/**
 * Where a room's data comes from, so the same screens (BrowserRooms) serve two kinds of page:
 *
 * - BrowserSource, the hosted site: this browser is a device of its own. It signs its commands, polls the room service,
 *   holds peer connections (BrowserPeers), keeps history in IndexedDB and shares rooms between tabs (background.ts).
 * - LocalSource (local-source.ts), the page the desktop app serves on 127.0.0.1: a thin client of the machine's person
 *   device, which the daemon runs. It reads and changes rooms through the local API; the device signs and connects.
 *
 * The interface is what the screens need, in the shapes they already use (RoomStatus, SavedMessage, task, decision and
 * reaction operations, FileView), so neither page draws anything differently.
 */
import type { Task } from '../collab';
import type { TaskBody, TaskChange } from './board';
import { BrowserApi, type ApiError } from './client';
import type { DecisionDraft } from './DecisionViews';
import type { Decision, DecisionBody, VoteBody } from './decisions';
import type { ActivityRecord } from './activity';
import type { AttachmentRef } from './files';
import { BrowserPeers, type FileView, type SavedMessage } from './peers';
import type { ReactionChip, ReactionEmoji } from './reactions';
import { identity, persistStorage, read, write } from './storage';
import { BackgroundRooms, announceRooms, announceVisibility, claimRoom, forgetRoom, holdConnection, onRoomsChanged, recordOpened, type RecentRoom } from './background';
import { clearWaiting, onCountsChanged, publishCount, publishedCounts, readPosition, saveReadPosition, type ReadPosition, type UnreadCount } from './unread';
import { ROOM_CLOSED, type Command, type JoinRequest, type RoomStatus } from './protocol';

/** What an open room tells the screen, as it changes. Nothing is called once the room is disposed. */
export type RoomEvents = {
  /** The room's actions are available (the connection is held, its history loaded). */
  ready(session: RoomSession): void;
  status(next: RoomStatus): void;
  messages(messages: SavedMessage[], connected: string[], added?: SavedMessage): void;
  network(problem: string): void;
  board(tasks: Task[], ops: TaskBody[]): void;
  files(view: Record<string, FileView>): void;
  activity(records: Record<string, ActivityRecord>): void;
  decisions(ops: (DecisionBody | VoteBody)[]): void;
  reactions(chips: ReactionChip[]): void;
  /** How far this person has read the room, once its history is loaded. */
  position(position: ReadPosition): void;
  /** The host closed the room, or the service removed it. */
  closed(reason: string): void;
  /** The person's list of rooms changed (a closed room left it). */
  recent(rooms: RecentRoom[]): void;
  /** Another tab of this browser took the room over. */
  lost(): void;
};
/** What the person can do in an open room. */
export interface RoomSession {
  send(text: string, replyTo?: string, files?: { ref: AttachmentRef; bytes: Uint8Array }[]): Promise<void>;
  react(messageId: string, emoji: ReactionEmoji): Promise<void>;
  changeTask(change: TaskChange, current?: Task, removed?: boolean): Promise<void>;
  openDecision(draft: DecisionDraft): Promise<unknown>;
  reviseDecision(decision: Decision, change: { addOption?: string; close?: boolean; withdraw?: boolean }): Promise<void>;
  vote(decision: Decision, optionId: string | null, comment?: string): Promise<void>;
  /** Whether a file of the room was let go here because newer ones filled its storage. */
  evicted(sha: string): boolean;
  /** The person has read up to this message. */
  markRead(messageId: string): Promise<void>;
  /** The open room's badge, for this person's other tabs. */
  publishCount(count: UnreadCount | undefined): void;
  /** Older messages, when the room holds more than it handed out at first; false once there are none. */
  loadOlder(): Promise<boolean>;
  /** Whether older messages can be loaded. */
  hasOlder(): boolean;
  stop(): void;
}
/**
 * The person's agents on this computer (the local page only, server/local-agents.ts): harnesses found here, agent
 * identities, putting them into rooms and binding them to sessions. Every string in these shapes comes from the machine
 * (titles, folder labels, names, errors) and is shown as plain text only.
 */
