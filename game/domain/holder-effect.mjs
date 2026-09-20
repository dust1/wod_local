// 持有者效果解析。设计文档 §8.6、§9、§9.7、§15.5。
//
// 「作用在技能拥有者上的效果」（data/profession_skills|race_skills/<id>.json）
// 与「作用在物品持有者上的效果」（data/items/<id>.json）字段形状完全一致，
// 因此共用同一套解析与分类逻辑，只有来源与生效条件不同：
//   技能侧：技能等级 ≥ 1 时生效。
//   物品侧：装备期间生效。
//
// 记录形状（原样来自 item_cache / skill_cache 的解析产物）：
//   {
//     "类型": <九种之一>,
//     "<维度键>": <目标名>,          // 属性 | 攻击方式 | 伤害方式 | 技能 | 奖励
//     "修正": "+3" | "" | "+1 -15%" | "+50%×技能等级" ...,
//     "护甲(r)" | "伤害奖励(r)" | "奖励(r)": "普通 / 重击 / 致命"
//   }
// 「修正」为空时数值落在 (r) 三元组键上，三个值依次对应 普通/重击/致命。
//
// 本模块是纯函数集合：不读文件、不读系统时间、不接触数据库。
import {
  BASE_ATTRIBUTE_TARGET_KEYS,
  CHARACTER_ATTRIBUTE_TARGET_KEYS,
  CHARACTER_SLOT_CAPACITY_TARGET_KEYS,
  DERIVED_CHARACTER_KEYS,
} from "./attributes.mjs";

/** (r) 三元组的命中等级顺序。 */
export const GRADE_KEYS = Object.freeze(["normal", "critical", "lethal"]);

export const GRADE_LABELS = Object.freeze({ normal: "普通", critical: "重击", lethal: "致命" });

/**
 * 九种持有者效果「类型」到内部类别的映射。
 * bucket 决定该效果最终汇总到角色实例的哪一块。
 */
export const EFFECT_CATEGORIES = Object.freeze({
  属性奖励: { id: "attributeBonus", bucket: "attribute" },
  对技能等级的奖励: { id: "skillLevelBonus", bucket: "skillLevel" },
  对技能效果的奖励: { id: "skillEffectBonus", bucket: "skillEffect" },
  护甲奖励: { id: "armorBonus", bucket: "armor" },
  伤害奖励: { id: "damageBonus", bucket: "damage" },
  攻击奖励: { id: "attackBonus", bucket: "attack" },
  防御奖励: { id: "defenseBonus", bucket: "defense" },
  "对此种攻击方式，攻击类型伤害的脆弱性": { id: "vulnerabilityBonus", bucket: "vulnerability" },
  "地城探险得到的物品掉落奖励": { id: "dungeonLootBonus", bucket: "dungeonLoot" },
});

/** 维度键 → 内部维度名。 */
export const DIMENSION_KEYS = Object.freeze({
  属性: "attribute",
  攻击方式: "attackType",
  伤害方式: "damageType",
  技能: "skill",
  奖励: "loot",
});

/**
 * 「属性」维度的目标名 → 角色实例内部属性键。
 * 前八项是设计文档 §6.2 的八项基础属性；其余是 §6.3 的派生属性。
 */
export const ATTRIBUTE_TARGET_KEYS = CHARACTER_ATTRIBUTE_TARGET_KEYS;

/** 基础属性与派生属性的分界，供来源归类使用。 */
export const BASE_ATTRIBUTE_KEYS = BASE_ATTRIBUTE_TARGET_KEYS;

export const DERIVED_KEYS = DERIVED_CHARACTER_KEYS;

/**
 * 「属性」维度里表示装备位容量而非角色属性的目标名。
 * 它们不参与角色数值推导，单独成组，避免混进未映射告警。
 */
export const SLOT_CAPACITY_TARGET_KEYS = CHARACTER_SLOT_CAPACITY_TARGET_KEYS;

/** 「所有」等通配写法，表示不限定攻击方式或伤害方式。 */
export const GLOBAL_SCOPE_NAMES = Object.freeze(["所有", "全部", "任何"]);

/** 「X 类别的所有技能」这一类目标，表示按技能类型批量加成。 */
const SKILL_CATEGORY_PATTERN = /类别的所有/;

export function isGlobalScope(name) {
  return GLOBAL_SCOPE_NAMES.includes(String(name ?? "").trim());
}

