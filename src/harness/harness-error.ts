import type {
  HarnessError,
  HarnessErrorCategory,
  HarnessLayer,
  HarnessRecovery,
  HarnessScope,
  HarnessSideEffect,
} from "./harness-types.js";

export interface HarnessErrorOptions {
  code?: string;
  category?: HarnessErrorCategory;
  layer: HarnessLayer;
  phase: string;
  scope: HarnessScope;
  retryable?: boolean;
  recovery?: HarnessRecovery;
  sideEffect?: HarnessSideEffect;
  details?: Record<string, unknown>;
}

export function normalizeHarnessError(
  error: unknown,
  options: HarnessErrorOptions,
): HarnessError {
  const message = getErrorMessage(error);
  const inferred = inferError(message, error);
  return {
    code: options.code ?? inferred.code,
    category: options.category ?? inferred.category,
    layer: options.layer,
    phase: options.phase,
    scope: options.scope,
    message,
    retryable: options.retryable ?? inferred.retryable,
    recovery: options.recovery ?? inferred.recovery,
    sideEffect: options.sideEffect ?? inferred.sideEffect,
    ...(options.details ? { details: options.details } : {}),
    ...(error !== undefined ? { cause: error } : {}),
  };
}

export function harnessErrorToMessage(error: HarnessError): string {
  return [
    `[${error.category}] ${error.message}`,
    `layer=${error.layer}`,
    `phase=${error.phase}`,
    `recovery=${error.recovery}`,
  ].join("\n");
}

function inferError(
  message: string,
  error: unknown,
): Pick<HarnessError, "code" | "category" | "retryable" | "recovery" | "sideEffect"> {
  const lower = message.toLowerCase();
  if (isAbortError(error, lower)) {
    return {
      code: "cancelled",
      category: "cancelled",
      retryable: false,
      recovery: "abort",
      sideEffect: "unknown",
    };
  }
  if (
    (error instanceof Error && error.name === "SandboxViolation") ||
    lower.includes("sandbox denied")
  ) {
    return {
      code: "sandbox_violation",
      category: "sandbox_violation",
      retryable: false,
      recovery: "ask_user",
      sideEffect: "none",
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      code: "timeout",
      category: "timeout",
      retryable: true,
      recovery: "wait",
      sideEffect: "unknown",
    };
  }
  if (lower.includes("permission denied") || lower.includes("policy denied")) {
    return {
      code: "permission_denied",
      category: "permission_denied",
      retryable: false,
      recovery: "ask_user",
      sideEffect: "none",
    };
  }
  if (lower.includes("invalid") || lower.includes("requires ")) {
    return {
      code: "invalid_input",
      category: "invalid_input",
      retryable: true,
      recovery: "repair_input",
      sideEffect: "none",
    };
  }
  if (lower.includes("provider") || lower.includes("api") || lower.includes("network")) {
    return {
      code: "provider_failure",
      category: "provider_failure",
      retryable: true,
      recovery: "retry",
      sideEffect: "none",
    };
  }
  return {
    code: "runtime_failure",
    category: "runtime_failure",
    retryable: false,
    recovery: "abort",
    sideEffect: "unknown",
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown, lowerMessage: string): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    lowerMessage.includes("aborted") ||
    lowerMessage.includes("cancelled")
  );
}
