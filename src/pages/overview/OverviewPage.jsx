export default function OverviewPage({ meta, hero, detail }) {
  if (!meta) return <section><h1>英雄概况</h1><p className="subtle">载入中……</p></section>;
  return (
    <section>
      <h1>英雄概况</h1>
      <div className="two-columns">
        <div>
          <h2>运行信息</h2>
          <dl className="derived-panel">
            <dt>规则版本</dt><dd>{meta.rulesetVersion}</dd>
            <dt>内容版本</dt><dd>{meta.contentVersion}</dd>
            <dt>生成时间</dt><dd>{meta.generatedAt ?? "—"}</dd>
            <dt>数据库 schema</dt><dd>{meta.schemaMeta?.schema_version ?? "—"}</dd>
            <dt>技能定义</dt><dd>{meta.counts.skills}</dd>
            <dt>物品定义</dt><dd>{meta.counts.items}</dd>
            <dt>人工校正</dt><dd>{meta.counts.overrides}</dd>
            <dt>实验策略</dt><dd>{meta.experimentalPolicies.length}</dd>
          </dl>
          {meta.generatedFiles.length > 0 && <p className="subtle">生成文件：{meta.generatedFiles.join("、")}</p>}
          {meta.warnings.length > 0 && <p className="warning">数据告警：{meta.warnings.slice(0, 8).join("；")}</p>}
        </div>
        <div>
          <h2>当前英雄</h2>
          <dl className="derived-panel">
            <dt>名称</dt><dd>{hero?.name}</dd>
            <dt>职业 / 种族</dt><dd>{hero?.profession} / {hero?.race}</dd>
            <dt>等级</dt><dd>{hero?.level}</dd>
            <dt>体力 / 法力上限</dt><dd>{detail?.derived.healthMax} / {detail?.derived.manaMax}</dd>
            <dt>先攻平均值</dt><dd>{detail?.derived.initiative}</dd>
            <dt>已学技能</dt><dd>{detail?.skills.length}</dd>
          </dl>
        </div>
      </div>
    </section>
  );
}


