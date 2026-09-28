import { useState } from "react";
import { request } from "../../api/client.js";
import { WodButton } from "../../components/ui.jsx";
import { SkillEffectsTable } from "../skills/skill-components.jsx";

export function ItemDetailDialog({ state, onClose }) {
  if (!state) return null;
  const item = state.data?.detail;
  const hiddenFacts = new Set(["掉落数", "相关道具", "最近拍卖信息", "最近5条掉落信息", "最低副本等级前5次掉落信息", "记录掉落数最多的5个地城", "联盟内最近10条掉落信息", "盟友团队最近10条掉落信息"]);
  const facts = Object.entries(item?.["详细属性"] ?? {}).filter(([label]) => !hiddenFacts.has(label));
  const evaluationKey = { "职业限制": "profession", "种族限定": "race", "装备要求": "requirements" };
  function factContent(label, value) {
    const conditions = state.data?.equipability?.[evaluationKey[label]];
    if (conditions) return <div className="item-fact-lines">{conditions.map((condition, index) => <span className={condition.met ? "item-condition-met" : "item-condition-unmet"} key={`${condition.text}-${index}`}>{condition.text}</span>)}</div>;
    const list = label === "物品类别" ? item?.["物品类别"] : label === "装备要求" ? item?.["装备要求"] : null;
    if (Array.isArray(list) && list.length > 0) return <div className="item-fact-lines">{list.map((entry, index) => <span key={`${entry}-${index}`}>{entry}</span>)}</div>;
    return value || <i>—</i>;
  }
  return <div className="skill-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="skill-dialog item-dialog" role="dialog" aria-modal="true" aria-labelledby="item-dialog-title">
      <header><h2 id="item-dialog-title">物品 {item?.["物品名称"] ?? state.name}</h2><button className="skill-dialog-close" onClick={onClose} aria-label="关闭物品详情">×</button></header>
      <div className="skill-dialog-scroll">{state.loading && <p className="subtle">载入物品详情……</p>}{state.error && <p className="form-error">{state.error}</p>}{item && <>
        <div className="item-detail-intro"><h1>{item["物品名称"]}</h1><p>{item["描述"] || "暂无说明。"}</p></div>
        <section className="item-detail-section"><h2>详细信息</h2><table className="wod-table item-facts-table"><tbody>{facts.map(([label, value], index) => <tr key={label} className={index % 2 ? "row1" : "row0"}><th>{label}</th><td>{factContent(label, value)}</td></tr>)}</tbody></table></section>
        <h2>作用在物品持有者上的效果</h2><p className="item-effect-note">当此物品被装备时，就会有这些奖惩效果（除非另有说明）。</p><SkillEffectsTable rows={item["作用在物品持有者上的效果"]} />
        <h2>作用在被此物品影响的目标上的效果</h2><SkillEffectsTable rows={item["作用在被此物品影响的目标上的效果"]} />
      </>}</div>
    </section>
  </div>;
}

export function InventoryTable({ items, mode, busy, onAction, onDetail, onSocket }) {
  const slotText = (item) => item.equipSlotLabel ?? item.slotLabel ?? "—";
  return <table className="wod-table inventory-table"><thead><tr><th>实例</th><th>物品</th><th>部位</th><th>等级范围</th><th>状态</th><th>操作</th></tr></thead><tbody>
    {items.map((item) => <tr key={item.instanceId}><td>#{item.instanceId}</td><td><button className="skill-name" onClick={() => onDetail(item)}>{item.name}</button></td><td>{slotText(item)}</td><td>{item.minLevel}–{item.maxLevel}</td><td>{item.equipped ? "已装备" : mode === "team" ? "团队仓库" : "角色仓库"}</td><td className="inventory-actions">
      {mode === "equipment" && <WodButton disabled={busy} onClick={() => onAction("equip", item, false)}>卸下</WodButton>}
      {mode === "hero" && <><WodButton disabled={busy || !item.canEquip} title={!item.slotId ? "该物品不可装备" : item.canEquip ? "装备到角色身上" : item.equipabilityReasons?.join("；") || "不满足装备要求"} onClick={() => onAction("equip", item, true)}>装备</WodButton>{item.runeCapacity > 0 && item.runePolarities?.length > 0 && <WodButton disabled={busy} onClick={() => onSocket(item)}>镶嵌 {item.socketedRuneItemIds.length}/{item.runeCapacity}</WodButton>}<WodButton disabled={busy} onClick={() => onAction("team", item)}>转入团队</WodButton><WodButton disabled={busy} onClick={() => onAction("sell", item)}>出售（1 金币）</WodButton></>}
      {mode === "team" && <WodButton disabled={busy} onClick={() => onAction("hero", item)}>交给角色</WodButton>}
    </td></tr>)}
  </tbody></table>;
}

