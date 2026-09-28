// 装备与仓库模块：迁移、初始物品表、装备/卸下、角色仓库 ↔ 团队仓库流转、角色删除与租户隔离。
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openDatabase, createRepository } from "../infrastructure/persistence/sqlite-repository.mjs";
import { equipSlotIdForItemSlot } from "../game/domain/item.mjs";
import { heroInventoryDto, heroInventoryPageDto, teamInventoryDto } from "../application/inventory-service.mjs";
import { applyHeroEquipment, equipHeroInventoryItem, heroEquipmentDto, itemEquipabilityConditions, validateItemEquipability } from "../application/equipment-service.mjs";
import { MARKET_ITEM_PRICE, marketDto, purchaseMarketItem } from "../application/market-service.mjs";
import { validateHeroInput } from "../application/auth-service.mjs";
import { deleteHero } from "../application/hero-service.mjs";
import { createBaseCharacter } from "../game/domain/attributes.mjs";
import { equippedItemPool } from "../application/character-instance-service.mjs";

/** 删除测试库；Windows 上 WAL 句柄释放略有延迟，因此带重试。 */
function removeDatabase(path) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      return;
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

const testDataDir = mkdtempSync(join(tmpdir(), "local-wod-inventory-"));
const templatePath = resolve("tests", "fixtures", "runtime-template.sqlite");

/** 每个用例使用独立数据库文件，避免 Windows 上句柄释放延迟导致的重建失败。 */
let databaseSequence = 0;
function freshRepository() {
  databaseSequence += 1;
  const path = resolve(testDataDir, `test-inventory-${databaseSequence}.sqlite`);
  try { removeDatabase(path); } catch { /* 旧文件残留不影响新建库 */ }
  copyFileSync(templatePath, path);
  const reportPath = resolve(testDataDir, `test-inventory-reports-${databaseSequence}`);
  const db = openDatabase(path, { reportDirectory: reportPath });
  return { db, path, reportPath, repository: createRepository(db) };
}

function cleanup(db, path) {
  try { db.close(); } catch { /* 已关闭 */ }
  try { removeDatabase(path); } catch { /* 句柄尚未释放，忽略 */ }
  const match = /test-inventory-(\d+)\.sqlite$/.exec(path);
  if (match) rmSync(resolve(testDataDir, `test-inventory-reports-${match[1]}`), { recursive: true, force: true });
}

/** 测试夹具：写入物品主数据与冒险者初始物品。 */
function seedItems(db) {
  const insertItem = db.prepare("INSERT OR REPLACE INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,1)");
  insertItem.run(9075, "普通的皮衣", "身体", 0, 40);
  insertItem.run(48030, "轻布手套", "手", 0, 40);
  insertItem.run(24058, "赫伯特叔叔的旧剑", "右手", 0, 40);
  insertItem.run(48034, "普通布护腿", "腿", 0, 40);
  insertItem.run(35753, "赫伯特叔叔的旧戒指", "戒指", 0, 40);
  insertItem.run(20668, "匕首", "单手", 0, 40);
  insertItem.run(9001, "测试分页物品A", "不可装备", 0, 40);
  const insertStarter = db.prepare("INSERT OR REPLACE INTO profession_starting_items(profession_id,item_id,quantity,equip_on_create) VALUES(?,?,?,1)");
  for (const itemId of [9075, 48030, 24058, 48034, 35753]) insertStarter.run("adventurer", itemId, 1);
}

/**
 * 显式给角色发一件物品，可选直接装备。
 * 新建角色不再自动获得或装备任何物品，需要物品的用例必须自己发放。
 */
function grantItem(db, heroId, itemId, { equipped = false } = {}) {
  const slot = db.prepare("SELECT slot FROM items WHERE id=?").get(itemId).slot;
  const slotId = equipSlotIdForItemSlot(slot);
  const canEquip = Boolean(equipped && slotId && !db.prepare("SELECT 1 FROM hero_equipment WHERE hero_id=? AND equip_slot=?").get(heroId, slotId));
  const instanceId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(?)").run(itemId).lastInsertRowid);
  db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,?,?)")
    .run(heroId, instanceId, canEquip ? 1 : 0, canEquip ? slotId : null);
  if (canEquip) db.prepare("INSERT INTO hero_equipment(hero_id,equip_slot,item_instance_id) VALUES(?,?,?)").run(heroId, slotId, instanceId);
  return instanceId;
}

/**
 * 发放一整套冒险者初始装备并全部装上（身体/手/右手/腿/戒指各一件）。
 * 这是历史 createHero 的行为，保留为测试夹具，供需要「已装备若干件」的用例复用。
 * @returns {number[]} 新增的物品实例 ID
 */
function grantStarterKit(db, heroId) {
  const starters = db.prepare(`SELECT psi.item_id,psi.quantity FROM profession_starting_items psi
    WHERE psi.profession_id='adventurer' ORDER BY psi.item_id`).all();
  const instances = [];
  for (const starter of starters) {
    for (let index = 0; index < starter.quantity; index += 1) {
      instances.push(grantItem(db, heroId, starter.item_id, { equipped: true }));
    }
  }
  return instances;
}

function createUser(db, repository, username) {
  return repository.createUser({ username, passwordHash: "hash", passwordSalt: "salt" });
}

