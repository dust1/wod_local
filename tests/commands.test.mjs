import test from "node:test";
import assert from "node:assert/strict";
import {
  CommandCursor,
  defaultFailureCostPolicy,
  interpretMainCommands,
  FAILURE_REASON_LABELS,
} from "../game/commands/cursor.mjs";
import {
  createBattlePlan,
  createFloorPlan,
  resolveFloorPlan,
  REPEAT_MODE_LABELS,
} from "../game/commands/battle-plan.mjs";
import {
  assessWounds,
  collectHealingTriggers,
  selectHealingInterrupt,
  WOUND_LABELS,
  defaultHealingPriorityPolicy,
} from "../game/commands/healing.mjs";
import {
  EQUIP_SLOTS,
  slotConflicts,
  findRequirementCycles,
  resolveRequirementChain,
  parseMarker,
  markerApplies,
  canUseItem,
  createUniquenessLedger,
  blocksTeamUniqueDrop,
  canDamageDurability,
  handOccupancy,
  ONE_HAND_SLOT_ID,
  ONE_HAND_SLOT_LABEL,
} from "../game/domain/item.mjs";

const skills = new Map([
  ["slash", { id: "slash", name: "斩击", baseType: "attack" }],
  ["guard", { id: "guard", name: "守势", baseType: "improve" }],
  ["bandage", { id: "bandage", name: "包扎", baseType: "heal" }],
]);

test("normal 模式每次尝试后推进", () => {
  const cursor = new CommandCursor([
    { id: "c1", skillId: "slash", repeat: "normal" },
    { id: "c2", skillId: "guard", repeat: "normal" },
  ]);
  assert.equal(cursor.current().id, "c1");
  cursor.record({ ok: true });
  assert.equal(cursor.current().id, "c2");
  cursor.record({ ok: false, reason: "noTargets" });
  assert.equal(cursor.current().id, "c1");
  assert.equal(cursor.wrapped, 1);
});

test("oncePerBattle 每场战斗最多成功执行一次", () => {
  const cursor = new CommandCursor([
    { id: "once", skillId: "slash", repeat: "oncePerBattle" },
    { id: "other", skillId: "guard", repeat: "normal" },
  ]);
  cursor.record({ ok: true });
  assert.equal(cursor.successCount("once"), 1);
  assert.equal(cursor.current().id, "other");
  cursor.record({ ok: true });
  // 回到一次性指令时不可再执行
  assert.equal(cursor.current().id, "once");
  assert.deepEqual(cursor.isExecutable(cursor.current()), { executable: false, reason: "oncePerBattleExhausted" });
  cursor.record({ ok: false, reason: "oncePerBattleExhausted" });
  assert.equal(cursor.current().id, "other");
});

test("repeatWhilePossible 成功时保持当前指令，失败时跳到下一条", () => {
  const cursor = new CommandCursor([
    { id: "repeat", skillId: "slash", repeat: "repeatWhilePossible" },
    { id: "other", skillId: "guard", repeat: "normal" },
  ]);
  cursor.record({ ok: true });
  assert.equal(cursor.current().id, "repeat");
  cursor.record({ ok: true });
  assert.equal(cursor.current().id, "repeat");
  assert.equal(cursor.successCount("repeat"), 2);
  // 不可执行时跳到下一条
  cursor.record({ ok: false, reason: "insufficientMana" });
  assert.equal(cursor.current().id, "other");
  // 下次循环重新到达时才再次尝试
  cursor.record({ ok: true });
  assert.equal(cursor.current().id, "repeat");
});

test("尝试失败是否消耗行动由策略决定并返回结构化原因", () => {
  assert.equal(defaultFailureCostPolicy.consumesAction("insufficientMana"), true);
  assert.equal(defaultFailureCostPolicy.consumesAction("noTargets"), false);
  assert.equal(defaultFailureCostPolicy.consumesAction("oncePerBattleExhausted"), false);
  assert.equal(defaultFailureCostPolicy.experimental, true);
  const cursor = new CommandCursor([{ id: "c1", skillId: "slash", repeat: "normal" }]);
  const record = cursor.record({ ok: false, reason: "missingItem" });
  assert.equal(record.consumedAction, true);
  assert.equal(record.reason, "missingItem");
  assert.equal(FAILURE_REASON_LABELS.missingItem, "缺少所需物品");
  assert.equal(FAILURE_REASON_LABELS.missingSummonDefinition, "没有匹配技能等级和调用物品的召唤物配置");
});

test("空指令序列安全", () => {
  const cursor = new CommandCursor([]);
  assert.equal(cursor.exhausted, true);
  assert.equal(cursor.current(), null);
  assert.deepEqual(cursor.isExecutable(null), { executable: false, reason: "noCommands" });
});

