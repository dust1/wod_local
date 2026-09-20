import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { openDatabase, createRepository } from "../infrastructure/persistence/sqlite-repository.mjs";
import { loadCatalog, loadItems, listGeneratedFiles } from "../application/catalog-service.mjs";
import { addHeroResource, advanceHeroProfession, heroDetailDto, heroListDto, planDto, trainHeroAttribute, trainHeroAttributes, trainHeroSkills, upgradeHeroLevel } from "../application/hero-service.mjs";
import { attributeTrainingRangeChange } from "../game/formulas/training-cost.mjs";
import { runDungeon, runDungeonFloor, createDungeonExploration, deleteDungeonRun, listBattles, getBattleDetail, listDungeonRuns, getDungeonRunDetail } from "../application/battle-service.mjs";
import { hashPassword, validateCredentials, validateHeroInput, verifyPassword } from "../application/auth-service.mjs";
import { actionSettingsDto, actionSettingsToBattlePlan, normalizeActionSettings, saveActionSettings } from "../application/action-settings-service.mjs";
import { buildCharacterInstance } from "../application/character-instance-service.mjs";
import { itemCandidatesFor, validateSkillItemSelections } from "../application/skill-item-service.mjs";

const testRoot = mkdtempSync(join(tmpdir(), "local-wod-application-"));
const templatePath = resolve("tests", "fixtures", "runtime-template.sqlite");
let databaseSequence = 0;
let testDbPath;
let testReportPath;

function freshRepository() {
  databaseSequence += 1;
  testDbPath = join(testRoot, `runtime-${databaseSequence}.sqlite`);
  testReportPath = join(testRoot, `test-dungeon-report-${databaseSequence}`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${testDbPath}${suffix}`, { force: true });
  copyFileSync(templatePath, testDbPath);
  const db = openDatabase(testDbPath, { reportDirectory: testReportPath });
  return { db, repository: createRepository(db) };
}

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${testDbPath}${suffix}`, { force: true });
  rmSync(testReportPath, { recursive: true, force: true });
}

test("用户密码安全存储且英雄严格按账号隔离", () => {
  const { db, repository } = freshRepository();
  const credentials = validateCredentials("player_one", "secret-pass");
  const password = hashPassword(credentials.password);
  assert.notEqual(password.hash, credentials.password);
  assert.equal(verifyPassword(credentials.password, password.salt, password.hash), true);
  assert.equal(verifyPassword("wrong-pass", password.salt, password.hash), false);
  const first = repository.createUser({ username: credentials.username, passwordHash: password.hash, passwordSalt: password.salt });
  const secondPassword = hashPassword("another-pass");
  const second = repository.createUser({ username: "player_two", passwordHash: secondPassword.hash, passwordSalt: secondPassword.salt });
  const heroInput = validateHeroInput({ name: "新英雄", raceId: "dinturan", professionId: "adventurer", gender: "female" });
  const hero = repository.createHero(first.id, heroInput);
  assert.equal(repository.listHeroes(first.id).length, 1);
  assert.equal(repository.listHeroes(second.id).length, 0);
  assert.equal(repository.getHero(hero.id, second.id), undefined);
  assert.equal(hero.gender, "female");
  assert.equal(hero.current_experience, 300);
  assert.equal(hero.total_experience, 300);
  assert.equal(hero.gold, 1000);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_detail_metadata'").get());
  db.close();
  cleanup();
});

test("英雄详情包含八项属性、派生属性与技能明细", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const list = heroListDto(repository);
  assert.equal(list.length, 4);
  const active = list.find((hero) => hero.active);
  assert.ok(active);
  const detail = heroDetailDto(repository, active.id, catalog);
  assert.equal(detail.attributes.length, 8);
  assert.equal(detail.derived.healthMax, 1 + detail.attributes.find((a) => a.key === "constitution").effective * 3 + detail.attributes.find((a) => a.key === "strength").effective * 2);
  assert.equal(detail.derived.pocketSlots, 15);
  assert.equal(detail.derived.ringSlots, 4);
  assert.equal(detail.derived.medalSlots, 3);
  assert.ok(detail.derived.manaMax > 0);
  assert.ok(detail.derived.traces.healthMax.length > 0, "派生属性必须带计算步骤");
  assert.ok(detail.skills.length >= 4);
  assert.equal(detail.attackTypes.length, 13);
  assert.equal(detail.damageTypes.length, 18);
  // 战斗属性不再有硬编码兜底：未传入角色实例时是空表，并显式标注未应用实例。
  assert.equal(detail.effectSummary.instanceApplied, false);
  assert.deepEqual(detail.combatAttributes.armor, []);
  assert.deepEqual(detail.combatAttributes.attackBonuses, []);
  for (const skill of detail.skills) {
    assert.ok(skill.hasDefinition, `技能 ${skill.skillId} 缺少定义`);
    assert.ok(skill.baseTypeLabel);
  }
  const sword = detail.skills.find((skill) => skill.skillId === "basic-swordsmanship");
  // 攻击平均值 = 灵巧 × 2 + 敏捷 + 实时技能等级 × 2 = 12×2 + 14 + 4×2 = 46
  assert.equal(sword.attackMean, 46);
  assert.equal(sword.liveLevel, 4);
  db.close();
  cleanup();
});

test("设置方案 DTO 暴露层覆盖来源", () => {
  const { db, repository } = freshRepository();
  const plans = repository.listPlans(1);
  assert.ok(plans.length >= 2);
  const dto = planDto(plans[0]);
  assert.equal(dto.positionLabel, "右翼");
  assert.equal(dto.floorPlanPreview[1].source, "default");
  assert.equal(dto.floorPlanPreview[3].source, "floorOverride");
  assert.equal(dto.floorPlanPreview[3].position, "rear");
  db.close();
  cleanup();
});