export type HarnessId = 'claude' | 'codex' | 'hermes' | 'exec';
export type HarnessScan = { harness: HarnessId; label: string; detected: boolean; version?: string; sessionsAvailable: boolean; reason?: string };
export type HarnessSession = { id: string; title: string | null; folder: string | null; lastActiveAt: string | null; lastActiveLabel?: string | null };
export type SessionListing = { harness: HarnessId; sessionsAvailable: boolean; reason?: string; truncated: boolean; sessions: HarnessSession[] };
export type AgentBinding = {
  wakes: 'unbound' | 'on' | 'off' | 'paused' | 'halted'; kind?: 'new' | 'existing'; state?: 'starting' | 'bound' | 'failed';
  reason?: 'bootstrap-failed' | 'bind-refused' | 'not-finished'; session?: string | null; error?: string; offReason?: string;
  /** Wakes are on and the watcher listens (it has its listen cursor); until then a mention could pass unnoticed. */
  listening?: boolean;
};
export type AgentRoom = { roomId: string; title: string | null; memberId: string | null; state: 'connected' | 'waiting' | 'closed' | 'removed'; runner: 'alive' | 'down'; binding: AgentBinding };
export type LocalAgent = { id: string; name: string; harness: HarnessId; label: string; model: string | null; custom: boolean; createdAt: string; rooms: AgentRoom[] };
export interface LocalAgents {
  list(): Promise<{ agents: LocalAgent[]; approvalsWaiting: number }>;
  harnesses(): Promise<HarnessScan[]>;
  sessions(harness: HarnessId): Promise<SessionListing>;
  create(input: { name: string; harness: HarnessId; model?: string }): Promise<LocalAgent>;
  remove(identityId: string): Promise<void>;
  /** Puts an identity into a room: it joins at once, or waits for the host (a guest's agent, when the room asks). */
  putIntoRoom(roomId: string, identityId: string): Promise<{ state: 'connected' | 'waiting' }>;
  /**
   * 'new': a new session, bound at once or started in the background (`starting`, then GET /agents says how it went).
   * A listed session's id: never bound from the page, only filed for the person to approve in the app (`pending`).
   */
  bind(roomId: string, member: string, session: string): Promise<{ state: 'bound' | 'starting' } | { approval: 'pending' }>;
  unbind(roomId: string, member: string): Promise<{ wakes: string }>;
}
/** The room service actions the screens send, besides what a RoomSession does. */
export type RoomAction = Extract<Command['action'], 'create' | 'request' | 'cancel' | 'status' | 'decide' | 'link' | 'remove' | 'agent-invite' | 'settings' | 'profile' | 'repositories' | 'close'>;
export interface RoomSource {
  /** The page the desktop app serves: the person device does the work. */
  readonly isLocal: boolean;
  /** The footer's note on where this page runs. */
  readonly label: string;
  /** The person's agents on this computer: only the local page has them; the hosted site connects agents by link. */
  readonly agents?: LocalAgents;
  /** This device, the person's rooms and the name they last used. */
  start(): Promise<{ deviceId: string; recent: RecentRoom[]; name: string }>;
  /** What the room service says about itself: whether creating a room needs an invite, the agents' bridge version, and (the local page) which room service new rooms are made on. */
  health(): Promise<{ inviteRequired?: boolean; currentAgentVersion?: string; roomService?: string }>;
  /** A room's title, or why it is gone. */
  room(roomId: string): Promise<{ title: string } | { closed: string }>;
  /** Opens a room: the events follow until `dispose`. `done` settles when the room stops (closed, lost or disposed). */
  open(roomId: string, deviceId: string, events: RoomEvents): { done: Promise<void>; dispose(): void };
  /** A room service action, signed by this device (or by the person device, for the local page). */
  command(action: RoomAction, roomId: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Drops a closed room from the person's list. */
  forget(roomId: string): Promise<RecentRoom[]>;
  /** Unread counts of the person's rooms, as known now. */
  counts(deviceId: string): Record<string, UnreadCount>;
  /** Follows counts and the room list, and keeps the person's other rooms connected, while a page is open. */
  watch(deviceId: string, openRoom: string, on: { counts(counts: Record<string, UnreadCount>): void; recent(rooms: RecentRoom[]): void }): () => void;
  /** This page stops holding a room (it closes or moves on). */
  leave(deviceId: string, roomId: string): void;
  /** Where the room lives: its links (invites, agent links) are on this origin. */
  roomOrigin(roomId: string): string;
  /** A member's picture: its URL now, or undefined while it loads (then `loaded` is called). */
  avatar(roomId: string, memberId: string, hash: string, loaded: () => void): string | undefined;
  /** This page's own small settings (the name last used, a dismissed banner). */
  readPref<T>(key: string): Promise<T | undefined>;
  writePref(key: string, value: unknown): Promise<void>;
}

const closedError = (e: unknown) => (e as ApiError).status === 410 && (e as ApiError).code === ROOM_CLOSED;

/** The hosted site: this browser is the device. Its behaviour is the browser rooms' as they were, moved here. */
export class BrowserSource implements RoomSource {
  readonly isLocal = false;
  readonly label = 'Browser preview';
  private api = new BrowserApi();
  async start() {
    const device = await identity();
    const rooms = await read<RecentRoom[]>('recent-rooms') || [];
    const profile = await read<string>('display-name') || '';
    return { deviceId: device.id, recent: rooms, name: profile };
  }
  async health() {
    const health = await fetch('/api/lobby/health', { signal: AbortSignal.timeout(10_000) }).then(r => r.json());
    return { ...(health?.inviteRequired === true ? { inviteRequired: true } : {}), ...(typeof health?.currentAgentVersion === 'string' ? { currentAgentVersion: health.currentAgentVersion } : {}) };
  }
  async room(roomId: string) {
    const response = await fetch(`/api/lobby/rooms/${roomId}`, { signal: AbortSignal.timeout(10_000) });
    const info = await response.json();
    if (response.status === 410 && info.code === ROOM_CLOSED) return { closed: info.error as string };
    if (!response.ok) throw new Error(info.error || 'Room unavailable.');
    return { title: info.title as string };
  }
  command(action: RoomAction, roomId: string, payload: Record<string, unknown> = {}) {
    return this.api.command(action, roomId, payload) as unknown as Promise<Record<string, unknown>>;
  }
  forget(roomId: string) { return forgetRoom(roomId); }
  counts(deviceId: string) { return publishedCounts(deviceId); }
  watch(deviceId: string, openRoom: string, on: { counts(counts: Record<string, UnreadCount>): void; recent(rooms: RecentRoom[]): void }) {
    const refresh = () => on.counts(publishedCounts(deviceId));
    refresh();
    const stopCounts = onCountsChanged(refresh);
    const stopRooms = onRoomsChanged(() => void read<RecentRoom[]>('recent-rooms').then(rooms => on.recent(rooms || [])).catch(() => {}));
    const stopBeats = announceVisibility();
    const background = new BackgroundRooms(deviceId, openRoom);
    return () => { stopCounts(); stopRooms(); stopBeats(); background.dispose(); };
  }
  leave(deviceId: string, roomId: string) { clearWaiting(deviceId, roomId); }
  roomOrigin() { return location.origin; }
  avatar(roomId: string, memberId: string, hash: string) { return `/api/lobby/rooms/${roomId}/avatars/${memberId}?h=${hash}`; }
  readPref<T>(key: string) { return read<T>(key); }
  async writePref(key: string, value: unknown) { await write(key, value); }

