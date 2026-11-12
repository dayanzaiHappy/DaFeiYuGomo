import { analyzeMove } from './explain';
import { immediateWins, openFourPoints } from './tactics';
import { other, type BoardState, type Player } from './types';

/**
 * 复盘里对单手的规则判定。
 *
 * 只回答「这手有没有违反某条战术常识」，不回答「这手好不好」——
 * 后者要靠搜索值与评级，前者是确定性的，不随预算抖动，也不受模型校准影响。
 */
export type CoachVerdict =
  | 'missedWin'
  | 'missedBlockFive'
  | 'missedBlockOpenThree'
  | 'goodBlock'
  | 'goodOpenFour';

/**
 * 判定顺序即优先级：漏成五 > 漏挡五 > 漏活三 > 好堵 > 活四。
 * 返回 null 表示这手没有可说的，不是「好棋」的意思。
 *
 * 两处例外都在防止误判：
 * - 这手自己成五：赢了就不谈「漏」。
 * - 对方已经有 ≥2 个成五点：已经挡不住，说「漏挡」没有行动价值。
 */
export function judgeMove(
  boardBefore: BoardState,
  player: Player,
  move: number,
): CoachVerdict | null {
  const analysis = analyzeMove(boardBefore, player, move);
  if (analysis.wouldWin) return null;

  // 自己能赢却去造四，可能是连续冲四的杀法，不判漏杀
  if (immediateWins(boardBefore, player).length > 0 && !analysis.createsFour) {
    return 'missedWin';
  }

  const rivalWins = immediateWins(boardBefore, other(player));
  if (rivalWins.length === 1) {
    return move === rivalWins[0] ? 'goodBlock' : 'missedBlockFive';
  }
  if (rivalWins.length >= 2) return null;

  if (analysis.createsOpenFour) return 'goodOpenFour';

  const openThreePoints = openFourPoints(boardBefore, other(player));
  if (openThreePoints.length > 0) {
    // 堵住活三的延伸点只能算「好堵」：活三还有另一头，这一步不构成漏防
    if (openThreePoints.includes(move)) return 'goodBlock';
    // 自己冲四是对攻，先把先手抢过来，不判漏防
    if (analysis.createsFour) return null;
    return 'missedBlockOpenThree';
  }

  return null;
}

/** 统计与遍历用的固定顺序，同时决定徽标的展示顺序。 */
export const COACH_VERDICTS: readonly CoachVerdict[] = [
  'missedWin',
  'missedBlockFive',
  'missedBlockOpenThree',
  'goodBlock',
  'goodOpenFour',
];
