// 战报领域事件。设计文档 §18。
// 战斗引擎不直接生成 HTML 文本，而是先输出领域事件。

export const BATTLE_EVENT_TYPES = Object.freeze([
  "RoundStarted",
  "StatusSnapshot",
  "SkillAttempted",
  "SkillFailed",
  "ResourceSpent",
  "ResourceChanged",
  "InitiativeSkillCalculated",
  "InitiativeRolled",
  "ActionScheduled",
  "ActionWaited",
  "TargetSelected",
  "AttackRolled",
  "AttackResolved",
  "DamageApplied",
  "HealingApplied",
  "EffectApplied",
  "EffectActivationChanged",
  "EffectExpired",
  "SummonCreated",
  "SummonDismissed",
  "ItemChargeSpent",
  "ItemDamaged",
  "UnitDefeated",
  "UnitEscaped",
  "BattleEnded",
  "LevelEnded",
  "DungeonEnded",
]);

export const BATTLE_EVENT_TYPE_SET = new Set(BATTLE_EVENT_TYPES);

let sequence = 0;

/** 重置事件序号，便于测试中比较事件序列。 */
export function resetEventSequence() {
  sequence = 0;
}

/**
 * 构造一个领域事件。每个数值事件都应附带 trace。
 * @param {string} type
 * @param {object} payload
 */
export function event(type, payload = {}) {
  if (!BATTLE_EVENT_TYPE_SET.has(type)) throw new Error(`未知战报事件类型: ${type}`);
  sequence += 1;
  const { phase, round, trace, ...rest } = payload;
  const built = { seq: sequence, type, ...rest };
  if (round !== undefined) built.round = round;
  if (phase !== undefined) built.phase = phase;
  if (trace !== undefined) built.trace = trace;
  return built;
}

export function isBattleEvent(value) {
  return Boolean(value) && typeof value === "object" && BATTLE_EVENT_TYPE_SET.has(value.type);
}
