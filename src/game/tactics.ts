import { colOf, legalMoves, rowOf } from './board';
import {
  DIRECTIONS,
  EMPTY,
  N_CELLS,
  SIZE,
  other,
  type BoardState,
  type Player,
} from './types';

/** VCF 默认节点上限：超限即放弃，不拖慢正常搜索。 */
export const VCF_NODE_LIMIT = 20000;

/**
 * 招式分档分值。攻防读同一张表：「挡住对方的活三」按被挡威胁的分值计。
 * 数值取自公开的五子棋战术先验分档（成五 / 活四 / 冲四 / 活三 = 1000 / 200 / 80 / 40）。
 */
export const TIER_WIN = 1000;
export const TIER_OPEN_FOUR = 200;
export const TIER_FOUR = 80;
export const TIER_OPEN_THREE = 40;

/** 强制集门槛：达到活四及以上的招式另加一份分值，让「必须应」的着法排到前面。 */
export const PRIOR_BIAS_TAU = TIER_OPEN_FOUR;

interface LineShape {
  /** 落子后这一方向的连子长度。 */
  total: number;
  /** 连子两端的空位数，0~2。 */
  openEnds: number;
}

/**
 * 以 move 为中心、沿 (dr, dc) 的形状。
 * board[move] 必须是空点，按 player 已落子计算——这里只看邻居，不改盘面。
 */
function lineShape(
  board: BoardState,
  move: number,
  player: Player,
  dr: number,
  dc: number,
): LineShape {
  const row = rowOf(move);
  const col = colOf(move);

  let forward = 0;
  while (forward < 4) {
    const r = row + dr * (forward + 1);
    const c = col + dc * (forward + 1);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) break;
    if (board[r * SIZE + c] !== player) break;
    forward++;
  }

  let backward = 0;
  while (backward < 4) {
    const r = row - dr * (backward + 1);
    const c = col - dc * (backward + 1);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) break;
    if (board[r * SIZE + c] !== player) break;
    backward++;
  }

  let openEnds = 0;
  const forwardRow = row + dr * (forward + 1);
  const forwardCol = col + dc * (forward + 1);
  if (
    forwardRow >= 0 &&
    forwardRow < SIZE &&
    forwardCol >= 0 &&
    forwardCol < SIZE &&
    board[forwardRow * SIZE + forwardCol] === EMPTY
  ) {
    openEnds++;
  }
  const backwardRow = row - dr * (backward + 1);
  const backwardCol = col - dc * (backward + 1);
  if (
    backwardRow >= 0 &&
    backwardRow < SIZE &&
    backwardCol >= 0 &&
    backwardCol < SIZE &&
    board[backwardRow * SIZE + backwardCol] === EMPTY
  ) {
    openEnds++;
  }

  return { total: forward + backward + 1, openEnds };
}

function winsAt(board: BoardState, move: number, player: Player): boolean {
  for (const [dr, dc] of DIRECTIONS) {
    if (lineShape(board, move, player, dr, dc).total >= 5) return true;
  }
  return false;
}

/**
 * 立刻能连成五的点。
 *
 * 只扫半径 1 的空点：任何一个成五点都至少与四枚己方子之一相邻
 * （五连的最后一块必然贴着前面四块），所以不会漏。
 */
export function immediateWins(board: BoardState, player: Player): number[] {
  const out: number[] = [];
  for (const move of legalMoves(board, 1)) {
    if (board[move] !== EMPTY) continue;
    if (winsAt(board, move, player)) out.push(move);
  }
  return out;
}

/**
 * 「下一手能造活四」的点，也就是活三的两个延伸点。
 *
 * 活四两端都能成五，挡不住，所以这类点是必须考虑防守的。
 * 它和成五点不同：这里只是「对方有这个威胁」，不是「对方已经能成五」，
 * 所以不进 resolveForced 的胜负判定，只用来保证候选里有它。
 */
export function openFourPoints(board: BoardState, player: Player): number[] {
  const out: number[] = [];
  for (const move of legalMoves(board, 2)) {
    if (board[move] !== EMPTY) continue;
    for (const [dr, dc] of DIRECTIONS) {
      const shape = lineShape(board, move, player, dr, dc);
      if (shape.total === 4 && shape.openEnds === 2) {
        out.push(move);
        break;
      }
    }
  }
  return out;
}

/**
 * 是否存在活四威胁。与 openFourPoints 同义，但找到第一个就返回。
 * 叶节点每次模拟都要问两次，走这条短路版本。
 */
