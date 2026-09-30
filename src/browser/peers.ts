import type { Task } from '../collab';
import { COMPACT_AT, MAX_TASK_OPS, compactBoard, foldBoard, syncChunks, taskBody, validTaskBody, withinRevisionJump, type TaskBody, type TaskChange, type TaskPacket } from './board';
import { verify, type BrowserDevice, type RoomStatus } from './protocol';
import { BrowserApi } from './client';
import {
  COMPACT_DECISIONS_AT, MAX_DECISION_OPS, admissible, castVote, compactDecisions, decisionChunks, nextVoteRevision, openDecision, reviseDecision, validDecisionBody, validVoteBody,
  type Decision, type DecisionBody, type DecisionPacket, type VoteBody,
} from './decisions';
import { FileTransfers, IMAGE_TYPES, MAX_MESSAGE_ATTACHMENTS, attachmentText, isFilePacket, retainedFiles, validAttachments, type AttachmentRef, type TransferState } from './files';
import {
  COMPACT_REACTIONS_AT, MAX_REACTION_KEYS_PER_MEMBER, MAX_REACTION_OPS, compactReactions, currentRevision,
  foldReactions, isReactionEmoji, liveKeysForMember, mayHoldPending, memberReacted, reactionSyncChunks, validReactionBody, withinReactionKeyCap,
  type ReactionChip, type ReactionEmoji, type ReactionPacket,
} from './reactions';
import { FenceError, StorageError, read, sign, update, type Fence } from './storage';
import { isActivityPacket, receiveActivity, validActivityPacket, type ActivityRecord } from './activity';
import { awaitingDelivery, windowHistory } from './history';
import { IncomingGate, PACE_LOW_WATER, Resync, SYNC_REQUEST, SendQueue, isSyncRequest, type SyncRequest } from './pacer';
import { QuotaDrops, ReceiveQuota, type QuotaKind } from './quota';

/** `replyTo` and `attachments` are optional so browsers from before them keep verifying and storing these packets. */
type MessageBody = { kind: 'message'; roomId: string; id: string; deviceId: string; memberId: string; text: string; at: number; replyTo?: string; attachments?: AttachmentRef[] };
const isId = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
type ReceiptBody = { kind: 'receipt'; roomId: string; id: string; deviceId: string };
type Packet = { body: MessageBody | ReceiptBody | TaskPacket['body'] | DecisionBody | VoteBody | ReactionPacket['body']; signature: string };
export type SavedMessage = { packet: Packet & { body: MessageBody }; targets: string[]; receipts: string[] };
/**
 * `sent`: when each outbox message was last sent on this connection, so an unconfirmed one isn't resent every tick.
 * `queue` paces this device's board, decisions and reactions onto the channel; `resync` answers the peer's requests for them.
 */
