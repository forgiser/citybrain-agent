# CityBrain 工具架构整理与工厂化重构方案

> 状态：工具平铺迁移已完成，进入 ToolCatalog 收口和兼容层清理阶段  
> 目标：在不新增功能、不删减现有功能的前提下，整理工具目录、统一工具契约、集中工具工厂和注册入口。

## 1. 重构目标

当前工具已经具备参数校验、输入规范化、权限协调、沙箱检查、并发判断、Hook、产物登记、进度上报和日志记录等能力，但这些能力分布在多个层级：

```text
interactive-app.ts
  -> 手动注册 definition / handler / metadata
  -> ToolRegistry
  -> PermissionCoordinator
  -> StreamingToolExecutor
  -> ToolHandler 内部逻辑
```

这种结构适合 MVP，但随着 QGIS 算法、文件工具、子 Agent 和后续 MCP 工具增加，会出现：

- 工具定义和工具注册分散在 App 中；
- 工具元数据与执行逻辑不在同一个工具目录；
- `ToolMetadata` 和 `ToolRegistrationOptions` 的职责边界不够清晰；
- QGIS 工具、文件工具和子 Agent 使用不同的工厂返回结构；
- 校验、权限、并发、产物、展示等能力无法从一个工具定义中完整看出；
- 相同的工具注册配置可能在主 Agent 和子 Agent 中重复；
- 工具目录按照“当前文件数量”增长，而不是按照领域和生命周期组织。

本次重构的目标是：

```text
工具工厂
  -> 生成完整 ToolSpec
  -> 工具目录聚合
  -> 统一注册
  -> Harness 统一执行
```

重构只改变组织方式和依赖方向，不改变现有工具的行为。

## 2. 当前结构盘点

### 2.1 当前目录

当前工具相关代码主要分布在：

```text
src/tools/
  artifact-registry.ts
  edit-file.ts
  file-write-utils.ts
  list-files.ts
  permission-coordinator.ts
  read-file.ts
  streaming-tool-executor.ts
  subagent-tool.ts
  tool-contract.ts
  tool-execution-log.ts
  tool-preflight.ts
  tool-registry.ts
  write-file.ts

src/integrations/qgis/
  qgis-process-client.ts
  qgis-tools.ts
  qgis-runtime.ts
  qgis-setup.ts
  path-input-dialog.ts

src/app/
  interactive-app.ts
```

### 2.2 当前职责分布

| 内容 | 当前所在位置 | 问题 |
| --- | --- | --- |
| ToolMetadata | `src/tools/tool-contract.ts` | 主要定义策略元数据 |
| validateInput | `ToolRegistrationOptions`，位于 `tool-registry.ts` | 工具契约混在 Registry 实现文件中 |
| normalizeInput | `ToolRegistrationOptions`，位于 `tool-registry.ts` | 没有和工具的输入契约放在一起 |
| definition / handler 注册 | `interactive-app.ts` | App 承担了工具装配职责 |
| QGIS 工具定义 | `src/tools/<qgis-tool>/` | 每个 QGIS 工具独立定义、校验和执行 |
| 文件工具定义 | `src/tools/read-file.ts` 等 | 工具实现和工具描述分散在根目录 |
| 权限策略 | `permission-coordinator.ts` | 已经具备统一入口，但由 Registry 间接调用 |
| 沙箱边界 | `SandboxPolicy` + Registry + Handler | 统一检查和运行时最后检查并存 |
| 并发调度 | `StreamingToolExecutor` | 消费 Registry 解析出的结果 |
| 日志和生命周期 | `tool-execution-log.ts`、`tool-registry.ts` | 能力已存在，但目录层次不清晰 |
| 子 Agent 工具注册 | `subagent-tool.ts` | 存在一套子工具装配逻辑 |

### 2.3 当前最需要解决的问题

当前并不是缺少 `validateInput`、`isConcurrencySafe` 或权限能力，而是这些能力没有统一地作为“一个完整工具”的组成部分出现。

例如当前工具实际由以下几部分组成：

```text
ChatToolDefinition
ToolHandler
ToolMetadata
normalizeInput
validateInput
producesArtifacts
PermissionCoordinator
ToolHooks
CLI 展示逻辑
```

这些内容应当被一个工厂统一组装成 `ToolSpec`，而不是由 App 逐项拼接。

## 3. 目标目录结构

目标结构建议如下：

```text
src/tools/
  index.ts                         # 对外统一出口和工具集合工厂

  core/                             # 跨工具公共核心，不代表具体工具
    contracts/                      # ToolSpec、上下文、预检、生命周期类型
    execution/                      # Registry 和 StreamingToolExecutor
    security/                       # 权限协调器
    artifacts/                      # 产物状态注册表
    observability/                  # 工具执行日志
    shared/                         # 跨文件工具的通用实现
    qgis/                           # QGIS 工具共用适配逻辑

  read-file/                        # 一个工具一个顶层目录
    index.ts                        # 定义、工厂、执行逻辑和工具策略
  list-files/
    index.ts
  write-file/
    index.ts
  edit-file/
    index.ts
  list-qgis-algorithms/
    index.ts
  describe-qgis-algorithm/
    index.ts
  run-qgis-algorithm/
    index.ts
  delegate/
    index.ts
```

工具目录不再按 `builtin/qgis/subagent` 进行二次分组。工具的领域归属通过
`ToolSpec.metadata.source` 和工具名称表达；目录只表达“这是一个可独立注册、校验、执行的工具”。

QGIS 的运行环境和 `qgis_process` 客户端仍然可以保留在：

```text
src/integrations/qgis/
  qgis-process-client.ts
  qgis-runtime.ts
  qgis-setup.ts
  path-input-dialog.ts
```

这里需要区分：

```text
src/integrations/qgis/          QGIS 运行时基础设施
src/tools/qgis/    QGIS Agent 工具定义
```

## 4. 统一 ToolSpec 设计

### 4.1 ToolSpec 是工具工厂的统一产物

每个工具工厂最终返回一个完整的 `ToolSpec`：

```ts
interface ToolSpec<Input = unknown, Output = string> {
  identity: ToolIdentity;
  definition: ChatToolDefinition;
  contract: ToolContract<Input, Output>;
  policy: ToolPolicy<Input>;
  runtime: ToolRuntime<Input, Output>;
  artifacts?: ToolArtifacts<Input>;
  hooks?: ToolHooks<Input, Output>;
  presentation?: ToolPresentation<Input, Output>;
}
```

它不是要求所有工具继承一个巨大基类，而是使用组合式结构表达工具能力。

### 4.2 ToolIdentity

负责工具的身份和发现：

```ts
interface ToolIdentity {
  name: string;
  aliases?: readonly string[];
  description: string;
  source: "builtin" | "qgis" | "mcp" | "subagent";
  enabled?: boolean;
  deferred?: boolean;
}
```

### 4.3 ToolContract

负责工具输入和输出：

```ts
interface ToolContract<Input, Output> {
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  normalizeInput?: (
    input: unknown,
    context: ToolRuntimeContext,
  ) => Input | Promise<Input>;
  validateInput?: (
    input: Input,
    context: ToolRuntimeContext,
  ) => ToolValidationResult | Promise<ToolValidationResult>;
  mapResult?: (
    output: Output,
    context: ToolRuntimeContext,
  ) => ToolResultPayload;
  maxResultSizeChars?: number;
}
```

因此：

