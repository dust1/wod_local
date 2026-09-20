import { useState } from "react";
import { useApi } from "../../api/client.js";
import { Badge, WodButton } from "../../components/ui.jsx";

export default function SkillLibraryPage() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data, loading, error } = useApi(`/api/skills?q=${encodeURIComponent(submitted)}&limit=100`);
  return (
    <section>
      <h1>技能资料</h1>
      <form className="search-row" onSubmit={(event) => { event.preventDefault(); setSubmitted(query); }}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称或 ID 搜索" />
        <WodButton onClick={() => setSubmitted(query)}>搜索</WodButton>
      </form>
      {error && <p className="warning">{error}</p>}
      {loading && <p className="subtle">载入中……</p>}
      {data && (
        <>
          <p className="subtle">共 {data.total} 个技能定义，匹配 {data.matched} 个。</p>
          <table className="wod-table wide">
            <thead><tr><th>ID</th><th>名称</th><th>用途</th><th>攻击方式</th><th>目标</th><th>物品</th><th>来源</th></tr></thead>
            <tbody>
              {data.skills.map((skill) => (
                <tr key={skill.id}>
                  <td>{skill.id}</td>
                  <td>{skill.name}{skill.warnings.length > 0 && <Badge kind="warn" title={skill.warnings.join("；")}>告警</Badge>}</td>
                  <td>{skill.baseTypeLabel}</td>
                  <td>{skill.attackType ?? "—"}</td>
                  <td>{skill.target?.rawText ?? "—"}</td>
                  <td>{skill.itemRequirement?.rawText || "—"}</td>
                  <td>{skill.generated ? "ETL 生成" : "人工校正"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}


