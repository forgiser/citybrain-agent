# Geo-agent Claude Code 风格工具执行 Harness 改造规划

## 1. 文档目的

本文档规划将当前 Geo-agent 的工具执行机制，逐步升级为类似 Claude Code 的“工具任务状态机”：

- 前台工具默认等待真实完成后再进入下一轮模型循环；
- 长任务执行期间持续产生进度事件，而不是阻塞 CLI；
- 支持显式后台执行和后续任务查询；
- 对 QGIS 输出文件建立产物状态管理；
- 阻止 `read_file` 在依赖的 QGIS 任务尚未完成时提前读取；
- 保证工具调用、工具结果、异常和中断之间始终保持完整对应关系；
- 将工具执行过程完整落地到日志，方便定位“命令成功但文件不存在”等问题。

本文档只描述改造方案，不代表本阶段已经完成代码实现。

## 2. 当前结论

### 2.1 改造规模

整体属于**中等规模的 Harness 改造**，不是简单修改一个 QGIS 函数，也不需要完全重写 Agent Loop。

当前系统已经具备以下基础能力：

1. [agent-loop.ts](E:/Geo-agent/src/agent/agent-loop.ts) 已经存在模型循环、工具轮次和最终化机制。
2. 工具已经通过 `isConcurrencySafe` 区分并发安全与独占执行。
3. `run_qgis_algorithm` 当前已经设置为独占工具。
4. `AgentEvent` 已经支持 `tool_started` 和 `tool_result`。
5. [tool-execution-log.ts](E:/Geo-agent/src/tools/tool-execution-log.ts) 已经可以记录工具开始、结束和 Harness 状态。
6. CLI 已经可以显示工具执行成功和失败的不同背景色。
7. 上下文、压缩和上下文追踪日志已经存在。

当前缺少的不是“有没有等待 Promise”，而是：

- 工具执行期间的实时进度；
- 工具前台/后台任务模型；
- 工具结果的后置条件验证；
- QGIS 输出文件与读取工具之间的依赖关系；
- 工具取消、超时和后台完成通知；
- 更完整的工具生命周期和恢复机制。

### 2.2 当前执行模型

当前 Agent Loop 的主要流程是：

```text
用户输入
  -> 调用模型
  -> 收集一批 tool call
  -> executeToolTurn()
  -> 等待工具 Promise 完成
  -> 将工具结果加入上下文
  -> 进入下一次模型请求
```

当前 `executeToolTurn()` 会等待工具处理完成，因此如果 QGIS 进程一直没有退出，正常情况下模型不会提前进入下一轮。

但是当前并发调度只理解“工具本身是否安全”，不理解“工具之间是否存在数据依赖”。例如：

```text
run_qgis_algorithm(生成 output.csv)
read_file(output.csv)
```

`read_file` 本身是只读工具，因此可能被认为可以并发执行。当前 Harness 不会自动判断它读取的是一个正在生成的 QGIS 产物。

## 3. 参考 Claude Code 的核心机制

参考 `E:\Claude\Claude-Code2-main\src\query.ts`、`StreamingToolExecutor.ts`、`BashTool.tsx` 和 `LocalShellTask.tsx`，需要借鉴以下机制。

### 3.1 工具执行状态机

Claude Code 不是简单地执行：

```text
调用工具 -> await -> 返回字符串
```

而是为每个工具维护状态：

```text
queued
  -> executing
  -> completed
  -> yielded
```

Geo-agent 建议扩展为：

```text
queued
  -> starting
  -> running
  -> verifying_outputs
  -> completed
  -> yielded
```

异常状态：

```text
failed
timed_out
cancelled
backgrounded
output_pending
output_missing
output_invalid
```

### 3.2 前台执行和下一轮模型请求

前台工具的规则应保持清晰：

```text
工具处于 running
  -> Agent Loop 不开始下一轮模型请求
  -> 工具可以持续发送 progress 事件
  -> 工具完成并生成正式 tool result
  -> Agent Loop 才开始下一轮模型请求
```

因此对于一个执行 10 分钟的 QGIS 算法：

