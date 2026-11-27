import { assignmentWakes, authorWakes, mentionedIds, wakes, type Task } from '../collab';
import type { Message, Participant } from '../room';
import { COMPACT_AT, MAX_TASK_OPS, capLiveTasks, compactBoard, foldBoard, mayAddTask, syncChunks, taskBody, validTaskBody, withinRevisionJump, type TaskBody, type TaskChange, type TaskPacket } from './board';
import { signerOf, verify, type BrowserDevice, type MessageVisibility, type RoomStatus } from './protocol';
import { BrowserApi } from './client';
import {
  COMPACT_DECISIONS_AT, MAX_DECISION_OPS, admissible, castVote, compactDecisions, decisionChunks, nextVoteRevision, openDecision, reviseDecision, validDecisionBody, validVoteBody,
  type Decision, type DecisionBody, type DecisionPacket, type VoteBody,
} from './decisions';
import { FileTransfers, IMAGE_TYPES, LOW_WATER, MAX_MESSAGE_ATTACHMENTS, attachmentText, autoFetchFiles, isFilePacket, isSha256, retainedFiles, shownText, validAttachments, type AttachmentRef, type TransferState } from './files';
import {
  COMPACT_REACTIONS_AT, MAX_PENDING_PER_MEMBER, MAX_PENDING_REACTIONS, MAX_REACTION_OPS, capReactions, compactReactions, currentRevision,
  foldReactions, isReactionEmoji, mayHoldPending, memberReacted, reactionSyncChunks, validReactionBody,
  type ReactionChip, type ReactionEmoji, type ReactionPacket,
} from './reactions';
import { addRetractions, applyRetractions, isRetracted, mayRetract, opKey, retractedStub, retractionSyncChunks, validRetractBody, type RetractBody, type RetractPacket } from './retractions';
import { FenceError, StorageError, decryptWithEncKey, identity, isPlainObject, read, readArray, readRecord, sign, signDeviceEncKey, update, type Fence } from './storage';
import { isActivityPacket, receiveActivity, validActivityPacket, type ActivityRecord } from './activity';
import { awaitingDelivery, MAX_STORED_MESSAGES, windowHistory } from './history';
import {
  buildHistoryHave, canonicalMessageKeys, currentAudienceUntil, HISTORY_ACCEPT_ENTRIES_BURST,
  HISTORY_ACCEPT_ENTRIES_PER_MINUTE, HISTORY_ROUND_TIMEOUT_MS, HISTORY_SERVE_BURST, HISTORY_SERVE_PER_MINUTE,
  historyChunks, isHistoryHavePacket, isHistoryPacket, MAX_HISTORY_ROUND_TIMEOUTS, MAX_HISTORY_ROUNDS,
  maxSeqByDevice, maxSeqForDevice, mayServeMessage, mergeHistoryMessages, messageKey, nextAuthorSeq,
  PeerRateLimiter, RELAY_HISTORY_RETRY_MS, selectHistoryEntries, validAudienceUntil, validMessageSeq,
  validMessageVisibility, withinSeqJump, type HistoryCursor, type HistoryHavePacket, type HistoryPacket,
} from './history-sync';
import {
  FILE_CHANNEL_LABEL, IncomingGate, PACE_LOW_WATER, PRIMARY_CHANNEL_LABEL, Resync, SYNC_REQUEST, SendQueue,
  answerMatchesOffer, dedupeSignals, evaluatePeerHealth, isLiveOpenPeer, isSyncRequest, sdpIceUfrag,
  type PeerHealthState, type SyncRequest,
} from './pacer';
import { QuotaDrops, ReceiveQuota, type QuotaKind } from './quota';
import {
  canonicalJson, hashRosterBody, parseHostPin, signRoster, verifyEncBinding, verifyRoster,
  type DecryptedRelayEnvelope, type RelayEnvelope, type RelayLane, type RemovedRosterEntry, type RosterBody, type RosterEntry, type SignedRoster,
} from './relay-crypto';
import { RelayClient, type RelayClientOptions } from './relay-client';
import { RelayReplayGuard } from './relay-replay';

/** `replyTo`, `attachments`, `visibility`, `seq` and `audienceUntil` are optional so browsers from before them keep verifying and storing these packets. */
type MessageBody = {
  kind: 'message'; roomId: string; id: string; deviceId: string; memberId: string; text: string; at: number;
  replyTo?: string; attachments?: AttachmentRef[]; visibility?: MessageVisibility; seq?: number; audienceUntil?: number;
};
const isId = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
type ReceiptBody = { kind: 'receipt'; roomId: string; id: string; deviceId: string };
type Packet = { body: MessageBody | ReceiptBody | TaskPacket['body'] | DecisionBody | VoteBody | ReactionPacket['body'] | RetractBody; signature: string };
export type SavedMessage = { packet: Packet & { body: MessageBody }; targets: string[]; receipts: string[]; retracted?: true; receivedAt?: number; replicated?: true };

/**
 * A room as `src/collab.ts`'s wake rules read it: this browser's messages, members and settings. Relay wake targets and the
 * room's "agents paused" notices both read it, so the page shows the same loop guard the wakes obey.
 */
