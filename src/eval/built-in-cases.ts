import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCases } from "./eval-runner.js";

export function loadBuiltInEvalCases() {
  return loadEvalCases(resolve(dirname(fileURLToPath(import.meta.url)), "../../evals/cases/core.json"));
}
