// 八项基础属性与派生属性的稳定定义。纯数据，无 I/O。
// 设计文档 §6.2 / §6.3。

export const ATTRIBUTE_KEYS = Object.freeze([
  "strength",
  "constitution",
  "intelligence",
  "dexterity",
  "charisma",
  "agility",
  "perception",
  "willpower",
]);

export const ATTRIBUTE_LABELS = Object.freeze({
  strength: "力量",
  constitution: "体质",
  intelligence: "智力",
  dexterity: "灵巧",
  charisma: "魅力",
  agility: "敏捷",
  perception: "感知",
  willpower: "意志",
});

/**
 * 英雄从 heroes 表取出后补齐的非持久化基础属性。
 * 这些值是角色规则的一部分，不应散落在应用服务或 UI 中。
 */
export const BASE_CHARACTER_DEFAULTS = Object.freeze({
  allianceFame: 999999,
  healthMax: 1,
  manaMax: 1,
  healthRegeneration: 0,
  manaRegeneration: 0,
  pocketSlots: 15,
  ringSlots: 4,
  medalSlots: 3,
  actionsPerRound: 1,
  initiativeBonus: 0,
});

export const CHARACTER_STAT_LABELS = Object.freeze({
  allianceFame: "联盟荣誉",
  healthMax: "体力上限",
  manaMax: "法力上限",
  healthRegeneration: "体力回复",
  manaRegeneration: "法力回复",
  pocketSlots: "口袋槽位数量",
  ringSlots: "戒指槽位数量",
  medalSlots: "勋章槽位数量",
  actionsPerRound: "每回合行动次数",
  initiative: "先攻",
  initiativeBonus: "先攻附加值",
});

/** 物品/技能 JSON 中的属性目标名统一映射。 */
export const CHARACTER_ATTRIBUTE_TARGET_KEYS = Object.freeze({
  力量: "strength", 体质: "constitution", 智力: "intelligence", 灵巧: "dexterity",
  魅力: "charisma", 敏捷: "agility", 感知: "perception", 意志: "willpower",
  体力: "healthMax", 法力: "manaMax", 体力回复: "healthRegeneration", 法力回复: "manaRegeneration",
  先攻权: "initiative", 每回合行动次数: "actionsPerRound", 荣誉: "fame", 联盟荣誉: "allianceFame",
});

export const BASE_ATTRIBUTE_TARGET_KEYS = ATTRIBUTE_KEYS;
export const DERIVED_CHARACTER_KEYS = Object.freeze([
  "healthMax", "manaMax", "healthRegeneration", "manaRegeneration", "initiative", "actionsPerRound", "fame", "allianceFame",
]);
export const CHARACTER_SLOT_CAPACITY_TARGET_KEYS = Object.freeze({
  "#口袋位": "pocket", "#戒指位": "ring", "#勋章位": "medal", "#颈部位": "neck", "#手部位": "hand",
});

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 八项基础属性的稳定化入口。 */
export function normalizeBaseAttributes(source = {}) {
  return Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [key, finite(source[key], 1)]));
}

/**
 * 基础属性点换算为角色基础数值。默认值先进入计算，再叠加属性换算。
 * 返回精确值和可直接用于计算追踪的分项，供 unit 与 character-instance 共用。
 */
