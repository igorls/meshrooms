import type { Task } from '../collab';
import { COMPACT_AT, MAX_TASK_OPS, compactBoard, foldBoard, syncChunks, taskBody, validTaskBody, type TaskBody, type TaskChange, type TaskPacket } from './board';
import { verify, type BrowserDevice, type RoomStatus } from './protocol';
import { BrowserApi } from './client';
import {
  MAX_DECISION_OPS, admissible, castVote, decisionChunks, nextVoteRevision, openDecision, reviseDecision, validDecisionBody, validVoteBody,
  type Decision, type DecisionBody, type DecisionPacket, type VoteBody,
} from './decisions';
import { FileTransfers, IMAGE_TYPES, MAX_MESSAGE_ATTACHMENTS, attachmentText, isFilePacket, retainedFiles, validAttachments, type AttachmentRef, type TransferState } from './files';
import { read, sign, update, write } from './storage';
import { isActivityPacket, receiveActivity, validActivityPacket, type ActivityRecord } from './activity';

/** `replyTo` and `attachments` are optional so browsers from before them keep verifying and storing these packets. */
type MessageBody = { kind: 'message'; roomId: string; id: string; deviceId: string; memberId: string; text: string; at: number; replyTo?: string; attachments?: AttachmentRef[] };
const isId = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
type ReceiptBody = { kind: 'receipt'; roomId: string; id: string; deviceId: string };
type Packet = { body: MessageBody | ReceiptBody | TaskPacket['body'] | DecisionBody | VoteBody; signature: string };
export type SavedMessage = { packet: Packet & { body: MessageBody }; targets: string[]; receipts: string[] };
type Peer = { pc: RTCPeerConnection; session: string; channel?: RTCDataChannel; started: number };
/** A file of this room as this browser sees it: a blob URL once verified and stored, else how fetching goes. */
export type FileView = { url?: string; type?: string; transfer?: TransferState };
/** Stored files by hash, with the type sniffed from their bytes. */
type FileIndex = Record<string, { size: number; type: string }>;

