import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openDatabase, createRepository } from "../infrastructure/persistence/sqlite-repository.mjs";
import { loadCatalog } from "../application/catalog-service.mjs";
import { parseCharacterCard, renderCharacterCard } from "../game/domain/character-card.mjs";
import { applyCharacterCard, characterCardPreview, exportCharacterCard } from "../application/character-card-service.mjs";

const testRoot = mkdtempSync(join(tmpdir(), "local-wod-character-card-"));
const testDbPath = join(testRoot, "character-card.sqlite");
const templatePath = resolve("tests", "fixtures", "runtime-template.sqlite");
const root = resolve(".");

function freshRepository() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${testDbPath}${suffix}`, { force: true });
  copyFileSync(templatePath, testDbPath);
  const db = openDatabase(testDbPath);
  return { db, repository: createRepository(db) };
}

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${testDbPath}${suffix}`, { force: true });
}

// 一张最小人物卡：两行属性 + 技能、两件装备。
const SAMPLE_CARD = [
  "[table border=1]",
  "[tr][td][color=orange]力量[/color][/td][td]2[6][/td][td][skill:法术：魔法盾][/td][td]4[/td][/tr]",
  "[tr][td][color=orange]智力[/color][/td][td]10[42][/td][td][skill:典型的玛格—莫精灵][/td][td]3[/td][/tr]",
  "[tr][td][color=orange]英雄等级[/color][/td][td]40[/td][td][/td][td][/td][/tr]",
  "[tr][td][color=orange]耳[/color][/td][td colspan=3][item:+3魅力耳环]!:g0:[/td][/tr]",
  "[tr][td][color=orange]肩膀[/color][/td][td colspan=3][item:智慧布披肩][/td][/tr]",
  "[tr][td][color=orange]头[/color][/td][td colspan=3][item:角色没有的头盔]!:g0::g0:[/td][/tr]",
  "[/table]",
].join("\n");

test("人物卡解析识别属性、技能与装备三部分", () => {
  const parsed = parseCharacterCard(SAMPLE_CARD);
  assert.deepEqual(parsed.attributes.map((entry) => [entry.label, entry.base, entry.trained]), [["力量", 2, 6], ["智力", 10, 42]]);
  assert.deepEqual(parsed.derived.map((entry) => [entry.label, entry.base]), [["英雄等级", 40]]);
  assert.deepEqual(parsed.skills.map((entry) => [entry.label, entry.name, entry.level]), [["法术", "魔法盾", 4], ["", "典型的玛格—莫精灵", 3]]);
  assert.deepEqual(parsed.equipment.map((entry) => [entry.slotLabel, entry.name, entry.markerCount]), [
    ["耳", "+3魅力耳环", 1],
    ["肩膀", "智慧布披肩", 0],
    ["头", "角色没有的头盔", 2],
  ]);
});

test("人物卡解析忽略卡面占位文字并拒绝空内容", () => {
  const parsed = parseCharacterCard([
    "[table border=1]",
    "[tr][td][skill:每次地城探险得到的荣誉奖励][/td][td][/td][td][/td][td][/td][/tr]",
    "[tr][td][skill:+1][/td][td][/td][td][skill:强化：疾影][/td][td]6[8][/td][/tr]",
    "[/table]",
  ].join("\n"));
  assert.deepEqual(parsed.skills.map((entry) => entry.name), ["疾影"]);
  assert.equal(parsed.warnings.length, 2);
  assert.throws(() => parseCharacterCard("   "), /人物卡内容为空/);
  assert.throws(() => parseCharacterCard("没有表格"), /没有找到人物卡表格/);
});

test("人物卡生成与解析互为逆运算", () => {
  const hero = {
    attributes: [
      { label: "力量", base: 7, effective: 9 },
      { label: "智力", base: 13, effective: 20 },
    ],
    learnableSkills: [
      { name: "法术：魔法盾", currentLevel: 4 },
      { name: "典型的玛格—莫精灵", currentLevel: 3 },
    ],
  };
  const equipped = [
    { name: "宁静之冠", slotLabel: "头", equipSlot: "head", markerCount: 3 },
    { name: "+4体质之戒", slotLabel: "戒指", equipSlot: "ring:1", markerCount: 1 },
  ];
  const text = renderCharacterCard(hero, equipped);
  const parsed = parseCharacterCard(text);
  assert.deepEqual(parsed.attributes.map((entry) => [entry.label, entry.base, entry.trained]), [["力量", 7, 9], ["智力", 13, 20]]);
  assert.deepEqual(parsed.skills.map((entry) => [entry.name, entry.level]), [["魔法盾", 4], ["典型的玛格—莫精灵", 3]]);
  assert.deepEqual(parsed.equipment.map((entry) => [entry.slotLabel, entry.name, entry.markerCount]), [
    ["头", "宁静之冠", 3],
    ["戒指", "+4体质之戒", 1],
  ]);
});

