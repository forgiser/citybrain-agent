# Geo-agent 上下文管理与工具执行 Harness 设计方案

## 1. 文档定位

本文档面向 Geo-agent 后续工程化改造，目标是将当前系统逐步升级为参考 Claude Code、Pi-agent 等成熟 Agent 的：

```text
上下文投影与压缩系统
+
工具任务状态机
```

本方案不追求复制 Claude Code 的全部实现，而是提取适合 Geo-agent 的核心思想，并结合 QGIS 空间分析场景增加：

- QGIS 输出产物生命周期管理；
- 算法执行与文件读取之间的依赖管理；
- 长时间空间分析任务的进度反馈；
- 工具结果的可追溯落盘；
- 面向空间数据分析的任务状态和失败恢复。

本文档中的“当前状态”以现有代码为准；“目标状态”和“实施计划”属于后续改造方案。

## 2. 总体结论

当前 Geo-agent 已经具备 Claude Code 风格 Harness 的部分基础，但还没有形成完整的上下文管理和工具执行体系。

当前系统可以概括为：

```text
System Prompt 分层骨架
  +
Session JSONL 历史记录
  +
简单的阈值式消息压缩
  +
AgentLoop 内置工具调度
  +
QGIS 工具的部分进度与产物状态
```

目标系统应升级为：

```text
Canonical Transcript
        ↓
Context Projection
        ↓
Compression Pipeline
        ↓
Prepared Model Context

AgentLoop
        ↓
StreamingToolExecutor
        ↓
Tool Task State Machine
        ↓
Artifact Lifecycle
```

最重要的两个抽象是：

```text
Context Projection
上下文投影层

Tool Task State Machine
工具任务状态机
```

## 3. 当前真实实现评估

### 3.1 已经具备的能力

当前项目已经存在以下基础：

1. `context-builder.ts` 已经按照静态内容、用户/项目内容和系统状态设计了上下文分块。
2. `context-assembly.ts` 已经存在静态 System Prompt 与动态 System Prompt 的边界标记。
3. `context-section.ts` 已经提供了缓存 section 和 volatile section 的概念。
4. `SessionManager` 使用 JSONL 保存会话消息、工具调用、工具结果和压缩记录。
5. `context-trace.jsonl` 可以记录发送给模型的消息内容和工具定义。
6. `context-usage.jsonl` 可以记录 provider usage 和估算 usage。
7. `AgentLoop` 已经具备工具轮次、最终化、重复工具批次和工具安全上限。
8. `ToolRegistry` 已经负责工具注册、参数解析、工具日志、进度事件和产物登记。
9. `ArtifactRegistry` 已经支持 pending、ready、missing、invalid 等产物状态。
10. `run_qgis_algorithm` 已经支持 QGIS 进程输出、进度和输出文件存在性校验。
11. `read_file` 已经可以等待 pending artifact 的生产任务结束。

### 3.2 当前上下文的实际形态

当前 AgentLoop 在每次用户请求开始时构造：

```ts
messages = [
  { role: "system", content: systemPrompt },
  ...sessionMessages,
  currentUserMessage,
]
```

随后模型请求、工具调用和工具结果继续追加到同一个 `messages` 数组。

在 Provider 序列化阶段，OpenAI、Anthropic 和 Gemini 会分别将 system message 转换成各自的 system prompt 结构。因此：

```text
Provider 请求层：部分实现了 System Prompt / messages 分离
Agent 内部上下文层：仍然将 System Prompt 放在 messages 数组中
```

### 3.3 当前动态 System Prompt 的缺口

当前代码虽然定义了：

```text
defaultSystemPrompt
userContext
systemContext
```

但 `buildSystemPromptForCwd()` 当前主要组合静态 sections 和动态 registry sections，实时状态内容还没有完整进入最终模型请求。

因此以下内容还没有形成稳定的 volatile System Prompt：

- 当前分析任务；
- 当前 QGIS 运行环境；
- 已完成的分析步骤；
- 正在生成的文件；
- 已失败的工具；
- 当前下一步；
- QGIS artifact 状态。

### 3.4 当前压缩的实际能力

当前压缩主要是：

```text
估算 system prompt + tools + messages token
  ↓
超过阈值
  ↓
保留最近消息
  ↓
将旧消息生成规则摘要
  ↓
写入 compaction entry
```

当前还没有真正实现以下 Claude Code 风格能力：

