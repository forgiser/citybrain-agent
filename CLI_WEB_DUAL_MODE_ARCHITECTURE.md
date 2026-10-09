# Geo-agent CLI / Web UI 双模式架构与落地方案

> 文档状态：设计方案，尚未实施  
> 适用项目：`E:\Geo-agent`（npm 包名与 CLI 命令名为 `citybrain`）  
> 编写日期：2026-10-09

## 1. 目标

Geo-agent 需要同时支持两种交互方式：

1. **CLI 模式**：保留当前基于 `@earendil-works/pi-tui` 的终端交互体验。
2. **Web UI 模式**：启动本地 Web 服务，在浏览器中提供完整的 Agent 对话、工具状态、后台任务、人工确认和地图可视化能力。

用户执行 `npm run dev` 或 `npm start` 时，可以交互选择运行模式；自动化场景则可以通过命令行参数直接指定模式。

本方案的核心不是维护两套 Agent，而是将项目重构为：

```text
一个 Agent Runtime
    ├── CLI Adapter
    └── Web Adapter
```

Agent、工具、会话、后台任务、权限和 QGIS 能力只实现一次，CLI 与 Web UI 只是不同的输入输出适配器。

## 2. 当前项目基础

项目已经具备实现双模式架构的大部分核心能力：

| 当前能力 | 现有位置 | 对双模式架构的价值 |
| --- | --- | --- |
| Agent 流式事件 | `src/agent/agent-loop.ts` | `AgentLoop.run()` 返回 `AsyncGenerator<AgentEvent>`，可以同时被 CLI 和 Web 事件流消费 |
| CLI 应用 | `src/app/interactive-app.ts` | 可以保留现有 TUI，但需要拆出其中的运行时组装逻辑 |
| 工具注册与执行 | `src/tools/core/` | 与界面无关，可以由统一 Runtime 创建和持有 |
| 后台任务 | `src/task/` | `TaskManager` 已支持提交、进度、取消、超时、订阅和等待 |
| 人工交互 | `src/harness/human-interaction.ts` | `HumanInteractionBroker` 已是传输无关设计，并已预留 `web` 决策来源 |
| 会话管理 | `src/session/` | 可供两种模式共用，但 Web 模式下需要明确会话与 Run 的对应关系 |
| 制品登记 | `src/tools/core/artifacts/artifact-registry.ts` | 已能记录任务输出路径，需要扩展为适合 Web 和地图使用的制品描述 |
| QGIS 集成 | `src/integrations/qgis/` | 可继续作为 Runtime 内部的空间处理基础设施 |

当前主要问题是 `src/app/interactive-app.ts` 同时负责：

- 创建模型、会话、工具、TaskManager 和 QGIS Runtime；
- 创建 `AgentLoop`；
- 处理 CLI 输入；
- 消费 Agent 事件并渲染 TUI；
- 处理人工确认和会话命令。

因此，Web UI 落地前的首要工作是把“Agent 运行时组装”从“CLI 展示”中抽离。

## 3. 总体架构

```text
                         npm run dev / npm start
                                    │
                           ┌────────▼────────┐
                           │  Mode Launcher  │
                           │ CLI / Web 选择器 │
                           └────────┬────────┘
                                    │
                      ┌─────────────▼─────────────┐
                      │      Agent Runtime        │
                      │                           │
                      │ AgentLoop                 │
                      │ ToolRegistry              │
                      │ StreamingToolExecutor     │
                      │ TaskManager               │
                      │ SessionManager            │
                      │ HumanInteractionBroker    │
                      │ ArtifactService           │
                      │ QGIS Runtime              │
                      └───────────┬───────┬───────┘
                                  │       │
                         ┌────────▼─┐   ┌─▼─────────────┐
                         │ CLI      │   │ Local Web     │
                         │ Adapter  │   │ Server        │
                         └──────────┘   └──────┬────────┘
                                              │ HTTP + SSE
                                    ┌─────────▼─────────┐
                                    │ React Web UI      │
                                    │ Chat / Task / Map │
                                    └───────────────────┘
```

### 3.1 职责边界

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Agent Runtime | 依赖组装、Agent 执行、会话、工具、任务、制品、人工交互 | 终端组件、HTTP、浏览器组件 |
| CLI Adapter | 读取终端输入、渲染 `AgentEvent`、显示 CLI 确认框 | 创建工具和重复实现 Agent 流程 |
| Web Adapter | HTTP API、SSE、静态资源、Web 人工确认适配 | 空间分析逻辑、工具执行逻辑 |
| Web UI | 对话、事件渲染、任务面板、地图、用户操作 | 直接读取本机路径、直接执行 QGIS |

## 4. 启动方式

### 4.1 交互选择

无模式参数时显示选择器：

```text
请选择 Geo-agent 运行模式：

  1. CLI
  2. Web UI

请输入选项 [1]:
```

选择 Web UI 后输出：

```text
Geo-agent Web UI 已启动：

  http://127.0.0.1:3170

按 Ctrl+C 停止服务
```

### 4.2 非交互启动

必须同时保留显式参数，避免 CI、IDE、脚本或部署环境卡在交互选择上：

```bash
npm run dev -- --mode cli
npm run dev -- --mode web
npm run dev -- --mode web --port 3170
npm run dev -- --mode web --no-open
```

构建后：

