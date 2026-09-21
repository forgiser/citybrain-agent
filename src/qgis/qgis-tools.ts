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
import type {
  ToolCallContext,
  ToolRegistrationOptions,
} from "../tools/tool-registry.js";

export interface QgisTool {
  definition: ChatToolDefinition;
  handler: (args: unknown, context?: ToolCallContext) => Promise<string>;
  /**
   * Concurrency verdict for a parsed-arguments call. list/describe are
   * read-only and may run in parallel; run has side effects (writes output
   * files) and executes exclusively. A path-collision-aware refinement —
   * parallel runs with distinct OUTPUT paths — is a later refinement.
   */
  producesArtifacts?: (args: unknown, context?: ToolCallContext) => string[];
  metadata?: ToolRegistrationOptions;
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

      resolveParameterPaths(parameters, context);
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
            cwd: context?.sandbox?.sandboxRoot,
            env: context?.sandbox?.getProcessEnvironment(),
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
      for (const outputPath of outputPaths) {
        context?.sandbox?.assertWritable(outputPath);
      }
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
    // The shared ToolMetadata contract makes this decision from the parsed
    // algorithm call. Unknown or write-producing algorithms stay exclusive.
    producesArtifacts: getQgisOutputPaths,
    metadata: {
      source: "qgis",
      isReadOnly: () => false,
      isDestructive: (args) => getQgisOutputPaths(args).length > 0,
      isConcurrencySafe: isQgisAlgorithmConcurrencySafe,
      interruptBehavior: "block",
      getPath: getQgisInputPaths,
      getReadPaths: getQgisInputPaths,
      getWritePaths: getQgisOutputParameterPaths,
      getActivityDescription: (args) => {
        const algorithm = getStringField(args, "algorithm");
        return algorithm ? `Running QGIS ${algorithm}` : "Running QGIS algorithm";
      },
      getToolUseSummary: (args) => {
        const algorithm = getStringField(args, "algorithm");
        const outputs = getQgisOutputPaths(args);
        return [algorithm, outputs.length > 0 ? `output=${outputs[0]}` : undefined]
          .filter(Boolean)
          .join(" ") || "algorithm";
      },
      maxResultSizeChars: 20_000,
    },
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

/**
 * Conservative QGIS parallelism policy.
 *
 * QGIS exposes hundreds of algorithms and their side effects are not encoded
 * uniformly in qgis_process output. Keep the default exclusive and explicitly
 * allow algorithms whose contract is read-only and does not produce a file.
 */
function isQgisAlgorithmConcurrencySafe(args: unknown): boolean {
  const algorithm = getStringField(args, "algorithm")?.toLowerCase();
  if (!algorithm || getQgisOutputPaths(args).length > 0) return false;

  return new Set([
    "gdal:gdalinfo",
    "gdal:ogrinfo",
    "native:basicstatisticsforfields",
    "native:basicstatisticsforrasterlayer",
    "native:rasterlayerstatistics",
    "native:vectorlayerhistogram",
  ]).has(algorithm);
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
  context?: ToolCallContext,
): void {
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const isOutput = /^OUTPUT(?:_|$)/iu.test(key);
    if (isOutput) {
      if (/^TEMPORARY_OUTPUT$/iu.test(trimmed)) continue;
      if (!context?.sandbox) {
        parameters[key] = resolveWorkspacePath(trimmed);
      } else {
        parameters[key] = context.sandbox.resolveWritePath(trimmed);
      }
      continue;
    }

    const looksLikePath = WINDOWS_ABSOLUTE_PATH.test(trimmed)
      || trimmed.startsWith("\\\\")
      || (isPathParameterKey(key) &&
        (trimmed.includes("/") || trimmed.includes("\\")));
    if (!looksLikePath) continue;
    if (!context?.sandbox) {
      parameters[key] = resolveWorkspacePath(trimmed);
      continue;
    }

    parameters[key] = context.sandbox.resolveReadPath(
      trimmed,
      context.sandbox.projectDir,
    );
  }
}

function isPathParameterKey(key: string): boolean {
  return /(?:INPUT|LAYER|SOURCE|OVERLAY|MASK|RASTER|VECTOR|DATABASE|FILE|PATH|DIRECTORY|TABLE|URI)/iu.test(
    key,
  );
}

function getQgisOutputPaths(args: unknown, context?: ToolCallContext): string[] {
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
    paths.push(
      context?.sandbox
        ? context.sandbox.resolveWritePath(trimmed)
        : resolveWorkspacePath(trimmed),
    );
  }
  return paths;
}

function getQgisOutputParameterPaths(args: unknown): string[] {
  if (!isRecord(args) || !isRecord(args.parameters)) return [];
  return Object.entries(args.parameters)
    .filter(([key, value]) =>
      /^OUTPUT(?:_|$)/iu.test(key) &&
      typeof value === "string" &&
      value.trim() &&
      !/^TEMPORARY_OUTPUT$/iu.test(value.trim()),
    )
    .map(([, value]) => value as string);
}

function getQgisInputPaths(args: unknown): string[] {
  if (!isRecord(args) || !isRecord(args.parameters)) return [];
  return Object.entries(args.parameters)
    .filter(([key, value]) =>
      !/^OUTPUT(?:_|$)/iu.test(key) &&
      typeof value === "string" &&
      (isPathParameterKey(key) || WINDOWS_ABSOLUTE_PATH.test(value)),
    )
    .map(([, value]) => value as string);
}

function getStringField(args: unknown, key: string): string | undefined {
  return isRecord(args) && typeof args[key] === "string"
    ? args[key] as string
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWorkspacePath(value: string): string {
  const isAbsolute = WINDOWS_ABSOLUTE_PATH.test(value) || value.startsWith("\\\\");
  if (isAbsolute) return value;
  return join(process.cwd(), value);
}
