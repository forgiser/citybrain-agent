# CityBrain 核心工具契约与生命周期设计

## 1. 文档目的

当前 CityBrain 的工具定义较为简洁，主要由以下部分组成：

```text
ChatToolDefinition
  -> ToolRegistry.register()
  -> ToolHandler
  -> StreamingToolExecutor
```

这种结构可以快速完成 MVP，但工具定义和工具执行之间的职责边界比较粗：

- 工具的模型描述和运行时行为分散在不同位置；
- 参数校验主要依赖 handler 内部实现；
- sandbox、权限、并发、产物、结果大小和 CLI 展示没有形成统一契约；
- 工具执行前后的生命周期状态不够完整；
- 不同工具难以表达“只读工具”“高风险工具”“不可中断工具”等属性。

本文参考 `E:\Claude\Claude-Code2-main\src\Tool.ts`、
`src\services\tools\toolExecution.ts` 和
`src\services\tools\StreamingToolExecutor.ts`，为 CityBrain 设计一套适合
当前 QGIS 城市数据分析场景的核心工具契约。

目标不是复制 Claude Code 的全部实现，而是逐步引入其中真正有价值的工具
抽象，使工具能够被 Harness 统一调度、校验、授权、执行、记录和展示。

## 2. Claude Code 工具对象的职责

Claude Code 的核心 `Tool` 类型承担了很多职责。可以按以下八个维度理解。

### 2.1 工具身份与发现

用于回答“这是什么工具、模型如何找到它”：

```text
name
aliases
description
searchHint
isEnabled
shouldDefer
alwaysLoad
isMcp
isLsp
mcpInfo
```

主要作用：

- 工具主名称；
- 旧名称兼容；
- 供模型理解工具用途的描述；
- ToolSearch 或延迟加载时使用的搜索提示；
- 判断工具当前是否可用；
- 控制工具是否在首轮完整注入模型上下文；
- 标识 MCP/LSP 等外部工具来源。

### 2.2 输入和输出契约

用于回答“工具接受什么参数、返回什么结果”：

```text
inputSchema
inputJSONSchema
outputSchema
strict
mapToolResultToToolResultBlockParam
maxResultSizeChars
```

主要作用：

- 约束模型生成的输入；
- 让运行时在执行前发现参数类型错误；
- 支持不同模型供应商的 schema 表达；
- 将内部结果映射为模型可理解的 tool result；
- 限制过大的工具结果进入上下文；
- 为结构化结果保留可验证的数据结构。

### 2.3 输入校验与预处理

Claude Code 把“schema 合法”和“业务上可执行”分成了不同层次：

```text
inputSchema.safeParse()
validateInput()
backfillObservableInput()
getPath()
```

其中：

- Schema 校验检查字段类型、必填字段和基本结构；
- `validateInput()` 检查当前上下文下参数是否可以执行；
- `backfillObservableInput()` 补充路径、别名或派生字段；
- `getPath()` 为文件类工具提供统一路径识别能力。

例如：

```text
参数类型正确：
  DISTANCE = 10

业务校验仍可能失败：
  INPUT 不存在
  INPUT 不在授权读取目录
  OUTPUT 位于 sandbox 外部
  FIELD_NAME 不存在
  QGIS 算法当前不可用
```

### 2.4 权限与安全

Claude Code 将权限相关职责作为工具契约的一部分：

```text
checkPermissions
preparePermissionMatcher
isReadOnly
isDestructive
requiresUserInteraction
toAutoClassifierInput
```

这些能力可以回答：

- 当前工具是否只读；
- 是否会覆盖、删除或发送不可逆操作；
- 是否必须请求用户确认；
- 是否可以由规则自动放行；
- 是否需要安全分类器进一步判断；
- 工具参数是否匹配某条权限规则。

CityBrain 当前的 sandbox 本质上属于权限体系的一部分，但它解决的是其中
最底层、最硬的一类问题：**文件系统路径边界**。因此不能把 sandbox 和一般
的“是否允许执行”混成一个布尔值，而应该采用分层模型：

```text
Permission System
├─ SandboxPolicy
│  ├─ sandboxRoot
│  ├─ authorizedReadRoots
│  ├─ resolveReadPath()
│  ├─ resolveWritePath()
│  ├─ symlink / traversal 检查
│  └─ 文件读写边界
├─ ToolPolicy
│  ├─ isReadOnly
│  ├─ isDestructive
│  ├─ isConcurrencySafe
│  └─ interruptBehavior
├─ ProjectRules
│  ├─ AGENTS.md
│  ├─ workspace.json
│  └─ 当前任务约束
├─ UserApproval
└─ PreToolUse Hooks
```

