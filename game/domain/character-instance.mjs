// 角色实例。设计文档 §6、§8.6、§8.7、§9、§13、§14。
//
// 一个角色实例 = 角色自身数值 + 种族/职业天生加成 + 当前装备物品与精确件数套装的持有者效果
// + 已学技能的「作用在技能拥有者上的效果」合成后的结果。
//
// 合成规则：
//   - 分成三个累加阶段，顺序固定为 基础 → 装备 → 技能，因此
//     base + equipmentDelta + skillDelta === effective 恒成立，便于页面直接展示差值。
//   - 每个阶段内部复用 game/modifiers/pipeline.mjs 的「先乘后加」管线，不另写公式。
//   - 带 (a) 标记的效果「仅当技能/物品被实际使用时生效」，按设计文档 §9.7
//     不计入常驻数值，单独收集到 onUseOnly 中。
//
// 本模块是纯函数集合：不读文件、不接触数据库、不读系统时间。

import { ATTRIBUTE_KEYS, ATTRIBUTE_LABELS, CHARACTER_STAT_LABELS, deriveBaseCharacterStats } from "./attributes.mjs";
import {
  BASE_ATTRIBUTE_KEYS,
  GRADE_KEYS,
  GRADE_LABELS,
  groupHolderEffects,
  isGlobalScope,
  readHolderEffects,
} from "./holder-effect.mjs";
import { applyModifierPipeline } from "../modifiers/pipeline.mjs";
import { actionsFromExact, DEFAULT_ROUNDING_POLICY } from "../formulas/calculation.mjs";
import { calculateSkillLevel, capEquipmentLevelBonus } from "./skill-level.mjs";

export { capEquipmentLevelBonus } from "./skill-level.mjs";

export const INSTANCE_STAGES = Object.freeze(["base", "equipment", "skill"]);

export const DERIVED_LABELS = Object.freeze({
  ...CHARACTER_STAT_LABELS,
  fame: "荣誉",
});

export const COMBAT_BUCKETS = Object.freeze({
  armor: { label: "护甲", graded: true, keyLabel: "护甲 (r)" },
  damage: { label: "损害", graded: true, keyLabel: "损害 (r)" },
  attack: { label: "累计攻击奖励", graded: false, keyLabel: "修正" },
  defense: { label: "累计防御奖励", graded: false, keyLabel: "修正" },
  vulnerability: { label: "脆弱性", graded: true, keyLabel: "脆弱 (r)" },
});

/**
 * 角标规则：装备直接生效的技能等级加成 ≤ 技能基础等级（设计文档 §8.7）。
 * 只用于装备本体；套装、技能被动、联盟纪念碑等非装备直接来源不受该上限约束。
 */
/**
 * 修正项 → 已求值的「固定值 / 百分比」。
 * 按等级缩放的写法必须在构造修正时就用正确的上下文求值：技能来源的修正
 * 使用提供该效果的技能自身等级，装备来源使用英雄等级。
 * 求值后同时保留 origin，便于页面回溯原始写法。
 */
export function resolveTerm(term, context = {}) {
  switch (term.kind) {
    case "flat":
      return { unit: "flat", value: Number(term.value ?? 0) };
    case "percent":
      return { unit: "percent", value: Number(term.value ?? 0) };
    case "scaledFlat": {
      const scaleValue = Number(context[term.scale] ?? 0);
      return { unit: "flat", value: scaleValue * Number(term.ratio ?? 0) };
    }
    case "scaledValue":
    case "scaledPercent": { // 兼容修复前已序列化的旧结构。
      const scaleValue = Number(context[term.scale] ?? 0);
      // “25% × 英雄等级”中的百分号属于比例常量：25% × 40 = 10。
      // 求值结果是可加减的具体数值，不是再作用于目标基础值的百分比倍率。
      return { unit: "flat", value: (scaleValue * Number(term.ratio ?? 0)) / 100 };
    }
    default:
      return { unit: "flat", value: 0 };
  }
}

/**
 * 技能等级奖励求和。
 *
 * 对「技能等级」这个目标，`+50%×技能等级` 表示增加该技能等级的 50%（以等级为单位），
 * 而不是给等级加一个百分比倍率，因此这里把 flat 与按等级缩放的项统一按「等级数」相加。
 * `+技能等级` 在当前技能等级为 L 时提供 +L 级。
 */
export function sumLevelTerms(terms = [], context = {}) {
  let total = 0;
  for (const term of terms) {
    const scaleValue = Number(context[term.scale] ?? 0);
    switch (term.kind) {
      case "flat":
        total += Number(term.value ?? 0);
        break;
      case "percent":
        total += (scaleValue * Number(term.value ?? 0)) / 100;
        break;
      case "scaledFlat":
        total += scaleValue * Number(term.ratio ?? 0);
        break;
      case "scaledValue":
      case "scaledPercent":
        total += (scaleValue * Number(term.ratio ?? 0)) / 100;
        break;
      default:
        break;
    }
  }
  return total;
}

