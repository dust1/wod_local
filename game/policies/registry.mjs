// 可替换策略注册表。设计文档 §25、§27。
//
// 所有 C、D 级规则必须通过策略接口隔离，并能在界面或诊断中标注实验状态。
// 这里集中列出当前实现的所有策略及其证据等级，供测试与诊断使用。

import { meanRollPolicy, createDiceRollPolicy, createUniformRollPolicy } from "./roll.mjs";
import { DEFAULT_DECAY_POLICY, createLinearDecayPolicy, noDecayPolicy, stableTieBreakPolicy, randomTieBreakPolicy } from "./initiative.mjs";
import { floorRoundingPolicy, roundHalfUpPolicy } from "../formulas/calculation.mjs";
import { zeroReductionPolicy, createLinearReductionPolicy, DEFAULT_DAMAGE_PIPELINE, zeroHitGradePercents } from "../formulas/damage-pipeline.mjs";
import { defaultFailureCostPolicy } from "../commands/cursor.mjs";
import { defaultWoundThresholdPolicy, defaultHealingPriorityPolicy } from "../commands/healing.mjs";
import { randomWithinPositionPolicy, stableWithinPositionPolicy } from "../targeting/select.mjs";
import { defaultEvadeAttributePolicy } from "../engine/simulate.mjs";
import { DEFAULT_NO_DURABILITY_DAMAGE_TYPES, SLOT_CONFLICTS, ONE_HAND_SLOT_ID } from "../domain/item.mjs";

/**
 * @typedef {object} PolicyEntry
 * @property {string} id
 * @property {"A"|"B"|"C"|"D"} evidenceLevel
 * @property {boolean} experimental
 * @property {string} description
 * @property {string|null} ruleQuestionId
 */

