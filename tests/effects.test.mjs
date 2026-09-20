import test from "node:test";
import assert from "node:assert/strict";
import {
  EffectLedger,
  activationRoundOf,
  durationExpiry,
  effectStackKey,
  sameSourceBehavior,
  isEffectLive,
  DURATION_LABELS,
} from "../game/domain/effect.mjs";

function applyRoundEnd(ledger, round, options) {
  return ledger.expireAtRoundEnd(round, options).map((instance) => instance.effectDefinitionId);
}

test("持续时间语义：1 个回合包含当前回合与下一个回合", () => {
  const expiry = durationExpiry({ kind: "rounds", value: 1 }, 3);
  assert.deepEqual(expiry, { boundary: "round", round: 4 });
  const ledger = new EffectLedger();
  ledger.apply({
    effectDefinitionId: "buff",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "t",
    appliedRound: 3,
    appliedPhase: "MainActionsExecuted",
    duration: { kind: "rounds", value: 1 },
  });
  assert.deepEqual(applyRoundEnd(ledger, 3), []);
  assert.deepEqual(applyRoundEnd(ledger, 4), ["buff"]);
  assert.equal(ledger.instances[0].state, "expired");
});

test("X 个回合包含当前回合以及之后 X 个回合", () => {
  const ledger = new EffectLedger();
  ledger.apply({
    effectDefinitionId: "three",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "t",
    appliedRound: 2,
    appliedPhase: "MainActionsExecuted",
    duration: { kind: "rounds", value: 3 },
  });
  assert.deepEqual(applyRoundEnd(ledger, 4), []);
  assert.deepEqual(applyRoundEnd(ledger, 5), ["three"]);
});

test("当前回合结束到期", () => {
  const ledger = new EffectLedger();
  ledger.apply({
    effectDefinitionId: "instant",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "t",
    appliedRound: 1,
    appliedPhase: "MainActionsExecuted",
    duration: { kind: "untilCurrentRoundEnd" },
  });
  assert.deepEqual(applyRoundEnd(ledger, 1), ["instant"]);
});

test("到该战斗结束只持续到当前房间结束", () => {
  const ledger = new EffectLedger();
  ledger.apply({
    effectDefinitionId: "room",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "t",
    appliedRound: 1,
    appliedPhase: "MainActionsExecuted",
    duration: { kind: "untilBattleEnd" },
  });
  ledger.apply({
    effectDefinitionId: "dungeon",
    sourceActorId: "a",
    sourceSkillId: "s2",
    targetId: "t",
    appliedRound: 1,
    appliedPhase: "MainActionsExecuted",
    duration: { kind: "untilDungeonEnd" },
  });
  assert.deepEqual(applyRoundEnd(ledger, 99), []);
  const expired = ledger.onBattleEnd().map((instance) => instance.effectDefinitionId);
  assert.deepEqual(expired, ["room"]);
  assert.equal(ledger.instances.find((instance) => instance.effectDefinitionId === "dungeon").state, "active");
  ledger.onDungeonEnd();
  assert.equal(ledger.instances.every((instance) => instance.state === "expired"), true);
  assert.equal(DURATION_LABELS.untilDungeonEnd, "无限制");
});

test("下个回合生效：延迟不消耗持续时间", () => {
  assert.equal(activationRoundOf({ kind: "nextRound" }, 5), 6);
  const ledger = new EffectLedger();
  const { instance } = ledger.apply({
    effectDefinitionId: "delayed",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "t",
    appliedRound: 5,
    appliedPhase: "MainActionsExecuted",
    activation: { kind: "nextRound" },
    duration: { kind: "rounds", value: 1 },
  });
  assert.equal(instance.state, "pending");
  assert.equal(instance.activationRound, 6);
  // 到期边界基于激活回合：第 6 回合开始生效，第 7 回合末结束
  assert.deepEqual(instance.expiry, { boundary: "round", round: 7 });
  assert.deepEqual(ledger.activateAtRound(6).map((item) => item.effectDefinitionId), ["delayed"]);
  assert.equal(instance.state, "active");
  assert.deepEqual(applyRoundEnd(ledger, 6), []);
  assert.deepEqual(applyRoundEnd(ledger, 7), ["delayed"]);
});

