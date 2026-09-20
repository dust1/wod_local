import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createRepository, openDatabase } from "../infrastructure/persistence/sqlite-repository.mjs";
import { loadCatalog } from "../application/catalog-service.mjs";
import {
  summonConfigDto,
  validateArchetypeInput,
  validateAssignmentInput,
  validateDefinitionInput,
} from "../application/summon-config-service.mjs";
import { saveSummonActionSettings, summonActionConfigDto } from "../application/summon-action-settings-service.mjs";
import { summonTemplateForCommand } from "../application/battle-service.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "local-wod-summon-config-"));
  const database = join(directory, "game.sqlite");
  copyFileSync(resolve("tests/fixtures/runtime-template.sqlite"), database);
  const db = openDatabase(database);
  return { directory, db, repository: createRepository(db), catalog: loadCatalog() };
}

function closeFixture({ directory, db }) {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}

test("召唤物配置可创建、修改、查询并级联删除形态", () => {
  const state = fixture();
  const { repository, catalog } = state;
  const input = validateArchetypeInput({ id: "forest-spirit", name: "森林精灵", description: "测试", active: true });
  repository.createSummonArchetype(input);
  repository.updateSummonArchetype(input.id, { name: "森林守护灵", description: "更新", active: true });
  const skill = [...catalog.skills.values()].find((entry) => entry.baseType === "summon");
  const item = repository.raw.prepare("SELECT id,name FROM items WHERE active=1 ORDER BY id LIMIT 1").get();
  const definitionInput = validateDefinitionInput(repository, input.id, {
    summonName: "一阶森林守护灵", tier: 1, summonSkillId: skill.id, recipeType: "direct",
    summonItemId: `item-${item.id}`, minSummonSkillLevel: 1, maxSummonSkillLevel: 5,
    summonLevelExpr: "summonSkillLevel", defaultPosition: "rear",
    attributes: Object.fromEntries(["strength", "constitution", "intelligence", "dexterity", "charisma", "agility", "perception", "willpower"].map((key) => [key, "1 + summonSkillLevel / 2"])),
  }, null, catalog);
  const definition = repository.createSummonDefinition(definitionInput);
  const dto = summonConfigDto(repository, catalog).archetypes[0];
  assert.equal(dto.name, "森林守护灵");
  assert.equal(dto.definitions[0].id, definition.id);
  assert.equal(dto.definitions[0].summonSkillName, skill.name);
  assert.equal(dto.definitions[0].summonItemName, item.name);
  assert.equal(repository.deleteSummonArchetype(input.id), 1);
  assert.equal(repository.getSummonDefinition(definition.id), undefined);
  closeFixture(state);
});

test("召唤物形态拒绝重叠区间、自引用等级公式和无效物品", () => {
  const state = fixture();
  const { repository, catalog } = state;
  repository.createSummonArchetype({ id: "wolf", name: "狼", description: "", active: true });
  const skill = [...catalog.skills.values()].find((entry) => entry.baseType === "summon");
  const item = repository.raw.prepare("SELECT id FROM items WHERE active=1 ORDER BY id LIMIT 1").get();
  const body = { summonName: "一阶狼", tier: 1, summonSkillId: skill.id, summonItemId: item.id, recipeType: "direct", minSummonSkillLevel: 1, maxSummonSkillLevel: 10, summonLevelExpr: "summonSkillLevel", attributes: Object.fromEntries(["strength", "constitution", "intelligence", "dexterity", "charisma", "agility", "perception", "willpower"].map((key) => [key, "1"])) };
  repository.createSummonDefinition(validateDefinitionInput(repository, "wolf", body, null, catalog));
  assert.throws(() => validateDefinitionInput(repository, "wolf", { ...body, summonName: "二阶狼", tier: 2, minSummonSkillLevel: 6 }, null, catalog), /区间.*重叠/);
  assert.throws(() => validateDefinitionInput(repository, "wolf", { ...body, summonLevelExpr: "summonLevel + 1" }, null, catalog), /不能引用自身/);
  assert.throws(() => validateDefinitionInput(repository, "wolf", { ...body, summonItemId: "item-999999999" }, null, catalog), /有效的召唤物品/);
  closeFixture(state);
});