其中：

```text
Sandbox   = 工具允许触碰哪些路径
Permission = 当前工具动作是否允许执行
```

Sandbox 是权限判断的必要前置条件，也是不可被普通 Hook 放宽的硬边界。
例如，工具即使被用户确认、项目规则允许，仍然不能通过修改参数访问
sandbox 外部的未授权文件。相反，路径位于 sandbox 内也不代表动作一定
可以执行，因为仍然需要判断工具是否具有写入、删除、覆盖、执行外部进程
等能力。

因此，后续不应让每个 handler 自己零散调用 sandbox，而应由 Harness 统一
执行：

```text
Tool Call
  -> Input Validation
  -> PreToolUse Hooks
  -> PermissionCoordinator
      -> SandboxPolicy
      -> ToolPolicy
      -> ProjectRules
      -> UserApproval
  -> Tool Execution
```

### 2.5 PreToolUse、PostToolUse 与失败 Hook

参考 Claude Code 的工具生命周期，CityBrain 需要把工具执行前后的扩展点
纳入核心契约。它们不是简单的日志回调，而是 Harness 生命周期中的正式
控制点：

```text
PreToolUse
  执行前校验、补充上下文、规范化输入、阻止执行

PostToolUse
  成功后验证输出、登记产物、更新 profile 状态、追加上下文

PostToolUseFailure
  失败后记录错误、保留诊断信息、标记产物状态、决定是否允许恢复
```

三类 Hook 的边界：

- `PreToolUse` 可以拒绝执行或修改规范化后的输入，但不能绕过
  `SandboxPolicy`；
- `PostToolUse` 只能处理已经完成的执行结果，不能把失败结果伪装成成功；
- `PostToolUseFailure` 负责失败后的恢复和记录，不应自动重试具有副作用
  的工具；
- Hook 的输出必须进入执行日志，保证权限决策、输入变更和失败原因可追溯；
- Hook 失败时，Harness 应采用保守策略：执行前 Hook 失败则拒绝执行，
  执行后 Hook 失败则将结果标记为需要复核。

### 2.6 执行与上下文修改

Claude Code 的核心执行接口大致包含：

```text
call(args, context, canUseTool, parentMessage, onProgress)
```

工具可以：

- 执行实际工作；
- 通过 `onProgress` 发出实时进度；
- 返回结构化结果；
- 返回新的上下文消息；
- 返回 context modifier，修改后续 Agent 状态；
- 在执行过程中响应 AbortSignal。

CityBrain 当前对应的是：

```text
ToolHandler(args, ToolCallContext)
```

后续需要将工具执行上下文扩展为稳定的 Harness Runtime Context。

### 2.7 并发、暂停和中断

Claude Code 的工具对象明确表达：

```text
isConcurrencySafe
interruptBehavior
```

其中：

- 只读、互不依赖的工具可以并发；
- 写文件、QGIS 输出、状态修改等工具默认独占；
- 用户输入新消息时，部分工具可以取消；
- 部分工具必须继续运行，新消息等待其结束；
- 某个工具失败后，可以根据工具类型取消同批次的兄弟工具。

CityBrain 当前已经有 `isConcurrencySafe` 和
`StreamingToolExecutor`，但工具定义还没有正式表达中断策略。

### 2.8 用户界面与可观测性

Claude Code 的工具对象包含大量展示方法：

```text
userFacingName
userFacingNameBackgroundColor
getToolUseSummary
getActivityDescription
renderToolUseMessage
renderToolUseProgressMessage
renderToolResultMessage
renderToolUseQueuedMessage
renderToolUseRejectedMessage
renderToolUseErrorMessage
renderGroupedToolUse
renderToolUseTag
isResultTruncated
extractSearchText
```

这些方法解决了一个关键问题：

> 工具的模型结果、日志结果和用户界面结果不应该被视为同一种文本。

例如：

```text
模型看到：
  文件读取成功，返回了 120 行内容

CLI 看到：
  read E:\workspace1\data\roads.geojson
  120 lines · 4.2 KB

日志保存：
  完整路径、耗时、字节数、hash、sandbox 判断、结果状态
```

CityBrain 当前主要由 `interactive-app.ts` 根据工具名称统一拼接文本，
后续可以逐步将工具的展示摘要能力移到工具契约中。

### 2.9 工具结果与生命周期

Claude Code 会将工具结果进一步处理：

