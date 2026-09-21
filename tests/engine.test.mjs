import test from "node:test";
import assert from "node:assert/strict";
import { simulateBattle, RULESET_VERSION, RANDOM_ALGORITHM_VERSION } from "../game/engine/simulate.mjs";
import { BATTLE_PHASES } from "../game/domain/phases.mjs";
import { renderEventsToText } from "../game/events/render.mjs";
import { verifyReplay, stableHash } from "../game/replay/envelope.mjs";
import { STARTER_SKILLS, STARTER_SKILL_BY_ID } from "../gamedata/overrides/starter-content.mjs";
import { createUnit, deriveUnit, effectiveSkillLevelOf } from "../game/engine/unit.mjs";
import { EffectLedger } from "../game/domain/effect.mjs";
import { manaCostValue } from "../game/formulas/mana-cost.mjs";
import { createDisplayBattleReport } from "../game/events/display-report.mjs";
import { createBattlePlan } from "../game/commands/battle-plan.mjs";

const HERO_ATTRIBUTES = {
  strength: 8, constitution: 9, intelligence: 4, dexterity: 12,
  charisma: 6, agility: 14, perception: 11, willpower: 7,
};
const MONSTER_ATTRIBUTES = {
  strength: 6, constitution: 6, intelligence: 2, dexterity: 8,
  charisma: 1, agility: 5, perception: 3, willpower: 2,
};

function heroUnit(overrides = {}) {
  const base = createUnit({
    id: "hero-1",
    name: "晴空",
    side: "attacker",
    kind: "hero",
    level: 10,
    position: "front",
    attributes: HERO_ATTRIBUTES,
    skills: { "basic-swordsmanship": { baseLevel: 4 } },
    healthRegeneration: 2,
    manaRegeneration: 3,
    ...overrides,
  });
  const derived = deriveUnit(base, { roundingPolicy: undefined });
  base.health = overrides.health ?? derived.healthMax;
  base.mana = overrides.mana ?? derived.manaMax;
  return base;
}

function monsterUnit(overrides = {}) {
  const base = createUnit({
    id: "monster-1",
    name: "训练木偶",
    side: "defender",
    kind: "monster",
    level: 3,
    position: "front",
    attributes: MONSTER_ATTRIBUTES,
    skills: { "club-strike": { baseLevel: 3 } },
    ...overrides,
  });
  const derived = deriveUnit(base, { roundingPolicy: undefined });
  base.health = overrides.health ?? derived.healthMax;
  base.mana = overrides.mana ?? derived.manaMax;
  return base;
}

function plans(heroOverrides = {}, monsterOverrides = {}) {
  return {
    "hero-1": {
      id: "hero-plan",
      name: "林地巡猎",
      mode: "pve",
      defaultPlan: { position: "front", initiativeSkillId: null, preRound: [], mainRound: [{ skillId: "basic-swordsmanship", repeat: "repeatWhilePossible" }], ...heroOverrides },
      floorOverrides: {},
      general: {},
    },
    "monster-1": {
      id: "monster-plan",
      name: "默认",
      mode: "pve",
      defaultPlan: { position: "front", initiativeSkillId: null, preRound: [], mainRound: [{ skillId: "club-strike", repeat: "normal" }], ...monsterOverrides },
      floorOverrides: {},
      general: {},
    },
  };
}

function run(options = {}) {
  return simulateBattle({
    initialState: {
      battleId: "battle-1",
      floorNumber: 1,
      units: [heroUnit(options.hero), monsterUnit(options.monster)],
      preRoundOrder: [],
    },
    battlePlans: options.battlePlans ?? plans(),
    skills: STARTER_SKILL_BY_ID,
    randomSeed: options.seed ?? "engine-test-1",
    rulesetVersion: RULESET_VERSION,
    contentVersion: "starter-content",
    maxRounds: options.maxRounds ?? 12,
    policies: options.policies,
  });
}

test("每回合严格按文档阶段顺序推进", () => {
  const result = run({ maxRounds: 1 });
  const firstRound = result.diagnostics.roundPhaseTrace.filter((entry) => entry.round === 1).map((entry) => entry.phase);
  assert.deepEqual(firstRound, [...BATTLE_PHASES]);
  assert.equal(result.diagnostics.rulesetVersion, RULESET_VERSION);
  assert.equal(result.diagnostics.randomAlgorithmVersion, RANDOM_ALGORITHM_VERSION);
});

test("回合前在自然回复之前，自然回复在先攻之前", () => {
  const result = run({ maxRounds: 2, hero: { health: 30, mana: 10 } });
  const round1 = result.events.filter((ev) => ev.round === 1);
  const regenIndex = round1.findIndex((ev) => ev.type === "ResourceChanged" && ev.resource === "health");
  const initiativeIndex = round1.findIndex((ev) => ev.type === "InitiativeRolled");
  const preRoundIndex = round1.findIndex((ev) => ev.phase === "PreRoundCommandsExecuted");
  assert.ok(regenIndex > -1, "缺少自然回复事件");
  assert.ok(initiativeIndex > -1, "缺少先攻事件");
  assert.ok(regenIndex < initiativeIndex, "自然回复必须发生在先攻之前");
  if (preRoundIndex > -1) assert.ok(preRoundIndex < regenIndex, "回合前必须在自然回复之前");
  // 阶段顺序同时记录在诊断轨迹里
  const phases = result.diagnostics.roundPhaseTrace.filter((entry) => entry.round === 1).map((entry) => entry.phase);
  assert.ok(phases.indexOf("NaturalRegenerationApplied") < phases.indexOf("InitiativeScheduleGenerated"));
});

