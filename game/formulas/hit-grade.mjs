// 命中等级判定。设计文档 §13.6、§23.2。
// H ≤ E → 闪避；E < H ≤ 1.5E → 命中；1.5E < H ≤ 2.25E → 重击；2.25E < H → 致命一击。

export const HIT_GRADES = Object.freeze(["闪避", "命中", "重击", "致命一击"]);
export const HIT_GRADE_IDS = Object.freeze(["miss", "hit", "heavy", "critical"]);

export const HIT_GRADE_LABEL_BY_ID = Object.freeze({
  miss: "闪避",
  hit: "命中",
  heavy: "重击",
  critical: "致命一击",
});

export const HIT_GRADE_ID_BY_LABEL = Object.freeze({
  闪避: "miss",
  命中: "hit",
  重击: "heavy",
  致命一击: "critical",
});

/**
 * 按教材边界判定命中等级。边界属于 A 级规则，必须逐点测试。
 * @returns {"闪避"|"命中"|"重击"|"致命一击"}
 */
export function hitGrade(hit, evade) {
  if (hit <= evade) return "闪避";
  if (hit <= evade * 1.5) return "命中";
  if (hit <= evade * 2.25) return "重击";
  return "致命一击";
}

/** 带诊断的判定结果，便于战报与测试比较。 */
export function hitGradeDetail(hit, evade) {
  const grade = hitGrade(hit, evade);
  return {
    grade,
    id: HIT_GRADE_ID_BY_LABEL[grade],
    hit,
    evade,
    thresholds: {
      miss: evade,
      hit: evade * 1.5,
      heavy: evade * 2.25,
    },
  };
}

/** 只要没有闪避，本次附带的 Debuff 完整生效，不因命中等级缩放。文档 §13.6。 */
export function debuffApplies(grade) {
  return grade !== "闪避";
}
