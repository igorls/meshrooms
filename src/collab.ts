import type { Message, Participant } from './room';
import { parseMarkdown, type Block, type Inline } from './markdown';

/**
 * Who wakes agents. `humans-first`: only people (an agent's message never wakes another agent). `people-and-agents`:
 * anyone's @mention or reply wakes the agent it names, within the loop guard (`loopGuard`), and a message that names
 * nobody wakes nobody. `open`: additionally, a person's message that names nobody wakes every agent.
 */
export type Floor = 'humans-first' | 'people-and-agents' | 'open';
export const FLOORS: Floor[] = ['humans-first', 'people-and-agents', 'open'];
/** What a room that records no floor reads as: rooms made before floors existed. */
export const DEFAULT_FLOOR: Floor = 'humans-first';
/**
 * What a browser room starts with: stored when the room is made, so rooms made before keep what they had. It becomes
 * `people-and-agents` once a bridge with the loop guard (#160) is on npm: older bridges let agents wake each other with no pause.
 */
export const NEW_ROOM_FLOOR: Floor = 'humans-first';

/** People and agents: agent-to-agent wakes along one reply chain with no person speaking in it, before the chain pauses. */
export const AGENT_CHAIN_LIMIT = 8;
/** People and agents: agent-to-agent wakes in the whole room with no person speaking anywhere, before the room pauses. */
export const AGENT_ROOM_LIMIT = 24;

/**
 * An agent's hold on a person's message that went to every agent (see `needsClaim`), as the room service settles it: the
 * first agent to claim it answers, and the others stay quiet. `until` is on the room service's clock; an answered claim
 * holds for good.
 */
export type Claim = { messageId: string; memberId: string; at: number; until: number; answered?: true };
/** How long a claim holds before its agent answers or claims again: long enough for real work, short enough to recover. */
export const CLAIM_TTL_MS = 10 * 60_000;

export type TaskStatus = 'todo' | 'doing' | 'done';
export const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];
export type Task = {
  id: string;
  title: string;
  notes: string;
  /** A linked GitHub issue or pull request (browser rooms). */
  issue?: string;
  status: TaskStatus;
  assigneeId?: string;
  /** Who set the current assignee, and the board revision at which it happened. */
  assignedBy?: string;
  assignedRevision?: number;
  /**
   * A done task: who moved it to done, when, and the board revision of that move (browser rooms). Later edits to its
   * notes or link leave this as it is, so they don't read as finishing it again.
   */
  finished?: { by: string; at: string; revision: number };
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  revision: number;
};

/** `@agents` addresses every agent in the room. */
export const AGENTS_MENTION = 'agents';
/** Nobody may be named `agents`: `@agents` must keep addressing every agent. */
export const reservedName = (name: string) => name.trim().toLowerCase() === AGENTS_MENTION;

const boundary = (char: string | undefined) => char === undefined || !/[\p{L}\p{N}_]/u.test(char);

/**
 * Scanned message texts that hold code, so rescanning a room's history doesn't parse each one again: room for one full
 * room (`MAX_STORED_MESSAGES`) of ordinary messages. Each read of the history makes new strings, so the keys are copies:
 * a character budget bounds the memory, and a room of very long code messages just parses again.
 */
const proseCache = new Map<string, string>();
const PROSE_CACHE_LIMIT = 6000, PROSE_CACHE_CHARS = 4_000_000;
let proseCacheChars = 0;

/**
 * The text a reader sees outside code, from the room's own renderer (`parseMarkdown`), so a mention counts exactly when
 * it shows as text: an `@Name` in a pasted log, command or snippet is quoted, not addressed. Code becomes a space, so
 * the words around it stay apart, and so do emphasis and links, whose markers stood where a name could start. Text with
 * no backtick or tilde fence can hold no code and is returned as it is.
 */
