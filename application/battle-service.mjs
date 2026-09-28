// 战斗与地城用例：组装初始状态、运行引擎、持久化、回放校验。
//
// 地城结构（设计文档 §10）：
//   DungeonRun → Level 1..N → Battle/Room 1..M → Round 1..K
// 同层多场战斗共用该层设置；“到该战斗结束”的效果不跨房间，“无限制”的效果持续到地城结束。
import { simulateBattle, RULESET_VERSION, RANDOM_ALGORITHM_VERSION } from "../game/engine/simulate.mjs";
import { EffectLedger } from "../game/domain/effect.mjs";
import { stableHash } from "../game/replay/envelope.mjs";
import { renderEvents } from "../game/events/render.mjs";
import { createDisplayBattleReport } from "../game/events/display-report.mjs";
import { POSITION_LABELS } from "../game/domain/positions.mjs";
import { planRowToDomain } from "./hero-service.mjs";
import { actionSettingsDto, actionSettingsToBattlePlan, ACTION_PHASES } from "./action-settings-service.mjs";
import { buildCharacterInstance } from "./character-instance-service.mjs";
import { encountersForDungeon, battlesForFloor } from "../gamedata/overrides/dungeon-encounters.mjs";
import { ATTRIBUTE_TARGET_KEYS, DERIVED_KEYS, parseCorrection, parseGradeCorrection } from "../game/domain/holder-effect.mjs";
import { evaluateSummonExpression } from "../game/formulas/summon-expression.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BASE_TYPE_BY_LABEL, createSkillDefinition, parseTargetSpec, parseTiming } from "../game/domain/skill.mjs";
import { createBattlePlan } from "../game/commands/battle-plan.mjs";
import { summonActionSettingsDto } from "./summon-action-settings-service.mjs";

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function targetEffectDuration(effect) {
  const text = String(effect?.durationLabel ?? effect?.["持续时间"] ?? effect?.cells?.[effect?.columnHeaders?.indexOf?.("持续时间")] ?? "");
  if (text.includes("无限制")) return { kind: "untilDungeonEnd" };
  if (text.includes("战斗") && text.includes("结束")) return { kind: "untilBattleEnd" };
  if (text.includes("回合结束") || text.includes("该回合")) return { kind: "untilCurrentRoundEnd" };
  const rounds = /(?:一个|([0-9]+))\s*个?回合/.exec(text);
  if (rounds) return { kind: "rounds", value: rounds[1] ? Number(rounds[1]) : 1 };
  return { kind: "untilBattleEnd" };
}

function targetEffectActivation(effect) {
  const text = String(effect?.activationLabel ?? effect?.["评注"] ?? effect?.cells?.[effect?.columnHeaders?.indexOf?.("评注")] ?? "");
  if (text.includes("下个回合")) return { kind: "nextRound" };
  const rounds = /(\d+)\s*个?回合后/.exec(text);
  if (rounds) return { kind: "afterRounds", value: Number(rounds[1]) };
  return { kind: "immediate" };
}

export function combatEffect(effect, sourceKind, sourceId, index, skillIdByName = new Map()) {
  const correction = parseCorrection(effect?.["修正"] ?? "");
  const gradedKind = effect?.["类型"] === "护甲奖励" ? "armor" : effect?.["类型"] === "伤害奖励" ? "damageBonus"
    : effect?.["类型"] === "对此种攻击方式，攻击类型伤害的脆弱性" ? "vulnerability" : null;
  const gradeKey = gradedKind === "armor" ? "护甲(r)" : gradedKind === "damageBonus" ? "伤害奖励(r)" : "奖励(r)";
  const gradedModifiers = gradedKind && effect?.[gradeKey]
    ? parseGradeCorrection(effect[gradeKey]).flatMap((grade) => grade.terms.map((term) => ({
      ...term,
      kind: term.kind === "scaledValue" ? "scaledPercent" : term.kind,
      target: { type: gradedKind, damageType: effect["伤害方式"], attackType: effect["攻击方式"], grade: grade.grade },
      source: `${sourceKind}:${sourceId}`,
    })))
    : [];
  const targetName = effect?.["属性"] ?? effect?.["技能"] ?? effect?.targetName;
  const attributeKey = ATTRIBUTE_TARGET_KEYS[targetName];
  const target = effect?.["类型"] === "对技能等级的奖励" || effect?.targetKind === "skill" || effect?.targetKind === "skillCategory"
    ? { type: "skill", key: effect?.targetSkillId ?? skillIdByName.get(targetName) ?? targetName, label: targetName }
    : effect?.["类型"] === "对技能效果的奖励"
      ? { type: "skillEffect", key: effect?.targetSkillId ?? skillIdByName.get(targetName) ?? targetName, label: targetName }
    : attributeKey
      ? { type: Object.values(DERIVED_KEYS).includes(attributeKey) ? "derived" : "attribute", key: attributeKey, label: targetName }
      : effect?.["类型"] === "防御奖励" || effect?.category === "防御奖励"
        ? { type: "defenseBonus", key: targetName, label: targetName }
        : effect?.["类型"] === "攻击奖励" || effect?.category === "攻击奖励"
          ? { type: "attackBonus", key: targetName, label: targetName }
          : null;
  const parsedTerms = (effect?.modifiers ?? []).map((entry) => entry.modifier ?? entry);
  const terms = correction.terms.length > 0 ? correction.terms : parsedTerms;
  const modifiers = target ? terms.map((term) => ({
    ...term,
    kind: term.kind === "scaledValue" ? "scaledPercent" : term.kind,
    target,
    source: `${sourceKind}:${sourceId}`,
  })) : [];
  const rawText = Object.entries(effect ?? {})
    .filter(([key, value]) => !["类型", "持续时间", "评注"].includes(key) && String(value ?? "").trim() !== "")
    .map(([key, value]) => `${key} ${value}`)
    .join("，");
  return {
    id: `${sourceKind}:${sourceId}:${index}`,
    name: effect?.name ?? effect?.["类型"] ?? effect?.category ?? `${sourceKind}效果`,
    duration: targetEffectDuration(effect),
    activation: targetEffectActivation(effect),
    modifiers: effect?.engineModifiers ?? [...modifiers, ...gradedModifiers],
    rawText: effect?.rawText ?? rawText,
    raw: effect,
    sourceKind,
    sourceId,
  };
}

