// 角色实例：技能「作用在技能拥有者上的效果」与物品「作用在物品持有者上的效果」
// 的解析、分类、加成合成。设计文档 §8.6、§8.7、§9、§9.7、§14。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ATTRIBUTE_TARGET_KEYS,
  classifyHolderRecord,
  parseCorrection,
  parseGradeCorrection,
  readHolderEffects,
} from "../game/domain/holder-effect.mjs";
import {
  buildCombatTables,
  capEquipmentLevelBonus,
  createCharacterInstance,
  resolveTerm,
  skillCategoryPrefix,
  sumLevelTerms,
} from "../game/domain/character-instance.mjs";
import { applyModifierPipeline } from "../game/modifiers/pipeline.mjs";

test("角色实例保留脆弱性的独立百分比项及缩放后的固定百分点", () => {
  const parsed = parseCorrection("0.34x英雄等级");
  assert.equal(parsed.unparsed.length, 0);
  assert.ok(Math.abs(resolveTerm(parsed.terms[0], { heroLevel: 20 }).value - 6.8) < 1e-9);
  const target = { type: "vulnerability", damageType: "切割伤害", attackType: "近战", grade: "normal" };
  const rows = buildCombatTables([
    { target, kind: "percent", value: -20, sourceLabel: "装备一" },
    { target, kind: "percent", value: -20, sourceLabel: "装备二" },
    { target, kind: "flat", value: 6.8, sourceLabel: "等级换算" },
  ]).vulnerability;
  assert.deepEqual(rows[0].percentTerms[0], [-20, -20]);
  assert.equal(rows[0].values[0], 6.8);
});

const HERO = {
  id: 1,
  name: "测试英雄",
  level: 20,
  attributes: { strength: 10, constitution: 10, intelligence: 10, dexterity: 10, charisma: 10, agility: 10, perception: 10, willpower: 10 },
  healthRegeneration: 2,
  manaRegeneration: 3,
  actionsPerRoundExact: 1,
  initiativeBonus: 0,
  fame: 0,
};

/** 物品详情：持有者效果段落。 */
function itemDetail(effects) {
  return { 物品名称: "测试物品", 作用在物品持有者上的效果: effects };
}

/** 技能详情：拥有者效果段落。 */
function skillDetail(effects) {
  return { 技能名称: "测试技能", 作用在技能拥有者上的效果: effects, 作用在被此技能影响的目标上的效果: [] };
}

function itemSetDetail(effects) {
  return { 套装名称: "测试套装", 作用在装备者上的效果: effects, 作用在被影响的目标上的效果: [{ 类型: "属性奖励", 属性: "力量", 修正: "+99" }] };
}

// ---------------------------------------------------------------- 修正写法解析

test("修正文本覆盖全部实测写法", () => {
  assert.deepEqual(parseCorrection("+3").terms, [{ kind: "flat", value: 3, rawText: "+3" }]);
  assert.deepEqual(parseCorrection("-25%").terms, [{ kind: "percent", value: -25, rawText: "-25%" }]);
  assert.deepEqual(parseCorrection("+技能等级").terms, [{ kind: "scaledFlat", scale: "skillLevel", ratio: 1, rawText: "+技能等级" }]);
  assert.deepEqual(parseCorrection("-英雄等级").terms, [{ kind: "scaledFlat", scale: "heroLevel", ratio: -1, rawText: "-英雄等级" }]);
  assert.deepEqual(parseCorrection("+50%×技能等级").terms, [{ kind: "scaledValue", scale: "skillLevel", ratio: 50, rawText: "+50%×技能等级" }]);
  assert.deepEqual(parseCorrection("+20%×英雄等级").terms, [{ kind: "scaledValue", scale: "heroLevel", ratio: 20, rawText: "+20%×英雄等级" }]);
  // 实测存在的无百分号乘号变体。
  assert.deepEqual(parseCorrection("+75 x 英雄等级").terms, [{ kind: "scaledFlat", scale: "heroLevel", ratio: 75, rawText: "+75 x 英雄等级" }]);
});

