/**
 * Phase 1 Work-First Room UI primitives (pure, protocol-free UI projection):
 * - Agent Response Stacks: collapses multi-agent bursts replying to the same prompt or human turn
 *   (from 2+ distinct agents within a bounded 15-minute window from the first reply) into a single
 *   expandable card with stable anchor-based ID, direct links to originals, and capped agent-labeled
 *   pinned asks (viewer @mentions, any question, human-addressed notes, and tight hint chips).
 * - Timeline Zoom (`focused` "Humans & Outcomes" <-> `full` "Full Stream").
 * - Room Details helpers: split & ordered People / Agents lists and deduplicated Shared Files index.
 */
import { mentionedIds } from '../collab';
import type { Participant } from '../room';
import type { AgentActivity } from './activity';
import type { TaskEvent } from './board';
import type { Decision } from './decisions';
import { shownText, type AttachmentRef } from './files';
import type { SavedMessage } from './peers';
import type { BrowserMember, RenameNotice } from './protocol';
import { isRetracted } from './retractions';

export type TimelineZoom = 'focused' | 'full';
export type DetailsTab = 'members' | 'shared' | 'rules' | 'you';

export type TranscriptItem =
  | { message: SavedMessage; event?: undefined; decision?: undefined; rename?: undefined }
  | { event: TaskEvent; message?: undefined; decision?: undefined; rename?: undefined }
  | { decision: Decision; message?: undefined; event?: undefined; rename?: undefined }
  | { rename: RenameNotice; message?: undefined; event?: undefined; decision?: undefined };

export type PinnedActionKind = 'mention-you' | 'question' | 'addressed' | 'blocker' | 'approval' | 'review-ready';

export type PinnedActionItem = {
  message: SavedMessage;
  authorName: string;
  kind: PinnedActionKind;
  label: string;
  snippet: string;
  /** True when raised from a keyword hint rather than direct addressing or a question. */
  isHint?: boolean;
};

export type ResponseStack = {
  kind: 'stack';
  id: string;
  /** The prompt or human-turn message ID anchoring this stack. */
  anchorId: string;
  at: number;
  replyTo?: string;
  messages: SavedMessage[];
  authors: { memberId: string; name: string }[];
  pinnedActions: PinnedActionItem[];
  /** Number of additional pinned candidates omitted by MAX_STACK_PINS or per-author cap. */
  hiddenPinnedCount: number;
  attachmentCount: number;
  hasUnreadForYou: boolean;
};

export type EventsFold = {
  kind: 'events-fold';
  id: string;
  at: number;
  events: TaskEvent[];
};

export type StreamEntry =
  | { kind: 'item'; item: TranscriptItem; at: number }
  | ResponseStack
  | EventsFold;

export type SharedFileEntry = {
  ref: AttachmentRef;
  messageId: string;
  authorId: string;
  authorName: string;
  at: number;
};

/** Maximum span from the first reply in a stack to the last reply in that stack. */
export const STACK_WINDOW_MS = 15 * 60_000;
/** Cap visible pinned chips per stack so no single burst or guest agent can flood the timeline. */
export const MAX_STACK_PINS = 3;

export const transcriptItemAt = (item: TranscriptItem): number =>
  item.message?.packet.body.at ?? item.event?.at ?? item.rename?.at ?? item.decision!.createdAt;

