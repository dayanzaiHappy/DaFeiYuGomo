import { LINE_CELLS, LINE_COUNT, LINE_STARTS } from './lines';
import { BLACK, EMPTY, N_CELLS, SIZE, WHITE, type BoardState, type Player } from './types';

/**
 * 局面评估：`evaluate(board, side)` 返回 side 视角的分数，正数表示 side 占优。
 *
 * 两部分相加：
 * 1. **形状分**：成五 / 活四 / 冲四 / 活三 / 眠三 / 活二，遍历 72 条线统计；
 * 2. **位置分**：每颗子按离天元的曼哈顿距离给一点分。
 *
 * 位置分是后补的：只有形状分时，开局十步内所有安静局面都是 0，
 * 搜索挑哪一手等于由候选排序和噪声决定，看不出「往中间下、别贴边」。
 * 它的量级压得很低（天元 28 分，一个活二 40 分），只用来打破平局，不参与威胁权衡。
 *
 * 形状定义只写一次（`tallyLine`），全量评估与增量评估共用；
 * 打分的口径也只写一次（`combine`），两边不可能算出两个数。
 */

/** 将杀分。非将杀分被钳在 ±SCORE_CLAMP，保证将杀永远压过任何形状堆叠。 */
export const SCORE_WIN = 30000;

/** 非将杀分的上限。int16 能存下 ±30000，置换表不必为此换 int32。 */
export const SCORE_CLAMP = 10000;

/**
 * 分值转胜率用的尺度：`value = 0.5 + 0.5·tanh(score / WIN_RATE_SCALE)`。
 *
 * 2500 是 2026-11-15 用自对弈数据重新拟合的值，见 `docs/versions/v2.0.0.md`。
 * 太小则曲线贴顶、中局全是 0.5 附近看不出差别；太大则一个活四就顶到 1.0，图表失去分辨率。
 */
export const WIN_RATE_SCALE = 2500;

/** 搜索分转对外胜率。将杀直接取 1 / 0，不过 tanh——否则 30000 会被压成 0.99999。 */
export function toWinRate(score: number): number {
  if (score >= SCORE_WIN - 64) return 1;
  if (score <= -SCORE_WIN + 64) return 0;
  return 0.5 + 0.5 * Math.tanh(score / WIN_RATE_SCALE);
}

const SCORE_OPEN_FOUR = 6000;
const SCORE_DOUBLE_THREE = 3500;
const SCORE_FOUR = 1200;
const SCORE_OPEN_THREE = 400;
/**
 * 眠三：一端被堵的三，下一手能造出冲四，但不成活四。
 *
 * 1.4.x 及以前完全不计，等于把「我方还有一个四可以冲」当成零；
 * 取一个活三的三成：它确实是一手强制威胁，但对方有整整一手棋可以处理。
 */
const SCORE_SLEEP_THREE = 120;
const SCORE_OPEN_TWO = 40;

/**
 * 每种颜色占 6 个槽位：成五 / 活四 / 冲四 / 活三 / 眠三 / 活二。
 * 计数器是一条扁平数组，黑在前、白在后，下标 = 颜色序号 * 6 + 形状序号。
 *
 * 用扁平数组而不是对象：评估在搜索里每次叶子都要跑，属性读写比数组下标慢一截。
 */
export const SHAPE_SLOTS = 6;

const SHAPE_FIVE = 0;
const SHAPE_OPEN_FOUR = 1;
const SHAPE_FOUR = 2;
const SHAPE_OPEN_THREE = 3;
const SHAPE_SLEEP_THREE = 4;
const SHAPE_OPEN_TWO = 5;

/** 全量评估用的两块临时表；评估同步且不重入，一份够用。 */
const lineScratch = new Int32Array(SHAPE_SLOTS * 2);
const totalScratch = new Int32Array(SHAPE_SLOTS * 2);
const positionScratch = new Int32Array(2);

/** 段缓冲：15 格最多 8 段（`X_X_X…`），留点余量。评估同步不重入，够用。 */
const SEG_MAX = 12;
const segStart = new Int32Array(SEG_MAX);
const segLen = new Int32Array(SEG_MAX);
const segColor = new Uint8Array(SEG_MAX);

/**
 * 每颗子的位置分：离天元越远越低，边线为 0。
 *
 * 曼哈顿距离 0~14，线性衰减到 0。天元 28 分，约等于 0.7 个活二——
 * 刻意压在这个量级：它只该在同形状的局面之间分出高下。
 */
const POSITION_WEIGHT = buildPositionWeight();

