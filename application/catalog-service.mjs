// 内容目录用例。设计文档 §4.6、§22、§20.1。
// 只读 gamedata/generated（ETL 产物）并合并 gamedata/overrides（人工校正）。
// 不解析 HTML，不访问网络。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { STARTER_SKILLS, STARTER_ITEMS } from "../gamedata/overrides/starter-content.mjs";
import { parseMaxTargetsFormula } from "../game/domain/skill.mjs";

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`GameData 文件损坏 ${path}: ${error.message}`);
  }
}

function asArray(value, key) {
  if (value === null) return null;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[key])) return value[key];
  return null;
}

/**
 * 目标是否允许选择召唤物。
 * 原始技能页只在少数技能上写明“非召唤”，因此默认允许；
 * 这里显式记录修正原因，不静默改写 ETL 数据（设计文档 §4.6）。
 */
function normalizeAllowSummons(target) {
  if (!target) return target;
  const rawText = String(target.rawText ?? "");
  if (rawText.includes("非召唤")) return { ...target, allowSummons: false };
  if (target.allowSummons === false) {
    return { ...target, allowSummons: true, allowSummonsCorrected: true };
  }
  return target;
}

/** 统一 ETL 与人工校正记录的字段形状，保证引擎可以无条件读取。 */
function normalizeSkill(skill, extraWarnings) {
  const warnings = [...(skill.warnings ?? skill.meta?.warnings ?? [])];
  let target = normalizeAllowSummons(skill.target);
  const formulaWarning = warnings.find((warning) => String(warning).startsWith("target:max-count-modifier-not-represented:"));
  const rawFormula = /^target:max-count-modifier-not-represented:"(.*)"$/.exec(String(formulaWarning ?? ""))?.[1];
  const maxTargetsFormula = skill.target?.maxTargetsFormula ?? parseMaxTargetsFormula(rawFormula ?? "");
  if (target && maxTargetsFormula) target = { ...target, maxTargetsFormula };
  if (target?.allowSummonsCorrected) warnings.push("target-allow-summons-corrected");
  if (!skill.baseType) warnings.push("base-type-missing");
  if (extraWarnings) warnings.push(...extraWarnings);
  return {
    ...skill,
    baseType: skill.baseType ?? null,
    timing: skill.timing ?? { preRound: false, mainAction: false, initiative: false, reactiveDefense: false, passive: false },
    target,
    attributeFormula: skill.attributeFormula ?? {},
    manaCost: skill.manaCost ?? null,
    itemRequirement: skill.itemRequirement ?? null,
    effects: skill.effects ?? skill.targetEffects ?? [],
    targetEffects: skill.targetEffects ?? skill.effects ?? [],
    globalEffectBonus: skill.globalEffectBonus ?? [],
    skillTypeNames: skill.skillTypeNames ?? [],
    ownerPassives: skill.ownerPassives ?? [],
    skillLevelBonuses: skill.skillLevelBonuses ?? [],
    warnings,
    unsupported: !skill.baseType,
  };
}

function normalizeItem(item) {
  return {
    ...item,
    categories: item.categories ?? [],
    requiredTogetherCategories: item.requiredTogetherCategories ?? [],
    modifiers: item.modifiers ?? null,
    triggeredEffects: item.triggeredEffects ?? null,
    uniqueness: item.uniqueness ?? "none",
  };
}

/**
 * 载入内容目录。
 * @param {object} [options]
 * @param {string} [options.generatedDir] 默认 gamedata/generated
 * @param {boolean} [options.includeOverrides] 是否合并人工校正，默认 true
 * @param {boolean} [options.includeItems] 是否解析物品索引（12 MB），默认 false，按需加载
 * @param {object} [options.fallback] 生成数据缺失时的职业/种族回退
 */
