import { useCallback, useEffect, useMemo, useState } from "react";
import "./attributes.css";
import SettingsPage from "./pages/settings/SettingsPage.jsx";
import { request, useApi } from "./api/client.js";
import { SideNavigation, TopBar, RightRail } from "./layout/AppLayout.jsx";
import AuthPage from "./pages/auth/AuthPage.jsx";
import HeroesPage from "./pages/heroes/HeroesPage.jsx";
import CreateHeroPage from "./pages/heroes/CreateHeroPage.jsx";
import AttributesPage from "./pages/attributes/AttributesPage.jsx";
import SkillsPage from "./pages/skills/SkillsPage.jsx";
import EquipmentPage from "./pages/equipment/EquipmentPage.jsx";
import HeroInventoryPage from "./pages/inventory/HeroInventoryPage.jsx";
import TeamInventoryPage from "./pages/inventory/TeamInventoryPage.jsx";
import DungeonPage from "./pages/dungeon/DungeonPage.jsx";
import ReportPage from "./pages/reports/ReportPage.jsx";
import BattlesPage from "./pages/reports/BattlesPage.jsx";
import ReportImportPage from "./pages/reports/ReportImportPage.jsx";
import MarketPage from "./pages/market/MarketPage.jsx";
import RulesPage from "./pages/rules/RulesPage.jsx";
import SkillLibraryPage from "./pages/library/SkillLibraryPage.jsx";
import OverviewPage from "./pages/overview/OverviewPage.jsx";
import SummonConfigPage from "./pages/admin/SummonConfigPage.jsx";
import SummonActionConfigPage from "./pages/admin/SummonActionConfigPage.jsx";

const adminMode = __WOD_ADMIN_MODE__;

