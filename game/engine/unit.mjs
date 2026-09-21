// 战斗单位与派生属性。设计文档 §6、§13、§15、§16。
import { ATTRIBUTE_KEYS, ATTRIBUTE_LABELS, composeAttribute, deriveBaseCharacterStats } from "../domain/attributes.mjs";
import { applyRegeneration } from "../formulas/resources.mjs";
import { damageMean, skillRollMean } from "../formulas/rolls.mjs";
import { manaCost } from "../formulas/mana-cost.mjs";
import { applyModifierPipeline } from "../modifiers/pipeline.mjs";
import { actionsFromExact, DEFAULT_ROUNDING_POLICY } from "../formulas/calculation.mjs";

export const UNIT_KINDS = Object.freeze(["hero", "monster", "summon"]);

/**
 * 创建战斗单位。
 * @param {object} input
 */
export function createUnit(input) {
  if (!input?.id) throw new Error("单位缺少 id");
  if (!input?.side) throw new Error(`单位 ${input.id} 缺少 side`);
  const attributes = {};
  for (const key of ATTRIBUTE_KEYS) attributes[key] = Number(input.attributes?.[key] ?? 1);

  const skills = {};
  for (const [skillId, skill] of Object.entries(input.skills ?? {})) {
    skills[skillId] = {
      baseLevel: Number(skill.baseLevel ?? skill.level ?? 0),
      equipmentBonus: Number(skill.equipmentBonus ?? 0),
      otherBonus: Number(skill.otherBonus ?? 0),
    };
  }

  return {
    id: input.id,
    name: input.name ?? input.id,
    side: input.side,
    kind: input.kind ?? "hero",
    level: Number(input.level ?? 1),
    position: input.position ?? "front",
    attributes,
    baseStats: input.baseStats ?? null,
    baseStatDefaults: input.baseStatDefaults ?? input.baseStats?.defaults ?? null,
    skills,
    health: input.health ?? null,
    mana: input.mana ?? null,
    healthRegeneration: Number(input.healthRegeneration ?? 0),
    manaRegeneration: Number(input.manaRegeneration ?? 0),
    actionsPerRoundExact: input.actionsPerRoundExact ?? 1,
    initiativeBonus: Number(input.initiativeBonus ?? 0),
    defenseSkillId: input.defenseSkillId ?? null,
    defaultDefenseSkillId: input.defaultDefenseSkillId ?? null,
    summonUpkeep: input.summonUpkeep ?? null,
    summonerId: input.summonerId ?? null,
    summonCreatedRound: input.summonCreatedRound ?? null,
    summonCreatedPhase: input.summonCreatedPhase ?? null,
    equipment: input.equipment ?? [],
    combat: input.combat ?? { armor: [], damage: [], vulnerability: [], attackBonuses: [], defenseBonuses: [] },
    onUseOnly: input.onUseOnly ?? [],
    alive: input.alive !== false,
    present: input.present !== false,
    defeatedAtRound: input.defeatedAtRound ?? null,
    escaped: false,
    notes: [],
  };
}

/** 效果修正按目标过滤。 */
export function modifiersForTarget(modifiers, target) {
  return modifiers.filter((modifier) => {
    if (!modifier.target) return false;
    if (modifier.target.type !== target.type) return false;
    if (target.key !== undefined && modifier.target.key !== target.key) return false;
    if (target.damageType !== undefined && modifier.target.damageType !== target.damageType) return false;
    return true;
  });
}

/**
 * 计算单位当前派生属性。所有输入显式传入，不读取系统时间或全局状态。
 */
