import { useEffect, useState } from "react";
import { request } from "../../api/client.js";
import { isCompanionPlaceholder } from "../../../game/domain/item.mjs";

const phases = [
  { id: "preRound", title: "回合前", timing: "preRound" },
  { id: "mainRound", title: "回合中", timing: "mainAction" },
];
const WAIT_COMMAND_SKILL_ID = "__wait__";
const healingWounds = [{ id: "light", label: "轻伤" }, { id: "wounded", label: "受伤" }, { id: "severe", label: "重伤" }];

function newAction(phase, positionIds) {
  return { id: `${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, skillId: null, itemIds: [], repeat: "normal", positions: positionIds.map((id) => ({ id, enabled: true })) };
}

/** 技能「物品」字段非空且不是 "-" 时，才需要出现调用物品下拉框。 */
function findSkill(skills, skillId) {
  return skills.find((skill) => skill.skillId === skillId) ?? null;
}

/**
 * 调用物品下拉框。候选来自 hero DTO 的 itemRequirement.candidates
 * （技能「物品」字段 ∩ 当前已装备物品的类别），见 application/skill-item-service.mjs。
 */
function ItemPicker({ action, skill, inline = false, onChange }) {
  const requirement = skill?.itemRequirement;
  if (!requirement) return null;
  const candidates = requirement.candidates ?? [];
  const chosen = (action.itemIds ?? (action.itemId == null ? [] : [action.itemId])).map(String);
  const primary = candidates.find((candidate) => String(candidate.itemId) === chosen[0]);
  // 二次调用物品只属于当前选中的主物品。字段缺失、空集合、空 tag 和占位值 `-`
  // （物品 JSON 用 `-` 表示"无需配合物品"）都不渲染。
  const companionRequirements = Array.isArray(primary?.companionRequirements)
    ? primary.companionRequirements.filter((entry) => !isCompanionPlaceholder(entry?.itemTypeName))
    : [];
  return <div className="action-item-pickers">
    <label>{inline ? <span className="sr-only">先攻技能调用物品</span> : "调用物品"}<select aria-label="调用物品" value={chosen[0] ?? ""} onChange={(event) => onChange(event.target.value ? [event.target.value] : [])}>
      <option value="">{requirement.optional ? "（不调用物品）" : "请选择一个物品"}</option>
      {candidates.map((candidate) => <option key={candidate.itemId} value={String(candidate.itemId)}>{candidate.name}</option>)}
    </select></label>
    {companionRequirements.length > 0 && <div className="action-companion-pickers">
      {companionRequirements.map((companion, index) => <label key={`${companion.itemTypeName}-${index}`}>配合物品（{companion.itemTypeName}）<select aria-label={`配合物品（${companion.itemTypeName}）`} value={chosen[index + 1] ?? ""} disabled={chosen.slice(1, index + 1).some((id) => !id)} onChange={(event) => {
      const next = chosen.slice(0, index + 2);
      next[index + 1] = event.target.value;
      onChange(next.filter(Boolean));
    }}>
      <option value="">请选择一个物品</option>
      {(companion.candidates ?? []).map((candidate) => <option key={candidate.itemId} value={String(candidate.itemId)}>{candidate.name}</option>)}
      </select></label>)}
    </div>}
  </div>;
}

/** 候选为空或必选未选中时的说明，与保存校验的规则一致。 */
function ItemHint({ action, skill }) {
  const requirement = skill?.itemRequirement;
  if (!requirement) return null;
  const candidates = requirement.candidates ?? [];
  if (candidates.length === 0) return <p className="action-item-hint">当前没有已装备的「{requirement.itemTypeName}」类物品{requirement.optional ? "，可以留空。" : "，请先装备后再保存，或删除该行动。"}</p>;
  if (!requirement.optional && (action.itemIds ?? (action.itemId == null ? [] : [action.itemId])).length === 0) return <p className="action-item-hint">该技能必选调用物品（{requirement.itemTypeName}），未选择时无法保存。</p>;
  return null;
}

/** 保存前的本地预检，与服务端校验同一规则；服务端仍是唯一权威。 */
function collectItemIssues(settings, skills) {
  const issues = [];
  const collect = (scope, layer) => {
    if (!layer?.actions) return;
    for (const actions of Object.values(layer.actions)) {
      for (const action of actions ?? []) {
        const skill = findSkill(skills, action.skillId);
        const requirement = skill?.itemRequirement;
        if (!requirement) continue;
        const chosen = (action.itemIds ?? (action.itemId == null ? [] : [action.itemId])).map(String);
        if (chosen.length === 0 && !requirement.optional) { issues.push(`${scope}「${skill.name}」需要选择调用物品（${requirement.itemTypeName}）`); continue; }
        if (chosen.length === 0) continue;
        const primary = (requirement.candidates ?? []).find((candidate) => String(candidate.itemId) === chosen[0]);
        if (!primary) { issues.push(`${scope}「${skill.name}」所选的调用物品已不在装备中，请重新选择`); continue; }
        const companions = (primary.companionRequirements ?? []).filter((companion) => !isCompanionPlaceholder(companion?.itemTypeName));
        for (const [index, companion] of companions.entries()) {
          const id = chosen[index + 1];
          if (!id) issues.push(`${scope}「${skill.name}」还需要选择配合物品（${companion.itemTypeName}）`);
          else if (!(companion.candidates ?? []).some((candidate) => String(candidate.itemId) === id)) issues.push(`${scope}「${skill.name}」所选的配合物品（${companion.itemTypeName}）已不在装备中，请重新选择`);
        }
      }
    }
  };
  collect("默认层", settings.defaultLayer);
  collect("默认层治疗设置", { actions: settings.defaultLayer?.healing });
  for (const [floor, entry] of Object.entries(settings.floors ?? {})) collect(`第 ${floor} 层`, entry);
  return issues;
}

function HealingSetting({ healing, allSkills, onChange }) {
  const skills = allSkills.filter((skill) => skill.baseType === "heal");
  const update = (wound, entries) => onChange({ ...healing, [wound]: entries });
  return <section className="healing-setting">
    <h2>治疗设置</h2>
    {healingWounds.map(({ id, label }) => {
      const entries = healing?.[id] ?? [];
      return <div className="healing-tier" key={id}>
        <strong>{label}</strong>
        <div className="healing-entries">{entries.map((entry, index) => {
          const skill = findSkill(skills, entry.skillId);
          const replace = (patch) => update(id, entries.map((current, currentIndex) => currentIndex === index ? { ...current, ...patch } : current));
          return <div className="healing-entry" key={index}>
            <label>技能 {index + 1}<select value={entry.skillId} onChange={(event) => replace({ skillId: event.target.value, itemIds: [] })}>
              <option value="">请选择治疗技能</option>
              {skills.map((candidate) => <option key={candidate.skillId} value={candidate.skillId}>{candidate.name}</option>)}
            </select></label>
            <ItemPicker action={entry} skill={skill} onChange={(itemIds) => replace({ itemIds })} />
            <ItemHint action={entry} skill={skill} />
            <button type="button" onClick={() => update(id, entries.filter((_, currentIndex) => currentIndex !== index))}>删除</button>
          </div>;
        })}</div>
        <button type="button" disabled={entries.length >= 5 || skills.length === 0} onClick={() => update(id, [...entries, { skillId: skills[0].skillId, itemIds: [] }])}>＋ 添加治疗技能（{entries.length}/5）</button>
      </div>;
    })}
  </section>;
}

function InitiativeSetting({ actions, allSkills, positionIds, onChange }) {
  const action = actions[0] ?? newAction("initiative", positionIds);
  const skills = allSkills.filter((skill) => skill.timing?.initiative);
  const skill = findSkill(skills, action.skillId);
  const update = (patch) => onChange([{ ...action, ...patch }]);
  return <section className="initiative-setting">
    <h2>先攻技能</h2>
    <div className="initiative-fields">
      <label>行动：<select aria-label="先攻技能" value={action.skillId ?? ""} onChange={(event) => update({ skillId: event.target.value || null, itemIds: [], itemId: null })}>
        <option value="">（不使用先攻技能）</option>
        {skills.map((entry) => <option key={entry.skillId} value={entry.skillId}>{entry.name}</option>)}
      </select></label>
      <ItemPicker action={action} skill={skill} inline onChange={(itemIds) => update({ itemIds, itemId: itemIds[0] ?? null })} />
    </div>
    <ItemHint action={action} skill={skill} />
  </section>;
}

function Detail({ action, skills, positions, repeatModes, onChange }) {
  if (!action) return <aside className="action-detail action-detail-empty">选择左侧的一项行动来编辑详细设置。</aside>;
  const selectedSkill = findSkill(skills, action.skillId);
  const movePosition = (index, delta) => {
    const next = [...action.positions];
    const destination = index + delta;
    if (destination < 0 || destination >= next.length) return;
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange({ ...action, positions: next });
  };
  return <aside className="action-detail">
    <label>技能<select value={action.skillId ?? ""} onChange={(event) => onChange({ ...action, skillId: event.target.value || null, itemIds: [], itemId: null })}>
      <option value="">点击选择一个技能</option>
      <option value={WAIT_COMMAND_SKILL_ID}>干等</option>
      {skills.map((skill) => <option key={skill.skillId} value={skill.skillId}>{skill.name}</option>)}
    </select></label>
    <ItemPicker action={action} skill={selectedSkill} onChange={(itemIds) => onChange({ ...action, itemIds, itemId: itemIds[0] ?? null })} />
    <ItemHint action={action} skill={selectedSkill} />
    <div className="position-editor-label">位置</div>
    <div className="position-editor">
      {action.positions.map((position, index) => <div className={position.enabled ? "position-row" : "position-row disabled"} key={position.id}>
        <label><input type="checkbox" checked={position.enabled} onChange={() => onChange({ ...action, positions: action.positions.map((entry, entryIndex) => entryIndex === index ? { ...entry, enabled: !entry.enabled } : entry) })} />{positions[position.id]}</label>
        <span><button aria-label="上移位置" disabled={index === 0} onClick={() => movePosition(index, -1)}>▲</button><button aria-label="下移位置" disabled={index === action.positions.length - 1} onClick={() => movePosition(index, 1)}>▼</button></span>
      </div>)}
    </div>
    <label>执行<select value={action.repeat} onChange={(event) => onChange({ ...action, repeat: event.target.value })}>
      {Object.entries(repeatModes).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></label>
  </aside>;
}

function ActionSection({ phase, actions, allSkills, positions, repeatModes, onChange }) {
  const [selectedId, setSelectedId] = useState(actions[0]?.id ?? null);
  useEffect(() => { if (selectedId && !actions.some((action) => action.id === selectedId)) setSelectedId(actions[0]?.id ?? null); }, [actions, selectedId]);
  const selectedIndex = actions.findIndex((action) => action.id === selectedId);
  const selected = actions[selectedIndex] ?? null;
  const availableSkills = allSkills.filter((skill) => skill.timing?.[phase.timing] && skill.baseType !== "heal");
  const move = (delta) => {
    const destination = selectedIndex + delta;
    if (selectedIndex < 0 || destination < 0 || destination >= actions.length) return;
    const next = [...actions];
    [next[selectedIndex], next[destination]] = [next[destination], next[selectedIndex]];
    onChange(next);
  };
  const add = () => { const action = newAction(phase.id, Object.keys(positions)); onChange([...actions, action]); setSelectedId(action.id); };
  const copy = () => {
    if (!selected) return;
    const action = { ...selected, id: `${phase.id}-${Date.now()}-copy`, positions: selected.positions.map((entry) => ({ ...entry })) };
    onChange([...actions.slice(0, selectedIndex + 1), action, ...actions.slice(selectedIndex + 1)]); setSelectedId(action.id);
  };
  const label = (action) => {
    if (action.skillId === WAIT_COMMAND_SKILL_ID) return "干等";
    const skill = allSkills.find((entry) => entry.skillId === action.skillId);
    const suffix = action.repeat === "oncePerBattle" ? "（一次性）" : action.repeat === "repeatWhilePossible" ? "（重复）" : "";
    return `${skill?.name ?? "点击这里选择一个技能"}${suffix}`;
  };
  return <section className="action-section">
    <h2>{phase.title}</h2>
    <div className="action-workspace">
      <div className="action-list-frame">
        <div className="action-list" role="listbox" aria-label={`${phase.title}行动列表`}>
          {actions.map((action) => <button key={action.id} className={action.id === selectedId ? "selected" : ""} onClick={() => setSelectedId(action.id)}>{label(action)}</button>)}
          {actions.length === 0 && <button className="empty-action" onClick={add}>点击这里新增一个空白行动</button>}
        </div>
        <div className="action-toolbar">
          <button title="上移行动" disabled={selectedIndex <= 0} onClick={() => move(-1)}>▲</button><button title="下移行动" disabled={selectedIndex < 0 || selectedIndex === actions.length - 1} onClick={() => move(1)}>▼</button>
          <button title="新增行动" onClick={add}>＋</button><button title="删除行动" disabled={!selected} onClick={() => onChange(actions.filter((_, index) => index !== selectedIndex))}>−</button><button title="复制行动" disabled={!selected} onClick={copy}>▣</button>
        </div>
      </div>
      <Detail action={selected} skills={availableSkills} positions={positions} repeatModes={repeatModes} onChange={(nextAction) => onChange(actions.map((action, index) => index === selectedIndex ? nextAction : action))} />
    </div>
  </section>;
}

export default function SettingsPage({ heroId, detail, catalog, loading, error }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [layer, setLayer] = useState("default");
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  useEffect(() => {
    if (!heroId) return;
    let cancelled = false;
    request(`/api/heroes/${heroId}/action-settings`).then((data) => { if (!cancelled) { setSaved(data); setDraft(structuredClone(data)); } }).catch((cause) => { if (!cancelled) setLoadError(cause.message); });
    return () => { cancelled = true; };
  }, [heroId]);
  const positions = catalog?.enums?.positions ?? {};
  const repeatModes = catalog?.enums?.repeatModes ?? {};
  const floor = layer === "default" ? null : Number(layer);
  const floorEntry = floor ? draft?.floors?.[floor] : null;
  const activeLayer = floor ? floorEntry : draft?.defaultLayer;
  const updateLayer = (patch) => floor
    ? setDraft({ ...draft, floors: { ...draft.floors, [floor]: { ...draft.floors[floor], ...patch } } })
    : setDraft({ ...draft, defaultLayer: { ...draft.defaultLayer, ...patch } });
  const toggleOverride = (checked) => {
    const floors = { ...draft.floors };
    if (checked) floors[floor] = { override: true, actions: { initiative: [], preRound: [], mainRound: [] } };
    else delete floors[floor];
    setDraft({ ...draft, floors });
  };
  const save = async () => {
    setStatus("saving");
    try { const data = await request(`/api/heroes/${heroId}/action-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) }); setSaved(data); setDraft(data); setStatus("saved"); }
    catch (cause) { setStatus(`error: ${cause.message}`); }
  };
  if (error || loadError) return <section><h1>设置</h1><p className="warning">{error ?? loadError}</p></section>;
  if (loading || !draft) return <section><h1>设置</h1><p className="subtle">载入中……</p></section>;
  const allSkills = detail?.actionSkills ?? detail?.skills ?? [];
  const itemIssues = collectItemIssues(draft, allSkills);
  return <section className="character-settings-page">
    <h1>设置：{detail?.name ?? "当前英雄"}</h1>
    <div className="settings-tabs"><button className="active">地城</button><button disabled>决斗</button><button disabled>一般</button><button disabled>说明</button></div>
    <div className="layer-tabs"><button className={layer === "default" ? "active" : ""} onClick={() => setLayer("default")}>默认</button><span>等级</span>{Array.from({ length: 10 }, (_, index) => String(index + 1)).map((value) => <button key={value} className={layer === value ? "active" : draft.floors[value]?.override ? "overridden" : ""} onClick={() => setLayer(value)}>{value}</button>)}</div>
    {floor && <label className="override-toggle"><input type="checkbox" checked={Boolean(floorEntry?.override)} onChange={(event) => toggleOverride(event.target.checked)} /> 覆盖默认层设置</label>}
    {activeLayer ? <>
      {!floor && <div className="position-setting"><h2>在战斗中的位置</h2><select value={activeLayer.position} onChange={(event) => updateLayer({ position: event.target.value })}>{Object.entries(positions).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>}
      <InitiativeSetting actions={activeLayer.actions.initiative} allSkills={allSkills} positionIds={Object.keys(positions)} onChange={(actions) => updateLayer({ actions: { ...activeLayer.actions, initiative: actions } })} />
      {phases.map((phase) => <ActionSection key={`${layer}-${phase.id}`} phase={phase} actions={activeLayer.actions[phase.id]} allSkills={allSkills} positions={positions} repeatModes={repeatModes} onChange={(actions) => updateLayer({ actions: { ...activeLayer.actions, [phase.id]: actions } })} />)}
      {!floor && <HealingSetting healing={activeLayer.healing} allSkills={allSkills} onChange={(healing) => updateLayer({ healing })} />}
      {itemIssues.length > 0 && <ul className="action-item-issues">{itemIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      <div className="settings-save"><button className="wod-button" onClick={save} disabled={status === "saving" || itemIssues.length > 0} title={itemIssues.length > 0 ? "请先解决上方调用物品问题" : undefined}>{status === "saving" ? "保存中……" : "保存角色行动设置"}</button><button className="settings-reset" onClick={() => setDraft(structuredClone(saved))}>撤销未保存改动</button>{status === "saved" && <span>设置已保存。</span>}{status?.startsWith("error") && <span className="warning">{status}</span>}</div>
    </> : <div className="override-empty">本层当前沿用默认层设置。勾选“覆盖默认层设置”后可配置专属行动。</div>}
  </section>;
}
