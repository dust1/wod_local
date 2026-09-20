import { useState } from "react";
import { request, useApi } from "../../api/client.js";
import { WodButton } from "../../components/ui.jsx";
import { ItemSearchBar } from "../../features/items/item-components.jsx";

export default function MarketPage({ hero, onPurchased }) {
  const empty = { query: "", professionId: "", raceId: "", slot: "", itemSet: "" };
  const [draft, setDraft] = useState(empty);
  const [filters, setFilters] = useState(empty);
  const [pageNumber, setPageNumber] = useState(1);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState("");
  // 本阶段市场只启用名称模糊搜索；其余选择框保留展示，不发送筛选参数。
  const query = new URLSearchParams({ ...(filters.query ? { q: filters.query } : {}), limit: "20", offset: String((pageNumber - 1) * 20) }).toString();
  const market = useApi(`/api/market${query ? `?${query}` : ""}`, [query]);
  async function buy(item) {
    if (!hero) return;
    setBusyId(item.id); setMessage("");
    try {
      await request("/api/market/purchase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ heroId: hero.id, itemId: item.id }) });
      setMessage(`已购买 ${item.name}，花费 1 金币。`);
      onPurchased();
    } catch (cause) { setMessage(cause.message); }
    finally { setBusyId(null); }
  }
  return <section className="market-page">
    <h1>市场</h1>
    <ItemSearchBar options={market.data?.filters ?? {}} value={draft} onChange={setDraft} onSearch={() => { setPageNumber(1); setFilters(draft); }} />
    <div className="market-summary"><span>找到 {market.data?.total ?? 0} 件物品</span><span>所有物品统一售价 <b>1 金币</b></span></div>
    {market.loading && <p className="subtle">正在查看市场货架……</p>}
    {market.error && <p className="form-error">{market.error}</p>}
    {message && <p className={message.startsWith("已购买") ? "positive" : "form-error"}>{message}</p>}
    {!market.loading && market.data?.items?.length === 0 && <p className="subtle">没有符合条件的物品。</p>}
    {market.data?.items?.length > 0 && <div className="table-scroll"><table className="wod-table market-table">
      <thead><tr><th>#</th><th>物品</th><th>装备位置</th><th>等级范围</th><th>价格</th><th>购买</th></tr></thead>
      <tbody>{market.data.items.map((item, index) => <tr key={item.id}><td>{(pageNumber - 1) * 20 + index + 1}</td><td>{item.name}</td><td>{item.slot || "—"}</td><td>{item.min_level}–{item.max_level}</td><td>{item.price} 金币</td><td><WodButton disabled={!hero || busyId !== null} onClick={() => buy(item)}>{busyId === item.id ? "购买中…" : "购买"}</WodButton></td></tr>)}</tbody>
    </table></div>}
    {(market.data?.total ?? 0) > 20 && <nav className="market-pagination" aria-label="市场分页"><WodButton disabled={pageNumber === 1} onClick={() => setPageNumber((page) => page - 1)}>上一页</WodButton><span>第 {pageNumber} / {Math.ceil(market.data.total / 20)} 页</span><WodButton disabled={pageNumber >= Math.ceil(market.data.total / 20)} onClick={() => setPageNumber((page) => page + 1)}>下一页</WodButton></nav>}
  </section>;
}


