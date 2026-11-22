/**
 * Stored message history of one room on one device (browser or agent bridge). History is a rolling window: past
 * MAX_STORED_MESSAGES the oldest stored messages are evicted (a member's own first, while they fill more than half the
 * window), except this device's own messages that a device still in the room has not confirmed storing yet (the outbox). Only the newest MAX_PENDING_OUTBOX of those are protected, so the
 * window always has something to evict, incoming messages are always stored and receipted, and sending never stops.
 */
export const MAX_STORED_MESSAGES = 5000;
/**
 * Own unconfirmed messages protected from eviction. Older ones stay stored and are still sent, but become ordinary
 * history: a device that stays in the room without ever returning (a lost laptop, a cleared browser) can't pin the
 * window or block sending.
 */
export const MAX_PENDING_OUTBOX = 1000;

type Stored = { packet: { body: { id: string; deviceId: string; memberId?: string } }; targets: string[]; receipts: string[] };
/** Who a stored message counts against: its member, or its device where a record names no member. */
const author = (message: Stored) => message.packet.body.memberId ?? message.packet.body.deviceId;

/**
 * Whether this is one of `self`'s messages that a device in the room has not confirmed yet. Targets that have left the
 * room (not in `devices`) no longer hold a message back; with no device list yet, every target counts.
 */
export function awaitingDelivery(message: Stored, self: string, devices?: ReadonlySet<string>) {
  return message.packet.body.deviceId === self && message.targets.some(t => !message.receipts.includes(t) && (!devices || devices.has(t)));
}

/** The rolling window with the newest `outbox` of this device's unconfirmed messages protected (see MAX_PENDING_OUTBOX). */
export function windowHistory<T extends Stored>(messages: T[], awaiting: (message: T) => boolean, max = MAX_STORED_MESSAGES, outbox = MAX_PENDING_OUTBOX) {
  const kept = new Set(messages.filter(awaiting).slice(-outbox));
  return windowMessages(messages, message => kept.has(message), max);
}

/**
 * Keep at most `max` messages, evicting the oldest stored (arrival order) that are not protected. While one member's
 * messages fill more than half the window, that member's oldest go first: otherwise one member sending as fast as the
 * quota allows would push everyone else's history out of every device in under two hours. In a room where nobody holds
 * more than half, this is plain oldest-first.
 */
export function windowMessages<T extends Stored>(messages: T[], isProtected: (message: T) => boolean, max = MAX_STORED_MESSAGES): { kept: T[]; evicted: T[] } {
  if (messages.length <= max) return { kept: messages, evicted: [] };
  const counts = new Map<string, number>();
  for (const message of messages) counts.set(author(message), (counts.get(author(message)) ?? 0) + 1);
  const half = max / 2, gone = new Set<T>();
  // First the oldest of whoever holds more than half, down to half or until enough are gone.
  let excess = messages.length - max;
  for (const message of messages) {
    if (excess <= 0) break;
    const held = counts.get(author(message))!;
    if (held <= half || isProtected(message)) continue;
    counts.set(author(message), held - 1); gone.add(message); excess--;
  }
  // Then the oldest of what is left.
  for (const message of messages) {
    if (excess <= 0) break;
    if (gone.has(message) || isProtected(message)) continue;
    gone.add(message); excess--;
  }
  return { kept: messages.filter(message => !gone.has(message)), evicted: messages.filter(message => gone.has(message)) };
}
