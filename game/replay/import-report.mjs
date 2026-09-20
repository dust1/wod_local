// 原始战报导入器：HTML 字符串 → 结构化数据 + 领域事件。设计文档 §18、§19、§23.5。
//
// 纯函数：相同输入必然产生相同输出（事件序号在导入开始时重置，不读取系统时间）。
// 不依赖 React、HTTP、数据库；文件读取集中在 importBattleReportFile。
// 解析失败一律写入 parseWarnings + unparsedFragments，绝不静默丢弃（§19.2 步骤 9）。

import { event, resetEventSequence } from "../events/types.mjs";
import { POSITION_BY_LABEL } from "../domain/positions.mjs";
import {
  countClassNodesMulti,
  elementEnd,
  elementSpan,
  findElementsByTagName,
  isHiddenTag,
  isVoidElement,
  parseAttributes,
  parseTagAt,
  scanTokens,
  textContent,
} from "./html-scan.mjs";

export const IMPORT_VERSION = "report-import/1";

/** 单位锚点类名 → 单位种类。 */
export const UNIT_CLASS_KINDS = Object.freeze({
  rep_myhero: "own",
  rep_myotherheros: "ally",
  rep_hero: "hero",
  rep_monster: "monster",
});

export const SIDE_BY_LABEL = Object.freeze({ 进攻者: "attacker", 防御者: "defender" });
export const SIDE_LABELS = Object.freeze({ attacker: "进攻者", defender: "防御者" });

/** 命中等级：战报文本 → 稳定 ASCII ID。hit-grade.mjs 用“命中”，战报用“普通”。 */
export const HIT_GRADE_ID_BY_TEXT = Object.freeze({
  闪避: "miss",
  普通: "hit",
  命中: "hit",
  重击: "heavy",
  致命一击: "critical",
});

export const HIT_GRADE_TEXT_BY_CLASS = Object.freeze({
  rep_miss: "闪避",
  rep_hit: "普通",
  rep_hit_crit: "致命一击",
});

export const WOUND_ID_BY_CLASS = Object.freeze({
  rep_wounds_none: "none",
  rep_wounds_lightly: "lightly",
  rep_status_msg: "statusMessage",
});

/** 设计文档 §2.3 使用的原始节点类别。 */
export const RAW_COUNT_CLASSES = Object.freeze([
  "rep_round_headline",
  "rep_status_headline",
  "rep_status_table",
  "rep_initiative",
  "rep_action",
  "rep_mana_cost",
  "rep_gain",
  "rep_loss",
  "rep_monster",
  "rep_myhero",
  "rep_myotherheros",
  "rep_hero",
  "rep_room_end",
  "rep_level_success",
  "rep_resource",
  "rep_wounds_none",
  "rep_status_msg",
  "rep_hit",
  "rep_hit_crit",
  "rep_miss",
]);

const MODIFIER_PREFIX_CATEGORY = Object.freeze({
  技能: "skill",
  伤害: "damage",
  攻击: "attack",
  防御: "defense",
  护甲: "armor",
  抗性: "resistance",
  敏感: "sensitivity",
  效果: "effect",
});

const DEFAULT_LIMITS = Object.freeze({
  maxWarnings: 5000,
  maxFragments: 2000,
  maxFragmentLength: 400,
});

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/**
 * 战报文件摘要（非加密、纯 JS，128 位十六进制）。
 * 用于黄金测试按文件校验，不用于安全场景。
 */
export function hashReportText(text) {
  const source = String(text);
  let a = 0x811c9dc5;
  let b = 0x7fed2a17;
  let c = 0x2545f491;
  let d = 0xc2b2ae35;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
    c = Math.imul(c ^ code, 0x27d4eb2f) >>> 0;
    d = Math.imul(d ^ code, 0x9e3779b1) >>> 0;
  }
  const length = source.length;
  a = (a ^ length) >>> 0;
  b = (b ^ (length << 3)) >>> 0;
  c = (c + length) >>> 0;
  d = (d ^ Math.imul(length, 0x01000193)) >>> 0;
  return [a, b, c, d].map((lane) => lane.toString(16).padStart(8, "0")).join("");
}

/** 没有数字 ID 的单位使用由名字派生的稳定 ID。 */
export function syntheticUnitId(name) {
  return `name:${String(name ?? "").trim()}`;
}

export function unitIdFor(heroId, name) {
  return heroId === null || heroId === undefined ? syntheticUnitId(name) : `h${heroId}`;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[,\s\u00a0]/g, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

function splitOutsideTags(html, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "<") depth += 1;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(html.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(html.slice(start));
  return parts;
}

/** 取出 `wodToolTip(this,'...')` 中的 JS 字符串原文（反转义 `\'`）。 */
export function extractTooltipString(tagHtml) {
  if (typeof tagHtml !== "string") return null;
  const marker = tagHtml.indexOf("wodToolTip(this,");
  if (marker < 0) return null;
  let i = marker + "wodToolTip(this,".length;
  while (i < tagHtml.length && /\s/.test(tagHtml[i])) i += 1;
  const quote = tagHtml[i];
  if (quote !== "'" && quote !== '"') return null;
  i += 1;
  let out = "";
  while (i < tagHtml.length) {
    const ch = tagHtml[i];
    if (ch === "\\") {
      const next = tagHtml[i + 1];
      out += next === "n" ? "\n" : next === undefined ? "" : next;
      i += 2;
      continue;
    }
    if (ch === quote) break;
    out += ch;
    i += 1;
  }
  return out;
}

/** 解析 tooltip 里的一段修正值（可能包含 `/` 分隔的多段伤害区间）。 */
function parseModifierLine(lineHtml) {
  const segments = splitOutsideTags(lineHtml, "/");
  const values = [];
  let label = "";
  let resourceHint = null;
  let note = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const firstBonus = segment.indexOf("rep_bonus");
    if (firstBonus < 0) {
      const text = textContent(segment);
      if (index === 0) label = text;
      else if (text) note = note ? `${note} ${text}` : text;
      continue;
    }
    const openTag = segment.lastIndexOf("<", firstBonus);
    if (index === 0 && openTag > 0) label = textContent(segment.slice(0, openTag));
    // 同一段里的固定值和百分比按出现顺序配对（伤害行是 `+85.50 +25%`）。
    const flats = [];
    const percents = [];
    let cursor = 0;
    let lastEnd = 0;
    while (cursor < segment.length) {
      const found = segment.indexOf("rep_bonus", cursor);
      if (found < 0) break;
      const open = segment.lastIndexOf("<", found);
      if (open < 0) break;
      const end = elementEnd(segment, open);
      const raw = textContent(segment.slice(open, end));
      const number = toNumber(raw.replace("%", ""));
      if (number !== null) {
        if (raw.includes("%")) percents.push(number);
        else flats.push(number);
      }
      cursor = end;
      lastEnd = end;
    }
    const pairs = Math.max(flats.length, percents.length);
    for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
      values.push({ flat: flats[pairIndex] ?? null, percent: percents[pairIndex] ?? null });
    }
    const tail = textContent(segment.slice(lastEnd));
    if (tail) {
      if (index === 0) note = note ? `${note} ${tail}` : tail;
      else note = note ? `${note} ${tail}` : tail;
    }
  }
  const trimmedLabel = label.replace(/[:：]\s*$/, "").trim();
  const firstFlat = values.find((value) => value.flat !== null);
  const firstPercent = values.find((value) => value.percent !== null);
  return {
    label: trimmedLabel,
    values,
    flat: firstFlat ? firstFlat.flat : null,
    percent: firstPercent ? firstPercent.percent : null,
    note: note ? note.trim() : null,
    raw: textContent(lineHtml),
  };
}