/** 一组已求值修正 → { flat, percent } 合计。 */
export function sumTerms(terms = []) {
  let flat = 0;
  let percent = 0;
  for (const term of terms) {
    const unit = term.unit ?? (term.kind === "percent" ? "percent" : "flat");
    const value = Number(term.value ?? 0);
    if (unit === "percent") percent += value;
    else flat += value;
  }
  return { flat, percent };
}

/** 「基础：剑术 类别的所有技能」→ "基础：剑术"。非类别写法返回 null。 */
export function skillCategoryPrefix(targetName) {
  const match = /^(.*?)\s*类别的所有技能$/.exec(String(targetName ?? ""));
  return match ? match[1].trim() : null;
}

/** 判断某技能是否落在「X 类别的所有技能」范围内。 */
export function matchesSkillCategory(prefix, skill) {
  if (!prefix) return false;
  const names = [skill.skillType, ...(skill.typeNames ?? []), ...(skill.skillTypeNames ?? [])].filter(Boolean).map((name) => String(name));
  return names.some((name) => name.includes(prefix) || prefix.includes(name));
}

/**
 * 构造角色实例。
 *
 * @param {object} input
 * @param {object} input.hero 角色自身数值
 * @param {number} input.hero.id
 * @param {string} [input.hero.name]
 * @param {number} input.hero.level
 * @param {object} input.hero.attributes 八项基础属性原始值
 * @param {number} [input.hero.healthRegeneration]
 * @param {number} [input.hero.manaRegeneration]
 * @param {number} [input.hero.actionsPerRoundExact]
 * @param {number} [input.hero.initiativeBonus]
 * @param {Array} [input.equippedItems] { itemId, instanceId, name, slotId, slotLabel, detail }
 * @param {Array} [input.itemSets] { setName, pieceCount, detail }
 * @param {Array} [input.skills] { sourceSkillId, skillId, name, level, skillType, typeNames, scope, detail }
 * @param {Array} [input.innateSources] { kind: "race"|"profession", id, name, detail }
 * @param {object} [input.policies] { roundingPolicy }
 */
