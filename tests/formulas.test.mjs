import test from "node:test";
import assert from "node:assert/strict";
import { ATTRIBUTE_KEYS, BASE_CHARACTER_DEFAULTS, composeAttribute, createBaseCharacter } from "../game/domain/attributes.mjs";
import { healthMax, manaMax, applyRegeneration, legalizeResourceAfterMaxChange, resourceFromDebt } from "../game/formulas/resources.mjs";
import { defaultInitiativeMean, damageMean, skillRollMean } from "../game/formulas/rolls.mjs";
import { manaCost, manaCostFactor, effectiveSkillLevel, equipmentSkillLevelBonus } from "../game/formulas/mana-cost.mjs";
import { hitGrade, hitGradeDetail, debuffApplies } from "../game/formulas/hit-grade.mjs";
import { applyModifierPipeline, percentMultiplier, percent, flat, globalPercent, scaledFlat } from "../game/modifiers/pipeline.mjs";
import { calculatedNumber, actionsFromExact, floorRoundingPolicy, roundHalfUpPolicy } from "../game/formulas/calculation.mjs";
import { applySkillEffectBonus, resolveDamage, zeroReductionPolicy } from "../game/formulas/damage-pipeline.mjs";
import { attributeTrainingChange, attributeTrainingRangeChange, heroExperienceProgress, normalizedAttributeDraftValue, normalizedSkillDraftLevel, skillTrainingChange, skillTrainingRangeChange } from "../game/formulas/training-cost.mjs";
import { createRandomStream, hashSeed, pickDeterministic } from "../game/policies/random.mjs";
import { createUniformRollPolicy, meanRollPolicy } from "../game/policies/roll.mjs";
import { buildInitiativeSchedule, createLinearDecayPolicy, createWodBlockDecayPolicy } from "../game/policies/initiative.mjs";

test("脆弱性在护甲后合成固定百分点与叠乘百分比，负值转为回血", () => {
  const input = { meanExact: 20, rollPolicy: meanRollPolicy, damageTypes: ["切割伤害"],
    defense: { armor: { flat: 5 } }, postDefenseBonus: { flat: 3 } };
  const reduced = resolveDamage({ ...input, vulnerability: { flat: -10, percents: [-20, -20] } });
  assert.ok(Math.abs(reduced.diagnostics.vulnerabilityRate - 0.54) < 1e-9);
  assert.equal(reduced.applied, 11);
  assert.equal(reduced.diagnostics.vulnerabilityLabel, "抵抗性");
  const deepened = resolveDamage({ ...input, vulnerability: { flat: 30 } });
  assert.equal(deepened.diagnostics.vulnerabilityRate, 1.3);
  assert.equal(deepened.diagnostics.vulnerabilityLabel, "脆弱性");
  const immune = resolveDamage({ ...input, postDefenseBonus: {}, vulnerability: { flat: -100 } });
  assert.equal(immune.applied, 0);
  const healed = resolveDamage({ ...input, postDefenseBonus: {}, vulnerability: { flat: -150 } });
  assert.equal(healed.applied, -8);
  assert.equal(healed.diagnostics.vulnerabilityLabel, "抗性超出预期");
});

test("八项属性键完整且顺序稳定", () => {
  assert.deepEqual(ATTRIBUTE_KEYS, [
    "strength", "constitution", "intelligence", "dexterity",
    "charisma", "agility", "perception", "willpower",
  ]);
});

test("heroes 行补齐统一的角色基础数值默认值", () => {
  const character = createBaseCharacter({ id: 1, strength: 8, constitution: 9, intelligence: 4, willpower: 7 });
  assert.deepEqual(character.baseStats.defaults, BASE_CHARACTER_DEFAULTS);
  assert.equal(character.baseStats.healthMax, 44);
  assert.equal(character.baseStats.manaMax, 30);
  assert.equal(character.baseStats.healthRegeneration, 2);
  assert.equal(character.baseStats.manaRegeneration, 2);
  assert.equal(character.baseStats.pocketSlots, 15);
  assert.equal(character.baseStats.ringSlots, 4);
  assert.equal(character.baseStats.medalSlots, 3);
  assert.equal(character.baseStats.actionsPerRound, 1);
  assert.equal(character.baseStats.initiativeBonus, 0);
  assert.equal(character.allianceFame, 999999);
  assert.equal(character.baseStats.allianceFame, 999999);
});