test("X 个回合后显示效果：当前回合结束再经过 X 个完整回合", () => {
  assert.equal(activationRoundOf({ kind: "afterRounds", value: 0 }, 2), 3);
  assert.equal(activationRoundOf({ kind: "afterRounds", value: 1 }, 2), 4);
  assert.equal(activationRoundOf({ kind: "afterRounds", value: 3 }, 2), 6);
});

test("无限期效果的延迟计数可以跨战斗继续推进", () => {
  const ledger = new EffectLedger();
  const { instance } = ledger.apply({
    effectDefinitionId: "crossBattle",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "t",
    appliedRound: 1,
    appliedPhase: "MainActionsExecuted",
    activation: { kind: "afterRounds", value: 1 },
    duration: { kind: "untilDungeonEnd" },
  });
  assert.equal(instance.state, "pending");
  assert.deepEqual(ledger.onBattleEnd(), []);
  assert.equal(isEffectLive(instance), true);
  assert.deepEqual(ledger.activateAtRound(3).map((item) => item.effectDefinitionId), ["crossBattle"]);
});

test("同一个 Buff 中的 modifier 按各自评注独立延迟生效", () => {
  const ledger = new EffectLedger();
  const { instance } = ledger.apply({
    effectDefinitionId: "技能-物品-套装组合 Buff",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "t",
    appliedRound: 5,
    appliedPhase: "MainActionsExecuted",
    activation: { kind: "immediate" },
    duration: { kind: "untilDungeonEnd" },
    modifiers: [
      { kind: "flat", value: 7, target: { type: "attribute", key: "perception" }, activation: { kind: "immediate" } },
      { kind: "flat", value: 4, target: { type: "attribute", key: "agility" }, activation: { kind: "nextRound" } },
      { kind: "flat", value: -4, target: { type: "attribute", key: "agility" }, activation: { kind: "afterRounds", value: 2 } },
    ],
  });

  assert.equal(instance.state, "active", "Buff 应在施加时立即存在");
  assert.deepEqual(ledger.modifiersFor("t").map((modifier) => modifier.value), [7]);
  ledger.activateAtRound(6);
  assert.deepEqual(ledger.modifiersFor("t").map((modifier) => modifier.value), [7, 4]);
  ledger.activateAtRound(7);
  assert.deepEqual(ledger.modifiersFor("t").map((modifier) => modifier.value), [7, 4]);
  ledger.activateAtRound(8);
  assert.deepEqual(ledger.modifiersFor("t").map((modifier) => modifier.value), [7, 4, -4]);
});

test("同源不叠加：同技能同目标未结束时不再附加", () => {
  const ledger = new EffectLedger();
  const base = {
    effectDefinitionId: "bleed",
    sourceActorId: "a",
    sourceSkillId: "slash",
    targetId: "t",
    appliedRound: 1,
    appliedPhase: "MainActionsExecuted",
    duration: { kind: "rounds", value: 2 },
  };
  assert.equal(ledger.apply(base).applied, true);
  const second = ledger.apply(base);
  assert.equal(second.applied, false);
  assert.equal(second.reason, "sameSourceActive");
  // 效果结束后可以再次附加
  ledger.expireAtRoundEnd(3, {});
  assert.equal(ledger.apply({ ...base, appliedRound: 4 }).applied, true);
});

test("不同技能可以产生同名多叠", () => {
  const ledger = new EffectLedger();
  const common = { effectDefinitionId: "bleed", sourceActorId: "a", targetId: "t", appliedRound: 1, appliedPhase: "MainActionsExecuted" };
  assert.equal(ledger.apply({ ...common, sourceSkillId: "slash" }).applied, true);
  assert.equal(ledger.apply({ ...common, sourceSkillId: "rend" }).applied, true);
  assert.equal(ledger.activeFor("t").length, 2);
});

