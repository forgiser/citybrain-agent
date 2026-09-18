import { join } from "node:path";
import type { ChatToolDefinition } from "../models/model-chat.js";
import type { QgisRuntimeInfo } from "./qgis-runtime.js";
import {
  DEFAULT_ALGORITHM_LIST_LIMIT,
  QGIS_EXECUTE_TIMEOUT_MS,
  describeQgisAlgorithm,
  executeQgisAlgorithm,
  listQgisAlgorithms,
} from "./qgis-process-client.js";
import type { ToolCallContext } from "../tools/tool-registry.js";

export interface QgisTool {
  definition: ChatToolDefinition;
  handler: (args: unknown, context?: ToolCallContext) => Promise<string>;
  /**
   * Concurrency verdict for a parsed-arguments call. list/describe are
   * read-only and may run in parallel; run has side effects (writes output
   * files) and executes exclusively. A path-collision-aware refinement —
   * parallel runs with distinct OUTPUT paths — is a later refinement.
   */
  isConcurrencySafe?: (args: unknown) => boolean;
  producesArtifacts?: (args: unknown) => string[];
}

type RuntimeGetter = () => QgisRuntimeInfo | undefined;

const RUN_TIMEOUT_RANGE: [number, number] = [5_000, QGIS_EXECUTE_TIMEOUT_MS];
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/u;

function makeListTool(getRuntime: RuntimeGetter): QgisTool {
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
    handler: async (args, context) => {
      const runtime = requireRuntime(getRuntime());
      const parsed = (args ?? {}) as { filter?: unknown; limit?: unknown };
      const filter = typeof parsed.filter === "string" ? parsed.filter : undefined;
      let limit: number | undefined;
      if (typeof parsed.limit === "number" && Number.isFinite(parsed.limit)) {
        limit = Math.min(Math.max(Math.floor(parsed.limit), 1), 50);
      }
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
    isConcurrencySafe: () => true,
  };
}

function makeDescribeTool(getRuntime: RuntimeGetter): QgisTool {
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
    handler: async (args, context) => {
      const runtime = requireRuntime(getRuntime());
      return describeQgisAlgorithm(runtime, getAlgorithmId(args));
    },
    isConcurrencySafe: () => true,
  };
}

function makeRunTool(getRuntime: RuntimeGetter): QgisTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "run_qgis_algorithm",
        description:
          "Execute a QGIS Processing algorithm. Provide parameters as an object, e.g. " +
          '{"INPUT": "data/in.geojson", "DISTANCE": 1000, "OUTPUT": "output/out.gpkg"}. ' +
          "String values that look like paths are resolved against the workspace when " +
          "relative. For Windows absolute paths, prefer forward slashes or escaped " +
          'backslashes, e.g. "C:/temp/in.geojson" or "C:\\\\temp\\\\in.geojson". ' +
          "The result reports the absolute paths of produced output files.",
        parameters: {
          type: "object",
          properties: {
            algorithm: {
              type: "string",
              description: "Algorithm id, e.g. native:buffer.",
            },
            parameters: {
              type: "object",
              description: "Parameter entries; values must be string, number or boolean.",
              additionalProperties: { type: ["string", "number", "boolean"] },
            },
            timeoutSeconds: {
              type: "number",
              description: "Optional execution timeout in seconds (5-600).",
            },
          },
          required: ["algorithm", "parameters"],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, context) => {
      const runtime = requireRuntime(getRuntime());
      const algorithmId = getAlgorithmId(args);
      const parsed = (args ?? {}) as {
        parameters?: unknown;
        timeoutSeconds?: unknown;
      };
      if (
        typeof parsed.parameters !== "object" ||
        parsed.parameters === null ||
        Array.isArray(parsed.parameters)
      ) {
        throw new Error("run_qgis_algorithm requires a parameters object.");
      }
      const raw = parsed.parameters as Record<string, unknown>;
      const parameters: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          parameters[key] = value;
        } else {
          throw new Error('Parameter "' + key + '" must be string, number or boolean.');
        }
      }

      resolveParameterPaths(parameters);
      const timeoutMs = getTimeoutMs(parsed.timeoutSeconds);
      context?.emitProgress?.({
        phase: "running",
        message: `Running ${algorithmId}`,
      });
      let result;
      try {
        result = await executeQgisAlgorithm(
          runtime,
          algorithmId,
          parameters,
          timeoutMs,
          {
            signal: context?.signal,
            onProgress: (progress) => {
              context?.emitProgress?.({
                phase: "running",
                elapsedMs: progress.elapsedMs,
                message: `Running ${algorithmId}`,
                stdoutTail: progress.stdoutTail,
                stderrTail: progress.stderrTail,
              });
            },
          },
        );
      } catch (error) {
        context?.emitProgress?.({
          phase: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const outputPaths = result.outputPaths;
      context?.emitProgress?.({
        phase: "verifying_outputs",
        elapsedMs: result.durationMs,
        message: "Verifying QGIS output files",
        outputPaths,
        missingOutputPaths: result.missingOutputPaths,
      });
      if (!result.ok) {
        context?.markArtifactsMissing?.(
          result.missingOutputPaths.length > 0
            ? result.missingOutputPaths
            : outputPaths,
          result.stdoutTail,
        );
        throw new Error("qgis_process reported an error:\n" + result.stdoutTail);
      }
      context?.markArtifactsReady?.(outputPaths);
      const parts = ["Algorithm " + algorithmId + " completed."];
      if (Object.keys(result.results).length > 0) {
        parts.push("Results: " + JSON.stringify(result.results, null, 2));
      }
      if (result.outputPaths.length > 0) {
        parts.push("Output files:\n  " + result.outputPaths.join("\n  "));
      }
      return parts.join("\n");
    },
    // Side effects (writes output files). Exclusive until path-collision-aware
    // refinement lands (parallel runs with distinct OUTPUT paths).
    isConcurrencySafe: () => false,
    producesArtifacts: getQgisOutputPaths,
  };
}

