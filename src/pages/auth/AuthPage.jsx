import { useState } from "react";
import { request } from "../../api/client.js";
import { WodButton } from "../../components/ui.jsx";

export default function AuthPage({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      onAuthenticated();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-logo" aria-label="World of Dungeons" />
        <h1>{mode === "login" ? "进入地下城世界" : "创建冒险者账号"}</h1>
        <div className="settings-tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>注册</button>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <label>用户名<input autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
          <label>密码<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
          {error && <p className="form-error">{error}</p>}
          <WodButton type="submit" disabled={busy}>{busy ? "处理中……" : mode === "login" ? "登录" : "注册并登录"}</WodButton>
        </form>
        <p className="subtle">用户名 3–24 位，密码至少 8 位。账号与角色数据仅保存在本地数据库。</p>
      </section>
    </main>
  );
}