test("角色行动设置以单个 JSON 对象按角色保存并规范化层覆盖", () => {
  const { db, repository } = freshRepository();
  const skillId = repository.listHeroSkills(1)[0].skill_id;
  const settings = normalizeActionSettings({
    defaultLayer: { position: "rear", actions: { initiative: [{ id: "i1", skillId, itemId: "item-42" }, { id: "i2", skillId }], preRound: [], mainRound: [{ id: "a1", skillId, repeat: "oncePerBattle", positions: [{ id: "rear", enabled: false }] }] } },
    floors: { 2: { override: true, actions: { initiative: [], preRound: [], mainRound: [] } }, 11: { override: true } },
  }, [skillId]);
  repository.upsertHeroActionSettings(1, settings);
  const restored = actionSettingsDto(repository.getHeroActionSettings(1));
  assert.equal(restored.defaultLayer.position, "rear");
  assert.equal(restored.defaultLayer.actions.initiative.length, 1);
  assert.equal(restored.defaultLayer.actions.initiative[0].itemId, "item-42");
  assert.equal(restored.defaultLayer.actions.mainRound[0].repeat, "oncePerBattle");
  assert.equal(restored.defaultLayer.actions.mainRound[0].positions.length, 6);
  assert.equal(restored.defaultLayer.actions.mainRound[0].positions[0].enabled, false);
  assert.equal(restored.floors[2].override, true);
  assert.equal(restored.floors[11], undefined);
  assert.ok(db.prepare("SELECT settings_json FROM hero_action_settings WHERE hero_id=1").get().settings_json.includes("mainRound"));
  db.close();
  cleanup();
});

test("角色行动设置拒绝保存未学习技能", () => {
  assert.throws(() => normalizeActionSettings({ defaultLayer: { actions: { initiative: [], preRound: [], mainRound: [{ skillId: "not-learned" }] } } }, ["known"]), /未学习/);
});

test("角色行动设置允许保存干等并转换为战斗指令", () => {
  const settings = normalizeActionSettings({
    defaultLayer: { actions: { mainRound: [{ id: "wait-1", skillId: "__wait__" }] } },
  }, ["known"]);
  const plan = actionSettingsToBattlePlan(settings, 1);
  assert.equal(plan.defaultPlan.mainRound[0].skillId, "__wait__");
});

/** 技能调用物品夹具：一个角色 + 基础：剑术（「物品」字段为「剑」，必选）。 */
function swordSkillHero(db, repository) {
  const user = repository.createUser({ username: `sword_${Math.random().toString(36).slice(2)}`, passwordHash: "h", passwordSalt: "s" });
  const hero = repository.createHero(user.id, { name: "剑客", professionId: "scholar", raceId: "gnome", gender: "female" });
  db.prepare("INSERT OR REPLACE INTO hero_skills (hero_id,skill_id,base_level,equipment_bonus) VALUES (?,?,?,?)").run(hero.id, "basic-swordsmanship", 3, 0);
  return { user, hero };
}

const swordAction = (itemId) => ({
  defaultLayer: { position: "rear", actions: { mainRound: [{ id: "m1", skillId: "basic-swordsmanship", itemId }] } },
});

test("技能调用物品候选来自已装备物品的物品类别", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const { user, hero } = swordSkillHero(db, repository);
  equipFixtureSword(db, hero.id);
  const instance = buildCharacterInstance({ repository, catalog, root: resolve("."), heroId: hero.id, userId: user.id });
  const detail = heroDetailDto(repository, hero.id, catalog, user.id, { instance });

  assert.deepEqual(instance.equippedItems[0].companionItemTypes, [], "角色实例 DTO 必须保留配合物品 tag");
  const skill = detail.actionSkills.find((entry) => entry.skillId === "basic-swordsmanship");
  assert.equal(skill.itemRequirement.itemTypeName, "剑");
  assert.equal(skill.itemRequirement.optional, false);
  assert.deepEqual(skill.itemRequirement.candidates.map((candidate) => candidate.itemId), [24058]);
  assert.equal(skill.itemRequirement.candidates[0].name, "赫伯特叔叔的旧剑");
  db.close();
  cleanup();
});

test("物品「需配合何物使用」为 `-` 时，生活：豪饮调用黑骑士的佐餐酒无需二次调用物品", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const user = repository.createUser({ username: `drinker_${Math.random().toString(36).slice(2)}`, passwordHash: "h", passwordSalt: "s" });
  const hero = repository.createHero(user.id, { name: "酒客", professionId: "scholar", raceId: "gnome", gender: "female" });
  // 生活：豪饮（skill-764）的「物品」字段是「饮料」，佐餐酒属于饮料。
  db.prepare("INSERT OR REPLACE INTO skills(id,name,base_type,attack_type,source_id) VALUES(?,?,?,?,?)").run("skill-764", "生活：豪饮", "improve", null, 764);
  db.prepare("INSERT OR REPLACE INTO hero_skills (hero_id,skill_id,base_level,equipment_bonus) VALUES (?,?,?,?)").run(hero.id, "skill-764", 3, 0);
  equipAssetItem(db, hero.id, { itemId: 32692, name: "黑骑士的佐餐酒", slot: "单手", jsonPath: "data/items/32692.json" });

  const instance = buildCharacterInstance({ repository, catalog, root: resolve("."), heroId: hero.id, userId: user.id });
  assert.deepEqual(instance.equippedItems[0].companionItemTypes, [], "`-` 占位值在角色实例 DTO 里必须等同于空集合");

  const detail = heroDetailDto(repository, hero.id, catalog, user.id, { instance });
  const skill = detail.actionSkills.find((entry) => entry.skillId === "skill-764");
  assert.equal(skill.itemRequirement.itemTypeName, "饮料");
  const candidate = skill.itemRequirement.candidates.find((entry) => entry.itemId === 32692);
  assert.ok(candidate, "已装备的佐餐酒必须出现在「饮料」候选里");
  assert.deepEqual(candidate.companionRequirements, [], "页面不应再渲染「配合物品（-）」下拉框");

  // 回归：以前这里会因为要求选择永远选不到的「配合物品（-）」而无法保存。
  const saved = saveActionSettings(repository, hero.id, {
    defaultLayer: { position: "rear", actions: { preRound: [{ id: "p1", skillId: "skill-764", itemIds: [32692] }] } },
  }, { catalog, root: resolve("."), userId: user.id });
  assert.deepEqual(saved.defaultLayer.actions.preRound[0].itemIds, ["32692"]);
  db.close();
  cleanup();
});