- 工具结果预算裁剪；
- 大结果持久化到磁盘；
- 旧工具结果的微压缩；
- 历史片段剪枝；
- 工具链上下文折叠；
- 面向当前任务的结构化全量摘要；
- 对 system prompt、tools、messages 的独立预算管理。

### 3.5 当前工具执行的实际形态

当前 AgentLoop 仍然包含：

- 工具批次扫描；
- 并发安全判断；
- 独占工具等待；
- 工具事件队列；
- 工具结果收集；
- 下一轮模型前的结果写入。

因此当前工具执行属于：

```text
ToolRegistry：执行和日志
AgentLoop：调度和生命周期
QGIS 工具：领域逻辑和进程执行
```

这属于半解耦状态，还没有形成独立的 `StreamingToolExecutor`。

### 3.6 当前模型上下文窗口和 Token 记录的缺口

当前已经为部分 DeepSeek V4 模型配置了 1M 上下文能力，但模型元数据、Provider 探测结果和 fallback 之间的优先级还需要进一步明确。

同时，当前 provider usage 中的：

```text
totalTokens
```

不一定等于当前 prompt 的上下文 token。后续必须区分：

```text
promptTokens
  = input + cacheRead + cacheWrite

completionTokens
  = output

requestTotalTokens
  = promptTokens + completionTokens
```

CLI 的上下文占用应优先显示：

```text
当前 prompt tokens / context window
```

而不是简单使用 request total tokens。

## 4. 目标上下文架构

### 4.1 三层 System Prompt

目标上下文应将 System Prompt 明确拆成三层。

#### Static System Prompt

整个会话长期稳定，尽可能保持字节级稳定：

- CityBrain 身份；
- 城市数据分析使命；
- 工作纪律；
- 工具使用规则；
- 安全约束；
- 输出风格；
- QGIS 处理原则。

这部分适合成为 Provider Prompt Cache 的稳定前缀。

#### Dynamic System Prompt

每次模型请求前重新计算，但不一定每轮变化：

- 项目指令；
- `CLAUDE.md` 或 `PROJECT.md`；
- `MEMORY.md` 索引；
- `SKILLS_index.md` 索引；
- 当前工作目录；
- 当前日期；
- QGIS runtime 摘要。

#### Volatile System Prompt

随着任务和工具执行状态变化：

- 当前分析目标；
- 当前任务阶段；
- 已完成的分析步骤；
- 已生成的文件；
- 正在执行的任务；
- 失败工具及原因；
- 当前可读 artifact；
- 建议的下一步。

建议结构：

```text
## Current Analysis State

Goal:
...

Completed steps:
...

Running tasks:
...

Artifacts:
...

Failed attempts:
...

Next expected action:
...
```

### 4.2 Canonical Transcript 与 Model Projection

Session 中保存完整的 Canonical Transcript：

```text
用户消息
assistant 消息
thinking
tool call
tool result
usage
压缩记录
```

但模型请求不直接使用完整历史，而是每次生成一个上下文投影：

```text
Canonical Transcript
        ↓
Message Projection
        ↓
Tool Result Budgeting
        ↓
Compression Pipeline
        ↓
Messages Sent To Model
```

这样可以实现：

- 审计日志保留完整历史；
- 模型只接收当前任务需要的内容；
- 压缩不会破坏原始会话；
- 可以重新生成不同模型或不同预算下的上下文；
- 失败后可以回放原始工具结果。

### 4.3 目标模型请求结构

建议将模型调用前的上下文封装为：

```ts
interface PreparedModelContext {
  systemPrompt: {
    staticText: string;
    dynamicText: string;
    volatileText: string;
    tokenEstimate: number;
  };
  messages: ChatMessage[];
  tools: ChatToolDefinition[];
  usage: {
    systemTokens: number;
    toolTokens: number;
    messageTokens: number;
    promptTokens: number;
    contextWindow: number;
    availableTokens: number;
  };
  compression: CompressionReport;
}
```

`messages` 不再承担 System Prompt 的存储职责，Provider 层根据 `systemPrompt` 和 `messages` 分别序列化。

## 5. 上下文准备与压缩流水线

每次模型请求前按以下顺序准备上下文：

