import test from "node:test";
import assert from "node:assert/strict";

import { navigationSections, PAGE_FOR_NAV_ITEM } from "../src/app/routes.js";

test("普通启动不显示配置导航", () => {
  assert.equal(navigationSections().some((section) => section.label === "配置"), false);
});

test("管理员启动显示召唤物配置入口", () => {
  const section = navigationSections(true).find((entry) => entry.label === "配置");
  assert.deepEqual(section?.items, ["召唤物配置", "召唤物行动配置"]);
  assert.equal(PAGE_FOR_NAV_ITEM.召唤物配置, "summonConfig");
  assert.equal(PAGE_FOR_NAV_ITEM.召唤物行动配置, "summonActionConfig");
});
