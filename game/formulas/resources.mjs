// 体力和法力上限、当前值合法化。设计文档 §13.1、§13.2。
import { calculationStep, calculatedNumber, DEFAULT_ROUNDING_POLICY } from "./calculation.mjs";
import { deriveBaseCharacterStats } from "../domain/attributes.mjs";

/** 体力上限 = 基础体力 1 + 体质 × 3 + 力量 × 2。 */
export function healthMax({ constitution = 0, strength = 0 }, options = {}) {
  const result = deriveBaseCharacterStats({ constitution, strength });
  const exact = result.healthMax;
  return calculatedNumber(exact, {
    roundingPolicy: options.roundingPolicy ?? DEFAULT_ROUNDING_POLICY,
    minimum: 0,
    steps: [
      calculationStep("基础体力", 1),
      calculationStep("体质 × 3", constitution * 3),
      calculationStep("力量 × 2", strength * 2),
    ],
  });
}

/** 法力上限 = 基础法力 1 + 意志 × 3 + 智力 × 2。 */
export function manaMax({ willpower = 0, intelligence = 0 }, options = {}) {
  const result = deriveBaseCharacterStats({ willpower, intelligence });
  const exact = result.manaMax;
  return calculatedNumber(exact, {
    roundingPolicy: options.roundingPolicy ?? DEFAULT_ROUNDING_POLICY,
    minimum: 0,
    steps: [
      calculationStep("基础法力", 1),
      calculationStep("意志 × 3", willpower * 3),
      calculationStep("智力 × 2", intelligence * 2),
    ],
  });
}

/** 便捷取整值。 */
export function healthMaxValue(attributes, options) {
  return healthMax(attributes, options).applied;
}

export function manaMaxValue(attributes, options) {
  return manaMax(attributes, options).applied;
}

/**
 * 用“累计伤害债务”表达当前资源，便于上限下降时重新判定击倒。
 * 文档 §13.2：currentHp = maxHp - accumulatedDamage + accumulatedHealing。
 */
export function resourceFromDebt({ max, accumulatedDamage = 0, accumulatedHealing = 0 }) {
  const exact = max - accumulatedDamage + accumulatedHealing;
  return { exact, applied: Math.floor(exact) };
}

/**
 * 上限变化后的合法化。
 * 体力：累计伤害超过新上限 → 击倒（不能简单裁剪当前值）。
 * 法力：最低降到 0，不产生击倒。
 */
export function legalizeResourceAfterMaxChange({ resourceKind, newMax, accumulatedDamage = 0, accumulatedHealing = 0 }) {
  const { exact, applied } = resourceFromDebt({ max: newMax, accumulatedDamage, accumulatedHealing });
  if (resourceKind === "mana") {
    return {
      exact,
      current: Math.max(0, applied),
      knockedDown: false,
      clamped: exact < 0,
    };
  }
  return {
    exact,
    current: Math.max(0, applied),
    knockedDown: exact <= 0,
    clamped: exact < 0,
  };
}

/**
 * 自然回复。体力传入 max 时不得超过上限；法力没有上限，因此不传 max。
 * 负回复表现为资源流失。
 * 文档 §11.4。
 */
export function applyRegeneration({ current, max, regeneration }) {
  const exact = current + regeneration;
  if (regeneration >= 0) {
    const hasMaximum = Number.isFinite(max);
    return {
      exact,
      current: hasMaximum ? Math.min(max, Math.floor(exact)) : Math.floor(exact),
      clampedByMax: hasMaximum && exact > max,
    };
  }
  return { exact, current: Math.max(0, Math.floor(exact)), clampedByMax: false };
}
