// API 自检：启动 --no-vite 模式的服务端，逐个调用接口并断言响应形状。
// 用法：node scripts/smoke-api.mjs [port]
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RULE_QUESTIONS } from "../gamedata/rules/rule-questions.mjs";
import { ANCIENT_RUNE_COMBINATIONS } from "../gamedata/overrides/ancient-rune-combinations.mjs";
import { openDatabase } from "../infrastructure/persistence/sqlite-repository.mjs";

const port = Number(process.argv[2] ?? 4599);
const base = `http://127.0.0.1:${port}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "local-wod-api-smoke-"));
const databasePath = join(temporaryDirectory, "game.sqlite");
copyFileSync(resolve("tests", "fixtures", "runtime-template.sqlite"), databasePath);
// 沙箱禁止以管道捕获子进程输出，因此这里用 stdio: "ignore"。
const child = spawn(process.execPath, [resolve("server.mjs"), "--no-vite", "--host", "127.0.0.1", "--port", String(port)], {
  stdio: "ignore",
  env: { ...process.env, WOD_DB_PATH: databasePath },
});
let sessionCookie = "";

function cleanup() {
  child.kill();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

function fail(message) {
  console.error(`FAIL ${message}`);
  cleanup();
  process.exit(1);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/meta`);
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  fail("服务端未在超时时间内就绪");
}

async function get(path) {
  const response = await fetch(`${base}${path}`, { headers: sessionCookie ? { Cookie: sessionCookie } : {} });
  const body = await response.json();
  if (!response.ok) fail(`GET ${path} → ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function post(path, payload) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await response.json();
  if (!response.ok) fail(`POST ${path} → ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function del(path) {
  const response = await fetch(`${base}${path}`, { method: "DELETE", headers: sessionCookie ? { Cookie: sessionCookie } : {} });
  const body = await response.json();
  if (!response.ok) fail(`DELETE ${path} → ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function check(condition, message) {
  if (!condition) fail(message);
}

await waitForServer();

const meta = await get("/api/meta");
check(meta.rulesetVersion, "meta 缺少 rulesetVersion");
check(meta.counts.skills > 0, "meta 缺少技能计数");
check(meta.experimentalPolicies.length > 0, "meta 应列出实验策略");
console.log(`✓ /api/meta contentVersion=${meta.contentVersion} skills=${meta.counts.skills}`);

const catalog = await get("/api/catalog");
check(catalog.enums.phases.length === 10, "阶段枚举应为 10 项");
check(catalog.dungeons.length > 0, "缺少地城");
console.log(`✓ /api/catalog professions=${catalog.professions.length} races=${catalog.races.length} dungeons=${catalog.dungeons.length}`);

const registration = await fetch(`${base}/api/auth/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: `smoke_${Date.now()}`, password: "smoke-password" }),
});
check(registration.ok, `注册失败: ${registration.status}`);
sessionCookie = registration.headers.get("set-cookie")?.split(";")[0] ?? "";
check(sessionCookie, "注册响应缺少会话 Cookie");
const created = await post("/api/heroes", { name: "自检英雄", raceId: catalog.races[0].id, professionId: catalog.professions[0].id, gender: "male" });
check(created.name === "自检英雄", "角色创建失败");
check((await get(`/api/heroes/${created.id}/inventory`)).items.length === 0, "新建角色不应自带物品");

// 在临时库中添加遗物与材料，通过真实 HTTP 请求核验同时提交只消耗一次。
const runeDb = openDatabase(databasePath);
const relicItemId = 990001;
runeDb.prepare("INSERT INTO items(id,name,slot,min_level,max_level,active) VALUES(?,?,?,?,?,1)")
  .run(relicItemId, "接口测试传古遗物", "身体", 0, 99);
runeDb.prepare("INSERT INTO item_detail_metadata(item_id,source_table,json_path,content_hash,parsed_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)")
  .run(relicItemId, "test", "tests/fixtures/ancient-relic.json", "test");
