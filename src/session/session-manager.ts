import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { getCityBrainDir } from "../auth/auth-storage.js";
import { getContextTokensFromUsage } from "../context/context-usage.js";
import {
  createCompactionPlan,
  estimateMessages,
  type CompactionPlan,
} from "../context/context-compaction.js";
import { getWorkspaceDir as resolveWorkspaceDir } from "../workspace/workspace.js";
import { readWorkspaceManifest } from "../workspace/sandbox-policy.js";
import type { ChatMessage, ModelUsage } from "../models/model-chat.js";
import type {
  ContextUsage,
  ModelChangeEntry,
  SessionEntry,
  SessionFileEntry,
  SessionHeader,
  SessionInfo,
  SessionMessage,
  SessionMessageEntry,
  CompactionEntry,
  ContextReplacementEntry,
  SessionEntryBase,
} from "./session-types.js";
import type { PersistedToolResultProjection } from "../context/context-projection.js";

const SESSION_VERSION = 1;
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function getSessionsRoot(): string {
  return join(
    process.env.CITYBRAIN_SESSIONS_DIR?.trim() || join(getCityBrainDir(), "sessions"),
  );
}

function getSessionDirectory(cwd: string, sessionsRoot: string): string {
  const safeCwd = resolve(cwd)
    .replace(/^[/\\]/u, "")
    .replace(/[/\\:]/gu, "-");
  return join(sessionsRoot, `--${safeCwd}--`);
}

function createSessionId(): string {
  return randomUUID();
}

function createEntryId(): string {
  return randomUUID().replace(/-/gu, "").slice(0, 8);
}

function createSessionFile(sessionDirectory: string, createdAt: string, id: string): string {
  const fileTimestamp = createdAt.replace(/[:.]/gu, "-");
  return join(sessionDirectory, `${fileTimestamp}_${id}.jsonl`);
}

function parseFileEntries(path: string): SessionFileEntry[] {
  const raw = readFileSync(path, "utf8");
  const entries: SessionFileEntry[] = [];

  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isSessionFileEntry(parsed)) {
      entries.push(parsed);
    }
  }

  return entries;
}

export class SessionManager {
  private constructor(
    private header: SessionHeader,
    private sessionFile: string,
    private entries: SessionEntry[],
  ) {}

  static create(cwd: string = process.cwd(), sessionsRoot: string = getSessionsRoot()): SessionManager {
    const header = createHeader(cwd);
    const sessionDirectory = getSessionDirectory(header.cwd, sessionsRoot);
    const sessionFile = createSessionFile(sessionDirectory, header.timestamp, header.id);
    return new SessionManager(header, sessionFile, []);
  }

  static continueRecent(
    cwd: string = process.cwd(),
    sessionsRoot: string = getSessionsRoot(),
  ): SessionManager {
    const sessions = SessionManager.list(cwd, sessionsRoot);
    const recent = sessions[0];
    return recent ? SessionManager.open(recent.path) : SessionManager.create(cwd, sessionsRoot);
  }

  static open(path: string): SessionManager {
    const sessionFile = resolve(path);
    if (!existsSync(sessionFile)) {
      throw new Error(`Session file does not exist: ${sessionFile}`);
    }

    const fileEntries = parseFileEntries(sessionFile);
    const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
    if (!header || header.version !== SESSION_VERSION) {
      throw new Error(`Invalid CityBrain session file: ${sessionFile}`);
    }

    const entries = fileEntries.filter(
      (entry): entry is SessionEntry => entry.type !== "session",
    );
    return new SessionManager(header, sessionFile, entries);
  }

