// WOD 投点骰池。
//
// 每颗骰子都从 0 开始：Dn 的结果范围是 0..n-1，平均值为 (n-1)/2。
// 目标点数会拆成最多 6 颗主骰和最多 1 颗副骰，骰池的数学期望始终等于目标点数。

function assertPoints(points) {
  if (!Number.isSafeInteger(points) || points < 0) {
    throw new RangeError(`骰池点数必须是非负安全整数: ${points}`);
  }
}

function die(count, sides) {
  return count > 0 ? Object.freeze({ count, sides, minimum: 0, maximum: sides - 1 }) : null;
}

/**
 * 把整数平均值拆成 WOD 骰池。
 *
 * 0..41 点：每 7 点使用一颗 D15，余数 r 使用一颗 D(2r+1)。
 * 42 点起：固定使用 6 颗主骰，每颗平均值为 floor(points / 6)，
 * 余数 r 使用一颗 D(2r+1)。因此副骰最大为 D11。
 */
export function createDicePool(points) {
  assertPoints(points);

  let mainCount;
  let mainMean;
  let remainder;
  if (points < 42) {
    mainCount = Math.floor(points / 7);
    mainMean = 7;
    remainder = points % 7;
  } else {
    mainCount = 6;
    mainMean = Math.floor(points / 6);
    remainder = points % 6;
  }

  const main = die(mainCount, mainMean * 2 + 1);
  const secondary = die(remainder > 0 ? 1 : 0, remainder * 2 + 1);
  return Object.freeze({
    points,
    expected: points,
    minimum: 0,
    maximum: points * 2,
    main,
    secondary,
  });
}

function rollDie(sides, randomStream) {
  if (!randomStream || typeof randomStream.integer !== "function") {
    throw new TypeError("骰池投点需要提供支持 integer(maxExclusive) 的 randomStream");
  }
  return randomStream.integer(sides);
}

/** 投掷已构造的骰池，并返回总点数与逐骰结果。 */
export function rollDicePool(pool, randomStream) {
  if (!pool || !Number.isSafeInteger(pool.points)) {
    throw new TypeError("无效的骰池");
  }

  const main = [];
  for (let index = 0; index < (pool.main?.count ?? 0); index += 1) {
    main.push(rollDie(pool.main.sides, randomStream));
  }
  const secondary = pool.secondary ? rollDie(pool.secondary.sides, randomStream) : null;
  const total = main.reduce((sum, value) => sum + value, 0) + (secondary ?? 0);
  return Object.freeze({ total, main: Object.freeze(main), secondary, pool });
}

/** 构造并投掷指定整数平均值的骰池，只返回总点数。 */
export function rollDice(points, randomStream) {
  return rollDicePool(createDicePool(points), randomStream).total;
}
