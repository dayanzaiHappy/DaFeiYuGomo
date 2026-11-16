import { SCORE_CLAMP, SCORE_WIN, WIN_RATE_SCALE } from '../eval';

/**
 * 旧评估分与新评估 logit 的融合（log-linear opinion pool）。
 *
 * 两个评估的量纲不同：旧评估是形状分（±10000，将杀 ±30000），网络给出的是一个 logit。
 * 直接平均分等于按 λ 随机加权；直接平均概率会压极端（0.99 与 0.9 平均成 0.945，
 * 搜索会误判「还能翻」）。先把两边都换成 logit 再线性平均，在胜率空间看是几何平均。
 */
export interface BlendParams {
  /**
   * 旧评估分换 logit 的尺度：`u_o = 2·s_o/K`。
   *
   * 这个 2 不能丢：`0.5 + 0.5·tanh(x) = σ(2x)`，分数与 logit 之间差一个 2 倍。
   * K 是从标定集拟合出来的**旧评估专属**常数，回答「多少分算一个 logit」。
   * 它不参与输出刻度，见 `scoreFromLogit`。
   */
  K: number;
  /** 先后手偏置：黑先 +1、白先 −1。freestyle 黑必胜，旧评估的空盘给 0 就是缺了这一项。 */
  b: number;
  /** 对新评估的信任度。0 表示全用旧的（原样返回），1 表示全用新的。 */
  lambda: number;
}

/** 将杀判定容差，与 eval 里「超过 SCORE_WIN − 64 即将杀」的口径一致。 */
const MATE_GUARD = 64;

/**
 * logit 换回引擎分用的尺度。
 *
 * 为什么不用 K：`noise`、`MOVE_MARGIN`、`GRADE_LOSS`、`SCORE_CLAMP` 全是按 2.0.0 的分数
 * 刻度（即 `toWinRate` 除以 `WIN_RATE_SCALE`）写的。若改用 K 当输出尺度，λ=1 时所有分数
 * 会整体放大 K/2500 倍，弱档抖动幅度、候选门控、评级阈值会全部静默改变——那是另一场改动，
 * 不该混在「换评估」里。
 *
 * 这样取值之后两个端点都精确：λ=0 短路返回 `s_o`（与 2.0.0 逐位一致）；
 * λ=1 时 `toWinRate(s) = σ(2s/2500) = σ(u_n)`，界面胜率恰好等于网络的胜率。
 */
const OUTPUT_SCALE = WIN_RATE_SCALE;

/** logit → 引擎分。夹在 ±SCORE_CLAMP 内，保证非将杀分不会落进将杀区。 */
export function scoreFromLogit(u: number): number {
  const score = Math.round((OUTPUT_SCALE * u) / 2);
  if (score > SCORE_CLAMP) return SCORE_CLAMP;
  if (score < -SCORE_CLAMP) return -SCORE_CLAMP;
  return score;
}

/**
 * 融合一次。返回行棋方视角的分数，刻度与旧评估一致。
 *
 * `lambda <= 0` 时**原样返回 `oldScore`**，不做任何浮点往返——这是 λ=0 与 2.0.0
 * 逐位一致的前提（`Object.is`，不是近似）。
 *
 * 将杀分不参与融合：30000 经过 logit 往返会被夹到 10000，「五连」就退化成「优势极大」。
 */
export function blend(
  oldScore: number,
  netLogit: number,
  blackToMove: boolean,
  params: BlendParams,
): number {
  const { K, b, lambda } = params;
  if (!(lambda > 0)) return oldScore;
  if (oldScore >= SCORE_WIN - MATE_GUARD || oldScore <= -SCORE_WIN + MATE_GUARD) return oldScore;
  if (!Number.isFinite(netLogit)) return oldScore;

  const uOld = (2 * oldScore) / K + b * (blackToMove ? 1 : -1);
  return scoreFromLogit(uOld + lambda * (netLogit - uOld));
}
