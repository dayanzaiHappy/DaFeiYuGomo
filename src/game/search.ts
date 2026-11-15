import type { AbProfile } from './ai-config';
import { candidateCells, makeMove, unmakeMove } from './board';
import { SCORE_WIN, toWinRate } from './eval';
import { EvalCache } from './eval-cache';
import { TIER_FOUR, TIER_WIN, vcf } from './tactics';
import { ThreatCache } from './threat-cache';
import { N_CELLS, other, type BoardState, type Player } from './types';

/**
 * negamax + alpha-beta 搜索，本项目唯一的引擎。
 *
 * 分工：`threat-cache` 回答「这一手造了什么」，`eval` 回答「这个局面谁好」，
 * 这里只负责把它们组织成一次搜索。
 *
 * 已有：迭代加深、置换表、PVS、根节点 VCF 快检、根节点 multiPV 与采样。
 * 还没有：真正的 LMR——内部宽度之外只是降 2 层，不是按序数递减。
 */

/** 递归硬顶，参数写错时不至于爆栈。 */
const MAX_PLY = 48;

/** 内部无穷，必须大于任何将杀分。 */
const INF = 1_000_000;

/** 采样门控：分差超过一个冲四就不进池子。 */
const MOVE_MARGIN = 1200;

/** 候选半径。成五 / 挡五 / 造四的点都紧贴已有棋子，2 格足够。 */
const CANDIDATE_RADIUS = 2;

/** 内部软门控：全深度着法之外再多看这么多，超出部分降 2 层试探。 */
const LMR_EXTRA = 4;

/** 分值超过这个量级就是将杀分，进出置换表要按层换算。 */
const MATE_BOUND = SCORE_WIN - 512;

// ---------------------------------------------------------------------------
// 置换表
//
// 键是两个 32 位 Zobrist 哈希（A 做下标、B 做校验），单个 32 位在几十万节点的
// 规模下撞车概率已经不能忽略。伪随机用固定种子，保证每次启动同一张表，可复现。
// 有效性用代号标记，省掉每次搜索整表清零。
// ---------------------------------------------------------------------------

const TT_BITS = 17;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;

const TT_KEY_A = new Int32Array(TT_SIZE);
const TT_KEY_B = new Int32Array(TT_SIZE);
const TT_MOVE = new Int16Array(TT_SIZE);
const TT_SCORE = new Int32Array(TT_SIZE);
const TT_DEPTH = new Uint8Array(TT_SIZE);
const TT_FLAG = new Uint8Array(TT_SIZE);
const TT_GEN = new Uint8Array(TT_SIZE);
let ttGeneration = 0;

const FLAG_EXACT = 0;
const FLAG_LOWER = 1;
const FLAG_UPPER = 2;

function buildZobrist(): { a: Int32Array; b: Int32Array } {
  // xorshift32
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state | 0;
  };
  const a = new Int32Array(N_CELLS * 2);
  const b = new Int32Array(N_CELLS * 2);
  for (let i = 0; i < N_CELLS * 2; i += 1) {
    a[i] = next();
    b[i] = next();
  }
  return { a, b };
}

const ZOB = buildZobrist();

export interface RootMove {
  move: number;
  /** 根节点上的分值，`multiPV > 1` 时是确切分，否则只有第一名确切。 */
  score: number;
}

export interface AbSearchOptions extends AbProfile {
  /** 随机源，默认 Math.random；测试注入固定序列。 */
  random?: () => number;
  /**
   * 根节点排序用的模型 policy（225 维，越大越优先）。
   *
   * 只在同一威胁档内起作用：强制点该进候选还是得进。缺省（测试、无模型）时
   * 退回按格号排序，与旧行为一致。
   */
  rootPrior?: ArrayLike<number> | null;
}

export interface AbResult {
  move: number;
  /** 根节点分值，行棋方视角。 */
  score: number;
  /** 对外胜率 0~1。 */
  value: number;
  /** 完成的最后一个迭代深度；0 表示一层都没跑完。 */
  depth: number;
  nodes: number;
  /** 根节点候选，按分值降序。 */
  top: RootMove[];
  /** 节点预算耗尽，提前中止；`top` 来自上一层完整迭代，仍然可用。 */
  aborted: boolean;
}