/**
 * 测试夹具：等级 40 的学者 / 玛格—莫精灵。三件卡面装备都只需存在于物品表；
 * 其中两件位于角色仓库，第三件位于团队仓库，用来验证导入按优先级复用实例。
 *
 * 物品由夹具自己写入：测试库只建骨架，不导入 1.9 GB 源库的物品表。
 */
function cardFixture() {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const user = repository.createUser({ username: `card_${Math.random().toString(36).slice(2)}`, passwordHash: "h", passwordSalt: "s" });
  const hero = repository.createHero(user.id, { name: "卡面复制体", professionId: "scholar", raceId: "magmor-elf", gender: "male" });
  db.prepare("UPDATE heroes SET level=40, gold=1000000, fame=100000 WHERE id=?").run(hero.id);
  // 职业/种族技能关系表由 ETL 从源库导入；测试只补上卡面用到的两条。
  db.prepare(`INSERT OR REPLACE INTO profession_skills
    (id,profession_id,source_skill_id,skill_name,skill_type,learn_level,learn_type,training_class)
    VALUES(?,?,?,?,?,?,?,?)`).run(990001, "scholar", 539, "法术：魔法盾", "spell", 4, "basic", "additional");
  db.prepare(`INSERT OR REPLACE INTO race_skills
    (id,race_id,source_skill_id,skill_name,skill_type,learn_level,learn_type,training_class)
    VALUES(?,?,?,?,?,?,?,?)`).run(990002, "magmor-elf", 98, "典型的玛格—莫精灵", "talent", 22, "basic", "additional");
  const owned = {};
  const teamOwned = {};
  for (const [name, itemId, slot] of [["+3魅力耳环", 35018, "耳"], ["智慧布披肩", 16051, "肩膀"], ["角色没有的头盔", 99001, "头"]]) {
    db.prepare("INSERT OR IGNORE INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,1)").run(itemId, name, slot, 0, 40);
    db.prepare("INSERT OR REPLACE INTO item_detail_metadata(item_id,source_table,json_path,content_hash,parsed_at) VALUES(?,?,?,?,?)")
      .run(itemId, "test", "tests/fixtures/character-card-item.json", `card-${itemId}`, new Date().toISOString());
    const instanceId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(?)").run(itemId).lastInsertRowid);
    if (name === "角色没有的头盔") {
      db.prepare("INSERT INTO team_inventory(user_id,item_instance_id) VALUES(?,?)").run(user.id, instanceId);
      teamOwned[name] = instanceId;
    }
    else {
      db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(hero.id, instanceId);
      owned[name] = instanceId;
    }
  }
  return { db, repository, catalog, user, hero, owned, teamOwned };
}

