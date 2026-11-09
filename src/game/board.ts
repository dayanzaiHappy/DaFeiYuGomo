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

const NEIGHBORS_CACHE = new Map<number, Array<[number, number]>>();

function neighbors(radius: number): Array<[number, number]> {
  const cached = NEIGHBORS_CACHE.get(radius);
  if (cached) return cached;
  const out: Array<[number, number]> = [];
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (dr === 0 && dc === 0) continue;
      out.push([dr, dc]);
    }
  }
  NEIGHBORS_CACHE.set(radius, out);
  return out;
}

export function legalMoves(board: BoardState, radius = 4): number[] {
  let empty = true;
  for (let i = 0; i < N_CELLS; i++) {
    if (board[i] !== EMPTY) {
      empty = false;
      break;
    }
  }
  if (empty) return [idx(7, 7)];

  const out: number[] = [];
  const offsets = neighbors(radius);
  for (let move = 0; move < N_CELLS; move++) {
    if (board[move] !== EMPTY) continue;
    const row = rowOf(move);
    const col = colOf(move);
    for (const [dr, dc] of offsets) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      if (board[idx(r, c)] !== EMPTY) {
        out.push(move);
        break;
      }
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
