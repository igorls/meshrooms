import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { testDirectory } from './test-directory';
import {
  appendOwnedAllow,
  confirmShareReload,
  createShareRecord,
  enforceShareExpiry,
  expireShareRecord,
  findAmbiguousPeerAllow,
  findBroaderAllows,
  findPrecedingDeny,
  hexToBase64Pubkey,
  isShareExpired,
  markSharePendingDisable,
  ownershipMarker,
  parseOwnershipMarker,
  parsePolicyFile,
  peerPolicyPath,
  peerPolicyStem,
  readShareRecord,
  removeOwnedRules,
  resolveSharePeerKey,
  ruleCoversTcpPort,
  validateMeshIp,
  validatePort,
  writeShareRecord,
} from './share';

const peerKey = 'a'.repeat(64);
const otherKey = 'b'.repeat(64);

test('validatePort accepts 1–65535 integers only', () => {
  expect(validatePort(1)).toBe(1);
  expect(validatePort('65535')).toBe(65535);
  expect(() => validatePort(0)).toThrow('1 and 65535');
  expect(() => validatePort(65536)).toThrow('1 and 65535');
  expect(() => validatePort(22.5)).toThrow('1 and 65535');
});

test('ownership markers round-trip and attach to the following allow', () => {
  const id = randomUUID();
  expect(parseOwnershipMarker(ownershipMarker(id))).toBe(id);
  expect(parseOwnershipMarker('# comment')).toBeUndefined();
  const rules = parsePolicyFile(`${ownershipMarker(id)}\nallow tcp 4173\n# noise\nallow tcp 22\n`);
  expect(rules).toHaveLength(2);
  expect(rules[0]).toMatchObject({ action: 'allow', portMin: 4173, portMax: 4173, ownershipId: id });
  expect(rules[1].ownershipId).toBeUndefined();
  expect(ruleCoversTcpPort(rules[0], 4173)).toBe(true);
  expect(ruleCoversTcpPort({ proto: 'udp', portMin: 4173, portMax: 4173 }, 4173)).toBe(false);
  expect(ruleCoversTcpPort({ proto: 'all', portMin: 4000, portMax: 5000 }, 4173)).toBe(true);
});

test('broader-allow detection covers default, global, org, and other peer allows', () => {
  const directory = testDirectory('share-broader');
  try {
    const config = join(directory.path, 'meshguard');
    const services = join(config, 'services');
    mkdirSync(join(services, 'peer'), { recursive: true });
    mkdirSync(join(services, 'org'), { recursive: true });
    const stem = peerPolicyStem(peerKey);

    writeFileSync(join(services, 'default'), 'allow\n');
    expect(findBroaderAllows(config, 4173, stem).some(item => item.scope === 'default')).toBe(true);

    writeFileSync(join(services, 'default'), 'deny\n');
    expect(findBroaderAllows(config, 4173, stem)).toEqual([]);

    writeFileSync(join(services, 'global.policy'), 'allow tcp 4173\n');
    expect(findBroaderAllows(config, 4173, stem).map(item => item.scope)).toContain('global');
    writeFileSync(join(services, 'global.policy'), 'deny tcp 4173\n');
    expect(findBroaderAllows(config, 4173, stem)).toEqual([]);

    writeFileSync(join(services, 'org', 'team.policy'), 'allow tcp 4000-4200\n');
    expect(findBroaderAllows(config, 4173, stem).some(item => item.scope === 'org')).toBe(true);
    writeFileSync(join(services, 'org', 'team.policy'), 'deny all\n');

    const otherStem = peerPolicyStem(otherKey);
    writeFileSync(peerPolicyPath(config, otherStem), 'allow tcp 4173\n');
    expect(findBroaderAllows(config, 4173, stem).some(item => item.scope === 'peer')).toBe(true);

    // Paired peer's own allow is not "broader".
    writeFileSync(peerPolicyPath(config, otherStem), 'deny tcp 4173\n');
    writeFileSync(peerPolicyPath(config, stem), 'allow tcp 4173\n');
    expect(findBroaderAllows(config, 4173, stem)).toEqual([]);
  } finally { directory.cleanup(); }
});