test("人物卡导入预览把卡面与角色现状逐项对照", () => {
  const { db, repository, catalog, user, hero } = cardFixture();
  try {
    const preview = characterCardPreview(repository, hero.id, SAMPLE_CARD, catalog, user.id);

    assert.deepEqual(preview.attributes.map((entry) => [entry.label, entry.cardBase, entry.current, entry.changes]), [
      ["力量", 2, 1, true],
      ["智力", 10, 1, true],
    ]);
    assert.equal(preview.summary.attributeChanges, 2);
    assert.deepEqual(preview.skills.map((entry) => [entry.name, entry.cardLevel, entry.currentLevel]), [
      ["法术：魔法盾", 4, 0],
      ["典型的玛格—莫精灵", 3, 0],
    ]);
    assert.deepEqual(preview.equipment.map((entry) => [entry.name, entry.targetSlotId]), [
      ["+3魅力耳环", "ear"],
      ["智慧布披肩", "shoulder"],
      ["角色没有的头盔", "head"],
    ]);
    assert.deepEqual(preview.skippedEquipment, []);
    assert.equal(preview.summary.equipmentCount, 3);
    assert.equal(preview.summary.skippedEquipmentCount, 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("人物卡导入覆盖属性、技能与装备且不结算经验", () => {
  const { db, repository, catalog, user, hero, owned, teamOwned } = cardFixture();
  try {
    const before = repository.getHero(hero.id, user.id);

    const result = applyCharacterCard(repository, root, hero.id, SAMPLE_CARD, catalog, user.id);
    assert.equal(result.detail.attributes.find((entry) => entry.key === "strength").base, 2);
    assert.equal(result.detail.attributes.find((entry) => entry.key === "intelligence").base, 10);
    assert.equal(result.detail.currentExperience, before.current_experience, "导入不结算经验");
    assert.deepEqual(result.applied.equipped.map((entry) => entry.name).sort(), ["+3魅力耳环", "智慧布披肩", "角色没有的头盔"].sort());
    assert.deepEqual(result.applied.skipped, []);

    const equipped = repository.listHeroInventory(hero.id, user.id).filter((row) => row.is_equipped);
    assert.deepEqual(
      equipped.map((row) => [row.name, row.equip_slot]).sort(),
      [["+3魅力耳环", "ear"], ["智慧布披肩", "shoulder"], ["角色没有的头盔", "head"]].sort(),
    );
    assert.equal(owned["+3魅力耳环"], equipped.find((row) => row.name === "+3魅力耳环").item_instance_id);
    assert.equal(owned["智慧布披肩"], equipped.find((row) => row.name === "智慧布披肩").item_instance_id);
    assert.equal(teamOwned["角色没有的头盔"], equipped.find((row) => row.name === "角色没有的头盔").item_instance_id);
    assert.equal(repository.listTeamInventory(user.id).some((row) => row.item_instance_id === teamOwned["角色没有的头盔"]), false);

    const skillLevels = db.prepare("SELECT source_skill_id, level FROM hero_skill_levels WHERE hero_id=? ORDER BY source_skill_id").all(hero.id);
    assert.equal(skillLevels.length, 2);
    assert.ok(skillLevels.every((row) => row.level > 0));
  } finally {
    db.close();
    cleanup();
  }
});

test("人物卡导入跳过普通装备要求校验", () => {
  const { db, repository, catalog, user, hero } = cardFixture();
  try {
    // 先把角色降回 1 级：人物卡仍应直接穿戴有等级要求的物品。
    db.prepare("UPDATE heroes SET level=1 WHERE id=?").run(hero.id);
    const card = [
      "[table border=1]",
      "[tr][td][color=orange]耳[/color][/td][td colspan=3][item:+3魅力耳环][/td][/tr]",
      "[/table]",
    ].join("\n");
    const result = applyCharacterCard(repository, root, hero.id, card, catalog, user.id);
    assert.equal(result.applied.equipped.length, 1);
    assert.equal(result.applied.failed.length, 0);
    assert.equal(repository.listHeroInventory(hero.id, user.id).some((row) => row.is_equipped), true);
  } finally {
    db.close();
    cleanup();
  }
});

test("人物卡导入保留卡面多槽位序号，缺失物品直接跳过", () => {
  const { db, repository, catalog, user, hero } = cardFixture();
  try {
    const card = [
      "[table border=1]",
      "[tr][td][color=orange]英雄等级[/color][/td][td]17[/td][td][/td][td][/td][/tr]",
      "[tr][td][color=orange]口袋#24[/color][/td][td colspan=3][item:智慧布披肩][/td][/tr]",
      "[tr][td][color=orange]戒指#6[/color][/td][td colspan=3][item:+3魅力耳环][/td][/tr]",
      "[tr][td][color=orange]勋章#9[/color][/td][td colspan=3][item:本地不存在的勋章][/td][/tr]",
      "[/table]",
    ].join("\n");
    const result = applyCharacterCard(repository, root, hero.id, card, catalog, user.id);
    assert.equal(repository.getHero(hero.id, user.id).level, 17);
    assert.deepEqual(result.applied.equipped.map((entry) => entry.targetSlotId), ["pocket:24", "ring:6"]);
    assert.deepEqual(result.applied.skipped.map((entry) => entry.name), ["本地不存在的勋章"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("人物卡导入在两个仓库都没有物品时才按物品定义新建实例", () => {
  const { db, repository, catalog, user, hero } = cardFixture();
  try {
    db.prepare("INSERT INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,1)")
      .run(99100, "仅有定义的项链", "颈", 40, 40);
    const beforeCount = db.prepare("SELECT COUNT(*) count FROM item_instances WHERE item_id=99100").get().count;
    const card = [
      "[table border=1]",
      "[tr][td][color=orange]颈[/color][/td][td colspan=3][item:仅有定义的项链][/td][/tr]",
      "[/table]",
    ].join("\n");
    const result = applyCharacterCard(repository, root, hero.id, card, catalog, user.id);
    assert.equal(result.preview.equipment[0].inventorySource, "catalog");
    assert.equal(result.applied.equipped.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM item_instances WHERE item_id=99100").get().count, beforeCount + 1);
  } finally {
    db.close();
    cleanup();
  }
});

test("人物卡导出把角色现状写回 BBCode", () => {
  const { db, repository, catalog, user, hero } = cardFixture();
  try {
    applyCharacterCard(repository, root, hero.id, SAMPLE_CARD, catalog, user.id);
    const exported = exportCharacterCard(repository, root, hero.id, catalog, user.id);
    const reparsed = parseCharacterCard(exported.text);
    assert.equal(exported.name, "卡面复制体");
    assert.deepEqual(reparsed.attributes.map((entry) => [entry.label, entry.base]), [["力量", 2], ["体质", 1], ["智力", 10], ["灵巧", 1], ["魅力", 1], ["敏捷", 1], ["感知", 1], ["意志", 1]]);
    assert.deepEqual(reparsed.equipment.map((entry) => entry.name).sort(), ["+3魅力耳环", "智慧布披肩", "角色没有的头盔"].sort());
  } finally {
    db.close();
    cleanup();
  }
  assert.equal(existsSync(testDbPath), false);
});