/** 去掉目标名里的 (a)/(z)/(r) 等标记，只留纯名称。 */
export function cleanTargetName(raw) {
  return String(raw ?? "")
    .replace(/[（(]\s*[a-zA-ZrR]\s*[)）]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从任意字段里收集 (a)/(z) 标记。
 * 标记未必写在「修正」里——`"攻击方式": "近战 (a)"` 同样表示仅实际使用时生效。
 */
export function collectMarkers(record) {
  const text = Object.values(record ?? {}).map((value) => String(value ?? "")).join(" ");
  return {
    onUseOnly: /\(\s*a\s*\)/i.test(text),
    damageTypeOnly: /\(\s*z\s*\)/i.test(text),
  };
}

/**
 * 修正项词法：按出现顺序切分文本，逐项判定单位为「固定值 / 百分比 / 按等级缩放」。
 *
 * 规则覆盖全部实测形态：
 *   +3            → flat
 *   -25%          → percent
 *   +技能等级      → scaledFlat(skillLevel, ±1)
 *   +英雄等级      → scaledFlat(heroLevel, ±1)
 *   +50%×技能等级  → scaledValue(skillLevel, 50)，求值后是固定值
 *   +20%×英雄等级  → scaledValue(heroLevel, 20)，求值后是固定值
 *   +75 x 英雄等级 → scaledFlat(heroLevel, 75)   （实测存在的无百分号变体）
 *   +1 -15%       → 两项，逐项解析
 */
const TERM_PATTERN = new RegExp(
  [
    "([+-]?\\s*\\d+(?:\\.\\d+)?\\s*%\\s*[×x*]\\s*(?:技能等级|英雄等级))",
    "([+-]?\\s*\\d+(?:\\.\\d+)?\\s*[×x*]\\s*(?:技能等级|英雄等级))",
    "([+-]?\\s*(?:技能等级|英雄等级))",
    "([+-]?\\s*\\d+(?:\\.\\d+)?\\s*%)",
    "([+-]?\\s*\\d+(?:\\.\\d+)?)",
  ].join("|"),
  "g",
);

function numeric(text) {
  const value = Number(String(text).replace(/\s/g, ""));
  return Number.isFinite(value) ? value : null;
}

function detectScale(text) {
  if (/技能等级/.test(text)) return "skillLevel";
  if (/英雄等级/.test(text)) return "heroLevel";
  return null;
}

/** 单个修正项 → 结构化修正。无法识别时返回 null，由调用方计入警告。 */
export function parseCorrectionTerm(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  const scale = detectScale(text);
  const numberMatch = text.match(/[+-]?\s*\d+(?:\.\d+)?/);
  const value = numberMatch ? numeric(numberMatch[0]) : null;

  if (scale) {
    if (value !== null && /%/.test(text) && /[×x*]/.test(text)) {
      return { kind: "scaledValue", scale, ratio: value, rawText: text };
    }
    if (value !== null && /[×x*]/.test(text)) {
      return { kind: "scaledFlat", scale, ratio: value, rawText: text };
    }
    if (value === null) {
      const sign = /^\s*-/.test(text) ? -1 : 1;
      return { kind: "scaledFlat", scale, ratio: sign, rawText: text };
    }
    return { kind: "scaledFlat", scale, ratio: value, rawText: text };
  }

  if (value === null) return null;
  if (/%/.test(text)) return { kind: "percent", value, rawText: text };
  return { kind: "flat", value, rawText: text };
}

/**
 * 解析一段「修正」或 (r) 单元格文本，返回全部修正项。
 *
 * 逐项剔除已识别的写法后再检查残留：残留只在确实存在未覆盖写法时出现，
 * 因此「+」「-」这类残缺单元格不会产生噪声告警。
 *
 * @returns {{terms: object[], unparsed: string[]}}
 */
export function parseCorrection(text) {
  const source = String(text ?? "").replace(/[（(]\s*[a-zA-Z]\s*[)）]/g, "");
  const terms = [];
  const pieces = [];
  let cursor = 0;
  TERM_PATTERN.lastIndex = 0;
  let match;
  while ((match = TERM_PATTERN.exec(source)) !== null) {
    pieces.push(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const term = parseCorrectionTerm(match[0]);
    if (term) terms.push(term);
  }
  pieces.push(source.slice(cursor));
  const residue = pieces
    .join(" ")
    .replace(/[+\-/%×x*\s]/g, "")
    .trim();
  return { terms, unparsed: residue === "" ? [] : [residue] };
}

/** (r) 三元组 → 三个修正项数组。 */
export function parseGradeCorrection(text) {
  const parts = String(text ?? "").split("/");
  return GRADE_KEYS.map((key, index) => ({
    grade: key,
    gradeLabel: GRADE_LABELS[key],
    ...parseCorrection(parts[index] ?? ""),
  }));
}

/**
 * 把一条原始持有者效果记录归类为角色实例可直接消费的结构。
 *
 * @param {object} record 原始缓存记录
 * @returns {{
 *   category: string, categoryId: string, bucket: string,
 *   dimension: string|null, targetName: string|null, targetKey: string|null,
 *   attackScope: string|null, skillCategory: boolean,
 *   terms: object[], grades: object[]|null,
 *   onUseOnly: boolean, damageTypeOnly: boolean,
 *   warnings: string[]
 * }|null}
 */
export function classifyHolderRecord(record) {
  const rawCategory = String(record?.["类型"] ?? "").trim();
  const category = EFFECT_CATEGORIES[rawCategory];
  if (!category) return null;

  const warnings = [];
  const markers = collectMarkers(record);

  const gradeKey = Object.keys(record).find((key) => key.endsWith("(r)"));
  const dimensionKey = Object.keys(record).find((key) => key in DIMENSION_KEYS && !key.endsWith("(r)"));
  const dimension = dimensionKey ? DIMENSION_KEYS[dimensionKey] : null;
  if (!dimension) warnings.push(`无法识别维度键: ${JSON.stringify(record)}`);

  const rawTarget = dimensionKey ? cleanTargetName(record[dimensionKey]) : "";
  const attackScope = record["攻击方式"] === undefined ? null : cleanTargetName(record["攻击方式"]);
  const isSkillDimension = dimension === "skill";
  const skillCategory = isSkillDimension && SKILL_CATEGORY_PATTERN.test(String(record["技能"] ?? ""));

  let targetKey = null;
  let bucket = category.bucket;
  if (dimension === "attribute") {
    if (rawTarget in SLOT_CAPACITY_TARGET_KEYS) {
      // 装备位容量不属于角色属性，单独成组。
      targetKey = SLOT_CAPACITY_TARGET_KEYS[rawTarget];
      bucket = "slotCapacity";
    } else {
      targetKey = ATTRIBUTE_TARGET_KEYS[rawTarget] ?? null;
      if (!targetKey) warnings.push(`未映射的属性目标: ${rawTarget}`);
    }
  }

  const valueText = String(record["修正"] ?? "").trim();
  const parsed = gradeKey
    ? { terms: [], unparsed: [] }
    : parseCorrection(valueText);
  const grades = gradeKey ? parseGradeCorrection(record[gradeKey]) : null;
  warnings.push(...parsed.unparsed.map((entry) => `未识别的修正写法: ${entry}`));
  if (grades) {
    for (const grade of grades) warnings.push(...grade.unparsed.map((entry) => `未识别的修正写法(${grade.gradeLabel}): ${entry}`));
  }

  return {
    category: rawCategory,
    categoryId: category.id,
    bucket,
    dimension,
    targetName: rawTarget || null,
    targetKey,
    attackScope,
    skillCategory,
    terms: parsed.terms,
    grades,
    // 该条效果的完整原始数值文本：(r) 行取三元组单元格，其余取「修正」。
    // 用于来源去重与页面回溯，避免按档位/分项重复登记同一来源。
    valueText: gradeKey ? String(record[gradeKey] ?? "") : valueText,
    onUseOnly: markers.onUseOnly,
    damageTypeOnly: markers.damageTypeOnly,
    warnings,
  };
}

/**
 * 解析一份详情 JSON 的持有者效果段落。
 *
 * @param {object} detail 详情 JSON（含「作用在…拥有者/持有者上的效果」）
 * @param {object} source { kind: "skill"|"item", id, name, holderKey }
 * @returns {{entries: object[], warnings: string[]}}
 */
export function readHolderEffects(detail, source) {
  const holderKey = source?.holderKey
    ?? (source?.kind === "item" ? "作用在物品持有者上的效果" : "作用在技能拥有者上的效果");
  const records = Array.isArray(detail?.[holderKey]) ? detail[holderKey] : [];
  const entries = [];
  const warnings = [];
  records.forEach((record, index) => {
    const classified = classifyHolderRecord(record);
    if (!classified) {
      warnings.push(`${source.kind}:${source.id} 第 ${index + 1} 条效果的类型无法识别: ${JSON.stringify(record["类型"])}`);
      return;
    }
    entries.push({
      ...classified,
      sourceKind: source.kind,
      sourceId: source.id,
      sourceName: source.name ?? String(source.id),
      index,
      warnings: classified.warnings,
    });
    warnings.push(...classified.warnings.map((warning) => `${source.kind}:${source.id} ${warning}`));
  });
  return { entries, warnings };
}

/**
 * 汇总一组持有者效果条目，按 bucket + 目标聚合。
 * @param {object[]} entries
 */
export function groupHolderEffects(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.bucket}|${entry.dimension}|${entry.targetKey ?? entry.targetName ?? "-"}|${entry.attackScope ?? "-"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        bucket: entry.bucket,
        categoryId: entry.categoryId,
        dimension: entry.dimension,
        targetName: entry.targetName,
        targetKey: entry.targetKey,
        attackScope: entry.attackScope,
        skillCategory: entry.skillCategory,
        terms: [],
        grades: entry.grades ? GRADE_KEYS.map((grade) => ({ grade, terms: [] })) : null,
        onUseOnly: false,
        damageTypeOnly: false,
        sources: [],
      });
    }
    const group = groups.get(key);
    group.onUseOnly = group.onUseOnly || entry.onUseOnly;
    group.damageTypeOnly = group.damageTypeOnly || entry.damageTypeOnly;
    group.sources.push({ sourceKind: entry.sourceKind, sourceId: entry.sourceId, sourceName: entry.sourceName, category: entry.category, onUseOnly: entry.onUseOnly, rawText: entry.terms.map((term) => term.rawText).join(" ") || null });
    if (entry.grades) {
      entry.grades.forEach((grade, index) => {
        if (group.grades?.[index]) group.grades[index].terms.push(...grade.terms);
      });
    } else {
      group.terms.push(...entry.terms);
    }
  }
  return [...groups.values()];
}
