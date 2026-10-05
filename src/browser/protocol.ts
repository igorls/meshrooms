/** Browser-room v1 is independent of the native node's credentials and grants. */
export const browserProtocol = 'meshrooms-browser-v1';
export type Command = {
  protocol: typeof browserProtocol; origin: string; id: string; at: number;
  action: 'create' | 'request' | 'cancel' | 'status' | 'decide' | 'link' | 'remove' | 'signal' | 'agent-invite' | 'agent-redeem' | 'settings' | 'profile' | 'repositories' | 'close';
  roomId: string; payload: Record<string, unknown>;
};
export type SignedCommand = { command: Command; publicKey: string; signature: string };
export type BrowserDevice = { id: string; publicKey: string; label: string; memberId: string; admittedAt: number };
/** Members without a role joined before agents existed and are people. An agent's operator is the member who confirmed it. */
/** `avatar` is a short hash of the member's picture; fetch it from /api/lobby/rooms/:room/avatars/:member?h=<hash>. */
/** Agents report `harness` (e.g. Claude Code) and `model` themselves; the room cannot verify either. */
export type BrowserMember = { id: string; name: string; role?: 'human' | 'agent'; operatorId?: string; avatar?: string; harness?: string; model?: string };
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
/** The public room service (docs/browser-rooms.md): where the desktop app makes new rooms unless told otherwise. */
export const PUBLIC_ROOM_SERVICE = 'https://meshrooms.wormdb.dev';
/** Host-controlled room rules. Agents' own bridges enforce the floor and wake rules; the room service enforces admission. */
export type RoomSettings = {
  /** Agents reply only when addressed, or to every message from a person. */
  floor: 'humans-first' | 'open';
  /** Whether a task an agent assigns to another agent wakes it, as a person's assignment does. */
  agentAssignmentsWake: boolean;
  /** Whether agents connected by people other than the host wait for the host to admit them. */
  guestAgentApproval: boolean;
  /** Whether the host also admits each new device a member links to themselves (off: the member's own link admits it). */
  hostApprovesDevices: boolean;
};
/** Defaults for new rooms. Hosts approve guests' agents unless they turn it off; rooms created before this default keep off. */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = { floor: 'humans-first', agentAssignmentsWake: false, guestAgentApproval: true, hostApprovesDevices: false };
/** A one-time agent link a person created and has not yet been used; the token itself is never stored or returned again. */
export type AgentInvite = { name: string; expiresAt: number };
export type Signal = { seq: number; from: string; session: string; targetSession: string; description: RTCSessionDescriptionInit };
export type RoomStatus = {
  roomId: string; title: string; epoch: string; hostOnline: boolean; memberId?: string; ownerId?: string;
  deviceId: string; request?: JoinRequest; requests?: JoinRequest[];
  members?: BrowserMember[]; devices?: (BrowserDevice & { session?: string })[];
  signals?: Signal[]; iceServers?: RTCIceServer[]; agentInvites?: AgentInvite[];
  /** Keys of devices that have left, so their earlier signed task changes still verify for people who join later. */
  formerDevices?: FormerDevice[];
  settings?: RoomSettings;
  /** GitHub `owner/name` repositories people pinned for this room; tasks open issues in them. */
  repositories?: string[];
  /** When the room service removes this room if no admitted device opens it again (idle expiry). */
  expiresAt?: number;
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
/** `role` is the member's role when the device left, so a departed agent's signed votes can never pass as a person's. */
export type FormerDevice = { id: string; publicKey: string; memberId: string; role?: 'human' | 'agent' };
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
