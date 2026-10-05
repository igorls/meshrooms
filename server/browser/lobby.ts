import type { Database } from 'bun:sqlite';
import { sniff } from '../attachments';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { browserProtocol, deviceId, MAX_REPOSITORIES, validRepository, verify, type BrowserDevice, type BrowserMember, type FormerDevice, type JoinRequest, type RoomSettings, type RoomStatus, type Signal, type SignedCommand, DEFAULT_ROOM_SETTINGS, PAIRING_NOT_FOUND, ROOM_CLOSED } from '../../src/browser/protocol';
import { PAIRING_PROOF, PAIRING_SECRET, pairingMessage } from '../../src/browser/pairing';
import { consumeInvite, inviteMessages } from './invites';
import { openAdmission, retireRoom, type ClosedReason } from './store';

/** Only a hash of an agent link's token is kept; the link itself is shown once to the person who made it. */
type StoredInvite = { tokenHash: string; operatorId: string; name: string; expiresAt: number };
/** `retired` keeps the public keys of devices that left, so their earlier signed task changes still verify. */
type Room = { id: string; title: string; ownerId: string; members: BrowserMember[]; devices: BrowserDevice[]; requests: JoinRequest[]; invites?: StoredInvite[]; retired?: FormerDevice[]; settings?: Partial<RoomSettings>; repositories?: string[] };
const RETIRED_DEVICES = 256;
const INVITE_TTL = 900_000, INVITES_PER_PERSON = 4, AGENTS_PER_OPERATOR = 4;
/** Devices one member may hold in a room, under the room's 16: one person can't fill the room with devices of their own. */
export const DEVICES_PER_MEMBER = 4;
/** Device codes a device may get wrong in a room per window before `link` answers 429 (codes are 64 bits and expire anyway). */
export const LINK_FAILURES = 8, LINK_FAILURE_WINDOW = 600_000;
/** Requests that wait in a room at once, per kind (people, companions, agents), so no kind can crowd out another. */
export const WAITING_PER_KIND = 16;
/** Requests from one address that wait in a room at once, so one network can't fill a kind's share on its own. */
export const WAITING_PER_ADDRESS = 8;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** Avatars are small pictures kept apart from the room record; members carry only a short hash of theirs. */
const AVATAR_BYTES = 16 * 1024, AVATAR_SIDE = 256, AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** `code` is a stable machine-readable reason for errors clients act on (a closed room, an invite problem). */
export class LobbyError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
function fail(status: number, message: string, code?: string): never { throw new LobbyError(status, message, code); }
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
/** New rooms store their settings; rooms created before hosts approved guests' agents by default keep it off. */
const LEGACY_SETTINGS: Partial<RoomSettings> = { guestAgentApproval: false };
const settingsOf = (room: Room): RoomSettings => ({ ...DEFAULT_ROOM_SETTINGS, ...LEGACY_SETTINGS, ...room.settings });
/** A harness or model name as the agent reports it: short plain text, so it can't pose as markup or another line. */
function runtimeLabel(value: unknown, key: 'harness' | 'model') {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._:+()/@-]{0,47}$/u.test(value.trim())) fail(400, `Give a ${key} of up to 48 letters, digits, spaces or . _ : + ( ) / @ -.`);
  return value.trim();
}
/**
 * `maxRooms` caps rooms service-wide (default 256). `invites: 'required'` gates room creation behind operator invite codes.
 * `idleDays` is how long a room lives without an admitted device opening it (default 30).
 */
export type LobbyOptions = { origin: string; now?: () => number; stunUrls?: string[]; turnUrls?: string[]; turnSecret?: string;
  maxRooms?: number; invites?: 'required' | 'off'; idleDays?: number };