test("治疗技能不能作为普通主动指令", () => {
  const commands = [
    { id: "a", skillId: "slash" },
    { id: "b", skillId: "bandage" },
    { id: "c", skillId: "unknown" },
  ];
  const { executable, rejected } = interpretMainCommands(commands, skills);
  assert.deepEqual(executable.map((command) => command.id), ["a"]);
  assert.deepEqual(rejected.map((entry) => [entry.command.id, entry.reason]), [["b", "cannotUseTiming"], ["c", "skillNotLearned"]]);
});

test("层设置覆盖默认方案，且只允许 1 至 10 层", () => {
  const plan = createBattlePlan({
    id: "p",
    name: "林地巡猎",
    defaultPlan: { position: "rightWing", mainRound: [{ skillId: "slash" }] },
    floorOverrides: { 3: { position: "rear" } },
  });
  assert.equal(resolveFloorPlan(plan, 1).source, "default");
  assert.equal(resolveFloorPlan(plan, 1).plan.position, "rightWing");
  assert.equal(resolveFloorPlan(plan, 3).source, "floorOverride");
  assert.equal(resolveFloorPlan(plan, 3).plan.position, "rear");
  assert.throws(() => createBattlePlan({ floorOverrides: { 11: {} } }), /层覆盖只允许/);
  assert.equal(REPEAT_MODE_LABELS.repeatWhilePossible, "尽可能多的重复");
});

test("层方案默认值完整", () => {
  const plan = createFloorPlan({});
  assert.equal(plan.position, "front");
  assert.equal(plan.initiativeSkillId, null);
  assert.deepEqual(plan.preRound, []);
  assert.deepEqual(plan.mainRound, []);
});

test("受伤阈值：低于 90% 至少视为轻伤", () => {
  assert.equal(assessWounds({ current: 100, max: 100 }).state, "healthy");
  assert.equal(assessWounds({ current: 90, max: 100 }).state, "healthy");
  assert.equal(assessWounds({ current: 89.9, max: 100 }).state, "light");
  assert.equal(assessWounds({ current: 0, max: 100 }).state, "down");
  assert.equal(WOUND_LABELS.light, "轻伤");
  assert.equal(WOUND_LABELS.severe, "重伤");
  assert.equal(assessWounds({ current: 100, max: 100 }).policyId, "default-wound-thresholds");
});

test("治疗触发器按优先级排序，英雄优先于召唤物", () => {
  const units = [
    { id: "hero", name: "英雄", side: "attacker", kind: "hero", alive: true, health: 10, healthMax: 100 },
    { id: "summon", name: "狼", side: "attacker", kind: "summon", alive: true, health: 10, healthMax: 100 },
    { id: "enemy", name: "敌人", side: "defender", kind: "monster", alive: true, health: 1, healthMax: 100 },
  ];
  const triggers = collectHealingTriggers({ units, actorId: "hero" });
  assert.deepEqual(triggers.map((trigger) => trigger.unitId), ["hero", "summon"]);
  assert.equal(triggers[0].priority, 1);
  assert.equal(triggers[1].priority, 4);
  assert.equal(defaultHealingPriorityPolicy.experimental, true);
});

test("治疗中断选择最高优先级触发器", () => {
  const chosen = selectHealingInterrupt({
    healingCommands: [{ id: "h1", skillId: "bandage" }],
    triggers: [{ unitId: "u1", unitName: "甲", priority: 2, woundLabel: "受伤" }],
  });
  assert.equal(chosen.targetId, "u1");
  assert.equal(chosen.priority, 2);
  assert.match(chosen.reason, /优先级 2/);
  assert.equal(selectHealingInterrupt({ healingCommands: [], triggers: [{ unitId: "u1" }] }), null);
  assert.equal(selectHealingInterrupt({ healingCommands: [{ id: "h1" }], triggers: [] }), null);
});

test("装备槽位与双手冲突", () => {
  assert.equal(Object.keys(EQUIP_SLOTS).length, 18);
  assert.equal(EQUIP_SLOTS.two_hands, "双手");
  assert.deepEqual(slotConflicts("two_hands", ["right_hand"]), ["right_hand"]);
  assert.deepEqual(slotConflicts("two_hands", ["left_hand", "head"]), ["left_hand"]);
  assert.deepEqual(slotConflicts("right_hand", ["two_hands"]), ["two_hands"]);
  assert.deepEqual(slotConflicts("head", ["head"]), ["head"]);
  assert.deepEqual(slotConflicts("head", ["neck"]), []);
});

