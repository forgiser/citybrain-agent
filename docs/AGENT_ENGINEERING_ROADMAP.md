# CityBrain Agent 工程化增强路线

## 1. 文档目标

本文用于规划 CityBrain 后续面向“大模型应用 / 智能体开发”岗位的工程化增强方向。重点不是继续堆叠地图按钮或 QGIS 算法，而是把项目建设成一套可评测、可观测、可恢复、可复现、可治理的空间智能体运行时。

文档中的能力分为两类：

- **当前能力**：代码中已经存在并经过验证，可以写入简历。
- **规划能力**：尚未完成，只能作为后续路线，完成验收后才能写成个人贡献。

## 2. 当前项目基础

CityBrain 已经具备以下基础：

- CLI 与 Web UI 共享同一套 UI-neutral Agent Runtime。
- 根据 Host Profile 动态组装工具、System Prompt 和运行时上下文。
- 通过 QGIS 元工具发现、描述和执行空间处理算法。
- 支持文件沙箱、工具生命周期、动态 HITL 和结构化错误。
- 耗时工具超过一分钟后可以把同一执行实例移交后台托管。
- Web 模式支持地图状态感知、图层管理、矢量/栅格/DEM 可视化和三维场景。
- 支持增量工作区数据画像和 Agent 可读的 `profile.md`。
- 支持 Run、模型、上下文、工具、后台任务、HITL、产物和错误的全链路观测。
- 支持 npm 安装和 CLI/Web 两种启动方式。

这些能力已经形成完整 Agent 应用闭环。下一阶段应优先提高可验证性和可靠性，而不是无限扩展工具数量。

## 3. 总体建设目标

目标架构：

```text
用户请求
   ↓
Host Profile 与上下文组装
   ↓
模型规划与工具选择
   ↓
Tool Harness / Policy / HITL
   ↓
持久化任务与 GIS 执行
   ↓
地图、文件和分析产物
   ↓
Workflow DAG 与数据血缘
   ↓
Observability / Eval / Regression
```

最终希望项目具备以下工程属性：

| 属性 | 目标 |
| --- | --- |
| 可评测 | 能用真实任务集量化 Agent 是否完成目标 |
| 可复现 | 一次成功分析可以沉淀为可再次执行的工作流 |
| 可恢复 | 长任务在进程异常后可以识别、恢复或安全终止 |
| 可观测 | 可以关联模型、上下文、工具、任务和最终结果 |
| 可治理 | 工具执行受到权限、预算、HITL 和审计约束 |
| 可扩展 | 新模型、工具和 MCP 服务可以受控接入 |

## 4. 优先级路线

| 优先级 | 能力 | 简历价值 | 实现成本 | 建议 |
| --- | --- | --- | --- | --- |
| P0 | Agent Eval 与 GIS Benchmark | 极高 | 中 | 首先实现 |
| P0 | 可复现 Workflow DAG | 极高 | 高 | 第二阶段核心 |
| P0 | 持久化任务与故障恢复 | 高 | 高 | 生产化关键 |
| P1 | 模型路由、降级和预算控制 | 高 | 中 | 在 Eval 后实现 |
| P1 | Tool Policy 安全治理 | 高 | 中 | 强化现有 Sandbox/HITL |
| P1 | 空间数据目录与 Geo-RAG | 高 | 中高 | 复用数据画像基础 |
| P2 | MCP 插件化接入 | 中高 | 中 | 在工具治理后实现 |
| P2 | OpenTelemetry 导出 | 中 | 中 | 扩展现有观测能力 |

## 5. P0：Agent Eval 与 GIS Benchmark

### 5.1 目标

建立可重复执行的 Agent 评测框架，用数据回答以下问题：

- Agent 是否真正完成任务？
- 是否选择了正确工具和参数？
- 模型升级或 Prompt 修改是否导致能力退化？
- 多调用几次工具是否真的提高了成功率？
- 哪个模型在效果、时延和成本之间更合适？

### 5.2 建议目录

```text
src/eval/
├─ eval-types.ts
├─ eval-runner.ts
├─ evaluators/
│  ├─ artifact-evaluator.ts
│  ├─ tool-trace-evaluator.ts
│  ├─ map-state-evaluator.ts
│  └─ safety-evaluator.ts
└─ reporters/
   ├─ markdown-reporter.ts
   └─ json-reporter.ts

evals/
├─ cases/
│  ├─ vector/
│  ├─ raster/
│  ├─ map/
│  ├─ hitl/
│  └─ safety/
└─ fixtures/
```

### 5.3 用例格式

