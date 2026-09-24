import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ANCIENT_RUNE_ITEMS } from "../gamedata/overrides/ancient-rune-combinations.mjs";
import { ancientRelicCapacity, matchingAncientRuneCombination } from "../game/domain/ancient-rune.mjs";

export function socketAncientRunes(repository, root, heroId, userId, relicInstanceId, runeInstanceIds) {
  const relic = repository.listHeroInventory(heroId, userId)?.find((row) => Number(row.item_instance_id) === Number(relicInstanceId));
  if (!relic) throw new Error("遗物不在当前角色仓库");
  const metadata = repository.getItemDetailMetadata(relic.item_id);
  if (!metadata?.json_path) throw new Error("遗物详情不可用");
  const rootPath = resolve(root);
  const path = resolve(rootPath, metadata.json_path);
  const fromRoot = relative(rootPath, path);
  if (fromRoot.startsWith("..") || fromRoot.includes(":")) throw new Error("遗物详情路径无效");
  const detail = JSON.parse(readFileSync(path, "utf8"));
  const { polarities, capacity } = ancientRelicCapacity(detail);
  if (!polarities.length || capacity < 1) throw new Error("物品不是可镶嵌的传古遗物");
  const result = repository.socketAncientRunes(heroId, userId, relicInstanceId, runeInstanceIds,
    Object.values(ANCIENT_RUNE_ITEMS), capacity);
  return { socketedRuneItemIds: result, combination: matchingAncientRuneCombination(detail, result) };
}
