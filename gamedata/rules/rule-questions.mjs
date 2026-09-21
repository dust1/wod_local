// 待验证规则登记表。设计文档 §25。
//
// 以下内容不得在没有证据时声称与原版一致。每项都必须绑定一个可替换的策略实现，
// 或者在代码中显式标注为尚未实现。
//
// status:
//   open        尚无足够证据，也未实现
//   hypothesis  已有实验实现，等待更多样本校准
//   verified    已由教材或数据库交叉验证
//   rejected    已被证据否定

/**
 * @typedef {object} RuleQuestion
 * @property {string} id
 * @property {string} question
 * @property {"open"|"hypothesis"|"verified"|"rejected"} status
 * @property {Array<{kind:string,ref:string,note?:string}>} evidence
 * @property {string|null} experimentalPolicy
 */

export const RULE_QUESTIONS = [
  {
    id: "random-roll-distribution",
    question: "随机投点的精确概率分布和随机算法",
    status: "hypothesis",
    evidence: [
      { kind: "textbook", ref: "§13.5", note: "确认 0 ≤ 实际投点 ≤ 2 × 平均值" },
      { kind: "research", ref: "用户提供的《统计分析》骰子研究文档", note: "给出 1 至 60 点的主骰/副骰换算表" },
    ],
    experimentalPolicy: "roll:wod-dice-pool-int",
  },
  {
    id: "random-flat-range",
    question: "+x? 随机固定加值的区间与分布",
    status: "open",
    evidence: [{ kind: "textbook", ref: "§14.1" }],
    experimentalPolicy: "modifier:randomFlat",
  },
  {
    id: "multi-action-initiative-decay",
    question: "多次行动的先攻衰减公式",
    status: "hypothesis",
    evidence: [{ kind: "report", ref: "docs/wodlog/4907363/level1.html", note: "先攻 X 第 n 步行动 / 共 m 步" }],
    experimentalPolicy: "decay:linear-decay-0.5",
  },
  {
    id: "initiative-tie-break",
    question: "同先攻值的排序规则",
    status: "hypothesis",
    evidence: [{ kind: "textbook", ref: "§11.6" }],
    experimentalPolicy: "tieBreak:stable-input-order",
  },
  {
    id: "default-evade-attributes",
    question: "无防御技能时，各常规攻击方式的默认闪避主副属性",
    status: "hypothesis",
    evidence: [{ kind: "textbook", ref: "§13.3" }],
    experimentalPolicy: "evade:default-evade-agility-perception",
  },
  {
    id: "healing-formula",
    question: "治疗量公式和治疗命中规则",
    status: "open",
    evidence: [{ kind: "textbook", ref: "§8.2" }],
    experimentalPolicy: "heal:damage-mean-reuse",
  },
  {
    id: "armor-resistance-formula",
    question: "护甲、抵抗及其与命中等级的完整伤害公式",
    status: "hypothesis",
    evidence: [{ kind: "textbook", ref: "§13.7" }],
    experimentalPolicy: "armor:zero-reduction",
  },
  {
    id: "damage-order-z-item-global",
    question: "z 伤害、物品效果等级和全局效果奖励的完整顺序",
    status: "hypothesis",
    evidence: [{ kind: "textbook", ref: "§13.7" }],
    experimentalPolicy: "pipeline:wod-textbook-v1",
  },
  {
    id: "rounding-points",
    question: "各阶段的精确取整点",
    status: "hypothesis",
    evidence: [{ kind: "textbook", ref: "§14.5", note: "只确认使用时向下取整" }],
    experimentalPolicy: "rounding:floor",
  },
  {
    id: "durability-damage",
    question: "装备损坏概率、损坏量和免损伤害类型全集",
    status: "open",
    evidence: [{ kind: "textbook", ref: "§9.2", note: "只确认心理与毒素伤害不损坏装备" }],
    experimentalPolicy: "durability:default-no-damage-types",
  },
  {
    id: "wound-thresholds",
    question: "受伤、重伤的体力阈值",
    status: "hypothesis",
    evidence: [{ kind: "textbook", ref: "§11.2", note: "只确认低于 90% 至少视为轻伤" }],
    experimentalPolicy: "woundThreshold:default-wound-thresholds",
  },
  {
    id: "target-random-selection",
    question: "目标随机选择算法",
    status: "hypothesis",
    evidence: [{ kind: "textbook", ref: "§8.4" }],
    experimentalPolicy: "withinPosition:random-within-position",
  },
  {
    id: "within-position-order",
    question: "同一站位内的目标排序规则",
    status: "hypothesis",
    evidence: [{ kind: "textbook", ref: "§12.2" }],
    experimentalPolicy: "withinPosition:random-within-position",
  },
  {
    id: "defeat-escape-victory",
    question: "击倒、死亡、复活、逃跑和胜负条件",
    status: "open",
    evidence: [{ kind: "textbook", ref: "§11.7" }],
    experimentalPolicy: "battleEnd:last-side-standing",
  },
  {
    id: "failed-attempt-cost",
    question: "技能失败是否消耗资源、物品、次数或行动；主回合一整圈都没有可执行指令时如何结算",
    status: "hypothesis",
    evidence: [{ kind: "textbook", ref: "§17.3" }],
    experimentalPolicy: "failureCost:default-failure-cost",
    note: "当前实现：调用前预检不通过（同源效果仍在生效、法力不足）与「没有合法目标」都不消耗行动并顺位到下一条指令；一次行动最多检查一整圈，一圈都不可用时判定本次行动失败、消耗行动点，并在战报中显示「无法执行任何行动」。",
  },
  {
    id: "hand-slot-occupancy",
    question: "双手、左右手以及多戒指等槽位占用细节",
    status: "hypothesis",
    evidence: [{ kind: "database", ref: "equip_slot", note: "18 个稳定字符串 ID 已确认" }],
    experimentalPolicy: "slots:two-hands-conflict",
  },
  {
    id: "training-cost-curve",
    question: "基本、附加、特殊、天赋技能的完整训练花费和精通曲线",
    status: "open",
    evidence: [{ kind: "textbook", ref: "§6.4" }],
    experimentalPolicy: null,
  },
  {
    id: "loot-and-uniqueness",
    question: "掉落、唯一物品重掉、战利品、经验和金币结算",
    status: "open",
    evidence: [{ kind: "textbook", ref: "§9.4" }],
    experimentalPolicy: "uniqueness:dropped-ever-ledger",
  },
  {
    id: "pvp-pve-differences",
    question: "PVP 与 PVE 的规则差异",
    status: "open",
    evidence: [{ kind: "textbook", ref: "§17.1" }],
    experimentalPolicy: null,
  },
  {
    id: "dungeon-scheduling",
    question: "地城等待、加速和任务路线的完整服务端规则",
    status: "open",
    evidence: [{ kind: "textbook", ref: "§10" }],
    experimentalPolicy: null,
  },
];

