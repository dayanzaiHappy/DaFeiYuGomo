import { judgeMove, type CoachVerdict } from './coach';
import { BLACK, EMPTY, other, type BoardState, type Player, type SearchTop } from './types';

/**
 * 复盘的数据模型与判定规则。
 *
 * 两条口径贯穿全文：
 * 1. `moverValue` 是行棋方视角，模型与搜索都按这个口径输出；`humanValue` 只是翻给人类看。
 * 2. `loss` 永远按行棋方算。AI 的败着就是 AI 的损失，不换算成人类的收益，
 *    否则「对手崩了」会显示成「你下得好」。
 */

export type MoveGrade = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/** 该点的值来自一次网络前向（fast）还是一次搜索（deep）。混合曲线必须能区分。 */
export type ReviewQuality = 'fast' | 'deep';

/**
 * 评级阈值，单位是「估值损失」，不是校准后的胜率损失。
 * 模型 value 没有校准，这套阈值只保证同一模型内相对可比；要改必须重跑一批评测对局。
 */
export const GRADE_LOSS = {
  inaccuracy: 0.05,
  mistake: 0.1,
  blunder: 0.2,
} as const;

/**
 * 开局段手数：前两手不评级、不打标签、不给 Top-3。
 *
 * 三个原因都出在这两手：
 * 1. AI 执黑时第一手固定天元，`place(112)` 不是决策，评成「最佳」等于白送一分；
 * 2. 空盘点在 `legalMoves` 里只有天元一个候选，先手若下在别处，会被一个搜索
 *    根本没考虑过的点当「最佳」；
 * 3. 只有一两颗子时，49 次模拟排在 12 个候选上，top-1 本身就是噪声。
 *
 * 想覆盖到第 4 手（盘面 3 子）就把它改成 4，其余代码不用动。
 */
export const OPENING_PLIES = 2;

export interface ReviewPoint {
  /** 0 = 空盘，i = 走了 i 手之后。 */
  index: number;
  /** 该局面轮到谁走。 */
  player: Player;
  /** 行棋方（该局面轮到谁）视角；null 表示还没评估。 */
  moverValue: number | null;
  /** 人类视角；只用于图表与汇总，不参与评级。 */
  humanValue: number | null;
  /** 该局面行棋方的最佳着；深评后填充。 */
  bestMove: number | null;
  /** 深评的前 3 候选；深评后填充。 */
  top: SearchTop[] | null;
  quality: ReviewQuality;
}

export interface ReviewedMove {
  /** 1-based。 */
  ply: number;
  player: Player;
  move: number;
  /** 只影响措辞与汇总分组，不决定是否评级。 */
  human: boolean;
  /** 落子前，行棋方视角。 */
  moverBefore: number | null;
  /** 落子后，**对方**视角；评级用的损失会先把它翻回来。 */
  moverAfter: number | null;
  humanBefore: number | null;
  humanAfter: number | null;
  loss: number | null;
  grade: MoveGrade | null;
  tags: CoachVerdict[];
  bestMove: number | null;
  top: SearchTop[] | null;
  /** 开局段：只记录估值，不评级、不打标签、不给最佳着。 */
  opening: boolean;
  /** 简易评估留下的网络 value；深评会覆盖 mover*，这里保留原值以便记录两种口径。 */
  fastValue: number | null;
  /** pending 无值，fast 只有网络值，deep 深评进行中，done 两端都是深评。 */
  status: 'pending' | 'fast' | 'deep' | 'done';
}

/** 把行棋方视角翻成人类视角；人类执黑时两者相同，执白时互补。 */
export function humanValueOf(
  moverValue: number | null,
  player: Player,
  humanColor: Player,
): number | null {
  if (moverValue === null) return null;
  return player === humanColor ? moverValue : 1 - moverValue;
}

/** 终局值：按「该局面轮到谁」给 1 / 0 / 0.5，与搜索的视角一致。 */
export function terminalMoverValue(winner: Player | null, player: Player): number {
  if (winner === null) return 0.5;
  return winner === player ? 1 : 0;
}