export function proseText(text: string): string {
  if (!text.includes('`') && !text.includes('~~~')) return text;
  const cached = proseCache.get(text);
  if (cached !== undefined) return cached;
  const out: string[] = [];
  const inline = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === 'text') out.push(node.text);
      else if (node.type === 'code') out.push(' ');
      else if (node.type === 'br') out.push('\n');
      else { out.push(' '); inline(node.children); out.push(' '); }
    }
  };
  const blocks = (list: Block[]) => {
    for (const block of list) {
      if (block.type === 'paragraph' || block.type === 'heading') inline(block.children);
      else if (block.type === 'list') block.items.forEach(item => { blocks(item); out.push('\n'); });
      else if (block.type === 'quote') blocks(block.children);
      else if (block.type === 'table') [block.header, ...block.rows].forEach(row => row.forEach(cell => { inline(cell); out.push('\n'); }));
      out.push('\n');
    }
  };
  blocks(parseMarkdown(text));
  const prose = out.join('');
  const size = text.length + prose.length;
  if (size > PROSE_CACHE_CHARS / 100) return prose;
  while (proseCache.size && (proseCache.size >= PROSE_CACHE_LIMIT || proseCacheChars + size > PROSE_CACHE_CHARS)) {
    const [oldText, oldProse] = proseCache.entries().next().value!;
    proseCache.delete(oldText); proseCacheChars -= oldText.length + oldProse.length;
  }
  proseCache.set(text, prose); proseCacheChars += size;
  return prose;
}

/**
 * Participants addressed by `@Name` in text, matched case-insensitively against the room roster. Longer names win, so
 * `@Codex CLI` does not also count as `@Codex` when both exist. Mentions inside code don't count. `broadcast: false`
 * leaves out the agents `@agents` names, keeping only those named one by one.
 */
export function mentionedIds(text: string, participants: Pick<Participant, 'id' | 'name' | 'role'>[], options: { broadcast?: boolean } = {}): string[] {
  if (!text.includes('@')) return [];
  const scan = proseText(text);
  const lower = scan.toLowerCase(); const taken = new Array<boolean>(scan.length).fill(false); const found = new Set<string>();
  // `@agents` comes first so the stable sort keeps it ahead of any participant with an equally long name. Without the
  // broadcast it still takes its place, so `@agents` never counts as a participant whose name starts with "agents".
  const names = [{ key: AGENTS_MENTION, ids: options.broadcast === false ? [] : participants.filter(p => p.role === 'agent').map(p => p.id) },
    ...participants.map(p => ({ key: p.name.toLowerCase(), ids: [p.id] }))].sort((a, b) => b.key.length - a.key.length);
  for (const { key, ids } of names) {
    let from = 0;
    while ((from = lower.indexOf(`@${key}`, from)) >= 0) {
      const end = from + key.length + 1;
      if (boundary(scan[from - 1]) && boundary(scan[end]) && !taken[from]) {
        for (let i = from; i < end; i++) taken[i] = true;
        ids.forEach(id => found.add(id));
      }
      from = end;
    }
  }
  return participants.map(p => p.id).filter(id => found.has(id));
}

/** Split text into plain and mention segments for display. */
export function mentionSegments(text: string, participants: Pick<Participant, 'id' | 'name' | 'role'>[]): { text: string; mention?: boolean }[] {
  if (!text.includes('@')) return [{ text }];
  const keys = [...new Set([...participants.map(p => p.name.toLowerCase()), AGENTS_MENTION])].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase(); const segments: { text: string; mention?: boolean }[] = []; let plain = 0; let i = 0;
  while ((i = lower.indexOf('@', i)) >= 0) {
    const key = boundary(text[i - 1]) ? keys.find(k => lower.startsWith(k, i + 1) && boundary(text[i + 1 + k.length])) : undefined;
    if (!key) { i++; continue; }
    if (i > plain) segments.push({ text: text.slice(plain, i) });
    segments.push({ text: text.slice(i, i + key.length + 1), mention: true });
    plain = i = i + key.length + 1;
  }
  if (plain < text.length) segments.push({ text: text.slice(plain) });
  return segments;
}

