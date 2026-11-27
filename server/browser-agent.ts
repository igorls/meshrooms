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
import { tryLock } from './locks';
import { guardNetworkInterfaces, interfacesUnavailable, withoutMdnsCandidates } from './interfaces';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { browserProtocol, signerOf, type AgentRuntimeProfile, type BrowserDevice, type BrowserMember, type Command, type MessageVisibility, type RoomStatus } from '../src/browser/protocol';
import { COMPACT_AT, compactBoard, foldBoard, MAX_TASK_OPS, MAX_TIME, syncChunks, taskBody, validIssueLink, validTaskBody, capLiveTasks, mayAddTask, withinRevisionJump, type BoardSync, type TaskChange, type TaskPacket } from '../src/browser/board';
import {
  FileTransfers, IMAGE_TYPES, LOW_WATER, MAX_ATTACHMENT_BYTES, displayKind, MAX_MESSAGE_ATTACHMENTS, attachmentRef, attachmentText, isFilePacket, isSha256, retainedFiles, shownText,
  validAttachments, type AttachmentRef, type FileStore, type TransferState,
} from '../src/browser/files';
import { cleanName, defaultName, sniff } from '../src/attachments';
import { admissible, castVote, COMPACT_DECISIONS_AT, compactDecisions, decisionChunks, decisionWakes, due, foldDecisions, MAX_DECISION_OPS, nextVoteRevision, openDecision, reviseDecision, validDecisionBody, validVoteBody,
  type Decision, type DecisionBody, type DecisionMode, type DecisionPacket, type DecisionSync, type VoteBody } from '../src/browser/decisions';
import { ACTIVITY_RESEND_MS, LISTEN_HEARTBEAT_MS, activityPacket, isActivityPacket, receiveActivity, validActivity, validActivityPacket, validNote, type Activity, type ActivityOn, type ActivityRecord } from '../src/browser/activity';
import {
  COMPACT_REACTIONS_AT, MAX_REACTION_OPS, REACTION_EMOJI, capReactions, compactReactions, currentRevision,
  foldReactions, isReactionEmoji, mayHoldPending, memberReacted, reactionSyncChunks, validReactionBody,
  type ReactionBody, type ReactionEmoji, type ReactionPacket,
} from '../src/browser/reactions';
import { addRetractions, applyRetractions, isRetracted, mayRetract, opKey, retractedStub, retractionSyncChunks, validRetractBody, type RetractBody, type RetractPacket, type RetractionSync } from '../src/browser/retractions';
import { assignmentWakes, authorWakes, claimHolder, claimRefusal, evaluateWake, heldByAnother, takenBy, mayAgentSpeak, mentionedIds, needsClaim, resolveMessageById, speakRefusal, wakes, type Claim, type Floor, type Task } from '../src/collab';
import type { Message, Participant } from '../src/room';
import { releaseIssueTask } from './github-issues';
import { whileBusy } from './agent-install';
import { awaitingDelivery, MAX_STORED_MESSAGES, windowHistory } from '../src/browser/history';
import {
  buildHistoryHave, canonicalMessageKeys, currentAudienceUntil, HISTORY_ACCEPT_ENTRIES_BURST,
  HISTORY_ACCEPT_ENTRIES_PER_MINUTE, HISTORY_ROUND_TIMEOUT_MS, HISTORY_SERVE_BURST, HISTORY_SERVE_PER_MINUTE,
  historyChunks, isHistoryHavePacket, isHistoryPacket, MAX_HISTORY_ROUND_TIMEOUTS, MAX_HISTORY_ROUNDS,
  maxSeqByDevice, maxSeqForDevice, mayServeMessage, mergeHistoryMessages, messageKey, nextAuthorSeq,
  PeerRateLimiter, RELAY_HISTORY_RETRY_MS, selectHistoryEntries, storedCursorIndex, validAudienceUntil,
  validMessageSeq, validMessageVisibility, withinSeqJump,
  type HistoryCursor, type HistoryHavePacket, type HistoryPacket,
} from '../src/browser/history-sync';
import {
  FILE_CHANNEL_LABEL, IncomingGate, PACE_LOW_WATER, PRIMARY_CHANNEL_LABEL, Resync, SYNC_REQUEST, SendQueue,
  answerMatchesOffer, dedupeSignals, evaluatePeerHealth, isLiveOpenPeer, isSyncRequest, nextPollBackoff, parseRetryAfter, sdpIceUfrag,
  type PeerHealthState, type SyncRequest,
} from '../src/browser/pacer';
import { QuotaDrops, ReceiveQuota, type QuotaKind } from '../src/browser/quota';
import {
  SEALED_STATE_MAX_BYTES, canonicalJson, decodeAgentKeySecret, decryptRelayEnvelope, encodeAgentKeySecret, encryptRelayEnvelope,
  exportRawPublicKey, generateEncKeyPair, hashRosterBody, importEncPrivateJwk, parseHostPin, sealAgentState,
  signEncBinding, signRoster, stripHostPinFromFragment, unsealAgentState, verifyEncBinding, verifyRoster,
  type AgentKeySecret, type DecryptedRelayEnvelope, type RelayEnvelope, type RelayLane, type RemovedRosterEntry,
  type RosterBody, type RosterEntry, type SignedRoster,
} from '../src/browser/relay-crypto';
import { RelayClient, type RelayClientOptions } from '../src/browser/relay-client';
import { RelayReplayGuard, type RelayReplayRecord } from '../src/browser/relay-replay';

export type AgentIdentity = {
  id: string;
  publicKey: string;
  privateJwk: JsonWebKey;
  encPublicKey: string;
  encPrivateJwk: JsonWebKey;
  encVersion: number;
  encSig: string;
};
type Identity = AgentIdentity;
type MessageBody = {
  kind: 'message'; roomId: string; id: string; deviceId: string; memberId: string; text: string; at: number;
  replyTo?: string; attachments?: AttachmentRef[]; visibility?: MessageVisibility; seq?: number; audienceUntil?: number;
};
type ReceiptBody = { kind: 'receipt'; roomId: string; id: string; deviceId: string };
type Packet = { body: MessageBody | ReceiptBody | ReactionBody | RetractBody; signature: string };
export type Stored = { packet: { body: MessageBody; signature: string }; targets: string[]; receipts: string[]; retracted?: true; receivedAt?: number; replicated?: true };
/** `online` (a person device's folders only): the device polled the room service within its presence window. */
type Members = { memberId?: string; ownerId?: string; title?: string; former?: { id: string; role?: 'human' | 'agent' }[]; members: BrowserMember[]; devices: { id: string; memberId: string; online?: boolean }[] };
/** A queued task change; `run` applies it to the board as it stands when signing, so the revision is current. */
type TaskIntent = { type: 'task'; id: string; taskId: string; change: TaskChange; removed?: boolean };
/** A queued reaction toggle; `run` signs it against the current folded chips and revision. */
type ReactionIntent = { type: 'reaction'; id: string; messageId: string; emoji: ReactionEmoji; blocked?: 'log-full' };
/** A queued deletion of the member's own message; `run` signs it. */
type RetractIntent = { type: 'retract'; id: string; messageId: string };
/** A queued claim of a message that went to every agent (or its release); `run` settles it with the room service. */
type ClaimIntent = { type: 'claim'; id: string; messageId: string; release?: true };
/** A queued decision change; like tasks, `run` builds it against the decision as it stands when signing. */
type DecisionIntent = { type: 'decision'; id: string; decisionId: string } & (
  | { action: 'open'; question: string; context: string; mode: DecisionMode; options: string[]; askAgents: boolean | string[]; closesAt: number | null; replyTo?: string }
  | { action: 'vote'; optionId: string | null; comment: string; replyTo?: string }
  | { action: 'option'; label: string } | { action: 'close' } | { action: 'withdraw' });
type StoredDecisionOp = DecisionPacket & { seq: number };
/** A stored task operation and the board cursor at which it arrived. */
type StoredOp = TaskPacket & { seq: number };
/**
 * `sent`: when each outbox message was last sent on this connection, so an unconfirmed one isn't resent every second.
 * `queue` paces this agent's board, decisions and reactions onto the channel; `resync` answers the peer's requests for them.
 */
type Peer = {
  pc: RTCPeerConnection; session: string; channel?: RTCDataChannel; fileChannel?: RTCDataChannel;
  started: number; unhealthySince?: number; openedOnce?: boolean; offerSent?: boolean;
  iceKey?: string; remoteUfrag?: string;
  sent: Map<string, number>; queue?: SendQueue; resync: Resync;
};
/** Message, board and decision cursors `listen` continues from; saved in the agent's room folder. */
export type ListenCursor = { after?: string; boardAfter: number; decisionsAfter: number };
const LISTEN_CURSOR = 'listen-cursor.json';
/** The room folder's subfolder for what the agent's own commands write (see BrowserAgent.live). */
export const LIVE = 'live';

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/**
 * Writes via a temporary file and a rename, so readers never see half a file. On Windows the rename fails with
 * EPERM/EACCES/EBUSY while another process (the runner, `listen`, an antivirus scan) has the target open; that is
 * contention, retried briefly, not a reason for the command to crash.
 */