export function App() {
  const [page, setPage] = useState("heroes");
  const [activeHeroId, setActiveHeroId] = useState(null);
  const [run, setRun] = useState(null);
  const [highlightRunId, setHighlightRunId] = useState(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);

  const session = useApi("/api/auth/session");
  const isAuthenticated = Boolean(session.data?.user);
  const meta = useApi(isAuthenticated ? "/api/meta" : null);
  const catalog = useApi(isAuthenticated ? "/api/catalog" : null);
  const heroes = useApi(isAuthenticated ? "/api/heroes" : null);

  const activeHero = useMemo(() => {
    const list = heroes.data ?? [];
    return list.find((hero) => hero.id === activeHeroId) ?? list.find((hero) => hero.active) ?? list[0] ?? null;
  }, [heroes.data, activeHeroId]);

  const detail = useApi(activeHero ? `/api/heroes/${activeHero.id}` : null);
  const heroInventory = useApi(isAuthenticated && activeHero ? `/api/heroes/${activeHero.id}/inventory` : null);
  const heroEquipment = useApi(isAuthenticated && activeHero ? `/api/heroes/${activeHero.id}/equipment` : null);
  const teamInventory = useApi(isAuthenticated ? "/api/team-inventory" : null);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [inventoryError, setInventoryError] = useState(null);

  useEffect(() => {
    if (activeHero && activeHeroId === null) setActiveHeroId(activeHero.id);
  }, [activeHero, activeHeroId]);

  // 可装备性由服务端按角色当前属性、技能和装备实时计算。
  // 页面路由变化不会改变 useApi 的请求地址，因此每次进入角色仓库时显式刷新，
  // 避免沿用训练属性或技能之前缓存的 canEquip 与 equipabilityReasons。
  useEffect(() => {
    if (page === "heroInventory" && activeHero?.id) heroInventory.reload();
  }, [page, activeHero?.id]);

  const navigate = useCallback((next) => {
    setPage(next);
    window.location.hash = next;
  }, []);

  async function activate(id) {
    await request(`/api/heroes/${id}/activate`, { method: "POST" });
    setActiveHeroId(id);
    heroes.reload();
    detail.reload();
  }

  /** 属性页草稿统一提交：服务端在单个事务里写入全部基础值与经验消耗。 */
  async function trainAttributes(updates) {
    if (!activeHero) return;
    const next = await request(`/api/heroes/${activeHero.id}/attributes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    detail.setData(next);
    heroes.reload();
  }

  async function trainSkill(updates) {
    if (!activeHero) return;
    const next = await request(`/api/heroes/${activeHero.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    detail.setData(next);
    heroes.reload();
  }

  async function advanceProfession(name) {
    if (!activeHero) return;
    const next = await request(`/api/heroes/${activeHero.id}/advanced-profession`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    detail.setData(next);
    heroes.reload();
  }

  async function addHeroResource(resource, amount) {
    if (!activeHero) throw new Error("请先选择一个英雄");
    const next = await request(`/api/heroes/${activeHero.id}/resources/${resource}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    detail.setData(next);
    heroes.reload();
  }

  async function levelUpHero() {
    if (!activeHero) throw new Error("请先选择一个英雄");
    const next = await request(`/api/heroes/${activeHero.id}/level-up`, { method: "POST" });
    detail.setData(next);
    heroes.reload();
  }

  /**
   * 删除角色：名下物品由服务端移入团队仓库，角色从列表消失。
   * 被删的正好是当前角色时清空选择，让列表重新落到服务端选定的当前角色上。
   */
  async function deleteHero(heroId) {
    const result = await request(`/api/heroes/${heroId}`, { method: "DELETE" });
    if (activeHeroId === heroId) setActiveHeroId(null);
    heroes.reload();
    teamInventory.reload();
    detail.reload();
    heroInventory.reload();
    return result;
  }

  /**
   * 人物卡导入：写入由 /api/heroes/:id/character-card 完成，
   * 这里只负责让所有受影响的视图（角色列表、详情、仓库、装备）重新取数。
   */
  function heroCardImported() {
    heroes.reload();
    detail.reload();
    heroInventory.reload();
    heroEquipment.reload();
  }

  async function logout() {
    await request("/api/auth/logout", { method: "POST" });
    setActiveHeroId(null);
    setPage("heroes");
    session.reload();
  }

  function heroCreated(hero) {
    setActiveHeroId(hero.id);
    heroes.reload();
    navigate("heroes");
  }

  /** 装备、卸下、角色仓库与团队仓库之间的物品流转。 */
  async function handleInventoryAction(action, item, equipped = true) {
    if (!activeHero) return;
    setInventoryBusy(true);
    setInventoryError(null);
    try {
      if (action === "equip") {
        await request(`/api/heroes/${activeHero.id}/inventory/${item.instanceId}/equip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ equipped }),
        });
      } else if (action === "team") {
        await request(`/api/heroes/${activeHero.id}/inventory/${item.instanceId}/to-team`, { method: "POST" });
      } else if (action === "hero") {
        await request(`/api/team-inventory/${item.instanceId}/to-hero/${activeHero.id}`, { method: "POST" });
      }
      heroInventory.reload();
      teamInventory.reload();
      detail.reload();
    } catch (cause) {
      setInventoryError(cause.message);
    } finally {
      setInventoryBusy(false);
    }
  }

  async function applyEquipment(selections) {
    if (!activeHero) return;
    setInventoryBusy(true); setInventoryError(null);
    try {
      const next = await request(`/api/heroes/${activeHero.id}/equipment`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selections }),
      });
      heroEquipment.setData(next); heroInventory.reload(); detail.reload();
    } catch (cause) { setInventoryError(cause.message); }
    finally { setInventoryBusy(false); }
  }

  /**
   * 地城探索：用账号全部角色及各自行动设置同步结算地城并保存战报，
   * 然后回到战报列表，让玩家打开刚完成的探索结果。
   */
  async function exploreDungeon(dungeonId, maxFloor) {
    if (!activeHero) return;
    setRunning(true);
    setRunError(null);
    try {
      const created = await request(`/api/dungeons/${encodeURIComponent(dungeonId)}/explore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heroId: activeHero.id, maxFloor }),
      });
      setRun(null);
      setHighlightRunId(created.dungeonRunId ?? null);
      navigate("report");
    } catch (cause) {
      setRunError(cause.message);
    } finally {
      setRunning(false);
    }
  }

  /** 回到战报记录列表（清空当前详情）。 */
  function backToReportList() {
    setRun(null);
  }

  async function openBattle(battleId) {
    const detailResponse = await request(`/api/battles/${battleId}`);
    setRun({
      dungeonName: detailResponse.dungeonName,
      floorNumber: detailResponse.levelNumber,
      planName: "历史战报",
      result: detailResponse.result,
      battles: [{
        battleId: detailResponse.battleId,
        battleIndex: 1,
        battleName: detailResponse.dungeonName,
        result: detailResponse.result,
        rounds: detailResponse.rounds,
        roundData: detailResponse.roundData,
      }],
    });
    navigate("report");
  }

  /** 打开一条战报记录详情：包含战斗规则输入快照与（已结算时的）战斗事件流。 */
  async function openDungeonRun(dungeonRunId) {
    const detail = await request(`/api/dungeons/runs/${dungeonRunId}`);
    const levels = detail.levels ?? [];
    const battleIds = levels.flatMap((level) => level.battles.map((battle) => battle.battleId));
    const battles = [];
    for (const battleId of battleIds) battles.push(await request(`/api/battles/${battleId}`));
    setRun({
      dungeonRunId: detail.dungeonRunId,
      dungeonId: detail.dungeonId,
      dungeonName: detail.dungeonName,
      status: detail.status ?? "completed",
      input: detail.input ?? {},
      rewards: detail.rewards ?? {},
      partyCount: detail.partyCount ?? 0,
      createdAt: detail.createdAt,
      rulesetVersion: detail.rulesetVersion,
      planName: "历史战报",
      seed: detail.seed,
      contentVersion: detail.contentVersion,
      result: detail.result,
      floorCount: detail.floorCount,
      battleCount: detail.battleCount,
      events: detail.events,
      levels: levels.map((level) => ({
        ...level,
        battles: level.battles.map((summary, index) => {
          const full = battles.find((battle) => battle.battleId === summary.battleId);
          return {
            ...summary,
            battleIndex: index + 1,
            roundData: full.roundData,
          };
        }),
      })),
      battles: [],
    });
    setHighlightRunId(null);
    navigate("report");
  }

  if (session.loading) return <div className="loading-screen">正在检查冒险者凭证……</div>;
  if (!isAuthenticated) return <AuthPage onAuthenticated={session.reload} />;

  if (heroes.error) {
    return <div className="loading-screen">无法连接本地服务端：{heroes.error}</div>;
  }

  return (
    <div className="app-shell">
      <TopBar hero={activeHero} meta={meta.data} user={session.data.user} onLogout={logout} />
      <SideNavigation page={page} onNavigate={navigate} adminMode={adminMode} />
      <main className="content-panel">
        {page === "heroes" && <HeroesPage heroes={heroes.data ?? []} activeHero={activeHero} detail={detail.data} onActivate={activate} onNavigate={navigate} onAddResource={addHeroResource} onImportCharacterCard={heroCardImported} onDelete={deleteHero} error={heroes.error} />}
        {page === "createHero" && <CreateHeroPage catalog={catalog.data} onCreated={heroCreated} onCancel={() => navigate("heroes")} />}
        {page === "attributes" && <AttributesPage hero={activeHero} detail={detail.data} loading={detail.loading} error={detail.error} onTrain={trainAttributes} onLevelUp={levelUpHero} />}
        {page === "skills" && <SkillsPage detail={detail.data} loading={detail.loading} error={detail.error} onTrain={trainSkill} onAdvance={advanceProfession} />}
        {page === "equipment" && <EquipmentPage hero={activeHero} equipment={heroEquipment.data} loading={heroEquipment.loading} busy={inventoryBusy} error={inventoryError ?? heroEquipment.error} onApply={applyEquipment} />}
        {page === "heroInventory" && <HeroInventoryPage heroId={activeHero?.id} inventory={heroInventory.data} loading={heroInventory.loading} busy={inventoryBusy} error={inventoryError ?? heroInventory.error} hint={activeHero ? `${activeHero.name} 的私人仓库，存放未装备的物品。` : "请先创建或选择一个英雄。"} onAction={handleInventoryAction} />}
        {page === "teamInventory" && <TeamInventoryPage heroId={activeHero?.id} inventory={teamInventory.data} loading={teamInventory.loading} busy={inventoryBusy || !activeHero} error={inventoryError ?? teamInventory.error} hint={activeHero ? "团队仓库按账号隔离，可在同一账号的角色之间调配物品。" : "团队仓库按账号隔离。先创建一个角色才能把物品交给他。"} onAction={handleInventoryAction} />}
        {page === "settings" && <SettingsPage heroId={activeHero?.id} detail={detail.data} catalog={catalog.data} loading={detail.loading} error={detail.error} />}
        {page === "dungeon" && <DungeonPage hero={activeHero} heroes={heroes.data ?? []} catalog={catalog.data} onExplore={exploreDungeon} running={running} error={runError} />}
        {page === "report" && (
          <ReportPage
            run={run}
            onOpen={openDungeonRun}
            onBack={backToReportList}
            highlightRunId={highlightRunId}
          />
        )}
        {page === "battles" && <BattlesPage onOpen={openBattle} />}
        {page === "market" && <MarketPage hero={activeHero} onPurchased={() => { heroes.reload(); heroInventory.reload(); detail.reload(); }} />}
        {page === "reportImport" && <ReportImportPage />}
        {page === "rules" && <RulesPage />}
        {page === "library" && <SkillLibraryPage />}
        {page === "overview" && <OverviewPage meta={meta.data} hero={activeHero} detail={detail.data} />}
        {adminMode && page === "summonConfig" && <SummonConfigPage />}
        {adminMode && page === "summonActionConfig" && <SummonActionConfigPage />}
      </main>
      <RightRail hero={activeHero} detail={detail.data} meta={meta.data} onNavigate={navigate} />
    </div>
  );
}