/**
 * `agentAssignmentsWake`: a host setting in browser rooms that lets an agent's assignment wake another agent. Names, when
 * the view carries them, let people-and-agents rooms tell an agent's `@Name` from its `@agents`.
 */
type RoomView = { floor?: Floor; messages: Message[]; participants: (Pick<Participant, 'id' | 'role' | 'operatorId' | 'wake'> & { name?: string })[]; tasks?: Task[]; agentAssignmentsWake?: boolean; claims?: Claim[] };

/** Where a people-and-agents room's agent-to-agent conversations stand. */
export type LoopGuard = {
  /** Agent messages in the room since a person last addressed an agent anywhere in it. */
  roomHops: number;
  roomPaused: boolean;
  /** Per reply chain, keyed by its root message id: agent messages since a person last wrote in that chain. */
  chains: Map<string, { hops: number; paused: boolean }>;
};
type Chain = { root: string; complete: boolean };
type GuardTrace = LoopGuard & { byId: Map<string, Message>; rootOf: Map<string, string>; incomplete: Set<string>; resolve: (id: string) => Chain; pausedBefore: Map<string, boolean>; participants: RoomView['participants']; count: number; lastId: string | undefined };
const guardTraces = new WeakMap<readonly Message[], GuardTrace>();

/** The agents a message addresses one by one: a reply's author, and `@Name`s (never `@agents`). */
function namedAddressees(room: RoomView, message: Message, byId: Map<string, Message>): string[] {
  // Without names, `@Name` can't be told from `@agents`, so only the reply counts.
  const named = room.participants.every(p => typeof p.name === 'string')
    ? mentionedIds(message.text, room.participants as Pick<Participant, 'id' | 'name' | 'role'>[], { broadcast: false })
    : [];
  const repliedTo = message.replyTo ? byId.get(message.replyTo)?.authorId : undefined;
  return [...new Set([...named, ...(repliedTo ? [repliedTo] : [])])].filter(id => id !== message.authorId);
}

/**
 * Walks the room once, in order, counting every message not written by a person on the roster. A person's message resets
 * its reply chain, and the room when it addresses an agent. Each message records whether its chain or the room was
 * already paused before it, so every device that holds the same messages reaches the same answer.
 */
function guardTrace(room: RoomView): GuardTrace {
  const cached = guardTraces.get(room.messages);
  // A caller that adds to the same array gets a fresh trace: the cache also checks its length and last message.
  if (cached && cached.participants === room.participants && cached.count === room.messages.length && cached.lastId === room.messages.at(-1)?.id) return cached;
  // Two devices can sign the same id: as `resolveMessageById` does, the canonical copy answers for it.
  const byId = new Map<string, Message>();
  for (const m of room.messages) { const held = byId.get(m.id); if (!held || (held.collidingCopy && !m.collidingCopy)) byId.set(m.id, m); }
  const rootOf = new Map<string, string>(), pausedBefore = new Map<string, boolean>(), incomplete = new Set<string>();
  // A message's chain, following `replyTo` through every message the device holds, wherever it sits in the array:
  // messages are stored as they arrive, so a reply can come before the message it answers. A chain that reaches a
  // message the device doesn't hold (not received yet, or past what it keeps), or loops, has an unknown beginning and
  // an unknown count; its root is the earliest message held.
  const resolved = new Map<string, Chain>();
  const resolve = (id: string): Chain => {
    const path: string[] = [], seen = new Set<string>();
    let cur = id, chain: Chain;
    for (;;) {
      const known = resolved.get(cur);
      if (known) { chain = known; break; }
      const m = byId.get(cur);
      if (!m) { chain = { root: path.at(-1) ?? cur, complete: false }; break; }
      if (seen.has(cur)) { chain = { root: cur, complete: false }; break; }
      seen.add(cur); path.push(cur);
      if (!m.replyTo) { chain = { root: cur, complete: true }; break; }
      cur = m.replyTo;
    }
    for (const step of path) resolved.set(step, chain);
    return chain;
  };
  const hops = new Map<string, number>(); let roomHops = 0;
  for (const m of room.messages) {
    const { root, complete } = resolve(m.id);
    if (!complete) incomplete.add(root);
    rootOf.set(m.id, root);
    // A colliding copy still counts below, but the canonical copy's record stands.
    if (byId.get(m.id) === m) pausedBefore.set(m.id, (hops.get(root) ?? 0) >= AGENT_CHAIN_LIMIT || roomHops >= AGENT_ROOM_LIMIT);
    // Only a person on the roster resets, by writing: their chain, and the room when they address an agent. A deleted
    // message of theirs resets nothing.
    if (roleOf(room, m.authorId) === 'human') {
      if (m.deleted) continue;
      hops.set(root, 0);
      if (addressesAnAgent(room, m, byId)) roomHops = 0;
      continue;
    }
    // Every other message counts, so deleting, leaving or renaming never gives an exchange more room: an agent's, deleted
    // or not, and one from a member no longer on the roster, who may have been an agent.
    hops.set(root, (hops.get(root) ?? 0) + 1); roomHops++;
  }
  const chains = new Map([...hops].map(([root, n]) => [root, { hops: n, paused: n >= AGENT_CHAIN_LIMIT }]));
  const trace = { roomHops, roomPaused: roomHops >= AGENT_ROOM_LIMIT, chains, byId, rootOf, incomplete, resolve, pausedBefore, participants: room.participants, count: room.messages.length, lastId: room.messages.at(-1)?.id };
  guardTraces.set(room.messages, trace);
  return trace;
}

