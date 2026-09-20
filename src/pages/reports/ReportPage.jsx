import { useState } from "react";
import { request, useApi } from "../../api/client.js";
import { Badge, WodButton } from "../../components/ui.jsx";
import { BattleReport, ExplorationSnapshot, explorationStatusLabel, runResultLabel } from "../../features/reports/report-components.jsx";

/**
 * 删除战报的二次确认弹窗。
 * 删除会同时移除数据库记录与 data/dungeon_report 下的战报 JSON，且不可撤销，
 * 因此所有删除入口都必须先经过这里。
 */
function DeleteRunDialog({ entry, busy, error, onConfirm, onClose }) {
  return (
    <div className="skill-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="skill-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-run-title">
        <header>
          <h2 id="delete-run-title">删除战报 #{entry.dungeonRunId}</h2>
          <button className="skill-dialog-close" disabled={busy} onClick={onClose} aria-label="关闭删除战报确认">×</button>
        </header>
        <div className="skill-dialog-scroll">
          <p>地城：<strong>{entry.dungeonName}</strong>　状态：{explorationStatusLabel(entry.status)}　结果：{runResultLabel(entry.result)}　创建时间：{entry.createdAt ?? "—"}</p>
          <p>会同时删除这条记录名下的 {(entry.battleCount ?? 0)} 份战斗战报，以及 data/dungeon_report 下对应的战报 JSON 文件。</p>
          <p className="warning">删除后无法恢复，也不能再从战报列表打开这条记录。</p>
          {error ? <p className="warning" role="alert">{error}</p> : null}
          <div className="button-row">
            <WodButton disabled={busy} onClick={onConfirm}>{busy ? "删除中……" : "确认删除"}</WodButton>
            <WodButton disabled={busy} onClick={onClose}>取消</WodButton>
          </div>
        </div>
      </section>
    </div>
  );
}

