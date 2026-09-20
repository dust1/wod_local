import { useApi } from "../../api/client.js";
import { ExperimentalBadge } from "../../components/ui.jsx";

export default function RulesPage() {
  const { data, loading, error } = useApi("/api/rules");
  if (error) return <section><h1>规则诊断</h1><p className="warning">{error}</p></section>;
  if (loading) return <section><h1>规则诊断</h1><p className="subtle">载入中……</p></section>;
  const statusLabels = { open: "待证据", hypothesis: "实验假设", verified: "已验证", rejected: "已否定" };
  return (
    <section>
      <h1>规则诊断</h1>
      <p className="subtle">下列规则尚未有足够证据，实现为可替换策略；任何数值结果都可以展开查看计算步骤。</p>
      <table className="wod-table wide">
        <thead><tr><th>#</th><th>问题</th><th>状态</th><th>实验策略</th><th>证据</th></tr></thead>
        <tbody>
          {(data?.questions ?? []).map((question, index) => (
            <tr key={question.id}>
              <td>{index + 1}</td>
              <td>{question.question}</td>
              <td>{statusLabels[question.status] ?? question.status}</td>
              <td>{question.experimentalPolicy ? <ExperimentalBadge label={question.experimentalPolicy} /> : <span className="subtle">未实现</span>}</td>
              <td>{question.evidence.map((item) => `${item.ref}${item.note ? `（${item.note}）` : ""}`).join("；")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>策略注册表</h2>
      <table className="wod-table wide">
        <thead><tr><th>策略</th><th>证据等级</th><th>说明</th><th>关联问题</th></tr></thead>
        <tbody>
          {(data?.policies ?? []).map((policy) => (
            <tr key={policy.id}>
              <td>{policy.id}</td>
              <td>{policy.evidenceLevel}</td>
              <td>{policy.description}</td>
              <td>{policy.ruleQuestionId ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}


