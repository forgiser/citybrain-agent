import type {
  HarnessState,
  HarnessStateUpdate,
} from "./harness-types.js";

const transitions: Record<HarnessState, readonly HarnessState[]> = {
  idle: ["planning", "executing", "aborted"],
  planning: ["executing", "recovering", "waiting_for_human", "finalizing", "failed", "aborted"],
  executing: ["recovering", "waiting_for_human", "finalizing", "completed", "failed", "aborted"],
  recovering: ["planning", "executing", "waiting_for_human", "finalizing", "failed", "aborted"],
  waiting_for_human: ["resuming", "failed", "aborted"],
  resuming: ["planning", "executing", "recovering", "finalizing", "failed", "aborted"],
  finalizing: ["completed", "failed", "aborted"],
  completed: ["planning", "idle"],
  failed: ["planning", "idle"],
  aborted: ["planning", "idle"],
};

export class HarnessStateMachine {
  private current: HarnessState = "idle";

  get state(): HarnessState {
    return this.current;
  }

  canTransition(next: HarnessState): boolean {
    return this.current === next || transitions[this.current].includes(next);
  }

  transition(
    next: HarnessState,
    update: Omit<HarnessStateUpdate, "state" | "previousState">,
  ): HarnessStateUpdate {
    if (!this.canTransition(next)) {
      throw new Error(
        `Invalid Harness state transition: ${this.current} -> ${next}`,
      );
    }
    const result: HarnessStateUpdate = {
      ...update,
      state: next,
      previousState: this.current,
    };
    this.current = next;
    return result;
  }

  reset(): void {
    this.current = "idle";
  }
}
