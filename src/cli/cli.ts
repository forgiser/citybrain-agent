import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { startWebApp } from "../adapters/web/index.js";
import { startInteractiveApp } from "../app/interactive-app.js";
import { createAgentRuntime } from "../runtime/index.js";
import { createAgentHostProfile } from "../host/index.js";
import { runWorkspaceProfileWorker } from "../profile/index.js";
import { runEvalCli } from "../eval/eval-cli.js";
import { runWorkflowCli } from "../workflow/workflow-cli.js";
import { runMcpCli } from "../mcp/mcp-cli.js";

type LaunchMode = "cli" | "web";

interface LaunchOptions {
  mode?: string;
  port: string;
  open: boolean;
}

function buildProgram(): Command {
  return new Command()
    .name("citybrain")
    .description("Agent for urban geospatial analysis and governance")
    .version("0.1.0")
    .argument("[command]", "cli or web")
    .option("--mode <mode>", "launch mode: cli or web")
    .option("--port <port>", "local Web UI port", "3170")
    .option("--no-open", "do not open the browser automatically")
    .addHelpText("after", "\n独立命令：\n  citybrain eval --help\n  citybrain workflow --help\n  citybrain mcp --help\nCLI 交互命令：/observe、/workflow、/mcp\n");
}

export async function runCli(argv: string[]): Promise<void> {
  if (argv[2] === "eval") {
    await runEvalCli(argv.slice(3));
    return;
  }
  if (argv[2] === "workflow") {
    await runWorkflowCli(argv.slice(3));
    return;
  }
  if (argv[2] === "mcp") {
    await runMcpCli(argv.slice(3));
    return;
  }
  if (argv[2] === "__profile-worker") {
    const jobPath = argv[3];
    if (!jobPath) throw new Error("A profile worker job path is required.");
    await runWorkspaceProfileWorker(jobPath);
    return;
  }
  const program = buildProgram();
  program.parse(argv);
  const options = program.opts<LaunchOptions>();
  const command = program.args[0];
  const mode = normalizeMode(options.mode ?? command) ?? await selectMode();
  if (mode === "web") {
    await runWebMode(options);
    return;
  }

  const runtime = await createAgentRuntime({
    cwd: process.cwd(),
    hostProfile: createAgentHostProfile("cli"),
  });
  await startInteractiveApp(runtime);
}

async function runWebMode(options: LaunchOptions): Promise<void> {
  const port = Number.parseInt(options.port, 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  const runtime = await createAgentRuntime({
    cwd: process.cwd(),
    hostProfile: createAgentHostProfile("web"),
  });
  const app = await startWebApp(runtime, {
    port,
    openBrowser: options.open,
  });
  stdout.write(`\nGeo-agent Web UI 已启动：\n\n  ${app.address}\n\n按 Ctrl+C 停止服务\n`);

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void app.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function selectMode(): Promise<LaunchMode> {
  if (!stdin.isTTY || !stdout.isTTY) return "cli";
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await reader.question(
      "请选择 Geo-agent 运行模式：\n\n  1. CLI\n  2. Web UI\n\n请输入选项 [1]: ",
    );
    return answer.trim() === "2" ? "web" : "cli";
  } finally {
    reader.close();
  }
}

function normalizeMode(value: string | undefined): LaunchMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "cli" || normalized === "web") return normalized;
  throw new Error(`Unknown launch mode: ${value}. Use cli or web.`);
}
