// 最终伤害管线。设计文档 §13.7、§14.4、§9.7。
//
// 顺序由版本化 DamagePipelineDefinition 控制：
//   伤害公式平均值
//   → 随机伤害投点
//   → 投点前/后固定伤害加值（按来源分类）
//   → 常规伤害百分比
//   → z 类型伤害追加
//   → 命中等级伤害修正
//   → 技能效果奖励
//   → 防御方护甲/抵抗
//   → 脆弱性
//   → 技能全局效果奖励
//   → 伤害奖励（限时与常驻三档效果）
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
    "skillEffectBonus",
    "armorResistance",
    "vulnerability",
    "globalPercent",
    "postDefenseBonus",
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

/** 技能效果奖励：百分比相乘，再追加固定值；伤害与治疗共用。 */
export function applySkillEffectBonus(value, terms = []) {
  const percents = terms.filter((term) => term.kind === "percent").map((term) => Number(term.value ?? 0));
  const flat = terms.filter((term) => term.kind !== "percent").reduce((sum, term) => sum + Number(term.value ?? 0), 0);
  return { value: Math.max(0, value * percentMultiplier(percents) + flat), multiplier: percentMultiplier(percents), flat };
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
 * @param {Array} [input.skillEffectBonus] 技能效果奖励，护甲之前生效
 * @param {object} [input.defense] { armor: {percent}, resistance: {percent} }
 * @param {object} [input.armorPolicy]
 * @param {object} [input.resistancePolicy]
 * @param {number[]} [input.globalPercents]
 * @param {object} [input.postDefenseBonus] 伤害奖励在护甲和后续减免之后追加
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

  // 2. 公式平均值先受百分比修正，然后投点。
  // 固定加值不进入骰池，在投点后追加。
  const percentValues = (input.percents ?? []).map((entry) => Number(entry.value ?? 0));
  const percentMul = percentMultiplier(percentValues);
  if (percentValues.length > 0) steps.push(calculationStep("常规伤害百分比倍率", percentMul, `×${percentMul}`));
  const rollBase = meanExact * percentMul;
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
  const afterFlats = rolled + preRollFlat + postRollFlatTotal;

  // 5. z 类型伤害追加：只有本次攻击确实产生该类型伤害时生效
  const producedTypes = new Set(input.damageTypes ?? []);
  const zEntries = (input.zAdditions ?? []).filter((entry) => producedTypes.has(entry.damageType));
  const zTotal = sumBy(zEntries, () => true);
  for (const entry of zEntries) {
    steps.push(calculationStep(`z 伤害追加 ${entry.damageType} ${entry.source ?? ""}`.trim(), entry.value));
  }
  const afterZ = afterFlats + zTotal;

  // 6. 命中等级伤害修正
  const hitGrade = input.hitGrade ?? "命中";
  const hitGradePercents = input.hitGradePercents ?? zeroHitGradePercents;
  const hitGradePercent = Number(hitGradePercents[hitGrade] ?? 0);
  const afterHitGrade = afterZ * (1 + hitGradePercent / 100);
  if (hitGradePercent !== 0) steps.push(calculationStep(`命中等级修正 ${hitGrade}`, hitGradePercent, `×${1 + hitGradePercent / 100}`));
  const skillEffect = applySkillEffectBonus(afterHitGrade, input.skillEffectBonus);
  if ((input.skillEffectBonus ?? []).length > 0) steps.push(calculationStep("技能效果奖励", skillEffect.value, `×${skillEffect.multiplier} +${skillEffect.flat}`));

  // 7. 防御方护甲 / 抵抗
  const armorPolicy = input.armorPolicy ?? zeroReductionPolicy;
  const resistancePolicy = input.resistancePolicy ?? zeroReductionPolicy;
  const armor = armorPolicy.reduce(skillEffect.value, input.defense?.armor?.percent ?? 0);
  steps.push(calculationStep(`护甲减免`, armor.applied, `策略 ${armorPolicy.id}`));
  const afterArmor = Math.max(0, armor.value - Number(input.defense?.armor?.flat ?? 0));
  if (input.defense?.armor?.flat) steps.push(calculationStep("固定护甲减免", Number(input.defense.armor.flat)));
  const resistance = resistancePolicy.reduce(afterArmor, input.defense?.resistance?.percent ?? 0);
  steps.push(calculationStep(`抵抗减免`, resistance.applied, `策略 ${resistancePolicy.id}`));
  const afterDefense = resistance.value;
  const vulnerability = input.vulnerability ?? {};
  const vulnerabilityPercent = percentMultiplier(vulnerability.percents ?? []);
  const vulnerabilityRate = vulnerabilityPercent + Number(vulnerability.flat ?? 0) / 100;
  const vulnerabilityLabel = vulnerabilityRate > 1 ? "脆弱性" : vulnerabilityRate >= 0 ? "抵抗性" : "抗性超出预期";
  const afterVulnerability = afterDefense * vulnerabilityRate;
  if ((vulnerability.percents ?? []).length > 0 || Number(vulnerability.flat ?? 0) !== 0)
    steps.push(calculationStep(vulnerabilityLabel, afterVulnerability, `${vulnerabilityRate * 100}%`));

  // 8. 技能全局效果奖励
  const globalPercents = input.globalPercents ?? [];
  const globalMul = percentMultiplier(globalPercents);
  if (globalPercents.length > 0) steps.push(calculationStep("技能全局效果奖励倍率", globalMul, `×${globalMul}`));
  const afterGlobal = afterVulnerability * globalMul;
  const damageBonus = input.postDefenseBonus ?? {};
  const bonusMultiplier = percentMultiplier(damageBonus.percents ?? []);
  const bonusFlat = Number(damageBonus.flat ?? 0);
  if ((damageBonus.percents ?? []).length > 0) steps.push(calculationStep("伤害奖励倍率", bonusMultiplier, `×${bonusMultiplier}`));
  if (bonusFlat !== 0) steps.push(calculationStep("固定伤害奖励", bonusFlat));
  const exact = afterGlobal * bonusMultiplier + bonusFlat;

  // 9. 最终取整
  const final = calculatedNumber(exact, { roundingPolicy, steps });

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
      vulnerabilityRate,
      vulnerabilityLabel,
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
