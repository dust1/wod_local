import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { RULE_QUESTIONS, RULE_QUESTION_BY_ID, RULE_QUESTION_STATUSES, VERIFIED_RULES } from "../gamedata/rules/rule-questions.mjs";
import { POLICY_REGISTRY, POLICY_BY_ID, experimentalPolicies, policyForRuleQuestion } from "../game/policies/registry.mjs";
import { BATTLE_PHASES, phaseBefore, phaseIndex, PHASE_LABELS } from "../game/domain/phases.mjs";
import { BASE_TYPES, BASE_TYPE_LABELS, ATTACK_TYPES, STANDARD_DEFENSE_ATTACK_TYPES, dealsDirectDamage, executionPath, canBeDirectMainCommand } from "../game/domain/skill.mjs";
import { EQUIP_SLOTS, EQUIP_SLOT_ID_BY_LABEL } from "../game/domain/item.mjs";
import { POSITIONS, MELEE_TARGET_PRIORITY, MELEE_POSITION_HIT_MODIFIER } from "../game/domain/positions.mjs";
import { healthMax, manaMax } from "../game/formulas/resources.mjs";
import { skillRollMean, defaultInitiativeMean, damageMean } from "../game/formulas/rolls.mjs";
import { manaCost } from "../game/formulas/mana-cost.mjs";
import { hitGrade } from "../game/formulas/hit-grade.mjs";
import { applyModifierPipeline, percent, flat, globalPercent } from "../game/modifiers/pipeline.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

test("每回合阶段顺序与文档一致且可比较先后", () => {
  assert.deepEqual(BATTLE_PHASES, [
    "RoundStarted",
    "StatusSnapshotPublished",
    "PreRoundCommandsExecuted",
    "NaturalRegenerationApplied",
    "SummonUpkeepPaid",
    "InitiativeSkillsExecuted",
    "InitiativeScheduleGenerated",
    "MainActionsExecuted",
    "ExpiredEffectsRemoved",
    "RoundEnded",
  ]);
  assert.equal(phaseBefore("NaturalRegenerationApplied", "InitiativeScheduleGenerated"), true);
  assert.equal(phaseBefore("MainActionsExecuted", "PreRoundCommandsExecuted"), false);
  assert.equal(phaseIndex("RoundStarted"), 0);
  assert.equal(PHASE_LABELS.MainActionsExecuted, "主回合");
  assert.throws(() => phaseIndex("Unknown"), /未知战斗阶段/);
});

test("七种基础用途类型与执行路径一一对应", () => {
  assert.deepEqual(Object.values(BASE_TYPES), ["heal", "improve", "attack", "deteriorate", "summon", "defend", "initiative"]);
  assert.equal(BASE_TYPE_LABELS.attack, "攻击");
  assert.equal(executionPath("attack"), "attackRoll");
  assert.equal(executionPath("deteriorate"), "attackRollNoDamage");
  assert.equal(executionPath("heal"), "healingTrigger");
  assert.equal(executionPath("summon"), "summon");
  // 恶化技能无论攻击方式是什么都不造成直接伤害
  assert.equal(dealsDirectDamage("attack"), true);
  assert.equal(dealsDirectDamage("deteriorate"), false);
  // 治疗技能不能当作普通主动指令直接设置
  assert.equal(canBeDirectMainCommand("heal"), false);
  assert.equal(canBeDirectMainCommand("attack"), true);
});

test("13 种攻击方式与 4 种常规攻防方式", () => {
  assert.equal(Object.keys(ATTACK_TYPES).length, 13);
  assert.equal(ATTACK_TYPES[11], "近战");
  assert.equal(ATTACK_TYPES[13], "远程");
  assert.deepEqual(STANDARD_DEFENSE_ATTACK_TYPES, ["近战", "远程", "魔法", "心理攻击"]);
});

test("18 个装备部位使用稳定字符串 ID", () => {
  assert.equal(Object.keys(EQUIP_SLOTS).length, 18);
  for (const id of ["head", "ear", "glasses", "neck", "body", "belt", "cloak", "shoulder", "arm", "hand", "two_hands", "right_hand", "left_hand", "leg", "foot", "medal", "pocket", "ring"]) {
    assert.ok(EQUIP_SLOTS[id], `缺少部位 ${id}`);
  }
  assert.equal(EQUIP_SLOT_ID_BY_LABEL["双手"], "two_hands");
  assert.equal(EQUIP_SLOT_ID_BY_LABEL["右手"], "right_hand");
});

