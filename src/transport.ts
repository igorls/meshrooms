import type { Attachment, RoomTransport } from './room';
import type { SetupCommand, SetupStatus } from './setup';

export const sessionRequiredEvent = 'meshrooms:session-required';
export class SessionRequiredError extends Error {
  constructor() { super('Open Meshrooms through your agent.'); }
}
function requireSession() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(sessionRequiredEvent));
  return new SessionRequiredError();
}

type CommandResult = { roomId?: string; messageId?: string; status?: string; taskId?: string; revision?: number };
function createCommandPoster(prefix: string, demo = false) {
  const uncertainCommands = new Map<string, string>();
  const retryNote = demo ? 'Check the room before trying again.' : 'Try the same action again to safely retry.';

  return async function post(path: string, body: Record<string, unknown>): Promise<CommandResult> {
    // An unchanged manual retry is the same command until its outcome is known.
    const key = `${path}:${JSON.stringify(body)}`;
    const requestId = uncertainCommands.get(key) || crypto.randomUUID();
    uncertainCommands.set(key, requestId);
    let response: Response;
    try {
      response = await fetch(`${prefix}/${path}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, requestId }), signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(`Could not confirm the result. ${retryNote}`);
    }
    const definitiveRejection = response.status >= 400 && response.status < 500;
    if (definitiveRejection) uncertainCommands.delete(key);
    if (!demo && response.status === 401) throw requireSession();
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      if (definitiveRejection) throw new Error(result?.message || 'The local node rejected this action. Check the details and try again.');
      throw new Error(`${result?.message || 'Could not confirm the result.'} ${retryNote}`);
    }
    const confirmed = path === 'setup'
      ? !!result && typeof result === 'object' && !Array.isArray(result) && (body.intentId !== undefined ? typeof result.roomId === 'string' && result.roomId.length > 0 : result.roomId === undefined || typeof result.roomId === 'string' && result.roomId.length > 0)
      : path === 'messages'
      ? demo ? result?.status === 'in-local-memory' : result?.status === 'stored-locally' && typeof result?.messageId === 'string'
      : path.startsWith('tasks')
      ? typeof result?.taskId === 'string' && Number.isInteger(result?.revision)
      : typeof result?.roomId === 'string' && result.roomId.length > 0;
    if (!confirmed) throw new Error(`Could not confirm the result. ${retryNote}`);
    uncertainCommands.delete(key);
    return result;
  };
}

export function createSetupTransport() {
  const post = createCommandPoster('/api/node');
  return {
    async exchange(ticket: string): Promise<void> {
      const response = await fetch('/api/node/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(15000) });
      // A reused ticket must not invalidate an already-authorized browser cookie.
      if (response.status === 401) throw new SessionRequiredError();
      if (!response.ok) throw new Error('Could not open the local session. Retry or reopen Meshrooms through your agent.');
    },
    async status(intentId?: string): Promise<SetupStatus> {
      const query = intentId ? `?intent=${encodeURIComponent(intentId)}` : '';
      const response = await fetch(`/api/node/setup${query}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (response.status === 401) throw new SessionRequiredError();
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || 'Could not load local setup. Retry when the daemon is available.');
      if (!result || typeof result.completed !== 'boolean' || typeof result.humanName !== 'string' || typeof result.machineName !== 'string'
        || typeof result.dataDir !== 'string' || !result.startup || !['manual', 'login'].includes(result.startup.preference)
        || typeof result.startup.installed !== 'boolean' || typeof result.startup.supported !== 'boolean'
        || result.pending && (typeof result.pending.id !== 'string' || typeof result.pending.title !== 'string' || typeof result.pending.project !== 'string'
          || typeof result.pending.agentName !== 'string' || !['pending', 'completed'].includes(result.pending.status)
          || result.pending.status === 'completed' && (typeof result.pending.roomId !== 'string' || !result.pending.roomId))) {
        throw new Error('Could not read local setup. Retry when the daemon is available.');
      }
      return result;
    },
    async save(command: Omit<SetupCommand, 'requestId'>): Promise<{ roomId?: string }> {
      return post('setup', { humanName: command.humanName, machineName: command.machineName, startAtLogin: command.startAtLogin, intentId: command.intentId });
    },
  };
}

export function createRoomTransport(demo = false): RoomTransport {
  const prefix = demo ? '/api/demo' : '/api/node';
  const post = createCommandPoster(prefix, demo);
  // A view ID identifies the SSE subscriber, never a person or room membership.
  const viewId = crypto.randomUUID();

  return {
    connect(onSnapshot, onConnection) {
      onConnection('connecting');
      const source = new EventSource(`${prefix}/events?view=${viewId}`);
      let closed = false;
      let checkingSession = false;
      source.onopen = () => onConnection('local');
      source.onmessage = event => onSnapshot(JSON.parse(event.data));
      source.onerror = () => {
        onConnection('disconnected');
        if (!demo && !checkingSession) {
          checkingSession = true;
          void fetch('/api/node/setup', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) }).then(response => { if (!closed && response.status === 401) requireSession(); }).catch(() => {}).finally(() => { checkingSession = false; });
        }
      };
      return () => { closed = true; source.close(); };
    },
    async send(roomId, draft) { await post('messages', { roomId, text: draft.text, replyTo: draft.replyTo, share: draft.share ? { title: draft.share.title, text: draft.share.text } : undefined, attachments: draft.attachments?.length ? draft.attachments : undefined }); },
    async upload(roomId, file, name, requestId): Promise<Attachment> {
      if (demo) throw new Error('The demo node does not store attachments.');
      const query = new URLSearchParams({ roomId, requestId, name });
      let response: Response;
      try {
        response = await fetch(`${prefix}/attachments?${query}`, { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file, signal: AbortSignal.timeout(60000) });
      } catch { throw new Error('Could not confirm the upload. Retry to upload it safely.'); }
      if (response.status === 401) throw requireSession();
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || 'The local node rejected this file.');
      if (typeof result?.id !== 'string' || typeof result?.name !== 'string' || !['image', 'file'].includes(result?.kind)) throw new Error('Could not confirm the upload. Retry to upload it safely.');
      return result;
    },
    async createRoom(input) { return (await post('rooms', { title: input.title, project: input.project })).roomId!; },
    async joinRoom(roomId) { return (await post('rooms/join', { roomId })).roomId!; },
    async setFloor(roomId, floor) { await post('rooms/floor', { roomId, floor }); },
    async setAgentWake(roomId, agentId, wake) { await post('rooms/agent-wake', { roomId, agentId, wake }); },
    async createTask(roomId, task) { await post('tasks', { roomId, title: task.title, notes: task.notes, assigneeId: task.assigneeId }); },
    async updateTask(roomId, taskId, revision, changes) { await post('tasks/update', { roomId, taskId, revision, ...changes }); },
    async removeTask(roomId, taskId, revision) { await post('tasks/remove', { roomId, taskId, revision }); },
  };
}
