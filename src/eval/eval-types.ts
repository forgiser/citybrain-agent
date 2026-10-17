export interface EvalOutputExpectation {
  path: string;
  format?: "geojson" | "json" | "csv" | "file";
  geometryType?: string;
  minFeatures?: number;
  maxFeatures?: number;
  crs?: string;
  requiredFields?: string[];
}

export interface EvalCase {
  id: string;
  name: string;
  prompt: string;
  projectDir: string;
  expected: {
    requiredTools?: string[];
    forbiddenTools?: string[];
    outputFiles?: EvalOutputExpectation[];
    maxToolCalls?: number;
    maxTokens?: number;
    requireHitl?: boolean;
    requireNoSandboxViolation?: boolean;
    mapLayers?: { minCount?: number; names?: string[] };
  };
  tags?: string[];
}

export interface EvalCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvalCaseResult {
  caseId: string;
  name: string;
  runId: string;
  passed: boolean;
  checks: EvalCheck[];
  metrics: {
    toolCalls: number;
    successfulTools: number;
    modelRequests: number;
    totalTokens: number;
    durationMs: number;
    hitlRequests: number;
  };
}

export interface EvalReport {
  generatedAt: string;
  model: string;
  promptVersion: string;
  codeVersion: string;
  cases: EvalCaseResult[];
  summary: {
    total: number;
    passed: number;
    successRate: number;
    averageToolCalls: number;
    averageTokens: number;
    p95DurationMs: number;
  };
  comparison?: {
    baselineModel: string;
    baselinePromptVersion: string;
    baselineCodeVersion: string;
    successRateDelta: number;
    averageToolCallsDelta: number;
    averageTokensDelta: number;
    p95DurationMsDelta: number;
    regressedCases: string[];
    improvedCases: string[];
  };
}
