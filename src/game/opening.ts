import { colOf, idx, rowOf } from './board';
import { EMPTY, N_CELLS, SIZE, type BoardState } from './types';

/** 天元坐标。 */
const CENTER = (SIZE - 1) / 2;
/** 有 policy 时的权重：policy / 贴近玩家 / 靠近天元。 */
const POLICY_WEIGHT = 0.5;
const PLAYER_WEIGHT = 0.3;
const CENTER_WEIGHT = 0.2;
/** 模型不可用时的兜底权重。 */
const FALLBACK_PLAYER_WEIGHT = 0.65;
const FALLBACK_CENTER_WEIGHT = 0.35;
/** 候选点到玩家第一手的最远切比雪夫距离。 */
const MAX_PLAYER_DISTANCE = 2;
/** 天元到棋盘角落的曼哈顿距离。 */
const MAX_CENTER_DISTANCE = 2 * CENTER;
/** 只在评分最高的几个点里加权随机。 */
const TOP_K = 3;

export type RandomSource = () => number;

interface Candidate {
  move: number;
  nearPlayer: number;
  nearCenter: number;
  centerDistance: number;
  row: number;
  col: number;
}

/**
 * 玩家执黑时，AI 白棋的第一手：
 * - 有 policy（一次模型前向，不跑 MCTS）时按
 *   S = 0.50 * π̂ + 0.30 * a + 0.20 * c 评分；
 * - 模型不可用时退回 S = 0.65 * a + 0.35 * c。
 * π̂ 是 policy 在候选集内的归一化；a 为贴近玩家程度（相邻 1、隔一格 0.5）；
 * c 为靠近天元的程度（天元 1、角落 0）。
 * 在评分前 3 名里按分数加权随机；无可用点时返回 -1。
 */
export function chooseOpeningResponse(
  board: BoardState,
  humanMove: number,
  policy: ArrayLike<number> | null = null,
  random: RandomSource = Math.random,
): number {
  const humanRow = rowOf(humanMove);
  const humanCol = colOf(humanMove);
  const candidates: Candidate[] = [];

  for (let dr = -MAX_PLAYER_DISTANCE; dr <= MAX_PLAYER_DISTANCE; dr++) {
    for (let dc = -MAX_PLAYER_DISTANCE; dc <= MAX_PLAYER_DISTANCE; dc++) {
      if (dr === 0 && dc === 0) continue;
      const row = humanRow + dr;
      const col = humanCol + dc;
      if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) continue;
      const move = idx(row, col);
      if (board[move] !== EMPTY) continue;

      const playerDistance = Math.max(Math.abs(dr), Math.abs(dc));
      const centerDistance = Math.abs(row - CENTER) + Math.abs(col - CENTER);
      candidates.push({
        move,
        nearPlayer:
          (MAX_PLAYER_DISTANCE + 1 - playerDistance) / MAX_PLAYER_DISTANCE,
        nearCenter: 1 - centerDistance / MAX_CENTER_DISTANCE,
        centerDistance,
        row,
        col,
      });
    }
  }

  if (candidates.length === 0) return -1;

  const policyValues = policy && policy.length >= N_CELLS ? policy : null;
  let policySum = 0;
  if (policyValues) {
    for (const candidate of candidates) {
      policySum += policyValues[candidate.move];
    }
  }
  const hasPolicy = policyValues !== null && policySum > 0;

  const scored = candidates.map((candidate) => {
    const policyShare =
      hasPolicy && policyValues ? policyValues[candidate.move] / policySum : 0;
    const score = hasPolicy
      ? POLICY_WEIGHT * policyShare +
        PLAYER_WEIGHT * candidate.nearPlayer +
        CENTER_WEIGHT * candidate.nearCenter
      : FALLBACK_PLAYER_WEIGHT * candidate.nearPlayer +
        FALLBACK_CENTER_WEIGHT * candidate.nearCenter;
    return { ...candidate, score };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.centerDistance - b.centerDistance ||
      a.row - b.row ||
      a.col - b.col,
  );

  const top = scored.slice(0, TOP_K);
  let total = 0;
  for (const candidate of top) total += candidate.score;
  if (total <= 0) return top[0].move;

  let threshold = random() * total;
  for (const candidate of top) {
    threshold -= candidate.score;
    if (threshold < 0) return candidate.move;
  }
  return top[top.length - 1].move;
}
