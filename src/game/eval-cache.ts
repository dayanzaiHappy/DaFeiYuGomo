import { combine, positionScore, positionWeight, SHAPE_SLOTS, tallyLine } from './eval';
import { CELL_LINES, LINE_COUNT } from './lines';
import { BLACK, WHITE, type BoardState, type Player } from './types';

/** 一条线要存双方各 6 个形状计数。 */
const SLOTS_PER_LINE = SHAPE_SLOTS * 2;

/** 与搜索的递归硬顶一致。 */
const MAX_LEVELS = 48;

/** 每层记录：12 个总数 + 4 条线的计数 + 双方位置分。 */
const UNDO_SIZE = SLOTS_PER_LINE * 5 + 2;

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
 */
export class EvalCache {
  /** `线序号 * 12 + 颜色 * 6 + 形状`。 */
  private readonly byLine = new Int32Array(LINE_COUNT * SLOTS_PER_LINE);

  /** 全部线的计数总和，与 `byLine` 同布局。 */
  private readonly totals = new Int32Array(SLOTS_PER_LINE);

  /** 双方位置分，下标 0 黑、1 白。 */
  private readonly position = new Int32Array(2);

  /** 每层的旧值：先 12 个总数，再 4 条线的计数块，最后双方位置分。 */
  private readonly undo = new Int32Array(MAX_LEVELS * UNDO_SIZE);
  private level = 0;

  /** 全量重建。一次搜索开始时调用一次，之后就靠 `push` / `pop` 维护。 */
  reset(board: BoardState): void {
    this.byLine.fill(0);
    this.totals.fill(0);
    this.level = 0;

    for (let line = 0; line < LINE_COUNT; line += 1) {
      const base = line * SLOTS_PER_LINE;
      tallyLine(board, line, this.byLine, base);
      for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.totals[i] += this.byLine[base + i];
    }

    this.position[0] = positionScore(board, BLACK);
    this.position[1] = positionScore(board, WHITE);
  }

  /** 落子或提子之后重算经过该格的四条线，并把旧值压栈。方向缺失（短对角线）时跳过。 */
  push(board: BoardState, cell: number, side: Player): void {
    if (this.level >= MAX_LEVELS) throw new Error('评估缓存层数溢出');
    let slot = this.level * UNDO_SIZE;

    for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.undo[slot + i] = this.totals[i];
    slot += SLOTS_PER_LINE;

    for (let dir = 0; dir < 4; dir += 1) {
      const line = CELL_LINES[(cell << 2) | dir];
      if (line < 0) {
        for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.undo[slot + i] = 0;
        slot += SLOTS_PER_LINE;
        continue;
      }

      const base = line * SLOTS_PER_LINE;
      for (let i = 0; i < SLOTS_PER_LINE; i += 1) {
        this.undo[slot + i] = this.byLine[base + i];
        this.totals[i] -= this.byLine[base + i];
      }
      slot += SLOTS_PER_LINE;

      tallyLine(board, line, this.byLine, base);
      for (let i = 0; i < SLOTS_PER_LINE; i += 1) this.totals[i] += this.byLine[base + i];
    }

    // 两个位置分都记，且固定按「黑、白」顺序：恢复时不必再知道是哪一方落子
    this.undo[slot] = this.position[0];
    this.undo[slot + 1] = this.position[1];
    this.position[side === BLACK ? 0 : 1] += positionWeight(cell);

    this.level += 1;
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
  }

  score(side: Player): number {
    return combine(this.totals, this.position, side);
  }
}
