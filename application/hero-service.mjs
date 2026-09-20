// 英雄用例：把持久化行转换为领域单位，并给出派生属性与技能明细。
import { createUnit, deriveUnit, effectiveSkillLevelOf, skillMeans, skillManaCost } from "../game/engine/unit.mjs";
import { ATTRIBUTE_KEYS, ATTRIBUTE_LABELS, createBaseCharacter } from "../game/domain/attributes.mjs";
import { POSITION_LABELS } from "../game/domain/positions.mjs";
import { BASE_TYPE_LABELS } from "../game/domain/skill.mjs";
import { assessWounds, WOUND_LABELS } from "../game/commands/healing.mjs";
import { createBattlePlan, resolveFloorPlan } from "../game/commands/battle-plan.mjs";
import { attributeTrainingRangeChange, heroExperienceProgress, skillTrainingChange } from "../game/formulas/training-cost.mjs";
import { ADVANCED_PROFESSIONS, ADVANCEMENT_EXPERIENCE_COST, ADVANCEMENT_GOLD_COST, ADVANCEMENT_LEVEL } from "../game/domain/advanced-profession.mjs";
import { skillItemRequirementFor } from "./skill-item-service.mjs";

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function heroRowToUnit(row, options = {}) {
  const baseCharacter = createBaseCharacter(row, {
    healthMax: options.healthMax,
    manaMax: options.manaMax,
    healthRegeneration: options.healthRegeneration,
    manaRegeneration: options.manaRegeneration,
    pocketSlots: options.pocketSlots,
    ringSlots: options.ringSlots,
    medalSlots: options.medalSlots,
    actionsPerRound: options.actionsPerRoundExact,
    initiativeBonus: options.initiativeBonus,
  });
  const attributes = baseCharacter.attributes;
  const skills = {};
  for (const entry of options.heroSkills ?? []) {
    skills[entry.skill_id] = { baseLevel: entry.base_level, equipmentBonus: entry.equipment_bonus };
  }
  const unit = createUnit({
    id: String(row.id),
    name: row.name,
    side: "attacker",
    kind: "hero",
    level: Number(row.level ?? 1),
    position: options.position ?? "front",
    attributes,
    skills,
    baseStats: baseCharacter.baseStats,
    baseStatDefaults: baseCharacter.baseStats.defaults,
    healthRegeneration: baseCharacter.baseStats.healthRegeneration,
    manaRegeneration: baseCharacter.baseStats.manaRegeneration,
    actionsPerRoundExact: baseCharacter.baseStats.actionsPerRound,
    initiativeBonus: baseCharacter.baseStats.initiativeBonus,
  });
  const derived = deriveUnit(unit, options);
  unit.health = options.health ?? derived.healthMax;
  unit.mana = options.mana ?? derived.manaMax;
  return unit;
}

/** 没有角色实例时使用的空战斗属性表，避免退回硬编码数值。 */
export function emptyCombatTables() {
  return {
    armor: [], damage: [], vulnerability: [],
    attackBonuses: [], defenseBonuses: [], slotCapacities: [], dungeonLoot: [],
  };
}

/**
 * 英雄详情 DTO，供 /api/heroes/:id 使用。
 *
 * 角色实例由调用方（server.mjs）组装后经 options.instance 传入；传入后
 * 属性、派生属性、战斗属性、技能等级全部改用实例的「基础值 + 装备/技能加持」结果。
 * 未传入时退回不带加持的裸数值，并在 effectSummary.instanceApplied 中标注，
 * 不会静默展示成有加成。
 */