function initiativeAttributeBinding(skill, repository, root) {
  if (skill.baseType !== "initiative") return null;
  if (skill.attributeFormula?.initiative) return skill.attributeFormula.initiative;
  const sourceId = Number(skill.sourceId);
  if (!Number.isFinite(sourceId)) return null;
  for (const scope of ["profession", "race"]) {
    const metadata = repository?.getSkillDetailMetadata?.(scope, sourceId);
    if (!metadata) continue;
    let detail = null;
    try { detail = parseJson(readFileSync(resolve(root, metadata.json_path), "utf8"), null); } catch {}
    const text = String(detail?.["详细属性"]?.["出手速度"] ?? "");
    const [primaryName, secondaryName] = text.split(/[,，]/).map((part) => part.trim());
    const primary = ATTRIBUTE_TARGET_KEYS[primaryName];
    const secondary = ATTRIBUTE_TARGET_KEYS[secondaryName];
    if (primary && secondary) return { primary, secondary };
  }
  return null;
}

function healingFields(skill, repository, root) {
  if (skill.baseType !== "heal" || !Number.isFinite(Number(skill.sourceId))) return {};
  for (const scope of ["profession", "race"]) {
    const metadata = repository?.getSkillDetailMetadata?.(scope, Number(skill.sourceId));
    if (!metadata?.json_path) continue;
    let detail;
    try { detail = JSON.parse(readFileSync(resolve(root, metadata.json_path), "utf8"))["详细属性"]; } catch { continue; }
    const [primaryName, secondaryName] = String(detail?.["治疗"] ?? "").split(/[,，]/).map((part) => part.trim().replace(/\s*\(.*/, ""));
    const primary = ATTRIBUTE_TARGET_KEYS[primaryName];
    const secondary = ATTRIBUTE_TARGET_KEYS[secondaryName];
    const recoveryText = String(detail?.["体力恢复"] ?? "");
    return {
      ...(primary && secondary ? { healingFormula: { primary, secondary } } : {}),
      healthRecovery: parseCorrection(recoveryText).terms,
    };
  }
  return {};
}

/** 把目录中的技能目标效果转换为引擎可直接施加的效果。 */
function battleSkillDefinitions(catalog, repository, root = process.cwd()) {
  const skillIdByName = new Map([...catalog.skills.values()].map((skill) => [skill.name, skill.id]));
  return Object.fromEntries([...catalog.skills].map(([id, skill]) => {
    const initiative = initiativeAttributeBinding(skill, repository, root);
    const healing = healingFields(skill, repository, root);
    return [id, {
      ...skill,
      ...healing,
      attributeFormula: { ...(skill.attributeFormula ?? {}), ...(initiative ? { initiative } : {}), ...(healing.healingFormula ? { damage: healing.healingFormula } : {}) },
      effects: (skill.targetEffects ?? skill.effects ?? []).map((effect, index) => combatEffect(effect, "skill", id, index, skillIdByName)),
    }];
  }));
}

/** 将本次调用物品及其套装的目标效果固化进方案快照。 */
function summonSkillLevel(instance, skillId) {
  const skill = (instance.skills ?? []).find((entry) => String(entry.skillId) === String(skillId));
  return Number(skill?.liveLevel ?? skill?.baseLevel ?? 0);
}

/** 将数据库召唤配方解析成引擎模板。配方必须与本次实际调用的物品和技能等级同时匹配。 */
function summonBattleSkill(repository, root, assignment) {
  const metadata = repository.getSkillDetailMetadata("summon", assignment.summon_skill_id);
  let raw = {};
  if (metadata?.json_path) {
    try { raw = JSON.parse(readFileSync(resolve(root, metadata.json_path), "utf8")); } catch { raw = {}; }
  }
  const rawType = raw["类型"] ?? "";
  return createSkillDefinition({
    id: String(assignment.summon_skill_id),
    name: assignment.skill_name,
    baseType: BASE_TYPE_BY_LABEL[rawType] ?? "improve",
    timing: parseTiming(`${raw["可以被用于"] ?? ""} ${rawType}`).timing,
    target: parseTargetSpec(raw["目标"] ?? "").spec,
    skillTypeNames: [assignment.skill_type].filter(Boolean),
    effects: (raw["作用在被此技能影响的目标上的效果"] ?? []).map((effect, index) => combatEffect(effect, "skill", String(assignment.summon_skill_id), index)),
  });
}

function summonBattlePlan(definition, settings) {
  const layer = settings.defaultLayer;
  const command = (entry) => ({
    id: entry.id, skillId: entry.skillId, itemIds: entry.itemIds, repeat: entry.repeat,
    target: { mode: "auto", priority: entry.positions.filter((position) => position.enabled).map((position) => position.id) },
  });
  return createBattlePlan({
    id: `summon-action-settings-${definition.id}`,
    name: `${definition.summon_name}行动设置`,
    defaultPlan: {
      position: definition.default_position,
      initiativeSkillId: layer.actions.initiative[0]?.skillId ?? null,
      preRound: layer.actions.preRound.filter((entry) => entry.skillId).map(command),
      mainRound: layer.actions.mainRound.filter((entry) => entry.skillId).map(command),
    },
  });
}

export function summonTemplateForCommand(repository, instance, skillId, itemIds, root = process.cwd()) {
  const level = summonSkillLevel(instance, skillId);
  const selected = new Set((itemIds ?? []).map((id) => String(id).replace(/^item-/, "")));
  const definition = repository.listSummonDefinitions().find((entry) => {
    if (!entry.active || entry.summon_skill_id !== skillId) return false;
    if (level < entry.min_summon_skill_level || (entry.max_summon_skill_level != null && level > entry.max_summon_skill_level)) return false;
    const requiredItem = entry.recipe_type === "advanced" ? entry.medium_item_id : entry.summon_item_id;
    return selected.has(String(requiredItem));
  });
  if (!definition) return null;
  const baseVariables = { summonSkillLevel: level, heroLevel: Number(instance.heroLevel ?? 1), tier: Number(definition.tier) };
  const summonLevel = evaluateSummonExpression(definition.summon_level_expr, baseVariables);
  const variables = { ...baseVariables, summonLevel };
  const attributes = Object.fromEntries(["strength", "constitution", "intelligence", "dexterity", "charisma", "agility", "perception", "willpower"]
    .map((key) => [key, evaluateSummonExpression(definition[`${key}_expr`], variables)]));
  const actionsPerRoundExact = evaluateSummonExpression(definition.actions_per_round_expr ?? "1", variables);
  const assignments = repository.listSummonSkillAssignments()
    .filter((entry) => entry.archetype_id === definition.archetype_id && entry.active && level >= entry.unlock_summon_skill_level);
  const skillDefinitions = assignments.map((entry) => summonBattleSkill(repository, root, entry));
  const skills = Object.fromEntries(assignments.map((entry) => [String(entry.summon_skill_id), {
    baseLevel: evaluateSummonExpression(entry.skill_level_expr, variables), equipmentBonus: 0,
  }]));
  const settings = summonActionSettingsDto(repository.getSummonActionSettings(definition.id));
  return {
    definitionId: definition.id, archetypeId: definition.archetype_id, name: definition.summon_name,
    level: summonLevel, position: definition.default_position, attributes, actionsPerRoundExact,
    baseStatDefaults: { actionsPerRound: actionsPerRoundExact }, skills, skillDefinitions,
    battlePlan: summonBattlePlan(definition, settings),
  };
}

export function attachCalledItemEffects(plan, instance, catalog, repository, root) {
  if (!plan) return plan;
  const items = new Map();
  for (const item of instance.equippedItems ?? []) {
    const key = String(item.itemId);
    if (!items.has(key)) items.set(key, []);
    items.get(key).push(item);
  }
  const sets = new Map((instance.itemSets ?? []).map((set) => [set.setName, set]));
  const skillIdByName = new Map([...catalog.skills.values()].map((skill) => [skill.name, skill.id]));
  const enrich = (command) => {
    const itemIds = command.itemIds ?? (command.itemId == null ? [] : [command.itemId]);
    const selected = itemIds.map(String).map((id) => items.get(id)?.[0]).filter(Boolean);
    command.calledItems = selected.map((item) => ({
      id: String(item.itemId), name: item.name ?? String(item.itemId), setName: item.setName ?? null,
      instances: items.get(String(item.itemId)).map((entry) => ({ instanceId: entry.instanceId, ...entry.useLimits })),
    }));
    command.itemEffects = selected.flatMap((item) => (item.targetEffects ?? []).map((effect, index) => combatEffect(effect, "item", item.itemId, index, skillIdByName)));
    command.itemEffects.push(...selected.flatMap((item) => (item.runeTargetEffects ?? []).map((effect, index) =>
      combatEffect(effect, "ancientRune", `${item.instanceId}:${item.runeCombination?.name}`, index, skillIdByName))));
    const selectedSetNames = [...new Set(selected.map((item) => item.setName).filter(Boolean))];
    command.setEffects = selectedSetNames.flatMap((name) => (sets.get(name)?.targetEffects ?? []).map((effect, index) => combatEffect(effect, "itemSet", name, index, skillIdByName)));
    if (catalog.skills.get(command.skillId)?.baseType === "summon") command.summonTemplate = summonTemplateForCommand(repository, instance, command.skillId, itemIds, root);
    return command;
  };
  for (const layer of [plan.defaultPlan, ...Object.values(plan.floorOverrides ?? {})]) {
    layer.preRound = (layer.preRound ?? []).map(enrich);
    layer.mainRound = (layer.mainRound ?? []).map(enrich);
    layer.healing = Object.fromEntries(["light", "wounded", "severe"].map((wound) => [wound, (layer.healing?.[wound] ?? []).map(enrich)]));
    const initiative = enrich({ itemIds: layer.initiativeItemIds ?? (layer.initiativeItemId == null ? [] : [layer.initiativeItemId]) });
    layer.initiativeItemEffects = initiative.itemEffects;
    layer.initiativeSetEffects = initiative.setEffects;
    layer.initiativeCalledItems = initiative.calledItems;
  }
  return plan;
}

// ---------------------------------------------------------------- 探索记录
//
// 探索分两步，都以同一条 dungeon_runs 记录为载体：
//   1. 创建（本阶段已实现）：把「账号全部角色 + 各自行动设置 + 所选地城」固化为战斗规则输入。
//   2. 模拟：战斗引擎读取该输入，按角色设置决定站位与技能释放顺序，回填战斗结果。
// 这样战报记录在点击探索的瞬间就可见，且战斗规则输入不随后续设置变更而漂移。

/** 探索记录状态。 */
export const EXPLORATION_STATUS = Object.freeze({
  pending: "pending", // 记录已创建，战斗尚未执行
  running: "running", // 引擎正在执行（保留给异步结算）
  completed: "completed", // 战斗已执行；奖励是否结算由 rewards.settled 单独表示
});

export const EXPLORATION_INPUT_VERSION = 2;

function positionLabel(position) {
  return POSITION_LABELS[position] ?? position ?? "未指定";
}

/** 行动设置摘要：站位 + 每阶段实际配置的指令数，供战报详情展示。 */
function actionSettingsSummary(settings) {
  const phaseCounts = (layer) => Object.fromEntries(
    ACTION_PHASES.map((phase) => [
      phase,
      (layer?.actions?.[phase] ?? []).filter((action) => action.skillId).length,
    ]),
  );
  const floorOverrides = Object.keys(settings?.floors ?? {})
    .map(Number)
    .filter((floor) => Number.isFinite(floor) && settings.floors[floor]?.override)
    .sort((a, b) => a - b)
    .map((floor) => ({ floor, ...phaseCounts(settings.floors[floor]) }));
  const position = settings?.defaultLayer?.position ?? "rear";
  return {
    version: settings?.version ?? null,
    position,
    positionLabel: positionLabel(position),
    commandCounts: phaseCounts(settings?.defaultLayer),
    floorOverrides,
  };
}

/** 地城遭遇配置摘要：战斗规则输入中的防御方。 */
function encounterSummary(dungeonId) {
  const encounter = encountersForDungeon(dungeonId);
  if (!encounter) return null;
  return {
    floorNumber: encounter.floorNumber,
    evidence: encounter.evidence ?? null,
    battles: encounter.battles.map((battle, index) => ({
      battleIndex: index + 1,
      name: battle.name,
      unitCount: battle.units.length,
      units: battle.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        level: unit.level,
        position: unit.position,
        positionLabel: positionLabel(unit.position),
      })),
    })),
  };
}

