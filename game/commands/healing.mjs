// 治疗中断。设计文档 §17.4、§11.2、§25.11。
//
// 行动开始 → 检查治疗触发器 → 若命中更高优先级触发器，执行治疗
// → 否则执行普通指令游标。
//
// 体力低于最大体力 90% 时至少视为轻伤；轻伤、受伤和重伤的其余阈值尚未确认，
// 因此阈值表是显式的实验参数（WoundThresholdPolicy）。

export const WOUND_STATES = Object.freeze(["healthy", "light", "wounded", "severe", "down"]);

export const WOUND_LABELS = Object.freeze({
  healthy: "毫发无伤",
  light: "轻伤",
  wounded: "受伤",
  severe: "重伤",
  down: "倒下",
});

/**
 * 默认阈值：轻伤 < 90%（A 级）；其余为 D 级实验参数。
 */
export const defaultWoundThresholdPolicy = Object.freeze({
  id: "default-wound-thresholds",
  experimental: true,
  thresholds: Object.freeze({ light: 0.9, wounded: 0.6, severe: 0.3 }),
});

export function assessWounds({ current, max }, policy = defaultWoundThresholdPolicy) {
  if (current <= 0) return { state: "down", ratio: 0, policyId: policy.id };
  if (max <= 0) return { state: "healthy", ratio: 1, policyId: policy.id };
  const ratio = current / max;
  const { light, wounded, severe } = policy.thresholds;
  if (ratio < severe) return { state: "severe", ratio, policyId: policy.id };
  if (ratio < wounded) return { state: "wounded", ratio, policyId: policy.id };
  if (ratio < light) return { state: "light", ratio, policyId: policy.id };
  return { state: "healthy", ratio, policyId: policy.id };
}

/**
 * 治疗触发器优先级表，1 最高。默认实现为实验策略：英雄优先于召唤物。
 */
export const defaultHealingPriorityPolicy = Object.freeze({
  id: "default-healing-priority",
  experimental: true,
  table: Object.freeze({
    "hero:severe": 1,
    "hero:wounded": 2,
    "hero:light": 3,
    "summon:severe": 4,
    "summon:wounded": 5,
    "summon:light": null,
  }),
  priorityFor({ kind, woundState }) {
    return this.table[`${kind === "summon" ? "summon" : "hero"}:${woundState}`] ?? null;
  },
});

/**
 * 收集治疗触发器。
 * @param {object} input
 * @param {object[]} input.units 我方单位（含召唤物）
 * @param {string} input.actorId 当前行动者
 * @param {object} [input.woundThresholdPolicy]
 * @param {object} [input.priorityPolicy]
 */
export function collectHealingTriggers({
  units,
  actorId,
  woundThresholdPolicy = defaultWoundThresholdPolicy,
  priorityPolicy = defaultHealingPriorityPolicy,
}) {
  const actor = units.find((unit) => unit.id === actorId);
  const triggers = [];
  for (const unit of units) {
    if (!unit || unit.alive === false) continue;
    if (unit.side !== actor?.side) continue;
    const wound = assessWounds({ current: unit.health, max: unit.healthMax }, woundThresholdPolicy);
    const priority = priorityPolicy.priorityFor({ kind: unit.kind === "summon" ? "summon" : "hero", woundState: wound.state });
    if (priority === null) continue;
    triggers.push({
      unitId: unit.id,
      unitName: unit.name,
      kind: unit.kind ?? "hero",
      woundState: wound.state,
      woundLabel: WOUND_LABELS[wound.state],
      ratio: wound.ratio,
      priority,
      isSelf: unit.id === actorId,
    });
  }
  return triggers.sort((a, b) => a.priority - b.priority || a.unitId.localeCompare(b.unitId));
}

/**
 * 选择要中断执行的治疗触发器。
 * @param {object} input
 * @param {object[]} input.healingCommands 可用的治疗指令，按游标顺序
 * @param {object[]} input.triggers
 */
export function selectHealingInterrupt({ healingCommands = [], triggers = [] }) {
  if (healingCommands.length === 0 || triggers.length === 0) return null;
  const command = healingCommands[0];
  const trigger = triggers[0];
  return {
    command,
    trigger,
    priority: trigger.priority,
    targetId: trigger.unitId,
    reason: `优先级 ${trigger.priority}：${trigger.unitName}（${trigger.woundLabel}）`,
  };
}
