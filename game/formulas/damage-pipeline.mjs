// 最终伤害管线。设计文档 §13.7、§14.4、§9.7。
//
// 顺序由版本化 DamagePipelineDefinition 控制：
//   伤害公式平均值
//   → 随机伤害投点
//   → 投点前/后固定伤害加值（按来源分类）
//   → 常规伤害百分比
//   → z 类型伤害追加
//   → 命中等级伤害修正
//   → 防御方护甲/抵抗
//   → 技能全局效果奖励
//   → 最终取整
//   → 资源扣减与装备损坏判定（由引擎负责，管线只返回结算结果）
//
// 每一步都产生诊断记录，顺序可被替换而无需修改调用方。

import { calculationStep, calculatedNumber, DEFAULT_ROUNDING_POLICY } from "./calculation.mjs";
import { percentMultiplier } from "../modifiers/pipeline.mjs";
import { damageMean } from "./rolls.mjs";

export const DEFAULT_DAMAGE_PIPELINE_ID = "wod-textbook-v1";

export const DEFAULT_DAMAGE_PIPELINE = Object.freeze({
  id: DEFAULT_DAMAGE_PIPELINE_ID,
  experimental: false,
  stages: Object.freeze([
    "mean",
    "roll",
    "preRollFlat",
    "postRollFlat",
    "percent",
    "zAddition",
    "hitGrade",
    "armorResistance",
    "globalPercent",
    "round",
  ]),
});

/** 护甲/抵抗尚未有完整公式，默认策略不减免并标记为实验性。 */
export const zeroReductionPolicy = Object.freeze({
  id: "zero-reduction",
  experimental: true,
  reduce(value) {
    return { value, applied: 0 };
  },
});

/**
 * 线性减免实验策略：减免 = value × 百分比 ÷ 100。
 * 仅用于演示管线位置，不得声称与原版一致（文档 §25.7）。
 */
export function createLinearReductionPolicy(id = "linear-reduction") {
  return {
    id,
    experimental: true,
    reduce(value, reductionPercent = 0) {
      const applied = value * (reductionPercent / 100);
      return { value: value - applied, applied };
    },
  };
}

/** 命中等级伤害修正，默认全 0，属于 D 级待验证参数。 */
export const zeroHitGradePercents = Object.freeze({
  闪避: 0,
  命中: 0,
  重击: 0,
  致命一击: 0,
});

function sumBy(entries, predicate) {
  return entries.filter(predicate).reduce((sum, entry) => sum + Number(entry.value ?? 0), 0);
}

/**
 * 结算一次伤害。
 *
 * @param {object} input
 * @param {number} [input.meanExact] 伤害公式平均值（精确）
 * @param {object} [input.formula] 传给 damageMean 的参数，与 meanExact 二选一
 * @param {object} [input.rollPolicy]
 * @param {object} [input.randomStream]
 * @param {Array<{value:number,source:string,timing?:string,damageType?:string}>} [input.flats]
 * @param {Array<{value:number,source:string}>} [input.percents]
 * @param {Array<{value:number,damageType:string,source:string}>} [input.zAdditions]
 * @param {string[]} [input.damageTypes] 本次攻击实际产生的伤害类型
 * @param {string} [input.hitGrade]
 * @param {object} [input.hitGradePercents]
 * @param {object} [input.defense] { armor: {percent}, resistance: {percent} }
 * @param {object} [input.armorPolicy]
 * @param {object} [input.resistancePolicy]
 * @param {number[]} [input.globalPercents]
 * @param {object} [options] { pipeline, roundingPolicy }
 */
