import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * CityBrain 项目工作区：随项目走、用户可见的目录骨架，承载中间产物、最终结果
 * 与内部状态。`/init` 手动初始化，首次问答时若缺失则按当前文件夹自动创建。
 */
export const WORKSPACE_DIR_NAME = "citybrain";

/**
 * 目录骨架（相对 workspace 根）。intermediate 预置两个 step，后续步骤由分析推进
 * 时按需新增；output 按产物类型分桶；.internal 为隐藏内部状态。
 */
const WORKSPACE_DIRECTORIES = [
  "intermediate/step-01",
  "intermediate/step-02",
  "output/maps",
  "output/reports",
  "output/data",
  ".internal/tmp",
  ".internal/profiles",
] as const;

export interface WorkspaceInfo {
  /** 项目根目录（绝对路径）。 */
  projectDir: string;
  /** workspace 目录（<projectDir>/citybrain）。 */
  workspaceDir: string;
  /** 本次新建的路径（文件或目录），已存在则不在列。 */
  created: string[];
  /** 调用前 workspace 是否已存在。 */
  alreadyInitialized: boolean;
}

export function getWorkspaceDir(projectDir: string): string {
  return join(resolve(projectDir), WORKSPACE_DIR_NAME);
}

export function isWorkspaceInitialized(projectDir: string): boolean {
  return existsSync(getWorkspaceDir(projectDir));
}

/**
 * 幂等地创建 workspace 骨架：目录一律 `recursive` 补齐；AGENT.md / config.json /
 * audit.log 只在缺失时写入，绝不覆盖用户已有内容。
 */
export function ensureWorkspace(projectDir: string): WorkspaceInfo {
  const projectDirResolved = resolve(projectDir);
  const workspaceDir = getWorkspaceDir(projectDirResolved);
  const alreadyInitialized = existsSync(workspaceDir);
  const created: string[] = [];

  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
    created.push(workspaceDir);
  }

  for (const relative of WORKSPACE_DIRECTORIES) {
    const dir = join(workspaceDir, relative);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  const agentMd = join(workspaceDir, "AGENT.md");
  if (!existsSync(agentMd)) {
    writeFileSync(agentMd, defaultAgentMd(basename(projectDirResolved)), "utf8");
    created.push(agentMd);
  }

  const configJson = join(workspaceDir, "config.json");
  if (!existsSync(configJson)) {
    writeFileSync(configJson, defaultConfig(basename(projectDirResolved)), "utf8");
    created.push(configJson);
  }

  const auditLog = join(workspaceDir, ".internal", "audit.log");
  if (!existsSync(auditLog)) {
    writeFileSync(auditLog, "", "utf8");
    created.push(auditLog);
  }

  return { projectDir: projectDirResolved, workspaceDir, created, alreadyInitialized };
}

function defaultAgentMd(name: string): string {
  return [
    "# AGENT.md",
    "",
    `${name} 的 CityBrain 项目说明（可选）。在此补充分析目标、数据来源与项目约定，供代理参考。`,
    "",
    "## 目标",
    "",
    "（一句话说明要完成的分析）",
    "",
    "## 数据",
    "",
    "（数据文件位置与说明）",
    "",
    "## 约定",
    "",
    "- 统一坐标系（CRS）：",
    "- 输出格式：",
    "- 命名规范：",
    "",
  ].join("\n");
}

function defaultConfig(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: 1,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
}
