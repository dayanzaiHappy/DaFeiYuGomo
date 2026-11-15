import type { SearchRequest } from '../ai/client';
import { AB_PROFILES } from '../game/ai-config';
import { checkWin, getWinLine, isBoardFull, isValidMove, placeStone } from '../game/board';
import { shapeCounts, type ShapeCounts } from '../game/eval';
import {
  BLACK,
  EMPTY,
  N_CELLS,
  WHITE,
  other,
  type BoardState,
  type Player,
  type SearchResult,
} from '../game/types';

/**
 * 分析板控制器。
 *
 * 与复盘控制器最大的区别：这里是**可写**的局面。
 * 所有盘面都在构造时复制一份，对局状态（`state.board`、走子历史）一概不碰——
 * 分析板是「如果这样下会怎样」的沙盘，不是对局的第二个副本。
 *
 * 不记录、不评级、不导出：这些属于复盘域，分析板只回答「当前这一手的分数与候补」。
 */

export interface AnalysisMove {
  player: Player;
  move: number;
}

export interface AnalysisSeed {
  board: BoardState;
  history: ReadonlyArray<AnalysisMove>;
  toMove: Player;
}

export type AnalysisMode = 'auto' | 'deep';

/**
 * 只依赖搜索这一个方法，不绑死 `AiClient`。
 * 单测里用一个同步返回的假引擎就能跑完整套状态机，不需要 Worker 与模型。
 */
export interface AnalysisEngine {
  search(board: Uint8Array, player: Player, request: SearchRequest): Promise<SearchResult>;
  cancelAll(): void;
}

export interface AnalysisThreats {
  black: ShapeCounts;
  white: ShapeCounts;
}

export class AnalysisController {
  board: BoardState;
  history: AnalysisMove[];
  toMove: Player;
  lastMove: number | null;
  /** 最近一次搜索结果；盘面一变就作废。 */
  result: SearchResult | null = null;
  /** 五连的一方；null 表示未结束。 */
  winner: Player | null = null;
  draw = false;
  /** 最近一次搜索失败的原因；取消不算失败。 */
  error: string | null = null;

  private readonly seed: AnalysisSeed;
  private undone: AnalysisMove[] = [];
  /** 成五的那一手；只用来画五连线，可能为 null（手动摆出的局面）。 */
  private winAt: number | null = null;
  /** 盘面代号：每次改动自增，在途结果靠它判断自己是否过期。 */
  private generation = 0;
  /** 最新一次请求的模式；null 表示没有待办。 */
  private wanted: AnalysisMode | null = null;
  private running = false;
  private engine: AnalysisEngine | null = null;

  constructor(seed: AnalysisSeed) {
    this.seed = {
      board: new Uint8Array(seed.board),
      history: seed.history.map((item) => ({ ...item })),
      toMove: seed.toMove,
    };

    this.board = new Uint8Array(seed.board);
    this.history = seed.history.map((item) => ({ ...item }));
    this.toMove = seed.toMove;
    this.lastMove = this.history.length > 0 ? this.history[this.history.length - 1].move : null;
    this.settle();
  }

  /** 局面已经分出胜负或下满：不再落子，也不再搜索。 */
  get terminal(): boolean {
    return this.winner !== null || this.draw;
  }

  get busy(): boolean {
    return this.running;
  }

