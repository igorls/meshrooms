import type { SignedRoster } from './relay-crypto';
import type { Claim, Floor } from '../collab';
export type { SignedRoster } from './relay-crypto';

/** Browser-room v1 is independent of the native node's credentials and grants. */
export const browserProtocol = 'meshrooms-browser-v1';
/** Numeric wire protocol version advertised on `/api/lobby/health` and optionally sent via `PROTOCOL_HEADER`. */
export const PROTOCOL_VERSION = 1;
/** Oldest numeric wire protocol version this coordinator accepts before answering HTTP 426. */
export const MIN_PROTOCOL_VERSION = 1;
/** Optional HTTP header clients send to declare their numeric wire protocol version. */
export const PROTOCOL_HEADER = 'x-meshrooms-protocol';
/** Error `code` returned with HTTP 426 when a client's declared protocol version is below `MIN_PROTOCOL_VERSION`. */
export const UPGRADE_REQUIRED = 'upgrade-required';
export type Command = {
  protocol: typeof browserProtocol; origin: string; id: string; at: number;
  action:
    | 'create' | 'creation-status' | 'request' | 'cancel' | 'status' | 'decide' | 'link' | 'remove' | 'signal'
    | 'agent-invite' | 'agent-redeem' | 'settings' | 'profile' | 'rename' | 'repositories' | 'claim' | 'transfer-host' | 'close'
    | 'pair-offer' | 'pair-redeem' | 'pair-cancel'
    | 'roster-publish' | 'relay-open' | 'relay-send' | 'relay-poll' | 'relay-wake-register' | 'relay-state-get' | 'relay-state-put';
  roomId: string; payload: Record<string, unknown>;
};
export type SignedCommand = { command: Command; publicKey: string; signature: string };
export type BrowserDevice = {
  id: string; publicKey: string; label: string; memberId: string; admittedAt: number;
  /** Raw uncompressed P-256 ECDH public key (base64, 88 chars) for E2E relay envelopes. */
  enc?: string;
  /** Monotonic encryption key version; increments when the device rotates `enc`. */
  encVersion?: number;
  /** Device ECDSA signature binding `{ room, deviceId, enc, encVersion }`. */
  encSig?: string;
  /** True for cloud/ephemeral agents that registered a relay inbox and wake trigger. */
  wakeable?: true;
  /** Earlier non-revoked memberships this same device key held before leaving and rejoining, so earlier signed records stay verifiable. */
  priorMembers?: { memberId: string; retiredAt?: number }[];
};
/** Who may receive a message via peer-to-peer history replication (`docs/flows/history-replication.md`). */
export type MessageVisibility = 'members' | 'room';
const agentRuntimeLabels = { harness: 'harness', model: 'model', reasoningEffort: 'reasoning effort', serviceTier: 'service tier' } as const;
type AgentRuntimeField = keyof typeof agentRuntimeLabels;
export const AGENT_RUNTIME_FIELDS = Object.keys(agentRuntimeLabels) as AgentRuntimeField[];
/** Agents report these settings themselves. The room cannot verify them. */
export type AgentRuntimeProfile = Partial<Record<AgentRuntimeField, string>>;

export function cleanAgentRuntimeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} ._:+()/@-]{0,47}$/u.test(label) ? label : undefined;
}

export function agentRuntimeLabelError(field: AgentRuntimeField): string {
  return `Give a ${agentRuntimeLabels[field]} of up to 48 letters, digits, spaces or . _ : + ( ) / @ -.`;
}

/**
 * Members without a role joined before agents existed and are people. An agent's operator is the member who confirmed it.
 * `avatar` is a short hash of the member's picture; fetch it from /api/lobby/rooms/:room/avatars/:member?h=<hash>.
 * `joinedAt` is the member's first admission time on the room service's clock, preserved when companion devices link later.
 */
export type BrowserMember = AgentRuntimeProfile & { id: string; name: string; role?: 'human' | 'agent'; operatorId?: string; avatar?: string; joinedAt?: number };
/**
 * A rename of an agent after it joined, as the room service reports it. `by` is the member who renamed it (the host or the
 * agent's operator), shown by that member's current name. The service keeps only the latest few, for members still here.
 */
export type RenameNotice = { id: string; at: number; memberId: string; by: string; from: string; to: string };
/** Renames the room service reports at once; older ones fall off. */
export const MAX_RENAME_NOTICES = 20;
/**
 * `agent` requests come only from a redeemed agent link while the host requires approval for guests' agents. A companion
 * request carries either a `code` its person enters on another device, or `pairing`, a proof made with a secret the
 * person's browser gave the desktop app (src/browser/pairing.ts), which that browser then links with: never both. The
 * room service keeps the proof and shows it to nobody.
 */
