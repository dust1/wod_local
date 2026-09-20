import { parseSummonExpression } from "../game/formulas/summon-expression.mjs";
import { POSITIONS } from "../game/domain/positions.mjs";

const ATTRIBUTE_KEYS = Object.freeze(["strength", "constitution", "intelligence", "dexterity", "charisma", "agility", "perception", "willpower"]);
const text = (value) => String(value ?? "").trim();
const positiveInteger = (value, label, minimum = 1) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${label}必须是不小于 ${minimum} 的整数`);
  return number;
};
const optionalPositiveInteger = (value, label) => value === "" || value == null ? null : positiveInteger(value, label);
const expression = (value, label) => {
  const source = text(value);
  try { parseSummonExpression(source); }
  catch (error) { throw new Error(`${label}无效：${error.message}`); }
  return source;
};

export function summonConfigDto(repository, catalog = null) {
  const definitions = repository.listSummonDefinitions();
  const assignments = repository.listSummonSkillAssignments();
  return {
    archetypes: repository.listSummonArchetypes().map((row) => ({
      id: row.id, name: row.name, description: row.description, active: Boolean(row.active),
      definitions: definitions.filter((entry) => entry.archetype_id === row.id).map((entry) => definitionDto(entry, catalog)),
      skills: assignments.filter((entry) => entry.archetype_id === row.id).map(assignmentDto),
    })),
  };
}

export function definitionDto(row, catalog = null) { return {
  id: row.id, archetypeId: row.archetype_id, summonSkillId: row.summon_skill_id,
  summonSkillName: catalog?.skills?.get(row.summon_skill_id)?.name ?? null,
  recipeType: row.recipe_type, mediumItemId: row.medium_item_id, summonItemId: row.summon_item_id,
  mediumItemName: row.medium_item_name ?? null, summonItemName: row.summon_item_name ?? null,
  summonName: row.summon_name, tier: row.tier, summonLevelExpr: row.summon_level_expr,
  minSummonSkillLevel: row.min_summon_skill_level, maxSummonSkillLevel: row.max_summon_skill_level,
  defaultPosition: row.default_position, sortOrder: row.sort_order, active: Boolean(row.active),
  actionsPerRoundExpr: row.actions_per_round_expr,
  attributes: Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [key, row[`${key}_expr`]])),
}; }

function assignmentDto(row) { return {
  summonSkillId: row.summon_skill_id, skillName: row.skill_name, skillType: row.skill_type,
  unlockSummonSkillLevel: row.unlock_summon_skill_level, skillLevelExpr: row.skill_level_expr,
  sortOrder: row.sort_order, active: Boolean(row.active),
}; }

export function validateArchetypeInput(body, { requireId = true } = {}) {
  const id = text(body.id);
  if (requireId && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("召唤物 ID 只能包含小写字母、数字和连字符，最长 64 位");
  const name = text(body.name);
  if (!name) throw new Error("召唤物名称不能为空");
  return { ...(requireId ? { id } : {}), name, description: text(body.description), active: body.active !== false };
}

function itemSourceId(value, label) {
  const match = String(value ?? "").trim().match(/^(?:item-)?(\d+)$/);
  if (!match) throw new Error(`${label} ID 无效`);
  return positiveInteger(match[1], label);
}

export function validateDefinitionInput(repository, archetypeId, body, excludedId = null, catalog = null) {
  if (!repository.getSummonArchetype(archetypeId)) throw new Error("召唤物不存在");
  const recipeType = body.recipeType === "advanced" ? "advanced" : "direct";
  const summonSkillId = text(body.summonSkillId);
  const summonSkill = catalog?.skills?.get(summonSkillId);
  if (!summonSkill) throw new Error("请选择有效的召唤技能");
  if (summonSkill.baseType !== "summon") throw new Error(`“${summonSkill.name}”不是召唤类型技能`);
  const summonItemId = itemSourceId(body.summonItemId, "召唤物品");
  if (!repository.getCatalogItem(summonItemId)) throw new Error("请选择有效的召唤物品");
  const mediumItemId = recipeType === "advanced" ? itemSourceId(body.mediumItemId, "召唤媒介物品") : null;
  if (mediumItemId && !repository.getCatalogItem(mediumItemId)) throw new Error("请选择有效的召唤媒介物品");
  if (mediumItemId === summonItemId) throw new Error("召唤媒介和召唤物品不能相同");
  const minSummonSkillLevel = positiveInteger(body.minSummonSkillLevel, "最低召唤技能等级");
  const maxSummonSkillLevel = optionalPositiveInteger(body.maxSummonSkillLevel, "最高召唤技能等级");
  if (maxSummonSkillLevel != null && maxSummonSkillLevel < minSummonSkillLevel) throw new Error("最高等级不能低于最低等级");
  const defaultPosition = POSITIONS.includes(body.defaultPosition) ? body.defaultPosition : "rear";
  const attributes = body.attributes ?? {};
  const entry = {
    archetypeId, summonSkillId, recipeType, mediumItemId, summonItemId,
    summonName: text(body.summonName), tier: positiveInteger(body.tier, "阶位"),
    summonLevelExpr: expression(body.summonLevelExpr, "召唤物等级表达式"),
    actionsPerRoundExpr: expression(body.actionsPerRoundExpr ?? "1", "默认行动次数表达式"),
    minSummonSkillLevel, maxSummonSkillLevel, defaultPosition,
    sortOrder: Math.max(0, Number(body.sortOrder) || 0), active: body.active !== false, metadataJson: "{}",
  };
  if (!entry.summonName) throw new Error("形态名称不能为空");
  if (/\bsummonLevel\b/.test(entry.summonLevelExpr)) throw new Error("召唤物等级表达式不能引用自身 summonLevel");
  for (const key of ATTRIBUTE_KEYS) entry[`${key}Expr`] = expression(attributes[key], `${key} 表达式`);
  const overlap = repository.findOverlappingSummonDefinition(entry, excludedId);
  if (overlap) throw new Error(`召唤等级区间与“${overlap.summon_name}”重叠`);
  return entry;
}

export function validateAssignmentInput(repository, archetypeId, body) {
  if (!repository.getSummonArchetype(archetypeId)) throw new Error("召唤物不存在");
  const summonSkillId = positiveInteger(body.summonSkillId, "召唤物技能 ID");
  if (!repository.getSummonSkill(summonSkillId)) throw new Error("请选择有效的召唤物技能");
  return {
    archetypeId, summonSkillId,
    unlockSummonSkillLevel: positiveInteger(body.unlockSummonSkillLevel, "技能解锁等级"),
    skillLevelExpr: expression(body.skillLevelExpr, "技能等级表达式"),
    sortOrder: Math.max(0, Number(body.sortOrder) || 0), active: body.active !== false,
  };
}