test("属性训练按目标等级花费经验，降低时退回当前等级花费", () => {
  assert.deepEqual(attributeTrainingChange(1, 1), { current: 1, next: 2, delta: 1, experienceChange: -100, cost: 100 });
  assert.deepEqual(attributeTrainingChange(8, -1), { current: 8, next: 7, delta: -1, experienceChange: 4700, cost: 4700 });
  assert.throws(() => attributeTrainingChange(1, -1), /不能低于 1/);
});

test("数据库等级决定升级门槛，总经验只判断能否手动升级", () => {
  assert.deepEqual(heroExperienceProgress(300, 1), {
    level: 1, levelStart: 0, nextLevelAt: 1000, earnedInLevel: 300, levelSpan: 1000, toNextLevel: 700, percent: 30, canLevelUp: false,
  });
  assert.equal(heroExperienceProgress(81000, 9).canLevelUp, true);
  assert.equal(heroExperienceProgress(81000, 1).level, 1, "总经验不得直接改变数据库等级");
  assert.deepEqual(skillTrainingChange(0, 1, "basic"), { current: 0, next: 1, delta: 1, trainingClass: "basic", cost: 20, experienceChange: -20 });
  assert.equal(skillTrainingChange(1, -1, "basic").experienceChange, 20);
});

test("技能草稿未初始化时回退当前等级且跨级经验计算有限", () => {
  assert.equal(normalizedSkillDraftLevel(3, undefined), 3);
  assert.equal(normalizedSkillDraftLevel(3, Number.NaN), 3);
  assert.equal(skillTrainingRangeChange(0, 3, "basic"), -(20 + 40 + 120));
  assert.equal(skillTrainingRangeChange(3, 0, "basic"), 20 + 40 + 120);
});

test("属性草稿未初始化时回退基础值，跨点费用与逐点训练一致", () => {
  assert.equal(normalizedAttributeDraftValue(8, undefined), 8);
  assert.equal(normalizedAttributeDraftValue(8, Number.NaN), 8);
  assert.equal(normalizedAttributeDraftValue(8, 0), 8, "草稿低于 1 时回退基础值");
  // 8 → 10 逐级取值：下标 9（6200）与下标 10（8000）。
  assert.equal(attributeTrainingRangeChange(8, 10), -(6200 + 8000));
  // 10 → 8 逐级退回：下标 10（8000）与下标 9（6200）。
  assert.equal(attributeTrainingRangeChange(10, 8), 8000 + 6200);
  assert.equal(attributeTrainingRangeChange(1, 3), -(100 + 400));
  assert.equal(attributeTrainingRangeChange(39, 40), -196200, "训练表最后一个等级仍可取到费用");
  assert.throws(() => attributeTrainingRangeChange(40, 41), /没有训练花费定义/, "训练表最高等级没有下一级费用");
});

test("属性分层合成保留精确值并在使用时向下取整", () => {
  const result = composeAttribute({ base: 10, percentages: [10], flats: [1] });
  assert.equal(result.exact, 12);
  assert.equal(result.applied, 12);
  const fractional = composeAttribute({ base: 9, percentages: [5] });
  assert.ok(Math.abs(fractional.exact - 9.45) < 1e-12, `精确值应为 9.45，实际 ${fractional.exact}`);
  assert.equal(fractional.applied, 9);
});

test("体力上限 = 基础 1 + 体质 × 3 + 力量 × 2", () => {
  const result = healthMax({ constitution: 9, strength: 8 });
  assert.equal(result.exact, 44);
  assert.equal(result.applied, 44);
  assert.ok(result.steps.length > 0);
  assert.equal(healthMax({ constitution: 0, strength: 0 }).applied, 1);
});

test("法力上限 = 基础 1 + 意志 × 3 + 智力 × 2", () => {
  assert.equal(manaMax({ willpower: 7, intelligence: 4 }).exact, 30);
});

test("先攻命中闪避平均值 = 主属性 × 2 + 副属性 + 实时技能等级 × 2", () => {
  const result = skillRollMean({ primary: 12, secondary: 14, skillLevel: 4 });
  assert.equal(result.exact, 46);
  assert.equal(result.steps.length, 4);
});

