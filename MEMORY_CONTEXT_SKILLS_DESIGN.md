# CityBrain 记忆·上下文·自进化 SKILLS 体系

> 目标：为 CityBrain（用 LLM 驱动 `qgis_process` 做城市空间分析的 shell）设计一套
> **记忆管理 + 上下文组装 + 可自进化工具能力库** 的整体架构。
>
> 定位说明：本文是**决赛版**，淘汰了初稿"通用记忆系统"（见 [CONTEXT_MEMORY_DESIGN.md](CONTEXT_MEMORY_DESIGN.md)，留作对照）。
> 决赛版只留三样东西：**动静拼装**（借鉴 Claude 的思路）、**数据血缘账本**（项目原生）、
> **自进化 SKILLS**（差异化核心）。
>
> 状态：设计阶段，未写代码。

---

## 0. 一句话总纲

三层静态结构（像 Claude）+ 一个随项目走的血缘账本（GIS 原生）
+ 一套**随成败自动沉淀、按工具织成网络的 SKILLS 手册**（真正的差异化）。

面试口径：**"这不是 Claude Code 的记忆。Claude 的记忆是藏在用户目录的通用笔记；我的记忆分两层——
随项目走、可版本化、可审阅的『数据血缘账本』，加上一套在每次 qgis 成功/失败中自我沉淀、可复用的
『操作手册 SKILLS』。召回也因此极简：项目小就整本带上，不需要 vector 检索或 md 记忆子代理。"**

---

## 1. 四层记忆总览（生命周期 × 召唤时机）

| 层 | 性质 | 内容 | 载体 | 生命周期 | 写者/信任 | 召唤时机 | 预算 |
|---|---|---|---|---|---|---|---|
| **L0 静态/指令** | 常驻 | System prompt、分析项目说明、MEMORY.md 索引 | `<CITYBRAIN_DIR>/CLAUDE.md 栈` + 内存 | 跨项目 · 长期 · 低频改 | 用户显式 · 高 | **每轮必读（缓存后整会话一次）** | <8k token |
| **L1 工作上下文** | 会话态 | 对话 transcript + **血缘账本** | 项目的 `ANALYSIS_LEDGER.md` | 项目级 · append-only（账本） | 代理结算后 append · 中高 | **动态：每一步工具结算后重建** | 账本整体 |
| **L2 长期记忆** | 事实/偏好 | 用户偏好、领域常识、既往结论 | `<CITYBRAIN_DIR>/memory/*.md` | 跨项目 · 长期 | 用户/`/remember` · 高 | 一次性召回（小预算） | ≤3 条 |
| **L3 自进化 SKILLS** | 程序性 | 选工具·参数惯例·失败手册·数据准备·性能 | 项目的 `qgis-skills/<域>/<名>.md` + `SKILL_INDEX.md` | 随项目自我进化 | 进化引擎 · 中 | **事件驱动：选工具/执行失败时** | ≤3 条/事件 |

> **一句话区分四层**：L0=指令（永远在）；L1=进行到哪（每步翻篇）；L2=事实（按需召回）；
> L3=怎么做/怎么修（出事时才查）。**L1、L3 都住在项目里**——这才是我和你系统的分野。

---

## 2. L0 静态层：动静拼装（保留你点名的部分）

动静拼装的核心是 `buildContext(deps)`，三段按时机喂：

```
buildContext(deps)
├─ 静块  system prompt + 项目说明 + MEMORY.md      → 缓存整会话，一次构建（优先覆盖，@include≤5）
├─ 动块  L1 状态头（目标/当前阶段/待办/活跃指针）   → 每个分析动作后失效重建
└─ 条件块 L3 by-tool / by-failure SKILLS            → 事件触发时才拉（见 §6 时间线）
```

- 静块成本最低，长期缓存；动块是"每步在翻篇"的部分；条件块是"出事/要选工具"才介入的部分。
- 这层是**每轮都进上下文**的，必须控制总量（静块 <8k）。

---

## 3. L1 工作上下文：数据血缘账本（项目的经纬）

项目天然小且自足（一个文件夹、十几个数据层、一个目标），所以账本可以**整本载入**。

```
<项目文件夹>/
  out/  step*/   ...shp/gpkg/tif...
  ANALYSIS_LEDGER.md    ← append-only 血缘账本
```

