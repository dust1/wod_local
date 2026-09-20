// 训练花费来自 docs/game_meta_rule.md「训练花费」表。
// 数组下标是目标属性等级；例如从 1 提升到 2 使用 ATTRIBUTE_TRAINING_COST[2]。
export const ATTRIBUTE_TRAINING_COST = Object.freeze([
  null, null, 100, 400, 800, 1500, 2300, 3400, 4700, 6200, 8000,
  10000, 12300, 14800, 17600, 20700, 24000, 27600, 31500, 35700, 40200,
  45000, 50000, 55400, 61100, 67100, 73400, 80000, 87000, 94200, 101800,
  109700, 118000, 126600, 135500, 144700, 154300, 164300, 174500, 185200, 196200,
]);

export function attributeTrainingChange(currentValue, delta) {
  const current = Number(currentValue);
  if (!Number.isInteger(current) || current < 1) throw new Error("属性值无效");
  if (delta !== 1 && delta !== -1) throw new Error("属性每次只能增减 1 点");
  const next = current + delta;
  if (next < 1) throw new Error("属性不能低于 1");
  const costLevel = delta > 0 ? next : current;
  const cost = ATTRIBUTE_TRAINING_COST[costLevel];
  if (!Number.isFinite(cost)) throw new Error("该属性等级没有训练花费定义");
  return { current, next, delta, experienceChange: delta > 0 ? -cost : cost, cost };
}

/**
 * 草稿尚未初始化或值无效时回退到服务端基础值，避免 UI 逐级计算进入死循环。
 * 属性最低为 1，与服务端 attributeTrainingChange 的下限保持一致。
 */
export function normalizedAttributeDraftValue(baseValue, draftValue) {
  const base = Number(baseValue);
  if (!Number.isSafeInteger(base) || base < 1) throw new Error("属性值无效");
  const draft = Number(draftValue);
  return Number.isSafeInteger(draft) && draft >= 1 ? draft : base;
}

/** 计算两个属性值之间的总经验变化；逐级取样，与单步训练费用完全一致。 */
export function attributeTrainingRangeChange(currentValue, targetValue) {
  const current = normalizedAttributeDraftValue(currentValue, currentValue);
  const target = Number(targetValue);
  if (!Number.isSafeInteger(target) || target < 1) throw new Error("属性值无效");
  let value = current;
  let experienceChange = 0;
  while (value !== target) {
    const step = attributeTrainingChange(value, target > value ? 1 : -1);
    experienceChange += step.experienceChange;
    value = step.next;
  }
  return experienceChange;
}

export const SKILL_TRAINING_COSTS = Object.freeze({
  basic: Object.freeze([null, 20, 40, 120, 240, 400, 600, 840, 1120, 1440, 1800, 2200, 2640, 3120, 3640, 4200, 4800, 5440, 6120, 6840, 7600, 8400, 9240, 10120, 11040, 12000, 13000, 14040, 15120, 16240, 17400, 18600, 19840, 21120, 22440, 23800, 25200, 26640, 28120, 29640, 31200]),
  additional: Object.freeze([null, 40, 80, 280, 560, 920, 1440, 2040, 2760, 3600, 4520, 5600, 6760, 8080, 9480, 11000, 12680, 14440, 16360, 18360, 20520, 22760, 25160, 27680, 30360, 33120, 36000, 39040, 42200, 45480, 48880, 52440, 56120, 59920, 63840, 67920, 72120, 76440, 80920, 85520, 90240]),
  special: Object.freeze([null, 50, 100, 350, 800, 1400, 2150, 3100, 4250, 5600, 7150, 8900, 10850, 13050, 15450, 18050, 20900, 23950, 27250, 30800, 34600, 38600, 42850, 47350, 52100, 57100, 62350, 67850, 73600, 79600, 85900, 92400, 99200, 106250, 113550, 121150, 129000, 137100, 145500, 154200, 163100]),
  talent: Object.freeze([null, 1440, 1800, 2200, 2640, 3120, 3640, 4200, 4800, 5440, 6120, 6840, 7600, 8400, 9240, 10120, 11040, 12000, 13000, 14040, 15120, 16240, 17400, 18600, 19840, 21120, 22440, 23800, 25200, 26640, 28120, 29640, 31200, 32800, 34440, 36120, 37840, 39600, 41400, 43240, 45120]),
});

export function skillTrainingChange(currentLevel, delta, trainingClass) {
  const current = Number(currentLevel);
  if (!Number.isInteger(current) || current < 0) throw new Error("技能等级无效");
  if (delta !== 1 && delta !== -1) throw new Error("技能每次只能增减 1 级");
  const next = current + delta;
  if (next < 0) throw new Error("技能等级不能低于 0");
  const curve = SKILL_TRAINING_COSTS[trainingClass];
  if (!curve) throw new Error("未知训练类别");
  const cost = curve[delta > 0 ? next : current];
  if (!Number.isFinite(cost)) throw new Error("该技能等级没有训练花费定义");
  return { current, next, delta, trainingClass, cost, experienceChange: delta > 0 ? -cost : cost };
}

/** 草稿尚未初始化或值无效时回退到服务端等级，避免 UI 逐级计算进入死循环。 */
export function normalizedSkillDraftLevel(currentLevel, draftLevel) {
  const current = Number(currentLevel);
  if (!Number.isSafeInteger(current) || current < 0) throw new Error("技能等级无效");
  const draft = Number(draftLevel);
  return Number.isSafeInteger(draft) && draft >= 0 ? draft : current;
}

/** 计算两个技能等级之间的总经验变化。 */
export function skillTrainingRangeChange(currentLevel, targetLevel, trainingClass) {
  const current = normalizedSkillDraftLevel(currentLevel, currentLevel);
  const target = Number(targetLevel);
  if (!Number.isSafeInteger(target) || target < 0) throw new Error("技能等级无效");
  let level = current;
  let experienceChange = 0;
  while (level !== target) {
    const step = skillTrainingChange(level, target > level ? 1 : -1, trainingClass);
    experienceChange += step.experienceChange;
    level = step.next;
  }
  return experienceChange;
}

/**
 * 等级以 heroes.level 为准；总经验只判断当前等级能否手动提升一级。
 * game_meta_rule.md 的「等级提升_总数」等于 (目标等级 - 1)² × 1000。
 */
export function heroExperienceProgress(totalExperience, currentLevel) {
  const total = Math.max(0, Number(totalExperience) || 0);
  const level = Math.max(1, Math.min(40, Math.trunc(Number(currentLevel) || 1)));
  const levelStart = (level - 1) ** 2 * 1000;
  if (level >= 40) {
    return { level, levelStart, nextLevelAt: null, earnedInLevel: Math.max(0, total - levelStart), levelSpan: 0, toNextLevel: 0, percent: 100, canLevelUp: false };
  }
  const nextLevelAt = level ** 2 * 1000;
  const levelSpan = nextLevelAt - levelStart;
  const earnedInLevel = Math.max(0, total - levelStart);
  return {
    level,
    levelStart,
    nextLevelAt,
    earnedInLevel,
    levelSpan,
    toNextLevel: Math.max(0, nextLevelAt - total),
    percent: Math.max(0, Math.min(100, earnedInLevel / levelSpan * 100)),
    canLevelUp: total >= nextLevelAt,
  };
}
