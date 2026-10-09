import type { ChatToolDefinition } from "../../../models/model-chat.js";
import type { ToolCallContext } from "./tool-context.js";
import type { ToolHandler } from "./tool-types.js";
import type { ToolValidationResult } from "./tool-preflight.js";
import type { ToolMetadata } from "./tool-contract.js";
import type {
  AgentCapability,
  AgentHostMode,
  AgentHostProfile,
} from "../../../host/index.js";

export interface ToolRegistrationOptions extends ToolMetadata<unknown> {
  /** Host modes in which this tool may be exposed to the model. */
  supportedModes?: readonly AgentHostMode[];
  /** Every listed capability must be active before this tool is exposed. */
  requiredCapabilities?: readonly AgentCapability[];
  /** Optional live gate, e.g. an active browser map-command connection. */
  isAvailable?: (profile: AgentHostProfile) => boolean;
  producesArtifacts?: (args: unknown, context?: ToolCallContext) => string[];
  normalizeInput?: (
    input: unknown,
    context: ToolCallContext,
  ) => unknown | Promise<unknown>;
  validateInput?: (
    input: unknown,
    context: ToolCallContext,
  ) => ToolValidationResult | Promise<ToolValidationResult>;
}

export interface ToolSpec {
  definition: ChatToolDefinition;
  handler: ToolHandler;
  metadata?: ToolRegistrationOptions;
  producesArtifacts?: (
    args: unknown,
    context?: ToolCallContext,
  ) => string[];
}
