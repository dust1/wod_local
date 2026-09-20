import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const normalizedType = (value) => String(value ?? "").trim().toUpperCase();
const stable = (value) => JSON.stringify(value);

export function loadDatabaseContract(contractPath = resolve("docs", "database-schema.json")) {
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  if (contract?.formatVersion !== 1) throw new Error(`Unsupported database contract format: ${contract?.formatVersion}`);
  if (!Number.isInteger(contract.databaseFormatVersion)) throw new Error("databaseFormatVersion must be an integer");
  if (!contract.tables || typeof contract.tables !== "object" || Array.isArray(contract.tables)) throw new Error("tables must be an object");
  for (const [tableName, table] of Object.entries(contract.tables)) {
    if (!Array.isArray(table.columns) || table.columns.length === 0) throw new Error(`Table ${tableName} has no columns`);
    const columnNames = table.columns.map((column) => column.name);
    if (new Set(columnNames).size !== columnNames.length) throw new Error(`Table ${tableName} has duplicate columns`);
    for (const index of table.indexes ?? []) {
      for (const column of index.columns) if (!columnNames.includes(column)) throw new Error(`Index ${index.name} references missing column ${tableName}.${column}`);
    }
  }
  return contract;
}

export function inspectDatabaseSchema(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
  const actual = {};
  for (const name of tables) {
    const identifier = quoteIdentifier(name);
    const columns = db.prepare(`PRAGMA table_info(${identifier})`).all().map((column) => ({
      name: column.name,
      type: normalizedType(column.type),
      nullable: column.notnull === 0 && column.pk === 0,
      primaryKeyPosition: column.pk,
      default: column.dflt_value,
    }));
    const indexes = db.prepare(`PRAGMA index_list(${identifier})`).all()
      .filter((index) => index.origin === "c")
      .map((index) => ({
        name: index.name,
        unique: index.unique === 1,
        columns: db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all()
          .sort((left, right) => left.seqno - right.seqno)
          .map((column) => column.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const groups = new Map();
    for (const row of db.prepare(`PRAGMA foreign_key_list(${identifier})`).all()) {
      if (!groups.has(row.id)) groups.set(row.id, []);
      groups.get(row.id).push(row);
    }
    const foreignKeys = [...groups.values()].map((rows) => {
      rows.sort((left, right) => left.seq - right.seq);
      return {
        columns: rows.map((row) => row.from),
        referencesTable: rows[0].table,
        referencesColumns: rows.map((row) => row.to),
        onUpdate: rows[0].on_update,
        onDelete: rows[0].on_delete,
      };
    });
    actual[name] = { columns, indexes, foreignKeys };
  }
  return actual;
}

export function compareDatabaseSchema(contract, actual) {
  const errors = [];
  const expectedNames = Object.keys(contract.tables).sort();
  const actualNames = Object.keys(actual).sort();
  for (const name of expectedNames.filter((name) => !actualNames.includes(name))) errors.push({ code: "missing-table", table: name, message: `Missing table: ${name}` });
  for (const name of actualNames.filter((name) => !expectedNames.includes(name))) errors.push({ code: "unexpected-table", table: name, message: `Unexpected table: ${name}` });
  for (const name of expectedNames.filter((name) => actualNames.includes(name))) {
    const expected = contract.tables[name];
    const found = actual[name];
    const expectedColumns = expected.columns.map((column) => ({ ...column, type: normalizedType(column.type) }));
    if (stable(found.columns) !== stable(expectedColumns)) errors.push({ code: "column-mismatch", table: name, message: `Column definition mismatch: ${name}` });
    if (stable(found.indexes) !== stable(expected.indexes ?? [])) errors.push({ code: "index-mismatch", table: name, message: `Index definition mismatch: ${name}` });
    if (stable(found.foreignKeys) !== stable(expected.foreignKeys ?? [])) errors.push({ code: "foreign-key-mismatch", table: name, message: `Foreign key definition mismatch: ${name}` });
  }
  return { ok: errors.length === 0, errors, warnings: [] };
}

export function checkDatabaseContract(db, contract = loadDatabaseContract()) {
  const result = compareDatabaseSchema(contract, inspectDatabaseSchema(db));
  const schemaVersion = Number(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value);
  if (schemaVersion !== contract.databaseFormatVersion) {
    result.errors.push({ code: "version-mismatch", message: `Database format version ${schemaVersion} does not match contract ${contract.databaseFormatVersion}` });
  }
  const quickCheck = db.prepare("PRAGMA quick_check").all();
  if (quickCheck.length !== 1 || quickCheck[0].quick_check !== "ok") {
    result.errors.push({ code: "integrity-check-failed", message: `Database quick_check failed: ${stable(quickCheck)}` });
  }
  const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length > 0) {
    result.errors.push({ code: "foreign-key-check-failed", message: `Database foreign_key_check failed: ${stable(foreignKeyErrors)}` });
  }
  result.ok = result.errors.length === 0;
  return result;
}
