import { useEffect, useState } from "react";
import { request } from "../../api/client.js";
import { WodButton } from "../../components/ui.jsx";
import { ItemDetailDialog } from "../../features/items/item-components.jsx";
const assetRoot = "/assets/wod/css/skins/skin-4/images";

export default function EquipmentPage({ hero, equipment, loading, busy, error, onApply }) {
  const [draft, setDraft] = useState({});
  const [detailState, setDetailState] = useState(null);
  const slots = equipment?.slots ?? [];
  useEffect(() => {
    setDraft(Object.fromEntries(slots.map((slot) => [slot.id, slot.selectedInstanceId == null ? "" : String(slot.selectedInstanceId)])));
  }, [equipment]);
  const changed = slots.filter((slot) => String(slot.selectedInstanceId ?? "") !== String(draft[slot.id] ?? ""));
  const columns = [slots.filter((slot) => slot.column === "left"), slots.filter((slot) => slot.column === "right")];
  function selectedItem(slot) {
    const instanceId = Number(draft[slot.id]);
    return Number.isFinite(instanceId) && instanceId > 0 ? slot.options.find((item) => item.instanceId === instanceId) ?? null : null;
  }
  async function showDetail(item) {
    if (!item) return;
    setDetailState({ name: item.name, loading: true });
    try { setDetailState({ name: item.name, loading: false, data: await request(`/api/item-details/${item.itemId}?heroId=${hero.id}`) }); }
    catch (cause) { setDetailState({ name: item.name, loading: false, error: cause.message }); }
  }
  return <section className="equipment-page">
    <header className="equipment-heading">
      <div><h1>装备</h1><p>{hero ? `${hero.name} 的装备配置` : "请先创建或选择一个英雄。"}</p></div>
      <span className={changed.length ? "equipment-dirty is-dirty" : "equipment-dirty"}>{changed.length ? `待应用 ${changed.length} 项` : "已应用"}</span>
    </header>
    <p className="equipment-note">先为多个槽位选择装备，再一次性应用改动。下拉选项仅包含角色仓库中适合该槽位并通过可装备校验的物品。</p>
    {loading && <p className="subtle">载入装备槽位……</p>}{error && <p className="form-error">{error}</p>}
    {!loading && slots.length > 0 && <div className="equipment-board">
      {columns.map((column, columnIndex) => <div className="equipment-column" key={columnIndex}>
        {column.map((slot) => { const selected = selectedItem(slot); return <div className={`equipment-slot${slot.options.length === 0 && slot.selectedInstanceId == null ? " is-empty" : ""}`} key={slot.id}>
          <span className="equipment-slot-label">{slot.label}</span>
          {slot.options.length > 0 || slot.selectedInstanceId != null ? <>
            <span className="equipment-ready" title="该槽位的选项已经过可装备校验">可选</span>
            <select aria-label={slot.label} value={draft[slot.id] ?? ""} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, [slot.id]: event.target.value }))}>
              <option value="">— 卸下 —</option>
              {slot.options.map((item) => <option key={item.instanceId} value={item.instanceId}>{item.name}</option>)}
            </select>
            <a className={`equipment-info-link${selected ? "" : " is-disabled"}`} href={selected ? "#item-detail" : undefined} aria-disabled={!selected} title={selected ? `查看 ${selected.name} 的物品详情` : "当前槽位没有装备物品"} onClick={(event) => { event.preventDefault(); if (selected) showDetail(selected); }}>
              <img className="equipment-info" src={`${assetRoot}/icons/inf.gif`} alt="" />
            </a>
          </> : <span className="equipment-empty-text" aria-hidden="true" />}
        </div>; })}
      </div>)}
    </div>}
    <div className="equipment-actions">
      <WodButton disabled={busy || loading || changed.length === 0} onClick={() => onApply(slots.map((slot) => ({ slotId: slot.id, instanceId: draft[slot.id] === "" ? null : Number(draft[slot.id]) })))}>{busy ? "正在应用……" : "应用改动"}</WodButton>
      <button className="equipment-reset" disabled={busy || changed.length === 0} onClick={() => setDraft(Object.fromEntries(slots.map((slot) => [slot.id, slot.selectedInstanceId == null ? "" : String(slot.selectedInstanceId)])))}>撤销未应用改动</button>
    </div>
    <ItemDetailDialog state={detailState} onClose={() => setDetailState(null)} />
  </section>;
}


