import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSummonExpression,
  parseSummonExpression,
  SummonExpressionError,
  validateSummonExpression,
} from "../game/formulas/summon-expression.mjs";

const variables = { summonSkillLevel: 14, heroLevel: 20, tier: 4, summonLevel: 14 };

test("召唤表达式支持变量、优先级、括号和一元运算", () => {
  assert.equal(evaluateSummonExpression("2 + summonSkillLevel * 1.5", variables), 23);
  assert.equal(evaluateSummonExpression("-(heroLevel - summonLevel) + tier", variables), -2);
});

test("召唤表达式支持受限数学函数", () => {
  assert.equal(evaluateSummonExpression("floor(summonSkillLevel / 3)", variables), 4);
  assert.equal(evaluateSummonExpression("ceil(1.2) + round(1.5)", variables), 4);
  assert.equal(evaluateSummonExpression("clamp(max(1, summonSkillLevel - 10), 2, 3)", variables), 3);
  assert.equal(evaluateSummonExpression("min(heroLevel, summonLevel)", variables), 14);
});

test("固定数值与预解析语法树可以直接求值", () => {
  const ast = parseSummonExpression("5");
  assert.equal(evaluateSummonExpression(ast, variables), 5);
  assert.deepEqual(validateSummonExpression("summonSkillLevel + 1"), { ok: true, error: null });
});

test("召唤表达式拒绝任意代码、未知名称和错误参数", () => {
  for (const expression of ["Math.random()", "process.exit()", "unknown + 1", "min(1)", "min(, 1)", "clamp(1, 3, 2)"]) {
    assert.throws(() => evaluateSummonExpression(expression, variables), SummonExpressionError);
  }
});

test("召唤表达式拒绝缺失变量、除零和非有限结果", () => {
  assert.throws(() => evaluateSummonExpression("summonSkillLevel + 1", {}), /有限数值/);
  assert.throws(() => evaluateSummonExpression("1 / 0", variables), /除以零/);
  assert.equal(validateSummonExpression("1 +" ).ok, false);
});