test("必选调用物品的技能留空时拒绝保存，选中已装备的对应物品后通过", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const { user, hero } = swordSkillHero(db, repository);
  equipFixtureSword(db, hero.id);
  const options = { catalog, root: resolve("."), userId: user.id };

  assert.throws(() => saveActionSettings(repository, hero.id, swordAction(null), options), /需要选择调用物品（剑）/);
  // 未装备对应物品时即使想选也选不到，因此留空同样被拒绝。
  assert.throws(() => saveActionSettings(repository, hero.id, swordAction(999), options), /已不在已装备的「剑」类物品中/);

  const saved = saveActionSettings(repository, hero.id, swordAction(24058), options);
  assert.equal(saved.defaultLayer.actions.mainRound[0].itemId, "24058");
  db.close();
  cleanup();
});

test("必选调用物品的技能在没有可装备物品时同样不允许留空保存", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const { user, hero } = swordSkillHero(db, repository);
  assert.throws(
    () => saveActionSettings(repository, hero.id, swordAction(null), { catalog, root: resolve("."), userId: user.id }),
    /当前没有已装备的该类物品/,
  );
  db.close();
  cleanup();
});

test("缺参数时保存入口直接拒绝，不静默跳过调用物品校验", () => {
  const { db, repository } = freshRepository();
  const { hero } = swordSkillHero(db, repository);
  assert.throws(() => saveActionSettings(repository, hero.id, swordAction(24058)), /需要 catalog 与 root/);
  db.close();
  cleanup();
});

test("标记为可选的调用物品技能允许留空，必选技能在同一层不允许", () => {
  const settings = normalizeActionSettings({
    defaultLayer: { actions: { mainRound: [{ id: "m1", skillId: "optional-skill" }, { id: "m2", skillId: "required-skill" }] } },
  });
  const requirementFor = (skillId) => skillId === "optional-skill"
    ? { itemTypeName: "灵素", optional: true, candidates: [], skillName: "仪式：冥想" }
    : { itemTypeName: "剑", optional: false, candidates: [], skillName: "基础：剑术" };

  const issues = validateSkillItemSelections({ settings, requirementFor });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /默认层「基础：剑术」需要调用物品（剑）/);
  assert.match(issues[0], /没有已装备的该类物品/);
});

test("调用物品按需配合 tag 生成二级候选并逐项校验", () => {
  const equippedItems = [
    { itemId: 18657, name: "黑骑士的长面包", itemTypes: ["剑"], companionItemTypes: ["饮料"] },
    { itemId: 7001, name: "清水", itemTypes: ["饮料"], companionItemTypes: [] },
  ];
  const candidates = itemCandidatesFor({ itemTypeName: "剑" }, equippedItems);
  assert.deepEqual(candidates[0].companionRequirements, [{
    itemTypeName: "饮料",
    candidates: [{ itemId: 7001, instanceId: null, name: "清水" }],
  }]);

  const requirementFor = () => ({ itemTypeName: "剑", optional: false, skillName: "派生：嗜血打击", candidates });
  const settingsFor = (itemIds) => normalizeActionSettings({
    defaultLayer: { actions: { mainRound: [{ id: "m1", skillId: "blood-strike", itemIds }] } },
  });
  assert.match(validateSkillItemSelections({ settings: settingsFor([18657]), requirementFor })[0], /需要选择配合物品（饮料）/);
  assert.match(validateSkillItemSelections({ settings: settingsFor([18657, 9999]), requirementFor })[0], /配合物品已不在已装备的「饮料」/);
  assert.deepEqual(validateSkillItemSelections({ settings: settingsFor([18657, 7001]), requirementFor }), []);
  assert.deepEqual(settingsFor([18657, 7001]).defaultLayer.actions.mainRound[0].itemIds, ["18657", "7001"]);
});

test("调用物品未定义配合 tag、配合 tag 为空时不生成二级选择要求", () => {
  const withoutField = itemCandidatesFor({ itemTypeName: "剑" }, [
    { itemId: 1, name: "普通剑", itemTypes: ["剑"] },
  ]);
  const emptyTags = itemCandidatesFor({ itemTypeName: "剑" }, [
    { itemId: 2, name: "另一把剑", itemTypes: ["剑"], companionItemTypes: ["", "  "] },
  ]);
  assert.deepEqual(withoutField[0].companionRequirements, []);
  assert.deepEqual(emptyTags[0].companionRequirements, []);
});

test("「需配合何物使用」为占位值 `-` 时与空集合等价，不生成二级选择要求", () => {
  // 物品 JSON 用 ["-"] 表示"无需配合物品"（真实资产 32692 黑骑士的佐餐酒就是这种写法）。
  const placeholder = itemCandidatesFor({ itemTypeName: "饮料" }, [
    { itemId: 32692, name: "黑骑士的佐餐酒", itemTypes: ["饮料"], companionItemTypes: ["-"] },
    { itemId: 7001, name: "清水", itemTypes: ["饮料"], companionItemTypes: ["-", "  ", ""] },
  ]);
  assert.deepEqual(placeholder.map((candidate) => candidate.companionRequirements), [[], []]);

  // 占位值不能被当成真实类别，也不能掩盖真正的配合要求。
  const mixed = itemCandidatesFor({ itemTypeName: "饮料" }, [
    { itemId: 8001, name: "带真正的配合要求", itemTypes: ["饮料"], companionItemTypes: ["-", "烟草"] },
  ]);
  assert.deepEqual(mixed[0].companionRequirements.map((entry) => entry.itemTypeName), ["烟草"]);

  // 服务端校验不能再要求选择「配合物品（-）」。
  const requirementFor = () => ({ itemTypeName: "饮料", optional: false, skillName: "生活：豪饮", candidates: placeholder });
  const settings = normalizeActionSettings({
    defaultLayer: { actions: { preRound: [{ id: "p1", skillId: "skill-764", itemIds: [32692] }] } },
  });
  assert.deepEqual(validateSkillItemSelections({ settings, requirementFor }), []);
});

