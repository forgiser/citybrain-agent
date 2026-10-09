import type { ToolSpec } from "../core/contracts/tool-spec.js";
import type { QgisRuntimeInfo } from "../../integrations/qgis/qgis-runtime.js";
import {
  DEFAULT_ALGORITHM_LIST_LIMIT,
  listQgisAlgorithms,
} from "../../integrations/qgis/qgis-process-client.js";

type RuntimeGetter = () => QgisRuntimeInfo | undefined;

export function createListQgisAlgorithmsTool(getRuntime: RuntimeGetter): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "list_qgis_algorithms",
        description:
          "Search the QGIS Processing algorithm catalog. Call this before running " +
          "anything to find the right algorithm id. Returns ids with names, groups, tags.",
        parameters: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              description: "Case-insensitive keyword matched against id, name, group and tags.",
            },
            limit: {
              type: "number",
              description: "Max results (1-50). Defaults to " + DEFAULT_ALGORITHM_LIST_LIMIT + ".",
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const runtime = requireRuntime(getRuntime());
      const parsed = (args ?? {}) as { filter?: unknown; limit?: unknown };
      const filter = typeof parsed.filter === "string" ? parsed.filter : undefined;
      const limit = typeof parsed.limit === "number" && Number.isFinite(parsed.limit)
        ? Math.min(Math.max(Math.floor(parsed.limit), 1), 50)
        : undefined;
      const result = await listQgisAlgorithms(runtime, filter, limit);
      if (result.matched === 0) {
        const reason = filter ? ' for "' + filter + '"' : "";
        return "No algorithms matched" + reason + ". Total in catalog: " + result.total + ".";
      }
      const lines = result.algorithms.map((algorithm) => {
        const group = algorithm.group ? "  [" + algorithm.group + "]" : "";
        return algorithm.id + "  " + algorithm.name + group;
      });
      const header = "Matched " + result.matched + " of " + result.total
        + " algorithms; showing " + result.algorithms.length + ":";
      const notice = result.truncated ? "[List truncated - refine the filter keyword.]" : "";
      return [header, ...lines, notice].filter(Boolean).join("\n");
    },
    metadata: {
      source: "qgis",
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      interruptBehavior: "cancel",
      getActivityDescription: () => "Searching QGIS algorithms",
      getToolUseSummary: (args) => {
        const filter = getStringField(args, "filter");
        return filter ? `filter=${filter}` : "algorithm catalog";
      },
      maxResultSizeChars: 20_000,
    },
  };
}

function requireRuntime(runtime: QgisRuntimeInfo | undefined): QgisRuntimeInfo {
  if (!runtime) {
    throw new Error("QGIS runtime is not configured. Ask the user to run /qgis to set it up.");
  }
  return runtime;
}

function getStringField(args: unknown, key: string): string | undefined {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    && typeof (args as Record<string, unknown>)[key] === "string"
    ? (args as Record<string, string>)[key]
    : undefined;
}
