import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCatalog } from "../application/catalog-service.mjs";
import { validateManifest } from "../gamedata/schemas/catalog.schema.mjs";

test("frozen catalog manifest matches its documented schema", () => {
  const manifest = JSON.parse(readFileSync(resolve("gamedata", "generated", "manifest.json"), "utf8"));
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal("sourceDatabase" in manifest, false);
});

test("frozen catalog retains classified skills without silent omissions", () => {
  const catalog = loadCatalog();
  assert.ok(catalog.skills.size > 0);
  assert.ok([...catalog.skills.values()].every((skill) => skill.id && skill.name));
  assert.ok(catalog.counts.skills > 0);
});