export function createQgisTools(getRuntime: RuntimeGetter): QgisTool[] {
  return [makeListTool(getRuntime), makeDescribeTool(getRuntime), makeRunTool(getRuntime)];
}

function requireRuntime(runtime: QgisRuntimeInfo | undefined): QgisRuntimeInfo {
  if (!runtime) {
    throw new Error("QGIS runtime is not configured. Ask the user to run /qgis to set it up.");
  }
  return runtime;
}

function getAlgorithmId(args: unknown): string {
  if (typeof args !== "object" || args === null) {
    throw new Error("An algorithm id is required.");
  }
  const algorithm = (args as { algorithm?: unknown }).algorithm;
  if (typeof algorithm !== "string" || !algorithm.trim()) {
    throw new Error("An algorithm id is required.");
  }
  return algorithm.trim();
}

function getTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return QGIS_EXECUTE_TIMEOUT_MS;
  }
  const ms = value * 1000;
  return Math.min(Math.max(Math.floor(ms), RUN_TIMEOUT_RANGE[0]), RUN_TIMEOUT_RANGE[1]);
}

function resolveParameterPaths(
  parameters: Record<string, string | number | boolean>,
): void {
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const looksLikePath = WINDOWS_ABSOLUTE_PATH.test(trimmed)
      || trimmed.startsWith("\\\\")
      || trimmed.includes("/")
      || trimmed.includes("\\");
    if (!looksLikePath) continue;
    parameters[key] = resolveWorkspacePath(trimmed);
  }
}

function getQgisOutputPaths(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const rawParameters = (args as { parameters?: unknown }).parameters;
  if (
    typeof rawParameters !== "object" ||
    rawParameters === null ||
    Array.isArray(rawParameters)
  ) {
    return [];
  }
  const paths: string[] = [];
  for (const [key, value] of Object.entries(rawParameters)) {
    if (!/^OUTPUT(?:_|$)/iu.test(key) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || /^TEMPORARY_OUTPUT$/iu.test(trimmed)) continue;
    paths.push(resolveWorkspacePath(trimmed));
  }
  return paths;
}

function resolveWorkspacePath(value: string): string {
  const isAbsolute = WINDOWS_ABSOLUTE_PATH.test(value) || value.startsWith("\\\\");
  if (isAbsolute) return value;
  return join(process.cwd(), value);
}
