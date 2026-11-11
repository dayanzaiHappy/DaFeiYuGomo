import { legalMoves, checkWin, isBoardFull, colOf, rowOf } from './board';
import {
  C_FPU,
  LEAF_RADIUS,
  PRIOR_BIAS_STRENGTH,
  ROOT_PRIOR_FLOOR,
  ROOT_RADIUS,
} from './ai-config';
import {
  PRIOR_BIAS_TAU,
  TIER_WIN,
  forcedMoves,
  hasOpenFourThreat,
  immediateWins,
  resolveForced,
  threatScore,
  vcf,
} from './tactics';
import {
  BLACK,
  N_CELLS,
  type BoardState,
  type EvalResult,
  type Evaluator,
  type Player,
  type RootNoise,
  type SearchOptions,
  type SearchResult,
  type SearchTop,
} from './types';

const DRAW = 3;

/** 有活四威胁一方的叶子估值。不是必胜（对方可能还有 VCF），只是把两类局面分开。 */
const THREAT_WIN_VALUE = 0.85;

class Node {
  readonly grid: BoardState;
  readonly player: Player;
  readonly move: number;
  readonly parent: number;
  prior: number;
  readonly children: number[] = [];
  visits = 0;
  score = 0;
  winner = 0;
  expanded = false;
  /** 强制解析是否已算过；算过就不再重复算，它没有子节点，会被反复选中。 */
  forcedChecked = false;
  /** 强制解析结果（轮到此节点的胜率），-1 表示未解析。 */
  forcedWin = -1;

  constructor(
    grid: BoardState,
    player: Player,
    move: number,
    parent: number,
    prior: number,
  ) {
    this.grid = grid;
    this.player = player;
    this.move = move;
    this.parent = parent;
    this.prior = prior;
  }
}

/** uctValue 只看这三个字段，抽出来便于单测时直接构造。 */
export interface UctNode {
  readonly visits: number;
  readonly score: number;
}

export interface UctChild extends UctNode {
  readonly prior: number;
}

/**
 * 选择公式：标准 PUCT。
 *
 * 未访问节点的 Q 取父节点自身的价值 Q0，而不是乐观常数 0.5。
 * 1.2.0 的 `0.5 + cPuct·P·√(N+1)` 恒大于已访问节点的 Q（Q ∈ [0,1]），
 * 搜索因此被迫横向铺开，179 次模拟分摊到 149 个候选上。
 *
 * cFpu = 0 时与纯 PUCT 逐位等价（q0 - 0·√x === q0），本版取 0。
 * 保留 √(N+1) 而不是 √N：N=0 时用 √N 会让所有子节点并列 0，永远只选第一个。
 */
export function uctValue(
  child: UctChild,
  parent: UctNode,
  cPuct: number,
  cFpu: number,
  seenPrior: number,
): number {
  // node.score 以父节点视角累计，所以父节点自己的价值要翻回来
  const q0 = parent.visits > 0 ? 1 - parent.score / parent.visits : 0.5;
  const unvisited = cFpu > 0 ? q0 - cFpu * Math.sqrt(seenPrior) : q0;
  const q = child.visits > 0 ? child.score / child.visits : unvisited;
  const explore = (cPuct * child.prior * Math.sqrt(parent.visits + 1)) / (1 + child.visits);
  return q + explore;
}

/**
 * 根节点先验修正：在候选池上做 softmax(log p + b)。
 *
 * b = (λ/W)·[档位分 + τ·1{档位分 ≥ τ}]，档位由 tactics.threatScore 给出（攻防同表）。
 * 动机很简单：网络在稀疏局面会给「该堵的活三」很低的先验，而先验决定谁上场、
 * 也决定 PUCT 的探索权重；给它一个与招式价值成比例的对数偏置，比在候选表上另加规则更平滑。
 *
 * 只在根节点做：叶子层每层都加等于把偏置乘以深度。λ = 0 时原样返回。
 */