test("复合修正按项拆分，且裸符号不产生噪声告警", () => {
  assert.deepEqual(parseCorrection("+1 -15%").terms, [
    { kind: "flat", value: 1, rawText: "+1" },
    { kind: "percent", value: -15, rawText: "-15%" },
  ]);
  assert.deepEqual(parseCorrection("-1 -25%×技能等级").terms, [
    { kind: "flat", value: -1, rawText: "-1" },
    { kind: "scaledValue", scale: "skillLevel", ratio: -25, rawText: "-25%×技能等级" },
  ]);
  // 残缺单元格「+」在真实数据里存在，不应报未识别。
  assert.deepEqual(parseCorrection("+").unparsed, []);
  assert.deepEqual(parseCorrection("").terms, []);
});

test("(r) 三元组按 普通/重击/致命 拆档", () => {
  const grades = parseGradeCorrection("+3 / +2 / +1");
  assert.deepEqual(grades.map((grade) => grade.grade), ["normal", "critical", "lethal"]);
  assert.deepEqual(grades.map((grade) => grade.terms[0].value), [3, 2, 1]);
  assert.deepEqual(grades.map((grade) => grade.gradeLabel), ["普通", "重击", "致命"]);
});

test("按等级缩放的修正在给定上下文中求值", () => {
  const term = { kind: "scaledValue", scale: "heroLevel", ratio: 20 };
  assert.deepEqual(resolveTerm(term, { heroLevel: 26 }), { unit: "flat", value: 5.2 });
  assert.deepEqual(resolveTerm({ kind: "scaledFlat", scale: "skillLevel", ratio: 1 }, { skillLevel: 7 }), { unit: "flat", value: 7 });
});

// ---------------------------------------------------------------- 分类

test("九种效果类型与装备位容量都能正确归类", () => {
  const cases = [
    [{ 类型: "属性奖励", 属性: "敏捷", 修正: "-1" }, { bucket: "attribute", targetKey: "agility", dimension: "attribute" }],
    [{ 类型: "对技能等级的奖励", 技能: "基础：剑术", 修正: "+3" }, { bucket: "skillLevel", targetName: "基础：剑术", dimension: "skill" }],
    [{ 类型: "对技能效果的奖励", 技能: "派生：抵近射击", 修正: "+4" }, { bucket: "skillEffect", dimension: "skill" }],
    [{ 类型: "攻击奖励", 攻击方式: "近战", 修正: "+4" }, { bucket: "attack", targetName: "近战", dimension: "attackType" }],
    [{ 类型: "防御奖励", 攻击方式: "近战", 修正: "+10 (a)" }, { bucket: "defense", onUseOnly: true }],
    [{ 类型: "护甲奖励", 伤害方式: "粉碎伤害", 攻击方式: "所有", "护甲(r)": "+1 / +1 / 0" }, { bucket: "armor", attackScope: "所有", dimension: "damageType" }],
    [{ 类型: "伤害奖励", 伤害方式: "黑暗伤害", 攻击方式: "所有", "伤害奖励(r)": "+1 / +2 / +4 (z)" }, { bucket: "damage", damageTypeOnly: true }],
    [{ 类型: "对此种攻击方式，攻击类型伤害的脆弱性", 伤害方式: "切割伤害", 攻击方式: "所有", "奖励(r)": "-5% / -4% / -3%" }, { bucket: "vulnerability" }],
    [{ 类型: "地城探险得到的物品掉落奖励", 奖励: "每次地城探险得到的金币奖励", 修正: "+5%" }, { bucket: "dungeonLoot", dimension: "loot" }],
    [{ 类型: "属性奖励", 属性: "#口袋位", 修正: "+1" }, { bucket: "slotCapacity", targetKey: "pocket" }],
  ];
  for (const [record, expected] of cases) {
    const classified = classifyHolderRecord(record);
    assert.ok(classified, `未能归类: ${JSON.stringify(record)}`);
    for (const [key, value] of Object.entries(expected)) assert.equal(classified[key], value, `${record.类型} 的 ${key}`);
  }
  assert.equal(classifyHolderRecord({ 类型: "未知类型" }), null);
});

test("属性目标名映射到八项属性与派生属性", () => {
  assert.equal(ATTRIBUTE_TARGET_KEYS.力量, "strength");
  assert.equal(ATTRIBUTE_TARGET_KEYS.意志, "willpower");
  assert.equal(ATTRIBUTE_TARGET_KEYS.体力, "healthMax");
  assert.equal(ATTRIBUTE_TARGET_KEYS.法力回复, "manaRegeneration");
  assert.equal(ATTRIBUTE_TARGET_KEYS.先攻权, "initiative");
});

