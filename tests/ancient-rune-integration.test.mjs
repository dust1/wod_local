import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, createRepository } from "../infrastructure/persistence/sqlite-repository.mjs";
import { buildCharacterInstance } from "../application/character-instance-service.mjs";
import { socketAncientRunes } from "../application/ancient-rune-service.mjs";
import { heroInventoryPageDto } from "../application/inventory-service.mjs";
import { attachCalledItemEffects, unitFromCharacterInstance } from "../application/battle-service.mjs";
import { ANCIENT_RUNE_COMBINATIONS } from "../gamedata/overrides/ancient-rune-combinations.mjs";
import { STARTER_SKILL_BY_ID } from "../gamedata/overrides/starter-content.mjs";
import { simulateBattle } from "../game/engine/simulate.mjs";
import { createUnit } from "../game/engine/unit.mjs";
import { verifyReplay } from "../game/replay/envelope.mjs";

const root = resolve(".");
const recipe = (name, size = 4) => ANCIENT_RUNE_COMBINATIONS.find((entry) => entry.name === name).variants[size];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "wod-rune-integration-"));
  const path = join(directory, "game.sqlite");
  copyFileSync(resolve("tests/fixtures/runtime-template.sqlite"), path);
  const db = openDatabase(path);
  const repository = createRepository(db);
  const user = repository.createUser({ username: "rune_test", passwordHash: "hash", passwordSalt: "salt" });
  const hero = repository.createHero(user.id, { name: "符文测试", raceId: "dinturan", professionId: "adventurer", gender: "male" });
  db.prepare("UPDATE heroes SET strength=50 WHERE id=?").run(hero.id);
  const relicItemId = 990001;
  db.prepare("INSERT INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,1)")
    .run(relicItemId, "测试传古遗物", "身体", 0, 99);
  db.prepare("INSERT INTO item_detail_metadata(item_id,source_table,json_path,content_hash,parsed_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)")
    .run(relicItemId, "test", "tests/fixtures/ancient-relic.json", "test");
  const relicInstanceId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(?)").run(relicItemId).lastInsertRowid);
  db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(hero.id, relicInstanceId);
  db.prepare("UPDATE skills SET name='战技：精准弩' WHERE id='basic-swordsmanship'").run();
  for (const id of ["basic-swordsmanship", "survival-bandage", "guard-stance"]) {
    db.prepare("INSERT INTO hero_skills(hero_id,skill_id,base_level,equipment_bonus) VALUES(?,?,4,0)").run(hero.id, id);
  }
  const catalog = { skills: new Map([
    ["basic-swordsmanship", { ...STARTER_SKILL_BY_ID["basic-swordsmanship"], name: "战技：精准弩", skillTypeNames: ["远程攻击"] }],
    ["survival-bandage", { ...STARTER_SKILL_BY_ID["survival-bandage"], skillTypeNames: ["治疗技能"] }],
    ["guard-stance", STARTER_SKILL_BY_ID["guard-stance"]],
  ]) };
  const grantRunes = (name, size = 4) => recipe(name, size).runeItemIds.map((itemId) => {
    const id = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(?)").run(itemId).lastInsertRowid);
    db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(hero.id, id);
    return id;
  });
  const instance = () => buildCharacterInstance({ repository, catalog, root, heroId: hero.id, userId: user.id });
  const close = () => { db.close(); rmSync(directory, { recursive: true, force: true }); };
  return { db, repository, user, hero, relicInstanceId, catalog, grantRunes, instance, close };
}

function relicPageItem(f, instanceId = f.relicInstanceId) {
  return heroInventoryPageDto(f.repository, root, f.hero.id, f.user.id, f.catalog).items.find((item) => item.instanceId === instanceId);
}