**账本头（每次进入自动刷新，反映"现在进行到哪"）：**
```markdown
目标:   蒲胶流域淹没范围与影响分析
当前阶段: 缓冲已完成，下一步与城市绿地叠置
待办:   核对 buffer_500 与绿地 CRS 是否一致
活跃指针: output/buffer_500.gpkg
```

**账本条目（每步 appended 一行，间接引出 [agent-loop.ts](e:\Geo-agent\src\agent\agent-loop.ts) 的 run 结算点）：**
```markdown
### step-03 · 道路缓冲
- input:   step-02 → output/roads_clean.gpkg
- tool:    native:buffer
- params:  DISTANCE=500, JOIN_STYLE=1
- output:  buffer_500.gpkg
- 意图:    为后续与绿地叠置做准备
- 时间:    2026-09-17
```

**为什么要记它**：文件在不在能 `lstat`，但"哪个文件是哪个算法的产物、下一步喂给谁"这条
**语义推导链**读不出来。账本 = 分析推导链的唯一载体。

- **生命周期**：项目级，append-only；随项目版本化、可审阅、可分享。
- **召唤时机**：动态每轮；账本小→**整本注入**（<几 KB）；账本撞预算→**折叠旧步成阶段小结**（见 §7）。

---

## 4. L2 长期记忆：轻量事实/偏好（保留，但砍到最薄）

不建 taxonomy 子代理、不做召回选择引擎。就是一个小目录 + 用户/`/remember` 显式写：

```
<CITYBRAIN_DIR>/memory/
  MEMORY.md            # 索引，进 L0 常驻
  user-crs.md          # 默认 EPSG:32650
  pref-output-gpkg.md  # 输出偏好 GPKG
```

- 召回 = 一次性把小索引 + 命中条目带进上下文（预算 ≤3 条），**不跑模型选择**——因为量小，全带即可。
- 带 **陈旧声明**：`memory 是时刻观察，断言前先对照当前 workspace 与 qgis_process 校验`。

---

## 5. 自进化 SKILLS：能促进 qgis 工具用的内容（核心）

### 5.1 什么内容"促进 qgis 工具使用"——六大能力类型

| 类型 | 回答的问题 | 示例 |
|---|---|---|
| `selection` 工具选择 | "这个任务该用哪个算法？" | 多边形裁剪→`native:clip`；融合→`native:dissolve`；求交→`native:intersection` |
| `usage` 参数惯例 | "这个算法参数怎么给对？" | `native:buffer` 的 DISTANCE 单位；`-1` 保留原值 |
| `failure` 失败手册 | "这个错误怎么修？" | 算法 id 拼错→先 `list` 确认；CRS 不匹配→`reproject`；路径空格→转义 |
| `prep` 数据准备 | "执行前要备什么？" | 建工作区、统一 CRS、检查字段 |
| `perf` 性能/资源 | "大数据怎么不卡？" | 大数据跑独占模式；合理 `timeoutSeconds` |
| `semantics` 领域常识 | "这类数据标准链？" | S1C 影像、河流矢量的惯用处理链 |

### 5.2 SKILL 单元结构（frontmatter 驱动）

```markdown
---
name: buffer-idiom
kind: usage
applies_to: [native:buffer]                 # 工具↔技能 关联
trigger: [task:buffer, param:DISTANCE]      # 选择/触发信号
error_signature: [QgsProcessingException]   # 失败类：错误签名匹配
domain: geometry-operations
tags: [buffer, distance, units]
---
<runbook>: 前置条件 / 推荐参数 / 常见坑 / 验证方法 + **Why:** + **How to apply:**
```

### 5.3 组织形式：能力域目录 + 索引 + 关联

```
<项目文件夹>/qgis-skills/
  SKILL_INDEX.md                    # 像 MEMORY.md，但给 skills 用（进 L0 常驻？否 — 事件触发拉）
  geometry-operations/buffer-idiom.md / clip-selection.md
  crs/reproject-idiom.md
  failures/windows-path-traps.md / timeout-heavy-data.md
```

**四类关联（织成网络，正是"动态 skills 的关联"）：**
- **tool → skill**：`run_qgis_algorithm(algorithm=X)` 被选中时，按 `applies_to` 拉 usage
- **failure → skill**：`tool_result.is_error` 时，按 `error_signature`（算法 id + 错误关键词）拉 failure
- **skill → skill**：交叉引用（crs-mismatch 连到 reproject-idiom）
- **skill → memory**：skills 可引用项目事实（如"本项目统一 EPSG:32650"）

