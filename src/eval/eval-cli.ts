import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { createAgentRuntime } from "../runtime/create-runtime.js";
import { createAgentHostProfile } from "../host/index.js";
import { buildEvalReport, compareEvalReports, evaluateRecordedRun, formatEvalReportMarkdown, loadEvalCases } from "./eval-runner.js";
import type { EvalCaseResult, EvalReport } from "./eval-types.js";

interface EvalOptions {
  cases: string;
  runId?: string;
  runMap?: string;
  execute?: boolean;
  output: string;
  model: string;
  promptVersion: string;
  codeVersion: string;
  baseline?: string;
  includeHitl?: boolean;
  case?: string;
  projectDir?: string;
}

export async function runEvalCli(argv: string[]): Promise<void> {
  const program = new Command("eval")
    .requiredOption("--cases <path>", "JSON case file or directory")
    .option("--case <id>", "run or evaluate one case from a suite")
    .option("--run-id <id>", "evaluate one existing Agent run")
    .option("--run-map <path>", "JSON map from case id to existing run id")
    .option("--project-dir <path>", "project directory containing the recorded Run; offline modes only")
    .option("--execute", "execute each case with the configured model in an isolated temporary workspace")
    .option("--include-hitl", "include interactive HITL cases in --execute mode")
    .option("--baseline <path>", "previous JSON report for regression comparison")
    .option("--output <path>", "report prefix", "evals/results/latest")
    .option("--model <name>", "model label for an existing run", "recorded")
    .option("--prompt-version <version>", "Prompt version", "current")
    .option("--code-version <version>", "code version", "working-tree");
  program.parse(argv, { from: "user" });
  const options = program.opts<EvalOptions>();
  if (Number(Boolean(options.runId)) + Number(Boolean(options.runMap)) + Number(Boolean(options.execute)) !== 1) {
    throw new Error("Choose exactly one of --run-id, --run-map, or --execute.");
  }
  const casePath = resolve(options.cases);
  const files = existsSync(casePath) && readdirSafe(casePath)
    ? readdirSync(casePath, { recursive: true }).map(String).filter((file) => file.endsWith(".json")).map((file) => join(casePath, file))
    : [casePath];
  const cases = files.flatMap(loadEvalCases).filter((item) =>
    (!options.case || item.id === options.case) &&
    (!options.execute || (!item.tags?.includes("web") && (options.includeHitl || !item.tags?.includes("hitl")))))
    .map((item) => options.projectDir && !options.execute ? { ...item, projectDir: resolve(options.projectDir) } : item);
  if (cases.length === 0) throw new Error("No eval cases found.");
  if (options.runId && cases.length !== 1) throw new Error("--run-id requires exactly one case.");
  const runMap = options.runMap ? JSON.parse(readFileSync(resolve(options.runMap), "utf8")) as Record<string, string> : {};
  const results: EvalCaseResult[] = [];
  let model = options.model;
  for (const testCase of cases) {
    if (options.execute) {
      const root = mkdtempSync(join(tmpdir(), `citybrain-eval-${testCase.id}-`));
      try {
        const projectDir = join(root, "project");
        cpSync(testCase.projectDir, projectDir, { recursive: true });
        const runtime = await createAgentRuntime({ cwd: projectDir, hostProfile: createAgentHostProfile("cli") });
        try {
          model = runtime.modelRuntime.getSelectedModel()?.id ?? "unknown";
          let runId = "";
          for await (const event of runtime.agentLoop.run(testCase.prompt)) {
            if ("runId" in event && typeof event.runId === "string") runId = event.runId;
          }
          if (!runId) throw new Error(`No Agent run id was emitted for ${testCase.id}.`);
          await Promise.all([runtime.toolLogger.flush(), runtime.contextLogger.flush()]);
          results.push(evaluateRecordedRun({ ...testCase, projectDir }, runId));
        } finally { await runtime.dispose("eval finished"); }
      } catch (error) {
        results.push({
          caseId: testCase.id, name: testCase.name, runId: "", passed: false,
          checks: [{ name: "execution", passed: false, detail: error instanceof Error ? error.message : String(error) }],
          metrics: { toolCalls: 0, successfulTools: 0, modelRequests: 0, totalTokens: 0, durationMs: 0, hitlRequests: 0 },
        });
      } finally { rmSync(root, { recursive: true, force: true }); }
    } else {
      const runId = options.runId ?? runMap[testCase.id];
      if (!runId) throw new Error(`No recorded run id for ${testCase.id}.`);
      results.push(evaluateRecordedRun(testCase, runId));
    }
  }
  const report = buildEvalReport(results, {
    model, promptVersion: options.promptVersion, codeVersion: options.codeVersion,
  });
  if (options.baseline) compareEvalReports(report, JSON.parse(readFileSync(resolve(options.baseline), "utf8")) as EvalReport);
  const prefix = resolve(options.output);
  mkdirSync(dirname(prefix), { recursive: true });
  writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(`${prefix}.md`, formatEvalReportMarkdown(report), "utf8");
  process.stdout.write(`${basename(prefix)}: ${report.summary.passed}/${report.summary.total} cases passed\n`);
  if (report.summary.passed !== report.summary.total) process.exitCode = 1;
}

function readdirSafe(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
