import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { EQUIP_SLOTS, ONE_HAND_SLOT_ID } from "../game/domain/item.mjs";
import { ATTRIBUTE_LABELS, createBaseCharacter } from "../game/domain/attributes.mjs";
import { buildCharacterInstance } from "./character-instance-service.mjs";

const BODY_SLOT_IDS = Object.freeze([
  "head", "ear", "glasses", "neck", "body", "belt", "cloak", "shoulder", "arm",
  "hand", "two_hands", "right_hand", "left_hand", "leg", "foot",
]);

function repeatedSlots(baseSlot, count, column) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${baseSlot}:${index + 1}`,
    baseSlot,
    label: `${EQUIP_SLOTS[baseSlot]} #${index + 1}`,
    column,
  }));
}

export function equipmentSlotsFor({ medalSlots = 3, pocketSlots = 15, ringSlots = 4 } = {}) {
  return Object.freeze([
  ...BODY_SLOT_IDS.map((id) => ({ id, baseSlot: id, label: EQUIP_SLOTS[id], column: "left" })),
  ...repeatedSlots("medal", Math.max(0, Math.floor(medalSlots)), "left"),
  ...repeatedSlots("pocket", Math.max(0, Math.floor(pocketSlots)), "right"),
  ...repeatedSlots("ring", Math.max(0, Math.floor(ringSlots)), "right"),
  ]);
}

export const EQUIPMENT_SLOTS = equipmentSlotsFor();

const ATTRIBUTE_KEY_BY_LABEL = Object.freeze(Object.fromEntries(Object.entries(ATTRIBUTE_LABELS).map(([key, label]) => [label, key])));

function restrictionReasons(hero, detail) {
  const reasons = [];
  const profession = hero.profession_name ?? hero.profession ?? "";
  const professionText = String(detail?.["详细属性"]?.["职业限制"] ?? "");
  const professions = Array.isArray(detail?.["职业限制"]) ? detail["职业限制"] : [];
  if (professionText.includes("只适用于") && professions.length > 0 && !professions.includes(profession)) reasons.push(`职业要求：${professions.join("、")}`);
  if (professionText.includes("不") && professionText.includes("适用于") && professions.includes(profession)) reasons.push(`职业 ${profession} 不可使用`);

  const race = hero.race_name ?? hero.race ?? "";
  const raceText = String(detail?.["种族限定"] ?? detail?.["详细属性"]?.["种族限定"] ?? "");
  if (raceText && !raceText.includes("任何种族") && !raceText.includes(race)) reasons.push(`种族要求：${raceText}`);
  return reasons;
}

function requirementValue(hero, label, raw) {
  const attributeKey = ATTRIBUTE_KEY_BY_LABEL[label];
  if (attributeKey) {
    // 角色实例的 attributes 是数组，接口测试/旧调用也可能传按 key 索引的对象。
    // “原始值”必须读取加点产生的 base，不受当前装备或技能奖惩影响。
    const entry = Array.isArray(hero.attributes)
      ? hero.attributes.find((attribute) => attribute.key === attributeKey)
      : hero.attributes?.[attributeKey];
    if (raw) return entry?.base ?? hero.rawAttributes?.[attributeKey] ?? hero[attributeKey];
    return entry?.effective ?? hero.effectiveAttributes?.[attributeKey] ?? hero[attributeKey];
  }
  if (label === "等级") return hero.heroLevel ?? hero.level;
  if (label === "传奇等级") return hero.legendaryLevel ?? 0;
  if (label === "体力") return hero.derived?.healthMax?.effective;
  if (label === "法力") return hero.derived?.manaMax?.effective;
  if (label === "先攻奖励") return hero.derived?.initiative?.effective;
  if (label === "行动次数") return hero.derived?.actionsPerRound?.effective;
  if (label === "荣誉") return hero.derived?.fame?.effective ?? hero.fame;
  if (label === "联盟荣誉") return hero.derived?.allianceFame?.effective ?? hero.allianceFame ?? hero.baseStats?.allianceFame;
  if (label === "金币") return hero.gold;
  if (label === "#口袋") return hero.derived?.pocketSlots?.effective;
  if (label === "#戒指") return hero.derived?.ringSlots?.effective;
  if (label === "#勋章") return hero.derived?.medalSlots?.effective;
  return hero.skills?.find((skill) => skill.name === label)?.liveLevel;
}