test("单手物品的派生部位与手部占用", () => {
  assert.equal(ONE_HAND_SLOT_ID, "one_hand");
  assert.equal(ONE_HAND_SLOT_LABEL, "单手");
  // 单手物品与双手物品互斥
  assert.deepEqual(slotConflicts("one_hand", ["two_hands"]), ["two_hands"]);
  assert.deepEqual(slotConflicts("two_hands", ["one_hand"]), ["one_hand"]);
  // 空手时两只手都可用
  assert.deepEqual(handOccupancy([]), { freeHands: 2, usesTwoHands: false, canEquipOneHand: true, canEquipTwoHands: true });
  // 一件单手物品占用一只手
  assert.equal(handOccupancy(["one_hand"]).freeHands, 1);
  // 两件单手物品占满双手
  assert.equal(handOccupancy(["one_hand", "one_hand"]).freeHands, 0);
  // 双手武器占满双手
  assert.equal(handOccupancy(["two_hands"]).freeHands, 0);
  assert.equal(handOccupancy(["two_hands"]).canEquipOneHand, false);
  assert.equal(handOccupancy(["right_hand"]).freeHands, 1);
  assert.equal(handOccupancy(["right_hand", "left_hand"]).freeHands, 0);
  // 非手部槽位不影响手部占用
  assert.equal(handOccupancy(["head", "neck"]).freeHands, 2);
});

test("物品配套需求图检测循环依赖", () => {
  const items = [
    { id: "bow", requires: ["arrow"] },
    { id: "arrow", requires: ["quiver"] },
    { id: "quiver", requires: [] },
    { id: "loop-a", requires: ["loop-b"] },
    { id: "loop-b", requires: ["loop-a"] },
  ];
  const cycles = findRequirementCycles(items);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]].sort(), ["loop-a", "loop-b"]);
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.deepEqual(resolveRequirementChain("bow", byId).map((item) => item.id), ["bow", "arrow", "quiver"]);
});

test("a 与 z 标记解析为结构字段", () => {
  const markerA = parseMarker("a");
  assert.equal(markerA.kind, "a");
  assert.equal(markerA.appliesOnUseOnly, true);
  assert.equal(markerA.appliesOnUseOnly && markerApplies(markerA, { wasUsed: false }), false);
  assert.equal(markerApplies(markerA, { wasUsed: true }), true);

  const markerZ = parseMarker("z（切割伤害）");
  assert.equal(markerZ.kind, "z");
  assert.equal(markerZ.damageType, "切割伤害");
  assert.equal(markerApplies(markerZ, { damageTypes: ["切割伤害"] }), true);
  assert.equal(markerApplies(markerZ, { damageTypes: ["穿刺伤害"] }), false);
  assert.equal(parseMarker("?").kind, "unknown");
});

test("使用次数限制与每战斗一次不能多倍消耗", () => {
  assert.deepEqual(canUseItem({ totalCharges: 3, remainingCharges: 1 }), { allowed: true });
  assert.deepEqual(canUseItem({ totalCharges: 3, remainingCharges: 0 }), { allowed: false, reason: "noCharges" });
  assert.deepEqual(canUseItem({ usesPerBattle: 1 }, { usedThisBattle: 1 }), { allowed: false, reason: "usesPerBattleExhausted" });
  assert.deepEqual(canUseItem({ usesPerDungeon: 2 }, { usedThisDungeon: 2 }), { allowed: false, reason: "usesPerDungeonExhausted" });
  assert.deepEqual(canUseItem({ usesPerBattle: 1 }, { multiplier: 2 }), { allowed: false, reason: "oncePerBattleCannotBeMultiplied" });
});

test("唯一性：已掉落记录与当前持有分离", () => {
  const ledger = createUniquenessLedger();
  ledger.markDropped("team-1:item-relic");
  ledger.hold("hero-1", "item-relic");
  assert.equal(ledger.holds("hero-1", "item-relic"), true);
  assert.equal(blocksTeamUniqueDrop(ledger, "team-1:item-relic"), true);
  ledger.release("hero-1", "item-relic");
  assert.equal(ledger.holds("hero-1", "item-relic"), false);
  // 摧毁后队伍仍然无法再次获得正常掉落
  assert.equal(blocksTeamUniqueDrop(ledger, "team-1:item-relic"), true);
  assert.deepEqual(ledger.snapshot().droppedEver, ["team-1:item-relic"]);
});

test("心理与毒素伤害不造成装备损坏", () => {
  assert.equal(canDamageDurability("切割伤害"), true);
  assert.equal(canDamageDurability("心理伤害"), false);
  assert.equal(canDamageDurability("毒素伤害"), false);
});
