import { useState } from "react";
import { WodButton } from "../../components/ui.jsx";

export default function DungeonPage({ hero, heroes = [], catalog, onExplore, running, error }) {
  const [maxFloor, setMaxFloor] = useState(10);
  const hasParty = heroes.length > 0;
  return (
    <section>
      <h1>地城</h1>
      <div className="form-grid">
        <label>推进层数上限
          <select value={maxFloor} onChange={(event) => setMaxFloor(Number(event.target.value))}>
            {[1, 2, 3, 5, 10].map((value) => <option key={value} value={value}>{value} 层</option>)}
          </select>
        </label>
      </div>
      <p className="subtle">
        点击探索会先创建一条战报记录：把本账号的全部角色（{hasParty ? heroes.map((entry) => entry.name).join("、") : "暂无角色"}）
        与各自的行动设置、所选地城一起固化为战斗规则输入，随后由战斗引擎结算。
      </p>
      <table className="wod-table wide">
        <thead><tr><th>名称</th><th>类型</th><th>说明</th><th /></tr></thead>
        <tbody>
          {(catalog?.dungeons ?? []).map((dungeon) => (
            <tr key={dungeon.id}>
              <td>{dungeon.name}</td>
              <td>{dungeon.kind === "raid" ? "团队副本" : "常规地城"}</td>
              <td>{dungeon.description}</td>
              <td>
                <WodButton
                  disabled={!dungeon.enabled || running || !hero || !hasParty}
                  title={dungeon.enabled ? "" : "本地未配置该地城的遭遇数据"}
                  onClick={() => onExplore(dungeon.id, maxFloor)}
                >
                  {running ? "探索中" : "探索"}
                </WodButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="warning">{error}</p>}
      <p className="subtle">模拟可随时重复运行，不受地城等级或准备时间限制。一层可能包含多场战斗；同层多场战斗共用该层设置方案。战斗结果由 game/engine 的确定性状态机产生，种子可复现。</p>
    </section>
  );
}
