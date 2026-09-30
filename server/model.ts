import { createHash } from 'node:crypto';
import type { Attachment, Message, Participant, RoomInfo } from '../src/room';
import type { PendingRoom } from '../src/setup';
import { FLOORS, TASK_STATUSES, type Floor, type Task } from '../src/collab';

export const CATALOG_V1 = 'meshrooms/v1/catalog';
export const CATALOG = 'meshrooms/v2/catalog';
export const MAX_ROOMS = 64;
export const MAX_MESSAGES = 1000;
export const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const historyKey = (roomId: string) => `meshrooms/v1/rooms/${roomId}/history`;
export const boardKey = (roomId: string) => `meshrooms/v1/rooms/${roomId}/board`;
export const attachmentsKey = (roomId: string) => `meshrooms/v1/rooms/${roomId}/attachments`;
export const MAX_TASKS = 200;
export const MAX_BOARD_RECEIPTS = 256;
/** `files`: attachment IDs the paired node confirmed it stored (absent before attachment delivery existed). */
export type RoomPeer = { key: string; participantIds: string[]; excluded: string[]; acknowledged: string[]; files?: string[] };
/** `floor` is absent on rooms created before floor control; they read as humans-first. */
/** `operatorOnly`: local agents in this room that only their operator can wake. */
export type RoomRecord = RoomInfo & { participantIds: string[]; requestId: string; fingerprint: string; peer?: RoomPeer; floor?: Floor; operatorOnly?: string[] };
/** Board receipts make retried task commands idempotent per author and request ID. */
export type BoardReceipt = { id: string; actorId: string; fingerprint: string; taskId: string; revision: number };
export type Board = { version: 1; roomId: string; revision: number; tasks: Task[]; receipts: BoardReceipt[] };
/** An upload. It is pending until a message in the same room references it; bytes live in the blob store by hash. */
export type AttachmentRecord = Attachment & { hash: string; uploadedBy: string; uploadedAt: string; requestId: string; fingerprint: string };
export type AttachmentIndex = { version: 1; roomId: string; files: AttachmentRecord[] };
export type IntentRecord = PendingRoom & { agentId: string; tokenHash: string; fingerprint: string };
export type Settings = { completed: boolean; machineName: string; startAtLogin: boolean };
export type Catalog = {
  version: 3; nodeId: string; ownerId: string; participants: Participant[]; rooms: RoomRecord[];
  settings: Settings; intents: IntentRecord[]; setupReceipts: { id: string; fingerprint: string; roomId?: string }[];
};
export type StoredMessage = Message & { requestId: string; fingerprint: string };
export type History = { version: 1 | 2; roomId: string; messages: StoredMessage[] };
export type Principal = { kind: 'owner'; participantId: string } | { kind: 'agent'; participantId: string; roomId: string };

