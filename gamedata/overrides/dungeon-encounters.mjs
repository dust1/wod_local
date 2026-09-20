// 地城遭遇配置。设计文档 §10、§26 里程碑 6。
//
// 证据说明：地城结构（一层多场战斗、同层共用设置、效果边界）来自设计文档 §10；
// 具体怪物数值属于本地演示内容，标注为 unverified，不得当作原版数据。
// 本文件只包含纯数据。

/** @typedef {object} EncounterUnit */
const UNVERIFIED = "unverified: 本地演示数值";

export const DUNGEON_ENCOUNTERS = [
  {
    dungeonId: "rowdy-tavern",
    name: "喧嚷的酒吧",
    floorNumber: 1,
    evidence: UNVERIFIED,
    battles: [
      {
        name: "训练木偶",
        units: [
          {
            id: "tavern-dummy-1",
            name: "训练木偶",
            kind: "monster",
            level: 3,
            position: "front",
            attributes: { strength: 6, constitution: 6, intelligence: 2, dexterity: 8, charisma: 1, agility: 5, perception: 3, willpower: 2 },
            skills: { "club-strike": { baseLevel: 3 } },
          },
        ],
      },
      {
        name: "醉醺醺的雇佣兵",
        units: [
          {
            id: "tavern-merc-1",
            name: "醉醺醺的雇佣兵",
            kind: "monster",
            level: 5,
            position: "front",
            attributes: { strength: 9, constitution: 8, intelligence: 3, dexterity: 9, charisma: 4, agility: 6, perception: 5, willpower: 4 },
            skills: { "club-strike": { baseLevel: 5 } },
          },
          {
            id: "tavern-merc-2",
            name: "酒吧打手",
            kind: "monster",
            level: 4,
            position: "leftWing",
            attributes: { strength: 7, constitution: 7, intelligence: 2, dexterity: 7, charisma: 3, agility: 8, perception: 4, willpower: 3 },
            skills: { "club-strike": { baseLevel: 4 } },
          },
        ],
      },
    ],
  },
  {
    dungeonId: "woodland-path",
    name: "林间旧路",
    floorNumber: 1,
    evidence: UNVERIFIED,
    battles: [
      {
        name: "林狼群",
        units: [
          {
            id: "wolf-1",
            name: "林狼",
            kind: "monster",
            level: 9,
            position: "front",
            attributes: { strength: 10, constitution: 9, intelligence: 2, dexterity: 12, charisma: 2, agility: 14, perception: 10, willpower: 4 },
            skills: { "familiar-bite": { baseLevel: 6 } },
          },
          {
            id: "wolf-2",
            name: "灰毛林狼",
            kind: "monster",
            level: 9,
            position: "leftWing",
            attributes: { strength: 9, constitution: 9, intelligence: 2, dexterity: 11, charisma: 2, agility: 13, perception: 9, willpower: 4 },
            skills: { "familiar-bite": { baseLevel: 6 } },
          },
        ],
      },
    ],
  },
  {
    dungeonId: "crypt-of-ash",
    name: "灰烬墓窟",
    floorNumber: 1,
    evidence: UNVERIFIED,
    battles: [
      {
        name: "灰烬骸骨",
        units: [
          {
            id: "skeleton-1",
            name: "灰烬骸骨",
            kind: "monster",
            level: 17,
            position: "front",
            attributes: { strength: 14, constitution: 13, intelligence: 3, dexterity: 12, charisma: 1, agility: 10, perception: 8, willpower: 6 },
            skills: { "club-strike": { baseLevel: 10 } },
          },
          {
            id: "skeleton-2",
            name: "墓窟守卫",
            kind: "monster",
            level: 18,
            position: "center",
            attributes: { strength: 15, constitution: 15, intelligence: 4, dexterity: 10, charisma: 1, agility: 8, perception: 9, willpower: 8 },
            skills: { "club-strike": { baseLevel: 12 } },
          },
        ],
      },
    ],
  },
];

export const ENCOUNTER_BY_DUNGEON = Object.fromEntries(DUNGEON_ENCOUNTERS.map((entry) => [entry.dungeonId, entry]));

export function encountersForDungeon(dungeonId) {
  return ENCOUNTER_BY_DUNGEON[dungeonId] ?? null;
}

/** 取该地城指定层的战斗列表；缺省用第一个配置。 */
export function battlesForFloor(dungeonId, floorNumber = 1) {
  const encounter = encountersForDungeon(dungeonId);
  if (!encounter) return [];
  return encounter.floorNumber === floorNumber ? encounter.battles : [];
}