```text
工具原始结果
  -> 结果映射
  -> 大小限制
  -> 必要时持久化
  -> 生成模型 tool_result
  -> 生成 CLI 展示
  -> 写入日志和遥测
```

CityBrain 当前已经有：

- `ArtifactRegistry`；
- 工具结果日志；
- 上下文投影；
- 大结果持久化；
- `pending/ready/missing/invalid` 状态。

但这些能力还没有完全进入工具定义层。

## 3. Claude Code 工具定义与 CityBrain 当前结构对照

| Claude Code 能力 | CityBrain 当前实现 | 当前问题 |
|---|---|---|
| `name` | `ChatToolDefinition.function.name` | 已具备 |
| `description` | `ChatToolDefinition.function.description` | 已具备 |
| `inputSchema` | `function.parameters` | 只有 JSON Schema，缺少统一运行时校验接口 |
| `call()` | `ToolHandler` | 已具备，但执行上下文较薄 |
| `onProgress()` | `emitProgress` | 已具备 |
| `isConcurrencySafe()` | 注册选项 | 已具备，但未成为完整工具元数据 |
| `validateInput()` | handler 内部抛错 | 缺少执行前独立校验阶段 |
| `checkPermissions()` | SandboxPolicy 部分承担 | 缺少统一 `PermissionCoordinator` 决策模型 |
| `isReadOnly()` | 未统一定义 | 只能通过注册时约定 |
| `isDestructive()` | 未统一定义 | 无法统一表达风险 |
| `interruptBehavior()` | 只有 AbortSignal | 缺少工具级 cancel/block 策略 |
| `getPath()` | 各工具自行解析路径 | 缺少统一路径提取 |
| `maxResultSizeChars` | 上下文层处理 | 工具自身无法声明结果策略 |
| `mapToolResult()` | handler 直接返回字符串 | 结构化结果能力较弱 |
| `getActivityDescription()` | CLI 根据工具名推断 | 描述不够准确 |
| `getToolUseSummary()` | CLI 根据 argumentsText 截取 | 缺少工具级摘要 |
| `renderToolUseMessage()` | `interactive-app.ts` 统一渲染 | 工具无法提供专属展示 |
| `renderToolResultMessage()` | 统一结果 Box | 无法按工具类型优化结果 |
| `PreToolUse Hook` | 未实现统一 Hook | 缺少工具前置生命周期和阻断/改参能力 |
| `PostToolUse Hook` | 主要由 Registry 收尾 | 缺少成功后产物校验和状态更新契约 |
| `PostToolUseFailure Hook` | 主要依赖异常处理 | 缺少失败诊断、恢复和重试边界 |
| `outputSchema` | 未统一定义 | 无法验证结构化结果 |
| `contextModifier` | Artifact 和上下文外部维护 | 后续需要正式纳入结果契约 |
| `aliases` | 未实现 | 可后续添加 |
| `shouldDefer` | 未实现 | QGIS 算法不建议首期引入 |
| `MCP/LSP metadata` | 未实现 | 保留扩展字段即可 |

## 4. CityBrain 推荐工具架构

不建议把 Claude Code 的所有方法直接塞进一个巨大的工具接口。建议将工具
职责拆成六个层次：

```text
ToolDefinition
  ├─ ToolIdentity
  ├─ ToolContract
  ├─ ToolPolicy
  ├─ ToolHooks
  ├─ ToolRuntime
  └─ ToolPresentation
```

### 4.1 ToolIdentity

描述工具的身份和发现信息：

```ts
interface ToolIdentity {
  name: string;
  aliases?: string[];
  description: string;
  searchHint?: string;
  source?: "builtin" | "qgis" | "mcp" | "subagent";
  enabled?: boolean;
  deferred?: boolean;
  alwaysLoad?: boolean;
}
```

首期至少需要：

```text
name
aliases
description
source
enabled
```

### 4.2 ToolContract

描述输入、输出和结果策略：

```ts
interface ToolContract<Input = unknown, Output = unknown> {
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  parseInput?: (raw: string) => Input;
  validateInput?: (
    input: Input,
    context: ToolRuntimeContext,
  ) => Promise<ToolValidationResult>;
  mapResult?: (
    output: Output,
    context: ToolRuntimeContext,
  ) => ToolResultPayload;
  maxResultSizeChars?: number;
  strict?: boolean;
}
```

其中：

- `parseInput` 负责 JSON 修复、类型转换和基础解析；
- `validateInput` 负责工具执行前校验；
- `mapResult` 将内部输出映射为模型、CLI 和日志可使用的结果；
- `maxResultSizeChars` 控制模型上下文中的结果大小；
- `outputSchema` 为未来结构化结果验证预留。