test("先攻队列降序执行，且第 n 动与总动数正确关联", () => {
  const result = run({ maxRounds: 3 });
  const scheduled = result.events.filter((ev) => ev.type === "ActionScheduled");
  assert.ok(scheduled.length > 0);
  // 先攻降序只在本回合内成立，跨回合会重新生成
  for (const round of new Set(scheduled.map((entry) => entry.round))) {
    const inRound = scheduled.filter((entry) => entry.round === round);
    for (let index = 1; index < inRound.length; index += 1) {
      assert.ok(inRound[index - 1].initiative >= inRound[index].initiative, `第 ${round} 回合先攻必须降序`);
    }
  }
  for (const entry of scheduled) {
    assert.ok(entry.ordinal >= 1 && entry.ordinal <= entry.totalActions, `ordinal ${entry.ordinal} / total ${entry.totalActions}`);
  }
  // 同一单位的第 n 动先攻不高于第 n-1 动
  const byActor = new Map();
  for (const entry of scheduled) {
    const key = `${entry.round}:${entry.actorId}`;
    if (!byActor.has(key)) byActor.set(key, []);
    byActor.get(key).push(entry);
  }
  for (const entries of byActor.values()) {
    for (let index = 1; index < entries.length; index += 1) {
      assert.ok(entries[index].initiative <= entries[index - 1].initiative, "多次行动的先攻必须逐次衰减");
      assert.equal(entries[index].ordinal, entries[index - 1].ordinal + 1);
    }
  }
});

test("先攻技能按出手速度属性计算先攻，不进入攻击命中流程", () => {
  const initiativeSkill = {
    id: "battle-cry-initiative",
    name: "行动：战吼",
    baseType: "initiative",
    timing: { preRound: false, mainAction: false, initiative: true, reactiveDefense: false, passive: false },
    target: { side: "ally", mode: "self", maxTargets: 1, allowSummons: false },
    attributeFormula: { initiative: { primary: "strength", secondary: "agility" } },
    manaCost: null,
    effects: [{
      id: "battle-cry-buff",
      name: "战吼加速",
      duration: { kind: "untilBattleEnd" },
      modifiers: [{ kind: "flat", value: 3, target: { type: "derived", key: "initiative" } }],
    }],
  };
  const ledger = new EffectLedger();
  const result = simulateBattle({
    initialState: {
      battleId: "initiative-skill",
      floorNumber: 1,
      units: [heroUnit({ skills: { "battle-cry-initiative": { baseLevel: 4 } }, mana: 100 }), monsterUnit({ health: 9999 })],
      preRoundOrder: [],
    },
    battlePlans: plans({
      initiativeSkillId: "battle-cry-initiative",
      initiativeItemIds: ["war-drum"],
      initiativeCalledItems: [{ id: "war-drum", name: "战鼓" }],
      initiativeItemEffects: [{
        id: "war-drum-effect",
        name: "战鼓激励",
        sourceKind: "item",
        sourceId: "war-drum",
        duration: { kind: "untilBattleEnd" },
        modifiers: [{ kind: "flat", value: 2, target: { type: "attribute", key: "strength" } }],
      }],
      preRound: [],
    }),
    skills: { ...STARTER_SKILL_BY_ID, "battle-cry-initiative": initiativeSkill },
    effectLedger: ledger,
    randomSeed: "initiative-skill-seed",
    maxRounds: 1,
    contentVersion: "starter-content",
  });
  const rolled = result.events.find((event) => event.type === "InitiativeRolled" && event.actorId === "hero-1");
  const expectedMean = HERO_ATTRIBUTES.strength * 2 + HERO_ATTRIBUTES.agility + 4 * 2;
  assert.equal(rolled.initiativeMean, expectedMean);
  assert.ok(rolled.initiative >= 0 && rolled.initiative <= expectedMean * 2, `先攻投点 ${rolled.initiative} 超出 [0, ${expectedMean * 2}]`);
  assert.equal(result.events.some((event) => event.type === "AttackRolled" && event.actorId === "hero-1" && event.phase === "InitiativeSkillsExecuted"), false);
  assert.ok(result.events.some((event) => event.type === "InitiativeSkillCalculated" && event.actorId === "hero-1"));
  const buff = ledger.instances.find((instance) => instance.sourceSkillId === "battle-cry-initiative");
  assert.ok(buff, "先攻技能的目标效果应作为 Buff 附加");
  assert.ok(buff.components.some((component) => component.sourceKind === "item" && component.sourceId === "war-drum"), "先攻技能调用物品的目标效果应并入同一 Buff");
});

test("同一规则版本与种子产生完全相同的事件序列", () => {
  const first = run({ seed: "repeatable-seed" });
  const second = run({ seed: "repeatable-seed" });
  assert.deepEqual(second.events, first.events);
  assert.equal(second.replay.eventsHash, first.replay.eventsHash);
  assert.equal(second.replay.inputSnapshotHash, first.replay.inputSnapshotHash);
  const third = run({ seed: "different-seed" });
  assert.notEqual(third.replay.eventsHash, first.replay.eventsHash);
});

test("回放信封可校验事件序列", () => {
  const result = run({});
  const verification = verifyReplay(result.replay, result.events);
  assert.equal(verification.ok, true);
  assert.equal(verification.eventCount, result.events.length);
  const tampered = [...result.events, { type: "RoundStarted", round: 99, seq: 9999 }];
  assert.equal(verifyReplay(result.replay, tampered).ok, false);
  assert.equal(stableHash({ b: 1, a: 2 }), stableHash({ a: 2, b: 1 }));
});

test("战斗产生伤害、击倒与结束事件", () => {
  const result = run({ maxRounds: 12 });
  assert.ok(result.events.some((ev) => ev.type === "AttackRolled"));
  assert.ok(result.events.some((ev) => ev.type === "DamageApplied"));
  assert.ok(result.events.some((ev) => ev.type === "UnitDefeated"));
  const ended = result.events.find((ev) => ev.type === "BattleEnded");
  assert.ok(ended);
  assert.equal(result.finalState.result, "victory");
  assert.equal(ended.resultLabel, "胜利");
  const defeated = result.finalState.units.find((unit) => unit.id === "monster-1");
  assert.equal(defeated.alive, false);
  assert.equal(defeated.health, 0);
});

test("命中判定覆盖闪避与命中两种路径", () => {
  const result = run({ maxRounds: 12 });
  const resolved = result.events.filter((ev) => ev.type === "AttackResolved");
  assert.ok(resolved.length > 0);
  for (const ev of resolved) {
    assert.ok(["闪避", "命中", "重击", "致命一击"].includes(ev.grade));
    if (ev.grade === "闪避") {
      const damage = result.events.find((candidate) => candidate.type === "DamageApplied" && candidate.seq > ev.seq && candidate.seq < ev.seq + 3);
      assert.equal(damage, undefined, "闪避不应产生伤害");
    }
  }
});

