/**
 * Desktop notifications (desktop-first M5): what the person device and the agents' daemon know that the person should
 * hear about while no tab is open, as a short feed only the app reads (GET /api/local/notifications, control token
 * only; the page's session token is refused). The app polls it and posts each entry as a native notification.
 *
 * What notifies:
 * - a message that mentions the person (by their member id, as the room's mention rules find it) or replies to one of
 *   their messages; every message too in a room set to `all`, and nothing in a room set to `off` (the person's own
 *   setting per room, notifications.json in the person folder, never on the room service; `mentions` by default);
 * - someone waiting for the person, as host, to let them in: a person, or a guest's agent. Companion requests (a device
 *   being paired) are left out: the pairing window shows those, as the join window shows the app's own requests;
 * - an agent the person operates that its watcher paused (an approval wall among the reasons) or halted, or whose new
 *   session failed to start; and a request waiting for approval in the app (an agent asking for an identity, or binding
 *   an existing session).
 *
 * Every entry is short plain text: a room's title, a sender's name and at most PREVIEW_POINTS code points of what they
 * wrote, with control, format (bidi, zero-width) and line-breaking characters gone, and anything that looks like a path
 * replaced. Attachments are never named. Entries coalesce: one per room (and one for agents, one for approvals) per
 * COALESCE_MS, what came meanwhile merged into one ("3 new mentions in Launch"), and at most CAP_PER_MINUTE in a minute.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PERSON_STATUS_FILE, replaceFile } from './browser-agent';
import { listIdentities, pathFree, readApprovals, readIdentities, recordHold } from './agents';
import { listedAgents, personHome, personRooms, personRoomStatus, roomState } from './person';
import { mentionedIds } from '../src/collab';
import type { LocalEvent } from './local-api';

/** The person's notification settings, per room, in the person folder. */
export const NOTIFY_FILE = 'notifications.json';
export const NOTIFY_LEVELS = ['mentions', 'all', 'off'] as const;
export type NotifyLevel = typeof NOTIFY_LEVELS[number];
/** One entry per room (or for agents, or approvals) per this long; what comes meanwhile is merged into the next. */
export const COALESCE_MS = 30_000;
/** At most this many entries in any minute, across everything; the rest wait and merge. */
export const CAP_PER_MINUTE = 10;
/** Code points of a message shown at most. */
export const PREVIEW_POINTS = 80;
/** Entries the feed keeps for the app to read. */
export const KEPT_NOTICES = 200;
/** Long polls of the feed waiting at once, and how long one may wait. */
export const MAX_WAITERS = 4, MAX_WAIT_SECONDS = 30;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** The level set for each room; anything else in the file is left out. */
export function notifySettings(home = personHome()): Record<string, NotifyLevel> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(home, NOTIFY_FILE), 'utf8')); } catch { return {}; }
  const rooms = (parsed as { rooms?: unknown } | null)?.rooms;
  if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) return {};
  return Object.fromEntries(Object.entries(rooms).filter(([room, level]) => UUID.test(room) && NOTIFY_LEVELS.includes(level as NotifyLevel))) as Record<string, NotifyLevel>;
}
export const notifyLevel = (home: string, roomId: string): NotifyLevel => notifySettings(home)[roomId] ?? 'mentions';
/** Sets a room's level: a room on the person's list only; rooms no longer on it are dropped from the file meanwhile. */
export function setNotifyLevel(home: string, roomId: unknown, level: unknown) {
  if (typeof roomId !== 'string' || !UUID.test(roomId)) throw httpError(400, 'Use a room id.');
  if (!NOTIFY_LEVELS.includes(level as NotifyLevel)) throw httpError(400, `Use level ${NOTIFY_LEVELS.join(', ')}.`);
  const listed = new Set(personRooms(home).map(r => r.roomId));
  if (!listed.has(roomId)) throw httpError(404, 'This person is not in that room.');
  const rooms = Object.fromEntries(Object.entries(notifySettings(home)).filter(([room]) => listed.has(room) && room !== roomId));
  if (level !== 'mentions') rooms[roomId] = level as NotifyLevel;
  replaceFile(join(home, NOTIFY_FILE), JSON.stringify({ rooms }, null, 2));
  return { roomId, level: level as NotifyLevel };
}

