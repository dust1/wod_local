import { ANCIENT_RUNE_COMBINATIONS, ANCIENT_RUNE_ITEMS } from "../../gamedata/overrides/ancient-rune-combinations.mjs";

const runeIds = new Set(Object.values(ANCIENT_RUNE_ITEMS));

export function ancientRelicCapacity(detail) {
  const types = Array.isArray(detail?.["物品类别"]) ? detail["物品类别"] : [];
  const polarities = ["阴性", "中性", "阳性"].filter((value) => types.includes(`传古遗物(${value})`));
  const match = String(detail?.["详细属性"]?.["特性"] ?? "").match(/可以镶嵌\s*(\d+)\s*次/);
  return { polarities, capacity: match ? Number(match[1]) : 0 };
}

export function matchingAncientRuneCombination(detail, itemIds) {
  const { polarities, capacity } = ancientRelicCapacity(detail);
  if (!polarities.length || !Array.isArray(itemIds) || itemIds.length !== capacity || !itemIds.every((id) => runeIds.has(Number(id)))) return null;
  const signature = itemIds.map(Number).sort((a, b) => a - b).join(",");
  for (const recipe of ANCIENT_RUNE_COMBINATIONS) {
    if (!polarities.includes(recipe.polarity)) continue;
    for (const [size, variant] of Object.entries(recipe.variants)) {
      if (Number(size) !== capacity) continue;
      if (variant.runeItemIds.slice().sort((a, b) => a - b).join(",") === signature)
        return { name: recipe.name, polarity: recipe.polarity, ...variant };
    }
  }
  return null;
}

export function isAncientRuneItemId(itemId) { return runeIds.has(Number(itemId)); }
