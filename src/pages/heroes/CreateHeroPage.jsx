import { useState } from "react";
import { request } from "../../api/client.js";
import { WodButton } from "../../components/ui.jsx";

export default function CreateHeroPage({ catalog, onCreated, onCancel }) {
  const [form, setForm] = useState({ name: "", raceId: "", professionId: "", gender: "male" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const hero = await request("/api/heroes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      onCreated(hero);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="create-hero-page">
      <h1>创建新英雄</h1>
      <p className="subtle">选择将决定英雄的初始身份；属性与技能成长将在后续训练中完成。</p>
      <form className="hero-create-form" onSubmit={submit}>
        <label>角色名称<input maxLength="24" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="2–24 个字符" /></label>
        <label>种族<select required value={form.raceId} onChange={(event) => setForm({ ...form, raceId: event.target.value })}><option value="">请选择种族</option>{(catalog?.races ?? []).map((race) => <option key={race.id} value={race.id}>{race.name}</option>)}</select></label>
        <label>初始职业<select required value={form.professionId} onChange={(event) => setForm({ ...form, professionId: event.target.value })}><option value="">请选择职业</option>{(catalog?.professions ?? []).map((profession) => <option key={profession.id} value={profession.id}>{profession.name}</option>)}</select></label>
        <fieldset><legend>性别</legend><label><input type="radio" name="gender" checked={form.gender === "male"} onChange={() => setForm({ ...form, gender: "male" })} /> 男</label><label><input type="radio" name="gender" checked={form.gender === "female"} onChange={() => setForm({ ...form, gender: "female" })} /> 女</label></fieldset>
        {error && <p className="form-error">{error}</p>}
        <div className="button-row"><WodButton type="submit" disabled={busy}>{busy ? "创建中……" : "创建英雄"}</WodButton><WodButton onClick={onCancel}>返回</WodButton></div>
      </form>
    </section>
  );
}