export function createCharacterInstance(input) {
  const hero = input?.hero ?? {};
  const heroLevel = Number(hero.level ?? 1);
  const roundingPolicy = input?.policies?.roundingPolicy ?? DEFAULT_ROUNDING_POLICY;
  const warnings = [];
  const missingSources = [];

  const heroAttributes = Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => [key, Number(hero.attributes?.[key] ?? 1)]),
  );

  // ---------------------------------------------------------- 1. 收集持有者效果
  const rawEntries = [];

  for (const source of input?.innateSources ?? []) {
    if (!source?.detail) {
      missingSources.push({ kind: source?.kind ?? "innate", id: source?.id ?? null, name: source?.name ?? null, reason: "detailUnavailable" });
      continue;
    }
    const { entries, warnings: entryWarnings } = readHolderEffects(source.detail, {
      kind: source.kind,
      id: source.id,
      name: source.name,
      holderKey: "作用在角色上的效果",
    });
    rawEntries.push(...entries);
    warnings.push(...entryWarnings);
  }

  for (const item of input?.equippedItems ?? []) {
    if (!item?.detail) {
      missingSources.push({ kind: "item", id: item?.itemId ?? null, name: item?.name ?? null, reason: "detailUnavailable" });
      continue;
    }
    const { entries, warnings: entryWarnings } = readHolderEffects(item.detail, { kind: "item", id: item.itemId, name: item.name });
    for (const entry of entries) {
      rawEntries.push({ ...entry, slotId: item.slotId ?? null, slotLabel: item.slotLabel ?? null });
    }
    warnings.push(...entryWarnings);
    if (item.runeCombination && !item.runeDetail) {
      missingSources.push({ kind: "ancientRune", id: item.instanceId, name: item.runeCombination.name, reason: "detailUnavailable" });
    }
    if (item.runeDetail && item.runeCombination) {
      const runeSource = { kind: "ancientRune", id: item.instanceId,
        name: `${item.name}·${item.runeCombination.name}`, holderKey: "作用在物品持有者上的效果" };
      const runeEffects = readHolderEffects(item.runeDetail, runeSource);
      rawEntries.push(...runeEffects.entries.map((entry) => ({ ...entry, slotId: item.slotId ?? null, slotLabel: item.slotLabel ?? null })));
      warnings.push(...runeEffects.warnings);
    }
  }

  for (const itemSet of input?.itemSets ?? []) {
    if (!itemSet?.detail) {
      missingSources.push({ kind: "itemSet", id: itemSet?.setName ?? null, name: itemSet?.setName ?? null, pieceCount: itemSet?.pieceCount ?? 0, reason: "detailUnavailable" });
      continue;
    }
    const { entries, warnings: entryWarnings } = readHolderEffects(itemSet.detail, {
      kind: "itemSet",
      id: `${itemSet.setName}:${itemSet.pieceCount}`,
      name: `${itemSet.setName}（${itemSet.pieceCount}件）`,
      holderKey: "作用在装备者上的效果",
    });
    rawEntries.push(...entries);
    warnings.push(...entryWarnings);
  }

  for (const skill of input?.skills ?? []) {
    // 只有已学（等级 ≥ 1）的技能才提供拥有者效果。
    if (Number(skill?.level ?? 0) < 1) continue;
    if (!skill?.detail) {
      // 起步技能等没有详情页的技能没有拥有者效果段落，不算缺失数据。
      if (skill?.hasDetailSource !== false) {
        missingSources.push({ kind: "skill", id: skill?.sourceSkillId ?? skill?.skillId ?? null, name: skill?.name ?? null, reason: "detailUnavailable" });
      }
      continue;
    }
    const { entries, warnings: entryWarnings } = readHolderEffects(skill.detail, {
      kind: "skill",
      id: skill.sourceSkillId ?? skill.skillId,
      name: skill.name,
      holderKey: "作用在技能拥有者上的效果",
    });
    for (const entry of entries) {
      rawEntries.push({ ...entry, skill });
    }
    warnings.push(...entryWarnings);
  }

  // ---------------------------------------------------------- 2. 归类为管线修正
  let allModifiers = [];
  const onUseOnlyEntries = [];

  for (const entry of rawEntries) {
    if (entry.onUseOnly) {
      onUseOnlyEntries.push(entry);
      continue;
    }
    const sourceLabel = sourceLabelOf(entry);
    const localContext = { heroLevel, skillLevel: Number(entry.skill?.level ?? 0) };
    const common = {
      sourceKind: entry.sourceKind,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      sourceLabel,
      // pipeline 的计算步骤按 modifier.source 显示来源，这里保持一致。
      source: sourceLabel,
      category: entry.category,
      categoryId: entry.categoryId,
      bucket: entry.bucket,
      onUseOnly: false,
      damageTypeOnly: entry.damageTypeOnly,
      skillCategory: entry.skillCategory,
      attackScope: entry.attackScope,
      scaleContext: localContext,
    };

    /**
     * 推入一条修正。按等级缩放的写法在这里就落到具体数字，
     * 因此下游（管线、战斗属性表、技能等级）只会看到固定值或百分比。
     */
    const push = (term, target) => {
      const resolved = resolveTerm(term, localContext);
      allModifiers.push({
        ...common,
        kind: resolved.unit === "percent" ? "percent" : "flat",
        value: resolved.value,
        rawText: term.rawText,
        recordRawText: entry.valueText || term.rawText,
        origin: { kind: term.kind, ratio: term.ratio, scale: term.scale },
        target,
      });
    };

    if (entry.bucket === "armor" || entry.bucket === "damage" || entry.bucket === "vulnerability") {
      // 护甲/损害/脆弱性是 (r) 三元组，逐档位各生成一条修正。
      const targetType = entry.bucket === "armor" ? "armor" : entry.bucket === "damage" ? "damage" : "vulnerability";
      for (const grade of entry.grades ?? []) {
        for (const term of grade.terms) {
          push(term, { type: targetType, damageType: entry.targetName, attackType: entry.attackScope, grade: grade.grade, gradeLabel: GRADE_LABELS[grade.grade] });
        }
      }
      continue;
    }

    const targetType = {
      attribute: null,
      attack: "attackBonus",
      defense: "defenseBonus",
      skillLevel: "skill",
      skillEffect: "skillEffect",
      slotCapacity: "slotCapacity",
      dungeonLoot: "dungeonLoot",
    }[entry.bucket];

    for (const term of entry.terms) {
      if (entry.bucket === "attribute") {
        const isBase = BASE_ATTRIBUTE_KEYS.includes(entry.targetKey);
        push(term, { type: isBase ? "attribute" : "derived", key: entry.targetKey, rawKey: entry.targetName });
        continue;
      }
      push(term, { type: targetType, key: entry.bucket === "slotCapacity" ? entry.targetKey : entry.targetName });
    }
  }

  const context = { heroLevel, skillLevel: 0 };
  const isEquipmentSource = (modifier) => ["item", "itemSet", "ancientRune"].includes(modifier.sourceKind);
  const forStage = (stage) => allModifiers.filter((modifier) => {
    if (["item", "equipment"].includes(stage)) return isEquipmentSource(modifier);
    if (stage === "skill") return ["skill", "race", "profession"].includes(modifier.sourceKind);
    return modifier.sourceKind === stage;
  });
  const forTarget = (modifiers, target) => modifiers.filter((modifier) => {
    if (modifier.target.type !== target.type) return false;
    if (target.key !== undefined && modifier.target.key !== target.key) return false;
    return true;
  });

  const skillLevelParts = (skill) => {
    const baseLevel = Number(skill.level ?? 0);
    const equipmentLevelBonusRaw = Number(skill.equipmentBonus ?? 0);
    const levelModifiers = allModifiers.filter((modifier) => {
      if (modifier.target.type !== "skill") return false;
      const categoryPrefix = skillCategoryPrefix(modifier.target.key);
      if (categoryPrefix) return matchesSkillCategory(categoryPrefix, skill);
      return modifier.target.key === skill.name;
    });
    const itemLevelTerms = levelModifiers.filter((modifier) => ["item", "ancientRune"].includes(modifier.sourceKind));
    const setLevelTerms = levelModifiers.filter((modifier) => modifier.sourceKind === "itemSet");
    const skillLevelTerms = levelModifiers.filter((modifier) => ["skill", "race", "profession"].includes(modifier.sourceKind));
    const flatValue = (mods) => mods.filter((modifier) => modifier.kind !== "percent" && modifier.kind !== "globalPercent")
      .reduce((sum, modifier) => sum + Number(modifier.value ?? 0), 0);
    const percentageBonuses = levelModifiers.filter((modifier) => modifier.kind === "percent" || modifier.kind === "globalPercent")
      .map((modifier) => Number(modifier.value ?? 0));
    const itemLevelBonusRaw = flatValue(itemLevelTerms);
    const calculation = calculateSkillLevel({
      baseLevel,
      equipmentFlatBonuses: [equipmentLevelBonusRaw, itemLevelBonusRaw],
      percentageBonuses,
      postPercentFlatBonuses: [flatValue(setLevelTerms), flatValue(skillLevelTerms)],
    });
    // 兼容既有展示字段：先分配数据库装备字段，再把剩余的装备上限记到物品效果。
    const equipmentLevelBonus = Math.min(capEquipmentLevelBonus(equipmentLevelBonusRaw, baseLevel), calculation.equipmentBonusApplied);
    const itemLevelBonus = calculation.equipmentBonusApplied - equipmentLevelBonus;
    const setLevelBonus = flatValue(setLevelTerms);
    const skillLevelBonus = flatValue(skillLevelTerms);
    return {
      baseLevel,
      equipmentLevelBonusRaw,
      itemLevelBonusRaw,
      levelModifiers,
      itemLevelBonus,
      setLevelBonus,
      skillLevelBonus,
      equipmentLevelBonus,
      equipmentLevelBonusApplied: calculation.equipmentBonusApplied,
      percentageBase: calculation.percentageBase,
      percentageBonuses: calculation.percentageBonuses,
      percentMultiplier: calculation.percentMultiplier,
      afterPercentLevel: calculation.afterPercentLevel,
      postPercentFlatBonus: calculation.postPercentFlatBonus,
      liveLevel: calculation.exact,
    };
  };

  // 技能拥有者效果中的“×技能等级”必须使用完成装备、套装及技能等级奖励后的实时等级。
  // 第一遍只求实时等级，随后把技能来源的按技能等级缩放项重新落值，再计算属性与派生值。
  const liveLevelBySource = new Map();
  for (const skill of input?.skills ?? []) {
    const liveLevel = skillLevelParts(skill).liveLevel;
    liveLevelBySource.set(String(skill.sourceSkillId ?? skill.skillId ?? skill.name), liveLevel);
  }
  allModifiers = allModifiers.map((modifier) => {
    if (modifier.sourceKind !== "skill" || modifier.origin?.scale !== "skillLevel") return modifier;
    const liveLevel = liveLevelBySource.get(String(modifier.sourceId ?? modifier.sourceName));
    if (!Number.isFinite(liveLevel)) return modifier;
    const ratio = Number(modifier.origin?.ratio ?? 0);
    const value = modifier.origin.kind === "scaledValue" ? (liveLevel * ratio) / 100 : liveLevel * ratio;
    return { ...modifier, value, scaleContext: { ...modifier.scaleContext, skillLevel: liveLevel } };
  });

  // ---------------------------------------------------------- 3. 基础属性
  const attributes = ATTRIBUTE_KEYS.map((key) => {
    const base = heroAttributes[key];
    const all = forTarget(allModifiers, { type: "attribute", key });
    const equipment = forTarget(forStage("item"), { type: "attribute", key });
    const skill = forTarget(forStage("skill"), { type: "attribute", key });
    const baseStage = applyModifierPipeline(base, { modifiers: [], context });
    const equipmentStage = applyModifierPipeline(baseStage.exact, { modifiers: equipment, context });
    const skillStage = applyModifierPipeline(equipmentStage.exact, { modifiers: skill, context });
    return {
      key,
      label: ATTRIBUTE_LABELS[key],
      base,
      equipmentDelta: applyRound(equipmentStage.exact, roundingPolicy) - base,
      skillDelta: applyRound(skillStage.exact, roundingPolicy) - applyRound(equipmentStage.exact, roundingPolicy),
      effective: applyRound(skillStage.exact, roundingPolicy),
      exact: skillStage.exact,
      stageExact: { base: baseStage.exact, equipment: equipmentStage.exact, skill: skillStage.exact },
      steps: [...baseStage.steps, ...equipmentStage.steps.slice(1), ...skillStage.steps.slice(1)],
      contributors: contributorList([...equipment, ...skill]),
      modifiers: all,
    };
  });

  const effectiveAttributes = Object.fromEntries(attributes.map((entry) => [entry.key, entry.effective]));
  const rawAttributes = { ...heroAttributes };
  /** 某一合成阶段的属性快照；体力/法力上限与先攻都由它推出。 */
  const attributesAt = (stage) => Object.fromEntries(
    attributes.map((entry) => [entry.key, Math.max(1, Math.floor(entry.stageExact[stage]))]),
  );
  const baseStatDefaults = hero.baseStatDefaults ?? hero.baseStats?.defaults ?? {
    healthMax: hero.healthMaxBase,
    manaMax: hero.manaMaxBase,
    healthRegeneration: hero.healthRegenerationBase,
    manaRegeneration: hero.manaRegenerationBase,
    pocketSlots: hero.pocketSlots,
    ringSlots: hero.ringSlots,
    medalSlots: hero.medalSlots,
    actionsPerRound: hero.actionsPerRoundExact,
    initiativeBonus: hero.initiativeBonus,
  };
  const baseStatsAt = (stage) => deriveBaseCharacterStats(attributesAt(stage), baseStatDefaults);

  // ---------------------------------------------------------- 4. 派生属性
  const derivedModsFor = (key, stage) => (stage === "base"
    ? []
    : forTarget(forStage(stage), { type: "derived", key }));
  const capacityModsFor = (key, stage) => (stage === "base"
    ? []
    : forTarget(forStage(stage), { type: "slotCapacity", key }));

  /**
   * @param {(stage: string) => number} unitBaseOf 每个阶段的基础值。
   *   由属性推出的派生值，其基础值必须取该阶段的属性快照，
   *   这样「装备提升体质」之类的加持才会顺延到体力上限、先攻等派生值上。
   */
  function derivedEntry(key, label, computeFrom, unitBaseOf) {
    const baseStage = applyModifierPipeline(unitBaseOf("base"), { modifiers: [], context });
    const equipmentModifiers = derivedModsFor(key, "equipment");
    const skillModifiers = derivedModsFor(key, "skill");
    const equipmentStage = applyModifierPipeline(unitBaseOf("equipment"), { modifiers: equipmentModifiers, context });
    // 技能可能先改变八项基础属性，进而改变派生属性的基础值。最终阶段必须在这个
    // 新基础值上重新应用装备的直接派生修正，再串接技能的直接派生修正；不能只应用
    // 技能修正，否则装备提供的法力、回复、行动次数等会在最终值与战斗快照中消失。
    const skillEquipmentStage = applyModifierPipeline(unitBaseOf("skill"), { modifiers: equipmentModifiers, context });
    const skillStage = applyModifierPipeline(skillEquipmentStage.exact, { modifiers: skillModifiers, context });
    const baseValue = roundFor(key, baseStage.exact);
    return {
      key,
      label,
      base: baseValue,
      equipmentDelta: roundFor(key, equipmentStage.exact) - baseValue,
      skillDelta: roundFor(key, skillStage.exact) - roundFor(key, equipmentStage.exact),
      effective: roundFor(key, skillStage.exact),
      exact: skillStage.exact,
      steps: [...skillEquipmentStage.steps.slice(1), ...skillStage.steps.slice(1)],
      contributors: contributorList([...equipmentModifiers, ...skillModifiers]),
      computeFrom,
    };
  }

  function capacityEntry(key, label, baseKey) {
    const baseValue = baseStatsAt("base")[baseKey];
    const equipment = capacityModsFor(key, "item");
    const skill = capacityModsFor(key, "skill");
    const equipmentStage = applyModifierPipeline(baseValue, { modifiers: equipment, context });
    const skillStage = applyModifierPipeline(equipmentStage.exact, { modifiers: skill, context });
    return {
      key: baseKey, label, base: Math.max(0, Math.floor(baseValue)),
      equipmentDelta: Math.max(0, Math.floor(equipmentStage.exact)) - Math.max(0, Math.floor(baseValue)),
      skillDelta: Math.max(0, Math.floor(skillStage.exact)) - Math.max(0, Math.floor(equipmentStage.exact)),
      effective: Math.max(0, Math.floor(skillStage.exact)), exact: skillStage.exact,
      steps: [...equipmentStage.steps.slice(1), ...skillStage.steps.slice(1)], contributors: contributorList([...equipment, ...skill]), computeFrom: "baseCharacter",
    };
  }

  const derived = {
    healthMax: derivedEntry("healthMax", DERIVED_LABELS.healthMax, "attributes", (stage) => baseStatsAt(stage).healthMax),
    manaMax: derivedEntry("manaMax", DERIVED_LABELS.manaMax, "attributes", (stage) => baseStatsAt(stage).manaMax),
    healthRegeneration: derivedEntry("healthRegeneration", DERIVED_LABELS.healthRegeneration, "attributes", (stage) => baseStatsAt(stage).healthRegeneration),
    manaRegeneration: derivedEntry("manaRegeneration", DERIVED_LABELS.manaRegeneration, "attributes", (stage) => baseStatsAt(stage).manaRegeneration),
    pocketSlots: capacityEntry("pocket", DERIVED_LABELS.pocketSlots, "pocketSlots"),
    ringSlots: capacityEntry("ring", DERIVED_LABELS.ringSlots, "ringSlots"),
    medalSlots: capacityEntry("medal", DERIVED_LABELS.medalSlots, "medalSlots"),
    actionsPerRound: derivedEntry("actionsPerRound", DERIVED_LABELS.actionsPerRound, "baseCharacter", (stage) => baseStatsAt(stage).actionsPerRound),
    initiative: derivedEntry("initiative", DERIVED_LABELS.initiative, "attributes", (stage) => baseStatsAt(stage).initiative),
    fame: derivedEntry("fame", DERIVED_LABELS.fame, "hero", () => Number(hero.fame ?? 0)),
    allianceFame: derivedEntry("allianceFame", DERIVED_LABELS.allianceFame, "hero", () => Number(hero.allianceFame ?? 999999)),
  };

  // ---------------------------------------------------------- 5. 技能等级与技能效果
  const skills = (input?.skills ?? []).map((skill) => {
    const parts = skillLevelParts(skill);
    const { baseLevel, equipmentLevelBonusRaw, itemLevelBonusRaw, levelModifiers, itemLevelBonus, setLevelBonus, skillLevelBonus, equipmentLevelBonus, equipmentLevelBonusApplied, percentageBase, percentageBonuses, percentMultiplier, afterPercentLevel, postPercentFlatBonus, liveLevel } = parts;

    const effectModifiers = allModifiers.filter((modifier) => {
      if (modifier.target.type !== "skillEffect") return false;
      const categoryPrefix = skillCategoryPrefix(modifier.target.key);
      if (categoryPrefix) return matchesSkillCategory(categoryPrefix, skill);
      return modifier.target.key === skill.name;
    });

    return {
      skillId: skill.skillId ?? null,
      sourceSkillId: skill.sourceSkillId ?? null,
      name: skill.name,
      scope: skill.scope ?? null,
      baseLevel,
      equipmentLevelBonus,
      equipmentLevelBonusRaw,
      equipmentLevelBonusApplied,
      itemLevelBonusRaw,
      itemLevelBonus,
      setLevelBonus,
      skillLevelBonus,
      percentageBase,
      percentageBonuses,
      percentMultiplier,
      afterPercentLevel,
      postPercentFlatBonus,
      liveLevel,
      levelDelta: liveLevel - baseLevel,
      levelSources: contributorList(levelModifiers),
      effectBonuses: groupByTarget(effectModifiers),
      onUseOnlyLevelSources: onUseOnlyEntries
        .filter((entry) => entry.bucket === "skillLevel" && matchesTarget(entry, skill))
        .map((entry) => ({ sourceLabel: sourceLabelOf(entry), rawText: entry.terms.map((term) => term.rawText).join(" ") })),
    };
  });

  // ---------------------------------------------------------- 6. 战斗属性
  const combat = buildCombatTables(allModifiers);

  // ---------------------------------------------------------- 7. 未纳入常驻的 (a) 效果
  const onUseOnly = groupOnUseOnly(onUseOnlyEntries, heroLevel);

  return {
    heroId: hero.id ?? null,
    heroName: hero.name ?? null,
    heroLevel,
    stageOrder: INSTANCE_STAGES,
    attributes,
    effectiveAttributes,
    derived,
    combat,
    skills,
    modifiers: allModifiers,
    sources: rawEntries.map((entry) => ({
      sourceKind: entry.sourceKind,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      category: entry.category,
      bucket: entry.bucket,
      targetName: entry.targetName,
      targetKey: entry.targetKey,
      attackScope: entry.attackScope,
      rawText: entry.grades
        ? entry.grades.map((grade) => `${GRADE_LABELS[grade.grade]} ${grade.terms.map((term) => term.rawText).join(" ") || "—"}`).join(" / ")
        : entry.terms.map((term) => term.rawText).join(" "),
    })),
    onUseOnly,
    missingSources,
    unsupportedTargets: warnings.filter((warning) => warning.startsWith("未映射")),
    warnings,
    roundingPolicy,
    /** 供 deriveUnit / effectiveSkillLevelOf 直接当作 effectLedger 使用。 */
    modifiersFor() {
      return allModifiers;
    },
    modifiersForSkillLevel(skillId) {
      return allModifiers.filter((modifier) => modifier.target.type === "skill" && modifier.target.key === skillId);
    },
  };
}