export function loadCatalog(options = {}) {
  const generatedDir = resolve(options.generatedDir ?? "gamedata/generated");
  const manifest = readJson(resolve(generatedDir, "manifest.json"));
  const warnings = [];

  const skills = new Map();
  const items = new Map();
  const relations = [];
  let professions = asArray(readJson(resolve(generatedDir, "professions.json")), "professions");
  let races = asArray(readJson(resolve(generatedDir, "races.json")), "races");
  const enums = readJson(resolve(generatedDir, "enums.json")) ?? {};

  const generatedSkills = asArray(readJson(resolve(generatedDir, "skills.json")), "skills") ?? [];
  const generatedBySourceId = new Map();
  for (const raw of generatedSkills) {
    if (!raw?.id) {
      warnings.push("生成数据中存在缺少 id 的技能记录");
      continue;
    }
    const skill = normalizeSkill(raw);
    skills.set(skill.id, skill);
    if (skill.sourceId !== null && skill.sourceId !== undefined) generatedBySourceId.set(skill.sourceId, skill.id);
  }

  if (options.includeItems) {
    const generatedItems = asArray(readJson(resolve(generatedDir, "items.json")), "items") ?? [];
    for (const raw of generatedItems) {
      if (!raw?.id) {
        warnings.push("生成数据中存在缺少 id 的物品记录");
        continue;
      }
      items.set(raw.id, normalizeItem(raw));
    }
  }

  const generatedRelations = asArray(readJson(resolve(generatedDir, "skill-relations.json")), "relations") ?? [];
  relations.push(...generatedRelations);

  if (!manifest) warnings.push(`未找到 ${generatedDir}/manifest.json，仅使用人工校正内容`);

  let overrideCount = 0;
  let mergedCount = 0;
  if (options.includeOverrides !== false) {
    for (const override of STARTER_SKILLS) {
      // 人工校正按 sourceId 对齐 ETL 记录：校正覆盖同源生成记录，并保留原始记录以便对比。
      let id = override.id;
      let generated = skills.get(override.id) ?? null;
      if (override.sourceId !== null && override.sourceId !== undefined) {
        const generatedId = generatedBySourceId.get(override.sourceId);
        if (generatedId && generatedId !== override.id) {
          generated = skills.get(generatedId) ?? generated;
          skills.delete(generatedId);
          mergedCount += 1;
        }
      }
      const merged = normalizeSkill(generated ? { ...generated, ...override, generated } : override, generated ? ["override-merged-by-source-id"] : null);
      skills.set(id, merged);
      overrideCount += 1;
    }
    for (const item of STARTER_ITEMS) {
      const previous = items.get(item.id);
      items.set(item.id, previous ? { ...previous, ...item, generated: previous } : normalizeItem(item));
    }
  }

  if (!professions || professions.length === 0) {
    professions = options.fallback?.professions ?? professions ?? [];
    if (professions.length === 0) warnings.push("缺少 professions.json");
    else warnings.push("使用运行时数据库中的职业列表作为回退");
  }
  if (!races || races.length === 0) {
    races = options.fallback?.races ?? races ?? [];
    if (races.length === 0) warnings.push("缺少 races.json");
    else warnings.push("使用运行时数据库中的种族列表作为回退");
  }

  const qualityReport = readJson(resolve(generatedDir, "quality-report.json"));

  const skillList = [...skills.values()];
  return {
    contentVersion: manifest?.contentVersion ?? "overrides-only",
    generatedAt: manifest?.generatedAt ?? null,
    parserVersions: manifest?.parserVersions ?? null,
    counts: {
      skills: skills.size,
      skillsUnsupported: skillList.filter((skill) => skill.unsupported).length,
      skillsWithWarnings: skillList.filter((skill) => skill.warnings.length > 0).length,
      items: items.size,
      itemsLoaded: options.includeItems === true,
      relations: relations.length,
      professions: professions.length,
      races: races.length,
      overrides: overrideCount,
      overridesMergedBySourceId: mergedCount,
    },
    skills,
    items,
    relations,
    professions,
    races,
    enums,
    qualityReport,
    warnings: [...warnings, ...(manifest?.warnings ?? [])],
  };
}

/**
 * 按需加载物品索引。12 MB 的 items.json 不在服务启动时解析。
 */
export function loadItems(catalog, options = {}) {
  // 注意：不能用 items.size 判断是否已加载，人工校正物品会让它一开始就非空。
  if (catalog.counts.itemsLoaded) return catalog.items;
  const generatedDir = resolve(options.generatedDir ?? "gamedata/generated");
  const generatedItems = asArray(readJson(resolve(generatedDir, "items.json")), "items") ?? [];
  for (const raw of generatedItems) {
    if (!raw?.id) continue;
    catalog.items.set(raw.id, normalizeItem(raw));
  }
  for (const item of STARTER_ITEMS) {
    const previous = catalog.items.get(item.id);
    catalog.items.set(item.id, previous ? { ...previous, ...item, generated: previous } : normalizeItem(item));
  }
  catalog.counts.items = catalog.items.size;
  catalog.counts.itemsLoaded = true;
  return catalog.items;
}

/** 技能定义 Map → 引擎需要的纯对象。 */
export function skillMapForEngine(catalog, skillIds) {
  const map = {};
  const ids = skillIds ?? [...catalog.skills.keys()];
  for (const id of ids) {
    const skill = catalog.skills.get(id);
    if (skill && !skill.unsupported) map[id] = skill;
  }
  return map;
}

/** 列出生成目录中实际存在的文件，供诊断页展示。 */
export function listGeneratedFiles(generatedDir = "gamedata/generated") {
  const dir = resolve(generatedDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const stats = statSync(resolve(dir, name));
      return `${name}（${(stats.size / 1024).toFixed(1)} KB）`;
    });
}
