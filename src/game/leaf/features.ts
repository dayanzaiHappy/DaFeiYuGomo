import {
  SCORE_FOUR,
  SCORE_OPEN_FOUR,
  SCORE_OPEN_THREE,
  SCORE_OPEN_TWO,
  SCORE_SLEEP_THREE,
  SHAPE_FOUR,
  SHAPE_OPEN_FOUR,
  SHAPE_OPEN_THREE,
  SHAPE_OPEN_TWO,
  SHAPE_SLEEP_THREE,
  SHAPE_SLOTS,
} from '../eval';
import type { EvalCache } from '../eval-cache';
import { BLACK, N_CELLS, type Player } from '../types';

/**
 * 叶子评估特征（30 维）：训练与推理共用这唯一一份实现。
 *
 * 输入全部来自 `EvalCache` 已维护的增量计数，不做全盘扫描；
 * 归一化的 cap 与除数只在这一处定义——训练脚本、量化脚本都消费这里的输出，
 * 另写一份迟早和推理算出两个数。
 *
 * 特征是**行棋方视角**：own/rival 两组按 `side` 对调；
 * `is_black_to_move` 是绝对颜色，不随视角对调——freestyle 黑必胜，
 * 基率不对称必须显式可见——不放进分数里，是因为分数要满足反对称：
 *
 * 维度顺序是训练端与推理端之间的契约，改动即等于换模型版本：
 *   [0..11]  形状计数：own 成五/活四/冲四/活三/眠三/活二 × cap 归一化，rival 同 6 维
 *   [0..11]  形状计数：own 成五/活四/冲四/活三/眠三/活二 × cap 归一化，rival 同 6 维
 *   [12..15] 方向集中度：每方向（竖/横/↘/↙）形状分差 / 2500，截断到 [-1,1]，
 *            **按值降序排序后输出**——旋转/翻转只会置换方向，排序保证 8 对称下
 *            输入向量不变（无增广的网络要满足 §10.1 的镜像验收，只能靠特征本身不变）；
 *            集中度关心「威胁堆在哪一条方向上多狠」，不关心是竖是横，与老评估口径一致
 *   [16..17] 位置分：own、rival / 1000
 *   [18..19] 棋子数：own、rival / 225
 *   [20..21] 前沿空点：own、rival / 225
 *   [22..27] 组合指示：own 活四 / own 四+三 / own 双活三 / rival 同三项
 *   [28]     阶段：总手数 / 225
 *   [29]     is_black_to_move
 */
export const FEATURE_COUNT = 30;

/** 形状分差的天然尺度：与 `WIN_RATE_SCALE` 同值，一个活四的量级正好顶满。 */
const DIR_SCALE = 2500;

/** 位置分除数：双方实际对局里单方位置分极少超过 800。 */
const POS_SCALE = 1000;

/** 计数的饱和上限：按各形状的出现频次上限取值，超出部分对网络是同一信号。 */
const CAP = [1, 2, 4, 4, 6, 8] as const;

/**
 * 四个方向的临时槽位。
 *
 * 这里曾经写的是 `const dirDiff = [0,0,0,0]` 加 `sort((a,b) => b-a)`：
 * 每次叶子调用都要分配一个数组和一个比较器闭包，光这一项就比整个前向还贵。
 * 改成模块级缓冲加 4 元素插入排序后零分配。
 * 叶子评估同步、不重入，一份够用。
 */
const dirScratch = new Float64Array(4);

function capped(count: number, cap: number): number {
  return Math.min(count, cap) / cap;
}

/**
 * 把当前缓存的特征写进 `out`（长度 `FEATURE_COUNT`，复用缓冲，不分配）。
 *
 * `blackToMove` 由调用方给出：搜索里有明确的行棋方；提取脚本里来自 npz 的
 * 先后手维或子数奇偶，不在这里推断。
 */