- Schema 校验负责基本结构；
- `normalizeInput` 负责路径、别名和默认值规范化；
- `validateInput` 负责工具领域规则；
- `mapResult` 负责统一结果结构；
- 工具 Handler 不再承担全部前置校验职责。

### 4.4 ToolPolicy

负责工具声明自身的能力和风险：

```ts
interface ToolPolicy<Input> {
  isReadOnly?: (input: Input) => boolean;
  isDestructive?: (input: Input) => boolean;
  isConcurrencySafe?: (input: Input) => boolean;
  interruptBehavior?: "cancel" | "block";
  requiresUserInteraction?: (input: Input) => boolean;
  getPath?: (input: Input) => string | string[] | undefined;
  getReadPaths?: (input: Input) => string | string[] | undefined;
  getWritePaths?: (input: Input) => string | string[] | undefined;
  authorize?: (
    input: Input,
    context: ToolRuntimeContext,
  ) => Promise<PermissionDecision>;
}
```

这些内容应该由各个工具自己声明。例如：

```text
read_file
  isReadOnly = true
  isConcurrencySafe = true
  interruptBehavior = cancel

write_file
  isReadOnly = false
  isDestructive = true
  isConcurrencySafe = false
  requiresUserInteraction = true
  interruptBehavior = block

run_qgis_algorithm
  isConcurrencySafe = 根据 algorithm 和 OUTPUT 动态判断
  getReadPaths = 读取参数中的输入数据
  getWritePaths = 输出参数路径
```

但是工具只声明策略，最终是否允许执行仍然由 `PermissionCoordinator`、SandboxPolicy、项目规则和 Human-in-the-Loop 决定。

### 4.5 ToolRuntime

只负责真正执行：

```ts
interface ToolRuntime<Input, Output> {
  execute(
    input: Input,
    context: ToolRuntimeContext,
  ): Promise<Output>;
}
```

Runtime 不应直接依赖：

- `interactive-app.ts`
- ModelRuntime
- AgentLoop
- TUI 组件
- 全局 Session

它只通过 `ToolRuntimeContext` 获取运行时能力。

### 4.6 ToolArtifacts

负责声明和登记产物：

```ts
interface ToolArtifacts<Input> {
  produces?: (
    input: Input,
    context: ToolRuntimeContext,
  ) => string[];
}
```

QGIS 的输出文件、文件写入工具产生的目标文件，都通过该能力进入统一的 `ArtifactRegistry`。

## 5. 工具工厂规范

### 5.1 单工具工厂

每个具体工具提供一个工厂函数：

```text
createReadFileTool()
createListFilesTool()
createWriteFileTool()
createEditFileTool()

createListQgisAlgorithmsTool()
createDescribeQgisAlgorithmTool()
createRunQgisAlgorithmTool()
```

工厂负责组装该工具的全部静态定义和运行时依赖：

```ts
function createRunQgisAlgorithmTool(
  deps: QgisToolDependencies,
): ToolSpec<RunQgisInput, RunQgisOutput> {
  return {
    identity: ...,
    definition: ...,
    contract: ...,
    policy: ...,
    runtime: ...,
    artifacts: ...,
  };
}
```

### 5.2 工具集合工厂

每个领域提供一个集合工厂：

```ts
function createFileTools(
  deps: FileToolDependencies,
): ToolSpec[] {
  return [
    createReadFileTool(deps),
    createListFilesTool(deps),
    createWriteFileTool(deps),
    createEditFileTool(deps),
  ];
}
```

QGIS 工具同理：

```ts
function createQgisTools(
  deps: QgisToolDependencies,
): ToolSpec[] {
  return [
    createListQgisAlgorithmsTool(deps),
    createDescribeQgisAlgorithmTool(deps),
    createRunQgisAlgorithmTool(deps),
  ];
}
```

### 5.3 总工具目录工厂

App 不再逐个调用 `register()`，而是只组装依赖并创建工具目录：

```ts
const catalog = createToolCatalog({
  fileTools: {...},
  qgisTools: {...},
  subagentTools: {...},
  harness: {...},
});

catalog.registerInto(toolRegistry);
```

App 只负责：

- 创建 Session；
- 创建 ModelRuntime；
- 创建 SandboxPolicy；
- 创建 HumanInteractionBroker；
- 创建 QGIS runtime；
- 注入依赖；
- 启动 AgentLoop。

App 不再负责逐个填写工具的 `isReadOnly`、`validateInput`、`getWritePaths` 等配置。

## 6. 各类能力应该放在哪里

### 6.1 应该由工具自己定义的内容

以下内容与工具领域知识直接相关，应放在工具工厂的 `contract`、`policy` 或 `artifacts` 中：

- `inputSchema`
- `normalizeInput`
- `validateInput`
- `isReadOnly`
- `isDestructive`
- `isConcurrencySafe`
- `interruptBehavior`
- `getPath`
- `getReadPaths`
- `getWritePaths`
- `producesArtifacts`
- 工具专属 `authorize`
- 工具专属 Hook
- 工具展示摘要和活动描述

例如 QGIS 工具知道哪些参数是 `INPUT`、`OUTPUT`、`DISTANCE`，因此 QGIS 工具工厂负责解析这些参数。

### 6.2 应该由 Harness 统一处理的内容

以下内容不能由单个工具最终决定：

- Sandbox 是否允许访问路径；
- 当前项目规则是否允许；
- 是否需要 Human-in-the-Loop；
- 最终 `allow / deny / ask` 决策；
- 工具生命周期中的统一执行规则；
- 工具并发调度；
- 工具超时和取消；
- 统一错误归一化；
- 产物状态登记；
- 执行日志；
- CLI 和模型结果投影。

这里的 Harness 是 AgentLoop 内部使用的统一编排能力，不是一个脱离
AgentLoop、独立驱动模型循环的第二个 Agent。AgentLoop 仍然拥有完整的
“准备上下文 -> 调用模型 -> 执行工具 -> 收集结果 -> 更新状态 -> 进入下一轮”
控制权。

工具可以声明意图和能力，但不能绕过 Harness 的最终检查。

### 6.3 Tool 中不应直接承担的内容

工具实现不应直接负责：

- 读取 CLI 输入；
- 创建 TUI 组件；
- 决定是否跳过 Sandbox；
- 决定是否自动重试整个 AgentLoop；
- 写入 Agent 对话消息；
- 直接修改 System Prompt；
- 直接控制其他工具的并发。

### 6.4 AgentLoop 的总协调职责

AgentLoop 是整个 Harness 的运行时外层，负责维护一次用户请求期间的可变状态：

- 当前 `messages` 和对话追加顺序；
- 当前轮次、工具轮次和终止条件；
- 当前可见上下文、压缩结果和动态 System Prompt；
- 当前模型请求和流式响应；
- 当前批次的工具调用；
- 工具执行结果写回 messages 的时机；
- 是否继续下一轮模型调用；
- 是否进入最终回答、失败或中止状态。

Harness、StreamingToolExecutor、RecoveryPolicy 和 HumanInteractionBroker
都是 AgentLoop 调用的子能力：

```text
AgentLoop
  -> Context Projection / Compression
  -> Dynamic System Prompt
  -> Model Runtime
  -> StreamingToolExecutor
       -> ToolRegistry / ToolSpec
       -> Execution Log / Artifact Registry
  -> Harness State / Recovery Policy
  -> messages 更新
  -> 下一轮 AgentLoop
```

