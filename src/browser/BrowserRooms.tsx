import { Fragment, createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from 'react';
import { mentionedIds, type Task, type TaskStatus } from '../collab';
import { FloorControl, MAX_MESSAGE_FILES, MAX_UPLOAD_BYTES, MentionText, MessageAttachments, PendingFiles, TaskBoard, formatBytes, uploadName, useAutoGrow, useMentions, useStickToBottom, type AttachmentSource, type PendingFile } from '../prototype/Collaboration';
import { Wordmark } from '../prototype/RoomPrototype';
import type { Attachment, Participant, RoomSnapshot, TaskDraft } from '../room';
import { deriveActivity, duration, type ActivityRecord, type AgentActivity } from './activity';
import { issueLabel, mentionedRepositories, repositoryFrom, taskTimeline, type TaskBody, type TaskEvent } from './board';
import type { ApiError } from './client';
import { DecisionCard, DecisionForm, DecisionList } from './DecisionViews';
import { DesktopPairing } from './DesktopPairing';
import { joinLink, pairedHere } from './desktop-join';
import { LocalAgentsSection, identityOfMember, useLocalAgents, wakeLabel } from './LocalAgents';
import { due, foldDecisions, type Decision, type DecisionBody, type VoteBody } from './decisions';
import { IMAGE_TYPES, attachmentRef, displayKind, shownText, type AttachmentRef } from './files';
import { BOARD_DEFAULT, BOARD_STEP, boardLimits, clampBoardWidth, saveBoardWidth, savedBoardWidth } from './panel';
import type { FileView, SavedMessage } from './peers';
import { REACTION_EMOJI, memberReacted, type ReactionChip, type ReactionEmoji } from './reactions';
import { agentPrompt, PROMPT_HARNESSES, type PromptHarness } from './agent-prompt';
import { onStorageProblem } from './storage';
import type { RecentRoom } from './background';
import { badgeText, countUnread, freshRequests, joinNotice, tabTitle, unreadLabel, waitingLabel, waitingOf, type ReadPosition, type UnreadCount, type Waiting } from './unread';
import { DEFAULT_ROOM_SETTINGS, INVITE_ERRORS, MAX_REPOSITORIES, PUBLIC_ROOM_SERVICE, ROOM_CLOSED, base64, type BrowserMember, type RoomSettings, type RoomStatus } from './protocol';
import { BrowserSource, type RoomSession, type RoomSource } from './source';
import './browser.css';

const closedError = (e: unknown) => (e as ApiError).status === 410 && (e as ApiError).code === ROOM_CLOSED;
/** Rooms warn a week before idle expiry. */
const EXPIRY_WARNING = 7 * 86_400_000;
const deviceLabel = /Mac/.test(navigator.userAgent) ? 'Mac browser' : /Windows/.test(navigator.userAgent) ? 'Windows browser' : 'Browser';
const urlRoom = location.pathname.match(/^\/r\/([a-f0-9-]{36})$/)?.[1] || '';

/** A file chosen for the next message: read and hashed here, stored only when the message is sent. */
type ChosenFile = PendingFile & { ref?: AttachmentRef; bytes?: Uint8Array };
const fileNames = (body: SavedMessage['packet']['body']) => body.attachments?.map(a => a.name).join(', ') || '';

function RoomIcon({ kind }: { kind: 'people' | 'link' | 'close' | 'chat' | 'send' | 'tasks' | 'clip' | 'plus' | 'collapse' | 'expand' | 'vote' }) {
  const paths = {
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5" /></>,
    link: <><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chat: <path d="M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z" />,
    send: <path d="m4 12 8-8 8 8M12 4v16" />,
    tasks: <path d="M10 6h10M10 12h10M10 18h10M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" />,
    clip: <path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14.5 7" />,
    plus: <path d="M12 5v14M5 12h14" />,
    collapse: <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />,
    expand: <path d="m13 17 5-5-5-5M6 17l5-5-5-5" />,
    vote: <path d="M4 21h16M6 17V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v12M9 10l2 2 4-4" />,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
/** A face with a small plus: add a reaction. */
function ReactionIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20.9 11.2A9 9 0 1 1 12.8 3" /><path d="M8 14.5a4.5 4.5 0 0 0 8 0M9 9.5h.01M15 9.5h.01M19 2v6M16 5h6" /></svg>;
}

/**
 * The task board's left edge. While dragging, the width goes straight to the workspace's CSS variable, so the room
 * does not re-render per pixel; it is committed (and saved) when the drag ends.
 */
function BoardHandle({ workspace, width, onCommit }: { workspace: RefObject<HTMLDivElement | null>; width: number; onCommit: (width: number | undefined) => void }) {
  const [space, setSpace] = useState(() => ({ available: innerWidth, viewport: innerWidth }));
  useEffect(() => {
    const node = workspace.current; if (!node) return;
    const sizes = new ResizeObserver(() => setSpace({ available: node.clientWidth, viewport: innerWidth }));
    sizes.observe(node);
    return () => sizes.disconnect();
  }, [workspace]);
  const handle = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; from: number; value: number } | null>(null);
  const { min, max } = boardLimits(space.available, space.viewport), value = clampBoardWidth(width, space.available, space.viewport);
  function preview(next: number) {
    workspace.current?.style.setProperty('--board-width', `${next}px`); handle.current?.setAttribute('aria-valuenow', String(next));
  }
  function end() {
    if (!drag.current) return;
    const { value } = drag.current; drag.current = null;
    document.documentElement.classList.remove('board-resizing'); onCommit(value);
  }
  return <div ref={handle} className="board-handle" role="separator" aria-orientation="vertical" aria-controls="task-board" aria-label="Resize tasks panel" tabIndex={0}
    aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} title="Drag to resize · double-click to reset"
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, from: value, value }; document.documentElement.classList.add('board-resizing');
    }}
    onPointerMove={event => {
      const current = drag.current; if (!current) return;
      const next = clampBoardWidth(current.from + current.x - event.clientX, workspace.current?.clientWidth ?? space.available, innerWidth);
      if (next !== current.value) { current.value = next; preview(next); }
    }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={() => onCommit(undefined)}
    onKeyDown={event => {
      // The handle is on the board's left edge: moving it left widens the board.
      const step = event.key === 'ArrowLeft' ? BOARD_STEP : event.key === 'ArrowRight' ? -BOARD_STEP : 0;
      const next = step ? value + step : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
      if (next === undefined) return;
      event.preventDefault(); onCommit(clampBoardWidth(next, space.available, space.viewport));
    }} />;
}

/**
 * A room's badges: its unread count (in the accent when some are for you), read out as "3 unread, 1 mention", and in
 * rooms you host, a person with how many are waiting to join, read out as "1 waiting to join".
 */
function RoomBadges({ count }: { count?: UnreadCount }) {
  const label = unreadLabel(count), waiting = count?.waiting?.length || 0;
  if (!label && !waiting) return null;
  return <span className="browser-room-badges">
    {label && <><span className={`browser-room-badge ${count!.mentions ? 'is-mention' : ''}`} aria-hidden="true">{badgeText(count!.unread)}</span><span className="sr-only">, {label}</span></>}
    {waiting > 0 && <><span className="browser-room-waiting" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>{badgeText(waiting)}</span><span className="sr-only">, {waitingLabel(waiting)}</span></>}
  </span>;
}
const roomLabel = (count: UnreadCount | undefined) => [unreadLabel(count), waitingLabel(count?.waiting?.length || 0)].filter(Boolean).join(', ');
/** Request ids this tab has announced; kept for the tab's session, so moving between rooms doesn't announce them again. */
function announcedRequests() {
  try { return new Set<string>(JSON.parse(sessionStorage.getItem('meshrooms:announced') || '[]')); } catch { return new Set<string>(); }
}
function saveAnnounced(ids: Set<string>) {
  try { sessionStorage.setItem('meshrooms:announced', JSON.stringify([...ids].slice(-200))); } catch { /* Announced again after a reload. */ }
}

const isAgent = (member: BrowserMember | undefined) => member?.role === 'agent';
/** Room members in the shape the shared mention helpers expect. Members from before agents existed are people. */
const participantsOf = (members: BrowserMember[] = []): Participant[] =>
  members.map(m => ({ id: m.id, name: m.name, role: m.role ?? 'human', state: 'remote', detail: '', operatorId: m.operatorId }));
/** The page's room source (see source.ts), for the parts of the room that load their own data. */
const Source = createContext<RoomSource | undefined>(undefined);
/** A member's picture, or their initial (a rounded square for agents) when they have none. */
function MemberAvatar({ member, roomId, fallback }: { member?: BrowserMember; roomId: string; fallback: string }) {
  const agent = member?.role === 'agent', source = useContext(Source), [, loaded] = useReducer((n: number) => n + 1, 0);
  const src = member?.avatar && source ? source.avatar(roomId, member.id, member.avatar, loaded) : undefined;
  if (src) return <img className={`avatar avatar-picture ${agent ? 'agent' : ''}`} src={src} alt="" />;
  return <span className={`avatar ${agent ? 'agent' : ''}`} aria-hidden="true">{fallback.slice(0, 1)}</span>;
}
/** Crops to a centred square, scales to 128 px and encodes it small enough for the room service (16 KB). */
async function avatarData(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('This image could not be read.'); });
  const side = Math.min(bitmap.width, bitmap.height), canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
  bitmap.close();
  // Browsers without WebP encoding hand back PNG instead, so check the type before trusting the size.
  for (const [type, quality] of [['image/webp', 0.85], ['image/webp', 0.6], ['image/jpeg', 0.8], ['image/jpeg', 0.6]] as const) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
    if (blob?.type === type && blob.size <= 16 * 1024) return base64(await blob.arrayBuffer());
  }
  throw new Error('This picture is too detailed to fit in 16 KB. Try a simpler one.');
}
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
/**
 * Whether `b` continues `a` under one header: same author, same day, within five minutes, and neither is a reply.
 * A reply's "Replying to" context belongs to that message alone, so nothing joins it and it joins nothing.
 */
const grouped = (a: SavedMessage | undefined, b: SavedMessage) => !!a && a.packet.body.memberId === b.packet.body.memberId && sameDay(a.packet.body.at, b.packet.body.at)
  && b.packet.body.at - a.packet.body.at < 300_000 && !a.packet.body.replyTo && !b.packet.body.replyTo;