```text
1. 读取 Canonical Transcript
2. 重新构建 Dynamic System Prompt
3. 重新构建 Volatile System Prompt
4. 生成工具定义和工具预算
5. 工具结果预算裁剪
6. 大结果持久化
7. 历史片段剪枝
8. 微压缩
9. 工具链上下文折叠
10. 全量摘要压缩
11. 计算最终 prompt tokens
12. 发送模型请求
```

压缩必须遵循“由轻到重”的顺序。只有前一层仍然无法满足预算时，才进入下一层。

### 5.1 工具结果预算裁剪

建议按工具类型配置 inline 预算：

| 工具 | 默认 inline 预算 |
| --- | ---: |
| `read_file` | 12,000 tokens |
| `list_files` | 4,000 tokens |
| `list_qgis_algorithms` | 8,000 tokens |
| `describe_qgis_algorithm` | 12,000 tokens |
| `run_qgis_algorithm` | 8,000 tokens |
| `delegate` | 8,000 tokens |

预算策略：

```text
优先保留结果头部、状态、错误、输出路径
其次保留结果尾部
中间大段内容裁剪
完整结果落盘
```

### 5.2 大结果持久化

完整工具结果写入：

```text
<workspace>/.internal/tool-results/<taskId>.txt
```

模型上下文只保留：

```text
Tool result exceeded inline budget.

Status:
completed

Preview:
...

Full result:
E:/.../.internal/tool-results/<taskId>.txt

Use read_file with offset and limit to inspect the full result.
```

工具结果存储至少记录：

```ts
interface ToolResultArtifact {
  taskId: string;
  toolName: string;
  path: string;
  sizeBytes: number;
  preview: string;
  createdAt: string;
}
```

### 5.3 历史片段剪枝

优先剪枝：

- 重复的 `list_files` 结果；
- 重复的 QGIS 算法列表；
- 已被后续读取结果覆盖的旧文件片段；
- 已经完成且与当前目标无关的普通成功结果；
- 重复的失败调用；
- 已经被 artifact 状态替代的原始进度消息。

必须保留：

- 用户原始目标；
- 用户明确约束；
- 关键 QGIS 参数；
- 关键失败原因；
- 输出文件路径；
- 当前任务状态；
- 最近若干轮工具调用和结果。

### 5.4 微压缩

微压缩不调用模型，只对旧工具结果进行确定性替换：

```text
run_qgis_algorithm:
  status: completed
  algorithm: gdal:buffer
  input: ...
  output: ...
  duration: 23s
```

或者：

```text
read_file:
  status: completed
  path: ...
  lines: 1-100
  full_result: ...
```

注意：压缩时必须保留合法的 assistant tool call 与 tool result 配对。

### 5.5 上下文折叠

将已经完成的一组空间分析工具链折叠为一个分析步骤：

```text
## Processing Step 2

Algorithm:
gdal:executesql

Input:
E:/data/BJ_education_osm/data.shp

Output:
E:/data/name_check.csv

Status:
failed

Reason:
qgis_process returned exit code 0, but the declared output file was not created.
```

折叠对象可以包括：

- `list_qgis_algorithms`；
- `describe_qgis_algorithm`；
- `run_qgis_algorithm`；
- `list_files`；
- `read_file`；
- 与同一输出 artifact 相关的重试。

### 5.6 全量摘要压缩

全量摘要是最后手段，用于仍然无法满足上下文预算的情况。

摘要结构固定为：

```text
## User Goal
## Confirmed Facts
## Files and Layers
## Completed Processing
## Failed Attempts
## Important Parameters
## Current Artifacts
## Current Constraints
## Next Action
```

当前已增加独立的摘要模型调用，但摘要模型必须：

- 不调用业务工具；
- 不改变原始 Session；
- 将摘要作为本次 request projection 的 working memory；
- 失败时回退规则摘要；
- 记录摘要前后 token 数。

## 6. 工具执行 Harness 目标架构

### 6.1 AgentLoop 的职责

AgentLoop 只负责：

```text
接收用户消息
  -> 准备模型上下文
  -> 请求模型
  -> 收集 tool calls
  -> 交给 StreamingToolExecutor
  -> 消费工具事件
  -> 将最终 tool results 写回 Canonical Transcript
  -> 开始下一次模型请求
```

AgentLoop 不再直接负责：

- 工具并发调度；
- 任务队列；
- 子进程状态；
- artifact 注册；
- 工具进度日志；
- 工具取消细节。

### 6.2 StreamingToolExecutor 的职责

建议新增：

```text
src/tools/streaming-tool-executor.ts
```

