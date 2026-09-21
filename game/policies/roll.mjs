// RollPolicy：先攻、命中、闪避和伤害的实际投点。设计文档 §13.5、§25.1。
// 骰池分布来自用户提供的投点研究文档，仍通过策略隔离，便于继续用战报校准。

import { rollDice } from "../dice.mjs";

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

/**
 * WOD 骰池策略：先按“使用时向下取整”得到整数平均值，再交给骰池投掷。
 * 公式里的直接固定加值应由调用方在投点后追加，不应拆进骰池。
 */
export function createDiceRollPolicy() {
  return {
    id: "wod-dice-pool-int",
    experimental: true,
    rollAroundMean(mean, context) {
      if (!Number.isFinite(mean)) throw new RangeError(`投点平均值必须是有限数值: ${mean}`);
      const stream = context?.randomStream;
      if (!stream) throw new Error("骰池投点需要 randomStream");
      return rollDice(Math.max(0, Math.floor(mean)), stream);
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
