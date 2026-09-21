import { randomUUID } from "node:crypto";
import type { HarnessLayer, HarnessScope } from "./harness-types.js";

export type HumanInteractionKind =
  | "permission"
  | "sandbox_access"
  | "destructive_confirmation"
  | "recovery_choice"
  | "clarification"
  | "provider_fallback";

export type HumanInteractionRisk = "low" | "medium" | "high";

export type HumanDecisionAction =
  | "approve"
  | "reject"
  | "select"
  | "retry"
  | "edit"
  | "abort";

export type HumanDecisionSource = "cli" | "web" | "api" | "timeout" | "system";

export interface HumanInteractionOption {
  id: string;
  label: string;
  description?: string;
  dangerous?: boolean;
}

export interface HumanInteractionRequestInput {
  runId?: string;
  turn?: number;
  layer: HarnessLayer;
  phase: string;
  scope: HarnessScope;
  kind: HumanInteractionKind;
  title: string;
  message: string;
  options: readonly HumanInteractionOption[];
  defaultOption?: string;
  risk?: HumanInteractionRisk;
  timeoutMs?: number;
  context?: Record<string, unknown>;
}

export interface HumanInteractionRequest extends HumanInteractionRequestInput {
  requestId: string;
  createdAt: string;
  expiresAt?: string;
}

export interface HumanInteractionDecision {
  requestId: string;
  action: HumanDecisionAction;
  optionId?: string;
  editedInput?: unknown;
  source: HumanDecisionSource;
  decidedAt: string;
  reason?: string;
}

export type HumanInteractionEvent =
  | {
      type: "created";
      request: HumanInteractionRequest;
    }
  | {
      type: "resolved";
      request: HumanInteractionRequest;
      decision: HumanInteractionDecision;
    }
  | {
      type: "expired";
      request: HumanInteractionRequest;
      decision: HumanInteractionDecision;
    }
  | {
      type: "cancelled";
      request: HumanInteractionRequest;
      decision: HumanInteractionDecision;
    };

export interface HumanInteractionBrokerOptions {
  defaultTimeoutMs?: number;
  onEvent?: (event: HumanInteractionEvent) => void;
}

interface PendingInteraction {
  request: HumanInteractionRequest;
  resolve: (decision: HumanInteractionDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Transport-neutral Human-in-the-Loop broker.
 *
 * Producers create a request and await a decision. UI adapters subscribe to
 * events and call resolve/cancel; they do not own the pending promise.
 */
export class HumanInteractionBroker {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly listeners = new Set<(event: HumanInteractionEvent) => void>();

  constructor(private readonly options: HumanInteractionBrokerOptions = {}) {
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  request(input: HumanInteractionRequestInput): Promise<HumanInteractionDecision> {
    const requestId = `human-${randomUUID()}`;
    const createdAt = new Date();
    const timeoutMs = normalizeTimeout(
      input.timeoutMs ?? this.options.defaultTimeoutMs,
    );
    const request: HumanInteractionRequest = {
      ...input,
      requestId,
      createdAt: createdAt.toISOString(),
      ...(timeoutMs
        ? { expiresAt: new Date(createdAt.getTime() + timeoutMs).toISOString() }
        : {}),
      options: input.options.map((option) => ({ ...option })),
    };

    return new Promise<HumanInteractionDecision>((resolve) => {
      const pending: PendingInteraction = { request, resolve };
      if (timeoutMs) {
        pending.timer = setTimeout(() => {
          const current = this.pending.get(requestId);
          if (!current) return;
          const decision = this.createDecision(
            request,
            "abort",
            "timeout",
            undefined,
            "human interaction timed out",
          );
          this.pending.delete(requestId);
          this.emit({ type: "expired", request, decision });
          current.resolve(decision);
        }, timeoutMs);
      }
      this.pending.set(requestId, pending);
      this.emit({ type: "created", request });
    });
  }

  resolve(
    requestId: string,
    input: Omit<HumanInteractionDecision, "requestId" | "decidedAt">,
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if (!this.isValidDecision(pending.request, input)) return false;

    const decision: HumanInteractionDecision = {
      ...input,
      requestId,
      decidedAt: new Date().toISOString(),
    };
    this.finishPending(pending);
    this.emit({ type: "resolved", request: pending.request, decision });
    pending.resolve(decision);
    return true;
  }

  cancel(requestId: string, reason = "human interaction cancelled"): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    const decision = this.createDecision(
      pending.request,
      "abort",
      "system",
      undefined,
      reason,
    );
    this.finishPending(pending);
    this.emit({ type: "cancelled", request: pending.request, decision });
    pending.resolve(decision);
    return true;
  }

  cancelAll(reason = "human interaction cancelled"): number {
    const requestIds = [...this.pending.keys()];
    let cancelled = 0;
    for (const requestId of requestIds) {
      if (this.cancel(requestId, reason)) cancelled += 1;
    }
    return cancelled;
  }

  getPending(runId?: string): HumanInteractionRequest[] {
    return [...this.pending.values()]
      .map((item) => item.request)
      .filter((request) => !runId || request.runId === runId);
  }

  subscribe(listener: (event: HumanInteractionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private createDecision(
    request: HumanInteractionRequest,
    action: HumanDecisionAction,
    source: HumanDecisionSource,
    optionId?: string,
    reason?: string,
  ): HumanInteractionDecision {
    return {
      requestId: request.requestId,
      action,
      source,
      decidedAt: new Date().toISOString(),
      ...(optionId ? { optionId } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  private isValidDecision(
    request: HumanInteractionRequest,
    input: Omit<HumanInteractionDecision, "requestId" | "decidedAt">,
  ): boolean {
    if (input.action === "abort" || input.action === "approve" || input.action === "reject") {
      return true;
    }
    return Boolean(
      input.optionId && request.options.some((option) => option.id === input.optionId),
    );
  }

  private finishPending(pending: PendingInteraction): void {
    this.pending.delete(pending.request.requestId);
    if (pending.timer) clearTimeout(pending.timer);
  }

  private emit(event: HumanInteractionEvent): void {
    this.options.onEvent?.(event);
    for (const listener of this.listeners) listener(event);
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.min(Math.floor(timeoutMs), 30 * 60 * 1_000);
}