test('owned allow write/remove keeps unmarked hand-written rules', () => {
  const directory = testDirectory('share-owned');
  try {
    const config = join(directory.path, 'meshguard');
    mkdirSync(join(config, 'services'), { recursive: true });
    writeFileSync(join(config, 'services', 'default'), 'deny\n');
    const stem = peerPolicyStem(peerKey);
    const path = peerPolicyPath(config, stem);
    mkdirSync(join(config, 'services', 'peer'), { recursive: true });
    writeFileSync(path, 'allow tcp 22\n');

    expect(findAmbiguousPeerAllow(config, stem, 22)?.raw).toBe('allow tcp 22');
    expect(findAmbiguousPeerAllow(config, stem, 4173)).toBeUndefined();

    const owned = appendOwnedAllow(config, stem, 4173);
    const afterWrite = readFileSync(path, 'utf8');
    expect(afterWrite).toContain('allow tcp 22');
    expect(afterWrite).toContain(ownershipMarker(owned.id));
    expect(afterWrite).toContain('allow tcp 4173');
    expect(findAmbiguousPeerAllow(config, stem, 4173)).toBeUndefined();
    expect(() => appendOwnedAllow(config, stem, 22)).toThrow('unmarked allow');

    removeOwnedRules([owned]);
    expect(readFileSync(path, 'utf8')).toBe('allow tcp 22\n');
  } finally { directory.cleanup(); }
});

test('share record status transitions stay local and honest about reload lag', () => {
  const directory = testDirectory('share-status');
  try {
    const owned = { id: randomUUID(), path: '/tmp/unused.policy', line: 'allow tcp 4173' };
    let record = createShareRecord({
      roomId: randomUUID(), port: 4173, peerKey, meshIp: '10.99.0.1', minutes: 15, ownedRules: [owned],
    });
    expect(record.status).toBe('pending-enable');
    expect(record.url).toBe('http://10.99.0.1:4173/');
    expect(Date.parse(record.expiresAt) - Date.parse(record.startedAt)).toBe(15 * 60_000);

    writeShareRecord(directory.path, record);
    expect(readShareRecord(directory.path, record.roomId)).toEqual(record);

    record = confirmShareReload(record);
    expect(record.status).toBe('active');
    record = markSharePendingDisable(record);
    expect(record.status).toBe('pending-disable');
    expect(record.ownedRules).toEqual([]);
    record = confirmShareReload(record);
    expect(record.status).toBe('stopped');
  } finally { directory.cleanup(); }
});

test('peer policy stems use MeshGuard base64 (or alias), not hex filenames', () => {
  expect(hexToBase64Pubkey(peerKey)).toBe(Buffer.from(peerKey, 'hex').toString('base64'));
  expect(peerPolicyStem(peerKey)).toBe(hexToBase64Pubkey(peerKey));
  expect(peerPolicyStem(peerKey, 'node-b')).toBe('node-b');
  expect(() => peerPolicyStem(peerKey, '../x')).toThrow('peer-alias');
});

test('validateMeshIp requires four octets in 0–255', () => {
  expect(validateMeshIp('10.99.0.1')).toBe('10.99.0.1');
  expect(validateMeshIp('0.0.0.0')).toBe('0.0.0.0');
  expect(validateMeshIp('255.255.255.255')).toBe('255.255.255.255');
  expect(() => validateMeshIp('999.999.999.999')).toThrow('IPv4');
  expect(() => validateMeshIp('10.99.0')).toThrow('IPv4');
  expect(() => validateMeshIp('10.99.0.1.2')).toThrow('IPv4');
  expect(() => validateMeshIp('10.99.0.256')).toThrow('IPv4');
  expect(() => validateMeshIp('10.99.-1.1')).toThrow('IPv4');
  expect(() => createShareRecord({
    roomId: randomUUID(), port: 4173, peerKey, meshIp: '999.1.1.1', ownedRules: [],
  })).toThrow('IPv4');
});