test("默认先攻平均值没有技能等级项", () => {
  assert.equal(defaultInitiativeMean({ agility: 14, perception: 11 }).exact, 39);
});

test("伤害平均值 = 主属性 ÷ 2 + 副属性 ÷ 3 + 实时技能等级 ÷ 2", () => {
  const result = damageMean({ primary: 12, secondary: 9, skillLevel: 4 });
  assert.equal(result.exact, 11);
  const fractional = damageMean({ primary: 7, secondary: 4, skillLevel: 1 });
  assert.equal(fractional.exact, 3.5 + 4 / 3 + 0.5);
  assert.equal(fractional.applied, 5);
});

test("法力消耗 = (0.8 + 0.1 × 实时技能等级) × 标准消耗，取整点由策略注入", () => {
  assert.equal(manaCostFactor(4), 1.2000000000000002);
  const floored = manaCost({ standardCost: 10, skillLevel: 4 }, { roundingPolicy: floorRoundingPolicy });
  assert.equal(floored.applied, 12);
  const halfUp = manaCost({ standardCost: 5, skillLevel: 1 }, { roundingPolicy: roundHalfUpPolicy });
  assert.equal(halfUp.exact, 4.5);
  assert.equal(halfUp.applied, 5);
  assert.equal(manaCost({ standardCost: 5, skillLevel: 1 }).applied, 4);
});

test("装备直接技能等级加成不得超过技能基础等级", () => {
  assert.equal(equipmentSkillLevelBonus(4, 10), 4);
  assert.equal(equipmentSkillLevelBonus(4, 2), 2);
  assert.equal(equipmentSkillLevelBonus(0, 5), 0);
  const level = effectiveSkillLevel({ baseLevel: 4, equipmentBonus: 10, otherBonus: 1 });
  assert.equal(level.applied, 9);
  assert.equal(level.cappedEquipment, true);
});

test("百分比连乘：+10% 与 +20% 合并为 +32%", () => {
  assert.equal(percentMultiplier([10, 20]), 1.32);
});

test("修正管线先乘后加，最后应用全局百分比", () => {
  const result = applyModifierPipeline(100, {
    modifiers: [percent(10, "a"), percent(20, "b"), flat(8, "c"), globalPercent(25, "d")],
  });
  assert.equal(result.percentMultiplier, 1.32);
  assert.equal(result.globalMultiplier, 1.25);
  assert.equal(result.flatTotal, 8);
  assert.equal(result.exact, 175);
  assert.equal(result.flatBySource.length, 1);
  assert.equal(result.flatBySource[0].source, "c");
});

test("scaledFlat 按英雄等级或技能等级缩放", () => {
  const byHero = applyModifierPipeline(10, { modifiers: [scaledFlat("heroLevel", 2, "level")], context: { heroLevel: 5 } });
  assert.equal(byHero.exact, 20);
  const bySkill = applyModifierPipeline(10, { modifiers: [scaledFlat("skillLevel", 0.5, "skill")], context: { skillLevel: 4 } });
  assert.equal(bySkill.exact, 12);
});

test("命中等级边界逐点覆盖", () => {
  assert.equal(hitGrade(100, 100), "闪避");
  assert.equal(hitGrade(100.0001, 100), "命中");
  assert.equal(hitGrade(150, 100), "命中");
  assert.equal(hitGrade(150.0001, 100), "重击");
  assert.equal(hitGrade(225, 100), "重击");
  assert.equal(hitGrade(225.0001, 100), "致命一击");
  assert.equal(hitGrade(0, 0), "闪避");
});

test("没有闪避时 Debuff 完整生效", () => {
  assert.equal(debuffApplies("闪避"), false);
  assert.equal(debuffApplies("命中"), true);
  assert.equal(debuffApplies("重击"), true);
  assert.equal(debuffApplies("致命一击"), true);
  assert.equal(hitGradeDetail(300, 100).thresholds.heavy, 225);
});

test("小数保留，使用时才向下取整：1.9 只产生 1 次行动", () => {
  assert.equal(actionsFromExact(1.9), 1);
  assert.equal(actionsFromExact(2.1), 2);
  assert.equal(actionsFromExact(-1), 0);
  const number = calculatedNumber(1.9);
  assert.equal(number.exact, 1.9);
  assert.equal(number.applied, 1);
});

