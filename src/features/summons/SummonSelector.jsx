import { useMemo, useState } from "react";
import { WodButton } from "../../components/ui.jsx";

export default function SummonSelector({ archetypes, selectedId, onSelect, allowCreate = false, creating = false, onCreate }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return archetypes;
    return archetypes.filter((entry) => entry.name.toLocaleLowerCase().includes(term) || entry.id.toLocaleLowerCase().includes(term));
  }, [archetypes, query]);
  return <aside className="summon-admin-list">
    <div className="summon-admin-list-heading"><b>召唤物</b>{allowCreate && <WodButton onClick={onCreate}>新增</WodButton>}</div>
    <div className="summon-list-search"><input aria-label="搜索召唤物" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称模糊查询" /></div>
    {filtered.map((entry) => <button type="button" className={entry.id === selectedId && !creating ? "active" : ""} key={entry.id} onClick={() => onSelect(entry)}>
      <b>{entry.name}</b><small>{entry.id} · {entry.definitions.length} 个形态</small>
    </button>)}
    {filtered.length === 0 && <p className="summon-list-empty">没有匹配的召唤物</p>}
  </aside>;
}
