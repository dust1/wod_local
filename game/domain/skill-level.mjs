/**
 * 技能等级的统一计算规则。
 *
 * 百分比只作用于「技能基础等级 + 受上限约束后的装备固定等级」，
 * 多个百分比逐项连乘；套装、技能和战斗效果的固定等级最后相加。
 */

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

/** 装备直接提供的固定技能等级，合计最多等于技能基础等级。 */
export function capEquipmentLevelBonus(bonus, baseLevel) {
  return Math.min(Math.max(0, finite(bonus)), Math.max(0, finite(baseLevel)));
}

/** 多个技能等级百分比逐项连乘。 */
export function skillLevelPercentMultiplier(percentages = []) {
  return percentages.reduce((multiplier, percentage) => multiplier * (1 + finite(percentage) / 100), 1);
}

/**
 * @param {object} input
 * @param {number} input.baseLevel
 * @param {number[]} [input.equipmentFlatBonuses]
 * @param {number[]} [input.percentageBonuses]
 * @param {number[]} [input.postPercentFlatBonuses]
 */
export function calculateSkillLevel(input = {}) {
  const baseLevel = Math.max(0, finite(input.baseLevel));
  const equipmentBonusRaw = (input.equipmentFlatBonuses ?? []).reduce((sum, value) => sum + finite(value), 0);
  const equipmentBonusApplied = capEquipmentLevelBonus(equipmentBonusRaw, baseLevel);
  const percentageBase = baseLevel + equipmentBonusApplied;
  const percentageBonuses = (input.percentageBonuses ?? []).map(finite);
  const percentMultiplier = skillLevelPercentMultiplier(percentageBonuses);
  const afterPercentLevel = percentageBase * percentMultiplier;
  const postPercentFlatBonus = (input.postPercentFlatBonuses ?? []).reduce((sum, value) => sum + finite(value), 0);
  const exact = Math.max(0, afterPercentLevel + postPercentFlatBonus);

  return {
    baseLevel,
    equipmentBonusRaw,
    equipmentBonusApplied,
    percentageBase,
    percentageBonuses,
    percentMultiplier,
    afterPercentLevel,
    postPercentFlatBonus,
    exact,
  };
}
