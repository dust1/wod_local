import test from "node:test";
import assert from "node:assert/strict";
import {
  POSITIONS,
  POSITION_LABELS,
  MELEE_TARGET_PRIORITY,
  MELEE_POSITION_HIT_MODIFIER,
  meleeTargetPriority,
  meleePositionHitPercent,
  isMeleeAttackType,
  TARGET_MODES,
} from "../game/domain/positions.mjs";
import { enumerateCandidates, selectTargets, targetPositionPriority, stableWithinPositionPolicy } from "../game/targeting/select.mjs";
import { createRandomStream } from "../game/policies/random.mjs";

function unit(id, side, position, extra = {}) {
  return { id, name: id, side, position, alive: true, present: true, kind: "hero", ...extra };
}

test("六个站位与中文显示名", () => {
  assert.deepEqual(POSITIONS, ["front", "leftWing", "rightWing", "center", "rear", "enemyRear"]);
  assert.equal(POSITION_LABELS.front, "前排");
  assert.equal(POSITION_LABELS.enemyRear, "队伍后方");
  assert.deepEqual(TARGET_MODES, ["self", "single", "samePositionAoE", "globalAoE"]);
});

test("近战固定攻击顺序逐行匹配教材表格", () => {
  assert.deepEqual(MELEE_TARGET_PRIORITY.front, ["front", "center", "rear", "leftWing", "rightWing", "enemyRear"]);
  assert.deepEqual(MELEE_TARGET_PRIORITY.leftWing, ["rightWing", "front", "center", "rear", "leftWing", "enemyRear"]);
  assert.deepEqual(MELEE_TARGET_PRIORITY.rightWing, ["leftWing", "front", "center", "rear", "rightWing", "enemyRear"]);
  assert.deepEqual(MELEE_TARGET_PRIORITY.center, ["front", "center", "rear", "rightWing", "leftWing", "enemyRear"]);
  assert.deepEqual(MELEE_TARGET_PRIORITY.rear, ["enemyRear", "front", "center", "rightWing", "leftWing", "rear"]);
  assert.deepEqual(MELEE_TARGET_PRIORITY.enemyRear, ["rear", "center", "front", "rightWing", "leftWing", "enemyRear"]);
});

test("近战站位命中修正逐格匹配教材表格", () => {
  const expected = {
    front: { front: 0, leftWing: -20, rightWing: -20, center: 20, rear: 20, enemyRear: -30 },
    leftWing: { front: 20, leftWing: -20, rightWing: 0, center: 0, rear: -20, enemyRear: -30 },
    rightWing: { front: 20, leftWing: 0, rightWing: -20, center: 0, rear: -20, enemyRear: -30 },
    center: { front: -20, leftWing: -20, rightWing: -20, center: -20, rear: -20, enemyRear: -30 },
    rear: { front: -20, leftWing: -20, rightWing: -20, center: -20, rear: -20, enemyRear: 0 },
    enemyRear: { front: 30, leftWing: 20, rightWing: 20, center: 30, rear: 0, enemyRear: 0 },
  };
  for (const [attacker, row] of Object.entries(expected)) {
    for (const [defender, value] of Object.entries(row)) {
      assert.equal(MELEE_POSITION_HIT_MODIFIER[attacker][defender], value, `${attacker} → ${defender}`);
      assert.equal(meleePositionHitPercent(attacker, defender), value);
    }
  }
});

test("近战与远程的位置优先级来源不同", () => {
  assert.equal(isMeleeAttackType("近战"), true);
  assert.equal(isMeleeAttackType("远程"), false);
  assert.deepEqual(targetPositionPriority({ actorPosition: "rear", attackType: "近战" }), MELEE_TARGET_PRIORITY.rear);
  assert.deepEqual(
    targetPositionPriority({ actorPosition: "rear", attackType: "远程", configuredPriority: ["rear", "front"] }),
    ["rear", "front"],
  );
  assert.deepEqual(targetPositionPriority({ actorPosition: "rear", attackType: "远程" }), MELEE_TARGET_PRIORITY.rear);
});

test("同位置 AOE 不跨站位补齐", () => {
  const units = [
    unit("a", "attacker", "front"),
    unit("e1", "defender", "front"),
    unit("e2", "defender", "center"),
    unit("e3", "defender", "center"),
  ];
  const result = selectTargets({
    actor: units[0],
    units,
    spec: { side: "enemy", mode: "samePositionAoE", maxTargets: 3, allowSummons: true },
    attackType: "近战",
  });
  // 前排只有 1 人，即使上限是 3 也不能跨到中间补齐
  assert.deepEqual(result.targets.map((target) => target.id), ["e1"]);
  assert.equal(result.position, "front");
});

