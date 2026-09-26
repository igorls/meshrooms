import { Database } from 'bun:sqlite';
import { sniff } from '../attachments';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { browserProtocol, deviceId, MAX_REPOSITORIES, validRepository, verify, type BrowserDevice, type BrowserMember, type FormerDevice, type JoinRequest, type RoomSettings, type RoomStatus, type Signal, type SignedCommand, DEFAULT_ROOM_SETTINGS } from '../../src/browser/protocol';

/** Only a hash of an agent link's token is kept; the link itself is shown once to the person who made it. */
type StoredInvite = { tokenHash: string; operatorId: string; name: string; expiresAt: number };
/** `retired` keeps the public keys of devices that left, so their earlier signed task changes still verify. */
type Room = { id: string; title: string; ownerId: string; members: BrowserMember[]; devices: BrowserDevice[]; requests: JoinRequest[]; invites?: StoredInvite[]; retired?: FormerDevice[]; settings?: Partial<RoomSettings>; repositories?: string[] };
const RETIRED_DEVICES = 256;
const INVITE_TTL = 900_000, INVITES_PER_PERSON = 4, AGENTS_PER_OPERATOR = 4;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** Avatars are small pictures kept apart from the room record; members carry only a short hash of theirs. */
const AVATAR_BYTES = 16 * 1024, AVATAR_SIDE = 256, AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export class LobbyError extends Error { constructor(public status: number, message: string) { super(message); } }
function fail(status: number, message: string): never { throw new LobbyError(status, message); }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
function label(v: unknown, max = 80): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max || /[\u0000-\u001f]/.test(v)) return fail(400, 'Enter a valid name.');
  return v.trim();
}
/** A member name. `agents` is reserved: `@agents` addresses every agent (AGENTS_MENTION in src/collab.ts). */
function memberName(v: unknown, max = 80): string {
  const name = label(v, max);
  if (name.toLowerCase() === 'agents') fail(400, '"agents" is reserved: @agents addresses every agent. Choose another name.');
  return name;
}
/** Members from before agents existed have no role and are people. */
function isPerson(room: Room, memberId: string) { return room.members.some(m => m.id === memberId && (m.role ?? 'human') === 'human'); }
/** Mentions resolve by name, so an agent may not share a name with anyone in the room or another open agent link. */
function nameAvailable(room: Room, name: string, pending: StoredInvite[] = []) {
  const taken = [...room.members.map(m => m.name), ...pending.map(i => i.name)];
  if (taken.some(n => n.toLowerCase() === name.toLowerCase())) fail(409, 'Someone in this room already uses that name. Choose another agent name.');
}
const settingsOf = (room: Room): RoomSettings => ({ ...DEFAULT_ROOM_SETTINGS, ...room.settings });
/** A harness or model name as the agent reports it: short plain text, so it can't pose as markup or another line. */
function runtimeLabel(value: unknown, key: 'harness' | 'model') {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._:+()/@-]{0,47}$/u.test(value.trim())) fail(400, `Give a ${key} of up to 48 letters, digits, spaces or . _ : + ( ) / @ -.`);
  return value.trim();
}
export type LobbyOptions = { origin: string; now?: () => number; stunUrls?: string[]; turnUrls?: string[]; turnSecret?: string };

