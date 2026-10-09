import { randomUUID } from "node:crypto";

export type MapCommandName =
  | "set_view"
  | "fit_layer"
  | "add_layer"
  | "remove_layer"
  | "set_layer_visibility";

export interface MapCommandEnvelope {
  id: string;
  sessionId: string;
  clientId: string;
  command: MapCommandName;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface MapCommandResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface MapClient {
  clientId: string;
  connectedAt: number;
  send(command: MapCommandEnvelope): void;
}

interface PendingCommand {
  sessionId: string;
  clientId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

export interface MapCommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Routes Agent map tools to the most recently connected map client. */
export class MapCommandBridge {
  private readonly clients = new Map<string, Map<string, MapClient>>();
  private readonly pending = new Map<string, PendingCommand>();
  private disposed = false;

  registerClient(
    sessionId: string,
    clientId: string,
    send: MapClient["send"],
  ): () => void {
    this.assertActive();
    const clients = this.clients.get(sessionId) ?? new Map<string, MapClient>();
    const client = { clientId, connectedAt: Date.now(), send };
    clients.set(clientId, client);
    this.clients.set(sessionId, clients);
    return () => {
      const current = this.clients.get(sessionId);
      if (current?.get(clientId) !== client) return;
      current.delete(clientId);
      if (current?.size === 0) this.clients.delete(sessionId);
      this.rejectClientCommands(sessionId, clientId, "Map client disconnected.");
    };
  }

  hasActiveClient(sessionId: string): boolean {
    return (this.clients.get(sessionId)?.size ?? 0) > 0;
  }

  removeSession(sessionId: string, reason = "Session removed."): void {
    this.clients.delete(sessionId);
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.finishPending(id);
      pending.reject(new Error(reason));
    }
  }

  async execute(
    sessionId: string,
    command: MapCommandName,
    payload: Record<string, unknown>,
    options: MapCommandOptions = {},
  ): Promise<unknown> {
    this.assertActive();
    const client = this.getActiveClient(sessionId);
    if (!client) throw new Error("No active Web map client is connected for this session.");
    if (options.signal?.aborted) throw abortError();

    const id = `map-command-${randomUUID()}`;
    const envelope: MapCommandEnvelope = {
      id,
      sessionId,
      clientId: client.clientId,
      command,
      payload,
      createdAt: new Date().toISOString(),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.finishPending(id);
        reject(new Error(`Map command timed out after ${options.timeoutMs ?? 15_000} ms.`));
      }, options.timeoutMs ?? 15_000);
      const pending: PendingCommand = {
        sessionId,
        clientId: client.clientId,
        resolve,
        reject,
        timeout,
      };
      if (options.signal) {
        const onAbort = (): void => {
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(abortError());
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, pending);
      try {
        client.send(envelope);
      } catch (error) {
        this.finishPending(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  resolveResult(
    sessionId: string,
    clientId: string,
    result: MapCommandResult,
  ): boolean {
    const pending = this.pending.get(result.id);
    if (!pending || pending.sessionId !== sessionId || pending.clientId !== clientId) {
      return false;
    }
    this.finishPending(result.id);
    if (result.ok) pending.resolve(result.result);
    else pending.reject(new Error(result.error?.trim() || "Map command failed."));
    return true;
  }

  dispose(reason = "Map command bridge disposed."): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, pending] of this.pending) {
      this.finishPending(id);
      pending.reject(new Error(reason));
    }
    this.clients.clear();
  }

  private getActiveClient(sessionId: string): MapClient | undefined {
    return [...(this.clients.get(sessionId)?.values() ?? [])]
      .sort((left, right) => right.connectedAt - left.connectedAt)[0];
  }

  private finishPending(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    this.pending.delete(id);
  }

  private rejectClientCommands(sessionId: string, clientId: string, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId || pending.clientId !== clientId) continue;
      this.finishPending(id);
      pending.reject(new Error(reason));
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Map command bridge is disposed.");
  }
}

function abortError(): Error {
  const error = new Error("Map command aborted.");
  error.name = "AbortError";
  return error;
}
