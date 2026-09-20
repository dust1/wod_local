import { useEffect, useState } from "react";
import { normalizedSkillDraftLevel, SKILL_TRAINING_COSTS, skillTrainingRangeChange } from "../../../game/formulas/training-cost.mjs";
import { request } from "../../api/client.js";
import { WodButton } from "../../components/ui.jsx";
import { SkillDetailDialog } from "../../features/skills/skill-components.jsx";
import { HolderEffectSources } from "../attributes/AttributesPage.jsx";

export default function SkillsPage({ detail, loading, error, onTrain, onAdvance }) {
  const [draft, setDraft] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [trainingError, setTrainingError] = useState(null);
  const [skillDialog, setSkillDialog] = useState(null);
  const [advancementOpen, setAdvancementOpen] = useState(false);
  const [advancementChoice, setAdvancementChoice] = useState("");
  useEffect(() => {
    setDraft(Object.fromEntries((detail?.learnableSkills ?? []).map((skill) => [skill.sourceSkillId, skill.currentLevel])));
    setTrainingError(null);
  }, [detail]);
  if (error) return <section><h1>技能</h1><p className="warning">{error}</p></section>;
  if (loading || !detail) return <section><h1>技能</h1><p className="subtle">载入中……</p></section>;
  const draftLevelOf = (skill) => normalizedSkillDraftLevel(skill.currentLevel, draft[skill.sourceSkillId]);
  const changes = detail.learnableSkills.filter((skill) => draftLevelOf(skill) !== skill.currentLevel);
  function skillCostAt(skill, targetLevel) {
    return SKILL_TRAINING_COSTS[skill.trainingClass]?.[targetLevel] ?? null;
  }
  const remainingExperience = changes.reduce((remaining, skill) => {
    return remaining + skillTrainingRangeChange(skill.currentLevel, draftLevelOf(skill), skill.trainingClass);
  }, detail.currentExperience);
  function step(skill, delta) {
    const current = draftLevelOf(skill);
    if (delta > 0 && (skillCostAt(skill, current + 1) == null || remainingExperience < skillCostAt(skill, current + 1))) return;
    setDraft((value) => ({ ...value, [skill.sourceSkillId]: current + delta }));
    setTrainingError(null);
  }
  async function submit() {
    setSubmitting(true);
    setTrainingError(null);
    try { await onTrain(changes.map((skill) => ({ sourceSkillId: skill.sourceSkillId, level: draftLevelOf(skill) }))); }
    catch (cause) { setTrainingError(cause.message); }
    finally { setSubmitting(false); }
  }
  async function showSkill(skill) {
    setSkillDialog({ skill, loading: true, data: null, error: null });
    try {
      const data = await request(`/api/skill-details/${skill.source}/${skill.sourceSkillId}`);
      setSkillDialog({ skill, loading: false, data, error: null });
    } catch (cause) {
      setSkillDialog({ skill, loading: false, data: null, error: cause.message });
    }
  }
  async function confirmAdvancement() {
    if (!advancementChoice) return;
    setSubmitting(true);
    setTrainingError(null);
    try { await onAdvance(advancementChoice); setAdvancementOpen(false); }
    catch (cause) { setTrainingError(cause.message); }
    finally { setSubmitting(false); }
  }
  return (
    <section className="skills-page">
      <div className="skill-page-heading"><h1>我的{detail.name} - 技能</h1>{detail.advancement?.eligible && <WodButton disabled={submitting} onClick={() => { setAdvancementChoice(detail.advancedProfession ?? detail.advancement.options[0] ?? ""); setAdvancementOpen(true); }}>{detail.advancedProfession ? `进阶职业：${detail.advancedProfession}` : "职业进阶"}</WodButton>}</div>
      <div className="skill-training-toolbar">
        <p className="skill-experience">剩余经验 <strong>{remainingExperience.toLocaleString()}</strong>{changes.length > 0 && <span>（当前 {detail.currentExperience.toLocaleString()}）</span>} · 总经验 {detail.totalExperience.toLocaleString()} · 英雄等级 {detail.level}</p>
        <WodButton disabled={submitting || changes.length === 0} onClick={submit}>{submitting ? "提交中……" : "提交修改"}</WodButton>
      </div>
      <table className="wod-table skill-training-table">
        <thead><tr><th>#</th><th>技能</th><th>技能等级</th><th>加持后等级</th><th>解锁等级</th><th>训练花费</th></tr></thead>
        <tbody>
          {detail.learnableSkills.map((skill, index) => (
            <tr key={skill.sourceSkillId} className={!skill.unlocked ? "skill-locked" : ""}>
              <td>{index + 1}</td>
              <td>
                <button className={`skill-name skill-${skill.trainingClass}`} onClick={() => showSkill(skill)}>{skill.name}</button>
                <span className="skill-origin">{skill.source === "race" ? "种族" : "职业"} · {skill.trainingClassLabel}</span>
                {skill.effectBonuses?.length > 0 && (
                  <span className="skill-boost-badge" title={skill.effectBonuses.map((entry) => `${entry.targetName}：${entry.total.flat}${entry.total.percent ? ` ${entry.total.percent}%` : ""}`).join("\n")}>
                    技能效果加成 {skill.effectBonuses.length} 项
                  </span>
                )}
              </td>
              <td className="skill-level-cell">
                <button className="attribute-step-button" disabled={submitting || !skill.unlocked || draftLevelOf(skill) <= 0} title="降低 1 级并退回对应经验" onClick={() => step(skill, -1)}>−</button>
                <strong>{draftLevelOf(skill)}</strong>
                <button className="attribute-step-button" disabled={submitting || !skill.unlocked || skillCostAt(skill, draftLevelOf(skill) + 1) == null || remainingExperience < skillCostAt(skill, draftLevelOf(skill) + 1)} title={!skill.unlocked ? `${skill.learnLevel} 级解锁` : "提高 1 级并模拟扣除经验"} onClick={() => step(skill, 1)}>+</button>
              </td>
              <td className="skill-live-level" title={skill.levelDelta !== 0 ? `${[
                skill.itemLevelBonus !== 0 ? `装备加持 ${skill.itemLevelBonus} 级` : null,
                skill.setLevelBonus !== 0 ? `套装加持 ${skill.setLevelBonus} 级` : null,
                skill.skillLevelBonus !== 0 ? `技能加持 ${skill.skillLevelBonus} 级` : null,
              ].filter(Boolean).join("，")}\n${skill.levelSources.map((entry) => `${entry.sourceLabel}｜${entry.rawText}`).join("\n")}` : undefined}>
                {skill.levelDelta !== 0
                  ? <span className="positive">{draftLevelOf(skill)} → {draftLevelOf(skill) + skill.levelDelta}</span>
                  : <span className="subtle">—</span>}
              </td>
              <td>{skill.learnLevel}</td>
              <td className="skill-cost">{skill.unlocked && skill.increaseCost != null ? `${skill.increaseCost.toLocaleString()} 经验` : skill.unlocked ? "—" : "未解锁"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {changes.length > 0 && <button className="equipment-reset" disabled={submitting} onClick={() => setDraft(Object.fromEntries(detail.learnableSkills.map((skill) => [skill.sourceSkillId, skill.currentLevel])))}>撤销未提交修改（{changes.length} 项）</button>}
      {detail.learnableSkills.length === 0 && <p className="subtle">当前职业与种族没有可显示的技能。</p>}
      <p className="attribute-note">
        「加持后等级」= 技能等级 + 装备提供的「对技能等级的奖励」（受「装备加成不超过技能基础等级」限制）+ 套装与已学技能彼此提供的等级加成（不受该限制）。
        {detail.effectSummary?.onUseOnly?.length > 0 && " 带 (a) 标记的效果仅在技能被实际使用时生效，不计入。 "}
      </p>
      {detail.effectSummary && <HolderEffectSources summary={detail.effectSummary} />}
      {trainingError && <p className="form-error">{trainingError}</p>}
      <SkillDetailDialog state={skillDialog} onClose={() => setSkillDialog(null)} />
      {advancementOpen && <div className="skill-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setAdvancementOpen(false)}>
        <section className="skill-dialog advancement-dialog" role="dialog" aria-modal="true" aria-labelledby="advancement-title">
          <header><h2 id="advancement-title">选择{detail.profession}的进阶职业</h2><button className="skill-dialog-close" onClick={() => setAdvancementOpen(false)} aria-label="关闭">×</button></header>
          <div className="advancement-options">{detail.advancement.options.map((name) => <label key={name} className={advancementChoice === name ? "selected" : ""}><input type="radio" name="advanced-profession" checked={advancementChoice === name} onChange={() => setAdvancementChoice(name)} /> <strong>{name}</strong></label>)}</div>
          <p className="subtle">{detail.advancedProfession ? "切换进阶职业免费，确认后对应职业技能立即更新。" : `首次进阶将扣除 ${detail.advancement.experienceCost.toLocaleString()} 经验和 ${detail.advancement.goldCost.toLocaleString()} 金币。`}</p>
          <WodButton disabled={submitting || !advancementChoice || advancementChoice === detail.advancedProfession} onClick={confirmAdvancement}>{submitting ? "处理中……" : detail.advancedProfession ? "确认切换" : "确认进阶"}</WodButton>
        </section>
      </div>}
    </section>
  );
}

