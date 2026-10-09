<!--
Screenshot slot:
After adding the screenshot, place it at `docs/assets/citybrain-cli.png` and
uncomment the following block.

<p align="center">
  <img src="docs/assets/citybrain-cli.png" alt="CityBrain CLI" width="960">
</p>
-->

# CityBrain

<p align="center">
  <strong>Language / 语言</strong>
</p>

<details open>
<summary><strong>中文</strong></summary>

CityBrain 是一个面向城市数据分析的 TypeScript CLI Agent。项目以
`qgis_process` 为主要空间分析执行入口，通过一个类似 Pi Agent / Claude
Code 的 Harness 运行时，将模型对话、工具执行、QGIS 算法调用、上下文管理、
工作区安全和执行日志组织在同一个终端工作流中。

当前项目的重点不是重新封装数百个 QGIS 算法，而是让 Agent 能够：

- 发现、查询和调用本地 QGIS Processing 算法；
- 在长时间运行的空间分析任务中持续执行工具并返回状态；
- 将工具调用、工具结果和错误显示在 CLI 中；
- 在真实模型上下文预算下构建动态 System Prompt；
- 对历史消息和大型工具结果执行分阶段上下文压缩；
- 在项目级 sandbox 中读取数据并生成分析文件；
- 保留可恢复的会话、工具执行日志和上下文追踪记录。

### 当前状态

当前版本是一个可运行的 MVP，已经完成核心 CLI、Agent Loop、QGIS
Processing 调用、基础 Harness 状态管理、工作区 sandbox 和上下文管理基础。
数据画像 `profile.md` 的设计和生命周期规范已经形成，但自动化画像 Worker
仍属于后续建设内容。

### 主要能力

#### Agent CLI

- Pi 风格终端交互界面；
- 流式输出模型回答和 reasoning/thinking 内容；
- 工具执行过程在 CLI 中实时显示；
- 工具成功使用浅绿色背景，工具失败使用浅红色背景；
- 用户消息使用浅色背景；
- `/thinking off|high|max` 切换模型思考等级；
- 两次 `Ctrl+C` 才退出程序；
- 空白会话不会立即创建 session 文件；
- 支持会话恢复和新建会话。

#### QGIS Processing

当前通过 `qgis_process` 直接调用 QGIS Processing，不对数百个算法逐一
进行手工封装。主要工具包括：

- `list_qgis_algorithms`：获取和过滤算法列表；
- `describe_qgis_algorithm`：查询算法参数和输出定义；
- `run_qgis_algorithm`：执行具体 QGIS 算法；
- QGIS runtime 检测、路径配置和版本校验；
- QGIS 长任务的进度、超时、失败和产物状态管理；
- QGIS 输入路径和输出路径经过 sandbox 策略检查。

#### 文件工具

- `read_file`：读取文本文件，支持 `offset` / `limit` 渐进式读取；
- `list_files`：查看目录内容；
- `write_file`：创建文件或完整重写文件；
- `edit_file`：基于精确字符串匹配进行局部修改。

已有文件必须先通过 `read_file` 完整读取，随后才能使用
`write_file` 或 `edit_file` 修改。写入过程使用同目录临时文件、同步写入和
原子替换，并执行读取快照和内容指纹检查。

#### Harness 与工具执行

当前工具执行层包含：

- `ToolRegistry`：工具注册、统一调用、错误封装和产物状态管理；
- `StreamingToolExecutor`：流式工具执行、进度事件和取消信号；
- 工具执行开始、进度、产物、成功和失败日志；
- QGIS 长任务的 `pending -> ready/missing/invalid` 产物状态；
- 工具调用失败后将结构化错误返回模型，而不是直接终止 Agent Loop；
- 子 Agent 继承父 Agent 的 sandbox、QGIS runtime 和日志能力。

#### 上下文管理

系统将稳定的静态 System Prompt 与运行时动态 System Prompt 分离。动态内容
可以包括当前模型、QGIS runtime、sandbox 状态、产物状态、项目说明和可用技能。

上下文压缩按照由轻到重的顺序执行：

1. 历史片段剪枝；
2. 旧工具结果 microcompact；
3. context collapse；
4. LLM 摘要压缩；
5. LLM 摘要失败时使用确定性摘要作为 fallback。