function grant(itemId) {
  const instanceId = Number(runeDb.prepare("INSERT INTO item_instances(item_id) VALUES(?)").run(itemId).lastInsertRowid);
  runeDb.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(created.id, instanceId);
  return instanceId;
}
const relicInstanceId = grant(relicItemId);
const runeIds = ANCIENT_RUNE_COMBINATIONS.find((entry) => entry.name === "泪").variants[4].runeItemIds.map(grant);
runeDb.close();
const socketPath = `/api/heroes/${created.id}/inventory/${relicInstanceId}/runes`;
const beforeSocket = await get(`/api/heroes/${created.id}/inventory`);
check(beforeSocket.items.find((item) => item.instanceId === relicInstanceId)?.runeCapacity === 4, "仓库未显示传古遗物孔位");
const simultaneous = await Promise.all([0, 1].map(() => fetch(`${base}${socketPath}`, {
  method: "POST", headers: { "Content-Type": "application/json", Cookie: sessionCookie },
  body: JSON.stringify({ runeInstanceIds: runeIds }),
})));
check(simultaneous.filter((response) => response.ok).length === 1, "并发提交应仅成功一次");
const afterSocket = await get(`/api/heroes/${created.id}/inventory`);
check(afterSocket.items.find((item) => item.instanceId === relicInstanceId)?.runeCombination?.name === "泪", "并发镶嵌组合不正确");
check(afterSocket.items.filter((item) => item.isAncientRune).length === 0, "符文库存应只消耗一次");
const cleared = await del(socketPath);
check(cleared.items.find((item) => item.instanceId === relicInstanceId)?.socketedRuneItemIds.length === 0, "拆卸后遗物仍有符文");
check(cleared.items.filter((item) => item.isAncientRune).length === 0, "拆卸不应返还符文");
console.log("✓ /api/heroes/:id/inventory/:instanceId/runes 并发、展示、拆卸");

const heroes = await get("/api/heroes");
check(heroes.length > 0, "缺少英雄");
console.log(`✓ /api/heroes ${heroes.length} 名英雄`);

const hero = await get(`/api/heroes/${heroes[0].id}`);
check(hero.attributes.length === 8, "英雄属性应为 8 项");
check(hero.derived.healthMax > 0, "缺少体力上限");
console.log(`✓ /api/heroes/${heroes[0].id} hp=${hero.derived.healthMax} mana=${hero.derived.manaMax} skills=${hero.skills.length}`);

const experienceAdded = await post(`/api/heroes/${heroes[0].id}/resources/experience`, { amount: 250 });
check(experienceAdded.currentExperience === hero.currentExperience + 250, "补充经验未增加当前经验");
check(experienceAdded.totalExperience === hero.totalExperience + 250, "补充经验未增加总经验");
const goldAdded = await post(`/api/heroes/${heroes[0].id}/resources/gold`, { amount: 75 });
const fameAdded = await post(`/api/heroes/${heroes[0].id}/resources/fame`, { amount: 25 });
check(goldAdded.gold === hero.gold + 75, "补充金币未生效");
console.log(`✓ POST 英雄资源 experience=${experienceAdded.currentExperience} gold=${goldAdded.gold} fame=${fameAdded.fame}`);

const levelBefore = goldAdded.level;
const levelThreshold = levelBefore ** 2 * 1000;
if (goldAdded.totalExperience < levelThreshold) {
  await post(`/api/heroes/${heroes[0].id}/resources/experience`, { amount: levelThreshold - goldAdded.totalExperience });
}
const leveled = await post(`/api/heroes/${heroes[0].id}/level-up`);
check(leveled.level === levelBefore + 1, "达到总经验门槛后未提升数据库等级");
console.log(`✓ POST 英雄升级 level=${leveled.level}`);

const plans = await get(`/api/heroes/${heroes[0].id}/plans`);
console.log(`✓ /api/heroes/${heroes[0].id}/plans ${plans.map((plan) => plan.name).join(", ")}`);

