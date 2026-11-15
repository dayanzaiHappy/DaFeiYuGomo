import { legalMoves } from './board';
import { WINDOWS } from './lines';
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

/**
 * 每个格子、每个方向的 8 个邻居下标：前 4 个正向、后 4 个反向，越界为 -1。
 *
 * 形状检测在一次搜索里要被调用几十万次。原来每次都要算行列、判边界，除法和取模
 * 占掉大半时间；展开成表之后只剩数组读，也不再分配临时对象。
 */
const STEPS = buildSteps();

function buildSteps(): Int16Array {
  const table = new Int16Array(N_CELLS * 4 * 8);
  for (let move = 0; move < N_CELLS; move += 1) {
    const row = Math.floor(move / SIZE);
    const col = move % SIZE;
    for (let dir = 0; dir < 4; dir += 1) {
      const [dr, dc] = DIRECTIONS[dir];
      const base = ((move << 2) | dir) << 3;
      for (let step = 1; step <= 4; step += 1) {
        const fr = row + dr * step;
        const fc = col + dc * step;
        table[base + step - 1] =
          fr >= 0 && fr < SIZE && fc >= 0 && fc < SIZE ? fr * SIZE + fc : -1;
        const br = row - dr * step;
        const bc = col - dc * step;
        table[base + 3 + step] =
          br >= 0 && br < SIZE && bc >= 0 && bc < SIZE ? br * SIZE + bc : -1;
      }
    }
  }
  return table;
}

/**
 * 以 move 为中心、沿 dir 的连子形状，打包成 `连子长度 * 4 + 开放端数`。
 *
 * 长度在 ≥ 5 时饱和成 5：调用方只关心「够不够五」。
 * 打包而不是返回对象——这个函数每节点调用几百次，对象分配会直接把 GC 压满。
 * board[move] 必须是空点，按 player 已落子计算，这里只看邻居、不改盘面。
 */
function lineRun(board: BoardState, move: number, player: Player, dir: number): number {
  const base = ((move << 2) | dir) << 3;

  let forward = 0;
  while (forward < 4) {
    const cell = STEPS[base + forward];
    if (cell < 0 || board[cell] !== player) break;
    forward += 1;
  }

  let backward = 0;
  while (backward < 4) {
    const cell = STEPS[base + 4 + backward];
    if (cell < 0 || board[cell] !== player) break;
    backward += 1;
  }

  const total = forward + backward + 1;
  if (total >= 5) return 5 << 2;

  let openEnds = 0;
  const head = STEPS[base + forward];
  if (head >= 0 && board[head] === EMPTY) openEnds += 1;
  const tail = STEPS[base + 4 + backward];
  if (tail >= 0 && board[tail] === EMPTY) openEnds += 1;
  return (total << 2) | openEnds;
}

function winsAt(board: BoardState, move: number, player: Player): boolean {
  for (let dir = 0; dir < 4; dir += 1) {
    if (lineRun(board, move, player, dir) >> 2 >= 5) return true;
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
  const candidates = legalMoves(board, 1);
  for (let i = 0; i < candidates.length; i += 1) {
    const move = candidates[i];
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
 * 练习时用来判断「这手是不是漏了活三」，搜索里不单独处理。
 */
export function openFourPoints(board: BoardState, player: Player): number[] {
  const out: number[] = [];
  for (const move of legalMoves(board, 2)) {
    if (board[move] !== EMPTY) continue;
    for (let dir = 0; dir < 4; dir += 1) {
      const packed = lineRun(board, move, player, dir);
      if (packed >> 2 === 4 && (packed & 3) === 2) {
        out.push(move);
        break;
      }
    }
  }
  return out;
}

/**
 * 某一方落子后这一方向的档位分。
 * 只看「这手造出了什么」：五连 / 活四 / 冲四 / 活三，其余为 0。
 */
export function directionTier(board: BoardState, move: number, player: Player, dir: number): number {
  const packed = lineRun(board, move, player, dir);
  const total = packed >> 2;
  if (total >= 5) return TIER_WIN;
  const openEnds = packed & 3;
  if (total === 4) {
    if (openEnds === 2) return TIER_OPEN_FOUR;
    if (openEnds === 1) return TIER_FOUR;
    return 0;
  }
  if (total === 3 && openEnds === 2) return TIER_OPEN_THREE;
  return 0;
}

/**
 * 这一手能为 player 造出的最高档位（只看进攻，不看防守）。
 *
 * 静态战术搜索只关心「这手能不能造四」；排序要的是「攻防取大」，
 * 由 `generate` 把两个方向的档位各取一次再取大，不在这里合并。
 */
export function attackTier(board: BoardState, move: number, player: Player): number {
  let best = 0;
  for (let dir = 0; dir < 4; dir += 1) {
    const tier = directionTier(board, move, player, dir);
    if (tier > best) best = tier;
  }
  return best;
}

/**
 * 造四的候选点：存在一个窗口「三枚己方 + 两格空」，落在这两格之一就变成四。
 *
 * 用窗口枚举而不是「试落每一手再看有没有成五点」：窗口总数固定 572 个，
 * 与局面无关；后者要为每个空点跑一次成五点检测，在 VCF 里是立方级的浪费。
 * 窗口表在 lines.ts 里构建，与评估共用同一份，避免两处对「五格」有不同理解。
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
