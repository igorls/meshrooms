import type { Task } from '../collab';
import { COMPACT_AT, MAX_TASK_OPS, capLiveTasks, compactBoard, foldBoard, mayAddTask, syncChunks, taskBody, validTaskBody, withinRevisionJump, type TaskBody, type TaskChange, type TaskPacket } from './board';
import { signerOf, verify, type BrowserDevice, type RoomStatus } from './protocol';
import { BrowserApi } from './client';
import {
  COMPACT_DECISIONS_AT, MAX_DECISION_OPS, admissible, castVote, compactDecisions, decisionChunks, nextVoteRevision, openDecision, reviseDecision, validDecisionBody, validVoteBody,
  type Decision, type DecisionBody, type DecisionPacket, type VoteBody,
} from './decisions';
import { FileTransfers, IMAGE_TYPES, LOW_WATER, MAX_MESSAGE_ATTACHMENTS, attachmentText, autoFetchFiles, isFilePacket, isSha256, retainedFiles, validAttachments, type AttachmentRef, type TransferState } from './files';
import {
  COMPACT_REACTIONS_AT, MAX_PENDING_PER_MEMBER, MAX_PENDING_REACTIONS, MAX_REACTION_OPS, capReactions, compactReactions, currentRevision,
  foldReactions, isReactionEmoji, mayHoldPending, memberReacted, reactionSyncChunks, validReactionBody,
  type ReactionChip, type ReactionEmoji, type ReactionPacket,
} from './reactions';
import { addRetractions, applyRetractions, isRetracted, mayRetract, retractedStub, retractionSyncChunks, validRetractBody, type RetractBody, type RetractPacket } from './retractions';
import { FenceError, StorageError, isPlainObject, read, readArray, readRecord, sign, update, type Fence } from './storage';
import { isActivityPacket, receiveActivity, validActivityPacket, type ActivityRecord } from './activity';
import { awaitingDelivery, windowHistory } from './history';
import {
  FILE_CHANNEL_LABEL, IncomingGate, PACE_LOW_WATER, PRIMARY_CHANNEL_LABEL, Resync, SYNC_REQUEST, SendQueue,
  answerMatchesOffer, dedupeSignals, evaluatePeerHealth, isLiveOpenPeer, isSyncRequest, sdpIceUfrag,
  type PeerHealthState, type SyncRequest,
} from './pacer';
import { QuotaDrops, ReceiveQuota, type QuotaKind } from './quota';

/** `replyTo` and `attachments` are optional so browsers from before them keep verifying and storing these packets. */
type MessageBody = { kind: 'message'; roomId: string; id: string; deviceId: string; memberId: string; text: string; at: number; replyTo?: string; attachments?: AttachmentRef[] };
const isId = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
type ReceiptBody = { kind: 'receipt'; roomId: string; id: string; deviceId: string };
type Packet = { body: MessageBody | ReceiptBody | TaskPacket['body'] | DecisionBody | VoteBody | ReactionPacket['body'] | RetractBody; signature: string };
export type SavedMessage = { packet: Packet & { body: MessageBody }; targets: string[]; receipts: string[]; retracted?: true };
/**
 * `sent`: when each outbox message was last sent on this connection, so an unconfirmed one isn't resent every tick.
 * `queue` paces this device's board, decisions and reactions onto the channel; `resync` answers the peer's requests for them.
 */
type Peer = {
  pc: RTCPeerConnection; session: string; channel?: RTCDataChannel; fileChannel?: RTCDataChannel;
  started: number; unhealthySince?: number; openedOnce?: boolean; offerSent?: boolean;
  iceKey?: string; remoteUfrag?: string;
  sent: Map<string, number>; queue?: SendQueue; resync: Resync;
};
/** An unconfirmed message is sent to a peer again after this long. */
const RESEND_MS = 5000;
/** A file of this room as this browser sees it: a blob URL once verified and stored, else how fetching goes. */
export type FileView = { url?: string; type?: string; transfer?: TransferState };
/** Stored files by hash, with the type sniffed from their bytes. */
type FileIndex = Record<string, { size: number; type: string }>;
/** Out-of-order reactions whose message hasn't arrived within this window are evicted as stale. */
export const PENDING_REACTION_TTL_MS = 5 * 60_000;

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
const isAttachmentRefShape = (value: unknown): value is AttachmentRef =>
  isPlainObject(value) && typeof value.id === 'string' && typeof value.name === 'string'
  && typeof value.type === 'string' && typeof value.size === 'number' && Number.isFinite(value.size)
  && typeof value.sha256 === 'string';
function isSavedMessage(value: unknown, roomId: string): value is SavedMessage {
  if (!isPlainObject(value) || !isPlainObject(value.packet) || typeof value.packet.signature !== 'string') return false;
  const b = value.packet.body;
  if (!isPlainObject(b) || b.kind !== 'message' || b.roomId !== roomId) return false;
  if (typeof b.id !== 'string' || typeof b.deviceId !== 'string' || typeof b.memberId !== 'string'
    || typeof b.text !== 'string' || typeof b.at !== 'number' || !Number.isFinite(b.at)) return false;
  if (b.replyTo !== undefined && typeof b.replyTo !== 'string') return false;
  if (b.attachments !== undefined && (!Array.isArray(b.attachments) || !b.attachments.every(isAttachmentRefShape))) return false;
  return isStringArray(value.targets) && isStringArray(value.receipts) && (value.retracted === undefined || value.retracted === true);
}
const isTaskPacket = (value: unknown, roomId: string): value is TaskPacket =>
  isPlainObject(value) && typeof value.signature === 'string' && validTaskBody(value.body, roomId);
const isDecisionPacket = (value: unknown, roomId: string): value is DecisionPacket =>
  isPlainObject(value) && typeof value.signature === 'string' && (validDecisionBody(value.body, roomId) || validVoteBody(value.body, roomId));
const isReactionPacket = (value: unknown, roomId: string): value is ReactionPacket =>
  isPlainObject(value) && typeof value.signature === 'string' && validReactionBody(value.body, roomId);
const isRetractPacket = (value: unknown, roomId: string): value is RetractPacket =>
  isPlainObject(value) && typeof value.signature === 'string' && validRetractBody(value.body, roomId);
const isFileIndexEntry = (value: unknown, sha: string): value is { size: number; type: string } =>
  isSha256(sha) && isPlainObject(value) && typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0 && typeof value.type === 'string';
const isBlob = (value: unknown): value is Blob => typeof Blob !== 'undefined' && value instanceof Blob;