function RuneEffects({ title, holder, target }) {
  return <section className="rune-effects"><h3>{title}</h3>
    <h4>作用在物品持有者上的效果</h4>{holder?.length ? <SkillEffectsTable rows={holder} /> : <p className="subtle">无</p>}
    <h4>作用在被此物品影响的目标上的效果</h4>{target?.length ? <SkillEffectsTable rows={target} /> : <p className="subtle">无</p>}
  </section>;
}

function AncientRuneDialog({ item, runeItems, heroId, onClose, onChanged }) {
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const remaining = item.runeCapacity - item.socketedRuneItemIds.length;
  const full = remaining === 0;
  const statusText = item.runeStatus === "wrongPolarity" ? "符文组合与遗物极性不符，不追加效果。"
    : item.runeStatus === "unsupported" ? "组合效果资料暂不可用，当前不追加效果。"
      : full && !item.runeCombination ? "符文未匹配组合，不追加效果。" : null;
  async function update(method) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await request(`/api/heroes/${heroId}/inventory/${item.instanceId}/runes`, method === "POST" ? {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runeInstanceIds: selected }),
      } : { method });
      onChanged(method === "POST" ? result.inventory : result);
      setSelected([]);
      setNotice(method === "POST" ? "镶嵌完成，已消耗所选符文。" : "已拆卸全部符文，符文不返还。");
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  return <div className="skill-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="skill-dialog item-dialog rune-dialog" role="dialog" aria-modal="true" aria-labelledby="rune-dialog-title">
      <header><h2 id="rune-dialog-title">镶嵌 · {item.name} #{item.instanceId}</h2><button className="skill-dialog-close" onClick={onClose} aria-label="关闭镶嵌页面">×</button></header>
      <div className="skill-dialog-scroll">
        <p>极性：{item.runePolarities.join("、")}；孔位：{item.socketedRuneItemIds.length}/{item.runeCapacity}</p>
        <p>已镶嵌：{item.socketedRuneNames.length ? item.socketedRuneNames.join("、") : "无"}</p>
        <p>组合：{item.runeCombination ? `${item.runeCombination.name}（${item.runeCombination.polarity}）` : "无"}</p>
        {statusText && <p className="rune-warning">{statusText}</p>}
        <RuneEffects title="物品原有效果" holder={item.baseHolderEffects} target={item.baseTargetEffects} />
        <RuneEffects title="符文追加效果" holder={item.runeHolderEffects} target={item.runeTargetEffects} />
        <section className="rune-picker"><h3>选择角色仓库符文（还可镶嵌 {remaining} 枚）</h3>
          {runeItems.length ? <div className="rune-options">{runeItems.map((rune) => <label key={rune.instanceId}>
            <input type="checkbox" checked={selected.includes(rune.instanceId)} disabled={busy || (selected.length >= remaining && !selected.includes(rune.instanceId))}
              onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, rune.instanceId] : ids.filter((id) => id !== rune.instanceId))} />
            {rune.name} #{rune.instanceId}
          </label>)}</div> : <p className="subtle">当前角色仓库没有传古符文。</p>}
          <p className="subtle">镶嵌会消耗所选符文；拆卸后符文不返还。组合由服务端按种类、数量和极性判定。</p>
          {notice && <p role="status">{notice}</p>}{error && <p className="form-error" role="alert">{error}</p>}
          <div className="button-row"><WodButton disabled={busy || selected.length === 0} onClick={() => update("POST")}>镶嵌所选符文</WodButton>
            <WodButton disabled={busy || item.socketedRuneItemIds.length === 0} onClick={() => update("DELETE")}>拆卸全部（不返还）</WodButton></div>
        </section>
      </div>
    </section>
  </div>;
}