因此，异常处理不能把 AgentLoop 的循环控制权转移给 ToolRegistry 或
StreamingToolExecutor。工具执行器只返回结构化事实和事件，AgentLoop 在
本轮结束边界统一收敛状态，并决定下一轮如何开始。

## 7. AgentLoop 主循环与工具执行边界

重构后的整体结构应以 AgentLoop 为主循环。工具执行不是独立于 AgentLoop
之外的第二个循环，而是模型返回工具调用后，由 AgentLoop 委托给
StreamingToolExecutor 的一个执行阶段。

```text
AgentLoop while (true)
  -> 收敛上一轮状态和执行事件
  -> 获取当前可见 messages
  -> 工具结果预算裁剪 / 历史剪枝 / microcompact
  -> context collapse / LLM 摘要压缩
  -> 拼接动态 System Prompt
  -> 调用 ModelRuntime
  -> 流式接收 thinking / text / tool calls
  -> 若无 tool calls：进入最终回答
  -> 若有 tool calls：
       -> StreamingToolExecutor 执行当前工具批次
       -> 收集工具事件和 ToolExecutionOutcome
       -> 归一化异常、更新 Harness 状态和恢复决策
       -> 将 assistant tool calls 和 tool results 写入 messages
       -> 判断是否继续下一轮
       -> continue 回到 AgentLoop while (true)
```

单个工具调用的内部执行链路是：

```text
Tool Call
  -> ToolCatalog.resolve()
  -> ToolRegistry.resolve()
  -> parse arguments
  -> schema validation
  -> normalizeInput
  -> validateInput
  -> resolve ToolPolicy
  -> PreToolUse hooks
  -> Sandbox hard check
  -> PermissionCoordinator
       -> project rules
       -> 条件触发 HumanInteractionBroker
  -> artifact preflight
  -> StreamingToolExecutor queue
  -> ToolRuntime.execute()
  -> output validation / result mapping
  -> artifact ready or failed
  -> PostToolUse hooks
  -> ToolExecutionLogger
  -> 返回 ToolExecutionOutcome 和执行事件
```

上面的单工具链路不能替代 AgentLoop 的主循环。尤其是
`HumanInteractionBroker`、异常恢复和结果写回都必须通过 AgentLoop 的状态
边界收敛，避免工具执行器自行启动下一轮模型请求。

其中：

```text
ToolSpec       描述单个工具
ToolFactory    创建 ToolSpec
ToolCatalog    聚合 ToolSpec
ToolRegistry   索引和执行 ToolSpec
StreamingExecutor 调度多个 ToolSpec
Harness        提供安全、状态、恢复和审计能力
AgentLoop      负责整个请求的循环、消息和下一轮决策
```

## 8. 推荐的迁移原则

### 8.1 保持兼容注册入口

第一阶段不要立即删除现有：

```ts
toolRegistry.register(definition, handler, options);
```

可以先增加：

```ts
toolRegistry.registerSpec(toolSpec);
toolRegistry.registerMany(toolSpecs);
```

旧接口暂时转化为 `ToolSpec`，保证迁移期间行为不变。

### 8.2 一次只迁移一个工具域

推荐顺序：

```text
通用文件工具
  -> QGIS 工具
  -> 子 Agent 工具
  -> 其他外部工具
```

不要一次移动所有文件，避免出现大量路径变化和行为变化混在一起的问题。

### 8.3 先建立新契约，再移动实现

迁移顺序必须是：

```text
定义 ToolSpec
  -> 提供兼容适配器
  -> 迁移一个工具
  -> 对照旧行为测试
  -> 删除重复注册代码
```

不建议先移动文件，再边移动边重新设计工具接口。

### 8.4 领域工具不能反向依赖 App

目标依赖方向：

```text
interactive-app
  -> tool catalog
  -> domain tool factories
  -> qgis runtime / workspace / harness ports
```

禁止：

```text
qgis tool -> interactive-app
file tool -> interactive-app
tool factory -> TUI
```

## 9. 分阶段实施计划

### Phase 0：基线盘点与行为冻结

目标：在代码移动前建立当前行为基线。

工作内容：

- 记录所有现有工具名称和别名；
- 记录每个工具的 Schema；
- 记录每个工具的读写路径；
- 记录只读、破坏性、并发和中断策略；
- 记录现有 Hook、权限和产物行为；
- 为文件工具、QGIS 工具和子 Agent 工具补充最小调用测试；
- 明确当前 CLI 展示和日志字段不能变化。

产物：

```text
TOOL_ARCHITECTURE_REORGANIZATION_PLAN.md
tool inventory checklist
tool behavior baseline
```

验收：

- 能够列出当前全部工具；
- 每个工具都有明确的旧注册位置；
- 迁移前后有可比较的行为基线。

### Phase 1：建立 Core ToolSpec 和工厂适配器

目标：把现有 `ToolMetadata`、`ToolRegistrationOptions` 和 Handler 组合为统一的 `ToolSpec`，但不移动现有工具文件。

工作内容：

- 新增 `ToolSpec`、`ToolIdentity`、`ToolContract`、`ToolPolicy`、`ToolRuntime`；
- 将 `validateInput`、`normalizeInput`、`producesArtifacts` 纳入统一契约；
- 增加 `createToolSpec()` 适配器；
- 增加 `ToolRegistry.registerSpec()`；
- 保留旧 `register()` 作为兼容入口；
- 明确默认安全策略。

验收：

- 旧工具仍然可以执行；
- 新旧注册方式生成相同的 `ResolvedToolMetadata`；
- `npm run typecheck` 和 `npm run build` 通过。

### Phase 2：整理通用文件工具

目标：将 `read/list/write/edit` 放入统一文件工具目录，并通过 `createFileTools()` 聚合。

工作内容：

```text
src/tools/builtin/files/
  read-file.ts
  list-files.ts
  write-file.ts
  edit-file.ts
  file-write-utils.ts
  create-file-tools.ts
```

- 工具定义、校验、权限路径和执行函数在同一领域目录内；
- 文件工具共用 `FileToolDependencies`；
- 主 Agent 和子 Agent 都通过同一工厂创建文件工具；
- 删除 App 中逐个注册文件工具的重复配置。

验收：

- 文件读取渐进式查询行为不变；
- 文件写入和编辑的 Human-in-the-Loop 行为不变；
- Sandbox 边界检查行为不变；
- 主 Agent 和子 Agent 工具集合一致。

### Phase 3：整理 QGIS 工具

目标：将 QGIS 工具从单一大文件拆分为领域内的独立工厂。

工作内容：

```text
src/tools/qgis/
  list-algorithms.ts
  describe-algorithm.ts
  run-algorithm.ts
  qgis-tool-common.ts
  create-qgis-tools.ts
```

- `list_qgis_algorithms` 独立工厂；
- `describe_qgis_algorithm` 独立工厂；
- `run_qgis_algorithm` 独立工厂；
- `qgis_process` 调用继续复用 `src/integrations/qgis/qgis-process-client.ts`；
- 输入路径解析、输出路径提取、产物声明和并发判断放入 QGIS 工具自身的契约；
- 未确认只读的算法默认不可并行。

验收：

- QGIS 算法列表、查询和执行行为不变；
- QGIS 输入输出 Sandbox 检查不变；
- 只读查询类算法可以并行；
- 写输出算法仍然串行；
- QGIS 工具不再由 App 逐项拼装。

### Phase 4：整理子 Agent 工具

