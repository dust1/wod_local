// 本地 HTTP API 与 Vite 中间件。设计文档 §3、§20.1。
// 这一层只做协议转换：解析请求 → 调用 application 用例 → 序列化响应。
import { createServer } from "node:http";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer as createViteServer } from "vite";

import { openDatabase, createRepository } from "./infrastructure/persistence/sqlite-repository.mjs";
import { checkDatabaseContract, loadDatabaseContract } from "./infrastructure/persistence/database-contract.mjs";
import { loadCatalog, loadItems, listGeneratedFiles } from "./application/catalog-service.mjs";
import { addHeroResource, advanceHeroProfession, deleteHero, heroDetailDto, heroListDto, planDto, trainHeroAttribute, trainHeroAttributes, trainHeroSkill, trainHeroSkills, upgradeHeroLevel } from "./application/hero-service.mjs";
import { buildCharacterInstance } from "./application/character-instance-service.mjs";
import { runDungeon, runDungeonFloor, createDungeonExploration, listBattles, getBattleDetail, listDungeonRuns, getDungeonRunDetail, deleteDungeonRun, RULESET_VERSION } from "./application/battle-service.mjs";
import { RULE_QUESTIONS } from "./gamedata/rules/rule-questions.mjs";
import { hashPassword, newSession, validateCredentials, validateHeroInput, verifyPassword } from "./application/auth-service.mjs";
import { loadSkillDetail } from "./application/skill-detail-service.mjs";
import { heroInventoryDto, heroInventoryPageDto, itemDetailDto, teamInventoryDto } from "./application/inventory-service.mjs";
import { socketAncientRunes } from "./application/ancient-rune-service.mjs";
import { applyHeroEquipment, equipHeroInventoryItem, heroEquipmentDto, itemEquipabilityConditions } from "./application/equipment-service.mjs";
import { applyCharacterCard, characterCardPreview, exportCharacterCard } from "./application/character-card-service.mjs";
import { marketDto, purchaseMarketItem } from "./application/market-service.mjs";
import { POLICY_REGISTRY, experimentalPolicies, policyForRuleQuestion } from "./game/policies/registry.mjs";
import { actionSettingsDto, saveActionSettings } from "./application/action-settings-service.mjs";
import { BATTLE_PHASES, PHASE_LABELS } from "./game/domain/phases.mjs";
import { BASE_TYPE_LABELS, ATTACK_TYPES } from "./game/domain/skill.mjs";
import { EQUIP_SLOTS } from "./game/domain/item.mjs";
import { POSITIONS, POSITION_LABELS } from "./game/domain/positions.mjs";
import { REPEAT_MODES, REPEAT_MODE_LABELS } from "./game/commands/battle-plan.mjs";
import { WOUND_LABELS } from "./game/commands/healing.mjs";
import { summonConfigDto, validateArchetypeInput, validateAssignmentInput, validateDefinitionInput } from "./application/summon-config-service.mjs";
import { saveSummonActionSettings, summonActionConfigDto } from "./application/summon-action-settings-service.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const adminMode = args.includes("--admin");
const processStartedAt = performance.now();
// WOD_DB_PATH 供本地自检/回归指向一次性的库副本，默认仍是运行时库 data/game.sqlite。
const dbPath = process.env.WOD_DB_PATH ? resolve(root, process.env.WOD_DB_PATH) : resolve(root, "data", "game.sqlite");
let db;
try {
  db = openDatabase(dbPath);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const databaseOpenedMs = Number((performance.now() - processStartedAt).toFixed(1));
const readiness = checkDatabaseContract(db, loadDatabaseContract(resolve(root, "docs", "database-schema.json")));
if (!readiness.ok) {
  for (const error of readiness.errors) console.error(`[${error.code}] ${error.message}`);
  db.close();
  process.exit(1);
}
const repository = createRepository(db);
const catalogFallback = {
  professions: db.prepare("SELECT id, name, source_id AS sourceId FROM professions ORDER BY source_id").all(),
  races: db.prepare("SELECT id, name, source_id AS sourceId FROM races ORDER BY source_id").all(),
};
const catalogStartedAt = performance.now();
let catalog = loadCatalog({ fallback: catalogFallback });
const catalogLoadedAt = new Date().toISOString();
// 启动各阶段耗时，供 /api/meta 展示与启动日志输出，便于定位首屏卡顿来源。
const startupTiming = {
  databaseOpenedMs,
  catalogLoadMs: Number((performance.now() - catalogStartedAt).toFixed(1)),
};

const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const host = readArg("--host", "0.0.0.0");
const port = Number(readArg("--port", "4173"));
// --no-vite 只启动 API，便于在无法运行 esbuild 的环境里做接口自检。
const useVite = !args.includes("--no-vite");

const vite = useVite
  ? await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
    define: { __WOD_ADMIN_MODE__: JSON.stringify(adminMode) },
  })
  : null;

