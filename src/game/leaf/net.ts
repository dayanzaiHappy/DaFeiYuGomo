import { FEATURE_COUNT } from './features';
import type { LeafNet } from './evaluator';

/**
 * 叶子网络的 int16 定点前向。
 *
 * 口径的唯一说明在 `docs/versions/v2.1.0.md` 的「网络与量化」一节；
 * 改口径必须训练导出与这里同时改，并重新生成对拍基准。
 * 所有除法都用 2 的幂，float64 上是精确的——这里**不用 `>>`**：JS 的 `>>` 会先把
 * 操作数转成 int32，而一层的累加值可以到 1e10，转了就废。
 *
 * 为什么走定点而不走浮点：JS 没有真正的 fp32（`Float32Array` 只负责存，运算仍是 double），
 * 浮点实现既无法与 PyTorch 的 float32 逐位对齐，也会随 JIT 与平台抖动。
 * 定点前向给出一个精确、可复现的规格，这样「上线的网就是训出来的网」才是可证的。
 */

const MAGIC = 0x31464c47; // "GLF1" 小端
const VERSION = 1;
const HEADER_BYTES = 24;

/** 量化口径。改这里的任何一个数都必须同时改训练端的导出，并重新生成对拍基准。 */
export const LEAF_QUANT = {
  /** 权重 int16 = round(w × 4096)。 */
  qw: 4096,
  /** 特征 int16 = round(f × 8192)。 */
  qf: 8192,
  /** 激活尺度：int 值 ÷ 1024 才是真实激活。 */
  act: 1024,
  /** 激活上限，等于 round(127/64 × act)——训练时 CReLU 就是按 127/64 截的。 */
  clipInt: 2032,
  /** 特征量化前先夹到这个范围，只为挡住 int16 溢出。 */
  featureLimit: 3.5,
  /** 三层移位。L1 = log2(qf×qw/act) = 15，L2/L3 = log2(qw) = 12。 */
  shifts: [15, 12, 12] as const,
} as const;

const { qf: QF, act: ACT, clipInt: CLIP_INT, featureLimit: FEATURE_LIMIT, shifts: SHIFTS } =
  LEAF_QUANT;

/** FNV-1a 32 位，与导出端的 `fnv1a` 同构；校验 body。 */
function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * 移位与截断值取成数字常量：数组下标和对象属性读在热循环里会被反复求值。
 *
 * 折算成 `Math.round(v / 2^s)` 就是四舍五入——Python 侧同一个式子是
 * `(v + (1 << (s-1))) >> s`。两点等价：2 的幂做除数，商在 float64 上是精确的，
 * 半值处 `Math.round` 与「先加半个再下取整」都朝 +∞ 收，负数也一致。
 * 乘倒数而不是做除法：除法十几拍，乘一个 2 的幂次倒数既精确又快。
 *
 * 不用 `>>` 的原因：JS 的 `>>` 会先把操作数转 int32，而一层累加能到 1e10。
 * 裸移位还只朝 −∞ 取整，误差在同号权重上累加，三层能把 logit 推歪 0.42（改四舍五入后 0.017）。
 */
const S1 = SHIFTS[0];
const S2 = SHIFTS[1];
const S3 = SHIFTS[2];
const INV_1 = 1 / (1 << S1);
const INV_2 = 1 / (1 << S2);
const INV_3 = 1 / (1 << S3);

/** 定点累加值 → 激活：四舍五入后夹到 `[0, clip]`（CReLU）。 */
function quantize(sum: number, inv: number, clip: number): number {
  const act = Math.round(sum * inv);
  if (act < 0) return 0;
  if (act > clip) return clip;
  return act;
}

export class Int16LeafNet implements LeafNet {
  /** 量化后的特征缓冲，每层复用。 */
  private readonly q = new Int32Array(FEATURE_COUNT);
  private readonly hidden: Int32Array;
  private readonly hidden2: Int32Array;

  constructor(
    private readonly h1: number,
    private readonly h2: number,
    private readonly w1: Int16Array,
    private readonly w2: Int16Array,
    private readonly w3: Int16Array,
    private readonly b1: Int32Array,
    private readonly b2: Int32Array,
    private readonly b3: Int32Array,
  ) {
    this.hidden = new Int32Array(h1);
    this.hidden2 = new Int32Array(h2);
  }

