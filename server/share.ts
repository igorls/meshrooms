import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isHash, isUuid } from './model';

export type ShareStatus = 'pending-enable' | 'active' | 'pending-disable' | 'stopped';
export type OwnedRule = { id: string; path: string; line: string };
export type ShareRecord = {
  roomId: string;
  port: number;
  peerKey: string;
  meshIp: string;
  startedAt: string;
  expiresAt: string;
  status: ShareStatus;
  ownedRules: OwnedRule[];
  url: string;
};

export type PolicyAction = 'allow' | 'deny';
export type PolicyProto = 'tcp' | 'udp' | 'all';
export type ParsedPolicyRule = {
  action: PolicyAction;
  proto: PolicyProto;
  portMin: number;
  portMax: number;
  raw: string;
  index: number;
  ownershipId?: string;
};

export type BroaderAllow = { scope: 'default' | 'global' | 'org' | 'peer'; path: string; detail: string; line?: string };

const OWNERSHIP_PREFIX = '# meshrooms-share:';
const SHARE_STATUSES: ShareStatus[] = ['pending-enable', 'active', 'pending-disable', 'stopped'];

export function validatePort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use --port with an integer between 1 and 65535.');
  return port;
}

export function ownershipMarker(id: string): string {
  if (!isUuid(id)) throw new Error('Ownership markers require a UUID rule id.');
  return `${OWNERSHIP_PREFIX}${id}`;
}

export function parseOwnershipMarker(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(OWNERSHIP_PREFIX)) return undefined;
  const id = trimmed.slice(OWNERSHIP_PREFIX.length).trim();
  return isUuid(id) ? id : undefined;
}