/** Real browser data channels; the lobby carries connection descriptions only. */
export class BrowserPeers {
  private peers = new Map<string, Peer>();
  private status?: RoomStatus;
  private messages: SavedMessage[] = [];
  /** Receipts recorded in memory but not yet written; they are written together, at most once a second (SYNC-7). */
  private receiptsDirty = false;
  private receiptTimer?: ReturnType<typeof setTimeout>;
  private serial: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private incoming = new IncomingGate();
  /** Live packets per member and kind (DEC-6); over-quota packets are dropped unstored, unrelayed and unconfirmed. */
  private quota = new ReceiveQuota();
  /** Peers whose task, decision or reaction operations went over quota; asked for their state again after the burst. */
  private quotaDrops = new QuotaDrops();
  private key: string;
  private boardKey: string;
  private ops: TaskPacket[] = [];
  private decisionKey: string;
  private decisionOps: DecisionPacket[] = [];
  private reactionKey: string;
  private reactionOps: ReactionPacket[] = [];
  /** Verified reactions whose message has not arrived yet; retried when that message is stored. */
  private pendingReactions: ReactionPacket[] = [];
  private pendingReactionAt = new Map<string, number>();
  private retractKey: string;
  private retractOps: RetractPacket[] = [];
  private filesKey: string;
  private index: FileIndex = {};
  private refs = new Map<string, AttachmentRef>();
  private retained = new Map<string, AttachmentRef>();
  /** Attachments explicitly requested by the person on demand (non-images, or images past the auto-fetch budget). */
  private requested = new Set<string>();
  private urls = new Map<string, string>();
  private fileSerial: Promise<unknown> = Promise.resolve();
  private files: FileTransfers;
  /** Latest ICE server list (including refreshed TURN credentials) from the coordinator (OPS-11). */
  private iceServers: RTCIceServer[] = [];
  private iceKey = '[]';
  /** Remote `ice-ufrag`s already consumed by retired connections for `${deviceId}:${session}` (stale answer guard). */
  private retiredUfrags = new Map<string, Set<string>>();
  /** Latest activity per agent device with an open channel; memory only, dropped when the channel closes. */
  private activity = new Map<string, ActivityRecord>();
  /** This engine's claim on the room's records in this browser (see claimFence). Nothing is written without one. */
  private fence?: Fence;
  /** A fenced write found that another tab claimed the room: this engine stopped for good. */
  private fencedOut = false;
  constructor(private api: BrowserApi, private roomId: string, private deviceId: string, private session: string,
    private changed: (messages: SavedMessage[], connected: string[], added?: SavedMessage) => void, private error: (message: string) => void,
    private boardChanged: (tasks: Task[], ops: TaskBody[]) => void = () => {}, private filesChanged: (files: Record<string, FileView>) => void = () => {},
    private activityChanged: (activity: Record<string, ActivityRecord>) => void = () => {},
    private decisionsChanged: (ops: (DecisionBody | VoteBody)[]) => void = () => {},
    private reactionsChanged: (chips: ReactionChip[]) => void = () => {},
    private now: () => number = () => Date.now()) {
    this.key = `messages:${deviceId}:${roomId}`;
    this.boardKey = `board:${deviceId}:${roomId}`;
    this.decisionKey = `decisions:${deviceId}:${roomId}`;
    this.reactionKey = `reactions:${deviceId}:${roomId}`;
    this.retractKey = `retractions:${deviceId}:${roomId}`;
    this.filesKey = `files:${deviceId}:${roomId}`;
    this.files = new FileTransfers({ roomId, referenced: sha => this.refs.get(sha), changed: () => this.notifyFiles(), now: () => this.now(),
      store: { has: sha => sha in this.index, get: sha => this.readFile(sha), put: (sha, bytes, type) => this.storeFile(sha, bytes, type) },
      channel: id => { const peer = this.peers.get(id); return peer?.fileChannel?.readyState === 'open' ? peer.fileChannel : peer?.channel; },
      peers: () => [...this.peers].filter(([id, p]) => (p.fileChannel?.readyState === 'open' || p.channel?.readyState === 'open') && this.status?.devices?.some(d => d.id === id)).map(([id]) => id) });
  }
  /** Write only while this claim on the room is current: once another tab claims it, every write aborts unwritten. */
  fenced(fence: Fence) { this.fence = fence; }
  /** Stopped, by its owner or because another tab claimed the room. */
  isStopped() { return this.stopped; }
  /** Stopped because another tab of this browser claimed the room (its writes are fenced out); a reload takes it back. */
  lostRoom() { return this.fencedOut; }
  /**
   * Every write of this room's records goes through here, fenced by the engine's claim. An engine without a claim
   * writes nothing: an unfenced writer could overwrite the room's current owner. Losing the room stops this engine at
   * once, whichever write found out (a message, a receipt, the board, a file), then the error goes on to the caller.
   */
  private async put(puts: [string, unknown][], deletes: string[] = []) {
    if (!this.fence) throw new Error('Claim the room (claimRoom) before writing its records.');
    try { await update(puts, deletes, this.fence); }
    catch (error) {
      if (error instanceof FenceError && !this.fencedOut) { this.fencedOut = true; this.stop(); }
      throw error;
    }
  }
  async load() {
    this.messages = await readArray(this.key, (v): v is SavedMessage => isSavedMessage(v, this.roomId));
    this.ops = await readArray(this.boardKey, (v): v is TaskPacket => isTaskPacket(v, this.roomId));
    this.decisionOps = await readArray(this.decisionKey, (v): v is DecisionPacket => isDecisionPacket(v, this.roomId));
    this.reactionOps = await readArray(this.reactionKey, (v): v is ReactionPacket => isReactionPacket(v, this.roomId));
    this.retractOps = await readArray(this.retractKey, (v): v is RetractPacket => isRetractPacket(v, this.roomId));
    this.index = await readRecord(this.filesKey, isFileIndexEntry);
    for (const sha of Object.keys(this.index)) await this.fileUrl(sha);
    this.notify(); this.notifyBoard(); this.notifyDecisions(); this.notifyReactions(); this.syncFiles();
  }
  private notifyReactions() { if (!this.stopped) this.reactionsChanged(foldReactions(this.reactionOps.map(op => op.body))); }
  chips() { return foldReactions(this.reactionOps.map(op => op.body)); }
  private fileKey(sha: string) { return `file:${this.deviceId}:${this.roomId}:${sha}`; }
  private fileChain<T>(work: () => Promise<T>): Promise<T> { const next = this.fileSerial.then(work); this.fileSerial = next.catch(() => {}); return next; }
  private async readFile(sha: string) {
    const blob = await read<Blob>(this.fileKey(sha), isBlob);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  }
  /** Stored as a Blob, which browsers keep on disk; only verified raster images carry an image type. */
  private storeFile(sha: string, bytes: Uint8Array, type: string) {
    return this.fileChain(async () => {
      // A stopped engine has handed the room to another owner, which keeps the file index from now on.
      if (this.stopped) return;
      const next = { ...this.index, [sha]: { size: bytes.length, type } };
      await this.put([[this.fileKey(sha), new Blob([bytes as BlobPart], { type: IMAGE_TYPES.includes(type) ? type : 'application/octet-stream' })], [this.filesKey, next]]);
      this.index = next; await this.fileUrl(sha); this.notifyFiles();
    });
  }
  private async fileUrl(sha: string) {
    if (this.urls.has(sha)) return;
    const blob = await read<Blob>(this.fileKey(sha), isBlob);
    if (blob && !this.stopped) this.urls.set(sha, URL.createObjectURL(blob));
  }
  /** Auto-fetch only raster images within per-sender and room caps (SEC-11), keep on-demand requests, and evict the rest. */
  private syncFiles() {
    const lists = this.messages.map(m => m.packet.body.attachments);
    const owners = this.messages.map(m => m.packet.body.memberId);
    this.refs = new Map(lists.flatMap(list => list || []).map(ref => [ref.sha256, ref]));
    this.retained = retainedFiles(lists, undefined, undefined, owners);
    for (const sha of this.requested) if (!this.retained.has(sha)) this.requested.delete(sha);
    const auto = autoFetchFiles(lists, owners, this.retained);
    this.files.keep(sha => this.retained.has(sha) && (auto.has(sha) || this.requested.has(sha)));
    for (const ref of auto.values()) this.files.want(ref);
    for (const sha of this.requested) { const ref = this.retained.get(sha); if (ref) this.files.want(ref); }
    // Always queued, behind any write under way, which the index doesn't show yet.
    void this.fileChain(async () => {
      const evicted = Object.keys(this.index).filter(sha => !this.retained.has(sha));
      if (!evicted.length) return;
      const next = Object.fromEntries(Object.entries(this.index).filter(([sha]) => this.retained.has(sha)));
      await this.put([[this.filesKey, next]], evicted.map(sha => this.fileKey(sha)));
      this.index = next;
      for (const sha of evicted) { const url = this.urls.get(sha); if (url) URL.revokeObjectURL(url); this.urls.delete(sha); }
      this.notifyFiles();
    }).catch(e => this.fail(e));
    this.notifyFiles();
  }
  /** Fetch a non-image attachment (or an image past the per-sender auto-fetch budget) on demand (SEC-11). */
  requestFile(sha: string) {
    if (this.stopped) return;
    const ref = this.retained.get(sha);
    if (!ref || sha in this.index) return;
    this.requested.add(sha);
    this.files.want(ref);
    this.notifyFiles();
  }
  private notifyFiles() {
    if (this.stopped) return;
    const view: Record<string, FileView> = {};
    for (const sha of this.refs.keys()) view[sha] = { url: this.urls.get(sha), type: this.index[sha]?.type, transfer: this.files.state(sha) };
    this.filesChanged(view);
  }
  /** True when this browser no longer keeps the file because newer files filled the room's share of storage. */
  evicted(sha: string) { return this.refs.has(sha) && !this.retained.has(sha); }
  private notifyBoard() { if (this.stopped) return; const ops = this.ops.map(op => op.body); this.boardChanged(foldBoard(ops), ops); }
  /** Keeps operations we have not seen, compacting once the board grows large. */
  private async addOps(incoming: TaskPacket[]) {
    const held = this.ops.map(op => op.body);
    const known = new Set(held.map(op => op.id));
    const unseen = incoming.filter(op => !known.has(op.body.id) && (known.add(op.body.id), true));
    // Revisions stay within MAX_REVISION_JUMP of pre-batch held state; each member keeps their oldest
    // MAX_LIVE_TASKS_PER_MEMBER live tasks over everything held (capLiveTasks), whatever order it arrived in.
    const fresh = withinRevisionJump(held, unseen);
    if (!fresh.length) return;
    let next = capLiveTasks([...this.ops, ...fresh]);
    if (next.length === this.ops.length && next.every((op, i) => op === this.ops[i])) return;
    // Compaction keeps the same board with fewer operations; only a large board needs it.
    if (next.length > COMPACT_AT) next = compactBoard(next);
    if (next.length > MAX_TASK_OPS) throw new Error('This room’s task board is full in this preview.');
    await this.put([[this.boardKey, next]]); this.ops = next; this.notifyBoard();
  }
  /** Create a task (no current), change one, or remove it. Signed here and sent to every connected device. */
  async changeTask(change: TaskChange, current?: Task, removed = false) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before changing tasks.');
      const body = taskBody({ roomId: this.roomId, deviceId: this.deviceId, memberId: this.status.memberId, current, change, removed, repositories: this.status.repositories });
      if (!current && !removed && !mayAddTask(this.ops.map(op => op.body), body)) {
        throw new Error('You have too many live tasks in this room. Remove some before adding more.');
      }
      const packet: TaskPacket = { body, signature: await sign(body) };
      await this.addOps([packet]);
      for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') { try { peer.channel.send(JSON.stringify(packet)); } catch { /* The board is exchanged again on reconnect. */ } }
    });
  }
  private prunePendingReactions(now = this.now()) {
    if (!this.pendingReactions.length) return;
    const kept: ReactionPacket[] = [];
    for (const op of this.pendingReactions) {
      const at = this.pendingReactionAt.get(op.body.id) ?? now;
      if (now - at > PENDING_REACTION_TTL_MS) this.pendingReactionAt.delete(op.body.id);
      else kept.push(op);
    }
    this.pendingReactions = kept;
  }
  private dropPendingForMessages(messageIds: Set<string>) {
    if (!messageIds.size || !this.pendingReactions.length) return;
    const kept: ReactionPacket[] = [];
    for (const op of this.pendingReactions) {
      if (messageIds.has(op.body.messageId)) this.pendingReactionAt.delete(op.body.id);
      else kept.push(op);
    }
    this.pendingReactions = kept;
  }
  private parkPendingReaction(op: ReactionPacket, now = this.now()) {
    if (!mayHoldPending(this.pendingReactions, op)) {
      const memberCount = this.pendingReactions.filter(p => p.body.memberId === op.body.memberId).length;
      const dropIndex = memberCount >= MAX_PENDING_PER_MEMBER
        ? this.pendingReactions.findIndex(p => p.body.memberId === op.body.memberId)
        : this.pendingReactions.length >= MAX_PENDING_REACTIONS ? 0 : -1;
      if (dropIndex >= 0) {
        const [dropped] = this.pendingReactions.splice(dropIndex, 1);
        this.pendingReactionAt.delete(dropped.body.id);
      }
    }
    if (mayHoldPending(this.pendingReactions, op)) {
      this.pendingReactions.push(op);
      this.pendingReactionAt.set(op.body.id, now);
    }
  }
  private async addReactionOps(incoming: ReactionPacket[]) {
    const now = this.now();
    this.prunePendingReactions(now);
    const live = new Set(this.messages.filter(m => !isRetracted(m)).map(m => m.packet.body.id));
    const retracted = new Set(this.messages.filter(isRetracted).map(m => m.packet.body.id));
    const known = new Set([...this.reactionOps, ...this.pendingReactions].map(op => op.body.id));
    let ready: ReactionPacket[] = [];
    for (const op of incoming) {
      if (known.has(op.body.id) || retracted.has(op.body.messageId)) continue;
      known.add(op.body.id);
      if (live.has(op.body.messageId)) ready.push(op);
      else this.parkPendingReaction(op, now);
    }
    if (!ready.length) return;
    // Each member keeps their newest MAX_REACTION_KEYS_PER_MEMBER live reactions over everything held (capReactions).
    let next = capReactions([...this.reactionOps, ...ready]);
    if (next.length > COMPACT_REACTIONS_AT) next = compactReactions(next);
    if (next.length > MAX_REACTION_OPS) throw new Error('This room’s reactions log is full in this preview.');
    await this.put([[this.reactionKey, next]]); this.reactionOps = next; this.notifyReactions();
  }
  private async flushPendingReactions(messageId: string) {
    const due = this.pendingReactions.filter(op => op.body.messageId === messageId);
    if (!due.length) return;
    this.dropPendingForMessages(new Set([messageId]));
    await this.addReactionOps(due);
  }
  /** Toggle one of the fixed emoji on a message. Humans and agents use the same path. */
  async react(messageId: string, emoji: ReactionEmoji) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before reacting.');
      if (!isReactionEmoji(emoji)) throw new Error('Choose one of the room’s reaction emoji.');
      const message = this.messages.find(m => m.packet.body.id === messageId);
      if (!message || isRetracted(message)) throw new Error('That message is not in this browser.');
      const bodies = this.reactionOps.map(op => op.body);
      const remove = memberReacted(this.chips(), messageId, emoji, this.status.memberId);
      const body = {
        kind: 'reaction' as const, roomId: this.roomId, id: crypto.randomUUID(), deviceId: this.deviceId,
        memberId: this.status.memberId, messageId, emoji,
        revision: currentRevision(bodies, messageId, this.status.memberId, emoji) + 1,
        at: Date.now(), ...(remove ? { removed: true as const } : {}),
      };
      const packet: ReactionPacket = { body, signature: await sign(body) };
      await this.addReactionOps([packet]);
      for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') {
        try { peer.channel.send(JSON.stringify(packet)); } catch { /* Reactions are exchanged again on reconnect. */ }
      }
    });
  }
  /** Keep verified retractions and remove what they name. The log and the messages are written together. */
  private async addRetractionOps(incoming: RetractPacket[]) {
    const { log, added } = addRetractions(this.retractOps, incoming, this.messages);
    if (!added.length) return;
    const { messages, changed } = applyRetractions(this.messages, log.map(op => op.body));
    const puts: [string, unknown][] = [[this.retractKey, log]];
    const removed = new Set(changed);
    // A deleted message's reactions go too, so they count toward nobody's cap here or on a device that joins later.
    const reactions = this.reactionOps.filter(op => !removed.has(op.body.messageId));
    if (changed.length) puts.push([this.key, messages]);
    if (reactions.length !== this.reactionOps.length) puts.push([this.reactionKey, reactions]);
    await this.put(puts); this.retractOps = log;
    if (reactions.length !== this.reactionOps.length) { this.reactionOps = reactions; this.notifyReactions(); }
    if (changed.length) {
      this.dropPendingForMessages(removed);
      this.messages = messages; this.notify(); this.syncFiles();
    }
  }
  /** Delete one of this member's messages for everyone. Any of their devices can, so it is the member that is compared. */
  async retract(messageId: string) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before deleting a message.');
      const message = this.messages.find(m => m.packet.body.id === messageId);
      if (!message) throw new Error('That message is not in this browser.');
      if (message.packet.body.memberId !== this.status.memberId) throw new Error('You can only delete your own messages.');
      if (isRetracted(message)) return;
      const body: RetractBody = { kind: 'retract', roomId: this.roomId, id: crypto.randomUUID(), deviceId: this.deviceId, memberId: this.status.memberId, at: Date.now(), target: messageId };
      const packet: RetractPacket = { body, signature: await sign(body) };
      await this.addRetractionOps([packet]);
      for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') {
        try { peer.channel.send(JSON.stringify(packet)); } catch { /* Retractions are exchanged again on reconnect. */ }
      }
    });
  }
  /** A retraction relayed in an exchange is checked against its author's own device (see signerOf), not the sender's. */
  private async acceptRetractions(sync: { roomId?: unknown; ops?: unknown }) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const accepted: RetractPacket[] = [];
    const held = new Set(this.retractOps.map(op => op.body.id));
    for (const op of sync.ops as RetractPacket[]) {
      if (held.has(op?.body?.id)) continue;
      const author = signerOf(this.status, op?.body?.deviceId, op?.body?.at);
      if (!author || !validRetractBody(op.body, this.roomId) || op.body.memberId !== author.memberId || typeof op.signature !== 'string') continue;
      if (await verify(author.publicKey, op.body, op.signature)) accepted.push({ body: op.body, signature: op.signature });
    }
    await this.addRetractionOps(accepted);
  }
  private async acceptReactions(sync: { roomId?: unknown; ops?: unknown }) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const accepted: ReactionPacket[] = [];
    // Held operations and retracted targets are skipped before signatures are checked.
    const held = new Set([...this.reactionOps, ...this.pendingReactions].map(op => op.body.id));
    const retracted = new Set(this.messages.filter(isRetracted).map(m => m.packet.body.id));
    for (const op of sync.ops as ReactionPacket[]) {
      if (held.has(op?.body?.id) || retracted.has(op?.body?.messageId)) continue;
      const author = signerOf(this.status, op?.body?.deviceId, op?.body?.at);
      if (!author || !validReactionBody(op.body, this.roomId) || op.body.memberId !== author.memberId || typeof op.signature !== 'string') continue;
      if (await verify(author.publicKey, op.body, op.signature)) accepted.push({ body: op.body, signature: op.signature });
    }
    try { await this.addReactionOps(accepted); }
    catch { /* Cap full: keep the local log; peers retry after compaction elsewhere. */ }
  }
  /** Operations relayed in a board exchange are checked against each author's own device, not the sender's. */
  private async acceptBoard(sync: { roomId?: unknown; ops?: unknown }) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const accepted: TaskPacket[] = [];
    const held = new Set(this.ops.map(op => op.body.id));
    for (const op of sync.ops as TaskPacket[]) {
      if (held.has(op?.body?.id)) continue;
      // A change by someone who has since left still verifies against the key the room service keeps for them (see signerOf).
      const author = signerOf(this.status, op?.body?.deviceId, op?.body?.at);
      if (!author || !validTaskBody(op.body, this.roomId) || op.body.memberId !== author.memberId || typeof op.signature !== 'string') continue;
      if (await verify(author.publicKey, op.body, op.signature)) accepted.push({ body: op.body, signature: op.signature });
    }
    await this.addOps(accepted);
  }
  /** This device's board, decisions and reactions, paced onto the peer's channel (on open, and when it asks again). */
  private sendState(peer: Peer) {
    if (!peer.queue) return;
    const chunks = [...syncChunks(this.roomId, this.ops), ...decisionChunks(this.roomId, this.decisionOps), ...reactionSyncChunks(this.roomId, this.reactionOps), ...retractionSyncChunks(this.roomId, this.retractOps)];
    if (!chunks.length) return;
    peer.resync.sent();
    peer.queue.push(chunks.map(chunk => JSON.stringify(chunk)));
  }
  /** Ask a peer for its state again after this device dropped some of its packets under load. */
  private requestSync(id: string) {
    const channel = this.peers.get(id)?.channel;
    if (channel?.readyState !== 'open') return;
    const request: SyncRequest = { kind: SYNC_REQUEST, roomId: this.roomId };
    try { channel.send(JSON.stringify(request)); } catch { /* Asked again after the next drop, or the state is exchanged on reconnect. */ }
  }
  private notifyDecisions() { if (!this.stopped) this.decisionsChanged(this.decisionOps.map(op => op.body)); }
  /** Keeps decision operations we have not seen; a full log refuses new ones rather than dropping live state. */
  private async addDecisionOps(incoming: DecisionPacket[]) {
    const known = new Set(this.decisionOps.map(op => op.body.id));
    const fresh = incoming.filter(op => !known.has(op.body.id) && (known.add(op.body.id), true));
    if (!fresh.length) return;
    let next = [...this.decisionOps, ...fresh];
    // Compaction keeps the same decisions with fewer votes; only a busy log needs it.
    if (next.length > COMPACT_DECISIONS_AT) next = compactDecisions(next);
    if (next.length > MAX_DECISION_OPS) throw new Error('This room’s decisions log is full in this preview.');
    await this.put([[this.decisionKey, next]]); this.decisionOps = next; this.notifyDecisions();
  }
  private async publishDecision(body: DecisionBody | VoteBody) {
    // The same per-member limit applies to this device's own operations as to those it receives.
    if (!admissible(this.decisionOps.map(op => op.body), [body]).length) throw new Error('You have reached this room’s limit for decision changes.');
    const packet: DecisionPacket = { body, signature: await sign(body) };
    await this.addDecisionOps([packet]);
    for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') { try { peer.channel.send(JSON.stringify(packet)); } catch { /* Decisions are exchanged again on reconnect. */ } }
  }
  private author() {
    if (!this.status?.memberId || this.stopped) throw new Error('Join the room before taking part in decisions.');
    return { roomId: this.roomId, deviceId: this.deviceId, memberId: this.status.memberId };
  }
  /** Open a decision for the room: a question with options, or a plan review. Signed here and sent to every device. */
  openDecision(input: Omit<Parameters<typeof openDecision>[0], 'roomId' | 'deviceId' | 'memberId'>) {
    return this.transaction(async () => { const body = openDecision({ ...this.author(), ...input }); await this.publishDecision(body); return body.decisionId; });
  }
  /** Add an option, close (recording the tally this device sees) or withdraw a decision. */
  reviseDecision(decision: Decision, change: Parameters<typeof reviseDecision>[2]) {
    return this.transaction(async () => { await this.publishDecision(reviseDecision(this.author(), decision, change)); });
  }
  /** Vote for an option, or `null` to take the vote back. A later vote from the same member replaces this one. */
  vote(decision: Decision, optionId: string | null, comment = '') {
    return this.transaction(async () => {
      const a = this.author();
      await this.publishDecision(castVote(a, decision, optionId, comment, nextVoteRevision(this.decisionOps.map(op => op.body), decision, a.memberId)));
    });
  }
  /** Decision operations relayed in an exchange are checked against each author's own device, not the sender's. */
  private async acceptDecisions(sync: { roomId?: unknown; ops?: unknown }) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const held = new Set(this.decisionOps.map(op => op.body.id));
    const candidates = (sync.ops as DecisionPacket[]).filter(op => (validDecisionBody(op?.body, this.roomId) || validVoteBody(op?.body, this.roomId))
      && typeof op.signature === 'string' && !held.has(op.body.id));
    const authentic = async ({ body: b, signature }: DecisionPacket) => {
      const author = signerOf(this.status, b.deviceId, b.at);
      return !!author && b.memberId === author.memberId && await verify(author.publicKey, b, signature);
    };
    // Decisions first, so a vote is admitted only against a decision held or just verified (a forged decision in the
    // batch can't carry votes in); then the per-member cap, before the more numerous votes are verified.
    const decisions: DecisionPacket[] = [];
    for (const op of candidates) if (op.body.kind === 'decision' && await authentic(op)) decisions.push(op);
    const votes = candidates.filter(op => op.body.kind === 'vote');
    const admitted = new Set(admissible(this.decisionOps.map(op => op.body), [...decisions, ...votes].map(op => op.body)));
    const accepted = decisions.filter(op => admitted.has(op.body));
    for (const op of votes) if (admitted.has(op.body) && await authentic(op)) accepted.push(op);
    await this.addDecisionOps(accepted.map(({ body, signature }) => ({ body, signature })));
  }
  /**
   * Spend one live packet of `kind` from a member, sent by peer `from`; false (with a debug line, at most once a minute)
   * when over quota. A dropped message is sent again by its sender; for other kinds the peer is asked for its state.
   */
  private allowed(memberId: string, kind: QuotaKind, from: string) {
    if (this.quota.take(memberId, kind)) return true;
    if (this.quota.report(memberId, kind)) console.debug(`Meshrooms: dropped ${kind} packets from member ${memberId.slice(0, 8)} over the receive quota`);
    if (kind !== 'message') this.quotaDrops.drop(from);
    return false;
  }
  private notifyActivity() { if (!this.stopped) this.activityChanged(Object.fromEntries(this.activity)); }
  private forget(id: string) { if (this.activity.delete(id)) this.notifyActivity(); }
  /** Only an agent's own device speaks for it, on its own channel. */
  private acceptActivity(id: string, packet: unknown) {
    const device = this.status?.devices?.find(d => d.id === id);
    if (!device || this.status?.members?.find(m => m.id === device.memberId)?.role !== 'agent' || !validActivityPacket(packet, this.roomId)) return;
    this.activity.set(id, receiveActivity(packet)); this.notifyActivity();
  }
  /**
   * Network and peer problems go to the transient banner; failed saves are shown by the storage banner instead. A
   * fenced-out write means another tab owns the room now: this engine stops, and the new owner keeps the records.
   */
  private fail(error: Error) {
    if (error instanceof FenceError) return; // Already stopped by put().
    if (!(error instanceof StorageError)) this.error(error.message);
  }
  private notify(added?: SavedMessage) { if (!this.stopped) this.changed([...this.messages], [...this.peers].filter(([, p]) => p.channel?.readyState === 'open').map(([id]) => id), added); }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work); this.serial = next.catch(() => {}); return next;
  }
  /** Own messages a device still in the room has not confirmed storing; eviction never drops them. */
  private awaiting(message: SavedMessage) {
    return awaitingDelivery(message, this.deviceId, this.status?.devices && new Set(this.status.devices.map(d => d.id)));
  }
  /** Store `added` at the end of the history, evicting the oldest messages past the rolling window. */
  private async save(added: SavedMessage) {
    const { kept, evicted } = windowHistory([...this.messages, added], m => this.awaiting(m));
    await this.put([[this.key, kept]]); this.messages = kept; this.receiptsDirty = false;
    if (evicted.length) this.dropPendingForMessages(new Set(evicted.map(m => m.packet.body.id)));
    const stored = kept.at(-1) === added;
    this.notify(stored && !isRetracted(added) ? added : undefined);
    if (added.packet.body.attachments || evicted.some(m => m.packet.body.attachments)) this.syncFiles();
    if (stored) await this.flushPendingReactions(added.packet.body.id);
  }
  /** A receipt changes one message; the history is written with the next save, or within a second. Receipts are idempotent: one lost on close only makes this device send that message again, and the peer confirms it again. */
  private receipt(message: SavedMessage, from: string) {
    this.messages = this.messages.map(m => m === message ? { ...m, receipts: [...m.receipts, from] } : m);
    this.receiptsDirty = true; this.notify();
    this.receiptTimer ??= setTimeout(() => {
      this.receiptTimer = undefined;
      void this.transaction(() => this.writeReceipts()).catch(e => this.fail(e));
    }, 1000);
  }
  private async writeReceipts() { if (this.receiptsDirty) { this.receiptsDirty = false; await this.put([[this.key, this.messages]]); } }
  /** Files are stored here before the message that names them, so this browser can serve them as soon as peers ask. */
  async send(text: string, replyTo?: string, files: { ref: AttachmentRef; bytes: Uint8Array }[] = []) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before sending.');
      if ((!text.trim() && !files.length) || text.length > 4000) throw new Error('Write a message of up to 4,000 characters.');
      if (files.length > MAX_MESSAGE_ATTACHMENTS) throw new Error(`Attach up to ${MAX_MESSAGE_ATTACHMENTS} files per message.`);
      const attachments = files.map(f => f.ref);
      if (files.length && !validAttachments(attachments)) throw new Error('These files cannot be attached. Remove them and attach them again.');
      if (replyTo !== undefined && !this.messages.some(m => m.packet.body.id === replyTo)) throw new Error('The message you replied to is not in this browser.');
      for (const { ref, bytes } of files) if (!this.index[ref.sha256]) await this.storeFile(ref.sha256, bytes, ref.type);
      const body: MessageBody = { kind: 'message', roomId: this.roomId, id: crypto.randomUUID(), deviceId: this.deviceId, memberId: this.status.memberId,
        text: text.trim() || attachmentText(attachments), at: Date.now(), ...(replyTo ? { replyTo } : {}), ...(files.length ? { attachments } : {}) };
      const packet = { body, signature: await sign(body) };
      const saved: SavedMessage = { packet, targets: this.status.devices!.filter(d => d.id !== this.deviceId).map(d => d.id), receipts: [] };
      await this.save(saved); this.flush();
    });
  }
  /** Send each connected peer up to 16 of its unconfirmed messages, oldest first; ones sent in the last few seconds wait. */
  private flush() {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (peer.channel?.readyState !== 'open') continue;
      let sent = 0;
      for (const message of this.messages) {
        if (sent >= 16) break;
        if (peer.channel.bufferedAmount > 256_000) break;
        const messageId = message.packet.body.id;
        if (message.packet.body.deviceId === this.deviceId && message.targets.includes(id) && !message.receipts.includes(id) && now - (peer.sent.get(messageId) ?? 0) >= RESEND_MS) {
          try { peer.channel.send(JSON.stringify(message.packet)); sent++; peer.sent.set(messageId, now); } catch { break; } // Persisted outbox retries on the next connection.
        }
      }
      if (peer.sent.size > 4096) peer.sent.clear();
    }
  }
  private handleDataMessage(peer: Peer, id: string, channel: RTCDataChannel, raw: unknown) {
    if (typeof raw !== 'string' || raw.length > 20_000) return;
    let packet: Packet;
    try { packet = JSON.parse(raw); } catch { return; }
    // File transfers bypass the message queue: chunks arrive by the hundred and are cheap to check.
    if (isFilePacket(packet)) {
      if (!this.stopped && this.peers.get(id) === peer && this.status?.devices?.some(d => d.id === id)) this.files.handle(id, packet);
      return;
    }
    if (isActivityPacket(packet)) { if (!this.stopped && this.peers.get(id) === peer) this.acceptActivity(id, packet); return; }
    // Cheap and never queued: answered from the tick, at most once per interval.
    if (isSyncRequest(packet, this.roomId)) {
      if (!this.stopped && this.peers.get(id) === peer && this.status?.devices?.some(d => d.id === id)) { peer.resync.request(); this.resyncDue(peer); }
      return;
    }
    if (!this.incoming.admit(id)) return;
    void this.transaction(async () => {
      if (this.stopped || !this.status?.memberId || this.peers.get(id) !== peer) return;
      const device = this.status.devices?.find(d => d.id === id); if (!device) return;
      if ((packet as unknown as { kind?: unknown })?.kind === 'board') { await this.acceptBoard(packet as never); return; }
      if ((packet as unknown as { kind?: unknown })?.kind === 'decisions') { await this.acceptDecisions(packet as never); return; }
      if ((packet as unknown as { kind?: unknown })?.kind === 'reactions') { await this.acceptReactions(packet as never); return; }
      if ((packet as unknown as { kind?: unknown })?.kind === 'retractions') { await this.acceptRetractions(packet as never); return; }
      const b = packet?.body;
      if (!b || b.roomId !== this.roomId || b.deviceId !== id || !isId(b.id) || typeof packet.signature !== 'string' || !await verify(device.publicKey, b, packet.signature)) return;
      if (b.kind === 'message') {
        if (b.memberId !== device.memberId || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at) || b.at < 0 || b.at > 8_640_000_000_000_000) return;
        // The replied-to message may predate this browser's admission, so only its form is checked.
        if (b.replyTo !== undefined && !isId(b.replyTo)) return;
        if (b.attachments !== undefined && !validAttachments(b.attachments)) return;
        const existing = this.messages.find(m => m.packet.body.id === b.id);
        // A stub no longer matches the original its sender may still be retrying, and it only needs confirming.
        if (existing && !isRetracted(existing) && JSON.stringify(existing.packet.body) !== JSON.stringify(b)) return;
        // Past the rolling window the oldest messages make room, so a new one is always stored and confirmed.
        if (!existing) {
          if (!this.allowed(device.memberId, 'message', id)) return; // Unconfirmed, so its sender retries later.
          const saved: SavedMessage = { packet: packet as SavedMessage['packet'], targets: [], receipts: [] };
          await this.save(this.retractOps.some(op => mayRetract(op.body, b)) ? retractedStub(saved) : saved);
        }
        // A receipt means an IndexedDB transaction completed, not that a person read it.
        const receipt: ReceiptBody = { kind: 'receipt', roomId: this.roomId, id: b.id, deviceId: this.deviceId };
        if (channel.readyState === 'open') {
          const encoded = JSON.stringify({ body: receipt, signature: await sign(receipt) });
          if (channel.readyState === 'open') {
            try { channel.send(encoded); } catch { /* The sender retries on reconnect and receives a receipt then. */ }
          }
        }
      } else if (b.kind === 'receipt') {
        const m = this.messages.find(m => m.packet.body.id === b.id && m.packet.body.deviceId === this.deviceId);
        if (m?.targets.includes(id) && !m.receipts.includes(id)) this.receipt(m, id);
      } else if (b.kind === 'task') {
        if (validTaskBody(b, this.roomId) && b.memberId === device.memberId && !this.ops.some(op => op.body.id === b.id)
          && this.allowed(device.memberId, 'task', id)) await this.addOps([{ body: b, signature: packet.signature }]);
      } else if (b.kind === 'decision' || b.kind === 'vote') {
        if ((validDecisionBody(b, this.roomId) || validVoteBody(b, this.roomId)) && b.memberId === device.memberId && !this.decisionOps.some(op => op.body.id === b.id)
          && admissible(this.decisionOps.map(op => op.body), [b]).length && this.allowed(device.memberId, 'decision', id)) await this.addDecisionOps([{ body: b, signature: packet.signature }]);
      } else if (b.kind === 'reaction') {
        if (validReactionBody(b, this.roomId) && b.memberId === device.memberId && ![...this.reactionOps, ...this.pendingReactions].some(op => op.body.id === b.id)
          && this.allowed(device.memberId, 'reaction', id)) await this.addReactionOps([{ body: b, signature: packet.signature }]);
      } else if (b.kind === 'retract') {
        if (validRetractBody(b, this.roomId) && b.memberId === device.memberId && !this.retractOps.some(op => op.body.id === b.id)
          && this.allowed(device.memberId, 'retract', id)) await this.addRetractionOps([{ body: b, signature: packet.signature }]);
      }
    }).catch(e => this.fail(e)).finally(() => { for (const from of this.incoming.done()) this.requestSync(from); });
  }
  private connectChannel(peer: Peer, id: string, channel: RTCDataChannel) {
    peer.channel = channel;
    const queue = peer.queue = new SendQueue(channel);
    channel.bufferedAmountLowThreshold = PACE_LOW_WATER;
    channel.addEventListener('bufferedamountlow', () => queue.pump());
    let didOpen = false;
    const opened = () => {
      if (didOpen || this.stopped || this.peers.get(id) !== peer) return;
      didOpen = true;
      this.healthOf(peer);
      this.flush(); this.sendState(peer);
      if (peer.fileChannel?.readyState !== 'open') this.files.opened(id);
      this.notify();
    };
    channel.onopen = opened;
    channel.onclose = () => {
      peer.unhealthySince ??= this.now();
      if (this.peers.get(id) === peer) { this.files.closed(id); this.forget(id); }
      this.notify();
    };
    channel.onmessage = event => this.handleDataMessage(peer, id, channel, event.data);
    if (channel.readyState === 'open') opened();
  }
  /** Dedicated `'files'` channel isolating bulk chunks from chat/sync; also accepts non-file traffic from older answerers. */
  private connectFileChannel(peer: Peer, id: string, channel: RTCDataChannel) {
    peer.fileChannel = channel;
    try { channel.bufferedAmountLowThreshold = LOW_WATER; } catch { /* Read-only in some mocks. */ }
    let didOpen = false;
    const opened = () => {
      if (didOpen || this.stopped || this.peers.get(id) !== peer || peer.fileChannel !== channel) return;
      didOpen = true;
      this.files.opened(id);
    };
    channel.onopen = opened;
    channel.onclose = () => {
      if (this.peers.get(id) === peer && peer.fileChannel === channel) {
        peer.fileChannel = undefined;
        this.files.closed(id);
        if (peer.channel?.readyState === 'open') this.files.opened(id);
      }
    };
    channel.onmessage = event => this.handleDataMessage(peer, id, channel, event.data);
    if (channel.readyState === 'open') opened();
  }
  private resyncDue(peer: Peer) { if (peer.queue && peer.resync.due(peer.queue)) this.sendState(peer); }
  /** Each status poll: pump paced sends, answer due resync requests, and ask peers for state dropped over quota. */
  private tick() {
    this.prunePendingReactions();
    for (const peer of this.peers.values()) { peer.queue?.pump(); this.resyncDue(peer); }
    for (const id of this.quotaDrops.due()) this.requestSync(id);
  }
  private retireUfrag(id: string, session: string, ufrag: string | undefined) {
    if (!ufrag) return;
    const key = `${id}:${session}`;
    let set = this.retiredUfrags.get(key);
    if (!set) { set = new Set(); this.retiredUfrags.set(key, set); }
    set.add(ufrag);
    if (set.size > 32) set.delete(set.values().next().value!);
  }
  private dropPeer(id: string, peer: Peer) {
    this.retireUfrag(id, peer.session, peer.remoteUfrag);
    try { peer.pc.close(); } catch { /* Already closed. */ }
    if (this.peers.get(id) === peer) {
      this.peers.delete(id);
      this.files.closed(id);
      this.forget(id);
    }
  }
  private healthOf(peer: Peer, now = this.now()) {
    const state: PeerHealthState = {
      connectionState: peer.pc.connectionState,
      iceConnectionState: peer.pc.iceConnectionState,
      channelState: peer.channel?.readyState,
      started: peer.started,
      openedOnce: peer.openedOnce,
      unhealthySince: peer.unhealthySince,
    };
    const verdict = evaluatePeerHealth(state, now);
    peer.openedOnce = state.openedOnce;
    peer.unhealthySince = state.unhealthySince;
    return verdict;
  }
  private peer(device: BrowserDevice & { session?: string }) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = { pc, session: device.session!, started: this.now(), iceKey: this.iceKey, sent: new Map(), resync: new Resync() };
    this.peers.set(device.id, peer);
    pc.ondatachannel = event => event.channel.label === FILE_CHANNEL_LABEL
      ? this.connectFileChannel(peer, device.id, event.channel)
      : this.connectChannel(peer, device.id, event.channel);
    const onState = () => { this.healthOf(peer); this.notify(); };
    pc.onconnectionstatechange = onState;
    pc.oniceconnectionstatechange = onState;
    return peer;
  }
  private async description(id: string, peer: Peer, offer: boolean) {
    const isClosed = () => peer.pc.connectionState === 'closed';
    if (this.stopped || this.peers.get(id) !== peer || isClosed()) return;
    await peer.pc.setLocalDescription(offer ? await peer.pc.createOffer() : await peer.pc.createAnswer());
    if (peer.pc.iceGatheringState !== 'complete') await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); peer.pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (peer.pc.iceGatheringState === 'complete' || isClosed()) finish(); };
      const timer = setTimeout(finish, 4000); peer.pc.addEventListener('icegatheringstatechange', check); check();
    });
    if (this.stopped || this.peers.get(id) !== peer || isClosed() || !peer.pc.localDescription) return;
    if (offer) peer.offerSent = true;
    await this.api.command('signal', this.roomId, { to: id, session: this.session, targetSession: peer.session, description: peer.pc.localDescription.toJSON() });
  }
  async update(status: RoomStatus) {
    if (this.stopped) return;
    // OPS-9: on coordinator restart (epoch change), keep healthy peers with an open DataChannel alive; only abort
    // half-open/connecting peers whose in-flight offers/answers on the old coordinator epoch are gone.
    if (this.status && this.status.epoch !== status.epoch) {
      for (const [id, peer] of [...this.peers]) {
        if (!isLiveOpenPeer(peer.pc.connectionState, peer.pc.iceConnectionState, peer.channel?.readyState)) {
          this.dropPeer(id, peer);
        }
      }
    }
    // OPS-11: store refreshed TURN credentials immediately and push them to existing PCs where supported.
    if (status.iceServers) {
      const nextIceKey = JSON.stringify(status.iceServers);
      if (nextIceKey !== this.iceKey) {
        this.iceServers = status.iceServers;
        this.iceKey = nextIceKey;
        for (const [id, peer] of [...this.peers]) {
          if (peer.iceKey === this.iceKey) continue;
          if (typeof peer.pc.setConfiguration === 'function' && peer.pc.connectionState !== 'closed') {
            try {
              peer.pc.setConfiguration({ iceServers: this.iceServers });
              peer.iceKey = this.iceKey;
            } catch {
              if (peer.pc.connectionState === 'disconnected' || peer.pc.iceConnectionState === 'disconnected') this.dropPeer(id, peer);
            }
          } else if (peer.pc.connectionState === 'disconnected' || peer.pc.iceConnectionState === 'disconnected') {
            this.dropPeer(id, peer);
          }
        }
      }
    }
    this.status = status;
    const now = this.now();
    const devices = (status.devices || []).filter(d => d.id !== this.deviceId);
    const available = devices.filter(d => d.session);
    for (const key of [...this.retiredUfrags.keys()]) {
      const sep = key.indexOf(':'), devId = key.slice(0, sep), sess = key.slice(sep + 1);
      const d = devices.find(x => x.id === devId);
      if (!d || (d.session && d.session !== sess)) this.retiredUfrags.delete(key);
    }
    for (const [id, peer] of [...this.peers]) {
      const device = devices.find(d => d.id === id);
      const sessionChanged = !!device?.session && device.session !== peer.session;
      const liveOpen = isLiveOpenPeer(peer.pc.connectionState, peer.pc.iceConnectionState, peer.channel?.readyState);
      const staleIceDisconnected = !!peer.iceKey && peer.iceKey !== this.iceKey && (peer.pc.connectionState === 'disconnected' || peer.pc.iceConnectionState === 'disconnected');
      if (!device || sessionChanged || (!device.session && !liveOpen) || staleIceDisconnected || this.healthOf(peer, now) === 'drop') {
        this.dropPeer(id, peer);
      }
    }
    this.files.tick();
    const work: Promise<unknown>[] = [];
    for (const signal of dedupeSignals(status.signals || [], available)) {
      const device = available.find(d => d.id === signal.from && d.session === signal.session);
      if (!device) continue;
      work.push((async () => {
        let peer = this.peers.get(device.id);
        if (signal.description.type === 'offer') {
          if (device.id > this.deviceId) return;
          const offerUfrag = sdpIceUfrag(signal.description.sdp);
          if (peer && peer.session === device.session && offerUfrag && peer.remoteUfrag === offerUfrag
            && isLiveOpenPeer(peer.pc.connectionState, peer.pc.iceConnectionState, peer.channel?.readyState)) return;
          if (peer) this.dropPeer(device.id, peer);
          peer = this.peer(device);
          peer.remoteUfrag = offerUfrag;
          try {
            const closed = () => peer!.pc.connectionState === 'closed';
            if (this.stopped || this.peers.get(device.id) !== peer || closed()) return;
            await peer.pc.setRemoteDescription(signal.description);
            if (this.stopped || this.peers.get(device.id) !== peer || closed()) return;
            await this.description(device.id, peer, false);
          } catch (err) {
            if (this.peers.get(device.id) === peer && peer.channel?.readyState !== 'open') this.dropPeer(device.id, peer);
            throw err;
          }
        } else if (signal.description.type === 'answer') {
          if (this.deviceId >= device.id) return;
          if (!peer || peer.session !== device.session || !peer.offerSent || peer.pc.connectionState === 'closed' || peer.pc.signalingState !== 'have-local-offer') return;
          if (!answerMatchesOffer(peer.pc.localDescription?.sdp, signal.description.sdp, this.retiredUfrags.get(`${device.id}:${device.session}`), peer.pc.remoteDescription?.sdp)) return;
          peer.remoteUfrag = sdpIceUfrag(signal.description.sdp);
          await peer.pc.setRemoteDescription(signal.description);
        }
      })());
    }
    for (const device of available) {
      if (this.deviceId < device.id && !this.peers.has(device.id)) {
        const peer = this.peer(device);
        this.connectChannel(peer, device.id, peer.pc.createDataChannel(PRIMARY_CHANNEL_LABEL));
        this.connectFileChannel(peer, device.id, peer.pc.createDataChannel(FILE_CHANNEL_LABEL));
        work.push(this.description(device.id, peer, true).catch(err => {
          if (this.peers.get(device.id) === peer && peer.channel?.readyState !== 'open') this.dropPeer(device.id, peer);
          throw err;
        }));
      }
    }
    const results = await Promise.allSettled(work);
    for (const result of results) if (result.status === 'rejected' && !this.stopped) this.error('Peer connection interrupted. Reconnecting automatically.');
    this.tick();
    this.flush(); this.notify();
  }
  private disconnect() {
    for (const [id, peer] of [...this.peers]) this.dropPeer(id, peer);
    this.peers.clear();
  }
  stop() {
    this.stopped = true; this.disconnect();
    // No file is fetched for a stopped engine: another owner, if any, fetches what the room needs.
    this.files.keep(() => false);
    if (this.receiptTimer) { clearTimeout(this.receiptTimer); this.receiptTimer = undefined; void this.transaction(() => this.writeReceipts()).catch(() => {}); }
    for (const url of this.urls.values()) URL.revokeObjectURL(url); this.urls.clear();
  }
  /**
   * Stop, then wait for every write this engine had started (history, receipts, board, files), so another owner of
   * the room in this browser (a tab taking it into the foreground) loads everything and never races a late write.
   */
  async close() {
    this.stop();
    for (let serial = this.serial, files = this.fileSerial; ; serial = this.serial, files = this.fileSerial) {
      await serial; await files;
      if (serial === this.serial && files === this.fileSerial) return;
    }
  }
}
