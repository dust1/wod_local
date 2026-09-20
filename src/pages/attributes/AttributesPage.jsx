import { useEffect, useState } from "react";
import { attributeTrainingRangeChange, normalizedAttributeDraftValue } from "../../../game/formulas/training-cost.mjs";
import { Trace, WodButton } from "../../components/ui.jsx";

export function HolderEffectSources({ summary }) {
  if (!summary?.instanceApplied) return null;
  const rows = summary.sources ?? [];
  return (
    <section className="holder-effect-panel">
      <h2>当前持有效果</h2>
      <p className="attribute-note">
        以下效果来自种族、职业、当前装备与已学技能，
        已计入上方属性、派生属性与战斗属性的加持值。
      </p>
      <div className="holder-effect-groups">
        <div>
          <h3>装备物品</h3>
          {summary.equippedItems.length === 0 && <p className="subtle">当前没有装备任何物品。</p>}
          {summary.equippedItems.length > 0 && (
            <table className="wod-table attribute-compact-table">
              <thead><tr><th>物品</th><th>部位</th><th>持有者效果</th></tr></thead>
              <tbody>
                {summary.equippedItems.map((item) => (
                  <tr key={item.instanceId}>
                    <td>{item.name}</td>
                    <td>{item.slotLabel ?? "—"}</td>
                    <td className={item.effectCount > 0 ? "positive" : "subtle"}>
                      {item.hasDetail ? (item.effectCount > 0 ? `${item.effectCount} 条` : "无") : "未解析"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h3>效果来源明细（{summary.sourceCount} 条）</h3>
          {rows.length === 0 && <p className="subtle">当前没有常驻加持效果。</p>}
          {rows.length > 0 && (
            <div className="table-scroll">
              <table className="wod-table source-effect-table">
                <thead><tr><th>来源</th><th>类型</th><th>目标</th><th>修正</th></tr></thead>
                <tbody>
                  {rows.map((source, index) => (
                    <tr key={`${source.sourceId}-${index}`}>
                      <td>{({ item: "装备", itemSet: "套装", skill: "技能", race: "种族", profession: "职业" })[source.sourceKind] ?? source.sourceKind}：{source.sourceName}</td>
                      <td>{source.category}</td>
                      <td>{source.targetName ?? "—"}{source.attackScope && source.attackScope !== "所有" ? ` · ${source.attackScope}` : ""}</td>
                      <td className="positive">{source.rawText || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {summary.onUseOnly.length > 0 && <>
        <h3>仅在技能/物品被实际使用时生效（不计入以上常驻数值）</h3>
        <div className="table-scroll">
          <table className="wod-table source-effect-table">
            <thead><tr><th>来源</th><th>类型</th><th>目标</th><th>修正</th></tr></thead>
            <tbody>
              {summary.onUseOnly.map((source, index) => (
                <tr key={`onuse-${source.sourceId}-${index}`} className="skill-locked">
                  <td>{({ item: "装备", itemSet: "套装", skill: "技能", race: "种族", profession: "职业" })[source.sourceKind] ?? source.sourceKind}：{source.sourceName}</td>
                  <td>{source.category}</td>
                  <td>{source.targetName ?? "—"}</td>
                  <td>{source.rawText || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}
      {summary.missingSources.length > 0 && (
        <p className="attribute-note warning">
          以下来源缺少详细数据，其效果未计入：{summary.missingSources.map((entry) => `${({ item: "装备", itemSet: "套装", skill: "技能", race: "种族", profession: "职业" })[entry.kind] ?? entry.kind} ${entry.name ?? entry.id}`).join("、")}
        </p>
      )}
      {summary.warnings.length > 0 && (
        <details className="taxonomy-details"><summary>解析告警（{summary.warnings.length} 条）</summary><ul>{summary.warnings.slice(0, 40).map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
      )}
    </section>
  );
}

export default function AttributesPage({ hero, detail, loading, error, onTrain, onLevelUp }) {
  const [draft, setDraft] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [trainingError, setTrainingError] = useState(null);
  const [leveling, setLeveling] = useState(false);
  // 提交成功后服务端会回传新详情，此时清空草稿，让表格重新落到已提交的基础值上。
  useEffect(() => {
    setDraft({});
    setTrainingError(null);
  }, [detail]);
  if (error) return <section><h1>英雄属性</h1><p className="warning">{error}</p></section>;
  if (loading || !detail) return <section><h1>英雄属性</h1><p className="subtle">载入中……</p></section>;
  const derived = detail.derived;
  const combat = detail.combatAttributes;
  const signed = (value) => `${value > 0 ? "+" : ""}${value}`;
  const deltaClass = (value) => (value > 0 ? "positive" : value < 0 ? "negative" : "subtle");
  const breakdownOf = (key) => derived.breakdown?.[key] ?? null;
  /** 基础值 → 装备 → 技能 → 生效值。 */
  const DerivedValue = ({ statKey, value, suffix = "" }) => {
    const row = breakdownOf(statKey);
    if (!row || (row.equipmentDelta === 0 && row.skillDelta === 0)) return <>{value}{suffix}</>;
    return (
      <span title={`基础值 ${row.base}${suffix}｜装备 ${signed(row.equipmentDelta)}｜技能 ${signed(row.skillDelta)}`}>
        {value}{suffix} <em className="derived-delta positive">（{row.base} {signed(row.equipmentDelta)} {signed(row.skillDelta)}）</em>
      </span>
    );
  };
  const contributorTitle = (contributors) => contributors.length === 0
    ? undefined
    : contributors.map((entry) => `${entry.sourceLabel}｜${entry.category}｜${entry.rawText}`).join("\n");
  const BonusTable = ({ rows }) => (
    <table className="wod-table attribute-compact-table bonus-table">
      <thead><tr><th>奖励</th><th>修正</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.label}><td>{row.label}</td><td className={row.flat >= 0 ? "positive" : "negative"} title={contributorTitle(row.sources)}>{signed(row.flat)}{row.percent != null && row.percent !== 0 && ` ${signed(row.percent)}%`}</td></tr>)}</tbody>
    </table>
  );
  const GradedTable = ({ rows, label }) => (
    <table className="wod-table attribute-compact-table">
      <thead><tr><th>伤害类型</th><th>攻击方式</th><th>{label} (r)</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.damageType}-${row.attackType}`}><td>{row.damageType}</td><td>{row.attackType}</td><td className="positive" title={contributorTitle(row.sources)}>{row.text}</td></tr>)}</tbody>
    </table>
  );
  const draftValueOf = (attribute) => normalizedAttributeDraftValue(attribute.base, draft[attribute.key]);
  const changes = detail.attributes.filter((attribute) => draftValueOf(attribute) !== attribute.base);
  /** 草稿与当前基础值之间的逐级费用；提升按目标等级取值，降低按当前等级退回。 */
  const draftCostBetween = (attribute, target) => attributeTrainingRangeChange(attribute.base, target);
  /**
   * 训练表在最高等级没有下一级费用，只有能算出费用时才允许加号；
   * 这与减号在最低值 1 处的处理对称。
   */
  function draftCostOrNull(attribute, target) {
    try { return draftCostBetween(attribute, target); }
    catch { return null; }
  }
  const remainingExperience = changes.reduce((remaining, attribute) => {
    return remaining + draftCostBetween(attribute, draftValueOf(attribute));
  }, detail.currentExperience);
  function step(attribute, delta) {
    const current = draftValueOf(attribute);
    if (delta < 0 && current <= 1) return;
    if (delta > 0 && (draftCostOrNull(attribute, current + 1) ?? Infinity) + remainingExperience < 0) return;
    setDraft((value) => ({ ...value, [attribute.key]: current + delta }));
    setTrainingError(null);
  }
  async function submit() {
    setSubmitting(true);
    setTrainingError(null);
    try { await onTrain(changes.map((attribute) => ({ key: attribute.key, value: draftValueOf(attribute) }))); }
    catch (cause) { setTrainingError(cause.message); }
    finally { setSubmitting(false); }
  }
  async function levelUp() {
    setLeveling(true);
    setTrainingError(null);
    try { await onLevelUp(); }
    catch (cause) { setTrainingError(cause.message); }
    finally { setLeveling(false); }
  }
  return (
    <section className="attributes-page">
      <h1>我的{detail.name} - 属性与特性</h1>
      <div className="attribute-overview">
        <div className="base-attributes">
          <div className="attribute-training-panel">
            <div className="skill-training-toolbar">
              <p className="skill-experience">剩余经验 <strong>{remainingExperience.toLocaleString()}</strong>{changes.length > 0 && <span>（当前 {detail.currentExperience.toLocaleString()}）</span>} · 总经验 {detail.totalExperience.toLocaleString()} · 英雄等级 {detail.level}</p>
              <WodButton disabled={submitting || changes.length === 0} onClick={submit}>{submitting ? "提交中……" : "提交修改"}</WodButton>
            </div>
            {trainingError && <p className="form-error attribute-training-error">{trainingError}</p>}
            <table className="wod-table attribute-compact-table">
              <thead><tr><th>属性</th><th colSpan="3">基础值</th><th>装备</th><th>技能/天生</th><th>生效值</th></tr></thead>
              <tbody>
                {detail.attributes.map((attribute) => {
                  const draftValue = draftValueOf(attribute);
                  const canDecrease = draftValue > 1;
                  const increaseCost = draftCostOrNull(attribute, draftValue + 1);
                  const decreaseRefund = canDecrease ? draftCostBetween(attribute, draftValue - 1) : 0;
                  const affordable = increaseCost != null && increaseCost + remainingExperience >= 0;
                  return (
                    <tr key={attribute.key}>
                      <td>{attribute.label}</td>
                      <td><button className="attribute-step-button" disabled={submitting || !canDecrease} title={canDecrease ? `降低 1 点，退回 ${decreaseRefund.toLocaleString()} 经验` : "属性不能低于 1"} onClick={() => step(attribute, -1)}>−</button></td>
                      <td className="attribute-base-value">{draftValue}</td>
                      <td><button className="attribute-step-button" disabled={submitting || !affordable} title={increaseCost == null ? "已达到训练表上限" : affordable ? `提高 1 点，花费 ${increaseCost.toLocaleString()} 经验` : `剩余经验不足，需要 ${(-increaseCost).toLocaleString()} 经验`} onClick={() => step(attribute, 1)}>+</button></td>
                      <td className={deltaClass(attribute.equipmentDelta)} title={contributorTitle(attribute.contributors.filter((entry) => entry.sourceKind === "item" || entry.sourceKind === "itemSet"))}>{signed(attribute.equipmentDelta)}</td>
                      <td className={deltaClass(attribute.skillDelta)} title={contributorTitle(attribute.contributors.filter((entry) => ["skill", "race", "profession"].includes(entry.sourceKind)))}>{signed(attribute.skillDelta)}</td>
                      <td className={attribute.effective !== attribute.base ? "positive" : ""} title={contributorTitle(attribute.contributors)}>{attribute.effective}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {changes.length > 0 && <button className="equipment-reset" disabled={submitting} onClick={() => setDraft({})}>撤销未提交修改（{changes.length} 项）</button>}
            <p className="attribute-note">生效值 = 基础值 + 装备加持 + 技能/种族/职业加持。悬停可得来源明细。</p>
          </div>
        </div>
        <table className="wod-table attribute-summary-table"><tbody>
          <tr><th>英雄等级</th><td><span className="hero-level-cell">{detail.level}{detail.experienceProgress.canLevelUp && <WodButton disabled={leveling} title={`总经验已达到 ${detail.experienceProgress.nextLevelAt.toLocaleString()}，可以提升至 ${detail.level + 1} 级`} onClick={levelUp}>{leveling ? "升级中……" : "升级"}</WodButton>}</span></td><td colSpan="2">{detail.profession} · {detail.race}</td></tr>
          <tr><th>当前经验</th><td>{detail.currentExperience.toLocaleString()}</td><th>总经验</th><td>{detail.totalExperience.toLocaleString()}</td></tr>
          <tr><th>荣誉</th><td>{detail.fame.toLocaleString()}</td><td colSpan="2">当前状态：<span className="positive">{derived.woundsLabel}</span></td></tr>
          <tr><th>体力</th><td>{derived.health}</td><th>体力上限</th><td><DerivedValue statKey="healthMax" value={derived.healthMax} /></td></tr>
          <tr><th>体力恢复</th><td><DerivedValue statKey="healthRegeneration" value={derived.healthRegeneration} /></td><th>法力回复</th><td><DerivedValue statKey="manaRegeneration" value={derived.manaRegeneration} /></td></tr>
          <tr><th>法力</th><td>{derived.mana}</td><th>法力上限</th><td><DerivedValue statKey="manaMax" value={derived.manaMax} /></td></tr>
          <tr><th>每回合行动次数</th><td><DerivedValue statKey="actionsPerRound" value={derived.actions} /></td><td colSpan="2" className="formula-cell">精确值 {derived.actionsExact.toFixed(2)}</td></tr>
          <tr><th>先攻附加值</th><td><DerivedValue statKey="initiative" value={derived.initiative} /></td><td colSpan="2"><Trace steps={derived.traces.initiative} title="查看计算" /></td></tr>
          <tr><th>性别</th><td colSpan="3">{detail.gender === "female" ? "女性" : "男性"}</td></tr>
        </tbody></table>
      </div>
      <div className="combat-grid">
        <div className="combat-block armor-block"><h2>护甲</h2>{combat.armor.length > 0 ? <GradedTable rows={combat.armor} label="护甲" /> : <p className="subtle">当前装备与技能没有提供护甲奖励。</p>}<p className="attribute-note">(r) 分别为普通/重击/致命</p></div>
        <div className="combat-block damage-block"><h2>损害</h2>{combat.damage.length > 0 ? <GradedTable rows={combat.damage} label="损害" /> : <p className="subtle">当前装备与技能没有提供损害奖励。</p>}<p className="attribute-note">(r) 分别为普通/重击/致命</p></div>
        <div className="combat-block"><h2>累计攻击奖励</h2>{combat.attackBonuses.length > 0 ? <BonusTable rows={combat.attackBonuses} /> : <p className="subtle">无</p>}</div>
        <div className="combat-block"><h2>累计防御奖励</h2>{combat.defenseBonuses.length > 0 ? <BonusTable rows={combat.defenseBonuses} /> : <p className="subtle">无</p>}</div>
      </div>
      <HolderEffectSources summary={detail.effectSummary} />
      <details className="taxonomy-details"><summary>查看规则字典</summary><p><b>攻击方式：</b>{detail.attackTypes.join("、")}</p><p><b>伤害类型：</b>{detail.damageTypes.join("、")}</p></details>
    </section>
  );
}