```bash
npm start -- --mode cli
npm start -- --mode web
```

也可以给 Commander 增加子命令：

```bash
citybrain cli
citybrain web --port 3170 --open
```

推荐优先级为：

```text
显式 --mode 参数 > 子命令 > 交互选择
```

### 4.3 默认网络配置

```ts
interface WebLaunchOptions {
  host: "127.0.0.1";
  port: number;       // 默认 3170
  openBrowser: boolean;
}
```

默认只监听 `127.0.0.1`，不向局域网公开。端口被占用时，可以自动尝试后续端口，并将最终地址打印到终端。

## 5. 目标目录结构

建议逐步调整为：

```text
src/
├─ main.ts
├─ cli/
│  ├─ cli.ts
│  └─ mode-selector.ts
│
├─ runtime/
│  ├─ agent-runtime.ts
│  ├─ create-runtime.ts
│  ├─ run-manager.ts
│  ├─ runtime-events.ts
│  └─ runtime-options.ts
│
├─ adapters/
│  ├─ cli/
│  │  ├─ cli-app.ts
│  │  ├─ cli-event-renderer.ts
│  │  └─ cli-human-interaction.ts
│  │
│  └─ web/
│     ├─ web-server.ts
│     ├─ api-routes.ts
│     ├─ event-stream.ts
│     ├─ web-human-interaction.ts
│     └─ artifact-routes.ts
│
├─ artifacts/
│  ├─ artifact-service.ts
│  ├─ artifact-types.ts
│  └─ map-artifact-adapter.ts
│
├─ agent/
├─ harness/
├─ integrations/
├─ session/
├─ task/
└─ tools/

web/
├─ index.html
├─ src/
│  ├─ api/
│  ├─ components/
│  │  ├─ AppSidebar.tsx
│  │  ├─ SidebarTabs.tsx
│  │  ├─ SessionList.tsx
│  │  ├─ ProjectExplorer.tsx
│  │  ├─ SettingsButton.tsx
│  │  ├─ ChatPanel.tsx
│  │  ├─ MapPanel.tsx
│  │  ├─ LayerPanel.tsx
│  │  ├─ TaskPanel.tsx
│  │  └─ HumanInteractionDialog.tsx
│  ├─ pages/
│  │  ├─ WorkspacePage.tsx
│  │  └─ SettingsPage.tsx
│  ├─ stores/
│  ├─ types/
│  ├─ App.tsx
│  └─ main.tsx
├─ package.json
└─ vite.config.ts
```

现有 `src/app/interactive-app.ts` 不需要一次性重写。可以先移动依赖组装，再逐步把 CLI 组件迁入 `src/adapters/cli/`。

## 6. Agent Runtime 设计

### 6.1 Runtime 接口

Runtime 应提供与界面无关的 API：

```ts
export interface AgentRuntime {
  createSession(options?: CreateSessionOptions): Promise<RuntimeSession>;

  getSession(sessionId: string): RuntimeSession | undefined;

  startRun(
    sessionId: string,
    input: AgentInput,
    options?: RunOptions,
  ): Promise<RunSnapshot>;

  getRun(runId: string): RunSnapshot | undefined;

  subscribeRun(
    runId: string,
    listener: (event: RuntimeEventEnvelope) => void,
    afterSequence?: number,
  ): () => void;

  submitInteraction(
    requestId: string,
    decision: RuntimeInteractionDecision,
  ): boolean;

  getTask(taskId: string): TaskSnapshot | undefined;
  listTasks(sessionId?: string): TaskSnapshot[];
  cancelTask(taskId: string, reason?: string): boolean;

  getArtifact(artifactId: string): AgentArtifact | undefined;

  dispose(): Promise<void>;
}
```

### 6.2 Runtime 创建函数

```ts
export async function createAgentRuntime(
  options: AgentRuntimeOptions,
): Promise<AgentRuntime> {
  // 创建 AuthStorage、ModelRuntime、SessionManager、TaskManager、
  // HumanInteractionBroker、ToolRegistry、QGIS Runtime 和 AgentLoop。
}
```

CLI 与 Web 都调用这一函数，不再各自注册工具或初始化 QGIS。

### 6.3 为什么需要 RunManager

当前 CLI 可以直接执行：

```ts
for await (const event of agentLoop.run(input)) {
  render(event);
}
```

Web 请求不能直接长期持有这个生成器。浏览器可能刷新、断线或重新连接，但 Agent 仍应继续执行。因此需要 `RunManager`：

1. 为每次用户输入生成稳定的 `runId`。
2. 在服务端消费 `AgentLoop.run()`。
3. 缓存有限数量的事件，供断线重连补发。
4. 将事件发布给一个或多个 SSE 订阅者。
5. 维护 `queued/running/waiting_for_human/completed/failed/cancelled` 状态。
6. 将 Run 与 `sessionId`、Task、Artifact 建立关联。

Runtime 第一版应限制同一会话只有一个前台 Run，避免同一 `SessionManager` 被并发写入。不同会话是否并行，可在运行时拆分完成后再开放。

## 7. 统一事件协议

当前 `AgentEvent` 已覆盖文本、思考、工具、状态、上下文和 Agent 状态。Web 层不应直接透传内部对象，而应包装成可版本化、可序列化的事件信封：

