// CalculatedNumber / CalculationStep 与取整策略。设计文档 §14.5、§18、§25.9。
// 规则：内部计算保留小数；只有数值被实际使用时才向下取整。

/** 默认取整策略：使用时向下取整。 */
export const floorRoundingPolicy = Object.freeze({
  id: "floor",
  round(value) {
    return Math.floor(value);
  },
});

/** 仅供实验对照，不得声称与原版一致。 */
export const roundHalfUpPolicy = Object.freeze({
  id: "round-half-up",
  round(value) {
    return Math.round(value);
  },
});

export const DEFAULT_ROUNDING_POLICY = floorRoundingPolicy;

function step(label, value, note) {
  return note === undefined ? { label, value } : { label, value, note };
}

/**
 * 构造一个 CalculatedNumber。
 * @param {number} exact 未取整精确值
 * @param {object} [options]
 * @param {Array} [options.steps] 计算步骤，按发生顺序
 * @param {object} [options.roundingPolicy] 取整策略
 * @param {number} [options.minimum] 使用值下限
 */
export function calculatedNumber(exact, options = {}) {
  const policy = options.roundingPolicy ?? DEFAULT_ROUNDING_POLICY;
  const raw = policy.round(exact);
  const minimum = options.minimum;
  const applied = minimum === undefined ? raw : Math.max(minimum, raw);
  const steps = options.steps ? [...options.steps, step("取整", applied, `${policy.id}(${exact})`)] : [step("取整", applied, `${policy.id}(${exact})`)];
  return { exact, applied, steps, roundingPolicyId: policy.id };
}

export function traceSteps(...groups) {
  return groups.flat().filter(Boolean);
}

export function isCalculatedNumber(value) {
  return Boolean(value) && typeof value === "object" && "exact" in value && "applied" in value && Array.isArray(value.steps);
}

/** 断言没有 NaN / Infinity，供诊断层使用。 */
export function assertFinite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`数值异常 ${label}: ${value}`);
  return value;
}

/** 行动次数：1.9 只产生 1 次行动。文档 §14.5。 */
export function actionsFromExact(exact, roundingPolicy = DEFAULT_ROUNDING_POLICY) {
  return Math.max(0, roundingPolicy.round(exact));
}

export { step as calculationStep };
