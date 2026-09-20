// 人物卡（BBCode 角色卡）的解析与生成。纯数据与纯函数，无 I/O。
//
// 卡面格式来自游戏「导出人物卡」：
//   [table border=1]
//   [tr][td][color=orange]力量[/color][/td][td]2[6][/td][td][skill:强化：疾影][/td][td]6[8][/td][/tr]
//   ...
//   [tr][td][color=orange]头[/color][/td][td colspan=3][item:宁静之冠]!:g0::g0::g0:[/td][/tr]
//   [/table]
//
// 表格前段左右两列各自成组：左列是属性（名称 / 基础值与已训练值），右列是技能（技能名 / 训练等级），
// 两列长度不同时用空格子补齐，因此左右两列必须分别解析、不能按行配对。
// 表格后段是装备：左格是部位名，跨三列格是 `[item:名称]!` 与品阶标记。

import { ATTRIBUTE_LABELS, ATTRIBUTE_KEYS } from "./attributes.mjs";

/** 卡面属性名称 → heroes 表的稳定属性键。 */
export const CHARACTER_CARD_ATTRIBUTE_KEYS = Object.freeze(
  Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [ATTRIBUTE_LABELS[key], key])),
);

/**
 * 卡面出现但不由属性训练写入的派生项。
 * 它们由 game/formulas 的纯函数从属性推导，导入时不写库，只在预览里逐项对照。
 */
export const CHARACTER_CARD_DERIVED_LABELS = Object.freeze([
  "英雄等级", "体力", "体力恢复", "法力", "法力回复", "每回合行动次数", "先攻附加值", "荣誉",
]);

const CARD_DERIVED_LABEL_SET = new Set(CHARACTER_CARD_DERIVED_LABELS);

/** 装备部位名称 → equip_slot 稳定 ID；勋章/口袋/戒指在卡面上带 #N 后缀。 */
export const CHARACTER_CARD_SLOT_IDS = Object.freeze({
  头: "head", 耳: "ear", 眼镜: "glasses", 颈: "neck", 身体: "body", 腰带: "belt",
  披风: "cloak", 肩膀: "shoulder", 臂: "arm", 手: "hand", 双手: "two_hands",
  右手: "right_hand", 左手: "left_hand", 腿: "leg", 脚: "foot",
  勋章: "medal", 口袋: "pocket", 戒指: "ring",
});

/** 卡面的多槽位部位：导出时按 `部位#N` 编号。 */
export const CHARACTER_CARD_REPEATED_SLOTS = Object.freeze(["勋章", "口袋", "戒指"]);

/** 装备品质标记：`:g0:` 等卡片内联标记，生成时统一写回 `:g0:`。 */
const MARKER_PATTERN = /:g[a-z0-9]*:/gi;
const NEUTRAL_MARKER = ":g0:";

// 技能名前缀（`强化`、`天赋`、`远古智慧` 这类 0–3 字的分类标签）。
const SKILL_LABEL_PATTERN = /^[^\s\d:：]{0,3}$/;

/** 只剥离纯样式标签；`[skill:…]` / `[item:…]` 是卡面数据，必须原样保留。 */
function stripTags(text) {
  return String(text ?? "")
    .replace(/\[\/?(?:color|b|i|u|center|left|right|size|font|quote)(?:=[^\]]*)?\]/gi, "")
    .trim();
}

/**
 * 把一个格子还原成裸文本：剥掉 `[skill:…]` 外层标签与品质标记。
 * 这样 `[skill:天赋：狂热讲演]!:g0:` 与 `天赋：狂热讲演` 走同一条解析路径。
 */
function skillCellText(text) {
  const raw = stripMarkers(text).trim();
  const tagged = raw.match(/\[skill[:：]([\s\S]*?)\]/i);
  if (tagged) return tagged[1].trim();
  return raw.replace(/^[!！]+/, "").trim();
}

function stripMarkers(text) {
  return String(text ?? "").replace(MARKER_PATTERN, "").trim();
}

/** 去掉技能/物品名尾部的装饰符（`!` 与品质标记），保留名称本身的括号与连字符。 */
function cleanName(text) {
  return stripMarkers(text).replace(/[!！]+$/g, "").replace(/\s+/g, " ").trim();
}

function countMarkers(text) {
  const matches = String(text ?? "").match(MARKER_PATTERN);
  return matches ? matches.length : 0;
}

function statusOf(text) {
  const markerCount = countMarkers(text);
  return {
    markerCount,
    status: markerCount > 0 ? "trained" : "untrained",
    statusLabel: markerCount > 0 ? "已训练" : "未训练",
  };
}