  get plies(): number {
    return this.history.length;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  place(move: number): boolean {
    if (this.terminal) return false;
    if (!isValidMove(this.board, move)) return false;
    this.write(move, this.toMove);
    return true;
  }

  /** 悔棋：撤回最后一手，并把轮次还给走那手的一方。 */
  undo(): boolean {
    const last = this.history.pop();
    if (!last) return false;
    this.board[last.move] = 0;
    this.undone.push(last);
    this.toMove = last.player;
    this.lastMove = this.history.length > 0 ? this.history[this.history.length - 1].move : null;
    this.invalidate();
    this.settle();
    return true;
  }

  /** 重下：把悔掉的一手接回去。落点被占（中途换过手）就整条重下栈作废。 */
  redo(): boolean {
    const next = this.undone.pop();
    if (!next) return false;
    if (!isValidMove(this.board, next.move)) {
      this.undone = [];
      return false;
    }
    this.board = placeStone(this.board, next.move, next.player);
    this.history.push(next);
    this.lastMove = next.move;
    this.toMove = other(next.player);
    this.invalidate();
    this.settle();
    return true;
  }

  /** 回到进入分析时的局面。 */
  reset(): void {
    this.board = new Uint8Array(this.seed.board);
    this.history = this.seed.history.map((item) => ({ ...item }));
    this.toMove = this.seed.toMove;
    this.lastMove = this.history.length > 0 ? this.history[this.history.length - 1].move : null;
    this.undone = [];
    this.invalidate();
    this.settle();
  }

  /** 清空：从空盘开始摆特定局面，这是「特定状态模拟」的起点。 */
  clear(): void {
    this.board = new Uint8Array(N_CELLS);
    this.history = [];
    this.toMove = BLACK;
    this.lastMove = null;
    this.undone = [];
    this.invalidate();
    this.settle();
  }

  /**
   * 换手：只翻转「轮到谁」，不动盘面与历史。
   *
   * 真实对局里轮次由手数奇偶锁死，但分析时常要问「这个局面如果换对方先走会怎样」，
   * 而那个问题的答案和当前手数无关。
   */
  flip(): void {
    this.toMove = other(this.toMove);
    this.invalidate();
  }

  winLine(): number[] {
    if (this.winAt === null) return [];
    return getWinLine(this.board, this.winAt);
  }

  threats(): AnalysisThreats {
    return {
      black: shapeCounts(this.board, BLACK),
      white: shapeCounts(this.board, WHITE),
    };
  }

  /**
   * 发起一次搜索；多次请求按「最新一次胜出」收敛。
   *
   * 不在前一次没回来时并发发第二次：alpha-beta 在 Worker 里是同步计算，根本没法打断，
   * 并发只会让请求在队列里排队，最后拿回来一串过期结果。这里改成串行 + 只保留最新意图，
   * 最多多跑一次。
   */
  async request(
    mode: AnalysisMode,
    engine: AnalysisEngine,
    onChange: () => void,
  ): Promise<void> {
    if (this.terminal) {
      this.wanted = null;
      this.result = null;
      onChange();
      return;
    }

    this.engine = engine;
    this.wanted = mode;
    if (this.running) {
      onChange();
      return;
    }

    this.running = true;
    onChange();
    try {
      while (this.wanted !== null) {
        const current = this.wanted;
        this.wanted = null;
        await this.searchOnce(current, engine);
        onChange();
      }
    } finally {
      this.running = false;
      this.engine = null;
      onChange();
    }
  }

  /** 停止：丢掉待办，并让在途结果作废。搜索本身能不能立刻停由引擎决定。 */
  stop(): void {
    this.wanted = null;
    this.generation += 1;
    this.engine?.cancelAll();
    this.engine = null;
  }

  dispose(): void {
    this.stop();
  }

  private write(move: number, player: Player): void {
    this.board = placeStone(this.board, move, player);
    this.history.push({ player, move });
    this.lastMove = move;
    this.toMove = other(player);
    this.undone = [];
    this.invalidate();
    this.settle();
  }

  private invalidate(): void {
    this.generation += 1;
    this.result = null;
    this.error = null;
  }

  /**
   * 结算盘面。
   *
   * 不看最后一手，直接扫盘找五连：分析板允许从一个摆了半天的局面进入，
   * 那时最后一手可能是 null，也可能和五连无关（换过手）。扫一次全盘的代价
   * 只在用户落子/悔棋时付，与搜索无关。
   */
  private settle(): void {
    let winner: Player | null = null;
    let winAt: number | null = null;
    for (let move = 0; move < N_CELLS && winner === null; move += 1) {
      if (this.board[move] === EMPTY) continue;
      winner = checkWin(this.board, move);
      if (winner !== null) winAt = move;
    }
    this.winner = winner;
    this.winAt = winAt;
    this.draw = winner === null && isBoardFull(this.board);
  }

  private async searchOnce(mode: AnalysisMode, engine: AnalysisEngine): Promise<void> {
    const generation = this.generation;
    const player = this.toMove;
    const board = new Uint8Array(this.board);

    let result: SearchResult;
    try {
      result = await engine.search(board, player, this.requestOf(mode));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('取消') && generation === this.generation) this.error = message;
      return;
    }

    // 盘面在搜索期间变了：这份结果回答的是上一个局面，直接丢
    if (generation !== this.generation) return;
    this.error = null;
    this.result = {
      ...result,
      // 旧记录里的候选带 visits，0 表示「建过节点但没搜过」。新搜索不产出这个字段，
      // 一律视为已搜；最佳着本身无论有没有 visits 都留下，否则会出现「有推荐、没候补」。
      top: result.top.filter(
        (item) => item.visits === undefined || item.visits > 0 || item.move === result.move,
      ),
    };
  }

  /**
   * 自动分析走困难档：提示档一次要两秒级，连点几下就排不上队；
   * 想要提示档的质量就点「深入分析」，那是用户主动的一次等待。
   */
  private requestOf(mode: AnalysisMode): SearchRequest {
    const profile = mode === 'deep' ? AB_PROFILES.hint : AB_PROFILES.hard;
    return { ab: { ...profile } };
  }
}