### 4.3 ToolPolicy

描述安全、权限、并发和中断行为：

```ts
interface ToolPolicy<Input = unknown> {
  isReadOnly?: (input: Input) => boolean;
  isDestructive?: (input: Input) => boolean;
  isConcurrencySafe?: (input: Input) => boolean;
  interruptBehavior?: "cancel" | "block";
  requiresUserInteraction?: (input: Input) => boolean;
  getPath?: (input: Input) => string | string[] | undefined;
  authorize?: (
    input: Input,
    context: ToolRuntimeContext,
  ) => Promise<PermissionDecision>;
}
```

默认策略必须保守：

```text
isReadOnly           -> false
isDestructive        -> false
isConcurrencySafe    -> false
interruptBehavior    -> block
requiresUserInteraction -> false
```

未知工具、参数解析失败或策略判断失败时，应默认拒绝或进入失败结果，
不能默认放行并发或写入。

权限决策不应由单个工具自行完成，而应由 Harness 统一协调：

```ts
type PermissionDecision =
  | {
      action: "allow";
      source: "policy" | "user" | "hook" | "system";
      reason?: string;
    }
  | {
      action: "deny";
      source: "sandbox" | "policy" | "project_rules" | "hook" | "system";
      reason: string;
    }
  | {
      action: "ask";
      source: "policy" | "project_rules";
      reason: string;
    };

interface PermissionCoordinator {
  evaluate<Input>(
    tool: CoreTool<Input, unknown>,
    input: Input,
    context: ToolRuntimeContext,
  ): Promise<PermissionDecision>;
}
```

推荐的判断顺序：

```text
1. PreToolUse Hook 对规范化输入进行补全或拦截
2. 对 Hook 修改后的输入重新解析和规范化
3. SandboxPolicy 硬检查
4. ToolPolicy 风险与并发检查
5. AGENTS.md / workspace.json / 任务规则检查
6. 必要时请求用户确认
7. 形成最终 allow / deny / ask 决策
```

`allow` 只表示当前动作通过权限协调器；工具仍然必须经过
`ToolRuntime` 执行前的最终输入校验。任何普通策略或 Hook 都不能把
SandboxPolicy 的 `deny` 改写为 `allow`。如果 `PreToolUse` 修改了路径，
必须重新执行 SandboxPolicy 检查。

### 4.4 ToolRuntime

描述实际执行行为：

```ts
interface ToolRuntime<Input = unknown, Output = unknown> {
  execute(
    input: Input,
    context: ToolRuntimeContext,
  ): Promise<ToolExecutionResult<Output>>;
}
```

运行时上下文建议包含：

```ts
interface ToolRuntimeContext {
  runId: string;
  turn: number;
  toolCallId: string;
  taskId: string;
  signal: AbortSignal;
  sandbox: SandboxPolicy;
  artifacts: ArtifactRegistry;
  logger: ToolExecutionLogger;
  emitProgress: (progress: ToolProgress) => void;
  emitPhase: (phase: ToolExecutionPhase) => void;
  getContextValue?: (key: string) => unknown;
  setContextValue?: (key: string, value: unknown) => void;
}
```

工具不应该直接依赖全局 session、CLI 组件或模型对象，而应从
`ToolRuntimeContext` 获取运行时能力。

### 4.5 ToolHooks

Hook 是工具生命周期的一部分，不是散落在 `ToolRegistry` 中的异常回调。
建议使用一个稳定的最小接口：

```ts
type ToolHookResult = {
  decision?: "continue" | "block" | "mark_review";
  updatedInput?: unknown;
  additionalContext?: string;
  preventContinuation?: boolean;
  stopReason?: string;
  audit?: Record<string, unknown>;
};

interface ToolHooks<Input = unknown, Output = unknown> {
  beforeExecute?: (
    input: Input,
    context: ToolRuntimeContext,
  ) => Promise<ToolHookResult>;
  afterExecute?: (
    result: ToolExecutionResult<Output>,
    context: ToolRuntimeContext,
  ) => Promise<ToolHookResult>;
  onError?: (
    error: ToolError,
    context: ToolRuntimeContext,
  ) => Promise<ToolHookResult>;
}
```

Hook 的职责边界：

| Hook | 可以做什么 | 不应该做什么 |
|---|---|---|
| `beforeExecute` | 输入补全、上下文注入、风险拦截、记录审计信息 | 绕过 SandboxPolicy、直接替代最终权限决策 |
| `afterExecute` | 验证输出、登记 artifacts、标记 profile stale、追加事实 | 把失败结果改写成成功 |
| `onError` | 保存诊断信息、生成恢复建议、标记结果待复核 | 对有副作用的工具无条件重试 |

