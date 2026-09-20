// 人物卡导入 / 导出弹窗。
//
// 导入：粘贴游戏导出的人物卡 BBCode，服务端解析后把卡面的属性、技能与匹配到的装备
// 覆盖到所选角色上；预览与实际写入共用同一套匹配结果，因此这里展示什么就会写入什么。
// 导出：把角色现状（基础属性 / 当前加点 / 已穿戴物品）写成同样格式的 BBCode，可复制走。
//
// 角色卡领域规则（解析、生成）在 game/domain/character-card.mjs，本组件只负责交互。

import { useCallback, useEffect, useState } from "react";
import { request } from "../../api/client.js";
import { WodButton } from "../../components/ui.jsx";

const MODE_IMPORT = "import";
const MODE_EXPORT = "export";

function ChangeBadge({ changed }) {
  return changed ? <span className="card-change">待覆盖</span> : <span className="card-same">无变化</span>;
}

function ImportPreview({ preview }) {
  if (!preview) return null;
  const { summary } = preview;
  return (
    <div className="character-card-preview">
      <section className="character-card-summary">
        <h3>解析结果</h3>
        <ul>
          <li>属性：{preview.attributes.length} 项，其中 {summary.attributeChanges} 项需要覆盖</li>
          <li>技能：{preview.skills.length} 项，其中 {summary.skillChanges} 项需要改写</li>
          <li>等级：{preview.level.current} → {preview.level.card}</li>
          <li>装备：卡面 {preview.equipment.length + preview.skippedEquipment.length} 件，本地已匹配 {summary.equipmentCount} 件</li>
          <li className="character-card-note">等级、基础属性和技能加点按卡面覆盖；装备不做穿戴校验，仅跳过本地物品表中不存在的名称。</li>
        </ul>
      </section>

      <h3>属性</h3>
      <div className="table-scroll">
        <table className="wod-table character-card-table">
          <thead><tr><th>属性</th><th>卡面基础值</th><th>卡面已训练值</th><th>当前基础值</th><th>导入动作</th></tr></thead>
          <tbody>
            {preview.attributes.map((entry) => (
              <tr key={entry.key}>
                <td>{entry.label}</td>
                <td className="character-card-value">{entry.cardBase}</td>
                <td className="subtle">{entry.cardTrained ?? "—"}</td>
                <td className="subtle">{entry.current ?? "—"}</td>
                <td>{entry.valid ? <ChangeBadge changed={entry.changes} /> : <span className="card-skip">数值无效，跳过</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview.derived.length > 0 && (
        <>
          <h3>卡面数值（英雄等级会覆盖，其余仅对照）</h3>
          <div className="table-scroll">
            <table className="wod-table character-card-table">
              <thead><tr><th>项目</th><th>卡面值</th><th>卡面已训练值</th><th>当前值</th></tr></thead>
              <tbody>
                {preview.derived.map((entry) => (
                  <tr key={entry.label}>
                    <td>{entry.label}</td>
                    <td className="character-card-value">{entry.cardBase ?? "—"}</td>
                    <td className="subtle">{entry.cardTrained ?? "—"}</td>
                    <td className="subtle">{entry.current ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>技能加点</h3>
      {preview.skills.length === 0 && <p className="subtle">卡面技能都不属于该角色的职业与种族技能。</p>}
      {preview.skills.length > 0 && (
        <div className="table-scroll">
          <table className="wod-table character-card-table">
            <thead><tr><th>技能</th><th>训练类别</th><th>解锁等级</th><th>当前等级</th><th>卡面等级</th><th>导入动作</th></tr></thead>
            <tbody>
              {preview.skills.map((entry) => (
                <tr key={entry.sourceSkillId} className={entry.unlocked ? "" : "skill-locked"}>
                  <td>{entry.name}</td>
                  <td className="subtle">{({ basic: "基本", additional: "附加", special: "特殊", talent: "天赋" })[entry.trainingClass] ?? entry.trainingClass}</td>
                  <td className="subtle">{entry.learnLevel}{entry.unlocked ? "" : "（未解锁）"}</td>
                  <td className="subtle">{entry.currentLevel}</td>
                  <td className="character-card-value">{entry.cardLevel}</td>
                  <td><ChangeBadge changed={entry.changes} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview.skippedSkills.length > 0 && (
        <details className="character-card-details">
          <summary>未匹配的技能（{preview.skippedSkills.length}）</summary>
          <ul>{preview.skippedSkills.map((entry) => <li key={entry.name}><b>{entry.name}</b>（卡面等级 {entry.level}）：{entry.reason}</li>)}</ul>
        </details>
      )}

      <h3>装备</h3>
      {preview.equipment.length === 0 && <p className="subtle">卡面装备在本地物品表里都没有同名物品；确认后会直接跳过。</p>}
      {preview.equipment.length > 0 && (
        <div className="table-scroll">
          <table className="wod-table character-card-table">
            <thead><tr><th>卡面部位</th><th>物品</th><th>装入槽位</th><th>当前状态</th></tr></thead>
            <tbody>
              {preview.equipment.map((entry) => (
                <tr key={`${entry.targetSlotId}-${entry.instanceId}`}>
                  <td>{entry.slotLabel}</td>
                  <td>{entry.name}</td>
                  <td className="character-card-value">{entry.targetSlotId}</td>
                  <td className="subtle">{entry.alreadyEquipped ? "已在该槽位" : ({ hero: "复用角色仓库", team: "复用团队仓库", catalog: "按物品表新建" })[entry.inventorySource] ?? "待穿戴"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview.skippedEquipment.length > 0 && (
        <details className="character-card-details" open>
          <summary>未导入的装备（{preview.skippedEquipment.length}）</summary>
          <ul>{preview.skippedEquipment.map((entry) => <li key={`${entry.slotLabel}-${entry.name}`}><b>{entry.slotLabel}：{entry.name}</b>：{entry.reason}</li>)}</ul>
        </details>
      )}
      {preview.warnings.length > 0 && (
        <details className="character-card-details">
          <summary>解析告警（{preview.warnings.length}）</summary>
          <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function ImportResult({ result }) {
  if (!result) return null;
  const { equipped, failed, skipped } = result;
  return (
    <section className="character-card-result" role="status">
      <h3>导入完成</h3>
      <p className="positive">已穿戴 {equipped.length} 件装备，覆盖属性与技能加点完成。</p>
      {failed.length > 0 && <details className="character-card-details" open><summary>穿戴失败的装备（{failed.length}）</summary><ul>{failed.map((entry) => <li key={`${entry.targetSlotId}-${entry.instanceId}`}><b>{entry.name}</b>：{entry.reason}</li>)}</ul></details>}
      {skipped.length > 0 && <details className="character-card-details"><summary>未匹配的装备（{skipped.length}）</summary><ul>{skipped.map((entry) => <li key={`${entry.slotLabel}-${entry.name}`}><b>{entry.slotLabel}：{entry.name}</b>：{entry.reason}</li>)}</ul></details>}
    </section>
  );
}

export default function CharacterCardDialog({ hero, detail, onImported, onClose }) {
  const [mode, setMode] = useState(MODE_IMPORT);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [exportText, setExportText] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const parsePreview = useCallback(async () => {
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      setPreview(await request(`/api/heroes/${hero.id}/character-card/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }));
    } catch (cause) {
      setPreview(null);
      setError(cause.message);
    } finally {
      setBusy(null);
    }
  }, [hero.id, text]);

  async function apply() {
    setBusy("apply");
    setError(null);
    try {
      const response = await request(`/api/heroes/${hero.id}/character-card`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setPreview(response.characterCard?.preview ?? null);
      setResult(response.characterCard?.applied ?? null);
      onImported?.(response);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(null);
    }
  }

  const loadExport = useCallback(async () => {
    setBusy("export");
    setError(null);
    try {
      const exported = await request(`/api/heroes/${hero.id}/character-card`);
      setExportText(exported.text);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(null);
    }
  }, [hero.id]);

  useEffect(() => {
    if (mode === MODE_EXPORT && exportText === "") loadExport();
  }, [mode, exportText, loadExport]);

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("浏览器拒绝了剪贴板写入，请手动全选复制。");
    }
  }

  function useExportAsInput() {
    setText(exportText);
    setMode(MODE_IMPORT);
    setPreview(null);
    setResult(null);
  }

  return (
    <div className="skill-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="skill-dialog character-card-dialog" role="dialog" aria-modal="true" aria-labelledby="character-card-title">
        <header>
          <h2 id="character-card-title">人物卡 · {hero.name}</h2>
          <button className="skill-dialog-close" disabled={Boolean(busy)} onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="character-card-tabs" role="tablist">
          <button role="tab" aria-selected={mode === MODE_IMPORT} className={mode === MODE_IMPORT ? "selected" : ""} onClick={() => setMode(MODE_IMPORT)}>导入人物卡</button>
          <button role="tab" aria-selected={mode === MODE_EXPORT} className={mode === MODE_EXPORT ? "selected" : ""} onClick={() => setMode(MODE_EXPORT)}>导出人物卡</button>
        </div>
        <div className="skill-dialog-scroll">
          {mode === MODE_IMPORT && (
            <>
              <p className="character-card-hint">
                把游戏里导出的人物卡 BBCode 整段粘贴到下面。导入会用卡面的<strong>方括号外数字</strong>覆盖基础属性、
                用卡面等级覆盖技能加点，并从物品表匹配卡面装备、创建新实例后穿戴；角色当前装备会卸下并移回角色仓库，导入不消耗经验。
              </p>
              <textarea
                className="character-card-input"
                value={text}
                spellCheck="false"
                disabled={Boolean(busy)}
                placeholder="[table border=1]&#10;[tr][td][color=orange]力量[/color][/td][td]2[6][/td]…&#10;[/table]"
                onChange={(event) => { setText(event.target.value); setPreview(null); setResult(null); setError(null); }}
              />
              <div className="button-row">
                <WodButton disabled={Boolean(busy) || text.trim() === ""} onClick={parsePreview}>{busy === "preview" ? "解析中……" : "解析并预览"}</WodButton>
                <WodButton disabled={Boolean(busy) || !preview} onClick={apply}>{busy === "apply" ? "导入中……" : "确认导入"}</WodButton>
                <WodButton disabled={Boolean(busy) || text === ""} onClick={() => { setText(""); setPreview(null); setResult(null); setError(null); }}>清空</WodButton>
              </div>
              {error && <p className="form-error">{error}</p>}
              {result && <ImportResult result={result} />}
              <ImportPreview preview={preview} />
            </>
          )}
          {mode === MODE_EXPORT && (
            <>
              <p className="character-card-hint">
                下面是当前角色的 BBCode 人物卡：属性写成「基础值[当前值]」，技能写成训练等级，装备按部位列出。
                {detail?.derived ? ` 生效体力 ${detail.derived.healthMax}、法力 ${detail.derived.manaMax}。` : ""}
              </p>
              <textarea className="character-card-input" value={exportText} readOnly spellCheck="false" placeholder={busy === "export" ? "正在生成……" : ""} />
              <div className="button-row">
                <WodButton disabled={Boolean(busy) || exportText === ""} onClick={copyExport}>{copied ? "已复制" : "复制人物卡"}</WodButton>
                <WodButton disabled={Boolean(busy) || exportText === ""} onClick={loadExport}>重新生成</WodButton>
                <WodButton disabled={Boolean(busy) || exportText === ""} onClick={useExportAsInput}>填入导入框</WodButton>
              </div>
              <p className="subtle">装备的品阶标记（`:g0:`）不由服务端编造：导出统一省略，导入时按名称匹配，不影响属性与技能。</p>
              {error && <p className="form-error">{error}</p>}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
