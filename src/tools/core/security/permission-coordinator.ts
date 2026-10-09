import type { SandboxPolicy } from "../../../workspace/sandbox-policy.js";
import type {
  HumanInteractionBroker,
  HumanInteractionDecision,
} from "../../../harness/human-interaction.js";
import type {
  PermissionDecision,
  ResolvedToolMetadata,
} from "../contracts/tool-contract.js";
import type { ToolCallContext } from "../contracts/tool-context.js";

export interface PermissionRequest {
  toolName: string;
  input: unknown;
  metadata: ResolvedToolMetadata;
  readPaths: readonly string[];
  writePaths: readonly string[];
  context: ToolCallContext;
}

export interface PermissionCoordinator {
  evaluate(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface PermissionCoordinatorOptions {
  sandbox?: SandboxPolicy;
  humanInteractionBroker?: HumanInteractionBroker;
  projectRules?: (
    request: PermissionRequest,
  ) => Promise<PermissionDecision | undefined> | PermissionDecision | undefined;
  requestUserApproval?: (
    request: PermissionRequest,
  ) => Promise<boolean>;
}

/**
 * Phase D's default policy coordinator.
 *
 * The order is intentional:
 * 1. sandbox path boundaries are hard denials;
 * 2. tool metadata and project rules may further restrict execution;
 * 3. user approval can only approve an undecided action, never a sandbox denial.
 */
export class DefaultPermissionCoordinator implements PermissionCoordinator {
  constructor(private readonly options: PermissionCoordinatorOptions = {}) {}

  async evaluate(request: PermissionRequest): Promise<PermissionDecision> {
    const sandboxDecision = this.checkSandbox(request);
    if (sandboxDecision) return sandboxDecision;

    if (request.metadata.authorize) {
      const customDecision = await request.metadata.authorize(
        request.input,
        request.context,
      );
      if (customDecision.action === "deny") return customDecision;
      if (customDecision.action === "ask") {
        return this.resolveApproval(request, customDecision.reason);
      }
    }

    if (this.options.projectRules) {
      const projectDecision = await this.options.projectRules(request);
      if (projectDecision?.action === "deny") return projectDecision;
      if (projectDecision?.action === "ask") {
        return this.resolveApproval(request, projectDecision.reason);
      }
    }

    if (request.metadata.requiresUserInteraction) {
      return this.resolveApproval(
        request,
        `Tool "${request.toolName}" requires user confirmation.`,
      );
    }

    return {
      action: "allow",
      source: "policy",
      reason: request.metadata.readOnly
        ? "read-only tool allowed by policy"
        : "tool is inside the active sandbox",
    };
  }

  private checkSandbox(
    request: PermissionRequest,
  ): PermissionDecision | undefined {
    const sandbox = this.options.sandbox ?? request.context.sandbox;
    if (!sandbox) return undefined;

    try {
      for (const path of request.readPaths) {
        sandbox.assertReadable(path);
      }
      for (const path of request.writePaths) {
        sandbox.assertWritable(path);
      }
    } catch (error) {
      return {
        action: "deny",
        source: "sandbox",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return undefined;
  }

  private async resolveApproval(
    request: PermissionRequest,
    reason = `Tool "${request.toolName}" requires user approval.`,
  ): Promise<PermissionDecision> {
    if (this.options.humanInteractionBroker) {
      const decision = await this.options.humanInteractionBroker.request({
        runId: request.context.runId,
        turn: request.context.turn,
        layer: "tool",
        phase: "permission_decision",
        scope: "tool",
        kind: request.metadata.destructive
          ? "destructive_confirmation"
          : "permission",
        title: request.metadata.destructive
          ? "Confirm destructive tool action"
          : "Confirm tool action",
        message: [
          reason,
          request.readPaths.length > 0
            ? `Read: ${request.readPaths.join(", ")}`
            : "",
          request.writePaths.length > 0
            ? `Write: ${request.writePaths.join(", ")}`
            : "",
        ].filter(Boolean).join("\n"),
        options: [
          {
            id: "approve",
            label: "Approve",
            description: "Allow this tool call to continue.",
            dangerous: request.metadata.destructive,
          },
          {
            id: "reject",
            label: "Reject",
            description: "Block this tool call.",
          },
        ],
        defaultOption: "reject",
        risk: request.metadata.destructive ? "high" : "medium",
        context: {
          toolName: request.toolName,
          source: request.metadata.source,
          destructive: request.metadata.destructive,
        },
      });
      return permissionDecisionFromHuman(decision);
    }

    if (!this.options.requestUserApproval) {
      return {
        action: "ask",
        source: "policy",
        reason,
        requiresConfirmation: true,
      };
    }

    const approved = await this.options.requestUserApproval(request);
    return approved
      ? { action: "allow", source: "user", reason: "user approved the tool call" }
      : { action: "deny", source: "user", reason: "user denied the tool call" };
  }
}

function permissionDecisionFromHuman(
  decision: HumanInteractionDecision,
): PermissionDecision {
  if (decision.action === "approve" || decision.optionId === "approve") {
    return {
      action: "allow",
      source: "user",
      reason: decision.reason ?? "user approved the tool call",
    };
  }
  return {
    action: "deny",
    source: decision.source === "system" || decision.source === "timeout"
      ? "system"
      : "user",
    reason: decision.reason ?? "user denied the tool call",
  };
}
