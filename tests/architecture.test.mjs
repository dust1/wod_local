import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

/** 递归收集目录下的源文件。 */
function collectFiles(dir, extensions = [".mjs", ".js", ".jsx"]) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(full);
  }
  return out;
}

/** 取出所有 import/export ... from "..." 的模块说明符。 */
function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^;]*?from\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^;]*?from\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) specifiers.push(match[1]);
  }
  return specifiers;
}

const LAYER_RULES = [
  {
    layer: "game",
    dir: "game",
    // 领域层不得依赖任何外层实现
    forbidden: [/^react/, /^react-dom/, /node:sqlite/, /^node:http/, /^node:fs/, /^vite/],
    forbiddenPaths: [/^\.\.\/\.\.\/application\//, /^\.\.\/\.\.\/infrastructure\//, /^\.\.\/\.\.\/src\//, /^\.\.\/\.\.\/gamedata\/generated\//],
    allowPaths: [/^\.\.\/\.\.\/gamedata\/overrides\//, /^\.\.\/\.\.\/gamedata\/rules\//],
    note: "game/ 必须与 React、HTTP、SQLite 无关（设计文档 §3、§20.1）",
  },
  {
    layer: "application",
    dir: "application",
    forbidden: [/^react/, /^react-dom/, /node:sqlite/, /^node:http/, /^vite/],
    forbiddenPaths: [/^\.\.\/src\//],
    allowPaths: [],
    note: "application/ 只能依赖领域层与持久化端口，不得直接依赖 UI 或 HTTP",
  },
];

test("依赖方向只能从外层指向内层", () => {
  const violations = [];
  for (const rule of LAYER_RULES) {
    const dir = resolve(repoRoot, rule.dir);
    for (const file of collectFiles(dir)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (rule.forbidden.some((pattern) => pattern.test(specifier))) {
          violations.push(`${relative(repoRoot, file)} → ${specifier}（禁止的模块）`);
        }
        if (rule.forbiddenPaths.some((pattern) => pattern.test(specifier))) {
          violations.push(`${relative(repoRoot, file)} → ${specifier}（反向依赖）`);
        }
      }
    }
    assert.ok(statSync(dir).isDirectory(), `${rule.dir} 必须存在`);
  }
  assert.deepEqual(violations, [], `${violations.join("; ")}\n${LAYER_RULES.map((rule) => rule.note).join("; ")}`);
});

test("公式与引擎层不读取系统时间，保证确定性", () => {
  const violations = [];
  for (const dir of ["game/formulas", "game/engine", "game/policies", "game/modifiers", "game/targeting", "game/commands"]) {
    for (const file of collectFiles(resolve(repoRoot, dir))) {
      const source = readFileSync(file, "utf8");
      if (/\bDate\.now\s*\(/.test(source) || /new Date\s*\(\s*\)/.test(source)) {
        violations.push(relative(repoRoot, file));
      }
    }
  }
  assert.deepEqual(violations, [], `以下文件读取了系统时间，会破坏同种子可复现性: ${violations.join(", ")}`);
});

test("GameData 生成产物不含可执行代码", () => {
  const dir = resolve(repoRoot, "gamedata/generated");
  const files = readdirSync(dir);
  assert.ok(files.includes("manifest.json"));
  for (const file of files) {
    assert.ok(file.endsWith(".json"), `生成目录只允许 JSON：${file}`);
    const text = readFileSync(resolve(dir, file), "utf8");
    assert.equal(/function\s|=>\s*\{|require\(/.test(text), false, `${file} 中疑似包含可执行代码`);
  }
});

test("服务端只在基础设施层出现 SQL", () => {
  const allowed = new Set(["infrastructure/persistence/sqlite-repository.mjs", "infrastructure/persistence/database-contract.mjs"]);
  const violations = [];
  for (const dir of ["game", "application", "src"]) {
    for (const file of collectFiles(resolve(repoRoot, dir))) {
      const source = readFileSync(file, "utf8");
      if (/\bdb\.prepare\(|\bDatabaseSync\b|SELECT\s+\*\s+FROM/i.test(source)) {
        const relativePath = relative(repoRoot, file).replace(/\\/g, "/");
        if (!allowed.has(relativePath)) violations.push(relativePath);
      }
    }
  }
  assert.deepEqual(violations, [], `SQL 只允许出现在基础设施层: ${violations.join(", ")}`);
});

test("runtime source contains no database construction or migration statements", () => {
  const violations = [];
  const files = [
    ...collectFiles(resolve(repoRoot, "game")),
    ...collectFiles(resolve(repoRoot, "application")),
    ...collectFiles(resolve(repoRoot, "infrastructure")),
    ...collectFiles(resolve(repoRoot, "scripts")),
    resolve(repoRoot, "server.mjs"),
  ];
  const forbidden = /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+INDEX|DROP\s+INDEX|PRAGMA\s+user_version\s*=)/i;
  for (const file of files) {
    if (forbidden.test(readFileSync(file, "utf8"))) violations.push(relative(repoRoot, file));
  }
  assert.deepEqual(violations, [], `Database construction statements are forbidden: ${violations.join(", ")}`);
  assert.ok(statSync(resolve(repoRoot, "docs", "database-schema.json")).isFile());
});

test("前端路由页面独立于 App 协调器", () => {
  const app = readFileSync(resolve(repoRoot, "src/App.jsx"), "utf8");
  assert.equal(/function\s+\w*Page\s*\(/.test(app), false, "App.jsx 不应包含页面组件实现");
  const routeFiles = [
    "pages/heroes/HeroesPage.jsx", "pages/heroes/CreateHeroPage.jsx", "pages/attributes/AttributesPage.jsx",
    "pages/skills/SkillsPage.jsx", "pages/equipment/EquipmentPage.jsx", "pages/inventory/HeroInventoryPage.jsx",
    "pages/inventory/TeamInventoryPage.jsx", "pages/settings/SettingsPage.jsx", "pages/dungeon/DungeonPage.jsx",
    "pages/reports/ReportPage.jsx", "pages/reports/BattlesPage.jsx", "pages/reports/ReportImportPage.jsx",
    "pages/market/MarketPage.jsx", "pages/library/SkillLibraryPage.jsx", "pages/rules/RulesPage.jsx",
    "pages/overview/OverviewPage.jsx", "pages/admin/SummonConfigPage.jsx", "pages/admin/SummonActionConfigPage.jsx",
  ];
  for (const file of routeFiles) assert.ok(statSync(resolve(repoRoot, "src", file)).isFile(), `缺少路由页面模块 src/${file}`);
});
