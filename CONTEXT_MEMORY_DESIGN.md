# CityBrain 上下文与记忆体系设计

> 文档目标：为 **CityBrain（Geo-agent）**——一个用 LLM 驱动 `qgis_process` 做城市空间分析的单壳应用——
> 设计一套"上下文组装 + 记忆存储 + 召回 + 提取 + 压缩"的整体架构。
>
> 参考范本：Claude Code 2（`E:\Claude\Claude-Code2-main\src`）的上下文/记忆体系。
> 本文把它的设计思想**转录并领域化**到地理空间分析工作流，非照搬。
>
> 状态：**设计阶段，未写代码**。落地节奏见 §10。

---

## 0. 为什么要为 CityBrain 单独设计记忆

CityBrain 当前的"记忆"只有一层：[session-manager.ts](e:\Geo-agent\src\session\session-manager.ts)
是一个**纯会话日志**——JSONL 追加式存 user/assistant 消息与模型切换；
[agent-loop.ts:run()](e:\Geo-agent\src\agent\agent-loop.ts) 调
`session.getContextMessages()` 把**整段历史**喂给模型。它满足"能跑"，但有四块缺失：

| 缺失能力 | 现状 | 后果 |
|---|---|---|
| **跨会话长期记忆** | 无，会话结束即忘 | 用户每次重开会话都要重新交代"数据在哪、上次怎么做的" |
| **相关召回** | 无，全量历史都喂 | 每次请求都塞满整段 JSONL，token 浪费 |
| **自动提取** | 无 | 对话里的关键事实/用户偏好不会沉淀 |
| **上下文压缩** | 无（`getContextUsage` 只统计不动作） | 长会话必然撞 128k 窗口，只能手动 /clear |

**CityBrain 的领域特殊性**（决定了记忆该记什么）：
这是一个**空间数据分析代理**，用户的工作流高度结构化——数据源位置、坐标系（CRS）、字段语义、
输出规约、某片区域的既往分析结论。这些是**极其值得记忆**的东西；而 QGIS 算法目录、
项目代码结构则是**可由 `qgis_process list` / 读代码派生**的东西，**不该占记忆**。
这份"该记 / 不该记"的判据正是本设计最有价值的部分（见 §7）。

---

## 1. 三层心智模型（从 Claude Code 2 转录）

Claude Code 2 把记忆严格分为三层，生命周期、信任度、成本各不相同。CityBrain 沿用这套分层：

```
 ┌──────────────────────────────────────────────────────────┐
 │  L1  指令/静态层（永远加载，高信任，低频率变更）            │
 │       system prompt + 项目说明 + MEMORY.md 索引            │
 ├──────────────────────────────────────────────────────────┤
 │  L2  工作上下文（会话级，有界，会压缩）                    │
 │      对话 transcript + 会话笔记 session-memory             │
 ├──────────────────────────────────────────────────────────┤
 │  L3  长期记忆（跨会话、跨项目，按相关性召回）               │
 │      memdir/*.md 主题文件 + MEMORY.md 索引                 │
 └──────────────────────────────────────────────────────────┘
```

一句区分（Claude Code 2 原话精神）：
- **L1 = 指令**，用户写的，永远可信、永远加载；
- **L3 = 事实**，代理学到的，带"可能过期"的召回、不当作权威；
- **L2 = 工作状态**，当轮关键，最终被压缩/摘要掉。

因为 CityBrain 是**纯 shell（无 IDE、无并行子 agent 生态）**，三层的 trust 边界可以更简单：
L1、L3 的写入只来自两条路——用户的显式指令、或受沙箱限制的后台提取代理。

---

## 2. 记忆单元模型（Memory Unit）

CityBrain 的记忆单元 = **一个 Markdown 文件**，YAML frontmatter 指路。无数字 id、无访问计数、
无打分字段——`身份 = 文件名`，`时间 = 文件系统 mtime`。这与 Claude Code 2 完全一致，且实现极轻。

