import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from 'react';
import { AGENT_CHAIN_LIMIT, AGENT_ROOM_LIMIT, chainRoot, loopGuard, mentionedIds, type Task, type TaskStatus } from '../collab';
import { FloorControl, MAX_MESSAGE_FILES, MAX_UPLOAD_BYTES, MentionText, MessageAttachments, PendingFiles, TaskBoard, formatBytes, uploadName, useAutoGrow, useMentions, useStickToBottom, type AttachmentSource, type PendingFile } from '../prototype/Collaboration';
import { Wordmark } from '../prototype/RoomPrototype';
import type { Attachment, Participant, RoomSnapshot, TaskDraft } from '../room';
import { deriveActivity, duration, type ActivityRecord, type AgentActivity } from './activity';
import { MAX_TIME, issueLabel, mentionedRepositories, repositoryFrom, taskTimeline, type TaskBody, type TaskEvent } from './board';
import type { ApiError } from './client';
import { AttentionStrip } from './AttentionStrip';
import { attentionAt, decisionMark, loadSeen, markSeen, messageMark, messagesForYou, taskMark } from './attention';
import { WorkPane } from './WorkPane';
import { resolveWork, taskFromDecision, workList, type WorkRef } from './work-pane';
import { DecisionCard, DecisionForm, DecisionList } from './DecisionViews';
import { roomDrafts } from './drafts';
import { DesktopPairing } from './DesktopPairing';
import { joinLink, pairedHere } from './desktop-join';
import { LocalAgentsSection, identityOfMember, useLocalAgents, wakeLabel } from './LocalAgents';
import { AgentApps } from './AgentApps';
import { RoomNotificationControls } from './RoomNotificationControls';
import { decisionTaskTitle, due, foldDecisions, type Decision, type DecisionBody, type VoteBody } from './decisions';
import { IMAGE_TYPES, attachmentRef, displayKind, shownText, type AttachmentRef } from './files';
import { analyzeHistory, canonicalMessageKeys, messageKey } from './history-sync';
import { BOARD_DEFAULT, BOARD_STEP, boardLimits, clampBoardWidth, saveBoardWidth, savedBoardWidth } from './panel';
import { roomViewOf, type FileView, type SavedMessage } from './peers';
import { REACTION_EMOJI, memberReacted, type ReactionChip, type ReactionEmoji } from './reactions';
import type { RetractBody } from './retractions';
import { AgentRename } from './AgentRename';
import { canRenameAgent, renameLine } from './rename-state';
import { InviteDialog, type InviteTab } from './InviteDialog';
import { PhoneInvalid, PhoneLanding } from './PhoneLanding';
import { PhoneCode } from './PhoneCode';
import { deviceLabel as labelFor, parsePhoneFragment, type PairCommander, type PhoneLink } from './phone-pairing';
import { onStorageProblem } from './storage';
import type { RecentRoom } from './background';
import { badgeText, countUnread, freshRequests, hostJoinNotifications, joinNotice, tabTitle, unreadLabel, waitingLabel, waitingOf, type ReadPosition, type UnreadCount, type Waiting } from './unread';
import { DEFAULT_ROOM_SETTINGS, INVITE_ERRORS, MAX_REPOSITORIES, PUBLIC_ROOM_SERVICES, ROOM_CLOSED, UPGRADE_REQUIRED, base64, cleanDisplayName, deviceFingerprint, type BrowserMember, type RenameNotice, type RoomSettings, type RoomStatus } from './protocol';
import { BrowserSource, type RoomSession, type RoomSource } from './source';
import { buildStreamEntries, collectSharedFiles, isHiddenInCollapsedStack, messagePreview, sortRoomMembers, transcriptItemAt, type DetailsTab, type ResponseStack, type TimelineZoom, type TranscriptItem } from './work-stream';
import './browser.css';

const closedError = (e: unknown) => (e as ApiError).status === 410 && (e as ApiError).code === ROOM_CLOSED;
const upgradeError = (e: unknown) => !!e && typeof e === 'object' && ((e as ApiError).status === 426 || (e as ApiError).code === UPGRADE_REQUIRED);
/** Rooms warn a week before idle expiry. */
const EXPIRY_WARNING = 7 * 86_400_000;
const deviceLabel = labelFor(navigator.userAgent, navigator.maxTouchPoints);
const urlRoom = location.pathname.match(/^\/r\/([a-f0-9-]{36})$/)?.[1] || '';
/**
 * A phone that scanned a "Connect your phone" code lands on /rooms#pair=…. The secret is read once and taken out of the
 * address bar at once, so a reload, a bookmark or a shared screenshot of the URL never carries it.
 */
function takePhoneLink(): PhoneLink | 'invalid' | undefined {
  if (urlRoom || !/^#pair=/.test(location.hash)) return undefined;
  const link = parsePhoneFragment(location.hash);
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* Kept in the bar; the page still works. */ }
  return link ?? 'invalid';
}
const incomingPhone = takePhoneLink();

/** A file chosen for the next message: read and hashed here, stored only when the message is sent. */
type ChosenFile = PendingFile & { ref?: AttachmentRef; bytes?: Uint8Array };
const fileNames = (body: SavedMessage['packet']['body']) => body.attachments?.map(a => a.name).join(', ') || '';

function RoomIcon({ kind }: { kind: 'people' | 'link' | 'close' | 'chat' | 'send' | 'tasks' | 'clip' | 'plus' | 'collapse' | 'expand' | 'vote' | 'back' | 'more' | 'invite' | 'phone' }) {
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
    back: <path d="m15 6-6 6 6 6" />,
    invite: <><circle cx="10" cy="8" r="4" /><path d="M3 20c0-4 3-6 7-6s7 2 7 6M19 8v6M16 11h6" /></>,
    phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
    more: <><circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

/** Follows the visual viewport so the room chrome stays above an on-screen keyboard. */
function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport; if (!vv) return;
    const root = document.documentElement;
    const sync = () => {
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vv-offset', `${Math.round(vv.offsetTop)}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vv-offset');
    };
  }, []);
}

