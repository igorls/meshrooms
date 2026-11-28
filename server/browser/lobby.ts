import type { Database } from 'bun:sqlite';
import { CLAIM_TTL_MS, FLOORS, NEW_ROOM_FLOOR, type Claim, type Floor } from '../../src/collab';
import { sniff } from '../attachments';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AGENT_RUNTIME_FIELDS, CONTROL_ROOM_ID, agentRuntimeLabelError, browserProtocol, cleanAgentRuntimeLabel, cleanDisplayName, deviceId, foldDisplayName, MAX_REPOSITORIES, MAX_RENAME_NOTICES, MIN_PROTOCOL_VERSION, validRepository, verify, type BrowserDevice, type BrowserMember, type RenameNotice, type Command, type JoinRequest, type RoomSettings, type RoomStatus, type Signal, type SignedCommand, type SignedRoster, DEFAULT_ROOM_SETTINGS, PAIR_OFFER_NOT_FOUND, PAIRING_NOT_FOUND, ROOM_CLOSED, type CommandAnswer, type PairingOffer } from '../../src/browser/protocol';
import { importEncPublicKey, verifyEncBinding, verifyRoster } from '../../src/browser/relay-crypto';
import { OFFER_LOOKUP, OFFER_MAX_ROOMS, OFFER_TTL_MS, PAIRING_PROOF, PAIRING_SECRET, pairingMessage } from '../../src/browser/pairing';
import { admitBetaDevice, betaDevices, betaPerson, betaRevoked, consumeInvite, inviteMessages } from './invites';
import { deleteRetiredDevice, getRetiredDevice, getRoomRoster, listRetiredDevices, MAX_FORMER_DEVICES, MAX_HISTORY_FORMER_DEVICES, openAdmission, retireRoom, revokeRetiredDevice, ROOM_META_VERSION, saveRoom, saveRoomRoster, upsertRetiredDevice, type ClosedReason } from './store';

/** Only a hash of an agent link's token is kept; the link itself is shown once to the person who made it. */
type StoredInvite = { tokenHash: string; operatorId: string; name: string; expiresAt: number };
/** Cooldown (`until` timestamp) or permanent block (`until: null`) recorded when the host declines a join request. */
type BlockedDevice = { deviceId: string; until: number | null };
type Room = { id: string; title: string; ownerId: string; ownerPerson?: string; members: BrowserMember[]; devices: BrowserDevice[]; requests: JoinRequest[]; invites?: StoredInvite[]; blocked?: BlockedDevice[]; settings?: Partial<RoomSettings>; historyEverEnabled?: true; repositories?: string[]; renames?: RenameNotice[]; claims?: Claim[] };
/** How long a declined device waits before asking to join the same room again. */
export const DECLINE_COOLDOWN_MS = 5 * 60_000;
/** Maximum decline cooldown / block entries retained per room. */
export const MAX_BLOCKED_DEVICES = 256;
/** Claims a room keeps (see `claim`). Answered ones make room first, oldest first. */
export const MAX_CLAIMS = 64;
/** Unanswered claims one agent may hold at once, so no agent can hold every open question. */
export const MAX_LIVE_CLAIMS = 4;
/** How long an answered claim is kept, so a late agent still sees who answered. */
export const CLAIM_KEEP_MS = 24 * 3_600_000;
const INVITE_TTL = 900_000, INVITES_PER_PERSON = 4;
/** Agents one person may operate in one room, by default (LobbyOptions.agentsPerOperator, MESHROOMS_AGENTS_PER_OPERATOR). */
export const AGENTS_PER_OPERATOR = 8;
/** Devices one member may hold in a room, under the room's 16: one person can't fill the room with devices of their own. */
export const DEVICES_PER_MEMBER = 4;
/** Device codes a device may get wrong in a room per window before `link` answers 429 (codes are 64 bits and expire anyway). */
export const LINK_FAILURES = 8, LINK_FAILURE_WINDOW = 600_000;
/** Pairing offers (`pair-offer`) the service holds at once, and the wrong lookups one device or address may try per window. */
export const MAX_OFFERS = 512, OFFER_FAILURES = 8;
type Offer = { device: string; name: string; rooms: string[]; expiresAt: number; redeemedBy?: string };
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
  if (typeof v !== 'string') return fail(400, 'Enter a valid name.');
  const cleaned = cleanDisplayName(v);
  if (!cleaned || cleaned.length > max) return fail(400, 'Enter a valid name.');
  return cleaned;
}
/** A member name. `agents` is reserved: `@agents` addresses every agent (AGENTS_MENTION in src/collab.ts). */
function memberName(v: unknown, max = 80): string {
  const name = label(v, max);
  if (foldDisplayName(name) === 'agents') fail(400, '"agents" is reserved: @agents addresses every agent. Choose another name.');
  return name;
}
/** Members from before agents existed have no role and are people. */
function isPerson(room: Room, memberId: string) { return room.members.some(m => m.id === memberId && (m.role ?? 'human') === 'human'); }
/** Active members currently holding at least one device in the room. */
function activeMembers(room: Room) { return room.members.filter(m => room.devices.some(d => d.memberId === m.id)); }
/** Mentions and approval views resolve by name, so active members and open agent invites keep NFKC+case-folded unique names. */
function nameAvailable(room: Room, name: string, pending: StoredInvite[] = [], except?: string) {
  const target = foldDisplayName(name);
  const taken = [...activeMembers(room).filter(m => m.id !== except).map(m => m.name), ...pending.map(i => i.name)];
  if (taken.some(n => foldDisplayName(n) === target)) fail(409, 'Someone in this room already uses that name. Choose a different name.');
}
/** New rooms store their settings; rooms created before hosts approved guests' agents by default keep it off. */
const LEGACY_SETTINGS: Partial<RoomSettings> = { guestAgentApproval: false };
/**
 * The claims that still hold: unanswered ones until they lapse, while their agent is still in the room, and answered ones
 * for CLAIM_KEEP_MS, so an agent that comes late still learns who answered.
 */
const liveClaims = (room: Room, now: number) => (room.claims ?? []).filter(k => k.answered ? now - k.at < CLAIM_KEEP_MS : k.until > now && room.members.some(m => m.id === k.memberId) && room.devices.some(d => d.memberId === k.memberId));
const settingsOf = (room: Room): RoomSettings => ({ ...DEFAULT_ROOM_SETTINGS, ...LEGACY_SETTINGS, ...room.settings });
/**
 * `maxRooms` caps rooms service-wide (default 256). `invites: 'required'` gates room creation behind operator invite codes.
 * `idleDays` is how long a room lives without an admitted device opening it (default 30).
 */
export type LobbyOptions = { origin: string; /** Agents one person may operate in one room (default AGENTS_PER_OPERATOR). */ agentsPerOperator?: number; /** Other origins of this service, accepted like `origin`. */ aliases?: string[]; now?: () => number; stunUrls?: string[]; turnUrls?: string[]; turnSecret?: string;
  relayUrl?: string; /** Advertise and accept the E2E relay (relay URL, host-signed rosters, device encryption keys). Default true here; the coordinator process passes its `MESHROOMS_RELAY_ENABLED` flag, which defaults to off. */ relayEnabled?: boolean; maxRooms?: number; invites?: 'required' | 'off'; idleDays?: number; maxSignalChars?: number; minProtocolVersion?: number };
/**
 * Connection offers wait in memory for up to 30 seconds. One queue holds at most 32 of 16,000 characters, but there
 * is a queue per device of every room: 256 full rooms could queue about 2 GB, far past the service's memory limit.
 * This many characters of SDP are held in all queues together; beyond it a new offer is refused until some expire.
 * A typical offer is 2,000 to 6,000 characters, so this is several thousand of them at once.
 */