function named(value: unknown, max: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max; }
function participant(value: any): value is Participant {
  return !!value && isUuid(value.id) && named(value.name, 64) && ['human', 'agent'].includes(value.role)
    && (value.state === 'local' ? value.peerKey === undefined : value.state === 'remote' && isHash(value.peerKey)) && typeof value.detail === 'string'
    // Operators and machine names are stored only for remote participants; local ones derive from the node.
    && (value.operatorId === undefined || (value.state === 'remote' && value.role === 'agent' && isUuid(value.operatorId)))
    && (value.machine === undefined || (value.state === 'remote' && named(value.machine, 64)));
}
function unique(values: unknown[]): boolean { return new Set(values).size === values.length; }
export function validCatalog(value: any): value is Catalog {
  if (!value || value.version !== 3 || !isUuid(value.nodeId) || !isUuid(value.ownerId)
    || !Array.isArray(value.participants) || !value.participants.every(participant) || !unique(value.participants.map((p: Participant) => p.id))
    || !Array.isArray(value.rooms) || value.rooms.length > MAX_ROOMS || !unique(value.rooms.map((r: RoomRecord) => r?.id))
    || !unique(value.rooms.map((r: RoomRecord) => r?.requestId))
    || !value.settings || typeof value.settings.completed !== 'boolean' || !named(value.settings.machineName, 64) || typeof value.settings.startAtLogin !== 'boolean'
    || !Array.isArray(value.intents) || value.intents.length > MAX_ROOMS || !unique(value.intents.map((i: IntentRecord) => i?.id))
    || !unique(value.intents.map((i: IntentRecord) => i?.agentId)) || !unique(value.intents.map((i: IntentRecord) => i?.tokenHash))
    || !Array.isArray(value.setupReceipts) || value.setupReceipts.length > 256 || !unique(value.setupReceipts.map((r: any) => r?.id))) return false;
  const people = new Map<string, Participant>(value.participants.map((p: Participant) => [p.id, p]));
  if (people.get(value.ownerId)?.role !== 'human' || people.get(value.ownerId)?.state !== 'local'
    || value.participants.filter((p: Participant) => p.role === 'human' && p.state === 'local').length !== 1) return false;
  if (value.participants.some((p: Participant) => p.operatorId !== undefined && (people.get(p.operatorId)?.role !== 'human' || people.get(p.operatorId)?.peerKey !== p.peerKey))) return false;
  if (!value.rooms.every((r: any) => r && isUuid(r.id) && isUuid(r.requestId) && isHash(r.fingerprint)
    && named(r.title, 64) && typeof r.project === 'string' && r.project.length <= 48 && r.sample === false
    && (r.floor === undefined || FLOORS.includes(r.floor))
    && (r.operatorOnly === undefined || (Array.isArray(r.operatorOnly) && unique(r.operatorOnly)
      && r.operatorOnly.every((id: string) => r.participantIds.includes(id) && people.get(id)?.role === 'agent' && people.get(id)?.state === 'local')))
    && Array.isArray(r.participantIds) && unique(r.participantIds) && r.participantIds.includes(value.ownerId)
    && r.participantIds.every((id: string) => people.has(id))
    && (r.peer === undefined ? r.participantIds.every((id: string) => people.get(id)?.state === 'local')
      : isHash(r.peer.key) && Array.isArray(r.peer.participantIds) && r.peer.participantIds.length > 0 && r.peer.participantIds.length <= 16
        && unique(r.peer.participantIds) && r.peer.participantIds.every((id: string) => r.participantIds.includes(id) && people.get(id)?.peerKey === r.peer.key)
        && r.participantIds.every((id: string) => people.get(id)?.state === 'local' || r.peer.participantIds.includes(id))
        && [r.peer.excluded, r.peer.acknowledged].every(ids => Array.isArray(ids) && ids.length <= MAX_MESSAGES && unique(ids) && ids.every(isUuid))
        && (r.peer.files === undefined || (Array.isArray(r.peer.files) && r.peer.files.length <= 512 && unique(r.peer.files) && r.peer.files.every(isUuid)))))) return false;
  if (!value.intents.every((i: any) => i && isUuid(i.id) && isUuid(i.agentId) && isHash(i.tokenHash) && isHash(i.fingerprint)
    && named(i.title, 64) && named(i.agentName, 64) && typeof i.project === 'string' && i.project.length <= 48
    && (i.status === 'pending' ? i.roomId === undefined && !people.has(i.agentId)
      : i.status === 'completed' && i.roomId === i.id && people.get(i.agentId)?.role === 'agent'
        && value.rooms.some((r: RoomRecord) => r.id === i.roomId && r.participantIds.includes(i.agentId))))) return false;
  return value.setupReceipts.every((r: any) => r && isUuid(r.id) && isHash(r.fingerprint)
    && (r.roomId === undefined || value.rooms.some((room: RoomRecord) => room.id === r.roomId)));
}

export function migrateV1(value: any, machineName: string): Catalog {
  const owner = value?.localParticipant;
  if (!value || value.version !== 1 || !isUuid(value.nodeId) || !participant(owner) || owner.role !== 'human'
    || !Array.isArray(value.rooms) || !value.rooms.every((room: any) => Array.isArray(room?.participants)
      && room.participants.length === 1 && room.participants[0].id === owner.id && participant(room.participants[0]))) throw new Error('Invalid legacy catalog');
  const result: Catalog = {
    version: 3, nodeId: value.nodeId, ownerId: owner.id, participants: [owner],
    rooms: value.rooms.map(({ participants: _, ...room }: any) => ({ ...room, participantIds: [owner.id] })),
    settings: { completed: false, machineName, startAtLogin: false }, intents: [], setupReceipts: [],
  };
  if (!validCatalog(result)) throw new Error('Invalid legacy catalog');
  return result;
}

