// 本地战斗模拟场景。地城名称仅用于选择和战报；敌方统一使用固定训练木桩。
// 两个酒吧房间保留跨房间资源、效果及物品次数的验证路径。

const TRAINING_DUMMY = Object.freeze({
  name: "训练木桩",
  kind: "monster",
  level: 3,
  position: "front",
  attributes: { strength: 6, constitution: 6, intelligence: 2, dexterity: 8, charisma: 1, agility: 5, perception: 3, willpower: 2 },
  skills: { "club-strike": { baseLevel: 3 } },
});
const LOCAL_DUMMY_EVIDENCE = "本地固定训练木桩；不代表原版怪物";

const dummyBattle = (id, name = "训练木桩") => ({
  name,
  units: [{ ...TRAINING_DUMMY, id }],
});

export const DUNGEON_ENCOUNTERS = [
  {
    dungeonId: "rowdy-tavern",
    name: "喧嚷的酒吧",
    floorNumber: 1,
    evidence: LOCAL_DUMMY_EVIDENCE,
    battles: [dummyBattle("dummy-1", "训练木桩（一）"), dummyBattle("dummy-2", "训练木桩（二）")],
  },
  {
    dungeonId: "woodland-path",
    name: "林间旧路",
    floorNumber: 1,
    evidence: LOCAL_DUMMY_EVIDENCE,
    battles: [dummyBattle("dummy-1")],
  },
  {
    dungeonId: "crypt-of-ash",
    name: "灰烬墓窟",
    floorNumber: 1,
    evidence: LOCAL_DUMMY_EVIDENCE,
    battles: [dummyBattle("dummy-1")],
  },
];

export const ENCOUNTER_BY_DUNGEON = Object.fromEntries(DUNGEON_ENCOUNTERS.map((entry) => [entry.dungeonId, entry]));

export function encountersForDungeon(dungeonId) {
  return ENCOUNTER_BY_DUNGEON[dungeonId] ?? null;
}

/** 取该地城指定层的战斗列表。 */
export function battlesForFloor(dungeonId, floorNumber = 1) {
  const encounter = encountersForDungeon(dungeonId);
  if (!encounter) return [];
  return encounter.floorNumber === floorNumber ? encounter.battles : [];
}
