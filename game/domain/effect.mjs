// 效果实例、持续时间、延迟生效和同源不叠加。设计文档 §15。
//
// 关键语义（必须按原文转换，不能用简单的 remainingRounds 表达）：
//   “1 个回合”   包含当前回合与下一个回合
//   “X 个回合”   包含当前回合以及之后 X 个回合
//   “到该战斗结束” 只持续到当前房间结束
//   “无限制”     持续到地城结束
//   延迟期间不消耗持续时间

export const DURATION_KINDS = Object.freeze([
  "untilCurrentRoundEnd",
  "rounds",
  "untilBattleEnd",
  "untilDungeonEnd",
]);

export const ACTIVATION_KINDS = Object.freeze(["immediate", "nextRound", "afterRounds"]);

export const EFFECT_STATES = Object.freeze(["pending", "active", "expired"]);

export const DURATION_LABELS = Object.freeze({
  untilCurrentRoundEnd: "到该回合结束",
  rounds: "回合",
  untilBattleEnd: "到该战斗结束",
  untilDungeonEnd: "无限制",
});

/** 计算效果的结束边界。 */
export function durationExpiry(duration, appliedRound) {
  switch (duration.kind) {
    case "untilCurrentRoundEnd":
      return { boundary: "round", round: appliedRound };
    case "rounds":
      // “X 个回合” = 当前回合 + 之后 X 个回合 → 在第 appliedRound + X 回合末结束
      return { boundary: "round", round: appliedRound + Number(duration.value ?? 0) };
    case "untilBattleEnd":
      return { boundary: "battleEnd" };
    case "untilDungeonEnd":
      return { boundary: "dungeonEnd" };
    default:
      throw new Error(`未知持续时间类型: ${duration.kind}`);
  }
}

/**
 * 计算激活回合。
 * immediate    本阶段立即生效
 * nextRound    下个回合开始生效
 * afterRounds  “X 个回合后显示效果”：当前回合结束，再经过 X 个完整回合，随后回合开始生效
 */
export function activationRoundOf(activation, appliedRound) {
  switch (activation.kind) {
    case "immediate":
      return appliedRound;
    case "nextRound":
      return appliedRound + 1;
    case "afterRounds":
      return appliedRound + Number(activation.value ?? 0) + 1;
    default:
      throw new Error(`未知延迟类型: ${activation.kind}`);
  }
}

/** 延迟是否把效果推到未来（决定 state 是否为 pending）。 */
export function isDelayed(activation, appliedRound) {
  return activationRoundOf(activation, appliedRound) > appliedRound;
}

/**
 * 叠加判定主键：sourceSkillId + targetId + effectApplicationGroup。
 * 不能只按 Buff 名称判断，也不能把物品名误当作唯一来源。
 */
export function effectStackKey({ buffKey, sourceSkillName, sourceSkillId, targetId }) {
  return `${buffKey ?? sourceSkillName ?? sourceSkillId ?? "unknown-skill"}|${targetId ?? "unknown-target"}`;
}

/**
 * 构造效果实例。
 * @param {object} input
 */