test("伤害事件附带 CalculationTrace", () => {
  const result = run({ maxRounds: 12 });
  const damage = result.events.find((ev) => ev.type === "DamageApplied" && ev.amount > 0);
  assert.ok(damage);
  assert.ok(damage.trace);
  assert.equal(typeof damage.trace.base, "number");
  assert.equal(typeof damage.trace.exact, "number");
  assert.ok(Array.isArray(damage.trace.steps));
  assert.equal(damage.trace.applied, damage.amount);
  assert.ok(damage.diagnostics.pipelineId);
});

test("状态快照包含文档要求的字段", () => {
  const result = run({ maxRounds: 1 });
  const snapshots = result.events.filter((ev) => ev.type === "StatusSnapshot");
  assert.equal(snapshots.length, 2);
  for (const snapshot of snapshots) {
    assert.ok(snapshot.name);
    assert.equal(typeof snapshot.level, "number");
    assert.ok(snapshot.position);
    assert.equal(typeof snapshot.health, "number");
    assert.equal(typeof snapshot.resource, "number");
    assert.equal(snapshot.resourceLabel, "法力");
    assert.ok(snapshot.wounds);
    assert.ok(["毫发无伤", "轻伤", "受伤", "重伤", "倒下"].includes(snapshot.wounds), `状态必须为中文显示名，实际 ${snapshot.wounds}`);
    assert.ok(Array.isArray(snapshot.effects));
  }
});

test("回合前召唤参加当前回合，主回合召唤下一回合才行动", () => {
  const preRound = run({
    maxRounds: 3,
    battlePlans: plans({ preRound: [{ skillId: "call-familiar" }] }),
    hero: { mana: 200, skills: { "basic-swordsmanship": { baseLevel: 4 } } },
  });
  const createdPreRound = preRound.events.find((ev) => ev.type === "SummonCreated");
  assert.ok(createdPreRound);
  assert.equal(createdPreRound.joinsThisRound, true);
  const summonActions = preRound.events.filter((ev) => ev.type === "ActionScheduled" && ev.actorId === createdPreRound.summonId);
  assert.ok(summonActions.length > 0, "回合前召唤必须参加当前回合");
  assert.equal(summonActions[0].round, 1);

  const mainRound = run({
    maxRounds: 3,
    battlePlans: plans({ preRound: [], mainRound: [{ skillId: "call-familiar", repeat: "normal" }, { skillId: "basic-swordsmanship", repeat: "repeatWhilePossible" }] }),
    hero: { mana: 200 },
  });
  const createdMainRound = mainRound.events.find((ev) => ev.type === "SummonCreated");
  assert.ok(createdMainRound);
  assert.equal(createdMainRound.joinsThisRound, false);
  const summonActionsMain = mainRound.events.filter((ev) => ev.type === "ActionScheduled" && ev.actorId === createdMainRound.summonId);
  assert.ok(summonActionsMain.length > 0);
  assert.ok(summonActionsMain[0].round >= 2, `主回合召唤应至少从第 2 回合行动，实际第 ${summonActionsMain[0].round} 回合`);
});

test("召唤指令可以用数据库解析出的模板覆盖技能静态模板", () => {
  const result = run({
    maxRounds: 1,
    battlePlans: plans({ preRound: [{
      skillId: "call-familiar",
      target: { mode: "auto", priority: ["rightWing"] },
      summonTemplate: {
        name: "自然树灵", level: 5, position: "rear", attributes: HERO_ATTRIBUTES,
        actionsPerRoundExact: 2, baseStatDefaults: { actionsPerRound: 2 },
        skills: { "basic-swordsmanship": { baseLevel: 4 } },
        battlePlan: plans({ preRound: [], mainRound: [{ skillId: "basic-swordsmanship", repeat: "normal" }] })["hero-1"],
      },
    }] }),
    hero: { mana: 200 },
  });
  const created = result.events.find((event) => event.type === "SummonCreated");
  assert.equal(created.summonName, "自然树灵");
  assert.equal(created.position, "rightWing");
  const summonActions = result.events.filter((event) => event.type === "ActionScheduled" && event.actorId === created.summonId);
  assert.equal(summonActions.length, 2);
  assert.ok(result.events.some((event) => event.type === "SkillAttempted" && event.actorId === created.summonId && event.skillId === "basic-swordsmanship"));
});

test("召唤维持失败时召唤物消失", () => {
  const result = run({
    maxRounds: 3,
    battlePlans: plans({ preRound: [{ skillId: "call-familiar" }] }),
    hero: { mana: 10, manaRegeneration: 0 },
  });
  const dismissed = result.events.find((ev) => ev.type === "SummonDismissed");
  assert.ok(dismissed, "维持费用不足时应解散召唤物");
  assert.equal(dismissed.reason, "upkeepUnpaid");
  assert.equal(dismissed.reasonLabel, "维持失败");
});

test("回合前效果影响当前回合的回复与先攻", () => {
  const guardSkill = {
    ...STARTER_SKILL_BY_ID["guard-stance"],
  };
  const skills = { ...STARTER_SKILL_BY_ID, "guard-stance": guardSkill };
  const result = simulateBattle({
    initialState: {
      battleId: "battle-effects",
      floorNumber: 1,
      units: [heroUnit({ mana: 100 }), monsterUnit()],
      preRoundOrder: [],
    },
    battlePlans: plans({ preRound: [{ skillId: "guard-stance" }] }),
    skills,
    randomSeed: "effects-seed",
    maxRounds: 2,
    contentVersion: "starter-content",
  });
  const applied = result.events.find((ev) => ev.type === "EffectApplied");
  assert.ok(applied);
  assert.equal(applied.effectId, "架势：守势");
  assert.equal(applied.state, "active");
  const expired = result.events.find((ev) => ev.type === "EffectExpired" && ev.effectName === "架势：守势");
  assert.ok(expired, "持续 1 个回合的守势应在第 2 回合末结束");
});