目标：统一子 Agent 的依赖注入、子工具工厂和 Human-in-the-Loop 继承。

工作内容：

- 将子 Agent 工具移动到 `src/tools/subagent/`；
- 通过 `createSubagentTool()` 创建；
- 子 Agent 的文件和 QGIS 工具复用领域工厂；
- 保留独立 Session 和工具隔离；
- 复用同一个 Harness/Broker 接口，但不共享对话上下文。

验收：

- 子 Agent 不会递归注册自身；
- 子 Agent 的 Sandbox、权限和日志行为不变；
- 子 Agent 可以使用与主 Agent 一致的工具契约。

### Phase 5：集中工具目录和 App 装配

目标：将 App 中的工具注册代码收敛为一次工具目录创建。

目标形式：

```ts
const toolSpecs = createToolCatalog({
  workspace: ...,
  sandbox: ...,
  qgisRuntime: ...,
  humanInteractionBroker: ...,
  logger: ...,
});

toolRegistry.registerMany(toolSpecs);
```

工作内容：

- 新增 `src/tools/catalog/create-tool-catalog.ts`；
- 集中创建文件、QGIS、子 Agent 工具；
- App 只提供依赖，不定义工具策略；
- 子 Agent 使用同一套领域工具工厂；
- 清理重复的 `isReadOnly`、`isConcurrencySafe`、`getPath` 配置。

验收：

- `interactive-app.ts` 不再包含大量工具元数据；
- 工具集合可以在测试环境独立创建；
- CLI、AgentLoop、子 Agent 都通过 ToolCatalog 获取工具。

### Phase 6：清理兼容层和补充架构测试

目标：在确认所有工具已经迁移后，删除旧的重复接口和兼容代码。

工作内容：

- 删除旧的手动注册适配路径；
- 删除重复的 QGIS 工具接口；
- 统一工具导出入口；
- 增加目录级架构约束；
- 增加工具契约快照测试；
- 增加工具工厂依赖方向检查。

验收：

- 每个工具只能通过工厂进入目录；
- App 不直接拼装工具契约；
- QGIS 工具不会依赖 CLI；
- 工具定义、执行、权限、展示职责边界清晰。

## 10. 测试和验收规范

每个工具工厂至少需要覆盖：

```text
identity
schema
normalizeInput
validateInput
policy
permission paths
concurrency decision
interrupt behavior
artifact declaration
runtime success
runtime failure
```

每个工具域需要覆盖：

- 工具工厂返回数量；
- 工具名称和别名唯一；
- 工具注册后可被 Registry 解析；
- 只读工具不会产生写路径；
- 写工具不会被标记为可并行；
- QGIS 输出路径会进入 ArtifactRegistry；
- Sandbox 拒绝不会被 Human-in-the-Loop 覆盖；
- 子 Agent 使用同一工具契约但保持 Session 隔离。

## 11. 重构期间禁止事项

本次架构整理阶段暂不做以下事情：

- 不新增新的 QGIS 算法；
- 不改变现有工具参数 Schema；
- 不改变 QGIS 算法执行命令；
- 不调整 AgentLoop 的整体策略；
- 不替换当前 Human-in-the-Loop 交互方式；
- 不删除已有工具；
- 不改变 Sandbox 的安全边界；
- 不把所有工具强制改成继承同一个巨大基类；
- 不让工具工厂直接依赖 TUI。

## 12. 最终目标

最终每个工具都可以清晰回答：

```text
我是谁？
我接受什么输入？
我如何校验和规范化输入？
我是否只读？
我是否具有破坏性？
我能否并行？
我如何处理中断？
我需要读取和写入哪些路径？
我是否需要人工确认？
我会产生哪些产物？
我如何执行？
我如何返回结果？
我如何记录和展示？
```

最终执行链路：

```text
Domain Tool Factory
  -> ToolSpec
  -> ToolCatalog
  -> ToolRegistry
  -> Preflight
  -> Permission / Sandbox / Human Approval
  -> StreamingToolExecutor
  -> ToolRuntime
  -> Artifact / Log / Model / CLI Projection
```

这套结构可以在保持当前 MVP 行为的同时，为后续增加更多 QGIS 算法、MCP 工具、数据画像工具和后台 Profile Agent 提供稳定的扩展边界。

## 13. 解耦的正式边界

本次重构不能只停留在“把文件移动到不同目录”。真正的解耦需要同时满足：

```text
领域工具知道自己的业务规则
Harness 知道如何统一编排工具
基础设施知道如何提供能力
CLI 只知道如何展示事件
```

### 13.1 工具模块的职责

工具模块负责：

- 定义工具名称、描述、Schema；
- 定义工具领域输入类型；
- 实现 `normalizeInput`；
- 实现 `validateInput`；
- 实现工具特有的 `checkPermissions`；
- 声明 `isReadOnly`、`isDestructive` 和 `isConcurrencySafe`；
- 声明输入涉及的读写路径；
- 声明中断策略；
- 实现真实的工具业务动作；
- 声明工具产物；
- 返回工具领域结果。

工具模块不负责：

- 直接创建 CLI 或 TUI；
- 直接读取用户键盘输入；
- 直接修改 AgentLoop 状态；
- 直接决定整个会话是否终止；
- 直接覆盖 Sandbox 拒绝；
- 直接调度其他工具；
- 直接写入对话消息；
- 直接调用 ModelRuntime。

### 13.2 Harness 模块的职责

Harness 负责：

- 找到工具；
- 解析和规范化调用；
- 调用工具的 Schema 和领域校验；
- 调用工具特有权限判断；
- 执行 Sandbox 硬检查；
- 合并项目策略和全局权限策略；
- 调用 HumanInteractionBroker；
- 生成最终权限决策；
- 根据工具声明进行并发调度；
- 处理取消、超时、错误和恢复；
- 处理工具结果和产物状态；
- 发布生命周期事件；
- 记录执行日志。

Harness 不负责：

- 理解 QGIS 算法的业务参数含义；
- 理解文件编辑的 `old_string/new_string` 规则；
- 在工具中重复实现领域校验；
- 为每一种工具写一套专属调度器；
- 将工具结果硬编码成某一种 CLI 文本。

### 13.3 基础设施模块的职责

基础设施提供能力，但不参与工具业务判断：

| 模块 | 提供能力 | 不负责 |
| --- | --- | --- |
| `SandboxPolicy` | 路径解析、读写边界、进程工作区 | 判断工具业务是否允许 |
| `HumanInteractionBroker` | 请求、等待、决策、超时、取消 | 决定哪些工具必须询问 |
| `ArtifactRegistry` | 产物 pending/ready/missing/invalid | 判断产物业务含义 |
| `ToolExecutionLogger` | 生命周期和审计日志 | 决定是否允许执行 |
| `StreamingToolExecutor` | 并发、串行、排队、结果顺序 | 判断某算法是否只读 |
| `QgisProcessClient` | 启动和监控 `qgis_process` | 判断 QGIS 参数是否合法 |

## 14. 工具级校验与统一安全校验

### 14.1 两类校验必须分开

```text
Tool.validateInput()
  = 工具领域规则

Harness preflight / PermissionCoordinator / SandboxPolicy
  = 统一安全和运行规则
```

例如 `run_qgis_algorithm`：

```text
工具级 validateInput：
  algorithm 是否存在
  parameters 是否为对象
  参数值类型是否合法
  算法所需字段是否完整

Harness 统一检查：
  INPUT 是否允许读取
  OUTPUT 是否允许写入
  输出是否位于 Sandbox
  是否需要人工确认
  是否可以并行
  是否允许中断
```