function ReportListPage({ onOpen, highlightRunId, notice }) {
  const { data, loading, error, reload } = useApi("/api/dungeons/runs?limit=20");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [message, setMessage] = useState(null);

  /** 删除一条记录：数据库行与本地 JSON 由服务端一并清理，成功后重新取列表。 */
  async function confirmDelete() {
    const entry = pendingDelete;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await request(`/api/dungeons/runs/${entry.dungeonRunId}`, { method: "DELETE" });
      setPendingDelete(null);
      const files = result.removedReportFiles?.length ?? 0;
      setMessage(`已删除战报 #${entry.dungeonRunId}（${entry.dungeonName}）：战斗战报 ${(result.deletedBattleIds ?? []).length} 份${files ? `，战报 JSON 文件 ${files} 个` : ""}。`);
      reload();
    } catch (cause) {
      setDeleteError(cause.message);
      // 服务端说记录不存在时列表可能已经过期，重新取一遍让页面与数据库一致。
      reload();
    } finally {
      setDeleting(false);
    }
  }

  if (error) return <section><h1>战报</h1><p className="warning">{error}</p></section>;
  if (loading) return <section><h1>战报</h1><p className="subtle">载入中……</p></section>;
  const runs = data ?? [];
  return (
    <section>
      <h1>战报</h1>
      <p className="subtle">每次探索生成一条记录：先把战斗规则输入（账号全部角色 + 行动设置 + 地城）固化下来，再由战斗引擎回填结果与奖励。</p>
      {notice ? <p className="positive" role="status">{notice}</p> : null}
      {message ? <p className="positive" role="status">{message}</p> : null}
      {runs.length === 0 && <p className="subtle">还没有战报记录。先在地城页面选择一个地城开始探索。</p>}
      {runs.length > 0 && (
        <table className="wod-table wide">
          <thead><tr><th>#</th><th>地城</th><th>状态</th><th>队伍</th><th>结果</th><th>经验 / 金币</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>
            {runs.map((entry) => (
              <tr key={entry.dungeonRunId} className={entry.dungeonRunId === highlightRunId ? "report-row-current" : undefined}>
                <td>{entry.dungeonRunId}</td>
                <td>{entry.dungeonName}{entry.dungeonRunId === highlightRunId ? " " : ""}{entry.dungeonRunId === highlightRunId && <Badge kind="info">本次探索</Badge>}</td>
                <td>{explorationStatusLabel(entry.status)}</td>
                <td>{entry.partyCount > 0 ? `${entry.partyCount} 名角色` : "—"}</td>
                <td>{runResultLabel(entry.result)}</td>
                <td>{entry.rewards?.settled ? `${entry.rewards.experience ?? 0} / ${entry.rewards.gold ?? 0}` : entry.status === "completed" ? "未记录" : "未结算"}</td>
                <td>{entry.createdAt}</td>
                <td className="report-actions">
                  <WodButton onClick={() => onOpen(entry.dungeonRunId)}>查看详情</WodButton>
                  <WodButton title={`删除战报 #${entry.dungeonRunId}`} onClick={() => { setDeleteError(null); setPendingDelete(entry); }}>删除</WodButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pendingDelete ? <DeleteRunDialog entry={pendingDelete} busy={deleting} error={deleteError} onConfirm={confirmDelete} onClose={() => { setPendingDelete(null); setDeleteError(null); }} /> : null}
    </section>
  );
}

/** 探索快照：战斗规则输入的可读视图（队伍站位与行动设置、地城敌人配置）。 */

export default function ReportPage({ run, onOpen, onBack, highlightRunId }) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [notice, setNotice] = useState(null);

  if (!run) return <ReportListPage onOpen={(dungeonRunId) => { setNotice(null); onOpen(dungeonRunId); }} highlightRunId={highlightRunId} notice={notice} />;

  /** 详情页删除当前记录：成功后回到列表，列表会重新取数，因此不需要在这里手工刷新。 */
  async function confirmDetailDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await request(`/api/dungeons/runs/${run.dungeonRunId}`, { method: "DELETE" });
      setPendingDelete(false);
      setNotice(`已删除战报 #${run.dungeonRunId}（${run.dungeonName}）及其名下的战斗战报与本地 JSON 文件。`);
      onBack();
    } catch (cause) {
      setDeleteError(cause.message);
    } finally {
      setDeleting(false);
    }
  }

  const pending = run.status === "pending";
  const levels = run.levels ?? [{ floor: run.floorNumber, result: run.result, battles: run.battles }];
  return (
    <section className="classic-report-page">
      <p>
        <WodButton onClick={onBack}>返回战报列表</WodButton>
        {run.dungeonRunId != null && <WodButton title={`删除战报 #${run.dungeonRunId}`} onClick={() => { setDeleteError(null); setPendingDelete(true); }}>删除该战报</WodButton>}
      </p>
      <h1>战报：{run.dungeonName}</h1>
      {pending
        ? <ExplorationSnapshot run={run} />
        : (
          <>
            <div className="report-meta">
              方案 {run.planName}　种子 {run.seed}　内容版本 {run.contentVersion}　层数 {run.floorCount ?? levels.length}　战斗数 {run.battleCount ?? levels.reduce((total, level) => total + (level.battles?.length ?? 0), 0)}
              　结果 <span className={run.result === "victory" ? "victory" : "warning"}>{runResultLabel(run.result)}</span>
              {run.finalHero && <>　剩余体力 {run.finalHero.health}　剩余法力 {run.finalHero.mana}</>}
            </div>
            {run.events?.length > 0 && (
              <div className="battle-report dungeon-events">
                {run.events.map((event) => (
                  <div className={`report-row report-${event.type}`} key={event.seq}>
                    <strong>{event.type === "LevelEnded" ? "层结算" : "地城结算"}</strong>
                    <span>{event.type === "LevelEnded"
                      ? `第 ${event.level} 层完成：${event.result === "victory" ? "胜利" : event.result}（${event.battleCount} 场战斗）`
                      : `地城结束：${event.resultLabel}（${event.floorCount} 层 / ${event.battleCount} 场战斗）`}</span>
                  </div>
                ))}
              </div>
            )}
            {levels.map((level) => (
              <div key={level.floor}>
                <h2>第 {level.floor} 层</h2>
                {level.battles.map((battle) => <BattleReport key={battle.battleId} battle={battle} />)}
              </div>
            ))}
            <p className="subtle">战报由领域事件渲染，渲染层不决定战斗结果。</p>
          </>
        )}
      {pendingDelete && (
        <DeleteRunDialog
          entry={{
            dungeonRunId: run.dungeonRunId,
            dungeonName: run.dungeonName,
            status: run.status,
            result: run.result,
            createdAt: run.createdAt,
            battleCount: run.battleCount ?? run.battles?.length ?? 0,
          }}
          busy={deleting}
          error={deleteError}
          onConfirm={confirmDetailDelete}
          onClose={() => { setPendingDelete(false); setDeleteError(null); }}
        />
      )}
    </section>
  );
}