function modifierCategory(label) {
  for (const [prefix, category] of Object.entries(MODIFIER_PREFIX_CATEGORY)) {
    if (label.startsWith(prefix)) return category;
  }
  return "attribute";
}

function modifierName(label, category) {
  if (category === "attribute") return label;
  const space = label.indexOf(" ");
  return space < 0 ? label : label.slice(space + 1).trim();
}

/**
 * 解析 tooltip：返回原始文本、逐行修正和按效果来源分组的修正列表。
 * 战报 tooltip 结构：`<b>来源:</b><br />修正行<br />...<br /><br /><b>来源2:</b>...`
 */
export function parseTooltip(tooltipHtml, options = {}) {
  if (typeof tooltipHtml !== "string" || tooltipHtml.length === 0) return null;
  const lines = tooltipHtml.split(/<br\s*\/?>/i);
  const modifiers = [];
  const effects = [];
  let current = null;
  for (const lineHtml of lines) {
    const plain = textContent(lineHtml);
    const heading = /^<b>([\s\S]*?)<\/b>\s*:?/.exec(lineHtml.trim());
    if (heading && plain.endsWith(":")) {
      const name = textContent(heading[1]).replace(/[:：]\s*$/, "").trim();
      current = { name, modifiers: [] };
      effects.push(current);
      continue;
    }
    if (!plain) continue;
    if (!/rep_bonus/.test(lineHtml)) {
      // 纯说明行（例如“这是团队物品.”），保留为备注。
      if (current) current.note = current.note ? `${current.note} ${plain}` : plain;
      continue;
    }
    const parsed = parseModifierLine(lineHtml);
    if (!parsed.label) continue;
    const category = modifierCategory(parsed.label);
    const modifier = {
      label: parsed.label,
      name: modifierName(parsed.label, category),
      category,
      values: parsed.values,
      flat: parsed.flat,
      percent: parsed.percent,
      note: parsed.note,
      raw: parsed.raw,
    };
    modifiers.push(modifier);
    if (current) current.modifiers.push(modifier);
  }
  const result = { raw: options.keepRaw === false ? null : tooltipHtml, modifiers, effects };
  if (options.keepRaw === false) result.rawLength = tooltipHtml.length;
  return result;
}

/* ------------------------------------------------------------------ *
 * 锚点与单元格解析
 * ------------------------------------------------------------------ */

function parseAnchor(html, tagStart, options = {}) {
  const span = elementSpan(html, tagStart);
  if (!span) return null;
  const { attrs } = parseAttributes(span.tagHtml);
  const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean);
  const onclick = attrs.onclick ?? "";
  const jumpMatch = /jump\('h',\s*(\d+)\)/.exec(onclick);
  const heroId = jumpMatch ? Number(jumpMatch[1]) : null;
  const tooltipRaw = extractTooltipString(span.tagHtml);
  const name = textContent(html.slice(span.tagEnd, span.end));
  const unitClass = classes.find((cls) => UNIT_CLASS_KINDS[cls]) ?? null;
  // 召唤物的归属写在包裹它的 <span onmouseover="wodToolTip(this,'属于<b>主人</b>.')"> 上。
  let ownerName = null;
  let ownerTooltip = null;
  const wrapperStart = html.lastIndexOf("<span", span.start);
  if (wrapperStart >= 0) {
    const wrapper = parseTagAt(html, wrapperStart);
    if (wrapper && !wrapper.isEnd && elementEnd(html, wrapperStart) > span.start) {
      const wrapperTip = extractTooltipString(wrapper.raw);
      if (wrapperTip) {
        ownerTooltip = wrapperTip;
        const ownerMatch = /属于<b>([\s\S]*?)<\/b>/.exec(wrapperTip);
        if (ownerMatch) ownerName = textContent(ownerMatch[1]);
      }
    }
  }
  const ownerMatch = tooltipRaw ? /属于<b>([\s\S]*?)<\/b>/.exec(tooltipRaw) : null;
  if (!ownerName && ownerMatch) ownerName = textContent(ownerMatch[1]);
  return {
    name,
    heroId,
    unitId: unitIdFor(heroId, name),
    classes,
    unitClass,
    kind: unitClass ? (ownerName ? "summon" : UNIT_CLASS_KINDS[unitClass]) : "other",
    ownerName,
    ownerTooltip,
    isSkill: onclick.includes("o('s'"),
    isItem: classes.some((cls) => cls === "rep_uni" || cls.startsWith("item_")),
    tooltip: tooltipRaw === null ? null : parseTooltip(tooltipRaw, options),
    offset: span.start,
    endOffset: span.end,
  };
}