### 14.2 `checkPermissions` 的准确定位

工具可以定义：

```ts
checkPermissions(
  input: Input,
  context: ToolRuntimeContext,
): Promise<ToolPermissionAdvice>;
```

它返回工具特有的权限建议：

```ts
type ToolPermissionAdvice =
  | {
      action: "allow";
      updatedInput?: unknown;
      reason?: string;
    }
  | {
      action: "deny";
      reason: string;
    }
  | {
      action: "ask";
      reason: string;
      request?: HumanInteractionRequestInput;
    };
```

它不是最终授权接口。它只提供工具领域相关的权限建议，最终决策由 Harness
统一合并。Human-in-the-Loop 不是每次调用都必经的步骤，而是仅在权限策略或
异常恢复策略要求人工决策时，由 Harness 条件触发：

```text
Tool.checkPermissions()
  -> SandboxPolicy hard check
  -> ProjectRules
  -> PermissionCoordinator
  -> Decision:
       allow  -> execute
       deny   -> stop / return structured error
       ask    -> HumanInteractionBroker
                    -> approve -> execute
                    -> reject  -> stop / return structured error
```

执行过程中出现异常时，Harness 还可以根据工具执行记录再次触发同一个
`HumanInteractionBroker`。这属于异常恢复分支，不是正常工具生命周期中的
固定阶段。

规则如下：

1. 工具可以拒绝自己不支持的业务操作；
2. 工具可以返回 `ask`，表达“该工具认为需要人工判断”，但不能直接读取
   键盘或创建 CLI 交互；
3. 工具不能把 Sandbox 的 `deny` 改为 `allow`；
4. 工具不能绕过全局项目规则；
5. 工具不能在自己的 `checkPermissions` 中直接执行副作用；
6. `checkPermissions` 必须在真正执行前完成；
7. 权限检查产生的输入修改必须重新经过 Schema、路径和 Sandbox 检查；
8. Harness 可以根据历史执行记录升级为人工确认，也可以根据策略直接拒绝，
   不要求工具自身了解重试次数、Agent 循环或 CLI 状态。

### 14.3 权限检查的输入修改

如果工具权限判断返回了 `updatedInput`，执行顺序必须是：

```text
原始输入
  -> validateInput
  -> checkPermissions
  -> updatedInput
  -> Schema 重新校验
  -> normalizeInput
  -> 路径重新提取
  -> Sandbox 重新检查
  -> 最终权限决策
  -> execute
```

不能出现以下不安全流程：

```text
checkPermissions 修改路径
  -> 直接 execute
```

## 15. 推荐的完整 ToolSpec 组成

为了避免将所有内容继续塞进一个 `ToolMetadata`，目标 `ToolSpec` 应按职责分组：

```ts
interface ToolSpec<Input, Output> {
  identity: ToolIdentity;
  contract: ToolContract<Input, Output>;
  policy: ToolPolicy<Input>;
  permissions: ToolPermissions<Input>;
  runtime: ToolRuntime<Input, Output>;
  artifacts?: ToolArtifacts<Input>;
  hooks?: ToolHooks<Input, Output>;
  presentation?: ToolPresentation<Input, Output>;
}
```

### 15.1 `contract`

```ts
interface ToolContract<Input, Output> {
  definition: ChatToolDefinition;
  inputSchema: unknown;
  outputSchema?: unknown;
  normalizeInput?: (
    input: unknown,
    context: ToolRuntimeContext,
  ) => Input | Promise<Input>;
  validateInput?: (
    input: Input,
    context: ToolRuntimeContext,
  ) => Promise<ToolValidationResult>;
  mapResult?: (
    output: Output,
    context: ToolRuntimeContext,
  ) => ToolResultPayload;
}
```

### 15.2 `policy`

```ts
interface ToolPolicy<Input> {
  isReadOnly(input: Input): boolean;
  isDestructive(input: Input): boolean;
  isConcurrencySafe(input: Input): boolean;
  interruptBehavior(input: Input): "cancel" | "block";
  getPath?(input: Input): string | string[] | undefined;
  getReadPaths?(input: Input): string | string[] | undefined;
  getWritePaths?(input: Input): string | string[] | undefined;
}
```

### 15.3 `permissions`

```ts
interface ToolPermissions<Input> {
  requiresUserInteraction?(input: Input): boolean;
  checkPermissions?(
    input: Input,
    context: ToolRuntimeContext,
  ): Promise<ToolPermissionAdvice>;
}
```

### 15.4 `runtime`

```ts
interface ToolRuntime<Input, Output> {
  execute(
    input: Input,
    context: ToolRuntimeContext,
  ): Promise<Output>;
}
```

### 15.5 `presentation`

```ts
interface ToolPresentation<Input, Output> {
  getActivityDescription?(input: Partial<Input>): string;
  getToolUseSummary?(input: Partial<Input>): string | undefined;
  renderResult?(result: ToolResultPayload): ToolDisplayModel;
}
```

工具定义可以提供展示数据，但不直接依赖具体 CLI 组件。CLI 只消费 `ToolDisplayModel` 或统一生命周期事件。

## 16. 依赖方向规则

### 16.1 允许的依赖方向

```text
App Composition Root
  -> Tool Catalog
  -> Domain Tool Factory
  -> Core Tool Contracts
  -> Harness Ports
  -> Infrastructure Adapters
```

具体工具可以依赖：

- `ToolRuntimeContext`；
- 所属领域的基础客户端；
- `SandboxPolicy` 的只读能力接口；
- `ArtifactRegistry` 的能力接口；
- `HumanInteractionBroker` 的能力接口；
- 日志和进度上报接口。

### 16.2 禁止的依赖方向

以下依赖必须禁止：

```text
工具实现 -> interactive-app.ts
工具实现 -> TUI 组件
工具实现 -> AgentLoop
工具实现 -> ModelRuntime
工具实现 -> SessionManager
ToolSpec -> ToolRegistry 实现细节
ToolPolicy -> CLI 输入
QGIS 工具 -> QGIS setup UI
```

### 16.3 依赖注入要求

工具工厂通过依赖参数获取运行时服务：

```ts
interface QgisToolDependencies {
  getRuntime: () => QgisRuntimeInfo | undefined;
  processClient: QgisProcessClient;
  workspace: WorkspacePort;
}
```

文件工具通过：

```ts
interface FileToolDependencies {
  getProjectDir: () => string;
  sandbox: SandboxPort;
  fileSystem: FileSystemPort;
}
```

这样可以在测试中注入 fake runtime、fake filesystem 和 fake sandbox，而不需要启动整个 CLI。

## 17. 工具生命周期责任矩阵

下表描述的是各模块的责任边界，不表示每次工具调用必须依次经过所有行。
尤其是 Human-in-the-Loop，它是由权限决策或异常策略触发的条件分支；只有在
策略判定为 `ask` 时才会进入。工具执行记录是 Harness 判断是否进入该分支的
重要输入。

这里还需要区分“工具执行事实”和“AgentLoop 的循环决策”：

- 工具模块和执行器产生事实：校验结果、运行状态、错误、产物、耗时；
- Harness 负责归一化事实、调用恢复策略并发布事件；
- AgentLoop 在当前工具批次结束后消费这些结果，更新 messages 和状态；
- AgentLoop 决定是继续下一轮、重试、等待、最终回答还是终止；
- 下一轮开始时，AgentLoop 使用更新后的 messages 执行上下文压缩和 Prompt
  组装，不是由工具执行器自行重新调用模型。

