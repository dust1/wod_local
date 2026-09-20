// 战斗引擎状态机。设计文档 §11、§18、§21。
//
// 每回合阶段顺序（A 级规则，必须逐阶段产生事件）：
//   RoundStarted → StatusSnapshotPublished → PreRoundCommandsExecuted
//   → NaturalRegenerationApplied → SummonUpkeepPaid → InitiativeSkillsExecuted
//   → InitiativeScheduleGenerated → MainActionsExecuted → ExpiredEffectsRemoved
//   → RoundEnded
//
// 引擎不依赖 React、数据库、HTML 或网络；所有随机性来自注入的种子。

import { BATTLE_PHASES } from "../domain/phases.mjs";
import { POSITION_LABELS } from "../domain/positions.mjs";
import { EffectLedger, activationRoundOf, sameSourceBehavior } from "../domain/effect.mjs";
import { event, resetEventSequence } from "../events/types.mjs";
import { createRandomStream } from "../policies/random.mjs";
import { DEFAULT_ROLL_POLICY, createUniformRollPolicy } from "../policies/roll.mjs";
import { buildInitiativeSchedule, DEFAULT_DECAY_POLICY, DEFAULT_TIE_BREAK_POLICY } from "../policies/initiative.mjs";
import { resolveDamage, zeroHitGradePercents, zeroReductionPolicy } from "../formulas/damage-pipeline.mjs";
import { hitGradeDetail, debuffApplies } from "../formulas/hit-grade.mjs";
import { skillRollMean } from "../formulas/rolls.mjs";
import { createUnit, deriveUnit, effectiveSkillLevelOf, regenerate, skillManaCost, skillMeans } from "./unit.mjs";
import { selectTargets } from "../targeting/select.mjs";
import { CommandCursor, FAILURE_REASON_LABELS, defaultFailureCostPolicy, interpretMainCommands } from "../commands/cursor.mjs";
import { WAIT_COMMAND_SKILL_ID } from "../commands/battle-plan.mjs";
import { createBattlePlan, resolveFloorPlan } from "../commands/battle-plan.mjs";
import { collectHealingTriggers, selectHealingInterrupt, defaultWoundThresholdPolicy, defaultHealingPriorityPolicy, assessWounds, WOUND_LABELS } from "../commands/healing.mjs";
import { createReplayEnvelope, hashInputSnapshot } from "../replay/envelope.mjs";
import { DEFAULT_ROUNDING_POLICY } from "../formulas/calculation.mjs";
import { meleePositionHitPercent, isMeleeAttackType } from "../domain/positions.mjs";
import { resolveModifier } from "../modifiers/pipeline.mjs";

export const RULESET_VERSION = "wod-complete-rules-v2";
export const RANDOM_ALGORITHM_VERSION = "mulberry32-fnv1a-v1";
export const DEFAULT_MAX_ROUNDS = 30;

const ATTACKER_SIDE = "attacker";

function toSkillMap(skills) {
  if (skills instanceof Map) return skills;
  return new Map(Object.entries(skills ?? {}));
}

function unitSideLabel(side) {
  return side === ATTACKER_SIDE ? "进攻者" : "防御者";
}

const GRADE_INDEX = Object.freeze({ "命中": 0, "重击": 1, "致命一击": 2 });

function matchesScope(value, expected) {
  return value == null || value === "所有" || value === expected;
}

function applyCombatBonus(base, rows = [], label) {
  const applicable = rows.filter((row) => matchesScope(row.label, label));
  const multiplier = applicable.reduce((value, row) => value * (1 + Number(row.percent ?? 0) / 100), 1);
  return base * multiplier + applicable.reduce((sum, row) => sum + Number(row.flat ?? 0), 0);
}

function applyActiveCombatBonus(base, ledger, unitId, targetType, label) {
  const applicable = ledger.modifiersFor(unitId).filter((modifier) => modifier.target?.type === targetType && matchesScope(modifier.target?.key, label));
  const multiplier = applicable.filter((modifier) => modifier.kind === "percent" || modifier.kind === "globalPercent")
    .reduce((value, modifier) => value * (1 + Number(modifier.value ?? 0) / 100), 1);
  const flat = applicable.filter((modifier) => modifier.kind === "flat").reduce((sum, modifier) => sum + Number(modifier.value ?? 0), 0);
  return base * multiplier + flat;
}

function gradedCombatTerms(rows = [], damageType, attackType, grade) {
  const index = GRADE_INDEX[grade] ?? 0;
  const applicable = rows.filter((row) => matchesScope(row.damageType, damageType) && matchesScope(row.attackType, attackType));
  return {
    flat: applicable.reduce((sum, row) => sum + Number(row.values?.[index] ?? 0), 0),
    percents: applicable.map((row) => Number(row.percents?.[index] ?? 0)).filter((value) => value !== 0),
  };
}

/**
 * 默认闪避主副属性尚未确认（设计文档 §25.5）。
 * 这里显式使用“敏捷 × 2 + 感知”作为实验默认，并在诊断中标注。
 */
export const defaultEvadeAttributePolicy = Object.freeze({
  id: "default-evade-agility-perception",
  experimental: true,
  attributes: Object.freeze({ primary: "agility", secondary: "perception" }),
});

/**
 * 运行一场战斗。
 * @param {object} input
 * @param {object} input.initialState { battleId, units, floorNumber, dungeonName }
 * @param {object} input.battlePlans 角色 ID → BattlePlan
 * @param {object|Map} input.skills 技能定义
 * @param {object} [input.policies]
 * @param {string} input.randomSeed
 */