/** A person's message that is for the agents: it mentions one (`@agents` included) or replies to one's message. */
function addressesAnAgent(room: RoomView, message: Message, byId: Map<string, Message>): boolean {
  if (message.mentions?.some(id => roleOf(room, id) === 'agent')) return true;
  return !!message.replyTo && roleOf(room, byId.get(message.replyTo)?.authorId) === 'agent';
}

/** The people-and-agents loop guard as it stands after the room's last message. */
export function loopGuard(room: RoomView): LoopGuard {
  const { roomHops, roomPaused, chains } = guardTrace(room);
  return { roomHops, roomPaused, chains };
}

/** The root of a message's reply chain, following `replyTo` back through the messages the room holds. */
export function chainRoot(room: RoomView, messageId: string): string {
  return guardTrace(room).rootOf.get(messageId) ?? messageId;
}

/**
 * Whether the loop guard keeps this agent message from waking agents: its chain or the room was paused before it, or its
 * chain starts at a message this device doesn't hold, so it can't be counted.
 */
function agentMessagePaused(room: RoomView, message: Message): boolean {
  const trace = guardTrace(room);
  const recorded = trace.pausedBefore.get(message.id);
  if (recorded !== undefined) return recorded || trace.incomplete.has(trace.rootOf.get(message.id)!);
  // Not in the room yet (a message arriving now): judged as if appended.
  const { root, complete } = message.replyTo ? trace.resolve(message.replyTo) : { root: message.id, complete: true };
  return !complete || trace.incomplete.has(root) || (trace.chains.get(root)?.hops ?? 0) >= AGENT_CHAIN_LIMIT || trace.roomPaused;
}

/**
 * Resolves a bare message ID using the first-seen canonical message, ignoring later cross-device ID collisions.
 */
export function resolveMessageById<T extends Pick<Message, 'id' | 'collidingCopy'>>(messages: readonly T[], id: string): T | undefined {
  return messages.find(m => m.id === id && !m.collidingCopy) ?? messages.find(m => m.id === id);
}

/**
 * Resolves an agent listen cursor (`<id>` or composite `<deviceId>:<id>` for colliding copies) to its index.
 * Bare IDs prefer the canonical first-seen message so a colliding copy can neither rewind nor skip messages.
 */
