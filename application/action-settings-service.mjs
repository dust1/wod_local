import { POSITION_LABELS } from "../game/domain/positions.mjs";
import { createBattlePlan, REPEAT_MODES, WAIT_COMMAND_SKILL_ID } from "../game/commands/battle-plan.mjs";
import { equippedItemPool } from "./character-instance-service.mjs";
import { catalogSkillForId, itemRequirementResolver, validateSkillItemSelections } from "./skill-item-service.mjs";

export const ACTION_SETTINGS_VERSION = 1;
export const ACTION_PHASES = Object.freeze(["initiative", "preRound", "mainRound"]);

const defaultPositions = () => Object.keys(POSITION_LABELS).map((id) => ({ id, enabled: true }));
const healingWounds = ["light", "wounded", "severe"];
const emptyHealing = () => ({ light: [], wounded: [], severe: [] });
const emptyLayer = (withPosition = true) => ({
  ...(withPosition ? { position: "rear" } : {}),
  actions: { initiative: [], preRound: [], mainRound: [] },
  ...(withPosition ? { healing: emptyHealing() } : {}),
});

export function defaultActionSettings() {
  return { version: ACTION_SETTINGS_VERSION, defaultLayer: emptyLayer(true), floors: {} };
}

export function actionSettingsDto(row) {
  if (!row?.settings_json) return defaultActionSettings();
  try {
    return normalizeActionSettings(JSON.parse(row.settings_json));
  } catch {
    return defaultActionSettings();
  }
}

function normalizeAction(action, skillIds, phase) {
  const skillId = action?.skillId == null ? null : String(action.skillId);
  const itemIds = Array.isArray(action?.itemIds)
    ? action.itemIds.filter((id) => id != null && String(id) !== "").map(String)
    : action?.itemId == null ? [] : [String(action.itemId)];
  if (skillId && skillId !== WAIT_COMMAND_SKILL_ID && skillIds && !skillIds.has(skillId)) throw new Error(`行动包含未学习的技能: ${skillId}`);
  const repeat = REPEAT_MODES.includes(action?.repeat) ? action.repeat : "normal";
  const seen = new Set();
  const positions = [];
  for (const position of Array.isArray(action?.positions) ? action.positions : defaultPositions()) {
    if (!POSITION_LABELS[position?.id] || seen.has(position.id)) continue;
    seen.add(position.id);
    positions.push({ id: position.id, enabled: position.enabled !== false });
  }
  for (const id of Object.keys(POSITION_LABELS)) if (!seen.has(id)) positions.push({ id, enabled: true });
  return { id: String(action?.id ?? `${phase}-${Date.now()}`), skillId, itemIds, itemId: itemIds[0] ?? null, repeat, positions };
}

function normalizeLayer(layer, withPosition, skillIds = new Set()) {
  const actions = {};
  for (const phase of ACTION_PHASES) {
    const source = Array.isArray(layer?.actions?.[phase]) ? layer.actions[phase] : [];
    actions[phase] = source.slice(0, phase === "initiative" ? 1 : 60).map((action) => normalizeAction(action, skillIds, phase));
  }
  return {
    ...(withPosition ? { position: POSITION_LABELS[layer?.position] ? layer.position : "rear" } : {}),
    actions,
    ...(withPosition ? { healing: Object.fromEntries(healingWounds.map((wound) => [wound,
      (Array.isArray(layer?.healing?.[wound]) ? layer.healing[wound] : []).slice(0, 5)
        .map((entry) => ({ skillId: String(entry?.skillId ?? ""), itemIds: Array.isArray(entry?.itemIds) ? entry.itemIds.filter(Boolean).map(String) : entry?.itemId == null ? [] : [String(entry.itemId)] }))
        .filter((entry) => entry.skillId),
    ])) } : {}),
  };
}

export function normalizeActionSettings(input, learnedSkillIds = null) {
  const skillIds = learnedSkillIds ? new Set(learnedSkillIds.map(String)) : null;
  const floors = {};
  for (let floor = 1; floor <= 10; floor += 1) {
    const entry = input?.floors?.[floor];
    if (entry?.override) floors[floor] = { override: true, ...normalizeLayer(entry, false, skillIds) };
  }
  return {
    version: ACTION_SETTINGS_VERSION,
    defaultLayer: normalizeLayer(input?.defaultLayer, true, skillIds),
    floors,
  };
}

