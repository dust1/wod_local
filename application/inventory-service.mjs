import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { EQUIP_SLOTS, ONE_HAND_SLOT_ID, ONE_HAND_SLOT_LABEL, equipSlotIdForItemSlot } from "../game/domain/item.mjs";
import { buildCharacterInstance } from "./character-instance-service.mjs";
import { itemEquipabilityConditions, validateItemEquipability } from "./equipment-service.mjs";

/** 派生部位与 equip_slot 表共用同一套展示标签。 */
const SLOT_LABELS = Object.freeze({ ...EQUIP_SLOTS, [ONE_HAND_SLOT_ID]: ONE_HAND_SLOT_LABEL });

/** 物品的基础可装备部位 ID；“单手”映射为派生部位 one_hand。 */
function itemDto(row) {
  const equipped = Boolean(row.is_equipped);
  const slotId = equipSlotIdForItemSlot(row.item_slot);
  return {
    instanceId: row.item_instance_id,
    itemId: row.item_id,
    name: row.name,
    itemSlot: row.item_slot ?? null,
    slotId,
    slotLabel: slotId ? SLOT_LABELS[slotId] : row.item_slot ?? null,
    equipped,
    equipSlot: row.equip_slot ?? null,
    equipSlotLabel: row.equip_slot ? SLOT_LABELS[row.equip_slot] ?? row.equip_slot : null,
    acquiredAt: row.acquired_at ?? row.stored_at ?? null,
    minLevel: row.min_level,
    maxLevel: row.max_level,
  };
}

export function heroInventoryDto(repository, heroId, userId) {
  const rows = repository.listHeroInventory(heroId, userId);
  return rows && { heroId: Number(heroId), items: rows.map(itemDto) };
}

/** 角色仓库页面 DTO：每次读取都以当前装备生成最新角色实例并重新校验。 */
export function heroInventoryPageDto(repository, root, heroId, userId, catalog = null) {
  const hero = repository.getHero(heroId, userId);
  const rows = repository.listHeroInventory(heroId, userId);
  if (!hero || !rows) return null;
  const character = buildCharacterInstance({ repository, catalog, root, heroId, userId });
  const liveHero = { ...hero, ...character };
  const rootPath = resolve(root);
  const items = rows.map((row) => {
    const dto = itemDto(row);
    const metadata = repository.getItemDetailMetadata(row.item_id);
    let detail = null;
    if (metadata) {
      const filePath = resolve(rootPath, metadata.json_path);
      const pathFromRoot = relative(rootPath, filePath);
      if (!pathFromRoot.startsWith("..") && !pathFromRoot.includes(":")) {
        try { detail = JSON.parse(readFileSync(filePath, "utf8")); } catch { detail = null; }
      }
    }
    const result = validateItemEquipability({ hero: liveHero, item: dto, itemDetail: detail });
    return {
      ...dto,
      canEquip: Boolean(dto.slotId && result.allowed),
      equipabilityReasons: dto.slotId ? result.reasons : ["该物品不可装备"],
      equipability: detail ? itemEquipabilityConditions({ hero: liveHero, itemDetail: detail }) : null,
      allowedProfessions: Array.isArray(detail?.["职业限制"]) ? detail["职业限制"] : [],
      professionRestriction: String(detail?.["详细属性"]?.["职业限制"] ?? ""),
      raceRestriction: String(detail?.["种族限定"] ?? detail?.["详细属性"]?.["种族限定"] ?? ""),
      itemSet: detail?.["所属套装"] ?? "",
    };
  });
  return {
    heroId: Number(heroId), items,
    filters: {
      professions: repository.listProfessions(), races: repository.listRaces(),
      equipSlots: Object.entries(EQUIP_SLOTS).filter(([id]) => id !== ONE_HAND_SLOT_ID).map(([id, name]) => ({ id, name })),
      itemSets: [...new Set(items.map((item) => item.itemSet).filter(Boolean))].map((name) => ({ id: name, name })),
    },
  };
}

export function teamInventoryDto(repository, userId) {
  return { userId: Number(userId), items: repository.listTeamInventory(userId).map(itemDto) };
}

export function itemDetailDto(repository, root, itemId) {
  const metadata = repository.getItemDetailMetadata(itemId);
  if (!metadata) return null;
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, metadata.json_path);
  const pathFromRoot = relative(rootPath, filePath);
  if (pathFromRoot.startsWith("..") || pathFromRoot.includes(":")) throw new Error("物品详情路径无效");
  return {
    metadata: {
      itemId: metadata.item_id,
      name: metadata.name,
      slot: metadata.slot,
      sourceTable: metadata.source_table,
      contentHash: metadata.content_hash,
      parsedAt: metadata.parsed_at,
    },
    detail: JSON.parse(readFileSync(filePath, "utf8")),
  };
}