interface SearchState {
  board: BoardState;
  cache: ThreatCache;
  evalCache: EvalCache;
  nodes: number;
  limit: number;
  aborted: boolean;
  qDepth: number;
  widthInner: number;
  /** Zobrist 哈希，与盘面、两个缓存同步维护。 */
  hashA: number;
  hashB: number;
  /** 候选缓冲。生成完立刻编码成键，所以一份够用。 */
  generateBuffer: number[];
  /** 静态战术搜索的候选缓冲按层各一份——外层还在遍历时内层就会用到。 */
  qBuffers: number[][];
}

/**
 * 计一次节点并检查预算。
 *
 * 中止用标志位而不是异常：异常会穿透 alpha-beta 的循环，把半截结果当成完整结果返回，
 * 而且 catch 之后盘面未必已经撤回。
 */
function tick(state: SearchState): boolean {
  state.nodes += 1;
  if (state.nodes >= state.limit) state.aborted = true;
  return state.aborted;
}

/**
 * 落子 / 提子必须成对调用：哈希与两个缓存都要跟着盘面走，漏一次后面全是脏数据。
 * 缓存走 push / pop 而不是「再算一遍」——撤回后的盘面与落子前逐格相同，旧值直接写回即可。
 */
function place(state: SearchState, move: number, side: Player): void {
  makeMove(state.board, move, side);
  const key = (move << 1) | (side - 1);
  state.hashA = (state.hashA ^ ZOB.a[key]) | 0;
  state.hashB = (state.hashB ^ ZOB.b[key]) | 0;
  state.cache.push(state.board, move);
  state.evalCache.push(state.board, move, side);
}

function lift(state: SearchState, move: number, side: Player): void {
  unmakeMove(state.board, move);
  const key = (move << 1) | (side - 1);
  state.hashA = (state.hashA ^ ZOB.a[key]) | 0;
  state.hashB = (state.hashB ^ ZOB.b[key]) | 0;
  state.cache.pop(move);
  state.evalCache.pop(move);
}

/** 将杀分与置换表之间的换算：表里存「距该节点还有几步」，取出来再按层加回去。 */
function toTable(score: number, ply: number): number {
  if (score > MATE_BOUND) return score + ply;
  if (score < -MATE_BOUND) return score - ply;
  return score;
}

function fromTable(score: number, ply: number): number {
  if (score > MATE_BOUND) return score - ply;
  if (score < -MATE_BOUND) return score + ply;
  return score;
}

/**
 * 查置换表。
 *
 * `usable` 表示这一条可以直接当返回值用（深度够且窗口类型匹配）；
 * 不成立但键对得上时，仍然把着法带回来给排序用。
 */
function probe(
  state: SearchState,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
): { usable: boolean; score: number; move: number } | null {
  const index = (state.hashA >>> 0) & TT_MASK;
  if (TT_GEN[index] !== ttGeneration) return null;
  if (TT_KEY_A[index] !== state.hashA || TT_KEY_B[index] !== state.hashB) return null;

  const move = TT_MOVE[index];
  if (TT_DEPTH[index] < depth) return { usable: false, score: 0, move };

  const score = fromTable(TT_SCORE[index], ply);
  const flag = TT_FLAG[index];
  if (flag === FLAG_EXACT) return { usable: true, score, move };
  if (flag === FLAG_LOWER && score >= beta) return { usable: true, score, move };
  if (flag === FLAG_UPPER && score <= alpha) return { usable: true, score, move };
  return { usable: false, score: 0, move };
}

function store(
  state: SearchState,
  depth: number,
  score: number,
  flag: number,
  move: number,
  ply: number,
): void {
  if (state.aborted || ply >= MAX_PLY) return;
  const index = (state.hashA >>> 0) & TT_MASK;
  TT_GEN[index] = ttGeneration;
  TT_KEY_A[index] = state.hashA;
  TT_KEY_B[index] = state.hashB;
  TT_MOVE[index] = move;
  TT_SCORE[index] = toTable(score, ply);
  TT_DEPTH[index] = depth;
  TT_FLAG[index] = flag;
}

