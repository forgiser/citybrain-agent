# Geo-agent（CityBrain）未来工作路线图

> 更新日期：2026-09-17
> 前置文档：[PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md)（项目现状与架构理解）
> 本文回答一个问题：**从"QGIS 环境已可配置"到"自然语言驱动的空间分析"，接下来的路怎么走。**

---

## 0. 当前断点

```
终端外壳 ✅ → 模型接入 ✅ → Agent Loop + 工具机制 ✅（目前只有 read_file）
                                      ↘ QGIS：仅完成运行时的「发现 + 校验 + 配置」
```

QGIS 部分目前是「环境就绪」状态：`/qgis` 能找到并校验 `qgis_process`，但**从 `qgisRuntime` 到实际算法执行完全没有下文**。

下一步的原则：**不铺大架构，先让「模型 → 工具 → qgis_process → 结果回给模型」这条链路端到端跑通一次。** 一旦闭环成立，后续所有能力都在这个骨架上加肉。

---

## M1：执行层 + 三个内置工具（下一个里程碑）

### 第 1 步：`qgis-process-client`（进程执行封装）

在 `src/qgis/` 新建 `qgis-process-client.ts`，复用 `qgis-runtime.ts` 已趟平的 Windows `.bat` 调用方式（`cmd /d /c call`），实现三个方法：

| 方法 | 对应命令 | 说明 |
|---|---|---|
| `listAlgorithms(filter?)` | `qgis_process list --json` | 返回算法清单，支持过滤 |
| `describeAlgorithm(id)` | `qgis_process help <id> --json` | 返回某算法的参数定义 |
| `execute(algo, params)` | `qgis_process run <id> -- KEY=VALUE ...` | 执行算法，返回 exit code + stdout + 输出文件路径 |

**这一步不碰 Agent**，先以 shell 命令作为手动验证桩（与项目渐进风格一致）：

```
/qgis list buffer        → 搜索算法
/qgis info native:buffer → 查看某算法的参数定义
```

这两条命令成本极低，但能尽早暴露真实的坑（见第 3 步风险清单）。

### 第 2 步：把执行层暴露为 Agent 工具

**不走 dist 蓝图中「每个算法生成一个工具」的路线**（那是 M2+）。先给模型 3 个粗粒度工具：

| 工具 | 作用 |
|---|---|
| `list_qgis_algorithms(filter?)` | 按关键词搜索，**限制返回条数**（防 token 爆炸） |
| `describe_qgis_algorithm(id)` | 取参数 schema，模型「先看再调」 |
| `run_qgis_algorithm(id, params, output?)` | 执行算法，返回 exit code + stdout 尾部 + **输出文件绝对路径** |

同时把 `src/agent/agent-loop.ts` 中硬编码的 `read_file` 分发改成一个简单的工具注册表（`Map<string, handler>` 即可，暂不引入 dist 那套完整 ToolRegistry 抽象）。

工具定义中要写清使用约定：绝对路径、先 describe 再 run、输出目录需已存在等，减少模型试错。

### 第 3 步：闭环验收标准

用一句自然语言验收，例如：

> "把 data/roads.shp 做 100 米缓冲区，输出到 output/roads_buffer.gpkg"

模型应自主完成 `list → describe → run` 的调用链，产物文件真实生成。

**能稳定跑通这个，M1 即完成。**

### 已知风险与对策（动手前想好）

| # | 风险 | 对策 |
|---|---|---|
| 1 | **参数拼接**：`run` 用 `KEY=VALUE` 语法，路径含空格、多值参数在 Windows 下易碎 | 执行层负责把结构化参数序列化；强制绝对路径；单测覆盖空格/引号场景 |
| 2 | **超时**：现 `COMMAND_TIMEOUT_MS = 15s`，远不够真实分析（大数据缓冲区/裁剪可达分钟级） | `execute` 使用独立长超时（如 10 分钟）；预留 AbortSignal 中断（接 Ctrl+C） |
| 3 | **结果反馈**：算法产物是输出文件而非 stdout | 解析 `Result: OUTPUT = ...` 类输出，把生成文件的绝对路径回给模型 |
| 4 | **算法目录太大**：QGIS 1000+ 算法，全量 list 吃上下文 | 工具层「搜索 + 截断 + 按需 describe」，单次返回上限（如 20 条） |
| 5 | **安全边界**：`run` 会写文件 | M1 先做简单校验（输入输出路径限制在 workspace 内）；完整沙箱留给 Harness 阶段 |

