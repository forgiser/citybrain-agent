import type { ToolExecutionOutcome } from "../tools/core/contracts/tool-types.js";
import type { TaskSnapshot } from "./task-types.js";

export function isToolExecutionTask(task: TaskSnapshot): boolean {
  return task.metadata?.kind === "tool_execution" && task.metadata.detached === true;
}

export function formatTaskCompletionNotification(task: TaskSnapshot): string {
  const outcome = readOutcome(task);
  const lines = [
    "<task-notification>",
    `<task-id>${escapeXml(task.id)}</task-id>`,
    `<task-name>${escapeXml(task.name)}</task-name>`,
    `<status>${escapeXml(task.status)}</status>`,
  ];
  const toolCallId = readString(task.metadata?.toolCallId);
  if (toolCallId) lines.push(`<tool-call-id>${escapeXml(toolCallId)}</tool-call-id>`);
  if (task.description) lines.push(`<summary>${escapeXml(task.description)}</summary>`);
  if (task.artifactPaths.length > 0) {
    lines.push("<artifacts>");
    lines.push(...task.artifactPaths.map((path) => `- ${path}`));
    lines.push("</artifacts>");
  }
  if (outcome) {
    lines.push(`<tool-result ok="${outcome.ok ? "true" : "false"}">`);
    lines.push(outcome.content);
    lines.push("</tool-result>");
  } else if (task.error?.message) {
    lines.push(`<error>${escapeXml(task.error.message)}</error>`);
  } else if (task.cancellationReason) {
    lines.push(`<error>${escapeXml(task.cancellationReason)}</error>`);
  }
  lines.push("</task-notification>");
  lines.push(
    "This is an automatic terminal notification, not a user request to poll. " +
      "Continue the original task using this final result. Do not call task status tools unless the user explicitly asks for status.",
  );
  return lines.join("\n");
}

function readOutcome(task: TaskSnapshot): ToolExecutionOutcome | undefined {
  if (isOutcome(task.result)) return task.result;
  const stored = task.error?.details?.toolOutcome;
  return isOutcome(stored) ? stored : undefined;
}

function isOutcome(value: unknown): value is ToolExecutionOutcome {
  return typeof value === "object" && value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean" &&
    typeof (value as { content?: unknown }).content === "string" &&
    typeof (value as { taskId?: unknown }).taskId === "string";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