  static list(
    cwd: string = process.cwd(),
    sessionsRoot: string = getSessionsRoot(),
  ): SessionInfo[] {
    const sessionDirectory = getSessionDirectory(cwd, sessionsRoot);
    if (!existsSync(sessionDirectory)) return [];

    return readdirSync(sessionDirectory)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => {
        const path = join(sessionDirectory, name);
        try {
          const manager = SessionManager.open(path);
          const stat = statSync(path);
          return [manager.getInfo(stat.mtimeMs)];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
  }

  /** List persisted sessions for every project, used by project-agnostic hosts such as Web UI. */
  static listAll(sessionsRoot: string = getSessionsRoot()): SessionInfo[] {
    if (!existsSync(sessionsRoot)) return [];
    return readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((directory) => {
        const path = join(sessionsRoot, directory.name);
        return readdirSync(path)
          .filter((name) => name.endsWith(".jsonl"))
          .flatMap((name) => {
            const sessionPath = join(path, name);
            try {
              const manager = SessionManager.open(sessionPath);
              return [manager.getInfo(statSync(sessionPath).mtimeMs)];
            } catch {
              return [];
            }
          });
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
  }

  getSessionId(): string {
    return this.header.id;
  }

  getSessionFile(): string {
    return this.sessionFile;
  }

  isPersisted(): boolean {
    return existsSync(this.sessionFile);
  }

  getCwd(): string {
    return this.header.cwd;
  }

  /**
   * Active project root for the selected workspace. This may differ from the
   * process cwd when `/init <target-folder>` selects another project.
   */
  getProjectDir(): string {
    return readWorkspaceManifest(
      this.getWorkspaceDir(),
      this.header.cwd,
    ).projectDir;
  }

  /** 文件系统沙箱目录（citybrain/ 工作区）的绝对路径。 */
  getWorkspaceDir(): string {
    return this.header.workspaceDir ?? resolveWorkspaceDir(this.header.cwd);
  }

  /** 记录/变更沙箱目录并持久化到会话头，避免重启或 /resume 后丢失。 */
  setWorkspaceDir(path: string): void {
    this.header.workspaceDir = resolve(path);
    this.persistHeader();
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  getInfo(modifiedAt: number = this.getModifiedAt()): SessionInfo {
    const firstMessage = this.entries.find((entry) => entry.type === "message")?.message.content;
    return {
      path: this.sessionFile,
      id: this.header.id,
      cwd: this.header.cwd,
      createdAt: this.header.timestamp,
      modifiedAt,
      messageCount: this.entries.filter((entry) => entry.type === "message").length,
      firstMessage,
      compactionCount: this.entries.filter((entry) => entry.type === "compaction").length,
    };
  }

  getMessageCount(): number {
    return this.entries.filter((entry) => entry.type === "message").length;
  }

  getContextReplacementRecords(): ContextReplacementEntry[] {
    return this.entries.filter(
      (entry): entry is ContextReplacementEntry =>
        entry.type === "context_replacement",
    );
  }

  getContextMessages(): ChatMessage[] {
    const boundaryIndex = this.findLatestCompactionIndex();
    const messages = this.entries
      .slice(boundaryIndex + 1)
      .filter((entry): entry is SessionMessageEntry => entry.type === "message")
      .map((entry) => ({
        role: entry.message.role,
        content: entry.message.content,
        ...(entry.message.toolCalls ? { toolCalls: entry.message.toolCalls } : {}),
        ...(entry.message.toolCallId ? { toolCallId: entry.message.toolCallId } : {}),
        ...(entry.message.toolName ? { toolName: entry.message.toolName } : {}),
      }));
    if (boundaryIndex < 0) return messages;
    const boundary = this.entries[boundaryIndex];
    if (!boundary || boundary.type !== "compaction") return messages;
    return [
      { role: "user", content: boundary.summary },
      ...boundary.retainedMessages,
      ...messages,
    ];
  }

  compactContext(
    contextWindow: number,
    systemPrompt: string,
    tools: unknown[],
    reason: string,
    projectedMessages?: readonly ChatMessage[],
  ): CompactionPlan | undefined {
    const currentMessages = this.getContextMessages();
    const messagesForEstimate = projectedMessages ?? currentMessages;
    const estimatedTokens = Math.ceil(
      (systemPrompt.length + JSON.stringify(tools).length) / 4,
    ) + estimateMessages(messagesForEstimate);
    if (estimatedTokens <= contextWindow - 16_384) return undefined;

    const plan = createCompactionPlan(currentMessages);
    if (!plan) return undefined;
    this.appendCompaction({
      summary: plan.summary,
      retainedMessages: plan.keptMessages.slice(1),
      tokensBefore: plan.tokensBefore,
      tokensAfter: plan.tokensAfter,
      keptMessages: plan.keptMessages.length,
      removedMessages: plan.removedMessages,
      reason,
    });
    return plan;
  }

  getContextUsage(contextWindow: number = DEFAULT_CONTEXT_WINDOW): ContextUsage {
    const boundaryIndex = this.findLatestCompactionIndex();
    const messages = this.entries.slice(boundaryIndex + 1).filter(
      (entry): entry is SessionMessageEntry => entry.type === "message",
    );
    const safeContextWindow = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
    const usageInfo = getLastAssistantUsageInfo(messages);

    if (!usageInfo) {
      const tokens = estimateMessages(this.getContextMessages());
      return createContextUsage(tokens, safeContextWindow, 0, tokens, true);
    }

    const trailingTokens = messages
      .slice(usageInfo.index + 1)
      .reduce((sum, entry) => sum + estimateMessages([toChatMessage(entry.message)]), 0);
    const usageTokens = getContextTokensFromUsage(usageInfo.usage);
    const tokens = usageTokens + trailingTokens;
    return createContextUsage(
      tokens,
      safeContextWindow,
      usageTokens,
      trailingTokens,
      trailingTokens > 0,
    );
  }

  getUsageTotals(): ModelUsage {
    const totals: ModelUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    };

    for (const entry of this.entries) {
      if (entry.type !== "message" || entry.message.role !== "assistant") {
        continue;
      }
      const usage = entry.message.usage;
      if (!usage) continue;
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      totals.totalTokens += usage.totalTokens;
    }

    return totals;
  }

  appendMessage(message: SessionMessage): string {
    const entry: SessionMessageEntry = {
      type: "message",
      id: createEntryId(),
      parentId: this.getLeafId(),
      timestamp: new Date().toISOString(),
      message,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: createEntryId(),
      parentId: this.getLeafId(),
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCompaction(input: Omit<CompactionEntry, keyof SessionEntryBase | "type">): string {
    const entry: CompactionEntry = {
      type: "compaction",
      id: createEntryId(),
      parentId: this.getLeafId(),
      timestamp: new Date().toISOString(),
      ...input,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendContextReplacement(
    record: PersistedToolResultProjection,
  ): string {
    if (!record.toolCallId) {
      throw new Error("A context replacement requires a tool call id.");
    }
    const entry: ContextReplacementEntry = {
      type: "context_replacement",
      id: createEntryId(),
      parentId: this.getLeafId(),
      timestamp: new Date().toISOString(),
      toolCallId: record.toolCallId,
      ...(record.toolName ? { toolName: record.toolName } : {}),
      path: record.path,
      replacement: record.replacement,
      originalCharacters: record.originalCharacters,
      originalTokens: record.originalTokens,
      projectedTokens: record.projectedTokens,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  newSession(cwd: string = this.header.cwd): void {
    this.header = createHeader(cwd);
    const sessionsRoot = dirname(dirname(this.sessionFile));
    const sessionDirectory = getSessionDirectory(this.header.cwd, sessionsRoot);
    this.sessionFile = createSessionFile(
      sessionDirectory,
      this.header.timestamp,
      this.header.id,
    );
    this.entries = [];
  }

  /** Remove conversation/history while preserving this session identity and workspace. */
  clearConversation(): void {
    this.entries = [];
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    writeFileSync(this.sessionFile, `${JSON.stringify(this.header)}\n`, "utf8");
  }

  /** Permanently remove this session's persisted transcript file. */
  deletePersistedSession(): void {
    if (existsSync(this.sessionFile)) unlinkSync(this.sessionFile);
    this.entries = [];
  }

  private getLeafId(): string | null {
    return this.entries.at(-1)?.id ?? null;
  }

  private findLatestCompactionIndex(): number {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (this.entries[index]?.type === "compaction") return index;
    }
    return -1;
  }

  private appendEntry(entry: SessionEntry): void {
    this.ensureFile();
    this.entries.push(entry);
    appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private ensureFile(): void {
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    if (!existsSync(this.sessionFile)) {
      writeFileSync(
        this.sessionFile,
        `${JSON.stringify(this.header)}\n`,
        "utf8",
      );
    }
  }

  /** 把改动后的会话头写回文件首行（JSONL 首行即 header）。 */
  private persistHeader(): void {
    if (!this.isPersisted()) return;
    const lines = readFileSync(this.sessionFile, "utf8").split(/\r?\n/u);
    lines[0] = JSON.stringify(this.header);
    writeFileSync(this.sessionFile, lines.join("\n"), "utf8");
  }

  private getModifiedAt(): number {
    return this.isPersisted()
      ? statSync(this.sessionFile).mtimeMs
      : getModifiedAtForHeader(this.header);
  }
}

function getModifiedAtForHeader(header: SessionHeader): number {
  const timestamp = Date.parse(header.timestamp);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function createHeader(cwd: string): SessionHeader {
  return {
    type: "session",
    version: SESSION_VERSION,
    id: createSessionId(),
    timestamp: new Date().toISOString(),
    cwd: resolve(cwd),
    workspaceDir: resolveWorkspaceDir(cwd),
  };
}

function isSessionFileEntry(value: unknown): value is SessionFileEntry {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  if (value.type === "session") {
    return (
      value.version === SESSION_VERSION &&
      typeof value.id === "string" &&
      typeof value.timestamp === "string" &&
      typeof value.cwd === "string" &&
      (value.workspaceDir === undefined || typeof value.workspaceDir === "string")
    );
  }

  if (
    typeof value.id !== "string" ||
    (typeof value.parentId !== "string" && value.parentId !== null) ||
    typeof value.timestamp !== "string"
  ) {
    return false;
  }

  if (value.type === "model_change") {
    return typeof value.provider === "string" && typeof value.modelId === "string";
  }

  if (value.type === "compaction") {
    return (
      typeof value.summary === "string" &&
      Array.isArray(value.retainedMessages) &&
      typeof value.tokensBefore === "number" &&
      typeof value.tokensAfter === "number" &&
      typeof value.keptMessages === "number" &&
      typeof value.removedMessages === "number" &&
      typeof value.reason === "string"
    );
  }

  if (value.type === "context_replacement") {
    return (
      typeof value.toolCallId === "string" &&
      typeof value.path === "string" &&
      typeof value.replacement === "string" &&
      typeof value.originalCharacters === "number" &&
      typeof value.originalTokens === "number" &&
      typeof value.projectedTokens === "number" &&
      (value.toolName === undefined || typeof value.toolName === "string")
    );
  }

  if (value.type === "message" && isRecord(value.message)) {
    return (
      (value.message.role === "user" ||
        value.message.role === "assistant" ||
        value.message.role === "tool") &&
      typeof value.message.content === "string" &&
      (value.message.thinking === undefined || typeof value.message.thinking === "string") &&
      (value.message.visibility === undefined ||
        value.message.visibility === "visible" ||
        value.message.visibility === "system") &&
      (value.message.toolCalls === undefined || Array.isArray(value.message.toolCalls)) &&
      (value.message.toolCallId === undefined || typeof value.message.toolCallId === "string") &&
      (value.message.toolName === undefined || typeof value.message.toolName === "string") &&
      (value.message.usage === undefined || isModelUsage(value.message.usage))
    );
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.input === "number" &&
    typeof value.output === "number" &&
    typeof value.cacheRead === "number" &&
    typeof value.cacheWrite === "number" &&
    typeof value.totalTokens === "number"
  );
}

function getLastAssistantUsageInfo(
  messages: SessionMessageEntry[],
): { usage: NonNullable<SessionMessage["usage"]>; index: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]?.message;
    if (
      message?.role === "assistant" &&
      message.usage &&
      getContextTokensFromUsage(message.usage) > 0
    ) {
      return { usage: message.usage, index };
    }
  }
  return undefined;
}

function toChatMessage(message: SessionMessage): ChatMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
  };
}

function createContextUsage(
  tokens: number,
  contextWindow: number,
  usageTokens: number,
  trailingTokens: number,
  estimated: boolean,
): ContextUsage {
  return {
    tokens,
    contextWindow,
    percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : 0,
    usageTokens,
    trailingTokens,
    estimated,
  };
}
