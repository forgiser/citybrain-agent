import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EvalCase, EvalCaseResult, EvalCheck, EvalOutputExpectation, EvalReport } from "./eval-types.js";

type JsonRecord = Record<string, unknown>;

export function loadEvalCase(path: string): EvalCase {
  const cases = loadEvalCases(path);
  if (cases.length !== 1) throw new Error(`Expected exactly one eval case in ${path}`);
  return cases[0];
}

export function loadEvalCases(path: string): EvalCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return (Array.isArray(parsed) ? parsed : [parsed]).map((value) => parseEvalCase(value, path));
}

function parseEvalCase(value: unknown, path: string): EvalCase {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(value.id) ||
    typeof value.prompt !== "string" || typeof value.projectDir !== "string" || !isRecord(value.expected)) {
    throw new Error(`Invalid eval case: ${path}`);
  }
  const input = value as unknown as EvalCase;
  return { ...input, projectDir: resolve(dirname(path), input.projectDir) };
}

/** Offline evaluation of an actual Agent run, using its durable execution evidence. */
export function evaluateRecordedRun(testCase: EvalCase, runId: string): EvalCaseResult {
  const workspaceDir = resolve(testCase.projectDir, "citybrain");
  const logRoot = resolve(workspaceDir, ".internal", "logs");
  const tools = readEvents(resolve(logRoot, "tool-execution.jsonl"), runId);
  const usage = readEvents(resolve(logRoot, "context-usage.jsonl"), runId);
  const starts = tools.filter((item) => item.phase === "start");
  const finishes = tools.filter((item) => item.phase === "finish");
  const states = tools.filter((item) => item.phase === "state");
  const toolNames = starts.map((item) => String(item.tool ?? ""));
  const checks: EvalCheck[] = [];
  const add = (name: string, passed: boolean, detail: string): void => { checks.push({ name, passed, detail }); };
  add("run_completed", states.some((item) => item.state === "completed"), "Agent Run reached completed state");
  for (const tool of testCase.expected.requiredTools ?? []) {
    add(`required_tool:${tool}`, toolNames.includes(tool), `Expected tool ${tool}`);
  }
  for (const tool of testCase.expected.forbiddenTools ?? []) {
    add(`forbidden_tool:${tool}`, !toolNames.includes(tool), `Forbidden tool ${tool}`);
  }
  const toolCalls = starts.length;
  if (testCase.expected.maxToolCalls !== undefined) {
    add("tool_budget", toolCalls <= testCase.expected.maxToolCalls, `${toolCalls}/${testCase.expected.maxToolCalls} calls`);
  }
  const responseUsage = usage.filter((item) => item.stage === "after_response");
  const totalTokens = responseUsage.reduce((sum, item) => sum + number(item.totalTokens, 0), 0);
  if (testCase.expected.maxTokens !== undefined) {
    add("token_budget", totalTokens <= testCase.expected.maxTokens, `${totalTokens}/${testCase.expected.maxTokens} tokens`);
  }
  const hitlRequests = tools.filter((item) => item.stage === "human_created").length;
  if (testCase.expected.requireHitl !== undefined) {
    add("hitl", (hitlRequests > 0) === testCase.expected.requireHitl, `${hitlRequests} requests`);
  }
  if (testCase.expected.requireNoSandboxViolation) {
    const violations = tools.filter((item) => item.errorCode === "sandbox_violation" || String(item.detail ?? "").includes("sandbox violation"));
    add("sandbox", violations.length === 0, `${violations.length} violations`);
  }
  if (testCase.expected.mapLayers) {
    const mapResults = finishes.filter((item) => item.ok === true && ["map_get_state", "map_manage_layer"].includes(String(item.tool)));
    const latest = [...mapResults].reverse().map((item) => {
      try { return JSON.parse(String(item.result ?? "")) as unknown; } catch { return undefined; }
    }).find((item) => isRecord(item) && Array.isArray(item.layers));
    const layers = isRecord(latest) && Array.isArray(latest.layers) ? latest.layers : [];
    const names = layers.flatMap((item) => isRecord(item) && typeof item.name === "string" ? [item.name] : []);
    const countMatch = layers.length >= (testCase.expected.mapLayers.minCount ?? 0);
    const namesMatch = (testCase.expected.mapLayers.names ?? []).every((name) => names.includes(name));
    add("map_layers", Boolean(latest) && countMatch && namesMatch, `${layers.length} layers; names: ${names.join(", ")}`);
  }
  for (const expectation of testCase.expected.outputFiles ?? []) {
    checks.push(evaluateOutput(testCase.projectDir, expectation));
  }
  const timestamps = tools.map((item) => Date.parse(String(item.timestamp ?? ""))).filter(Number.isFinite);
  const durationMs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  return {
    caseId: testCase.id,
    name: testCase.name,
    runId,
    passed: checks.every((check) => check.passed),
    checks,
    metrics: {
      toolCalls,
      successfulTools: finishes.filter((item) => item.ok === true).length,
      modelRequests: responseUsage.length,
      totalTokens,
      durationMs,
      hitlRequests,
    },
  };
}

export function buildEvalReport(results: EvalCaseResult[], metadata: { model: string; promptVersion: string; codeVersion: string }): EvalReport {
  const durations = results.map((item) => item.metrics.durationMs).sort((a, b) => a - b);
  const total = results.length;
  const passed = results.filter((item) => item.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    ...metadata,
    cases: results,
    summary: {
      total,
      passed,
      successRate: total > 0 ? passed / total : 0,
      averageToolCalls: total > 0 ? results.reduce((sum, item) => sum + item.metrics.toolCalls, 0) / total : 0,
      averageTokens: total > 0 ? results.reduce((sum, item) => sum + item.metrics.totalTokens, 0) / total : 0,
      p95DurationMs: durations[Math.max(0, Math.ceil(total * 0.95) - 1)] ?? 0,
    },
  };
}