type Peer = { pc: RTCPeerConnection; session: string; channel?: RTCDataChannel; started: number; sent: Map<string, number>; queue?: SendQueue; resync: Resync };
/** An unconfirmed message is sent to a peer again after this long. */
const RESEND_MS = 5000;
/** A file of this room as this browser sees it: a blob URL once verified and stored, else how fetching goes. */
export type FileView = { url?: string; type?: string; transfer?: TransferState };
/** Stored files by hash, with the type sniffed from their bytes. */
type FileIndex = Record<string, { size: number; type: string }>;

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
  private filesKey: string;
  private index: FileIndex = {};
  private refs = new Map<string, AttachmentRef>();
  private retained = new Map<string, AttachmentRef>();
  private urls = new Map<string, string>();
  private fileSerial: Promise<unknown> = Promise.resolve();
  private files: FileTransfers;
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
    private reactionsChanged: (chips: ReactionChip[]) => void = () => {}) {
    this.key = `messages:${deviceId}:${roomId}`;
    this.boardKey = `board:${deviceId}:${roomId}`;
    this.decisionKey = `decisions:${deviceId}:${roomId}`;
    this.reactionKey = `reactions:${deviceId}:${roomId}`;
    this.filesKey = `files:${deviceId}:${roomId}`;
    this.files = new FileTransfers({ roomId, referenced: sha => this.refs.get(sha), changed: () => this.notifyFiles(),
      store: { has: sha => sha in this.index, get: sha => this.readFile(sha), put: (sha, bytes, type) => this.storeFile(sha, bytes, type) },
      channel: id => this.peers.get(id)?.channel,
      peers: () => [...this.peers].filter(([id, p]) => p.channel?.readyState === 'open' && this.status?.devices?.some(d => d.id === id)).map(([id]) => id) });
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
    this.messages = await read<SavedMessage[]>(this.key) || []; this.ops = await read<TaskPacket[]>(this.boardKey) || [];
    this.decisionOps = await read<DecisionPacket[]>(this.decisionKey) || [];
    this.reactionOps = await read<ReactionPacket[]>(this.reactionKey) || [];
    this.index = await read<FileIndex>(this.filesKey) || {};
    for (const sha of Object.keys(this.index)) await this.fileUrl(sha);
    this.notify(); this.notifyBoard(); this.notifyDecisions(); this.notifyReactions(); this.syncFiles();
  }
  private notifyReactions() { if (!this.stopped) this.reactionsChanged(foldReactions(this.reactionOps.map(op => op.body))); }
  chips() { return foldReactions(this.reactionOps.map(op => op.body)); }
  private fileKey(sha: string) { return `file:${this.deviceId}:${this.roomId}:${sha}`; }
  private fileChain<T>(work: () => Promise<T>): Promise<T> { const next = this.fileSerial.then(work); this.fileSerial = next.catch(() => {}); return next; }
  private async readFile(sha: string) {
    const blob = await read<Blob>(this.fileKey(sha));
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
    const blob = await read<Blob>(this.fileKey(sha));
    if (blob && !this.stopped) this.urls.set(sha, URL.createObjectURL(blob));
  }
  /** Fetch the files this browser keeps for the room and evict the rest (see retainedFiles). */
  private syncFiles() {
    const lists = this.messages.map(m => m.packet.body.attachments);
    this.refs = new Map(lists.flatMap(list => list || []).map(ref => [ref.sha256, ref]));
    this.retained = retainedFiles(lists);
    this.files.keep(sha => this.retained.has(sha));
    for (const ref of this.retained.values()) this.files.want(ref);
    if (Object.keys(this.index).some(sha => !this.retained.has(sha))) void this.fileChain(async () => {
      const evicted = Object.keys(this.index).filter(sha => !this.retained.has(sha));
      const next = Object.fromEntries(Object.entries(this.index).filter(([sha]) => this.retained.has(sha)));
      await this.put([[this.filesKey, next]], evicted.map(sha => this.fileKey(sha)));
      this.index = next;
      for (const sha of evicted) { const url = this.urls.get(sha); if (url) URL.revokeObjectURL(url); this.urls.delete(sha); }
      this.notifyFiles();
    }).catch(e => this.fail(e));
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
    // A revision far past the held ones would freeze the task at the revision cap (see MAX_REVISION_JUMP).
    const fresh = withinRevisionJump(this.ops.map(op => op.body), incoming.filter(op => !this.ops.some(known => known.body.id === op.body.id)));
    if (!fresh.length) return;
    let next = [...this.ops, ...fresh];
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
      const packet: TaskPacket = { body, signature: await sign(body) };
      await this.addOps([packet]);
      for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') { try { peer.channel.send(JSON.stringify(packet)); } catch { /* The board is exchanged again on reconnect. */ } }
    });
  }
  private async addReactionOps(incoming: ReactionPacket[]) {
    const held = new Set(this.messages.map(m => m.packet.body.id));
    let ready: ReactionPacket[] = [];
    for (const op of incoming) {
      if (this.reactionOps.some(known => known.body.id === op.body.id) || this.pendingReactions.some(known => known.body.id === op.body.id)) continue;
      if (held.has(op.body.messageId)) ready.push(op);
      else if (mayHoldPending(this.pendingReactions, op)) this.pendingReactions.push(op);
    }
    // Each member keeps at most MAX_REACTION_KEYS_PER_MEMBER live reactions here too, not only when sending.
    ready = withinReactionKeyCap(this.reactionOps.map(op => op.body), ready);
    if (!ready.length) return;
    let next = [...this.reactionOps, ...ready];
    if (next.length > COMPACT_REACTIONS_AT) next = compactReactions(next);
    if (next.length > MAX_REACTION_OPS) throw new Error('This room’s reactions log is full in this preview.');
    await this.put([[this.reactionKey, next]]); this.reactionOps = next; this.notifyReactions();
  }
  private async flushPendingReactions(messageId: string) {
    const due = this.pendingReactions.filter(op => op.body.messageId === messageId);
    if (!due.length) return;
    this.pendingReactions = this.pendingReactions.filter(op => op.body.messageId !== messageId);
    await this.addReactionOps(due);
  }
  /** Toggle one of the fixed emoji on a message. Humans and agents use the same path. */
  async react(messageId: string, emoji: ReactionEmoji) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before reacting.');
      if (!isReactionEmoji(emoji)) throw new Error('Choose one of the room’s reaction emoji.');
      if (!this.messages.some(m => m.packet.body.id === messageId)) throw new Error('That message is not in this browser.');
      const bodies = this.reactionOps.map(op => op.body);
      const remove = memberReacted(this.chips(), messageId, emoji, this.status.memberId);
      if (!remove && liveKeysForMember(bodies, this.status.memberId) >= MAX_REACTION_KEYS_PER_MEMBER) {
        throw new Error('You have too many reactions in this room. Remove some before adding more.');
      }
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
  private async acceptReactions(sync: { roomId?: unknown; ops?: unknown }) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const accepted: ReactionPacket[] = [];
    // Held operations are skipped before their signatures are checked, so a repeated exchange costs little.
    const held = new Set([...this.reactionOps, ...this.pendingReactions].map(op => op.body.id));
    for (const op of sync.ops as ReactionPacket[]) {
      if (held.has(op?.body?.id)) continue;
      const author = this.status?.devices?.find(d => d.id === op?.body?.deviceId) ?? this.status?.formerDevices?.find(d => d.id === op?.body?.deviceId);
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
      // A change by someone who has since left still verifies against the key the room service keeps for them.
      const author = this.status?.devices?.find(d => d.id === op?.body?.deviceId) ?? this.status?.formerDevices?.find(d => d.id === op?.body?.deviceId);
      if (!author || !validTaskBody(op.body, this.roomId) || op.body.memberId !== author.memberId || typeof op.signature !== 'string') continue;
      if (await verify(author.publicKey, op.body, op.signature)) accepted.push({ body: op.body, signature: op.signature });
    }
    await this.addOps(accepted);
  }
  /** This device's board, decisions and reactions, paced onto the peer's channel (on open, and when it asks again). */
  private sendState(peer: Peer) {
    if (!peer.queue) return;
    peer.resync.sent();
    const chunks = [...syncChunks(this.roomId, this.ops), ...decisionChunks(this.roomId, this.decisionOps), ...reactionSyncChunks(this.roomId, this.reactionOps)];
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
      const author = this.status?.devices?.find(d => d.id === b.deviceId) ?? this.status?.formerDevices?.find(d => d.id === b.deviceId);
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
    const stored = kept.at(-1) === added;
    this.notify(stored ? added : undefined);
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
  private connectChannel(peer: Peer, id: string, channel: RTCDataChannel) {
    peer.channel = channel;
    const queue = peer.queue = new SendQueue(channel);
    channel.bufferedAmountLowThreshold = PACE_LOW_WATER;
    channel.addEventListener('bufferedamountlow', () => queue.pump());
    channel.onopen = () => { this.flush(); this.sendState(peer); this.files.opened(id); this.notify(); };
    channel.onclose = () => { if (this.peers.get(id) === peer) { this.files.closed(id); this.forget(id); } this.notify(); };
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 20_000) return;
      let packet: Packet;
      try { packet = JSON.parse(event.data); } catch { return; }
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
        const b = packet?.body;
        if (!b || b.roomId !== this.roomId || b.deviceId !== id || !isId(b.id) || typeof packet.signature !== 'string' || !await verify(device.publicKey, b, packet.signature)) return;
        if (b.kind === 'message') {
          if (b.memberId !== device.memberId || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at) || b.at < 0 || b.at > 8_640_000_000_000_000) return;
          // The replied-to message may predate this browser's admission, so only its form is checked.
          if (b.replyTo !== undefined && !isId(b.replyTo)) return;
          if (b.attachments !== undefined && !validAttachments(b.attachments)) return;
          const existing = this.messages.find(m => m.packet.body.id === b.id);
          if (existing && JSON.stringify(existing.packet.body) !== JSON.stringify(b)) return;
          // Past the rolling window the oldest messages make room, so a new one is always stored and confirmed.
          if (!existing) {
            if (!this.allowed(device.memberId, 'message', id)) return; // Unconfirmed, so its sender retries later.
            await this.save({ packet: packet as SavedMessage['packet'], targets: [], receipts: [] });
          }
          // A receipt means an IndexedDB transaction completed, not that a person read it.
          const receipt: ReceiptBody = { kind: 'receipt', roomId: this.roomId, id: b.id, deviceId: this.deviceId };
          if (channel.readyState === 'open') channel.send(JSON.stringify({ body: receipt, signature: await sign(receipt) }));
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
        }
      }).catch(e => this.fail(e)).finally(() => { for (const from of this.incoming.done()) this.requestSync(from); });
    };
  }
  private resyncDue(peer: Peer) { if (peer.queue && peer.resync.due(peer.queue)) this.sendState(peer); }
  /** Each status poll: pump paced sends, answer due resync requests, and ask peers for state dropped over quota. */
  private tick() {
    for (const peer of this.peers.values()) { peer.queue?.pump(); this.resyncDue(peer); }
    for (const id of this.quotaDrops.due()) this.requestSync(id);
  }
  private peer(device: BrowserDevice & { session?: string }) {
    const pc = new RTCPeerConnection({ iceServers: this.status?.iceServers || [] });
    const peer: Peer = { pc, session: device.session!, started: Date.now(), sent: new Map(), resync: new Resync() };
    this.peers.set(device.id, peer);
    pc.ondatachannel = event => this.connectChannel(peer, device.id, event.channel);
    pc.onconnectionstatechange = () => this.notify();
    return peer;
  }
  private async description(id: string, peer: Peer, offer: boolean) {
    await peer.pc.setLocalDescription(offer ? await peer.pc.createOffer() : await peer.pc.createAnswer());
    if (peer.pc.iceGatheringState !== 'complete') await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); peer.pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (peer.pc.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, 4000); peer.pc.addEventListener('icegatheringstatechange', check); check();
    });
    if (this.stopped || this.peers.get(id) !== peer) return;
    await this.api.command('signal', this.roomId, { to: id, session: this.session, targetSession: peer.session, description: peer.pc.localDescription!.toJSON() });
  }
  async update(status: RoomStatus) {
    if (this.stopped) return;
    if (this.status && this.status.epoch !== status.epoch) this.disconnect();
    this.status = status;
    const available = (status.devices || []).filter(d => d.id !== this.deviceId && d.session);
    for (const [id, peer] of this.peers) {
      if (!available.some(d => d.id === id && d.session === peer.session) || ['failed', 'closed'].includes(peer.pc.connectionState) || (peer.pc.connectionState !== 'connected' && Date.now() - peer.started > 20_000)) {
        peer.pc.close(); this.peers.delete(id); this.files.closed(id); this.forget(id);
      }
    }
    this.files.tick();
    const work: Promise<unknown>[] = [];
    for (const signal of status.signals || []) {
      const device = available.find(d => d.id === signal.from && d.session === signal.session);
      if (!device) continue;
      work.push((async () => {
        let peer = this.peers.get(device.id);
        if (signal.description.type === 'offer') {
          if (device.id > this.deviceId) return;
          if (peer) { peer.pc.close(); this.files.closed(device.id); this.forget(device.id); } peer = this.peer(device);
          await peer.pc.setRemoteDescription(signal.description);
          await this.description(device.id, peer, false);
        } else if (peer?.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription(signal.description);
      })());
    }
    for (const device of available) {
      if (this.deviceId < device.id && !this.peers.has(device.id)) {
        const peer = this.peer(device); this.connectChannel(peer, device.id, peer.pc.createDataChannel('meshrooms-browser-v1'));
        work.push(this.description(device.id, peer, true));
      }
    }
    const results = await Promise.allSettled(work);
    for (const result of results) if (result.status === 'rejected' && !this.stopped) this.error('Peer connection interrupted. Reconnecting automatically.');
    this.tick();
    this.flush(); this.notify();
  }
  private disconnect() {
    const ids = [...this.peers.keys()];
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear(); for (const id of ids) { this.files.closed(id); this.forget(id); }
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
