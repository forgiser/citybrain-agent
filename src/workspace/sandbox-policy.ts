import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export type SandboxMode = "strict" | "analysis";

export interface WorkspaceManifest {
  version: 1;
  /** Harness/control directory, normally <projectDir>/citybrain. */
  workspaceRoot: string;
  /** User selected project/sandbox root, normally the folder passed to /init. */
  sandboxRoot: string;
  projectDir: string;
  mode: SandboxMode;
  readRoots: string[];
  createdAt: string;
  updatedAt: string;
}

const MANIFEST_NAME = "workspace.json";

export function getWorkspaceManifestPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, MANIFEST_NAME);
}

function getLegacyWorkspaceManifestPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".internal", MANIFEST_NAME);
}

export function createDefaultWorkspaceManifest(
  workspaceRoot: string,
  projectDir: string,
): WorkspaceManifest {
  const workspace = resolve(workspaceRoot);
  const project = resolve(projectDir);
  const now = new Date().toISOString();
  return {
    version: 1,
    workspaceRoot: workspace,
    sandboxRoot: project,
    projectDir: project,
    mode: "analysis",
    readRoots: uniquePaths([project]),
    createdAt: now,
    updatedAt: now,
  };
}

export function readWorkspaceManifest(
  workspaceRoot: string,
  fallbackProjectDir: string,
): WorkspaceManifest {
  const path = getWorkspaceManifestPath(workspaceRoot);
  const legacyPath = getLegacyWorkspaceManifestPath(workspaceRoot);
  const readablePath = existsSync(path)
    ? path
    : existsSync(legacyPath)
      ? legacyPath
      : undefined;
  if (!readablePath) {
    return createDefaultWorkspaceManifest(workspaceRoot, fallbackProjectDir);
  }

  try {
    const parsed = JSON.parse(readFileSync(readablePath, "utf8")) as Partial<WorkspaceManifest>;
    const manifest = normalizeManifest(parsed, workspaceRoot, fallbackProjectDir);
    return manifest;
  } catch {
    return createDefaultWorkspaceManifest(workspaceRoot, fallbackProjectDir);
  }
}