/** 卡面一格：`2[6]` → 基础值 2、已训练值 6；`40` → 只有单值。 */
function parseNumberCell(text) {
  const match = stripMarkers(text).match(/^(\d+)\s*(?:\[\s*(\d+)\s*\])?/);
  if (!match) return null;
  return { base: Number(match[1]), trained: match[2] != null ? Number(match[2]) : null };
}

/** 把表格拆成「行 → 格子」，并保留 colspan 等属性。 */
function parseTableCells(text) {
  const cells = [];
  const rowPattern = /\[tr\]([\s\S]*?)\[\/tr\]/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(String(text ?? "")))) {
    const row = [];
    const cellPattern = /\[td([^\]]*)\]([\s\S]*?)\[\/td\]/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      const attributes = {};
      const attributePattern = /([a-z]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?/gi;
      let attributeMatch;
      while ((attributeMatch = attributePattern.exec(cellMatch[1]))) {
        attributes[attributeMatch[1].toLowerCase()] = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? "1";
      }
      row.push({ text: stripTags(cellMatch[2]), ...attributes });
    }
    cells.push(row);
  }
  return cells;
}

/**
 * 把一格 `[skill:…]` 内容拆成名称与等级。
 *
 * 第一个 `:` 之后是标签与名称，`标签：名称` 里名称仍可能含全角括号；
 * 名称之后以 `:` 分隔的 `g0` 等片段是品质标记，最后一个纯数字片段是训练等级。
 */
/** 取走末尾的纯数字片段（技能训练等级），其余片段拼回名称。 */
function popTrailingLevel(segments) {
  const last = segments.length > 0 ? segments[segments.length - 1].trim() : "";
  if (segments.length > 0 && /^\d+$/.test(last)) return Number(segments.pop().trim());
  return null;
}

function parseSkillCell(text) {
  const content = skillCellText(text);
  const colonIndex = content.indexOf(":");
  const head = colonIndex === -1 ? content : content.slice(0, colonIndex);
  const rest = colonIndex === -1 ? "" : content.slice(colonIndex + 1);
  const segments = rest === "" ? [] : rest.split(":");

  const level = popTrailingLevel(segments) ?? 0;
  const rawName = [head, ...segments].join(":").replace(/[!！]+$/g, "").trim();
  const labelIndex = rawName.indexOf("：");
  const label = labelIndex === -1 ? "" : rawName.slice(0, labelIndex).trim();
  const name = (labelIndex === -1 ? rawName : rawName.slice(labelIndex + 1)).trim();
  return { ...statusOf(text), label, name, level };
}

/**
 * 判断一格 `[skill:…]` 是否真的是技能名。
 *
 * 卡面里还有「每次地城探险得到的荣誉奖励」「+1」这类占位文字：它们同样带 `[skill:]` 标签，
 * 只靠标签区分不了。这里的判据是「没有 `标签：名称` 结构时，名称必须是短名」——
 * 目录里不带冒号的技能名最长 10 个字符（如「典型的玛格—莫精灵」），而占位文字是整句说明。
 * 真正的技能匹配仍由 application 层对着目录做，这里只负责不把说明文字当成技能。
 */
const MAX_PLAIN_SKILL_NAME_LENGTH = 12;

function looksLikeSkillLabel(text) {
  const content = skillCellText(text);
  const colonIndex = content.indexOf(":");
  const head = colonIndex === -1 ? content : content.slice(0, colonIndex);
  const rest = colonIndex === -1 ? "" : content.slice(colonIndex + 1);
  const segments = rest === "" ? [] : rest.split(":");
  popTrailingLevel(segments);
  const rawName = [head, ...segments].join(":").replace(/[!！]+$/g, "").trim();
  if (rawName === "" || /^[+\-—\d]/.test(rawName)) return false;
  const labelIndex = rawName.indexOf("：");
  if (labelIndex === -1) return rawName.length <= MAX_PLAIN_SKILL_NAME_LENGTH;
  return SKILL_LABEL_PATTERN.test(rawName.slice(0, labelIndex).trim()) && rawName.slice(labelIndex + 1).trim() !== "";
}

