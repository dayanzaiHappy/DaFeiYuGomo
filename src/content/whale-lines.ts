/**
 * 大肥鱼在提示气泡里说的话。
 * 想改口吻、措辞或提示理由，只改这个文件即可，游戏逻辑不依赖具体文案。
 */

export const WHALE_LINES = {
  /** 等待提示 */
  idle: '点「提示」，我帮你看看这步该怎么走。',
  /** 提示搜索中 */
  thinking: '正在思考中……',
  /** 人 vs 人模式 */
  pvp: '本地双人模式。轮到你时直接落子。',
  /** 轮到 AI 落子 */
  myTurn: '轮到我啦，我看看……',
  /** AI 引擎加载中 */
  loading: '我先把脑子搬过来……',
  /** AI 引擎加载失败 */
  loadError: '我的脑子没加载成功，检查一下网络再试？',
  /** 对局结束：你赢或本地双人结束 */
  win: '这局结束了，下得不错。再来一局？',
  /** 对局结束：大肥鱼赢 */
  lose: '这局我赢啦。再来一局？',
  /** 和棋 */
  draw: '和棋。再来一局分个胜负？',

  /** 提示正文模板：{coord} 坐标，{reason} 理由，{confidence} 收尾 */
  suggestion: '我建议下在{coord}。{reason}{confidence}',

  /** 落点理由 */
  reasons: {
    win: '这一步直接连成五子，胜负立刻见分晓。',
    blockWin: '对面这里已经能连五了，必须先挡住。',
    openFour: '这里能做出活四，对面挡不住。',
    four: '这里能冲出四，先手很足。',
    openThree: '这里能做出活三，下一步就有活四。',
    blockFour: '先拆掉对面的四连，不然会很危险。',
    blockOpenThree: '先把对面的活三压住，别让它继续长。',
    center: '靠近中路，向两边都好展开。',
    fallback: '这里子力最集中，攻守都能兼顾。',
  },

  /** 按局面估值给的收尾 */
  confidence: {
    high: '我比较看好这里。',
    medium: '这里比较稳。',
    low: '局面有点紧，先稳住。',
  },
} as const;

/** 把模板里的 {name} 占位符替换成实际内容。 */
export function fillLine(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}
