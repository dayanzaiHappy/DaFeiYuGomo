import type { RootNoise } from './types';

export type AiDifficulty = 'easy' | 'normal' | 'hard' | 'hell';

/** 参数表的行：四档难度 + 提示。提示不是「额外功能」，只是把随机性推到 0 的第五档。 */
export type SearchTier = AiDifficulty | 'hint';

/** 难度顺序：设置面板的展示顺序，也是合法性校验的唯一清单。 */
export const DIFFICULTY_ORDER: readonly AiDifficulty[] = ['easy', 'normal', 'hard', 'hell'];

/** 判断持久化的字符串是否仍是合法难度（新增档位时只需改 DIFFICULTY_ORDER）。 */
export function isAiDifficulty(value: unknown): value is AiDifficulty {
  return typeof value === 'string' && (DIFFICULTY_ORDER as readonly string[]).includes(value);
}

/** 四档难度的中文名。 */
export const DIFFICULTY_LABELS: Record<AiDifficulty, string> = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
  hell: '地狱',
};

/**
 * 搜索预算：40·(√e)ⁿ，n 从 0 起。
 * 公式生成而不是手填——1.2.0 的提示预算 292 就是手填时算错的，第五项应为 296。
 */
const simsOf = (n: number): number => Math.round(40 * Math.pow(Math.E, n / 2));

/** 根节点保留的候选数：rootLimit 决定「谁上场」，与 SAMPLE_TOP_K（怎么抽）、hintTopK（展示几个）无关。 */
export interface SearchProfile {
  sims: number;
  /** 根节点按先验只保留这么多个点；0 表示不截断。 */
  rootLimit: number;
  /** 叶节点强制解析的层数；0 表示不做。 */
  forcedPlies: number;
  /** 根节点 VCF 深度；0 表示不做。 */
  vcfDepth: number;
  /** 根节点 visits 温度，0 表示 argmax。 */
  temperature: number;
  /** 根节点 Dirichlet 噪声；null 表示不加。 */
  noise: RootNoise | null;
}

/** 温度采样只在 visits 前几名里选。 */
export const SAMPLE_TOP_K = 3;

/** 噪声支持集的质量护栏：先验不得低于 top1 的这个比例。 */
export const NOISE_MIN_RATIO = 0.5;

/** 噪声支持集的位置护栏：到上一手的切比雪夫半径。 */
export const NOISE_RADIUS = 2;

/** 根节点候选的相对阈值（相对第一名）。0.5 太狠会只剩两三个点，实测取 0.05。 */
export const ROOT_PRIOR_FLOOR = 0.05;

/**
 * 根节点先验的战术偏置强度 λ。
 *
 * 做法：softmax(log p + b)，b = (λ/W)·[档位分 + τ·1{档位分 ≥ τ}]，W = 成五分。
 * λ = 0 关闭。实测（真实模型，15 个「先验看错活三」的局面，地狱档）：
 *   λ=0 → 7/15，λ=1 → 10/15，λ=2 → 12/15，λ=4 → 13/15，λ=8 → 14/15。
 * 2 拿走了大部分收益；再往上偏置会盖过网络判断、退化成硬规则，所以取 2。
 * 只在开了战术层的档位生效（简单档不受影响）。
 */
export const PRIOR_BIAS_STRENGTH = 2;

/**
 * FPU reduction 系数。0 = 标准 PUCT（未访问节点取父节点价值）。
 * 机制写进 uctValue 是为了留痕：调整它是一行的事，把推导重来一遍不是。
 *
 * 本版取 0：惩罚尺度由先验质量决定，先验越偏锁得越快，而我们的先验来自小网；
 * 四档又都带根节点噪声，按 KataGo 的口径就不该启用。
 */
export const C_FPU = 0;

/** 五个档位一张表。四档的 sims / τ / ε 与 1.2.0 完全一致，变的只是多了三个新旋钮。 */
export const SEARCH_PROFILES: Record<SearchTier, SearchProfile> = {
  easy: {
    sims: simsOf(0),
    rootLimit: 8,
    forcedPlies: 0,
    vcfDepth: 0,
    temperature: 1.0,
    noise: { epsilon: 0.1, alpha: 0.1, minRatio: NOISE_MIN_RATIO, radius: NOISE_RADIUS, topM: 12 },
  },
  normal: {
    sims: simsOf(1),
    rootLimit: 12,
    forcedPlies: 1,
    // 普通档也给两级连冲：到这个档位就不该再犯「漏堵活三」这种一眼错
    vcfDepth: 2,
    temperature: 0.6,
    noise: { epsilon: 0.06, alpha: 0.1, minRatio: NOISE_MIN_RATIO, radius: NOISE_RADIUS, topM: 10 },
  },
  hard: {
    sims: simsOf(2),
    rootLimit: 20,
    forcedPlies: 2,
    vcfDepth: 5,
    temperature: 0.3,
    noise: { epsilon: 0.03, alpha: 0.1, minRatio: NOISE_MIN_RATIO, radius: NOISE_RADIUS, topM: 8 },
  },
  hell: {
    sims: simsOf(3),
    rootLimit: 32,
    forcedPlies: 3,
    vcfDepth: 7,
    temperature: 0.1,
    noise: { epsilon: 0.01, alpha: 0.1, minRatio: NOISE_MIN_RATIO, radius: NOISE_RADIUS, topM: 8 },
  },
  hint: {
    sims: simsOf(4),
    rootLimit: 48,
    forcedPlies: 3,
    vcfDepth: 7,
    // 提示要求同一局面点两次结果一样：τ 关、ε 关，两者缺一不可
    temperature: 0,
    noise: null,
  },
};

/** 根节点候选半径：远点由先验与阈值决定要不要留。 */
export const ROOT_RADIUS = 4;

/** 叶节点候选半径：任何成五/挡五/造四的落点都与已有棋子相邻，2 格足够。 */
export const LEAF_RADIUS = 2;

/** 配置行里能直接搬进搜索参数的部分。 */
export interface ProfileOptions {
  sims: number;
  rootLimit: number;
  forcedPlies: number;
  vcfDepth: number;
  temperature: number;
  rootNoise: RootNoise | null;
}

/**
 * 把配置行展开成搜索参数。
 *
 * 唯一的原因是字段名不同：配置里叫 noise，搜索参数叫 rootNoise。
 * 直接 `{ ...profile }` 展开会被静默丢掉——类型系统查不出展开出来的多余字段，
 * 表现为「噪声配置写了但没生效」，所以这里显式对齐一次，调用方只展开这个结果。
 */
export function toSearchOptions(profile: SearchProfile): ProfileOptions {
  return {
    sims: profile.sims,
    rootLimit: profile.rootLimit,
    forcedPlies: profile.forcedPlies,
    vcfDepth: profile.vcfDepth,
    temperature: profile.temperature,
    rootNoise: profile.noise,
  };
}

export const AI_CONFIG = {
  /** 搜索逻辑的版本，与模型版本正交：换模型不改它，改公式/候选/战术才改它。 */
  engineVersion: 'mcts-1.3',
  /** 提示返回并展示的候选数量。 */
  hintTopK: 3,
  progressEvery: 16,
  modelVersion: 'v2-b6c96-fp32',
  modelUrl: 'models/model-v2.onnx',
} as const;
