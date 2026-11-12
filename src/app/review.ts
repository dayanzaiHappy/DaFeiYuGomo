import type { AiClient } from '../ai/client';
import {
  AI_CONFIG,
  REVIEW_PROFILE,
  isAiDifficulty,
  toSearchOptions,
  type AiDifficulty,
} from '../game/ai-config';
import { buildRecord, type ParsedRecord } from '../game/record';
import {
  OPENING_PLIES,
  buildReviewPoints,
  buildReviewedMoves,
  humanValueOf,
  resultOf,
  setPointValue,
  terminalMoverValue,
  type ReviewPoint,
  type ReviewedMove,
} from '../game/review';
import { placeStone } from '../game/board';
import { BLACK, N_CELLS, WHITE, other, type BoardState, type Player } from '../game/types';

/**
 * 复盘控制器：持有快照、局面点与着手，负责把评估请求串行喂给 Worker。
 *
 * 只读：所有盘面都在构造时复制一份，不碰对局状态。
 * 评估是一次一个局面的串行请求——Worker 本来也只跑一个搜索，
 * 并发发过去只会排队，还拿不到中间进度。
 */

export interface ReviewSnapshot {
  history: ReadonlyArray<{ player: Player; move: number }>;
  humanColor: Player;
  difficulty: AiDifficulty;
  winner: Player | null;
  createdAt: string;
}

export type ReviewMode = 'fast' | 'deep';

export interface ReviewProgress {
  mode: ReviewMode;
  done: number;
  total: number;
  busy: boolean;
}

/** 记录头里的结果串 → 胜方；不认识的字符串直接报错。 */
function winnerOf(result: string): Player | null {
  if (result === 'B+') return BLACK;
  if (result === 'W+') return WHITE;
  if (result === 'Draw') return null;
  throw new Error(`记录里的结果不合法：${result}`);
}

export class ReviewController {
  readonly points: ReviewPoint[];
  readonly boards: BoardState[];
  moves: ReviewedMove[] = [];
  mode: ReviewMode | null = null;
  busy = false;
  done = 0;

  private fastValues: Array<number | null> = [];
  private token = 0;
  private engine: AiClient | null = null;

  constructor(
    readonly snapshot: ReviewSnapshot,
    readonly source: 'live' | 'imported' = 'live',
  ) {
    this.points = buildReviewPoints(snapshot.history);

    this.boards = [new Uint8Array(N_CELLS)];
    let board = this.boards[0];
    for (const item of snapshot.history) {
      board = placeStone(board, item.move, item.player);
      this.boards.push(board);
    }

    this.applyTerminal();
    this.refreshMoves();
  }

  /**
   * 从导出的 JSONL 重建复盘，不跑任何推理。
   *
   * 值、评级、标签都按记录原样还原：导入的是当时那份结论，不是按今天规则重算的结论。
   * 校验比 parseRecord 更严：难度、结果串、手数连续性、黑白交替、重复落子。
   */
  static fromRecord(parsed: ParsedRecord): ReviewController {
    const { header, moves } = parsed;
    if (!isAiDifficulty(header.difficulty)) {
      throw new Error('记录里的难度不合法');
    }
    if (moves.length === 0) throw new Error('记录里没有着手');

    const humanColor = header.humanColor;
    const history: Array<{ player: Player; move: number }> = [];
    const used = new Set<number>();
    moves.forEach((move, index) => {
      if (move.ply !== index + 1) {
        throw new Error(`手数不连续：第 ${index + 1} 行写的是第 ${move.ply} 手`);
      }
      const expected = index % 2 === 0 ? BLACK : WHITE;
      if (move.player !== expected) {
        throw new Error(`黑白不交替：第 ${move.ply} 手`);
      }
      if (!Number.isInteger(move.move) || move.move < 0 || move.move >= N_CELLS) {
        throw new Error(`落点越界：第 ${move.ply} 手`);
      }
      if (used.has(move.move)) throw new Error(`重复落子：第 ${move.ply} 手`);
      used.add(move.move);
      history.push({ player: move.player, move: move.move });
    });

    const controller = new ReviewController(
      {
        history,
        humanColor,
        difficulty: header.difficulty,
        winner: winnerOf(header.result),
        createdAt: header.createdAt,
      },
      'imported',
    );

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      const before = controller.points[i];
      const after = controller.points[i + 1];
      if (move.moverBefore !== null) {
        setPointValue(before, move.moverBefore, humanColor, move.quality);
      }
      if (move.moverAfter !== null) {
        setPointValue(after, move.moverAfter, humanColor, move.quality);
      }
      before.bestMove = move.bestMove;
      before.top = move.top;
    }

