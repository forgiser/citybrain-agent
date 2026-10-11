import type { ToolSpec } from "./core/contracts/tool-spec.js";
import { createEditFileTool } from "./edit-file/index.js";
import { createListFilesTool } from "./list-files/index.js";
import { createReadFileTool } from "./read-file/index.js";
import { createWriteFileTool } from "./write-file/index.js";
import { createListQgisAlgorithmsTool } from "./list-qgis-algorithms/index.js";
import { createDescribeQgisAlgorithmTool } from "./describe-qgis-algorithm/index.js";
import { createRunQgisAlgorithmTool } from "./run-qgis-algorithm/index.js";
export { createTaskManagementTools } from "./task-management/index.js";
export { createMapTools } from "./map/index.js";
export { createHumanInteractionTools } from "./human-interaction/index.js";

export * from "./core/index.js";
export * from "./delegate/index.js";
export * from "./edit-file/index.js";
export * from "./list-files/index.js";
export * from "./read-file/index.js";
export * from "./write-file/index.js";
export * from "./list-qgis-algorithms/index.js";
export * from "./describe-qgis-algorithm/index.js";
export * from "./run-qgis-algorithm/index.js";
export * from "./task-management/index.js";
export * from "./map/index.js";
export * from "./human-interaction/index.js";

export interface FileToolFactoryDependencies {
  getCwd: () => string;
}

export function createFileTools(
  deps: FileToolFactoryDependencies,
): ToolSpec[] {
  return [
    createReadFileTool(deps),
    createListFilesTool(deps),
    createWriteFileTool(),
    createEditFileTool(),
  ];
}

export function createQgisTools(
  getRuntime: Parameters<typeof createListQgisAlgorithmsTool>[0],
): ToolSpec[] {
  return [
    createListQgisAlgorithmsTool(getRuntime),
    createDescribeQgisAlgorithmTool(getRuntime),
    createRunQgisAlgorithmTool(getRuntime),
  ];
}