export function extractFeatures(
  cache: EvalCache,
  side: Player,
  blackToMove: boolean,
  out: Float32Array,
): void {
  const totals = cache.totalsView;
  const dirTotals = cache.dirTotalsView;
  const stones = cache.stoneCounts;
  const frontier = cache.frontierCounts;
  const position = cache.positionScores;

  const own = side === BLACK ? 0 : SHAPE_SLOTS;
  const rival = side === BLACK ? SHAPE_SLOTS : 0;
  const ownColor = side === BLACK ? 0 : 1;
  const rivalColor = side === BLACK ? 1 : 0;

  let k = 0;
  for (let shape = 0; shape < SHAPE_SLOTS; shape += 1) {
    out[k] = capped(totals[own + shape], CAP[shape]);
    out[k + 6] = capped(totals[rival + shape], CAP[shape]);
    k += 1;
  }
  k += SHAPE_SLOTS;

  // 方向集中度：该方向上「己方威胁形状分 − 对方」，权重与评估打分同一套；
  // 算完 4 个方向再降序排序——对称操作只置换方向不改变值的集合
  for (let dir = 0; dir < 4; dir += 1) {
    const base = dir * SHAPE_SLOTS * 2;
    dirScratch[dir] =
      (dirTotals[base + own + SHAPE_OPEN_FOUR] - dirTotals[base + rival + SHAPE_OPEN_FOUR]) *
        SCORE_OPEN_FOUR +
      (dirTotals[base + own + SHAPE_FOUR] - dirTotals[base + rival + SHAPE_FOUR]) * SCORE_FOUR +
      (dirTotals[base + own + SHAPE_OPEN_THREE] - dirTotals[base + rival + SHAPE_OPEN_THREE]) *
        SCORE_OPEN_THREE +
      (dirTotals[base + own + SHAPE_SLEEP_THREE] - dirTotals[base + rival + SHAPE_SLEEP_THREE]) *
        SCORE_SLEEP_THREE +
      (dirTotals[base + own + SHAPE_OPEN_TWO] - dirTotals[base + rival + SHAPE_OPEN_TWO]) *
        SCORE_OPEN_TWO;
  }
  for (let i = 1; i < 4; i += 1) {
    const key = dirScratch[i];
    let j = i - 1;
    while (j >= 0 && dirScratch[j] < key) {
      dirScratch[j + 1] = dirScratch[j];
      j -= 1;
    }
    dirScratch[j + 1] = key;
  }
  for (let dir = 0; dir < 4; dir += 1) {
    const diff = dirScratch[dir];
    out[k + dir] =
      (diff > DIR_SCALE ? DIR_SCALE : diff < -DIR_SCALE ? -DIR_SCALE : diff) / DIR_SCALE;
  }
  k += 4;

  out[k] = position[ownColor] / POS_SCALE;
  out[k + 1] = position[rivalColor] / POS_SCALE;
  out[k + 2] = stones[ownColor] / N_CELLS;
  out[k + 3] = stones[rivalColor] / N_CELLS;
  out[k + 4] = frontier[ownColor] / N_CELLS;
  out[k + 5] = frontier[rivalColor] / N_CELLS;
  k += 6;

  // 组合指示，双三条件与评估的双活三奖励一致（对方无四才成立）
  const ownOpenFour = totals[own + SHAPE_OPEN_FOUR];
  const ownFour = totals[own + SHAPE_FOUR];
  const ownOpenThree = totals[own + SHAPE_OPEN_THREE];
  const rivalOpenFour = totals[rival + SHAPE_OPEN_FOUR];
  const rivalFour = totals[rival + SHAPE_FOUR];
  const rivalOpenThree = totals[rival + SHAPE_OPEN_THREE];

  out[k] = ownOpenFour > 0 ? 1 : 0;
  out[k + 1] = ownFour > 0 && ownOpenThree > 0 ? 1 : 0;
  out[k + 2] = ownOpenThree >= 2 && rivalFour === 0 && rivalOpenFour === 0 ? 1 : 0;
  out[k + 3] = rivalOpenFour > 0 ? 1 : 0;
  out[k + 4] = rivalFour > 0 && rivalOpenThree > 0 ? 1 : 0;
  out[k + 5] = rivalOpenThree >= 2 && ownFour === 0 && ownOpenFour === 0 ? 1 : 0;
  k += 6;

  out[k] = (stones[0] + stones[1]) / N_CELLS;
  out[k + 1] = blackToMove ? 1 : 0;
}