所有 Hook 都必须可观测。至少记录：

```text
hook name
tool call id
input changed
permission decision
additional context
duration
status
error
```

### 4.6 ToolPresentation

描述工具在 CLI 中如何显示：

```ts
interface ToolPresentation<Input = unknown, Output = unknown> {
  getActivityDescription?: (input: Partial<Input>) => string;
  getToolUseSummary?: (input: Partial<Input>) => string | null;
  getUserFacingName?: (input?: Partial<Input>) => string;
  renderQueued?: (input: Partial<Input>) => string;
  renderStarted?: (input: Partial<Input>) => string;
  renderProgress?: (
    progress: ToolProgress,
    input: Partial<Input>,
  ) => string;
  renderSuccess?: (
    output: Output,
    input: Input,
  ) => string;
  renderError?: (
    error: ToolError,
    input: Partial<Input>,
  ) => string;
}
```

首期不需要让每个工具直接返回 TUI Component。先返回结构化展示模型：

```ts
interface ToolDisplayModel {
  title: string;
  summary?: string;
  phase?: string;
  status: "queued" | "running" | "success" | "error" | "cancelled";
  details?: string[];
  color: "neutral" | "success" | "error" | "warning";
}
```

这样 CLI 可以统一渲染，未来替换 TUI 也不会影响工具执行。

## 5. 推荐的核心工具类型

建议最终形成一个组合式工具定义：

```ts
interface CoreTool<
  Input = unknown,
  Output = unknown,
> {
  identity: ToolIdentity;
  contract: ToolContract<Input, Output>;
  policy: ToolPolicy<Input>;
  runtime: ToolRuntime<Input, Output>;
  hooks?: ToolHooks<Input, Output>;
  presentation?: ToolPresentation<Input, Output>;
}
```

示例：

```ts
const readFileTool: CoreTool<ReadFileInput, ReadFileOutput> = {
  identity: {
    name: "read_file",
    description: "Read a UTF-8 text file inside the active sandbox.",
    source: "builtin",
    enabled: true,
  },

  contract: {
    inputSchema: readFileSchema,
    maxResultSizeChars: 20_000,
    validateInput: async (input, context) => {
      const target = context.sandbox.resolveReadPath(input.path);
      return {
        ok: true,
        normalizedInput: {
          ...input,
          path: target,
        },
      };
    },
  },

  policy: {
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    interruptBehavior: "cancel",
    getPath: (input) => input.path,
  },

  runtime: {
    async execute(input, context) {
      const content = await readTextFile(input.path, context.signal);
      return {
        output: {
          path: input.path,
          content,
        },
      };
    },
  },

  presentation: {
    getActivityDescription: (input) => `Reading ${input.path ?? "file"}`,
    getToolUseSummary: (input) => input.path ?? null,
  },
};
```

这个例子体现了几个重要原则：

- 工具定义本身声明只读和可并发；
- 路径解析和 sandbox 检查在执行前完成；
- runtime 不负责决定权限；
- CLI 摘要不需要解析原始 JSON；
- 模型结果和 CLI 展示可以分别处理。

## 6. 工具生命周期

### 6.1 推荐生命周期

```text
model_tool_call_received
  ↓
tool_resolved
  ↓
input_parsed
  ↓
input_validated
  ↓
pre_tool_hook
  ↓
tool_normalized
  ↓
sandbox_check
  ↓
policy_check
  ↓
permission_decision
  ↓
tool_artifact_preflight
  ↓
tool_queued
  ↓
tool_started
  ↓
progress*
  ↓
tool_completed
  ↓
post_tool_hook
  ↓
completed / failed
  ↓
model_tool_result

runtime_failed
  ↓
failure_hook
  ↓
failed / cancelled
  ↓
model_tool_result
```

### 6.2 生命周期阶段定义

```ts
type ToolExecutionPhase =
  | "received"
  | "resolved"
  | "parsing"
  | "validating"
  | "pre_tool_hook"
  | "sandbox_check"
  | "policy_check"
  | "permission_decision"
  | "queued"
  | "waiting"
  | "tool_artifact_preflight"
  | "starting"
  | "running"
  | "verifying_outputs"
  | "mapping_result"
  | "post_tool_hook"
  | "failure_hook"
  | "completed"
  | "failed"
  | "cancelled";
```

当前 CLI 不需要全部显示为独立长文本，但日志应保留完整阶段。CLI 可以按
阶段折叠：