test("仓库镶嵌资料显示原有效果、符文实例、孔位和命中组合的两类追加效果", () => {
  const f = fixture();
  try {
    const original = relicPageItem(f);
    assert.equal(original.runeCapacity, 4);
    assert.deepEqual(original.runePolarities, ["阴性", "中性", "阳性"]);
    assert.deepEqual(original.baseHolderEffects, []);
    assert.deepEqual(original.baseTargetEffects, []);
    const ids = f.grantRunes("决心");
    const runes = heroInventoryPageDto(f.repository, root, f.hero.id, f.user.id, f.catalog).items.filter((item) => item.isAncientRune);
    assert.equal(runes.length, 4);
    socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, ids.reverse());
    const socketed = relicPageItem(f);
    assert.equal(socketed.runeCombination.name, "决心");
    assert.equal(socketed.runeStatus, "matched");
    assert.equal(socketed.socketedRuneNames.length, 4);
    assert.ok(socketed.runeHolderEffects.length > 0);
    assert.ok(socketed.runeTargetEffects.length > 0);
    assert.equal(heroInventoryPageDto(f.repository, root, f.hero.id, f.user.id, f.catalog).items.filter((item) => item.isAncientRune).length, 0);
  } finally { f.close(); }
});

test("四孔与五孔分别匹配三种极性，多极性遗物接受任一对应组合", () => {
  for (const [name, polarity, detailPath] of [
    ["回声", "阴性", "tests/fixtures/ancient-relic-yin.json"],
    ["泪", "中性", "tests/fixtures/ancient-relic.json"],
    ["凤凰", "阳性", "tests/fixtures/ancient-relic-yang.json"],
  ]) {
    const f = fixture();
    try {
      f.db.prepare("UPDATE item_detail_metadata SET json_path=? WHERE item_id=990001").run(detailPath);
      socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, f.grantRunes(name));
      assert.equal(relicPageItem(f).runeCombination.polarity, polarity);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    f.db.prepare("UPDATE item_detail_metadata SET json_path=? WHERE item_id=990001")
      .run("tests/fixtures/ancient-relic-five.json");
    socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, f.grantRunes("魔山", 5));
    const item = relicPageItem(f);
    assert.equal(item.runeCapacity, 5);
    assert.equal(item.runeCombination.name, "魔山");
    assert.equal(item.socketedRuneNames.filter((name) => name === "巨物").length, 2);
    assert.ok(item.runeHolderEffects.length > 0);
  } finally { f.close(); }
});

test("极性不符与未匹配的满孔组合保留镶嵌，但不增加效果", () => {
  for (const [name, status] of [["泪", "wrongPolarity"], ["魔山", "unmatched"]]) {
    const f = fixture();
    try {
      f.db.prepare("UPDATE item_detail_metadata SET json_path=? WHERE item_id=990001")
        .run("tests/fixtures/ancient-relic-yin.json");
      const ids = f.grantRunes(name);
      if (status === "unmatched") ids[3] = f.grantRunes("泪")[0];
      socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, ids);
      const item = relicPageItem(f);
      assert.equal(item.runeStatus, status);
      assert.equal(item.runeCombination, null);
      assert.deepEqual(item.runeHolderEffects, []);
      assert.deepEqual(item.runeTargetEffects, []);
    } finally { f.close(); }
  }
});

test("同名遗物不同实例分别保存组合，库存不足和重复实例提交均不修改状态", () => {
  const f = fixture();
  try {
    const second = Number(f.db.prepare("INSERT INTO item_instances(item_id) VALUES(990001)").run().lastInsertRowid);
    f.db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(f.hero.id, second);
    const ids = f.grantRunes("泪");
    assert.throws(() => socketAncientRunes(f.repository, root, f.hero.id, f.user.id, second, ids.slice(0, 3).concat(999999)), /符文/);
    assert.deepEqual(f.repository.getSocketedRuneItemIds(second), []);
    assert.throws(() => socketAncientRunes(f.repository, root, f.hero.id, f.user.id, second, [ids[0], ids[0]]), /重复/);
    assert.equal(f.repository.listHeroInventory(f.hero.id, f.user.id).length, 6);
    socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, ids);
    assert.equal(relicPageItem(f, f.relicInstanceId).runeCombination.name, "泪");
    assert.deepEqual(relicPageItem(f, second).socketedRuneItemIds, []);
    assert.throws(() => socketAncientRunes(f.repository, root, f.hero.id, f.user.id, second, ids), /符文/);
    assert.deepEqual(f.repository.getSocketedRuneItemIds(second), []);
  } finally { f.close(); }
});

