import { useMemo, useState } from "react";
import { WodButton } from "../../components/ui.jsx";
import { isActionLevelFailure } from "../../../game/commands/cursor.mjs";

const EFFECT_TARGET_LABELS = {
  strength: "力量", constitution: "体质", intelligence: "智力", dexterity: "灵巧",
  charisma: "魅力", agility: "敏捷", perception: "感知", willpower: "意志",
  healthMax: "体力", manaMax: "法力", healthRegeneration: "体力回复", manaRegeneration: "法力回复",
  initiative: "先攻权", actionsPerRound: "每回合行动次数", fame: "荣誉", allianceFame: "联盟荣誉",
};

function effectTargetLabel(target) {
  if (target?.label) return target.label;
  const key = target?.key ?? target?.type ?? "效果";
  if (EFFECT_TARGET_LABELS[key]) return EFFECT_TARGET_LABELS[key];
  return key;
}

function effectText(effects = []) {
  if (effects.length === 0) return "没有可用的目标 Buff 快照";
  return effects.map((effect) => {
    const values = (effect.values ?? []).map((value) => {
      const target = effectTargetLabel(value.target);
      const suffix = value.kind === "percent" || value.kind === "globalPercent" ? "%" : "";
      const resolvedValue = ["scaledFlat", "scaledPercent", "randomFlat"].includes(value.kind) && Number.isFinite(Number(value.value))
        ? Math.floor(Number(value.value))
        : value.value ?? "—";
      return `${target} ${resolvedValue}${suffix}`;
    }).join("，");
    return `${effect.name ?? "效果"}${values ? `：${values}` : ""}`;
  }).join("\n");
}
const ITEM_EFFECT_LABELS = {
  "对技能等级的奖励": "技能等级奖励",
};

function effectActivationText(activation) {
  if (activation?.kind === "nextRound") return "1个回合后生效";
  if (activation?.kind === "afterRounds") return `${Number(activation.value ?? 0)}个回合后生效`;
  return "";
}

function groupedEffectText(effects = []) {
  if (effects.length === 0) return "无";
  const groups = new Map();
  for (const effect of effects) {
    const label = ITEM_EFFECT_LABELS[effect.name] ?? effect.name ?? "效果";
    if (!groups.has(label)) groups.set(label, []);
    const activation = effectActivationText(effect.activation);
    const values = (effect.values ?? []).map((value) => {
      const target = effectTargetLabel(value.target);
      const suffix = value.kind === "percent" || value.kind === "globalPercent" ? "%" : "";
      const resolvedValue = ["scaledFlat", "scaledPercent", "randomFlat"].includes(value.kind) && Number.isFinite(Number(value.value))
        ? Math.floor(Number(value.value))
        : value.value ?? "—";
      return `${target} ${resolvedValue}${suffix}${activation ? ` ${activation}` : ""}`;
    });
    groups.get(label).push(...(values.length > 0 ? values : [activation || "—"]));
  }
  return [...groups].map(([label, lines]) => `${label}：\n${lines.join("\n")}`).join("\n");
}

function itemEffectText(item) {
  return `物品的效果：\n${groupedEffectText(item.itemEffects)}\n----\n\n套装的效果：\n${groupedEffectText(item.setEffects)}`;
}

function costText(costs = []) {
  return costs.map((cost) => `${cost.amount} ${cost.resourceLabel ?? (cost.resource === "health" ? "体力" : "法力")}`).join(",");
}

const HIT_GRADE_CLASS_BY_LABEL = { 闪避: "miss", 命中: "hit", 重击: "heavy", 致命一击: "critical" };

/** 判定骰与伤害数值缺失时显示占位符，避免战报出现 undefined。 */
function displayNumber(value) {
  return value === undefined || value === null ? "—" : String(value);
}

/**
 * 一次行动对单个目标的结果：命中等级、双方判定骰、伤害与治疗。
 *
 * 这些数值由 game/events/display-report.mjs 在结算时固化进快照，
 * 渲染层只负责把它们展示出来，不参与任何判定。
 */
function TargetOutcome({ target }) {
  const damage = target.damage ?? [];
  const healing = target.healing ?? [];
  const graded = target.hit != null || target.evade != null;
  return <span className="compact-report-target">
    <span className="compact-report-target-line">
      <span className="report-target-name">{target.targetName}</span>
      {target.grade && <span className={`report-grade grade-${HIT_GRADE_CLASS_BY_LABEL[target.grade] ?? "hit"}`}>{target.grade}</span>}
    </span>
    {graded && <span className="report-rolls" title="命中骰与闪避骰是本次攻击的实际投点">
      <span className="report-roll-hit">命中骰 {displayNumber(target.hit)}</span>
      <span className="report-roll-evade">闪避骰 {displayNumber(target.evade)}</span>
    </span>}
    {damage.map((entry, damageIndex) => <span className="report-damage" key={`damage-${damageIndex}`}>
      {displayNumber(entry.amount)}{entry.damageType ? ` ${entry.damageType}` : ""}伤害
      {entry.healthAfter != null && <small>（剩余体力 {entry.healthAfter}）</small>}
    </span>)}
    {healing.map((entry, healingIndex) => <span className="report-healing" key={`healing-${healingIndex}`}>
      恢复 {displayNumber(entry.amount)} 体力
      {entry.healthAfter != null && <small>（当前体力 {entry.healthAfter}）</small>}
    </span>)}
  </span>;
}