```text
run_qgis_algorithm {...}
  validating parameters
  checking sandbox
  registering outputs
  running 32s
  verifying outputs
  completed
```

## 7. QGIS 工具如何使用新契约

QGIS 工具是当前项目最需要增强契约的工具类型。

### 7.1 QGIS 工具身份

```text
name:
  run_qgis_algorithm

source:
  qgis

description:
  Run one QGIS Processing algorithm through qgis_process.
```

### 7.2 QGIS 输入校验

`validateInput` 应至少检查：

- algorithm 是否存在；
- parameters 是否是对象；
- INPUT/LAYER/SOURCE 等输入路径是否可读；
- INPUT 是否位于 sandbox 或授权 read root；
- 参数中的路径是否需要 Windows 路径修复；
- 算法描述是否要求特定字段、类型或 geometry；
- QGIS runtime 是否可用。

### 7.3 QGIS 权限和写入策略

```text
输入路径：
  SandboxPolicy.resolveReadPath()

输出路径：
  SandboxPolicy.resolveWritePath()

临时输出：
  sandbox/.internal/tmp

QGIS cwd：
  sandboxRoot
```

QGIS 输出不能只依赖 QGIS 自己判断路径合法性，Harness 必须在执行前和执行后
各检查一次。

### 7.4 QGIS 并发策略

建议默认：

```text
list_qgis_algorithms       read-only / concurrency-safe
describe_qgis_algorithm    read-only / concurrency-safe
read_file                  read-only / concurrency-safe
list_files                 read-only / concurrency-safe
run_qgis_algorithm         exclusive
write_file                 exclusive
edit_file                  exclusive
```

即使两个 QGIS 算法都看起来是只读查询，也不建议默认并发执行真正的
`qgis_process` 分析任务，除非后续确认：

- 不共享临时文件；
- 不修改同一输出；
- 不产生 QGIS provider 级别冲突；
- 不会造成内存和 CPU 过载。

### 7.5 QGIS 结果映射

QGIS 工具不应该把完整 stdout/stderr 全部作为模型结果返回。建议分成：

```text
模型结果：
  algorithm
  status
  output paths
  elapsed time
  concise stdout/stderr summary

日志结果：
  完整命令
  完整 stdout/stderr
  exit code
  input parameters
  resolved paths
  output verification

profile facts：
  输出数据类型
  CRS
  geometry type
  feature count
  extent
  field list
  raster metadata
```

## 8. 工具结果模型

建议将当前的字符串结果逐步升级为结构化结果：

```ts
interface ToolExecutionResult<Output = unknown> {
  ok: boolean;
  output?: Output;
  content: string;
  error?: ToolError;
  taskId: string;
  toolCallId: string;
  status: "completed" | "failed" | "cancelled";
  artifacts?: ArtifactResult[];
  contextUpdates?: ContextUpdate[];
  usage?: {
    resultCharacters: number;
    persistedPath?: string;
  };
}
```

错误也应结构化：