export function heroDetailDto(repository, heroId, catalog, userId, options = {}) {
  const row = repository.getHero(heroId, userId);
  if (!row) return null;
  const heroSkills = repository.listHeroSkills(heroId);
  const unit = heroRowToUnit(row, { heroSkills });
  const baseline = deriveUnit(unit);
  const instance = options.instance ?? null;
  const heroLevel = Number(row.level ?? 1);
  const wounds = assessWounds({ current: unit.health, max: instance?.derived.healthMax.effective ?? baseline.healthMax });
  const combatAttributes = instance?.combat ?? emptyCombatTables();
  const instanceAttributes = new Map((instance?.attributes ?? []).map((entry) => [entry.key, entry]));
  const instanceDerived = instance?.derived ?? null;

  const attributes = ATTRIBUTE_KEYS.map((key) => {
    const fromInstance = instanceAttributes.get(key);
    const base = Number(row[key] ?? 1);
    return {
      key,
      label: ATTRIBUTE_LABELS[key],
      base,
      equipmentDelta: fromInstance?.equipmentDelta ?? 0,
      skillDelta: fromInstance?.skillDelta ?? 0,
      effective: fromInstance?.effective ?? baseline.attributes[key],
      exact: fromInstance?.exact ?? baseline.attributeTraces[key]?.exact ?? base,
      steps: fromInstance?.steps ?? baseline.attributeTraces[key]?.steps ?? [],
      contributors: fromInstance?.contributors ?? [],
    };
  });

  const instanceSkills = new Map((instance?.skills ?? []).map((entry) => [entry.name, entry]));
  // 行动设置里的「调用物品」下拉框候选：技能「物品」字段 ∩ 当前已装备物品的类别。
  const equippedItems = instance?.equippedItems ?? [];
  const skills = heroSkills.map((entry) => {
    const definition = catalog?.skills?.get(entry.skill_id) ?? null;
    const liveLevel = effectiveSkillLevelOf(unit, entry.skill_id);
    const means = definition ? skillMeans(unit, definition, { derived: baseline }) : null;
    const cost = definition ? skillManaCost(unit, definition, {}) : null;
    const name = definition?.name ?? entry.skill_name;
    const boosted = instanceSkills.get(name) ?? null;
    return {
      skillId: entry.skill_id,
      name,
      baseType: definition?.baseType ?? entry.base_type,
      baseTypeLabel: BASE_TYPE_LABELS[definition?.baseType ?? entry.base_type] ?? entry.base_type,
      attackType: definition?.attackType ?? entry.attack_type,
      baseLevel: entry.base_level,
      equipmentBonus: entry.equipment_bonus,
      liveLevel: boosted?.liveLevel ?? liveLevel,
      levelSources: boosted?.levelSources ?? [],
      itemLevelBonus: boosted?.itemLevelBonus ?? 0,
      setLevelBonus: boosted?.setLevelBonus ?? 0,
      skillLevelBonus: boosted?.skillLevelBonus ?? 0,
      effectBonuses: boosted?.effectBonuses ?? [],
      onUseOnlyLevelSources: boosted?.onUseOnlyLevelSources ?? [],
      timing: definition?.timing ?? null,
      target: definition?.target ?? null,
      itemRequirement: skillItemRequirementFor(definition, equippedItems),
      attributeFormula: definition?.attributeFormula ?? null,
      attackMean: means?.attackMean?.applied ?? null,
      defenseMean: means?.defenseMean?.applied ?? null,
      damageMean: means?.damageMean?.applied ?? null,
      manaCost: cost?.applied ?? null,
      manaCostExact: cost?.exact ?? null,
      warnings: definition?.warnings ?? [],
      hasDefinition: Boolean(definition),
    };
  });
  const relationPriority = { basic: 0, additional: 1, special: 2, talent: 3, unknown: 4 };
  const learnableById = new Map();
  for (const entry of repository.listLearnableSkills(heroId, userId)) {
    const existing = learnableById.get(entry.source_skill_id);
    if (!existing || entry.learn_level < existing.learn_level || relationPriority[entry.training_class] < relationPriority[existing.training_class]) {
      learnableById.set(entry.source_skill_id, entry);
    }
  }
  const learnableSkills = [...learnableById.values()].map((entry) => {
    const unlocked = heroLevel >= entry.learn_level;
    let increaseCost = null;
    let decreaseRefund = null;
    try { increaseCost = skillTrainingChange(entry.current_level, 1, entry.training_class).cost; } catch {}
    try { if (entry.current_level > 0) decreaseRefund = skillTrainingChange(entry.current_level, -1, entry.training_class).cost; } catch {}
    // 技能等级加持来自「对技能等级的奖励」，装备与已学技能都可能提供。
    const boosted = instanceSkills.get(entry.skill_name) ?? null;
    const currentLevel = Number(entry.current_level ?? 0);
    return {
      sourceSkillId: entry.source_skill_id,
      name: entry.skill_name,
      skillType: entry.skill_type,
      learnLevel: entry.learn_level,
      trainingClass: entry.training_class,
      trainingClassLabel: ({ basic: "基本", additional: "附加", special: "特殊", talent: "天赋" })[entry.training_class] ?? "未知",
      source: entry.source,
      currentLevel,
      itemLevelBonus: boosted?.itemLevelBonus ?? 0,
      setLevelBonus: boosted?.setLevelBonus ?? 0,
      skillLevelBonus: boosted?.skillLevelBonus ?? 0,
      levelDelta: boosted ? boosted.liveLevel - boosted.baseLevel : 0,
      liveLevel: boosted?.liveLevel ?? currentLevel,
      levelSources: boosted?.levelSources ?? [],
      effectBonuses: boosted?.effectBonuses ?? [],
      onUseOnlyLevelSources: boosted?.onUseOnlyLevelSources ?? [],
      unlocked,
      increaseCost,
      decreaseRefund,
    };
  }).sort((a, b) => a.learnLevel - b.learnLevel || a.name.localeCompare(b.name, "zh-CN"));

  // 行动设置既支持旧的稳定技能，也支持通过职业/种族训练系统新学到的源技能。
  const actionSkills = [...skills];
  const actionSkillIds = new Set(actionSkills.map((skill) => skill.skillId));
  const definitionsBySourceId = new Map([...catalog.skills.values()].filter((skill) => skill.sourceId != null).map((skill) => [Number(skill.sourceId), skill]));
  for (const learned of learnableSkills.filter((skill) => skill.currentLevel > 0)) {
    const skillId = `skill-${learned.sourceSkillId}`;
    if (actionSkillIds.has(skillId)) continue;
    const definition = definitionsBySourceId.get(Number(learned.sourceSkillId));
    if (!definition?.timing || definition.timing.passive) continue;
    actionSkills.push({ skillId, name: learned.name, baseType: definition.baseType, baseTypeLabel: BASE_TYPE_LABELS[definition.baseType] ?? learned.skillType, timing: definition.timing, target: definition.target, itemRequirement: skillItemRequirementFor(definition, equippedItems) });
    actionSkillIds.add(skillId);
  }

  const derivedRow = (key, fallback) => (instanceDerived?.[key] ?? {
    key, label: null, base: fallback, equipmentDelta: 0, skillDelta: 0, effective: fallback, exact: fallback, steps: [], contributors: [],
  });

  return {
    id: row.id,
    name: row.name,
    level: heroLevel,
    active: Boolean(row.active),
    professionId: row.profession_id,
    profession: row.profession_name,
    advancedProfession: row.advanced_profession_name ?? null,
    advancement: {
      eligible: heroLevel >= ADVANCEMENT_LEVEL && Boolean(ADVANCED_PROFESSIONS[row.profession_name]),
      options: ADVANCED_PROFESSIONS[row.profession_name] ?? [],
      levelRequired: ADVANCEMENT_LEVEL,
      experienceCost: ADVANCEMENT_EXPERIENCE_COST,
      goldCost: ADVANCEMENT_GOLD_COST,
      firstAdvancement: !row.advanced_profession_name,
    },
    raceId: row.race_id,
    race: row.race_name,
    gender: row.gender,
    experience: row.current_experience,
    currentExperience: row.current_experience,
    totalExperience: row.total_experience,
    experienceProgress: heroExperienceProgress(row.total_experience, row.level),
    gold: row.gold,
    fame: row.fame,
    nextDungeonAt: row.next_dungeon_at,
    attackTypes: repository.listAttackTypes().map((entry) => entry.name),
    damageTypes: repository.listDamageTypes().map((entry) => entry.name),
    combatAttributes,
    baseCharacter: {
      attributes: unit.attributes,
      stats: unit.baseStats,
    },
    attributes,
    derived: {
      healthMax: derivedRow("healthMax", baseline.healthMax).effective,
      manaMax: derivedRow("manaMax", baseline.manaMax).effective,
      health: unit.health,
      mana: unit.mana,
      healthRegeneration: derivedRow("healthRegeneration", baseline.healthRegeneration).effective,
      manaRegeneration: derivedRow("manaRegeneration", baseline.manaRegeneration).effective,
      actions: derivedRow("actionsPerRound", baseline.actions).effective,
      actionsExact: derivedRow("actionsPerRound", baseline.actionsExact).exact,
      initiative: derivedRow("initiative", baseline.initiative).effective,
      initiativeExact: derivedRow("initiative", baseline.initiativeExact).exact,
      pocketSlots: derivedRow("pocketSlots", baseline.pocketSlots).effective,
      ringSlots: derivedRow("ringSlots", baseline.ringSlots).effective,
      medalSlots: derivedRow("medalSlots", baseline.medalSlots).effective,
      wounds: wounds.state,
      woundsLabel: WOUND_LABELS[wounds.state],
      // 基础值 / 装备加持 / 技能加持 / 生效值，供属性页逐项展示。
      breakdown: {
        healthMax: derivedRow("healthMax", baseline.healthMax),
        manaMax: derivedRow("manaMax", baseline.manaMax),
        healthRegeneration: derivedRow("healthRegeneration", baseline.healthRegeneration),
        manaRegeneration: derivedRow("manaRegeneration", baseline.manaRegeneration),
        actionsPerRound: derivedRow("actionsPerRound", baseline.actions),
        initiative: derivedRow("initiative", baseline.initiative),
        pocketSlots: derivedRow("pocketSlots", baseline.pocketSlots),
        ringSlots: derivedRow("ringSlots", baseline.ringSlots),
        medalSlots: derivedRow("medalSlots", baseline.medalSlots),
      },
      traces: {
        healthMax: instanceDerived?.healthMax.steps ?? baseline.traces.healthMax.steps,
        manaMax: instanceDerived?.manaMax.steps ?? baseline.traces.manaMax.steps,
        initiative: instanceDerived?.initiative.steps ?? baseline.traces.initiative.steps,
      },
    },
    skills,
    actionSkills,
    learnableSkills,
    // 角色实例的来源与缺口汇总：页面据此说明加持来自哪些装备/技能。
    effectSummary: {
      instanceApplied: Boolean(instance),
      stageOrder: instance?.stageOrder ?? [],
      equippedItems: instance?.equippedItems ?? [],
      sources: instance?.sources ?? [],
      sourceCount: instance?.sources?.length ?? 0,
      onUseOnly: instance?.onUseOnly ?? [],
      missingSources: instance?.missingSources ?? [],
      warnings: instance?.warnings ?? [],
    },
  };
}

