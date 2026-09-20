import { useApi } from "../../api/client.js";
import { WodButton } from "../../components/ui.jsx";

function dungeonLabel(result) {
  return result.dungeonName ? `地城 ${result.dungeonName}` : "";
}

export default function BattlesPage({ onOpen }) {
  const { data, loading, error } = useApi("/api/battles?limit=30");
  if (error) return <section><h1>记录者小屋</h1><p className="warning">{error}</p></section>;
  if (loading) return <section><h1>记录者小屋</h1><p className="subtle">载入中……</p></section>;
  return (
    <section>
      <h1>记录者小屋</h1>
      <table className="wod-table wide">
        <thead><tr><th>#</th><th>地城</th><th>结果</th><th>回合</th><th>创建时间</th><th /></tr></thead>
        <tbody>
          {(data ?? []).map((battle) => (
            <tr key={battle.battleId}>
              <td>{battle.battleId}</td>
              <td>{battle.dungeonName}</td>
              <td>{battle.result === "victory" ? "胜利" : battle.result === "defeat" ? "失败" : "未决"}</td>
              <td>{battle.rounds}</td>
              <td>{battle.createdAt}</td>
              <td><WodButton onClick={() => onOpen(battle.battleId)}>查看</WodButton></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

