/**
 * Signed message retractions for browser rooms (docs/flows/history-replication.md, "Reserved: retractions"). Only the
 * member who wrote a message can retract it, from any of their devices, current or former. A device that applies one
 * replaces the message with a stub that holds no content, in place, so read positions, cursors and replies still resolve.
 * The signed retraction stays in a log and is exchanged like reactions, so it reaches devices that were offline. None of
 * this can make anyone forget what they already saw, and the interface says so.
 *
 * `seq` from the reserved shape is left out until per-device sequence numbers exist (HIST-1).
 */

export type RetractBody = { kind: 'retract'; roomId: string; id: string; deviceId: string; memberId: string; at: number; target: string };
export type RetractPacket = { body: RetractBody; signature: string };
export type RetractionSync = { kind: 'retractions'; roomId: string; ops: RetractPacket[] };

/** A stored message of either store (browser or bridge). `retracted` sits beside the packet, so it is never signed. */
type Stored = {
  packet: { body: { kind: 'message'; roomId: string; id: string; deviceId: string; memberId: string; text: string; at: number; replyTo?: string; attachments?: { sha256: string }[] }; signature: string };
  targets: string[]; receipts: string[]; retracted?: true;
};

const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const isDevice = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validRetractBody(body: unknown, roomId: string): body is RetractBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as RetractBody;
  return b.kind === 'retract' && b.roomId === roomId && isId(b.id) && isDevice(b.deviceId) && isId(b.memberId) && isId(b.target)
    && Number.isSafeInteger(b.at) && b.at > 0 && b.at <= 8_640_000_000_000_000;
}

/**
 * Whether this retraction may remove this message. The member id is compared, not the device, so a person's later
 * device can retract. The caller has already checked the signature against a device of `op.memberId`.
 */
export function mayRetract(op: RetractBody, message: Stored['packet']['body']) {
  return op.target === message.id && op.roomId === message.roomId && op.memberId === message.memberId;
}

export const isRetracted = (message: { retracted?: true }) => message.retracted === true;

/**
 * The message with its content gone: text, attachments and signature. A stub is never sent, so its empty signature is
 * never checked, and with no targets it no longer holds back the window or waits for receipts.
 */
export function retractedStub<T extends Stored>(message: T): T & { retracted: true } {
  const { attachments: _attachments, ...body } = message.packet.body;
  return { ...message, packet: { body: { ...body, text: '' }, signature: '' }, targets: [], receipts: [], retracted: true };
}

/**
 * Apply the log to stored messages. It doesn't matter which arrived first, and running it again changes nothing.
 * `released` names the files only retracted messages referred to, for the caller to delete.
 */
export function applyRetractions<T extends Stored>(messages: T[], ops: RetractBody[]): { messages: T[]; changed: string[]; released: string[] } {
  const byTarget = new Map<string, RetractBody[]>();
  for (const op of ops) byTarget.set(op.target, [...byTarget.get(op.target) ?? [], op]);
  const changed: string[] = [], files = new Set<string>();
  const next = messages.map(message => {
    const body = message.packet.body;
    if (isRetracted(message) || !byTarget.get(body.id)?.some(op => mayRetract(op, body))) return message;
    changed.push(body.id);
    for (const ref of body.attachments ?? []) files.add(ref.sha256);
    return retractedStub(message);
  });
  for (const message of next) for (const ref of message.packet.body.attachments ?? []) files.delete(ref.sha256);
  return { messages: changed.length ? next : messages, changed, released: [...files] };
}

/** Above MAX_STORED_MESSAGES, so every stub a device holds can keep its retraction. */
export const MAX_RETRACTIONS = 6000;
/** Retractions of messages this device doesn't hold can't be checked yet, so each member may only park this many. */
export const MAX_UNRESOLVED_PER_MEMBER = 200;

/**
 * The log with `incoming` added. Duplicates are skipped, as is one aimed at a held message its author didn't write. Past
 * the unresolved cap a retraction is dropped, and its holder sends it again at the next exchange. Past MAX_RETRACTIONS
 * the oldest whose message this device no longer holds make room, so deleting never fails. A retraction of a held
 * message is never dropped: stubs aren't sent, so it is what tells a device that was offline to remove the message.
 */
export function addRetractions<T extends Pick<RetractPacket, 'body'>>(log: T[], incoming: T[], messages: Pick<Stored, 'packet'>[], max = MAX_RETRACTIONS): { log: T[]; added: T[] } {
  const held = new Map(messages.map(m => [m.packet.body.id, m.packet.body]));
  const ids = new Set(log.map(op => op.body.id)), targets = new Set(log.map(op => `${op.body.memberId}\0${op.body.target}`));
  const unresolved = new Map<string, number>();
  for (const { body } of log) if (!held.has(body.target)) unresolved.set(body.memberId, (unresolved.get(body.memberId) ?? 0) + 1);
  const added: T[] = [];
  for (const op of incoming) {
    const { body } = op, key = `${body.memberId}\0${body.target}`, message = held.get(body.target);
    if (ids.has(body.id) || targets.has(key)) continue;
    if (message ? !mayRetract(body, message) : (unresolved.get(body.memberId) ?? 0) >= MAX_UNRESOLVED_PER_MEMBER) continue;
    if (!message) unresolved.set(body.memberId, (unresolved.get(body.memberId) ?? 0) + 1);
    ids.add(body.id); targets.add(key); added.push(op);
  }
  if (!added.length) return { log, added };
  let excess = log.length + added.length - max;
  return { log: [...log, ...added].filter(({ body }) => held.has(body.target) || excess-- <= 0), added };
}

/** Data channel messages over 20,000 characters are dropped, so exchanged retractions are split well below that. */
export const RETRACTION_CHUNK_CHARS = 15_000;

export function retractionSyncChunks(roomId: string, ops: RetractPacket[]): RetractionSync[] {
  const chunks: RetractionSync[] = []; let current: RetractPacket[] = [], size = 0;
  for (const op of ops) {
    const length = JSON.stringify(op).length + 1;
    if (current.length && size + length > RETRACTION_CHUNK_CHARS) { chunks.push({ kind: 'retractions', roomId, ops: current }); current = []; size = 0; }
    current.push(op); size += length;
  }
  if (current.length) chunks.push({ kind: 'retractions', roomId, ops: current });
  return chunks;
}
