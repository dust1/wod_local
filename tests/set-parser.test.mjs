import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

function parseSet(pieceCount) {
  const parser = resolve("docs", "script", "parse_sets.py");
  const html = resolve("docs", "sets", "荒古圣体", `${pieceCount}.html`);
  return JSON.parse(execFileSync("python", [parser, html], {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  }));
}

test("套装解析器识别含内联标签的目标效果标题", () => {
  const onePiece = parseSet(1);
  assert.equal(onePiece["作用在装备者上的效果"].length, 1);
  assert.equal(onePiece["作用在被影响的目标上的效果"].length, 1);

  const fivePieces = parseSet(5);
  assert.equal(fivePieces["作用在装备者上的效果"].length, 65);
  assert.equal(fivePieces["作用在被影响的目标上的效果"].length, 14);
});
