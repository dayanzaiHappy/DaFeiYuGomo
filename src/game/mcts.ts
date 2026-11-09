import { legalMoves, checkWin, isBoardFull } from './board';
import {
  BLACK,
  type BoardState,
  type EvalResult,
  type Evaluator,
  type Player,
  type RootNoise,
  type SearchProgress,
  type SearchResult,
  type SearchTop,
} from './types';

const DRAW = 3;

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

export interface SearchOptions {
  sims: number;
  topk?: number;
  radius?: number;
  cPuct?: number;
  onProgress?: (progress: SearchProgress) => void;
  progressEvery?: number;
  shouldCancel?: () => boolean;
  /** 随机源，默认 Math.random；测试可注入固定序列。 */
  random?: () => number;
  /** 根节点 visits 温度，0 表示 argmax（旧行为）。 */
  temperature?: number;
  /** 温度采样时只在前 K 名里选，默认 3。 */
  sampleTopK?: number;
  /** 根节点 Dirichlet 噪声；null 表示不加。 */
  rootNoise?: RootNoise | null;
}

function uctValue(child: Node, parentVisits: number, cPuct: number): number {
  if (child.visits === 0) {
    return 0.5 + cPuct * child.prior * Math.sqrt(parentVisits + 1);
  }
  return (
    child.score / child.visits +
    (cPuct * child.prior * Math.sqrt(parentVisits)) / (1 + child.visits)
  );
}

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

/** 对根节点的子节点先验加 Dirichlet 噪声并重新归一化。 */
function applyRootNoise(
  root: Node,
  nodes: Node[],
  noise: RootNoise,
  random: () => number,
): void {
  const epsilon = Math.min(1, Math.max(0, noise.epsilon));
  if (epsilon <= 0 || !(noise.alpha > 0) || root.children.length <= 1) return;

  const eta = sampleDirichlet(root.children.length, noise.alpha, random);
  let sum = 0;
  for (let i = 0; i < root.children.length; i++) {
    const child = nodes[root.children[i]];
    child.prior = (1 - epsilon) * child.prior + epsilon * eta[i];
    sum += child.prior;
  }
  if (sum > 0 && Number.isFinite(sum)) {
    for (const childIndex of root.children) nodes[childIndex].prior /= sum;
  }
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
  const radius = options.radius ?? 4;
  const cPuct = options.cPuct ?? 2.0;
  const progressEvery = Math.max(1, options.progressEvery ?? 32);
  const random = options.random ?? Math.random;
  const temperature = Math.max(0, options.temperature ?? 0);
  const sampleTopK = Math.max(1, Math.min(64, Math.floor(options.sampleTopK ?? 3)));

  const nodes: Node[] = [];
  const rootLegal = legalMoves(board, radius);
  if (rootLegal.length === 0) {
    return { move: -1, value: -1, legal: 0, sims: 0, top: [] };
  }

  const root = new Node(new Uint8Array(board), player, -1, -1, 0);
  nodes.push(root);

  const expand = (nodeIndex: number, ev: EvalResult, legal: number[]) => {
    const node = nodes[nodeIndex];
    let sum = 0;
    for (const move of legal) sum += ev.policy[move];
    const uniform = sum <= 1e-8;

    for (const move of legal) {
      const childGrid = new Uint8Array(node.grid);
      childGrid[move] = node.player;
      const child = new Node(
        childGrid,
        node.player === BLACK ? 2 : 1,
        move,
        nodeIndex,
        uniform ? 1 / legal.length : ev.policy[move] / sum,
      );
      child.winner = checkWin(childGrid, move) ?? 0;
      if (child.winner === 0 && isBoardFull(childGrid)) child.winner = DRAW;
      const childIndex = nodes.length;
      nodes.push(child);
      node.children.push(childIndex);
    }
    node.expanded = true;
  };

  const rootEval = await evaluator.evaluate(root.grid, root.player);
  expand(0, rootEval, rootLegal);
  if (options.rootNoise) {
    applyRootNoise(root, nodes, options.rootNoise, random);
  }

  const select = (): { leaf: number; path: number[] } => {
    const path: number[] = [0];
    let current = 0;
    while (true) {
      const node = nodes[current];
      if (!node.expanded || node.children.length === 0 || node.winner !== 0) break;
      let best = node.children[0];
      let bestVal = uctValue(nodes[best], node.visits, cPuct);
      for (let i = 1; i < node.children.length; i++) {
        const candidate = node.children[i];
        const value = uctValue(nodes[candidate], node.visits, cPuct);
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
    };
  };

  let done = 0;
  for (let iter = 0; iter < sims; iter++) {
    if (options.shouldCancel?.()) {
      return makeResult(done, true);
    }

    const { leaf, path } = select();
    const leafNode = nodes[leaf];
    let result: number;

    if (leafNode.winner !== 0) {
      result = terminalResult(leafNode.winner, leafNode.player);
    } else {
      const ev = await evaluator.evaluate(leafNode.grid, leafNode.player);
      if (options.shouldCancel?.()) {
        return makeResult(done, true);
      }
      const legal = legalMoves(leafNode.grid, radius);
      if (legal.length === 0) {
        leafNode.winner = DRAW;
        leafNode.expanded = true;
        result = 0.5;
      } else {
        expand(leaf, ev, legal);
        result = 1 - ev.value;
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
      });
    }
  }

  return makeResult(done, false);
}
