import type { ModelUsage } from "../models/model-chat.js";

export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  timestamp: string;
  cwd: string;
}

export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
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

export type SessionEntry = SessionMessageEntry | ModelChangeEntry;
export type SessionFileEntry = SessionHeader | SessionEntry;

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  createdAt: string;
  modifiedAt: number;
  messageCount: number;
  firstMessage?: string;
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
  usageTokens: number;
  trailingTokens: number;
  estimated: boolean;
}