export function messageCursorIndex(messages: readonly Pick<Message, 'id' | 'deviceId' | 'collidingCopy'>[], after: string): number {
  const sep = after.indexOf(':');
  if (sep > 0) {
    const deviceId = after.slice(0, sep), id = after.slice(sep + 1);
    const exact = messages.findIndex(m => m.deviceId === deviceId && m.id === id);
    if (exact >= 0) return exact;
  }
  const canonical = messages.findIndex(m => m.id === after && !m.collidingCopy);
  return canonical >= 0 ? canonical : messages.findIndex(m => m.id === after);
}

/** Cursor string for the last message in a wake batch: bare `id` normally, or `<deviceId>:<id>` for a colliding copy. */
function cursorOf(message: Pick<Message, 'id' | 'deviceId' | 'collidingCopy'>): string {
  return message.collidingCopy && message.deviceId ? `${message.deviceId}:${message.id}` : message.id;
}

/** A message addresses a participant by mentioning them or by replying to one of their messages, on either floor. */
export function addresses(message: Message, participantId: string, messages: Message[]): boolean {
  if (message.authorId === participantId) return false;
  if (message.mentions?.includes(participantId)) return true;
  return !!message.replyTo && resolveMessageById(messages, message.replyTo)?.authorId === participantId;
}

const roleOf = (room: RoomView, id: string | undefined) => room.participants.find(p => p.id === id)?.role;
/**
 * An agent set to operator-only wakes solely for its operator; otherwise any person may wake it. The operator's
 * messages still follow `wakes`: a reply to someone else is for them, so it wakes the agent only if it names it.
 */
function mayWake(room: RoomView, agentId: string, authorId: string | undefined): boolean {
  const agent = room.participants.find(p => p.id === agentId);
  return agent?.wake !== 'operator' || (!!agent.operatorId && agent.operatorId === authorId);
}

/**
 * A person's message on an open floor that names nobody and replies to nothing: the open floor's broadcast. It wakes every
 * agent, and one of them answers: the first to claim it with the room service (`Claim`). To hear from every agent, a
 * person writes `@agents`, which is not a broadcast and needs no claim.
 */
export function needsClaim(room: Pick<RoomView, 'floor'>, message: Pick<Message, 'role' | 'mentions' | 'replyTo' | 'deleted'>): boolean {
  return (room.floor ?? DEFAULT_FLOOR) === 'open' && message.role === 'human' && !message.deleted && !message.mentions?.length && !message.replyTo;
}

/**
 * The agent answering a message, if one claimed it. A claim holds until it lapses, and an answered one for good once this
 * device holds the answer: the holder's reply to the message. Its word alone isn't enough, so an agent that marks a claim
 * answered without answering keeps the others quiet only until the claim lapses. `until` is on the room service's clock:
 * a device whose clock runs ahead sees a claim lapse early, which costs a wake, not a second answer (the runner asks the
 * room service before it signs one).
 */
export function claimHolder(room: Pick<RoomView, 'claims'> & { messages?: Message[] }, messageId: string, now = Date.now()): string | undefined {
  const claim = room.claims?.find(c => c.messageId === messageId);
  if (!claim) return undefined;
  if (claim.until > now) return claim.memberId;
  const answered = claim.answered && (!room.messages || room.messages.some(m => m.replyTo === messageId && m.authorId === claim.memberId && !m.deleted));
  return answered ? claim.memberId : undefined;
}

/**
 * Whether another agent has this message that went to every agent, so this one leaves it to them: it holds the claim, or
 * this device already holds another agent's reply to it, which stays true after the room service forgets the claim.
 */
export function heldByAnother(room: RoomView, message: Message, agentId: string, now = Date.now()): boolean {
  const by = takenBy(room, message, now);
  return !!by && by !== agentId;
}

/** Who has a message that went to every agent: the agent holding its claim, else the first agent whose reply this device holds. */
export function takenBy(room: RoomView, message: Message, now = Date.now()): string | undefined {
  if (!needsClaim(room, message)) return undefined;
  return claimHolder(room, message.id, now)
    ?? room.messages.find(m => m.replyTo === message.id && !m.deleted && roleOf(room, m.authorId) === 'agent')?.authorId;
}

