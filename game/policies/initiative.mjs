// 先攻衰减与平局策略。设计文档 §11.5、§25.3、§25.4。
//
// 默认使用 level1 + level2 战报反解出的 32 步循环公式；真正精确值相同的
// 平局顺序仍未确认，因此平局策略保持可替换。

/**
 * 线性衰减实验策略：
 *   factor(ordinal) = 1 - (ordinal - 1) × stepFraction ÷ totalActions
 * 每次行动的衰减比例与总行动次数成反比，因此行动次数越高，衰减越缓。
 */
export function createLinearDecayPolicy(options = {}) {
  const stepFraction = options.stepFraction ?? 0.5;
  const minimumFactor = options.minimumFactor ?? 0.1;
  return {
    id: options.id ?? `linear-decay-${stepFraction}`,
    experimental: true,
    factor(ordinal, totalActions) {
      if (totalActions <= 1) return 1;
      const factor = 1 - ((ordinal - 1) * stepFraction) / totalActions;
      return Math.max(minimumFactor, factor);
    },
  };
}

/**
 * 原版战报反解的多行动先攻衰减（level1 + level2，3,736 个步序观测）。
 *
 *   k = ((g - 1) mod 32) + 1
 *   factor(g) = 1/2 + 2^-k - (g - 1)/(2N)
 *
 * 32 步后指数项重置，所以第 33、65……步可能插到较早行动之前。
 * 排序和后续衰减使用精确值，只有展示值向下取整。
 */
export function createWodBlockDecayPolicy(options = {}) {
  const blockSize = Number(options.blockSize ?? 32);
  return {
    id: options.id ?? `wod-block-${blockSize}`,
    experimental: false,
    evidenceLevel: "C",
    factor(ordinal, totalActions) {
      const total = Math.max(1, Number(totalActions) || 1);
      const step = Math.max(1, Number(ordinal) || 1);
      const blockOrdinal = ((step - 1) % blockSize) + 1;
      return 0.5 + 2 ** (-blockOrdinal) - (step - 1) / (2 * total);
    },
  };
}

export const noDecayPolicy = Object.freeze({
  id: "no-decay",
  experimental: true,
  factor() {
    return 1;
  },
});

export const DEFAULT_DECAY_POLICY = createWodBlockDecayPolicy();

/**
 * 平局排序策略。默认：先按输入顺序稳定排序，进攻方优先。
 * 属于 D 级待验证项，仅作为实验实现。
 */
export const stableTieBreakPolicy = Object.freeze({
  id: "stable-input-order",
  experimental: true,
  compare(a, b) {
    if (a.side !== b.side) return a.side === "attacker" ? -1 : 1;
    return 0;
  },
});

/** 随机平局策略，需要 randomStream。 */
export const randomTieBreakPolicy = Object.freeze({
  id: "random",
  experimental: true,
  compare() {
    return 0;
  },
});

export const DEFAULT_TIE_BREAK_POLICY = stableTieBreakPolicy;

/**
 * 生成一次行动的完整先攻队列。
 * 本回合每一次行动的先攻都在先攻阶段生成，而不是行动到来时临时生成。
 *
 * @param {object} input
 * @param {object[]} input.units 参与先攻的单位
 * @param {Map<string, number>} input.initiativeValues 每个单位的基础先攻值
 * @param {Map<string, number>} input.actionCounts 每个单位的行动次数
 * @param {object} [input.decayPolicy]
 * @param {object} [input.tieBreakPolicy]
 * @returns {{schedule: object[], byUnit: Map<string, object[]>}}
 */
export function buildInitiativeSchedule(input) {
  const decayPolicy = input.decayPolicy ?? DEFAULT_DECAY_POLICY;
  const tieBreakPolicy = input.tieBreakPolicy ?? DEFAULT_TIE_BREAK_POLICY;
  const schedule = [];
  const byUnit = new Map();

  for (const unit of input.units) {
    const base = Number(input.initiativeValues.get(unit.id) ?? 0);
    const total = Math.max(0, Number(input.actionCounts.get(unit.id) ?? 0));
    const entries = [];
    for (let ordinal = 1; ordinal <= total; ordinal += 1) {
      const factor = decayPolicy.factor(ordinal, total);
      entries.push({
        actorId: unit.id,
        actorName: unit.name,
        side: unit.side,
        initiativeExact: base * factor,
        initiative: Math.floor(base * factor),
        ordinal,
        totalActions: total,
        decayFactor: factor,
      });
    }
    byUnit.set(unit.id, entries);
    schedule.push(...entries);
  }

  schedule.sort((a, b) => {
    if (b.initiativeExact !== a.initiativeExact) return b.initiativeExact - a.initiativeExact;
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    const tie = tieBreakPolicy.compare(a, b);
    if (tie !== 0) return tie;
    if (a.side !== b.side) return a.side === "attacker" ? -1 : 1;
    if (a.actorId !== b.actorId) return String(a.actorId).localeCompare(String(b.actorId));
    return a.ordinal - b.ordinal;
  });

  return { schedule, byUnit };
}
