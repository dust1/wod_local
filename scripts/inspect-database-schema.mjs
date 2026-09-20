#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const databasePath = resolve(process.argv[2] ?? "data/game.sqlite");
const outputPath = process.argv[3] ? resolve(process.argv[3]) : null;
if (!existsSync(databasePath)) throw new Error("Database not found: " + databasePath);

const db = new DatabaseSync(databasePath, { readOnly: true });
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const tables = db.prepare(`SELECT name FROM sqlite_master
  WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
const contract = {
  formatVersion: 1,
  databaseFormatVersion: Number(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value ?? 0),
  databaseName: "game.sqlite",
  description: "Local WOD runtime database schema contract; validates an existing database and cannot construct one.",
  tables: {},
};

for (const { name } of tables) {
  const identifier = quoteIdentifier(name);
  const columns = db.prepare(`PRAGMA table_info(${identifier})`).all().map((column) => ({
    name: column.name,
    type: column.type,
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
  const foreignKeyRows = db.prepare(`PRAGMA foreign_key_list(${identifier})`).all();
  const groupedForeignKeys = new Map();
  for (const row of foreignKeyRows) {
    if (!groupedForeignKeys.has(row.id)) groupedForeignKeys.set(row.id, []);
    groupedForeignKeys.get(row.id).push(row);
  }
  const foreignKeys = [...groupedForeignKeys.values()].map((rows) => ({
    columns: rows.sort((left, right) => left.seq - right.seq).map((row) => row.from),
    referencesTable: rows[0].table,
    referencesColumns: rows.map((row) => row.to),
    onUpdate: rows[0].on_update,
    onDelete: rows[0].on_delete,
  }));
  contract.tables[name] = { description: "", columns, indexes, foreignKeys };
}

db.close();
if (outputPath && existsSync(outputPath)) {
  const previous = JSON.parse(readFileSync(outputPath, "utf8"));
  for (const [name, table] of Object.entries(contract.tables)) table.description = previous.tables?.[name]?.description ?? "";
}
const output = `${JSON.stringify(contract, null, 2)}\n`;
if (outputPath) writeFileSync(outputPath, output, "utf8");
else process.stdout.write(output);