export function deriveBaseCharacterStats(attributes, overrides = {}) {
  const values = normalizeBaseAttributes(attributes);
  const defaults = { ...BASE_CHARACTER_DEFAULTS, ...overrides };
  const healthMax = finite(defaults.healthMax, 1) + values.constitution * 3 + values.strength * 2;
  const manaMax = finite(defaults.manaMax, 1) + values.willpower * 3 + values.intelligence * 2;
  const healthRegeneration = finite(defaults.healthRegeneration, 0) + Math.max(0, Math.floor(values.constitution / 4));
  const manaRegeneration = finite(defaults.manaRegeneration, 0) + Math.max(0, Math.floor(values.willpower / 3));
  const initiative = values.agility * 2 + values.perception + finite(defaults.initiativeBonus, 0);
  return {
    defaults: Object.freeze({
      allianceFame: finite(defaults.allianceFame, 999999),
      healthMax: finite(defaults.healthMax, 1), manaMax: finite(defaults.manaMax, 1),
      healthRegeneration: finite(defaults.healthRegeneration, 0), manaRegeneration: finite(defaults.manaRegeneration, 0),
      pocketSlots: finite(defaults.pocketSlots, 15), ringSlots: finite(defaults.ringSlots, 4), medalSlots: finite(defaults.medalSlots, 3),
      actionsPerRound: finite(defaults.actionsPerRound, 1), initiativeBonus: finite(defaults.initiativeBonus, 0),
    }),
    healthMax,
    allianceFame: finite(defaults.allianceFame, 999999),
    manaMax,
    healthRegeneration,
    manaRegeneration,
    pocketSlots: finite(defaults.pocketSlots, 15),
    ringSlots: finite(defaults.ringSlots, 4),
    medalSlots: finite(defaults.medalSlots, 3),
    actionsPerRound: finite(defaults.actionsPerRound, 1),
    initiativeBonus: finite(defaults.initiativeBonus, 0),
    initiative,
    traces: {
      healthMax: [
        { label: "基础体力", value: finite(defaults.healthMax, 1) },
        { label: "体质 × 3", value: values.constitution * 3 },
        { label: "力量 × 2", value: values.strength * 2 },
      ],
      manaMax: [
        { label: "基础法力", value: finite(defaults.manaMax, 1) },
        { label: "意志 × 3", value: values.willpower * 3 },
        { label: "智力 × 2", value: values.intelligence * 2 },
      ],
      healthRegeneration: [{ label: "基础体力回复 + ⌊体质 ÷ 4⌋", value: healthRegeneration }],
      manaRegeneration: [{ label: "基础法力回复 + ⌊意志 ÷ 3⌋", value: manaRegeneration }],
      initiative: [
        { label: "敏捷 × 2", value: values.agility * 2 },
        { label: "感知", value: values.perception },
        { label: "先攻附加值", value: finite(defaults.initiativeBonus, 0) },
      ],
    },
  };
}

/** heroes 持久化行 → 完整基础人物对象。 */
export function createBaseCharacter(row = {}, overrides = {}) {
  const attributes = normalizeBaseAttributes(row);
  const baseStats = deriveBaseCharacterStats(attributes, overrides);
  return {
    ...row,
    attributes,
    baseStats,
    allianceFame: baseStats.allianceFame,
    healthRegeneration: baseStats.healthRegeneration,
    manaRegeneration: baseStats.manaRegeneration,
    actionsPerRoundExact: baseStats.actionsPerRound,
    initiativeBonus: baseStats.initiativeBonus,
  };
}

const ATTRIBUTE_KEY_SET = new Set(ATTRIBUTE_KEYS);

export function isAttributeKey(key) {
  return ATTRIBUTE_KEY_SET.has(key);
}

/** 属性来源层，顺序即合成顺序。 */
export const ATTRIBUTE_LAYERS = Object.freeze([
  "base",
  "permanent",
  "dungeonSnapshot",
  "liveEffect",
]);

/**
 * 按文档 §6.2 合成一条属性的精确值。
 * 属性没有“百分比连乘”以外的特殊规则，百分比来自各层的百分比修正。
 * 返回 exact（未取整）与 applied（使用时向下取整，最低 1）。
 */
export function composeAttribute(layers = {}) {
  const base = Number(layers.base ?? 1);
  const percentMultiplier = (layers.percentages ?? []).reduce((value, percent) => value * (1 + percent / 100), 1);
  const flat = (layers.flats ?? []).reduce((sum, value) => sum + value, 0);
  const exact = base * percentMultiplier + flat;
  return {
    exact,
    applied: Math.max(1, Math.floor(exact)),
    percentMultiplier,
    flat,
  };
}

export const DERIVED_STATS = Object.freeze([
  "healthMax",
  "manaMax",
  "healthRegeneration",
  "manaRegeneration",
  "actionsPerRound",
  "initiativeBonus",
  "attack",
  "defense",
  "armor",
  "resistance",
  "damageBonus",
]);