test("召唤物技能通过关联表分配并校验技能等级表达式", () => {
  const state = fixture();
  const { repository } = state;
  repository.createSummonArchetype({ id: "sprite", name: "精灵", description: "", active: true });
  const result = repository.raw.prepare("INSERT INTO summon_skills(skill_name,skill_type) VALUES('自然发芽','自然魔法')").run();
  const summonSkillId = Number(result.lastInsertRowid);
  const entry = validateAssignmentInput(repository, "sprite", { summonSkillId, unlockSummonSkillLevel: 6, skillLevelExpr: "max(1, summonSkillLevel - 2)", sortOrder: 1 });
  repository.saveSummonSkillAssignment(entry);
  assert.equal(summonConfigDto(repository).archetypes[0].skills[0].skillLevelExpr, "max(1, summonSkillLevel - 2)");
  assert.throws(() => validateAssignmentInput(repository, "sprite", { summonSkillId, unlockSummonSkillLevel: 6, skillLevelExpr: "eval(1)" }), /未知函数/);
  assert.equal(repository.deleteSummonSkillAssignment("sprite", summonSkillId), 1);
  closeFixture(state);
});

test("生成目录的 skill/item 前缀 ID 可以保存召唤形态", () => {
  const state = fixture();
  const { repository, catalog } = state;
  repository.createSummonArchetype({ id: "nature-spirit", name: "自然树灵", description: "", active: true });
  const entry = validateDefinitionInput(repository, "nature-spirit", {
    id: null,
    summonName: "自然树灵",
    tier: 1,
    summonSkillId: "skill-2094",
    recipeType: "direct",
    mediumItemId: null,
    summonItemId: "item-34528",
    minSummonSkillLevel: 1,
    maxSummonSkillLevel: "",
    summonLevelExpr: "5",
    actionsPerRoundExpr: "1 + tier",
    defaultPosition: "rear",
    attributes: Object.fromEntries(["strength", "constitution", "intelligence", "dexterity", "charisma", "agility", "perception", "willpower"].map((key) => [key, "10"])),
  }, null, catalog);
  assert.equal(entry.summonSkillId, "skill-2094");
  assert.equal(entry.summonItemId, 34528);
  const created = repository.createSummonDefinition(entry);
  assert.equal(created.summon_skill_id, "skill-2094");
  assert.equal(created.summon_item_id, 34528);
  const template = summonTemplateForCommand(repository, {
    heroLevel: 30,
    skills: [{ skillId: "skill-2094", liveLevel: 8 }],
  }, "skill-2094", ["34528"]);
  assert.equal(template.name, "自然树灵");
  assert.equal(template.level, 5);
  assert.equal(template.attributes.strength, 10);
  assert.equal(template.actionsPerRoundExact, 2);
  assert.equal(summonTemplateForCommand(repository, { heroLevel: 30, skills: [{ skillId: "skill-2094", liveLevel: 8 }] }, "skill-2094", ["999"]), null);
  closeFixture(state);
});

test("召唤物行动设置只接受该召唤物关联的技能并可持久化", () => {
  const state = fixture();
  const { repository, catalog } = state;
  repository.createSummonArchetype({ id: "action-spirit", name: "行动精灵", description: "", active: true });
  const item = repository.raw.prepare("SELECT id FROM items WHERE active=1 ORDER BY id LIMIT 1").get();
  const summon = [...catalog.skills.values()].find((entry) => entry.baseType === "summon");
  const definition = repository.createSummonDefinition(validateDefinitionInput(repository, "action-spirit", {
    summonName: "行动精灵", tier: 1, summonSkillId: summon.id, summonItemId: item.id,
    recipeType: "direct", minSummonSkillLevel: 1, summonLevelExpr: "1",
    attributes: Object.fromEntries(["strength", "constitution", "intelligence", "dexterity", "charisma", "agility", "perception", "willpower"].map((key) => [key, "1"])),
  }, null, catalog));
  const assigned = repository.raw.prepare("INSERT INTO summon_skills(skill_name,skill_type) VALUES('精灵冲击','自然魔法')").run();
  const assignedId = Number(assigned.lastInsertRowid);
  repository.saveSummonSkillAssignment({ archetypeId: "action-spirit", summonSkillId: assignedId, unlockSummonSkillLevel: 1, skillLevelExpr: "1", sortOrder: 0, active: true });
  const input = { defaultLayer: { actions: { initiative: [], preRound: [], mainRound: [{ id: "a", skillId: String(assignedId), repeat: "normal", positions: [] }] } } };
  const saved = saveSummonActionSettings(repository, definition.id, input);
  assert.equal(saved.defaultLayer.actions.mainRound[0].skillId, String(assignedId));
  assert.equal(summonActionConfigDto(repository, resolve("."), definition.id).skills[0].skillId, String(assignedId));
  assert.throws(() => saveSummonActionSettings(repository, definition.id, { defaultLayer: { actions: { initiative: [], preRound: [], mainRound: [{ id: "bad", skillId: "999999", positions: [] }] } } }), /未学习的技能/);
  closeFixture(state);
});