/**
 * Characters that never reach a notification. Invisible ones (format characters: bidi controls, zero-width, tags; private
 * use, lone surrogates, variation selectors) are dropped, as the app's own text cleaning does; controls and line or
 * paragraph separators become a space.
 */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cs}᠋-᠏︀-️\u{E0100}-\u{E01EF}]/gu, BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
/** One line of at most `limit` code points, as plain text, cut with an ellipsis. */
export function plainLine(value: unknown, limit: number) {
  if (typeof value !== 'string') return '';
  const text = value.replace(INVISIBLE, '').replace(BREAKS, ' ').replace(/\s+/g, ' ').trim(), points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('').trimEnd()}…`;
}
/** What a notification shows of a message: anything that looks like a path replaced, then at most PREVIEW_POINTS code points. */
export const preview = (text: string) => plainLine(pathFree(plainLine(text, 4 * PREVIEW_POINTS)), PREVIEW_POINTS);
const name = (value: unknown, fallback: string) => plainLine(value, 40) || fallback;

/** Something to tell the person, before coalescing. */
export type NotifyItem =
  | { kind: 'mention' | 'reply' | 'message'; roomId: string; room: string | null; sender: string; text: string }
  | { kind: 'request'; roomId: string; room: string | null; name: string; agent: boolean }
  | { kind: 'agent'; roomId: string; room: string | null; agent: string; state: AgentAttention; reason?: string }
  | { kind: 'approval'; approval: 'identity' | 'bind-existing'; name: string };
export type AgentAttention = 'paused' | 'approval-wall' | 'halted' | 'failed' | 'untrusted';
/** What clicking an entry opens: the room in the localhost UI, the app's Review window, or the app's own window. */
export type NoticeTarget = { kind: 'room'; roomId: string } | { kind: 'review' } | { kind: 'app' };
/** One entry of the feed: the text of one native notification and where it leads. */
export type Notice = { seq: number; at: string; title: string; body: string; count: number; target: NoticeTarget };

const keyOf = (item: NotifyItem) => item.kind === 'agent' ? 'agents' : item.kind === 'approval' ? 'approvals' : `room:${item.roomId}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const roomName = (room: string | null) => name(room, 'a room');
const AGENT_WORDS: Record<AgentAttention, string> = { paused: 'paused', 'approval-wall': 'stopped for an approval', halted: 'halted', failed: 'could not start its session',
  untrusted: 'stopped waking: its binding was changed outside Meshrooms,' };