export function InventoryPage({ title, mode, inventory, loading, busy = false, error, onAction, onRunesChanged, hint, heroId }) {
  const [detailState, setDetailState] = useState(null);
  const [socketInstanceId, setSocketInstanceId] = useState(null);
  const emptyFilters = { query: "", professionId: "", raceId: "", slot: "", itemSet: "" };
  const [filterDraft, setFilterDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const all = inventory?.items ?? [];
  const socketItem = all.find((item) => item.instanceId === socketInstanceId);
  const options = inventory?.filters ?? {};
  const professionName = options.professions?.find((entry) => String(entry.id) === filters.professionId)?.name;
  const raceName = options.races?.find((entry) => String(entry.id) === filters.raceId)?.name;
  const items = all.filter((item) => {
    if (mode === "equipment" ? !item.equipped : mode === "hero" ? item.equipped : false) return false;
    if (mode !== "hero") return true;
    if (filters.query && !item.name.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase())) return false;
    if (filters.slot && item.slotId !== filters.slot) return false;
    if (filters.itemSet && item.itemSet !== filters.itemSet) return false;
    if (professionName) {
      const only = item.professionRestriction?.includes("只适用于");
      const excluded = item.professionRestriction?.includes("不") && item.professionRestriction?.includes("适用于");
      if ((only && !item.allowedProfessions.includes(professionName)) || (excluded && item.allowedProfessions.includes(professionName))) return false;
    }
    if (raceName && item.raceRestriction && !item.raceRestriction.includes("任何种族") && !item.raceRestriction.includes(raceName)) return false;
    return true;
  });
  async function showDetail(item) {
    setDetailState({ name: item.name, loading: true });
    try { setDetailState({ name: item.name, loading: false, data: await request(`/api/item-details/${item.itemId}${heroId ? `?heroId=${heroId}` : ""}`) }); }
    catch (cause) { setDetailState({ name: item.name, loading: false, error: cause.message }); }
  }
  return <section className="inventory-page"><h1>{title}</h1>
    {mode === "hero" && <ItemSearchBar options={options} value={filterDraft} onChange={setFilterDraft} onSearch={() => setFilters(filterDraft)} />}
    {mode === "hero" && <div className="market-summary"><span>找到 {items.length} 件角色仓库物品</span><span>可装备 <b>{items.filter((item) => item.canEquip).length}</b> 件</span></div>}
    <p className="subtle">{hint ?? ""}{all.length > 0 && <>共 {all.length} 件实例，其中已装备 {all.filter((item) => item.equipped).length} 件。</>}</p>
    {loading && <p className="subtle">载入中……</p>}{error && <p className="form-error">{error}</p>}
    {!loading && items.length === 0 && <p className="subtle">这里还没有物品。</p>}
    {items.length > 0 && <InventoryTable items={items} mode={mode} busy={busy || loading} onAction={onAction} onDetail={showDetail} onSocket={(item) => setSocketInstanceId(item.instanceId)} />}
    <ItemDetailDialog state={detailState} onClose={() => setDetailState(null)} />
    {mode === "hero" && socketItem && <AncientRuneDialog key={socketItem.instanceId} item={socketItem} runeItems={all.filter((item) => item.isAncientRune && !item.equipped)} heroId={heroId} onClose={() => setSocketInstanceId(null)} onChanged={onRunesChanged} />}
  </section>;
}

/** 市场、角色仓库与团队仓库共用的物品搜索栏。 */
export function ItemSearchBar({ options, value, onChange, onSearch }) {
  const field = (key, label, values) => <label><span>{label}</span><select value={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.value })}>
    <option value="">全部</option>{values.map((entry) => <option key={entry.id ?? entry.name} value={entry.id ?? entry.name}>{entry.name}</option>)}
  </select></label>;
  return <form className="item-search-panel" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
    <div className="item-search-name"><label><span>名称:</span><input value={value.query} onChange={(event) => onChange({ ...value, query: event.target.value })} /></label><WodButton type="submit">开始搜索</WodButton></div>
    <div className="item-search-fields">
      {field("professionId", "职业", options.professions ?? [])}
      {field("raceId", "种族", options.races ?? [])}
      {field("slot", "装备位置", options.equipSlots ?? [])}
      {field("itemSet", "所属套装", options.itemSets ?? [])}
    </div>
  </form>;
}