  open(urlRoom: string, deviceId: string, events: RoomEvents) {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
    let engine: BrowserPeers | undefined, lastRequest: JoinRequest | undefined;
    const api = this.api;
    const done = (async () => {
      await navigator.locks.request(`meshrooms-room:${urlRoom}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('This room is already open in another tab of this browser. Close that tab, then retry here.');
        if (disposed) return;
        // The leader tab may hold this room in the background: it hands the connection over first.
        await holdConnection(urlRoom, async () => {
        if (disposed) return;
        const session = crypto.randomUUID(); let cursor = 0, epoch = '', recorded = false;
        let latest: SavedMessage[] = [];
        engine = new BrowserPeers(api, urlRoom, deviceId, session, (m, c, added) => {
          latest = m;
          if (!disposed) events.messages(m, c, added);
        }, message => { if (!disposed) events.network(message); }, (board, ops) => { if (!disposed) events.board(board, ops); }, view => { if (!disposed) events.files(view); },
        records => { if (!disposed) events.activity(records); }, ops => { if (!disposed) events.decisions(ops); },
        chips => { if (!disposed) events.reactions(chips); });
        // This tab owns the room's records now: a background owner that lost the room can no longer write them.
        const fence = await claimRoom(deviceId, urlRoom);
        engine.fenced(fence);
        const peers = engine;
        events.ready({
          send: (text, replyTo, files) => peers.send(text, replyTo, files),
          react: (messageId, emoji) => peers.react(messageId, emoji),
          changeTask: (change, current, removed) => peers.changeTask(change, current, removed),
          openDecision: draft => peers.openDecision(draft),
          reviseDecision: (decision, change) => peers.reviseDecision(decision, change),
          vote: (decision, optionId, comment) => peers.vote(decision, optionId, comment),
          evicted: sha => peers.evicted(sha),
          markRead: messageId => saveReadPosition(deviceId, urlRoom, messageId, fence),
          publishCount: count => publishCount(deviceId, urlRoom, count),
          // A browser holds its whole history: there is never an older page to load.
          loadOlder: async () => false,
          hasOlder: () => false,
          stop: () => peers.stop(),
        });
        await engine.load();
        const stored = await readPosition(deviceId, urlRoom, latest.map(m => m.packet.body), fence);
        if (!disposed) events.position(stored);
        // A write that found another tab's claim stops the engine; then this tab stops polling and connecting too.
        while (!disposed && !engine.isStopped()) {
          try {
            const next = await api.command('status', urlRoom, { session, cursor, epoch });
            if (disposed) break;
            if (next.epoch !== epoch) cursor = 0;
            epoch = next.epoch;
            if (!next.memberId && !next.request && lastRequest) {
              const prior = lastRequest;
              if (prior.state === 'expired' || prior.state === 'declined') next.request = prior;
              else if (prior.state === 'pending' && prior.expiresAt <= Date.now()) next.request = { ...prior, state: 'expired', code: undefined };
            }
            lastRequest = next.request;
            events.status(next);
            if (next.memberId) {
              if (!recorded) {
                const joined = await navigator.locks.request('meshrooms-recent', async () => {
                  const all = await read<RecentRoom[]>('recent-rooms') || [];
                  // Opening a room keeps its place in the list (only its title refreshes); a newly joined room goes first.
                  const known = all.some(r => r.id === urlRoom);
                  await write('recent-rooms', (known ? all.map(r => r.id === urlRoom ? { ...r, title: next.title } : r) : [{ id: urlRoom, title: next.title }, ...all]).slice(0, 64));
                  return !known;
                });
                await recordOpened(urlRoom); // The background keeps the most recently opened rooms.
                if (joined) announceRooms();
                recorded = true;
                persistStorage(); // This browser now holds a room key; ask it not to evict site storage.
              }
            }
            await engine.update(next);
            for (const signal of next.signals || []) cursor = Math.max(cursor, signal.seq);
          } catch (e) {
            // The host closed the room, or the service removed it: stop polling and say so, instead of retrying forever.
            if (closedError(e)) {
              engine.stop(); publishCount(deviceId, urlRoom, undefined);
              if (!disposed) { events.closed((e as Error).message); void forgetRoom(urlRoom).then(rooms => { if (!disposed) events.recent(rooms); }); }
              break;
            }
            if (!disposed) events.network((e as Error).message);
          }
          if (!disposed) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 1500); });
        }
        if (engine.lostRoom() && !disposed) events.lost();
        // Every write finishes before the connection is handed back to the background.
        await engine.close();
        });
      });
    })();
    return { done, dispose() { disposed = true; engine?.stop(); clearTimeout(timer); wake?.(); } };
  }
}