```yaml
id: vector-buffer-001
name: 河流缓冲区分析
prompt: 为 rivers.geojson 创建 100 米缓冲区并保存结果
workspace: fixtures/vector-buffer
expect:
  requiredTools:
    - run_qgis_algorithm
  outputFiles:
    - pattern: "*.geojson"
  geometryType: Polygon
  crs: EPSG:4326
  maxToolCalls: 8
  requireNoSandboxViolation: true
```

### 5.4 评测维度

| 维度 | 指标示例 |
| --- | --- |
| 任务完成 | 结果文件存在、格式正确、要素数量符合预期 |
| 工具选择 | 必需工具是否调用、是否调用无关工具 |
| 参数质量 | CRS、字段、路径、距离和输出格式是否正确 |
| 地图一致性 | 图层是否真实存在于浏览器上报状态 |
| HITL | 信息不足或高风险时是否正确请求用户决策 |
| 安全性 | 是否越过工作区、覆盖文件或绕过确认 |
| 效率 | 模型轮数、工具次数、运行耗时 |
| 成本 | 输入、输出、缓存 Token 和估算费用 |
| 恢复能力 | 工具失败后是否选择合理恢复方案 |

### 5.5 首批基准任务

建议首先建设 20～30 个稳定用例：

1. 文件读取与字段识别。
2. CRS 检查和重投影。
3. Shapefile/GPKG 转 GeoJSON。
4. 缓冲区、裁剪、相交和空间连接。
5. 河流宽度分级制图。
6. 分类字段唯一值制图。
7. GeoTIFF 灰度、色带和 RGB 渲染。
8. DEM 阴影和三维地形。
9. GLB 或 3D Tiles 场景加载。
10. 不明确需求触发方案选择 HITL。
11. 危险覆盖操作触发确认。
12. 工具异常后的恢复与重试。

### 5.6 验收标准

- 同一个用例可以重复执行，不依赖人工观察判断结果。
- 输出 JSON 和 Markdown 两种报告。
- 支持按模型、Prompt 版本和代码版本比较结果。
- CI 中可执行不依赖在线地图的核心用例。
- Web 地图用例提供单独的浏览器集成测试分组。
- 至少能够输出成功率、工具准确率、平均调用次数、P95 耗时和 Token。

## 6. P0：可复现 Workflow DAG

### 6.1 目标

把一次动态工具调用链沉淀为可复用空间分析工作流，使 Agent 的结果不只存在于对话中。

```text
输入数据 → CRS 检查 → 重投影 → 缓冲区 → 空间相交 → 汇总 → 可视化
```

### 6.2 核心模型

```ts
interface WorkflowDefinition {
  id: string;
  version: number;
  name: string;
  inputs: WorkflowInput[];
  nodes: WorkflowNode[];
  outputs: WorkflowOutput[];
}

interface WorkflowNode {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  dependencies: string[];
  cachePolicy: "never" | "by-input-fingerprint";
  retryPolicy?: { maximumAttempts: number };
  requiresApproval?: boolean;
}
```

### 6.3 需要实现的能力

- 从已完成 Run 的工具链生成 Workflow 草稿。
- 记录输入、输出、参数和节点依赖。
- 使用文件指纹判断缓存是否可复用。
- 修改一个参数后只重新运行受影响节点。
- 支持节点级失败重试和断点续跑。
- 记录每个输出的数据血缘。
- Web UI 展示 DAG、节点状态和产物。
- 支持导出 JSON/YAML，后续可考虑导出 QGIS Model。

### 6.4 边界

- 不是所有对话都需要生成 Workflow。
- 纯读取、解释和临时地图浏览可以不沉淀。
- 包含不可重放外部副作用的工具必须明确标记。
- HITL 决策应保存结果，但敏感自由文本需要脱敏。

### 6.5 验收标准

- 一个至少包含三个处理节点的工作流可以重新执行。
- 相同输入第二次执行能够命中缓存。
- 中间节点失败后可以从失败位置继续。
- 可以追踪最终文件来自哪些输入和处理步骤。
- Workflow 执行仍然经过现有 Tool Harness、Sandbox、HITL 和观测链路。

## 7. P0：持久化任务与故障恢复

### 7.1 当前问题

现有 TaskManager 可以托管运行时内的长工具，但普通任务状态主要保存在内存中。进程退出后，Node.js Promise 和 QGIS 子进程句柄不能自动恢复。

### 7.2 建议方案

引入 SQLite TaskStore：

```text
TaskManager
   ↓
PersistentTaskStore
   ├─ tasks
   ├─ task_events
   ├─ task_leases
   └─ task_artifacts
```

任务增加：

- `idempotencyKey`
- `ownerRunId`
- `workspaceId`
- `attempt`
- `leaseOwner`
- `leaseExpiresAt`
- `heartbeatAt`
- `recoverability`
- `checkpoint`

### 7.3 恢复策略