test("体力上限下降时按债务重新判定击倒", () => {
  const shrunk = legalizeResourceAfterMaxChange({ resourceKind: "health", newMax: 20, accumulatedDamage: 25 });
  assert.equal(shrunk.knockedDown, true);
  assert.equal(shrunk.current, 0);
  const survived = legalizeResourceAfterMaxChange({ resourceKind: "health", newMax: 30, accumulatedDamage: 25 });
  assert.equal(survived.knockedDown, false);
  assert.equal(survived.current, 5);
});

test("法力上限下降只降到 0，不产生击倒", () => {
  const result = legalizeResourceAfterMaxChange({ resourceKind: "mana", newMax: 10, accumulatedDamage: 30 });
  assert.equal(result.knockedDown, false);
  assert.equal(result.current, 0);
  assert.equal(result.clamped, true);
  assert.equal(resourceFromDebt({ max: 10, accumulatedDamage: 4, accumulatedHealing: 1 }).applied, 7);
});

test("自然回复不得超过上限，负回复表现为流失", () => {
  const up = applyRegeneration({ current: 40, max: 43, regeneration: 10 });
  assert.equal(up.current, 43);
  assert.equal(up.clampedByMax, true);
  const down = applyRegeneration({ current: 40, max: 43, regeneration: -10 });
  assert.equal(down.current, 30);
  const floored = applyRegeneration({ current: 1, max: 43, regeneration: -5 });
  assert.equal(floored.current, 0);
  const manaWithoutMaximum = applyRegeneration({ current: 40, regeneration: 10 });
  assert.equal(manaWithoutMaximum.current, 50);
  assert.equal(manaWithoutMaximum.clampedByMax, false);
});

test("随机流由种子决定且可复现", () => {
  const a = createRandomStream("seed-1");
  const b = createRandomStream("seed-1");
  const c = createRandomStream("seed-2");
  const first = [a.next(), a.next(), a.next()];
  const second = [b.next(), b.next(), b.next()];
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, [c.next(), c.next(), c.next()]);
  assert.equal(hashSeed("seed-1"), hashSeed("seed-1"));
  assert.equal(a.draws, 3);
});

test("确定性选取在候选超过上限时可用", () => {
  const stream = createRandomStream("pick");
  const items = ["a", "b", "c"];
  const picked = pickDeterministic(items, stream);
  assert.ok(items.includes(picked));
  assert.equal(pickDeterministic([], stream), undefined);
  assert.equal(pickDeterministic(["only"], stream), "only");
});

test("均匀投点策略落在 [0, 2 × 平均值]", () => {
  const policy = createUniformRollPolicy();
  const stream = createRandomStream("roll");
  for (let index = 0; index < 50; index += 1) {
    const value = policy.rollAroundMean(10, { randomStream: stream });
    assert.ok(value >= 0 && value <= 20, `${value} 越界`);
  }
  assert.equal(policy.experimental, true);
  assert.equal(meanRollPolicy.rollAroundMean(13), 13);
});

test("伤害管线按顺序记录每一步诊断", () => {
  const result = resolveDamage({
    meanExact: 10,
    flats: [
      { value: 2, source: "pre", timing: "preRoll" },
      { value: 3, source: "z-item", timing: "postRoll", damageType: "切割伤害" },
    ],
    percents: [{ value: 50, source: "buff" }],
    zAdditions: [
      { value: 4, damageType: "切割伤害", source: "z" },
      { value: 100, damageType: "火焰伤害", source: "wrong-type" },
    ],
    damageTypes: ["切割伤害"],
    hitGrade: "重击",
    hitGradePercents: { 重击: 100 },
    defense: { armor: { percent: 50 }, resistance: { percent: 0 } },
    globalPercents: [20],
    armorPolicy: { id: "half", experimental: true, reduce: (value) => ({ value: value / 2, applied: value / 2 }) },
  });
  // 公式平均值 10 ×1.5 = 15 → 投点（未注入策略时取平均值）
  // → +2/+3 固定 = 20 → +4 z = 24 → 重击 ×2 = 48 → 护甲减半 = 24 → ×1.2 = 28.8
  assert.ok(Math.abs(result.exact - 28.8) < 1e-12, `精确值应为 28.8，实际 ${result.exact}`);
  assert.equal(result.applied, 28);
  assert.equal(result.diagnostics.preRollFlat, 2);
  assert.equal(result.diagnostics.postRollFlatTotal, 3);
  assert.equal(result.diagnostics.zTotal, 4);
  assert.equal(result.diagnostics.percentMultiplier, 1.5);
  assert.equal(result.diagnostics.globalMultiplier, 1.2);
  assert.equal(result.trace.base, 10);
  assert.ok(result.trace.steps.some((step) => step.label.includes("z 伤害追加")));
  assert.ok(!result.trace.steps.some((step) => step.label.includes("火焰伤害")));
});