- 不应每隔几秒重新调用模型；
- 不应让 `read_file` 自己盲目轮询；
- 应该由当前工具任务持续报告状态；
- 任务完成并验证输出后，才向模型提交最终工具结果。

### 3.3 进度事件不等于新一轮推理

执行期间的进度只更新 CLI 和 Harness 状态，不追加新的模型对话轮次：

```text
tool_started
  -> tool_progress
  -> tool_progress
  -> tool_progress
  -> tool_result
  -> 下一轮模型
```

进度事件可以包含：

- 已运行时间；
- 当前阶段；
- 最近一段 stdout/stderr；
- 输出文件大小；
- 进程 PID；
- 当前 QGIS 算法；
- 当前产物状态。

### 3.4 显式后台任务

对于用户明确允许后台执行的长任务：

```text
run_qgis_algorithm(run_in_background=true)
  -> 创建 task_id
  -> 启动 QGIS 进程
  -> 当前工具立即返回 running
  -> Agent Loop 进入下一轮
  -> 后台任务完成后写入通知
```

后台模式返回的内容不能是“Algorithm completed”，而应该类似：

```text
QGIS task started in background.
task_id: qgis-task-123
status: running
expected_outputs:
  - E:/data/output.gpkg
```

只有任务完成并验证输出后，才能发送：

```text
task_completed
```

### 3.5 自动后台化

后续可以参考 Claude Code，为前台长任务增加可配置的阻塞预算，例如：

```text
前 15 秒：保持前台，等待快速完成
超过 15 秒：自动转后台
```

但是对于当前 MVP，不建议第一阶段直接启用自动后台化。QGIS 算法通常具有明确的空间数据依赖，过早后台化会增加模型对任务状态理解的复杂度。

推荐顺序：

1. 先实现稳定的前台等待和进度事件；
2. 再实现显式 `run_in_background`；
3. 最后再评估自动后台化。

## 4. 目标架构

### 4.1 目标组件

建议新增或扩展以下组件：

```text
AgentLoop
  -> ToolExecutionManager
       -> ToolTaskRegistry
       -> ToolScheduler
       -> ToolProgressBus
       -> ArtifactRegistry
       -> CancellationManager
       -> ToolExecutionLogger
```

职责划分：

| 组件 | 职责 |
| --- | --- |
| `ToolExecutionManager` | 统一管理一次工具调用的完整生命周期 |
| `ToolTaskRegistry` | 保存前台和后台任务状态 |
| `ToolScheduler` | 处理并发、独占和依赖顺序 |
| `ToolProgressBus` | 将进度事件传递给 Agent Loop 和 CLI |
| `ArtifactRegistry` | 记录正在生成、已完成和失败的文件产物 |
| `CancellationManager` | 处理 Ctrl+C、超时和任务终止 |
| `ToolExecutionLogger` | 记录生命周期、进度、结果和错误 |

第一阶段可以不拆成这么多文件，先在现有 `ToolRegistry` 和 `AgentLoop` 中实现最小版本；当后台任务和多个生产工具出现后，再拆分组件。

### 4.2 统一工具任务模型

建议引入类似下面的任务结构：

```ts
type ToolTaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "verifying_outputs"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "backgrounded";

interface ToolTask {
  taskId: string;
  runId: string;
  turn: number;
  toolCallId: string;
  toolName: string;
  argumentsText: string;
  status: ToolTaskStatus;
  startedAt?: string;
  endedAt?: string;
  processId?: number;
  progress?: ToolProgress;
  expectedArtifacts?: ArtifactRef[];
  verifiedArtifacts?: ArtifactRef[];
  missingArtifacts?: ArtifactRef[];
  result?: ToolExecutionOutcome;
  error?: string;
}
```

### 4.3 统一进度事件

现有 `AgentEvent` 建议增加：

```ts
| { type: "tool_progress"; taskId: string; progress: ToolProgress }
| { type: "task_notification"; taskId: string; status: ToolTaskStatus; message: string }
```

推荐的进度结构：

