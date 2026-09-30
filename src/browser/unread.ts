import { mentionedIds } from '../collab';
import type { BrowserMember } from './protocol';
import type { RoomStatus } from './protocol';
import { read, write, type Fence } from './storage';

/** The parts of a stored message that unread counting looks at. */
export type UnreadBody = { id: string; memberId: string; text: string; replyTo?: string };
/**
 * Someone waiting for this person, as the room's host, to admit them: a person, their own new device, or a guest's
 * agent. `name` is the requester's own text: shown as plain text only.
 */
export type Waiting = { id: string; name: string; kind: 'person' | 'companion' | 'agent' };
/** A room's badge: unread messages, how many are for this person and, in rooms they host, who is waiting to join. */
export type UnreadCount = { unread: number; mentions: number; waiting?: Waiting[] };
const MAX_WAITING = 16, MAX_NAME = 80, MAX_REQUEST_ID = 64;
/** Room ids as room links carry them. */
const ROOM_ID = /^[a-f0-9-]{36}$/;
/**
 * Who is waiting is live information: an owner republishes it at least every WAITING_REFRESH_MS while anyone waits,
 * and readers ignore a list older than WAITING_TTL_MS (its owner closed, or storage kept it across a restart).
 */
export const WAITING_REFRESH_MS = 5000, WAITING_TTL_MS = 15_000;
const KINDS = ['person', 'companion', 'agent'];
/**
 * How far this device has read a room: the id of the last message read, in arrival order (the order history is stored
 * in). No `id` means nothing has been read yet, so every message by others counts.
 */
export type ReadPosition = { id?: string; at: number };

const readKey = (deviceId: string, roomId: string) => `read:${deviceId}:${roomId}`;
export const loadReadPosition = (deviceId: string, roomId: string) => read<ReadPosition>(readKey(deviceId, roomId));
/** Fenced like the room's other records, so only the tab holding the room moves its position. */
export const saveReadPosition = (deviceId: string, roomId: string, id: string | undefined, fence?: Fence) => write(readKey(deviceId, roomId), { ...(id ? { id } : {}), at: Date.now() }, fence);

/**
 * The read position to use for a room: the stored one, or, on the first run with this feature, the newest stored
 * message, so history from before unread tracking isn't all counted as new. That baseline is saved.
 */
export async function readPosition(deviceId: string, roomId: string, bodies: Pick<UnreadBody, 'id'>[], fence?: Fence): Promise<ReadPosition> {
  const stored = await loadReadPosition(deviceId, roomId);
  if (stored) return stored;
  const baseline = bodies.at(-1)?.id;
  await saveReadPosition(deviceId, roomId, baseline, fence);
  return { ...(baseline ? { id: baseline } : {}), at: Date.now() };
}

/** Participants in the shape the shared mention helper expects. Members from before agents existed are people. */
const mentionable = (members: BrowserMember[]) => members.map(m => ({ id: m.id, name: m.name, role: m.role ?? 'human' as const }));

/** A message for this member: it @mentions them, or replies to one of their messages. Their own messages never are. */
export function mentionsMember(body: UnreadBody, memberId: string, participants: ReturnType<typeof mentionable>, authorOf: (messageId: string) => string | undefined) {
  if (body.memberId === memberId) return false;
  return mentionedIds(body.text, participants).includes(memberId) || (!!body.replyTo && authorOf(body.replyTo) === memberId);
}

/**
 * Messages by others after the read position, and how many of them are for this member. A position whose message
 * is no longer stored (the rolling window evicted it) means everything stored arrived after it, so all of it counts.
 */
