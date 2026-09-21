import { isActionLevelFailure } from "../commands/cursor.mjs";

function compactValues(values = []) {
  return values.map(({ target = null, kind = null, value = null }) => ({ target, kind, value }));
}

function compactEffects(effects = []) {
  return effects.map(({ name = "效果", sourceId = null, duration = null, activation = null, values = [] }) => ({
    name,
    sourceId,
    duration,
    activation,
    values: compactValues(values),
  }));
}

function compactBuffs(buffs = []) {
  return buffs.map(({ name = "效果", duration = null, values = [] }) => ({
    name,
    duration,
    values: compactValues(values),
  }));
}

function compactStatus(event) {
  return {
    unitId: event.unitId,
    name: event.name,
    kind: event.kind,
    level: event.level,
    position: event.position,
    positionLabel: event.positionLabel,
    health: event.health,
    healthMax: event.healthMax,
    resource: event.resource,
    resourceLabel: event.resourceLabel,
    wounds: event.wounds,
    buffs: compactBuffs(event.buffSnapshots),
  };
}

function recoveryRows(events) {
  const rows = new Map();
  for (const event of events.filter((entry) => entry.type === "ResourceChanged")) {
    const key = String(event.actorId ?? event.actorName);
    if (!rows.has(key)) rows.set(key, { actorId: event.actorId, actorName: event.actorName, changes: [] });
    rows.get(key).changes.push({ resource: event.resource, resourceLabel: event.resourceLabel, delta: event.delta, current: event.current, max: event.max });
  }
  return [...rows.values()];
}

function schedulesFor(events) {
  const queues = new Map();
  for (const event of events.filter((entry) => entry.type === "ActionScheduled")) {
    const key = String(event.actorId);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push({ initiative: event.initiative, ordinal: event.ordinal, totalActions: event.totalActions });
  }
  return queues;
}

/**
 * 一次展示行动的开始事件。
 * 技能调用与干等各自开始一次行动；「无法执行任何行动」「没有配置指令」
 * 这类行动级失败没有技能调用，自己就是那一行。
 */
function startsAction(event, phase) {
  return event.type === "SkillAttempted"
    || event.type === "ActionWaited"
    || (phase === "InitiativeSkillsExecuted" && event.type === "SkillFailed")
    || (event.type === "SkillFailed" && isActionLevelFailure(event.reason));
}

/** 事件所属行动槽的标识；没有该标记时（旧快照）每次调用各算一次行动。 */
function actionKey(event) {
  if (!event.actionSchedule) return null;
  return `${event.actorId}:${event.actionSchedule.ordinal}`;
}