function collectAnchors(html, from = 0, to = html.length, options = {}) {
  const anchors = [];
  for (const token of scanTokens(html, from, to)) {
    if (token.kind !== "startTag" || token.name !== "a") continue;
    const anchor = parseAnchor(html, token.start, options);
    if (anchor) anchors.push(anchor);
  }
  return anchors;
}

function collectSpansByClass(html, className, from = 0, to = html.length) {
  const spans = [];
  for (const token of scanTokens(html, from, to)) {
    if (token.kind !== "startTag") continue;
    const { attrs } = parseAttributes(token.raw);
    const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean);
    if (!classes.includes(className)) continue;
    const span = elementSpan(html, token.start, to);
    spans.push({ ...span, classes, html: html.slice(span.start, span.end) });
  }
  return spans;
}

function parseTableCells(rowHtml) {
  return findElementsByTagName(rowHtml, "td").map((span) => {
    const { attrs } = parseAttributes(span.tagHtml);
    return {
      ...span,
      classes: (attrs.class ?? "").split(/\s+/).filter(Boolean),
      html: rowHtml.slice(span.start, span.end),
    };
  });
}

function parseManaCostSpan(html) {
  const match = /class="rep_mana_cost"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  if (!match) return null;
  const text = textContent(match[1]);
  const number = toNumber(text.replace(/[^\d.+-]/g, ""));
  return { amount: number, label: text.replace(/[\d.\s,+-]+/g, "").trim() || null, raw: text };
}

function parseDeltaSpan(rowHtml, span, kind) {
  const raw = textContent(rowHtml.slice(span.start, span.end));
  // 单位可能写在 span 内（`<span class="rep_loss"><b>-208 HP</b></span>`），
  // 也可能紧跟其后（`恢复<span class="rep_gain">15</span>法力`）。
  const inner = /^([+-]?\d+(?:\.\d+)?)\s*([^\d.]*)$/.exec(raw);
  let amount = null;
  let resourceLabel = null;
  if (inner) {
    amount = toNumber(inner[1]);
    resourceLabel = inner[2].trim() || null;
  } else {
    amount = toNumber(raw.replace(/[^\d.+-]/g, ""));
  }
  if (!resourceLabel) {
    const tail = /^\s*([A-Za-z\u4e00-\u9fff]+)/.exec(textContent(rowHtml.slice(span.end, span.end + 40)));
    if (tail) resourceLabel = tail[1];
  }
  return {
    kind,
    amount: amount === null ? null : Math.abs(amount),
    resourceLabel,
    raw,
    offset: span.start,
  };
}

function parseResourceSpan(html) {
  const labelMatch = /class="rep_resource"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  const label = labelMatch ? textContent(labelMatch[1]) : null;
  const text = textContent(html);
  const number = toNumber(text.replace(/[^\d.+-]/g, ""));
  return { amount: number, label, raw: text };
}

/* ------------------------------------------------------------------ *
 * 状态区块
 * ------------------------------------------------------------------ */

function parseStatusUnits(tableHtml, tableOffset, context) {
  const units = [];
  const rows = findElementsByTagName(tableHtml, "tr");
  for (const row of rows) {
    if (/<th\b/i.test(row.tagHtml)) continue;
    const rowHtml = tableHtml.slice(row.start, row.end);
    const cells = parseTableCells(rowHtml);
    if (cells.length === 0) continue;
    const heroCell = cells.find((cell) => cell.classes.includes("hero"));
    if (!heroCell) {
      context.warn("UNPARSED_STATUS_ROW", "状态表行缺少单位单元格", `status@${tableOffset + row.start}`, rowHtml);
      continue;
    }
    const anchors = collectAnchors(rowHtml, 0, rowHtml.length, { keepRaw: context.keepStatusTooltips });
    const unitAnchor = anchors.find((anchor) => anchor.unitClass) ?? anchors[0] ?? null;
    const numberCell = cells.find((cell) => cell.classes.includes("number"));
    const positionCell = cells.find((cell) => cell.classes.includes("position"));
    const resourceCell = cells.find((cell) => cell.classes.includes("resource"));
    const statusCell = cells.find((cell) => cell.classes.some((cls) => cls.startsWith("rep_wounds") || cls === "rep_status_msg"));
    const plainCells = cells.filter((cell) => cell.classes.length === 0);
    const level = toNumber(textContent(plainCells[0]?.html ?? ""));
    const health = toNumber(textContent(plainCells[1]?.html ?? ""));
    const resource = resourceCell ? parseResourceSpan(resourceCell.html) : null;
    const statusClasses = statusCell ? statusCell.classes : [];
    const statusText = statusCell ? textContent(statusCell.html) : null;
    const woundsClass = statusClasses.find((cls) => WOUND_ID_BY_CLASS[cls]) ?? null;
    const positionLabel = positionCell ? textContent(positionCell.html) : null;
    const position = positionLabel ? POSITION_BY_LABEL[positionLabel] ?? null : null;
    if (positionLabel && !position) {
      context.warn("UNKNOWN_POSITION", `未知站位: ${positionLabel}`, `status@${tableOffset + row.start}`, positionCell.html);
    }
    const unit = {
      unitId: unitAnchor ? unitAnchor.unitId : syntheticUnitId(textContent(heroCell.html)),
      heroId: unitAnchor ? unitAnchor.heroId : null,
      name: unitAnchor ? unitAnchor.name : textContent(heroCell.html),
      kind: unitAnchor?.ownerName ? "summon" : unitAnchor?.kind ?? "unknown",
      ownerName: unitAnchor?.ownerName ?? null,
      classes: unitAnchor?.classes ?? [],
      index: numberCell ? toNumber(textContent(numberCell.html)) : null,
      level,
      position,
      positionLabel,
      health,
      resource: resource ? resource.amount : null,
      resourceLabel: resource ? resource.label : null,
      status: statusText,
      statusId: woundsClass ? WOUND_ID_BY_CLASS[woundsClass] : null,
      effects: unitAnchor?.tooltip ? unitAnchor.tooltip.effects : [],
      modifiers: unitAnchor?.tooltip ? unitAnchor.tooltip.modifiers : [],
      tooltip: unitAnchor?.tooltip ? unitAnchor.tooltip.raw : null,
      tooltipLength: unitAnchor?.tooltip ? (unitAnchor.tooltip.rawLength ?? (unitAnchor.tooltip.raw ?? "").length) : 0,
      offset: tableOffset + row.start,
      endOffset: tableOffset + row.end,
    };
    units.push(unit);
  }
  return units;
}

