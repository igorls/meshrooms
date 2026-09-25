/**
 * Browser-room decisions: a question the room settles by majority of people's votes. Agents open them (the multiplayer
 * form of asking the user a question) and give advice, but only people's votes count. Like tasks, every change is a
 * signed operation between devices that the room service never sees, and every device folds them the same way.
 *
 * A decision is a chain of revisions keyed by its creator and id, so nobody can take over someone else's decision by
 * signing a competing first revision; each operation must extend the one before it, and ties at a revision fall to the
 * lower operation id, so clocks never decide anything. A decision closes as soon as a majority of people makes the result
 * certain, when everyone has voted, or at its deadline. Closing pins the people's votes it counted: every device checks
 * them against the votes it holds and rejects a close whose tally doesn't add up, so a steward can end a decision but
 * cannot invent its outcome.
 */
export type DecisionMode = 'choice' | 'plan-review';
export type DecisionState = 'open' | 'closed' | 'withdrawn';
export type DecisionOption = { id: string; label: string; addedBy: string };
export type Outcome = {
  result: 'decided' | 'draw' | 'no-votes';
  /** The winning option, or the options that tied. */
  optionIds: string[];
  /** People's votes per option when it closed; agents' advice is never counted. */
  tally: Record<string, number>;
  voters: number; people: number;
};
/** A person's vote a close counted, by the vote's operation id. */
export type Counted = { vote: string; memberId: string; optionId: string };
export type DecisionBody = {
  kind: 'decision'; roomId: string; id: string; deviceId: string; memberId: string; at: number;
  /** The member who opened it; with decisionId, the decision's identity. Only they can sign revision 1. */
  createdBy: string; decisionId: string; revision: number; question: string; context: string; mode: DecisionMode; options: DecisionOption[];
  /** Wake every agent (true) or these agents for their advice. */
  askAgents: boolean | string[];
  closesAt: number | null; state: DecisionState; outcome?: Outcome; counted?: Counted[];
};
export type VoteBody = {
  kind: 'vote'; roomId: string; id: string; deviceId: string; memberId: string; at: number;
  createdBy: string; decisionId: string; revision: number; optionId: string | null; comment: string;
};
export type DecisionPacket = { body: DecisionBody | VoteBody; signature: string };
/** Unsigned envelope for exchanging decisions; each operation inside is verified against its own author's device. */
export type DecisionSync = { kind: 'decisions'; roomId: string; ops: DecisionPacket[] };
/** `former` lists members who left (from the room service's retired devices), so a departed agent is still known as one. */
export type RoomMembers = { ownerId?: string; members: { id: string; role?: 'human' | 'agent'; operatorId?: string }[]; former?: { id: string; role?: 'human' | 'agent' }[] };
export type Vote = { op: string; memberId: string; optionId: string | null; comment: string; at: number; counts: boolean };
export type Decision = {
  /** `key` identifies the decision (creator and id); `id` is what people and agents quote. */
  key: string; id: string; question: string; context: string; mode: DecisionMode; options: DecisionOption[]; askAgents: boolean | string[];
  closesAt: number | null; state: DecisionState; outcome?: Outcome; createdBy: string; createdAt: number; updatedAt: number; revision: number;
  votes: Vote[];
  /** For open decisions: people's votes so far, and whether the result can no longer change (a majority is reached, so it closes). */
  tally: Outcome; settled: boolean;
  /** Closed: false while some counted votes haven't reached this device. `uncounted` people's votes arrived after the close. */
  verified: boolean; uncounted: number;
};

export const MAX_DECISION_OPS = 4000;
/** Operations one member may add to a room's decisions, so nobody can fill the shared cap alone. */
export const MAX_MEMBER_DECISION_OPS = 400;
export const MAX_OPTIONS = 8;
export const PLAN_REVIEW_OPTIONS: Omit<DecisionOption, 'addedBy'>[] = [
  { id: 'approve', label: 'Approve' }, { id: 'changes', label: 'Request changes' }, { id: 'reject', label: 'Reject' }];
const SYNC_CHUNK_CHARS = 15_000;
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const optionId = (v: unknown) => typeof v === 'string' && /^[a-z0-9-]{1,36}$/.test(v);
const text = (v: unknown, max: number, required = false) => typeof v === 'string' && v.length <= max && (!required || !!v.trim());
const stamp = (b: any, roomId: string) => !!b && b.roomId === roomId && uuid(b.id) && uuid(b.decisionId) && uuid(b.memberId) && uuid(b.createdBy)
  && typeof b.deviceId === 'string' && /^[a-f0-9]{64}$/.test(b.deviceId) && Number.isSafeInteger(b.at) && b.at > 0
  && Number.isSafeInteger(b.revision) && b.revision >= 1 && b.revision <= 1_000_000;

