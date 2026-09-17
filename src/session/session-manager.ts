import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { getCityBrainDir } from "../auth/auth-storage.js";
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
} from "./session-types.js";

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
    };
  }

  getMessageCount(): number {
    return this.entries.filter((entry) => entry.type === "message").length;
  }

  getContextMessages(): ChatMessage[] {
    return this.entries
      .filter((entry): entry is SessionMessageEntry => entry.type === "message")
      .map((entry) => ({
        role: entry.message.role,
        content: entry.message.content,
      }));
  }

  getContextUsage(contextWindow: number = DEFAULT_CONTEXT_WINDOW): ContextUsage {
    const messages = this.entries.filter(
      (entry): entry is SessionMessageEntry => entry.type === "message",
    );
    const safeContextWindow = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
    const usageInfo = getLastAssistantUsageInfo(messages);

    if (!usageInfo) {
      const tokens = messages.reduce(
        (sum, entry) => sum + estimateMessageTokens(entry.message),
        0,
      );
      return createContextUsage(tokens, safeContextWindow, 0, tokens, true);
    }

    const trailingTokens = messages
      .slice(usageInfo.index + 1)
      .reduce((sum, entry) => sum + estimateMessageTokens(entry.message), 0);
    const tokens = usageInfo.usage.totalTokens + trailingTokens;
    return createContextUsage(
      tokens,
      safeContextWindow,
      usageInfo.usage.totalTokens,
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

  private getLeafId(): string | null {
    return this.entries.at(-1)?.id ?? null;
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
  };
}

function isSessionFileEntry(value: unknown): value is SessionFileEntry {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  if (value.type === "session") {
    return (
      value.version === SESSION_VERSION &&
      typeof value.id === "string" &&
      typeof value.timestamp === "string" &&
      typeof value.cwd === "string"
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

  if (value.type === "message" && isRecord(value.message)) {
    return (
      (value.message.role === "user" || value.message.role === "assistant") &&
      typeof value.message.content === "string" &&
      (value.message.thinking === undefined || typeof value.message.thinking === "string") &&
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
      message.usage.totalTokens > 0
    ) {
      return { usage: message.usage, index };
    }
  }
  return undefined;
}

function estimateMessageTokens(message: SessionMessage): number {
  return Math.ceil((message.content.length + (message.thinking?.length ?? 0)) / 4);
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
