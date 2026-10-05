/**
 * The page the desktop app serves on 127.0.0.1: a thin client of the machine's person device (server/person.ts), which
 * the daemon runs. Everything goes through the local API (server/local-api.ts) with the session token this page got
 * for its one-time ticket, kept in sessionStorage (this origin's, port included) and sent as a bearer token. No cookie,
 * no key here: the person device signs, connects, stores and keeps presence, with or without this page.
 *
 * What changes reaches the page through the API's events long poll; the open room is then read again (its view).
 */
import { foldBoard, type TaskBody } from './board';
import type { DecisionBody, VoteBody } from './decisions';
import type { ActivityRecord } from './activity';
import type { FileView, SavedMessage } from './peers';
import type { ReactionChip } from './reactions';
import type { RecentRoom } from './background';
import type { UnreadCount, Waiting } from './unread';
import type { BrowserDevice, RoomStatus } from './protocol';
import type { HarnessScan, LocalAgent, LocalAgents, RoomAction, RoomEvents, RoomSession, RoomSource, SessionListing } from './source';

const TOKEN_KEY = 'meshrooms:local-session';
const SIGN_IN = 'Open Meshrooms from the app (Open Meshrooms in its menu) to sign in on this browser.';
/** The page's routes on the local origin; another path is never navigated to. */
type RoomSummary = { roomId: string; origin: string; title: string | null; state: string; unread: number; mentions: number; waiting?: Waiting[] };
type PersonStatus = Omit<RoomStatus, 'devices' | 'signals' | 'iceServers'> & { devices?: (BrowserDevice & { online: boolean })[]; connected: string[]; activity: Record<string, ActivityRecord> };
type View = {
  roomId: string; origin: string; title: string | null; state: 'joined' | 'waiting' | 'declined' | 'expired' | 'closed' | 'removed' | 'starting'; code?: string; reason?: string;
  memberId: string | null; status: PersonStatus | null; messages: SavedMessage[]; more: boolean; taskOps: TaskBody[]; decisionOps: (DecisionBody | VoteBody)[];
  reactions: ReactionChip[]; files: Record<string, { held: boolean; transfer?: FileView['transfer'] }>; read: { id?: string; at: number };
};
type LocalEvent = { type: 'message' | 'members' | 'room'; roomId: string } | { type: 'rooms'; roomIds: string[] };
export type ApiFailure = Error & { status?: number };

function storedToken() { try { return sessionStorage.getItem(TOKEN_KEY) ?? undefined; } catch { return undefined; } }