/** 英雄列表 DTO。 */
export function heroListDto(repository, userId) {
  return repository.listHeroes(userId).map((row) => {
    const heroSkills = repository.listHeroSkills(row.id);
    const unit = heroRowToUnit(row, { heroSkills });
    const derived = deriveUnit(unit);
    return {
      id: row.id,
      name: row.name,
      level: Number(row.level ?? 1),
      active: Boolean(row.active),
      profession: row.profession_name,
      race: row.race_name,
      gender: row.gender,
      nextDungeonAt: row.next_dungeon_at,
      experience: row.current_experience,
      currentExperience: row.current_experience,
      totalExperience: row.total_experience,
      experienceProgress: heroExperienceProgress(row.total_experience, row.level),
      gold: row.gold,
      fame: row.fame,
      healthMax: derived.healthMax,
      manaMax: derived.manaMax,
      initiative: derived.initiative,
      skillCount: heroSkills.length,
    };
  });
}

const MAX_RESOURCE_AMOUNT = 1_000_000_000;
const MAX_RESOURCE_BALANCE = 2_147_483_647;

/** 给当前账号所属英雄补充经验、金币或荣誉，供英雄页的资源补充操作使用。 */
export function addHeroResource(repository, heroId, resource, amount, catalog, userId, options = {}) {
  if (!["experience", "gold", "fame"].includes(resource)) throw new Error("未知资源类型");
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RESOURCE_AMOUNT) {
    throw new Error(`补充数量必须是 1 到 ${MAX_RESOURCE_AMOUNT.toLocaleString("en-US")} 之间的整数`);
  }
  const hero = repository.getHero(heroId, userId);
  if (!hero) throw new Error("英雄不存在");
  const current = resource === "experience"
    ? Math.max(Number(hero.current_experience), Number(hero.total_experience))
    : Number(hero[resource]);
  if (current + value > MAX_RESOURCE_BALANCE) throw new Error("补充后资源总量超出允许范围");
  repository.addHeroResources(heroId, userId, {
    experience: resource === "experience" ? value : 0,
    gold: resource === "gold" ? value : 0,
    fame: resource === "fame" ? value : 0,
  });
  return heroDetailDto(repository, heroId, catalog, userId, options);
}

