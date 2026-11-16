import { combine, positionScore, positionWeight, SHAPE_SLOTS, tallyLine } from './eval';
import { CELL_LINES, LINE_COUNT } from './lines';
import { BLACK, EMPTY, N_CELLS, SIZE, WHITE, type BoardState, type Player } from './types';

/** 一条线要存双方各 6 个形状计数。 */
const SLOTS_PER_LINE = SHAPE_SLOTS * 2;

/** 与搜索的递归硬顶一致。 */
const MAX_LEVELS = 48;

/** `线序号 → 方向序号`（竖/横/↘/↙）。叶子特征要按方向聚合威胁，从 CELL_LINES 反推一次即可。 */
const LINE_DIR = (() => {
  const dir = new Int16Array(LINE_COUNT).fill(-1);
  for (let cell = 0; cell < N_CELLS; cell += 1) {
    for (let d = 0; d < 4; d += 1) {
      const line = CELL_LINES[(cell << 2) | d];
      if (line >= 0 && dir[line] < 0) dir[line] = d;
    }
  }
  return dir;
})();

/** 每格的 8 邻域表；边角不足 8 个的方向位补 -1。前沿特征用。 */
const NB_CELLS = (() => {
  const table = new Int16Array(N_CELLS * 8).fill(-1);
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      let k = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
          table[(row * SIZE + col) * 8 + k] = nr * SIZE + nc;
          k += 1;
        }
      }
    }
  }
  return table;
})();

/**
 * 每层的旧值。布局（写入顺序与 pop 的读取顺序严格一致）：
 * totals(12) + 每方向{byDir 块(12) + byLine 块(12)} × 4 + position(2) + stones(2)
 * + frontier(2) + 落点触色(3) + 邻格备份(8 × 3)。
 */
const UNDO_SIZE = SLOTS_PER_LINE * 9 + 33;

/**
 * 局面分的增量缓存。
 *
 * 全量评估要扫 860 个格子；但落子只改变**经过它的那四条线**上的连子，
 * 其余 68 条线的计数一点没动。所以按线存计数，落子只重算 4 条线（约 60 格），
 * 读取时把总数过一遍 `combine` 即可。
 *
 * 位置分单独记：它只跟「哪一格有哪颗子」有关，落子时加减一个常数即可，不需要重扫。
 *
 * 为什么存计数而不是直接存分数：双活三的奖励要看「对方有没有四」，
 * 那是全局条件，只存一个分数就没法在对方情况变化时重算。存计数才能随时合出正确的分。
 *
 * 撤销走 `pop()` 把旧值写回，不重新计数：搜索里 `place` / `lift` 严格成对，
 * 撤回后的盘面与落子前逐格相同。这一步省下的是每条线一次完整扫描。
 *
 * 叶子评估网（v2.1.0）引入四个新字段，全部随 push/pop 增量维护：
 * - `byDir`：按方向聚合的形状计数（方向集中度特征）；
 * - `stones`：双方棋子数（棋子数 / 阶段特征）；
 * - `frontier`：双方前沿空点数，靠 `touch` 触色表做到 O(8) 更新；
 * - `stamp`：每次状态变化自增，同一局面只算一次特征要用。
 */
export class EvalCache {
  /** `线序号 * 12 + 颜色 * 6 + 形状`。 */
  private readonly byLine = new Int32Array(LINE_COUNT * SLOTS_PER_LINE);

  /** 全部线的计数总和，与 `byLine` 同布局。 */
  private readonly totals = new Int32Array(SLOTS_PER_LINE);

  /** `方向 * 12 + 颜色 * 6 + 形状`，方向序号与 DIRECTIONS 一致。 */
  private readonly byDir = new Int32Array(4 * SLOTS_PER_LINE);

  /** 双方位置分，下标 0 黑、1 白。 */
  private readonly position = new Int32Array(2);

  /** 双方棋子数，下标 0 黑、1 白。 */
  private readonly stones = new Int32Array(2);

  /** 双方前沿空点数（8 邻域内有该色子的空格），下标 0 黑、1 白。 */
  private readonly frontier = new Int32Array(2);

  /** 空格的邻色计数：`[0, 225)` 黑、`[225, 450)` 白；occupied 格的值冻结不维护。 */
  private readonly touch = new Int32Array(2 * N_CELLS);