export const MAX_SIGNAL_CHARS = 32_000_000;
/** How long an unpolled WebRTC signal stays queued in memory before expiring. */
export const SIGNAL_TTL_MS = 30_000;
/** Maximum queued signals held for one recipient device at once across all peers in its room. */
export const MAX_SIGNALS_PER_DEVICE = 32;
/** Fair per-sender cap within a recipient's queue so one noisy peer cannot starve other room members. */
export const MAX_SIGNALS_PER_SENDER = 8;
const DAY = 86_400_000;
/** Room activity is written at most hourly per room (less for short idle periods), so polling isn't a write per request. */
const ACTIVITY_WRITE_INTERVAL = 3_600_000;
/** Global in-memory sweeps (presence, link-failure windows, expired signals) run at most once per signal TTL on polls. */
const MEMORY_PRUNE_INTERVAL = SIGNAL_TTL_MS;
/** Expired SQLite command receipts are pruned at most once per minute rather than on every mutating request. */
const RECEIPT_PRUNE_INTERVAL = 60_000;
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
  /** The SDP characters queued in `signals`, and the most the service holds at once (see MAX_SIGNAL_CHARS). */
  private signalChars = 0;
  private get maxSignalChars() { return this.options.maxSignalChars ?? MAX_SIGNAL_CHARS; }
  private sequence = 0;
  private epoch = crypto.randomUUID();
  /** Wrong device codes per room and device, in memory like presence: a bound on guessing, not a record. */
  private linkFailures = new Map<string, { count: number; since: number }>();
  /** Which address each waiting request came from (`room:request`), in memory like presence: a bound, never stored. */
  private requestAddresses = new Map<string, string>();
  /** When each room's activity was last written and committed; see touch(). */
  private active = new Map<string, number>();
  /** Rooms that currently hold any in-memory state (`active`, `presence`, `signals`, or `requestAddresses`). */
  private liveRooms = new Set<string>();
  /** Activity written by the transaction in progress; it reaches `active` only if that transaction commits. */
  private pending = new Map<string, number>();
  /** Rooms retired by the transaction in progress; forgotten from memory only if that transaction commits. */
  private pendingForget = new Set<string>();
  /** Devices removed by the transaction in progress; cleared from presence/signals only if that transaction commits. */
  private pendingDropDevices: { roomId: string; deviceIds: Set<string> }[] = [];
  /** Last time global in-memory maps (presence, linkFailures, signals) were swept on a status poll. */
  private lastMemoryPrune: number;
  /** Last time expired rows were pruned from `receipts`, and any prune performed by the transaction in progress. */
  private lastReceiptPrune: number;
  private pendingReceiptPrune: number | undefined;
  /** Subscribers notified synchronously after a device is removed from a room (used by RelayService). */
  private deviceRemovedListeners = new Set<(roomId: string, deviceId: string) => void>();
  /** Subscribers notified synchronously after a room is closed or expired (used by RelayService). */
  private roomClosedListeners = new Set<(roomId: string) => void>();
  /** Fired after anything in a room that its devices' status would show changed (`deviceId`: only that device's). */
  private roomChangedListeners = new Set<(roomId: string, deviceId?: string) => void>();
  /** The origins a signed command may name: the service's own, and its aliases. */
  private readonly origins: Set<string>;
  constructor(path: string, private options: LobbyOptions) {
    this.origins = new Set([options.origin, ...(options.aliases ?? [])]);
    this.now = options.now || Date.now;
    this.lastMemoryPrune = this.now();
    this.lastReceiptPrune = this.now();
    this.db = openAdmission(path, this.now());
    // Grandfather existing creators and their authenticated companion devices, never guests or agents.
    if (this.inviteRequired) this.grandfatherHosts();
    this.resume();
  }
  close() { try { this.heartbeat(); } finally { this.db.close(); } }
  get inviteRequired() { return this.options.invites === 'required'; }
  get minProtocolVersion() { return this.options.minProtocolVersion ?? MIN_PROTOCOL_VERSION; }
  get relayEnabled() { return this.options.relayEnabled !== false; }
  get agentsPerOperator() { return this.options.agentsPerOperator ?? AGENTS_PER_OPERATOR; }
  get relayUrl() { return this.relayUrlFor(this.options.origin); }
  /**
   * The relay a device reaching the service through `origin` is told about: at that origin. A configured relay URL at one
   * of the service's own addresses moves to the device's address too, since each address only takes its own pages'
   * requests; one at a host of its own is kept.
   */
  relayUrlFor(origin: string) {
    const ws = origin.replace(/^http/, 'ws');
    if (!this.options.relayUrl) return `${ws}/api/relay/v1`;
    try {
      const url = new URL(this.options.relayUrl);
      if ([...this.origins].some(own => own.replace(/^http/, 'ws') === url.origin)) return `${ws}${url.pathname}${url.search}`;
    } catch { /* kept as configured */ }
    return this.options.relayUrl;
  }
  /** Every origin of this service. */
  get allOrigins() { return [...this.origins]; }
  /** Registers a hook fired immediately after a device is removed from a room. Returns an unsubscribe function. */
  onDeviceRemoved(listener: (roomId: string, deviceId: string) => void): () => void {
    this.deviceRemovedListeners.add(listener);
    return () => { this.deviceRemovedListeners.delete(listener); };
  }
  /**
   * Registers a hook fired after a room's status changed for its devices: a command that changed the room, a device that
   * came online or changed its session, or (with `deviceId`) a signal queued for one device. The relay pushes status to
   * the devices that watch it, so they don't have to poll. Returns an unsubscribe function.
   */
  onRoomChanged(listener: (roomId: string, deviceId?: string) => void): () => void {
    this.roomChangedListeners.add(listener);
    return () => { this.roomChangedListeners.delete(listener); };
  }
  private changed(roomId: string, deviceId?: string) {
    for (const listener of this.roomChangedListeners) { try { listener(roomId, deviceId); } catch { /* a listener never fails a command */ } }
  }
  /**
   * A device's status, as the `status` command answers it, for a device the relay already authenticated in the room:
   * the same presence, signals and cursor rules. `origin`: the address the device's socket authenticated through.
   */
  statusFor(roomId: string, deviceId: string, payload: Record<string, unknown>, origin?: string): RoomStatus {
    return this.snapshot(this.load(roomId), deviceId, payload, origin && this.origins.has(origin) ? origin : this.options.origin);
  }
  /** Registers a hook fired immediately after a room is closed or retired. Returns an unsubscribe function. */
  onRoomClosed(listener: (roomId: string) => void): () => void {
    this.roomClosedListeners.add(listener);
    return () => { this.roomClosedListeners.delete(listener); };
  }
  /**
   * Verifies a SignedCommand's envelope (protocol, origin, uuid ids, ±60s clock window, expected action(s), ECDSA
   * signature) without opening an IMMEDIATE write lock or writing a receipt row. Used by RelayService for WSS auth
   * and HTTPS fallback routes.
   */
  async verifySignedCommand(
    input: SignedCommand,
    expectedAction: Command['action'] | readonly Command['action'][],
  ): Promise<{ command: Command; deviceId: string; publicKey: string }> {
    const c = input?.command;
    if (!c || c.protocol !== browserProtocol || !this.origins.has(c.origin) || !uuid(c.id) || !uuid(c.roomId) || !Number.isSafeInteger(c.at) || Math.abs(this.now() - c.at) > 60_000 || !c.payload || typeof c.payload !== 'object' || Array.isArray(c.payload)) {
      fail(400, 'This request has expired or is invalid. Try again.');
    }
    const allowed = Array.isArray(expectedAction) ? expectedAction : [expectedAction];
    if (!allowed.includes(c.action)) fail(400, 'Unexpected command action.');
    if (typeof input.publicKey !== 'string' || typeof input.signature !== 'string' || !await verify(input.publicKey, c, input.signature)) {
      fail(401, 'This device could not be authenticated.');
    }
    const id = await deviceId(input.publicKey);
    return { command: c, deviceId: id, publicKey: input.publicKey };
  }
  /**
   * Whether a device takes part in Meshrooms here: admitted (not retired) in some room, or admitted to the beta. Remote
   * control's endpoint (control.ts) serves only these, so a key made a moment ago gets nothing from it.
   */
  participantDevice(id: string): boolean {
    return !!this.db.query('SELECT 1 FROM room_devices WHERE device_id = ? AND retired = 0 LIMIT 1').get(id) || !!betaPerson(this.db, id);
  }
  /** Returns true when `deviceId` is currently an admitted (non-retired) device in `roomId`. */
  isAdmittedDevice(roomId: string, id: string): boolean {
    return !!this.db.query('SELECT 1 FROM room_devices WHERE room_id = ? AND device_id = ? AND retired = 0').get(roomId, id);
  }
  /** Throws 410 if room closed, 404 if room missing, or 403 if device is not admitted. */
  assertAdmittedDevice(roomId: string, id: string): void {
    if (!this.db.query('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) this.roomUnavailable(roomId);
    if (!this.isAdmittedDevice(roomId, id)) fail(403, 'Room admission is required.');
    this.touchStatus(roomId, this.now());
  }
  /** Returns the set of currently admitted device ids in `roomId`. */
  admittedDeviceIds(roomId: string): Set<string> {
    const rows = this.db.query('SELECT device_id FROM room_devices WHERE room_id = ? AND retired = 0').all(roomId) as { device_id: string }[];
    return new Set(rows.map(r => r.device_id));
  }
  /** Returns true when `deviceId` is an admitted device in `roomId` with `wakeable: true`. */
  isWakeableDevice(roomId: string, id: string): boolean {
    const row = this.db.query('SELECT wakeable FROM room_devices WHERE room_id = ? AND device_id = ? AND retired = 0').get(roomId, id) as { wakeable: number } | null;
    return !!row && row.wakeable === 1;
  }
  /** Persists `wakeable` on an admitted device in both `rooms.body` and `room_devices`. */
  setDeviceWakeable(roomId: string, id: string, wakeable: boolean): void {
    this.db.transaction(() => {
      const room = this.load(roomId);
      const device = room.devices.find(d => d.id === id);
      if (!device) fail(403, 'Room admission is required.');
      if (wakeable) device.wakeable = true;
      else delete device.wakeable;
      saveRoom(this.db, room, true);
    }).immediate();
  }
  /** Reads the latest persisted host-signed roster for `roomId`, or null if none has been published yet. */
  getRoomRoster(roomId: string): SignedRoster | null {
    return getRoomRoster<SignedRoster>(this.db, roomId);
  }
  private get idleMs() { return (this.options.idleDays ?? 30) * DAY; }
  private activityInterval() { return Math.min(ACTIVITY_WRITE_INTERVAL, this.idleMs / 4); }
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
  healthy() { this.db.query('SELECT 1 FROM rooms LIMIT 1').get(); return true; }
  /**
   * Grandfathers existing room hosts into beta_admissions via the indexed `room_devices` projection without scanning or
   * parsing `rooms.body`. Normal restarts where all hosts are already admitted perform zero writes.
   */
  private grandfatherHosts() {
    const pendingRooms = this.db.query(
      `SELECT DISTINCT rd.room_id
       FROM room_devices rd
       LEFT JOIN beta_admissions ba ON ba.device = rd.device_id
       LEFT JOIN beta_revocations br ON br.device = rd.device_id
       WHERE rd.is_host = 1 AND rd.is_human = 1 AND rd.retired = 0 AND ba.device IS NULL AND br.device IS NULL`
    ).all() as { room_id: string }[];
    if (!pendingRooms.length) return;
    this.db.transaction(() => {
      const hostStmt = this.db.query(
        // A host the operator revoked (invites.ts revoke-person) stays revoked across restarts.
        'SELECT device_id FROM room_devices WHERE room_id = ? AND is_host = 1 AND is_human = 1 AND retired = 0 AND device_id NOT IN (SELECT device FROM beta_revocations)'
      );
      for (const { room_id } of pendingRooms) {
        const hosts = (hostStmt.all(room_id) as { device_id: string }[]).map(row => row.device_id);
        if (!hosts.length) continue;
        const person = hosts.map(d => betaPerson(this.db, d)).find(Boolean) ?? hosts[0];
        if (person) this.admitCreator(hosts, person, true);
      }
    }).immediate();
  }
  /**
   * Devices linked before beta redemption belong to the same person too. Never follow agent operators or names.
   * Grandfathering (`grandfather`) skips devices the operator revoked; admitting after a new invite, or by a linker who
   * holds admission, clears their revocation.
   */
  private admitCreator(initial: string | string[], person?: string, grandfather = false) {
    const start = Array.isArray(initial) ? initial : [initial];
    if (!start.length) return;
    const owner = person ?? start[0];
    const seen = new Set<string>(start);
    const queue = [...start];
    const linkedStmt = this.db.query(
      `SELECT DISTINCT b.device_id
       FROM room_devices a
       JOIN room_devices b ON a.room_id = b.room_id AND a.member_id = b.member_id
       WHERE a.device_id = ? AND a.is_human = 1 AND a.retired = 0 AND b.retired = 0`
    );
    while (queue.length) {
      const current = queue.shift()!;
      for (const { device_id } of linkedStmt.all(current) as { device_id: string }[]) {
        if (!seen.has(device_id)) { seen.add(device_id); queue.push(device_id); }
      }
    }
    for (const id of seen) {
      if (grandfather && betaRevoked(this.db, id)) continue;
      this.db.query('DELETE FROM beta_revocations WHERE device=?').run(id);
      admitBetaDevice(this.db, id, owner, this.now());
    }
  }
  /**
   * Counts rooms hosted by an admitted person across all linked devices (including retired host keys and `owner_person`),
   * or by the single calling device when unlinked or invites are off. Uses indexed SQL rather than scanning room JSON.
   */
  private hostedCount(id: string, owner: string | undefined): number {
    const devices = owner ? [...new Set([...betaDevices(this.db, owner), id])] : [id];
    const placeholders = devices.map(() => '?').join(',');
    if (owner !== undefined) {
      return (this.db.query(
        `SELECT COUNT(*) AS n FROM (
          SELECT room_id AS id FROM room_devices WHERE is_host = 1 AND device_id IN (${placeholders})
          UNION
          SELECT id FROM rooms WHERE owner_person = ?
        )`
      ).get(...devices, owner) as { n: number }).n;
    }
    return (this.db.query(
      `SELECT COUNT(DISTINCT room_id) AS n FROM room_devices WHERE is_host = 1 AND device_id IN (${placeholders})`
    ).get(...devices) as { n: number }).n;
  }
  private roomUnavailable(id: string): never {
    const closed = this.db.query('SELECT reason FROM closed_rooms WHERE id=?').get(id) as { reason: ClosedReason } | null;
    if (closed) {
      if (this.liveRooms.has(id)) this.forget(id);
      fail(410, closed.reason === 'closed' ? 'This room was closed by its host.'
        : closed.reason === 'expired' ? 'This room was removed because nobody opened it for a long time.' : 'This room was removed by the service operator.', ROOM_CLOSED);
    }
    return fail(404, 'This room is unavailable. Check the invitation.');
  }
  private load(id: string): Room {
    const row = this.db.query('SELECT body FROM rooms WHERE id=?').get(id) as { body: string } | null;
    if (row) return JSON.parse(row.body);
    return this.roomUnavailable(id);
  }
  /**
   * An admitted device opened or used the room: it stays for another idle period. Called inside a write transaction;
   * written at most every hour, or a quarter of the idle period if that is shorter.
   */
  private touch(roomId: string) {
    const at = this.now(), last = this.pending.get(roomId) ?? this.active.get(roomId);
    if (last !== undefined && at - last < this.activityInterval()) return last;
    this.db.query('INSERT OR REPLACE INTO room_activity (id, at) VALUES (?,?)').run(roomId, at);
    this.pending.set(roomId, at);
    return at;
  }
  /**
   * Non-blocking activity check for read-only status polls: returns the cached activity timestamp with zero SQLite writes
   * (and zero `BEGIN IMMEDIATE` locks) while within the activity interval, and acquires a write transaction only when the
   * on-disk timestamp actually needs advancing.
   */
  private touchStatus(roomId: string, at: number): number {
    const interval = this.activityInterval();
    const cached = this.active.get(roomId);
    if (cached !== undefined && at - cached < interval) return cached;
    if (cached === undefined) {
      const row = this.db.query('SELECT at FROM room_activity WHERE id=?').get(roomId) as { at: number } | null;
      if (row && at - row.at < interval) {
        this.active.set(roomId, row.at);
        this.liveRooms.add(roomId);
        return row.at;
      }
    }
    const written = this.db.transaction(() => {
      if (!this.db.query('SELECT 1 FROM rooms WHERE id=?').get(roomId)) return undefined;
      this.db.query('INSERT OR REPLACE INTO room_activity (id, at) VALUES (?,?)').run(roomId, at);
      return at;
    }).immediate();
    if (written === undefined) return this.roomUnavailable(roomId);
    this.active.set(roomId, written);
    this.liveRooms.add(roomId);
    return written;
  }
  private forget(roomId: string) {
    this.liveRooms.delete(roomId);
    this.active.delete(roomId); this.pending.delete(roomId);
    const prefix = `${roomId}:`;
    for (const key of this.presence.keys()) if (key.startsWith(prefix)) this.presence.delete(key);
    for (const key of this.requestAddresses.keys()) if (key.startsWith(prefix)) this.requestAddresses.delete(key);
    for (const [key, queue] of this.signals) {
      if (!key.startsWith(prefix)) continue;
      for (const s of queue) this.signalChars -= s.description.sdp?.length ?? 0;
      this.signals.delete(key);
    }
    for (const listener of this.roomClosedListeners) {
      try { listener(roomId); } catch { /* listener errors must not break lobby cleanup */ }
    }
  }
  /** Removes presence and all queued signals addressed to or sent by `deviceIds` in `roomId`, keeping `signalChars` exact. */
  private dropDevices(roomId: string, deviceIds: Set<string>) {
    const prefix = `${roomId}:`;
    for (const deviceId of deviceIds) {
      const key = `${prefix}${deviceId}`;
      this.presence.delete(key);
      const queue = this.signals.get(key);
      if (queue) {
        for (const s of queue) this.signalChars -= s.description.sdp?.length ?? 0;
        this.signals.delete(key);
      }
    }
    for (const [key, queue] of this.signals) {
      if (!key.startsWith(prefix)) continue;
      let dropped = 0;
      const kept: (Signal & { at: number })[] = [];
      for (const s of queue) {
        if (deviceIds.has(s.from)) dropped += s.description.sdp?.length ?? 0;
        else kept.push(s);
      }
      if (dropped > 0 || kept.length !== queue.length) {
        this.signalChars -= dropped;
        if (kept.length) this.signals.set(key, kept); else this.signals.delete(key);
      }
    }
    for (const deviceId of deviceIds) {
      for (const listener of this.deviceRemovedListeners) {
        try { listener(roomId, deviceId); } catch { /* listener errors must not break lobby cleanup */ }
      }
    }
  }
  /** Retires idle rooms inside an active write transaction, deferring in-memory cleanup until commit. */
  private retireIdleRooms(): number {
    const cutoff = this.now() - this.idleMs;
    const idle = this.db.query('SELECT id FROM room_activity WHERE at < ?').all(cutoff) as { id: string }[];
    let removed = 0;
    for (const { id } of idle) if (retireRoom(this.db, id, 'expired', this.now())) { this.pendingForget.add(id); removed++; }
    return removed;
  }
  /** Removes rooms no admitted device opened within the idle period. Returns how many were removed. */
  sweep(): number {
    this.heartbeat();
    const cutoff = this.now() - this.idleMs;
    const idle = this.db.query('SELECT id FROM room_activity WHERE at < ?').all(cutoff) as { id: string }[];
    let removed = 0;
    for (const { id } of idle) if (retireRoom(this.db, id, 'expired', this.now())) { this.forget(id); removed++; }
    this.db.query('DELETE FROM room_activity WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE rooms.id = room_activity.id)').run();
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
  publicRoom(id: string) {
    const row = this.db.query('SELECT id, title, body FROM rooms WHERE id=?').get(id) as { id: string; title: string | null; body: string | null } | null;
    if (row) {
      const room = row.body ? JSON.parse(row.body) as Room : undefined;
      return {
        roomId: row.id,
        title: room?.title ?? row.title ?? '',
        historyForNewcomers: room ? settingsOf(room).historyForNewcomers : DEFAULT_ROOM_SETTINGS.historyForNewcomers,
      };
    }
    return this.roomUnavailable(id);
  }
  /** A member's current avatar, only when the hash matches, so an old link never shows a newer picture. */
  avatar(roomId: string, memberId: string, hash: string) {
    return this.db.query('SELECT type, bytes FROM avatars WHERE room=? AND member=? AND hash=?').get(roomId, memberId, hash) as { type: string; bytes: Uint8Array } | null;
  }
  /**
   * `address`: who sent the command, as the HTTP layer keys addresses (one IPv4 address, or an IPv6 /64), for the cap
   * on waiting requests per address. Commands without one (tests, local tools) aren't capped by address.
   */
  /**
   * `admit`, when given, runs once the request is valid and its device authenticated, right before the command, with no
   * await in between: a quota it takes (see http.ts) is taken by exactly the requests that run. It may throw a LobbyError.
   */
  /** Validates optional ECDH `enc` + `encVersion` + `encSig` fields before entering the synchronous write transaction. */
  private async parseEncFields(
    publicKey: string,
    id: string,
    roomId: string,
    payload: Record<string, unknown>,
  ): Promise<{ enc: string; encVersion: number; encSig: string } | undefined> {
    const { enc, encVersion, encSig } = payload;
    if (enc === undefined && encVersion === undefined && encSig === undefined) return undefined;
    if (typeof enc !== 'string' || enc.length !== 88 || typeof encVersion !== 'number' || !Number.isInteger(encVersion) || encVersion < 1 || typeof encSig !== 'string' || encSig.length !== 88) {
      fail(400, 'Invalid device encryption key metadata.');
    }
    try { await importEncPublicKey(enc); } catch { fail(400, 'Invalid device encryption public key.'); }
    const roomBound = await verifyEncBinding(publicKey, { room: roomId, deviceId: id, enc, encVersion }, encSig);
    if (!roomBound) {
      const profileBound = await verifyEncBinding(publicKey, { room: '*', deviceId: id, enc, encVersion }, encSig);
      if (!profileBound) fail(400, 'Invalid device encryption key signature.');
    }
    return { enc, encVersion, encSig };
  }
  async execute(input: SignedCommand, address?: string, admit?: () => void): Promise<RoomStatus | ({ roomId: string; token?: string } & CommandAnswer)> {
    const c = input?.command;
    if (!c || c.protocol !== browserProtocol || !this.origins.has(c.origin) || !uuid(c.id) || !uuid(c.roomId) || !Number.isSafeInteger(c.at) || Math.abs(this.now() - c.at) > 60_000 || !c.payload || typeof c.payload !== 'object' || Array.isArray(c.payload)) fail(400, 'This request has expired or is invalid. Try again.');
    // Remote control's id names no room, and no room may take it.
    if (c.roomId === CONTROL_ROOM_ID) fail(400, 'This request has expired or is invalid. Try again.');
    if (typeof input.publicKey !== 'string' || typeof input.signature !== 'string' || !await verify(input.publicKey, c, input.signature)) fail(401, 'This device could not be authenticated.');
    const id = await deviceId(input.publicKey);
    admit?.();
    // Read-only commands run outside any BEGIN IMMEDIATE write lock so routine status polls never block writers or each other.
    if (c.action === 'creation-status') return { roomId: c.roomId, admitted: !this.inviteRequired || !!betaPerson(this.db, id) };
    if (c.action === 'status') return this.snapshot(this.load(c.roomId), id, c.payload, c.origin);
    if (c.action === 'pair-offer' || c.action === 'pair-redeem' || c.action === 'pair-cancel') return this.pairOffer(c, id, address);
    // Async cryptographic validation of optional device `enc` keys or `roster-publish` runs before the synchronous IMMEDIATE transaction.
    let prevalidatedEnc: { enc: string; encVersion: number; encSig: string } | undefined;
    if (c.action === 'create' || c.action === 'request' || c.action === 'agent-redeem' || c.action === 'profile') {
      if (c.action === 'profile') {
        const room = this.load(c.roomId);
        if (!room.devices.some(d => d.id === id)) fail(403, 'Join this room first.');
      }
      // With the relay off these fields are ignored, as they were before the relay existed: no encryption key is stored or advertised.
      if (this.relayEnabled) prevalidatedEnc = await this.parseEncFields(input.publicKey, id, c.roomId, c.payload);
    }
    let prevalidatedRoster: { roster: SignedRoster; expectedPrevVersion: number } | undefined;
    if (c.action === 'roster-publish') {
      if (!this.relayEnabled) fail(404, 'The relay is not enabled on this server.');
      // Ensure room exists (404/410) and caller is admitted (403) BEFORE running verifyRoster crypto.
      const room = this.load(c.roomId);
      if (!room.devices.some(d => d.id === id)) fail(403, 'Room admission is required.');
      const existing = getRoomRoster<SignedRoster>(this.db, c.roomId);
      const verdict = await verifyRoster(c.payload.roster, { roomId: c.roomId, previous: existing ?? undefined });
      if (!verdict.ok) fail(400, `Invalid roster: ${verdict.reason}`);
      prevalidatedRoster = { roster: c.payload.roster as SignedRoster, expectedPrevVersion: existing?.body.version ?? 0 };
    }
    // After verification, all mutating read/modify/write work is synchronous in one IMMEDIATE transaction so an operator
    // command writing the same file in between can't invalidate what this one read.
    try {
      const result = this.run(c, id, input, address, prevalidatedEnc, prevalidatedRoster);
      for (const [room, at] of this.pending) { this.active.set(room, at); this.liveRooms.add(room); }
      for (const room of this.pendingForget) this.forget(room);
      for (const { roomId, deviceIds } of this.pendingDropDevices) this.dropDevices(roomId, deviceIds);
      if (this.pendingReceiptPrune !== undefined) this.lastReceiptPrune = this.pendingReceiptPrune;
      // A signal is news for its recipient only; anything else may be news for everyone in the room.
      if (c.action === 'signal') this.changed(c.roomId, typeof c.payload.to === 'string' ? c.payload.to : undefined);
      else this.changed(c.roomId);
      return result;
    } finally {
      this.pending.clear();
      this.pendingForget.clear();
      this.pendingDropDevices = [];
      this.pendingReceiptPrune = undefined;
    }
  }
  private run(
    c: SignedCommand['command'],
    id: string,
    input: SignedCommand,
    address?: string,
    prevalidatedEnc?: { enc: string; encVersion: number; encSig: string },
    prevalidatedRoster?: { roster: SignedRoster; expectedPrevVersion: number },
  ): RoomStatus | ({ roomId: string; token?: string } & CommandAnswer) {
    return this.db.transaction(() => {
      const serialized = fingerprint(c);
      /** What an action adds to its answer (and to its receipt, so a retry gets the same). */
      const answer: CommandAnswer = {};
      const previous = this.db.query('SELECT body,result FROM receipts WHERE device=? AND id=?').get(id, c.id) as { body: string; result: string } | null;
      if (previous) {
        if (previous.body !== serialized) fail(409, 'That request ID was already used.');
        return JSON.parse(previous.result);
      }
      if (c.action === 'create') {
        const maxRooms = this.options.maxRooms ?? 256;
        let count = (this.db.query('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n;
        if (count >= maxRooms) {
          if (this.retireIdleRooms() > 0) count = (this.db.query('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n;
          if (count >= maxRooms) fail(429, 'The room service is full right now. Try again later.');
        }
        // Bound hosted rooms per admitted person across all their linked devices (and retired host keys), falling
        // back to the caller's device when unlinked or when invites are off, so companion churn cannot pass eight.
        const person = betaPerson(this.db, id);
        if (this.hostedCount(id, person) >= 8) fail(429, person ? 'You already host eight rooms.' : 'This device already hosts eight rooms.');
        const existing = this.db.query('SELECT id FROM rooms WHERE id=? UNION SELECT id FROM closed_rooms WHERE id=?').get(c.roomId, c.roomId);
        if (existing) fail(409, 'This room already exists.');
        const memberId = crypto.randomUUID();
        const createdAt = this.now();
        const room: Room = { id: c.roomId, title: label(c.payload.title), ownerId: memberId,
          members: [{ id: memberId, name: memberName(c.payload.name), joinedAt: createdAt }],
          devices: [{ id, publicKey: input.publicKey, label: label(c.payload.label), memberId, admittedAt: createdAt, ...prevalidatedEnc }], requests: [],
          settings: { guestAgentApproval: DEFAULT_ROOM_SETTINGS.guestAgentApproval, floor: NEW_ROOM_FLOOR } };
        // Last, so nothing above can fail after a use was taken; the transaction rolls it back if anything below does.
        let ownerPerson = person;
        if (this.inviteRequired && !ownerPerson) {
          const problem = consumeInvite(this.db, c.payload.invite, this.now());
          if (problem) fail(problem === 'invite-required' || problem === 'invite-invalid' ? 403 : 410, inviteMessages[problem], problem);
          this.admitCreator(id);
          ownerPerson = betaPerson(this.db, id);
          if (this.hostedCount(id, ownerPerson) >= 8) fail(429, 'You already host eight rooms.');
        }
        if (ownerPerson) room.ownerPerson = ownerPerson;
        saveRoom(this.db, room, true);
        this.touch(room.id);
      } else {
        const room = this.load(c.roomId);
        const actor = room.devices.find(d => d.id === id);
        const isHost = actor?.memberId === room.ownerId;
        if (actor) this.touch(room.id);
        let devicesChanged = false;
        const activeInvites = () => (room.invites || []).filter(i => i.expiresAt > this.now());
        const pending = (requestId: unknown) => room.requests.find(r => r.id === requestId && r.state === 'pending' && r.expiresAt > this.now()) || fail(409, 'This request is no longer waiting.');
        const admit = (r: JoinRequest) => {
          if (room.devices.length >= 16) fail(429, 'This room has reached its device limit.');
          if (r.kind === 'companion' && !r.linkedMemberId) fail(409, 'Confirm this device from its existing identity first.');
          if (r.linkedMemberId) {
            // A device only ever joins a member who is still here, and each member holds at most DEVICES_PER_MEMBER.
            if (!room.devices.some(d => d.memberId === r.linkedMemberId)) fail(409, 'The person this device belongs to is no longer in the room.');
            if (room.devices.filter(d => d.memberId === r.linkedMemberId).length >= DEVICES_PER_MEMBER) fail(429, `Each person can have up to ${DEVICES_PER_MEMBER} devices in this room. Remove one first.`);
          }
          if (r.kind === 'agent' && (!r.operatorId || !isPerson(room, r.operatorId))) fail(409, 'This agent’s operator is no longer in the room.');
          if (!r.linkedMemberId) nameAvailable(room, r.name, activeInvites());
          const memberId = r.linkedMemberId || crypto.randomUUID();
          const admittedAt = this.now();
          if (!r.linkedMemberId) room.members.push(r.kind === 'agent' ? { id: memberId, name: r.name, role: 'agent', operatorId: r.operatorId, joinedAt: admittedAt } : { id: memberId, name: r.name, role: 'human', joinedAt: admittedAt });
          // Preserve a voluntarily departed person device's prior memberId (never a revoked one) so earlier signed messages stay verifiable after rejoining.
          const retired = r.kind === 'person' && !r.linkedMemberId ? getRetiredDevice(this.db, room.id, r.device.id) : undefined;
          const priorMembers = retired && !retired.revoked && retired.memberId !== memberId
            ? [...(r.device.priorMembers ?? []).filter(p => p.memberId !== retired.memberId), { memberId: retired.memberId, ...(retired.retiredAt !== undefined ? { retiredAt: retired.retiredAt } : {}) }].slice(-8)
            : undefined;
          room.devices.push({ ...r.device, memberId, admittedAt, ...(priorMembers?.length ? { priorMembers } : {}) });
          // COL-4: Clear any stale retired_devices record for a re-admitted device so active & former records never conflict.
          deleteRetiredDevice(this.db, room.id, r.device.id);
          devicesChanged = true;
          if (r.kind === 'companion' && r.linkedMemberId && isPerson(room, memberId)) {
            const person = room.devices.filter(d => d.memberId === memberId && d.id !== r.device.id).map(d => betaPerson(this.db, d.id)).find(Boolean);
            if (person) this.admitCreator(r.device.id, person);
          }
          r.state = 'admitted'; delete r.code; delete r.pairing;
        };
        switch (c.action) {
          case 'request': {
            if (actor) break;
            const now = this.now();
            if (room.blocked?.length) {
              room.blocked = room.blocked.filter(b => b.until === null || b.until > now);
              const blocked = room.blocked.find(b => b.deviceId === id);
              if (blocked) {
                if (blocked.until === null) fail(403, 'This device was blocked from joining this room.');
                fail(429, 'Your join request was declined. Wait a few minutes before asking again.');
              }
              if (!room.blocked.length) delete room.blocked;
            }
            // A companion asks either for a code its person enters elsewhere, or (`pairing`, see src/browser/pairing.ts) to
            // be linked by the browser holding the secret its proof was made with: never both, so neither check can stand in
            // for the other. The proof is bound to this device's key, this room and the browser device that may link it.
            const pairing = c.payload.pairing;
            if (pairing !== undefined && (c.payload.kind !== 'companion' || typeof pairing !== 'string' || !PAIRING_PROOF.test(pairing))) fail(400, 'Only a companion request carries a pairing, as 64 lowercase hex characters.');
            const current = room.requests.find(r => r.device.id === id && r.state === 'pending' && r.expiresAt > now);
            // A request still waiting is kept, unless this device now pairs with a browser (another one, or for the first
            // time): then it asks anew under the new proof. One a person already linked waits for the host as it is.
            if (current && (pairing === undefined || current.pairing === pairing || current.linkedMemberId)) break;
            room.requests = room.requests.filter(r => r.device.id !== id && r.state === 'pending' && r.expiresAt > now);
            if (!['person', 'companion'].includes(String(c.payload.kind))) fail(400, 'Choose how to join.');
            const kind = c.payload.kind as JoinRequest['kind'];
            const name = memberName(c.payload.name);
            if (kind === 'person') nameAvailable(room, name, activeInvites());
            // Each kind waits in its own share of the waiting room, so a flood of one (throwaway keys asking as companions,
            // say) never keeps a person, or an agent, from asking. They expire after ten minutes; the host can decline them.
            if (room.requests.filter(r => r.kind === kind).length >= WAITING_PER_KIND) fail(429, 'The waiting room is full. Please try again later, or ask the host to clear it.');
            // And one address fills at most WAITING_PER_ADDRESS places, however many keys it makes.
            for (const key of this.requestAddresses.keys()) if (key.startsWith(`${room.id}:`) && !room.requests.some(r => `${room.id}:${r.id}` === key)) this.requestAddresses.delete(key);
            if (address !== undefined) {
              if (room.requests.filter(r => this.requestAddresses.get(`${room.id}:${r.id}`) === address).length >= WAITING_PER_ADDRESS) fail(429, 'Too many requests from your network are waiting in this room. Try again later.');
              this.requestAddresses.set(`${room.id}:${c.id}`, address);
              this.liveRooms.add(room.id);
            }
            room.requests.push({ id: c.id, name, kind, state: 'pending', expiresAt: now + 600_000,
              device: { id, publicKey: input.publicKey, label: label(c.payload.label), memberId: '', admittedAt: 0, ...prevalidatedEnc },
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
            const { code, pairing, preview, revoke } = c.payload;
            if (code !== undefined && pairing !== undefined) fail(400, 'Link with a device code or a pairing secret, not both.');
            // `preview` shows the request that answers the secret without linking it; `revoke` drops the unused ones. Both
            // need the secret (a device code is shown to the person on the device that asks, nothing to preview there).
            if ((preview !== undefined && preview !== true) || (revoke !== undefined && revoke !== true) || (preview && revoke) || ((preview || revoke) && pairing === undefined)) fail(400, 'Preview or revoke a pairing secret, one at a time.');
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
              if (revoke) {
                // Closing a pairing early: whoever holds N may withdraw the requests that answer it, in this room. Nothing to
                // find is not a failure (N is 256 bits; a revoke guesses nothing), so a retry or a second tab is harmless.
                if (matches.length) { const gone = new Set(matches.map(m => m.id)); room.requests = room.requests.filter(r => !gone.has(r.id)); }
                answer.revoked = matches.length;
                break;
              }
              if (!matches.length) miss('The desktop app has not asked to join this room yet, or the pairing expired.', PAIRING_NOT_FOUND);
              // Two requests can't hold proofs from one secret unless something is wrong: link neither.
              if (matches.length > 1) fail(409, 'More than one device answers this pairing, so none was linked. Pair again.');
              r = matches[0];
              if (preview) {
                answer.preview = { requestId: r.id, label: r.device.label, publicKey: r.device.publicKey, deviceId: r.device.id, expiresAt: r.expiresAt };
                break;
              }
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
            // keeps the say over a device it removed (its key stays in `retired_devices`), and over every device with hostApprovesDevices.
            const removedBefore = !!getRetiredDevice(this.db, room.id, r.device.id);
            if (isHost || (!settingsOf(room).hostApprovesDevices && !removedBefore && isPerson(room, actor.memberId) && r.kind === 'companion' && r.linkedMemberId === actor.memberId)) admit(r);
            // Whether the device is in now, or waits for the host: the browser that paired says which.
            answer.admitted = r.state === 'admitted';
            break;
          }
          case 'agent-invite': {
            if (!actor || !isPerson(room, actor.memberId)) fail(403, 'Only people in this room can connect agents.');
            const invites = activeInvites();
            const name = memberName(c.payload.name, 64);
            nameAvailable(room, name, invites);
            if (invites.filter(i => i.operatorId === actor.memberId).length >= INVITES_PER_PERSON) fail(429, 'You already have four unused agent links. Use one or wait for them to expire.');
            if (room.members.filter(m => m.role === 'agent' && m.operatorId === actor.memberId).length >= this.agentsPerOperator) fail(429, `You already have ${this.agentsPerOperator} agents in this room.`);
            const token = randomBytes(32).toString('base64url');
            room.invites = [...invites, { tokenHash: tokenHash(token), operatorId: actor.memberId, name, expiresAt: this.now() + INVITE_TTL }];
            saveRoom(this.db, room, false);
            // Deliberately no receipt: the token is returned once and never retained. A retry creates a new link.
            return { roomId: room.id, token };
          }
          case 'agent-redeem': {
            if (actor) fail(409, 'This device is already in the room.');
            if (room.blocked?.some(b => b.deviceId === id && b.until === null)) fail(403, 'This device was blocked from joining this room.');
            const token = c.payload.token;
            const invites = activeInvites();
            const invite = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? invites.find(i => i.tokenHash === tokenHash(token)) : undefined;
            if (!invite || !isPerson(room, invite.operatorId)) fail(410, 'This agent link was already used or has expired. Ask for a new one.');
            const remainingInvites = invites.filter(i => i !== invite);
            nameAvailable(room, invite.name, remainingInvites);
            // Checked again here: links made before the operator's earlier agents joined must not exceed the limit.
            const operated = room.members.filter(m => m.role === 'agent' && m.operatorId === invite.operatorId).length
              + room.requests.filter(r => r.kind === 'agent' && r.state === 'pending' && r.expiresAt > this.now() && r.operatorId === invite.operatorId).length;
            if (operated >= this.agentsPerOperator) fail(429, `The person who made this link already has ${this.agentsPerOperator} agents in this room.`);
            if (room.devices.length >= 16) fail(429, 'This room has reached its device limit.');
            room.invites = remainingInvites;
            room.requests = room.requests.filter(r => r.device.id !== id);
            const device = { id, publicKey: input.publicKey, label: label(c.payload.label), memberId: '', admittedAt: 0, ...prevalidatedEnc };
            if (settingsOf(room).guestAgentApproval && invite.operatorId !== room.ownerId) {
              // The link was used, but the host decides whether a guest's agent enters.
              if (room.requests.filter(r => r.kind === 'agent' && r.state === 'pending' && r.expiresAt > this.now()).length >= WAITING_PER_KIND) fail(429, 'The waiting room is full. Please try again later.');
              room.requests.push({ id: c.id, name: invite.name, kind: 'agent', state: 'pending', expiresAt: this.now() + 600_000, device, operatorId: invite.operatorId });
              break;
            }
            const memberId = crypto.randomUUID();
            const admittedAt = this.now();
            room.members.push({ id: memberId, name: invite.name, role: 'agent', operatorId: invite.operatorId, joinedAt: admittedAt });
            room.devices.push({ ...device, memberId, admittedAt });
            deleteRetiredDevice(this.db, room.id, id);
            devicesChanged = true;
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
            const { admit: admitFlag, decision, block } = c.payload;
            if (admitFlag !== undefined && decision !== undefined) fail(400, 'Choose admit or decline.');
            if (block !== undefined && typeof block !== 'boolean') fail(400, 'Choose whether to block this device.');
            const isAdmit = admitFlag === true || (admitFlag === undefined && decision === 'admit');
            const isDecline = admitFlag === false || (admitFlag === undefined && decision === 'decline');
            if (isAdmit) {
              if (block) fail(400, 'Choose admit or decline.');
              admit(r);
            } else if (isDecline) {
              r.state = 'declined'; delete r.code; delete r.pairing;
              const now = this.now();
              const active = (room.blocked || []).filter(b => b.deviceId !== r.device.id && (b.until === null || b.until > now));
              active.push({ deviceId: r.device.id, until: block ? null : now + DECLINE_COOLDOWN_MS });
              if (active.length > MAX_BLOCKED_DEVICES) {
                const permanent = active.filter(b => b.until === null).slice(-MAX_BLOCKED_DEVICES);
                const temp = active.filter(b => b.until !== null).slice(-(MAX_BLOCKED_DEVICES - permanent.length));
                room.blocked = [...permanent, ...temp];
              } else {
                room.blocked = active;
              }
            } else {
              fail(400, 'Choose admit or decline.');
            }
            break;
          }
          case 'remove': {
            const hasDevice = c.payload.deviceId !== undefined;
            const hasMember = c.payload.memberId !== undefined;
            if (hasDevice === hasMember) fail(400, 'Choose a device or member to remove.');
            if (hasMember) {
              if (!actor) fail(403, 'You cannot remove this member.');
              const targetMemberId = c.payload.memberId;
              if (!uuid(targetMemberId)) fail(400, 'Choose a valid member to remove.');
              const member = room.members.find(m => m.id === targetMemberId);
              const targetDevices = member ? room.devices.filter(d => d.memberId === member.id) : [];
              if (!member || !targetDevices.length) fail(404, 'Member not found.');
              const isSelf = actor.memberId === member.id;
              const operates = member.role === 'agent' && member.operatorId === actor.memberId;
              if (!isHost && !isSelf && !operates) fail(403, 'You cannot remove this member.');
              if (member.id === room.ownerId) fail(409, 'Transfer host to another member or delete the room before leaving.');
              const roles = new Map(room.members.map(m => [m.id, m.role ?? 'human'] as const));
              const removed: BrowserDevice[] = [...targetDevices];
              room.devices = room.devices.filter(d => d.memberId !== member.id);
              const present = (memberId: string) => room.devices.some(d => d.memberId === memberId);
              for (const agent of room.members.filter(m => m.role === 'agent' && m.operatorId && !present(m.operatorId))) {
                removed.push(...room.devices.filter(d => d.memberId === agent.id));
                room.devices = room.devices.filter(d => d.memberId !== agent.id);
              }
              for (const gone of room.members.filter(m => !present(m.id))) this.db.query('DELETE FROM avatars WHERE room=? AND member=?').run(room.id, gone.id);
              room.members = room.members.filter(m => present(m.id));
              room.requests = room.requests.filter(r => !removed.some(d => d.id === r.device.id) && !(r.kind === 'agent' && r.operatorId && !present(r.operatorId)));
              if (room.invites) room.invites = room.invites.filter(i => present(i.operatorId));
              this.pendingDropDevices.push({ roomId: room.id, deviceIds: new Set(removed.map(d => d.id)) });
              const retiredAt = this.now();
              for (const d of removed) {
                const role = roles.get(d.memberId);
                const revoked = d.id !== actor.id;
                upsertRetiredDevice(this.db, room.id, {
                  id: d.id, publicKey: d.publicKey, memberId: d.memberId,
                  ...(role ? { role } : {}), retiredAt, ...(revoked ? { revoked: true as const } : {}),
                });
              }
              devicesChanged = true;
              break;
            }
            const targetDeviceId = typeof c.payload.deviceId === 'string' ? c.payload.deviceId : '';
            const departed = targetDeviceId && !room.devices.some(d => d.id === targetDeviceId) ? getRetiredDevice(this.db, room.id, targetDeviceId) : undefined;
            if (departed) {
              // A device that left from itself can be revoked afterwards: a stolen laptop could leave on its own before
              // its owner removes it, and would otherwise stay trusted for whatever it backdates (see signerOf).
              const operator = !!actor && room.members.some(m => m.role === 'agent' && m.id === departed.memberId && m.operatorId === actor.memberId);
              if (!actor || (!isHost && actor.memberId !== departed.memberId && !operator)) fail(403, 'You cannot remove this device.');
              revokeRetiredDevice(this.db, room.id, departed.id);
              break;
            }
            const target = room.devices.find(d => d.id === targetDeviceId) || fail(404, 'Device not found.');
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
            this.pendingDropDevices.push({ roomId: room.id, deviceIds: new Set(removed.map(d => d.id)) });
            // A device removed from another one is revoked: peers accept nothing more it signs, even relayed by a member
            // (see signerOf). Its member's agents that leave with it follow it. A device leaving from itself is trusted
            // up to now. Either way its earlier records still verify for those who hold them.
            const retiredAt = this.now(), revoked = actor.id !== target.id;
            for (const d of removed) {
              const role = roles.get(d.memberId);
              upsertRetiredDevice(this.db, room.id, {
                id: d.id, publicKey: d.publicKey, memberId: d.memberId,
                ...(role ? { role } : {}), retiredAt, ...(revoked ? { revoked: true as const } : {}),
              });
            }
            devicesChanged = true;
            break;
          }
          case 'profile': {
            if (!actor) fail(403, 'Join this room first.');
            const target = c.payload.memberId === undefined ? actor.memberId : c.payload.memberId;
            const member = room.members.find(m => m.id === target) || fail(404, 'That person is not in this room.');
            const own = member.id === actor.memberId, operated = member.role === 'agent' && member.operatorId === actor.memberId;
            const { avatar: encoded } = c.payload;
            const runtimeFields = AGENT_RUNTIME_FIELDS.filter(field => c.payload[field] !== undefined);
            if (encoded === undefined && !runtimeFields.length && !prevalidatedEnc) fail(400, 'Choose what to change.');
            if (prevalidatedEnc) {
              if (!own) fail(403, 'A device can only update its own encryption key.');
              if (actor.encVersion !== undefined && prevalidatedEnc.encVersion < actor.encVersion) {
                fail(409, 'Encryption key version cannot move backwards.');
              }
              actor.enc = prevalidatedEnc.enc;
              actor.encVersion = prevalidatedEnc.encVersion;
              actor.encSig = prevalidatedEnc.encSig;
              devicesChanged = true;
            }
            if (runtimeFields.length) {
              if (member.role !== 'agent') fail(400, 'Only agents report runtime settings.');
              const clearing = runtimeFields.every(field => c.payload[field] === null);
              if (!own && !operated && !(clearing && isHost)) fail(403, 'Only the agent or its operator can change this.');
              for (const field of runtimeFields) {
                const value = c.payload[field];
                if (value === null) { delete member[field]; continue; }
                member[field] = cleanAgentRuntimeLabel(value) ?? fail(400, agentRuntimeLabelError(field));
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
          case 'rename': {
            // An agent's name is what people @mention, so it changes by the same rules as when it joined, and only at the
            // hand of the host or the person who operates it. People keep the name they joined with.
            if (!actor) fail(403, 'Join this room first.');
            const member = activeMembers(room).find(m => m.id === c.payload.memberId) || fail(404, 'That agent is not in this room.');
            if (member.role !== 'agent') fail(400, 'Only agents can be renamed.');
            if (!isHost && member.operatorId !== actor.memberId) fail(403, 'Only the host or the agent’s operator can rename it.');
            const name = memberName(c.payload.name, 64);
            if (name === member.name) fail(400, 'That is already its name.');
            nameAvailable(room, name, activeInvites(), member.id);
            const notice: RenameNotice = { id: crypto.randomUUID(), at: this.now(), memberId: member.id, by: actor.memberId, from: member.name, to: name };
            member.name = name;
            room.renames = [...(room.renames || []).filter(r => room.members.some(m => m.id === r.memberId)), notice].slice(-MAX_RENAME_NOTICES);
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
          case 'claim': {
            // A person's message that went to every agent is answered by the first agent to claim it (src/collab.ts,
            // `needsClaim`). The service never sees messages: it keeps only which agent holds which message id, until
            // when. Its holder can claim again to keep it, mark it answered, or release it for another agent.
            if (!actor || room.members.find(m => m.id === actor.memberId)?.role !== 'agent') fail(403, 'Only agents in this room claim messages.');
            const { messageId, answered, release } = c.payload;
            if (!uuid(messageId) || (answered !== undefined && answered !== true) || (release !== undefined && release !== true) || (answered && release)) fail(400, 'Claim one message by its id.');
            const now = this.now();
            const claims = liveClaims(room, now);
            const held = claims.find(k => k.messageId === messageId);
            if (held && held.memberId !== actor.memberId) answer.claim = held;
            else if (answered && !held) fail(409, 'Claim the message before marking it answered.');
            else if (release) { answer.claim = held?.answered ? held : null; if (!held?.answered) room.claims = claims.filter(k => k !== held); }
            else {
              const next: Claim = { messageId, memberId: actor.memberId, at: held?.at ?? now, until: now + CLAIM_TTL_MS, ...(answered || held?.answered ? { answered: true as const } : {}) };
              if (!next.answered && !held && claims.filter(k => k.memberId === actor.memberId && !k.answered).length >= MAX_LIVE_CLAIMS) {
                fail(429, `An agent holds up to ${MAX_LIVE_CLAIMS} unanswered messages at once. Answer or release one first.`);
              }
              const rest = claims.filter(k => k !== held);
              // Over the cap, answered claims go first, oldest first, then the oldest live ones.
              while (rest.length >= MAX_CLAIMS) { const i = rest.findIndex(k => k.answered); rest.splice(i >= 0 ? i : 0, 1); }
              room.claims = [...rest, next];
              answer.claim = next;
            }
            if (!room.claims?.length) delete room.claims;
            break;
          }
          case 'settings': {
            if (!isHost) fail(403, 'Only the host can change room settings.');
            const next: Partial<RoomSettings> = { ...room.settings };
            if (c.payload.floor !== undefined) { if (!FLOORS.includes(c.payload.floor as Floor)) fail(400, 'Choose who wakes agents.'); next.floor = c.payload.floor as RoomSettings['floor']; }
            for (const key of ['agentAssignmentsWake', 'guestAgentApproval', 'hostApprovesDevices', 'historyForNewcomers'] as const) {
              if (c.payload[key] === undefined) continue;
              if (typeof c.payload[key] !== 'boolean') fail(400, 'Choose on or off.');
              next[key] = c.payload[key] as boolean;
            }
            if (next.historyForNewcomers) room.historyEverEnabled = true;
            room.settings = next;
            break;
          }
          case 'signal': {
            if (!actor) fail(403, 'Room admission is required.');
            const target = room.devices.find(d => d.id === c.payload.to) || fail(403, 'The recipient is not admitted.');
            const local = this.presence.get(`${room.id}:${id}`), remote = this.presence.get(`${room.id}:${target.id}`);
            const now = this.now();
            if (!local || local.session !== c.payload.session || !remote || remote.session !== c.payload.targetSession || remote.at < now - PRESENCE_MS) fail(409, 'The connection changed. Reconnecting.');
            const description = c.payload.description as RTCSessionDescriptionInit;
            if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 16_000) fail(400, 'Invalid connection offer.');
            // Proactively prune expired 30 s signals before enforcing per-device, per-sender or global limits so
            // expired entries never block valid reconnects.
            this.pruneSignals(now);
            const key = `${room.id}:${target.id}`;
            const existing = this.signals.get(key) || [];
            const queue: (Signal & { at: number })[] = [];
            for (const s of existing) {
              if (s.targetSession !== remote.session) this.signalChars -= s.description.sdp?.length ?? 0;
              else queue.push(s);
            }
            if (queue.length !== existing.length) {
              if (queue.length) this.signals.set(key, queue); else this.signals.delete(key);
            }
            // Supersede any earlier unpolled offer or answer from the same sender to the same recipient in this room,
            // preventing stale offers from piling up and causing glare.
            const replaceIdx = (description.type === 'offer' || description.type === 'answer')
              ? queue.findIndex(s => s.from === id && s.description.type === description.type)
              : -1;
            const replacedChars = replaceIdx >= 0 ? (queue[replaceIdx].description.sdp?.length ?? 0) : 0;
            if (replaceIdx < 0) {
              if (queue.length >= MAX_SIGNALS_PER_DEVICE) fail(429, 'Connection busy. Try again.');
              let fromSender = 0;
              for (const s of queue) if (s.from === id) fromSender++;
              if (fromSender >= MAX_SIGNALS_PER_SENDER) fail(429, 'Connection busy. Try again.');
            }
            if (this.signalChars - replacedChars + description.sdp.length > this.maxSignalChars) {
              fail(429, 'The room service is busy. Try again.');
            }
            if (replaceIdx >= 0) {
              queue.splice(replaceIdx, 1);
              this.signalChars -= replacedChars;
            }
            this.signalChars += description.sdp.length;
            queue.push({ seq: ++this.sequence, from: id, session: local.session, targetSession: remote.session, description: { type: description.type, sdp: description.sdp }, at: now });
            this.signals.set(key, queue);
            break;
          }
          case 'transfer-host': {
            if (!isHost) fail(403, 'Only the host can transfer hosting.');
            const targetId = c.payload.memberId;
            if (!uuid(targetId)) fail(400, 'Choose a person in this room to make host.');
            if (targetId === room.ownerId) fail(409, 'That person is already the host.');
            const target = room.members.find(m => m.id === targetId);
            if (!target || !room.devices.some(d => d.memberId === targetId)) fail(404, 'That person is not in this room.');
            if ((target.role ?? 'human') !== 'human') fail(400, 'Only a person can host a room, not an agent.');
            room.ownerId = target.id;
            const newOwnerPerson = room.devices.filter(d => d.memberId === target.id).map(d => betaPerson(this.db, d.id)).find(Boolean);
            if (newOwnerPerson) room.ownerPerson = newOwnerPerson; else delete room.ownerPerson;
            devicesChanged = true;
            break;
          }
          case 'roster-publish': {
            if (!actor) fail(403, 'Room admission is required.');
            if (!prevalidatedRoster) fail(400, 'Invalid roster.');
            const { roster, expectedPrevVersion } = prevalidatedRoster;
            const current = getRoomRoster<SignedRoster>(this.db, room.id);
            if ((current?.body.version ?? 0) !== expectedPrevVersion) {
              fail(409, 'A newer roster was already published. Refresh and try again.');
            }
            // Genesis roster (v1) must be published by the host and name an active host device.
            // Subsequent versions are already cryptographically chained to the host via verifyRoster.
            const hostDevice = room.devices.find(d => d.id === roster.body.host);
            if (!hostDevice) fail(400, 'Roster host must be an admitted device in this room.');
            if (!current) {
              if (!isHost || hostDevice.memberId !== room.ownerId) {
                fail(403, 'Only the host can publish the initial room roster.');
              }
            }
            saveRoomRoster(this.db, room.id, roster.body.version, roster, this.now());
            break;
          }
          case 'close': {
            // The room, its admission records and pictures are deleted; members' browsers keep their own copies.
            if (!isHost) fail(403, 'Only the host can delete this room.');
            retireRoom(this.db, room.id, 'closed', this.now());
            this.pendingForget.add(room.id);
            break;
          }
          default: fail(400, 'Unknown room action.');
        }
        if (c.action !== 'signal' && c.action !== 'close' && c.action !== 'roster-publish') saveRoom(this.db, room, devicesChanged);
      }
      const now = this.now();
      const result = { roomId: c.roomId, ...answer };
      if (now - this.lastReceiptPrune >= RECEIPT_PRUNE_INTERVAL || now < this.lastReceiptPrune) {
        this.db.query('DELETE FROM receipts WHERE at < ?').run(now - 120_000);
        this.pendingReceiptPrune = now;
      }
      this.db.query('INSERT INTO receipts VALUES (?,?,?,?,?)').run(id, c.id, serialized, JSON.stringify(result), now);
      return result;
    }).immediate();
  }
  /** Offers the service holds for pairing a person's new device, by sha256 of the lookup the devices derive from the typed code. Memory only: they live five minutes, so a restart costs a person one new code. */
  private offers = new Map<string, Offer>();
  private offerFailures = new Map<string, { count: number; since: number }>();
  /**
   * `pair-offer` (a person's device files an offer naming up to eight of its rooms), `pair-redeem` (any device that knows
   * the code reads it once) and `pair-cancel` (the filer withdraws it). The service never sees the code, or the pairing
   * secret made from it: it holds only sha256 of a lookup derived from the code (src/browser/pairing.ts, `offerLookup`).
   * Rooms are named only to devices that are people there; a redeem answers 404 alike for a wrong, used, cancelled or expired code.
   */
  private pairOffer(c: SignedCommand['command'], id: string, address?: string): { roomId: string } & CommandAnswer {
    const now = this.now();
    for (const [key, offer] of this.offers) if (offer.expiresAt <= now) this.offers.delete(key);
    for (const [key, value] of this.offerFailures) if (now - value.since > LINK_FAILURE_WINDOW) this.offerFailures.delete(key);
    const lookup = c.payload.lookup;
    if (typeof lookup !== 'string' || !OFFER_LOOKUP.test(lookup)) fail(400, 'This pairing code is not valid.');
    const key = createHash('sha256').update(lookup).digest('hex');
    if (c.action === 'pair-cancel') {
      const offer = this.offers.get(key);
      const cancelled = !!offer && offer.device === id && this.offers.delete(key);
      return { roomId: c.roomId, cancelled };
    }
    if (c.action === 'pair-redeem') {
      const budgets = [`d:${id}`, ...(address !== undefined ? [`a:${address}`] : [])];
      if (budgets.some(b => (this.offerFailures.get(b)?.count ?? 0) >= OFFER_FAILURES)) fail(429, 'Too many wrong pairing codes. Wait a few minutes, then try again.');
      const offer = this.offers.get(key);
      if (!offer || (offer.redeemedBy !== undefined && offer.redeemedBy !== id)) {
        for (const b of budgets) { const current = this.offerFailures.get(b); this.offerFailures.set(b, { count: (current?.count ?? 0) + 1, since: current?.since ?? now }); }
        fail(404, 'This pairing code was not found. It may have been mistyped, used or expired.', PAIR_OFFER_NOT_FOUND);
      }
      // One use, but the device that read it may read it again (a retry after a lost answer): nobody else can.
      offer.redeemedBy = id;
      const { name, device, rooms, expiresAt } = offer;
      const answer: PairingOffer = { name, device, rooms: [...rooms], expiresAt };
      return { roomId: c.roomId, offer: answer };
    }
    const rooms = c.payload.rooms;
    if (!Array.isArray(rooms) || !rooms.length || rooms.length > OFFER_MAX_ROOMS || !rooms.every(uuid) || new Set(rooms).size !== rooms.length) fail(400, `Name between one and ${OFFER_MAX_ROOMS} rooms.`);
    let name = '';
    for (const roomId of rooms as string[]) {
      const room = this.load(roomId), actor = room.devices.find(d => d.id === id);
      if (!actor || !isPerson(room, actor.memberId)) fail(403, 'Only people can pair a new device, and only to rooms they are in.');
      if (roomId === c.roomId || !name) name = room.members.find(m => m.id === actor.memberId)?.name ?? '';
    }
    if (!(rooms as string[]).includes(c.roomId)) fail(400, 'Name the room this command is sent in.');
    // One open offer per device: a new code replaces the last one.
    for (const [other, offer] of this.offers) if (offer.device === id) this.offers.delete(other);
    if (this.offers.size >= MAX_OFFERS) fail(429, 'Too many pairing codes are open right now. Try again in a few minutes.');
    const expiresAt = now + OFFER_TTL_MS;
    this.offers.set(key, { device: id, name, rooms: rooms as string[], expiresAt });
    return { roomId: c.roomId, offer: { expiresAt } };
  }
  /** Drops expired offers across every queue and recounts `signalChars`, so closed rooms and removed devices never leave it high. */
  private pruneSignals(now = this.now()) {
    const cutoff = now - SIGNAL_TTL_MS;
    let chars = 0;
    for (const [key, value] of this.signals) {
      const active = value.filter(s => s.at > cutoff);
      if (active.length) {
        this.signals.set(key, active);
        for (const s of active) chars += s.description.sdp?.length ?? 0;
      } else {
        this.signals.delete(key);
      }
    }
    this.signalChars = chars;
  }
  /** Periodically sweeps expired in-memory presence, link-failure windows and signals across rooms instead of on every poll. */
  private pruneMemory(now: number) {
    if (now - this.lastMemoryPrune < MEMORY_PRUNE_INTERVAL && now >= this.lastMemoryPrune) return;
    this.lastMemoryPrune = now;
    for (const [key, value] of this.presence) if (value.at < now - SIGNAL_TTL_MS) this.presence.delete(key);
    for (const [key, value] of this.linkFailures) if (now - value.since > LINK_FAILURE_WINDOW) this.linkFailures.delete(key);
    this.pruneSignals(now);
  }
  private snapshot(room: Room, id: string, payload: Record<string, unknown>, origin = this.options.origin): RoomStatus {
    const now = this.now();
    this.pruneMemory(now);
    const online = (d: BrowserDevice) => {
      const p = this.presence.get(`${room.id}:${d.id}`);
      return p && p.at > now - PRESENCE_MS ? p.session : undefined;
    };
    const settings = settingsOf(room);
    const result: RoomStatus = { roomId: room.id, title: room.title, epoch: this.epoch, deviceId: id, hostOnline: room.devices.some(d => d.memberId === room.ownerId && !!online(d)), historyForNewcomers: settings.historyForNewcomers };
    const actor = room.devices.find(d => d.id === id);
    if (!actor) {
      const request = room.requests.find(r => r.device.id === id);
      // A pairing proof is shown to nobody, the device that sent it included: it never needs it back.
      const shown = request && (({ pairing, ...rest }) => rest)(request);
      result.request = shown?.state === 'pending' && shown.expiresAt <= now ? { ...shown, state: 'expired', code: undefined } : shown;
      return result;
    }
    if (!uuid(payload.session)) fail(400, 'Invalid browser session.');
    result.expiresAt = this.touchStatus(room.id, now) + this.idleMs;
    const seen = this.presence.get(`${room.id}:${id}`);
    this.presence.set(`${room.id}:${id}`, { session: payload.session, at: now });
    // A device that came online, or came back with a new session: the others can connect to it now.
    if (!seen || seen.session !== payload.session || seen.at <= now - PRESENCE_MS) this.changed(room.id);
    result.memberId = actor.memberId; result.ownerId = room.ownerId;
    result.members = room.members
      .filter(m => room.devices.some(d => d.memberId === m.id))
      .map(m => {
        if (m.joinedAt !== undefined) return m;
        // Backfill legacy rooms created before `joinedAt` existed using the earliest admission time of the member's devices.
        let earliest: number | undefined;
        for (const d of room.devices) if (d.memberId === m.id && (earliest === undefined || d.admittedAt < earliest)) earliest = d.admittedAt;
        return earliest !== undefined ? { ...m, joinedAt: earliest } : m;
      });
    if (room.renames?.length) result.renames = room.renames;
    result.devices = room.devices.map(d => ({ ...d, session: online(d) }));
    if (actor.memberId === room.ownerId) result.requests = room.requests.filter(r => r.state === 'pending' && r.expiresAt > now).map(r => { const { code, pairing, ...rest } = r; return rest; });
    const keepMoreRetired = settings.historyForNewcomers || !!room.historyEverEnabled;
    const formerDevices = listRetiredDevices(this.db, room.id, keepMoreRetired ? MAX_HISTORY_FORMER_DEVICES : MAX_FORMER_DEVICES);
    if (formerDevices.length) result.formerDevices = formerDevices;
    result.settings = settings;
    if (room.repositories?.length) result.repositories = room.repositories;
    const claims = liveClaims(room, now);
    if (claims.length) result.claims = claims;
    const invites = (room.invites || []).filter(i => i.operatorId === actor.memberId && i.expiresAt > now);
    if (invites.length) result.agentInvites = invites.map(({ name, expiresAt }) => ({ name, expiresAt }));
    const key = `${room.id}:${id}`;
    const matchedEpoch = payload.epoch === this.epoch;
    const cursor = matchedEpoch && typeof payload.cursor === 'number' && Number.isSafeInteger(payload.cursor) && payload.cursor > 0 ? payload.cursor : 0;
    const queued = this.signals.get(key);
    if (queued) {
      const cutoff = now - SIGNAL_TTL_MS;
      const admitted = new Set(room.devices.map(d => d.id));
      const kept: (Signal & { at: number })[] = [];
      for (const s of queued) {
        if (s.at <= cutoff || s.targetSession !== payload.session || !admitted.has(s.from) || (matchedEpoch && s.seq <= cursor)) {
          this.signalChars -= s.description.sdp?.length ?? 0;
        } else {
          kept.push(s);
        }
      }
      if (kept.length) this.signals.set(key, kept); else this.signals.delete(key);
      result.signals = [...kept];
    } else {
      result.signals = [];
    }
    result.iceServers = this.iceServers(room);
    if (this.relayEnabled) {
      result.relayUrl = this.relayUrlFor(origin);
      const roster = getRoomRoster<SignedRoster>(this.db, room.id);
      if (roster) result.roster = roster;
    }
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