function equippedCategoryCount(hero, category, item, detail) {
  const equipped = hero.equippedItems ?? [];
  let count = equipped.filter((entry) => Array.isArray(entry.itemTypes) && entry.itemTypes.includes(category)).length;
  const candidateTypes = Array.isArray(detail?.["物品类别"]) ? detail["物品类别"].map(String) : [];
  const alreadyIncluded = item?.instanceId != null && equipped.some((entry) => Number(entry.instanceId) === Number(item.instanceId));
  if (!alreadyIncluded && candidateTypes.includes(category)) count += 1;
  return count;
}

function equippedNamedItemCount(hero, requiredName, item, detail) {
  const equipped = hero.equippedItems ?? [];
  let count = equipped.filter((entry) => entry.name === requiredName).length;
  const candidateName = detail?.["物品名称"] ?? item?.name;
  const alreadyIncluded = item?.instanceId != null && equipped.some((entry) => Number(entry.instanceId) === Number(item.instanceId));
  if (!alreadyIncluded && candidateName === requiredName) count += 1;
  return count;
}

function parseItemCount(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === "十") return 10;
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  return digits[text] ?? Number.NaN;
}

function requirementReasons(hero, detail, item = null) {
  const reasons = [];
  for (const text of Array.isArray(detail?.["装备要求"]) ? detail["装备要求"] : []) {
    const normalized = String(text).trim();
    if (!normalized || normalized === "-" || normalized === "无任何需求" || normalized === "无") continue;
    const categoryCount = normalized.match(/^英雄必须装备(.+?)类别的至少(\d+)件物品$/);
    if (categoryCount) {
      const category = categoryCount[1].trim();
      const expected = Number(categoryCount[2]);
      const actual = equippedCategoryCount(hero, category, item, detail);
      if (actual < expected) reasons.push(`需要装备至少 ${expected} 件${category}类别物品（当前 ${actual} 件）`);
      continue;
    }
    const categoryMinimum = normalized.match(/^英雄必须装备至少([零一二两三四五六七八九十\d]+)件(.+?)物品$/);
    if (categoryMinimum) {
      const expected = parseItemCount(categoryMinimum[1]);
      const category = categoryMinimum[2].trim();
      const actual = equippedCategoryCount(hero, category, item, detail);
      if (actual < expected) reasons.push(`需要装备至少 ${expected} 件${category}物品（当前 ${actual} 件）`);
      continue;
    }
    const categoryMaximum = normalized.match(/^英雄至多可以装备([零一二两三四五六七八九十\d]+)件(.+?)物品$/);
    if (categoryMaximum) {
      const expected = parseItemCount(categoryMaximum[1]);
      const category = categoryMaximum[2].trim();
      const actual = equippedCategoryCount(hero, category, item, detail);
      if (actual > expected) reasons.push(`至多可以装备 ${expected} 件${category}物品（换装后 ${actual} 件）`);
      continue;
    }
    const namedItemMinimum = normalized.match(/^英雄必须装备至少([零一二两三四五六七八九十\d]+)件(.+)$/);
    if (namedItemMinimum) {
      const expected = parseItemCount(namedItemMinimum[1]);
      const requiredName = namedItemMinimum[2].trim();
      const actual = equippedNamedItemCount(hero, requiredName, item, detail);
      if (actual < expected) reasons.push(`需要装备至少 ${expected} 件${requiredName}（当前 ${actual} 件）`);
      continue;
    }
    const mutuallyExclusiveItem = normalized.match(/^物品\s*(.+?)\s*不能被同时装备$/);
    if (mutuallyExclusiveItem) {
      const excludedName = mutuallyExclusiveItem[1].trim();
      const equipped = hero.equippedItems ?? [];
      if (equipped.some((entry) => entry.name === excludedName)) reasons.push(`不能与物品${excludedName}同时装备`);
      continue;
    }
    const match = normalized.match(/^(.*?)(至少为|最高到)(-?\d+(?:\.\d+)?)$/);
    if (!match) { reasons.push(`暂不支持的装备要求：${text}`); continue; }
    const [, labelText, operator, expectedText] = match;
    const raw = /[（(]原始值[）)]$/.test(labelText.trim());
    const label = labelText.trim().replace(/[（(]原始值[）)]$/, "").trim();
    const actual = Number(requirementValue(hero, label, raw));
    const expected = Number(expectedText);
    if (!Number.isFinite(actual)) { reasons.push(`缺少要求值：${label}`); continue; }
    if (operator === "至少为" && actual < expected) reasons.push(`${label}${raw ? "（原始值）" : ""}需要至少 ${expected}（当前 ${actual}）`);
    if (operator === "最高到" && actual > expected) reasons.push(`${label}${raw ? "（原始值）" : ""}最高允许 ${expected}（当前 ${actual}）`);
  }
  return reasons;
}

