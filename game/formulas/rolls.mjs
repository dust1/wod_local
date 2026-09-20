// 先攻、命中、闪避、伤害的平均值公式。设计文档 §13.3、§13.4。
import { calculationStep, calculatedNumber, DEFAULT_ROUNDING_POLICY } from "./calculation.mjs";
import { deriveBaseCharacterStats } from "../domain/attributes.mjs";

/** 平均值 = 主属性 × 2 + 副属性 + 实时技能等级 × 2 */
export function skillRollMean({ primary = 0, secondary = 0, skillLevel = 0 }, options = {}) {
  const exact = primary * 2 + secondary + skillLevel * 2;
  return calculatedNumber(exact, {
    roundingPolicy: options.roundingPolicy ?? DEFAULT_ROUNDING_POLICY,
    minimum: 0,
    steps: [
      calculationStep("主属性 × 2", primary * 2),
      calculationStep("副属性", secondary),
      calculationStep("实时技能等级 × 2", skillLevel * 2),
    ],
  });
}

/** 默认先攻没有技能等级项：默认先攻平均值 = 敏捷 × 2 + 感知 */
export function defaultInitiativeMean({ agility = 0, perception = 0 }, options = {}) {
  const exact = deriveBaseCharacterStats({ agility, perception }).initiative;
  return calculatedNumber(exact, {
    roundingPolicy: options.roundingPolicy ?? DEFAULT_ROUNDING_POLICY,
    minimum: 0,
    steps: [
      calculationStep("敏捷 × 2", agility * 2),
      calculationStep("感知", perception),
    ],
  });
}

/** 伤害平均值 = 主属性 ÷ 2 + 副属性 ÷ 3 + 实时技能等级 ÷ 2 */
export function damageMean({ primary = 0, secondary = 0, skillLevel = 0 }, options = {}) {
  const exact = primary / 2 + secondary / 3 + skillLevel / 2;
  return calculatedNumber(exact, {
    roundingPolicy: options.roundingPolicy ?? DEFAULT_ROUNDING_POLICY,
    minimum: 0,
    steps: [
      calculationStep("主属性 ÷ 2", primary / 2),
      calculationStep("副属性 ÷ 3", secondary / 3),
      calculationStep("实时技能等级 ÷ 2", skillLevel / 2),
    ],
  });
}

/** 便捷取整值，便于纯数值调用点。 */
export function skillRollMeanValue(input, options) {
  return skillRollMean(input, options).applied;
}

export function defaultInitiativeMeanValue(input, options) {
  return defaultInitiativeMean(input, options).applied;
}

export function damageMeanValue(input, options) {
  return damageMean(input, options).applied;
}