```markdown
---
name: bujiao-watershed-analysis
description: 2026-09 蒲胶流域淹没分析；输入 S1C_IW IW 数据、输出 4 类水面矢量；CRS 用 EPSG:32650。
type: project
---
<正文：facts 起手，feedback/project 型补 **Why:** 与 **How to apply:**>
```

### 四型封闭分类（核心：既约束"存什么"，也约束"按什么召回"）

| type | 含义 | CityBrain 典型内容 | 隐私/信任 |
|---|---|---|---|
| `user` | 人的信息 | 用户是城市规划研究生、常用 EPSG:32650、偏好 GPKG 输出 | 私有，仅本机 |
| `feedback` | 行为指导（纠正 + 确认） | "缓冲距离要浮点，别取整"、"输出必须落 workspace" | 高信任 |
| `project` | 项目工作状态 | 某区域内既往分析的输入/输出/结论 | 阶段临时 |
| `reference` | 指向外部系统/数据的指针 | 数据源绝对路径、坐标系、字段字典、工具站点 | 高价值 |

### 索引：MEMORY.md（永远加载的指路牌）

```
- [蒲胶流域淹没](bujiao-watershed-analysis.md) — S1C→4类水面，EPSG:32650
- [用户偏好-CRS](user-crs-preference.md) — 默认输出 UTM 带号投影
```

**MEMORY.md 是索引，不是记忆。** 每条一行指针，塞进 L1 永远加载；
主题文件的**全文只在其被召回时才进上下文**。这样索引常驻（便宜）、正文按需（省 token）。
上限对齐参考：索引截断至 200 行 / 25KB；单记忆文件 40k 字符封顶。

### 目录布局

```
<CITYBRAIN_DIR>/
  memory/
    MEMORY.md                        # 索引（常驻 L1）
    *.md                             # 主题记忆文件（召回时才加载）
    logs/YYYY/MM/YYYY-MM-DD.md       # 可选的逐日日志（见 §5 备选模式）
  sessions/--<cwd>--/…               # 既有会话日志，不动
```

---

## 3. 上下文组装（对应 L1）

Claude Code 2 用三个 fetch 拼 L1（system prompt + userContext(CLAUDE.md) + systemContext(git 状态)），
并因循环依赖拆到了单独文件 `queryContext.ts`。对 CityBrain 这种小项目，**建议收敛成单模块**
`src/context/assemble.ts`，暴露一个 `buildSystemParts(): SystemParts`：

```
SystemParts
├─ cityBrainSystemPrompt   // 既有的角色声明（城市数据治理助理）
├─ projectInstruction      // 项目说明：从 <CITYBRAIN_DIR>/CLAUDE.md 栈或内存 project-*.md 注入
├─ memoryIndex             // MEMORY.md 全文（L1 常驻）
└─ metadata                // "今天日期是 …"、当前工作目录、已配置 QGIS 运行时摘要
```

这一层是唯一**永远加载**的部分，必须控制在 token 预算内（建议 index+说明合计 < 8k）。
要点（转录）+ CityBrain 落点：
- **优先级覆盖**：project 说明 > 用户级 > 系统内建（反向优先级，后者覆盖前者）。CityBrain 用
  `@include` 深度上限 5 与单文件 40k cap。
- 惰性缓存：`buildSystemParts()` 整会话缓存一次，避免每轮重读磁盘。

---

## 4. 召回（Retrieval）——让相关记忆在对的时候进来

**设计决策：召回引擎 = 一次小模型调用，不是向量检索。**
Claude Code 2 用 LLM 在"清单（name, description, type, mtime）"上选 ≤5 条，**不读正文**；
选中后才读全文，作为 **attachment 附件**注入（不进 system prompt）。CityBrain 照此，核心收益是
**零嵌入、零打分表，一个 manifest + 一个小模型调用**。

CityBrain 召回流水线：

```
用户输入
  → 读 memory/ 目录头（文件名+description+type+mtime，不读正文，cap 200 文件）
  → 组 manifest
  → 小模型选 ≤5 条 "CERTAIN 会帮助这次空间分析请求" 的记忆
  → 过滤：已在此前轮次注入的（alreadySurfaced）、已被 read_file 打开过的
  → 选中者读全文 → 作为 relevant_memories 附件注入本轮
```

