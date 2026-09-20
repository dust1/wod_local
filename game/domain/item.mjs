// 物品与装备。设计文档 §9。
// 必须保留数据库中的稳定字符串 ID，显示名称不得作为主键。

export const EQUIP_SLOTS = Object.freeze({
  head: "头",
  ear: "耳",
  glasses: "眼镜",
  neck: "颈",
  body: "身体",
  belt: "腰带",
  cloak: "披风",
  shoulder: "肩膀",
  arm: "臂",
  hand: "手",
  two_hands: "双手",
  right_hand: "右手",
  left_hand: "左手",
  leg: "腿",
  foot: "脚",
  medal: "勋章",
  pocket: "口袋",
  ring: "戒指",
});

export const EQUIP_SLOT_ID_BY_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(EQUIP_SLOTS).map(([id, label]) => [label, id])),
);

export const UNIQUENESS_KINDS = Object.freeze(["none", "hero", "team", "alliance"]);

export const UNIQUENESS_LABELS = Object.freeze({
  none: "无",
  hero: "英雄唯一",
  team: "队伍唯一",
  alliance: "联盟唯一",
});

/**
 * 单手物品的派生部位。
 * `item.slot` 使用“单手”表示可装备在右手或左手的物品，而 equip_slot 表只有
 * right_hand / left_hand，因此引入派生部位 `one_hand` 显式表达。
 * 冻结内容资产使用“单手”表示可装备在任意一只空手。
 */
export const ONE_HAND_SLOT_ID = "one_hand";
export const ONE_HAND_SLOT_LABEL = "单手";

export function equipSlotIdForItemSlot(itemSlot) {
  if (!itemSlot || itemSlot === "不可装备") return null;
  if (itemSlot === ONE_HAND_SLOT_LABEL) return ONE_HAND_SLOT_ID;
  return EQUIP_SLOT_ID_BY_LABEL[itemSlot] ?? null;
}

/**
 * 槽位占用冲突。设计文档 §4.4：需要单独实现双手与左右手的占用冲突规则。
 * 同类多槽位的数量上限尚未确认（D 级），因此戒指等同类槽位不设上限。
 */
export const SLOT_CONFLICTS = Object.freeze({
  two_hands: Object.freeze(["right_hand", "left_hand", "two_hands", ONE_HAND_SLOT_ID]),
  right_hand: Object.freeze(["two_hands", "right_hand"]),
  left_hand: Object.freeze(["two_hands", "left_hand"]),
  [ONE_HAND_SLOT_ID]: Object.freeze(["two_hands", ONE_HAND_SLOT_ID]),
});

/**
 * 手部占用：单手物品占用一只空手，双手物品占用两只。
 * @param {string[]} slots 已装备物品的槽位（含派生部位 one_hand）
 */
export function handOccupancy(slots = []) {
  const usesTwoHands = slots.includes("two_hands");
  const oneHandCount = slots.filter((slot) => slot === ONE_HAND_SLOT_ID).length;
  const namedRight = slots.includes("right_hand");
  const namedLeft = slots.includes("left_hand");
  const freeHands = usesTwoHands ? 0 : Math.max(0, 2 - oneHandCount - (namedRight ? 1 : 0) - (namedLeft ? 1 : 0));
  return {
    freeHands,
    usesTwoHands,
    canEquipOneHand: freeHands > 0,
    canEquipTwoHands: slots.length === 0,
  };
}

export const EXPERIMENTAL_MULTI_SLOT_LIMITS = Object.freeze({
  // D 级待验证：当前资料未给出同类多槽位上限，这里显式标注为实验值。
  ring: null,
  pocket: null,
});

/** 判断把 slotId 装备到已有 occupiedSlots 是否冲突。 */
export function slotConflicts(slotId, occupiedSlots = []) {
  const blocked = SLOT_CONFLICTS[slotId];
  if (!blocked) return occupiedSlots.includes(slotId) ? [slotId] : [];
  return occupiedSlots.filter((occupied) => blocked.includes(occupied));
}

/**
 * 耐久度。设计文档 §9.2：心理和毒素伤害不造成装备损坏。
 * 完整免损伤害类型表尚未确认（D 级），用显式实验参数表达。
 */
export const DEFAULT_NO_DURABILITY_DAMAGE_TYPES = Object.freeze(["心理伤害", "毒素伤害"]);

export function canDamageDurability(damageType, noDamageTypes = DEFAULT_NO_DURABILITY_DAMAGE_TYPES) {
  if (!damageType) return true;
  return !noDamageTypes.includes(damageType);
}

/**
 * 「需配合何物使用」的占位值。物品 JSON 在没有配合物品时写 `-`（不是空数组），
 * 全量 48564 份物品里有 44393 份是这种写法，且这是数据里唯一出现过的占位值。
 * 占位值必须与空集合等价：否则会生成一个永远选不到的配合物品下拉框，
 * 让「生活：豪饮」等技能永远无法保存。设计文档 §9.6。
 */
const COMPANION_PLACEHOLDER_PATTERN = /^[-—–－_]+$/;

/** 单个「需配合何物使用」条目是否是"无配合物品"的占位写法。 */
export function isCompanionPlaceholder(value) {
  const name = String(value ?? "").trim();
  return name === "" || COMPANION_PLACEHOLDER_PATTERN.test(name);
}