function dayLabel(at: number) {
  return sameDay(at, Date.now()) ? 'Today' : new Date(at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}
const statusMoves: Record<TaskStatus, string> = { todo: 'back to to-do', doing: 'to in progress', done: 'to done' };
/** "Igor assigned “Fix header” to Wren and moved it to in progress". The title leads; later phrases say "it". */
function describeTask(event: TaskEvent, name: (memberId: string, subject?: boolean) => string) {
  const title = `“${event.title}”`, phrases: string[] = [], it = () => phrases.length ? 'it' : title;
  if (event.removed) return `${name(event.memberId, true)} removed ${title}`;
  if (event.created) phrases.push(`created ${title}`);
  if (event.updated) phrases.push(`updated ${title}`);
  if (event.renamedFrom !== undefined) phrases.push(`renamed “${event.renamedFrom}” to ${title}`);
  if (event.assigneeId !== undefined) phrases.push(event.assigneeId === null ? `unassigned ${it()}` : event.assigneeId === event.memberId ? `took ${it()}` : `assigned ${it()} to ${name(event.assigneeId)}`);
  if (event.status) phrases.push(`moved ${it()} ${statusMoves[event.status]}`);
  if (event.notes) phrases.push(`edited the notes on ${it()}`);
  // A task made from a pasted link is titled with it already.
  if (event.issue !== undefined && !(event.created && event.issue && issueLabel(event.issue) === event.title))
    phrases.push(event.issue === null ? `unlinked the issue from ${it()}` : `linked ${it()} to ${issueLabel(event.issue)}`);
  return `${name(event.memberId, true)} ${phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}` : phrases[0]}`;
}
type TranscriptItem = { message: SavedMessage; event?: undefined; decision?: undefined } | { event: TaskEvent; message?: undefined; decision?: undefined }
  | { decision: Decision; message?: undefined; event?: undefined };
const itemAt = (item: TranscriptItem) => item.message?.packet.body.at ?? item.event?.at ?? item.decision!.createdAt;

export function BrowserRooms({ source: given }: { source?: RoomSource } = {}) {
  const [source] = useState<RoomSource>(() => given ?? new BrowserSource());
  return <Source.Provider value={source}><Rooms source={source} /></Source.Provider>;
}
function Rooms({ source }: { source: RoomSource }) {
  const [status, setStatus] = useState<RoomStatus>();
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [recent, setRecent] = useState<RecentRoom[]>([]);
  const [messages, setMessages] = useState<SavedMessage[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  /** Why the room is gone (closed by its host or removed by the service); the room view is replaced by this. */
  const [closed, setClosed] = useState('');
  /** Another tab of this browser claimed this room, so this tab's engine stopped writing and connecting (see claimRoom). */
  const [lostRoom, setLostRoom] = useState(false);
  const [inviteRequired, setInviteRequired] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  /** Where the local page makes new rooms (the person device's room service), shown when it isn't the public one. */
  const [roomService, setRoomService] = useState<string>();
  const [network, setNetwork] = useState('');
  /** Local saving is failing: shown until a save succeeds again, unlike network problems, which the next poll clears. */
  const [storageProblem, setStorageProblem] = useState<string>();
  useEffect(() => onStorageProblem(setStorageProblem), []);
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [liveMessage, setLiveMessage] = useState<{ id: string; text: string }>();
  const [replyId, setReplyId] = useState<string>();
  const [agentName, setAgentName] = useState('');
  const [repositoryDraft, setRepositoryDraft] = useState('');
  /** The agent link just made; `expiresAt` is filled in once room status lists it as unused. */
  const [agentLink, setAgentLink] = useState<{ name: string; url: string; expiresAt?: number }>();
  /** The bridge version the service asks agents to run, pinned in the prompt people copy for their agent. */
  const [agentVersion, setAgentVersion] = useState<string>();
  const [promptHarness, setPromptHarness] = useState<PromptHarness>('claude');
  /** Rooms where this person chose "Not now" on the connect-an-agent banner. */
  const [agentCtaDismissed, setAgentCtaDismissed] = useState(true);
  /** This browser's device id, once its identity is loaded. */
  const [deviceId, setDeviceId] = useState<string>();
  /** Unread counts of this person's rooms, as the tabs holding them publish them. */
  const [counts, setCounts] = useState<Record<string, UnreadCount>>({});
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  /** How far this device has read the open room; loaded with the room's history. */
  const [position, setPosition] = useState<ReadPosition>();
  /** Someone new waiting to join another room this person hosts: announced once in this tab. */
  /** People newly waiting to join rooms this person hosts, announced one at a time, oldest first. */
  const [joinAlerts, setJoinAlerts] = useState<{ roomId: string; request: Waiting }[]>([]);
  const announced = useRef<Set<string> | null>(null);
  const [confirming, setConfirming] = useState<string>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardWidth, setBoardWidth] = useState(savedBoardWidth);
  const workspace = useRef<HTMLDivElement>(null);
  const [railCollapsed, setRailCollapsed] = useState(() => { try { return localStorage.getItem('meshrooms:rail') === 'collapsed'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('meshrooms:rail', railCollapsed ? 'collapsed' : 'open'); } catch { /* storage may be unavailable */ } }, [railCollapsed]);
  const [avatarFor, setAvatarFor] = useState<string>();
  const avatarInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Record<string, FileView>>({});
  const [chosen, setChosen] = useState<ChosenFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [taskOps, setTaskOps] = useState<TaskBody[]>([]);
  const [decisionOps, setDecisionOps] = useState<(DecisionBody | VoteBody)[]>([]);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [reactions, setReactions] = useState<ReactionChip[]>([]);
  const [reactPicker, setReactPicker] = useState<string>();
  const closing = useRef(new Set<string>());
  const [highlight, setHighlight] = useState<string>();
  const [activity, setActivity] = useState<Record<string, ActivityRecord>>({});
  const [now, setNow] = useState(() => Date.now());
  const composer = useRef<HTMLTextAreaElement>(null);
  const currentStatus = useRef<RoomStatus | undefined>(undefined);
  /** The open room's actions, once its connection is held (see RoomSource.open). */
  const peers = useRef<RoomSession | null>(null);
  /** Older messages can be loaded (the local page hands out the newest first). */
  const [olderAvailable, setOlderAvailable] = useState(false);
  const everJoined = useRef(false);
  const stick = useStickToBottom();
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const linkDevice = useRef<HTMLDetailsElement>(null);
  /** Room details' "Use the desktop app", which the header's hint opens. */
  const desktopPairing = useRef<HTMLDetailsElement>(null);
  const admitted = !!status?.memberId;
  const host = admitted && status?.memberId === status?.ownerId;
  const self = status?.members?.find(m => m.id === status.memberId);
  const pending = status?.request?.state === 'pending';
  const participants = useMemo(() => participantsOf(status?.members), [status?.members]);
  const mentions = useMentions(participants, status?.memberId, composer, setText);
  useAutoGrow(composer, text);
  const agents = status?.members?.filter(isAgent) || [];
  const people = (status?.members?.length || 0) - agents.length;
  /** The local page: the person's agents on this computer, read while the details are open or one of them is in the room. */
  const localAgents = useLocalAgents(source.agents, admitted && (detailsOpen || agents.some(a => a.operatorId === status?.memberId)));
  /** The agent whose sessions the people list asked to show (`at`: each ask scrolls to it again). */
  const [agentFocus, setAgentFocus] = useState<{ id: string; at: number }>();
  /** How an agent of the person's wakes here, from its identity on this computer (the local page only). */
  const wakeOf = (member: BrowserMember) => source.agents && member.operatorId === status?.memberId ? identityOfMember(localAgents.listing, urlRoom, member.id) : undefined;
  const reply = messages.find(m => m.packet.body.id === replyId);
  /** "you", or the operator's name, for an agent member. */
  const operatorOf = (member: BrowserMember | undefined) => {
    if (!isAgent(member) || !member!.operatorId) return undefined;
    return member!.operatorId === status?.memberId ? 'you' : status?.members?.find(m => m.id === member!.operatorId)?.name || 'a former member';
  };
  /** "Claude Code · claude-opus-5-5", as the agent reported it. */
  const runtimeOf = (member: BrowserMember | undefined) => isAgent(member) ? [member!.harness, member!.model].filter(Boolean).join(' · ') || undefined : undefined;
  const nameOf = (memberId: string) => status?.members?.find(m => m.id === memberId)?.name || 'Former member';
  /** Task changes read as quiet lines between messages, placed by time. They are local views, never sent. */
  const timeline = useMemo(() => taskTimeline(taskOps), [taskOps]);
  /** Decisions as every device folds them: people's votes count, agents' are advice. */
  // Departed members keep their role, so a removed agent's vote can never be counted as a person's.
  const former = useMemo(() => [...new Map((status?.formerDevices ?? []).map(d => [d.memberId, { id: d.memberId, ...(d.role ? { role: d.role } : {}) }])).values()], [status?.formerDevices]);
  const decisions = useMemo(() => foldDecisions(decisionOps, { ownerId: status?.ownerId, members: status?.members ?? [], former }), [decisionOps, status?.ownerId, status?.members, former]);
  const openDecisions = decisions.filter(d => d.state === 'open').length;
  const items = useMemo((): TranscriptItem[] => {
    // Task lines and decision cards sit between messages by time; messages keep their arrival order.
    const inserts: TranscriptItem[] = [...timeline.map(event => ({ event })), ...decisions.map(decision => ({ decision }))].sort((a, b) => itemAt(a) - itemAt(b));
    const merged: TranscriptItem[] = []; let next = 0;
    for (const message of messages) {
      while (next < inserts.length && itemAt(inserts[next]) <= message.packet.body.at) merged.push(inserts[next++]);
      merged.push({ message });
    }
    return [...merged, ...inserts.slice(next)];
  }, [messages, timeline, decisions]);
  // Close this person's own decisions once the result can't change or the deadline passes (agents' bridges do the same).
  useEffect(() => {
    // The person device behind the local page closes its own decisions itself.
    if (!status?.memberId || source.isLocal) return;
    const tick = () => {
      const at = Date.now();
      if (decisions.some(d => d.state === 'open' && d.closesAt)) setNow(at);
      for (const d of decisions) if (d.createdBy === status.memberId && due(d, at) && !closing.current.has(`${d.key}:${d.revision}`)) {
        closing.current.add(`${d.key}:${d.revision}`);
        void peers.current?.reviseDecision(d, { close: true }).catch(() => closing.current.delete(`${d.key}:${d.revision}`));
      }
    };
    tick(); const timer = setInterval(tick, 5000); return () => clearInterval(timer);
  }, [decisions, status?.memberId, source]);

  useEffect(() => {
    let disposed = false, room: { done: Promise<void>; dispose(): void } | undefined;
    setReady(false); setError('');
    void (async () => {
      const { deviceId: device, recent: rooms, name: profile } = await source.start();
      if (disposed) return;
      setRecent(rooms); setName(profile); setDeviceId(device);
      if (!urlRoom) {
        const pendingCreate = await source.readPref<{ name: string; title: string }>('pending-create');
        if (pendingCreate) { setName(pendingCreate.name); setTitle(pendingCreate.title); }
        // During the invite-only beta the service asks for a code to create rooms; joining by link never needs one.
        void source.health().then(health => { if (disposed) return; if (health.inviteRequired === true) setInviteRequired(true); if (health.roomService) setRoomService(health.roomService); }).catch(() => { /* The create response says so too. */ });
        setReady(true); return;
      }
      void source.health().then(health => { if (!disposed && typeof health.currentAgentVersion === 'string') setAgentVersion(health.currentAgentVersion); }).catch(() => { /* The prompt falls back to @latest. */ });
      void source.readPref<boolean>(`agent-cta-dismissed:${urlRoom}`).then(dismissed => { if (!disposed) setAgentCtaDismissed(!!dismissed); }).catch(() => setAgentCtaDismissed(false));
      const info = await source.room(urlRoom);
      if ('closed' in info) {
        const rest = await source.forget(urlRoom);
        if (!disposed) { setRecent(rest); setClosed(info.closed); setReady(true); }
        return;
      }
      if (disposed) return;
      setTitle(info.title);
      room = source.open(urlRoom, device, {
        ready: session => { peers.current = session; },
        messages: (m, c, added) => {
          if (added) {
            const own = added.packet.body.deviceId === (currentStatus.current?.deviceId || device);
            stick.arrived(own);
            if (!own) {
              const author = currentStatus.current?.members?.find(p => p.id === added.packet.body.memberId)?.name || 'Room member';
              setLiveMessage({ id: added.packet.body.id, text: `${author}: ${shownText(added.packet.body) || `shared ${fileNames(added.packet.body)}`}` });
            }
          }
          setMessages(m); setConnected(c); setOlderAvailable(!!peers.current?.hasOlder());
        },
        network: setNetwork,
        board: (board, ops) => { setTasks(board); setTaskOps(ops); },
        files: setFiles,
        activity: records => { setActivity(records); setNow(Date.now()); },
        decisions: setDecisionOps,
        reactions: setReactions,
        position: setPosition,
        status: next => {
          if (next.request?.state === 'expired' || next.request?.state === 'declined') setNotice('');
          currentStatus.current = next;
          setStatus(next); setReady(true); setNetwork('');
          if (next.memberId) everJoined.current = true;
        },
        closed: reason => { setClosed(current => current || reason); setStatus(undefined); setNetwork(''); setReady(true); },
        recent: setRecent,
        lost: () => { setLostRoom(true); setNetwork(''); },
      });
      await room.done;
    })().catch(e => { if (!disposed) { setError(e.message); setReady(true); } });
    return () => { disposed = true; room?.dispose(); peers.current = null; };
  }, [source, retry]);
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  // Once this device is known: follow the counts of the person's rooms, and keep the other rooms connected.
  useEffect(() => {
    if (!deviceId) return;
    return source.watch(deviceId, urlRoom, { counts: setCounts, recent: setRecent });
  }, [deviceId, source]);
  // The open room is read up to its newest message while the tab is visible and the conversation follows the end.
  const lastId = messages.at(-1)?.packet.body.id;
  const reading = visible && stick.following && admitted && !closed;
  useEffect(() => {
    if (!deviceId || !position || !reading || !lastId || position.id === lastId) return;
    setPosition({ id: lastId, at: Date.now() });
    void peers.current?.markRead(lastId).catch(() => { /* Saved with the next message read. */ });
  }, [deviceId, position, reading, lastId]);
  // The open room's count, for this browser's other tabs (this one shows no badge for it).
  const ownCount = useMemo(() => position && status?.memberId ? { ...countUnread(messages.map(m => m.packet.body), position, status.memberId, status.members || []), waiting: waitingOf(status) } : undefined,
    [messages, position, status?.memberId, status?.members, status?.requests]);
  useEffect(() => { if (deviceId && ownCount && !closed) peers.current?.publishCount(ownCount); }, [deviceId, ownCount, closed]);
  /** Unread in the person's other rooms: the tab title's (N). */
  const others = recent.filter(r => r.id !== urlRoom);
  const otherUnread = others.reduce((sum, r) => sum + (counts[r.id]?.unread || 0), 0);
  const otherWaiting = others.flatMap(r => counts[r.id]?.waiting || []);
  // The tab names the open room, so several Meshrooms tabs can be told apart.
  useEffect(() => { document.title = tabTitle(urlRoom ? title : '', otherUnread, otherWaiting.length); }, [title, otherUnread, otherWaiting.length]);
  // A new request in another room this person hosts is announced once, here, with a way to open that room and admit.
  useEffect(() => {
    if (!deviceId) return;
    announced.current ??= announcedRequests();
    const before = announced.current.size;
    const fresh = freshRequests(counts, announced.current, urlRoom, new Set(recent.map(r => r.id)));
    if (announced.current.size !== before) saveAnnounced(announced.current);
    if (fresh.length) setJoinAlerts(queue => [...queue, ...fresh]);
  }, [deviceId, counts, recent]);
  // Who is waiting is live: re-read now and then while anyone is, so a list its owner stopped refreshing goes away.
  const anyWaiting = Object.values(counts).some(c => c.waiting?.length);
  useEffect(() => {
    if (!deviceId || !anyWaiting) return;
    const timer = setInterval(() => setCounts(source.counts(deviceId)), 5000);
    return () => clearInterval(timer);
  }, [deviceId, anyWaiting, source]);
  // Leaving this room: whoever holds it next says who is waiting, so no other tab announces a stale request.
  useEffect(() => {
    if (!deviceId || !urlRoom) return;
    const leave = () => source.leave(deviceId, urlRoom);
    addEventListener('pagehide', leave);
    return () => removeEventListener('pagehide', leave);
  }, [deviceId]);
  // The first queued request still waiting is shown; the others follow as each is dismissed or admitted.
  const alertShown = joinAlerts.find(a => counts[a.roomId]?.waiting?.some(w => w.id === a.request.id) && recent.some(r => r.id === a.roomId));
  const alertRoom = alertShown && recent.find(r => r.id === alertShown.roomId)?.title;
  const alertsMore = alertShown ? joinAlerts.filter(a => a !== alertShown && counts[a.roomId]?.waiting?.some(w => w.id === a.request.id)).length : 0;
  useEffect(() => { if (detailsOpen) detailsHeading.current?.focus(); }, [detailsOpen]);
  // A link works once: once room status stops listing it as unused, it was used (or it expired), and the page says so
  // instead of offering a link that no longer works. Status may lag the link by a poll, so only a link it has listed counts.
  const listedLink = agentLink && status?.agentInvites?.find(i => i.name === agentLink.name);
  useEffect(() => {
    if (listedLink && agentLink && agentLink.expiresAt !== listedLink.expiresAt) setAgentLink({ ...agentLink, expiresAt: listedLink.expiresAt });
  }, [listedLink?.expiresAt, agentLink]);
  const linkAgent = agentLink && status?.members?.find(m => isAgent(m) && m.name === agentLink.name && m.operatorId === status.memberId);
  const linkState: 'open' | 'joined' | 'used' | 'expired' | undefined = !agentLink ? undefined : linkAgent ? 'joined'
    : listedLink || agentLink.expiresAt === undefined ? 'open' : Date.now() >= agentLink.expiresAt ? 'expired' : 'used';
  // Activity durations and staleness move with the clock, not only with packets.
  useEffect(() => {
    if (!agents.length) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [agents.length]);
  useEffect(() => {
    if (!admitted || !notice) return;
    const timeout = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timeout);
  }, [admitted, notice]);

  useEffect(() => {
    if (!highlight) return;
    const timeout = setTimeout(() => setHighlight(undefined), 2400);
    return () => clearTimeout(timeout);
  }, [highlight]);
  function showTask(taskId: string) { setBoardOpen(true); setDetailsOpen(false); setDecisionsOpen(false); setHighlight(taskId); }
  function showDecision(key: string) { setHighlight(key); document.getElementById(`decision-${key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  /** A decided option becomes a task on the board, noting where it was decided. */
  async function decisionTask(d: Decision) {
    const winner = d.tally.optionIds[0], chosen = d.options.find(o => o.id === winner)?.label ?? '';
    const notes = `Decided in the room: ${d.question}\nOutcome: ${chosen} (${d.tally.tally[winner] ?? 0} of ${d.tally.voters} votes from people)`;
    // The question carries the meaning ("Yes" alone says nothing); the outcome follows it.
    const title = `${d.question.replace(/\s*\?\s*$/, '')} → ${chosen}`;
    await peers.current!.changeTask({ title: title.length > 120 ? `${title.slice(0, 119)}…` : title, notes: notes.slice(0, 2000) });
    setBoardOpen(true); setDecisionsOpen(false); setDetailsOpen(false);
  }
  function showMessage(id: string) {
    setDetailsOpen(false); setHighlight(id);
    requestAnimationFrame(() => document.getElementById(`message-${id}`)?.scrollIntoView({ block: 'center' }));
  }
  /** An agent's activity as the freshest report from any of its devices this browser is connected to. */
  const activityOf = (member: BrowserMember): AgentActivity => {
    const devices = status?.devices?.filter(d => d.memberId === member.id && connected.includes(d.id)) || [];
    return deriveActivity(devices.map(d => activity[d.id]), devices.length > 0, now);
  };
  const activities = new Map(agents.map(agent => [agent.id, activityOf(agent)]));
  const working = [...activities.values()].filter(a => a.state === 'working').length;
  /** Agents reachable right now for the strip under the header, busiest first; the rest are only counted. */
  const STRIP_ORDER = { working: 0, idle: 1, online: 2, offline: 3 } as const;
  const present = agents.filter(agent => activities.get(agent.id)!.state !== 'offline')
    .sort((a, b) => STRIP_ORDER[activities.get(a.id)!.state] - STRIP_ORDER[activities.get(b.id)!.state]);
  /** Task id → names of agents working on it right now, for markers on the board. */
  const workingOn: Record<string, string[]> = {};
  for (const agent of agents) {
    const a = activities.get(agent.id);
    if (a?.state === 'working' && a.quiet === undefined) for (const id of a.on.tasks || []) (workingOn[id] ||= []).push(agent.name);
  }
  /** "Working on “Fix header” · 4 min", "Replying to Igor · 1 min", "Idle · 12 min", with links to the task or message. */
  function activityLine(a: AgentActivity) {
    if (a.state === 'offline' || a.state === 'online') return <span className={`agent-activity is-${a.state}`}>{a.state === 'offline' ? 'Offline' : 'Online'}</span>;
    const age = <span className="agent-activity-age"> · {duration(now - a.since)}</span>;
    if (a.state === 'idle') return <span className="agent-activity is-idle">Idle{a.quiet === undefined ? age : <span className="agent-activity-quiet"> · no check-in for {duration(a.quiet)}</span>}</span>;
    if (a.quiet !== undefined) return <span className="agent-activity is-working is-quiet">Busy<span className="agent-activity-quiet"> · no check-in for {duration(a.quiet)}</span></span>;
    const task = a.on.tasks?.map(id => tasks.find(t => t.id === id)).find(Boolean);
    if (task) return <span className="agent-activity is-working">Working on <button className="agent-activity-link" title="Show on the task board" onClick={() => showTask(task.id)}>“{task.title}”</button>{age}</span>;
    const woke = (a.on.messages || []).map(id => messages.find(m => m.packet.body.id === id)?.packet.body).filter(b => !!b);
    if (!woke.length) return <span className="agent-activity is-working">Working{age}</span>;
    const authors = [...new Set(woke.map(b => b.memberId === status?.memberId ? 'you' : nameOf(b.memberId)))];
    const latest = woke.at(-1)!;
    return <span className="agent-activity is-working">Replying to <button className="agent-activity-link" title="Show the message" onClick={() => showMessage(latest.id)}>{authors.length > 1 ? `${authors.slice(0, -1).join(', ')} and ${authors.at(-1)}` : authors[0]}</button>{age}</span>;
  }
  function closeDetails() { setDetailsOpen(false); detailsButton.current?.focus(); }
  function openDetails() { setDetailsOpen(true); setBoardOpen(false); setDecisionsOpen(false); }

  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void act(async () => {
      // Persist the destination before submitting so a lost response can resume it.
      const previous = await source.readPref<{ id: string; name: string; title: string }>('pending-create');
      const operation = previous?.name === name && previous.title === title ? previous : { id: crypto.randomUUID(), name, title };
      await source.writePref('pending-create', operation); await source.writePref('display-name', name);
      // The invite code is sent, never stored in this browser.
      const invite = inviteCode.trim();
      try { await source.command('create', operation.id, { name, title, label: deviceLabel, ...(invite ? { invite } : {}) }); }
      catch (e) {
        const recovered = await source.command('status', operation.id, { session: crypto.randomUUID() }).catch(() => null);
        if (!recovered?.memberId) {
          if ((INVITE_ERRORS as readonly string[]).includes((e as ApiError).code ?? '')) setInviteRequired(true);
          throw e;
        }
      }
      await source.writePref('pending-create', null);
      location.assign(`/r/${operation.id}`);
    });
  }
  /** Pairing with the desktop app links the app's request in a room by the browser's secret (DesktopPairing). */
  const pairRoom = (roomId: string, secret: string) => source.command('link', roomId, { pairing: secret });
  function request(kind: 'person' | 'companion') {
    void act(async () => {
      await source.command('request', urlRoom, { name: kind === 'person' ? name : 'Companion device', label: deviceLabel, kind });
      if (kind === 'person') await source.writePref('display-name', name);
      setNotice('Request sent.');
    });
  }
  /** The host deletes the room for everyone; members' rooms say it was closed on their next poll. */
  function deleteRoom() {
    void act(async () => {
      await source.command('close', urlRoom);
      setConfirming(undefined); setDetailsOpen(false);
      setClosed('You deleted this room. Its link no longer works.'); setStatus(undefined);
      peers.current?.stop(); setRecent(await source.forget(urlRoom));
    });
  }
  /** The room's own origin: the local page runs on this computer, but the room lives on its room service. */
  const roomOrigin = source.roomOrigin(urlRoom);
  const invite = `${roomOrigin}/r/${urlRoom}`;
  async function copyInvite() {
    try { await navigator.clipboard.writeText(invite); setNotice('Room link copied.'); }
    catch { setDetailsOpen(true); setNotice('Copy the room link from Room details.'); }
  }
  const readyFiles = chosen.filter(f => f.status === 'ready');
  // More than MAX_MESSAGE_FILES only after a failed send brought its files back: the person removes some before sending.
  const canSend = !busy && chosen.length <= MAX_MESSAGE_FILES && chosen.every(f => f.status === 'ready') && (!!text.trim() || readyFiles.length > 0);
  function send(event: FormEvent) {
    event.preventDefault(); if (!canSend) return;
    const draft = text, replyTo = reply ? replyId : undefined, sending = readyFiles;
    // Clear at once, so whatever is typed while this sends is a new draft; a failed send puts its text back in front.
    setText(''); setReplyId(undefined); setChosen(current => current.filter(f => !sending.includes(f)));
    void act(async () => {
      try {
        if (!peers.current) throw new Error('Room connection is not ready.');
        await peers.current.send(draft, replyTo, sending.map(f => ({ ref: f.ref!, bytes: f.bytes! })));
      } catch (e) {
        setText(current => !draft ? current : current.trim() ? `${draft}\n${current}` : draft);
        setReplyId(current => current ?? replyTo);
        setChosen(current => [...sending, ...current]); // Files added while it was sending are kept too.
        throw e;
      }
      sending.forEach(f => f.preview && URL.revokeObjectURL(f.preview));
    });
  }
  /** Files are read and hashed as soon as they are chosen; nothing leaves this browser until the message is sent. */
  function addFiles(list: FileList | File[] | null | undefined) {
    const picked = [...(list || [])]; if (!picked.length) return;
    const accepted = picked.filter(f => f.size > 0 && f.size <= MAX_UPLOAD_BYTES).slice(0, Math.max(0, MAX_MESSAGE_FILES - chosen.length));
    if (accepted.length < picked.length) setError(`Attach up to ${MAX_MESSAGE_FILES} files of ${formatBytes(MAX_UPLOAD_BYTES)} or less per message.`);
    const items: ChosenFile[] = accepted.map(file => ({ key: crypto.randomUUID(), file, name: uploadName(file), status: 'uploading',
      preview: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined }));
    setChosen(current => [...current, ...items]);
    items.forEach(prepareFile);
  }
  function prepareFile(item: ChosenFile) {
    const patch = (change: Partial<ChosenFile>) => setChosen(current => current.map(f => f.key === item.key ? { ...f, ...change } : f));
    patch({ status: 'uploading', error: undefined });
    item.file.arrayBuffer().then(async buffer => { const bytes = new Uint8Array(buffer); patch({ status: 'ready', bytes, ref: await attachmentRef(bytes, item.name) }); })
      .catch(e => patch({ status: 'failed', error: e instanceof Error ? e.message : 'Could not read this file.' }));
  }
  function removeFile(key: string) {
    setChosen(current => { const item = current.find(f => f.key === key); if (item?.preview) URL.revokeObjectURL(item.preview); return current.filter(f => f.key !== key); });
  }
  /** Where a message's file is in this browser: a blob URL once verified and stored, or what is happening to it. */
  const fileSource: AttachmentSource = attachment => {
    const sha = (attachment as Attachment & { sha256: string }).sha256, view = files[sha];
    if (view?.url) return { url: view.url };
    const transfer = view?.transfer;
    if (transfer?.state === 'fetching') return { note: `Receiving · ${Math.floor(transfer.received * 100 / transfer.size)}%` };
    if (transfer?.state === 'damaged') return { note: 'A copy failed verification. Trying other devices.' };
    if (peers.current?.evicted(sha)) return { note: 'Not kept in this browser: newer files filled this room’s storage' };
    return { note: connected.length ? 'Waiting for a device that has this file' : 'Available when a device that has it connects' };
  };
  const attachmentsOf = (body: SavedMessage['packet']['body']): Attachment[] => (body.attachments || []).map(ref => ({ ...ref,
    kind: files[ref.sha256]?.url ? displayKind(ref, files[ref.sha256].type) : IMAGE_TYPES.includes(ref.type) ? 'image' : 'file' }));
  function startReply(id: string) { setReplyId(id); requestAnimationFrame(() => composer.current?.focus()); }
  function connectAgent(event: FormEvent) {
    event.preventDefault(); const name = agentName.trim();
    void act(async () => {
      // The token is shown once; the room service keeps only its hash.
      const { token } = await source.command('agent-invite', urlRoom, { name }) as unknown as { token: string };
      setAgentLink({ name, url: `${roomOrigin}/agent/${urlRoom}#${token}` }); setAgentName('');
      // A name that says which harness it is picks that harness; the person can still change it.
      if (/codex/i.test(name)) setPromptHarness('codex'); else if (/claude/i.test(name)) setPromptHarness('claude');
    });
  }
  const promptText = agentLink ? agentPrompt({ origin: roomOrigin, roomId: urlRoom, link: agentLink.url, name: agentLink.name, version: agentVersion, harness: promptHarness }) : '';
  async function copyAgentLink(what: 'prompt' | 'link') {
    if (!agentLink) return;
    try {
      await navigator.clipboard.writeText(what === 'prompt' ? promptText : agentLink.url);
      setNotice(what === 'prompt' ? 'Copied. Paste it to your agent.' : 'Agent link copied. Give it to your agent.');
    } catch { setNotice(what === 'prompt' ? 'Select the text for your agent and copy it.' : 'Select the agent link and copy it.'); }
  }
  function openAgentConnect() {
    setDetailsOpen(true); setBoardOpen(false); setDecisionsOpen(false);
    requestAnimationFrame(() => {
      // The local page: an agent of the person's not in this room yet goes first; else the new agent form opens.
      const add = document.querySelector<HTMLButtonElement>('.browser-local-agent-add:not(:disabled)');
      if (add) { add.focus(); return; }
      const form = document.getElementById('browser-new-agent') as HTMLDetailsElement | null;
      if (form) form.open = true;
      document.getElementById('browser-agent-name')?.focus();
    });
  }
  function dismissAgentCta() { setAgentCtaDismissed(true); void source.writePref(`agent-cta-dismissed:${urlRoom}`, true).catch(() => { /* Shown again next visit. */ }); }
  /** Removes every device of a member; this device goes last so leaving still reports its result. Their agents leave with them. */
  function removeMember(member: BrowserMember) {
    void act(async () => {
      const devices = (status?.devices?.filter(d => d.memberId === member.id) || []).sort((a, b) => Number(a.id === status?.deviceId) - Number(b.id === status?.deviceId));
      for (const device of devices) await source.command('remove', urlRoom, { deviceId: device.id });
      setConfirming(undefined);
      setNotice(member.id === status?.memberId ? 'You left this room.' : `${member.name} was removed from the room.`);
    });
  }
  /** The shared TaskBoard offers "local" participants as assignees; in a browser room every member can be assigned. */
  const boardRoom = { id: urlRoom, title, project: '', sample: false, messages: [], tasks,
    participants: participants.map(p => ({ ...p, state: 'local' as const })) } as unknown as RoomSnapshot;
  async function boardAction(work: (engine: RoomSession) => Promise<void>) {
    setError('');
    try { if (!peers.current) throw new Error('Room connection is not ready.'); await work(peers.current); }
    catch (e) { setError((e as Error).message); throw e; }
  }
  const boardActions = {
    create: (draft: TaskDraft & { title: string }) => boardAction(engine => engine.changeTask({ title: draft.title, notes: draft.notes, assigneeId: draft.assigneeId ?? null, ...(draft.issue ? { issue: draft.issue } : {}) })),
    update: (task: Task, changes: TaskDraft) => boardAction(engine => engine.changeTask(changes, task)),
    remove: (task: Task) => boardAction(engine => engine.changeTask({}, task, true)),
  };
  const openTasks = tasks.filter(t => t.status !== 'done').length;
  const settings = status?.settings ?? DEFAULT_ROOM_SETTINGS;
  function changeSettings(change: Partial<RoomSettings>, done: string) {
    void act(async () => {
      await source.command('settings', urlRoom, change);
      // Show the accepted change now rather than at the next status poll, so the control doesn't flick back.
      setStatus(current => current && { ...current, settings: { ...(current.settings ?? DEFAULT_ROOM_SETTINGS), ...change } });
      setNotice(done);
    });
  }
  const pinned = status?.repositories ?? [];
  // Only while the details are open: scanning the conversation on every render would slow typing. Messages are
  // stored as they arrived from peers, so order them by when they were sent for newest-first suggestions.
  const mentioned = detailsOpen ? mentionedRepositories([...messages].sort((a, b) => a.packet.body.at - b.packet.body.at).map(m => m.packet.body.text)).filter(r => !pinned.some(p => p.toLowerCase() === r.toLowerCase())) : [];
  function pinRepository(change: { pin: string } | { unpin: string }) {
    void act(async () => {
      await source.command('repositories', urlRoom, change);
      const name = 'pin' in change ? change.pin : change.unpin, same = (r: string) => r.toLowerCase() === name.toLowerCase();
      // As the service does: pinning one already pinned, in any case, leaves the list as it is.
      setStatus(current => { if (!current) return current; const list = current.repositories ?? [];
        return { ...current, repositories: 'pin' in change ? (list.some(same) ? list : [...list, name]) : list.filter(r => !same(r)) }; });
      setRepositoryDraft('');
      setNotice('pin' in change ? `Pinned ${name}. Tasks can open issues there.` : `Unpinned ${name}.`);
    });
  }
  function pickAvatar(memberId: string) { setAvatarFor(memberId); avatarInput.current?.click(); }
  function uploadAvatar(file: File | undefined) {
    const target = avatarFor; if (!file || !target) return;
    void act(async () => {
      const avatar = await avatarData(file);
      await source.command('profile', urlRoom, target === status?.memberId ? { avatar } : { avatar, memberId: target });
      setNotice('Picture updated.');
    });
  }
  function clearAvatar(memberId: string) {
    void act(async () => { await source.command('profile', urlRoom, memberId === status?.memberId ? { avatar: null } : { avatar: null, memberId }); setNotice('Picture removed.'); });
  }
  const agentsOf = (member: BrowserMember) => status?.members?.filter(m => isAgent(m) && m.operatorId === member.id).length || 0;
  /** Inline confirmation for removing a person or leaving, naming the agents that go with them. */
  function confirmRemove(member: BrowserMember) {
    const leaving = member.id === status?.memberId, count = agentsOf(member);
    const agentsText = `${count} agent${count === 1 ? '' : 's'}`;
    return <div className="browser-confirm" role="group" aria-label={leaving ? 'Confirm leaving the room' : `Confirm removing ${member.name}`}>
      <p>{leaving ? `Leave this room on all your devices${count ? ` and remove your ${agentsText}` : ''}?` : `Remove ${member.name}${count ? ` and their ${agentsText}` : ''} from this room?`}</p>
      <div><button className="secondary" disabled={busy} onClick={() => removeMember(member)}>{leaving ? 'Leave room' : 'Remove'}</button><button className="browser-text-link" onClick={() => setConfirming(undefined)}>Cancel</button></div>
    </div>;
  }

  /** This browser paired with the desktop app (DesktopPairing): the room page offers to open rooms there. */
  const appPaired = !source.isLocal && pairedHere();
  return <div className={`browser-rooms ${admitted ? 'browser-joined' : ''} ${admitted && railCollapsed ? 'browser-rail-collapsed' : ''}`}>
    <a className="skip-link" href="#browser-main">Skip to room</a>
    <aside className="browser-rail">
      <div className="browser-rail-top"><a className="browser-brand" href="/rooms" aria-label="Meshrooms rooms"><Wordmark demo={false} /></a>
        {admitted && <button className="browser-rail-toggle" aria-controls="browser-room-nav" aria-expanded={!railCollapsed} title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setRailCollapsed(!railCollapsed)}><RoomIcon kind={railCollapsed ? 'expand' : 'collapse'} /><span className="sr-only">{railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span></button>}</div>
      {admitted ? <>
        <nav id="browser-room-nav" className="browser-room-nav" aria-label="Your rooms"><h2>Your rooms</h2>
          {[{ id: urlRoom, title }, ...recent.filter(r => r.id !== urlRoom)].map(r => {
            // The open room shows no badge: it is being read here.
            const count = r.id === urlRoom ? undefined : counts[r.id], label = roomLabel(count);
            return <a key={r.id} href={`/r/${r.id}`} className={count?.unread ? 'has-unread' : undefined} title={railCollapsed ? label ? `${r.title} · ${label}` : r.title : undefined} aria-current={r.id === urlRoom ? 'page' : undefined}>
              <RoomIcon kind="chat" /><span>{r.title}</span><RoomBadges count={count} /></a>;
          })}
          <a href="/rooms" className="browser-all-rooms" title={railCollapsed ? 'Create a room' : undefined}><RoomIcon kind="plus" /><span>Create a room</span></a>
        </nav>
        <a href="/rooms" className="browser-mobile-rooms">Your rooms<RoomBadges count={{ unread: otherUnread, mentions: others.reduce((sum, r) => sum + (counts[r.id]?.mentions || 0), 0), waiting: otherWaiting }} /></a>
        <div className="browser-self"><MemberAvatar member={self} roomId={urlRoom} fallback={self?.name || ''} /><div><strong>{self?.name}</strong><span>{host ? 'Room host' : 'Room member'}</span></div></div>
      </> : <p className="browser-rail-intro">A shared room for your people and their agents.</p>}
      <p className="browser-rail-footer">Meshrooms by WormDB<br />{source.label}</p>
    </aside>
    <main id="browser-main" className={`browser-main ${detailsOpen ? 'browser-details-open' : ''} ${boardOpen ? 'browser-board-open' : ''}`} tabIndex={-1}>
      {error && <div role="alert" className="browser-error">{error} <button onClick={() => { setError(''); if (!status) setRetry(v => v + 1); }}>{status ? 'Dismiss' : 'Retry'}</button></div>}
      {storageProblem && <p role="alert" className="browser-error">{storageProblem}</p>}
      {network && <p role="status" className="browser-error">{network}</p>}
      {notice && <p role="status" className="browser-notice">{notice}</p>}
      {alertShown && alertRoom && <div role="status" className="browser-notice browser-join-notice"><span>{joinNotice(alertShown.request, alertRoom)}</span>
        {alertsMore > 0 && <span className="browser-join-more">{alertsMore} more waiting</span>}
        <a href={`/r/${alertShown.roomId}`}>Open room</a><button className="browser-text-link" onClick={() => setJoinAlerts(queue => queue.filter(a => a !== alertShown))}>Dismiss</button></div>}
      {lostRoom && <div role="alert" className="browser-error">This room is open in another tab. Reload to use it here. <button onClick={() => location.reload()}>Reload</button></div>}
      {closed ? <section className="browser-entry"><h1>{title || 'Room closed'}</h1><h2>This room is closed</h2><p>{closed}</p>
          <p>Nobody can join, send messages or connect agents here any more.</p>
          <div className="browser-entry-actions"><a className="browser-text-link" href="/rooms">Start or open another room</a></div></section>
      : !ready ? <section className="browser-entry" aria-busy="true"><h1>Opening your room…</h1><p>{source.isLocal ? 'Reading your rooms from this computer.' : 'Restoring this browser’s identity.'}</p></section> : !urlRoom ?
        <section className="browser-entry"><h1>Start a room</h1><p>Share a link. Approve who joins. Start talking.</p>
          <form onSubmit={create} className="browser-form"><label>Your name<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></label>
            <label>Room name<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={80} placeholder="Project room" /></label>
            {inviteRequired && <label>Invite code<input value={inviteCode} onChange={e => setInviteCode(e.target.value)} required maxLength={32} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX" /></label>}
            <button className="primary" disabled={busy}>{busy ? 'Creating room…' : 'Create room'}</button></form>
          {source.isLocal && roomService && roomService !== PUBLIC_ROOM_SERVICE && <p className="browser-entry-note browser-room-service">This room will be made on <strong>{roomService}</strong>, not the public Meshrooms service.</p>}
          {inviteRequired && <p className="browser-entry-note">Meshrooms is invite-only during the beta: creating a room needs an invite code. Joining a room from its link doesn’t.</p>}
          {recent.length > 0 && <section className="browser-recent"><h2>Your rooms</h2>{recent.map(r => <a key={r.id} href={`/r/${r.id}`}>{r.title}<RoomBadges count={counts[r.id]} /></a>)}</section>}
          {!source.isLocal && recent.length > 0 && <section className="browser-desktop-app" id="desktop-app" ref={section => { if (section && location.hash === '#desktop-app') { history.replaceState(null, '', location.pathname); section.scrollIntoView({ block: 'start' }); } }}><h2>Desktop app</h2><DesktopPairing rooms={recent} name={name} device={deviceId} link={pairRoom} /></section>}
        </section> : !admitted ?
        <section className="browser-entry"><h1>{title || 'Join room'}</h1>
          {pending ? <>
            <h2>{status.request!.kind === 'companion' && !status.request!.linkedMemberId ? 'Confirm on your other device' : status.hostOnline ? 'Waiting for approval' : 'Waiting for the host to return'}</h2>
            {status.request!.kind === 'companion' && !status.request!.linkedMemberId ? <><p>In this room on your trusted device, open <strong>Room details</strong>, then <strong>Add another device</strong>, and enter this code.</p><code className="browser-link-code">{status.request!.code}</code><p>This request expires in ten minutes.</p></> : <p>You’ll enter the conversation when the host admits you.</p>}
            <div className="browser-entry-actions"><button className="secondary" disabled={busy} onClick={() => void act(async () => { await source.command('cancel', urlRoom, { requestId: status.request!.id }); setNotice('Join request canceled.'); })}>Cancel request</button>
              <a className="browser-text-link" href="/rooms">Back to your rooms</a></div>
          </> : <>
            <p>{status?.request?.state === 'expired' ? 'Your request expired. Ask to join again when you’re ready.' : everJoined.current ? 'This device no longer has access. Ask the host to admit it again.' : status?.request?.state === 'declined' ? 'The host declined your request.' : 'The host will approve your request before you enter.'}</p>
            <form className="browser-form" onSubmit={e => { e.preventDefault(); request('person'); }}><label>Your name<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></label>
              <button className="primary" disabled={busy || !status}>{busy ? 'Sending request…' : 'Ask to join'}</button></form>
            <button className="browser-text-link" disabled={busy || !status} onClick={() => request('companion')}>Use my existing identity</button>
            <p className="browser-entry-note">No installation or agent needed. This browser remembers your identity.</p>
            {!source.isLocal && (appPaired
              ? <div className="browser-entry-actions browser-open-app"><a className="secondary" href={joinLink(location.origin, urlRoom)}>Open in Meshrooms</a>
                <span className="browser-entry-note">Join from the desktop app on this computer instead. It asks before it joins.</span></div>
              : <p className="browser-entry-note browser-app-hint">Have the desktop app? {recent.length
                ? <><a href="/rooms#desktop-app">Use the desktop app</a> to pair it with this browser first.</>
                : <>Join here first, then pair it from <strong>Room details</strong>, <strong>Use the desktop app</strong>.</>}</p>)}
          </>}
        </section> : <>
          <header className="browser-room-header">
            <div className="browser-room-heading"><h1>{title}</h1><p>{people} {people === 1 ? 'person' : 'people'}{agents.length ? ` and ${agents.length} agent${agents.length === 1 ? '' : 's'}` : ''} in this room{working ? ` · ${working} working` : ''}</p></div>
            <div className="browser-room-actions"><button className="secondary" aria-expanded={decisionsOpen} aria-controls="browser-decisions" onClick={() => { setDecisionsOpen(!decisionsOpen); setBoardOpen(false); setDetailsOpen(false); }}><RoomIcon kind="vote" />Decisions{openDecisions ? <span className="browser-count">{openDecisions}</span> : null}</button><button className="secondary" aria-expanded={boardOpen} aria-controls="task-board" onClick={() => { setBoardOpen(!boardOpen); setDetailsOpen(false); setDecisionsOpen(false); }}><RoomIcon kind="tasks" />Tasks{openTasks ? <span className="browser-count">{openTasks}</span> : null}</button><button className="secondary" ref={detailsButton} aria-expanded={detailsOpen} aria-controls="browser-room-details" onClick={() => { if (detailsOpen) closeDetails(); else openDetails(); }}><RoomIcon kind="people" />Room details</button>{!source.isLocal && (appPaired
              ? <a className="secondary browser-open-app" href={joinLink(location.origin, urlRoom)}>Open in Meshrooms</a>
              : <button className="browser-text-link browser-app-hint" onClick={() => { openDetails(); requestAnimationFrame(() => { const pair = desktopPairing.current; if (!pair) return; pair.open = true; pair.scrollIntoView({ block: 'nearest' }); }); }}>Have the desktop app?</button>)}<button className="primary" onClick={() => void copyInvite()}><RoomIcon kind="link" />Copy room link</button></div>
          </header>
          {admitted && agents.length > 0 && <section className="browser-agent-strip" aria-label="Agents in this room">
            {present.map(agent => {
              const a = activities.get(agent.id)!, wakes = wakeOf(agent);
              return <div className={`browser-agent-chip is-${a.state}`} key={agent.id} title={`${agent.name} · ${runtimeOf(agent) || 'agent'} · operated by ${operatorOf(agent)}${wakes ? ` · ${wakeLabel(wakes.room.binding)}` : ''}`}>
                <span className="browser-person-avatar"><MemberAvatar member={agent} roomId={urlRoom} fallback={agent.name} /><span className={`agent-dot is-${a.state}${a.state !== 'offline' && a.state !== 'online' && a.quiet !== undefined ? ' is-quiet' : ''}`} aria-hidden="true" /></span>
                <span className="browser-agent-chip-text"><strong>{agent.name}</strong>{activityLine(a)}</span></div>;
            })}
            {agents.length > present.length && <button className="browser-text-link browser-agent-strip-more" onClick={openDetails}>{present.length ? `${agents.length - present.length} offline` : `${agents.length} agent${agents.length === 1 ? '' : 's'} offline`}</button>}
          </section>}
          {status.expiresAt !== undefined && status.expiresAt - Date.now() < EXPIRY_WARNING && <p role="status" className="browser-notice">This room will be removed on {new Date(status.expiresAt).toLocaleDateString(undefined, { dateStyle: 'long' })} if nobody opens it.</p>}
          {admitted && self && !isAgent(self) && !agentCtaDismissed && !agentLink && !status.agentInvites?.length && !status.members?.some(m => isAgent(m) && m.operatorId === self.id) &&
            <section className="browser-agent-cta" aria-label="Connect an agent"><div><strong>Bring your agent into this room</strong><p>Connect Claude Code, Codex or another agent. It joins as your agent, answers when someone addresses it, and you decide what it does.</p></div>
              <div className="browser-agent-cta-actions"><button className="primary" onClick={openAgentConnect}>Connect an agent</button><button className="browser-text-link" onClick={dismissAgentCta}>Not now</button></div></section>}
          <p className="sr-only" role="status">{host && status.requests?.length ? `${status.requests.length} request${status.requests.length === 1 ? '' : 's'} waiting to join. Use the join requests section to admit or decline.` : ''}</p>
          {host && !!status.requests?.length && <section className="browser-requests" aria-label="Join requests"><h2>Waiting to join <span>{status.requests.length}</span></h2>
            {status.requests.map(r => <div className="browser-request" key={r.id}><div><strong>{r.linkedMemberId ? status.members!.find(m => m.id === r.linkedMemberId)?.name : r.name}</strong><span>{r.kind === 'person' ? 'New person' : r.kind === 'agent' ? `Agent · operated by ${status.members!.find(m => m.id === r.operatorId)?.name || 'a former member'}` : r.linkedMemberId ? 'Confirmed companion device' : 'Waiting for identity confirmation'} · {r.device.label}</span></div>
              <div className="browser-request-actions"><button disabled={busy} onClick={() => void act(async () => { await source.command('decide', urlRoom, { requestId: r.id, admit: false }); })}>Decline</button>
                {(r.kind !== 'companion' || r.linkedMemberId) && <button className="primary" disabled={busy} onClick={() => void act(async () => { await source.command('decide', urlRoom, { requestId: r.id, admit: true }); })}>Admit</button>}</div></div>)}
          </section>}
          <p className="sr-only" aria-live="polite" aria-atomic="true">{liveMessage && <span key={liveMessage.id}>{liveMessage.text}</span>}</p>
          <div ref={workspace} className="browser-workspace" style={{ '--board-width': `${boardWidth}px` } as CSSProperties}>
            <div className={`browser-conversation ${dragging ? 'dragging' : ''}`}
              onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
              onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
              onDrop={e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
              {dragging && <div className="drop-overlay" aria-hidden="true"><RoomIcon kind="clip" /><strong>Drop to attach</strong><span>Screenshots and files up to {formatBytes(MAX_UPLOAD_BYTES)}</span></div>}
              <section ref={stick.ref} className="browser-transcript" role="log" aria-live="off" aria-label="Conversation" tabIndex={0} onScroll={stick.onScroll}>
                <div className="browser-message-list">
                  {olderAvailable && <div className="browser-day"><button className="browser-text-link" disabled={busy} onClick={() => void act(async () => { setOlderAvailable(await peers.current!.loadOlder()); })}>Show earlier messages</button></div>}
                  {!messages.length && <div className="browser-empty"><RoomIcon kind="chat" /><h2>{status.members!.length > 1 ? 'Ready for your first message' : status.requests?.length ? 'Your conversation starts here' : 'Bring someone into the room'}</h2><p>{status.members!.length > 1 ? 'Send a message below to start the conversation.' : status.requests?.length ? 'Someone is waiting to join. Admit them above to get started.' : 'Share the room link with someone, or open it on another device.'}</p></div>}
                  {items.map((item, index) => {
                    const previous = items[index - 1], at = itemAt(item);
                    const day = (!index || !sameDay(itemAt(previous), at)) && <div className="browser-day"><span>{dayLabel(at)}</span></div>;
                    if (item.decision) {
                      const d = item.decision;
                      return <Fragment key={`decision-${d.key}`}>{day}<DecisionCard decision={d} viewerId={status.memberId} ownerId={status.ownerId} members={status.members!} participants={participants} now={now}
                        highlight={highlight === d.key} nameOf={id => id === status.memberId ? 'You' : nameOf(id)}
                        avatar={id => <MemberAvatar member={status.members!.find(m => m.id === id)} roomId={urlRoom} fallback={nameOf(id)} />}
                        onVote={(optionId, comment) => peers.current!.vote(d, optionId, comment)} onAddOption={label => peers.current!.reviseDecision(d, { addOption: label })}
                        onClose={() => peers.current!.reviseDecision(d, { close: true })} onWithdraw={() => peers.current!.reviseDecision(d, { withdraw: true })}
                        onTasks={() => void decisionTask(d)} /></Fragment>;
                    }
                    if (item.event) {
                      const event = item.event, line = describeTask(event, (id, subject) => id === status.memberId ? subject ? 'You' : 'you' : nameOf(id));
                      const time = <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>;
                      return <Fragment key={event.id}>{day}<p className="browser-task-line">
                        {tasks.some(t => t.id === event.taskId) ? <button title="Show on the task board" onClick={() => showTask(event.taskId)}>{line}</button> : <span>{line}</span>}{time}</p></Fragment>;
                    }
                    const m = item.message, body = m.packet.body;
                    const member = status.members!.find(p => p.id === body.memberId);
                    const author = member?.name || 'Former member';
                    const target = body.replyTo ? messages.find(t => t.packet.body.id === body.replyTo)?.packet.body : undefined;
                    const continuation = grouped(previous?.message, m);
                    const next = items[index + 1]?.message;
                    const own = body.deviceId === status.deviceId;
                    const showReceipt = own && (!next || !grouped(m, next) || m.receipts.length < m.targets.length);
                    const forYou = body.memberId !== status.memberId && (mentionedIds(body.text, participants).includes(status.memberId!) || target?.memberId === status.memberId);
                    const operator = operatorOf(member);
                    const shown = shownText(body), quoted = target && (shownText(target) || fileNames(target));
                    const chips = reactions.filter(r => r.messageId === body.id);
                    const picking = reactPicker === body.id;
                    // Without reactions the control sits next to Reply (in the top corner for a grouped message, whose header is
                    // hidden), shown on hover or focus (always, quietly, on touch);
                    // with reactions it ends their row. Either way there is no row of its own for a lone button.
                    const addReaction = admitted && <div className={`browser-reaction-add ${chips.length ? '' : 'browser-reaction-add-header'}`}>
                      <button type="button" className="browser-reaction-picker-toggle" disabled={busy} aria-expanded={picking} aria-label={`Add a reaction to ${own ? 'your' : `${author}’s`} message`}
                        title="Add a reaction" onClick={() => setReactPicker(picking ? undefined : body.id)}><ReactionIcon /></button>
                      {picking && <div className="browser-reaction-picker" role="listbox" aria-label="Reaction emoji">
                        {REACTION_EMOJI.map(emoji => <button key={emoji} type="button" role="option" disabled={busy}
                          aria-label={emoji} onClick={() => void act(async () => {
                            if (!peers.current) throw new Error('Room connection is not ready.');
                            await peers.current.react(body.id, emoji as ReactionEmoji);
                            setReactPicker(undefined);
                          })}>{emoji}</button>)}
                      </div>}
                    </div>;
                    return <Fragment key={body.id}>
                      {day}
                      <article id={`message-${body.id}`} className={`browser-message ${highlight === body.id ? 'browser-message-highlight' : ''} ${continuation ? 'browser-message-continuation' : ''} ${forYou ? 'browser-message-for-you' : ''} ${isAgent(member) ? 'browser-message-agent' : ''}`}>
                        <MemberAvatar member={member} roomId={urlRoom} fallback={author} />
                        <div><header className={continuation ? 'browser-continuation-header' : ''}><strong>{author}</strong>{isAgent(member) && <span className="browser-role" title={runtimeOf(member) ? `${runtimeOf(member)} (reported by the agent)` : 'Agent'}>agent</span>}{operator && <span className="browser-operator">for {operator}</span>}{body.memberId === status.memberId && <span className="browser-author-you">you</span>}<time dateTime={new Date(body.at).toISOString()}>{new Date(body.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                          <button className="browser-reply-button" aria-label={`Reply to ${own ? 'your' : `${author}’s`} message`} title="Reply" onClick={() => startReply(body.id)}>Reply</button>{!chips.length && addReaction}</header>
                          {body.replyTo && <p className="browser-reply-reference">{target ? <>Replying to <strong>{nameOf(target.memberId)}</strong>: {quoted!.length > 120 ? `${quoted!.slice(0, 120)}…` : quoted}</> : 'Replying to an earlier message'}</p>}
                          {shown && <div className="message-text"><MentionText text={shown} participants={participants} viewerId={status.memberId} repositories={pinned} /></div>}
                          {body.attachments && <MessageAttachments roomId={urlRoom} attachments={attachmentsOf(body)} author={own ? 'You' : author} source={fileSource} />}
                          {chips.length > 0 && <div className="browser-reactions">
                            {chips.map(chip => {
                              const mine = memberReacted([chip], body.id, chip.emoji, status.memberId!);
                              const names = chip.memberIds.map(id => id === status.memberId ? 'you' : nameOf(id)).join(', ');
                              return <button key={chip.emoji} type="button" className={`browser-reaction ${mine ? 'is-mine' : ''}`} disabled={busy || !admitted}
                                title={names} aria-label={`${chip.emoji} ${chip.memberIds.length}${mine ? ', including you' : ''}. Activate to ${mine ? 'remove' : 'add'} your reaction.`}
                                onClick={() => void act(async () => { if (!peers.current) throw new Error('Room connection is not ready.'); await peers.current.react(body.id, chip.emoji); })}>
                                <span aria-hidden="true">{chip.emoji}</span><span>{chip.memberIds.length}</span>
                              </button>;
                            })}
                            {addReaction}
                          </div>}
                          {showReceipt && <span className="browser-receipt">{m.targets.length ? `Stored on ${m.receipts.length} of ${m.targets.length} devices` : 'Saved in this browser'}</span>}
                        </div>
                      </article>
                    </Fragment>;
                  })}
                </div>
              </section>
              <div className="browser-compose-area">
                {stick.unread > 0 && <button className="secondary browser-unread" onClick={stick.toBottom}>{stick.unread === 1 ? 'New message' : `${stick.unread} new messages`} <span aria-hidden="true">↓</span></button>}
                {deciding && <DecisionForm agents={agents.length} onCancel={() => setDeciding(false)}
                  onSubmit={async draft => { await peers.current!.openDecision(draft); setDeciding(false); stick.toBottom(); }} />}
                {reply && <div className="browser-reply-draft"><span>Replying to <strong>{reply.packet.body.memberId === status.memberId ? 'your message' : nameOf(reply.packet.body.memberId)}</strong></span><button className="browser-close" aria-label="Cancel reply" onClick={() => setReplyId(undefined)}><RoomIcon kind="close" /></button></div>}
                <form className="browser-composer" onSubmit={send}>{mentions.list}<label className="sr-only" htmlFor="browser-message">Message {title}</label><textarea ref={composer} id="browser-message" value={text} {...mentions.inputProps}
                  onChange={e => { setText(e.target.value); mentions.track(e.target.value, e.target.selectionStart); }} onSelect={e => mentions.track(e.currentTarget.value, e.currentTarget.selectionStart)} onBlur={mentions.close}
                  onPaste={e => { const pasted = [...e.clipboardData.files]; if (pasted.length) { e.preventDefault(); addFiles(pasted); } }}
                  onKeyDown={e => { if (mentions.onKeyDown(e)) return; if (e.key === 'Escape' && reply) { setReplyId(undefined); return; } if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); send(e); } }}
                  maxLength={4000} rows={2} placeholder={agents.length ? `Message ${title} · type @ to ask an agent` : `Message ${title}`} />
                  <PendingFiles files={chosen} onRemove={removeFile} onRetry={key => { const item = chosen.find(f => f.key === key); if (item) prepareFile(item); }} />
                  <div><span className="browser-compose-tools"><input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
                    <button type="button" className="secondary browser-attach" title="Attach screenshots or files (you can also paste or drop them)" onClick={() => fileInput.current?.click()}><RoomIcon kind="clip" /><span>Attach</span></button>
                    <button type="button" className="secondary browser-attach" aria-expanded={deciding} title="Ask the room to decide between options, or to review a plan" onClick={() => setDeciding(!deciding)}><RoomIcon kind="vote" /><span>Decide</span></button>
                    <span className="browser-key-hint">Enter to send · Shift + Enter for a new line</span></span><button className="primary" disabled={!canSend}><span>Send</span><RoomIcon kind="send" /></button></div></form>
                <p className="browser-connection" role="status"><span className={`browser-connection-dot ${connected.length ? 'is-connected' : ''}`} aria-hidden="true" />{connected.length ? `Connected to ${connected.length} other device${connected.length === 1 ? '' : 's'}` : status.devices!.length > 1 ? 'Waiting for another device to connect' : 'You’re the first one here'}</p>
              </div>
            </div>
            {boardOpen && <BoardHandle workspace={workspace} width={boardWidth} onCommit={width => { setBoardWidth(width ?? BOARD_DEFAULT); saveBoardWidth(width); }} />}
            {decisionsOpen && <DecisionList decisions={decisions} onShow={showDecision} onClose={() => setDecisionsOpen(false)} />}
            {boardOpen && <TaskBoard room={boardRoom} viewerId={status.memberId} disabled={!admitted} onClose={() => setBoardOpen(false)} actions={boardActions} highlight={highlight} working={workingOn} repositories={pinned} />}
            <aside id="browser-room-details" className="browser-details" aria-label="Room details" hidden={!detailsOpen} onKeyDown={e => { if (e.key === 'Escape') closeDetails(); }}>
              <header className="browser-details-heading"><h2 tabIndex={-1} ref={detailsHeading}>Room details</h2><button className="browser-close" aria-label="Close room details" onClick={closeDetails}><RoomIcon kind="close" /></button></header>
              <section aria-label="People and agents in this room" className="browser-people"><h3>{agents.length ? 'People and agents' : 'People'} <span>{status.members!.length}</span></h3>
                {status.members!.map(member => {
                  const devices = status.devices!.filter(d => d.memberId === member.id).length;
                  // The host may remove anyone but themselves; an operator may remove their own agents.
                  const removable = member.id !== status.memberId && (host ? member.id !== status.ownerId : isAgent(member) && member.operatorId === status.memberId);
                  const operatesIt = isAgent(member) && member.operatorId === status.memberId;
                  const a = activities.get(member.id), wakes = isAgent(member) ? wakeOf(member) : undefined;
                  return <div className="browser-person" key={member.id}><span className="browser-person-avatar"><MemberAvatar member={member} roomId={urlRoom} fallback={member.name} />{a && <span className={`agent-dot is-${a.state}${a.state !== 'offline' && a.state !== 'online' && a.quiet !== undefined ? ' is-quiet' : ''}`} aria-hidden="true" />}</span><div><strong>{member.name}{member.id === status.memberId ? ' (you)' : ''}</strong>
                    <span>{isAgent(member) ? `Agent · operated by ${operatorOf(member)}` : `${member.id === status.ownerId ? 'Host · ' : ''}${devices} device${devices === 1 ? '' : 's'}`}</span>
                    {isAgent(member) && <span className="agent-runtime" title="Reported by the agent">{runtimeOf(member) || 'Harness and model not reported'}</span>}
                    {a && activityLine(a)}
                    {a && a.state !== 'offline' && a.state !== 'online' && a.note && <span className="agent-activity-note">{a.note}</span>}
                    {wakes && <span className="agent-wakes">{wakeLabel(wakes.room.binding)}</span>}
                    {wakes && <button className="browser-text-link browser-picture-link" onClick={() => setAgentFocus({ id: wakes.agent.id, at: Date.now() })}>Sessions</button>}
                    {removable && (confirming === member.id ? confirmRemove(member) : <button className="browser-remove" disabled={busy} aria-label={`Remove ${member.name} from the room`} onClick={() => setConfirming(member.id)}>{isAgent(member) ? 'Remove agent' : 'Remove'}</button>)}
                    {operatesIt && <button className="browser-text-link browser-picture-link" disabled={busy} onClick={() => pickAvatar(member.id)}>{member.avatar ? 'Change picture' : 'Set picture'}</button>}
                    {member.avatar && member.id !== status.memberId && (operatesIt || host) && <button className="browser-remove" disabled={busy} onClick={() => clearAvatar(member.id)}>Remove picture</button>}</div></div>;
                })}
              </section>
              <section className="browser-picture" aria-label="Your picture"><h3>Your picture</h3>
                <input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden onChange={e => { uploadAvatar(e.target.files?.[0]); e.target.value = ''; }} />
                <div><MemberAvatar member={self} roomId={urlRoom} fallback={self?.name || ''} />
                  <button className="secondary" disabled={busy || !self} onClick={() => self && pickAvatar(self.id)}>{self?.avatar ? 'Change picture' : 'Choose picture'}</button>
                  {self?.avatar && <button className="browser-remove" disabled={busy} onClick={() => clearAvatar(self.id)}>Remove</button>}</div>
                <p>Cropped to a square and kept under 16 KB. Everyone in this room sees it.</p>
              </section>
              {!isAgent(self) && source.agents && <LocalAgentsSection api={source.agents} state={localAgents} roomId={urlRoom} selfName={self?.name} focus={agentFocus} />}
              {!isAgent(self) && !source.agents && <section className="browser-agents"><h3>Your agents</h3><p>You’re connecting as <strong>{self?.name}</strong>: you’ll be the operator of any agent you connect here, and only you and the host can remove it. Use your own browser, not one an agent is driving.</p>
                {agentLink && linkState !== 'open' ? <div className="browser-agent-link" role="status"><p>{linkState === 'joined' ? <>Used by <strong>{agentLink.name}</strong>, which joined the room.</>
                    : linkState === 'used' ? <>Used by <strong>{agentLink.name}</strong>, which is waiting for the host to let it in.</>
                    : <>The link for <strong>{agentLink.name}</strong> expired unused. Make a new one to connect it.</>}</p>
                  <div><button className="browser-text-link" onClick={() => setAgentLink(undefined)}>Done</button></div></div>
                : agentLink ? <div className="browser-agent-link"><p>Paste this to <strong>{agentLink.name}</strong>. It tells your agent what Meshrooms is and how to join. The link inside works once and expires in 15 minutes.</p>
                  <label className="browser-agent-harness">Your agent runs on<select value={promptHarness} onChange={e => setPromptHarness(e.target.value as PromptHarness)}>
                    {(Object.keys(PROMPT_HARNESSES) as PromptHarness[]).map(h => <option key={h} value={h}>{PROMPT_HARNESSES[h] || 'Something else'}</option>)}</select></label>
                  <label className="sr-only" htmlFor="browser-agent-prompt">What your agent will read</label><textarea id="browser-agent-prompt" className="browser-agent-prompt" readOnly rows={9} value={promptText} onFocus={e => e.target.select()} />
                  <div><button className="secondary" onClick={() => void copyAgentLink('prompt')}>Copy for your agent</button><button className="browser-text-link" onClick={() => void copyAgentLink('link')}>Copy link only</button><button className="browser-text-link" onClick={() => setAgentLink(undefined)}>Done</button></div></div>
                  : <form onSubmit={connectAgent}><label>Agent name<input id="browser-agent-name" value={agentName} onChange={e => setAgentName(e.target.value)} required maxLength={64} placeholder="Codex" autoComplete="off" /></label><button className="secondary" disabled={busy || !agentName.trim()}>Connect an agent</button></form>}
                {status.agentInvites?.map(i => <p className="browser-agent-waiting" key={i.name}>Waiting for <strong>{i.name}</strong> to connect · link expires at {new Date(i.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>)}
              </section>}
              <section className="browser-repositories" aria-labelledby="browser-repositories-title"><h3 id="browser-repositories-title">Repositories {pinned.length > 0 && <span>{pinned.length}</span>}</h3>
                <p>Pinned for this room, so tasks can open issues there. Meshrooms isn’t connected to GitHub: issues open on GitHub under your own account.</p>
                {pinned.length > 0 && <ul>{pinned.map(r => <li key={r}><a href={`https://github.com/${r}`} target="_blank" rel="noopener noreferrer">{r}</a>
                  {!isAgent(self) && <button className="browser-remove" disabled={busy} aria-label={`Unpin ${r}`} onClick={() => pinRepository({ unpin: r })}>Unpin</button>}</li>)}</ul>}
                {!isAgent(self) && pinned.length < MAX_REPOSITORIES && <>
                  {mentioned.length > 0 && <div className="browser-repo-suggestions" role="group" aria-label="Repositories mentioned in this room"><span>Mentioned here</span>
                    {mentioned.map(r => <button key={r} className="browser-chip" disabled={busy} onClick={() => pinRepository({ pin: r })}>Pin {r}</button>)}</div>}
                  <form className="browser-repo-add" onSubmit={e => { e.preventDefault(); const r = repositoryFrom(repositoryDraft); if (r) pinRepository({ pin: r }); }}>
                    <label className="sr-only" htmlFor="browser-repo-name">Repository to pin</label>
                    <input id="browser-repo-name" value={repositoryDraft} onChange={e => setRepositoryDraft(e.target.value)} placeholder="owner/name or a GitHub link" maxLength={300} autoComplete="off" />
                    <button className="secondary" disabled={busy || !repositoryFrom(repositoryDraft)}>Pin</button>
                  </form></>}
              </section>
              <section className="browser-settings" aria-label="Room settings"><h3>Room settings</h3>
                {host ? <>
                  <FloorControl floor={settings.floor} disabled={busy} onChange={floor => changeSettings({ floor }, floor === 'humans-first' ? 'Agents now reply only when addressed.' : 'Agents may now reply to every message from a person.')} />
                  <label className="browser-setting"><input type="checkbox" checked={settings.agentAssignmentsWake} disabled={busy} onChange={e => changeSettings({ agentAssignmentsWake: e.target.checked }, e.target.checked ? 'Agents can now hand tasks to each other.' : 'Only people’s assignments wake agents now.')} /><span><strong>Agents can hand tasks to each other</strong>A task one agent assigns to another wakes it, as a person’s assignment does.</span></label>
                  <label className="browser-setting"><input type="checkbox" checked={settings.guestAgentApproval} disabled={busy} onChange={e => changeSettings({ guestAgentApproval: e.target.checked }, e.target.checked ? 'Guests’ agents now wait for your approval.' : 'Guests’ agents now join right away.')} /><span><strong>Approve guests’ agents</strong>Agents connected by other people wait for you to admit them. Your own agents join right away.</span></label>
                  <label className="browser-setting"><input type="checkbox" checked={settings.hostApprovesDevices} disabled={busy} onChange={e => changeSettings({ hostApprovesDevices: e.target.checked }, e.target.checked ? 'New devices now wait for your approval.' : 'People now add their own devices.')} /><span><strong>Approve new devices</strong>A device someone links to themselves waits for you to admit it. Off: their own confirmation admits it.</span></label>
                </> : <ul className="browser-settings-summary">
                  <li>{settings.floor === 'humans-first' ? 'Agents reply only when addressed.' : 'Agents may reply to every message from a person; one that @mentions someone wakes only the agents it names.'}</li>
                  <li>{settings.agentAssignmentsWake ? 'Agents can hand tasks to each other.' : 'Only people’s assignments wake agents.'}</li>
                  <li>{settings.guestAgentApproval ? 'The host approves agents connected by guests.' : 'Agents join as soon as their link is used.'}</li>
                  <li>{settings.hostApprovesDevices ? 'The host approves each new device.' : 'People add their own devices.'}</li>
                </ul>}
              </section>
              <section className="browser-invite"><h3>Invite someone</h3><p>New people wait for the host’s approval.</p><label className="sr-only" htmlFor="browser-invite-link">Room invite link</label><input id="browser-invite-link" readOnly value={invite} onFocus={e => e.target.select()} /></section>
              <section className="browser-device-section"><h3>Your devices</h3><p>Join as yourself from another browser.</p>
                {host && status.devices!.filter(d => d.memberId === status.memberId).length === 1 && <p className="browser-only-device">This browser holds your only key for this room. Add another device so you don’t lose hosting.{' '}
                  <button className="browser-text-link" onClick={() => { const add = linkDevice.current; if (!add) return; add.open = true; add.scrollIntoView({ block: 'nearest' }); add.querySelector('input')?.focus(); }}>Link another device</button></p>}
                <details ref={linkDevice} className="browser-link-device"><summary>Add another device</summary><p>Open this room link on your other device and choose <strong>Use my existing identity</strong>. Enter its code here.</p>
                  <form onSubmit={e => { e.preventDefault(); void act(async () => { await source.command('link', urlRoom, { code: code.trim().toLowerCase() }); setCode(''); setNotice(host || !settings.hostApprovesDevices ? 'Your device is approved.' : 'Identity confirmed. The host can now admit your device.'); }); }}><label>Device code<input value={code} onChange={e => setCode(e.target.value)} required maxLength={16} autoComplete="off" spellCheck={false} /></label><button className="secondary" disabled={busy || code.trim().length !== 16}>Approve my device</button></form>
                </details>
                {!source.isLocal && <details ref={desktopPairing} className="browser-desktop-pairing"><summary>Use the desktop app</summary>
                  <DesktopPairing rooms={[{ id: urlRoom, title }, ...recent.filter(r => r.id !== urlRoom)]} name={self?.name || name} device={deviceId} link={pairRoom} />
                </details>}
                <details className="browser-device-details"><summary>Manage your devices</summary>
                  {status.devices!.filter(d => d.memberId === status.memberId).map(d => <div key={d.id}><strong>{d.label} · {d.id.slice(-6).toUpperCase()}</strong><span>{d.id === status.deviceId ? 'This device' : connected.includes(d.id) ? 'Connected' : 'Offline'}</span>{d.id !== status.deviceId && <button className="browser-remove" aria-label={`Remove ${d.label} ${d.id.slice(-6).toUpperCase()}`} disabled={busy} onClick={() => void act(async () => { await source.command('remove', urlRoom, { deviceId: d.id }); })}>Remove device</button>}</div>)}
                </details>
                {!host && self && (confirming === self.id ? confirmRemove(self) : <button className="browser-remove browser-leave" disabled={busy} onClick={() => setConfirming(self.id)}>Leave this room</button>)}
              </section>
              {host && <section className="browser-delete-room"><h3>Delete room</h3><p>Deletes this room for everyone: the link stops working and nobody can reconnect, agents included.</p>
                {confirming === 'delete-room' ? <div className="browser-confirm" role="group" aria-label="Confirm deleting the room">
                  <p>Delete “{title}” for everyone? This can’t be undone.</p>
                  <div><button className="secondary" disabled={busy} onClick={deleteRoom}>Delete room</button><button className="browser-text-link" onClick={() => setConfirming(undefined)}>Cancel</button></div>
                </div> : <button className="browser-remove browser-leave" disabled={busy} onClick={() => setConfirming('delete-room')}>Delete room</button>}
              </section>}
              <p className="browser-storage-note">Messages and files stay in participating browsers; each keeps the newest 256 MB of files per room. Device receipts confirm storage, not that someone has read a message.</p>
            </aside>
          </div>
        </>}
    </main>
  </div>;
}