test("六个站位与教材表格完整", () => {
  assert.equal(POSITIONS.length, 6);
  for (const position of POSITIONS) {
    assert.equal(MELEE_TARGET_PRIORITY[position].length, 6);
    assert.equal(Object.keys(MELEE_POSITION_HIT_MODIFIER[position]).length, 6);
  }
});

test("A 级公式在规则层逐条复验", () => {
  assert.equal(healthMax({ constitution: 9, strength: 8 }).exact, 44);
  assert.equal(manaMax({ willpower: 7, intelligence: 4 }).exact, 30);
  assert.equal(skillRollMean({ primary: 12, secondary: 14, skillLevel: 4 }).exact, 46);
  assert.equal(defaultInitiativeMean({ agility: 14, perception: 11 }).exact, 39);
  assert.equal(damageMean({ primary: 12, secondary: 9, skillLevel: 4 }).exact, 11);
  assert.equal(manaCost({ standardCost: 10, skillLevel: 4 }).applied, 12);
  assert.equal(hitGrade(100, 100), "闪避");
  assert.equal(hitGrade(150, 100), "命中");
  assert.equal(hitGrade(225, 100), "重击");
  assert.equal(hitGrade(225.001, 100), "致命一击");
  assert.equal(applyModifierPipeline(100, { modifiers: [percent(10), percent(20), flat(8), globalPercent(25)] }).exact, 175);
});

test("待验证规则清单只包含本地模拟需要的项目", () => {
  assert.equal(RULE_QUESTIONS.length, 19);
  for (const question of RULE_QUESTIONS) {
    assert.ok(question.id, "规则问题缺少 id");
    assert.ok(question.question, `规则问题 ${question.id} 缺少描述`);
    assert.ok(RULE_QUESTION_STATUSES.includes(question.status), `规则问题 ${question.id} 状态非法: ${question.status}`);
    assert.ok(Array.isArray(question.evidence) && question.evidence.length > 0, `规则问题 ${question.id} 缺少证据引用`);
    assert.ok("experimentalPolicy" in question, `规则问题 ${question.id} 缺少实验策略字段`);
  }
  const ids = RULE_QUESTIONS.map((question) => question.id);
  assert.equal(new Set(ids).size, ids.length, "规则问题 id 必须唯一");
});

test("每条已实现的实验策略都能追溯到规则问题", () => {
  for (const policy of POLICY_REGISTRY) {
    assert.ok(policy.id, "策略缺少 id");
    assert.ok(["A", "B", "C", "D"].includes(policy.evidenceLevel), `策略 ${policy.id} 证据等级非法`);
    assert.ok(policy.description, `策略 ${policy.id} 缺少描述`);
    assert.ok(policy.ruleQuestionId === null || RULE_QUESTION_BY_ID[policy.ruleQuestionId], `策略 ${policy.id} 指向未知规则问题 ${policy.ruleQuestionId}`);
  }
  const ids = POLICY_REGISTRY.map((policy) => policy.id);
  assert.equal(new Set(ids).size, ids.length, "策略 id 必须唯一");
});

test("规则问题引用的策略必须已注册", () => {
  for (const question of RULE_QUESTIONS) {
    if (!question.experimentalPolicy) continue;
    assert.ok(POLICY_BY_ID[question.experimentalPolicy], `规则问题 ${question.id} 引用了未注册策略 ${question.experimentalPolicy}`);
  }
  // 仍有未实现的规则问题，必须显式为 null，不能假装已实现
  const unimplemented = RULE_QUESTIONS.filter((question) => question.experimentalPolicy === null).map((question) => question.id);
  assert.ok(unimplemented.includes("training-cost-curve"));
  assert.ok(unimplemented.includes("pvp-pve-differences"));
});

test("实验策略必须被显式标注", () => {
  const experimental = experimentalPolicies();
  assert.ok(experimental.length >= 15, `实验策略数量偏少: ${experimental.length}`);
  for (const policy of experimental) {
    assert.equal(policy.experimental, true);
    assert.ok(policy.evidenceLevel === "C" || policy.evidenceLevel === "D", `实验策略 ${policy.id} 不应声称 A/B 级证据`);
  }
  assert.equal(policyForRuleQuestion("wound-thresholds").length, 1);
});

test("已确认规则都指向存在的测试文件", () => {
  assert.ok(VERIFIED_RULES.length >= 15);
  for (const rule of VERIFIED_RULES) {
    assert.ok(rule.ref, `已确认规则 ${rule.id} 缺少文档引用`);
    assert.ok(existsSync(resolve(repoRoot, rule.test)), `已确认规则 ${rule.id} 指向的测试不存在: ${rule.test}`);
  }
});