export function deriveUnit(unit, options = {}) {
  const roundingPolicy = options.roundingPolicy ?? DEFAULT_ROUNDING_POLICY;
  const ledger = options.effectLedger;
  const allModifiers = ledger ? ledger.modifiersFor(unit.id) : [];

  const attributes = {};
  const attributeTraces = {};
  for (const key of ATTRIBUTE_KEYS) {
    const target = { type: "attribute", key };
    const mods = modifiersForTarget(allModifiers, target);
    const result = applyModifierPipeline(unit.attributes[key], { modifiers: mods, context: { heroLevel: unit.level } });
    attributes[key] = result.exact;
    attributeTraces[key] = {
      base: unit.attributes[key],
      exact: result.exact,
      applied: Math.max(1, Math.floor(result.exact)),
      steps: result.steps,
      modifiers: mods,
    };
  }

  const appliedAttributes = Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, Math.max(1, Math.floor(value))]),
  );

  const baseStats = deriveBaseCharacterStats(appliedAttributes, unit.baseStatDefaults ?? {});
  const healthMaxResult = calculatedFromBaseStat(baseStats.healthMax, baseStats.traces.healthMax, roundingPolicy);
  const manaMaxResult = calculatedFromBaseStat(baseStats.manaMax, baseStats.traces.manaMax, roundingPolicy);

  const healthMaxMods = modifiersForTarget(allModifiers, { type: "derived", key: "healthMax" });
  const manaMaxMods = modifiersForTarget(allModifiers, { type: "derived", key: "manaMax" });
  const healthMaxFinal = applyModifierPipeline(healthMaxResult.exact, { modifiers: healthMaxMods });
  const manaMaxFinal = applyModifierPipeline(manaMaxResult.exact, { modifiers: manaMaxMods });

  const regenMods = (key) => modifiersForTarget(allModifiers, { type: "derived", key });
  const healthRegeneration = applyModifierPipeline(baseStats.healthRegeneration, { modifiers: regenMods("healthRegeneration") }).exact;
  const manaRegeneration = applyModifierPipeline(baseStats.manaRegeneration, { modifiers: regenMods("manaRegeneration") }).exact;

  const actionMods = modifiersForTarget(allModifiers, { type: "derived", key: "actionsPerRound" });
  const actionsExact = applyModifierPipeline(baseStats.actionsPerRound, { modifiers: actionMods }).exact;

  const initiativeMods = modifiersForTarget(allModifiers, { type: "derived", key: "initiative" });
  const initiativeFormulaBase = appliedAttributes.agility * 2 + appliedAttributes.perception;
  const initiativeBase = calculatedFromBaseStat(initiativeFormulaBase, baseStats.traces.initiative, roundingPolicy);
  const initiativePipeline = applyModifierPipeline(initiativeBase.exact, {
    modifiers: initiativeMods,
    context: { heroLevel: unit.level },
  });
  // 先攻的公式部分先受百分比修正并进入骰池；直接固定加值在投点后追加。
  const initiativeRollMean = initiativeFormulaBase * initiativePipeline.percentMultiplier * initiativePipeline.globalMultiplier;
  const initiativeHardBonus = baseStats.initiativeBonus + initiativePipeline.flatTotal;
  const initiativeExact = initiativeRollMean + initiativeHardBonus;

  const capacity = (key, baseKey) => Math.max(0, Math.floor(applyModifierPipeline(baseStats[baseKey], {
    modifiers: modifiersForTarget(allModifiers, { type: "slotCapacity", key }),
    context: { heroLevel: unit.level },
  }).exact));

  return {
    unitId: unit.id,
    attributes: appliedAttributes,
    attributeTraces,
    healthMax: Math.max(0, Math.floor(healthMaxFinal.exact)),
    manaMax: Math.max(0, Math.floor(manaMaxFinal.exact)),
    healthRegeneration,
    manaRegeneration,
    actionsExact,
    actions: actionsFromExact(actionsExact, roundingPolicy),
    initiativeExact,
    initiative: Math.floor(initiativeExact),
    initiativeRollMean,
    initiativeHardBonus,
    initiativePercentMultiplier: initiativePipeline.percentMultiplier * initiativePipeline.globalMultiplier,
    pocketSlots: capacity("pocket", "pocketSlots"),
    ringSlots: capacity("ring", "ringSlots"),
    medalSlots: capacity("medal", "medalSlots"),
    traces: {
      healthMax: { ...healthMaxResult, exact: healthMaxFinal.exact, steps: [...healthMaxResult.steps, ...healthMaxFinal.steps] },
      manaMax: { ...manaMaxResult, exact: manaMaxFinal.exact, steps: [...manaMaxResult.steps, ...manaMaxFinal.steps] },
      initiative: { exact: initiativeExact, steps: [...initiativeBase.steps, ...initiativePipeline.steps] },
    },
  };
}

