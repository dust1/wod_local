// 战报导入测试：HTML 扫描器、导入器、黄金片段与真实战报计数。
// 设计文档 §2.3、§11.1、§11.5、§18、§19、§23.5。
//
// 真实战报是只读来源：本测试只读 docs/wodlog/4907363/*.html，绝不写入。

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classList,
  countClassNodes,
  countClassNodesMulti,
  decodeEntities,
  elementEnd,
  findElementsByClass,
  isHiddenTag,
  parseAttributes,
  scanTokens,
  splitTopLevelRegions,
  textContent,
} from "../game/replay/html-scan.mjs";
import {
  HIT_GRADE_ID_BY_TEXT,
  extractTooltipString,
  hashReportText,
  importBattleReport,
  importBattleReportFile,
  parseTooltip,
  syntheticUnitId,
} from "../game/replay/import-report.mjs";
import { BATTLE_EVENT_TYPE_SET } from "../game/events/types.mjs";
import { POSITION_LABELS } from "../game/domain/positions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixtureDir = path.join(here, "fixtures", "report");
const reportDir = path.join(repoRoot, "docs", "wodlog", "4907363");
const level1Path = path.join(reportDir, "level1.html");
const level2Path = path.join(reportDir, "level2.html");

/** 设计文档 §2.3 的原始节点计数表。 */
const DESIGN_DOC_COUNTS = {
  "level1.html": { rep_round_headline: 6, rep_status_table: 14, rep_action: 2074, rep_initiative: 2130, rep_mana_cost: 170, rep_gain: 74, rep_loss: 7 },
  "level2.html": { rep_round_headline: 2, rep_status_table: 6, rep_action: 1710, rep_initiative: 1732, rep_mana_cost: 1134, rep_gain: 29, rep_loss: 58 },
};

function fixture(name) {
  return readFile(path.join(fixtureDir, name), "utf8");
}

function eventsOf(report, type) {
  return report.events.filter((ev) => ev.type === type);
}

function phaseOffset(list) {
  return list.map((entry) => entry.offset);
}

// ---------------------------------------------------------------------------
// html-scan：索引扫描器
// ---------------------------------------------------------------------------