export const RULE_QUESTION_STATUSES = Object.freeze(["open", "hypothesis", "verified", "rejected"]);

export const RULE_QUESTION_BY_ID = Object.fromEntries(RULE_QUESTIONS.map((question) => [question.id, question]));

/** 已确认（A 级）的规则不需要登记为待验证项，但必须逐条有测试。 */
export const VERIFIED_RULES = Object.freeze([
  { id: "phase-order", ref: "§11.1", test: "tests/engine.test.mjs" },
  { id: "health-mana-max", ref: "§13.1", test: "tests/formulas.test.mjs" },
  { id: "roll-mean", ref: "§13.3", test: "tests/formulas.test.mjs" },
  { id: "damage-mean", ref: "§13.4", test: "tests/formulas.test.mjs" },
  { id: "mana-cost", ref: "§8.5", test: "tests/formulas.test.mjs" },
  { id: "hit-grade", ref: "§13.6", test: "tests/formulas.test.mjs" },
  { id: "percent-chain", ref: "§14.2", test: "tests/formulas.test.mjs" },
  { id: "multiply-then-add", ref: "§14.3", test: "tests/formulas.test.mjs" },
  { id: "floor-at-use", ref: "§14.5", test: "tests/formulas.test.mjs" },
  { id: "equipment-skill-cap", ref: "§8.7", test: "tests/formulas.test.mjs" },
  { id: "duration-semantics", ref: "§15.2", test: "tests/effects.test.mjs" },
  { id: "same-source-stacking", ref: "§15.4", test: "tests/effects.test.mjs" },
  { id: "melee-target-priority", ref: "§12.2", test: "tests/targeting.test.mjs" },
  { id: "melee-position-modifier", ref: "§12.3", test: "tests/targeting.test.mjs" },
  { id: "same-position-aoe", ref: "§8.4", test: "tests/targeting.test.mjs" },
  { id: "repeat-modes", ref: "§17.3", test: "tests/commands.test.mjs" },
  { id: "healing-interrupt", ref: "§17.4", test: "tests/commands.test.mjs" },
  { id: "item-requirement-chain", ref: "§9.6", test: "tests/commands.test.mjs" },
  { id: "az-markers", ref: "§9.7", test: "tests/commands.test.mjs" },
  { id: "deterministic-replay", ref: "§21", test: "tests/engine.test.mjs" },
  { id: "report-dom-semantics", ref: "§19.1", test: "tests/report-import.test.mjs" },
  { id: "report-golden-counts", ref: "§2.3", test: "tests/report-import.test.mjs" },
  { id: "report-phase-order", ref: "§11.1", test: "tests/report-import.test.mjs" },
  { id: "etl-talent-classification", ref: "§4.5", test: "tests/catalog-assets.test.mjs" },
  { id: "etl-no-silent-missing-fields", ref: "§4.6", test: "tests/catalog-assets.test.mjs" },
]);
