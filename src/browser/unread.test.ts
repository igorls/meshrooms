import { beforeEach, describe, expect, test } from 'bun:test';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { WAITING_REFRESH_MS, WAITING_TTL_MS, badgeText, clearWaiting, countUnread, freshRequests, joinNotice, loadReadPosition, onCountsChanged, publishCount, publishedCounts, readPosition, saveReadPosition, tabTitle, unreadLabel, waitingLabel, waitingOf, type UnreadBody, type UnreadCount } from './unread';
import type { JoinRequest } from './protocol';
import type { BrowserMember } from './protocol';

installFakeIndexedDB();
/** A localStorage stand-in: Bun has none. */
class MemoryStorage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  key(i: number) { return [...this.items.keys()][i] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}
const memory = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memory });
beforeEach(() => { fakeStorage.records.clear(); memory.clear(); });

const members: BrowserMember[] = [
  { id: 'me', name: 'Alex' }, { id: 'sam', name: 'Sam' }, { id: 'bot', name: 'Helper', role: 'agent', operatorId: 'sam' },
] as BrowserMember[];
let serial = 0;
const message = (memberId: string, text = 'hello', replyTo?: string): UnreadBody => ({ id: `m${++serial}`, memberId, text, ...(replyTo ? { replyTo } : {}) });

describe('unread counts', () => {
  test('counts messages by others after the read position, never your own', () => {
    const a = message('sam'), b = message('me'), c = message('sam'), d = message('bot'), e = message('me');
    const all = [a, b, c, d, e];
    expect(countUnread(all, { id: b.id, at: 0 }, 'me', members)).toEqual({ unread: 2, mentions: 0 });
    expect(countUnread(all, { id: e.id, at: 0 }, 'me', members)).toEqual({ unread: 0, mentions: 0 });
    // Nothing read yet: every message by others counts.
    expect(countUnread(all, { at: 0 }, 'me', members)).toEqual({ unread: 3, mentions: 0 });
  });

  test('a position the rolling window evicted counts everything still stored', () => {
    const kept = [message('sam'), message('sam'), message('me')];
    expect(countUnread(kept, { id: 'evicted-long-ago', at: 0 }, 'me', members)).toEqual({ unread: 2, mentions: 0 });
  });

  test('mentions are @names of this person and replies to their messages', () => {
    const mine = message('me', 'my question');
    const all = [
      mine,
      message('sam', 'hey @alex, look'), // mention
      message('sam', 'reply to you', mine.id), // reply to my message
      message('sam', '@agents please check'), // for agents, not me
      message('sam', 'email alex@example.com'), // not a mention
      message('bot', '@Alex done'), // an agent mentioning me counts too
      message('me', '@alex note to self'), // my own never counts
    ];
    expect(countUnread(all, { id: mine.id, at: 0 }, 'me', members)).toEqual({ unread: 5, mentions: 3 });
    // A reply to someone else's message is not for me.
    const theirs = message('sam', 'their question');
    expect(countUnread([theirs, message('bot', 'answer', theirs.id)], { id: theirs.id, at: 0 }, 'me', members)).toEqual({ unread: 1, mentions: 0 });
  });

  test('screen reader labels, badge text and the tab title', () => {
    expect(unreadLabel(undefined)).toBe('');
    expect(unreadLabel({ unread: 0, mentions: 0 })).toBe('');
    expect(unreadLabel({ unread: 3, mentions: 0 })).toBe('3 unread');
    expect(unreadLabel({ unread: 3, mentions: 1 })).toBe('3 unread, 1 mention');
    expect(unreadLabel({ unread: 4, mentions: 2 })).toBe('4 unread, 2 mentions');
    expect(badgeText(7)).toBe('7'); expect(badgeText(100)).toBe('99+');
    expect(tabTitle('Design review', 0)).toBe('Design review · Meshrooms');
    expect(tabTitle('Design review', 4)).toBe('(4) Design review · Meshrooms');
    expect(tabTitle('', 2)).toBe('(2) Meshrooms');
    expect(tabTitle('', 0)).toBe('Meshrooms');
  });
});

describe('read positions', () => {
  test('the first run baselines at the newest stored message, so older history is not all unread', async () => {
    const history = [message('sam'), message('sam')];
    const position = await readPosition('dev', 'room-1', history);
    expect(position.id).toBe(history[1].id);
    expect(countUnread(history, position, 'me', members).unread).toBe(0);
    // Saved: a later message counts from there.
    const later = message('sam');
    expect(countUnread([...history, later], (await loadReadPosition('dev', 'room-1'))!, 'me', members).unread).toBe(1);
  });

  test('a room with no history starts from the beginning, and saved positions persist per device and room', async () => {
    const empty = await readPosition('dev', 'room-2', []);
    expect(empty.id).toBeUndefined();
    const first = message('sam');
    expect(countUnread([first], (await loadReadPosition('dev', 'room-2'))!, 'me', members).unread).toBe(1);
    await saveReadPosition('dev', 'room-2', first.id);
    expect((await loadReadPosition('dev', 'room-2'))?.id).toBe(first.id);
    expect(await loadReadPosition('other-device', 'room-2')).toBeUndefined();
    expect(await loadReadPosition('dev', 'room-3')).toBeUndefined();
  });
});

