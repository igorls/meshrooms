/**
 * Browser-room agent bridge (stage 1).
 *
 * Lets a local agent take part in a hosted browser room (meshrooms-browser-v1) as its
 * own device: a P-256 identity kept on this machine, WebRTC data channels via werift,
 * and signed packets exactly like a browser. `listen` and `send` apply the same
 * humans-first rules as local rooms (src/collab.ts), so agents behave identically.
 *
 * State lives in a private directory (identity, messages, task operations, outbox, files).
 * `run` is the only process that talks to peers; `listen` reads its state, `send`/`task`/`react`
 * queue outgoing messages and changes that `run` signs and delivers, and `attachment`
 * asks `run` (through wants/) to fetch a file it does not hold yet. The agent's commands also
 * record its activity (activity.json), which `run` announces to connected devices.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { browserProtocol, type BrowserDevice, type Command, type RoomStatus } from '../src/browser/protocol';
import { COMPACT_AT, compactBoard, foldBoard, MAX_TASK_OPS, syncChunks, taskBody, validTaskBody, type BoardSync, type TaskChange, type TaskPacket } from '../src/browser/board';
import {
  FileTransfers, IMAGE_TYPES, MAX_ATTACHMENT_BYTES, displayKind, MAX_MESSAGE_ATTACHMENTS, attachmentRef, attachmentText, isFilePacket, isSha256, retainedFiles, shownText,
  validAttachments, type AttachmentRef, type FileStore, type TransferState,
} from '../src/browser/files';
import { cleanName, defaultName, sniff } from '../src/attachments';
import { admissible, castVote, COMPACT_DECISIONS_AT, compactDecisions, decisionChunks, decisionWakes, due, foldDecisions, MAX_DECISION_OPS, nextVoteRevision, openDecision, reviseDecision, validDecisionBody, validVoteBody,
  type Decision, type DecisionBody, type DecisionMode, type DecisionPacket, type DecisionSync, type VoteBody } from '../src/browser/decisions';
import { ACTIVITY_RESEND_MS, LISTEN_HEARTBEAT_MS, activityPacket, isActivityPacket, validActivity, validNote, type Activity, type ActivityOn } from '../src/browser/activity';
import {
  COMPACT_REACTIONS_AT, MAX_REACTION_KEYS_PER_MEMBER, MAX_REACTION_OPS, REACTION_EMOJI, compactReactions, currentRevision,
  foldReactions, isReactionEmoji, liveKeysForMember, memberReacted, reactionSyncChunks, validReactionBody,
  type ReactionBody, type ReactionEmoji, type ReactionPacket,
} from '../src/browser/reactions';
import { evaluateWake, mayAgentSpeak, mentionedIds, type Floor, type Task } from '../src/collab';
import type { Message, Participant } from '../src/room';

type Identity = { id: string; publicKey: string; privateJwk: JsonWebKey };
type MessageBody = { kind: 'message'; roomId: string; id: string; deviceId: string; memberId: string; text: string; at: number; replyTo?: string; attachments?: AttachmentRef[] };
type ReceiptBody = { kind: 'receipt'; roomId: string; id: string; deviceId: string };
type Packet = { body: MessageBody | ReceiptBody | ReactionBody; signature: string };
type Stored = { packet: { body: MessageBody; signature: string }; targets: string[]; receipts: string[] };
type Members = { memberId?: string; ownerId?: string; former?: { id: string; role?: 'human' | 'agent' }[]; members: { id: string; name: string; role?: 'human' | 'agent'; operatorId?: string; harness?: string; model?: string }[]; devices: { id: string; memberId: string }[] };
/** A queued task change; `run` applies it to the board as it stands when signing, so the revision is current. */
type TaskIntent = { type: 'task'; id: string; taskId: string; change: TaskChange; removed?: boolean };
/** A queued reaction toggle; `run` signs it against the current folded chips and revision. */
type ReactionIntent = { type: 'reaction'; id: string; messageId: string; emoji: ReactionEmoji; blocked?: 'log-full' };
/** A queued decision change; like tasks, `run` builds it against the decision as it stands when signing. */
type DecisionIntent = { type: 'decision'; id: string; decisionId: string } & (
  | { action: 'open'; question: string; context: string; mode: DecisionMode; options: string[]; askAgents: boolean | string[]; closesAt: number | null }
  | { action: 'vote'; optionId: string | null; comment: string }
  | { action: 'option'; label: string } | { action: 'close' } | { action: 'withdraw' });