### M1 明确不做

- per-algorithm 工具工厂
- Docker / 远程 runner（保持菜单占位）
- Harness / 审批门控
- 空间领域模型（M1 用绝对路径字符串凑合）

---

## M2：精细化工具与体验

M1 闭环成立后再做：

1. **常用算法子集的工具工厂**（dist 蓝图 `qgis-tool-factory` 落地）：对 buffer/clip/intersection/reproject 等高频算法生成参数枚举、类型约束齐全的专用工具，提高模型一次调用成功率。
2. **图层检查工具**：`run` 的产物是二进制（gpkg/shp），模型无法 `read_file`。需要一个 `inspect_layer`（字段、要素数、范围、CRS 摘要）类工具，让模型能看懂数据。
3. **算法目录缓存**：`list --json` 结果落盘缓存（含 QGIS 版本号），避免每次会话重复拉取。
4. **执行进度与中断**：长时间算法的 stdout 流式透传到终端；Ctrl+C 触发 AbortSignal 终止子进程。

### M2 增补：执行模型（并发 + yield 事件流）——参考 Claude Code

> **状态（2026-09-17）**：✅ 并发执行已落地（"设计目标 1"）——`ToolRegistry` 支持
> `isConcurrencySafe(input)` 注册项，`agent-loop` 的 `startToolCalls` 按队列扫描调度
> （安全工具并发启动、独占工具排空后独跑、结果按调用顺序结算）；三个 QGIS 工具中
> `list`/`describe` 声明并发安全，`run` 独占。
> ✅ yield 事件流已落地（"设计目标 2"）——`AgentLoop.run()` 改为 async generator，`yield`
> 结构化事件（`text`/`thinking`/`tool_started`/`tool_result`），UI 端改为 `for await` 逐条消费；
> 工具事件经 `executeToolTurn` 的事件队列 + 唤醒信号桥接并发调度器，事件随到随吐、结果按序结算。
> ⬜ 完整对齐 query.ts 的形态③（状态机 + StreamingToolExecutor 整体搬迁）为后续迭代。
> 注：`run` 的路径冲突感知细化（不同 OUTPUT 并行）为后续迭代。
> **CLI 渲染策略（2026-09-17）**：工具消息在 CLI 中**不展示具体返回内容**——成功仅显
> 示头部（工具名 + 目标），失败追加一行截断原因，避免算法 schema/目录清单撑爆终端。

从 `E:\Claude\Claude-Code2-main\src\services\tools\StreamingToolExecutor.ts` 与
`E:\Claude\Claude-Code2-main\src\query.ts` 提炼的一条主线：**工具执行不该阻塞模型回答。**

#### 现状诊断（2026-09-17 实测）

```
model-chat.ts：  streamModelChat 是 async generator ✅（yield 已到协议层）
agent-loop.ts：  run() 普通 async fn ❌ 把每个 delta 折叠成 response += delta
interactive-app：回调消费 onDelta/onToolCall ❌（无 for-await、无中途丢弃）
```