/**
 * 把物品 JSON 的「需配合何物使用」规范化成配合物品类别名列表。
 * 缺失、非数组、空白、占位值 `-` 都返回空数组。
 * @param {unknown} raw 物品详情 JSON 里的原始值
 * @returns {string[]} 需要逐项追加选择的配合物品类别名
 */
export function companionItemTypeNames(raw) {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return list.map((name) => String(name ?? "").trim()).filter((name) => !isCompanionPlaceholder(name));
}

/**
 * 配套物品需求图。设计文档 §9.6：技能可要求一个主物品，主物品又可要求其他配套物品。
 * 解析为有向需求图，并在构建时检查循环依赖。
 */
export function buildRequirementGraph(items = []) {
  const graph = new Map();
  for (const item of items) {
    graph.set(item.id, item.requiredTogetherCategories ?? item.requires ?? []);
  }
  return graph;
}

/**
 * 检查循环依赖。返回所有环（每个环是节点数组）。
 */
export function findRequirementCycles(items = []) {
  const graph = buildRequirementGraph(items);
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(node) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      cycles.push(stack.slice(start));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (graph.has(next)) visit(next);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) visit(node);
  return cycles;
}

/**
 * 展开一次技能使用中实际参与且允许触发效果的物品链。
 * @param {string} rootItemId
 * @param {Map<string, object>} itemById
 */
export function resolveRequirementChain(rootItemId, itemById) {
  const resolved = [];
  const visited = new Set();
  const queue = [rootItemId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const item = itemById.get(id);
    if (!item) continue;
    resolved.push(item);
    for (const next of item.requires ?? []) queue.push(next);
  }
  return resolved;
}

/**
 * a 与 z 标记必须解析为结构字段，不能保留为自由文本后在战斗中匹配字符串。
 * 文档 §9.7：
 *   a：仅当技能或物品被实际使用时生效（回合前、主回合、先攻或作为防御技能使用）
 *   z：对应伤害类型的伤害追加值；只有本次攻击确实产生该类型伤害时生效
 */
export function parseMarker(rawMarker) {
  const text = String(rawMarker ?? "").trim().toLowerCase();
  if (text === "a") {
    return { kind: "a", appliesOnUseOnly: true, damageType: undefined };
  }
  if (text === "z" || text.startsWith("z")) {
    const match = String(rawMarker).match(/z\s*[（(]?\s*([^）)]+)\s*[）)]?/i);
    return { kind: "z", appliesOnUseOnly: false, damageType: match ? match[1].trim() : undefined };
  }
  return { kind: "unknown", appliesOnUseOnly: false, damageType: undefined, raw: rawMarker };
}

/** 判断一个标记在当前上下文中是否生效。 */
export function markerApplies(marker, context = {}) {
  if (marker.kind === "a") return context.wasUsed === true;
  if (marker.kind === "z") {
    if (!marker.damageType) return context.wasUsed === true;
    return (context.damageTypes ?? []).includes(marker.damageType);
  }
  return false;
}

/**
 * 使用次数。设计文档 §9.3。
 * 每战斗只能使用一次的耗材不能用于多倍消耗技能。
 */
export function canUseItem(item, { usedThisBattle = 0, usedThisDungeon = 0, multiplier = 1 } = {}) {
  if (item.totalCharges !== undefined && item.remainingCharges !== undefined && item.remainingCharges <= 0) {
    return { allowed: false, reason: "noCharges" };
  }
  if (item.usesPerBattle !== undefined && usedThisBattle >= item.usesPerBattle) {
    return { allowed: false, reason: "usesPerBattleExhausted" };
  }
  if (item.usesPerDungeon !== undefined && usedThisDungeon >= item.usesPerDungeon) {
    return { allowed: false, reason: "usesPerDungeonExhausted" };
  }
  if (item.usesPerBattle === 1 && multiplier > 1) {
    return { allowed: false, reason: "oncePerBattleCannotBeMultiplied" };
  }
  return { allowed: true };
}

/**
 * 唯一性。设计文档 §9.4：
 * “已掉落唯一记录”和“当前持有记录”必须分离。
 */
export function createUniquenessLedger() {
  const droppedEver = new Set();
  const held = new Map();
  return {
    /** 记录一次掉落（历史事实，不可回滚）。 */
    markDropped(key) {
      droppedEver.add(key);
    },
    hasDropped(key) {
      return droppedEver.has(key);
    },
    hold(ownerId, key) {
      if (!held.has(ownerId)) held.set(ownerId, new Set());
      held.get(ownerId).add(key);
    },
    holds(ownerId, key) {
      return held.get(ownerId)?.has(key) ?? false;
    },
    release(ownerId, key) {
      held.get(ownerId)?.delete(key);
    },
    snapshot() {
      return {
        droppedEver: [...droppedEver],
        held: Object.fromEntries([...held].map(([owner, set]) => [owner, [...set]])),
      };
    },
  };
}

/**
 * 队伍唯一装备若被摧毁，教材称该队无法再次获得其正常掉落。
 * 因此掉落判定只看 droppedEver，不看当前持有。
 */
export function blocksTeamUniqueDrop(ledger, teamKey) {
  return ledger.hasDropped(teamKey);
}