test("市场统一以 1 金币出售物品并放入角色仓库", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "market_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "采购者", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const market = marketDto(repository, { query: "测试分页物品A" });
  assert.equal(MARKET_ITEM_PRICE, 1);
  assert.equal(market.items.length, 1);
  assert.equal(market.items[0].price, 1);
  assert.ok(market.filters.professions.length > 0);
  assert.ok(market.filters.races.length > 0);
  assert.ok(Array.isArray(market.filters.itemSets));
  const before = repository.getHero(hero.id, user.id).gold;
  const purchase = purchaseMarketItem(repository, { heroId: hero.id, userId: user.id, itemId: market.items[0].id });
  assert.equal(purchase.price, 1);
  assert.equal(repository.getHero(hero.id, user.id).gold, before - 1);
  assert.ok(heroInventoryDto(repository, hero.id, user.id).items.some((item) => item.instanceId === purchase.instanceId));
  cleanup(db, path);
});

test("角色仓库出售指定未装备实例并只增加 1 金币", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "seller");
  const otherUser = createUser(db, repository, "other_seller");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "卖家", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const otherHero = repository.createHero(otherUser.id, validateHeroInput({ name: "其他卖家", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const soldId = grantItem(db, hero.id, 9001);
  const keptId = grantItem(db, hero.id, 9001);
  const equippedId = grantItem(db, hero.id, 9075, { equipped: true });
  const otherId = grantItem(db, otherHero.id, 9001);
  const beforeGold = repository.getHero(hero.id, user.id).gold;
  const otherGold = repository.getHero(otherHero.id, otherUser.id).gold;

  assert.throws(() => repository.sellHeroInventoryItem(hero.id, user.id, equippedId), /装备状态/);
  assert.throws(() => repository.sellHeroInventoryItem(hero.id, user.id, otherId), /不在该角色仓库/);
  assert.throws(() => repository.sellHeroInventoryItem(otherHero.id, user.id, otherId), /英雄不存在/);
  assert.equal(repository.getHero(hero.id, user.id).gold, beforeGold);

  const result = repository.sellHeroInventoryItem(hero.id, user.id, soldId);
  assert.deepEqual(result, { instanceId: soldId, name: "测试分页物品A", price: 1, gold: beforeGold + 1 });
  assert.equal(db.prepare("SELECT 1 FROM item_instances WHERE id=?").get(soldId), undefined);
  assert.deepEqual(heroInventoryDto(repository, hero.id, user.id).items.map((item) => item.instanceId).sort((a, b) => a - b), [keptId, equippedId].sort((a, b) => a - b));
  assert.equal(repository.getHero(otherHero.id, otherUser.id).gold, otherGold);
  assert.throws(() => repository.sellHeroInventoryItem(hero.id, user.id, soldId), /不在该角色仓库/);
  assert.equal(repository.getHero(hero.id, user.id).gold, beforeGold + 1);
  cleanup(db, path);
});

test("市场按名称包含关系搜索，并保持结果总数与分页一致", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  db.prepare("INSERT OR REPLACE INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,?)")
    .run(99001, "测试分页物品B", "右手", 1, 40, 1);

  const firstPage = marketDto(repository, { query: "测试分页物品", limit: 1, offset: 0, slot: "头" });
  const secondPage = marketDto(repository, { query: "测试分页物品", limit: 1, offset: 1 });

  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.items.length, 1);
  assert.equal(secondPage.total, 2);
  assert.equal(secondPage.items.length, 1);
  assert.ok([...firstPage.items, ...secondPage.items].every((item) => item.name.includes("测试分页物品")));
  cleanup(db, path);
});

test("item.slot 映射到装备部位，单手使用派生部位", () => {
  assert.equal(equipSlotIdForItemSlot("右手"), "right_hand");
  assert.equal(equipSlotIdForItemSlot("身体"), "body");
  assert.equal(equipSlotIdForItemSlot("单手"), "one_hand");
  assert.equal(equipSlotIdForItemSlot("不可装备"), null);
  assert.equal(equipSlotIdForItemSlot(null), null);
});

test("新建角色不发放也不装备任何物品", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "equip_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "步鸟", raceId: "dinturan", professionId: "adventurer", gender: "male" }));

  // profession_starting_items 仍在库里（导入器需要它抓取详情页），但角色创建不再消费它。
  assert.ok(db.prepare("SELECT count(*) c FROM profession_starting_items WHERE profession_id='adventurer'").get().c > 0);
  const inventory = heroInventoryDto(repository, hero.id, user.id);
  assert.equal(inventory.items.length, 0, "新建角色不应获得任何物品");
  assert.equal(db.prepare("SELECT count(*) c FROM hero_equipment WHERE hero_id=?").get(hero.id).c, 0, "新建角色不应装备任何物品");
  assert.equal(db.prepare("SELECT count(*) c FROM hero_inventory WHERE hero_id=?").get(hero.id).c, 0);

  // 显式发放后才会有物品，并且装备/卸下流程照常工作。
  const swordInstance = grantItem(db, hero.id, 24058, { equipped: true });
  const granted = heroInventoryDto(repository, hero.id, user.id);
  assert.equal(granted.items.length, 1);
  const sword = granted.items[0];
  assert.equal(sword.instanceId, swordInstance);
  assert.equal(sword.equipSlotLabel, "右手");

  const afterUnequip = repository.setItemEquipped(hero.id, user.id, sword.instanceId, false);
  const unequippedSword = afterUnequip.find((row) => row.item_instance_id === sword.instanceId);
  assert.equal(unequippedSword.is_equipped, 0);
  assert.equal(unequippedSword.equip_slot, null);
  assert.equal(db.prepare("SELECT count(*) c FROM hero_equipment WHERE hero_id=?").get(hero.id).c, 0);

  // 重新装备：写回 equip_slot 与 is_equipped
  const afterEquip = repository.setItemEquipped(hero.id, user.id, sword.instanceId, true);
  const equippedSword = afterEquip.find((row) => row.item_instance_id === sword.instanceId);
  assert.equal(equippedSword.is_equipped, 1);
  assert.equal(equippedSword.equip_slot, "right_hand");
  assert.equal(db.prepare("SELECT count(*) c FROM hero_equipment WHERE hero_id=?").get(hero.id).c, 1);
  cleanup(db, path);
});