test("技能类别目标可被识别并把前缀切出来", () => {
  assert.equal(skillCategoryPrefix("近战攻击类别的所有技能"), "近战攻击");
  assert.equal(skillCategoryPrefix("基础：剑术"), null);
  const classified = classifyHolderRecord({ 类型: "对技能等级的奖励", 技能: "专精 类别的所有技能", 修正: "+2" });
  assert.equal(classified.skillCategory, true);
});

// ---------------------------------------------------------------- 技能等级语义

test("技能等级奖励把 +技能等级 与 +N%×技能等级 都折算成等级数", () => {
  // 技能等级 6：+技能等级 → +6 级；+50%×技能等级 → +3 级。
  assert.equal(sumLevelTerms([{ kind: "scaledFlat", scale: "skillLevel", ratio: 1 }], { skillLevel: 6 }), 6);
  assert.equal(sumLevelTerms([{ kind: "scaledValue", scale: "skillLevel", ratio: 50 }], { skillLevel: 6 }), 3);
  assert.equal(sumLevelTerms([{ kind: "flat", value: 2 }, { kind: "scaledValue", scale: "skillLevel", ratio: 50 }], { skillLevel: 4 }), 4);
});

test("装备提供的技能等级加成不超过技能基础等级", () => {
  assert.equal(capEquipmentLevelBonus(10, 4), 4);
  assert.equal(capEquipmentLevelBonus(2, 4), 2);
  assert.equal(capEquipmentLevelBonus(-3, 4), 0);
});

test("技能等级以基础加装备为百分比基数，百分比连乘后再加固定奖励", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [{ itemId: 1, name: "训练手册", detail: itemDetail([
      { 类型: "对技能等级的奖励", 技能: "基础：剑术", 修正: "+6" },
    ]) }],
    itemSets: [{ setName: "百分比套装", pieceCount: 2, detail: itemSetDetail([
      { 类型: "对技能等级的奖励", 技能: "基础：剑术", 修正: "+20%" },
      { 类型: "对技能等级的奖励", 技能: "基础：剑术", 修正: "+20%" },
      { 类型: "对技能等级的奖励", 技能: "基础：剑术", 修正: "+300" },
    ]) }],
    skills: [{ sourceSkillId: 140, name: "基础：剑术", level: 5, equipmentBonus: 4, detail: skillDetail([]) }],
  });
  const skill = instance.skills[0];
  // 数据库装备 +4 与物品 +6 合并后只生效 +5，不能分别各吃一次上限。
  assert.equal(skill.equipmentLevelBonusApplied, 5);
  assert.equal(skill.equipmentLevelBonus + skill.itemLevelBonus, 5);
  assert.equal(skill.percentageBase, 10);
  assert.deepEqual(skill.percentageBonuses, [20, 20]);
  assert.equal(skill.percentMultiplier, 1.44);
  assert.equal(skill.postPercentFlatBonus, 300);
  assert.equal(skill.liveLevel, 314.4);
});

test("装备上限只约束装备本体，套装的技能等级加成不受约束", () => {
  const fromItem = createCharacterInstance({
    hero: HERO,
    equippedItems: [{ itemId: 1, name: "训练手册", detail: itemDetail([{ 类型: "对技能等级的奖励", 技能: "基础：剑术", 修正: "+5" }]) }],
    skills: [{ sourceSkillId: 140, name: "基础：剑术", level: 2, detail: skillDetail([]) }],
  });
  // 装备本体：+5 被截断到基础等级 2。
  assert.equal(fromItem.skills[0].itemLevelBonus, 2);
  assert.equal(fromItem.skills[0].liveLevel, 4);

  const fromSet = createCharacterInstance({
    hero: HERO,
    equippedItems: [],
    itemSets: [{ setName: "测试套装", pieceCount: 3, detail: itemSetDetail([{ 类型: "对技能等级的奖励", 技能: "基础：剑术", 修正: "+5" }]) }],
    skills: [{ sourceSkillId: 140, name: "基础：剑术", level: 2, detail: skillDetail([]) }],
  });
  // 套装属非装备直接来源：+5 完整生效（设计文档 §8.7）。
  assert.equal(fromSet.skills[0].itemLevelBonus, 0);
  assert.equal(fromSet.skills[0].setLevelBonus, 5);
  assert.equal(fromSet.skills[0].liveLevel, 7);
});