test("属性训练在同一事务中修改基础值与已使用经验", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const before = heroDetailDto(repository, 1, catalog);
  const trained = trainHeroAttribute(repository, 1, "strength", 1, catalog);
  assert.equal(trained.attributes.find((entry) => entry.key === "strength").base, before.attributes.find((entry) => entry.key === "strength").base + 1);
  assert.equal(trained.currentExperience, before.currentExperience + trained.training.experienceChange);
  const refunded = trainHeroAttribute(repository, 1, "strength", -1, catalog);
  assert.equal(refunded.attributes.find((entry) => entry.key === "strength").base, before.attributes.find((entry) => entry.key === "strength").base);
  assert.equal(refunded.currentExperience, before.currentExperience);
  db.close();
  cleanup();
});

test("属性草稿一次性提交多点并在同一事务中扣除经验", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const before = heroDetailDto(repository, 1, catalog);
  const strength = before.attributes.find((entry) => entry.key === "strength");
  const agility = before.attributes.find((entry) => entry.key === "agility");
  const expected = attributeTrainingRangeChange(strength.base, strength.base + 1)
    + attributeTrainingRangeChange(agility.base, agility.base + 1);
  const result = trainHeroAttributes(repository, 1, [
    { key: "strength", value: strength.base + 1 },
    { key: "agility", value: agility.base + 1 },
  ], catalog);
  assert.equal(result.training.experienceChange, expected);
  assert.equal(result.currentExperience, before.currentExperience + expected);
  assert.equal(result.attributes.find((entry) => entry.key === "strength").base, strength.base + 1);
  assert.equal(result.attributes.find((entry) => entry.key === "agility").base, agility.base + 1);
  db.close();
  cleanup();
});

test("属性草稿经验不足时整批失败，不留下部分加点", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const before = heroDetailDto(repository, 1, catalog);
  const strength = before.attributes.find((entry) => entry.key === "strength");
  const agility = before.attributes.find((entry) => entry.key === "agility");
  // 两项单独都付得起，合计超过当前经验：原子提交必须两项都不落地。
  let strengthTarget = strength.base + 1;
  while (attributeTrainingRangeChange(strength.base, strengthTarget + 1) + before.currentExperience >= 0) strengthTarget += 1;
  assert.ok(attributeTrainingRangeChange(strength.base, strengthTarget) + before.currentExperience >= 0, "夹具需要力量单独可负担");
  const agilityTarget = agility.base + 1;
  assert.ok(attributeTrainingRangeChange(agility.base, agilityTarget) + before.currentExperience >= 0, "夹具需要敏捷单独可负担");
  const items = [{ key: "strength", value: strengthTarget }, { key: "agility", value: agilityTarget }];
  assert.throws(() => trainHeroAttributes(repository, 1, items, catalog), /当前经验不足/);
  const after = heroDetailDto(repository, 1, catalog);
  assert.equal(after.attributes.find((entry) => entry.key === "strength").base, strength.base);
  assert.equal(after.attributes.find((entry) => entry.key === "agility").base, agility.base);
  assert.equal(after.currentExperience, before.currentExperience);
  assert.throws(() => trainHeroAttributes(repository, 1, [], catalog), /没有需要提交的属性修改/);
  assert.throws(() => trainHeroAttributes(repository, 1, [{ key: "luck", value: 2 }], catalog), /未知属性/);
  assert.throws(() => trainHeroAttributes(repository, 1, [{ key: "strength", value: 0 }], catalog), /目标值无效/);
  assert.throws(() => trainHeroAttributes(repository, 1, [items[0], items[0]], catalog), /重复项目/);
  db.close();
  cleanup();
});

test("技能草稿一次性提交多个等级并原子扣除经验", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const professionId = repository.getHero(1).profession_id;
  db.prepare(`INSERT INTO profession_skills (id,profession_id,source_skill_id,skill_name,learn_level,training_class)
    VALUES (9001,?,9001,'测试基础技能',1,'basic'),(9002,?,9002,'测试附加技能',1,'additional')`).run(professionId, professionId);
  db.prepare("UPDATE heroes SET level=40,current_experience=1000000 WHERE id=1").run();
  const before = heroDetailDto(repository, 1, catalog);
  const available = before.learnableSkills.filter((skill) => skill.unlocked).slice(0, 2);
  assert.equal(available.length, 2);
  const result = trainHeroSkills(repository, 1, available.map((skill) => ({ sourceSkillId: skill.sourceSkillId, level: skill.currentLevel + 1 })), catalog);
  assert.deepEqual(result.training.changes.map((change) => change.sourceSkillId), available.map((skill) => skill.sourceSkillId));
  assert.equal(result.currentExperience, 1000000 + result.training.experienceChange);
  for (const skill of available) assert.equal(result.learnableSkills.find((entry) => entry.sourceSkillId === skill.sourceSkillId).currentLevel, skill.currentLevel + 1);

  db.prepare("UPDATE heroes SET current_experience=0 WHERE id=1").run();
  const levelsBeforeFailure = repository.listLearnableSkills(1).map((skill) => skill.current_level);
  assert.throws(() => trainHeroSkills(repository, 1, available.map((skill) => ({ sourceSkillId: skill.sourceSkillId, level: skill.currentLevel + 2 })), catalog), /当前经验不足/);
  assert.deepEqual(repository.listLearnableSkills(1).map((skill) => skill.current_level), levelsBeforeFailure, "失败时不得部分保存技能等级");
  db.close();
  cleanup();
});

