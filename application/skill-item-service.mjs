// 技能「调用物品」。设计文档 §9.6、规则文档 §13.3。
//
// 技能页的「物品」字段由 ETL 解析成 skill.itemRequirement
// （冻结技能资产的调用物品需求格式）：
//   原始为 "-" 或空           → null
//   "剑"                      → { rawText: "剑",        itemTypeName: "剑",        categories: [3] }
//   "灵素 (可选)"              → { rawText: "灵素 (可选)", itemTypeName: "灵素",       categories: [361] }
// 这里把该字段与角色**当前已装备**的物品做匹配：候选 = 物品类别含 itemTypeName 的物品。
// 主物品自己还能要求配合物品：物品 JSON 的「需配合何物使用」，占位值 `-` 视为无要求
// （见 game/domain/item.mjs 的 companionItemTypeNames）。
//
// 匹配用名称而不是 categories 里的数字 ID：category 表缺了少数类别名
// （例如「大地圣物」在物品类别里存在、在 category 表里不存在），按名称比对覆盖更全。

import { companionItemTypeNames } from "../game/domain/item.mjs";

/** 技能「物品」字段是否表达了物品需求（非空且不是 "-"），以及是否标记为可选。 */
export function itemRequirementOf(definition) {
  const requirement = definition?.itemRequirement ?? null;
  const itemTypeName = requirement?.itemTypeName == null ? null : String(requirement.itemTypeName).trim();
  if (!itemTypeName) return null;
  const rawText = String(requirement.rawText ?? itemTypeName);
  return {
    rawText,
    itemTypeName,
    optional: /\(\s*可选\s*\)/.test(rawText),
    skillName: definition?.name ?? null,
  };
}

function bareItemCandidatesFor(requirement, equippedItems = []) {
  if (!requirement) return [];
  const seen = new Set();
  const candidates = [];
  for (const item of equippedItems) {
    if (!Array.isArray(item?.itemTypes) || !item.itemTypes.includes(requirement.itemTypeName)) continue;
    const key = String(item.itemId);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ itemId: item.itemId, instanceId: item.instanceId ?? null, name: item.name ?? null });
  }
  return candidates.sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? ""), "zh-CN"));
}

/** 候选物品：已装备物品中物品类别包含该 tag 的那些，按物品定义去重。 */
export function itemCandidatesFor(requirement, equippedItems = []) {
  return bareItemCandidatesFor(requirement, equippedItems).map((candidate) => {
    const item = equippedItems.find((entry) => String(entry.itemId) === String(candidate.itemId));
    const companionItemTypes = companionItemTypeNames(item?.companionItemTypes);
    const companionRequirements = companionItemTypes.map((itemTypeName) => ({
      itemTypeName,
      candidates: bareItemCandidatesFor({ itemTypeName }, equippedItems),
    }));
    return { ...candidate, companionRequirements };
  });
}

/** 技能定义 → DTO 用的物品要求（含候选物品），无需求时为 null。 */
export function skillItemRequirementFor(definition, equippedItems = []) {
  const requirement = itemRequirementOf(definition);
  if (!requirement) return null;
  return { ...requirement, candidates: itemCandidatesFor(requirement, equippedItems) };
}

/**
 * 行动设置里的 skillId 解析成目录技能定义。
 * 稳定技能直接用目录 id；训练系统学到的技能用 `skill-<sourceId>`。
 */
export function catalogSkillForId(catalog, skillId) {
  if (skillId == null) return null;
  const direct = catalog?.skills?.get(String(skillId));
  if (direct) return direct;
  const match = /^skill-(\d+)$/.exec(String(skillId));
  if (!match) return null;
  const sourceId = Number(match[1]);
  for (const skill of catalog?.skills?.values() ?? []) {
    if (Number(skill?.sourceId) === sourceId) return skill;
  }
  return null;
}

/** 按 skillId 建立「技能 → 物品要求（含候选）」的查询函数，避免每层重复解析。 */
export function itemRequirementResolver(catalog, equippedItems = []) {
  const cache = new Map();
  return (skillId) => {
    if (skillId == null) return null;
    const key = String(skillId);
    if (!cache.has(key)) cache.set(key, skillItemRequirementFor(catalogSkillForId(catalog, key), equippedItems));
    return cache.get(key);
  };
}

const LAYER_LABELS = { defaultLayer: "默认层" };

function layerLabel(key) {
  return LAYER_LABELS[key] ?? `第 ${key} 层`;
}

function issueText(scope, skillName, requirement, reason) {
  const name = skillName ?? "所选技能";
  if (reason === "missing") {
    return requirement.candidates.length === 0
      ? `${scope}「${name}」需要调用物品（${requirement.itemTypeName}），当前没有已装备的该类物品，请先装备后再保存，或删除该行动`
      : `${scope}「${name}」需要选择调用物品（${requirement.itemTypeName}）`;
  }
  return `${scope}「${name}」所选的调用物品已不在已装备的「${requirement.itemTypeName}」类物品中，请重新选择`;
}

function companionIssueText(scope, skillName, itemTypeName, reason) {
  const name = skillName ?? "所选技能";
  return reason === "missing"
    ? `${scope}「${name}」所选物品还需要选择配合物品（${itemTypeName}）`
    : `${scope}「${name}」所选的配合物品已不在已装备的「${itemTypeName}」类物品中，请重新选择`;
}

/**
 * 校验行动设置里的「调用物品」选择。
 *
 * 规则：带物品要求且未标记「可选」的技能必须选中一件当前已装备、类别符合的物品；
 * 标记「可选」的技能不做校验（留空或沿用旧值都允许）。
 * 无物品要求的技能跳过。
 *
 * @param {object} input
 * @param {object} input.settings 已规范化的行动设置
 * @param {Function} input.requirementFor skillId → 物品要求（见 itemRequirementResolver）
 * @returns {string[]} 人类可读的问题列表，空数组表示通过
 */
export function validateSkillItemSelections({ settings, requirementFor }) {
  const issues = [];
  const layers = [["defaultLayer", settings?.defaultLayer], ...Object.entries(settings?.floors ?? {})];
  for (const [key, layer] of layers) {
    if (!layer) continue;
    const scope = layerLabel(key);
    for (const actions of Object.values(layer.actions ?? {})) {
      for (const action of Array.isArray(actions) ? actions : []) {
        const requirement = requirementFor(action?.skillId);
        if (!requirement) continue;
        const chosen = Array.isArray(action?.itemIds)
          ? action.itemIds.map(String)
          : action?.itemId == null ? [] : [String(action.itemId)];
        if (chosen.length === 0 && !requirement.optional) {
          issues.push(issueText(scope, requirement.skillName, requirement, "missing"));
          continue;
        }
        if (chosen.length === 0) continue;
        const primary = requirement.candidates.find((candidate) => String(candidate.itemId) === chosen[0]);
        if (!primary) {
          issues.push(issueText(scope, requirement.skillName, requirement, "unavailable"));
          continue;
        }
        for (const [index, companion] of (primary.companionRequirements ?? []).entries()) {
          const chosenId = chosen[index + 1];
          if (!chosenId) issues.push(companionIssueText(scope, requirement.skillName, companion.itemTypeName, "missing"));
          else if (!(companion.candidates ?? []).some((candidate) => String(candidate.itemId) === chosenId)) {
            issues.push(companionIssueText(scope, requirement.skillName, companion.itemTypeName, "unavailable"));
          }
        }
      }
    }
  }
  return issues;
}
