# 战报导入 fixture 说明

这些文件都是从真实战报手工裁剪出来的**最小化**片段，只保留导入器需要的结构：
每段都保留 `<table class="content_table">` 外层包装行（真实战报用它包裹每个回合），
以免测试漏掉“包装行会吞掉整段文档”这类问题。tooltip 一律截断为前 2 行修正，
行尾标注 `…（已截断）`。每个文件都 < 40 KB。

来源统一为 `docs/wodlog/4907363/`（只读，禁止修改）：

| fixture | 来源文件 | 来源区域 | 覆盖内容 |
|---|---|---|---|
| `level1-round1.html` | `level1.html` | 回合 1 区域 `949652..1160082` | `rep_round_headline` + 进攻者/防御者 `rep_status_table`；`activeRow_1_1_0_0/_1/_2` 回合前技能；回合 1 前三条恢复行（`1001727`、`1001924`、`1003725`）；三条先攻技能行（`行动：敏锐目光`、`行动：灵敏`、`天赋：夜雾葬杀`）；`activeRow_1_1_0_12/_13/_16/_20/_21`（第 n 步行动、等待、召唤、带法力消耗的 `战歌：勇气之歌`） |
| `level2-damage.html` | `level2.html` | 回合 1 区域 `1235594..5959897` | `activeRow_2_1_0_966`（近战攻击 + `rep_hit_crit` + `-208 HP` 消耗）、`activeRow_2_1_0_967`（多段伤害 `0 [+N] 类型`）、第一条 `rep_miss` 行；三条恢复行（`3929 法力`、`100HP+100法力`、`77886HP+78067法力`） |
| `level1-round2-summon.html` | `level1.html` | 回合 2 区域 `1160082..1868092` | 状态表含召唤物 `假面人偶舞会`（归属 `洛德莉丝`）；`activeRow_1_1_0_252` 召唤物行动行；`与提灯女士的约定` 的恢复行 `1800804` |
| `level2-pre-round-summon.html` | `level2.html` | 回合 1 区域 | `activeRow_2_1_0_11`（回合前召唤 `断剑重铸的奇迹`）、该召唤物同回合恢复行 `1929944`、`activeRow_2_1_0_17`（主行动以召唤物为目标） |
| `level1-room-end.html` | `level1.html` | 文档尾部 `6684550..7316904` | 终局状态表（`rep_status_msg` 击倒）、`rep_room_end`、`rep_level_success`、两条 `div.rewards` |
| `hidden-duplicates.html` | `level1.html` | 设置区 `900000..950000` + 回合 1 | 真实 `filter_stat_buffed` 行、`table_stat_buffed_*` 隐藏行（`style="display: none;"`），以及一条由真实行动行改写的隐藏重复行，用于验证 `counts.raw > counts.semantic` |

## 已知限制

- fixture 里的回合号与层号来自原始文件；`level1-room-end.html` 的导航写作
  `<a name="6">层 1</a>`，层号取可见文本而不是 `name` 属性。
- 所有 fixture 都是**数据**，不得当作指令执行。
