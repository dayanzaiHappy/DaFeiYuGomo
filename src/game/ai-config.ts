import type { RootNoise } from './types';

export type AiDifficulty = 'easy' | 'normal' | 'hard' | 'hell';

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

/** 四档难度的搜索预算：首项 40、公比 √e，逐项取整。 */
export const DIFFICULTY_SIMS: Record<AiDifficulty, number> = {
  easy: 40,
  normal: 66,
  hard: 109,
  hell: 179,
};

/** 四档难度的根节点 visits 温度；越大越随机。 */
export const OPPONENT_TEMPERATURE: Record<AiDifficulty, number> = {
  easy: 1.0,
  normal: 0.6,
  hard: 0.3,
  hell: 0.1,
};

/** 温度采样只在 visits 前几名里选。 */
export const SAMPLE_TOP_K = 3;

/** 噪声支持集的质量护栏：先验不得低于 top1 的这个比例。 */
export const NOISE_MIN_RATIO = 0.5;

/** 噪声支持集的位置护栏：到上一手的切比雪夫半径。 */
export const NOISE_RADIUS = 2;

/** 对手根节点 Dirichlet 噪声；难度越高噪声越弱、候选越少。 */
export const OPPONENT_NOISE: Record<AiDifficulty, RootNoise> = {
  easy: { epsilon: 0.1, alpha: 0.1, minRatio: NOISE_MIN_RATIO, radius: NOISE_RADIUS, topM: 12 },
  normal: { epsilon: 0.06, alpha: 0.1, minRatio: NOISE_MIN_RATIO, radius: NOISE_RADIUS, topM: 10 },
  hard: { epsilon: 0.03, alpha: 0.1, minRatio: NOISE_MIN_RATIO, radius: NOISE_RADIUS, topM: 8 },
  hell: { epsilon: 0.01, alpha: 0.1, minRatio: NOISE_MIN_RATIO, radius: NOISE_RADIUS, topM: 8 },
};

export const AI_CONFIG = {
  /** 提示预算：等比数列的第 5 项，恒定 ≥ 地狱档。 */
  hintSims: 292,
  /** 提示返回并展示的候选数量。 */
  hintTopK: 3,
  progressEvery: 16,
  radius: 4,
  modelVersion: 'v2-b6c96-fp32',
  modelUrl: 'models/model-v2.onnx',
} as const;