/** Why an agent may not answer a message another agent claimed. */
export function claimRefusal(holder: string | undefined): string {
  return `${holder ?? 'Another agent'} is answering this message, so stay quiet: it went to every agent and one answers. You can still answer when someone names you or replies to you.`;
}

/**
 * Whether a message should wake an agent under the room's floor policy. Agents never wake themselves. A message addresses
 * the agents it mentions (`@agents` mentions them all) and the author of the message it replies to, on either floor.
 * On an open floor, a person's message that neither mentions anyone nor replies to anything addresses every agent until
 * one of them claims it, and then only that agent. A reply is never that broadcast, not even when the message it replies
 * to is gone from this snapshot: it was for that message's author, so it wakes nobody else. In people-and-agents rooms an agent's message wakes the agents it names one
 * by one or replies to (never through `@agents`), unless the loop guard has paused its chain or the room.
 */
export function wakes(room: RoomView, message: Message, agentId: string): boolean {
  if (message.deleted || message.authorId === agentId || !mayWake(room, agentId, message.authorId)) return false;
  const floor = room.floor ?? DEFAULT_FLOOR;
  if (needsClaim(room, message)) return !heldByAnother(room, message, agentId);
  if (message.role !== 'human' && floor === 'humans-first') return false;
  // With people and agents, only a person on the roster takes the person path: a member who left may have been an agent.
  if (floor === 'people-and-agents' && roleOf(room, message.authorId) !== 'human') {
    // A second message under an id another device already used can't be told apart in the guard's records, which hold
    // the first: it wakes no agent.
    if (message.collidingCopy || agentMessagePaused(room, message)) return false;
    return namedAddressees(room, message, guardTrace(room).byId).includes(agentId);
  }
  return addresses(message, agentId, room.messages);
}

/**
 * Whether something another member started, other than a message (a decision that asks agents), may wake this agent:
 * never itself, only its operator when it is operator-only, a person on any floor, and another agent only on an open
 * floor. An agent's decision never starts agent-to-agent work in people-and-agents rooms: it would wake every agent it
 * asks at once, past the loop guard.
 */
export function authorWakes(room: RoomView, agentId: string, authorId: string): boolean {
  if (authorId === agentId || !mayWake(room, agentId, authorId)) return false;
  return (room.floor ?? DEFAULT_FLOOR) === 'open' || roleOf(room, authorId) === 'human';
}

/**
 * Whether an assignment should wake its agent: from a person, from anyone else in open rooms, and from another agent
 * when the room allows agents to hand work to each other (`agentAssignmentsWake`), which in people-and-agents rooms also
 * stops while the loop guard has paused the room.
 */
export function assignmentWakes(room: RoomView, task: Task, agentId: string): boolean {
  if (task.assigneeId !== agentId || task.status === 'done' || !task.assignedBy || task.assignedBy === agentId || !mayWake(room, agentId, task.assignedBy)) return false;
  const assigner = roleOf(room, task.assignedBy), floor = room.floor ?? DEFAULT_FLOOR;
  if (floor === 'open' || assigner === 'human') return true;
  return !!room.agentAssignmentsWake && assigner === 'agent' && (floor !== 'people-and-agents' || !guardTrace(room).roomPaused);
}

/**
 * An agent may speak when replying to a message that woke it, or while holding open work a person assigned. An open
 * floor lets agents speak freely, except one set to operator-only: it still speaks only on its operator's behalf. With
 * people and agents, an agent may also start a message that names another member one by one (`text`), which is how it
 * brings in another agent; `@agents` alone is not enough. On an open floor, an agent may not reply to a message that went
 * to every agent (`needsClaim`) while another agent has it (`heldByAnother`), unless `claimsAside`: the runner settles
 * that with the room service before it signs.
 */