### 5.4 自进化机制（事件驱动、节流、与显式写互斥）

**触发源（谁触发进化）：**
- `run`/`list`/`describe` **成功**且模型用了值得固化的做法 → 抽 `usage`/`selection` 候选
- `run` **失败**且存在可复现的修复 → 抽 `failure` 候选
- 检测到**重复的排障步骤**（同一条排查走两遍）→ 提醒固化为手册

**进化流水线（两级，保质量）:**
1. **extract 候选**（事件发生当刻，轻量）：from 最近若干工具事件，判断"是否有一条**非可派生**的、可复用程序性经验"；写为候选 skill 文件（frontmatter `status: candidate`）+ 记 SKILL_INDEX。
2. **consolidate 晋升**（节流批处理，≤ 每 N 轮一次）：对候选做 dedup（查索引去重）、补联动（tool/skill/memory 交叉引用）、`status → promoted`。一条候选被实际使用成功后，其 `usedCount++` 做正向反馈。

**护栏（对齐 Claude 心法）：**
- **互斥**：当轮主代理已写过 skill 则不进化（同 range 跳过）
- **沙箱**：只写 `qgis-skills/`，`rm` 拒绝（只能软弃用 `status: retired`）
- **节流**：一次进化 ≤1 条新 skill；只响应"成功有沉淀 / 失败可修复"的显著事件，杜绝每轮刷
- **排除**：qgis 算法目录、schema 可派生 → 归 cache；skills 只存**硬打出来的经验**

### 5.5 为什么它是差异化

- 面试：**"记忆体系不抄 Claude 的通用笔记，而是：状态层=随项目走的血缘账本；能力层=随每次
  qgis 成败自动沉淀、按工具织成网络的操作手册。模型不记'所有东西'，只记'项目跑成的推导链'
  和'怎么把 qgis 用顺'。"**
- 自进化 = "用过 → 沉淀 → 织网 → 被复用"的闭环，不是静态文件库。

---

## 6. 记忆读取位置：一次交互何时读哪层（核心，明确到环节）

记忆管理成败在于**明确的读取时机**。下面按一次用户消息的推进，逐环节标注 read/write 哪层、预算、决策。

