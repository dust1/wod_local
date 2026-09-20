// 依赖为零的 HTML 扫描工具。设计文档 §19.1 / §19.2。
//
// 所有函数都基于索引扫描（indexOf / 字符循环），不使用覆盖整个文档的正则，
// 因此对 8 MB 级战报不会出现灾难性回溯。
// 本模块只处理字符串，不依赖 DOM、React、网络或数据库。

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// 内容不会被解析为标签的元素。
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
  ["ensp", "\u2002"],
  ["emsp", "\u2003"],
  ["thinsp", "\u2009"],
  ["shy", "\u00ad"],
  ["copy", "\u00a9"],
  ["reg", "\u00ae"],
  ["trade", "\u2122"],
  ["hellip", "\u2026"],
  ["mdash", "\u2014"],
  ["ndash", "\u2013"],
  ["middot", "\u00b7"],
  ["times", "\u00d7"],
  ["divide", "\u00f7"],
  ["plusmn", "\u00b1"],
  ["deg", "\u00b0"],
  ["laquo", "\u00ab"],
  ["raquo", "\u00bb"],
  ["lsaquo", "\u2039"],
  ["rsaquo", "\u203a"],
  ["ldquo", "\u201c"],
  ["rdquo", "\u201d"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["bull", "\u2022"],
  ["dagger", "\u2020"],
  ["prime", "\u2032"],
  ["Prime", "\u2033"],
  ["larr", "\u2190"],
  ["rarr", "\u2192"],
  ["uarr", "\u2191"],
  ["darr", "\u2193"],
  ["le", "\u2264"],
  ["ge", "\u2265"],
  ["ne", "\u2260"],
  ["sup1", "\u00b9"],
  ["sup2", "\u00b2"],
  ["sup3", "\u00b3"],
  ["frac12", "\u00bd"],
  ["frac14", "\u00bc"],
  ["frac34", "\u00be"],
  ["sect", "\u00a7"],
  ["para", "\u00b6"],
  ["euro", "\u20ac"],
  ["pound", "\u00a3"],
  ["yen", "\u00a5"],
  ["cent", "\u00a2"],
  ["micro", "\u00b5"],
  ["sdot", "\u22c5"],
]);

export const VOID_ELEMENT_SET = VOID_ELEMENTS;
export const RAW_TEXT_ELEMENT_SET = RAW_TEXT_ELEMENTS;

export function isVoidElement(name) {
  return VOID_ELEMENTS.has(String(name).toLowerCase());
}

export function isRawTextElement(name) {
  return RAW_TEXT_ELEMENTS.has(String(name).toLowerCase());
}

/** 解码 HTML 实体（命名实体 + 十进制 + 十六进制）。未知实体原样保留。 */
export function decodeEntities(text) {
  if (typeof text !== "string" || text.indexOf("&") === -1) return text;
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES.get(body);
    return named === undefined ? match : named;
  });
}

/**
 * 从 `from` 开始找到当前标签的 `>`（跳过引号内的 `>`）。
 * @returns {number} `>` 的下标；未找到返回 -1。
 */
