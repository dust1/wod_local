// 每回合阶段状态机顺序。设计文档 §11.1。

export const BATTLE_PHASES = Object.freeze([
  "RoundStarted",
  "StatusSnapshotPublished",
  "PreRoundCommandsExecuted",
  "NaturalRegenerationApplied",
  "SummonUpkeepPaid",
  "InitiativeSkillsExecuted",
  "InitiativeScheduleGenerated",
  "MainActionsExecuted",
  "ExpiredEffectsRemoved",
  "RoundEnded",
]);

export const PHASE_LABELS = Object.freeze({
  RoundStarted: "回合开始",
  StatusSnapshotPublished: "状态快照",
  PreRoundCommandsExecuted: "回合前",
  NaturalRegenerationApplied: "自然回复",
  SummonUpkeepPaid: "召唤维持",
  InitiativeSkillsExecuted: "先攻技能",
  InitiativeScheduleGenerated: "先攻排序",
  MainActionsExecuted: "主回合",
  ExpiredEffectsRemoved: "效果结算",
  RoundEnded: "回合结束",
});

const PHASE_INDEX = new Map(BATTLE_PHASES.map((phase, index) => [phase, index]));

export function phaseIndex(phase) {
  const index = PHASE_INDEX.get(phase);
  if (index === undefined) throw new Error(`未知战斗阶段: ${phase}`);
  return index;
}

/** 阶段 a 是否严格早于阶段 b。 */
export function phaseBefore(a, b) {
  return phaseIndex(a) < phaseIndex(b);
}
