import { BrowserApi, type ApiError } from './client';
import { BrowserPeers, type SavedMessage } from './peers';
import { ROOM_CLOSED, type RoomStatus } from './protocol';
import { claimFence, read, write, type Fence } from './storage';
import { clearWaiting, countUnread, publishCount, publishedCounts, readPosition, waitingOf, type ReadPosition } from './unread';

/**
 * Background rooms: while any Meshrooms tab is open, one tab per browser profile (the leader) also stays connected to
 * the person's other rooms, so their messages arrive peer to peer as usual and the sidebar shows real unread counts.
 * The room service sees the same status polls it always does, only less often, and nothing about messages.
 *
 * A browser profile is one device, and the service keeps one session per device and room, so exactly one engine may
 * hold a room's connection at a time. Three kinds of Web Lock keep it that way:
 * - `meshrooms-room:<id>`: the tab showing the room (one per room; a second tab is told the room is already open);
 * - `meshrooms-connection:<id>`: whoever runs the room's connection, that tab or the leader in the background;
 * - `meshrooms-background`: the leader. Every tab queues for it, so when the leader closes another takes over.
 * A tab opening a room takes the room lock, tells the leader, and waits for the connection lock; the leader stops that
 * room, waits for its writes to finish and releases it, and the tab loads the stored history with its own session.
 */
export type RecentRoom = { id: string; title: string };

/**
 * Background rooms poll room status every 6 s instead of 1.5 s. It can't be much slower: the service reports a device
 * online only within 10 s of its last poll, and peers drop the connection of a device that isn't online.
 */
export const BACKGROUND_POLL_MS = 6000;
/** At most this many rooms in the background: the most recently opened. Rooms past it show no count. */
export const BACKGROUND_ROOMS = 10;
/**
 * When every Meshrooms tab has been hidden this long, background rooms disconnect until one is visible again. Their
 * counts stay as they were; messages sent meanwhile arrive when they reconnect, since senders retry until stored.
 * It also matches Chrome's intensive throttling, which limits timers in pages hidden for five minutes to about one
 * wake-up a minute (pages using WebRTC are exempt, but a room with nobody else online has no connection to exempt it).
 */
export const HIDDEN_PAUSE_MS = 5 * 60_000;
/** A hidden leader hands over to a visible tab after this long, since hidden tabs' timers are throttled first. */
const HIDDEN_LEADER_MS = 2 * 60_000;
/** Visible tabs say so this often; a tab not heard from for longer than VISIBLE_STALE_MS may have been hidden. */
const VISIBLE_BEAT_MS = 20_000, VISIBLE_STALE_MS = 45_000;
/** The leader checks which rooms other tabs show at least this often, besides on every message from them. */
const RECONCILE_MS = 2000;
/** A tab waits this long for the leader to hand a room over before taking the connection lock anyway. */
const TAKEOVER_MS = 10_000;
/**
 * A background room that ended on its own (fenced out by another tab's claim, or its storage failed) is started again
 * after this long, doubling each time in a row up to RESTART_MAX_MS, so a lasting conflict can't make it spin.
 */
export const RESTART_MS = 5000, RESTART_MAX_MS = 120_000;

export const roomLock = (roomId: string) => `meshrooms-room:${roomId}`;
export const connectionLock = (roomId: string) => `meshrooms-connection:${roomId}`;
const LEADER_LOCK = 'meshrooms-background';
const CHANNEL = 'meshrooms-tabs';
type TabMessage = { type: 'claim' | 'release'; roomId: string } | { type: 'rooms' } | { type: 'visible' };

function channel(): BroadcastChannel | undefined {
  try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : undefined; } catch { return undefined; }
}
function post(message: TabMessage) {
  const bus = channel(); if (!bus) return;
  try { bus.postMessage(message); } finally { bus.close(); }
}
/** Tell other tabs the list of rooms changed (a room joined, closed or removed). */
export const announceRooms = () => post({ type: 'rooms' });
/** Follow room-list changes made by other tabs. */
export function onRoomsChanged(listener: () => void) {
  const bus = channel(); if (!bus) return () => {};
  bus.onmessage = event => { if ((event.data as TabMessage)?.type === 'rooms') listener(); };
  return () => bus.close();
}