test("镶嵌记录属于遗物实例，消耗角色符文；装备后角色实例获得符文效果，卸下后消失", () => {
  const f = fixture();
  try {
    const ids = f.grantRunes("泪");
    const result = socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, ids);
    assert.equal(result.combination.name, "泪");
    assert.equal(f.repository.listHeroInventory(f.hero.id, f.user.id).length, 1);
    assert.deepEqual(f.repository.getSocketedRuneItemIds(f.relicInstanceId), recipe("泪").runeItemIds);
    assert.throws(() => socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, ids));
    f.repository.moveItemToTeam(f.hero.id, f.user.id, f.relicInstanceId);
    assert.deepEqual(f.repository.getSocketedRuneItemIds(f.relicInstanceId), recipe("泪").runeItemIds);
    assert.equal(f.instance().equippedItems.length, 0);
    f.repository.moveItemToHero(f.user.id, f.hero.id, f.relicInstanceId);
    assert.equal(f.instance().skills.find((skill) => skill.skillId === "survival-bandage").effectBonuses.length, 0);
    f.repository.setItemEquipped(f.hero.id, f.user.id, f.relicInstanceId, true);
    const equipped = f.instance();
    assert.equal(equipped.equippedItems[0].runeCombination.name, "泪");
    assert.ok(equipped.skills.find((skill) => skill.skillId === "survival-bandage").effectBonuses.length > 0);
    assert.ok(equipped.skills.find((skill) => skill.skillId === "survival-bandage").effectBonuses[0].sources.some((source) => source.sourceLabel.startsWith("传古符文：")),
      JSON.stringify(equipped.skills.find((skill) => skill.skillId === "survival-bandage").effectBonuses));
    f.repository.setItemEquipped(f.hero.id, f.user.id, f.relicInstanceId, false);
    assert.equal(f.instance().skills.find((skill) => skill.skillId === "survival-bandage").effectBonuses.length, 0);
    assert.deepEqual(f.repository.getSocketedRuneItemIds(f.relicInstanceId), recipe("泪").runeItemIds);
    f.repository.clearSocketedRunes(f.hero.id, f.user.id, f.relicInstanceId);
    assert.deepEqual(f.repository.getSocketedRuneItemIds(f.relicInstanceId), []);
    assert.equal(f.repository.listHeroInventory(f.hero.id, f.user.id).length, 1);
  } finally { f.close(); }
});

test("无效符文和超出孔位的镶嵌在事务中回滚，不消耗库存", () => {
  const f = fixture();
  try {
    const ids = f.grantRunes("泪");
    assert.throws(() => socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId,
      [...ids.slice(0, 3), 999999]), /符文/);
    assert.deepEqual(f.repository.getSocketedRuneItemIds(f.relicInstanceId), []);
    assert.equal(f.repository.listHeroInventory(f.hero.id, f.user.id).length, 5);
    socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, ids);
    const extra = f.grantRunes("魔山")[0];
    assert.throws(() => socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, [extra]), /孔位/);
    assert.equal(f.repository.listHeroInventory(f.hero.id, f.user.id).some((row) => row.item_instance_id === extra), true);
    assert.deepEqual(f.repository.getSocketedRuneItemIds(f.relicInstanceId), recipe("泪").runeItemIds);
  } finally { f.close(); }
});