test("21 级英雄首次进阶扣费，之后可免费切换", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  db.prepare("UPDATE heroes SET level=21,current_experience=10000,gold=30000 WHERE id=1").run();
  const professionId = repository.getHero(1).profession_id;
  db.prepare(`INSERT INTO profession_skills (id,profession_id,source_skill_id,skill_name,learn_level,training_class,advanced_profession_name)
    VALUES (9101,?,9101,'巡林技能',21,'special','巡林客'),(9102,?,9102,'追随者技能',21,'special','查桑追随者')`).run(professionId, professionId);
  const first = advanceHeroProfession(repository, 1, "巡林客", catalog);
  assert.equal(first.advancedProfession, "巡林客");
  assert.equal(first.currentExperience, 5000);
  assert.equal(first.gold, 10000);
  assert.ok(first.learnableSkills.some((skill) => skill.name === "巡林技能"));
  assert.ok(!first.learnableSkills.some((skill) => skill.name === "追随者技能"));
  const switched = advanceHeroProfession(repository, 1, "查桑追随者", catalog);
  assert.equal(switched.currentExperience, 5000);
  assert.equal(switched.gold, 10000);
  assert.throws(() => advanceHeroProfession(repository, 1, "黑袍法师", catalog), /不属于/);
  db.close();
  cleanup();
});

test("英雄资源补充同步增加经验、金币与荣誉并校验账号归属", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const before = repository.getHero(1);
  const withExperience = addHeroResource(repository, 1, "experience", 750, catalog);
  assert.equal(withExperience.currentExperience, before.current_experience + 750);
  assert.equal(withExperience.totalExperience, before.total_experience + 750);
  assert.equal(repository.getHero(1).experience, before.experience + 750);
  const withGold = addHeroResource(repository, 1, "gold", 125, catalog);
  assert.equal(withGold.gold, before.gold + 125);
  const withFame = addHeroResource(repository, 1, "fame", 50, catalog);
  assert.equal(withFame.fame, before.fame + 50);
  assert.throws(() => addHeroResource(repository, 1, "experience", 0, catalog), /1 到/);
  assert.throws(() => addHeroResource(repository, 1, "gold", 1.5, catalog), /整数/);
  assert.throws(() => addHeroResource(repository, 1, "mana", 1, catalog), /未知资源/);
  assert.throws(() => addHeroResource(repository, 1, "gold", 1, catalog, 99999), /英雄不存在/);
  db.close();
  cleanup();
});

test("英雄等级读取数据库并在达到累计总经验门槛后手动逐级提升", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  db.prepare("UPDATE heroes SET level=1,total_experience=900 WHERE id=1").run();
  assert.equal(heroDetailDto(repository, 1, catalog).level, 1);
  assert.equal(heroDetailDto(repository, 1, catalog).experienceProgress.canLevelUp, false);
  assert.throws(() => upgradeHeroLevel(repository, 1, catalog), /总经验不足/);

  db.prepare("UPDATE heroes SET total_experience=9000 WHERE id=1").run();
  const levelTwo = upgradeHeroLevel(repository, 1, catalog);
  assert.equal(levelTwo.level, 2);
  assert.equal(levelTwo.experienceProgress.canLevelUp, true, "超额经验仍需用户逐级确认升级");
  const levelThree = upgradeHeroLevel(repository, 1, catalog);
  assert.equal(levelThree.level, 3);
  assert.equal(levelThree.experienceProgress.canLevelUp, true);
  assert.equal(repository.getHero(1).level, 3);
  assert.throws(() => upgradeHeroLevel(repository, 1, catalog, 99999), /英雄不存在/);
  db.close();
  cleanup();
});

test("运行一层地城并持久化多场战斗", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const run = runDungeonFloor({
    repository,
    catalog,
    heroId: 1,
    dungeonId: "rowdy-tavern",
    planName: "林地巡猎",
    floorNumber: 1,
    seed: "app-test-seed",
  });
  assert.equal(run.error, undefined);
  assert.equal(run.dungeonName, "喧嚷的酒吧");
  assert.equal(run.battles.length, 2, "喧嚷的酒吧第 1 层包含两场战斗");
  assert.equal(run.result, "victory");
  for (const battle of run.battles) {
    assert.equal(battle.result, "victory");
  }
  // 第二场战斗从第一场继承体力与法力
  assert.ok(run.finalHero.health >= 0);
  assert.equal(listBattles(repository).length, 2);
  for (const row of repository.listBattleRuns()) {
    assert.match(row.json_path, /test-dungeon-report-\d+\/dungeon-[0-9a-f-]+\.json$/);
    assert.ok(existsSync(resolve(dirname(testDbPath), row.json_path)));
    assert.ok(Array.isArray(row.report.rounds));
    assert.equal("events" in row.report, false);
    assert.equal("input" in row.report, false);
  }
  assert.equal(readdirSync(testReportPath).filter((name) => name.endsWith(".json")).length, 1, "一次地城结算只写一个战报文件");
  assert.equal(new Set(repository.listBattleRuns().map((row) => row.json_path)).size, 1, "同次地城的单场索引共同指向一个文件");
  db.close();
  cleanup();
});

test("历史战斗只保存四阶段展示快照", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const run = runDungeonFloor({ repository, catalog, heroId: 1, dungeonId: "rowdy-tavern", floorNumber: 1, seed: "replay-seed" });
  const detail = getBattleDetail(repository, run.battles[0].battleId);
  assert.ok(detail.roundData.length > 0);
  assert.deepEqual(Object.keys(detail.roundData[0]), ["round", "preRound", "recovery", "initiative", "mainRound"]);
  assert.equal("events" in detail, false);
  assert.equal("input" in detail, false);
  db.close();
  cleanup();
});