export function countUnread(bodies: UnreadBody[], position: ReadPosition, memberId: string, members: BrowserMember[]): UnreadCount {
  let start = 0;
  if (position.id) for (let i = bodies.length - 1; i >= 0; i--) if (bodies[i].id === position.id) { start = i + 1; break; }
  const participants = mentionable(members);
  let authors: Map<string, string> | undefined;
  const authorOf = (id: string) => (authors ??= new Map(bodies.map(b => [b.id, b.memberId]))).get(id);
  let unread = 0, mentions = 0;
  for (let i = start; i < bodies.length; i++) {
    const body = bodies[i];
    if (body.memberId === memberId) continue;
    unread++;
    if (mentionsMember(body, memberId, participants, authorOf)) mentions++;
  }
  return { unread, mentions };
}

/** "3 unread, 1 mention", for screen readers; empty with nothing unread. */
export function unreadLabel(count: UnreadCount | undefined) {
  if (!count?.unread) return '';
  return `${count.unread} unread${count.mentions ? `, ${count.mentions} mention${count.mentions === 1 ? '' : 's'}` : ''}`;
}
/** "1 waiting to join", for screen readers; empty with nobody waiting. */
export const waitingLabel = (waiting: number) => waiting > 0 ? `${waiting} waiting to join` : '';
/** Badge text: the number, or 99+. */
export const badgeText = (unread: number) => unread > 99 ? '99+' : String(unread);

/**
 * Who is waiting to join a room this person hosts: room status lists pending requests to the host only. A companion
 * request confirmed by its owner carries that member's name; one still unconfirmed has only its placeholder.
 */
export function waitingOf(status: Pick<RoomStatus, 'requests' | 'members'> | undefined): Waiting[] {
  return (status?.requests || []).filter(r => r.state === 'pending').slice(0, MAX_WAITING).map(r => ({
    id: r.id, kind: r.kind,
    name: (r.kind === 'companion' ? status?.members?.find(m => m.id === r.linkedMemberId)?.name ?? '' : r.name).slice(0, MAX_NAME),
  }));
}
/** The in-app notice for a new request: the name is the requester's own text, so it's shown as text, never markup. */
export function joinNotice(request: Waiting, room: string) {
  if (request.kind === 'agent') return `${request.name || 'An agent'}, an agent, is waiting to join ${room}`;
  if (request.kind === 'companion') return `${request.name ? `${request.name}’s new device` : 'A new device'} is waiting to join ${room}`;
  return `${request.name || 'Someone'} asked to join ${room}`;
}
/**
 * Requests in other rooms this tab hasn't announced yet, newest room last; each is announced once (added to `seen`).
 */
export function freshRequests(counts: Record<string, UnreadCount>, seen: Set<string>, exclude: string, known: Set<string>) {
  const fresh: { roomId: string; request: Waiting }[] = [];
  for (const [roomId, count] of Object.entries(counts)) for (const request of count.waiting || []) {
    if (seen.has(request.id)) continue;
    // The room this tab shows lists its requests itself. A room not in this tab's list yet is announced once it is.
    if (roomId !== exclude && !known.has(roomId)) continue;
    seen.add(request.id);
    if (roomId !== exclude) fresh.push({ roomId, request });
  }
  return fresh;
}

/**
 * `(N) Room · Meshrooms`, N being what's unread in the person's other rooms. People waiting to join are spelled out,
 * `(3 · 1 waiting)`, not added to N: they need a different action (admitting), and their requests expire after ten
 * minutes, so they shouldn't read as three more messages.
 */
export function tabTitle(roomTitle: string, otherUnread: number, otherWaiting = 0) {
  const base = roomTitle ? `${roomTitle} · Meshrooms` : 'Meshrooms';
  const parts = [...(otherUnread > 0 ? [badgeText(otherUnread)] : []), ...(otherWaiting > 0 ? [`${otherWaiting} waiting`] : [])];
  return parts.length ? `(${parts.join(' · ')}) ${base}` : base;
}

/**
 * Counts are shared between this browser's tabs through localStorage, one key per device and room, written only by
 * the tab that holds the room's connection. Other tabs pick them up from the `storage` event.
 */
