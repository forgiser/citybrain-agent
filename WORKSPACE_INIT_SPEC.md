# CityBrain 工作区初始化规范

## 1. 文档目的

本文档定义 CityBrain 执行 `/init` 时创建的工作区结构、文件职责、内容格式和生命周期。

`/init <projectDir>` 中的 `projectDir` 是项目级 Sandbox 根目录，例如
`E:\workspace1`。`citybrain/` 是生成在该 Sandbox 内部的 Harness 控制目录，
用于保存画像、日志、内部状态和推荐的分析产物目录。

工作区的目标不是存放所有原始数据，而是作为 Agent 的：

- 数据分析过程承载区；
- 分析结果承载区；
- 工作区数据画像存储区；
- Harness 内部状态和审计区；
- 后续对话动态上下文的事实来源。

工作区必须满足以下约束：

```text
外部原生数据：保留在原位置，只读访问
推荐过程文件：写入 citybrain/artifacts/process/
推荐结果文件：写入 citybrain/artifacts/result/
画像文件：写入 citybrain/profile.md
工作区配置：写入 citybrain/workspace.json
内部状态：写入 citybrain/.internal/
实际 Sandbox 边界：projectDir，即 citybrain 的父目录。
```

## 2. 工作区目录结构

执行 `/init` 后，目标项目目录下创建：

```text
<projectDir>/
└─ citybrain/
   ├─ AGENTS.md
   ├─ workspace.json
   ├─ profile.md
   ├─ artifacts/
   │  ├─ process/
   │  └─ result/
   └─ .internal/
      ├─ tmp/
      ├─ logs/
      └─ state/
```

示例：

```text
E:\Geo-agent\
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

## 3. 权限和所有权模型

### 3.1 文件所有权

| 内容 | 主要维护者 | Agent 是否可以自动修改 |
|---|---|---:|
| `AGENTS.md` | 用户/项目维护者 | 否 |
| `workspace.json` | CityBrain Harness | 是 |
| `profile.md` | Agent 的画像流程 | 是 |
| `artifacts/process/` | QGIS/Agent 工具 | 是 |
| `artifacts/result/` | QGIS/Agent 工具 | 是 |
| `.internal/tmp/` | 工具执行器 | 是 |
| `.internal/logs/` | Harness 日志器 | 追加写入 |
| `.internal/state/` | Harness 状态管理器 | 是 |

### 3.2 读写边界

```text
citybrain/artifacts/process/  可读、可写
citybrain/artifacts/result/   可读、可写
citybrain/profile.md          可读、由画像流程更新
citybrain/workspace.json      可读、由 Harness 更新
citybrain/AGENTS.md           可读、默认禁止自动覆盖
citybrain/.internal/          仅由系统组件读写
projectDir/                   Sandbox 根目录，可读取；普通写入工具可写入非 Harness 管理路径
```

外部数据目录通过 `readRoots` 授权后只能读取，不能作为 Agent 或 QGIS 的输出目录。

## 4. `AGENTS.md`

### 4.1 作用

`AGENTS.md` 是项目级人工维护规则，用于描述：

- 当前项目的业务目标；
- 数据来源和业务含义；
- 坐标系约定；
- 字段命名规则；
- 结果命名规则；
- 输出格式要求；
- 数据质量要求；
- 禁止执行的操作；
- 人工确认点。

它属于项目指令，不属于自动生成的数据画像。

### 4.2 初始内容

如果文件不存在，`/init` 可以创建一个模板：

```markdown
# AGENTS.md

## 项目目标

请补充当前城市数据分析项目的目标。

## 数据来源

请补充外部原始数据目录、数据范围和来源说明。

## 坐标系约定

- 统一坐标系：
- 距离单位：
- 面积单位：

## 输出约定

- 过程数据保存位置：`citybrain/artifacts/process/`
- 结果数据保存位置：`citybrain/artifacts/result/`
- 文件命名规则：
- 默认输出格式：

## 安全约定