test("套装 +9999 抵消技能自身的 -9999 门槛后技能等级回到已学等级", () => {
  // 「紫衣宰相」给「传承：凡世的理想乡」+9999，该技能自身的拥有者效果是 -9999，
  // 两者相抵后实时等级应等于已学等级，而不是被装备上限截断成 0。
  const name = "传承：凡世的理想乡";
  const instance = createCharacterInstance({
    hero: { ...HERO, level: 40 },
    equippedItems: [],
    itemSets: [{
      setName: "紫衣宰相",
      pieceCount: 5,
      detail: itemSetDetail([{ 类型: "对技能等级的奖励", 技能: name, 修正: "+9999" }]),
    }],
    skills: [{ sourceSkillId: 1888, name, level: 2, detail: skillDetail([{ 类型: "对技能等级的奖励", 技能: name, 修正: "-9999" }]) }],
  });
  const skill = instance.skills[0];
  assert.equal(skill.baseLevel, 2);
  assert.equal(skill.setLevelBonus, 9999);
  assert.equal(skill.skillLevelBonus, -9999);
  assert.equal(skill.liveLevel, 2);
  assert.equal(skill.levelDelta, 0);

  // 未穿套装时该技能被自身门槛压到 0 级：装备套装正是使用它的前提。
  const withoutSet = createCharacterInstance({
    hero: { ...HERO, level: 40 },
    equippedItems: [],
    skills: [{ sourceSkillId: 1888, name, level: 2, detail: skillDetail([{ 类型: "对技能等级的奖励", 技能: name, 修正: "-9999" }]) }],
  });
  assert.equal(withoutSet.skills[0].liveLevel, 0);
});

// ---------------------------------------------------------------- 加成合成

test("装备与技能的属性加成分别归因，并可累加回生效值", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [{ itemId: 1, name: "力量护腕", detail: itemDetail([{ 类型: "属性奖励", 属性: "力量", 修正: "+4" }]) }],
    skills: [{ sourceSkillId: 1, name: "力量训练", level: 1, detail: skillDetail([{ 类型: "属性奖励", 属性: "力量", 修正: "+2" }]) }],
  });
  const strength = instance.attributes.find((entry) => entry.key === "strength");
  assert.equal(strength.base, 10);
  assert.equal(strength.equipmentDelta, 4);
  assert.equal(strength.skillDelta, 2);
  assert.equal(strength.effective, 16);
  assert.equal(strength.base + strength.equipmentDelta + strength.skillDelta, strength.effective);
  assert.deepEqual(strength.contributors.map((entry) => entry.sourceLabel), ["装备：力量护腕", "技能：力量训练"]);
});

test("种族与职业天生加成作为独立来源应用到属性、攻防与技能等级", () => {
  const instance = createCharacterInstance({
    hero: { ...HERO, level: 10 },
    innateSources: [
      { kind: "race", id: "test-race", name: "测试种族", detail: { "作用在角色上的效果": [
        { 类型: "属性奖励", 属性: "力量", 修正: "+1" },
        { 类型: "攻击奖励", 攻击方式: "近战", 修正: "+2 +20%×英雄等级" },
      ] } },
      { kind: "profession", id: "test-profession", name: "测试职业", detail: { "作用在角色上的效果": [
        { 类型: "属性奖励", 属性: "智力", 修正: "+2" },
        { 类型: "对技能等级的奖励", 技能: "强化：迅捷", 修正: "-2" },
      ] } },
    ],
    equippedItems: [],
    skills: [{ sourceSkillId: 1, name: "强化：迅捷", level: 5, detail: skillDetail([]) }],
  });
  const strength = instance.attributes.find((entry) => entry.key === "strength");
  const intelligence = instance.attributes.find((entry) => entry.key === "intelligence");
  assert.equal(strength.skillDelta, 1);
  assert.equal(intelligence.skillDelta, 2);
  assert.deepEqual(strength.contributors.map((entry) => entry.sourceLabel), ["种族：测试种族"]);
  assert.deepEqual(intelligence.contributors.map((entry) => entry.sourceLabel), ["职业：测试职业"]);
  assert.equal(instance.skills[0].liveLevel, 3);
  assert.deepEqual(instance.skills[0].levelSources.map((entry) => entry.sourceLabel), ["职业：测试职业"]);
  const melee = instance.combat.attackBonuses.find((entry) => entry.label === "近战");
  assert.equal(melee.flat, 4);
  assert.deepEqual(melee.sources.map((entry) => entry.sourceLabel), ["种族：测试种族"]);
});