function validOutcome(o: any) {
  return !!o && ['decided', 'draw', 'no-votes'].includes(o.result) && Array.isArray(o.optionIds) && o.optionIds.length <= MAX_OPTIONS && o.optionIds.every(optionId)
    && !!o.tally && typeof o.tally === 'object' && Object.entries(o.tally).length <= MAX_OPTIONS
    && Object.entries(o.tally).every(([k, n]) => optionId(k) && Number.isSafeInteger(n) && (n as number) >= 0)
    && Number.isSafeInteger(o.voters) && o.voters >= 0 && Number.isSafeInteger(o.people) && o.people >= 0;
}
export function validDecisionBody(b: any, roomId: string): b is DecisionBody {
  return stamp(b, roomId) && b.kind === 'decision' && text(b.question, 200, true) && text(b.context, 4000) && ['choice', 'plan-review'].includes(b.mode)
    && Array.isArray(b.options) && b.options.length >= 2 && b.options.length <= MAX_OPTIONS
    && b.options.every((o: any) => o && optionId(o.id) && text(o.label, 120, true) && uuid(o.addedBy) && Object.keys(o).length === 3)
    && new Set(b.options.map((o: any) => o.id)).size === b.options.length
    && (b.mode !== 'plan-review' || (b.options.length === PLAN_REVIEW_OPTIONS.length
      && PLAN_REVIEW_OPTIONS.every((o, i) => b.options[i].id === o.id && b.options[i].label === o.label)))
    && (typeof b.askAgents === 'boolean' || (Array.isArray(b.askAgents) && b.askAgents.length <= 16 && b.askAgents.every(uuid)))
    && (b.closesAt === null || (Number.isSafeInteger(b.closesAt) && b.closesAt > 0)) && ['open', 'closed', 'withdrawn'].includes(b.state)
    && (b.state === 'closed' ? validOutcome(b.outcome) && validCounted(b.counted) : b.outcome === undefined && b.counted === undefined)
    && (b.revision !== 1 || b.memberId === b.createdBy);
}
function validCounted(c: any) {
  return Array.isArray(c) && c.length <= 256 && c.every((v: any) => v && uuid(v.vote) && uuid(v.memberId) && optionId(v.optionId) && Object.keys(v).length === 3)
    && new Set(c.map((v: any) => v.memberId)).size === c.length;
}
export function validVoteBody(b: any, roomId: string): b is VoteBody {
  return stamp(b, roomId) && b.kind === 'vote' && (b.optionId === null || optionId(b.optionId)) && text(b.comment, 500);
}

const order = (a: { revision: number; id: string }, b: { revision: number; id: string }) => a.revision - b.revision || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sameOption = (a: DecisionOption, b: DecisionOption) => a.id === b.id && a.label === b.label && a.addedBy === b.addedBy;
/** Who may change a decision's terms or close it: its creator, the creator's operator, or the host. */
function steward(room: RoomMembers, creator: string, memberId: string) {
  if (memberId === creator || memberId === room.ownerId) return true;
  return room.members.some(m => m.id === creator && m.role === 'agent' && m.operatorId === memberId);
}

/**
 * Whether a close's outcome follows from the votes it pins: every pinned vote this device holds matches and is that
 * person's latest vote here (so an older, changed vote can't be pinned), no pinned voter is a known agent, and the tally,
 * voters and result are exactly what those votes give. `people` only describes the room when it closed (it never decides
 * the result), so it is checked for sense, not against today's membership, which would unsettle past outcomes.
 */