function CompactPhase({ label, actions, playerIds, onActor }) {
  if (actions.length === 0) return null;
  return <section className="compact-report-phase">
    <h4>{label}</h4>
    {actions.map((row, index) => <div className="compact-report-action" key={`${row.actor.id}-${index}`}>
      <span className="compact-report-call">
        {row.schedule && `先攻 ${row.schedule.initiative} 第 ${row.schedule.ordinal} 步行动/共 ${row.schedule.totalActions} 步　`}
        <button className={playerIds.has(String(row.actor.id)) ? "report-actor player" : "report-actor"} onClick={() => onActor(row)}>{row.actor.name}</button>
        {isActionLevelFailure(row.failure?.reason) ? (
          // 行动级失败：「{角色名} 无法执行任何行动」/「{角色名} 没有配置指令」，
          // 没有具体技能、物品与目标可显示。
          <span className="warning"> {row.failure.reasonLabel}</span>
        ) : label === "先攻" ? (<>
          <span> 使用</span>
          <span className="report-skill" title={`技能等级：${row.skill.level}\n${effectText(row.skill.effects)}`}>{row.skill.name}</span>
          {(row.costs.length > 0 || row.items.length > 0) && <span>(
            {row.costs.length > 0 && <span className="report-cost">{costText(row.costs)}</span>}
            {row.costs.length > 0 && row.items.length > 0 && "/"}
            {row.items.map((item, itemIndex) => <span key={item.id}>{itemIndex > 0 && ","}<span className="report-item" title={itemEffectText(item)}>{item.name}</span></span>)}
          )</span>}
          {row.initiativeDetails ? <span className="report-initiative-breakdown">
            <span><small>基础</small>{displayNumber(row.initiativeDetails.base)}</span>
            <span><small>投掷</small>{displayNumber(row.initiativeDetails.roll)}</span>
            <span><small>硬加值</small>{displayNumber(row.initiativeDetails.hardBonus ?? 0)}</span>
            <b><small>最终</small>{displayNumber(row.initiative)}</b>
          </span> : <span>: 先攻{row.initiative ?? "—"}</span>}
          {row.failure && <span className="warning"> 失败：{row.failure.reasonLabel}{row.failure.requiredMana != null ? `（需要 ${row.failure.requiredMana}，当前 ${row.failure.currentMana}）` : ""}</span>}
        </>) : (<>
          <span>{row.failure ? " 尝试使用 " : " 使用 "}</span>
          <span className="report-skill" title={`技能等级：${row.skill.level}\n${effectText(row.skill.effects)}`}>{row.skill.name}</span>
          {(row.costs.length > 0 || row.items.length > 0) && <span>(
            {row.costs.length > 0 && <span className="report-cost">{costText(row.costs)}</span>}
            {row.costs.length > 0 && row.items.length > 0 && "/"}
            {row.items.map((item, itemIndex) => <span key={item.id}>{itemIndex > 0 && ","}<span className="report-item" title={itemEffectText(item)}>{item.name}</span></span>)}
          )</span>}
          {row.targets.length > 0 && " 给"}
          {row.failure && <span className="warning"> 失败：{row.failure.reasonLabel}</span>}
        </>)}
      </span>
      {label !== "先攻" && row.targets.length > 0 && <span className="compact-report-targets">
        {row.targets.map((target, targetIndex) => <TargetOutcome key={`${target.targetId}-${targetIndex}`} target={target} />)}
      </span>}
    </div>)}
  </section>;
}