export function createEffectInstance(input) {
  const {
    instanceId,
    effectDefinitionId,
    effectName,
    sourceActorId,
    sourceSkillId,
    sourceSkillName,
    buffKey,
    sourceItemIds = [],
    targetId,
    appliedRound,
    appliedPhase,
    activation = { kind: "immediate" },
    duration = { kind: "untilBattleEnd" },
    applicationGroup = "default",
    modifiers = [],
    components = [],
    tags = [],
    experimental = false,
  } = input;

  const activationRound = activationRoundOf(activation, appliedRound);
  const expiry = durationExpiry(duration, activationRound);
  const pending = isDelayed(activation, appliedRound);

  return {
    instanceId,
    effectDefinitionId,
    effectName: effectName ?? effectDefinitionId,
    sourceActorId,
    sourceSkillId,
    sourceItemIds: [...sourceItemIds],
    targetId,
    appliedRound,
    appliedPhase,
    activation: { ...activation },
    activationRound,
    duration: { ...duration },
    expiry,
    applicationGroup,
    buffKey: buffKey ?? sourceSkillName ?? sourceSkillId,
    stackKey: effectStackKey({ buffKey, sourceSkillName, sourceSkillId, targetId }),
    modifiers: modifiers.map((modifier) => {
      const modifierActivation = modifier.activation ?? activation;
      const modifierActivationRound = modifier.activationRound ?? activationRoundOf(modifierActivation, appliedRound);
      return {
        ...modifier,
        activation: { ...modifierActivation },
        activationRound: modifierActivationRound,
        state: modifierActivationRound > appliedRound ? "pending" : "active",
      };
    }),
    components: components.map((component) => ({ ...component })),
    tags: [...tags],
    experimental,
    state: pending ? "pending" : "active",
  };
}

/** 效果当前是否仍然存在（pending 或 active）。 */
export function isEffectLive(instance) {
  return instance.state === "pending" || instance.state === "active";
}

/** 效果当前是否提供修正。 */
export function isEffectActive(instance) {
  return instance.state === "active";
}

/**
 * 效果账本：负责同源不叠加、延迟激活与到期移除。
 * 所有方法都是确定性的，不读取系统时间。
 */
export class EffectLedger {
  #instances = [];
  #sequence = 0;

  constructor(options = {}) {
    this.idPrefix = options.idPrefix ?? "effect";
  }

  get instances() {
    return this.#instances;
  }

  /** 某来源技能对该目标是否仍有未结束的效果（同源不叠加）。 */
  hasLiveFromSource(sourceSkillId, targetId, applicationGroup = "default", buffKey = null) {
    const key = effectStackKey({ buffKey, sourceSkillId, targetId, applicationGroup });
    return this.#instances.some((instance) => instance.stackKey === key && isEffectLive(instance));
  }