function json(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 2_000_000) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function cookieValue(request, name) {
  const match = String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function currentUser(request) {
  const sessionId = cookieValue(request, "wod_session");
  const session = sessionId ? repository.getSession(sessionId) : null;
  return session ? { id: session.user_id, username: session.username, sessionId } : null;
}

function setSessionCookie(response, session) {
  response.setHeader("Set-Cookie", `wod_session=${session.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

/**
 * 角色详情 = 角色实例 + DTO。
 *
 * 角色实例负责读取当前装备物品的「作用在物品持有者上的效果」与已学技能的
 * 「作用在技能拥有者上的效果」，属性页与技能页的基础值/加持值都取自它。
 */
function heroDetailWithInstance(heroId, userId) {
  const instance = buildCharacterInstance({ repository, catalog, root, heroId, userId });
  return heroDetailDto(repository, heroId, catalog, userId, { instance });
}

/** 人物卡导入用的多槽位容量：优先取角色实例的派生值。 */
function slotCapacitiesOf(instance) {
  return {
    medalSlots: instance?.derived?.medalSlots?.effective ?? 3,
    pocketSlots: instance?.derived?.pocketSlots?.effective ?? 15,
    ringSlots: instance?.derived?.ringSlots?.effective ?? 4,
  };
}

/** 枚举 DTO，供界面渲染下拉框与说明。 */
function enumsDto() {  return {
    attributes: { strength: "力量", constitution: "体质", intelligence: "智力", dexterity: "灵巧", charisma: "魅力", agility: "敏捷", perception: "感知", willpower: "意志" },
    baseTypes: BASE_TYPE_LABELS,
    attackTypes: Object.values(ATTACK_TYPES),
    equipSlots: EQUIP_SLOTS,
    positions: POSITION_LABELS,
    positionOrder: POSITIONS,
    repeatModes: REPEAT_MODE_LABELS,
    repeatModeIds: REPEAT_MODES,
    phases: BATTLE_PHASES.map((phase) => ({ id: phase, label: PHASE_LABELS[phase] })),
    wounds: WOUND_LABELS,
  };
}

async function api(request, response, url) {
  const method = request.method;
  const path = url.pathname;

  if (method === "POST" && path === "/api/auth/register") {
    try {
      const body = await readJson(request);
      const credentials = validateCredentials(body.username, body.password);
      if (repository.getUserByUsername(credentials.username)) return json(response, 409, { error: "用户名已存在" });
      const password = hashPassword(credentials.password);
      const user = repository.createUser({ username: credentials.username, passwordHash: password.hash, passwordSalt: password.salt });
      const session = { ...newSession(), userId: user.id };
      repository.createSession(session);
      setSessionCookie(response, session);
      return json(response, 201, { user });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  if (method === "POST" && path === "/api/auth/login") {
    const body = await readJson(request);
    const username = String(body.username ?? "").trim();
    const user = repository.getUserByUsername(username);
    if (!user || !verifyPassword(String(body.password ?? ""), user.password_salt, user.password_hash)) return json(response, 401, { error: "用户名或密码错误" });
    const session = { ...newSession(), userId: user.id };
    repository.createSession(session);
    setSessionCookie(response, session);
    return json(response, 200, { user: { id: user.id, username: user.username, created_at: user.created_at } });
  }

  if (method === "GET" && path === "/api/auth/session") {
    const user = currentUser(request);
    return json(response, 200, { user: user ? { id: user.id, username: user.username } : null });
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const user = currentUser(request);
    if (user) repository.deleteSession(user.sessionId);
    response.setHeader("Set-Cookie", "wod_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return json(response, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/meta") {
    return json(response, 200, {
      rulesetVersion: RULESET_VERSION,
      contentVersion: catalog.contentVersion,
      generatedAt: catalog.generatedAt,
      catalogLoadedAt,
      schemaMeta: repository.schemaMeta(),
      generatedFiles: listGeneratedFiles(),
      counts: catalog.counts,
      warnings: catalog.warnings,
      startupTiming,
      experimentalPolicies: experimentalPolicies().map((policy) => ({ id: policy.id, description: policy.description, ruleQuestionId: policy.ruleQuestionId })),
    });
  }

  if (method === "GET" && path === "/api/catalog") {
    return json(response, 200, {
      contentVersion: catalog.contentVersion,
      professions: catalog.professions,
      races: catalog.races,
      dungeons: repository.listDungeons().map((dungeon) => ({
        id: dungeon.id,
        name: dungeon.name,
        kind: dungeon.kind,
        minLevel: dungeon.min_level,
        maxLevel: dungeon.max_level,
        prepareMinutes: dungeon.prepare_minutes,
        description: dungeon.description,
        enabled: Boolean(dungeon.enabled),
      })),
      enums: enumsDto(),
      counts: catalog.counts,
      qualityReport: catalog.qualityReport
        ? {
            checks: (catalog.qualityReport.checks ?? []).map((check) => ({ check: check.check, severity: check.severity, count: check.count })),
          }
        : null,
    });
  }

  if (method === "GET" && path === "/api/skills") {
    const query = (url.searchParams.get("q") ?? "").trim();
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
    const all = [...catalog.skills.values()];
    const filtered = query
      ? all.filter((skill) => skill.name?.includes(query) || skill.id.includes(query))
      : all;
    return json(response, 200, {
      total: all.length,
      matched: filtered.length,
      skills: filtered.slice(0, limit).map((skill) => ({
        id: skill.id,
        name: skill.name,
        baseType: skill.baseType,
        baseTypeLabel: BASE_TYPE_LABELS[skill.baseType] ?? skill.baseType,
        attackType: skill.attackType ?? null,
        timing: skill.timing,
        target: skill.target,
        attributeFormula: skill.attributeFormula,
        manaCost: skill.manaCost,
        itemRequirement: skill.itemRequirement,
        warnings: skill.warnings ?? [],
        evidence: skill.evidence ?? null,
        generated: Boolean(skill.generated),
      })),
    });
  }

  if (method === "GET" && path === "/api/items") {
    const query = (url.searchParams.get("q") ?? "").trim();
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
    // 物品索引约 12 MB，按需加载，避免拖慢服务启动。
    const all = [...loadItems(catalog).values()];
    const filtered = query ? all.filter((item) => item.name?.includes(query) || item.id.includes(query)) : all;
    return json(response, 200, { total: all.length, matched: filtered.length, items: filtered.slice(0, limit) });
  }

  if (method === "GET" && path === "/api/rules") {
    return json(response, 200, {
      questions: RULE_QUESTIONS.map((question) => ({
        ...question,
        policies: policyForRuleQuestion(question.id).map((policy) => ({ id: policy.id, evidenceLevel: policy.evidenceLevel, description: policy.description })),
      })),
      policies: POLICY_REGISTRY.map(({ impl, ...policy }) => policy),
    });
  }

  const user = currentUser(request);
  if (!user) return json(response, 401, { error: "请先登录" });

  if (path.startsWith("/api/admin/")) {
    if (!adminMode) return json(response, 403, { error: "请使用 npm run admin 启动管理模式" });
    try {
      if (method === "GET" && path === "/api/admin/summons") return json(response, 200, summonConfigDto(repository, catalog));
      const summonActionsMatch = path.match(/^\/api\/admin\/summon-definitions\/(\d+)\/action-settings$/);
      if (summonActionsMatch && method === "GET") return json(response, 200, summonActionConfigDto(repository, root, Number(summonActionsMatch[1])));
      if (summonActionsMatch && method === "PUT") {
        const settings = saveSummonActionSettings(repository, Number(summonActionsMatch[1]), await readJson(request));
        return json(response, 200, settings);
      }
      if (method === "GET" && path === "/api/admin/summon-skills") {
        const query = (url.searchParams.get("q") ?? "").trim();
        return json(response, 200, { total: repository.countSummonSkills(query), skills: repository.searchSummonSkills(query, url.searchParams.get("limit") ?? 20) });
      }
      if (method === "POST" && path === "/api/admin/summons") {
        return json(response, 201, repository.createSummonArchetype(validateArchetypeInput(await readJson(request))));
      }
      const archetypeMatch = path.match(/^\/api\/admin\/summons\/([a-z0-9-]+)$/);
      if (archetypeMatch && method === "PUT") {
        if (!repository.getSummonArchetype(archetypeMatch[1])) return json(response, 404, { error: "召唤物不存在" });
        return json(response, 200, repository.updateSummonArchetype(archetypeMatch[1], validateArchetypeInput(await readJson(request), { requireId: false })));
      }
      if (archetypeMatch && method === "DELETE") {
        return repository.deleteSummonArchetype(archetypeMatch[1]) ? json(response, 200, { ok: true }) : json(response, 404, { error: "召唤物不存在" });
      }
      const definitionsMatch = path.match(/^\/api\/admin\/summons\/([a-z0-9-]+)\/definitions$/);
      if (definitionsMatch && method === "POST") {
        const entry = validateDefinitionInput(repository, definitionsMatch[1], await readJson(request), null, catalog);
        return json(response, 201, repository.createSummonDefinition(entry));
      }
      const definitionMatch = path.match(/^\/api\/admin\/summon-definitions\/(\d+)$/);
      if (definitionMatch && method === "PUT") {
        const existing = repository.getSummonDefinition(definitionMatch[1]);
        if (!existing) return json(response, 404, { error: "召唤物形态不存在" });
        const entry = validateDefinitionInput(repository, existing.archetype_id, await readJson(request), Number(definitionMatch[1]), catalog);
        return json(response, 200, repository.updateSummonDefinition(definitionMatch[1], entry));
      }
      if (definitionMatch && method === "DELETE") {
        return repository.deleteSummonDefinition(definitionMatch[1]) ? json(response, 200, { ok: true }) : json(response, 404, { error: "召唤物形态不存在" });
      }
      const skillsMatch = path.match(/^\/api\/admin\/summons\/([a-z0-9-]+)\/skills$/);
      if (skillsMatch && method === "POST") {
        return json(response, 200, repository.saveSummonSkillAssignment(validateAssignmentInput(repository, skillsMatch[1], await readJson(request))));
      }
      const skillMatch = path.match(/^\/api\/admin\/summons\/([a-z0-9-]+)\/skills\/(\d+)$/);
      if (skillMatch && method === "PUT") {
        const body = { ...(await readJson(request)), summonSkillId: Number(skillMatch[2]) };
        return json(response, 200, repository.saveSummonSkillAssignment(validateAssignmentInput(repository, skillMatch[1], body)));
      }
      if (skillMatch && method === "DELETE") {
        return repository.deleteSummonSkillAssignment(skillMatch[1], skillMatch[2]) ? json(response, 200, { ok: true }) : json(response, 404, { error: "技能分配不存在" });
      }
      return json(response, 404, { error: "管理接口不存在" });
    } catch (error) {
      const status = String(error.message).includes("UNIQUE constraint") ? 409 : 400;
      return json(response, status, { error: error.message });
    }
  }

  if (method === "GET" && path === "/api/market") {
    return json(response, 200, marketDto(repository, {
      query: (url.searchParams.get("q") ?? "").trim(),
      limit: url.searchParams.get("limit") ?? 20,
      offset: url.searchParams.get("offset") ?? 0,
    }));
  }
  if (method === "POST" && path === "/api/market/purchase") {
    const body = await readJson(request);
    try { return json(response, 200, purchaseMarketItem(repository, { heroId: Number(body.heroId), userId: user.id, itemId: Number(body.itemId) })); }
    catch (error) { return json(response, 400, { error: error.message }); }
  }

  if (method === "GET" && path === "/api/heroes") {
    return json(response, 200, heroListDto(repository, user.id));
  }

  const skillDetailMatch = path.match(/^\/api\/skill-details\/(race|profession)\/(\d+)$/);
  if (method === "GET" && skillDetailMatch) {
    try {
      const detail = loadSkillDetail(repository, root, skillDetailMatch[1], Number(skillDetailMatch[2]));
      return detail ? json(response, 200, detail) : json(response, 404, { error: "技能详情不存在" });
    } catch (error) {
      return json(response, 500, { error: `技能详情读取失败: ${error.message}` });
    }
  }

  const itemDetailMatch = path.match(/^\/api\/item-details\/(\d+)$/);
  if (method === "GET" && itemDetailMatch) {
    try {
      const detail = itemDetailDto(repository, root, Number(itemDetailMatch[1]));
      if (!detail) return json(response, 404, { error: "物品详情不存在" });
      const heroId = Number(url.searchParams.get("heroId"));
      if (Number.isInteger(heroId) && heroId > 0) {
        const hero = repository.getHero(heroId, user.id);
        const character = buildCharacterInstance({ repository, catalog, root, heroId, userId: user.id });
        if (hero && character) detail.equipability = itemEquipabilityConditions({ hero: { ...hero, ...character }, itemDetail: detail.detail });
      }
      return json(response, 200, detail);
    } catch (error) { return json(response, 500, { error: `物品详情读取失败: ${error.message}` }); }
  }

  const heroInventoryMatch = path.match(/^\/api\/heroes\/(\d+)\/inventory$/);
  if (method === "GET" && heroInventoryMatch) {
    const inventory = heroInventoryPageDto(repository, root, Number(heroInventoryMatch[1]), user.id, catalog);
    return inventory ? json(response, 200, inventory) : json(response, 404, { error: "英雄不存在" });
  }
  const heroEquipmentMatch = path.match(/^\/api\/heroes\/(\d+)\/equipment$/);
  if (method === "GET" && heroEquipmentMatch) {
    const equipment = heroEquipmentDto(repository, root, Number(heroEquipmentMatch[1]), user.id, catalog);
    return equipment ? json(response, 200, equipment) : json(response, 404, { error: "英雄不存在" });
  }
  if (method === "PUT" && heroEquipmentMatch) {
    try {
      const body = await readJson(request);
      return json(response, 200, applyHeroEquipment(repository, root, Number(heroEquipmentMatch[1]), user.id, body.selections, catalog));
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  const equipMatch = path.match(/^\/api\/heroes\/(\d+)\/inventory\/(\d+)\/equip$/);
  const runeMatch = path.match(/^\/api\/heroes\/(\d+)\/inventory\/(\d+)\/runes$/);
  if (method === "POST" && runeMatch) {
    try {
      const body = await readJson(request);
      const result = socketAncientRunes(repository, root, Number(runeMatch[1]), user.id, Number(runeMatch[2]), body.runeInstanceIds ?? []);
      return json(response, 200, { ...result, inventory: heroInventoryPageDto(repository, root, Number(runeMatch[1]), user.id, catalog) });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (method === "DELETE" && runeMatch) {
    try {
      repository.clearSocketedRunes(Number(runeMatch[1]), user.id, Number(runeMatch[2]));
      return json(response, 200, heroInventoryPageDto(repository, root, Number(runeMatch[1]), user.id, catalog));
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (method === "POST" && equipMatch) {
    try {
      const body = await readJson(request);
      if (Boolean(body.equipped)) equipHeroInventoryItem(repository, root, Number(equipMatch[1]), user.id, Number(equipMatch[2]), catalog);
      else repository.setItemEquipped(Number(equipMatch[1]), user.id, Number(equipMatch[2]), false);
      return json(response, 200, heroInventoryPageDto(repository, root, Number(equipMatch[1]), user.id, catalog));
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  const toTeamMatch = path.match(/^\/api\/heroes\/(\d+)\/inventory\/(\d+)\/to-team$/);
  if (method === "POST" && toTeamMatch) {
    try {
      repository.moveItemToTeam(Number(toTeamMatch[1]), user.id, Number(toTeamMatch[2]));
      return json(response, 200, { hero: heroInventoryDto(repository, Number(toTeamMatch[1]), user.id), team: teamInventoryDto(repository, user.id) });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (method === "GET" && path === "/api/team-inventory") return json(response, 200, teamInventoryDto(repository, user.id));
  const toHeroMatch = path.match(/^\/api\/team-inventory\/(\d+)\/to-hero\/(\d+)$/);
  if (method === "POST" && toHeroMatch) {
    try {
      repository.moveItemToHero(user.id, Number(toHeroMatch[2]), Number(toHeroMatch[1]));
      return json(response, 200, { hero: heroInventoryDto(repository, Number(toHeroMatch[2]), user.id), team: teamInventoryDto(repository, user.id) });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  if (method === "POST" && path === "/api/heroes") {
    try {
      const hero = repository.createHero(user.id, validateHeroInput(await readJson(request)));
      return json(response, 201, heroDetailWithInstance(hero.id, user.id));
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const resourceMatch = path.match(/^\/api\/heroes\/(\d+)\/resources\/(experience|gold|fame)$/);
  if (method === "POST" && resourceMatch) {
    try {
      const body = await readJson(request);
      const heroId = Number(resourceMatch[1]);
      addHeroResource(repository, heroId, resourceMatch[2], body.amount, catalog, user.id);
      return json(response, 200, heroDetailWithInstance(heroId, user.id));
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const levelUpMatch = path.match(/^\/api\/heroes\/(\d+)\/level-up$/);
  if (method === "POST" && levelUpMatch) {
    try {
      const heroId = Number(levelUpMatch[1]);
      upgradeHeroLevel(repository, heroId, catalog, user.id);
      return json(response, 200, heroDetailWithInstance(heroId, user.id));
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const attributeMatch = path.match(/^\/api\/heroes\/(\d+)\/attributes\/([a-z]+)$/);
  const attributeBatchMatch = path.match(/^\/api\/heroes\/(\d+)\/attributes$/);
  if (method === "PUT" && attributeBatchMatch) {
    try {
      const body = await readJson(request);
      const heroId = Number(attributeBatchMatch[1]);
      const result = trainHeroAttributes(repository, heroId, body.updates, catalog, user.id);
      return json(response, 200, { ...heroDetailWithInstance(heroId, user.id), training: result.training });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }
  if (method === "POST" && attributeMatch) {
    try {
      const body = await readJson(request);
      const heroId = Number(attributeMatch[1]);
      const result = trainHeroAttribute(repository, heroId, attributeMatch[2], Number(body.delta), catalog, user.id);
      // 训练会改变基础值，必须在写入之后重建实例，否则返回的加持值是旧状态。
      return json(response, 200, { ...heroDetailWithInstance(heroId, user.id), training: result.training });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const skillTrainingMatch = path.match(/^\/api\/heroes\/(\d+)\/skills\/(\d+)$/);
  const advancementMatch = path.match(/^\/api\/heroes\/(\d+)\/advanced-profession$/);
  if (method === "PUT" && advancementMatch) {
    try {
      const body = await readJson(request);
      const heroId = Number(advancementMatch[1]);
      const result = advanceHeroProfession(repository, heroId, body.name, catalog, user.id);
      return json(response, 200, { ...heroDetailWithInstance(heroId, user.id), firstAdvancement: result.firstAdvancement });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }
  if (method === "POST" && skillTrainingMatch) {
    try {
      const body = await readJson(request);
      const heroId = Number(skillTrainingMatch[1]);
      const result = trainHeroSkill(repository, heroId, Number(skillTrainingMatch[2]), Number(body.delta), catalog, user.id);
      return json(response, 200, { ...heroDetailWithInstance(heroId, user.id), training: result.training });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const skillTrainingBatchMatch = path.match(/^\/api\/heroes\/(\d+)\/skills$/);
  if (method === "PUT" && skillTrainingBatchMatch) {
    try {
      const body = await readJson(request);
      const heroId = Number(skillTrainingBatchMatch[1]);
      const result = trainHeroSkills(repository, heroId, body.updates, catalog, user.id);
      return json(response, 200, { ...heroDetailWithInstance(heroId, user.id), training: result.training });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  // 人物卡导入导出：预览只读取，导入在同一套预览结果上写属性、技能与已匹配的装备。
  const characterCardMatch = path.match(/^\/api\/heroes\/(\d+)\/character-card$/);
  if (characterCardMatch && (method === "POST" || method === "GET")) {
    const heroId = Number(characterCardMatch[1]);
    if (!repository.getHero(heroId, user.id)) return json(response, 404, { error: "英雄不存在" });
    const instance = buildCharacterInstance({ repository, catalog, root, heroId, userId: user.id });
    const characterCardOptions = { instance, slotCapacities: slotCapacitiesOf(instance) };
    if (method === "GET") return json(response, 200, exportCharacterCard(repository, root, heroId, catalog, user.id, characterCardOptions));
    try {
      const body = await readJson(request);
      const result = applyCharacterCard(repository, root, heroId, String(body.text ?? ""), catalog, user.id, characterCardOptions);
      return json(response, 200, { ...result.detail, characterCard: { preview: result.preview, applied: result.applied } });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const characterCardPreviewMatch = path.match(/^\/api\/heroes\/(\d+)\/character-card\/preview$/);
  if (method === "POST" && characterCardPreviewMatch) {
    const heroId = Number(characterCardPreviewMatch[1]);
    if (!repository.getHero(heroId, user.id)) return json(response, 404, { error: "英雄不存在" });
    try {
      const body = await readJson(request);
      const instance = buildCharacterInstance({ repository, catalog, root, heroId, userId: user.id });
      const cardOptions = { instance, slotCapacities: slotCapacitiesOf(instance) };
      return json(response, 200, characterCardPreview(repository, heroId, String(body.text ?? ""), catalog, user.id, cardOptions));
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const heroMatch = path.match(/^\/api\/heroes\/(\d+)$/);
  if (method === "GET" && heroMatch) {
    const detail = heroDetailWithInstance(Number(heroMatch[1]), user.id);
    return detail ? json(response, 200, detail) : json(response, 404, { error: "英雄不存在" });
  }
  if (method === "DELETE" && heroMatch) {
    const heroId = Number(heroMatch[1]);
    if (!repository.getHero(heroId, user.id)) return json(response, 404, { error: "英雄不存在" });
    try {
      return json(response, 200, deleteHero(repository, heroId, user.id));
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const activateMatch = path.match(/^\/api\/heroes\/(\d+)\/activate$/);
  if (method === "POST" && activateMatch) {
    const ok = repository.activateHero(Number(activateMatch[1]), user.id);
    return ok ? json(response, 200, { ok: true }) : json(response, 404, { error: "英雄不存在" });
  }

  const plansMatch = path.match(/^\/api\/heroes\/(\d+)\/plans$/);
  if (method === "GET" && plansMatch) {
    if (!repository.getHero(Number(plansMatch[1]), user.id)) return json(response, 404, { error: "英雄不存在" });
    return json(response, 200, repository.listPlans(Number(plansMatch[1])).map(planDto));
  }

  const actionSettingsMatch = path.match(/^\/api\/heroes\/(\d+)\/action-settings$/);
  if (actionSettingsMatch && (method === "GET" || method === "PUT")) {
    const heroId = Number(actionSettingsMatch[1]);
    if (!repository.getHero(heroId, user.id)) return json(response, 404, { error: "英雄不存在" });
    if (method === "GET") return json(response, 200, actionSettingsDto(repository.getHeroActionSettings(heroId)));
    try {
      return json(response, 200, await readJson(request).then((body) => saveActionSettings(repository, heroId, body, { catalog, root, userId: user.id })));
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const planMatch = path.match(/^\/api\/heroes\/(\d+)\/plans\/(.+)$/);
  if (planMatch && method === "PUT") {
    const heroId = Number(planMatch[1]);
    const name = decodeURIComponent(planMatch[2]);
    if (!repository.getHero(heroId, user.id)) return json(response, 404, { error: "英雄不存在" });
    const body = await readJson(request);
    const row = repository.upsertPlan({
      heroId,
      name,
      mode: body.mode ?? "pve",
      position: body.position ?? "front",
      initiativeSkillId: body.initiativeSkillId ?? null,
      preRound: body.preRound ?? [],
      mainRound: body.mainRound ?? [],
      floorOverrides: body.floorOverrides ?? {},
      general: body.general ?? {},
    });
    return json(response, 200, { ok: true, plan: planDto(row) });
  }

  if (planMatch && method === "GET") {
    if (!repository.getHero(Number(planMatch[1]), user.id)) return json(response, 404, { error: "英雄不存在" });
    const row = repository.getPlan(Number(planMatch[1]), decodeURIComponent(planMatch[2]));
    return row ? json(response, 200, planDto(row)) : json(response, 404, { error: "方案不存在" });
  }

  if (method === "GET" && path === "/api/dungeons") {
    return json(response, 200, repository.listDungeons().map((dungeon) => ({
      id: dungeon.id,
      name: dungeon.name,
      kind: dungeon.kind,
      minLevel: dungeon.min_level,
      maxLevel: dungeon.max_level,
      prepareMinutes: dungeon.prepare_minutes,
      description: dungeon.description,
      enabled: Boolean(dungeon.enabled),
    })));
  }

  if (method === "GET" && path === "/api/dungeons/runs") {
    return json(response, 200, listDungeonRuns(repository, Number(url.searchParams.get("limit") ?? 20), user.id));
  }

  const dungeonRunMatch = path.match(/^\/api\/dungeons\/runs\/(\d+)$/);
  if (method === "GET" && dungeonRunMatch) {
    const detail = getDungeonRunDetail(repository, Number(dungeonRunMatch[1]), user.id);
    return detail ? json(response, 200, detail) : json(response, 404, { error: "地城记录不存在" });
  }

  // 删除战报：记录、名下的战斗战报行与本地展示 JSON 一并删除，不可撤销。
  if (method === "DELETE" && dungeonRunMatch) {
    const result = deleteDungeonRun(repository, Number(dungeonRunMatch[1]), user.id);
    return result ? json(response, 200, result) : json(response, 404, { error: "地城记录不存在" });
  }

  // 探索：固化账号全部角色 + 行动设置 + 地城输入，并同步完成战斗结算。
  const exploreMatch = path.match(/^\/api\/dungeons\/([^/]+)\/explore$/);
  if (method === "POST" && exploreMatch) {
    const body = await readJson(request);
    const result = createDungeonExploration({
      repository,
      catalog,
      root,
      userId: user.id,
      dungeonId: decodeURIComponent(exploreMatch[1]),
      heroId: body.heroId,
      maxFloor: Number(body.maxFloor ?? 10),
      seed: body.seed,
    });
    if (result.error) {
      const status = result.error === "dungeonNotFound" || result.error === "heroNotFound" || result.error === "noEncounter" ? 404 : 400;
      return json(response, status, { error: result.error });
    }
    return json(response, 201, result);
  }

  const runMatch = path.match(/^\/api\/dungeons\/([^/]+)\/run$/);
  if (method === "POST" && runMatch) {
    const body = await readJson(request);
    if (!repository.getHero(body.heroId, user.id)) return json(response, 404, { error: "英雄不存在" });
    const result = runDungeon({
      repository,
      catalog,
      heroId: body.heroId,
      dungeonId: decodeURIComponent(runMatch[1]),
      planName: body.planName,
      maxFloor: Number(body.maxFloor ?? body.floorNumber ?? 10),
      seed: body.seed,
      maxRounds: body.maxRounds,
    });
    if (result.error) {
      const status = result.error === "heroNotFound" || result.error === "dungeonNotFound" ? 404 : 400;
      return json(response, status, { error: result.error });
    }
    return json(response, 200, result);
  }

  if (method === "POST" && path === "/api/dungeons/floor-run") {
    const body = await readJson(request);
    if (!repository.getHero(body.heroId, user.id)) return json(response, 404, { error: "英雄不存在" });
    const result = runDungeonFloor({
      repository,
      catalog,
      heroId: body.heroId,
      dungeonId: body.dungeonId,
      planName: body.planName,
      floorNumber: Number(body.floorNumber ?? 1),
      seed: body.seed,
      maxRounds: body.maxRounds,
    });
    return result.error ? json(response, 400, { error: result.error }) : json(response, 200, result);
  }

  if (method === "GET" && path === "/api/battles") {
    return json(response, 200, listBattles(repository, Number(url.searchParams.get("limit") ?? 20), user.id));
  }

  const battleMatch = path.match(/^\/api\/battles\/(\d+)$/);
  if (method === "GET" && battleMatch) {
    const detail = getBattleDetail(repository, Number(battleMatch[1]), user.id);
    return detail ? json(response, 200, detail) : json(response, 404, { error: "战报不存在" });
  }

  if (method === "POST" && path === "/api/simulate") {
    const body = await readJson(request);
    if (!repository.getHero(body.heroId, user.id)) return json(response, 404, { error: "英雄不存在" });
    const result = runDungeon({
      repository,
      catalog,
      heroId: body.heroId,
      dungeonId: body.dungeonId ?? "rowdy-tavern",
      planName: body.planName,
      maxFloor: Number(body.maxFloor ?? 10),
      seed: body.seed,
    });
    return result.error ? json(response, 400, { error: result.error }) : json(response, 200, result);
  }

  if (method === "POST" && path === "/api/catalog/reload") {
    catalog = loadCatalog({ fallback: catalogFallback });
    return json(response, 200, { ok: true, contentVersion: catalog.contentVersion, counts: catalog.counts });
  }

  return false;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await api(request, response, url);
      if (handled !== false) return;
      return json(response, 404, { error: "接口不存在" });
    }
    if (vite) {
      vite.middlewares(request, response, () => json(response, 404, { error: "页面不存在" }));
      return;
    }
    return json(response, 404, { error: "页面不存在（--no-vite 模式仅提供 API）" });
  } catch (error) {
    console.error(error);
    json(response, 500, { error: "服务器错误", detail: String(error?.message ?? error) });
  }
});

server.listen(port, host, () => {
  console.log(`Local WOD running at http://${host}:${port}`);
  console.log(`启动耗时：数据库就绪 ${startupTiming.databaseOpenedMs} ms · 内容目录解析 ${startupTiming.catalogLoadMs} ms（Vite 首屏转译在首次请求时进行）`);
});
