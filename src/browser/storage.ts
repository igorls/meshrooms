import { base64, deviceId, encode } from './protocol';
import {
  decryptRelayEnvelope,
  exportRawPublicKey,
  generateEncKeyPair,
  importEncPublicKey,
  signEncBinding,
  type DecryptedRelayEnvelope,
} from './relay-crypto';

export type Identity = {
  id: string;
  publicKey: string;
  keys: CryptoKeyPair;
  encKeys: CryptoKeyPair;
  encPublicKey: string;
  encVersion: number;
  encSig: string;
};

/** Local saving failed (out of space, evicted or closed storage). The room shows it until a later save succeeds. */
export class StorageError extends Error { override name = 'StorageError'; }
type StorageListener = (problem: string | undefined) => void;
const listeners = new Set<StorageListener>();
let problem: string | undefined;
/** Follow whether local saving is failing: a message while it is, undefined once a save succeeds again. */
export function onStorageProblem(listener: StorageListener) {
  listeners.add(listener); listener(problem);
  return () => { listeners.delete(listener); };
}
function report(next: string | undefined) {
  if (next === problem) return;
  problem = next; for (const listener of listeners) listener(problem);
}
function failure(error: DOMException | null | undefined) {
  return new StorageError(error?.name === 'QuotaExceededError'
    ? 'This browser is out of space for Meshrooms: new messages and changes are not being saved here. Free some site storage.'
    : 'Could not save in this browser. Free some site storage and retry.');
}

