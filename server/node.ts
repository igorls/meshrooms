import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import type { Attachment, Draft, NodeSnapshot, Participant, RoomSnapshot } from '../src/room';
import { memoryBlobs, type BlobStore } from './blobs';
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_PENDING_ATTACHMENTS, MAX_ROOM_ATTACHMENTS, MAX_ROOM_ATTACHMENT_BYTES, PENDING_ATTACHMENT_MS,
  cleanName, defaultName, normalizeAttachment, sniff } from './attachments';
import { DEFAULT_FLOOR, FLOORS, TASK_STATUSES, mayAgentSpeak, mentionedIds, reservedName, type Floor, type Task } from '../src/collab';
import type { SetupCommand, PendingRoom } from '../src/setup';
import type { DurableStore } from './persistence/store';
import { CATALOG, CATALOG_V1, MAX_BOARD_RECEIPTS, MAX_ROOMS, MAX_MESSAGES, MAX_HISTORY_BYTES, MAX_TASKS, attachmentsKey, boardKey, fingerprint, historyKey, isHash, isUuid,
  migrateV1, migrateV2, recover, tokenHash, validAttachmentIndex, validBoard, validCatalog, validHistory, type AttachmentIndex, type AttachmentRecord, type Board, type Catalog, type History, type Principal, type RoomRecord, type StoredMessage } from './model';
import { parseDescriptor, type RoomDescriptor } from './peer-model';
export type { Principal } from './model';

export class NodeError extends Error { constructor(public status: number, message: string) { super(message); } }
export function requestId(value: unknown): string {
  if (!isUuid(value)) throw new NodeError(400, 'A UUID requestId is required. Reuse it when retrying the same command.');
  return value.toLowerCase();
}
/** A participant name; `agents` is reserved because `@agents` addresses every agent. */
function personName(value: unknown, name: string): string {
  const result = text(value, name, 64);
  if (reservedName(result)) throw new NodeError(400, '"agents" is reserved: @agents addresses every agent. Choose another name.');
  return result;
}
function text(value: unknown, name: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new NodeError(400, `Enter ${name} up to ${max} characters.`);
  return value.trim();
}

const emptyBoard = (roomId: string): Board => ({ version: 1, roomId, revision: 0, tasks: [], receipts: [] });
const emptyAttachments = (roomId: string): AttachmentIndex => ({ version: 1, roomId, files: [] });
const publicAttachment = (record: AttachmentRecord): Attachment => normalizeAttachment(record);

export class LocalNode {
  private catalog: Catalog;
  private histories = new Map<string, History>();
  private boards = new Map<string, Board>();
  private attachments = new Map<string, AttachmentIndex>();
  private listeners = new Set<() => void>();
  private leases = new Map<string, number>();
  private connections = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;
  private storageFailure = false;
  private closed = false;

