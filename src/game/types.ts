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
  /** 行棋方视角的胜率 0~1。 */
  value: number;
  /**
   * MCTS 时代的访问次数，当前的 alpha-beta 搜索不产出。
   *
   * 留着只为读旧记录：1.4.x 导出的 JSONL 里每一条候选都带 visits，
   * 解析时原样保留、展示时按「未定义即视为已搜」处理。
   */
  visits?: number;
  /** 内部分值（行棋方视角）。仅调试与记录用，展示一律走 value。 */
  score?: number;
}

export interface SearchResult {
  /** -1 表示没有可落子的点（棋盘已满）。 */
  move: number;
  /** 行棋方视角的胜率 0~1，由分值经 tanh 压出来，不是校准过的真实胜率。 */
  value: number;
  /** 本次搜索展开的节点数。 */
  nodes: number;
  top: SearchTop[];
  /** 因节点预算耗尽提前中止；结果来自上一层完整迭代，仍然可用。 */
  aborted?: boolean;
  /** 完成的最后一个迭代深度；0 表示根节点 VCF 直接命中，没进主搜索。 */
  depth?: number;
}

export function other(player: Player): Player {
  return player === BLACK ? WHITE : BLACK;
}