function honestClose(next: DecisionBody, held: Map<string, VoteBody>, latest: Map<string, VoteBody>, room: RoomMembers) {
  const counted = next.counted!, outcome = next.outcome!;
  if (outcome.people < counted.length) return false;
  for (const c of counted) {
    const vote = held.get(c.vote);
    if (vote && (vote.memberId !== c.memberId || vote.optionId !== c.optionId || vote.decisionId !== next.decisionId || vote.createdBy !== next.createdBy)) return false;
    const newest = latest.get(`${next.createdBy}:${next.decisionId}:${c.memberId}`);
    if (newest && newest.id !== c.vote && (!vote || order(vote, newest) < 0)) return false;
    // Agents never count as people, including ones who have since left; members who left before roles were recorded stay accepted.
    if (room.members.some(m => m.id === c.memberId && m.role === 'agent') || room.former?.some(m => m.id === c.memberId && m.role === 'agent')) return false;
    if (!next.options.some(o => o.id === c.optionId)) return false;
  }
  const expected = tallyVotes(next.options, counted.map(c => ({ op: c.vote, memberId: c.memberId, optionId: c.optionId, comment: '', at: 0, counts: true })), outcome.people).tally;
  return JSON.stringify(expected.tally) === JSON.stringify(outcome.tally) && expected.voters === outcome.voters && expected.result === outcome.result
    && JSON.stringify([...expected.optionIds].sort()) === JSON.stringify([...outcome.optionIds].sort());
}

/** Whether `next` may follow `current`: options only grow, only stewards change the terms or close, and closing is final and honest. */
function extends_(current: DecisionBody, next: DecisionBody, room: RoomMembers, held: Map<string, VoteBody>, latest: Map<string, VoteBody>) {
  if (next.state === 'closed' && !honestClose(next, held, latest, room)) return false;
  if (current.state !== 'open' || next.revision !== current.revision + 1 || next.mode !== current.mode) return false;
  if (next.options.length < current.options.length || !current.options.every((o, i) => sameOption(o, next.options[i]))) return false;
  const added = next.options.slice(current.options.length);
  if (added.length && (current.mode === 'plan-review' || added.some(o => o.addedBy !== next.memberId))) return false;
  const terms = next.question !== current.question || next.context !== current.context || next.closesAt !== current.closesAt
    || JSON.stringify(next.askAgents) !== JSON.stringify(current.askAgents) || next.state !== 'open';
  // Stewardship follows the creator, never whoever signed the latest revision (e.g. by adding an option).
  return !terms || steward(room, current.createdBy, next.memberId);
}

/** People's votes so far, and whether the result can no longer change (everyone voted, or the leader can't be caught). */
export function tallyVotes(options: DecisionOption[], votes: Vote[], people: number): { tally: Outcome; settled: boolean } {
  const counts: Record<string, number> = Object.fromEntries(options.map(o => [o.id, 0]));
  const cast = votes.filter(v => v.counts && v.optionId && v.optionId in counts);
  for (const v of cast) counts[v.optionId!]++;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [first, second] = [ranked[0]?.[1] ?? 0, ranked[1]?.[1] ?? 0];
  const leaders = ranked.filter(([, n]) => n === first && n > 0).map(([id]) => id);
  const remaining = Math.max(0, people - cast.length);
  const result: Outcome['result'] = !cast.length ? 'no-votes' : leaders.length > 1 ? 'draw' : 'decided';
  return { tally: { result, optionIds: result === 'no-votes' ? [] : leaders, tally: counts, voters: cast.length, people },
    settled: people > 0 && (remaining === 0 || first - second > remaining) };
}

