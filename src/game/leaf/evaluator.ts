import type { EvalCache } from '../eval-cache';
import { BLACK, type Player } from '../types';
import { blend, type BlendParams } from './blend';
import { extractFeatures, FEATURE_COUNT } from './features';

/**
 * 叶子评估的接缝：搜索只认 `score(side)`。
 *
 * 2.0.0 的搜索直接调 `EvalCache.score`，现在中间多一层，好让「旧评估 / 混合评估」
 * 在对局记录里可区分，也让网络缺失时的降级只是换一个实现而不是加分支。
 * 接口刻意只有 `score`：push/pop/reset 仍归搜索管，评估器只是读取方。
 */
export interface LeafEvaluator {
  /** 行棋方视角的分数，刻度与 `EvalCache.score` 相同。 */
  score(side: Player): number;
}

/** 纯旧评估。λ=0、未加载权重、权重解析失败，最终都落到这里。 */
export class OldEvaluator implements LeafEvaluator {
  constructor(private readonly cache: EvalCache) {}

  score(side: Player): number {
    return this.cache.score(side);
  }
}

/**
 * 小型 MLP 的前向。
 *
 * 输入是 `features.ts` 写出的 30 维复用缓冲，调用方不要在实现里保留引用。
 * 输出直接给 logit 而不是胜率：blend 需要的就是 logit，走一遍 σ 再取 log
 * 既多两次超越函数、又白白丢精度。
 */
export interface LeafNet {
  /** 行棋方视角的 logit（约 ±8，对应胜率 0.9997 之外都被夹掉）。 */
  logit(features: Float32Array): number;
}

/** 混合评估：旧评估分与网络 logit 按 λ 融合。 */
export class BlendedEvaluator implements LeafEvaluator {
  private readonly features = new Float32Array(FEATURE_COUNT);

  constructor(
    private readonly cache: EvalCache,
    private readonly net: LeafNet,
    private readonly params: BlendParams,
  ) {}

  score(side: Player): number {
    const blackToMove = side === BLACK;
    extractFeatures(this.cache, side, blackToMove, this.features);
    // 旧评估分照算：它只占叶子总成本的很小一部分，却是「盘上已有五连 → ±30000」
    // 这条判断的唯一来源。省它换不来速度，丢它会把将杀退化成「优势极大」。
    return blend(this.cache.score(side), this.net.logit(this.features), blackToMove, this.params);
  }
}

/** 叶子评估的运行期配置。λ 的标定值来自训练端，默认 0 保证行为与 2.0.0 一致。 */
export interface LeafConfig {
  K: number;
  b: number;
  lambda: number;
}

/**
 * 按配置造评估器。缺网络或 λ=0 时返回 `OldEvaluator`——
 * 这不是「优化」，是降级路径：权重要么没下发，要么校验没过，搜索必须照常跑完。
 */
export function createLeafEvaluator(
  cache: EvalCache,
  net: LeafNet | null | undefined,
  config: LeafConfig,
): LeafEvaluator {
  if (!net || !(config.lambda > 0)) return new OldEvaluator(cache);
  return new BlendedEvaluator(cache, net, {
    K: config.K,
    b: config.b,
    lambda: config.lambda,
  });
}