/** A closed room leaves this browser's list of rooms. */
export async function forgetRoom(id: string) {
  const rest = await navigator.locks.request('meshrooms-recent', async () => {
    const all = (await read<RecentRoom[]>('recent-rooms') || []).filter(r => r.id !== id);
    await write('recent-rooms', all);
    return all;
  });
  announceRooms();
  return rest;
}
/** When each room was last opened in the foreground here; the background cap keeps the most recent. */
export async function recordOpened(roomId: string) {
  await navigator.locks.request('meshrooms-recent', async () => {
    const opened = await read<Record<string, number>>('rooms-opened') || {};
    await write('rooms-opened', { ...opened, [roomId]: Date.now() });
  });
}
/**
 * The rooms to keep in the background: joined rooms no tab shows, most recently opened first (rooms never opened
 * since this feature keep their list order, after those), at most `cap`.
 */
export function backgroundRooms(recent: RecentRoom[], opened: Record<string, number>, excluded: Set<string>, cap = BACKGROUND_ROOMS) {
  return recent.map((room, index) => ({ room, index })).filter(({ room }) => !excluded.has(room.id))
    .sort((a, b) => (opened[b.room.id] ?? -1) - (opened[a.room.id] ?? -1) || a.index - b.index)
    .slice(0, cap).map(({ room }) => room.id);
}

/**
 * The foreground tab's hold on its room's connection: tells the leader, then waits for it to hand the room over.
 * A leader that doesn't answer in time (a frozen tab) has the lock taken from it.
 */
export async function holdConnection<T>(roomId: string, work: () => Promise<T>, wait = TAKEOVER_MS): Promise<T> {
  post({ type: 'claim', roomId });
  const release = () => post({ type: 'release', roomId });
  addEventListener('pagehide', release);
  try {
    return await navigator.locks.request(connectionLock(roomId), { signal: AbortSignal.timeout(wait) }, work);
  } catch (error) {
    if ((error as DOMException)?.name !== 'TimeoutError' && (error as DOMException)?.name !== 'AbortError') throw error;
    return await navigator.locks.request(connectionLock(roomId), { steal: true }, work);
  } finally { removeEventListener('pagehide', release); release(); }
}

/** Every tab says when it is visible, so the leader knows whether anyone is looking at Meshrooms. */
export function announceVisibility() {
  const beat = () => { if (document.visibilityState === 'visible') post({ type: 'visible' }); };
  beat();
  const timer = setInterval(beat, VISIBLE_BEAT_MS);
  document.addEventListener('visibilitychange', beat);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', beat); };
}

/**
 * Claim a room's records for the engine about to hold its connection (see claimFence). Called with the connection
 * lock held; an owner that lost the lock, even one frozen mid-write, can no longer write the room's records.
 */
export const claimRoom = (deviceId: string, roomId: string) => claimFence(`owner:${deviceId}:${roomId}`);

const closedError = (e: unknown) => (e as ApiError).status === 410 && (e as ApiError).code === ROOM_CLOSED;

/** When background rooms end without being asked to, and when they have run well again. */
export class Restarts {
  private failures = new Map<string, { count: number; until: number }>();
  constructor(private base = RESTART_MS, private now = () => Date.now()) {}
  /** The room ended on its own: not started again for a while, longer each time in a row. */
  failed(roomId: string) {
    const count = (this.failures.get(roomId)?.count || 0) + 1;
    this.failures.set(roomId, { count, until: this.now() + Math.min(RESTART_MAX_MS, this.base * 2 ** (count - 1)) });
  }
  /** It polled the room successfully: the next failure waits the shortest time again. */
  healthy(roomId: string) { this.failures.delete(roomId); }
  waiting(roomId: string) { const f = this.failures.get(roomId); return !!f && f.until > this.now(); }
}

/** What a background room tells the leader. `ended`: it stopped on its own and released the room. */
export type RoomEvents = { gone(reason: 'closed' | 'removed'): void; ended(): void; healthy(): void };