export function simulateBattle(input) {
  // 事件序号必须只取决于本场战斗，才能满足“同种子产生相同事件序列”。
  resetEventSequence();
  const seed = String(input.randomSeed ?? "seed-0");
  const skills = toSkillMap(input.skills);
  const policies = input.policies ?? {};
  const rollPolicy = policies.rollPolicy ?? createUniformRollPolicy({ integer: true });
  const roundingPolicy = policies.roundingPolicy ?? DEFAULT_ROUNDING_POLICY;
  // 带符号的缩放修正按绝对值应用取整策略后再恢复符号。
  // 否则 floor(+13.25)=13、floor(-13.25)=-14，会让同源的等量增减无法抵消。
  const roundModifierValue = (value) => Math.sign(value) * roundingPolicy.round(Math.abs(value));
  const decayPolicy = policies.decayPolicy ?? DEFAULT_DECAY_POLICY;
  const tieBreakPolicy = policies.tieBreakPolicy ?? DEFAULT_TIE_BREAK_POLICY;
  const failureCostPolicy = policies.failureCostPolicy ?? defaultFailureCostPolicy;
  const woundThresholdPolicy = policies.woundThresholdPolicy ?? defaultWoundThresholdPolicy;
  const healingPriorityPolicy = policies.healingPriorityPolicy ?? defaultHealingPriorityPolicy;
  const hitGradePercents = policies.hitGradePercents ?? zeroHitGradePercents;
  const armorPolicy = policies.armorPolicy ?? zeroReductionPolicy;
  const resistancePolicy = policies.resistancePolicy ?? zeroReductionPolicy;
  const evadePolicy = policies.evadeAttributePolicy ?? defaultEvadeAttributePolicy;
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const units = (input.initialState?.units ?? []).map(createUnit);
  // 同一地城的多场战斗可以共享效果账本，使“无限制”效果跨战斗继续推进。
  const ledger = input.effectLedger ?? new EffectLedger();
  const roundOffset = Number(input.roundOffset ?? 0);
  const stream = createRandomStream(seed);
  // 未显式给出当前资源时按上限初始化，否则单位会以 0 体力“开局即倒下”。
  for (const unit of units) {
    const derived = deriveUnit(unit, { roundingPolicy, effectLedger: ledger });
    if (unit.health === null || unit.health === undefined) unit.health = derived.healthMax;
    if (unit.mana === null || unit.mana === undefined) unit.mana = derived.manaMax;
    if (unit.health <= 0) {
      unit.alive = false;
      unit.defeatedAtRound = roundOffset;
    }
  }
  const events = [];
  const diagnostics = {
    rulesetVersion: input.rulesetVersion ?? RULESET_VERSION,
    contentVersion: input.contentVersion ?? "unknown",
    randomAlgorithmVersion: RANDOM_ALGORITHM_VERSION,
    seed,
    warnings: [],
    experimentalPolicies: [],
    roundPhaseTrace: [],
  };
  for (const [name, policy] of Object.entries({
    roll: rollPolicy,
    decay: decayPolicy,
    tieBreak: tieBreakPolicy,
    failureCost: failureCostPolicy,
    woundThreshold: woundThresholdPolicy,
    healingPriority: healingPriorityPolicy,
    evade: evadePolicy,
    armor: armorPolicy,
    resistance: resistancePolicy,
  })) {
    if (policy?.experimental) diagnostics.experimentalPolicies.push(`${name}:${policy.id}`);
  }

  let phase = "RoundStarted";
  let round = 0;

  const emit = (type, payload = {}) => {
    const ev = event(type, { round, phase, ...payload });
    events.push(ev);
    return ev;
  };
  const enterPhase = (next) => {
    phase = next;
    diagnostics.roundPhaseTrace.push({ round, phase });
  };
  const byId = (id) => units.find((unit) => unit.id === id);
  const derivedOf = (unit) => deriveUnit(unit, { roundingPolicy, effectLedger: ledger });
  const livingUnits = (side) => units.filter((unit) => unit.present && unit.alive && (side === undefined || unit.side === side));
  const sideAlive = (side) => livingUnits(side).length > 0;

  const cursors = new Map();
  const preRoundCursors = new Map();
  const implicitPlans = new Map();
  const battlePlans = { ...(input.battlePlans ?? {}) };

  /**
   * 没有显式设置方案的单位使用确定性默认方案。
   * 原游戏的自动行动行为被教材认为不稳定，因此这里只做最小、可复现的兜底，
   * 并登记为实验策略 defaultPlan:first-available-skill。
   */
  function implicitPlanFor(unit) {
    if (implicitPlans.has(unit.id)) return implicitPlans.get(unit.id);
    if (!diagnostics.experimentalPolicies.includes("defaultPlan:first-available-skill")) {
      diagnostics.experimentalPolicies.push("defaultPlan:first-available-skill");
    }
    const known = Object.keys(unit.skills ?? {})
      .map((skillId) => skills.get(skillId))
      .filter(Boolean);
    const initiativeSkill = known.find((skill) => skill.timing?.initiative);
    const preRoundSkill = known.find((skill) => skill.timing?.preRound);
    const mainSkill = known.find((skill) => skill.timing?.mainAction && skill.baseType !== "heal")
      ?? known.find((skill) => skill.timing?.mainAction);
    const plan = createBattlePlan({
      id: `implicit-${unit.id}`,
      name: "默认方案",
      mode: "pve",
      defaultPlan: {
        position: unit.position,
        initiativeSkillId: initiativeSkill?.id ?? null,
        preRound: preRoundSkill ? [{ id: `${unit.id}-pre`, skillId: preRoundSkill.id, repeat: "normal" }] : [],
        mainRound: mainSkill ? [{ id: `${unit.id}-main`, skillId: mainSkill.id, repeat: "repeatWhilePossible" }] : [],
      },
    });
    implicitPlans.set(unit.id, plan);
    return plan;
  }

  // 玩家角色必须使用已保存的行动设置；怪物和召唤物仍可使用确定性 AI 方案。
  const planFor = (unit) => battlePlans[unit.id] ?? (unit.kind === "hero" ? null : implicitPlanFor(unit));
  const floorPlanFor = (unit) => {
    const plan = planFor(unit);
    if (!plan) return null;
    return resolveFloorPlan(plan, input.initialState?.floorNumber ?? 1).plan;
  };

  // ---------------------------------------------------------------- 主循环
  for (let localRound = 1; localRound <= maxRounds; localRound += 1) {
    round = roundOffset + localRound;
    if (!sideAlive(ATTACKER_SIDE) || !sideAlive("defender")) break;

    enterPhase("RoundStarted");
    emit("RoundStarted", {});

    enterPhase("StatusSnapshotPublished");
    publishStatusSnapshots();

    enterPhase("PreRoundCommandsExecuted");
    for (const unit of preRoundOrder()) executePreRound(unit);

    enterPhase("NaturalRegenerationApplied");
    applyNaturalRegeneration();

    enterPhase("SummonUpkeepPaid");
    paySummonUpkeep();

    enterPhase("InitiativeSkillsExecuted");
    for (const unit of livingUnits()) executeInitiativeSkill(unit);

    enterPhase("InitiativeScheduleGenerated");
    const { schedule, initiativeValues } = generateSchedule();

    enterPhase("MainActionsExecuted");
    executeMainActions(schedule, initiativeValues);

    enterPhase("ExpiredEffectsRemoved");
    const expired = ledger.expireAtRoundEnd(round, {
      battleEnded: false,
      dungeonEnded: false,
    });
    for (const instance of expired) {
      emit("EffectExpired", {
        targetId: instance.targetId,
        targetName: byId(instance.targetId)?.name ?? instance.targetId,
        effectName: instance.effectName ?? instance.effectDefinitionId,
        reason: "durationEnded",
      });
    }
    const activated = ledger.activateAtRound(round + 1);
    for (const instance of activated) {
      emit("EffectActivationChanged", {
        targetId: instance.targetId,
        targetName: byId(instance.targetId)?.name ?? instance.targetId,
        effectName: instance.effectName ?? instance.effectDefinitionId,
        state: "active",
      });
    }

    // 回合结束本身没有独立事件类型（设计文档 §18 的事件清单不含 RoundEnded），
    // 阶段推进记录在 diagnostics.roundPhaseTrace 中。
    enterPhase("RoundEnded");
    diagnostics.roundEndSummary = { round, expiredCount: expired.length, activatedCount: activated.length };
  }

  const result = sideAlive("defender") && !sideAlive(ATTACKER_SIDE) ? "defeat" : sideAlive(ATTACKER_SIDE) && !sideAlive("defender") ? "victory" : "draw";
  emit("BattleEnded", { result, resultLabel: result === "victory" ? "胜利" : result === "defeat" ? "失败" : "未决" });
  const battleEndExpired = ledger.onBattleEnd();
  for (const instance of battleEndExpired) {
    emit("EffectExpired", {
      targetId: instance.targetId,
      targetName: byId(instance.targetId)?.name ?? instance.targetId,
      effectName: instance.effectName ?? instance.effectDefinitionId,
      reason: "battleEnded",
    });
  }

  const snapshotHash = hashInputSnapshot({
    units: input.initialState?.units ?? [],
    battlePlans: input.battlePlans ?? {},
    skillIds: [...skills.keys()].sort(),
  });

  return {
    finalState: {
      battleId: input.initialState?.battleId ?? null,
      round,
      result,
      units: units.map((unit) => ({ ...unit })),
      effects: ledger.snapshot(),
    },
    events,
    replay: createReplayEnvelope({
      battleId: input.initialState?.battleId ?? null,
      rulesetVersion: diagnostics.rulesetVersion,
      contentVersion: diagnostics.contentVersion,
      randomAlgorithmVersion: RANDOM_ALGORITHM_VERSION,
      seed,
      inputSnapshotHash: snapshotHash,
      events,
    }),
    diagnostics,
  };

  // ---------------------------------------------------------------- 阶段实现

  function publishStatusSnapshots() {
    for (const unit of units) {
      if (!unit.present) continue;
      const derived = derivedOf(unit);
      const wounds = assessWounds({ current: unit.health, max: derived.healthMax }, woundThresholdPolicy);
      const liveEffects = ledger.liveFor(unit.id);
      emit("StatusSnapshot", {
        side: unit.side,
        kind: unit.kind,
        sideLabel: unitSideLabel(unit.side),
        unitId: unit.id,
        name: unit.name,
        level: unit.level,
        position: unit.position,
        positionLabel: POSITION_LABELS[unit.position] ?? unit.position,
        health: unit.health,
        healthMax: derived.healthMax,
        resource: unit.mana,
        resourceLabel: "法力",
        wounds: WOUND_LABELS[wounds.state] ?? wounds.state,
        woundsState: wounds.state,
        effects: liveEffects.map((instance) => instance.effectDefinitionId),
        buffSnapshots: liveEffects.map((instance) => ({
          name: instance.effectName,
          sourceSkillId: instance.sourceSkillId,
          sourceSkillName: instance.sourceSkillName,
          state: instance.state,
          duration: instance.duration,
          values: instance.modifiers.map((modifier) => ({
            target: modifier.target ?? null,
            kind: modifier.snapshotKind ?? modifier.kind,
            value: modifier.value ?? modifier.mean ?? null,
            source: modifier.source ?? null,
          })),
        })),
      });
    }
  }

  function preRoundOrder() {
    const configured = input.initialState?.preRoundOrder ?? [];
    const ordered = [];
    for (const id of configured) {
      const unit = byId(id);
      if (unit) ordered.push(unit);
    }
    for (const unit of livingUnits()) {
      if (!ordered.includes(unit)) ordered.push(unit);
    }
    return ordered;
  }

  /** 每个单位最多执行一次回合前技能；指令游标同样按 §17.3 的重复模式推进。 */
  function executePreRound(unit) {
    const floorPlan = floorPlanFor(unit);
    if (!floorPlan || floorPlan.preRound.length === 0) return;
    let cursor = preRoundCursors.get(unit.id);
    if (!cursor) {
      const usable = floorPlan.preRound.filter((command) => command.skillId === WAIT_COMMAND_SKILL_ID || skills.get(command.skillId)?.timing?.preRound);
      cursor = new CommandCursor(usable, { failureCostPolicy });
      preRoundCursors.set(unit.id, cursor);
    }
    const command = cursor.current();
    if (!command) return;
    if (command.skillId === WAIT_COMMAND_SKILL_ID) {
      cursor.record({ ok: true });
      emit("ActionWaited", { actorId: unit.id, actorName: unit.name, skillId: WAIT_COMMAND_SKILL_ID, skillName: "干等", phase: "PreRoundCommandsExecuted" });
      return;
    }
    const skill = skills.get(command.skillId);
    if (!skill) {
      cursor.record({ ok: false, reason: "skillNotLearned" });
      emit("SkillFailed", { actorId: unit.id, actorName: unit.name, skillId: command.skillId, skillName: command.skillId, reason: "skillNotLearned", reasonLabel: "未学会该技能" });
      return;
    }
    if (!skill.timing.preRound) {
      cursor.record({ ok: false, reason: "cannotUseTiming" });
      emit("SkillFailed", { actorId: unit.id, actorName: unit.name, skillId: skill.id, skillName: skill.name, reason: "cannotUseTiming", reasonLabel: "该阶段不能使用" });
      return;
    }
    const outcome = performSkill(unit, skill, command, { phase: "PreRoundCommandsExecuted" });
    const record = cursor.record({ ok: outcome.ok, reason: outcome.reason });
    if (!outcome.ok) emit("SkillFailed", {
      actorId: unit.id,
      actorName: unit.name,
      skillId: skill.id,
      skillName: skill.name,
      reason: outcome.reason,
      reasonLabel: FAILURE_REASON_LABELS[outcome.reason] ?? outcome.reason,
      consumedAction: record.consumedAction,
    });
  }

  function applyNaturalRegeneration() {
    for (const unit of livingUnits()) {
      const derived = derivedOf(unit);
      const result = regenerate(unit, derived);
      const healthDelta = result.health.current - unit.health;
      const manaDelta = result.mana.current - unit.mana;
      unit.health = result.health.current;
      unit.mana = result.mana.current;
      if (healthDelta !== 0) {
        emit("ResourceChanged", { actorId: unit.id, actorName: unit.name, resource: "health", resourceLabel: "体力", delta: healthDelta, current: unit.health, max: derived.healthMax });
      }
      if (manaDelta !== 0) {
        emit("ResourceChanged", { actorId: unit.id, actorName: unit.name, resource: "mana", resourceLabel: "法力", delta: manaDelta, current: unit.mana, max: derived.manaMax });
      }
    }
  }

  function paySummonUpkeep() {
    for (const summon of units.filter((unit) => unit.kind === "summon" && unit.alive && unit.present)) {
      if (!summon.summonUpkeep) continue;
      const owner = byId(summon.summonerId);
      if (!owner || !owner.alive) {
        dismissSummon(summon, "summonerGone");
        continue;
      }
      const { resource = "mana", amount = 0 } = summon.summonUpkeep;
      const available = resource === "health" ? owner.health : owner.mana;
      if (available < amount) {
        dismissSummon(summon, "upkeepUnpaid");
        continue;
      }
      if (resource === "health") owner.health -= amount;
      else owner.mana -= amount;
      emit("ResourceSpent", { actorId: owner.id, actorName: owner.name, resource, resourceLabel: resource === "health" ? "体力" : "法力", amount, reason: "summonUpkeep" });
    }
  }

  function dismissSummon(summon, reason) {
    summon.alive = false;
    summon.present = false;
    emit("SummonDismissed", { summonId: summon.id, summonName: summon.name, reason, reasonLabel: reason === "upkeepUnpaid" ? "维持失败" : "召唤者不在场" });
  }

  function executeInitiativeSkill(unit) {
    const floorPlan = floorPlanFor(unit);
    if (!floorPlan?.initiativeSkillId) return;
    const skill = skills.get(floorPlan.initiativeSkillId);
    if (!skill) return;
    if (!skill.timing.initiative) {
      emit("SkillFailed", { actorId: unit.id, actorName: unit.name, skillId: skill.id, skillName: skill.name, reason: "cannotUseTiming", reasonLabel: "该阶段不能使用" });
      return;
    }
    performSkill(unit, skill, {
      skillId: skill.id,
      itemIds: floorPlan.initiativeItemIds ?? (floorPlan.initiativeItemId == null ? [] : [floorPlan.initiativeItemId]),
      itemEffects: floorPlan.initiativeItemEffects ?? [],
      setEffects: floorPlan.initiativeSetEffects ?? [],
      calledItems: floorPlan.initiativeCalledItems ?? [],
      target: { mode: "auto" },
    }, { phase: "InitiativeSkillsExecuted" });
  }

  function generateSchedule() {
    const derivedByUnit = new Map();
    const initiativeValues = new Map();
    const actionCounts = new Map();
    const acting = [];
    for (const unit of livingUnits()) {
      const derived = derivedOf(unit);
      derivedByUnit.set(unit.id, derived);
      // 主回合召唤的单位从下一回合开始行动；回合前召唤的单位可参加当前回合主行动。
      const eligible = unit.kind !== "summon"
        || unit.summonCreatedRound === null
        || unit.summonCreatedRound < round
        || (unit.summonCreatedRound === round && unit.summonCreatedPhase === "PreRoundCommandsExecuted");
      if (!eligible) continue;
      acting.push(unit);
      initiativeValues.set(unit.id, derived.initiativeExact);
      actionCounts.set(unit.id, derived.actions);
      emit("InitiativeRolled", {
        actorId: unit.id,
        actorName: unit.name,
        initiative: derived.initiative,
        initiativeExact: derived.initiativeExact,
        skillName: floorPlanFor(unit)?.initiativeSkillId ? skills.get(floorPlanFor(unit).initiativeSkillId)?.name : undefined,
        trace: derived.traces.initiative,
      });
    }
    const { schedule } = buildInitiativeSchedule({
      units: acting,
      initiativeValues,
      actionCounts,
      decayPolicy,
      tieBreakPolicy,
    });
    for (const entry of schedule) {
      emit("ActionScheduled", {
        actorId: entry.actorId,
        actorName: entry.actorName,
        initiative: entry.initiative,
        initiativeExact: entry.initiativeExact,
        ordinal: entry.ordinal,
        totalActions: entry.totalActions,
        decayFactor: entry.decayFactor,
      });
    }
    return { schedule, initiativeValues };
  }

  function executeMainActions(schedule) {
    for (const entry of schedule) {
      if (!sideAlive(ATTACKER_SIDE) || !sideAlive("defender")) break;
      const actor = byId(entry.actorId);
      if (!actor || !actor.alive || !actor.present) continue;

      // 行动开始 → 检查治疗触发器
      const healResult = tryHealingInterrupt(actor);
      if (healResult) continue;

      const floorPlan = floorPlanFor(actor);
      if (!floorPlan || floorPlan.mainRound.length === 0) {
        emit("SkillFailed", { actorId: actor.id, actorName: actor.name, skillId: null, skillName: "-", reason: "noCommands", reasonLabel: "没有配置指令" });
        continue;
      }

      let cursor = cursors.get(actor.id);
      if (!cursor) {
        const interpreted = interpretMainCommands(floorPlan.mainRound, skills);
        cursor = new CommandCursor(interpreted.executable, { failureCostPolicy });
        cursors.set(actor.id, cursor);
        for (const rejected of interpreted.rejected) {
          diagnostics.warnings.push(`指令被拒绝 ${actor.id}:${rejected.command.skillId} ${rejected.reason}`);
        }
      }

      // 无单位的释放位置不消耗本次行动：按设置顺序继续寻找，最多检查一整圈。
      for (let checked = 0; checked < cursor.commands.length; checked += 1) {
        const command = cursor.current();
        const check = cursor.isExecutable(command);
        if (!check.executable) {
          cursor.record({ ok: false, reason: check.reason });
          continue;
        }
        if (command.skillId === WAIT_COMMAND_SKILL_ID) {
          cursor.record({ ok: true });
          emit("ActionWaited", { actorId: actor.id, actorName: actor.name, skillId: WAIT_COMMAND_SKILL_ID, skillName: "干等", phase: "MainActionsExecuted" });
          break;
        }
        const skill = skills.get(command.skillId);
        if (!skill) {
          const record = cursor.record({ ok: false, reason: "skillNotLearned" });
          emit("SkillFailed", { actorId: actor.id, actorName: actor.name, skillId: command.skillId, skillName: command.skillId, reason: "skillNotLearned", reasonLabel: "未学会该技能", consumedAction: record.consumedAction });
          break;
        }
        const outcome = performSkill(actor, skill, command, { phase: "MainActionsExecuted" });
        const record = cursor.record({ ok: outcome.ok, reason: outcome.reason });
        if (!outcome.ok) emit("SkillFailed", {
          actorId: actor.id,
          actorName: actor.name,
          skillId: skill.id,
          skillName: skill.name,
          reason: outcome.reason,
          reasonLabel: FAILURE_REASON_LABELS[outcome.reason] ?? outcome.reason,
          consumedAction: record.consumedAction,
        });
        if (outcome.ok || record.consumedAction) break;
        if (outcome.reason !== "noTargets") break;
      }
    }
  }

  function tryHealingInterrupt(actor) {
    const floorPlan = floorPlanFor(actor);
    if (!floorPlan) return false;
    const healingCommands = floorPlan.mainRound.filter((command) => skills.get(command.skillId)?.baseType === "heal");
    if (healingCommands.length === 0) return false;
    const triggers = collectHealingTriggers({
      units,
      actorId: actor.id,
      woundThresholdPolicy,
      priorityPolicy: healingPriorityPolicy,
    });
    const chosen = selectHealingInterrupt({ healingCommands, triggers });
    if (!chosen) return false;
    const skill = skills.get(chosen.command.skillId);
    emit("TargetSelected", { actorId: actor.id, actorName: actor.name, targetId: chosen.targetId, targetName: chosen.trigger.unitName, reason: "healingInterrupt", note: chosen.reason });
    performSkill(actor, skill, { ...chosen.command, target: { mode: "single", position: null, forcedTargetId: chosen.targetId } }, { phase: "MainActionsExecuted" });
    return true;
  }

  /**
   * 执行一次技能。返回 { ok, reason }。
   */
  function performSkill(actor, skill, command, context) {
    const skillLevel = effectiveSkillLevelOf(actor, skill.id, { effectLedger: ledger, skill });
    const selection = resolveTargets(actor, skill, command);
    const components = [...(skill.effects ?? []), ...(command.itemEffects ?? []), ...(command.setEffects ?? [])];
    const snapshotModifierValue = (modifier) => {
      try {
        const value = resolveModifier(modifier, { heroLevel: actor.level, skillLevel });
        return ["scaledFlat", "scaledPercent", "randomFlat"].includes(modifier.kind) ? roundModifierValue(value) : value;
      }
      catch { return modifier.mean ?? modifier.value ?? null; }
    };
    const snapshotEffect = (effect, sourceKind) => ({
      id: effect.id ?? null,
      name: effect.name ?? effect.category ?? effect.raw?.category ?? "效果",
      sourceKind,
      sourceId: effect.sourceId ?? null,
      duration: effect.duration ?? { kind: "untilBattleEnd" },
      activation: effect.activation ?? { kind: "immediate" },
      values: (effect.modifiers ?? []).map((modifier) => ({
        target: modifier.target ?? null,
        kind: modifier.kind,
        value: snapshotModifierValue(modifier),
        source: modifier.source ?? null,
      })),
      rawText: effect.raw?.rawText ?? effect.rawText ?? null,
    });
    const derived = derivedOf(actor);
    emit("SkillAttempted", {
      actorId: actor.id,
      actorName: actor.name,
      skillId: skill.id,
      skillName: skill.name,
      itemIds: command.itemIds ?? (command.itemId == null ? [] : [command.itemId]),
      calledItems: command.calledItems ?? [],
      baseType: skill.baseType,
      actionSnapshot: {
        heroLevel: actor.level,
        skillLevel,
        attributes: { ...derived.attributes },
        health: actor.health,
        healthMax: derived.healthMax,
        mana: actor.mana,
        manaMax: derived.manaMax,
        initiative: derived.initiative,
        actions: derived.actions,
        actorBuffs: ledger.activeFor(actor.id).map((instance) => ({
          name: instance.effectName,
          sourceSkillId: instance.sourceSkillId,
          duration: instance.duration,
          values: instance.modifiers.map((modifier) => ({
            target: modifier.target ?? null,
            kind: modifier.kind,
            value: snapshotModifierValue(modifier),
            source: modifier.source ?? null,
          })),
        })),
        skillEffects: (skill.effects ?? []).map((effect) => snapshotEffect(effect, "skill")),
        itemEffects: (command.itemEffects ?? []).map((effect) => snapshotEffect(effect, "item")),
        setEffects: (command.setEffects ?? []).map((effect) => snapshotEffect(effect, "itemSet")),
      },
    });

    // 失败尝试也必须先产生 SkillAttempted。展示战报以该事件划分行动；若在
    // 发出事件前返回，后续 SkillFailed 会被错误地归到上一条成功行动上。
    if (selection.targets.length === 0) return { ok: false, reason: "noTargets" };
    if (skill.baseType === "improve" && components.length > 0 && selection.targets.every((target) => ledger.hasLiveFromSource(skill.id, target.id, "buff", skill.name))) {
      return { ok: false, reason: "sameSourceActive" };
    }

    const cost = skillManaCost(actor, skill, { effectLedger: ledger, roundingPolicy });
    if (cost) {
      if (actor.mana < cost.applied) {
        return { ok: false, reason: "insufficientMana" };
      }
      actor.mana -= cost.applied;
      emit("ResourceSpent", { actorId: actor.id, actorName: actor.name, resource: "mana", resourceLabel: "法力", amount: cost.applied, reason: "skillCost", trace: cost });
    }

    const path = skill.baseType;
    if (path === "summon") {
      return performSummon(actor, skill, command, derived, context, selection);
    }
    if (path === "heal") {
      return performHeal(actor, skill, command, derived, selection);
    }
    if (path === "improve") {
      return performSupport(actor, skill, command, derived, selection);
    }
    if (["attack", "deteriorate", "defend", "initiative"].includes(path)) {
      return performAttack(actor, skill, command, derived, { dealDamage: path === "attack", selection });
    }
    return { ok: false, reason: "cannotUseTiming" };
  }

  function resolveTargets(actor, skill, command) {
    const forced = command?.target?.forcedTargetId;
    if (forced) {
      const unit = byId(forced);
      return { targets: unit ? [unit] : [], mode: "single", position: unit?.position ?? null, truncated: false, priority: [] };
    }
    const plan = planFor(actor);
    const floorPlan = floorPlanFor(actor);
    const configuredPriority = command?.target?.priority
      ?? (isMeleeAttackType(skill.attackType) ? null : plan?.general?.rangedPositionPriority
        ?? floorPlan?.rangedPositionPriority
        ?? null);
    return selectTargets({
      actor,
      units,
      spec: skill.target,
      attackType: skill.attackType,
      configuredPriority,
      randomStream: stream,
    });
  }

  function performAttack(actor, skill, command, derived, options) {
    const selection = options.selection ?? resolveTargets(actor, skill, command);
    let totalDamage = 0;
    const grades = [];
    for (const target of selection.targets) {
    emit("TargetSelected", { actorId: actor.id, actorName: actor.name, targetId: target.id, targetName: target.name, mode: selection.mode, position: selection.position });

    const means = skillMeans(actor, skill, { effectLedger: ledger, derived, roundingPolicy });
    const attackMean = means.attackMean ?? skillRollMean({ primary: derived.attributes.agility, secondary: derived.attributes.perception }, { roundingPolicy });
    let attackExact = applyCombatBonus(attackMean.exact, actor.combat?.attackBonuses, skill.attackType);
    attackExact = applyActiveCombatBonus(attackExact, ledger, actor.id, "attackBonus", skill.attackType);
    const positionPercent = isMeleeAttackType(skill.attackType) ? meleePositionHitPercent(actor.position, target.position) : 0;
    attackExact *= 1 + positionPercent / 100;
    const hit = rollPolicy.rollAroundMean(attackExact, { purpose: "hit", randomStream: stream, actorId: actor.id });

    const targetDerived = derivedOf(target);
    let evadeMean = applyCombatBonus(defaultEvadeMean(target, targetDerived), target.combat?.defenseBonuses, skill.attackType);
    evadeMean = applyActiveCombatBonus(evadeMean, ledger, target.id, "defenseBonus", skill.attackType);
    const evade = rollPolicy.rollAroundMean(evadeMean, { purpose: "evade", randomStream: stream, actorId: target.id });
    emit("AttackRolled", { actorId: actor.id, actorName: actor.name, targetId: target.id, targetName: target.name, hit, evade, attackMean: attackExact, evadeMean, positionPercent, trace: attackMean });

    const detail = hitGradeDetail(hit, evade);
    emit("AttackResolved", { actorId: actor.id, actorName: actor.name, targetId: target.id, targetName: target.name, grade: detail.grade, hit, evade, thresholds: detail.thresholds });

    if (detail.grade === "闪避") {
      applySkillEffects(actor, skill, target, command, { hit: false, dealDamage: options.dealDamage });
      grades.push(detail.grade);
      continue;
    }

    let damageResult = null;
    if (options.dealDamage && means.damageMean) {
      const targetModifiers = ledger.modifiersFor(target.id);
      const attackerModifiers = ledger.modifiersFor(actor.id);
      const damageType = skill.damageType ?? skill.attackType;
      const persistentDamage = gradedCombatTerms(actor.combat?.damage, damageType, skill.attackType, detail.grade);
      const persistentArmor = gradedCombatTerms(target.combat?.armor, damageType, skill.attackType, detail.grade);
      const persistentVulnerability = gradedCombatTerms(target.combat?.vulnerability, damageType, skill.attackType, detail.grade);
      const flats = attackerModifiers
        .filter((modifier) => modifier.target?.type === "damage" && (!modifier.target.damageType || modifier.target.damageType === damageType))
        .map((modifier) => ({ value: Number(modifier.value ?? 0), source: modifier.source ?? "effect", timing: "postRoll", damageType }));
      if (persistentDamage.flat !== 0) flats.push({ value: persistentDamage.flat, source: "角色实例伤害奖励", timing: "postRoll", damageType });
      const percents = attackerModifiers
        .filter((modifier) => modifier.target?.type === "damagePercent" && (!modifier.target.damageType || modifier.target.damageType === damageType))
        .map((modifier) => ({ value: Number(modifier.value ?? 0), source: modifier.source ?? "effect" }));
      percents.push(...persistentDamage.percents.map((value) => ({ value, source: "角色实例伤害奖励" })));
      const globalPercents = attackerModifiers
        .filter((modifier) => modifier.target?.type === "globalPercent")
        .map((modifier) => Number(modifier.value ?? 0));
      globalPercents.push(...persistentVulnerability.percents);

      damageResult = resolveDamage(
        {
          formula: {
            primary: means.damageMean ? derived.attributes[skill.attributeFormula.damage.primary] ?? 0 : 0,
            secondary: means.damageMean ? derived.attributes[skill.attributeFormula.damage.secondary] ?? 0 : 0,
            skillLevel: means.skillLevel,
          },
          rollPolicy,
          randomStream: stream,
          flats,
          percents,
          zAdditions: [],
          damageTypes: [damageType],
          hitGrade: detail.grade,
          hitGradePercents,
          defense: {
            armor: { percent: sumReduction(targetModifiers, "armor", damageType) + persistentArmor.percents.reduce((sum, value) => sum + value, 0), flat: persistentArmor.flat },
            resistance: { percent: sumReduction(targetModifiers, "resistance", damageType) },
          },
          armorPolicy,
          resistancePolicy,
          globalPercents,
          context: { actorId: actor.id, targetId: target.id },
        },
        { roundingPolicy },
      );

      if (damageResult.applied > 0) {
        target.health = Math.max(0, target.health - damageResult.applied);
        emit("DamageApplied", {
          actorId: actor.id,
          actorName: actor.name,
          targetId: target.id,
          targetName: target.name,
          amount: damageResult.applied,
          damageType,
          healthAfter: target.health,
          hitGrade: detail.grade,
          trace: damageResult.trace,
          diagnostics: damageResult.diagnostics,
        });
        if (target.health <= 0 && target.alive) {
          target.alive = false;
          target.defeatedAtRound = round;
          emit("UnitDefeated", { unitId: target.id, unitName: target.name, side: target.side });
        }
      } else {
        emit("DamageApplied", { actorId: actor.id, actorName: actor.name, targetId: target.id, targetName: target.name, amount: 0, damageType, healthAfter: target.health, hitGrade: detail.grade, trace: damageResult.trace });
      }
    }

    // 只要没有闪避，本次附带的 Debuff 完整生效，不因命中等级缩放。
    applySkillEffects(actor, skill, target, command, { hit: debuffApplies(detail.grade), dealDamage: options.dealDamage });
    grades.push(detail.grade);
    totalDamage += damageResult?.applied ?? 0;
    }
    return { ok: true, reason: null, grades, damage: totalDamage };
  }

  function performHeal(actor, skill, command, derived, selection = resolveTargets(actor, skill, command)) {
    const means = skillMeans(actor, skill, { effectLedger: ledger, derived, roundingPolicy });
    const base = means.damageMean ? means.damageMean.exact : means.attackMean?.exact ?? 0;
    for (const target of selection.targets) {
      emit("TargetSelected", { actorId: actor.id, actorName: actor.name, targetId: target.id, targetName: target.name, mode: selection.mode, position: target.position });
      const targetDerived = derivedOf(target);
      const amount = Math.max(0, Math.floor(rollPolicy.rollAroundMean(base, { purpose: "heal", randomStream: stream })));
      target.health = Math.min(targetDerived.healthMax, target.health + amount);
      emit("HealingApplied", { actorId: actor.id, actorName: actor.name, targetId: target.id, targetName: target.name, amount, healthAfter: target.health, trace: { base, applied: amount } });
      applySkillEffects(actor, skill, target, command, { hit: true, dealDamage: false });
    }
    return { ok: true, reason: null };
  }

  function performSupport(actor, skill, command, derived, selection = resolveTargets(actor, skill, command)) {
    let applied = 0;
    for (const target of selection.targets) {
      emit("TargetSelected", { actorId: actor.id, actorName: actor.name, targetId: target.id, targetName: target.name, mode: selection.mode, position: target.position });
      const results = applySkillEffects(actor, skill, target, command, { hit: true, dealDamage: false });
      applied += results.filter((result) => result.applied).length;
    }
    if (applied === 0 && skill.effects.length > 0) return { ok: false, reason: "sameSourceActive" };
    return { ok: true, reason: null };
  }

  function performSummon(actor, skill, command, derived, context, selection = resolveTargets(actor, skill, command)) {
    const template = command?.summonTemplate ?? skill.summonTemplate;
    if (!template) return { ok: false, reason: "missingSummonDefinition" };
    const configuredPositions = command?.target?.priority ?? [];
    const position = configuredPositions[0] ?? template.position ?? selection.position ?? actor.position;
    const summon = createUnit({
      id: `${actor.id}:${skill.id}:${round}`,
      name: template.name ?? `${skill.name}的召唤物`,
      side: actor.side,
      kind: "summon",
      level: template.level ?? actor.level,
      position,
      attributes: template.attributes ?? {},
      skills: template.skills ?? {},
      baseStatDefaults: template.baseStatDefaults ?? { actionsPerRound: template.actionsPerRoundExact ?? 1 },
      healthRegeneration: template.healthRegeneration ?? 0,
      manaRegeneration: template.manaRegeneration ?? 0,
      actionsPerRoundExact: template.actionsPerRoundExact ?? 1,
      initiativeBonus: template.initiativeBonus ?? 0,
      summonUpkeep: template.summonUpkeep ?? null,
      summonerId: actor.id,
      summonCreatedRound: round,
      summonCreatedPhase: context.phase,
    });
    const summonDerived = derivedOf(summon);
    summon.health = template.health ?? summonDerived.healthMax;
    summon.mana = template.mana ?? summonDerived.manaMax;
    units.push(summon);
    for (const definition of template.skillDefinitions ?? []) skills.set(definition.id, definition);
    if (template.battlePlan) battlePlans[summon.id] = template.battlePlan;
    emit("SummonCreated", { actorId: actor.id, actorName: actor.name, summonId: summon.id, summonName: summon.name, position, joinsThisRound: context.phase === "PreRoundCommandsExecuted" });
    return { ok: true, reason: null };
  }

  /**
   * 应用技能效果。同源不叠加的判定主键为
   * sourceSkillId + targetId + effectApplicationGroup。
   */
  function applySkillEffects(actor, skill, target, command, { hit }) {
    if (!hit) return [];
    const behavior = sameSourceBehavior(skill.baseType);
    const itemIds = command?.itemIds ?? (command?.itemId == null ? [] : [command.itemId]);
    const components = [
      ...(skill.effects ?? []).map((effect) => ({ ...effect, sourceKind: "skill", sourceId: skill.id })),
      ...(command?.itemEffects ?? []).map((effect) => ({ ...effect, sourceKind: "item" })),
      ...(command?.setEffects ?? []).map((effect) => ({ ...effect, sourceKind: "itemSet" })),
    ];
    if (components.length === 0) return [];
    const castSkillLevel = effectiveSkillLevelOf(actor, skill.id, { effectLedger: ledger, skill });
    const appliedComponents = components.map((effect) => {
      const activation = effect.activation ?? { kind: "immediate" };
      return {
        ...effect,
        activation,
        modifiers: (effect.modifiers ?? []).map((modifier) => {
          const activationFields = { activation, activationRound: activationRoundOf(activation, round) };
          if (!["scaledFlat", "scaledPercent", "randomFlat"].includes(modifier.kind)) return { ...modifier, ...activationFields };
          let value = modifier.value ?? modifier.mean ?? 0;
          try { value = roundModifierValue(resolveModifier(modifier, { heroLevel: actor.level, skillLevel: castSkillLevel })); } catch {}
          return { ...modifier, kind: "flat", value, snapshotKind: modifier.kind, ...activationFields };
        }),
      };
    });
    const durationRank = (duration = {}) => ({ untilCurrentRoundEnd: 0, rounds: 1, untilBattleEnd: 2, untilDungeonEnd: 3 }[duration.kind] ?? 2);
    const longestDuration = appliedComponents.reduce((longest, effect) => {
      const candidate = effect.duration ?? { kind: "untilBattleEnd" };
      if (durationRank(candidate) !== durationRank(longest)) return durationRank(candidate) > durationRank(longest) ? candidate : longest;
      return candidate.kind === "rounds" && Number(candidate.value ?? 0) > Number(longest.value ?? 0) ? candidate : longest;
    }, { kind: "untilCurrentRoundEnd" });

    const outcome = ledger.apply({
      effectDefinitionId: skill.name,
      effectName: skill.name,
      buffKey: skill.name,
      sourceActorId: actor.id,
      sourceSkillId: skill.id,
      sourceSkillName: skill.name,
      sourceItemIds: itemIds,
      targetId: target.id,
      appliedRound: round,
      appliedPhase: phase,
      activation: { kind: "immediate" },
      duration: longestDuration,
      applicationGroup: "buff",
      modifiers: appliedComponents.flatMap((effect) => effect.modifiers ?? []),
      components: appliedComponents,
      tags: [...new Set(appliedComponents.flatMap((effect) => effect.tags ?? []))],
    });
    if (!outcome.applied) {
      diagnostics.warnings.push(`同名 Buff 未叠加 ${skill.name} → ${target.id}`);
      return [{ applied: false, reason: outcome.reason }];
    }
    const instance = outcome.instance;
    emit("EffectApplied", { actorId: actor.id, actorName: actor.name, targetId: target.id, targetName: target.name, effectId: skill.name, effectName: skill.name, state: instance.state, sourceSkillId: skill.id });
    if (instance.state === "active" && instance.activationRound === round) emit("EffectActivationChanged", { targetId: target.id, targetName: target.name, effectName: skill.name, state: "active" });

    if (!behavior.reapplies && skill.baseType === "deteriorate") {
      diagnostics.warnings.push(`恶化技能 ${skill.id} 命中了已有同源效果的 ${target.id}`);
    }
    return [{ applied: true, instance }];
  }

  function defaultEvadeMean(unit, derived) {
    const binding = evadePolicy.attributes;
    return skillRollMean(
      {
        primary: derived.attributes[binding.primary] ?? 0,
        secondary: derived.attributes[binding.secondary] ?? 0,
        skillLevel: 0,
      },
      { roundingPolicy },
    ).exact;
  }

  function sumReduction(modifiers, kind, damageType) {
    return modifiers
      .filter((modifier) => modifier.target?.type === kind && (!modifier.target.damageType || modifier.target.damageType === damageType))
      .reduce((sum, modifier) => sum + Number(modifier.value ?? 0), 0);
  }
}

export { BATTLE_PHASES };
