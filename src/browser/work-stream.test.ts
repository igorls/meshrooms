import { describe, expect, test } from 'bun:test';
import type { Participant } from '../room';
import type { AgentActivity } from './activity';
import type { SavedMessage } from './peers';
import type { BrowserMember } from './protocol';
import { retractedStub } from './retractions';
import {
  buildStreamEntries,
  collectSharedFiles,
  detectHumanAction,
  isHiddenInCollapsedStack,
  MAX_STACK_PINS,
  messagePreview,
  sortRoomMembers,
  STACK_WINDOW_MS,
  type ResponseStack,
  type TranscriptItem,
} from './work-stream';

const ROOM = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const ROBIN = '33333333-3333-4333-8333-333333333333';
const AGENT_A = '44444444-4444-4444-8444-444444444444';
const AGENT_B = '55555555-5555-4555-8555-555555555555';
const AGENT_C = '66666666-6666-4666-8666-666666666666';
const AGENT_D = '77777777-7777-4777-8777-777777777777';

const members: BrowserMember[] = [
  { id: ALEX, name: 'Alex', role: 'human' },
  { id: ROBIN, name: 'Robin', role: 'human' },
  { id: AGENT_A, name: 'BotAlpha', role: 'agent', operatorId: ALEX },
  { id: AGENT_B, name: 'BotBeta', role: 'agent', operatorId: ALEX },
  { id: AGENT_C, name: 'BotGamma', role: 'agent', operatorId: ROBIN },
  { id: AGENT_D, name: 'BotDelta', role: 'agent', operatorId: ROBIN },
];
const participants: Participant[] = members.map(m => ({ id: m.id, name: m.name, role: m.role ?? 'human', state: 'remote', detail: '' }));

function msg(overrides: {
  id?: string;
  memberId: string;
  text: string;
  at: number;
  replyTo?: string;
  retracted?: true;
  attachments?: SavedMessage['packet']['body']['attachments'];
}): SavedMessage {
  const m: SavedMessage = {
    packet: {
      body: {
        kind: 'message',
        roomId: ROOM,
        id: overrides.id ?? crypto.randomUUID(),
        deviceId: 'a'.repeat(64),
        memberId: overrides.memberId,
        text: overrides.text,
        at: overrides.at,
        ...(overrides.replyTo ? { replyTo: overrides.replyTo } : {}),
        ...(overrides.attachments ? { attachments: overrides.attachments } : {}),
      },
      signature: 's'.repeat(88),
    },
    targets: [],
    receipts: [],
  };
  return overrides.retracted ? retractedStub(m) : m;
}

