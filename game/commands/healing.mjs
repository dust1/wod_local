// 伤势分档供角色详情与行动点的治疗设置共用。
//
// 当前生命比例达到 90% / 75% / 50% 时分别进入轻伤 / 受伤 / 重伤。

export const WOUND_STATES = Object.freeze(["healthy", "light", "wounded", "severe", "down"]);

export const WOUND_LABELS = Object.freeze({
  healthy: "毫发无伤",
  light: "轻伤",
  wounded: "受伤",
  severe: "重伤",
  down: "倒下",
});

/**
 * 默认阈值包含边界值。
 */
export const defaultWoundThresholdPolicy = Object.freeze({
  id: "default-wound-thresholds",
  experimental: false,
  thresholds: Object.freeze({ light: 0.9, wounded: 0.75, severe: 0.5 }),
});

export function assessWounds({ current, max }, policy = defaultWoundThresholdPolicy) {
  if (current <= 0) return { state: "down", ratio: 0, policyId: policy.id };
  if (max <= 0) return { state: "healthy", ratio: 1, policyId: policy.id };
  const ratio = current / max;
  const { light, wounded, severe } = policy.thresholds;
  if (ratio <= severe) return { state: "severe", ratio, policyId: policy.id };
  if (ratio <= wounded) return { state: "wounded", ratio, policyId: policy.id };
  if (ratio <= light) return { state: "light", ratio, policyId: policy.id };
  return { state: "healthy", ratio, policyId: policy.id };
}