export class LocalSource implements RoomSource {
  readonly isLocal = true;
  readonly label = 'Meshrooms on this computer';
  /** The agent routes of the local API (server/local-agents.ts), with this page's session token. */
  readonly agents: LocalAgents = {
    list: () => this.call<{ agents: LocalAgent[]; approvalsWaiting: number }>('/api/local/agents'),
    harnesses: async () => (await this.call<{ harnesses: HarnessScan[] }>('/api/local/harnesses', { timeout: 30_000 })).harnesses,
    sessions: harness => this.call<SessionListing>(`/api/local/harnesses/${harness}/sessions`, { timeout: 30_000 }),
    create: async input => (await this.call<{ agent: LocalAgent }>('/api/local/agents', { method: 'POST', json: input })).agent,
    remove: async id => { await this.call(`/api/local/agents/${id}`, { method: 'DELETE' }); },
    // The person device makes the agent link and the daemon redeems it: a round trip or two to the room service.
    putIntoRoom: (roomId, identity) => this.call(`/api/local/rooms/${roomId}/agents`, { method: 'POST', json: { identity }, timeout: 60_000 }),
    bind: async (roomId, member, session) => {
      try { return await this.call<{ state: 'bound' | 'starting' }>(`/api/local/rooms/${roomId}/agents/${member}/bind`, { method: 'POST', json: { session }, timeout: 60_000 }); }
      catch (error) { if ((error as { approval?: string }).approval === 'pending') return { approval: 'pending' as const }; throw error; }
    },
    unbind: (roomId, member) => this.call(`/api/local/rooms/${roomId}/agents/${member}/unbind`, { method: 'POST', json: {}, timeout: 60_000 }),
  };
  private token = storedToken();
  private signIn?: Promise<void>;
  private rooms: RoomSummary[] = [];
  private listeners = new Set<(events: LocalEvent[], reset: boolean) => void>();
  private polling = false;
  private avatars = new Map<string, string | Promise<void>>();
  /** `ticket`: the one-time ticket from the link the app opened (#access=…), exchanged once for a session token. */
  constructor(ticket?: string | null) {
    if (ticket) this.signIn = this.exchange(ticket);
  }
  private async exchange(ticket: string) {
    const response = await fetch('/api/local/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json().catch(() => ({})) as { token?: string; error?: string };
    // A link already used (a reload of it) is fine while this tab still holds its session.
    if (!response.ok || typeof result.token !== 'string') { if (this.token) return; throw new Error(result.error || SIGN_IN); }
    this.token = result.token;
    try { sessionStorage.setItem(TOKEN_KEY, result.token); } catch { /* Kept in memory: a reload signs in again from the app. */ }
  }
  /** One request to the local API, with the session token; JSON in and out unless `raw`. */
  private async call<T>(path: string, init: RequestInit & { json?: unknown; timeout?: number } = {}): Promise<T> {
    await this.signIn;
    if (!this.token) throw Object.assign(new Error(SIGN_IN), { status: 401 });
    const { json, timeout = 15_000, ...rest } = init;
    let response: Response;
    try {
      response = await fetch(path, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeout), headers: { Authorization: `Bearer ${this.token}`, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers as Record<string, string> },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError' && rest.signal?.aborted) throw error;
      throw new Error('Meshrooms on this computer does not answer. Check that the app is running.');
    }
    if (response.status === 401) { this.token = undefined; try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* Not kept. */ } }
    const result = await response.json().catch(() => ({})) as T & { error?: string; code?: unknown; approval?: unknown };
    // `code`: a room service's reason (an invite code it wants), passed on by the local API. `approval`: the request
    // was filed for the person to approve in the app (binding an existing session), which the page shows as waiting.
    if (!response.ok) throw Object.assign(new Error(response.status === 401 ? SIGN_IN : result.error || 'Meshrooms on this computer could not do that.'),
      { status: response.status, ...(typeof result.code === 'string' ? { code: result.code } : {}), ...(result.approval === 'pending' ? { approval: 'pending' } : {}) });
    return result;
  }
  private async blob(path: string) {
    await this.signIn;
    const response = await fetch(path, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Not available.');
    return response.blob();
  }

  /** The events long poll, shared by everything on the page while anything listens. */
  private subscribe(listener: (events: LocalEvent[], reset: boolean) => void) {
    this.listeners.add(listener);
    if (!this.polling) void this.poll();
    return () => { this.listeners.delete(listener); };
  }
  private async poll() {
    this.polling = true;
    let cursor = '';
    try {
      while (this.listeners.size) {
        try {
          const answer = await this.call<{ cursor: string; events: LocalEvent[]; reset?: boolean }>(`/api/local/events?after=${encodeURIComponent(cursor)}&wait=${cursor ? 25 : 0}`, { timeout: 40_000 });
          const first = !cursor;
          cursor = answer.cursor;
          // The first answer only sets the cursor: whatever changed before it is read again from here, so nothing falls
          // between a page's first read and its first event.
          if (answer.events.length || answer.reset || first) for (const listener of [...this.listeners]) listener(answer.events, !!answer.reset || first);
          if (first) continue;
        } catch (error) {
          if ((error as ApiFailure).status === 401) return;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    } finally { this.polling = false; }
  }
  private recent(): RecentRoom[] { return this.rooms.map(r => ({ id: r.roomId, title: r.title ?? 'Room' })); }
  private async loadRooms() {
    this.rooms = (await this.call<{ rooms: RoomSummary[] }>('/api/local/rooms')).rooms;
    return this.recent();
  }

  async start() {
    const name = await this.readPref<string>('display-name') || '';
    return { deviceId: 'local', recent: await this.loadRooms(), name };
  }
  /** Whether the room service new rooms are made on asks for an invite code (the person device asks it). */
  async health() {
    const service = await this.call<{ origin: string; inviteRequired?: boolean }>('/api/local/service');
    return { roomService: service.origin, ...(service.inviteRequired === true ? { inviteRequired: true } : {}) };
  }
  async room(roomId: string) {
    const view = await this.call<View>(`/api/local/rooms/${roomId}/view?limit=1`);
    return view.state === 'closed' ? { closed: view.reason || 'The host closed this room.' } : { title: view.title ?? 'Room' };
  }
  async command(action: RoomAction, roomId: string, payload: Record<string, unknown> = {}) {
    // A new room is the person device's: it creates it on its room service, and hosts it from then on.
    if (action === 'create') {
      const { name, title, invite } = payload as { name?: string; title?: string; invite?: string };
      const made = await this.call<Record<string, unknown>>('/api/local/rooms', { method: 'POST', json: { roomId, name, title, ...(invite ? { invite } : {}) }, timeout: 30_000 });
      await this.loadRooms().catch(() => {});
      return made;
    }
    if (action === 'status') throw new Error('The person device on this computer polls its rooms itself.');
    return this.call<Record<string, unknown>>(`/api/local/rooms/${roomId}/command`, { method: 'POST', json: { action, payload } });
  }
  async forget(roomId: string) { await this.loadRooms().catch(() => {}); return this.recent().filter(r => r.id !== roomId); }
  counts() {
    return Object.fromEntries(this.rooms.map(r => [r.roomId, { unread: r.unread, mentions: r.mentions, ...(r.waiting?.length ? { waiting: r.waiting } : {}) } satisfies UnreadCount]));
  }
  watch(_deviceId: string, _openRoom: string, on: { counts(counts: Record<string, UnreadCount>): void; recent(rooms: RecentRoom[]): void }) {
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.loadRooms().then(rooms => { if (!stopped) { on.recent(rooms); on.counts(this.counts()); } }).catch(() => {}), 300);
    };
    on.counts(this.counts());
    // Any room's change can change its badge: the list is read again, at most every 300 ms.
    const stop = this.subscribe(() => refresh());
    return () => { stopped = true; clearTimeout(timer); stop(); };
  }
  /** The daemon holds the rooms: nothing to hand over. */
  leave() {}
  roomOrigin(roomId: string) { return this.rooms.find(r => r.roomId === roomId)?.origin ?? location.origin; }
  avatar(roomId: string, memberId: string, hash: string, loaded: () => void) {
    const key = `${roomId}:${memberId}:${hash}`, known = this.avatars.get(key);
    if (typeof known === 'string') return known;
    if (!known) this.avatars.set(key, this.blob(`/api/local/rooms/${roomId}/avatars/${memberId}?h=${hash}`)
      .then(blob => { this.avatars.set(key, URL.createObjectURL(blob)); loaded(); }, () => { /* Shown as the initial; tried again on the next load. */ }));
    return undefined;
  }
  async readPref<T>(key: string) { try { const value = localStorage.getItem(`meshrooms:pref:${key}`); return value === null ? undefined : JSON.parse(value) as T; } catch { return undefined; } }
  async writePref(key: string, value: unknown) {
    try { if (value === null || value === undefined) localStorage.removeItem(`meshrooms:pref:${key}`); else localStorage.setItem(`meshrooms:pref:${key}`, JSON.stringify(value)); } catch { /* A convenience only. */ }
  }

  open(roomId: string, _deviceId: string, events: RoomEvents) {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, older: SavedMessage[] = [], current: SavedMessage[] = [], more = false;
    let shown = new Set<string>(), first = true, lastRead: string | undefined, closed = false;
    const files = new Map<string, FileView>(), wanted = new Set<string>(), base = `/api/local/rooms/${roomId}`;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const fileViews = (view: View) => {
      for (const [sha, state] of Object.entries(view.files)) {
        const known = files.get(sha);
        if (state.held) {
          if (known?.url || wanted.has(`get:${sha}`)) continue;
          wanted.add(`get:${sha}`);
          void this.blob(`${base}/files/${sha}`).then(blob => {
            files.set(sha, { url: URL.createObjectURL(blob), type: blob.type });
            if (!disposed) events.files(Object.fromEntries(files));
          }, () => wanted.delete(`get:${sha}`));
        } else {
          files.set(sha, state.transfer ? { transfer: state.transfer } : {});
          // Like a browser, the person device fetches what the room shows: asked once per file while this page is open.
          if (!wanted.has(sha)) { wanted.add(sha); void this.call(`${base}/files/${sha}/want`, { method: 'POST', json: {} }).catch(() => wanted.delete(sha)); }
        }
      }
      return Object.fromEntries(files);
    };
    const status = (view: View): RoomStatus | undefined => {
      const s = view.status;
      if (view.state === 'joined') {
        if (!s?.memberId) return undefined;
        return { ...s, devices: s.devices ?? [] };
      }
      // A room just added (created here, or paired) whose runner hasn't heard from the room service yet: still connecting.
      if (view.state === 'starting') return undefined;
      // Not in the room: what the room service last said about this device's request, as the hosted page shows it.
      const request = s && !s.memberId ? s.request : undefined;
      return { roomId, title: view.title ?? s?.title ?? '', epoch: '', hostOnline: !!s?.hostOnline, deviceId: s?.deviceId ?? '',
        ...(request ? { request } : {}) };
    };
    const readOnce = async () => {
      if (disposed || closed) return;
      try {
        const view = await this.call<View>(`${base}/view`);
        if (disposed) return;
        if (view.state === 'closed') { closed = true; events.closed(view.reason || 'The host closed this room.'); void this.forget(roomId).then(rooms => { if (!disposed) events.recent(rooms); }); resolveDone(); return; }
        const next = status(view);
        if (!next) { events.network('Meshrooms on this computer is still connecting to this room.'); return; }
        events.status(next);
        events.network('');
        const messages = [...older.filter(m => !view.messages.some(v => v.packet.body.id === m.packet.body.id)), ...view.messages];
        if (first) more = view.more;
        // Only the newest window brings arrivals: an older page loaded on request is history, never announced as new.
        const added = first ? undefined : view.messages.filter(m => !shown.has(m.packet.body.id)).at(-1);
        shown = new Set(messages.map(m => m.packet.body.id)); current = messages;
        events.messages(messages, view.status?.connected ?? [], added);
        events.board(foldBoard(view.taskOps), view.taskOps);
        events.decisions(view.decisionOps);
        events.reactions(view.reactions);
        events.files(fileViews(view));
        events.activity(view.status?.activity ?? {});
        if (first) {
          first = false;
          // The person device's read position, as the hosted page keeps its own: the last message read.
          const position = view.read.id ? view.read : { id: [...view.messages].reverse().find(m => m.packet.body.at <= view.read.at)?.packet.body.id, at: view.read.at };
          lastRead = position.id;
          events.position({ ...(position.id ? { id: position.id } : {}), at: Date.now() });
        }
      } catch (error) {
        if (!disposed) events.network((error as Error).message);
      }
    };
    // One read at a time, so an older answer never lands after a newer one; a change during a read reads again after it.
    let reading: Promise<void> | undefined, again = false;
    const read = (): Promise<void> => {
      if (reading) { again = true; return reading; }
      return reading = (async () => { do { again = false; await readOnce(); } while (again && !disposed); })().finally(() => { reading = undefined; });
    };
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => void read(), 120); };
    const session: RoomSession = {
      send: async (text, replyTo, chosen = []) => {
        const attachments = [];
        for (const { ref, bytes } of chosen) {
          const stored = await this.call<{ sha256: string; name: string }>(`${base}/files?name=${encodeURIComponent(ref.name)}`, { method: 'POST', body: bytes as BodyInit, headers: { 'Content-Type': 'application/octet-stream' }, timeout: 60_000 });
          attachments.push({ sha256: stored.sha256, name: stored.name });
        }
        await this.call(`${base}/send`, { method: 'POST', json: { text, ...(replyTo ? { replyTo } : {}), requestId: crypto.randomUUID(), ...(attachments.length ? { attachments } : {}) } });
        soon();
      },
      react: async (messageId, emoji) => { await this.changed(`${base}/react`, { messageId, emoji, requestId: crypto.randomUUID() }); soon(); },
      changeTask: async (change, current, removed = false) => {
        await this.changed(`${base}/task`, { requestId: crypto.randomUUID(), ...(current ? { taskId: current.id } : {}), change, ...(removed ? { removed: true } : {}) });
        soon();
      },
      openDecision: async draft => { const result = await this.changed(`${base}/decision`, { requestId: crypto.randomUUID(), action: 'open', ...draft }); soon(); return result.decisionId; },
      reviseDecision: async (decision, change) => {
        const action = change.addOption !== undefined ? { action: 'option', label: change.addOption } : change.close ? { action: 'close' } : { action: 'withdraw' };
        await this.changed(`${base}/decision`, { requestId: crypto.randomUUID(), decisionId: decision.id, ...action }); soon();
      },
      vote: async (decision, optionId, comment = '') => { await this.changed(`${base}/decision`, { requestId: crypto.randomUUID(), decisionId: decision.id, action: 'vote', optionId, comment }); soon(); },
      // The person device keeps the room's newest files, as a browser does; what it let go is fetched again on request.
      evicted: () => false,
      markRead: async messageId => {
        if (messageId === lastRead) return;
        lastRead = messageId;
        await this.call(`${base}/read`, { method: 'POST', json: { messageId } });
      },
      // Counts come from the person device, for every page alike.
      publishCount: () => {},
      loadOlder: async () => {
        const oldest = current[0]?.packet.body.id;
        if (!more || !oldest) return false;
        const page = await this.call<View>(`${base}/view?before=${oldest}&limit=200`);
        older = [...page.messages, ...older]; more = page.more;
        await read();
        return more;
      },
      hasOlder: () => more,
      stop: () => { disposed = true; resolveDone(); },
    };
    events.ready(session);
    const stop = this.subscribe((list, reset) => { if (reset || list.some(e => e.type === 'rooms' || ('roomId' in e && e.roomId === roomId))) soon(); });
    void read();
    return { done, dispose() { disposed = true; clearTimeout(timer); stop(); resolveDone(); } };
  }
  /** A change the person device signs: its answer says whether it was made (`dropped`: it no longer applied). */
  private async changed(path: string, json: Record<string, unknown>) {
    const result = await this.call<{ status: string; decisionId?: string }>(path, { method: 'POST', json, timeout: 15_000 });
    if (result.status === 'dropped') throw new Error('This change no longer applied by the time it was signed (someone changed it first). Look again and retry.');
    return result;
  }
}