/** 物品详情使用的逐条条件状态；与实际穿戴校验共享同一判断入口。 */
export function itemEquipabilityConditions({ hero, itemDetail }) {
  const professionText = String(itemDetail?.["详细属性"]?.["职业限制"] ?? "所有人都可以使用该物品");
  const raceText = String(itemDetail?.["种族限定"] ?? itemDetail?.["详细属性"]?.["种族限定"] ?? "任何种族都可使用该物品");
  const requirements = (Array.isArray(itemDetail?.["装备要求"]) ? itemDetail["装备要求"] : [])
    .map((text) => String(text).trim()).filter(Boolean);
  return {
    profession: [{ text: professionText, met: restrictionReasons(hero, { ...itemDetail, "种族限定": "任何种族都可使用该物品" }).length === 0 }],
    race: [{ text: raceText, met: restrictionReasons(hero, { ...itemDetail, "详细属性": { ...itemDetail?.["详细属性"], "职业限制": "所有人都可以使用该物品" }, "职业限制": [] }).length === 0 }],
    requirements: (requirements.length > 0 ? requirements : ["无任何需求"]).map((text) => ({
      text,
      met: requirementReasons(hero, { "装备要求": [text] }).length === 0,
    })),
  };
}

/** 使用加成后的角色实例校验职业、种族、等级、属性与技能等级需求。 */
export function validateItemEquipability({ hero, item, itemDetail }) {
  const reasons = [...restrictionReasons(hero, itemDetail), ...requirementReasons(hero, itemDetail, item)];
  const level = Number(hero.heroLevel ?? hero.level ?? 0);
  if (item?.minLevel != null && level < Number(item.minLevel)) reasons.push(`角色等级需要至少 ${item.minLevel}`);
  if (item?.maxLevel != null && level > Number(item.maxLevel)) reasons.push(`角色等级最高允许 ${item.maxLevel}`);
  return { allowed: reasons.length === 0, reasons };
}

function readItemDetail(repository, root, itemId) {
  const metadata = repository.getItemDetailMetadata(itemId);
  if (!metadata) return null;
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, metadata.json_path);
  const pathFromRoot = relative(rootPath, filePath);
  if (pathFromRoot.startsWith("..") || pathFromRoot.includes(":")) return null;
  try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { return null; }
}

function fitsSlot(item, baseSlot) {
  if (item.slotId === ONE_HAND_SLOT_ID) return baseSlot === "right_hand" || baseSlot === "left_hand";
  return item.slotId === baseSlot;
}

