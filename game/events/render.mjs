// 事件 → 中文战报文本。设计文档 §18、§20.1。
// 渲染器不得决定战斗结果，只消费事件。
import { PHASE_LABELS } from "../domain/phases.mjs";
import { isActionLevelFailure } from "../commands/cursor.mjs";

function number(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "number" ? String(value) : String(value);
}

/** 单个事件的展示文本。 */
export function renderEvent(ev) {
  switch (ev.type) {
    case "RoundStarted":
      return { phase: "回合", text: `第 ${ev.round} 回合开始。` };
    case "StatusSnapshot":
      return {
        phase: "状态",
        text: `${ev.side === "defender" ? "防御者" : "进攻者"} ${ev.name}（等级 ${number(ev.level)}，${ev.positionLabel ?? ev.position}）体力 ${number(ev.health)}${ev.resourceLabel ? `，${ev.resourceLabel} ${number(ev.resource)}` : ""}${ev.wounds ? `，${ev.wounds}` : ""}`,
      };
    case "SkillAttempted":
      return { phase: "行动", text: `${ev.actorName} 尝试使用 ${ev.skillName}${ev.manaCost ? `（${number(ev.manaCost)} 法力）` : ""}。` };
    case "SkillFailed":
      // 行动级失败没有具体技能调用，直接渲染成「{角色名} {失败文案}」。
      return isActionLevelFailure(ev.reason)
        ? { phase: "行动", text: `${ev.actorName} ${ev.reasonLabel ?? ev.reason}。` }
        : { phase: "行动", text: `${ev.actorName} 使用 ${ev.skillName} 失败：${ev.reasonLabel ?? ev.reason}。` };
    case "ResourceSpent":
      return { phase: "消耗", text: `${ev.actorName} 消耗 ${number(ev.amount)} ${ev.resourceLabel ?? "法力"}。` };
    case "ResourceChanged":
      return { phase: PHASE_LABELS[ev.phase] ?? "回复", text: `${ev.actorName} ${ev.delta >= 0 ? "恢复" : "流失"} ${number(Math.abs(ev.delta))} ${ev.resourceLabel ?? "体力"}。` };
    case "InitiativeRolled":
      return { phase: "先攻", text: `${ev.actorName} 投出先攻 ${number(ev.initiative)}${ev.skillName ? `（${ev.skillName}）` : ""}。` };
    case "ActionScheduled":
      return { phase: "先攻", text: `${ev.actorName} 先攻 ${number(ev.initiative)}，第 ${ev.ordinal} 步行动 / 共 ${ev.totalActions} 步。` };
    case "ActionWaited":
      return { phase: "行动", text: `${ev.actorName} 干等。` };
    case "TargetSelected":
      return { phase: "目标", text: `${ev.actorName} 选择了 ${ev.targetName}。` };
    case "AttackRolled":
      return { phase: "判定", text: `${ev.actorName} 命中投点 ${number(ev.hit)}，${ev.targetName} 闪避投点 ${number(ev.evade)}。` };
    case "AttackResolved":
      return { phase: "判定", text: `${ev.actorName} 对 ${ev.targetName} 的攻击结果为${ev.grade}。` };
    case "DamageApplied":
      return { phase: "伤害", text: `${ev.targetName} 受到 ${number(ev.amount)} 点伤害${ev.damageType ? `（${ev.damageType}）` : ""}，剩余体力 ${number(ev.healthAfter)}。` };
    case "HealingApplied":
      return { phase: "治疗", text: `${ev.targetName} 恢复 ${number(ev.amount)} 点体力，当前 ${number(ev.healthAfter)}。` };
    case "EffectApplied":
      return { phase: "效果", text: `${ev.targetName} 获得效果 ${ev.effectName}${ev.durationLabel ? `（${ev.durationLabel}）` : ""}。` };
    case "EffectActivationChanged":
      return { phase: "效果", text: `${ev.targetName} 的效果 ${ev.effectName} 开始生效。` };
    case "EffectExpired":
      return { phase: "效果", text: `${ev.targetName} 的效果 ${ev.effectName} 结束。` };
    case "SummonCreated":
      return { phase: "召唤", text: `${ev.actorName} 召唤了 ${ev.summonName}。` };
    case "SummonDismissed":
      return { phase: "召唤", text: `${ev.summonName} 消失了（${ev.reasonLabel ?? ev.reason}）。` };
    case "ItemChargeSpent":
      return { phase: "物品", text: `${ev.itemName} 剩余次数 ${number(ev.chargesAfter)}。` };
    case "ItemDamaged":
      return { phase: "物品", text: `${ev.itemName} 耐久度降至 ${number(ev.durabilityAfter)}。` };
    case "UnitDefeated":
      return { phase: "结算", text: `${ev.unitName} 被击倒。` };
    case "UnitEscaped":
      return { phase: "结算", text: `${ev.unitName} 逃离了战斗。` };
    case "BattleEnded":
      return { phase: "结算", text: `战斗结束：${ev.resultLabel ?? ev.result}。` };
    case "LevelEnded":
      return { phase: "结算", text: `第 ${ev.level} 层完成。` };
    case "DungeonEnded":
      return { phase: "结算", text: `地城结束：${ev.resultLabel ?? ev.result}。` };
    default:
      return { phase: "事件", text: JSON.stringify(ev) };
  }
}

/** 渲染整个事件序列。 */
export function renderEvents(events) {
  return events.map(renderEvent);
}

/** 渲染为纯文本，供 CLI 与测试快照使用。 */
export function renderEventsToText(events) {
  return renderEvents(events)
    .map((row) => `[${row.phase}] ${row.text}`)
    .join("\n");
}