function actionRows(events, phase, scheduleQueues, initiativeByActor) {
  const phaseEvents = events.filter((event) => event.phase === phase);
  const groups = [];
  let current = null;
  for (const event of phaseEvents) {
    if (startsAction(event, phase)) {
      // 同一次行动里的重复尝试（先「没有合法目标」再顺位到下一条指令）合并成一行：
      // 只展示真正执行过的那次调用，被它取代的尝试只留在事件流里。
      const key = actionKey(event);
      if (current && key && current.actionKey === key) {
        current.attempt = event;
        current.events = [];
        continue;
      }
      current = { attempt: event, events: [], actionKey: key };
      groups.push(current);
    } else if (current) current.events.push(event);
  }
  return groups.map(({ attempt, events: actionEvents }, actionIndex) => {
    const targets = [];
    const targetMap = new Map();
    for (const event of actionEvents) {
      if (event.type === "TargetSelected") {
        const target = { targetId: event.targetId, targetName: event.targetName, position: event.position, hit: null, evade: null, grade: null, damage: [], healing: [] };
        targets.push(target);
        targetMap.set(String(event.targetId), target);
      } else if (event.targetId != null) {
        const target = targetMap.get(String(event.targetId));
        if (!target) continue;
        if (event.type === "AttackRolled") { target.hit = event.hit; target.evade = event.evade; }
        if (event.type === "AttackResolved") target.grade = event.grade;
        if (event.type === "DamageApplied") target.damage.push({ amount: event.amount, damageType: event.damageType, healthAfter: event.healthAfter });
        if (event.type === "HealingApplied") target.healing.push({ amount: event.amount, healthAfter: event.healthAfter });
      }
    }
    const snapshot = attempt.actionSnapshot ?? {};
    const costs = actionEvents.filter((event) => event.type === "ResourceSpent" && event.reason === "skillCost")
      .map(({ resource, resourceLabel, amount }) => ({ resource, resourceLabel, amount }));
    // 行动级失败（无法执行任何行动 / 没有配置指令）没有技能调用，失败就是这一行本身。
    const failed = attempt.type === "SkillFailed"
      ? attempt
      : actionEvents.find((event) => event.type === "SkillFailed" && String(event.actorId) === String(attempt.actorId));
    const schedule = attempt.actionSchedule
      ? { initiative: attempt.actionSchedule.initiative, ordinal: attempt.actionSchedule.ordinal, totalActions: attempt.actionSchedule.totalActions }
      : phase === "MainActionsExecuted" ? scheduleQueues.get(String(attempt.actorId))?.shift() ?? null : null;
    return {
      actionIndex: actionIndex + 1,
      schedule,
      initiative: initiativeByActor.get(String(attempt.actorId))?.initiative ?? null,
      initiativeDetails: initiativeByActor.get(String(attempt.actorId)) ?? null,
      actor: {
        id: attempt.actorId,
        name: attempt.actorName,
        heroLevel: snapshot.heroLevel,
        buffs: compactBuffs(snapshot.actorBuffs),
        attributes: snapshot.attributes ?? {},
        health: snapshot.health,
        healthMax: snapshot.healthMax,
        mana: snapshot.mana,
        manaMax: snapshot.manaMax,
        initiative: snapshot.initiative,
        actions: snapshot.actions,
      },
      skill: { id: attempt.skillId ?? null, name: attempt.skillName ?? null, level: snapshot.skillLevel, effects: compactEffects(snapshot.skillEffects) },
      items: (attempt.calledItems ?? []).map((item) => ({
        id: String(item.id),
        name: item.name,
        setName: item.setName ?? null,
        itemEffects: compactEffects((snapshot.itemEffects ?? []).filter((effect) => String(effect.sourceId) === String(item.id))),
        setEffects: compactEffects((snapshot.setEffects ?? []).filter((effect) => String(effect.sourceId) === String(item.setName))),
      })),
      costs,
      targets,
      failure: failed ? {
        reason: failed.reason,
        reasonLabel: failed.reasonLabel ?? failed.reason,
        ...(failed.requiredMana == null ? {} : { requiredMana: failed.requiredMana }),
        ...(failed.currentMana == null ? {} : { currentMana: failed.currentMana }),
      } : null,
    };
  });
}

/** 将领域事件立即压缩为仅供战报页面重现的不可回放快照。 */
export function createDisplayBattleReport({ dungeonName, battleName, result, roundCount, levelNumber, events }) {
  const rounds = [...new Set(events.map((event) => event.round).filter((round) => Number(round) > 0))].sort((a, b) => a - b);
  return {
    dungeonName,
    battleName,
    result,
    roundCount,
    levelNumber,
    rounds: rounds.map((round) => {
      const roundEvents = events.filter((event) => event.round === round);
      const schedules = schedulesFor(roundEvents);
      const initiativeByActor = new Map(roundEvents.filter((event) => event.type === "InitiativeRolled").map((event) => [String(event.actorId), {
        initiative: event.initiative,
        base: event.initiativeBase ?? event.initiativeMean ?? null,
        roll: event.initiativeRoll ?? event.initiative,
        hardBonus: event.initiativeHardBonus ?? null,
      }]));
      const statuses = roundEvents.filter((event) => event.type === "StatusSnapshot");
      return {
        round,
        preRound: {
          teams: {
            attacker: statuses.filter((event) => event.side === "attacker").map(compactStatus),
            defender: statuses.filter((event) => event.side === "defender").map(compactStatus),
          },
          actions: actionRows(roundEvents, "PreRoundCommandsExecuted", schedules, initiativeByActor),
        },
        recovery: recoveryRows(roundEvents.filter((event) => event.phase === "NaturalRegenerationApplied")),
        initiative: actionRows(roundEvents, "InitiativeSkillsExecuted", schedules, initiativeByActor),
        mainRound: actionRows(roundEvents, "MainActionsExecuted", schedules, initiativeByActor),
      };
    }),
  };
}
