import { parseRetryAfter } from './pacer';
import { browserProtocol, PROTOCOL_VERSION as WIRE_PROTOCOL_VERSION, UPGRADE_REQUIRED, type Command, type RoomStatus, type SignedCommand } from './protocol';
import { identity, sign } from './storage';

export type ApiError = Error & { status?: number; code?: string; retryAfterMs?: number };

export const PROTOCOL_HEADER = 'X-Meshrooms-Protocol';
export const PROTOCOL_VERSION = String(WIRE_PROTOCOL_VERSION);
export { UPGRADE_REQUIRED };
/** Maximum pending commands retained for idempotent retry across transient failures. */
export const MAX_PENDING_COMMANDS = 128;
/** Stale pending retry entries older than this (well past the lobby receipt window) are pruned. */
export const PENDING_COMMAND_TTL_MS = 5 * 60_000;

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abort = (src: AbortSignal) => { if (!controller.signal.aborted) controller.abort(src.reason); };
  if (signal.aborted) { abort(signal); return controller.signal; }
  signal.addEventListener('abort', () => abort(signal), { once: true });
  timeout.addEventListener('abort', () => abort(timeout), { once: true });
  return controller.signal;
}

export class BrowserApi {
  private pending = new Map<string, SignedCommand>();
  constructor(
    private maxPending = MAX_PENDING_COMMANDS,
    private pendingTtlMs = PENDING_COMMAND_TTL_MS,
    private now: () => number = () => Date.now(),
  ) {}
  private prunePending(at: number) {
    for (const [key, envelope] of this.pending) {
      if (at - envelope.command.at > this.pendingTtlMs) this.pending.delete(key);
    }
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
  async command(action: Command['action'], roomId: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<RoomStatus> {
    const key = JSON.stringify([action, roomId, payload]);
    const i = await identity();
    const at = this.now();
    this.prunePending(at);
    const previous = action === 'status' ? undefined : this.pending.get(key);
    const command: Command = { protocol: browserProtocol, origin: location.origin, id: previous?.command.id || crypto.randomUUID(), at, action, roomId, payload };
    const envelope: SignedCommand = { command, publicKey: i.publicKey, signature: await sign(command) };
    if (action !== 'status') {
      this.pending.delete(key);
      this.pending.set(key, envelope);
      this.prunePending(at);
    }
    let response: Response;
    try {
      response = await fetch('/api/lobby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [PROTOCOL_HEADER]: PROTOCOL_VERSION },
        body: JSON.stringify(envelope),
        signal: combineSignals(10_000, signal),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Cannot reach the room service. Your action can be retried.');
    }
    // A proxy (Nginx rate limit, gateway error) can answer with HTML instead of JSON; keep the status so callers still back off.
    let result: (RoomStatus & { error?: string; code?: string }) | undefined;
    try { result = await response.json(); } catch { /* handled below */ }
    if (response.ok || response.status < 500) this.pending.delete(key);
    // `status` and `code` let the room react: 410 with ROOM_CLOSED means the room is gone, 426 asks to reload/upgrade, invite codes ask for a code.
    if (!response.ok) {
      const fallback = response.status === 429
        ? 'Too many requests. Try again shortly.'
        : response.status === 426
          ? 'This Meshrooms client is out of date. Reload to upgrade.'
          : 'The room service rejected this action.';
      const code = typeof result?.code === 'string' ? result.code : response.status === 426 ? UPGRADE_REQUIRED : undefined;
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw Object.assign(new Error(result?.error || fallback), { status: response.status, code, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
    }
    if (!result || typeof result !== 'object') throw new Error('The room service returned an unexpected response.');
    return result;
  }
}