function buildPositionWeight(): Int16Array {
  const weight = new Int16Array(N_CELLS);
  const center = (SIZE - 1) / 2;
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      const distance = Math.abs(row - center) + Math.abs(col - center);
      weight[row * SIZE + col] = Math.max(0, Math.round((14 - distance) * 2));
    }
  }
  return weight;
}

/** 单个格子的位置分；增量评估落子时按格加减，不必重扫全盘。 */
export function positionWeight(cell: number): number {
  return POSITION_WEIGHT[cell];
}

/** 一方的位置分总和。 */
export function positionScore(board: BoardState, player: Player): number {
  let total = 0;
  for (let cell = 0; cell < N_CELLS; cell += 1) {
    if (board[cell] === player) total += POSITION_WEIGHT[cell];
  }
  return total;
}

/**
 * 统计一条线上的形状，写进 `counts[base .. base+11]`（黑 6 个、白 6 个），先清零。
 *
 * 先把线切成连续段，再两两检查「同色、中间恰好隔一个空」的跳形状：
 * `X_XXX`（跳四）补中间就成五，按冲四计；`XX_X`（跳三）补中间成四，
 * 两端空按活三计、一端空按眠三计。
 *
 * 合并过的两段不再单独计数，避免 `X_XXX` 同时算成「活二 + 活三 + 冲四」。
 * 增量评估与全量评估共用这一个函数，两边的形状定义不可能写岔。
 */
export function tallyLine(
  board: BoardState,
  line: number,
  counts: Int32Array,
  base: number,
): void {
  const start = LINE_STARTS[line];
  const end = LINE_STARTS[line + 1];

  const limit = base + SHAPE_SLOTS * 2;
  for (let i = base; i < limit; i += 1) counts[i] = 0;

  let segs = 0;
  let pos = start;
  while (pos < end && segs < SEG_MAX) {
    const player = board[LINE_CELLS[pos]];
    if (player === EMPTY) {
      pos += 1;
      continue;
    }
    let stop = pos + 1;
    while (stop < end && board[LINE_CELLS[stop]] === player) stop += 1;
    segStart[segs] = pos;
    segLen[segs] = stop - pos;
    segColor[segs] = player;
    segs += 1;
    pos = stop;
  }

  let i = 0;
  while (i < segs) {
    const offset = base + (segColor[i] === BLACK ? 0 : SHAPE_SLOTS);
    if (
      i + 1 < segs &&
      segColor[i + 1] === segColor[i] &&
      segStart[i + 1] - (segStart[i] + segLen[i]) === 1
    ) {
      const total = segLen[i] + segLen[i + 1];
      let openEnds = 0;
      if (segStart[i] > start && board[LINE_CELLS[segStart[i] - 1]] === EMPTY) openEnds += 1;
      const after = segStart[i + 1] + segLen[i + 1];
      if (after < end && board[LINE_CELLS[after]] === EMPTY) openEnds += 1;
      recordJump(counts, offset, total, openEnds);
      i += 2;
      continue;
    }

    const run = segLen[i];
    if (run >= 2) {
      let openEnds = 0;
      if (segStart[i] > start && board[LINE_CELLS[segStart[i] - 1]] === EMPTY) openEnds += 1;
      const after = segStart[i] + run;
      if (after < end && board[LINE_CELLS[after]] === EMPTY) openEnds += 1;
      record(counts, offset, run, openEnds);
    }
    i += 1;
  }
}

function record(counts: Int32Array, offset: number, run: number, openEnds: number): void {
  if (run >= 5) {
    counts[offset + SHAPE_FIVE] += 1;
    return;
  }
  if (run === 4) {
    if (openEnds === 2) counts[offset + SHAPE_OPEN_FOUR] += 1;
    else if (openEnds === 1) counts[offset + SHAPE_FOUR] += 1;
    return;
  }
  if (openEnds === 0) return;
  if (run === 3) {
    if (openEnds === 2) counts[offset + SHAPE_OPEN_THREE] += 1;
    else counts[offset + SHAPE_SLEEP_THREE] += 1;
    return;
  }
  if (run === 2 && openEnds === 2) counts[offset + SHAPE_OPEN_TWO] += 1;
}

/**
 * 跳形状（两段同色、中间隔一空）的计数。
 *
 * 补上中间那一格之后才是真正连起来的 `total + 1` 连，所以档位按 `total` 判：
 * - `total >= 4`：补一手就成五，是强制应手，价值等同冲四；
 * - `total === 3`：补一手成四。两端空 → 活三；一端空 → 眠三（只造出冲四）。
 * - `total === 2`：补一手成活三，只在两端都空时算活二。
 *
 * 注意不会记成五：这里统计的是「补一手的威胁」，盘上还没有五连。
 */