export function applyPriorBias(
  policy: ArrayLike<number>,
  board: BoardState,
  player: Player,
  pool: readonly number[],
  lambda: number,
): Float32Array {
  const out = new Float32Array(N_CELLS);
  if (!(lambda > 0) || pool.length === 0) {
    for (const move of pool) out[move] = policy[move];
    return out;
  }

  let maxLogit = -Infinity;
  const logits = new Map<number, number>();
  for (const move of pool) {
    const raw = policy[move];
    const base = Math.log(raw > 1e-9 ? raw : 1e-9);
    const score = threatScore(board, move, player);
    const bonus = score >= PRIOR_BIAS_TAU ? PRIOR_BIAS_TAU : 0;
    const logit = base + (lambda / TIER_WIN) * (score + bonus);
    logits.set(move, logit);
    if (logit > maxLogit) maxLogit = logit;
  }

  let sum = 0;
  for (const [move, logit] of logits) {
    const value = Math.exp(logit - maxLogit);
    out[move] = value;
    sum += value;
  }
  if (sum > 0) {
    for (const move of logits.keys()) out[move] /= sum;
  }
  return out;
}

/**
 * 根节点候选：归一化先验的相对阈值 ∩ 名次上限，再并上战术必选点，最后按 move 升序。
 *
 * 只用名次，policy 平坦时会把噪声点全收进来；只用阈值，policy 尖锐时可能只剩一两个点。
 * 两道取交集，宽度与质量各有一道保障。必选点是安全网：先验不回答「哪必胜」，
 * 只按先验截断会裁掉唯一能赢、必须挡的点。
 */
export function shortlist(
  pool: readonly number[],
  policy: ArrayLike<number>,
  limit: number,
  forced: readonly number[] = [],
): number[] {
  if (pool.length === 0) return [];
  if (limit <= 0) return [...pool];

  let sum = 0;
  for (const move of pool) {
    const value = policy[move];
    if (Number.isFinite(value) && value > 0) sum += value;
  }
  // 模型输出可能是 logits，负值和全零都会让阈值失去意义；这两种情况退回均匀先验
  const uniform = !(sum > 1e-8);
  const priorOf = (move: number): number => {
    if (uniform) return 1 / pool.length;
    const value = policy[move];
    return Number.isFinite(value) && value > 0 ? value / sum : 0;
  };

  let maxPrior = 0;
  for (const move of pool) {
    const value = priorOf(move);
    if (value > maxPrior) maxPrior = value;
  }
  const floor = ROOT_PRIOR_FLOOR * maxPrior;

  const ranked = pool.filter((move) => priorOf(move) >= floor);
  ranked.sort((a, b) => priorOf(b) - priorOf(a) || a - b);

  const picked = new Set<number>(forced);
  for (const move of ranked.slice(0, limit)) picked.add(move);
  return [...picked].sort((a, b) => a - b);
}

/**
 * winner 永远是「刚落子的一方」，而 leafPlayer 是「该走的一方」，
 * 两者恒不相等，所以这里的分支只可能是 1（不是 0）。保留判断是为了让语义完整，
 * 不要按字面理解改成别的口径。
 */
function terminalResult(winner: number, leafPlayer: Player): number {
  if (winner === DRAW) return 0.5;
  return winner === leafPlayer ? 0 : 1;
}

function childValue(node: Node): number {
  return node.visits > 0 ? node.score / node.visits : -1;
}

function buildTop(root: Node, nodes: Node[], topk: number): SearchTop[] {
  const top: SearchTop[] = [];
  for (const childIndex of root.children) {
    const child = nodes[childIndex];
    if (child.visits <= 0) continue;
    top.push({
      move: child.move,
      visits: child.visits,
      value: childValue(child),
    });
  }
  top.sort((a, b) => {
    if (a.visits !== b.visits) return b.visits - a.visits;
    if (a.value !== b.value) return b.value - a.value;
    return a.move - b.move;
  });
  return topk > 0 ? top.slice(0, topk) : top;
}

function bestChild(root: Node, nodes: Node[]): Node | null {
  if (root.children.length === 0) return null;
  let best = nodes[root.children[0]];
  for (let i = 1; i < root.children.length; i++) {
    const candidate = nodes[root.children[i]];
    if (candidate.visits !== best.visits) {
      if (candidate.visits > best.visits) best = candidate;
      continue;
    }
    const cv = childValue(candidate);
    const bv = childValue(best);
    if (cv !== bv) {
      if (cv > bv) best = candidate;
      continue;
    }
    if (candidate.move < best.move) best = candidate;
  }
  return best;
}