export function writeWorkspaceManifest(manifest: WorkspaceManifest): void {
  const path = getWorkspaceManifestPath(manifest.workspaceRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function addWorkspaceReadRoot(
  workspaceRoot: string,
  fallbackProjectDir: string,
  readRoot: string,
): WorkspaceManifest {
  const manifest = readWorkspaceManifest(workspaceRoot, fallbackProjectDir);
  const root = resolve(readRoot);
  const next: WorkspaceManifest = {
    ...manifest,
    readRoots: uniquePaths([...manifest.readRoots, root]),
    updatedAt: new Date().toISOString(),
  };
  writeWorkspaceManifest(next);
  return next;
}

export function removeWorkspaceReadRoot(
  workspaceRoot: string,
  fallbackProjectDir: string,
  readRoot: string,
): WorkspaceManifest {
  const manifest = readWorkspaceManifest(workspaceRoot, fallbackProjectDir);
  const target = normalizePath(resolve(readRoot));
  const protectedRoots = new Set([
    normalizePath(manifest.workspaceRoot),
    normalizePath(manifest.sandboxRoot),
    normalizePath(manifest.projectDir),
  ]);
  const next: WorkspaceManifest = {
    ...manifest,
    readRoots: manifest.readRoots.filter(
      (root) =>
        normalizePath(root) !== target ||
        protectedRoots.has(normalizePath(root)),
    ),
    updatedAt: new Date().toISOString(),
  };
  writeWorkspaceManifest(next);
  return next;
}

/**
 * Runtime path policy for one workspace. This is an application-level
 * sandbox: all tool-side writes are restricted to workspaceRoot, while
 * explicitly approved readRoots may be used as read-only inputs.
 */
export class SandboxPolicy {
  /** Harness/control directory, normally <projectDir>/citybrain. */
  readonly workspaceRoot: string;
  /** Actual filesystem sandbox root selected by the user. */
  readonly sandboxRoot: string;
  readonly projectDir: string;
  readonly mode: SandboxMode;
  readonly readRoots: readonly string[];

  constructor(manifest: WorkspaceManifest) {
    this.workspaceRoot = resolve(manifest.workspaceRoot);
    this.sandboxRoot = resolve(manifest.sandboxRoot);
    this.projectDir = resolve(manifest.projectDir);
    this.mode = manifest.mode;
    this.readRoots = uniquePaths([
      this.sandboxRoot,
      ...(manifest.mode === "strict"
        ? []
        : [...manifest.readRoots]),
    ]);
  }

  static fromWorkspace(
    workspaceRoot: string,
    fallbackProjectDir: string,
  ): SandboxPolicy {
    return new SandboxPolicy(
      readWorkspaceManifest(workspaceRoot, fallbackProjectDir),
    );
  }

  resolveReadPath(input: string, baseDir = this.projectDir): string {
    const value = cleanPathInput(input);
    if (!value) throw new Error("A non-empty path is required.");

    const candidates = isAbsolute(value)
      ? [resolve(value)]
      : [resolve(baseDir, value), resolve(this.workspaceRoot, value)];
    const candidate = candidates.find((path) => this.isReadable(path));
    if (!candidate) {
      throw new SandboxViolation(
        "read",
        candidates[0]!,
        this.readRoots,
      );
    }
    return candidate;
  }

  resolveWritePath(input: string, baseDir = this.sandboxRoot): string {
    const value = cleanPathInput(input);
    if (!value) throw new Error("A non-empty output path is required.");
    const target = isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
    this.assertWritable(target);
    return target;
  }

  assertReadable(path: string): void {
    if (!this.isReadable(path)) {
      throw new SandboxViolation("read", resolve(path), this.readRoots);
    }
  }

  assertWritable(path: string): void {
    const target = resolve(path);
    if (!isWithin(target, this.sandboxRoot)) {
      throw new SandboxViolation("write", target, [this.sandboxRoot]);
    }

    // A symlink/junction in an existing parent must not redirect a write
    // outside the workspace. The final target may not exist yet.
    const parent = nearestExistingParent(target);
    const canonicalParent = canonicalPath(parent);
    if (!isWithin(canonicalParent, canonicalPath(this.sandboxRoot))) {
      throw new SandboxViolation("write", target, [this.sandboxRoot]);
    }
  }

  isReadable(path: string): boolean {
    const target = resolve(path);
    return this.readRoots.some((root) => {
      if (!isWithin(target, root)) return false;
      const canonicalTarget = canonicalPath(target);
      return isWithin(canonicalTarget, canonicalPath(root));
    });
  }

  isWritable(path: string): boolean {
    try {
      this.assertWritable(path);
      return true;
    } catch {
      return false;
    }
  }

  getTempDir(): string {
    const tempDir = resolve(this.workspaceRoot, ".internal", "tmp");
    this.assertWritable(tempDir);
    mkdirSync(tempDir, { recursive: true });
    return tempDir;
  }

  getProcessEnvironment(): NodeJS.ProcessEnv {
    const tempDir = this.getTempDir();
    return {
      TEMP: tempDir,
      TMP: tempDir,
      TMPDIR: tempDir,
    };
  }

  describe(): string {
    return [
      `mode: ${this.mode}`,
      `sandbox root: ${this.sandboxRoot}`,
      `workspace/control dir: ${this.workspaceRoot}`,
      "read roots:",
      ...this.readRoots.map((root) => `  - ${root}`),
      `write root: ${this.sandboxRoot}`,
      `temp root: ${resolve(this.workspaceRoot, ".internal", "tmp")}`,
    ].join("\n");
  }
}

export class SandboxViolation extends Error {
  readonly operation: "read" | "write";
  readonly target: string;
  readonly allowedRoots: readonly string[];

  constructor(
    operation: "read" | "write",
    target: string,
    allowedRoots: readonly string[],
  ) {
    super(
      [
        `Sandbox denied ${operation} access.`,
        `target: ${target}`,
        `allowed: ${allowedRoots.join(", ")}`,
      ].join("\n"),
    );
    this.name = "SandboxViolation";
    this.operation = operation;
    this.target = target;
    this.allowedRoots = allowedRoots;
  }
}

function normalizeManifest(
  value: Partial<WorkspaceManifest>,
  workspaceRoot: string,
  fallbackProjectDir: string,
): WorkspaceManifest {
  const defaults = createDefaultWorkspaceManifest(workspaceRoot, fallbackProjectDir);
  const mode = value.mode === "strict" ? "strict" : "analysis";
  const readRoots = Array.isArray(value.readRoots)
    ? value.readRoots.filter((root): root is string => typeof root === "string")
    : defaults.readRoots;
  return {
    version: 1,
    workspaceRoot: resolve(
      typeof value.workspaceRoot === "string"
        ? value.workspaceRoot
        : defaults.workspaceRoot,
    ),
    sandboxRoot: resolve(
      typeof value.sandboxRoot === "string"
        ? value.sandboxRoot
        : defaults.sandboxRoot,
    ),
    projectDir: resolve(
      typeof value.projectDir === "string" ? value.projectDir : defaults.projectDir,
    ),
    mode,
    readRoots: uniquePaths(readRoots),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : defaults.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function cleanPathInput(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/u, "$2");
}

function uniquePaths(paths: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const resolved = resolve(path);
    const key = normalizePath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+/gu, sep).toLowerCase();
}

function isWithin(target: string, root: string): boolean {
  const targetKey = normalizePath(target);
  const rootKey = normalizePath(root);
  if (targetKey === rootKey) return true;
  const rel = relative(rootKey, targetKey);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function nearestExistingParent(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