function highestEquippedSlotIndex(inventory, baseSlot) {
  let highest = 0;
  const pattern = new RegExp(`^${baseSlot}:(\\d+)$`);
  for (const row of inventory) {
    if (!row.is_equipped) continue;
    const match = String(row.equip_slot ?? "").match(pattern);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

export function heroEquipmentDto(repository, root, heroId, userId, catalog = null) {
  const hero = repository.getHero(heroId, userId);
  const inventory = repository.listHeroInventory(heroId, userId);
  if (!hero || !inventory) return null;
  const baseCharacter = createBaseCharacter(hero);
  const character = buildCharacterInstance({ repository, catalog, root, heroId, userId });
  const characterStats = {
    medalSlots: Math.max(character?.derived?.medalSlots?.effective ?? baseCharacter.baseStats.medalSlots, highestEquippedSlotIndex(inventory, "medal")),
    pocketSlots: Math.max(character?.derived?.pocketSlots?.effective ?? baseCharacter.baseStats.pocketSlots, highestEquippedSlotIndex(inventory, "pocket")),
    ringSlots: Math.max(character?.derived?.ringSlots?.effective ?? baseCharacter.baseStats.ringSlots, highestEquippedSlotIndex(inventory, "ring")),
  };
  const equipmentSlots = equipmentSlotsFor(characterStats);
  const items = inventory.map((row) => ({
    instanceId: Number(row.item_instance_id), itemId: Number(row.item_id), name: row.name,
    slotId: row.item_slot === "单手" ? ONE_HAND_SLOT_ID : Object.keys(EQUIP_SLOTS).find((id) => EQUIP_SLOTS[id] === row.item_slot) ?? null,
    equipped: Boolean(row.is_equipped), equipSlot: row.equip_slot ?? null,
    minLevel: row.min_level, maxLevel: row.max_level,
    itemDetail: readItemDetail(repository, root, row.item_id),
  }));
  const currentBySlot = new Map();
  for (const item of items.filter((entry) => entry.equipped)) {
    let slotId = item.equipSlot;
    if (slotId === ONE_HAND_SLOT_ID) slotId = currentBySlot.has("right_hand") ? "left_hand" : "right_hand";
    if (slotId && ["medal", "pocket", "ring"].includes(slotId)) {
      const next = equipmentSlots.find((slot) => slot.baseSlot === slotId && !currentBySlot.has(slot.id));
      slotId = next?.id ?? slotId;
    }
    if (slotId) currentBySlot.set(slotId, item.instanceId);
  }
  const slots = equipmentSlots.map((slot) => ({
    ...slot,
    selectedInstanceId: currentBySlot.get(slot.id) ?? null,
    options: items.filter((item) => fitsSlot(item, slot.baseSlot)
      && (currentBySlot.get(slot.id) === item.instanceId
        || (!item.equipped && validateItemEquipability({ hero: { ...hero, ...(character ?? baseCharacter) }, item, itemDetail: item.itemDetail }).allowed)))
      .map(({ instanceId, itemId, name }) => ({ instanceId, itemId, name })),
  }));
  return { heroId: Number(heroId), slots };
}

export function applyHeroEquipment(repository, root, heroId, userId, selections, catalog = null) {
  const hero = repository.getHero(heroId, userId);
  const inventory = repository.listHeroInventory(heroId, userId);
  if (!hero || !inventory) throw new Error("英雄不存在");
  const character = buildCharacterInstance({ repository, catalog, root, heroId, userId });
  const dto = heroEquipmentDto(repository, root, heroId, userId, catalog);
  const requested = new Map((Array.isArray(selections) ? selections : []).map((entry) => [String(entry.slotId), entry.instanceId == null ? null : Number(entry.instanceId)]));
  const inventoryById = new Map(inventory.map((row) => [Number(row.item_instance_id), row]));
  const assignments = [];
  for (const slot of dto.slots) {
    const instanceId = requested.has(slot.id) ? requested.get(slot.id) : slot.selectedInstanceId;
    if (instanceId == null) continue;
    const row = inventoryById.get(instanceId);
    if (!row) throw new Error(`${slot.label}所选物品不在角色仓库`);
    const slotId = row.item_slot === "单手" ? ONE_HAND_SLOT_ID : Object.keys(EQUIP_SLOTS).find((id) => EQUIP_SLOTS[id] === row.item_slot) ?? null;
    if (!fitsSlot({ slotId }, slot.baseSlot)) throw new Error(`${slot.label}所选物品与槽位不匹配`);
    assignments.push({ slotId: slot.id, baseSlot: slot.baseSlot, instanceId });
  }

  const desiredIds = new Set(assignments.map((entry) => entry.instanceId));
  const retainedRows = inventory.filter((row) => Boolean(row.is_equipped) && desiredIds.has(Number(row.item_instance_id)));
  const temporaryCharacter = buildCharacterInstance({ repository, catalog, root, heroId, userId, equippedInventory: retainedRows });
  for (const assignment of assignments) {
    const original = dto.slots.find((slot) => slot.id === assignment.slotId)?.selectedInstanceId ?? null;
    if (Number(original) === Number(assignment.instanceId)) continue;
    const row = inventoryById.get(assignment.instanceId);
    const item = { instanceId: assignment.instanceId, minLevel: row.min_level, maxLevel: row.max_level };
    const itemDetail = readItemDetail(repository, root, row.item_id);
    const result = validateItemEquipability({ hero: { ...hero, ...(temporaryCharacter ?? character) }, item, itemDetail });
    if (!result.allowed) throw new Error(`${row.name}穿戴失败：${result.reasons.join("；")}`);
  }
  repository.replaceHeroEquipment(heroId, userId, assignments);
  return heroEquipmentDto(repository, root, heroId, userId, catalog);
}

/** 角色仓库的单件装备入口，同样走“先卸后验”的整套原子换装规则。 */
export function equipHeroInventoryItem(repository, root, heroId, userId, instanceId, catalog = null) {
  const dto = heroEquipmentDto(repository, root, heroId, userId, catalog);
  if (!dto) throw new Error("英雄不存在");
  const candidates = dto.slots.filter((slot) => slot.options.some((item) => item.instanceId === Number(instanceId)));
  if (candidates.length === 0) throw new Error("该物品当前不满足装备要求");
  const target = candidates.find((slot) => slot.selectedInstanceId == null) ?? candidates[0];
  return applyHeroEquipment(repository, root, heroId, userId, [{ slotId: target.id, instanceId: Number(instanceId) }], catalog);
}