export function formatEvalReportMarkdown(report: EvalReport): string {
  const rows = report.cases.map((item) =>
    `| ${escapeCell(item.caseId)} | ${item.passed ? "通过" : "失败"} | ${item.metrics.toolCalls} | ${item.metrics.totalTokens} | ${item.metrics.durationMs} | ${item.checks.filter((check) => !check.passed).map((check) => check.name).join(", ") || "—"} |`);
  return [
    "# CityBrain Agent 评测报告", "",
    `- 生成时间：${report.generatedAt}`,
    `- 模型：${report.model}`,
    `- Prompt 版本：${report.promptVersion}`,
    `- 代码版本：${report.codeVersion}`,
    `- 成功率：${(report.summary.successRate * 100).toFixed(1)}%（${report.summary.passed}/${report.summary.total}）`,
    `- 平均工具调用：${report.summary.averageToolCalls.toFixed(1)}`,
    `- 平均 Token：${report.summary.averageTokens.toFixed(0)}`,
    `- P95 耗时：${report.summary.p95DurationMs} ms`, "",
    "| 用例 | 结果 | 工具调用 | Token | 耗时 ms | 失败检查 |",
    "| --- | --- | ---: | ---: | ---: | --- |", ...rows, "",
    ...(report.comparison ? [
      "## 与基线比较", "",
      `- 基线：${report.comparison.baselineModel} / Prompt ${report.comparison.baselinePromptVersion} / Code ${report.comparison.baselineCodeVersion}`,
      `- 成功率变化：${(report.comparison.successRateDelta * 100).toFixed(1)} 个百分点`,
      `- 平均工具调用变化：${report.comparison.averageToolCallsDelta.toFixed(1)}`,
      `- 平均 Token 变化：${report.comparison.averageTokensDelta.toFixed(0)}`,
      `- P95 耗时变化：${report.comparison.p95DurationMsDelta} ms`,
      `- 退化用例：${report.comparison.regressedCases.join(", ") || "无"}`,
      `- 改善用例：${report.comparison.improvedCases.join(", ") || "无"}`, "",
    ] : []),
  ].join("\n");
}

export function compareEvalReports(report: EvalReport, baseline: EvalReport): void {
  const oldCases = new Map(baseline.cases.map((item) => [item.caseId, item.passed]));
  report.comparison = {
    baselineModel: baseline.model,
    baselinePromptVersion: baseline.promptVersion,
    baselineCodeVersion: baseline.codeVersion,
    successRateDelta: report.summary.successRate - baseline.summary.successRate,
    averageToolCallsDelta: report.summary.averageToolCalls - baseline.summary.averageToolCalls,
    averageTokensDelta: report.summary.averageTokens - baseline.summary.averageTokens,
    p95DurationMsDelta: report.summary.p95DurationMs - baseline.summary.p95DurationMs,
    regressedCases: report.cases.filter((item) => oldCases.get(item.caseId) === true && !item.passed).map((item) => item.caseId),
    improvedCases: report.cases.filter((item) => oldCases.get(item.caseId) === false && item.passed).map((item) => item.caseId),
  };
}

function evaluateOutput(projectDir: string, expected: EvalOutputExpectation): EvalCheck {
  const path = resolve(projectDir, expected.path);
  if (!existsSync(path)) return { name: `output:${expected.path}`, passed: false, detail: "File does not exist" };
  try {
    if (expected.format === "geojson" || expected.geometryType || expected.minFeatures !== undefined) {
      const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const features = isRecord(value) && value.type === "FeatureCollection" && Array.isArray(value.features) ? value.features : [];
      if (!isRecord(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) throw new Error("Invalid GeoJSON FeatureCollection");
      const geometryMatch = !expected.geometryType || (features.length > 0 && features.every((feature) => isRecord(feature) && isRecord(feature.geometry) && feature.geometry.type === expected.geometryType));
      const countMatch = expected.minFeatures === undefined || features.length >= expected.minFeatures;
      const maxMatch = expected.maxFeatures === undefined || features.length <= expected.maxFeatures;
      const fields = new Set(features.flatMap((feature) => isRecord(feature) && isRecord(feature.properties) ? Object.keys(feature.properties) : []));
      const fieldMatch = (expected.requiredFields ?? []).every((field) => fields.has(field));
      const crs = isRecord(value.crs) && isRecord(value.crs.properties) ? String(value.crs.properties.name ?? "") : "";
      const crsMatch = !expected.crs || crs.toUpperCase() === expected.crs.toUpperCase();
      return { name: `output:${expected.path}`, passed: geometryMatch && countMatch && maxMatch && fieldMatch && crsMatch, detail: `${features.length} features; geometry ${expected.geometryType ?? "any"}; CRS ${crs || "unspecified"}` };
    }
    if (expected.format === "json") JSON.parse(readFileSync(path, "utf8"));
    if (expected.format === "csv") {
      const firstLine = readFileSync(path, "utf8").split(/\r?\n/u, 1)[0];
      if (!firstLine?.includes(",")) throw new Error("Missing CSV header");
    }
    return { name: `output:${expected.path}`, passed: true, detail: "File exists and format is readable" };
  } catch (error) {
    return { name: `output:${expected.path}`, passed: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function readEvents(path: string, runId: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/u).flatMap((line): JsonRecord[] => {
    try { const value = JSON.parse(line) as unknown; return isRecord(value) && value.runId === runId ? [value] : []; }
    catch { return []; }
  });
}

function number(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function escapeCell(value: string): string { return value.replaceAll("|", "\\|").replaceAll("\n", " "); }
