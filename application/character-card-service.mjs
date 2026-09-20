// 人物卡导入导出用例。
//
// 导入把人物卡里的加点结果**覆盖**到所选角色上：
//   - 属性：写入卡面「方括号外的数字」作为基础值；
//   - 技能：写入卡面的训练等级；
//   - 等级：直接覆盖为卡面英雄等级；
//   - 装备：本地存在同名物品时按卡面槽位创建新实例并穿戴，缺失名称直接跳过；
//   - 经验：按需求不结算经验，`current_experience` 保持不变（导入结果在预览与结果里都会标注）。
//
// 人物卡被视为可信快照；导入不复用普通升级与穿戴校验。

import {
  CHARACTER_CARD_SLOT_IDS,
  parseCharacterCard,
  renderCharacterCard,
} from "../game/domain/character-card.mjs";
import { heroDetailDto } from "./hero-service.mjs";
import { buildCharacterInstance } from "./character-instance-service.mjs";

/** 导入不结算经验，因此属性与技能都按 0 经验变化写入。 */
const IMPORT_EXPERIENCE_CHANGE = 0;

/** 多槽位部位的默认容量，与 game/domain/attributes.mjs 的基础角色默认值一致。 */
/** 卡面部位标签 → 装备槽位 ID；未知部位返回 null。 */
function slotIdForCardLabel(label) {
  const normalized = String(label ?? "").replace(/#\s*\d+$/, "").trim();
  return CHARACTER_CARD_SLOT_IDS[normalized] ?? null;
}

function skillNameOf(entry) {
  return String(entry.name ?? "").replace(/[:：]/, "：");
}

/**
 * 把解析结果与角色现状对照，产出可展示的预览。
 *
 * 只读取，不写库；`applyCharacterCard` 复用同一套匹配结果，保证预览与实际写入一致。
 */
export function characterCardPreview(repository, heroId, cardText, catalog, userId, options = {}) {
  const detail = heroDetailDto(repository, heroId, catalog, userId, options);
  if (!detail) throw new Error("英雄不存在");
  const parsed = parseCharacterCard(cardText);
  const warnings = [...parsed.warnings];
  // ------------------------------------------------------------ 属性
  const slotCount = { medal: 0, pocket: 0, ring: 0 };
  const attributeByKey = new Map(detail.attributes.map((attribute) => [attribute.key, attribute]));
  const attributes = parsed.attributes.map((entry) => {
    const current = attributeByKey.get(entry.key) ?? null;
    return {
      key: entry.key,
      label: entry.label,
      cardBase: entry.base,
      cardTrained: entry.trained,
      current: current ? Number(current.base) : null,
      changes: !current || Number(current.base) !== entry.base,
      valid: Number.isSafeInteger(entry.base) && entry.base >= 1,
    };
  });
  for (const attribute of attributes) {
    if (!attribute.valid) warnings.push(`${attribute.label}的卡面基础值无效，导入时会跳过该项`);
  }

  // ------------------------------------------------------------ 派生项（只对照，不写入）
  const derivedCurrent = {
    英雄等级: detail.level,
    体力: detail.derived.healthMax,
    体力恢复: detail.derived.healthRegeneration,
    法力: detail.derived.manaMax,
    法力回复: detail.derived.manaRegeneration,
    每回合行动次数: detail.derived.actions,
    先攻附加值: detail.derived.initiative,
  };
  const derived = parsed.derived.map((entry) => ({
    label: entry.label,
    cardBase: entry.base,
    cardTrained: entry.trained,
    current: derivedCurrent[entry.label] ?? null,
  }));
  const cardLevel = parsed.derived.find((entry) => entry.label === "英雄等级")?.base ?? detail.level;

  // ------------------------------------------------------------ 技能
  const learnableByName = new Map(detail.learnableSkills.map((skill) => [skillNameOf(skill), skill]));
  const currentLevels = new Map(repository.listHeroSkillLevels(heroId).map((row) => [Number(row.source_skill_id), Number(row.level)]));
  for (const skill of catalog.skills.values()) {
    if (skill.sourceId == null || learnableByName.has(skill.name)) continue;
    learnableByName.set(skill.name, {
      sourceSkillId: Number(skill.sourceId), name: skill.name,
      trainingClass: skill.trainingClass ?? "additional",
      learnLevel: Number(skill.learnLevel ?? 1), unlocked: true,
      currentLevel: currentLevels.get(Number(skill.sourceId)) ?? 0,
    });
  }
  const seenSkillIds = new Set();
  const skills = [];
  const skippedSkills = [];
  for (const entry of parsed.skills) {
    const fullName = entry.label ? `${entry.label}：${entry.name}` : entry.name;
    const matched = learnableByName.get(fullName) ?? learnableByName.get(entry.name) ?? null;
    if (!matched) {
      skippedSkills.push({ name: fullName, level: entry.level, reason: "本地技能资料中没有同名技能" });
      continue;
    }
    if (seenSkillIds.has(matched.sourceSkillId)) continue;
    seenSkillIds.add(matched.sourceSkillId);
    const currentLevel = Number(matched.currentLevel ?? 0);
    const unlocked = Boolean(matched.unlocked);
    if (!unlocked) warnings.push(`${matched.name} 将在 ${matched.learnLevel} 级解锁，仍会按卡面写入等级`);
    skills.push({
      sourceSkillId: matched.sourceSkillId,
      name: matched.name,
      trainingClass: matched.trainingClass,
      learnLevel: matched.learnLevel,
      unlocked,
      currentLevel,
      cardLevel: entry.level,
      changes: currentLevel !== entry.level,
    });
  }

  // ------------------------------------------------------------ 装备（只要求本地物品存在，不校验容量和穿戴条件）
  const equipment = [];
  const skippedEquipment = [];
  const heroItemsByName = groupInventoryByName(repository.listHeroInventory(heroId, userId) ?? []);
  const teamItemsByName = groupInventoryByName(repository.listTeamInventory(userId) ?? []);
  for (const entry of parsed.equipment) {
    const slotId = slotIdForCardLabel(entry.slotLabel);
    const heroItem = takeInventoryItem(heroItemsByName, entry.name);
    const teamItem = heroItem ? null : takeInventoryItem(teamItemsByName, entry.name);
    const storedItem = heroItem ?? teamItem;
    const item = storedItem ?? repository.findItemByName(entry.name);
    if (!item) {
      skippedEquipment.push({ slotLabel: entry.slotLabel, name: entry.name, reason: "物品表里没有同名物品" });
      continue;
    }
    const targetSlot = nextSlotFor(slotId, entry.slotIndex, slotCount);
    if (!targetSlot) {
      skippedEquipment.push({ slotLabel: entry.slotLabel, name: entry.name, reason: "部位无法识别或不支持穿戴" });
      continue;
    }
    equipment.push({
      slotLabel: entry.slotLabel,
      slotId,
      targetSlotId: targetSlot,
      itemId: Number(storedItem?.item_id ?? item.id),
      name: item.name,
      instanceId: storedItem ? Number(storedItem.item_instance_id) : null,
      inventorySource: heroItem ? "hero" : teamItem ? "team" : "catalog",
      alreadyEquipped: Boolean(heroItem?.is_equipped && heroItem?.equip_slot === targetSlot),
      markerCount: entry.markerCount,
    });
  }

  return {
    heroId: Number(heroId),
    level: { current: Number(detail.level), card: Number(cardLevel), changes: Number(detail.level) !== Number(cardLevel) },
    attributes,
    derived,
    skills,
    equipment,
    skippedSkills,
    skippedEquipment,
    warnings,
    summary: {
      attributeChanges: attributes.filter((entry) => entry.changes && entry.valid).length,
      skillChanges: skills.filter((entry) => entry.changes).length,
      equipmentCount: equipment.length,
      skippedSkillCount: skippedSkills.length,
      skippedEquipmentCount: skippedEquipment.length,
    },
  };
}

function groupInventoryByName(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const name = String(row.name);
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(row);
  }
  return grouped;
}