- 外部原始数据只读；
- 所有 Agent 产生的文件必须位于当前 sandboxRoot 内，推荐过程/结果产物进入 `citybrain/artifacts/`；
- 不得覆盖原始输入文件；
- 高风险操作需要用户确认。
```

### 4.3 生命周期

| 时机 | 行为 |
|---|---|
| `/init` 时不存在 | 创建模板 |
| `/init` 时已经存在 | 保留原文件，不覆盖 |
| 对话读取 | 注入动态 System Prompt 的项目约定区域 |
| 用户编辑后 | 下一轮对话重新读取 |
| Agent 任务结束 | 不自动修改 |
| 删除 workspace | 随 workspace 一起删除，但删除前需要用户确认 |

## 5. `workspace.json`

### 5.1 作用

`workspace.json` 是机器可读的工作区清单和 Sandbox 配置，是工作区路径和权限的权威来源。

它不应该被完整拼接到 System Prompt 中，只提取必要摘要。

### 5.2 推荐内容

```json
{
  "version": 1,
  "workspaceRoot": "E:\\workspace1\\citybrain",
  "sandboxRoot": "E:\\workspace1",
  "projectDir": "E:\\workspace1",
  "mode": "analysis",
  "readRoots": [
    "E:\\workspace1",
    "E:\\GeoAIOps\\data"
  ],
  "writeRoots": [
    "E:\\workspace1"
  ],
  "profile": {
    "path": "profile.md",
    "status": "stale",
    "version": 0,
    "updatedAt": null
  },
  "createdAt": "2026-09-19T00:00:00.000Z",
  "updatedAt": "2026-09-19T00:00:00.000Z"
}
```

### 5.3 字段说明

| 字段 | 说明 |
|---|---|
| `version` | 配置格式版本 |
| `workspaceRoot` | 当前 `citybrain` 控制目录的绝对路径 |
| `sandboxRoot` | 实际 Sandbox 根目录，即 `/init` 选择的项目目录 |
| `projectDir` | `/init` 选择的项目目录，当前与 `sandboxRoot` 一致 |
| `mode` | `strict` 或 `analysis` |
| `readRoots` | 允许读取的目录 |
| `writeRoots` | 允许写入的目录，当前等价于 `sandboxRoot` |
| `profile` | 画像文件状态和版本 |
| `createdAt` | 工作区首次创建时间 |
| `updatedAt` | 配置最近更新时间 |

### 5.4 生命周期

| 时机 | 行为 |
|---|---|
| `/init` 时不存在 | 创建默认配置 |
| `/init` 时已经存在 | 读取并校验，不重置用户配置 |
| `/sandbox add-read` | 更新 `readRoots` |
| `/sandbox remove-read` | 更新 `readRoots` |
| workspace 路径校验 | 检查 `workspaceRoot` 是否仍然有效 |
| 画像更新 | 更新 `profile.status`、版本和时间 |
| 工具执行 | 只读取策略，不允许工具自行修改权限 |
| 配置损坏 | 阻止写入型工具，并提示重新初始化或修复 |

## 6. `profile.md`

### 6.1 作用

`profile.md` 是当前工作区的数据画像，面向用户阅读，也作为动态 System Prompt 的事实来源。

它记录三类数据：

1. 外部原生数据；
2. workspace 内的过程数据；
3. workspace 内的结果数据。

原生数据可以位于 `citybrain` 外部，画像只记录其位置和分析结果，不代表文件已经被复制进 workspace。

### 6.2 推荐内容结构

```markdown
# Workspace Data Profile

## Profile Metadata

- Profile version:
- Generated at:
- Status:
- Workspace:

## Data Roots

### External Read Roots

- `E:\GeoAIOps\data`

### Workspace Artifact Roots

- `citybrain/artifacts/process`
- `citybrain/artifacts/result`

## Native Data

### Dataset: BER city boundary

- Origin: `external`
- Path: `E:\GeoAIOps\data\...\BER_city_boundary_osm`
- Format:
- CRS:
- Geometry type:
- Feature count:
- Extent:
- Fields:
- Last inspected:
- Status:

## Process Artifacts

### Dataset: buffer output

- Origin: `workspace`
- Path: `citybrain/artifacts/process/task-20260919-buffer-analysis/01-buffer/buffer_10m.gpkg`
- Producer:
- Source inputs:
- Algorithm:
- Parameters:
- CRS:
- Feature count:
- Created at:
- Status:

## Result Artifacts