export function mayAgentSpeak(room: RoomView, agentId: string, replyTo: string | undefined, text?: string, claimsAside = false): boolean {
  const operatorOnly = room.participants.find(p => p.id === agentId)?.wake === 'operator';
  const floor = room.floor ?? DEFAULT_FLOOR;
  const target = replyTo ? resolveMessageById(room.messages, replyTo) : undefined;
  // A message that went to every agent is answered by the one that claimed it.
  if (!claimsAside && target && heldByAnother(room, target, agentId)) return false;
  if (floor === 'open' && !operatorOnly) return true;
  if (target && wakes(room, target, agentId)) return true;
  if (floor === 'people-and-agents' && !operatorOnly && text !== undefined && room.participants.every(p => typeof p.name === 'string')
    && mentionedIds(text, room.participants as Pick<Participant, 'id' | 'name' | 'role'>[], { broadcast: false }).some(id => id !== agentId)) return true;
  return (room.tasks || []).some(task => assignmentWakes(room, task, agentId));
}

/** Why an agent may not send here, in the room's own terms. */
export function speakRefusal(floor: Floor | undefined): string {
  const f = floor ?? DEFAULT_FLOOR;
  if (f === 'open') return 'This agent wakes only for its operator: reply to a message of theirs that mentions you or replies to you.';
  return f === 'people-and-agents'
    ? 'This room lets people and agents address agents: reply to a message that mentions you or replies to you, or name the member you are talking to with @Name.'
    : 'This room is humans-first: agents speak only when a person addresses them. Reply to a message that mentions you or replies to you.';
}

export type WakeResult = {
  /** `history`: first read without a cursor. `addressed`: something needs this agent. `waiting`: only observed messages. */
  state: 'history' | 'addressed' | 'waiting';
  /** Every message after the cursor, including observed ones, so the agent has the conversation it was listening to. */
  messages: Message[];
  addressed: string[];
  tasks: Task[];
  cursor?: string;
  boardCursor?: number;
};

/**
 * Evaluate one snapshot for an agent. The message cursor only advances when the agent is woken,
 * so unaddressed messages accumulate as context rather than being consumed silently.
 */
export function evaluateWake(room: RoomView & { boardRevision?: number }, agentId: string, after: string | undefined, boardAfter: number | undefined): WakeResult {
  const index = after ? messageCursorIndex(room.messages, after) : -1;
  if (after && index < 0) throw new Error('The supplied cursor is not in this room. Read the room to establish a cursor.');
  const unseen = room.messages.slice(index + 1);
  const addressed = unseen.filter(m => wakes(room, m, agentId)).map(m => m.id);
  const tasks = boardAfter === undefined ? [] : (room.tasks || []).filter(t => (t.assignedRevision ?? 0) > boardAfter && assignmentWakes(room, t, agentId));
  const boardCursor = room.boardRevision ?? boardAfter;
  if (!after && unseen.length) return { state: 'history', messages: unseen, addressed, tasks, cursor: cursorOf(unseen.at(-1)!), boardCursor };
  if (addressed.length || tasks.length) return { state: 'addressed', messages: unseen, addressed, tasks, cursor: unseen.length ? cursorOf(unseen.at(-1)!) : after, boardCursor };
  return { state: 'waiting', messages: unseen, addressed: [], tasks: [], cursor: after, boardCursor: boardAfter };
}

/** Board filters: everyone's tasks, the viewer's, nobody's, or one member's (`member:<id>`). */
export type TaskFilter = 'all' | 'mine' | 'unassigned' | `member:${string}`;
export function matchesTaskFilter(task: Task, filter: TaskFilter, viewerId?: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'mine') return !!viewerId && task.assigneeId === viewerId;
  if (filter === 'unassigned') return !task.assigneeId;
  return task.assigneeId === filter.slice('member:'.length);
}
/** Tasks by status in board order, except finished work: newest first, since boards show only the latest of it. */
export function groupTasks(tasks: Task[], filter: TaskFilter = 'all', viewerId?: string): Record<TaskStatus, Task[]> {
  const groups: Record<TaskStatus, Task[]> = { todo: [], doing: [], done: [] };
  for (const task of tasks) if (matchesTaskFilter(task, filter, viewerId)) groups[task.status].push(task);
  groups.done.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return groups;
}