test("删除单场战报时重写共用文件而不是删掉整份战报", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const run = runDungeonFloor({ repository, catalog, heroId: 1, dungeonId: "rowdy-tavern", floorNumber: 1, seed: "app-test-seed" });
  assert.equal(run.battles.length, 2, "喧嚷的酒吧第 1 层包含两场战斗");
  const [first, second] = run.battles.map((battle) => battle.battleId);
  const jsonPath = repository.getBattleRun(first).json_path;
  const filePath = resolve(dirname(testDbPath), jsonPath);

  const result = repository.deleteBattleRuns([first]);
  assert.deepEqual(result.deletedBattleIds, [first]);
  assert.deepEqual(result.removedReportFiles, [], "仍有战斗引用时不能删文件");
  assert.deepEqual(result.rewrittenReportFiles, [jsonPath]);
  assert.deepEqual(result.warnings, []);
  assert.equal(repository.getBattleRun(first), null);
  assert.ok(repository.getBattleRun(second), "同一次运行的其它战斗必须保留");
  assert.equal(new Set(repository.listBattleRuns().map((row) => row.json_path)).size, 1, "仍然只有一个展示文件");
  const document = JSON.parse(readFileSync(filePath, "utf8"));
  assert.deepEqual(document.battles.map((battle) => Number(battle.battleId)), [second], "重写后的文件只保留未删除的战斗");
  db.close();
  cleanup();
});

test("删除战报记录同时清理战斗战报与本地战报 JSON 文件", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const { user, leader } = explorationFixture(db, repository, catalog);
  const run = createDungeonExploration({ repository, catalog, userId: user.id, dungeonId: "rowdy-tavern", heroId: leader.id, maxFloor: 3, seed: "delete-run-seed" });
  const battleIds = (getDungeonRunDetail(repository, run.dungeonRunId, user.id).levels ?? [])
    .flatMap((level) => level.battles.map((battle) => battle.battleId));
  assert.equal(battleIds.length, run.battleCount);
  const rows = battleIds.map((battleId) => repository.getBattleRun(battleId, user.id));
  assert.ok(rows.every(Boolean), "待删除的战斗战报必须可读");
  const files = [...new Set(rows.map((row) => row.json_path))];
  assert.equal(files.length, 1, "一次运行的多次战斗共用一个展示文件");
  const filePaths = files.map((jsonPath) => resolve(dirname(testDbPath), jsonPath));
  assert.ok(filePaths.every((filePath) => existsSync(filePath)));
  const battlesBefore = repository.listBattleRuns().length;

  const result = deleteDungeonRun(repository, run.dungeonRunId, user.id);
  assert.equal(result.dungeonRunId, run.dungeonRunId);
  assert.deepEqual([...result.deletedBattleIds].sort((left, right) => left - right), [...battleIds].sort((left, right) => left - right));
  assert.deepEqual(result.removedReportFiles, files);
  assert.deepEqual(result.warnings, []);
  assert.equal(getDungeonRunDetail(repository, run.dungeonRunId, user.id), null);
  for (const battleId of battleIds) assert.equal(repository.getBattleRun(battleId, user.id), null, `战斗战报 ${battleId} 应已删除`);
  assert.ok(filePaths.every((filePath) => !existsSync(filePath)), "战报 JSON 文件必须一并删除");
  assert.equal(repository.listBattleRuns().length, battlesBefore - battleIds.length);
  assert.equal(listDungeonRuns(repository, 50, user.id).some((entry) => entry.dungeonRunId === run.dungeonRunId), false);

  // 重复删除与其它账号的删除都必须返回 null，不会波及别人的记录。
  const outsider = repository.createUser({ username: `outsider_${Math.random().toString(36).slice(2)}`, passwordHash: "h", passwordSalt: "s" });
  assert.equal(deleteDungeonRun(repository, run.dungeonRunId, outsider.id), null);
  assert.equal(deleteDungeonRun(repository, run.dungeonRunId, user.id), null);
  db.close();
  cleanup();
});

test("同一地城同一种子产生相同的展示结果", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const first = runDungeonFloor({ repository, catalog, heroId: 1, dungeonId: "woodland-path", floorNumber: 1, seed: "same-seed" });
  const second = runDungeonFloor({ repository, catalog, heroId: 1, dungeonId: "woodland-path", floorNumber: 1, seed: "same-seed" });
  assert.deepEqual(second.battles.map((battle) => battle.result), first.battles.map((battle) => battle.result));
  db.close();
  cleanup();
});

test("地城与英雄不存在时返回结构化错误", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  assert.equal(runDungeonFloor({ repository, catalog, heroId: 999, dungeonId: "rowdy-tavern" }).error, "heroNotFound");
  assert.equal(runDungeonFloor({ repository, catalog, heroId: 1, dungeonId: "missing" }).error, "dungeonNotFound");
  assert.equal(runDungeonFloor({ repository, catalog, heroId: 1, dungeonId: "rowdy-tavern", floorNumber: 7 }).error, "noEncounter");
  assert.equal(heroDetailDto(repository, 999, catalog), null);
  db.close();
  cleanup();
});

test("内容目录在缺少生成数据时仍可用并给出告警", () => {
  const catalog = loadCatalog({ generatedDir: "gamedata/__missing__" });
  assert.equal(catalog.contentVersion, "overrides-only");
  assert.ok(catalog.warnings.length > 0);
  assert.ok(catalog.skills.size >= 6);
  assert.ok(catalog.skills.get("basic-swordsmanship"));
  assert.ok(Array.isArray(listGeneratedFiles()));
});

