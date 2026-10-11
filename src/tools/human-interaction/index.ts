import type {
  HumanInteractionBroker,
  HumanInteractionKind,
  HumanInteractionOption,
  HumanInteractionRisk,
} from "../../harness/human-interaction.js";
import type { ToolSpec } from "../core/contracts/tool-spec.js";

export interface HumanInteractionToolDependencies {
  humanInteractionBroker: HumanInteractionBroker;
}

const MODEL_INTERACTION_KINDS = [
  "clarification",
  "choice",
  "confirmation",
  "destructive_confirmation",
  "recovery_choice",
] as const satisfies readonly HumanInteractionKind[];

/** Lets the model pause its current run and request one bounded human decision. */
export function createHumanInteractionTools(
  deps: HumanInteractionToolDependencies,
): ToolSpec[] {
  return [{
    definition: {
      type: "function",
      function: {
        name: "request_user_input",
        description: [
          "Pause the current run and ask the user one material question using bounded choices.",
          "Use clarification when required intent is missing, choice when several materially different valid plans exist, confirmation before a consequential action, destructive_confirmation for irreversible or high-risk actions, and recovery_choice when execution cannot safely continue without a recovery decision.",
          "Do not use this tool for routine reversible details with a reasonable default. Inspect available state/data first, provide 2-8 concrete options, mark at most one recommended option, then continue from the structured decision returned by this tool.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [...MODEL_INTERACTION_KINDS],
              description: "Why human input is required.",
            },
            title: { type: "string", description: "Short decision title shown in CLI and Web UI." },
            message: { type: "string", description: "Explain the decision, relevant evidence, and consequences without exposing hidden reasoning." },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 8,
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Stable short identifier using letters, numbers, underscores, or hyphens." },
                  label: { type: "string", description: "Concise user-facing option label." },
                  description: { type: "string", description: "Effect or tradeoff of this option." },
                  recommended: { type: "boolean", description: "Mark at most one option as recommended." },
                  dangerous: { type: "boolean", description: "Whether this option has destructive or high-risk effects." },
                },
                required: ["id", "label"],
                additionalProperties: false,
              },
            },
            defaultOption: { type: "string", description: "Option selected initially. Defaults to the recommended option, otherwise the first option." },
            risk: { type: "string", enum: ["low", "medium", "high"], description: "Overall interaction risk. Destructive confirmation always uses high risk." },
            timeoutSeconds: { type: "integer", minimum: 30, maximum: 1800, description: "Optional wait timeout. Omit to use the runtime default." },
          },
          required: ["kind", "title", "message", "options"],
          additionalProperties: false,
        },
      },
    },
    handler: async (input, context) => {
      const args = readRecord(input);
      const kind = readEnum(args.kind, "kind", MODEL_INTERACTION_KINDS);
      const title = readBoundedString(args.title, "title", 120);
      const message = readBoundedString(args.message, "message", 2_000);
      const options = readOptions(args.options);
      const recommended = options.filter((option) => option.recommended);
      if (recommended.length > 1) throw new Error("Only one interaction option may be recommended.");
      const defaultOption = args.defaultOption === undefined
        ? recommended[0]?.id ?? options[0]!.id
        : readBoundedString(args.defaultOption, "defaultOption", 64);
      if (!options.some((option) => option.id === defaultOption)) {
        throw new Error(`defaultOption does not match an option id: ${defaultOption}`);
      }
      const requestedRisk = args.risk === undefined
        ? undefined
        : readEnum(args.risk, "risk", ["low", "medium", "high"] as const);
      const risk: HumanInteractionRisk = kind === "destructive_confirmation"
        ? "high"
        : requestedRisk ?? (kind === "confirmation" ? "medium" : "low");
      const timeoutSeconds = args.timeoutSeconds === undefined
        ? undefined
        : readInteger(args.timeoutSeconds, "timeoutSeconds", 30, 1_800);

      const decision = await deps.humanInteractionBroker.request({
        runId: context?.runId,
        turn: context?.turn,
        layer: "interaction",
        phase: `model_${kind}`,
        scope: "turn",
        kind,
        title,
        message,
        options,
        defaultOption,
        risk,
        ...(timeoutSeconds !== undefined ? { timeoutMs: timeoutSeconds * 1_000 } : {}),
        context: {
          source: "model_tool",
          ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}),
        },
      });
      const selectedOption = decision.optionId
        ? options.find((option) => option.id === decision.optionId)
        : undefined;
      return JSON.stringify({
        requestId: decision.requestId,
        kind,
        action: decision.action,
        ...(decision.optionId ? { optionId: decision.optionId } : {}),
        ...(selectedOption ? { selectedOption } : {}),
        ...(decision.editedInput !== undefined ? { editedInput: decision.editedInput } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      }, null, 2);
    },
    metadata: {
      source: "builtin",
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => false,
      interruptBehavior: "block",
      supportsBackground: false,
      getActivityDescription: (input) => `Waiting for user input: ${readOptionalTitle(input) ?? "decision"}`,
      getToolUseSummary: (input) => readOptionalTitle(input) ?? "Request user input",
      maxResultSizeChars: 10_000,
    },
  }];
}

function readOptions(value: unknown): HumanInteractionOption[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    throw new Error("options must contain 2 to 8 entries.");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const option = readRecord(entry, `options[${index}]`);
    const id = readBoundedString(option.id, `options[${index}].id`, 64);
    if (!/^[a-zA-Z0-9_-]+$/u.test(id)) {
      throw new Error(`options[${index}].id may contain only letters, numbers, underscores, and hyphens.`);
    }
    if (ids.has(id)) throw new Error(`Duplicate interaction option id: ${id}`);
    ids.add(id);
    return {
      id,
      label: readBoundedString(option.label, `options[${index}].label`, 120),
      ...(option.description !== undefined
        ? { description: readBoundedString(option.description, `options[${index}].description`, 500) }
        : {}),
      ...(option.recommended !== undefined
        ? { recommended: readBoolean(option.recommended, `options[${index}].recommended`) }
        : {}),
      ...(option.dangerous !== undefined
        ? { dangerous: readBoolean(option.dangerous, `options[${index}].dangerous`) }
        : {}),
    };
  });
}

function readOptionalTitle(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const title = (value as Record<string, unknown>).title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

function readRecord(value: unknown, name = "input"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readBoundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${name} must not exceed ${maximum} characters.`);
  return normalized;
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function readInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function readEnum<const T extends readonly string[]>(value: unknown, name: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  }
  return value as T[number];
}
