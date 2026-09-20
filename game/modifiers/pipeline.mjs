// 修正收集与管线。设计文档 §14。
// 顺序：基础值 × 常规百分比倍率 + 固定值合计 → × 全局百分比倍率。

/**
 * @typedef {object} Modifier
 * @property {"percent"|"flat"|"scaledFlat"|"scaledPercent"|"randomFlat"|"globalPercent"} kind
 * @property {number} [value]
 * @property {"heroLevel"|"skillLevel"} [scale]
 * @property {number} [ratio]
 * @property {number} [mean]
 * @property {string} [rollPolicyId]
 * @property {string} [source] 来源分类，必须保留以便追踪
 */

export function percent(value, source = "unknown") {
  return { kind: "percent", value, source };
}

export function flat(value, source = "unknown") {
  return { kind: "flat", value, source };
}

export function globalPercent(value, source = "unknown") {
  return { kind: "globalPercent", value, source };
}

export function scaledFlat(scale, ratio, source = "unknown") {
  return { kind: "scaledFlat", scale, ratio, source };
}

/**
 * 按等级比例换算的固定修正，形态为「+N%×技能等级 / +N%×英雄等级」。
 * 百分号只参与比例换算：ratio/100 × 等级值。例如 +20%×英雄等级、英雄 26 级 → 固定 +5.2。
 */
export function scaledPercent(scale, ratio, source = "unknown") {
  return { kind: "scaledPercent", scale, ratio, source };
}

export function randomFlat(mean, rollPolicyId, source = "unknown") {
  return { kind: "randomFlat", mean, rollPolicyId, source };
}

/**
 * 解析修正为可加的固定值或百分比值。
 * scaledFlat / randomFlat 需要上下文才能求值。
 */
export function resolveModifier(modifier, context = {}) {
  switch (modifier.kind) {
    case "percent":
    case "globalPercent":
      return Number(modifier.value ?? 0);
    case "flat":
      return Number(modifier.value ?? 0);
    case "scaledFlat": {
      const scaleValue = modifier.scale === "heroLevel" ? Number(context.heroLevel ?? 0) : Number(context.skillLevel ?? 0);
      return scaleValue * Number(modifier.ratio ?? 0);
    }
    case "scaledPercent": {
      const scaleValue = modifier.scale === "heroLevel" ? Number(context.heroLevel ?? 0) : Number(context.skillLevel ?? 0);
      return (scaleValue * Number(modifier.ratio ?? 0)) / 100;
    }
    case "randomFlat": {
      const rollPolicy = context.rollPolicies?.[modifier.rollPolicyId];
      if (!rollPolicy) throw new Error(`缺少随机策略: ${modifier.rollPolicyId}`);
      return rollPolicy.rollAroundMean(Number(modifier.mean ?? 0), { purpose: "randomFlat", ...context });
    }
    default:
      throw new Error(`未知修正类型: ${modifier.kind}`);
  }
}

/**
 * 百分比连乘：∏(1 + 百分比值 ÷ 100)。文档 §14.2。
 */
export function percentMultiplier(percentValues = []) {
  return percentValues.reduce((value, percentValue) => value * (1 + percentValue / 100), 1);
}

/**
 * 完整修正管线，返回精确值与按来源分类的诊断步骤。
 * 文档 §14.3 / §14.4。
 *
 * @param {number} base
 * @param {object} options
 * @param {Modifier[]} [options.modifiers]
 * @param {object} [options.context]
 */
export function applyModifierPipeline(base, options = {}) {
  const modifiers = options.modifiers ?? [];
  const context = options.context ?? {};
  const steps = [{ label: "基础值", value: base }];

  const percents = [];
  const globals = [];
  const flats = [];

  for (const modifier of modifiers) {
    const value = resolveModifier(modifier, context);
    if (modifier.kind === "percent") {
      percents.push(value);
      steps.push({ label: `百分比 ${modifier.source ?? ""}`.trim(), value, note: `+${value}%` });
    } else if (modifier.kind === "globalPercent") {
      globals.push(value);
      steps.push({ label: `全局百分比 ${modifier.source ?? ""}`.trim(), value, note: `+${value}%` });
    } else {
      flats.push({ value, source: modifier.source ?? "unknown" });
      steps.push({ label: `固定值 ${modifier.source ?? ""}`.trim(), value });
    }
  }

  const percentMul = percentMultiplier(percents);
  const globalMul = percentMultiplier(globals);
  const flatTotal = flats.reduce((sum, entry) => sum + entry.value, 0);

  const afterPercent = base * percentMul;
  steps.push({ label: "常规百分比倍率", value: percentMul, note: `×${percentMul}` });
  const afterFlat = afterPercent + flatTotal;
  steps.push({ label: "固定值合计", value: flatTotal, note: `+${flatTotal}` });
  const exact = afterFlat * globalMul;
  steps.push({ label: "全局百分比倍率", value: globalMul, note: `×${globalMul}` });

  return {
    exact,
    percentMultiplier: percentMul,
    globalMultiplier: globalMul,
    flatTotal,
    flatBySource: flats,
    steps,
  };
}