const saved = await fetch(`${base}/api/heroes/${heroes[0].id}/plans/${encodeURIComponent("自检方案")}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Cookie: sessionCookie },
  body: JSON.stringify({ position: "rear", mainRound: [{ id: "m1", skillId: "basic-swordsmanship", repeat: "repeatWhilePossible" }] }),
});
check(saved.ok, `保存方案失败: ${saved.status}`);
console.log("✓ PUT 方案保存");

const run = await post("/api/dungeons/rowdy-tavern/run", { heroId: heroes[0].id, planName: "自检方案", seed: "smoke-seed" });
check(run.battles.length >= 1, "地城未产生战斗");
console.log(`✓ POST 地城运行 result=${run.result} battles=${run.battles.length} rounds=${run.battles[0].rounds}`);

const battles = await get("/api/battles");
check(battles.length >= 1, "缺少战报列表");
const detail = await get(`/api/battles/${battles[0].battleId}`);
check(detail.roundData.length > 0, "战报缺少回合展示快照");
check(Object.keys(detail.roundData[0]).join(",") === "round,preRound,recovery,initiative,mainRound", "战报不是四阶段格式");
check(detail.events === undefined && detail.input === undefined, "战报详情不应暴露回放数据");
console.log(`✓ /api/battles/${battles[0].battleId} displayRounds=${detail.roundData.length}`);

const rules = await get("/api/rules");
check(rules.questions.length === RULE_QUESTIONS.length, "规则问题数量应与当前注册表一致");
console.log(`✓ /api/rules questions=${rules.questions.length} policies=${rules.policies.length}`);

const skills = await get("/api/skills?q=剑");
check(skills.matched >= 1, "技能搜索无结果");
console.log(`✓ /api/skills matched=${skills.matched}`);
const heroDetailForSkill = await get(`/api/heroes/${heroes[0].id}`);
const detailedSkill = heroDetailForSkill.learnableSkills.find((skill) => skill.sourceSkillId);
if (detailedSkill) {
  const skillDetail = await get(`/api/skill-details/${detailedSkill.source}/${detailedSkill.sourceSkillId}`);
  if (skillDetail.metadata.skillId !== detailedSkill.sourceSkillId) fail("技能详情 ID 不一致");
  if (skillDetail.detail["技能名称"] !== detailedSkill.name) fail("技能详情名称不一致");
  console.log(`✓ /api/skill-details ${detailedSkill.name}`);
}

const items = await get("/api/items?q=剑&limit=5");
check(items.total > 1000, "物品索引未加载");
console.log(`✓ /api/items total=${items.total} matched=${items.matched}`);

// 装备、角色仓库、团队仓库：完整走一遍流转并验证租户隔离。
const emptyInventory = await get(`/api/heroes/${created.id}/inventory`);
check(emptyInventory.items.length === 1 && emptyInventory.items[0].instanceId === relicInstanceId, "临时库应仅有接口测试遗物");
const emptyEquipment = await get(`/api/heroes/${created.id}/equipment`);
check(emptyEquipment.slots.every((slot) => slot.selectedInstanceId == null), "新建角色不应装备任何物品");
console.log("✓ 新建角色没有自动装备");

// 挑一件当前角色真的穿得上的物品：新手装备没有任何属性/等级要求，最稳妥。
let sword = null;
for (const query of ["轻布手套", "普通的皮衣", "赫伯特叔叔的旧剑", "匕首"]) {
  const market = await get(`/api/market?q=${encodeURIComponent(query)}&limit=20`);
  for (const item of market.items) {
    if (!item.slot || item.slot === "不可装备") continue;
    await post("/api/market/purchase", { heroId: created.id, itemId: item.id });
    const page = await get(`/api/heroes/${created.id}/inventory`);
    const candidate = page.items.find((entry) => entry.itemId === item.id && entry.canEquip);
    if (candidate) { sword = candidate; break; }
  }
  if (sword) break;
}
check(sword, "市场里没有当前角色穿得上的物品");
check(sword.slotId && sword.slotLabel, "物品应带有可装备部位标签");
const afterPurchase = await get(`/api/heroes/${created.id}/inventory`);
check(afterPurchase.items.some((entry) => entry.instanceId === sword.instanceId), "购买后物品应在角色仓库");
check(afterPurchase.items.every((entry) => !entry.equipped), "购买的物品不应自动装备");
console.log(`✓ 市场购买 instance=${sword.instanceId} ${sword.name}`);

const invalidRuneResponse = await fetch(`${base}/api/heroes/${created.id}/inventory/${sword.instanceId}/runes`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: sessionCookie },
  body: JSON.stringify({ runeInstanceIds: [] }),
});
check(invalidRuneResponse.status === 400, "非传古遗物必须拒绝镶嵌");
check((await invalidRuneResponse.json()).error.includes("传古遗物"), "镶嵌错误应说明物品类别");
console.log("✓ 非传古遗物镶嵌被拒绝");

const equipped = await post(`/api/heroes/${created.id}/inventory/${sword.instanceId}/equip`, { equipped: true });
const equippedEntry = equipped.items.find((entry) => entry.instanceId === sword.instanceId);
check(equippedEntry.equipped === true, "装备失败");
check(Boolean(equippedEntry.equipSlotLabel), "装备后应显示所在部位");
const unequippedAgain = await post(`/api/heroes/${created.id}/inventory/${sword.instanceId}/equip`, { equipped: false });
check(unequippedAgain.items.find((entry) => entry.instanceId === sword.instanceId).equipped === false, "卸下失败");

const moved = await post(`/api/heroes/${created.id}/inventory/${sword.instanceId}/equip`, { equipped: false });
check(moved.items.find((entry) => entry.instanceId === sword.instanceId).equipped === false, "准备转仓前应先卸下");
await post(`/api/heroes/${created.id}/inventory/${sword.instanceId}/to-team`, {});
const team = await get("/api/team-inventory");
check(team.items.some((entry) => entry.instanceId === sword.instanceId), "物品未进入团队仓库");
console.log(`✓ 装备/卸下/转入团队仓库 instance=${sword.instanceId}`);

const returned = await post(`/api/team-inventory/${sword.instanceId}/to-hero/${created.id}`, {});
check(returned.hero.items.some((entry) => entry.instanceId === sword.instanceId), "物品未交回角色");
check(returned.team.items.every((entry) => entry.instanceId !== sword.instanceId), "交回后团队仓库不应保留该实例");
console.log("✓ 团队仓库交回角色");

const itemDetail = await get(`/api/item-details/${sword.itemId}`);
check(itemDetail.metadata.itemId === sword.itemId, "物品详情 ID 不一致");
check(itemDetail.detail["物品名称"] === sword.name, `物品详情名称不一致: ${itemDetail.detail["物品名称"]} != ${sword.name}`);
console.log(`✓ /api/item-details/${sword.itemId} ${sword.name} 字段=${Object.keys(itemDetail.detail).length}`);

const dungeonRuns = await get("/api/dungeons/runs");
check(dungeonRuns.length >= 1, "缺少地城运行记录");
const dungeonDetail = await get(`/api/dungeons/runs/${dungeonRuns[0].dungeonRunId}`);
check(dungeonDetail.events.some((event) => event.type === "DungeonEnded"), "地城记录缺少 DungeonEnded");
console.log(`✓ /api/dungeons/runs/${dungeonRuns[0].dungeonRunId} floors=${dungeonDetail.floorCount} battles=${dungeonDetail.battleCount}`);

// 探索：使用账号全部角色及行动设置完成战斗并固化输入。
const exploration = await post("/api/dungeons/rowdy-tavern/explore", { heroId: heroes[0].id, maxFloor: 5 });
check(exploration.status === "completed", `探索记录状态应为 completed，实际 ${exploration.status}`);
check(exploration.partyCount >= 1, "探索记录应包含账号全部角色");
check(exploration.input.party.length === exploration.partyCount, "队伍快照与人数不一致");
check(exploration.input.dungeon.id === "rowdy-tavern", "探索记录缺少地城输入");
check(exploration.input.encounters.battles.length >= 1, "探索记录缺少敌人配置");
check(exploration.input.party.every((member) => member.actionSettings), "角色缺少行动设置快照");
check(exploration.events.some((event) => event.type === "DungeonEnded"), "探索记录缺少地城结束事件");
check(exploration.battleCount >= 1, "探索没有生成战斗记录");
const afterExplore = await get("/api/dungeons/runs");
check(afterExplore[0].dungeonRunId === exploration.dungeonRunId, "新建的探索记录应排在列表首位");
check(afterExplore[0].status === "completed", "列表未暴露已完成状态");
console.log(`✓ POST 探索记录 #${exploration.dungeonRunId} status=${exploration.status} party=${exploration.partyCount} battles=${afterExplore[0].battleCount}`);

// 探索记录必须能按「查看详情」的路径取回：含队伍、行动设置与敌人配置快照。
const explorationDetail = await get(`/api/dungeons/runs/${exploration.dungeonRunId}`);
check(explorationDetail.input.party.length === exploration.partyCount, "探索详情缺少队伍快照");
check(explorationDetail.levels.length >= 1, "探索详情缺少层记录");
check(explorationDetail.rewards.settled === false, "配装模拟不应结算探索奖励");
console.log(`✓ /api/dungeons/runs/${exploration.dungeonRunId} 详情 队伍=${explorationDetail.input.party.length} 战斗=${explorationDetail.battleCount}`);

// 删除角色：物品全部移入团队仓库，角色从列表消失，战报与探索记录必须保留。
// 这位角色既是战报的当事人，也是账号里唯一的角色，因此同时覆盖了「删除当前角色」的路径。
const battlesBeforeDelete = await get("/api/battles");
const runsBeforeDelete = await get("/api/dungeons/runs");
const inventoryBeforeDelete = await get(`/api/heroes/${created.id}/inventory`);
check(battlesBeforeDelete.length >= 1 && runsBeforeDelete.length >= 1, "删除前的战报夹具缺失");

const deleted = await del(`/api/heroes/${created.id}`);
check(deleted.heroId === created.id, "删除响应缺少 heroId");
check(deleted.movedItemCount === inventoryBeforeDelete.items.length, `转移件数应为 ${inventoryBeforeDelete.items.length}，实际 ${deleted.movedItemCount}`);
check(!(await get("/api/heroes")).some((hero) => hero.id === created.id), "已删除角色仍出现在角色列表");
const deletedDetail = await fetch(`${base}/api/heroes/${created.id}`, { headers: sessionCookie ? { Cookie: sessionCookie } : {} });
check(deletedDetail.status === 404, `已删除角色的详情应为 404，实际 ${deletedDetail.status}`);
const teamAfterDelete = await get("/api/team-inventory");
check(inventoryBeforeDelete.items.every((item) => teamAfterDelete.items.some((entry) => entry.instanceId === item.instanceId)), "角色物品未全部移入团队仓库");
check((await get("/api/battles")).length === battlesBeforeDelete.length, "删除角色不应删除战报");
check((await get("/api/dungeons/runs")).length === runsBeforeDelete.length, "删除角色不应删除探索记录");
console.log(`✓ DELETE /api/heroes/${created.id} 入库物品=${deleted.movedItemCount} 战报保留=${battlesBeforeDelete.length} 探索保留=${runsBeforeDelete.length}`);

// 删除战报：记录、它名下的战斗战报与本地展示 JSON 一并删除，且不能重复删除。
const battlesBeforeRunDelete = await get("/api/battles?limit=500");
const targetRun = (await get("/api/dungeons/runs"))[0];
check(targetRun.battleCount >= 1, "待删除的探索记录缺少战斗");
const removedRun = await del(`/api/dungeons/runs/${targetRun.dungeonRunId}`);
check(removedRun.dungeonRunId === targetRun.dungeonRunId, "删除响应缺少 dungeonRunId");
check(removedRun.deletedBattleIds.length === targetRun.battleCount, `应删除 ${targetRun.battleCount} 份战斗战报，实际 ${removedRun.deletedBattleIds.length}`);
check(removedRun.removedReportFiles.length >= 1, "删除记录必须同时清理本地战报 JSON 文件");
check(removedRun.warnings.length === 0, `删除过程不应有告警：${removedRun.warnings.join("；")}`);
check(!(await get("/api/dungeons/runs")).some((entry) => entry.dungeonRunId === targetRun.dungeonRunId), "已删除的记录仍出现在战报列表");
check((await get("/api/battles?limit=500")).length === battlesBeforeRunDelete.length - removedRun.deletedBattleIds.length, "战斗战报数量未按预期减少");
const removedRunDetail = await fetch(`${base}/api/dungeons/runs/${targetRun.dungeonRunId}`, { headers: sessionCookie ? { Cookie: sessionCookie } : {} });
check(removedRunDetail.status === 404, `已删除记录的详情应为 404，实际 ${removedRunDetail.status}`);
const removedRunAgain = await fetch(`${base}/api/dungeons/runs/${targetRun.dungeonRunId}`, { method: "DELETE", headers: sessionCookie ? { Cookie: sessionCookie } : {} });
check(removedRunAgain.status === 404, `重复删除应为 404，实际 ${removedRunAgain.status}`);
console.log(`✓ DELETE /api/dungeons/runs/${targetRun.dungeonRunId} 战斗=${removedRun.deletedBattleIds.length} 文件=${removedRun.removedReportFiles.length}`);

console.log("API 自检全部通过");
cleanup();
process.exit(0);