  /**
   * 应用一个效果。
   * 同源不叠加：同一技能对同一目标在效果未全部结束时不能再次附加新效果。
   * @returns {{applied: boolean, reason?: string, instance?: object}}
   */
  apply(input) {
    const { sourceSkillId, targetId, applicationGroup = "default", buffKey, sourceSkillName } = input;
    if (this.hasLiveFromSource(sourceSkillId, targetId, applicationGroup, buffKey ?? sourceSkillName)) {
      return { applied: false, reason: "sameSourceActive" };
    }
    return { applied: true, instance: this.#push(input, applicationGroup) };
  }

  /**
   * 一次技能调用产生的全部效果。
   *
   * 设计文档 §15.4：技能效果与本次使用物品的目标效果属于同一应用组，
   * 但每个效果仍保留自身来源。因此“同源不叠加”只在一次调用开始时判定一次，
   * 组内多个效果必须全部落地，不能被第二个效果自身的键挡住。
   *
   * @param {object} input 公共字段 + effects: 每个效果自己的字段
   * @returns {{applied: boolean, reason?: string, instances: object[], skipped: object[]}}
   */
  applyGroup(input) {
    const { effects = [], sourceSkillId, targetId, applicationGroup = "default", buffKey, sourceSkillName } = input;
    if (this.hasLiveFromSource(sourceSkillId, targetId, applicationGroup, buffKey ?? sourceSkillName)) {
      return { applied: false, reason: "sameSourceActive", instances: [], skipped: effects.map((effect) => ({ effect, reason: "sameSourceActive" })) };
    }
    const instances = [];
    for (const effect of effects) {
      instances.push(this.#push({ ...input, ...effect }, applicationGroup));
    }
    return { applied: instances.length > 0, instances, skipped: [] };
  }

  #push(input, applicationGroup) {
    this.#sequence += 1;
    const instance = createEffectInstance({
      ...input,
      applicationGroup,
      instanceId: input.instanceId ?? `${this.idPrefix}-${this.#sequence}`,
    });
    this.#instances.push(instance);
    return instance;
  }

  /**
   * 推进到指定回合的开始：把到期延迟的效果转为 active。
   * 延迟期间不消耗持续时间，因此到期边界基于 activationRound 计算。
   */
  activateAtRound(round) {
    const activated = [];
    for (const instance of this.#instances) {
      if (instance.state === "pending" && instance.activationRound <= round) {
        instance.state = "active";
        activated.push(instance);
      }
      if (!isEffectLive(instance)) continue;
      for (const modifier of instance.modifiers) {
        if (modifier.state === "pending" && modifier.activationRound <= round) modifier.state = "active";
      }
    }
    return activated;
  }

  /**
   * 回合结束结算：移除到期效果。
   * @param {number} round
   * @param {object} [options] { battleEnded, dungeonEnded }
   */
  expireAtRoundEnd(round, options = {}) {
    const expired = [];
    for (const instance of this.#instances) {
      if (!isEffectLive(instance)) continue;
      const { expiry } = instance;
      const byRound = expiry.boundary === "round" && expiry.round <= round;
      const byBattle = expiry.boundary === "battleEnd" && options.battleEnded === true;
      const byDungeon = expiry.boundary === "dungeonEnd" && options.dungeonEnded === true;
      if (byRound || byBattle || byDungeon) {
        instance.state = "expired";
        expired.push(instance);
      }
    }
    return expired;
  }

  /** 战斗结束时清除“到该战斗结束”的效果，保留无限期效果。 */
  onBattleEnd() {
    return this.expireAtRoundEnd(Number.POSITIVE_INFINITY, { battleEnded: true });
  }

  onDungeonEnd() {
    return this.expireAtRoundEnd(Number.POSITIVE_INFINITY, { dungeonEnded: true });
  }

  activeFor(targetId) {
    return this.#instances.filter((instance) => instance.targetId === targetId && isEffectActive(instance));
  }

  liveFor(targetId) {
    return this.#instances.filter((instance) => instance.targetId === targetId && isEffectLive(instance));
  }

  /** 收集某目标当前生效的修正，保留来源分类。 */
  modifiersFor(targetId) {
    return this.activeFor(targetId).flatMap((instance) =>
      instance.modifiers.filter((modifier) => modifier.state !== "pending").map((modifier) => ({
        ...modifier,
        source: modifier.source ?? `${instance.sourceSkillId}/${instance.effectDefinitionId}`,
        instanceId: instance.instanceId,
        sourceSkillId: instance.sourceSkillId,
      })),
    );
  }

  /** 快照，用于存档与回放。 */
  snapshot() {
    return this.#instances.map((instance) => ({
      ...instance,
      modifiers: instance.modifiers.map((m) => ({ ...m })),
      components: (instance.components ?? []).map((component) => ({ ...component })),
    }));
  }

  restore(instances) {
    this.#instances = instances.map((instance) => ({ ...instance }));
    this.#sequence = instances.length;
  }

  clear() {
    this.#instances = [];
    this.#sequence = 0;
  }
}

/**
 * 基础用途对“同源不叠加”的行为差异。文档 §15.4。
 * 攻击技能仍可选择目标并造成伤害，但不重复附加该技能效果。
 * 恶化或改良技能通常不能再次选择该目标。
 */
export const SAME_SOURCE_BEHAVIOR = Object.freeze({
  attack: { canStillTarget: true, reapplies: false },
  deteriorate: { canStillTarget: false, reapplies: false },
  improve: { canStillTarget: false, reapplies: false },
  heal: { canStillTarget: true, reapplies: true },
  summon: { canStillTarget: true, reapplies: false },
  defend: { canStillTarget: true, reapplies: false },
  initiative: { canStillTarget: true, reapplies: false },
});

export function sameSourceBehavior(baseType) {
  return SAME_SOURCE_BEHAVIOR[baseType] ?? { canStillTarget: true, reapplies: true };
}