function ClassicStatusTable({ side, events, playerIds, onUnit }) {
  const attacker = side === "attacker";
  return (
    <div className={`classic-status-block ${attacker ? "attacker" : "defender"}`}>
      <h4>{attacker ? "进攻者:" : "防御者:"}</h4>
      <table className="classic-status-table">
        <thead><tr><th /><th>名称</th><th>等级</th><th>位置</th><th>体力</th><th>Resource</th><th>状态</th></tr></thead>
        <tbody>{events.map((event, index) => (
          <tr key={event.unitId}>
            <td>{index + 1}</td>
            <td className="classic-unit-name"><button className={playerIds.has(String(event.unitId)) ? "report-actor player" : "report-actor"} onClick={() => onUnit({ kind: "status", unit: event })}>{event.name}</button></td>
            <td>{event.level}</td>
            <td>{event.positionLabel}</td>
            <td>{event.health}</td>
            <td>{event.resource} <small>{event.resourceLabel}</small></td>
            <td className="classic-wounds">{event.wounds}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function BattleReport({ battle }) {
  const [buffDialog, setBuffDialog] = useState(null);
  const playerIds = useMemo(() => new Set((battle.roundData ?? []).flatMap((round) => round.preRound.teams.attacker).filter((unit) => unit.kind === "hero").map((unit) => String(unit.unitId))), [battle]);

  return (
    <div className="battle-block classic-battle-block">
      <h2 className="classic-battle-title">第 {battle.battleIndex} 场：{battle.battleName}　<span className={battle.result === "victory" ? "victory" : "warning"}>
        {battle.result === "victory" ? "胜利" : battle.result === "defeat" ? "失败" : "未决"}</span></h2>
      <div className="report-meta classic-report-meta">
        战斗 #{battle.battleId}　回合数 {battle.rounds}
      </div>
      {(battle.roundData ?? []).map((round) => (
          <section key={round.round} className="classic-round-block">
            <h3>回合 {round.round}</h3>
            <div className="classic-round-status">
              <ClassicStatusTable side="attacker" events={round.preRound.teams.attacker} playerIds={playerIds} onUnit={setBuffDialog} />
              <ClassicStatusTable side="defender" events={round.preRound.teams.defender} playerIds={playerIds} onUnit={setBuffDialog} />
            </div>
            <CompactPhase label="回合前" actions={round.preRound.actions} playerIds={playerIds} onActor={setBuffDialog} />
            {round.recovery.length > 0 && <section className="compact-report-phase"><h4>回复</h4>{round.recovery.map((row) => <div key={row.actorId}>{row.actorName} {row.changes.map((change) => `${change.delta >= 0 ? "恢复" : "失去"} ${Math.abs(change.delta)} ${change.resourceLabel}`).join("，")}</div>)}</section>}
            <CompactPhase label="先攻" actions={round.initiative} playerIds={playerIds} onActor={setBuffDialog} />
            <CompactPhase label="回合中" actions={round.mainRound} playerIds={playerIds} onActor={setBuffDialog} />
          </section>
      ))}
      {buffDialog && <div className="report-buff-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setBuffDialog(null)}>
        <section className="report-buff-dialog" role="dialog" aria-modal="true">
          <button className="report-buff-close" onClick={() => setBuffDialog(null)}>×</button>
          <h3>{buffDialog.kind === "status" ? buffDialog.unit.name : buffDialog.actor.name} · {buffDialog.kind === "status" ? "回合开始 Buff" : "当前行动 Buff"}</h3>
          {buffDialog.kind !== "status" && <p>技能等级快照：{buffDialog.skill.level}</p>}
          <div className="report-buff-scroll">
            {buffDialog.kind === "status" ? (
              (buffDialog.unit.buffs ?? []).length > 0
                ? buffDialog.unit.buffs.map((buff, index) => <details key={`${buff.name}-${index}`} open><summary>{buff.name}</summary><pre>{effectText([buff])}</pre></details>)
                : <p className="subtle">该角色在本回合开始时没有 Buff。</p>
            ) : (buffDialog.actor.buffs ?? []).length > 0
              ? buffDialog.actor.buffs.map((buff, index) => <details key={`${buff.name}-${index}`} open><summary>{buff.name}</summary><pre>{effectText([buff])}</pre></details>)
              : <p className="subtle">该行动没有保存可展开的角色 Buff 数值快照。</p>}
          </div>
        </section>
      </div>}
    </div>
  );
}

const EXPLORATION_STATUS_LABELS = { pending: "探索准备中", running: "结算中", completed: "已结算" };

export function explorationStatusLabel(status) {
  return EXPLORATION_STATUS_LABELS[status] ?? "已结算";
}

export function runResultLabel(result) {
  if (result === "victory") return "胜利";
  if (result === "defeat") return "失败";
  if (result === "pending") return "待结算";
  return "未决";
}

/** 战报记录列表：每次探索一条，含「查看详情」入口。 */

function ExplorationSnapshot({ run }) {
  const input = run.input ?? {};
  const party = input.party ?? [];
  const dungeon = input.dungeon ?? {};
  const encounters = input.encounters ?? null;
  const rewards = run.rewards ?? {};
  return (
    <>
      <div className="report-meta">
        记录 #{run.dungeonRunId}　状态 {explorationStatusLabel(run.status)}　地城 {dungeon.name ?? run.dungeonName}
        {dungeon.kind ? `（${dungeon.kind === "raid" ? "团队副本" : "常规地城"}）` : ""}
        　层数上限 {input.maxFloor ?? "—"}　规则版本 {run.rulesetVersion}　种子 {run.seed}
        　创建时间 {run.createdAt}
      </div>
      <h2>队伍与行动设置（{party.length} 名角色）</h2>
      {party.length === 0
        ? <p className="subtle">该记录没有保存队伍快照。</p>
        : (
          <table className="wod-table wide">
            <thead><tr><th>角色</th><th>等级</th><th>职业 / 种族</th><th>站位</th><th>先攻</th><th>回合前</th><th>主回合</th><th>体力 / 法力上限</th></tr></thead>
            <tbody>
              {party.map((member) => (
                <tr key={member.heroId}>
                  <td>{member.name}{member.isLeader ? "（队长）" : ""}</td>
                  <td>{member.level}</td>
                  <td>{member.profession ?? "—"} / {member.race ?? "—"}</td>
                  <td>{member.positionLabel ?? member.position}</td>
                  <td>{member.actionSummary?.commandCounts?.initiative ?? 0}</td>
                  <td>{member.actionSummary?.commandCounts?.preRound ?? 0}</td>
                  <td>{member.actionSummary?.commandCounts?.mainRound ?? 0}</td>
                  <td>{member.healthMax} / {member.manaMax}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      <h2>敌人配置</h2>
      {!encounters
        ? <p className="subtle">该地城在本地没有遭遇配置。</p>
        : (
          <>
            <p className="subtle">配置层号 {encounters.floorNumber}　每层战斗场次 {encounters.battles.length}</p>
            <table className="wod-table wide">
              <thead><tr><th>场次</th><th>战斗</th><th>单位数</th><th>单位（等级 / 站位）</th></tr></thead>
              <tbody>
                {encounters.battles.map((battle) => (
                  <tr key={battle.battleIndex}>
                    <td>{battle.battleIndex}</td>
                    <td>{battle.name}</td>
                    <td>{battle.unitCount}</td>
                    <td>{battle.units.map((unit) => `${unit.name}（${unit.level} / ${unit.positionLabel}）`).join("、")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      <h2>战斗结果与奖励</h2>
      <div className="report-meta">
        结果 {runResultLabel(run.result)}　经验 {rewards.settled ? rewards.experience ?? 0 : "未结算"}　金币 {rewards.settled ? rewards.gold ?? 0 : "未结算"}
      </div>
      <p className="subtle">
        该记录已保存战斗规则输入。战斗引擎按角色设置决定站位与技能释放顺序、逐条记录行动并回填结果——执行环节尚未接入，
        因此这里暂时只有输入快照，没有战斗事件流。
      </p>
    </>
  );
}

function ReportPage({ run, onOpen, onBack, highlightRunId }) {
  if (!run) return <ReportListPage onOpen={onOpen} highlightRunId={highlightRunId} />;
  const pending = run.status === "pending";
  const levels = run.levels ?? [{ floor: run.floorNumber, result: run.result, battles: run.battles }];
  return (
    <section className="classic-report-page">
      <p><WodButton onClick={onBack}>返回战报列表</WodButton></p>
      <h1>战报：{run.dungeonName}</h1>
      {pending
        ? <ExplorationSnapshot run={run} />
        : (
          <>
            <div className="report-meta">
              方案 {run.planName}　种子 {run.seed}　内容版本 {run.contentVersion}　层数 {run.floorCount ?? levels.length}　战斗数 {run.battles.length}
              　结果 <span className={run.result === "victory" ? "victory" : "warning"}>{runResultLabel(run.result)}</span>
              {run.finalHero && <>　剩余体力 {run.finalHero.health}　剩余法力 {run.finalHero.mana}</>}
            </div>
            {run.events?.length > 0 && (
              <div className="battle-report dungeon-events">
                {run.events.map((event) => (
                  <div className={`report-row report-${event.type}`} key={event.seq}>
                    <strong>{event.type === "LevelEnded" ? "层结算" : "地城结算"}</strong>
                    <span>{event.type === "LevelEnded"
                      ? `第 ${event.level} 层完成：${event.result === "victory" ? "胜利" : event.result}（${event.battleCount} 场战斗）`
                      : `地城结束：${event.resultLabel}（${event.floorCount} 层 / ${event.battleCount} 场战斗）`}</span>
                  </div>
                ))}
              </div>
            )}
            {levels.map((level) => (
              <div key={level.floor}>
                <h2>第 {level.floor} 层</h2>
                {level.battles.map((battle) => <BattleReport key={battle.battleId} battle={battle} />)}
              </div>
            ))}
            <p className="subtle">战报由领域事件渲染，渲染层不决定战斗结果。</p>
          </>
        )}
    </section>
  );
}


export { BattleReport, ExplorationSnapshot };