test("技能拥有者的按技能等级属性奖励使用最终实时等级", () => {
  const instance = createCharacterInstance({
    hero: { ...HERO, charisma: 3 },
    equippedItems: [],
    itemSets: [{ setName: "等级套装", pieceCount: 1, detail: itemSetDetail([
      { 类型: "对技能等级的奖励", 技能: "强化：非凡魅力", 修正: "+2" },
      { 类型: "对技能等级的奖励", 技能: "知识的传播者", 修正: "+20" },
    ]) }],
    skills: [
      { sourceSkillId: 359, name: "强化：非凡魅力", level: 6, detail: skillDetail([{ 类型: "属性奖励", 属性: "魅力", 修正: "+50%×技能等级" }]) },
      { sourceSkillId: 1038, name: "知识的传播者", level: 1, detail: skillDetail([{ 类型: "属性奖励", 属性: "魅力", 修正: "+20%×技能等级" }]) },
    ],
  });
  const charisma = instance.attributes.find((entry) => entry.key === "charisma");
  assert.deepEqual(instance.skills.map((skill) => skill.liveLevel), [8, 21]);
  assert.equal(charisma.skillDelta, 8);
  assert.equal(charisma.exact, 18.2);
  assert.deepEqual(charisma.modifiers.filter((modifier) => modifier.sourceKind === "skill").map((modifier) => modifier.value), [4, 4.2]);
});

test("技能阶段保留装备对法力与法力回复的直接修正", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [{ itemId: 37252, name: "法力之源", detail: itemDetail([
      { 类型: "属性奖励", 属性: "法力", 修正: "+20 -25% +50%×英雄等级" },
      { 类型: "属性奖励", 属性: "法力回复", 修正: "+17%×英雄等级" },
    ]) }],
    skills: [{ sourceSkillId: 1, name: "法力约束", level: 1, detail: skillDetail([
      { 类型: "属性奖励", 属性: "法力", 修正: "-5" },
      { 类型: "属性奖励", 属性: "法力回复", 修正: "-1" },
    ]) }],
  });
  assert.deepEqual(
    { base: instance.derived.manaMax.base, equipment: instance.derived.manaMax.equipmentDelta, skill: instance.derived.manaMax.skillDelta, effective: instance.derived.manaMax.effective },
    { base: 51, equipment: 17, skill: -5, effective: 63 },
  );
  assert.deepEqual(
    { base: instance.derived.manaRegeneration.base, equipment: instance.derived.manaRegeneration.equipmentDelta, skill: instance.derived.manaRegeneration.skillDelta, effective: instance.derived.manaRegeneration.effective },
    { base: 3, equipment: 3, skill: -1, effective: 5 },
  );
  assert.equal(instance.derived.manaMax.contributors.some((entry) => entry.sourceLabel === "装备：法力之源"), true);
  assert.equal(instance.derived.manaMax.contributors.some((entry) => entry.sourceLabel === "技能：法力约束"), true);
});

test("物品套装只加持精确件数 JSON 中作用在装备者上的效果", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [],
    itemSets: [{ setName: "测试套装", pieceCount: 3, detail: itemSetDetail([{ 类型: "属性奖励", 属性: "力量", 修正: "+4" }]) }],
    skills: [],
  });
  const strength = instance.attributes.find((entry) => entry.key === "strength");
  assert.equal(strength.equipmentDelta, 4);
  assert.equal(strength.effective, 14);
  assert.deepEqual(strength.contributors.map((entry) => entry.sourceLabel), ["套装：测试套装（3件）"]);
  assert.equal(instance.sources.filter((source) => source.sourceKind === "itemSet").length, 1);
});

test("属性加成会顺延到由它推出的派生属性", () => {
  const withoutItem = createCharacterInstance({ hero: HERO, equippedItems: [], skills: [] });
  const withItem = createCharacterInstance({
    hero: HERO,
    equippedItems: [{ itemId: 1, name: "体质护符", detail: itemDetail([{ 类型: "属性奖励", 属性: "体质", 修正: "+5" }]) }],
    skills: [],
  });
  // 体力上限 = 体质 × 3 + 力量 × 2，体质 +5 应带来 +15。
  assert.equal(withItem.derived.healthMax.effective - withoutItem.derived.healthMax.effective, 15);
  assert.equal(withItem.derived.healthMax.base, withoutItem.derived.healthMax.base);
});