```ts
interface ToolError {
  code:
    | "unknown_tool"
    | "invalid_json"
    | "invalid_input"
    | "policy_denied"
    | "permission_denied"
    | "execution_failed"
    | "output_invalid"
    | "cancelled"
    | "timeout";
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

这样模型可以区分：

```text
参数错误       -> 修正参数后重试
输入不存在     -> 重新 list/read
sandbox 拒绝   -> 不能自行绕过，需要用户授权
QGIS 执行失败  -> 根据 stderr 判断是否换算法或参数
超时           -> 等待、检查输出或调整策略
```

## 9. 工具注册表的改造方向

当前注册方式：

```ts
registry.register(
  definition,
  handler,
  {
    isConcurrencySafe,
    producesArtifacts,
  },
);
```

后续推荐：

```ts
registry.registerTool({
  identity,
  contract,
  policy,
  runtime,
  hooks,
  presentation,
});
```

注册表负责：

- 工具名称和 alias 解析；
- 工具是否启用；
- schema 暴露；
- 输入解析；
- 生命周期调度；
- PreToolUse Hook 调度；
- PermissionCoordinator 权限决策；
- SandboxPolicy 硬边界检查；
- policy 检查；
- artifact 预登记；
- runtime 调用；
- PostToolUse / PostToolUseFailure 调度；
- 结果映射；
- 日志和事件；
- CLI 展示模型生成。

注册表不应该负责：

- 具体 QGIS 算法业务；
- 具体文件内容解析；
- 具体 CLI 布局；
- 模型供应商请求；
- 画像自然语言生成。

## 10. 不建议一次性复制的 Claude Code 能力

Claude Code 的 `Tool` 类型包含很多适配自身产品形态的能力，当前 CityBrain
不需要一次性实现：

### 10.1 延迟工具发现

`shouldDefer`、`alwaysLoad` 和 ToolSearch 适合工具数量非常大、上下文压力
明显的系统。当前可以先保留字段，不立即实现动态 tool schema 加载。

### 10.2 MCP/LSP 专用元数据

当前主要工具是内置 QGIS 和文件工具。MCP/LSP 字段可以保留扩展位置，
不应该为了接口完整而提前引入大量外部协议逻辑。

### 10.3 React 级别的工具渲染

Claude Code 是复杂的 React/Ink CLI，因此工具对象可以直接返回 React Node。
CityBrain 当前应该先使用结构化 `ToolDisplayModel`，避免让工具层依赖 TUI。

### 10.4 Auto classifier

Claude Code 的 `toAutoClassifierInput` 服务于更复杂的自动权限分类器。当前
可以先将其降级为：

```ts
getSecuritySummary(input): string
```

只写入日志和未来的 Harness 判断，不立即接入第二个模型分类器。

### 10.5 复杂 Hook 生态

Claude Code 的 PreToolUse/PostToolUse Hook 支持阻止执行、修改输入、追加上下文、
停止后续流程等。CityBrain 的核心契约需要先支持最小的
`beforeExecute`、`afterExecute` 和 `onError`；更复杂的外部 Hook 注册、
多级 Hook 优先级和跨进程 Hook 可以后置。

## 11. 分阶段落地建议

### Phase A：工具契约补全

目标：不改变现有工具行为，只增加统一元数据。

新增：

```text
aliases
source
isReadOnly
isDestructive
interruptBehavior
getPath
getActivityDescription
getToolUseSummary
maxResultSizeChars
```

改造结果：

- `ToolRegistry` 从分散注册选项读取工具元数据；
- `StreamingToolExecutor` 使用工具契约判断并发和中断；
- CLI 使用工具自己的 activity/summary；
- 日志记录工具类型、只读性、危险性和并发策略。

### Phase B：统一 preflight

目标：将执行前检查从 handler 中抽出来。

顺序：

```text
parse
  -> tool resolved
  -> schema validate
  -> normalize input
  -> normalized schema validate
  -> tool-specific validateInput
  -> final schema validate
  -> artifact preflight
  -> queue
  -> execute
```

当前实现已经完成上述基础 preflight。`PreToolUse`、
`PermissionCoordinator`、`SandboxPolicy` 统一硬检查以及
`PostToolUse/PostToolUseFailure` 的调度已经在 Phase D 接入；现有 handler
内部的 sandbox 检查继续保留，作为运行时的最后一道保护。

新增事件：

```text
tool_resolved
tool_validating
tool_normalizing
tool_normalized
tool_artifact_preflight
tool_queued
tool_started
tool_completed
pre_tool_hook
post_tool_hook
failure_hook
tool_failed
```

### Phase C：统一结果契约

目标：从纯字符串结果转向结构化结果。

新增：

```text
ToolExecutionResult
ToolError
ArtifactResult
ToolResultPayload
```

同时分离：

```text
model content
CLI display
execution log
profile facts
```

### Phase D：Hook 与权限

目标：引入 Claude Code 风格的前后置生命周期，并将路径边界、工具风险、
项目规则和用户确认统一纳入权限决策。

接口复用第 4.5 节的 `ToolHooks` 和 `PermissionCoordinator`，不在
执行器中重新定义第二套权限协议。

Hook 能力先支持：

- 记录或追加上下文；
- 修改规范化后的输入；
- 阻止执行；
- 标记 profile stale；
- 触发 artifact 校验。

Phase D 的权限决策至少应覆盖：

- sandbox 内外路径判断；
- 读、写、删除、覆盖和外部进程执行的风险分类；
- `AGENTS.md`、`workspace.json` 和当前任务约束；
- 是否需要用户确认；
- 权限决策和 Hook 变更的审计日志。

当前已完成基础实现，详见 `TOOL_CONTRACT_PHASE_D_PLAN.md`。现阶段项目规则
和用户确认通过可注入回调接入，尚未绑定具体 CLI 交互；未提供确认回调时，
`ask` 不会自动放行。

### Phase E：工具发现与复杂展示

只有当内置工具、QGIS 工具、MCP 工具数量明显增长后，再考虑：

- deferred tools；
- ToolSearch；
- 动态工具 schema；
- 工具分组渲染；
- 专用权限分类器；
- 复杂用户交互工具。

## 12. 推荐的工具基类边界

未来如果需要使用 class，可以采用较薄的基类：

```ts
abstract class BaseTool<Input, Output> {
  abstract readonly identity: ToolIdentity;
  abstract readonly contract: ToolContract<Input, Output>;
  abstract readonly policy: ToolPolicy<Input>;
  abstract readonly runtime: ToolRuntime<Input, Output>;