/** How many of each kind a bucket took. */
export type Counts = Partial<Record<NotifyItem['kind'], number>>;
/** The text of one entry for what a bucket held (its last few `items`, and `counts` of all): the item itself when it was one. */
export function compose(items: NotifyItem[], counts: Counts, total: number): Omit<Notice, 'seq' | 'at'> {
  const last = items.at(-1)!;
  if (last.kind === 'approval') {
    if (total === 1) return { title: 'Approval waiting', count: 1, target: { kind: 'app' }, body: last.approval === 'identity'
      ? `An agent asks for a new agent, ${name(last.name, 'unnamed')}. Approve or reject it in the Meshrooms app.`
      : `Binding ${name(last.name, 'an agent')} to an existing session waits for you in the Meshrooms app.` };
    return { title: plural(total, 'approval waiting', 'approvals waiting'), body: 'Approve or reject them in the Meshrooms app.', count: total, target: { kind: 'app' } };
  }
  if (last.kind === 'agent') {
    if (total === 1) {
      const reason = last.reason ? `: ${plainLine(pathFree(last.reason), PREVIEW_POINTS)}` : '.';
      return { title: `${name(last.agent, 'An agent')} needs attention`, body: `It ${AGENT_WORDS[last.state]} in ${roomName(last.room)}${reason}`, count: 1, target: { kind: 'review' } };
    }
    const names = [...new Set(items.flatMap(i => i.kind === 'agent' ? [name(i.agent, 'An agent')] : []))];
    return { title: `${plural(total, 'agent change needs', 'agent changes need')} attention`, body: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''}. Open Review to see them.`,
      count: total, target: { kind: 'review' } };
  }
  const roomId = last.roomId, title = name(last.room, 'Meshrooms');
  if (total === 1) {
    const text = last.kind === 'request' ? '' : preview(last.text);
    const body = last.kind === 'request' ? (last.agent ? `${name(last.name, 'An agent')}, an agent, is waiting to join.` : `${name(last.name, 'Someone')} asked to join.`)
      : last.kind === 'mention' ? (text ? `${name(last.sender, 'Someone')} mentioned you: ${text}` : `${name(last.sender, 'Someone')} mentioned you.`)
        : last.kind === 'reply' ? (text ? `${name(last.sender, 'Someone')} replied: ${text}` : `${name(last.sender, 'Someone')} replied with a file.`)
          : text ? `${name(last.sender, 'Someone')}: ${text}` : `${name(last.sender, 'Someone')} sent a file.`;
    return { title, body, count: 1, target: { kind: 'room', roomId } };
  }
  return { title, body: `${countsOf(counts, total)} in ${roomName(last.room)}`, count: total, target: { kind: 'room', roomId } };
}
/** "3 new mentions, 1 reply to you and 2 waiting to join", from the kinds a room's bucket counted. */
function countsOf(counts: Counts, total: number) {
  const parts = [counts.mention && plural(counts.mention, 'new mention', 'new mentions'), counts.reply && plural(counts.reply, 'reply to you', 'replies to you'),
    counts.message && plural(counts.message, 'new message', 'new messages'), counts.request && `${counts.request} waiting to join`].filter(Boolean) as string[];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? plural(total, 'update', 'updates');
}

/** Items a bucket keeps while it waits, to name who and what: the last few. Every item is counted. */
const HELD = 5;
/**
 * The feed: items come in, entries go out, coalesced per key and capped per minute (see the top of this file). Pure but
 * for the clock, so the rules are tested as they are. Entries are numbered in order; a cursor is `<epoch>.<seq>`, the
 * epoch new with every daemon, so a cursor from another one (or older than the entries kept) answers `reset: true`.
 */
export class Notifier {
  readonly epoch = randomUUID().slice(0, 8);
  private seq = 0;
  private kept: Notice[] = [];
  /** When each recent entry went out, for the cap. */
  private sent: number[] = [];
  private buckets = new Map<string, { last?: number; items: NotifyItem[]; counts: Counts; total: number }>();
  /** Long polls waiting for the next entry (the app's, one at a time; MAX_WAITERS at most). */
  private waiters = new Set<() => void>();
  constructor(private readonly now: () => number = Date.now) {}
  get cursor() { return `${this.epoch}.${this.seq}`; }
  add(item: NotifyItem) {
    const key = keyOf(item), bucket = this.buckets.get(key) ?? { items: [], counts: {}, total: 0 };
    bucket.items.push(item);
    if (bucket.items.length > HELD) bucket.items.shift();
    bucket.counts[item.kind] = (bucket.counts[item.kind] ?? 0) + 1;
    bucket.total++;
    this.buckets.set(key, bucket);
    this.flush();
  }
  /** Sends what may go now: a bucket whose last entry is COALESCE_MS old, while the minute's cap allows. The daemon calls it every second. */
  flush() {
    const now = this.now();
    this.sent = this.sent.filter(at => now - at < 60_000);
    const due: [string, { last?: number; items: NotifyItem[]; counts: Counts; total: number }][] = [];
    for (const [key, bucket] of this.buckets) {
      if (!bucket.total) { if (bucket.last === undefined || now - bucket.last >= COALESCE_MS) this.buckets.delete(key); continue; }
      if (bucket.last === undefined || now - bucket.last >= COALESCE_MS) due.push([key, bucket]);
    }
    // Under the cap, what never went out (or went out longest ago) goes first, so a busy room can't starve the others.
    due.sort(([, a], [, b]) => (a.last ?? -Infinity) - (b.last ?? -Infinity));
    for (const [key, bucket] of due) {
      if (this.sent.length >= CAP_PER_MINUTE) break;
      this.kept.push({ ...compose(bucket.items, bucket.counts, bucket.total), seq: ++this.seq, at: new Date(now).toISOString() });
      if (this.kept.length > KEPT_NOTICES) this.kept.splice(0, this.kept.length - KEPT_NOTICES);
      this.sent.push(now);
      this.buckets.set(key, { last: now, items: [], counts: {}, total: 0 });
    }
    if (due.length) for (const wake of [...this.waiters]) wake();
  }
  /**
   * `since`, waiting up to `waitMs` for an entry when there is none yet (a long poll, as the events feed has), so the app
   * asks about twice a minute instead of every few seconds. At most MAX_WAITERS wait at once; past that, 429.
   */
  async wait(after: string | null, waitMs: number, signal?: AbortSignal) {
    const first = this.since(after);
    if (first.notifications.length || 'reset' in first || after === null || after === '' || waitMs <= 0 || signal?.aborted) return first;
    if (this.waiters.size >= MAX_WAITERS) throw httpError(429, 'Too many notification requests are waiting.');
    await new Promise<void>(done => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(finish); signal?.removeEventListener('abort', finish); done(); };
      const timer = setTimeout(finish, waitMs);
      this.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
    return this.since(after);
  }
  get waiting() { return this.waiters.size; }
  /** Entries after `after` (at most 50); none for no cursor, with the cursor to start from. */
  since(after: string | null) {
    if (after === null || after === '') return { cursor: this.cursor, notifications: [] as Notice[] };
    const match = /^([a-f0-9]{8})\.(\d{1,15})$/.exec(after);
    if (!match) throw httpError(400, 'Use after with the cursor from an earlier answer.');
    const seq = Number(match[2]);
    if (match[1] !== this.epoch || seq > this.seq || (this.kept.length > 0 && seq < this.kept[0].seq - 1)) return { cursor: this.cursor, notifications: [] as Notice[], reset: true };
    const notifications = this.kept.filter(n => n.seq > seq).slice(0, 50);
    return { cursor: notifications.length ? `${this.epoch}.${notifications.at(-1)!.seq}` : after, notifications };
  }
}

/** The watcher's own words for a pause at an approval wall (agent-watch.ts), told apart from other pauses. */
const APPROVAL_WALL = /approval/i;
/** The daemon's words for a binding whose file changed after `watch` authorised it (agent-daemon.ts UNTRUSTED_OFF). */
const UNTRUSTED = /changed outside watch/i;
/**
 * Where the items come from: the local API's event feed (new messages, already diffed per room), each room's status as
 * the person device's runner keeps it (who waits to join), and the person's agents and approvals, read every few seconds.
 */
export class NotificationWatch {
  readonly notifier: Notifier;
  private requests = new Map<string, { stamp: string; seen: Set<string> }>();
  private agents?: Map<string, AgentAttention | ''>;
  private approvals = new Set<string>();
  private ticks = 0;
  constructor(private readonly home = personHome(), now: () => number = Date.now) { this.notifier = new Notifier(now); }

  /** A local API event: a new message may notify. */
  event(event: LocalEvent) {
    if (event.type !== 'message' || event.message.own) return;
    const listed = listedAgents(this.home).find(r => r.room.roomId === event.roomId);
    if (!listed || roomState(listed.agent).state !== 'joined') return;
    const level = notifyLevel(this.home, event.roomId);
    if (level === 'off') return;
    const { memberId, members, title } = listed.agent.members(), message = event.message;
    if (!memberId) return;
    const participants = members.map(m => ({ id: m.id, name: m.name, role: m.role ?? 'human' as const }));
    const mention = mentionedIds(message.text, participants).includes(memberId);
    const reply = !mention && !!message.replyTo && listed.agent.messages().find(m => m.packet.body.id === message.replyTo)?.packet.body.memberId === memberId;
    const kind = mention ? 'mention' as const : reply ? 'reply' as const : level === 'all' ? 'message' as const : undefined;
    if (kind) this.notifier.add({ kind, roomId: event.roomId, room: title ?? null, sender: message.author, text: message.text });
  }

  /** Once a second: who waits to join; every fifth, the agents and approvals; then whatever may go out. */
  poll() {
    try { this.waiting(); } catch { /* A room being written is read again next second. */ }
    if (this.ticks++ % 5 === 0) {
      try { this.agentStates(); } catch { /* Read again in a few seconds. */ }
      try { this.approvalsWaiting(); } catch { /* Read again in a few seconds. */ }
    }
    this.notifier.flush();
  }

  /** People and guests' agents waiting for the person, as host, in each room: each request once, when first seen. */
  private waiting() {
    const listed = listedAgents(this.home), ids = new Set(listed.map(r => r.room.roomId));
    for (const key of this.requests.keys()) if (!ids.has(key)) this.requests.delete(key);
    for (const { room, agent } of listed) {
      let stamp = ''; try { const s = statSync(join(agent.dir, PERSON_STATUS_FILE)); stamp = `${s.mtimeMs}:${s.size}`; } catch { /* None yet. */ }
      const known = this.requests.get(room.roomId);
      if (known?.stamp === stamp) continue;
      const status = personRoomStatus(agent), { memberId, title } = agent.members();
      const pending = memberId && status?.ownerId === memberId ? (status.requests ?? []).filter(r => r.state === 'pending' && (r.kind === 'person' || r.kind === 'agent')) : [];
      for (const request of pending) if (!known?.seen.has(request.id))
        this.notifier.add({ kind: 'request', roomId: room.roomId, room: title ?? status?.title ?? null, name: request.name, agent: request.kind === 'agent' });
      this.requests.set(room.roomId, { stamp, seen: new Set(pending.map(r => r.id)) });
    }
  }

  /**
   * The person's agents: one that newly needs attention (its watcher paused or halted it, or its new session failed)
   * notifies once. What stood at the daemon's start is the baseline: the app's start notice lists it.
   */
  private agentStates() {
    const next = new Map<string, AgentAttention | ''>();
    for (const identity of listIdentities(this.home)) for (const room of identity.rooms) {
      const b = room.binding;
      const state: AgentAttention | '' = b.state === 'failed' ? 'failed' : b.pausedInApp ? '' : b.wakes === 'halted' ? 'halted'
        : b.wakes === 'paused' ? (APPROVAL_WALL.test(b.why ?? '') ? 'approval-wall' : 'paused')
          : b.wakes === 'off' && UNTRUSTED.test(b.offReason ?? '') ? 'untrusted' : '';
      const key = `${identity.id}:${room.roomId}`;
      next.set(key, state);
      // What the watcher holds the wakes for is kept in the agent's record from the first time it is seen.
      const held = b.hold;
      if (held) void recordHold(this.home, identity.id, room.roomId, held).catch(() => { /* Tried again in a few seconds. */ });
      if (this.agents && state && this.agents.get(key) !== state)
        this.notifier.add({ kind: 'agent', roomId: room.roomId, room: room.title, agent: identity.name, state,
          ...(state === 'failed' ? (b.error ? { reason: b.error } : {}) : state === 'untrusted' ? {} : b.why ? { reason: b.why } : {}) });
    }
    this.agents = next;
  }

  /** Requests waiting for the person's approval in the app: each once, when first seen (also those waiting at the start). */
  private approvalsWaiting() {
    const waiting = readApprovals(this.home), names = new Map(readIdentities(this.home).map(i => [i.id, i.name]));
    for (const approval of waiting) if (!this.approvals.has(approval.id))
      this.notifier.add({ kind: 'approval', approval: approval.kind, name: approval.kind === 'identity' ? approval.name : names.get(approval.identityId) ?? '' });
    this.approvals = new Set(waiting.map(a => a.id));
  }
}