/* ------------------------------------------------------------------ *
 * 行动行
 * ------------------------------------------------------------------ */

function parseRowHtml(rowHtml, rowTag, options) {
  const cells = parseTableCells(rowHtml);
  const initiativeCell = cells.find((cell) => cell.classes.includes("rep_initiative")) ?? null;
  const anchors = collectAnchors(rowHtml, 0, rowHtml.length, options);
  const text = textContent(rowHtml);
  const deltas = [];
  for (const token of scanTokens(rowHtml)) {
    if (token.kind !== "startTag") continue;
    const { attrs } = parseAttributes(token.raw);
    const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean);
    const deltaKind = classes.includes("rep_gain") ? "gain" : classes.includes("rep_loss") ? "loss" : null;
    if (!deltaKind) continue;
    const span = elementSpan(rowHtml, token.start);
    deltas.push(parseDeltaSpan(rowHtml, span, deltaKind));
  }
  const manaCosts = [];
  for (const span of collectSpansByClass(rowHtml, "rep_mana_cost")) {
    const parsed = parseManaCostSpan(span.html);
    if (parsed) manaCosts.push({ ...parsed, offset: span.start });
  }
  const hitGrades = [];
  for (const token of scanTokens(rowHtml)) {
    if (token.kind !== "startTag") continue;
    const { attrs } = parseAttributes(token.raw);
    const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean);
    const gradeClass = classes.find((cls) => HIT_GRADE_TEXT_BY_CLASS[cls]);
    if (!gradeClass) continue;
    const span = elementSpan(rowHtml, token.start);
    const gradeText = textContent(rowHtml.slice(span.start, span.end)) || HIT_GRADE_TEXT_BY_CLASS[gradeClass];
    hitGrades.push({
      grade: gradeText,
      gradeId: HIT_GRADE_ID_BY_TEXT[gradeText] ?? null,
      gradeClass,
      offset: span.start,
    });
  }
  const damage = [];
  const damageRe = /<br\s*\/?>\s*(-?[\d,]+(?:\.\d+)?)\s*(?:\[\s*([+-]?[\d,]+(?:\.\d+)?)\s*\])?\s*([^<]+?)\s*(?=<br\s*\/?>|<\/td>|$)/gi;
  let damageMatch;
  while ((damageMatch = damageRe.exec(rowHtml))) {
    const amount = toNumber(damageMatch[1]);
    if (amount === null) continue;
    damage.push({
      amount,
      absorbed: toNumber(damageMatch[2] ?? null),
      damageType: damageMatch[3].trim(),
    });
  }
  const unitAnchors = anchors.filter((anchor) => anchor.unitClass);
  const contentCells = cells.filter(
    (cell) => !cell.classes.includes("rep_initiative") && textContent(cell.html) !== "",
  );
  const firstContentCell = contentCells[0] ?? null;
  // 只有出现在第一个内容单元格开头的单位锚点才是行动者；
  // 叙述型消息（例如“式典所需的仪式尚未被满足……”）里列出的名字只是被提及者。
  const leadingUnitAnchor = firstContentCell
    ? unitAnchors.find(
        (anchor) =>
          anchor.offset >= firstContentCell.tagEnd &&
          anchor.offset < firstContentCell.end &&
          textContent(rowHtml.slice(firstContentCell.tagEnd, anchor.offset)) === "",
      ) ?? null
    : null;
  const skillAnchor = anchors.find((anchor) => anchor.isSkill) ?? null;
  const mentionedAnchors = unitAnchors.filter((anchor) => anchor !== leadingUnitAnchor);
  const targetAnchor = (() => {
    if (!skillAnchor) return null;
    const after = mentionedAnchors.filter((anchor) => anchor.offset > skillAnchor.offset);
    if (after.length === 0) return null;
    const cellAnchors = anchors.filter(
      (anchor) => anchor.offset > (firstContentCell ? firstContentCell.end : 0) && anchor.unitClass,
    );
    return cellAnchors[cellAnchors.length - 1] ?? after[after.length - 1];
  })();
  const initText = initiativeCell ? textContent(initiativeCell.html) : "";
  const initiativeMatch = /先攻\s*(-?[\d,]+)/.exec(initText);
  const scheduleMatch = /第\s*(\d+)\s*步行动\s*\/\s*共\s*(\d+)\s*步/.exec(initText);
  const initiativeSkillMatch = /:\s*先攻\s*(-?[\d,]+)\s*$/.exec(text);
  const rowIdMatch = /id="(activeRow_[^"]*)"/.exec(rowTag);
  return {
    rowId: rowIdMatch ? rowIdMatch[1] : null,
    text,
    anchors,
    unitAnchors,
    mentionedAnchors,
    leadingUnitAnchor,
    skillAnchor,
    targetAnchor,
    initiativeCell: initiativeCell ? initiativeCell.html : null,
    initiative: initiativeMatch ? toNumber(initiativeMatch[1]) : null,
    ordinal: scheduleMatch ? Number(scheduleMatch[1]) : null,
    totalActions: scheduleMatch ? Number(scheduleMatch[2]) : null,
    initiativeSkillText: initiativeSkillMatch ? toNumber(initiativeSkillMatch[1]) : null,
    isPreRound: Boolean(initiativeCell) && initText === "",
    manaCosts,
    deltas,
    hitGrades,
    damage,
  };
}