压缩只作用于本次模型请求的消息投影，不破坏 session 中保存的 canonical
conversation。上下文请求、响应、压缩阶段和实际发送的消息会落地到日志中。

#### 项目级 Sandbox

执行：

```text
/init E:\workspace1
```

其中：

- `E:\workspace1` 是真正的项目级 sandbox 根目录；
- `E:\workspace1\citybrain` 是 Harness 控制目录；
- `E:\workspace1` 下可以放置待处理的原始数据和用户文件；
- Agent 和 QGIS 的写入不能越过 `E:\workspace1`；
- 外部目录默认不能读取，需要显式授权；
- `citybrain/.internal`、`workspace.json`、`profile.md` 和 `AGENTS.md`
  等 Harness 管理文件不能由通用文件工具直接修改。

工作区结构：

```text
E:\workspace1\
├─ 原始数据和用户文件
└─ citybrain\
   ├─ AGENTS.md
   ├─ workspace.json
   ├─ profile.md
   ├─ artifacts\
   │  ├─ process\
   │  └─ result\
   └─ .internal\
      ├─ tmp\
      ├─ logs\
      └─ state\
```

过程文件和结果文件目前可以通过显式路径写入
`citybrain/artifacts/process` 和 `citybrain/artifacts/result`。当前版本暂不
自动判断并路由过程数据与结果数据。

### 快速开始

环境要求：

- Node.js `>= 22.19.0`；
- 一个可用的模型供应商 API key；
- 如果需要空间分析，需要本地可用的 `qgis_process`。

```cmd
cd /d E:\Geo-agent
npm install
npm run dev
```

启动时可以选择 CLI 或 Web UI，也可以直接指定：

```cmd
npm run dev -- --mode cli
npm run dev -- --mode web
npm run dev -- --mode web --port 3170 --no-open
```

Web UI 默认只监听 `127.0.0.1`，页面采用左侧会话/项目目录、中间地图、右侧
Agent 问答的工作台布局。生产构建会同时生成服务端和 Web 静态资源：

```cmd
npm run build
npm start -- --mode web
```

也可以构建并注册全局命令：

```cmd
cd /d E:\Geo-agent
npm run build
npm link
citybrain
```

取消全局链接：

```cmd
npm unlink -g citybrain
```

### CLI 命令

```text
/help
/new
/clear
/resume
/model [provider/model]
/thinking [off|high|max]
/qgis [setup|detect|list [filter]|info <algorithm>|use <path>|clear]
/init [<target-folder>]
/sandbox [add-read|remove-read <directory>]
/session
/login [provider]
/logout [provider]
/quit
/exit
```

授权读取外部数据目录：

```text
/sandbox add-read E:\GeoAIOps\data
```

查看当前 sandbox：

```text
/sandbox
```

### QGIS Runtime

启动时 CityBrain 会检测 `qgis_process`。如果没有检测到可用环境，会显示
配置引导：

```text
1. Install QGIS LTR locally
2. Configure existing QGIS path
3. Use Docker runtime
4. Connect remote QGIS runner
5. Continue without QGIS
```

当前可用的是：

- 本地 QGIS runtime 检测；
- 配置已有的 `qgis_process` 路径；
- 执行 `qgis_process --version` 验证；
- 将配置保存到 `%USERPROFILE%\.citybrain\qgis-runtime.json`。

Docker runtime 和远程 QGIS runner 目前保留为后续扩展入口。

### 日志与会话

本地配置：

```text
%USERPROFILE%\.citybrain\auth.json
%USERPROFILE%\.citybrain\settings.json
%USERPROFILE%\.citybrain\models-store.json
%USERPROFILE%\.citybrain\qgis-runtime.json
%USERPROFILE%\.citybrain\sessions\
```

如果需要修改配置目录，可以设置：

```cmd
set CITYBRAIN_AGENT_DIR=D:\citybrain-config
```

工作区日志：

```text
<sandbox>\citybrain\.internal\logs\tool-execution.jsonl
<sandbox>\citybrain\.internal\logs\context-usage.jsonl
<sandbox>\citybrain\.internal\logs\context-trace.jsonl
```

其中：

- `tool-execution.jsonl`：工具开始、进度、产物和结束事件；
- `context-usage.jsonl`：模型上下文和 token 使用记录；
- `context-trace.jsonl`：实际发送给模型的消息、System Prompt 分段和压缩报告。