function recordJump(counts: Int32Array, offset: number, total: number, openEnds: number): void {
  if (total >= 4) {
    counts[offset + SHAPE_FOUR] += 1;
    return;
  }
  if (total === 3) {
    if (openEnds === 2) counts[offset + SHAPE_OPEN_THREE] += 1;
    else if (openEnds === 1) counts[offset + SHAPE_SLEEP_THREE] += 1;
    return;
  }
  if (total === 2 && openEnds === 2) counts[offset + SHAPE_OPEN_TWO] += 1;
}

/**
 * 一方的形状总分。
 *
 * 双活三单独加一份：加和式的表表达不了「两个活三胜过一个冲四」，而双三是五子棋最常见的赢法。
 * 前提是对方没有四——有的话轮到对方先动手，这个双三来不及兑现。
 */
function sideScore(counts: Int32Array, own: number, rival: number): number {
  let score =
    counts[own + SHAPE_OPEN_FOUR] * SCORE_OPEN_FOUR +
    counts[own + SHAPE_FOUR] * SCORE_FOUR +
    counts[own + SHAPE_OPEN_THREE] * SCORE_OPEN_THREE +
    counts[own + SHAPE_SLEEP_THREE] * SCORE_SLEEP_THREE +
    counts[own + SHAPE_OPEN_TWO] * SCORE_OPEN_TWO;

  if (
    counts[own + SHAPE_OPEN_THREE] >= 2 &&
    counts[rival + SHAPE_FOUR] === 0 &&
    counts[rival + SHAPE_OPEN_FOUR] === 0
  ) {
    score += SCORE_DOUBLE_THREE;
  }
  return score;
}

/**
 * 由扁平计数与位置分算出 side 视角的分数。
 *
 * 增量评估把维护好的总数直接喂进来，与全量评估走同一条路径——
 * 这是「两边不可能算出两个数」的保证，单测也正是拿这两个数比对。
 */
export function combine(counts: Int32Array, position: Int32Array, side: Player): number {
  const own = side === BLACK ? 0 : SHAPE_SLOTS;
  const rival = side === BLACK ? SHAPE_SLOTS : 0;

  if (counts[own + SHAPE_FIVE] > 0 || counts[rival + SHAPE_FIVE] > 0) {
    return (
      (counts[own + SHAPE_FIVE] > 0 ? SCORE_WIN : 0) -
      (counts[rival + SHAPE_FIVE] > 0 ? SCORE_WIN : 0)
    );
  }

  const ownIndex = side === BLACK ? 0 : 1;
  const rivalIndex = side === BLACK ? 1 : 0;
  const raw =
    sideScore(counts, own, rival) -
    sideScore(counts, rival, own) +
    position[ownIndex] -
    position[rivalIndex];
  if (raw > SCORE_CLAMP) return SCORE_CLAMP;
  if (raw < -SCORE_CLAMP) return -SCORE_CLAMP;
  return raw;
}

/** 全量评估：扫 72 条线 + 225 格位置分。留作参照与单测基准，搜索里走增量版本。 */
export function evaluate(board: BoardState, side: Player): number {
  tallyAll(board);
  positionScratch[0] = positionScore(board, BLACK);
  positionScratch[1] = positionScore(board, WHITE);
  return combine(totalScratch, positionScratch, side);
}

/** 形状计数的可读视图；扁平数组的槽位细节只在评估内部使用。 */
export interface ShapeCounts {
  five: number;
  openFour: number;
  four: number;
  openThree: number;
  sleepThree: number;
  openTwo: number;
}

/**
 * 某一方的形状计数。
 *
 * 分析板每走一步要显示双方的活四/冲四/活三，用 `evaluate` 只能拿到一个合成分数，
 * 拿不到「几个活三」这种可读信息。代价是一次全量扫描（约 100 µs），界面层足够。
 */
export function shapeCounts(board: BoardState, player: Player): ShapeCounts {
  tallyAll(board);
  const base = player === BLACK ? 0 : SHAPE_SLOTS;
  return {
    five: totalScratch[base + SHAPE_FIVE],
    openFour: totalScratch[base + SHAPE_OPEN_FOUR],
    four: totalScratch[base + SHAPE_FOUR],
    openThree: totalScratch[base + SHAPE_OPEN_THREE],
    sleepThree: totalScratch[base + SHAPE_SLEEP_THREE],
    openTwo: totalScratch[base + SHAPE_OPEN_TWO],
  };
}

function tallyAll(board: BoardState): void {
  totalScratch.fill(0);
  for (let line = 0; line < LINE_COUNT; line += 1) {
    tallyLine(board, line, lineScratch, 0);
    for (let i = 0; i < SHAPE_SLOTS * 2; i += 1) totalScratch[i] += lineScratch[i];
  }
}