test("同位置 AOE 在人数足够时填满上限", () => {
  const units = [
    unit("a", "attacker", "front"),
    unit("e1", "defender", "front"),
    unit("e2", "defender", "front"),
    unit("e3", "defender", "front"),
  ];
  const result = selectTargets({
    actor: units[0],
    units,
    spec: { side: "enemy", mode: "samePositionAoE", maxTargets: 2, allowSummons: true },
    attackType: "近战",
    withinPositionPolicy: stableWithinPositionPolicy,
  });
  assert.equal(result.targets.length, 2);
  assert.equal(result.truncated, true);
});

test("跨位置 AOE 可以跨站位但不超过上限", () => {
  const units = [
    unit("a", "attacker", "front"),
    unit("e1", "defender", "front"),
    unit("e2", "defender", "center"),
    unit("e3", "defender", "rear"),
  ];
  const result = selectTargets({
    actor: units[0],
    units,
    spec: { side: "enemy", mode: "globalAoE", maxTargets: 2, allowSummons: true },
    attackType: "远程",
    withinPositionPolicy: stableWithinPositionPolicy,
  });
  assert.deepEqual(result.targets.map((target) => target.id), ["e1", "e2"]);
});

test("单体目标来自最高优先级站位", () => {
  const units = [
    unit("a", "attacker", "rear"),
    unit("e-front", "defender", "front"),
    unit("e-rear", "defender", "rear"),
  ];
  const result = selectTargets({
    actor: units[0],
    units,
    spec: { side: "enemy", mode: "single", maxTargets: 1, allowSummons: true },
    attackType: "近战",
  });
  // 后排攻击者的最高优先级是队伍后方，其次是前排
  assert.deepEqual(result.targets.map((target) => target.id), ["e-front"]);
});

test("self 目标不需要候选", () => {
  const units = [unit("a", "attacker", "front"), unit("e", "defender", "front")];
  const result = selectTargets({
    actor: units[0],
    units,
    spec: { side: "ally", mode: "self", maxTargets: 1, allowSummons: true },
    attackType: null,
  });
  assert.deepEqual(result.targets.map((target) => target.id), ["a"]);
});

test("候选过滤：同阵营、倒下、召唤物开关", () => {
  const units = [
    unit("a", "attacker", "front"),
    unit("dead", "defender", "front", { alive: false }),
    unit("summon", "defender", "front", { kind: "summon" }),
    unit("ally", "attacker", "front"),
  ];
  const enemyOnly = enumerateCandidates({
    actor: units[0],
    units,
    spec: { side: "enemy", mode: "single", maxTargets: 1, allowSummons: false },
    attackType: "近战",
  });
  assert.deepEqual(enemyOnly.candidates.map((candidate) => candidate.id), []);
  const withSummon = enumerateCandidates({
    actor: units[0],
    units,
    spec: { side: "enemy", mode: "single", maxTargets: 1, allowSummons: true },
    attackType: "近战",
  });
  assert.deepEqual(withSummon.candidates.map((candidate) => candidate.id), ["summon"]);
  const allies = enumerateCandidates({
    actor: units[0],
    units,
    spec: { side: "ally", mode: "single", maxTargets: 1, allowSummons: true },
    attackType: "近战",
  });
  assert.deepEqual(allies.candidates.map((candidate) => candidate.id), ["ally"]);
});

test("己方全体覆盖施法者以及所有己方单位", () => {
  const units = [
    unit("actor", "attacker", "front"),
    unit("ally-front", "attacker", "front"),
    unit("ally-rear", "attacker", "rear"),
    unit("enemy", "defender", "front"),
  ];
  const result = selectTargets({
    actor: units[0], units,
    spec: { side: "ally", mode: "globalAoE", maxTargets: Number.MAX_SAFE_INTEGER, allowSummons: true },
    configuredPriority: ["front"],
  });
  assert.deepEqual(new Set(result.targets.map((target) => target.id)), new Set(["actor", "ally-front", "ally-rear"]));
});

test("候选超过上限时随机选取是确定性可复现的", () => {
  const units = [
    unit("a", "attacker", "front"),
    unit("e1", "defender", "front"),
    unit("e2", "defender", "front"),
    unit("e3", "defender", "front"),
  ];
  const first = selectTargets({
    actor: units[0],
    units,
    spec: { side: "enemy", mode: "single", maxTargets: 1, allowSummons: true },
    attackType: "近战",
    randomStream: createRandomStream("pick-seed"),
  });
  const second = selectTargets({
    actor: units[0],
    units,
    spec: { side: "enemy", mode: "single", maxTargets: 1, allowSummons: true },
    attackType: "近战",
    randomStream: createRandomStream("pick-seed"),
  });
  assert.deepEqual(first.targets.map((target) => target.id), second.targets.map((target) => target.id));
  assert.equal(first.truncated, true);
});