### 相关设计文档

- [工作区初始化规范](WORKSPACE_INIT_SPEC.md)
- [Workspace Sandbox 设计](WORKSPACE_SANDBOX_DESIGN.md)
- [Context 与 Tool Harness 设计](CONTEXT_AND_TOOL_HARNESS_DESIGN.md)
- [Claude Code 风格 Tool Harness 规划](CLAUDE_CODE_STYLE_TOOL_HARNESS_PLAN.md)
- [Memory 设计](MEMORY_DESIGN.md)

### 当前限制与后续方向

当前仍有以下限制：

- profile 自动画像 Worker 尚未完整实现；
- 过程数据和结果数据尚未根据任务自动路由；
- sandbox 目前是应用层路径策略，不是操作系统级容器隔离；
- Docker 和远程 QGIS runner 尚未实现；
- 复杂数据类型的画像需要进一步接入 QGIS/GDAL 元数据探测；
- 需要继续补充 Windows 路径、junction/symlink、长任务取消和恢复测试。

后续重点方向：

1. 实现基于工具日志和 artifact registry 的后台 profile Worker；
2. 对矢量、栅格、表格等数据建立确定性元数据扫描器；
3. 将扫描事实交给子 Agent 生成可读的 `profile.md`；
4. 增加显式 `/profile refresh`；
5. 完善 artifact 路由、任务目录和数据血缘；
6. 增加更强的进程级 QGIS 隔离能力。

</details>

<details>
<summary><strong>English</strong></summary>

CityBrain is a TypeScript CLI Agent for urban data analysis. It uses
`qgis_process` as the primary spatial-processing entry point and combines a
Pi/Claude Code-inspired Harness runtime with streaming model interaction,
tool execution, QGIS algorithm discovery, context management, workspace
sandboxing, and execution logs.

The project does not manually wrap hundreds of QGIS algorithms. Instead, it
lets the Agent discover, inspect, and execute algorithms through the local
QGIS Processing CLI.

### Current Status

The current milestone is a runnable MVP. It includes the core terminal UI,
streaming Agent Loop, QGIS Processing integration, Harness state handling,
project-level sandboxing, file tools, execution logging, and request-time
context compression.

The `profile.md` data-profile lifecycle has been designed and documented, but
the fully automated background profile Worker is still planned.

### Implemented Capabilities

#### Agent CLI

- Pi-style terminal UI;
- streaming assistant text and reasoning output;
- live tool execution display;
- light-green tool success blocks and light-red failure blocks;
- light user-message blocks;
- `/thinking off|high|max`;
- two `Ctrl+C` presses required to exit;
- no session file is created for an untouched blank session;
- session resume and fresh-session commands.

#### QGIS Processing

The Agent calls `qgis_process` directly instead of maintaining one wrapper per
algorithm:

- `list_qgis_algorithms`;
- `describe_qgis_algorithm`;
- `run_qgis_algorithm`;
- QGIS runtime discovery and configuration;
- version validation;
- progress, timeout, failure, and artifact-state handling;
- sandbox validation for QGIS input and output paths.

#### File Tools

- `read_file` with `offset` / `limit`;
- `list_files`;
- `write_file`;
- `edit_file`.

Existing files must be fully read before modification. Writes use read
snapshots, content fingerprints, same-directory temporary files, sync, and
atomic replacement.

#### Harness and Tool Execution

The current execution layer includes:

- `ToolRegistry` for registration, invocation, error wrapping, and artifact state;
- `StreamingToolExecutor` for progress events and cancellation;
- start, progress, artifact, success, and failure logs;
- `pending -> ready/missing/invalid` artifact transitions;
- structured tool errors returned to the model instead of terminating the loop;
- subagents inheriting the parent sandbox, QGIS runtime, and logging context.

#### Context Management

Static system instructions are separated from runtime dynamic prompt sections.
Dynamic sections may include the selected model, QGIS runtime, sandbox state,
artifact state, project instructions, and available skills.

Request-time compression proceeds from light to heavy:

1. history pruning;
2. microcompaction of old tool results;
3. context collapse;
4. LLM summary compression;
5. deterministic fallback summaries when the summary request fails.