export type JoinRequest = {
  id: string; device: BrowserDevice; name: string; kind: 'person' | 'companion' | 'agent';
  state: 'pending' | 'admitted' | 'declined' | 'expired'; expiresAt: number; code?: string; pairing?: string; linkedMemberId?: string; operatorId?: string;
};
/**
 * `link {pairing}` matched no request waiting in the room: the app hasn't asked there yet, or the pairing expired. It
 * counts against the linking device's wrong codes like any miss, so the browser links once the app says it has asked.
 */
export const PAIRING_NOT_FOUND = 'pairing-not-found';
/** `pair-redeem` found no open offer under that code: it was mistyped, used, cancelled or expired (the answer never says which). */
export const PAIR_OFFER_NOT_FOUND = 'pair-offer-not-found';
/**
 * `link {pairing, preview: true}`: the one request in the room that answers the secret, shown without linking it, so a
 * trusted device that isn't the host (hosts see requests in `RoomStatus.requests`) can show the phone's label and the
 * key-bound words (pairingSas) before it links.
 */
export type PairingPreview = { requestId: string; label: string; publicKey: string; deviceId: string; expiresAt: number };
/** What `pair-redeem` gives the phone: the person's name, the trusted device's id and the rooms the offer names. */
export type PairingOffer = { name: string; device: string; rooms: string[]; expiresAt: number };
/** What a command can add to its answer: `link` (admitted, preview, revoked), `pair-offer`, `pair-redeem` and `pair-cancel`. */
export type CommandAnswer = { admitted?: boolean; preview?: PairingPreview; revoked?: number; offer?: PairingOffer | { expiresAt: number }; cancelled?: boolean;
  /** `claim`: who holds the message now (this agent, or the one that got there first); none once released. */
  claim?: Claim | null };
/** The public room service (docs/browser-rooms.md): where the desktop app makes new rooms unless told otherwise. */
export const PUBLIC_ROOM_SERVICE = 'https://meshrooms.wormdb.dev';
/**
 * Every address of the public room service. It is one service: the same rooms, reached through each. A browser keeps
 * its identity and rooms per address, so an address stays served once people have used it.
 */
export const PUBLIC_ROOM_SERVICES: readonly string[] = [PUBLIC_ROOM_SERVICE, 'https://meshrooms.ai'];
/** Whether two room service origins reach the same rooms: the same origin, or two addresses of the public service. */
export const sameRoomService = (a: string, b: string) => a === b || (PUBLIC_ROOM_SERVICES.includes(a) && PUBLIC_ROOM_SERVICES.includes(b));
/** Host-controlled room rules. Agents' own bridges enforce the floor and wake rules; the room service enforces admission. */
export type RoomSettings = {
  /** Agents reply only when addressed, or to every message from a person. */
  floor: Floor;
  /** Whether a task an agent assigns to another agent wakes it, as a person's assignment does. */
  agentAssignmentsWake: boolean;
  /** Whether agents connected by people other than the host wait for the host to admit them. */
  guestAgentApproval: boolean;
  /** Whether the host also admits each new device a member links to themselves (off: the member's own link admits it). */
  hostApprovesDevices: boolean;
  /** Whether new messages are signed with `visibility: 'room'` so newcomers and agents admitted later can receive them. */
  historyForNewcomers: boolean;
};
/** Defaults for new rooms. Hosts approve guests' agents unless they turn it off; rooms created before this default keep off. */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = { floor: 'humans-first', agentAssignmentsWake: false, guestAgentApproval: true, hostApprovesDevices: false, historyForNewcomers: false };
/** A one-time agent link a person created and has not yet been used; the token itself is never stored or returned again. */
export type AgentInvite = { name: string; expiresAt: number };
export type Signal = { seq: number; from: string; session: string; targetSession: string; description: RTCSessionDescriptionInit };
export type RoomStatus = {
  roomId: string; title: string; epoch: string; hostOnline: boolean; memberId?: string; ownerId?: string;
  deviceId: string; request?: JoinRequest; requests?: JoinRequest[];
  members?: BrowserMember[]; renames?: RenameNotice[]; devices?: (BrowserDevice & { session?: string })[];
  signals?: Signal[]; iceServers?: RTCIceServer[]; agentInvites?: AgentInvite[];
  /** Keys of devices that have left, so their earlier signed records still verify for people who join later (see signerOf). */
  formerDevices?: FormerDevice[];
  settings?: RoomSettings;
  /** Disclosed even before admission so join screens show whether new messages are shared with newcomers. */
  historyForNewcomers?: boolean;
  /** GitHub `owner/name` repositories people pinned for this room; tasks open issues in them. */
  repositories?: string[];
  /** Agents' claims on messages that went to every agent (src/collab.ts, `needsClaim`): who answers each. */
  claims?: Claim[];
  /** When the room service removes this room if no admitted device opens it again (idle expiry). */
  expiresAt?: number;
  /** Host-signed monotonic device roster used as the authoritative recipient set for E2E relay encryption. */
  roster?: SignedRoster;
  /** WebSocket relay endpoint URL advertised by the room service when the relay is enabled. */
  relayUrl?: string;
};
/** Status of a room the host closed, or the service removed: every command for it answers 410 with this `code`. */
export const ROOM_CLOSED = 'room-closed';
/** Codes for room-creation invite errors, so the create form can ask for (another) code. */
export const INVITE_ERRORS = ['invite-required', 'invite-invalid', 'invite-used', 'invite-expired'] as const;
/** Repositories a room can pin; names only, never anyone's GitHub credentials. */
export const MAX_REPOSITORIES = 8;
/** `owner/name` of a GitHub repository. `.` and `..` are not names, so a link built from one stays on that repository. */
export const validRepository = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9-]{1,39}\/[\w.-]{1,100}$/.test(v) && !/\/\.{1,2}$/.test(v);
/**
 * `role` is the member's role when the device left, so a departed agent's signed votes can never pass as a person's.
 * `retiredAt` is the room service's clock when the device left; `revoked` marks a device someone else removed (the host,
 * or its own member removing a lost device) rather than one that left from itself. Entries kept before these existed
 * carry neither.
 */
