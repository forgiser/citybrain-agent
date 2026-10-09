import type { ToolSpec } from "../core/contracts/tool-spec.js";
import type { QgisRuntimeInfo } from "../../integrations/qgis/qgis-runtime.js";
import { describeQgisAlgorithm } from "../../integrations/qgis/qgis-process-client.js";

type RuntimeGetter = () => QgisRuntimeInfo | undefined;

export function createDescribeQgisAlgorithmTool(getRuntime: RuntimeGetter): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "describe_qgis_algorithm",
        description:
          "Show the parameter schema of a QGIS algorithm (names, types, defaults, " +
          "acceptable values, outputs). Always call this before run_qgis_algorithm " +
          "so parameters are provided correctly.",
        parameters: {
          type: "object",
          properties: {
            algorithm: {
              type: "string",
              description: "Algorithm id, e.g. native:buffer.",
            },
          },
          required: ["algorithm"],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const runtime = getRuntime();
      if (!runtime) {
        throw new Error("QGIS runtime is not configured. Ask the user to run /qgis to set it up.");
      }
      return describeQgisAlgorithm(runtime, getAlgorithmId(args));
    },
    metadata: {
      source: "qgis",
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      interruptBehavior: "cancel",
      getActivityDescription: () => "Describing QGIS algorithm",
      getToolUseSummary: (args) => getStringField(args, "algorithm") ?? "algorithm",
      maxResultSizeChars: 20_000,
    },
  };
}

function getAlgorithmId(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("An algorithm id is required.");
  }
  const algorithm = (args as { algorithm?: unknown }).algorithm;
  if (typeof algorithm !== "string" || !algorithm.trim()) {
    throw new Error("An algorithm id is required.");
  }
  return algorithm.trim();
}

function getStringField(args: unknown, key: string): string | undefined {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    && typeof (args as Record<string, unknown>)[key] === "string"
    ? (args as Record<string, string>)[key]
    : undefined;
}
