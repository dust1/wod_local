// 客户端只做展示文本拼装，不参与任何战斗判定。
import { isActionLevelFailure } from "../../../game/commands/cursor.mjs";

export function renderOne(event) {
  const map = {
    RoundStarted: `第 ${event.round} 回合开始。`,
    StatusSnapshot: `${event.sideLabel ?? ""} ${event.name}（等级 ${event.level}，${event.positionLabel}）体力 ${event.health}/${event.healthMax}，${event.resourceLabel} ${event.resource}，${event.wounds}`,
    SkillAttempted: `${event.actorName} 尝试使用 ${event.skillName}。`,
    // 行动级失败没有具体技能调用，直接显示「{角色名} {失败文案}」。
    SkillFailed: isActionLevelFailure(event.reason)
      ? `${event.actorName} ${event.reasonLabel ?? event.reason}。`
      : `${event.actorName} 使用 ${event.skillName} 失败：${event.reasonLabel ?? event.reason}。`,
    ResourceSpent: `${event.actorName} 消耗 ${event.amount} ${event.resourceLabel ?? "法力"}。`,
    ResourceChanged: `${event.actorName} ${event.delta >= 0 ? "恢复" : "流失"} ${Math.abs(event.delta)} ${event.resourceLabel ?? "体力"}。`,
    InitiativeRolled: `${event.actorName} 投出先攻 ${event.initiative}${event.skillName ? `（${event.skillName}）` : ""}。`,
    ActionScheduled: `${event.actorName} 先攻 ${event.initiative}，第 ${event.ordinal} 步行动 / 共 ${event.totalActions} 步。`,
    ActionWaited: `${event.actorName} 干等。`,
    TargetSelected: `${event.actorName} 选择了 ${event.targetName}。`,
    AttackRolled: `${event.actorName} 命中投点 ${event.hit}，${event.targetName} 闪避投点 ${event.evade}。`,
    AttackResolved: `${event.actorName} 对 ${event.targetName} 的攻击结果为${event.grade}。`,
    DamageApplied: `${event.targetName} 受到 ${event.amount} 点伤害（${event.damageType}），剩余体力 ${event.healthAfter}。`,
    HealingApplied: `${event.targetName} 恢复 ${event.amount} 点体力，当前 ${event.healthAfter}。`,
    EffectApplied: `${event.targetName} 获得效果 ${event.effectName}${event.state === "pending" ? "（延迟生效）" : ""}。`,
    EffectActivationChanged: `${event.targetName} 的效果 ${event.effectName} 开始生效。`,
    EffectExpired: `${event.targetName} 的效果 ${event.effectName} 结束。`,
    SummonCreated: `${event.actorName} 召唤了 ${event.summonName}${event.joinsThisRound ? "（参加当前回合）" : "（下回合加入）"}。`,
    SummonDismissed: `${event.summonName} 消失了（${event.reasonLabel ?? event.reason}）。`,
    UnitDefeated: `${event.unitName} 被击倒。`,
    BattleEnded: `战斗结束：${event.resultLabel ?? event.result}。`,
  };
  return map[event.type] ?? JSON.stringify(event);
}