function takeInventoryItem(grouped, name) {
  const rows = grouped.get(String(name));
  return rows?.shift() ?? null;
}

/**
 * 为多槽位部位保留卡面编号；没有编号时才顺序补号。
 */
function nextSlotFor(slotId, cardIndex, slotCount) {
  if (!slotId) return null;
  if (!["medal", "pocket", "ring"].includes(slotId)) return slotId;
  const index = Number(cardIndex) > 0 ? Number(cardIndex) : (slotCount[slotId] ?? 0) + 1;
  slotCount[slotId] = Math.max(slotCount[slotId] ?? 0, index);
  return `${slotId}:${index}`;
}

/**
 * 应用人物卡：等级、属性、技能以卡面覆盖；已匹配装备按卡面槽位直接穿戴。
 * 经验不结算，装备不走普通穿戴校验。
 *
 * @returns {{detail: object, preview: object, applied: object}}
 */
export function applyCharacterCard(repository, root, heroId, cardText, catalog, userId, options = {}) {
  const preview = characterCardPreview(repository, heroId, cardText, catalog, userId, options);
  const attributeChanges = preview.attributes
    .filter((entry) => entry.valid && entry.changes)
    .map((entry) => ({ key: entry.key, value: entry.cardBase }));
  const skillChanges = preview.skills.map((entry) => ({ sourceSkillId: entry.sourceSkillId, nextLevel: entry.cardLevel }));

  repository.replaceHeroLevel(heroId, userId, preview.level.card);
  if (attributeChanges.length > 0) {
    repository.replaceHeroAttributes(heroId, userId, attributeChanges, IMPORT_EXPERIENCE_CHANGE);
  }
  repository.replaceHeroSkillLevelsExactly(heroId, userId, skillChanges, IMPORT_EXPERIENCE_CHANGE);

  const applied = { equipped: [], failed: [], skipped: preview.skippedEquipment };
  {
    const assignments = preview.equipment.map((entry) => ({
      slotId: entry.targetSlotId, baseSlot: entry.slotId, itemId: entry.itemId,
      instanceId: entry.instanceId, inventorySource: entry.inventorySource, entry,
    }));
    const created = repository.replaceHeroEquipmentFromCard(heroId, userId, assignments);
    applied.equipped = created.map((createdItem, index) => ({
      ...assignments[index].entry,
      instanceId: createdItem.instanceId,
    }));
  }

  return {
    detail: heroDetailDto(repository, heroId, catalog, userId, options),
    preview,
    applied,
  };
}