test("同源效果不重复附加并产生诊断", () => {
  const result = run({
    // 守势覆盖当前回合与下一回合；只检查其首次到期前的重复施放。
    // 第 3 回合到期后重新施放属于合法行为，不能依赖随机伤害让战斗提前结束。
    maxRounds: 2,
    battlePlans: plans({ preRound: [{ skillId: "guard-stance" }] }),
    hero: { mana: 100 },
  });
  const appliedCount = result.events.filter((ev) => ev.type === "EffectApplied" && ev.effectId === "架势：守势").length;
  assert.equal(appliedCount, 1, "同一技能同目标未结束前不得重复附加");
});

test("同源 Buff 仍生效时跳过该指令：不产生事件、不消耗行动，直接执行下一条", () => {
  const lastingBuff = {
    ...STARTER_SKILL_BY_ID["guard-stance"],
    timing: { preRound: false, mainAction: true, initiative: false, reactiveDefense: false, passive: false },
    manaCost: null,
    effects: STARTER_SKILL_BY_ID["guard-stance"].effects.map((effect) => ({ ...effect, duration: { kind: "untilBattleEnd" } })),
  };
  const result = simulateBattle({
    initialState: {
      battleId: "same-source-skip",
      floorNumber: 1,
      units: [
        heroUnit({
          skills: { "guard-stance": { baseLevel: 4 } },
          baseStatDefaults: { actionsPerRound: 3 },
          mana: 100,
        }),
        monsterUnit(),
      ],
      preRoundOrder: [],
    },
    battlePlans: plans({
      preRound: [],
      mainRound: [
        { id: "lasting-buff", skillId: "guard-stance", repeat: "normal" },
        { id: "attack", skillId: "basic-swordsmanship", repeat: "normal" },
      ],
    }),
    skills: { ...STARTER_SKILL_BY_ID, "guard-stance": lastingBuff },
    randomSeed: "same-source-skip-seed",
    maxRounds: 1,
    contentVersion: "starter-content",
  });

  // 第 1 动施放 Buff，第 2 动攻击，第 3 动本会重复施放 Buff —— 该次调用是空操作，
  // 必须被跳过并且不消耗行动，于是第 3 动继续执行下一条（攻击）。
  const attempts = result.events.filter((event) => event.type === "SkillAttempted" && event.actorId === "hero-1").map((event) => event.skillId);
  assert.deepEqual(attempts, ["guard-stance", "basic-swordsmanship", "basic-swordsmanship"], "空操作不应占掉行动");
  assert.equal(result.events.filter((event) => event.type === "SkillFailed" && event.actorId === "hero-1").length, 0, "跳过的调用不应产生失败事件");
  assert.equal(result.events.filter((event) => event.type === "EffectApplied" && event.sourceSkillId === "guard-stance").length, 1, "同一技能同目标未结束前不得重复附加");

  const report = createDisplayBattleReport({
    dungeonName: "测试地城",
    battleName: "测试战斗",
    result: result.finalState.result,
    roundCount: result.finalState.round,
    levelNumber: 1,
    events: result.events,
  });
  const heroActions = report.rounds[0].mainRound.filter((action) => action.actor.id === "hero-1");
  assert.deepEqual(heroActions.map((action) => action.skill.id), ["guard-stance", "basic-swordsmanship", "basic-swordsmanship"]);
  assert.equal(heroActions[0].failure, null, "首次施放已成功，不应被后续失败事件覆盖");
});

test("法力消耗按实时技能等级计算并扣除", () => {
  const result = run({
    maxRounds: 2,
    battlePlans: plans({ preRound: [{ skillId: "guard-stance" }] }),
    hero: { mana: 100 },
  });
  const spent = result.events.find((ev) => ev.type === "ResourceSpent" && ev.reason === "skillCost");
  assert.ok(spent);
  assert.equal(spent.amount, manaCostValue({ standardCost: 8, skillLevel: 0 }));
  assert.equal(spent.trace.applied, spent.amount);
});

test("付不起法力的指令被跳过：不产生事件、不扣法力、不消耗行动", () => {
  const result = run({
    maxRounds: 1,
    battlePlans: plans({ preRound: [{ id: "guard", skillId: "guard-stance", repeat: "normal" }] }),
    hero: { mana: 0 },
  });
  assert.equal(result.events.some((event) => event.type === "SkillAttempted" && event.skillId === "guard-stance"), false, "预检不通过不应发起调用");
  assert.equal(result.events.some((event) => event.type === "SkillFailed" && event.skillId === "guard-stance"), false, "不再出现“失败：法力不足”提示");
  assert.equal(result.events.some((event) => event.type === "TargetSelected" && event.actorId === "hero-1" && event.phase === "PreRoundCommandsExecuted"), false);
  assert.equal(result.events.some((event) => event.type === "EffectApplied" && event.actorId === "hero-1" && event.phase === "PreRoundCommandsExecuted"), false);
  assert.equal(result.events.some((event) => event.type === "ResourceSpent" && event.reason === "skillCost"), false, "跳过的指令不应扣法力");
});

test("法力不足的指令顺位跳过，后续行动一直使用付得起的那条（不再交替出现失败）", () => {
  // report 66 的场景：威势：战争怒吼 消耗 31 点法力但角色只有 27，
  // 于是第 1 动失败、第 2 动破盾攻击，来回交替。正确行为是每动都直接使用破盾攻击。
  const expensive = {
    ...STARTER_SKILL_BY_ID["guard-stance"],
    id: "expensive-warcry",
    name: "威势：战争怒吼",
    timing: { preRound: false, mainAction: true, initiative: false, reactiveDefense: false, passive: false },
    manaCost: { standard: 8, display: 8 },
    effects: STARTER_SKILL_BY_ID["guard-stance"].effects.map((effect) => ({ ...effect, duration: { kind: "untilBattleEnd" } })),
  };
  const result = simulateBattle({
    initialState: {
      battleId: "mana-skip",
      floorNumber: 1,
      units: [heroUnit({ baseStatDefaults: { actionsPerRound: 2 }, mana: 1, manaRegeneration: 3 }), monsterUnit({ health: 9999 })],
      preRoundOrder: [],
    },
    battlePlans: plans({
      preRound: [],
      mainRound: [
        { id: "warcry", skillId: "expensive-warcry", repeat: "normal" },
        { id: "attack", skillId: "basic-swordsmanship", repeat: "normal" },
      ],
    }),
    skills: { ...STARTER_SKILL_BY_ID, "expensive-warcry": expensive },
    randomSeed: "mana-skip-seed",
    maxRounds: 1,
    contentVersion: "starter-content",
  });

  const attempts = result.events.filter((event) => event.type === "SkillAttempted" && event.actorId === "hero-1").map((event) => event.skillId);
  assert.deepEqual(attempts, ["basic-swordsmanship", "basic-swordsmanship"], "两次行动都顺位到付得起的技能，而不是交替失败");
  assert.equal(result.events.filter((event) => event.type === "SkillFailed" && event.actorId === "hero-1").length, 0, "跳过的指令不应产生失败事件");
  assert.equal(result.events.some((event) => event.type === "ResourceSpent" && event.skillId === "expensive-warcry"), false);

  const report = createDisplayBattleReport({
    dungeonName: "测试地城",
    battleName: "测试战斗",
    result: result.finalState.result,
    roundCount: result.finalState.round,
    levelNumber: 1,
    events: result.events,
  });
  const heroActions = report.rounds[0].mainRound.filter((action) => action.actor.id === "hero-1");
  assert.deepEqual(heroActions.map((action) => action.skill.name), ["基础：剑术", "基础：剑术"]);
  assert.deepEqual(heroActions.map((action) => action.failure), [null, null]);
});