```ts
export interface RuntimeEventEnvelope<T = unknown> {
  version: 1;
  eventId: string;
  sequence: number;
  timestamp: string;
  sessionId: string;
  runId: string;
  type: RuntimeEventType;
  data: T;
}
```

建议事件类型：

```ts
type RuntimeEventType =
  | "run.started"
  | "run.state_changed"
  | "run.completed"
  | "run.failed"
  | "message.text_delta"
  | "message.thinking_delta"
  | "tool.started"
  | "tool.progress"
  | "tool.lifecycle"
  | "tool.completed"
  | "task.submitted"
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.timed_out"
  | "interaction.created"
  | "interaction.resolved"
  | "interaction.expired"
  | "artifact.registered"
  | "artifact.ready"
  | "artifact.failed"
  | "map.layer_added"
  | "context.updated";
```

`eventId` 与单调递增的 `sequence` 用于浏览器断线重连。服务端应支持根据 `Last-Event-ID` 或 `afterSequence` 补发事件。

## 8. Web Server 与 API

### 8.1 技术选型

推荐：

| 部分 | 选型 |
| --- | --- |
| Web Server | Fastify |
| 流式事件 | Server-Sent Events（SSE） |
| Web UI | React + Vite + TypeScript |
| 状态管理 | Zustand，第一版也可使用 React Context |
| 地图 | MapLibre GL JS |
| 参数校验 | JSON Schema；可由 Fastify 直接使用 |

当前主要通信方向是服务端持续向浏览器发送 Agent 事件，而用户操作可以通过普通 POST 提交，因此第一版使用 SSE 比 WebSocket 更简单。只有未来需要高频双向协作时再引入 WebSocket。

### 8.2 API 草案

#### 会话与运行

```text
POST /api/sessions
GET  /api/sessions
GET  /api/sessions/:sessionId

POST /api/sessions/:sessionId/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/events
POST /api/runs/:runId/cancel
```

启动 Run：

```http
POST /api/sessions/session-1/runs
Content-Type: application/json

{
  "input": "对当前河流数据生成 100 米缓冲区",
  "thinkingLevel": "high"
}
```

#### 当前工作区与文件

```text
GET /api/sessions/:sessionId/workspace
GET /api/sessions/:sessionId/files?path=<relative-path>
GET /api/sessions/:sessionId/files/content?path=<relative-path>
```

`workspace` 返回当前会话关联的项目目录、工作区目录和可读根目录；文件接口只接受相对于这些允许目录的相对路径。第一版文件树只读，不在 Web UI 内提供删除、移动和编辑操作。

#### Agent 设置

```text
GET   /api/settings
PATCH /api/settings
GET   /api/settings/options
```

`GET /api/settings` 返回经过脱敏的有效配置；`options` 返回可选模型、thinking level、检测到的 QGIS Runtime 等枚举信息；`PATCH` 只接受白名单字段。API Key 只返回 `configured: true/false`，永远不返回明文。

返回：

```json
{
  "runId": "run-...",
  "sessionId": "session-1",
  "status": "running",
  "eventsUrl": "/api/runs/run-.../events"
}
```

#### 人工交互

```text
GET  /api/interactions?status=pending
POST /api/interactions/:requestId/respond
```

```json
{
  "action": "approve",
  "optionId": "allow-once"
}
```

Web Adapter 调用 `HumanInteractionBroker.resolve()`，并将 `source` 固定为 `web`。

#### 后台任务

```text
GET  /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/cancel
```

#### 制品与地图

```text
GET /api/artifacts
GET /api/artifacts/:artifactId
GET /api/artifacts/:artifactId/content
GET /api/maps/:mapId
GET /api/tiles/:artifactId/:z/:x/:y
```

浏览器只能提交和访问 `artifactId`，不能通过 API 传入任意本机绝对路径。

### 8.3 开发与生产模式

开发模式：

```text
Vite Dev Server       http://127.0.0.1:5173
Geo-agent API Server  http://127.0.0.1:3170
```

由 Vite 代理 `/api` 到 Geo-agent Server。

构建模式：

```text
npm run build
  ├── TypeScript 编译到 dist/
  └── Web UI 编译到 dist/web/

citybrain web
  └── 同一个本地服务同时提供静态页面和 /api
```

这样最终用户只需要访问一个地址，不需要单独运行前端开发服务器。

## 9. Web UI 页面与交互设计

### 9.1 固定三栏布局

