// 战斗诊断 CLI。设计文档 §24.2：每场模拟记录战斗 ID、规则/内容版本、种子、
// 阶段耗时、行动数与事件数、未识别规则与数据告警、数值异常。
//
// 用法：
//   node scripts/run-battle.mjs --hero 1 --dungeon rowdy-tavern --floor 1 --seed demo [--plan 林地巡猎] [--json]
// Pass --database data/game.sqlite only when writing diagnostic results to the live database is intentional.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { openDatabase, createRepository } from "../infrastructure/persistence/sqlite-repository.mjs";
import { loadCatalog } from "../application/catalog-service.mjs";
import { runDungeonFloor, getBattleDetail } from "../application/battle-service.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const heroId = Number(readArg("--hero", "1"));
const dungeonId = readArg("--dungeon", "rowdy-tavern");
const floorNumber = Number(readArg("--floor", "1"));
const seed = readArg("--seed", `cli-${Date.now()}`);
const planName = readArg("--plan", undefined);
const asJson = args.includes("--json");
const databaseArgument = readArg("--database", undefined);
const temporaryDirectory = databaseArgument ? null : mkdtempSync(join(tmpdir(), "local-wod-battle-"));
const databasePath = databaseArgument ? resolve(databaseArgument) : join(temporaryDirectory, "game.sqlite");
if (!databaseArgument) copyFileSync(resolve("tests", "fixtures", "runtime-template.sqlite"), databasePath);

const db = openDatabase(databasePath);
const repository = createRepository(db);
const professions = db.prepare("SELECT id, name, source_id AS sourceId FROM professions ORDER BY source_id").all();
const races = db.prepare("SELECT id, name, source_id AS sourceId FROM races ORDER BY source_id").all();
const catalog = loadCatalog({ fallback: { professions, races } });

const started = performance.now();
const run = runDungeonFloor({ repository, catalog, heroId, dungeonId, planName, floorNumber, seed });
const elapsedMs = performance.now() - started;

if (run.error) {
  console.error(`运行失败：${run.error}`);
  db.close();
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(run, null, 2));
  db.close();
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  process.exit(0);
}

console.log(`地城 ${run.dungeonName} 第 ${run.floorNumber} 层　方案 ${run.planName}`);
console.log(`种子 ${run.seed}　规则 ${run.contentVersion}　耗时 ${elapsedMs.toFixed(1)} ms　结果 ${run.result}`);
console.log(`战斗数 ${run.battles.length}　最终体力 ${run.finalHero.health}　最终法力 ${run.finalHero.mana}`);

for (const battle of run.battles) {
  const detail = getBattleDetail(repository, battle.battleId);
  console.log("");
  console.log(`=== 第 ${battle.battleIndex} 场：${battle.battleName}　结果 ${battle.result}　回合 ${battle.rounds} ===`);
  console.log(`展示快照 ${detail.roundData.length} 个回合`);
}
db.close();
if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
