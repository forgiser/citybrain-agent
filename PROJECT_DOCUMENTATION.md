# Geo-agent（CityBrain）项目理解文档

> 生成日期：2026-09-17
> 本文档用于记录对 `E:\Geo-agent` 项目现状、已完成内容、架构设计及后续方向的理解，供后续开发参考。

---

## 1. 项目定位与目标

**Geo-agent（项目内部代号 `CityBrain`）** 是一个**仿 [pi-agent](https://github.com/earendil-works/pi-agent) 风格的 TypeScript 终端 Shell（Agent 外壳）**，面向未来的**城市地理空间数据分析 / 城市数据治理**工作流。

项目的最终目标是：

> **基于 QGIS 的命令行工具 `qgis_process`，让 Agent（LLM）能够通过自然语言驱动各种针对地理空间数据的分析与处理操作。**

即：用户在城市地理数据工作区里输入自然语言指令，CityBrain 通过 LLM 调用内置工具，最终把任务翻译成对 `qgis_process` 的调用，完成空间数据（矢量 / 栅格）的分析处理。

为了达成这个目标，项目采用了与 pi-agent 高度一致的终端体验与 Agent 架构，先把「终端外壳 + LLM 接入 + 工具调用 + 会话管理」这套地基打好，**再逐步接入 QGIS 处理能力**。

---

## 2. 与 pi-agent 的关系

Geo-agent 是**以 pi-agent（`E:\pi-agent-main`）为参考模板、独立重写**的一个轻量项目。

### pi-agent 是什么

pi-agent 是一个**多包 monorepo**，核心是「自扩展的编码 Agent」，提供了终端 TUI、统一多供应商 LLM 接口、Agent 运行时、会话后端（sqlite）等一系列可复用库：

| pi-agent 包 | 作用 | Geo-agent 的对应物 |
|---|---|---|
| `@earendil-works/pi-tui` | 终端差异化渲染 UI 库 | **直接复用** `@earendil-works/pi-tui` |
| `@earendil-works/pi-ai` | 统一多供应商 LLM API（OpenAI/Anthropic/Google…） | 自研 `src/models/*`（轻量 adapter） |
| `@earendil-works/pi-agent-core` | Agent 运行时、工具调用、状态管理 | 自研 `src/agent/agent-loop.ts` |
| `@earendil-works/pi-coding-agent` | 交互式编码 Agent CLI | 自研 `src/app/*` + `src/cli/*` |
| `@earendil-works/chord` | 服务 / 复制状态 / RPC / 插件运行时 | 暂未用到（未来扩展玩法参考） |
| `@earendil-works/pi-telemetry` | 遥测契约 | 未用到 |

> **关键点**：pi-agent 本身**与 QGIS 无任何关系**（代码库中检索不到 `qgis` 字样）。Geo-agent 的独特价值正是在 pi 这套成熟的终端 + Agent 范式之上，**嫁接 QGIS 空间分析能力**。

### pi-agent 移植/借鉴的产物

Geo-agent 保留了 pi 的**用户交互体验**（见第 5 节），包括：
- Pi 风格的终端渲染布局；
- 交互式文本编辑器、斜杠命令弹出框、模糊匹配、方向键选择；
- 流式聊天、思维（reasoning）内容灰色斜体展示；
- 底部 Pi 风格状态栏（token 用量 / 费用占位 / 上下文占用 / 活动模型）；
- 追加式 JSONL 会话存储、显式会话恢复流程。

---

## 3. 技术栈

| 项 | 值 |
|---|---|
| 语言 | TypeScript（ESM，NodeNext） |
| 运行时 | **Node.js >= 22.19.0** |
| 终端 UI | `@earendil-works/pi-tui` 0.85.1 |
| CLI 解析 | `commander` 14.0.0 |
| LLM SDK | `openai` 6.40.0（兼容 OpenAI / DeepSeek / Qwen / OpenRouter） |
| 构建 | `tsc`，入口 `dist/main.js`，包名 `citybrain`，bin 为 `citybrain` |
| 开发启动 | `npm run dev`（`tsx src/main.ts`） |

---

## 4. 当前状态（重点：已完成内容）

### 4.1 当前里程碑：CLI 终端体验完整可用

按 `README.md`，当前里程碑聚焦 CLI 与 Agent 基础，**已完成**：

- ✅ Pi 风格终端渲染
- ✅ 交互式文本编辑器
- ✅ 斜杠命令弹出框（`/` 唤起）
- ✅ 模糊命令匹配
- ✅ 方向键命令选择
- ✅ 本地供应商 API Key 登录
- ✅ 供应商模型探测与模型缓存
- ✅ 活动模型选择
- ✅ 最小化 Agent 循环（流式聊天）
- ✅ 持久化 JSONL 聊天会话
- ✅ 显式会话恢复流程（`/resume`）
- ✅ `read_file` 工具（首个内置工具，agent 可读取工作区内 UTF-8 文本）

### 4.2 当前 Shell 命令清单

当前 `src/app/shell-commands.ts` 中注册的命令（含中文描述，合成自源码 / README 英文）：

```text
/new       开启一个新的对话消息
/help      展示可用的命令
/clear     清除当前的对话内容
/resume    恢复之前的对话消息
/model     选择当前的模型        <provider/model>
/thinking  设置思考等级           <off|high|max>
/qgis      检测/配置 QGIS Processing 环境   <detect|use <path>|clear>
/login     保存供应商 API 密钥   <provider>
/logout    删除保存的 API 密钥   <provider>
/session   展示当前会话信息
/quit      退出（别名 /exit）
```

### 4.3 供应商 / 模型接入

已接入的供应商模型通道：

- **OpenAI / DeepSeek / Qwen / OpenRouter**：走官方 `openai` SDK，共用一个兼容性 adapter；
- **Anthropic / Google Gemini**：走轻量 legacy adapter。

登录密钥本地存储于：`%USERPROFILE%\.citybrain\auth.json`
（可用环境变量 `CITYBRAIN_AGENT_DIR` 覆盖目录，不可提交到版本库）

其它 `%USERPROFILE%\.citybrain\` 下的状态文件：

| 文件 | 内容 |
|---|---|
| `settings.json` | 活动模型选择 |
| `models-store.json` | 最近一次成功的模型探测缓存 |
| `sessions/` | JSONL 会话文件（追加式：首行 header，后续为 message/model-change 条目，含 `id/parentId/timestamp/type`） |
| `qgis-runtime.json` | 配置的 qgis_process 路径（见第 6 节） |

启动时会**并发刷新已保存供应商的模型**；探测失败则回退到缓存并在终端提示。

### 4.4 Agent 循环

`src/agent/agent-loop.ts` 中的 `AgentLoop`：
- 组装 system + 历史上下文 + 用户输入；
- 通过`流式 model-chat` 迭代最多 **4 轮**工具循环；
- 支持 `thinking` / `text` / `toolCall` 三种流式增量；
- 工具执行后把 `role: tool` 结果回填，直到模型给出最终回复；
- 结束把 assistant 回复（含思维、usage）写入会话。

当前注册给模型的工具**仅 `read_file`**（相对路径校验、工作区越界拦截、UTF-8 读取、20,000 字符截断）。

### 4.5 QGIS 环境检测已打通（但仅到「环境」层面）

在当前 `src/` 中，QGIS 相关的**唯一**实现是 `src/qgis/qgis-runtime.ts`，它完成：

- **`detectQgisRuntime()`**：先读配置，再用候选列表探测 `qgis_process --version`；
- **`findQgisCandidates()`**：候选来源依次为
  - 环境变量 `CITYBRAIN_QGIS_PROCESS`、`QGIS_PROCESS`
  - `PATH` 中的常见 qgis_process 名称
  - 常见安装目录（`C:\qgis\bin`、`C:\OSGeo4W\bin`、`C:\OSGeo4W64\bin`、`Program Files` 下以 `qgis` 开头的目录的 `bin`）
- **`/qgis` 命令**（`interactive-app.ts` 已接线）：`/qgis` 显示状态、`/qgis detect`、`/qgis use <path>`、`/qgis clear`；
- 启动时自动探测，并把状态显示在终端头部（未找到时提示使用 `/qgis`）；
- 成功路径保存到 `%USERPROFILE%\.citybrain\qgis-runtime.json`。

> **重要界定**：当前 `/qgis` 只完成 **QGIS 运行时的「发现 + 校验 + 配置」**，尚不能真正调用算法去执行空间分析。真正执行 `qgis_process` 做算法运算，是项目**下一步/最终目标**（详见第 7 节）。
>
> **2026-09-17 更新**：启动时若未检测到 QGIS 运行时，会自动弹出设置菜单（5 个选项：本地安装 LTR 引导 / 配置已有路径（候选列表 + 手动输入）/ Docker 运行时（占位）/ 远程 runner（占位）/ 跳过），`/qgis setup` 可随时重新打开。相关新文件：`src/qgis/qgis-setup.ts`、`src/qgis/path-input-dialog.ts`；`src/auth/secret-input.ts` 已支持非掩码输入。

---

## 5. 项目结构

### 5.1 当前源码 `src/`（活跃、与运行一致）

```text
Geo-agent/
|-- src/
|   |-- main.ts                    # 入口：装载 CLI
|   |-- cli/cli.ts                 # CLI 解析 & 启动交互应用
|   |-- agent/agent-loop.ts        # Agent 循环（工具调用 + 流式）
|   |-- app/interactive-app.ts     # Pi 风格交互式主界面（命令分发、QGIS 状态）
|   |-- app/shell-commands.ts      # Shell 命令注册表
|   |-- auth/                      # API Key 认证存储 / 登录对话框 / describe 输入
|   |   |-- auth-storage.ts  providers.ts  login-dialog.ts  secret-input.ts
|   |-- models/                    # 模型目录、聊天、探测、store、settings、runtime
|   |   |-- model-catalog  model-chat  model-probe  model-runtime  model-store  model-settings
|   |-- qgis/qgis-runtime.ts       # QGIS 运行时探测/配置（见 4.5）
|   |-- session/                   # 会话管理与类型
|   |   |-- session-manager.ts  session-types.ts
|   |-- tools/read-file.ts         # 内置 read_file 工具
|-- config/                        # （空占位，尚未使用）
|-- extensions/                    # （空占位，未来扩展）
|-- dist/                          # 构建产物（与当前 src 不一致，见 5.2 警示）
|-- package.json / tsconfig.json / README.md
```

### 5.2 重要警示：`dist/` 中存在「过期架构」

**`dist/` 是历史某次构建的产物，包含当前 `src/` 中并不存在的模块**。这些模块反映了项目**早期更完整的设计意图**，对理解目标架构很有参考价值，但**尚未落地到 `src/`**。当前 `tsconfig.json` `include: ["src/**/*.ts"]`，因此这些 `dist` 文件不会参与当前构建，**不要误以为它们是现成实现**。

`dist/` 中过期但值得参考的 QGIS / Agent 设计模块：

```
dist/qgis/qgis-process-client.d.ts     → qgis_process 抽象：execute / listAlgorithms / describeAlgorithm
dist/qgis/qgis-algorithm-catalog.d.ts  → 算法目录：refresh / get / list；算法描述含参数/所属 provider
dist/qgis/qgis-tool-factory.d.ts       → 把算法描述批量生成 ToolDefinition
dist/qgis/qgis-environment.d.ts        → 环境探测：detect() → {available, processPath, version}
dist/tools/tool-registry.d.ts          → 工具注册表
dist/harness/agent-harness.d.ts        → 一次完整 run 的应用级所有权（会话/审批/扩展/工具调度）
dist/harness/approval-gate.d.ts        → 审批门控
dist/domain/spatial.d.ts               → 空间数据领域模型（格式/Layer/Extent/CRS）
dist/domain/agent.d.ts                 → Agent 领域模型
dist/sessions/session-store.d.ts       → 会话存储抽象 + file-session-store
dist/integrations/pi/pi-runtime-adapter.d.ts → 对接 pi 的 runtime adapter
dist/ui/terminal-renderer.d.ts         → 终端渲染器
dist/config/config-{types,loader}.d.ts → 配置加载
```

> 这些 `.d.ts` 与对应 `.js` 一起躺在 `dist/`，**很像一次或多阶段迭代中被 `src` 精简掉的前置架构**。真实 QGIS 执行能力（`qgis_process-client` → `qgis-algorithm-catalog` → `qgis-tool-factory` → 注册为 agent 工具）正是项目最终要落地的目标，本文件第 7 节据此给出路线建议。

---

## 6. QGIS 集成：目标、现状与差距

### 6.1 目标（远景）
Agent 工具链最终应能：
1. **发现** qgis_process 运行时；（✅ 已完成）
2. **校验**版本 / 环境；（✅ 已完成）
3. **枚举算法** `qgis_process list`；（❌ 待做）
4. **描述算法参数** `qgis_process help <algo>`，转成结构化 ToolDefinition；（❌ 待做）
5. **执行算法** `qgis_process run <algo> --param=...`，以 json 输入/输出处理参数与图层；（❌ 待做）
6. 把「执行空间分析」作为工具暴露给 Agent，形成自然语言 → 空间分析的闭环。（❌ 待做）

### 6.2 差距对照

| 能力 | 当前 `src/` | 过期 `dist/` 设计 |
|---|---|---|
| 运行时发现/配置 | ✅ 已实现 | ✅ 曾设计（环境检测） |
| 进程执行封装 | ❌ | ✅ 曾设计（process-client） |
| 算法目录/枚举 | ❌ | ✅ 曾设计（algorithm-catalog） |
| 算法→工具工厂 | ❌ | ✅ 曾设计（tool-factory） |
| 工具注册表 | ❌（仅内联 read_file） | ✅ 曾设计（tool-registry） |
| 语义空间领域模型 | ❌ | ✅ 曾设计（domain/spatial） |
| Agent Harness / 审批 | ❌ | ✅ 曾设计（harness/*） |

---

## 7. 使用 / 运行方式

```cmd
cd /d E:\Geo-agent
npm install
npm run dev        # 开发启动（tsx）
```

全局安装（可选）：

```cmd
npm run build
npm link
citybrain
```

卸载全局链接：`npm unlink -g citybrain`

交互说明：启动出现 `CITYBRAIN` 头部 → 输入 `/` 弹出命令托盘 → 输入字母过滤 → 方向键选择 → 回车执行。`/login` 登录供应商后 `/model` 选模型，即可开始对话。退出需在 2 秒内连按两次 `Ctrl+C`；`Ctrl+D` 不退出。

---

## 8. 后续建议路线（Roadmap）

> **2026-09-17 起正式路线以 [ROADMAP.md](ROADMAP.md) 为准**（M1 执行层 + 3 个通用工具 → M2 精细化工具 → M3 Harness/审批 → M4 Docker/远程）。以下为早期的方向性建议，保留作参考。

基于去世的 `dist/` 架构蓝图与项目目标，建议逐步推进：

1. **补齐 QGIS 进程执行层**：回到 `src/qgis/`，新增 `qgis-process-client`（复用 `qgis-runtime.ts` 的 `execFile` 封装），实现 `listAlgorithms` / `describeAlgorithm` / `execute`。
2. **算法目录 + 算法→工具工厂**：用 `qgis_process list --json` 拉取算法清单，`help --json` 拉取参数，转为结构化描述并批量生成工具定义。
3. **注册为 Agent 工具**：把生成的 QGIS 工具并入 AgentLoop 的工具分发表（当前仅 `read_file`），支持执行模式/审批。
4. **空间领域模型**：引入 `dist/domain/spatial.d.ts` 的设计（LayerRef / Extent / CRS / format），为图层输入输出建立统一约定。
5. **分层收拢**：视需要把 Harness / 审批门控 / 会话后端 / 扩展机制从蓝图落到实现。
6. **清理**：明确 `dist/` 与 `src/` 的差异，避免历史产物误导（可删可留，但要在文档中说明）。

---

## 9. 其它杂项

- `11.txt`：空文件（0 字节），疑为临时占位/误创建。
- `config/`、`extensions/`：空占位目录，尚未启用。
- 会话采用 pi 风格追加式 JSONL，首行 header，条目带 `id/parentId/timestamp/type`；启动默认新建空会话，`/resume` 恢复。
- `/qgis`、`/model`、`/login` 等命令已接线到交互应用；`/model` 可直接带参（如 `/model openai/gpt-4o`）。

---

*本文档基于对 `E:\Geo-agent` 与 `E:\pi-agent-main` 两处源码的静态阅读整理，未执行运行时验证；`dist/` 内各类按期不起作用的产物已在 5.2 中单独标注。*