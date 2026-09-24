import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { ANCIENT_RUNE_ITEMS, ANCIENT_RUNE_COMBINATIONS } from "../gamedata/overrides/ancient-rune-combinations.mjs";
import { ancientRelicCapacity, matchingAncientRuneCombination } from "../game/domain/ancient-rune.mjs";
import { combatEffect } from "../application/battle-service.mjs";

test("遗物孔位、极性和重复符文按实例组合判定", () => {
  const relic = { "物品类别": ["传古遗物(阴性)", "传古遗物(中性)"], "详细属性": { "特性": "可以镶嵌4次" } };
  assert.deepEqual(ancientRelicCapacity(relic), { polarities: ["阴性", "中性"], capacity: 4 });
  const mountain = ANCIENT_RUNE_COMBINATIONS.find((entry) => entry.name === "魔山").variants[4].runeItemIds;
  assert.equal(matchingAncientRuneCombination(relic, mountain.slice().reverse()).name, "魔山");
  assert.equal(matchingAncientRuneCombination(relic, mountain.slice(0, 3)), null);
  assert.equal(matchingAncientRuneCombination(relic, [mountain[0], mountain[1], mountain[2], 999]), null);
  const positive = { ...relic, "物品类别": ["传古遗物(阳性)"] };
  assert.equal(matchingAncientRuneCombination(positive, mountain), null);
});

test("传古符文清单与组合效果文件逐一对应", () => {
  assert.equal(Object.keys(ANCIENT_RUNE_ITEMS).length, 20);
  for (const [name, itemId] of Object.entries(ANCIENT_RUNE_ITEMS)) {
    const detail = JSON.parse(readFileSync(new URL(`../data/items/${itemId}.json`, import.meta.url), "utf8"));
    assert.equal(detail["物品名称"], name);
    assert.deepEqual(detail["物品类别"], ["传古符文"]);
    assert.equal(detail["详细属性"]["特性"], "镶嵌材料");
  }

  assert.equal(ANCIENT_RUNE_COMBINATIONS.length, 30);
  const paths = new Set();
  for (const combination of ANCIENT_RUNE_COMBINATIONS) {
    assert.ok(["阴性", "中性", "阳性"].includes(combination.polarity));
    for (const [capacity, variant] of Object.entries(combination.variants)) {
      assert.equal(variant.runeItemIds.length, Number(capacity), combination.name);
      assert.ok(variant.runeItemIds.every((itemId) => Object.values(ANCIENT_RUNE_ITEMS).includes(itemId)), combination.name);
      assert.ok(!paths.has(variant.effectPath), variant.effectPath);
      paths.add(variant.effectPath);
      const effects = JSON.parse(readFileSync(new URL(`../${variant.effectPath}`, import.meta.url), "utf8"));
      assert.ok(Array.isArray(effects["作用在物品持有者上的效果"]), variant.effectPath);
      if (effects["作用在被此物品影响的目标上的效果"] != null) {
        assert.ok(Array.isArray(effects["作用在被此物品影响的目标上的效果"]), variant.effectPath);
      }
    }
  }
  assert.deepEqual(
    [...paths].sort(),
    readdirSync(new URL("../data/fuwen/", import.meta.url)).filter((name) => name.endsWith(".json")).map((name) => `data/fuwen/${name}`).sort(),
  );
  const mountain = ANCIENT_RUNE_COMBINATIONS.find((entry) => entry.name === "魔山");
  assert.deepEqual(mountain.variants[5].runeItemIds, [...mountain.variants[4].runeItemIds, ANCIENT_RUNE_ITEMS.巨物]);
});

test("符文目标护甲与伤害奖励的三档修正均可转换", () => {
  let armorCount = 0;
  let damageCount = 0;
  for (const combination of ANCIENT_RUNE_COMBINATIONS) {
    for (const variant of Object.values(combination.variants)) {
      const detail = JSON.parse(readFileSync(new URL(`../${variant.effectPath}`, import.meta.url), "utf8"));
      (detail["作用在被此物品影响的目标上的效果"] ?? []).forEach((record, index) => {
        if (!["护甲奖励", "伤害奖励"].includes(record["类型"])) return;
        const converted = combatEffect(record, "item", combination.name, index);
        assert.ok(converted.modifiers.length >= 3, `${variant.effectPath} 第 ${index + 1} 条`);
        assert.deepEqual([...new Set(converted.modifiers.map((modifier) => modifier.target.grade))], ["normal", "critical", "lethal"]);
        assert.ok(converted.modifiers.every((modifier) => modifier.target.damageType === record["伤害方式"] && modifier.target.attackType === record["攻击方式"]));
        if (record["类型"] === "护甲奖励") armorCount += 1;
        else damageCount += 1;
      });
    }
  }
  assert.equal(armorCount, 37);
  assert.equal(damageCount, 42);
});

test("符文目标技能效果奖励与技能等级奖励分开转换", () => {
  let count = 0;
  for (const combination of ANCIENT_RUNE_COMBINATIONS) {
    for (const variant of Object.values(combination.variants)) {
      const detail = JSON.parse(readFileSync(new URL(`../${variant.effectPath}`, import.meta.url), "utf8"));
      (detail["作用在被此物品影响的目标上的效果"] ?? []).forEach((record, index) => {
        if (record["类型"] !== "对技能效果的奖励") return;
        const converted = combatEffect(record, "item", combination.name, index);
        assert.ok(converted.modifiers.length > 0, `${variant.effectPath} 第 ${index + 1} 条`);
        assert.ok(converted.modifiers.every((modifier) => modifier.target.type === "skillEffect" && modifier.target.key === record["技能"]));
        count += 1;
      });
    }
  }
  assert.equal(count, 12);
});

test("61 条符文目标脆弱性保留三档范围和固定值与百分比单位", () => {
  let count = 0;
  for (const combination of ANCIENT_RUNE_COMBINATIONS) {
    for (const variant of Object.values(combination.variants)) {
      const detail = JSON.parse(readFileSync(new URL(`../${variant.effectPath}`, import.meta.url), "utf8"));
      (detail["作用在被此物品影响的目标上的效果"] ?? []).forEach((record, index) => {
        if (record["类型"] !== "对此种攻击方式，攻击类型伤害的脆弱性") return;
        const converted = combatEffect(record, "item", combination.name, index);
        assert.ok(converted.modifiers.length >= 3, `${variant.effectPath} 第 ${index + 1} 条`);
        assert.deepEqual([...new Set(converted.modifiers.map((modifier) => modifier.target.grade))], ["normal", "critical", "lethal"]);
        assert.ok(converted.modifiers.every((modifier) => modifier.target.type === "vulnerability"
          && modifier.target.damageType === record["伤害方式"] && modifier.target.attackType === record["攻击方式"]));
        count += 1;
      });
    }
  }
  assert.equal(count, 61);
});
