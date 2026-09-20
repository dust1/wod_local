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
  battleEnded: "战斗已结束",
});

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
