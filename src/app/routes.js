const PLAYER_NAVIGATION_SECTIONS = Object.freeze([
  { label: "新闻", items: [] },
  { label: "英雄", items: ["我的英雄", "属性", "技能", "装备", "角色仓库", "设置", "英雄概况"] },
  { label: "团队", items: ["团队仓库", "地城", "战报"] },
  { label: "酒馆", items: ["记录者小屋", "市场"] },
  { label: "图书馆", items: ["技能资料", "规则诊断"] },
]);

const ADMIN_NAVIGATION_SECTION = Object.freeze({ label: "配置", items: ["召唤物配置", "召唤物行动配置"] });

export function navigationSections(adminMode = false) {
  return adminMode ? [...PLAYER_NAVIGATION_SECTIONS, ADMIN_NAVIGATION_SECTION] : PLAYER_NAVIGATION_SECTIONS;
}

export const PAGE_FOR_NAV_ITEM = Object.freeze({
  我的英雄: "heroes", 属性: "attributes", 技能: "skills", 装备: "equipment", 角色仓库: "heroInventory",
  设置: "settings", 英雄概况: "overview", 团队仓库: "teamInventory", 地城: "dungeon", 战报: "report",
  记录者小屋: "battles", 市场: "market", 技能资料: "library", 规则诊断: "rules",
  召唤物配置: "summonConfig", 召唤物行动配置: "summonActionConfig",
});

export const PAGE_IDS = Object.freeze(new Set(["createHero", ...Object.values(PAGE_FOR_NAV_ITEM)]));