// Tight hint patterns: require explicit active ask/status phrasing rather than bare words like "approve",
// "go ahead", or past-tense "was blocked ... fixed now".
const RESOLVED_BLOCKER_RE = /\b(?:was\s+blocked|were\s+blocked|fixed\s+now|now\s+fixed|resolved|unblocked|worked\s+around|corrigid[oa]|resolvid[oa]|desbloquead[oa])\b/i;
const BLOCKER_RE = /(?:^|[\s:;(\[-])(?:blocker\s*:|i(?:'m| am)\s+blocked\b|we(?:'re| are)\s+blocked\b|still\s+blocked\b|blocked\s+on\b|estou\s+bloquead[oa]\b|bloqueio\s*:|travad[oa]\s+(?:em|no|na)\b|needs?\s+(?:your|human)\s+(?:input|help)\b|waiting\s+(?:on|for)\s+(?:you|a\s+person|human)\b|precis[ao]\s+d[ae]\s+(?:sua\s+ajuda|você)\b)/i;
const APPROVAL_RE = /\b(?:needs?\s+(?:your\s+|human\s+)?(?:approval|permission|sign[- ]?off|decision)|awaiting\s+(?:your\s+)?(?:approval|sign[- ]?off)|waiting\s+(?:on|for)\s+(?:your\s+)?(?:approval|sign[- ]?off|go[- ]?ahead)|pending\s+(?:your\s+)?approval|please\s+approve|ok\s+to\s+(?:proceed|merge|ship)|aguardando\s+(?:sua\s+)?aprova[çc][aã]o|precis[ao]\s+d[ae]\s+(?:sua\s+)?aprova[çc][aã]o|confirmar\s+antes|bater\s+o\s+martelo|posso\s+(?:seguir|abrir|fazer|começar|implementar))\b/i;
const REVIEW_READY_RE = /\b(?:ready\s+for\s+(?:your\s+)?(?:re-?)?review|pronto\s+(?:para|pro)\s+(?:re-?)?revis[aã]o|aguardando\s+(?:sua\s+)?revis[aã]o|re-?review\s+no\s+pr)\b/i;

const PIN_PRIORITY: Record<PinnedActionKind, number> = {
  'mention-you': 0,
  question: 1,
  addressed: 2,
  approval: 3,
  blocker: 4,
  'review-ready': 5,
};

/** Removes fenced code blocks so technical keywords or `?` inside code never trigger false action pins. */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, m => m.slice(1, -1));
}

