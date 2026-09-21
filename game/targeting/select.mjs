// 目标候选枚举与选择。设计文档 §8.4、§12.2、§25.12、§25.13。
//
// 规则要点：
// - 同位置 AOE 的所有目标必须来自同一站位；人数不足时不得跨到下一位置补齐。
// - 跨位置 AOE 可以跨站位，但不能超过最大目标数。
// - 候选数量超过上限时教材称为“随机选取”，具体随机方法待验证。
// - 同一站位内的目标排序规则待验证，因此通过策略注入。

import { meleeTargetPriority, POSITION_LABELS } from "../domain/positions.mjs";
import { isMeleeAttackType } from "../domain/positions.mjs";
import { pickDeterministic } from "../policies/random.mjs";

/** 单位是否可被选为目标。 */
export function isSelectable(unit) {
  return unit && unit.alive !== false && unit.present !== false;
}

export function isSummon(unit) {
  return unit?.kind === "summon";
}

/**
 * 按站位把候选分组，组内顺序由 policy 决定。
 */
export function groupByPosition(candidates, options = {}) {
  const policy = options.withinPositionPolicy ?? randomWithinPositionPolicy;
  const groups = new Map();
  for (const unit of candidates) {
    const position = unit.position ?? "front";
    if (!groups.has(position)) groups.set(position, []);
    groups.get(position).push(unit);
  }
  for (const [position, units] of groups) {
    groups.set(position, policy.order(units, { position, ...options }));
  }
  return groups;
}

/** 同一站位内顺序未确认（D 级），默认保持稳定输入顺序。 */
export const stableWithinPositionPolicy = Object.freeze({
  id: "stable-input-order",
  experimental: true,
  order(units) {
    return [...units];
  },
});

/** 实验策略：站位内随机排序。 */
export const randomWithinPositionPolicy = Object.freeze({
  id: "random-within-position",
  experimental: true,
  order(units, context = {}) {
    if (units.length <= 1) return [...units];
    const stream = context.randomStream;
    if (!stream) return [...units];
    const pool = [...units];
    const shuffled = [];
    while (pool.length > 0) {
      const index = stream.integer(pool.length);
      shuffled.push(pool[index]);
      pool.splice(index, 1);
    }
    return shuffled;
  },
});

/** 目标位置优先级：近战固定顺序；非近战由设置指定，缺省用固定顺序。 */
export function targetPositionPriority({ actorPosition, attackType, configuredPriority }) {
  if (Array.isArray(configuredPriority) && configuredPriority.length > 0) return configuredPriority;
  if (isMeleeAttackType(attackType)) return meleeTargetPriority(actorPosition);
  return meleeTargetPriority(actorPosition);
}

/**
 * 枚举候选并按站位分组。
 */
export function enumerateCandidates({ actor, units, spec, attackType, configuredPriority, randomStream, withinPositionPolicy }) {
  const wantedSide = spec?.side ?? "enemy";
  const candidates = units.filter((unit) => {
    if (!isSelectable(unit)) return false;
    // 「己方全体」「同一位置的所有队友」这类**群体**描述都包含施法者本人：
    // 施法者也在那个位置上、也属于“己方”，所以只有他自己在前排时同样成立。
    // 普通单体“队友”（例如治疗单体）仍不把自己列为候选，否则会改成自我治疗。
    if (unit.id === actor.id && !["self", "globalAoE", "samePositionAoE"].includes(spec?.mode)) return false;
    if (wantedSide === "ally" && unit.side !== actor.side) return false;
    if (wantedSide === "enemy" && unit.side === actor.side) return false;
    if (!spec?.allowSummons && isSummon(unit)) return false;
    return true;
  });

  let priority = targetPositionPriority({
    actorPosition: actor.position,
    attackType,
    configuredPriority,
  });
  // 全体技能的站位设置只决定遍历顺序，不能把其他站位的合法单位排除在“全体”之外。
  if (spec?.mode === "globalAoE") {
    priority = [...priority, ...Object.keys(POSITION_LABELS).filter((position) => !priority.includes(position))];
  }

  return {
    candidates,
    priority,
    groups: groupByPosition(candidates, { randomStream, withinPositionPolicy }),
  };
}

/**
 * 选择目标。
 * @returns {{targets: object[], mode: string, position: string|null, truncated: boolean, priority: string[]}}
 */
export function selectTargets(input) {
  const { actor, spec } = input;
  const { candidates, priority, groups } = enumerateCandidates(input);
  const mode = spec?.mode ?? "single";

  if (mode === "self") {
    const self = input.units.find((unit) => unit.id === actor.id) ?? actor;
    return { targets: [self], mode, position: self.position ?? null, truncated: false, priority };
  }

  const maxTargets = spec?.maxTargets ?? 1;

  if (mode === "samePositionAoE") {
    for (const position of priority) {
      const group = groups.get(position);
      if (group && group.length > 0) {
        const targets = group.slice(0, maxTargets);
        return {
          targets,
          mode,
          position,
          truncated: group.length > targets.length,
          priority,
        };
      }
    }
    return { targets: [], mode, position: null, truncated: false, priority };
  }

  if (mode === "globalAoE") {
    const targets = [];
    for (const position of priority) {
      const group = groups.get(position);
      if (!group) continue;
      for (const unit of group) {
        if (targets.length >= maxTargets) break;
        targets.push(unit);
      }
      if (targets.length >= maxTargets) break;
    }
    return {
      targets,
      mode,
      position: targets[0]?.position ?? null,
      truncated: candidates.length > targets.length,
      priority,
    };
  }

  // single
  for (const position of priority) {
    const group = groups.get(position);
    if (group && group.length > 0) {
      const policy = input.withinPositionPolicy ?? randomWithinPositionPolicy;
      const chosen = policy.pick ? policy.pick(group, { randomStream: input.randomStream }) : pickDeterministic(group, input.randomStream ?? { integer: () => 0 });
      return {
        targets: chosen ? [chosen] : [],
        mode: "single",
        position,
        truncated: group.length > 1,
        priority,
      };
    }
  }
  return { targets: [], mode: "single", position: null, truncated: false, priority };
}

/** 供战报展示的候选摘要。 */
export function describeCandidates({ groups }) {
  return [...groups.entries()].map(([position, units]) => ({
    position,
    positionLabel: POSITION_LABELS[position] ?? position,
    names: units.map((unit) => unit.name),
  }));
}
