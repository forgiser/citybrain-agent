import type { ToolSpec } from "../core/contracts/tool-spec.js";
import {
  TaskManager,
  TaskWaitTimeoutError,
  isTaskTerminal,
  type TaskSnapshot,
} from "../../task/index.js";

export function createTaskManagementTools(taskManager: TaskManager): ToolSpec[] {
  return [
    createGetTaskStatusTool(taskManager),
    createWaitTaskTool(taskManager),
    createCancelTaskTool(taskManager),
    createListTasksTool(taskManager),
  ];
}

function createGetTaskStatusTool(taskManager: TaskManager): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "get_task_status",
        description:
          "Get the current state of a background task. A running task has no usable final result yet.",
        parameters: taskIdSchema(),
      },
    },
    handler: async (args) => formatTask(requireTask(taskManager, getTaskId(args))),
    metadata: readOnlyMetadata("Checking background task status"),
  };
}

function createWaitTaskTool(taskManager: TaskManager): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "wait_task",
        description:
          "Wait briefly for a background task. If it is still running when the wait expires, " +
          "the task continues in the background and its current state is returned.",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Background task id." },
            timeoutSeconds: {
              type: "number",
              description: "How long to wait for this check (1-60 seconds, default 30).",
            },
          },
          required: ["taskId"],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, context) => {
      const taskId = getTaskId(args);
      requireTask(taskManager, taskId);
      const timeoutMs = getWaitTimeoutMs(args);
      try {
        const task = await taskManager.wait(taskId, {
          timeoutMs,
          signal: context?.signal,
        });
        return formatTask(task);
      } catch (error) {
        if (error instanceof TaskWaitTimeoutError) {
          return formatTask(requireTask(taskManager, taskId));
        }
        throw error;
      }
    },
    metadata: {
      ...readOnlyMetadata("Waiting for background task"),
      interruptBehavior: "cancel",
      isConcurrencySafe: () => false,
    },
  };
}

function createCancelTaskTool(taskManager: TaskManager): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "cancel_task",
        description:
          "Request cancellation of one background task. This does not cancel the whole Agent run.",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Background task id." },
            reason: { type: "string", description: "Optional cancellation reason." },
          },
          required: ["taskId"],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const taskId = getTaskId(args);
      const current = requireTask(taskManager, taskId);
      if (isTaskTerminal(current.status)) return formatTask(current);
      const reason = isRecord(args) && typeof args.reason === "string"
        ? args.reason.trim() || "cancelled by agent"
        : "cancelled by agent";
      taskManager.cancel(taskId, reason);
      return formatTask(requireTask(taskManager, taskId));
    },
    metadata: {
      source: "builtin",
      isReadOnly: () => false,
      isDestructive: () => true,
      isConcurrencySafe: () => false,
      interruptBehavior: "block",
      requiresUserInteraction: () => true,
      getActivityDescription: () => "Cancelling background task",
      getToolUseSummary: (args) => getTaskIdSafe(args) ?? "task",
      maxResultSizeChars: 4_000,
    },
  };
}

function createListTasksTool(taskManager: TaskManager): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "list_tasks",
        description: "List recent background tasks and their current states.",
        parameters: {
          type: "object",
          properties: {
            activeOnly: {
              type: "boolean",
              description: "Only return queued/running/cancelling tasks.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const activeOnly = isRecord(args) && args.activeOnly === true;
      const tasks = taskManager.list().filter(
        (task) => !activeOnly || !isTaskTerminal(task.status),
      );
      if (tasks.length === 0) return "No background tasks.";
      return tasks.slice(0, 50).map(formatTaskSummary).join("\n");
    },
    metadata: readOnlyMetadata("Listing background tasks"),
  };
}

function readOnlyMetadata(activityDescription: string): NonNullable<ToolSpec["metadata"]> {
  return {
    source: "builtin",
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    interruptBehavior: "cancel",
    getActivityDescription: () => activityDescription,
    getToolUseSummary: (args) => getTaskIdSafe(args) ?? "tasks",
    maxResultSizeChars: 8_000,
  };
}

function taskIdSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Background task id." },
    },
    required: ["taskId"],
    additionalProperties: false,
  };
}

function getTaskId(args: unknown): string {
  const taskId = getTaskIdSafe(args);
  if (!taskId) throw new Error("A non-empty taskId is required.");
  return taskId;
}

function getTaskIdSafe(args: unknown): string | undefined {
  return isRecord(args) && typeof args.taskId === "string" && args.taskId.trim()
    ? args.taskId.trim()
    : undefined;
}

function getWaitTimeoutMs(args: unknown): number {
  if (!isRecord(args) || typeof args.timeoutSeconds !== "number") return 30_000;
  if (!Number.isFinite(args.timeoutSeconds)) return 30_000;
  return Math.min(60, Math.max(1, Math.floor(args.timeoutSeconds))) * 1_000;
}

function requireTask(taskManager: TaskManager, taskId: string): TaskSnapshot {
  const task = taskManager.get(taskId);
  if (!task) throw new Error(`Background task does not exist: ${taskId}`);
  return task;
}

function formatTask(task: TaskSnapshot): string {
  const lines = [
    `Task: ${task.id}`,
    `Name: ${task.name}`,
    `Status: ${task.status}`,
  ];
  if (task.description) lines.push(`Description: ${task.description}`);
  if (task.progress?.message) lines.push(`Progress: ${task.progress.message}`);
  if (task.progress?.percent !== undefined) {
    lines.push(`Percent: ${task.progress.percent}%`);
  }
  if (task.artifactPaths.length > 0) {
    lines.push(`Artifacts (${task.status === "completed" ? "ready if verified" : "not ready"}):`);
    lines.push(...task.artifactPaths.map((path) => `- ${path}`));
  }
  if (task.error) lines.push(`Error: ${task.error.message}`);
  if (task.cancellationReason) {
    lines.push(`Cancellation reason: ${task.cancellationReason}`);
  }
  const outcome = getToolOutcome(task.result) ??
    getToolOutcome(task.error?.details?.toolOutcome);
  if (outcome) {
    lines.push(`Tool outcome: ${outcome.ok ? "success" : "failure"}`);
    lines.push(outcome.content);
  } else if (task.status === "queued" || task.status === "running" || task.status === "cancelling") {
    lines.push("The final result is not available. Do not consume pending artifacts.");
  }
  return lines.join("\n");
}

function formatTaskSummary(task: TaskSnapshot): string {
  const progress = task.progress?.percent !== undefined
    ? ` ${task.progress.percent}%`
    : "";
  return `- ${task.id} [${task.status}${progress}] ${task.name}`;
}

function getToolOutcome(value: unknown): { ok: boolean; content: string } | undefined {
  return isRecord(value) && typeof value.ok === "boolean" && typeof value.content === "string"
    ? { ok: value.ok, content: value.content }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
