const VARIABLES = new Set(["summonSkillLevel", "heroLevel", "tier", "summonLevel"]);
const FUNCTIONS = Object.freeze({
  floor: { minArgs: 1, maxArgs: 1, apply: Math.floor },
  ceil: { minArgs: 1, maxArgs: 1, apply: Math.ceil },
  round: { minArgs: 1, maxArgs: 1, apply: Math.round },
  min: { minArgs: 2, maxArgs: 2, apply: Math.min },
  max: { minArgs: 2, maxArgs: 2, apply: Math.max },
  clamp: { minArgs: 3, maxArgs: 3, apply: (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum) },
});

const MAX_EXPRESSION_LENGTH = 500;
const MAX_PARSE_DEPTH = 50;

export class SummonExpressionError extends Error {
  constructor(message, position = null) {
    super(position == null ? message : `${message}（位置 ${position + 1}）`);
    this.name = "SummonExpressionError";
    this.position = position;
  }
}

function tokenize(source) {
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    if (/[0-9.]/u.test(character)) {
      const start = cursor;
      const match = source.slice(cursor).match(/^(?:\d+(?:\.\d*)?|\.\d+)/u);
      if (!match) throw new SummonExpressionError("无效的数字", start);
      cursor += match[0].length;
      if (source[cursor] === ".") throw new SummonExpressionError("无效的数字", cursor);
      tokens.push({ kind: "number", value: Number(match[0]), position: start });
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const start = cursor;
      const match = source.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_]*/u)[0];
      cursor += match.length;
      tokens.push({ kind: "identifier", value: match, position: start });
      continue;
    }
    if ("+-*/(),".includes(character)) {
      tokens.push({ kind: character, value: character, position: cursor });
      cursor += 1;
      continue;
    }
    throw new SummonExpressionError(`不支持的字符“${character}”`, cursor);
  }
  tokens.push({ kind: "end", value: "", position: source.length });
  return tokens;
}

export function parseSummonExpression(expression) {
  if (typeof expression !== "string") throw new SummonExpressionError("表达式必须是字符串");
  const source = expression.trim();
  if (source.length === 0) throw new SummonExpressionError("表达式不能为空");
  if (source.length > MAX_EXPRESSION_LENGTH) throw new SummonExpressionError(`表达式不能超过 ${MAX_EXPRESSION_LENGTH} 个字符`);

  const tokens = tokenize(source);
  let cursor = 0;
  let depth = 0;
  const current = () => tokens[cursor];
  const take = (kind) => {
    const token = current();
    if (token.kind !== kind) throw new SummonExpressionError(`预期“${kind}”`, token.position);
    cursor += 1;
    return token;
  };

  function guarded(parse) {
    depth += 1;
    if (depth > MAX_PARSE_DEPTH) throw new SummonExpressionError(`表达式嵌套不能超过 ${MAX_PARSE_DEPTH} 层`, current().position);
    try {
      return parse();
    } finally {
      depth -= 1;
    }
  }

  function primary() {
    const token = current();
    if (token.kind === "number") {
      cursor += 1;
      return { type: "number", value: token.value };
    }
    if (token.kind === "identifier") {
      cursor += 1;
      if (current().kind !== "(") {
        if (!VARIABLES.has(token.value)) throw new SummonExpressionError(`未知变量“${token.value}”`, token.position);
        return { type: "variable", name: token.value };
      }
      if (!Object.hasOwn(FUNCTIONS, token.value)) throw new SummonExpressionError(`未知函数“${token.value}”`, token.position);
      take("(");
      const args = [];
      if (current().kind !== ")") {
        args.push(guarded(additive));
        while (current().kind === ",") {
          take(",");
          args.push(guarded(additive));
        }
      }
      take(")");
      const definition = FUNCTIONS[token.value];
      if (args.length < definition.minArgs || args.length > definition.maxArgs) {
        throw new SummonExpressionError(`函数“${token.value}”需要 ${definition.minArgs} 个参数`, token.position);
      }
      return { type: "call", name: token.value, args };
    }
    if (token.kind === "(") {
      take("(");
      const value = guarded(additive);
      take(")");
      return value;
    }
    throw new SummonExpressionError("预期数字、变量、函数或括号", token.position);
  }

  function unary() {
    if (current().kind === "+" || current().kind === "-") {
      const operator = current().kind;
      cursor += 1;
      return { type: "unary", operator, argument: guarded(unary) };
    }
    return primary();
  }

  function multiplicative() {
    let node = unary();
    while (current().kind === "*" || current().kind === "/") {
      const operator = current().kind;
      cursor += 1;
      node = { type: "binary", operator, left: node, right: guarded(unary) };
    }
    return node;
  }

  function additive() {
    let node = multiplicative();
    while (current().kind === "+" || current().kind === "-") {
      const operator = current().kind;
      cursor += 1;
      node = { type: "binary", operator, left: node, right: guarded(multiplicative) };
    }
    return node;
  }

  const ast = guarded(additive);
  if (current().kind !== "end") throw new SummonExpressionError("表达式末尾存在多余内容", current().position);
  return ast;
}

function evaluateNode(node, variables) {
  if (node.type === "number") return node.value;
  if (node.type === "variable") {
    const value = variables[node.name];
    if (!Number.isFinite(value)) throw new SummonExpressionError(`变量“${node.name}”必须是有限数值`);
    return value;
  }
  if (node.type === "unary") {
    const value = evaluateNode(node.argument, variables);
    return node.operator === "-" ? -value : value;
  }
  if (node.type === "binary") {
    const left = evaluateNode(node.left, variables);
    const right = evaluateNode(node.right, variables);
    if (node.operator === "/" && right === 0) throw new SummonExpressionError("表达式不能除以零");
    if (node.operator === "+") return left + right;
    if (node.operator === "-") return left - right;
    if (node.operator === "*") return left * right;
    return left / right;
  }
  const args = node.args.map((argument) => evaluateNode(argument, variables));
  if (node.name === "clamp" && args[1] > args[2]) throw new SummonExpressionError("clamp 的最小值不能大于最大值");
  return FUNCTIONS[node.name].apply(...args);
}

export function evaluateSummonExpression(expression, variables = {}) {
  const ast = typeof expression === "string" ? parseSummonExpression(expression) : expression;
  const result = evaluateNode(ast, variables);
  if (!Number.isFinite(result)) throw new SummonExpressionError("表达式结果必须是有限数值");
  return result;
}

export function validateSummonExpression(expression) {
  try {
    parseSummonExpression(expression);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
