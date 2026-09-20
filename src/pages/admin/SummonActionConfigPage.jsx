import { useEffect, useMemo, useState } from "react";
import { request, useApi } from "../../api/client.js";
import SummonSelector from "../../features/summons/SummonSelector.jsx";

const phases = [{ id: "preRound", title: "回合前", timing: "preRound" }, { id: "mainRound", title: "回合中", timing: "mainAction" }];
const WAIT = "__wait__";
const positions = { front: "前排", leftWing: "左翼", rightWing: "右翼", center: "中间", rear: "后排", enemyRear: "队伍后方" };
const repeats = { normal: "正常执行", oncePerBattle: "每场战斗一次", repeatWhilePossible: "尽可能重复" };
const newAction = (phase) => ({ id: `${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, skillId: null, itemIds: [], repeat: "normal", positions: Object.keys(positions).map((id) => ({ id, enabled: true })) });

function Initiative({ actions, skills, onChange }) {
  const action = actions[0] ?? newAction("initiative");
  return <section className="initiative-setting"><h2>先攻技能</h2><div className="initiative-fields"><label>行动：<select aria-label="先攻技能" value={action.skillId ?? ""} onChange={(event) => onChange(event.target.value ? [{ ...action, skillId: event.target.value }] : [])}><option value="">（不使用先攻技能）</option>{skills.filter((skill) => skill.timing?.initiative).map((skill) => <option key={skill.skillId} value={skill.skillId}>{skill.name}</option>)}</select></label></div></section>;
}

function Detail({ action, skills, onChange }) {
  if (!action) return <aside className="action-detail action-detail-empty">选择左侧的一项行动来编辑详细设置。</aside>;
  const movePosition = (index, delta) => { const next = [...action.positions]; const to = index + delta; if (to < 0 || to >= next.length) return; [next[index], next[to]] = [next[to], next[index]]; onChange({ ...action, positions: next }); };
  return <aside className="action-detail"><label>技能<select value={action.skillId ?? ""} onChange={(event) => onChange({ ...action, skillId: event.target.value || null })}><option value="">点击选择一个技能</option><option value={WAIT}>干等</option>{skills.map((skill) => <option key={skill.skillId} value={skill.skillId}>{skill.name}</option>)}</select></label><div className="position-editor-label">目标位置优先级</div><div className="position-editor">{action.positions.map((position, index) => <div className={position.enabled ? "position-row" : "position-row disabled"} key={position.id}><label><input type="checkbox" checked={position.enabled} onChange={() => onChange({ ...action, positions: action.positions.map((entry, i) => i === index ? { ...entry, enabled: !entry.enabled } : entry) })} />{positions[position.id]}</label><span><button aria-label="上移位置" disabled={index === 0} onClick={() => movePosition(index, -1)}>▲</button><button aria-label="下移位置" disabled={index === action.positions.length - 1} onClick={() => movePosition(index, 1)}>▼</button></span></div>)}</div><label>执行<select value={action.repeat} onChange={(event) => onChange({ ...action, repeat: event.target.value })}>{Object.entries(repeats).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label></aside>;
}

function ActionSection({ phase, actions, skills, onChange }) {
  const [selectedId, setSelectedId] = useState(actions[0]?.id ?? null);
  useEffect(() => { if (selectedId && !actions.some((action) => action.id === selectedId)) setSelectedId(actions[0]?.id ?? null); }, [actions, selectedId]);
  const index = actions.findIndex((action) => action.id === selectedId); const selected = actions[index] ?? null; const available = skills.filter((skill) => skill.timing?.[phase.timing]);
  const add = () => { const action = newAction(phase.id); onChange([...actions, action]); setSelectedId(action.id); };
  const move = (delta) => { const to = index + delta; if (index < 0 || to < 0 || to >= actions.length) return; const next = [...actions]; [next[index], next[to]] = [next[to], next[index]]; onChange(next); };
  const copy = () => { if (!selected) return; const action = structuredClone(selected); action.id = `${phase.id}-${Date.now()}-copy`; onChange([...actions.slice(0, index + 1), action, ...actions.slice(index + 1)]); setSelectedId(action.id); };
  const label = (action) => action.skillId === WAIT ? "干等" : `${skills.find((skill) => skill.skillId === action.skillId)?.name ?? "点击这里选择一个技能"}${action.repeat === "oncePerBattle" ? "（一次性）" : action.repeat === "repeatWhilePossible" ? "（重复）" : ""}`;
  return <section className="action-section"><h2>{phase.title}</h2><div className="action-workspace"><div className="action-list-frame"><div className="action-list" role="listbox" aria-label={`${phase.title}行动列表`}>{actions.map((action) => <button key={action.id} className={action.id === selectedId ? "selected" : ""} onClick={() => setSelectedId(action.id)}>{label(action)}</button>)}{actions.length === 0 && <button className="empty-action" onClick={add}>点击这里新增一个空白行动</button>}</div><div className="action-toolbar"><button title="上移行动" disabled={index <= 0} onClick={() => move(-1)}>▲</button><button title="下移行动" disabled={index < 0 || index === actions.length - 1} onClick={() => move(1)}>▼</button><button title="新增行动" onClick={add}>＋</button><button title="删除行动" disabled={!selected} onClick={() => onChange(actions.filter((_, i) => i !== index))}>−</button><button title="复制行动" disabled={!selected} onClick={copy}>▣</button></div></div><Detail action={selected} skills={available} onChange={(next) => onChange(actions.map((action, i) => i === index ? next : action))} /></div></section>;
}

function ActionEditor({ definition }) {
  const endpoint = `/api/admin/summon-definitions/${definition.id}/action-settings`; const data = useApi(endpoint, [definition.id]);
  const [saved, setSaved] = useState(null); const [draft, setDraft] = useState(null); const [status, setStatus] = useState("");
  useEffect(() => { if (data.data) { setSaved(data.data.settings); setDraft(structuredClone(data.data.settings)); setStatus(""); } }, [data.data]);
  if (data.error) return <div className="admin-card"><p className="form-error">{data.error}</p></div>;
  if (data.loading || !draft) return <div className="admin-card"><p className="subtle">正在载入行动配置……</p></div>;
  const skills = data.data.skills; const actions = draft.defaultLayer.actions;
  const update = (phase, next) => setDraft({ ...draft, defaultLayer: { ...draft.defaultLayer, actions: { ...actions, [phase]: next } } });
  const save = async () => { setStatus("saving"); try { const result = await request(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) }); setSaved(result); setDraft(result); setStatus("saved"); } catch (cause) { setStatus(`error: ${cause.message}`); } };
  return <div className="admin-card character-settings-page"><h2>行动配置：{definition.summonName}</h2>{skills.length === 0 && <p className="warning">该召唤物尚未分配任何启用的召唤物技能，请先在召唤物配置页添加技能。</p>}<Initiative actions={actions.initiative} skills={skills} onChange={(next) => update("initiative", next)} />{phases.map((phase) => <ActionSection key={`${definition.id}-${phase.id}`} phase={phase} actions={actions[phase.id]} skills={skills} onChange={(next) => update(phase.id, next)} />)}<div className="settings-save"><button className="wod-button" onClick={save} disabled={status === "saving"}>{status === "saving" ? "保存中……" : "保存召唤物行动设置"}</button><button className="settings-reset" onClick={() => setDraft(structuredClone(saved))}>撤销未保存改动</button>{status === "saved" && <span>设置已保存。</span>}{status.startsWith("error") && <span className="warning">{status}</span>}</div></div>;
}

export default function SummonActionConfigPage() {
  const config = useApi("/api/admin/summons"); const archetypes = config.data?.archetypes ?? []; const [selectedId, setSelectedId] = useState(null); const [definitionId, setDefinitionId] = useState(null);
  const selected = useMemo(() => archetypes.find((entry) => entry.id === selectedId) ?? null, [archetypes, selectedId]);
  useEffect(() => { if (!selectedId && archetypes[0]) setSelectedId(archetypes[0].id); }, [archetypes, selectedId]); useEffect(() => setDefinitionId(selected?.definitions[0]?.id ?? null), [selected]);
  const definition = selected?.definitions.find((entry) => entry.id === definitionId) ?? null;
  return <section className="summon-admin-page"><h1>召唤物行动配置</h1>{config.error && <p className="form-error">{config.error}</p>}<div className="summon-admin-layout"><SummonSelector archetypes={archetypes} selectedId={selectedId} onSelect={(entry) => setSelectedId(entry.id)} /><div className="summon-admin-workspace">{selected ? selected.definitions.length > 0 ? <><div className="admin-card"><h2>选择形态</h2><div className="admin-chip-list">{selected.definitions.map((entry) => <button type="button" className={definitionId === entry.id ? "active" : ""} key={entry.id} onClick={() => setDefinitionId(entry.id)}>{entry.summonName}<small>阶位 {entry.tier} · 等级 {entry.minSummonSkillLevel}–{entry.maxSummonSkillLevel ?? "∞"}</small></button>)}</div></div>{definition && <ActionEditor key={definition.id} definition={definition} />}</> : <div className="admin-card"><p className="subtle">该召唤物还没有形态，请先在召唤物配置页添加形态。</p></div> : <div className="admin-card"><p className="subtle">请选择一个召唤物。</p></div>}</div></div></section>;
}