test("带 (a) 标记的效果不计入常驻数值，单独收集", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [{
      itemId: 1,
      name: "旧剑",
      detail: itemDetail([
        { 类型: "对技能等级的奖励", 技能: "基础：剑术", 修正: "+3" },
        { 类型: "防御奖励", 攻击方式: "近战", 修正: "+10 (a)" },
      ]),
    }],
    skills: [{ sourceSkillId: 140, name: "基础：剑术", level: 6, skillType: "近战攻击", detail: skillDetail([{ 类型: "防御奖励", 攻击方式: "近战", 修正: "-20% (a)" }]) }],
  });
  assert.equal(instance.skills[0].itemLevelBonus, 3);
  assert.equal(instance.skills[0].liveLevel, 9);
  // (a) 效果不进常驻战斗属性。
  assert.deepEqual(instance.combat.defenseBonuses, []);
  assert.equal(instance.onUseOnly.length, 2);
  assert.deepEqual(instance.onUseOnly.map((entry) => entry.sourceName).sort(), ["基础：剑术", "旧剑"]);
});

test("护甲与损害的 (r) 三档位分别累加", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [
      { itemId: 1, name: "手套", detail: itemDetail([{ 类型: "护甲奖励", 伤害方式: "粉碎伤害", 攻击方式: "所有", "护甲(r)": "+1 / +1 / 0" }]) },
      { itemId: 2, name: "护腿", detail: itemDetail([{ 类型: "护甲奖励", 伤害方式: "粉碎伤害", 攻击方式: "所有", "护甲(r)": "+1 / 0 / 0" }]) },
      { itemId: 3, name: "皮衣", detail: itemDetail([{ 类型: "护甲奖励", 伤害方式: "粉碎伤害", 攻击方式: "所有", "护甲(r)": "+1 / 0 / 0" }]) },
    ],
    skills: [],
  });
  const row = instance.combat.armor.find((entry) => entry.damageType === "粉碎伤害");
  assert.deepEqual(row.values, [3, 1, 0]);
  assert.equal(row.attackType, "所有");
  assert.equal(row.text, "+3 / +1 / 0");
  assert.equal(row.sources.length, 3);
});

test("攻击与防御奖励区分裸百分比和按等级换算的固定值", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [
      { itemId: 1, name: "皮帽", detail: itemDetail([{ 类型: "攻击奖励", 攻击方式: "近战", 修正: "+4" }]) },
      { itemId: 2, name: "护肩", detail: itemDetail([{ 类型: "防御奖励", 攻击方式: "魔法", 修正: "+2" }, { 类型: "防御奖励", 攻击方式: "近战", 修正: "+10%×英雄等级" }]) },
    ],
    skills: [],
  });
  assert.deepEqual(instance.combat.attackBonuses.map((row) => [row.label, row.flat]), [["近战", 4]]);
  const defense = Object.fromEntries(instance.combat.defenseBonuses.map((row) => [row.label, row]));
  assert.equal(defense.魔法.flat, 2);
  // +10%×英雄等级、英雄 20 级 → 固定 +2。
  assert.equal(defense.近战.flat, 2);
  assert.equal(defense.近战.percent, 0);
});

test("技能来源的按技能等级缩放修正使用该技能自身的等级", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [],
    skills: [{ sourceSkillId: 5, name: "血脉：健康", level: 2, detail: skillDetail([{ 类型: "防御奖励", 攻击方式: "病毒", 修正: "+125%×技能等级" }]) }],
  });
  const row = instance.combat.defenseBonuses.find((entry) => entry.label === "病毒");
  // 125% × 技能等级 2 → 固定 +2.5。
  assert.equal(row.flat, 2.5);
  assert.equal(row.percent, 0);
});

test("裸百分比仍按先乘后加管线计算", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [{ itemId: 3, name: "复合力量饰品", detail: itemDetail([
      { 类型: "属性奖励", 属性: "力量", 修正: "+1 +10%" },
    ]) }],
    skills: [],
  });
  const strength = instance.attributes.find((entry) => entry.key === "strength");
  assert.equal(strength.effective, 12); // 10 × 1.1 + 1
});