它负责：

- 工具调用排队；
- 工具启动；
- 并发安全判断；
- 独占工具调度；
- 工具进度转发；
- 工具完成结果；
- 工具错误；
- 工具取消；
- 工具结果与 tool call 配对；
- 批次预扫描；
- artifact 依赖等待。

### 6.3 工具任务状态

建议统一使用：

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
output_pending
output_missing
output_invalid
```

建议任务接口：

```ts
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
  expectedArtifacts: ArtifactRef[];
  verifiedArtifacts: ArtifactRef[];
  missingArtifacts: ArtifactRef[];
  result?: ToolResultEnvelope;
  error?: string;
}
```

### 6.4 工具结果 Envelope

工具不应只返回一个字符串，建议统一包装为：

```ts
interface ToolResultEnvelope {
  taskId: string;
  toolName: string;
  ok: boolean;
  status: "completed" | "failed";
  summary: string;
  inlineContent?: string;
  fullResultPath?: string;
  artifacts?: ArtifactRecord[];
  durationMs: number;
  stdoutTail?: string;
  stderrTail?: string;
}
```

ContextManager 再根据上下文预算决定将 `inlineContent` 全量放入模型，还是只放 preview 和 `fullResultPath`。

## 7. QGIS 专属产物生命周期

### 7.1 产物状态

QGIS 任务不能只使用进程退出码判断成功，必须区分：

```text
process_started
process_running
process_exited
outputs_pending
outputs_ready
completed
```

失败状态：

```text
process_failed
timed_out
cancelled
output_missing
output_invalid
```

必须明确：

```text
exitCode = 0
  !=
output file exists
  !=
output file is readable
  !=
output data is valid
```

### 7.2 批次预扫描

在执行一批 tool calls 之前，先扫描所有调用：

```text
收集 run_qgis_algorithm 的 OUTPUT
  -> 统一规范化路径
  -> 注册 pending artifact
  -> 建立 producer task
  -> 再启动工具
```

这样可以处理两种顺序：

```text
run_qgis_algorithm
read_file
```

以及：

```text
read_file
run_qgis_algorithm
```

`read_file` 发现目标属于 pending artifact 时，必须等待生产任务进入终态，而不能直接发起文件读取。

### 7.3 QGIS 输出验证

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

后续可以增加数据格式验证：

- GeoPackage 是否能够打开；
- CSV 是否有表头；
- Shapefile 的 `.shp/.shx/.dbf` 是否成套；
- Raster 是否可以通过 GDAL 读取；
- 输出 CRS 是否存在；
- 要素数量是否符合预期。

## 8. 日志与可观测性

### 8.1 工具日志

当前 `.internal/tool-execution.jsonl` 应继续作为工具主日志，并扩展以下事件：

```json
{
  "phase": "start",
  "taskId": "...",
  "runId": "...",
  "turn": 2,
  "tool": "run_qgis_algorithm"
}
```

```json
{
  "phase": "progress",
  "taskId": "...",
  "status": "running",
  "elapsedMs": 120000,
  "stdoutTail": "...",
  "stderrTail": "..."
}
```

```json
{
  "phase": "artifact",
  "taskId": "...",
  "status": "pending",
  "artifactPaths": ["E:/data/output.gpkg"]
}
```

```json
{
  "phase": "artifact",
  "taskId": "...",
  "status": "ready",
  "artifactPaths": ["E:/data/output.gpkg"]
}
```

```json
{
  "phase": "finish",
  "taskId": "...",
  "ok": false,
  "status": "output_missing",
  "durationMs": 600123,
  "error": "..."
}
```

### 8.2 上下文日志

`context-trace.jsonl` 应记录每次模型请求的：

```text
static system prompt token
dynamic system prompt token
volatile system prompt token
tool definition token
message token
prompt token
completion token
context window
available token
compression stages
```

每个消息还应记录：

- 原始字符数；
- 发送字符数；
- 原始估算 token；
- 发送估算 token；
- 是否被裁剪；
- 是否落盘；
- 对应结果文件路径。

### 8.3 CLI 显示

CLI 只显示摘要：

```text
run_qgis_algorithm running  124s
  algorithm: gdal:executesql
  output verification pending
```

完整 stdout/stderr 放到日志和结果文件中，避免 CLI 和模型上下文同时被大输出占满。

## 9. 上下文窗口与 Token 口径

### 9.1 Context Window 来源优先级

建议固定为：

```text
用户显式配置
  >