function classifyRow(row) {
  if (row.initiativeCell !== null) {
    if (row.isPreRound) return "preRound";
    if (row.initiative !== null) return row.ordinal === null ? "mainAction" : "scheduledAction";
    return "unknown";
  }
  if (row.deltas.length > 0 && row.initiativeSkillText === null) return "regeneration";
  if (row.initiativeSkillText !== null) return "initiativeSkill";
  if (row.text) return "narrative";
  return "separator";
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function createContext(options) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const warnings = [];
  const fragments = [];
  const warn = (code, message, region, snippet) => {
    if (warnings.length >= limits.maxWarnings) {
      if (warnings.length === limits.maxWarnings) {
        warnings.push({ code: "WARNING_LIMIT_REACHED", message: `告警数超过 ${limits.maxWarnings} 条，后续告警已折叠`, region, snippet: null });
      }
      return;
    }
    warnings.push({ code, message, region: region ?? null, snippet: snippet ? String(snippet).slice(0, limits.maxFragmentLength) : null });
  };
  const fragment = (code, message, region, snippet) => {
    warn(code, message, region, snippet);
    if (fragments.length < limits.maxFragments) fragments.push(String(snippet ?? "").slice(0, limits.maxFragmentLength));
  };
  return { limits, warnings, fragments, warn, fragment, hiddenNodesSkipped: 0, keepStatusTooltips: options.keepStatusTooltips === true };
}

function parseReportMeta(html, context) {
  const meta = {
    dungeonName: null,
    generatedAt: null,
    levelNumber: null,
    battleNumber: null,
    reportTitle: null,
    computedAt: null,
  };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) meta.reportTitle = textContent(title[1]);
  const comment = /<!--\s*computed by wod on ([^>]*?)-->/i.exec(html);
  if (comment) meta.computedAt = comment[1].replace(/\s+/g, " ").trim();
  const heading = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(html);
  if (heading) {
    const text = textContent(heading[1]);
    const separator = text.indexOf(" - ");
    if (separator > 0) {
      meta.generatedAt = text.slice(0, separator).trim();
      meta.dungeonName = text.slice(separator + 3).trim();
    } else {
      meta.generatedAt = text || null;
    }
  }
  if (!meta.dungeonName && meta.reportTitle) {
    const bracket = /^\[([^\]]*)\]\s*([\s\S]*)$/.exec(meta.reportTitle);
    meta.dungeonName = bracket ? bracket[2].replace(/\d{12}$/, "").trim() : meta.reportTitle.trim();
  }
  const rowId = /id="activeRow_(\d+)_(\d+)_\d+_\d+"/.exec(html);
  if (rowId) {
    meta.levelNumber = Number(rowId[1]);
    meta.battleNumber = Number(rowId[2]);
  }
  if (meta.levelNumber === null) {
    // 战报导航写作 <a name="回合号">层  1</a>，层号来自可见文本而不是 name 属性。
    const levelAnchor = /<a\s+name="\d+"[^>]*>\s*层\s*(\d+)/.exec(html);
    if (levelAnchor) meta.levelNumber = Number(levelAnchor[1]);
  }
  return meta;
}

function warnMeta(html, context) {
  if (!/<p[^>]*class="rep_round_headline"/.test(html)) {
    context.warn("MISSING_ROUND_HEADLINE", "未找到 rep_round_headline，文档可能不是战报", "document", html.slice(0, 200));
  }
}

/** 统计战斗区域内带单位 class 的锚点数量，跳过隐藏子树（用于与原始 class 计数对比）。 */
function countUnitAnchors(html, from, to) {
  let count = 0;
  const stack = [];
  let hiddenDepth = 0;
  for (const token of scanTokens(html, from, to)) {
    if (token.kind === "endTag") {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === token.name) {
          for (let j = stack.length - 1; j >= i; j -= 1) {
            if (stack[j].hidden) hiddenDepth -= 1;
          }
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (token.kind !== "startTag") continue;
    const { name, attrs } = parseAttributes(token.raw);
    const hidden = isHiddenTag(token.raw);
    if (name === "a" && hiddenDepth === 0 && !hidden) {
      const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean);
      if (classes.some((cls) => UNIT_CLASS_KINDS[cls])) count += 1;
    }
    if (!token.selfClosing && !isVoidElement(name)) {
      stack.push({ name, hidden });
      if (hidden) hiddenDepth += 1;
    }
  }
  return count;
}

function parseRoundHeadline(html, span, fallbackRound) {
  const text = textContent(html.slice(span.start, span.end));
  const match = /回合\s*(\d+)/.exec(text);
  return { round: match ? Number(match[1]) : fallbackRound, text };
}

/**
 * 收集行动表里的 `<tr>`。
 * 战报把每个回合包在 `<table class="content_table">` 的外层行里，
 * 因此必须跳过 content_table 内部的行，否则会把整回合甚至下一回合吞进行文本。
 */
function collectActionRows(html, from, to, statusSpans, context) {
  const rows = [];
  const stack = [];
  const insideStatus = (offset) => statusSpans.some(([start, end]) => offset >= start && offset < end);
  for (const token of scanTokens(html, from, to)) {
    if (token.kind === "endTag") {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === token.name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (token.kind !== "startTag") continue;
    const { name, attrs } = parseAttributes(token.raw);
    const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean);
    if (name === "tr") {
      let enclosingTable = null;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === "table") {
          enclosingTable = stack[i];
          break;
        }
      }
      const inContentTable = Boolean(enclosingTable && enclosingTable.classes.includes("content_table"));
      if (inContentTable) continue;
      if (insideStatus(token.start)) continue;
      if (isHiddenTag(token.raw)) {
        context.hiddenNodesSkipped += 1;
        continue;
      }
      rows.push({ start: token.start, end: elementEnd(html, token.start, to), tag: token.raw });
      continue;
    }
    if (!token.selfClosing && !isVoidElement(name)) stack.push({ name, classes });
  }
  if (rows.length === 0 && html.slice(from, to).includes("rep_initiative")) {
    context.warn("NO_ACTION_ROWS", "回合区域存在先攻节点但未解析出行动行", `@${from}`, html.slice(from, Math.min(to, from + 200)));
  }
  return rows;
}