test("未学（等级为 0）的技能不提供拥有者效果", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [],
    skills: [{ sourceSkillId: 9, name: "未学技能", level: 0, detail: skillDetail([{ 类型: "属性奖励", 属性: "力量", 修正: "+10" }]) }],
  });
  assert.equal(instance.attributes.find((entry) => entry.key === "strength").effective, 10);
});

test("缺少详情数据的来源被显式登记，而不是静默当作没有效果", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [{ itemId: 77, name: "无详情物品", detail: null }],
    skills: [],
  });
  assert.equal(instance.missingSources.length, 1);
  assert.equal(instance.missingSources[0].kind, "item");
  assert.equal(instance.missingSources[0].reason, "detailUnavailable");
});

test("角色实例可直接作为 deriveUnit 的效果来源", () => {
  const instance = createCharacterInstance({
    hero: HERO,
    equippedItems: [{ itemId: 1, name: "力量护腕", detail: itemDetail([{ 类型: "属性奖励", 属性: "力量", 修正: "+6" }]) }],
    skills: [],
  });
  const modifiers = instance.modifiersFor("any-target");
  assert.equal(modifiers.length, 1);
  assert.equal(modifiers[0].target.type, "attribute");
  assert.equal(modifiers[0].target.key, "strength");
  // 修正已求值，可直接进管线。
  assert.equal(applyModifierPipeline(10, { modifiers }).exact, 16);
});

test("战斗属性表在无修正时为空", () => {
  const tables = buildCombatTables([]);
  assert.deepEqual(tables.armor, []);
  assert.deepEqual(tables.attackBonuses, []);
});

// ---------------------------------------------------------------- 真实数据契约

const realItem = resolve("data", "items", "24058.json");
const scaledGradeItem = resolve("data", "items", "31373.json");
const realSkill = resolve("data", "profession_skills", "140.json");

test("真实物品页的持有者效果能被解析并生效", { skip: !existsSync(realItem) }, () => {
  const detail = JSON.parse(readFileSync(realItem, "utf8"));
  const { entries, warnings } = readHolderEffects(detail, { kind: "item", id: 24058, name: detail["物品名称"] });
  assert.equal(entries.length, 2);
  assert.deepEqual(warnings, []);
  const levelBonus = entries.find((entry) => entry.bucket === "skillLevel");
  assert.equal(levelBonus.targetName, "基础：剑术");
  assert.deepEqual(levelBonus.terms, [{ kind: "flat", value: 3, rawText: "+3" }]);
  const defense = entries.find((entry) => entry.bucket === "defense");
  assert.equal(defense.onUseOnly, true);
  assert.equal(defense.targetName, "近战");
});

test("百分比乘英雄等级在三档伤害中换算为固定值", { skip: !existsSync(scaledGradeItem) }, () => {
  const detail = JSON.parse(readFileSync(scaledGradeItem, "utf8"));
  const instance = createCharacterInstance({
    hero: { ...HERO, level: 40 },
    equippedItems: [{ itemId: 31373, name: detail["物品名称"], detail }],
    skills: [],
  });
  const damage = instance.onUseOnly.find((entry) => entry.bucket === "damage"
    && entry.targetName === "神圣伤害" && entry.rawText.includes("25%×英雄等级"));
  assert.ok(damage);
  assert.deepEqual(damage.values, [18, 26, 34]);
  assert.deepEqual(damage.percents, [0, 0, 0]);
  assert.equal(damage.text, "+18 / +26 / +34");
});

test("真实技能页的拥有者效果能被解析", { skip: !existsSync(realSkill) }, () => {
  const detail = JSON.parse(readFileSync(realSkill, "utf8"));
  const { entries, warnings } = readHolderEffects(detail, { kind: "skill", id: 140, name: detail["技能名称"] });
  assert.deepEqual(warnings, []);
  const byBucket = entries.reduce((all, entry) => ({ ...all, [entry.bucket]: (all[entry.bucket] ?? 0) + 1 }), {});
  // 基础：剑术：14 条「对技能等级的奖励」+ 1 条带 (a) 的「防御奖励」。
  assert.equal(byBucket.skillLevel, 14);
  assert.equal(byBucket.defense, 1);
  // +50%×技能等级 这类按等级缩放的写法必须已被识别。
  const scaled = entries.flatMap((entry) => entry.terms).filter((term) => term.kind === "scaledValue");
  assert.ok(scaled.length > 0);
  assert.ok(scaled.every((term) => term.scale === "skillLevel"));
});
