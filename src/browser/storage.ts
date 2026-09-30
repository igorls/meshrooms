import { base64, deviceId, encode } from './protocol';

type Identity = { id: string; publicKey: string; keys: CryptoKeyPair };

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
    const forget = () => { if (database === opening) database = undefined; };
    const open = indexedDB.open('meshrooms-browser-v1', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('records');
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
export async function read<T>(key: string): Promise<T | undefined> {
  const store = (await transaction('readonly')).objectStore('records');
  return new Promise((resolve, reject) => { const r = store.get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
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
    tx.oncomplete = () => { report(undefined); resolve(); };
    tx.onabort = tx.onerror = () => {
      // Losing the room is not a storage problem: the new owner saves.
      if (fenced) { reject(new FenceError('This room was opened in another tab of this browser.')); return; }
      const error = failure(tx.error); report(error.message); reject(error);
    };
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
    tx.oncomplete = () => resolve({ key, epoch });
    tx.onabort = tx.onerror = () => reject(failure(tx.error));
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
let current: Promise<Identity> | undefined;
export function identity() {
  return current ||= (async () => {
    if (!crypto.subtle || !navigator.locks) throw new Error('Open this room over HTTPS in a browser with Web Crypto and Web Locks support.');
    return navigator.locks.request('meshrooms-identity', async () => {
      const existing = await read<Identity>('identity'); if (existing) return existing;
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKey = base64(await crypto.subtle.exportKey('raw', keys.publicKey));
      const created = { id: await deviceId(publicKey), publicKey, keys };
      await write('identity', created); return created;
    });
  })().catch(error => { current = undefined; throw error; }); // Retry opens storage again rather than repeating the failure.
}
export async function sign(value: unknown) {
  const i = await identity();
  return base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, i.keys.privateKey, encode(value)));
}