```ts
interface ToolProgress {
  phase: "starting" | "running" | "verifying_outputs" | "completed";
  elapsedMs: number;
  message?: string;
  stdoutTail?: string;
  stderrTail?: string;
  outputBytes?: number;
  outputPaths?: string[];
}
```

## 5. 重点改造范围

### 5.1 `AgentLoop`

文件：[agent-loop.ts](E:/Geo-agent/src/agent/agent-loop.ts)

当前已经具备工具轮次和状态事件，因此不需要重写主循环，主要改造：

1. `executeToolTurn()` 从直接等待工具 Promise，改为消费工具任务事件。
2. 保证前台任务在产生最终结果前不会进入下一轮模型请求。
3. 允许进度事件穿透到 CLI，但不把进度事件加入模型上下文。
4. 支持后台任务立即返回 `running` 结果。
5. 处理任务取消、超时和进程终止。
6. 对异常任务产生结构化 tool result，而不是让模型只看到一行普通错误。
7. 保留当前 `MAX_TOOL_TURNS` 和重复工具批次保护。

### 5.2 `ToolRegistry`

文件：[tool-registry.ts](E:/Geo-agent/src/tools/tool-registry.ts)

当前 `ToolHandler` 只有：

```ts
type ToolHandler = (args, context) => Promise<string>;
```

建议逐步扩展为支持任务上下文和进度：

```ts
interface ToolExecutionContext extends ToolCallContext {
  taskId: string;
  signal: AbortSignal;
  emitProgress(progress: ToolProgress): void;
  registerArtifacts(artifacts: ArtifactRef[]): void;
}
```

工具返回值也建议从纯字符串逐步升级为：

```ts
interface ToolExecutionResult {
  ok: boolean;
  status: "completed" | "running" | "failed";
  content: string;
  artifacts?: ArtifactRef[];
  taskId?: string;
}
```

为了降低改造风险，普通的 `read_file` 和 `list_files` 可以继续返回字符串，由 Registry 统一包装。

### 5.3 `qgis-process-client.ts`

文件：[qgis-process-client.ts](E:/Geo-agent/src/qgis/qgis-process-client.ts)

这是 QGIS 可靠性的核心改造点：

1. 从一次性 `execFile` 输出，改成可监听 stdout/stderr 的进程执行器。
2. 保存 QGIS 进程 PID。
3. 支持 `AbortSignal`。
4. 支持定期发送运行时长和最近输出。
5. 同时记录 stdout 和 stderr。
6. 解析 `Result:`、`OUTPUT:` 和 `Results:` 形式的输出。
7. 从算法参数和 QGIS 结果中提取预期输出路径。
8. 进程退出后验证输出文件是否存在。
9. 必要时验证文件大小和可访问性。
10. 将“进程退出成功但文件不存在”标记为 `output_missing`，不能返回普通成功。

必须明确区分：

```text
process_exit_0
  !=
output_exists
  !=
output_readable
  !=
output_valid
```

### 5.4 `qgis-tools.ts`

文件：[qgis-tools.ts](E:/Geo-agent/src/qgis/qgis-tools.ts)

建议将 `run_qgis_algorithm` 的描述和返回契约改成：

- 默认前台执行；
- 长任务可以使用 `run_in_background`；
- 返回 `taskId`、状态、耗时和输出文件；
- 只有通过输出校验后才返回 `completed`；
- 输出缺失时明确返回 `output_missing`；
- 不自动因为 `read_file` 失败而重新运行整个算法。

建议第一版新增参数：

```json
{
  "algorithm": "gdal:executesql",
  "parameters": {},
  "timeoutSeconds": 600,
  "runInBackground": false
}
```

### 5.5 `read_file` 和 `list_files`

文件：

- [read-file.ts](E:/Geo-agent/src/tools/read-file.ts)
- [list-files.ts](E:/Geo-agent/src/tools/list-files.ts)

两者继续保持只读和并发安全，但需要增加产物感知：

```text
read_file(path)
  -> ArtifactRegistry 中存在 running producer
  -> 返回 artifact_pending
```

而不是直接返回：

```text
ENOENT
```

建议输出：

```text
Artifact is still being generated.
task_id: qgis-task-123
path: E:/data/output.csv
status: running
```