/**
 * 角色详情 → BBCode 人物卡，供「导出」使用。
 *
 * 已穿戴物品由角色实例提供；`markerCount` 由调用方（导出弹窗，通常来自上次导入的卡面）
 * 传入，缺省为 0，避免服务端凭空编造品阶标记。
 */
export function exportCharacterCard(repository, root, heroId, catalog, userId, options = {}) {
  const instance = options.instance ?? buildCharacterInstance({ repository, catalog, root, heroId, userId });
  const detail = heroDetailDto(repository, heroId, catalog, userId, { ...options, instance });
  if (!detail) throw new Error("英雄不存在");
  const markers = new Map(
    (Array.isArray(options.markers) ? options.markers : [])
      .map((entry) => [Number(entry.instanceId), Math.max(0, Number(entry.markerCount) || 0)]),
  );
  const rows = repository.listHeroInventory(heroId, userId) ?? [];
  const equipped = (detail.effectSummary?.equippedItems ?? []).map((item) => {
    const row = rows.find((entry) => Number(entry.item_instance_id) === Number(item.instanceId));
    return {
      name: item.name,
      slotId: item.slotId,
      slotLabel: item.slotLabel,
      equipSlot: row?.equip_slot ?? null,
      markerCount: markers.get(Number(item.instanceId)) ?? 0,
    };
  });
  return { heroId: Number(heroId), name: detail.name, text: renderCharacterCard(detail, equipped) };
}