可信模型能力目录
  >
Provider 模型元数据
  >
128k fallback
```

对于 DeepSeek V4，应明确使用 1M 上下文配置，不能因为 Provider 返回一个较小的默认值而覆盖可信目录。

### 9.2 Token 统计口径

必须分开记录：

```text
systemTokens
toolDefinitionTokens
messageTokens
promptTokens
completionTokens
cacheReadTokens
cacheWriteTokens
requestTotalTokens
```

其中 CLI 的 context percent 使用：

```text
promptTokens / contextWindow
```

累计费用或会话消耗使用：

```text
requestTotalTokens
```

## 10. 分阶段实施计划

### Phase A：完成 System Prompt / messages 真正分离

目标：

- Agent 内部不再将 System Prompt 作为普通消息管理；
- 每次模型请求前重新构建动态和 volatile System Prompt；
- 将 QGIS runtime、当前分析任务和 artifact 状态注入动态上下文；
- 修正 prompt token 与 total token 的口径；
- 修正上下文窗口的来源优先级。

当前实现进度：

- 已完成 AgentLoop 内部的 `conversationMessages` / `requestMessages` 分离；
- 已完成每次模型请求前刷新 project instruction、memory、skills、当前任务、QGIS runtime、工作目录和日期；
- 已完成 static / dynamic / volatile 边界标记，并在 `context-trace.jsonl` 记录三段文本及估算 token；
- 已完成 provider prompt token、completion token、request total token 的分开记录；
- 已完成 DeepSeek V4 可信 1M context window 覆盖较小 provider 元数据；
- 已完成将当前 QGIS/tool artifact 的 `pending/ready/missing/invalid` 状态摘要注入 volatile context；
- 工具结果预算与投影式结果落盘已在 Phase B 实现；
  - 独立 `StreamingToolExecutor` 已在 Phase D 实现，AgentLoop 不再直接维护工具并发集合。

主要文件：

```text
src/agent/agent-loop.ts
src/context/context-builder.ts
src/context/context-assembly.ts
src/context/context-types.ts
src/context/context-usage.ts
src/models/model-chat.ts
src/models/model-catalog.ts
src/session/session-manager.ts
```

验收标准：

- `messages` 中不再包含 system message；
- 每次模型请求前都能看到最新 volatile context；
- trace 日志能区分三类 System Prompt；
- DeepSeek V4 的 context window 显示为 1M；
- CLI 显示的 context percent 基于 prompt tokens。

### Phase B：工具结果预算与大结果落盘

目标：

- 每个工具拥有独立结果预算；
- 大结果落盘；
- 模型只接收 preview；
- 支持通过 `read_file` 分段读取完整结果。

当前实现进度：

- 已新增 `src/context/context-projection.ts`，作为模型请求前的独立 Context Projector；
- 已新增 `src/context/tool-result-store.ts`，将超预算工具结果保存到 `<workspace>/.internal/tool-results`；
  - 已实现按工具类型的条件式 inline budget；
  - 未超预算的工具结果原样进入请求；
  - 超预算的工具结果只在本次 projected context 中替换为预览和可恢复文件路径；
  - Session JSONL 和 AgentLoop 的 canonical conversation 仍然保存完整工具结果；
  - 以 `toolCallId` 为稳定键冻结投影决定，同一工具结果后续请求不会反复落盘或在预算变化时来回切换；
  - 投影决定以 `context_replacement` 条目写入 Session JSONL，恢复会话后可以重建投影状态；
  - 对连续工具结果批次增加聚合预算，避免多个单独未超限的结果叠加后撑大 request messages；
  - `context-trace.jsonl` 记录 projection 前后 token、字符数、处理阶段和落盘文件；
  - 本阶段暂不实现 microcompact、context collapse 和 LLM 全量摘要；这些能力在 Phase C 的请求级压缩流水线中实现。

主要文件：

```text
src/context/context-projection.ts
src/context/tool-result-store.ts
```

验收标准：

  - 大型 `list_files` 不会完整塞入 messages；
  - 超预算工具结果可以通过 `read_file` 读取完整落盘文件；
  - `context-trace.jsonl` 能看到原始大小、投影大小和落盘路径；
  - Session 保留完整结果，模型请求只使用投影后的引用；
  - 同一个 `toolCallId` 在多轮请求和恢复会话后都复用同一投影结果。

### Phase C：消息投影与多层压缩

目标：

- 加入历史片段剪枝；
- 加入微压缩；
- 加入 QGIS 工具链折叠；
- 扩展全量摘要结构；
- 保持原始 Canonical Transcript 不变。

当前实现进度：

- 已新增 `src/context/context-compression.ts`，作为工具结果投影之后、模型请求之前的请求级压缩流水线；
- 已实现历史片段剪枝：超过阈值时按用户消息边界保留近期上下文，并插入可追踪的历史摘要；
- 已实现 microcompact：压缩较早的工具结果，只保留工具身份、调用 ID 和短预览，完整内容仍留在 canonical session 或 tool-result artifact；
- 已实现 context collapse：轻量压缩后仍超预算时折叠更早的消息片段；
- 已实现 LLM 摘要压缩：仅在前面阶段仍无法满足目标预算时，使用无工具的摘要请求生成结构化工作记忆；摘要请求失败时自动使用确定性摘要兜底；
- 所有压缩只作用于本次 request messages，原始 Session JSONL 和 canonical conversation 不被改写；
- 每个阶段记录 `applied/changed/tokensBefore/tokensAfter/removedMessages`，并写入 `context-trace.jsonl`；
- 历史剪枝和折叠只在用户消息边界执行，保证 assistant tool call 与 tool result 不被拆开；
- 压缩目标预算会扣除 System Prompt、工具定义和保留缓冲，避免只按 messages 估算造成请求超限。

主要文件：

```text
src/context/context-compression.ts
src/context/context-projection.ts
src/context/tool-result-store.ts
```

验收标准：

- 压缩顺序可观察；
- 每个阶段记录压缩前后 token；
- tool call/tool result 始终成对；
- 重要用户目标、参数、失败和 artifact 不会被剪掉；
- 普通旧工具结果可以被压缩成结构化状态；
- 摘要请求不会携带工具定义，不会在压缩过程中再次进入工具循环。

### Phase D：独立 StreamingToolExecutor

目标：

- 从 AgentLoop 移出工具调度逻辑；
- 建立工具任务执行队列；
- 统一处理进度、AbortSignal 和错误；
- 保证工具结果和 tool call 严格配对；
- 并发安全工具可以并行，独占工具会等待当前批次完成后再运行；
- 工具事件以 started/progress/result 生命周期实时回传 CLI。

当前实现进度：

```text
src/tools/streaming-tool-executor.ts
```

验收标准：

- AgentLoop 不再直接维护工具并发集合；
- 工具执行队列和事件流由 `StreamingToolExecutor` 独立维护；
- 工具进度不进入模型 messages；
- 工具的 `AbortSignal` 能传递到具体 handler；
- 工具失败时能够返回合法的失败 tool result；
- CLI 按 thinking、工具执行和后续 assistant 响应的真实顺序渲染。

### Phase E：依赖图和高级任务调度

目标：

- 批次预扫描；
- producer/consumer 依赖图；
- QGIS artifact 状态驱动；
- 显式后台任务；
- 后续自动后台化。

验收标准：

- 无论模型工具调用顺序如何，读取不会早于生产；
- 不同独立输出可以按策略并发；
- 长任务可以转后台；
- 任务完成后可以通知模型；
- 用户退出时不会遗留失控的 QGIS 进程。

## 11. 当前阶段建议

当前不建议立即实现 Claude Code 的全部高级功能。推荐执行顺序：

```text
Phase A：先修正上下文分层
  ↓