test("零减免策略显式标注为实验性", () => {
  const result = resolveDamage({ meanExact: 10, damageTypes: [], defense: { armor: { percent: 90 } } });
  assert.equal(result.applied, 10);
  assert.equal(result.diagnostics.armorPolicyId, zeroReductionPolicy.id);
  assert.equal(result.diagnostics.pipelineExperimental, false);
});

test("固定护甲先扣减，伤害奖励在护甲后追加", () => {
  const result = resolveDamage({ meanExact: 20, damageTypes: ["火焰伤害"], defense: { armor: { flat: 25 } }, postDefenseBonus: { flat: 3 } });
  assert.equal(result.applied, 3);
  const second = resolveDamage({ meanExact: 20, damageTypes: ["火焰伤害"], defense: { armor: { flat: 5 } }, postDefenseBonus: { flat: 3, percents: [20] } });
  assert.equal(second.applied, 21);
});

test("技能效果奖励先乘百分比再加固定值，并在护甲之前生效", () => {
  assert.equal(applySkillEffectBonus(20, [{ kind: "percent", value: -25 }, { kind: "flat", value: -2 }]).value, 13);
  const result = resolveDamage({ meanExact: 20, damageTypes: ["切割伤害"], skillEffectBonus: [{ kind: "flat", value: 5 }], defense: { armor: { flat: 10 } } });
  assert.equal(result.applied, 15);
});

test("先攻队列按降序排列并逐次衰减", () => {
  const units = [
    { id: "a", name: "A", side: "attacker" },
    { id: "b", name: "B", side: "defender" },
  ];
  const { schedule, byUnit } = buildInitiativeSchedule({
    units,
    initiativeValues: new Map([["a", 100], ["b", 60]]),
    actionCounts: new Map([["a", 2], ["b", 1]]),
  });
  assert.equal(schedule[0].actorId, "a");
  assert.equal(schedule[0].initiative, 100);
  assert.equal(byUnit.get("a").length, 2);
  assert.ok(byUnit.get("a")[1].initiative < byUnit.get("a")[0].initiative);
  for (let index = 1; index < schedule.length; index += 1) {
    assert.ok(schedule[index - 1].initiative >= schedule[index].initiative);
  }
  assert.equal(byUnit.get("a")[0].ordinal, 1);
  assert.equal(byUnit.get("a")[0].totalActions, 2);
});

test("行动次数越高，单步先攻衰减越缓", () => {
  const policy = createLinearDecayPolicy({ stepFraction: 0.5 });
  const twoActions = policy.factor(2, 2);
  const fiveActions = policy.factor(2, 5);
  assert.ok(fiveActions > twoActions);
  assert.equal(policy.experimental, true);
  assert.equal(policy.factor(1, 5), 1);
});

test("WOD 多行动先攻每 32 步重置指数项并按精确值排序", () => {
  const policy = createWodBlockDecayPolicy();
  const base = 46505;
  const total = 83;
  assert.equal(Math.floor(base * policy.factor(1, total)), 46505);
  assert.equal(Math.floor(base * policy.factor(33, total)), 37540);
  assert.equal(Math.floor(base * policy.factor(2, total)), 34598);
  const { schedule } = buildInitiativeSchedule({
    units: [{ id: "a", name: "A", side: "attacker" }],
    initiativeValues: new Map([["a", base]]),
    actionCounts: new Map([["a", total]]),
    decayPolicy: policy,
  });
  assert.deepEqual(schedule.slice(0, 4).map((entry) => entry.ordinal), [1, 33, 2, 65]);
});
