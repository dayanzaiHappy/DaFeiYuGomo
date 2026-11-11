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
  /** 本次搜索到达的最大深度（根为 0）；仅用于诊断。 */
  depth?: number;
}

export interface SearchProgress {
  simsDone: number;
  simsTotal: number;
  best: SearchTop | null;
  top: SearchTop[];
  value: number;
  /** 到本次搜索为止到达过的最大深度（根为 0）。 */
  depth: number;
}

export interface SearchOptions {
  sims: number;
  topk?: number;
  cPuct?: number;
  onProgress?: (progress: SearchProgress) => void;
  progressEvery?: number;
  shouldCancel?: () => boolean;
  /** 随机源，默认 Math.random；测试可注入固定序列。 */
  random?: () => number;
  /** 根节点 visits 温度，0 表示 argmax（旧行为）。 */
  temperature?: number;
  /** 温度采样时只在前 K 名里选，默认 3。 */
  sampleTopK?: number;
  /** 根节点 Dirichlet 噪声；null 表示不加。 */
  rootNoise?: RootNoise | null;
  /** 棋盘上最后一手的位置，用于噪声支持集的位置过滤；-1 表示不做位置过滤。 */
  lastMove?: number;
  /** 根节点保留的候选数；0 或缺省表示不截断。 */
  rootLimit?: number;
  /** 叶节点强制解析层数；0 或缺省表示不做。 */
  forcedPlies?: number;
  /** 根节点 VCF 深度；0 或缺省表示不做。 */
  vcfDepth?: number;
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