test("战斗文本渲染不决定结果", () => {
  const result = run({ maxRounds: 2 });
  const text = renderEventsToText(result.events);
  assert.match(text, /\[回合\] 第 1 回合开始/);
  assert.match(text, /\[先攻\]/);
  assert.match(text, /\[结算\] 战斗结束/);
  const first = run({ maxRounds: 2 });
  assert.equal(renderEventsToText(first.events), text);
});

test("诊断记录实验性策略清单", () => {
  const result = run({ maxRounds: 1 });
  assert.ok(result.diagnostics.experimentalPolicies.length > 0);
  assert.ok(result.diagnostics.experimentalPolicies.some((entry) => entry.startsWith("roll:")));
  assert.ok(result.diagnostics.experimentalPolicies.some((entry) => entry.startsWith("evade:")));
  assert.ok(!result.diagnostics.experimentalPolicies.some((entry) => entry.startsWith("decay:")), "已验证的 32 步先攻策略不应标为实验");
});

test("效果账本在引擎中按目标聚合修正", () => {
  const ledger = new EffectLedger();
  ledger.apply({
    effectDefinitionId: "str",
    sourceActorId: "a",
    sourceSkillId: "s",
    targetId: "hero-1",
    appliedRound: 1,
    appliedPhase: "PreRoundCommandsExecuted",
    modifiers: [{ kind: "flat", value: 10, target: { type: "attribute", key: "strength" } }],
  });
  const unit = heroUnit();
  const without = deriveUnit(unit, { roundingPolicy: undefined });
  const withEffect = deriveUnit(unit, { roundingPolicy: undefined, effectLedger: ledger });
  assert.equal(withEffect.attributes.strength, without.attributes.strength + 10);
  // 力量 +10 → 体力上限 +20（体力上限 = 体质 × 3 + 力量 × 2）
  assert.equal(withEffect.healthMax, without.healthMax + 20);
});

test("未显式给出当前资源的单位按上限初始化，不会开局即倒下", () => {
  const hero = createUnit({
    id: "h",
    name: "无资源英雄",
    side: "attacker",
    attributes: HERO_ATTRIBUTES,
    skills: { "basic-swordsmanship": { baseLevel: 4 } },
  });
  const monster = createUnit({
    id: "m",
    name: "无资源木偶",
    side: "defender",
    attributes: MONSTER_ATTRIBUTES,
    skills: { "club-strike": { baseLevel: 3 } },
  });
  assert.equal(hero.health, null);
  const result = simulateBattle({
    initialState: { battleId: "no-resources", units: [hero, monster], floorNumber: 1 },
    battlePlans: plans(),
    skills: STARTER_SKILL_BY_ID,
    randomSeed: "no-resources-seed",
    maxRounds: 1,
  });
  const snapshot = result.events.find((ev) => ev.type === "StatusSnapshot" && ev.unitId === "m");
  assert.equal(snapshot.health, snapshot.healthMax);
  assert.notEqual(snapshot.wounds, "倒下");
  assert.equal(snapshot.wounds, "毫发无伤");
});

test("没有显式方案的单位使用确定性兜底方案并实际行动", () => {
  const result = simulateBattle({
    initialState: { battleId: "implicit", floorNumber: 1, units: [heroUnit(), monsterUnit()] },
    battlePlans: { "hero-1": plans()["hero-1"] },
    skills: STARTER_SKILL_BY_ID,
    randomSeed: "implicit-plan-seed",
    maxRounds: 3,
  });
  const monsterAttempts = result.events.filter((ev) => ev.type === "SkillAttempted" && ev.actorId === "monster-1");
  assert.ok(monsterAttempts.length > 0, "无方案单位必须按兜底方案行动");
  assert.equal(monsterAttempts[0].skillId, "club-strike");
  assert.ok(result.diagnostics.experimentalPolicies.includes("defaultPlan:first-available-skill"));
  assert.equal(result.events.some((ev) => ev.type === "SkillFailed" && ev.reason === "noCommands"), false);
});

