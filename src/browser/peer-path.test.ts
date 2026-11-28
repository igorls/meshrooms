import { expect, test } from 'bun:test';
import { pathOf } from './peers';

const report = (...entries: Record<string, unknown>[]) => new Map(entries.map(e => [e.id as string, e])) as unknown as RTCStatsReport;
const candidates = (local: string, remote: string) => [
  { id: 'L', type: 'local-candidate', candidateType: local }, { id: 'R', type: 'remote-candidate', candidateType: remote }];

test('the selected pair decides: direct between the devices, or through TURN when either end is a relay candidate', () => {
  // Chrome names the pair on the transport.
  const chrome = (local: string, remote: string) => report({ id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded' },
    { id: 'X', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R', state: 'failed' }, ...candidates(local, remote));
  expect(pathOf(chrome('host', 'srflx'))).toBe('direct');
  expect(pathOf(chrome('srflx', 'prflx'))).toBe('direct');
  expect(pathOf(chrome('relay', 'host'))).toBe('turn');
  expect(pathOf(chrome('host', 'relay'))).toBe('turn');
  // Firefox marks it selected.
  expect(pathOf(report({ id: 'P', type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' }, ...candidates('relay', 'srflx')))).toBe('turn');
  // Firefox after a switch: an earlier pair is still nominated and succeeded, but the selected one is in use.
  expect(pathOf(report({ id: 'P0', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L0', remoteCandidateId: 'R' },
    { id: 'P', type: 'candidate-pair', selected: true, nominated: true, state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'L0', type: 'local-candidate', candidateType: 'host' }, ...candidates('relay', 'srflx')))).toBe('turn');
  // No pair marked at all: a nominated, succeeded pair stands in.
  expect(pathOf(report({ id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' }, ...candidates('host', 'relay')))).toBe('turn');
  // Nothing to tell from: an open channel counts as direct.
  expect(pathOf(report())).toBe('direct');
});
