import { resolve } from "node:path";
import { Command } from "commander";
import { createAgentHostProfile } from "../host/index.js";
import { createAgentRuntime } from "../runtime/create-runtime.js";

export async function runWorkflowCli(argv: string[]): Promise<void> {
  const program = new Command("workflow")
    .description("从 Agent Run 提取并复跑空间分析工作流")
    .argument("<action>", "list | draft | show | run | status")
    .argument("[id]", "Run ID or workflow ID")
    .option("--project-dir <path>", "项目目录，默认为当前目录", process.cwd())
    .option("--name <name>", "创建草稿时的名称");
  program.parse(argv, { from: "user" });
  const { projectDir, name } = program.opts<{ projectDir: string; name?: string }>();
  const [action, id] = program.args;
  const runtime = await createAgentRuntime({ cwd: resolve(projectDir), hostProfile: createAgentHostProfile("cli") });
  try {
    if (action === "list") {
      const definitions = runtime.workflows.list();
      process.stdout.write(definitions.length ? `${definitions.map((item) => `${item.id}\t${item.name}\t${item.nodes.length} nodes`).join("\n")}\n` : "当前项目暂无工作流。\n");
    } else if (action === "draft" && id) {
      const definition = runtime.workflows.createFromRun(id, name);
      process.stdout.write(`${JSON.stringify(definition, null, 2)}\n`);
    } else if (action === "show" && id) {
      process.stdout.write(`${JSON.stringify(runtime.workflows.get(id), null, 2)}\n`);
    } else if (action === "status" && id) {
      process.stdout.write(`${JSON.stringify(runtime.workflows.getExecution(id) ?? { status: "not_started" }, null, 2)}\n`);
    } else if (action === "run" && id) {
      const task = runtime.workflows.submit(runtime.taskManager, id);
      process.stdout.write(`已提交任务 ${task.id}，等待执行结果…\n`);
      const finished = await runtime.taskManager.wait(task.id);
      process.stdout.write(`${JSON.stringify({ taskId: task.id, status: finished.status, attempt: finished.attempt, error: finished.error, execution: runtime.workflows.getExecution(id) }, null, 2)}\n`);
      if (finished.status !== "completed") process.exitCode = 1;
    } else {
      throw new Error("用法：citybrain workflow <list|draft|show|run|status> [ID] [--project-dir 目录]");
    }
  } finally {
    await runtime.dispose("workflow CLI finished");
  }
}