/** Real browser data channels; the lobby carries connection descriptions only. */
export class BrowserPeers {
  private peers = new Map<string, Peer>();
  private status?: RoomStatus;
  private messages: SavedMessage[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private pendingIncoming = 0;
  private key: string;
  private boardKey: string;
  private ops: TaskPacket[] = [];
  private decisionKey: string;
  private decisionOps: DecisionPacket[] = [];
  private filesKey: string;
  private index: FileIndex = {};
  private refs = new Map<string, AttachmentRef>();
  private retained = new Map<string, AttachmentRef>();
  private urls = new Map<string, string>();
  private fileSerial: Promise<unknown> = Promise.resolve();
  private files: FileTransfers;
  /** Latest activity per agent device with an open channel; memory only, dropped when the channel closes. */
  private activity = new Map<string, ActivityRecord>();
  constructor(private api: BrowserApi, private roomId: string, private deviceId: string, private session: string,
    private changed: (messages: SavedMessage[], connected: string[], added?: SavedMessage) => void, private error: (message: string) => void,
    private boardChanged: (tasks: Task[], ops: TaskBody[]) => void = () => {}, private filesChanged: (files: Record<string, FileView>) => void = () => {},
    private activityChanged: (activity: Record<string, ActivityRecord>) => void = () => {},
    private decisionsChanged: (ops: (DecisionBody | VoteBody)[]) => void = () => {}) {
    this.key = `messages:${deviceId}:${roomId}`;
    this.boardKey = `board:${deviceId}:${roomId}`;
    this.decisionKey = `decisions:${deviceId}:${roomId}`;
    this.filesKey = `files:${deviceId}:${roomId}`;
    this.files = new FileTransfers({ roomId, referenced: sha => this.refs.get(sha), changed: () => this.notifyFiles(),
      store: { has: sha => sha in this.index, get: sha => this.readFile(sha), put: (sha, bytes, type) => this.storeFile(sha, bytes, type) },
      channel: id => this.peers.get(id)?.channel,
      peers: () => [...this.peers].filter(([id, p]) => p.channel?.readyState === 'open' && this.status?.devices?.some(d => d.id === id)).map(([id]) => id) });
  }
  async load() {
    this.messages = await read<SavedMessage[]>(this.key) || []; this.ops = await read<TaskPacket[]>(this.boardKey) || [];
    this.decisionOps = await read<DecisionPacket[]>(this.decisionKey) || [];
    this.index = await read<FileIndex>(this.filesKey) || {};
    for (const sha of Object.keys(this.index)) await this.fileUrl(sha);
    this.notify(); this.notifyBoard(); this.notifyDecisions(); this.syncFiles();
  }
  private fileKey(sha: string) { return `file:${this.deviceId}:${this.roomId}:${sha}`; }
  private fileChain<T>(work: () => Promise<T>): Promise<T> { const next = this.fileSerial.then(work); this.fileSerial = next.catch(() => {}); return next; }
  private async readFile(sha: string) {
    const blob = await read<Blob>(this.fileKey(sha));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  }
  /** Stored as a Blob, which browsers keep on disk; only verified raster images carry an image type. */
  private storeFile(sha: string, bytes: Uint8Array, type: string) {
    return this.fileChain(async () => {
      const next = { ...this.index, [sha]: { size: bytes.length, type } };
      await update([[this.fileKey(sha), new Blob([bytes as BlobPart], { type: IMAGE_TYPES.includes(type) ? type : 'application/octet-stream' })], [this.filesKey, next]]);
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
      await update([[this.filesKey, next]], evicted.map(sha => this.fileKey(sha)));
      this.index = next;
      for (const sha of evicted) { const url = this.urls.get(sha); if (url) URL.revokeObjectURL(url); this.urls.delete(sha); }
      this.notifyFiles();
    }).catch(e => this.error(e.message));
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
    const fresh = incoming.filter(op => !this.ops.some(known => known.body.id === op.body.id));
    if (!fresh.length) return;
    let next = [...this.ops, ...fresh];
    // Compaction keeps the same board with fewer operations; only a large board needs it.
    if (next.length > COMPACT_AT) next = compactBoard(next);
    if (next.length > MAX_TASK_OPS) throw new Error('This room’s task board is full in this preview.');
    await write(this.boardKey, next); this.ops = next; this.notifyBoard();
  }
  /** Create a task (no current), change one, or remove it. Signed here and sent to every connected device. */
  async changeTask(change: TaskChange, current?: Task, removed = false) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before changing tasks.');
      const body = taskBody({ roomId: this.roomId, deviceId: this.deviceId, memberId: this.status.memberId, current, change, removed });
      const packet: TaskPacket = { body, signature: await sign(body) };
      await this.addOps([packet]);
      for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') { try { peer.channel.send(JSON.stringify(packet)); } catch { /* The board is exchanged again on reconnect. */ } }
    });
  }
  /** Operations relayed in a board exchange are checked against each author's own device, not the sender's. */
  private async acceptBoard(sync: { roomId?: unknown; ops?: unknown }) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const accepted: TaskPacket[] = [];
    for (const op of sync.ops as TaskPacket[]) {
      // A change by someone who has since left still verifies against the key the room service keeps for them.
      const author = this.status?.devices?.find(d => d.id === op?.body?.deviceId) ?? this.status?.formerDevices?.find(d => d.id === op?.body?.deviceId);
      if (!author || !validTaskBody(op.body, this.roomId) || op.body.memberId !== author.memberId || typeof op.signature !== 'string') continue;
      if (await verify(author.publicKey, op.body, op.signature)) accepted.push({ body: op.body, signature: op.signature });
    }
    await this.addOps(accepted);
  }
  private sendBoard(channel: RTCDataChannel) {
    for (const chunk of syncChunks(this.roomId, this.ops)) { try { channel.send(JSON.stringify(chunk)); } catch { return; } }
  }
  private notifyDecisions() { if (!this.stopped) this.decisionsChanged(this.decisionOps.map(op => op.body)); }
  /** Keeps decision operations we have not seen; a full log refuses new ones rather than dropping live state. */
  private async addDecisionOps(incoming: DecisionPacket[]) {
    const known = new Set(this.decisionOps.map(op => op.body.id));
    const fresh = incoming.filter(op => !known.has(op.body.id) && (known.add(op.body.id), true));
    if (!fresh.length) return;
    if (this.decisionOps.length + fresh.length > MAX_DECISION_OPS) throw new Error('This room’s decisions log is full in this preview.');
    const next = [...this.decisionOps, ...fresh];
    await write(this.decisionKey, next); this.decisionOps = next; this.notifyDecisions();
  }
  private async publishDecision(body: DecisionBody | VoteBody) {
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
    // Votes only for decisions held (or arriving alongside), and a per-member cap, before any signature work.
    const admitted = new Set(admissible(this.decisionOps.map(op => op.body), candidates.map(op => op.body)));
    const accepted: DecisionPacket[] = [];
    for (const op of candidates) {
      const b = op.body;
      if (!admitted.has(b)) continue;
      const author = this.status?.devices?.find(d => d.id === b.deviceId) ?? this.status?.formerDevices?.find(d => d.id === b.deviceId);
      if (!author || b.memberId !== author.memberId) continue;
      if (await verify(author.publicKey, b, op.signature)) accepted.push({ body: b, signature: op.signature });
    }
    await this.addDecisionOps(accepted);
  }
  private sendDecisions(channel: RTCDataChannel) {
    for (const chunk of decisionChunks(this.roomId, this.decisionOps)) { try { channel.send(JSON.stringify(chunk)); } catch { return; } }
  }
  private notifyActivity() { if (!this.stopped) this.activityChanged(Object.fromEntries(this.activity)); }
  private forget(id: string) { if (this.activity.delete(id)) this.notifyActivity(); }
  /** Only an agent's own device speaks for it, on its own channel. */
  private acceptActivity(id: string, packet: unknown) {
    const device = this.status?.devices?.find(d => d.id === id);
    if (!device || this.status?.members?.find(m => m.id === device.memberId)?.role !== 'agent' || !validActivityPacket(packet, this.roomId)) return;
    this.activity.set(id, receiveActivity(packet)); this.notifyActivity();
  }
  private notify(added?: SavedMessage) { if (!this.stopped) this.changed([...this.messages], [...this.peers].filter(([, p]) => p.channel?.readyState === 'open').map(([id]) => id), added); }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work); this.serial = next.catch(() => {}); return next;
  }
  private async save(messages: SavedMessage[]) {
    const added = messages.length > this.messages.length ? messages.at(-1) : undefined;
    await write(this.key, messages); this.messages = messages; this.notify(added);
    if (added?.packet.body.attachments) this.syncFiles();
  }
  /** Files are stored here before the message that names them, so this browser can serve them as soon as peers ask. */
  async send(text: string, replyTo?: string, files: { ref: AttachmentRef; bytes: Uint8Array }[] = []) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before sending.');
      if ((!text.trim() && !files.length) || text.length > 4000) throw new Error('Write a message of up to 4,000 characters.');
      if (files.length > MAX_MESSAGE_ATTACHMENTS) throw new Error(`Attach up to ${MAX_MESSAGE_ATTACHMENTS} files per message.`);
      const attachments = files.map(f => f.ref);
      if (files.length && !validAttachments(attachments)) throw new Error('These files cannot be attached. Remove them and attach them again.');
      if (this.messages.length >= 1000) throw new Error('This preview has reached its local history limit.');
      if (replyTo !== undefined && !this.messages.some(m => m.packet.body.id === replyTo)) throw new Error('The message you replied to is not in this browser.');
      for (const { ref, bytes } of files) if (!this.index[ref.sha256]) await this.storeFile(ref.sha256, bytes, ref.type);
      const body: MessageBody = { kind: 'message', roomId: this.roomId, id: crypto.randomUUID(), deviceId: this.deviceId, memberId: this.status.memberId,
        text: text.trim() || attachmentText(attachments), at: Date.now(), ...(replyTo ? { replyTo } : {}), ...(files.length ? { attachments } : {}) };
      const packet = { body, signature: await sign(body) };
      const saved: SavedMessage = { packet, targets: this.status.devices!.filter(d => d.id !== this.deviceId).map(d => d.id), receipts: [] };
      await this.save([...this.messages, saved]); this.flush();
    });
  }
  private flush() {
    for (const [id, peer] of this.peers) {
      if (peer.channel?.readyState !== 'open') continue;
      let sent = 0;
      for (const message of this.messages) {
        if (sent >= 16) break;
        if (peer.channel.bufferedAmount > 256_000) break;
        if (message.packet.body.deviceId === this.deviceId && message.targets.includes(id) && !message.receipts.includes(id)) {
          try { peer.channel.send(JSON.stringify(message.packet)); sent++; } catch { break; } // Persisted outbox retries on the next connection.
        }
      }
    }
  }
  private connectChannel(peer: Peer, id: string, channel: RTCDataChannel) {
    peer.channel = channel;
    channel.onopen = () => { this.flush(); this.sendBoard(channel); this.sendDecisions(channel); this.files.opened(id); this.notify(); };
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
      if (this.pendingIncoming >= 64) return;
      this.pendingIncoming++;
      void this.transaction(async () => {
        if (this.stopped || !this.status?.memberId || this.peers.get(id) !== peer) return;
        const device = this.status.devices?.find(d => d.id === id); if (!device) return;
        if ((packet as unknown as { kind?: unknown })?.kind === 'board') { await this.acceptBoard(packet as never); return; }
        if ((packet as unknown as { kind?: unknown })?.kind === 'decisions') { await this.acceptDecisions(packet as never); return; }
        const b = packet?.body;
        if (!b || b.roomId !== this.roomId || b.deviceId !== id || !isId(b.id) || typeof packet.signature !== 'string' || !await verify(device.publicKey, b, packet.signature)) return;
        if (b.kind === 'message') {
          if (b.memberId !== device.memberId || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at) || b.at < 0 || b.at > 8_640_000_000_000_000) return;
          // The replied-to message may predate this browser's admission, so only its form is checked.
          if (b.replyTo !== undefined && !isId(b.replyTo)) return;
          if (b.attachments !== undefined && !validAttachments(b.attachments)) return;
          const existing = this.messages.find(m => m.packet.body.id === b.id);
          if (existing && JSON.stringify(existing.packet.body) !== JSON.stringify(b)) return;
          if (!existing) {
            if (this.messages.length >= 1000) throw new Error('Browser history is full. New messages could not be stored.');
            await this.save([...this.messages, { packet: packet as SavedMessage['packet'], targets: [], receipts: [] }]);
          }
          // A receipt means an IndexedDB transaction completed, not that a person read it.
          const receipt: ReceiptBody = { kind: 'receipt', roomId: this.roomId, id: b.id, deviceId: this.deviceId };
          if (channel.readyState === 'open') channel.send(JSON.stringify({ body: receipt, signature: await sign(receipt) }));
        } else if (b.kind === 'receipt') {
          const m = this.messages.find(m => m.packet.body.id === b.id && m.packet.body.deviceId === this.deviceId);
          if (m?.targets.includes(id) && !m.receipts.includes(id)) await this.save(this.messages.map(x => x === m ? { ...x, receipts: [...x.receipts, id] } : x));
        } else if (b.kind === 'task') {
          if (validTaskBody(b, this.roomId) && b.memberId === device.memberId) await this.addOps([{ body: b, signature: packet.signature }]);
        } else if (b.kind === 'decision' || b.kind === 'vote') {
          if ((validDecisionBody(b, this.roomId) || validVoteBody(b, this.roomId)) && b.memberId === device.memberId
            && admissible(this.decisionOps.map(op => op.body), [b]).length) await this.addDecisionOps([{ body: b, signature: packet.signature }]);
        }
      }).catch(e => this.error(e.message)).finally(() => { this.pendingIncoming--; });
    };
  }
  private peer(device: BrowserDevice & { session?: string }) {
    const pc = new RTCPeerConnection({ iceServers: this.status?.iceServers || [] });
    const peer: Peer = { pc, session: device.session!, started: Date.now() };
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
    this.flush(); this.notify();
  }
  private disconnect() {
    const ids = [...this.peers.keys()];
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear(); for (const id of ids) { this.files.closed(id); this.forget(id); }
  }
  stop() { this.stopped = true; this.disconnect(); for (const url of this.urls.values()) URL.revokeObjectURL(url); this.urls.clear(); }
}
