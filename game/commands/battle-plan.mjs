// 战斗设置方案。设计文档 §17.1、§17.2。
// 默认方案为所有层的回退值，1 至 10 层可以覆盖。
// 若一层内有多场战斗，这些战斗必须使用同一层设置。

export const REPEAT_MODES = Object.freeze(["normal", "oncePerBattle", "repeatWhilePossible"]);
export const WAIT_COMMAND_SKILL_ID = "__wait__";

export const REPEAT_MODE_LABELS = Object.freeze({
  normal: "默认",
  oncePerBattle: "一次性",
  repeatWhilePossible: "尽可能多的重复",
});

export const PLAN_MODES = Object.freeze(["pve", "pvp"]);

export const DEFAULT_GENERAL_SETTINGS = Object.freeze({
  fleeCondition: null,
  healthPotionCondition: null,
  manaPotionCondition: null,
  defaultDefenseSkillId: null,
  defaultSupportSkillId: null,
  rangedPositionPriority: null,
  preRoundOrder: [],
});

export function createCommand(input = {}) {
  const itemIds = Array.isArray(input.itemIds)
    ? [...new Set(input.itemIds.filter((id) => id != null).map(String))]
    : input.itemId == null ? [] : [String(input.itemId)];
  return {
    id: input.id ?? `${input.skillId ?? "command"}`,
    skillId: input.skillId ?? null,
    itemIds,
    // 兼容旧战斗快照；新代码一律以 itemIds 为准。
    itemId: itemIds[0] ?? null,
    calledItems: (input.calledItems ?? []).map((item) => ({ id: String(item.id), name: item.name, setName: item.setName ?? null })),
    itemEffects: (input.itemEffects ?? []).map((effect) => ({ ...effect })),
    setEffects: (input.setEffects ?? []).map((effect) => ({ ...effect })),
    target: {
      mode: input.target?.mode ?? "auto",
      position: input.target?.position ?? null,
      priority: input.target?.priority ?? null,
    },
    repeat: input.repeat ?? "normal",
    multiplier: input.multiplier ?? 1,
    note: input.note ?? "",
  };
}

export function createFloorPlan(input = {}) {
  const initiativeItemIds = Array.isArray(input.initiativeItemIds)
    ? [...new Set(input.initiativeItemIds.filter((id) => id != null).map(String))]
    : input.initiativeItemId == null ? [] : [String(input.initiativeItemId)];
  return {
    position: input.position ?? "front",
    initiativeSkillId: input.initiativeSkillId ?? null,
    initiativeItemIds,
    initiativeItemId: initiativeItemIds[0] ?? null,
    initiativeCalledItems: (input.initiativeCalledItems ?? []).map((item) => ({ id: String(item.id), name: item.name })),
    initiativeItemEffects: (input.initiativeItemEffects ?? []).map((effect) => ({ ...effect })),
    initiativeSetEffects: (input.initiativeSetEffects ?? []).map((effect) => ({ ...effect })),
    preRound: (input.preRound ?? []).map(createCommand),
    mainRound: (input.mainRound ?? []).map(createCommand),
    healing: Object.fromEntries(["light", "wounded", "severe"].map((wound) => [wound, (input.healing?.[wound] ?? []).map(createCommand)])),
  };
}

export function createBattlePlan(input = {}) {
  const floorOverrides = {};
  for (const [floor, plan] of Object.entries(input.floorOverrides ?? {})) {
    const number = Number(floor);
    if (!Number.isInteger(number) || number < 1 || number > 10) {
      throw new Error(`层覆盖只允许 1 至 10 层: ${floor}`);
    }
    floorOverrides[number] = createFloorPlan(plan);
  }
  return {
    id: input.id ?? "plan",
    name: input.name ?? "默认",
    mode: input.mode ?? "pve",
    defaultPlan: createFloorPlan(input.defaultPlan ?? {}),
    floorOverrides,
    general: { ...DEFAULT_GENERAL_SETTINGS, ...(input.general ?? {}) },
  };
}

/** 取得某一层实际使用的设置：层覆盖优先，否则回退到默认方案。 */
export function resolveFloorPlan(battlePlan, floorNumber) {
  const override = battlePlan.floorOverrides?.[floorNumber];
  return {
    plan: override ?? battlePlan.defaultPlan,
    source: override ? "floorOverride" : "default",
  };
}