主工作区按以下顺序固定为：

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Geo-agent        当前工作区 / 模型 / QGIS 状态                  运行状态     │
├──────────────────┬────────────────────────────────┬──────────────────────────┤
│ [会话] [项目目录] │              地图              │        Agent 问答        │
│──────────────────│                                │──────────────────────────│
│                  │  底图                          │ 用户消息                 │
│ 会话列表，或      │  Agent 生成的空间图层           │ Agent 流式回复           │
│ 当前会话关联的    │  图层控制                      │ thinking（可折叠）       │
│ 工作区文件树      │  要素选择与属性查看             │ 工具执行卡片             │
│                  │  缩放、定位、比例尺             │ 后台任务卡片             │
│                  │                                │ 人工确认卡片             │
│──────────────────│                                │──────────────────────────│
│ ⚙ 设置           │                                │ 输入问题……       [发送] │
└──────────────────┴────────────────────────────────┴──────────────────────────┘
```

建议初始宽度：

```text
左侧导航栏    280 px，可折叠到 56 px
中间地图      使用剩余空间，最小宽度 480 px
右侧问答栏    420 px，可在 360～560 px 之间拖动
```

地图是空间 Agent 的主要工作画布，因此中间区域占据最大的可用宽度。问答区固定在右侧，用户可以一边观察地图变化，一边查看 Agent 的执行过程。

窗口宽度不足时，不强行压缩地图：

- 大于等于 1200 px：保持三栏；
- 800～1199 px：左侧默认折叠，地图与问答区并排；
- 小于 800 px：地图与问答区通过标签切换，第一版只保证基本可用，不以移动端为主要目标。

### 9.2 左侧导航栏

左侧导航栏由顶部标签区、主体内容区和固定底部操作区构成：

```text
┌────────────────────┐
│ [会话] [项目目录]   │  ← 顶部标签，默认“会话”
├────────────────────┤
│                    │
│ 当前标签对应内容    │  ← 独立滚动
│                    │
├────────────────────┤
│ ⚙ 设置             │  ← 始终固定在底部
└────────────────────┘
```

切换标签只替换左侧主体内容，不影响中间地图、右侧问答记录和正在运行的任务。

#### 会话标签

默认显示“会话”标签，包含：

- 新建会话按钮；
- 会话搜索；
- 当前会话高亮；
- 会话标题、最后更新时间和运行状态；
- 正在执行、等待确认和存在后台任务的状态标识；
- 会话重命名；
- 会话删除二次确认；
- 切换会话后恢复其消息、地图图层、Task 和关联工作区。

会话项建议显示：

```text
● 河流缓冲区分析
  E:\data\river-project
  2 分钟前            运行中
```

新会话默认继承当前项目目录，但在创建时允许重新选择项目目录。不同会话可以关联不同项目；`sessionId` 是消息、Run、Task、Artifact 和地图状态的共同隔离键。

#### 项目目录标签

“项目目录”展示当前会话关联的工作区，而不是展示服务器上的任意文件系统：

```text
项目目录
E:\data\river-project

▼ input/
  ├─ rivers.shp
  ├─ rivers.dbf
  └─ boundary.geojson
▼ output/
  ├─ river_buffer.gpkg       [地图]
  └─ statistics.html         [预览]
▶ intermediate/
▶ .internal/                 [默认隐藏]
```

第一版功能：

- 显示当前会话的项目目录和工作区目录；
- 按需展开目录，避免一次性扫描大型工作区；
- 刷新目录；
- 显示文件名、类型、大小和修改时间；
- 对空间数据文件显示“添加到地图”操作；
- 对文本、JSON、Markdown 和 HTML 报告提供只读预览；
- 对工具新生成的文件显示“新”标记，并通过事件局部刷新目录；
- 默认隐藏 `.internal`、日志、认证信息等内部内容；
- 空目录、无权限、文件消失和超大文件均显示明确状态。

文件树不直接持有绝对路径。前端保存 `rootId + relativePath`，服务端把它解析为绝对路径后再次执行 SandboxPolicy 和符号链接边界检查。

空间文件的“添加到地图”不是让浏览器直接打开本机文件，而是调用制品转换接口：

```text
用户点击“添加到地图”
  → 服务端校验文件
  → 创建或复用 Artifact
  → 必要时转换为 GeoJSON / 瓦片
  → 发布 map.layer_added
  → 中间地图加载图层