**领域化召回信号（CityBrain 特色）**：
1. **语义判断**（主引擎）：manifest → LLM 选。对空间分析，拒绝把不相关记忆混进来。
2. **新鲜度**（mtime 驱动，排第二）：呈现成人类可读的 **"43 天前"** 而非 ISO 时间戳——
   原始时间戳不会触发模型的"可能过期"推理，人类可读的相对时间会。
3. **强制陈旧声明**（信任核心）：凡召回记忆时间 > 1 天，随记忆附带：

   > "记忆是时刻观察、非实时状态——关于数据路径、坐标系取舍、算法的描述可能已过期，
   > 断言前请先对照当前 workspace 与 `qgis_process` 校验。"

   这正是地理数据最需要的：`run_qgis_algorithm` 的产物文件可能已被覆盖/删除。

**预算与位置**：≤5 条；作为附件而非 prompt 插入；MEMORY.md 索引走 L1（豁免召回开销）。

**显式访问**：提示词约定——用户说 "remember / 记住/查一下记忆" 时必须访问记忆；说 "忽略记忆" 时
当作 MEMORY.md 为空。

---

## 5. 提取（Extraction）——记忆从哪来

**设计决策（转录 Claude Code 2）：主代理显式写 与 后台提取代理自动写，每轮互斥。**

- **A. 主代理显式写（最高信任）**：系统提示注入"如何保存"的记忆规则；用户显式要求记住时
  立即写文件（`Write`/`Edit` 到 memory/ 目录）。低频、可信。
- **B. 后台提取代理（低信任，兜底）**：每轮完整结束（模型给出最终回复、无工具调用）后，
  fork 一个后台任务跑提取。**若当轮主代理已写过记忆（检测 assistant tool_use 是否指向
  memory/ 路径），后台提取整轮跳过**——两者互斥，绝不重复或覆盖。

**提取代理约束（沙箱化 + 节流）**：
- 只用最近 N 条消息，不浪费轮次去 grep/git/验证；
- 工具权限：Read/Grep/Glob + 只读 Bash + 仅在 memory/ 目录内 Write/Edit；`rm` 拒绝；
- 节流：每 N 轮合格才跑（默认 1），≤5 轮，best-effort（出错记日志、不打扰用户）；
- 判定"值不值得存"用的正是 §2 的同款 taxonomy 与排除规则。

**会话笔记（L2）与"逐日日志（KAIROS 备选）"**：
- 会话笔记：一个固定模板的笔记文件（SessionTitle/当前状态/文件与函数/工作流/错误修正/学到的/
  关键结果/工作日志 …），每段封顶、总量 cap。**这一层与长期记忆完全分开**——存的是"这轮进行到哪"，
  不留到未来闲聊。
- 备选模式（针对能长时间跑的任务，如 CityBrain 批量跑流域分析）：逐日日志 `logs/YYYY/MM/…md`
  每轮追加时间戳条目，由一次"夜跑"提炼进 MEMORY.md + 主题文件。适合不便于增量维护索引的长活代理。

**CityBrain 节流阈值建议（转录并定值）**：
- 会话笔记子代理：上下文 ≥ 10k tokens 才初始化，且自上次提取增长 ≥ 5k tokens，
  且（新增 ≥ 3 个工具调用 或 上个 assistant 轮无工具调用——自然停顿）
  才更新；上述 token 门槛**始终必须满足**，防止每轮都为摘要买单。

---

## 6. 压缩（Compaction）——给工作上下文收口

CityBrain 现状：`agent-loop` 把整段 `getContextMessages()` 历史 + 当轮工具结果全推进模型，
无任何压缩，长会话必撞 `DEFAULT_CONTEXT_WINDOW=128k`。

参照 Claude Code 2 四层收口，按成本递增：

