# CityBrain 工具契约 Phase D 实施记录

> 状态：已完成（2026-09-20）

## 1. 目标

将工具执行前后的权限决策和生命周期扩展点正式纳入 Harness：

```text
PreToolUse
  -> PermissionCoordinator
  -> SandboxPolicy hard check
  -> ToolRuntime
  -> PostToolUse / PostToolUseFailure
```

## 2. 已实现内容

### 2.1 PermissionCoordinator

新增 `src/tools/permission-coordinator.ts`：

- `PermissionDecision` 支持 `allow`、`deny`、`ask`；
- SandboxPolicy 作为第一层硬边界；
- 支持工具自定义 `authorize`；
- 支持项目规则回调；
- 支持用户确认回调；
- 用户确认不能覆盖 Sandbox 拒绝；
- 没有用户确认器时，`ask` 保持为待确认状态，不自动放行。

### 2.2 工具 Hook

工具可以声明：

```ts
interface ToolHooks<Input, Output> {
  beforeExecute?: (input, context) => Promise<ToolHookResult>;
  afterExecute?: (result, context) => Promise<ToolHookResult>;
  onError?: (error, context) => Promise<ToolHookResult>;
}
```

支持：

- 修改规范化后的输入；
- 阻止执行；
- 追加模型上下文；
- 标记结果需要复核；
- 要求 AgentLoop 进入最终回答；
- 保存审计信息；
- 失败后的诊断和恢复信息。

`beforeExecute` 修改输入后会重新执行 Schema 校验、路径提取和
SandboxPolicy 检查。

### 2.3 文件和 QGIS 路径边界

工具契约新增：

```text
getReadPaths
getWritePaths
```

当前默认配置：

- `read_file`、`list_files`：只检查读路径；
- `write_file`、`edit_file`：只检查写路径；
- `run_qgis_algorithm`：检查输入读路径和输出写路径；
- QGIS 临时输出继续使用 SandboxPolicy 的临时目录策略。

### 2.4 生命周期和日志

新增并接入：

```text
pre_tool_hook
sandbox_check
policy_check
permission_decision
post_tool_hook
failure_hook
```

权限决策会记录：

```text
decisionAction
decisionSource
detail
```

所有生命周期事件同时进入 CLI 事件流和
`.internal/logs/tool-execution.jsonl`。

## 3. AgentLoop 行为

如果工具 Hook 返回 `preventContinuation: true`，工具结果会携带该状态，
AgentLoop 会在工具返回后进入 finalization，避免继续产生新的工具调用。

## 4. 验收

- `npm run typecheck` 通过；
- `npm run build` 通过；
- Sandbox 外部读写会在 handler 执行前被拒绝；
- PreToolUse 修改后的输入会重新校验；
- Hook 阻止执行时不会调用 handler；
- PostToolUse 和失败 Hook 的上下文会进入模型工具结果；
- Hook 请求停止后续流程时 AgentLoop 会进入 finalization。

## 5. 后续建议

Phase D 已形成基础 Harness 权限和 Hook 骨架。后续可以逐步补充：

- 基于 `AGENTS.md` 和 `workspace.json` 的项目规则解析；
- CLI 内的用户确认交互；
- 工具级输出 Schema 和 PostToolUse 输出验证；
- Hook 审计字段的独立日志索引；
- 失败工具的显式 retry policy。
