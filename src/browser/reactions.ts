/** Signed reaction operations for browser rooms. Fixed emoji set; one per member per emoji per message. */
import { newestPerMember } from './markers';

export const REACTION_EMOJI = ['👍', '❤️', '😂', '👀', '🎉'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export type ReactionBody = {
  kind: 'reaction';
  roomId: string;
  id: string;
  deviceId: string;
  memberId: string;
  messageId: string;
  emoji: ReactionEmoji;
  /** Per-(messageId, memberId, emoji) counter the author increments. Device clocks never decide winners. */
  revision: number;
  at: number;
  removed?: true;
};

export type ReactionPacket = { body: ReactionBody; signature: string };

/** One visible chip: who reacted with this emoji on a message. */
export type ReactionChip = {
  messageId: string;
  emoji: ReactionEmoji;
  memberIds: string[];
};

const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const isDevice = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keyOf = (op: Pick<ReactionBody, 'messageId' | 'memberId' | 'emoji'>) => `${op.messageId}\0${op.memberId}\0${op.emoji}`;

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === 'string' && (REACTION_EMOJI as readonly string[]).includes(value);
}

export function validReactionBody(body: unknown, roomId: string): body is ReactionBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as ReactionBody;
  return b.kind === 'reaction'
    && b.roomId === roomId
    && isId(b.id)
    && isDevice(b.deviceId)
    && isId(b.memberId)
    && isId(b.messageId)
    && isReactionEmoji(b.emoji)
    && Number.isSafeInteger(b.revision) && b.revision >= 1 && b.revision <= 1_000_000
    && Number.isSafeInteger(b.at) && b.at > 0 && b.at <= 8_640_000_000_000_000 // the latest time a Date can hold
    && (b.removed === undefined || b.removed === true);
}

/** Revision first, then operation id. Device clocks never decide. */
function compare(a: ReactionBody, b: ReactionBody) {
  return a.revision - b.revision || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Latest op wins per (messageId, memberId, emoji). A later `removed` clears it. */
export function foldReactions(ops: ReactionBody[]): ReactionChip[] {
  const latest = new Map<string, ReactionBody>();
  for (const op of [...ops].sort(compare)) latest.set(keyOf(op), op);
  const chips = new Map<string, ReactionChip>();
  for (const op of latest.values()) {
    if (op.removed) continue;
    const key = `${op.messageId}\0${op.emoji}`;
    const chip = chips.get(key) || { messageId: op.messageId, emoji: op.emoji, memberIds: [] };
    chip.memberIds.push(op.memberId);
    chips.set(key, chip);
  }
  return [...chips.values()].map(chip => ({
    ...chip,
    memberIds: [...new Set(chip.memberIds)].sort(),
  })).sort((a, b) => a.messageId.localeCompare(b.messageId) || REACTION_EMOJI.indexOf(a.emoji) - REACTION_EMOJI.indexOf(b.emoji));
}

export function memberReacted(chips: ReactionChip[], messageId: string, emoji: ReactionEmoji, memberId: string) {
  return !!chips.find(c => c.messageId === messageId && c.emoji === emoji && c.memberIds.includes(memberId));
}

/** Highest revision this member has published for a message+emoji, or 0. */
export function currentRevision(ops: ReactionBody[], messageId: string, memberId: string, emoji: ReactionEmoji) {
  let revision = 0;
  for (const op of ops) {
    if (op.messageId === messageId && op.memberId === memberId && op.emoji === emoji && op.revision > revision) revision = op.revision;
  }
  return revision;
}

export const MAX_REACTION_OPS = 4000;
/** Reactions held back until their message arrives; bounded so signed reactions to unknown messages can't grow memory. */
export const MAX_PENDING_REACTIONS = 500, MAX_PENDING_PER_MEMBER = 50;
/**
 * Whether a reaction may wait for its message. Past the caps it is dropped, not stored; its holder sends it again at the
 * next exchange, by which time the message has usually arrived.
 */
export function mayHoldPending(pending: ReactionPacket[], op: ReactionPacket) {
  if (pending.length >= MAX_PENDING_REACTIONS) return false;
  return pending.filter(p => p.body.memberId === op.body.memberId).length < MAX_PENDING_PER_MEMBER;
}
export const COMPACT_REACTIONS_AT = 1000;
/** Soft bound so one member cannot fill the log with reactions to unknown messages. */
export const MAX_REACTION_KEYS_PER_MEMBER = 200;

export function liveKeysForMember(ops: ReactionBody[], memberId: string) {
  const latest = new Map<string, ReactionBody>();
  for (const op of [...ops].sort(compare)) {
    if (op.memberId !== memberId) continue;
    latest.set(keyOf(op), op);
  }
  return [...latest.values()].filter(op => !op.removed).length;
}

/**
 * The ops that keep each member to `cap` live reactions: each member keeps the newest `cap` they give (by the time of
 * the op that gives each, then id) and their older ones are forgotten whole, as compaction forgets old removals. The
 * rule depends only on the ops, never on arrival order or on which messages a device still holds, so devices holding
 * the same ops show the same reactions. Giving one more never fails; it lets the member's oldest reaction go.
 */
export function capReactions<T extends { body: ReactionBody }>(ops: T[], cap = MAX_REACTION_KEYS_PER_MEMBER): T[] {
  const latest = new Map<string, ReactionBody>();
  for (const op of [...ops].sort((a, b) => compare(a.body, b.body))) latest.set(keyOf(op.body), op.body);
  const byMember = new Map<string, ReactionBody[]>();
  for (const op of latest.values()) if (!op.removed) {
    const given = byMember.get(op.memberId);
    if (given) given.push(op); else byMember.set(op.memberId, [op]);
  }
  const dropped = new Set<string>();
  for (const given of byMember.values()) {
    if (given.length <= cap) continue;
    given.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const op of given.slice(cap)) dropped.add(keyOf(op));
  }
  return dropped.size ? ops.filter(op => !dropped.has(keyOf(op.body))) : ops;
}