function calculatedFromBaseStat(exact, steps, roundingPolicy) {
  return { exact, applied: roundingPolicy.round(exact), steps: [...steps, { label: "取整", value: roundingPolicy.round(exact) }], roundingPolicyId: roundingPolicy.id };
}

/** 实时技能等级（装备加成受上限约束）。 */
export function effectiveSkillLevelOf(unit, skillId, options = {}) {
  const entry = unit.skills?.[skillId];
  if (!entry) return 0;
  const ledger = options.effectLedger;
  const skill = options.skill;
  const mods = ledger ? ledger.modifiersFor(unit.id).filter((modifier) => {
    if (modifier.target?.type !== "skill") return false;
    if (modifier.target.key === skillId) return true;
    const category = /^(.*?)\s*类别的所有技能$/.exec(String(modifier.target.key ?? ""))?.[1]?.trim();
    return Boolean(category && (skill?.skillTypeNames ?? []).some((name) => String(name).includes(category) || category.includes(String(name))));
  }) : [];
  const base = entry.baseLevel;
  const equipmentBonus = Math.min(Math.max(0, entry.equipmentBonus), Math.max(0, base));
  const otherBonus = entry.otherBonus + mods.reduce((sum, modifier) => {
    const value = Number(modifier.value ?? 0);
    return sum + (modifier.kind === "percent" || modifier.kind === "globalPercent" ? base * value / 100 : value);
  }, 0);
  return Math.max(0, base + equipmentBonus + otherBonus);
}

/** 攻击/防御/伤害的平均值，全部使用实时技能等级。 */
export function skillMeans(unit, skill, options = {}) {
  const level = effectiveSkillLevelOf(unit, skill.id, { ...options, skill });
  const derived = options.derived ?? deriveUnit(unit, options);
  const pick = (binding) => {
    if (!binding) return 0;
    return derived.attributes[binding.primary] ?? 0;
  };
  const attackBinding = skill.attributeFormula?.attack;
  const defenseBinding = skill.attributeFormula?.defense;
  const damageBinding = skill.attributeFormula?.damage;
  const initiativeBinding = skill.attributeFormula?.initiative;
  return {
    skillLevel: level,
    attackMean: attackBinding
      ? skillRollMean({ primary: pick(attackBinding), secondary: derived.attributes[attackBinding.secondary] ?? 0, skillLevel: level }, options)
      : null,
    defenseMean: defenseBinding
      ? skillRollMean({ primary: pick(defenseBinding), secondary: derived.attributes[defenseBinding.secondary] ?? 0, skillLevel: level }, options)
      : null,
    damageMean: damageBinding
      ? damageMean({ primary: pick(damageBinding), secondary: derived.attributes[damageBinding.secondary] ?? 0, skillLevel: level }, options)
      : null,
    initiativeMean: initiativeBinding
      ? skillRollMean({ primary: pick(initiativeBinding), secondary: derived.attributes[initiativeBinding.secondary] ?? 0, skillLevel: level }, options)
      : null,
  };
}

export function skillManaCost(unit, skill, options = {}) {
  if (!skill.manaCost) return null;
  const level = effectiveSkillLevelOf(unit, skill.id, { ...options, skill });
  return manaCost({ standardCost: skill.manaCost.standard ?? skill.manaCost.display ?? 0, skillLevel: level }, options);
}

/** 自然回复，正回复不得超过上限。 */
export function regenerate(unit, derived) {
  const health = applyRegeneration({ current: unit.health, max: derived.healthMax, regeneration: derived.healthRegeneration });
  const mana = applyRegeneration({ current: unit.mana, max: derived.manaMax, regeneration: derived.manaRegeneration });
  return { health, mana };
}

export function attributeLabel(key) {
  return ATTRIBUTE_LABELS[key] ?? key;
}

export function composeAttributeValue(layers) {
  return composeAttribute(layers);
}