describe('work-stream Response Stacks & Timeline Zoom', () => {
  test('collapses multi-agent replies to the same prompt into an anchor-keyed ResponseStack with pinned asks, and flattens in full mode', () => {
    const prompt = msg({ memberId: ALEX, text: 'How should we organize the room?', at: 1000 });
    const r1 = msg({ memberId: AGENT_A, text: 'I suggest a work-first layout with three sections.', at: 1100, replyTo: prompt.packet.body.id });
    const r2 = msg({ memberId: AGENT_B, text: 'Agreed. Every task gets a thread.\nReady for review on PR #151 once CI finishes.', at: 1200, replyTo: prompt.packet.body.id });
    const r3 = msg({ memberId: AGENT_C, text: 'Needs approval: should we start with Phase 1 before touching the protocol?', at: 1300, replyTo: prompt.packet.body.id });
    const followUp = msg({ memberId: ROBIN, text: 'Looks great!', at: 2000 });

    const allMessages = [prompt, r1, r2, r3, followUp];
    const items: TranscriptItem[] = allMessages.map(message => ({ message }));

    const focused = buildStreamEntries(items, { zoom: 'focused', members, participants, viewerId: ALEX, allMessages });
    expect(focused).toHaveLength(3);
    expect(focused[0].kind).toBe('item');
    expect(focused[1].kind).toBe('stack');
    expect(focused[2].kind).toBe('item');

    const stack = focused[1] as ResponseStack;
    expect(stack.id).toBe(`stack:${prompt.packet.body.id}`);
    expect(stack.anchorId).toBe(prompt.packet.body.id);
    expect(stack.messages).toHaveLength(3);
    expect(stack.authors.map(a => a.name)).toEqual(['BotAlpha', 'BotBeta', 'BotGamma']);
    expect(stack.replyTo).toBe(prompt.packet.body.id);
    expect(stack.hasUnreadForYou).toBe(true);
    // Question/approval ask sorts ahead of pure review-note hint.
    expect(stack.pinnedActions.map(a => [a.authorName, a.kind])).toEqual([
      ['BotGamma', 'approval'],
      ['BotBeta', 'review-ready'],
    ]);

    // Unread-hide helper: plain reply inside collapsed stack is hidden; pinned reply or expanded stack is visible.
    expect(isHiddenInCollapsedStack(r1.packet.body.id, focused, new Set())).toBe(true);
    expect(isHiddenInCollapsedStack(r3.packet.body.id, focused, new Set())).toBe(false);
    expect(isHiddenInCollapsedStack(r1.packet.body.id, focused, new Set([stack.id]))).toBe(false);
    expect(isHiddenInCollapsedStack(followUp.packet.body.id, focused, new Set())).toBe(false);

    // Full mode expands every message flat in chronological order.
    const full = buildStreamEntries(items, { zoom: 'full', members, participants, viewerId: ALEX, allMessages });
    expect(full).toHaveLength(5);
    expect(full.every(e => e.kind === 'item')).toBe(true);
  });

  test('does not merge bursts answering different prompts, requires distinct authors, and splits on a human message', () => {
    const q1 = msg({ memberId: ALEX, text: 'Question 1?', at: 1000 });
    const q2 = msg({ memberId: ALEX, text: 'Question 2?', at: 1100 });
    const a1 = msg({ memberId: AGENT_A, text: 'Answer to Q1.', at: 1200, replyTo: q1.packet.body.id });
    const b1 = msg({ memberId: AGENT_B, text: 'Answer to Q2.', at: 1300, replyTo: q2.packet.body.id });
    // Two messages from the SAME agent answering Q2 should also stay unstacked.
    const b2 = msg({ memberId: AGENT_B, text: 'Follow-up on Q2.', at: 1400, replyTo: q2.packet.body.id });

    const allDiff = [q1, q2, a1, b1, b2];
    const diffEntries = buildStreamEntries(allDiff.map(message => ({ message })), { zoom: 'focused', members, participants, viewerId: ALEX, allMessages: allDiff });
    expect(diffEntries.every(e => e.kind === 'item')).toBe(true);
    expect(diffEntries).toHaveLength(5);

    // A person's message splits replies to the same prompt so the thread stays chronological.
    const midHuman = msg({ memberId: ROBIN, text: 'Hold on, checking too.', at: 1500 });
    const c1 = msg({ memberId: AGENT_C, text: 'Another answer to Q1.', at: 1600, replyTo: q1.packet.body.id });
    const splitMsgs = [q1, a1, midHuman, c1];
    const splitEntries = buildStreamEntries(splitMsgs.map(message => ({ message })), { zoom: 'focused', members, participants, viewerId: ALEX, allMessages: splitMsgs });
    expect(splitEntries.every(e => e.kind === 'item')).toBe(true);
    expect(splitEntries).toHaveLength(4);
  });

  test('enforces the 15-minute boundary from the first message, splits long chains, and splits on negative timestamp gaps', () => {
    const prompt = msg({ memberId: ALEX, text: 'Keep reporting progress', at: 0 });
    // Exact 15-minute boundary: 0 -> 15m stacks, 15m + 1ms splits.
    const first = msg({ memberId: AGENT_A, text: 'First update.', at: 1000, replyTo: prompt.packet.body.id });
    const atBoundary = msg({ memberId: AGENT_B, text: 'Right at 15m.', at: 1000 + STACK_WINDOW_MS, replyTo: prompt.packet.body.id });
    const pastBoundary = msg({ memberId: AGENT_C, text: '1ms past 15m.', at: 1000 + STACK_WINDOW_MS + 1, replyTo: prompt.packet.body.id });

    const boundaryMsgs = [prompt, first, atBoundary, pastBoundary];
    const boundaryEntries = buildStreamEntries(boundaryMsgs.map(message => ({ message })), { zoom: 'focused', members, participants, viewerId: ALEX, allMessages: boundaryMsgs });
    expect(boundaryEntries).toHaveLength(3);
    expect(boundaryEntries[1].kind).toBe('stack');
    expect((boundaryEntries[1] as ResponseStack).messages).toHaveLength(2);
    expect(boundaryEntries[2].kind).toBe('item');

    // Long chain: agents posting every 10 minutes for 60 minutes must NOT merge into one unbounded stack.
    const chainMsgs: SavedMessage[] = [prompt];
    for (let i = 0; i < 6; i++) {
      chainMsgs.push(msg({
        memberId: i % 2 === 0 ? AGENT_A : AGENT_B,
        text: `Update #${i + 1}.`,
        at: 1000 + i * 10 * 60_000,
        replyTo: prompt.packet.body.id,
      }));
    }
    const chainEntries = buildStreamEntries(chainMsgs.map(message => ({ message })), { zoom: 'focused', members, participants, viewerId: ALEX, allMessages: chainMsgs });
    const stacks = chainEntries.filter((e): e is ResponseStack => e.kind === 'stack');
    expect(stacks).toHaveLength(3);
    expect(stacks.every(s => s.messages.length === 2)).toBe(true);
    // Distinct stack IDs when multiple stacks share the same prompt after time splits.
    expect(new Set(stacks.map(s => s.id)).size).toBe(3);

    // Negative `at` gap (out-of-order clock) splits instead of merging.
    const outA = msg({ memberId: AGENT_A, text: 'Later clock.', at: 5000, replyTo: prompt.packet.body.id });
    const outB = msg({ memberId: AGENT_B, text: 'Earlier clock.', at: 4000, replyTo: prompt.packet.body.id });
    const outMsgs = [prompt, outA, outB];
    const outEntries = buildStreamEntries(outMsgs.map(message => ({ message })), { zoom: 'focused', members, participants, viewerId: ALEX, allMessages: outMsgs });
    expect(outEntries.every(e => e.kind === 'item')).toBe(true);
  });

  test('keeps stack id stable when older history is prepended into the same burst', () => {
    const prompt = msg({ memberId: ALEX, text: 'Review this plan', at: 1000 });
    const r1 = msg({ memberId: AGENT_A, text: 'First reply.', at: 2000, replyTo: prompt.packet.body.id });
    const r2 = msg({ memberId: AGENT_B, text: 'Second reply.', at: 3000, replyTo: prompt.packet.body.id });
    const r3 = msg({ memberId: AGENT_C, text: 'Third reply.', at: 4000, replyTo: prompt.packet.body.id });

    // Initial newest page (prompt & r1 not loaded yet).
    const beforeMsgs = [r2, r3];
    const before = buildStreamEntries(beforeMsgs.map(message => ({ message })), { zoom: 'focused', members, participants, viewerId: ALEX, allMessages: beforeMsgs });
    expect(before).toHaveLength(1);
    expect(before[0].kind).toBe('stack');
    const idBefore = (before[0] as ResponseStack).id;

    // After "Load earlier" prepends prompt and r1 within the window.
    const afterMsgs = [prompt, r1, r2, r3];
    const after = buildStreamEntries(afterMsgs.map(message => ({ message })), { zoom: 'focused', members, participants, viewerId: ALEX, allMessages: afterMsgs });
    const stackAfter = after.find((e): e is ResponseStack => e.kind === 'stack');
    expect(stackAfter).toBeDefined();
    expect(stackAfter!.id).toBe(idBefore);
    expect(stackAfter!.messages).toHaveLength(3);
  });

  test('pins any agent question (even without @ or replying to another agent), rejects false-positive keyword wording, and caps pins', () => {
    const prompt = msg({ memberId: ALEX, text: 'Next steps?', at: 1000 });
    const agentStatement = msg({ memberId: AGENT_A, text: 'Looking at storage options.', at: 1050, replyTo: prompt.packet.body.id });

    // False-negative fixes: ALL of these questions MUST be pinned.
    const topLevelQ = msg({ memberId: AGENT_A, text: 'Should I use Postgres or SQLite?', at: 1100 });
    const noAtQ = msg({ memberId: AGENT_B, text: 'Alex, should I run the migration tonight?', at: 1150, replyTo: prompt.packet.body.id });
    const agentReplyQ = msg({ memberId: AGENT_C, text: 'Wait, should we keep the legacy table too?', at: 1200, replyTo: agentStatement.packet.body.id });
    const codeOnlyQ = msg({ memberId: AGENT_A, text: 'All good!\n```ts\n// blocked: approve?\n```', at: 1250, replyTo: prompt.packet.body.id });

    expect(detectHumanAction(topLevelQ, 'BotAlpha', ALEX, participants)?.kind).toBe('question');
    expect(detectHumanAction(noAtQ, 'BotBeta', ALEX, participants)?.kind).toBe('question');
    expect(detectHumanAction(agentReplyQ, 'BotGamma', ALEX, participants)?.kind).toBe('question');
    expect(detectHumanAction(codeOnlyQ, 'BotAlpha', ALEX, participants)).toBeUndefined();

    // False-positive fixes: casual "approve", "go ahead", or past/resolved "was blocked ... fixed now" MUST NOT pin.
    const casualApprove = msg({ memberId: AGENT_A, text: 'I approve of this approach.', at: 1300, replyTo: prompt.packet.body.id });
    const casualGoAhead = msg({ memberId: AGENT_B, text: 'Please go ahead and ignore my earlier note.', at: 1350, replyTo: prompt.packet.body.id });
    const resolvedBlocker = msg({ memberId: AGENT_C, text: 'The CI job was blocked by the firewall, fixed now.', at: 1400, replyTo: prompt.packet.body.id });
    expect(detectHumanAction(casualApprove, 'BotAlpha', ALEX, participants)).toBeUndefined();
    expect(detectHumanAction(casualGoAhead, 'BotBeta', ALEX, participants)).toBeUndefined();
    expect(detectHumanAction(resolvedBlocker, 'BotGamma', ALEX, participants)).toBeUndefined();

    // True positives still detected cleanly.
    const realBlocker = msg({ memberId: AGENT_B, text: 'Blocked on Windows signing certificate.', at: 1450, replyTo: prompt.packet.body.id });
    const realMention = msg({ memberId: AGENT_C, text: '@Alex can you confirm the deploy window?', at: 1500, replyTo: prompt.packet.body.id });
    const realApproval = msg({ memberId: AGENT_D, text: 'Waiting for your go-ahead before deploying.', at: 1550, replyTo: prompt.packet.body.id });
    const realForRobin = msg({ memberId: AGENT_A, text: '@Robin the build artifacts are uploaded.', at: 1600, replyTo: prompt.packet.body.id });
    expect(detectHumanAction(realBlocker, 'BotBeta', ALEX, participants)?.kind).toBe('blocker');
    expect(detectHumanAction(realMention, 'BotGamma', ALEX, participants)?.kind).toBe('mention-you');
    expect(detectHumanAction(realApproval, 'BotDelta', ALEX, participants)?.kind).toBe('approval');
    expect(detectHumanAction(realForRobin, 'BotAlpha', ALEX, participants)?.kind).toBe('addressed');
    expect(messagePreview(realBlocker)).toBe('Blocked on Windows signing certificate.');

    // Cap: 4 distinct agents + duplicate spam from one agent still cap at MAX_STACK_PINS (3), prioritizing viewer @mention & questions.
    const spam1 = msg({ memberId: AGENT_D, text: 'Blocker: item one.', at: 1410, replyTo: prompt.packet.body.id });
    const spam2 = msg({ memberId: AGENT_D, text: 'Blocker: item two.', at: 1420, replyTo: prompt.packet.body.id });
    const stackMsgs = [prompt, noAtQ, spam1, spam2, realBlocker, realMention, realForRobin];
    const entries = buildStreamEntries(stackMsgs.map(message => ({ message })), { zoom: 'focused', members, participants, viewerId: ALEX, allMessages: stackMsgs });
    const stack = entries[1] as ResponseStack;
    expect(stack.pinnedActions).toHaveLength(MAX_STACK_PINS);
    expect(stack.pinnedActions[0].kind).toBe('mention-you');
    expect(stack.pinnedActions[1].kind).toBe('question');
    expect(stack.pinnedActions[2].kind).toBe('addressed');
    expect(stack.hiddenPinnedCount).toBeGreaterThan(0);
    // At most 1 pin per agent author in a stack.
    expect(new Set(stack.pinnedActions.map(p => p.message.packet.body.memberId)).size).toBe(MAX_STACK_PINS);
  });

  test('keeps people task changes, viewer assignments, removals, and done outcomes visible while folding routine agent task churn', () => {
    const agentCreate = { id: 'e1', taskId: 't1', title: 'Build UI', memberId: AGENT_A, at: 1000, created: true as const };
    const agentDoing = { id: 'e2', taskId: 't1', title: 'Build UI', memberId: AGENT_A, at: 1100, status: 'doing' as const };
    const agentDone = { id: 'e3', taskId: 't1', title: 'Build UI', memberId: AGENT_A, at: 1200, status: 'done' as const };
    const humanAssign = { id: 'e4', taskId: 't2', title: 'Ship', memberId: ROBIN, at: 1300, assigneeId: ALEX };
    const humanReopen = { id: 'e5', taskId: 't1', title: 'Build UI', memberId: ROBIN, at: 1400, status: 'todo' as const };
    const agentAssignViewer = { id: 'e6', taskId: 't3', title: 'Approve release', memberId: AGENT_B, at: 1500, assigneeId: ALEX };
    const agentRemove = { id: 'e7', taskId: 't4', title: 'Old draft', memberId: AGENT_B, at: 1600, removed: true as const };

    const items: TranscriptItem[] = [
      { event: agentCreate },
      { event: agentDoing },
      { event: agentDone },
      { event: humanAssign },
      { event: humanReopen },
      { event: agentAssignViewer },
      { event: agentRemove },
    ];

    const focused = buildStreamEntries(items, { zoom: 'focused', members, participants, viewerId: ALEX, allMessages: [] });
    // Only the first two routine agent updates fold; done, human changes, viewer assignment, and removal all stay visible.
    expect(focused).toHaveLength(6);
    expect(focused[0].kind).toBe('events-fold');
    if (focused[0].kind === 'events-fold') expect(focused[0].events.map(e => e.id)).toEqual(['e1', 'e2']);
    expect(focused.slice(1).every(e => e.kind === 'item')).toBe(true);
  });

  test('sortRoomMembers splits People (Host -> You -> alpha) and Agents (Working -> Idle -> Offline)', () => {
    const activities = new Map<string, AgentActivity>([
      [AGENT_A, { state: 'offline' }],
      [AGENT_B, { state: 'working', since: 1000, on: {} }],
      [AGENT_C, { state: 'idle', since: 1000 }],
      [AGENT_D, { state: 'offline' }],
    ]);
    const { people, agents } = sortRoomMembers(members, activities, ALEX, ROBIN);
    expect(people.map(m => m.name)).toEqual(['Alex', 'Robin']);
    expect(agents.map(m => m.name)).toEqual(['BotBeta', 'BotGamma', 'BotAlpha', 'BotDelta']);
  });

  test('collectSharedFiles returns newest-first deduplicated attachments excluding retracted messages', () => {
    const refA = { id: 'f1', name: 'logo.svg', type: 'text/plain', size: 100, sha256: 'a'.repeat(64) };
    const refB = { id: 'f2', name: 'mockup.png', type: 'image/png', size: 200, sha256: 'b'.repeat(64) };
    const refDeleted = { id: 'f3', name: 'secret.png', type: 'image/png', size: 300, sha256: 'c'.repeat(64) };
    const m1 = msg({ memberId: ALEX, text: 'first', at: 1000, attachments: [refA] });
    const m2 = msg({ memberId: AGENT_A, text: 'deleted', at: 1100, attachments: [refDeleted], retracted: true });
    const m3 = msg({ memberId: AGENT_C, text: 'second', at: 1200, attachments: [refB, refA] });

    const files = collectSharedFiles([m1, m2, m3], members);
    expect(files.map(f => [f.ref.name, f.authorName])).toEqual([
      ['mockup.png', 'BotGamma'],
      ['logo.svg', 'BotGamma'],
    ]);
  });
});