test("不可装备物品以及无实例的物品会被拒绝，异常不会留下脏数据", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "reject_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "试错者", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const junk = db.prepare("INSERT INTO item_instances(item_id) VALUES(9001)").run();
  db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(hero.id, Number(junk.lastInsertRowid));

  assert.throws(() => repository.setItemEquipped(hero.id, user.id, Number(junk.lastInsertRowid), true), /不可装备/);
  assert.throws(() => repository.setItemEquipped(hero.id, user.id, 999999, true), /物品不在该角色仓库/);
  assert.equal(db.prepare("SELECT count(*) c FROM hero_equipment WHERE item_instance_id=?").get(Number(junk.lastInsertRowid)).c, 0);
  cleanup(db, path);
});

test("同部位新装备顶替旧装备，旧实例回到角色仓库", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "swap_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "换装者", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  grantItem(db, hero.id, 24058, { equipped: true });
  const before = heroInventoryDto(repository, hero.id, user.id).items.find((item) => item.name === "赫伯特叔叔的旧剑");

  // 再授予一把右手武器
  const instanceId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(24058)").run().lastInsertRowid);
  db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(hero.id, instanceId);
  repository.setItemEquipped(hero.id, user.id, instanceId, true);

  const items = heroInventoryDto(repository, hero.id, user.id).items;
  assert.equal(items.find((item) => item.instanceId === instanceId).equipped, true, "新武器应处于装备状态");
  assert.equal(items.find((item) => item.instanceId === before.instanceId).equipped, false, "被顶替的旧武器应回到角色仓库");
  assert.equal(db.prepare("SELECT count(*) c FROM hero_equipment WHERE hero_id=? AND equip_slot='right_hand'").get(hero.id).c, 1, "右手部位只能有一件装备");
  assert.equal(items.length, 2, "实例数量不因换装变化");
  cleanup(db, path);
});

