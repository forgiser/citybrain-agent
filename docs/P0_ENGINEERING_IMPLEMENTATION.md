# P0 工程能力：评测、工作流、持久化任务

本文对应 [工程路线图](AGENT_ENGINEERING_ROADMAP.md) 的三个 P0 项。以下内容区分**已实现机制**与**尚未验证的成绩**；22 个基准用例是测试定义，不代表模型已通过。

## 1. Agent Eval 与 GIS Benchmark

- `src/eval/` 提供用例加载、基于真实 Run 日志的离线评测、隔离工作区的在线执行、JSON/Markdown 报告与基线对比。
- `evals/cases/core.json` 包含 22 个用例，`evals/fixtures/core/` 提供小型矢量与 CSV 输入。CLI 在线执行默认跳过需要真人回答的 HITL 用例和必须有浏览器的 Web 地图用例；显式加 `--include-hitl` 才会执行 HITL。Web 用例需要在真实 Web 会话中运行后，通过 `--run-map` 回放评测。
- 检查项包括 Run 是否结束、必需/禁止工具、调用与 Token 上限、HITL、沙箱违规、产物存在性、GeoJSON 要素数/几何类型/字段/CRS、CSV/JSON 可读性，以及 Web 地图工具回执中的图层名称/数量。最后一项仍需浏览器集成测试确认视觉渲染，不把工具回执等同于像素级可见性。
- 指标包括成功率、工具调用、Token 和 P95 耗时；`--baseline` 报告新增退化/改善用例及指标变化。

```powershell
# 使用已保存的真实 Run 评测单个用例
npm run eval -- --cases evals/cases/core.json --case vector-inspect-001 --run-id <Agent-Run-ID> --project-dir <项目目录> --output evals/results/inspect

# 基于 caseId -> runId 的 JSON 映射批量评测
npm run eval -- --cases evals/cases/core.json --run-map path/to/run-map.json --output evals/results/baseline

# 使用已配置模型和 QGIS 在临时工作区运行非交互用例
npm run eval -- --cases evals/cases/core.json --execute --output evals/results/current --baseline evals/results/baseline.json
```

在线评测会先复制 fixture，不会修改仓库原件；每个用例结束后删除临时副本。模型调用需要用户本机配置和可能的 API 费用，仓库不会自动执行在线基准。`evals/results/` 应视为本机结果，不应把未运行的用例写成通过成绩。

CLI 交互界面支持 `/eval cases` 和 `/eval run <caseId> <Run ID>`；独立命令 `citybrain eval --help` 可查看批量、隔离执行和基线比较选项。Web UI 的“设置 → 运行与评估 → 评测”可对当前工作区的已有 Run 选择用例、查看逐项检查，并下载 JSON/Markdown 报告；不会在浏览器点击评测时重新调用模型。

## 2. 可复现 Workflow DAG

- 从同一工作区的 `tool-execution.jsonl` 按 Run ID 提取**成功且明确允许重放**的 `run_qgis_algorithm` 调用，不把读取、地图临时交互或任意副作用工具误判为可重放节点。
- 节点保存参数、输入/输出路径、依赖、重试上限和缓存策略。定义及最新执行检查点存于 `<工作区>/citybrain/.internal/workflows/` 的 JSON 文件。
- 节点按拓扑顺序执行，每一步仍经过原有 `ToolRegistry` 的校验、沙箱、权限/HITL 和工具日志。文件 SHA-256 指纹与已提交输出的指纹共同判定缓存；输入或参数改变时，受影响的节点会重新执行。
- 单文件 GeoJSON、GPKG、GeoTIFF、CSV、JSON 等输出先写同目录暂存文件，成功后改名提交；节点失败不会覆盖上一次已提交的单文件产物。多输出或 Shapefile 等伴随多个侧车文件的格式目前拒绝以此方式复跑，避免宣称不存在的原子性。
- 执行通过 `TaskManager` 后台托管。进程中断后，工作流任务凭已保存的节点检查点恢复；已提交且指纹仍匹配的节点跳过。若中断发生在某节点执行/提交的临界区，该节点保留 `running` 证据，自动恢复会停止并报错，要求先检查产物再手动重跑，避免不确定副作用被自动重复执行。

CLI 中可使用 `/workflow list`、`/workflow draft <Run ID>`、`/workflow show <ID>`、`/workflow run <ID>`、`/workflow status <ID>`；非交互命令为 `citybrain workflow <list|draft|show|run|status> [ID] --project-dir <目录>`，`run` 会等待后台任务到达终态后退出。Web UI 的“设置 → 运行与评估 → 工作流”支持创建、查看节点与执行状态、编辑参数及运行。变更输出路径时，如果下游仍引用旧路径，会拒绝保存并要求先修正下游输入。

## 3. 任务持久化与故障恢复

- 用户级 `tasks.sqlite` 保存任务快照与生命周期事件；任务带工作区、幂等键、恢复标识/负载、attempt、租约与心跳。CLI/Web 查询仍按当前工作区隔离。
- 重启发现非终态任务时，不会把失联的 Promise 或 QGIS 子进程伪装成成功；它们先进入 `orphaned`。只有注册了明确恢复处理器的工作流会进入下一次 attempt，且复用原任务 ID。一般工具任务不自动重放，防止重复外部副作用。
- Web UI 的“设置 → 后台任务”展示历史状态、尝试次数、进度、产物和孤儿原因。

## 验证与边界

```powershell
npm run check
npm run smoke:p0
npm run build:web
```

`smoke:p0` 在临时目录验证 SQLite 幂等/孤儿恢复、三节点 DAG 缓存与输入失效、失败节点不覆盖已有产物、中断节点不自动重放、以及记录式评测。此测试不调用真实模型或 QGIS。真实 QGIS 算法、模型质量、浏览器地图状态和 HITL 用户决策仍需分别在对应环境做集成/人工验收，不能由冒烟测试推断通过。

`.github/workflows/p0-check.yml` 在 GitHub Actions 中运行同一组离线检查；它不会调用付费模型或依赖本机 QGIS。