test("一圈都不可用时本次行动失败并消耗行动点，战报显示「无法执行任何行动」", () => {
  const lastingBuff = {
    ...STARTER_SKILL_BY_ID["guard-stance"],
    timing: { preRound: false, mainAction: true, initiative: false, reactiveDefense: false, passive: false },
    manaCost: null,
    effects: STARTER_SKILL_BY_ID["guard-stance"].effects.map((effect) => ({ ...effect, duration: { kind: "untilBattleEnd" } })),
  };
  const result = simulateBattle({
    initialState: {
      battleId: "no-usable-command",
      floorNumber: 1,
      units: [heroUnit({ skills: { "guard-stance": { baseLevel: 4 } }, baseStatDefaults: { actionsPerRound: 3 }, mana: 100 }), monsterUnit({ health: 9999 })],
      preRoundOrder: [],
    },
    battlePlans: plans({ preRound: [], mainRound: [{ id: "lasting-buff", skillId: "guard-stance", repeat: "normal" }] }),
    skills: { ...STARTER_SKILL_BY_ID, "guard-stance": lastingBuff },
    randomSeed: "no-usable-command-seed",
    maxRounds: 1,
    contentVersion: "starter-content",
  });
  // 第 1 动施放 Buff；第 2、3 动这一圈只有同源仍在生效的 Buff，判定为失败并消耗行动点。
  const failures = result.events.filter((event) => event.type === "SkillFailed" && event.actorId === "hero-1" && event.reason === "noUsableCommand");
  assert.equal(failures.length, 2, "两个行动槽都判定为失败");
  assert.ok(failures.every((event) => event.consumedAction === true), "失败必须消耗行动点");
  assert.ok(failures.every((event) => event.actionSchedule?.ordinal >= 2), "每个行动槽各自记录自己的先攻序号");
  assert.equal(result.events.filter((event) => event.type === "EffectApplied" && event.sourceSkillId === "guard-stance").length, 1);

  const report = createDisplayBattleReport({
    dungeonName: "测试地城",
    battleName: "测试战斗",
    result: result.finalState.result,
    roundCount: result.finalState.round,
    levelNumber: 1,
    events: result.events,
  });
  const heroActions = report.rounds[0].mainRound.filter((action) => action.actor.id === "hero-1");
  assert.equal(heroActions.length, 3);
  assert.equal(heroActions[0].skill.name, "架势：守势");
  assert.equal(heroActions[0].failure, null);
  for (const action of heroActions.slice(1)) {
    assert.equal(action.skill.name, null, "行动级失败没有具体技能");
    assert.deepEqual(action.failure, { reason: "noUsableCommand", reasonLabel: "无法执行任何行动" });
    assert.deepEqual(action.targets, []);
    assert.ok(action.schedule, "仍然显示先攻序号");
  }
  assert.match(renderEventsToText(result.events), /晴空 无法执行任何行动。/);
});

test("英雄没有保存行动设置时提示无法行动，不自动挑选技能", () => {
  const result = simulateBattle({
    initialState: { battleId: "hero-without-settings", floorNumber: 1, units: [heroUnit(), monsterUnit()] },
    battlePlans: { "monster-1": plans()["monster-1"] },
    skills: STARTER_SKILL_BY_ID,
    randomSeed: "hero-without-settings-seed",
    maxRounds: 1,
  });
  assert.equal(result.events.some((ev) => ev.type === "SkillAttempted" && ev.actorId === "hero-1"), false);
  const failures = result.events.filter((ev) => ev.type === "SkillFailed" && ev.actorId === "hero-1" && ev.reason === "noCommands");
  assert.ok(failures.length >= 1);
  assert.ok(failures.every((ev) => ev.consumedAction === true), "没有配置指令同样消耗行动点");
  assert.ok(failures.every((ev) => ev.actionSchedule), "每个行动槽各有一条提示");
  const report = createDisplayBattleReport({
    dungeonName: "测试地城",
    battleName: "测试战斗",
    result: result.finalState.result,
    roundCount: result.finalState.round,
    levelNumber: 1,
    events: result.events,
  });
  const heroRows = report.rounds[0].mainRound.filter((action) => action.actor.id === "hero-1");
  assert.equal(heroRows.length, failures.length, "每条提示在战报里各占一行");
  assert.ok(heroRows.every((action) => action.failure?.reasonLabel === "没有配置指令"));
  assert.match(renderEventsToText(result.events), /晴空 没有配置指令。/);
});

test("干等指令消耗本次行动且不尝试释放技能", () => {
  const result = run({
    maxRounds: 1,
    battlePlans: plans({ mainRound: [
      { id: "wait", skillId: "__wait__", repeat: "normal" },
      { id: "attack", skillId: "basic-swordsmanship", repeat: "normal" },
    ] }),
  });
  const waited = result.events.filter((event) => event.type === "ActionWaited" && event.actorId === "hero-1");
  const attempts = result.events.filter((event) => event.type === "SkillAttempted" && event.actorId === "hero-1");
  assert.equal(waited.length, 1);
  assert.equal(attempts.length, 0);
});

test("释放位置没有单位时在同一次行动中继续检查下一项设置", () => {
  const result = run({
    maxRounds: 1,
    battlePlans: plans({ mainRound: [
      { id: "empty-position", skillId: "basic-swordsmanship", repeat: "normal", target: { priority: ["rightRear"] } },
      { id: "occupied-position", skillId: "basic-swordsmanship", repeat: "normal", target: { priority: ["front"] } },
    ] }),
  });
  const attempts = result.events.filter((ev) => ev.type === "SkillAttempted" && ev.actorId === "hero-1");
  assert.deepEqual(attempts.map((ev) => ev.skillId), ["basic-swordsmanship", "basic-swordsmanship"]);
  assert.ok(result.events.some((ev) => ev.type === "SkillFailed" && ev.actorId === "hero-1" && ev.reason === "noTargets"));
  assert.ok(result.events.some((ev) => ev.type === "AttackRolled" && ev.actorId === "hero-1"));
});

test("范围技能对覆盖到的每个目标分别进行命中投掷", () => {
  const aoe = {
    ...STARTER_SKILL_BY_ID["basic-swordsmanship"],
    id: "sweeping-strike",
    name: "横扫",
    target: { side: "enemy", mode: "globalAoE", maxTargets: 3, allowSummons: true },
  };
  const second = monsterUnit({ id: "monster-2", name: "第二木偶" });
  const result = simulateBattle({
    initialState: { battleId: "aoe", floorNumber: 1, units: [heroUnit({ skills: { "sweeping-strike": { baseLevel: 4 } } }), monsterUnit(), second] },
    battlePlans: plans({ mainRound: [{ id: "aoe", skillId: "sweeping-strike", repeat: "normal", target: { priority: ["front"] } }] }),
    skills: { ...STARTER_SKILL_BY_ID, "sweeping-strike": aoe },
    randomSeed: "aoe-seed",
    maxRounds: 1,
  });
  const rolledTargets = result.events.filter((ev) => ev.type === "AttackRolled" && ev.actorId === "hero-1").map((ev) => ev.targetId);
  assert.deepEqual(new Set(rolledTargets), new Set(["monster-1", "monster-2"]));
});