export function findTagEnd(html, from) {
  let i = from;
  const length = html.length;
  while (i < length) {
    const ch = html.charCodeAt(i);
    if (ch === 62 /* > */) return i;
    if (ch === 34 /* " */) {
      const close = html.indexOf('"', i + 1);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    if (ch === 39 /* ' */) {
      const close = html.indexOf("'", i + 1);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * 解析一个标签（不含前后文本）。
 * @param {string} html
 * @param {number} tagStart `<` 的下标
 * @returns {{isEnd:boolean,name:string,selfClosing:boolean,tagStart:number,tagEnd:number,raw:string}|null}
 */
export function parseTagAt(html, tagStart) {
  if (html.charCodeAt(tagStart) !== 60 /* < */) return null;
  let i = tagStart + 1;
  let isEnd = false;
  if (html.charCodeAt(i) === 47 /* / */) {
    isEnd = true;
    i += 1;
  }
  if (!isEnd && (html.charCodeAt(i) === 33 /* ! */ || html.charCodeAt(i) === 63 /* ? */)) return null;
  const nameStart = i;
  while (i < html.length) {
    const code = html.charCodeAt(i);
    // 字母、数字、-、:、_
    const isNameChar =
      (code >= 97 && code <= 122) ||
      (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) ||
      code === 45 ||
      code === 58 ||
      code === 95;
    if (!isNameChar) break;
    i += 1;
  }
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();
  const tagEnd = findTagEnd(html, i);
  if (tagEnd < 0) return null;
  let cursor = tagEnd - 1;
  while (cursor > i && /\s/.test(html[cursor])) cursor -= 1;
  const selfClosing = html[cursor] === "/";
  return { isEnd, name, selfClosing, tagStart, tagEnd: tagEnd + 1, raw: html.slice(tagStart, tagEnd + 1) };
}

/**
 * 解析标签属性。属性名统一小写，值解码实体；无值属性为 ""。
 * @param {string} tagHtml
 * @returns {{name:string, attrs:Record<string,string>}}
 */
export function parseAttributes(tagHtml) {
  const attrs = Object.create(null);
  if (typeof tagHtml !== "string") return { name: "", attrs };
  let i = 1;
  if (tagHtml[0] !== "<") {
    const first = tagHtml.indexOf("<");
    if (first < 0) return { name: "", attrs };
    i = first + 1;
  }
  if (tagHtml[i] === "/") i += 1;
  let nameEnd = i;
  while (nameEnd < tagHtml.length && /[^\s/>]/.test(tagHtml[nameEnd])) nameEnd += 1;
  const name = tagHtml.slice(i, nameEnd).toLowerCase();
  i = nameEnd;
  const length = tagHtml.length;
  while (i < length) {
    while (i < length && /\s/.test(tagHtml[i])) i += 1;
    if (i >= length) break;
    if (tagHtml[i] === ">" || (tagHtml[i] === "/" && tagHtml[i + 1] === ">")) break;
    const attrStart = i;
    while (i < length && !/[\s=/>]/.test(tagHtml[i])) i += 1;
    const attrName = tagHtml.slice(attrStart, i).toLowerCase();
    if (!attrName) {
      i += 1;
      continue;
    }
    while (i < length && /\s/.test(tagHtml[i])) i += 1;
    let value = "";
    if (tagHtml[i] === "=") {
      i += 1;
      while (i < length && /\s/.test(tagHtml[i])) i += 1;
      const quote = tagHtml[i];
      if (quote === '"' || quote === "'") {
        const close = tagHtml.indexOf(quote, i + 1);
        value = close < 0 ? tagHtml.slice(i + 1) : tagHtml.slice(i + 1, close);
        i = close < 0 ? length : close + 1;
      } else {
        const valueStart = i;
        while (i < length && !/[\s>]/.test(tagHtml[i])) i += 1;
        value = tagHtml.slice(valueStart, i);
      }
    }
    attrs[attrName] = decodeEntities(value);
  }
  return { name, attrs };
}

/** 标签的 class 列表。 */
export function classList(tagHtml) {
  const raw = typeof tagHtml === "string" && tagHtml.startsWith("<")
    ? (parseAttributes(tagHtml).attrs.class ?? "")
    : String(tagHtml ?? "");
  return raw.split(/\s+/).filter(Boolean);
}

/** 标签是否包含某个 class。 */
export function hasClass(tagHtml, className) {
  return classList(tagHtml).includes(className);
}

/** 元素是否被隐藏（display:none 或 hidden 属性）。 */
export function isHiddenTag(tagHtml) {
  const { attrs } = parseAttributes(tagHtml);
  if ("hidden" in attrs) return true;
  const style = (attrs.style ?? "").replace(/\s+/g, "").toLowerCase();
  return style.includes("display:none");
}

/**
 * 遍历文档标签与文本。
 * @param {string} html
 * @param {number} [from]
 * @param {number} [to]
 * @returns {Generator<{kind:"startTag"|"endTag"|"comment"|"decl"|"text",start:number,end:number,name?:string,raw?:string,selfClosing?:boolean}>}
 */
export function* scanTokens(html, from = 0, to = html.length) {
  let i = from;
  while (i < to) {
    const lt = html.indexOf("<", i);
    if (lt < 0 || lt >= to) {
      if (i < to) yield { kind: "text", start: i, end: to };
      return;
    }
    if (lt > i) yield { kind: "text", start: i, end: lt };
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      const end = close < 0 ? to : close + 3;
      yield { kind: "comment", start: lt, end };
      i = end;
      continue;
    }
    const next = html[lt + 1];
    if (next === "!" || next === "?") {
      const gt = findTagEnd(html, lt + 1);
      const end = gt < 0 ? to : gt + 1;
      yield { kind: "decl", start: lt, end };
      i = end;
      continue;
    }
    const tag = parseTagAt(html, lt);
    if (!tag) {
      // 非法 `<`，按文本跳过，避免死循环。
      yield { kind: "text", start: lt, end: lt + 1 };
      i = lt + 1;
      continue;
    }
    yield {
      kind: tag.isEnd ? "endTag" : "startTag",
      start: tag.tagStart,
      end: tag.tagEnd,
      name: tag.name,
      raw: tag.raw,
      selfClosing: tag.selfClosing,
    };
    i = tag.tagEnd;
    if (!tag.isEnd && !tag.selfClosing && isRawTextElement(tag.name)) {
      const close = html.toLowerCase().indexOf(`</${tag.name}`, i);
      if (close < 0) return;
      const gt = findTagEnd(html, close + 2);
      const end = gt < 0 ? to : gt + 1;
      yield { kind: "text", start: i, end: close };
      const closeTag = parseTagAt(html, close);
      yield {
        kind: "endTag",
        start: close,
        end,
        name: tag.name,
        raw: closeTag ? closeTag.raw : html.slice(close, end),
      };
      i = end;
    }
  }
}

/**
 * 计算某个起始标签对应元素的结束下标（不包含）。
 * 无匹配闭合标签时返回 `to`。
 */
export function elementEnd(html, tagStart, to = html.length) {
  const tag = parseTagAt(html, tagStart);
  if (!tag || tag.isEnd) return tag ? tag.tagEnd : tagStart;
  if (tag.selfClosing || isVoidElement(tag.name)) return tag.tagEnd;
  const name = tag.name;
  let depth = 1;
  for (const token of scanTokens(html, tag.tagEnd, to)) {
    if (token.kind === "startTag") {
      if (token.name === name && !token.selfClosing && !isVoidElement(name)) depth += 1;
    } else if (token.kind === "endTag" && token.name === name) {
      depth -= 1;
      if (depth === 0) return token.end;
    }
  }
  return to;
}

/**
 * 起始标签对应的元素跨度。
 * @returns {{start:number,end:number,tagStart:number,tagEnd:number,tagHtml:string,name:string,attrs:Record<string,string>}|null}
 */
export function elementSpan(html, tagStart, to = html.length) {
  const tag = parseTagAt(html, tagStart);
  if (!tag || tag.isEnd) return null;
  const { attrs } = parseAttributes(tag.raw);
  return {
    start: tag.tagStart,
    end: elementEnd(html, tagStart, to),
    tagStart: tag.tagStart,
    tagEnd: tag.tagEnd,
    tagHtml: tag.raw,
    name: tag.name,
    attrs,
  };
}

/**
 * 收集满足条件的元素。
 * @param {string} html
 * @param {(token:{name:string,raw:string,attrs:Record<string,string>})=>boolean} predicate
 * @param {{from?:number,to?:number,limit?:number}} [options]
 */
export function findElements(html, predicate, options = {}) {
  const from = options.from ?? 0;
  const to = options.to ?? html.length;
  const limit = options.limit ?? Infinity;
  const found = [];
  for (const token of scanTokens(html, from, to)) {
    if (token.kind !== "startTag") continue;
    const { name, attrs } = parseAttributes(token.raw);
    if (!predicate({ name, raw: token.raw, attrs })) continue;
    found.push(elementSpan(html, token.start, to));
    if (found.length >= limit) break;
  }
  return found;
}

/** 按 class 查找元素。 */
export function findElementsByClass(html, className, options = {}) {
  return findElements(html, (token) => (token.attrs.class ?? "").split(/\s+/).includes(className), options);
}

/** 按 id 查找元素。 */
export function findElementsById(html, id, options = {}) {
  return findElements(html, (token) => token.attrs.id === id, options);
}

/** 按标签名查找元素。 */
export function findElementsByTagName(html, tagName, options = {}) {
  const wanted = String(tagName).toLowerCase();
  return findElements(html, (token) => token.name === wanted, options);
}

/** 去标签但保留文本（不解码实体）。 */
export function stripTags(html) {
  if (typeof html !== "string" || html.indexOf("<") === -1) return html;
  let out = "";
  let cursor = 0;
  for (const token of scanTokens(html)) {
    if (token.kind === "text") continue;
    out += html.slice(cursor, token.start);
    if (token.kind === "comment" || token.kind === "decl") out += " ";
    else if (token.kind === "startTag" && (token.name === "br" || token.name === "hr")) out += " ";
    cursor = token.end;
  }
  out += html.slice(cursor);
  return out;
}

/** 提取文本：去标签、解码实体、压缩空白。 */
export function textContent(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

/** 提取文本但保留换行（用于 tooltip 等保留分行的场景）。 */
export function textContentKeepLines(html) {
  return decodeEntities(
    stripTags(html.replace(/<br\s*\/?>/gi, "\n")).replace(/<hr\s*\/?>/gi, "\n"),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * 统计整个文档中带某 class 的元素个数（只统计双引号 class 属性）。
 * 战报 tooltip 内的 class 使用单引号，因此不会被计入，
 * 这与设计文档 §2.3 的原始节点计数口径一致。
 */
export function countClassNodes(html, className) {
  let count = 0;
  let i = -1;
  const needle = 'class="';
  while ((i = html.indexOf(needle, i + 1)) !== -1) {
    const end = html.indexOf('"', i + needle.length);
    if (end < 0) break;
    const value = html.slice(i + needle.length, end);
    if (value.split(/\s+/).includes(className)) count += 1;
  }
  return count;
}

/** 一次遍历统计多个 class 的节点数。 */
export function countClassNodesMulti(html, classNames) {
  const wanted = new Set(classNames);
  const counts = Object.create(null);
  for (const name of classNames) counts[name] = 0;
  let i = -1;
  const needle = 'class="';
  while ((i = html.indexOf(needle, i + 1)) !== -1) {
    const end = html.indexOf('"', i + needle.length);
    if (end < 0) break;
    const value = html.slice(i + needle.length, end);
    for (const token of value.split(/\s+/)) {
      if (wanted.has(token)) counts[token] += 1;
    }
  }
  return counts;
}

const TRANSPARENT_CONTAINERS = new Set(["html", "head", "body"]);

/**
 * 把文档切成顶层内容区块。
 * `html`/`head`/`body` 视为透明容器，因此返回的是页面真正的内容块序列。
 * @param {string} html
 * @param {{from?:number,to?:number,transparent?:Iterable<string>}} [options]
 * @returns {Array<{kind:"element"|"text"|"comment",start:number,end:number,name?:string,attrs?:Record<string,string>,classes?:string[],id?:string|null,hidden?:boolean}>}
 */
export function splitTopLevelRegions(html, options = {}) {
  const from = options.from ?? 0;
  const to = options.to ?? html.length;
  const transparent = options.transparent ? new Set(options.transparent) : TRANSPARENT_CONTAINERS;
  const regions = [];
  const stack = [];
  for (const token of scanTokens(html, from, to)) {
    if (token.kind === "text" || token.kind === "comment" || token.kind === "decl") {
      if (stack.length === 0 && token.end > token.start) {
        regions.push({ kind: token.kind === "text" ? "text" : "comment", start: token.start, end: token.end });
      }
      continue;
    }
    if (token.kind === "endTag") {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i] === token.name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const isVoid = token.selfClosing || isVoidElement(token.name);
    const isTransparent = transparent.has(token.name);
    if (stack.length === 0 && !isTransparent) {
      const { attrs } = parseAttributes(token.raw);
      const span = elementSpan(html, token.start, to);
      regions.push({
        kind: "element",
        start: span.start,
        end: span.end,
        name: token.name,
        attrs,
        classes: (attrs.class ?? "").split(/\s+/).filter(Boolean),
        id: attrs.id ?? null,
        hidden: isHiddenTag(token.raw),
      });
    }
    if (!isVoid && !isTransparent) stack.push(token.name);
  }
  return regions;
}
