import test from "node:test";
import assert from "node:assert/strict";
import { createDisplayBattleReport } from "../game/events/display-report.mjs";

test("展示战报只保留四阶段、数值快照与命中伤害结果", () => {
  const base = { round: 1 };
  const report = createDisplayBattleReport({
    dungeonName: "测试地城",
    battleName: "测试战斗",
    result: "victory",
    roundCount: 1,
    levelNumber: 1,
    events: [
      { ...base, type: "StatusSnapshot", side: "attacker", kind: "hero", unitId: "h", name: "英雄", level: 10, position: "rear", positionLabel: "后排", health: 20, healthMax: 30, resource: 12, resourceLabel: "法力", wounds: "轻伤", buffSnapshots: [{ name: "勇气", rawText: "不得保存", values: [{ target: { type: "agility" }, kind: "flat", value: 4, source: "不得保存" }] }] },
      { ...base, phase: "MainActionsExecuted", type: "SkillAttempted", actorId: "h", actorName: "英雄", skillId: "s", skillName: "斩击", calledItems: [{ id: "i", name: "磨刀石", setName: "磨刀套装" }], actionSnapshot: { heroLevel: 10, skillLevel: 7, attributes: { agility: 14 }, actorBuffs: [], skillEffects: [], itemEffects: [{ name: "锋利", sourceId: "i", activation: { kind: "nextRound" }, rawText: "不得保存", values: [{ target: { type: "damage" }, kind: "flat", value: 3, source: "不得保存" }] }], setEffects: [{ name: "属性奖励", sourceId: "磨刀套装", activation: { kind: "afterRounds", value: 2 }, values: [{ target: { type: "agility" }, kind: "flat", value: -4 }] }] } },
      { ...base, phase: "MainActionsExecuted", type: "ResourceSpent", actorId: "h", reason: "skillCost", resource: "mana", resourceLabel: "法力", amount: 2 },
      { ...base, phase: "MainActionsExecuted", type: "TargetSelected", actorId: "h", targetId: "m", targetName: "木偶" },
      { ...base, phase: "MainActionsExecuted", type: "AttackRolled", targetId: "m", hit: 18, evade: 7 },
      { ...base, phase: "MainActionsExecuted", type: "AttackResolved", targetId: "m", grade: "重击" },
      { ...base, phase: "MainActionsExecuted", type: "DamageApplied", targetId: "m", amount: 9, damageType: "cutting", healthAfter: 11 },
    ],
  });
  assert.deepEqual(Object.keys(report.rounds[0]), ["round", "preRound", "recovery", "initiative", "mainRound"]);
  const action = report.rounds[0].mainRound[0];
  assert.equal(action.actor.attributes.agility, 14);
  assert.equal(action.items[0].name, "磨刀石");
  assert.equal(action.items[0].setName, "磨刀套装");
  assert.equal(action.items[0].itemEffects[0].values[0].value, 3);
  assert.deepEqual(action.items[0].itemEffects[0].activation, { kind: "nextRound" });
  assert.equal(action.items[0].setEffects[0].values[0].value, -4);
  assert.deepEqual(action.items[0].setEffects[0].activation, { kind: "afterRounds", value: 2 });
  assert.deepEqual(action.targets[0], { targetId: "m", targetName: "木偶", position: undefined, hit: 18, evade: 7, grade: "重击", damage: [{ amount: 9, damageType: "cutting", healthAfter: 11 }], healing: [] });
  assert.equal(JSON.stringify(report).includes("不得保存"), false);
});

test("展示战报保留技能尝试的失败原因，避免把失败显示为成功使用", () => {
  const report = createDisplayBattleReport({
    dungeonName: "测试地城",
    battleName: "测试战斗",
    result: "draw",
    roundCount: 1,
    levelNumber: 1,
    events: [
      { round: 1, phase: "MainActionsExecuted", type: "SkillAttempted", actorId: "h", actorName: "英雄", skillId: "buff", skillName: "强化", actionSnapshot: { actorBuffs: [], skillEffects: [], itemEffects: [], setEffects: [] } },
      { round: 1, phase: "MainActionsExecuted", type: "SkillFailed", actorId: "h", actorName: "英雄", skillId: "buff", skillName: "强化", reason: "insufficientMana", reasonLabel: "法力不足" },
    ],
  });
  assert.deepEqual(report.rounds[0].mainRound[0].failure, { reason: "insufficientMana", reasonLabel: "法力不足" });
  assert.deepEqual(report.rounds[0].mainRound[0].targets, []);
});