### Result: buffer area statistics

- Origin: `workspace`
- Path: `citybrain/artifacts/result/task-20260919-buffer-analysis/buffer_area_stats.html`
- Producer:
- Source artifacts:
- Summary:
- Created at:
- Status:

## Data Lineage

```text
external input
  -> process artifact
  -> result artifact
```

## Known Issues

- 
```

### 6.3 画像状态

建议使用以下状态：

```text
empty      尚未生成画像
fresh      画像与当前文件状态基本一致
stale      有新产物或文件变化，等待重新生成
failed     画像生成失败
```

### 6.4 生命周期

| 时机 | 行为 |
|---|---|
| `/init` 时不存在 | 创建空模板 |
| `/init` 时已经存在 | 保留旧画像，校验后决定是否标记 `stale` |
| QGIS 任务完成 | 相关画像标记为 `stale` |
| 文件产物变化 | 相关画像标记为 `stale` |
| 任务结束 | 可根据策略自动刷新 |
| `/profile refresh` | 扫描授权目录和 workspace 产物并重建 |
| 下一轮对话 | 将画像摘要加入动态 System Prompt |
| 画像生成失败 | 保留旧版本，并标记 `failed` |

画像更新必须采用临时文件写入后原子替换，避免程序中断导致 `profile.md` 损坏。

### 6.5 画像的事实来源

`profile.md` 是一个派生视图，不是工作区唯一的事实来源。

真实事实来源包括：

```text
文件系统
workspace.json
ArtifactRegistry
工具执行日志
QGIS/GDAL 元数据探测结果
```

`profile.md` 负责将这些事实整理成用户和模型可以理解的摘要。画像内容不能覆盖真实文件状态，也不能代替 artifact 状态管理。

### 6.6 画像更新触发方式

画像支持以下更新触发方式：

| 触发方式 | 行为 |
|---|---|
| `/init` | 创建空画像模板或执行轻量扫描，不默认扫描全部大型数据 |
| QGIS 任务成功 | 将相关画像标记为 `stale`，记录新增或变化的产物 |
| 单次任务结束 | 扫描本次任务涉及的文件，执行增量更新或按策略延迟更新 |
| `/profile refresh` | 扫描授权读取目录和 workspace 产物，执行完整刷新 |
| 启动或恢复 session | 检查画像版本和文件指纹，必要时标记为 `stale` |
| 空闲维护阶段 | 对大型数据执行异步或分批画像更新 |

不建议每次工具调用后都执行完整扫描。大数据集应优先采用增量扫描和延迟刷新。

### 6.7 画像更新策略

画像更新采用以下策略：

```text
首次画像：全量建立
普通更新：增量扫描
显式刷新：全量校验
```

文件是否发生变化，可以优先通过以下轻量信息判断：

```text
规范化路径
文件大小
最后修改时间
文件格式
可选内容 hash
```

空间数据变化时，再读取以下元数据：

```text
CRS
几何类型
要素数量
空间范围
字段列表
栅格行列数
分辨率
NoData
```

如果文件指纹没有变化，则不重复执行昂贵的 QGIS/GDAL 元数据读取。

### 6.8 画像与 artifact 状态的关系

画像更新必须遵循 artifact 生命周期：

```text
工具计划生成文件
  -> artifact: pending
  -> 工具执行成功
  -> artifact: ready
  -> profile: stale
  -> 画像扫描器提取元数据
  -> profile: fresh
```

工具失败时：

```text
artifact: missing / invalid
profile: 保留旧版本，并记录失败信息
```

禁止在 QGIS 任务完成前将输出文件写入 `profile.md`，避免出现画像记录了不存在文件的情况。

### 6.9 外部原生数据画像

外部原生数据不复制到 workspace。画像只记录它们的引用和探测结果：

```markdown
### Dataset: BER city boundary