describe("html-scan 索引扫描器", () => {
  it("解码命名实体、十进制与十六进制实体，未知实体原样保留", () => {
    assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&apos;"), "&<>\"'");
    assert.equal(decodeEntities("&#65;&#x42;"), "AB");
    assert.equal(decodeEntities("&nbsp;"), "\u00a0");
    assert.equal(decodeEntities("&notarealentity;"), "&notarealentity;");
    assert.equal(decodeEntities("没有任何实体"), "没有任何实体");
  });

  it("解析属性时跳过引号内的 >，并解码属性值里的实体", () => {
    const tag = `<a href="#" onmouseover="wodToolTip(this,'属于<b>洛德莉丝</b>.')" class="rep_hero rep_group" x="207131" disabled>`;
    const { name, attrs } = parseAttributes(tag);
    assert.equal(name, "a");
    assert.equal(attrs.class, "rep_hero rep_group");
    assert.equal(attrs.x, "207131");
    assert.equal(attrs.disabled, "");
    assert.equal(attrs.onmouseover, "wodToolTip(this,'属于<b>洛德莉丝</b>.')");
    assert.deepEqual(classList(tag), ["rep_hero", "rep_group"]);
  });

  it("elementEnd 处理嵌套同名标签、void 元素与 script 原文", () => {
    const html = `<div id="a"><div>内层</div><br><img src="x"><script>if (a < b) { x = "<div>"; }</script></div><p>之后</p>`;
    const start = html.indexOf("<div");
    const end = elementEnd(html, start);
    assert.equal(html.slice(end), "<p>之后</p>");
    assert.match(html.slice(start, end), /内层/);
    const imgStart = html.indexOf("<img");
    assert.equal(elementEnd(html, imgStart), imgStart + "<img src=\"x\">".length);
  });

  it("未闭合元素返回给定上界而不是抛错", () => {
    const html = `<table><tr><td>没有闭合`;
    assert.equal(elementEnd(html, 0, html.length), html.length);
  });

  it("textContent 不会把属性里的标签当成正文（tooltip 回归）", () => {
    const html = `<tr><td colspan="2"><span onmouseover="wodToolTip(this,'属于<b>玩wod玩的</b>.')"><a href="#">与提灯女士的约定</a></span> : <a href="#">玩wod玩的</a> 恢复100HP，恢复100法力.</td></tr>`;
    const text = textContent(html);
    assert.equal(text, "与提灯女士的约定 : 玩wod玩的 恢复100HP，恢复100法力.");
    assert.ok(!text.includes(".')\">"), "属性内容不得泄漏为正文");
    assert.ok(!text.includes("<b>"));
  });

  it("countClassNodes 只统计双引号 class 属性，tooltip 内的单引号 class 不计入", () => {
    const html = `<td class="rep_initiative">先攻1<br><span class="rep_action">第1步行动 / 共1步</span></td>
      <a onmouseover="wodToolTip(this,'灵巧 <span class=\\'rep_bonus bonus_positive\\'>+50<span class=\\'rep_decimal\\'>.50</span></span>')">技能</a>`;
    const counts = countClassNodesMulti(html, ["rep_initiative", "rep_action", "rep_decimal", "rep_bonus"]);
    assert.deepEqual({ ...counts }, { rep_initiative: 1, rep_action: 1, rep_decimal: 0, rep_bonus: 0 });
    assert.equal(countClassNodes(html, "rep_initiative"), 1);
  });

  it("isHiddenTag 识别 display:none 与 hidden 属性", () => {
    assert.equal(isHiddenTag(`<tr style="display: none;">`), true);
    assert.equal(isHiddenTag(`<tr style="display:none">`), true);
    assert.equal(isHiddenTag(`<tr hidden>`), true);
    assert.equal(isHiddenTag(`<tr style="display: block;">`), false);
  });

  it("splitTopLevelRegions 穿透 html/head/body 返回真正的内容块", () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>一</p><table class="content_table"><tr><td>二</td></tr></table></body></html>`;
    const regions = splitTopLevelRegions(html);
    const elements = regions.filter((region) => region.kind === "element");
    assert.deepEqual(elements.map((region) => region.name), ["meta", "p", "table"]);
    assert.deepEqual(elements[2].classes, ["content_table"]);
  });

  it("findElementsByClass 返回正确的元素跨度", () => {
    const html = `<div><p class="rep_round_headline">回合 1</p><p class="rep_round_headline">回合 2</p></div>`;
    const spans = findElementsByClass(html, "rep_round_headline");
    assert.equal(spans.length, 2);
    assert.equal(textContent(html.slice(spans[0].start, spans[0].end)), "回合 1");
    assert.equal(textContent(html.slice(spans[1].start, spans[1].end)), "回合 2");
  });

  it("扫描大文档不会退化（2 万行合成表格）", () => {
    const rows = [];
    for (let index = 0; index < 20000; index += 1) {
      rows.push(`<tr id="activeRow_1_1_0_${index}"><td class="rep_initiative">先攻${index}<br><span class="rep_action">第1步行动 / 共1步</span></td><td><a href="#" onclick="return jump('h',${100000 + index})" class="rep_hero">单位${index}</a> 无聊的打量四周，等待着。</td></tr>`);
    }
    const html = `<html><body><table><tbody>${rows.join("")}</tbody></table></body></html>`;
    const started = Date.now();
    const counts = countClassNodesMulti(html, ["rep_initiative", "rep_action"]);
    const tokens = [...scanTokens(html)].length;
    const elapsed = Date.now() - started;
    assert.equal(counts.rep_initiative, 20000);
    assert.equal(counts.rep_action, 20000);
    assert.ok(tokens > 60000, `token 数偏少: ${tokens}`);
    assert.ok(elapsed < 15000, `扫描耗时过长: ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// tooltip 修正解析
// ---------------------------------------------------------------------------

describe("tooltip 修正解析", () => {
  const raw = "灵巧 <span class='rep_bonus bonus_positive'>+50<span class='rep_decimal'>.50</span></span> <span class='rep_bonus bonus_positive'>+50%</span><br />智力 <span class='rep_bonus bonus_negative'>-50%</span><br />伤害 心灵伤害 <span class='rep_bonus bonus_positive'>+85<span class='rep_decimal'>.50</span></span> <span class='rep_bonus bonus_positive'>+25%</span>/<span class='rep_bonus bonus_positive'>+86<span class='rep_decimal'>.00</span></span> <span class='rep_bonus bonus_positive'>+25%</span><br />技能 专精 <span class='rep_bonus bonus_positive'>+439<span class='rep_decimal'>.00</span></span>";

  it("从属性字符串中取出原始 tooltip 文本并反转义", () => {
    const tag = `<a onmouseover="wodToolTip(this,'灵巧 <span class=\\'rep_bonus\\'>+50</span>')">技能</a>`;
    assert.equal(extractTooltipString(tag), "灵巧 <span class='rep_bonus'>+50</span>");
    assert.equal(extractTooltipString("<a>无 tooltip</a>"), null);
  });

  it("解析出属性/伤害/技能的固定值与百分比", () => {
    const parsed = parseTooltip(raw);
    assert.equal(parsed.raw, raw);
    assert.equal(parsed.modifiers.length, 4);
    const [dexterity, intelligence, damage, skill] = parsed.modifiers;
    assert.deepEqual({ label: dexterity.label, category: dexterity.category, flat: dexterity.flat, percent: dexterity.percent }, { label: "灵巧", category: "attribute", flat: 50.5, percent: 50 });
    assert.deepEqual({ label: intelligence.label, category: intelligence.category, flat: intelligence.flat, percent: intelligence.percent }, { label: "智力", category: "attribute", flat: null, percent: -50 });
    assert.equal(damage.category, "damage");
    assert.equal(damage.name, "心灵伤害");
    assert.deepEqual(damage.values, [{ flat: 85.5, percent: 25 }, { flat: 86, percent: 25 }]);
    assert.equal(skill.category, "skill");
    assert.equal(skill.name, "专精");
    assert.equal(skill.flat, 439);
  });

  it("按 <b>来源:</b> 分组为效果快照", () => {
    const parsed = parseTooltip("<b>爱憎的堕神之咒:</b><br />防御 诅咒 <span class='rep_bonus bonus_positive'>+202<span class='rep_decimal'>.00</span></span><br /><br /><b>专精：卓越师范:</b><br />技能 专精 <span class='rep_bonus bonus_positive'>+439<span class='rep_decimal'>.00</span></span>");
    assert.deepEqual(parsed.effects.map((effect) => effect.name), ["爱憎的堕神之咒", "专精：卓越师范"]);
    assert.equal(parsed.effects[0].modifiers.length, 1);
    assert.equal(parsed.effects[0].modifiers[0].flat, 202);
    assert.equal(parsed.effects[1].modifiers[0].name, "专精");
  });

  it("命中等级文本映射到稳定 ID", () => {
    assert.equal(HIT_GRADE_ID_BY_TEXT["闪避"], "miss");
    assert.equal(HIT_GRADE_ID_BY_TEXT["普通"], "hit");
    assert.equal(HIT_GRADE_ID_BY_TEXT["命中"], "hit");
    assert.equal(HIT_GRADE_ID_BY_TEXT["致命一击"], "critical");
  });
});

// ---------------------------------------------------------------------------
// fixture 导入
// ---------------------------------------------------------------------------

describe("fixture 导入：回合结构", () => {
  it("level1-round1.html 解析回合、状态表、回合前、恢复、先攻与主行动", async () => {
    const report = importBattleReport(await fixture("level1-round1.html"), { sourceFile: "level1-round1.html" });
    assert.equal(report.levelNumber, 1);
    assert.equal(report.dungeonName, "巨兽讨伐战-乌龟巨兽巴沙兰");
    assert.equal(report.generatedAt, "2026年8月28日 20:18");
    assert.equal(report.rounds.length, 1);
    const round = report.rounds[0];
    assert.equal(round.round, 1);
    assert.deepEqual(round.statusBlocks.map((block) => block.side), ["attacker", "defender"]);
    const attacker = round.statusBlocks[0].units;
    assert.equal(attacker.length, 13);
    assert.deepEqual(attacker.map((unit) => unit.name).slice(0, 3), ["多萝粞", "就是要哥布林硬！", "洛德莉丝"]);
    const first = attacker[0];
    assert.equal(first.unitId, "h215910");
    assert.equal(first.level, 40);
    assert.equal(first.position, "front");
    assert.equal(first.positionLabel, POSITION_LABELS.front);
    assert.equal(first.health, 197);
    assert.equal(first.resource, 299);
    assert.equal(first.resourceLabel, "法力");
    assert.equal(first.status, "毫发无伤");
    assert.equal(first.statusId, "none");
    assert.equal(first.kind, "ally");
    const observer = attacker[attacker.length - 1];
    assert.equal(observer.name, "戰報抄寫手");
    assert.equal(observer.level, null);
    assert.equal(observer.status, "观察者(导师)");
    assert.equal(round.statusBlocks[1].units[0].kind, "monster");
    assert.equal(round.statusBlocks[1].units[0].name, "出发倒计时");

    // 回合前技能：技能名、法力消耗、目标
    assert.equal(round.preRound.length, 3);
    assert.deepEqual(round.preRound.map((row) => row.skillName), ["支配指令：强攻之章", "专精：卓越师范", "传承：凡世的理想乡"]);
    assert.equal(round.preRound[0].actorName, "洛德莉丝");
    assert.equal(round.preRound[0].manaCost, 54);
    assert.deepEqual(round.preRound[0].targets.map((target) => target.name), ["多萝粞", "就是要哥布林硬！"]);
    assert.equal(round.preRound[1].targets.length, 11);
    assert.ok(round.preRound[0].skillModifiers.length > 0, "回合前技能应带出修正列表");

    // 自然回复：正负回复与资源类型
    assert.equal(round.regeneration.length, 3);
    assert.deepEqual(
      round.regeneration.map((row) => ({ actor: row.actorName, deltas: row.deltas.map((delta) => `${delta.kind}:${delta.amount}:${delta.resourceLabel}`) })),
      [
        { actor: "多萝粞", deltas: ["loss:32:法力"] },
        { actor: "就是要哥布林硬！", deltas: ["gain:15:法力"] },
        { actor: "出发倒计时", deltas: ["loss:1:HP"] },
      ],
    );

    // 先攻技能：先攻值 + 法力消耗
    assert.deepEqual(round.initiativeSkills.map((row) => [row.actorName, row.skillName, row.manaCost, row.initiative]), [
      ["多萝粞", "行动：敏锐目光", 8, 1134],
      ["就是要哥布林硬！", "行动：灵敏", 5, 2135],
      ["洛德莉丝", "天赋：支配之心", 10, 1316],
    ]);

    // 主行动：第 n 步行动 / 共 m 步
    assert.equal(round.scheduledActions.length, 5);
    assert.deepEqual(round.scheduledActions[0], {
      actorId: "h207131",
      actorName: "就是要哥布林硬！",
      initiative: 2135,
      ordinal: 1,
      totalActions: 24,
      rowId: "activeRow_1_1_0_12",
      offset: round.scheduledActions[0].offset,
      manaCost: null,
      skillName: null,
      text: "先攻2135 第1步行动 / 共24步 就是要哥布林硬！ 无聊的打量四周，等待着。",
    });
    assert.equal(round.scheduledActions[1].ordinal, 2);
    assert.equal(round.scheduledActions[1].totalActions, 24);
    const manaAction = round.scheduledActions.find((row) => row.manaCost !== null);
    assert.equal(manaAction.actorName, "多萝粞");
    assert.equal(manaAction.skillName, "战歌：勇气之歌");
    assert.equal(manaAction.manaCost, 6);
    assert.equal(manaAction.initiative, 1134);
    assert.equal(round.manaCosts.length, 6);

    // 阶段顺序：回合前 < 自然回复 < 先攻技能 < 主行动
    const maxPre = Math.max(...phaseOffset(round.preRound));
    const minRegen = Math.min(...phaseOffset(round.regeneration));
    const minInit = Math.min(...phaseOffset(round.initiativeSkills));
    const minMain = Math.min(...phaseOffset(round.scheduledActions));
    assert.ok(maxPre < minRegen, "回合前必须早于自然回复");
    assert.ok(minRegen < minInit, "自然回复必须早于先攻技能");
    assert.ok(minInit < minMain, "先攻技能必须早于主行动");

    // 事件顺序与类型
    assert.deepEqual(
      report.events.filter((ev) => ["RoundStarted", "StatusSnapshot", "SkillAttempted", "ResourceChanged", "InitiativeRolled", "ActionScheduled", "SummonCreated"].includes(ev.type)).slice(0, 3).map((ev) => ev.type),
      ["RoundStarted", "StatusSnapshot", "StatusSnapshot"],
    );
    for (const ev of report.events) {
      assert.ok(BATTLE_EVENT_TYPE_SET.has(ev.type), `未知事件类型: ${ev.type}`);
    }
    const summon = eventsOf(report, "SummonCreated")[0];
    assert.deepEqual({ actorName: summon.actorName, summonName: summon.summonName, skillName: summon.skillName, phase: summon.phase, round: summon.round }, {
      actorName: "玩wod玩的",
      summonName: "与提灯女士的约定",
      skillName: "传承：熙拉夏的约定",
      phase: "MainActionsExecuted",
      round: 1,
    });
    assert.ok(report.parseWarnings.every((warning) => warning.code === "PRE_BATTLE_REGION_IGNORED"));
    assert.equal(report.unparsedFragments.length, 0);
  });

  it("level2-damage.html 解析伤害条目、命中等级与技能体力消耗", async () => {
    const report = importBattleReport(await fixture("level2-damage.html"), { sourceFile: "level2-damage.html" });
    const round = report.rounds[0];
    assert.equal(round.scheduledActions.length, 4);
    const multi = round.actions.find((row) => row.damage.length > 1);
    assert.equal(multi.actorName, "多萝粞");
    assert.equal(multi.skillName, "战技：九天之歌");
    assert.equal(multi.manaCost, 6241);
    assert.deepEqual(multi.targets.map((target) => target.name), ["乌龟巨兽巴沙兰"]);
    assert.deepEqual(multi.damage.slice(0, 3), [
      { amount: 0, absorbed: 4103, damageType: "神圣伤害" },
      { amount: 0, absorbed: 11071, damageType: "心灵伤害" },
      { amount: 0, absorbed: 72, damageType: "恶魔伤害" },
    ]);
    assert.deepEqual(multi.hitGrades.map((grade) => [grade.grade, grade.gradeId]), [["致命一击", "critical"]]);

    const miss = round.actions.find((row) => row.hitGrades.some((grade) => grade.gradeId === "miss"));
    assert.equal(miss.actorName, "阿萝维纳斯");

    // 技能自带的 HP 消耗（rep_loss 在行动行内部）
    const hpCost = round.actions.find((row) => row.deltas.length > 0);
    assert.equal(hpCost.actorName, "Anton");
    assert.deepEqual(hpCost.deltas.map((delta) => [delta.kind, delta.amount, delta.resourceLabel]), [["loss", 208, "HP"]]);
    assert.ok(report.events.some((ev) => ev.type === "ResourceSpent" && ev.resourceLabel === "HP" && ev.amount === 208));

    // 多节点恢复行（同一行既有 HP 流失又有法力流失）
    const multiRegen = round.regeneration.find((row) => row.deltas.filter((delta) => delta.kind === "loss").length === 2);
    assert.equal(multiRegen.actorName, "阿萝维纳斯");
    assert.deepEqual(multiRegen.deltas.map((delta) => [delta.kind, delta.amount, delta.resourceLabel]), [["loss", 77886, "HP"], ["loss", 78067, "法力"]]);
    assert.equal(round.statusBlocks[1].units[0].name, "乌龟巨兽巴沙兰");
    assert.equal(round.statusBlocks[1].units[0].kind, "monster");
  });

  it("level1-room-end.html 解析击倒、战斗结束、层完成与奖励", async () => {
    const report = importBattleReport(await fixture("level1-room-end.html"), { sourceFile: "level1-room-end.html" });
    assert.equal(report.levelNumber, 1, "层号必须取可见文本而不是 <a name> 属性");
    assert.equal(report.roomEnds.length, 1);
    assert.equal(report.roomEnds[0].text, "进攻者胜利了！");
    assert.equal(report.levelSuccess.text, "准备完成，可以出发了。");
    const defeated = report.rounds[0].statusBlocks[1].units[0];
    assert.equal(defeated.status, "击倒");
    assert.equal(defeated.statusId, "statusMessage");
    assert.equal(defeated.health, 0);
    assert.equal(eventsOf(report, "UnitDefeated").length, 1);
    assert.deepEqual({ ...eventsOf(report, "BattleEnded")[0] }, { seq: 6, type: "BattleEnded", result: "attackerVictory", resultLabel: "进攻者胜利了！", round: 6, phase: "RoundEnded" });
    assert.equal(eventsOf(report, "LevelEnded")[0].level, 1);
    assert.equal(report.rewards.length, 2);
    assert.deepEqual(report.rewards[0].entries, [
      { label: "经验点", value: 108 },
      { label: "荣誉", value: 41 },
      { label: "金币", value: 216 },
    ]);
  });
});

describe("fixture 导入：召唤物生命周期", () => {
  it("level1-round2-summon.html 识别主回合召唤物在下一回合的状态与行动", async () => {
    const report = importBattleReport(await fixture("level1-round2-summon.html"), { sourceFile: "level1-round2-summon.html" });
    const round = report.rounds[0];
    const summon = round.statusBlocks[0].units.find((unit) => unit.kind === "summon");
    assert.ok(summon, "状态表应含召唤物");
    assert.equal(summon.name, "假面人偶舞会");
    assert.equal(summon.ownerName, "洛德莉丝");
    assert.equal(summon.unitId, syntheticUnitId("假面人偶舞会"), "没有数字 ID 时必须使用确定性合成 ID");
    assert.equal(summon.level, 60);
    assert.equal(summon.position, "center");

    const summonAction = round.scheduledActions[0];
    assert.equal(summonAction.actorId, syntheticUnitId("假面人偶舞会"));
    assert.equal(summonAction.initiative, 50275);
    assert.deepEqual([summonAction.ordinal, summonAction.totalActions], [1, 1]);

    const regen = round.regeneration[0];
    assert.equal(regen.actorName, "与提灯女士的约定");
    assert.deepEqual(regen.deltas.map((delta) => [delta.kind, delta.amount, delta.resourceLabel]), [["gain", 100, "HP"], ["gain", 100, "法力"]]);
    assert.equal(report.counts.semantic.summonUnits, 1);
  });

  it("level2-pre-round-summon.html 回合前召唤物参与当前回合", async () => {
    const report = importBattleReport(await fixture("level2-pre-round-summon.html"), { sourceFile: "level2-pre-round-summon.html" });
    const round = report.rounds[0];
    const summon = eventsOf(report, "SummonCreated")[0];
    assert.deepEqual({ round: summon.round, phase: summon.phase, actorName: summon.actorName, summonName: summon.summonName, skillName: summon.skillName }, {
      round: 1,
      phase: "PreRoundCommandsExecuted",
      actorName: "莉雅·月之呢喃",
      summonName: "断剑重铸的奇迹",
      skillName: "圣印：代行神迹",
    });
    assert.equal(summon.summonId, syntheticUnitId("断剑重铸的奇迹"));
    // 同一回合的主行动把召唤物当作目标
    const targetIds = round.actions.flatMap((row) => row.targets.map((target) => target.unitId));
    assert.ok(targetIds.includes(summon.summonId), "回合前召唤物应参与当前回合");
    assert.ok(report.events.some((ev) => ev.type === "TargetSelected" && ev.targetId === summon.summonId));
  });
});

describe("fixture 导入：隐藏与重复节点", () => {
  it("hidden-duplicates.html 的原始计数大于语义计数", async () => {
    const report = importBattleReport(await fixture("hidden-duplicates.html"), { sourceFile: "hidden-duplicates.html" });
    assert.equal(report.counts.raw.rep_initiative, 2, "隐藏重复行仍计入原始计数");
    assert.equal(report.counts.raw.rep_action, 2);
    assert.equal(report.counts.semantic.initiativeRows, 1, "语义解析必须排除隐藏行");
    assert.equal(report.counts.semantic.scheduledActionRows, 1);
    assert.equal(report.counts.semantic.hiddenNodesSkipped, 1);
    assert.equal(report.counts.raw.rep_hero, 2);
    // 两个可见单位锚点：状态表中的多萝粞 + 可见行动行里的就是要哥布林硬！
    // 隐藏的重复行动行被语义解析排除，因此语义计数小于原始计数。
    assert.equal(report.counts.semantic.unitAnchors, 2);
    assert.ok(report.counts.semantic.unitAnchors < report.counts.raw.rep_hero + 1);
    assert.ok(report.counts.preBattleRegion.hiddenNodes >= 2);
  });
});

// ---------------------------------------------------------------------------
// 黄金测试：真实战报
// ---------------------------------------------------------------------------

const level1Start = Date.now();
const level1 = await importBattleReportFile(level1Path);
const level1ImportMs = Date.now() - level1Start;
const level2Start = Date.now();
const level2 = await importBattleReportFile(level2Path);
const level2ImportMs = Date.now() - level2Start;
const FULL_REPORTS = [
  ["level1.html", level1],
  ["level2.html", level2],
];

describe("黄金测试：原始节点计数与设计文档 §2.3 一致", () => {
  for (const [name, report] of FULL_REPORTS) {
    it(`${name} 的原始 class 节点计数与文档表格完全一致`, () => {
      for (const [className, expected] of Object.entries(DESIGN_DOC_COUNTS[name])) {
        assert.equal(report.counts.raw[className], expected, `${name} ${className} 原始计数不一致`);
      }
    });
  }

  it("语义解析覆盖战斗区域内的全部原始节点（7 类）", () => {
    assert.deepEqual(
      {
        rounds: level1.counts.semantic.rounds,
        statusBlocks: level1.counts.semantic.statusBlocks,
        initiativeRows: level1.counts.semantic.initiativeRows,
        scheduledActionRows: level1.counts.semantic.scheduledActionRows,
        manaCostNodes: level1.counts.semantic.manaCostNodes,
        gainNodes: level1.counts.semantic.gainNodes,
        lossNodes: level1.counts.semantic.lossNodes,
      },
      {
        rounds: 6,
        statusBlocks: 14,
        initiativeRows: 2130,
        scheduledActionRows: 2074,
        manaCostNodes: 170,
        gainNodes: 74,
        lossNodes: 7,
      },
    );
    assert.deepEqual(
      {
        rounds: level2.counts.semantic.rounds,
        statusBlocks: level2.counts.semantic.statusBlocks,
        initiativeRows: level2.counts.semantic.initiativeRows,
        scheduledActionRows: level2.counts.semantic.scheduledActionRows,
        manaCostNodes: level2.counts.semantic.manaCostNodes,
        gainNodes: level2.counts.semantic.gainNodes,
        lossNodes: level2.counts.semantic.lossNodes,
      },
      {
        rounds: 2,
        statusBlocks: 6,
        initiativeRows: 1732,
        scheduledActionRows: 1710,
        manaCostNodes: 1134,
        gainNodes: 29,
        lossNodes: 58,
      },
    );
    // 行动节点与先攻节点一一对应，行动节点里的 rep_action 数量与原始计数一致。
    assert.equal(level1.counts.semantic.initiativeActionNodes, level1.counts.raw.rep_action);
    assert.equal(level2.counts.semantic.initiativeActionNodes, level2.counts.raw.rep_action);
  });

  it("战斗前区域被排除但可追溯：单位锚点守恒", () => {
    for (const [name, report] of FULL_REPORTS) {
      const excluded = report.counts.excludedBeforeFirstRound;
      const excludedUnitAnchors = excluded.rep_hero + excluded.rep_myhero + excluded.rep_myotherheros + excluded.rep_monster;
      const rawUnitAnchors = report.counts.raw.rep_hero + report.counts.raw.rep_myhero + report.counts.raw.rep_myotherheros + report.counts.raw.rep_monster;
      assert.ok(excludedUnitAnchors > 0, `${name} 战斗前区域应含单位锚点`);
      assert.equal(report.counts.semantic.unitAnchors + excludedUnitAnchors, rawUnitAnchors, `${name} 单位锚点不守恒`);
      // 设计文档统计的 7 类节点全部位于战斗区域，因此这些类别的 raw 与 semantic 相等。
      for (const className of Object.keys(DESIGN_DOC_COUNTS[name])) {
        if (className === "rep_round_headline" || className === "rep_status_table") continue;
        assert.equal(excluded[className], 0, `${name} ${className} 不应出现在战斗前区域`);
      }
      assert.equal(report.counts.semantic.hiddenNodesSkipped, 0, `${name} 战斗区域不应含隐藏节点`);
      assert.equal(report.counts.preBattleRegion.hiddenNodes > 0, true);
    }
  });
});

describe("黄金测试：阶段顺序与先攻", () => {
  it("每个回合都满足 回合前 → 自然回复 → 先攻技能 → 主行动", () => {
    for (const [name, report] of FULL_REPORTS) {
      for (const round of report.rounds) {
        const label = `${name} 回合 ${round.round}`;
        const maxPre = phaseOffset(round.preRound).length ? Math.max(...phaseOffset(round.preRound)) : null;
        const minRegen = phaseOffset(round.regeneration).length ? Math.min(...phaseOffset(round.regeneration)) : null;
        const minInit = phaseOffset(round.initiativeSkills).length ? Math.min(...phaseOffset(round.initiativeSkills)) : null;
        const minMain = phaseOffset(round.scheduledActions).length ? Math.min(...phaseOffset(round.scheduledActions)) : null;
        if (maxPre !== null && minRegen !== null) assert.ok(maxPre < minRegen, `${label}: 回合前必须在恢复之前`);
        if (minRegen !== null && minInit !== null) assert.ok(minRegen < minInit, `${label}: 恢复必须在先攻技能之前`);
        if (minInit !== null && minMain !== null) assert.ok(minInit < minMain, `${label}: 先攻技能必须在主行动之前`);
        if (maxPre !== null && minMain !== null) assert.ok(maxPre < minMain, `${label}: 回合前必须在主行动之前`);
      }
    }
  });

  it("自然回复一定出现在先攻节点之前", () => {
    for (const [name, report] of FULL_REPORTS) {
      for (const round of report.rounds) {
        const firstRegen = Math.min(...phaseOffset(round.regeneration));
        const firstInitiative = Math.min(...phaseOffset([...round.initiativeSkills, ...round.scheduledActions]));
        if (Number.isFinite(firstRegen) && Number.isFinite(firstInitiative)) {
          assert.ok(firstRegen < firstInitiative, `${name} 回合 ${round.round}: 恢复必须先于先攻`);
        }
      }
    }
  });

  it("主行动按先攻降序执行", () => {
    for (const [name, report] of FULL_REPORTS) {
      for (const round of report.rounds) {
        let violations = 0;
        for (let index = 1; index < round.scheduledActions.length; index += 1) {
          if (round.scheduledActions[index].initiative > round.scheduledActions[index - 1].initiative) violations += 1;
        }
        assert.equal(violations, 0, `${name} 回合 ${round.round}: 存在 ${violations} 处先攻升序`);
      }
    }
  });

  it("第 n 步行动 / 共 m 步 的序号与总数一致", () => {
    for (const [name, report] of FULL_REPORTS) {
      let completeGroups = 0;
      for (const round of report.rounds) {
        const groups = new Map();
        for (const action of round.scheduledActions) {
          // 叙述型消息行没有可归属的行动者，单独统计，不参与序号校验。
          if (action.actorId === null) continue;
          const key = `${action.actorId}|${action.totalActions}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(action.ordinal);
        }
        const totalsByActor = new Map();
        for (const action of round.scheduledActions) {
          if (action.actorId === null) continue;
          if (!totalsByActor.has(action.actorId)) totalsByActor.set(action.actorId, new Set());
          totalsByActor.get(action.actorId).add(action.totalActions);
        }
        for (const [actorId, totals] of totalsByActor) {
          assert.equal(totals.size, 1, `${name} 回合 ${round.round}: 角色 ${actorId} 在同一回合出现多个总步数 ${[...totals]}`);
        }
        for (const [key, ordinals] of groups) {
          const total = Number(key.split("|")[1]);
          assert.ok(ordinals.every((ordinal) => ordinal >= 1 && ordinal <= total), `${name} 回合 ${round.round}: ${key} 序号越界`);
          assert.equal(new Set(ordinals).size, ordinals.length, `${name} 回合 ${round.round}: ${key} 序号重复`);
          if (ordinals.length === total && Math.max(...ordinals) === total) completeGroups += 1;
        }
      }
      assert.ok(completeGroups > 0, `${name} 应至少有一个角色的行动步数完整覆盖 1..m`);
    }
  });
});

describe("黄金测试：召唤物是否跨回合加入", () => {
  it("回合前召唤参与当前回合（level2 断剑重铸的奇迹）", () => {
    const summon = eventsOf(level2, "SummonCreated").find((ev) => ev.summonName === "断剑重铸的奇迹");
    assert.ok(summon, "level2 应记录回合前召唤");
    assert.equal(summon.phase, "PreRoundCommandsExecuted");
    assert.equal(summon.round, 1);
    const round1 = level2.rounds.find((round) => round.round === 1);
    // 同一回合的恢复阶段就有召唤物自己的恢复行
    assert.ok(
      round1.regeneration.some((row) => row.actorName === "断剑重铸的奇迹"),
      "回合前召唤物应在当前回合的恢复阶段出现",
    );
    // 同一回合的主行动把它当作目标
    assert.ok(
      round1.actions.some((row) => row.targets.some((target) => target.unitId === summon.summonId)),
      "回合前召唤物应在当前回合被选为目标",
    );
    // 但它不在本回合开始时的状态快照里（快照早于回合前阶段）
    assert.ok(
      round1.statusBlocks.every((block) => block.units.every((unit) => unit.unitId !== summon.summonId)),
      "回合前召唤物不应出现在同一回合开始的状态快照中",
    );
  });

  it("主回合召唤下一回合才加入（level1 与提灯女士的约定 / 假面人偶舞会）", () => {
    const summon = eventsOf(level1, "SummonCreated").find((ev) => ev.summonName === "与提灯女士的约定");
    assert.ok(summon, "level1 应记录主回合召唤");
    assert.equal(summon.phase, "MainActionsExecuted");
    assert.equal(summon.round, 1);
    const round1 = level1.rounds.find((round) => round.round === 1);
    const round2 = level1.rounds.find((round) => round.round === 2);
    assert.ok(
      round1.regeneration.every((row) => row.actorName !== "与提灯女士的约定"),
      "主回合召唤物不应在召唤当回合的恢复阶段出现",
    );
    assert.ok(
      round2.regeneration.some((row) => row.actorName === "与提灯女士的约定"),
      "主回合召唤物应出现在下一回合的恢复阶段",
    );
    assert.ok(
      round1.statusBlocks.every((block) => block.units.every((unit) => unit.name !== "与提灯女士的约定")),
      "主回合召唤物不应出现在召唤当回合的状态快照中",
    );

    // 同一场战斗里另一个召唤物（假面人偶舞会）从第 2 回合起出现在状态快照并行动。
    const summonRounds = level1.rounds
      .filter((round) => round.statusBlocks.some((block) => block.units.some((unit) => unit.kind === "summon" && unit.name === "假面人偶舞会")))
      .map((round) => round.round);
    assert.deepEqual(summonRounds, [2, 3, 4, 5, 6]);
    const actedRounds = level1.rounds
      .filter((round) => round.scheduledActions.some((action) => action.actorName === "假面人偶舞会"))
      .map((round) => round.round);
    assert.deepEqual(actedRounds, [2, 3, 4, 5]);
    assert.ok(
      level1.rounds.find((round) => round.round === 1).statusBlocks.every((block) => block.units.every((unit) => unit.name !== "假面人偶舞会")),
      "第 1 回合状态快照不应含该召唤物",
    );
  });
});

describe("黄金测试：确定性与可追溯性", () => {
  it("相同输入产生完全相同的输出对象", async () => {
    const html = await readFile(level1Path, "utf8");
    const first = importBattleReport(html);
    const second = importBattleReport(html);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(first.events.map((ev) => ev.seq), second.events.map((ev) => ev.seq));
    assert.equal(first.events[0].seq, 1, "事件序号必须从 1 开始，不得依赖模块加载顺序");
    assert.equal(first.events[first.events.length - 1].seq, first.events.length);
  });

  it("文件摘要稳定且与文本内容绑定", () => {
    assert.equal(level1.sourceFileHash, "14ba3b3710ee48499794c4df5e208b2d");
    assert.equal(level2.sourceFileHash, "8ddeb8da0a719a673946bb048315dada");
    assert.equal(hashReportText("abc"), hashReportText("abc"));
    assert.notEqual(hashReportText("abc"), hashReportText("abd"));
    assert.equal(hashReportText("abc").length, 32);
    assert.equal(level1.sourceFile.endsWith("level1.html"), true);
  });

  it("真实战报没有未识别片段，只有战斗前区域告警", () => {
    for (const [name, report] of FULL_REPORTS) {
      assert.equal(report.unparsedFragments.length, 0, `${name} 不应有未识别片段`);
      assert.equal(report.parseWarnings.length, 1, `${name} 应只有一条战斗前区域告警`);
      assert.equal(report.parseWarnings[0].code, "PRE_BATTLE_REGION_IGNORED");
      assert.ok(report.parseWarnings[0].snippet.length > 0, "告警必须附带片段");
    }
  });

  it("元信息与结算信息解析正确", () => {
    for (const [name, report] of FULL_REPORTS) {
      assert.equal(report.dungeonName, "巨兽讨伐战-乌龟巨兽巴沙兰", name);
      assert.equal(report.generatedAt, "2026年8月28日 20:18", name);
      assert.equal(report.roomEnds.length, 1, name);
      assert.equal(report.roomEnds[0].text, "进攻者胜利了！", name);
      assert.ok(report.levelSuccess, name);
      assert.equal(report.rewards.length > 0, true, name);
    }
    assert.equal(level1.levelNumber, 1);
    assert.equal(level2.levelNumber, 2);
    assert.equal(level1.battleNumber, 1);
    assert.equal(level2.battleNumber, 1);
    assert.equal(level1.rounds.map((round) => round.round).join(","), "1,2,3,4,5,6");
    assert.equal(level2.rounds.map((round) => round.round).join(","), "1,2");
  });

  it("每个解析出的单位都带稳定 unitId 与中文显示名", () => {
    for (const [name, report] of FULL_REPORTS) {
      for (const round of report.rounds) {
        for (const block of round.statusBlocks) {
          for (const unit of block.units) {
            assert.ok(unit.unitId, `${name}: 单位缺少 unitId`);
            assert.ok(unit.name, `${name}: 单位缺少中文名`);
            if (unit.heroId !== null) assert.equal(unit.unitId, `h${unit.heroId}`);
            else assert.equal(unit.unitId, syntheticUnitId(unit.name));
          }
        }
      }
    }
  });

  it("空文档与无回合文档产生告警但不抛错", () => {
    const empty = importBattleReport("");
    assert.equal(empty.rounds.length, 0);
    assert.deepEqual(empty.parseWarnings.map((warning) => warning.code), ["MISSING_ROUND_HEADLINE"]);
    assert.equal(empty.counts.raw.rep_round_headline, 0);
    const noRounds = importBattleReport("<html><body><p>不是战报</p></body></html>");
    assert.equal(noRounds.rounds.length, 0);
    assert.equal(noRounds.parseWarnings[0].code, "MISSING_ROUND_HEADLINE");
  });

  it("整份战报导入在时间预算内完成", () => {
    assert.ok(level1ImportMs < 20000, `level1 导入耗时 ${level1ImportMs}ms`);
    assert.ok(level2ImportMs < 20000, `level2 导入耗时 ${level2ImportMs}ms`);
    assert.ok(level1.sourceLength > 7000000);
    assert.ok(level2.sourceLength > 8000000);
  });
});
