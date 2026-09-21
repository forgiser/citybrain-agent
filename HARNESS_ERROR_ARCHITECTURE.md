# Harness 异常处理骨架

## 目标

Citybrain 的异常处理采用统一 Harness 入口，将不同层级的错误转换为结构化事件，再由状态机和恢复策略决定下一步动作。工具负责报告事实，AgentLoop 负责推进任务状态，CLI 负责展示，不让某一层直接吞掉错误或自行决定整个会话的生命周期。

## 分层

| 层级 | 负责内容 | 典型异常 |
| --- | --- | --- |
| 用户与交互层 | 输入、取消、CLI 展示、人工确认 | 空输入、用户中断、需要授权 |
| Agent 循环层 | 轮次、工具批次、终止条件、最终回答 | 工具后无最终回答、重复调用、状态越迁 |
| API 与模型层 | 请求、流式响应、上下文预算 | provider 错误、超时、响应格式异常 |
| 工具层 | 参数、Hook、权限、沙箱、工具进程 | 参数错误、权限拒绝、QGIS 失败、输出缺失 |
| 系统与运行时层 | 文件系统、进程、网络、持久化 | 文件不存在、进程退出、日志写入失败 |

这些层级共享同一个 `HarnessError`、`HarnessStateMachine` 和 `RecoveryPolicy`。错误发生的位置通过 `layer`、`phase`、`scope` 标记，恢复动作通过 `recovery` 和 `HarnessRecoveryDecision` 标记。

## 当前骨架

- `src/harness/harness-types.ts`：统一错误、状态、恢复决策和事件类型。
- `src/harness/harness-error.ts`：将 `unknown` 错误归一化为 `HarnessError`。
- `src/harness/harness-state-machine.ts`：限制任务状态的合法迁移。
- `src/harness/recovery-policy.ts`：根据错误类型选择重试、等待、修复输入、询问用户或终止。
- `src/harness/harness-controller.ts`：串联状态机、错误上报、恢复决策和事件发布。
- `src/harness/human-interaction.ts`：跨层复用的人工介入 Broker，管理请求、决策、超时和取消。
- `src/app/cli-human-interaction.ts`：CLI 交互适配器，不让业务层依赖 TUI。
- `src/tools/tool-execution-log.ts`：将工具生命周期、Harness 错误和状态写入 `.internal/logs/tool-execution.jsonl`。
- `src/tools/streaming-tool-executor.ts`：把工具级 Harness 错误作为流式事件向上游传递。
- `src/agent/agent-loop.ts`：接入运行级 Harness 状态和运行级错误事件。
- `src/app/interactive-app.ts`：以可见状态展示 Harness 错误，保留工具结果的成功/失败配色。

## 最小运行流程

```text
idle
  -> planning
  -> executing
  -> waiting_for_human
  -> resuming
  -> executing
  -> finalizing
  -> completed
```

出现异常时：

```text
当前状态
  -> HarnessController.report()
  -> HarnessError + RecoveryDecision
  -> recovering / failed / aborted
```

工具层失败不会直接让整个 CLI 崩溃。工具返回结构化失败结果并附带 `harnessError`，模型仍可根据错误上下文修复参数或进入最终回答边界；只有 AgentLoop、模型请求或运行时出现无法继续的异常时，才由运行级 Harness 决定终止。

## 日志约定

工具日志仍然使用 JSONL，一次工具执行至少包含：

1. `start`：调用参数、工具元数据和关联的 `runId/turn/toolCallId/taskId`。
2. `lifecycle`：校验、Hook、沙箱、权限、启动、完成或失败。
3. `harness_error`：结构化错误码、错误层级、错误范围和建议恢复动作。
4. `finish`：最终结果、耗时、状态和结果截断信息。

人工介入请求使用同一份 Broker 生命周期记录：

```text
created -> pending -> resolved / expired / cancelled
```

权限和文件编辑确认已经接入 CLI Broker。沙箱边界仍然属于硬约束，越过沙箱的请求会直接拒绝，不会通过人工确认绕过安全边界。

后续可在不改变工具接口的前提下增加模型请求级错误、上下文压缩失败恢复、QGIS 长任务等待、用户确认后的权限恢复，以及运行级重试预算和熔断指标。