/** 达到 game_meta_rule.md 的累计总经验门槛后，手动提升数据库等级一级。 */
export function upgradeHeroLevel(repository, heroId, catalog, userId, options = {}) {
  const hero = repository.getHero(heroId, userId);
  if (!hero) throw new Error("英雄不存在");
  const progress = heroExperienceProgress(hero.total_experience, hero.level);
  if (progress.nextLevelAt == null) throw new Error("英雄已经达到最高等级");
  if (!progress.canLevelUp) throw new Error(`总经验不足，升级需要 ${progress.nextLevelAt.toLocaleString("zh-CN")}`);
  repository.upgradeHeroLevel(heroId, userId, Number(hero.level), progress.nextLevelAt);
  return heroDetailDto(repository, heroId, catalog, userId, options);
}

export function trainHeroAttribute(repository, heroId, attributeKey, delta, catalog, userId, options = {}) {
  const hero = repository.getHero(heroId, userId);
  if (!hero) throw new Error("英雄不存在");
  if (!ATTRIBUTE_KEYS.includes(attributeKey)) throw new Error("未知属性");
  if (Number(delta) !== 1 && Number(delta) !== -1) throw new Error("属性每次只能增减 1 点");
  // 单点训练只是「一次一点」的批量提交，两条路径共用同一套逐级费用与事务。
  const result = trainHeroAttributes(repository, heroId, [{ key: attributeKey, value: Number(hero[attributeKey]) + Number(delta) }], catalog, userId, options);
  const [change] = result.training.changes;
  return { ...result, training: { ...change, experienceChange: result.training.experienceChange } };
}