test("动态目标上限 2 +10%×英雄等级在 40 级覆盖 6 人", () => {
  const natureLore = {
    id: "nature-lore",
    name: "天赋：自然学识",
    baseType: "improve",
    timing: { preRound: false, mainAction: true, initiative: false, reactiveDefense: false, passive: false },
    target: {
      side: "ally",
      mode: "globalAoE",
      maxTargets: 2,
      maxTargetsFormula: { base: 2, terms: [{ scale: "heroLevel", ratio: 10 }] },
      allowSummons: true,
    },
    manaCost: null,
    attributeFormula: {},
    effects: [],
  };
  const actor = heroUnit({ id: "nature", name: "丰饶", level: 40, skills: { "nature-lore": { baseLevel: 4 } } });
  const allies = Array.from({ length: 6 }, (_, index) => heroUnit({ id: `ally-${index + 1}`, name: `队友${index + 1}` }));
  const result = simulateBattle({
    initialState: { battleId: "dynamic-target-count", floorNumber: 1, units: [actor, ...allies, monsterUnit()] },
    battlePlans: { nature: createBattlePlan({ actorId: "nature", defaultPlan: { position: "front", initiativeSkillId: null, preRound: [], mainRound: [{ id: "nature", skillId: "nature-lore", repeat: "normal" }] } }) },
    skills: { "nature-lore": natureLore },
    randomSeed: "dynamic-target-count",
    maxRounds: 1,
  });
  const targets = result.events.filter((event) => event.type === "TargetSelected" && event.actorId === "nature");
  assert.equal(targets.length, 6);
});

test("Buff 合并技能、多个调用物品和套装效果，并取最长持续时间", () => {
  const ledger = new EffectLedger();
  const result = simulateBattle({
    initialState: { battleId: "composite-buff", floorNumber: 1, units: [heroUnit({ mana: 100 }), monsterUnit()] },
    battlePlans: plans({ preRound: [{
      id: "composite",
      skillId: "guard-stance",
      itemIds: ["item-a", "item-b"],
      itemEffects: [{
        id: "item-target",
        duration: { kind: "untilBattleEnd" },
        activation: { kind: "nextRound" },
        modifiers: [{ kind: "flat", value: 4, target: { type: "attribute", key: "agility" } }],
      }],
      setEffects: [{
        id: "set-target",
        duration: { kind: "untilDungeonEnd" },
        activation: { kind: "afterRounds", value: 2 },
        modifiers: [{ kind: "flat", value: -4, target: { type: "attribute", key: "agility" } }],
      }],
    }] }),
    skills: STARTER_SKILL_BY_ID,
    randomSeed: "composite-buff-seed",
    maxRounds: 1,
    effectLedger: ledger,
  });
  const buff = ledger.instances.find((instance) => instance.buffKey === "架势：守势");
  assert.ok(buff);
  assert.deepEqual(buff.sourceItemIds, ["item-a", "item-b"]);
  assert.deepEqual(new Set(buff.components.map((component) => component.sourceKind)), new Set(["skill", "item", "itemSet"]));
  assert.deepEqual(buff.duration, { kind: "untilDungeonEnd" });
  assert.ok(result.events.some((ev) => ev.type === "EffectApplied" && ev.effectName === "架势：守势"));
  assert.equal(buff.state, "active", "组合 Buff 在施加时就应存在");
  assert.equal(buff.modifiers.find((modifier) => modifier.value === 4).activationRound, 2);
  assert.equal(buff.modifiers.find((modifier) => modifier.value === -4).activationRound, 4);
  assert.equal(buff.modifiers.find((modifier) => modifier.value === 4).state, "active", "下回合效果应在第一回合结束时激活");
  assert.equal(buff.modifiers.find((modifier) => modifier.value === -4).state, "pending", "2 个回合后效果不应提前激活");
});

test("按技能等级缩放的目标 Buff 在行动时求值，等量正负修正对称取整", () => {
  const effect = {
    id: "scaled-item-effect",
    name: "对技能等级的奖励",
    sourceId: "8746",
    duration: { kind: "untilDungeonEnd" },
    modifiers: [
      { kind: "scaledPercent", scale: "skillLevel", ratio: 15, target: { type: "skill", key: "skill-119", label: "启发：智慧之语" } },
      { kind: "scaledPercent", scale: "skillLevel", ratio: -15, target: { type: "skill", key: "skill-119", label: "启发：智慧之语" } },
    ],
  };
  const ledger = new EffectLedger();
  const result = simulateBattle({
    initialState: { battleId: "scaled-buff", floorNumber: 1, units: [heroUnit({ skills: { "guard-stance": { baseLevel: 31.45 } }, mana: 100 }), monsterUnit()] },
    battlePlans: plans({ preRound: [{ id: "scaled", skillId: "guard-stance", itemIds: ["8746"], itemEffects: [effect] }] }),
    skills: STARTER_SKILL_BY_ID,
    randomSeed: "scaled-buff-seed",
    maxRounds: 1,
    effectLedger: ledger,
  });
  const attempt = result.events.find((event) => event.type === "SkillAttempted" && event.actorId === "hero-1");
  assert.equal(attempt.actionSnapshot.heroLevel, 10);
  assert.equal(attempt.actionSnapshot.itemEffects[0].values[0].value, 4);
  assert.equal(attempt.actionSnapshot.itemEffects[0].values[1].value, -4);
  assert.equal(attempt.actionSnapshot.itemEffects[0].values[0].target.label, "启发：智慧之语");
  const scaledValues = ledger.instances.find((instance) => instance.buffKey === "架势：守势").modifiers
    .filter((modifier) => modifier.target?.key === "skill-119")
    .map((modifier) => modifier.value);
  assert.deepEqual(scaledValues, [4, -4]);
});

test("技能类别的纯百分比 Buff 按目标技能基础等级计算", () => {
  const ledger = new EffectLedger();
  ledger.apply({
    effectDefinitionId: "理想乡", effectName: "理想乡", buffKey: "理想乡",
    sourceSkillId: "skill-1888", targetId: "hero-1", applicationGroup: "buff",
    appliedRound: 1, appliedPhase: "PreRoundCommandsExecuted", duration: { kind: "untilDungeonEnd" },
    modifiers: [{ kind: "percent", value: 75, target: { type: "skill", key: "治疗技能类别的所有技能" } }],
  });
  const unit = heroUnit({ skills: { healing: { baseLevel: 10, equipmentBonus: 0, otherBonus: 0 } } });
  assert.equal(effectiveSkillLevelOf(unit, "healing", { effectLedger: ledger, skill: { id: "healing", skillTypeNames: ["治疗技能"] } }), 17.5);
});