let database: Promise<IDBDatabase> | undefined;
function db() {
  if (database) return database;
  const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    // A failed, closed or upgraded database is opened again by the next read or write, without a reload.
    const forget = () => { if (database === opening) { database = undefined; current = undefined; } };
    const open = indexedDB.open('meshrooms-browser-v1', 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('records')) open.result.createObjectStore('records');
    };
    open.onsuccess = () => {
      const handle = open.result;
      handle.onclose = forget; // The browser closed it (storage cleared or evicted).
      handle.onversionchange = () => { handle.close(); forget(); };
      resolve(handle);
    };
    open.onerror = () => { forget(); reject(new Error('Browser storage is unavailable. Allow site storage and reload.')); };
    open.onblocked = () => { forget(); reject(new Error('Close other Meshrooms tabs and reload to update storage.')); };
  });
  return database = opening;
}
/** A transaction on the records store; a handle that closed under us is dropped and the database opened again once. */
async function transaction(mode: IDBTransactionMode) {
  const handle = await db();
  try { return handle.transaction('records', mode); } catch {
    if (database) { const current = await database; if (current === handle) database = undefined; }
    return (await db()).transaction('records', mode);
  }
}
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export async function read<T>(key: string, validate?: (value: unknown) => value is T): Promise<T | undefined> {
  const store = (await transaction('readonly')).objectStore('records');
  const raw = await new Promise<unknown>((resolve, reject) => {
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (raw === undefined) return undefined;
  if (validate) {
    try { return validate(raw) ? raw : undefined; } catch { return undefined; }
  }
  return raw as T;
}

/** Read a stored array, returning `[]` if missing or non-array and dropping corrupted elements. */
export async function readArray<T>(key: string, valid: (item: unknown) => item is T): Promise<T[]> {
  const list = await read<unknown[]>(key, Array.isArray);
  if (!list) return [];
  const clean: T[] = [];
  for (const item of list) {
    try { if (valid(item)) clean.push(item); } catch { /* Drop corrupted entry. */ }
  }
  return clean;
}

/** Read a stored plain-object map, returning `{}` if missing or invalid and dropping corrupted entries. */
export async function readRecord<T>(key: string, valid: (value: unknown, entryKey: string) => value is T): Promise<Record<string, T>> {
  const record = await read<Record<string, unknown>>(key, isPlainObject);
  if (!record) return {};
  const clean: Record<string, T> = {};
  for (const [entryKey, value] of Object.entries(record)) {
    try { if (valid(value, entryKey)) clean[entryKey] = value; } catch { /* Drop corrupted entry. */ }
  }
  return clean;
}
/**
 * Ownership of a room's records in this browser. Whoever takes a room's connection increments the room's epoch
 * (claimFence) and writes with it; a fenced write checks the stored epoch in its own transaction and aborts, writing
 * nothing, once someone else has claimed the room since. So an owner that lost the room (a frozen tab whose lock was
 * taken) can never write an older copy over the new owner's.
 */
export type Fence = { key: string; epoch: number };
/** A fenced write found that another owner holds the room now; nothing was written. */
export class FenceError extends Error { override name = 'FenceError'; }
/** Several puts and deletes in one transaction; a failure is reported to onStorageProblem and rejects with StorageError. */
async function save(puts: [string, unknown][], deletes: string[] = [], fence?: Fence) {
  let tx: IDBTransaction;
  try { tx = await transaction('readwrite'); } catch { const error = failure(undefined); report(error.message); throw error; }
  let fenced = false;
  return new Promise<void>((resolve, reject) => {
    let capturedError: DOMException | null | undefined;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      // Losing the room is not a storage problem: the new owner saves.
      if (fenced) { reject(new FenceError('This room was opened in another tab of this browser.')); return; }
      const error = failure(tx.error ?? capturedError); report(error.message); reject(error);
    };
    tx.oncomplete = () => { if (settled) return; settled = true; report(undefined); resolve(); };
    // Request errors bubble to tx.onerror while tx.error is still null; capture them and settle once on tx.onabort.
    tx.onerror = event => { capturedError ??= (event.target as IDBRequest | null)?.error ?? tx.error; };
    tx.onabort = fail;
    try {
      const store = tx.objectStore('records');
      const apply = () => {
        for (const [key, value] of puts) store.put(value, key);
        for (const key of deletes) store.delete(key);
      };
      if (!fence) { apply(); return; }
      // Read and write in one transaction: no other write can commit between the check and these puts.
      const check = store.get(fence.key);
      check.onsuccess = () => {
        if (check.result === fence.epoch) { try { apply(); } catch { tx.abort(); } return; }
        fenced = true; tx.abort();
      };
    } catch { try { tx.abort(); } catch { /* Already finished; onabort or onerror reports it. */ } }
  });
}
export function write(key: string, value: unknown, fence?: Fence) { return save([[key, value]], [], fence); }
/** Several puts and deletes in one transaction, so a file and its index entry change together. */
export function update(puts: [string, unknown][], deletes: string[] = [], fence?: Fence) { return save(puts, deletes, fence); }
/** Take ownership of a room's records: the next epoch, which every earlier owner's fenced writes now fail against. */
export async function claimFence(key: string): Promise<Fence> {
  const tx = await transaction('readwrite');
  return new Promise<Fence>((resolve, reject) => {
    let epoch = 0;
    let capturedError: DOMException | null | undefined;
    tx.oncomplete = () => resolve({ key, epoch });
    tx.onerror = event => { capturedError ??= (event.target as IDBRequest | null)?.error ?? tx.error; };
    tx.onabort = () => reject(failure(tx.error ?? capturedError));
    const store = tx.objectStore('records');
    const current = store.get(key);
    current.onsuccess = () => { epoch = (typeof current.result === 'number' ? current.result : 0) + 1; store.put(epoch, key); };
  });
}
/**
 * Ask the browser to keep this site's storage (identity keys, history, outbox) under storage pressure. Called once the
 * person has joined a room; a browser that declines (or has no such API) is left alone, with nothing shown.
 */
export function persistStorage() {
  try { void navigator.storage?.persist?.().catch(() => {}); } catch { /* Not offered here. */ }
}
type BaseIdentity = { id: string; publicKey: string; keys: CryptoKeyPair };
const isBaseIdentity = (value: unknown): value is BaseIdentity =>
  isPlainObject(value) && typeof value.id === 'string' && typeof value.publicKey === 'string'
  && isPlainObject(value.keys) && 'privateKey' in value.keys && 'publicKey' in value.keys;
const hasEncIdentity = (value: BaseIdentity): value is Identity => {
  const v = value as Record<string, unknown>;
  return isPlainObject(v.encKeys) && 'privateKey' in v.encKeys && 'publicKey' in v.encKeys
    && typeof v.encPublicKey === 'string' && v.encPublicKey.length === 88
    && typeof v.encVersion === 'number' && Number.isInteger(v.encVersion) && v.encVersion >= 1
    && typeof v.encSig === 'string' && v.encSig.length === 88;
};
let current: Promise<Identity> | undefined;
/** Clears the in-memory cached identity promise so the next `identity()` call re-reads IndexedDB (used after storage reset/tests). */
export function resetIdentityCache() {
  current = undefined;
}
export function identity(): Promise<Identity> {
  return current ||= (async () => {
    if (!crypto.subtle || !navigator.locks) throw new Error('Open this room over HTTPS in a browser with Web Crypto and Web Locks support.');
    return navigator.locks.request('meshrooms-identity', async () => {
      const existing = await read<BaseIdentity>('identity', isBaseIdentity);
      if (existing && hasEncIdentity(existing)) return existing;
      const keys = existing?.keys ?? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKey = existing?.publicKey ?? base64(await crypto.subtle.exportKey('raw', keys.publicKey));
      const id = existing?.id ?? await deviceId(publicKey);
      // Separate non-exportable P-256 ECDH keypair for E2E relay envelopes (never reuses the ECDSA signing key).
      const encKeys = await generateEncKeyPair(false);
      const encPublicKey = await exportRawPublicKey(encKeys.publicKey);
      const encVersion = 1;
      const signWithKeys = async (value: unknown) =>
        base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encode(value)));
      const encSig = await signEncBinding(signWithKeys, {
        room: '*',
        deviceId: id,
        enc: encPublicKey,
        encVersion,
      });
      const complete: Identity = { id, publicKey, keys, encKeys, encPublicKey, encVersion, encSig };
      await write('identity', complete);
      return complete;
    });
  })().catch(error => { current = undefined; throw error; }); // Retry opens storage again rather than repeating the failure.
}
export async function sign(value: unknown) {
  const i = await identity();
  return base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, i.keys.privateKey, encode(value)));
}
/** Signs a room-scoped `{ room, deviceId, enc, encVersion }` binding for this browser device's ECDH key. */
export async function signDeviceEncKey(roomId: string): Promise<{ enc: string; encVersion: number; encSig: string }> {
  const i = await identity();
  const encSig = await signEncBinding(sign, {
    room: roomId,
    deviceId: i.id,
    enc: i.encPublicKey,
    encVersion: i.encVersion,
  });
  return { enc: i.encPublicKey, encVersion: i.encVersion, encSig };
}
/** Derives a 256-bit ECDH shared secret with a peer's raw base64 P-256 public key using this device's encryption key. */
export async function deriveSharedSecret(peerEncPublicKey: string): Promise<ArrayBuffer> {
  const i = await identity();
  const peerPub = await importEncPublicKey(peerEncPublicKey);
  return crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, i.encKeys.privateKey, 256);
}
/** Decrypts an incoming E2E relay envelope using this browser device's non-exportable ECDH private key. */
export async function decryptWithEncKey<T = unknown>(
  envelope: unknown,
  options: { room: string; senderSignKey: string; minRosterVersion?: number; expectedFrom?: string },
): Promise<DecryptedRelayEnvelope<T>> {
  const i = await identity();
  return decryptRelayEnvelope<T>(envelope, {
    room: options.room,
    selfDeviceId: i.id,
    selfEncPrivateKey: i.encKeys.privateKey,
    selfEncVersion: i.encVersion,
    senderSignKey: options.senderSignKey,
    minRosterVersion: options.minRosterVersion,
    expectedFrom: options.expectedFrom,
  });
}
