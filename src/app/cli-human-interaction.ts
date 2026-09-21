import type {
  HumanDecisionAction,
  HumanInteractionBroker,
  HumanInteractionEvent,
  HumanInteractionOption,
  HumanInteractionRequest,
} from "../harness/human-interaction.js";
import { matchesKey } from "@earendil-works/pi-tui";

export interface CliHumanInteractionHost {
  show(request: HumanInteractionRequest): void;
  select(request: HumanInteractionRequest, index: number): void;
  remove(request: HumanInteractionRequest): void;
  requestRender(): void;
}

/**
 * CLI adapter for the transport-neutral HumanInteractionBroker.
 *
 * It intentionally supports only bounded choices for now. Free-form edited
 * input can be added later without changing the broker or permission layer.
 */
export class CliHumanInteractionAdapter {
  private readonly unsubscribe: () => void;
  private readonly selectedIndexes = new Map<string, number>();

  constructor(
    private readonly broker: HumanInteractionBroker,
    private readonly host: CliHumanInteractionHost,
  ) {
    this.unsubscribe = broker.subscribe((event) => this.handleEvent(event));
  }

  dispose(): void {
    this.unsubscribe();
  }

  handleInput(data: string): boolean {
    const request = this.broker.getPending()[0];
    if (!request) return false;

    const selectedIndex = this.selectedIndexes.get(request.requestId) ?? 0;
    if (matchesKey(data, "up")) {
      const nextIndex = selectedIndex > 0
        ? selectedIndex - 1
        : request.options.length - 1;
      this.selectedIndexes.set(request.requestId, nextIndex);
      this.host.select(request, nextIndex);
      this.host.requestRender();
      return true;
    }
    if (matchesKey(data, "down")) {
      const nextIndex = selectedIndex < request.options.length - 1
        ? selectedIndex + 1
        : 0;
      this.selectedIndexes.set(request.requestId, nextIndex);
      this.host.select(request, nextIndex);
      this.host.requestRender();
      return true;
    }
    if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
      const option = request.options[selectedIndex];
      if (option) return this.resolve(request, actionForOption(option), option.id);
      return true;
    }

    const input = data.trim().toLowerCase();
    if (!input) return true;

    if (matchesKey(data, "escape") || input === "\u001b" || input === "escape") {
      return this.resolve(request, "abort", undefined, "cli cancelled the request");
    }
    if (input === "y" || input === "yes") {
      return this.resolve(request, "approve", "approve");
    }
    if (input === "n" || input === "no") {
      return this.resolve(request, "reject", "reject");
    }

    const index = Number.parseInt(input, 10);
    if (Number.isInteger(index) && index >= 1 && index <= request.options.length) {
      const option = request.options[index - 1];
      if (option) {
        return this.resolve(request, actionForOption(option), option.id);
      }
    }

    return true;
  }

  private resolve(
    request: HumanInteractionRequest,
    action: HumanDecisionAction,
    optionId?: string,
    reason?: string,
  ): boolean {
    const resolved = this.broker.resolve(request.requestId, {
      action,
      optionId,
      source: "cli",
      ...(reason ? { reason } : {}),
    });
    if (resolved) this.host.requestRender();
    return true;
  }

  private handleEvent(event: HumanInteractionEvent): void {
    if (event.type === "created") {
      this.selectedIndexes.set(
        event.request.requestId,
        getInitialSelection(event.request),
      );
      this.host.show(event.request);
      this.host.requestRender();
      return;
    }
    this.selectedIndexes.delete(event.request.requestId);
    this.host.remove(event.request);
    this.host.requestRender();
  }
}

function getInitialSelection(request: HumanInteractionRequest): number {
  const defaultIndex = request.options.findIndex(
    (option) => option.id === request.defaultOption,
  );
  return defaultIndex >= 0 ? defaultIndex : 0;
}

function actionForOption(option: HumanInteractionOption): HumanDecisionAction {
  if (option.id === "approve") return "approve";
  if (option.id === "reject") return "reject";
  if (option.id === "retry") return "retry";
  if (option.id === "abort") return "abort";
  return "select";
}