export function resolveDamage(input = {}, options = {}) {
  const pipeline = options.pipeline ?? DEFAULT_DAMAGE_PIPELINE;
  const roundingPolicy = options.roundingPolicy ?? DEFAULT_ROUNDING_POLICY;
  const steps = [];

  // 1. 伤害公式平均值
  let meanExact;
  if (input.meanExact !== undefined) {
    meanExact = input.meanExact;
    steps.push(calculationStep("伤害公式平均值", meanExact));
  } else {
    const mean = damageMean(input.formula ?? {}, { roundingPolicy: meanRollPolicyIdentity });
    meanExact = mean.exact;
    steps.push(calculationStep("伤害公式平均值", meanExact));
  }

  const flats = input.flats ?? [];
  const preRollFlat = sumBy(flats, (entry) => (entry.timing ?? "postRoll") === "preRoll");
  if (preRollFlat !== 0) steps.push(calculationStep("投点前固定伤害加值", preRollFlat));

  // 2. 随机伤害投点
  const rollBase = meanExact + preRollFlat;
  const rollPolicy = input.rollPolicy ?? options.rollPolicy;
  let rolled = rollBase;
  if (rollPolicy) {
    rolled = rollPolicy.rollAroundMean(rollBase, {
      purpose: "damage",
      randomStream: input.randomStream ?? input.context?.randomStream,
      ...(input.context ?? {}),
    });
    steps.push(calculationStep("随机伤害投点", rolled, `策略 ${rollPolicy.id}`));
  } else {
    steps.push(calculationStep("随机伤害投点", rolled, "未注入策略，使用平均值"));
  }

  // 3. 投点后固定伤害加值（按来源分类，不能提前汇总）
  const postRollFlats = flats.filter((entry) => (entry.timing ?? "postRoll") === "postRoll");
  for (const entry of postRollFlats) {
    steps.push(calculationStep(`固定伤害加值 ${entry.source ?? ""}`.trim(), entry.value));
  }
  const postRollFlatTotal = sumBy(postRollFlats, () => true);
  const afterFlats = rolled + postRollFlatTotal;

  // 4. 常规伤害百分比
  const percentValues = (input.percents ?? []).map((entry) => Number(entry.value ?? 0));
  const percentMul = percentMultiplier(percentValues);
  if (percentValues.length > 0) steps.push(calculationStep("常规伤害百分比倍率", percentMul, `×${percentMul}`));
  const afterPercent = afterFlats * percentMul;

  // 5. z 类型伤害追加：只有本次攻击确实产生该类型伤害时生效
  const producedTypes = new Set(input.damageTypes ?? []);
  const zEntries = (input.zAdditions ?? []).filter((entry) => producedTypes.has(entry.damageType));
  const zTotal = sumBy(zEntries, () => true);
  for (const entry of zEntries) {
    steps.push(calculationStep(`z 伤害追加 ${entry.damageType} ${entry.source ?? ""}`.trim(), entry.value));
  }
  const afterZ = afterPercent + zTotal;

  // 6. 命中等级伤害修正
  const hitGrade = input.hitGrade ?? "命中";
  const hitGradePercents = input.hitGradePercents ?? zeroHitGradePercents;
  const hitGradePercent = Number(hitGradePercents[hitGrade] ?? 0);
  const afterHitGrade = afterZ * (1 + hitGradePercent / 100);
  if (hitGradePercent !== 0) steps.push(calculationStep(`命中等级修正 ${hitGrade}`, hitGradePercent, `×${1 + hitGradePercent / 100}`));

  // 7. 防御方护甲 / 抵抗
  const armorPolicy = input.armorPolicy ?? zeroReductionPolicy;
  const resistancePolicy = input.resistancePolicy ?? zeroReductionPolicy;
  const armor = armorPolicy.reduce(afterHitGrade, input.defense?.armor?.percent ?? 0);
  const resistance = resistancePolicy.reduce(armor.value, input.defense?.resistance?.percent ?? 0);
  steps.push(calculationStep(`护甲减免`, armor.applied, `策略 ${armorPolicy.id}`));
  steps.push(calculationStep(`抵抗减免`, resistance.applied, `策略 ${resistancePolicy.id}`));
  const afterDefense = resistance.value;

  // 8. 技能全局效果奖励
  const globalPercents = input.globalPercents ?? [];
  const globalMul = percentMultiplier(globalPercents);
  if (globalPercents.length > 0) steps.push(calculationStep("技能全局效果奖励倍率", globalMul, `×${globalMul}`));
  const exact = afterDefense * globalMul;

  // 9. 最终取整
  const final = calculatedNumber(exact, { roundingPolicy, minimum: 0, steps });

  return {
    exact: final.exact,
    applied: final.applied,
    hitGrade,
    damageTypes: [...producedTypes],
    diagnostics: {
      pipelineId: pipeline.id,
      pipelineExperimental: Boolean(pipeline.experimental),
      rollPolicyId: rollPolicy?.id ?? null,
      roundingPolicyId: roundingPolicy.id,
      armorPolicyId: armorPolicy.id,
      resistancePolicyId: resistancePolicy.id,
      preRollFlat,
      postRollFlatTotal,
      flatBySource: postRollFlats,
      percentMultiplier: percentMul,
      zTotal,
      globalMultiplier: globalMul,
    },
    trace: {
      base: meanExact,
      roll: rolled,
      percents: percentValues,
      flats: flats.map((entry) => ({ ...entry })),
      globalPercents,
      exact: final.exact,
      applied: final.applied,
      steps: final.steps,
    },
  };
}

const meanRollPolicyIdentity = { id: "identity", round: (value) => value };
