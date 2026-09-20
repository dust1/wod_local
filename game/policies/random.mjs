// 确定性随机数：同一 seed 必须产生完全相同的序列。设计文档 §5、§13.5、§21。

/** FNV-1a 32 位哈希，把字符串种子映射为 uint32。 */
export function hashSeed(seed) {
  const text = String(seed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32：小、快、可移植，跨平台位运算结果一致。
 * 不使用系统时间，因此满足公式层“不得读取系统时间”的约束。
 */
export function createRandomStream(seed) {
  let state = hashSeed(seed);
  let draws = 0;
  return {
    seed: String(seed),
    get draws() {
      return draws;
    },
    /** 返回 [0, 1) 的均匀浮点数。 */
    next() {
      draws += 1;
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    },
    /** 返回 [min, max) 的均匀浮点数。 */
    between(min, max) {
      return min + this.next() * (max - min);
    },
    /** 返回 [0, maxExclusive) 的整数。 */
    integer(maxExclusive) {
      return Math.floor(this.next() * maxExclusive);
    },
    snapshot() {
      return { seed: String(seed), state, draws };
    },
    restore(snapshot) {
      state = snapshot.state >>> 0;
      draws = snapshot.draws;
    },
  };
}

/** 从候选数组中确定性地挑一个（目标随机选择算法待验证，文档 §25.12）。 */
export function pickDeterministic(items, stream) {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];
  return items[stream.integer(items.length)];
}
