// RollPolicy：先攻、命中、闪避和伤害的实际投点。设计文档 §13.5、§25.1。
// 教材只确认 0 ≤ 实际投点 ≤ 2 × 公式平均值，分布未知，
// 因此所有策略都是可替换的显式实验实现，不得声称与原版一致。

/**
 * @typedef {object} RollPolicy
 * @property {string} id
 * @property {boolean} experimental
 * @property {(mean: number, context: object) => number} rollAroundMean
 */

/** 期望值策略：直接返回平均值。用于确定性测试与回归断言。 */
export const meanRollPolicy = Object.freeze({
  id: "mean",
  experimental: false,
  rollAroundMean(mean) {
    return mean;
  },
});

/**
 * 均匀分布策略：在 [0, 2 × 平均值] 上均匀投点。
 * 分布、整数化与上界是否包含均未确认，属于 D 级实验参数。
 */
export function createUniformRollPolicy(options = {}) {
  const includeUpperBound = Boolean(options.includeUpperBound);
  const integer = Boolean(options.integer);
  return {
    id: integer ? "uniform-0-2mean-int" : "uniform-0-2mean",
    experimental: true,
    rollAroundMean(mean, context) {
      const stream = context?.randomStream;
      if (!stream) throw new Error("均匀投点需要 randomStream");
      const upper = mean * 2;
      const value = stream.between(0, upper);
      if (integer) return Math.floor(includeUpperBound ? Math.min(value, upper) : value);
      return value;
    },
  };
}

export const DEFAULT_ROLL_POLICY = meanRollPolicy;

export function resolveRollPolicy(policies, id, fallback = DEFAULT_ROLL_POLICY) {
  if (!id) return fallback;
  const policy = policies?.[id];
  if (!policy) throw new Error(`缺少随机投点策略: ${id}`);
  return policy;
}