type StoredDecisionOp = DecisionPacket & { seq: number };
/** A stored task operation and the board cursor at which it arrived. */
type StoredOp = TaskPacket & { seq: number };
type Peer = { pc: RTCPeerConnection; session: string; channel?: RTCDataChannel; started: number };

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path);
}
function readJson<T>(path: string, fallback: T): T { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Files younger than this are never evicted: `send` stores them before `run` signs the message naming them. */
const FILE_GRACE_MS = 10 * 60_000;

export function parseRoomUrl(url: string) {
  const parsed = new URL(url);
  const match = /^\/r\/([a-f0-9-]{36})$/.exec(parsed.pathname);
  if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Use the HTTPS room link.');
  if (!match) throw new Error('Use a browser room link like https://host/r/<room id>.');
  return { origin: parsed.origin, roomId: match[1] };
}

/** An agent connect link made by a person in the room: https://host/agent/<room>#<one-time token>. */
export function parseConnectLink(link: string) {
  const url = new URL(link);
  const match = /^\/agent\/([a-f0-9-]{36})$/.exec(url.pathname);
  const token = url.hash.slice(1);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Use the HTTPS connect link.');
  if (!match || !/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw new Error('This is not a Meshrooms agent connect link (https://host/agent/<room>#<token>).');
  return { origin: url.origin, roomId: match[1], token };
}

/** One agent's membership in one browser room. */
export class BrowserAgent {
  readonly dir: string;
  private identity?: Identity;
  private key?: CryptoKey;
  constructor(dataDir: string, readonly origin: string, readonly roomId: string) {
    this.dir = resolve(dataDir, 'browser-agents', roomId);
    for (const sub of ['outbox', 'files', 'wants']) mkdirSync(join(this.dir, sub), { recursive: true, mode: 0o700 });
  }
  private path(name: string) { return join(this.dir, name); }
  /** Content-addressed files: <dir>/files/<sha256>. Every read re-hashes, so a damaged file is never served or returned. */
  readonly files: FileStore & { path: (sha: string) => string; add: (bytes: Uint8Array) => string } = {
    path: sha => this.path(join('files', sha)),
    has: sha => isSha256(sha) && existsSync(this.files.path(sha)),
    get: async sha => {
      if (!this.files.has(sha)) return undefined;
      const bytes = new Uint8Array(readFileSync(this.files.path(sha)));
      if (sha256(bytes) === sha) return bytes;
      try { unlinkSync(this.files.path(sha)); } catch { /* Already gone. */ }
      return undefined;
    },
    // Only verified bytes arrive here, so they always replace whatever is on disk (a damaged copy would block them otherwise).
    put: async (_sha, bytes) => { this.files.add(bytes); },
    add: bytes => {
      const sha = sha256(bytes), path = this.files.path(sha), temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, path); return sha;
    },
  };
  /** Metadata of a file named by a stored (verified) message, by attachment id or hash. */
  attachment(key: string): AttachmentRef | undefined {
    for (const { packet: { body } } of this.messages()) for (const ref of body.attachments || []) if (ref.id === key || ref.sha256 === key) return ref;
  }
  transfers(): Record<string, TransferState> { return readJson(this.path('transfers.json'), {}); }
  async ensureIdentity(): Promise<Identity> {
    if (this.identity) return this.identity;
    const file = this.path('identity.json');
    if (!existsSync(file)) {
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const publicKey = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
      const id = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
      writeFileSync(file, JSON.stringify({ id, publicKey, privateJwk: await crypto.subtle.exportKey('jwk', keys.privateKey) }), { mode: 0o600, flag: 'wx' });
    }
    this.identity = JSON.parse(readFileSync(file, 'utf8'));
    this.key = await crypto.subtle.importKey('jwk', this.identity!.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return this.identity!;
  }
  async sign(value: unknown) {
    await this.ensureIdentity();
    return b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.key!, encode(value)));
  }
  async verify(publicKey: string, value: unknown, signature: string) {
    try {
      const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signature, 'base64'), encode(value));
    } catch { return false; }
  }
  /** A signed coordinator command. Retries of one logical action reuse its id. */
  async command(action: Command['action'] | 'agent-redeem', payload: Record<string, unknown> = {}, id: string = randomUUID()): Promise<any> {
    const identity = await this.ensureIdentity();
    // 'agent-redeem' joins the protocol with browser-room agents; older coordinators reject it with a clear error.
    const command = { protocol: browserProtocol, origin: this.origin, id, at: Date.now(), action, roomId: this.roomId, payload } as Command;
    const response = await fetch(`${this.origin}/api/lobby`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Origin: this.origin },
      body: JSON.stringify({ command, publicKey: identity.publicKey, signature: await this.sign(command) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Room service rejected ${action} (${response.status}).`);
    return result;
  }
  messages(): Stored[] { return readJson(this.path('messages.json'), []); }
  members(): Members { return readJson(this.path('members.json'), { members: [], devices: [] }); }
  /** The room's rules as the host set them, copied from the room service by `run`. */
  settings(): { floor: Floor; agentAssignmentsWake?: boolean } { return readJson(this.path('settings.json'), { floor: 'humans-first' as Floor }); }
  /** Verified task operations in arrival order, each with the board cursor at which it arrived. */
  taskOps(): StoredOp[] { return readJson<StoredOp[]>(this.path('tasks.json'), []).map((p, i) => ({ ...p, seq: p.seq ?? i + 1 })); }
  /** Arrivals so far. Compaction drops operations but never moves the cursor back, so later assignments still wake. */
  boardCursor(ops = this.taskOps()) { return Math.max(readJson(this.path('board.json'), { seq: 0 }).seq, ops.at(-1)?.seq ?? 0); }
  /** Verified decision and vote operations in arrival order, each with the decision cursor at which it arrived. */
  decisionOps(): StoredDecisionOp[] { return readJson<StoredDecisionOp[]>(this.path('decisions.json'), []); }
  /** Arrivals so far; compaction drops votes but never moves the cursor back, so later wakes still fire. */
  decisionCursor(ops = this.decisionOps()) { return Math.max(readJson(this.path('decisions-cursor.json'), { seq: 0 }).seq, ops.at(-1)?.seq ?? 0); }
  /** The room's decisions as every device folds them; people's votes count, agents' are advice. */
  decisions(ops = this.decisionOps()): Decision[] {
    const { ownerId, members, former } = this.members();
    return foldDecisions(ops.map(p => p.body), { ownerId, members, former });
  }
  /** Verified reaction operations this device holds (only for messages it also holds). */
  reactionOps(): ReactionPacket[] { return readJson(this.path('reactions.json'), []); }
  reactionChips() { return foldReactions(this.reactionOps().map(p => p.body)); }
  /** What the agent is doing, as its own commands last recorded it; undefined before its first `listen`. */
  activity(): Activity | undefined { const a = readJson<unknown>(this.path('activity.json'), undefined); return validActivity(a) ? a : undefined; }
  /** A change of state starts a new `since` and drops the note, which described the previous state. */
  recordActivity(state: Activity['state'], on?: ActivityOn, now = Date.now()) {
    const current = this.activity(), same = current?.state === state;
    const messages = on?.messages?.length ? { messages: on.messages } : {}, tasks = on?.tasks?.length ? { tasks: on.tasks } : {};
    const next: Activity = { state, since: same ? current!.since : now, heartbeat: now,
      ...(state === 'working' && (messages.messages || tasks.tasks) ? { on: { ...messages, ...tasks } } : {}), ...(same && current!.note ? { note: current!.note } : {}) };
    writeJson(this.path('activity.json'), next); return next;
  }
  /** The agent is still at it: refresh the heartbeat without changing what it is doing. */
  touchActivity(now = Date.now()) { const current = this.activity(); if (current) writeJson(this.path('activity.json'), { ...current, heartbeat: now }); }
  /** Set (or clear, with an empty note) the agent's note. Before any `listen`, a note means it is working. */
  noteActivity(note: string, now = Date.now()) {
    const text = note.trim();
    if (text && !validNote(text)) throw new Error('Keep the note to one line of up to 140 characters.');
    const { note: _, ...current } = this.activity() ?? { state: 'working' as const, since: now, heartbeat: now };
    const next: Activity = { ...current, heartbeat: now, ...(text ? { note: text } : {}) };
    writeJson(this.path('activity.json'), next); return next;
  }

  /** The room as local-room shapes, so collab.ts rules apply unchanged. */
  view() {
    const { memberId, members } = this.members();
    const participants: Participant[] = members.map(m => ({ id: m.id, name: m.name, role: m.id === memberId ? 'agent' : m.role ?? 'human',
      state: m.id === memberId ? 'local' : 'remote', detail: 'Browser room member', ...(m.operatorId ? { operatorId: m.operatorId } : {}) }));
    const messages: Message[] = this.messages().map(({ packet: { body } }) => {
      const author = participants.find(p => p.id === body.memberId);
      const text = shownText(body), mentions = mentionedIds(text, participants);
      // `kind` follows the declared type here; `attachment` re-checks it against the verified bytes.
      const attachments = body.attachments?.map(ref => ({ ...ref, kind: IMAGE_TYPES.includes(ref.type) ? 'image' as const : 'file' as const }));
      return { id: body.id, authorId: body.memberId, author: author?.name ?? 'Former member', role: author?.role ?? 'human', text,
        time: new Date(body.at).toISOString(), ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(mentions.length ? { mentions } : {}), ...(attachments ? { attachments } : {}) };
    });
    const ops = this.taskOps();
    const settings = this.settings();
    return { memberId, participants, messages, floor: settings.floor, agentAssignmentsWake: !!settings.agentAssignmentsWake, tasks: boardTasks(ops), boardRevision: this.boardCursor(ops) };
  }
}

/**
 * The folded board, with assignedRevision rewritten as the board cursor at which this device received the assigning
 * operation. Task revisions count per task, but wake cursors must count across the room, like local rooms.
 */
export function boardTasks(ops: (TaskPacket & { seq?: number })[]): Task[] {
  return foldBoard(ops.map(p => p.body)).map(task => {
    if (!task.assigneeId) return task;
    let position = 0;
    ops.forEach((p, index) => { const b = p.body;
      if (b.taskId === task.id && b.revision === task.assignedRevision && b.assigneeId === task.assigneeId && b.memberId === task.assignedBy) position = p.seq ?? index + 1; });
    return { ...task, assignedRevision: position };
  });
}

type Channel = { readonly readyState: string; send(data: string): void };
/**
 * Announces the agent's activity to every open channel when it changes and again every 30 seconds, so a browser can
 * tell a quiet agent from a silent bridge, and once to each channel as it opens. Call `tick` about once a second.
 */
export function activityAnnouncer(agent: BrowserAgent, channels: () => (Channel | undefined)[], now = () => Date.now()) {
  let announced = '', announcedAt = 0;
  const current = () => { const packet = activityPacket(agent.roomId, agent.activity(), now()); return packet && { packet, text: JSON.stringify(packet) }; };
  const send = (channel: Channel | undefined, text: string) => { if (channel?.readyState === 'open') try { channel.send(text); } catch { /* Sent again within 30 seconds. */ } };
  return {
    tick() {
      const next = current(); if (!next) return;
      const { at: _, heartbeat: __, ...state } = next.packet, key = JSON.stringify(state);
      if (key === announced && now() - announcedAt < ACTIVITY_RESEND_MS) return;
      announced = key; announcedAt = now();
      for (const channel of channels()) send(channel, next.text);
    },
    opened(channel: Channel) { const next = current(); if (next) send(channel, next.text); },
  };
}

/** Harness and model given to `connect` before the host admitted the agent; the runner reports them once admitted. */
export const PENDING_PROFILE = 'profile-pending.json';
export async function applyPendingProfile(agent: BrowserAgent, log: (line: string) => void) {
  const path = join(agent.dir, PENDING_PROFILE);
  if (!existsSync(path)) return;
  const pending = readJson<{ harness?: string; model?: string } | null>(path, null);
  try { if (pending) { await agent.command('profile', pending); log('reported harness and model'); } }
  catch (error) { log(`could not report harness and model (run profile again): ${(error as Error).message}`); }
  finally { try { unlinkSync(path); } catch { /* Already gone. */ } }
}

/** Long-running peer loop: presence, signaling, data channels, storage, and outbox delivery. */
export async function runBridge(agent: BrowserAgent, log: (line: string) => void = console.error) {
  const identity = await agent.ensureIdentity();
  const session = randomUUID(); const peers = new Map<string, Peer>();
  let status: RoomStatus | undefined; let epoch = ''; let cursor = 0;
  let serial: Promise<unknown> = Promise.resolve();
  const transaction = <T>(work: () => Promise<T>) => { const next = serial.then(work); serial = next.catch(() => {}); return next; };
  const save = (messages: Stored[]) => writeJson(join(agent.dir, 'messages.json'), messages);
  /** Append verified operations at the next cursors; a large board is compacted like a browser's, without moving the cursor. */
  const storeOps = (ops: StoredOp[], added: TaskPacket[]) => {
    let seq = agent.boardCursor(ops);
    let next: StoredOp[] = [...ops, ...added.map(p => ({ ...p, seq: ++seq }))];
    if (next.length > COMPACT_AT) { writeJson(join(agent.dir, 'board.json'), { seq }); next = compactBoard(next); }
    writeJson(join(agent.dir, 'tasks.json'), next);
  };
  /** Keep a task operation signed by a current device of its author; duplicates and a full board are ignored. */
  const acceptOps = async (packets: unknown[]) => {
    const ops = agent.taskOps(); const known = new Set(ops.map(p => p.body.id)); const added: TaskPacket[] = [];
    for (const packet of packets as TaskPacket[]) {
      const b = packet?.body;
      if (ops.length + added.length >= MAX_TASK_OPS) break;
      if (!validTaskBody(b, agent.roomId) || known.has(b.id) || typeof packet.signature !== 'string') continue;
      // A change by someone who has since left still verifies against the key the room service keeps for them.
      const author = status?.devices?.find(d => d.id === b.deviceId) ?? status?.formerDevices?.find(d => d.id === b.deviceId);
      if (!author || author.memberId !== b.memberId || !await agent.verify(author.publicKey, b, packet.signature)) continue;
      known.add(b.id); added.push({ body: b, signature: packet.signature });
    }
    if (added.length) storeOps(ops, added);
  };
  const storeDecisionOps = (added: DecisionPacket[]) => {
    const ops = agent.decisionOps(); let seq = agent.decisionCursor(ops);
    let next: StoredDecisionOp[] = [...ops, ...added.map(p => ({ ...p, seq: ++seq }))];
    if (next.length > COMPACT_DECISIONS_AT) { writeJson(join(agent.dir, 'decisions-cursor.json'), { seq }); next = compactDecisions(next); }
    writeJson(join(agent.dir, 'decisions.json'), next);
  };
  /** Keep decision and vote operations signed by a (current or former) device of their author; duplicates are ignored. */
  const acceptDecisionOps = async (packets: unknown[]) => {
    const ops = agent.decisionOps();
    const added = await admitDecisionPackets(ops.map(p => p.body), packets, agent.roomId, async (b, signature) => {
      const author = status?.devices?.find(d => d.id === b.deviceId) ?? status?.formerDevices?.find(d => d.id === b.deviceId);
      return !!author && author.memberId === b.memberId && await agent.verify(author.publicKey, b, signature);
    });
    if (added.length) storeDecisionOps(added);
  };
  const shareDecisionOp = async (body: DecisionBody | VoteBody) => {
    // This device's own changes obey the same per-member share as everyone's, or peers would drop them.
    const held = agent.decisionOps();
    if (held.length >= MAX_DECISION_OPS) throw new Error('This room has reached its limit of decision changes.');
    if (!admissible(held.map(p => p.body), [body]).length) throw new Error('This agent has reached its share of decision changes in this room.');
    const packet = { body, signature: await agent.sign(body) };
    storeDecisionOps([packet]);
    for (const peer of peers.values()) if (peer.channel?.readyState === 'open') peer.channel.send(JSON.stringify(packet));
  };
  /** Close this agent's own decisions once the result can no longer change or their deadline passes (wake on consensus follows). */
  const closeDueDecisions = () => transaction(async () => {
    if (!status?.memberId) return;
    for (const d of agent.decisions()) if (d.createdBy === status.memberId && due(d, Date.now()))
      await shareDecisionOp(reviseDecision({ roomId: agent.roomId, deviceId: identity.id, memberId: status.memberId }, d, { close: true }));
  });
  /** Verified reactions whose message has not arrived yet; retried when that message is stored. */
  let pendingReactions: ReactionPacket[] = [];
  /** Persist ready reaction ops; refuse past the cap after compaction instead of truncating live keys. */
  const storeReactionOps = (ops: ReactionPacket[], added: ReactionPacket[]) => {
    if (!added.length) return true;
    let next = [...ops, ...added];
    if (next.length > COMPACT_REACTIONS_AT) next = compactReactions(next);
    if (next.length > MAX_REACTION_OPS) return false;
    writeJson(join(agent.dir, 'reactions.json'), next);
    return true;
  };
  /** Keep verified reactions for held messages; unknown messages stay pending until the message is stored. */
  const addReactionOps = (incoming: ReactionPacket[]) => {
    const held = new Set(agent.messages().map(m => m.packet.body.id));
    const ops = agent.reactionOps();
    const known = new Set([...ops.map(p => p.body.id), ...pendingReactions.map(p => p.body.id)]);
    const ready: ReactionPacket[] = [];
    for (const op of incoming) {
      if (known.has(op.body.id)) continue;
      known.add(op.body.id);
      if (held.has(op.body.messageId)) ready.push(op);
      else pendingReactions.push(op);
    }
    if (!ready.length) return true;
    return storeReactionOps(ops, ready);
  };
  const flushPendingReactions = (messageId: string) => {
    const due = pendingReactions.filter(op => op.body.messageId === messageId);
    if (!due.length) return;
    pendingReactions = pendingReactions.filter(op => op.body.messageId !== messageId);
    if (!addReactionOps(due)) pendingReactions.push(...due);
  };
  /** Keep reaction operations signed by a current or former device of their author; duplicates are ignored. */
  const acceptReactions = async (packets: unknown[]) => {
    const accepted: ReactionPacket[] = [];
    const known = new Set([...agent.reactionOps().map(p => p.body.id), ...pendingReactions.map(p => p.body.id)]);
    for (const packet of packets as ReactionPacket[]) {
      const b = packet?.body;
      if (!validReactionBody(b, agent.roomId) || known.has(b.id) || typeof packet.signature !== 'string') continue;
      const author = status?.devices?.find(d => d.id === b.deviceId) ?? status?.formerDevices?.find(d => d.id === b.deviceId);
      if (!author || author.memberId !== b.memberId || !await agent.verify(author.publicKey, b, packet.signature)) continue;
      known.add(b.id);
      accepted.push({ body: b, signature: packet.signature });
    }
    if (accepted.length) addReactionOps(accepted);
  };
  /**
   * Files named by verified messages. The store and transfers know nothing about messages, so other signed records
   * (task artifacts, later) can make a file servable the same way.
   */
  const referenced = () => new Map(agent.messages().flatMap(m => m.packet.body.attachments || []).map(ref => [ref.sha256, ref]));
  let transfersDirty = true;
  const transfers = new FileTransfers({ roomId: agent.roomId, store: agent.files, referenced: sha => referenced().get(sha),
    channel: id => peers.get(id)?.channel, changed: () => { transfersDirty = true; },
    peers: () => [...peers].filter(([id, p]) => p.channel?.readyState === 'open' && status?.devices?.some(d => d.id === id)).map(([id]) => id) });
  /** `attachment` asks for a file by writing wants/<sha256>; the bridge fetches only what an agent asked for or sent. */
  let wanted = new Set<string>();
  const fetchWanted = () => {
    const refs = referenced(); wanted = new Set(readdirSync(join(agent.dir, 'wants')).filter(sha => refs.has(sha)));
    transfers.keep(sha => wanted.has(sha));
    for (const sha of wanted) transfers.want(refs.get(sha)!);
    if (!transfersDirty) return;
    transfersDirty = false;
    writeJson(join(agent.dir, 'transfers.json'), Object.fromEntries([...wanted].map(sha => [sha, transfers.state(sha)]).filter(([, state]) => state)));
  };
  /** Keep the files of the newest messages up to the room cap, as browsers do; recent files are left for `send` and `attachment`. */
  const prune = () => {
    const keep = retainedFiles(agent.messages().map(m => m.packet.body.attachments));
    for (const name of readdirSync(join(agent.dir, 'files'))) {
      const path = join(agent.dir, 'files', name);
      try { if (!keep.has(name) && !wanted.has(name) && Date.now() - statSync(path).mtimeMs > FILE_GRACE_MS) unlinkSync(path); } catch { /* Raced with another prune or a write. */ }
    }
  };

  const activity = activityAnnouncer(agent, () => [...peers.values()].map(p => p.channel));
  setInterval(activity.tick, 1000);

  const flush = () => {
    const messages = agent.messages();
    for (const [id, peer] of peers) {
      if (peer.channel?.readyState !== 'open') continue;
      for (const m of messages) if (m.packet.body.deviceId === identity.id && m.targets.includes(id) && !m.receipts.includes(id)) peer.channel.send(JSON.stringify(m.packet));
    }
  };
  const connectChannel = (peer: Peer, id: string, channel: RTCDataChannel) => {
    peer.channel = channel;
    channel.stateChanged.subscribe(state => {
      if (state === 'closed') { if (peers.get(id) === peer) transfers.closed(id); return; }
      if (state !== 'open') return;
      log(`channel open to ${id.slice(0, 8)}`);
      // Exchange boards, decisions, and reactions so either side catches up while apart.
      for (const chunk of syncChunks(agent.roomId, agent.taskOps().map(({ body, signature }) => ({ body, signature })))) channel.send(JSON.stringify(chunk));
      for (const chunk of decisionChunks(agent.roomId, agent.decisionOps().map(({ body, signature }) => ({ body, signature })))) channel.send(JSON.stringify(chunk));
      for (const chunk of reactionSyncChunks(agent.roomId, agent.reactionOps())) channel.send(JSON.stringify(chunk));
      transfers.opened(id);
      activity.opened(channel);
      flush();
    });
    if (channel.readyState === 'open') { transfers.opened(id); activity.opened(channel); }
    channel.onMessage.subscribe(raw => {
      const text = raw.toString(); if (text.length > 20_000) return;
      let packet: Packet; try { packet = JSON.parse(text); } catch { return; }
      // File transfers bypass the serialized queue: chunks arrive by the hundred and are cheap to check.
      if (isFilePacket(packet)) { if (peers.get(id) === peer && status?.devices?.some(d => d.id === id)) transfers.handle(id, packet); return; }
      if (isActivityPacket(packet)) return; // For people's rosters; agents learn nothing from each other's activity.
      void incoming(packet).catch(error => log(`incoming: ${error.message}`));
    });
    const incoming = (packet: Packet) => transaction(async () => {
      if (peers.get(id) !== peer) return;
      const device = status?.devices?.find(d => d.id === id); if (!device) return;
      const sync = packet as unknown as BoardSync;
      if (sync?.kind === 'board') { if (sync.roomId === agent.roomId && Array.isArray(sync.ops)) await acceptOps(sync.ops); return; }
      if ((packet?.body as { kind?: string })?.kind === 'task') { await acceptOps([packet]); return; }
      const decisions = packet as unknown as DecisionSync;
      if (decisions?.kind === 'decisions') { if (decisions.roomId === agent.roomId && Array.isArray(decisions.ops)) await acceptDecisionOps(decisions.ops); return; }
      if (['decision', 'vote'].includes((packet?.body as { kind?: string })?.kind ?? '')) { await acceptDecisionOps([packet]); return; }
      const reactions = packet as unknown as { kind?: string; roomId?: string; ops?: unknown };
      if (reactions?.kind === 'reactions') { if (reactions.roomId === agent.roomId && Array.isArray(reactions.ops)) await acceptReactions(reactions.ops); return; }
      if ((packet?.body as { kind?: string })?.kind === 'reaction') { await acceptReactions([packet]); return; }
      const b = packet?.body;
      if (!b || b.roomId !== agent.roomId || b.deviceId !== id || typeof b.id !== 'string' || !/^[a-f0-9-]{36}$/.test(b.id)
        || typeof packet.signature !== 'string' || !await agent.verify(device.publicKey, b, packet.signature)) return;
      if (b.kind === 'message') {
        if (b.memberId !== device.memberId || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at)) return;
        if (b.replyTo !== undefined && (typeof b.replyTo !== 'string' || !/^[a-f0-9-]{36}$/.test(b.replyTo))) return;
        if (b.attachments !== undefined && !validAttachments(b.attachments)) return;
        const messages = agent.messages(); const existing = messages.find(m => m.packet.body.id === b.id);
        if (existing && JSON.stringify(existing.packet.body) !== JSON.stringify(b)) return;
        if (!existing) {
          if (messages.length >= 1000) return;
          save([...messages, { packet: packet as Stored['packet'], targets: [], receipts: [] }]);
          flushPendingReactions(b.id);
        }
        const receipt: ReceiptBody = { kind: 'receipt', roomId: agent.roomId, id: b.id, deviceId: identity.id };
        if (channel.readyState === 'open') channel.send(JSON.stringify({ body: receipt, signature: await agent.sign(receipt) }));
      } else if (b.kind === 'receipt') {
        const messages = agent.messages(); const m = messages.find(m => m.packet.body.id === b.id && m.packet.body.deviceId === identity.id);
        if (m?.targets.includes(id) && !m.receipts.includes(id)) save(messages.map(x => x === m ? { ...x, receipts: [...x.receipts, id] } : x));
      }
    });
  };
  const makePeer = (device: BrowserDevice & { session?: string }) => {
    // werift takes one URL per entry: expand each server so TURN udp/tcp/tls all stay available.
    const iceServers = (status?.iceServers || []).flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls])
      .map(urls => ({ urls, username: s.username, credential: s.credential as string | undefined })));
    const pc = new RTCPeerConnection({ iceServers });
    const peer: Peer = { pc, session: device.session!, started: Date.now() };
    peers.set(device.id, peer);
    pc.onDataChannel.subscribe(channel => connectChannel(peer, device.id, channel));
    return peer;
  };
  const describe = async (id: string, peer: Peer, offer: boolean) => {
    await peer.pc.setLocalDescription(offer ? await peer.pc.createOffer() : await peer.pc.createAnswer());
    await new Promise(r => setTimeout(r, 1500)); // werift gathers host/srflx candidates quickly; descriptions are not trickled.
    if (peers.get(id) !== peer) return;
    await agent.command('signal', { to: id, session, targetSession: peer.session, description: { type: peer.pc.localDescription!.type, sdp: peer.pc.localDescription!.sdp } });
  };
  const deliverOutbox = () => transaction(async () => {
    const outbox = join(agent.dir, 'outbox');
    for (const file of readdirSync(outbox).filter(f => f.endsWith('.json')).sort()) {
      const item = readJson<{ id: string; text: string; replyTo?: string; attachments?: AttachmentRef[] } | TaskIntent | DecisionIntent | ReactionIntent | null>(join(outbox, file), null);
      if (!item || !status?.memberId) continue;
      if ('type' in item && item.type === 'decision') {
        const ops = agent.decisionOps(), author = { roomId: agent.roomId, deviceId: identity.id, memberId: status.memberId };
        const current = pickDecision(agent.decisions(ops), item.decisionId, status.memberId);
        try {
          if (!ops.some(p => p.body.id === item.id)) {
            const body = item.action === 'open' ? (current ? undefined : openDecision({ ...author, decisionId: item.decisionId, question: item.question, context: item.context,
                mode: item.mode, options: item.options, askAgents: item.askAgents, closesAt: item.closesAt }))
              : !current ? undefined
              : item.action === 'vote' ? castVote(author, current, item.optionId, item.comment, nextVoteRevision(ops.map(p => p.body), current, status.memberId))
              : reviseDecision(author, current, item.action === 'option' ? { addOption: item.label } : item.action === 'close' ? { close: true } : { withdraw: true });
            if (body) await shareDecisionOp({ ...body, id: item.id });
          }
        } catch (error) { log(`dropped decision change ${item.id}: ${error instanceof Error ? error.message : String(error)}`); }
        unlinkSync(join(outbox, file)); continue;
      }
      if ('type' in item && item.type === 'task') {
        const ops = agent.taskOps();
        if (!ops.some(p => p.body.id === item.id)) {
          const current = foldBoard(ops.map(p => p.body)).find(t => t.id === item.taskId);
          const creating = !ops.some(p => p.body.taskId === item.taskId);
          if (creating || current) { // A task someone removed meanwhile is not recreated by an update.
            const body = { ...taskBody({ roomId: agent.roomId, deviceId: identity.id, memberId: status.memberId, current, taskId: item.taskId, change: item.change, removed: item.removed }), id: item.id };
            const packet = { body, signature: await agent.sign(body) };
            storeOps(ops, [packet]);
            for (const peer of peers.values()) if (peer.channel?.readyState === 'open') peer.channel.send(JSON.stringify(packet));
          }
        }
        unlinkSync(join(outbox, file)); continue;
      }
      if ('type' in item && item.type === 'reaction') {
        const ops = agent.reactionOps();
        if (ops.some(p => p.body.id === item.id)) { unlinkSync(join(outbox, file)); continue; }
        // Wait until the message is held; do not drop the outbox item forever.
        if (!agent.messages().some(m => m.packet.body.id === item.messageId)) continue;
        const bodies = ops.map(p => p.body);
        const remove = memberReacted(agent.reactionChips(), item.messageId, item.emoji, status.memberId);
        if (!remove && liveKeysForMember(bodies, status.memberId) >= MAX_REACTION_KEYS_PER_MEMBER) {
          unlinkSync(join(outbox, file)); continue;
        }
        const body: ReactionBody = {
          kind: 'reaction', roomId: agent.roomId, id: item.id, deviceId: identity.id, memberId: status.memberId,
          messageId: item.messageId, emoji: item.emoji,
          revision: currentRevision(bodies, item.messageId, status.memberId, item.emoji) + 1,
          at: Date.now(), ...(remove ? { removed: true as const } : {}),
        };
        const packet = { body, signature: await agent.sign(body) };
        if (!storeReactionOps(ops, [packet])) {
          // Log full: leave queued and mark so reactBrowser can report log-full distinctly.
          writeJson(join(outbox, file), { ...item, blocked: 'log-full' });
          continue;
        }
        for (const peer of peers.values()) if (peer.channel?.readyState === 'open') peer.channel.send(JSON.stringify(packet));
        unlinkSync(join(outbox, file)); continue;
      }
      if (!('text' in item)) continue;
      const messages = agent.messages();
      const files = item.attachments;
      if (files && (!validAttachments(files) || !files.every(ref => agent.files.has(ref.sha256)))) { log(`dropped message ${item.id}: its files are missing`); unlinkSync(join(outbox, file)); continue; }
      if (!messages.some(m => m.packet.body.id === item.id)) {
        const body: MessageBody = { kind: 'message', roomId: agent.roomId, id: item.id, deviceId: identity.id, memberId: status.memberId,
          text: item.text || (files ? attachmentText(files) : ''), at: Date.now(), ...(item.replyTo ? { replyTo: item.replyTo } : {}), ...(files ? { attachments: files } : {}) };
        save([...messages, { packet: { body, signature: await agent.sign(body) }, targets: (status.devices || []).filter(d => d.id !== identity.id).map(d => d.id), receipts: [] }]);
        flushPendingReactions(item.id);
      }
      unlinkSync(join(outbox, file));
    }
    flush();
  });

  let pruned = 0;
  log(`bridge running as device ${identity.id.slice(0, 12)} in ${agent.roomId}`);
  while (true) {
    try {
      const next: RoomStatus = await agent.command('status', { session, epoch, cursor });
      if (!next.memberId) { log(next.request ? `waiting for admission (${next.request.state})` : 'not admitted to this room'); await Bun.sleep(3000); continue; }
      if (epoch && next.epoch !== epoch) { for (const p of peers.values()) await p.pc.close(); peers.clear(); cursor = 0; }
      epoch = next.epoch; status = next;
      // Departed members' roles, one per member, so an agent that left is never counted as a person in a decision.
      const former = [...new Map((next.formerDevices || []).map(d => [d.memberId, { id: d.memberId, ...((d as { role?: 'human' | 'agent' }).role ? { role: (d as { role?: 'human' | 'agent' }).role } : {}) }])).values()];
      writeJson(join(agent.dir, 'members.json'), { memberId: next.memberId, ownerId: next.ownerId, former, members: next.members || [], devices: (next.devices || []).map(d => ({ id: d.id, memberId: d.memberId })) });
      if (next.settings) writeJson(join(agent.dir, 'settings.json'), { floor: next.settings.floor, agentAssignmentsWake: next.settings.agentAssignmentsWake });
      await applyPendingProfile(agent, log);
      for (const signal of next.signals || []) cursor = Math.max(cursor, signal.seq);
      const available = (next.devices || []).filter(d => d.id !== identity.id && d.session);
      for (const [id, peer] of peers) {
        if (!available.some(d => d.id === id && d.session === peer.session) || ['failed', 'closed'].includes(peer.pc.connectionState)
          || (peer.pc.connectionState !== 'connected' && Date.now() - peer.started > 20_000)) { await peer.pc.close(); peers.delete(id); transfers.closed(id); }
      }
      for (const signal of next.signals || []) {
        const device = available.find(d => d.id === signal.from && d.session === signal.session); if (!device) continue;
        let peer = peers.get(device.id);
        if (signal.description.type === 'offer') {
          if (device.id > identity.id) continue;
          if (peer) { await peer.pc.close(); transfers.closed(device.id); } peer = makePeer(device);
          await peer.pc.setRemoteDescription(signal.description as any);
          await describe(device.id, peer, false);
        } else if (peer?.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription(signal.description as any);
      }
      for (const device of available) {
        if (identity.id < device.id && !peers.has(device.id)) {
          const peer = makePeer(device); connectChannel(peer, device.id, peer.pc.createDataChannel('meshrooms-browser-v1'));
          await describe(device.id, peer, true);
        }
      }
      await deliverOutbox();
      await closeDueDecisions();
      transfers.tick(); fetchWanted();
      if (Date.now() - pruned > 60_000) { prune(); pruned = Date.now(); }
    } catch (error) { log(`status: ${error instanceof Error ? error.message : String(error)}`); }
    await Bun.sleep(1000);
  }
}

/**
 * Wait until this agent is addressed in the browser room (same semantics as local `listen`). Calling it means the
 * agent is idle; returning what addressed it means it is working on that until it listens again.
 */
export async function listenBrowser(agent: BrowserAgent, after: string | undefined, seconds: number, boardAfter?: number, decisionsAfter?: number) {
  const deadline = Date.now() + seconds * 1000;
  let beat = 0;
  while (true) {
    const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
    const woke = evaluateWake(view, view.memberId, after, boardAfter);
    // Decisions asking for this agent's advice, and its own decisions that resolved (wake on consensus).
    const ops = agent.decisionOps(), decisionCursor = agent.decisionCursor(ops);
    const wakes = decisionsAfter === undefined ? { asked: [], resolved: [], withdrawn: [] } : decisionWakes(ops.map(p => p.body), agent.members(), view.memberId, ops.filter(p => p.seq > decisionsAfter).map(p => p.body));
    const decided = wakes.asked.length || wakes.resolved.length || wakes.withdrawn.length;
    const result = woke.state === 'waiting' && decided ? { ...woke, state: 'addressed' as const } : woke;
    if (result.state !== 'waiting') {
      // History without anything for this agent is catching up, not work.
      if (result.addressed.length || result.tasks.length || decided) agent.recordActivity('working', { messages: result.addressed.slice(-8), tasks: result.tasks.map(t => t.id).slice(-8) });
      else agent.recordActivity('idle');
      return { roomId: agent.roomId, participantId: view.memberId, floor: view.floor, ...result, decisionCursor,
        ...(decided ? { decisions: { asked: wakes.asked.map(d => describeDecision(agent, d)), resolved: wakes.resolved.map(d => describeDecision(agent, d)),
          ...(wakes.withdrawn.length ? { withdrawn: wakes.withdrawn.map(d => describeDecision(agent, d)) } : {}) } } : {}) };
    }
    if (!beat || Date.now() - beat >= LISTEN_HEARTBEAT_MS) { if (beat) agent.touchActivity(); else agent.recordActivity('idle'); beat = Date.now(); }
    if (Date.now() >= deadline) {
      agent.touchActivity();
      return { state: 'timeout', roomId: agent.roomId, participantId: view.memberId, floor: view.floor, messages: [], cursor: after,
        boardCursor: boardAfter ?? view.boardRevision, decisionCursor: decisionsAfter ?? decisionCursor, observed: result.messages.filter(m => m.authorId !== view.memberId).length };
    }
    await Bun.sleep(500);
  }
}

/** Queue a message for `run` to sign and deliver; waits until peers store it or the timeout passes. */
export async function sendBrowser(agent: BrowserAgent, text: string, replyTo: string | undefined, requestId: string, attach: string[] = []) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  if ((!text.trim() && !attach.length) || text.length > 4000) throw new Error('Write a message of up to 4,000 characters.');
  if (attach.length > MAX_MESSAGE_ATTACHMENTS) throw new Error(`Attach up to ${MAX_MESSAGE_ATTACHMENTS} files per message.`);
  if (replyTo && !view.messages.some(m => m.id === replyTo)) throw new Error('The reply target is not in this browser room.');
  if (!mayAgentSpeak(view, view.memberId, replyTo)) throw new Error('This room is humans-first: agents speak only when a person addresses them. Reply to a message that mentions you or replies to you.');
  const id = requestId; // Stable per logical send, so a retry never duplicates.
  if (agent.activity()?.state === 'working') agent.touchActivity();
  const sent = agent.messages().find(m => m.packet.body.id === id);
  let attachments = sent?.packet.body.attachments;
  if (!sent) {
    const files = attach.map(path => {
      const size = statSync(path).size;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error(`${basename(path)} is ${Math.ceil(size / 1024 / 1024)} MB; attach files of 10 MB or less.`);
      return { path, bytes: new Uint8Array(readFileSync(path)) };
    });
    // Stored before the message is queued, so `run` can serve each file as soon as a peer asks.
    attachments = await Promise.all(files.map(async ({ path, bytes }) => { const ref = await attachmentRef(bytes, basename(path)); agent.files.add(bytes); return ref; }));
    writeJson(join(agent.dir, 'outbox', `${Date.now()}-${id}.json`), { id, text: text.trim(), ...(replyTo ? { replyTo } : {}), ...(attachments.length ? { attachments } : {}) });
  }
  const files = attachments?.length ? { attachments } : {};
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const stored = agent.messages().find(m => m.packet.body.id === id);
    if (stored && stored.receipts.length) return { messageId: id, status: 'stored-remotely', devices: stored.receipts.length, ...files };
    await Bun.sleep(300);
  }
  return { messageId: id, status: agent.messages().some(m => m.packet.body.id === id) ? 'queued-for-peers' : 'queued-for-bridge', ...files };
}

/**
 * Write a file from a message to `out` (a file path, or an existing directory to write it into under its name).
 * Asks `run` to fetch it when this device does not hold it, and waits up to `seconds`. Returns only verified bytes.
 */
export async function attachmentBrowser(agent: BrowserAgent, key: string, out: string, seconds: number) {
  const ref = agent.attachment(key);
  if (!ref) throw new Error('No message in this room has that attachment. Use an attachment id from listen.');
  const want = join(agent.dir, 'wants', ref.sha256);
  let bytes = await agent.files.get(ref.sha256);
  if (!bytes) writeFileSync(want, '', { mode: 0o600 });
  const deadline = Date.now() + seconds * 1000;
  try {
    while (!bytes && Date.now() < deadline) { await Bun.sleep(300); bytes = await agent.files.get(ref.sha256); }
  } finally { try { unlinkSync(want); } catch { /* Not asked, or already removed. */ } }
  if (!bytes) {
    const state = agent.transfers()[ref.sha256];
    throw new Error(state?.state === 'damaged' ? 'The copies offered so far failed verification against the signed hash, so nothing was saved. Retry later.'
      : state?.state === 'fetching' ? `Still receiving (${Math.floor(state.received * 100 / state.size)}%). Retry with a longer --wait-seconds.`
      : 'No connected device has this file right now. Retry when its author or another member who has it is online.');
  }
  let path = resolve(out);
  if (existsSync(path) && statSync(path).isDirectory()) {
    // The name comes from a peer's message: validated on arrival, cleaned again here, and never allowed to replace a file.
    const dir = path, name = cleanName(ref.name, defaultName(ref.type)), dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    path = join(dir, name);
    for (let n = 2; existsSync(path); n++) path = join(dir, `${stem}-${n}${extension}`);
    if (dirname(path) !== dir) throw new Error('This attachment name cannot be saved safely. Pass --out with a file path.');
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  } else writeFileSync(path, bytes, { mode: 0o600 }); // An explicit file path is the caller's choice to replace.
  const kind = displayKind(ref, sniff(bytes).type);
  return { path, id: ref.id, name: ref.name, type: ref.type, kind, size: ref.size, sha256: ref.sha256, ...(ref.width ? { width: ref.width, height: ref.height } : {}) };
}

/** Starting a task means working on it; finishing, reopening or removing it means that task is no longer what the agent is on. */
function taskActivity(agent: BrowserAgent, taskId: string, status: TaskChange['status'], removed: boolean) {
  const current = agent.activity(), on = current?.state === 'working' ? current.on : undefined;
  const others = (on?.tasks || []).filter(id => id !== taskId);
  if (status === 'doing' && !removed) agent.recordActivity('working', { messages: on?.messages, tasks: [taskId, ...others].slice(0, 8) });
  else if (on?.tasks?.includes(taskId)) agent.recordActivity('working', { messages: on.messages, tasks: others });
  else if (current?.state === 'working') agent.touchActivity();
}

/** Queue a task change for `run` to sign and share; returns the task once it is on this device's board. */
export async function taskBrowser(agent: BrowserAgent, input: { requestId: string; taskId?: string; revision?: number; change: TaskChange; removed?: boolean }) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  const { change } = input;
  if (change.title !== undefined && (!change.title.trim() || change.title.trim().length > 120)) throw new Error('Give the task a title of up to 120 characters.');
  if (change.notes !== undefined && change.notes.trim().length > 2000) throw new Error('Keep task notes to 2,000 characters.');
  if (change.assigneeId && !view.participants.some(p => p.id === change.assigneeId)) throw new Error('The assignee is not a member of this room.');
  const done = agent.taskOps().find(p => p.body.id === input.requestId);
  // A new task takes the request id as its task id, so retrying the same request never creates a second task.
  const taskId = input.taskId ?? input.requestId;
  if (!done && input.taskId) {
    const current = view.tasks.find(t => t.id === input.taskId);
    if (!current) throw new Error('That task is not on the board. Run tasks for current task IDs.');
    if (input.revision !== undefined && current.revision !== input.revision) throw new Error(`The task changed since you read it (now revision ${current.revision}). Read tasks again, then retry.`);
  }
  if (!done && !input.taskId && !change.title?.trim()) throw new Error('Use --title for the new task.');
  if (!done) writeJson(join(agent.dir, 'outbox', `${Date.now()}-${input.requestId}.json`), { type: 'task', id: input.requestId, taskId, change, ...(input.removed ? { removed: true } : {}) } satisfies TaskIntent);
  taskActivity(agent, taskId, change.status, !!input.removed);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // Check the outbox first: `run` stores the operation before deleting the queued file.
    const pending = readdirSync(join(agent.dir, 'outbox')).some(f => f.endsWith(`-${input.requestId}.json`));
    const ops = agent.taskOps();
    if (ops.some(p => p.body.id === input.requestId)) {
      return { taskId, status: 'shared', removed: !!input.removed, task: boardTasks(ops).find(t => t.id === taskId) ?? null, boardCursor: agent.boardCursor(ops) };
    }
    if (!pending) return { taskId, status: 'dropped', reason: 'Someone removed the task before this change was signed.' };
    await Bun.sleep(300);
  }
  return { taskId, status: 'queued-for-bridge' };
}

/** Queue a reaction toggle for `run` to sign and share. Humans and agents use the same fixed emoji set. */
export async function reactBrowser(agent: BrowserAgent, input: { requestId: string; messageId: string; emoji: string }) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  if (!isReactionEmoji(input.emoji)) throw new Error(`Use one of these emoji: ${REACTION_EMOJI.join(' ')}`);
  if (!view.messages.some(m => m.id === input.messageId)) throw new Error('That message is not in this browser room.');
  const emoji = input.emoji;
  const bodies = agent.reactionOps().map(p => p.body);
  const already = memberReacted(agent.reactionChips(), input.messageId, emoji, view.memberId);
  if (!already && liveKeysForMember(bodies, view.memberId) >= MAX_REACTION_KEYS_PER_MEMBER) {
    throw new Error('You have too many reactions in this room. Remove some before adding more.');
  }
  if (!agent.reactionOps().some(p => p.body.id === input.requestId)) {
    writeJson(join(agent.dir, 'outbox', `${Date.now()}-${input.requestId}.json`), { type: 'reaction', id: input.requestId, messageId: input.messageId, emoji } satisfies ReactionIntent);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pendingFile = readdirSync(join(agent.dir, 'outbox')).find(f => f.endsWith(`-${input.requestId}.json`));
    if (agent.reactionOps().some(p => p.body.id === input.requestId)) {
      return { messageId: input.messageId, emoji, removed: already, status: 'shared', reactions: agent.reactionChips().filter(c => c.messageId === input.messageId) };
    }
    if (pendingFile) {
      const pending = readJson<ReactionIntent | null>(join(agent.dir, 'outbox', pendingFile), null);
      if (pending?.blocked === 'log-full') return { messageId: input.messageId, emoji, status: 'log-full' as const };
    } else {
      return { messageId: input.messageId, emoji, status: 'dropped', reason: 'The message was gone before this reaction was signed.' };
    }
    await Bun.sleep(300);
  }
  return { messageId: input.messageId, emoji, status: 'queued-for-bridge' };
}

/** A decision as an agent reads it: names instead of ids, and which votes count. */
export function describeDecision(agent: BrowserAgent, d: Decision) {
  const { members } = agent.members(), name = (id: string) => members.find(m => m.id === id)?.name ?? 'Former member';
  const label = (id: string | null) => id === null ? null : d.options.find(o => o.id === id)?.label ?? id;
  return { id: d.id, question: d.question, ...(d.context ? { context: d.context } : {}), mode: d.mode, state: d.state, createdBy: name(d.createdBy),
    options: d.options.map(o => ({ id: o.id, label: o.label, people: d.tally.tally[o.id] ?? 0 })),
    ...(d.closesAt ? { closesAt: new Date(d.closesAt).toISOString() } : {}),
    // An outcome is final only once every vote it counted has arrived here (verified); uncounted votes came after it closed.
    ...(d.state === 'closed' && d.outcome ? { outcome: { result: d.outcome.result, options: d.outcome.optionIds.map(label), voters: d.outcome.voters, people: d.outcome.people,
      verified: d.verified, ...(d.uncounted ? { uncounted: d.uncounted } : {}) } }
      : { leading: d.tally.result === 'no-votes' ? [] : d.tally.optionIds.map(label), voters: d.tally.voters, people: d.tally.people, settled: d.settled }),
    votes: d.votes.map(v => ({ by: name(v.memberId), counts: v.counts, option: label(v.optionId), ...(v.comment ? { comment: v.comment } : {}) })) };
}

/** Queue a decision change for `run` to sign and share; returns the decision once this device holds the change. */
export async function decisionBrowser(agent: BrowserAgent, intent: DistributiveOmit<DecisionIntent, 'type'>, seconds = 10) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  const current = pickDecision(agent.decisions(), intent.decisionId, view.memberId);
  const done = agent.decisionOps().some(p => p.body.id === intent.id);
  if (!done && intent.action !== 'open') {
    if (!current) throw new Error('That decision is not in this room. Run decisions for current ids.');
    if (current.state !== 'open') throw new Error(`This decision is already ${current.state}.`);
    if (intent.action === 'vote' && intent.optionId !== null && !current.options.some(o => o.id === intent.optionId))
      throw new Error(`Choose one of: ${current.options.map(o => `${o.id} (${o.label})`).join(', ')}.`);
    const { ownerId, members } = agent.members();
    const steward = current.createdBy === view.memberId || view.memberId === ownerId || members.some(m => m.id === current.createdBy && m.operatorId === view.memberId);
    if ((intent.action === 'close' || intent.action === 'withdraw') && !steward) throw new Error('Only the person or agent who opened it, its operator, or the host can close it.');
    if (intent.action === 'option' && current.mode === 'plan-review') throw new Error('Plan reviews keep Approve / Request changes / Reject.');
  }
  if (!done) writeJson(join(agent.dir, 'outbox', `${Date.now()}-${intent.id}.json`), { type: 'decision', ...intent });
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const pending = readdirSync(join(agent.dir, 'outbox')).some(f => f.endsWith(`-${intent.id}.json`));
    const ops = agent.decisionOps();
    if (ops.some(p => p.body.id === intent.id)) {
      agent.touchActivity();
      const decision = pickDecision(agent.decisions(ops), intent.decisionId, view.memberId);
      return { status: 'shared', decision: decision ? describeDecision(agent, decision) : null, decisionCursor: agent.decisionCursor(ops) };
    }
    if (!pending) return { status: 'dropped', reason: 'The change no longer applied when it was signed (the decision closed or changed). Read it again.' };
    await Bun.sleep(300);
  }
  return { status: 'queued-for-bridge' };
}

/** Block until a decision closes (the multiplayer form of waiting for a user's answer), or the wait ends. */
export async function waitDecision(agent: BrowserAgent, decisionId: string, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  while (true) {
    const d = pickDecision(agent.decisions(), decisionId, agent.members().memberId);
    if (!d) throw new Error('That decision is not in this room. Run decisions for current ids.');
    const final = d.state === 'withdrawn' || (d.state === 'closed' && d.verified);
    if (final || Date.now() >= deadline) {
      agent.touchActivity();
      return { state: final ? d.state : d.state === 'closed' ? 'verifying' : 'timeout', decision: describeDecision(agent, d) };
    }
    await Bun.sleep(1000);
  }
}
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/**
 * A decision by the id people quote. Ids are unique per creator, so a copy someone else signed with the same id is a
 * different decision: prefer this agent's own, and refuse to guess between other people's.
 */
export function pickDecision(decisions: Decision[], id: string, me: string | undefined) {
  const matches = decisions.filter(d => d.id === id);
  if (matches.length <= 1) return matches[0];
  const own = matches.find(d => d.createdBy === me); if (own) return own;
  throw new Error('Several decisions share that id. Ask the person who opened yours for its question, and use decisions to find it.');
}

/**
 * The decision operations of a batch this device keeps. Signatures are checked before the hold rule is applied, so a
 * forged decision can't make a genuine vote for it look admissible: decisions (few) are verified first, then votes are
 * admitted only against held or verified decisions and per-member shares, then the admitted votes are verified.
 */
export async function admitDecisionPackets(held: (DecisionBody | VoteBody)[], packets: unknown[], roomId: string,
  genuine: (body: DecisionBody | VoteBody, signature: string) => Promise<boolean>): Promise<DecisionPacket[]> {
  const known = new Set(held.map(b => b.id)), seen = new Set<string>();
  const fresh = (packets as DecisionPacket[]).filter(p => typeof p?.signature === 'string' && (validDecisionBody(p.body, roomId) || validVoteBody(p.body, roomId))
    && !known.has(p.body.id) && !seen.has(p.body.id) && seen.add(p.body.id));
  const decisions: DecisionPacket[] = [];
  for (const p of fresh) if (p.body.kind === 'decision' && await genuine(p.body, p.signature)) decisions.push(p);
  const votes = fresh.filter(p => p.body.kind === 'vote');
  const keep = new Set(admissible(held, [...decisions, ...votes].map(p => p.body)).map(b => b.id));
  const accepted: DecisionPacket[] = [];
  for (const p of fresh) {
    if (held.length + accepted.length >= MAX_DECISION_OPS) break;
    if (!keep.has(p.body.id)) continue;
    if (p.body.kind === 'vote' && !await genuine(p.body, p.signature)) continue;
    accepted.push({ body: p.body, signature: p.signature });
  }
  return accepted;
}
