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
/** Several puts and deletes in one transaction; a failure is reported to onStorageProblem and rejects with StorageError. */
async function save(puts: [string, unknown][], deletes: string[] = []) {
  let tx: IDBTransaction;
  try { tx = await transaction('readwrite'); } catch { const error = failure(undefined); report(error.message); throw error; }
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => { report(undefined); resolve(); };
    tx.onabort = tx.onerror = () => { const error = failure(tx.error); report(error.message); reject(error); };
    try {
      const store = tx.objectStore('records');
      for (const [key, value] of puts) store.put(value, key);
      for (const key of deletes) store.delete(key);
    } catch { try { tx.abort(); } catch { /* Already finished; onabort or onerror reports it. */ } }
  });
}
export function write(key: string, value: unknown) { return save([[key, value]]); }
/** Several puts and deletes in one transaction, so a file and its index entry change together. */
export function update(puts: [string, unknown][], deletes: string[] = []) { return save(puts, deletes); }
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