/** Cleans markdown headings/bold/bullets into a calm 1-line snippet. */
function cleanSnippet(line: string, maxLen = 148): string {
  const cleaned = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*•>]\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).trimEnd()}…`;
}

function matchingLine(prose: string, re: RegExp, exclude?: RegExp): string | undefined {
  const lines = prose.split(/\n+/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (re.test(line) && (!exclude || !exclude.test(line))) return cleanSnippet(line);
  }
  return undefined;
}

function questionLine(prose: string): string | undefined {
  const lines = prose.split(/\n+/).map(l => l.trim()).filter(Boolean);
  // Prefer the last non-URL line ending with a question mark (agents typically put their ask at the end).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/\?["'”’)\]]*$/.test(line) && !/^https?:\/\/\S+$/.test(line) && line.length >= 6) return cleanSnippet(line);
  }
  return undefined;
}

/**
 * Detects whether an agent message should stay pinned when its Response Stack is collapsed:
 * - Always pins direct `@mentions` of the viewer, any message ending in a question (regardless of `@` or reply target),
 *   and messages explicitly `@mentioning` a person in the room.
 * - Also surfaces tight, resolved-guarded agent hint notes for explicit active blockers, approval requests, and review-ready handoffs.
 */
export function detectHumanAction(
  message: SavedMessage,
  authorName: string,
  viewerId: string | undefined,
  participants: Pick<Participant, 'id' | 'name' | 'role'>[],
  _allMessages?: readonly SavedMessage[],
): PinnedActionItem | undefined {
  if (isRetracted(message)) return undefined;
  const body = message.packet.body;
  const text = shownText(body);
  if (!text) return undefined;
  const prose = stripCodeBlocks(text);
  const firstLine = cleanSnippet(prose.split(/\n+/).find(l => l.trim()) ?? prose);
  const mentions = mentionedIds(text, participants);
  const mentionsViewer = !!viewerId && mentions.includes(viewerId);
  const mentionsAnyHuman = mentions.some(id => participants.find(p => p.id === id)?.role === 'human');
  const q = questionLine(prose);

  if (mentionsViewer) {
    return { message, authorName, kind: 'mention-you', label: 'Mentions you', snippet: q ?? firstLine };
  }

  // Tight agent hints (checked on individual lines so a past/resolved blocker never fires).
  const blockerSnippet = matchingLine(prose, BLOCKER_RE, RESOLVED_BLOCKER_RE);
  if (blockerSnippet) {
    return { message, authorName, kind: 'blocker', label: 'Blocker note', snippet: blockerSnippet, isHint: true };
  }
  const approvalSnippet = matchingLine(prose, APPROVAL_RE);
  if (approvalSnippet) {
    return { message, authorName, kind: 'approval', label: 'Approval note', snippet: approvalSnippet, isHint: true };
  }
  const reviewSnippet = matchingLine(prose, REVIEW_READY_RE);
  if (reviewSnippet) {
    return { message, authorName, kind: 'review-ready', label: 'Review note', snippet: reviewSnippet, isHint: true };
  }

  // Any agent question stays visible — even top-level, without @mention, or replying to another agent.
  if (q) {
    return { message, authorName, kind: 'question', label: 'Question', snippet: q };
  }
  if (mentionsAnyHuman) {
    return { message, authorName, kind: 'addressed', label: 'For people', snippet: firstLine };
  }
  return undefined;
}

/** Concise 1-line preview of an agent message for stack headers & compare lists. */
export function messagePreview(message: SavedMessage, maxLen = 120): string {
  if (isRetracted(message)) return 'Message deleted';
  const text = shownText(message.packet.body);
  if (!text && message.packet.body.attachments?.length) {
    const names = message.packet.body.attachments.map(a => a.name).join(', ');
    return cleanSnippet(`Shared ${names}`, maxLen);
  }
  const firstLine = stripCodeBlocks(text).split(/\n+/).map(l => l.trim()).find(Boolean) ?? text;
  return cleanSnippet(firstLine, maxLen);
}

/**
 * Projects a flat chronological `TranscriptItem[]` into `StreamEntry[]` according to `zoom`:
 * - `full`: every message, decision, task line and rename renders flat in chronological order.
 * - `focused` ("Humans & Outcomes"):
 *   1. Multi-agent bursts (>= 2 distinct live agents answering the exact same prompt `replyTo` or
 *      the same immediately preceding human turn, within `STACK_WINDOW_MS` from the first reply in
 *      the burst and in non-decreasing timestamp order) collapse into a `ResponseStack` keyed by
 *      its anchor ID (`stack:<anchorId>`), with capped agent-labeled pinned items.
 *   2. 2+ consecutive routine non-done, non-removal task updates authored by agents (and not
 *      assigned to the viewer) fold into an expandable `EventsFold`; all human task events,
 *      assignments to the viewer, removals, and `done` outcomes stay directly visible.
 *   3. Human messages, Decisions, Renames, unanchored agent posts, and single-agent replies always
 *      stay directly visible.
 */
export function buildStreamEntries(
  items: readonly TranscriptItem[],
  options: {
    zoom: TimelineZoom;
    members: readonly BrowserMember[];
    participants: Pick<Participant, 'id' | 'name' | 'role'>[];
    viewerId?: string;
    allMessages: readonly SavedMessage[];
  },
): StreamEntry[] {
  if (options.zoom === 'full') {
    return items.map(item => ({ kind: 'item', item, at: transcriptItemAt(item) }));
  }

  const memberMap = new Map(options.members.map(m => [m.id, m]));
  const isAgentMember = (memberId: string) => memberMap.get(memberId)?.role === 'agent';
  const nameOf = (memberId: string) => memberMap.get(memberId)?.name ?? 'Former member';

  const result: StreamEntry[] = [];
  const usedStackIds = new Set<string>();
  let agentBuf: SavedMessage[] = [];
  let currentAnchor: string | undefined;
  let lastHumanMessageId: string | undefined;
  let eventBuf: TaskEvent[] = [];

  const flushEvents = () => {
    if (!eventBuf.length) return;
    if (eventBuf.length === 1) {
      result.push({ kind: 'item', item: { event: eventBuf[0] }, at: eventBuf[0].at });
    } else {
      result.push({ kind: 'events-fold', id: `events:${eventBuf[0].id}`, at: eventBuf[0].at, events: eventBuf });
    }
    eventBuf = [];
  };

  const flushAgents = () => {
    if (!agentBuf.length) return;
    const anchor = currentAnchor;
    const live = agentBuf.filter(m => !isRetracted(m));
    const distinctAuthors: { memberId: string; name: string }[] = [];
    const seenAuthor = new Set<string>();
    for (const m of live) {
      if (!seenAuthor.has(m.packet.body.memberId)) {
        seenAuthor.add(m.packet.body.memberId);
        distinctAuthors.push({ memberId: m.packet.body.memberId, name: nameOf(m.packet.body.memberId) });
      }
    }

    // Only stack replies to the same prompt or human turn from 2+ distinct live agents.
    const shouldStack = !!anchor && live.length >= 2 && distinctAuthors.length >= 2;
    if (!shouldStack) {
      for (const m of agentBuf) result.push({ kind: 'item', item: { message: m }, at: m.packet.body.at });
      agentBuf = [];
      currentAnchor = undefined;
      return;
    }

    // Collect pins capped to 1 per agent author (highest priority first) and MAX_STACK_PINS per stack.
    const bestByAuthor = new Map<string, { item: PinnedActionItem; order: number; hasQuestion: boolean }>();
    let totalCandidates = 0;
    let attachmentCount = 0;
    let hasUnreadForYou = false;
    live.forEach((m, order) => {
      attachmentCount += m.packet.body.attachments?.length ?? 0;
      const action = detectHumanAction(m, nameOf(m.packet.body.memberId), options.viewerId, options.participants, options.allMessages);
      if (action) {
        totalCandidates++;
        const hasQuestion = action.kind === 'question' || !!questionLine(stripCodeBlocks(shownText(m.packet.body)));
        const existing = bestByAuthor.get(m.packet.body.memberId);
        if (!existing || PIN_PRIORITY[action.kind] < PIN_PRIORITY[existing.item.kind] ||
          (PIN_PRIORITY[action.kind] === PIN_PRIORITY[existing.item.kind] && order > existing.order)) {
          bestByAuthor.set(m.packet.body.memberId, { item: action, order, hasQuestion });
        }
      }
      if (options.viewerId) {
        const mentions = mentionedIds(m.packet.body.text, options.participants);
        const replied = m.packet.body.replyTo ? options.allMessages.find(t => t.packet.body.id === m.packet.body.replyTo) : undefined;
        if (mentions.includes(options.viewerId) || replied?.packet.body.memberId === options.viewerId) hasUnreadForYou = true;
      }
    });

    const rankedPins = [...bestByAuthor.values()].sort((a, b) => {
      // Direct @mentions of viewer first, then any question (even if tagged as an approval/blocker note),
      // then human-addressed notes, then pure keyword hints; preserve chronological order within each tier.
      const tier = (p: { item: PinnedActionItem; hasQuestion: boolean }) =>
        p.item.kind === 'mention-you' ? 0
          : p.hasQuestion ? 1
            : p.item.kind === 'addressed' ? 2
              : 3;
      return tier(a) - tier(b) || PIN_PRIORITY[a.item.kind] - PIN_PRIORITY[b.item.kind] || a.order - b.order;
    });
    const pinnedActions = rankedPins.slice(0, MAX_STACK_PINS).map(p => p.item);
    const hiddenPinnedCount = Math.max(0, totalCandidates - pinnedActions.length);

    // Stable anchor-based stack ID: prepending or appending messages within the same burst keeps the same ID.
    const baseId = `stack:${anchor}`;
    const id = usedStackIds.has(baseId) ? `${baseId}:${agentBuf[0].packet.body.id}` : baseId;
    usedStackIds.add(id);

    result.push({
      kind: 'stack',
      id,
      anchorId: anchor,
      at: agentBuf[0].packet.body.at,
      replyTo: anchor,
      messages: agentBuf,
      authors: distinctAuthors,
      pinnedActions,
      hiddenPinnedCount,
      attachmentCount,
      hasUnreadForYou,
    });
    agentBuf = [];
    currentAnchor = undefined;
  };

  for (const item of items) {
    if (item.message) {
      flushEvents();
      const msg = item.message;
      if (isAgentMember(msg.packet.body.memberId)) {
        const anchor = msg.packet.body.replyTo ?? lastHumanMessageId;
        if (!anchor) {
          flushAgents();
          result.push({ kind: 'item', item, at: msg.packet.body.at });
          continue;
        }
        if (agentBuf.length > 0) {
          const first = agentBuf[0];
          const prev = agentBuf[agentBuf.length - 1];
          const outOfOrder = msg.packet.body.at < prev.packet.body.at;
          const pastWindow = msg.packet.body.at - first.packet.body.at > STACK_WINDOW_MS;
          if (anchor !== currentAnchor || outOfOrder || pastWindow) {
            flushAgents();
          }
        }
        currentAnchor = anchor;
        agentBuf.push(msg);
      } else {
        flushAgents();
        lastHumanMessageId = msg.packet.body.id;
        result.push({ kind: 'item', item, at: msg.packet.body.at });
      }
      continue;
    }
    if (item.event) {
      flushAgents();
      // Keep people's task changes, assignments to the viewer, removals, and completions directly visible.
      const keepVisible =
        !isAgentMember(item.event.memberId) ||
        item.event.status === 'done' ||
        item.event.removed === true ||
        (!!options.viewerId && item.event.assigneeId === options.viewerId);
      if (keepVisible) {
        flushEvents();
        result.push({ kind: 'item', item, at: item.event.at });
      } else {
        eventBuf.push(item.event);
      }
      continue;
    }
    // Decisions and renames always stand on their own and end the preceding human conversational turn.
    flushAgents();
    flushEvents();
    lastHumanMessageId = undefined;
    result.push({ kind: 'item', item, at: transcriptItemAt(item) });
  }
  flushAgents();
  flushEvents();
  return result;
}

/**
 * Returns true when `messageId` lands inside a collapsed ResponseStack without surfacing a visible
 * pinned callout, so the scrolled-up "N new messages ↓" pill doesn't advertise messages hidden inside
 * a collapsed card.
 */
export function isHiddenInCollapsedStack(
  messageId: string,
  entries: readonly StreamEntry[],
  expandedStackIds: ReadonlySet<string>,
): boolean {
  const stack = entries.find(
    (e): e is ResponseStack => e.kind === 'stack' && e.messages.some(m => m.packet.body.id === messageId),
  );
  if (!stack) return false;
  if (expandedStackIds.has(stack.id)) return false;
  if (stack.pinnedActions.some(p => p.message.packet.body.id === messageId)) return false;
  return true;
}

const AGENT_SORT_ORDER: Record<AgentActivity['state'], number> = {
  working: 0,
  idle: 1,
  online: 2,
  offline: 3,
};

/** Splits room members into ordered `people` (Host -> You -> alpha) and `agents` (Working -> Idle -> Online -> Offline -> alpha). */
export function sortRoomMembers(
  members: readonly BrowserMember[] | undefined,
  activities: ReadonlyMap<string, AgentActivity>,
  ownerId: string | undefined,
  selfId: string | undefined,
): { people: BrowserMember[]; agents: BrowserMember[] } {
  const people: BrowserMember[] = [];
  const agents: BrowserMember[] = [];
  for (const m of members ?? []) {
    if (m.role === 'agent') agents.push(m);
    else people.push(m);
  }
  people.sort((a, b) => {
    const rank = (m: BrowserMember) => (m.id === ownerId ? 0 : m.id === selfId ? 1 : 2);
    const dr = rank(a) - rank(b);
    return dr !== 0 ? dr : a.name.localeCompare(b.name);
  });
  agents.sort((a, b) => {
    const sa = AGENT_SORT_ORDER[activities.get(a.id)?.state ?? 'offline'];
    const sb = AGENT_SORT_ORDER[activities.get(b.id)?.state ?? 'offline'];
    return sa !== sb ? sa - sb : a.name.localeCompare(b.name);
  });
  return { people, agents };
}

/** Collects newest-first deduplicated attachments from non-retracted messages for the Room Details `Shared` tab. */
export function collectSharedFiles(
  messages: readonly SavedMessage[],
  members: readonly BrowserMember[] | undefined,
): SharedFileEntry[] {
  const names = new Map((members ?? []).map(m => [m.id, m.name]));
  const seen = new Set<string>();
  const out: SharedFileEntry[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isRetracted(m)) continue;
    const body = m.packet.body;
    for (const ref of body.attachments ?? []) {
      if (seen.has(ref.sha256)) continue;
      seen.add(ref.sha256);
      out.push({
        ref,
        messageId: body.id,
        authorId: body.memberId,
        authorName: names.get(body.memberId) ?? 'Former member',
        at: body.at,
      });
    }
  }
  return out;
}