/** 单个角色的战斗规则输入：站位、行动设置、技能与派生资源上限。 */
function heroExplorationEntry(repository, hero, leaderHeroId, instance) {
  const heroSkills = repository.listHeroSkills(hero.id);
  const actionSettings = actionSettingsDto(repository.getHeroActionSettings(hero.id));
  const position = actionSettings.defaultLayer?.position ?? "rear";
  return {
    heroId: hero.id,
    name: hero.name,
    level: Number(hero.level ?? 1),
    profession: hero.profession_name ?? null,
    race: hero.race_name ?? null,
    isLeader: hero.id === leaderHeroId,
    position,
    positionLabel: positionLabel(position),
    healthMax: instance.derived.healthMax.effective,
    manaMax: instance.derived.manaMax.effective,
    initiative: instance.derived.initiative.effective,
    skills: heroSkills.map((entry) => ({
      skillId: entry.skill_id,
      baseLevel: entry.base_level,
      equipmentBonus: entry.equipment_bonus ?? 0,
    })),
    actionSettings,
    actionSummary: actionSettingsSummary(actionSettings),
    characterSnapshot: {
      attributes: instance.effectiveAttributes,
      derived: Object.fromEntries(Object.entries(instance.derived).map(([key, value]) => [key, { exact: value.exact, effective: value.effective }])),
      combat: instance.combat,
      skills: instance.skills.map((skill) => ({ skillId: skill.skillId, name: skill.name, level: skill.liveLevel })),
      equippedItems: instance.equippedItems,
      warnings: instance.warnings,
    },
  };
}

