import type { ChatMessage, ChatToolCall, ModelUsage } from "../models/model-chat.js";

export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  timestamp: string;
  cwd: string;
  /**
   * 文件系统沙箱目录（citybrain/ 工作区）的绝对路径。缺省时按 cwd 派生
   * （`<cwd>/citybrain`），旧会话文件向后兼容。
   */
  workspaceDir?: string;
}

export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
  provider?: string;
  model?: string;
  usage?: ModelUsage;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: SessionMessage;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  retainedMessages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  keptMessages: number;
  removedMessages: number;
  reason: string;
}

export type SessionEntry = SessionMessageEntry | ModelChangeEntry | CompactionEntry;
export type SessionFileEntry = SessionHeader | SessionEntry;

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  createdAt: string;
  modifiedAt: number;
  messageCount: number;
  firstMessage?: string;
  compactionCount?: number;
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
  usageTokens: number;
  trailingTokens: number;
  estimated: boolean;
}
