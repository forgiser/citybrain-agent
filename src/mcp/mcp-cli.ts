import { Command } from "commander";
import { McpService } from "./mcp-service.js";

export async function runMcpCli(argv: string[]): Promise<void> {
  const service = new McpService();
  const program = new Command()
    .name("citybrain mcp")
    .description("管理外接 MCP Server（配置保存在本机 CityBrain 用户目录）");
  program.command("list").description("列出服务和连接状态")
    .action(() => print(service.list()));
  program.command("add-stdio <name> <command> [args...]")
    .description("注册本地 stdio 服务")
    .option("--cwd <path>", "子进程工作目录")
    .option("--env <names>", "显式传给子进程的环境变量名，逗号分隔")
    .option("--description <text>", "服务用途简介")
    .action(async (name: string, command: string, args: string[], options: {
      cwd?: string; env?: string; description?: string;
    }) => print(await service.upsert({
      name, transport: "stdio", command, args, enabled: true,
      cwd: options.cwd,
      envVars: csv(options.env),
      description: options.description,
    })));
  program.command("add-http <name> <url>")
    .description("注册 Streamable HTTP 服务")
    .option("--header-env <pairs>", "HTTP header=环境变量名，多个以逗号分隔")
    .option("--description <text>", "服务用途简介")
    .action(async (name: string, url: string, options: {
      headerEnv?: string; description?: string;
    }) => print(await service.upsert({
      name, transport: "http", url, enabled: true,
      headerEnv: parseHeaderEnv(options.headerEnv),
      description: options.description,
    })));
  program.command("remove <name>").description("移除服务配置")
    .action(async (name: string) => print({ removed: await service.remove(name) }));
  program.command("enable <name>").description("启用服务")
    .action(async (name: string) => print(await service.setEnabled(name, true)));
  program.command("disable <name>").description("禁用服务并断开连接")
    .action(async (name: string) => print(await service.setEnabled(name, false)));
  program.command("test <name>").description("连接并发现工具，测试服务是否可用")
    .action(async (name: string) => {
      await service.connect(name);
      print({ server: name, tools: await service.listTools(name) });
    });
  program.command("tools <name>").description("列出某个服务提供的工具")
    .action(async (name: string) => print((await service.listTools(name))
      .map(({ name: tool, description }) => ({ name: tool, description }))));
  program.command("inspect <name> <tool>").description("查看 MCP 工具的输入 schema")
    .action(async (name: string, tool: string) => print(await service.inspectTool(name, tool)));
  try {
    if (argv.length === 0) {
      program.outputHelp();
      return;
    }
    await program.parseAsync(argv, { from: "user" });
  } finally {
    await service.dispose();
  }
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
}

function parseHeaderEnv(value: string | undefined): Record<string, string> {
  return Object.fromEntries(csv(value).map((pair) => {
    const equals = pair.indexOf("=");
    if (equals <= 0 || equals === pair.length - 1) {
      throw new Error(`Invalid header-env pair: ${pair}. Use Header=ENV_VAR.`);
    }
    return [pair.slice(0, equals), pair.slice(equals + 1)];
  }));
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