- Origin: external
- Path: `E:\GeoAIOps\data\...\BER_city_boundary_osm`
- Format:
- CRS:
- Geometry type:
- Feature count:
- Extent:
- Fields:
- Last inspected:
- Status: available
```

下一次刷新时需要检查：

- 路径是否仍然存在；
- 文件大小是否变化；
- 最后修改时间是否变化；
- CRS、字段和要素数量是否变化。

如果外部数据被移动或删除，不直接删除历史画像，而是将状态改为：

```text
unavailable
```

这样可以保留历史任务的可追溯性。

### 6.10 画像写入和失败恢复

画像更新必须采用临时文件和原子替换：

```text
生成 profile.md.tmp
完成内容校验
原子替换 profile.md
更新 workspace.json.profile
```

如果画像生成失败：

- 保留旧版 `profile.md`；
- 将 `workspace.json.profile.status` 设置为 `failed`；
- 在 `.internal/logs/` 中记录失败原因；
- 下一次刷新时继续尝试。

画像文件不允许由模型直接编辑，必须由画像流程统一生成。

### 6.11 动态 System Prompt 使用方式

下一轮对话不默认注入完整 `profile.md`，而是注入受限摘要：

```text
Profile status
Profile updated time
External dataset count
Process artifact count
Result artifact count
Recent process artifacts
Recent result artifacts
Known issues
```

完整 `profile.md` 仍然保存在 workspace 中，Agent 需要详细信息时再通过 `read_file` 读取。

## 7. `artifacts/`

`artifacts/` 是用户可访问的分析产物区域。

### 7.1 `artifacts/process/`

保存分析过程中的中间文件，例如：

- 缓冲区结果；
- 裁剪结果；
- 投影转换结果；
- 字段计算结果；
- 临时但需要保留的空间数据；
- 下一步算法需要继续使用的数据。

过程文件应保留必要的来源信息，不能直接覆盖原始输入。

### 7.2 `artifacts/result/`

保存面向用户的最终分析结果，例如：

- 最终矢量或栅格结果；
- 统计表；
- HTML 报告；
- CSV 汇总；
- 分析摘要；
- 可视化结果。

### 7.3 文件生命周期

```text
planned
  -> pending
  -> ready
  -> stale / invalid / deleted
```

具体规则：

| 时机 | 行为 |
|---|---|
| QGIS 执行前 | 预登记预计输出路径 |
| QGIS 执行中 | 文件状态为 `pending` |
| QGIS 成功完成 | 校验文件并标记 `ready` |
| QGIS 失败 | 标记为 `missing` 或 `invalid` |
| 文件被外部删除 | 下一次访问时标记为 `deleted` 或 `missing` |
| 文件被新任务覆盖 | 默认拒绝，除非用户或策略明确允许 |
| 任务结束 | 更新画像状态为 `stale` |
| workspace 删除 | 删除前必须经过用户确认 |

过程文件和结果文件不按照文件格式自动分类。分类应由任务规划阶段、工具参数
或用户明确指定；如果没有明确分类，默认写入 `artifacts/` 根目录或当前任务
专属目录，不应根据扩展名猜测。

### 7.4 任务级目录隔离

`artifacts/process/` 和 `artifacts/result/` 不应把所有任务文件直接平铺在根目录下。
建议按照任务和步骤组织：

```text
artifacts/
├─ process/
│  └─ task-20260919-buffer-analysis/
│     ├─ 01-buffer/
│     │  └─ buffer_10m.gpkg
│     ├─ 02-field-calculator/
│     │  └─ buffer_area.gpkg
│     └─ 03-statistics/
│        └─ area_stats.csv
└─ result/
   └─ task-20260919-buffer-analysis/
      ├─ buffer_area_stats.html
      └─ summary.csv
