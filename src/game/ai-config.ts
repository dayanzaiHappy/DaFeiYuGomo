import type { RootNoise } from './types';

export type AiDifficulty = 'easy' | 'normal' | 'hard';

/** 三档难度对应的对手搜索预算。 */
export const DIFFICULTY_SIMS: Record<AiDifficulty, number> = {
  easy: 4,
  normal: 16,
  hard: 64,
};

/** 三档难度的根节点 visits 温度；越大越随机。 */
export const OPPONENT_TEMPERATURE: Record<AiDifficulty, number> = {
  easy: 1.0,
  normal: 0.6,
  hard: 0.2,
};

/** 温度采样只在 visits 前几名里选。 */
export const SAMPLE_TOP_K = 3;

/** 对手根节点 Dirichlet 噪声；难度越高噪声越弱。 */
export const OPPONENT_NOISE: Record<AiDifficulty, RootNoise> = {
  easy: { epsilon: 0.25, alpha: 0.1 },
  normal: { epsilon: 0.2, alpha: 0.1 },
  hard: { epsilon: 0.15, alpha: 0.1 },
};

export const AI_CONFIG = {
  hintSims: 256,
  /** 提示返回并展示的候选数量。 */
  hintTopK: 3,
  progressEvery: 16,
  radius: 4,
  cPuct: 2.0,
  modelVersion: 'v2-b6c96-fp32',
  modelUrl: 'models/model-v2.onnx',
} as const;