test("已装备遗物调用时把组合目标效果写入战斗计划和回放输入，并实时提高攻击", () => {
  const f = fixture();
  try {
    socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, f.grantRunes("决心"));
    f.repository.setItemEquipped(f.hero.id, f.user.id, f.relicInstanceId, true);
    const instance = f.instance();
    const plan = { defaultPlan: { position: "front", preRound: [{ skillId: "guard-stance", itemIds: [990001] }],
      mainRound: [{ skillId: "basic-swordsmanship" }] }, floorOverrides: {} };
    attachCalledItemEffects(plan, instance, f.catalog, f.repository, root);
    const runeEffects = plan.defaultPlan.preRound[0].itemEffects.filter((effect) => effect.sourceKind === "ancientRune");
    assert.ok(runeEffects.length > 0);
    assert.ok(runeEffects.some((effect) => effect.modifiers.some((modifier) => modifier.target?.type === "skillEffect")));
    assert.ok(runeEffects.every((effect) => String(effect.sourceId).includes(String(f.relicInstanceId))));
    const run = (battlePlan) => simulateBattle({
      initialState: { battleId: "rune-target-effect", floorNumber: 1, units: [unitFromCharacterInstance(f.hero, instance, "front"),
        createUnit({ id: "target", side: "defender", kind: "monster", position: "front", level: 2,
          attributes: { strength: 3, constitution: 20, intelligence: 3, dexterity: 3, charisma: 3, agility: 1, perception: 1, willpower: 3 },
          skills: {}, health: 9999, mana: 0 })], preRoundOrder: [] },
      battlePlans: { [String(f.hero.id)]: battlePlan, target: { defaultPlan: { position: "front", preRound: [], mainRound: [] }, floorOverrides: {} } },
      skills: Object.fromEntries(f.catalog.skills), randomSeed: "rune-target-effect", maxRounds: 1,
    });
    const baselinePlan = structuredClone(plan);
    baselinePlan.defaultPlan.preRound[0].itemEffects = [];
    const baseline = run(baselinePlan);
    const boosted = run(plan);
    const damage = (result) => result.events.find((event) => event.type === "DamageApplied" && event.actorId === String(f.hero.id)).amount;
    assert.ok(damage(boosted) > damage(baseline), `${damage(baseline)} -> ${damage(boosted)}`);
    assert.notEqual(boosted.replay.inputSnapshotHash, baseline.replay.inputSnapshotHash);
    assert.equal(verifyReplay(boosted.replay, boosted.events).ok, true);
  } finally { f.close(); }
});

function battleWithHero(unit, skillId, skillDefinition, health = null) {
  const hero = createUnit({ ...unit, health: health ?? unit.health, mana: 500 });
  const monster = createUnit({ id: "target", name: "训练木桩", side: "defender", kind: "monster", level: 3, position: "front",
    attributes: { strength: 8, constitution: 20, intelligence: 4, dexterity: 8, charisma: 4, agility: 1, perception: 1, willpower: 4 },
    skills: {}, health: 9999, mana: 0 });
  return simulateBattle({ initialState: { battleId: "rune-instance", floorNumber: 1, units: [hero, monster], preRoundOrder: [] },
    battlePlans: { [hero.id]: { defaultPlan: { position: "front", preRound: [],
      mainRound: skillDefinition.baseType === "heal" ? [] : [{ skillId }],
      healing: skillDefinition.baseType === "heal" ? { severe: [{ skillId }] } : {} }, floorOverrides: {} },
      target: { defaultPlan: { position: "front", preRound: [], mainRound: [] }, floorOverrides: {} } },
    skills: { [skillId]: skillDefinition }, randomSeed: "rune-instance-seed", maxRounds: 1 });
}

test("真实角色实例的符文技能效果提高攻击与治疗，不改变技能等级", () => {
  for (const [combination, skillId, eventType, heroHealth] of [
    ["洞悉", "basic-swordsmanship", "DamageApplied", null],
    ["泪", "survival-bandage", "HealingApplied", 10],
  ]) {
    const f = fixture();
    try {
      const plain = f.instance();
      const skill = f.catalog.skills.get(skillId);
      const baseline = battleWithHero(unitFromCharacterInstance(f.hero, plain, "front"), skillId, skill, heroHealth);
      socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, f.grantRunes(combination));
      f.repository.setItemEquipped(f.hero.id, f.user.id, f.relicInstanceId, true);
      const modifiedInstance = f.instance();
      const runeUnit = unitFromCharacterInstance(f.hero, modifiedInstance, "front");
      const withoutEffectBonus = structuredClone(runeUnit);
      withoutEffectBonus.skills[skillId].effectBonusTerms = [];
      const sameLevel = battleWithHero(withoutEffectBonus, skillId, skill, heroHealth);
      const modified = battleWithHero(runeUnit, skillId, skill, heroHealth);
      const event = (result) => result.events.find((entry) => entry.type === eventType && entry.actorId === String(f.hero.id));
      assert.ok(event(baseline), `${combination} 基准事件`);
      assert.ok(event(modified), `${combination} 符文事件`);
      assert.ok(event(modified).amount > event(sameLevel).amount, `${combination} 技能效果应增加${eventType === "HealingApplied" ? "治疗" : "伤害"}: ${event(sameLevel).amount} -> ${event(modified).amount}`);
      const attempted = (result) => result.events.find((entry) => entry.type === "SkillAttempted" && entry.skillId === skillId);
      assert.equal(attempted(modified).actionSnapshot.skillLevel, attempted(sameLevel).actionSnapshot.skillLevel);
    } finally { f.close(); }
  }
});