| 能力/事件 | 工具模块 | Harness | AgentLoop | 基础设施 | CLI |
| --- | --- | --- | --- | --- | --- |
| 解析输入 | 提供 Schema | 调用和处理错误 | 维护当前 tool call 批次 | - | - |
| 输入规范化 | 实现领域规范化 | 控制调用顺序 | 接收修正后的结果 | 路径能力 | - |
| 工具校验 | 实现 `validateInput` | 统一结果处理 | 决定是否继续当前循环 | 文件/QGIS客户端 | - |
| 工具权限建议 | 实现 `checkPermissions` | 合并最终决策 | 消费决策并更新状态 | Broker/Sandbox | - |
| Sandbox 检查 | 提供路径声明 | 强制调用 | 处理阻断结果 | 执行路径检查 | - |
| 权限触发 HITL | 提供原因、风险和选项 | 仅在 `ask` 或策略升级时调用 Broker | 暂停/恢复当前循环 | Broker/适配器 | 展示和输入 |
| 并发判断 | 实现 `isConcurrencySafe` | 调度 | 等待当前工具批次边界 | - | 显示队列状态 |
| 执行 | 实现 runtime | 创建上下文和监控 | 消费执行事件 | QGIS/filesystem/process | 显示进度 |
| 产物登记 | 声明输出 | 更新状态 | 将结果写入下一轮上下文 | ArtifactRegistry | 显示结果 |
| 执行记录 | 提供工具标识和领域信息 | 记录输入摘要、状态、耗时、重试和错误 | 在轮次边界消费记录 | Logger/持久化 | 可选显示 |
| 异常处理 | 提供领域错误 | 归一化、分类、恢复、熔断、按策略触发 HITL | 决定下一轮或终止 | 日志/状态存储 | 显示摘要 |
| 结果映射 | 提供领域结果 | 控制投影 | 追加 assistant/tool messages | 日志/profile 存储 | 渲染 |
| 上下文压缩 | - | 提供压缩能力和报告 | 每轮开始时组装可见 messages | 压缩存储 | 显示上下文状态 |
| 模型调用和下一轮 | - | 提供模型错误恢复能力 | 负责模型请求、循环和终止 | ModelRuntime | 流式展示 |

## 18. 工厂和注册的唯一入口

工具注册必须遵循以下规则：

```text
具体工具文件
  -> createXxxTool()
领域工具集合
  -> createFileTools() / createQgisTools()
总工具目录
  -> createToolCatalog()
唯一 Composition Root
  -> ToolRegistry.registerMany()
```

不允许出现：

- `interactive-app.ts` 直接导入每一个具体工具并逐个填写 metadata；
- 主 Agent 和子 Agent 各自维护一份完整的 QGIS 注册配置；
- 同一个工具同时存在两套 `isConcurrencySafe` 定义；
- Handler 外部再配置一套与工具自身不一致的校验规则；
- 工具定义通过全局变量寻找 Sandbox、Logger 或 Broker。

### 18.1 允许的兼容层

迁移期间可以提供：

```ts
toolRegistry.registerLegacy(definition, handler, options);
```

但兼容层只能存在于 Registry，不得继续扩散到新的工具模块。每完成一个领域迁移，就删除该领域的旧注册代码。

## 19. 架构级验收规则

除了类型检查和功能测试，还需要增加架构级检查：

### 19.1 工具完整性检查

每个 `ToolSpec` 必须能够被检查出：

```text
identity
inputSchema
validateInput
checkPermissions
isReadOnly
isDestructive
isConcurrencySafe
interruptBehavior
execute
```

未显式定义的能力使用保守默认值：

```text
isReadOnly          -> false
isDestructive       -> false
isConcurrencySafe   -> false
interruptBehavior   -> block
```

### 19.2 安全边界检查

- 任意 `checkPermissions` 都不能覆盖 Sandbox deny；
- 权限修改输入后必须重新执行路径检查；
- 工具不能直接调用 CLI 询问用户；
- 工具不能直接改变 Harness 状态；
- 写入工具不能声明为只读；
- 产物路径必须经过统一 ArtifactRegistry；
- 未声明并发安全的工具不能进入并行批次。

### 19.3 依赖检查

通过静态检查或 Code Review 保证：

- `src/tools/**` 不导入 `src/app/**`；
- `src/tools/**` 不直接创建 TUI；
- `src/tools/core/**` 不导入具体领域实现；
- QGIS 工具只依赖 QGIS Port，不依赖 QGIS Setup UI；
- Registry 不反向依赖具体工具文件；
- Tool Factory 不依赖 AgentLoop。

## 20. 文档和实现进度维护

本方案的进度不以“移动了多少文件”为标准，而以边界是否生效为标准。

每个 Phase 完成时，需要在本文件对应章节增加：

```text
状态：未开始 / 进行中 / 已完成
完成日期：
涉及文件：
保留的兼容层：
行为验证：
遗留问题：
```

推荐的状态记录格式：

| 阶段 | 状态 | 完成标准 |
| --- | --- | --- |
| Phase 0 | 未开始 | 工具清单和行为基线完成 |
| Phase 1 | 已完成 | ToolSpec、分层目录、兼容入口和 `registerSpec/registerMany` 完成 |
| Phase 2 | 已完成 | 文件工具全部迁移到顶层工具目录并由工厂创建 |
| Phase 3 | 已完成 | QGIS 工具按算法职责迁移到顶层工具目录 |
| Phase 4 | 已完成 | 子 Agent 复用平铺工具工厂 |
| Phase 5 | 进行中 | App 已使用统一工具出口，后续可继续收敛为 ToolCatalog |
| Phase 6 | 未开始 | 兼容层删除，架构检查通过 |

### 20.1 Phase 1 实际记录

```text
状态：已完成
完成日期：2026-09-21
涉及文件：
  - src/tools/core/*
  - src/tools/core/*
  - src/tools/read-file/*
  - src/tools/list-files/*
  - src/tools/write-file/*
  - src/tools/edit-file/*
  - src/tools/list-qgis-algorithms/*
  - src/tools/describe-qgis-algorithm/*
  - src/tools/run-qgis-algorithm/*
  - src/tools/delegate/*
  - src/tools/index.ts
  - src/app/interactive-app.ts
保留的兼容层：
  - src/tools/*.ts 的旧路径转出文件
  - 原 `src/qgis/qgis-tools.ts` 已删除，工具入口统一由 `src/tools/index.ts` 提供
行为验证：
  - npm run typecheck 通过
  - 主 Agent 和子 Agent 复用 createFileTools()
  - QGIS 工具通过 registerSpec() 注册
遗留问题：
  - ToolRegistry 的完整执行逻辑仍待继续拆分
  - QGIS 三个工具仍集中在 qgis-tools.ts
  - App Composition Root 仍包含 QGIS 和 delegate 工具的装配逻辑
  - 兼容转出文件将在后续迁移完成后删除
```

## 21. 最终判断标准

当以下问题都可以得到肯定回答时，才认为工具架构完成整理：