/** Marsaglia-Tsang 采样 Gamma(alpha, 1)；alpha < 1 时用提升公式。 */
function sampleGamma(alpha: number, random: () => number): number {
  if (alpha < 1) {
    const u = Math.max(1 - random(), Number.EPSILON);
    return sampleGamma(alpha + 1, random) * Math.pow(u, 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    const x =
      Math.sqrt(-2 * Math.log(Math.max(1 - random(), Number.EPSILON))) *
      Math.cos(2 * Math.PI * random());
    const v = 1 + c * x;
    if (v <= 0) continue;
    const v3 = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v3;
    if (Math.log(Math.max(u, Number.EPSILON)) < 0.5 * x * x + d * (1 - v3 + Math.log(v3))) {
      return d * v3;
    }
  }
}

/** 对称 Dirichlet 采样，返回和为 1 的权重。 */
function sampleDirichlet(size: number, alpha: number, random: () => number): number[] {
  const values = new Array<number>(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const value = sampleGamma(alpha, random);
    values[i] = value;
    sum += value;
  }
  if (!(sum > 0) || !Number.isFinite(sum)) {
    return new Array<number>(size).fill(1 / size);
  }
  for (let i = 0; i < size; i++) values[i] /= sum;
  return values;
}

/** 两个棋盘点之间的切比雪夫距离。 */
function chebyshev(a: number, b: number): number {
  return Math.max(Math.abs(rowOf(a) - rowOf(b)), Math.abs(colOf(a) - colOf(b)));
}

/**
 * 对根节点先验加 Dirichlet 噪声（纯函数，便于单测）。
 *
 * 支持集 S 由三道过滤取交集得到：
 *   1. 质量护栏：prior ≥ minRatio × max(prior)
 *   2. 位置护栏：chebyshev(move, lastMove) ≤ radius（lastMove < 0 时跳过）
 *   3. 数量上限：按 (prior 降序, move 升序) 取前 topM 名
 *
 * 混合：
 *   p'_i = (1-ε)·p_i + ε·η_i   i ∈ S
 *   p'_i = (1-ε)·p_i           i ∉ S
 *
 * 总和恒为 1；ε=1 时支持集外先验精确清零。
 * |S| ≤ 1 时直接返回：单点 Dirichlet 恒为 1，只会把该点抬高，等于强化自信而非随机化。
 */
export function mixRootNoise(
  entries: ReadonlyArray<{ prior: number; move: number }>,
  noise: RootNoise,
  random: () => number = Math.random,
  lastMove = -1,
): number[] {
  const count = entries.length;
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = entries[i].prior;
  if (count <= 1) return out;

  const epsilon = Number.isFinite(noise.epsilon) ? Math.min(1, Math.max(0, noise.epsilon)) : 0;
  if (!(epsilon > 0) || !(noise.alpha > 0) || !Number.isFinite(noise.alpha)) return out;

  // 清洗并归一化先验，避免 NaN / 负值污染 Dirichlet。
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const value = out[i];
    const safe = Number.isFinite(value) && value > 0 ? value : 0;
    out[i] = safe;
    sum += safe;
  }
  if (!(sum > 0)) return new Array<number>(count).fill(1 / count);
  if (Math.abs(sum - 1) > 1e-9) {
    for (let i = 0; i < count; i++) out[i] /= sum;
  }

  // 质量护栏
  let maxPrior = 0;
  for (let i = 0; i < count; i++) if (out[i] > maxPrior) maxPrior = out[i];
  const ratioRaw = noise.minRatio;
  const ratio =
    typeof ratioRaw === 'number' && Number.isFinite(ratioRaw) && ratioRaw > 0
      ? Math.min(1, ratioRaw)
      : 0;
  const floor = ratio * maxPrior;

  // 位置护栏
  const radiusRaw = noise.radius;
  const radius =
    typeof radiusRaw === 'number' && Number.isFinite(radiusRaw) && radiusRaw >= 0
      ? radiusRaw
      : -1;
  const hasRadius = radius >= 0 && lastMove >= 0;

  // 数量上限
  const rawLimit = noise.topM;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(count, Math.max(1, Math.floor(rawLimit)))
      : count;

  const support: number[] = [];
  for (let i = 0; i < count; i++) {
    if (out[i] < floor) continue;
    if (hasRadius && chebyshev(entries[i].move, lastMove) > radius) continue;
    support.push(i);
  }
  support.sort((a, b) => {
    if (out[a] !== out[b]) return out[b] - out[a];
    return entries[a].move - entries[b].move;
  });

  const size = Math.min(limit, support.length);
  if (size <= 1) return out;

  const eta = sampleDirichlet(size, noise.alpha, random);
  const keep = 1 - epsilon;
  for (let i = 0; i < count; i++) out[i] *= keep;
  for (let k = 0; k < size; k++) out[support[k]] += epsilon * eta[k];

  let total = 0;
  for (let i = 0; i < count; i++) total += out[i];
  if (!(total > 0) || !Number.isFinite(total)) {
    return new Array<number>(count).fill(1 / count);
  }
  if (Math.abs(total - 1) > 1e-9) {
    for (let i = 0; i < count; i++) out[i] /= total;
  }
  return out;
}