如果不存在生产任务，则返回普通 `ENOENT`，避免掩盖真正的路径错误。

## 6. 调度策略

### 6.1 工具并发规则

基础规则：

```text
只读工具之间可以并发
写入工具默认独占
读取正在生成的产物必须等待生产任务
不同输出路径的独立生产任务后续再考虑并发
```

建议初期采用保守策略：

| 工具类型 | 第一阶段策略 |
| --- | --- |
| `read_file` | 只读并发，但遇到 pending artifact 时等待或返回 pending |
| `list_files` | 只读并发 |
| `list_qgis_algorithms` | 只读并发 |
| `describe_qgis_algorithm` | 只读并发 |
| `run_qgis_algorithm` | 独占执行 |
| `delegate` | 独占执行或保持当前策略 |

### 6.2 同一批工具调用的依赖

如果模型一次返回：

```text
run_qgis_algorithm(output.csv)
read_file(output.csv)
```

推荐的第一版行为：

1. 识别 `run_qgis_algorithm` 的预期输出；
2. 将该输出登记为 `pending`；
3. 读取工具发现路径属于 pending artifact；
4. 不执行真实读取；
5. 返回结构化的 `artifact_pending`；
6. 当前批次等待生产任务完成；
7. 下一轮模型根据任务结果决定是否读取。

更高级的行为是自动重排工具顺序，但第一阶段不建议直接重排模型工具调用，因为可能改变模型原本的语义顺序。

## 7. 前台、后台和自动后台化策略

### 7.1 第一阶段：前台等待

目标：

- 正确等待长 QGIS 任务；
- CLI 有进度反馈；
- 不会提前读取输出；
- 任务失败时有完整原因。

行为：

```text
run_qgis_algorithm
  -> running
  -> progress
  -> verifying_outputs
  -> completed/failed
  -> 下一轮模型
```

这是当前 MVP 最应该优先实现的版本。

### 7.2 第二阶段：显式后台任务

新增工具参数：

```json
{
  "runInBackground": true
}
```

新增辅助工具：

```text
get_task_status(task_id)
list_tasks()
cancel_task(task_id)
read_task_output(task_id)
```

后台任务完成时，至少要记录和通知：

- task id；
- QGIS 算法；
- 开始时间；
- 完成时间；
- exit code；
- stdout/stderr 摘要；
- 输出文件；
- 输出校验结果。

### 7.3 第三阶段：自动后台化

仅在以下条件满足后考虑：

- 任务状态已经稳定；
- CLI 可以显示后台任务；
- 模型能正确理解 `running`、`completed`、`failed`；
- 任务通知可以进入当前 Agent Loop；
- 有足够测试覆盖取消和重启。

## 8. 输出产物状态管理

### 8.1 Artifact Registry

建议维护：

```ts
interface ArtifactRecord {
  path: string;
  normalizedPath: string;
  producerTaskId: string;
  status: "pending" | "ready" | "missing" | "invalid";
  registeredAt: string;
  readyAt?: string;
  sizeBytes?: number;
  error?: string;
}
```

路径需要统一规范化：