1. 新增一个 QGIS 算法时，是否只需要新增或修改 QGIS 工具工厂？
2. 新增工具是否不需要修改 `interactive-app.ts` 的具体注册逻辑？
3. 工具领域校验是否在工具自身定义？
4. 工具特有权限判断是否在工具自身定义？
5. 最终 Sandbox 和权限决策是否仍由 Harness 统一控制？
6. 并发判断是否由工具声明、由 Executor 调度？
7. 工具是否可以在没有 CLI 的测试环境中单独测试？
8. 主 Agent 和子 Agent 是否使用同一套工具工厂？
9. CLI 是否只消费统一事件和展示模型？
10. 工具失败后是否仍由 Harness 统一归一化、日志和恢复？

最终应形成：

```text
工具负责专业知识
工厂负责组装
目录负责聚合
Registry 负责索引
AgentLoop 负责请求循环、消息和下一轮决策
Harness 负责统一安全、状态、恢复和审计能力
基础设施负责提供能力
CLI 负责展示
```

## 22. Human-in-the-Loop 的正确定位

### 22.1 HITL 不是固定生命周期阶段

Human-in-the-Loop（HITL）不应被设计成每次工具调用都必经的步骤：

```text
解析 -> 校验 -> 权限 -> HITL -> 执行 -> 结果
```

推荐拆分为两条路径：

```text
正常路径：
输入 -> 规范化 -> 工具校验 -> 安全检查 -> 执行 -> 记录结果

条件分支：
任意阶段产生事件
  -> Harness 读取执行记录和策略
  -> 自动恢复 / 重试 / 降级 / 终止
  -> 只有需要人工判断时才调用 HumanInteractionBroker
```

因此，HITL 是 Harness 的可复用决策能力，而不是工具生命周期中的固定阶段。
工具只需要提供风险信息、请求原因和可选操作；是否真正询问用户由 Harness
结合权限策略和执行记录决定。

### 22.2 工具执行记录是决策输入

工具执行记录不应只保存给人查看的文本日志，还应形成结构化状态记录：

```ts
interface ToolExecutionRecord {
  executionId: string;
  parentExecutionId?: string;
  toolName: string;
  inputSummary: unknown;
  normalizedInputSummary?: unknown;
  status:
    | "received"
    | "validated"
    | "blocked"
    | "awaiting_human"
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out";
  errorCode?: string;
  errorClass?: string;
  retryCount: number;
  durationMs?: number;
  affectedPaths?: string[];
  producedArtifacts?: string[];
  recoveryAction?: string;
  timestamp: string;
}
```

Harness 根据当前事件和同一任务的历史记录进行决策，而不是让每个工具
自行维护重试计数、重复调用判断或交互状态。

### 22.3 典型事件与处理策略

| 事件 | 默认处理 | 何时触发 HITL | 不能做的事情 |
| --- | --- | --- | --- |
| Schema 或参数校验失败 | 返回结构化错误，让 Agent 修正参数 | 存在多个合理解释且自动修正有风险 | 不能把无效参数交给 runtime |
| 工具领域校验失败 | 终止本次调用或要求 Agent 换方案 | 需要用户选择字段、图层或算法语义 | 不能由 CLI 私自修改参数 |
| Sandbox 拒绝 | 直接拒绝 | 仅当项目策略允许申请外部目录授权 | HITL 不能覆盖硬性 Sandbox deny |
| 破坏性或高风险操作 | 挂起等待确认 | 默认触发 | 不能由工具直接读取键盘 |
| 权限建议为 `ask` | 创建待决请求 | 触发 | 不能默认当作 `allow` |
| QGIS 参数检查失败 | 记录 stderr 和参数摘要，优先修正后重试 | 自动修正会改变数据或需要业务判断 | 不能无条件重复执行 |
| 同一输入连续失败 | 熔断或转人工 | 达到重复失败阈值且存在恢复方案 | 不能无限循环重试 |
| 工具超时 | 标记 `timed_out`，按 interrupt policy 取消或继续观察 | 需要用户决定是否继续等待或取消 | 不能立即重复启动 |
| 用户取消 | 发送取消信号并记录结果 | 通常不需要 HITL | 不能丢失取消前的记录 |
| 结果文件缺失 | 检查 ArtifactRegistry，等待、恢复或失败 | 需要用户选择重新生成或替代文件 | 不能让后续 `read` 无限重试 |
| 重复工具调用 | 识别相同输入，复用结果或阻止 | Agent 仍要求重复执行且可能产生副作用 | 不能只依赖模型自行判断 |

这里的“触发 HITL”表示向 `HumanInteractionBroker` 提交结构化请求，而不是
由工具直接显示提示。Broker 负责等待、超时、取消和返回决定；CLI 只是 Broker
的一种交互适配器，未来也可以替换为 Web、API 或批处理策略。

### 22.4 统一的异常决策接口

建议 Harness 提供独立的异常决策器：

```ts
interface ExecutionRecoveryPolicy {
  decide(input: {
    event: ToolExecutionEvent;
    current: ToolExecutionRecord;
    history: ToolExecutionRecord[];
    context: HarnessRuntimeContext;
  }): Promise<RecoveryDecision>;
}

type RecoveryDecision =
  | { action: "continue"; reason: string }
  | { action: "retry"; input?: unknown; reason: string }
  | { action: "wait"; reason: string }
  | { action: "ask_human"; request: HumanInteractionRequestInput }
  | { action: "fallback"; toolName?: string; reason: string }
  | { action: "abort"; reason: string };
```

该接口由 AgentLoop 在当前工具批次结束边界调用，具体策略由 Harness 提供。
工具只负责产生领域错误和工具级建议。这样：

- 参数校验失败、QGIS 进程失败、权限拒绝、超时和重复执行可以使用同一套
  决策模型；
- HITL 的触发阈值、默认选项和超时策略可以集中配置；
- 主 Agent、子 Agent、CLI 和未来 Web 界面可以共享同一个 Broker；
- 所有人工决定都能与对应的 `executionId` 关联，形成可追溯记录；
- 失败恢复不会散落在 `read`、`write`、QGIS 工具和 AgentLoop 中。

### 22.5 与工具定义的关系

工具定义只声明事实和局部规则：

```ts
{
  isDestructive: true,
  isConcurrencySafe: false,
  interruptBehavior: "cancel",
  validateInput,
  checkPermissions,
  execute,
}
```

Harness 负责把这些声明与运行时事实结合：

```text
工具声明
  + 当前输入
  + Sandbox 检查结果
  + 项目权限规则
  + 历史执行记录
  + 当前错误 / 超时 / 取消事件
  -> RecoveryPolicy
  -> 自动处理或条件触发 HITL
```

这才是工具定义与 Harness 解耦的边界：工具不负责整个异常流程，
Harness 也不需要了解每个工具的业务实现细节。

## 23. AgentLoop 中的事件驱动异常处理位置

### 23.1 推荐的轮次结构

`AgentLoop` 是一次用户请求的总协调器。每一轮不是简单的
“请求模型 -> 执行工具”，而是一个有明确边界的状态收敛过程：

```text
while (true) {
  A. 读取上一轮已经收敛的执行状态
  B. 获取当前可见 messages
  C. 执行工具结果预算裁剪、历史剪枝和上下文压缩
  D. 拼接动态 System Prompt 和可用工具定义
  E. 调用模型并流式收集 thinking / text / tool calls
  F. 没有 tool calls -> 进入最终回答
  G. 有 tool calls -> StreamingToolExecutor 执行当前批次
  H. 收集工具结果、日志、产物和异常事件
  I. 在当前工具批次结束边界调用 Harness 恢复策略，更新状态
  J. 将 assistant tool calls 和 tool results 写入 messages
  K. 根据决策继续下一轮、等待、重试、最终回答或终止
}
```