test("人工校正按 sourceId 与 ETL 记录合并，并统一字段形状", () => {
  const catalog = loadCatalog();
  const sword = catalog.skills.get("basic-swordsmanship");
  assert.ok(sword);
  assert.equal(sword.sourceId, 140);
  // 生成记录被合并进校正记录，不再以 skill-140 重复出现
  assert.equal(catalog.skills.has("skill-140"), false);
  assert.ok(sword.generated, "应保留原始 ETL 记录以便对比");
  assert.equal(catalog.counts.overridesMergedBySourceId, 1);
  // 所有技能都必须具备引擎可无条件读取的字段
  for (const skill of catalog.skills.values()) {
    assert.ok(Array.isArray(skill.effects), `技能 ${skill.id} 缺少 effects 数组`);
    assert.ok(Array.isArray(skill.warnings), `技能 ${skill.id} 缺少 warnings 数组`);
    assert.ok(skill.timing, `技能 ${skill.id} 缺少 timing`);
    if (skill.unsupported) assert.equal(skill.baseType, null);
  }
  // 目标默认允许选择召唤物，修正必须留痕
  assert.equal(sword.target.allowSummons, true);
  assert.ok(sword.warnings.includes("target-allow-summons-corrected"));
});

test("物品索引按需加载，未加载时不占用启动成本", () => {
  const catalog = loadCatalog();
  // 只有人工校正的物品在启动时载入，ETL 的 12 MB 索引按需解析
  assert.equal(catalog.items.size, 3);
  assert.equal(catalog.counts.itemsLoaded, false);
  const items = loadItems(catalog);
  assert.ok(items.size > 1000, `物品索引过小: ${items.size}`);
  assert.equal(catalog.counts.itemsLoaded, true);
  // 重复调用不重复解析
  assert.equal(loadItems(catalog), items);
  // 人工校正物品在加载后仍然保留
  assert.ok(items.has("item-sword"));
});

test("运行整座地城并记录层与地城级事件", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const run = runDungeon({ repository, catalog, heroId: 1, dungeonId: "rowdy-tavern", planName: "林地巡猎", seed: "dungeon-run-seed" });
  assert.equal(run.error, undefined);
  assert.ok(run.dungeonRunId > 0);
  assert.ok(run.floorCount >= 1);
  assert.equal(run.levels.length, run.floorCount);
  assert.equal(run.levels[0].battles.length, 2);
  const types = run.events.map((event) => event.type);
  assert.ok(types.includes("LevelEnded"));
  assert.ok(types.includes("DungeonEnded"));
  const ended = run.events.find((event) => event.type === "DungeonEnded");
  assert.equal(ended.floorCount, run.floorCount);
  assert.equal(ended.battleCount, run.battleCount);
  // 地城级事件不混入单场展示快照。
  for (const battle of run.battles) {
    assert.ok(getBattleDetail(repository, battle.battleId).roundData.length > 0);
  }
  const listed = listDungeonRuns(repository);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].dungeonRunId, run.dungeonRunId);
  const detail = getDungeonRunDetail(repository, run.dungeonRunId);
  assert.equal(detail.levels.length, run.floorCount);
  assert.equal(detail.rendered.length, detail.events.length);
  assert.equal(getDungeonRunDetail(repository, 999999), null);
  db.close();
  cleanup();
});

test("地城运行在同种子下可复现", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const first = runDungeon({ repository, catalog, heroId: 1, dungeonId: "rowdy-tavern", seed: "same-dungeon-seed" });
  const second = runDungeon({ repository, catalog, heroId: 1, dungeonId: "rowdy-tavern", seed: "same-dungeon-seed" });
  assert.deepEqual(second.battles.map((battle) => battle.result), first.battles.map((battle) => battle.result));
  assert.deepEqual(second.events, first.events);
  assert.equal(second.result, first.result);
  db.close();
  cleanup();
});

test("唯一性账本区分已掉落与当前持有", () => {
  const { db, repository } = freshRepository();
  repository.markUniqueDropped("team", "team-1", "item-relic");
  assert.equal(repository.isUniqueDropped("team", "team-1", "item-relic"), true);
  repository.setUniqueHeld("team", "team-1", "item-relic", true);
  repository.setUniqueHeld("team", "team-1", "item-relic", false);
  // 摧毁后仍然无法再次获得正常掉落
  assert.equal(repository.isUniqueDropped("team", "team-1", "item-relic"), true);
  db.close();
  cleanup();
  assert.equal(existsSync(testDbPath), false);
});

/** 测试夹具：写入一把带「剑」类别的物品并直接装备到右手。 */
function equipFixtureSword(db, heroId) {
  db.prepare("INSERT OR REPLACE INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,1)").run(24058, "赫伯特叔叔的旧剑", "右手", 0, 40);
  db.prepare("INSERT OR REPLACE INTO item_detail_metadata(item_id,source_table,json_path,content_hash,parsed_at) VALUES(?,?,?,?,?)")
    .run(24058, "test", "tests/fixtures/item-category-sword.json", "sword", new Date().toISOString());
  const instanceId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(24058)").run().lastInsertRowid);
  db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,1,?)").run(heroId, instanceId, "right_hand");
  db.prepare("INSERT INTO hero_equipment(hero_id,equip_slot,item_instance_id) VALUES(?,?,?)").run(heroId, "right_hand", instanceId);
  return instanceId;
}

/** 测试夹具：把 data/items 里的真实物品资产直接装备到右手，用于覆盖真实 JSON 的字段写法。 */
function equipAssetItem(db, heroId, { itemId, name, slot, jsonPath }) {
  db.prepare("INSERT OR REPLACE INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,1)").run(itemId, name, slot, 0, 40);
  db.prepare("INSERT OR REPLACE INTO item_detail_metadata(item_id,source_table,json_path,content_hash,parsed_at) VALUES(?,?,?,?,?)")
    .run(itemId, "test", jsonPath, `asset-${itemId}`, new Date().toISOString());
  const instanceId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(?)").run(itemId).lastInsertRowid);
  db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,1,?)").run(heroId, instanceId, "right_hand");
  db.prepare("INSERT INTO hero_equipment(hero_id,equip_slot,item_instance_id) VALUES(?,?,?)").run(heroId, "right_hand", instanceId);
  return instanceId;
}

