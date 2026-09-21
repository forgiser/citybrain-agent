# CityBrain 工具契约 Phase B 实施计划

> 状态：已完成（2026-09-20）

## 1. 目标

将工具执行前的基础检查从各个 handler 中抽离，形成统一的 preflight
入口，确保非法参数不会进入文件、QGIS 或子 Agent 的实际执行逻辑。

## 2. 已实现的执行顺序

```text
parse
  -> tool_resolved
  -> schema validate
  -> normalize input
  -> normalized schema validate
  -> tool-specific validateInput
  -> final schema validate
  -> artifact preflight
  -> queue
  -> execute
```

当前 `PermissionCoordinator`、SandboxPolicy 的统一硬检查和 Hook 调度仍然
保留在后续阶段；现有文件/QGIS handler 内部的 sandbox 检查继续作为运行时
最后一道保护。

## 3. 本阶段改动

### 3.1 Schema preflight

新增 `src/tools/tool-preflight.ts`，支持当前内置工具使用的 JSON Schema 子集：

- `object`、`array`、`string`、`number`、`integer`、`boolean`、`null`；
- 多类型 `type`；
- `required`；
- `properties`；
- `additionalProperties`；
- `items`；
- `enum`；
- `minLength`；
- `minimum` / `maximum`。

### 3.2 输入规范化和工具级校验

工具注册可以声明：

```ts
normalizeInput?: (input, context) => unknown | Promise<unknown>;
validateInput?: (input, context) => ToolValidationResult | Promise<ToolValidationResult>;
```

规范化和工具级校验后会再次执行 Schema 校验，防止规范化逻辑产生非法
输入。

### 3.3 生命周期事件

执行器和 CLI 可以观察以下阶段：

```text
tool_queued
tool_resolved
tool_validating
tool_normalizing
tool_normalized
tool_artifact_preflight
tool_started
tool_completed
tool_failed
```

生命周期事件同时写入工具执行日志，失败时可以区分：

- JSON 解析失败；
- 未知工具；
- Schema 参数错误；
- 输入规范化失败；
- 工具级校验失败；
- 产物预登记失败；
- handler 运行失败。

## 4. 验收结果

- `npm run typecheck` 通过；
- `npm run build` 通过；
- 非法参数在 handler 执行前被拒绝；
- 合法工具调用会产生完整的 preflight 生命周期事件；
- 现有工具注册方式保持兼容；
- 没有在本阶段引入第二套权限协议或 Hook 协议。

## 5. 后续边界

下一步进入 Phase C 时，重点是把当前字符串结果升级为结构化
`ToolExecutionResult`、`ToolError`、`ArtifactResult` 和
`ToolResultPayload`，再由 Phase D 接入 `PermissionCoordinator` 与
Pre/Post Tool Hook。
