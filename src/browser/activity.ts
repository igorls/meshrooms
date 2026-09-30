/**
 * Agent activity in browser rooms: whether an agent is waiting to be addressed (`idle`) or handling what woke it
 * (`working`). The bridge derives it from the agent's own `listen` calls and announces it to connected devices in an
 * unsigned envelope without a `body`, so browsers and bridges from before activity ignore it. It is shown, never
 * stored: nothing here reaches IndexedDB or the room service.
 */
export type ActivityState = 'idle' | 'working';
/** What woke a working agent: message ids and task ids from `listen`. */
export type ActivityOn = { messages?: string[]; tasks?: string[] };
/** The bridge's activity.json. Times are the agent machine's clock. */
export type Activity = { state: ActivityState; since: number; heartbeat: number; on?: ActivityOn; note?: string };
/** `at` is the sender's clock when sending, so receivers measure ages on that clock and skew between machines cancels out. */
export type ActivityPacket = { kind: 'activity'; roomId: string; at: number } & Activity;
/** A packet as a device received it, with its times moved onto this device's clock. */
export type ActivityRecord = Activity & { receivedAt: number };
/** What a roster shows. `online` is a connected agent that has not reported activity (a bridge from before it). */
export type AgentActivity =
  | { state: 'offline' } | { state: 'online' }
  | { state: 'idle'; since: number; note?: string; quiet?: number }
  | { state: 'working'; since: number; on: ActivityOn; note?: string; quiet?: number };

export const MAX_NOTE = 140;
const MAX_ON = 8;
/** `run` announces changes at once and repeats the current state this often. */
export const ACTIVITY_RESEND_MS = 30_000;
/** `listen` refreshes its heartbeat this often while it waits. */
export const LISTEN_HEARTBEAT_MS = 15_000;
/** No packet for this long, although the channel is open: the bridge stopped reporting. */
export const PACKET_STALE_MS = 90_000;
/** An idle agent that has not called `listen` for this long is not waiting any more (its harness may have stopped). */
export const IDLE_STALE_MS = 180_000;
/** A working agent that has not touched the bridge for this long is shown as busy without a recent check-in. */
export const WORKING_STALE_MS = 30 * 60_000;

const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) < 8_640_000_000_000_000;
// C0/C1 controls, line and paragraph separators, and bidi overrides: a note is one line of plain text.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
export const validNote = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= MAX_NOTE && !CONTROL.test(v);
const ids = (v: unknown) => v === undefined || (Array.isArray(v) && v.length >= 1 && v.length <= MAX_ON && v.every(uuid) && new Set(v).size === v.length);
const only = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export function validOn(on: unknown): on is ActivityOn {
  return !!on && typeof on === 'object' && !Array.isArray(on) && only(on, ['messages', 'tasks']) && ids((on as ActivityOn).messages) && ids((on as ActivityOn).tasks);
}
export function validActivity(a: unknown): a is Activity {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const v = a as Activity;
  return (v.state === 'idle' || v.state === 'working') && time(v.since) && time(v.heartbeat) && v.since <= v.heartbeat
    && (v.on === undefined || (v.state === 'working' && validOn(v.on))) && (v.note === undefined || validNote(v.note));
}
export function validActivityPacket(p: unknown, roomId: string): p is ActivityPacket {
  if (!validActivity(p)) return false;
  const v = p as ActivityPacket;
  return v.kind === 'activity' && v.roomId === roomId && time(v.at) && v.heartbeat <= v.at
    && only(v, ['kind', 'roomId', 'at', 'state', 'since', 'heartbeat', 'on', 'note']);
}
export const isActivityPacket = (p: unknown) => (p as { kind?: unknown })?.kind === 'activity';

/** The packet for an activity file, or undefined when the file is missing or damaged. Only known fields are sent. */
export function activityPacket(roomId: string, a: unknown, at = Date.now()): ActivityPacket | undefined {
  if (!validActivity(a)) return undefined;
  const packet: ActivityPacket = { kind: 'activity', roomId, at: Math.max(at, a.heartbeat), state: a.state, since: a.since, heartbeat: a.heartbeat,
    ...(a.state === 'working' && a.on ? { on: { ...(a.on.messages ? { messages: a.on.messages } : {}), ...(a.on.tasks ? { tasks: a.on.tasks } : {}) } } : {}),
    ...(a.note ? { note: a.note } : {}) };
  return validActivityPacket(packet, roomId) ? packet : undefined;
}
/** Moves a packet's times onto the receiver's clock. */
export function receiveActivity(p: ActivityPacket, now = Date.now()): ActivityRecord {
  const shift = now - p.at;
  return { state: p.state, since: p.since + shift, heartbeat: p.heartbeat + shift, ...(p.on ? { on: p.on } : {}), ...(p.note ? { note: p.note } : {}), receivedAt: now };
}

/**
 * What to show for an agent: offline without an open channel to one of its devices, `online` until its bridge
 * reports, otherwise the freshest report. `quiet` (ms since the agent last checked in) is set only once that is
 * unusual: an idle agent that stopped listening or whose bridge went silent, or a working agent quiet for 30 minutes.
 */
export function deriveActivity(records: (ActivityRecord | undefined)[], connected: boolean, now = Date.now()): AgentActivity {
  if (!connected) return { state: 'offline' };
  const record = records.filter((r): r is ActivityRecord => !!r).sort((a, b) => b.receivedAt - a.receivedAt)[0];
  if (!record) return { state: 'online' };
  const silent = now - record.receivedAt > PACKET_STALE_MS, quiet = Math.max(0, now - record.heartbeat);
  const note = record.note ? { note: record.note } : {};
  if (record.state === 'idle') return { state: 'idle', since: record.since, ...note, ...(silent || quiet > IDLE_STALE_MS ? { quiet } : {}) };
  return { state: 'working', since: record.since, on: record.on ?? {}, ...note, ...(quiet > WORKING_STALE_MS ? { quiet } : {}) };
}

/** "just now", "4 min", "2 h", "3 d". */
export function duration(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1440)} d`;
}