function buildRound(html, regionStart, regionEnd, roundNumber, context, options) {
  const region = html.slice(regionStart, regionEnd);
  const statusTables = collectSpansByClass(html, "rep_status_table", regionStart, regionEnd).filter((table) => {
    if (isHiddenTag(table.tagHtml)) {
      context.hiddenNodesSkipped += 1;
      return false;
    }
    return true;
  });
  const headlines = collectSpansByClass(html, "rep_status_headline", regionStart, regionEnd);
  const statusBlocks = [];
  for (const table of statusTables) {
    let side = null;
    let headlineSpan = null;
    for (const headline of headlines) {
      if (headline.start < table.start) headlineSpan = headline;
      else break;
    }
    if (headlineSpan) {
      const label = textContent(html.slice(headlineSpan.start, headlineSpan.end)).replace(/[:：]\s*$/, "").trim();
      side = SIDE_BY_LABEL[label] ?? null;
      if (!side) context.warn("UNKNOWN_SIDE", `未知阵营标题: ${label}`, `round:${roundNumber}`, headlineSpan.html);
    } else {
      context.warn("STATUS_TABLE_WITHOUT_HEADLINE", "状态表前没有阵营标题", `round:${roundNumber}@${table.start}`, table.html);
    }
    const tableHtml = html.slice(table.start, table.end);
    const units = parseStatusUnits(tableHtml, table.start, context);
    statusBlocks.push({ side, sideLabel: side ? SIDE_LABELS[side] : null, offset: table.start, endOffset: table.end, units });
  }

  const statusSpans = statusTables.map((table) => [table.start, table.end]);
  const rows = [];
  for (const rawRow of collectActionRows(html, regionStart, regionEnd, statusSpans, context)) {
    const rowHtml = html.slice(rawRow.start, rawRow.end);
    const parsed = parseRowHtml(rowHtml, rawRow.tag, options);
    parsed.kind = classifyRow(parsed);
    parsed.offset = rawRow.start;
    parsed.endOffset = rawRow.end;
    rows.push(parsed);
  }

  const round = {
    round: roundNumber,
    statusBlocks,
    preRound: [],
    regeneration: [],
    initiativeSkills: [],
    scheduledActions: [],
    actions: [],
    manaCosts: [],
    gains: [],
    losses: [],
    startOffset: regionStart,
    endOffset: regionEnd,
    rows,
  };

  for (const row of rows) {
    const actor = row.leadingUnitAnchor;
    const actorId = actor ? actor.unitId : null;
    const actorName = actor ? actor.name : null;
    const targets = row.mentionedAnchors.map((anchor) => ({
      unitId: anchor.unitId,
      name: anchor.name,
      kind: anchor.kind,
      ownerName: anchor.ownerName,
    }));
    const base = {
      rowId: row.rowId,
      kind: row.kind,
      round: roundNumber,
      actorId,
      actorName,
      actorKind: actor ? actor.kind : null,
      ownerName: actor ? actor.ownerName : null,
      targets,
      mentionedUnits: targets,
      hitGrades: row.hitGrades.map((grade) => ({ ...grade, offset: row.offset + grade.offset })),
      damage: row.damage,
      skillName: row.skillAnchor ? row.skillAnchor.name : null,
      skillTooltip: row.skillAnchor ? row.skillAnchor.tooltip?.raw ?? null : null,
      skillModifiers: row.skillAnchor ? row.skillAnchor.tooltip?.modifiers ?? [] : [],
      manaCost: row.manaCosts.length > 0 ? row.manaCosts[0].amount : null,
      initiative: row.initiative,
      ordinal: row.ordinal,
      totalActions: row.totalActions,
      deltas: row.deltas.map((delta) => ({ ...delta, offset: row.offset + delta.offset })),
      text: row.text,
      offset: row.offset,
      endOffset: row.endOffset,
    };
    if (row.kind === "separator") continue;
    for (const mana of row.manaCosts) {
      round.manaCosts.push({ actorId, actorName, amount: mana.amount, resourceLabel: mana.label ?? "法力", offset: row.offset + mana.offset, rowId: row.rowId });
    }
    for (const delta of base.deltas) {
      const entry = { actorId, actorName, amount: delta.amount, resourceLabel: delta.resourceLabel, kind: delta.kind, offset: delta.offset, rowId: row.rowId };
      if (delta.kind === "gain") round.gains.push(entry);
      else round.losses.push(entry);
    }
    switch (row.kind) {
      case "preRound":
        round.preRound.push(base);
        break;
      case "regeneration":
        round.regeneration.push(base);
        break;
      case "initiativeSkill":
        base.initiative = row.initiativeSkillText;
        round.initiativeSkills.push(base);
        break;
      case "scheduledAction":
      case "mainAction":
        round.scheduledActions.push({
          actorId,
          actorName,
          initiative: row.initiative,
          ordinal: row.ordinal,
          totalActions: row.totalActions,
          rowId: row.rowId,
          offset: row.offset,
          manaCost: base.manaCost,
          skillName: base.skillName,
          text: base.text,
        });
        round.actions.push(base);
        break;
      case "narrative":
        round.actions.push(base);
        break;
      default:
        context.fragment("UNPARSED_ROW", `无法识别的行动行: ${row.text.slice(0, 60)}`, `round:${roundNumber}@${row.offset}`, html.slice(row.offset, row.endOffset));
        break;
    }
  }
  return round;
}