```

### 9.3 中间地图工作区

地图区域是页面中心，包含：

- 底图切换；
- 缩放、平移、回到初始范围；
- 当前坐标和比例尺；
- 图层列表、顺序、显隐和透明度；
- 自动缩放到新结果，可在设置中关闭；
- 点击要素并查看属性；
- 新生成图层的高亮提示；
- 图层加载中、转换中和加载失败状态；
- 当前会话地图状态恢复。

地图图层必须属于当前会话。切换会话时保存当前视口和图层状态，再恢复目标会话的地图状态，避免将不同项目的数据混在同一地图中。

图层面板建议以地图右上角抽屉形式存在，避免额外占用固定栏位。要素属性在地图底部抽屉中显示。

### 9.4 右侧 Agent 问答区

右侧问答区承担当前 CLI 的主要交互能力：

- 用户问题与 Agent 流式回答；
- thinking 折叠区；
- 工具开始、进度、完成和错误状态；
- 后台 Task 卡片与取消操作；
- 权限、沙箱访问、危险操作和恢复选择；
- 引用或定位当前选中的地图要素和项目文件；
- 固定底部输入框；
- 停止当前 Run；
- 自动滚动与“回到底部”按钮。

问答区与地图需要双向联动：

```text
Agent 生成空间制品  → 地图自动添加或提示添加图层
用户选中地图要素    → 可将要素摘要附加到下一条问题
用户选择项目文件    → 可将文件引用附加到输入框
工具进入后台 Task   → 问答不中断，Task 卡片持续更新
```

附件只传递受控引用，例如 `artifactId`、`rootId` 和 `relativePath`，不将浏览器提交的路径直接拼接进工具参数。

### 9.5 设置入口与设置界面

设置按钮固定在左侧导航栏底部。点击后进入 `/settings`，设置界面替换主工作区内容，但保留顶部应用栏和返回按钮；返回后恢复之前的会话、地图视口和未发送输入。

设置项按领域分组：

| 分组 | 设置内容 | 保存范围 |
| --- | --- | --- |
| 模型 | Provider、模型、thinking level、上下文窗口 | 全局默认，可被会话覆盖 |
| Agent | 最大工具轮次、上下文压缩策略、是否显示 thinking | 全局默认 |
| 工具执行 | 后台升级默认阈值、任务超时、最大并发数、最大队列长度 | 全局运行时配置 |
| QGIS | 自动检测结果、可执行文件位置、运行环境状态 | 全局配置 |
| 工作区与沙箱 | 默认项目目录、附加只读根、路径权限策略 | 全局默认与当前会话 |
| 地图 | 默认底图、默认中心、自动缩放、新图层默认样式 | Web UI 本地偏好 |
| 界面 | 主题、语言、左右栏宽度、thinking 展示 | Web UI 本地偏好 |
| 认证 | Provider 是否已配置、更新或清除凭据 | 服务端安全存储 |

设置分为三种生效级别：

1. **即时生效**：主题、地图偏好、thinking 是否展开等 UI 设置。
2. **下一次 Run 生效**：模型、thinking level、工具后台阈值等运行参数。
3. **重启后生效**：监听地址、端口等服务启动参数。

保存时必须显示具体结果，不应只显示笼统的“保存成功”：

```text
已保存：默认模型、thinking level
下次运行生效：后台任务阈值
需要重启：Web 服务端口
```

无效配置不能部分静默写入。服务端先完整校验，返回字段级错误；涉及清除认证、扩大工作区访问范围等敏感操作时仍通过 HumanInteractionBroker 请求确认。

### 9.6 页面状态与 Store 划分

前端状态按领域拆分，避免把整个页面放进单个全局 Store：

```text
sessionStore      会话列表、当前 sessionId
runStore          当前 Run、消息和流式事件
taskStore         后台任务快照
workspaceStore    当前工作区、文件树和文件预览
mapStore          视口、图层、选中要素
settingsStore     配置草稿、有效配置和保存状态
uiStore           当前侧栏标签、面板宽度、主题
```

切换会话时必须以 `sessionId` 为边界清空或恢复对应状态；SSE 事件也必须校验 `sessionId` 和 `runId`，防止旧会话事件更新当前页面。

### 9.7 第一版页面能力

- 三栏顺序固定为“左侧导航 / 中间地图 / 右侧问答”；
- 左侧默认显示会话列表，可切换项目目录；
- 左侧底部固定设置按钮；
- 设置页可以读取、校验和保存 Agent 相关配置；
- 创建、切换和恢复会话；
- 按当前会话安全浏览项目文件；
- 流式显示 Agent 文本和可折叠 thinking；
- 展示工具、Task 和人工确认状态；
- 显示 GeoJSON 图层；
- 图层显隐、透明度、缩放和要素属性查看；
- 新空间制品生成后自动加入当前会话地图。

## 10. 地图数据链路

### 10.1 核心原则

地图不是单独于 Agent 的临时预览功能，而是 Agent 输出制品的一种标准展示方式：

```text
Agent 调用空间工具
       │
       ▼
QGIS / GDAL 生成文件
       │
       ▼
ArtifactService 登记并检查文件
       │
       ├── 创建 artifactId
       ├── 提取格式、CRS、bbox 等元数据
       └── 发布 artifact.ready / map.layer_added
                              │
                              ▼
                        Web UI 加载图层
```

### 10.2 扩展制品模型

当前 `ArtifactRegistry` 以标准化路径为索引，主要服务于后台任务依赖。Web UI 需要稳定 ID、媒体类型和地图元数据，因此建议在其上增加 `ArtifactService`，不要直接破坏现有 Registry 的任务语义。

```ts
export interface AgentArtifact {
  id: string;
  sessionId: string;
  runId?: string;
  producerTaskId?: string;
  name: string;
  kind: "file" | "vector" | "raster" | "map" | "report";
  status: "pending" | "ready" | "missing" | "invalid";
  path: string;               // 仅服务端内部使用
  contentType?: string;
  sizeBytes?: number;
  createdAt: string;
  readyAt?: string;
  map?: MapArtifactMetadata;
}

