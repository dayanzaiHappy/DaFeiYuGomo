export const SIZE = 15;
export const N_CELLS = SIZE * SIZE;

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export type Player = 1 | 2;
export type Cell = 0 | 1 | 2;
export type BoardState = Uint8Array;

export const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

export interface SearchTop {
  move: number;
  visits: number;
  value: number;
}

/** 根节点 Dirichlet 噪声参数。 */
export interface RootNoise {
  epsilon: number;
  alpha: number;
  /** 支持集的质量护栏：只让先验 ≥ minRatio × max(prior) 的点参与加噪；缺省表示不过滤。 */
  minRatio?: number;
  /** 支持集的切比雪夫半径（相对上一手）；缺省表示不过滤。 */
  radius?: number;
  /** 支持集的数量上限；缺省表示不限（即 Ver 1.0 的全部子节点）。 */
  topM?: number;
}

export interface SearchResult {
  move: number;
  value: number;
  legal: number;
  sims: number;
  top: SearchTop[];
  cancelled?: boolean;
}

export interface SearchProgress {
  simsDone: number;
  simsTotal: number;
  best: SearchTop | null;
  top: SearchTop[];
  value: number;
}

export interface EvalResult {
  policy: Float32Array;
  value: number;
}

export interface Evaluator {
  evaluate(board: BoardState, player: Player): Promise<EvalResult>;
}

export function other(player: Player): Player {
  return player === BLACK ? WHITE : BLACK;
}