export function unitFromCharacterInstance(hero, instance, position) {
  const attributes = { ...instance.effectiveAttributes };
  const healthMax = Number(instance.derived.healthMax.effective);
  const manaMax = Number(instance.derived.manaMax.effective);
  const healthRegeneration = Number(instance.derived.healthRegeneration.exact);
  const manaRegeneration = Number(instance.derived.manaRegeneration.exact);
  const actionsPerRound = Number(instance.derived.actionsPerRound.exact);
  const initiative = Number(instance.derived.initiative.exact);
  const skills = {};
  for (const skill of instance.skills) {
    if (!skill.skillId) continue;
    skills[skill.skillId] = {
      baseLevel: Number(skill.baseLevel ?? 0),
      equipmentBonus: Number(skill.equipmentLevelBonusApplied ?? skill.equipmentLevelBonus ?? 0),
      percentageBonuses: [...(skill.percentageBonuses ?? [])],
      otherBonus: Number(skill.postPercentFlatBonus ?? ((skill.setLevelBonus ?? 0) + (skill.skillLevelBonus ?? 0))),
      effectBonusTerms: (skill.effectBonuses ?? []).flatMap((bonus) => bonus.terms),
    };
  }
  return {
    id: String(hero.id),
    name: hero.name,
    side: "attacker",
    kind: "hero",
    level: instance.heroLevel,
    position,
    attributes,
    baseStatDefaults: {
      healthMax: healthMax - attributes.constitution * 3 - attributes.strength * 2,
      manaMax: manaMax - attributes.willpower * 3 - attributes.intelligence * 2,
      healthRegeneration: healthRegeneration - Math.floor(attributes.constitution / 4),
      manaRegeneration: manaRegeneration - Math.floor(attributes.willpower / 3),
      actionsPerRound,
      initiativeBonus: initiative - attributes.agility * 2 - attributes.perception,
    },
    skills,
    health: healthMax,
    mana: manaMax,
    combat: instance.combat,
    onUseOnly: instance.onUseOnly,
    equipment: instance.equippedItems,
  };
}