/** Narrow pane is under 600px; compact chrome also covers phone viewports where the rail is a top bar. */
function usePaneFlags(element: RefObject<HTMLElement | null>, paneWidth = 600, viewWidth = 760) {
  const [flags, setFlags] = useState(() => {
    const compact = window.innerWidth <= viewWidth || window.innerWidth < paneWidth;
    return { narrowPane: window.innerWidth < paneWidth, compactChrome: compact };
  });
  useEffect(() => {
    const node = element.current; if (!node) return;
    const read = () => {
      const narrowPane = node.clientWidth < paneWidth;
      setFlags({ narrowPane, compactChrome: narrowPane || window.innerWidth <= viewWidth });
    };
    const observer = new ResizeObserver(read);
    observer.observe(node);
    addEventListener('resize', read);
    read();
    return () => { observer.disconnect(); removeEventListener('resize', read); };
  }, [element, paneWidth, viewWidth]);
  return flags;
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
/**
 * "Igor assigned “Fix header” to Wren and moved it to in progress". The title leads; later phrases say "it". `here`
 * describes the change from the task's own page, where the title is already shown: "Igor created this task".
 */
function describeTask(event: TaskEvent, name: (memberId: string, subject?: boolean) => string, here = false) {
  const title = here ? 'this task' : `“${event.title}”`, phrases: string[] = [], it = () => phrases.length ? 'it' : title;
  if (event.removed) return `${name(event.memberId, true)} removed ${title}`;
  if (event.created) phrases.push(`created ${title}`);
  if (event.updated) phrases.push(`updated ${title}`);
  if (event.renamedFrom !== undefined) phrases.push(here ? `renamed ${it()} to “${event.title}”` : `renamed “${event.renamedFrom}” to ${title}`);
  if (event.assigneeId !== undefined) phrases.push(event.assigneeId === null ? `unassigned ${it()}` : event.assigneeId === event.memberId ? `took ${it()}` : `assigned ${it()} to ${name(event.assigneeId)}`);
  if (event.status) phrases.push(`moved ${it()} ${statusMoves[event.status]}`);
  if (event.notes) phrases.push(`edited the notes on ${it()}`);
  // A task made from a pasted link is titled with it already.
  if (event.issue !== undefined && !(event.created && event.issue && issueLabel(event.issue) === event.title))
    phrases.push(event.issue === null ? `unlinked the issue from ${it()}` : `linked ${it()} to ${issueLabel(event.issue)}`);
  return `${name(event.memberId, true)} ${phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}` : phrases[0]}`;
}
type HistoryAnchor = { node: HTMLElement; offset: number; focus: boolean; messageId?: string };
const itemAt = transcriptItemAt;
/** Interleaves task lines, decisions and renames between messages by time while keeping message arrival order. */
function mergeTranscriptItems(
  messages: readonly SavedMessage[],
  timeline: readonly TaskEvent[],
  decisions: readonly Decision[],
  renames: readonly RenameNotice[],
): TranscriptItem[] {
  const inserts: TranscriptItem[] = [...timeline.map(event => ({ event })), ...decisions.map(decision => ({ decision })), ...renames.map(rename => ({ rename }))].sort((a, b) => itemAt(a) - itemAt(b));
  const merged: TranscriptItem[] = []; let next = 0;
  for (const message of messages) {
    while (next < inserts.length && itemAt(inserts[next]) <= message.packet.body.at) merged.push(inserts[next++]);
    merged.push({ message });
  }
  return [...merged, ...inserts.slice(next)];
}
/** A stable empty list, so memos keyed on a room's pinned repositories don't rerun while it has none. */
const NO_REPOSITORIES: string[] = [];
/** Where the side pane sits beside the conversation; below it (max-width:1150px in browser.css) it covers it. */
const PANE_BESIDE = '(min-width: 1151px)';
/** Which side panel was open when the person left a room: `details:<tab>`, `work`, `tasks`, `decisions`, or empty. */
const SIDE_PANEL_KEY = 'meshrooms:side-panel';
/**
 * The side panel to reopen in this room. Opening a room loads a new page, so without this every room started with its
 * panels closed. Only on screens wide enough to keep the conversation beside the panel: below that the panel replaces it.
 */
function savedSidePanel(): { panel?: 'details' | 'work' | 'tasks' | 'decisions'; tab?: DetailsTab } {
  try {
    if (!matchMedia(PANE_BESIDE).matches) return {};
    const [panel, tab] = (localStorage.getItem(SIDE_PANEL_KEY) || '').split(':');
    if (panel === 'tasks' || panel === 'decisions' || panel === 'work') return { panel };
    if (panel === 'details') return { panel, ...(DETAILS_TABS.some(t => t.id === tab) ? { tab: tab as DetailsTab } : {}) };
  } catch { /* storage or matchMedia unavailable */ }
  return {};
}
const DETAILS_TABS: { id: DetailsTab; label: string }[] = [
  { id: 'members', label: 'Members' },
  { id: 'shared', label: 'Shared' },
  { id: 'rules', label: 'Rules' },
  { id: 'you', label: 'You' },
];

export function BrowserRooms({ source: given }: { source?: RoomSource } = {}) {
  const [source] = useState<RoomSource>(() => given ?? new BrowserSource());
  return <Source.Provider value={source}>{source.isLocal && source.agents && location.pathname === '/agent-apps' ? <AgentApps api={source.agents} /> : <Rooms source={source} />}</Source.Provider>;
}
function Rooms({ source }: { source: RoomSource }) {
  const [status, setStatus] = useState<RoomStatus>();
  const [title, setTitle] = useState('');
  const [publicHistory, setPublicHistory] = useState(false);
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
  const [openingError, setOpeningError] = useState('');
  const [signInRequired, setSignInRequired] = useState(false);
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  /** Local saving is failing: shown until a save succeeds again, unlike network problems, which the next poll clears. */
  const [storageProblem, setStorageProblem] = useState<string>();
  useEffect(() => onStorageProblem(setStorageProblem), []);
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [restoredPanel] = useState(savedSidePanel);
  const [detailsOpen, setDetailsOpen] = useState(restoredPanel.panel === 'details' || restoredPanel.panel === 'work');
  const [detailsTab, setDetailsTab] = useState<DetailsTab>(restoredPanel.tab ?? 'members');
  /** The side pane shows this room's work ("This work") or the room itself (Room details). */
  const [paneTab, setPaneTab] = useState<'work' | 'room'>(restoredPanel.panel === 'work' ? 'work' : 'room');
  const [selectedWork, setSelectedWork] = useState<WorkRef>();
  /** What opened the pane onto a piece of work, so closing it returns focus there. */
  const workOpener = useRef<HTMLElement | null>(null);
  const [pendingDetailsTarget, setPendingDetailsTarget] = useState<'desktop-pairing' | 'link-device'>();
  const [memberMenu, setMemberMenu] = useState<string>();
  const memberMenuFocus = useRef<'first' | 'last'>('first');
  const [renamingAgent, setRenamingAgent] = useState<string>();
  const [focusedMessageId, setFocusedMessageId] = useState<string>();
  const [timelineZoom, setTimelineZoom] = useState<TimelineZoom>(() => {
    try { return localStorage.getItem('meshrooms:timeline-zoom') === 'full' ? 'full' : 'focused'; } catch { return 'focused'; }
  });
  useEffect(() => { try { localStorage.setItem('meshrooms:timeline-zoom', timelineZoom); } catch { /* storage may be unavailable */ } }, [timelineZoom]);
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(() => new Set());
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(() => new Set());
  const latestZoom = useRef<TimelineZoom>(timelineZoom);
  const latestExpandedStacks = useRef<ReadonlySet<string>>(expandedStacks);
  const latestTimeline = useRef<readonly TaskEvent[]>([]);
  const latestDecisions = useRef<readonly Decision[]>([]);
  const latestRenames = useRef<readonly RenameNotice[]>([]);
  const [liveMessage, setLiveMessage] = useState<{ id: string; text: string }>();
  const [replyId, setReplyId] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [retractOps, setRetractOps] = useState<RetractBody[]>([]);
  const draftOwner = useRef('');
  const [draftProblem, setDraftProblem] = useState(false);
  const [repositoryDraft, setRepositoryDraft] = useState('');
  /** The invite dialog (a person or an agent) and the tab it opens on. */
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteTab, setInviteTab] = useState<InviteTab>('person');
  const [phoneLeft, setPhoneLeft] = useState(false);
  /** A phone that typed a code instead of scanning one. */
  const [typedPhone, setTypedPhone] = useState<PhoneLink>();
  const [phonePairingActive, setPhonePairingActive] = useState(false);
  /** The bridge version the service asks agents to run, pinned in the prompt people copy for their agent. */
  const [agentVersion, setAgentVersion] = useState<string>();
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
  const [boardOpen, setBoardOpen] = useState(restoredPanel.panel === 'tasks');
  const [boardWidth, setBoardWidth] = useState(savedBoardWidth);
  const workspace = useRef<HTMLDivElement>(null);
  const [railCollapsed, setRailCollapsed] = useState(() => { try { return localStorage.getItem('meshrooms:rail') === 'collapsed'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('meshrooms:rail', railCollapsed ? 'collapsed' : 'open'); } catch { /* storage may be unavailable */ } }, [railCollapsed]);
  const [avatarFor, setAvatarFor] = useState<string>();
  const avatarInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Record<string, FileView>>({});
  const [chosen, setChosen] = useState<ChosenFile[]>([]);
  const [sending, setSending] = useState(false);
  const sendPending = useRef(false);
  // Save before the browser can follow a room link. This is tab storage, never a message or a daemon preference.
  useLayoutEffect(() => {
    if (!urlRoom || !deviceId || draftOwner.current !== `${deviceId}:${urlRoom}`) return;
    setDraftProblem(!roomDrafts.save(deviceId, urlRoom, { text, replyId }));
  }, [deviceId, text, replyId]);
  // Files and an in-flight send are held in memory. Warn before leaving while anything cannot be restored as a draft.
  useEffect(() => {
    if (!sending && !chosen.length && !(draftProblem && (text || replyId))) return;
    const leaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, [sending, chosen.length, draftProblem, text, replyId]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [taskOps, setTaskOps] = useState<TaskBody[]>([]);
  const [decisionOps, setDecisionOps] = useState<(DecisionBody | VoteBody)[]>([]);
  const [decisionsOpen, setDecisionsOpen] = useState(restoredPanel.panel === 'decisions');
  // Remember the side panel the person leaves open, for the next room they open. Only their changes are saved: the
  // first render is what was restored (or nothing, on a narrow screen), and saving it would forget the choice.
  const shownPanel = useRef<string | undefined>(undefined);
  useEffect(() => {
    const panel = detailsOpen ? paneTab === 'work' ? 'work' : `details:${detailsTab}` : boardOpen ? 'tasks' : decisionsOpen ? 'decisions' : '';
    if (shownPanel.current === undefined || shownPanel.current === panel) { shownPanel.current = panel; return; }
    shownPanel.current = panel;
    try { localStorage.setItem(SIDE_PANEL_KEY, panel); } catch { /* Not remembered. */ }
  }, [detailsOpen, paneTab, detailsTab, boardOpen, decisionsOpen]);
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
  /** Previous room session teardown in this tab, awaited on retry before re-acquiring the room lock. */
  const closingRoom = useRef<Promise<void>>(Promise.resolve());
  /** Older messages can be loaded (the local page hands out the newest first). */
  const [olderAvailable, setOlderAvailable] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const historyLoading = useRef(false), historyAnchor = useRef<HistoryAnchor | undefined>(undefined);
  const [restoreHistory, setRestoreHistory] = useState<HistoryAnchor>();
  const everJoined = useRef(false);
  const stick = useStickToBottom();
  function captureHistory(focus = false): HistoryAnchor | undefined {
    const view = stick.viewport.current;
    if (!view) return;
    const top = view.getBoundingClientRect().top;
    const node = Array.from(view.querySelector('.browser-message-list')?.children ?? []).find(row =>
      !row.classList.contains('browser-day') && row.getBoundingClientRect().bottom > top) as HTMLElement | undefined;
    if (node) {
      const messageId = node.dataset.anchorMsg || node.dataset.stackMsgs?.split(' ')[0] || undefined;
      return { node, offset: node.getBoundingClientRect().top - top, focus, messageId };
    }
  }
  useLayoutEffect(() => {
    const view = stick.viewport.current;
    if (!restoreHistory) return;
    if (!view) { setRestoreHistory(undefined); return; }
    let target: HTMLElement | null = restoreHistory.node.isConnected ? restoreHistory.node : null;
    if (!target && restoreHistory.messageId) {
      const list = view.querySelector('.browser-message-list');
      target = (list?.querySelector(`[data-anchor-msg="${restoreHistory.messageId}"]`)
        || list?.querySelector(`[data-stack-msgs~="${restoreHistory.messageId}"]`)) as HTMLElement | null;
    }
    if (!target) { setRestoreHistory(undefined); return; }
    if (!view.clientHeight) return;
    view.scrollTop += target.getBoundingClientRect().top - view.getBoundingClientRect().top - restoreHistory.offset;
    if (restoreHistory.focus && document.activeElement === document.body) {
      target.tabIndex = -1; target.focus({ preventScroll: true });
    }
    setRestoreHistory(undefined);
  }, [restoreHistory, detailsOpen, boardOpen]);
  async function loadEarlier(event: React.MouseEvent<HTMLButtonElement>) {
    if (historyLoading.current || !peers.current) return;
    historyLoading.current = true; setOlderLoading(true);
    historyAnchor.current = captureHistory(document.activeElement === event.currentTarget);
    stick.pauseFollowing();
    try {
      setOlderAvailable(await peers.current.loadOlder());
      setRestoreHistory(historyAnchor.current);
    } catch (error) { if (upgradeError(error)) setUpgradeRequired(true); setError((error as Error).message); }
    finally { historyLoading.current = false; setOlderLoading(false); }
  }
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const linkDevice = useRef<HTMLDetailsElement>(null);
  /** Room details' "Use the desktop app", which the header's hint opens. */
  const desktopPairing = useRef<HTMLDetailsElement>(null);
  const [desktopPairingActive, setDesktopPairingActive] = useState(false);
  const admitted = !!status?.memberId;
  const host = admitted && status?.memberId === status?.ownerId;
  const self = status?.members?.find(m => m.id === status.memberId);
  const pending = status?.request?.state === 'pending';
  const participants = useMemo(() => participantsOf(status?.members), [status?.members]);
  const mentions = useMentions(participants, status?.memberId, composer, setText);
  useAutoGrow(composer, text);
  const mainPane = useRef<HTMLElement>(null);
  const composeTools = useRef<HTMLSpanElement>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const { narrowPane, compactChrome } = usePaneFlags(mainPane);
  const headerActions = useRef<HTMLDivElement>(null);
  const headerMore = useRef<HTMLButtonElement>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  useVisualViewport();
  const touchComposer = useRef(false);
  useEffect(() => {
    const mq = matchMedia('(pointer: coarse)');
    const apply = () => { touchComposer.current = mq.matches; };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  useEffect(() => { if (!narrowPane) setToolsOpen(false); }, [narrowPane]);
  useEffect(() => { if (!compactChrome) setHeaderMenuOpen(false); }, [compactChrome]);
  useEffect(() => {
    if (!headerMenuOpen) return;
    const close = (event: PointerEvent) => { if (!headerActions.current?.contains(event.target as Node)) setHeaderMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setHeaderMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [headerMenuOpen]);
  useEffect(() => {
    if (!toolsOpen) return;
    const close = (event: PointerEvent) => { if (!composeTools.current?.contains(event.target as Node)) setToolsOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setToolsOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [toolsOpen]);
  const agents = status?.members?.filter(isAgent) || [];
  /** The "Bring your agent" banner: until they have an agent here, an unused link, or chose "Not now". */
  const agentCtaShown = !!(admitted && self && !isAgent(self) && !agentCtaDismissed && !status?.agentInvites?.length && !status?.members?.some(m => isAgent(m) && m.operatorId === self.id));
  const people = (status?.members?.length || 0) - agents.length;
  /** The local page: the person's agents on this computer, read while Room details shows or one of them is in the room. */
  const localAgents = useLocalAgents(source.agents, admitted && ((detailsOpen && paneTab === 'room') || agents.some(a => a.operatorId === status?.memberId)));
  /** The agent whose sessions the people list asked to show (`at`: each ask scrolls to it again). */
  const [agentFocus, setAgentFocus] = useState<{ id: string; at: number }>();
  /** How an agent of the person's wakes here, from its identity on this computer (the local page only). */
  const wakeOf = (member: BrowserMember) => source.agents && member.operatorId === status?.memberId ? identityOfMember(localAgents.listing, urlRoom, member.id) : undefined;
  const canonicalKeys = useMemo(() => canonicalMessageKeys(messages), [messages]);
  const canonicalById = useMemo(() => {
    const map = new Map<string, SavedMessage>();
    for (const m of messages) {
      const k = messageKey(m.packet.body.deviceId, m.packet.body.id);
      if (canonicalKeys.get(m.packet.body.id) === k) map.set(m.packet.body.id, m);
    }
    return map;
  }, [messages, canonicalKeys]);
  const reply = replyId ? canonicalById.get(replyId) : undefined;
  /** "you", or the operator's name, for an agent member. */
  const operatorOf = (member: BrowserMember | undefined) => {
    if (!isAgent(member) || !member!.operatorId) return undefined;
    return member!.operatorId === status?.memberId ? 'you' : status?.members?.find(m => m.id === member!.operatorId)?.name || 'a former member';
  };
  const runtimeOf = (member: BrowserMember | undefined) => {
    if (member?.role !== 'agent') return undefined;
    return [
      member.harness,
      member.model,
      member.reasoningEffort && `Reasoning effort: ${member.reasoningEffort}`,
      member.serviceTier && `Service tier: ${member.serviceTier}`,
    ].filter(Boolean).join(' · ') || undefined;
  };
  const nameOf = (memberId: string) => status?.members?.find(m => m.id === memberId)?.name || 'Former member';
  /** Task changes read as quiet lines between messages, placed by time. They are local views, never sent. */
  const timeline = useMemo(() => taskTimeline(taskOps), [taskOps]);
  /** Decisions as every device folds them: people's votes count, agents' are advice. */
  // Departed members keep their role, so a removed agent's vote can never be counted as a person's.
  const former = useMemo(() => [...new Map((status?.formerDevices ?? []).map(d => [d.memberId, { id: d.memberId, ...(d.role ? { role: d.role } : {}) }])).values()], [status?.formerDevices]);
  const decisions = useMemo(() => foldDecisions(decisionOps, { ownerId: status?.ownerId, members: status?.members ?? [], former }), [decisionOps, status?.ownerId, status?.members, former]);
  const openDecisions = decisions.filter(d => d.state === 'open').length;
  const roomWork = useMemo(() => workList(tasks, decisions, now), [tasks, decisions, now]);
  /** What waits on this person here ("Needs you"), and what they've already opened from it on this device. */
  const [attentionSeen, setAttentionSeen] = useState(() => loadSeen(urlRoom));
  // Reading the conversation for messages to this person happens when it changes, not on every tick of the clock: the
  // clock only moves the windows, which attentionAt applies to what was found.
  const forYou = useMemo(() => messagesForYou({
    memberId: status?.memberId ?? '', participants, reactions,
    messages: [...canonicalById.values()].map(({ packet: { body }, retracted }) => ({ id: body.id, memberId: body.memberId, text: body.text, at: body.at, ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(retracted ? { retracted } : {}) })),
  }), [status?.memberId, participants, reactions, canonicalById]);
  const attention = useMemo(() => attentionAt(forYou, { memberId: status?.memberId ?? '', participants, decisions, tasks, seen: attentionSeen, now }),
    [forYou, status?.memberId, participants, decisions, tasks, attentionSeen, now]);
  const seeAttention = (marks: string[]) => setAttentionSeen(current => markSeen(urlRoom, current, marks));
  const items = useMemo(() => mergeTranscriptItems(messages, timeline, decisions, status?.renames ?? []), [messages, timeline, decisions, status?.renames]);
  const hasAgentMessages = useMemo(() => {
    const agentIds = new Set(agents.map(a => a.id));
    return agents.length > 0 && messages.some(m => agentIds.has(m.packet.body.memberId));
  }, [agents, messages]);
  const streamEntries = useMemo(() => buildStreamEntries(items, {
    zoom: hasAgentMessages ? timelineZoom : 'full',
    members: status?.members ?? [],
    participants,
    viewerId: status?.memberId,
    allMessages: messages,
  }), [items, hasAgentMessages, timelineZoom, status?.members, participants, status?.memberId, messages]);
  latestZoom.current = timelineZoom;
  latestExpandedStacks.current = expandedStacks;
  latestTimeline.current = timeline;
  latestDecisions.current = decisions;
  latestRenames.current = status?.renames ?? [];
  /** True while the reader has a reaction picker, delete prompt, highlight, or keyboard focus inside a stack's messages. */
  const stackHasInteraction = (stack: ResponseStack) => stack.messages.some(m => {
    const id = m.packet.body.id;
    const key = messageKey(m.packet.body.deviceId, id);
    return key === reactPicker || key === confirmDelete || id === highlight || id === focusedMessageId;
  });
  // Keep a stack open once a reader is interacting with or focused inside a reply that just formed a stack.
  useEffect(() => {
    const toExpand = streamEntries
      .filter((e): e is ResponseStack => e.kind === 'stack' && !expandedStacks.has(e.id) && stackHasInteraction(e))
      .map(e => e.id);
    if (!toExpand.length) return;
    setExpandedStacks(current => {
      const next = new Set(current);
      for (const id of toExpand) next.add(id);
      return next;
    });
  }, [streamEntries, reactPicker, confirmDelete, highlight, focusedMessageId]);
  // If a focused lone agent reply just wrapped into an expanded stack, restore focus instead of dropping to body.
  useLayoutEffect(() => {
    if (!focusedMessageId || document.activeElement !== document.body) return;
    const article = document.getElementById(`message-${focusedMessageId}`);
    if (!article) return;
    article.tabIndex = -1;
    article.focus({ preventScroll: true });
  }, [streamEntries, focusedMessageId]);
  const sharedFiles = useMemo(() => collectSharedFiles(messages, status?.members), [messages, status?.members]);
  // Close this person's own decisions once the result can't change or the deadline passes (agents' bridges do the same).
  useEffect(() => {
    // The person device behind the local page closes its own decisions itself.
    if (!status?.memberId || source.isLocal) return;
    const tick = () => {
      const at = Date.now();
      if (decisions.some(d => d.state === 'open' && d.closesAt)) setNow(at);
      const session = peers.current;
      if (!session) return;
      for (const d of decisions) {
        const key = `${d.key}:${d.revision}:${d.votes.length}`;
        if (d.createdBy === status.memberId && due(d, at) && !closing.current.has(key)) {
          closing.current.add(key);
          void session.reviseDecision(d, { close: true }).catch(() => closing.current.delete(key));
        }
      }
    };
    tick(); const timer = setInterval(tick, 5000); return () => clearInterval(timer);
  }, [decisions, status?.memberId, source]);

  useEffect(() => {
    let disposed = false, room: { done: Promise<void>; dispose(): void } | undefined;
    setReady(false); setError(''); setOpeningError(''); setNetwork(''); setSignInRequired(false); setUpgradeRequired(false);
    void (async () => {
      // Wait for any previous room session in this tab to finish closing and release its lock before retrying.
      await closingRoom.current.catch(() => {});
      if (disposed) return;
      const { deviceId: device, recent: rooms, name: profile } = await source.start();
      if (disposed) return;
      if (urlRoom && draftOwner.current !== `${device}:${urlRoom}`) {
        const draft = roomDrafts.read(device, urlRoom);
        draftOwner.current = `${device}:${urlRoom}`;
        setText(draft.text); setReplyId(draft.replyId);
      }
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
      setPublicHistory(!!info.historyForNewcomers);
      room = source.open(urlRoom, device, {
        ready: session => { peers.current = session; },
        messages: (m, c, added) => {
          setLiveMessage(current => current && m.some(saved => saved.retracted && saved.packet.body.id === current.id) ? undefined : current);
          if (added && !added.retracted) {
            const own = added.packet.body.deviceId === (currentStatus.current?.deviceId || device);
            let hiddenInCollapsedStack = false;
            if (!own && latestZoom.current === 'focused') {
              const roomMembers = currentStatus.current?.members ?? [];
              const hasAgentsInRoom = roomMembers.some(member => isAgent(member));
              if (hasAgentsInRoom) {
                const projected = buildStreamEntries(
                  mergeTranscriptItems(m, latestTimeline.current, latestDecisions.current, latestRenames.current),
                  {
                    zoom: 'focused',
                    members: roomMembers,
                    participants: participantsOf(roomMembers),
                    viewerId: currentStatus.current?.memberId,
                    allMessages: m,
                  },
                );
                hiddenInCollapsedStack = isHiddenInCollapsedStack(added.packet.body.id, projected, latestExpandedStacks.current);
              }
            }
            if (own || !hiddenInCollapsedStack) stick.arrived(own);
            if (!own) {
              const author = currentStatus.current?.members?.find(p => p.id === added.packet.body.memberId)?.name || 'Room member';
              setLiveMessage({ id: added.packet.body.id, text: `${author}: ${shownText(added.packet.body) || `shared ${fileNames(added.packet.body)}`}` });
            }
          }
          setMessages(m); setConnected(c); setOlderAvailable(!!peers.current?.hasOlder());
        },
        network: (problem, needsSignIn = false) => { if (/Reload the page or update the agent bridge/i.test(problem)) setUpgradeRequired(true); setNetwork(problem); setSignInRequired(needsSignIn); if (problem) setReady(true); },
        board: (board, ops) => { setTasks(board); setTaskOps(ops); },
        files: setFiles,
        activity: records => { setActivity(records); setNow(Date.now()); },
        decisions: setDecisionOps,
        reactions: setReactions,
        retractions: setRetractOps,
        position: setPosition,
        status: next => {
          if (next.request?.state === 'expired' || next.request?.state === 'declined') setNotice('');
          currentStatus.current = next;
          setStatus(next); setReady(true); setNetwork(''); setSignInRequired(false);
          if (next.memberId) everJoined.current = true;
        },
        closed: reason => { setClosed(current => current || reason); setStatus(undefined); setNetwork(''); setReady(true); },
        recent: setRecent,
        lost: () => { setLostRoom(true); setNetwork(''); },
      });
      closingRoom.current = room.done.catch(() => {});
      await room.done;
    })().catch(e => { if (!disposed) { if (upgradeError(e)) setUpgradeRequired(true); setOpeningError(e.message); setSignInRequired(e.status === 401); setReady(true); } });
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
  /** Unread in the person's other rooms, plus the open room when hidden or hosting pending join requests. */
  const others = useMemo(() => recent.filter(r => r.id !== urlRoom), [recent]);
  const otherUnread = others.reduce((sum, r) => sum + (counts[r.id]?.unread || 0), 0);
  const otherWaiting = others.flatMap(r => counts[r.id]?.waiting || []);
  const ownWaiting = useMemo(() => host && !closed ? waitingOf(status) : [], [host, closed, status?.requests, status?.members]);
  const titleUnread = otherUnread + (!visible && !closed ? (ownCount?.unread || 0) : 0);
  const titleWaiting = otherWaiting.length + ownWaiting.length;
  // The tab names the open room, so several Meshrooms tabs can be told apart.
  useEffect(() => { document.title = tabTitle(urlRoom ? title : '', titleUnread, titleWaiting); }, [title, titleUnread, titleWaiting]);
  // Opt-in browser notifications for hosted rooms: permission is requested only on an explicit click.
  const notifySupported = !source.isLocal && typeof Notification !== 'undefined';
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission>(() => notifySupported ? Notification.permission : 'denied');
  const [hostNotifyEnabled, setHostNotifyEnabled] = useState(false);
  const notifiedRequests = useRef(new Set<string>());
  useEffect(() => {
    if (!notifySupported) return;
    let active = true;
    void source.readPref<boolean>('host-join-notifications').then(saved => {
      if (active) setHostNotifyEnabled(!!saved && Notification.permission === 'granted');
    }).catch(() => {});
    return () => { active = false; };
  }, [notifySupported, source]);
  async function toggleHostNotifications(enable: boolean) {
    if (!notifySupported) return;
    if (!enable) {
      setHostNotifyEnabled(false);
      await source.writePref('host-join-notifications', false).catch(() => {});
      return;
    }
    let permission = Notification.permission;
    if (permission === 'default') {
      try { permission = await Notification.requestPermission(); } catch { permission = 'denied'; }
    }
    setNotifyPermission(permission);
    const allowed = permission === 'granted';
    setHostNotifyEnabled(allowed);
    await source.writePref('host-join-notifications', allowed).catch(() => {});
    if (allowed) setNotice('Join-request alerts are on for this browser.');
  }
  useEffect(() => {
    if (!notifySupported) return;
    const rooms: { roomId: string; roomTitle: string; waiting: Waiting[] }[] = [
      ...(urlRoom && ownWaiting.length ? [{ roomId: urlRoom, roomTitle: title, waiting: ownWaiting }] : []),
      ...others.map(r => ({ roomId: r.id, roomTitle: r.title, waiting: counts[r.id]?.waiting || [] })).filter(r => r.waiting.length),
    ];
    if (!rooms.length) return;
    const fresh = hostJoinNotifications(rooms, notifiedRequests.current);
    // Record requests already seen while visible so switching tabs later does not alert for them.
    if (document.visibilityState === 'visible' || !hostNotifyEnabled || Notification.permission !== 'granted') return;
    for (const item of fresh) {
      try {
        const note = new Notification(item.title, { body: item.body, tag: item.key });
        note.onclick = () => {
          window.focus();
          if (item.roomId && item.roomId !== urlRoom) location.assign(`/r/${item.roomId}`);
          note.close();
        };
      } catch { /* Browsers that disallow direct Notification construction skip quietly. */ }
    }
  }, [notifySupported, hostNotifyEnabled, title, ownWaiting, others, counts]);
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
  // Opening onto a piece of work focuses its title instead (the work view does that as it mounts).
  useEffect(() => { if (detailsOpen && !(paneTab === 'work' && selectedWork)) detailsHeading.current?.focus(); }, [detailsOpen]);
  // Activity durations and staleness move with the clock, not only with packets.
  useEffect(() => {
    if (!agents.length) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [agents.length]);
  // So do This work's "5 min ago", in a room without agents to keep the clock going.
  const workShown = detailsOpen && paneTab === 'work';
  useEffect(() => {
    if (!workShown || agents.length) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [workShown, agents.length]);
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
  function showOnBoard(taskId: string) { setBoardOpen(true); setDetailsOpen(false); setDecisionsOpen(false); setHighlight(taskId); }
  /** Opens a task or decision in the side pane's "This work", remembering what opened it for when the pane closes. */
  function showWork(ref: WorkRef) {
    if (!detailsOpen) workOpener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setSelectedWork(ref); setPaneTab('work'); setDetailsOpen(true); setBoardOpen(false); setDecisionsOpen(false);
  }
  function showTask(taskId: string) { showWork({ kind: 'task', id: taskId }); }
  function showDecision(key: string) { setHighlight(key); document.getElementById(`decision-${key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  /** A decided option becomes a task on the board, noting where it was decided. */
  async function decisionTask(d: Decision) {
    const winner = d.tally.optionIds[0], chosen = d.options.find(o => o.id === winner)?.label ?? '';
    const notes = `Decided in the room: ${d.question}\nOutcome: ${chosen} (${d.tally.tally[winner] ?? 0} of ${d.tally.voters} votes from people)`;
    // Budget space for ` → chosen` first so truncation never cuts off the chosen outcome.
    const title = decisionTaskTitle(d.question, chosen, 120);
    await peers.current!.changeTask({ title, notes: notes.slice(0, 2000) });
    setBoardOpen(true); setDecisionsOpen(false); setDetailsOpen(false);
  }
  function toggleStack(id: string) {
    setExpandedStacks(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleEventsFold(id: string) {
    setExpandedEvents(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function openStackMessage(stackId: string, messageId: string) {
    setExpandedStacks(current => current.has(stackId) ? current : new Set([...current, stackId]));
    setHighlight(messageId);
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`message-${messageId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })));
  }
  /** Below the wide layout the side pane covers the conversation: step out of it before showing something there. */
  function uncoverConversation() {
    if (matchMedia(PANE_BESIDE).matches) return;
    setDetailsOpen(false); workOpener.current = null;
  }
  function showMessage(id: string) {
    uncoverConversation();
    const parentStack = streamEntries.find(e => e.kind === 'stack' && e.messages.some(m => m.packet.body.id === id));
    if (parentStack && parentStack.kind === 'stack') {
      setExpandedStacks(current => current.has(parentStack.id) ? current : new Set([...current, parentStack.id]));
    }
    setHighlight(id);
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`message-${id}`)?.scrollIntoView({ block: 'center' })));
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
  const { people: sortedPeople, agents: sortedAgents } = sortRoomMembers(status?.members, activities, status?.ownerId, status?.memberId);
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
    if (a.state === 'idle') return a.quiet === undefined
      ? <span className="agent-activity is-idle">Idle{age}</span>
      : <span className="agent-activity is-idle is-quiet">Not listening<span className="agent-activity-quiet"> · no check-in for {duration(a.quiet)}</span></span>;
    if (a.quiet !== undefined) return <span className="agent-activity is-working is-quiet">Busy<span className="agent-activity-quiet"> · no check-in for {duration(a.quiet)}</span></span>;
    const task = a.on.tasks?.map(id => tasks.find(t => t.id === id)).find(Boolean);
    if (task) return <span className="agent-activity is-working">Working on <button className="agent-activity-link" title="Open this task" onClick={() => showTask(task.id)}>“{task.title}”</button>{age}</span>;
    const woke = (a.on.messages || []).map(id => messages.find(m => m.packet.body.id === id)?.packet.body).filter(b => !!b);
    if (!woke.length) return <span className="agent-activity is-working">Working{age}</span>;
    const authors = [...new Set(woke.map(b => b.memberId === status?.memberId ? 'you' : nameOf(b.memberId)))];
    const latest = woke.at(-1)!;
    return <span className="agent-activity is-working">Replying to <button className="agent-activity-link" title="Show the message" onClick={() => showMessage(latest.id)}>{authors.length > 1 ? `${authors.slice(0, -1).join(', ')} and ${authors.at(-1)}` : authors[0]}</button>{age}</span>;
  }
  /** The roster's short state beside an agent's name: "Idle · 9 min", "Working · just now", "Not listening". */
  function rosterState(a: AgentActivity) {
    if (a.state === 'offline' || a.state === 'online') return <span className="browser-person-state">{a.state === 'offline' ? 'Offline' : 'Online'}</span>;
    const quiet = a.quiet !== undefined ? `No check-in for ${duration(a.quiet)}` : undefined;
    const text = a.state === 'idle' ? quiet ? 'Not listening' : `Idle · ${duration(now - a.since)}` : quiet ? 'Busy' : `Working · ${duration(now - a.since)}`;
    return <span className={`browser-person-state${a.state === 'working' && !quiet ? ' is-working' : ''}`} title={quiet}>{text}</span>;
  }
  /** One line under a working agent saying what it works on, linked to the task or message; nothing otherwise. */
  function rosterDetail(a: AgentActivity) {
    if (a.state !== 'working' || a.quiet !== undefined) return null;
    const task = a.on.tasks?.map(id => tasks.find(t => t.id === id)).find(Boolean);
    if (task) return <span className="browser-person-detail">On <button className="agent-activity-link" title={`Open “${task.title}”`} onClick={() => showTask(task.id)}>“{task.title}”</button></span>;
    const woke = (a.on.messages || []).map(id => messages.find(m => m.packet.body.id === id)?.packet.body).filter(b => !!b);
    if (!woke.length) return null;
    const authors = [...new Set(woke.map(b => b.memberId === status?.memberId ? 'you' : nameOf(b.memberId)))];
    const who = authors.length > 1 ? `${authors.slice(0, -1).join(', ')} and ${authors.at(-1)}` : authors[0];
    return <span className="browser-person-detail">Replying to <button className="agent-activity-link" title="Show the message" onClick={() => showMessage(woke.at(-1)!.id)}>{who}</button></span>;
  }
  function closeDetails() {
    setDetailsOpen(false);
    setMemberMenu(undefined);
    const opener = workOpener.current; workOpener.current = null;
    requestAnimationFrame(() => {
      if (opener?.isConnected && opener.getClientRects().length) opener.focus();
      else if (headerMore.current && headerMore.current.getClientRects().length) headerMore.current.focus();
      else detailsButton.current?.focus();
    });
  }
  function focusMemberMenuButton(memberId: string) {
    requestAnimationFrame(() => document.getElementById(`member-menu-btn-${memberId}`)?.focus());
  }
  function openMemberMenu(memberId: string, focusPos: 'first' | 'last' = 'first') {
    memberMenuFocus.current = focusPos;
    setMemberMenu(memberId);
  }
  function handleMemberMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>, memberId: string) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(idx + 1) % items.length].focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0].focus(); }
    else if (event.key === 'End') { event.preventDefault(); items[items.length - 1].focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMemberMenu(undefined); focusMemberMenuButton(memberId); }
    else if (event.key === 'Tab') { setMemberMenu(undefined); }
  }
  function openDetails(tab?: DetailsTab) {
    if (tab) setDetailsTab(tab);
    if (!detailsOpen) workOpener.current = null;
    setPaneTab('room'); setDetailsOpen(true); setBoardOpen(false); setDecisionsOpen(false);
  }
  useEffect(() => {
    if (!detailsOpen || detailsTab !== 'you' || !pendingDetailsTarget) return;
    const target = pendingDetailsTarget;
    setPendingDetailsTarget(undefined);
    requestAnimationFrame(() => {
      if (target === 'desktop-pairing') {
        const pair = desktopPairing.current; if (!pair) return;
        pair.open = true;
        (pair.querySelector('[data-desktop-pairing-confirm]') || pair).scrollIntoView({ block: 'center' });
      } else if (target === 'link-device') {
        const add = linkDevice.current; if (!add) return;
        add.open = true;
        add.scrollIntoView({ block: 'nearest' });
        add.querySelector('input')?.focus();
      }
    });
  }, [detailsOpen, detailsTab, pendingDetailsTarget]);
  useEffect(() => {
    if (!memberMenu) return;
    const openId = memberMenu;
    const focusPos = memberMenuFocus.current;
    requestAnimationFrame(() => {
      const menu = document.getElementById(`member-menu-${openId}`);
      const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      if (!items.length) return;
      (focusPos === 'last' ? items[items.length - 1] : items[0]).focus();
    });
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest('.browser-member-menu-wrap')) setMemberMenu(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setMemberMenu(undefined); focusMemberMenuButton(openId); }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [memberMenu]);

  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { if (upgradeError(e)) setUpgradeRequired(true); setError((e as Error).message); }
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
  const pairRoom = (roomId: string, secret: string, options?: { preview?: true; revoke?: true }) => source.command('link', roomId, { pairing: secret, ...options });
  const pairCommand: PairCommander = (action, roomId, payload) => source.command(action, roomId, payload);
  /** A device waiting in a room this one hosts, with no code or person behind it yet: the phone of an open "My phone" code, most likely. */
  const askingRequest = host ? status?.requests?.filter(r => r.kind === 'companion' && !r.linkedMemberId && r.state === 'pending').at(-1) : undefined;
  /** The old way for a phone that cannot scan: its device code, typed in Room details › You. */
  function openCodeLink() {
    setInviteOpen(false);
    setPendingDetailsTarget('link-device');
    openDetails('you');
  }
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
  const readyFiles = chosen.filter(f => f.status === 'ready');
  // More than MAX_MESSAGE_FILES only after a failed send brought its files back: the person removes some before sending.
  const canSend = !busy && !signInRequired && chosen.length <= MAX_MESSAGE_FILES && chosen.every(f => f.status === 'ready') && (!!text.trim() || readyFiles.length > 0);
  function send(event: FormEvent) {
    event.preventDefault(); if (!canSend || sendPending.current) return;
    sendPending.current = true; setSending(true);
    const draft = text, replyTo = replyId, sending = readyFiles;
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
      } finally {
        sendPending.current = false; setSending(false);
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
    if (transfer?.state === 'fetching') return { note: transfer.received > 0 ? `Receiving · ${Math.floor(transfer.received * 100 / transfer.size)}%` : 'Fetching…' };
    if (transfer?.state === 'damaged') return { note: 'A copy failed verification. Trying other devices.' };
    if (transfer?.state === 'waiting') return { note: connected.length ? 'Fetching…' : 'Available when a device that has it connects' };
    if (peers.current?.evicted(sha)) return { note: source.isLocal ? 'Not kept on this computer: newer files filled this room’s storage' : 'Not kept in this browser: newer files filled this room’s storage' };
    return { onFetch: () => peers.current?.requestFile(sha) };
  };
  const attachmentsOf = (body: SavedMessage['packet']['body']): Attachment[] => (body.attachments || []).map(ref => ({ ...ref,
    kind: files[ref.sha256]?.url ? displayKind(ref, files[ref.sha256].type) : IMAGE_TYPES.includes(ref.type) ? 'image' : 'file' }));
  function startReply(id: string) { setReplyId(id); requestAnimationFrame(() => composer.current?.focus()); }
  function openInvite(tab: InviteTab) { setInviteTab(tab); setInviteOpen(true); setHeaderMenuOpen(false); }
  /** A one-time agent link for this name. The token is shown once; the room service keeps only its hash. */
  async function createAgentLink(name: string) {
    const { token } = await source.command('agent-invite', urlRoom, { name }) as unknown as { token: string };
    return token;
  }
  function openAgentConnect() {
    openDetails('members');
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
  /** Atomically removes every device of a member and any agents they operate in one command. */
  function removeMember(member: BrowserMember) {
    void act(async () => {
      await source.command('remove', urlRoom, { memberId: member.id });
      setConfirming(undefined);
      setNotice(member.id === status?.memberId ? 'You left this room.' : `${member.name} was removed from the room.`);
    });
  }
  /** Transfers host privileges to another human member in this room. */
  function transferHost(member: BrowserMember) {
    void act(async () => {
      await source.command('transfer-host', urlRoom, { memberId: member.id });
      setConfirming(undefined);
      setNotice(`${member.name} is now the host of this room.`);
    });
  }
  /** The shared TaskBoard offers "local" participants as assignees; in a browser room every member can be assigned. */
  const boardRoom = { id: urlRoom, title, project: '', sample: false, messages: [], tasks,
    participants: participants.map(p => ({ ...p, state: 'local' as const })) } as unknown as RoomSnapshot;
  async function boardAction(work: (engine: RoomSession) => Promise<void>) {
    setError('');
    try { if (!peers.current) throw new Error('Room connection is not ready.'); await work(peers.current); }
    catch (e) { if (upgradeError(e)) setUpgradeRequired(true); setError((e as Error).message); throw e; }
  }
  const boardActions = {
    create: (draft: TaskDraft & { title: string }) => boardAction(engine => engine.changeTask({ title: draft.title, notes: draft.notes, assigneeId: draft.assigneeId ?? null, ...(draft.issue ? { issue: draft.issue } : {}) })),
    update: (task: Task, changes: TaskDraft) => boardAction(engine => engine.changeTask(changes, task)),
    remove: (task: Task) => boardAction(engine => engine.changeTask({}, task, true)),
  };
  const openTasks = tasks.filter(t => t.status !== 'done').length;
  const settings = status?.settings ?? DEFAULT_ROOM_SETTINGS;
  /** People and agents: whether the room's loop guard paused agents, and the last message of each paused thread, where its note goes. */
  const paused = useMemo(() => {
    if (settings.floor !== 'people-and-agents' || !status?.members) return undefined;
    const room = roomViewOf(status, messages), guard = loopGuard(room), last = new Map<string, string>();
    for (const m of room.messages) last.set(chainRoot(room, m.id), m.id);
    const threads = new Set([...guard.chains].filter(([, chain]) => chain.paused).map(([root]) => last.get(root)).filter((id): id is string => !!id));
    return { room: guard.roomPaused, threads };
  }, [settings.floor, status, messages]);
  /** Open floor: messages that went to every agent and the agent answering each, until it has answered (its reply shows then). */
  const answering = useMemo(() => {
    const names = new Map((status?.members ?? []).map(m => [m.id, m.name])), now = Date.now();
    return new Map((status?.claims ?? []).filter(c => !c.answered && c.until > now && names.has(c.memberId)).map(c => [c.messageId, names.get(c.memberId)!]));
  }, [status]);
  const historyForNewcomers = status?.settings?.historyForNewcomers ?? status?.historyForNewcomers ?? publicHistory;
  const historyMeta = useMemo(() => analyzeHistory(messages, retractOps), [messages, retractOps]);
  function changeSettings(change: Partial<RoomSettings>, done: string) {
    void act(async () => {
      await source.command('settings', urlRoom, change);
      // Show the accepted change now rather than at the next status poll, so the control doesn't flick back.
      setStatus(current => current && { ...current, settings: { ...(current.settings ?? DEFAULT_ROOM_SETTINGS), ...change } });
      setNotice(done);
    });
  }
  const pinned = status?.repositories ?? NO_REPOSITORIES;
  // Only while the Shared tab shows them, and once per change to the conversation: scanning it on every render would
  // slow typing. Messages are stored as they arrived from peers, so order them by when they were sent for newest-first
  // suggestions.
  const showsMentioned = detailsOpen && paneTab === 'room' && detailsTab === 'shared';
  const mentioned = useMemo(() => showsMentioned
    ? mentionedRepositories([...messages].sort((a, b) => a.packet.body.at - b.packet.body.at).map(m => m.packet.body.text))
      .filter(r => !pinned.some(p => p.toLowerCase() === r.toLowerCase()))
    : [], [showsMentioned, messages, pinned]);
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
  function confirmRemove(member: BrowserMember, onCancel?: () => void) {
    const leaving = member.id === status?.memberId, count = agentsOf(member);
    const agentsText = `${count} agent${count === 1 ? '' : 's'}`;
    const cancel = () => { setConfirming(undefined); onCancel?.(); };
    return <div className="browser-confirm" role="group" aria-label={leaving ? 'Confirm leaving the room' : `Confirm removing ${member.name}`}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
      <p>{leaving ? `Leave this room on all your devices${count ? ` and remove your ${agentsText}` : ''}?` : `Remove ${member.name}${count ? ` and their ${agentsText}` : ''} from this room?`}</p>
      <div><button className="secondary" disabled={busy} onClick={() => removeMember(member)}>{leaving ? 'Leave room' : 'Remove'}</button><button className="browser-text-link" autoFocus onClick={cancel}>Cancel</button></div>
    </div>;
  }
  /** Inline confirmation for transferring room hosting to another person. */
  function confirmTransfer(member: BrowserMember, onCancel?: () => void) {
    const cancel = () => { setConfirming(undefined); onCancel?.(); };
    return <div className="browser-confirm" role="group" aria-label={`Confirm making ${member.name} host`}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
      <p>Make {member.name} the host of this room? They will control join requests, room settings and deleting the room, and you will become a regular member.</p>
      <div><button className="secondary" disabled={busy} onClick={() => transferHost(member)}>Make host</button><button className="browser-text-link" autoFocus onClick={cancel}>Cancel</button></div>
    </div>;
  }

  function newRoomForm() {
    return <>
          <form onSubmit={create} className="browser-form"><label>Your name<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></label>
            <label>Room name<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={80} placeholder="Project room" /></label>
            {inviteRequired && <label>Invite code<input value={inviteCode} onChange={e => setInviteCode(e.target.value)} required maxLength={32} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX" /></label>}
            <button className="primary" disabled={busy}>{busy ? 'Creating room…' : 'Create room'}</button></form>
          {source.isLocal && roomService && !PUBLIC_ROOM_SERVICES.includes(roomService) && <p className="browser-entry-note browser-room-service">This room will be made on <strong>{roomService}</strong>, not the public Meshrooms service.</p>}
          {inviteRequired && <p className="browser-entry-note">Enter your beta invite once. Then create more rooms without a code. Joining a room from its link doesn’t need one.</p>}
    </>;
  }

  /** This browser paired with the desktop app (DesktopPairing): the room page offers to open rooms there. */
  const appPaired = !source.isLocal && pairedHere();
  const connectionProblem = network || openingError;
  const connectionLabel = upgradeRequired ? 'Reload the page to update' : connectionProblem ? signInRequired ? 'Sign in again from the app to reconnect' : 'Reconnecting…' : connected.length ? `Connected to ${connected.length} other device${connected.length === 1 ? '' : 's'}` : status?.devices && status.devices.length > 1 ? 'Waiting for another device to connect' : 'You’re the first one here';
  const retryConnection = () => setRetry(v => v + 1);
  return <div className={`browser-rooms ${admitted ? 'browser-joined' : ''} ${admitted && railCollapsed ? 'browser-rail-collapsed' : ''} ${admitted && compactChrome ? 'browser-compact' : ''}`}>
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
            const hasDraft = deviceId && r.id !== urlRoom && roomDrafts.has(deviceId, r.id);
            return <a key={r.id} href={`/r/${r.id}`} className={count?.unread ? 'has-unread' : undefined} title={railCollapsed ? label ? `${r.title} · ${label}` : r.title : undefined} aria-current={r.id === urlRoom ? 'page' : undefined} aria-describedby={hasDraft ? `room-draft-${r.id}` : undefined}>
              <RoomIcon kind="chat" /><span>{r.title}</span>{hasDraft && <span id={`room-draft-${r.id}`} className="browser-room-draft" aria-hidden="true">Draft</span>}<RoomBadges count={count} /></a>;
          })}
          <a href={source.isLocal ? '/rooms#create-room' : '/rooms'} className="browser-all-rooms" title={railCollapsed ? 'Create a room' : undefined}><RoomIcon kind="plus" /><span>Create a room</span></a>
        </nav>
        <a href="/rooms" className="browser-mobile-rooms">Your rooms<RoomBadges count={{ unread: otherUnread, mentions: others.reduce((sum, r) => sum + (counts[r.id]?.mentions || 0), 0), waiting: otherWaiting }} /></a>
        <div className="browser-self"><MemberAvatar member={self} roomId={urlRoom} fallback={self?.name || ''} /><div><strong>{self?.name}</strong><span>{host ? 'Room host' : 'Room member'}</span></div>{!source.isLocal && <button type="button" className="browser-self-phone" aria-haspopup="dialog" aria-label="Connect your phone" title="Connect your phone" onClick={() => openInvite('phone')}><RoomIcon kind="phone" /></button>}</div>
      </> : <p className="browser-rail-intro">A shared room for your people and their agents.</p>}
      {source.isLocal && <a href="/agent-apps" className="browser-agent-apps-link">Agent apps</a>}
      <p className="browser-rail-footer">Meshrooms by WormDB<br />{source.label}</p>
    </aside>
    <main ref={mainPane} id="browser-main" className={`browser-main ${detailsOpen ? 'browser-details-open' : ''} ${boardOpen ? 'browser-board-open' : ''}`} tabIndex={-1}>
      {upgradeRequired && (status || !connectionProblem) && <section role="alert" className="browser-recovery browser-upgrade" aria-label="Update available"><div>
        <strong>Update available</strong>
        <p>{error || connectionProblem || 'This page or bridge is outdated. Reload the page or update the agent bridge to continue.'}</p>
        </div><button className="primary" onClick={() => location.reload()}>Reload page</button></section>}
      {!upgradeRequired && error && <div role="alert" className="browser-error">{error} <button onClick={() => { setError(''); if (!status) setRetry(v => v + 1); }}>{status ? 'Dismiss' : 'Retry'}</button></div>}
      {storageProblem && <p role="alert" className="browser-error">{storageProblem}</p>}
      {!upgradeRequired && connectionProblem && status && <section role="status" className="browser-recovery" aria-label="Connection problem"><div>
        <strong>{signInRequired ? 'Sign in again from the app' : source.isLocal ? 'Connection to this computer interrupted' : 'Connection interrupted'}</strong>
        <p>{connectionProblem}</p>{!signInRequired && <p className="browser-recovery-hint">{openingError ? 'Try again when the app is available. Your draft stays in this tab.' : 'We’ll keep trying to reconnect. Your draft stays in this tab.'}</p>}
        </div>{!signInRequired && <button className="secondary" disabled={busy} onClick={retryConnection}>Try again</button>}</section>}
      {notice && <p role="status" className="browser-notice">{notice}</p>}
      {alertShown && alertRoom && <div role="status" className="browser-notice browser-join-notice"><span>{joinNotice(alertShown.request, alertRoom)}</span>
        {alertsMore > 0 && <span className="browser-join-more">{alertsMore} more waiting</span>}
        <a href={`/r/${alertShown.roomId}`}>Open room</a><button className="browser-text-link" onClick={() => setJoinAlerts(queue => queue.filter(a => a !== alertShown))}>Dismiss</button></div>}
      {lostRoom && <div role="alert" className="browser-error">This room is open in another tab. Reload to use it here. <button onClick={() => location.reload()}>Reload</button></div>}
      {closed ? <section className="browser-entry"><h1>{title || 'Room closed'}</h1><h2>This room is closed</h2><p>{closed}</p>
          <p>Nobody can join, send messages or connect agents here any more.</p>
          <div className="browser-entry-actions"><a className="browser-text-link" href="/rooms">Start or open another room</a></div></section>
      : !ready ? <section className="browser-entry" aria-busy="true"><h1>{urlRoom ? 'Opening your room…' : 'Opening your rooms…'}</h1><p>{source.isLocal ? 'Reading your rooms from this computer.' : 'Restoring this browser’s identity.'}</p></section>
      : connectionProblem && !status ? <section className="browser-entry browser-entry-recovery" role="alert">
          <h1>{upgradeRequired ? 'Update available' : signInRequired ? 'Open your rooms from the app' : source.isLocal ? 'Cannot reach Meshrooms on this computer' : 'Your room could not be opened'}</h1>
          <p>{connectionProblem}</p>
          {!upgradeRequired && source.isLocal && !signInRequired && <p>Your rooms and settings are kept on this computer. Open Meshrooms and check that the background service is running.</p>}
          <div className="browser-entry-actions">{upgradeRequired ? <button className="primary" onClick={() => location.reload()}>Reload page</button> : !signInRequired && <button className="primary" onClick={retryConnection}>Try again</button>}
            {urlRoom && <a className="browser-text-link" href="/rooms">Start or open another room</a>}</div>
        </section> : !urlRoom && (typedPhone || incomingPhone) && !source.isLocal && !phoneLeft ? ((typedPhone ?? incomingPhone) === 'invalid' ? <PhoneInvalid /> : <PhoneLanding link={(typedPhone ?? incomingPhone) as PhoneLink} viaCode={!!typedPhone} source={source} onLeave={() => { setPhoneLeft(true); setTypedPhone(undefined); }} />) : !urlRoom ?
        <section className="browser-entry"><h1>{source.isLocal && recent.length ? 'Your rooms' : 'Start a room'}</h1>
          <p>{source.isLocal && recent.length ? 'Open a room paired with this computer.' : 'Share a link. Approve who joins. Start talking.'}</p>
          {!source.isLocal && recent.length === 0 && <p className="browser-entry-note browser-phone-hint">Already use Meshrooms on a computer? Open <strong>Invite</strong> then <strong>My phone</strong> there, and scan its code with this phone’s camera, or type the code it shows.</p>}
          {!source.isLocal && <PhoneCode command={pairCommand} onLink={link => { setPhoneLeft(false); setTypedPhone(link); }} />}
          {source.isLocal && recent.length > 0 && <nav className="browser-recent browser-paired-rooms" aria-label="Your rooms">{recent.map(r => <a key={r.id} href={`/r/${r.id}`}>{r.title}<RoomBadges count={counts[r.id]} /></a>)}</nav>}
          {source.isLocal && recent.length > 0 ? <details className="browser-create-room" id="create-room" ref={section => { if (section && location.hash === '#create-room') { section.open = true; history.replaceState(null, '', location.pathname); section.scrollIntoView({ block: 'start' }); } }}>
            <summary>Create a room</summary>{newRoomForm()}</details> : newRoomForm()}
          {!source.isLocal && recent.length > 0 && <section className="browser-recent"><h2>Your rooms</h2>{recent.map(r => <a key={r.id} href={`/r/${r.id}`}>{r.title}<RoomBadges count={counts[r.id]} /></a>)}</section>}
          {!source.isLocal && recent.length > 0 && <section className="browser-desktop-app" id="desktop-app" ref={section => { if (section && location.hash === '#desktop-app') { history.replaceState(null, '', location.pathname); section.scrollIntoView({ block: 'start' }); } }}><h2>Desktop app</h2><DesktopPairing rooms={recent} name={name} device={deviceId} link={pairRoom} /></section>}
        </section> : !admitted ?
        <section className="browser-entry"><h1>{title || 'Join room'}</h1>
          {pending ? <>
            <h2>{status.request!.kind === 'companion' && !status.request!.linkedMemberId ? 'Confirm on your other device' : status.hostOnline ? 'Waiting for approval' : 'Waiting for the host to return'}</h2>
            {status.request!.kind === 'companion' && !status.request!.linkedMemberId ? <><p>In this room on your trusted device, open <strong>Room details</strong>, then <strong>Add another device</strong>, and enter this code.</p><code className="browser-link-code">{status.request!.code}</code><p>This request expires in ten minutes.</p></> : <p>You’ll enter the conversation when the host admits you. {!status.hostOnline && 'The host is offline right now. '}Requests expire after ten minutes.</p>}
            <div className="browser-entry-actions"><button className="secondary" disabled={busy} onClick={() => void act(async () => { await source.command('cancel', urlRoom, { requestId: status.request!.id }); setNotice('Join request canceled.'); })}>Cancel request</button>
              <a className="browser-text-link" href="/rooms">Back to your rooms</a></div>
          </> : <>
            <p>{status?.request?.state === 'expired' ? 'Your request expired. Ask to join again when you’re ready.' : everJoined.current ? 'This device no longer has access. Ask the host to admit it again.' : status?.request?.state === 'declined' ? 'The host declined your request.' : 'The host will approve your request before you enter. Requests expire after ten minutes.'}</p>
            {status && !status.hostOnline && <p role="status" className="browser-host-offline">The host appears to be offline right now. Join requests expire after ten minutes if they don’t return in time.</p>}
            <form className="browser-form" onSubmit={e => { e.preventDefault(); request('person'); }}><label>Your name<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></label>
              <button className="primary" disabled={busy || !status}>{busy ? 'Sending request…' : 'Ask to join'}</button></form>
            <button className="browser-text-link" disabled={busy || !status} onClick={() => request('companion')}>Use my existing identity</button>
            <p className="browser-entry-note">{source.isLocal ? 'This computer holds your key for this room. ' : 'No installation or agent needed. This browser remembers your identity. '}{historyForNewcomers ? 'History for newcomers is on: new members receive earlier messages shared with the room.' : 'Messages deliver directly between online devices; newcomers don’t receive earlier chat history (your own linked devices still receive your earlier messages).'}</p>
            {!source.isLocal && (appPaired
              ? <div className="browser-entry-actions browser-open-app"><a className="secondary" href={joinLink(location.origin, urlRoom)}>Open in Meshrooms</a>
                <span className="browser-entry-note">Join from the desktop app on this computer instead. It asks before it joins.</span></div>
              : <p className="browser-entry-note browser-app-hint">Have the desktop app? {recent.length
                ? <><a href="/rooms#desktop-app">Use the desktop app</a> to pair it with this browser first.</>
                : <>Join here first, then pair it from <strong>Room details</strong>, <strong>Use the desktop app</strong>.</>}</p>)}
          </>}
        </section> : <>
          <header className="browser-room-header">
            <a className="browser-header-rooms" href="/rooms" aria-label="Your rooms"><RoomIcon kind="back" /><RoomBadges count={{ unread: otherUnread, mentions: others.reduce((sum, r) => sum + (counts[r.id]?.mentions || 0), 0), waiting: otherWaiting }} /></a>
            <div className="browser-room-heading"><h1 title={title || undefined}>{title}</h1><p><span className="browser-room-sub-full">{people} {people === 1 ? 'person' : 'people'}{agents.length ? ` and ${agents.length} agent${agents.length === 1 ? '' : 's'}` : ''} in this room{working ? ` · ${working} working` : ''}{settings.historyForNewcomers ? ' · History for newcomers on' : ''}</span><span className="browser-room-sub-short">{people} {people === 1 ? 'person' : 'people'}{agents.length ? ` · ${agents.length} agent${agents.length === 1 ? '' : 's'}` : ''}{working ? ` · ${working} working` : ''}{settings.historyForNewcomers ? ' · History on' : ''}</span></p></div>
            <div className="browser-room-actions" ref={headerActions}><button type="button" className="secondary browser-header-wide" aria-expanded={decisionsOpen} aria-controls="browser-decisions" onClick={() => { setDecisionsOpen(!decisionsOpen); setBoardOpen(false); setDetailsOpen(false); }}><RoomIcon kind="vote" /><span className="browser-action-label">Decisions</span>{openDecisions ? <span className="browser-count">{openDecisions}</span> : null}</button><button type="button" className="secondary browser-header-wide" aria-expanded={boardOpen} aria-controls="task-board" onClick={() => { setBoardOpen(!boardOpen); setDetailsOpen(false); setDecisionsOpen(false); }}><RoomIcon kind="tasks" /><span className="browser-action-label">Tasks</span>{openTasks ? <span className="browser-count">{openTasks}</span> : null}</button><button type="button" className="secondary browser-header-wide" ref={detailsButton} aria-expanded={detailsOpen && paneTab === 'room'} aria-controls="browser-room-details" onClick={() => { if (detailsOpen && paneTab === 'room') closeDetails(); else openDetails(); }}><RoomIcon kind="people" /><span className="browser-action-label">Room details</span></button>{!source.isLocal && (appPaired && !desktopPairingActive
              ? <a className="secondary browser-open-app browser-header-wide" href={joinLink(location.origin, urlRoom)}>Open in Meshrooms</a>
              : <button type="button" className={`${desktopPairingActive ? "primary browser-app-hint" : "browser-text-link browser-app-hint"} browser-header-wide`} onClick={() => { setPendingDetailsTarget('desktop-pairing'); openDetails('you'); }}>{desktopPairingActive ? 'Finish desktop pairing' : 'Have the desktop app?'}</button>)}<button type="button" className="primary browser-header-invite" aria-haspopup="dialog" onClick={() => openInvite('person')} title="Invite a person or an agent"><RoomIcon kind="invite" /><span className="browser-action-label">Invite</span></button>
              <button type="button" className="secondary browser-header-more" ref={headerMore} aria-label="Room actions" aria-haspopup="menu" aria-expanded={headerMenuOpen} aria-controls="browser-header-menu" title="Room actions" onClick={() => setHeaderMenuOpen(open => !open)}><RoomIcon kind="more" />{(openDecisions || openTasks) ? <span className="browser-count">{(openDecisions || 0) + (openTasks || 0)}</span> : null}</button>
              {headerMenuOpen && <div className="browser-header-menu" id="browser-header-menu" role="menu">
                <button type="button" role="menuitem" aria-haspopup="dialog" onClick={() => openInvite('person')}><RoomIcon kind="invite" />Invite</button>
                {!source.isLocal && <button type="button" role="menuitem" aria-haspopup="dialog" onClick={() => openInvite('phone')}><RoomIcon kind="phone" />Connect your phone</button>}
                <button type="button" role="menuitem" aria-expanded={decisionsOpen} onClick={() => { setDecisionsOpen(!decisionsOpen); setBoardOpen(false); setDetailsOpen(false); setHeaderMenuOpen(false); }}><RoomIcon kind="vote" />Decisions{openDecisions ? <span className="browser-count">{openDecisions}</span> : null}</button>
                <button type="button" role="menuitem" aria-expanded={boardOpen} onClick={() => { setBoardOpen(!boardOpen); setDetailsOpen(false); setDecisionsOpen(false); setHeaderMenuOpen(false); }}><RoomIcon kind="tasks" />Tasks{openTasks ? <span className="browser-count">{openTasks}</span> : null}</button>
                <button type="button" role="menuitem" aria-expanded={detailsOpen && paneTab === 'room'} onClick={() => { if (detailsOpen && paneTab === 'room') closeDetails(); else openDetails(); setHeaderMenuOpen(false); }}><RoomIcon kind="people" />Room details</button>
                {!source.isLocal && (appPaired && !desktopPairingActive
                  ? <a role="menuitem" className="browser-open-app" href={joinLink(location.origin, urlRoom)}>Open in Meshrooms</a>
                  : <button type="button" role="menuitem" onClick={() => { setPendingDetailsTarget('desktop-pairing'); openDetails('you'); setHeaderMenuOpen(false); }}>{desktopPairingActive ? 'Finish desktop pairing' : 'Have the desktop app?'}</button>)}
              </div>}
            </div>
          </header>
          {admitted && agents.length > 0 && <section className="browser-agent-strip" aria-label="Agents in this room">
            {present.map(agent => {
              const a = activities.get(agent.id)!, wakes = wakeOf(agent);
              return <div className={`browser-agent-chip is-${a.state}`} key={agent.id} title={`${agent.name} · ${runtimeOf(agent) || 'agent'} · operated by ${operatorOf(agent)}${wakes ? ` · ${wakeLabel(wakes.room.binding)}` : ''}`}>
                <span className="browser-person-avatar"><MemberAvatar member={agent} roomId={urlRoom} fallback={agent.name} /><span className={`agent-dot is-${a.state}${a.state !== 'offline' && a.state !== 'online' && a.quiet !== undefined ? ' is-quiet' : ''}`} aria-hidden="true" /></span>
                <span className="browser-agent-chip-text"><strong>{agent.name}</strong>{activityLine(a)}</span></div>;
            })}
            {agents.length > present.length && <button className="browser-text-link browser-agent-strip-more" onClick={() => openDetails('members')}>{present.length ? `${agents.length - present.length} offline` : `${agents.length} agent${agents.length === 1 ? '' : 's'} offline`}</button>}
            {hasAgentMessages && <div className="browser-timeline-zoom" role="group" aria-label="Conversation view">
              <button type="button" aria-pressed={timelineZoom === 'focused'} title="Collapse multi-agent bursts into Response Stacks while keeping human messages, decisions, and action items visible" onClick={() => setTimelineZoom('focused')}>Humans &amp; Outcomes</button>
              <button type="button" aria-pressed={timelineZoom === 'full'} title="Show every agent reply and task update inline" onClick={() => setTimelineZoom('full')}>Full stream</button>
            </div>}
          </section>}
          {status.expiresAt !== undefined && status.expiresAt - Date.now() < EXPIRY_WARNING && <p role="status" className="browser-notice">This room will be removed on {new Date(status.expiresAt).toLocaleDateString(undefined, { dateStyle: 'long' })} if nobody opens it.</p>}
          {paused?.room && <p role="status" className="browser-notice browser-agents-paused">Agents paused after {AGENT_ROOM_LIMIT} agent messages. Mention an agent or reply to one to let them continue.</p>}
          {agentCtaShown &&
            <section className="browser-agent-cta" aria-label="Connect an agent"><div><strong>Bring your agent into this room</strong><p>Connect Claude Code, Codex or another agent. It joins as your agent, answers when someone addresses it, and you decide what it does.</p></div>
              <div className="browser-agent-cta-actions"><button className="primary" aria-haspopup="dialog" onClick={() => openInvite('agent')}>Connect an agent</button><button className="browser-text-link" onClick={dismissAgentCta}>Not now</button></div></section>}
          <p className="sr-only" role="status">{host && status.requests?.length ? `${status.requests.length} request${status.requests.length === 1 ? '' : 's'} waiting to join. Use the join requests section to admit or decline.` : ''}</p>
          {host && !!status.requests?.length && <section className="browser-requests" aria-label="Join requests"><h2>Waiting to join <span>{status.requests.length}</span></h2>
            {status.requests.map(r => <div className="browser-request" key={r.id}><div><strong>{r.linkedMemberId ? status.members!.find(m => m.id === r.linkedMemberId)?.name : r.name}</strong><span>{r.kind === 'person' ? 'New person' : r.kind === 'agent' ? `Agent · operated by ${status.members!.find(m => m.id === r.operatorId)?.name || 'a former member'}` : r.linkedMemberId ? 'Confirmed companion device' : phonePairingActive ? 'Asking to join as you. If it’s your phone, confirm in Invite › My phone' : 'Waiting for identity confirmation'} · {r.device.label} · <code className="browser-key-fingerprint" title={`Device key fingerprint: ${deviceFingerprint(r.device.id)}`}>Key {deviceFingerprint(r.device.id)}</code></span></div>
              <div className="browser-request-actions"><button disabled={busy} onClick={() => void act(async () => { await source.command('decide', urlRoom, { requestId: r.id, admit: false }); })}>Decline</button>
                <button className="browser-decline-block" disabled={busy} onClick={() => void act(async () => { await source.command('decide', urlRoom, { requestId: r.id, admit: false, block: true }); })}>Decline &amp; block</button>
                {(r.kind !== 'companion' || r.linkedMemberId) && <button className="primary" disabled={busy} onClick={() => void act(async () => { await source.command('decide', urlRoom, { requestId: r.id, admit: true }); })}>Admit</button>}</div></div>)}
          </section>}
          <p className="sr-only" aria-live="polite" aria-atomic="true">{liveMessage && <span key={liveMessage.id}>{liveMessage.text}</span>}</p>
          <div ref={workspace} className="browser-workspace" style={{ '--board-width': `${boardWidth}px` } as CSSProperties}>
            <div className={`browser-conversation ${dragging ? 'dragging' : ''}`}
              onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
              onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
              onDrop={e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
              {admitted && <AttentionStrip attention={attention} nameOf={nameOf}
                onMessage={id => { seeAttention([messageMark(id)]); showMessage(id); }}
                onDecision={d => showWork({ kind: 'decision', key: d.key })}
                onTask={task => { seeAttention([taskMark(task)]); showTask(task.id); }}
                onClear={() => seeAttention([...attention.messages.map(m => messageMark(m.id)), ...attention.decisions.map(decisionMark), ...attention.tasks.map(taskMark)])} />}
              {dragging && <div className="drop-overlay" aria-hidden="true"><RoomIcon kind="clip" /><strong>Drop to attach</strong><span>Screenshots and files up to {formatBytes(MAX_UPLOAD_BYTES)}</span></div>}
              <section ref={stick.ref} className="browser-transcript" role="log" aria-live="off" aria-label="Conversation" tabIndex={0} onScroll={() => {
                stick.onScroll();
                if (historyLoading.current) historyAnchor.current = captureHistory(historyAnchor.current?.focus);
              }}>
                <div className="browser-message-list"
                  onFocusCapture={e => {
                    const article = (e.target as HTMLElement | null)?.closest<HTMLElement>('article.browser-message[data-anchor-msg]');
                    setFocusedMessageId(article?.dataset.anchorMsg);
                  }}
                  onBlurCapture={e => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedMessageId(undefined);
                  }}>
                  {olderAvailable && <div className="browser-day"><button className="browser-text-link" disabled={busy || olderLoading || signInRequired} aria-busy={olderLoading} onClick={loadEarlier}>{olderLoading ? 'Loading earlier messages…' : 'Show earlier messages'}</button></div>}
                  {historyMeta.hasVisibleGaps && <p className="browser-history-gap" role="status">Some earlier messages aren’t available on this device.</p>}
                  {!messages.length && <div className="browser-empty"><RoomIcon kind="chat" /><h2>{status.members!.length > 1 ? 'Ready for your first message' : status.requests?.length ? 'Your conversation starts here' : 'Bring someone into the room'}</h2><p>{status.members!.length > 1 ? 'Send a message below to start the conversation.' : status.requests?.length ? 'Someone is waiting to join. Admit them above to get started.' : 'Invite a person, or connect an agent of yours.'}</p>
                    {admitted && status.members!.length === 1 && !status.requests?.length && <div className="browser-empty-actions"><button type="button" className="primary" aria-haspopup="dialog" onClick={() => openInvite('person')}><RoomIcon kind="invite" />Invite a person</button>{!agentCtaShown && <button type="button" className="secondary" aria-haspopup="dialog" onClick={() => openInvite('agent')}>Connect an agent</button>}</div>}
                    {host && notifySupported && !hostNotifyEnabled && notifyPermission !== 'denied' && <button type="button" className="browser-text-link" onClick={() => void toggleHostNotifications(true)}>Notify me when someone asks to join</button>}</div>}
                  {(() => {
                    const renderMessage = (m: SavedMessage, prevMessage: SavedMessage | undefined, nextMessage: SavedMessage | undefined) => {
                      const body = m.packet.body;
                      const msgKey = messageKey(body.deviceId, body.id);
                      const isCanonical = canonicalKeys.get(body.id) === msgKey;
                      const member = status.members!.find(p => p.id === body.memberId);
                      const author = member?.name || 'Former member';
                      const replied = body.replyTo ? canonicalById.get(body.replyTo) : undefined, target = replied?.packet.body;
                      const gone = !!m.retracted, mine = body.memberId === status.memberId;
                      const continuation = grouped(prevMessage, m);
                      const own = body.deviceId === status.deviceId;
                      const equivocating = historyMeta.equivocatingDevices.has(body.deviceId);
                      const idCollision = historyMeta.collidingMessageIds.has(body.id);
                      const showReceipt = own && !gone && (!nextMessage || !grouped(m, nextMessage) || m.receipts.length < m.targets.length);
                      const forYou = body.memberId !== status.memberId && (mentionedIds(body.text, participants).includes(status.memberId!) || target?.memberId === status.memberId);
                      const operator = operatorOf(member);
                      const shown = shownText(body), quoted = target && (replied?.retracted ? 'a deleted message' : shownText(target) || fileNames(target));
                      // Bind bare-ID reaction chips only to the canonical (first-seen) message copy so colliding copies never mirror or hijack reactions.
                      const chips = gone || !isCanonical ? [] : reactions.filter(r => r.messageId === body.id);
                      const picking = reactPicker === msgKey;
                      const addReaction = admitted && !gone && isCanonical && <div className={`browser-reaction-add ${chips.length ? '' : 'browser-reaction-add-header'}`}>
                        <button type="button" className="browser-reaction-picker-toggle" disabled={busy} aria-expanded={picking} aria-label={`Add a reaction to ${own ? 'your' : `${author}’s`} message`}
                          title="Add a reaction" onClick={() => setReactPicker(picking ? undefined : msgKey)}><ReactionIcon /></button>
                        {picking && <div className="browser-reaction-picker" role="listbox" aria-label="Reaction emoji">
                          {REACTION_EMOJI.map(emoji => <button key={emoji} type="button" role="option" disabled={busy}
                            aria-label={emoji} onClick={() => void act(async () => {
                              if (!peers.current) throw new Error('Room connection is not ready.');
                              await peers.current.react(body.id, emoji as ReactionEmoji);
                              setReactPicker(undefined);
                            })}>{emoji}</button>)}
                        </div>}
                      </div>;
                      return <article id={isCanonical ? `message-${body.id}` : `message-${body.deviceId.slice(0, 12)}-${body.id}`} data-anchor-msg={body.id} className={`browser-message ${highlight === body.id && isCanonical ? 'browser-message-highlight' : ''} ${continuation ? 'browser-message-continuation' : ''} ${forYou ? 'browser-message-for-you' : ''} ${isAgent(member) ? 'browser-message-agent' : ''}`}>
                        <MemberAvatar member={member} roomId={urlRoom} fallback={author} />
                        <div><header className={continuation ? 'browser-continuation-header' : ''}><strong>{author}</strong>{isAgent(member) && <span className="browser-role" title={runtimeOf(member) ? `${runtimeOf(member)} (reported by the agent)` : 'Agent'}>agent</span>}{operator && <span className="browser-operator">for {operator}</span>}{body.memberId === status.memberId && <span className="browser-author-you">you</span>}<time dateTime={new Date(body.at).toISOString()}>{new Date(body.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                          {!gone && isCanonical && <button className="browser-reply-button" aria-label={`Reply to ${own ? 'your' : `${author}’s`} message`} title="Reply" onClick={() => startReply(body.id)}>Reply</button>}
                          {mine && !gone && admitted && <button className="browser-reply-button browser-delete-button" aria-label="Delete your message" aria-expanded={confirmDelete === msgKey} title="Delete" onClick={() => setConfirmDelete(confirmDelete === msgKey ? undefined : msgKey)}>Delete</button>}{!chips.length && addReaction}</header>
                          {body.replyTo && <p className="browser-reply-reference">{target ? <>Replying to <strong>{nameOf(target.memberId)}</strong>: {quoted!.length > 120 ? `${quoted!.slice(0, 120)}…` : quoted}</> : 'Replying to an earlier message'}</p>}
                          {equivocating && <p className="browser-equivocation-warning" role="alert">Warning: this device signed conflicting messages for the same sequence number.</p>}
                          {idCollision && <p className="browser-equivocation-warning" role="alert">Warning: another device also signed a message with this ID.</p>}
                          {gone ? <p className="browser-message-deleted">Message deleted</p> : shown && <div className="message-text"><MentionText text={shown} participants={participants} viewerId={status.memberId} repositories={pinned} /></div>}
                          {confirmDelete === msgKey && !gone && <div className="browser-delete-confirm" role="group" aria-label="Delete this message" onKeyDown={e => { if (e.key === 'Escape') setConfirmDelete(undefined); }}>
                            <p>Delete this for everyone? Anyone who already saw it may still have a copy.</p>
                            <button type="button" className="secondary" autoFocus onClick={() => setConfirmDelete(undefined)}>Keep</button>
                            <button type="button" className="browser-delete-confirm-action" disabled={busy} onClick={() => void act(async () => { if (!peers.current) throw new Error('Room connection is not ready.'); await peers.current.retract(body.id); setConfirmDelete(undefined); })}>Delete</button>
                          </div>}
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
                          {showReceipt && <span className="browser-receipt">{m.targets.length ? `Stored on ${m.receipts.length} of ${m.targets.length} devices` : source.isLocal ? 'Saved on this computer' : 'Saved in this browser'}</span>}
                          {answering.has(body.id) && <p className="browser-claim-note">{answering.get(body.id)} is answering. The other agents leave this one to them.</p>}
                          {paused?.threads.has(body.id) && <p className="browser-paused-note">Agents paused in this thread after {AGENT_CHAIN_LIMIT} agent messages. A reply from a person lets them continue.</p>}
                        </div>
                      </article>;
                    };

                    const renderTaskEvent = (event: TaskEvent) => {
                      const line = describeTask(event, (id, subject) => id === status.memberId ? subject ? 'You' : 'you' : nameOf(id));
                      const time = <time dateTime={new Date(Math.min(event.at, MAX_TIME)).toISOString()}>{new Date(Math.min(event.at, MAX_TIME)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>;
                      return <p key={event.id} className="browser-task-line">
                        {tasks.some(t => t.id === event.taskId) ? <button title="Open this task" onClick={() => showTask(event.taskId)}>{line}</button> : <span>{line}</span>}{time}</p>;
                    };

                    return streamEntries.map((entry, index) => {
                      const previous = streamEntries[index - 1], at = entry.at;
                      const day = (!index || !sameDay(previous.at, at)) && <div className="browser-day"><span>{dayLabel(at)}</span></div>;

                      if (entry.kind === 'events-fold') {
                        const open = expandedEvents.has(entry.id);
                        return <Fragment key={entry.id}>{day}
                          <div className="browser-events-fold">
                            <button type="button" className="browser-events-fold-toggle" aria-expanded={open} onClick={() => toggleEventsFold(entry.id)}>
                              <span>{entry.events.length} task updates</span>
                              <span className="browser-events-fold-action">{open ? 'Hide' : 'Show'}</span>
                            </button>
                            {open && <div className="browser-events-fold-list">{entry.events.map(renderTaskEvent)}</div>}
                          </div>
                        </Fragment>;
                      }

                      if (entry.kind === 'stack') {
                        const expanded = expandedStacks.has(entry.id) || stackHasInteraction(entry);
                        const liveCount = entry.messages.filter(m => !m.retracted).length;
                        const namesSummary = entry.authors.length <= 3
                          ? entry.authors.map(a => a.name).join(', ')
                          : `${entry.authors.slice(0, 3).map(a => a.name).join(', ')} +${entry.authors.length - 3}`;
                        const timeLabel = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        const stackMsgIds = entry.messages.map(m => m.packet.body.id).join(' ');
                        return <Fragment key={entry.id}>{day}
                          <section data-stack-msgs={stackMsgIds} className={`browser-stack ${expanded ? 'is-expanded' : ''} ${entry.hasUnreadForYou ? 'is-for-you' : ''}`} aria-label={`${liveCount} agent replies from ${namesSummary}`}>
                            <header className="browser-stack-header">
                              <div className="browser-stack-avatars" aria-hidden="true">
                                {entry.authors.slice(0, 4).map(a => (
                                  <MemberAvatar key={a.memberId} member={status.members!.find(m => m.id === a.memberId)} roomId={urlRoom} fallback={a.name} />
                                ))}
                              </div>
                              <div className="browser-stack-meta">
                                <strong>{liveCount} agent replies</strong>
                                <span>{namesSummary}{entry.attachmentCount ? ` · ${entry.attachmentCount} file${entry.attachmentCount === 1 ? '' : 's'}` : ''} · <time dateTime={new Date(entry.at).toISOString()}>{timeLabel}</time></span>
                              </div>
                              <button type="button" className="secondary browser-stack-toggle" aria-expanded={expanded} onClick={() => toggleStack(entry.id)}>
                                {expanded ? 'Hide replies' : 'Show replies'}
                              </button>
                            </header>
                            {!expanded && <div className="browser-stack-authors" role="group" aria-label="Jump to an agent reply">
                              {entry.authors.map(a => {
                                const firstMsg = entry.messages.find(m => !m.retracted && m.packet.body.memberId === a.memberId);
                                if (!firstMsg) return null;
                                return <button key={a.memberId} type="button" className="browser-stack-author-chip" title={messagePreview(firstMsg)} onClick={() => openStackMessage(entry.id, firstMsg.packet.body.id)}>
                                  <strong>{a.name}</strong><span>{messagePreview(firstMsg, 64)}</span>
                                </button>;
                              })}
                            </div>}
                            {entry.pinnedActions.length > 0 && <ul className="browser-stack-pins" aria-label="Highlighted agent messages">
                              {entry.pinnedActions.map(pin => (
                                <li key={`${pin.message.packet.body.id}:${pin.kind}`} className={`browser-stack-pin is-${pin.kind}`}>
                                  <span className="browser-stack-pin-badge">Agent · {pin.label}</span>
                                  <span className="browser-stack-pin-text"><strong>{pin.authorName}:</strong> {pin.snippet}</span>
                                  <button type="button" className="browser-link-button" aria-label={`Open ${pin.authorName}’s message`} onClick={() => openStackMessage(entry.id, pin.message.packet.body.id)}>Open</button>
                                </li>
                              ))}
                              {entry.hiddenPinnedCount > 0 && !expanded && <li className="browser-stack-pin-more">
                                <button type="button" className="browser-link-button" onClick={() => toggleStack(entry.id)}>
                                  +{entry.hiddenPinnedCount} more agent note{entry.hiddenPinnedCount === 1 ? '' : 's'} · Show replies
                                </button>
                              </li>}
                            </ul>}
                            {expanded && <div className="browser-stack-messages">
                              {entry.messages.map((m, i) => (
                                <Fragment key={`${m.packet.body.deviceId}:${m.packet.body.id}`}>
                                  {renderMessage(m, entry.messages[i - 1], entry.messages[i + 1])}
                                </Fragment>
                              ))}
                            </div>}
                          </section>
                        </Fragment>;
                      }

                      const item = entry.item;
                      if (item.decision) {
                        const d = item.decision;
                        return <Fragment key={`decision-${d.key}`}>{day}<DecisionCard decision={d} viewerId={status.memberId} ownerId={status.ownerId} members={status.members!} participants={participants} now={now}
                          highlight={highlight === d.key} nameOf={id => id === status.memberId ? 'You' : nameOf(id)}
                          avatar={id => <MemberAvatar member={status.members!.find(m => m.id === id)} roomId={urlRoom} fallback={nameOf(id)} />}
                          onVote={(optionId, comment) => peers.current!.vote(d, optionId, comment)} onAddOption={label => peers.current!.reviseDecision(d, { addOption: label })}
                          onClose={() => peers.current!.reviseDecision(d, { close: true })} onWithdraw={() => peers.current!.reviseDecision(d, { withdraw: true })}
                          onTasks={taskFromDecision(d, tasks, decisions) ? undefined : () => void decisionTask(d)} /></Fragment>;
                      }
                      if (item.rename) {
                        const rename = item.rename, time = <time dateTime={new Date(Math.min(at, MAX_TIME)).toISOString()}>{new Date(Math.min(at, MAX_TIME)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>;
                        return <Fragment key={`rename-${rename.id}`}>{day}<p className="browser-task-line browser-rename-line"><span>{renameLine(rename, status.memberId, id => status.members!.find(m => m.id === id)?.name)}</span>{time}</p></Fragment>;
                      }
                      if (item.event) {
                        return <Fragment key={item.event.id}>{day}{renderTaskEvent(item.event)}</Fragment>;
                      }
                      const prevMsg = previous?.kind === 'item' ? previous.item.message : undefined;
                      const nextEntry = streamEntries[index + 1];
                      const nextMsg = nextEntry?.kind === 'item' ? nextEntry.item.message : undefined;
                      return <Fragment key={`${item.message.packet.body.deviceId}:${item.message.packet.body.id}`}>
                        {day}
                        {renderMessage(item.message, prevMsg, nextMsg)}
                      </Fragment>;
                    });
                  })()}
                </div>
              </section>
              <div className="browser-compose-area">
                {stick.unread > 0 && <button className="secondary browser-unread" onClick={stick.toBottom}>{stick.unread === 1 ? 'New message' : `${stick.unread} new messages`} <span aria-hidden="true">↓</span></button>}
                {deciding && <DecisionForm agents={agents.length} onCancel={() => setDeciding(false)}
                  onSubmit={async draft => { await peers.current!.openDecision(draft); setDeciding(false); stick.toBottom(); }} />}
                {replyId && <div className="browser-reply-draft"><span>Replying to <strong>{reply ? reply.packet.body.memberId === status.memberId ? 'your message' : nameOf(reply.packet.body.memberId) : 'an earlier message'}</strong></span><button className="browser-close" aria-label="Cancel reply" onClick={() => setReplyId(undefined)}><RoomIcon kind="close" /></button></div>}
                <form className="browser-composer" onSubmit={send}>{mentions.list}<label className="sr-only" htmlFor="browser-message">Message {title}</label><textarea ref={composer} id="browser-message" value={text} {...mentions.inputProps}
                  onChange={e => { setText(e.target.value); mentions.track(e.target.value, e.target.selectionStart); }} onSelect={e => mentions.track(e.currentTarget.value, e.currentTarget.selectionStart)} onBlur={mentions.close}
                  onPaste={e => { const pasted = [...e.clipboardData.files]; if (pasted.length) { e.preventDefault(); addFiles(pasted); } }}
                  onKeyDown={e => { if (mentions.onKeyDown(e)) return; if (e.key === 'Escape' && replyId) { setReplyId(undefined); return; } if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && !touchComposer.current) { e.preventDefault(); send(e); } }}
                  maxLength={4000} rows={narrowPane ? 1 : 2} placeholder={agents.length ? (narrowPane ? 'Message… @ for agents' : `Message ${title} · type @ to ask an agent`) : (narrowPane ? 'Message…' : `Message ${title}`)} />
                  <PendingFiles files={chosen} onRemove={removeFile} onRetry={key => { const item = chosen.find(f => f.key === key); if (item) prepareFile(item); }} />
                  <span className="browser-compose-tools" ref={composeTools}><input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
                    <button type="button" className="secondary browser-compose-add" aria-label="Attach or decide" aria-haspopup="menu" aria-expanded={toolsOpen} aria-controls="browser-compose-menu" title="Attach or decide" onClick={() => setToolsOpen(open => !open)}><RoomIcon kind="plus" /></button>
                    {toolsOpen && <div className="browser-compose-menu" id="browser-compose-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { fileInput.current?.click(); setToolsOpen(false); }}><RoomIcon kind="clip" />Attach</button>
                      <button type="button" role="menuitem" aria-expanded={deciding} onClick={() => { setDeciding(current => !current); setToolsOpen(false); }}><RoomIcon kind="vote" />Decide</button>
                    </div>}
                    <button type="button" className="secondary browser-attach" title="Attach screenshots or files (you can also paste or drop them)" onClick={() => fileInput.current?.click()}><RoomIcon kind="clip" /><span className="browser-action-label">Attach</span></button>
                    <button type="button" className="secondary browser-attach" aria-expanded={deciding} title="Ask the room to decide between options, or to review a plan" onClick={() => setDeciding(!deciding)}><RoomIcon kind="vote" /><span className="browser-action-label">Decide</span></button>
                    <span className="browser-key-hint browser-key-hint-keyboard">Enter to send · Shift + Enter for a new line</span>
                    <span className="browser-key-hint browser-key-hint-touch">Enter for a new line</span></span>
                  <button type="submit" className="primary browser-send" disabled={!canSend} aria-busy={sending} title={sending ? 'Sending…' : 'Send'}><span className="browser-send-label">{sending ? 'Sending…' : 'Send'}</span><RoomIcon kind="send" /></button></form>
                {settings.historyForNewcomers && <p className="browser-history-disclosure">New members will see this</p>}
                {draftProblem ? <p className="browser-draft-problem" role="status">Draft changes could not be saved in this tab. Keep this page open or copy your text before leaving.</p>
                  : !sending && (text || replyId || chosen.length > 0) ? <p className="browser-draft-saved">{text || replyId ? 'Draft saved in this tab.' : ''}{chosen.length > 0 ? ' Unsent files stay here while this page is open.' : ''}</p> : null}
                <p className={`browser-connection ${upgradeRequired || connectionProblem ? 'is-alert' : 'is-quiet'}`} role="status" title={connectionLabel}><span className={`browser-connection-dot ${!upgradeRequired && !connectionProblem && connected.length ? 'is-connected' : ''}`} aria-hidden="true" /><span className="browser-connection-text">{connectionLabel}</span></p>
              </div>
            </div>
            {boardOpen && <BoardHandle workspace={workspace} width={boardWidth} onCommit={width => { setBoardWidth(width ?? BOARD_DEFAULT); saveBoardWidth(width); }} />}
            {decisionsOpen && <DecisionList decisions={decisions} onShow={showDecision} onClose={() => setDecisionsOpen(false)} />}
            {boardOpen && <TaskBoard room={boardRoom} viewerId={status.memberId} disabled={!admitted} onClose={() => setBoardOpen(false)} actions={boardActions} highlight={highlight} working={workingOn} repositories={pinned} />}
            <aside id="browser-room-details" className={`browser-details browser-details-tabbed is-${paneTab}`} aria-label={paneTab === 'work' ? 'This work' : 'Room details'} hidden={!detailsOpen} onKeyDown={e => {
              if (e.key !== 'Escape') return;
              if (memberMenu) { const openId = memberMenu; e.stopPropagation(); setMemberMenu(undefined); focusMemberMenuButton(openId); }
              else closeDetails();
            }}>
              <input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden onChange={e => { uploadAvatar(e.target.files?.[0]); e.target.value = ''; }} />
              <div className="browser-details-sticky">
                <header className="browser-details-heading">
                  <h2 tabIndex={-1} ref={detailsHeading} className="sr-only">{paneTab === 'work' ? 'This work' : 'Room details'}</h2>
                  <div className="browser-pane-switch" role="tablist" aria-label="Side panel" data-tab={paneTab} onKeyDown={e => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                    e.preventDefault();
                    const next = e.key === 'Home' ? 'work' : e.key === 'End' ? 'room' : paneTab === 'work' ? 'room' : 'work';
                    setPaneTab(next); setMemberMenu(undefined);
                    requestAnimationFrame(() => document.getElementById(`pane-tab-${next}`)?.focus());
                  }}>
                    <span className="browser-pane-glider" aria-hidden="true" />
                    {(['work', 'room'] as const).map(tab => <button key={tab} type="button" role="tab" id={`pane-tab-${tab}`} aria-selected={paneTab === tab}
                      aria-controls={tab === 'work' ? 'pane-panel-work' : `details-panel-${detailsTab}`} tabIndex={paneTab === tab ? 0 : -1}
                      onClick={() => { setPaneTab(tab); setMemberMenu(undefined); }}>{tab === 'work' ? 'This work' : 'Room details'}</button>)}
                  </div>
                  <div className="browser-details-head-actions">
                    {paneTab === 'room' && <button type="button" className="primary browser-details-invite-btn" aria-haspopup="dialog" onClick={() => openInvite('person')}>+ Invite</button>}
                    <button type="button" className="browser-close" aria-label={paneTab === 'work' ? 'Close this work' : 'Close room details'} onClick={closeDetails}><RoomIcon kind="close" /></button>
                  </div>
                </header>
                {paneTab === 'room' && <div className="browser-details-tabs" role="tablist" aria-label="Room details sections" onKeyDown={e => {
                  const idx = DETAILS_TABS.findIndex(t => t.id === detailsTab);
                  let next: DetailsTab | undefined;
                  if (e.key === 'ArrowRight') next = DETAILS_TABS[(idx + 1) % DETAILS_TABS.length].id;
                  else if (e.key === 'ArrowLeft') next = DETAILS_TABS[(idx - 1 + DETAILS_TABS.length) % DETAILS_TABS.length].id;
                  else if (e.key === 'Home') next = DETAILS_TABS[0].id;
                  else if (e.key === 'End') next = DETAILS_TABS[DETAILS_TABS.length - 1].id;
                  if (!next) return;
                  e.preventDefault();
                  setDetailsTab(next);
                  setMemberMenu(undefined);
                  requestAnimationFrame(() => document.getElementById(`details-tab-${next}`)?.focus());
                }}>
                  {DETAILS_TABS.map(tab => {
                    return <button key={tab.id} type="button" role="tab" id={`details-tab-${tab.id}`} aria-selected={detailsTab === tab.id} aria-controls={`details-panel-${tab.id}`}
                      tabIndex={detailsTab === tab.id ? 0 : -1} className={detailsTab === tab.id ? 'is-active' : undefined}
                      onClick={() => { setDetailsTab(tab.id); setMemberMenu(undefined); }}>
                      {tab.label}
                    </button>;
                  })}
                </div>}
              </div>

              <div className="browser-details-body">
                <div role="tabpanel" id="pane-panel-work" aria-labelledby="pane-tab-work" hidden={paneTab !== 'work'}>
                  {workShown && <WorkPane work={resolveWork(selectedWork, tasks, decisions)} list={roomWork} tasks={tasks} decisions={decisions} events={timeline}
                    viewerId={status.memberId} viewerIsPerson={participants.find(p => p.id === status.memberId)?.role === 'human'} now={now} disabled={!admitted}
                    nameOf={id => id === status.memberId ? 'You' : nameOf(id)}
                    avatar={id => <MemberAvatar member={status.members!.find(m => m.id === id)} roomId={urlRoom} fallback={nameOf(id)} />}
                    describe={event => describeTask(event, (id, subject) => id === status.memberId ? subject ? 'You' : 'you' : nameOf(id), true)}
                    renderDecision={(d, made) => <DecisionCard decision={d} idBase="work-decision" viewerId={status.memberId} ownerId={status.ownerId} members={status.members!} participants={participants} now={now}
                      nameOf={id => id === status.memberId ? 'You' : nameOf(id)}
                      avatar={id => <MemberAvatar member={status.members!.find(m => m.id === id)} roomId={urlRoom} fallback={nameOf(id)} />}
                      onVote={(optionId, comment) => peers.current!.vote(d, optionId, comment)} onAddOption={label => peers.current!.reviseDecision(d, { addOption: label })}
                      onClose={() => peers.current!.reviseDecision(d, { close: true })} onWithdraw={() => peers.current!.reviseDecision(d, { withdraw: true })}
                      onTasks={made ? undefined : () => void decisionTask(d)} />}
                    onSelect={setSelectedWork}
                    onStatus={(task, next) => boardActions.update(task, { status: next })}
                    onShowOnBoard={showOnBoard}
                    onShowInConversation={key => { uncoverConversation(); requestAnimationFrame(() => showDecision(key)); }}
                    onOpenBoard={() => { setBoardOpen(true); setDetailsOpen(false); setDecisionsOpen(false); }} />}
                </div>
                <div role="tabpanel" id="details-panel-members" aria-labelledby="details-tab-members" hidden={paneTab !== 'room' || detailsTab !== 'members'}>
                  <div className="browser-people">
                    <section aria-label="People in this room" className="browser-roster-group">
                      <h3>People <span>{sortedPeople.length}</span></h3>
                      <div className="browser-member-list">
                        {sortedPeople.map(member => {
                          const devices = status.devices!.filter(d => d.memberId === member.id).length;
                          const removable = member.id !== status.memberId && host && member.id !== status.ownerId;
                          const transferable = host && member.id !== status.memberId;
                          const hasActions = removable || transferable || (!!member.avatar && member.id !== status.memberId && host);
                          const menuOpen = memberMenu === member.id;
                          return <div className="browser-person" key={member.id}>
                            <span className="browser-person-avatar"><MemberAvatar member={member} roomId={urlRoom} fallback={member.name} /></span>
                            <div className="browser-person-main">
                              <div className="browser-person-row">
                                <div className="browser-person-title">
                                  <strong title={member.name}>{member.name}{member.id === status.memberId ? ' (you)' : ''}</strong>
                                  {member.id === status.ownerId && <span className="browser-member-badge is-host">Host</span>}
                                </div>
                                <span className="browser-person-state">{`${devices} device${devices === 1 ? '' : 's'}`}</span>
                                {hasActions && <div className="browser-member-menu-wrap">
                                  <button type="button" id={`member-menu-btn-${member.id}`} className="browser-member-menu-btn" aria-label={`Actions for ${member.name}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? `member-menu-${member.id}` : undefined}
                                    onClick={() => menuOpen ? setMemberMenu(undefined) : openMemberMenu(member.id, 'first')}
                                    onKeyDown={e => {
                                      if (e.key === 'ArrowDown') { e.preventDefault(); openMemberMenu(member.id, 'first'); }
                                      else if (e.key === 'ArrowUp') { e.preventDefault(); openMemberMenu(member.id, 'last'); }
                                    }}><RoomIcon kind="more" /></button>
                                  {menuOpen && <div id={`member-menu-${member.id}`} className="browser-member-menu" role="menu" aria-label={`Actions for ${member.name}`} onKeyDown={e => handleMemberMenuKeyDown(e, member.id)}>
                                    {transferable && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMemberMenu(undefined); setConfirming(`transfer:${member.id}`); }}>Make host</button>}
                                    {member.avatar && member.id !== status.memberId && host && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMemberMenu(undefined); clearAvatar(member.id); focusMemberMenuButton(member.id); }}>Remove picture</button>}
                                    {removable && <button type="button" role="menuitem" className="is-danger" disabled={busy} onClick={() => { setMemberMenu(undefined); setConfirming(member.id); }}>Remove</button>}
                                  </div>}
                                </div>}
                                {!hasActions && <span className="browser-member-menu-slot" aria-hidden="true" />}
                              </div>
                              {removable && confirming === member.id && confirmRemove(member, () => focusMemberMenuButton(member.id))}
                              {transferable && confirming === `transfer:${member.id}` && confirmTransfer(member, () => focusMemberMenuButton(member.id))}
                            </div>
                          </div>;
                        })}
                      </div>
                    </section>

                    <section aria-label="Agents in this room" className="browser-roster-group">
                      <h3>Agents <span>{sortedAgents.length}</span></h3>
                      {sortedAgents.length === 0 ? <p className="browser-details-empty">{source.agents ? 'No agents in this room yet.' : <>No agents connected yet. <button type="button" className="browser-link-button" onClick={() => openInvite('agent')}>Connect an agent</button></>}</p> : (
                        <div className="browser-member-list">
                          {sortedAgents.map(member => {
                            const removable = host || member.operatorId === status.memberId;
                            const operatesIt = member.operatorId === status.memberId;
                            const renameable = canRenameAgent(member, self, status.ownerId);
                            const a = activities.get(member.id), wakes = wakeOf(member);
                            const hasActions = removable || operatesIt || renameable || (!!member.avatar && (operatesIt || host));
                            const menuOpen = memberMenu === member.id;
                            return <div className="browser-person" key={member.id}>
                              <span className="browser-person-avatar"><MemberAvatar member={member} roomId={urlRoom} fallback={member.name} />{a && <span className={`agent-dot is-${a.state}${a.state !== 'offline' && a.state !== 'online' && a.quiet !== undefined ? ' is-quiet' : ''}`} aria-hidden="true" />}</span>
                              <div className="browser-person-main">
                                <div className="browser-person-row">
                                  <div className="browser-person-title">
                                    <strong title={member.name}>{member.name}</strong>
                                  </div>
                                  {a && rosterState(a)}
                                  {hasActions && <div className="browser-member-menu-wrap">
                                    <button type="button" id={`member-menu-btn-${member.id}`} className="browser-member-menu-btn" aria-label={`Actions for ${member.name}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? `member-menu-${member.id}` : undefined}
                                      onClick={() => menuOpen ? setMemberMenu(undefined) : openMemberMenu(member.id, 'first')}
                                      onKeyDown={e => {
                                        if (e.key === 'ArrowDown') { e.preventDefault(); openMemberMenu(member.id, 'first'); }
                                        else if (e.key === 'ArrowUp') { e.preventDefault(); openMemberMenu(member.id, 'last'); }
                                      }}><RoomIcon kind="more" /></button>
                                    {menuOpen && <div id={`member-menu-${member.id}`} className="browser-member-menu" role="menu" aria-label={`Actions for ${member.name}`} onKeyDown={e => handleMemberMenuKeyDown(e, member.id)}>
                                      {renameable && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMemberMenu(undefined); setRenamingAgent(member.id); }}>Rename</button>}
                                      {operatesIt && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMemberMenu(undefined); focusMemberMenuButton(member.id); pickAvatar(member.id); }}>{member.avatar ? 'Change picture' : 'Set picture'}</button>}
                                      {member.avatar && (operatesIt || host) && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMemberMenu(undefined); clearAvatar(member.id); focusMemberMenuButton(member.id); }}>Remove picture</button>}
                                      {removable && <button type="button" role="menuitem" className="is-danger" disabled={busy} onClick={() => { setMemberMenu(undefined); setConfirming(member.id); }}>Remove agent</button>}
                                    </div>}
                                  </div>}
                                  {!hasActions && <span className="browser-member-menu-slot" aria-hidden="true" />}
                                </div>
                                <span className="browser-person-meta" title={`${runtimeOf(member) || 'Runtime settings not reported'} (reported by the agent) · operated by ${operatorOf(member)}`}>
                                  {runtimeOf(member) || 'Runtime not reported'} · by {operatorOf(member)}</span>
                                {a && rosterDetail(a)}
                                {a && a.state !== 'offline' && a.state !== 'online' && a.note && <span className="browser-person-detail agent-activity-note" title={a.note}>{a.note}</span>}
                                {wakes && <span className="agent-wakes">{wakeLabel(wakes.room.binding)} · <button type="button" className="browser-link-button" onClick={() => setAgentFocus({ id: wakes.agent.id, at: Date.now() })}>Sessions</button></span>}
                                {renamingAgent === member.id && renameable && <AgentRename member={member} members={status.members!} reserved={(status.agentInvites ?? []).map(i => i.name)} disabled={busy} startOpen
                                  onClose={() => { setRenamingAgent(undefined); focusMemberMenuButton(member.id); }}
                                  onRename={async name => { await source.command('rename', urlRoom, { memberId: member.id, name }); setNotice(`Renamed ${member.name} to ${cleanDisplayName(name)}.`); }} />}
                                {removable && confirming === member.id && confirmRemove(member, () => focusMemberMenuButton(member.id))}
                              </div>
                            </div>;
                          })}
                        </div>
                      )}
                    </section>
                  </div>

                  {!isAgent(self) && source.agents && <LocalAgentsSection api={source.agents} state={localAgents} roomId={urlRoom} selfName={self?.name} focus={agentFocus} />}
                </div>

                <div role="tabpanel" id="details-panel-shared" aria-labelledby="details-tab-shared" hidden={paneTab !== 'room' || detailsTab !== 'shared'}>
                  <section className="browser-shared-files" aria-label="Shared files">
                    <h3>Shared files {sharedFiles.length > 0 && <span>{sharedFiles.length}</span>}</h3>
                    {sharedFiles.length === 0 ? <p>Files and screenshots shared in this room appear here.</p> : (
                      <ul className="browser-shared-file-list">
                        {sharedFiles.slice(0, 40).map(item => {
                          const view = files[item.ref.sha256];
                          const isImg = !!view?.url && displayKind(item.ref, view.type) === 'image';
                          const ext = item.ref.name.includes('.') ? item.ref.name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE';
                          return <li key={item.ref.sha256} className="browser-shared-file">
                            {isImg ? <img className="browser-shared-file-thumb" src={view.url} alt="" /> : <span className="browser-shared-file-badge" aria-hidden="true">{ext}</span>}
                            <div className="browser-shared-file-meta">
                              <strong title={item.ref.name}>{item.ref.name}</strong>
                              <span>{formatBytes(item.ref.size)} · {item.authorName}</span>
                            </div>
                            <button type="button" className="browser-link-button" onClick={() => showMessage(item.messageId)}>Show</button>
                          </li>;
                        })}
                      </ul>
                    )}
                  </section>

                  <section className="browser-repositories" aria-labelledby="browser-repositories-title">
                    <h3 id="browser-repositories-title">Repositories {pinned.length > 0 && <span>{pinned.length}</span>}</h3>
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
                </div>

                <div role="tabpanel" id="details-panel-rules" aria-labelledby="details-tab-rules" hidden={paneTab !== 'room' || detailsTab !== 'rules'}>
                  <section className="browser-settings" aria-label="Room settings">
                    <h3>Room settings</h3>
                    {host ? <>
                      <FloorControl floor={settings.floor} disabled={busy} onChange={floor => changeSettings({ floor }, floor === 'humans-first' ? 'Only people wake agents now.' : floor === 'people-and-agents' ? 'People and agents now wake the agents they @mention or reply to.' : 'Agents may now reply to every message from a person.')} />
                      <label className="browser-setting"><input type="checkbox" checked={settings.agentAssignmentsWake} disabled={busy} onChange={e => changeSettings({ agentAssignmentsWake: e.target.checked }, e.target.checked ? 'Agents can now hand tasks to each other.' : 'Only people’s assignments wake agents now.')} /><span><strong>Agents can hand tasks to each other</strong>A task one agent assigns to another wakes it, as a person’s assignment does.</span></label>
                      <label className="browser-setting"><input type="checkbox" checked={settings.guestAgentApproval} disabled={busy} onChange={e => changeSettings({ guestAgentApproval: e.target.checked }, e.target.checked ? 'Guests’ agents now wait for your approval.' : 'Guests’ agents now join right away.')} /><span><strong>Approve guests’ agents</strong>Agents connected by other people wait for you to admit them. Your own agents join right away.</span></label>
                      <label className="browser-setting"><input type="checkbox" checked={settings.hostApprovesDevices} disabled={busy} onChange={e => changeSettings({ hostApprovesDevices: e.target.checked }, e.target.checked ? 'New devices now wait for your approval.' : 'People now add their own devices.')} /><span><strong>Approve new devices</strong>A device someone links to themselves waits for you to admit it. Off: their own confirmation admits it.</span></label>
                      <label className="browser-setting"><input type="checkbox" checked={settings.historyForNewcomers} disabled={busy} onChange={e => changeSettings({ historyForNewcomers: e.target.checked }, e.target.checked ? 'New members can read messages sent from now on.' : 'New messages will only be shared with current members.')} /><span><strong>History for newcomers</strong>New members and agents admitted later can read messages sent from now on. Turning this off only applies to future messages; people who already saw a message may still keep a copy.</span></label>
                    </> : <ul className="browser-settings-summary">
                      <li>{settings.floor === 'humans-first' ? 'Only people wake agents: an @mention, a reply or an assigned task.' : settings.floor === 'people-and-agents' ? `People and agents wake the agents they @mention or reply to. Agents pause after ${AGENT_CHAIN_LIMIT} agent messages in a row in one thread, or ${AGENT_ROOM_LIMIT} in the room, until a person steps in.` : 'Agents may reply to every message from a person; one that @mentions someone wakes only the agents it names.'}</li>
                      <li>{settings.agentAssignmentsWake ? 'Agents can hand tasks to each other.' : 'Only people’s assignments wake agents.'}</li>
                      <li>{settings.guestAgentApproval ? 'The host approves agents connected by guests.' : 'Agents join as soon as their link is used.'}</li>
                      <li>{settings.hostApprovesDevices ? 'The host approves each new device.' : 'People add their own devices.'}</li>
                      <li>{settings.historyForNewcomers ? 'New members can read messages sent from now on.' : 'New members only see messages sent after they join.'}</li>
                    </ul>}
                  </section>

                  {host && <section className="browser-delete-room">
                    <h3>Danger zone</h3>
                    <p>Deletes this room for everyone: the link stops working and nobody can reconnect, agents included.</p>
                    {confirming === 'delete-room' ? <div className="browser-confirm" role="group" aria-label="Confirm deleting the room">
                      <p>Delete “{title}” for everyone? This can’t be undone.</p>
                      <div><button className="secondary" disabled={busy} onClick={deleteRoom}>Delete room</button><button className="browser-text-link" onClick={() => setConfirming(undefined)}>Cancel</button></div>
                    </div> : <button className="browser-remove browser-leave" disabled={busy} onClick={() => setConfirming('delete-room')}>Delete room</button>}
                  </section>}

                  <p className="browser-storage-note">{source.isLocal
                    ? 'Messages and files stay on participating devices (saved on this computer and connected peers); each keeps the newest 256 MB of files per room. Messages deliver directly while devices are online together, and newcomers don’t receive earlier chat history. Device receipts confirm storage, not that someone has read a message.'
                    : 'Messages and files stay in participating browsers and devices; each keeps the newest 256 MB of files per room. Messages deliver directly while devices are online together, and newcomers don’t receive earlier chat history. Device receipts confirm storage, not that someone has read a message.'}</p>
                </div>

                <div role="tabpanel" id="details-panel-you" aria-labelledby="details-tab-you" hidden={paneTab !== 'room' || detailsTab !== 'you'}>
                  <section className="browser-picture" aria-label="Your picture">
                    <h3>Your picture</h3>
                    <div>
                      <MemberAvatar member={self} roomId={urlRoom} fallback={self?.name || ''} />
                      <button className="secondary" disabled={busy || !self} onClick={() => self && pickAvatar(self.id)}>{self?.avatar ? 'Change picture' : 'Choose picture'}</button>
                      {self?.avatar && <button className="browser-remove" disabled={busy} onClick={() => clearAvatar(self.id)}>Remove</button>}
                    </div>
                    <p>Cropped to a square and kept under 16 KB. Everyone in this room sees it.</p>
                  </section>

                  {detailsOpen && paneTab === 'room' && detailsTab === 'you' && source.notifications && <RoomNotificationControls key={urlRoom} api={source.notifications} roomId={urlRoom} />}
                  {detailsOpen && notifySupported && host && <section className="browser-notifications" aria-label="Browser notifications">
                    <h3>Browser notifications</h3>
                    <p>Get notified when someone asks to join while this tab is in the background.</p>
                    {notifyPermission === 'denied'
                      ? <p>Notifications are blocked for this site in your browser settings.</p>
                      : <label className="browser-setting"><input type="checkbox" checked={hostNotifyEnabled && notifyPermission === 'granted'}
                          onChange={e => void toggleHostNotifications(e.target.checked)} />
                          <span><strong>Notify on join requests</strong>Alerts arrive only while this tab is hidden.</span></label>}
                  </section>}

                  <section className="browser-device-section">
                    <h3>Your devices</h3>
                    <p>{source.isLocal ? 'Join as yourself from another device.' : 'Join as yourself from another browser or device.'}</p>
                    {host && status.devices!.filter(d => d.memberId === status.memberId).length === 1 && <p className="browser-only-device">{source.isLocal ? 'This computer holds your key for this room.' : 'This browser holds your only key for this room.'} Add another device so you don’t lose hosting.{' '}
                      {source.isLocal && <button className="browser-text-link" onClick={openCodeLink}>Link another device</button>}</p>}
                    {!source.isLocal && <button type="button" className="secondary browser-connect-phone" aria-haspopup="dialog" onClick={() => openInvite('phone')}><RoomIcon kind="phone" />Connect your phone</button>}
                    <details ref={linkDevice} className="browser-link-device"><summary>{source.isLocal ? 'Add another device' : 'Add a device with a code'}</summary><p>Open this room link on your other device and choose <strong>Use my existing identity</strong>. Enter its code here.</p>
                      <form onSubmit={e => { e.preventDefault(); void act(async () => { await source.command('link', urlRoom, { code: code.trim().toLowerCase() }); setCode(''); setNotice(host || !settings.hostApprovesDevices ? 'Your device is approved.' : 'Identity confirmed. The host can now admit your device.'); }); }}><label>Device code<input value={code} onChange={e => setCode(e.target.value)} required maxLength={16} autoComplete="off" spellCheck={false} /></label><button className="secondary" disabled={busy || code.trim().length !== 16}>Approve my device</button></form>
                    </details>
                    {!source.isLocal && <details ref={desktopPairing} className="browser-desktop-pairing"><summary>Use the desktop app</summary>
                      <DesktopPairing rooms={[{ id: urlRoom, title }, ...recent.filter(r => r.id !== urlRoom)]} name={self?.name || name} device={deviceId} link={pairRoom} onActiveChange={setDesktopPairingActive} />
                    </details>}
                    <details className="browser-device-details"><summary>Manage your devices</summary>
                      {status.devices!.filter(d => d.memberId === status.memberId).map(d => <div key={d.id}><strong>{d.label} · {d.id.slice(-6).toUpperCase()}</strong><span>{d.id === status.deviceId ? 'This device' : connected.includes(d.id) ? 'Connected' : 'Offline'}</span>{d.id !== status.deviceId && <button className="browser-remove" aria-label={`Remove ${d.label} ${d.id.slice(-6).toUpperCase()}`} disabled={busy} onClick={() => void act(async () => { await source.command('remove', urlRoom, { deviceId: d.id }); })}>Remove device</button>}</div>)}
                    </details>
                    {!host && self && (confirming === self.id ? confirmRemove(self, () => requestAnimationFrame(() => document.getElementById('browser-leave-room-btn')?.focus())) : <button id="browser-leave-room-btn" className="browser-remove browser-leave" disabled={busy} onClick={() => setConfirming(self.id)}>Leave this room</button>)}
                  </section>
                </div>
              </div>
            </aside>
          </div>
          <InviteDialog key={urlRoom} phone={source.isLocal ? undefined : { rooms: [{ id: urlRoom, title }, ...recent.filter(r => r.id !== urlRoom)], name: self?.name || name, device: deviceId, link: pairRoom, command: pairCommand,
              asking: askingRequest ? { label: askingRequest.device.label, fingerprint: deviceFingerprint(askingRequest.device.id) } : undefined, onActiveChange: setPhonePairingActive, onUseCode: openCodeLink }} open={inviteOpen} tab={inviteTab} onTab={setInviteTab} onClose={() => setInviteOpen(false)} roomId={urlRoom} roomTitle={title} roomOrigin={roomOrigin} personLink={invite}
            agentVersion={agentVersion} status={status} host={host} createAgentLink={createAgentLink} localAgents={!!source.agents}
            onOpenLocalAgents={() => { setInviteOpen(false); openAgentConnect(); }} onNotice={setNotice} />
        </>}
    </main>
  </div>;
}