function matchesTarget(entry, skill) {
  const categoryPrefix = skillCategoryPrefix(entry.targetName);
  if (categoryPrefix) return matchesSkillCategory(categoryPrefix, skill);
  return entry.targetName === skill.name;
}

function sourceLabelOf(source) {
  if (source.sourceKind === "item") return `装备：${source.sourceName}`;
  if (source.sourceKind === "ancientRune") return `传古符文：${source.sourceName}`;
  if (source.sourceKind === "itemSet") return `套装：${source.sourceName}`;
  if (source.sourceKind === "race") return `种族：${source.sourceName}`;
  if (source.sourceKind === "profession") return `职业：${source.sourceName}`;
  return `技能：${source.sourceName}`;
}

function applyRound(value, roundingPolicy) {
  return Math.max(1, roundingPolicy?.round?.(value) ?? Math.floor(value));
}

/** 上限/回复量只允许非负；先攻与行动次数走各自取整。 */
function roundFor(key, value) {
  switch (key) {
    case "healthMax":
    case "manaMax":
    case "healthRegeneration":
    case "manaRegeneration":
      return Math.max(0, Math.floor(value));
    case "actionsPerRound":
      return actionsFromExact(value, DEFAULT_ROUNDING_POLICY);
    case "initiative":
    case "fame":
    case "allianceFame":
      return Math.floor(value);
    default:
      return Math.floor(value);
  }
}