/**
 * 创建一次探索记录（战报）。
 *
 * 战斗规则输入 = 当前登录账号下的全部角色 + 每个角色的 hero_action_settings + 所选地城。
 * 点击探索后同步执行完整地城；输入快照与战报在同一事务边界内固化。
 */
export function createDungeonExploration({ repository, catalog, root = process.cwd(), userId, dungeonId, heroId, maxFloor = 10, seed, policies, maxRounds }) {
  const dungeon = repository.getDungeon(dungeonId);
  if (!dungeon) return { error: "dungeonNotFound" };
  const heroes = repository.listHeroes(userId);
  if (heroes.length === 0) return { error: "noHero" };
  const leader = heroId == null
    ? heroes.find((hero) => hero.active) ?? heroes[0]
    : heroes.find((hero) => hero.id === Number(heroId));
  if (!leader) return { error: "heroNotFound" };
  const encounters = encounterSummary(dungeon.id);
  if (!encounters) return { error: "noEncounter" };

  const floorLimit = Math.max(1, Math.min(10, Number(maxFloor) || 1));
  const members = heroes.map((hero) => {
    const settingsRow = repository.getHeroActionSettings(hero.id);
    const settings = actionSettingsDto(settingsRow);
    const instance = buildCharacterInstance({ repository, catalog, root, heroId: hero.id, userId });
    if (!instance) throw new Error(`无法构造角色实例: ${hero.id}`);
    return {
      hero,
      settings,
      instance,
      unit: unitFromCharacterInstance(hero, instance, settings.defaultLayer.position),
      // 缺少持久化设置与“保存了一份空设置”是两种状态；前者必须在战斗中提示无法行动。
      plan: settingsRow ? attachCalledItemEffects(actionSettingsToBattlePlan(settings, hero.id), instance, catalog, repository, root) : null,
    };
  });
  const input = {
    version: EXPLORATION_INPUT_VERSION,
    kind: "dungeon-exploration",
    dungeon: {
      id: dungeon.id,
      name: dungeon.name,
      kind: dungeon.kind,
      minLevel: dungeon.min_level,
      maxLevel: dungeon.max_level,
      prepareMinutes: dungeon.prepare_minutes,
      description: dungeon.description,
    },
    leaderHeroId: leader.id,
    maxFloor: floorLimit,
    party: members.map(({ hero, instance }) => heroExplorationEntry(repository, hero, leader.id, instance)),
    encounters,
    rulesetVersion: RULESET_VERSION,
    contentVersion: catalog.contentVersion,
  };

  const seedBase = String(seed ?? `${Date.now()}-${leader.id}`);
  const reportGroupId = repository.createBattleReportGroup();
  // 技能目录在一次探索中不变；同层多场战斗共用同一份定义。
  const battleSkills = battleSkillDefinitions(catalog, repository, root);
  return repository.withBattleReportTransaction(reportGroupId, () => {
    const itemUsage = new Map();
    const ledger = new EffectLedger({ idPrefix: `d${dungeon.id}` });
    const carried = new Map(members.map(({ unit }) => [unit.id, { health: unit.health, mana: unit.mana, alive: true }]));
    const levels = [];
    const dungeonEvents = [];
    let roundOffset = 0;
    let result = "victory";
    let battleCount = 0;

    for (let floorNumber = 1; floorNumber <= floorLimit; floorNumber += 1) {
      const battles = battlesForFloor(dungeon.id, floorNumber);
      if (battles.length === 0) break;
      const floorBattles = [];
      let floorResult = "victory";
      for (let index = 0; index < battles.length; index += 1) {
        const encounter = battles[index];
        const partyUnits = members.map(({ unit }) => {
          const resource = carried.get(unit.id);
          return { ...unit, health: resource?.health ?? unit.health, mana: resource?.mana ?? unit.mana, alive: resource?.alive !== false };
        });
        const initialState = {
          battleId: `${dungeon.id}#${floorNumber}.${index + 1}`,
          dungeonName: dungeon.name,
          floorNumber,
          battleIndex: index + 1,
          battleName: encounter.name,
          units: [...partyUnits, ...encounterUnits(encounter)],
          preRoundOrder: members.map(({ hero }) => String(hero.id)),
        };
        const battlePlans = Object.fromEntries(members.map(({ hero, plan }) => [String(hero.id), plan]));
        const battleSeed = `${seedBase}:${floorNumber}.${index + 1}`;
        const battleInput = {
          initialState,
          battlePlans,
          skills: battleSkills,
          skillIds: [...catalog.skills.keys()],
          rulesetVersion: RULESET_VERSION,
          contentVersion: catalog.contentVersion,
          randomSeed: battleSeed,
          roundOffset,
          maxRounds,
        };
        const battleResult = simulateBattle({ ...battleInput, effectLedger: ledger, itemUsage, policies });
        roundOffset = battleResult.finalState.round;
        for (const member of members) {
          const after = battleResult.finalState.units.find((unit) => unit.id === String(member.hero.id));
          if (after) carried.set(after.id, { health: after.health, mana: after.mana, alive: after.alive });
        }
        const battleId = repository.insertBattleRun({
          reportGroupId,
          heroId: leader.id,
          report: createDisplayBattleReport({
            dungeonName: `${dungeon.name} - ${encounter.name}`,
            battleName: encounter.name,
            result: battleResult.finalState.result,
            roundCount: battleResult.finalState.round,
            levelNumber: floorNumber,
            events: battleResult.events,
          }),
        });
        battleCount += 1;
        floorBattles.push({
          battleId,
          battleIndex: index + 1,
          battleName: encounter.name,
          result: battleResult.finalState.result,
          rounds: battleResult.finalState.round,
        });
        if (battleResult.finalState.result !== "victory") {
          floorResult = battleResult.finalState.result;
          result = floorResult;
          break;
        }
      }
      levels.push({ floor: floorNumber, result: floorResult, battleIds: floorBattles.map((battle) => battle.battleId), battles: floorBattles });
      dungeonEvents.push({ type: "LevelEnded", level: floorNumber, round: roundOffset, result: floorResult, battleCount: floorBattles.length });
      if (floorResult !== "victory") break;
    }
    dungeonEvents.push({ type: "DungeonEnded", round: roundOffset, result, floorCount: levels.length, battleCount });
    const rewards = {
      settled: false,
      experience: 0,
      gold: 0,
      byHero: members.map(({ hero }) => ({ heroId: hero.id, experience: 0, gold: 0 })),
      note: "配装与战斗模拟不发放探索奖励",
    };

    const dungeonRunId = repository.insertDungeonRun({
      heroId: leader.id,
      dungeonId: dungeon.id,
      dungeonName: dungeon.name,
      seed: seedBase,
      rulesetVersion: RULESET_VERSION,
      contentVersion: catalog.contentVersion,
      result,
      status: EXPLORATION_STATUS.completed,
      floorCount: levels.length,
      battleCount,
      partyCount: input.party.length,
      levels,
      events: dungeonEvents,
      effects: ledger.snapshot(),
      input,
      rewards,
    });

    return getDungeonRunDetail(repository, dungeonRunId, userId);
  });
}