test('preceding peer deny blocks an unreachable owned allow', () => {
  const directory = testDirectory('share-deny');
  try {
    const config = join(directory.path, 'meshguard');
    mkdirSync(join(config, 'services', 'peer'), { recursive: true });
    writeFileSync(join(config, 'services', 'default'), 'deny\n');
    const stem = peerPolicyStem(peerKey);
    const path = peerPolicyPath(config, stem);

    writeFileSync(path, 'deny all\n');
    expect(findPrecedingDeny(config, stem, 4173)?.raw).toBe('deny all');
    expect(() => appendOwnedAllow(config, stem, 4173)).toThrow('unreachable');

    writeFileSync(path, 'deny tcp 4173\n');
    expect(() => appendOwnedAllow(config, stem, 4173)).toThrow('unreachable');

    writeFileSync(path, 'deny tcp all\n');
    expect(() => appendOwnedAllow(config, stem, 4173)).toThrow('unreachable');

    writeFileSync(path, 'allow tcp 22\ndeny tcp 4173\n');
    expect(() => appendOwnedAllow(config, stem, 4173)).toThrow('unreachable');

    writeFileSync(path, 'allow tcp 22\n');
    const owned = appendOwnedAllow(config, stem, 4173);
    expect(readFileSync(path, 'utf8')).toContain('allow tcp 4173');
    removeOwnedRules([owned]);
  } finally { directory.cleanup(); }
});

test('expired pending-enable and active shares remove owned rules', () => {
  const directory = testDirectory('share-expiry');
  try {
    const config = join(directory.path, 'meshguard');
    mkdirSync(join(config, 'services'), { recursive: true });
    writeFileSync(join(config, 'services', 'default'), 'deny\n');
    const stem = peerPolicyStem(peerKey);
    const owned = appendOwnedAllow(config, stem, 4173);
    const roomId = randomUUID();
    const past = new Date(Date.now() - 60_000).toISOString();
    let record = createShareRecord({
      roomId, port: 4173, peerKey, meshIp: '10.99.0.1', minutes: 30, ownedRules: [owned],
    });
    record = { ...record, startedAt: past, expiresAt: past };
    expect(isShareExpired(record)).toBe(true);
    writeShareRecord(directory.path, record);

    const expired = enforceShareExpiry(directory.path, roomId)!;
    expect(expired.status).toBe('stopped');
    expect(expired.ownedRules).toEqual([]);
    expect(existsSync(peerPolicyPath(config, stem)) && readFileSync(peerPolicyPath(config, stem), 'utf8').includes('allow tcp 4173')).toBe(false);

    const ownedActive = appendOwnedAllow(config, stem, 4173);
    let active = createShareRecord({
      roomId: randomUUID(), port: 4173, peerKey, meshIp: '10.99.0.1', minutes: 30, ownedRules: [ownedActive],
    });
    active = confirmShareReload({ ...active, startedAt: past, expiresAt: past });
    expect(active.status).toBe('active');
    expect(isShareExpired(active)).toBe(true);
    const after = expireShareRecord(active);
    expect(after.status).toBe('pending-disable');
    expect(after.ownedRules).toEqual([]);
    expect(existsSync(peerPolicyPath(config, stem)) && readFileSync(peerPolicyPath(config, stem), 'utf8').includes('allow tcp 4173')).toBe(false);
  } finally { directory.cleanup(); }
});

test('resolveSharePeerKey requires an explicit key to match a known pair', () => {
  expect(resolveSharePeerKey(undefined, peerKey)).toBe(peerKey);
  expect(resolveSharePeerKey(peerKey, peerKey)).toBe(peerKey);
  expect(() => resolveSharePeerKey(otherKey, peerKey)).toThrow('matches the peer paired');
  expect(resolveSharePeerKey(peerKey, undefined)).toBe(peerKey);
  expect(() => resolveSharePeerKey(undefined, undefined)).toThrow('peer-key');
});
