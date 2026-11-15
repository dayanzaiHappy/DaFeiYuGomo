import {
  BLACK,
  DIRECTIONS,
  EMPTY,
  N_CELLS,
  SIZE,
  WHITE,
  type BoardState,
  type Player,
} from './types';
import { directionTier } from './tactics';

/** 与搜索的递归硬顶一致：超过这个层数就不再做撤销记录。 */
const MAX_LEVELS = 48;

/** 每层要记的条目：4 方向 × 9 格 × 2 色；越界位置留两个 0xffff 占位。 */
const UNDO_SIZE = 4 * 9 * 2;

/**
 * 每个空点、每个方向的威胁档位缓存。
 *
 * 搜索里最贵的一件事是「这个候选点能造出什么」——原来每个节点都要对几十个候选
 * 各跑四次形状检测。但落子只会改变**经过它的那四条线**上、距离不超过 4 的格子，
 * 其余格子的档位一点没变。所以把档位按「格子 × 方向 × 颜色」存下来，
 * 落子时只刷新 4 × 9 个格子，读取时是四次数组访问。
 *
 * 为什么按方向分开存：一次落子只影响一条方向上的连子，另外三个方向不用重算。
 * 合并成「每格一个总分」就没法只更新一维，得四个方向全重算，白花三倍。
 *
 * 撤销走 `pop()` 而不是再算一遍：搜索里 `place` / `lift` 严格成对，
 * 撤回后的盘面与落子前逐格相同，缓存自然也该回到原值。记 72 个旧值再写回，
 * 比重新跑 72 次形状检测便宜一个量级——这是整个搜索最热的路径。
 */
export class ThreatCache {
  /** 下标 `(格子 * 4 + 方向) * 2 + 颜色`，取值是 TIER_*。 */
  private readonly byDirection = new Uint16Array(N_CELLS * 8);

  /** 每层的旧值，布局与刷新顺序一致。 */
  private readonly undo = new Uint16Array(MAX_LEVELS * UNDO_SIZE);
  private level = 0;

  /** 全量重建。只在一次搜索开始时调用一次。 */
  reset(board: BoardState): void {
    this.byDirection.fill(0);
    this.level = 0;
    for (let move = 0; move < N_CELLS; move += 1) {
      if (board[move] !== EMPTY) continue;
      for (let dir = 0; dir < 4; dir += 1) {
        this.byDirection[(move << 3) | (dir << 1)] = directionTier(board, move, BLACK, dir);
        this.byDirection[(move << 3) | (dir << 1) | 1] = directionTier(board, move, WHITE, dir);
      }
    }
  }

  /**
   * 落子后刷新经过该格的四条线，并把旧值压栈。
   *
   * 只碰距离 4 以内的格子：更远的位置，它的连子看不见这里的变化。
   * 已占用的格子顺手跳过重算——档位只对空点有意义。跳过也照样记旧值，
   * 保证 `pop` 的遍历与这里逐项对齐。
   */
  push(board: BoardState, cell: number): void {
    if (this.level >= MAX_LEVELS) throw new Error('威胁缓存层数溢出');
    let slot = this.level * UNDO_SIZE;
    const row = Math.floor(cell / SIZE);
    const col = cell % SIZE;

    for (let dir = 0; dir < 4; dir += 1) {
      const [dr, dc] = DIRECTIONS[dir];
      for (let step = -4; step <= 4; step += 1) {
        const r = row + dr * step;
        const c = col + dc * step;
        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) {
          this.undo[slot] = 0xffff;
          this.undo[slot + 1] = 0xffff;
          slot += 2;
          continue;
        }

        const target = r * SIZE + c;
        const key = (target << 3) | (dir << 1);
        this.undo[slot] = this.byDirection[key];
        this.undo[slot + 1] = this.byDirection[key | 1];
        slot += 2;

        if (board[target] !== EMPTY) continue;
        this.byDirection[key] = directionTier(board, target, BLACK, dir);
        this.byDirection[key | 1] = directionTier(board, target, WHITE, dir);
      }
    }

    this.level += 1;
  }

  /** 撤回：盘面已经回到落子前，按同一顺序把旧值写回。 */
  pop(cell: number): void {
    if (this.level <= 0) throw new Error('威胁缓存层数下溢');
    this.level -= 1;
    let slot = this.level * UNDO_SIZE;
    const row = Math.floor(cell / SIZE);
    const col = cell % SIZE;

    for (let dir = 0; dir < 4; dir += 1) {
      const [dr, dc] = DIRECTIONS[dir];
      for (let step = -4; step <= 4; step += 1) {
        const r = row + dr * step;
        const c = col + dc * step;
        if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
          const key = ((r * SIZE + c) << 3) | (dir << 1);
          this.byDirection[key] = this.undo[slot];
          this.byDirection[key | 1] = this.undo[slot + 1];
        }
        slot += 2;
      }
    }
  }

  /**
   * 这一手能为 player 造出的最高档位，等价于 `attackTier`。
   *
   * 四个方向取最大；不另存一份合并值——那要多维护一张表，
   * 而这里只有四次数组读，省下的维护成本不值。
   */
  attack(move: number, player: Player): number {
    const base = move << 3;
    const color = player === BLACK ? 0 : 1;
    let best = this.byDirection[base | color];
    const second = this.byDirection[base + 2 + color];
    if (second > best) best = second;
    const third = this.byDirection[base + 4 + color];
    if (third > best) best = third;
    const fourth = this.byDirection[base + 6 + color];
    if (fourth > best) best = fourth;
    return best;
  }
}
