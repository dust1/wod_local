import { useState } from "react";
import { ANCIENT_RUNE_COMBINATIONS, ANCIENT_RUNE_ITEMS } from "../../../gamedata/overrides/ancient-rune-combinations.mjs";

const sections = [
  { id: "intro", label: "介绍" },
  { id: "runes", label: "传古镶嵌公式" },
  { id: "card", label: "人物卡导入" },
];
const runeNames = Object.fromEntries(Object.entries(ANCIENT_RUNE_ITEMS).map(([name, id]) => [id, name]));
const cardExample = `[table border=1]
[tr][td][color=orange]力量[/color][/td][td]2[6][/td][td][skill:法术：魔法盾][/td][td]4[/td][/tr]
[tr][td][color=orange]体质[/color][/td][td]3[7][/td][td][skill:典型的玛格—莫精灵][/td][td]3[/td][/tr]
[tr][td][color=orange]智力[/color][/td][td]10[42][/td][td][/td][td][/td][/tr]
[tr][td][color=orange]灵巧[/color][/td][td]5[9][/td][td][/td][td][/td][/tr]
[tr][td][color=orange]魅力[/color][/td][td]4[8][/td][td][/td][td][/td][/tr]
[tr][td][color=orange]敏捷[/color][/td][td]6[10][/td][td][/td][td][/td][/tr]
[tr][td][color=orange]感知[/color][/td][td]7[11][/td][td][/td][td][/td][/tr]
[tr][td][color=orange]意志[/color][/td][td]8[12][/td][td][/td][td][/td][/tr]
[tr][td][color=orange]英雄等级[/color][/td][td]40[/td][td][/td][td][/td][/tr]
[tr][td][color=orange]耳[/color][/td][td colspan=3][item:+3魅力耳环]!:g0:[/td][/tr]
[tr][td][color=orange]肩膀[/color][/td][td colspan=3][item:智慧布披肩][/td][/tr]
[/table]`;

function Introduction() {
  return <>
    <section className="library-card">
      <h2>项目定位</h2>
      <p>这是 WOD 的本地配装与战斗模拟工具。建立或导入角色后，可以调整属性、训练技能、配置装备和行动，再运行地城模拟，查看战报并继续修改构筑。</p>
      <p>探索用于验证当前构筑，不发放经验、金币或物品，也不受地城等级、准备时间和重复探索次数限制。战斗对象统一为本地训练木桩。</p>
    </section>
    <section className="library-card">
      <h2>当前功能</h2>
      <ul>
        <li>创建角色、导入人物卡，调整属性、技能和职业。</li>
        <li>管理角色与团队仓库、装备和市场物品，并为传古遗物镶嵌符文。</li>
        <li>设置行动与治疗技能，运行地城模拟，阅读本地战报。</li>
      </ul>
    </section>
  </>;
}

function RuneRecipes() {
  return <>
    <p className="library-lead">配方按符文种类和数量匹配，镶嵌顺序不影响结果。遗物极性与配方极性必须对应；4 孔和 5 孔使用各自的组合。</p>
    {["中性", "阳性", "阴性"].map((polarity) => <section className="library-card" key={polarity}>
      <h2>{polarity}组合</h2>
      <div className="library-table-scroll"><table className="wod-table wide library-rune-table">
        <thead><tr><th>效果名称</th><th>4 孔符文</th><th>5 孔符文</th></tr></thead>
        <tbody>{ANCIENT_RUNE_COMBINATIONS.filter((entry) => entry.polarity === polarity).map((entry) => <tr key={entry.name}>
          <td>{entry.name}</td>
          <td>{entry.variants[4]?.runeItemIds.map((id) => runeNames[id]).join(" ＋ ") ?? "—"}</td>
          <td>{entry.variants[5].runeItemIds.map((id) => runeNames[id]).join(" ＋ ")}</td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
  </>;
}

function CharacterCardGuide() {
  return <>
    <section className="library-card">
      <h2>导入前准备</h2>
      <p>先在本工具中新建一个角色，选择与待导入人物卡相同的种族和职业，再打开该角色的“人物卡”入口。导入会覆盖等级、基础属性和技能加点，并尝试按名称匹配和穿戴卡面装备；先查看解析预览再确认导入。</p>
    </section>
    <section className="library-card">
      <h2>导入自己的人物卡</h2>
      <ol>
        <li>在原游戏安装人物卡插件，导出自己人物卡的 BBCode。</li>
        <li>复制完整 BBCode，粘贴到本工具角色的“导入人物卡”文本框。</li>
        <li>点击“解析并预览”，核对属性、技能和装备，再点击“确认导入”。</li>
      </ol>
    </section>
    <section className="library-card">
      <h2>拘灵遣将：导入其他人的人物卡</h2>
      <ol>
        <li>打开目标人物卡，在浏览器按 F12，复制该人物卡对应的 HTML 代码。</li>
        <li>请大模型把 HTML 转成与下方示例相同结构的 BBCode，保留属性、技能等级和装备名称；核对转换结果。</li>
        <li>将 BBCode 粘贴到已建好的对应种族、职业角色的导入框，解析预览后确认导入。</li>
      </ol>
    </section>
    <section className="library-card">
      <h2>BBCode 人物卡格式示例</h2>
      <p>下面是一张可被本工具解析的示例卡。导入自己的角色时请使用完整导出内容；转换他人卡片时保持相同的表格、属性、技能和物品标记格式。</p>
      <pre className="library-bbcode"><code>{cardExample}</code></pre>
    </section>
  </>;
}

export default function SkillLibraryPage() {
  const [section, setSection] = useState("intro");
  return <section className="library-page">
    <h1>资料库</h1>
    <nav className="library-nav" aria-label="资料库页面">
      {sections.map((entry) => <button key={entry.id} type="button" className={section === entry.id ? "active" : ""}
        aria-current={section === entry.id ? "page" : undefined} onClick={() => setSection(entry.id)}>{entry.label}</button>)}
    </nav>
    <div className="library-content">
      {section === "intro" && <Introduction />}
      {section === "runes" && <RuneRecipes />}
      {section === "card" && <CharacterCardGuide />}
    </div>
  </section>;
}