1. **Microcompact（最便宜，常开，零摘要）**：只清**高容量工具**（run_qgis_algorithm 的 stdout、
   list/describe 的目录清单、read_file 的正文）的 tool 结果，替换为
   `"[Old tool result content cleared]"`，保底留最新 1 条。时间触发（距上条 assistant 消息间隔久、
   服务端缓存已冷）。**对 CityBrain 尤其有效**——一次 `list_qgis_algorithms` 可能返回几十条算法，
   用完就该清。
2. **会话笔记压缩（优先；免 LLM 调用）**：压缩触发时，用**已写好的会话笔记文件直接当摘要**，
   不跑 LLM。保留"最后一条摘要游标"之后的消息，再向前扩展以满足最小量（≥10k tokens 且 ≥5 个
   text 块，硬 cap 40k）。**切块时必须保 API 不变量**：`tool_use`/`tool_result` 配对上、thinking
   块不拆——这正是 CityBrain 的 `messages.push` 保序结算最该护理的地方。
3. **LLM 压缩（兜底）**：整段历史让模型摘要。沿用 Claude Code 2 的 9 段模板：
   Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and fixes /
   Problem Solving / **All user messages** / Pending Tasks / Current Work / Optional Next Step。
   用 `<analysis>`（草稿，剥掉）+ `<summary>`（保留）包装；**必须加 "no tools" 前置**——maxTurns:1
   时一次被拒的工具调用 = 零输出。
4. **优雅降级 + 熔断**：告警/错误阈值（窗口−20k / −20k）、硬界窗口−3k；连续 3 次 autocompact 失败
   熔断，避免反复打 API 撞 prompt_too_long。

**触发数学（转录定值）**：阈值 = `窗口 − 13k buffer`；保留区 ≤20k 预留做摘要输出。CityBrain 的
128k 窗口下，autocompact 在 ~115k 触发。

---

## 7. 领域化：CityBrain 该记什么 / 不该记什么

这是本设计区别于通用模板的核心。判据承接 §0:记忆只存**不可派生**的知识；可派生的一律排除。

### 该记（高价值，建议入 memory/）

| 类别 | 例子 | 类型 |
|---|---|---|
| 数据源指针 | 输入影像绝对路径、S1C/IW/IW 数据目录、水质数据 CSV 位置 | `reference` |
| 坐标系/投影决策 | "本流域统一用 EPSG:32650 输出" | `feedback`/`reference` |
| 字段/语义字典 | 某图层 `TYPE` 字段含义（水库/湖泊/河流/渠） | `reference` |
| 既往分析结论 | 某区域淹没范围/过程参数小结（会被新轮引用） | `project` |
| 用户工作流偏好 | 输出必须是 GPKG、缓冲距离要浮点、先 describe 再 run | `feedback` |
| 外部系统指针 | 城市低空/空域系统接口、模型站点 URL | `reference` |

### 不该记（排除；可从当前项目状态派生）

| 排除 | 理由（转录自 Claude Code 2） |
|---|---|
| QGIS 算法目录、算法参数 schema | 每轮 `qgis_process list` 可派生 → 归 **cache/运行时**，不是记忆 |
| 项目代码结构、函数签名、架构 | 读代码可派生 |
| git 历史、修 bug 的配方 | 已被 git/代码记录 |
| 输出文件清单、覆盖态 | 是实时状态，非记忆（强制陈旧声明覆盖此坑） |

**架构结论**：`list`/`describe` 的目录类结果该落**磁盘缓存**（M2 已列的"算法目录缓存"），
落 memory/ 反而违反排除规则——缓存与记忆分层，别混。

---

## 8. 用户驱动 vs 代理驱动：信任不对称

| | 用户驱动（显式、可信、低频） | 代理驱动（自动、启发式、best-effort） |
|---|---|---|
| 写记忆 | `/memory` 命令 + `$EDITOR` 打开目标文件原生编辑；`remember X` 即时写入；CLAUDE.md 全由用户手写 | 后台提取代理：沙箱到 memory/、节流、≤5 轮、与主代理互斥 |
| 召回 | `check memory about X` 显式访问 | LLM 选 ≤5 条 + 陈旧声明 |
| 压缩 | `/clear`、`/compact` 手动触发 | microcompact / 会话笔记压缩 / autocompact 全自动 |
| 关键护栏 | — | 自动提取**不能**污染用户显式记忆；自动召回**永远**带"可能过期、断言前核对" |

