import { EQUIP_SLOTS } from "../game/domain/item.mjs";

export const MARKET_ITEM_PRICE = 1;

/** 套装筛选的数据入口；当前运行库尚无套装关系，本次仅定义契约。 */
export function listMarketItemSets(repository) {
  return repository.listItemSets();
}

export function marketDto(repository, filters = {}) {
  const items = repository.listMarketItems(filters).map((item) => ({ ...item, price: MARKET_ITEM_PRICE }));
  return {
    filters: {
      professions: repository.listProfessions(),
      races: repository.listRaces(),
      equipSlots: Object.entries(EQUIP_SLOTS).filter(([id]) => id !== "one_hand").map(([id, name]) => ({ id, name })),
      itemSets: listMarketItemSets(repository),
    },
    total: repository.countMarketItems(filters),
    items,
  };
}

export function purchaseMarketItem(repository, { heroId, userId, itemId }) {
  return repository.buyMarketItem(heroId, userId, itemId, MARKET_ITEM_PRICE);
}