```

其中：

- `task-id` 表示一次完整分析任务；
- `step-id` 表示任务中的具体处理步骤；
- 过程文件可以被后续步骤继续使用；
- 结果文件面向用户查看或交付；
- 重复执行同一类任务时，应生成新的任务目录；
- 默认不覆盖既有任务产物；
- 原始外部数据只记录引用路径，不复制到 `artifacts/`。

如果任务没有明确指定过程或结果分类，可以先写入当前任务专属目录，
不能根据文件扩展名自动猜测分类。

## 7.5 基础文件编辑工具

CityBrain 提供两个基础写入工具：

```text
write_file  创建新文件或完整重写文件
edit_file   基于 old_string -> new_string 的精确替换
```

两者都必须经过 `SandboxPolicy`，只能写入当前 `sandboxRoot`。工具不允许写入
sandbox 外部路径，也不允许修改 `citybrain/.internal/`、`AGENTS.md`、
`workspace.json` 和 `profile.md` 等 Harness 管理文件。

### `write_file`

适用于：

- 创建新的文本文件；
- 完整重写已经读取过的 workspace 文件；
- 生成任务说明、CSV、HTML、Markdown 等文本产物。

如果目标文件已存在，必须先通过 `read_file` 完整读取。写入前会再次读取
当前文件，并用文件大小、修改时间和内容指纹检查读取后是否发生变化。

### `edit_file`

适用于：

- 修改已有文本文件中的一处内容；
- 在明确位置追加或替换内容；
- 对一个文件执行精确、可验证的局部修改。

`old_string` 必须存在：

- 匹配 0 次：失败；
- 匹配 1 次：执行替换；
- 匹配多次且 `replace_all` 为 `false`：失败并要求提供更多上下文；
- `replace_all` 为 `true`：替换全部匹配。

编辑前同样要求先完整读取文件，并检查文件在读取后没有被用户、编辑器
或其他工具修改。

### 写入一致性

两个工具都采用：

```text
读取当前文件
  -> 校验读取快照
  -> 写入同目录临时文件
  -> flush/sync
  -> 原子替换目标文件
```

这样可以避免进程中断时留下半个文件。工具还会尽量保留原文件的
`LF` 或 `CRLF` 换行风格。

### 工具结果

工具结果只返回路径、操作类型、替换次数和大小等摘要，不把完整文件内容
重复塞回对话上下文。工具执行过程仍然记录到 `.internal/logs/`。

## 8. `.internal/tmp/`

### 8.1 作用

保存短生命周期的运行时临时文件：

- QGIS 临时输出；
- QGIS 环境探测脚本；
- 中间转换临时文件；
- 上下文压缩临时内容；
- 原子写入时的临时文件；
- 工具执行过程中的临时缓存。

### 8.2 生命周期

```text
工具开始
  -> 创建临时文件
  -> 工具执行
  -> 成功后删除
  -> 失败时保留短期诊断文件
  -> 下次启动时清理过期文件
```

临时目录不得作为用户最终结果目录，也不应被加入动态 System Prompt。

## 9. `.internal/logs/`

### 9.1 作用

保存 Harness 可观测性和安全审计日志：

```text
.internal/logs/
├─ tool-execution.jsonl
├─ context-trace.jsonl
├─ context-usage.jsonl
└─ audit.jsonl
```

### 9.2 日志内容

工具执行日志至少应包含：

- 时间；
- run ID；
- turn；
- tool call ID；
- 工具名称；
- 参数摘要；
- 开始、进度和结束事件；
- 执行耗时；
- 成功或失败状态；
- 错误信息；
- 产物路径；
- sandbox policy 结果。

### 9.3 生命周期

| 时机 | 行为 |
|---|---|
| 工具开始 | 追加 start 事件 |
| 工具运行 | 追加 progress 事件 |
| 产物状态变化 | 追加 artifact 事件 |
| 工具结束 | 追加 finish 事件 |
| sandbox 拒绝 | 记录 policy denied 事件 |
| 会话恢复 | 继续追加，不覆盖历史 |
| 日志过大 | 按日期或 run 分片归档 |
| workspace 删除 | 与 workspace 一起删除，删除前需要确认 |

日志文件采用 JSONL 追加写入，不允许模型直接编辑。

## 10. `.internal/state/`

### 10.1 作用

保存恢复运行所需的机器状态，例如：

- artifact registry 快照；
- 当前任务状态；
- 画像索引；
- 任务与文件的依赖关系；
- 未完成任务；
- workspace 锁；
- 版本迁移状态。

### 10.2 生命周期

| 时机 | 行为 |
|---|---|
| `/init` | 创建空状态目录 |
| 工具预执行 | 写入 pending 状态 |
| 工具完成 | 更新 ready、missing 或 invalid |
| Agent 中断 | 保留未完成状态 |
| 下次启动 | 读取并恢复可恢复状态 |
| 状态损坏 | 使用日志重建，不能静默覆盖 |
| workspace 删除 | 一并删除 |

## 11. 初始化流程

### 11.1 `/init` 执行步骤

```text
1. 确认目标 projectDir
2. 设定 sandboxRoot = projectDir
3. 计算 workspaceRoot = projectDir/citybrain
4. 创建 workspaceRoot
5. 创建 artifacts/process
6. 创建 artifacts/result
7. 创建 .internal/tmp
8. 创建 .internal/logs
9. 创建 .internal/state
10. 创建 workspace.json
11. 创建 AGENTS.md 模板（如果不存在）
12. 创建 profile.md 模板（如果不存在）
13. 校验 workspaceRoot 和 sandboxRoot 的真实路径
14. 激活当前 session 的 SandboxPolicy
15. 在 CLI 中显示 sandbox 和 citybrain 状态
```

### 11.2 幂等要求

重复执行 `/init` 不得：

- 删除已有文件；
- 覆盖 `AGENTS.md`；
- 覆盖已有 `profile.md`；
- 清空 `artifacts/`；
- 重置用户配置的 `readRoots`；
- 删除未完成任务状态。

重复执行只能补齐缺失目录和缺失的系统文件。

## 12. 任务结束流程

任务完成后，Harness 应执行：

```text
1. 等待所有工具结束
2. 完成 artifact 状态收敛
3. 校验过程文件和结果文件
4. 标记 profile 为 stale
5. 根据配置决定是否刷新 profile
6. 写入任务总结
7. 清理过期 tmp 文件
8. 保留 logs 和 state
```

默认不应该每次自动执行完整画像扫描。对于大型空间数据，建议：

- 小文件任务：任务结束后自动刷新；
- 大型数据任务：标记 `stale`，由 `/profile refresh` 或下一次空闲时刷新；
- 画像生成失败：保留上一个可用版本。

## 13. 下一轮动态 System Prompt

下一轮对话只注入必要摘要：

```text
Workspace:
- root
- sandbox mode
- read roots
- write roots

