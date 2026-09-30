/**
 * Stored message history of one room on one device (browser or agent bridge). History is a rolling window: past
 * MAX_STORED_MESSAGES the oldest stored messages are evicted, except this device's own messages that a device still in
 * the room has not confirmed storing yet (the outbox). Only the newest MAX_PENDING_OUTBOX of those are protected, so the
 * window always has something to evict, incoming messages are always stored and receipted, and sending never stops.
 */
export const MAX_STORED_MESSAGES = 5000;
/**
 * Own unconfirmed messages protected from eviction. Older ones stay stored and are still sent, but become ordinary
 * history: a device that stays in the room without ever returning (a lost laptop, a cleared browser) can't pin the
 * window or block sending.
 */
export const MAX_PENDING_OUTBOX = 1000;

type Stored = { packet: { body: { id: string; deviceId: string } }; targets: string[]; receipts: string[] };

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

/** Keep at most `max` messages, evicting the oldest stored (arrival order) that are not protected. */
export function windowMessages<T extends Stored>(messages: T[], isProtected: (message: T) => boolean, max = MAX_STORED_MESSAGES): { kept: T[]; evicted: T[] } {
  if (messages.length <= max) return { kept: messages, evicted: [] };
  let excess = messages.length - max;
  const evicted: T[] = [];
  const kept = messages.filter(message => {
    if (excess > 0 && !isProtected(message)) { excess--; evicted.push(message); return false; }
    return true;
  });
  return { kept, evicted };
}
