// 法力消耗。设计文档 §8.5、§25.9。
// 实际法力消耗 = (0.8 + 0.1 × 实时技能等级) × 标准法力消耗
// 取整时点尚未确认，必须由 ManaCostRoundingPolicy 注入。

import { calculationStep, calculatedNumber, DEFAULT_ROUNDING_POLICY } from "./calculation.mjs";

/** 系数，不取整。 */
export function manaCostFactor(skillLevel) {
  return 0.8 + 0.1 * skillLevel;
}

/**
 * @param {object} input
 * @param {number} input.standardCost 标准法力消耗
 * @param {number} input.skillLevel 实时技能等级
 * @param {object} [options]
 * @param {object} [options.roundingPolicy] 取整策略（ManaCostRoundingPolicy）
 */
export function manaCost({ standardCost = 0, skillLevel = 0 }, options = {}) {
  const factor = manaCostFactor(skillLevel);
  const exact = factor * standardCost;
  return calculatedNumber(exact, {
    roundingPolicy: options.roundingPolicy ?? DEFAULT_ROUNDING_POLICY,
    minimum: 0,
    steps: [
      calculationStep("系数 0.8 + 0.1 × 实时技能等级", factor, `${skillLevel} 级`),
      calculationStep("标准法力消耗", standardCost),
    ],
  });
}

export function manaCostValue(input, options) {
  return manaCost(input, options).applied;
}

/**
 * 装备直接生效的技能等级加成 ≤ 技能基础等级。文档 §8.7。
 * 套装、技能被动、联盟纪念碑及其他非装备直接来源不受该限制。
 */
export function equipmentSkillLevelBonus(baseLevel, rawBonus) {
  if (rawBonus <= 0) return 0;
  return Math.min(rawBonus, Math.max(0, baseLevel));
}

/** 实时技能等级 = 基础等级 + 装备加成（受上限约束）+ 其他来源加成。 */
export function effectiveSkillLevel({ baseLevel = 0, equipmentBonus = 0, otherBonus = 0 }) {
  const cappedEquipment = equipmentSkillLevelBonus(baseLevel, equipmentBonus);
  return {
    applied: Math.max(0, baseLevel + cappedEquipment + otherBonus),
    equipmentBonus: cappedEquipment,
    cappedEquipment: equipmentBonus > cappedEquipment,
    steps: [
      calculationStep("基础等级", baseLevel),
      calculationStep("装备加成（受上限约束）", cappedEquipment),
      calculationStep("其他来源加成", otherBonus),
    ],
  };
}