  /**
   * 行棋方视角的 logit。blend 直接用这个，不再经 σ 往返。
   *
   * 所有状态在入口一次性提到局部：热循环里出现 `this.x` 或 `SHIFTS[n]` 这类属性读，
   * V8 就不敢把它们提出循环，整个前向会慢上好几倍。
   */
  logit(features: Float32Array): number {
    const f = FEATURE_COUNT;
    const q = this.q;
    const a1 = this.hidden;
    const a2 = this.hidden2;
    const h1 = this.h1;
    const h2 = this.h2;
    const w1 = this.w1;
    const w2 = this.w2;
    const w3 = this.w3;
    const b1 = this.b1;
    const b2 = this.b2;
    const b3 = this.b3;
    const limit = FEATURE_LIMIT;
    const clip = CLIP_INT;

    for (let i = 0; i < f; i += 1) {
      const raw = features[i];
      q[i] = Math.round((raw > limit ? limit : raw < -limit ? -limit : raw) * QF);
    }

    // 一次算四个隐藏单元：内层只读一次 q[i]，四个累加器互相独立、CPU 能流水。
    // 单单元版本在每个单元都重走一遍 30 维，多出来的是无谓的载入与循环开销。
    for (let j = 0; j < h1; j += 4) {
      const base0 = j * f;
      const base1 = base0 + f;
      const base2 = base1 + f;
      const base3 = base2 + f;
      let s0 = b1[j];
      let s1 = b1[j + 1];
      let s2 = b1[j + 2];
      let s3 = b1[j + 3];
      for (let i = 0; i < f; i += 1) {
        const qv = q[i];
        s0 += qv * w1[base0 + i];
        s1 += qv * w1[base1 + i];
        s2 += qv * w1[base2 + i];
        s3 += qv * w1[base3 + i];
      }
      a1[j] = quantize(s0, INV_1, clip);
      a1[j + 1] = quantize(s1, INV_1, clip);
      a1[j + 2] = quantize(s2, INV_1, clip);
      a1[j + 3] = quantize(s3, INV_1, clip);
    }

    for (let k = 0; k < h2; k += 4) {
      const base0 = k * h1;
      const base1 = base0 + h1;
      const base2 = base1 + h1;
      const base3 = base2 + h1;
      let s0 = b2[k];
      let s1 = b2[k + 1];
      let s2 = b2[k + 2];
      let s3 = b2[k + 3];
      for (let j = 0; j < h1; j += 1) {
        const av = a1[j];
        s0 += av * w2[base0 + j];
        s1 += av * w2[base1 + j];
        s2 += av * w2[base2 + j];
        s3 += av * w2[base3 + j];
      }
      a2[k] = quantize(s0, INV_2, clip);
      a2[k + 1] = quantize(s1, INV_2, clip);
      a2[k + 2] = quantize(s2, INV_2, clip);
      a2[k + 3] = quantize(s3, INV_2, clip);
    }

    let sum = b3[0];
    for (let k = 0; k < h2; k += 1) sum += a2[k] * w3[k];
    return Math.round(sum * INV_3) / ACT;
  }
}

/**
 * 解析 `leaf-v1.bin`。
 *
 * 头部 24 B：magic(4) | ver u32 | F,H1,H2 u16×3 | shifts u16×3 | hash u32，
 * 之后依次是 w1·w2·w3（int16）和 b1·b2·b3（int32），全为小端、行主序。
 * 校验不过就抛，调用方据此退回 λ=0——宁可退化到旧评估，也不要带着半份权重跑。
 */
export function decodeLeafModel(bytes: Uint8Array): Int16LeafNet {
  if (bytes.byteLength < HEADER_BYTES) throw new Error('叶子权重长度不足');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('叶子权重 magic 不对（不是 GLF1）');
  const version = view.getUint32(4, true);
  if (version !== VERSION) throw new Error(`不支持的叶子权重版本 ${version}`);

  const features = view.getUint16(8, true);
  const h1 = view.getUint16(10, true);
  const h2 = view.getUint16(12, true);
  const shifts = [
    view.getUint16(14, true),
    view.getUint16(16, true),
    view.getUint16(18, true),
  ];
  const hash = view.getUint32(20, true);

  if (features !== FEATURE_COUNT) {
    throw new Error(`叶子权重期望 ${FEATURE_COUNT} 维特征，文件里是 ${features}`);
  }
  // 前向一次算四个隐藏单元，宽度不是 4 的倍数会漏掉最后几个
  if (h1 % 4 !== 0 || h2 % 4 !== 0) {
    throw new Error(`隐藏层宽度必须是 4 的倍数，文件里是 ${h1}/${h2}`);
  }
  if (shifts[0] !== SHIFTS[0] || shifts[1] !== SHIFTS[1] || shifts[2] !== SHIFTS[2]) {
    throw new Error(`移位口径不一致：文件 ${shifts.join('/')}，引擎 ${SHIFTS.join('/')}`);
  }

  const body = bytes.subarray(HEADER_BYTES);
  if (fnv1a(body) !== hash) throw new Error('叶子权重校验失败（body 与头部 hash 不符）');

  const w1Count = h1 * features;
  const w2Count = h2 * h1;
  const w3Count = h2;
  const expect = (w1Count + w2Count + w3Count) * 2 + (h1 + h2 + 1) * 4;
  if (body.byteLength !== expect) {
    throw new Error(`叶子权重 body 长度 ${body.byteLength}，按头应为 ${expect}`);
  }

  // DataView 逐元素读，避开对齐要求；2 KB 的量级，开销可以忽略
  const bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const readI16 = (offset: number, count: number): Int16Array => {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i += 1) out[i] = bodyView.getInt16(offset + i * 2, true);
    return out;
  };
  const readI32 = (offset: number, count: number): Int32Array => {
    const out = new Int32Array(count);
    for (let i = 0; i < count; i += 1) out[i] = bodyView.getInt32(offset + i * 4, true);
    return out;
  };

  let offset = 0;
  const w1 = readI16(offset, w1Count);
  offset += w1Count * 2;
  const w2 = readI16(offset, w2Count);
  offset += w2Count * 2;
  const w3 = readI16(offset, w3Count);
  offset += w3Count * 2;
  const b1 = readI32(offset, h1);
  offset += h1 * 4;
  const b2 = readI32(offset, h2);
  offset += h2 * 4;
  const b3 = readI32(offset, 1);

  return new Int16LeafNet(h1, h2, w1, w2, w3, b1, b2, b3);
}