    controller.moves = moves.map((move) => ({
      ply: move.ply,
      player: move.player,
      move: move.move,
      human: move.player === humanColor,
      moverBefore: move.moverBefore,
      moverAfter: move.moverAfter,
      // 记录里的 human* 是派生值，以 header 的 humanColor 为准重算
      humanBefore: humanValueOf(move.moverBefore, move.player, humanColor),
      humanAfter: humanValueOf(move.moverAfter, other(move.player), humanColor),
      loss: move.loss,
      grade: move.grade,
      tags: move.tags,
      bestMove: move.bestMove,
      top: move.top,
      opening: move.opening ?? move.ply <= OPENING_PLIES,
      fastValue: move.fast?.value ?? null,
      status:
        move.quality === 'deep'
          ? move.moverBefore !== null && move.moverAfter !== null
            ? 'done'
            : 'deep'
          : move.moverBefore !== null
            ? 'fast'
            : 'pending',
    }));
    controller.fastValues = moves.map((move) => move.fast?.value ?? null);
    controller.mode = moves.some((move) => move.quality === 'deep') ? 'deep' : 'fast';
    controller.done = moves.length;
    return controller;
  }

  get total(): number {
    return this.snapshot.history.length;
  }

  progress(): ReviewProgress {
    return { mode: this.mode ?? 'fast', done: this.done, total: this.total, busy: this.busy };
  }

  /** 深评剩余时间的粗估：一次模拟约等于一次前向。 */
  remainingSeconds(evalMs: number): number {
    const perPoint = this.mode === 'deep' ? REVIEW_PROFILE.sims : 1;
    return Math.max(0, (this.total - this.done) * perPoint * evalMs) / 1000;
  }

  boardAt(index: number): BoardState {
    return this.boards[Math.max(0, Math.min(this.boards.length - 1, index))];
  }

  /** 用一次评估填完所有局面；终局点保留真实结果，不送给网络。 */
  async run(
    mode: ReviewMode,
    engine: AiClient,
    onChange: () => void,
  ): Promise<void> {
    if (this.source === 'imported') throw new Error('导入的记录是只读的');
    if (this.busy) return;
    const token = ++this.token;
    this.engine = engine;
    this.mode = mode;
    this.busy = true;
    this.done = 0;
    this.resetValues(mode === 'fast');
    onChange();

    try {
      if (mode === 'fast') {
        for (let i = 0; i < this.total; i++) {
          if (this.token !== token) return;
          const point = this.points[i];
          const result = await engine.evaluate(new Uint8Array(this.boards[i]), point.player);
          if (this.token !== token) return;
          setPointValue(point, result.value, this.snapshot.humanColor, 'fast');
          this.done = i + 1;
          this.refreshMoves();
          onChange();
        }
        this.fastValues = this.points.map((point) => point.moverValue);
      } else {
        for (let i = 0; i < this.total; i++) {
          if (this.token !== token) return;
          const point = this.points[i];
          const result = await engine.search(new Uint8Array(this.boards[i]), point.player, {
            ...toSearchOptions(REVIEW_PROFILE),
            topk: AI_CONFIG.hintTopK,
          });
          if (this.token !== token) return;
          setPointValue(point, result.value, this.snapshot.humanColor, 'deep');
          point.bestMove = result.move >= 0 ? result.move : null;
          point.top = result.top.filter((item) => item.visits > 0);
          this.done = i + 1;
          this.refreshMoves();
          onChange();
        }
        // 终局是确定值，但整条曲线已经全部来自搜索，标记也要统一
        const last = this.points[this.points.length - 1];
        if (last) last.quality = 'deep';
        this.refreshMoves();
      }
    } finally {
      if (this.token === token) {
        this.busy = false;
        onChange();
      }
    }
  }

  /** 停止当前评估；已完成的结果保留。 */
  stop(): void {
    if (!this.busy) return;
    this.token++;
    this.busy = false;
    this.engine?.cancelAll();
    this.engine = null;
  }

  /** 退出复盘时调用，确保 Worker 不再为已关闭的界面干活。 */
  dispose(): void {
    this.stop();
  }

  exportRecord(options: {
    appVersion: string;
    modelVersion: string;
    modelHash: string | null;
  }): string {
    const built = buildRecord(
      {
        appVersion: options.appVersion,
        engineVersion: AI_CONFIG.engineVersion,
        modelVersion: options.modelVersion,
        modelHash: options.modelHash,
        reviewProfile: [
          REVIEW_PROFILE.sims,
          REVIEW_PROFILE.rootLimit,
          REVIEW_PROFILE.forcedPlies,
          REVIEW_PROFILE.vcfDepth,
        ].join('/'),
        humanColor: this.snapshot.humanColor,
        difficulty: this.snapshot.difficulty,
        result: resultOf(this.snapshot.winner),
        createdAt: this.snapshot.createdAt,
      },
      this.moves,
    );
    return built.text;
  }

  private applyTerminal(): void {
    const last = this.points[this.points.length - 1];
    if (!last) return;
    const value = terminalMoverValue(this.snapshot.winner, last.player);
    setPointValue(last, value, this.snapshot.humanColor, 'fast');
  }

  /**
   * 换模式时清掉上一种模式的值。
   * 不清的话，简易重跑会把深评的 bestMove/top 留在点上，记录里就会出现
   * 「quality=deep、值却来自网络」的混口径。
   */
  private resetValues(clearFastCache: boolean): void {
    for (const point of this.points) {
      point.moverValue = null;
      point.humanValue = null;
      point.bestMove = null;
      point.top = null;
      point.quality = 'fast';
    }
    if (clearFastCache) this.fastValues = [];
    this.applyTerminal();
    this.refreshMoves();
  }

  private refreshMoves(): void {
    this.moves = buildReviewedMoves(
      this.points,
      this.snapshot.history,
      this.snapshot.humanColor,
      this.boards,
      this.fastValues,
    );
  }
}
