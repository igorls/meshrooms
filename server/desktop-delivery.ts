/** Durable room-event handoff to an existing desktop chat. A receipt means accepted, never that the agent replied. */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ListenCursor } from './browser-agent';
import { DesktopError, deliverToDesktop, type DesktopEnvelope } from './codex-desktop';

export const DESKTOP_DELIVERY_FILE = 'desktop-delivery.json';
export const DESKTOP_PAYLOAD_LIMIT = 512 * 1024;
const RECORD_LIMIT = DESKTOP_PAYLOAD_LIMIT * 2 + 16_384;
export type DesktopDelivery = DesktopEnvelope & {
  version: 1; generation: string; roomId: string; before: string; cursor: ListenCursor;
  state: 'pending' | 'sending' | 'accepted' | 'uncertain'; turnId?: string; acceptedAt?: number; resolvedBy?: 'operator';
};
export type DeliveryStatus = { state: 'waiting' | 'pending' | 'accepted' | 'uncertain' | 'blocked'; id?: string; at: number; reason?: string; turnId?: string };
const invalid = () => new DesktopError('unsupported', 'The saved desktop delivery cannot be read safely. Its room work has not been discarded.');
export function readDesktopDelivery(dir: string): DesktopDelivery | undefined {
  const file = join(dir, DESKTOP_DELIVERY_FILE);
  if (!existsSync(file)) return;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECORD_LIMIT) throw invalid();
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
    if (d.version !== 1 || !['pending', 'sending', 'accepted', 'uncertain'].includes(d.state) ||
      ![d.id, d.threadId, d.roomId, d.generation, d.cwd, d.before, d.output].every(v => typeof v === 'string') ||
      !integer(d.createdAt) || !integer(d.cursor?.boardAfter) || !integer(d.cursor?.decisionsAfter) ||
      (d.cursor.after !== undefined && typeof d.cursor.after !== 'string')) throw invalid();
    return d;
  } catch (error) { if (error instanceof DesktopError) throw error; throw invalid(); }
}
export function saveDesktopDelivery(dir: string, delivery: DesktopDelivery) {
  if (Buffer.byteLength(delivery.output) > DESKTOP_PAYLOAD_LIMIT) throw new DesktopError('unsupported', 'This room event is too large for desktop delivery. Read the room manually before continuing.');
  const record = JSON.stringify(delivery);
  if (Buffer.byteLength(record) > RECORD_LIMIT) throw new DesktopError('unsupported', 'This desktop delivery record is too large. Pending room work is retained.');
  const draft = join(dir, `.desktop-delivery-${randomUUID()}.tmp`), target = join(dir, DESKTOP_DELIVERY_FILE);
  let fd: number | undefined;
  try {
    fd = openSync(draft, 'wx', 0o600); writeFileSync(fd, record); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(draft, target);
    if (process.platform !== 'win32') { const folder = openSync(dir, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); } }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(draft); } catch { /* Renamed already. */ }
  }
}

export type DeliveryDeps = {
  read(): DesktopDelivery | undefined;
  save(delivery: DesktopDelivery): void;
  cursor(): string;
  commit(cursor: ListenCursor, expected: string): void;
  /** Snapshot without consuming it; cursor is committed only after an acceptance was durably saved. */
  snapshot(id: string): Promise<{ output: string; cursor: ListenCursor } | undefined>;
  send(event: DesktopEnvelope, beforeSend: () => void): Promise<{ turnId: string }>;
  beforeSend(): void;
  current(): boolean;
  now(): number;
};
/** One handoff. Kept independent of the watcher clock so crash boundaries can be exercised explicitly. */
export async function desktopDeliveryStep(binding: { threadId: string; roomId: string; generation: string; cwd: string }, deps: DeliveryDeps): Promise<DeliveryStatus> {
  let delivery = deps.read();
  const status = (state: DeliveryStatus['state'], reason?: string): DeliveryStatus => ({ state, at: deps.now(), ...(delivery ? { id: delivery.id, ...(delivery.turnId ? { turnId: delivery.turnId } : {}) } : {}), ...(reason ? { reason } : {}) });
  if (delivery?.state === 'sending') {
    // A crash may have happened after submission. Never replay an unknown delivery automatically, even after rebind.
    delivery = { ...delivery, state: 'uncertain' }; deps.save(delivery);
  }
  if (delivery?.state === 'uncertain') return status('uncertain', 'Check the bound chat, then mark this delivery received or explicitly retry it in Agent apps.');
  if (delivery?.state === 'accepted') {
    // Recover a crash after the receipt was saved but before the cursor moved. A later reader's cursor is never rewound.
    if (deps.cursor() === delivery.before) deps.commit(delivery.cursor, delivery.before);
    delivery = undefined;
  }
  if (delivery && (delivery.threadId !== binding.threadId || delivery.generation !== binding.generation)) delivery = undefined;
  if (!delivery) {
    const id = randomUUID(), before = deps.cursor(), snapshot = await deps.snapshot(id);
    if (!snapshot) return status('waiting');
    if (!deps.current()) return status('waiting');
    delivery = { ...binding, ...snapshot, id, before, createdAt: deps.now(), version: 1, state: 'pending' };
    deps.save(delivery);
  }
  if (!deps.current()) return status('waiting');
  const sending = delivery;
  let accepted: { turnId: string };
  try {
    accepted = await deps.send(sending, () => {
      if (!deps.current()) throw new DesktopError('unavailable', 'This binding changed before delivery.');
      deps.beforeSend();
      sending.state = 'sending'; deps.save(sending);
    });
  } catch (error) {
    const uncertain = sending.state === 'sending';
    if (uncertain) { delivery = { ...sending, state: 'uncertain' }; deps.save(delivery); }
    if (!(error instanceof DesktopError)) throw error;
    return status(uncertain || error.kind === 'uncertain' ? 'uncertain' : error.kind === 'unavailable' ? 'pending' : 'blocked', error.message);
  }
  delivery = { ...sending, state: 'accepted', turnId: accepted.turnId, acceptedAt: deps.now() };
  deps.save(delivery); // Receipt BEFORE cursor. A failed write leaves sending on disk, which is uncertain on restart.
  if (deps.cursor() === delivery.before) deps.commit(delivery.cursor, delivery.before);
  return status('accepted');
}

/** Explicit operator recovery only. The watcher will commit or resend at its next check. */
export function resolveDesktopDelivery(dir: string, id: string, action: 'received' | 'retry') {
  const delivery = readDesktopDelivery(dir);
  if (!delivery || delivery.id !== id || !['uncertain', 'sending'].includes(delivery.state)) throw new Error('That delivery no longer needs a decision. Refresh Agent apps.');
  saveDesktopDelivery(dir, action === 'received' ? { ...delivery, state: 'accepted', acceptedAt: Date.now(), resolvedBy: 'operator' } : { ...delivery, state: 'pending' });
}
export const sendDesktopDelivery: DeliveryDeps['send'] = (event, beforeSend) => deliverToDesktop(event, beforeSend);