/** One room held in the background: its own session, status polls every BACKGROUND_POLL_MS, and its unread count. */
export class BackgroundRoom {
  private stopping = false;
  private wake?: () => void;
  private halted: Promise<void>;
  private halt!: () => void;
  private engine?: BrowserPeers;
  private messages: SavedMessage[] = [];
  private status?: RoomStatus;
  private position?: ReadPosition;
  /** Settles once the room's connection lock is released. */
  done: Promise<void>;
  /** True once the lock was granted; false if another tab had the room. */
  started: Promise<boolean>;
  constructor(private api: Pick<BrowserApi, 'command'>, private deviceId: string, readonly roomId: string, private events: RoomEvents) {
    let granted!: (value: boolean) => void;
    this.started = new Promise(resolve => { granted = resolve; });
    this.halted = new Promise(resolve => { this.halt = () => { this.stopping = true; this.engine?.stop(); this.wake?.(); resolve(); }; });
    this.done = navigator.locks.request(connectionLock(roomId), { ifAvailable: true }, async lock => {
      if (!lock) { granted(false); return; }
      granted(true);
      if (this.stopping) return;
      // Claimed while the lock is held, never after it is released: a tab taking the room over claims after this, so
      // its claim is the one that counts. A room halted meanwhile doesn't go on with a claim it no longer holds.
      let fence: Fence;
      try { fence = await claimRoom(deviceId, roomId); } catch { this.events.ended(); return; }
      if (this.stopping) return;
      // Stopping doesn't wait for a status poll in flight: the engine stops at once, and the lock is released as soon
      // as the writes it had started are done. The poll then finds it stopped and ends.
      await Promise.race([this.run(fence).catch(() => {}), this.halted]);
      await this.engine?.close();
      // No longer live here: whoever holds the room next says who is waiting.
      clearWaiting(deviceId, roomId);
      if (!this.stopping) this.events.ended();
    }).catch(() => { /* Taken by a tab that couldn't wait: stop quietly. */ this.halt(); }).finally(() => granted(false));
  }
  private recount() {
    const memberId = this.status?.memberId;
    if (!memberId || !this.position || this.stopping) return;
    // In rooms this person hosts, status lists who is waiting to join: they can admit them without opening the room first.
    publishCount(this.deviceId, this.roomId, { ...countUnread(this.messages.map(m => m.packet.body), this.position, memberId, this.status?.members || []), waiting: waitingOf(this.status) });
  }
  private async run(fence: Fence) {
    const session = crypto.randomUUID();
    let cursor = 0, epoch = '', backoff = 0, healthy = false;
    const engine = this.engine = new BrowserPeers(this.api as BrowserApi, this.roomId, this.deviceId, session, messages => { this.messages = messages; this.recount(); }, () => { /* Retried by the next poll. */ });
    engine.fenced(fence);
    await engine.load();
    if (this.stopping) return;
    this.position = await readPosition(this.deviceId, this.roomId, this.messages.map(m => m.packet.body), fence);
    this.recount();
    // A write fenced out (another tab claimed the room) stops the engine: then this room stops polling too.
    while (!this.stopping && !engine.isStopped()) {
      const started = Date.now();
      try {
        const next = await this.api.command('status', this.roomId, { session, cursor, epoch });
        if (this.stopping) break;
        if (next.epoch !== epoch) cursor = 0;
        epoch = next.epoch;
        // Removed from the room (or never admitted on this device): nothing to show here any more.
        if (!next.memberId) { this.events.gone('removed'); break; }
        this.status = next;
        await engine.update(next);
        for (const signal of next.signals || []) cursor = Math.max(cursor, signal.seq);
        this.recount(); backoff = 0;
        if (!healthy) { healthy = true; this.events.healthy(); }
      } catch (e) {
        if (closedError(e)) { this.events.gone('closed'); break; }
        // Over the service's rate limit: back off, and keep backing off while it lasts.
        if ((e as ApiError).status === 429) backoff = Math.min(60_000, (backoff || 15_000) * 2);
      }
      if (this.stopping) break;
      // Polls are spaced from start to start: a slow connection setup must not stretch the gap past the service's
      // 10 s presence window.
      await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, Math.max(0, BACKGROUND_POLL_MS - (Date.now() - started)) + backoff); });
    }
  }
  /** Stop, and resolve once every write finished and the connection lock is released. */
  async stop() { this.halt(); await this.done; }
}

/**
 * The leader: keeps the chosen rooms in the background until this tab closes or hands over. `foreground` is the room
 * this tab shows, never held here in the background.
 */
