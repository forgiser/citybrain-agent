import {
  makeRunQgisAlgorithmTool,
  type RuntimeGetter,
} from "./implementation.js";

export function createRunQgisAlgorithmTool(getRuntime: RuntimeGetter) {
  return makeRunQgisAlgorithmTool(getRuntime);
}