/** MeshGuard rule lines; comments/blank lines return null. Ownership is attached from the previous marker. */
export function parsePolicyRule(line: string): Omit<ParsedPolicyRule, 'index' | 'ownershipId'> | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(/\s+/);
  const action = parts[0];
  if (action !== 'allow' && action !== 'deny') throw new Error(`Invalid policy action: ${action}`);
  if (parts.length === 2 && parts[1] === 'all') {
    return { action, proto: 'all', portMin: 0, portMax: 0, raw: trimmed };
  }
  if (parts.length !== 3) throw new Error(`Invalid policy rule: ${trimmed}`);
  const proto = parts[1];
  if (proto !== 'tcp' && proto !== 'udp' && proto !== 'all') throw new Error(`Invalid policy protocol: ${proto}`);
  if (parts[2] === 'all') return { action, proto, portMin: 0, portMax: 0, raw: trimmed };
  const range = /^(\d{1,5})-(\d{1,5})$/.exec(parts[2]);
  if (range) {
    const portMin = Number(range[1]), portMax = Number(range[2]);
    if (!Number.isInteger(portMin) || !Number.isInteger(portMax) || portMin < 1 || portMax > 65535 || portMin > portMax) {
      throw new Error(`Invalid policy port range: ${parts[2]}`);
    }
    return { action, proto, portMin, portMax, raw: trimmed };
  }
  const port = Number(parts[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid policy port: ${parts[2]}`);
  return { action, proto, portMin: port, portMax: port, raw: trimmed };
}

export function parsePolicyFile(content: string): ParsedPolicyRule[] {
  const rules: ParsedPolicyRule[] = [];
  let pendingOwnership: string | undefined;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ownership = parseOwnershipMarker(line);
    if (ownership) { pendingOwnership = ownership; continue; }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { pendingOwnership = undefined; continue; }
    const rule = parsePolicyRule(line);
    if (!rule) { pendingOwnership = undefined; continue; }
    rules.push({ ...rule, index: i, ...(pendingOwnership ? { ownershipId: pendingOwnership } : {}) });
    pendingOwnership = undefined;
  }
  return rules;
}

export function ruleCoversTcpPort(rule: Pick<ParsedPolicyRule, 'proto' | 'portMin' | 'portMax'>, port: number): boolean {
  if (rule.proto !== 'tcp' && rule.proto !== 'all') return false;
  if (rule.portMin === 0 && rule.portMax === 0) return true;
  return port >= rule.portMin && port <= rule.portMax;
}

export function readDefaultAction(servicesDir: string): PolicyAction {
  const path = join(servicesDir, 'default');
  if (!existsSync(path)) return 'allow';
  const value = readFileSync(path, 'utf8').trim();
  if (value === 'deny') return 'deny';
  if (value === 'allow' || value === '') return 'allow';
  throw new Error(`Invalid MeshGuard default action in ${path}.`);
}

function firstMatchingAction(rules: ParsedPolicyRule[], port: number): PolicyAction | undefined {
  for (const rule of rules) {
    if (ruleCoversTcpPort(rule, port)) return rule.action;
  }
  return undefined;
}

function readRules(path: string): ParsedPolicyRule[] {
  if (!existsSync(path)) return [];
  return parsePolicyFile(readFileSync(path, 'utf8'));
}

/** Detect allows that would admit this TCP port to someone other than the paired peer. */
export function findBroaderAllows(configDir: string, port: number, pairedPeerStem: string): BroaderAllow[] {
  validatePort(port);
  const servicesDir = join(configDir, 'services');
  const broader: BroaderAllow[] = [];
  const defaultAction = existsSync(servicesDir) ? readDefaultAction(servicesDir) : 'allow';
  const globalPath = join(servicesDir, 'global.policy');
  const globalRules = readRules(globalPath);
  const globalMatch = firstMatchingAction(globalRules, port);
  if (globalMatch === 'allow') {
    broader.push({ scope: 'global', path: globalPath, detail: 'Global allow admits every peer without a more specific rule.', line: globalRules.find(r => ruleCoversTcpPort(r, port) && r.action === 'allow')?.raw });
  }
  const orgDir = join(servicesDir, 'org');
  if (existsSync(orgDir)) {
    for (const name of readdirSync(orgDir)) {
      if (!name.endsWith('.policy')) continue;
      const path = join(orgDir, name);
      const rules = readRules(path);
      const match = firstMatchingAction(rules, port);
      if (match === 'allow') {
        broader.push({ scope: 'org', path, detail: `Org policy ${name} allows TCP ${port}.`, line: rules.find(r => ruleCoversTcpPort(r, port) && r.action === 'allow')?.raw });
      }
    }
  }
  const peerDir = join(servicesDir, 'peer');
  if (existsSync(peerDir)) {
    for (const name of readdirSync(peerDir)) {
      if (!name.endsWith('.policy')) continue;
      const stem = name.slice(0, -'.policy'.length);
      if (stem === pairedPeerStem) continue;
      const path = join(peerDir, name);
      const rules = readRules(path);
      const match = firstMatchingAction(rules, port);
      if (match === 'allow') {
        broader.push({ scope: 'peer', path, detail: `Peer policy ${name} allows TCP ${port} for a peer other than the room pair.`, line: rules.find(r => ruleCoversTcpPort(r, port) && r.action === 'allow')?.raw });
      }
    }
  }
  // Unpaired peers with no peer/org match fall through to global, then default.
  if (globalMatch === undefined && defaultAction === 'allow') {
    broader.push({
      scope: 'default',
      path: join(servicesDir, 'default'),
      detail: 'Default allow admits every peer that does not match a more specific rule. Run `meshguard service default deny` before sharing.',
    });
  }
  return broader;
}

/** An unmarked allow for this port in the paired peer file would make owned stop ambiguous. */
export function findAmbiguousPeerAllow(configDir: string, peerStem: string, port: number): ParsedPolicyRule | undefined {
  const path = peerPolicyPath(configDir, peerStem);
  return readRules(path).find(rule => rule.action === 'allow' && ruleCoversTcpPort(rule, port) && !rule.ownershipId);
}

/** First-match MeshGuard semantics: an earlier deny makes a later allow unreachable. */
export function findPrecedingDeny(configDir: string, peerStem: string, port: number): ParsedPolicyRule | undefined {
  const first = readRules(peerPolicyPath(configDir, peerStem)).find(rule => ruleCoversTcpPort(rule, port));
  return first?.action === 'deny' ? first : undefined;
}

/** Prefer the paired key; `--peer-key` must match when a pair is known, else it is a fallback for unread rooms/tests. */
export function resolveSharePeerKey(explicit: string | undefined, paired: string | undefined): string {
  if (paired !== undefined) {
    if (!isHash(paired)) throw new Error('Paired peer key must be 64 lowercase hex characters.');
    if (explicit !== undefined) {
      if (!isHash(explicit)) throw new Error('Use --peer-key with the paired peer\'s 64-hex MeshGuard public key.');
      if (explicit !== paired) throw new Error('Use --peer-key that matches the peer paired to this room.');
    }
    return paired;
  }
  if (explicit !== undefined) {
    if (!isHash(explicit)) throw new Error('Use --peer-key with the paired peer\'s 64-hex MeshGuard public key.');
    return explicit;
  }
  throw new Error('Start the local node, or pass --peer-key for the paired MeshGuard peer.');
}

export function hexToBase64Pubkey(peerKey: string): string {
  if (!isHash(peerKey)) throw new Error('Peer keys must be 64 lowercase hex characters.');
  return Buffer.from(peerKey, 'hex').toString('base64');
}

/** MeshGuard loads peer/<base64>.policy or peer/<alias>.policy (via authorized_keys). Not hex. */
export function peerPolicyStem(peerKey: string, peerAlias?: string): string {
  if (peerAlias !== undefined) {
    const alias = peerAlias.trim();
    if (!alias || alias.length > 64 || /[\/\\]/.test(alias) || alias.includes('..')) {
      throw new Error('Use --peer-alias with a short MeshGuard authorized_keys alias (no path separators).');
    }
    return alias;
  }
  const stem = hexToBase64Pubkey(peerKey);
  // Standard base64 may include '/'; that cannot be a single path segment.
  if (stem.includes('/')) {
    throw new Error('This peer key\'s base64 form contains "/". Pass --peer-alias with the MeshGuard trust alias for that peer.');
  }
  return stem;
}

export function peerPolicyPath(configDir: string, peerStem: string): string {
  return join(configDir, 'services', 'peer', `${peerStem}.policy`);
}

export function validateMeshIp(meshIp: string): string {
  const parts = meshIp.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) {
    throw new Error('Mesh IP must be an IPv4 address from MeshGuard STATUS.');
  }
  for (const part of parts) {
    const octet = Number(part);
    if (octet < 0 || octet > 255) throw new Error('Mesh IP must be an IPv4 address from MeshGuard STATUS.');
  }
  return meshIp;
}

export function shareUrl(meshIp: string, port: number): string {
  return `http://${validateMeshIp(meshIp)}:${validatePort(port)}/`;
}

export function appendOwnedAllow(configDir: string, peerStem: string, port: number, id = randomUUID()): OwnedRule {
  validatePort(port);
  if (!isUuid(id)) throw new Error('Owned rules require a UUID id.');
  const path = peerPolicyPath(configDir, peerStem);
  const deny = findPrecedingDeny(configDir, peerStem, port);
  if (deny) {
    throw new Error(`Refusing to share: ${path} already has a deny covering TCP ${port} (${deny.raw}); an appended allow would be unreachable.`);
  }
  const ambiguous = findAmbiguousPeerAllow(configDir, peerStem, port);
  if (ambiguous) throw new Error(`Refusing to share: ${path} already has an unmarked allow covering TCP ${port} (${ambiguous.raw}).`);
  mkdirSync(join(configDir, 'services', 'peer'), { recursive: true, mode: 0o700 });
  const marker = ownershipMarker(id);
  const line = `allow tcp ${port}`;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${existing}${prefix}${marker}\n${line}\n`, { mode: 0o600 });
  return { id, path, line };
}

/** Remove only lines owned by the given markers; leave hand-written rules untouched. */
export function removeOwnedRules(ownedRules: OwnedRule[]): void {
  const byPath = new Map<string, Set<string>>();
  for (const rule of ownedRules) {
    if (!isUuid(rule.id)) throw new Error('Owned rules require a UUID id.');
    const set = byPath.get(rule.path) || new Set<string>();
    set.add(rule.id);
    byPath.set(rule.path, set);
  }
  for (const [path, ids] of byPath) {
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const ownership = parseOwnershipMarker(lines[i]);
      if (ownership && ids.has(ownership)) {
        const next = lines[i + 1];
        if (next !== undefined && parsePolicyRule(next)) i += 1;
        continue;
      }
      out.push(lines[i]);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    if (!out.length) unlinkSync(path);
    else writeFileSync(path, `${out.join('\n')}\n`, { mode: 0o600 });
  }
}

export function sharesDir(dataDir: string): string {
  return join(resolve(dataDir), 'shares');
}

export function shareRecordPath(dataDir: string, roomId: string): string {
  if (!isUuid(roomId)) throw new Error('Use --room with a room UUID.');
  return join(sharesDir(dataDir), `${roomId}.json`);
}

export function shareLockPath(dataDir: string, roomId: string): string {
  if (!isUuid(roomId)) throw new Error('Use --room with a room UUID.');
  return join(sharesDir(dataDir), `${roomId}.lock`);
}

/** Exclusive wx lock around conflict check + policy/record mutation for one room. */
export function withShareLock<T>(dataDir: string, roomId: string, fn: () => T): T {
  const directory = sharesDir(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = shareLockPath(dataDir, roomId);
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error(`Another share operation is in progress for room ${roomId}. Retry shortly.`);
    }
    throw error;
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
    try { unlinkSync(lockPath); } catch { /* best-effort */ }
  }
}

export function isShareRecord(value: unknown): value is ShareRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as ShareRecord;
  return isUuid(record.roomId) && Number.isInteger(record.port) && record.port >= 1 && record.port <= 65535
    && isHash(record.peerKey) && typeof record.meshIp === 'string' && typeof record.startedAt === 'string'
    && typeof record.expiresAt === 'string' && SHARE_STATUSES.includes(record.status)
    && typeof record.url === 'string' && Array.isArray(record.ownedRules)
    && record.ownedRules.every(rule => rule && isUuid(rule.id) && typeof rule.path === 'string' && typeof rule.line === 'string');
}

export function readShareRecord(dataDir: string, roomId: string): ShareRecord | undefined {
  const path = shareRecordPath(dataDir, roomId);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!isShareRecord(value) || value.roomId !== roomId) throw new Error(`Invalid share record at ${path}.`);
  return value;
}

export function writeShareRecord(dataDir: string, record: ShareRecord): void {
  if (!isShareRecord(record)) throw new Error('Invalid share record.');
  const directory = sharesDir(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = shareRecordPath(dataDir, record.roomId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { renameSync(temporary, path); }
  catch (error) { try { unlinkSync(temporary); } catch { /* best-effort */ } throw error; }
}

export function listShareRecords(dataDir: string): ShareRecord[] {
  const directory = sharesDir(dataDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
    const value = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    if (!isShareRecord(value)) throw new Error(`Invalid share record at ${join(directory, name)}.`);
    return value;
  });
}

export function assertNoConflictingShare(dataDir: string, roomId: string): void {
  for (const share of listShareRecords(dataDir)) {
    if (share.status === 'stopped' || share.status === 'pending-disable') continue;
    if (share.roomId === roomId) throw new Error(`Room ${roomId} already has a share in status ${share.status}. Stop it before sharing again.`);
    throw new Error(`This node already has an active share for room ${share.roomId} (status ${share.status}). First slice allows one share at a time.`);
  }
}

export function createShareRecord(input: {
  roomId: string; port: number; peerKey: string; meshIp: string; minutes?: number; ownedRules: OwnedRule[];
}): ShareRecord {
  if (!isUuid(input.roomId)) throw new Error('Use --room with a room UUID.');
  if (!isHash(input.peerKey)) throw new Error('Peer keys must be 64 lowercase hex characters.');
  const port = validatePort(input.port);
  const minutes = input.minutes === undefined ? 30 : Number(input.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error('Use --minutes between 1 and 1440.');
  const started = new Date();
  const expires = new Date(started.getTime() + minutes * 60_000);
  return {
    roomId: input.roomId, port, peerKey: input.peerKey, meshIp: validateMeshIp(input.meshIp),
    startedAt: started.toISOString(), expiresAt: expires.toISOString(), status: 'pending-enable',
    ownedRules: input.ownedRules, url: shareUrl(input.meshIp, port),
  };
}

export function markSharePendingDisable(record: ShareRecord): ShareRecord {
  if (record.status === 'stopped') throw new Error('That share is already stopped.');
  if (record.status === 'pending-disable') return record;
  return { ...record, status: 'pending-disable', ownedRules: [] };
}

export function confirmShareReload(record: ShareRecord): ShareRecord {
  if (record.status === 'pending-enable') return { ...record, status: 'active' };
  if (record.status === 'pending-disable') return { ...record, status: 'stopped' };
  return record;
}

/** Expiry is checked on CLI `share` / `share-status` / `share-stop`, not by a background timer. */
export function isShareExpired(record: ShareRecord, now = Date.now()): boolean {
  if (record.status !== 'pending-enable' && record.status !== 'active') return false;
  const expires = Date.parse(record.expiresAt);
  return Number.isFinite(expires) && now > expires;
}

/** Remove owned rules; pending-enable → stopped, active → pending-disable (await MeshGuard reload). */
export function expireShareRecord(record: ShareRecord): ShareRecord {
  if (record.status !== 'pending-enable' && record.status !== 'active') return record;
  if (record.ownedRules.length) removeOwnedRules(record.ownedRules);
  if (record.status === 'active') return markSharePendingDisable({ ...record, ownedRules: [] });
  return { ...record, status: 'stopped', ownedRules: [] };
}

export function enforceShareExpiry(dataDir: string, roomId: string, now = Date.now()): ShareRecord | undefined {
  const record = readShareRecord(dataDir, roomId);
  if (!record || !isShareExpired(record, now)) return record;
  const expired = expireShareRecord(record);
  writeShareRecord(dataDir, expired);
  return expired;
}

/** Clear expired live shares so they stop blocking a new share. */
export function enforceAllShareExpiries(dataDir: string, now = Date.now()): void {
  for (const share of listShareRecords(dataDir)) {
    if (!isShareExpired(share, now)) continue;
    writeShareRecord(dataDir, expireShareRecord(share));
  }
}

export function defaultMeshguardConfigDir(): string {
  if (process.env.MESHGUARD_CONFIG_DIR) return resolve(process.env.MESHGUARD_CONFIG_DIR);
  if (process.platform === 'win32') {
    const root = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(root, 'meshguard');
  }
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'meshguard');
  return join(homedir(), '.config', 'meshguard');
}

export function meshguardSocketPath(): string {
  const path = process.env.MESHROOMS_MESHGUARD_SOCKET?.trim();
  if (!path) throw new Error('Set MESHROOMS_MESHGUARD_SOCKET to the MeshGuard control socket (or named pipe) before sharing.');
  return path;
}