Project instructions:
- AGENTS.md 摘要

Data profile:
- profile 状态
- profile 更新时间
- 关键外部原生数据
- 最近过程产物
- 最近结果产物

Artifact state:
- pending
- ready
- missing
- invalid

Current task:
- 当前目标
- 已完成步骤
- 未完成步骤
```

完整 `profile.md`、`AGENTS.md` 和日志不应默认全部放入上下文。

## 14. 删除、迁移和恢复

### 14.1 删除

删除 workspace 前必须提示用户确认，并明确：

- 将删除过程文件；
- 将删除结果文件；
- 将删除画像和内部日志；
- 外部原生数据不会被删除。

### 14.2 workspace 移动

如果 workspace 被移动，启动时应检测：

- `workspace.json.workspaceRoot` 是否匹配当前真实路径；
- 当前 session 是否仍然绑定旧路径；
- artifacts 和 profile 是否仍然存在。

路径不一致时进入 `needs_reinit` 或迁移流程，不应直接写入未知目录。

### 14.3 版本迁移

`workspace.json.version` 发生变化时，由 Harness 执行显式迁移：

```text
version 1 -> version 2
```

迁移过程中不得删除用户文件，失败时保留迁移前状态并记录日志。

## 15. 当前实现需要对齐的内容

当前代码中已有 workspace、日志、artifact 和 sandbox 基础，但初始化结构仍需要逐步对齐本文档：

1. 将旧的 `AGENT.md` 统一为 `AGENTS.md`；
2. 删除初始化时预创建的 `intermediate/step-*`；
3. 删除 `output/maps`、`output/reports`、`output/data` 的固定分类；
4. 使用 `artifacts/process` 和 `artifacts/result`；
5. 将日志统一收敛到 `.internal/logs/`；
6. 将 artifact 和恢复状态统一收敛到 `.internal/state/`；
7. 将 `profile.md` 放到 workspace 根目录；
8. 让 QGIS 输出分类由任务或参数明确指定，不根据文件扩展名自动判断；
9. 保持外部原生数据原地保存，只通过 `readRoots` 读取；
10. 将画像摘要接入动态 System Prompt；
11. 将 `write_file` 和 `edit_file` 的文件快照、冲突检测和原子写入接入
    更完整的 Harness artifact 生命周期。
