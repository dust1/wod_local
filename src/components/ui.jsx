export function WodButton({ children, onClick, disabled = false, title, type = "button" }) {
  return <button type={type} className="wod-button" onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}

export function Badge({ kind = "info", children, title }) {
  return <span className={`badge badge-${kind}`} title={title}>{children}</span>;
}

export function ExperimentalBadge({ label }) {
  return <Badge kind="experimental" title="该规则属于 C/D 级待验证项，实现为可替换策略">{label ?? "实验"}</Badge>;
}

export function Trace({ steps, title }) {
  if (!steps || steps.length === 0) return null;
  return (
    <details className="trace">
      <summary>{title ?? "计算步骤"}</summary>
      <ol>
        {steps.map((step, index) => (
          <li key={`${step.label}-${index}`}>
            <span>{step.label}</span>
            <b>{typeof step.value === "number" ? Number(step.value.toFixed ? step.value.toFixed(4) : step.value) : step.value}</b>
            {step.note ? <em>{step.note}</em> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function StoneBlock({ title, children }) {
  return <section className="stone-block"><h3>{title}</h3><div>{children}</div></section>;
}