/**
 * 一手的估值损失。
 *
 * `moverAfter` 是**落子后轮到的对方**的视角，必须先翻回来才能和落子前相减：
 *   损失 = before - (1 - after) = before + after - 1
 * 直接相减会把「赢了」算成巨额损失——终局时 after = 0（对方已输），
 * before - 0 反而等于胜利方的全部优势。
 *
 * 负值只可能是估值噪声，截断为 0。
 */
export function lossOf(moverBefore: number | null, moverAfter: number | null): number | null {
  if (moverBefore === null || moverAfter === null) return null;
  return Math.max(0, moverBefore + moverAfter - 1);
}

/**
 * 「正确着法」预览盘面：把落错的那一手收回，再落到搜索给的最佳点。
 *
 * 只用于渲染，不改 controller 里的盘面与历史；`from` 与 `to` 必须不同，
 * 调用方先在 `ReviewedMove` 上挡掉「这手本来就是最佳」的情况。
 */
export function correctedBoard(
  board: BoardState,
  from: number,
  to: number,
  player: Player,
): BoardState {
  const next = new Uint8Array(board);
  next[from] = EMPTY;
  next[to] = player;
  return next;
}

/**
 * 评级。`bestMove` 来自同一局的深评，因此「最佳」是相对搜索结论，不是绝对正确。
 *
 * 标签优先级高于估值：漏成五 / 漏挡五必须至少是败着，漏活三至少是不精确以上。
 * 已经是「最佳」的不降级——规则与搜索冲突时，把最佳着标成失误只会让人不再信任评级。
 */
export function gradeOf(
  move: number,
  bestMove: number | null,
  loss: number | null,
  tags: readonly CoachVerdict[],
): MoveGrade | null {
  if (tags.includes('missedWin') || tags.includes('missedBlockFive')) return 'blunder';

  let grade: MoveGrade;
  if (bestMove !== null && move === bestMove) {
    grade = 'best';
  } else if (loss === null) {
    return null;
  } else if (loss >= GRADE_LOSS.blunder) {
    grade = 'blunder';
  } else if (loss >= GRADE_LOSS.mistake) {
    grade = 'mistake';
  } else if (loss >= GRADE_LOSS.inaccuracy) {
    grade = 'inaccuracy';
  } else {
    grade = 'good';
  }

  if (tags.includes('missedBlockOpenThree') && (grade === 'good' || grade === 'inaccuracy')) {
    grade = 'mistake';
  }
  return grade;
}

/** 从着手历史建出「局面点」骨架；值全部为 null，由评估流程填。 */
export function buildReviewPoints(
  history: ReadonlyArray<{ player: Player; move: number }>,
): ReviewPoint[] {
  const first: Player = history[0]?.player ?? BLACK;
  const points: ReviewPoint[] = [
    {
      index: 0,
      player: first,
      moverValue: null,
      humanValue: null,
      bestMove: null,
      top: null,
      quality: 'fast',
    },
  ];
  for (let i = 0; i < history.length; i++) {
    points.push({
      index: i + 1,
      player: other(history[i].player),
      moverValue: null,
      humanValue: null,
      bestMove: null,
      top: null,
      quality: 'fast',
    });
  }
  return points;
}

/** 写一个点的值，同时刷新人类视角。 */
export function setPointValue(
  point: ReviewPoint,
  moverValue: number,
  humanColor: Player,
  quality: ReviewQuality,
): void {
  point.moverValue = moverValue;
  point.humanValue = humanValueOf(moverValue, point.player, humanColor);
  point.quality = quality;
}

/**
 * 由局面点派生每一手的评级。
 *
 * 只有两端都是深评的手才评级：一端是快速值时，相减等于拿两种估计器作差，
 * 结果不可解释。`boardsBefore[i]` 是第 i 手落子前的盘面，标签由它算。
 *
 * 开局段（`ply <= OPENING_PLIES`）整体跳过评级与标签，并把 `bestMove/top` 清空：
 * 只把 `grade` 设成 null 不够——`gradeOf` 在 bestMove 为 null 时会退回按损失评级，
 * `judgeMove` 也会在空盘上给出没有意义的标签。
 */