/** 把遭遇配置转换为防御方单位。 */
function encounterUnits(battle) {
  return battle.units.map((unit) => ({
    id: unit.id,
    name: unit.name,
    side: "defender",
    kind: unit.kind ?? "monster",
    level: unit.level,
    position: unit.position,
    attributes: unit.attributes,
    skills: unit.skills,
    healthRegeneration: unit.healthRegeneration ?? 0,
    manaRegeneration: unit.manaRegeneration ?? 0,
    actionsPerRoundExact: unit.actionsPerRoundExact ?? 1,
    initiativeBonus: unit.initiativeBonus ?? 0,
  }));
}

/** 载入一次地城运行需要的全部上下文。 */
function prepareContext({ repository, catalog, heroId, dungeonId, planName }) {
  const heroRow = repository.getHero(heroId);
  if (!heroRow) return { error: "heroNotFound" };
  const dungeon = repository.getDungeon(dungeonId);
  if (!dungeon) return { error: "dungeonNotFound" };
  if (!encountersForDungeon(dungeonId)) return { error: "noEncounter" };

  const planRow = planName ? repository.getPlan(heroId, planName) : repository.listPlans(heroId)[0];
  if (!planRow) return { error: "planNotFound" };
  const plan = planRowToDomain(planRow);
  const instance = buildCharacterInstance({ repository, catalog, root: process.cwd(), heroId });
  if (instance) attachCalledItemEffects(plan, instance, catalog, repository, process.cwd());

  const heroSkills = repository.listHeroSkills(heroId);
  const skillIds = [...new Set([...heroSkills.map((entry) => entry.skill_id), ...catalog.skills.keys()])];
  const allBattleSkills = battleSkillDefinitions(catalog, repository);
  const skills = {};
  for (const id of skillIds) {
    const definition = allBattleSkills[id];
    if (definition) skills[id] = definition;
  }
  return { heroRow, dungeon, plan, instance, skills };
}

