#!/usr/bin/env node
import { resolve } from "node:path";
import { openDatabase } from "../infrastructure/persistence/sqlite-repository.mjs";
import { checkDatabaseContract, loadDatabaseContract } from "../infrastructure/persistence/database-contract.mjs";

const databasePath = resolve(process.argv[2] ?? "data/game.sqlite");
const contractPath = resolve(process.argv[3] ?? "docs/database-schema.json");
let db;
try {
  db = openDatabase(databasePath);
  const result = checkDatabaseContract(db, loadDatabaseContract(contractPath));
  if (!result.ok) {
    for (const error of result.errors) console.error(`[${error.code}] ${error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`Database contract verified: ${databasePath}`);
  }
} finally {
  db?.close();
}