- Windows 盘符大小写统一；
- `/` 和 `\` 统一；
- 相对路径转绝对路径；
- 去除多余引号；
- 必要时解析 QGIS 的 URI 参数。

### 8.2 输出验证

最低验证：

```text
exists(path)
```

推荐验证：

```text
exists(path)
stat(path)
size > 0
readable(path)
```

对于矢量和栅格数据，后续可以增加轻量验证：

- GeoPackage 能否打开；
- CSV 是否有表头；
- Shapefile 的 `.shp/.shx/.dbf` 是否成套；
- 栅格文件是否能被 GDAL 读取。

## 9. 日志和可观测性

当前已经有 `.internal/tool-execution.jsonl`，建议扩展事件类型：

```json
{
  "event": "tool_started",
  "taskId": "...",
  "tool": "run_qgis_algorithm",
  "status": "starting"
}
```

```json
{
  "event": "tool_progress",
  "taskId": "...",
  "status": "running",
  "elapsedMs": 120000,
  "stdoutTail": "...",
  "expectedOutputs": ["..."]
}
```

```json
{
  "event": "tool_outputs_verified",
  "taskId": "...",
  "status": "ready",
  "verifiedOutputs": ["..."],
  "missingOutputs": []
}
```

```json
{
  "event": "tool_finished",
  "taskId": "...",
  "ok": false,
  "status": "output_missing",
  "exitCode": 0,
  "durationMs": 600123,
  "error": "..."
}
```

日志要求：

1. 每个任务拥有稳定的 `taskId`；
2. `runId`、`turn`、`toolCallId` 全部保留；
3. 记录开始、进度、进程退出、输出验证、完成和失败；
4. stdout/stderr 使用尾部截断，避免日志无限增长；
5. 日志中记录预期输出和实际验证结果；
6. 不把完整大文件内容写入工具日志；
7. CLI 显示摘要，日志保留诊断细节。

## 10. 取消、超时和退出

### 10.1 两次 Ctrl+C

现有项目要求两次 Ctrl+C 退出，应保留该交互语义：

```text
第一次 Ctrl+C
  -> 取消当前模型流或当前前台工具
  -> 保留 CLI 进程和会话

第二次 Ctrl+C
  -> 终止剩余任务
  -> 关闭 Agent Loop
  -> 退出进程
```

QGIS 任务必须接入统一的 `AbortSignal` 或任务终止器，否则第一次 Ctrl+C 只能停止模型显示，无法停止实际的 `qgis_process` 子进程。

### 10.2 超时

超时后需要区分：

```text
进程被终止
  -> timed_out

进程已退出但输出缺失
  -> output_missing

进程退出码非零
  -> failed
```

不能把所有情况都压缩成普通的 `Tool error`。

## 11. 实施阶段

### Phase 0：基线和测试夹具

目标：在不改变行为的情况下，先建立可重复测试。

任务：

- 增加可控的模拟长任务工具；
- 增加模拟输出延迟工具；
- 增加进程退出但无输出文件的测试；
- 增加工具批次中 QGIS 后读取的测试；
- 固化当前工具日志格式。

验收：

- 能稳定复现提前读取；
- 能稳定复现进程成功但输出不存在；
- 每次测试都有完整 JSONL 日志。

### Phase 1：统一前台任务状态机

目标：完成最核心改造。

任务：

- 引入 `ToolTask`；
- 扩展 `AgentEvent` 的 progress 事件；
- `ToolRegistry` 支持任务上下文；
- QGIS 进程支持 stdout/stderr 进度；
- QGIS 进程退出后验证输出；
- `read_file` 感知 pending artifact；
- 保留当前前台等待语义。

验收：

- QGIS 执行 10 分钟时不会提前进入下一轮模型；
- CLI 可以显示运行阶段和耗时；
- 输出未生成时不会报告 completed；
- `read_file` 不会对 pending artifact 直接返回普通 ENOENT。

### Phase 2：后台任务

目标：支持不阻塞 Agent Loop 的长任务。

任务：

- 增加任务注册表；
- 增加 `runInBackground`；
- 增加 `get_task_status`；
- 增加任务完成通知；
- 增加 `cancel_task`；
- 增加进程重启和应用退出时的任务清理。

验收：

- 后台 QGIS 任务可以继续执行；
- Agent 可以处理其他非依赖工作；
- 依赖输出的 `read_file` 不会提前读取；
- 任务完成后状态可查询且日志完整。

### Phase 3：自动后台化和高级调度

目标：接近 Claude Code 的长任务体验。

任务：

- 增加前台阻塞预算；
- 自动将合适的长任务转后台；
- 支持不同输出路径的 QGIS 任务并发；
- 支持任务优先级；
- 支持任务恢复和会话重启后重新发现任务。

## 12. 测试矩阵

必须覆盖以下场景：

| 场景 | 预期结果 |
| --- | --- |
| QGIS 1 秒完成 | 前台直接返回 completed |
| QGIS 10 分钟完成 | 期间持续 progress，完成后进入下一轮 |
| QGIS exit 0 但无输出 | `output_missing`，不能报告成功 |
| QGIS exit 1 | `failed`，保留 stderr |
| 同批次 QGIS + read output | read 不得提前真实读取 |
| QGIS 输出路径错误 | 返回路径校验失败 |
| 输出文件正在生成 | 返回 `artifact_pending` |
| 输出文件被删除 | 返回 `output_missing` |
| 用户第一次 Ctrl+C | 取消当前任务但不退出进程 |
| 用户第二次 Ctrl+C | 终止任务并退出 |
| 后台 QGIS 完成 | 发送完成通知 |
| 后台 QGIS 失败 | 发送失败通知 |
| 多个只读工具 | 可以并发 |
| 两个写入型 QGIS 工具 | 默认串行 |
| 工具异常后模型无最终文本 | Harness 进入 finalization，不无限循环 |

## 13. 风险与取舍

### 13.1 不建议直接复制 Claude Code

Claude Code 的 Bash、任务、权限、后台通知和 UI 体系非常重，Geo-agent 不应直接照搬全部实现。

当前最合适的是借鉴其抽象：

```text
StreamingToolExecutor
  -> 工具任务状态
  -> 进度流
  -> 严格结果配对
  -> 取消和错误恢复
