// SQLite 持久化。所有 SQL 只出现在这一层，领域层与公式层不接触数据库。
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ONE_HAND_SLOT_ID, equipSlotIdForItemSlot, handOccupancy } from "../../game/domain/item.mjs";

/**
 * `items.slot` 是源数据库的中文部位名；“单手”在 equip_slot 表中不存在，映射为派生部位。
 * 其他取值直接使用 equip_slot 的稳定英文 ID；“不可装备”等返回 null。
 */
/** 手部相关部位；双手规则只关心这些部位，护甲等无关部位不参与判定。 */
const HAND_SLOT_IDS = Object.freeze(["two_hands", "right_hand", "left_hand", ONE_HAND_SLOT_ID]);

/**
 * dungeon_runs.levels_json 里的战斗编号。
 * 新格式在每层写 `battleIds`，旧格式只嵌在 `battles[].battleId`，两种都要认。
 */
function battleIdsOfDungeonRun(levelsJson) {
  let levels;
  try {
    levels = JSON.parse(levelsJson ?? "[]");
  } catch {
    return [];
  }
  const ids = [];
  for (const level of Array.isArray(levels) ? levels : []) {
    const listed = Array.isArray(level?.battleIds)
      ? level.battleIds
      : Array.isArray(level?.battles) ? level.battles.map((battle) => battle?.battleId) : [];
    for (const value of listed) {
      const id = Number(value);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/** 双手武器需要两只手都空闲。 */
function handsAreFree(occupiedSlots) {
  return !occupiedSlots.some((slot) => HAND_SLOT_IDS.includes(slot));
}

/** 已装备部位 ID 列表（含派生部位），供手部占用判定使用。 */
function equippedSlotIds(db, heroId) {
  // hero_inventory.equip_slot 存的是 equip_slot 表的英文 ID，players 由 createHero/setItemEquipped 写入；
  // items.slot 存的是中文部位名，需要经过 equipSlotIdFor 映射。
  return db.prepare(`SELECT hi.equip_slot, i.slot item_slot FROM hero_inventory hi
    JOIN item_instances ii ON ii.id=hi.item_instance_id JOIN items i ON i.id=ii.item_id
    WHERE hi.hero_id=? AND hi.is_equipped=1`).all(Number(heroId))
    .map((row) => row.equip_slot || equipSlotIdForItemSlot(row.item_slot))
    .filter(Boolean);
}

/**
 * 打开运行时数据库。
 *
 * This function opens an existing runtime database. It never creates schema,
 * migrates, seeds, or repairs a database.
 *
 * @param {string} dbPath
 * @param {object} [options]
 */
export function openDatabase(dbPath, options = {}) {
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${resolve(dbPath)}. Restore it from backup.`);
  const db = new DatabaseSync(dbPath);
  DATABASE_PATHS.set(db, {
    databasePath: resolve(dbPath),
    reportDirectory: resolve(options.reportDirectory ?? join(dirname(dbPath), "dungeon_report")),
  });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

const DATABASE_PATHS = new WeakMap();

// 已软删除的角色（deleted_at 非空）不出现在任何角色入口；战报查询各自 JOIN heroes，
// 不经过这里，因此删除角色不会让历史战报消失。
const HERO_SELECT = `SELECT h.*, p.name profession_name, r.name race_name
  FROM heroes h
  JOIN professions p ON p.id = h.profession_id
  JOIN races r ON r.id = h.race_id
  WHERE h.deleted_at IS NULL`;

export function createRepository(db) {
  const storage = DATABASE_PATHS.get(db) ?? {
    databasePath: join(process.cwd(), "data", "game.sqlite"),
    reportDirectory: join(process.cwd(), "data", "dungeon_report"),
  };
  const databasePath = storage.databasePath;
  const reportDirectory = storage.reportDirectory;
  const reportPath = (jsonPath) => {
    const resolvedPath = resolve(dirname(databasePath), String(jsonPath));
    const fromReportDirectory = relative(reportDirectory, resolvedPath);
    if (fromReportDirectory.startsWith("..") || fromReportDirectory.includes(":")) throw new Error("战报索引路径无效");
    return resolvedPath;
  };
  const reportForBattle = (row) => {
    const document = JSON.parse(readFileSync(reportPath(row.json_path), "utf8"));
    if (document.version !== 3 || document.kind !== "display-only-dungeon-report" || !Array.isArray(document.battles)) throw new Error("不支持的战报格式");
    const report = document.battles.find((battle) => Number(battle.battleId) === Number(row.id));
    if (!report) throw new Error(`战报文件缺少战斗索引: ${row.id}`);
    return report;
  };

  /**
   * 删除 battle_runs 行，并给出按 JSON 文件归组的清理计划。
   *
   * 调用方负责事务：同一次运行的多次战斗共用同一个 JSON 文件（见 insertBattleRun），
   * 因此必须先删库、提交事务，再按「还有没有别的战斗引用这个文件」决定删文件还是重写，
   * 否则事务回滚后文件已经消失，而行还在。
   */
  function deleteBattleRunRows(battleIds) {
    const deletedBattleIds = [];
    const paths = new Set();
    for (const value of battleIds ?? []) {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) continue;
      const row = db.prepare("SELECT id,json_path FROM battle_runs WHERE id=?").get(id);
      if (!row) continue;
      db.prepare("DELETE FROM battle_runs WHERE id=?").run(id);
      deletedBattleIds.push(Number(row.id));
      paths.add(String(row.json_path));
    }
    const plan = [...paths].map((jsonPath) => ({
      jsonPath,
      remainingBattleIds: db.prepare("SELECT id FROM battle_runs WHERE json_path=?").all(jsonPath).map((row) => Number(row.id)),
    }));
    return { deletedBattleIds, plan };
  }

  /** 事务提交后清理本地战报 JSON：无人引用则删文件，仍有战斗引用则重写并去掉已删战斗。 */
  function cleanupReportFiles(plan) {
    const removedReportFiles = [];
    const rewrittenReportFiles = [];
    const warnings = [];
    for (const entry of plan) {
      let filePath;
      try {
        filePath = reportPath(entry.jsonPath);
      } catch (error) {
        warnings.push(`战报索引路径无效，未处理本地文件：${entry.jsonPath}（${error.message}）`);
        continue;
      }
      if (!existsSync(filePath)) continue;
      if (entry.remainingBattleIds.length === 0) {
        try {
          unlinkSync(filePath);
          removedReportFiles.push(entry.jsonPath);
        } catch (error) {
          warnings.push(`删除战报文件失败：${entry.jsonPath}（${error.message}）`);
        }
        continue;
      }
      try {
        const document = JSON.parse(readFileSync(filePath, "utf8"));
        const keep = new Set(entry.remainingBattleIds.map(String));
        document.battles = (Array.isArray(document.battles) ? document.battles : []).filter((battle) => keep.has(String(battle?.battleId)));
        writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
        rewrittenReportFiles.push(entry.jsonPath);
      } catch (error) {
        warnings.push(`重写战报文件失败：${entry.jsonPath}（${error.message}）`);
      }
    }
    return { removedReportFiles, rewrittenReportFiles, warnings };
  }

  return {
    raw: db,

    schemaMeta() {
      return Object.fromEntries(db.prepare("SELECT key, value FROM schema_meta").all().map((row) => [row.key, row.value]));
    },

    listAttackTypes() { return db.prepare("SELECT id,name,sort_order FROM attack_types ORDER BY sort_order").all(); },
    listDamageTypes() { return db.prepare("SELECT id,name,sort_order FROM damage_types ORDER BY sort_order").all(); },
    listProfessions() { return db.prepare("SELECT id,name FROM professions ORDER BY name").all(); },
    listRaces() { return db.prepare("SELECT id,name FROM races ORDER BY name").all(); },
    listMarketItems({ query = "", limit = 20, offset = 0 } = {}) {
      const clauses = ["active=1"];
      const parameters = [];
      if (query) { clauses.push("name LIKE ?"); parameters.push(`%${query}%`); }
      parameters.push(Math.max(1, Math.min(Number(limit) || 20, 100)), Math.max(0, Number(offset) || 0));
      return db.prepare(`SELECT id,name,slot,min_level,max_level FROM items
        WHERE ${clauses.join(" AND ")} ORDER BY name,id LIMIT ? OFFSET ?`).all(...parameters);
    },
    countMarketItems({ query = "" } = {}) {
      const clauses = ["active=1"];
      const parameters = [];
      if (query) { clauses.push("name LIKE ?"); parameters.push(`%${query}%`); }
      return Number(db.prepare(`SELECT COUNT(*) total FROM items WHERE ${clauses.join(" AND ")}`).get(...parameters).total);
    },
    findItemByName(name) {
      return db.prepare(`SELECT id,name,slot,min_level,max_level FROM items
        WHERE name=? COLLATE NOCASE ORDER BY active DESC,id LIMIT 1`).get(String(name));
    },
    listItemSets() {
      return db.prepare("SELECT DISTINCT set_name AS id,set_name AS name FROM item_sets ORDER BY set_name").all();
    },
    getItemSetEffect(setName, pieceCount) {
      return db.prepare("SELECT set_name,piece_count,effect_json_path FROM item_sets WHERE set_name=? AND piece_count=?")
        .get(String(setName), Number(pieceCount));
    },
    getSkillDetailMetadata(scope, skillId) {
      return db.prepare("SELECT scope,skill_id,skill_name,source_table,json_path,content_hash,parsed_at FROM skill_detail_metadata WHERE scope=? AND skill_id=?")
        .get(String(scope), Number(skillId));
    },
    getItemDetailMetadata(itemId) {
      return db.prepare(`SELECT m.item_id,m.source_table,m.json_path,m.content_hash,m.parsed_at,i.name,i.slot
        FROM item_detail_metadata m JOIN items i ON i.id=m.item_id WHERE m.item_id=?`).get(Number(itemId));
    },

    listSummonArchetypes() {
      return db.prepare("SELECT id,name,description,active,created_at,updated_at FROM summon_archetypes ORDER BY name,id").all();
    },
    getSummonArchetype(id) {
      return db.prepare("SELECT id,name,description,active,created_at,updated_at FROM summon_archetypes WHERE id=?").get(String(id));
    },
    createSummonArchetype(entry) {
      db.prepare("INSERT INTO summon_archetypes(id,name,description,active) VALUES(?,?,?,?)")
        .run(entry.id, entry.name, entry.description, entry.active ? 1 : 0);
      return this.getSummonArchetype(entry.id);
    },
    updateSummonArchetype(id, entry) {
      db.prepare(`UPDATE summon_archetypes SET name=?,description=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(entry.name, entry.description, entry.active ? 1 : 0, String(id));
      return this.getSummonArchetype(id);
    },
    deleteSummonArchetype(id) {
      return Number(db.prepare("DELETE FROM summon_archetypes WHERE id=?").run(String(id)).changes);
    },
    listSummonDefinitions() {
      return db.prepare(`SELECT sd.*,mi.name medium_item_name,si.name summon_item_name
        FROM summon_definitions sd LEFT JOIN items mi ON mi.id=sd.medium_item_id JOIN items si ON si.id=sd.summon_item_id
        ORDER BY sd.archetype_id,sd.sort_order,sd.tier,sd.id`).all();
    },
    getSummonDefinition(id) {
      return db.prepare("SELECT * FROM summon_definitions WHERE id=?").get(Number(id));
    },
    findOverlappingSummonDefinition(entry, excludedId = null) {
      return db.prepare(`SELECT id,summon_name,min_summon_skill_level,max_summon_skill_level
        FROM summon_definitions
        WHERE archetype_id=? AND summon_skill_id=? AND recipe_type=?
          AND COALESCE(medium_item_id,-1)=COALESCE(?,-1) AND summon_item_id=?
          AND (? IS NULL OR id<>?)
          AND min_summon_skill_level<=COALESCE(?,2147483647)
          AND COALESCE(max_summon_skill_level,2147483647)>=?
        LIMIT 1`).get(
          entry.archetypeId, entry.summonSkillId, entry.recipeType, entry.mediumItemId, entry.summonItemId,
          excludedId, excludedId, entry.maxSummonSkillLevel, entry.minSummonSkillLevel,
        );
    },
    createSummonDefinition(entry) {
      const result = db.prepare(`INSERT INTO summon_definitions(
        archetype_id,summon_skill_id,recipe_type,medium_item_id,summon_item_id,summon_name,tier,summon_level_expr,
        min_summon_skill_level,max_summon_skill_level,default_position,strength_expr,constitution_expr,intelligence_expr,
        dexterity_expr,charisma_expr,agility_expr,perception_expr,willpower_expr,metadata_json,sort_order,active,actions_per_round_expr
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        entry.archetypeId, entry.summonSkillId, entry.recipeType, entry.mediumItemId, entry.summonItemId,
        entry.summonName, entry.tier, entry.summonLevelExpr, entry.minSummonSkillLevel, entry.maxSummonSkillLevel,
        entry.defaultPosition, entry.strengthExpr, entry.constitutionExpr, entry.intelligenceExpr, entry.dexterityExpr,
        entry.charismaExpr, entry.agilityExpr, entry.perceptionExpr, entry.willpowerExpr, entry.metadataJson,
        entry.sortOrder, entry.active ? 1 : 0, entry.actionsPerRoundExpr,
      );
      return this.getSummonDefinition(Number(result.lastInsertRowid));
    },
    updateSummonDefinition(id, entry) {
      db.prepare(`UPDATE summon_definitions SET
        archetype_id=?,summon_skill_id=?,recipe_type=?,medium_item_id=?,summon_item_id=?,summon_name=?,tier=?,summon_level_expr=?,
        min_summon_skill_level=?,max_summon_skill_level=?,default_position=?,strength_expr=?,constitution_expr=?,intelligence_expr=?,
        dexterity_expr=?,charisma_expr=?,agility_expr=?,perception_expr=?,willpower_expr=?,metadata_json=?,sort_order=?,active=?,actions_per_round_expr=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(
          entry.archetypeId, entry.summonSkillId, entry.recipeType, entry.mediumItemId, entry.summonItemId,
          entry.summonName, entry.tier, entry.summonLevelExpr, entry.minSummonSkillLevel, entry.maxSummonSkillLevel,
          entry.defaultPosition, entry.strengthExpr, entry.constitutionExpr, entry.intelligenceExpr, entry.dexterityExpr,
          entry.charismaExpr, entry.agilityExpr, entry.perceptionExpr, entry.willpowerExpr, entry.metadataJson,
          entry.sortOrder, entry.active ? 1 : 0, entry.actionsPerRoundExpr, Number(id),
        );
      return this.getSummonDefinition(id);
    },
    deleteSummonDefinition(id) {
      return Number(db.prepare("DELETE FROM summon_definitions WHERE id=?").run(Number(id)).changes);
    },
    getCatalogSkill(id) { return db.prepare("SELECT id,name FROM skills WHERE id=?").get(String(id)); },
    getCatalogItem(id) { return db.prepare("SELECT id,name FROM items WHERE id=?").get(Number(id)); },
    searchSummonSkills(query = "", limit = 20) {
      const term = String(query).trim();
      return db.prepare(`SELECT id,skill_id,source_skill_id,skill_name,skill_type,active FROM summon_skills
        WHERE (?='' OR skill_name LIKE ? OR CAST(id AS TEXT)=?)
        ORDER BY active DESC,skill_name,id LIMIT ?`).all(term, `%${term}%`, term, Math.max(1, Math.min(Number(limit) || 20, 100)));
    },
    countSummonSkills(query = "") {
      const term = String(query).trim();
      return Number(db.prepare(`SELECT COUNT(*) total FROM summon_skills WHERE (?='' OR skill_name LIKE ? OR CAST(id AS TEXT)=?)`)
        .get(term, `%${term}%`, term).total);
    },
    getSummonSkill(id) { return db.prepare("SELECT id,skill_id,source_skill_id,skill_name,skill_type,active FROM summon_skills WHERE id=?").get(Number(id)); },
    listSummonSkillAssignments() {
      return db.prepare(`SELECT sas.*,ss.skill_name,ss.skill_type FROM summon_archetype_skills sas
        JOIN summon_skills ss ON ss.id=sas.summon_skill_id
        ORDER BY sas.archetype_id,sas.sort_order,ss.skill_name`).all();
    },
    getSummonSkillAssignment(archetypeId, skillId) {
      return db.prepare(`SELECT sas.*,ss.skill_name,ss.skill_type FROM summon_archetype_skills sas
        JOIN summon_skills ss ON ss.id=sas.summon_skill_id WHERE sas.archetype_id=? AND sas.summon_skill_id=?`)
        .get(String(archetypeId), Number(skillId));
    },
    saveSummonSkillAssignment(entry) {
      db.prepare(`INSERT INTO summon_archetype_skills(archetype_id,summon_skill_id,unlock_summon_skill_level,skill_level_expr,sort_order,active)
        VALUES(?,?,?,?,?,?) ON CONFLICT(archetype_id,summon_skill_id) DO UPDATE SET
        unlock_summon_skill_level=excluded.unlock_summon_skill_level,skill_level_expr=excluded.skill_level_expr,
        sort_order=excluded.sort_order,active=excluded.active`).run(
          entry.archetypeId, entry.summonSkillId, entry.unlockSummonSkillLevel, entry.skillLevelExpr, entry.sortOrder, entry.active ? 1 : 0,
        );
      return this.getSummonSkillAssignment(entry.archetypeId, entry.summonSkillId);
    },
    deleteSummonSkillAssignment(archetypeId, skillId) {
      return Number(db.prepare("DELETE FROM summon_archetype_skills WHERE archetype_id=? AND summon_skill_id=?")
        .run(String(archetypeId), Number(skillId)).changes);
    },
    getSummonActionSettings(definitionId) {
      return db.prepare("SELECT * FROM summon_action_settings WHERE summon_definition_id=?").get(Number(definitionId));
    },
    upsertSummonActionSettings(definitionId, settings) {
      db.prepare(`INSERT INTO summon_action_settings(summon_definition_id,settings_json,updated_at)
        VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(summon_definition_id) DO UPDATE SET
        settings_json=excluded.settings_json,updated_at=CURRENT_TIMESTAMP`).run(Number(definitionId), JSON.stringify(settings));
      return this.getSummonActionSettings(definitionId);
    },

    createUser(user) {
      const result = db.prepare("INSERT INTO users (username,password_hash,password_salt) VALUES (?,?,?)")
        .run(user.username, user.passwordHash, user.passwordSalt);
      return this.getUserById(Number(result.lastInsertRowid));
    },

    getUserById(id) { return db.prepare("SELECT id,username,created_at FROM users WHERE id=?").get(Number(id)); },
    getUserByUsername(username) { return db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(String(username)); },
    createSession(session) { db.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)").run(session.id, session.userId, session.expiresAt); },
    getSession(id) { return db.prepare(`SELECT s.id,s.expires_at,u.id user_id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND datetime(s.expires_at)>CURRENT_TIMESTAMP`).get(String(id)); },
    deleteSession(id) { db.prepare("DELETE FROM sessions WHERE id=?").run(String(id)); },

    listHeroes(userId) {
      const scope = userId == null ? "" : " AND h.user_id = ?";
      return db.prepare(`${HERO_SELECT}${scope} ORDER BY h.active DESC, h.level DESC, h.id`).all(...(userId == null ? [] : [Number(userId)]));
    },

    getHero(id, userId) {
      const scope = userId == null ? "" : " AND h.user_id = ?";
      return db.prepare(`${HERO_SELECT} AND h.id = ?${scope}`).get(...(userId == null ? [Number(id)] : [Number(id), Number(userId)]));
    },

    /**
     * 新建角色。
     *
     * 角色创建时不发放任何物品，也不装备任何东西：`profession_starting_items`
     * 只用于导入器判断哪些物品需要抓取详情页，起步装备完全由玩家自行准备。
     */
    createHero(userId, hero) {
      const profession = db.prepare("SELECT id FROM professions WHERE id=?").get(hero.professionId);
      const race = db.prepare("SELECT id FROM races WHERE id=?").get(hero.raceId);
      if (!profession || !race) throw new Error("种族或职业不存在");
      const result = db.prepare(`INSERT INTO heroes
        (user_id,name,profession_id,race_id,gender,experience,current_experience,total_experience,gold,active,next_dungeon_at)
        VALUES (?,?,?,?,?,300,300,300,1000,CASE WHEN EXISTS(SELECT 1 FROM heroes WHERE user_id=? AND deleted_at IS NULL) THEN 0 ELSE 1 END,'立刻')`)
        .run(Number(userId), hero.name, hero.professionId, hero.raceId, hero.gender, Number(userId));
      return this.getHero(Number(result.lastInsertRowid), userId);
    },

    /**
     * 删除角色。
     *
     * `battle_runs.hero_id` / `dungeon_runs.hero_id` 是指向 heroes 的 NOT NULL 外键，
     * 真删角色行会连带毁掉战报，因此删除实现为**软删除**：写入 `deleted_at` 让角色从
     * 所有角色入口消失，战报仍保留原 hero_id 并可继续按账号查看。
     *
     * 角色名下（含已装备）的物品全部转入账号的团队仓库，不销毁任何实例。
     * 删除的是当前角色时，把账号内剩下的角色里等级最高的一位设为当前角色。
     *
     * @returns {{heroId: number, movedItemCount: number}}
     */
    deleteHero(heroId, userId) {
      const hero = this.getHero(heroId, userId);
      if (!hero) throw new Error("英雄不存在");
      // 物品要落到持有者账号的团队仓库；未指定账号时以角色自己的账号为准。
      const ownerId = userId == null ? Number(hero.user_id) : Number(userId);
      db.exec("BEGIN IMMEDIATE");
      try {
        const instances = db.prepare("SELECT item_instance_id FROM hero_inventory WHERE hero_id=?")
          .all(Number(heroId)).map((row) => Number(row.item_instance_id));
        const store = db.prepare("INSERT OR IGNORE INTO team_inventory(user_id,item_instance_id) VALUES(?,?)");
        for (const instanceId of instances) store.run(ownerId, instanceId);
        db.prepare("DELETE FROM hero_equipment WHERE hero_id=?").run(Number(heroId));
        db.prepare("DELETE FROM hero_inventory WHERE hero_id=?").run(Number(heroId));
        db.prepare("UPDATE heroes SET active=0, deleted_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND deleted_at IS NULL")
          .run(Number(heroId), ownerId);
        db.prepare(`UPDATE heroes SET active=1 WHERE id=(
            SELECT id FROM heroes WHERE user_id=? AND deleted_at IS NULL ORDER BY active DESC, level DESC, id LIMIT 1)`)
          .run(ownerId);
        db.exec("COMMIT");
        return { heroId: Number(heroId), movedItemCount: instances.length };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    buyMarketItem(heroId, userId, itemId, price = 1) {
      const hero = this.getHero(heroId, userId);
      if (!hero) throw new Error("英雄不存在");
      const item = db.prepare("SELECT id,name FROM items WHERE id=? AND active=1").get(Number(itemId));
      if (!item) throw new Error("市场中没有该物品");
      const cost = Number(price);
      if (Number(hero.gold) < cost) throw new Error("金币不足");
      db.exec("BEGIN IMMEDIATE");
      try {
        const charged = db.prepare("UPDATE heroes SET gold=gold-? WHERE id=? AND user_id=? AND gold>=?")
          .run(cost, Number(heroId), Number(userId), cost);
        if (Number(charged.changes) !== 1) throw new Error("金币不足");
        const instanceId = Number(db.prepare("INSERT INTO item_instances(item_id) VALUES(?)").run(Number(itemId)).lastInsertRowid);
        db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)")
          .run(Number(heroId), instanceId);
        db.exec("COMMIT");
        return { instanceId, itemId: Number(itemId), name: item.name, price: cost, gold: Number(hero.gold) - cost };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },

    listHeroInventory(heroId, userId) {
      if (!this.getHero(heroId, userId)) return null;
      // hero_equipment 是槽位分配的权威来源。历史导入可能只留下 hero_inventory.is_equipped，
      // 若在这里信任该缓存标记，装备页会把并未穿戴的“幽灵装备”带入整套提交。
      return db.prepare(`SELECT hi.hero_id,hi.item_instance_id,
        CASE WHEN he.item_instance_id IS NULL THEN 0 ELSE 1 END is_equipped,
        he.equip_slot,hi.acquired_at,
        i.id item_id,i.name,i.slot item_slot,i.min_level,i.max_level
        FROM hero_inventory hi
        LEFT JOIN hero_equipment he ON he.hero_id=hi.hero_id AND he.item_instance_id=hi.item_instance_id
        JOIN item_instances ii ON ii.id=hi.item_instance_id JOIN items i ON i.id=ii.item_id
        WHERE hi.hero_id=? ORDER BY is_equipped DESC,i.slot,i.name,hi.item_instance_id`).all(Number(heroId));
    },

    listTeamInventory(userId) {
      return db.prepare(`SELECT ti.user_id,ti.item_instance_id,ti.stored_at,i.id item_id,i.name,i.slot item_slot,i.min_level,i.max_level
        FROM team_inventory ti JOIN item_instances ii ON ii.id=ti.item_instance_id JOIN items i ON i.id=ii.item_id
        WHERE ti.user_id=? ORDER BY i.slot,i.name,ti.item_instance_id`).all(Number(userId));
    },

    setItemEquipped(heroId, userId, instanceId, equipped) {
      const hero = this.getHero(heroId, userId);
      if (!hero) throw new Error("英雄不存在");
      const row = db.prepare(`SELECT hi.*,i.slot item_slot,i.name item_name FROM hero_inventory hi JOIN item_instances ii ON ii.id=hi.item_instance_id
        JOIN items i ON i.id=ii.item_id WHERE hi.hero_id=? AND hi.item_instance_id=?`).get(Number(heroId), Number(instanceId));
      if (!row) throw new Error("物品不在该角色仓库");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (equipped) {
          const slotId = equipSlotIdForItemSlot(row.item_slot);
          if (!slotId) throw new Error("该物品不可装备");
          const occupiedSlots = equippedSlotIds(db, heroId);
          const others = occupiedSlots.filter((slot) => slot !== slotId);
          if (slotId === ONE_HAND_SLOT_ID && !handOccupancy(others).canEquipOneHand) {
            throw new Error("双手已被占用，无法再装备单手物品");
          }
          if (slotId === "two_hands" && !handsAreFree(others)) {
            throw new Error("需要空闲的双手才能装备双手物品");
          }
          // 同一部位只允许一件实例：新物品顶替旧物品，旧物品回到角色仓库（仍保留实例）。
          // 注意必须按目标部位 slotId 查询，而不是 hero_inventory.equip_slot——待装备实例
          // 此刻一定处于未装备状态，该列为 NULL。
          const replaced = db.prepare("SELECT item_instance_id FROM hero_equipment WHERE hero_id=? AND equip_slot=?")
            .all(Number(heroId), slotId).map((entry) => entry.item_instance_id);
          for (const previous of replaced) {
            db.prepare("DELETE FROM hero_equipment WHERE hero_id=? AND item_instance_id=?").run(Number(heroId), previous);
            db.prepare("UPDATE hero_inventory SET is_equipped=0,equip_slot=NULL WHERE hero_id=? AND item_instance_id=?").run(Number(heroId), previous);
          }
          db.prepare("INSERT INTO hero_equipment(hero_id,equip_slot,item_instance_id) VALUES(?,?,?)").run(Number(heroId), slotId, Number(instanceId));
          db.prepare("UPDATE hero_inventory SET is_equipped=1,equip_slot=? WHERE hero_id=? AND item_instance_id=?").run(slotId, Number(heroId), Number(instanceId));
        } else {
          db.prepare("DELETE FROM hero_equipment WHERE hero_id=? AND item_instance_id=?").run(Number(heroId), Number(instanceId));
          db.prepare("UPDATE hero_inventory SET is_equipped=0,equip_slot=NULL WHERE hero_id=? AND item_instance_id=?").run(Number(heroId), Number(instanceId));
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return this.listHeroInventory(heroId, userId);
    },

    /** 用一份完整槽位草稿原子替换角色装备；任一选择失败则全部回滚。 */
    replaceHeroEquipment(heroId, userId, assignments = []) {
      if (!this.getHero(heroId, userId)) throw new Error("英雄不存在");
      const seenSlots = new Set();
      const seenInstances = new Set();
      const rows = assignments.map((assignment) => {
        const slotId = String(assignment.slotId);
        const baseSlot = String(assignment.baseSlot ?? slotId.split(":", 1)[0]);
        const instanceId = Number(assignment.instanceId);
        if (seenSlots.has(slotId)) throw new Error("装备槽位重复");
        if (seenInstances.has(instanceId)) throw new Error("同一物品不能装备到多个槽位");
        seenSlots.add(slotId); seenInstances.add(instanceId);
        const row = db.prepare(`SELECT i.slot item_slot FROM hero_inventory hi
          JOIN item_instances ii ON ii.id=hi.item_instance_id JOIN items i ON i.id=ii.item_id
          WHERE hi.hero_id=? AND hi.item_instance_id=?`).get(Number(heroId), instanceId);
        if (!row) throw new Error("物品不在该角色仓库");
        const itemSlot = equipSlotIdForItemSlot(row.item_slot);
        const fits = itemSlot === baseSlot || (itemSlot === ONE_HAND_SLOT_ID && (baseSlot === "right_hand" || baseSlot === "left_hand"));
        if (!fits) throw new Error("物品与装备槽位不匹配");
        return { slotId, baseSlot, instanceId };
      });
      const occupied = rows.map((row) => row.baseSlot);
      if (occupied.includes("two_hands") && occupied.some((slot) => slot === "right_hand" || slot === "left_hand")) throw new Error("双手装备与左右手装备冲突");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM hero_equipment WHERE hero_id=?").run(Number(heroId));
        db.prepare("UPDATE hero_inventory SET is_equipped=0,equip_slot=NULL WHERE hero_id=?").run(Number(heroId));
        const equip = db.prepare("INSERT INTO hero_equipment(hero_id,equip_slot,item_instance_id) VALUES(?,?,?)");
        const mark = db.prepare("UPDATE hero_inventory SET is_equipped=1,equip_slot=? WHERE hero_id=? AND item_instance_id=?");
        for (const row of rows) { equip.run(Number(heroId), row.slotId, row.instanceId); mark.run(row.slotId, Number(heroId), row.instanceId); }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return this.listHeroInventory(heroId, userId);
    },

    /**
     * 用物品定义创建全新的角色物品实例，并将它们作为整套装备原子替换。
     * 原有装备实例不会被销毁，只会解除装备并留在角色仓库中。
     */
    replaceHeroEquipmentWithNewInstances(heroId, userId, assignments = []) {
      if (!this.getHero(heroId, userId)) throw new Error("英雄不存在");
      const seenSlots = new Set();
      const rows = assignments.map((assignment) => {
        const slotId = String(assignment.slotId);
        const baseSlot = String(assignment.baseSlot ?? slotId.split(":", 1)[0]);
        const itemId = Number(assignment.itemId);
        if (seenSlots.has(slotId)) throw new Error("装备槽位重复");
        seenSlots.add(slotId);
        const item = db.prepare("SELECT id,name,slot FROM items WHERE id=?").get(itemId);
        if (!item) throw new Error("物品不存在");
        const itemSlot = equipSlotIdForItemSlot(item.slot);
        const fits = itemSlot === baseSlot || (itemSlot === ONE_HAND_SLOT_ID && (baseSlot === "right_hand" || baseSlot === "left_hand"));
        if (!fits) throw new Error("物品与装备槽位不匹配");
        return { slotId, baseSlot, itemId, item };
      });
      const occupied = rows.map((row) => row.baseSlot);
      if (occupied.includes("two_hands") && occupied.some((slot) => slot === "right_hand" || slot === "left_hand")) throw new Error("双手装备与左右手装备冲突");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM hero_equipment WHERE hero_id=?").run(Number(heroId));
        db.prepare("UPDATE hero_inventory SET is_equipped=0,equip_slot=NULL WHERE hero_id=?").run(Number(heroId));
        const createInstance = db.prepare("INSERT INTO item_instances(item_id) VALUES(?)");
        const store = db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,1,?)");
        const equip = db.prepare("INSERT INTO hero_equipment(hero_id,equip_slot,item_instance_id) VALUES(?,?,?)");
        const created = [];
        for (const row of rows) {
          const instanceId = Number(createInstance.run(row.itemId).lastInsertRowid);
          store.run(Number(heroId), instanceId, row.slotId);
          equip.run(Number(heroId), row.slotId, instanceId);
          created.push({ ...row, instanceId, name: row.item.name });
        }
        db.exec("COMMIT");
        return created;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },

    /** 人物卡专用：优先复用角色/团队仓库实例，否则按物品定义新建，再按卡面槽位原样穿戴。 */
    replaceHeroEquipmentFromCard(heroId, userId, assignments = []) {
      if (!this.getHero(heroId, userId)) throw new Error("英雄不存在");
      const rows = assignments.map((assignment) => {
        const item = db.prepare("SELECT id,name FROM items WHERE id=?").get(Number(assignment.itemId));
        if (!item) throw new Error(`物品已不在物品表：${assignment.entry?.name ?? assignment.itemId}`);
        const source = String(assignment.inventorySource ?? "catalog");
        const instanceId = assignment.instanceId == null ? null : Number(assignment.instanceId);
        if (source === "hero") {
          const owned = db.prepare(`SELECT 1 FROM hero_inventory hi JOIN item_instances ii ON ii.id=hi.item_instance_id
            WHERE hi.hero_id=? AND hi.item_instance_id=? AND ii.item_id=?`).get(Number(heroId), instanceId, Number(item.id));
          if (!owned) throw new Error(`物品已不在角色仓库：${item.name}`);
        } else if (source === "team") {
          const stored = db.prepare(`SELECT 1 FROM team_inventory ti JOIN item_instances ii ON ii.id=ti.item_instance_id
            WHERE ti.user_id=? AND ti.item_instance_id=? AND ii.item_id=?`).get(Number(userId), instanceId, Number(item.id));
          if (!stored) throw new Error(`物品已不在团队仓库：${item.name}`);
        }
        return { slotId: String(assignment.slotId), itemId: Number(item.id), item, source, instanceId };
      });
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM hero_equipment WHERE hero_id=?").run(Number(heroId));
        db.prepare("UPDATE hero_inventory SET is_equipped=0,equip_slot=NULL WHERE hero_id=?").run(Number(heroId));
        const createInstance = db.prepare("INSERT INTO item_instances(item_id) VALUES(?)");
        const store = db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,1,?)");
        const equip = db.prepare("INSERT INTO hero_equipment(hero_id,equip_slot,item_instance_id) VALUES(?,?,?)");
        const created = [];
        for (const row of rows) {
          let instanceId = row.instanceId;
          if (row.source === "team") {
            db.prepare("DELETE FROM team_inventory WHERE user_id=? AND item_instance_id=?").run(Number(userId), instanceId);
            db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)")
              .run(Number(heroId), instanceId);
          } else if (row.source !== "hero") {
            instanceId = Number(createInstance.run(row.itemId).lastInsertRowid);
            store.run(Number(heroId), instanceId, row.slotId);
          }
          equip.run(Number(heroId), row.slotId, instanceId);
          db.prepare("UPDATE hero_inventory SET is_equipped=1,equip_slot=? WHERE hero_id=? AND item_instance_id=?")
            .run(row.slotId, Number(heroId), instanceId);
          created.push({ ...row, instanceId, name: row.item.name });
        }
        db.exec("COMMIT");
        return created;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    moveItemToTeam(heroId, userId, instanceId) {
      if (!this.getHero(heroId, userId)) throw new Error("英雄不存在");
      const row = db.prepare("SELECT is_equipped FROM hero_inventory WHERE hero_id=? AND item_instance_id=?").get(Number(heroId), Number(instanceId));
      if (!row) throw new Error("物品不在该角色仓库");
      if (row.is_equipped) throw new Error("请先卸下装备");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM hero_inventory WHERE hero_id=? AND item_instance_id=?").run(Number(heroId), Number(instanceId));
        db.prepare("INSERT INTO team_inventory(user_id,item_instance_id) VALUES(?,?)").run(Number(userId), Number(instanceId));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },

    moveItemToHero(userId, heroId, instanceId) {
      if (!this.getHero(heroId, userId)) throw new Error("英雄不存在");
      const row = db.prepare("SELECT 1 FROM team_inventory WHERE user_id=? AND item_instance_id=?").get(Number(userId), Number(instanceId));
      if (!row) throw new Error("物品不在当前用户的团队仓库");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM team_inventory WHERE user_id=? AND item_instance_id=?").run(Number(userId), Number(instanceId));
        db.prepare("INSERT INTO hero_inventory(hero_id,item_instance_id,is_equipped,equip_slot) VALUES(?,?,0,NULL)").run(Number(heroId), Number(instanceId));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },

    activateHero(id, userId) {
      // 已软删除的角色既不能被激活，也不参与“取消当前角色”。
      const scope = `id = ? AND deleted_at IS NULL${userId == null ? "" : " AND user_id = ?"}`;
      const params = userId == null ? [Number(id)] : [Number(id), Number(userId)];
      db.exec("BEGIN IMMEDIATE");
      try {
        // 先确认目标角色存在且属于该账号，否则非法请求会把当前角色一并清空。
        if (!db.prepare(`SELECT 1 FROM heroes WHERE ${scope}`).get(...params)) {
          db.exec("ROLLBACK");
          return false;
        }
        if (userId == null) db.prepare("UPDATE heroes SET active = 0 WHERE deleted_at IS NULL").run();
        else db.prepare("UPDATE heroes SET active = 0 WHERE user_id = ? AND deleted_at IS NULL").run(Number(userId));
        db.prepare(`UPDATE heroes SET active = 1 WHERE ${scope}`).run(...params);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    /** 原子补充英雄资源；经验同时写入当前、总计与旧版兼容字段。 */
    addHeroResources(id, userId, { experience = 0, gold = 0, fame = 0 } = {}) {
      const scope = userId == null ? "id = ?" : "id = ? AND user_id = ?";
      const params = userId == null ? [Number(id)] : [Number(id), Number(userId)];
      db.exec("BEGIN IMMEDIATE");
      try {
        const hero = db.prepare(`SELECT current_experience,total_experience,gold,fame FROM heroes WHERE ${scope}`).get(...params);
        if (!hero) throw new Error("英雄不存在");
        db.prepare(`UPDATE heroes SET
          experience = experience + ?,
          current_experience = current_experience + ?,
          total_experience = total_experience + ?,
          gold = gold + ?,
          fame = fame + ?
          WHERE ${scope}`).run(Number(experience), Number(experience), Number(experience), Number(gold), Number(fame), ...params);
        db.exec("COMMIT");
        return this.getHero(id, userId);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    /** 满足累计经验门槛时原子提升一级；条件更新防止重复请求连续升级。 */
    upgradeHeroLevel(id, userId, expectedLevel, requiredTotalExperience) {
      const sql = userId == null
        ? "UPDATE heroes SET level=level+1 WHERE id=? AND level=? AND level<40 AND total_experience>=?"
        : "UPDATE heroes SET level=level+1 WHERE id=? AND user_id=? AND level=? AND level<40 AND total_experience>=?";
      const params = userId == null
        ? [Number(id), Number(expectedLevel), Number(requiredTotalExperience)]
        : [Number(id), Number(userId), Number(expectedLevel), Number(requiredTotalExperience)];
      const result = db.prepare(sql).run(...params);
      if (Number(result.changes) !== 1) throw new Error("升级条件已变化，请刷新后重试");
      return this.getHero(id, userId);
    },

    changeHeroAttribute(id, userId, attributeKey, nextValue, experienceChange) {
      const allowed = new Set(["strength", "constitution", "intelligence", "dexterity", "charisma", "agility", "perception", "willpower"]);
      if (!allowed.has(attributeKey)) throw new Error("未知属性");
      const scope = userId == null ? "id = ?" : "id = ? AND user_id = ?";
      const params = userId == null ? [Number(id)] : [Number(id), Number(userId)];
      db.exec("BEGIN IMMEDIATE");
      try {
        const hero = db.prepare(`SELECT ${attributeKey} value, current_experience FROM heroes WHERE ${scope}`).get(...params);
        if (!hero) throw new Error("英雄不存在");
        if (Number(hero.current_experience) + Number(experienceChange) < 0) throw new Error("当前经验不足");
        db.prepare(`UPDATE heroes SET ${attributeKey} = ?, current_experience = current_experience + ? WHERE ${scope}`)
          .run(Number(nextValue), Number(experienceChange), ...params);
        db.exec("COMMIT");
        return this.getHero(id, userId);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    /** 一次性保存多项属性训练，经验与全部基础值在同一事务中提交。 */
    replaceHeroAttributes(heroId, userId, changes, experienceChange) {
      const allowed = new Set(["strength", "constitution", "intelligence", "dexterity", "charisma", "agility", "perception", "willpower"]);
      const scope = userId == null ? "id = ?" : "id = ? AND user_id = ?";
      const params = userId == null ? [Number(heroId)] : [Number(heroId), Number(userId)];
      const assignments = [];
      const values = [];
      for (const change of changes) {
        if (!allowed.has(change.key)) throw new Error("未知属性");
        assignments.push(`${change.key} = ?`);
        values.push(Number(change.value));
      }
      if (assignments.length === 0) throw new Error("没有需要提交的属性修改");
      db.exec("BEGIN IMMEDIATE");
      try {
        const hero = db.prepare(`SELECT current_experience FROM heroes WHERE ${scope}`).get(...params);
        if (!hero) throw new Error("英雄不存在");
        if (Number(hero.current_experience) + Number(experienceChange) < 0) throw new Error("当前经验不足");
        db.prepare(`UPDATE heroes SET ${assignments.join(", ")}, current_experience = current_experience + ? WHERE ${scope}`)
          .run(...values, Number(experienceChange), ...params);
        db.exec("COMMIT");
        return this.getHero(heroId, userId);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    listLearnableSkills(heroId, userId) {
      const hero = this.getHero(heroId, userId);
      if (!hero) return [];
      return db.prepare(`
        WITH available AS (
          SELECT source_skill_id,skill_name,skill_type,learn_level,training_class,'profession' source
          FROM profession_skills WHERE profession_id=? AND (advanced_profession_name IS NULL OR trim(advanced_profession_name)='' OR advanced_profession_name=?)
          UNION ALL
          SELECT source_skill_id,skill_name,skill_type,learn_level,training_class,'race' source
          FROM race_skills WHERE race_id=?
        )
        SELECT a.*,COALESCE(hsl.level,0) current_level
        FROM available a LEFT JOIN hero_skill_levels hsl ON hsl.hero_id=? AND hsl.source_skill_id=a.source_skill_id
        ORDER BY a.learn_level,a.skill_name,a.source
      `).all(hero.profession_id, hero.advanced_profession_name, hero.race_id, Number(heroId));
    },

    setAdvancedProfession(heroId, userId, name, { experienceCost, goldCost }) {
      const scope = userId == null ? "id=?" : "id=? AND user_id=?";
      const params = userId == null ? [Number(heroId)] : [Number(heroId), Number(userId)];
      db.exec("BEGIN IMMEDIATE");
      try {
        const hero = db.prepare(`SELECT advanced_profession_name,current_experience,gold FROM heroes WHERE ${scope}`).get(...params);
        if (!hero) throw new Error("英雄不存在");
        const first = !hero.advanced_profession_name;
        if (first && Number(hero.current_experience) < experienceCost) throw new Error("当前经验不足，需要 5,000 经验");
        if (first && Number(hero.gold) < goldCost) throw new Error("金币不足，需要 20,000 金币");
        db.prepare(`UPDATE heroes SET advanced_profession_name=?,current_experience=current_experience-?,gold=gold-? WHERE ${scope}`)
          .run(String(name), first ? experienceCost : 0, first ? goldCost : 0, ...params);
        db.exec("COMMIT");
        return { firstAdvancement: first };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    setHeroSkillLevel(heroId, userId, sourceSkillId, nextLevel, experienceChange) {
      const hero = this.getHero(heroId, userId);
      if (!hero) throw new Error("英雄不存在");
      if (Number(hero.current_experience) + Number(experienceChange) < 0) throw new Error("当前经验不足");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO hero_skill_levels (hero_id,source_skill_id,level) VALUES (?,?,?)
          ON CONFLICT(hero_id,source_skill_id) DO UPDATE SET level=excluded.level`).run(Number(heroId), Number(sourceSkillId), Number(nextLevel));
        db.prepare("UPDATE heroes SET current_experience=current_experience+? WHERE id=?").run(Number(experienceChange), Number(heroId));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    /** 一次性保存多项技能训练，经验与全部等级在同一事务中提交。 */
    replaceHeroSkillLevels(heroId, userId, changes, experienceChange) {
      const scope = userId == null ? "id = ?" : "id = ? AND user_id = ?";
      const params = userId == null ? [Number(heroId)] : [Number(heroId), Number(userId)];
      db.exec("BEGIN IMMEDIATE");
      try {
        const hero = db.prepare(`SELECT current_experience FROM heroes WHERE ${scope}`).get(...params);
        if (!hero) throw new Error("英雄不存在");
        if (Number(hero.current_experience) + Number(experienceChange) < 0) throw new Error("当前经验不足");
        const save = db.prepare(`INSERT INTO hero_skill_levels (hero_id,source_skill_id,level) VALUES (?,?,?)
          ON CONFLICT(hero_id,source_skill_id) DO UPDATE SET level=excluded.level`);
        for (const change of changes) save.run(Number(heroId), Number(change.sourceSkillId), Number(change.nextLevel));
        db.prepare(`UPDATE heroes SET current_experience=current_experience+? WHERE ${scope}`)
          .run(Number(experienceChange), ...params);
        db.exec("COMMIT");
        return this.getHero(heroId, userId);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    /** 人物卡专用：清空旧技能加点后，以卡面技能等级完整替换。 */
    replaceHeroSkillLevelsExactly(heroId, userId, changes, experienceChange = 0) {
      const scope = userId == null ? "id = ?" : "id = ? AND user_id = ?";
      const params = userId == null ? [Number(heroId)] : [Number(heroId), Number(userId)];
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!db.prepare(`SELECT 1 FROM heroes WHERE ${scope}`).get(...params)) throw new Error("英雄不存在");
        db.prepare("DELETE FROM hero_skill_levels WHERE hero_id=?").run(Number(heroId));
        const save = db.prepare("INSERT INTO hero_skill_levels(hero_id,source_skill_id,level) VALUES(?,?,?)");
        for (const change of changes) save.run(Number(heroId), Number(change.sourceSkillId), Number(change.nextLevel));
        db.prepare(`UPDATE heroes SET current_experience=current_experience+? WHERE ${scope}`)
          .run(Number(experienceChange), ...params);
        db.exec("COMMIT");
        return this.getHero(heroId, userId);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    listHeroSkillLevels(heroId) {
      return db.prepare("SELECT source_skill_id,level FROM hero_skill_levels WHERE hero_id=? ORDER BY source_skill_id").all(Number(heroId));
    },

    /** 人物卡专用：卡面等级直接覆盖，不结算升级消耗。 */
    replaceHeroLevel(heroId, userId, level) {
      const scope = userId == null ? "id = ?" : "id = ? AND user_id = ?";
      const params = userId == null ? [Number(heroId)] : [Number(heroId), Number(userId)];
      const result = db.prepare(`UPDATE heroes SET level=? WHERE ${scope}`).run(Number(level), ...params);
      if (result.changes !== 1) throw new Error("英雄不存在");
      return this.getHero(heroId, userId);
    },

    listHeroSkills(heroId) {
      return db.prepare(`SELECT hs.*, s.name skill_name, s.base_type, s.attack_type
        FROM hero_skills hs JOIN skills s ON s.id = hs.skill_id
        WHERE hs.hero_id = ? ORDER BY s.base_type, s.id`).all(Number(heroId));
    },

    listTrainedHeroSkillIds(heroId) {
      return db.prepare("SELECT source_skill_id FROM hero_skill_levels WHERE hero_id=? AND level>0 ORDER BY source_skill_id").all(Number(heroId));
    },

    listPlans(heroId) {
      return db.prepare("SELECT * FROM battle_plans WHERE hero_id = ? ORDER BY id").all(Number(heroId));
    },

    getHeroActionSettings(heroId) {
      return db.prepare("SELECT * FROM hero_action_settings WHERE hero_id = ?").get(Number(heroId));
    },

    upsertHeroActionSettings(heroId, settings) {
      db.prepare(`INSERT INTO hero_action_settings (hero_id,settings_json,updated_at)
        VALUES (?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(hero_id) DO UPDATE SET
          settings_json=excluded.settings_json,
          updated_at=CURRENT_TIMESTAMP`).run(Number(heroId), JSON.stringify(settings));
      return this.getHeroActionSettings(heroId);
    },

    getPlan(heroId, name) {
      return db.prepare("SELECT * FROM battle_plans WHERE hero_id = ? AND name = ?").get(Number(heroId), String(name));
    },

    upsertPlan(plan) {
      db.prepare(`INSERT INTO battle_plans
        (hero_id,name,mode,position,initiative_skill_id,pre_round_json,main_round_json,floor_overrides_json,general_json)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(hero_id,name) DO UPDATE SET
          mode = excluded.mode,
          position = excluded.position,
          initiative_skill_id = excluded.initiative_skill_id,
          pre_round_json = excluded.pre_round_json,
          main_round_json = excluded.main_round_json,
          floor_overrides_json = excluded.floor_overrides_json,
          general_json = excluded.general_json`).run(
        Number(plan.heroId), plan.name, plan.mode ?? "pve", plan.position ?? "front",
        plan.initiativeSkillId ?? null,
        JSON.stringify(plan.preRound ?? []),
        JSON.stringify(plan.mainRound ?? []),
        JSON.stringify(plan.floorOverrides ?? {}),
        JSON.stringify(plan.general ?? {}),
      );
      return this.getPlan(plan.heroId, plan.name);
    },

    listDungeons() {
      return db.prepare("SELECT * FROM dungeons ORDER BY min_level, id").all();
    },

    getDungeon(id) {
      return db.prepare("SELECT * FROM dungeons WHERE id = ?").get(String(id));
    },

    createBattleReportGroup() {
      return randomUUID();
    },

    insertBattleRun(run) {
      mkdirSync(reportDirectory, { recursive: true });
      const filename = `dungeon-${run.reportGroupId ?? randomUUID()}.json`;
      const destination = join(reportDirectory, filename);
      const jsonPath = relative(dirname(databasePath), destination).replaceAll("\\", "/");
      const temporary = `${destination}.tmp`;
      const backup = `${destination}.bak`;
      const previous = existsSync(destination) ? JSON.parse(readFileSync(destination, "utf8")) : { version: 3, kind: "display-only-dungeon-report", battles: [] };
      if (previous.version !== 3 || previous.kind !== "display-only-dungeon-report" || !Array.isArray(previous.battles)) throw new Error("不支持的战报格式");
      let insertedBattleId = null;
      try {
        const result = db.prepare("INSERT INTO battle_runs (hero_id,json_path) VALUES (?,?)").run(Number(run.heroId), jsonPath);
        const battleId = Number(result.lastInsertRowid);
        insertedBattleId = battleId;
        previous.battles.push({ battleId, ...run.report });
        writeFileSync(temporary, `${JSON.stringify(previous, null, 2)}\n`, "utf8");
        if (existsSync(destination)) renameSync(destination, backup);
        renameSync(temporary, destination);
        if (existsSync(backup)) unlinkSync(backup);
        return battleId;
      } catch (error) {
        if (existsSync(temporary)) unlinkSync(temporary);
        if (existsSync(backup) && !existsSync(destination)) renameSync(backup, destination);
        if (insertedBattleId != null) db.prepare("DELETE FROM battle_runs WHERE id=?").run(insertedBattleId);
        throw error;
      }
    },

    listBattleRuns(limit = 20, userId) {
      const scope = userId == null ? "" : " JOIN heroes h ON h.id=b.hero_id WHERE h.user_id=?";
      return db.prepare(`SELECT b.id,b.hero_id,b.json_path,b.created_at FROM battle_runs b${scope} ORDER BY b.id DESC LIMIT ?`)
        .all(...(userId == null ? [Number(limit)] : [Number(userId), Number(limit)]))
        .map((row) => ({ ...row, report: reportForBattle(row) }));
    },

    getBattleRun(id, userId) {
      const scope = userId == null ? "" : " AND EXISTS(SELECT 1 FROM heroes h WHERE h.id=battle_runs.hero_id AND h.user_id=?)";
      const row = db.prepare(`SELECT id,hero_id,json_path,created_at FROM battle_runs WHERE id = ?${scope}`).get(...(userId == null ? [Number(id)] : [Number(id), Number(userId)]));
      return row ? { ...row, report: reportForBattle(row) } : null;
    },

    /**
     * 删除战斗战报：数据库行与本地展示 JSON 一并清理。
     * 同一 JSON 文件可能被同一次运行的多次战斗共用，因此文件要么整个删除（没有战斗再引用它），
     * 要么重写为只保留仍然存在的战斗。
     *
     * @param {number[]} battleIds
     * @returns {{deletedBattleIds:number[], removedReportFiles:string[], rewrittenReportFiles:string[], warnings:string[]}}
     */
    deleteBattleRuns(battleIds) {
      db.exec("BEGIN IMMEDIATE");
      let outcome;
      try {
        outcome = deleteBattleRunRows(battleIds);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { deletedBattleIds: outcome.deletedBattleIds, ...cleanupReportFiles(outcome.plan) };
    },

    /**
     * 删除一条地城战报记录：记录本身、它名下的全部战斗战报与本地 JSON 文件一起删除。
     * 战斗与记录的对应关系来自 levels_json（见 battleIdsOfDungeonRun）。
     * 记录按账号隔离，查不到（或不属于该账号）时返回 null。
     *
     * @returns {null | {dungeonRunId:number, deletedBattleIds:number[], removedReportFiles:string[], rewrittenReportFiles:string[], warnings:string[]}}
     */
    deleteDungeonRun(id, userId) {
      const row = this.getDungeonRun(id, userId);
      if (!row) return null;
      const battleIds = battleIdsOfDungeonRun(row.levels_json);
      db.exec("BEGIN IMMEDIATE");
      let outcome;
      try {
        outcome = deleteBattleRunRows(battleIds);
        db.prepare("DELETE FROM dungeon_runs WHERE id=?").run(Number(row.id));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { dungeonRunId: Number(row.id), deletedBattleIds: outcome.deletedBattleIds, ...cleanupReportFiles(outcome.plan) };
    },

    insertDungeonRun(run) {
      const result = db.prepare(`INSERT INTO dungeon_runs
        (hero_id,dungeon_id,dungeon_name,seed,ruleset_version,content_version,result,
         floor_count,battle_count,levels_json,events_json,effects_json,
         status,input_json,rewards_json,party_count)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        Number(run.heroId), run.dungeonId, run.dungeonName, run.seed,
        run.rulesetVersion, run.contentVersion, run.result,
        run.floorCount ?? 0, run.battleCount ?? 0,
        JSON.stringify(run.levels ?? []), JSON.stringify(run.events ?? []),
        JSON.stringify(run.effects ?? []),
        run.status ?? "completed", JSON.stringify(run.input ?? {}),
        JSON.stringify(run.rewards ?? {}), Number(run.partyCount ?? 0),
      );
      return Number(result.lastInsertRowid);
    },

    listDungeonRuns(limit = 20, userId) {
      const scope = userId == null ? "" : " JOIN heroes h ON h.id=d.hero_id WHERE h.user_id=?";
      return db.prepare(`SELECT d.id, d.hero_id, d.dungeon_id, d.dungeon_name, d.seed, d.ruleset_version,
        d.content_version, d.result, d.floor_count, d.battle_count, d.status, d.rewards_json,
        d.party_count, d.created_at
        FROM dungeon_runs d${scope} ORDER BY d.id DESC LIMIT ?`)
        .all(...(userId == null ? [Number(limit)] : [Number(userId), Number(limit)]));
    },

    getDungeonRun(id, userId) {
      const scope = userId == null ? "" : " AND EXISTS(SELECT 1 FROM heroes h WHERE h.id=dungeon_runs.hero_id AND h.user_id=?)";
      return db.prepare(`SELECT * FROM dungeon_runs WHERE id = ?${scope}`).get(...(userId == null ? [Number(id)] : [Number(id), Number(userId)]));
    },

    /** 唯一性账本：已掉落记录与当前持有记录分离。 */
    markUniqueDropped(scope, ownerKey, itemKey) {
      db.prepare(`INSERT INTO uniqueness_ledger (scope, owner_key, item_key, dropped_ever, held)
        VALUES (?,?,?,1,0)
        ON CONFLICT(scope, owner_key, item_key) DO UPDATE SET dropped_ever = 1, updated_at = CURRENT_TIMESTAMP`)
        .run(scope, ownerKey, itemKey);
    },

    setUniqueHeld(scope, ownerKey, itemKey, held) {
      db.prepare(`INSERT INTO uniqueness_ledger (scope, owner_key, item_key, dropped_ever, held)
        VALUES (?,?,?,0,?)
        ON CONFLICT(scope, owner_key, item_key) DO UPDATE SET held = excluded.held, updated_at = CURRENT_TIMESTAMP`)
        .run(scope, ownerKey, itemKey, held ? 1 : 0);
    },

    isUniqueDropped(scope, ownerKey, itemKey) {
      const row = db.prepare("SELECT dropped_ever FROM uniqueness_ledger WHERE scope=? AND owner_key=? AND item_key=?")
        .get(scope, ownerKey, itemKey);
      return Boolean(row?.dropped_ever);
    },
  };
}