export interface MapArtifactMetadata {
  format: "geojson" | "image-overlay" | "xyz" | "cog" | "mvt" | "pmtiles";
  crs: string;
  bbox?: [number, number, number, number];
  geometryType?: string;
  featureCount?: number;
  style?: MapLayerStyle;
  dataUrl: string;
}
```

返回给浏览器时必须删除内部 `path`，只暴露受控的 `dataUrl`。

### 10.3 分阶段支持格式

| 阶段 | 数据类型 | 浏览器格式 | 处理方式 |
| --- | --- | --- | --- |
| 第一阶段 | 小型矢量 | GeoJSON，EPSG:4326 | QGIS/GDAL 转换后由受控接口提供 |
| 第二阶段 | 普通栅格 | XYZ 瓦片或 image overlay | 服务端转换并缓存 |
| 第三阶段 | 大型矢量 | MVT 或 PMTiles | 避免一次性下载完整要素集 |
| 第三阶段 | 大型栅格 | COG 或动态瓦片 | 按视口和层级读取 |

第一版不应直接把 Shapefile、GeoPackage 或任意 GeoTIFF 交给浏览器解析。

### 10.4 图层样式

工具可以返回可选的样式建议，但 Web UI 必须提供安全默认值：

```ts
interface MapLayerStyle {
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  circleColor?: string;
  circleRadius?: number;
}
```

样式仅作为数据，不允许工具向页面注入 JavaScript 或任意 HTML。

## 11. 后台 Task 在 Web UI 中的表现

现有 `TaskManager.subscribe()` 可以作为 Web 任务事件源。Runtime 负责把当前事件映射为统一事件：

| TaskManager 事件 | Runtime 事件 |
| --- | --- |
| `submitted` | `task.submitted` |
| `started` | `task.started` |
| `progress` / `artifacts_changed` | `task.progress` / `artifact.registered` |
| `completed` | `task.completed` |
| `failed` | `task.failed` |
| `cancelled` | `task.cancelled` |
| `timed_out` | `task.timed_out` |

Web 任务卡片示例：

```text
河流缓冲区分析
██████████████░░░░ 72%
已运行 38 秒 · 正在写入输出文件
[取消任务]
```

需要遵循以下语义：

- 浏览器关闭或 SSE 断开不自动取消后台任务；
- 页面重新连接后，先请求任务快照，再继续接收增量事件；
- 用户显式点击取消，才调用 `TaskManager.cancel()`；
- Web Server 退出时调用 `runtime.dispose()`，终止仍在运行的外部进程；
- 当前 `InMemoryTaskStore` 重启后不能恢复任务，UI 必须把重启前未完成任务标为 interrupted，而不能假装仍在运行；
- 如果未来要求进程重启后恢复，需要新增持久化 TaskStore 和可恢复 Runner，不能只序列化 `TaskSnapshot`。

## 12. 人工确认接入

`HumanInteractionBroker` 已经是传输无关的，并且 `HumanDecisionSource` 已包含 `web`，因此不需要重写权限系统。

```text
ToolRegistry / Harness
        │ request()
        ▼
HumanInteractionBroker
        │ created event
        ▼
Runtime Event Bus → SSE → Web Dialog
        │
        ▼ POST decision
Web Adapter → broker.resolve(..., source: "web")
```

刷新页面后，Web UI 通过 `getPending()` 恢复尚未处理的确认请求。高风险操作仍需显式确认，不能因为切换为 Web UI 而降低权限等级。

## 13. CLI 复用方式

CLI 仍然消费统一事件，只是渲染器不同：

```ts
const run = await runtime.startRun(sessionId, { text: input });

const unsubscribe = runtime.subscribeRun(run.id, (event) => {
  cliRenderer.render(event);
});
```

Web 模式则把同一事件写入 SSE：

```ts
runtime.subscribeRun(runId, (event) => {
  sseConnection.send(event);
});
```

CLI 模式产生地图制品时，可以提供一个补充命令：

```text
已生成地图图层：河流 100 米缓冲区

输入 /map 打开本地地图，或访问：
http://127.0.0.1:3170/maps/map-...
```

这属于后续增强能力。双模式第一版只需保证 Web UI 内嵌地图、CLI 保留文件路径和制品信息即可。

## 14. 安全边界

本地 Web 服务仍然需要明确安全设计：

1. 默认绑定 `127.0.0.1`，只有显式配置才能监听其他地址。
2. 启动时生成随机本地访问令牌，并通过 HttpOnly、SameSite Cookie 或启动 URL 完成首次交换。
3. API 不接受任意绝对路径下载参数。
4. `artifactId` 必须映射到已经登记且位于允许目录中的真实文件。
5. 返回文件前重新执行 `resolve()` 和工作区边界检查，防止路径穿越和符号链接逃逸。
6. Web 页面不能绕过 `HumanInteractionBroker` 直接执行危险工具。
7. 请求体、GeoJSON 大小、事件缓存和并发 Run 数必须设置上限。
8. 日志和 API 响应不得返回 API Key、认证令牌或未经处理的环境变量。
9. 地图要素属性按文本渲染，禁止直接作为 HTML 注入。
10. 服务关闭时停止接收新 Run，并在宽限期后清理 Task、QGIS 子进程和待处理人工请求。

## 15. 生命周期与退出流程

Web 模式启动：

```text
解析参数
  → createAgentRuntime()
  → 创建 Web Server
  → 注册 API/SSE/静态资源
  → 监听 127.0.0.1:port
  → 可选打开浏览器
```

收到 `SIGINT` 或 `SIGTERM`：

```text
停止接收新请求
  → 通知 SSE 客户端 server.shutting_down
  → 等待当前写操作进入安全点
  → runtime.dispose()
  → taskManager.dispose()
  → 取消待处理人工交互
  → 终止 QGIS 子进程
  → 关闭 HTTP Server
