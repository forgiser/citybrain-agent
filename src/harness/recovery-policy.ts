import type {
  HarnessError,
  HarnessRecovery,
  HarnessRecoveryDecision,
} from "./harness-types.js";

export interface RecoveryPolicy {
  decide(error: HarnessError, attempt: number): HarnessRecoveryDecision;
}

export class DefaultRecoveryPolicy implements RecoveryPolicy {
  decide(error: HarnessError, attempt: number): HarnessRecoveryDecision {
    if (error.recovery === "retry" && error.retryable && attempt < 2) {
      return {
        action: "retry",
        reason: "retryable error with remaining retry budget",
        delayMs: Math.min(2_000 * 2 ** attempt, 8_000),
        maxAttempts: 2,
      };
    }
    if (error.recovery === "wait" && error.retryable && attempt < 1) {
      return {
        action: "wait",
        reason: "resource or process may still be settling",
        delayMs: 1_000,
        maxAttempts: 1,
      };
    }
    if (error.recovery === "repair_input") {
      return {
        action: "repair_input",
        reason: "return structured input feedback to the model",
      };
    }
    if (error.recovery === "ask_user") {
      return {
        action: "ask_user",
        reason: "user authorization or intervention is required",
      };
    }
    if (error.recovery === "finalize") {
      return {
        action: "finalize",
        reason: "continue to a safe final answer boundary",
      };
    }
    return {
      action: error.recovery,
      reason: `recovery policy selected ${error.recovery}`,
    };
  }
}