export function migrateV2(value: any): Catalog {
  if (!value || value.version !== 2 || !Array.isArray(value.rooms) || value.rooms.some((r: any) => r?.peer !== undefined)
    || !Array.isArray(value.participants) || value.participants.some((p: any) => p?.state !== 'local' || p?.peerKey !== undefined)) throw new Error('Invalid v2 catalog');
  const next = { ...value, version: 3 };
  if (!validCatalog(next)) throw new Error('Invalid v2 catalog');
  return next;
}

export function validHistory(value: any, room: RoomRecord, people: Participant[]): value is History {
  if (!value || ![1, 2].includes(value.version) || value.roomId !== room.id || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) return false;
  const ids = new Set<string>(); const requests = new Set<string>(); const attached = new Set<string>();
  return value.messages.every((m: any) => {
    const author = people.find(p => p.id === m?.authorId && room.participantIds.includes(p.id));
    if (!m || !author || !isUuid(m.id) || ids.has(m.id) || !isUuid(m.requestId) || requests.has(`${m.authorId}:${m.requestId}`)
      || !named(m.author, 64) || m.role !== author.role || (value.version === 1 && m.role !== 'human')
      || typeof m.text !== 'string' || m.text.length > 4000 || typeof m.time !== 'string' || !Number.isFinite(Date.parse(m.time))
      || !isHash(m.fingerprint) || m.sample === true || (m.replyTo !== undefined && !ids.has(m.replyTo))) return false;
    if (m.share !== undefined && (!m.share || !named(m.share.title, 100) || !named(m.share.text, 8000))) return false;
    if (m.attachments !== undefined && (!Array.isArray(m.attachments) || !m.attachments.length || m.attachments.length > 4
      || !m.attachments.every((a: any) => validAttachment(a) && !attached.has(a.id) && !!attached.add(a.id)))) return false;
    if (!m.text.trim() && !m.share && !m.attachments) return false;
    ids.add(m.id); requests.add(`${m.authorId}:${m.requestId}`); return true;
  });
}

export function validAttachment(a: any): a is Attachment {
  return !!a && isUuid(a.id) && named(a.name, 120) && typeof a.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(a.type)
    && ['image', 'file'].includes(a.kind) && Number.isSafeInteger(a.size) && a.size > 0
    && [a.width, a.height].every(n => n === undefined || (Number.isSafeInteger(n) && n > 0 && n <= 65535));
}

export function validAttachmentIndex(value: any, room: RoomRecord): value is AttachmentIndex {
  if (!value || value.version !== 1 || value.roomId !== room.id || !Array.isArray(value.files) || !unique(value.files.map((f: any) => f?.id))) return false;
  return value.files.every((f: any) => isHash(f?.hash) && room.participantIds.includes(f.uploadedBy)
    && typeof f.uploadedAt === 'string' && Number.isFinite(Date.parse(f.uploadedAt)) && isUuid(f.requestId) && isHash(f.fingerprint) && validAttachment(f));
}

export function validBoard(value: any, room: RoomRecord, people: Participant[]): value is Board {
  if (!value || value.version !== 1 || value.roomId !== room.id || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS || !unique(value.tasks.map((t: Task) => t?.id))
    || !Array.isArray(value.receipts) || value.receipts.length > MAX_BOARD_RECEIPTS) return false;
  const member = (id: unknown) => typeof id === 'string' && room.participantIds.includes(id) && people.some(p => p.id === id);
  return value.tasks.every((t: any) => t && isUuid(t.id) && named(t.title, 120) && typeof t.notes === 'string' && t.notes.length <= 2000
    && TASK_STATUSES.includes(t.status) && member(t.createdBy) && member(t.updatedBy)
    && typeof t.updatedAt === 'string' && Number.isFinite(Date.parse(t.updatedAt))
    && Number.isSafeInteger(t.revision) && t.revision >= 1
    && (t.assigneeId === undefined ? t.assignedBy === undefined && t.assignedRevision === undefined
      : member(t.assigneeId) && member(t.assignedBy) && Number.isSafeInteger(t.assignedRevision) && t.assignedRevision >= 1 && t.assignedRevision <= value.revision))
    && value.receipts.every((r: any) => r && isUuid(r.id) && member(r.actorId) && isHash(r.fingerprint) && isUuid(r.taskId) && Number.isSafeInteger(r.revision));
}

export function recover<T>(raw: string, name: string, valid: (value: any) => boolean): T {
  try { const value = JSON.parse(raw); if (!valid(value)) throw new Error('Invalid schema'); return value; }
  catch { throw new Error(`Cannot recover ${name}: invalid stored data. The store has not been reset.`); }
}
