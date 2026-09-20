// 回放信封与确定性校验。设计文档 §5、§21、§24.1。
// 同一规则版本、内容版本、输入快照和随机种子必须产生完全相同的事件序列。

/** 稳定序列化：对象键排序，保证跨调用一致。 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/** FNV-1a 32 位哈希，转 8 位十六进制。 */
export function stableHash(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 战斗初始快照哈希。只包含影响结果的输入，不包含时间戳。
 */
export function hashInputSnapshot(snapshot) {
  return stableHash({
    units: (snapshot.units ?? []).map((unit) => ({
      id: unit.id,
      name: unit.name,
      side: unit.side,
      kind: unit.kind,
      level: unit.level,
      position: unit.position,
      attributes: unit.attributes,
      skills: unit.skills,
      health: unit.health,
      mana: unit.mana,
      healthRegeneration: unit.healthRegeneration,
      manaRegeneration: unit.manaRegeneration,
      actionsPerRoundExact: unit.actionsPerRoundExact,
      initiativeBonus: unit.initiativeBonus,
    })),
    battlePlans: snapshot.battlePlans ?? {},
    skills: snapshot.skillIds ?? [],
  });
}

export function createReplayEnvelope({ battleId, rulesetVersion, contentVersion, randomAlgorithmVersion, seed, inputSnapshotHash, events }) {
  return {
    battleId,
    rulesetVersion,
    contentVersion,
    randomAlgorithmVersion,
    seed: String(seed),
    inputSnapshotHash,
    eventCount: events.length,
    eventsHash: stableHash(events),
    events,
  };
}

/** 校验重放结果是否与信封一致。 */
export function verifyReplay(envelope, events) {
  const expected = envelope.eventsHash;
  const actual = stableHash(events);
  return {
    ok: expected === actual,
    expected,
    actual,
    eventCount: events.length,
    expectedEventCount: envelope.eventCount,
  };
}
