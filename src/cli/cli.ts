import { Command } from "commander";
import { startInteractiveApp } from "../app/interactive-app.js";

function buildProgram(): Command {
  return new Command()
    .name("citybrain")
    .description("Interactive CLI for urban data analysis and governance")
    .version("0.1.0");
}

export async function runCli(argv: string[]): Promise<void> {
  if (argv.length <= 2) {
    await startInteractiveApp();
    return;
  }

  await buildProgram().parseAsync(argv);
}