const R1 = '11111111-1111-4111-8111-111111111111', R2 = '22222222-2222-4222-8222-222222222222', R3 = '33333333-3333-4333-8333-333333333333', SHOWN = '44444444-4444-4444-8444-444444444444';

describe('counts shared between tabs', () => {
  test('publish, read back per device and clear', () => {
    publishCount('dev', R1, { unread: 3, mentions: 1 });
    publishCount('dev', R2, { unread: 0, mentions: 0 });
    publishCount('other', R1, { unread: 9, mentions: 9 });
    memory.setItem('meshrooms:rail', 'open');
    expect(publishedCounts('dev')).toEqual({ [R1]: { unread: 3, mentions: 1 }, [R2]: { unread: 0, mentions: 0 } });
    publishCount('dev', R1, undefined);
    expect(publishedCounts('dev')).toEqual({ [R2]: { unread: 0, mentions: 0 } });
  });

  test('only room ids shaped like room links are read', () => {
    memory.setItem('meshrooms:unread:dev:r1', JSON.stringify({ unread: 1, mentions: 0 }));
    memory.setItem('meshrooms:unread:dev:../../elsewhere', JSON.stringify({ unread: 1, mentions: 0 }));
    memory.setItem(`meshrooms:unread:dev:${"aaaaaaaa-1111-4111-8111-111111111111".toUpperCase()}`, JSON.stringify({ unread: 1, mentions: 0 }));
    expect(publishedCounts('dev')).toEqual({});
  });

  test('other tabs hear about changes through the storage event', () => {
    let heard = 0;
    const stop = onCountsChanged(() => heard++);
    try {
      dispatchEvent(Object.assign(new Event('storage'), { key: `meshrooms:unread:dev:${R1}` }));
      dispatchEvent(Object.assign(new Event('storage'), { key: 'meshrooms:rail' }));
      dispatchEvent(Object.assign(new Event('storage'), { key: null }));
      expect(heard).toBe(2);
      // This tab's own changes are heard too, once per actual change.
      publishCount('dev', R1, { unread: 1, mentions: 0 });
      publishCount('dev', R1, { unread: 1, mentions: 0 });
      publishCount('dev', R1, undefined);
      publishCount('dev', R1, undefined);
      expect(heard).toBe(4);
    } finally { stop(); }
  });
});

