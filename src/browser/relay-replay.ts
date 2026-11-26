/**
 * Receiver-side replay protection for relay envelopes.
 *
 * A sender signs every envelope (`sig`), so a replay can only re-deliver an envelope that sender really produced.
 * A hostile relay (or a member holding a stored copy) can still re-send it later, so receivers remember which
 * `(sender, envelope id)` pairs they already processed and drop the repeat. The record is bounded and persisted
 * wherever the receiver keeps its own state (IndexedDB, agent directory, or sealed agent state).
 *
 * A sender that rebuilds an unaccepted frame after a transport fallback re-uses the envelope id, so a second copy of
 * the same id is the same logical frame and is dropped here as a duplicate.
 */
export const RELAY_REPLAY_MAX_TOTAL = 1024;
export const RELAY_REPLAY_MAX_PER_SENDER = 256;

export type RelayReplayRecord = { v: 1; senders: Record<string, string[]> };

const ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

export class RelayReplayGuard {
  /** Insertion-ordered ids per sender, oldest first. */
  private senders = new Map<string, string[]>();
  private sets = new Map<string, Set<string>>();
  private total = 0;
  private revision = 0;

  constructor(private readonly maxTotal = RELAY_REPLAY_MAX_TOTAL, private readonly maxPerSender = RELAY_REPLAY_MAX_PER_SENDER) {}

  /** True when this exact sender + envelope id was already processed. */
  seen(sender: string, id: string): boolean {
    return this.sets.get(sender)?.has(id) === true;
  }

  /** Records a processed envelope id; returns false when it was already known. */
  add(sender: string, id: string): boolean {
    if (!sender || !ID_PATTERN.test(id)) return false;
    let set = this.sets.get(sender);
    let list = this.senders.get(sender);
    if (!set || !list) { set = new Set(); list = []; this.sets.set(sender, set); this.senders.set(sender, list); }
    if (set.has(id)) return false;
    set.add(id); list.push(id); this.total++; this.revision++;
    while (list.length > this.maxPerSender) { set.delete(list.shift()!); this.total--; }
    // Over the global cap: evict the oldest ids of the fullest sender, so one chatty sender cannot flush the others.
    while (this.total > this.maxTotal) {
      let fullest: string | undefined;
      for (const [key, entries] of this.senders) if (!fullest || entries.length > this.senders.get(fullest)!.length) fullest = key;
      if (!fullest) break;
      const entries = this.senders.get(fullest)!;
      this.sets.get(fullest)!.delete(entries.shift()!); this.total--;
      if (!entries.length) { this.senders.delete(fullest); this.sets.delete(fullest); }
    }
    return true;
  }

  /** Changes whenever the record changes, so callers can skip redundant writes. */
  get version() { return this.revision; }
  get size() { return this.total; }

  export(): RelayReplayRecord {
    return { v: 1, senders: Object.fromEntries([...this.senders].map(([k, v]) => [k, [...v]])) };
  }

  /** Loads a persisted record, ignoring anything malformed or over the caps. */
  static from(value: unknown, maxTotal = RELAY_REPLAY_MAX_TOTAL, maxPerSender = RELAY_REPLAY_MAX_PER_SENDER): RelayReplayGuard {
    const guard = new RelayReplayGuard(maxTotal, maxPerSender);
    if (!value || typeof value !== 'object' || (value as RelayReplayRecord).v !== 1) return guard;
    const senders = (value as RelayReplayRecord).senders;
    if (!senders || typeof senders !== 'object') return guard;
    for (const [sender, ids] of Object.entries(senders)) {
      if (!Array.isArray(ids) || sender.length > 128) continue;
      for (const id of ids) if (typeof id === 'string') guard.add(sender, id);
    }
    guard.revision = 0;
    return guard;
  }
}
