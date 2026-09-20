// 人工校正 / 起步内容。设计文档 §20：overrides 必须注明证据。
//
// 证据来源：
// - 基础：剑术 的属性绑定、攻击方式、物品需求与使用时机直接来自
//   冻结技能内容快照中的原始技能页。
// - 其余技能用于驱动引擎与界面，属于最小可用内容集；未从原始页校验的部分
//   在 evidence 字段中标注为 "unverified"，不得当作正式规则。
// 本文件只包含纯数据，不含可执行 JavaScript 逻辑（设计文档 §20.1）。

export const STARTER_SKILLS = [
  {
    id: "basic-swordsmanship",
    sourceId: 140,
    name: "基础：剑术",
    baseType: "attack",
    attackType: "近战",
    damageType: "切割伤害",
    // 技能页“可以被用于”只列出主回合；防御属性绑定用于一般设置中的默认防御技能（§17.5）。
    timing: { preRound: false, mainAction: true, initiative: false, reactiveDefense: false, passive: false },
    target: { side: "enemy", mode: "single", maxTargets: 1, allowSummons: true, rawText: "一个敌人" },
    attributeFormula: {
      attack: { primary: "dexterity", secondary: "agility" },
      defense: { primary: "dexterity", secondary: "agility" },
      damage: { primary: "strength", secondary: "agility" },
    },
    manaCost: null,
    itemRequirement: { rawText: "剑", itemTypeName: "剑", categories: [3] },
    effects: [],
    evidence: { attackType: "A: skill_cache 原始页", attributes: "A: skill_cache 原始页", timing: "A: 技能页只列出主回合", damageType: "unverified" },
  },
  {
    id: "action-keen-sight",
    sourceId: 0,
    name: "行动：敏锐目光",
    baseType: "initiative",
    attackType: null,
    timing: { preRound: false, mainAction: false, initiative: true, reactiveDefense: false, passive: false },
    target: { side: "ally", mode: "self", maxTargets: 1, allowSummons: true, rawText: "自己" },
    attributeFormula: { attack: { primary: "agility", secondary: "perception" } },
    manaCost: { standard: 4, display: 4 },
    itemRequirement: null,
    effects: [],
    evidence: { whole: "unverified: 起步内容" },
  },
  {
    id: "survival-bandage",
    sourceId: 0,
    name: "生存：包扎",
    baseType: "heal",
    attackType: null,
    timing: { preRound: false, mainAction: true, initiative: false, reactiveDefense: false, passive: false },
    target: { side: "ally", mode: "single", maxTargets: 1, allowSummons: true, rawText: "一个队友" },
    attributeFormula: { damage: { primary: "intelligence", secondary: "dexterity" } },
    manaCost: { standard: 6, display: 6 },
    itemRequirement: null,
    effects: [],
    evidence: { whole: "unverified: 起步内容，治疗量公式尚未确认（§25.6）" },
  },
  {
    id: "guard-stance",
    sourceId: 0,
    name: "架势：守势",
    baseType: "improve",
    attackType: null,
    timing: { preRound: true, mainAction: false, initiative: false, reactiveDefense: false, passive: false },
    target: { side: "ally", mode: "self", maxTargets: 1, allowSummons: true, rawText: "自己" },
    attributeFormula: null,
    manaCost: { standard: 8, display: 8 },
    itemRequirement: null,
    effects: [
      {
        id: "guard-stance-armor",
        name: "守势",
        duration: { kind: "rounds", value: 1 },
        activation: { kind: "immediate" },
        applicationGroup: "guard",
        modifiers: [
          { kind: "flat", value: 20, target: { type: "armor", damageType: "近战" }, source: "guard-stance-armor" },
        ],
        experimental: true,
      },
    ],
    evidence: { whole: "unverified: 起步内容，用于验证效果持续时间与同源不叠加" },
  },
  {
    id: "call-familiar",
    sourceId: 0,
    name: "召唤：林地伙伴",
    baseType: "summon",
    attackType: null,
    timing: { preRound: true, mainAction: true, initiative: false, reactiveDefense: false, passive: false },
    target: { side: "ally", mode: "self", maxTargets: 1, allowSummons: false, rawText: "自己" },
    attributeFormula: null,
    manaCost: { standard: 12, display: 12 },
    itemRequirement: null,
    effects: [],
    summonTemplate: {
      name: "林地狼",
      level: 1,
      position: "front",
      attributes: { strength: 6, constitution: 6, intelligence: 1, dexterity: 8, charisma: 1, agility: 10, perception: 6, willpower: 2 },
      skills: { "familiar-bite": { baseLevel: 2 } },
      actionsPerRoundExact: 1,
      summonUpkeep: { resource: "mana", amount: 3 },
    },
    evidence: { whole: "unverified: 起步内容，用于验证召唤生命周期与维持费用" },
  },
  {
    id: "familiar-bite",
    sourceId: 0,
    name: "撕咬",
    baseType: "attack",
    attackType: "近战",
    damageType: "穿刺伤害",
    timing: { preRound: false, mainAction: true, initiative: false, reactiveDefense: false, passive: false },
    target: { side: "enemy", mode: "single", maxTargets: 1, allowSummons: true, rawText: "一个敌人" },
    attributeFormula: {
      attack: { primary: "agility", secondary: "dexterity" },
      defense: { primary: "agility", secondary: "dexterity" },
      damage: { primary: "strength", secondary: "agility" },
    },
    manaCost: null,
    itemRequirement: null,
    effects: [],
    evidence: { whole: "unverified: 起步内容" },
  },
  {
    id: "club-strike",
    sourceId: 0,
    name: "棍击",
    baseType: "attack",
    attackType: "近战",
    damageType: "钝击伤害",
    timing: { preRound: false, mainAction: true, initiative: false, reactiveDefense: true, passive: false },
    target: { side: "enemy", mode: "single", maxTargets: 1, allowSummons: true, rawText: "一个敌人" },
    attributeFormula: {
      attack: { primary: "strength", secondary: "dexterity" },
      defense: { primary: "dexterity", secondary: "agility" },
      damage: { primary: "strength", secondary: "constitution" },
    },
    manaCost: null,
    itemRequirement: null,
    effects: [],
    evidence: { whole: "unverified: 起步内容，用于对手方" },
  },
];

/** 供测试与本地演示使用的最小物品索引。 */
export const STARTER_ITEMS = [
  { id: "item-sword", name: "短剑", equipSlot: "right_hand", uniqueness: "none", requires: [], modifiers: [] },
  { id: "item-bow", name: "短弓", equipSlot: "two_hands", uniqueness: "none", requires: ["item-arrow"], modifiers: [] },
  { id: "item-arrow", name: "箭", equipSlot: "pocket", uniqueness: "none", requires: [], modifiers: [] },
];

export const STARTER_SKILL_BY_ID = Object.fromEntries(STARTER_SKILLS.map((skill) => [skill.id, skill]));
export const STARTER_ITEM_BY_ID = Object.fromEntries(STARTER_ITEMS.map((item) => [item.id, item]));