/** 探索用夹具：一个账号 + 两名角色（第二名已学技能、装备一把剑并带自定义行动设置）。 */
function explorationFixture(db, repository, catalog) {
  const user = repository.createUser({ username: `explorer_${Math.random().toString(36).slice(2)}`, passwordHash: "h", passwordSalt: "s" });
  const leader = repository.createHero(user.id, { name: "甲", professionId: "hunter", raceId: "woodlander", gender: "male" });
  const second = repository.createHero(user.id, { name: "乙", professionId: "scholar", raceId: "gnome", gender: "female" });
  db.prepare("INSERT OR REPLACE INTO hero_skills (hero_id,skill_id,base_level,equipment_bonus) VALUES (?,?,?,?)")
    .run(second.id, "basic-swordsmanship", 3, 0);
  equipFixtureSword(db, second.id);
  // 基础：剑术的「物品」字段为「剑」，必选，因此必须选中已装备的剑才能保存。
  saveActionSettings(repository, second.id, {
    defaultLayer: {
      position: "rear",
      actions: { mainRound: [{ id: "m1", skillId: "basic-swordsmanship", itemId: 24058, repeat: "repeatWhilePossible" }] },
    },
  }, { catalog, root: resolve("."), userId: user.id });
  return { user, leader, second };
}

test("探索使用账号全部角色与行动设置完成战斗结算并固化输入", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const { user, leader, second } = explorationFixture(db, repository, catalog);

  const run = createDungeonExploration({
    repository,
    catalog,
    userId: user.id,
    dungeonId: "rowdy-tavern",
    heroId: leader.id,
    maxFloor: 3,
    seed: "explore-seed",
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, "completed");
  assert.ok(["victory", "defeat", "draw"].includes(run.result));
  assert.ok(run.floorCount >= 1);
  assert.ok(run.battleCount >= 1);
  assert.ok(run.events.some((event) => event.type === "DungeonEnded"));
  assert.equal(run.seed, "explore-seed");
  // 战斗规则输入 = 账号全部角色 + 各自行动设置 + 地城
  assert.equal(run.partyCount, 2);
  assert.equal(run.input.party.length, 2);
  assert.equal(run.input.dungeon.id, "rowdy-tavern");
  assert.equal(run.input.maxFloor, 3);
  assert.equal(run.input.leaderHeroId, leader.id);
  const leaderEntry = run.input.party.find((member) => member.heroId === leader.id);
  const secondEntry = run.input.party.find((member) => member.heroId === second.id);
  assert.equal(leaderEntry.isLeader, true);
  assert.equal(secondEntry.isLeader, false);
  assert.equal(secondEntry.position, "rear");
  assert.equal(secondEntry.actionSummary.commandCounts.mainRound, 1);
  assert.ok(secondEntry.healthMax > 0);
  // 敌人配置来自所选地城
  assert.equal(run.input.encounters.battles.length, 2);
  assert.equal(run.input.encounters.battles[0].units.length, 1);
  const battles = listBattles(repository);
  assert.equal(battles.length, run.battleCount);
  const firstBattle = getBattleDetail(repository, battles.at(-1).battleId);
  const firstSnapshot = firstBattle.roundData[0].preRound.teams.attacker;
  assert.ok(firstSnapshot.some((event) => event.unitId === String(leader.id)));
  assert.ok(firstSnapshot.some((event) => event.unitId === String(second.id)));

  const listed = listDungeonRuns(repository, 20, user.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].dungeonRunId, run.dungeonRunId);
  assert.equal(listed[0].status, "completed");
  assert.equal(listed[0].partyCount, 2);
  assert.equal(listed[0].rewards.settled, true);
  db.close();
  cleanup();
});

test("探索记录的战斗规则输入不随之后的行动设置变更而漂移", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const { user, leader, second } = explorationFixture(db, repository, catalog);
  const run = createDungeonExploration({ repository, catalog, userId: user.id, dungeonId: "rowdy-tavern", heroId: leader.id, seed: "frozen-seed" });

  saveActionSettings(repository, second.id, {
    defaultLayer: { position: "front", actions: { mainRound: [] } },
  }, { catalog, root: resolve("."), userId: user.id });
  const detail = getDungeonRunDetail(repository, run.dungeonRunId, user.id);
  const frozen = detail.input.party.find((member) => member.heroId === second.id);
  assert.equal(frozen.position, "rear", "快照应保留创建时的站位");
  assert.equal(frozen.actionSummary.commandCounts.mainRound, 1, "快照应保留创建时的指令");
  db.close();
  cleanup();
});

test("探索在缺少角色、地城或遭遇配置时返回结构化错误", () => {
  const { db, repository } = freshRepository();
  const catalog = loadCatalog();
  const emptyUser = repository.createUser({ username: `empty_${Math.random().toString(36).slice(2)}`, passwordHash: "h", passwordSalt: "s" });
  assert.equal(createDungeonExploration({ repository, catalog, userId: emptyUser.id, dungeonId: "rowdy-tavern" }).error, "noHero");

  const { user, leader } = explorationFixture(db, repository, catalog);
  assert.equal(createDungeonExploration({ repository, catalog, userId: user.id, dungeonId: "missing" }).error, "dungeonNotFound");
  assert.equal(createDungeonExploration({ repository, catalog, userId: user.id, dungeonId: "turtle-beast" }).error, "noEncounter");
  assert.equal(createDungeonExploration({ repository, catalog, userId: user.id, dungeonId: "rowdy-tavern", heroId: 999999 }).error, "heroNotFound");
  // 别人的角色不能作为队长
  assert.equal(createDungeonExploration({ repository, catalog, userId: emptyUser.id, dungeonId: "rowdy-tavern", heroId: leader.id }).error, "noHero");
  db.close();
  cleanup();
});
