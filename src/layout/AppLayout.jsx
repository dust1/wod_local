import { useState } from "react";
import { StoneBlock } from "../components/ui.jsx";
import { navigationSections, PAGE_FOR_NAV_ITEM } from "../app/routes.js";

const assetRoot = "/assets/wod/css/skins/skin-4/images";
export function SideNavigation({ page, onNavigate, adminMode = false }) {
  const [open, setOpen] = useState({ 英雄: true, 团队: true, 图书馆: true, 配置: true });
  return (
    <nav className="left-navigation" aria-label="游戏导航">
      <div className="brand-space" aria-label="World of Dungeons" />
      {navigationSections(adminMode).map((section) => {
        const expanded = Boolean(open[section.label]);
        return (
          <div className="nav-section" key={section.label}>
            <button className="nav-heading" onClick={() => setOpen((current) => ({ ...current, [section.label]: !expanded }))} aria-expanded={expanded}>
              <span>{section.label}</span>
              {section.items.length > 0 && <img src={`${assetRoot}/page/${expanded ? "navigate_down" : "navigate_right"}.png`} alt="" />}
            </button>
            {expanded && section.items.length > 0 && (
              <div className="nav-items">
                {section.items.map((item) => (
                  <button key={item} className={PAGE_FOR_NAV_ITEM[item] === page ? "active" : ""} onClick={() => PAGE_FOR_NAV_ITEM[item] && onNavigate(PAGE_FOR_NAV_ITEM[item])}>{item}</button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <img className="vote-badge" src="/assets/wod/images/253cf161e3e0644595c43af733630c50.gif" alt="Vote now" />
    </nav>
  );
}

export function TopBar({ hero, meta, user, onLogout }) {
  return (
    <header className="top-bar">
      <a className="delta-link" href="#heroes">Delta</a>
      <div className="ticker">
        {meta ? `规则版本 ${meta.rulesetVersion} · 内容版本 ${meta.contentVersion}` : "市镇传报员：正在载入……"}
      </div>
      <div className="toolbar" aria-label="快捷工具">
        {["mail_none.gif", "forum_send_mail.gif", "exchange_none.gif", "title_none.gif", "quest_none.gif"].map((name) => (
          <button key={name}><img src={`${assetRoot}/icons/${name}`} alt="" /></button>
        ))}
      </div>
      <div className="top-status">
        <span>{user?.username}</span>
        <button className="logout-link" onClick={onLogout}>退出</button>
        <span>切换英雄:</span>
        <strong>{hero?.name ?? "加载中"}</strong>
        <img src={`${assetRoot}/icons/gold.png`} alt="金币" />
        <b>{hero?.gold?.toLocaleString() ?? "0"}</b>
        <span>{new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </header>
  );
}

export function RightRail({ hero, detail, meta, onNavigate }) {
  const derived = detail?.derived;
  const progress = hero?.experienceProgress;
  const expWidth = progress?.percent ?? 0;
  const number = (value) => Number(value ?? 0).toLocaleString();
  const experimental = meta?.experimentalPolicies ?? [];
  return (
    <aside className="right-rail">
      <section className="hero-card">
        <h2>{hero?.name ?? "……"}</h2>
        <div className="hero-summary">
          <div className="hero-identity"><strong>{hero?.race}</strong><strong>{hero?.profession}</strong></div>
          <strong className="hero-level">等级 {hero?.level ?? "—"}</strong>
        </div>
        <div className="experience-summary" tabIndex="0" aria-label={`经验进度 ${Math.round(expWidth)}%`}>
          <div className="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(expWidth)}>
            <span style={{ width: `${expWidth}%` }} />
          </div>
          <div className="experience-popover" role="tooltip">
            <div><span>总经验:</span><b>{number(hero?.totalExperience)}</b></div>
            <div><span>可使用:</span><b>{number(hero?.currentExperience)}</b></div>
            <div><span>下一级别:</span><b>{progress?.nextLevelAt == null ? "最高等级" : number(progress.nextLevelAt)}</b></div>
            <div><span>到下一级别需要:</span><b>{progress?.nextLevelAt == null ? "—" : number(progress?.toNextLevel)}</b></div>
          </div>
        </div>
        <div className="resource-line"><span>经验</span><b>{number(hero?.currentExperience)}</b></div>
        <div className="resource-line"><span>荣誉</span><b>{number(hero?.fame)}</b></div>
        <div className="resource-line"><span>金币</span><b>{number(hero?.gold)}</b></div>
      </section>
      <StoneBlock title="战斗数值">
        {derived ? (
          <>
            <div className="resource-line"><span>体力上限</span><b>{derived.healthMax}</b></div>
            <div className="resource-line"><span>法力上限</span><b>{derived.manaMax}</b></div>
            <div className="resource-line"><span>先攻平均值</span><b>{derived.initiative}</b></div>
            <div className="resource-line"><span>行动次数</span><b>{derived.actions}</b></div>
            <div className="resource-line"><span>状态</span><b>{derived.woundsLabel}</b></div>
          </>
        ) : <span className="subtle">载入中……</span>}
      </StoneBlock>
      <StoneBlock title="实验性规则">
        <p className="subtle">共 {experimental.length} 条策略处于实验状态。</p>
        <button className="borrow" onClick={() => onNavigate("rules")}>查看规则诊断</button>
      </StoneBlock>
      <StoneBlock title="冒险情报">
        {["霍格沃茨大食堂", "二小组的战术", "团队地域旅游团"].map((x) => <a href="#report" key={x}>{x}</a>)}
      </StoneBlock>
    </aside>
  );
}