/**
 * 生成内部节点的候选，按威胁档降序，截断到 width。
 *
 * 键的编码：`(rank * 2 + 是否成五) << 8 | 落点`。排序用整数比较，一次排序即可，
 * 不额外分配对象。落点 < 256，低 8 位放得下。
 * 档位读缓存而不是现算。
 */
function generate(state: SearchState, side: Player, width: number): number[] {
  const cells = state.generateBuffer;
  candidateCells(state.board, CANDIDATE_RADIUS, cells);

  const rival = other(side);
  const keys: number[] = new Array(cells.length);

  for (let i = 0; i < cells.length; i += 1) {
    const move = cells[i];
    const attack = state.cache.attack(move, side);
    const defend = state.cache.attack(move, rival);
    const rank = attack > defend ? attack : defend;
    const win = attack >= TIER_WIN ? 1 : 0;
    keys[i] = ((rank * 2 + win) << 8) | move;
  }

  keys.sort((a, b) => b - a);
  if (keys.length > width) keys.length = width;
  return keys;
}

interface RootRank {
  move: number;
  rank: number;
  win: number;
  /* 模型给出的先验概率，只在同一威胁档内比较 */
  prior: number;
}

const rootRanks: RootRank[] = [];
const rootScratch: number[] = [];

/**
 * 根节点候选排序：威胁档在前，同档内用模型 policy 排。
 *
 * 为什么是两层而不是直接把 policy 当主序：成五 / 挡五 / 造四这些点必须进候选，
 * 模型对它们的判断不一定可靠，而漏掉唯一挡点的代价是一手输。反过来，安静局面里
 * 所有候选都是 0 档，这时 policy 就是唯一的排序依据——原来同档按格子号排，
 * 等于随机，这正是根节点排序最差的一段。
 *
 * 键的编码沿用 `(rank * 2 + 是否成五) << 8 | 落点`，供搜索识别「这一手直接成五」。
 */
export function rankRootMoves(
  cache: ThreatCache,
  board: BoardState,
  side: Player,
  width: number,
  prior?: ArrayLike<number> | null,
): number[] {
  candidateCells(board, CANDIDATE_RADIUS, rootScratch);
  const rival = other(side);
  rootRanks.length = 0;

  for (let i = 0; i < rootScratch.length; i += 1) {
    const move = rootScratch[i];
    const attack = cache.attack(move, side);
    const defend = cache.attack(move, rival);
    rootRanks.push({
      move,
      rank: attack > defend ? attack : defend,
      win: attack >= TIER_WIN ? 1 : 0,
      prior: prior ? (prior[move] ?? 0) : 0,
    });
  }

  rootRanks.sort(
    (a, b) => b.rank - a.rank || b.win - a.win || b.prior - a.prior || b.move - a.move,
  );

  const count = Math.min(rootRanks.length, width);
  const keys: number[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const entry = rootRanks[i];
    keys[i] = ((entry.rank * 2 + entry.win) << 8) | entry.move;
  }
  return keys;
}

/** 把置换表里的着法提到最前面：它大概率就是这层要走的。 */
function promote(keys: number[], move: number): void {
  for (let i = 1; i < keys.length; i += 1) {
    if ((keys[i] & 255) === move) {
      const head = keys[0];
      keys[0] = keys[i];
      keys[i] = head;
      return;
    }
  }
}

/**
 * 静态战术搜索：只走成五、挡五、造四。
 *
 * 它的作用是把「地平线上还没走完的强制线」读完，不是多搜两层普通着法——
 * 安静局面在这里立刻返回静态分，成本接近 0。
 * 不走置换表：层浅、节点多，填表反而把主搜索的条目挤掉。
 */
