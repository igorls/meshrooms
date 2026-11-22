import { describe, expect, test } from 'bun:test';
import { flushOutbox } from '../browser-agent';
import {
  CONNECT_TIMEOUT_MS, UNHEALTHY_GRACE_MS, answerMatchesOffer, dedupeSignals, evaluatePeerHealth, nextPollBackoff, parseRetryAfter,
} from '../../src/browser/pacer';

const roomId = crypto.randomUUID(), me = crypto.randomUUID();
const self = 'a'.repeat(64), peer = 'b'.repeat(64), gone = 'c'.repeat(64);
const own = (i: number, targets = [peer], receipts: string[] = []) => ({
  packet: { body: { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: self, memberId: me, text: `mine ${i}`, at: i + 1 }, signature: 'x' }, targets, receipts });

describe('bridge outbox (SYNC-2, AGT-4)', () => {
  test('flush sends at most 16 per peer per tick, waits for a full send buffer, and survives a failing channel', () => {
    const messages = Array.from({ length: 40 }, (_, i) => own(i));
    const sent: string[] = [], logs: string[] = [];
    const channel = { readyState: 'open', bufferedAmount: 0, send: (text: string) => { sent.push(text); } };
    const broken = { readyState: 'open', bufferedAmount: 0, send: () => { throw new Error('channel closed'); } };
    const peers = new Map([[peer, { channel, sent: new Map<string, number>() }], [gone, { channel: broken, sent: new Map<string, number>() }]]);
    flushOutbox(messages.map(m => ({ ...m, targets: [peer, gone] })), self, peers, line => logs.push(line), 1_000_000);
    expect(sent).toHaveLength(16);
    expect(logs).toEqual([`send to ${gone.slice(0, 8)} failed: channel closed`]);
    // The next tick moves on to the next 16 instead of resending the first ones.
    flushOutbox(messages, self, peers, () => {}, 1_001_000);
    expect(new Set(sent).size).toBe(32);
    // A confirmed message is not sent again; after five seconds an unconfirmed one is.
    const confirmed = messages.map((m, i) => i < 8 ? { ...m, receipts: [peer] } : m);
    sent.length = 0;
    flushOutbox(confirmed, self, peers, () => {}, 1_006_000);
    expect(sent.map(t => JSON.parse(t).body.text)).toEqual(Array.from({ length: 16 }, (_, i) => `mine ${i + 8}`));
    // A full send buffer holds everything until it drains.
    sent.length = 0; channel.bufferedAmount = 300_000;
    flushOutbox(messages, self, peers, () => {}, 2_000_000);
    expect(sent).toHaveLength(0);
  });
});

describe('WebRTC signaling, health, and 429 backoff helpers (SYNC-5, OPS-11)', () => {
  test('evaluatePeerHealth tracks unhealthySince separately from started and drops zombies immediately', () => {
    const state = { connectionState: 'connected', iceConnectionState: 'connected', channelState: 'open', started: 0, openedOnce: false as boolean | undefined, unhealthySince: undefined as number | undefined };
    expect(evaluatePeerHealth(state, 1_000)).toBe('healthy');
    expect(state.openedOnce).toBe(true);
    expect(state.unhealthySince).toBeUndefined();

    // 2 hours later, drops to disconnected: gets UNHEALTHY_GRACE_MS from unhealthySince instead of dropping on started!
    const later = 2 * 3_600_000;
    state.connectionState = 'disconnected';
    expect(evaluatePeerHealth(state, later)).toBe('grace');
    expect(state.unhealthySince).toBe(later);
    expect(evaluatePeerHealth(state, later + UNHEALTHY_GRACE_MS)).toBe('grace');
    expect(evaluatePeerHealth(state, later + UNHEALTHY_GRACE_MS + 1)).toBe('drop');

    // Zombie connected PC with closed DataChannel drops immediately.
    const zombie = { connectionState: 'connected', iceConnectionState: 'connected', channelState: 'closed', started: later, openedOnce: true };
    expect(evaluatePeerHealth(zombie, later)).toBe('drop');

    // Never-opened peer drops after CONNECT_TIMEOUT_MS.
    const pending = { connectionState: 'connecting', iceConnectionState: 'checking', channelState: 'connecting', started: 100 };
    expect(evaluatePeerHealth(pending, 100 + CONNECT_TIMEOUT_MS)).toBe('grace');
    expect(evaluatePeerHealth(pending, 100 + CONNECT_TIMEOUT_MS + 1)).toBe('drop');
  });

  test('dedupeSignals keeps newest seq per sender/session/type and answerMatchesOffer rejects stale or mismatched answers', () => {
    const available = [{ id: 'devA', session: 's1' }];
    const deduped = dedupeSignals([
      { seq: 1, from: 'devA', session: 's1', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:u1\r\n' } },
      { seq: 3, from: 'devA', session: 's1', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:u3\r\n' } },
      { seq: 2, from: 'devA', session: 's1', description: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:a2\r\n' } },
      { seq: 4, from: 'devA', session: 'old', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:old\r\n' } },
    ], available);
    expect(deduped.map(s => s.seq)).toEqual([2, 3]);

    const offerSdp = 'v=0\r\na=ice-ufrag:offer1\r\na=mid:0\r\n';
    expect(answerMatchesOffer(offerSdp, 'v=0\r\na=ice-ufrag:ans1\r\na=mid:0\r\n')).toBe(true);
    expect(answerMatchesOffer(offerSdp, 'v=0\r\na=mid:0\r\n')).toBe(false); // missing ice-ufrag
    expect(answerMatchesOffer(offerSdp, 'v=0\r\na=ice-ufrag:ans1\r\na=mid:1\r\n')).toBe(false); // mismatched mid
    expect(answerMatchesOffer(offerSdp, 'v=0\r\na=ice-ufrag:retired1\r\na=mid:0\r\n', new Set(['retired1']))).toBe(false); // retired remote ufrag
    expect(answerMatchesOffer(offerSdp, 'v=0\r\na=ice-ufrag:prev1\r\na=mid:0\r\n', undefined, 'v=0\r\na=ice-ufrag:prev1\r\n')).toBe(false); // unchanged remote ufrag on restart
  });

  test('parseRetryAfter and nextPollBackoff honor Retry-After and cap exponential backoff at 30 s', () => {
    expect(parseRetryAfter('5')).toBe(5_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(10_000);
    expect(parseRetryAfter('invalid')).toBeUndefined();
    expect(nextPollBackoff(0)).toBe(2_000);
    expect(nextPollBackoff(2_000)).toBe(4_000);
    expect(nextPollBackoff(4_000, 12_000)).toBe(12_000);
    expect(nextPollBackoff(16_000)).toBe(30_000);
    expect(nextPollBackoff(0, 90_000)).toBe(30_000);
  });
});