export function hasOpenFourThreat(board: BoardState, player: Player): boolean {
  for (const move of legalMoves(board, 2)) {
    if (board[move] !== EMPTY) continue;
    for (const [dr, dc] of DIRECTIONS) {
      const shape = lineShape(board, move, player, dr, dc);
      if (shape.total === 4 && shape.openEnds === 2) return true;
    }
  }
  return false;
}

/**
 * 某一方落子后这一方向的档位分。
 * 只看「这手造出了什么」：五连 / 活四 / 冲四 / 活三，其余为 0。
 */
function shapeTier(
  board: BoardState,
  move: number,
  player: Player,
  dr: number,
  dc: number,
): number {
  const shape = lineShape(board, move, player, dr, dc);
  if (shape.total >= 5) return TIER_WIN;
  if (shape.total === 4 && shape.openEnds === 2) return TIER_OPEN_FOUR;
  if (shape.total === 4 && shape.openEnds === 1) return TIER_FOUR;
  if (shape.total === 3 && shape.openEnds === 2) return TIER_OPEN_THREE;
  return 0;
}

/**
 * 招式分档分：攻（我这手造什么）与防（我这手堵掉对方什么）读同一张表，取较大者。
 *
 * 防守不需要单独发明权重——「堵掉对方的活三」和「自己造活三」一样值 40，
 * 因为两者都改变同一个威胁。
 */
export function threatScore(board: BoardState, move: number, player: Player): number {
  let best = 0;
  for (const [dr, dc] of DIRECTIONS) {
    const attack = shapeTier(board, move, player, dr, dc);
    if (attack > best) best = attack;
    const defend = shapeTier(board, move, other(player), dr, dc);
    if (defend > best) best = defend;
  }
  return best;
}

/**
 * 必须进候选的点：我能成五的点 + 对方能成五、我必须挡的点 + 对方活三的延伸点。
 *
 * 先验只回答「像人一样哪儿好」，不回答「哪儿必胜/必败」。
 * 候选截断如果不并上这组点，会裁掉唯一能赢或唯一能挡的着法，而且极难复现。
 *
 * 活三那组只保证「上场」：堵哪一头、要不要先走自己的进攻，都交给搜索判断。
 * 一旦像成五点那样强制，就会出现「自己有四可以赢，却被逼着去堵活三」。
 *
 * VCF 首着不在这里：根节点会先用 vcf() 做一次快检，命中就直接返回胜手，
 * 未命中说明不存在这样的首着，再并进来只是重复搜索。
 */
export function forcedMoves(board: BoardState, player: Player): number[] {
  const picked = new Set<number>();
  for (const move of immediateWins(board, player)) picked.add(move);
  for (const move of immediateWins(board, other(player))) picked.add(move);
  for (const move of openFourPoints(board, other(player))) picked.add(move);
  return [...picked].sort((a, b) => a - b);
}

export interface ForcedOutcome {
  /** 轮到我（传入的 player）时的胜率：1 我胜，0 我负。 */
  win: number;
}

/**
 * 强制线路解析（MCTS-Solver 的最小版本）。
 *
 * 只沿「唯一应手」走，因此每一步都是确定的：
 *   1. 我能成五            → 我胜
 *   2. 对方有 ≥2 个成五点  → 挡不住，我负
 *   3. 对方恰好 1 个成五点 → 只能挡，挡完交换视角继续
 *   4. 其他                → 未解析，交回神经网络估值
 *
 * 不做全宽搜索，所以不会误判；代价是只能证明强制线，判不出来就返回 null。
 * 返回「轮到我的胜率」而不是写 node.winner：winner 的语义是「盘面上已经有人连成五」，
 * 两者混用会让 select() 的终局判断变得含糊。
 */
export function resolveForced(
  board: BoardState,
  player: Player,
  maxPlies: number,
): ForcedOutcome | null {
  if (maxPlies <= 0) return null;
  const win = solveForced(board, player, maxPlies);
  return win === null ? null : { win };
}

function solveForced(board: BoardState, player: Player, plies: number): number | null {
  if (immediateWins(board, player).length > 0) return 1;

  const threats = immediateWins(board, other(player));
  if (threats.length >= 2) return 0;
  if (threats.length === 0) return null;
  if (plies <= 0) return null;

  const block = threats[0];
  board[block] = player;
  const next = solveForced(board, other(player), plies - 1);
  board[block] = EMPTY;

  if (next === null) return null;
  // next 是对手视角的胜率，翻回来才是我这一层的
  return 1 - next;
}

