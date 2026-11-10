/**
 * 小鲸鱼在气泡里说的话。
 *
 * 人设：傲娇嘴硬、短句、少标点、不客服腔；她不喜欢被叫「大肥鱼」。
 * 每个槽位是一个词池，由 pickLine 按洗牌袋取，同一轮内不会重复。
 * 想改口吻或措辞只改这个文件，游戏逻辑不依赖具体文案。
 */

export const WHALE_LINES = {
  /** 空盘开局 */
  opening: ['空盘 你先', '来了 下吧', '第一手随你'],

  /** 等你落子 */
  idle: [
    '轮到你了',
    '你倒是下啊',
    '我等着呢',
    '想好了就下',
    '手别抖',
    '有点饿了 中午吃啥',
  ],

  /** 提示计算中（超过 5 秒会换成「已思考 N 秒…」，不走这里） */
  thinking: ['别催', '在算', '深度思考中', '在想怎么下呢'],

  /** 她自己思考落子 */
  myTurn: ['该我了', '我来', '等我吃完这口', 'DeepSleep...'],

  /** 人 vs 人 */
  pvp: ['你俩下 我看着', '我围观', '双人局 我负责看'],

  /** 引擎加载中 */
  loading: ['等我一下 脑子还在路上', '正在加载 别急'],

  /** 引擎加载失败 */
  loadError: ['服务器繁忙', '没加载出来 看看网', '我这边没醒 刷新试试'],

  /** 玩家赢 */
  youWin: ['行吧 你赢了', '这局算你的', '哼 就这一次', '好多token白花了'],

  /** 她赢 */
  fishWin: ['赢了', '这局归我', '承让 下局你先'],

  /** 和棋 */
  draw: ['平了', '谁也没赢'],

  /** 双人局结束 */
  pvpEnd: ['下完了', '你俩谁厉害'],

  /** 开局低概率抗议「大肥鱼」这个外号 */
  nameGag: ['先说好 别叫我大肥鱼', '我才不是吃白饭的大肥鱼', '这游戏名字不是我起的'],

  /** 玩家连胜三局后的摆烂态 */
  tilt: ['我就是吃白饭的蓝色大肥鱼', '行吧 反正我是大肥鱼'],

  /** 悔棋 */
  undo: ['悔棋？', '行吧 当没看见', '这手不算'],

  /** 一局里第三次起悔棋 */
  undoRepeat: ['用户 你够了', '坏了...用户彻底怒了'],

  /** 重开 */
  restart: ['重开', '来', '这次我不留手'],

  /** 点错 / 落在已有子的格子上 */
  illegal: ['那儿有子', '看清楚再下'],

  /** 不是你的回合 */
  notYourTurn: ['急什么', '还没到你', '压力一只小鲸鱼？！'],

  /** 提示模板：{coord} 坐标，{reason} 理由，{confidence} 收尾 */
  suggestion: [
    '{coord} {reason}{confidence}',
    '下{coord} {reason}{confidence}',
    '{coord}吧 {reason}{confidence}',
  ],

  /** 落点理由 */
  reasons: {
    win: ['这儿五连，结束了。', '下了就赢。'],
    blockWin: ['他四连了，不挡就死。', '先堵，不然没了。'],
    openFour: ['活四，两头都空，他挡不住。', '这手活四，他没辙。'],
    four: ['冲四，先手在我这。', '这是个四，他必须应。'],
    openThree: ['活三，下一手就成四。', '先活三，别急着冲。'],
    blockFour: ['他这个四得破。', '先拆四，不然下一手就完。'],
    blockOpenThree: ['活三得压住。', '拦他活三，别让他长起来。'],
    center: ['中间，两边都好走。', '占中，稳。'],
    fallback: ['这儿子最多，攻守都顾得上。', '没更好的，就这儿。'],
  },

  /** 按局面估值给的收尾 */
  confidence: {
    /** 必杀专用：一手成五或必须挡五，不让估值左右措辞 */
    certain: '这步不用想。',
    high: '换我就下这儿。',
    medium: '稳。',
    low: '有点险，先这么走。',
  },
} as const;

/* ===== 抽取 ===== */

/** 洗牌袋：一轮内每句各出现一次，弹空才重洗。 */
let revision = 0;
const bags = new WeakMap<readonly string[], { rev: number; queue: string[] }>();

function shuffle<T>(list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** 从词池里取一句。同一个池连续取不会重复，取完一轮才重洗。 */
export function pickLine(pool: readonly string[]): string {
  if (pool.length === 1) return pool[0]!;
  const hit = bags.get(pool);
  if (hit && hit.rev === revision && hit.queue.length > 0) {
    return hit.queue.pop()!;
  }
  const queue = shuffle([...pool]);
  bags.set(pool, { rev: revision, queue });
  return queue.pop()!;
}

/**
 * 同一个签名下只抽一次，签名变了才换词。
 *
 * 必须用它：`refreshHintPanel()` 每次 `refreshAll()` 都会跑（切皮肤、开关音效都算），
 * 直接调 `pickLine` 会导致「开个音效开关，台词就换一句」。
 */
const stable = new Map<string, { sig: string; text: string }>();

export function pickLineStable(ns: string, pool: readonly string[], sig: string): string {
  const hit = stable.get(ns);
  if (hit && hit.sig === sig) return hit.text;
  const text = pickLine(pool);
  stable.set(ns, { sig, text });
  return text;
}

/** 重开一局时调用：让洗牌袋和防抖缓存都重新开始。 */
export function resetLines(): void {
  revision += 1;
  stable.clear();
}

/** 把模板里的 {name} 占位符替换成实际内容。 */
export function fillLine(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}
