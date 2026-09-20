// 技能定义。设计文档 §8。
// 攻击用途和攻击方式是两个不同维度。

export const BASE_TYPES = Object.freeze({
  1: "heal",
  2: "improve",
  3: "attack",
  4: "deteriorate",
  5: "summon",
  6: "defend",
  7: "initiative",
});

export const BASE_TYPE_IDS = Object.freeze(
  Object.fromEntries(Object.entries(BASE_TYPES).map(([id, key]) => [key, Number(id)])),
);

export const BASE_TYPE_LABELS = Object.freeze({
  heal: "治疗",
  improve: "改良",
  attack: "攻击",
  deteriorate: "恶化",
  summon: "召唤伙伴",
  defend: "防御",
  initiative: "先攻权",
});

export const BASE_TYPE_BY_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(BASE_TYPE_LABELS).map(([key, label]) => [label, key])),
);

export const ATTACK_TYPES = Object.freeze({
  1: "爆破",
  2: "冲击",
  3: "病毒",
  4: "自然灾害",
  5: "触动陷阱",
  6: "魔法诅咒",
  7: "心理攻击",
  8: "魔法弹",
  9: "解除陷阱",
  10: "魔法",
  11: "近战",
  12: "偷袭",
  13: "远程",
});

export const ATTACK_TYPE_IDS = Object.freeze(
  Object.fromEntries(Object.entries(ATTACK_TYPES).map(([id, name]) => [name, Number(id)])),
);

/** 教材明确提到、拥有标准防御技能的常规攻防方式。 */
export const STANDARD_DEFENSE_ATTACK_TYPES = Object.freeze(["近战", "远程", "魔法", "心理攻击"]);

export function isStandardDefenseAttackType(attackType) {
  return STANDARD_DEFENSE_ATTACK_TYPES.includes(attackType);
}

export const EMPTY_TIMING = Object.freeze({
  preRound: false,
  mainAction: false,
  initiative: false,
  reactiveDefense: false,
  passive: false,
});

export const TIMING_LABELS = Object.freeze({
  preRound: "回合前",
  mainAction: "主回合",
  initiative: "先攻",
  reactiveDefense: "防御",
  passive: "被动",
});

/**
 * 从技能页的“可以被用于”文本解析使用时机。
 * 原始文本同时保留，未识别的片段进入 warnings。
 */
export function parseTiming(rawText = "") {
  const text = String(rawText);
  const timing = { ...EMPTY_TIMING };
  const warnings = [];
  if (text.includes("回合前")) timing.preRound = true;
  if (text.includes("主回合")) timing.mainAction = true;
  if (text.includes("先攻")) timing.initiative = true;
  if (text.includes("防御")) timing.reactiveDefense = true;
  if (text.includes("被动")) timing.passive = true;
  if (!Object.values(timing).some(Boolean) && text.trim() !== "" && text.trim() !== "-") {
    warnings.push(`无法识别的使用时机: ${text.trim()}`);
  }
  return { timing, warnings };
}

export const TARGET_SIDES = Object.freeze(["ally", "enemy", "either"]);

/**
 * 从技能页的“目标”文本解析目标模式。
 * 规则见 §8.4：同位置 AOE 的所有目标必须来自同一站位，人数不足不得跨位置补齐。
 */
export function parseTargetSpec(rawText = "") {
  const text = String(rawText);
  const warnings = [];
  let side = "enemy";
  if (text.includes("自己")) side = "either";
  else if (text.includes("队友")) side = "ally";
  else if (text.includes("敌人")) side = "enemy";

  let mode = "single";
  if (text.includes("自己")) mode = "self";
  else if (text.includes("同一位置") && text.includes("所有")) mode = "samePositionAoE";
  else if (text.includes("所有")) mode = "globalAoE";

  let maxTargets = mode === "single" || mode === "self" ? 1 : Number.POSITIVE_INFINITY;
  const numberMatch = text.match(/(\d+)\s*(?:个|名)/);
  if (numberMatch) maxTargets = Number(numberMatch[1]);

  if (text.trim() === "") warnings.push("目标文本为空");
  return {
    spec: {
      side,
      mode,
      maxTargets,
      allowSummons: !text.includes("非召唤"),
      rawText: text,
    },
    warnings,
  };
}

/**
 * 技能定义工厂，带基础校验。
 */
export function createSkillDefinition(input) {
  const warnings = [];
  if (!input?.id) throw new Error("技能缺少 id");
  if (!input?.name) throw new Error(`技能 ${input.id} 缺少 name`);
  if (!BASE_TYPE_LABELS[input.baseType]) throw new Error(`技能 ${input.id} 的 baseType 无效: ${input.baseType}`);

  const attackType = input.attackType ?? (input.attackTypeId ? ATTACK_TYPES[input.attackTypeId] : undefined);
  if (attackType && !ATTACK_TYPE_IDS[attackType]) warnings.push(`未知攻击方式: ${attackType}`);
  if (input.baseType !== "attack" && input.baseType !== "deteriorate" && attackType) {
    warnings.push(`${input.baseType} 技能带有攻击方式 ${attackType}，请确认是否为技能定义`);
  }

  return {
    id: input.id,
    sourceId: input.sourceId ?? null,
    name: input.name,
    baseType: input.baseType,
    baseTypeId: BASE_TYPE_IDS[input.baseType],
    attackTypeId: attackType ? ATTACK_TYPE_IDS[attackType] : undefined,
    attackType,
    timing: { ...EMPTY_TIMING, ...(input.timing ?? {}) },
    target: {
      side: input.target?.side ?? "enemy",
      mode: input.target?.mode ?? "single",
      maxTargets: input.target?.maxTargets ?? 1,
      positionPriority: input.target?.positionPriority,
      allowSummons: input.target?.allowSummons ?? true,
      rawText: input.target?.rawText ?? "",
    },
    attributeFormula: input.attributeFormula ?? {},
    manaCost: input.manaCost ?? null,
    itemRequirement: input.itemRequirement ?? null,
    effects: input.effects ?? [],
    globalEffectBonus: input.globalEffectBonus ?? [],
    skillTypeNames: input.skillTypeNames ?? [],
    warnings,
  };
}

/** 基础用途决定技能进入哪条执行路径。 */
export function executionPath(baseType) {
  switch (baseType) {
    case "attack":
      return "attackRoll";
    case "deteriorate":
      return "attackRollNoDamage";
    case "heal":
      return "healingTrigger";
    case "improve":
      return "support";
    case "summon":
      return "summon";
    case "defend":
      return "reactiveDefense";
    case "initiative":
      return "initiative";
    default:
      throw new Error(`未知基础用途: ${baseType}`);
  }
}

/** 恶化技能无论攻击方式是什么都不造成直接伤害。 */
export function dealsDirectDamage(baseType) {
  return baseType === "attack";
}

/**
 * 治疗技能由治疗触发逻辑插入主行动序列，不能当作普通主动指令直接设置。
 * 文档 §8.2。
 */
export function canBeDirectMainCommand(baseType) {
  return baseType !== "heal";
}