function emitRoundEvents(round, events, options) {
  events.push(event("RoundStarted", { round: round.round, phase: "RoundStarted" }));
  for (const block of round.statusBlocks) {
    for (const unit of block.units) {
      events.push(
        event("StatusSnapshot", {
          round: round.round,
          phase: "StatusSnapshotPublished",
          side: block.side,
          unitId: unit.unitId,
          name: unit.name,
          kind: unit.kind,
          level: unit.level,
          position: unit.position,
          positionLabel: unit.positionLabel,
          health: unit.health,
          resource: unit.resource,
          resourceLabel: unit.resourceLabel,
          wounds: unit.status,
          statusId: unit.statusId,
          effects: unit.effects.map((effect) => effect.name),
        }),
      );
    }
  }
  for (const row of round.preRound) {
    if (row.skillName) {
      events.push(
        event("SkillAttempted", {
          round: round.round,
          phase: "PreRoundCommandsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          skillName: row.skillName,
          manaCost: row.manaCost,
        }),
      );
    }
    for (const mana of row.manaCost !== null ? [{ amount: row.manaCost, label: "法力" }] : []) {
      events.push(
        event("ResourceSpent", {
          round: round.round,
          phase: "PreRoundCommandsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          amount: mana.amount,
          resourceLabel: mana.label,
        }),
      );
    }
    for (const delta of row.deltas) {
      events.push(
        event("ResourceSpent", {
          round: round.round,
          phase: "PreRoundCommandsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          amount: delta.amount,
          resourceLabel: delta.resourceLabel,
        }),
      );
    }
    if (row.text.includes("召唤")) {
      const summon = row.targets[0] ?? null;
      events.push(
        event("SummonCreated", {
          round: round.round,
          phase: "PreRoundCommandsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          summonId: summon ? summon.unitId : null,
          summonName: summon ? summon.name : null,
          skillName: row.skillName,
        }),
      );
    }
    for (const target of row.targets) {
      events.push(
        event("TargetSelected", {
          round: round.round,
          phase: "PreRoundCommandsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          targetId: target.unitId,
          targetName: target.name,
        }),
      );
    }
  }
  for (const row of round.regeneration) {
    for (const delta of row.deltas) {
      events.push(
        event("ResourceChanged", {
          round: round.round,
          phase: "NaturalRegenerationApplied",
          actorId: row.actorId,
          actorName: row.actorName,
          delta: delta.kind === "gain" ? delta.amount : -delta.amount,
          resourceLabel: delta.resourceLabel,
        }),
      );
    }
  }
  for (const row of round.initiativeSkills) {
    if (row.skillName) {
      events.push(
        event("SkillAttempted", {
          round: round.round,
          phase: "InitiativeSkillsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          skillName: row.skillName,
          manaCost: row.manaCost,
        }),
      );
    }
    if (row.manaCost !== null) {
      events.push(
        event("ResourceSpent", {
          round: round.round,
          phase: "InitiativeSkillsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          amount: row.manaCost,
          resourceLabel: "法力",
        }),
      );
    }
    for (const delta of row.deltas) {
      events.push(
        event("ResourceSpent", {
          round: round.round,
          phase: "InitiativeSkillsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          amount: delta.amount,
          resourceLabel: delta.resourceLabel,
        }),
      );
    }
    if (row.initiative !== null && row.initiative !== undefined) {
      events.push(
        event("InitiativeRolled", {
          round: round.round,
          phase: "InitiativeSkillsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          initiative: row.initiative,
          skillName: row.skillName,
        }),
      );
    }
  }
  for (const row of round.actions) {
    if (row.ordinal !== null && row.ordinal !== undefined) {
      events.push(
        event("ActionScheduled", {
          round: round.round,
          phase: "InitiativeScheduleGenerated",
          actorId: row.actorId,
          actorName: row.actorName,
          initiative: row.initiative,
          ordinal: row.ordinal,
          totalActions: row.totalActions,
        }),
      );
    }
    if (row.skillName) {
      events.push(
        event("SkillAttempted", {
          round: round.round,
          phase: "MainActionsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          skillName: row.skillName,
          manaCost: row.manaCost,
        }),
      );
    }
    if (row.manaCost !== null) {
      events.push(
        event("ResourceSpent", {
          round: round.round,
          phase: "MainActionsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          amount: row.manaCost,
          resourceLabel: "法力",
        }),
      );
    }
    for (const delta of row.deltas) {
      events.push(
        event("ResourceSpent", {
          round: round.round,
          phase: "MainActionsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          amount: delta.amount,
          resourceLabel: delta.resourceLabel,
        }),
      );
    }
    if (row.text.includes("召唤")) {
      const summon = row.targets[0] ?? null;
      events.push(
        event("SummonCreated", {
          round: round.round,
          phase: "MainActionsExecuted",
          actorId: row.actorId,
          actorName: row.actorName,
          summonId: summon ? summon.unitId : null,
          summonName: summon ? summon.name : null,
          skillName: row.skillName,
        }),
      );
    }
  }
  return events;
}

/**
 * 导入一份战报。
 * @param {string} html 战报 HTML 全文
 * @param {object} [options]
 * @param {string|null} [options.sourceFile] 来源文件名（仅记录）
 * @param {(text:string)=>string} [options.hash] 自定义摘要函数
 * @param {boolean} [options.keepStatusTooltips] 是否保留状态表 tooltip 原文（默认 false，避免大内存）
 * @param {object} [options.limits] 告警与片段上限
 * @returns {object} ImportedBattleReport
 */