/** 所有五格窗口（4 个方向 × 全部起点），扁平存放，每 5 个一组。 */
const WINDOWS = buildWindows();

function buildWindows(): Int16Array {
  const cells: number[] = [];
  for (const [dr, dc] of DIRECTIONS) {
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        const endRow = row + dr * 4;
        const endCol = col + dc * 4;
        if (endRow < 0 || endRow >= SIZE || endCol < 0 || endCol >= SIZE) continue;
        for (let step = 0; step < 5; step++) {
          cells.push((row + dr * step) * SIZE + col + dc * step);
        }
      }
    }
  }
  return Int16Array.from(cells);
}

/**
 * 造四的候选点：存在一个窗口「三枚己方 + 两格空」，落在这两格之一就变成四。
 *
 * 用窗口枚举而不是「试落每一手再看有没有成五点」：窗口总数固定 572 个，
 * 与局面无关；后者要为每个空点跑一次成五点检测，在 VCF 里是立方级的浪费。
 */
function fourCandidates(board: BoardState, player: Player): number[] {
  const seen = new Uint8Array(N_CELLS);
  const out: number[] = [];

  for (let start = 0; start < WINDOWS.length; start += 5) {
    let mine = 0;
    let empties = 0;
    let firstEmpty = -1;
    let secondEmpty = -1;
    let blocked = false;

    for (let step = 0; step < 5; step++) {
      const cell = WINDOWS[start + step];
      const value = board[cell];
      if (value === player) {
        mine++;
      } else if (value === EMPTY) {
        empties++;
        if (firstEmpty < 0) firstEmpty = cell;
        else secondEmpty = cell;
      } else {
        blocked = true;
        break;
      }
    }

    if (blocked || mine !== 3 || empties !== 2) continue;
    if (seen[firstEmpty] === 0) {
      seen[firstEmpty] = 1;
      out.push(firstEmpty);
    }
    if (seen[secondEmpty] === 0) {
      seen[secondEmpty] = 1;
      out.push(secondEmpty);
    }
  }

  out.sort((a, b) => a - b);
  return out;
}

export interface VcfOutcome {
  /** 首着；-1 表示没找到。 */
  move: number;
  /** 实际展开的候选数，用于诊断与测试上限。 */
  nodes: number;
}

/**
 * 根节点 VCF 快检：只靠连续冲四取胜。
 *
 * 每条线路都要求对方的应对是唯一的：
 *   - 我落子后有两个成五点 → 对方挡不住，胜；
 *   - 只有一个成五点 → 对方只能挡，递归；
 *   - 对方自己能成五 → 这条线作废（他会先赢）。
 * 因为从不「猜」对方的应手，所以不会误判。
 */
export function vcf(
  board: BoardState,
  player: Player,
  depth: number,
  nodeLimit = VCF_NODE_LIMIT,
): VcfOutcome {
  if (depth <= 0) return { move: -1, nodes: 0 };
  const state = { nodes: 0, limit: Math.max(1, nodeLimit) };
  const move = vcfNode(board, player, depth, state);
  return { move, nodes: state.nodes };
}

function vcfNode(
  board: BoardState,
  me: Player,
  depth: number,
  state: { nodes: number; limit: number },
): number {
  // 能一手成五就不必再冲四
  const wins = immediateWins(board, me);
  if (wins.length > 0) return wins[0];

  const opponent = other(me);
  // 对方能成五而我没成五，这条线一定输，VCF 不管
  if (immediateWins(board, opponent).length > 0) return -1;
  if (depth <= 0) return -1;

  for (const move of fourCandidates(board, me)) {
    if (state.nodes >= state.limit) return -1;
    state.nodes++;

    board[move] = me;
    const myWins = immediateWins(board, me);
    if (myWins.length >= 2) {
      board[move] = EMPTY;
      return move;
    }

    if (myWins.length === 1) {
      // 对方此刻若能成五，他会直接赢，这个四挡不住
      if (immediateWins(board, opponent).length === 0) {
        const block = myWins[0];
        board[block] = opponent;
        const next = vcfNode(board, me, depth - 1, state);
        board[block] = EMPTY;
        board[move] = EMPTY;
        if (next >= 0) return move;
        continue;
      }
    }

    board[move] = EMPTY;
  }
  return -1;
}