export function roomViewOf(status: Pick<RoomStatus, 'members' | 'settings' | 'claims'>, messages: SavedMessage[]) {
  const participants: Participant[] = (status.members ?? []).map(m => ({
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
      text, time: new Date(body.at).toISOString(), deviceId: body.deviceId,
      ...(collidingCopy ? { collidingCopy: true as const } : {}),
      ...(retracted ? { deleted: true } : {}),
      ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
  });
  return { floor, agentAssignmentsWake, participants, messages: history, claims: status.claims ?? [] };
}
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
/** Online hosts periodically re-sign the roster so cold cloud senders have fresh host-authenticated membership. */
export const ROSTER_REFRESH_MS = 5 * 60_000;
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
  if (!validMessageVisibility(b.visibility) || !validMessageSeq(b.seq) || !validAudienceUntil(b.audienceUntil)) return false;
  if (value.receivedAt !== undefined && (typeof value.receivedAt !== 'number' || !Number.isFinite(value.receivedAt))) return false;
  if (value.replicated !== undefined && value.replicated !== true) return false;
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
  private quota: ReceiveQuota;
  /** Peers whose task, decision, reaction or history operations went over quota; asked for their state again after the burst. */
  private quotaDrops: QuotaDrops;
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
  private seqKey: string;
  /** Highest author `seq` this device ever signed in this room, so evicted/deleted messages never reuse a sequence number. */
  private lastAuthorSeq = 0;
  /** Per-peer token buckets for serving `history-have` and accepting `history` entries, independent of request digests. */
  private historyServeLimiter: PeerRateLimiter;
  private historyAcceptLimiter: PeerRateLimiter;
  private historyRounds = new Map<string, number>();
  /** Per-peer server-side pagination cursor for multi-round history sync. */
  private historyCursors = new Map<string, HistoryCursor>();
  /** Peers for which the current history round had a rate-limit or quota drop (keeps start-of-round cursor for retry). */
  private historyRoundDropped = new Set<string>();
  /** Scheduled retry timestamps (ms) from serving peers' `retryAfterMs` hints or full send queues. */
  private historyRetryAt = new Map<string, number>();
  private historyRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** In-flight `history-have` requests per peer for validating `retryAfterMs` hints and requester-side round timeouts. */
  private historyInFlight = new Map<string, { sentAt: number; expectReply: boolean; timeouts: number }>();
  private historyTimeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Online verified-roster peers we have sent a relay `history-have` to, mapped to the send timestamp for retry. */
  private relayHistorySynced = new Map<string, number>();
  /** Per-peer resync throttles for `SYNC_REQUEST` received over the E2E relay. */
  private relayResync = new Map<string, Resync>();
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
  /** Verified host-signed roster (authoritative recipient & signer set for E2E relay). */
  private verifiedRoster?: SignedRoster;
  /** Highest roster version seen in a verified HOST-SIGNED roster; prevents rollback. Never raised from envelope metadata. */
  private highestRosterVersion = 0;
  /** Relay envelopes (sender + id) already processed and persisted; a repeat is dropped as a replay. Persisted per room. */
  private relaySeen = new RelayReplayGuard();
  private relaySeenKey: string;
  /** Envelopes being processed right now, so a second copy of the same id cannot race the first. */
  private relayInflight = new Set<string>();
  /** File chunks and activity are not persisted state, so their replay record stays in memory (larger, to cover chunk bursts). */
  private relaySeenVolatile = new RelayReplayGuard(8192, 4096);
  /** Pinned host deviceId (or 16-hex prefix from `#h=` URL fragment, else TOFU on first verified roster). */
  private pinnedHost?: string;
  /** Optional WSS+HTTPS E2E relay client; started when `status.relayUrl` is advertised. */
  private relayClient?: RelayClient;
  private statusWatch?: { session: string; epoch?: string; cursor: number };
  /** When this engine first tried to connect to each device session (`device:session`), for connecting(). */
  private firstOffer = new Map<string, number>();
  private pushedStatus?: RoomStatus;
  private onPushedStatus?: () => void;
  /** When each outbox message was last sent over the relay, to obey `RESEND_MS`. */
  private relaySent = new Map<string, number>();
  /** Guard against overlapping encryption-key or roster publication requests. */
  private publishingEnc = false;
  private lastEncPublishAt = 0;
  private publishingRoster = false;
  private lastRosterPublishAt = 0;
  /** Injectable relay decryptor for tests (defaults to browser storage's `decryptWithEncKey`). */
  private decryptRelay: (envelope: unknown, options: { room: string; senderSignKey: string; minRosterVersion?: number; expectedFrom?: string }) => Promise<DecryptedRelayEnvelope<unknown>> = decryptWithEncKey;
  /** Injectable relay client factory for tests. */
  private createRelayClient?: (options: RelayClientOptions) => RelayClient;
  /** Optional listener for verified retraction operations (used by UI gap analysis). */
  private retractionsChanged: (ops: RetractBody[]) => void = () => {};
  constructor(private api: BrowserApi, private roomId: string, private deviceId: string, private session: string,
    private changed: (messages: SavedMessage[], connected: string[], added?: SavedMessage) => void, private error: (message: string) => void,
    private boardChanged: (tasks: Task[], ops: TaskBody[]) => void = () => {}, private filesChanged: (files: Record<string, FileView>) => void = () => {},
    private activityChanged: (activity: Record<string, ActivityRecord>) => void = () => {},
    private decisionsChanged: (ops: (DecisionBody | VoteBody)[]) => void = () => {},
    private reactionsChanged: (chips: ReactionChip[]) => void = () => {},
    private now: () => number = () => Date.now(),
    relayOptions?: {
      hostPin?: string;
      createRelayClient?: (options: RelayClientOptions) => RelayClient;
      decryptRelay?: (envelope: unknown, options: { room: string; senderSignKey: string; minRosterVersion?: number; expectedFrom?: string }) => Promise<DecryptedRelayEnvelope<unknown>>;
      retractionsChanged?: (ops: RetractBody[]) => void;
    }) {
    this.key = `messages:${deviceId}:${roomId}`;
    this.boardKey = `board:${deviceId}:${roomId}`;
    this.decisionKey = `decisions:${deviceId}:${roomId}`;
    this.reactionKey = `reactions:${deviceId}:${roomId}`;
    this.retractKey = `retractions:${deviceId}:${roomId}`;
    this.seqKey = `seq:${deviceId}:${roomId}`;
    this.relaySeenKey = `relay-seen:${deviceId}:${roomId}`;
    this.filesKey = `files:${deviceId}:${roomId}`;
    this.quota = new ReceiveQuota(() => this.now());
    this.quotaDrops = new QuotaDrops(() => this.now());
    this.historyServeLimiter = new PeerRateLimiter(() => this.now(), HISTORY_SERVE_PER_MINUTE, HISTORY_SERVE_BURST);
    this.historyAcceptLimiter = new PeerRateLimiter(() => this.now(), HISTORY_ACCEPT_ENTRIES_PER_MINUTE, HISTORY_ACCEPT_ENTRIES_BURST);
    this.pinnedHost = relayOptions?.hostPin ?? (typeof location !== 'undefined' ? parseHostPin(location.hash) : undefined);
    this.createRelayClient = relayOptions?.createRelayClient;
    if (relayOptions?.decryptRelay) this.decryptRelay = relayOptions.decryptRelay;
    if (relayOptions?.retractionsChanged) this.retractionsChanged = relayOptions.retractionsChanged;
    this.files = new FileTransfers({
      roomId,
      referenced: (sha, peer) => {
        if (!peer) return this.refs.get(sha);
        // Attachments follow message visibility: serve only when referenced by a message `peer` is authorized to see.
        for (const m of this.messages) {
          if (!mayServeMessage(m, peer, this.status, this.status?.memberId, this.verifiedRoster)) continue;
          const match = m.packet.body.attachments?.find(a => a.sha256 === sha);
          if (match) return match;
        }
        return undefined;
      },
      changed: () => this.notifyFiles(), now: () => this.now(),
      store: { has: sha => sha in this.index, get: sha => this.readFile(sha), put: (sha, bytes, type) => this.storeFile(sha, bytes, type) },
      channel: id => {
        const peer = this.peers.get(id);
        if (peer?.fileChannel?.readyState === 'open') return peer.fileChannel;
        if (peer?.channel?.readyState === 'open') return peer.channel;
        if (this.relayClient?.isConnected() && this.verifiedRoster?.body.devices.some(d => d.id === id)) {
          return this.relayFileChannel(id);
        }
        return undefined;
      },
      peers: () => {
        const set = new Set<string>();
        for (const [id, p] of this.peers) {
          if ((p.fileChannel?.readyState === 'open' || p.channel?.readyState === 'open') && this.status?.devices?.some(d => d.id === id)) set.add(id);
        }
        if (this.relayClient?.isConnected() && this.verifiedRoster) {
          for (const entry of this.verifiedRoster.body.devices) {
            if (entry.id !== this.deviceId && this.status?.devices?.some(d => d.id === entry.id && d.session)) set.add(entry.id);
          }
        }
        return [...set];
      } });
  }
  /** Currently verified host-signed roster, if any. */
  roster(): SignedRoster | undefined { return this.verifiedRoster; }
  /** Active relay client instance, if started. */
  relay(): RelayClient | undefined { return this.relayClient; }
  /**
   * Asks the service to push this room's status over the relay socket, as the lobby session the caller polls as, so it
   * needn't poll: `onPush` runs on each push, and `takePushedStatus` hands it over. Sent once the relay is up.
   */
  watchStatus(watch: { session: string; epoch?: string; cursor: number }, onPush: () => void) {
    this.statusWatch = { ...watch };
    this.onPushedStatus = onPush;
    this.relayClient?.watchStatus(this.statusWatch);
  }
  /** Signals up to `cursor` in `epoch` were handled: later pushes leave them out. */
  ackStatus(cursor: number, epoch: string) {
    if (this.statusWatch) { this.statusWatch.cursor = cursor; this.statusWatch.epoch = epoch; }
    this.relayClient?.ackStatus(cursor, epoch);
  }
  /** Whether the service pushes this room's status right now (see RelayClient.statusLive). */
  statusLive(): boolean { return this.relayClient?.statusLive === true; }
  /** How long pushed status stays live without another push (0 when it isn't). */
  statusLiveRemainingMs(): number { return this.relayClient?.statusLiveRemainingMs ?? 0; }
  /** The latest pushed status not yet taken, if any. */
  takePushedStatus(): RoomStatus | undefined { const next = this.pushedStatus; this.pushedStatus = undefined; return next; }
  hasPushedStatus(): boolean { return this.pushedStatus !== undefined; }
  /**
   * Whether an offer waits for its answer, in its first 10 s: a caller without pushes polls for it sooner. A device that
   * never answers doesn't keep the caller polling fast.
   */
  connecting(): boolean {
    const at = this.now();
    // Counted from the first attempt at that device's session, so retries don't keep it going.
    for (const [id, peer] of this.peers)
      if (peer.pc.signalingState === 'have-local-offer' && at - (this.firstOffer.get(`${id}:${peer.session}`) ?? peer.started) < 10_000) return true;
    return false;
  }
  /** Explicitly pin the expected host key prefix (e.g. from `#h=` fragment). */
  setHostPin(pin: string | undefined) { if (pin) this.pinnedHost = pin; }
  /** Whether a peer currently has a live open WebRTC DataChannel (Section 5.4 WebRTC-first rule). */
  private hasLiveWebRtc(id: string): boolean {
    const peer = this.peers.get(id);
    return !!peer && isLiveOpenPeer(peer.pc.connectionState, peer.pc.iceConnectionState, peer.channel?.readyState);
  }
  /** Virtual file-lane channel for a verified-roster peer without a live WebRTC channel. */
  private relayFileChannel(targetId: string) {
    const self = this;
    return {
      get readyState() { return self.relayClient?.isConnected() ? 'open' : 'closed'; },
      get bufferedAmount() { return self.relayClient?.currentFileInFlightBytes ?? 0; },
      send(data: string) {
        try {
          const parsed = JSON.parse(data);
          self.sendViaRelay(parsed, 'file', [targetId]);
        } catch { /* Ignore unparseable data. */ }
      },
    } as unknown as RTCDataChannel;
  }
  /**
   * Signer lookup that uses the verified host-signed roster when available (and strictly for relay frames),
   * preventing coordinator key substitution while remaining backwards-compatible with legacy WebRTC rooms.
   */
  private signerFor(deviceId: unknown, at: unknown, fromRelay: boolean, expectedMemberId?: unknown): { publicKey: string; memberId: string } | undefined {
    if (this.verifiedRoster) {
      const active = this.verifiedRoster.body.devices.find(d => d.id === deviceId);
      if (active) {
        if (expectedMemberId !== undefined && active.memberId !== expectedMemberId) {
          const statusDev = this.status?.devices?.find(d => d.id === deviceId);
          const prior = statusDev?.priorMembers?.find(p =>
            p.memberId === expectedMemberId && (p.retiredAt === undefined || (typeof at === 'number' && at <= p.retiredAt)));
          if (prior) return { publicKey: active.sign, memberId: prior.memberId };
        }
        return { publicKey: active.sign, memberId: active.memberId };
      }
      const removed = this.verifiedRoster.body.removed.find(r => r.id === deviceId);
      if (removed?.revoked) return undefined;
      if (fromRelay) {
        // For relayed historical board/decision/reaction/retract records from a non-revoked departed device.
        const former = this.status?.formerDevices?.find(d => d.id === deviceId);
        if (!former || former.revoked) return undefined;
        return former.retiredAt === undefined || (typeof at === 'number' && at <= former.retiredAt) ? former : undefined;
      }
    }
    if (fromRelay) return undefined;
    return signerOf(this.status, deviceId, at, expectedMemberId);
  }
  /** Recipients from the verified roster that do NOT have a live WebRTC channel (WebRTC-first routing). */
  private relayRecipients(targetIds?: readonly string[]): RosterEntry[] {
    if (!this.verifiedRoster) return [];
    const filter = targetIds ? new Set(targetIds) : undefined;
    return this.verifiedRoster.body.devices.filter(entry =>
      entry.id !== this.deviceId
      && (!filter || filter.has(entry.id))
      && !this.hasLiveWebRtc(entry.id));
  }
  /** Computes wake targets and inbox hold flag for a primary-lane packet (Sections 6.1 & 6.2). */
  private computeRelayMeta(packet: unknown, recipients: RosterEntry[]): { wake?: string[]; hold?: true } {
    const selfWakeable = !!this.verifiedRoster?.body.devices.find(d => d.id === this.deviceId)?.wakeable;
    const anyRecipientWakeable = recipients.some(r => r.wakeable === true);
    const hold = selfWakeable || anyRecipientWakeable ? true as const : undefined;
    const wakeableAgents = recipients.filter(r => r.wakeable === true && r.role === 'agent');
    if (!wakeableAgents.length || !this.status?.members) return hold ? { hold } : {};

    const roomView = roomViewOf(this.status, this.messages), participants = roomView.participants;
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
        time: new Date(typeof body.at === 'number' ? body.at : this.now()).toISOString(),
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
        status: (body.status === 'doing' || body.status === 'done' ? body.status : 'todo'),
        assigneeId: body.assigneeId,
        assignedBy: body.memberId,
        createdBy: body.memberId,
        updatedBy: body.memberId,
        updatedAt: new Date(typeof body.at === 'number' ? body.at : this.now()).toISOString(),
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
  /** Encrypts and queues `packet` onto the relay for non-WebRTC verified-roster peers. */
  private sendViaRelay(packet: unknown, lane: RelayLane, targetIds?: readonly string[]) {
    if (!this.relayClient || !this.verifiedRoster || this.stopped) return;
    const recipients = this.relayRecipients(targetIds);
    if (!recipients.length) return;
    const meta = lane === 'primary' ? this.computeRelayMeta(packet, recipients) : {};
    try {
      this.relayClient.enqueuePacket(packet, {
        rosterVersion: this.verifiedRoster.body.version,
        lane,
        recipients,
        ...meta,
      });
    } catch { /* Outbox or resync retries later. */ }
  }
  /** Broadcasts a primary packet to open WebRTC channels AND via relay to verified-roster peers without live WebRTC. */
  private broadcastPacket(packet: unknown) {
    const encoded = JSON.stringify(packet);
    for (const [id, peer] of this.peers) {
      if (this.hasLiveWebRtc(id) && peer.channel?.readyState === 'open') {
        try { peer.channel.send(encoded); } catch { /* Exchanged again on reconnect. */ }
      }
    }
    this.sendViaRelay(packet, 'primary');
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
    const savedSeq = await read<number>(this.seqKey, (v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
    this.lastAuthorSeq = savedSeq ?? 0;
    this.relaySeen = RelayReplayGuard.from(await read<unknown>(this.relaySeenKey));
    this.index = await readRecord(this.filesKey, isFileIndexEntry);
    for (const sha of Object.keys(this.index)) await this.fileUrl(sha);
    this.notify(); this.notifyBoard(); this.notifyDecisions(); this.notifyReactions(); this.notifyRetractions(); this.syncFiles();
  }
  private notifyReactions() { if (!this.stopped) this.reactionsChanged(foldReactions(this.reactionOps.map(op => op.body))); }
  private notifyRetractions() { if (!this.stopped) this.retractionsChanged(this.retractOps.map(op => op.body)); }
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
      this.broadcastPacket(packet);
    });
  }
  private prunePendingReactions(now = this.now()) {
    if (!this.pendingReactions.length) return;
    const kept: ReactionPacket[] = [];
    for (const op of this.pendingReactions) {
      const k = opKey(op.body);
      const at = this.pendingReactionAt.get(k) ?? now;
      if (now - at > PENDING_REACTION_TTL_MS) this.pendingReactionAt.delete(k);
      else kept.push(op);
    }
    this.pendingReactions = kept;
  }
  private dropPendingForMessages(messageIds: Set<string>) {
    if (!messageIds.size || !this.pendingReactions.length) return;
    const kept: ReactionPacket[] = [];
    for (const op of this.pendingReactions) {
      if (messageIds.has(op.body.messageId)) this.pendingReactionAt.delete(opKey(op.body));
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
        this.pendingReactionAt.delete(opKey(dropped.body));
      }
    }
    if (mayHoldPending(this.pendingReactions, op)) {
      this.pendingReactions.push(op);
      this.pendingReactionAt.set(opKey(op.body), now);
    }
  }
  private async addReactionOps(incoming: ReactionPacket[]) {
    const now = this.now();
    this.prunePendingReactions(now);
    const live = new Set(this.messages.filter(m => !isRetracted(m)).map(m => m.packet.body.id));
    const retracted = new Set(this.messages.filter(m => isRetracted(m) && !live.has(m.packet.body.id)).map(m => m.packet.body.id));
    const known = new Set([...this.reactionOps, ...this.pendingReactions].map(op => opKey(op.body)));
    let ready: ReactionPacket[] = [];
    for (const op of incoming) {
      const k = opKey(op.body);
      if (known.has(k) || retracted.has(op.body.messageId)) continue;
      known.add(k);
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
      const message = this.messages.find(m => m.packet.body.id === messageId && !isRetracted(m));
      if (!message) throw new Error('That message is not in this browser.');
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
      this.broadcastPacket(packet);
    });
  }
  /** Keep verified retractions and remove what they name. The log and the messages are written together. */
  private async addRetractionOps(incoming: RetractPacket[]) {
    const { log, added } = addRetractions(this.retractOps, incoming, this.messages);
    if (!added.length) return;
    const { messages, changed } = applyRetractions(this.messages, log.map(op => op.body));
    const puts: [string, unknown][] = [[this.retractKey, log]];
    // Only clear reactions for a retracted message ID when NO live message with that ID remains
    // (an attacker deleting their own colliding copy must never wipe reactions on the victim's live message).
    const stillLive = new Set(messages.filter(m => !isRetracted(m)).map(m => m.packet.body.id));
    const fullyRetracted = new Set(changed.filter(id => !stillLive.has(id)));
    const reactions = this.reactionOps.filter(op => !fullyRetracted.has(op.body.messageId));
    if (changed.length) puts.push([this.key, messages]);
    if (reactions.length !== this.reactionOps.length) puts.push([this.reactionKey, reactions]);
    await this.put(puts); this.retractOps = log; this.notifyRetractions();
    if (reactions.length !== this.reactionOps.length) { this.reactionOps = reactions; this.notifyReactions(); }
    if (changed.length) {
      this.dropPendingForMessages(fullyRetracted);
      this.messages = messages; this.notify(); this.syncFiles();
    }
  }
  /** Delete one of this member's messages for everyone. Any of their devices can, so it is the member that is compared. */
  async retract(messageId: string) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before deleting a message.');
      const message = this.messages.find(m => m.packet.body.id === messageId && m.packet.body.memberId === this.status!.memberId)
        ?? this.messages.find(m => m.packet.body.id === messageId);
      if (!message) throw new Error('That message is not in this browser.');
      if (message.packet.body.memberId !== this.status.memberId) throw new Error('You can only delete your own messages.');
      if (isRetracted(message)) return;
      const body: RetractBody = {
        kind: 'retract', roomId: this.roomId, id: crypto.randomUUID(), deviceId: this.deviceId,
        memberId: this.status.memberId, at: Date.now(), target: messageId,
        targetDeviceId: message.packet.body.deviceId,
        ...(message.packet.body.seq !== undefined ? { seq: message.packet.body.seq } : {}),
      };
      const packet: RetractPacket = { body, signature: await sign(body) };
      await this.addRetractionOps([packet]);
      this.broadcastPacket(packet);
    });
  }
  /** A retraction relayed in an exchange is checked against its author's own device (see signerOf), not the sender's. */
  private async acceptRetractions(sync: { roomId?: unknown; ops?: unknown }, fromRelay = false) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const accepted: RetractPacket[] = [];
    const held = new Set(this.retractOps.map(op => opKey(op.body)));
    for (const op of sync.ops as RetractPacket[]) {
      if (!validRetractBody(op?.body, this.roomId) || typeof op.signature !== 'string') continue;
      const k = opKey(op.body);
      if (held.has(k)) continue;
      const author = this.signerFor(op.body.deviceId, op.body.at, fromRelay);
      if (!author || op.body.memberId !== author.memberId) continue;
      if (await verify(author.publicKey, op.body, op.signature)) { held.add(k); accepted.push({ body: op.body, signature: op.signature }); }
    }
    await this.addRetractionOps(accepted);
  }
  private async acceptReactions(sync: { roomId?: unknown; ops?: unknown }, fromRelay = false) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const accepted: ReactionPacket[] = [];
    // Held operations and fully retracted targets are skipped before signatures are checked.
    const held = new Set([...this.reactionOps, ...this.pendingReactions].map(op => opKey(op.body)));
    const live = new Set(this.messages.filter(m => !isRetracted(m)).map(m => m.packet.body.id));
    const retracted = new Set(this.messages.filter(m => isRetracted(m) && !live.has(m.packet.body.id)).map(m => m.packet.body.id));
    for (const op of sync.ops as ReactionPacket[]) {
      if (!validReactionBody(op?.body, this.roomId) || typeof op.signature !== 'string') continue;
      const k = opKey(op.body);
      if (held.has(k) || retracted.has(op.body.messageId)) continue;
      const author = this.signerFor(op.body.deviceId, op.body.at, fromRelay);
      if (!author || op.body.memberId !== author.memberId) continue;
      if (await verify(author.publicKey, op.body, op.signature)) { held.add(k); accepted.push({ body: op.body, signature: op.signature }); }
    }
    try { await this.addReactionOps(accepted); }
    catch { /* Cap full: keep the local log; peers retry after compaction elsewhere. */ }
  }
  /** Operations relayed in a board exchange are checked against each author's own device, not the sender's. */
  private async acceptBoard(sync: { roomId?: unknown; ops?: unknown }, fromRelay = false) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const accepted: TaskPacket[] = [];
    const held = new Set(this.ops.map(op => op.body.id));
    for (const op of sync.ops as TaskPacket[]) {
      if (held.has(op?.body?.id)) continue;
      // A change by someone who has since left still verifies against the key the room service keeps for them (see signerOf).
      const author = this.signerFor(op?.body?.deviceId, op?.body?.at, fromRelay);
      if (!author || !validTaskBody(op.body, this.roomId) || op.body.memberId !== author.memberId || typeof op.signature !== 'string') continue;
      if (await verify(author.publicKey, op.body, op.signature)) accepted.push({ body: op.body, signature: op.signature });
    }
    await this.addOps(accepted);
  }
  /** This device's board, decisions, reactions and retractions, paced onto the peer's channel. */
  private sendState(peer: Peer) {
    if (!peer.queue) return;
    const chunks = [
      ...syncChunks(this.roomId, this.ops),
      ...decisionChunks(this.roomId, this.decisionOps),
      ...reactionSyncChunks(this.roomId, this.reactionOps),
      ...retractionSyncChunks(this.roomId, this.retractOps),
    ];
    if (!chunks.length) return;
    peer.resync.sent();
    peer.queue.push(chunks.map(chunk => JSON.stringify(chunk)));
  }
  /** Advertises this device's held message history so the peer can serve anything missing. */
  private sendHistoryHave(peerId: string, peer: Peer, cursor?: HistoryCursor, expectReply = false) {
    this.sendHistoryHaveTo(peerId, cursor, peer, expectReply, 0);
  }
  /** Sends a history replication packet over live WebRTC if open, else over the E2E relay. Returns false if dropped by a full SendQueue or unavailable transport. */
  private sendHistoryPackets(peerId: string, packets: (HistoryHavePacket | HistoryPacket)[], peer?: Peer): boolean {
    const active = peer ?? this.peers.get(peerId);
    if (active?.queue && this.hasLiveWebRtc(peerId) && active.channel?.readyState === 'open') {
      return active.queue.push(packets.map(p => JSON.stringify(p)));
    }
    if (this.relayClient?.isConnected() && this.verifiedRoster?.body.devices.some(d => d.id === peerId)) {
      for (const packet of packets) this.sendViaRelay(packet, 'primary', [peerId]);
      return true;
    }
    return false;
  }
  private clearHistoryTimeout(peerId: string) {
    const timer = this.historyTimeoutTimers.get(peerId);
    if (timer) { clearTimeout(timer); this.historyTimeoutTimers.delete(peerId); }
  }
  private clearPeerHistoryState(peerId: string) {
    this.historyRoundDropped.delete(peerId);
    this.historyRetryAt.delete(peerId);
    const retryTimer = this.historyRetryTimers.get(peerId);
    if (retryTimer) { clearTimeout(retryTimer); this.historyRetryTimers.delete(peerId); }
    this.historyInFlight.delete(peerId);
    this.clearHistoryTimeout(peerId);
  }
  private armHistoryRoundTimeout(peerId: string, timeouts: number) {
    this.clearHistoryTimeout(peerId);
    const delay = Math.min(30_000, HISTORY_ROUND_TIMEOUT_MS * (timeouts + 1));
    this.historyTimeoutTimers.set(peerId, setTimeout(() => {
      this.historyTimeoutTimers.delete(peerId);
      if (!this.stopped && this.historyInFlight.has(peerId)) this.flushHistoryRetries();
    }, delay));
  }
  /** Sends a `history-have` with requester-side tracking so full queues, silent rate limits, or lost replies always recover. */
  private sendHistoryHaveTo(peerId: string, cursor: HistoryCursor | undefined, peer: Peer | undefined, expectReply: boolean, timeouts = 0): boolean {
    const have = buildHistoryHave(this.roomId, this.messages, cursor ? { cursor } : undefined);
    const active = peer ?? this.peers.get(peerId);
    const isWebRtc = !!(active?.queue && this.hasLiveWebRtc(peerId) && active.channel?.readyState === 'open');
    const sent = this.sendHistoryPackets(peerId, [have], active);
    if (!sent) {
      // Full SendQueue on an open WebRTC channel: retry shortly without losing the pagination cursor.
      if (isWebRtc) this.scheduleHistoryRetry(peerId, 1_500);
      return false;
    }
    if (!isWebRtc) this.relayHistorySynced.set(peerId, this.now());
    this.historyInFlight.set(peerId, { sentAt: this.now(), expectReply, timeouts });
    if (expectReply) this.armHistoryRoundTimeout(peerId, timeouts);
    else this.clearHistoryTimeout(peerId);
    return true;
  }
  /** Schedules a delayed `history-have` retry for `peerId` without losing its pagination cursor. */
  private scheduleHistoryRetry(peerId: string, delayMs: number) {
    const clamped = Math.max(250, Math.min(30_000, delayMs));
    const dueAt = this.now() + clamped;
    const prev = this.historyRetryAt.get(peerId);
    if (prev !== undefined && prev <= dueAt) return;
    this.historyRetryAt.set(peerId, dueAt);
    const oldTimer = this.historyRetryTimers.get(peerId);
    if (oldTimer) clearTimeout(oldTimer);
    this.historyRetryTimers.set(peerId, setTimeout(() => {
      this.historyRetryTimers.delete(peerId);
      if (!this.stopped && this.historyRetryAt.has(peerId)) this.flushHistoryRetries();
    }, clamped));
  }
  private flushHistoryRetries() {
    const at = this.now();
    for (const [peerId, dueAt] of [...this.historyRetryAt]) {
      if (at < dueAt) continue;
      this.historyRetryAt.delete(peerId);
      const timer = this.historyRetryTimers.get(peerId);
      if (timer) { clearTimeout(timer); this.historyRetryTimers.delete(peerId); }
      this.historyRoundDropped.delete(peerId);
      this.sendHistoryHaveTo(peerId, this.historyCursors.get(peerId), undefined, true, 0);
    }
    for (const [peerId, pending] of [...this.historyInFlight]) {
      if (!pending.expectReply || this.historyRetryAt.has(peerId)) continue;
      const waitMs = Math.min(30_000, HISTORY_ROUND_TIMEOUT_MS * (pending.timeouts + 1));
      if (at - pending.sentAt < waitMs) continue;
      if (pending.timeouts + 1 > MAX_HISTORY_ROUND_TIMEOUTS) {
        this.historyInFlight.delete(peerId);
        this.clearHistoryTimeout(peerId);
        continue;
      }
      this.historyRoundDropped.delete(peerId);
      if (!this.sendHistoryHaveTo(peerId, this.historyCursors.get(peerId), undefined, true, pending.timeouts + 1)) {
        // Peer is no longer reachable over WebRTC or relay; drop in-flight state until reconnect.
        if (!this.historyRetryAt.has(peerId)) {
          this.historyInFlight.delete(peerId);
          this.clearHistoryTimeout(peerId);
        }
      }
    }
  }
  /** Initiates peer-to-peer history sync over the E2E relay for online verified-roster peers without live WebRTC. */
  private syncHistoryViaRelay() {
    if (!this.relayClient?.isConnected() || !this.verifiedRoster) return;
    const at = this.now();
    for (const entry of this.verifiedRoster.body.devices) {
      if (entry.id === this.deviceId || this.hasLiveWebRtc(entry.id)) continue;
      if (!this.status?.devices?.some(d => d.id === entry.id && d.session)) {
        this.relayHistorySynced.delete(entry.id);
        continue;
      }
      if (this.historyRetryAt.has(entry.id)) continue;
      const lastSent = this.relayHistorySynced.get(entry.id);
      if (lastSent !== undefined && at - lastSent < RELAY_HISTORY_RETRY_MS) continue;
      this.historyRounds.set(entry.id, 0);
      this.historyRoundDropped.delete(entry.id);
      this.sendHistoryHaveTo(entry.id, this.historyCursors.get(entry.id), undefined, this.historyCursors.has(entry.id), 0);
    }
  }
  /** Serves missing, authorized message history to `peerId` using a per-peer token bucket with bounded `retryAfterMs` hints. */
  private serveHistory(peerId: string, have: HistoryHavePacket, _fromRelay: boolean, peer?: Peer) {
    if (!this.status?.memberId) return;
    if (!this.historyServeLimiter.take(peerId)) {
      if (this.historyServeLimiter.report(peerId)) console.debug(`Meshrooms: rate-limited history-have requests from ${peerId.slice(0, 8)}`);
      if (this.historyServeLimiter.maySendRetryHint(peerId)) {
        this.sendHistoryPackets(peerId, [{ kind: 'history', roomId: this.roomId, entries: [], retryAfterMs: this.historyServeLimiter.retryAfterMs(peerId) }], peer);
      }
      return;
    }
    const { entries, more, nextCursor } = selectHistoryEntries(this.messages, have, peerId, this.status, this.status.memberId, undefined, this.verifiedRoster);
    if (!entries.length) {
      if (have.cursor) this.sendHistoryPackets(peerId, [{ kind: 'history', roomId: this.roomId, entries: [], done: true }], peer);
      return;
    }
    this.sendHistoryPackets(peerId, historyChunks(this.roomId, entries, more, nextCursor), peer);
  }
  /** Verifies and stores replicated history entries from `fromPeerId`, paginating cleanly with retry recovery. */
  private async acceptHistory(fromPeerId: string, packet: HistoryPacket, fromRelay: boolean, peer?: Peer) {
    // A serving peer telling us its serve bucket is temporarily full: accept only when we actually have a request in flight.
    if (packet.retryAfterMs !== undefined && packet.entries.length === 0) {
      const pending = this.historyInFlight.get(fromPeerId);
      if (!pending || this.now() - pending.sentAt > 60_000) return;
      this.historyInFlight.delete(fromPeerId);
      this.clearHistoryTimeout(fromPeerId);
      this.scheduleHistoryRetry(fromPeerId, packet.retryAfterMs);
      return;
    }
    this.clearHistoryTimeout(fromPeerId);
    if (fromRelay) this.relayHistorySynced.set(fromPeerId, this.now());
    const cost = Math.max(1, packet.entries.length);
    if (!this.historyAcceptLimiter.take(fromPeerId, cost)) {
      if (this.historyAcceptLimiter.report(fromPeerId)) console.debug(`Meshrooms: rate-limited history entries from ${fromPeerId.slice(0, 8)}`);
      this.historyRoundDropped.add(fromPeerId);
      this.historyInFlight.delete(fromPeerId);
      this.quotaDrops.drop(fromPeerId);
      return;
    }
    const held = new Set(this.messages.map(m => messageKey(m.packet.body.deviceId, m.packet.body.id)));
    const baseMaxSeq = maxSeqByDevice(this.messages);
    const batchAnchor = new Map<string, number>();
    const accepted: SavedMessage[] = [];
    let droppedByQuota = false;
    for (const entry of packet.entries) {
      const b = entry?.body;
      if (!b || b.kind !== 'message' || b.roomId !== this.roomId || !isId(b.id) || typeof b.deviceId !== 'string') continue;
      const key = messageKey(b.deviceId, b.id);
      if (held.has(key)) continue;
      if (typeof entry.signature !== 'string') continue;
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at) || b.at < 0 || b.at > 8_640_000_000_000_000) continue;
      if (b.replyTo !== undefined && !isId(b.replyTo)) continue;
      if (b.attachments !== undefined && !validAttachments(b.attachments)) continue;
      if (!validMessageVisibility(b.visibility) || !validMessageSeq(b.seq) || !validAudienceUntil(b.audienceUntil)) continue;
      const maxHeld = baseMaxSeq.get(b.deviceId) ?? batchAnchor.get(b.deviceId) ?? 0;
      if (!withinSeqJump(b.seq, maxHeld)) continue;
      const author = this.signerFor(b.deviceId, b.at, fromRelay, b.memberId);
      if (!author || b.memberId !== author.memberId) continue;
      if (!await verify(author.publicKey, b, entry.signature)) continue;
      if (!this.allowed(b.memberId, 'history', fromPeerId)) {
        droppedByQuota = true;
        this.historyRoundDropped.add(fromPeerId);
        continue;
      }
      held.add(key);
      if (typeof b.seq === 'number' && !baseMaxSeq.has(b.deviceId) && !batchAnchor.has(b.deviceId)) batchAnchor.set(b.deviceId, b.seq);
      const saved: SavedMessage = { packet: { body: b, signature: entry.signature }, targets: [], receipts: [], receivedAt: this.now(), replicated: true };
      accepted.push(this.retractOps.some(op => mayRetract(op.body, b)) ? retractedStub(saved) : saved);
    }
    let windowUnchanged = false;
    if (accepted.length) {
      const { messages: merged, added } = mergeHistoryMessages(this.messages, accepted);
      if (added.length) {
        const { kept, evicted } = windowHistory(merged, m => this.awaiting(m));
        const changed = kept.length !== this.messages.length || kept.some((m, i) => m !== this.messages[i]);
        if (changed) {
          await this.put([[this.key, kept]]);
          this.messages = kept;
          this.receiptsDirty = false;
          const keptSet = new Set(kept);
          const retainedAdded = added.filter(m => keptSet.has(m));
          const liveIds = new Set(kept.filter(m => !isRetracted(m)).map(m => m.packet.body.id));
          if (evicted.length) this.dropPendingForMessages(new Set(evicted.map(m => m.packet.body.id).filter(id => !liveIds.has(id))));
          this.notify();
          if (retainedAdded.some(m => m.packet.body.attachments) || evicted.some(m => m.packet.body.attachments)) this.syncFiles();
          for (const m of retainedAdded) if (!isRetracted(m)) await this.flushPendingReactions(m.packet.body.id);
        } else {
          // Every newly accepted entry was immediately evicted by the full rolling window: skip disk write & churn.
          windowUnchanged = true;
        }
      }
    }
    if (packet.more) {
      if (droppedByQuota || this.historyRoundDropped.has(fromPeerId)) {
        // Keep the start-of-round cursor so `quotaDrops` -> `requestSync` retries this round without skipping dropped entries.
        this.historyInFlight.delete(fromPeerId);
        this.quotaDrops.drop(fromPeerId);
      } else if (windowUnchanged && this.messages.length >= MAX_STORED_MESSAGES) {
        this.historyCursors.delete(fromPeerId);
        this.historyInFlight.delete(fromPeerId);
      } else {
        if (packet.nextCursor) this.historyCursors.set(fromPeerId, packet.nextCursor);
        const rounds = (this.historyRounds.get(fromPeerId) ?? 0) + 1;
        if (rounds <= MAX_HISTORY_ROUNDS) {
          this.historyRounds.set(fromPeerId, rounds);
          this.sendHistoryHaveTo(fromPeerId, this.historyCursors.get(fromPeerId), peer, true, 0);
        } else {
          this.historyInFlight.delete(fromPeerId);
        }
      }
    } else if (packet.done && !droppedByQuota && !this.historyRoundDropped.has(fromPeerId)) {
      this.historyCursors.delete(fromPeerId);
      this.historyInFlight.delete(fromPeerId);
    } else if (!droppedByQuota && !this.historyRoundDropped.has(fromPeerId) && packet.entries.length > 0 && this.historyInFlight.has(fromPeerId)) {
      // Intermediate chunk of a multi-chunk page: refresh the round timeout in case the trailing `more`/`done` chunk is lost.
      this.historyInFlight.set(fromPeerId, { sentAt: this.now(), expectReply: true, timeouts: 0 });
      this.armHistoryRoundTimeout(fromPeerId, 0);
    }
  }
  /** Ask a peer for its state and history again after packets were dropped under load (works over WebRTC and relay). */
  private requestSync(id: string) {
    const peer = this.peers.get(id);
    const channel = peer?.channel;
    const request: SyncRequest = { kind: SYNC_REQUEST, roomId: this.roomId };
    if (channel?.readyState === 'open') {
      try { channel.send(JSON.stringify(request)); } catch { /* Asked again after the next drop, or the state is exchanged on reconnect. */ }
    } else if (this.relayClient?.isConnected() && this.verifiedRoster?.body.devices.some(d => d.id === id)) {
      this.sendViaRelay(request, 'primary', [id]);
    }
    // Never cancel an active server `retryAfterMs` backoff — firing early hits `maySendRetryHint`'s 1s quiet window.
    if (this.historyRetryAt.has(id)) return;
    this.historyRoundDropped.delete(id);
    this.sendHistoryHaveTo(id, this.historyCursors.get(id), peer, true, 0);
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
    this.broadcastPacket(packet);
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
  private async acceptDecisions(sync: { roomId?: unknown; ops?: unknown }, fromRelay = false) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const held = new Set(this.decisionOps.map(op => op.body.id));
    const candidates = (sync.ops as DecisionPacket[]).filter(op => (validDecisionBody(op?.body, this.roomId) || validVoteBody(op?.body, this.roomId))
      && typeof op.signature === 'string' && !held.has(op.body.id));
    const authentic = async ({ body: b, signature }: DecisionPacket) => {
      const author = this.signerFor(b.deviceId, b.at, fromRelay);
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
  private forget(id: string) { this.clearPeerHistoryState(id); if (this.activity.delete(id)) this.notifyActivity(); }
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
    const puts: [string, unknown][] = [[this.key, kept]];
    if (added.packet.body.deviceId === this.deviceId && typeof added.packet.body.seq === 'number' && added.packet.body.seq > this.lastAuthorSeq) {
      this.lastAuthorSeq = added.packet.body.seq;
      puts.push([this.seqKey, this.lastAuthorSeq]);
    }
    await this.put(puts); this.messages = kept; this.receiptsDirty = false;
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
      const visibility: MessageVisibility = this.status.settings?.historyForNewcomers ? 'room' : 'members';
      const audienceUntil = visibility === 'members' ? currentAudienceUntil(this.status) : undefined;
      const seq = nextAuthorSeq(this.messages, this.deviceId, this.lastAuthorSeq);
      const body: MessageBody = {
        kind: 'message', roomId: this.roomId, id: crypto.randomUUID(), deviceId: this.deviceId, memberId: this.status.memberId,
        text: text.trim() || attachmentText(attachments), at: Date.now(), visibility, seq,
        ...(audienceUntil !== undefined ? { audienceUntil } : {}),
        ...(replyTo ? { replyTo } : {}), ...(files.length ? { attachments } : {}),
      };
      const packet = { body, signature: await sign(body) };
      const saved: SavedMessage = { packet, targets: this.status.devices!.filter(d => d.id !== this.deviceId).map(d => d.id), receipts: [], receivedAt: this.now() };
      await this.save(saved); this.flush();
    });
  }
  /** Send each connected peer up to 16 of its unconfirmed messages, oldest first; WebRTC first, else encrypted relay. */
  private flush() {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (!this.hasLiveWebRtc(id) || peer.channel?.readyState !== 'open') continue;
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
    if (this.relayClient?.isConnected() && this.verifiedRoster) {
      let relaySentCount = 0;
      for (const message of this.messages) {
        if (relaySentCount >= 16) break;
        const messageId = message.packet.body.id;
        if (message.packet.body.deviceId !== this.deviceId) continue;
        if (now - (this.relaySent.get(messageId) ?? 0) < RESEND_MS) continue;
        const pendingTargets = message.targets.filter(id => !message.receipts.includes(id));
        if (!pendingTargets.length) continue;
        const recipients = this.relayRecipients(pendingTargets);
        if (!recipients.length) continue;
        this.sendViaRelay(message.packet, 'primary', recipients.map(r => r.id));
        this.relaySent.set(messageId, now);
        relaySentCount++;
      }
      if (this.relaySent.size > 4096) this.relaySent.clear();
    }
  }
  /** Sends a signed receipt back to `senderId` over live WebRTC if available, else over the E2E relay. */
  private async sendReceiptTo(senderId: string, messageId: string, channel?: RTCDataChannel) {
    const receipt: ReceiptBody = { kind: 'receipt', roomId: this.roomId, id: messageId, deviceId: this.deviceId };
    const packet = { body: receipt, signature: await sign(receipt) };
    if (channel && channel.readyState === 'open') {
      try { channel.send(JSON.stringify(packet)); return; } catch { /* Fall through to relay if available. */ }
    }
    const peer = this.peers.get(senderId);
    if (this.hasLiveWebRtc(senderId) && peer?.channel?.readyState === 'open') {
      try { peer.channel.send(JSON.stringify(packet)); return; } catch { /* Fall through to relay. */ }
    }
    this.sendViaRelay(packet, 'primary', [senderId]);
  }
  /**
   * Shared receive pipeline for BOTH WebRTC DataChannel packets and decrypted E2E relay envelopes:
   * runs every packet through `IncomingGate`, `ReceiveQuota`, verified signer lookup, ECDSA verification,
   * and dedupe-by-id so WebRTC + WSS/HTTPS frames are handled identically.
   */
  private handleIncomingPacket(
    id: string,
    packet: Packet,
    fromRelay: boolean,
    peer?: Peer,
    channel?: RTCDataChannel,
    relayMeta?: { cursor?: number; replay?: { from: string; id: string } },
  ): Promise<void> | undefined {
    // File transfers bypass the message queue: chunks arrive by the hundred and are cheap to check.
    if (isFilePacket(packet)) {
      const authorized = fromRelay
        ? !!this.verifiedRoster?.body.devices.some(d => d.id === id)
        : this.peers.get(id) === peer && !!this.status?.devices?.some(d => d.id === id);
      if (!this.stopped && authorized) {
        this.files.handle(id, packet);
        if (relayMeta?.cursor !== undefined) this.relayClient?.ackCursor(relayMeta.cursor);
      }
      return;
    }
    if (isActivityPacket(packet)) {
      if (!this.stopped && (fromRelay ? !!this.verifiedRoster?.body.devices.some(d => d.id === id) : this.peers.get(id) === peer)) {
        this.acceptActivity(id, packet);
        if (relayMeta?.cursor !== undefined) this.relayClient?.ackCursor(relayMeta.cursor);
      }
      return;
    }
    // Cheap and never queued: answered from the tick, at most once per interval (WebRTC or verified-roster relay).
    if (isSyncRequest(packet, this.roomId)) {
      if (this.stopped) return;
      if (!fromRelay && peer && this.peers.get(id) === peer && this.status?.devices?.some(d => d.id === id)) {
        peer.resync.request(); this.resyncDue(peer);
      } else if (fromRelay && this.verifiedRoster?.body.devices.some(d => d.id === id)) {
        let limiter = this.relayResync.get(id);
        if (!limiter) { limiter = new Resync(); this.relayResync.set(id, limiter); if (this.relayResync.size > 512) this.relayResync.delete(this.relayResync.keys().next().value!); }
        limiter.request();
        if (limiter.due({ pending: 0 } as SendQueue)) {
          limiter.sent();
          for (const chunk of [
            ...syncChunks(this.roomId, this.ops),
            ...decisionChunks(this.roomId, this.decisionOps),
            ...reactionSyncChunks(this.roomId, this.reactionOps),
            ...retractionSyncChunks(this.roomId, this.retractOps),
          ]) this.sendViaRelay(chunk, 'primary', [id]);
        }
        if (relayMeta?.cursor !== undefined) this.relayClient?.ackCursor(relayMeta.cursor);
      }
      return;
    }
    if (!this.incoming.admit(id)) return;
    return this.transaction(async () => {
      if (this.stopped || !this.status?.memberId) return false;
      if (!fromRelay && peer && this.peers.get(id) !== peer) return false;
      const device = fromRelay
        ? (() => {
            const entry = this.verifiedRoster?.body.devices.find(d => d.id === id);
            return entry ? { id: entry.id, publicKey: entry.sign, memberId: entry.memberId } : undefined;
          })()
        : this.status.devices?.find(d => d.id === id);
      if (!device) return false;
      if ((packet as unknown as { kind?: unknown })?.kind === 'board') { await this.acceptBoard(packet as never, fromRelay); return true; }
      if ((packet as unknown as { kind?: unknown })?.kind === 'decisions') { await this.acceptDecisions(packet as never, fromRelay); return true; }
      if ((packet as unknown as { kind?: unknown })?.kind === 'reactions') { await this.acceptReactions(packet as never, fromRelay); return true; }
      if ((packet as unknown as { kind?: unknown })?.kind === 'retractions') { await this.acceptRetractions(packet as never, fromRelay); return true; }
      if (isHistoryHavePacket(packet, this.roomId)) { this.serveHistory(id, packet, fromRelay, peer); return true; }
      if (isHistoryPacket(packet, this.roomId)) { await this.acceptHistory(id, packet, fromRelay, peer); return true; }
      const b = packet?.body;
      if (!b || b.roomId !== this.roomId || b.deviceId !== id || !isId(b.id) || typeof packet.signature !== 'string' || !await verify(device.publicKey, b, packet.signature)) return false;
      if (b.kind === 'message') {
        if (b.memberId !== device.memberId || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at) || b.at < 0 || b.at > 8_640_000_000_000_000) return false;
        // The replied-to message may predate this browser's admission, so only its form is checked.
        if (b.replyTo !== undefined && !isId(b.replyTo)) return false;
        if (b.attachments !== undefined && !validAttachments(b.attachments)) return false;
        if (!validMessageVisibility(b.visibility) || !validMessageSeq(b.seq) || !validAudienceUntil(b.audienceUntil)) return false;
        const existing = this.messages.find(m => m.packet.body.deviceId === b.deviceId && m.packet.body.id === b.id);
        // A stub no longer matches the original its sender may still be retrying, and it only needs confirming.
        if (existing && !isRetracted(existing) && JSON.stringify(existing.packet.body) !== JSON.stringify(b)) return false;
        // Past the rolling window the oldest messages make room, so a new one is always stored and confirmed.
        if (!existing) {
          if (!withinSeqJump(b.seq, maxSeqForDevice(this.messages, b.deviceId))) return false;
          if (!this.allowed(device.memberId, 'message', id)) return false; // Unconfirmed, so its sender retries later.
          const saved: SavedMessage = { packet: packet as SavedMessage['packet'], targets: [], receipts: [], receivedAt: this.now() };
          await this.save(this.retractOps.some(op => mayRetract(op.body, b)) ? retractedStub(saved) : saved);
        }
        // A receipt means an IndexedDB transaction completed, not that a person read it.
        await this.sendReceiptTo(id, b.id, fromRelay ? undefined : channel);
        return true;
      } else if (b.kind === 'receipt') {
        const m = this.messages.find(m => m.packet.body.id === b.id && m.packet.body.deviceId === this.deviceId);
        if (m?.targets.includes(id) && !m.receipts.includes(id)) this.receipt(m, id);
        return true;
      } else if (b.kind === 'task') {
        if (validTaskBody(b, this.roomId) && b.memberId === device.memberId && !this.ops.some(op => op.body.id === b.id)
          && this.allowed(device.memberId, 'task', id)) await this.addOps([{ body: b, signature: packet.signature }]);
        return true;
      } else if (b.kind === 'decision' || b.kind === 'vote') {
        if ((validDecisionBody(b, this.roomId) || validVoteBody(b, this.roomId)) && b.memberId === device.memberId && !this.decisionOps.some(op => op.body.id === b.id)
          && admissible(this.decisionOps.map(op => op.body), [b]).length && this.allowed(device.memberId, 'decision', id)) await this.addDecisionOps([{ body: b, signature: packet.signature }]);
        return true;
      } else if (b.kind === 'reaction') {
        if (validReactionBody(b, this.roomId) && b.memberId === device.memberId && ![...this.reactionOps, ...this.pendingReactions].some(op => opKey(op.body) === opKey(b))
          && this.allowed(device.memberId, 'reaction', id)) await this.addReactionOps([{ body: b, signature: packet.signature }]);
        return true;
      } else if (b.kind === 'retract') {
        if (validRetractBody(b, this.roomId) && b.memberId === device.memberId && !this.retractOps.some(op => opKey(op.body) === opKey(b))
          && this.allowed(device.memberId, 'retract', id)) await this.addRetractionOps([{ body: b, signature: packet.signature }]);
        return true;
      }
      return false;
    }).then(async persisted => {
      if (!persisted) return;
      // Persist the replay guard BEFORE acknowledging the inbox cursor so a crash cannot allow a replay.
      if (relayMeta?.replay) await this.rememberRelayEnvelope(relayMeta.replay.from, relayMeta.replay.id);
      if (relayMeta?.cursor !== undefined) this.relayClient?.ackCursor(relayMeta.cursor);
    }).catch(e => this.fail(e)).finally(() => { for (const from of this.incoming.done()) this.requestSync(from); });
  }
  /** Remembers a processed envelope in memory at once and persists the record behind the room's other writes. */
  private rememberRelayEnvelope(from: string, id: string) {
    this.relaySeen.add(from, id);
    return this.transaction(() => this.put([[this.relaySeenKey, this.relaySeen.export()]]));
  }
  private handleDataMessage(peer: Peer, id: string, channel: RTCDataChannel, raw: unknown) {
    if (typeof raw !== 'string' || raw.length > 20_000) return;
    let packet: Packet;
    try { packet = JSON.parse(raw); } catch { return; }
    this.handleIncomingPacket(id, packet, false, peer, channel);
  }
  /**
   * Authenticates, deduplicates and decrypts an incoming `RelayEnvelope`, then feeds it into the shared receive pipeline.
   * The envelope signature is checked against the sender's key in the verified host-signed roster, so a forged `from` is dropped.
   */
  async handleRelayEnvelope(envelope: RelayEnvelope, cursor?: number) {
    if (this.stopped || !this.verifiedRoster) return;
    if (envelope.from === this.deviceId) return;
    const sender = this.verifiedRoster.body.devices.find(d => d.id === envelope.from);
    if (!sender) return;
    const key = `${envelope.from}:${envelope.id}`;
    // A repeat of something already processed and persisted: nothing more to do, and the inbox copy can be acknowledged.
    if (this.relaySeen.seen(envelope.from, envelope.id) || this.relaySeenVolatile.seen(envelope.from, envelope.id)) {
      if (cursor !== undefined) this.relayClient?.ackCursor(cursor);
      return;
    }
    if (this.relayInflight.has(key)) return;
    let decrypted: DecryptedRelayEnvelope<unknown>;
    try {
      // Do NOT reject frames encrypted under an earlier roster version (e.g. queued in inbox before v(N) published).
      // The roster version in an envelope is sender-chosen metadata and never moves `highestRosterVersion`.
      decrypted = await this.decryptRelay(envelope, { room: this.roomId, senderSignKey: sender.sign });
    } catch {
      return;
    }
    if (!decrypted.packet || typeof decrypted.packet !== 'object') return;
    const packet = decrypted.packet as Packet;
    if (isFilePacket(packet) || isActivityPacket(packet)) {
      if (!this.relaySeenVolatile.add(envelope.from, envelope.id)) return;
      this.handleIncomingPacket(envelope.from, packet, true, undefined, undefined, { cursor });
      return;
    }
    this.relayInflight.add(key);
    const done = this.handleIncomingPacket(envelope.from, packet, true, undefined, undefined, { cursor, replay: { from: envelope.from, id: envelope.id } });
    void Promise.resolve(done).finally(() => this.relayInflight.delete(key));
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
      this.historyRounds.set(id, 0);
      this.historyCursors.delete(id);
      this.clearPeerHistoryState(id);
      this.healthOf(peer);
      this.flush(); this.sendState(peer); this.sendHistoryHave(id, peer);
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
    this.flushHistoryRetries();
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
    const tried = `${device.id}:${device.session}`;
    if (!this.firstOffer.has(tried)) { if (this.firstOffer.size >= 256) this.firstOffer.clear(); this.firstOffer.set(tried, peer.started); }
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
    await this.verifyIncomingRoster(status);
    if (status.memberId) {
      void this.maybePublishEncKey(status);
      void this.maybePublishRoster(status);
      void this.ensureRelayClient(status);
    }
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
    this.syncHistoryViaRelay();
    this.flush(); this.notify();
  }
  /** Verifies `status.roster` against the pinned host key (or TOFU at first sight) and rejects rollbacks/tampering. */
  private async verifyIncomingRoster(status: RoomStatus) {
    const incoming = status.roster;
    if (!incoming) return;
    if (this.verifiedRoster && incoming.body.version === this.verifiedRoster.body.version && incoming.signature === this.verifiedRoster.signature) {
      return;
    }
    if (incoming.body.version <= (this.verifiedRoster?.body.version ?? 0) || incoming.body.version < this.highestRosterVersion) {
      return;
    }
    const consecutive = !!this.verifiedRoster && incoming.body.version === this.verifiedRoster.body.version + 1;
    const minVersion = Math.max(this.highestRosterVersion, this.verifiedRoster ? this.verifiedRoster.body.version + 1 : 0);
    const result = await verifyRoster(incoming, {
      roomId: this.roomId,
      expectedHostPin: this.pinnedHost,
      ...(consecutive ? { previous: this.verifiedRoster } : {}),
      ...(minVersion > 0 ? { minVersion } : {}),
    });
    if (!result.ok) return;
    this.verifiedRoster = incoming;
    this.highestRosterVersion = Math.max(this.highestRosterVersion, incoming.body.version);
    this.pinnedHost = result.hostDeviceId;
    this.syncHistoryViaRelay();
  }
  /** Publishes this browser device's ECDH public key (`enc`, `encVersion`, `encSig`) to a relay-capable lobby when missing or rotated. */
  private async maybePublishEncKey(status: RoomStatus) {
    if (this.stopped || this.publishingEnc || !status.memberId || (!status.relayUrl && !status.roster) || typeof this.api?.command !== 'function') return;
    const now = this.now();
    if (now - this.lastEncPublishAt < 5_000) return;
    try {
      const id = await identity();
      const selfDev = status.devices?.find(d => d.id === this.deviceId);
      if (!selfDev || (selfDev.enc === id.encPublicKey && selfDev.encVersion === id.encVersion && selfDev.encSig)) return;
      this.publishingEnc = true;
      this.lastEncPublishAt = now;
      const binding = await signDeviceEncKey(this.roomId);
      await this.api.command('profile', this.roomId, binding);
    } catch {
      // Retried on a later status poll.
    } finally {
      this.publishingEnc = false;
    }
  }
  /** When this device is the room host, publishes a monotonic host-signed `SignedRoster` whenever devices/removals change. */
  private async maybePublishRoster(status: RoomStatus) {
    if (this.stopped || this.publishingRoster || !status.memberId || status.ownerId !== status.memberId) return;
    if (typeof this.api?.command !== 'function') return;
    const now = this.now();
    if (now - this.lastRosterPublishAt < 2_000) return;
    // Only the current roster host (or the first host device if no roster exists yet) publishes.
    const currentRoster = this.verifiedRoster;
    if (currentRoster && currentRoster.body.host !== this.deviceId) {
      const currentHostStillPresent = status.devices?.some(d => d.id === currentRoster.body.host && d.memberId === status.ownerId);
      if (currentHostStillPresent) return;
    }
    const selfDev = status.devices?.find(d => d.id === this.deviceId);
    if (!selfDev?.enc || !selfDev.encVersion || !selfDev.encSig) return;

    this.publishingRoster = true;
    try {
      const entries: RosterEntry[] = [];
      for (const dev of status.devices || []) {
        if (!dev.enc || !dev.encVersion || !dev.encSig) continue;
        const okRoom = await verifyEncBinding(dev.publicKey, { room: this.roomId, deviceId: dev.id, enc: dev.enc, encVersion: dev.encVersion }, dev.encSig);
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
      if (!entries.some(e => e.id === this.deviceId)) return;
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

      const sameDevices = currentRoster
        && currentRoster.body.host === this.deviceId
        && canonicalJson(currentRoster.body.devices) === canonicalJson(entries)
        && canonicalJson(currentRoster.body.removed) === canonicalJson(removed);
      const stale = !currentRoster || now - currentRoster.body.at >= ROSTER_REFRESH_MS;
      if (sameDevices && !stale) return;

      const body: RosterBody = {
        v: 1,
        room: this.roomId,
        version: (currentRoster?.body.version ?? 0) + 1,
        prev: currentRoster ? await hashRosterBody(currentRoster.body) : '',
        at: now,
        host: this.deviceId,
        devices: entries,
        removed,
      };
      const roster = await signRoster(body, sign);
      this.lastRosterPublishAt = now;
      const updated = await this.api.command('roster-publish', this.roomId, { roster });
      if (updated?.roster) await this.verifyIncomingRoster(updated);
      else await this.verifyIncomingRoster({ ...status, roster });
    } catch {
      // Retried on a later status poll.
    } finally {
      this.publishingRoster = false;
    }
  }
  /** Signs and publishes roster version N+1 transferring host authority to `newHostDeviceId` (Section 5.2). */
  async publishHostTransfer(newHostDeviceId: string): Promise<SignedRoster> {
    if (!this.verifiedRoster || !this.status) throw new Error('No verified roster available for host transfer.');
    if (this.verifiedRoster.body.host !== this.deviceId) throw new Error('Only the current host device can sign a host transfer.');
    if (!this.verifiedRoster.body.devices.some(d => d.id === newHostDeviceId)) {
      throw new Error('New host device must be present in the verified roster.');
    }
    const body: RosterBody = {
      v: 1,
      room: this.roomId,
      version: this.verifiedRoster.body.version + 1,
      prev: await hashRosterBody(this.verifiedRoster.body),
      at: this.now(),
      host: newHostDeviceId,
      devices: this.verifiedRoster.body.devices,
      removed: this.verifiedRoster.body.removed,
    };
    const roster = await signRoster(body, sign);
    await this.api.command('roster-publish', this.roomId, { roster });
    await this.verifyIncomingRoster({ ...this.status, roster });
    return roster;
  }
  /** Starts the optional WSS+HTTPS relay client once `status.relayUrl` is advertised and this device is admitted. */
  private async ensureRelayClient(status: RoomStatus) {
    if (this.stopped || !status.relayUrl || !status.memberId || this.relayClient) return;
    if (!this.createRelayClient && typeof WebSocket === 'undefined') return;
    try {
      const id = await identity();
      if (this.stopped || this.relayClient) return;
      const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null'
        ? location.origin
        : status.relayUrl.replace(/^ws/, 'http').replace(/\/api\/relay\/v1.*$/, '');
      const opts: RelayClientOptions = {
        origin,
        relayUrl: status.relayUrl,
        roomId: this.roomId,
        deviceId: this.deviceId,
        publicKey: id.publicKey,
        session: this.session,
        sign,
        rosterVersion: () => this.verifiedRoster?.body.version ?? 1,
        onEnvelope: (envelope, meta) => this.handleRelayEnvelope(envelope, meta.cursor),
        onStatus: pushed => { if (this.stopped) return; this.pushedStatus = pushed; this.onPushedStatus?.(); },
        // Pushes stopped: wake the caller, which polls now rather than at the end of its wait.
        onStatusLost: () => { if (!this.stopped) this.onPushedStatus?.(); },
        onStateChange: state => {
          if (state === 'wss' || state === 'https') {
            this.relayHistorySynced.clear();
            this.flush();
            this.syncHistoryViaRelay();
            this.notify();
          }
        },
        onAuthError: () => {
          this.relayClient?.stop();
        },
      };
      this.relayClient = this.createRelayClient ? this.createRelayClient(opts) : new RelayClient(opts);
      if (this.statusWatch) this.relayClient.watchStatus(this.statusWatch);
      this.relayClient.start();
    } catch {
      // Relay unavailable; WebRTC continues unaffected.
    }
  }
  private disconnect() {
    for (const [id, peer] of [...this.peers]) this.dropPeer(id, peer);
    this.peers.clear();
    if (this.relayClient) {
      this.relayClient.stop();
      this.relayClient = undefined;
    }
  }
  stop() {
    this.stopped = true; this.disconnect();
    // No file is fetched for a stopped engine: another owner, if any, fetches what the room needs.
    this.files.keep(() => false);
    if (this.receiptTimer) { clearTimeout(this.receiptTimer); this.receiptTimer = undefined; void this.transaction(() => this.writeReceipts()).catch(() => {}); }
    for (const timer of this.historyRetryTimers.values()) clearTimeout(timer);
    this.historyRetryTimers.clear();
    this.historyRetryAt.clear();
    for (const timer of this.historyTimeoutTimers.values()) clearTimeout(timer);
    this.historyTimeoutTimers.clear();
    this.historyInFlight.clear();
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