```

然后针对 QGIS 增加：

```text
Artifact Registry
  -> 输出路径登记
  -> 文件落盘验证
  -> read_file 依赖阻塞
```

### 13.2 不建议第一阶段自动后台化

自动后台化虽然能提升交互性，但会引入：

- 模型是否理解任务尚未完成；
- 如何处理依赖输出；
- 如何注入任务完成通知；
- 任务完成后是否需要重新触发模型；
- 用户退出时如何回收进程。

因此第一阶段优先保证前台执行的正确性。

### 13.3 不建议让 read_file 自己无限重试

无限重试会掩盖：

- QGIS 参数错误；
- 输出格式不支持；
- SQL 没有产生结果；
- 文件路径解析错误；
- 进程退出但产物缺失。

应由生产工具负责声明和验证产物，由 Harness 负责依赖状态，而不是由读取工具盲目轮询。

## 14. 最小可行版本

如果目标是尽快解决当前 QGIS 数据分析问题，建议只实现以下内容：

1. `run_qgis_algorithm` 改为可报告进度；
2. QGIS 进程结束后校验 `OUTPUT` 文件；
3. QGIS 输出缺失时返回结构化失败；
4. 增加 `pendingArtifacts`；
5. `read_file` 遇到 pending artifact 时返回明确状态；
6. QGIS 工具执行期间不允许依赖读取提前执行；
7. 工具日志记录 `process_exit` 和 `outputs_verified`；
8. 保留当前前台等待，不立即实现后台任务；
9. 增加长任务、输出缺失和 Ctrl+C 测试。

这个 MVP 修改范围预计集中在：

```text
src/agent/agent-loop.ts
src/tools/tool-registry.ts
src/tools/tool-execution-log.ts
src/tools/read-file.ts
src/qgis/qgis-process-client.ts
src/qgis/qgis-tools.ts
src/app/interactive-app.ts
```

## 15. 最终判断

将当前 Agent 改造成 Claude Code 风格的工具执行 Harness，**需要改动多个核心模块，但不需要推倒重写整个项目**。

改造的关键不是把 `await` 改成后台线程，而是建立以下契约：

```text
工具是否正在执行
工具是否真正完成
工具是否产生了声明的输出
输出是否可以被其他工具读取
工具是否可以被取消
工具结果是否已经安全地交给模型
```

对于 Geo-agent，最重要的领域扩展是：

```text
通用 Tool Task State Machine
  +
QGIS Artifact Lifecycle
```

建议实施优先级：

```text
前台任务状态机
  -> QGIS 输出验证
  -> read_file 依赖管理
  -> 进度和 CLI 展示
  -> 后台任务
  -> 自动后台化
```

完成前四项后，当前“QGIS 执行结果已返回但 read_file 找不到输出文件”的主要 Harness 风险就能得到控制；完成后台任务后，系统才真正具备 Claude Code 风格的长时间工具执行体验。
