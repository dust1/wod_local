import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../infrastructure/persistence/sqlite-repository.mjs";
import {
  checkDatabaseContract,
  compareDatabaseSchema,
  inspectDatabaseSchema,
  loadDatabaseContract,
} from "../infrastructure/persistence/database-contract.mjs";

const contract = loadDatabaseContract(resolve("docs", "database-schema.json"));

test("runtime database and integration template match the documented schema", () => {
  for (const path of [resolve("data", "game.sqlite"), resolve("tests", "fixtures", "runtime-template.sqlite")]) {
    const db = openDatabase(path);
    try {
      assert.deepEqual(checkDatabaseContract(db, contract), { ok: true, errors: [], warnings: [] });
    } finally {
      db.close();
    }
  }
});

test("schema comparison rejects missing, extra, and changed definitions", () => {
  const db = openDatabase(resolve("tests", "fixtures", "runtime-template.sqlite"));
  const actual = inspectDatabaseSchema(db);
  db.close();

  const missing = structuredClone(actual);
  delete missing.heroes;
  assert.ok(compareDatabaseSchema(contract, missing).errors.some((error) => error.code === "missing-table"));

  const extra = structuredClone(actual);
  extra.unknown_table = { columns: [], indexes: [], foreignKeys: [] };
  assert.ok(compareDatabaseSchema(contract, extra).errors.some((error) => error.code === "unexpected-table"));

  const changed = structuredClone(actual);
  changed.heroes.columns[0].type = "TEXT";
  assert.ok(compareDatabaseSchema(contract, changed).errors.some((error) => error.code === "column-mismatch"));
});

test("opening a missing database fails without creating a file", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-wod-missing-db-"));
  const path = join(directory, "missing.sqlite");
  assert.throws(() => openDatabase(path), /Database not found/);
  rmSync(directory, { recursive: true, force: true });
});

test("a copied template remains isolated from the checked-in template", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-wod-contract-"));
  const path = join(directory, "copy.sqlite");
  copyFileSync(resolve("tests", "fixtures", "runtime-template.sqlite"), path);
  const db = openDatabase(path);
  assert.equal(checkDatabaseContract(db, contract).ok, true);
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("summon schema stores formulas as text and keeps action settings per definition", () => {
  const definitions = contract.tables.summon_definitions;
  assert.ok(definitions.columns.some((column) => column.name === "actions_per_round_expr" && column.type === "TEXT"));
  const columns = Object.fromEntries(definitions.columns.map((column) => [column.name, column]));
  for (const name of [
    "summon_level_expr", "strength_expr", "constitution_expr", "intelligence_expr",
    "dexterity_expr", "charisma_expr", "agility_expr", "perception_expr", "willpower_expr",
  ]) {
    assert.equal(columns[name]?.type, "TEXT", `${name} 必须以表达式文本存储`);
    assert.equal(columns[name]?.nullable, false, `${name} 不允许为空`);
  }
  const summonSkillColumns = contract.tables.summon_skills.columns.map((column) => column.name);
  assert.equal(summonSkillColumns.includes("archetype_id"), false, "技能元数据不应绑定具体召唤物");
  assert.equal(summonSkillColumns.includes("skill_level_expr"), false, "等级表达式属于召唤物技能分配关系");
  const assignment = contract.tables.summon_archetype_skills;
  assert.equal(assignment.columns.find((column) => column.name === "skill_level_expr")?.type, "TEXT");
  assert.ok(assignment.foreignKeys.some((foreignKey) => foreignKey.referencesTable === "summon_archetypes"));
  assert.ok(assignment.foreignKeys.some((foreignKey) => foreignKey.referencesTable === "summon_skills"));
  assert.ok(contract.tables.summon_action_settings.foreignKeys.some((foreignKey) => (
    foreignKey.columns[0] === "summon_definition_id"
    && foreignKey.referencesTable === "summon_definitions"
    && foreignKey.onDelete === "CASCADE"
  )));
});