export type FormerDevice = { id: string; publicKey: string; memberId: string; role?: 'human' | 'agent'; retiredAt?: number; revoked?: true };
/**
 * The device whose key verifies a signed record that reached this device in an exchange (relayed by anyone), dated `at`
 * by its signer: a device in the room, or a former one that may still have signed it. A revoked device signs nothing
 * more: a member willing to relay for it would otherwise keep it writing tasks, votes, reactions and retractions in its
 * member's name, and the time it signs is its own to pick. Records already held stay. A device that left from itself is
 * trusted up to when it left (it could backdate, but it could have signed the same before leaving). The cost of revoking:
 * a device that joins later, or was offline, never receives the revoked device's records that nobody else holds in a
 * newer form.
 */
export function signerOf(
  status: Pick<RoomStatus, 'devices' | 'formerDevices'> | undefined,
  deviceId: unknown,
  at: unknown,
  expectedMemberId?: unknown,
): { publicKey: string; memberId: string } | undefined {
  const current = status?.devices?.find(d => d.id === deviceId);
  if (current) {
    if (expectedMemberId !== undefined && current.memberId !== expectedMemberId && current.priorMembers?.length) {
      const prior = current.priorMembers.find(p =>
        p.memberId === expectedMemberId && (p.retiredAt === undefined || (typeof at === 'number' && at <= p.retiredAt)));
      if (prior) return { publicKey: current.publicKey, memberId: prior.memberId };
    }
    return current;
  }
  const former = status?.formerDevices?.find(d => d.id === deviceId);
  if (!former || former.revoked) return undefined;
  return former.retiredAt === undefined || (typeof at === 'number' && at <= former.retiredAt) ? former : undefined;
}
/** Normalizes a display name or room title via NFKC, stripping Unicode control/format chars (bidi overrides, zero-width chars), collapsing whitespace and trimming. */
export function cleanDisplayName(raw: string): string {
  return raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
}
/** Case-folded NFKC key for display-name uniqueness checks so lookalike spacing, casing, fullwidth or bidi/zero-width tricks collide. */
export function foldDisplayName(raw: string): string {
  return cleanDisplayName(raw).toLocaleLowerCase('en-US');
}
/** Deterministic 8-hex visual fingerprint (`XXXX-XXXX`) derived from a device's SHA-256 hex id. */
export function deviceFingerprint(id: string): string {
  const hex = id.replace(/[^a-fA-F0-9]/g, '').slice(0, 8).toUpperCase();
  return hex.length > 4 ? `${hex.slice(0, 4)}-${hex.slice(4)}` : hex;
}
export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export function base64(bytes: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
export function unbase64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function deviceId(publicKey: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', unbase64(publicKey))), n => n.toString(16).padStart(2, '0')).join('');
}
export async function verify(publicKey: string, value: unknown, signature: string) {
  try {
    if (publicKey.length !== 88 || signature.length !== 88) return false;
    const key = await crypto.subtle.importKey('raw', unbase64(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unbase64(signature), encode(value));
  } catch { return false; }
}