test("英雄唯一按角色、队伍唯一按账号限制已穿戴物品", () => {
  const { db, path, repository } = freshRepository();
  const owner = createUser(db, repository, "uniqueness_owner");
  const outsider = createUser(db, repository, "uniqueness_outsider");
  const first = repository.createHero(owner.id, validateHeroInput({ name: "角色甲", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const second = repository.createHero(owner.id, validateHeroInput({ name: "角色乙", raceId: "dinturan", professionId: "adventurer", gender: "female" }));
  const other = repository.createHero(outsider.id, validateHeroInput({ name: "角色丙", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const firstHeroUnique = grantItem(db, first.id, 31);
  const duplicateHeroUnique = grantItem(db, first.id, 31);
  const secondHeroUnique = grantItem(db, second.id, 31);
  repository.replaceHeroEquipment(first.id, owner.id, [{ slotId: "pocket:1", instanceId: firstHeroUnique }]);
  assert.throws(() => repository.replaceHeroEquipment(first.id, owner.id, [
    { slotId: "pocket:1", instanceId: firstHeroUnique }, { slotId: "pocket:2", instanceId: duplicateHeroUnique },
  ]), /英雄唯一/);
  repository.replaceHeroEquipment(second.id, owner.id, [{ slotId: "pocket:1", instanceId: secondHeroUnique }]);

  const firstTeamUnique = grantItem(db, first.id, 2);
  const secondTeamUnique = grantItem(db, second.id, 2);
  const otherTeamUnique = grantItem(db, other.id, 2);
  repository.replaceHeroEquipment(first.id, owner.id, [{ slotId: "pocket:1", instanceId: firstTeamUnique }]);
  assert.throws(() => repository.replaceHeroEquipment(second.id, owner.id, [{ slotId: "pocket:1", instanceId: secondTeamUnique }]), /队伍唯一/);
  assert.equal(repository.listHeroInventory(second.id, owner.id).find((row) => row.item_instance_id === secondTeamUnique).is_equipped, 0);
  repository.replaceHeroEquipment(other.id, outsider.id, [{ slotId: "pocket:1", instanceId: otherTeamUnique }]);
  repository.replaceHeroEquipment(first.id, owner.id, []);
  repository.replaceHeroEquipment(second.id, owner.id, [{ slotId: "pocket:1", instanceId: secondTeamUnique }]);
  cleanup(db, path);
});

test("物品详情的三类使用次数进入角色实例且不改动库存", () => {
  const { db, path, repository } = freshRepository();
  const user = createUser(db, repository, "item_limits_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "测试角色", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const instanceId = grantItem(db, hero.id, 82);
  repository.setItemEquipped(hero.id, user.id, instanceId, true);
  const item = equippedItemPool({ repository, root: resolve("."), heroId: hero.id, userId: user.id })
    .find((entry) => entry.instanceId === instanceId);
  assert.deepEqual(item.useLimits, { remainingCharges: null, usesPerDungeon: 2, usesPerBattle: 1 });
  assert.equal(repository.listHeroInventory(hero.id, user.id).length, 1);
  cleanup(db, path);
});

test("已装备物品必须先卸下才能转入团队仓库", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "team_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "移交者", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  grantStarterKit(db, hero.id);
  const sword = heroInventoryDto(repository, hero.id, user.id).items.find((item) => item.name === "赫伯特叔叔的旧剑");
  const heldBefore = heroInventoryDto(repository, hero.id, user.id).items.length;

  assert.throws(() => repository.moveItemToTeam(hero.id, user.id, sword.instanceId), /请先卸下装备/);
  assert.equal(teamInventoryDto(repository, user.id).items.length, 0, "失败的操作不应写入团队仓库");

  repository.setItemEquipped(hero.id, user.id, sword.instanceId, false);
  repository.moveItemToTeam(hero.id, user.id, sword.instanceId);
  assert.equal(teamInventoryDto(repository, user.id).items.length, 1);
  assert.equal(heroInventoryDto(repository, hero.id, user.id).items.length, heldBefore - 1, "转出后角色仓库不再持有该实例");

  // 再交给另一个角色，实例主键保持不变
  const second = repository.createHero(user.id, validateHeroInput({ name: "接手者", raceId: "dinturan", professionId: "adventurer", gender: "female" }));
  repository.moveItemToHero(user.id, second.id, sword.instanceId);
  const received = heroInventoryDto(repository, second.id, user.id).items.find((item) => item.itemId === sword.instanceId || item.instanceId === sword.instanceId);
  assert.ok(received, "接手角色应获得该实例");
  assert.equal(received.instanceId, sword.instanceId);
  assert.equal(received.equipped, false);
  assert.equal(teamInventoryDto(repository, user.id).items.length, 0);
  cleanup(db, path);
});

test("删除角色把名下全部物品转入团队仓库，且战报保留", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "delete_hero_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "退场者", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const equipped = grantStarterKit(db, hero.id);
  const loose = grantItem(db, hero.id, 20668);
  // 战报的 hero_id 是指向 heroes 的 NOT NULL 外键：删除角色不能连带毁掉战报。
  const battleId = repository.insertBattleRun({
    heroId: hero.id,
    report: { dungeonName: "测试地城", battleName: "测试", result: "victory", roundCount: 1, levelNumber: 1, rounds: [] },
  });

  const result = deleteHero(repository, hero.id, user.id);
  assert.equal(result.movedItemCount, equipped.length + 1, "已装备与未装备的物品都要转移");
  assert.deepEqual(result.heroes, [], "删除后账号内不应再有角色");

  // 角色从所有角色入口消失
  assert.equal(repository.getHero(hero.id, user.id), undefined);
  assert.deepEqual(repository.listHeroes(user.id), []);
  assert.equal(heroInventoryDto(repository, hero.id, user.id), null);
  assert.equal(heroInventoryPageDto(repository, resolve("."), hero.id, user.id), null);
  assert.throws(() => repository.deleteHero(hero.id, user.id), /英雄不存在/, "不能重复删除");

  // 物品实例没有被销毁，全部落在账号的团队仓库里
  const team = teamInventoryDto(repository, user.id).items;
  assert.equal(team.length, equipped.length + 1);
  assert.ok(team.some((item) => item.instanceId === loose), "未装备的物品也要移入团队仓库");
  assert.ok(equipped.every((instanceId) => team.some((item) => item.instanceId === instanceId)));
  assert.equal(db.prepare("SELECT count(*) c FROM item_instances").get().c, equipped.length + 1);
  assert.equal(db.prepare("SELECT count(*) c FROM hero_inventory WHERE hero_id=?").get(hero.id).c, 0);
  assert.equal(db.prepare("SELECT count(*) c FROM hero_equipment WHERE hero_id=?").get(hero.id).c, 0);

  // 战报按账号保留，仍能在战报列表里看到
  const battles = repository.listBattleRuns(20, user.id);
  assert.equal(battles.length, 1);
  assert.equal(battles[0].id, battleId);
  assert.equal(repository.getBattleRun(battleId, user.id).hero_id, hero.id, "战报仍保留原 hero_id");
  cleanup(db, path);
});

test("删除当前角色后自动选中账号内剩下的角色，且不能删除他人角色", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const owner = createUser(db, repository, "delete_owner");
  const stranger = createUser(db, repository, "delete_stranger");
  const first = repository.createHero(owner.id, validateHeroInput({ name: "首任", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const second = repository.createHero(owner.id, validateHeroInput({ name: "继任", raceId: "dinturan", professionId: "adventurer", gender: "female" }));
  assert.equal(repository.getHero(first.id, owner.id).active, 1);
  assert.equal(repository.getHero(second.id, owner.id).active, 0);

  // 他人无法删除：连角色都读不到
  assert.throws(() => repository.deleteHero(second.id, stranger.id), /英雄不存在/);
  assert.equal(repository.getHero(second.id, owner.id).active, 0, "越权删除不应改变当前角色");

  repository.deleteHero(first.id, owner.id);
  assert.equal(repository.getHero(second.id, owner.id).active, 1, "剩余角色应成为当前角色");
  // 已删除的角色既不能被激活，也不参与“取消当前角色”
  assert.equal(repository.activateHero(first.id, owner.id), false);
  assert.equal(repository.getHero(second.id, owner.id).active, 1);
  // 删光后新建的角色直接成为当前角色
  repository.deleteHero(second.id, owner.id);
  const third = repository.createHero(owner.id, validateHeroInput({ name: "新面孔", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  assert.equal(repository.getHero(third.id, owner.id).active, 1);
  assert.equal(repository.listHeroes(owner.id).length, 1, "已删除角色不应出现在角色列表");
  cleanup(db, path);
});

test("角色仓库按角色隔离，团队仓库按账号隔离", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const owner = createUser(db, repository, "owner_user");
  const stranger = createUser(db, repository, "stranger_user");
  const hero = repository.createHero(owner.id, validateHeroInput({ name: "本尊", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  const otherHero = repository.createHero(stranger.id, validateHeroInput({ name: "外人", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  grantStarterKit(db, hero.id);
  const sword = heroInventoryDto(repository, hero.id, owner.id).items.find((item) => item.name === "赫伯特叔叔的旧剑");

  // 角色仓库：别人的角色看不到，也无法操作
  assert.equal(repository.listHeroInventory(hero.id, stranger.id), null);
  assert.equal(heroInventoryDto(repository, hero.id, stranger.id), null);
  assert.throws(() => repository.moveItemToTeam(hero.id, stranger.id, sword.instanceId), /英雄不存在/);
  assert.throws(() => repository.setItemEquipped(hero.id, stranger.id, sword.instanceId, false), /英雄不存在/);

  // 团队仓库：只保存当前账号的物品
  repository.setItemEquipped(hero.id, owner.id, sword.instanceId, false);
  repository.moveItemToTeam(hero.id, owner.id, sword.instanceId);
  assert.equal(teamInventoryDto(repository, owner.id).items.length, 1);
  assert.equal(teamInventoryDto(repository, stranger.id).items.length, 0);
  assert.throws(() => repository.moveItemToHero(stranger.id, otherHero.id, sword.instanceId), /物品不在当前用户的团队仓库/);
  assert.equal(teamInventoryDto(repository, owner.id).items.length, 1, "越权操作不应改变归属");
  cleanup(db, path);
});

test("双手武器占用双手后不能继续装备单手物品", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  db.prepare("INSERT OR REPLACE INTO items(id,name,slot,min_level,max_level,active) VALUES(45327,'轻短弓','双手',0,40,1)").run();
  const user = createUser(db, repository, "hand_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "持弓者", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  grantStarterKit(db, hero.id);
  const sword = heroInventoryDto(repository, hero.id, user.id).items.find((item) => item.name === "赫伯特叔叔的旧剑");
  repository.setItemEquipped(hero.id, user.id, sword.instanceId, false);
  const bowId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(45327)").run().lastInsertRowid);
  db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(hero.id, bowId);
  const daggerId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(20668)").run().lastInsertRowid);
  db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(hero.id, daggerId);

  repository.setItemEquipped(hero.id, user.id, bowId, true);
  assert.throws(() => repository.setItemEquipped(hero.id, user.id, daggerId, true), /双手已被占用/);
  assert.equal(heroInventoryDto(repository, hero.id, user.id).items.find((item) => item.instanceId === daggerId).equipped, false);

  // 反过来也一样：手里有单手物品时无法装备双手物品
  repository.setItemEquipped(hero.id, user.id, bowId, false);
  repository.setItemEquipped(hero.id, user.id, daggerId, true);
  assert.throws(() => repository.setItemEquipped(hero.id, user.id, bowId, true), /需要空闲的双手/);
  assert.equal(heroInventoryDto(repository, hero.id, user.id).items.find((item) => item.instanceId === bowId).equipped, false);
  cleanup(db, path);
});

test("hero_equipment 与 hero_inventory 的装备状态保持一致", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "consistency_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "一致者", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  grantStarterKit(db, hero.id);
  const mismatches = db.prepare(`
    SELECT hi.item_instance_id FROM hero_inventory hi
    LEFT JOIN hero_equipment he ON he.hero_id=hi.hero_id AND he.item_instance_id=hi.item_instance_id
    WHERE hi.hero_id=? AND ((hi.is_equipped=1 AND he.item_instance_id IS NULL) OR (hi.is_equipped=0 AND he.item_instance_id IS NOT NULL)
      OR (hi.is_equipped=1 AND (hi.equip_slot IS NULL OR he.equip_slot<>hi.equip_slot)))
  `).all(hero.id);
  assert.deepEqual(mismatches, []);
  const equippedNames = db.prepare("SELECT i.name FROM hero_equipment he JOIN item_instances ii ON ii.id=he.item_instance_id JOIN items i ON i.id=ii.item_id WHERE he.hero_id=?").all(hero.id).map((row) => row.name);
  assert.equal(equippedNames.length, 5);
  cleanup(db, path);
});

test("装备页按槽位提供仓库选项，并一次性应用多件穿脱", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "equipment_page_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "整装者", raceId: "dinturan", professionId: "adventurer", gender: "female" }));
  grantStarterKit(db, hero.id);
  const before = heroEquipmentDto(repository, resolve("."), hero.id, user.id);
  assert.equal(before.slots.length, 37);
  assert.equal(before.slots.filter((slot) => slot.baseSlot === "pocket").length, 15);
  assert.equal(before.slots.filter((slot) => slot.baseSlot === "medal").length, 3);
  assert.equal(before.slots.filter((slot) => slot.baseSlot === "ring").length, 4);
  assert.equal(before.slots.find((slot) => slot.id === "ring:1").options.length, 1);
  assert.ok(before.slots.filter((slot) => ["ring:2", "ring:3", "ring:4"].includes(slot.id)).every((slot) => slot.options.length === 0));
  assert.ok(before.slots.filter((slot) => slot.column === "left").every((slot) => slot.baseSlot !== "pocket" && slot.baseSlot !== "ring"));
  assert.ok(before.slots.filter((slot) => slot.column === "right").every((slot) => slot.baseSlot === "pocket" || slot.baseSlot === "ring"));
  assert.ok(before.slots.find((slot) => slot.id === "body").options.some((item) => item.name === "普通的皮衣"));
  for (const slot of before.slots.filter((entry) => entry.selectedInstanceId != null)) {
    assert.ok(slot.options.some((item) => item.instanceId === slot.selectedInstanceId), `${slot.label}下拉必须显示当前装备`);
  }
  assert.equal(before.slots.find((slot) => slot.id === "head").options.length, 0);
  assert.deepEqual(validateItemEquipability({ hero, item: {}, itemDetail: {} }), { allowed: true, reasons: [] });

  const body = before.slots.find((slot) => slot.id === "body");
  const hand = before.slots.find((slot) => slot.id === "hand");
  const after = applyHeroEquipment(repository, resolve("."), hero.id, user.id, [
    { slotId: "body", instanceId: null },
    { slotId: "hand", instanceId: hand.selectedInstanceId },
  ]);
  assert.equal(after.slots.find((slot) => slot.id === "body").selectedInstanceId, null);
  assert.equal(after.slots.find((slot) => slot.id === "hand").selectedInstanceId, hand.selectedInstanceId);
  assert.equal(heroInventoryDto(repository, hero.id, user.id).items.find((item) => item.instanceId === body.selectedInstanceId).equipped, false);
  cleanup(db, path);
});

test("装备页忽略仅残留在 hero_inventory 标记中的幽灵装备并在提交时清理", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "ghost_equipment_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "清装者", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  grantStarterKit(db, hero.id);
  const ghost = db.prepare("SELECT item_instance_id FROM hero_inventory WHERE hero_id=? AND is_equipped=1 LIMIT 1").get(hero.id);
  db.prepare("DELETE FROM hero_equipment WHERE hero_id=? AND item_instance_id=?").run(hero.id, ghost.item_instance_id);
  assert.equal(db.prepare("SELECT is_equipped FROM hero_inventory WHERE hero_id=? AND item_instance_id=?").get(hero.id, ghost.item_instance_id).is_equipped, 1, "制造历史不一致记录");

  const before = heroEquipmentDto(repository, resolve("."), hero.id, user.id);
  assert.ok(before.slots.every((slot) => slot.selectedInstanceId !== ghost.item_instance_id), "幽灵装备不应进入装备草稿");
  applyHeroEquipment(repository, resolve("."), hero.id, user.id, []);
  const cleaned = db.prepare("SELECT is_equipped,equip_slot FROM hero_inventory WHERE hero_id=? AND item_instance_id=?").get(hero.id, ghost.item_instance_id);
  assert.equal(cleaned.is_equipped, 0);
  assert.equal(cleaned.equip_slot, null);
  cleanup(db, path);
});

test("装备页显示并保留人物卡导入的超容量及免校验装备", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "character_card_equipment_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "卡面装备者", raceId: "dinturan", professionId: "adventurer", gender: "male" }));
  db.prepare("INSERT OR REPLACE INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,1)").run(99991, "卡面超容量口袋物品", "口袋", 40, 40);
  const instanceId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(99991)").run().lastInsertRowid);
  db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,1,?)").run(hero.id, instanceId, "pocket:24");
  db.prepare("INSERT INTO hero_equipment(hero_id,equip_slot,item_instance_id) VALUES(?,?,?)").run(hero.id, "pocket:24", instanceId);

  const before = heroEquipmentDto(repository, resolve("."), hero.id, user.id);
  const slot = before.slots.find((entry) => entry.id === "pocket:24");
  assert.equal(slot.selectedInstanceId, instanceId);
  assert.ok(slot.options.some((item) => item.instanceId === instanceId), "免校验导入的当前装备必须显示在下拉框中");

  applyHeroEquipment(repository, resolve("."), hero.id, user.id, []);
  const retained = repository.listHeroInventory(hero.id, user.id).find((row) => row.item_instance_id === instanceId);
  assert.equal(retained.is_equipped, 1);
  assert.equal(retained.equip_slot, "pocket:24");
  cleanup(db, path);
});

test("明确的无装备需求标记不会被当作未知规则拒绝", () => {
  const hero = { heroLevel: 1, attributes: {}, skills: [] };
  for (const marker of ["无任何需求", "无", "-", ""]) {
    assert.deepEqual(validateItemEquipability({ hero, item: {}, itemDetail: { "装备要求": [marker] } }), { allowed: true, reasons: [] });
  }
  const unknown = validateItemEquipability({ hero, item: {}, itemDetail: { "装备要求": ["尚未实现的特殊条件"] } });
  assert.equal(unknown.allowed, false, "真正未知的条件仍应失败关闭");
});

test("换装提交使用卸下旧装备后的临时角色实例重新校验全部需求", () => {
  const { db, path, repository } = freshRepository();
  seedItems(db);
  const user = createUser(db, repository, "temporary_character_equip_user");
  const hero = repository.createHero(user.id, validateHeroInput({ name: "借力换装者", raceId: "dinturan", professionId: "adventurer", gender: "female" }));
  grantStarterKit(db, hero.id);
  const oldBody = heroInventoryDto(repository, hero.id, user.id).items.find((item) => item.name === "普通的皮衣");
  repository.setItemEquipped(hero.id, user.id, oldBody.instanceId, false);

  const insertItem = db.prepare("INSERT OR REPLACE INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,1)");
  insertItem.run(99001, "测试力量胸甲", "身体", 0, 40);
  insertItem.run(99002, "测试重型胸甲", "身体", 0, 40);
  const insertMetadata = db.prepare("INSERT OR REPLACE INTO item_detail_metadata(item_id,source_table,json_path,content_hash,parsed_at) VALUES(?,?,?,?,?)");
  insertMetadata.run(99001, "test", "tests/fixtures/equipment-strength-booster.json", "booster", new Date().toISOString());
  insertMetadata.run(99002, "test", "tests/fixtures/equipment-strength-required.json", "required", new Date().toISOString());
  const boosterId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(99001)").run().lastInsertRowid);
  const requiredId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(99002)").run().lastInsertRowid);
  const store = db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)");
  store.run(hero.id, boosterId);
  store.run(hero.id, requiredId);
  repository.setItemEquipped(hero.id, user.id, boosterId, true);

  const equipment = heroEquipmentDto(repository, resolve("."), hero.id, user.id);
  assert.ok(equipment.slots.find((slot) => slot.id === "body").options.some((item) => item.instanceId === requiredId), "当前加成后力量满足要求时应出现在下拉框");
  const inventoryPageWithBonus = heroInventoryPageDto(repository, resolve("."), hero.id, user.id);
  assert.equal(inventoryPageWithBonus.items.find((item) => item.instanceId === requiredId).canEquip, true, "角色仓库应使用当前角色实例启用装备按钮");
  assert.throws(() => equipHeroInventoryItem(repository, resolve("."), hero.id, user.id, requiredId), /测试重型胸甲穿戴失败.*力量需要至少 50/, "单件装备按钮也必须走卸下旧装备后的原子校验");
  assert.throws(() => applyHeroEquipment(repository, resolve("."), hero.id, user.id, [{ slotId: "body", instanceId: requiredId }]), /测试重型胸甲穿戴失败.*力量需要至少 50/);
  const after = heroInventoryDto(repository, hero.id, user.id).items;
  assert.equal(after.find((item) => item.instanceId === boosterId).equipped, true, "失败后旧装备必须保持穿戴");
  assert.equal(after.find((item) => item.instanceId === requiredId).equipped, false, "失败后新装备不得写入");
  repository.setItemEquipped(hero.id, user.id, boosterId, false);
  const inventoryPageWithoutBonus = heroInventoryPageDto(repository, resolve("."), hero.id, user.id);
  const reevaluated = inventoryPageWithoutBonus.items.find((item) => item.instanceId === requiredId);
  assert.equal(reevaluated.canEquip, false, "装备变化后重新读取页面必须使用最新角色实例");
  assert.match(reevaluated.equipabilityReasons.join("；"), /力量需要至少 50/);
  cleanup(db, path);
});

test("可装备性校验使用角色实例的加成属性、技能等级及职业限制", () => {
  const hero = {
    profession_name: "冒险者", race_name: "丁图安人", heroLevel: 8,
    attributes: { strength: { base: 4, effective: 7 } },
    skills: [{ name: "基础：剑术", liveLevel: 6 }],
  };
  const detail = {
    "详细属性": { "职业限制": "只适用于 冒险者", "种族限定": "任何种族都可使用该物品" },
    "职业限制": ["冒险者"], "种族限定": "任何种族都可使用该物品",
    "装备要求": ["力量至少为7", "力量(原始值)最高到4", "基础：剑术至少为6", "等级至少为8"],
  };
  assert.deepEqual(validateItemEquipability({ hero, item: { minLevel: 1, maxLevel: 40 }, itemDetail: detail }), { allowed: true, reasons: [] });
  const rejected = validateItemEquipability({ ...{ hero: { ...hero, profession_name: "野蛮人" }, item: {}, itemDetail: detail } });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reasons.join("；"), /职业要求/);
});

test("原始属性装备要求读取角色实例数组中的加点值而非加持值", () => {
  const hero = {
    heroLevel: 27,
    attributes: [
      { key: "intelligence", base: 10, effective: 8 },
      { key: "perception", base: 10, effective: 9 },
    ],
    skills: [], fame: 100000,
  };
  const rawRequirements = { "装备要求": ["智力(原始值)至少为10", "感知（原始值）至少为10"] };
  assert.deepEqual(validateItemEquipability({ hero, item: {}, itemDetail: rawRequirements }), { allowed: true, reasons: [] });
  const effectiveRequirement = validateItemEquipability({ hero, item: {}, itemDetail: { "装备要求": ["智力至少为10"] } });
  assert.equal(effectiveRequirement.allowed, false, "没有原始值标记时仍应使用装备和技能加持后的属性");
  assert.match(effectiveRequirement.reasons[0], /当前 8/);
});

test("联盟荣誉装备要求读取角色硬编码基础数值", () => {
  const hero = createBaseCharacter({ level: 27 });
  const result = validateItemEquipability({ hero, item: {}, itemDetail: { "装备要求": ["联盟荣誉至少为15000"] } });
  assert.deepEqual(result, { allowed: true, reasons: [] });
  assert.equal(hero.allianceFame, 999999);
});

test("装备要求可按物品类别统计当前实际装备的实例数量", () => {
  const requirement = { "装备要求": ["英雄必须装备书籍类别的至少3件物品"] };
  const hero = {
    heroLevel: 27, attributes: [], skills: [],
    equippedItems: [
      { instanceId: 1, itemTypes: ["书籍", "卷轴"] },
      { instanceId: 2, itemTypes: ["书籍"] },
      { instanceId: 3, itemTypes: ["书籍"] },
      { instanceId: 4, itemTypes: ["小型容器"] },
    ],
  };
  assert.deepEqual(validateItemEquipability({ hero, item: {}, itemDetail: requirement }), { allowed: true, reasons: [] });
  const rejected = validateItemEquipability({ hero: { ...hero, equippedItems: hero.equippedItems.slice(0, 2) }, item: {}, itemDetail: requirement });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reasons[0], /至少 3 件书籍类别物品（当前 2 件）/);
});

test("银色包袱的至少一件财宝物品要求识别已装备的宝石圣甲虫", () => {
  const detail = { "装备要求": ["英雄必须装备至少一件财宝物品"] };
  const item = { instanceId: 31581 };
  const hero = { heroLevel: 33, attributes: [], skills: [], equippedItems: [
    { instanceId: 31580, name: "宝石圣甲虫", itemTypes: ["传古符文", "财宝"] },
  ] };
  assert.deepEqual(validateItemEquipability({ hero, item, itemDetail: detail }), { allowed: true, reasons: [] });
  assert.deepEqual(itemEquipabilityConditions({ hero, itemDetail: detail }).requirements.map((entry) => entry.met), [true]);

  const withoutTreasure = { ...hero, equippedItems: [] };
  const rejected = validateItemEquipability({ hero: withoutTreasure, item, itemDetail: detail });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reasons[0], /财宝物品（当前 0 件）/);
  assert.deepEqual(itemEquipabilityConditions({ hero: withoutTreasure, itemDetail: detail }).requirements.map((entry) => entry.met), [false]);
});

test("物品类别装备上限按包含候选物品的换装结果计数且不重复计算已装备实例", () => {
  const detail = { "装备要求": ["英雄至多可以装备一件妖精物品"], "物品类别": ["妖精"] };
  const hero = { heroLevel: 27, attributes: [], skills: [], equippedItems: [] };
  assert.deepEqual(validateItemEquipability({ hero, item: { instanceId: 10 }, itemDetail: detail }), { allowed: true, reasons: [] });

  const withOtherFairy = { ...hero, equippedItems: [{ instanceId: 9, itemTypes: ["妖精"] }] };
  const rejected = validateItemEquipability({ hero: withOtherFairy, item: { instanceId: 10 }, itemDetail: detail });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reasons[0], /至多可以装备 1 件妖精物品（换装后 2 件）/);

  const alreadyEquipped = { ...hero, equippedItems: [{ instanceId: 10, itemTypes: ["妖精"] }] };
  assert.deepEqual(validateItemEquipability({ hero: alreadyEquipped, item: { instanceId: 10 }, itemDetail: detail }), { allowed: true, reasons: [] });
});

test("装备要求可按具体物品名称统计已装备实例", () => {
  const detail = { "物品名称": "万千教育法论述", "装备要求": ["英雄必须装备至少1件老学究的眼镜", "英雄必须装备至少一件崇高教育者披风"] };
  const hero = {
    heroLevel: 27, attributes: [], skills: [],
    equippedItems: [
      { instanceId: 87, name: "老学究的眼镜", itemTypes: ["眼镜"] },
      { instanceId: 91, name: "崇高教育者披风", itemTypes: ["盔甲"] },
    ],
  };
  assert.deepEqual(validateItemEquipability({ hero, item: { instanceId: 96 }, itemDetail: detail }), { allowed: true, reasons: [] });
  const missingCloak = validateItemEquipability({ hero: { ...hero, equippedItems: hero.equippedItems.slice(0, 1) }, item: { instanceId: 96 }, itemDetail: detail });
  assert.equal(missingCloak.allowed, false);
  assert.match(missingCloak.reasons[0], /崇高教育者披风（当前 0 件）/);
});

test("装备要求支持物品名称互斥条件", () => {
  const detail = {
    "物品名称": "克罗特的推理",
    "装备要求": [
      "物品奇洛特的大衣不能被同时装备",
      "物品 奇洛特的手套 不能被同时装备",
      "物品奇洛特的探知之心不能被同时装备",
    ],
  };
  const hero = {
    heroLevel: 28,
    attributes: [],
    skills: [],
    equippedItems: [{ instanceId: 164, name: "无关物品", itemTypes: ["戒指"] }],
  };
  assert.deepEqual(validateItemEquipability({ hero, item: { instanceId: 165 }, itemDetail: detail }), { allowed: true, reasons: [] });

  const conflictingHero = {
    ...hero,
    equippedItems: [...hero.equippedItems, { instanceId: 166, name: "奇洛特的手套", itemTypes: ["手套"] }],
  };
  const rejected = validateItemEquipability({ hero: conflictingHero, item: { instanceId: 165 }, itemDetail: detail });
  assert.equal(rejected.allowed, false);
  assert.deepEqual(rejected.reasons, ["不能与物品奇洛特的手套同时装备"]);

  const conditions = itemEquipabilityConditions({ hero: conflictingHero, itemDetail: detail });
  assert.deepEqual(conditions.requirements.map((entry) => entry.met), [true, false, true]);
});

test("物品详情逐条返回职业、种族与装备要求的满足状态", () => {
  const result = itemEquipabilityConditions({
    hero: {
      profession_name: "冒险者", race_name: "丁图安人", heroLevel: 8,
      attributes: { strength: { base: 4, effective: 7 }, constitution: { base: 3, effective: 3 } },
      skills: [{ name: "基础：剑术", liveLevel: 6 }],
    },
    itemDetail: {
      "详细属性": { "职业限制": "只适用于 冒险者", "种族限定": "只适用于 林地人" },
      "职业限制": ["冒险者"], "种族限定": "只适用于 林地人",
      "装备要求": ["力量至少为7", "体质至少为5", "基础：剑术至少为6"],
    },
  });
  assert.deepEqual(result.profession.map((entry) => entry.met), [true]);
  assert.deepEqual(result.race.map((entry) => entry.met), [false]);
  assert.deepEqual(result.requirements.map((entry) => entry.met), [true, false, true]);
});
