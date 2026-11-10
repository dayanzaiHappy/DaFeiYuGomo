import {
  colOf,
  formatCoord,
  inBounds,
  idx,
  rowOf,
  shortCoord,
} from './board';
import { fillLine, pickLine, WHALE_LINES } from '../content/whale-lines';
import {
  BLACK,
  DIRECTIONS,
  EMPTY,
  type BoardState,
  type Player,
  type SearchResult,
  type SearchTop,
} from './types';

interface LineInfo {
  total: number;
  openEnds: number;
}

function lineInfo(
  board: BoardState,
  player: Player,
  move: number,
  dr: number,
  dc: number,
): LineInfo {
  const row = rowOf(move);
  const col = colOf(move);
  let total = 1;
  let openEnds = 0;

  let r = row + dr;
  let c = col + dc;
  while (inBounds(r, c) && board[idx(r, c)] === player) {
    total++;
    r += dr;
    c += dc;
  }
  if (inBounds(r, c) && board[idx(r, c)] === EMPTY) openEnds++;

  r = row - dr;
  c = col - dc;
  while (inBounds(r, c) && board[idx(r, c)] === player) {
    total++;
    r -= dr;
    c -= dc;
  }
  if (inBounds(r, c) && board[idx(r, c)] === EMPTY) openEnds++;

  return { total, openEnds };
}

export interface MoveAnalysis {
  wouldWin: boolean;
  blocksWin: boolean;
  createsOpenFour: boolean;
  createsFour: boolean;
  createsOpenThree: boolean;
  blocksFour: boolean;
  blocksOpenThree: boolean;
  nearCenter: boolean;
}

export function analyzeMove(board: BoardState, player: Player, move: number): MoveAnalysis {
  const opponent: Player = player === BLACK ? 2 : 1;
  const result: MoveAnalysis = {
    wouldWin: false,
    blocksWin: false,
    createsOpenFour: false,
    createsFour: false,
    createsOpenThree: false,
    blocksFour: false,
    blocksOpenThree: false,
    nearCenter: false,
  };

  for (const [dr, dc] of DIRECTIONS) {
    const own = lineInfo(board, player, move, dr, dc);
    if (own.total >= 5) result.wouldWin = true;
    if (own.total === 4 && own.openEnds >= 1) result.createsFour = true;
    if (own.total === 4 && own.openEnds === 2) result.createsOpenFour = true;
    if (own.total === 3 && own.openEnds === 2) result.createsOpenThree = true;

    const enemy = lineInfo(board, opponent, move, dr, dc);
    if (enemy.total >= 5) result.blocksWin = true;
    if (enemy.total === 4) result.blocksFour = true;
    if (enemy.total === 3 && enemy.openEnds === 2) result.blocksOpenThree = true;
  }

  const row = rowOf(move);
  const col = colOf(move);
  result.nearCenter = Math.abs(row - 7) <= 3 && Math.abs(col - 7) <= 3;
  return result;
}

function reasonFor(analysis: MoveAnalysis): readonly string[] {
  if (analysis.wouldWin) return WHALE_LINES.reasons.win;
  if (analysis.blocksWin) return WHALE_LINES.reasons.blockWin;
  if (analysis.createsOpenFour) return WHALE_LINES.reasons.openFour;
  if (analysis.createsFour) return WHALE_LINES.reasons.four;
  if (analysis.createsOpenThree) return WHALE_LINES.reasons.openThree;
  if (analysis.blocksFour) return WHALE_LINES.reasons.blockFour;
  if (analysis.blocksOpenThree) return WHALE_LINES.reasons.blockOpenThree;
  if (analysis.nearCenter) return WHALE_LINES.reasons.center;
  return WHALE_LINES.reasons.fallback;
}

/**
 * 收尾措辞。
 * 必杀局面（一手成五 / 必须挡五）直接给 certain：这时说「局面有点紧」是自相矛盾，
 * 而 value 只是搜索 Q 值，不保证落在高分区。
 */
function confidenceFor(analysis: MoveAnalysis, value: number): string {
  if (analysis.wouldWin || analysis.blocksWin) return WHALE_LINES.confidence.certain;
  if (value >= 0.72) return WHALE_LINES.confidence.high;
  if (value >= 0.55) return WHALE_LINES.confidence.medium;
  return WHALE_LINES.confidence.low;
}

export interface HintView {
  text: string;
  move: number;
  coord: string;
  chips: Array<{ rank: number; move: number; label: string }>;
}

/**
 * 同一次提示只生成一遍文案。
 * `refreshHintPanel()` 每次 `refreshAll()` 都会调到这里，若不缓存，
 * 切皮肤或开关音效时提示语会自己换一句。
 */
const viewCache = new WeakMap<SearchResult, HintView>();

export function buildHintView(
  board: BoardState,
  player: Player,
  result: SearchResult,
): HintView | null {
  if (result.move < 0) return null;
  const cached = viewCache.get(result);
  if (cached) return cached;

  const analysis = analyzeMove(board, player, result.move);
  const coord = formatCoord(result.move);
  const text = fillLine(pickLine(WHALE_LINES.suggestion), {
    coord,
    reason: pickLine(reasonFor(analysis)),
    confidence: confidenceFor(analysis, result.value),
  });

  // value 是 MCTS 回传的搜索评分（Q 值），不是校准后的真实胜率，因此按“分”展示。
  const chips = result.top
    .filter((item: SearchTop) => item.visits > 0)
    .slice(0, 3)
    .map((item, index) => ({
      rank: index + 1,
      move: item.move,
      label: `${index + 1} ${shortCoord(item.move)} · ${Math.round(item.value * 100)} 分`,
    }));

  const view: HintView = { text, move: result.move, coord, chips };
  viewCache.set(result, view);
  return view;
}
