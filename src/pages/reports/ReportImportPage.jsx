import { useState } from "react";
import { request, useApi } from "../../api/client.js";
import { WodButton } from "../../components/ui.jsx";

export default function ReportImportPage() {
  const available = useApi("/api/reports/available");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // 设计文档 §2.3 的期望节点数
  const expected = {
    "level1.html": { rep_round_headline: 6, rep_status_table: 14, rep_action: 2074, rep_initiative: 2130, rep_mana_cost: 170, rep_gain: 74, rep_loss: 7 },
    "level2.html": { rep_round_headline: 2, rep_status_table: 6, rep_action: 1710, rep_initiative: 1732, rep_mana_cost: 1134, rep_gain: 29, rep_loss: 58 },
  };

  async function runImport(reportId, file) {
    setBusy(true);
    setError(null);
    try {
      setResult(await request("/api/reports/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId, file }),
      }));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>战报导入</h1>
      <p className="subtle">原始战报是只读事实来源，导入器按语义容器解析，不识别片段会全部记录为告警。</p>
      <table className="wod-table wide">
        <thead><tr><th>文件</th><th>大小</th><th /></tr></thead>
        <tbody>
          {(available.data?.files ?? []).map((entry) => (
            <tr key={`${entry.reportId}/${entry.file}`}>
              <td>{entry.reportId}/{entry.file}</td>
              <td>{(entry.sizeBytes / 1024 / 1024).toFixed(2)} MB</td>
              <td><WodButton disabled={busy} onClick={() => runImport(entry.reportId, entry.file)}>导入</WodButton></td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="warning">{error}</p>}
      {result && (
        <>
          <h2>{result.sourceFile}　{dungeonLabel(result)}</h2>
          <p className="subtle">文件摘要 {result.sourceFileHash}　层号 {result.levelNumber ?? "—"}</p>
          <table className="wod-table wide">
            <thead><tr><th>节点类</th><th>原始计数</th><th>文档 §2.3 期望</th><th>一致</th></tr></thead>
            <tbody>
              {Object.entries(expected[result.sourceFile.split("/").pop()] ?? {}).map(([key, value]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{result.counts.raw[key]}</td>
                  <td>{value}</td>
                  <td>{result.counts.raw[key] === value ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>语义解析结果</h2>
          <table className="wod-table wide">
            <thead><tr><th>回合</th><th>状态区块</th><th>回合前</th><th>恢复</th><th>先攻技能</th><th>已排行动</th><th>主行动</th><th>法力消耗</th></tr></thead>
            <tbody>
              {(result.roundSummaries ?? []).map((round) => (
                <tr key={round.round}>
                  <td>{round.round}</td>
                  <td>{round.statusBlocks.map((block) => `${block.side}:${block.units}`).join(" ")}</td>
                  <td>{round.preRound}</td>
                  <td>{round.regeneration}</td>
                  <td>{round.initiativeSkills}</td>
                  <td>{round.scheduledActions}</td>
                  <td>{round.actions}</td>
                  <td>{round.manaCosts}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="subtle">告警 {result.parseWarnings.length} 条，未识别片段 {result.unparsedFragments.length} 段。</p>
          {result.parseWarnings.length > 0 && (
            <details className="trace">
              <summary>告警明细</summary>
              <ol>{result.parseWarnings.map((warning, index) => <li key={index}><span>{warning.code}</span><b>{warning.message}</b><em>{warning.region ?? ""}</em></li>)}</ol>
            </details>
          )}
        </>
      )}
    </section>
  );
}