| 任务类型 | 重启后处理 |
| --- | --- |
| 尚未开始的排队任务 | 重新入队 |
| 支持检查点的内部任务 | 从 checkpoint 恢复 |
| 可安全重放的幂等工具 | 创建新 attempt |
| 无法恢复的外部进程 | 标记为 `orphaned` 并请求用户决策 |
| 已产生完整产物但未确认完成 | 校验产物后补偿为 completed |

### 7.4 验收标准

- 强制终止进程后，任务记录不会消失。
- 重启时不会重复提交相同幂等任务。
- 无法恢复的任务不会被错误标记为成功。
- 产物先写临时路径，成功后原子提交。
- Web UI 能查看历史任务、attempt 和恢复原因。

## 8. P1：模型路由、降级与预算控制

### 8.1 路由依据

- 任务复杂度。
- 是否需要强推理。
- 上下文长度。
- 工具调用历史成功率。
- 延迟和费用预算。
- 服务商健康状态。

### 8.2 建议策略

```text
简单查询/摘要       → 快速低成本模型
复杂 GIS 方案设计   → 推理模型
参数修复/格式转换   → 小模型
主服务商失败        → 备用服务商
预算即将耗尽        → HITL 或降级
```

### 8.3 验收标准

- 单个 Run 可以设置 Token、费用、时间和工具调用预算。
- 路由结果及原因进入观测日志。
- 服务商异常时只对可安全重试的请求执行降级。
- Eval 报告能比较模型组合的成功率、成本和延迟。

## 9. P1：Tool Policy 安全治理

### 9.1 目标

把当前分散在 Sandbox、工具元数据和 HITL 中的安全判断统一为声明式策略。

```yaml
tool: run_qgis_algorithm
when:
  overwritesExistingFile: true
decision: ask

---
tool: read_file
when:
  pathInsideWorkspace: true
decision: allow
```

### 9.2 决策结果

- `allow`：直接执行。
- `deny`：拒绝并返回结构化原因。
- `ask`：创建 HITL 请求。
- `dry-run`：先生成影响预览。

### 9.3 验收标准

- 文件、QGIS、网络、地图和外部进程可以使用不同策略。
- 策略决策进入审计日志。
- 会话临时授权不会自动变成永久授权。
- 工具不能绕过 Policy Engine 直接访问受控资源。

## 10. P1：空间数据目录与 Geo-RAG

### 10.1 基础

复用现有增量数据画像，而不是重新扫描工作区：

```text
.internal/profiles/datasets/*.json
        ↓
语义描述 + 字段 + CRS + 空间范围 + 时间范围
        ↓
关键词索引 / 向量索引 / 空间索引
        ↓
Geo-RAG 检索
```

### 10.2 混合检索

排序可以综合：

- 文本或向量相似度。
- 包围盒相交关系。
- 时间范围。
- CRS 兼容性。
- 字段匹配。
- 数据质量和更新时间。
- 数据血缘可信度。

### 10.3 验收标准

- 能根据自然语言查询合适的数据集。
- 返回结果必须包含来源、匹配原因和元数据证据。
- 文件变化后只更新对应索引项。
- 不把完整大文件直接写入向量数据库或 Prompt。

## 11. P2：MCP 插件化接入

MCP 工具不能绕开现有执行体系。正确链路应为：

```text
MCP Server
   ↓ 工具发现
ToolSpec Adapter
   ↓
参数校验
   ↓
Policy / Sandbox / HITL
   ↓
超时、取消与后台托管
   ↓
结果压缩与观测
```

需要支持：

- MCP Server 配置、启用、停用和连通性检查。
- 工具 Schema 转换和名称冲突处理。
- 按 Host Profile 控制可见性。
- 外部结果大小限制和敏感字段脱敏。
- Web 设置页管理 MCP 服务。

## 12. P2：OpenTelemetry 与诊断导出

在现有本地观测服务上增加标准 Trace 导出：

```text
Agent Run Span
├─ Context Build Span
├─ Model Request Span
├─ Tool Call Span
│  └─ Background Task Span
├─ HITL Span
└─ Map Command Span
```

建议增加：

- 首 Token 延迟和生成速度。
- Prompt 版本、模型路由原因和预算使用。
- 工具失败分类和重试次数。
- Run 瀑布图。
- 一键导出脱敏诊断包。
- OTLP 可选导出，默认仍保持本地运行。

## 13. 不建议优先实现的方向

- 只为了数量继续增加模型服务商。
- 为每一个 QGIS 算法分别创建工具。
- 为地图显隐、透明度、删除分别创建小工具。
- 没有评测数据支撑的多智能体编排。
- 与空间数据无关的普通文档 RAG。
- 只接入框架名称而没有解决可靠性问题。
- 只增加 Web 页面动画和聊天样式。