export function replaceFile(path: string, data: string | Uint8Array, rename: (from: string, to: string) => void = renameSync) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  try { whileBusy(() => rename(temporary, path)); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
function writeJson(path: string, value: unknown) { replaceFile(path, JSON.stringify(value)); }
export function readJson<T>(path: string, fallback: T, read: (p: string) => string = p => readFileSync(p, 'utf8'), platform = process.platform): T {
  try { return JSON.parse(whileBusy(() => read(path), undefined, platform)); } catch { return fallback; }
}
/**
 * Reads JSON for a writer that will replace the file: a missing file (ENOENT) starts from `fallback`, while a read
 * failure (EBUSY past retries, EACCES, ENOSPC) or corrupt JSON throws instead of returning an empty fallback that would
 * overwrite existing history with a single new entry.
 */
export function readJsonStrict<T>(path: string, fallback: T, read: (p: string) => string = p => readFileSync(p, 'utf8'), platform = process.platform): T {
  let text: string;
  try { text = whileBusy(() => read(path), undefined, platform); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return fallback; throw error; }
  return JSON.parse(text);
}
/** Formats a timestamp safely as ISO-8601, clamping out-of-range or non-finite values so Date.toISOString never throws. */
export const safeIso = (at: number) => new Date(Number.isFinite(at) ? Math.min(Math.max(at, 0), MAX_TIME) : 0).toISOString();
/** Per-peer rate limit on incoming `file-want` requests (60/min, burst 20) so hash floods cannot peg CPU or disk. */
export class FileWantLimiter {
  private readonly unit = 60_000;
  private buckets = new Map<string, { tokens: number; at: number; reported: number }>();
  constructor(private now: () => number = () => Date.now(), private perMinute = 60, private burst = 20, private maxBuckets = 512) {}
  private bucket(peer: string) {
    const at = this.now();
    let b = this.buckets.get(peer);
    if (b) {
      this.buckets.delete(peer);
      b.tokens = Math.min(this.burst * this.unit, b.tokens + Math.max(0, at - b.at) * this.perMinute); b.at = at;
    } else b = { tokens: this.burst * this.unit, at, reported: -Infinity };
    this.buckets.set(peer, b);
    if (this.buckets.size > this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value!);
    return b;
  }
  take(peer: string) { const b = this.bucket(peer); if (b.tokens < this.unit) return false; b.tokens -= this.unit; return true; }
  report(peer: string) { const b = this.bucket(peer), at = this.now(); if (at - b.reported < 60_000) return false; b.reported = at; return true; }
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Files younger than this are never evicted: `send` stores them before `run` signs the message naming them. */
const FILE_GRACE_MS = 10 * 60_000;

export function parseRoomUrl(url: string) {
  const parsed = new URL(url);
  const match = /^\/r\/([a-f0-9-]{36})$/.exec(parsed.pathname);
  if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Use the HTTPS room link.');
  if (!match) throw new Error('Use a browser room link like https://host/r/<room id>.');
  const hostPin = parseHostPin(parsed.hash);
  return { origin: parsed.origin, roomId: match[1], ...(hostPin ? { hostPin } : {}) };
}

/** An agent connect link made by a person in the room: https://host/agent/<room>#<one-time token>[&h=<hostPin>]. */
export function parseConnectLink(link: string) {
  const url = new URL(link);
  const match = /^\/agent\/([a-f0-9-]{36})$/.exec(url.pathname);
  const hostPin = parseHostPin(url.hash);
  const token = stripHostPinFromFragment(url.hash);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Use the HTTPS connect link.');
  // A person pasted the room link they share with people: say what it is and where the agent's link comes from.
  if (/^\/r\/[a-f0-9-]{36}$/.test(url.pathname)) throw new Error('This is a person invite (a /r/ room link), not an agent connect link. Ask for the agent connect link: in the room, choose Invite, then An AI agent.');
  if (!match || !/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw new Error('This is not a Meshrooms agent connect link (https://host/agent/<room>#<token>).');
  return { origin: url.origin, roomId: match[1], token, ...(hostPin ? { hostPin } : {}) };
}

/** settings.json. `checkedAt`: when the runner last had them from the room service (this machine's clock). */
export type RoomRules = { floor: Floor; agentAssignmentsWake?: boolean; historyForNewcomers?: boolean; repositories?: string[]; claims?: Claim[]; checkedAt?: number };

/** Written by a person device's runner while it waits for admission: the request's state, and a companion's code. */
export const ADMISSION_FILE = 'admission.json';
/**
 * Written by a person device's runner whenever the room as it last heard it changes: the room service's status without
 * its signals and ICE servers (which carry TURN credentials), devices marked `online` instead of their sessions, the
 * devices it has an open channel to (`connected`), and the agents' activity those channels reported. The local API
 * serves it to the person's own page, which can't poll the room service itself: a second session would take this
 * device's presence over.
 */
export const PERSON_STATUS_FILE = 'status.json';
export type PersonStatus = Omit<RoomStatus, 'signals' | 'iceServers' | 'devices'> & {
  devices?: (BrowserDevice & { online: boolean })[]; connected: string[]; activity: Record<string, ActivityRecord> };
/** The status a person device's runner keeps for the local API (see PERSON_STATUS_FILE). */
export function personStatusOf(next: RoomStatus, connected: string[], activity: Record<string, ActivityRecord>): PersonStatus {
  const { signals: _, iceServers: __, devices, ...rest } = next;
  return { ...rest, ...(devices ? { devices: devices.map(({ session, ...d }) => ({ ...d, online: !!session })) } : {}), connected, activity };
}

type MemoryRoomState = {
  messages: Stored[];
  members: Members;
  settings: RoomRules;
  taskOps: StoredOp[];
  boardSeq: number;
  decisionOps: StoredDecisionOp[];
  decisionSeq: number;
  compactedDecisionIds: string[];
  reactionOps: ReactionPacket[];
  retractOps: RetractPacket[];
  listenCursor?: ListenCursor;
  activity?: Activity;
};

function emptyMemoryRoomState(): MemoryRoomState {
  return {
    messages: [],
    members: { members: [], devices: [] },
    settings: { floor: 'humans-first' as Floor },
    taskOps: [],
    boardSeq: 0,
    decisionOps: [],
    decisionSeq: 0,
    compactedDecisionIds: [],
    reactionOps: [],
    retractOps: [],
  };
}

/**
 * One agent's membership in one browser room, or (with `person`) one room of the machine's person device: the same
 * peer, store and runner, signing with the person's one key (`person.identityFile`) and speaking as a person, so the
 * agents' floor rules don't apply to what it sends.
 *
 * When constructed with `stateless` (from `MESHROOMS_AGENT_KEY`), all identity and room state stays strictly in memory
 * and nothing is created or written on local disk.
 */
export class BrowserAgent {
  readonly dir: string;
  readonly person: boolean;
  readonly stateless: boolean;
  readonly hostPin?: string;
  private readonly identityFile: string;
  private readonly secret?: AgentKeySecret;
  private readonly mem?: MemoryRoomState;
  private identity?: Identity;
  private key?: CryptoKey;
  private encKey?: CryptoKey;
  /** `mkdir: false` only reads the room folder as it is (`bindings` lists rooms without changing them). */
  constructor(dataDir: string, readonly origin: string, readonly roomId: string,
    options: { mkdir?: boolean; person?: { identityFile: string }; stateless?: AgentKeySecret; hostPin?: string } = {}) {
    this.stateless = !!options.stateless;
    this.secret = options.stateless;
    this.hostPin = options.hostPin ?? options.stateless?.hostPin;
    this.dir = this.stateless ? '' : resolve(dataDir, 'browser-agents', roomId);
    this.person = !!options.person;
    this.identityFile = this.stateless ? '' : options.person ? resolve(options.person.identityFile) : join(this.dir, 'identity.json');
    if (this.stateless) {
      this.mem = emptyMemoryRoomState();
    } else if (options.mkdir !== false) {
      for (const sub of ['outbox', 'files', 'wants', LIVE]) mkdirSync(join(this.dir, sub), { recursive: true, mode: 0o700 });
    }
  }
  /** Constructs a stateless in-memory agent from `MESHROOMS_AGENT_KEY` without creating or writing any local files. */
  static fromEnvSecret(secretB64: string, expectedRoomId?: string): BrowserAgent {
    const secret = decodeAgentKeySecret(secretB64);
    if (expectedRoomId && secret.roomId !== expectedRoomId) {
      throw new Error(`MESHROOMS_AGENT_KEY is for room ${secret.roomId}, not ${expectedRoomId}.`);
    }
    return new BrowserAgent('', secret.origin, secret.roomId, { mkdir: false, stateless: secret, hostPin: secret.hostPin });
  }
  /** Hydrates in-memory room state for stateless (`MESHROOMS_AGENT_KEY`) runs. */
  hydrateMemoryState(patch: Partial<MemoryRoomState>) {
    if (!this.mem) return;
    Object.assign(this.mem, patch);
  }
  /** Snapshot of in-memory room state for stateless (`MESHROOMS_AGENT_KEY`) runs. */
  memoryState(): MemoryRoomState | undefined {
    return this.mem;
  }
  private path(name: string) { return join(this.dir, name); }
  /**
   * State the agent's own commands write (its listen cursor and activity) lives in live/, apart from the files the runner
   * and the watcher trust, so a harness sandbox can be given live/, outbox/, files/ and wants/ without the rest.
   * Folders from before live/ existed are still read.
   */
  private live(name: string) { const path = join(this.dir, LIVE, name); return existsSync(path) || !existsSync(this.path(name)) ? path : this.path(name); }
  private readonly verifiedFiles = new Map<string, string>();
  private rememberVerified(sha: string, stamp: string) {
    this.verifiedFiles.delete(sha);
    this.verifiedFiles.set(sha, stamp);
    if (this.verifiedFiles.size > 512) this.verifiedFiles.delete(this.verifiedFiles.keys().next().value!);
  }
  /** Content-addressed files: <dir>/files/<sha256>. Every read (and uncached `has`) re-hashes, deleting damaged copies. */
  readonly files: FileStore & { path: (sha: string) => string; add: (bytes: Uint8Array) => string } = {
    path: sha => this.path(join('files', sha)),
    // A regular file only: a link planted in files/ is never followed, and uncached files are hashed against their name.
    has: sha => {
      if (!isSha256(sha)) return false;
      const path = this.files.path(sha);
      try {
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isFile()) return false;
        const stamp = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`;
        if (this.verifiedFiles.get(sha) === stamp) return true;
        const bytes = new Uint8Array(readFileSync(path));
        if (sha256(bytes) === sha) { this.rememberVerified(sha, stamp); return true; }
        this.verifiedFiles.delete(sha);
        try { unlinkSync(path); } catch { /* Already gone. */ }
        return false;
      } catch {
        this.verifiedFiles.delete(sha);
        return false;
      }
    },
    get: async sha => {
      if (!isSha256(sha)) return undefined;
      const path = this.files.path(sha);
      try {
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isFile()) return undefined;
        const bytes = new Uint8Array(readFileSync(path));
        if (sha256(bytes) === sha) { this.rememberVerified(sha, `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`); return bytes; }
        this.verifiedFiles.delete(sha);
        try { unlinkSync(path); } catch { /* Already gone. */ }
        return undefined;
      } catch {
        this.verifiedFiles.delete(sha);
        return undefined;
      }
    },
    // Only verified bytes arrive here, so they always replace whatever is on disk (a damaged copy would block them otherwise).
    put: async (_sha, bytes) => { this.files.add(bytes); },
    add: bytes => {
      const sha = sha256(bytes), path = this.files.path(sha);
      replaceFile(path, bytes);
      this.verifiedFiles.delete(sha);
      return sha;
    },
  };
  /** Metadata of a file named by a stored (verified) message, by attachment id or hash. */
  attachment(key: string): AttachmentRef | undefined {
    for (const { packet: { body } } of this.messages()) for (const ref of body.attachments || []) if (ref.id === key || ref.sha256 === key) return ref;
  }
  transfers(): Record<string, TransferState> { return readJson(this.path('transfers.json'), {}); }
  async ensureIdentity(): Promise<Identity> {
    if (this.identity && this.key && this.encKey) return this.identity;
    const signWith = async (ecdsaKey: CryptoKey, value: unknown) =>
      b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ecdsaKey, encode(value)));
    if (this.secret) {
      const signJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: this.secret.signJwk.x, y: this.secret.signJwk.y, d: this.secret.signJwk.d };
      const signPubJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: this.secret.signJwk.x, y: this.secret.signJwk.y };
      const encPubJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: this.secret.encJwk.x, y: this.secret.encJwk.y };
      const signKey = await crypto.subtle.importKey('jwk', signJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const signPubKey = await crypto.subtle.importKey('jwk', signPubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const publicKey = b64(await crypto.subtle.exportKey('raw', signPubKey));
      const id = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
      const encKey = await importEncPrivateJwk(this.secret.encJwk, false);
      const encPubKey = await crypto.subtle.importKey('jwk', encPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
      const encPublicKey = await exportRawPublicKey(encPubKey);
      const encVersion = this.secret.encVersion;
      const encSig = await signEncBinding(v => signWith(signKey, v), { room: this.roomId, deviceId: id, enc: encPublicKey, encVersion });
      this.key = signKey;
      this.encKey = encKey;
      this.identity = { id, publicKey, privateJwk: signJwk, encPublicKey, encPrivateJwk: this.secret.encJwk, encVersion, encSig };
      return this.identity;
    }
    const file = this.identityFile;
    if (!existsSync(file)) {
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const publicKey = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
      const id = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
      const privateJwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
      const encKeys = await generateEncKeyPair(true);
      const encPublicKey = await exportRawPublicKey(encKeys.publicKey);
      const encPrivateJwk = await crypto.subtle.exportKey('jwk', encKeys.privateKey);
      const encVersion = 1;
      const encSig = await signEncBinding(v => signWith(keys.privateKey, v), {
        room: this.person ? '*' : this.roomId,
        deviceId: id,
        enc: encPublicKey,
        encVersion,
      });
      const created: Identity = { id, publicKey, privateJwk, encPublicKey, encPrivateJwk, encVersion, encSig };
      writeFileSync(file, JSON.stringify(created), { mode: 0o600, flag: 'wx' });
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Identity> & { id: string; publicKey: string; privateJwk: JsonWebKey };
    const signKey = await crypto.subtle.importKey('jwk', raw.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    let upgraded: Identity;
    if (
      typeof raw.encPublicKey === 'string' && raw.encPublicKey.length === 88
      && raw.encPrivateJwk && typeof raw.encPrivateJwk.d === 'string'
      && typeof raw.encVersion === 'number' && Number.isInteger(raw.encVersion) && raw.encVersion >= 1
      && typeof raw.encSig === 'string' && raw.encSig.length === 88
    ) {
      upgraded = raw as Identity;
    } else {
      // Seamlessly upgrade legacy identity.json files with a separate persistent P-256 ECDH encryption keypair.
      const encKeys = await generateEncKeyPair(true);
      const encPublicKey = await exportRawPublicKey(encKeys.publicKey);
      const encPrivateJwk = await crypto.subtle.exportKey('jwk', encKeys.privateKey);
      const encVersion = 1;
      const encSig = await signEncBinding(v => signWith(signKey, v), {
        room: this.person ? '*' : this.roomId,
        deviceId: raw.id,
        enc: encPublicKey,
        encVersion,
      });
      upgraded = { id: raw.id, publicKey: raw.publicKey, privateJwk: raw.privateJwk, encPublicKey, encPrivateJwk, encVersion, encSig };
      replaceFile(file, JSON.stringify(upgraded));
    }
    this.identity = upgraded;
    this.key = signKey;
    this.encKey = await importEncPrivateJwk(upgraded.encPrivateJwk, false);
    return this.identity;
  }
  /** Room-scoped `{ enc, encVersion, encSig }` binding signed by this device's ECDSA key. */
  async encBinding(roomId = this.roomId): Promise<{ enc: string; encVersion: number; encSig: string }> {
    const id = await this.ensureIdentity();
    const encSig = await signEncBinding(v => this.sign(v), {
      room: roomId,
      deviceId: id.id,
      enc: id.encPublicKey,
      encVersion: id.encVersion,
    });
    return { enc: id.encPublicKey, encVersion: id.encVersion, encSig };
  }
  /** Decrypts an incoming E2E `RelayEnvelope` using this device's persistent ECDH private key. */
  async decryptRelay<T = unknown>(
    envelope: unknown,
    options: { senderSignKey: string; minRosterVersion?: number; expectedFrom?: string },
  ): Promise<DecryptedRelayEnvelope<T>> {
    const id = await this.ensureIdentity();
    return decryptRelayEnvelope<T>(envelope, {
      room: this.roomId,
      selfDeviceId: id.id,
      selfEncPrivateKey: this.encKey!,
      selfEncVersion: id.encVersion,
      senderSignKey: options.senderSignKey,
      minRosterVersion: options.minRosterVersion,
      expectedFrom: options.expectedFrom,
    });
  }
  /** Encrypts opaque agent state (<= 256 KB) to this device's own ECDH key for relay storage. */
  async sealState(state: unknown): Promise<string> {
    const id = await this.ensureIdentity();
    return sealAgentState(state, this.encKey!, { room: this.roomId, deviceId: id.id });
  }
  /** Decrypts opaque agent state previously sealed by this device. */
  async unsealState<T = unknown>(blob: string): Promise<T> {
    const id = await this.ensureIdentity();
    return unsealAgentState<T>(blob, this.encKey!, { room: this.roomId, deviceId: id.id });
  }
  /** Encodes this room agent's persistent identity as a `MESHROOMS_AGENT_KEY` secret value. */
  async exportKeySecret(hostPin?: string): Promise<string> {
    const id = await this.ensureIdentity();
    const pin = hostPin ?? this.hostPin;
    return encodeAgentKeySecret({
      origin: this.origin,
      roomId: this.roomId,
      signJwk: id.privateJwk,
      encJwk: id.encPrivateJwk,
      encVersion: id.encVersion,
      ...(pin ? { hostPin: pin } : {}),
    });
  }
  /** Builds a `RelayClient` configured for this agent's device identity and room. */
  async createRelayClient(options: Partial<RelayClientOptions> = {}): Promise<RelayClient> {
    const id = await this.ensureIdentity();
    return new RelayClient({
      origin: this.origin,
      roomId: this.roomId,
      deviceId: id.id,
      publicKey: id.publicKey,
      sign: v => this.sign(v),
      ...options,
    });
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
  async command(action: Command['action'] | 'agent-redeem', payload: Record<string, unknown> = {}, id: string = randomUUID(), timeoutMs = 10_000): Promise<any> {
    const identity = await this.ensureIdentity();
    // 'agent-redeem' joins the protocol with browser-room agents; older coordinators reject it with a clear error.
    const command = { protocol: browserProtocol, origin: this.origin, id, at: Date.now(), action, roomId: this.roomId, payload } as Command;
    const response = await fetch(`${this.origin}/api/lobby`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Origin: this.origin, 'X-Meshrooms-Protocol': '1' },
      body: JSON.stringify({ command, publicKey: identity.publicKey, signature: await this.sign(command) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const code = typeof result.code === 'string' ? result.code : response.status === 426 ? 'upgrade-required' : undefined;
      const fallback = response.status === 426
        ? 'This Meshrooms bridge is out of date. Upgrade with bunx @wormdb/meshrooms@latest.'
        : `Room service rejected ${action} (${response.status}).`;
      throw Object.assign(new Error(result.error || fallback), {
        status: response.status,
        ...(code ? { code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    return result;
  }
  messages(): Stored[] { return this.mem ? this.mem.messages : readJson(this.path('messages.json'), []); }
  members(): Members { return this.mem ? this.mem.members : readJson(this.path('members.json'), { members: [], devices: [] }); }
  /** The room's rules as the host set them, copied from the room service by `run`. */
  settings(): RoomRules { return this.mem ? this.mem.settings : readJson(this.path('settings.json'), { floor: 'humans-first' as Floor }); }
  /**
   * Keeps a claim the room service just settled, until the runner's next poll brings the room's own list. Only over rules
   * the runner already wrote: never a default floor in place of the host's. Best effort: a sandboxed wake may not write
   * the room folder, and the runner's next poll brings the same claim.
   */
  noteClaim(messageId: string, claim: Claim | null) {
    const rules = this.settings(), claims = [...(rules.claims ?? []).filter(c => c.messageId !== messageId), ...(claim ? [claim] : [])];
    if (this.mem) { this.mem.settings = { ...rules, claims }; return; }
    try { if (existsSync(this.path('settings.json'))) writeJson(this.path('settings.json'), { ...rules, claims }); } catch { /* the next poll writes it */ }
  }
  /** Verified task operations in arrival order, each with the board cursor at which it arrived. */
  taskOps(): StoredOp[] {
    const raw = this.mem ? this.mem.taskOps : readJson<StoredOp[]>(this.path('tasks.json'), []);
    return raw.map((p, i) => ({ ...p, seq: p.seq ?? i + 1 }));
  }
  /** Arrivals so far. Compaction drops operations but never moves the cursor back, so later assignments still wake. */
  boardCursor(ops = this.taskOps()) {
    const seq = this.mem ? this.mem.boardSeq : readJson(this.path('board.json'), { seq: 0 }).seq;
    return Math.max(seq, ops.at(-1)?.seq ?? 0);
  }
  /** Verified decision and vote operations in arrival order, each with the decision cursor at which it arrived. */
  decisionOps(): StoredDecisionOp[] { return this.mem ? this.mem.decisionOps : readJson<StoredDecisionOp[]>(this.path('decisions.json'), []); }
  /** Arrivals so far; compaction drops votes but never moves the cursor back, so later wakes still fire. */
  /** Ids of this agent's own decision changes that compaction dropped, so a retried request is never signed twice. */
  compactedDecisionIds(): Set<string> { return new Set(this.mem ? this.mem.compactedDecisionIds : readJson<string[]>(this.path('decisions-done.json'), [])); }
  /** Whether this device already made the change with that request id: still in the log, or dropped by compaction since. */
  madeDecisionOp(id: string, ops = this.decisionOps()) { return ops.some(p => p.body.id === id) || this.compactedDecisionIds().has(id); }
  decisionCursor(ops = this.decisionOps()) {
    const seq = this.mem ? this.mem.decisionSeq : readJson(this.path('decisions-cursor.json'), { seq: 0 }).seq;
    return Math.max(seq, ops.at(-1)?.seq ?? 0);
  }
  /** The room's decisions as every device folds them; people's votes count, agents' are advice. */
  decisions(ops = this.decisionOps()): Decision[] {
    const { ownerId, members, former } = this.members();
    return foldDecisions(ops.map(p => p.body), { ownerId, members, former });
  }
  /** Verified reaction operations this device holds (only for messages it also holds). */
  reactionOps(): ReactionPacket[] { return this.mem ? this.mem.reactionOps : readJson(this.path('reactions.json'), []); }
  reactionChips() { return foldReactions(this.reactionOps().map(p => p.body)); }
  /** Verified retractions, including those of messages this device doesn't hold (yet, or any more). */
  retractOps(): RetractPacket[] { return this.mem ? this.mem.retractOps : readJson(this.path('retractions.json'), []); }
  /** Where a plain `listen` continues from: the cursors the last `listen` returned. */
  listenCursor(): ListenCursor | undefined {
    const c = this.mem ? this.mem.listenCursor : readJson<Partial<ListenCursor> | undefined>(this.live(LISTEN_CURSOR), undefined);
    const n = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
    return c && n(c.boardAfter) && n(c.decisionsAfter) && (c.after === undefined || typeof c.after === 'string') ? c as ListenCursor : undefined;
  }
  saveListenCursor(cursor: ListenCursor, expected?: string, options: { monotonic?: boolean } = {}) {
    if (this.mem) {
      const current = this.listenCursor();
      if (expected !== undefined && JSON.stringify(current ?? null) !== expected) return false;
      this.mem.listenCursor = cursor;
      return true;
    }
    mkdirSync(join(this.dir, LIVE), { recursive: true, mode: 0o700 });
    const lock = join(this.dir, LIVE, 'listen-cursor.lock');
    if (!tryLock(lock, 'the listen cursor', undefined, { maxAgeMs: 30_000 })) throw new Error('The listen cursor is busy. Try again.');
    try {
      const current = this.listenCursor();
      if (expected !== undefined && JSON.stringify(current ?? null) !== expected) return false;
      let next = cursor;
      if (options.monotonic && current) {
        const boardMax = this.boardCursor(), decisionMax = this.decisionCursor();
        const curBoard = current.boardAfter <= boardMax ? current.boardAfter : 0;
        const curDecisions = current.decisionsAfter <= decisionMax ? current.decisionsAfter : 0;
        let after = cursor.after;
        if (current.after !== undefined) {
          if (cursor.after === undefined) {
            if (storedCursorIndex(this.messages(), current.after) >= 0) after = current.after;
          } else if (cursor.after !== current.after) {
            const held = this.messages();
            const curIdx = storedCursorIndex(held, current.after), nextIdx = storedCursorIndex(held, cursor.after);
            if (curIdx >= 0 && (nextIdx < 0 || curIdx > nextIdx)) after = current.after;
          }
        }
        next = { ...(after !== undefined ? { after } : {}), boardAfter: Math.max(curBoard, cursor.boardAfter), decisionsAfter: Math.max(curDecisions, cursor.decisionsAfter) };
      }
      writeJson(join(this.dir, LIVE, LISTEN_CURSOR), next); return true;
    } finally { try { unlinkSync(lock); } catch { /* Released already. */ } }
  }
  /** What the agent is doing, as its own commands last recorded it; undefined before its first `listen`. */
  activity(): Activity | undefined {
    const a = this.mem ? this.mem.activity : readJson<unknown>(this.live('activity.json'), undefined);
    return validActivity(a) ? a : undefined;
  }
  /** A change of state starts a new `since` and drops the note, which described the previous state. */
  recordActivity(state: Activity['state'], on?: ActivityOn, now = Date.now()) {
    const current = this.activity(), same = current?.state === state;
    const messages = on?.messages?.length ? { messages: on.messages } : {}, tasks = on?.tasks?.length ? { tasks: on.tasks } : {};
    const next: Activity = { state, since: same ? current!.since : now, heartbeat: now,
      ...(state === 'working' && (messages.messages || tasks.tasks) ? { on: { ...messages, ...tasks } } : {}), ...(same && current!.note ? { note: current!.note } : {}) };
    if (this.mem) { this.mem.activity = next; return next; }
    writeJson(join(this.dir, LIVE, 'activity.json'), next); return next;
  }
  /** The agent is still at it: refresh the heartbeat without changing what it is doing. */
  touchActivity(now = Date.now()) {
    const current = this.activity();
    if (!current) return;
    const next = { ...current, heartbeat: now };
    if (this.mem) { this.mem.activity = next; return; }
    writeJson(join(this.dir, LIVE, 'activity.json'), next);
  }
  /** Set (or clear, with an empty note) the agent's note. Before any `listen`, a note means it is working. */
  noteActivity(note: string, now = Date.now()) {
    const text = note.trim();
    if (text && !validNote(text)) throw new Error('Keep the note to one line of up to 140 characters.');
    const { note: _, ...current } = this.activity() ?? { state: 'working' as const, since: now, heartbeat: now };
    const next: Activity = { ...current, heartbeat: now, ...(text ? { note: text } : {}) };
    if (this.mem) { this.mem.activity = next; return next; }
    writeJson(join(this.dir, LIVE, 'activity.json'), next); return next;
  }

  /** The room as local-room shapes, so collab.ts rules apply unchanged. */
  view() {
    const { memberId, members } = this.members();
    const self = this.person ? 'human' as const : 'agent' as const;
    const participants: Participant[] = members.map(m => ({ id: m.id, name: m.name, role: m.id === memberId ? self : m.role ?? 'human',
      state: m.id === memberId ? 'local' : 'remote', detail: 'Browser room member', ...(m.operatorId ? { operatorId: m.operatorId } : {}) }));
    const stored = this.messages();
    const canonicalKeys = canonicalMessageKeys(stored);
    const messages: Message[] = stored.map(({ packet: { body }, retracted }) => {
      const author = participants.find(p => p.id === body.memberId);
      const text = retracted ? 'Message deleted' : shownText(body), mentions = mentionedIds(text, participants);
      // `kind` follows the declared type here; `attachment` re-checks it against the verified bytes.
      const attachments = body.attachments?.map(ref => ({ ...ref, kind: IMAGE_TYPES.includes(ref.type) ? 'image' as const : 'file' as const }));
      const collidingCopy = canonicalKeys.get(body.id) !== messageKey(body.deviceId, body.id);
      return { id: body.id, authorId: body.memberId, author: author?.name ?? 'Former member', role: author?.role ?? 'human', text,
        time: safeIso(body.at), deviceId: body.deviceId, ...(collidingCopy ? { collidingCopy: true as const } : {}), ...(retracted ? { deleted: true } : {}), ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(mentions.length ? { mentions } : {}), ...(attachments ? { attachments } : {}) };
    });
    const ops = this.taskOps();
    const settings = this.settings();
    return { memberId, participants, messages, floor: settings.floor, agentAssignmentsWake: !!settings.agentAssignmentsWake, historyForNewcomers: !!settings.historyForNewcomers, claims: settings.claims ?? [], tasks: boardTasks(ops), boardRevision: this.boardCursor(ops) };
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

/** Whether the runner may sign a queued message: the room's floor rules, as `send` checks them, for its reply target. */
export function queuedMaySpeak(agent: BrowserAgent, memberId: string, replyTo: string | undefined, text?: string) {
  return mayAgentSpeak(agent.view(), memberId, replyTo, text);
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/**
 * Why the runner must not sign a queued item, if it mustn't. The commands check the same before they queue, but
 * anything that can write the outbox (a harness sandbox can) skips them, so the runner checks again: well-formed ids,
 * the room's floor for messages and for opening a decision, advice only when asked or addressed, only stewards close a
 * decision, and message text within the room's limit. Task, decision and reaction bodies are also checked as peers
 * check them, once built.
 */
export function outboxProblem(agent: BrowserAgent, memberId: string, item: unknown): string | undefined {
  const id = (value: unknown) => typeof value === 'string' && UUID.test(value);
  const it = item as Record<string, any>;
  if (!it || typeof it !== 'object' || !id(it.id)) return 'its id is not a UUID';
  if (it.replyTo !== undefined && !id(it.replyTo)) return 'its reply target is not a UUID';
  const view = agent.view();
  // A person's own device: the floor is for agents, and a person's vote counts rather than advises. Claims aside: the
  // runner settles those with the room service before it signs a reply (see settleClaim), since the claims this device
  // last heard may already be out of date.
  const speaks = (replyTo: unknown, text?: string) => agent.person || mayAgentSpeak(view, memberId, replyTo as string | undefined, text, true);
  if (it.type === 'decision') {
    if (!id(it.decisionId)) return 'its decision id is not a UUID';
    if (it.action === 'open') return speaks(it.replyTo) ? undefined : 'nothing in this room addressed the agent';
    const current = pickDecision(agent.decisions(), it.decisionId, memberId);
    if (!current) return undefined; // Nothing to change: the runner makes no change for it.
    if (it.action === 'vote') {
      const asked = current.askAgents === true || (Array.isArray(current.askAgents) && current.askAgents.includes(memberId));
      return asked || speaks(it.replyTo) ? undefined : 'the decision did not ask the agent and nothing addressed it';
    }
    if (it.action === 'close' || it.action === 'withdraw') {
      const { ownerId, members } = agent.members();
      const steward = current.createdBy === memberId || memberId === ownerId || members.some(m => m.id === current.createdBy && m.operatorId === memberId);
      return steward ? undefined : 'only who opened a decision, its operator, or the host can close it';
    }
    if (it.action === 'option') return current.mode === 'plan-review' ? 'plan reviews keep their options'
      : typeof it.label !== 'string' || !it.label.trim() ? 'give the new option a label' : undefined;
    return 'it is not a known decision change';
  }
  if (it.type === 'task') return id(it.taskId) ? undefined : 'its task id is not a UUID';
  if (it.type === 'reaction') return id(it.messageId) ? undefined : 'its message id is not a UUID';
  if (it.type === 'retract') {
    if (!id(it.messageId)) return 'its message id is not a UUID';
    const target = agent.messages().find(m => m.packet.body.id === it.messageId);
    return target && target.packet.body.memberId !== memberId ? 'only its author can delete a message' : undefined;
  }
  if (it.type === 'claim') {
    if (agent.person) return 'only agents claim messages';
    if (!id(it.messageId)) return 'its message id is not a UUID';
    if (it.release !== undefined && it.release !== true) return 'it is neither a claim nor a release';
    const target = resolveMessageById(view.messages, it.messageId);
    if (!target || !needsClaim(view, target)) return 'it is not a message that went to every agent';
    return it.release || wakes(view, target, memberId) ? undefined : 'the message does not wake the agent';
  }
  if (it.type !== undefined) return 'it is not a known kind';
  if (typeof it.text !== 'string' || it.text.length > 4000 || (!it.text.trim() && !(Array.isArray(it.attachments) && it.attachments.length)))
    return 'its text is empty or longer than 4,000 characters';
  return speaks(it.replyTo, it.text) ? undefined : 'nothing in this room addressed the agent';
}

/**
 * The runner rewrites this every second with its pid, so a command that can't inspect processes can still tell it runs:
 * `{ pid, at, startedAt, loopAt, polledAt?, failingSince?, failure?, syncedAt?, removedSince? }`.
 * - `at`: the process is alive (its ticker runs).
 * - `loopAt`: its loop last came round (reached the top of a pass, or had any outcome from its status poll). A pass is
 *   bounded, so a loop that stops coming round is stuck, and only that counts against the runner.
 * - `polledAt`: the room service last answered its status poll. `failingSince` and `failure`: the service has not
 *   answered since then, and why. That is an outage or a rejection that replacing the runner can't fix (and killing it
 *   would drop data channels that still work), so it is reported, never repaired.
 * - `syncedAt`: a channel to another device first opened, or the room service said no other device is online, so
 *   there is no history to wait for (set once; see startFromNow).
 * - `removedSince`: the room service has answered since then that this device is no longer in the room, which it was
 *   (someone removed the agent). Cleared once it is admitted again.
 */
export const RUNNER_ALIVE = 'runner-alive.json';
/**
 * A runner whose loop has not come round for this long is stuck, however fresh its proof of life: a pass takes at most
 * about 24 s (an 11 s poll, a 12 s budget, a second's pause), so this is well past any pass. Whoever owns the runner then
 * stops it and starts a fresh one.
 */
export const RUNNER_STUCK_MS = 60_000;
/**
 * How long the runner's loop has not come round, by its proof of life, never counted from before `since` (a command that
 * just started or replaced it gives it its full time). Undefined when the proof doesn't say (a runner from before this
 * was recorded), which is never taken for a stuck runner.
 */
export function stuckFor(proof: unknown, now = Date.now(), since = 0): number | undefined {
  const loopAt = (proof as { loopAt?: unknown } | undefined)?.loopAt;
  return typeof loopAt === 'number' ? now - Math.max(loopAt, since) : undefined;
}
export const runnerStuck = (proof: unknown, now = Date.now(), since = 0) => (stuckFor(proof, now, since) ?? 0) > RUNNER_STUCK_MS;
/**
 * Since when, and why, the room service has not answered the runner, by its proof; undefined while it answers. `status`:
 * the HTTP status of the latest failure when the service did answer (a rejection, a rate limit, a server error); absent
 * when the request itself failed or timed out.
 */
export function serviceSilence(proof: unknown): { since: number; failure?: string; status?: number; upgradeRequired?: boolean } | undefined {
  const p = proof as { failingSince?: unknown; failure?: unknown; failureStatus?: unknown; upgradeRequired?: unknown } | undefined;
  return typeof p?.failingSince === 'number' ? { since: p.failingSince, ...(typeof p.failure === 'string' ? { failure: p.failure } : {}),
    ...(typeof p.failureStatus === 'number' ? { status: p.failureStatus } : {}),
    ...(p.upgradeRequired ? { upgradeRequired: true } : {}) } : undefined;
}
/** Poll backoff after HTTP 426 Upgrade Required (OPS-6), avoiding 1 s retry storms while waiting for upgrade. */
export const UPGRADE_BACKOFF_MS = 60_000;
/** Written by the runner when the room service answers 410 (the host closed the room, or the service removed it). */
export const ROOM_CLOSED_FILE = 'room-closed.json';
/**
 * No proof of life from the runner for this long means it stopped or hangs. One pass can legitimately take a status
 * request that times out (10 s) plus some signalling, so this is well above that.
 */
export const RUNNER_STALE_MS = 30_000;
/** After this long without a new proof of life, a proof naming a process that no longer exists is not worth waiting out. */
const RUNNER_GONE_MS = 5_000;
const processGone = (pid: unknown) => {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 1) return false;
  try { process.kill(pid as number, 0); return false; } catch (error) { return (error as { code?: string }).code === 'ESRCH'; }
};
/**
 * What is wrong with the runner a command waited on since `since`, if anything. 'stopped': its proof of life is older
 * than RUNNER_STALE_MS, or names a process that is gone. 'stuck': it lives, but its loop has not come round for
 * RUNNER_STUCK_MS. A room service that doesn't answer is neither (see serviceSilence). Before its first proof, a runner
 * started just now gets RUNNER_STALE_MS from `since`.
 */
export function runnerTrouble(agent: BrowserAgent, since: number, now = Date.now()): 'stopped' | 'stuck' | undefined {
  const proof = readJson<{ pid?: unknown; at?: unknown } | undefined>(join(agent.dir, RUNNER_ALIVE), undefined);
  const at = typeof proof?.at === 'number' ? proof.at : 0, last = Math.max(at, since);
  if (now - last > RUNNER_STALE_MS) return 'stopped';
  // Only a proof from since onwards names the runner to check: an older one is the runner this one replaced, whose
  // process is gone by design while the new one starts up (bun, the version check) before its first proof.
  if (at >= since && now - last > RUNNER_GONE_MS && processGone(proof?.pid)) return 'stopped';
  return runnerStuck(proof, now, since) ? 'stuck' : undefined;
}
/** Whether the runner a command waited on since `since` stopped, or its loop is stuck (see runnerTrouble). */
export const runnerStopped = (agent: BrowserAgent, since: number, now = Date.now()) => runnerTrouble(agent, since, now) !== undefined;
/** Why the room is gone, once the runner has heard it from the room service. */
export function roomClosed(agent: BrowserAgent): { at: number; reason: string } | undefined {
  const closed = readJson<{ at?: unknown; reason?: unknown } | undefined>(join(agent.dir, ROOM_CLOSED_FILE), undefined);
  return closed && typeof closed.reason === 'string' && typeof closed.at === 'number' ? { at: closed.at, reason: closed.reason } : undefined;
}

/** Runtime settings given to `connect` before host approval. The runner reports them once admitted. */
export const PENDING_PROFILE = 'profile-pending.json';
export async function applyPendingProfile(agent: BrowserAgent, log: (line: string) => void) {
  const path = join(agent.dir, PENDING_PROFILE);
  if (!existsSync(path)) return;
  const pending = readJson<AgentRuntimeProfile | null>(path, null);
  try { if (pending) { await agent.command('profile', pending); log('reported runtime settings'); } }
  catch (error) {
    const { status, message } = error as Error & { status?: number };
    if (status === undefined || status === 408 || status === 429 || status >= 500) return;
    log(`could not report runtime settings (run profile again): ${message}`);
  }
  try { unlinkSync(path); } catch { /* Already gone. */ }
}

type OutboxPeer = { channel?: { readonly readyState: string; readonly bufferedAmount: number; send(data: string): void }; sent: Map<string, number> };
/**
 * Send each connected peer up to 16 of its unconfirmed messages per tick, oldest first, while its send buffer has room;
 * one sent in the last few seconds waits for its receipt. A failing channel is logged and skipped until the next tick.
 */
export function flushOutbox(messages: Stored[], self: string, peers: Map<string, OutboxPeer>, log: (line: string) => void, now = Date.now()) {
  for (const [id, peer] of peers) {
    const channel = peer.channel;
    if (channel?.readyState !== 'open') continue;
    let sent = 0;
    for (const m of messages) {
      if (sent >= 16 || channel.bufferedAmount > 256_000) break;
      const messageId = m.packet.body.id;
      if (m.packet.body.deviceId !== self || !m.targets.includes(id) || m.receipts.includes(id) || now - (peer.sent.get(messageId) ?? 0) < 5000) continue;
      try { channel.send(JSON.stringify(m.packet)); sent++; peer.sent.set(messageId, now); }
      catch (error) { log(`send to ${id.slice(0, 8)} failed: ${(error as Error).message}`); break; }
    }
    if (peer.sent.size > 4096) peer.sent.clear();
  }
}

/** Whether `work` settled within `ms`. It is not cancelled either way: a promise can't be. */
export async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); });
  try { return await Promise.race([work.then(() => true, () => true), late]); } finally { clearTimeout(timer); }
}
/** Each promise's outcome if it settled within `ms`, undefined for one still pending then. Late rejections stay handled. */
export async function settleWithin<T>(work: Promise<T>[], ms: number): Promise<(PromiseSettledResult<T> | undefined)[]> {
  const results: (PromiseSettledResult<T> | undefined)[] = work.map(() => undefined);
  await within(Promise.all(work.map((p, i) => p.then(value => { results[i] = { status: 'fulfilled', value }; }, reason => { results[i] = { status: 'rejected', reason }; }))), ms);
  return [...results];
}
/**
 * How long `describe` waits for werift's candidate gathering before it signals what it has. werift's setLocalDescription
 * resolves only once every STUN and TURN server has answered or timed out. On a network that drops UDP, one udp TURN URL
 * holds it for about 13 s, which is past the pass's `signals` deadline, so the agent dropped every connection it started.
 * Past this deadline the description goes out with the candidates gathered so far (relay over TCP/TLS comes in about a
 * second) and werift keeps gathering. The browser does the same: it waits up to 4 s, then sends what it has.
 */
export const GATHER_DEADLINE_MS = 3_000;
/** A gathered candidate as werift's onIceCandidate reports it. */
export type GatheredCandidate = { candidate: string; sdpMLineIndex?: number | null };
/**
 * `sdp` with each of `candidates` added to the end of its media section as an `a=candidate` line. Candidates already
 * there, or with a line break in them, are skipped. Descriptions are not trickled, so this is how candidates gathered
 * before the gather deadline reach the peer.
 */
export function withGatheredCandidates(sdp: string, candidates: GatheredCandidate[]): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol); if (lines.at(-1) === '') lines.pop();
  const sections = lines.flatMap((line, i) => line.startsWith('m=') ? [i] : []);
  if (!sections.length) return sdp;
  const present = new Set(lines.filter(line => line.startsWith('a=candidate:')).map(line => line.slice(2)));
  const added = new Map<number, string[]>();
  for (const { candidate, sdpMLineIndex } of candidates) {
    const text = String(candidate ?? '').replace(/^a=/, '');
    if (!text.startsWith('candidate:') || /[\r\n]/.test(text) || present.has(text)) continue;
    present.add(text);
    const section = Math.min(Math.max(Number.isInteger(sdpMLineIndex) ? sdpMLineIndex! : 0, 0), sections.length - 1);
    added.set(section, [...(added.get(section) ?? []), `a=${text}`]);
  }
  for (let section = sections.length - 1; section >= 0; section--) {
    const extra = added.get(section); if (!extra) continue;
    lines.splice(section + 1 < sections.length ? sections[section + 1] : lines.length, 0, ...extra);
  }
  return lines.join(eol) + eol;
}
/**
 * How long one pass of the runner waits on each step. The room service keeps a device present for 25 s after it
 * handled its last poll (PRESENCE_MS). Between one poll being handled and the next: the rest of that poll's round trip
 * (the request gives up after 10 s, and `poll` backs that up), everything after it (which shares `budget`), the second's
 * pause, and the next request's way to the service. That keeps polls inside the window in the usual case; only a slow
 * answer followed by a slow next request can pass it, and the next poll restores presence. A step that runs past its time is
 * left running, never started twice, and the pass moves on; one still unfinished after `wedged` means the runner can no
 * longer do its work, and it stops so a fresh one takes over (see runBridge).
 */
export const PASS_DEADLINES = { poll: 11_000, budget: 12_000, profile: 5_000, signals: 10_000, claims: 4_000, outbox: 5_000, decisions: 3_000, close: 5_000, wedged: 60_000 };
/** How long the runner waits on the room service for one claim, so a slow one delays a reply rather than the pass. */
export const CLAIM_CALL_MS = 3_000;
/** Notes the runner leaves next to the outbox for a command (`.dropped`, `.claim`) that nobody read go after this long. */
export const OUTBOX_NOTE_MS = 10 * 60_000;
export type PassDeadlines = typeof PASS_DEADLINES;
/** Thrown by runBridge when a step never finished: the process should exit, so whatever still hangs goes with it. */
export class RunnerWedged extends Error { readonly wedged = true; }
/** `work`'s value, or a rejection saying `what` didn't answer within `ms`. */
async function answerWithin<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

/**
 * This device's retractions (src/browser/retractions.ts). `save` writes the messages and `release` lets go of files only
 * deleted messages named. The log is saved first, and `apply` works from the log whatever was just added, so one saved by
 * a pass that then couldn't save the messages (a full disk) still takes effect the next time.
 */
export function retractionLog(agent: BrowserAgent, status: () => RoomStatus | undefined, save: (messages: Stored[]) => void, release: (sha256: string[]) => void,
  onRetracted?: (ids: string[]) => void) {
  const readLog = () => readJsonStrict<RetractPacket[]>(join(agent.dir, 'retractions.json'), []);
  const readMessages = () => readJsonStrict<Stored[]>(join(agent.dir, 'messages.json'), []);
  const apply = (log = readLog()) => {
    const { messages, changed, released } = applyRetractions(readMessages(), log.map(op => op.body));
    if (!changed.length) return;
    save(messages);
    // Only notify reaction cleanup for IDs that have NO remaining live copy (colliding-ID copy retraction never wipes victim reactions).
    const stillLive = new Set(messages.filter(m => !isRetracted(m)).map(m => m.packet.body.id));
    const fullyRetracted = changed.filter(id => !stillLive.has(id));
    if (fullyRetracted.length) onRetracted?.(fullyRetracted);
    release(released);
  };
  const add = (incoming: RetractPacket[]) => {
    const { log, added } = addRetractions(readLog(), incoming, readMessages());
    if (added.length) writeJson(join(agent.dir, 'retractions.json'), log);
    apply(log);
  };
  return {
    apply, add,
    /** Keep those signed by a device of their author that may still sign (see signerOf), whichever device relayed them. */
    async accept(packets: unknown[]) {
      const accepted: RetractPacket[] = [], known = new Set(readLog().map(p => opKey(p.body))), room = status();
      for (const packet of packets as RetractPacket[]) {
        const b = packet?.body;
        if (!validRetractBody(b, agent.roomId) || typeof packet.signature !== 'string') continue;
        const k = opKey(b);
        if (known.has(k)) continue;
        const author = signerOf(room, b.deviceId, b.at);
        if (!author || author.memberId !== b.memberId || !await agent.verify(author.publicKey, b, packet.signature)) continue;
        known.add(k);
        accepted.push({ body: b, signature: packet.signature });
      }
      add(accepted);
    },
    /** A message arriving after its retraction is stored as a stub, so its content never reaches the disk. */
    arriving: (stored: Stored): Stored => readLog().some(op => mayRetract(op.body, stored.packet.body)) ? retractedStub(stored) : stored,
  };
}

/**
 * Long-running peer loop: presence, signaling, data channels, storage, and outbox delivery. `pause` is how it waits
 * between passes (tests shorten it; the deadlines are what bound a pass).
 */
/**
 * Without status pushed over the relay socket, an idle runner polls the room service one pass in this many: with a
 * pass a second, about every 10 s, well inside the service's 25 s presence window.
 */
export const IDLE_POLL_EVERY = 10;
/** And never longer than this without status, however long the passes take: inside the 25 s presence window. */
export const IDLE_POLL_MS = 8_000;
/** A new peer connection gets each pass's poll for this long, for the answer and candidates it waits on. */
export const CONNECTING_POLL_MS = 10_000;
export async function runBridge(agent: BrowserAgent, log: (line: string) => void = console.error,
  options: {
    deadlines?: Partial<PassDeadlines>;
    pause?: (ms: number) => Promise<unknown>;
    /** Without pushed status, an idle runner polls one pass in this many (default IDLE_POLL_EVERY). */
    idlePollEvery?: number;
    now?: () => number;
    gatherMs?: number;
    gatherDeadlineMs?: number;
    createPeerConnection?: (config: { iceServers: { urls: string; username?: string; credential?: string }[]; iceTransportPolicy?: 'all' | 'relay' }) => RTCPeerConnection;
    /** Where network interfaces are listed (node:os); tests pass one that fails. */
    interfaces?: { networkInterfaces: typeof import('node:os').networkInterfaces };
    /** Disable or customize the optional WSS+HTTPS relay client (enabled automatically when `status.relayUrl` is advertised). */
    relay?: boolean;
    relayOptions?: Partial<RelayClientOptions>;
    /** Expected host key pin prefix (`#h=...`); falls back to `agent.hostPin` or `room.json`'s `hostPin`. */
    hostPin?: string;
    /** Optional abort signal for graceful shutdown. */
    signal?: AbortSignal;
  } = {}) {
  const deadlines: PassDeadlines = { ...PASS_DEADLINES, ...options.deadlines }, pause = options.pause ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? (() => Date.now()), gatherMs = options.gatherMs ?? 1500;
  const gatherDeadlineMs = options.gatherDeadlineMs ?? GATHER_DEADLINE_MS;
  const makePc = options.createPeerConnection ?? (config => new RTCPeerConnection(config));
  // Where interfaces can't be listed (a sandbox denying getifaddrs), connect through the room's relay only instead of
  // crashing in werift or multicast-dns (see ./interfaces).
  guardNetworkInterfaces(log, options.interfaces);
  const relayOnly = () => interfacesUnavailable(options.interfaces);
  const policy = (): { iceTransportPolicy?: 'relay' } => relayOnly() ? { iceTransportPolicy: 'relay' } : {};
  /** A remote description as werift should see it: with no interfaces, without the `.local` candidates it can't resolve. */
  const remote = <T extends { sdp?: string }>(id: string, description: T): T => {
    if (!relayOnly() || typeof description.sdp !== 'string') return description;
    const { sdp, dropped } = withoutMdnsCandidates(description.sdp);
    if (dropped) log(`relay-only: skipped ${dropped} mDNS candidate(s) from ${id.slice(0, 8)}`);
    return { ...description, sdp };
  };
  const identity = await agent.ensureIdentity();
  const session = randomUUID(); const peers = new Map<string, Peer>();
  let status: RoomStatus | undefined; let epoch = ''; let cursor = 0;
  /**
   * Room status the service pushed over the relay socket (watchStatus), not yet taken by a pass. While pushes arrive,
   * the runner polls no status at all; without them it polls one pass in IDLE_POLL_EVERY (about every 10 s), and every
   * pass only while it waits for admission, recovers from a failed poll, or sets up a peer connection.
   */
  let pushed: RoomStatus | undefined, passesSincePoll = 0;
  /** When this runner first tried to connect to each device session (`device:session`): see CONNECTING_POLL_MS. */
  const firstOffer = new Map<string, number>();
  const idlePollEvery = Math.max(1, options.idlePollEvery ?? IDLE_POLL_EVERY);
  let iceServers: RTCIceServer[] = []; let iceKey = '[]';
  let verifiedRoster: SignedRoster | undefined;
  /** Highest version of a HOST-SIGNED roster this loop verified. Never raised from envelope metadata. */
  let highestRosterVersion = 0;
  // Relay envelopes already processed (sender + id): persisted so a restart cannot be replayed, with a memory-only record for file chunks and activity.
  const relaySeenFile = join(agent.dir, 'relay-seen.json');
  const relaySeen = RelayReplayGuard.from(readJson<unknown>(relaySeenFile, undefined));
  const relaySeenVolatile = new RelayReplayGuard(8192, 4096);
  const relayInflight = new Set<string>();
  let pinnedHost: string | undefined = options.hostPin ?? agent.hostPin ?? (() => {
    try { return (JSON.parse(readFileSync(join(agent.dir, 'room.json'), 'utf8')) as { hostPin?: string }).hostPin; } catch { return undefined; }
  })();
  let relayClient: RelayClient | undefined;
  const relaySent = new Map<string, number>();
  let lastEncPublishAt = 0;
  let lastRosterPublishAt = 0;
  const retiredUfrags = new Map<string, Set<string>>();
  let pollBackoff = 0;
  let serial: Promise<unknown> = Promise.resolve();
  const transaction = <T>(work: () => Promise<T>) => { const next = serial.then(work); serial = next.catch(() => {}); return next; };
  const messagesFile = join(agent.dir, 'messages.json');
  let messagesCache: { mtimeMs: number; ctimeMs: number; size: number; ino: number; value: Stored[] } | undefined;
  const readMessages = (): Stored[] => {
    let st: { mtimeMs: number; ctimeMs: number; size: number; ino: number };
    try { st = statSync(messagesFile); } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') { messagesCache = undefined; return []; }
      throw error;
    }
    if (messagesCache && messagesCache.mtimeMs === st.mtimeMs && messagesCache.ctimeMs === st.ctimeMs
      && messagesCache.size === st.size && messagesCache.ino === st.ino) {
      return messagesCache.value;
    }
    const value = readJsonStrict<Stored[]>(messagesFile, []);
    messagesCache = { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino, value };
    return value;
  };
  const readTaskOps = () => readJsonStrict<StoredOp[]>(join(agent.dir, 'tasks.json'), []).map((p, i) => ({ ...p, seq: p.seq ?? i + 1 }));
  const readBoardCursor = (ops: StoredOp[]) => Math.max(readJsonStrict<{ seq: number }>(join(agent.dir, 'board.json'), { seq: 0 }).seq, ops.at(-1)?.seq ?? 0);
  const readDecisionOps = () => readJsonStrict<StoredDecisionOp[]>(join(agent.dir, 'decisions.json'), []);
  const readDecisionCursor = (ops: StoredDecisionOp[]) => Math.max(readJsonStrict<{ seq: number }>(join(agent.dir, 'decisions-cursor.json'), { seq: 0 }).seq, ops.at(-1)?.seq ?? 0);
  const readReactionOps = () => readJsonStrict<ReactionPacket[]>(join(agent.dir, 'reactions.json'), []);
  const readRetractOps = () => readJsonStrict<RetractPacket[]>(join(agent.dir, 'retractions.json'), []);
  const authorSeqFile = join(agent.dir, 'author-seq.json');
  const readAuthorSeq = () => readJson<{ seq?: number }>(authorSeqFile, {}).seq ?? 0;
  const saveAuthorSeq = (seq: number) => { if (seq > readAuthorSeq()) writeJson(authorSeqFile, { seq }); };
  const historyServeLimiter = new PeerRateLimiter(now, HISTORY_SERVE_PER_MINUTE, HISTORY_SERVE_BURST);
  const historyAcceptLimiter = new PeerRateLimiter(now, HISTORY_ACCEPT_ENTRIES_PER_MINUTE, HISTORY_ACCEPT_ENTRIES_BURST);
  const historyRounds = new Map<string, number>();
  const historyCursors = new Map<string, HistoryCursor>();
  const historyRoundDropped = new Set<string>();
  const historyRetryAt = new Map<string, number>();
  const historyInFlight = new Map<string, { sentAt: number; expectReply: boolean; timeouts: number }>();
  const relayHistorySynced = new Map<string, number>();
  const relayResync = new Map<string, Resync>();
  let referencedCache: Map<string, AttachmentRef> | undefined;
  const save = (messages: Stored[]) => {
    writeJson(messagesFile, messages);
    referencedCache = undefined;
    try { const st = statSync(messagesFile); messagesCache = { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino, value: messages }; }
    catch { messagesCache = undefined; }
  };
  /** Own messages a current device has not confirmed; the window never evicts them. */
  const awaiting = (m: Stored) => awaitingDelivery(m, identity.id, status?.devices && new Set(status.devices.map(d => d.id)));
  /** Append a message to the stored history, evicting the oldest past the rolling window (logged, never silent). */
  const store = (messages: Stored[], added: Stored) => {
    const { kept, evicted } = windowHistory([...messages, added], awaiting);
    save(kept);
    evictedSinceLog += evicted.length;
    if (evictedSinceLog && Date.now() - evictionLogged > 60_000) {
      log(`history window full: evicted ${evictedSinceLog} oldest message${evictedSinceLog === 1 ? '' : 's'} (keeping ${kept.length})`);
      evictedSinceLog = 0; evictionLogged = Date.now();
    }
    return kept.at(-1) === added;
  };
  let evictedSinceLog = 0, evictionLogged = 0;
  /** When a channel to another device first opened: the room's history and state arrive right after. */
  let syncedAt: number | undefined;
  /** Append verified operations at the next cursors; a large board is compacted like a browser's, without moving the cursor. */
  const storeOps = (ops: StoredOp[], added: TaskPacket[]) => {
    let seq = readBoardCursor(ops);
    // Each member keeps their oldest MAX_LIVE_TASKS_PER_MEMBER live tasks over everything held, as browsers do (capLiveTasks).
    let next: StoredOp[] = capLiveTasks([...ops, ...added.map(p => ({ ...p, seq: ++seq }))]);
    if (next.length > COMPACT_AT) { writeJson(join(agent.dir, 'board.json'), { seq }); next = compactBoard(next); }
    writeJson(join(agent.dir, 'tasks.json'), next);
  };
  /** Keep a task operation signed by a current device of its author; duplicates and a full board are ignored. */
  const acceptOps = async (packets: unknown[]) => {
    const ops = readTaskOps(); const known = new Set(ops.map(p => p.body.id)); const added: TaskPacket[] = [];
    for (const packet of packets as TaskPacket[]) {
      const b = packet?.body;
      if (ops.length + added.length >= MAX_TASK_OPS) break;
      if (!validTaskBody(b, agent.roomId) || known.has(b.id) || typeof packet.signature !== 'string') continue;
      // A change by someone who has since left still verifies against the key the room service keeps for them (see signerOf).
      const author = signerOf(status, b.deviceId, b.at);
      if (!author || author.memberId !== b.memberId || !await agent.verify(author.publicKey, b, packet.signature)) continue;
      known.add(b.id); added.push({ body: b, signature: packet.signature });
    }
    // Revisions stay within MAX_REVISION_JUMP of pre-batch held state; storeOps applies the live-task cap.
    const kept = withinRevisionJump(ops.map(p => p.body), added);
    if (kept.length) storeOps(ops, kept);
  };
  const storeDecisionOps = (added: DecisionPacket[]) => {
    const ops = readDecisionOps(); let seq = readDecisionCursor(ops);
    let next: StoredDecisionOp[] = [...ops, ...added.map(p => ({ ...p, seq: ++seq }))];
    if (next.length > COMPACT_DECISIONS_AT) { writeJson(join(agent.dir, 'decisions-cursor.json'), { seq }); next = compactDecisionLog(agent, next, status?.memberId); }
    writeJson(join(agent.dir, 'decisions.json'), next);
  };
  // A log that filled up before compaction existed (or before this agent upgraded) is compacted before anything is refused.
  try { compactStoredDecisions(agent, agent.members().memberId); } catch (error) { log(`decisions: ${error instanceof Error ? error.message : String(error)}`); }
  /** Keep decision and vote operations signed by a (current or former) device of their author; duplicates are ignored. */
  const acceptDecisionOps = async (packets: unknown[]) => {
    const ops = compactStoredDecisions(agent, status?.memberId);
    const added = await admitDecisionPackets(ops.map(p => p.body), packets, agent.roomId, async (b, signature) => {
      const author = signerOf(status, b.deviceId, b.at);
      return !!author && author.memberId === b.memberId && await agent.verify(author.publicKey, b, signature);
    });
    if (added.length) storeDecisionOps(added);
  };
  const shareDecisionOp = async (body: DecisionBody | VoteBody) => {
    // This device's own changes obey the same per-member share as everyone's, or peers would drop them.
    const held = compactStoredDecisions(agent, status?.memberId);
    if (held.length >= MAX_DECISION_OPS) throw new Error('This room has reached its limit of decision changes.');
    if (!admissible(held.map(p => p.body), [body]).length) throw new Error('This agent has reached its share of decision changes in this room.');
    const packet = { body, signature: await agent.sign(body) };
    storeDecisionOps([packet]);
    broadcast(packet);
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
    // Each member keeps their newest MAX_REACTION_KEYS_PER_MEMBER live reactions over everything held, as browsers do.
    let next = capReactions([...ops, ...added]);
    if (next.length > COMPACT_REACTIONS_AT) next = compactReactions(next);
    if (next.length > MAX_REACTION_OPS) return false;
    writeJson(join(agent.dir, 'reactions.json'), next);
    return true;
  };
  /** Keep verified reactions for live held messages; retracted messages take none and are not parked; unknown messages stay pending until stored. */
  const addReactionOps = (incoming: ReactionPacket[]) => {
    const messages = readMessages();
    const held = new Set(messages.filter(m => !isRetracted(m)).map(m => m.packet.body.id));
    const retractedIds = new Set(messages.filter(m => isRetracted(m) && !held.has(m.packet.body.id)).map(m => m.packet.body.id));
    const ops = readReactionOps();
    const known = new Set([...ops.map(p => opKey(p.body)), ...pendingReactions.map(p => opKey(p.body))]);
    let ready: ReactionPacket[] = [];
    for (const op of incoming) {
      const k = opKey(op.body);
      if (known.has(k) || retractedIds.has(op.body.messageId)) continue;
      known.add(k);
      if (held.has(op.body.messageId)) ready.push(op);
      else if (mayHoldPending(pendingReactions, op)) pendingReactions.push(op);
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
    const known = new Set([...readReactionOps().map(p => opKey(p.body)), ...pendingReactions.map(p => opKey(p.body))]);
    for (const packet of packets as ReactionPacket[]) {
      const b = packet?.body;
      if (!validReactionBody(b, agent.roomId) || typeof packet.signature !== 'string') continue;
      const k = opKey(b);
      if (known.has(k)) continue;
      const author = signerOf(status, b.deviceId, b.at);
      if (!author || author.memberId !== b.memberId || !await agent.verify(author.publicKey, b, packet.signature)) continue;
      known.add(k);
      accepted.push({ body: b, signature: packet.signature });
    }
    if (accepted.length) addReactionOps(accepted);
  };
  /**
   * Files named by verified messages, cached in memory and invalidated on every `messages.json` write so incoming
   * `file-want` packets never re-read and re-parse the message log synchronously.
   */
  const referenced = () => referencedCache ??= new Map(agent.messages().flatMap(m => m.packet.body.attachments || []).map(ref => [ref.sha256, ref]));
  const fileWantLimiter = new FileWantLimiter();
  let transfersDirty = true;
  const hasLiveWebRtc = (id: string) => {
    const p = peers.get(id);
    return !!p && isLiveOpenPeer(p.pc.connectionState, p.pc.iceConnectionState, p.channel?.readyState);
  };
  const signerFor = (deviceId: unknown, at: unknown, fromRelay: boolean, expectedMemberId?: unknown): { publicKey: string; memberId: string } | undefined => {
    if (verifiedRoster) {
      const active = verifiedRoster.body.devices.find(d => d.id === deviceId);
      if (active) {
        if (expectedMemberId !== undefined && active.memberId !== expectedMemberId) {
          const statusDev = status?.devices?.find(d => d.id === deviceId);
          const prior = statusDev?.priorMembers?.find(p =>
            p.memberId === expectedMemberId && (p.retiredAt === undefined || (typeof at === 'number' && at <= p.retiredAt)));
          if (prior) return { publicKey: active.sign, memberId: prior.memberId };
        }
        return { publicKey: active.sign, memberId: active.memberId };
      }
      const removed = verifiedRoster.body.removed.find(r => r.id === deviceId);
      if (removed?.revoked) return undefined;
      if (fromRelay) {
        const former = status?.formerDevices?.find(d => d.id === deviceId);
        if (!former || former.revoked) return undefined;
        return former.retiredAt === undefined || (typeof at === 'number' && at <= former.retiredAt) ? former : undefined;
      }
    }
    if (fromRelay) return undefined;
    return signerOf(status, deviceId, at, expectedMemberId);
  };
  const relayRecipients = (targetIds?: readonly string[]): RosterEntry[] => {
    if (!verifiedRoster) return [];
    const filter = targetIds ? new Set(targetIds) : undefined;
    return verifiedRoster.body.devices.filter(entry =>
      entry.id !== identity.id
      && (!filter || filter.has(entry.id))
      && !hasLiveWebRtc(entry.id));
  };
  const sendViaRelay = (packet: unknown, lane: RelayLane, targetIds?: readonly string[]) => {
    if (!relayClient || !verifiedRoster) return;
    const recipients = relayRecipients(targetIds);
    if (!recipients.length) return;
    const meta = lane === 'primary'
      ? computeRelayWakeMeta(packet, recipients, verifiedRoster, status, readMessages(), now)
      : {};
    try {
      relayClient.enqueuePacket(packet, {
        rosterVersion: verifiedRoster.body.version,
        lane,
        recipients,
        ...meta,
      });
    } catch (error) {
      log(`relay enqueue (${lane}): ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const relayFileChannel = (targetId: string) => ({
    get readyState() { return relayClient?.isConnected() ? 'open' : 'closed'; },
    get bufferedAmount() { return relayClient?.currentFileInFlightBytes ?? 0; },
    send(data: string) {
      try { sendViaRelay(JSON.parse(data), 'file', [targetId]); } catch { /* Ignore unparseable data. */ }
    },
  }) as unknown as RTCDataChannel;
  const transfers = new FileTransfers({
    roomId: agent.roomId,
    store: agent.files,
    referenced: (sha, peer) => {
      if (!peer) return referenced().get(sha);
      // Attachments follow message visibility: serve only when referenced by a message `peer` is authorized to see.
      for (const m of readMessages()) {
        if (!mayServeMessage(m, peer, status, status?.memberId, verifiedRoster)) continue;
        const match = m.packet.body.attachments?.find(a => a.sha256 === sha);
        if (match) return match;
      }
      return undefined;
    },
    now,
    channel: id => {
      const p = peers.get(id);
      if (p?.fileChannel?.readyState === 'open') return p.fileChannel;
      if (p?.channel?.readyState === 'open') return p.channel;
      if (relayClient?.isConnected() && verifiedRoster?.body.devices.some(d => d.id === id)) return relayFileChannel(id);
      return undefined;
    },
    changed: () => { transfersDirty = true; },
    peers: () => {
      const set = new Set<string>();
      for (const [id, p] of peers) {
        if ((p.fileChannel?.readyState === 'open' || p.channel?.readyState === 'open') && status?.devices?.some(d => d.id === id)) set.add(id);
      }
      if (relayClient?.isConnected() && verifiedRoster) {
        for (const entry of verifiedRoster.body.devices) {
          if (entry.id !== identity.id && status?.devices?.some(d => d.id === entry.id && d.session)) set.add(entry.id);
        }
      }
      return [...set];
    } });
  const retractions = retractionLog(agent, () => status, save, released => {
    const gone = new Set(released);
    transfers.keep(sha => !gone.has(sha));
    for (const sha of released) for (const path of [agent.files.path(sha), join(agent.dir, 'wants', sha)]) {
      try { rmSync(path, { force: true }); } catch { /* In use: `prune` removes it, since no message names it now. */ }
    }
  }, ids => {
    const retracted = new Set(ids);
    pendingReactions = pendingReactions.filter(op => !retracted.has(op.body.messageId));
    // A deleted message's reactions go too, so they count toward nobody's cap here or on a device that joins later.
    const ops = readReactionOps(), kept = ops.filter(op => !retracted.has(op.body.messageId));
    if (kept.length !== ops.length) writeJson(join(agent.dir, 'reactions.json'), kept);
  });
  // A runner that stopped between saving the log and the messages is finished here.
  try { retractions.apply(); } catch (error) { log(`retractions: ${error instanceof Error ? error.message : String(error)}`); }
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
    let held: Stored[];
    try { held = readMessages(); } catch (error) { log(`prune: ${error instanceof Error ? error.message : String(error)}`); return; }
    const keep = retainedFiles(held.map(m => m.packet.body.attachments), undefined, undefined, held.map(m => m.packet.body.memberId));
    for (const name of readdirSync(join(agent.dir, 'files'))) {
      const path = join(agent.dir, 'files', name);
      try { if (!keep.has(name) && !wanted.has(name) && Date.now() - statSync(path).mtimeMs > FILE_GRACE_MS) unlinkSync(path); } catch { /* Raced with another prune or a write. */ }
    }
  };

  const activity = activityAnnouncer(agent, () => [...peers.values()].map(p => p.channel));
  /** A person device's view of its agents: their latest activity per device with an open channel (see PERSON_STATUS_FILE). */
  const heard = new Map<string, ActivityRecord>();
  let shownStatus = '';
  /** Rewrites the person's status file only when what it says changed, so the local API's feed hears of real changes. */
  const keepStatus = (next: RoomStatus) => {
    const open = [...peers].filter(([id, p]) => p.channel?.readyState === 'open' && next.devices?.some(d => d.id === id)).map(([id]) => id);
    const text = JSON.stringify(personStatusOf(next, open, Object.fromEntries([...heard].filter(([id]) => open.includes(id)))));
    if (text === shownStatus) return;
    try { replaceFile(join(agent.dir, PERSON_STATUS_FILE), text); shownStatus = text; } catch { /* Written again next pass. */ }
  };
  /**
   * `loopAt`: when the loop last came round, which is what says the runner still works. `polledAt`: when the room service
   * last answered. `failingSince`/`failure`: it hasn't since then, and why (see RUNNER_ALIVE).
   */
  const startedAt = Date.now();
  let loopAt = startedAt, polledAt: number | undefined, failingSince: number | undefined, failure: string | undefined, failureStatus: number | undefined, upgradeRequired = false;
  /** Since when the room service has answered that this device is no longer in the room, after it was (see RUNNER_ALIVE). */
  let removedSince: number | undefined;
  /** True while intentionally sleeping between passes (e.g. 60 s HTTP 426 backoff) so `loopAt` does not look wedged. */
  let sleeping = false;
  /**
   * Proof of life for commands that can't inspect processes (a harness sandbox denies it), so they don't start a second
   * runner. Written every second by the ticker rather than once per pass, so a long pass never makes the process look
   * gone; whether its loop still comes round is `loopAt`.
   */
  const prove = () => {
    try {
      writeJson(join(agent.dir, RUNNER_ALIVE), { pid: process.pid, at: Date.now(), startedAt, loopAt, ...(polledAt ? { polledAt } : {}),
        ...(failingSince ? { failingSince, failure, ...(failureStatus !== undefined ? { failureStatus } : {}) } : {}),
        ...(upgradeRequired ? { upgradeRequired: true } : {}), ...(syncedAt ? { syncedAt } : {}),
        ...(removedSince ? { removedSince } : {}) });
    } catch { /* Written again next second. */ }
  };
  prove();
  const ticking = setInterval(() => { if (sleeping) loopAt = Date.now(); prove(); activity.tick(); }, 1000);

  const flush = () => {
    const messages = agent.messages();
    const at = Date.now();
    // WebRTC-first: send directly on live open WebRTC DataChannels.
    flushOutbox(messages, identity.id, peers, log, at);
    // Relay fallback: only for verified-roster targets that do NOT have a live WebRTC channel.
    if (relayClient?.isConnected() && verifiedRoster) {
      let sent = 0;
      for (const m of messages) {
        if (sent >= 16) break;
        const messageId = m.packet.body.id;
        if (m.packet.body.deviceId !== identity.id) continue;
        if (at - (relaySent.get(messageId) ?? 0) < 5000) continue;
        const pending = m.targets.filter(id => !m.receipts.includes(id));
        if (!pending.length) continue;
        const recipients = relayRecipients(pending);
        if (!recipients.length) continue;
        sendViaRelay(m.packet, 'primary', recipients.map(r => r.id));
        relaySent.set(messageId, at);
        sent++;
      }
      if (relaySent.size > 4096) relaySent.clear();
    }
  };
  /** Send one signed operation to every open WebRTC channel AND via E2E relay to non-WebRTC verified-roster peers. */
  const broadcast = (packet: unknown) => {
    const text = JSON.stringify(packet);
    for (const [id, peer] of peers) if (hasLiveWebRtc(id) && peer.channel?.readyState === 'open') {
      try { peer.channel.send(text); } catch (error) { log(`send to ${id.slice(0, 8)} failed: ${(error as Error).message}`); }
    }
    sendViaRelay(packet, 'primary');
  };
  /** This agent's board, decisions, reactions and retractions, paced onto the peer's channel. */
  const sendState = (peer: Peer) => {
    if (!peer.queue) return;
    const chunks = [
      ...syncChunks(agent.roomId, agent.taskOps().map(({ body, signature }) => ({ body, signature }))),
      ...decisionChunks(agent.roomId, agent.decisionOps().map(({ body, signature }) => ({ body, signature }))),
      ...reactionSyncChunks(agent.roomId, agent.reactionOps()),
      ...retractionSyncChunks(agent.roomId, agent.retractOps()),
    ];
    if (!chunks.length) return;
    peer.resync.sent();
    if (!peer.queue.push(chunks.map(chunk => JSON.stringify(chunk)))) log('sync queue full; state is exchanged again on the next request');
  };
  /** Advertises this agent's held message history so the peer can serve anything missing. */
  const sendHistoryHave = (peerId: string, peer: Peer, cursor?: HistoryCursor, expectReply = false) => {
    sendHistoryHaveTo(peerId, cursor, peer, expectReply, 0);
  };
  const sendHistoryPackets = (peerId: string, packets: (HistoryHavePacket | HistoryPacket)[], peer?: Peer): boolean => {
    const active = peer ?? peers.get(peerId);
    if (active?.queue && hasLiveWebRtc(peerId) && active.channel?.readyState === 'open') {
      return active.queue.push(packets.map(p => JSON.stringify(p)));
    }
    if (relayClient?.isConnected() && verifiedRoster?.body.devices.some(d => d.id === peerId)) {
      for (const packet of packets) sendViaRelay(packet, 'primary', [peerId]);
      return true;
    }
    return false;
  };
  const scheduleHistoryRetry = (peerId: string, delayMs: number) => {
    const clamped = Math.max(250, Math.min(30_000, delayMs));
    const dueAt = now() + clamped;
    const prev = historyRetryAt.get(peerId);
    if (prev === undefined || dueAt < prev) historyRetryAt.set(peerId, dueAt);
  };
  const sendHistoryHaveTo = (peerId: string, cursor: HistoryCursor | undefined, peer: Peer | undefined, expectReply: boolean, timeouts = 0): boolean => {
    const have = buildHistoryHave(agent.roomId, readMessages(), cursor ? { cursor } : undefined);
    const active = peer ?? peers.get(peerId);
    const isWebRtc = !!(active?.queue && hasLiveWebRtc(peerId) && active.channel?.readyState === 'open');
    const sent = sendHistoryPackets(peerId, [have], active);
    if (!sent) {
      if (isWebRtc) scheduleHistoryRetry(peerId, 1_500);
      return false;
    }
    if (!isWebRtc) relayHistorySynced.set(peerId, now());
    historyInFlight.set(peerId, { sentAt: now(), expectReply, timeouts });
    return true;
  };
  const flushHistoryRetries = () => {
    const at = now();
    for (const [peerId, dueAt] of [...historyRetryAt]) {
      if (at < dueAt) continue;
      historyRetryAt.delete(peerId);
      historyRoundDropped.delete(peerId);
      sendHistoryHaveTo(peerId, historyCursors.get(peerId), undefined, true, 0);
    }
    for (const [peerId, pending] of [...historyInFlight]) {
      if (!pending.expectReply || historyRetryAt.has(peerId)) continue;
      const waitMs = Math.min(30_000, HISTORY_ROUND_TIMEOUT_MS * (pending.timeouts + 1));
      if (at - pending.sentAt < waitMs) continue;
      if (pending.timeouts + 1 > MAX_HISTORY_ROUND_TIMEOUTS) {
        historyInFlight.delete(peerId);
        continue;
      }
      historyRoundDropped.delete(peerId);
      if (!sendHistoryHaveTo(peerId, historyCursors.get(peerId), undefined, true, pending.timeouts + 1)) {
        if (!historyRetryAt.has(peerId)) historyInFlight.delete(peerId);
      }
    }
  };
  const syncHistoryViaRelay = () => {
    if (!relayClient?.isConnected() || !verifiedRoster) return;
    const at = now();
    for (const entry of verifiedRoster.body.devices) {
      if (entry.id === identity.id || hasLiveWebRtc(entry.id)) continue;
      if (!status?.devices?.some(d => d.id === entry.id && d.session)) {
        relayHistorySynced.delete(entry.id);
        continue;
      }
      if (historyRetryAt.has(entry.id)) continue;
      const lastSent = relayHistorySynced.get(entry.id);
      if (lastSent !== undefined && at - lastSent < RELAY_HISTORY_RETRY_MS) continue;
      historyRounds.set(entry.id, 0);
      historyRoundDropped.delete(entry.id);
      sendHistoryHaveTo(entry.id, historyCursors.get(entry.id), undefined, historyCursors.has(entry.id), 0);
    }
  };
  const serveHistory = (peerId: string, have: HistoryHavePacket, peer?: Peer) => {
    if (!status?.memberId) return;
    if (!historyServeLimiter.take(peerId)) {
      if (historyServeLimiter.report(peerId)) log(`over history-have quota: dropping history requests from ${peerId.slice(0, 8)}`);
      if (historyServeLimiter.maySendRetryHint(peerId)) {
        sendHistoryPackets(peerId, [{ kind: 'history', roomId: agent.roomId, entries: [], retryAfterMs: historyServeLimiter.retryAfterMs(peerId) }], peer);
      }
      return;
    }
    const { entries, more, nextCursor } = selectHistoryEntries(readMessages(), have, peerId, status, status.memberId, undefined, verifiedRoster);
    if (!entries.length) {
      if (have.cursor) sendHistoryPackets(peerId, [{ kind: 'history', roomId: agent.roomId, entries: [], done: true }], peer);
      return;
    }
    sendHistoryPackets(peerId, historyChunks(agent.roomId, entries, more, nextCursor), peer);
  };
  const acceptHistory = async (fromPeerId: string, packet: HistoryPacket, fromRelay: boolean, peer?: Peer) => {
    if (packet.retryAfterMs !== undefined && packet.entries.length === 0) {
      const pending = historyInFlight.get(fromPeerId);
      if (!pending || now() - pending.sentAt > 60_000) return;
      historyInFlight.delete(fromPeerId);
      scheduleHistoryRetry(fromPeerId, packet.retryAfterMs);
      return;
    }
    if (fromRelay) relayHistorySynced.set(fromPeerId, now());
    const cost = Math.max(1, packet.entries.length);
    if (!historyAcceptLimiter.take(fromPeerId, cost)) {
      if (historyAcceptLimiter.report(fromPeerId)) log(`over history-accept quota: dropping history entries from ${fromPeerId.slice(0, 8)}`);
      historyRoundDropped.add(fromPeerId);
      historyInFlight.delete(fromPeerId);
      quotaDrops.drop(fromPeerId);
      return;
    }
    const messages = readMessages();
    const held = new Set(messages.map(m => messageKey(m.packet.body.deviceId, m.packet.body.id)));
    const baseMaxSeq = maxSeqByDevice(messages);
    const batchAnchor = new Map<string, number>();
    const accepted: Stored[] = [];
    let droppedByQuota = false;
    for (const entry of packet.entries) {
      const b = entry?.body;
      if (!b || b.kind !== 'message' || b.roomId !== agent.roomId || typeof b.id !== 'string' || !UUID.test(b.id) || typeof b.deviceId !== 'string') continue;
      const key = messageKey(b.deviceId, b.id);
      if (held.has(key)) continue;
      if (typeof entry.signature !== 'string') continue;
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at) || b.at < 0 || b.at > MAX_TIME) continue;
      if (b.replyTo !== undefined && (typeof b.replyTo !== 'string' || !UUID.test(b.replyTo))) continue;
      if (b.attachments !== undefined && !validAttachments(b.attachments)) continue;
      if (!validMessageVisibility(b.visibility) || !validMessageSeq(b.seq) || !validAudienceUntil(b.audienceUntil)) continue;
      const maxHeld = baseMaxSeq.get(b.deviceId) ?? batchAnchor.get(b.deviceId) ?? 0;
      if (!withinSeqJump(b.seq, maxHeld)) continue;
      const author = signerFor(b.deviceId, b.at, fromRelay, b.memberId);
      if (!author || b.memberId !== author.memberId) continue;
      if (!await agent.verify(author.publicKey, b, entry.signature)) continue;
      if (!allowed(b.memberId, 'history', fromPeerId)) {
        droppedByQuota = true;
        historyRoundDropped.add(fromPeerId);
        continue;
      }
      held.add(key);
      if (typeof b.seq === 'number' && !baseMaxSeq.has(b.deviceId) && !batchAnchor.has(b.deviceId)) batchAnchor.set(b.deviceId, b.seq);
      const arrived = retractions.arriving({ packet: { body: b, signature: entry.signature }, targets: [], receipts: [], receivedAt: Date.now(), replicated: true });
      accepted.push(arrived);
    }
    let windowUnchanged = false;
    if (accepted.length) {
      const { messages: merged, added } = mergeHistoryMessages(messages, accepted);
      if (added.length) {
        const { kept } = windowHistory(merged, awaiting);
        const changed = kept.length !== messages.length || kept.some((m, i) => m !== messages[i]);
        if (changed) {
          save(kept);
          const keptSet = new Set(kept);
          const liveIds = new Set(kept.filter(m => !isRetracted(m)).map(m => m.packet.body.id));
          for (const m of added) {
            if (!keptSet.has(m)) continue;
            if (isRetracted(m)) {
              if (!liveIds.has(m.packet.body.id)) pendingReactions = pendingReactions.filter(op => op.body.messageId !== m.packet.body.id);
            } else flushPendingReactions(m.packet.body.id);
          }
        } else {
          windowUnchanged = true;
        }
      }
    }
    if (packet.more) {
      if (droppedByQuota || historyRoundDropped.has(fromPeerId)) {
        historyInFlight.delete(fromPeerId);
        quotaDrops.drop(fromPeerId);
      } else if (windowUnchanged && readMessages().length >= MAX_STORED_MESSAGES) {
        historyCursors.delete(fromPeerId);
        historyInFlight.delete(fromPeerId);
      } else {
        if (packet.nextCursor) historyCursors.set(fromPeerId, packet.nextCursor);
        const rounds = (historyRounds.get(fromPeerId) ?? 0) + 1;
        if (rounds <= MAX_HISTORY_ROUNDS) {
          historyRounds.set(fromPeerId, rounds);
          sendHistoryHaveTo(fromPeerId, historyCursors.get(fromPeerId), peer, true, 0);
        } else {
          historyInFlight.delete(fromPeerId);
        }
      }
    } else if (packet.done && !droppedByQuota && !historyRoundDropped.has(fromPeerId)) {
      historyCursors.delete(fromPeerId);
      historyInFlight.delete(fromPeerId);
    } else if (!droppedByQuota && !historyRoundDropped.has(fromPeerId) && packet.entries.length > 0 && historyInFlight.has(fromPeerId)) {
      historyInFlight.set(fromPeerId, { sentAt: now(), expectReply: true, timeouts: 0 });
    }
  };
  const resyncDue = (peer: Peer) => { if (peer.queue && peer.resync.due(peer.queue)) sendState(peer); };
  /** Packets waiting for the serialized handler are bounded (SEC-6); peers that lost some are asked for their state again. */
  const gate = new IncomingGate();
  const requestSync = (id: string) => {
    const peer = peers.get(id);
    const channel = peer?.channel;
    const request: SyncRequest = { kind: SYNC_REQUEST, roomId: agent.roomId };
    if (channel?.readyState === 'open') {
      try { channel.send(JSON.stringify(request)); } catch { /* Asked again after the next drop, or exchanged on reconnect. */ }
    } else if (relayClient?.isConnected() && verifiedRoster?.body.devices.some(d => d.id === id)) {
      sendViaRelay(request, 'primary', [id]);
    }
    if (historyRetryAt.has(id)) return;
    historyRoundDropped.delete(id);
    sendHistoryHaveTo(id, historyCursors.get(id), peer, true, 0);
  };
  let droppedLogged = 0;
  /** Live packets per member and kind (DEC-6); over-quota packets are dropped unstored, unrelayed and unconfirmed. */
  const quota = new ReceiveQuota(now);
  /** Peers whose task, decision, reaction or history operations went over quota; asked for their state again after the burst. */
  const quotaDrops = new QuotaDrops(now);
  /** A dropped message is sent again by its sender; for other kinds the peer `from` is asked for its state later. */
  const allowed = (memberId: string, kind: QuotaKind, from: string) => {
    if (quota.take(memberId, kind)) return true;
    if (quota.report(memberId, kind)) log(`over receive quota: dropping ${kind} packets from member ${memberId.slice(0, 8)}`);
    if (kind !== 'message') quotaDrops.drop(from);
    return false;
  };
  /** A live operation this device does not hold yet, which counts against its sender's quota (keyed by deviceId:id when available). */
  const fresh = (held: { body: { id: string; deviceId?: string } }[], packet: Packet) => {
    const body = packet?.body as { id?: unknown; deviceId?: unknown } | undefined;
    if (typeof body?.deviceId === 'string' && typeof body?.id === 'string') {
      return !held.some(p => (p.body.deviceId ? p.body.deviceId === body.deviceId && p.body.id === body.id : p.body.id === body.id));
    }
    return !held.some(p => p.body.id === body?.id);
  };
  const expandIceServers = (servers: RTCIceServer[]) => servers.flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls])
    .map(urls => ({ urls, username: s.username, credential: s.credential as string | undefined })));
  const healthOf = (peer: Peer, at = now()) => {
    const state: PeerHealthState = {
      connectionState: peer.pc.connectionState,
      iceConnectionState: peer.pc.iceConnectionState,
      channelState: peer.channel?.readyState,
      started: peer.started,
      openedOnce: peer.openedOnce,
      unhealthySince: peer.unhealthySince,
    };
    const verdict = evaluatePeerHealth(state, at);
    peer.openedOnce = state.openedOnce;
    peer.unhealthySince = state.unhealthySince;
    return verdict;
  };
  const retireUfrag = (id: string, peerSession: string, ufrag: string | undefined) => {
    if (!ufrag) return;
    const key = `${id}:${peerSession}`;
    let set = retiredUfrags.get(key);
    if (!set) { set = new Set(); retiredUfrags.set(key, set); }
    set.add(ufrag);
    if (set.size > 32) set.delete(set.values().next().value!);
  };
  const sendReceipt = async (toId: string, messageId: string, channel?: RTCDataChannel) => {
    const receipt: ReceiptBody = { kind: 'receipt', roomId: agent.roomId, id: messageId, deviceId: identity.id };
    const signed = { body: receipt, signature: await agent.sign(receipt) };
    if (channel && channel.readyState === 'open') {
      try { channel.send(JSON.stringify(signed)); return; } catch { /* Fall through to relay. */ }
    }
    const peer = peers.get(toId);
    if (hasLiveWebRtc(toId) && peer?.channel?.readyState === 'open') {
      try { peer.channel.send(JSON.stringify(signed)); return; } catch { /* Fall through to relay. */ }
    }
    sendViaRelay(signed, 'primary', [toId]);
  };
  const handlePacket = (
    id: string,
    packet: Packet,
    fromRelay: boolean,
    peer?: Peer,
    channel?: RTCDataChannel,
    relayMeta?: { cursor?: number; replay?: { from: string; id: string } },
  ): Promise<void> | undefined => {
    // File transfers bypass the serialized queue: chunks arrive by the hundred and are cheap to check.
    if (isFilePacket(packet)) {
      const authorized = fromRelay
        ? !!verifiedRoster?.body.devices.some(d => d.id === id)
        : peers.get(id) === peer && !!status?.devices?.some(d => d.id === id);
      if (authorized) {
        if ((packet as { kind?: unknown }).kind === 'file-want' && !fileWantLimiter.take(id)) {
          if (fileWantLimiter.report(id)) log(`over file-want quota: dropping file-want packets from ${id.slice(0, 8)}`);
          return;
        }
        transfers.handle(id, packet);
        if (relayMeta?.cursor !== undefined) relayClient?.ackCursor(relayMeta.cursor);
      }
      return;
    }
    // For people's rosters; agents learn nothing from each other's activity. A person device keeps it for its page.
    if (isActivityPacket(packet)) {
      const authorized = fromRelay ? !!verifiedRoster?.body.devices.some(d => d.id === id) : peers.get(id) === peer;
      if (agent.person && authorized && validActivityPacket(packet, agent.roomId)) heard.set(id, receiveActivity(packet));
      if (authorized && relayMeta?.cursor !== undefined) relayClient?.ackCursor(relayMeta.cursor);
      return;
    }
    // Cheap and never queued: answered from the loop, at most once per interval (WebRTC or verified-roster relay).
    if (isSyncRequest(packet, agent.roomId)) {
      if (!fromRelay && peer && peers.get(id) === peer && status?.devices?.some(d => d.id === id)) { peer.resync.request(); resyncDue(peer); }
      else if (fromRelay && verifiedRoster?.body.devices.some(d => d.id === id)) {
        let limiter = relayResync.get(id);
        if (!limiter) { limiter = new Resync(); relayResync.set(id, limiter); if (relayResync.size > 512) relayResync.delete(relayResync.keys().next().value!); }
        limiter.request();
        if (limiter.due({ pending: 0 } as SendQueue)) {
          limiter.sent();
          for (const chunk of [
            ...syncChunks(agent.roomId, agent.taskOps().map(({ body, signature }) => ({ body, signature }))),
            ...decisionChunks(agent.roomId, agent.decisionOps().map(({ body, signature }) => ({ body, signature }))),
            ...reactionSyncChunks(agent.roomId, agent.reactionOps()),
            ...retractionSyncChunks(agent.roomId, agent.retractOps()),
          ]) sendViaRelay(chunk, 'primary', [id]);
        }
        if (relayMeta?.cursor !== undefined) relayClient?.ackCursor(relayMeta.cursor);
      }
      return;
    }
    if (!gate.admit(id)) {
      if (Date.now() - droppedLogged > 60_000) { log(`incoming backlog full: dropping packets from ${id.slice(0, 8)}; will ask for its state again`); droppedLogged = Date.now(); }
      return;
    }
    return transaction(async () => {
      if (!fromRelay && peer && peers.get(id) !== peer) return false;
      const device = fromRelay
        ? (() => {
            const entry = verifiedRoster?.body.devices.find(d => d.id === id);
            return entry ? { id: entry.id, publicKey: entry.sign, memberId: entry.memberId } : undefined;
          })()
        : status?.devices?.find(d => d.id === id);
      if (!device) return false;
      const sync = packet as unknown as BoardSync;
      if (sync?.kind === 'board') { if (sync.roomId === agent.roomId && Array.isArray(sync.ops) && sync.ops.length <= 500) await acceptOps(sync.ops); return true; }
      if ((packet?.body as { kind?: string })?.kind === 'task') {
        if ((packet?.body as { deviceId?: string })?.deviceId !== id) return false;
        if (!fresh(readTaskOps(), packet) || allowed(device.memberId, 'task', id)) await acceptOps([packet]);
        return true;
      }
      const decisions = packet as unknown as DecisionSync;
      if (decisions?.kind === 'decisions') { if (decisions.roomId === agent.roomId && Array.isArray(decisions.ops) && decisions.ops.length <= 500) await acceptDecisionOps(decisions.ops); return true; }
      if (['decision', 'vote'].includes((packet?.body as { kind?: string })?.kind ?? '')) {
        if ((packet?.body as { deviceId?: string })?.deviceId !== id) return false;
        if (!fresh(readDecisionOps(), packet) || allowed(device.memberId, 'decision', id)) await acceptDecisionOps([packet]);
        return true;
      }
      const reactions = packet as unknown as { kind?: string; roomId?: string; ops?: unknown };
      if (reactions?.kind === 'reactions') { if (reactions.roomId === agent.roomId && Array.isArray(reactions.ops) && reactions.ops.length <= 500) await acceptReactions(reactions.ops); return true; }
      if ((packet?.body as { kind?: string })?.kind === 'reaction') {
        if ((packet?.body as { deviceId?: string })?.deviceId !== id) return false;
        if (!fresh([...readReactionOps(), ...pendingReactions], packet) || allowed(device.memberId, 'reaction', id)) await acceptReactions([packet]);
        return true;
      }
      const retracted = packet as unknown as RetractionSync;
      if (retracted?.kind === 'retractions') { if (retracted.roomId === agent.roomId && Array.isArray(retracted.ops) && retracted.ops.length <= 500) await retractions.accept(retracted.ops); return true; }
      if ((packet?.body as { kind?: string })?.kind === 'retract') {
        if ((packet?.body as { deviceId?: string })?.deviceId !== id) return false;
        if (!fresh(readRetractOps(), packet) || allowed(device.memberId, 'retract', id)) await retractions.accept([packet]);
        return true;
      }
      if (isHistoryHavePacket(packet, agent.roomId)) { serveHistory(id, packet, peer); return true; }
      if (isHistoryPacket(packet, agent.roomId)) { await acceptHistory(id, packet, fromRelay, peer); return true; }
      const b = packet?.body;
      if (!b || b.roomId !== agent.roomId || b.deviceId !== id || typeof b.id !== 'string' || !UUID.test(b.id)
        || typeof packet.signature !== 'string' || !await agent.verify(device.publicKey, b, packet.signature)) return false;
      if (b.kind === 'message') {
        if (b.memberId !== device.memberId || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at) || b.at < 0 || b.at > MAX_TIME) return false;
        if (b.replyTo !== undefined && (typeof b.replyTo !== 'string' || !UUID.test(b.replyTo))) return false;
        if (b.attachments !== undefined && !validAttachments(b.attachments)) return false;
        if (!validMessageVisibility(b.visibility) || !validMessageSeq(b.seq) || !validAudienceUntil(b.audienceUntil)) return false;
        const messages = readMessages(); const existing = messages.find(m => m.packet.body.deviceId === b.deviceId && m.packet.body.id === b.id);
        // A stub no longer matches the original its sender may still be retrying, and it only needs confirming.
        if (existing && !isRetracted(existing) && JSON.stringify(existing.packet.body) !== JSON.stringify(b)) return false;
        if (!existing && !withinSeqJump(b.seq, maxSeqForDevice(messages, b.deviceId))) return false;
        // Over quota: not stored and not confirmed, so its sender retries later.
        if (!existing && !allowed(device.memberId, 'message', id)) return false;
        // Past the rolling window the oldest messages make room, so a new one is always stored and confirmed.
        if (!existing) {
          const arrived = retractions.arriving({ packet: packet as Stored['packet'], targets: [], receipts: [], receivedAt: Date.now() });
          if (store(messages, arrived)) {
            if (isRetracted(arrived)) pendingReactions = pendingReactions.filter(op => op.body.messageId !== b.id);
            else flushPendingReactions(b.id);
          }
        }
        await sendReceipt(id, b.id, fromRelay ? undefined : channel);
        return true;
      } else if (b.kind === 'receipt') {
        const messages = readMessages(); const m = messages.find(m => m.packet.body.id === b.id && m.packet.body.deviceId === identity.id);
        if (m?.targets.includes(id) && !m.receipts.includes(id)) save(messages.map(x => x === m ? { ...x, receipts: [...x.receipts, id] } : x));
        return true;
      }
      return false;
    }).then(persisted => {
      if (!persisted) return;
      // Persist the replay guard BEFORE acknowledging the inbox cursor so a crash cannot allow a replay.
      if (relayMeta?.replay && relaySeen.add(relayMeta.replay.from, relayMeta.replay.id)) writeJson(relaySeenFile, relaySeen.export());
      if (relayMeta?.cursor !== undefined) relayClient?.ackCursor(relayMeta.cursor);
    }).catch(error => log(`incoming: ${error.message}`)).finally(() => { for (const from of gate.done()) requestSync(from); });
  };
  const handleRelayEnvelope = async (envelope: RelayEnvelope, envCursor?: number) => {
    if (!verifiedRoster || envelope.from === identity.id) return;
    const sender = verifiedRoster.body.devices.find(d => d.id === envelope.from);
    if (!sender) return;
    const key = `${envelope.from}:${envelope.id}`;
    // A repeat of something already processed and persisted: drop it, and let the inbox copy be acknowledged.
    if (relaySeen.seen(envelope.from, envelope.id) || relaySeenVolatile.seen(envelope.from, envelope.id)) {
      if (envCursor !== undefined) relayClient?.ackCursor(envCursor);
      return;
    }
    if (relayInflight.has(key)) return;
    let decrypted: DecryptedRelayEnvelope<unknown>;
    try {
      // Do NOT reject legitimate inbox/in-flight frames encrypted under an earlier roster version. The envelope's roster
      // version is sender-chosen metadata and never moves `highestRosterVersion`; the sender signature is checked against the roster key.
      decrypted = await agent.decryptRelay(envelope, { senderSignKey: sender.sign });
    } catch {
      return;
    }
    if (!decrypted.packet || typeof decrypted.packet !== 'object') return;
    const packet = decrypted.packet as Packet;
    if (isFilePacket(packet) || isActivityPacket(packet)) {
      if (!relaySeenVolatile.add(envelope.from, envelope.id)) return;
      handlePacket(envelope.from, packet, true, undefined, undefined, { cursor: envCursor });
      return;
    }
    relayInflight.add(key);
    const done = handlePacket(envelope.from, packet, true, undefined, undefined, { cursor: envCursor, replay: { from: envelope.from, id: envelope.id } });
    void Promise.resolve(done).finally(() => relayInflight.delete(key));
  };
  const attachMessageHandler = (peer: Peer, id: string, channel: RTCDataChannel) => {
    channel.onMessage?.subscribe(raw => {
      const text = raw.toString(); if (text.length > 20_000) return;
      let packet: Packet; try { packet = JSON.parse(text); } catch { return; }
      handlePacket(id, packet, false, peer, channel);
    });
  };
  const connectChannel = (peer: Peer, id: string, channel: RTCDataChannel) => {
    peer.channel = channel;
    // Full state goes out once per channel, whichever of the open event or an already-open channel comes first.
    let stateSent = false;
    const opened = () => {
      if (stateSent || peers.get(id) !== peer) return;
      stateSent = true;
      historyRounds.set(id, 0);
      historyCursors.delete(id);
      historyRoundDropped.delete(id);
      historyRetryAt.delete(id);
      historyInFlight.delete(id);
      healthOf(peer);
      syncedAt ??= Date.now();
      log(`channel open to ${id.slice(0, 8)}`);
      sendState(peer);
      sendHistoryHave(id, peer);
      if (peer.fileChannel?.readyState !== 'open') transfers.opened(id);
      activity.opened(channel);
      flush();
    };
    const queue = peer.queue = new SendQueue(channel);
    channel.bufferedAmountLowThreshold = PACE_LOW_WATER;
    channel.bufferedAmountLow?.subscribe(() => queue.pump());
    channel.stateChanged?.subscribe(state => {
      if (state === 'closed') {
        peer.unhealthySince ??= now();
        if (peers.get(id) === peer) { transfers.closed(id); heard.delete(id); historyInFlight.delete(id); historyRetryAt.delete(id); }
        return;
      }
      // A peer that was retired (replaced, or its close still pending) has nothing more to exchange.
      if (state !== 'open' || peers.get(id) !== peer) return;
      opened();
    });
    if (channel.readyState === 'open') opened();
    attachMessageHandler(peer, id, channel);
  };
  /** Dedicated `'files'` channel isolating bulk chunks from chat/sync; also accepts non-file traffic from older answerers. */
  const connectFileChannel = (peer: Peer, id: string, channel: RTCDataChannel) => {
    peer.fileChannel = channel;
    try { channel.bufferedAmountLowThreshold = LOW_WATER; } catch { /* Read-only in some mocks. */ }
    let didOpen = false;
    const opened = () => {
      if (didOpen || peers.get(id) !== peer || peer.fileChannel !== channel) return;
      didOpen = true;
      transfers.opened(id);
    };
    channel.stateChanged?.subscribe(state => {
      if (state === 'closed') {
        if (peers.get(id) === peer && peer.fileChannel === channel) {
          peer.fileChannel = undefined;
          transfers.closed(id);
          if (peer.channel?.readyState === 'open') transfers.opened(id);
        }
        return;
      }
      if (state === 'open') opened();
    });
    if (channel.readyState === 'open') opened();
    attachMessageHandler(peer, id, channel);
  };
  const makePeer = (device: BrowserDevice & { session?: string }) => {
    // werift takes one URL per entry: expand each server so TURN udp/tcp/tls all stay available.
    const pc = makePc({ iceServers: expandIceServers(iceServers), ...policy() });
    const peer: Peer = { pc, session: device.session!, started: now(), iceKey, sent: new Map(), resync: new Resync() };
    peers.set(device.id, peer);
    const tried = `${device.id}:${device.session}`;
    if (!firstOffer.has(tried)) { if (firstOffer.size >= 256) firstOffer.clear(); firstOffer.set(tried, peer.started); }
    pc.onDataChannel?.subscribe(channel => channel.label === FILE_CHANNEL_LABEL
      ? connectFileChannel(peer, device.id, channel)
      : connectChannel(peer, device.id, channel));
    pc.connectionStateChange?.subscribe(() => healthOf(peer));
    pc.iceConnectionStateChange?.subscribe(() => healthOf(peer));
    return peer;
  };
  /**
   * Takes a peer out at once, then closes its connection in the background. A close that never finishes (seen with
   * werift) can then neither hold up the pass nor leave the peer half there: it is already gone from `peers`, which every
   * handler checks, and the next pass may connect to that device afresh.
   */
  const closeConnection = (id: string, peer: Peer) => {
    const closing = Promise.resolve().then(() => peer.pc.close());
    void within(closing, deadlines.close).then(done => { if (!done) log(`closing the connection to ${id.slice(0, 8)} did not finish within ${deadlines.close / 1000} s; left behind`); });
    return closing;
  };
  const retire = (id: string, peer: Peer) => {
    retireUfrag(id, peer.session, peer.remoteUfrag);
    if (peers.get(id) === peer) { peers.delete(id); transfers.closed(id); heard.delete(id); }
    return closeConnection(id, peer);
  };
  /** OPS-9: on coordinator epoch change, abort only half-open/connecting/unhealthy peers and keep open channels alive. */
  const retireHalfOpen = () => {
    for (const [id, peer] of [...peers]) {
      if (!isLiveOpenPeer(peer.pc.connectionState, peer.pc.iceConnectionState, peer.channel?.readyState)) {
        void retire(id, peer);
      }
    }
  };
  /** Every peer, as the room closes or runner stops; waits for the closes at most `deadlines.close`. */
  const retireAll = () => {
    if (relayClient) { relayClient.stop(); relayClient = undefined; }
    return within(Promise.allSettled([...peers].map(([id, peer]) => retire(id, peer))), deadlines.close);
  };
  /**
   * One step of the pass, waited on for at most `ms`. A step still running from an earlier pass is neither started again
   * nor waited on again: the outbox and closing decisions then never run twice at once, so nothing is signed or sent
   * twice, and what was not delivered stays in the outbox for the run that finishes.
   */
  const inFlight = new Map<string, { since: number; done: Promise<void> }>();
  const step = async (name: string, work: () => Promise<unknown>, ms: number) => {
    if (inFlight.has(name)) return;
    const entry = { since: Date.now(), done: Promise.resolve().then(work)
      .then(() => {}, error => log(`${name}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { if (inFlight.get(name) === entry) inFlight.delete(name); }) };
    inFlight.set(name, entry);
    if (await within(entry.done, ms)) return;
    log(`pass: ${name} did not finish within ${Math.round(ms / 100) / 10} s; moving on (it keeps running and is not started again until it ends)`);
  };
  /** The longest-running step, if one has run past `deadlines.wedged`. */
  const wedged = () => [...inFlight].find(([, entry]) => Date.now() - entry.since > deadlines.wedged)?.[0];
  const describe = async (id: string, peer: Peer, offer: boolean) => {
    const isClosed = () => peer.pc.connectionState === 'closed';
    if (peers.get(id) !== peer || isClosed()) return;
    const description = offer ? await peer.pc.createOffer() : await peer.pc.createAnswer();
    // Descriptions are not trickled: gather for at most gatherDeadlineMs, then send the candidates found so far
    // (see GATHER_DEADLINE_MS). werift keeps gathering; a late failure is only logged.
    const gathered: GatheredCandidate[] = [];
    const watching = peer.pc.onIceCandidate?.subscribe(c => { if (c?.candidate) gathered.push({ candidate: c.candidate, sdpMLineIndex: c.sdpMLineIndex }); });
    const applying = peer.pc.setLocalDescription(description);
    let complete = false;
    try {
      complete = await within(applying, gatherDeadlineMs);
      if (complete) await applying;
      else applying.catch(error => log(`gathering for ${id.slice(0, 8)} failed after its description was sent: ${error instanceof Error ? error.message : String(error)}`));
    } finally { (watching as { unSubscribe?: () => void } | undefined)?.unSubscribe?.(); }
    if (complete && gatherMs > 0) await new Promise(r => setTimeout(r, gatherMs)); // werift gathers host/srflx candidates quickly.
    if (peers.get(id) !== peer || isClosed()) return;
    const local = peer.pc.localDescription;
    if (!local) throw new Error(`no local description for ${id.slice(0, 8)} within ${gatherDeadlineMs / 1000} s`);
    if (!complete) log(`gathering for ${id.slice(0, 8)} still running after ${gatherDeadlineMs / 1000} s; sending ${gathered.length} candidate(s) gathered so far`);
    if (offer) peer.offerSent = true;
    await agent.command('signal', { to: id, session, targetSession: peer.session,
      description: { type: local.type, sdp: complete ? local.sdp : withGatheredCandidates(local.sdp, gathered) } });
  };
  /** Per queued reply to a message that went to every agent: why it may not go (another agent has it), or undefined. */
  const claimVerdicts = new Map<string, ClaimVerdict | undefined>();
  /** Messages this runner answered, to mark answered with the room service once the outbox step lets go of the lock. */
  const answeredMarks: string[] = [];
  /**
   * Claims, settled with the room service before the outbox step and outside its lock, so incoming packets never wait on
   * the room service: claims the agent asked for (`claim`), answered in a note next to the outbox for the command waiting
   * on it, and the claim each queued reply to a message that went to every agent needs before it is signed. Old notes
   * nobody read are pruned here.
   */
  const settleOutboxClaims = async () => {
    const outbox = join(agent.dir, 'outbox'), memberId = agent.members().memberId;
    if (!memberId || agent.person) return;
    const files = readdirSync(outbox);
    for (const file of files.filter(f => f.endsWith('.dropped') || f.endsWith('.claim'))) {
      try { if (Date.now() - lstatSync(join(outbox, file)).mtimeMs > OUTBOX_NOTE_MS) rmSync(join(outbox, file), { force: true }); } catch { /* gone */ }
    }
    // Within the step's budget: what is left waits for the next pass, so a slow room service never wedges the runner.
    const ends = Date.now() + deadlines.claims;
    for (const file of files.filter(f => f.endsWith('.json')).sort()) {
      if (Date.now() >= ends) break;
      try {
        if (!lstatSync(join(outbox, file)).isFile()) continue; // deliverOutbox removes it.
        const item = readJson<Record<string, any> | null>(join(outbox, file), null);
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'claim') {
          const problem = outboxProblem(agent, memberId, item);
          let answer: { claim?: Claim | null; unsupported?: true; error?: string };
          if (problem) { log(`dropped ${file}: ${problem}`); noteDropped(outbox, String(item.id), `This was not done: ${problem}.`); rmSync(join(outbox, file), { force: true }); continue; }
          try { const claim = await claimMessage(agent, item.messageId, item.release ? { release: true } : {}, CLAIM_CALL_MS); answer = claim === undefined ? { unsupported: true } : { claim }; }
          catch (error: any) { answer = error?.status === 429 ? { error: error.message } : { error: `The room service could not settle the claim: ${error instanceof Error ? error.message : String(error)}` }; }
          noteDropped(outbox, item.id, JSON.stringify(answer), 'claim');
          rmSync(join(outbox, file), { force: true }); continue;
        }
        if (item.type !== undefined || typeof item.replyTo !== 'string' || claimVerdicts.has(item.id)) continue;
        if (agent.messages().some(m => m.packet.body.memberId === memberId && m.packet.body.id === item.id)) continue;
        // A reply the outbox step will drop anyway takes no claim; it drops it.
        if (outboxProblem(agent, memberId, item)) continue;
        const view = agent.view(), target = resolveMessageById(view.messages, item.replyTo);
        if (target && needsClaim(view, target)) claimVerdicts.set(item.id, await settleClaim(agent, view, target.id, CLAIM_CALL_MS));
      } catch (error) { log(`claims: ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  };
  const markAnswered = () => {
    for (const messageId of answeredMarks.splice(0)) {
      void claimMessage(agent, messageId, { answered: true }, CLAIM_CALL_MS).catch(error => log(`marking ${messageId.slice(0, 8)} answered: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
  const deliverOutbox = () => transaction(async () => {
    const outbox = join(agent.dir, 'outbox');
    for (const file of readdirSync(outbox).filter(f => f.endsWith('.json')).sort()) {
      try {
        // A harness sandbox can write the outbox: only regular files are read, and a planted link is removed, not followed.
        if (!lstatSync(join(outbox, file)).isFile()) { log(`outbox ${file}: not a regular file, removed`); unlinkSync(join(outbox, file)); continue; }
        const item = readJson<{ id: string; text: string; replyTo?: string; attachments?: AttachmentRef[] } | TaskIntent | DecisionIntent | ReactionIntent | RetractIntent | ClaimIntent | null>(join(outbox, file), null);
        if (!item || !status?.memberId) continue;
        // Claims are settled before this, outside the lock (settleOutboxClaims).
        if ((item as { type?: string }).type === 'claim') continue;
        const problem = outboxProblem(agent, status.memberId, item);
        if (problem) {
          log(`dropped ${file}: ${problem}`);
          // Told to the command waiting on it: a decision change, a claim, or a message.
          const kind = (item as { type?: string }).type;
          if ((kind === 'decision' || kind === 'claim' || 'text' in item) && UUID.test(String(item.id))) noteDropped(outbox, item.id, `This was not done: ${problem}.`);
          unlinkSync(join(outbox, file)); continue;
        }
        if ('type' in item && item.type === 'decision') {
          const ops = readDecisionOps(), author = { roomId: agent.roomId, deviceId: identity.id, memberId: status.memberId };
          const current = pickDecision(agent.decisions(ops), item.decisionId, status.memberId);
          try {
            if (!agent.madeDecisionOp(item.id, ops)) {
              const body = item.action === 'open' ? (current ? undefined : openDecision({ ...author, decisionId: item.decisionId, question: item.question, context: item.context,
                  mode: item.mode, options: item.options, askAgents: item.askAgents, closesAt: item.closesAt }))
                : !current ? undefined
                : item.action === 'vote' ? castVote(author, current, item.optionId, item.comment, nextVoteRevision(ops.map(p => p.body), current, status.memberId))
                : reviseDecision(author, current, item.action === 'option' ? { addOption: item.label } : item.action === 'close' ? { close: true } : { withdraw: true });
              const signed = body && { ...body, id: item.id };
              if (signed && !validDecisionBody(signed, agent.roomId) && !validVoteBody(signed, agent.roomId)) throw new Error('the change is not within the room\'s limits');
              if (signed) await shareDecisionOp(signed);
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            log(`dropped decision change ${item.id}: ${reason}`);
            noteDropped(outbox, item.id, reason);
          }
          unlinkSync(join(outbox, file)); continue;
        }
        if ('type' in item && item.type === 'task') {
          const ops = readTaskOps();
          if (!ops.some(p => p.body.id === item.id)) {
            const current = foldBoard(ops.map(p => p.body)).find(t => t.id === item.taskId);
            const creating = !ops.some(p => p.body.taskId === item.taskId);
            if (creating || current) { // A task someone removed meanwhile is not recreated by an update.
              const body = { ...taskBody({ roomId: agent.roomId, deviceId: identity.id, memberId: status.memberId, current, taskId: item.taskId, change: item.change, removed: item.removed, repositories: agent.settings().repositories }), id: item.id };
              if (!validTaskBody(body, agent.roomId)) { log(`dropped ${file}: the task change is not within the room's limits`); unlinkSync(join(outbox, file)); continue; }
              if (!current && !item.removed && !mayAddTask(ops.map(p => p.body), body)) {
                log(`dropped ${file}: this member reached its live task limit`); unlinkSync(join(outbox, file)); continue;
              }
              const packet = { body, signature: await agent.sign(body) };
              storeOps(ops, [packet]);
              broadcast(packet);
            }
          }
          unlinkSync(join(outbox, file));
          // issue-task holds a claim while this outbox item is pending; release once run is done with it.
          if (validIssueLink(item.change.issue)) releaseIssueTask(join(agent.dir, 'issue-tasks'), item.change.issue);
          continue;
        }
        if ('type' in item && item.type === 'reaction') {
          const ops = readReactionOps();
          if (ops.some(p => p.body.id === item.id)) { unlinkSync(join(outbox, file)); continue; }
          // Wait until the message is held; do not drop the outbox item forever. A deleted one takes no reactions.
          const messages = readMessages(), target = messages.find(m => m.packet.body.id === item.messageId);
          if (!target) continue;
          if (isRetracted(target)) { unlinkSync(join(outbox, file)); continue; }
          const bodies = ops.map(p => p.body);
          const remove = memberReacted(foldReactions(bodies), item.messageId, item.emoji, status.memberId);
          const body: ReactionBody = {
            kind: 'reaction', roomId: agent.roomId, id: item.id, deviceId: identity.id, memberId: status.memberId,
            messageId: item.messageId, emoji: item.emoji,
            revision: currentRevision(bodies, item.messageId, status.memberId, item.emoji) + 1,
            at: Date.now(), ...(remove ? { removed: true as const } : {}),
          };
          if (!validReactionBody(body, agent.roomId)) { log(`dropped ${file}: not a valid reaction`); unlinkSync(join(outbox, file)); continue; }
          const packet = { body, signature: await agent.sign(body) };
          if (!storeReactionOps(ops, [packet])) {
            // Log full: leave queued and mark so reactBrowser can report log-full distinctly.
            writeJson(join(outbox, file), { ...item, blocked: 'log-full' });
            continue;
          }
          broadcast(packet);
          unlinkSync(join(outbox, file)); continue;
        }
        if ('type' in item && item.type === 'retract') {
          // Already in the log: a pass signed it and failed before finishing, and this one finishes it.
          let packet = readRetractOps().find(p => p.body.id === item.id);
          if (!packet) {
            const target = readMessages().find(m => m.packet.body.id === item.messageId && m.packet.body.memberId === status!.memberId);
            if (!target || isRetracted(target)) { unlinkSync(join(outbox, file)); continue; }
            const body: RetractBody = {
              kind: 'retract', roomId: agent.roomId, id: item.id, deviceId: identity.id, memberId: status.memberId,
              at: Date.now(), target: item.messageId, targetDeviceId: target.packet.body.deviceId,
              ...(target.packet.body.seq !== undefined ? { seq: target.packet.body.seq } : {}),
            };
            packet = { body, signature: await agent.sign(body) };
          }
          retractions.add([packet]);
          broadcast(packet);
          unlinkSync(join(outbox, file)); continue;
        }
        if (!('text' in item)) continue;
        const messages = readMessages();
        const files = item.attachments;
        if (files && (!validAttachments(files) || !files.every(ref => agent.files.has(ref.sha256)))) { log(`dropped message ${item.id}: its files are missing`); unlinkSync(join(outbox, file)); continue; }
        let answering: string | undefined;
        if (!messages.some(m => m.packet.body.deviceId === identity.id && m.packet.body.id === item.id) && item.replyTo) {
          // A reply to a message that went to every agent waits for its claim (settleOutboxClaims), and is dropped when
          // another agent got there first.
          const view = agent.view(), target = resolveMessageById(view.messages, item.replyTo);
          if (!agent.person && target && needsClaim(view, target)) {
            if (!claimVerdicts.has(item.id)) continue;
            const refused = claimVerdicts.get(item.id);
            claimVerdicts.delete(item.id);
            if (refused) {
              log(`dropped message ${item.id}: ${refused.reason}`);
              // Answered by another agent: noted as such, so send can tell it from a failure.
              noteDropped(outbox, item.id, refused.answeredBy !== undefined ? JSON.stringify(refused) : refused.reason);
              unlinkSync(join(outbox, file)); continue;
            }
            answering = target.id;
          }
        }
        if (!messages.some(m => m.packet.body.deviceId === identity.id && m.packet.body.id === item.id)) {
          const visibility: MessageVisibility = status.settings?.historyForNewcomers ? 'room' : 'members';
          const audienceUntil = visibility === 'members' ? currentAudienceUntil(status) : undefined;
          const seq = nextAuthorSeq(messages, identity.id, readAuthorSeq());
          const body: MessageBody = { kind: 'message', roomId: agent.roomId, id: item.id, deviceId: identity.id, memberId: status.memberId,
            text: item.text.trim() || (files ? attachmentText(files) : ''), at: Date.now(), visibility, seq,
            ...(audienceUntil !== undefined ? { audienceUntil } : {}), ...(item.replyTo ? { replyTo: item.replyTo } : {}), ...(files ? { attachments: files } : {}) };
          saveAuthorSeq(seq);
          if (store(messages, { packet: { body, signature: await agent.sign(body) }, targets: (status.devices || []).filter(d => d.id !== identity.id).map(d => d.id), receipts: [], receivedAt: Date.now() })) flushPendingReactions(item.id);
        }
        unlinkSync(join(outbox, file));
        // The answer is signed: its claim is marked answered once this pass lets go of the lock (markAnswered).
        if (answering) answeredMarks.push(answering);
      } catch (error) {
        // One item that can't be delivered now (a failed signature or write) stays queued and doesn't block the rest.
        log(`outbox ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    flush();
  });

  /**
   * Save one of the files the commands read (listen, status, the watch peek). A failure is logged, at most once a minute
   * per file, and the rest of the pass carries on; the commands keep reading the last good copy.
   */
  const failing = new Map<string, number>();
  /** The room's rules as the room service last gave them, kept in memory so each status rewrites them. */
  let rules: RoomRules | undefined;
  const keep = (file: string, value: unknown) => {
    try { writeJson(join(agent.dir, file), value); failing.delete(file); }
    catch (error) {
      if (Date.now() - (failing.get(file) ?? 0) < 60_000) return;
      failing.set(file, Date.now());
      log(`${file}: ${error instanceof Error ? error.message : String(error)} (keeping the last saved copy)`);
    }
  };
  let pruned = 0;
  const syncRosterAndRelay = async (next: RoomStatus) => {
    // 1. Verify incoming host-signed roster (rejecting rollbacks & substituted keys).
    if (next.roster) {
      const same = verifiedRoster && next.roster.body.version === verifiedRoster.body.version && next.roster.signature === verifiedRoster.signature;
      if (!same && next.roster.body.version > (verifiedRoster?.body.version ?? 0) && next.roster.body.version >= highestRosterVersion) {
        const consecutive = !!verifiedRoster && next.roster.body.version === verifiedRoster.body.version + 1;
        const minVersion = Math.max(highestRosterVersion, verifiedRoster ? verifiedRoster.body.version + 1 : 0);
        const verified = await verifyRoster(next.roster, {
          roomId: agent.roomId,
          expectedHostPin: pinnedHost,
          ...(consecutive ? { previous: verifiedRoster } : {}),
          ...(minVersion > 0 ? { minVersion } : {}),
        });
        if (verified.ok) {
          verifiedRoster = next.roster;
          highestRosterVersion = Math.max(highestRosterVersion, next.roster.body.version);
          pinnedHost = verified.hostDeviceId;
        } else {
          log(`roster rejected: ${verified.reason}`);
        }
      }
    }
    // 2. Publish this device's ECDH key binding if missing or rotated on a relay-capable coordinator.
    const selfDev = next.devices?.find(d => d.id === identity.id);
    if ((next.relayUrl || next.roster) && next.memberId && selfDev && (!selfDev.enc || selfDev.enc !== identity.encPublicKey || selfDev.encVersion !== identity.encVersion) && now() - lastEncPublishAt >= 5_000) {
      lastEncPublishAt = now();
      try {
        const binding = await agent.encBinding();
        await agent.command('profile', binding);
      } catch (error) {
        log(`enc publish: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 3. When this device is a host device, publish host-signed monotonic SignedRoster on changes.
    if (agent.person && next.memberId && next.ownerId === next.memberId && selfDev?.enc && selfDev.encVersion && selfDev.encSig && now() - lastRosterPublishAt >= 2_000) {
      const canPublish = !verifiedRoster || verifiedRoster.body.host === identity.id
        || !next.devices?.some(d => d.id === verifiedRoster!.body.host && d.memberId === next.ownerId);
      if (canPublish) {
        const built = await buildNextHostRoster(next, identity.id, verifiedRoster, v => agent.sign(v), now());
        if (built) {
          lastRosterPublishAt = now();
          try {
            const updated = await agent.command('roster-publish', { roster: built });
            const check = await verifyRoster(updated?.roster ?? built, {
              roomId: agent.roomId,
              expectedHostPin: pinnedHost,
              previous: verifiedRoster,
            });
            if (check.ok) {
              verifiedRoster = updated?.roster ?? built;
              highestRosterVersion = Math.max(highestRosterVersion, verifiedRoster!.body.version);
              pinnedHost = check.hostDeviceId;
            }
          } catch (error) {
            log(`roster publish: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    // 4. Start optional WSS+HTTPS relay client when advertised.
    if (options.relay !== false && next.relayUrl && next.memberId && !relayClient) {
      relayClient = await agent.createRelayClient({
        relayUrl: next.relayUrl,
        session,
        rosterVersion: () => verifiedRoster?.body.version ?? 1,
        onEnvelope: (envelope, meta) => handleRelayEnvelope(envelope, meta.cursor),
        onStatus: pushedStatus => { pushed = pushedStatus; },
        onStateChange: state => {
          if (state === 'wss' || state === 'https') {
            syncedAt ??= Date.now();
            relayHistorySynced.clear();
            syncHistoryViaRelay();
            flush();
          }
        },
        onError: err => log(`relay: ${err.message}`),
        onAuthError: (code, msg) => {
          log(`relay auth (${code}): ${msg}`);
          relayClient?.stop();
          relayClient = undefined;
          // Removed, or the room closed: the next pass polls, so it hears so, instead of opening the relay again.
          polledAt = undefined;
        },
        ...options.relayOptions,
      });
      // The service pushes this room's status over the socket, as this runner's lobby session: no polling while it does.
      relayClient.watchStatus({ session, epoch, cursor });
      relayClient.start();
    }
  };
  log(`bridge running as device ${identity.id.slice(0, 12)} in ${agent.roomId}`);
  while (!options.signal?.aborted) {
    loopAt = Date.now();
    // A step that never finishes holds the serialized work (incoming packets, the outbox) behind it: the runner would
    // stay present but deaf. It stops instead, so whoever owns the runner starts a fresh one.
    const stuck = wedged();
    if (stuck) {
      clearInterval(ticking);
      log(`pass: ${stuck} has not finished in ${Math.round(deadlines.wedged / 1000)} s; stopping so a fresh runner takes over`);
      await retireAll();
      throw new RunnerWedged(`The runner's ${stuck} step never finished; start the runner again.`);
    }
    try {
      let next: RoomStatus;
      const live = relayClient?.statusLive === true;
      // An offer waiting for its answer: poll each pass for it while no push brings it, for the offer's first seconds
      // only. A device that never answers (online, but unable to connect) mustn't keep the runner polling.
      // Counted from the first attempt at that device's session, so retries don't keep it going.
      const setupAt = now();
      const connecting = [...peers.entries()].some(([id, p]) => p.pc.signalingState === 'have-local-offer'
        && setupAt - (firstOffer.get(`${id}:${p.session}`) ?? p.started) < CONNECTING_POLL_MS);
      // A service without the relay has no socket to push over: polling is all there is, at the rate it always had.
      const due = !status?.memberId || !status.relayUrl || failingSince !== undefined || connecting || passesSincePoll + 1 >= idlePollEvery
        || Date.now() - (polledAt ?? 0) >= IDLE_POLL_MS;
      if (live && pushed) {
        next = pushed; pushed = undefined; passesSincePoll = 0;
        polledAt = Date.now(); failingSince = undefined; failure = undefined; failureStatus = undefined; upgradeRequired = false; pollBackoff = 0;
      } else if (status && (live || !due)) {
        // Nothing new: the pass does its own work (outbox, peers, decisions) on what the room last said. Its signals were
        // handled already, as an idle poll would leave them out.
        next = { ...status, signals: [] }; passesSincePoll++;
      } else {
        passesSincePoll = 0;
        try { next = await answerWithin(agent.command('status', { session, epoch, cursor }), deadlines.poll, 'the room service'); }
        catch (error) {
          // An outage, a machine that woke before its network, a rejection: reported through the proof, never a reason to
          // replace this runner, which carries on and polls again (a 410 is handled below).
          const status = (error as { status?: unknown }).status;
          const code = (error as { code?: unknown }).code;
          if (status !== 410) {
            failingSince ??= Date.now(); failure = error instanceof Error ? error.message : String(error);
            // An HTTP answer (a rejection, a rate limit, a server error) means the service was reached: only a failure without
            // one (the request failed or timed out) can mean this runner's own networking broke. See repairRunner.
            failureStatus = typeof status === 'number' ? status : undefined;
            upgradeRequired = status === 426 || code === 'upgrade-required';
          }
          throw error;
        } finally { loopAt = Date.now(); }
        polledAt = Date.now(); failingSince = undefined; failure = undefined; failureStatus = undefined; upgradeRequired = false; pollBackoff = 0;
      }
      // Everything after the poll shares one budget, so the next poll comes inside the service's presence window.
      const passEnds = Date.now() + deadlines.budget, left = (cap: number) => Math.max(0, Math.min(cap, passEnds - Date.now()));
      // A device the room no longer has, with no request of its own, after it was a member: someone removed this agent.
      // The proof says so, so the machine's daemon stops looking after a room that will never answer this device again.
      removedSince = next.memberId || next.request || !agent.members().memberId ? undefined : removedSince ?? Date.now();
      if (!next.memberId) {
        // A person device's commands read where its request stands (and a companion's code) from here, not by polling.
        if (agent.person) {
          keep(ADMISSION_FILE, next.request ? { state: next.request.state, kind: next.request.kind, ...(next.request.code ? { code: next.request.code } : {}),
            expiresAt: next.request.expiresAt, at: Date.now() } : { state: 'none', at: Date.now() });
          keepStatus(next);
        }
        // Kept as the last status, so the next pass polls again instead of working on an admission this device lost.
        status = next;
        log(next.request ? `waiting for admission (${next.request.state})` : 'not admitted to this room'); await pause(3000); continue;
      }
      // The room's rules first, and on their own: listen, status and the watch peek read the floor from this file, so
      // nothing else in the pass (closing peers, a members.json busy on Windows) may leave it behind the room.
      // Every admitted status from the room service carries them; one that doesn't (a service from before room settings)
      // keeps the last ones heard, which are still written, so a lost or damaged copy never falls back to the default.
      if (next.settings) rules = { floor: next.settings.floor, agentAssignmentsWake: next.settings.agentAssignmentsWake, historyForNewcomers: !!next.settings.historyForNewcomers, repositories: next.repositories ?? [], claims: next.claims ?? [], checkedAt: Date.now() };
      rules ??= agent.settings();
      keep('settings.json', rules);
      // OPS-9: on coordinator restart (epoch change), keep healthy open DataChannels alive and drop only half-open peers.
      // A push may still carry signals handled before its ack reached the service: each is applied once.
      if (next.epoch === epoch && next.signals?.length) next = { ...next, signals: next.signals.filter(s => s.seq > cursor) };
      if (epoch && next.epoch !== epoch) { retireHalfOpen(); cursor = 0; }
      // OPS-11: store refreshed TURN credentials immediately and update existing connections where supported.
      if (next.iceServers) {
        const nextIceKey = JSON.stringify(next.iceServers);
        if (nextIceKey !== iceKey) {
          iceServers = next.iceServers;
          iceKey = nextIceKey;
          const expanded = expandIceServers(iceServers);
          for (const [id, peer] of [...peers]) {
            if (peer.iceKey === iceKey) continue;
            if (typeof peer.pc.setConfiguration === 'function' && peer.pc.connectionState !== 'closed') {
              try {
                peer.pc.setConfiguration({ iceServers: expanded, ...policy() });
                peer.iceKey = iceKey;
              } catch {
                if (peer.pc.connectionState === 'disconnected' || peer.pc.iceConnectionState === 'disconnected') void retire(id, peer);
              }
            } else if (peer.pc.connectionState === 'disconnected' || peer.pc.iceConnectionState === 'disconnected') {
              void retire(id, peer);
            }
          }
        }
      }
      epoch = next.epoch; status = next;
      await step('relay', () => syncRosterAndRelay(next), left(deadlines.profile));
      syncHistoryViaRelay();
      // Departed members' roles, one per member, so an agent that left is never counted as a person in a decision.
      const former = [...new Map((next.formerDevices || []).map(d => [d.memberId, { id: d.memberId, ...((d as { role?: 'human' | 'agent' }).role ? { role: (d as { role?: 'human' | 'agent' }).role } : {}) }])).values()];
      // A roster that can't be saved keeps the last good one for the commands; peers and the outbox carry on regardless.
      keep('members.json', { memberId: next.memberId, ownerId: next.ownerId, ...(typeof next.title === 'string' ? { title: next.title } : {}), former, members: next.members || [],
        devices: (next.devices || []).map(d => ({ id: d.id, memberId: d.memberId, ...(agent.person ? { online: !!d.session } : {}) })) });
      if (agent.person && existsSync(join(agent.dir, ADMISSION_FILE))) rmSync(join(agent.dir, ADMISSION_FILE), { force: true });
      await step('profile', () => applyPendingProfile(agent, log), left(deadlines.profile));
      for (const signal of next.signals || []) cursor = Math.max(cursor, signal.seq);
      relayClient?.ackStatus(cursor, epoch);
      const devices = (next.devices || []).filter(d => d.id !== identity.id);
      const available = devices.filter(d => d.session);
      // Alone in the room: no device can send history, so there is nothing to wait for before a watcher starts from now.
      // Without this, a watcher whose operator closed the browser waited for a channel that would never open.
      if (available.length === 0) syncedAt ??= Date.now();
      for (const key of [...retiredUfrags.keys()]) {
        const sep = key.indexOf(':'), devId = key.slice(0, sep), sess = key.slice(sep + 1);
        const d = devices.find(x => x.id === devId);
        if (!d || (d.session && d.session !== sess)) retiredUfrags.delete(key);
      }
      const at = now();
      for (const [id, peer] of [...peers]) {
        const device = devices.find(d => d.id === id);
        const sessionChanged = !!device?.session && device.session !== peer.session;
        const liveOpen = isLiveOpenPeer(peer.pc.connectionState, peer.pc.iceConnectionState, peer.channel?.readyState);
        const staleIceDisconnected = !!peer.iceKey && peer.iceKey !== iceKey && (peer.pc.connectionState === 'disconnected' || peer.pc.iceConnectionState === 'disconnected');
        if (!device || sessionChanged || (!device.session && !liveOpen) || staleIceDisconnected || healthOf(peer, at) === 'drop') {
          void retire(id, peer);
        }
      }
      // Offers and answers are prepared side by side, as the browser does: each waits for its candidates, and one after
      // another a busy room's pass outlasted the service's presence window, so peers took this agent for gone. A peer is
      // replaced before its work starts, so each piece of work belongs to one peer; one not done in time is dropped, and
      // its late steps find it gone (describe checks) instead of signalling for it.
      const work: { id: string; peer: Peer; kind: 'offer-in' | 'offer-out' | 'answer'; done: Promise<unknown> }[] = [];
      for (const signal of dedupeSignals(next.signals || [], available)) {
        const device = available.find(d => d.id === signal.from && d.session === signal.session); if (!device) continue;
        if (signal.description.type === 'offer') {
          if (device.id > identity.id) continue;
          const previous = peers.get(device.id);
          const offerUfrag = sdpIceUfrag(signal.description.sdp);
          if (previous && previous.session === device.session && offerUfrag && previous.remoteUfrag === offerUfrag
            && isLiveOpenPeer(previous.pc.connectionState, previous.pc.iceConnectionState, previous.channel?.readyState)) continue;
          if (previous) void retire(device.id, previous);
          const peer = makePeer(device);
          peer.remoteUfrag = offerUfrag;
          work.push({ id: device.id, peer, kind: 'offer-in', done: (async () => {
            const isClosed = () => peer.pc.connectionState === 'closed';
            if (peers.get(device.id) !== peer || isClosed()) return;
            await peer.pc.setRemoteDescription(remote(device.id, signal.description) as any);
            if (peers.get(device.id) !== peer || isClosed()) return;
            await describe(device.id, peer, false);
          })() });
        } else if (signal.description.type === 'answer') {
          if (identity.id >= device.id) continue;
          const peer = peers.get(device.id);
          if (!peer || peer.session !== device.session || !peer.offerSent || peer.pc.connectionState === 'closed' || peer.pc.signalingState !== 'have-local-offer') continue;
          if (!answerMatchesOffer(peer.pc.localDescription?.sdp, signal.description.sdp, retiredUfrags.get(`${device.id}:${device.session}`), peer.pc.remoteDescription?.sdp)) continue;
          peer.remoteUfrag = sdpIceUfrag(signal.description.sdp);
          work.push({ id: device.id, peer, kind: 'answer', done: (async () => {
            if (peers.get(device.id) !== peer || peer.pc.connectionState === 'closed' || peer.pc.signalingState !== 'have-local-offer') return;
            await peer.pc.setRemoteDescription(remote(device.id, signal.description) as any);
          })() });
        }
      }
      for (const device of available) {
        if (identity.id < device.id && !peers.has(device.id)) {
          const peer = makePeer(device);
          connectChannel(peer, device.id, peer.pc.createDataChannel(PRIMARY_CHANNEL_LABEL));
          connectFileChannel(peer, device.id, peer.pc.createDataChannel(FILE_CHANNEL_LABEL));
          work.push({ id: device.id, peer, kind: 'offer-out', done: describe(device.id, peer, true) });
        }
      }
      const signalMs = left(deadlines.signals), settled = await settleWithin(work.map(w => w.done), signalMs);
      settled.forEach((result, i) => {
        const { id, peer, kind } = work[i];
        if (result?.status === 'rejected') {
          log(`signal: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          if (kind !== 'answer' && peers.get(id) === peer && peer.channel?.readyState !== 'open') void retire(id, peer);
        }
        if (result) return;
        // werift applies an answer only once its own gathering ends (description operations queue behind it), which can
        // outlast this pass when a description went out at the gather deadline. The answer is still being applied, so the
        // connection is kept: the connect timeout (evaluatePeerHealth) drops it if it never opens.
        if (kind === 'answer') { log(`pass: applying the answer from ${id.slice(0, 8)} is still waiting on gathering; keeping that connection`); return; }
        log(`pass: connecting to ${id.slice(0, 8)} did not finish within ${Math.round(signalMs / 100) / 10} s; dropping that connection to try again`);
        if (peers.get(id) === peer) void retire(id, peer);
      });
      await step('claims', settleOutboxClaims, left(deadlines.claims));
      await step('outbox', deliverOutbox, left(deadlines.outbox));
      markAnswered();
      await step('decisions', closeDueDecisions, left(deadlines.decisions));
      for (const peer of peers.values()) { peer.queue?.pump(); resyncDue(peer); }
      for (const id of quotaDrops.due()) requestSync(id);
      flushHistoryRetries();
      transfers.tick(); fetchWanted();
      if (agent.person) keepStatus(next);
      if (Date.now() - pruned > 60_000) { prune(); pruned = Date.now(); }
    } catch (error) {
      // 410: the host closed the room or the service removed it. Nothing will change, so stop instead of retrying.
      // A waiting listen reads the marker and returns at once instead of waiting out its timer.
      const statusCode = (error as { status?: number }).status;
      const errorCode = (error as { code?: string }).code;
      if (statusCode === 410) {
        clearInterval(ticking);
        try { writeJson(join(agent.dir, ROOM_CLOSED_FILE), { at: Date.now(), reason: error instanceof Error ? error.message : String(error) }); } catch { /* The next runner hears it again. */ }
        await retireAll();
        throw error;
      }
      if (statusCode === 426 || errorCode === 'upgrade-required') {
        const message = error instanceof Error ? error.message : String(error);
        const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
        pollBackoff = Math.max(UPGRADE_BACKOFF_MS, retryAfterMs ?? 0);
        prove();
        const hint = message.includes('@wormdb/meshrooms') ? '' : ' Upgrade with: bunx @wormdb/meshrooms@latest';
        log(`upgrade required (HTTP 426): ${message}${hint}`);
      } else {
        pollBackoff = statusCode === 429 ? nextPollBackoff(pollBackoff, (error as { retryAfterMs?: number }).retryAfterMs) : 0;
        log(`status: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    sleeping = true;
    try { await pause(pollBackoff || 1000); } finally { sleeping = false; }
  }
  clearInterval(ticking);
  await retireAll();
}

/**
 * How long a first listen waits for the room's history to arrive from its peers before it answers that there is none
 * yet. The bridge can't tell an empty room from one it hasn't synced, so it gives the sync a moment, not the whole wait.
 */
export const FIRST_LISTEN_GRACE_MS = 3_000;

/** The cursors one `listen` works from; `history` marks a first listen, which answers with the conversation so far. */
export type ListenPlan = { after?: string; boardAfter?: number; decisionsAfter?: number; outcomesAfter?: number; history: boolean };

/**
 * One look at the room for this agent under listen's rules: what would wake it, and which cursors that answer carries.
 * `historyDue` says whether a first listen has given the sync its moment, so it answers with history even when
 * nothing addresses the agent. Reads only: `listen` records activity and saves cursors, `peekWork` does neither.
 * Undefined while the agent is not admitted.
 */
export function listenSnapshot(agent: BrowserAgent, plan: ListenPlan, historyDue: boolean) {
  const { after, boardAfter, decisionsAfter, outcomesAfter, history } = plan;
  const view = agent.view(); if (!view.memberId) return undefined;
  const woke = evaluateWake(view, view.memberId, after, boardAfter);
  // Decisions asking for this agent's advice, and its own decisions that resolved (wake on consensus).
  const ops = agent.decisionOps(), decisionCursor = agent.decisionCursor(ops);
  // An ask wakes the agent under the same author rules as a message: in humans-first rooms, only a person's.
  const since = (seq: number) => decisionWakes(ops.map(p => p.body), agent.members(), view.memberId!, ops.filter(p => p.seq > seq).map(p => p.body), creator => authorWakes(view, view.memberId!, creator));
  const asks = decisionsAfter === undefined ? { asked: [], resolved: [], withdrawn: [] } : since(decisionsAfter);
  // Asks wake from decisionsAfter, outcomes of the agent's own decisions only from outcomesAfter: older ones are old news.
  const wakes = outcomesAfter === undefined || decisionsAfter === undefined || outcomesAfter <= decisionsAfter ? asks : { ...since(outcomesAfter), asked: asks.asked };
  const decided = wakes.asked.length || wakes.resolved.length || wakes.withdrawn.length;
  let result = woke.state === 'waiting' && decided ? { ...woke, state: 'addressed' as const } : woke;
  if (history && after === undefined) {
    // A first listen answers with history even when the room has no messages yet (once the sync had its moment):
    // what it finds for this agent is part of that history, not a separate wake.
    if (result.state === 'addressed') result = { ...result, state: 'history' };
    else if (result.state === 'waiting' && historyDue) result = { ...result, state: 'history', boardCursor: view.boardRevision ?? boardAfter };
  }
  return { view, result, wakes, decided, decisionCursor };
}

/**
 * The cursors a plain `listen` continues from, resolved the way `listenRemembering` does: flags first, then what the
 * last listen saved, as long as this folder still holds what it names.
 */
export function listenPlan(agent: BrowserAgent, flags: { after?: string; boardAfter?: number; decisionsAfter?: number; fromStart?: boolean } = {}) {
  const saved = flags.fromStart ? undefined : agent.listenCursor();
  // A cursor for a message this folder no longer holds (its messages were reset) starts over rather than failing every listen.
  const known = saved?.after !== undefined && storedCursorIndex(agent.messages(), saved.after) >= 0;
  const after = flags.after ?? (known ? saved!.after : undefined);
  // Saved cursors ahead of what this folder holds (its tasks or decisions were reset) are stale: start those from 0.
  const board = saved?.boardAfter !== undefined && saved.boardAfter <= agent.boardCursor() ? saved.boardAfter : undefined;
  const decided = saved?.decisionsAfter !== undefined && saved.decisionsAfter <= agent.decisionCursor() ? saved.decisionsAfter : undefined;
  const decisionsAfter = flags.decisionsAfter ?? decided;
  // With nothing saved (or --from-start) and no message cursor given, this is a first listen: it answers with history.
  const plan: ListenPlan = { after, boardAfter: flags.boardAfter ?? board ?? 0, decisionsAfter: decisionsAfter ?? 0,
    outcomesAfter: decisionsAfter ?? agent.decisionCursor(), history: !saved && after === undefined };
  return { plan, saved };
}

/** What a plain `listen` would hand the agent right now. */
export type PeekResult = { admitted: boolean; work: boolean; state: 'history' | 'addressed' | 'waiting'; addressed: string[]; tasks: string[]; decisions: string[] };
/**
 * Whether a plain `listen` would return work for this agent now, under exactly listen's rules and saved cursors, without
 * consuming it: no cursor is saved and no activity recorded, so the listen that follows still returns the same work.
 * Work means messages that address the agent, assignments, or decisions; a first listen's history counts only when it
 * holds some of those. The watcher calls this to decide whether to wake the agent's harness.
 */
export function peekWork(agent: BrowserAgent): PeekResult {
  const snapshot = listenSnapshot(agent, listenPlan(agent).plan, false);
  if (!snapshot) return { admitted: false, work: false, state: 'waiting', addressed: [], tasks: [], decisions: [] };
  const { result, wakes } = snapshot;
  const decisions = [...wakes.asked, ...wakes.resolved, ...wakes.withdrawn].map(d => d.id);
  const work = result.state !== 'waiting' && (result.addressed.length > 0 || result.tasks.length > 0 || decisions.length > 0);
  return { admitted: true, work, state: result.state, addressed: result.addressed, tasks: result.tasks.map(t => t.id), decisions };
}

/**
 * Wait until this agent is addressed in the browser room (same semantics as local `listen`). Calling it means the
 * agent is idle; returning what addressed it means it is working on that until it listens again.
 *
 * With `history`, this is the agent's first listen (or one --from-start): it always answers `state: history`, with the
 * conversation so far, which may be empty, instead of waiting for someone to speak. Open assignments and asks it finds
 * are part of that history too.
 */
export async function listenBrowser(agent: BrowserAgent, after: string | undefined, seconds: number, boardAfter?: number, decisionsAfter?: number, outcomesAfter?: number, history = false,
  restartRunner?: () => Promise<void>) {
  const started = Date.now(), deadline = started + seconds * 1000, historyBy = started + Math.min(seconds * 1000, FIRST_LISTEN_GRACE_MS);
  let beat = 0, runnerSince = started, restarted = false;
  while (true) {
    const closed = roomClosed(agent);
    const snapshot = listenSnapshot(agent, { after, boardAfter, decisionsAfter, outcomesAfter, history }, Date.now() >= historyBy);
    if (!snapshot && !closed) throw new Error('This agent is not admitted to the browser room yet.');
    /** A return that consumes nothing: the cursors stay where they were, and what it observed is only counted. */
    const unchanged = (state: 'timeout' | 'closed' | 'runner-stopped', extra: Record<string, unknown> = {}) => {
      const view = snapshot?.view, result = snapshot?.result;
      // Asks before outcomesAfter were checked and did not wake, so moving the cursor past them loses nothing.
      return { state, roomId: agent.roomId, participantId: view?.memberId, floor: view?.floor, messages: [], cursor: after,
        boardCursor: boardAfter ?? view?.boardRevision, decisionCursor: decisionsAfter === undefined ? snapshot?.decisionCursor ?? 0 : Math.max(decisionsAfter, outcomesAfter ?? 0),
        observed: result?.messages.filter(m => m.authorId !== view?.memberId).length ?? 0, ...extra };
    };
    // Nothing more will arrive, and nothing can be answered: say so now rather than at the end of the wait.
    if (closed) return unchanged('closed', { error: `${closed.reason} Stop listening to this room.` });
    const { view, result, wakes, decided, decisionCursor } = snapshot!;
    if (result.state !== 'waiting') {
      // History without anything for this agent is catching up, not work.
      if (result.addressed.length || result.tasks.length || decided) agent.recordActivity('working', { messages: result.addressed.slice(-8), tasks: result.tasks.map(t => t.id).slice(-8) });
      else agent.recordActivity('idle');
      // Messages that went to every agent: one of them answers, the first to claim it.
      const toClaim = result.addressed.filter(id => { const m = resolveMessageById(view.messages, id); return !!m && needsClaim(view, m); });
      return { roomId: agent.roomId, participantId: view.memberId, floor: view.floor, historyForNewcomers: view.historyForNewcomers, ...result, decisionCursor,
        ...(toClaim.length ? { claim: { messages: toClaim, note: CLAIM_NOTE } } : {}),
        ...(decided ? { decisions: { asked: wakes.asked.map(d => describeDecision(agent, d)), resolved: wakes.resolved.map(d => describeDecision(agent, d)),
          ...(wakes.withdrawn.length ? { withdrawn: wakes.withdrawn.map(d => describeDecision(agent, d)) } : {}) } } : {}) };
    }
    if (!beat || Date.now() - beat >= LISTEN_HEARTBEAT_MS) { if (beat) agent.touchActivity(); else agent.recordActivity('idle'); beat = Date.now(); }
    if (Date.now() >= deadline) { agent.touchActivity(); return unchanged('timeout'); }
    // The files only change while the runner runs: a long wait on a stopped one would never hear anything. Start it
    // again once; if that one stops too, hand the question back to the agent instead of waiting on frozen files.
    if (runnerStopped(agent, runnerSince)) {
      if (!restartRunner || restarted) {
        // In a WAKE the message above would be a lie: a wake's listen never restarts the runner (the
        // watcher owns it), so "run listen again" cannot help and telling the model that is a loop.
        // This lives in #57, not only the Hermes adapter, because the MCP server ALWAYS runs in wake
        // mode (serveMcp sets MESHROOMS_WAKE_ROOM for its whole process), so a wake served through the
        // MCP tools hits this path too. A wake says what is actually true instead: the work is still
        // there, someone else must bring the connection back, and the agent should stop rather than retry.
        const waking = process.env.MESHROOMS_WAKE_ROOM === agent.roomId;
        return unchanged('runner-stopped', { error: waking
          ? 'This agent has no live connection to the room right now, so the room cannot be read from here. Do not retry: nothing you do in this wake restarts it. Report this and end your turn.'
          : 'The background process stopped. Run listen again; it starts the process again.' });
      }
      restarted = true; await restartRunner(); runnerSince = Date.now();
    }
    await Bun.sleep(500);
  }
}

/**
 * `listen` that remembers: cursors not given as flags continue from where the last `listen` returned, and the cursors it
 * returns are saved before the agent sees them, like reading a mailbox. The bridge cannot tell whether the agent acted on
 * what it read, so an agent that lost a result (it crashed) recovers with `fromStart`: history again, and a wake for every
 * open assignment and every open decision still asking it. A timeout keeps the message and board cursors, so nothing it
 * observed is lost.
 *
 * With nothing saved, the first listen returns history (empty in a room without messages yet, after FIRST_LISTEN_GRACE_MS
 * rather than the whole wait), plus open assignments and open asks from any time (they
 * wake it once, then the cursors move past them). Outcomes of decisions the agent opened wake it only from now on, so an
 * agent that starts over is not flooded with results it already had.
 */
export async function listenRemembering(agent: BrowserAgent, seconds: number,
  flags: { after?: string; boardAfter?: number; decisionsAfter?: number; fromStart?: boolean; restartRunner?: () => Promise<void> } = {}) {
  const { plan, saved } = listenPlan(agent, flags);
  const result = await listenBrowser(agent, plan.after, seconds, plan.boardAfter, plan.decisionsAfter, plan.outcomesAfter, plan.history, flags.restartRunner);
  const next: ListenCursor = { ...(result.cursor ? { after: result.cursor } : {}), boardAfter: result.boardCursor ?? 0, decisionsAfter: result.decisionCursor };
  const unchanged = !!saved && saved.after === next.after && saved.boardAfter === next.boardAfter && saved.decisionsAfter === next.decisionsAfter;
  const explicit = !!flags.fromStart || flags.after !== undefined || flags.boardAfter !== undefined || flags.decisionsAfter !== undefined;
  if (result.state !== 'runner-stopped' && result.state !== 'closed' && !(result.state === 'timeout' && unchanged)) {
    agent.saveListenCursor(next, undefined, { monotonic: !explicit });
  }
  const resumed = !!saved && (flags.after === undefined || flags.boardAfter === undefined || flags.decisionsAfter === undefined);
  return resumed ? { ...result, resumed } : result;
}

/**
 * Claims a message that went to every agent (`needsClaim` in src/collab.ts) with the room service, which settles who got
 * there first, and keeps the answer in the agent's rules so `send`, `listen` and the runner see it before the next poll.
 * Returns who holds it now, or null once released. A room service from before claims answers undefined: nobody can hold
 * one there, and agents answer as before.
 */
export async function claimMessage(agent: BrowserAgent, messageId: string, change: { answered?: true; release?: true } = {}, timeoutMs = 10_000): Promise<Claim | null | undefined> {
  let claim: Claim | null | undefined;
  try { claim = (await agent.command('claim', { messageId, ...change }, randomUUID(), timeoutMs)).claim; }
  catch (error: any) { if (error?.status === 400 && /Unknown room action/.test(error.message)) return undefined; throw error; }
  if (claim === undefined) return undefined;
  agent.noteClaim(messageId, claim);
  return claim;
}

const memberName = (view: { participants: { id: string; name?: string }[] }, id: string) => view.participants.find(p => p.id === id)?.name;

/** Why a reply may not go: `answeredBy` when another agent has the message (named, or '' when unknown), else a refusal. */
export type ClaimVerdict = { reason: string; answeredBy?: string };
/** A message another agent answers: an expected outcome for the agent, not a failed delivery. */
const answeredElsewhere = (by: string | undefined): ClaimVerdict => ({ reason: claimRefusal(by), answeredBy: by ?? '' });

/**
 * What `send` returns when the reply did not go because another agent has the message: exit 0, `status: not-sent`,
 * `reason: answered-by-another`, so a channel records it as handled elsewhere rather than as a failed delivery.
 */
export const notSent = (messageId: string, verdict: ClaimVerdict) =>
  ({ messageId, status: 'not-sent' as const, reason: 'answered-by-another' as const, answeredBy: verdict.answeredBy || 'another agent', note: verdict.reason });

/**
 * Before an agent's reply to a message that went to every agent is signed: claim it, and say why not when another agent
 * got there first. The room service decides; one from before claims lets every agent answer, as before; one out of reach
 * leaves it to the claims this device last heard. Undefined: the reply may go.
 */
export async function settleClaim(agent: BrowserAgent, view: { memberId?: string; participants: { id: string; name?: string }[]; claims?: Claim[]; messages: Message[] }, messageId: string, timeoutMs = 10_000): Promise<ClaimVerdict | undefined> {
  let claim: Claim | null | undefined;
  try { claim = await claimMessage(agent, messageId, {}, timeoutMs); }
  catch (error: any) {
    // The agent holds as many unanswered messages as it may: answer or release one first.
    if (error?.status === 429) return { reason: error.message };
    const holder = claimHolder(view, messageId);
    return holder && holder !== view.memberId ? answeredElsewhere(memberName(view, holder)) : undefined;
  }
  // Another agent's answered claim counts past its time only once this device holds the answer, as everywhere.
  const holder = claim ? claimHolder({ claims: [claim], messages: view.messages }, messageId) : undefined;
  return holder && holder !== view.memberId ? answeredElsewhere(memberName(view, holder)) : undefined;
}

/**
 * `claim`: take (or with `release`, give back) a message that went to every agent, before working on it, so the others
 * know to stay quiet. `send` claims too when it replies to one, so this matters for work that takes a while.
 */
export async function claimBrowser(agent: BrowserAgent, messageId: string, release = false, seconds = 15) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  if (agent.person) throw new Error('Only agents claim messages.');
  const target = resolveMessageById(view.messages, messageId);
  if (!target) throw new Error('No message in this room has that id. Use a message id from listen.');
  if (!needsClaim(view, target)) throw new Error('This message is not one that goes to every agent (a person’s message on an open floor that names nobody and replies to nothing), so it needs no claim. Answer it if it addresses you.');
  if (!release && !wakes({ ...view, claims: [] }, target, view.memberId)) throw new Error('This message does not wake this agent (it answers only its operator), so it is not one for it to answer.');
  let claim: Claim | null | undefined;
  if (agent.stateless) claim = await claimMessage(agent, messageId, release ? { release: true } : {});
  else {
    // The runner settles it: it can reach the room service, which a sandboxed wake may not.
    const id = randomUUID(), outbox = join(agent.dir, 'outbox');
    writeJson(join(outbox, `${Date.now()}-${id}.json`), { type: 'claim', id, messageId, ...(release ? { release: true } : {}) });
    const deadline = Date.now() + seconds * 1000;
    let answer: { claim?: Claim | null; unsupported?: true; error?: string } | undefined;
    while (!answer && Date.now() < deadline) {
      const dropped = takeDropped(outbox, id);
      if (dropped) throw new Error(dropped);
      const note = takeDropped(outbox, id, 'claim');
      if (note) answer = JSON.parse(note); else await Bun.sleep(200);
    }
    if (!answer) {
      // Withdrawn, so a runner that comes back later doesn't take a claim the agent stopped waiting for.
      for (const f of readdirSync(outbox)) if (f.endsWith(`-${id}.json`)) rmSync(join(outbox, f), { force: true });
      if (takeDropped(outbox, id, 'claim') === undefined) return { messageId, claimed: false, status: 'not-settled', note: 'The bridge could not settle the claim in time; nothing was claimed. send claims the message when you reply.' };
      answer = { error: 'The bridge settled the claim just as the wait ended. Run claim again to see who holds it.' };
    }
    if (answer.error) throw new Error(answer.error);
    claim = answer.unsupported ? undefined : answer.claim ?? null;
  }
  if (claim === undefined) return { messageId, claimed: false, note: 'This room service does not settle claims yet. Answer as agents did before.' };
  if (claim === null) return { messageId, released: true };
  const answered = claim.answered ? { answered: true } : {};
  if (claim.memberId === view.memberId) return release ? { messageId, released: false, ...answered, note: 'You already answered it.' } : { messageId, claimed: true, until: new Date(claim.until).toISOString(), ...answered };
  const holder = memberName(view, claim.memberId);
  return { messageId, claimed: false, claimedBy: holder ?? 'Another agent', ...answered, note: claimRefusal(holder) };
}

/** What `listen` tells an agent about messages that went to every agent. */
export const CLAIM_NOTE = 'These went to every agent, and one of them answers. Decide whether you are the one to answer; if so, claim it (claim --message ID) before you work on it, and claim it again every few minutes while the work takes longer. If another agent has it, stay quiet. Answer with a reply to the message (--reply-to): the bridge claims it then too, and if another agent got there first send answers status not-sent, reason answered-by-another: stay quiet then.';

/** Queue a message for `run` to sign and deliver; waits until peers store it or the timeout passes. */
export async function sendBrowser(agent: BrowserAgent, text: string, replyTo: string | undefined, requestId: string, attach: string[] = []) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  if ((!text.trim() && !attach.length) || text.length > 4000) throw new Error('Write a message of up to 4,000 characters.');
  if (attach.length > MAX_MESSAGE_ATTACHMENTS) throw new Error(`Attach up to ${MAX_MESSAGE_ATTACHMENTS} files per message.`);
  if (replyTo && !view.messages.some(m => m.id === replyTo)) throw new Error('The reply target is not in this browser room.');
  const id = requestId; // Stable per logical send, so a retry never duplicates.
  const sent = agent.messages().find(m => m.packet.body.id === id), outbox = join(agent.dir, 'outbox');
  const queued = !sent && existsSync(outbox) && readdirSync(outbox).some(f => f.endsWith(`-${id}.json`));
  // A retry of a message already on its way isn't checked again: the claim it took may have lapsed since.
  if (!sent && !queued) {
    // A message that went to every agent is answered by the one that claims it first. The runner claims it before it
    // signs the reply, and drops the reply when another agent got there first; refuse here at once when this device
    // already knows that.
    const target = replyTo ? resolveMessageById(view.messages, replyTo) : undefined;
    if (!agent.person && target && heldByAnother(view, target, view.memberId)) return notSent(id, answeredElsewhere(memberName(view, takenBy(view, target)!)));
    if (!mayAgentSpeak(view, view.memberId, replyTo, text, true)) throw new Error(speakRefusal(view.floor));
  }
  if (agent.activity()?.state === 'working') agent.touchActivity();
  let attachments = sent?.packet.body.attachments;
  if (!sent) {
    const files = attach.map(path => {
      const size = statSync(path).size;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error(`${basename(path)} is ${Math.ceil(size / 1024 / 1024)} MB; attach files of 10 MB or less.`);
      return { path, bytes: new Uint8Array(readFileSync(path)) };
    });
    // Stored before the message is queued, so `run` can serve each file as soon as a peer asks.
    attachments = await Promise.all(files.map(async ({ path, bytes }) => { const ref = await attachmentRef(bytes, basename(path)); agent.files.add(bytes); return ref; }));
    if (!queued) writeJson(join(outbox, `${Date.now()}-${id}.json`), { id, text: text.trim(), ...(replyTo ? { replyTo } : {}), ...(attachments.length ? { attachments } : {}) });
  }
  const files = attachments?.length ? { attachments } : {};
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    // The runner dropped it (another agent claimed what it replies to): say why, rather than that it is still queued.
    const dropped = takeDropped(outbox, id);
    if (dropped) {
      // Another agent answers it: not a failure. Anything else the runner noted is.
      let verdict: ClaimVerdict | undefined;
      try { const parsed = JSON.parse(dropped); if (typeof parsed?.reason === 'string' && typeof parsed.answeredBy === 'string') verdict = parsed; } catch { /* a plain reason */ }
      if (verdict) return notSent(id, verdict);
      throw new Error(dropped);
    }
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
  // By rename: a link planted at the name in wants/ is replaced, never written through.
  if (!bytes) replaceFile(want, '');
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
export async function taskBrowser(agent: BrowserAgent, input: { requestId: string; taskId?: string; revision?: number; change: TaskChange; removed?: boolean }, waitMs = 10_000) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  const { change } = input;
  if (change.title !== undefined && (!change.title.trim() || change.title.trim().length > 120)) throw new Error('Give the task a title of up to 120 characters.');
  if (change.notes !== undefined && change.notes.trim().length > 2000) throw new Error('Keep task notes to 2,000 characters.');
  if (change.assigneeId && !view.participants.some(p => p.id === change.assigneeId)) throw new Error('The assignee is not a member of this room.');
  if (change.issue != null && !validIssueLink(change.issue)) throw new Error('Link a GitHub issue or pull request, like https://github.com/owner/name/issues/42.');
  const done = agent.taskOps().find(p => p.body.id === input.requestId);
  // A new task takes the request id as its task id, so retrying the same request never creates a second task.
  const taskId = input.taskId ?? input.requestId;
  if (!done && input.taskId) {
    const current = view.tasks.find(t => t.id === input.taskId);
    if (!current) throw new Error('That task is not on the board. Run tasks for current task IDs.');
    if (input.revision !== undefined && current.revision !== input.revision) throw new Error(`The task changed since you read it (now revision ${current.revision}). Read tasks again, then retry.`);
  }
  if (!done && !input.taskId && !change.title?.trim()) throw new Error('Use --title for the new task.');
  const alreadyQueued = readdirSync(join(agent.dir, 'outbox')).some(f => f.endsWith(`-${input.requestId}.json`));
  if (!done && !alreadyQueued) writeJson(join(agent.dir, 'outbox', `${Date.now()}-${input.requestId}.json`), { type: 'task', id: input.requestId, taskId, change, ...(input.removed ? { removed: true } : {}) } satisfies TaskIntent);
  taskActivity(agent, taskId, change.status, !!input.removed);
  const deadline = Date.now() + waitMs;
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
  if (!view.messages.some(m => m.id === input.messageId && !m.deleted)) throw new Error('That message is not in this browser room.');
  const emoji = input.emoji;
  const already = memberReacted(agent.reactionChips(), input.messageId, emoji, view.memberId);
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
    ...(d.closesAt ? { closesAt: safeIso(d.closesAt) } : {}),
    // An outcome is final only once every vote it counted has arrived here (verified); uncounted votes came after it closed.
    ...(d.state === 'closed' && d.outcome ? { outcome: { result: d.outcome.result, options: d.outcome.optionIds.map(label), voters: d.outcome.voters, people: d.outcome.people,
      verified: d.verified, ...(d.uncounted ? { uncounted: d.uncounted } : {}) } }
      : { leading: d.tally.result === 'no-votes' ? [] : d.tally.optionIds.map(label), voters: d.tally.voters, people: d.tally.people, settled: d.settled }),
    votes: d.votes.map(v => ({ by: name(v.memberId), counts: v.counts, option: label(v.optionId), ...(v.comment ? { comment: v.comment } : {}) })) };
}

/** Why `run` could not sign a queued decision change, kept next to the outbox for the command waiting on it. */
export function noteDropped(outbox: string, id: string, reason: string, kind: 'dropped' | 'claim' = 'dropped') {
  // The id names the file, so it must be a UUID; written by rename, so a link planted at the name is replaced, not followed.
  if (!UUID.test(id)) return;
  replaceFile(join(outbox, `${id}.${kind}`), reason);
}
/** The reason `run` noted for dropping a change (or, `claim`, how it settled a claim), read once. */
export function takeDropped(outbox: string, id: string, kind: 'dropped' | 'claim' = 'dropped') {
  const note = join(outbox, `${id}.${kind}`);
  // The outbox is writable by a sandboxed wake: only a small regular file is read, never a link to something else.
  let found; try { found = lstatSync(note); } catch { return undefined; }
  if (!found.isFile() || found.size > 4096) { rmSync(note, { force: true }); return undefined; }
  const reason = readFileSync(note, 'utf8'); rmSync(note, { force: true });
  return reason;
}

/** Queue a decision change for `run` to sign and share; returns the decision once this device holds the change. */
export async function decisionBrowser(agent: BrowserAgent, intent: DistributiveOmit<DecisionIntent, 'type'>, seconds = 10) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  const current = pickDecision(agent.decisions(), intent.decisionId, view.memberId);
  const done = agent.madeDecisionOp(intent.id);
  // A retry of a change compaction has since dropped: it was made, and a later change of this agent replaced it.
  if (done && !agent.decisionOps().some(p => p.body.id === intent.id)) return superseded(agent, intent.decisionId, view.memberId);
  if (!done && intent.action !== 'open') {
    if (!current) throw new Error('That decision is not in this room. Run decisions for current ids.');
    if (current.state !== 'open') throw new Error(`This decision is already ${current.state}.`);
    if (intent.action === 'vote' && intent.optionId !== null && !current.options.some(o => o.id === intent.optionId))
      throw new Error(`Choose one of: ${current.options.map(o => `${o.id} (${o.label})`).join(', ')}.`);
    const { ownerId, members } = agent.members();
    const steward = current.createdBy === view.memberId || view.memberId === ownerId || members.some(m => m.id === current.createdBy && m.operatorId === view.memberId);
    if ((intent.action === 'close' || intent.action === 'withdraw') && !steward) throw new Error('Only the person or agent who opened it, its operator, or the host can close it.');
    if (intent.action === 'option' && current.mode === 'plan-review') throw new Error('Plan reviews keep Approve / Request changes / Reject.');
    if (intent.action === 'option' && (!intent.label || !intent.label.trim())) throw new Error('Give the new option a label.');
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
    if (!pending && agent.compactedDecisionIds().has(intent.id)) return superseded(agent, intent.decisionId, view.memberId);
    if (!pending) return { status: 'dropped', reason: takeDropped(join(agent.dir, 'outbox'), intent.id) ?? 'The change no longer applied when it was signed (the decision closed or changed). Read it again.' };
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
  const decisionKeys = new Set(held.filter(b => b.kind === 'decision').map(b => `${b.createdBy}:${b.decisionId}`));
  const accepted: DecisionPacket[] = [];
  for (const p of [...decisions, ...votes]) {
    if (held.length + accepted.length >= MAX_DECISION_OPS) break;
    if (!keep.has(p.body.id)) continue;
    const key = `${p.body.createdBy}:${p.body.decisionId}`;
    if (p.body.kind === 'vote' && (!decisionKeys.has(key) || !await genuine(p.body, p.signature))) continue;
    if (p.body.kind === 'decision') decisionKeys.add(key);
    accepted.push({ body: p.body, signature: p.signature });
  }
  return accepted;
}

/**
 * Compact the log and remember every one of this agent's own operations that was dropped, so their request ids stay
 * spent for good (a reused request id never signs twice). The list grows only with this agent's own changes.
 */
export function compactDecisionLog(agent: BrowserAgent, ops: StoredDecisionOp[], memberId: string | undefined): StoredDecisionOp[] {
  const next = compactDecisions(ops), kept = new Set(next.map(p => p.body.id));
  const dropped = ops.filter(p => !kept.has(p.body.id) && p.body.memberId === memberId).map(p => p.body.id);
  if (dropped.length) {
    const done = readJsonStrict<string[]>(join(agent.dir, 'decisions-done.json'), []);
    writeJson(join(agent.dir, 'decisions-done.json'), [...new Set([...done, ...dropped])]);
  }
  return next;
}
/** The stored log, compacted first if it grew past the threshold; the arrival cursor is kept. */
export function compactStoredDecisions(agent: BrowserAgent, memberId: string | undefined): StoredDecisionOp[] {
  const ops = readJsonStrict<StoredDecisionOp[]>(join(agent.dir, 'decisions.json'), []);
  if (ops.length <= COMPACT_DECISIONS_AT) return ops;
  const cursor = Math.max(readJsonStrict<{ seq: number }>(join(agent.dir, 'decisions-cursor.json'), { seq: 0 }).seq, ops.at(-1)?.seq ?? 0);
  writeJson(join(agent.dir, 'decisions-cursor.json'), { seq: cursor });
  const next = compactDecisionLog(agent, ops, memberId);
  writeJson(join(agent.dir, 'decisions.json'), next);
  return next;
}
function superseded(agent: BrowserAgent, decisionId: string, me: string | undefined) {
  const decision = pickDecision(agent.decisions(), decisionId, me);
  return { status: 'superseded', reason: 'This change was made earlier and a later change of yours has replaced it; nothing was signed again.',
    decision: decision ? describeDecision(agent, decision) : null };
}

/**
 * Computes `{ wake, hold }` metadata for a primary-lane relay envelope using the room's standard wake rules
 * (`wakes`, `mentionedIds`, `authorWakes`, `assignmentWakes`, `floor`, `agentAssignmentsWake`).
 */
export function computeRelayWakeMeta(
  packet: unknown,
  recipients: readonly RosterEntry[],
  roster: SignedRoster,
  status: RoomStatus | undefined,
  messages: Stored[],
  now: () => number = () => Date.now(),
): { wake?: string[]; hold?: true } {
  const senderId = (packet as { body?: { deviceId?: string } } | null)?.body?.deviceId;
  const selfWakeable = !!(senderId && roster.body.devices.find(d => d.id === senderId)?.wakeable);
  const anyRecipientWakeable = recipients.some(r => r.wakeable === true);
  const hold = selfWakeable || anyRecipientWakeable ? true as const : undefined;
  const wakeableAgents = recipients.filter(r => r.wakeable === true && r.role === 'agent');
  if (!wakeableAgents.length || !status?.members) return hold ? { hold } : {};

  const participants: Participant[] = status.members.map(m => ({
    id: m.id, name: m.name, role: m.role ?? 'human', state: 'remote', detail: '',
    ...(m.operatorId ? { operatorId: m.operatorId } : {}),
  }));
  const floor = status.settings?.floor ?? 'humans-first';
  const agentAssignmentsWake = !!status.settings?.agentAssignmentsWake;
  const canonicalKeys = canonicalMessageKeys(messages);
  const history: Message[] = messages.map(({ packet: { body }, retracted }) => {
    const author = participants.find(p => p.id === body.memberId);
    const text = retracted ? 'Message deleted' : shownText(body);
    const mentions = mentionedIds(text, participants);
    const collidingCopy = canonicalKeys.get(body.id) !== messageKey(body.deviceId, body.id);
    return {
      id: body.id, authorId: body.memberId, author: author?.name ?? 'Former member', role: author?.role ?? 'human',
      text, time: safeIso(body.at), deviceId: body.deviceId,
      ...(collidingCopy ? { collidingCopy: true as const } : {}),
      ...(retracted ? { deleted: true } : {}),
      ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
  });
  const roomView = { floor, agentAssignmentsWake, participants, messages: history };
  const body = (packet as { body?: Record<string, unknown> } | null)?.body;
  if (!body || typeof body !== 'object') return hold ? { hold } : {};

  const wake = new Set<string>();
  if (body.kind === 'message' && typeof body.text === 'string' && typeof body.memberId === 'string' && typeof body.id === 'string') {
    const author = participants.find(p => p.id === body.memberId);
    const mentions = mentionedIds(body.text, participants);
    const msg: Message = {
      id: body.id,
      authorId: body.memberId,
      author: author?.name ?? 'Member',
      role: author?.role ?? 'human',
      text: body.text,
      time: safeIso(typeof body.at === 'number' ? body.at : now()),
      ...(typeof body.replyTo === 'string' ? { replyTo: body.replyTo } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
    for (const entry of wakeableAgents) {
      if (wakes(roomView, msg, entry.memberId)) wake.add(entry.id);
    }
  } else if (body.kind === 'task' && typeof body.assigneeId === 'string' && typeof body.memberId === 'string') {
    const task: Task = {
      id: String(body.taskId ?? body.id ?? ''),
      title: String(body.title ?? ''),
      notes: String(body.notes ?? ''),
      status: body.status === 'doing' || body.status === 'done' ? body.status : 'todo',
      assigneeId: body.assigneeId,
      assignedBy: body.memberId,
      createdBy: body.memberId,
      updatedBy: body.memberId,
      updatedAt: safeIso(typeof body.at === 'number' ? body.at : now()),
      revision: typeof body.revision === 'number' ? body.revision : 1,
    };
    for (const entry of wakeableAgents) {
      if (assignmentWakes(roomView, task, entry.memberId)) wake.add(entry.id);
    }
  } else if (body.kind === 'decision' && typeof body.memberId === 'string') {
    const askAgents = body.askAgents;
    for (const entry of wakeableAgents) {
      const asked = askAgents === true || (Array.isArray(askAgents) && askAgents.includes(entry.memberId));
      if (asked && authorWakes(roomView, entry.memberId, body.memberId)) wake.add(entry.id);
    }
  }
  return { ...(wake.size ? { wake: [...wake] } : {}), ...(hold ? { hold } : {}) };
}

/** How long a relay-once send waits for the relay to accept the frame when it is not waiting for peer receipts. */
const RELAY_ACCEPT_TIMEOUT_MS = 10_000;
/** Maximum age of a host-signed roster accepted for cold stateless sends without local disk state. */
export const ROSTER_FRESHNESS_MS = 15 * 60_000;
/** Maximum allowed forward clock skew on a host-signed roster timestamp. */
export const ROSTER_MAX_FUTURE_SKEW_MS = 60_000;
/** Interval at which an online host device refreshes its signed roster so cold senders see a fresh `at`. */
export const ROSTER_REFRESH_MS = 5 * 60_000;

/** Reads optional independent `MESHROOMS_MIN_ROSTER_VERSION` floor outside the relay's rollback domain. */
export function parseEnvMinRosterVersion(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.MESHROOMS_MIN_ROSTER_VERSION;
  if (raw === undefined || !raw.trim()) return undefined;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error('MESHROOMS_MIN_ROSTER_VERSION must be a positive integer.');
  }
  return n;
}

/** Builds and signs the next monotonic host-signed `SignedRoster` if devices/removals changed or refresh is due. */
export async function buildNextHostRoster(
  status: RoomStatus,
  hostDeviceId: string,
  currentRoster: SignedRoster | undefined,
  signFn: (value: unknown) => Promise<string>,
  now = Date.now(),
  refreshMs = ROSTER_REFRESH_MS,
): Promise<SignedRoster | undefined> {
  const entries: RosterEntry[] = [];
  for (const dev of status.devices || []) {
    if (!dev.enc || !dev.encVersion || !dev.encSig) continue;
    const okRoom = await verifyEncBinding(dev.publicKey, { room: status.roomId, deviceId: dev.id, enc: dev.enc, encVersion: dev.encVersion }, dev.encSig);
    const okWild = okRoom || await verifyEncBinding(dev.publicKey, { room: '*', deviceId: dev.id, enc: dev.enc, encVersion: dev.encVersion }, dev.encSig);
    if (!okWild) continue;
    const member = status.members?.find(m => m.id === dev.memberId);
    const role: 'human' | 'agent' = member?.role === 'agent' ? 'agent' : 'human';
    entries.push({
      id: dev.id,
      sign: dev.publicKey,
      enc: dev.enc,
      encVersion: dev.encVersion,
      encSig: dev.encSig,
      memberId: dev.memberId,
      role,
      ...(member?.operatorId ? { operatorId: member.operatorId } : {}),
      ...(dev.wakeable ? { wakeable: true as const } : {}),
    });
  }
  if (!entries.some(e => e.id === hostDeviceId)) return undefined;
  entries.sort((a, b) => a.id.localeCompare(b.id));

  const activeIds = new Set(entries.map(e => e.id));
  const removedMap = new Map<string, RemovedRosterEntry>();
  for (const prev of currentRoster?.body.removed || []) {
    if (!activeIds.has(prev.id)) removedMap.set(prev.id, prev);
  }
  for (const former of status.formerDevices || []) {
    if (!activeIds.has(former.id)) {
      removedMap.set(former.id, {
        id: former.id,
        at: former.retiredAt ?? now,
        revoked: !!former.revoked,
      });
    }
  }
  const removed = [...removedMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  const unchanged = currentRoster
    && currentRoster.body.host === hostDeviceId
    && canonicalJson(currentRoster.body.devices) === canonicalJson(entries)
    && canonicalJson(currentRoster.body.removed) === canonicalJson(removed);
  const stale = !currentRoster || now - currentRoster.body.at >= refreshMs;
  if (unchanged && !stale) return undefined;

  const body: RosterBody = {
    v: 1,
    room: status.roomId,
    version: (currentRoster?.body.version ?? 0) + 1,
    prev: currentRoster ? await hashRosterBody(currentRoster.body) : '',
    at: now,
    host: hostDeviceId,
    devices: entries,
    removed,
  };
  return signRoster(body, signFn);
}

/** Opaque per-device state sealed to the agent's own ECDH key and stored on the relay (<= 256 KB, Section 6.4). */
export type SealedAgentState = {
  v: 1;
  /**
   * Highest version of a HOST-SIGNED roster this agent verified. The only persisted rollback floor: it is read back from
   * here and nowhere else, so a value that did not come from a verified roster can never freeze the agent.
   */
  verifiedRosterVersion?: number;
  /** In-run rollback floor (verified roster version and any operator `--min-roster-version`). Written for readers of older state, never trusted on load. */
  highestRosterVersion: number;
  pinnedHost?: string;
  cursor?: ListenCursor;
  messages: Stored[];
  taskOps: StoredOp[];
  decisionOps: StoredDecisionOp[];
  reactionOps: ReactionPacket[];
  retractOps: RetractPacket[];
  /** Highest per-author-device sequence number this agent signed in this room. */
  lastAuthorSeq?: number;
  /** Relay envelopes (sender + id) already processed, so a replayed envelope is dropped. */
  relaySeen?: RelayReplayRecord;
};

function emptySealedState(): SealedAgentState {
  return {
    v: 1,
    highestRosterVersion: 0,
    messages: [],
    taskOps: [],
    decisionOps: [],
    reactionOps: [],
    retractOps: [],
  };
}

/** Seals `state` into a base64 blob guaranteed <= `SEALED_STATE_MAX_BYTES`, trimming oldest history only if needed. */
async function sealBoundedState(agent: BrowserAgent, state: SealedAgentState): Promise<string> {
  const copy: SealedAgentState = {
    ...state,
    messages: [...state.messages],
    taskOps: [...state.taskOps],
    decisionOps: [...state.decisionOps],
    reactionOps: [...state.reactionOps],
    retractOps: [...state.retractOps],
  };
  let replayTrimmed = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const blob = await agent.sealState(copy);
      if (Buffer.byteLength(blob, 'utf8') <= SEALED_STATE_MAX_BYTES) return blob;
    } catch {
      // Exceeded SEALED_STATE_MAX_BYTES; trim oldest records below.
    }
    if (copy.relaySeen && !replayTrimmed) { copy.relaySeen = RelayReplayGuard.from(copy.relaySeen, 256, 64).export(); replayTrimmed = true; }
    else if (copy.messages.length > 20) copy.messages.splice(0, Math.ceil(copy.messages.length / 4));
    else if (copy.reactionOps.length > 20) copy.reactionOps.splice(0, Math.ceil(copy.reactionOps.length / 2));
    else if (copy.decisionOps.length > 20) copy.decisionOps.splice(0, Math.ceil(copy.decisionOps.length / 2));
    else if (copy.taskOps.length > 20) copy.taskOps.splice(0, Math.ceil(copy.taskOps.length / 2));
    else if (copy.messages.length > 1) copy.messages.shift();
    else break;
  }
  return agent.sealState(copy);
}

function hydrateAgentFromStatusAndSealed(agent: BrowserAgent, status: RoomStatus, state: SealedAgentState) {
  const former = [...new Map((status.formerDevices || []).map(d => [d.memberId, { id: d.memberId, ...(d.role ? { role: d.role } : {}) }])).values()];
  const members: Members = {
    memberId: status.memberId,
    ownerId: status.ownerId,
    ...(typeof status.title === 'string' ? { title: status.title } : {}),
    former,
    members: status.members || [],
    devices: (status.devices || []).map(d => ({ id: d.id, memberId: d.memberId })),
  };
  const settings: RoomRules = {
    floor: status.settings?.floor ?? 'humans-first',
    agentAssignmentsWake: !!status.settings?.agentAssignmentsWake,
    historyForNewcomers: !!status.settings?.historyForNewcomers,
    repositories: status.repositories ?? [],
    claims: status.claims ?? [],
    checkedAt: Date.now(),
  };
  if (agent.stateless) {
    agent.hydrateMemoryState({
      members,
      settings,
      messages: state.messages,
      taskOps: state.taskOps,
      boardSeq: state.taskOps.at(-1)?.seq ?? 0,
      decisionOps: state.decisionOps,
      decisionSeq: state.decisionOps.at(-1)?.seq ?? 0,
      reactionOps: state.reactionOps,
      retractOps: state.retractOps,
      listenCursor: state.cursor,
    });
  } else {
    writeJson(join(agent.dir, 'members.json'), members);
    writeJson(join(agent.dir, 'settings.json'), settings);
    writeJson(join(agent.dir, 'messages.json'), state.messages);
    writeJson(join(agent.dir, 'tasks.json'), state.taskOps);
    writeJson(join(agent.dir, 'decisions.json'), state.decisionOps);
    writeJson(join(agent.dir, 'reactions.json'), state.reactionOps);
    writeJson(join(agent.dir, 'retractions.json'), state.retractOps);
    if (state.cursor) agent.saveListenCursor(state.cursor);
  }
}

async function fetchStatusAndVerifyRoster(
  agent: BrowserAgent,
  relayOptions: Partial<RelayClientOptions> | undefined,
  state: SealedAgentState,
  verifyOptions: {
    requireFreshRoster?: boolean;
    maxRosterAgeMs?: number;
    minRosterVersion?: number;
    now?: () => number;
  } = {},
): Promise<{ status: RoomStatus; roster: SignedRoster; relay: RelayClient; sealed: SealedAgentState }> {
  const identity = await agent.ensureIdentity();
  const session = randomUUID();
  const status = await agent.command('status', { session }) as RoomStatus;
  if (!status.memberId || !status.devices?.some(d => d.id === identity.id)) {
    throw Object.assign(new Error('This agent is no longer admitted to the room (removed or not admitted).'), { status: 403, code: 'REMOVED' });
  }
  const selfDev = status.devices.find(d => d.id === identity.id);
  if (!selfDev?.enc || selfDev.enc !== identity.encPublicKey || selfDev.encVersion !== identity.encVersion) {
    await agent.command('profile', await agent.encBinding());
  }
  const relay = await agent.createRelayClient({
    relayUrl: status.relayUrl,
    session,
    ...relayOptions,
  });
  let sealed = state;
  const remoteState = await relay.getSealedState();
  if (remoteState.state) {
    try {
      const unsealed = await agent.unsealState<Partial<SealedAgentState>>(remoteState.state);
      if (unsealed && unsealed.v === 1) {
        // Only `verifiedRosterVersion` (set from host-signed rosters) is trusted. States written before it existed carried a
        // floor that a member could have inflated through envelope metadata, so their `highestRosterVersion` is ignored.
        const storedVerified = typeof unsealed.verifiedRosterVersion === 'number' && Number.isSafeInteger(unsealed.verifiedRosterVersion) && unsealed.verifiedRosterVersion > 0
          ? unsealed.verifiedRosterVersion : 0;
        sealed = {
          v: 1,
          verifiedRosterVersion: Math.max(state.verifiedRosterVersion ?? 0, storedVerified),
          highestRosterVersion: Math.max(state.highestRosterVersion, storedVerified),
          relaySeen: unsealed.relaySeen ?? state.relaySeen,
          pinnedHost: unsealed.pinnedHost ?? state.pinnedHost,
          cursor: unsealed.cursor ?? state.cursor,
          messages: Array.isArray(unsealed.messages) ? unsealed.messages : [],
          taskOps: Array.isArray(unsealed.taskOps) ? unsealed.taskOps : [],
          decisionOps: Array.isArray(unsealed.decisionOps) ? unsealed.decisionOps : [],
          reactionOps: Array.isArray(unsealed.reactionOps) ? unsealed.reactionOps : [],
          retractOps: Array.isArray(unsealed.retractOps) ? unsealed.retractOps : [],
          ...(typeof unsealed.lastAuthorSeq === 'number' && Number.isSafeInteger(unsealed.lastAuthorSeq) && unsealed.lastAuthorSeq > 0 ? { lastAuthorSeq: unsealed.lastAuthorSeq } : {}),
        };
      }
    } catch {
      // Corrupted or incompatible remote sealed state: proceed with local/empty state.
    }
  }
  if (!status.roster) {
    relay.stop();
    throw Object.assign(new Error('This room has no host-signed roster yet.'), { code: 'NO_ROSTER' });
  }
  const externalMin = verifyOptions.minRosterVersion ?? parseEnvMinRosterVersion();
  const effectiveMinVersion = Math.max(sealed.highestRosterVersion, externalMin ?? 0);
  const expectedHostPin = agent.hostPin ?? sealed.pinnedHost;
  const check = await verifyRoster(status.roster, {
    roomId: agent.roomId,
    expectedHostPin,
    minVersion: effectiveMinVersion > 0 ? effectiveMinVersion : undefined,
  });
  if (!check.ok) {
    relay.stop();
    throw Object.assign(new Error(`Roster verification failed: ${check.reason}`), { code: 'INVALID_ROSTER' });
  }
  if (verifyOptions.requireFreshRoster) {
    const nowMs = (verifyOptions.now ?? Date.now)();
    const maxAge = verifyOptions.maxRosterAgeMs ?? ROSTER_FRESHNESS_MS;
    if (status.roster.body.at > nowMs + ROSTER_MAX_FUTURE_SKEW_MS) {
      relay.stop();
      throw Object.assign(new Error('Host-signed roster timestamp is too far in the future.'), { code: 'STALE_ROSTER' });
    }
    if (nowMs - status.roster.body.at > maxAge) {
      relay.stop();
      throw Object.assign(
        new Error(`Host-signed roster is stale (${Math.round((nowMs - status.roster.body.at) / 1000)}s old > ${Math.round(maxAge / 1000)}s limit); refusing cold send until the host refreshes the roster.`),
        { code: 'STALE_ROSTER' },
      );
    }
  }
  sealed.verifiedRosterVersion = Math.max(sealed.verifiedRosterVersion ?? 0, status.roster.body.version);
  sealed.highestRosterVersion = Math.max(sealed.highestRosterVersion, status.roster.body.version, externalMin ?? 0);
  sealed.pinnedHost = check.hostDeviceId;
  return { status, roster: status.roster, relay, sealed };
}

/**
 * Ephemeral cloud-agent one-shot listen (`listen --relay-once`, Section 6.4):
 * connects over WSS or HTTPS fallback, verifies the host-signed roster against `hostPin` + sealed state,
 * drains the ciphertext inbox, decrypts and verifies every frame, persists sealed state FIRST (failing
 * closed without sending receipts or acknowledging inbox frames if persistence fails), then sends signed
 * peer receipts and acknowledges the contiguous committed inbox cursor prefix.
 */
export async function relayListenOnce(
  agent: BrowserAgent,
  options: {
    waitSeconds?: number;
    after?: string;
    boardAfter?: number;
    decisionsAfter?: number;
    fromStart?: boolean;
    preferHttps?: boolean;
    minRosterVersion?: number;
    relayOptions?: Partial<RelayClientOptions>;
    now?: () => number;
  } = {},
) {
  const identity = await agent.ensureIdentity();
  const initialState: SealedAgentState = agent.stateless
    ? emptySealedState()
    : {
        v: 1,
        highestRosterVersion: 0,
        pinnedHost: agent.hostPin,
        cursor: agent.listenCursor(),
        messages: agent.messages(),
        taskOps: agent.taskOps(),
        decisionOps: agent.decisionOps(),
        reactionOps: agent.reactionOps(),
        retractOps: agent.retractOps(),
      };
  const { status, roster, relay, sealed } = await fetchStatusAndVerifyRoster(agent, options.relayOptions, initialState, {
    minRosterVersion: options.minRosterVersion,
  });
  try {
    const drained = await relay.drainOnce({
      waitSeconds: options.waitSeconds ?? 0,
      ack: false,
      preferHttps: options.preferHttps,
    });
    const receiptEnvelopes: RelayEnvelope[] = [];
    const rosterDevices = roster.body.devices;
    const findRosterDevice = (deviceId: string) => rosterDevices.find(d => d.id === deviceId);
    const awaiting = (m: Stored) => awaitingDelivery(m, identity.id, new Set(rosterDevices.map(d => d.id)));
    const seen = RelayReplayGuard.from(sealed.relaySeen);
    const clock = options.now ?? Date.now;
    const coldHistoryAcceptLimiter = new PeerRateLimiter(clock, HISTORY_ACCEPT_ENTRIES_PER_MINUTE, HISTORY_ACCEPT_ENTRIES_BURST);
    const coldQuota = new ReceiveQuota(clock);

    for (const item of drained.frames) {
      const env = item.envelope;
      if (env.from === identity.id) continue;
      const sender = findRosterDevice(env.from);
      if (!sender) continue;
      // Replay: this sender's envelope id was already processed and sealed. Dropped here; the inbox copy is acknowledged below.
      if (seen.seen(env.from, env.id)) continue;
      let decrypted: DecryptedRelayEnvelope<unknown>;
      try {
        // Do NOT reject legitimate inbox frames encrypted under an earlier roster version (Section 5.2). The sender signature
        // is verified against the host-signed roster key; the envelope's roster version is sender-chosen and never raises the floor.
        decrypted = await agent.decryptRelay(env, { senderSignKey: sender.sign });
      } catch {
        continue;
      }
      seen.add(env.from, env.id);
      const packet = decrypted.packet as Packet | undefined;
      if (!packet || typeof packet !== 'object') continue;
      if (isHistoryPacket(packet, agent.roomId)) {
        if (packet.retryAfterMs !== undefined && packet.entries.length === 0) continue;
        if (!coldHistoryAcceptLimiter.take(env.from, Math.max(1, packet.entries.length))) continue;
        const held = new Set(sealed.messages.map(m => messageKey(m.packet.body.deviceId, m.packet.body.id)));
        const baseMaxSeq = maxSeqByDevice(sealed.messages);
        const batchAnchor = new Map<string, number>();
        const accepted: Stored[] = [];
        for (const entry of packet.entries) {
          const eb = entry?.body;
          if (!eb || eb.kind !== 'message' || eb.roomId !== agent.roomId || typeof eb.id !== 'string' || !UUID.test(eb.id) || typeof eb.deviceId !== 'string') continue;
          const key = messageKey(eb.deviceId, eb.id);
          if (held.has(key)) continue;
          if (typeof entry.signature !== 'string' || typeof eb.text !== 'string' || !eb.text.trim() || eb.text.length > 4000 || !Number.isSafeInteger(eb.at) || eb.at < 0 || eb.at > MAX_TIME) continue;
          if (eb.replyTo !== undefined && (typeof eb.replyTo !== 'string' || !UUID.test(eb.replyTo))) continue;
          if (eb.attachments !== undefined && !validAttachments(eb.attachments)) continue;
          if (!validMessageVisibility(eb.visibility) || !validMessageSeq(eb.seq) || !validAudienceUntil(eb.audienceUntil)) continue;
          const maxHeld = baseMaxSeq.get(eb.deviceId) ?? batchAnchor.get(eb.deviceId) ?? 0;
          if (!withinSeqJump(eb.seq, maxHeld)) continue;
          const activeAuthor = findRosterDevice(eb.deviceId);
          const author = activeAuthor
            ? (() => {
                if (activeAuthor.memberId !== eb.memberId) {
                  const statusDev = status.devices?.find(d => d.id === eb.deviceId);
                  const prior = statusDev?.priorMembers?.find(p =>
                    p.memberId === eb.memberId && (p.retiredAt === undefined || eb.at <= p.retiredAt));
                  if (prior) return { publicKey: activeAuthor.sign, memberId: prior.memberId };
                }
                return { publicKey: activeAuthor.sign, memberId: activeAuthor.memberId };
              })()
            : (() => {
                const removed = roster.body.removed.find(r => r.id === eb.deviceId);
                if (removed?.revoked) return undefined;
                const former = status.formerDevices?.find(d => d.id === eb.deviceId);
                if (!former || former.revoked) return undefined;
                return former.retiredAt === undefined || eb.at <= former.retiredAt ? former : undefined;
              })();
          if (!author || eb.memberId !== author.memberId || !await agent.verify(author.publicKey, eb, entry.signature)) continue;
          if (!coldQuota.take(eb.memberId, 'history')) continue;
          held.add(key);
          if (typeof eb.seq === 'number' && !baseMaxSeq.has(eb.deviceId) && !batchAnchor.has(eb.deviceId)) batchAnchor.set(eb.deviceId, eb.seq);
          const savedEntry: Stored = { packet: { body: eb, signature: entry.signature }, targets: [], receipts: [], receivedAt: Date.now(), replicated: true };
          accepted.push(sealed.retractOps.some(op => mayRetract(op.body, eb)) ? retractedStub(savedEntry) : savedEntry);
        }
        if (accepted.length) {
          const { messages: merged } = mergeHistoryMessages(sealed.messages, accepted);
          sealed.messages = windowHistory(merged, awaiting).kept;
        }
        continue;
      }
      const b = (packet as { body?: Record<string, unknown> }).body;
      const sig = (packet as { signature?: unknown }).signature;
      if (!b || typeof sig !== 'string' || b.roomId !== agent.roomId || b.deviceId !== env.from) continue;
      if (!await agent.verify(sender.sign, b, sig)) continue;

      if (b.kind === 'message') {
        const msg = b as unknown as MessageBody;
        if (typeof msg.id !== 'string' || !UUID.test(msg.id) || msg.memberId !== sender.memberId
          || typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 4000
          || !Number.isSafeInteger(msg.at) || msg.at < 0 || msg.at > MAX_TIME) continue;
        if (msg.replyTo !== undefined && (typeof msg.replyTo !== 'string' || !UUID.test(msg.replyTo))) continue;
        if (msg.attachments !== undefined && !validAttachments(msg.attachments)) continue;
        if (!validMessageVisibility(msg.visibility) || !validMessageSeq(msg.seq) || !validAudienceUntil(msg.audienceUntil)) continue;
        const existing = sealed.messages.find(m => m.packet.body.deviceId === msg.deviceId && m.packet.body.id === msg.id);
        if (existing && !isRetracted(existing) && JSON.stringify(existing.packet.body) !== JSON.stringify(msg)) continue;
        if (!existing && !withinSeqJump(msg.seq, maxSeqForDevice(sealed.messages, msg.deviceId))) continue;
        if (!existing) {
          const { kept } = windowHistory([...sealed.messages, { packet: { body: msg, signature: sig }, targets: [], receipts: [], receivedAt: Date.now() }], awaiting);
          sealed.messages = kept;
        }
        // Build signed peer receipt (NEVER relay accepted) and wrap to the sender device.
        const receipt: ReceiptBody = { kind: 'receipt', roomId: agent.roomId, id: msg.id, deviceId: identity.id };
        const receiptPacket = { body: receipt, signature: await agent.sign(receipt) };
        const selfWakeable = !!findRosterDevice(identity.id)?.wakeable;
        const receiptEnv = await encryptRelayEnvelope(receiptPacket, {
          room: agent.roomId,
          from: identity.id,
          id: randomUUID(),
          seq: relay.nextSeq(),
          rosterVersion: roster.body.version,
          lane: 'primary',
          sign: v => agent.sign(v),
          recipients: [sender],
          ...(selfWakeable || sender.wakeable ? { hold: true as const } : {}),
        });
        receiptEnvelopes.push(receiptEnv);
      } else if (b.kind === 'receipt') {
        const rec = b as unknown as ReceiptBody;
        const m = sealed.messages.find(x => x.packet.body.id === rec.id && x.packet.body.deviceId === identity.id);
        if (m && m.targets.includes(env.from) && !m.receipts.includes(env.from)) {
          sealed.messages = sealed.messages.map(x => x === m ? { ...x, receipts: [...x.receipts, env.from] } : x);
        }
      } else if (b.kind === 'task') {
        if (validTaskBody(b, agent.roomId) && b.memberId === sender.memberId && !sealed.taskOps.some(op => op.body.id === b.id)) {
          const nextSeq = (sealed.taskOps.at(-1)?.seq ?? 0) + 1;
          sealed.taskOps = capLiveTasks([...sealed.taskOps, { body: b as unknown as TaskPacket['body'], signature: sig, seq: nextSeq }]);
        }
      } else if (b.kind === 'decision' || b.kind === 'vote') {
        if ((validDecisionBody(b, agent.roomId) || validVoteBody(b, agent.roomId)) && b.memberId === sender.memberId && !sealed.decisionOps.some(op => op.body.id === b.id)) {
          const nextSeq = (sealed.decisionOps.at(-1)?.seq ?? 0) + 1;
          sealed.decisionOps = [...sealed.decisionOps, { body: b as unknown as DecisionPacket['body'], signature: sig, seq: nextSeq }];
        }
      } else if (b.kind === 'reaction') {
        if (validReactionBody(b, agent.roomId) && b.memberId === sender.memberId && !sealed.reactionOps.some(op => opKey(op.body) === opKey(b))) {
          sealed.reactionOps = capReactions([...sealed.reactionOps, { body: b as unknown as ReactionPacket['body'], signature: sig }]);
        }
      } else if (b.kind === 'retract') {
        if (validRetractBody(b, agent.roomId) && b.memberId === sender.memberId && !sealed.retractOps.some(op => opKey(op.body) === opKey(b))) {
          const added = addRetractions(sealed.retractOps, [{ body: b as unknown as RetractPacket['body'], signature: sig }], sealed.messages);
          sealed.retractOps = added.log;
          const applied = applyRetractions(sealed.messages, added.log.map(op => op.body));
          sealed.messages = applied.messages;
          if (applied.changed.length) {
            const stillLive = new Set(sealed.messages.filter(m => !isRetracted(m)).map(m => m.packet.body.id));
            const fullyRetracted = new Set(applied.changed.filter(id => !stillLive.has(id)));
            if (fullyRetracted.size) sealed.reactionOps = sealed.reactionOps.filter(op => !fullyRetracted.has(op.body.messageId));
          }
        }
      }
    }

    sealed.relaySeen = seen.export();
    // Compute the listen output and updated cursor BEFORE persisting sealed state.
    hydrateAgentFromStatusAndSealed(agent, status, sealed);
    const { plan, saved } = listenPlan(agent, {
      after: options.after,
      boardAfter: options.boardAfter,
      decisionsAfter: options.decisionsAfter,
      fromStart: options.fromStart,
    });
    const snapshot = listenSnapshot(agent, plan, true);
    if (!snapshot) throw Object.assign(new Error('This agent is not admitted to the browser room.'), { status: 403 });
    const { view, result, wakes: decisionWakeResult, decided, decisionCursor } = snapshot;

    let output: Record<string, unknown>;
    let nextCursorToPersist: ListenCursor | undefined;
    if (result.state !== 'waiting') {
      output = {
        roomId: agent.roomId,
        participantId: view.memberId,
        floor: view.floor,
        historyForNewcomers: view.historyForNewcomers,
        ...result,
        decisionCursor,
        ...(decided ? {
          decisions: {
            asked: decisionWakeResult.asked.map(d => describeDecision(agent, d)),
            resolved: decisionWakeResult.resolved.map(d => describeDecision(agent, d)),
            ...(decisionWakeResult.withdrawn.length ? { withdrawn: decisionWakeResult.withdrawn.map(d => describeDecision(agent, d)) } : {}),
          },
        } : {}),
      };
      nextCursorToPersist = {
        ...(result.cursor ? { after: result.cursor } : {}),
        boardAfter: result.boardCursor ?? 0,
        decisionsAfter: decisionCursor,
      };
      sealed.cursor = nextCursorToPersist;
    } else {
      output = {
        state: 'timeout',
        roomId: agent.roomId,
        participantId: view.memberId,
        floor: view.floor,
        messages: [],
        cursor: plan.after,
        boardCursor: plan.boardAfter ?? view.boardRevision,
        decisionCursor: plan.decisionsAfter === undefined ? decisionCursor : Math.max(plan.decisionsAfter, plan.outcomesAfter ?? 0),
        observed: result.messages.filter(m => m.authorId !== view.memberId).length,
      };
    }

    // Strict durable commit order:
    // 1) Persist sealed state FIRST. If this fails, abort without sending receipts or acknowledging/deleting inbox frames!
    const blob = await sealBoundedState(agent, sealed);
    await relay.putSealedState(blob);
    if (!agent.stateless && nextCursorToPersist) {
      agent.saveListenCursor(nextCursorToPersist, undefined, { monotonic: !options.fromStart });
    }

    // 2) Only AFTER durable state persistence succeeds, send signed peer receipts and acknowledge the contiguous committed prefix.
    if (receiptEnvelopes.length) {
      await relay.sendOnce(receiptEnvelopes);
    }
    const committedCursor = drained.frames.reduce((max, item) => (item.cursor > max ? item.cursor : max), 0);
    if (committedCursor > 0) {
      await relay.ackInboxCursor(committedCursor);
    }

    const resumed = !!saved && (options.after === undefined || options.boardAfter === undefined || options.decisionsAfter === undefined);
    return { ...(resumed ? { ...output, resumed } : output), carrier: drained.carrier, rosterVersion: roster.body.version };
  } finally {
    relay.stop();
  }
}

/**
 * Stateless / relay-once send (Section 6.4):
 * encrypts the signed message to the current verified host-signed roster (enforcing host-authenticated
 * freshness and optional external `minRosterVersion` floor so a compromised relay cannot roll back both
 * sealed state and roster to re-include a revoked device), sends over WSS/HTTPS relay (with `hold: true`
 * for offline recipients per Section 6.2), and waits up to `waitReceiptMs` (default 30s) for signed peer
 * `receipt` packets from online recipients. Relay `accepted` NEVER counts as a receipt.
 */
export async function relaySendOnce(
  agent: BrowserAgent,
  input: {
    text: string;
    replyTo?: string;
    requestId: string;
    waitReceiptMs?: number;
    maxRosterAgeMs?: number;
    minRosterVersion?: number;
    now?: () => number;
    relayOptions?: Partial<RelayClientOptions>;
  },
) {
  const identity = await agent.ensureIdentity();
  const initialState: SealedAgentState = agent.stateless
    ? emptySealedState()
    : {
        v: 1,
        highestRosterVersion: 0,
        pinnedHost: agent.hostPin,
        cursor: agent.listenCursor(),
        messages: agent.messages(),
        taskOps: agent.taskOps(),
        decisionOps: agent.decisionOps(),
        reactionOps: agent.reactionOps(),
        retractOps: agent.retractOps(),
      };
  const { status, roster, relay, sealed } = await fetchStatusAndVerifyRoster(agent, input.relayOptions, initialState, {
    requireFreshRoster: true,
    maxRosterAgeMs: input.maxRosterAgeMs,
    minRosterVersion: input.minRosterVersion,
    now: input.now,
  });
  hydrateAgentFromStatusAndSealed(agent, status, sealed);

  const view = agent.view();
  if (!view.memberId) throw Object.assign(new Error('This agent is not admitted to the browser room.'), { status: 403 });
  if (!input.text.trim() || input.text.length > 4000) throw new Error('Write a message of up to 4,000 characters.');
  if (input.replyTo && !view.messages.some(m => m.id === input.replyTo)) throw new Error('The reply target is not in this browser room.');
  // Whether the floor lets it speak first (claims aside), so a send refused anyway never takes a claim. Then a reply to a
  // message that went to every agent claims it: this device has no runner to do that for it.
  const target = input.replyTo ? resolveMessageById(view.messages, input.replyTo) : undefined;
  const claimed = !agent.person && !!target && needsClaim(view, target);
  if (!agent.person && !mayAgentSpeak(view, view.memberId, input.replyTo, input.text, true)) throw new Error(speakRefusal(view.floor));
  if (claimed) {
    const refused = await settleClaim(agent, view, target!.id);
    if (refused?.answeredBy !== undefined) return notSent(input.requestId, refused);
    if (refused) throw new Error(refused.reason);
  }

  const recipients = roster.body.devices.filter(d => d.id !== identity.id);
  const visibility: MessageVisibility = status.settings?.historyForNewcomers ? 'room' : 'members';
  const audienceUntil = visibility === 'members' ? currentAudienceUntil(status) : undefined;
  const seq = nextAuthorSeq(sealed.messages, identity.id, sealed.lastAuthorSeq ?? 0);
  const body: MessageBody = {
    kind: 'message',
    roomId: agent.roomId,
    id: input.requestId,
    deviceId: identity.id,
    memberId: view.memberId,
    text: input.text.trim(),
    at: Date.now(),
    visibility,
    seq,
    ...(audienceUntil !== undefined ? { audienceUntil } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  };
  const packet = { body, signature: await agent.sign(body) };
  const existing = sealed.messages.find(m => m.packet.body.deviceId === identity.id && m.packet.body.id === input.requestId);
  if (!existing) {
    sealed.lastAuthorSeq = seq;
    sealed.messages = [...sealed.messages, { packet, targets: recipients.map(r => r.id), receipts: [], receivedAt: Date.now() }];
  }

  const receivedReceipts = new Set<string>(existing?.receipts ?? []);
  const onlineRecipientIds = new Set(
    recipients
      .filter(r => status.devices?.some(d => d.id === r.id && d.session))
      .map(r => r.id),
  );
  const meta = computeRelayWakeMeta(packet, recipients, roster, status, sealed.messages);
  const hold: true | undefined = true; // Ephemeral sender: hold frames for offline recipients per Section 6.2.

  let resolveDone: (() => void) | undefined;
  let relayAccepted = false;
  const allOnlineConfirmed = () => onlineRecipientIds.size > 0 && [...onlineRecipientIds].every(id => receivedReceipts.has(id));
  const waitMs = input.waitReceiptMs ?? 30_000;
  // With `waitMs === 0` the caller does not want to wait for peer receipts, but the frame must still reach the relay:
  // stopping the client before it is flushed would drop the message while reporting it as queued.
  const receiptsWanted = waitMs > 0 && onlineRecipientIds.size > 0;

  const liveRelay = await agent.createRelayClient({
    relayUrl: status.relayUrl,
    rosterVersion: () => roster.body.version,
    ...input.relayOptions,
    onAccepted: () => {
      relayAccepted = true;
      if (!receiptsWanted) resolveDone?.();
    },
    onEnvelope: async (env, envMeta) => {
      if (env.from === identity.id) return;
      const sender = recipients.find(d => d.id === env.from);
      if (!sender) return;
      try {
        // Do NOT reject legitimate in-flight receipt frames encrypted under an earlier roster version.
        const decrypted = await agent.decryptRelay<Packet>(env, { senderSignKey: sender.sign });
        const p = decrypted.packet;
        const b = p?.body;
        if (b && b.kind === 'receipt' && b.roomId === agent.roomId && b.deviceId === env.from && b.id === input.requestId
          && typeof p.signature === 'string' && await agent.verify(sender.sign, b, p.signature)) {
          receivedReceipts.add(env.from);
          if (envMeta.cursor !== undefined) liveRelay.ackCursor(envMeta.cursor);
          if (allOnlineConfirmed()) resolveDone?.();
        }
      } catch { /* Ignore non-matching or undecryptable frames. */ }
    },
  });

  try {
    if (recipients.length > 0) {
      liveRelay.start();
      liveRelay.enqueuePacket(packet, {
        rosterVersion: roster.body.version,
        lane: 'primary',
        recipients,
        ...(meta.wake ? { wake: meta.wake } : {}),
        hold,
      });
      await new Promise<void>(resolve => {
        resolveDone = resolve;
        if ((receiptsWanted && allOnlineConfirmed()) || (!receiptsWanted && relayAccepted)) { resolve(); return; }
        setTimeout(resolve, receiptsWanted ? waitMs : RELAY_ACCEPT_TIMEOUT_MS);
      });
      if (!relayAccepted && receivedReceipts.size === 0) {
        throw Object.assign(
          new Error('The relay did not accept the message in time, so nothing was sent. Retry with the same request id.'),
          { code: 'RELAY_NOT_ACCEPTED' },
        );
      }
    }
    sealed.messages = sealed.messages.map(m =>
      m.packet.body.id === input.requestId
        ? { ...m, receipts: [...new Set([...m.receipts, ...receivedReceipts])] }
        : m,
    );
    const blob = await sealBoundedState(agent, sealed);
    await relay.putSealedState(blob);
    hydrateAgentFromStatusAndSealed(agent, status, sealed);
    if (claimed) await claimMessage(agent, target!.id, { answered: true }).catch(() => undefined);
    return {
      messageId: input.requestId,
      status: receivedReceipts.size > 0 ? 'stored-remotely' : 'queued-for-peers',
      devices: receivedReceipts.size,
      accepted: relayAccepted || receivedReceipts.size > 0,
      held: true,
    };
  } finally {
    liveRelay.stop();
    relay.stop();
  }
}

/** Registers (or clears when `url === null`) a wake webhook signed strictly by this room device key (never an account). */
export async function relayWakeRegister(
  agent: BrowserAgent,
  url: string | null,
  key?: string,
  relayOptions?: Partial<RelayClientOptions>,
): Promise<{ roomId: string; deviceId: string; inboxId: string; wakeable: boolean }> {
  const identity = await agent.ensureIdentity();
  const status = await agent.command('status', { session: randomUUID() }) as RoomStatus;
  if (!status.memberId || !status.devices?.some(d => d.id === identity.id)) {
    throw Object.assign(new Error('This agent is not admitted to the room.'), { status: 403 });
  }
  const relay = await agent.createRelayClient({
    relayUrl: status.relayUrl,
    ...relayOptions,
  });
  try {
    const res = await relay.registerWake(url, key);
    return { roomId: agent.roomId, deviceId: identity.id, inboxId: res.inboxId, wakeable: res.wakeable };
  } finally {
    relay.stop();
  }
}