const DAY = 86_400_000;
/** Room activity is written at most hourly per room (less for short idle periods), so polling isn't a write per request. */
const ACTIVITY_WRITE_INTERVAL = 3_600_000;
/** Deduplication needs a fingerprint of a command, not a retained copy of SDP or device codes. */
const fingerprint = (c: SignedCommand['command']) => createHash('sha256').update(JSON.stringify({ ...c, at: 0 })).digest('hex');
/** TURN credentials last at least an hour; the expiry is rounded up to ten minutes so a room keeps one username meanwhile. */
const TURN_LIFETIME = 3600, TURN_STEP = 600;
/**
 * How long a device counts as present after its last status poll. Bridges up to 0.2.0-beta.3 poll only after a whole
 * pass that makes their connection offers one peer at a time, so in a busy room a pass outlasted a 10 s window: the
 * agent dropped out between polls, offers to it failed, and every peer kept reconnecting. Kept under the 30 s pruning.
 */
export const PRESENCE_MS = 25_000;

/** SQLite stores admission only. Signaling/presence expire in memory; no chat passes through this service. */
export class BrowserLobby {
  private db: Database;
  private now: () => number;
  private presence = new Map<string, { session: string; at: number }>();
  private signals = new Map<string, (Signal & { at: number })[]>();
  private sequence = 0;
  private epoch = crypto.randomUUID();
  /** Wrong device codes per room and device, in memory like presence: a bound on guessing, not a record. */
  private linkFailures = new Map<string, { count: number; since: number }>();
  /** Which address each waiting request came from (`room:request`), in memory like presence: a bound, never stored. */
  private requestAddresses = new Map<string, string>();
  /** When each room's activity was last written and committed; see touch(). */
  private active = new Map<string, number>();
  /** Activity written by the transaction in progress; it reaches `active` only if that transaction commits. */
  private pending = new Map<string, number>();
  constructor(path: string, private options: LobbyOptions) {
    this.now = options.now || Date.now;
    this.db = openAdmission(path, this.now());
    this.resume();
  }
  close() { try { this.heartbeat(); } finally { this.db.close(); } }
  get inviteRequired() { return this.options.invites === 'required'; }
  private get idleMs() { return (this.options.idleDays ?? 30) * DAY; }
  /** Records that the service is running, so a later start knows how long it was down. */
  private heartbeat() { this.db.query("INSERT OR REPLACE INTO service_state (key, at) VALUES ('heartbeat', ?)").run(this.now()); }
  /**
   * Time the service was down (stopped, or restored from an older backup) doesn't count as idle: every room's activity
   * moves forward by the downtime before anything is swept. Activity after the last heartbeat counts as fresh now.
   */
  private resume() {
    const now = this.now();
    this.db.transaction(() => {
      const last = this.db.query("SELECT at FROM service_state WHERE key='heartbeat'").get() as { at: number } | null;
      if (last && now > last.at) this.db.query('UPDATE room_activity SET at = MIN(at + ?, ?)').run(now - last.at, now);
      this.heartbeat();
    }).immediate();
  }
  /** Reads a real table, so a missing or unreadable database file fails the health check. */
  healthy() { this.db.query('SELECT COUNT(*) AS n FROM rooms').get(); return true; }
  private load(id: string): Room {
    const row = this.db.query('SELECT body FROM rooms WHERE id=?').get(id) as { body: string } | null;
    if (row) return JSON.parse(row.body);
    const closed = this.db.query('SELECT reason FROM closed_rooms WHERE id=?').get(id) as { reason: ClosedReason } | null;
    if (closed) fail(410, closed.reason === 'closed' ? 'This room was closed by its host.'
      : closed.reason === 'expired' ? 'This room was removed because nobody opened it for a long time.' : 'This room was removed by the service operator.', ROOM_CLOSED);
    return fail(404, 'This room is unavailable. Check the invitation.');
  }
  /**
   * An admitted device opened or used the room: it stays for another idle period. Called inside a transaction; written
   * at most every hour, or a quarter of the idle period if that is shorter.
   */
  private touch(roomId: string) {
    const at = this.now(), last = this.pending.get(roomId) ?? this.active.get(roomId);
    if (last !== undefined && at - last < Math.min(ACTIVITY_WRITE_INTERVAL, this.idleMs / 4)) return last;
    this.db.query('INSERT OR REPLACE INTO room_activity (id, at) VALUES (?,?)').run(roomId, at);
    this.pending.set(roomId, at);
    return at;
  }
  private forget(roomId: string) {
    this.active.delete(roomId); this.pending.delete(roomId);
    for (const map of [this.presence, this.signals, this.requestAddresses]) for (const key of map.keys()) if (key.startsWith(`${roomId}:`)) map.delete(key);
  }
  /** Removes rooms no admitted device opened within the idle period. Returns how many were removed. */
  sweep(): number {
    this.heartbeat();
    const cutoff = this.now() - this.idleMs;
    const idle = this.db.query('SELECT id FROM room_activity WHERE at < ?').all(cutoff) as { id: string }[];
    let removed = 0;
    for (const { id } of idle) if (retireRoom(this.db, id, 'expired', this.now())) { this.forget(id); removed++; }
    this.db.query('DELETE FROM room_activity WHERE id NOT IN (SELECT id FROM rooms)').run();
    return removed;
  }
  /**
   * Whether this is a retry of a command already answered (same device, id and content), so it isn't charged again.
   * Unverified: a forged retry can only get the recorded answer or fail verification in execute().
   */
  async answered(input: unknown): Promise<boolean> {
    const { command: c, publicKey } = (input ?? {}) as Partial<SignedCommand>;
    if (!c || typeof c !== 'object' || !uuid(c.id) || typeof publicKey !== 'string' || publicKey.length !== 88) return false;
    let device: string;
    try { device = await deviceId(publicKey); } catch { return false; }
    const row = this.db.query('SELECT body FROM receipts WHERE device=? AND id=?').get(device, c.id) as { body: string } | null;
    return row?.body === fingerprint(c);
  }
  publicRoom(id: string) { const r = this.load(id); return { roomId: r.id, title: r.title }; }
  /** A member's current avatar, only when the hash matches, so an old link never shows a newer picture. */
  avatar(roomId: string, memberId: string, hash: string) {
    return this.db.query('SELECT type, bytes FROM avatars WHERE room=? AND member=? AND hash=?').get(roomId, memberId, hash) as { type: string; bytes: Uint8Array } | null;
  }
  /**
   * `address`: who sent the command, as the HTTP layer keys addresses (one IPv4 address, or an IPv6 /64), for the cap
   * on waiting requests per address. Commands without one (tests, local tools) aren't capped by address.
   */
  async execute(input: SignedCommand, address?: string): Promise<RoomStatus | { roomId: string; token?: string; admitted?: boolean }> {
    const c = input?.command;
    if (!c || c.protocol !== browserProtocol || c.origin !== this.options.origin || !uuid(c.id) || !uuid(c.roomId) || !Number.isSafeInteger(c.at) || Math.abs(this.now() - c.at) > 60_000 || !c.payload || typeof c.payload !== 'object' || Array.isArray(c.payload)) fail(400, 'This request has expired or is invalid. Try again.');
    if (typeof input.publicKey !== 'string' || typeof input.signature !== 'string' || !await verify(input.publicKey, c, input.signature)) fail(401, 'This device could not be authenticated.');
    const id = await deviceId(input.publicKey);
    // After verification, all read/modify/write work is synchronous in one transaction. IMMEDIATE takes the write lock
    // up front, so an operator command writing the same file in between can't invalidate what this one read.
    try {
      const result = this.run(c, id, input, address);
      for (const [room, at] of this.pending) this.active.set(room, at);
      return result;
    } finally { this.pending.clear(); }
  }
  private run(c: SignedCommand['command'], id: string, input: SignedCommand, address?: string): RoomStatus | { roomId: string; token?: string; admitted?: boolean } {
    return this.db.transaction(() => {
      if (c.action === 'status') return this.snapshot(this.load(c.roomId), id, c.payload);
      const serialized = fingerprint(c);
      /** What an action adds to its answer (and to its receipt, so a retry gets the same). */
      const answer: { admitted?: boolean } = {};
      const previous = this.db.query('SELECT body,result FROM receipts WHERE device=? AND id=?').get(id, c.id) as { body: string; result: string } | null;
      if (previous) {
        if (previous.body !== serialized) fail(409, 'That request ID was already used.');
        return JSON.parse(previous.result);
      }
      if (c.action === 'create') {
        const count = (this.db.query('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n;
        if (count >= (this.options.maxRooms ?? 256)) fail(429, 'The room service is full right now. Try again later.');
        const owned = this.db.query('SELECT body FROM rooms').all() as { body: string }[];
        if (owned.filter(row => { const r: Room = JSON.parse(row.body); return r.devices.some(d => d.id === id && d.memberId === r.ownerId); }).length >= 8) fail(429, 'This device already hosts eight rooms.');
        const existing = this.db.query('SELECT id FROM rooms WHERE id=? UNION SELECT id FROM closed_rooms WHERE id=?').get(c.roomId, c.roomId);
        if (existing) fail(409, 'This room already exists.');
        const memberId = crypto.randomUUID();
        const room: Room = { id: c.roomId, title: label(c.payload.title), ownerId: memberId,
          members: [{ id: memberId, name: memberName(c.payload.name) }],
          devices: [{ id, publicKey: input.publicKey, label: label(c.payload.label), memberId, admittedAt: this.now() }], requests: [],
          settings: { guestAgentApproval: DEFAULT_ROOM_SETTINGS.guestAgentApproval } };
        // Last, so nothing above can fail after a use was taken; the transaction rolls it back if anything below does.
        if (this.inviteRequired) {
          const problem = consumeInvite(this.db, c.payload.invite, this.now());
          if (problem) fail(problem === 'invite-required' || problem === 'invite-invalid' ? 403 : 410, inviteMessages[problem], problem);
        }
        this.save(room);
        this.touch(room.id);
      } else {
        const room = this.load(c.roomId);
        const actor = room.devices.find(d => d.id === id);
        const isHost = actor?.memberId === room.ownerId;
        if (actor) this.touch(room.id);
        const pending = (requestId: unknown) => room.requests.find(r => r.id === requestId && r.state === 'pending' && r.expiresAt > this.now()) || fail(409, 'This request is no longer waiting.');
        const admit = (r: JoinRequest) => {
          if (room.devices.length >= 16) fail(429, 'This room has reached its device limit.');
          if (r.kind === 'companion' && !r.linkedMemberId) fail(409, 'Confirm this device from its existing identity first.');
          if (r.linkedMemberId) {
            // A device only ever joins a member who is still here, and each member holds at most DEVICES_PER_MEMBER.
            if (!room.devices.some(d => d.memberId === r.linkedMemberId)) fail(409, 'The person this device belongs to is no longer in the room.');
            if (room.devices.filter(d => d.memberId === r.linkedMemberId).length >= DEVICES_PER_MEMBER) fail(429, `Each person can have up to ${DEVICES_PER_MEMBER} devices in this room. Remove one first.`);
          }
          if (r.kind === 'agent') {
            if (!r.operatorId || !isPerson(room, r.operatorId)) fail(409, 'This agent’s operator is no longer in the room.');
            nameAvailable(room, r.name);
          }
          const memberId = r.linkedMemberId || crypto.randomUUID();
          if (!r.linkedMemberId) room.members.push(r.kind === 'agent' ? { id: memberId, name: r.name, role: 'agent', operatorId: r.operatorId } : { id: memberId, name: r.name, role: 'human' });
          room.devices.push({ ...r.device, memberId, admittedAt: this.now() });
          r.state = 'admitted'; delete r.code; delete r.pairing;
        };
        switch (c.action) {
          case 'request': {
            if (actor) break;
            // A companion asks either for a code its person enters elsewhere, or (`pairing`, see src/browser/pairing.ts) to
            // be linked by the browser holding the secret its proof was made with: never both, so neither check can stand in
            // for the other. The proof is bound to this device's key, this room and the browser device that may link it.
            const pairing = c.payload.pairing;
            if (pairing !== undefined && (c.payload.kind !== 'companion' || typeof pairing !== 'string' || !PAIRING_PROOF.test(pairing))) fail(400, 'Only a companion request carries a pairing, as 64 lowercase hex characters.');
            const current = room.requests.find(r => r.device.id === id && r.state === 'pending' && r.expiresAt > this.now());
            // A request still waiting is kept, unless this device now pairs with a browser (another one, or for the first
            // time): then it asks anew under the new proof. One a person already linked waits for the host as it is.
            if (current && (pairing === undefined || current.pairing === pairing || current.linkedMemberId)) break;
            room.requests = room.requests.filter(r => r.device.id !== id && r.state === 'pending' && r.expiresAt > this.now());
            if (!['person', 'companion'].includes(String(c.payload.kind))) fail(400, 'Choose how to join.');
            const kind = c.payload.kind as JoinRequest['kind'];
            // Each kind waits in its own share of the waiting room, so a flood of one (throwaway keys asking as companions,
            // say) never keeps a person, or an agent, from asking. They expire after ten minutes; the host can decline them.
            if (room.requests.filter(r => r.kind === kind).length >= WAITING_PER_KIND) fail(429, 'The waiting room is full. Please try again later, or ask the host to clear it.');
            // And one address fills at most WAITING_PER_ADDRESS places, however many keys it makes.
            for (const key of this.requestAddresses.keys()) if (key.startsWith(`${room.id}:`) && !room.requests.some(r => `${room.id}:${r.id}` === key)) this.requestAddresses.delete(key);
            if (address !== undefined) {
              if (room.requests.filter(r => this.requestAddresses.get(`${room.id}:${r.id}`) === address).length >= WAITING_PER_ADDRESS) fail(429, 'Too many requests from your network are waiting in this room. Try again later.');
              this.requestAddresses.set(`${room.id}:${c.id}`, address);
            }
            room.requests.push({ id: c.id, name: memberName(c.payload.name), kind, state: 'pending', expiresAt: this.now() + 600_000,
              device: { id, publicKey: input.publicKey, label: label(c.payload.label), memberId: '', admittedAt: 0 },
              ...(kind === 'companion' ? typeof pairing === 'string' ? { pairing } : { code: randomBytes(8).toString('hex') } : {}) });
            break;
          }
          case 'link': {
            if (!actor) fail(403, 'Join this room from your existing device first.');
            // Agents are participants of their own; they cannot add devices to anyone's identity.
            if (!isPerson(room, actor.memberId)) fail(403, 'Only people can confirm devices.');
            // Wrong codes are counted per device and room outside the transaction (which rolls back with the failure).
            const failures = `${room.id}:${id}`, failed = this.linkFailures.get(failures);
            if (failed && this.now() - failed.since > LINK_FAILURE_WINDOW) this.linkFailures.delete(failures);
            if ((this.linkFailures.get(failures)?.count ?? 0) >= LINK_FAILURES) fail(429, 'Too many wrong device codes. Wait a few minutes, then try again.');
            const miss = (message: string, code?: string): never => {
              const current = this.linkFailures.get(failures);
              this.linkFailures.set(failures, { count: (current?.count ?? 0) + 1, since: current?.since ?? this.now() });
              return fail(404, message, code);
            };
            const { code, pairing } = c.payload;
            if (code !== undefined && pairing !== undefined) fail(400, 'Link with a device code or a pairing secret, not both.');
            let r: JoinRequest | undefined;
            if (pairing !== undefined) {
              // The browser that made the secret links the app's request by it. Each waiting pairing's proof is made again
              // here from the secret, with that request's own device key and this room, and compared in constant time.
              const secret = typeof pairing === 'string' && PAIRING_SECRET.test(pairing) ? Buffer.from(pairing, 'base64url') : undefined;
              if (!secret || secret.length !== 32 || secret.toString('base64url') !== pairing) fail(400, 'This pairing secret is not valid.');
              const waiting = room.requests.filter(r => r.kind === 'companion' && r.pairing && r.state === 'pending' && r.expiresAt > this.now());
              const matches = waiting.filter(r => {
                // The linking device's own id: only the browser device the pairing link named can link it.
                const proof = Buffer.from(createHmac('sha256', secret!).update(pairingMessage(room.id, r.device.publicKey, id)).digest('hex'));
                const claimed = Buffer.from(r.pairing!);
                return proof.length === claimed.length && timingSafeEqual(proof, claimed);
              });
              // Every link that matches nothing counts against this device's own budget in this room, whatever other devices
              // asked: their requests can neither spend it nor spare it. The browser links once the app says it has asked.
              if (!matches.length) miss('The desktop app has not asked to join this room yet, or the pairing expired.', PAIRING_NOT_FOUND);
              // Two requests can't hold proofs from one secret unless something is wrong: link neither.
              if (matches.length > 1) fail(409, 'More than one device answers this pairing, so none was linked. Pair again.');
              r = matches[0];
            } else {
              r = typeof code === 'string' && /^[a-f0-9]{16}$/.test(code)
                ? room.requests.find(r => r.kind === 'companion' && r.code === code && r.state === 'pending' && r.expiresAt > this.now()) : undefined;
              if (!r) miss('Device code not found or expired.');
            }
            r = r!;
            if (r.linkedMemberId && r.linkedMemberId !== actor.memberId) fail(409, 'That device is already linked.');
            r.linkedMemberId = actor.memberId;
            // A pairing secret links once: the request now belongs to this person, whatever the host decides.
            delete r.pairing;
            // The host admitted the person; adding their own devices is their call. The code is the secret and the
            // request is linked to the linker's own member, so a link can only ever add a device to the linker. The host
            // keeps the say over a device it removed (its key stays in `retired`), and over every device with hostApprovesDevices.
            const removedBefore = (room.retired || []).some(d => d.id === r.device.id);
            if (isHost || (!settingsOf(room).hostApprovesDevices && !removedBefore && isPerson(room, actor.memberId) && r.kind === 'companion' && r.linkedMemberId === actor.memberId)) admit(r);
            // Whether the device is in now, or waits for the host: the browser that paired says which.
            answer.admitted = r.state === 'admitted';
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
              if (room.requests.filter(r => r.kind === 'agent' && r.state === 'pending' && r.expiresAt > this.now()).length >= WAITING_PER_KIND) fail(429, 'The waiting room is full. Please try again later.');
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
            else if (c.payload.admit === false) { r.state = 'declined'; delete r.code; delete r.pairing; }
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
            for (const key of ['agentAssignmentsWake', 'guestAgentApproval', 'hostApprovesDevices'] as const) {
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
            if (!local || local.session !== c.payload.session || !remote || remote.session !== c.payload.targetSession || remote.at < this.now() - PRESENCE_MS) fail(409, 'The connection changed. Reconnecting.');
            const description = c.payload.description as RTCSessionDescriptionInit;
            if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 16_000) fail(400, 'Invalid connection offer.');
            const key = `${room.id}:${target.id}`;
            const queue = (this.signals.get(key) || []).filter(s => s.at > this.now() - 30_000);
            if (queue.length >= 32) fail(429, 'Connection busy. Try again.');
            queue.push({ seq: ++this.sequence, from: id, session: local.session, targetSession: remote.session, description, at: this.now() });
            this.signals.set(key, queue);
            break;
          }
          case 'close': {
            // The room, its admission records and pictures are deleted; members' browsers keep their own copies.
            if (!isHost) fail(403, 'Only the host can delete this room.');
            retireRoom(this.db, room.id, 'closed', this.now());
            this.forget(room.id);
            break;
          }
          default: fail(400, 'Unknown room action.');
        }
        if (c.action !== 'signal' && c.action !== 'close') this.save(room);
      }
      const result = { roomId: c.roomId, ...answer };
      this.db.query('DELETE FROM receipts WHERE at < ?').run(this.now() - 120_000);
      this.db.query('INSERT INTO receipts VALUES (?,?,?,?,?)').run(id, c.id, serialized, JSON.stringify(result), this.now());
      return result;
    }).immediate();
  }
  private save(room: Room) { this.db.query('INSERT OR REPLACE INTO rooms VALUES (?,?)').run(room.id, JSON.stringify(room)); }
  private snapshot(room: Room, id: string, payload: Record<string, unknown>): RoomStatus {
    for (const [key, value] of this.presence) if (value.at < this.now() - 30_000) this.presence.delete(key);
    for (const [key, value] of this.linkFailures) if (this.now() - value.since > LINK_FAILURE_WINDOW) this.linkFailures.delete(key);
    for (const [key, value] of this.signals) {
      const active = value.filter(s => s.at > this.now() - 30_000);
      if (active.length) this.signals.set(key, active); else this.signals.delete(key);
    }
    const online = (d: BrowserDevice) => {
      const p = this.presence.get(`${room.id}:${d.id}`);
      return p && p.at > this.now() - PRESENCE_MS ? p.session : undefined;
    };
    const result: RoomStatus = { roomId: room.id, title: room.title, epoch: this.epoch, deviceId: id, hostOnline: room.devices.some(d => d.memberId === room.ownerId && !!online(d)) };
    const actor = room.devices.find(d => d.id === id);
    if (!actor) {
      const request = room.requests.find(r => r.device.id === id);
      // A pairing proof is shown to nobody, the device that sent it included: it never needs it back.
      const shown = request && (({ pairing, ...rest }) => rest)(request);
      result.request = shown?.state === 'pending' && shown.expiresAt <= this.now() ? { ...shown, state: 'expired', code: undefined } : shown;
      return result;
    }
    if (!uuid(payload.session)) fail(400, 'Invalid browser session.');
    result.expiresAt = this.touch(room.id) + this.idleMs;
    this.presence.set(`${room.id}:${id}`, { session: payload.session, at: this.now() });
    result.memberId = actor.memberId; result.ownerId = room.ownerId;
    result.members = room.members.filter(m => room.devices.some(d => d.memberId === m.id));
    result.devices = room.devices.map(d => ({ ...d, session: online(d) }));
    if (actor.memberId === room.ownerId) result.requests = room.requests.filter(r => r.state === 'pending' && r.expiresAt > this.now()).map(r => { const { code, pairing, ...rest } = r; return rest; });
    if (room.retired?.length) result.formerDevices = room.retired;
    result.settings = settingsOf(room);
    if (room.repositories?.length) result.repositories = room.repositories;
    const invites = (room.invites || []).filter(i => i.operatorId === actor.memberId && i.expiresAt > this.now());
    if (invites.length) result.agentInvites = invites.map(({ name, expiresAt }) => ({ name, expiresAt }));
    const key = `${room.id}:${id}`;
    const cursor = payload.epoch === this.epoch && typeof payload.cursor === 'number' && Number.isSafeInteger(payload.cursor) ? payload.cursor : 0;
    result.signals = (this.signals.get(key) || []).filter(s => s.targetSession === payload.session && s.seq > cursor && room.devices.some(d => d.id === s.from));
    result.iceServers = this.iceServers(room);
    return result;
  }
  /**
   * TURN credentials are per room, not per device, so the relay's per-user quota bounds a room however many throwaway
   * keys join it; and a room with one device has nobody to relay to, so it gets none.
   */
  private iceServers(room: Room): RTCIceServer[] {
    const servers: RTCIceServer[] = [];
    if (this.options.stunUrls?.length) servers.push({ urls: this.options.stunUrls });
    if (this.options.turnUrls?.length && this.options.turnSecret && room.devices.length >= 2) {
      const expiry = Math.ceil((Math.floor(this.now() / 1000) + TURN_LIFETIME) / TURN_STEP) * TURN_STEP;
      const username = `${expiry}:${room.id}`;
      servers.push({ urls: this.options.turnUrls, username, credential: createHmac('sha1', this.options.turnSecret).update(username).digest('base64') });
    }
    return servers;
  }
}