/** 运行一层中的全部战斗，并把结果写入战斗表。 */
function runFloor({ repository, catalog, context, floorNumber, state, seedBase, reportGroupId, policies, maxRounds }) {
  const battles = battlesForFloor(context.dungeon.id, floorNumber);
  if (battles.length === 0) return { floor: floorNumber, battles: [], result: "skipped" };

  const battleResults = [];
  let floorResult = "victory";

  for (let index = 0; index < battles.length; index += 1) {
    const battle = battles[index];
    const battleRoundOffset = state.roundOffset;
    const heroUnit = unitFromCharacterInstance(context.heroRow, context.instance, context.plan.defaultPlan.position);
    if (state.carriedHealth != null) heroUnit.health = state.carriedHealth;
    if (state.carriedMana != null) heroUnit.mana = state.carriedMana;
    const initialState = {
      battleId: `${context.dungeon.id}#${floorNumber}.${index + 1}`,
      dungeonName: context.dungeon.name,
      floorNumber,
      battleIndex: index + 1,
      battleName: battle.name,
      units: [heroUnit, ...encounterUnits(battle)],
      preRoundOrder: context.plan.general?.preRoundOrder ?? [],
    };
    const battlePlans = { [String(context.heroRow.id)]: context.plan };
    const battleSeed = `${seedBase}:${floorNumber}.${index + 1}`;

    const result = simulateBattle({
      initialState,
      battlePlans,
      skills: context.skills,
      rulesetVersion: RULESET_VERSION,
      contentVersion: catalog.contentVersion,
      randomSeed: battleSeed,
      maxRounds,
      roundOffset: battleRoundOffset,
      effectLedger: state.ledger,
      itemUsage: state.itemUsage,
      policies,
    });

    const heroAfter = result.finalState.units.find((unit) => unit.id === String(context.heroRow.id));
    state.carriedHealth = heroAfter ? heroAfter.health : 0;
    state.carriedMana = heroAfter ? heroAfter.mana : 0;
    state.roundOffset = result.finalState.round;

    // “到该战斗结束”的效果在房间结束时移除；“无限制”效果保留到地城结束。
    const expiredAtRoomEnd = state.ledger.onBattleEnd();
    for (const instance of expiredAtRoomEnd) {
      result.events.push({
        seq: result.events.length + 1,
        type: "EffectExpired",
        round: result.finalState.round,
        phase: "RoundEnded",
        targetId: instance.targetId,
        targetName: instance.targetName ?? instance.targetId,
        effectName: instance.effectName ?? instance.effectDefinitionId,
        reason: "battleEnded",
      });
    }

    const battleId = repository.insertBattleRun({
      reportGroupId,
      heroId: context.heroRow.id,
      report: createDisplayBattleReport({
        dungeonName: `${context.dungeon.name} - ${battle.name}`,
        battleName: battle.name,
        result: result.finalState.result,
        roundCount: result.finalState.round,
        levelNumber: floorNumber,
        events: result.events,
      }),
    });

    battleResults.push({
      battleId,
      battleIndex: index + 1,
      battleName: battle.name,
      result: result.finalState.result,
      rounds: result.finalState.round,
    });

    if (result.finalState.result !== "victory") {
      floorResult = result.finalState.result;
      break;
    }
  }

  return { floor: floorNumber, battles: battleResults, result: floorResult };
}

/** 运行单层地城（不含地城级事件），供接口与测试直接使用。 */
export function runDungeonFloor({ repository, catalog, heroId, dungeonId, planName, floorNumber = 1, seed, policies, maxRounds }) {
  const context = prepareContext({ repository, catalog, heroId, dungeonId, planName });
  if (context.error) return { error: context.error };
  const seedBase = String(seed ?? `${Date.now()}-${heroId}`);
  const reportGroupId = repository.createBattleReportGroup();
  const state = {
    ledger: new EffectLedger({ idPrefix: `d${dungeonId}` }),
    itemUsage: new Map(),
    roundOffset: 0,
    carriedHealth: null,
    carriedMana: null,
  };
  const floor = repository.withBattleReportTransaction(reportGroupId, () =>
    runFloor({ repository, catalog, context, floorNumber, state, seedBase, reportGroupId, policies, maxRounds }));
  if (floor.result === "skipped") return { error: "noEncounter" };
  return {
    dungeonId,
    dungeonName: context.dungeon.name,
    floorNumber,
    planName: context.plan.name,
    seed: seedBase,
    contentVersion: catalog.contentVersion,
    result: floor.result,
    battles: floor.battles,
    effects: state.ledger.snapshot(),
    finalHero: { health: state.carriedHealth, mana: state.carriedMana },
  };
}

/**
 * 运行整座地城：从第 1 层开始逐层推进，直到失败或没有更多配置层。
 * 地城级事件（LevelEnded / DungeonEnded）单独保存，不混入战斗事件流，
 * 这样单场战斗的回放校验仍然精确。
 */
