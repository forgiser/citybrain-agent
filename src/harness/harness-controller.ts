import { normalizeHarnessError } from "./harness-error.js";
import { DefaultRecoveryPolicy, type RecoveryPolicy } from "./recovery-policy.js";
import { HarnessStateMachine } from "./harness-state-machine.js";
import type {
  HarnessError,
  HarnessEvent,
  HarnessLayer,
  HarnessRecoveryDecision,
  HarnessScope,
  HarnessState,
  HarnessStateUpdate,
} from "./harness-types.js";
import type {
  HumanInteractionBroker,
  HumanInteractionDecision,
  HumanInteractionRequestInput,
} from "./human-interaction.js";

export interface HarnessControllerOptions {
  runId: string;
  onEvent?: (event: HarnessEvent) => void;
  recoveryPolicy?: RecoveryPolicy;
  humanInteractionBroker?: HumanInteractionBroker;
}

export class HarnessController {
  private readonly machine = new HarnessStateMachine();
  private readonly recoveryPolicy: RecoveryPolicy;
  private attempt = 0;
  private turn = 0;

  constructor(private readonly options: HarnessControllerOptions) {
    this.recoveryPolicy = options.recoveryPolicy ?? new DefaultRecoveryPolicy();
  }

  get state(): HarnessState {
    return this.machine.state;
  }

  canTransition(next: HarnessState): boolean {
    return this.machine.canTransition(next);
  }

  setTurn(turn: number): void {
    this.turn = turn;
  }

  transition(next: HarnessState, reason?: string): HarnessStateUpdate {
    const update = this.machine.transition(next, {
      runId: this.options.runId,
      turn: this.turn,
      ...(reason ? { reason } : {}),
    });
    this.emit({ type: "state", ...update });
    return update;
  }

  async requestHuman(
    request: HumanInteractionRequestInput,
  ): Promise<HumanInteractionDecision> {
    if (!this.options.humanInteractionBroker) {
      return {
        requestId: "human-unavailable",
        action: "abort",
        source: "system",
        decidedAt: new Date().toISOString(),
        reason: "Human interaction broker is not configured.",
      };
    }

    if (this.canTransition("waiting_for_human")) {
      this.transition("waiting_for_human", request.message);
    }
    const decision = await this.options.humanInteractionBroker.request({
      ...request,
      runId: request.runId ?? this.options.runId,
      turn: request.turn ?? this.turn,
    });
    if (this.canTransition("resuming")) {
      this.transition("resuming", `human decision: ${decision.action}`);
    }
    return decision;
  }

  report(
    error: unknown,
    options: {
      layer: HarnessLayer;
      phase: string;
      scope: HarnessScope;
      code?: string;
      details?: Record<string, unknown>;
    },
  ): { error: HarnessError; decision: HarnessRecoveryDecision } {
    const normalized = normalizeHarnessError(error, options);
    const decision = this.recoveryPolicy.decide(normalized, this.attempt);
    this.attempt += decision.action === "retry" || decision.action === "wait" ? 1 : 0;
    if (
      ["retry", "wait", "repair_input", "requery", "ask_user", "fallback"].includes(
        decision.action,
      ) &&
      this.canTransition("recovering")
    ) {
      this.transition("recovering", decision.reason);
    }
    this.emit({
      type: "error",
      runId: this.options.runId,
      turn: this.turn,
      error: normalized,
    });
    this.emit({
      type: "recovery",
      runId: this.options.runId,
      turn: this.turn,
      error: normalized,
      decision,
    });
    return { error: normalized, decision };
  }

  resetAttempts(): void {
    this.attempt = 0;
  }

  private emit(event: HarnessEvent): void {
    this.options.onEvent?.(event);
  }
}