Compression only changes the message projection sent for the current request.
The canonical session remains intact. Requests, responses, compression stages,
and the exact projected messages are persisted in context logs.

#### Project-Level Sandbox

Run:

```text
/init E:\workspace1
```

The semantics are:

- `E:\workspace1` is the actual project-level sandbox root;
- `E:\workspace1\citybrain` is the Harness control directory;
- user data and pending datasets may live directly under `E:\workspace1`;
- Agent and QGIS writes cannot escape `E:\workspace1`;
- external directories require explicit read authorization;
- generic file tools cannot modify Harness-managed files.

```text
E:\workspace1\
├─ user data and source datasets
└─ citybrain\
   ├─ AGENTS.md
   ├─ workspace.json
   ├─ profile.md
   ├─ artifacts\
   │  ├─ process\
   │  └─ result\
   └─ .internal\
      ├─ tmp\
      ├─ logs\
      └─ state\
```

Process and result artifacts can currently be written to the corresponding
directories with explicit output paths. Automatic process/result routing is
not enabled yet.

### Quick Start

Requirements:

- Node.js `>= 22.19.0`;
- an API key for a supported model provider;
- a local `qgis_process` installation for spatial analysis.

```cmd
cd /d E:\Geo-agent
npm install
npm run dev
```

Build and link the CLI globally:

```cmd
cd /d E:\Geo-agent
npm run build
npm link
citybrain
```

### Commands

```text
/help
/new
/clear
/resume
/model [provider/model]
/thinking [off|high|max]
/qgis [setup|detect|list [filter]|info <algorithm>|use <path>|clear]
/init [<target-folder>]
/sandbox [add-read|remove-read <directory>]
/session
/login [provider]
/logout [provider]
/quit
/exit
```

Authorize an external data directory:

```text
/sandbox add-read E:\GeoAIOps\data
```

Inspect the active sandbox:

```text
/sandbox
```

### QGIS Runtime

At startup, CityBrain checks for a usable `qgis_process`. If none is found,
the setup flow offers:

```text
1. Install QGIS LTR locally
2. Configure existing QGIS path
3. Use Docker runtime
4. Connect remote QGIS runner
5. Continue without QGIS
```

The currently available path is local runtime configuration and validation
through `qgis_process --version`. The selected runtime is stored at:

```text
%USERPROFILE%\.citybrain\qgis-runtime.json
```

Docker and remote QGIS runners are extension points for later milestones.

### Logs and Sessions

Local configuration and sessions:

```text
%USERPROFILE%\.citybrain\auth.json
%USERPROFILE%\.citybrain\settings.json
%USERPROFILE%\.citybrain\models-store.json
%USERPROFILE%\.citybrain\qgis-runtime.json
%USERPROFILE%\.citybrain\sessions\
```

Set `CITYBRAIN_AGENT_DIR` to override the configuration directory.

Workspace logs:

```text
<sandbox>\citybrain\.internal\logs\tool-execution.jsonl
<sandbox>\citybrain\.internal\logs\context-usage.jsonl
<sandbox>\citybrain\.internal\logs\context-trace.jsonl
```

### Design Documents

- [Workspace initialization specification](WORKSPACE_INIT_SPEC.md)
- [Workspace sandbox design](WORKSPACE_SANDBOX_DESIGN.md)
- [Context and tool Harness design](CONTEXT_AND_TOOL_HARNESS_DESIGN.md)
- [Claude Code-style tool Harness plan](CLAUDE_CODE_STYLE_TOOL_HARNESS_PLAN.md)
- [Memory design](MEMORY_DESIGN.md)

### Limitations and Roadmap

Known limitations:

- the automated profile Worker is not complete;
- process/result artifact routing is not automatic;
- sandboxing is an application-level path policy, not OS-level isolation;
- Docker and remote QGIS runners are not implemented;
- deterministic metadata scanners for more data types are still needed;
- Windows path, junction/symlink, cancellation, and recovery tests need to be expanded.

Next directions:

1. Build a background profile Worker from tool logs and the artifact registry;
2. add deterministic metadata scanners for vector, raster, and tabular data;
3. use a subagent to turn verified facts into `profile.md`;
4. add an explicit `/profile refresh` command;
5. improve artifact routing, task directories, and lineage;
6. add stronger process-level isolation for QGIS jobs.

</details>
