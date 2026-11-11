import {
  BLACK,
  type BoardState,
  type Player,
  DIRECTIONS,
  EMPTY,
  N_CELLS,
  SIZE,
} from './types';

export function createBoard(): BoardState {
  return new Uint8Array(N_CELLS);
}

export function cloneBoard(board: BoardState): BoardState {
  return new Uint8Array(board);
}

export function idx(row: number, col: number): number {
  return row * SIZE + col;
}

export function rowOf(move: number): number {
  return Math.floor(move / SIZE);
}

export function colOf(move: number): number {
  return move % SIZE;
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < SIZE && col >= 0 && col < SIZE;
}

export function isValidMove(board: BoardState, move: number): boolean {
  return move >= 0 && move < N_CELLS && board[move] === EMPTY;
}

export function placeStone(board: BoardState, move: number, player: Player): BoardState {
  const next = new Uint8Array(board);
  next[move] = player;
  return next;
}

export function checkWin(board: BoardState, move: number): Player | null {
  const player = board[move];
  if (player === EMPTY) return null;
  const row = rowOf(move);
  const col = colOf(move);

  for (const [dr, dc] of DIRECTIONS) {
    let count = 1;
    for (let step = 1; step < 5; step++) {
      const r = row + dr * step;
      const c = col + dc * step;
      if (!inBounds(r, c) || board[idx(r, c)] !== player) break;
      count++;
    }
    for (let step = 1; step < 5; step++) {
      const r = row - dr * step;
      const c = col - dc * step;
      if (!inBounds(r, c) || board[idx(r, c)] !== player) break;
      count++;
    }
    if (count >= 5) return player as Player;
  }
  return null;
}

export function getWinLine(board: BoardState, move: number): number[] {
  const player = board[move];
  if (player === EMPTY) return [];
  const row = rowOf(move);
  const col = colOf(move);

  for (const [dr, dc] of DIRECTIONS) {
    const line: number[] = [move];
    for (let step = 1; step < 5; step++) {
      const r = row + dr * step;
      const c = col + dc * step;
      if (!inBounds(r, c) || board[idx(r, c)] !== player) break;
      line.push(idx(r, c));
    }
    for (let step = 1; step < 5; step++) {
      const r = row - dr * step;
      const c = col - dc * step;
      if (!inBounds(r, c) || board[idx(r, c)] !== player) break;
      line.unshift(idx(r, c));
    }
    if (line.length >= 5) return line;
  }
  return [];
}

export function isBoardFull(board: BoardState): boolean {
  for (let i = 0; i < N_CELLS; i++) {
    if (board[i] === EMPTY) return false;
  }
  return true;
}

interface NeighborTable {
  /** 长度 N_CELLS × stride，越界存 -1。 */
  table: Int16Array;
  stride: number;
}

const NEIGHBOR_TABLES = new Map<number, NeighborTable>();

/**
 * 每个格子 × 每个偏移 → 邻居索引。
 * 预计算换掉内层的 inBounds + rowOf + colOf，是候选生成提速的主要来源。
 */
function neighborTable(radius: number): NeighborTable {
  const cached = NEIGHBOR_TABLES.get(radius);
  if (cached) return cached;

  const offsets: Array<[number, number]> = [];
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (dr !== 0 || dc !== 0) offsets.push([dr, dc]);
    }
  }

  const stride = offsets.length;
  const table = new Int16Array(N_CELLS * stride);
  for (let move = 0; move < N_CELLS; move++) {
    const row = rowOf(move);
    const col = colOf(move);
    const base = move * stride;
    for (let i = 0; i < stride; i++) {
      const r = row + offsets[i][0];
      const c = col + offsets[i][1];
      table[base + i] = inBounds(r, c) ? idx(r, c) : -1;
    }
  }

  const built: NeighborTable = { table, stride };
  NEIGHBOR_TABLES.set(radius, built);
  return built;
}

const LEGAL_WORDS = Math.ceil(N_CELLS / 32);
/** 按位去重用的临时位图；legalMoves 是同步且不重入的，复用一份即可。 */
const legalBits = new Uint32Array(LEGAL_WORDS);

/**
 * 半径内的空点候选，按索引升序。
 *
 * 只遍历落子点、把它们的邻居标进位图，再按位图升序还原——
 * 结果与「遍历全部空点、逐个检查 80 个偏移」逐点一致，但工作量从 225×80 降到 15×80。
 */
export function legalMoves(board: BoardState, radius = 4): number[] {
  const { table, stride } = neighborTable(Math.max(0, Math.floor(radius)));

  legalBits.fill(0);
  let placed = false;
  for (let move = 0; move < N_CELLS; move++) {
    if (board[move] === EMPTY) continue;
    placed = true;
    const base = move * stride;
    for (let i = 0; i < stride; i++) {
      const neighbor = table[base + i];
      if (neighbor >= 0) legalBits[neighbor >>> 5] |= 1 << (neighbor & 31);
    }
  }

  // 空盘没有可依托的棋子，直接给天元
  if (!placed) return [idx(7, 7)];

  const out: number[] = [];
  for (let word = 0; word < LEGAL_WORDS; word++) {
    const bits = legalBits[word];
    if (bits === 0) continue;
    const base = word << 5;
    for (let bit = 0; bit < 32; bit++) {
      if ((bits & (1 << bit)) === 0) continue;
      const move = base + bit;
      if (move < N_CELLS && board[move] === EMPTY) out.push(move);
    }
  }
  return out;
}

export function boardKey(board: BoardState, player: Player): string {
  let s = player === BLACK ? '1' : '2';
  for (let i = 0; i < N_CELLS; i++) {
    s += board[i];
  }
  return s;
}

export const COLUMN_LETTERS = 'ABCDEFGHIJKLMNO';

export function formatCoord(move: number): string {
  const row = rowOf(move) + 1;
  const col = COLUMN_LETTERS[colOf(move)];
  return `第${row}行第${colOf(move) + 1}列（${col}${row}）`;
}

export function shortCoord(move: number): string {
  return `${COLUMN_LETTERS[colOf(move)]}${rowOf(move) + 1}`;
}