/** @type {PolicyEntry[]} */
export const POLICY_REGISTRY = [
  { id: "rounding:floor", evidenceLevel: "B", experimental: false, description: "使用时向下取整", ruleQuestionId: "rounding-points", impl: floorRoundingPolicy },
  { id: "rounding:round-half-up", evidenceLevel: "D", experimental: true, description: "四舍五入对照实现", ruleQuestionId: "rounding-points", impl: roundHalfUpPolicy },
  { id: "roll:mean", evidenceLevel: "C", experimental: false, description: "直接返回平均值，用于确定性断言", ruleQuestionId: "random-roll-distribution", impl: meanRollPolicy },
  { id: "roll:wod-dice-pool-int", evidenceLevel: "C", experimental: true, description: "最多 6 颗主骰加 1 颗副骰的 0 起始奇数面骰池", ruleQuestionId: "random-roll-distribution", impl: createDiceRollPolicy() },
  { id: "roll:uniform-0-2mean", evidenceLevel: "D", experimental: true, description: "在 [0, 2 × 平均值] 上均匀投点", ruleQuestionId: "random-roll-distribution", impl: createUniformRollPolicy() },
  { id: "decay:wod-block-32", evidenceLevel: "C", experimental: false, description: "战报验证的 32 步循环多行动先攻衰减", ruleQuestionId: "multi-action-initiative-decay", impl: DEFAULT_DECAY_POLICY },
  { id: "decay:linear-decay-0.5", evidenceLevel: "D", experimental: true, description: "旧版多次行动线性衰减对照", ruleQuestionId: "multi-action-initiative-decay", impl: createLinearDecayPolicy() },
  { id: "decay:no-decay", evidenceLevel: "D", experimental: true, description: "不衰减对照实现", ruleQuestionId: "multi-action-initiative-decay", impl: noDecayPolicy },
  { id: "tieBreak:stable-input-order", evidenceLevel: "D", experimental: true, description: "同先攻按输入顺序稳定排序", ruleQuestionId: "initiative-tie-break", impl: stableTieBreakPolicy },
  { id: "tieBreak:random", evidenceLevel: "D", experimental: true, description: "同先攻随机排序", ruleQuestionId: "initiative-tie-break", impl: randomTieBreakPolicy },
  { id: "evade:default-evade-agility-perception", evidenceLevel: "D", experimental: true, description: "无防御技能时默认闪避用敏捷 × 2 + 感知", ruleQuestionId: "default-evade-attributes", impl: defaultEvadeAttributePolicy },
  { id: "armor:zero-reduction", evidenceLevel: "D", experimental: true, description: "护甲/抵抗不减免对照实现", ruleQuestionId: "armor-resistance-formula", impl: zeroReductionPolicy },
  { id: "armor:linear-reduction", evidenceLevel: "D", experimental: true, description: "护甲/抵抗线性减免实验实现", ruleQuestionId: "armor-resistance-formula", impl: createLinearReductionPolicy() },
  { id: "pipeline:wod-textbook-v1", evidenceLevel: "B", experimental: false, description: "教材伤害管线顺序", ruleQuestionId: "damage-order-z-item-global", impl: DEFAULT_DAMAGE_PIPELINE },
  { id: "hitGrade:zero-percents", evidenceLevel: "D", experimental: true, description: "命中等级伤害修正全为 0", ruleQuestionId: "damage-order-z-item-global", impl: zeroHitGradePercents },
  { id: "failureCost:default-failure-cost", evidenceLevel: "D", experimental: true, description: "结构性失败不消耗行动；主回合一整圈都无可执行指令算本次行动失败并消耗行动点（无法执行任何行动）", ruleQuestionId: "failed-attempt-cost", impl: defaultFailureCostPolicy },
  { id: "woundThreshold:default-wound-thresholds", evidenceLevel: "D", experimental: true, description: "轻伤 90% / 受伤 60% / 重伤 30%", ruleQuestionId: "wound-thresholds", impl: defaultWoundThresholdPolicy },
  { id: "healingPriority:default-healing-priority", evidenceLevel: "D", experimental: true, description: "治疗触发器 1 至 5 优先级，英雄优先", ruleQuestionId: "healing-formula", impl: defaultHealingPriorityPolicy },
  { id: "withinPosition:random-within-position", evidenceLevel: "D", experimental: true, description: "站位内随机排序", ruleQuestionId: "within-position-order", impl: randomWithinPositionPolicy },
  { id: "withinPosition:stable-input-order", evidenceLevel: "D", experimental: true, description: "站位内保持输入顺序", ruleQuestionId: "within-position-order", impl: stableWithinPositionPolicy },
  { id: "durability:default-no-damage-types", evidenceLevel: "D", experimental: true, description: "心理与毒素伤害不损坏装备", ruleQuestionId: "durability-damage", impl: { id: "durability:default-no-damage-types", types: DEFAULT_NO_DURABILITY_DAMAGE_TYPES } },
  { id: "slots:two-hands-conflict", evidenceLevel: "C", experimental: true, description: "双手与左右手互斥", ruleQuestionId: "hand-slot-occupancy", impl: { id: "slots:two-hands-conflict", conflicts: SLOT_CONFLICTS } },
  { id: "slots:one-hand-occupancy", evidenceLevel: "C", experimental: true, description: "单手物品占用一只空手，与双手物品互斥", ruleQuestionId: "hand-slot-occupancy", impl: { id: "slots:one-hand-occupancy", oneHand: ONE_HAND_SLOT_ID } },
  { id: "modifier:randomFlat", evidenceLevel: "D", experimental: true, description: "随机固定加值借用 RollPolicy 求值", ruleQuestionId: "random-flat-range", impl: { id: "modifier:randomFlat" } },
  { id: "heal:damage-mean-reuse", evidenceLevel: "D", experimental: true, description: "治疗量借用伤害平均值公式，治疗命中规则未确认", ruleQuestionId: "healing-formula", impl: { id: "heal:damage-mean-reuse" } },
  { id: "battleEnd:last-side-standing", evidenceLevel: "D", experimental: true, description: "一方全部倒下即结束战斗", ruleQuestionId: "defeat-escape-victory", impl: { id: "battleEnd:last-side-standing" } },
  { id: "uniqueness:dropped-ever-ledger", evidenceLevel: "C", experimental: true, description: "已掉落唯一记录与当前持有记录分离", ruleQuestionId: "loot-and-uniqueness", impl: { id: "uniqueness:dropped-ever-ledger" } },
  { id: "defaultPlan:first-available-skill", evidenceLevel: "D", experimental: true, description: "无显式方案的单位按已知技能生成确定性兜底方案", ruleQuestionId: null, impl: { id: "defaultPlan:first-available-skill" } },
];

export const POLICY_BY_ID = Object.fromEntries(POLICY_REGISTRY.map((policy) => [policy.id, policy]));

export function experimentalPolicies() {
  return POLICY_REGISTRY.filter((policy) => policy.experimental);
}

/** 供界面标注：某规则问题当前使用的策略及其实验状态。 */
export function policyForRuleQuestion(ruleQuestionId) {
  return POLICY_REGISTRY.filter((policy) => policy.ruleQuestionId === ruleQuestionId);
}