多智能体只有在存在明确角色边界、隔离策略、成本预算和效果对照实验时才值得重新启用。否则单 Agent 加可靠工具链通常更容易解释和维护。

## 14. 推荐实施阶段

### 阶段一：建立评测闭环

- 完成 Eval 数据结构和 Runner。
- 建设首批 20～30 个 GIS 用例。
- 复用现有观测数据计算效率和成本指标。
- 输出 JSON/Markdown 报告。

完成标志：每次修改 Prompt、工具或模型后，可以明确判断能力提升还是退化。

### 阶段二：工作流沉淀

- 定义 Workflow DAG。
- 从成功 Run 生成工作流。
- 实现节点执行、缓存和数据血缘。
- 在 Web UI 展示工作流状态。

完成标志：一个自然语言分析任务可以保存、修改并再次执行。

### 阶段三：执行可靠性

- 引入持久化 TaskStore。
- 增加幂等键、租约、心跳和 attempt。
- 实现进程重启后的恢复和 orphaned 处理。

完成标志：长时间 QGIS 任务不会因为主进程异常而丢失真实状态。

### 阶段四：治理和扩展

- 实现模型路由和预算。
- 实现 Tool Policy。
- 建设 Geo-RAG。
- 在治理链路完成后接入 MCP。
- 可选导出 OpenTelemetry。

## 15. 简历表达模板

以下内容必须在对应功能真正完成后使用。

### 项目定位

> CityBrain 是面向空间数据处理与可视化的本地智能体运行时，支持 CLI/Web 双宿主、QGIS 工具执行、动态 HITL、长任务后台托管、地图状态交互和全链路观测，并围绕可评测、可恢复和可复现构建生产级 Agent 工程能力。

### Eval 完成后

> 设计 Agent 自动评测框架，基于真实 GIS 任务集评估任务成功率、工具选择、参数正确性、Token 成本和失败恢复能力，支持多模型对比与 Prompt/工具链回归检测。

### Workflow 完成后

> 将动态工具调用沉淀为可复现 Workflow DAG，支持节点依赖、输入指纹缓存、失败重试、断点续跑和数据血缘，使自然语言空间分析可以保存、修改和重复执行。

### 持久化任务完成后

> 实现持久化 Agent 任务调度器，通过幂等键、任务租约、心跳、attempt 和原子产物提交，解决长时间 QGIS 任务在进程退出和重复请求场景下的一致性问题。

### 模型路由完成后

> 构建基于任务复杂度、上下文长度、服务健康度和预算的多模型路由机制，支持服务商降级、成本限制及效果/延迟联合观测。

### Tool Policy 完成后

> 设计声明式 Tool Policy Engine，根据工具类型、路径、参数和副作用动态执行 allow/deny/ask/dry-run 决策，并结合 Sandbox、HITL 与审计日志完成工具安全治理。

## 16. 面试重点问题

### 为什么优先做 Eval，而不是继续增加工具？

没有评测时无法判断工具增加后是否提高成功率，也无法发现 Prompt、模型或 Schema 修改造成的回归。Eval 是后续模型路由、工作流优化和安全治理的数据基础。

### Workflow 和普通对话历史有什么区别？

对话历史用于继续交流，Workflow 描述可执行依赖、输入输出、参数和产物血缘。Workflow 能缓存、重试、恢复和复用，而对话日志不能可靠承担这些职责。

### 为什么 TaskManager 需要持久化？

内存 TaskManager 能解决当前进程中的并发、取消和后台托管，但无法跨进程恢复。空间分析可能运行数十分钟，因此必须区分可恢复、可重放和 orphaned 任务，并防止重复执行产生副作用。

### 为什么不直接引入多智能体？

多智能体会增加上下文复制、状态同步、循环委派和成本控制问题。只有 Eval 证明角色分工优于单 Agent，且存在明确隔离边界时才值得使用。

### Geo-RAG 与普通 RAG 有什么不同？

Geo-RAG 不只计算文本相似度，还需要考虑空间范围、CRS、时间、字段、分辨率、数据质量和血缘信息，最终返回可验证的数据来源，而不是只返回语义相似文档。

## 17. 最终建议

如果只完成一项：优先完成 **Agent Eval**。

如果完成两项：选择 **Agent Eval + Workflow DAG**。

如果希望把项目提升为接近生产级的 Agent 平台，应形成以下组合：

```text
Agent Eval
+ Workflow DAG
+ 持久化任务
+ 模型路由与预算
+ Tool Policy
+ 全链路观测
```

最终项目定位应从“可以调用 GIS 工具的聊天助手”提升为：

> 面向空间数据分析的可评测、可观测、可恢复、可复现、可治理的本地 Agent Runtime。