const COUNT_PREFIX = 'meshrooms:unread:', LOCAL_EVENT = 'meshrooms-counts';
const countKey = (deviceId: string, roomId: string) => `${COUNT_PREFIX}${deviceId}:${roomId}`;
function storage(): Storage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }
/** Record a room's count, or clear it (`undefined`) when nobody holds the room live any more. */
export function publishCount(deviceId: string, roomId: string, count: UnreadCount | undefined, now = Date.now()) {
  try {
    const store = storage(); if (!store) return;
    const key = countKey(deviceId, roomId);
    const entry = count && { unread: count.unread, mentions: count.mentions, ...(count.waiting?.length ? { waiting: count.waiting.slice(0, MAX_WAITING) } : {}) };
    let stored: (UnreadCount & { waitingAt?: number }) | null = null;
    try { stored = JSON.parse(store.getItem(key) || 'null'); } catch { /* Damaged: replaced below. */ }
    const same = !!entry && !!stored && JSON.stringify(entry) === JSON.stringify({ unread: stored.unread, mentions: stored.mentions, ...(stored.waiting ? { waiting: stored.waiting } : {}) });
    // Unchanged: written again only to keep a waiting list fresh.
    if ((same && !(entry.waiting && now - (stored?.waitingAt ?? 0) >= WAITING_REFRESH_MS)) || (!entry && !store.getItem(key))) return;
    if (entry) store.setItem(key, JSON.stringify(entry.waiting ? { ...entry, waitingAt: now } : entry)); else store.removeItem(key);
    // Other tabs hear of it through the storage event; this one through its own.
    dispatchEvent(new Event(LOCAL_EVENT));
  } catch { /* Storage unavailable, or a damaged entry that the next write replaces. */ }
}
/** This tab stops holding a room (it closes or moves on): whoever holds it next says who is waiting. */
export function clearWaiting(deviceId: string, roomId: string) {
  const count = publishedCounts(deviceId)[roomId];
  if (count?.waiting) publishCount(deviceId, roomId, { unread: count.unread, mentions: count.mentions });
}
/** Every published count for this device, by room. */
export function publishedCounts(deviceId: string, now = Date.now()): Record<string, UnreadCount> {
  const counts: Record<string, UnreadCount> = {};
  try {
    const store = storage(); if (!store) return counts;
    const prefix = `${COUNT_PREFIX}${deviceId}:`;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      // Only room ids shaped like the ones in room links: the badge's link is built from it.
      if (!key?.startsWith(prefix) || !ROOM_ID.test(key.slice(prefix.length))) continue;
      try {
        const value = JSON.parse(store.getItem(key) || 'null') as (UnreadCount & { waitingAt?: unknown }) | null;
        if (!value || !Number.isSafeInteger(value.unread) || !Number.isSafeInteger(value.mentions)) continue;
        const live = typeof value.waitingAt === 'number' && now - value.waitingAt <= WAITING_TTL_MS;
        const waiting = (live && Array.isArray(value.waiting) ? value.waiting : [])
          .filter(w => typeof w?.id === 'string' && w.id.length > 0 && w.id.length <= MAX_REQUEST_ID && typeof w.name === 'string' && KINDS.includes(w.kind))
          .slice(0, MAX_WAITING).map(w => ({ id: w.id, name: w.name.slice(0, MAX_NAME), kind: w.kind }));
        counts[key.slice(prefix.length)] = { unread: value.unread, mentions: value.mentions, ...(waiting.length ? { waiting } : {}) };
      } catch { /* A damaged entry: skipped, the others still count. */ }
    }
  } catch { /* Storage unavailable: nothing to show. */ }
  return counts;
}
/** Follow the counts other tabs publish. */
export function onCountsChanged(listener: () => void) {
  const handler = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(COUNT_PREFIX)) listener(); };
  addEventListener('storage', handler); addEventListener(LOCAL_EVENT, listener);
  return () => { removeEventListener('storage', handler); removeEventListener(LOCAL_EVENT, listener); };
}