```

所有资源清理都应具有超时，避免某个外部进程导致应用无法退出。

## 16. package.json 调整建议

最终脚本可以组织为：

```json
{
  "scripts": {
    "dev": "tsx src/main.ts",
    "dev:cli": "tsx src/main.ts --mode cli",
    "dev:web": "concurrently \"vite --config web/vite.config.ts\" \"tsx watch src/main.ts --mode web --no-open\"",
    "build": "npm run build:server && npm run build:web",
    "build:server": "tsc -p tsconfig.json",
    "build:web": "vite build --config web/vite.config.ts",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

具体是否采用单个根 `package.json` 或 npm workspaces，可以在实施前确定。第一版建议保持单包结构，减少迁移范围；只有前后端依赖和构建流程明显复杂后再升级为 workspace。

## 17. 分阶段实施计划

### 阶段一：抽离 Runtime，不改变 CLI 行为（已完成）

> 完成日期：2026-10-09

目标：CLI 的功能和界面保持不变，但核心对象不再由 TUI 文件创建。

任务：

- 新增 `src/runtime/create-runtime.ts`；
- 把模型、会话、工具、QGIS、TaskManager 和 Broker 的创建迁出 `interactive-app.ts`；
- 为 Runtime 增加统一 `dispose()`；
- CLI 通过依赖注入获得 Runtime；
- 保留现有 `AgentLoop.run()` 和工具执行行为。

验收：

```bash
npm run typecheck
npm run dev -- --mode cli
```

CLI 的对话、工具调用、后台升级、任务管理和人工确认全部正常。

实际落地内容：

- 新增 `src/runtime/agent-runtime.ts`，统一持有 Agent、模型、会话、工具、TaskManager、HumanInteractionBroker、日志器和 QGIS 状态；
- 新增 `src/runtime/create-runtime.ts`，集中创建依赖图并注册当前全部工具；
- 新增 `src/runtime/index.ts`，作为 Runtime 模块统一出口；
- `src/app/interactive-app.ts` 改为通过 `createAgentRuntime()` 获得核心依赖；
- CLI 的会话、QGIS Runtime 和 thinking level 变更同步写入 Runtime；
- CLI 退出时调用幂等的 `runtime.dispose()`，统一取消待处理人工交互、清理订阅并终止 TaskManager；
- 保留当前 CLI 的事件消费、命令处理、TUI 展示和工具执行行为。

验证结果：

```text
npm run typecheck   通过
npm run build       通过
Runtime 工具注册     12 个工具，包含 QGIS、Task 和 delegate
Runtime 状态/释放    状态更新正确，重复 dispose 安全
```

### 阶段二：RunManager 与 Web 对话（已完成）

> 完成日期：2026-10-09

目标：浏览器可以完成一次完整 Agent 对话。

任务：

- 实现 RunManager 和统一事件信封；
- 实现本地 HTTP Server；
- 实现会话、Run、SSE 和人工确认 API；
- 实现 React 对话界面；
- 搭建“左侧导航 / 中间地图占位区 / 右侧问答”的基础布局；
- 实现会话列表、项目目录标签和底部设置入口；
- 实现工作区只读文件 API 与 Agent 设置 API；
- 支持断线重连和事件补发；
- 增加 CLI/Web 启动选择。

验收：浏览器刷新后可以恢复当前 Run、已输出文本和待确认操作；切换左侧标签不会影响地图和问答状态；设置项可以经过服务端校验后保存。

实际落地内容：

- 新增独立于 HTTP 连接的 `RunManager`，负责消费 `AgentLoop.run()`、缓存事件、取消 Run 和维护状态；
- 统一事件使用 `eventId + sequence + sessionId + runId`，SSE 支持按序列补发；
- 新增 Fastify 本地服务，提供会话、Run、SSE、Task、人工确认、设置和工作区 API；
- 增加 `citybrain cli`、`citybrain web`、`--mode`、`--port` 和 `--no-open` 启动参数；
- 无参数且在交互终端运行时显示 CLI / Web UI 选择器；
- 新增 React + Vite Web 工程，完成左侧会话/项目目录、中间地图、右侧问答布局；
- 设置页支持模型、thinking level、地图偏好、主题和 QGIS 状态展示；
- 工作区文件接口使用 `rootId + relativePath` 并再次经过 SandboxPolicy 校验；
- Web UI 已接入流式文本、thinking、工具状态、Task 卡片和人工确认对话框。

### 阶段三：Task 面板与地图制品（已完成第一版）

> 完成日期：2026-10-09

目标：耗时工具进入后台后，Web UI 可以持续追踪并自动显示空间结果。

任务：

- 将 TaskManager 事件接入 Runtime Event Bus；
- 新增 ArtifactService；
- 增加安全制品下载接口；
- 第一版支持 GeoJSON/EPSG:4326；
- 集成 MapLibre；
- 实现图层面板、属性查看和缩放至图层。
- 实现项目目录中空间文件的“添加到地图”；
- 保存并恢复每个会话自己的地图视口和图层状态。

验收：QGIS 工具完成后，不需要用户手工寻找输出文件，地图自动出现结果图层。

实际落地内容：

- TaskManager 事件已映射为 Runtime 事件，并通过现有 Run SSE 持续推送；
- 后台工具 Task 增加 Agent `runId` 元数据，确保任务、Run 和会话正确关联；
- 新增 ArtifactService，通过稳定 `artifactId` 管理内部路径，API 不暴露绝对路径；
- 自动捕获 QGIS 工具进度与后台 Task 的输出路径；
- 第一版支持 EPSG:4326 GeoJSON 注册、受控读取和 MapLibre 渲染；
- 项目目录中的 GeoJSON 可以手动添加到地图；
- 地图支持自动缩放、手动缩放至图层、图层显隐和安全的要素属性弹窗；
- 地图视口按 `sessionId` 保存在浏览器本地，切换会话后分别恢复；
- 页面刷新后会重新获取当前服务进程内的 Artifact 和 Task 快照。

第一版边界：

- GeoTIFF、Shapefile、GeoPackage、XYZ、COG 和 MVT 尚未实现浏览器转换或瓦片服务，属于阶段四；
- Run、Task 和 Artifact 目前仍为进程内状态，服务进程重启后的恢复属于阶段四；
- 当前只允许一个全局活动 Agent Run，避免共享 AgentLoop 和 SessionManager 出现并发污染；阶段四再扩展为安全的多会话并发；
- MapLibre 使首个前端 bundle 较大，后续可通过动态导入和代码分包优化。

验证结果：

```text
npm run typecheck       通过
npm run typecheck:web   通过
npm run build           通过
Web 服务健康检查         通过
生产首页与设置页          HTTP 200
会话/工作区/Task API     HTTP 200
路径越界请求              HTTP 400
GeoJSON 注册与读取        通过
RunManager 流式事件测试   通过
```

### 阶段四：大型数据与持久化

目标：支持生产级空间数据规模和进程恢复。

任务：

- XYZ、COG、MVT 或 PMTiles；
- 制品缓存、配额和清理策略；
- 持久化 Run Event Store；
- 持久化 TaskStore；
- 会话级并发控制；
- 性能和资源监控。

## 18. 第一版验收场景

完整验收流程：

```text
1. 执行 npm run dev。
2. 选择 Web UI。
3. 终端输出并自动打开本地地址。
4. 页面呈现左侧导航、中间地图、右侧问答三栏布局。
5. 左侧默认显示会话列表，并可以切换到当前会话的项目目录。
6. 项目目录只能浏览允许的工作区，空间文件可以添加到地图。
7. 点击左侧底部设置按钮，读取并修改允许的 Agent 配置。
8. 返回工作区后，原会话、地图视口和输入状态保持不变。
9. 在右侧输入“对河流数据生成 100 米缓冲区”。
10. 页面实时显示 Agent 文本和工具执行状态。
11. 工具超过阈值后升级为后台 Task。
12. 页面显示 Task 进度，浏览器刷新后仍能恢复任务状态。
13. 工具需要授权时，Web UI 显示确认对话框。
14. Task 完成后，GeoJSON 制品自动加载到中间地图。
15. 用户可以切换图层、缩放到结果并查看要素属性。
16. 切换会话后，消息、工作区、Task 和地图图层同步切换。
17. 重新启动并选择 CLI，原有终端能力保持可用。
```

## 19. 主要风险与处理方式

| 风险 | 后果 | 处理方式 |
| --- | --- | --- |
| CLI 和 Web 分别组装工具 | 行为和权限逐渐不一致 | 只允许 `createAgentRuntime()` 创建核心依赖 |
| 浏览器断线导致 Run 中断 | 长任务丢失 | RunManager 独立消费 Agent 流，SSE 只负责订阅 |
| 同一会话并发运行 | 会话消息顺序和上下文损坏 | 第一版限制每个会话一个活动 Run |
| SSE 重连后事件重复 | UI 内容重复 | 使用 `eventId + sequence` 去重和补发 |
| TaskManager 仅内存存储 | 进程重启后任务消失 | 第一版明确 interrupted 语义，后续再增加可恢复存储 |
| 暴露本机文件路径 | 目录穿越和敏感文件泄露 | 只接受 artifactId，并做工作区边界复检 |
| 项目目录文件树越权 | Web UI 浏览到工作区之外或内部凭据 | 使用 rootId + relativePath、SandboxPolicy、符号链接检查和隐藏规则 |
| 设置 API 泄露凭据 | API Key 被浏览器读取或日志记录 | 只返回 configured 状态，明文凭据只写不读并对日志脱敏 |
| 运行中修改配置 | 当前 Run 行为不可预测 | 区分即时、下一次 Run 和重启生效的配置 |
| 大 GeoJSON 卡死浏览器 | 内存过高、页面无响应 | 设置阈值，大数据转换为瓦片 |
| 多次转换相同数据 | CPU、磁盘浪费 | 使用源文件指纹和转换参数作为缓存键 |
| Web 模式绕过人工确认 | 高风险工具失去控制 | 所有决策仍通过 HumanInteractionBroker |
| 服务退出遗留 QGIS 进程 | 文件锁和资源泄漏 | Runtime 统一持有并清理外部进程 |

## 20. 最终决策摘要

本项目推荐采用以下确定方案：

```text
运行时          单一 AgentRuntime
启动入口        无参数交互选择 + --mode 显式参数
CLI             保留 pi-tui，改造成 Runtime Adapter
Web 后端        Fastify，本地监听 127.0.0.1
流式通信        HTTP POST + SSE
Web 前端        React + Vite + TypeScript
页面布局        左侧会话/项目目录，中间地图，右侧 Agent 问答
设置入口        左侧底部固定按钮，进入独立设置页
地图            MapLibre GL JS
首期地图格式    EPSG:4326 GeoJSON
后台任务        复用现有 TaskManager
人工确认        复用现有 HumanInteractionBroker
制品访问        artifactId 映射，不暴露任意绝对路径
并发策略        第一版一个会话一个活动 Run
```

实施时最重要的第一步是抽离 Runtime。只要完成这一步，Web UI、地图、Task 面板和未来其他客户端都可以作为适配层逐步接入，而不会破坏现有 CLI 或复制 Agent 核心逻辑。