/** Reactions each member may have taken back and still have remembered after compaction (see markers.ts). */
export const MAX_REMOVED_REACTIONS_PER_MEMBER = 200;

/**
 * Drop superseded ops so the log stays bounded while the folded chips stay the same, and forget each member's removals
 * past their newest `maxRemoved`: a forgotten removal leaves its reaction with no op at all, so it shows as not given.
 *
 * One case needs more than that. A device that has already forgotten a removal signs revision 1 when its member gives
 * that reaction again, which loses to the old removal on a device that still remembers it, so the reaction would show
 * on one device and not the others. When a removal is forgotten, the newest op of its member's own reaction signed
 * after it (by time) stands instead, if it is one that gives the reaction. Times decide only between one member's own
 * ops, and only once the removal is forgotten.
 */
export function compactReactions(ops: ReactionPacket[], maxRemoved = MAX_REMOVED_REACTIONS_PER_MEMBER): ReactionPacket[] {
  const byKey = new Map<string, ReactionPacket[]>();
  for (const op of [...ops].sort((a, b) => compare(a.body, b.body))) {
    const list = byKey.get(keyOf(op.body));
    if (list) list.push(op); else byKey.set(keyOf(op.body), [op]);
  }
  const markers = [...byKey.values()].map(list => list.at(-1)!.body).filter(op => op.removed);
  const remembered = newestPerMember(markers, maxRemoved);
  const kept: ReactionPacket[] = [];
  for (const list of byKey.values()) {
    const latest = list.at(-1)!;
    if (!latest.body.removed || remembered.has(latest.body.id)) { kept.push(latest); continue; }
    const after = list.filter(op => op.body.at > latest.body.at).at(-1);
    if (after && !after.body.removed) kept.push(after);
  }
  return kept.sort((a, b) => compare(a.body, b.body));
}

/** Data channel messages over 20,000 characters are dropped, so exchanged reactions are split well below that. */
export const REACTION_CHUNK_CHARS = 15_000;
export type ReactionSync = { kind: 'reactions'; roomId: string; ops: ReactionPacket[] };

/** Split the reactions log into sync envelopes that stay under the data channel limit (by size, like boards and decisions). */
export function reactionSyncChunks(roomId: string, ops: ReactionPacket[]): ReactionSync[] {
  const chunks: ReactionSync[] = []; let current: ReactionPacket[] = [], size = 0;
  for (const op of ops) {
    const length = JSON.stringify(op).length + 1;
    if (current.length && size + length > REACTION_CHUNK_CHARS) { chunks.push({ kind: 'reactions', roomId, ops: current }); current = []; size = 0; }
    current.push(op); size += length;
  }
  if (current.length) chunks.push({ kind: 'reactions', roomId, ops: current });
  return chunks;
}