  readonly presentation: ToolPresentation<Input, Output> = {};
  readonly hooks: ToolHooks = {};

  async prepare(
    rawArguments: string,
    context: ToolRuntimeContext,
  ): Promise<PreparedToolCall<Input>> {
    // parse, validate, normalize, policy check
  }

  async execute(
    input: Input,
    context: ToolRuntimeContext,
  ): Promise<ToolExecutionResult<Output>> {
    return this.runtime.execute(input, context);
  }
}
```

不过当前阶段更推荐使用组合式对象，而不是强制所有工具继承一个大型基类。
原因是：

- QGIS 工具、文件工具、子 Agent 工具差异很大；
- 组合式能力便于逐项迁移；
- 可以避免基类拥有大量不适用的空方法；
- 更接近 Claude Code `buildTool` 为工具补默认值的思路。

## 13. 当前项目的最终目标结构

```text
src/tools/
├─ core/
│  ├─ tool-types.ts
│  ├─ tool-contract.ts
│  ├─ tool-policy.ts
│  ├─ permission-coordinator.ts
│  ├─ tool-hooks.ts
│  ├─ tool-lifecycle.ts
│  ├─ tool-errors.ts
│  └─ tool-display.ts
├─ tool-registry.ts
├─ streaming-tool-executor.ts
├─ artifact-registry.ts
├─ tool-execution-log.ts
├─ file-tools/
│  ├─ read-file.ts
│  ├─ list-files.ts
│  ├─ write-file.ts
│  └─ edit-file.ts
├─ qgis-tools/
│  ├─ list-algorithms.ts
│  ├─ describe-algorithm.ts
│  └─ run-algorithm.ts
└─ subagent-tool.ts
```

执行链路：

```text
AgentLoop
  -> StreamingToolExecutor
  -> ToolRegistry
  -> ToolLifecycle
  -> ToolContract
  -> PreToolUseHooks
  -> PermissionCoordinator
  -> SandboxPolicy / ToolPolicy / ProjectRules / UserApproval
  -> ToolRuntime
  -> PostToolUse / PostToolUseFailure
  -> ArtifactRegistry
  -> ToolResultMapper
  -> CLI / model / logs / profile
```

## 14. 设计原则总结

### 14.1 工具不是一个 handler

工具应该是一个完整契约：

```text
身份
输入
输出
校验
权限
并发
中断
运行时
产物
展示
日志
```

### 14.2 模型描述、运行结果和 CLI 展示分离

同一份工具结果应该有不同投影：

```text
Model Projection
UI Projection
Log Projection
Profile Projection
```

### 14.3 安全策略必须由 Harness 执行

System Prompt 可以告诉模型权限边界，但最终权限必须在工具运行时校验。
模型不能通过修改参数绕过：

- sandbox；
- 外部目录授权；
- 输出目录限制；
- 工具并发策略；
- 结果写入规则。

这里的 sandbox 不需要和权限体系完全割裂，但需要作为独立的策略模块
维护。推荐关系是：

```text
权限体系
  ├─ SandboxPolicy：路径和文件系统硬边界
  ├─ ToolPolicy：工具能力、风险、并发和中断
  ├─ ProjectRules：项目和任务约束
  ├─ UserApproval：用户确认
  └─ Hooks：执行前后的可观测扩展
```

这样既能统一管理权限，又能保证 SandboxPolicy 的职责清晰：它负责回答
“能否触碰这个路径”，而不是承担所有工具风险判断。任何其他层只能收紧
SandboxPolicy，不能将拒绝改为允许。

### 14.4 默认保守

工具未声明的能力，应采用保守默认：

```text
不可并发
不可自动放行
不可判断为只读
不可跳过输出校验
不可绕过 sandbox
```

### 14.5 先形成稳定契约，再增加复杂功能

当前最重要的不是实现 Claude Code 的所有工具方法，而是先让每个 CityBrain
工具都能清晰回答：

```text
我是谁？
我接受什么输入？
我是否安全？
我能否并发？
我什么时候可以取消？
我会产生什么文件？
我如何显示？
我失败后模型应该怎么恢复？
```
