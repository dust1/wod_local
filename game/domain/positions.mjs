// 六个站位、近战固定目标顺序和近战站位命中修正。
// 设计文档 §12。

export const POSITIONS = Object.freeze([
  "front",
  "leftWing",
  "rightWing",
  "center",
  "rear",
  "enemyRear",
]);

export const POSITION_LABELS = Object.freeze({
  front: "前排",
  leftWing: "左翼",
  rightWing: "右翼",
  center: "中间",
  rear: "后排",
  enemyRear: "队伍后方",
});

export const POSITION_BY_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(POSITION_LABELS).map(([id, label]) => [label, id])),
);

/** 近战固定攻击顺序：自身位置 → 目标位置优先级。文档 §12.2。 */
export const MELEE_TARGET_PRIORITY = Object.freeze({
  front: Object.freeze(["front", "center", "rear", "leftWing", "rightWing", "enemyRear"]),
  leftWing: Object.freeze(["rightWing", "front", "center", "rear", "leftWing", "enemyRear"]),
  rightWing: Object.freeze(["leftWing", "front", "center", "rear", "rightWing", "enemyRear"]),
  center: Object.freeze(["front", "center", "rear", "rightWing", "leftWing", "enemyRear"]),
  rear: Object.freeze(["enemyRear", "front", "center", "rightWing", "leftWing", "rear"]),
  enemyRear: Object.freeze(["rear", "center", "front", "rightWing", "leftWing", "enemyRear"]),
});

/** 近战站位命中修正，百分比。文档 §12.3。 */
export const MELEE_POSITION_HIT_MODIFIER = Object.freeze({
  front: Object.freeze({ front: 0, leftWing: -20, rightWing: -20, center: 20, rear: 20, enemyRear: -30 }),
  leftWing: Object.freeze({ front: 20, leftWing: -20, rightWing: 0, center: 0, rear: -20, enemyRear: -30 }),
  rightWing: Object.freeze({ front: 20, leftWing: 0, rightWing: -20, center: 0, rear: -20, enemyRear: -30 }),
  center: Object.freeze({ front: -20, leftWing: -20, rightWing: -20, center: -20, rear: -20, enemyRear: -30 }),
  rear: Object.freeze({ front: -20, leftWing: -20, rightWing: -20, center: -20, rear: -20, enemyRear: 0 }),
  enemyRear: Object.freeze({ front: 30, leftWing: 20, rightWing: 20, center: 30, rear: 0, enemyRear: 0 }),
});

/** 近战方式使用固定顺序；其余方式可通过设置指定。 */
export const MELEE_ATTACK_TYPES = Object.freeze(["近战", "melee"]);

export function isMeleeAttackType(attackType) {
  return MELEE_ATTACK_TYPES.includes(attackType);
}

/**
 * 近战命中修正属于“全局百分比加成”，在常规百分比和固定加值之后应用。
 * 文档 §12.3 / §14.3。
 */
export function meleePositionHitPercent(attackerPosition, defenderPosition) {
  const row = MELEE_POSITION_HIT_MODIFIER[attackerPosition];
  if (!row) return 0;
  return row[defenderPosition] ?? 0;
}

/** 返回按固定顺序排列的目标位置列表。 */
export function meleeTargetPriority(attackerPosition) {
  return MELEE_TARGET_PRIORITY[attackerPosition] ?? MELEE_TARGET_PRIORITY.front;
}

export const TARGET_MODES = Object.freeze(["self", "single", "samePositionAoE", "globalAoE"]);
