/**
 * Minimal Cloudflare Workers type surface used by worker.ts, so the repo
 * typechecks without @cloudflare/workers-types. Wrangler bundles the real runtime.
 */
export interface CfWebSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (ev: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: 'close' | 'error', fn: (ev: unknown) => void): void;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(req: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectState {
  id: DurableObjectId;
}
