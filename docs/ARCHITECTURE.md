# 当前架构

产品边界：这是 WOD 的配装与战斗模拟工具。探索记录模拟输入、结果和战报，不发放经验、金币或掉落，也不检查地城等级、准备时间或重复探索次数；原版奖励经济和地城进入限制不属于当前目标。

请求路径：React `src/App.jsx`/页面 → `src/api/client.js` → `server.mjs` → `application/` 用例 → `game/` 纯规则与 `infrastructure/persistence/sqlite-repository.mjs` → SQLite。`server.mjs` 同时挂载 Vite 中间件；没有游戏引擎或场景文件，页面是 hash 路由。`worker/` 与 `.openai/` 支持站点构建。

`game/domain/` 定义角色、技能、物品、属性和效果；`game/formulas/` 是训练、资源、命中、伤害等计算；`game/modifiers/` 处理加成顺序；`game/commands/` 表达行动计划与游标；`game/targeting/` 选目标；`game/engine/` 建战斗单位并执行回合；`game/events/` 产生和渲染本地战报；`game/replay/envelope.mjs` 校验本地模拟事件的可复现性；`game/policies/` 收容未核实或可替换规则。战斗状态由 `simulateBattle`/`EffectLedger` 持有，不应由 UI 镜像计算。原版 HTML 战报导入不属于当前架构。

`application/` 负责账号、英雄训练、装备、背包、市场、行动设置、地城探索等用例。角色实例在 `character-instance-service` 从基础角色、技能、装备和目录生成；战斗服务将其转换为战斗单位，按地城配置逐场运行，再保存输入快照、结果和报告。`gamedata/generated/` 是导入目录，`gamedata/overrides/` 是手工内容；数据库保存运行时用户、角色、物品和战报。`docs/database-schema.json` 是启动校验契约，不是自动迁移指令。

SQLite 仓库在所有装备写入入口校验同物品的英雄唯一/队伍唯一，依据物品详情源数据。角色实例读取三种使用次数并附到行动调用物品上。一次探索持有地城物品使用状态，逐房间传入 `simulateBattle`；每次战斗另建房间计数。剩余次数耗尽仅阻止该模拟后续调用，不改仓库或物品实例。装备耐久没有运行时状态。

传古符文配方集中在 `gamedata/overrides/ancient-rune-combinations.mjs`，`game/domain/ancient-rune.mjs` 按物品类别、孔数、符文 ID 多重集合判定。`item_instances.socketed_rune_item_ids` 保存每件遗物的镶嵌状态；`application/ancient-rune-service.mjs` 与 SQLite 事务校验归属、孔位并消耗符文实例。角色仓库 DTO 向页面提供原有效果、组合效果和匹配状态，页面仅提交所选实例。已装备遗物的组合效果由现有角色实例和调用物品战斗链读取；战报输入快照保留效果来源。

旧库的 `uniqueness_ledger` 是原版掉落唯一性账本的遗留空表。模拟器没有掉落，运行时代码不读写该表；为兼容现有数据库和严格的结构校验，暂保留表与契约，配装唯一性仍由装备写入校验负责。

所有地城入口均从角色实例构造战斗单位；输入快照也引用同一实例的派生数值。模拟器逐回合重算派生值是为了反映持续效果，不应在用例层复制这部分动态状态。

依赖保持单向：UI 可调用 API，不直接写数据库；用例可调用规则与仓库；`game/` 不依赖 React、HTTP 或 SQLite。目录数据可驱动物品、技能、职业和种族；地城配置仅安排训练木桩的模拟房间，不扩充原版怪物数值。差异巨大的行为留在规则代码。UI 负责展示、输入与刷新，不放训练成本、伤害、掉落、效果或存档规则。`src/App.jsx` 是跨页面状态协调点，页面状态尽量留在页面。没有必要再引入全局事件总线、Service 层或 Manager 层。

当前风险：`server.mjs`、SQLite 仓库、战斗服务与模拟器都较大；拆分应基于独立职责和真实修改压力。`server.mjs` 集中协议路由，旧单英雄入口供 API 自检和脚本使用；`battle-service` 装配内容、运行战斗并通过仓库保存战报，`src/App.jsx` 负责多页面刷新。目前没有仅因文件大小而拆分的理由。各地城入口使用 SQLite 事务并在异常时清理本次专属战报 JSON；进程突然崩溃时仍没有跨数据库和文件的原子提交保证。规则问答/策略注册表承载未证实行为，不能仅凭文档改变默认策略。
