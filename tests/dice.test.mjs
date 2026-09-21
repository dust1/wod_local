import test from "node:test";
import assert from "node:assert/strict";

import { createDicePool, rollDice, rollDicePool } from "../game/dice.mjs";
import { createRandomStream } from "../game/policies/random.mjs";
import { createDiceRollPolicy } from "../game/policies/roll.mjs";

test("1 至 41 点使用 D15 主骰和一颗补余数的副骰", () => {
  assert.deepEqual(createDicePool(1).main, null);
  assert.equal(createDicePool(1).secondary.sides, 3);

  const seven = createDicePool(7);
  assert.deepEqual(seven.main, { count: 1, sides: 15, minimum: 0, maximum: 14 });
  assert.equal(seven.secondary, null);

  const thirtyThree = createDicePool(33);
  assert.deepEqual(thirtyThree.main, { count: 4, sides: 15, minimum: 0, maximum: 14 });
  assert.deepEqual(thirtyThree.secondary, { count: 1, sides: 11, minimum: 0, maximum: 10 });
});

test("42 点起固定六颗主骰并用至多 D11 补余数", () => {
  const fortyTwo = createDicePool(42);
  assert.deepEqual(fortyTwo.main, { count: 6, sides: 15, minimum: 0, maximum: 14 });
  assert.equal(fortyTwo.secondary, null);

  const fortyEight = createDicePool(48);
  assert.deepEqual(fortyEight.main, { count: 6, sides: 17, minimum: 0, maximum: 16 });
  assert.equal(fortyEight.secondary, null);

  const fiftyNine = createDicePool(59);
  assert.deepEqual(fiftyNine.main, { count: 6, sides: 19, minimum: 0, maximum: 18 });
  assert.deepEqual(fiftyNine.secondary, { count: 1, sides: 11, minimum: 0, maximum: 10 });
});

test("骰池期望值与上下界对所有换算表点数一致", () => {
  for (let points = 0; points <= 60; points += 1) {
    const pool = createDicePool(points);
    const expected = (pool.main?.count ?? 0) * ((pool.main?.sides ?? 1) - 1) / 2
      + ((pool.secondary?.sides ?? 1) - 1) / 2;
    assert.equal(expected, points, `${points} 点的骰池期望不匹配`);
    assert.equal(pool.minimum, 0);
    assert.equal(pool.maximum, points * 2);
    assert.ok((pool.main?.count ?? 0) <= 6);
    assert.ok((pool.secondary?.count ?? 0) <= 1);
  }
});

test("骰池投掷可复现并记录每颗骰子的结果", () => {
  const first = createRandomStream("dice-seed");
  const second = createRandomStream("dice-seed");
  const pool = createDicePool(33);
  const result = rollDicePool(pool, first);

  assert.deepEqual(result, rollDicePool(pool, second));
  assert.equal(result.main.length, 4);
  assert.ok(result.main.every((value) => value >= 0 && value <= 14));
  assert.ok(result.secondary >= 0 && result.secondary <= 10);
  assert.equal(result.total, result.main.reduce((sum, value) => sum + value, result.secondary));
});

test("骰池策略按使用规则向下取整，并把负平均值压到零", () => {
  const policy = createDiceRollPolicy();
  const stream = createRandomStream("policy-seed");
  const expectedStream = createRandomStream("policy-seed");

  assert.equal(policy.rollAroundMean(33.9, { randomStream: stream }), rollDice(33, expectedStream));
  assert.equal(policy.rollAroundMean(-2, { randomStream: stream }), 0);
  assert.equal(policy.id, "wod-dice-pool-int");
  assert.equal(policy.experimental, true);
});

test("非法骰池点数会被拒绝", () => {
  assert.throws(() => createDicePool(-1), /非负安全整数/);
  assert.throws(() => createDicePool(1.5), /非负安全整数/);
  assert.throws(() => createDicePool(Number.POSITIVE_INFINITY), /非负安全整数/);
});