  /** 状态代数：reset/push/pop 都会自增；特征 memo 以 (stamp, side) 为键。 */
  private stamp = 0;

  /** 每层的旧值：先 12 个总数，再 4 条线的计数块，最后双方位置分。 */
  private readonly undo = new Int32Array(MAX_LEVELS * UNDO_SIZE);
  private level = 0;

  /** 全量重建。一次搜索开始时调用一次，之后就靠 `push` / `pop` 维护。 */
  reset(board: BoardState): void {
    this.byLine.fill(0);
    this.totals.fill(0);
    this.byDir.fill(0);
    this.touch.fill(0);
    this.stones[0] = 0;
    this.stones[1] = 0;
    this.frontier[0] = 0;
    this.frontier[1] = 0;
    this.level = 0;

    for (let line = 0; line < LINE_COUNT; line += 1) {
      const base = line * SLOTS_PER_LINE;
      tallyLine(board, line, this.byLine, base);
      const dirBase = LINE_DIR[line] * SLOTS_PER_LINE;
      for (let i = 0; i < SLOTS_PER_LINE; i += 1) {
        this.totals[i] += this.byLine[base + i];
        this.byDir[dirBase + i] += this.byLine[base + i];
      }
    }

    this.position[0] = positionScore(board, BLACK);
    this.position[1] = positionScore(board, WHITE);

    for (let cell = 0; cell < N_CELLS; cell += 1) {
      const p = board[cell];
      if (p === EMPTY) continue;
      this.stones[p === BLACK ? 0 : 1] += 1;
      const start = cell * 8;
      const colorBase = p === BLACK ? 0 : N_CELLS;
      for (let k = 0; k < 8; k += 1) {
        const n = NB_CELLS[start + k];
        if (n >= 0 && board[n] === EMPTY) this.touch[colorBase + n] += 1;
      }
    }
    for (let cell = 0; cell < N_CELLS; cell += 1) {
      if (board[cell] !== EMPTY) continue;
      if (this.touch[cell] > 0) this.frontier[0] += 1;
      if (this.touch[N_CELLS + cell] > 0) this.frontier[1] += 1;
    }

    this.stamp += 1;
  }

  /** 落子或提子之后重算经过该格的四条线，并把旧值压栈。方向缺失（短对角线）时跳过。 */
  push(board: BoardState, cell: number, side: Player): void {
    if (this.level >= MAX_LEVELS) throw new Error('评估缓存层数溢出');
    let slot = this.level * UNDO_SIZE;

    for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.undo[slot + i] = this.totals[i];
    slot += SLOTS_PER_LINE;

    for (let dir = 0; dir < 4; dir += 1) {
      const line = CELL_LINES[(cell << 2) | dir];
      const dirBase = dir * SLOTS_PER_LINE;
      // byDir 的该方向块在改动前存档；无线的方向存档即恢复（原值不动）
      for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.undo[slot + i] = this.byDir[dirBase + i];
      slot += SLOTS_PER_LINE;
      if (line < 0) {
        for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.undo[slot + i] = 0;
        slot += SLOTS_PER_LINE;
        continue;
      }

      const base = line * SLOTS_PER_LINE;
      for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.undo[slot + i] = this.byLine[base + i];
      slot += SLOTS_PER_LINE;

      for (let i = 0; i < SLOTS_PER_LINE; i += 1) {
        this.totals[i] -= this.byLine[base + i];
        this.byDir[dirBase + i] -= this.byLine[base + i];
      }
      tallyLine(board, line, this.byLine, base);
      for (let i = 0; i < SLOTS_PER_LINE; i += 1) {
        this.totals[i] += this.byLine[base + i];
        this.byDir[dirBase + i] += this.byLine[base + i];
      }
    }

    // 两个位置分、双方棋子数都记，且固定按「黑、白」顺序：恢复时不必再知道是哪一方落子
    this.undo[slot] = this.position[0];
    this.undo[slot + 1] = this.position[1];
    slot += 2;
    this.undo[slot] = this.stones[0];
    this.undo[slot + 1] = this.stones[1];
    slot += 2;
    this.position[side === BLACK ? 0 : 1] += positionWeight(cell);
    this.stones[side === BLACK ? 0 : 1] += 1;

    // 落点从空格变棋子：先按旧触色从两色前沿里除名
    this.undo[slot] = this.frontier[0];
    this.undo[slot + 1] = this.frontier[1];
    slot += 2;
    if (this.touch[cell] > 0) this.frontier[0] -= 1;
    if (this.touch[N_CELLS + cell] > 0) this.frontier[1] -= 1;
    // 落点自身触色冻结存档，pop 时原样恢复
    this.undo[slot] = cell;
    this.undo[slot + 1] = this.touch[cell];
    this.undo[slot + 2] = this.touch[N_CELLS + cell];
    slot += 3;

    // 空邻格补上「贴着落子方」的触色；首次贴上才计入前沿
    const colorBase = side === BLACK ? 0 : N_CELLS;
    const colorIdx = side === BLACK ? 0 : 1;
    const start = cell * 8;
    for (let k = 0; k < 8; k += 1) {
      const n = NB_CELLS[start + k];
      if (n >= 0) {
        this.undo[slot + 1] = this.touch[n];
        this.undo[slot + 2] = this.touch[N_CELLS + n];
      } else {
        this.undo[slot + 1] = 0;
        this.undo[slot + 2] = 0;
      }
      this.undo[slot] = n;
      slot += 3;
      if (n < 0 || board[n] !== EMPTY) continue;
      const t = this.touch[colorBase + n];
      if (t === 0) this.frontier[colorIdx] += 1;
      this.touch[colorBase + n] = t + 1;
    }

    this.level += 1;
    this.stamp += 1;
  }

