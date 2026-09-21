// 指令游标与重复模式。设计文档 §17.3。
//
// normal             本次尝试结束后推进到下一条
// oncePerBattle      每场战斗最多成功执行一次
// repeatWhilePossible 只要可执行就保持在当前指令；不可执行时跳到下一条，
//                     直到下次循环重新到达才再次尝试
// 到序列末尾后回到第一条继续循环。
//
// “尝试失败是否消耗行动”对不同失败原因可能不同，当前资料没有完整定义，
// 因此返回结构化失败原因并由规则策略决定（FailureCostPolicy）。
//
// 注意：引擎在调用技能**之前**就会做预检（同源效果仍在生效、法力不足等）。
// 预检不通过的指令根本不会发起调用，用 skip() 推进游标即可，不经过失败策略；
// 失败策略只用于真正执行过、但结果失败的指令。
//
// 主回合的一次行动最多检查一整圈指令（`commands.length` 步）：
//   - 中途找到能执行的指令 → 按它执行，本次行动结束；
//   - 一整圈都没有任何指令能执行（预检跳过、没有合法目标、一次性已用尽……）
//     → 本次行动判定为失败（noUsableCommand「无法执行任何行动」）并消耗行动点。
// “一整圈”的次数由调用方的循环统计：游标可能从中途开始，本身无法只凭
// 是否绕过末尾判断一整圈是否走完，因此不放在 skip() 里。

import { WAIT_COMMAND_SKILL_ID } from "./battle-plan.mjs";

export const FAILURE_REASONS = Object.freeze([
  "noTargets",
  "skillNotLearned",
  "insufficientMana",
  "missingItem",
  "missingSummonDefinition",
  "sameSourceActive",
  "oncePerBattleExhausted",
  "noCharges",
  "cannotUseTiming",
  "noCommands",
  "noUsableCommand",
  "battleEnded",
]);

export const FAILURE_REASON_LABELS = Object.freeze({
  noTargets: "没有合法目标",
  skillNotLearned: "未学会该技能",
  insufficientMana: "法力不足",
  missingItem: "缺少所需物品",
  missingSummonDefinition: "没有匹配技能等级和调用物品的召唤物配置",
  sameSourceActive: "同源效果仍在生效",
  oncePerBattleExhausted: "本场战斗已使用过",
  noCharges: "没有剩余次数",
  cannotUseTiming: "该阶段不能使用",
  noCommands: "没有配置指令",
  noUsableCommand: "无法执行任何行动",
  battleEnded: "战斗已结束",
});

/**
 * 行动级失败原因：这些失败描述的是「这次行动整体没做成」，
 * 而不是某一次技能调用的结果，因此战报把它们渲染成
 * 「{角色名称} {失败文案}」这一行（不显示技能、物品与目标）。
 */
export const ACTION_LEVEL_FAILURE_REASONS = Object.freeze(["noCommands", "noUsableCommand"]);

export function isActionLevelFailure(reason) {
  return ACTION_LEVEL_FAILURE_REASONS.includes(reason);
}

/**
 * 失败代价策略：未定义的部分全部显式标注为实验性。
 * 默认：结构性失败（无目标、无指令、战斗结束）不消耗行动，其余消耗。
 */
export const defaultFailureCostPolicy = Object.freeze({
  id: "default-failure-cost",
  experimental: true,
  consumesAction(reason) {
    return !["noTargets", "noCommands", "battleEnded", "oncePerBattleExhausted"].includes(reason);
  },
});

export class CommandCursor {
  #commands;
  #index = 0;
  #successes = new Map();
  #attempts = 0;
  #wrapped = 0;

  constructor(commands = [], options = {}) {
    this.#commands = commands;
    this.failureCostPolicy = options.failureCostPolicy ?? defaultFailureCostPolicy;
  }

  get commands() {
    return this.#commands;
  }

  get index() {
    return this.#index;
  }

  get attempts() {
    return this.#attempts;
  }

  get wrapped() {
    return this.#wrapped;
  }

  get exhausted() {
    return this.#commands.length === 0;
  }

  current() {
    return this.#commands[this.#index] ?? null;
  }

  successCount(commandId) {
    return this.#successes.get(commandId) ?? 0;
  }

  /** 该指令当前是否还能被尝试。 */
  isExecutable(command) {
    if (!command) return { executable: false, reason: "noCommands" };
    if (command.repeat === "oncePerBattle" && this.successCount(command.id) > 0) {
      return { executable: false, reason: "oncePerBattleExhausted" };
    }
    return { executable: true };
  }

  /**
   * 记录一次尝试结果并推进游标。
   * @param {object} result { ok: boolean, reason?: string }
   * @returns {{ advanced: boolean, consumedAction: boolean, reason?: string }}
   */
  record(result = {}) {
    const command = this.current();
    this.#attempts += 1;
    if (result.ok) {
      const id = command?.id ?? "unknown";
      this.#successes.set(id, this.successCount(id) + 1);
      // repeatWhilePossible：成功就保持在当前指令
      const stay = command?.repeat === "repeatWhilePossible";
      if (!stay) this.#advance();
      return { advanced: !stay, consumedAction: true };
    }

    const reason = result.reason ?? "noTargets";
    const consumedAction = this.failureCostPolicy.consumesAction(reason);
    // 失败一律跳到下一条；normal 与 repeatWhilePossible 的差别体现在成功分支
    this.#advance();
    return { advanced: true, consumedAction, reason };
  }

  /**
   * 预检不通过、根本没有发起调用的指令：只推进游标，不消耗行动，也不计入尝试次数。
   *
   * 用于「同源效果仍在生效」「法力不足」这类可以顺位到下一条指令的空操作；
   * 与 record({ ok: false }) 的区别是不走失败代价策略，因此不会误导调用方
   * 把这次跳过当成一次失败的尝试。
   *
   * @returns {{advanced: true, consumedAction: false}}
   */
  skip() {
    this.#advance();
    return { advanced: true, consumedAction: false };
  }

  #advance() {
    if (this.#commands.length === 0) return;
    this.#index += 1;
    if (this.#index >= this.#commands.length) {
      this.#index = 0;
      this.#wrapped += 1;
    }
  }

  /** 供存档使用。 */
  snapshot() {
    return {
      index: this.#index,
      attempts: this.#attempts,
      wrapped: this.#wrapped,
      successes: Object.fromEntries(this.#successes),
    };
  }

  restore(snapshot) {
    this.#index = snapshot.index ?? 0;
    this.#attempts = snapshot.attempts ?? 0;
    this.#wrapped = snapshot.wrapped ?? 0;
    this.#successes = new Map(Object.entries(snapshot.successes ?? {}));
  }
}

/**
 * 把设置指令解释为可执行序列。
 * 治疗技能不能作为普通主动指令直接设置（§8.2），因此这里过滤并报告。
 */
export function interpretMainCommands(commands, skillById) {
  const executable = [];
  const rejected = [];
  for (const command of commands) {
    if (command.skillId === WAIT_COMMAND_SKILL_ID) {
      executable.push(command);
      continue;
    }
    const skill = skillById?.get?.(command.skillId) ?? skillById?.[command.skillId];
    if (!skill) {
      rejected.push({ command, reason: "skillNotLearned" });
      continue;
    }
    if (skill.baseType === "heal") {
      rejected.push({ command, reason: "cannotUseTiming", note: "治疗技能由治疗触发器插入" });
      continue;
    }
    executable.push(command);
  }
  return { executable, rejected };
}