/** 校验并原子应用属性页草稿；逐级计算保证跨多点训练使用正确费用。 */
export function trainHeroAttributes(repository, heroId, updates, catalog, userId, options = {}) {
  const hero = repository.getHero(heroId, userId);
  if (!hero) throw new Error("英雄不存在");
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("没有需要提交的属性修改");
  const seen = new Set();
  let experienceChange = 0;
  const changes = updates.map((update) => {
    const key = String(update?.key ?? "");
    if (!ATTRIBUTE_KEYS.includes(key)) throw new Error("未知属性");
    if (seen.has(key)) throw new Error("属性修改中存在重复项目");
    seen.add(key);
    const current = Number(hero[key]);
    const value = Number(update.value);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${ATTRIBUTE_LABELS[key]}的目标值无效`);
    // 训练表在最高等级没有下一级费用，草稿高过上限时按单点错误提示，避免抛出内部文案。
    try { experienceChange += attributeTrainingRangeChange(current, value); }
    catch { throw new Error(`${ATTRIBUTE_LABELS[key]}超出训练表上限`); }
    return { key, current, value };
  });
  const currentExperience = Number(hero.current_experience);
  if (currentExperience + experienceChange < 0) {
    const required = Math.max(0, -experienceChange - currentExperience);
    throw new Error(`当前经验不足，还需要 ${required.toLocaleString("zh-CN")} 经验`);
  }
  repository.replaceHeroAttributes(heroId, userId, changes, experienceChange);
  return { ...heroDetailDto(repository, heroId, catalog, userId, options), training: { changes, experienceChange } };
}

export function advanceHeroProfession(repository, heroId, name, catalog, userId, options = {}) {
  const hero = repository.getHero(heroId, userId);
  if (!hero) throw new Error("英雄不存在");
  if (Number(hero.level) < ADVANCEMENT_LEVEL) throw new Error(`英雄达到 ${ADVANCEMENT_LEVEL} 级后才能职业进阶`);
  if (!(ADVANCED_PROFESSIONS[hero.profession_name] ?? []).includes(name)) throw new Error("所选进阶职业不属于当前基础职业");
  const result = repository.setAdvancedProfession(heroId, userId, name, {
    experienceCost: ADVANCEMENT_EXPERIENCE_COST, goldCost: ADVANCEMENT_GOLD_COST,
  });
  return { ...heroDetailDto(repository, heroId, catalog, userId, options), firstAdvancement: result.firstAdvancement };
}

/**
 * 删除角色。
 *
 * 名下物品（含已装备）全部转入账号的团队仓库，随后角色从所有角色入口消失；
 * 战报与探索记录按外键要求保留，仍可在战报页查看。物品流转与角色隐藏
 * 在同一事务边界内完成，见 infrastructure/persistence/sqlite-repository.mjs 的 deleteHero。
 *
 * @returns {{heroId: number, movedItemCount: number, heroes: object[]}}
 */
export function deleteHero(repository, heroId, userId) {
  const result = repository.deleteHero(heroId, userId);
  return { ...result, heroes: heroListDto(repository, userId) };
}

export function trainHeroSkill(repository, heroId, sourceSkillId, delta, catalog, userId, options = {}) {
  const detail = heroDetailDto(repository, heroId, catalog, userId, options);
  if (!detail) throw new Error("英雄不存在");
  const skill = detail.learnableSkills.find((entry) => entry.sourceSkillId === Number(sourceSkillId));
  if (!skill) throw new Error("该技能不属于当前角色的职业或种族");
  if (!skill.unlocked) throw new Error(`技能将在英雄 ${skill.learnLevel} 级解锁`);
  const change = skillTrainingChange(skill.currentLevel, Number(delta), skill.trainingClass);
  repository.setHeroSkillLevel(heroId, userId, sourceSkillId, change.next, change.experienceChange);
  return { ...heroDetailDto(repository, heroId, catalog, userId, options), training: change };
}

/** 校验并原子应用技能页草稿；逐级计算保证跨多级训练使用正确费用。 */
export function trainHeroSkills(repository, heroId, updates, catalog, userId, options = {}) {
  const detail = heroDetailDto(repository, heroId, catalog, userId, options);
  if (!detail) throw new Error("英雄不存在");
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("没有需要提交的技能修改");
  const skills = new Map(detail.learnableSkills.map((skill) => [Number(skill.sourceSkillId), skill]));
  const seen = new Set();
  let experienceChange = 0;
  const changes = updates.map((update) => {
    const sourceSkillId = Number(update.sourceSkillId);
    const nextLevel = Number(update.level);
    const skill = skills.get(sourceSkillId);
    if (!skill) throw new Error("该技能不属于当前角色的职业或种族");
    if (seen.has(sourceSkillId)) throw new Error("技能修改中存在重复项目");
    seen.add(sourceSkillId);
    if (!skill.unlocked) throw new Error(`技能将在英雄 ${skill.learnLevel} 级解锁`);
    if (!Number.isSafeInteger(nextLevel) || nextLevel < 0) throw new Error("技能等级无效");
    let level = Number(skill.currentLevel);
    while (level !== nextLevel) {
      const step = skillTrainingChange(level, nextLevel > level ? 1 : -1, skill.trainingClass);
      experienceChange += step.experienceChange;
      level = step.next;
    }
    return { sourceSkillId, nextLevel };
  });
  if (Number(detail.currentExperience) + experienceChange < 0) throw new Error("当前经验不足");
  repository.replaceHeroSkillLevels(heroId, userId, changes, experienceChange);
  return { ...heroDetailDto(repository, heroId, catalog, userId, options), training: { changes, experienceChange } };
}

/** 把持久化方案行转换为领域 BattlePlan。 */
export function planRowToDomain(row) {
  return createBattlePlan({
    id: String(row.id),
    name: row.name,
    mode: row.mode ?? "pve",
    defaultPlan: {
      position: row.position ?? "front",
      initiativeSkillId: row.initiative_skill_id ?? null,
      preRound: parseJson(row.pre_round_json, []),
      mainRound: parseJson(row.main_round_json, []),
    },
    floorOverrides: parseJson(row.floor_overrides_json, {}),
    general: parseJson(row.general_json, {}),
  });
}

/** 方案 DTO，附带站位与层覆盖的中文显示。 */
export function planDto(row) {
  const plan = planRowToDomain(row);
  return {
    id: plan.id,
    name: plan.name,
    mode: plan.mode,
    position: plan.defaultPlan.position,
    positionLabel: POSITION_LABELS[plan.defaultPlan.position] ?? plan.defaultPlan.position,
    initiativeSkillId: plan.defaultPlan.initiativeSkillId,
    preRound: plan.defaultPlan.preRound,
    mainRound: plan.defaultPlan.mainRound,
    floorOverrides: plan.floorOverrides,
    general: plan.general,
    floorPlanPreview: Object.fromEntries(
      [1, 2, 3].map((floor) => {
        const resolved = resolveFloorPlan(plan, floor);
        return [floor, { source: resolved.source, position: resolved.plan.position, positionLabel: POSITION_LABELS[resolved.plan.position] ?? resolved.plan.position }];
      }),
    ),
  };
}