工具结算点在 [agent-loop.ts:120](../e%3A\Geo-agent\src\agent\agent-loop.ts#L120-L146)
是**纯串行**：`for (const toolCall) { await execute }`。一次模型回复 3 个 qgis 工具 = 3 个串行耗时。

#### 设计目标

1. **并发执行**：工具注册时多携带一个 `isConcurrencySafe(input) => boolean`。规则（对齐 StreamingToolExecutor）：

   | 条件 | 结论 |
   |---|---|---|
   | 当前无工具在跑 | 任何工具可启动 |
   | 新工具并发安全 且 所有在跑工具都并发安全 | 可并行 |
   | 否则（含非并发工具想启动） | 独占执行，排在它后面的全部等待 |

   你的工具天然分类：`list_qgis_algorithms` / `describe_qgis_algorithm` = 并发安全（只读）；
   `run_qgis_algorithm` = **取决于入参**——不同输出路径可并行，写同一 workspace/同名输出必须独占。
   `isConcurrencySafe` 设计成"入参函数"而非静态标志，正是为 run 这种按输出路径判定的场景。

2. **yield 事件流（拉模型）**：把 `run()` 改为 `async function*`，`yield` 结构化事件
   （`text` / `thinking` / `tool_started` / `tool_result` / `tool_progress` / `done`），UI 改 `for await`。
   - 不折叠、不转回调，让 view 拿到可中途丢弃的结构化流；
   - 中断 = `generator.return()` 统一收口（对齐 query.ts 的 terminal 通道），而非丢一个字符串；
   - 每次工具开始/结束作为旁路事件 yield 出去，为长算法（几分钟）提供实时 UI 反馈。

3. **协议边界（硬约束）**：工具结果结算必须**按接收顺序**连续推回 messages——API 不允许
   tool_result 与普通 user 消息交错（query.ts ~1535 行明示）。并发快慢无序没关系，结算必须保序。

#### 两条正交原则（别混淆）

- **yield 负责"出口"**（结构化事件如何流出给 UI）；
- **并发负责"后台"**（工具用 fire-and-forget 起 promise 存队列，generator 等待期 `Promise.race` 醒来）。
  工具执行不能做成 generator 内部的裸 `await` 串联——那会让 UI 停在一次 tool_result 上干等。

#### 三个来自 query.ts 的细节（同样值得抄）

- **定向错误级联**：只有"有依赖链"的工具出错才取消兄弟（Bash 那类）；独立工具（Read/WebFetch/你的 `list`/`describe`）错一个不牵连其它。`run_qgis_algorithm` 算哪个阵营？—— 若写不同输出路径，视为独立，不牵连。
- **进度消息绕开排序**：长任务中间进度随到随上抛（`pendingProgress` + 唤醒信号），不等结果攒齐。
- **完整对齐阶段（形态③预览）**：状态机 `State` + `turnCount` + `StreamingToolExecutor` 整体搬进 generator 内部——query.ts 整套编排，列入 M2/M3 过渡。

#### 落地节奏

- **形态①（已就位）**：现状。能用，但拿不到中途丢弃/续传。
- **形态②（M2 推荐）**：`run()` 改 async generator + UI `for await`，不动 model-chat / 工具层，只改返回值形状与 UI 消费方式。
- **形态③（M3 候选）**：query.ts 完整编排搬入。

---

## M3：Harness 与工程化（对应 dist 蓝图）

1. **Agent Harness**：一次完整 run 的应用级所有权（会话/工具/事件调度），替代 `interactive-app.ts` 里逐步膨胀的 context 传递。
2. **审批门控（approval-gate）**：`run_qgis_algorithm`、未来任何写文件/执行类工具在执行前请求用户确认（可按工具/按会话配置白名单）。
3. **空间领域模型**：落地 `dist/domain/spatial.d.ts` 的 LayerRef / Extent / CRS / format 约定，统一工具间传参。
4. **扩展机制**：启用空的 `extensions/` 目录，允许以 pi 扩展风格注入自定义算法包与工具。

---

## M4：运行时多样化（占位转正）

把设置菜单中的占位项变为可用：

1. **Docker runtime**：在官方 `qgis/qgis` 容器内执行 `qgis_process`，宿主通过卷挂载交换数据；`/qgis setup` 选项 3 从占位消息变为可用的检测 + 配置流程。
2. **远程 QGIS runner**：连接暴露 `qgis_process` 的远程机器/服务（HTTP 包装），选项 4 同理。
3. 两者的验收标准与 M1 相同的闭环指令。

---

## 里程碑总览

| 里程碑 | 主题 | 完成标志 |
|---|---|---|
| **M1** | 执行层 + 3 个通用工具 | 自然语言一句指令完成一次真实空间分析（缓冲区验收） |
| **M2** | 精细化工具 + 图层检查 | 高频算法专用工具 + `inspect_layer`，模型一次调用成功率明显提升 |
| **M3** | Harness + 审批 + 领域模型 | 写操作有审批；架构与 dist 蓝图对齐 |
| **M4** | Docker / 远程 runner | 设置菜单选项 3/4 从占位变可用 |

---

*本文档基于 2026-09-17 的代码现状（runtime 检测/配置已完成、执行层为零）制定；每完成一个里程碑请回写完成状态。*
