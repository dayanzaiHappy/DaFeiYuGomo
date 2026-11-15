import { DIRECTIONS, N_CELLS, SIZE } from './types';

/**
 * 棋盘线表与窗口表。
 *
 * 线：横 15、竖 15、两个斜向各 21，共 72 条。长度 < 5 的短对角线不入表——
 * 它们不可能成五，留着只会让评估白扫格子。代价是角落的格子不足 4 条线，
 * 所以 `CELL_LINES` 里那些方向填 -1。
 *
 * 窗口：连续的 5 格，4 个方向全部起点，共 572 个。窗口比线更贴近「成五」这件事——
 * 五连必然是某个窗口，而一条 15 格的线上有 11 个窗口。
 */

export const LINE_COUNT = 72;

// 三张表必须同源，所以一次构建、同时产出，避免两处过滤条件写岔
const built = buildLines();

/** 每条线的棋子在 LINE_CELLS 里的起始下标，长度 LINE_COUNT + 1。 */
export const LINE_STARTS = built.starts;

/** 72 条线首尾相接的格子下标，共 860 项。 */
export const LINE_CELLS = built.cells;

/** `格子 * 4 + 方向` → 线序号；-1 表示该方向没有长度 ≥ 5 的线。方向序号与 DIRECTIONS 一致。 */
export const CELL_LINES = built.cellLines;

/** `格子 * 4 + 方向` → 该格在这条线上的位置。 */
export const CELL_OFFSETS = built.cellOffsets;

/** 所有五格窗口首尾相接，共 572 × 5 项。 */
export const WINDOWS = buildWindows();

/** 窗口数。写成常量是给测试用的，避免测试里再算一遍。 */
export const WINDOW_COUNT = WINDOWS.length / 5;

function buildLines(): {
  starts: Int16Array;
  cells: Int16Array;
  cellLines: Int16Array;
  cellOffsets: Int16Array;
} {
  const cells: number[] = [];
  const starts: number[] = [0];
  const cellLines = new Int16Array(N_CELLS * 4).fill(-1);
  const cellOffsets = new Int16Array(N_CELLS * 4);

  forEachLine((line, dir) => {
    if (line.length < 5) return;
    const index = starts.length - 1;
    for (let pos = 0; pos < line.length; pos += 1) {
      const cell = line[pos];
      cells.push(cell);
      cellLines[(cell << 2) | dir] = index;
      cellOffsets[(cell << 2) | dir] = pos;
    }
    starts.push(cells.length);
  });

  return {
    starts: Int16Array.from(starts),
    cells: Int16Array.from(cells),
    cellLines,
    cellOffsets,
  };
}

/**
 * 按「横、竖、↘、↙」的顺序遍历全部候选线，短对角线由调用方过滤。
 * 方向序号必须和 `DIRECTIONS` 对齐：0 竖、1 横、2 ↘、3 ↙。
 */
function forEachLine(visit: (cells: number[], dir: number) => void): void {
  const walk = (row: number, col: number, dr: number, dc: number): number[] => {
    const cells: number[] = [];
    let r = row;
    let c = col;
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
      cells.push(r * SIZE + c);
      r += dr;
      c += dc;
    }
    return cells;
  };

  for (let row = 0; row < SIZE; row += 1) visit(walk(row, 0, 0, 1), 1);
  for (let col = 0; col < SIZE; col += 1) visit(walk(0, col, 1, 0), 0);

  for (let col = 0; col < SIZE; col += 1) visit(walk(0, col, 1, 1), 2);
  for (let row = 1; row < SIZE; row += 1) visit(walk(row, 0, 1, 1), 2);

  for (let col = 0; col < SIZE; col += 1) visit(walk(0, col, 1, -1), 3);
  for (let row = 1; row < SIZE; row += 1) visit(walk(row, SIZE - 1, 1, -1), 3);
}

function buildWindows(): Int16Array {
  const cells: number[] = [];
  for (const [dr, dc] of DIRECTIONS) {
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const endRow = row + dr * 4;
        const endCol = col + dc * 4;
        if (endRow < 0 || endRow >= SIZE || endCol < 0 || endCol >= SIZE) continue;
        for (let step = 0; step < 5; step += 1) {
          cells.push((row + dr * step) * SIZE + col + dc * step);
        }
      }
    }
  }
  return Int16Array.from(cells);
}