test("Buff 叠加主键是技能名称 + 目标，同名 Buff 不可叠加", () => {
  assert.equal(effectStackKey({ buffKey: "烈焰护盾", sourceSkillId: "s", targetId: "t", applicationGroup: "g" }), "烈焰护盾|t");
  const ledger = new EffectLedger();
  const common = { effectDefinitionId: "e", buffKey: "烈焰护盾", sourceActorId: "a", sourceSkillId: "s", targetId: "t", appliedRound: 1, appliedPhase: "MainActionsExecuted" };
  assert.equal(ledger.apply({ ...common, applicationGroup: "a" }).applied, true);
  assert.equal(ledger.apply({ ...common, applicationGroup: "b" }).applied, false);
  // 即使来源技能 ID 不同，同名 Buff 也不能叠加。
  assert.equal(ledger.apply({ ...common, sourceSkillId: "other" }).applied, false);
  assert.equal(ledger.apply({ ...common, sourceSkillId: "other", buffKey: "寒冰护盾" }).applied, true);
});

test("技能与物品效果归属同一次应用但仍保留各自来源", () => {
  const ledger = new EffectLedger();
  const result = ledger.applyGroup({
    sourceActorId: "a",
    sourceSkillId: "s",
    sourceItemIds: ["item-1"],
    targetId: "t",
    appliedRound: 1,
    appliedPhase: "MainActionsExecuted",
    applicationGroup: "s:item-1",
    effects: [
      {
        effectDefinitionId: "skill-effect",
        modifiers: [{ kind: "flat", value: 5, target: { type: "damage" } }],
      },
      {
        effectDefinitionId: "item-effect",
        modifiers: [{ kind: "flat", value: 3, target: { type: "damage" } }],
      },
    ],
  });
  // 同一应用组内两个效果并存，因为同源判定在一次调用开始时只做一次
  assert.equal(result.applied, true);
  assert.equal(result.instances.length, 2);
  assert.deepEqual(result.instances[0].sourceItemIds, ["item-1"]);
  assert.equal(ledger.modifiersFor("t").length, 2);
  // 同一技能对该目标再次调用仍被同源规则挡住
  const again = ledger.applyGroup({
    sourceActorId: "a",
    sourceSkillId: "s",
    sourceItemIds: ["item-1"],
    targetId: "t",
    appliedRound: 2,
    appliedPhase: "MainActionsExecuted",
    applicationGroup: "s:item-1",
    effects: [{ effectDefinitionId: "skill-effect" }],
  });
  assert.equal(again.applied, false);
  assert.equal(again.reason, "sameSourceActive");
  assert.equal(again.skipped.length, 1);
});

test("基础用途对同源行为有差异", () => {
  assert.equal(sameSourceBehavior("attack").canStillTarget, true);
  assert.equal(sameSourceBehavior("attack").reapplies, false);
  assert.equal(sameSourceBehavior("deteriorate").canStillTarget, false);
  assert.equal(sameSourceBehavior("improve").canStillTarget, false);
});

test("效果修正按目标过滤并保留来源", () => {
  const ledger = new EffectLedger();
  ledger.apply({
    effectDefinitionId: "strength-buff",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "t",
    appliedRound: 1,
    appliedPhase: "MainActionsExecuted",
    modifiers: [{ kind: "flat", value: 4, target: { type: "attribute", key: "strength" } }],
  });
  const modifiers = ledger.modifiersFor("t");
  assert.equal(modifiers.length, 1);
  assert.equal(modifiers[0].source, "s/strength-buff");
  assert.equal(modifiers[0].sourceSkillId, "s");
});

test("快照与恢复保持状态", () => {
  const ledger = new EffectLedger();
  ledger.apply({
    effectDefinitionId: "e1",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "t",
    appliedRound: 1,
    appliedPhase: "MainActionsExecuted",
  });
  const snapshot = ledger.snapshot();
  const restored = new EffectLedger();
  restored.restore(snapshot);
  assert.deepEqual(restored.snapshot(), snapshot);
});