function contributorList(modifiers) {
  const seen = new Map();
  for (const modifier of modifiers) {
    const key = `${modifier.sourceKind}|${modifier.sourceId}|${modifier.sourceLabel}|${modifier.rawText}|${modifier.target?.gradeLabel ?? ""}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      sourceKind: modifier.sourceKind,
      sourceId: modifier.sourceId,
      sourceName: modifier.sourceName,
      sourceLabel: modifier.sourceLabel,
      category: modifier.category,
      rawText: modifier.rawText,
      grade: modifier.target?.gradeLabel ?? null,
      damageType: modifier.target?.damageType ?? null,
      attackType: modifier.target?.attackType ?? null,
    });
  }
  return [...seen.values()];
}

function groupByTarget(modifiers) {
  const groups = new Map();
  for (const modifier of modifiers) {
    const key = modifier.target.key;
    if (!groups.has(key)) {
      groups.set(key, { targetName: key, terms: [], sources: [], total: { flat: 0, percent: 0 } });
    }
    const group = groups.get(key);
    group.terms.push({ unit: modifier.kind === "percent" ? "percent" : "flat", value: modifier.value });
    group.sources.push({ sourceKind: modifier.sourceKind, sourceId: modifier.sourceId,
      sourceLabel: modifier.sourceLabel, rawText: modifier.recordRawText ?? modifier.rawText });
  }
  for (const group of groups.values()) group.total = sumTerms(group.terms);
  return [...groups.values()];
}

function groupOnUseOnly(entries, heroLevel) {
  return entries.map((entry) => {
    const context = { heroLevel, skillLevel: Number(entry.skill?.level ?? 0) };
    const summarize = (terms) => sumTerms(terms.map((term) => resolveTerm(term, context)));
    const gradeTotals = entry.grades?.map((grade) => ({ grade: grade.grade, ...summarize(grade.terms) })) ?? null;
    const total = gradeTotals ? null : summarize(entry.terms);
    return {
      sourceKind: entry.sourceKind,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      category: entry.category,
      bucket: entry.bucket,
      targetName: entry.targetName,
      attackScope: entry.attackScope,
      total,
      grades: gradeTotals ? Object.fromEntries(gradeTotals.map(({ grade, ...value }) => [grade, value])) : null,
      values: gradeTotals?.map((grade) => grade.flat) ?? null,
      percents: gradeTotals?.map((grade) => grade.percent) ?? null,
      text: gradeTotals?.map((grade) => formatValue(grade.flat, grade.percent)).join(" / ")
        ?? formatValue(total.flat, total.percent),
      rawText: entry.grades
        ? entry.grades.map((grade) => grade.terms.map((term) => term.rawText).join(" ")).filter(Boolean).join(" / ")
        : entry.terms.map((term) => term.rawText).join(" "),
    };
  });
}

/**
 * 战斗属性表：护甲 / 损害 / 攻击奖励 / 防御奖励 / 脆弱性。
 * 逐行按 目标名 + 攻击方式 聚合，护甲与损害保留 (r) 三档位。
 * 传入的修正必须已经求值（见 createCharacterInstance 的 push）。
 */
export function buildCombatTables(modifiers) {
  const graded = { armor: [], damage: [], vulnerability: [] };
  const gradedIndex = { armor: new Map(), damage: new Map(), vulnerability: new Map() };
  const bonus = { attack: new Map(), defense: new Map(), slotCapacity: new Map(), dungeonLoot: new Map() };

  for (const modifier of modifiers) {
    const { target } = modifier;
    const value = Number(modifier.value ?? 0);
    const isPercent = modifier.kind === "percent";
    if (target.type === "armor" || target.type === "damage" || target.type === "vulnerability") {
      const rowKey = `${target.damageType ?? "所有"}|${target.attackType ?? "所有"}`;
      if (!gradedIndex[target.type].has(rowKey)) {
        const row = {
          damageType: target.damageType ?? "所有",
          attackType: target.attackType ?? "所有",
          grades: Object.fromEntries(GRADE_KEYS.map((grade) => [grade, { flat: 0, percent: 0, percentTerms: [] }])),
          sources: [],
        };
        gradedIndex[target.type].set(rowKey, row);
        graded[target.type].push(row);
      }
      const row = gradedIndex[target.type].get(rowKey);
      const grade = target.grade ?? "normal";
      if (isPercent) {
        row.grades[grade].percent += value;
        row.grades[grade].percentTerms.push(value);
      }
      else row.grades[grade].flat += value;
      row.sources.push({ sourceKind: modifier.sourceKind, sourceId: modifier.sourceId,
        sourceLabel: modifier.sourceLabel, category: modifier.category, rawText: modifier.recordRawText ?? modifier.rawText, grade: target.gradeLabel ?? null });
      continue;
    }

    if (target.type === "attackBonus" || target.type === "defenseBonus" || target.type === "slotCapacity" || target.type === "dungeonLoot") {
      const bucketKey = { attackBonus: "attack", defenseBonus: "defense", slotCapacity: "slotCapacity", dungeonLoot: "dungeonLoot" }[target.type];
      const label = target.key ?? "—";
      if (!bonus[bucketKey].has(label)) bonus[bucketKey].set(label, { label, flat: 0, percent: 0, sources: [] });
      const row = bonus[bucketKey].get(label);
      if (isPercent) row.percent += value;
      else row.flat += value;
      row.sources.push({ sourceLabel: modifier.sourceLabel, category: modifier.category, rawText: modifier.recordRawText ?? modifier.rawText });
    }
  }

  const finalizeGraded = (rows) => rows.map((row) => {
    const values = GRADE_KEYS.map((grade) => row.grades[grade].flat);
    const percents = GRADE_KEYS.map((grade) => row.grades[grade].percent);
    return {
      damageType: row.damageType,
      attackType: row.attackType,
      values,
      percents,
      percentTerms: GRADE_KEYS.map((grade) => [...row.grades[grade].percentTerms]),
      text: values.map((value, index) => formatValue(value, percents[index])).join(" / "),
      sources: dedupeSources(row.sources),
    };
  });

  return {
    armor: finalizeGraded(graded.armor),
    damage: finalizeGraded(graded.damage),
    vulnerability: finalizeGraded(graded.vulnerability),
    attackBonuses: [...bonus.attack.values()].map(finalizeBonus),
    defenseBonuses: [...bonus.defense.values()].map(finalizeBonus),
    slotCapacities: [...bonus.slotCapacity.values()].map(finalizeBonus),
    dungeonLoot: [...bonus.dungeonLoot.values()].map(finalizeBonus),
  };
}

/**
 * 同一来源的同一条原始写法只保留一次。
 * (r) 三档位会让同一条效果按档位各生成一条修正，来源列表按来源去重即可，
 * 档位差异已经体现在行的 values 里。
 */
function dedupeSources(sources) {
  const seen = new Map();
  for (const source of sources) {
    const key = `${source.sourceKind}|${source.sourceId}|${source.sourceLabel}|${source.category}|${source.rawText ?? ""}`;
    if (!seen.has(key)) seen.set(key, source);
  }
  return [...seen.values()];
}

function finalizeBonus(row) {
  return { label: row.label, flat: row.flat, percent: row.percent, sources: dedupeSources(row.sources) };
}

function formatValue(flat, percent) {
  const parts = [];
  if (flat !== 0 || percent === 0) parts.push(`${flat > 0 ? "+" : ""}${round(flat)}`);
  if (percent !== 0) parts.push(`${percent > 0 ? "+" : ""}${round(percent)}%`);
  return parts.join(" ");
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export { isGlobalScope };
