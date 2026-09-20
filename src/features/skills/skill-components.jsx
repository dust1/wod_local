import { useEffect } from "react";

function SkillEffectsTable({ rows }) {
  if (!rows?.length) return null;
  const groups = Object.groupBy ? Object.groupBy(rows, (row) => row["类型"] || "效果") : rows.reduce((all, row) => {
    const key = row["类型"] || "效果";
    (all[key] ??= []).push(row);
    return all;
  }, {});
  return Object.entries(groups).map(([title, entries]) => {
    const columns = [...new Set(entries.flatMap((entry) => Object.keys(entry).filter((key) => key !== "类型")))];
    return <section className="skill-effect-block" key={title}><h3>{title}</h3><table className="wod-table"><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{entries.map((entry, index) => <tr key={index}>{columns.map((column) => <td key={column}>{entry[column] || "—"}</td>)}</tr>)}</tbody></table></section>;
  });
}

function SkillDetailDialog({ state, onClose }) {
  useEffect(() => {
    if (!state) return undefined;
    const close = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [state, onClose]);
  if (!state) return null;
  const payload = state.data?.detail;
  const attributes = payload?.["详细属性"] ?? {};
  return (
    <div className="skill-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="skill-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-dialog-title">
        <header><h2 id="skill-dialog-title">技能 {payload?.["技能名称"] ?? state.skill.name}</h2><button className="skill-dialog-close" onClick={onClose} aria-label="关闭技能详情">×</button></header>
        {state.loading && <p className="subtle">载入技能详情……</p>}
        {state.error && <p className="form-error">{state.error}</p>}
        {payload && <div className="skill-dialog-scroll">
          <div className="skill-detail-overview">
            <div className="skill-description"><h3>{payload["技能名称"]}</h3><hr />{payload["描述"] && <p>{payload["描述"]}</p>}<hr />
              {payload["职业要求"]?.length > 0 && <div className="skill-requirements"><strong>此技能可由以下职业或种族学习：</strong>{payload["职业要求"].map((entry, index) => <span key={index}>{entry["名称"]}{entry["最低等级"] ? `（至少等级 ${entry["最低等级"]}）` : ""}</span>)}</div>}
            </div>
            <dl className="skill-facts">{Object.entries(attributes).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>
          </div>
          {payload["注释"] && <p className="skill-note">{payload["注释"]}</p>}
          <h2>作用在技能拥有者上的效果</h2><p>当英雄学会此技能并且技能等级大于等于一时，会有这些奖惩效果（除非另有说明）。</p>
          <SkillEffectsTable rows={payload["作用在技能拥有者上的效果"]} />
          <h2>作用在被此技能影响的目标上的效果</h2><p>只有英雄使用此技能时，才会有这些奖惩效果。</p>
          <SkillEffectsTable rows={payload["作用在被此技能影响的目标上的效果"]} />
        </div>}
      </section>
    </div>
  );
}


export { SkillEffectsTable, SkillDetailDialog };