  constructor(private readonly store: DurableStore, private readonly blobs: BlobStore = memoryBlobs()) {
    const raw = store.read(CATALOG);
    let writeCatalog = false;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.version === 2) { this.catalog = migrateV2(parsed); writeCatalog = true; }
        else this.catalog = recover<Catalog>(raw, 'node catalog', validCatalog);
      } catch { throw new Error('Cannot recover node catalog: invalid stored data. The store has not been reset.'); }
    }
    else {
      const legacy = store.read(CATALOG_V1);
      if (legacy !== null) {
        try { this.catalog = migrateV1(JSON.parse(legacy), hostname().slice(0, 64) || 'This machine'); }
        catch { throw new Error('Cannot recover node catalog: invalid stored data. The store has not been reset.'); }
      } else {
        const owner: Participant = { id: randomUUID(), name: 'You', role: 'human', state: 'local', detail: 'Local participant · room member' };
        this.catalog = { version: 3, nodeId: randomUUID(), ownerId: owner.id, participants: [owner], rooms: [],
          settings: { completed: false, machineName: hostname().slice(0, 64) || 'This machine', startAtLogin: false }, intents: [], setupReceipts: [] };
      }
      writeCatalog = true;
    }
    // Validate every old history before publishing the migrated catalog. Legacy records stay intact.
    for (const room of this.catalog.rooms) {
      const history = store.read(historyKey(room.id));
      if (history === null || Buffer.byteLength(history) > MAX_HISTORY_BYTES) throw new Error(`Cannot recover room ${room.id}: history is missing or too large. The store has not been reset.`);
      this.histories.set(room.id, recover<History>(history, `room ${room.id}`, value => validHistory(value, room, this.catalog.participants)));
      // Rooms created before the task board have no board record; it is written on the first task command.
      const board = store.read(boardKey(room.id));
      this.boards.set(room.id, board === null ? emptyBoard(room.id)
        : recover<Board>(board, `room ${room.id} task board`, value => validBoard(value, room, this.catalog.participants)));
      const files = store.read(attachmentsKey(room.id));
      this.attachments.set(room.id, files === null ? emptyAttachments(room.id)
        : recover<AttachmentIndex>(files, `room ${room.id} attachments`, value => validAttachmentIndex(value, room)));
      if (room.peer) {
        const messages = this.histories.get(room.id)!.messages;
        if ([...room.peer.excluded, ...room.peer.acknowledged].some(id => !messages.some(m => m.id === id))
          || room.peer.acknowledged.some(id => room.peer!.excluded.includes(id) || this.person(messages.find(m => m.id === id)!.authorId).state !== 'local')) {
          throw new Error('Cannot recover delivery receipts: invalid stored data. The store has not been reset.');
        }
      }
    }
    if (writeCatalog) store.write(CATALOG, JSON.stringify(this.catalog));
    this.dropAbandonedUploads();
    this.timer = setInterval(() => {
      let changed = false;
      for (const [id, until] of this.leases) if (until <= Date.now()) { this.leases.delete(id); changed = true; }
      if (changed) this.notify();
    }, 5000);
    this.timer.unref();
  }

  get ready() { return !this.storageFailure && !this.closed; }
  get owner(): Principal { return { kind: 'owner', participantId: this.catalog.ownerId }; }
  get settings() { return { ...this.catalog.settings, humanName: this.person(this.catalog.ownerId).name }; }
  get nodeId() { return this.catalog.nodeId; }
  snapshot(principal: Principal = this.owner): NodeSnapshot {
    const rooms = this.catalog.rooms.filter(room => this.permitted(principal, room));
    return { backend: 'local', storage: 'wormdb', nodeId: this.catalog.nodeId, localParticipantId: principal.participantId,
      rooms: rooms.map((room): RoomSnapshot => {
        const { id, title, project, sample, participantIds, peer } = room; const people = participantIds.map(id => this.person(id));
        const board = this.boards.get(id)!;
        return { id, title, project, sample, ...(peer ? { paired: true } : {}), floor: room.floor ?? DEFAULT_FLOOR,
          participants: people.map(person => {
            if (person.state === 'remote') return { ...person };
            const local = { ...person, machine: this.catalog.settings.machineName };
            if (person.role !== 'agent') return local;
            const connected = (this.connections.get(person.id) || 0) > 0 || (this.leases.get(person.id) || 0) > Date.now();
            return { ...local, ...this.agentAuthority(room, person.id), connected, detail: connected ? 'Agent connected on this machine' : 'Awaiting agent connection' };
          }),
          messages: this.histories.get(id)!.messages.map(({ requestId: _, fingerprint: __, ...message }) => {
            const mentions = mentionedIds(message.text, people);
            return { ...structuredClone(message), ...(mentions.length ? { mentions } : {}) };
          }),
          tasks: structuredClone(board.tasks), boardRevision: board.revision };
      }), availableRooms: [] };
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() { if (!this.closed) { this.closed = true; clearInterval(this.timer); this.listeners.clear(); this.store.close(); } }
  authenticateAgent(token: string): Principal | undefined {
    if (token.length < 32 || token.length > 256) return;
    const hash = Buffer.from(tokenHash(token), 'hex');
    const intent = this.catalog.intents.find(i => i.status === 'completed' && timingSafeEqual(hash, Buffer.from(i.tokenHash, 'hex')));
    return intent ? { kind: 'agent', participantId: intent.agentId, roomId: intent.roomId! } : undefined;
  }
  touch(principal: Principal) { if (principal.kind === 'agent') { const was = (this.leases.get(principal.participantId) || 0) > Date.now(); this.leases.set(principal.participantId, Date.now() + 45000); if (!was) this.notify(); } }
  connect(principal: Principal): () => void {
    if (principal.kind === 'owner') return () => {};
    const id = principal.participantId; this.connections.set(id, (this.connections.get(id) || 0) + 1); this.notify();
    let closed = false;
    return () => { if (!closed) { closed = true; this.connections.set(id, Math.max(0, (this.connections.get(id) || 0) - 1)); this.notify(); } };
  }
  pending(id: unknown): PendingRoom | undefined {
    if (id === undefined || id === '') return;
    const value = this.catalog.intents.find(intent => intent.id === id);
    if (!value) throw new NodeError(404, 'This room request is not on this machine. Run the Meshrooms skill again.');
    const { agentId: _, tokenHash: __, fingerprint: ___, ...visible } = value; return visible;
  }
  prepareRoom(input: { requestId?: unknown; title?: unknown; project?: unknown; agentName?: unknown; credentialHash?: unknown }): PendingRoom {
    this.assertReady();
    const id = requestId(input.requestId); const title = text(input.title, 'a room name', 64);
    const project = text(input.project ?? '', 'a project label', 48, false); const agentName = personName(input.agentName, 'an agent name');
    if (!isHash(input.credentialHash)) throw new NodeError(400, 'A credential hash is required.');
    const hash = fingerprint({ title, project, agentName, credentialHash: input.credentialHash });
    const existing = this.catalog.intents.find(intent => intent.id === id);
    if (existing) { this.assertRetry(existing.fingerprint, hash); return this.pending(id)!; }
    if (this.catalog.rooms.some(room => room.id === id) || this.catalog.intents.some(i => i.tokenHash === input.credentialHash)) throw new NodeError(409, 'This request or credential already belongs to another room.');
    if (this.catalog.rooms.length + this.catalog.intents.filter(i => i.status === 'pending').length >= MAX_ROOMS) throw new NodeError(409, 'This local beta has reached its room limit.');
    this.saveCatalog({ ...this.catalog, intents: [...this.catalog.intents, { id, title, project, agentName, agentId: randomUUID(),
      tokenHash: input.credentialHash, fingerprint: hash, status: 'pending' }] });
    return this.pending(id)!;
  }
  validateSetup(input: Record<string, unknown>): SetupCommand {
    const command: SetupCommand = { requestId: requestId(input.requestId), humanName: personName(input.humanName, 'your name'),
      machineName: text(input.machineName, 'a machine name', 64), startAtLogin: false };
    if (typeof input.startAtLogin !== 'boolean') throw new NodeError(400, 'Choose a startup preference.');
    command.startAtLogin = input.startAtLogin;
    if (input.intentId !== undefined) { command.intentId = requestId(input.intentId); this.pending(command.intentId); }
    const receipt = this.catalog.setupReceipts.find(r => r.id === command.requestId);
    if (receipt) this.assertRetry(receipt.fingerprint, fingerprint(command));
    else if (this.catalog.setupReceipts.length >= 256) throw new NodeError(409, 'This local beta has reached its settings update limit.');
    else if (command.humanName !== this.person(this.catalog.ownerId).name && this.catalog.rooms.some(room => room.peer)) {
      throw new NodeError(409, 'Paired rooms use a fixed participant grant. Keep your current name until updating peer grants is supported.');
    }
    return command;
  }
  setupResult(command: SetupCommand): { roomId?: string } | undefined {
    const receipt = this.catalog.setupReceipts.find(r => r.id === command.requestId);
    if (!receipt) return; this.assertRetry(receipt.fingerprint, fingerprint(command)); return receipt.roomId ? { roomId: receipt.roomId } : {};
  }
  completeSetup(input: Record<string, unknown>): { roomId?: string } {
    this.assertReady(); const command = this.validateSetup(input); const receipt = this.setupResult(command); if (receipt) return receipt;
    const next = structuredClone(this.catalog);
    next.settings = { completed: true, machineName: command.machineName, startAtLogin: command.startAtLogin };
    next.participants.find(p => p.id === next.ownerId)!.name = command.humanName;
    const intent = next.intents.find(i => i.id === command.intentId);
    let history: History | undefined;
    if (intent?.status === 'pending') {
      const agent: Participant = { id: intent.agentId, name: intent.agentName, role: 'agent', state: 'local', detail: 'Awaiting agent connection' };
      next.participants.push(agent);
      next.rooms.push({ id: intent.id, title: intent.title, project: intent.project, sample: false, participantIds: [next.ownerId, agent.id],
        requestId: intent.id, fingerprint: fingerprint({ title: intent.title, project: intent.project }) });
      history = { version: 2, roomId: intent.id, messages: [] };
      this.persist(historyKey(intent.id), history);
      intent.status = 'completed'; intent.roomId = intent.id;
    }
    next.setupReceipts.push({ id: command.requestId, fingerprint: fingerprint(command), roomId: intent?.roomId });
    this.persist(CATALOG, next); this.catalog = next;
    if (history) { this.histories.set(history.roomId, history); this.boards.set(history.roomId, emptyBoard(history.roomId)); this.attachments.set(history.roomId, emptyAttachments(history.roomId)); }
    this.notify(); return intent?.roomId ? { roomId: intent.roomId } : {};
  }
  createRoom(input: { title?: unknown; project?: unknown; requestId?: unknown }, principal: Principal = this.owner): { roomId: string } {
    this.assertReady(); this.requireOwner(principal);
    const id = requestId(input.requestId); const title = text(input.title, 'a room name', 64); const project = text(input.project ?? '', 'a project label', 48, false);
    const hash = fingerprint({ title, project }); const existing = this.catalog.rooms.find(room => room.requestId === id);
    if (existing) { this.assertRetry(existing.fingerprint, hash); return { roomId: existing.id }; }
    if (this.catalog.intents.some(i => i.id === id)) throw new NodeError(409, 'This request is waiting for setup confirmation.');
    if (this.catalog.rooms.length + this.catalog.intents.filter(i => i.status === 'pending').length >= MAX_ROOMS) throw new NodeError(409, `This local beta supports ${MAX_ROOMS} rooms.`);
    const room: RoomRecord = { id, title, project, sample: false, participantIds: [this.catalog.ownerId], requestId: id, fingerprint: hash };
    const history: History = { version: 2, roomId: room.id, messages: [] };
    this.persist(historyKey(room.id), history); this.persist(CATALOG, { ...this.catalog, rooms: [...this.catalog.rooms, room] });
    this.catalog.rooms.push(room); this.histories.set(room.id, history); this.boards.set(room.id, emptyBoard(room.id)); this.attachments.set(room.id, emptyAttachments(room.id)); this.notify(); return { roomId: room.id };
  }
  joinRoom(input: { roomId?: unknown; requestId?: unknown }, principal: Principal = this.owner) {
    this.assertReady(); this.requireOwner(principal); requestId(input.requestId); return { roomId: this.requireRoom(input.roomId, principal).id };
  }
  send(input: { roomId?: unknown; requestId?: unknown; text?: unknown; replyTo?: unknown; share?: unknown; attachments?: unknown }, principal: Principal = this.owner): { messageId: string; status: 'stored-locally' } {
    this.assertReady(); const room = this.requireRoom(input.roomId, principal); const id = requestId(input.requestId);
    const body = text(input.text ?? '', 'a message', 4000, false); let share: Draft['share'];
    if (input.share !== undefined) {
      const value = input.share as Record<string, unknown>; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NodeError(400, 'Use a labeled text excerpt.');
      const title = text(value.title, 'a source label', 100); text(value.text, 'an excerpt', 8000); share = { title, text: value.text as string };
    }
    let attachmentIds: string[] | undefined;
    if (input.attachments !== undefined) {
      if (!Array.isArray(input.attachments) || !input.attachments.every(isUuid) || new Set(input.attachments).size !== input.attachments.length
        || input.attachments.length > MAX_MESSAGE_ATTACHMENTS) throw new NodeError(400, `Attach up to ${MAX_MESSAGE_ATTACHMENTS} uploaded files.`);
      if (input.attachments.length) attachmentIds = input.attachments as string[];
    }
    if (!body && !share && !attachmentIds) throw new NodeError(400, 'Enter a message, a labeled excerpt, or an attachment.');
    const history = this.histories.get(room.id)!;
    if (input.replyTo !== undefined && (typeof input.replyTo !== 'string' || !history.messages.some(message => message.id === input.replyTo))) throw new NodeError(400, 'The reply target is not in this room. Choose a message from this room.');
    if (typeof input.replyTo === 'string' && room.peer?.excluded.includes(input.replyTo)) throw new NodeError(400, 'That message predates pairing and is private to this node. Send a new message instead.');
    const replyTo = input.replyTo as string | undefined; const hash = fingerprint({ text: body, share, replyTo, attachments: attachmentIds });
    const existing = history.messages.find(m => m.requestId === id && m.authorId === principal.participantId);
    if (existing) { this.assertRetry(existing.fingerprint, hash); return { messageId: existing.id, status: 'stored-locally' }; }
    if (history.messages.length >= MAX_MESSAGES) throw new NodeError(409, `This local beta supports ${MAX_MESSAGES} messages per room.`);
    const actor = this.person(principal.participantId);
    const attachments = attachmentIds && this.bindable(room, principal, attachmentIds);
    if (actor.role === 'agent' && !mayAgentSpeak(this.floorView(room), actor.id, replyTo)) {
      throw new NodeError(409, 'This room is humans-first: agents speak only when a person addresses them. Reply to a message that mentions you or replies to you, or work on a task a person assigned to you.');
    }
    const message: StoredMessage = { id: randomUUID(), authorId: actor.id, author: actor.name, role: actor.role, text: body,
      time: new Date().toISOString(), share, replyTo, ...(attachments ? { attachments } : {}), requestId: id, fingerprint: hash };
    const next: History = { ...history, version: 2, messages: [...history.messages, message] };
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_HISTORY_BYTES) throw new NodeError(409, 'This room reached the local beta history size limit.');
    this.persist(historyKey(room.id), next); this.histories.set(room.id, next); this.touch(principal); this.notify(); return { messageId: message.id, status: 'stored-locally' };
  }
  /** Store an upload for a later message. Retrying the same requestId with the same bytes returns the same attachment. */
  upload(input: { roomId?: unknown; requestId?: unknown; name?: unknown; bytes: Uint8Array }, principal: Principal = this.owner): Attachment {
    this.assertReady(); const room = this.requireRoom(input.roomId, principal); const id = requestId(input.requestId);
    if (!input.bytes.length) throw new NodeError(400, 'The file is empty.');
    if (input.bytes.length > MAX_ATTACHMENT_BYTES) throw new NodeError(413, `Attach files up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    const detected = sniff(input.bytes); const name = cleanName(input.name, defaultName(detected.type));
    const index = this.attachments.get(room.id)!;
    const existing = index.files.find(f => f.uploadedBy === principal.participantId && f.requestId === id);
    const contentHash = createHash('sha256').update(input.bytes).digest('hex'); const hash = fingerprint({ hash: contentHash, name });
    if (existing) { this.assertRetry(existing.fingerprint, hash); return publicAttachment(existing); }
    const used = this.usedAttachments(room.id);
    if (index.files.filter(f => f.uploadedBy === principal.participantId && !used.has(f.id)).length >= MAX_PENDING_ATTACHMENTS) {
      throw new NodeError(409, 'Send or discard your pending attachments before uploading more.');
    }
    if (index.files.length >= MAX_ROOM_ATTACHMENTS || index.files.reduce((sum, f) => sum + f.size, 0) + input.bytes.length > MAX_ROOM_ATTACHMENT_BYTES) {
      throw new NodeError(409, 'This room reached the local beta attachment limit.');
    }
    try { this.blobs.put(input.bytes); }
    catch { throw new NodeError(503, 'The attachment could not be saved. Keep its requestId and retry.'); }
    const record: AttachmentRecord = { id: randomUUID(), name, size: input.bytes.length, ...detected, hash: contentHash,
      uploadedBy: principal.participantId, uploadedAt: new Date().toISOString(), requestId: id, fingerprint: hash };
    const next: AttachmentIndex = { ...index, files: [...index.files, record] };
    this.persist(attachmentsKey(room.id), next); this.attachments.set(room.id, next);
    return publicAttachment(record);
  }
  attachment(roomId: unknown, attachmentId: unknown, principal: Principal = this.owner): { attachment: Attachment; bytes: Uint8Array } {
    const room = this.requireRoom(roomId, principal);
    const record = this.attachments.get(room.id)!.files.find(f => f.id === attachmentId);
    // Pending uploads are visible only to their author until a message shares them.
    if (!record || (record.uploadedBy !== principal.participantId && !this.usedAttachments(room.id).has(record.id))) throw new NodeError(404, 'That attachment is not in this room.');
    const bytes = this.blobs.get(record.hash);
    if (!bytes) throw new NodeError(410, 'The attachment file is missing or damaged on this machine.');
    return { attachment: publicAttachment(record), bytes };
  }
  /** Only the agent's operator (the local human, for a local agent) decides who can wake it. */
  setAgentWake(input: { roomId?: unknown; requestId?: unknown; agentId?: unknown; wake?: unknown }, principal: Principal = this.owner): { roomId: string } {
    this.assertReady(); this.requireOwner(principal); requestId(input.requestId);
    const room = this.requireRoom(input.roomId, principal);
    if (!['anyone', 'operator'].includes(input.wake as string)) throw new NodeError(400, 'Choose anyone or operator.');
    const agent = typeof input.agentId === 'string' && room.participantIds.includes(input.agentId) ? this.person(input.agentId) : undefined;
    if (agent?.role !== 'agent' || agent.state !== 'local') throw new NodeError(400, 'Choose an agent on this machine; each operator controls their own agents.');
    const operatorOnly = new Set(room.operatorOnly ?? []);
    if (input.wake === 'operator') operatorOnly.add(agent.id); else operatorOnly.delete(agent.id);
    if (operatorOnly.size === (room.operatorOnly?.length ?? 0) && [...operatorOnly].every(id => room.operatorOnly?.includes(id))) return { roomId: room.id };
    const next = structuredClone(this.catalog); const target = next.rooms.find(r => r.id === room.id)!;
    if (operatorOnly.size) target.operatorOnly = [...operatorOnly]; else delete target.operatorOnly;
    this.saveCatalog(next); return { roomId: room.id };
  }
  setFloor(input: { roomId?: unknown; requestId?: unknown; floor?: unknown }, principal: Principal = this.owner): { roomId: string } {
    this.assertReady(); this.requireOwner(principal); requestId(input.requestId);
    const room = this.requireRoom(input.roomId, principal);
    if (!FLOORS.includes(input.floor as Floor)) throw new NodeError(400, 'Choose humans-first or open for agent replies.');
    if ((room.floor ?? DEFAULT_FLOOR) === input.floor) return { roomId: room.id };
    const next = structuredClone(this.catalog); next.rooms.find(r => r.id === room.id)!.floor = input.floor as Floor;
    this.saveCatalog(next); return { roomId: room.id };
  }
  createTask(input: { roomId?: unknown; requestId?: unknown; title?: unknown; notes?: unknown; assigneeId?: unknown }, principal: Principal = this.owner): { taskId: string; revision: number } {
    this.assertReady(); const room = this.requireRoom(input.roomId, principal); const id = requestId(input.requestId);
    const title = text(input.title, 'a task title', 120); const notes = text(input.notes ?? '', 'task notes', 2000, false);
    const assigneeId = this.assignee(room, input.assigneeId ?? null);
    const board = this.boards.get(room.id)!; const hash = fingerprint({ command: 'create', title, notes, assigneeId });
    const prior = this.boardReceipt(board, principal, id, hash); if (prior) return prior;
    if (board.tasks.length >= MAX_TASKS) throw new NodeError(409, `This local beta supports ${MAX_TASKS} tasks per room. Remove finished tasks first.`);
    const revision = board.revision + 1; const now = new Date().toISOString();
    const task: Task = { id: randomUUID(), title, notes, status: 'todo', createdBy: principal.participantId, updatedBy: principal.participantId,
      updatedAt: now, revision: 1, ...(assigneeId ? { assigneeId, assignedBy: principal.participantId, assignedRevision: revision } : {}) };
    this.saveBoard(room.id, { ...board, revision, tasks: [...board.tasks, task] }, { id, actorId: principal.participantId, fingerprint: hash, taskId: task.id, revision: 1 });
    return { taskId: task.id, revision: 1 };
  }
  /** Updates name the revision they were based on, so two editors cannot silently overwrite each other. */
  updateTask(input: { roomId?: unknown; requestId?: unknown; taskId?: unknown; revision?: unknown; title?: unknown; notes?: unknown; status?: unknown; assigneeId?: unknown }, principal: Principal = this.owner): { taskId: string; revision: number } {
    this.assertReady(); const room = this.requireRoom(input.roomId, principal); const id = requestId(input.requestId);
    const changes: Partial<Pick<Task, 'title' | 'notes' | 'status'>> & { assigneeId?: string | null } = {};
    if (input.title !== undefined) changes.title = text(input.title, 'a task title', 120);
    if (input.notes !== undefined) changes.notes = text(input.notes, 'task notes', 2000, false);
    if (input.status !== undefined) {
      if (!TASK_STATUSES.includes(input.status as Task['status'])) throw new NodeError(400, 'Choose todo, doing, or done.');
      changes.status = input.status as Task['status'];
    }
    if (input.assigneeId !== undefined) changes.assigneeId = this.assignee(room, input.assigneeId);
    if (!Object.keys(changes).length) throw new NodeError(400, 'Change the title, notes, status, or assignee.');
    const board = this.boards.get(room.id)!; const hash = fingerprint({ command: 'update', taskId: input.taskId, revision: input.revision, changes });
    const prior = this.boardReceipt(board, principal, id, hash); if (prior) return prior;
    const current = this.task(board, input.taskId, input.revision);
    const revision = board.revision + 1; const next: Task = { ...current, updatedBy: principal.participantId, updatedAt: new Date().toISOString(), revision: current.revision + 1 };
    if (changes.title !== undefined) next.title = changes.title;
    if (changes.notes !== undefined) next.notes = changes.notes;
    if (changes.status !== undefined) next.status = changes.status;
    if (changes.assigneeId !== undefined && changes.assigneeId !== (current.assigneeId ?? null)) {
      delete next.assigneeId; delete next.assignedBy; delete next.assignedRevision;
      if (changes.assigneeId) Object.assign(next, { assigneeId: changes.assigneeId, assignedBy: principal.participantId, assignedRevision: revision });
    }
    this.saveBoard(room.id, { ...board, revision, tasks: board.tasks.map(t => t.id === next.id ? next : t) },
      { id, actorId: principal.participantId, fingerprint: hash, taskId: next.id, revision: next.revision });
    return { taskId: next.id, revision: next.revision };
  }
  removeTask(input: { roomId?: unknown; requestId?: unknown; taskId?: unknown; revision?: unknown }, principal: Principal = this.owner): { taskId: string; revision: number } {
    this.assertReady(); const room = this.requireRoom(input.roomId, principal); const id = requestId(input.requestId);
    const board = this.boards.get(room.id)!; const hash = fingerprint({ command: 'remove', taskId: input.taskId, revision: input.revision });
    const prior = this.boardReceipt(board, principal, id, hash); if (prior) return prior;
    const current = this.task(board, input.taskId, input.revision);
    this.saveBoard(room.id, { ...board, revision: board.revision + 1, tasks: board.tasks.filter(t => t.id !== current.id) },
      { id, actorId: principal.participantId, fingerprint: hash, taskId: current.id, revision: current.revision });
    return { taskId: current.id, revision: current.revision };
  }
  requireOwner(principal: Principal) { if (principal.kind !== 'owner' || principal.participantId !== this.catalog.ownerId) throw new NodeError(403, 'This action requires the local human session.'); }
  descriptor(roomId: unknown, peerKey: string): RoomDescriptor {
    const room = this.requireRoom(roomId, this.owner);
    return { version: 1, roomId: room.id, peerKey, machine: this.catalog.settings.machineName, participants: room.participantIds.map(id => this.person(id))
      .filter(p => p.state === 'local').map(({ id, name, role }) => ({ id, name, role, ...(role === 'agent' ? { operatorId: this.catalog.ownerId } : {}) })) };
  }
  pairRoom(input: unknown, localKey: string) {
    this.assertReady();
    if (!this.catalog.settings.completed) throw new NodeError(409, 'Complete local setup before pairing rooms.');
    let descriptor: RoomDescriptor;
    try { descriptor = parseDescriptor(input); } catch { throw new NodeError(400, 'Invalid room pairing descriptor.'); }
    const room = this.requireRoom(descriptor.roomId, this.owner);
    if (descriptor.peerKey === localKey) throw new NodeError(400, 'Select another machine identity.');
    const identity = (d: RoomDescriptor) => ({ version: 1, roomId: d.roomId, peerKey: d.peerKey, participants: d.participants.map(({ id, name, role }) => ({ id, name, role })) });
    if (room.peer) {
      const prior = { version: 1, roomId: room.id, peerKey: room.peer.key, participants: room.peer.participantIds.map(id => {
        const { id: participantId, name, role } = this.person(id); return { id: participantId, name, role };
      }) };
      if (fingerprint(prior) !== fingerprint(identity(descriptor))) throw new NodeError(409, 'This room is already paired. Changing membership requires a separate admission flow.');
      // The same grant may later add operator and machine attribution, but never change an existing one.
      const next = structuredClone(this.catalog); let changed = false;
      for (const granted of descriptor.participants) {
        const person = next.participants.find(p => p.id === granted.id)!;
        if (granted.operatorId && person.operatorId !== granted.operatorId) {
          if (person.operatorId) throw new NodeError(409, 'This agent already has a different operator.');
          person.operatorId = granted.operatorId; changed = true;
        }
        if (descriptor.machine && person.machine !== descriptor.machine) {
          if (person.machine) throw new NodeError(409, 'This participant already belongs to a different machine.');
          person.machine = descriptor.machine; changed = true;
        }
      }
      if (changed) {
        if (!validCatalog(next)) throw new NodeError(409, 'The operator grant conflicts with existing room identities.');
        this.saveCatalog(next);
      }
      return { roomId: room.id };
    }
    const next = structuredClone(this.catalog), target = next.rooms.find(r => r.id === room.id)!;
    for (const person of descriptor.participants) {
      const prior = next.participants.find(p => p.id === person.id);
      if (prior && (prior.state !== 'remote' || prior.peerKey !== descriptor.peerKey || prior.name !== person.name || prior.role !== person.role
        || (prior.operatorId && person.operatorId && prior.operatorId !== person.operatorId)
        || (prior.machine && descriptor.machine && prior.machine !== descriptor.machine))) throw new NodeError(409, 'A participant identity conflicts with this node.');
      // A participant already known from another room gains attribution it lacked, never a different one.
      if (prior && person.operatorId && !prior.operatorId) prior.operatorId = person.operatorId;
      if (prior && descriptor.machine && !prior.machine) prior.machine = descriptor.machine;
      if (!prior) next.participants.push({ id: person.id, name: person.name, role: person.role, state: 'remote', peerKey: descriptor.peerKey, detail: 'Remote room member · presence not tracked',
        ...(person.operatorId ? { operatorId: person.operatorId } : {}), ...(descriptor.machine ? { machine: descriptor.machine } : {}) });
    }
    target.peer = { key: descriptor.peerKey, participantIds: descriptor.participants.map(p => p.id),
      excluded: this.histories.get(room.id)!.messages.map(m => m.id), acknowledged: [] };
    target.participantIds.push(...target.peer.participantIds);
    if (!validCatalog(next)) throw new NodeError(409, 'The pairing conflicts with existing room identities.');
    this.saveCatalog(next); return { roomId: room.id };
  }
  acceptsPeer(roomId: string, key: string) { return this.catalog.rooms.some(r => r.id === roomId && r.peer?.key === key); }
  pendingDelivery() {
    return this.catalog.rooms.filter(r => r.peer).map(room => ({ roomId: room.id, peerKey: room.peer!.key,
      messages: structuredClone(this.histories.get(room.id)!.messages.filter(m => this.person(m.authorId).state === 'local'
        && !room.peer!.excluded.includes(m.id) && !room.peer!.acknowledged.includes(m.id))), acknowledged: [...room.peer!.acknowledged],
      files: [...(room.peer!.files ?? [])] }));
  }
  acknowledgePeer(roomId: string, key: string, messageId: string, hash: string) {
    this.assertReady();
    const room = this.catalog.rooms.find(r => r.id === roomId && r.peer?.key === key);
    const message = room && this.histories.get(roomId)!.messages.find(m => m.id === messageId && this.person(m.authorId).state === 'local');
    if (!room?.peer || !message || fingerprint(message) !== hash || room.peer.excluded.includes(messageId)) throw new NodeError(403, 'Unknown delivery receipt.');
    if (room.peer.acknowledged.includes(messageId)) return;
    const next = structuredClone(this.catalog); next.rooms.find(r => r.id === roomId)!.peer!.acknowledged.push(messageId); this.saveCatalog(next);
  }
  receivePeer(roomId: string, key: string, input: any) {
    this.assertReady();
    const room = this.catalog.rooms.find(r => r.id === roomId && r.peer?.key === key);
    if (!room?.peer || !room.peer.participantIds.includes(input?.authorId)) throw new NodeError(403, 'Peer is not admitted as this room author.');
    let attachments: Attachment[] | undefined;
    if (input.attachments !== undefined) {
      // Every attachment must already be stored here, from this author, with identical metadata.
      const index = this.attachments.get(roomId)!.files;
      if (!Array.isArray(input.attachments) || !input.attachments.length || input.attachments.length > MAX_MESSAGE_ATTACHMENTS) throw new NodeError(400, 'Invalid remote attachments.');
      attachments = input.attachments.map((a: any) => {
        const record = index.find(f => f.id === a?.id && f.uploadedBy === input.authorId);
        if (!record || fingerprint(publicAttachment(record)) !== fingerprint(normalizeAttachment(a))) throw new NodeError(409, 'A remote attachment has not arrived yet.');
        return publicAttachment(record);
      });
    }
    const message: StoredMessage = { id: input.id, authorId: input.authorId, author: input.author, role: input.role,
      text: input.text, time: input.time, share: input.share, replyTo: input.replyTo, ...(attachments ? { attachments } : {}), requestId: input.requestId, fingerprint: input.fingerprint };
    const history = this.histories.get(roomId)!;
    const existing = history.messages.find(m => m.id === message.id || (m.authorId === message.authorId && m.requestId === message.requestId));
    if (existing) { this.assertRetry(fingerprint(existing), fingerprint(message)); return fingerprint(existing); }
    if (message.replyTo && room.peer.excluded.includes(message.replyTo)) throw new NodeError(400, 'The remote reply target predates pairing.');
    const next: History = { ...history, version: 2, messages: [...history.messages, message] };
    if (message.author !== this.person(message.authorId).name || message.fingerprint !== fingerprint({ text: message.text, share: message.share, replyTo: message.replyTo, attachments: attachments?.map(a => a.id) })
      || !validHistory(next, room, this.catalog.participants) || Buffer.byteLength(JSON.stringify(next)) > MAX_HISTORY_BYTES) throw new NodeError(400, 'Invalid remote room message.');
    this.persist(historyKey(roomId), next); this.histories.set(roomId, next); this.notify(); return fingerprint(message);
  }
  private usedAttachments(roomId: string) {
    return new Set(this.histories.get(roomId)!.messages.flatMap(m => m.attachments?.map(a => a.id) ?? []));
  }
  private bindable(room: RoomRecord, principal: Principal, ids: string[]): Attachment[] {
    const files = this.attachments.get(room.id)!.files; const used = this.usedAttachments(room.id);
    return ids.map(id => {
      const record = files.find(f => f.id === id && f.uploadedBy === principal.participantId);
      if (!record) throw new NodeError(400, 'Upload each attachment to this room before sending it.');
      if (used.has(id)) throw new NodeError(409, 'That attachment was already sent. Upload it again to share it in a new message.');
      return publicAttachment(record);
    });
  }
  /** Unsent uploads expire after a day; then bytes no room references are removed. */
  private dropAbandonedUploads() {
    const cutoff = Date.now() - PENDING_ATTACHMENT_MS; const keep = new Set<string>();
    for (const [roomId, index] of this.attachments) {
      const used = this.usedAttachments(roomId);
      const files = index.files.filter(f => used.has(f.id) || Date.parse(f.uploadedAt) > cutoff);
      if (files.length !== index.files.length) { const next = { ...index, files }; this.store.write(attachmentsKey(roomId), JSON.stringify(next)); this.attachments.set(roomId, next); }
      files.forEach(f => keep.add(f.hash));
    }
    try { this.blobs.sweep(keep); } catch { /* Unreferenced bytes are retried at the next start. */ }
  }
  /** Operator and wake policy of a local agent. Every local agent answers to this node's one human owner. */
  private agentAuthority(room: RoomRecord, agentId: string): { operatorId: string; wake: 'anyone' | 'operator' } {
    return { operatorId: this.catalog.ownerId, wake: room.operatorOnly?.includes(agentId) ? 'operator' : 'anyone' };
  }
  private floorView(room: RoomRecord) {
    const participants = room.participantIds.map(id => { const p = this.person(id); return p.role === 'agent' && p.state === 'local' ? { ...p, ...this.agentAuthority(room, id) } : p; });
    return { floor: room.floor, participants, tasks: this.boards.get(room.id)!.tasks,
      messages: this.histories.get(room.id)!.messages.map(m => ({ ...m, mentions: mentionedIds(m.text, participants) })) };
  }
  /** Tasks are local to this node, so only participants on this machine can hold them. */
  private assignee(room: RoomRecord, value: unknown): string | null {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !room.participantIds.includes(value) || this.person(value).state !== 'local') throw new NodeError(400, 'Assign the task to a participant on this machine, or leave it unassigned.');
    return value;
  }
  private task(board: Board, taskId: unknown, revision: unknown): Task {
    const task = board.tasks.find(t => t.id === taskId);
    if (!task) throw new NodeError(404, 'That task is no longer on this board.');
    if (task.revision !== revision) throw new NodeError(409, 'This task changed since you loaded it. Review the latest version and retry.');
    return task;
  }
  private boardReceipt(board: Board, principal: Principal, id: string, hash: string) {
    const receipt = board.receipts.find(r => r.id === id && r.actorId === principal.participantId);
    if (!receipt) return; this.assertRetry(receipt.fingerprint, hash); return { taskId: receipt.taskId, revision: receipt.revision };
  }
  private saveBoard(roomId: string, next: Board, receipt: Board['receipts'][number]) {
    next = { ...next, receipts: [...next.receipts, receipt].slice(-MAX_BOARD_RECEIPTS) };
    this.persist(boardKey(roomId), next); this.boards.set(roomId, next); this.notify();
  }
  /** Bytes and metadata of an attachment this node sends with a pending paired-room message. */
  peerAttachment(roomId: string, key: string, attachmentId: string): { attachment: Attachment; hash: string; authorId: string; bytes: Uint8Array } {
    const room = this.catalog.rooms.find(r => r.id === roomId && r.peer?.key === key);
    const message = room && this.histories.get(roomId)!.messages.find(m => m.attachments?.some(a => a.id === attachmentId)
      && this.person(m.authorId).state === 'local' && !room.peer!.excluded.includes(m.id));
    const record = message && this.attachments.get(roomId)!.files.find(f => f.id === attachmentId);
    if (!record) throw new NodeError(404, 'That attachment is not shared with this peer.');
    const bytes = this.blobs.get(record.hash);
    if (!bytes) throw new NodeError(410, 'The attachment file is missing or damaged on this machine.');
    return { attachment: publicAttachment(record), hash: record.hash, authorId: message.authorId, bytes };
  }
  /** Store an attachment received from the paired node. Its type is re-detected here, never trusted. */
  receivePeerFile(roomId: string, key: string, input: { authorId?: unknown; id?: unknown; name?: unknown; hash?: unknown }, bytes: Uint8Array): Attachment {
    this.assertReady();
    const room = this.catalog.rooms.find(r => r.id === roomId && r.peer?.key === key);
    if (!room?.peer || typeof input.authorId !== 'string' || !room.peer.participantIds.includes(input.authorId)) throw new NodeError(403, 'Peer is not admitted as this room author.');
    if (!isUuid(input.id) || !isHash(input.hash) || !bytes.length || bytes.length > MAX_ATTACHMENT_BYTES
      || createHash('sha256').update(bytes).digest('hex') !== input.hash) throw new NodeError(400, 'Invalid remote attachment.');
    // Type, kind, and dimensions come from these bytes; the later message must agree with them.
    const detected = sniff(bytes);
    const attachment = normalizeAttachment({ id: input.id, name: cleanName(input.name, defaultName(detected.type)), size: bytes.length, ...detected });
    const index = this.attachments.get(room.id)!;
    const existing = index.files.find(f => f.id === attachment.id);
    if (existing) {
      if (existing.uploadedBy !== input.authorId || existing.hash !== input.hash) throw new NodeError(409, 'That attachment ID already names a different file.');
      return publicAttachment(existing);
    }
    if (index.files.length >= MAX_ROOM_ATTACHMENTS || index.files.reduce((sum, f) => sum + f.size, 0) + bytes.length > MAX_ROOM_ATTACHMENT_BYTES) {
      throw new NodeError(409, 'This room reached the local beta attachment limit.');
    }
    try { this.blobs.put(bytes); } catch { throw new NodeError(503, 'The attachment could not be saved.'); }
    const record: AttachmentRecord = { ...attachment, hash: input.hash, uploadedBy: input.authorId, uploadedAt: new Date().toISOString(),
      requestId: randomUUID(), fingerprint: fingerprint({ hash: input.hash, name: attachment.name }) };
    const next: AttachmentIndex = { ...index, files: [...index.files, record] };
    this.persist(attachmentsKey(room.id), next); this.attachments.set(room.id, next);
    return attachment;
  }
  /** The paired node stored an attachment of ours; stop re-sending it. */
  acknowledgePeerFile(roomId: string, key: string, attachmentId: string, hash: string) {
    this.assertReady();
    const sent = this.peerAttachment(roomId, key, attachmentId);
    if (sent.hash !== hash) throw new NodeError(403, 'Unknown attachment receipt.');
    const room = this.catalog.rooms.find(r => r.id === roomId)!;
    if (room.peer!.files?.includes(attachmentId)) return;
    const next = structuredClone(this.catalog); const peer = next.rooms.find(r => r.id === roomId)!.peer!;
    peer.files = [...(peer.files ?? []), attachmentId].slice(-512); this.saveCatalog(next);
  }
  private permitted(principal: Principal, room: RoomRecord) { return room.participantIds.includes(principal.participantId) && (principal.kind === 'owner' || principal.roomId === room.id); }
  private person(id: string) { const person = this.catalog.participants.find(p => p.id === id); if (!person) throw new NodeError(403, 'Unknown participant.'); return person; }
  private requireRoom(id: unknown, principal: Principal): RoomRecord {
    const room = this.catalog.rooms.find(room => room.id === id && this.permitted(principal, room));
    if (!room) throw new NodeError(404, 'That room is not available to this participant.'); return room;
  }
  private assertReady() { if (!this.ready) throw new NodeError(503, 'Local storage is unavailable. Restore the store and restart the daemon before retrying.'); }
  private assertRetry(prior: string, next: string) { if (prior !== next) throw new NodeError(409, 'This requestId was already used for different content.'); }
  private persist(key: string, value: unknown) {
    try { this.store.write(key, JSON.stringify(value)); }
    catch { this.storageFailure = true; throw new NodeError(503, 'The local write could not be confirmed. Keep its requestId and retry after the daemon recovers.'); }
  }
  private saveCatalog(next: Catalog) { this.persist(CATALOG, next); this.catalog = next; this.notify(); }
  private notify() { for (const listener of this.listeners) { try { listener(); } catch { /* View errors cannot roll back accepted writes. */ } } }
}