/** SQLite stores admission only. Signaling/presence expire in memory; no chat passes through this service. */
export class BrowserLobby {
  private db: Database;
  private now: () => number;
  private presence = new Map<string, { session: string; at: number }>();
  private signals = new Map<string, (Signal & { at: number })[]>();
  private sequence = 0;
  private epoch = crypto.randomUUID();
  constructor(path: string, private options: LobbyOptions) {
    this.now = options.now || Date.now;
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (device TEXT, id TEXT, body TEXT, result TEXT, at INTEGER, PRIMARY KEY(device,id)); CREATE TABLE IF NOT EXISTS avatars (room TEXT, member TEXT, hash TEXT, type TEXT, bytes BLOB, PRIMARY KEY(room,member));');
  }
  close() { this.db.close(); }
  healthy() { this.db.query('SELECT 1').get(); return true; }
  private load(id: string): Room {
    const row = this.db.query('SELECT body FROM rooms WHERE id=?').get(id) as { body: string } | null;
    return row ? JSON.parse(row.body) : fail(404, 'This room is unavailable. Check the invitation.');
  }
  publicRoom(id: string) { const r = this.load(id); return { roomId: r.id, title: r.title }; }
  /** A member's current avatar, only when the hash matches, so an old link never shows a newer picture. */
  avatar(roomId: string, memberId: string, hash: string) {
    return this.db.query('SELECT type, bytes FROM avatars WHERE room=? AND member=? AND hash=?').get(roomId, memberId, hash) as { type: string; bytes: Uint8Array } | null;
  }
  async execute(input: SignedCommand): Promise<RoomStatus | { roomId: string; token?: string }> {
    const c = input?.command;
    if (!c || c.protocol !== browserProtocol || c.origin !== this.options.origin || !uuid(c.id) || !uuid(c.roomId) || !Number.isSafeInteger(c.at) || Math.abs(this.now() - c.at) > 60_000 || !c.payload || typeof c.payload !== 'object' || Array.isArray(c.payload)) fail(400, 'This request has expired or is invalid. Try again.');
    if (typeof input.publicKey !== 'string' || typeof input.signature !== 'string' || !await verify(input.publicKey, c, input.signature)) fail(401, 'This device could not be authenticated.');
    const id = await deviceId(input.publicKey);
    // After verification, all read/modify/write work is synchronous in one transaction.
    return this.db.transaction(() => {
      if (c.action === 'status') return this.snapshot(this.load(c.roomId), id, c.payload);
      // Deduplication needs a fingerprint, not a retained copy of SDP or device codes.
      const serialized = createHash('sha256').update(JSON.stringify({ ...c, at: 0 })).digest('hex');
      const previous = this.db.query('SELECT body,result FROM receipts WHERE device=? AND id=?').get(id, c.id) as { body: string; result: string } | null;
      if (previous) {
        if (previous.body !== serialized) fail(409, 'That request ID was already used.');
        return JSON.parse(previous.result);
      }
      if (c.action === 'create') {
        const count = (this.db.query('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n;
        if (count >= 64) fail(429, 'Room capacity reached.');
        const owned = this.db.query('SELECT body FROM rooms').all() as { body: string }[];
        if (owned.filter(row => { const r: Room = JSON.parse(row.body); return r.devices.some(d => d.id === id && d.memberId === r.ownerId); }).length >= 8) fail(429, 'This device already hosts eight rooms.');
        const existing = this.db.query('SELECT id FROM rooms WHERE id=?').get(c.roomId);
        if (existing) fail(409, 'This room already exists.');
        const memberId = crypto.randomUUID();
        const room: Room = { id: c.roomId, title: label(c.payload.title), ownerId: memberId,
          members: [{ id: memberId, name: memberName(c.payload.name) }],
          devices: [{ id, publicKey: input.publicKey, label: label(c.payload.label), memberId, admittedAt: this.now() }], requests: [] };
        this.save(room);
      } else {
        const room = this.load(c.roomId);
        const actor = room.devices.find(d => d.id === id);
        const isHost = actor?.memberId === room.ownerId;
        const pending = (requestId: unknown) => room.requests.find(r => r.id === requestId && r.state === 'pending' && r.expiresAt > this.now()) || fail(409, 'This request is no longer waiting.');
        const admit = (r: JoinRequest) => {
          if (room.devices.length >= 16) fail(429, 'This room has reached its device limit.');
          if (r.kind === 'companion' && !r.linkedMemberId) fail(409, 'Confirm this device from its existing identity first.');
          if (r.kind === 'agent') {
            if (!r.operatorId || !isPerson(room, r.operatorId)) fail(409, 'This agent’s operator is no longer in the room.');
            nameAvailable(room, r.name);
          }
          const memberId = r.linkedMemberId || crypto.randomUUID();
          if (!r.linkedMemberId) room.members.push(r.kind === 'agent' ? { id: memberId, name: r.name, role: 'agent', operatorId: r.operatorId } : { id: memberId, name: r.name, role: 'human' });
          room.devices.push({ ...r.device, memberId, admittedAt: this.now() });
          r.state = 'admitted'; delete r.code;
        };
        switch (c.action) {
          case 'request': {
            if (actor) break;
            const current = room.requests.find(r => r.device.id === id && r.state === 'pending' && r.expiresAt > this.now());
            if (current) break;
            room.requests = room.requests.filter(r => r.device.id !== id && r.state === 'pending' && r.expiresAt > this.now());
            if (room.requests.length >= 16) fail(429, 'The waiting room is full. Please try again later.');
            if (!['person', 'companion'].includes(String(c.payload.kind))) fail(400, 'Choose how to join.');
            const kind = c.payload.kind as JoinRequest['kind'];
            room.requests.push({ id: c.id, name: memberName(c.payload.name), kind, state: 'pending', expiresAt: this.now() + 600_000,
              device: { id, publicKey: input.publicKey, label: label(c.payload.label), memberId: '', admittedAt: 0 },
              ...(kind === 'companion' ? { code: crypto.randomUUID().replaceAll('-', '').slice(0, 16) } : {}) });
            break;
          }
          case 'link': {
            if (!actor) fail(403, 'Join this room from your existing device first.');
            // Agents are participants of their own; they cannot add devices to anyone's identity.
            if (!isPerson(room, actor.memberId)) fail(403, 'Only people can confirm devices.');
            const r = room.requests.find(r => r.kind === 'companion' && r.code === c.payload.code && r.state === 'pending' && r.expiresAt > this.now()) || fail(404, 'Device code not found or expired.');
            if (r.linkedMemberId && r.linkedMemberId !== actor.memberId) fail(409, 'That device is already linked.');
            r.linkedMemberId = actor.memberId;
            if (isHost) admit(r);
            break;
          }
          case 'agent-invite': {
            if (!actor || !isPerson(room, actor.memberId)) fail(403, 'Only people in this room can connect agents.');
            const invites = (room.invites || []).filter(i => i.expiresAt > this.now());
            const name = memberName(c.payload.name, 64);
            nameAvailable(room, name, invites);
            if (invites.filter(i => i.operatorId === actor.memberId).length >= INVITES_PER_PERSON) fail(429, 'You already have four unused agent links. Use one or wait for them to expire.');
            if (room.members.filter(m => m.role === 'agent' && m.operatorId === actor.memberId).length >= AGENTS_PER_OPERATOR) fail(429, 'You already have four agents in this room.');
            const token = randomBytes(32).toString('base64url');
            room.invites = [...invites, { tokenHash: tokenHash(token), operatorId: actor.memberId, name, expiresAt: this.now() + INVITE_TTL }];
            this.save(room);
            // Deliberately no receipt: the token is returned once and never retained. A retry creates a new link.
            return { roomId: room.id, token };
          }
          case 'agent-redeem': {
            if (actor) fail(409, 'This device is already in the room.');
            const token = c.payload.token;
            const invites = (room.invites || []).filter(i => i.expiresAt > this.now());
            const invite = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? invites.find(i => i.tokenHash === tokenHash(token)) : undefined;
            if (!invite || !isPerson(room, invite.operatorId)) fail(410, 'This agent link was already used or has expired. Ask for a new one.');
            nameAvailable(room, invite.name);
            // Checked again here: links made before the operator's earlier agents joined must not exceed the limit.
            const operated = room.members.filter(m => m.role === 'agent' && m.operatorId === invite.operatorId).length
              + room.requests.filter(r => r.kind === 'agent' && r.state === 'pending' && r.expiresAt > this.now() && r.operatorId === invite.operatorId).length;
            if (operated >= AGENTS_PER_OPERATOR) fail(429, 'The person who made this link already has four agents in this room.');
            if (room.devices.length >= 16) fail(429, 'This room has reached its device limit.');
            room.invites = invites.filter(i => i !== invite);
            room.requests = room.requests.filter(r => r.device.id !== id);
            const device = { id, publicKey: input.publicKey, label: label(c.payload.label), memberId: '', admittedAt: 0 };
            if (settingsOf(room).guestAgentApproval && invite.operatorId !== room.ownerId) {
              // The link was used, but the host decides whether a guest's agent enters.
              if (room.requests.filter(r => r.state === 'pending' && r.expiresAt > this.now()).length >= 16) fail(429, 'The waiting room is full. Please try again later.');
              room.requests.push({ id: c.id, name: invite.name, kind: 'agent', state: 'pending', expiresAt: this.now() + 600_000, device, operatorId: invite.operatorId });
              break;
            }
            const memberId = crypto.randomUUID();
            room.members.push({ id: memberId, name: invite.name, role: 'agent', operatorId: invite.operatorId });
            room.devices.push({ ...device, memberId, admittedAt: this.now() });
            break;
          }
          case 'cancel': {
            const r = pending(c.payload.requestId);
            if (r.device.id !== id) fail(403, 'You can only cancel your own request.');
            room.requests = room.requests.filter(request => request.id !== r.id);
            break;
          }
          case 'decide': {
            if (!isHost) fail(403, 'Only the host can admit or decline requests.');
            const r = pending(c.payload.requestId);
            if (c.payload.admit === true) admit(r);
            else if (c.payload.admit === false) { r.state = 'declined'; delete r.code; }
            else fail(400, 'Choose admit or decline.');
            break;
          }
          case 'remove': {
            const target = room.devices.find(d => d.id === c.payload.deviceId) || fail(404, 'Device not found.');
            const operates = !!actor && room.members.some(m => m.id === target.memberId && m.role === 'agent' && m.operatorId === actor.memberId);
            if (!actor || (!isHost && actor.memberId !== target.memberId && !operates)) fail(403, 'You cannot remove this device.');
            if (target.memberId === room.ownerId && room.devices.filter(d => d.memberId === room.ownerId).length === 1) fail(409, 'Keep at least one host device.');
            const removed = [target];
            const roles = new Map(room.members.map(m => [m.id, m.role ?? 'human'] as const));
            room.devices = room.devices.filter(d => d.id !== target.id);
            // Agents leave with their operator: an agent never stays in a room its operator has left.
            const present = (memberId: string) => room.devices.some(d => d.memberId === memberId);
            for (const agent of room.members.filter(m => m.role === 'agent' && m.operatorId && !present(m.operatorId))) {
              removed.push(...room.devices.filter(d => d.memberId === agent.id));
              room.devices = room.devices.filter(d => d.memberId !== agent.id);
            }
            for (const gone of room.members.filter(m => !present(m.id))) this.db.query('DELETE FROM avatars WHERE room=? AND member=?').run(room.id, gone.id);
            room.members = room.members.filter(m => present(m.id));
            room.requests = room.requests.filter(r => !removed.some(d => d.id === r.device.id) && !(r.kind === 'agent' && r.operatorId && !present(r.operatorId)));
            if (room.invites) room.invites = room.invites.filter(i => present(i.operatorId));
            for (const device of removed) { this.presence.delete(`${room.id}:${device.id}`); this.signals.delete(`${room.id}:${device.id}`); }
            room.retired = [...(room.retired || []).filter(d => !removed.some(r => r.id === d.id)), ...removed.map(({ id, publicKey, memberId }) => ({ id, publicKey, memberId, ...(roles.has(memberId) ? { role: roles.get(memberId)! } : {}) }))].slice(-RETIRED_DEVICES);
            break;
          }
          case 'profile': {
            if (!actor) fail(403, 'Join this room first.');
            const target = c.payload.memberId === undefined ? actor.memberId : c.payload.memberId;
            const member = room.members.find(m => m.id === target) || fail(404, 'That person is not in this room.');
            const own = member.id === actor.memberId, operated = member.role === 'agent' && member.operatorId === actor.memberId;
            const { avatar: encoded, harness, model } = c.payload;
            if (encoded === undefined && harness === undefined && model === undefined) fail(400, 'Choose what to change.');
            if (harness !== undefined || model !== undefined) {
              // Agents say which harness and model they run on; people have neither. Clearing follows the picture rule.
              if (member.role !== 'agent') fail(400, 'Only agents report a harness and model.');
              const clearing = (harness === null || harness === undefined) && (model === null || model === undefined);
              if (!own && !operated && !(clearing && isHost)) fail(403, 'Only the agent or its operator can change this.');
              for (const [key, value] of [['harness', harness], ['model', model]] as const) {
                if (value === undefined) continue;
                if (value === null) { delete member[key]; continue; }
                member[key] = runtimeLabel(value, key);
              }
            }
            if (encoded === undefined) break;
            if (encoded === null) {
              // The host may clear anyone's picture; setting one is for yourself or the agents you operate.
              if (!own && !operated && !isHost) fail(403, 'You can only change your own picture or your agents’.');
              delete member.avatar; this.db.query('DELETE FROM avatars WHERE room=? AND member=?').run(room.id, member.id);
              break;
            }
            if (!own && !operated) fail(403, 'You can only change your own picture or your agents’.');
            if (typeof encoded !== 'string' || encoded.length > Math.ceil(AVATAR_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail(413, 'Use a picture of at most 16 KB.');
            const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
            if (!bytes.length || bytes.length > AVATAR_BYTES) fail(413, 'Use a picture of at most 16 KB.');
            const image = sniff(bytes);
            if (!AVATAR_TYPES.includes(image.type)) fail(415, 'Use a PNG, JPEG or WebP picture.');
            if (!image.width || !image.height || image.width > AVATAR_SIDE || image.height > AVATAR_SIDE) fail(400, 'Use a picture of at most 256 by 256 pixels.');
            const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
            this.db.query('INSERT OR REPLACE INTO avatars VALUES (?,?,?,?,?)').run(room.id, member.id, hash, image.type, bytes);
            member.avatar = hash;
            break;
          }
          case 'repositories': {
            // People pin repositories like pinning in a chat: any person, not only the host; agents don't. One change
            // at a time (pin or unpin a name), so two people pinning at once both keep theirs.
            if (!actor || !isPerson(room, actor.memberId)) fail(403, 'Only people in this room can pin repositories.');
            const { pin, unpin } = c.payload, name = pin ?? unpin;
            if ((pin === undefined) === (unpin === undefined) || !validRepository(name)) fail(400, 'Pin or unpin one GitHub repository, as owner/name.');
            const list = room.repositories ?? [], same = (r: string) => r.toLowerCase() === name.toLowerCase();
            if (pin !== undefined && !list.some(same)) {
              if (list.length >= MAX_REPOSITORIES) fail(400, `A room pins up to ${MAX_REPOSITORIES} repositories. Unpin one first.`);
              room.repositories = [...list, name];
            }
            if (unpin !== undefined) room.repositories = list.filter(r => !same(r));
            if (!room.repositories?.length) delete room.repositories;
            break;
          }
          case 'settings': {
            if (!isHost) fail(403, 'Only the host can change room settings.');
            const next: Partial<RoomSettings> = { ...room.settings };
            if (c.payload.floor !== undefined) { if (!['humans-first', 'open'].includes(String(c.payload.floor))) fail(400, 'Choose when agents reply.'); next.floor = c.payload.floor as RoomSettings['floor']; }
            for (const key of ['agentAssignmentsWake', 'guestAgentApproval'] as const) {
              if (c.payload[key] === undefined) continue;
              if (typeof c.payload[key] !== 'boolean') fail(400, 'Choose on or off.');
              next[key] = c.payload[key] as boolean;
            }
            room.settings = next;
            break;
          }
          case 'signal': {
            if (!actor) fail(403, 'Room admission is required.');
            const target = room.devices.find(d => d.id === c.payload.to) || fail(403, 'The recipient is not admitted.');
            const local = this.presence.get(`${room.id}:${id}`), remote = this.presence.get(`${room.id}:${target.id}`);
            if (!local || local.session !== c.payload.session || !remote || remote.session !== c.payload.targetSession || remote.at < this.now() - 10_000) fail(409, 'The connection changed. Reconnecting.');
            const description = c.payload.description as RTCSessionDescriptionInit;
            if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 16_000) fail(400, 'Invalid connection offer.');
            const key = `${room.id}:${target.id}`;
            const queue = (this.signals.get(key) || []).filter(s => s.at > this.now() - 30_000);
            if (queue.length >= 32) fail(429, 'Connection busy. Try again.');
            queue.push({ seq: ++this.sequence, from: id, session: local.session, targetSession: remote.session, description, at: this.now() });
            this.signals.set(key, queue);
            break;
          }
          default: fail(400, 'Unknown room action.');
        }
        if (c.action !== 'signal') this.save(room);
      }
      const result = { roomId: c.roomId };
      this.db.query('DELETE FROM receipts WHERE at < ?').run(this.now() - 120_000);
      this.db.query('INSERT INTO receipts VALUES (?,?,?,?,?)').run(id, c.id, serialized, JSON.stringify(result), this.now());
      return result;
    })();
  }
  private save(room: Room) { this.db.query('INSERT OR REPLACE INTO rooms VALUES (?,?)').run(room.id, JSON.stringify(room)); }
  private snapshot(room: Room, id: string, payload: Record<string, unknown>): RoomStatus {
    for (const [key, value] of this.presence) if (value.at < this.now() - 30_000) this.presence.delete(key);
    for (const [key, value] of this.signals) {
      const active = value.filter(s => s.at > this.now() - 30_000);
      if (active.length) this.signals.set(key, active); else this.signals.delete(key);
    }
    const online = (d: BrowserDevice) => {
      const p = this.presence.get(`${room.id}:${d.id}`);
      return p && p.at > this.now() - 10_000 ? p.session : undefined;
    };
    const result: RoomStatus = { roomId: room.id, title: room.title, epoch: this.epoch, deviceId: id, hostOnline: room.devices.some(d => d.memberId === room.ownerId && !!online(d)) };
    const actor = room.devices.find(d => d.id === id);
    if (!actor) {
      const request = room.requests.find(r => r.device.id === id);
      result.request = request?.state === 'pending' && request.expiresAt <= this.now() ? { ...request, state: 'expired', code: undefined } : request;
      return result;
    }
    if (!uuid(payload.session)) fail(400, 'Invalid browser session.');
    this.presence.set(`${room.id}:${id}`, { session: payload.session, at: this.now() });
    result.memberId = actor.memberId; result.ownerId = room.ownerId;
    result.members = room.members.filter(m => room.devices.some(d => d.memberId === m.id));
    result.devices = room.devices.map(d => ({ ...d, session: online(d) }));
    if (actor.memberId === room.ownerId) result.requests = room.requests.filter(r => r.state === 'pending' && r.expiresAt > this.now()).map(r => { const { code, ...rest } = r; return rest; });
    if (room.retired?.length) result.formerDevices = room.retired;
    result.settings = settingsOf(room);
    if (room.repositories?.length) result.repositories = room.repositories;
    const invites = (room.invites || []).filter(i => i.operatorId === actor.memberId && i.expiresAt > this.now());
    if (invites.length) result.agentInvites = invites.map(({ name, expiresAt }) => ({ name, expiresAt }));
    const key = `${room.id}:${id}`;
    const cursor = payload.epoch === this.epoch && typeof payload.cursor === 'number' && Number.isSafeInteger(payload.cursor) ? payload.cursor : 0;
    result.signals = (this.signals.get(key) || []).filter(s => s.targetSession === payload.session && s.seq > cursor && room.devices.some(d => d.id === s.from));
    result.iceServers = this.iceServers(id);
    return result;
  }
  private iceServers(id: string): RTCIceServer[] {
    const servers: RTCIceServer[] = [];
    if (this.options.stunUrls?.length) servers.push({ urls: this.options.stunUrls });
    if (this.options.turnUrls?.length && this.options.turnSecret) {
      const username = `${Math.floor(this.now() / 1000) + 3600}:${id}`;
      servers.push({ urls: this.options.turnUrls, username, credential: createHmac('sha1', this.options.turnSecret).update(username).digest('base64') });
    }
    return servers;
  }
}
