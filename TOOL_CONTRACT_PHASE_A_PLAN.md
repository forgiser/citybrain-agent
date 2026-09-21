# CityBrain 工具契约 Phase A 修改计划

> 状态：已完成（2026-09-20）

## 1. 目标

在不引入 Phase B 的统一 preflight、Phase D 的权限协调器和 Hook 执行之前，
先完成工具契约的元数据补全，让 `ToolRegistry`、`StreamingToolExecutor`、CLI
和工具日志使用同一份工具信息。

## 2. 本阶段范围

### 2.1 工具元数据

为工具注册增加以下可选字段：

- `aliases`：工具别名；
- `source`：`builtin`、`qgis`、`mcp`、`subagent`；
- `isReadOnly`：是否只读；
- `isDestructive`：是否具有覆盖、删除或其他破坏性副作用；
- `isConcurrencySafe`：是否允许与其他安全工具并发；
- `interruptBehavior`：`cancel` 或 `block`；
- `getPath`：提取工具涉及的路径；
- `getActivityDescription`：生成执行中的活动描述；
- `getToolUseSummary`：生成紧凑的工具调用摘要；
- `maxResultSizeChars`：限制进入模型上下文的工具结果大小。

### 2.2 注册表

- 保持现有 `register(definition, handler, options)` 调用兼容；
- 支持别名解析；
- 统一计算工具调用元数据；
- 未声明的安全属性采用保守默认值；
- 将结果大小限制应用在模型返回结果前。

### 2.3 StreamingToolExecutor

- 使用 Registry 提供的工具元数据判断并发；
- 把活动描述、调用摘要和工具元数据带入 `tool_started`；
- `cancel` 工具沿用当前 AbortSignal；
- `block` 工具完成前继续等待，不改变现有串行执行语义。

### 2.4 CLI 与日志

- CLI 优先使用工具自身的 activity/summary，无法提供时回退到当前通用解析；
- 工具执行日志记录来源、只读性、破坏性、并发性、中断策略和路径。

## 3. 不在本阶段实现

- `PermissionCoordinator`；
- `PreToolUse`、`PostToolUse`、`PostToolUseFailure` 的实际调度；
- Sandbox 权限判断重构；
- schema preflight 和 output schema 校验；
- QGIS 路径授权策略重构。

## 4. 验收标准

- `npm run typecheck` 通过；
- 当前文件、QGIS、子 Agent 工具仍可注册和调用；
- 已注册别名可以执行；
- 未声明工具默认不可并发、不可视为只读、使用 `block`；
- 工具开始事件能携带活动描述和摘要；
- `.internal/logs/tool-execution.jsonl` 的 start 事件包含 Phase A 元数据；
- 超过 `maxResultSizeChars` 的结果会被截断并明确标记。

## 5. 实施顺序

1. 新增工具元数据类型和安全解析辅助函数；
2. 改造 `ToolRegistry` 的注册、别名、元数据解析和结果限制；
3. 改造 `StreamingToolExecutor` 及其事件；
4. 为内置、QGIS、子 Agent 工具补齐元数据；
5. 修改 CLI 展示和执行日志；
6. 运行类型检查并修复兼容性问题。

## 6. 本次实际落地

- 新增 `src/tools/tool-contract.ts`，集中定义 Phase A 元数据和安全解析逻辑；
- `ToolRegistry` 支持别名、元数据解析、保守默认和结果大小限制；
- `StreamingToolExecutor` 使用工具元数据判断并发、中断行为，并向 CLI 事件传递摘要；
- 内置文件工具、QGIS 工具和子 Agent 工具补齐来源、读写属性、危险属性、
  并发策略、中断策略、路径和活动描述；
- `ToolExecutionLogger` 的 start/finish 事件记录工具来源、风险属性、路径、
  摘要和结果截断状态；
- CLI 优先使用工具自己的 activity/summary 展示；
- 已通过 `npm run typecheck` 和 `npm run build`。