关键边界是：

```text
工具执行期间：
  Executor 产生事实和事件

当前轮工具批次结束后：
  AgentLoop 调用 Harness 收敛异常和恢复决策

下一轮开始：
  AgentLoop 使用更新后的 messages 做上下文投影和压缩
```

因此，“处理工具异常”并不是下一轮一开始才被动检查，而是在当前轮工具批次
结束时先完成事实收集和恢复决策；下一轮开始主要负责消费已经收敛的状态，
重新生成模型可见上下文。也不能让 `StreamingToolExecutor` 自己启动下一轮
模型请求。更准确的实现是：

```text
工具异常在当前轮结束时产生
  -> AgentLoop 接收执行结果
  -> Harness 归一化和决策
  -> AgentLoop 将 tool result / error result 写入 messages
  -> AgentLoop 更新 state
  -> continue 回到下一轮开头
```

工具错误通常仍然需要作为与对应 `tool_call_id` 匹配的 `tool result` 写入
messages，让模型知道工具没有成功以及失败原因。恢复决策不应简单地丢弃该
结果；只有在明确的请求重试、模型 fallback 或流式请求回滚场景下，才可以由
AgentLoop 按协议清理未完成的 assistant/tool 消息。

### 23.2 与 Claude Code `query.ts` 的对应关系

Claude Code 的 `E:\Claude\Claude-Code2-main\src\query.ts` 可以对应为：

| Claude Code `query.ts` 位置 | 作用 | CityBrain 对应位置 |
| --- | --- | --- |
| `while (true)`，约第 307 行 | Agent 主循环和轮次状态读取 | `src/agent/agent-loop.ts` 的 `while (true)` |
| `messagesForQuery`，约第 365 行 | 获取当前轮可见消息 | `conversationMessages` 和 Context Projection |
| tool result budget / snip / microcompact / collapse / autocompact，约第 379-468 行 | 请求模型前的上下文处理 | `projectContextMessages`、`compressContextMessages` |
| `callModel` 流式循环，约第 659 行 | 调用模型并收集 assistant/tool use | `streamModelChat` 流式循环 |
| `StreamingToolExecutor` 添加和消费结果，约第 838-864 行、1363-1409 行 | 工具执行和结果收集 | `StreamingToolExecutor` |
| 流式/API错误捕获，约第 893-999 行 | fallback、缺失 tool result、模型错误 | AgentLoop 当前轮错误边界 |
| prompt-too-long、max-output recovery，约第 1062-1357 行 | 当前请求结束后的恢复和重试 | AgentLoop 调用 Harness RecoveryPolicy |
| tool result 写入并递归下一轮，约第 1585-1719 行 | 追加结果、检查终止、进入下一轮 | `conversationMessages` 更新后回到 `while` 开头 |

该对应关系说明：Claude Code 的恢复逻辑并不是放在具体工具内部，
而是放在 `query.ts` 这个总循环中，围绕一次模型请求和一次工具批次进行
收敛。工具执行器是被总循环调用的子系统。

### 23.3 当前项目的落地边界

当前 `AgentLoop` 已经具备以下主循环结构：

```text
agent-loop.ts:252
  -> system prompt
  -> context projection / compression
  -> streamModelChat
  -> executeToolTurn
  -> append tool messages
  -> continue while
```

下一步完善时，应在工具批次完成后、结果正式写回下一轮可见
`conversationMessages` 之前，增加统一的事件收敛入口。该入口属于
AgentLoop 当前轮的收尾阶段，例如：

```ts
const outcomes = yield* this.executeToolTurn(
  resolvedToolCalls,
  runId,
  turn,
  options.signal,
);

const executionEvents = collectExecutionEvents(outcomes);
const boundary = await harness.reconcileToolTurn({
  runId,
  turn,
  toolCalls: resolvedToolCalls,
  outcomes,
  events: executionEvents,
  history: toolHistory,
  signal: options.signal,
});

// AgentLoop 根据 boundary 处理结果消息、更新 state，
// 再决定继续、重试、等待、最终回答或终止
```

该入口的职责不是再次执行工具，也不是重新调用模型，而是：

- 读取本轮工具执行记录；
- 将异常统一转换成 HarnessError；
- 判断是否存在可安全自动恢复的路径；
- 必要时调用 HumanInteractionBroker；
- 更新 Harness 状态机；
- 返回 AgentLoop 可以理解的轮次决策。

AgentLoop 随后负责：

1. 为每一个 tool call 生成匹配的 tool result，包括成功结果和结构化错误；
2. 按照工具调用顺序写入 `conversationMessages` 和 Session；
3. 根据 `TurnBoundaryDecision` 更新当前轮状态；
4. 在允许继续时回到下一轮开头；
5. 在下一轮重新执行上下文投影、压缩和动态 Prompt 组装。

### 23.4 三类异常边界

为了避免把所有错误都归入工具执行异常，AgentLoop 应区分三个边界：

| 异常边界 | 典型问题 | 处理位置 | 是否写入 tool result |
| --- | --- | --- | --- |
| 请求准备异常 | 上下文压缩失败、System Prompt 组装失败、上下文超限 | 当前轮模型调用前，由 AgentLoop/Harness 处理 | 否，除非已经存在未完成 tool call |
| 模型流式异常 | API 失败、fallback、响应中断、模型返回不完整 tool call | 当前轮模型请求的异常边界 | 仅对已经产生的 tool call 补齐错误结果 |
| 工具批次异常 | 参数错误、权限拒绝、QGIS 失败、超时、产物缺失、重复失败 | 当前轮工具批次结束后的 `reconcileToolTurn` | 是，必须与 `tool_call_id` 匹配 |

对应 Claude Code `query.ts` 的结构是：

```text
每轮开始：
  messagesForQuery + compact / microcompact / collapse

模型请求阶段：
  callModel + streaming error / fallback recovery

工具结果阶段：
  StreamingToolExecutor.getRemainingResults()
  -> 收集 tool results
  -> 处理 abort / stop / recovery
  -> 追加 messages
  -> 递归或 continue 到下一轮
```

因此，QGIS 执行失败不应直接让 `AgentLoop` 的最外层 `catch` 终止整个请求。
它首先应成为一个带有 `tool_call_id` 的失败工具结果，并由 Harness 返回
`retry`、`wait`、`ask_human`、`fallback` 或 `abort` 等轮次决策。只有
AgentLoop 根据该决策确认本次请求不能继续时，才进入最终失败或终止状态。

### 23.5 不能采用的结构

以下结构不符合本方案：

```text
ToolRegistry.execute()
  -> 捕获异常
  -> 自动调用模型
  -> 自动重试整个 AgentLoop
```

```text
StreamingToolExecutor
  -> 执行工具
  -> 修改 conversationMessages
  -> 决定是否结束 AgentLoop
```

```text
HumanInteractionBroker
  -> 直接控制 AgentLoop
  -> 直接拼接下一轮模型请求
```

正确的依赖方向是：

```text
ToolSpec
  -> 产生领域结果和执行事实
StreamingToolExecutor
  -> 调度并发布工具事件
Harness
  -> 归一化、审计、恢复策略和条件 HITL
AgentLoop
  -> 控制 messages、模型调用、轮次和最终状态
CLI
  -> 展示 AgentLoop 发布的事件
```