test("回合前指令按重复模式推进而不是每回合重复同一条", () => {
  const skills = {
    ...STARTER_SKILL_BY_ID,
    "second-buff": {
      id: "second-buff",
      name: "第二个增益",
      baseType: "improve",
      attackType: null,
      timing: { preRound: true, mainAction: false, initiative: false, reactiveDefense: false, passive: false },
      target: { side: "ally", mode: "self", maxTargets: 1, allowSummons: true, rawText: "自己" },
      attributeFormula: null,
      manaCost: { standard: 1, display: 1 },
      itemRequirement: null,
      effects: [{ id: "second-buff-effect", name: "第二增益", duration: { kind: "rounds", value: 1 }, modifiers: [] }],
    },
  };
  const result = simulateBattle({
    initialState: { battleId: "pre-round-cursor", floorNumber: 1, units: [heroUnit({ mana: 200 }), monsterUnit()] },
    battlePlans: {
      ...plans(),
      "hero-1": {
        ...plans()["hero-1"],
        defaultPlan: {
          position: "front",
          initiativeSkillId: null,
          preRound: [{ id: "p1", skillId: "guard-stance", repeat: "normal" }, { id: "p2", skillId: "second-buff", repeat: "normal" }],
          mainRound: [{ skillId: "basic-swordsmanship", repeat: "repeatWhilePossible" }],
        },
      },
    },
    skills,
    randomSeed: "pre-round-cursor-seed",
    maxRounds: 2,
  });
  const preRoundAttempts = result.events.filter((ev) => ev.type === "SkillAttempted" && ev.phase === "PreRoundCommandsExecuted");
  assert.deepEqual(preRoundAttempts.map((ev) => ev.skillId), ["guard-stance", "second-buff"]);
});

test("无限持续的回合前 Buff 仍生效时不再尝试，也不产生失败提示", () => {
  const persistent = {
    ...STARTER_SKILL_BY_ID["guard-stance"],
    id: "persistent-party-buff",
    name: "长效理想乡",
    target: { side: "ally", mode: "globalAoE", maxTargets: Number.MAX_SAFE_INTEGER, allowSummons: true },
    effects: [{ id: "persistent-mana", name: "法力奖励", duration: { kind: "untilDungeonEnd" }, modifiers: [{ kind: "flat", value: 1, target: { type: "derived", key: "manaMax" } }] }],
  };
  const ally = heroUnit({ id: "hero-2", name: "同伴" });
  const result = simulateBattle({
    initialState: { battleId: "persistent-pre-round", floorNumber: 1, units: [heroUnit({ skills: { "persistent-party-buff": { baseLevel: 10 } }, mana: 200 }), ally, monsterUnit()] },
    battlePlans: plans({ preRound: [{ id: "persistent", skillId: "persistent-party-buff", repeat: "normal" }] }),
    skills: { ...STARTER_SKILL_BY_ID, "persistent-party-buff": persistent },
    randomSeed: "persistent-pre-round-seed",
    maxRounds: 2,
  });
  const attempts = result.events.filter((event) => event.type === "SkillAttempted" && event.skillId === "persistent-party-buff");
  assert.equal(attempts.length, 1, "效果仍生效的回合前调用是空操作：不产生尝试、不再消耗法力");
  assert.equal(result.events.filter((event) => event.type === "SkillFailed" && event.skillId === "persistent-party-buff").length, 0, "空操作不应产生失败提示");
  assert.equal(result.events.filter((event) => event.type === "EffectApplied" && event.sourceSkillId === "persistent-party-buff").length, 2, "首次施放对两个目标各应用一次");
  const targets = result.events.filter((event) => event.type === "TargetSelected" && event.actorId === "hero-1" && event.round === 1 && event.phase === "PreRoundCommandsExecuted").map((event) => event.targetId);
  assert.deepEqual(new Set(targets), new Set(["hero-1", "hero-2"]));
  // 第 2 回合的回合前阶段完全没有任何行动事件。
  assert.equal(result.events.some((event) => event.round === 2 && event.phase === "PreRoundCommandsExecuted"), false);
  const roundTwoStatus = result.events.find((event) => event.type === "StatusSnapshot" && event.round === 2 && event.unitId === "hero-2");
  assert.equal(roundTwoStatus.buffSnapshots[0].name, "长效理想乡");
  assert.equal(roundTwoStatus.buffSnapshots[0].values[0].target.key, "manaMax");
});

test("回合前 Buff 到期后仍会重新释放（跳过不会让指令失效）", () => {
  const result = simulateBattle({
    initialState: { battleId: "pre-round-recast", floorNumber: 1, units: [heroUnit({ mana: 200 }), monsterUnit({ health: 9999 })], preRoundOrder: [] },
    battlePlans: plans({ preRound: [{ id: "guard", skillId: "guard-stance", repeat: "normal" }] }),
    skills: STARTER_SKILL_BY_ID,
    randomSeed: "pre-round-recast-seed",
    maxRounds: 4,
  });
  // 守势持续“1 个回合”＝当前回合与下一个回合：第 1 回合释放，第 2 回合因仍生效被跳过，第 3 回合重新释放。
  const appliedRounds = result.events.filter((event) => event.type === "EffectApplied" && event.sourceSkillId === "guard-stance").map((event) => event.round);
  assert.deepEqual(appliedRounds, [1, 3]);
  assert.equal(result.events.some((event) => event.type === "SkillFailed" && event.skillId === "guard-stance" && event.reason === "sameSourceActive"), false, "跳过不应产生失败提示");
});

test("技能定义集合自检", () => {
  assert.ok(STARTER_SKILLS.length >= 6);
  for (const skill of STARTER_SKILLS) {
    assert.ok(skill.id && skill.name && skill.baseType);
    assert.ok(skill.evidence, `技能 ${skill.id} 缺少证据标注`);
  }
});