export function runDungeon({ repository, catalog, heroId, dungeonId, planName, maxFloor = 10, seed, policies, maxRounds }) {
  const context = prepareContext({ repository, catalog, heroId, dungeonId, planName });
  if (context.error) return { error: context.error };
  const seedBase = String(seed ?? `${Date.now()}-${heroId}`);
  const reportGroupId = repository.createBattleReportGroup();
  return repository.withBattleReportTransaction(reportGroupId, () => {
    const state = {
      ledger: new EffectLedger({ idPrefix: `d${dungeonId}` }),
      itemUsage: new Map(),
      roundOffset: 0,
      carriedHealth: null,
      carriedMana: null,
    };

    const levels = [];
    const events = [];
    let result = "victory";
    let floorCount = 0;
    let battleCount = 0;

    for (let floorNumber = 1; floorNumber <= maxFloor; floorNumber += 1) {
      const floor = runFloor({ repository, catalog, context, floorNumber, state, seedBase, reportGroupId, policies, maxRounds });
      if (floor.result === "skipped") break;
      floorCount += 1;
      battleCount += floor.battles.length;
      levels.push({
        floor: floorNumber,
        result: floor.result,
        battleIds: floor.battles.map((battle) => battle.battleId),
        battles: floor.battles,
      });
      events.push({
        seq: events.length + 1,
        type: "LevelEnded",
        round: state.roundOffset,
        phase: "RoundEnded",
        level: floorNumber,
        result: floor.result,
        battleCount: floor.battles.length,
      });
      if (floor.result !== "victory") {
        result = floor.result;
        break;
      }
    }

    events.push({
      seq: events.length + 1,
      type: "DungeonEnded",
      round: state.roundOffset,
      phase: "RoundEnded",
      result,
      resultLabel: result === "victory" ? "胜利" : result === "defeat" ? "失败" : "未决",
      floorCount,
      battleCount,
    });

    const dungeonRunId = repository.insertDungeonRun({
      heroId: context.heroRow.id,
      dungeonId,
      dungeonName: context.dungeon.name,
      seed: seedBase,
      rulesetVersion: RULESET_VERSION,
      contentVersion: catalog.contentVersion,
      result,
      // 同步结算的历史路径：一条记录即一次完整地城运行，只涉及单英雄。
      status: EXPLORATION_STATUS.completed,
      partyCount: 1,
      floorCount,
      battleCount,
      levels: levels.map((level) => ({
        floor: level.floor,
        result: level.result,
        battleIds: level.battleIds,
        battles: level.battles.map((battle) => ({
          battleId: battle.battleId,
          battleName: battle.battleName,
          result: battle.result,
          rounds: battle.rounds,
        })),
      })),
      events,
      effects: state.ledger.snapshot(),
    });

    return {
      dungeonRunId,
      dungeonId,
      dungeonName: context.dungeon.name,
      planName: context.plan.name,
      seed: seedBase,
      contentVersion: catalog.contentVersion,
      result,
      status: EXPLORATION_STATUS.completed,
      floorCount,
      battleCount,
      levels,
      events,
      effects: state.ledger.snapshot(),
      finalHero: { health: state.carriedHealth, mana: state.carriedMana },
      // 兼容单层视图
      floorNumber: levels[0]?.floor ?? 1,
      battles: levels.flatMap((level) => level.battles),
    };
  });
}

export function listBattles(repository, limit = 20, userId) {
  return repository.listBattleRuns(limit, userId).map((row) => ({
    battleId: row.id,
    heroId: row.hero_id,
    dungeonName: row.report.dungeonName,
    result: row.report.result,
    rounds: row.report.roundCount,
    createdAt: row.created_at,
  }));
}

export function getBattleDetail(repository, battleId, userId) {
  const row = repository.getBattleRun(battleId, userId);
  if (!row) return null;
  const report = row.report;
  return {
    battleId: row.id,
    heroId: row.hero_id,
    dungeonName: report.dungeonName,
    result: report.result,
    rounds: report.roundCount,
    levelNumber: report.levelNumber,
    battleName: report.battleName,
    roundData: report.rounds,
  };
}

export function listDungeonRuns(repository, limit = 20, userId) {
  return repository.listDungeonRuns(limit, userId).map((row) => ({
    dungeonRunId: row.id,
    heroId: row.hero_id,
    dungeonId: row.dungeon_id,
    dungeonName: row.dungeon_name,
    seed: row.seed,
    rulesetVersion: row.ruleset_version,
    contentVersion: row.content_version,
    result: row.result,
    status: row.status ?? EXPLORATION_STATUS.completed,
    rewards: parseJson(row.rewards_json, {}),
    partyCount: Number(row.party_count ?? 0),
    floorCount: row.floor_count,
    battleCount: row.battle_count,
    createdAt: row.created_at,
  }));
}

/**
 * 删除一条战报记录。
 *
 * 记录、它名下的战斗战报行，以及 data/dungeon_report 下对应的展示 JSON 一起删除，
 * 不可撤销。记录按账号隔离：不存在或不属于该账号时返回 null。
 *
 * @param {object} repository
 * @param {number} dungeonRunId
 * @param {number} [userId]
 * @returns {null | {dungeonRunId:number, deletedBattleIds:number[], removedReportFiles:string[], rewrittenReportFiles:string[], warnings:string[]}}
 */
export function deleteDungeonRun(repository, dungeonRunId, userId) {
  return repository.deleteDungeonRun(dungeonRunId, userId);
}

export function getDungeonRunDetail(repository, dungeonRunId, userId) {
  const row = repository.getDungeonRun(dungeonRunId, userId);
  if (!row) return null;
  const events = parseJson(row.events_json, []);
  return {
    dungeonRunId: row.id,
    heroId: row.hero_id,
    dungeonId: row.dungeon_id,
    dungeonName: row.dungeon_name,
    seed: row.seed,
    rulesetVersion: row.ruleset_version,
    contentVersion: row.content_version,
    result: row.result,
    status: row.status ?? EXPLORATION_STATUS.completed,
    rewards: parseJson(row.rewards_json, {}),
    partyCount: Number(row.party_count ?? 0),
    input: parseJson(row.input_json, {}),
    floorCount: row.floor_count,
    battleCount: row.battle_count,
    levels: parseJson(row.levels_json, []),
    events,
    rendered: renderEvents(events),
    effects: parseJson(row.effects_json, []),
    createdAt: row.created_at,
  };
}

export { RULESET_VERSION, RANDOM_ALGORITHM_VERSION, stableHash, POSITION_LABELS };