  /** 撤回：盘面已经回到落子前，把旧值写回。 */
  pop(cell: number): void {
    if (this.level <= 0) throw new Error('评估缓存层数下溢');
    this.level -= 1;
    let slot = this.level * UNDO_SIZE;

    for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.totals[i] = this.undo[slot + i];
    slot += SLOTS_PER_LINE;

    for (let dir = 0; dir < 4; dir += 1) {
      const line = CELL_LINES[(cell << 2) | dir];
      const dirBase = dir * SLOTS_PER_LINE;
      for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.byDir[dirBase + i] = this.undo[slot + i];
      slot += SLOTS_PER_LINE;
      if (line < 0) {
        slot += SLOTS_PER_LINE;
        continue;
      }
      const base = line * SLOTS_PER_LINE;
      for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.byLine[base + i] = this.undo[slot + i];
      slot += SLOTS_PER_LINE;
    }

    this.position[0] = this.undo[slot];
    this.position[1] = this.undo[slot + 1];
    slot += 2;
    this.stones[0] = this.undo[slot];
    this.stones[1] = this.undo[slot + 1];
    slot += 2;
    this.frontier[0] = this.undo[slot];
    this.frontier[1] = this.undo[slot + 1];
    slot += 2;

    // 落点触色恢复（occupied 期间其触色被冻结，不会错）
    const selfCell = this.undo[slot];
    this.touch[selfCell] = this.undo[slot + 1];
    this.touch[N_CELLS + selfCell] = this.undo[slot + 2];
    slot += 3;

    for (let k = 0; k < 8; k += 1) {
      const n = this.undo[slot];
      if (n >= 0) {
        this.touch[n] = this.undo[slot + 1];
        this.touch[N_CELLS + n] = this.undo[slot + 2];
      }
      slot += 3;
    }

    this.stamp += 1;
  }

  score(side: Player): number {
    return combine(this.totals, this.position, side);
  }

  // ---- 叶子特征的只读视图 ------------------------------------------------
  // 返回内部数组：调用方只读不写；写在注释里约定，换取零拷贝。

  /** 全局形状计数：`颜色 * 6 + 形状`。 */
  get totalsView(): Int32Array {
    return this.totals;
  }

  /** 按方向聚合的形状计数：`方向 * 12 + 颜色 * 6 + 形状`。 */
  get dirTotalsView(): Int32Array {
    return this.byDir;
  }

  /** 双方棋子数：[黑, 白]。 */
  get stoneCounts(): Int32Array {
    return this.stones;
  }

  /** 双方前沿空点数：[黑, 白]。 */
  get frontierCounts(): Int32Array {
    return this.frontier;
  }

  /** 双方位置分：[黑, 白]。 */
  get positionScores(): Int32Array {
    return this.position;
  }

  /** 状态代数：与 (side) 一起构成特征 memo 的键。 */
  get stampValue(): number {
    return this.stamp;
  }
}