```
┌──────────────── 一次交互（user turn）的时间线 ────────────────┐
│                                                                  │
│ ① 回合开始                                                       │
│    READ   L0 静块（缓存一次）+ L2 小召回(≤3) + L1 账本头/末段    │
│    → 组装 system + 记忆 + 状态头                                  │
│                                                                  │
│ ② 模型决定进入 QGIS 工具选择（分析任务）                          │
│    READ   L3 `selection` skills（by task-match）→ 注入 hint       │
│                                                                  │
│ ③ run_qgis_algorithm 被选中（即将调用 <algo>）                   │
│    READ   L3 `usage` skills（by applies_to[algo]）→ 注入运行前提示│
│    → 并发调度器启动（isConcurrencySafe / .env）                  │
│                                                                  │
│ ④ 工具结果返回 —— 成功                                           │
│    WRITE  L1 账本 append 血缘行                                   │
│    EVAL   L3 是否抽 usage/selection 候选（图节流）                │
│                                                                  │
│ ⑤ 工具结果返回 —— 失败 (is_error=true)                           │
│    READ   L3 `failure` skills（by error_signature）→ 注入修复手册 │
│    → 下一 assistant 轮据此排障                                    │
│                                                                  │
│ ⑥ 回合完整结束（最终回复，无工具）                               │
│    WRITE  L1 账本头刷新（当前阶段/待办）                          │
│    EVAL   L3 consolidate 晋升（节流批处理）                       │
│                                                                  │
│ ⑦ 上下文撞预算                                                 │
│    COMPACT  L1 折叠旧账本步 → 阶段小结（唯一压缩层，见 §7）       │
│                                                                  │
│ ⑧ 重开会话 / 断点续作（新会话·同项目）                           │
│    READ   从 ANALYSIS_LEDGER.md 头 + 末段恢复 L1 → 无缝续跑       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**矩阵（何时 read/write 哪层 → 打到 §1 的每一行）：**

| 触发点 | 层 | 操作 | 预算 | 决策 |
|---|---|---|---|---|
| 回合开始 | L0 / L2 / L1 | READ | 静<8k, 记≤3, 账本整体 | 不用选，直接带 |
| 任务→选工具 | L3 selection | READ | ≤3 | task-match |
| 选中算法 | L3 usage | READ | ≤1 | applies_to[algo] |
| 结果成功 | L1 | WRITE append | — | 结算后必写 |
| 结果成功 | L3 | WRITE(候选) | ≤1 | 显著成功才抽 |
| 结果失败 | L3 failure | READ | ≤3 | error_signature |
| 回合结束 | L1 | WRITE 头刷新 | — | 阶段/待办 |
| 回合结束 | L3 | WRITE(晋升) | ≤1 | 节流批处理 |
| 撞预算 | L1 | COMPACT 折叠 | — | 旧步→小结 |
| 新会话 | L1 | READ 恢复 | 账本末段 | 断点续作 |

---

## 7. 压缩 = 仅一层（砍掉四件套）

不需要 microcompact/会话笔记/autocompact 四件套。CityBrain 场景只需 **账本折叠**：

- **触发**：账本 token 预计超所剩窗口（对照使用 `DEFAULT_CONTEXT_WINDOW=128k` 与现有
  [session-manager.ts:getContextUsage](e:\Geo-agent\src\session\session-manager.ts#L183) 的统计）。
- **动作**：把旧步折叠成"阶段小结"一行（保留 input→output 链头尾，去掉中间参数细节），最新 N 步保留原样。
- **保序**：折叠发生在账本文本层，不碰对话 `messages`，故不破坏 `tool_use/tool_result` 配对（Claude 心法——但要保的知识在 [agent-loop.ts](e:\Geo-agent\src\agent\agent-loop.ts) 结算时那一条连续块即可）。
- 另含 L2 删除/软退休的陈旧管理。

---

## 8. 用户驱动 vs 代理驱动（信任）

| | 用户（显式·可信·低频） | 代理/进化引擎（自动·启发式·best-effort） |
|---|---|---|
| L0 静块 | `CLAUDE.md` 手写 | — |
| L1 账本 | 可 `$EDITOR` 审阅/修正 | 结算后自动 append + 头刷新（只增不删） |
| L2 事实 | `/remember`、`/memory` | 不自动写（保持薄） |
| L3 skills | 可审阅/`retired` | 候选抽取 + 晋升去重 + 织网，沙箱/互斥/节流 |

关键护栏：自动进化**不能**污染用户写的事实；任何召回记忆**必带**"以磁盘/当前状态为准"的声明。

---

## 9. 与现有代码的接入点

| 现有模块 | 接入点 |
|---|---|
| [context/ 新建](e:\Geo-agent\src\context) `buildContext.ts` | L0 静块 + L1 动块 + L3 条件块的组装 |
| [memory/ 新建](e:\Geo-agent\src\memory) | 账本读写、L2 目录、skills 清单/关联 |
| [agent-loop.ts](e:\Geo-agent\src\agent\agent-loop.ts) | ⑥回合结束时调账本追加；②③⑤工具调度点挂 skill 注入 |
| [session-manager.ts](e:\Geo-agent\src\session\session-manager.ts) | 复用 `getCityBrainDir()` 定根；不动现有 JSONL |
| [interactive-app.ts](e:\Geo-agent\src\app\interactive-app.ts) | 新增 `/memory`、`/skills`、`/ledger` 查看命令 |
| [auth-storage.ts](e:\Geo-agent\src\auth\auth-storage.ts) | 提供根目录 |

---

## 10. 落地节奏（每阶段可独立验收）

| 阶段 | 内容 | 验收标志 |
|---|---|---|
| **P0 磁盘骨架** | 项目 `ANALYSIS_LEDGER.md`（账本+头）+ `qgis-skills/` 目录 + `buildContext()` 静/动块 | 会话尾生成一份可读账本 |
| **P1 血缘落账** | run 结算后 append 账本行；回合末刷新状态头；账本整本注入上下文 | 一句"缓冲了 roads，下一步叠绿地"，下一问模型记得 |
| **P2 断点续作/折叠** | 新会话同项目恢复账本末段；撞预算折叠 | 关掉重开，还能从当前阶段继续 |
| **P3 自进化 skills** | extract 候选（成功/失败事件）+ consolidate 去重织网 + ②③⑤注入 | 一次失败后，下次同类错误能自动查到手册 |
| **P4 Skills 反馈闭环** | usedCount 晋升/退休；`/skills` 查看 | 手册被实际复用并沉淀 |

---

*本文基于 2026-09-17 代码现状制定；每落地一阶段请回写状态。P0 最小可验收，建议先做。*