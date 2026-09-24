#!/usr/bin/env node
// 显式迁移：先备份现有数据库，运行时绝不自动改表。
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const path = resolve(process.argv[2] ?? "data/game.sqlite");
if (!existsSync(path)) throw new Error(`数据库不存在: ${path}`);
const backup = `${path}.before-ancient-runes`;
const db = new DatabaseSync(path);
try {
  const columns = db.prepare("PRAGMA table_info(item_instances)").all();
  if (columns.some((column) => column.name === "socketed_rune_item_ids")) {
    console.log("传古符文孔位字段已存在");
  } else {
    if (!process.argv.includes("--test-fixture")) {
      if (existsSync(backup)) throw new Error(`备份文件已存在: ${backup}`);
      copyFileSync(path, backup);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE item_instances ADD COLUMN socketed_rune_item_ids TEXT NOT NULL DEFAULT '[]'");
      db.prepare("UPDATE schema_meta SET value='25' WHERE key='schema_version'").run();
      db.exec("COMMIT");
      console.log(process.argv.includes("--test-fixture") ? "测试夹具迁移完成" : `迁移完成；备份: ${backup}`);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
} finally { db.close(); }
