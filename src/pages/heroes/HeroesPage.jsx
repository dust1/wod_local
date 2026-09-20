import { useState } from "react";
import { WodButton } from "../../components/ui.jsx";
import CharacterCardDialog from "../../features/heroes/character-card-dialog.jsx";

export default function HeroesPage({ heroes, activeHero, detail, onActivate, onNavigate, onAddResource, onImportCharacterCard, onDelete, error }) {
  const [amounts, setAmounts] = useState({ experience: "", gold: "", fame: "" });
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState(null);
  const [cardDialogOpen, setCardDialogOpen] = useState(false);

  async function add(resource) {
    const amount = Number(amounts[resource]);
    setBusy(resource);
    setMessage("");
    try {
      await onAddResource(resource, amount);
      setAmounts((current) => ({ ...current, [resource]: "" }));
      setMessage(`已为 ${activeHero.name} 补充 ${amount.toLocaleString()} ${{ experience: "经验", gold: "金币", fame: "荣誉" }[resource]}。`);
    } catch (cause) {
      setMessage(cause.message);
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    const hero = pendingDelete;
    setDeleting(true);
    setDeleteMessage(null);
    try {
      const result = await onDelete(hero.id);
      setDeleteMessage({ ok: true, text: `已删除 ${hero.name}${result?.movedItemCount ? `，名下 ${result.movedItemCount} 件物品已移入团队仓库` : ""}。` });
      setPendingDelete(null);
    } catch (cause) {
      setDeleteMessage({ ok: false, text: cause.message });
    } finally {
      setDeleting(false);
    }
  }

  if (error) return <section><h1>我的英雄</h1><p className="warning">载入失败：{error}</p></section>;
  return (
    <section>
      <h1>我的英雄</h1>
      <div className="table-scroll">
        <table className="wod-table heroes-table">
          <thead><tr><th /><th>名称</th><th>职业</th><th>种族</th><th>等级</th><th>体力/法力</th><th>先攻</th><th>下一个地城</th><th>操作</th></tr></thead>
          <tbody>
            {heroes.map((hero) => (
              <tr key={hero.id} className={hero.active ? "selected" : ""}>
                <td><input type="radio" name="hero" checked={hero.active} onChange={() => onActivate(hero.id)} /></td>
                <td><button className="table-link" onClick={() => { onActivate(hero.id); onNavigate("attributes"); }}>{hero.name}</button></td>
                <td>{hero.profession}</td>
                <td>{hero.race}</td>
                <td>{hero.level}</td>
                <td>{hero.healthMax} / {hero.manaMax}</td>
                <td>{hero.initiative}</td>
                <td>{hero.nextDungeonAt || "立刻"}</td>
                <td><WodButton title={`删除 ${hero.name}`} onClick={() => { setDeleteMessage(null); setPendingDelete(hero); }}>删除</WodButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleteMessage ? <p className={deleteMessage.ok ? "positive" : "warning"} role="status">{deleteMessage.text}</p> : null}
      <div className="button-row">
        <WodButton onClick={() => onNavigate("createHero")}>创建新英雄</WodButton>
        <WodButton disabled={!activeHero} onClick={() => setCardDialogOpen(true)} title="粘贴人物卡 BBCode，把卡面的属性、技能与装备覆盖到所选角色">导入角色卡</WodButton>
        <WodButton disabled={!activeHero} onClick={() => onNavigate("attributes")}>查看属性</WodButton>
        <WodButton disabled={!activeHero} onClick={() => onNavigate("settings")}>战斗设置</WodButton>
        <WodButton disabled={!activeHero} onClick={() => onNavigate("dungeon")}>前往地城</WodButton>
      </div>
      <section className="hero-resource-panel" aria-labelledby="hero-resource-heading">
        <h2 id="hero-resource-heading">补充角色资源</h2>
        {activeHero ? <p>所选角色：<strong>{activeHero.name}</strong>　当前经验 {activeHero.currentExperience.toLocaleString()}　金币 {activeHero.gold.toLocaleString()}　荣誉 {activeHero.fame.toLocaleString()}</p> : <p className="subtle">请先选择一个英雄。</p>}
        <div className="hero-resource-controls">
          {[["experience", "经验"], ["gold", "金币"], ["fame", "荣誉"]].map(([resource, label]) => (
            <label key={resource}>
              <span>补充{label}</span>
              <input type="number" min="1" max="1000000000" step="1" inputMode="numeric" value={amounts[resource]} disabled={!activeHero || busy !== null} onChange={(event) => setAmounts((current) => ({ ...current, [resource]: event.target.value }))} />
              <WodButton disabled={!activeHero || busy !== null || !/^\d+$/.test(amounts[resource]) || Number(amounts[resource]) < 1} onClick={() => add(resource)}>{busy === resource ? "补充中……" : `补充${label}`}</WodButton>
            </label>
          ))}
        </div>
        {message ? <p className={message.startsWith("已为") ? "positive" : "warning"} role="status">{message}</p> : null}
      </section>
      <p className="subtle">英雄数据来自 data/game.sqlite；派生属性由 game/ 中的纯函数计算，界面不重复实现公式。</p>
      {pendingDelete ? (
        <div className="skill-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !deleting && setPendingDelete(null)}>
          <section className="skill-dialog delete-hero-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-hero-title">
            <header><h2 id="delete-hero-title">删除角色「{pendingDelete.name}」</h2><button className="skill-dialog-close" disabled={deleting} onClick={() => setPendingDelete(null)} aria-label="关闭">×</button></header>
            <div className="skill-dialog-scroll">
              <p>删除后该角色不再出现在角色列表中，等级、技能与战斗设置一并失效。</p>
              <p>他名下的全部物品（含已装备的）会移入团队仓库，不会有物品被销毁。</p>
              <p className="subtle">已产生的战报与探索记录会保留，仍可在战报页查看。</p>
              <div className="button-row">
                <WodButton disabled={deleting} onClick={confirmDelete}>{deleting ? "删除中……" : "确认删除"}</WodButton>
                <WodButton disabled={deleting} onClick={() => setPendingDelete(null)}>取消</WodButton>
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {cardDialogOpen && activeHero ? (
        <CharacterCardDialog
          hero={activeHero}
          detail={detail}
          onImported={onImportCharacterCard}
          onClose={() => setCardDialogOpen(false)}
        />
      ) : null}
    </section>
  );
}