Phase B：工具结果预算与落盘
  ↓
Phase C：多层消息压缩
  ↓
Phase D：独立 StreamingToolExecutor
  ↓
Phase E：依赖图、后台任务和自动后台化
```

原因：

1. 如果 System Prompt 和 messages 尚未真正分离，后续压缩边界会不清晰。
2. 如果工具结果没有先完成预算和落盘，单纯做摘要会丢失可追溯性。
3. 如果没有统一的工具任务模型，后台执行和依赖调度会继续堆积到 AgentLoop。
4. QGIS 场景最重要的是先保证产物状态正确，再考虑高级并发。

## 12. 非目标与工程取舍

### 12.1 不直接复制 Claude Code

不直接复制 Claude Code 的全部实现，包括：

- 完整权限系统；
- 多级后台任务 UI；
- 复杂的模型 fallback；
- 远程 Agent 协作；
- 所有上下文 feature gate；
- 与 Claude 专用 API 强绑定的消息结构。

Geo-agent 只吸收适合自身的核心抽象：

```text
分层 System Prompt
Canonical Transcript
Context Projection
分阶段压缩
Streaming Tool Executor
严格的 Tool Result 配对
```

### 12.2 不让 read_file 无限重试

`read_file` 不负责解决生产任务失败问题。

正确关系是：

```text
生产工具声明 artifact
  ↓