function quiescence(
  state: SearchState,
  side: Player,
  alpha: number,
  beta: number,
  ply: number,
  left: number,
): number {
  if (tick(state)) return 0;
  if (ply >= MAX_PLY) return state.evalCache.score(side);

  const board = state.board;
  const rival = other(side);
  const points = state.qBuffers[ply];
  candidateCells(board, 1, points);

  // 能一手成五就直接赢，不必再看别的
  for (let i = 0; i < points.length; i += 1) {
    if (state.cache.attack(points[i], side) >= TIER_WIN) return SCORE_WIN - ply;
  }

  // 对方的成五点：两个以上挡不住，恰好一个只能挡
  let block = -1;
  for (let i = 0; i < points.length; i += 1) {
    const move = points[i];
    if (state.cache.attack(move, rival) < TIER_WIN) continue;
    if (block >= 0) return -(SCORE_WIN - (ply + 1));
    block = move;
  }

  if (block >= 0) {
    place(state, block, side);
    const score =
      left <= 0
        ? -state.evalCache.score(rival)
        : -quiescence(state, rival, -beta, -alpha, ply + 1, left - 1);
    lift(state, block, side);
    return score;
  }

  const stand = state.evalCache.score(side);
  if (left <= 0) return stand;
  if (stand >= beta) return stand;
  if (stand > alpha) alpha = stand;

  let best = stand;
  for (let i = 0; i < points.length; i += 1) {
    const move = points[i];
    if (state.cache.attack(move, side) < TIER_FOUR) continue;

    place(state, move, side);
    const score = -quiescence(state, rival, -beta, -alpha, ply + 1, left - 1);
    lift(state, move, side);

    if (state.aborted) return 0;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function negamax(
  state: SearchState,
  side: Player,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
): number {
  if (tick(state)) return 0;
  if (ply >= MAX_PLY) return state.evalCache.score(side);
  if (depth <= 0) return quiescence(state, side, alpha, beta, ply, state.qDepth);

  const hit = probe(state, depth, alpha, beta, ply);
  if (hit?.usable) return hit.score;

  const keys = generate(state, side, state.widthInner + LMR_EXTRA);
  if (keys.length === 0) return 0;
  if (hit && hit.move >= 0) promote(keys, hit.move);

  const rival = other(side);
  const alpha0 = alpha;
  let best = -INF;
  let bestMove = -1;

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const move = key & 255;

    // 能一手成五就不必再往下搜，这已经是这一层的最高分
    if (((key >> 8) & 1) === 1) {
      store(state, depth, SCORE_WIN - ply, FLAG_EXACT, move, ply);
      return SCORE_WIN - ply;
    }

    place(state, move, side);
    let score: number;
    if (i === 0) {
      score = -negamax(state, rival, depth - 1, -beta, -alpha, ply + 1);
    } else {
      // 软门控：排在后面的着法先降 2 层零窗口试探，有希望再补全深。
      // 排序错了的代价是多花节点，不是错过最佳——这正是与根节点硬截断的本质区别。
      const probeDepth = i >= state.widthInner && depth >= 4 ? depth - 2 : depth - 1;
      score = -negamax(state, rival, probeDepth, -alpha - 1, -alpha, ply + 1);
      if (!state.aborted && score > alpha && score < beta) {
        score = -negamax(state, rival, depth - 1, -beta, -alpha, ply + 1);
      }
    }
    lift(state, move, side);

    if (state.aborted) return 0;
    if (score > best) {
      best = score;
      bestMove = move;
    }
    if (best > alpha) alpha = best;
    if (alpha >= beta) {
      store(state, depth, best, FLAG_LOWER, bestMove, ply);
      return best;
    }
  }

  store(state, depth, best, best > alpha0 ? FLAG_EXACT : FLAG_UPPER, bestMove, ply);
  return best;
}

/**
 * 根节点取子。
 *
 * 先按分差门控，再在池内做扰动后取最大：
 * `s' = s + bias·(s* − s)·u + v·noise`。
 * `noise` 是独立抖动，让分差小于它的两手互换；`bias` 会让差棋被抬过最优，
 * 只有 `bias·u > 1` 时才发生，所以是「故意」而不是「看不清」。
 */
function pickMove(top: readonly RootMove[], options: AbSearchOptions, random: () => number): number {
  if (top.length <= 1) return top[0].move;

  const bestScore = top[0].score;
  const mateFloor = SCORE_WIN - MAX_PLY;
  const pool = top.filter(
    (item) =>
      item.score >= bestScore - MOVE_MARGIN &&
      (bestScore < mateFloor || item.score >= mateFloor),
  );
  if (pool.length <= 1) return pool[0].move;
  if (options.noise === 0 && options.bias === 0) return pool[0].move;

  let bestValue = -INF;
  let chosen = pool[0].move;
  for (const item of pool) {
    const value =
      item.score +
      options.bias * (bestScore - item.score) * random() +
      random() * options.noise;
    if (value > bestValue) {
      bestValue = value;
      chosen = item.move;
    }
  }
  return chosen;
}

export function searchAb(board: BoardState, side: Player, options: AbSearchOptions): AbResult {
  const random = options.random ?? Math.random;
  const state: SearchState = {
    board: new Uint8Array(board),
    cache: new ThreatCache(),
    evalCache: new EvalCache(),
    nodes: 0,
    limit: Math.max(1, Math.floor(options.nodes)),
    aborted: false,
    qDepth: Math.max(0, Math.floor(options.qDepth)),
    widthInner: Math.max(1, Math.floor(options.widthInner)),
    hashA: 0,
    hashB: 0,
    generateBuffer: [],
    qBuffers: Array.from({ length: MAX_PLY }, () => []),
  };
  state.cache.reset(state.board);
  state.evalCache.reset(state.board);

  // 最便宜的搜索解决最确定的问题：能靠连续冲四赢，不必进主搜索
  const vcfDepth = Math.max(0, Math.floor(options.vcfDepth));
  if (vcfDepth > 0) {
    const found = vcf(state.board, side, vcfDepth);
    if (found.move >= 0) {
      return {
        move: found.move,
        score: SCORE_WIN - 1,
        value: toWinRate(SCORE_WIN - 1),
        depth: 0,
        nodes: state.nodes,
        top: [{ move: found.move, score: SCORE_WIN - 1 }],
        aborted: false,
      };
    }
  }

  ttGeneration = (ttGeneration + 1) & 0xff;
  if (ttGeneration === 0) {
    TT_GEN.fill(0);
    ttGeneration = 1;
  }

  const rootKeys = rankRootMoves(
    state.cache,
    state.board,
    side,
    Math.max(1, Math.floor(options.widthRoot)),
    options.rootPrior,
  );
  if (rootKeys.length === 0) {
    return { move: -1, score: 0, value: 0.5, depth: 0, nodes: 0, top: [], aborted: false };
  }

  const exactAll = options.multiPV > 1;
  const rival = other(side);
  const maxDepth = Math.min(Math.max(2, options.depth & ~1), MAX_PLY - 2);

  let top: RootMove[] = [{ move: rootKeys[0] & 255, score: 0 }];
  let completed = 0;

  for (let depth = 2; depth <= maxDepth; depth += 2) {
    const iter: RootMove[] = [];
    let alpha = -INF;
    let cut = false;

    for (let i = 0; i < rootKeys.length; i += 1) {
      const key = rootKeys[i];
      const move = key & 255;
      let score: number;

      if (((key >> 8) & 1) === 1) {
        score = SCORE_WIN - 1;
      } else {
        place(state, move, side);
        if (exactAll || i === 0) {
          score = -negamax(state, rival, depth - 1, -INF, exactAll ? INF : -alpha, 1);
        } else {
          score = -negamax(state, rival, depth - 1, -alpha - 1, -alpha, 1);
          if (!state.aborted && score > alpha) {
            score = -negamax(state, rival, depth - 1, -INF, -alpha, 1);
          }
        }
        lift(state, move, side);
      }

      if (state.aborted) {
        cut = true;
        break;
      }
      iter.push({ move, score });
      if (score > alpha) alpha = score;
    }

    if (cut) break;

    iter.sort((a, b) => b.score - a.score);
    top = iter;
    completed = depth;

    // 下一轮先搜这一轮得分的，根节点只有十几个候选，线性查找足够
    const previous = new Map(iter.map((item) => [item.move, item.score]));
    rootKeys.sort((a, b) => (previous.get(b & 255) ?? -INF) - (previous.get(a & 255) ?? -INF));

    if (top[0].score >= SCORE_WIN - MAX_PLY) break;
  }

  return {
    // 采样池只取前 multiPV 个：multiPV = 1 时池里只有一人，noise 与 bias 都不生效
    move: pickMove(top.slice(0, Math.max(1, options.multiPV)), options, random),
    score: top[0].score,
    value: toWinRate(top[0].score),
    depth: completed,
    nodes: state.nodes,
    top,
    aborted: state.aborted,
  };
}
