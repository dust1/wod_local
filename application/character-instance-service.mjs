// 角色实例取数：把持久化行与 detail JSON 组装成 game/domain/character-instance.mjs 的输入。
//
// 取数来源：
//   角色数值        → heroes 表
//   已装备物品      → hero_inventory（is_equipped=1）→ item_detail_metadata → data/items/<id>.json
//   当前套装件数    → item_sets（套装名 + 精确件数）→ data/sets/<套装名>/<件数>.json
//   已学技能        → hero_skills 与 hero_skill_levels（等级 ≥ 1）两条来源
//                   → skill_detail_metadata → data/profession_skills|race_skills/<id>.json
//
// detail JSON 只读取角色真正装备/学会的那几份，不做全量加载。
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { createCharacterInstance } from "../game/domain/character-instance.mjs";
import { createBaseCharacter } from "../game/domain/attributes.mjs";
import { companionItemTypeNames } from "../game/domain/item.mjs";

/** 读取 detail JSON，并确认路径没有逃出项目根目录。 */
function readDetail(root, jsonPath) {
  if (!jsonPath) return null;
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, jsonPath);
  const fromRoot = relative(rootPath, filePath);
  if (fromRoot.startsWith("..") || fromRoot.includes(":")) throw new Error(`详情路径无效: ${jsonPath}`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** 技能来源范围：hero_skills 只存目录技能 id，需要先经目录解析出 sourceId。 */
function resolveSkillDetail(repository, root, { sourceId, catalogSkill }) {
  const candidates = [];
  if (catalogSkill?.sourceId != null) candidates.push(Number(catalogSkill.sourceId));
  if (sourceId != null) candidates.push(Number(sourceId));
  for (const id of candidates) {
    for (const scope of ["profession", "race"]) {
      const metadata = repository.getSkillDetailMetadata(scope, id);
      if (!metadata) continue;
      const detail = readDetail(root, metadata.json_path);
      if (detail) return { detail, scope, sourceId: id, jsonPath: metadata.json_path };
    }
  }
  return null;
}

/** 技能的类型名，供「X 类别的所有技能」匹配使用。 */
function skillTypeNames(detail, catalogSkill) {
  const names = [];
  const fromDetail = detail?.["详细属性"]?.["技能类型"];
  if (fromDetail) names.push(String(fromDetail));
  for (const name of catalogSkill?.skillTypeNames ?? []) names.push(String(name));
  return [...new Set(names)];
}

/**
 * 已装备物品池。角色实例与「技能调用物品」的候选集共用同一份取数，
 * 避免两处各写一遍「is_equipped → item_detail_metadata → detail JSON」。
 *
 * @param {object} input
 * @param {object} input.repository
 * @param {string} input.root 项目根目录
 * @param {number} input.heroId
 * @param {number} [input.userId]
 * @param {Array} [input.equippedInventory] 换装校验用的临时行，传入时不再过滤 is_equipped
 */
export function equippedItemPool({ repository, root, heroId, userId, equippedInventory = null }) {
  const inventory = repository.listHeroInventory(heroId, userId) ?? [];
  return (equippedInventory ?? inventory.filter((entry) => Boolean(entry.is_equipped)))
    .map((entry) => {
      const metadata = repository.getItemDetailMetadata(entry.item_id);
      const detail = readDetail(root, metadata?.json_path);
      return {
        itemId: entry.item_id,
        instanceId: entry.item_instance_id,
        name: entry.name,
        slotId: entry.equip_slot ?? null,
        slotLabel: entry.item_slot ?? null,
        detail,
        jsonPath: metadata?.json_path ?? null,
        // 技能页「物品」字段匹配的就是这些类别名称，见 docs/WOD完整战斗规则.md §13.3 调用链。
        itemTypes: Array.isArray(detail?.["物品类别"]) ? detail["物品类别"].map(String) : [],
        // 选中该物品调用技能时，还需要按这里的每个 tag 追加一个配合物品。
        // JSON 用 `-` 表示"无配合物品"，这里已与空集合统一处理。
        companionItemTypes: companionItemTypeNames(detail?.["需配合何物使用"]),
        setName: String(detail?.["所属套装"] ?? "").trim() || null,
        targetEffects: detail?.["作用在被此物品影响的目标上的效果"]
          ?? detail?.["作用在被影响的目标上的效果"]
          ?? [],
      };
    });
}

/**
 * 组装角色实例。
 *
 * @param {object} input
 * @param {object} input.repository
 * @param {object} input.catalog
 * @param {string} input.root 项目根目录
 * @param {number} input.heroId
 * @param {number} [input.userId]
 * @returns {object|null} 角色实例，角色不存在时返回 null
 */
export function buildCharacterInstance({ repository, catalog, root, heroId, userId, equippedInventory = null }) {
  const row = repository.getHero(heroId, userId);
  if (!row) return null;

  const heroSkills = repository.listHeroSkills(heroId);
  const baseCharacter = createBaseCharacter(row);
  const heroLevel = Number(row.level ?? 1);
  const innateSources = [
    { kind: "race", id: row.race_id, name: row.race_name, jsonPath: `data/race/${row.race_id}.json` },
    { kind: "profession", id: row.profession_id, name: row.profession_name, jsonPath: `data/profession/${row.profession_id}.json` },
  ].map((source) => ({ ...source, detail: readDetail(root, source.jsonPath) }));

  // -------------------------------------------------------------- 已装备物品
  const equippedItems = equippedItemPool({ repository, root, heroId, userId, equippedInventory });
  const setCounts = new Map();
  for (const item of equippedItems) {
    const setName = String(item.detail?.["所属套装"] ?? "").trim();
    if (setName) setCounts.set(setName, (setCounts.get(setName) ?? 0) + 1);
  }
  const itemSets = [...setCounts].map(([setName, pieceCount]) => {
    const metadata = repository.getItemSetEffect(setName, pieceCount);
    return {
      setName,
      pieceCount,
      detail: readDetail(root, metadata?.effect_json_path),
      jsonPath: metadata?.effect_json_path ?? null,
    };
  });

  // -------------------------------------------------------------- 已学技能（两条来源合并）
  const collected = new Map();
  for (const entry of heroSkills) {
    const catalogSkill = catalog?.skills?.get(entry.skill_id) ?? null;
    const resolved = resolveSkillDetail(repository, root, { sourceId: null, catalogSkill });
    collected.set(entry.skill_name, {
      skillId: entry.skill_id,
      sourceSkillId: resolved?.sourceId ?? catalogSkill?.sourceId ?? null,
      name: entry.skill_name ?? catalogSkill?.name ?? entry.skill_id,
      level: Number(entry.base_level ?? 0),
      equipmentBonus: Number(entry.equipment_bonus ?? 0),
      scope: resolved?.scope ?? null,
      skillType: resolved?.detail?.["详细属性"]?.["技能类型"] ?? null,
      typeNames: skillTypeNames(resolved?.detail, catalogSkill),
      detail: resolved?.detail ?? null,
      hasDetailSource: Boolean(resolved),
    });
  }
  for (const entry of repository.listLearnableSkills(heroId, userId)) {
    if (Number(entry.current_level ?? 0) < 1) continue;
    if (collected.has(entry.skill_name)) continue;
    const resolved = resolveSkillDetail(repository, root, { sourceId: entry.source_skill_id, catalogSkill: null });
    collected.set(entry.skill_name, {
      skillId: `skill-${entry.source_skill_id}`,
      sourceSkillId: entry.source_skill_id,
      name: entry.skill_name,
      level: Number(entry.current_level ?? 0),
      equipmentBonus: 0,
      scope: entry.source ?? resolved?.scope ?? null,
      skillType: resolved?.detail?.["详细属性"]?.["技能类型"] ?? entry.skill_type ?? null,
      typeNames: skillTypeNames(resolved?.detail, null),
      detail: resolved?.detail ?? null,
      hasDetailSource: Boolean(resolved),
    });
  }

  const heroInput = {
    ...baseCharacter,
    level: heroLevel,
    baseStatDefaults: baseCharacter.baseStats.defaults,
    fame: Number(row.fame ?? 0),
  };

  const instance = createCharacterInstance({
    hero: heroInput,
    innateSources,
    equippedItems,
    itemSets,
    skills: [...collected.values()],
  });

  return {
    ...instance,
    equippedItems: equippedItems.map((item) => ({
      itemId: item.itemId,
      instanceId: item.instanceId,
      name: item.name,
      slotId: item.slotId,
      slotLabel: item.slotLabel,
      itemTypes: item.itemTypes,
      companionItemTypes: item.companionItemTypes,
      setName: item.setName,
      targetEffects: item.targetEffects,
      hasDetail: Boolean(item.detail),
      effectCount: item.detail?.["作用在物品持有者上的效果"]?.length ?? 0,
    })),
    itemSets: itemSets.map((set) => ({
      setName: set.setName,
      pieceCount: set.pieceCount,
      hasDetail: Boolean(set.detail),
      effectCount: set.detail?.["作用在装备者上的效果"]?.length ?? 0,
      targetEffects: set.detail?.["作用在被影响的目标上的效果"] ?? [],
    })),
  };
}