describe('people waiting to join rooms you host', () => {
  const request = (over: Partial<JoinRequest>): JoinRequest => ({ id: crypto.randomUUID(), name: 'Casey', kind: 'person', state: 'pending', expiresAt: Date.now() + 60_000,
    device: { id: 'd', publicKey: 'k', label: 'b', memberId: '', admittedAt: 0 }, ...over } as JoinRequest);

  test('pending requests from room status, named as the host sees them', () => {
    expect(waitingOf(undefined)).toEqual([]);
    expect(waitingOf({ members })).toEqual([]); // Not the host: status lists no requests.
    const person = request({ name: 'x'.repeat(200) }), agent = request({ kind: 'agent', name: 'Helper' });
    const confirmed = request({ kind: 'companion', name: 'Companion device', linkedMemberId: 'me' }), unconfirmed = request({ kind: 'companion', name: 'Companion device' });
    const waiting = waitingOf({ members, requests: [person, agent, confirmed, unconfirmed, request({ state: 'declined' })] });
    expect(waiting.map(w => [w.kind, w.name])).toEqual([['person', 'x'.repeat(80)], ['agent', 'Helper'], ['companion', 'Alex'], ['companion', '']]);
    expect(waiting[0].id).toBe(person.id);
  });

  test('labels, notices and the tab title', () => {
    expect(waitingLabel(0)).toBe(''); expect(waitingLabel(1)).toBe('1 waiting to join'); expect(waitingLabel(3)).toBe('3 waiting to join');
    expect(joinNotice({ id: '1', name: 'Casey', kind: 'person' }, 'Design review')).toBe('Casey asked to join Design review');
    expect(joinNotice({ id: '1', name: 'Helper', kind: 'agent' }, 'Design review')).toBe('Helper, an agent, is waiting to join Design review');
    expect(joinNotice({ id: '1', name: 'Alex', kind: 'companion' }, 'Design review')).toBe('Alex’s new device is waiting to join Design review');
    expect(joinNotice({ id: '1', name: '', kind: 'companion' }, 'Design review')).toBe('A new device is waiting to join Design review');
    // Guest-provided text stays text: the notice is a plain string, rendered as a text node.
    expect(joinNotice({ id: '1', name: '<img src=x onerror=alert(1)>', kind: 'person' }, 'R')).toBe('<img src=x onerror=alert(1)> asked to join R');
    expect(tabTitle('Design review', 0, 1)).toBe('(1 waiting) Design review · Meshrooms');
    expect(tabTitle('Design review', 3, 2)).toBe('(3 · 2 waiting) Design review · Meshrooms');
    expect(tabTitle('', 0, 0)).toBe('Meshrooms');
  });

  test('each new request is announced once, never for the room this tab shows, and only once its room is listed', () => {
    const seen = new Set<string>(), known = new Set([R1]);
    const a = { id: 'a', name: 'Casey', kind: 'person' as const }, b = { id: 'b', name: 'Robin', kind: 'person' as const };
    const c = { id: 'c', name: 'Kim', kind: 'person' as const }, e = { id: 'e', name: 'Sky', kind: 'person' as const };
    const counts: Record<string, UnreadCount> = { [R1]: { unread: 0, mentions: 0, waiting: [a] }, [SHOWN]: { unread: 0, mentions: 0, waiting: [c] }, [R3]: { unread: 0, mentions: 0, waiting: [e] } };
    // Announced the first time this tab sees it (a request already waiting when the tab opens included).
    expect(freshRequests(counts, seen, SHOWN, known)).toEqual([{ roomId: R1, request: a }]);
    expect(freshRequests(counts, seen, SHOWN, known)).toEqual([]);
    // Several at once are all returned, for the notice to queue.
    const d = { id: 'd', name: 'Lee', kind: 'person' as const };
    counts[R1].waiting = [a, b, d];
    counts[SHOWN].waiting = [c, { id: 'f', name: 'Ash', kind: 'person' }];
    expect(freshRequests(counts, seen, SHOWN, known)).toEqual([{ roomId: R1, request: b }, { roomId: R1, request: d }]);
    // R3 isn't in this tab's room list yet: not marked as seen, so it is announced once it is.
    expect(seen.has('e')).toBe(false);
    known.add(R3);
    expect(freshRequests(counts, seen, SHOWN, known)).toEqual([{ roomId: R3, request: e }]);
  });

  test('waiting lists are shared between tabs, checked on the way in', () => {
    const casey = { id: 'a', name: 'Casey', kind: 'person' as const };
    publishCount('dev', R1, { unread: 1, mentions: 0, waiting: [casey] });
    expect(publishedCounts('dev')[R1]).toEqual({ unread: 1, mentions: 0, waiting: [casey] });
    memory.setItem(`meshrooms:unread:dev:${R2}`, JSON.stringify({ unread: 0, mentions: 0, waitingAt: Date.now(), waiting: [
      { id: 1, name: 'x' }, { id: 'b', name: 'y'.repeat(300), kind: 'person' }, { id: 'c', name: 'z', kind: 'admin' }, null,
      { id: 'i'.repeat(65), name: 'long id', kind: 'person' }, { id: '', name: 'empty id', kind: 'person' }, { id: 'i'.repeat(64), name: 'longest id', kind: 'person' }] }));
    expect(publishedCounts('dev')[R2]).toEqual({ unread: 0, mentions: 0, waiting: [{ id: 'b', name: 'y'.repeat(80), kind: 'person' }, { id: 'i'.repeat(64), name: 'longest id', kind: 'person' }] });
    publishCount('dev', R1, { unread: 1, mentions: 0 });
    expect(publishedCounts('dev')[R1]).toEqual({ unread: 1, mentions: 0 });
  });

  test('a waiting list is live only while its owner keeps it fresh, and is cleared when it leaves', () => {
    const casey = { id: 'a', name: 'Casey', kind: 'person' as const };
    const start = 1_000_000;
    publishCount('dev', R1, { unread: 2, mentions: 0, waiting: [casey] }, start);
    expect(publishedCounts('dev', start + WAITING_TTL_MS)[R1].waiting).toEqual([casey]);
    // The owner closed without clearing it (or the browser restarted): the list is ignored, the count stays.
    expect(publishedCounts('dev', start + WAITING_TTL_MS + 1)[R1]).toEqual({ unread: 2, mentions: 0 });
    // An owner still holding the room rewrites an unchanged list once it is WAITING_REFRESH_MS old, not before.
    let heard = 0;
    const stop = onCountsChanged(() => heard++);
    try {
      publishCount('dev', R1, { unread: 2, mentions: 0, waiting: [casey] }, start + WAITING_REFRESH_MS - 1);
      expect(heard).toBe(0);
      publishCount('dev', R1, { unread: 2, mentions: 0, waiting: [casey] }, start + WAITING_REFRESH_MS);
      expect(heard).toBe(1);
      expect(publishedCounts('dev', start + WAITING_REFRESH_MS + WAITING_TTL_MS)[R1].waiting).toEqual([casey]);
    } finally { stop(); }
    // Leaving the room clears who is waiting, and keeps the count.
    clearWaiting('dev', R1);
    expect(publishedCounts('dev')[R1]).toEqual({ unread: 2, mentions: 0 });
  });

  test('a damaged entry hides only itself', () => {
    memory.setItem(`meshrooms:unread:dev:${R1}`, '{not json');
    publishCount('dev', R2, { unread: 2, mentions: 0 });
    expect(publishedCounts('dev')).toEqual({ [R2]: { unread: 2, mentions: 0 } });
    // The next write replaces it.
    publishCount('dev', R1, { unread: 1, mentions: 0 });
    expect(publishedCounts('dev')[R1]).toEqual({ unread: 1, mentions: 0 });
  });
});