Harness 跟踪 artifact 状态
  ↓
read_file 等待或读取
  ↓
生产失败时返回明确原因
```

不能通过无限 `ENOENT` 重试掩盖：

- QGIS 参数错误；
- 输出路径错误；
- SQL 没有产生结果；
- 输出格式不支持；
- qgis_process exit 0 但未生成文件。

### 12.3 不将进度写入模型上下文

进度事件用于：

- CLI；
- tool-execution.jsonl；
- 当前任务状态。

进度不应每秒追加为一条 message，否则会快速污染上下文。

## 13. 最小落地版本

如果需要控制改造范围，建议先实现以下最小闭环：

```text
1. Agent 内部独立保存 systemPrompt 和 messages
2. 每次模型请求前重新构建 volatile system context
3. 正确区分 promptTokens 和 requestTotalTokens
4. 工具结果按工具类型裁剪
5. 大工具结果写入 .internal/tool-results
6. messages 只保留 preview 和结果路径
7. 旧 QGIS 工具链折叠为结构化步骤
8. 批次预扫描 QGIS OUTPUT
9. 独立 StreamingToolExecutor
10. 完整记录 context trace 和 tool lifecycle
```

完成这十项后，系统就具备适用于城市空间分析的 Claude Code 风格 Harness 基础：

```text
完整历史可追溯
上下文可压缩
工具结果可恢复
QGIS 产物可验证
长任务可观察
AgentLoop 与工具执行解耦
```

## 14. 最终架构图

```text
                         ┌──────────────────────┐
                         │      AgentLoop       │
                         │  model request loop  │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │  ContextManager      │
                         │ system + projection  │
                         └──────┬───────┬───────┘
                                │       │
                   ┌────────────┘       └─────────────┐
                   ▼                                  ▼
          ┌────────────────┐                 ┌────────────────┐
          │ System Prompt  │                 │ Canonical      │
          │ static/dynamic │                 │ Transcript     │
          │ /volatile      │                 │ session JSONL  │
          └────────────────┘                 └───────┬────────┘
                                                     │
                                                     ▼
                                           ┌────────────────────┐
                                           │ Compression        │
                                           │ budget/project/    │
                                           │ micro/collapse/    │
                                           │ summary            │
                                           └────────────────────┘

                         ┌──────────────────────┐
                         │ StreamingToolExecutor│
                         │ queue/progress/error │
                         └──────────┬───────────┘
                                    │
                 ┌──────────────────┼──────────────────┐
                 ▼                  ▼                  ▼
          ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
          │ Tool Registry│  │ Task Registry│  │ Artifact      │
          │ handlers     │  │ lifecycle    │  │ Registry      │
          └──────────────┘  └──────────────┘  └──────┬───────┘
                                                     │
                                                     ▼
                                            ┌─────────────────┐
                                            │ QGIS Outputs    │
                                            │ pending/ready/  │
                                            │ missing/invalid │
                                            └─────────────────┘
```

## 15. 结论

Geo-agent 当前并不是完全没有参考 Claude Code，而是已经具备了部分结构化设计，但真实运行机制仍然更接近：

```text
单一 System Prompt
  +
原始 messages
  +
简单规则压缩
  +
AgentLoop 内置工具调度
```

后续应逐步演进为：

```text
稳定的 Static System Prompt
  +
每轮重建的 Dynamic/Volatile System Prompt
  +
完整 Canonical Transcript
  +
按需生成的 Context Projection
  +
分阶段 Compression Pipeline
  +
独立 StreamingToolExecutor
  +
QGIS Artifact Lifecycle
```

该方案能够同时满足：

- Claude Code 风格的上下文管理；
- Pi-agent 风格的轻量、透明和可观测；
- QGIS 空间分析的长任务执行；
- 工具结果和空间数据产物的可追溯性；
- 后续自进化 Agent 的知识积累和任务复盘。