export function buildReviewedMoves(
  points: readonly ReviewPoint[],
  history: ReadonlyArray<{ player: Player; move: number }>,
  humanColor: Player,
  boardsBefore: ReadonlyArray<BoardState>,
  fastValues: ReadonlyArray<number | null> = [],
): ReviewedMove[] {
  const moves: ReviewedMove[] = [];
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    const before = points[i];
    const after = points[i + 1];
    if (!before || !after) break;

    const ply = i + 1;
    const opening = ply <= OPENING_PLIES;
    const deep = before.quality === 'deep' && after.quality === 'deep';
    const graded = deep && !opening;
    const verdict = graded ? judgeMove(boardsBefore[i], item.player, item.move) : null;
    const tags = verdict ? [verdict] : [];
    const loss = lossOf(before.moverValue, after.moverValue);

    moves.push({
      ply,
      player: item.player,
      move: item.move,
      human: item.player === humanColor,
      moverBefore: before.moverValue,
      moverAfter: after.moverValue,
      humanBefore: before.humanValue,
      humanAfter: after.humanValue,
      loss,
      grade: graded ? gradeOf(item.move, before.bestMove, loss, tags) : null,
      tags,
      bestMove: opening ? null : before.bestMove,
      top: opening ? null : before.top,
      opening,
      fastValue: fastValues[i] ?? null,
      status:
        before.quality === 'deep' && after.quality === 'deep'
          ? 'done'
          : before.quality === 'deep'
            ? 'deep'
            : before.moverValue !== null
              ? 'fast'
              : 'pending',
    });
  }
  return moves;
}

export interface ReviewSummary {
  /** 参与统计的手数（不含开局）。 */
  moves: number;
  /** 开局段手数：只算估值，不评级。 */
  opening: number;
  /** 已评级的着手数；平均损失只在这批上算。 */
  graded: number;
  best: number;
  good: number;
  inaccuracy: number;
  mistake: number;
  blunder: number;
  meanLoss: number | null;
  tags: Record<CoachVerdict, number>;
}

/** 按「你 / 对手」分组统计。`human` 传 true 表示统计人类那一侧。 */
export function summarizeReview(
  moves: readonly ReviewedMove[],
  human: boolean,
): ReviewSummary {
  const summary: ReviewSummary = {
    moves: 0,
    opening: 0,
    graded: 0,
    best: 0,
    good: 0,
    inaccuracy: 0,
    mistake: 0,
    blunder: 0,
    meanLoss: null,
    tags: {
      missedWin: 0,
      missedBlockFive: 0,
      missedBlockOpenThree: 0,
      goodBlock: 0,
      goodOpenFour: 0,
    },
  };

  let lossSum = 0;
  for (const move of moves) {
    if (move.human !== human) continue;
    if (move.opening) {
      summary.opening += 1;
      continue;
    }
    summary.moves += 1;
    for (const verdict of move.tags) summary.tags[verdict] += 1;
    if (!move.grade) continue;
    summary.graded += 1;
    summary[move.grade] += 1;
    if (move.loss !== null) lossSum += move.loss;
  }

  if (summary.graded > 0) summary.meanLoss = lossSum / summary.graded;
  return summary;
}

/** 参考分：只用来横向比较两局，不是等级分，也不是校准过的准确率。 */
export function scoreOf(summary: ReviewSummary): number | null {
  if (summary.meanLoss === null) return null;
  return Math.round(100 * (1 - summary.meanLoss));
}

/** 记录用的结果串：B+ / W+ / Draw。 */
export function resultOf(winner: Player | null): string {
  if (winner === null) return 'Draw';
  return winner === BLACK ? 'B+' : 'W+';
}