/** The current decisions, oldest first. Votes from people count; agents' votes are advice. */
export function foldDecisions(ops: (DecisionBody | VoteBody)[], room: RoomMembers): Decision[] {
  const people = room.members.filter(m => (m.role ?? 'human') === 'human');
  const roleOf = (id: string) => room.members.find(m => m.id === id)?.role ?? (room.members.some(m => m.id === id) ? 'human' : undefined);
  const chains = new Map<string, DecisionBody[]>(), ballots = new Map<string, VoteBody>(), held = new Map<string, VoteBody>();
  for (const op of ops) {
    const key = `${op.createdBy}:${op.decisionId}`;
    if (op.kind === 'decision') chains.set(key, [...(chains.get(key) || []), op]);
    else { held.set(op.id, op); const ballot = `${key}:${op.memberId}`, seen = ballots.get(ballot); if (!seen || order(seen, op) < 0) ballots.set(ballot, op); }
  }
  const decisions: Decision[] = [];
  for (const [key, chain] of chains) {
    chain.sort(order);
    const first = chain[0];
    if (first.revision !== 1 || first.state !== 'open' || first.memberId !== first.createdBy) continue;
    let current = first;
    for (const op of chain.slice(1)) if (extends_(current, op, room, held, ballots)) current = op;
    const votes: Vote[] = [...ballots.values()].filter(v => `${v.createdBy}:${v.decisionId}` === key && roleOf(v.memberId) !== undefined
      && (v.optionId === null || current.options.some(o => o.id === v.optionId)))
      .map(v => ({ op: v.id, memberId: v.memberId, optionId: v.optionId, comment: v.comment, at: v.at, counts: roleOf(v.memberId) === 'human' }));
    const live = tallyVotes(current.options, votes, people.length);
    const pinned = new Set((current.counted || []).map(c => c.vote));
    decisions.push({ key, id: first.decisionId, question: current.question, context: current.context, mode: current.mode, options: current.options, askAgents: current.askAgents,
      closesAt: current.closesAt, state: current.state, ...(current.outcome ? { outcome: current.outcome } : {}), createdBy: first.memberId, createdAt: first.at,
      updatedAt: current.at, revision: current.revision, votes, tally: current.outcome ?? live.tally, settled: current.state !== 'open' || live.settled,
      verified: [...pinned].every(op => held.has(op)),
      uncounted: current.state === 'closed' ? votes.filter(v => v.counts && v.optionId !== null && !pinned.has(v.op)).length : 0 });
  }
  return decisions.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Whether a steward's device should close a decision now: a majority is reached (the result can no longer change) or the deadline passed. */
export function due(decision: Decision, now: number) { return decision.state === 'open' && (decision.settled || (decision.closesAt !== null && now >= decision.closesAt)); }

type Author = { roomId: string; deviceId: string; memberId: string };
const stampOf = (a: Author) => ({ roomId: a.roomId, id: crypto.randomUUID(), deviceId: a.deviceId, memberId: a.memberId, at: Date.now() });

/** A new decision. Plan reviews always offer Approve / Request changes / Reject. */
export function openDecision(a: Author & { question: string; context?: string; mode?: DecisionMode; options?: string[]; askAgents?: boolean | string[]; closesAt?: number | null; decisionId?: string }): DecisionBody {
  const mode = a.mode ?? 'choice';
  const labels = mode === 'plan-review' ? PLAN_REVIEW_OPTIONS : (a.options || []).map((label, i) => ({ id: `o${i + 1}`, label: label.trim() }));
  const body: DecisionBody = { kind: 'decision', ...stampOf(a), createdBy: a.memberId, decisionId: a.decisionId ?? crypto.randomUUID(), revision: 1, question: a.question.trim(), context: (a.context || '').trim(),
    mode, options: labels.map(o => ({ ...o, addedBy: a.memberId })), askAgents: a.askAgents ?? false, closesAt: a.closesAt ?? null, state: 'open' };
  if (!validDecisionBody(body, a.roomId)) throw new Error('Ask a question of up to 200 characters with 2 to 8 distinct options of up to 120 characters.');
  return body;
}
/** The next revision of a decision: an added option, or closing it with the tally as this device sees it. */
export function reviseDecision(a: Author, current: Decision, change: { addOption?: string; close?: boolean; withdraw?: boolean }): DecisionBody {
  if (change.addOption !== undefined && current.mode === 'plan-review') throw new Error('Plan reviews keep Approve / Request changes / Reject.');
  const options = change.addOption ? [...current.options, { id: crypto.randomUUID().slice(0, 8), label: change.addOption.trim(), addedBy: a.memberId }] : current.options;
  const state: DecisionState = change.withdraw ? 'withdrawn' : change.close ? 'closed' : 'open';
  // A close pins the people's votes it counted, so every device can check the outcome adds up.
  const counted: Counted[] = current.votes.filter(v => v.counts && v.optionId !== null).map(v => ({ vote: v.op, memberId: v.memberId, optionId: v.optionId! }));
  const body: DecisionBody = { kind: 'decision', ...stampOf(a), createdBy: current.createdBy, decisionId: current.id, revision: current.revision + 1, question: current.question,
    context: current.context, mode: current.mode, options, askAgents: current.askAgents, closesAt: current.closesAt, state,
    ...(state === 'closed' ? { outcome: current.tally, counted } : {}) };
  if (!validDecisionBody(body, a.roomId)) throw new Error('Options have up to 120 characters, and a decision has at most 8.');
  return body;
}
/** A vote (or `null` to take it back), with a short reason. The latest revision per member counts. */
export function castVote(a: Author, decision: Decision, optionId: string | null, comment = '', revision = 1): VoteBody {
  if (decision.state !== 'open') throw new Error('This decision is closed.');
  if (optionId !== null && !decision.options.some(o => o.id === optionId)) throw new Error('That option is not part of this decision.');
  const body: VoteBody = { kind: 'vote', ...stampOf(a), createdBy: decision.createdBy, decisionId: decision.id, revision, optionId, comment: comment.trim() };
  if (!validVoteBody(body, a.roomId)) throw new Error('Keep the reason to 500 characters.');
  return body;
}
/** The next vote revision for a member, so a changed vote always replaces the earlier one. */
export const nextVoteRevision = (ops: (DecisionBody | VoteBody)[], decision: Pick<Decision, 'id' | 'createdBy'>, memberId: string) =>
  1 + Math.max(0, ...ops.filter(o => o.kind === 'vote' && o.decisionId === decision.id && o.createdBy === decision.createdBy && o.memberId === memberId).map(o => o.revision));

/**
 * Which incoming operations a device keeps: votes only for decisions it holds (or that arrive alongside them), and at
 * most MAX_MEMBER_DECISION_OPS per member, so one member can't fill the room's shared cap.
 */
export function admissible(held: (DecisionBody | VoteBody)[], incoming: (DecisionBody | VoteBody)[]) {
  const known = new Set(held.filter(o => o.kind === 'decision').map(o => `${o.createdBy}:${o.decisionId}`));
  const per = new Map<string, number>(); for (const o of held) per.set(o.memberId, (per.get(o.memberId) ?? 0) + 1);
  const share = (o: DecisionBody | VoteBody) => { const n = per.get(o.memberId) ?? 0; if (n >= MAX_MEMBER_DECISION_OPS) return false; per.set(o.memberId, n + 1); return true; };
  // Decisions first, so only those admitted under the cap make their votes admissible.
  const admitted = new Set<DecisionBody | VoteBody>();
  for (const o of incoming) if (o.kind === 'decision' && share(o)) { admitted.add(o); known.add(`${o.createdBy}:${o.decisionId}`); }
  for (const o of incoming) if (o.kind === 'vote' && known.has(`${o.createdBy}:${o.decisionId}`) && share(o)) admitted.add(o);
  return incoming.filter(o => admitted.has(o));
}

/** Split decisions into sync envelopes under the data channel limit. */
export function decisionChunks(roomId: string, ops: DecisionPacket[]): DecisionSync[] {
  const chunks: DecisionSync[] = []; let current: DecisionPacket[] = [], size = 0;
  for (const op of ops) {
    const length = JSON.stringify(op).length;
    if (current.length && size + length > SYNC_CHUNK_CHARS) { chunks.push({ kind: 'decisions', roomId, ops: current }); current = []; size = 0; }
    current.push(op); size += length;
  }
  if (current.length) chunks.push({ kind: 'decisions', roomId, ops: current });
  return chunks;
}

/**
 * What should wake an agent, among operations it received after `after` (a position in its arrival-ordered list):
 * decisions asking for its advice that it hasn't given, and its own decisions that just closed (wake on consensus).
 */
export function decisionWakes(ops: (DecisionBody | VoteBody)[], room: RoomMembers, agentId: string, after: number) {
  const decisions = foldDecisions(ops, room), fresh = ops.slice(after);
  const mine = (o: DecisionBody | VoteBody, d: Decision) => o.kind === 'decision' && o.decisionId === d.id && o.createdBy === d.createdBy;
  const asked = decisions.filter(d => d.state === 'open' && d.createdBy !== agentId && (d.askAgents === true || (Array.isArray(d.askAgents) && d.askAgents.includes(agentId)))
    && !d.votes.some(v => v.memberId === agentId) && fresh.some(o => mine(o, d)));
  // Wake on a verified outcome only; a close whose pinned votes are still arriving wakes once the last of them lands.
  const pinned = (d: Decision) => new Set(ops.filter(o => mine(o, d) && (o as DecisionBody).state === 'closed').flatMap(o => (o as DecisionBody).counted?.map(c => c.vote) ?? []));
  const resolved = decisions.filter(d => d.state === 'closed' && d.verified && d.createdBy === agentId
    && fresh.some(o => (mine(o, d) && (o as DecisionBody).state === 'closed') || (o.kind === 'vote' && pinned(d).has(o.id))));
  const withdrawn = decisions.filter(d => d.state === 'withdrawn' && d.createdBy === agentId && fresh.some(o => mine(o, d) && (o as DecisionBody).state === 'withdrawn'));
  return { asked, resolved, withdrawn };
}