/**
 * 保存行动设置。
 *
 * 带物品要求且未标记「可选」的技能必须选中一件当前已装备、类别符合的物品
 * （规则文档 §13.3 调用链）。校验只在保存入口生效：`actionSettingsToBattlePlan`
 * 不校验，历史数据仍能照常进入战斗结算。
 *
 * @param {object} repository
 * @param {number} heroId
 * @param {object} input 页面提交的行动设置
 * @param {object} options
 * @param {object} options.catalog 内容目录，用于读取技能「物品」字段
 * @param {string} options.root 项目根目录，用于读取物品详情 JSON
 * @param {number} [options.userId]
 */
export function saveActionSettings(repository, heroId, input, options = {}) {
  const { catalog, root, userId } = options;
  // 缺参数就跳过校验会静默放行，因此这里直接拒绝，避免出现「调用方忘了传」的漏洞。
  if (!catalog || !root) throw new Error("保存行动设置需要 catalog 与 root 才能校验技能调用物品");
  const learnedIds = [
    ...repository.listHeroSkills(heroId).map((skill) => skill.skill_id),
    ...repository.listTrainedHeroSkillIds(heroId).map((skill) => `skill-${skill.source_skill_id}`),
  ];
  const normalized = normalizeActionSettings(input, learnedIds);
  for (const wound of healingWounds) {
    const entries = input?.defaultLayer?.healing?.[wound];
    if (Array.isArray(entries) && entries.length > 5) throw new Error("每档最多设置五个治疗技能");
    for (const entry of normalized.defaultLayer.healing[wound]) {
      if (!learnedIds.map(String).includes(entry.skillId) || catalogSkillForId(catalog, entry.skillId)?.baseType !== "heal") {
        throw new Error(`治疗设置包含未学习或非治疗技能: ${entry.skillId}`);
      }
    }
  }
  const equippedItems = equippedItemPool({ repository, root, heroId, userId });
  const issues = validateSkillItemSelections({
    settings: normalized,
    requirementFor: itemRequirementResolver(catalog, equippedItems),
  });
  if (issues.length > 0) throw new Error(`行动设置未通过校验：${issues.join("；")}`);
  const healingIssues = validateSkillItemSelections({
    settings: { defaultLayer: { actions: normalized.defaultLayer.healing } },
    requirementFor: itemRequirementResolver(catalog, equippedItems),
  });
  if (healingIssues.length > 0) throw new Error(`治疗设置未通过校验：${healingIssues.join("；")}`);
  return actionSettingsDto(repository.upsertHeroActionSettings(heroId, normalized));
}

/** 把 hero_action_settings 的页面 DTO 转成纯领域 BattlePlan。 */
export function actionSettingsToBattlePlan(settings, heroId, name = "角色行动设置") {
  const normalized = normalizeActionSettings(settings);
  const command = (entry) => ({
    id: entry.id,
    skillId: entry.skillId,
    itemIds: entry.itemIds,
    repeat: entry.repeat,
    target: {
      mode: "auto",
      priority: entry.positions.filter((position) => position.enabled).map((position) => position.id),
    },
  });
  const layer = (entry, fallbackPosition) => ({
    position: entry.position ?? fallbackPosition,
    initiativeSkillId: entry.actions.initiative[0]?.skillId ?? null,
    initiativeItemIds: entry.actions.initiative[0]?.itemIds ?? [],
    preRound: entry.actions.preRound.filter((entry) => entry.skillId).map(command),
    mainRound: entry.actions.mainRound.filter((entry) => entry.skillId).map(command),
    healing: Object.fromEntries(healingWounds.map((wound) => [wound,
      normalized.defaultLayer.healing[wound].map((healing, index) => ({ id: `healing-${wound}-${index}`, skillId: healing.skillId, itemIds: healing.itemIds })),
    ])),
  });
  const floorOverrides = {};
  for (const [floor, entry] of Object.entries(normalized.floors)) {
    floorOverrides[floor] = layer(entry, normalized.defaultLayer.position);
  }
  return createBattlePlan({
    id: `hero-action-settings-${heroId}`,
    name,
    mode: "pve",
    defaultPlan: layer(normalized.defaultLayer, normalized.defaultLayer.position),
    floorOverrides,
  });
}