/** 把 mixRootNoise 的结果写回根节点的子节点先验。 */
function applyRootNoise(
  root: Node,
  nodes: Node[],
  noise: RootNoise,
  random: () => number,
  lastMove: number,
): void {
  const count = root.children.length;
  if (count <= 1) return;

  const entries: Array<{ prior: number; move: number }> = new Array(count);
  for (let i = 0; i < count; i++) {
    const child = nodes[root.children[i]];
    entries[i] = { prior: child.prior, move: child.move };
  }

  const mixed = mixRootNoise(entries, noise, random, lastMove);
  for (let i = 0; i < count; i++) nodes[root.children[i]].prior = mixed[i];
}

/**
 * 在根节点 visits 前 sampleTopK 名里按 visits^(1/temperature) 加权随机。
 * 无已访问子节点时返回 null，由调用方退回 bestChild。
 */
function sampleByVisits(
  root: Node,
  nodes: Node[],
  sampleTopK: number,
  temperature: number,
  random: () => number,
): Node | null {
  const candidates: Node[] = [];
  for (const childIndex of root.children) {
    const child = nodes[childIndex];
    if (child.visits > 0) candidates.push(child);
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.visits !== b.visits) return b.visits - a.visits;
    const av = childValue(a);
    const bv = childValue(b);
    if (av !== bv) return bv - av;
    return a.move - b.move;
  });

  const pool = candidates.slice(0, Math.max(1, Math.min(64, Math.floor(sampleTopK))));
  if (pool.length === 1) return pool[0];

  const exponent = 1 / temperature;
  let total = 0;
  const weights = pool.map((node) => {
    const weight = Math.pow(node.visits, exponent);
    total += weight;
    return weight;
  });
  if (!(total > 0) || !Number.isFinite(total)) return pool[0];

  let threshold = random() * total;
  for (let i = 0; i < pool.length; i++) {
    threshold -= weights[i];
    if (threshold < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * 顺序 MCTS，语义与桌面版 src/v2/solver.cpp 对齐：
 * - 节点 score 以父节点视角累计；
 * - 叶价值回传时逐层 1 - result；
 * - 根节点 value 翻转到根走子方视角；
 * - 不做树复用；根节点噪声与温度采样默认关闭，由调用方按需开启。
 */
export async function runSearch(
  board: BoardState,
  player: Player,
  evaluator: Evaluator,
  options: SearchOptions,
): Promise<SearchResult> {
  const sims = Math.max(0, Math.floor(options.sims));
  const topk = Math.max(0, Math.min(64, Math.floor(options.topk ?? 0)));
  const cPuct = options.cPuct ?? 1.5;
  const cFpu = C_FPU;
  const rootLimit = Math.max(0, Math.floor(options.rootLimit ?? 0));
  const forcedPlies = Math.max(0, Math.floor(options.forcedPlies ?? 0));
  const vcfDepth = Math.max(0, Math.floor(options.vcfDepth ?? 0));
  const progressEvery = Math.max(1, options.progressEvery ?? 32);
  const random = options.random ?? Math.random;
  const temperature = Math.max(0, options.temperature ?? 0);
  const sampleTopK = Math.max(1, Math.min(64, Math.floor(options.sampleTopK ?? 3)));

  const nodes: Node[] = [];
  const rootLegal = legalMoves(board, ROOT_RADIUS);
  if (rootLegal.length === 0) {
    return { move: -1, value: -1, legal: 0, sims: 0, top: [] };
  }

  // 最便宜的搜索解决最确定的问题：能靠连续冲四赢的局，不必跑模拟
  if (vcfDepth > 0) {
    const found = vcf(board, player, vcfDepth);
    if (found.move >= 0) {
      return {
        move: found.move,
        value: 1,
        legal: rootLegal.length,
        sims: 0,
        top: [{ move: found.move, visits: 0, value: 1 }],
        depth: 0,
      };
    }
  }

  const root = new Node(new Uint8Array(board), player, -1, -1, 0);
  nodes.push(root);

  const expand = (nodeIndex: number, ev: EvalResult, legal: number[]) => {
    const node = nodes[nodeIndex];
    // 与 shortlist 同一口径：只统计正的有限值，全零退回均匀。
    // 模型输出 logits 时负值会让先验变成负数，explore 项跟着变负，那个点就再也选不到。
    let sum = 0;
    for (const move of legal) {
      const value = ev.policy[move];
      if (Number.isFinite(value) && value > 0) sum += value;
    }
    const uniform = !(sum > 1e-8);

    for (const move of legal) {
      const childGrid = new Uint8Array(node.grid);
      childGrid[move] = node.player;
      const raw = ev.policy[move];
      const prior = uniform
        ? 1 / legal.length
        : Math.max(0, Number.isFinite(raw) ? raw : 0) / sum;
      const child = new Node(
        childGrid,
        node.player === BLACK ? 2 : 1,
        move,
        nodeIndex,
        prior,
      );
      child.winner = checkWin(childGrid, move) ?? 0;
      if (child.winner === 0 && isBoardFull(childGrid)) child.winner = DRAW;
      const childIndex = nodes.length;
      nodes.push(child);
      node.children.push(childIndex);
    }
    node.expanded = true;
  };

  // 先评估、再截断：候选表由先验决定，而先验要跑一次前向才拿得到
  const rootEval = await evaluator.evaluate(root.grid, root.player);
  // 战术偏置只作用于根节点先验，且只在开了战术层的档位生效
  const rootPolicy = applyPriorBias(
    rootEval.policy,
    root.grid,
    root.player,
    rootLegal,
    forcedPlies > 0 ? PRIOR_BIAS_STRENGTH : 0,
  );
  const forced = rootLimit > 0 ? forcedMoves(root.grid, root.player) : [];
  const rootMoves =
    rootLimit > 0 ? shortlist(rootLegal, rootPolicy, rootLimit, forced) : rootLegal;
  expand(0, { policy: rootPolicy, value: rootEval.value }, rootMoves);

  // 并集只保证必选点「上场」，先验仍是模型给的。先验为 0 的点 explore 项恒为 0，
  // 会被其他候选压住、一次也选不到——那样安全网就等于没有，所以给它一个平均先验。
  if (forced.length > 0) {
    const floorPrior = 1 / Math.max(1, rootMoves.length);
    const forcedSet = new Set(forced);
    for (const childIndex of root.children) {
      const child = nodes[childIndex];
      if (forcedSet.has(child.move) && child.prior < floorPrior) child.prior = floorPrior;
    }
  }

  if (options.rootNoise) {
    applyRootNoise(root, nodes, options.rootNoise, random, options.lastMove ?? -1);
  }

  const select = (): { leaf: number; path: number[] } => {
    const path: number[] = [0];
    let current = 0;
    while (true) {
      const node = nodes[current];
      if (!node.expanded || node.children.length === 0 || node.winner !== 0) break;

      // cFpu = 0 时这段完全不跑：179 次模拟 × 每层几十个子节点，白花的循环不算小
      let seenPrior = 0;
      if (cFpu > 0) {
        for (const childIndex of node.children) {
          const child = nodes[childIndex];
          if (child.visits > 0) seenPrior += child.prior;
        }
      }

      let best = node.children[0];
      let bestVal = uctValue(nodes[best], node, cPuct, cFpu, seenPrior);
      for (let i = 1; i < node.children.length; i++) {
        const candidate = node.children[i];
        const value = uctValue(nodes[candidate], node, cPuct, cFpu, seenPrior);
        if (value > bestVal) {
          bestVal = value;
          best = candidate;
        }
      }
      current = best;
      path.push(current);
      if (path.length > 512) break;
    }
    return { leaf: current, path };
  };

  const backprop = (path: number[], result: number) => {
    let value = result;
    for (let i = path.length - 1; i >= 0; i--) {
      const node = nodes[path[i]];
      node.visits++;
      node.score += value;
      value = 1 - value;
    }
  };

  let maxDepth = 0;
  /** 强制解析只在第一次调用时算，命中后写在节点上；它没有子节点，会被反复选中。 */
  const resolveLeaf = (node: Node): number | null => {
    if (!node.forcedChecked) {
      node.forcedChecked = true;
      const outcome = resolveForced(node.grid, node.player, forcedPlies);
      node.forcedWin = outcome ? outcome.win : -1;
    }
    return node.forcedWin >= 0 ? node.forcedWin : null;
  };

  /**
   * 叶子估值修正：轮到走的这方如果有活三（下一手能造活四），而对方既不能成五、
   * 也没有活四威胁，那这基本是胜势——活四两端都能成五，挡不住。
   *
   * 为什么需要它：NN 只按当前盘面估胜率，稀疏局面下经常给不出这个信号，
   * 于是搜索会把「放对手做活四」和「堵住活三」估成一样好，然后按先验挑一个。
   * 这里是估值而不是判定：0.85 不是必胜，只是把「有活四」和「没活四」分开。
   * 只在开了战术层的档位生效，简单档不受影响。
   */
  const withThreatValue = (node: Node, value: number): number => {
    if (forcedPlies <= 0) return value;
    // 先问最可能为假的这一条：多数叶子自己并没有活三，一次扫描就能收工
    if (!hasOpenFourThreat(node.grid, node.player)) return value;
    const rival = node.player === BLACK ? 2 : 1;
    if (immediateWins(node.grid, rival).length > 0) return value;
    if (hasOpenFourThreat(node.grid, rival)) return value;
    return Math.max(value, THREAT_WIN_VALUE);
  };

  const makeResult = (done: number, cancelled: boolean): SearchResult => {
    const sampled =
      temperature > 0.05
        ? sampleByVisits(root, nodes, sampleTopK, temperature, random)
        : null;
    const best = sampled ?? bestChild(root, nodes);
    const rootValue = root.visits > 0 ? 1 - root.score / root.visits : 0.5;
    return {
      move: best ? best.move : -1,
      value: rootValue,
      legal: rootLegal.length,
      sims: done,
      top: buildTop(root, nodes, topk),
      cancelled,
      depth: maxDepth,
    };
  };

  let done = 0;
  for (let iter = 0; iter < sims; iter++) {
    if (options.shouldCancel?.()) {
      return makeResult(done, true);
    }

    const { leaf, path } = select();
    if (path.length - 1 > maxDepth) maxDepth = path.length - 1;
    const leafNode = nodes[leaf];
    let result: number;

    if (leafNode.winner !== 0) {
      result = terminalResult(leafNode.winner, leafNode.player);
    } else {
      const forcedWin =
        forcedPlies > 0 ? resolveLeaf(leafNode) : null;
      if (forcedWin !== null) {
        leafNode.expanded = true;
        // 与 result = 1 - ev.value 同一视角
        result = 1 - forcedWin;
      } else {
        const ev = await evaluator.evaluate(leafNode.grid, leafNode.player);
        if (options.shouldCancel?.()) {
          return makeResult(done, true);
        }
        const legal = legalMoves(leafNode.grid, LEAF_RADIUS);
        if (legal.length === 0) {
          leafNode.winner = DRAW;
          leafNode.expanded = true;
          result = 0.5;
        } else {
          expand(leaf, ev, legal);
          result = 1 - withThreatValue(leafNode, ev.value);
        }
      }
    }

    backprop(path, result);
    done = iter + 1;

    if (options.onProgress && (done % progressEvery === 0 || done === sims)) {
      const top = buildTop(root, nodes, Math.max(topk, 3));
      options.onProgress({
        simsDone: done,
        simsTotal: sims,
        best: top[0] ?? null,
        top,
        value: root.visits > 0 ? 1 - root.score / root.visits : 0.5,
        depth: maxDepth,
      });
    }
  }

  return makeResult(done, false);
}
