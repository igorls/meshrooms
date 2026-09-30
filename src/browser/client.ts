import { browserProtocol, type Command, type RoomStatus, type SignedCommand } from './protocol';
import { identity, sign } from './storage';

export type ApiError = Error & { status?: number; code?: string };
export class BrowserApi {
  private pending = new Map<string, SignedCommand>();
  async command(action: Command['action'], roomId: string, payload: Record<string, unknown> = {}): Promise<RoomStatus> {
    const key = JSON.stringify([action, roomId, payload]);
    const i = await identity();
    const previous = action === 'status' ? undefined : this.pending.get(key);
    const command: Command = { protocol: browserProtocol, origin: location.origin, id: previous?.command.id || crypto.randomUUID(), at: Date.now(), action, roomId, payload };
    const envelope: SignedCommand = { command, publicKey: i.publicKey, signature: await sign(command) };
    if (action !== 'status') this.pending.set(key, envelope);
    let response: Response;
    try {
      response = await fetch('/api/lobby', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(10_000) });
    } catch { throw new Error('Cannot reach the room service. Your action can be retried.'); }
    const result = await response.json();
    if (response.ok || response.status < 500) this.pending.delete(key);
    // `status` and `code` let the room react: 410 with ROOM_CLOSED means the room is gone, invite codes ask for a code.
    if (!response.ok) throw Object.assign(new Error(result.error || 'The room service rejected this action.'), { status: response.status, code: result.code as string | undefined });
    return result;
  }
}
