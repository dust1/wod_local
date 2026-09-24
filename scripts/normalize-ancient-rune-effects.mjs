// data/ 是本地导入目录；对其中符文效果的类型别名做可重复的格式修正。
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve("data/fuwen");
const replacements = new Map([
  ['"类型": "脆弱性"', '"类型": "对此种攻击方式，攻击类型伤害的脆弱性"'],
  ['"类型": "技能等级奖励"', '"类型": "对技能等级的奖励"'],
  ['"类型": "技能效果奖励"', '"类型": "对技能效果的奖励"'],
]);

let changed = 0;
for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
  const path = resolve(directory, name);
  const source = readFileSync(path, "utf8");
  let updated = source;
  for (const [from, to] of replacements) updated = updated.replaceAll(from, to);
  if (updated === source) continue;
  writeFileSync(path, updated, "utf8");
  changed += 1;
}
console.log(`已规范化 ${changed} 份传古符文效果文件`);