function incomingBattle(heroUnit) {
  const hero = createUnit({ ...heroUnit, health: 10, mana: 100 });
  const attacker = createUnit({ id: "attacker", name: "攻击木桩", side: "defender", kind: "monster", level: 10, position: "front",
    attributes: { strength: 80, constitution: 10, intelligence: 1, dexterity: 100, charisma: 1, agility: 40, perception: 30, willpower: 1 },
    skills: { "basic-swordsmanship": { baseLevel: 20 } }, health: 1000, mana: 0 });
  return simulateBattle({ initialState: { battleId: "rune-defense", floorNumber: 1, units: [hero, attacker], preRoundOrder: [] },
    battlePlans: { [hero.id]: { defaultPlan: { position: "front", preRound: [], mainRound: [] }, floorOverrides: {} },
      attacker: { defaultPlan: { position: "front", preRound: [], mainRound: [{ skillId: "basic-swordsmanship" }] }, floorOverrides: {} } },
    skills: { "basic-swordsmanship": STARTER_SKILL_BY_ID["basic-swordsmanship"] }, randomSeed: "rune-defense-seed", maxRounds: 1 });
}

test("真实角色实例的护甲和脆弱性减伤在战斗中生效，负脆弱性使受击者回血", () => {
  const f = fixture();
  try {
    const baseline = incomingBattle(unitFromCharacterInstance(f.hero, f.instance(), "front"));
    const baseHit = baseline.events.find((event) => event.type === "DamageApplied" && event.targetId === String(f.hero.id));
    assert.ok(baseHit?.amount > 0);
    socketAncientRunes(f.repository, root, f.hero.id, f.user.id, f.relicInstanceId, f.grantRunes("魔山"));
    f.repository.setItemEquipped(f.hero.id, f.user.id, f.relicInstanceId, true);
    const equipped = f.instance();
    const armor = equipped.combat.armor.find((row) => row.damageType === "切割伤害");
    const vulnerability = equipped.combat.vulnerability.find((row) => row.damageType === "切割伤害");
    assert.ok(armor.values[0] > 0);
    assert.ok(vulnerability.percents[0] < 0);
    const reduced = incomingBattle(unitFromCharacterInstance(f.hero, equipped, "front"));
    const reducedHit = reduced.events.find((event) => event.type === "DamageApplied" && event.targetId === String(f.hero.id));
    assert.ok(reducedHit.amount < baseHit.amount, `${baseHit.amount} -> ${reducedHit.amount}`);
    assert.ok(reducedHit.diagnostics.vulnerabilityRate < 1);

    f.db.prepare("UPDATE item_detail_metadata SET json_path=? WHERE item_id=990001")
      .run("tests/fixtures/ancient-relic-healing.json");
    const negative = f.instance();
    const healed = incomingBattle(unitFromCharacterInstance(f.hero, negative, "front"));
    const event = healed.events.find((entry) => entry.type === "HealingApplied" && entry.reason === "vulnerability");
    assert.ok(event, JSON.stringify(healed.events.filter((entry) => ["DamageApplied", "HealingApplied", "AttackResolved"].includes(entry.type))));
    assert.ok(event.amount > 0);
  } finally { f.close(); }
});