export function importBattleReport(html, options = {}) {
  if (typeof html !== "string") throw new TypeError("importBattleReport 需要 HTML 字符串");
  const context = createContext(options);
  const limits = context.limits;
  const raw = countClassNodesMulti(html, RAW_COUNT_CLASSES);
  const meta = parseReportMeta(html, context);
  warnMeta(html, context);

  const roundHeadlines = collectSpansByClass(html, "rep_round_headline");
  const firstRoundOffset = roundHeadlines.length > 0 ? roundHeadlines[0].start : html.length;

  // 战斗前的设置/统计区域：含隐藏行与重复展示节点，导入器有意跳过但必须留痕。
  if (firstRoundOffset > 0) {
    const preBattle = html.slice(0, firstRoundOffset);
    const hiddenNodes = (preBattle.match(/style="display: none;"/g) ?? []).length;
    const buffRows = (preBattle.match(/id="table_stat_buffed_/g) ?? []).length;
    const excluded = countClassNodesMulti(preBattle, RAW_COUNT_CLASSES);
    context.warn(
      "PRE_BATTLE_REGION_IGNORED",
      `跳过战斗前区域（${firstRoundOffset} 字符，隐藏行 ${hiddenNodes} 个，table_stat_buffed ${buffRows} 个），该区域属于设置/统计展示而非战斗过程`,
      "preBattle",
      preBattle.slice(0, 200),
    );
    context.excludedBeforeFirstRound = excluded;
    context.preBattleStats = { length: firstRoundOffset, hiddenNodes, buffRows };
  } else {
    context.excludedBeforeFirstRound = Object.fromEntries(RAW_COUNT_CLASSES.map((cls) => [cls, 0]));
    context.preBattleStats = { length: 0, hiddenNodes: 0, buffRows: 0 };
  }

  const rounds = [];
  for (let index = 0; index < roundHeadlines.length; index += 1) {
    const start = roundHeadlines[index].start;
    const end = index + 1 < roundHeadlines.length ? roundHeadlines[index + 1].start : html.length;
    const { round: roundNumber } = parseRoundHeadline(html, roundHeadlines[index], index + 1);
    rounds.push(buildRound(html, start, end, roundNumber, context, options));
  }

  // 战斗结束与层结算。
  const roomEnds = collectSpansByClass(html, "rep_room_end").map((span) => ({
    text: textContent(html.slice(span.start, span.end)),
    offset: span.start,
    round: rounds.length > 0 ? rounds[rounds.length - 1].round : null,
  }));
  const levelSuccessSpans = collectSpansByClass(html, "rep_level_success");
  const levelSuccess = levelSuccessSpans.length === 0
    ? null
    : {
        text: textContent(html.slice(levelSuccessSpans[0].start, levelSuccessSpans[0].end)),
        offset: levelSuccessSpans[0].start,
        level: meta.levelNumber,
      };
  const rewards = collectSpansByClass(html, "rewards").map((span) => {
    // rep_decimal 会把小数部分拆成单独 span，先合并再匹配数值。
    const rewardHtml = html
      .slice(span.start, span.end)
      .replace(/<span[^>]*class="rep_decimal"[^>]*>([\s\S]*?)<\/span>/g, "$1");
    const anchors = collectAnchors(rewardHtml);
    const unit = anchors.find((anchor) => anchor.unitClass) ?? null;
    const entries = [];
    const text = textContent(rewardHtml);
    const numberRe = /([+-]?[\d.,]+)\s*<[^>]*title="([^"]*)"[^>]*>/g;
    let match;
    while ((match = numberRe.exec(rewardHtml))) {
      const value = toNumber(match[1]);
      if (value === null) continue;
      entries.push({ label: match[2], value });
    }
    return {
      unitId: unit ? unit.unitId : null,
      name: unit ? unit.name : null,
      text,
      entries,
      offset: span.start,
    };
  });

  // 事件：重置序号，保证相同输入得到相同事件序列。
  resetEventSequence();
  const events = [];
  for (const round of rounds) emitRoundEvents(round, events, options);
  for (const round of rounds) {
    for (const block of round.statusBlocks) {
      for (const unit of block.units) {
        if (unit.statusId === "statusMessage" && unit.status === "击倒") {
          events.push(
            event("UnitDefeated", {
              round: round.round,
              phase: "RoundEnded",
              unitId: unit.unitId,
              unitName: unit.name,
              side: block.side,
            }),
          );
        }
      }
    }
  }
  for (const roomEnd of roomEnds) {
    events.push(
      event("BattleEnded", {
        round: roomEnd.round,
        phase: "RoundEnded",
        result: roomEnd.text.includes("进攻者") ? "attackerVictory" : roomEnd.text.includes("防御者") ? "defenderVictory" : "unknown",
        resultLabel: roomEnd.text,
      }),
    );
  }
  if (levelSuccess) {
    events.push(event("LevelEnded", { phase: "RoundEnded", level: levelSuccess.level, text: levelSuccess.text }));
  }

  const semantic = {
    rounds: rounds.length,
    statusBlocks: rounds.reduce((sum, round) => sum + round.statusBlocks.length, 0),
    statusUnits: rounds.reduce(
      (sum, round) => sum + round.statusBlocks.reduce((inner, block) => inner + block.units.length, 0),
      0,
    ),
    initiativeRows: 0,
    scheduledActionRows: 0,
    initiativeActionNodes: 0,
    manaCostNodes: 0,
    gainNodes: 0,
    lossNodes: 0,
    preRoundRows: rounds.reduce((sum, round) => sum + round.preRound.length, 0),
    regenerationRows: rounds.reduce((sum, round) => sum + round.regeneration.length, 0),
    initiativeSkillRows: rounds.reduce((sum, round) => sum + round.initiativeSkills.length, 0),
    scheduledActions: rounds.reduce((sum, round) => sum + round.scheduledActions.length, 0),
    actionRows: rounds.reduce((sum, round) => sum + round.actions.length, 0),
    messageRows: 0,
    unitAnchors: 0,
    summonUnits: 0,
    hiddenNodesSkipped: context.hiddenNodesSkipped,
    events: events.length,
    unparsedFragments: context.fragments.length,
    warnings: context.warnings.length,
  };
  for (const round of rounds) {
    for (const row of round.rows) {
      if (row.initiativeCell !== null) semantic.initiativeRows += 1;
      if (row.ordinal !== null) semantic.scheduledActionRows += 1;
      if (row.leadingUnitAnchor === null && row.unitAnchors.length > 0) semantic.messageRows += 1;
      for (const span of collectSpansByClass(html, "rep_action", row.offset, row.endOffset)) {
        if (span) semantic.initiativeActionNodes += 1;
      }
      semantic.manaCostNodes += row.manaCosts.length;
      for (const delta of row.deltas) {
        if (delta.kind === "gain") semantic.gainNodes += 1;
        else semantic.lossNodes += 1;
      }
    }
    for (const block of round.statusBlocks) {
      for (const unit of block.units) {
        if (unit.kind === "summon") semantic.summonUnits += 1;
      }
    }
    // 与原始 class 计数可直接对比的口径：战斗区域内带单位 class 的锚点总数（跳过隐藏子树）。
    semantic.unitAnchors += countUnitAnchors(html, round.startOffset, round.endOffset);
  }

  return {
    importVersion: IMPORT_VERSION,
    sourceFile: options.sourceFile ?? null,
    sourceFileHash: (options.hash ?? hashReportText)(html),
    sourceLength: html.length,
    dungeonName: meta.dungeonName,
    levelNumber: meta.levelNumber,
    battleNumber: meta.battleNumber,
    generatedAt: meta.generatedAt,
    computedAt: meta.computedAt,
    reportTitle: meta.reportTitle,
    rounds,
    roomEnds,
    levelSuccess,
    rewards,
    events,
    parseWarnings: context.warnings,
    unparsedFragments: context.fragments,
    counts: {
      raw,
      semantic,
      excludedBeforeFirstRound: context.excludedBeforeFirstRound,
      preBattleRegion: context.preBattleStats,
      limits,
    },
  };
}

/** 读取并导入战报文件。文件 I/O 只发生在这里。 */
export async function importBattleReportFile(filePath, options = {}) {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(filePath, options.encoding ?? "utf8");
  return importBattleReport(html, { ...options, sourceFile: options.sourceFile ?? String(filePath) });
}