/** `勋章#3` → 部位 `勋章`、序号 3。 */
function splitSlotLabel(label) {
  const match = String(label).match(/^(.*?)#\s*(\d+)$/);
  if (!match) return { slotLabel: String(label).trim(), slotIndex: null };
  return { slotLabel: match[1].trim(), slotIndex: Number(match[2]) };
}

/**
 * 装备行：`[item:名称]` 可能出现在左格，也可能出现在左格之后的跨列格，
 * 部位名与品阶标记分别位于它的前后。
 */
function readEquipmentRow(row) {
  const itemIndex = row.findIndex((cell) => /\[item[:：]/i.test(cell.text));
  if (itemIndex === -1) return null;
  const cell = row[itemIndex];
  const itemMatch = cell.text.match(/\[item[:：]([\s\S]*?)\]/i);
  if (!itemMatch) return null;
  const prefix = cell.text.split(/\[item[:：]/i)[0];
  const slotSource = stripMarkers(prefix) || row.find((entry) => entry !== cell && stripMarkers(entry.text))?.text?.trim() || "";
  const { slotLabel, slotIndex } = splitSlotLabel(slotSource);
  const decorator = row.find((entry) => entry !== cell && Boolean(entry.colspan)) ?? row[row.length - 1];
  return {
    slotLabel,
    slotId: CHARACTER_CARD_SLOT_IDS[slotLabel] ?? null,
    slotIndex,
    name: cleanName(itemMatch[1]),
    ...statusOf(`${cell.text} ${decorator && decorator !== cell ? decorator.text : ""}`),
  };
}
/**
 * 解析人物卡 BBCode。
 *
 * 返回结构只描述卡面事实（名称、数值、标记），不做任何与角色或数据库的匹配；
 * 匹配与合法性判断由 application 层的导入用例负责，便于两者分别测试。
 *
 * @param {string} text 人物卡 BBCode（可含表格外的说明文字）
 * @returns {{attributes: object[], derived: object[], skills: object[], equipment: object[], warnings: string[]}}
 */
export function parseCharacterCard(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  if (source.trim() === "") throw new Error("人物卡内容为空");

  const tableMatch = source.match(/\[table[^\]]*\]([\s\S]*?)\[\/table\]/i);
  const rows = parseTableCells(tableMatch ? tableMatch[1] : source);
  if (rows.length === 0) throw new Error("没有找到人物卡表格，请粘贴完整的 BBCode 人物卡");

  const attributes = [];
  const derived = [];
  const skills = [];
  const equipment = [];
  const warnings = [];
  const skillByName = new Map();
  let unnamedSkillCount = 0;

  const addSkill = (name, label, level) => {
    if (!name) return;
    const existing = skillByName.get(name);
    if (!existing) {
      const entry = { name, label, level: Number(level) || 0, markerCount: 0, status: "untrained", statusLabel: "未训练" };
      skillByName.set(name, entry);
      skills.push(entry);
      return;
    }
    existing.level = Math.max(existing.level, Number(level) || 0);
  };

  /** 右半格的技能格：有名称就是技能，只有占位文字则记录告警。 */
  const readSkillCell = (cell, levelCell) => {
    if (!cell) return;
    const hasSkillTag = /\[skill[:：]/i.test(cell.text);
    const levelText = levelCell ? stripMarkers(levelCell.text) : "";
    const levelMatch = levelText.match(/^(\d+)/);
    const level = levelMatch ? Number(levelMatch[1]) : null;

    if (hasSkillTag) {
      if (!looksLikeSkillLabel(cell.text)) {
        warnings.push(`忽略了人物卡中的占位文本：${cleanName(cell.text)}`);
        return;
      }
      const parsed = parseSkillCell(cell.text);
      addSkill(parsed.name, parsed.label, level ?? parsed.level);
      return;
    }

    const plain = skillCellText(cell.text);
    if (plain === "") {
      // 只有等级、没有名称的孤格：保留顺序编号，便于在预览里定位。
      if (level != null) {
        unnamedSkillCount += 1;
        addSkill(`未命名技能#${unnamedSkillCount}`, "", level);
      }
      return;
    }
    if (!looksLikeSkillLabel(cell.text)) {
      // 有技能标签但不像技能名（例如「+1」）：是卡面占位文字，不当成技能。
      if (hasSkillTag) {
        warnings.push(`忽略了人物卡中的占位文本：${plain}`);
        return;
      }
      warnings.push(`忽略了人物卡中的非技能格：${plain}`);
      return;
    }
    const colonIndex = plain.indexOf("：");
    const label = colonIndex === -1 ? "" : plain.slice(0, colonIndex).trim();
    const name = colonIndex === -1 ? plain : plain.slice(colonIndex + 1).trim();
    addSkill(name, label, level ?? 0);
  };

  for (const row of rows) {
    // 装备行：`[item:名称]` 与部位名、品阶标记分散在同一行的格子里。
    const equipmentEntry = readEquipmentRow(row);
    if (equipmentEntry) {
      equipment.push(equipmentEntry);
      continue;
    }

    const [cellA, cellB, cellC, cellD] = row;
    const nameText = cellA ? stripMarkers(cellA.text) : "";
    const numberCell = cellB && !cellB.colspan ? parseNumberCell(cellB.text) : null;

    if (CHARACTER_CARD_ATTRIBUTE_KEYS[nameText] && numberCell) {
      attributes.push({
        label: nameText,
        key: CHARACTER_CARD_ATTRIBUTE_KEYS[nameText],
        base: numberCell.base,
        trained: numberCell.trained,
      });
    } else if (CARD_DERIVED_LABEL_SET.has(nameText) && numberCell) {
      derived.push({ label: nameText, base: numberCell.base, trained: numberCell.trained });
    } else if (cellA && /\[skill[:：]/i.test(cellA.text)) {
      // 部分卡片把技能写在没有右半格的单侧行里：左格是技能，左格右侧的数值格是训练等级。
      if (!looksLikeSkillLabel(cellA.text)) {
        warnings.push(`忽略了人物卡中的占位文本：${skillCellText(cellA.text)}`);
      } else {
        const parsed = parseSkillCell(cellA.text);
        const levelMatch = stripMarkers(cellB?.text ?? "").match(/^(\d+)/);
        addSkill(parsed.name, parsed.label, levelMatch ? Number(levelMatch[1]) : parsed.level);
      }
    }
    readSkillCell(cellC, cellD);
  }

  if (attributes.length === 0 && skills.length === 0 && equipment.length === 0) {
    throw new Error("人物卡没有可识别的属性、技能或装备");
  }
  return { attributes, derived, skills, equipment, warnings };
}

/** 生成装备跨列格：`[item:名称]!` 加品阶标记。 */
function renderItemCell(name, markerCount) {
  return `[item:${name}]!${NEUTRAL_MARKER.repeat(Math.max(0, markerCount))}`;
}

/**
 * 由角色详情生成 BBCode 人物卡，与 `parseCharacterCard` 互为逆运算。
 *
 * 属性取「基础值 + 装备/技能加持后的生效值」，技能取「基础等级 + 装备/套装加持后的当前等级」；
 * 属性列与技能列分别输出，长度不同时用空格子补齐，与卡面的分组布局一致。
 *
 * @param {object} hero `GET /api/heroes/:id` 的详情（含 attributes、learnableSkills）
 * @param {object[]} [equippedItems] 已穿戴物品，字段来自角色实例的 equippedItems（name/slotId/slotLabel/markerCount）
 * @returns {string}
 */
export function renderCharacterCard(hero, equippedItems = []) {
  const attributes = (hero?.attributes ?? []).map((attribute) => ({
    label: attribute.label,
    base: Number(attribute.base ?? 1),
    trained: Number(attribute.effective ?? attribute.base ?? 1),
  }));
  // 只输出已加点的技能：等级为 0 的技能在卡面上没有意义，作为导入结果也会被忽略。
  const skills = (hero?.learnableSkills ?? [])
    .filter((skill) => Number(skill.currentLevel ?? 0) > 0)
    .map((skill) => {
      const labelMatch = String(skill.name).match(/^([^：:]{1,4})[：:](.+)$/);
      return {
        label: labelMatch ? labelMatch[1] : "",
        name: labelMatch ? labelMatch[2] : String(skill.name),
        level: Number(skill.currentLevel ?? 0),
      };
    });

  const lines = ["[table border=1]"];
  const rowCount = Math.max(attributes.length, skills.length);
  for (let index = 0; index < rowCount; index += 1) {
    const attribute = attributes[index];
    const skill = skills[index];
    lines.push([
      "[tr]",
      `[td]${attribute ? `[color=orange]${attribute.label}[/color]` : ""}[/td]`,
      `[td]${attribute ? `${attribute.base}${attribute.trained != null ? `[${attribute.trained}]` : ""}` : ""}[/td]`,
      `[td]${skill ? `[skill:${skill.label ? `${skill.label}：` : ""}${skill.name}]` : ""}[/td]`,
      `[td]${skill ? String(skill.level) : ""}[/td]`,
      "[/tr]",
    ].join(""));
  }

  const grouped = new Map();
  for (const item of equippedItems) {
    const slotId = String(item.equipSlot ?? item.slotId ?? "").split(":")[0];
    const label = Object.entries(CHARACTER_CARD_SLOT_IDS).find(([, id]) => id === slotId)?.[0] ?? item.slotLabel ?? "物品";
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(item);
  }
  for (const [label, items] of grouped) {
    const numbered = CHARACTER_CARD_REPEATED_SLOTS.includes(label) || items.length > 1;
    items.forEach((item, index) => {
      const slotLabel = numbered ? `${label}#${index + 1}` : label;
      lines.push(`[tr][td][color=orange]${slotLabel}[/color][/td][td colspan=3]${renderItemCell(item.name, Number(item.markerCount ?? 0))}[/td][/tr]`);
    });
  }
  lines.push("[/table]");
  return lines.join("\n");
}