---

## 9. 与现有代码的接入点（设计结论，非实现）

| 现有文件 | 接入点 | 说明 |
|---|---|---|
| [session-manager.ts](e:\Geo-agent\src\session\session-manager.ts) | 扩展，不动既有 JSONL 格式 | 增加会话笔记文件句柄、摘要游标 `lastSummarizedMessageId` |
| [agent-loop.ts](e:\Geo-agent\src\agent\agent-loop.ts) | `run()` 组装处 | 接入 `buildSystemParts()`（L1）+ 会话笔记（L2）+ 召回附件 |
| [session-types.ts](e:\Geo-agent\src\session\session-types.ts) | 新增 memory 相关类型 | 记忆单元、召回候选、压缩游标 |
| [interactive-app.ts](e:\Geo-agent\src\app\interactive-app.ts) | 新增 `/memory`、`/remember` 命令 | 复用既有命令分发模式 |
| 新目录 `src/context/`、`src/memory/` | 新模块 | `assemble.ts`（L1）、`memdir.ts`（L3 存储+索引）、`recall.ts`、`extract.ts`、`compact/` |

**记忆目录的根**：承接 [auth-storage.ts](e:\Geo-agent\src\auth\auth-storage.ts) 的 `getCityBrainDir()`
（既有位置），在其下挂 `memory/`，与 `sessions/` 平级——与 Claude Code 2 以"规范化工作根"为
键（多 worktree 共享一套记忆）对齐，保证**同一项目跨会话共享记忆**。

---

## 10. 落地节奏（分阶段，每阶段可独立验收）

| 阶段 | 内容 | 验收标志 |
|---|---|---|
| **P0（记忆存储 + 索引）** | memdir 目录 + frontmatter 模型 + MEMORY.md 索引 + `remember X`/`/memory` 显式读写 | 显式记住一条"数据源路径"，重开会话能 `check memory about` 找回 |
| **P1（L1 组装）** | `buildSystemParts()` 收敛 system prompt + 项目说明 + MEMORY.md 索引 | `/session` 能看到记忆索引已常驻 |
| **P2（召回）** | manifest + 小模型选 ≤5 条 + 陈旧声明附件 | 一个空间分析请求带上 ≤5 条真相关记忆 |
| **P3（会话笔记 + 压缩）** | 会话笔记子代理；microcompact（清大工具结果）→ 会话笔记压缩 → LLM 压缩 | 超长会话不再撞 128k；工具结果自动清 |
| **P4（自动提取）** | 后台提取代理，与主代理每轮互斥、沙箱 + 节流 | 自然对聊后自动沉淀 1 条有效记忆 |

建议先 P0 —— 它最小、可独立验收，且为后续所有召回/压缩提供地基。

---

## 附：从 Claude Code 2 偷到的最重五条（verbatim 要点 + CityBrain 落点）

1. **"记忆是时刻观察、非实时状态"** —— 召回必带陈旧声明，尤其地理数据产物易被覆盖。
2. **"MEMORY.md 是索引，不是记忆"** —— 索引走便宜常驻 L1；正文按需召回，≤5 条预算。
3. **"当主代理写了记忆，后台代理就跳过该段"** —— 提取与显式写每轮互斥，绝不竞态/重复。
4. **召回引擎 = LLM 在 (name,description,type,mtime) 清单上选，非向量检索** —— 零嵌入起手即可用。
5. **会话笔记文件兼作压缩摘要，省掉一次 LLM** —— 切块时用 `adjustIndexToPreserveAPIInvariants`
   保 `tool_use`/`tool_result` 配对、thinking 不拆。

---
*本文基于 2026-09-17 代码现状（会话日志层已就位、记忆/召回/提取/压缩为零）制定；每落地一阶段请回写状态。*