export type AiDifficulty = 'noob' | 'easy' | 'normal' | 'hard' | 'hell';

/** 参数表的行：五档难度 + 提示。提示不是「额外功能」，只是把随机性推到 0 的第六档。 */
export type SearchTier = AiDifficulty | 'hint';

/** 难度顺序：设置面板的展示顺序，也是合法性校验的唯一清单。 */
export const DIFFICULTY_ORDER: readonly AiDifficulty[] = ['noob', 'easy', 'normal', 'hard', 'hell'];

/** 判断持久化的字符串是否仍是合法难度（新增档位时只需改 DIFFICULTY_ORDER）。 */
export function isAiDifficulty(value: unknown): value is AiDifficulty {
  return typeof value === 'string' && (DIFFICULTY_ORDER as readonly string[]).includes(value);
}

/** 各档难度的中文名。 */
export const DIFFICULTY_LABELS: Record<AiDifficulty, string> = {
  noob: '菜鸟',
  easy: '简单',
  normal: '普通',
  hard: '困难',
  hell: '地狱',
};

/**
 * 引擎的档位参数，字段与 `src/game/search.ts` 的 `AbSearchOptions` 对齐。
 *
 * 2026-11-15 实测本机吞吐约 95k~130k 节点/秒（空闲、单进程），节点数按「让 depth
 * 真正跑完」而不是按某个延迟目标反推——depth 是硬上限，nodes 给不够就是名不副实。
 * 深度压在偶数：奇数深度会停在「我刚落子、对手还没应」的位置，系统性偏乐观。
 */
export interface AbProfile {
  /** 迭代加深上限，取偶数。 */
  depth: number;
  /** 节点总预算，静态战术搜索也从这里扣。 */
  nodes: number;
  /** 根节点硬截断：只搜这么多候选，每个都拿确切分。 */
  widthRoot: number;
  /** 内部软门控：前这么多全深度，其余降 2 层试探。 */
  widthInner: number;
  /** 静态战术层数。 */
  qDepth: number;
  /** 根节点 VCF 深度。 */
  vcfDepth: number;
  /** 根节点保留确切分的候选数：对局只要一手，提示与复盘要 top-3。 */
  multiPV: number;
  /** 弱化抖动幅度，单位是分值；只有 multiPV > 1 时池子里才有多个人可抖。 */
  noise: number;
  /** 弱化偏置：差多少按比例抬多少。0 表示不抬。 */
  bias: number;
}

export const AB_PROFILES: Record<SearchTier, AbProfile> = {
  noob: {
    depth: 2, nodes: 2_000, widthRoot: 8, widthInner: 4,
    qDepth: 2, vcfDepth: 1, multiPV: 8, noise: 1000, bias: 0,
  },
  easy: {
    depth: 2, nodes: 6_000, widthRoot: 10, widthInner: 6,
    qDepth: 3, vcfDepth: 3, multiPV: 6, noise: 700, bias: 0,
  },
  normal: {
    depth: 4, nodes: 24_000, widthRoot: 12, widthInner: 8,
    qDepth: 3, vcfDepth: 3, multiPV: 5, noise: 300, bias: 0,
  },
  hard: {
    depth: 6, nodes: 100_000, widthRoot: 16, widthInner: 10,
    qDepth: 4, vcfDepth: 5, multiPV: 4, noise: 100, bias: 0,
  },
  hell: {
    depth: 8, nodes: 300_000, widthRoot: 20, widthInner: 12,
    qDepth: 6, vcfDepth: 7, multiPV: 3, noise: 50, bias: 0,
  },
  hint: {
    depth: 8, nodes: 600_000, widthRoot: 24, widthInner: 14,
    qDepth: 6, vcfDepth: 9, multiPV: 3, noise: 0, bias: 0,
  },
};

/**
 * 复盘深评直接用提示档，不再单独定义一套参数。
 *
 * 深评必须比地狱强，否则「最佳着」只是「地狱会走的那一步」，评级会系统性偏袒 AI；
 * 提示档 depth 8、宽 24/14，正好高一级。单独给复盘打折（曾经的 300k）只会让两套
 * 参数各自漂移——嫌慢就该降提示档本身，提示是用户点一次就要等的同一件事。
 */
export const REVIEW_PROFILE: AbProfile = AB_PROFILES.hint;

/** 根节点候选半径：远点由威胁分与阈值决定要不要留。 */
export const ROOT_RADIUS = 4;

/** 叶节点候选半径：任何成五/挡五/造四的落点都与已有棋子相邻，2 格足够。 */
export const LEAF_RADIUS = 2;

export const AI_CONFIG = {
  /** 搜索逻辑的版本，与模型版本正交：换模型不改它，改公式/候选/战术才改它。 */
  engineVersion: 'ab-2.0.0',
  /** 提示返回并展示的候选数量。 */
  hintTopK: 3,
  modelVersion: 'v2-b6c96-fp32',
  modelUrl: 'models/model-v2.onnx',
} as const;

/**
 * 叶子评估的配置（2.1.0 的混合评估）。
 *
 * 默认 λ=0：混合评估在 λ=0 时原样返回旧评估分，搜索路径与 2.0.0 逐位一致。
 * 标定出来的 λ* 在等节点对局验证过之后才改这里，并且分档可不同——
 * 「弱档偏旧、强档偏新」是对局结论，不是可以假设的方向。
 */
export interface EvalConfig {
  /**
   * 旧评估分换 logit 的尺度：`u_o = 2·s_o / K`。
   *
   * 这是**旧评估专属**的标定常数，回答「多少分算一个 logit」，由标定集拟合得到。
   * 它不决定输出的分数刻度——刻度固定是 `WIN_RATE_SCALE`，因为 noise、MOVE_MARGIN、
   * GRADE_LOSS、SCORE_CLAMP 全都按那个刻度写。详见 `leaf/blend.ts` 的 `scoreFromLogit`。
   */
  K: number;
  /** 先后手偏置：黑先 +1、白先 −1。空盘旧评估给 0，缺的就是这一项（标定值 0.15）。 */
  b: number;
  /** 对新评估的信任度，0 表示完全不用网络。 */
  lambda: number;
  /** 叶子权重路径；null 表示不带网络，全部走旧评估。 */
  modelUrl: string | null;
  /** 权重的 SHA-256，与 modelUrl 一起下发，写进对局记录。 */
  hash: string | null;
}

export const EVAL_CONFIG: EvalConfig = {
  /** 标定集上拟合出的旧评估尺度，取整到 5000。 */
  K: 5000,
  /** 标定出的先后手偏置：黑先 +0.15 logit ≈ 53.7%，与 freestyle 黑的基率优势同向。 */
  b: 0.15,
  /**
   * 1 = 全用叶子网。标定给出 λ\*=1.0，与「网络特征包含旧评估全部信息」一致：
   * 网络的 30 维里就有双方六种形状计数与位置分，旧评估在这之上加不出新信号。
   */
  lambda: 1,
  modelUrl: 'models/leaf-v1.bin',
  /** 权重字节的 SHA-256。加载时比对，不符则按 λ=0 跑——宁可退回旧评估也不要跑半份权重。 */
  hash: 'sha256:8abc4322c38cfb059b820b3eaac35730ba96c7a61b46ca8fda7b673218270da7',
};