export class BackgroundRooms {
  private api = new BrowserApi();
  private rooms = new Map<string, BackgroundRoom>();
  /** Rooms that closed or no longer admit this device: left alone while this tab leads. */
  private skipped = new Set<string>();
  private restarts: Restarts;
  private bus = channel();
  private disposed = false;
  private othersVisibleAt = 0;
  private hiddenSince = document.visibilityState === 'visible' ? undefined as number | undefined : Date.now();
  private wake?: () => void;
  private abort = new AbortController();
  private busy?: Promise<void>;
  private again = false;
  constructor(private deviceId: string, private foreground: string, restartMs = RESTART_MS) {
    this.restarts = new Restarts(restartMs);
    if (this.bus) this.bus.onmessage = event => {
      const message = event.data as TabMessage;
      if (message?.type === 'visible') this.othersVisibleAt = Date.now();
      // Released locks are gone a moment after the page that held them.
      if (message?.type === 'release') setTimeout(() => this.poke(), 300);
      else this.poke();
    };
    document.addEventListener('visibilitychange', this.visibility);
    void this.lead();
  }
  /** Reconcile now, or once more after the pass that is running, which may have looked before this news. */
  private poke() { if (this.busy) this.again = true; else this.wake?.(); }
  private visibility = () => {
    this.hiddenSince = document.visibilityState === 'visible' ? undefined : this.hiddenSince ?? Date.now();
    this.poke();
  };
  /** Queue for leadership; after handing over to a visible tab, queue again behind the others. */
  private async lead() {
    while (!this.disposed) {
      try {
        await navigator.locks.request(LEADER_LOCK, { signal: this.abort.signal }, async () => {
          try { await this.loop(); } finally { await this.stopAll(); }
        });
      } catch { return; } // Disposed while queued.
      if (!this.disposed) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  private async loop() {
    while (!this.disposed) {
      await this.reconcile();
      if (this.disposed) return;
      // A hidden leader hands over when another tab is visible: hidden tabs are throttled first.
      if (this.hiddenSince !== undefined && Date.now() - this.hiddenSince > HIDDEN_LEADER_MS && Date.now() - this.othersVisibleAt < VISIBLE_STALE_MS) return;
      await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, RECONCILE_MS); });
      this.wake = undefined;
    }
  }
  /** Nobody has looked at a Meshrooms tab for HIDDEN_PAUSE_MS. */
  private paused() {
    if (this.hiddenSince === undefined) return false;
    const lastSeen = Math.max(this.hiddenSince, this.othersVisibleAt);
    return Date.now() - lastSeen > HIDDEN_PAUSE_MS;
  }
  /** Serialized: a message arriving mid-way runs it once more afterwards. */
  private reconcile(): Promise<void> {
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = (async () => {
      do { this.again = false; await this.reconcileOnce().catch(() => { /* Storage or locks unavailable: tried again shortly. */ }); } while (this.again && !this.disposed);
    })().finally(() => { this.busy = undefined; });
    return this.busy;
  }
  private async reconcileOnce() {
    const locks = await navigator.locks.query();
    const shown = new Set([this.foreground, ...(locks.held || []).map(l => l.name || '').filter(n => n.startsWith('meshrooms-room:')).map(n => n.slice('meshrooms-room:'.length))]);
    const recent = await read<RecentRoom[]>('recent-rooms') || [];
    const opened = await read<Record<string, number>>('rooms-opened') || {};
    const paused = this.paused();
    const wanted = new Set(paused || this.disposed ? [] : backgroundRooms(recent, opened, new Set([...shown, ...this.skipped])));
    // A room that ended on its own waits out its backoff before it is started again.
    const due = [...wanted].filter(roomId => !this.restarts.waiting(roomId));
    await Promise.all([...this.rooms.values()].filter(r => !wanted.has(r.roomId)).map(async room => {
      this.rooms.delete(room.roomId); await room.stop();
    }));
    if (!paused) {
      // Rooms nobody holds live show no count: past the cap, closed, or left.
      for (const roomId of Object.keys(publishedCounts(this.deviceId))) if (!wanted.has(roomId) && !shown.has(roomId)) publishCount(this.deviceId, roomId, undefined);
    }
    for (const roomId of due) {
      if (this.rooms.has(roomId) || this.disposed) continue;
      const room: BackgroundRoom = new BackgroundRoom(this.api, this.deviceId, roomId, {
        gone: reason => this.gone(roomId, reason),
        // Ended on its own: forgotten, so a later pass starts it again, after the backoff.
        ended: () => { if (this.rooms.get(roomId) === room) this.rooms.delete(roomId); this.restarts.failed(roomId); this.poke(); },
        healthy: () => this.restarts.healthy(roomId),
      });
      this.rooms.set(roomId, room);
      // Another tab holds it (it is taking the room over): try again on a later pass.
      if (!await room.started) { this.rooms.delete(roomId); }
    }
  }
  private gone(roomId: string, reason: 'closed' | 'removed') {
    this.skipped.add(roomId);
    publishCount(this.deviceId, roomId, undefined);
    if (reason === 'closed') void forgetRoom(roomId).catch(() => {});
    this.poke();
  }
  /** Leadership ends: the rooms stop, and keep their counts until the next leader publishes them again. */
  private async stopAll() {
    const rooms = [...this.rooms.values()]; this.rooms.clear();
    await Promise.all(rooms.map(room => room.stop()));
  }
  dispose() {
    this.disposed = true; this.abort.abort();
    document.removeEventListener('visibilitychange', this.visibility);
    this.wake?.();
    this.bus?.close();
  }
}
