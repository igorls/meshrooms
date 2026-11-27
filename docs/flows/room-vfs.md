# Room VFS over WormDB (design & protocol)

Status: proposed architecture (ready for decision sign-off before PR 1).

This document specifies an end-to-end encrypted room filesystem (**Room VFS**) for shared documents and files edited collaboratively by humans and AI agents, with verifiable revision history and CRDT-safe reversion.

## 1. Goal, Binding Constraints, and Scope

### Goal
Give every Meshrooms room a shared workspace of versioned documents and files that people edit live in the browser or desktop app and AI agents read, patch, diff, and revert safely over CLI/MCP—with cryptographic author attribution, deterministic offline convergence, and zero plaintext exposure to the relay/room server.

### Binding Decision 1 — Zero Server-Side Storage
Storage lives **exclusively on participating room devices** (browsers, desktop nodes, and agent bridges). The relay/room server stores **zero persistent VFS documents, blocks, trees, or history**. When direct WebRTC DataChannels are unavailable, the E2E relay acts strictly as ephemeral encrypted transit; **no VFS frame may ever set `hold: true` or `wake: true`** on the relay inbox or write VFS state into `relay-state-put` (256 KiB).

### MVP Target vs. Phase 2 and Non-Goals
- **MVP (PR 1–PR 5):** Shared UTF-8 text and Markdown documents with real-time CRDT editing, verifiable per-revision history, inline diff, CRDT-safe one-click reversion, safe concurrent agent read/patch via CLI and MCP, and a Work-First `Docs` split panel across hosted browser rooms and the desktop app.
- **Phase 2 (PR 6–PR 7):** Encrypted chunked CAS binary files (`<= 10 MiB`), interactive folder tree and move/rename (`vfs-mv`), drag-and-drop uploads, chat-attachment promotion to VFS, room-wide tree snapshots, and swapping browser IndexedDB storage to WormDB WASM + OPFS behind the same `VfsStore` interface.
- **Non-goals for MVP:** Server-side file hosting or cloud backup; rich-text WYSIWYG (ProseMirror/TipTap) formatting; OS-level FUSE/local-folder sync; waking agents automatically on document edits or `@mentions` inside document text; transparent wire decompression.

---

## 2. WormDB Engine Audit & Architectural Constraints

An audit of Meshrooms' native adapter (`server/persistence/wormdb.ts`, `docs/wormdb-adapter.md`) alongside the WormDB engine (`wormdb/ffi/wormdb.h`, `wormdb/src/ffi.zig`, `wormdb/src/storage/store.zig`, `wormdb/src/storage/wal.zig`, `wormdb/build.zig`) establishes the real capabilities and limits that govern this design:

| Capability / Constraint | Measured Reality in WormDB (`wormdb-ffi 0.3` & upstream) | Design Consequence for Room VFS |
| --- | --- | --- |
| **Exposed FFI ABI** | Meshrooms binds 5 UTF-8 string symbols today (`wormdb_open_sync`, `wormdb_close`, `wormdb_set`, `wormdb_get`, `wormdb_free`), while WormDB already exports 18 binary-safe C functions including `wormdb_set_worm`, `wormdb_get_meta` (`timestamp_ms`, `is_worm`, `value_len`, `value_sha256` without copying value bytes), `wormdb_delete`, `wormdb_scan_prefix` (per-shard sorted index, O(256·log n + matches), `limit > 0` returns lexicographic tail `ScanCut.last`), `wormdb_append_log*`, `wormdb_proof_*`, and `wormdb_exec`. | Extend `server/persistence/wormdb.ts` with binary `Uint8Array` methods for `wormdb_delete`, `wormdb_get_meta`, and `wormdb_scan_prefix` (keeping `DurableStore` backwards-compatible). |
| **100% RAM-resident live KV** | All 256 shards keep live keys and values in RAM (`store.zig:47-59,142-160`), `snapshot_arena` entries are not reclaimed individually until `deinit`, and `writeSnapshot()` copies live entries before writing `wormdb.snapshot.tmp` (temporarily 2× RAM). | Split storage into **Tier 1 Hot KV** (metadata, ops, commits, checkpoints, inline blocks `<= 16 KiB`, capped at 32 MiB browser / 64 MiB desktop+bridge) and **Tier 2 Cold Encrypted CAS** (binary chunks `> 16 KiB` stored outside WormDB RAM/WASM heap). |
| **WORM keys refuse `delete`** | `store.zig:649` permanently rejects `wormdb_delete` on WORM keys with `error.WormViolation`. | **All VFS KV keys use mutable `wormdb_set`** + app-level `putIfAbsent` + P-256 signature/CID verification so CRDT op compaction, binary LRU eviction, and room deletion work cleanly. `wormdb_append_log` stays strictly opt-in for local tamper-evident audit receipts. |
| **WAL key/value limits & single-key writes** | WAL encodes key length as `u16` (max 65,535 B; adapter enforces `<= 512 B`) and value length as `u32` (100 MiB replay / 16 MiB wire). FFI has no multi-key atomic transaction. | Enforce strict **write-before-publish** ordering so crashes leave only harmless unreferenced orphans swept after a grace window. |
| **`sync_writes` WAL truncation gap** | `wormdb_open_sync` executes synchronous inline `writeAll + fsync` and latches `sync_failed = true` until recovery, but `maybeSnapshotAndTruncate()` returns early when `sync_writes == true` (`store.zig:1218-1221`) and FFI exports no checkpoint function yet. | Land a small (~25 LOC) upstream `wormdb_checkpoint_sync(db)` FFI export (with a quiesced per-room directory-swap compaction fallback until available). |
| **No built-in at-rest encryption** | `wormdb.wal` and `wormdb.snapshot` store raw keys and values in plaintext. | **Zero filenames or paths in KV keys** (opaque IDs/hashes only) and AEAD encryption of every value above WormDB (`VfsEnvelopeV1`). |
| **Ed25519 vs. P-256 & `proof_prefix_root`** | WormDB's proof checkpoints use Ed25519 while Meshrooms identities use ECDSA P-256 (`src/browser/protocol.ts:198`). `proof_prefix_root` hashes local receipt timestamps (`prefix_root.zig:68-80`), so two peers with identical records compute different roots. | Carry P-256 author signatures inside canonical VFS payloads; use deterministic VFS-layer `frontierHash` over sorted `cid`s for cross-peer reconciliation—never `proof_prefix_root`. |
| **WASM32-WASI & Browser CSP** | Upstream `wormdb` (`PRs #98/#99/#100`, tracked in Meshrooms PR #159) builds `wasm32-wasi` (`565 KB` / `211 KB` gz, unshared linear memory → no `SharedArrayBuffer` or COOP/COEP headers) with buffered WAL replay and torn-tail detection. However, the WASI-over-OPFS worker shim, Safari Private fallback, `wormdb_checkpoint_sync`, and `'wasm-unsafe-eval'` in `server/browser/http.ts:119` (`script-src 'self'`) are not yet landed. | Ship MVP immediately on fenced IndexedDB (`IndexedDbVfsStore`) + pure-TS CRDT (zero WASM, zero CSP relaxation) behind a shared `VfsStore` interface; swap browser persistence to `WormDbWasmVfsStore` in PR 7 with zero wire changes. |

---

## 3. Unified `VfsStore` Abstraction & Two-Tier Storage Layout

### 3.1 Per-Room Isolation & Tiering
Each room owns an isolated VFS directory (`<dataDir>/vfs/<roomId>/` on desktop and agent bridges; `/meshrooms-vfs/<roomId>/` in browser OPFS), managed by an LRU open-handle pool (e.g., max 16 open rooms on desktop so idle rooms consume 0 RAM). Deleting or leaving a room closes its handle and deletes the directory for immediate 100% WAL and block reclamation, isolating WAL I/O failures per room.

- **Tier 1 — Hot KV** (WormDB KV on desktop/bridge; `vfs_kv` IndexedDB store in browser MVP): room VFS metadata, device-sealed room epoch keys, per-node heads & frontier maps, CRDT op-log entries, local checkpoints, commits, trees, manifests, inline blocks (`<= 16 KiB`), block refcount metadata (`bmeta`), commit time index, peer sync cursors, and idempotency receipts.
- **Tier 2 — Cold Encrypted CAS** (Phase 2 binary chunks `> 16 KiB`; fixed `64 KiB` plaintext blocks encrypted as `VfsEnvelopeV1`):
  - **Desktop / Agent Bridge:** `<roomVfsDir>/blocks/<cid[0..2]>/<cid>` written with temp + `fsync` + atomic rename + dir-fsync (matching `server/blobs.ts`), verified via `SHA-256(bytes) === cid` on read.
  - **Browser MVP:** dedicated IndexedDB object store `vfs_blocks` (stored out-of-heap by the browser).
  - **Browser Post-WASM:** OPFS files `/meshrooms-vfs/<roomId>/blocks/<cid[0..2]>/<cid>` outside WASM linear memory.

### 3.2 Canonical WormDB Key-Space
Prefix `P = vfs:v1:<roomId>:` (`<roomId>` is a 36-char lowercase UUID). All numeric fields use fixed-width big-endian lowercase hex so ASCII lexicographic order equals numeric order. Max key length is `<= 192 B` (hard adapter cap `512 B`). **Filenames and paths never appear in KV keys**; path↔`nodeId` bindings live exclusively inside encrypted tree records.

| Key Pattern | WormDB Mode | Encrypted Value | Purpose / Primitive Used |
| --- | --- | --- | --- |
| `${P}meta` | Mutable (`set`) | Device-sealed `RoomVfsMeta` (`schemaV`, `activeEpoch`, `headCommitCid`, `rootTreeCid`, `vfsCursor`, `updatedAt`) | Single-key atomic publish root |
| `${P}epoch:<epoch8>` | Mutable (`set`) | Device-sealed `EpochKeyRecord` (`epoch`, `rosterVersion`, `hostSignedHeader`, wrapped `RK_e`, `createdAt`, `revokedAt?`) | Room key-epoch ring sealed under `K_device_seal` |
| `${P}node:<nodeId>:head` | Mutable (`set`) | Device-sealed `NodeHead` (`nodeId`, `kind`, `latestSnapCid`, `docFrontier`, `frontierMap` (last 256 `f:<hex16> -> opHash[]`), `headCommitId`, `activeEpoch`, `deleted`, `plainBytes`) | O(1) node tip, checkpoint pointer, and `--base-rev` frontier lookup |
| `${P}op:<nodeId>:<deviceId>:<seq12>:<opHash8>` | Mutable (`set`) | Room-encrypted `VfsEnvelopeV1` (`0x01 doc-op` or `0x04 tree-op`) | Per-node, per-device op-log; `wormdb_scan_prefix(prefix, 1)` gets latest seq (`ScanCut.last`); `<opHash8>` retains **both** entries on `(deviceId, seq)` equivocation |
| `${P}snap:<nodeId>:<ts12>:<cid16>` | Mutable (`set`) | Device-sealed/cached `DocCheckpoint` (`FugueTree` state + `frontier[]` + `textSha256`) | O(1) startup cache; `wormdb_scan_prefix(prefix, 1)` returns newest snapshot |
| `${P}obj:<cid64>` | Mutable (`set`) | Room-encrypted `VfsEnvelopeV1` (`0x03 commit`, `0x05 manifest`, inline `0x06 chunk <= 16 KiB`) | Content-addressed object store; `wormdb_get_meta` checks existence/size/SHA-256 zero-copy |
| `${P}bmeta:<cid64>` | Mutable (`set`) | Device-sealed `BlockMeta` (`cid`, `plainSize`, `cipherSize`, `epoch`, `tier: 'kv'\|'cold'`, `authorMemberId`, `refCount`, `pinned`, `addedAt`, `lastAccessAt`) | Lightweight GC and per-member fairness accounting in KV |
| `${P}commit:<ts12>:<commitId16>` | Mutable (`set`) | Device-sealed `CommitIndexEntry` (`commitId`, `cid`, `parents[]`, `authorMemberId`, `authorDeviceId`, `nodeIds[]`, `summary`, `revertsCommit?`, `at`) | `wormdb_scan_prefix("${P}commit:", N)` returns latest `N` commits in O(log n + N) |
| `${P}sync:<peerDeviceId>` | Mutable (`set`) | Device-sealed `PeerSyncCursor` (`lastHaveVector`, `lastFrontierHash`, `pendingWants[]`, `updatedAt`) | Anti-entropy sync resumption per peer |
| `${P}req:<actorId>:<requestId>` | Mutable (`set`) | Device-sealed `IdempotencyReceipt` (`opId`, `nodeId`, `rev`, `vfsCursor`, `at`) | `--request-id` deduplication (retains newest 256 receipts per actor) |
| `vfs:v1:<roomId>:audit` *(optional)* | WORM (`wormdb_append_log`) | Local receipt `{ kind, cid, epoch, at }` | Opt-in local tamper-evident receipt log with MMR proofs (off by default) |

### 3.3 Shared `VfsStore` Interface & Runtime Adapters

```ts
export interface VfsKvEntry { key: string; value: Uint8Array; timestampMs?: number; }
export interface VfsScanOptions { limit?: number; direction?: 'first' | 'last'; afterKey?: string; }
export interface VfsPutOp { key: string; value: Uint8Array; }

export interface VfsStore {
  readonly backend: 'wormdb-ffi' | 'wormdb-wasm-opfs' | 'indexeddb' | 'bun-file' | 'memory';
  readonly durable: boolean;
  get(key: string): Promise<Uint8Array | null>;
  stat(key: string): Promise<{ size: number; sha256Hex?: string; timestampMs?: number } | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  putIfAbsent(key: string, value: Uint8Array): Promise<boolean>;
  batch(puts: VfsPutOp[], deletes?: string[]): Promise<void>;
  del(key: string): Promise<void>;
  scanPrefix(prefix: string, opts?: VfsScanOptions): Promise<VfsKvEntry[]>;
  getBlock(roomId: string, cid: string): Promise<Uint8Array | null>;
  putBlock(roomId: string, cid: string, bytes: Uint8Array): Promise<void>;
  hasBlock(roomId: string, cid: string): Promise<boolean>;
  delBlock(roomId: string, cid: string): Promise<void>;
  usage(roomId?: string): Promise<{ hotKvBytes: number; coldBlockBytes: number; walBytes?: number }>;
  checkpoint(): Promise<void>;
  close(): Promise<void>;
}
```

- **Browser MVP (`IndexedDbVfsStore`):** Upgrades existing `meshrooms-browser-v1` cleanly from `v1 -> v2` (`src/browser/storage.ts:47`), leaving `'records'` and `'identity'` untouched while adding `'vfs_kv'` and `'vfs_blocks'`. Every write executes inside a single multi-store `readwrite` transaction that checks the tab's ownership `Fence` (`owner:<dev>:<room>`, throwing `FenceError` on stolen tab locks). `scanPrefix` uses `IDBKeyRange.bound(prefix, prefix + '\uffff')`. Calls `navigator.storage.persist()`; falls back explicitly to `MemoryVfsStore` (`durable: false`) with a UI notice in strict private browsing.
- **Browser Post-MVP (`WormDbWasmVfsStore`):** Runs `wormdb_ffi.wasm` inside a Dedicated Web Worker (for synchronous OPFS `FileSystemSyncAccessHandle`; no `SharedArrayBuffer` or COOP/COEP required), gated on Web Lock `meshrooms-connection:<roomId>`, WASI-over-OPFS worker shim, Safari Private fallback to `IndexedDbVfsStore`, upstream `wormdb_checkpoint_sync`, one-time verified IDB→OPFS migration, and adding `'wasm-unsafe-eval'` to `server/browser/http.ts:119`. Identical keys and `VfsEnvelopeV1` bytes mean zero wire changes.
- **Desktop & Native Bridges (`WormDbFfiVfsStore`):** Uses `wormdb_open_sync` + binary FFI bindings (`wormdb_set`, `wormdb_get`, `wormdb_get_meta`, `wormdb_delete`, `wormdb_scan_prefix`) and `server/blobs.ts`-style fsync'd cold blocks.
- **Standalone npm Agent Bridges (`BunFileVfsStore`):** Because `@wormdb/meshrooms` on npm is pure JS/Bun (`server/agent-cli.ts:26`), agent bridges without a native WormDB library fall back cleanly to a crash-safe pure-Bun append-WAL + fsync'd CAS adapter storing identical `VfsEnvelopeV1` bytes and keys.
- **Stateless Cloud Agents (`MemoryVfsStore`):** Used with `MESHROOMS_AGENT_KEY` (`durable: false`, zero disk writes).

### 3.4 Compaction, GC, Budgets & Crash Recovery
- **Local CRDT checkpointing:** Emit a derived local `DocCheckpoint` (`snap:`) every `250 ops` or `256 KiB` of op-log per node. Once a node exceeds `20,000` raw ops, compact raw `op:` entries strictly covered by an active snapshot past the retention window (last 2 checkpoints or 7 days); wire sync always ships signed ops or verified epoch-transition snapshots.
- **Retention & shallow degradation:** Current `HEAD` tree, live node heads/latest snapshots/tail ops, active epoch keys, and explicitly pinned commits are **never evicted**. Retain full history up to `200 commits / 30 days` within device budgets; under quota pressure, sweep oldest unpinned non-HEAD cold binary chunks first (keeping commit metadata so viewing/reverting fetches evicted `cid`s on demand from peers such as desktop nodes or bridges). Mark-and-sweep GC honors `GC_GRACE_MS = 10 min` (`server/browser-agent.ts:167`) so in-flight writes are never swept.
- **WAL compaction (`sync_writes`):** Invoke `wormdb_checkpoint_sync(db)` (recommended upstream WormDB PR: under `wal_enqueue_mutex`, `writeSnapshot()` tmp+fsync+rename then `wal.truncate()`+fsync). Fallback before upstream lands: quiesced per-room directory rebuild when `walSize > 32 MiB && walSize > 4 × liveBytes` (copy live keys to `<roomDir>.compact/`, verify count & `meta`, close handles, atomic swap).
- **Write-before-publish crash ordering:** Every multi-key VFS commit writes in strict order: (1) cold chunks (`putBlock`, fsync+rename) + `bmeta`, (2) immutable `obj:<cid>` / `op:` / `snap:`, (3) `req:` idempotency receipt, (4) **atomic publish** of `node:<nodeId>:head` and `meta` + `commit:` index. Crashes during steps 1–3 leave only unreferenced orphans swept after `GC_GRACE_MS`.
- **Fail-closed error fencing:** Any `WORMDB_ERR` or IDB `StorageError` latches room-scoped `vfsStorageFailed`, refuses to acknowledge or broadcast new VFS writes for that room, surfaces a room error banner (`storageProblem`), and recovers via reopen + WAL replay (or explicit peer re-sync on WAL CRC corruption, never silently resetting to an empty divergent VFS).

---

## 4. Cryptography & `VfsEnvelopeV1`

All cryptographic primitives reuse native WebCrypto algorithms already audited in `src/browser/relay-crypto.ts` (ECDSA P-256, ECDH P-256, HKDF-SHA256, HMAC-SHA256, AES-256-GCM).

### 4.1 Binary Envelope Format (`VfsEnvelopeV1`, 56-byte overhead)

```text
Offset   Size  Field
[0..4)     4   magic     = "MVFS" (0x4d 0x56 0x46 0x53)
[4]        1   version   = 0x01
[5]        1   objKind   = 0x01 (doc-op) | 0x02 (snap) | 0x03 (commit) | 0x04 (tree-op)
                         | 0x05 (manifest) | 0x06 (chunk) | 0x10 (local)
[6]        1   flags     = bit0: deflate-raw (local snap 0x02 only; max 10x / 16 MiB); bits 1..7: 0
[7]        1   reserved  = 0x00
[8..12)    4   epoch     = uint32 BE (0 for device-local 0x10 records)
[12..28)  16   salt16    = 16-byte HKDF salt (keyed-deterministic for 0x01/0x03/0x04; random otherwise)
[28..40)  12   iv        = 12-byte AES-256-GCM IV
[40..40+N) N   ct        = AES-256-GCM ciphertext
[40+N..56+N)16 tag       = 16-byte GCM authentication tag
```

Every stored and replicated envelope has canonical identifier `cid = SHA-256(VfsEnvelopeV1)` (64 lowercase hex), allowing pre-decryption integrity verification before any AEAD or JSON work.

### 4.2 Two-Step Decryptable Keyed Derivation vs. Random-IV CAS

1. **Signed Operations & Commits (`0x01 doc-op`, `0x03 commit`, `0x04 tree-op`):**
   - Plaintext inner payload: `inner = utf8(canonicalJson({ body, signature }))`, where `signature` is a single ECDSA P-256 signature over `canonicalJson(body)` (halving catch-up verification CPU vs. double signing while keeping `{ body, signature }` portable).
   - Compute `opHash = SHA-256(inner)`.
   - Compute keyed salt placed in header `[12..28)`:
     `salt16 = HMAC-SHA256(RK_e, "meshrooms-vfs-salt-v1|" || opHash)[0..16]`.
   - Derive per-op AES-256 key and 96-bit IV:
     `(K_op[32], iv[12]) = HKDF-SHA256(ikm = RK_e, salt = salt16, info = "meshrooms-vfs-op-v1|" || roomId || "|" || epoch || "|" || objKind)`.
   - Unified AAD: `header[0..40] || utf8(roomId) || utf8(deviceId + ":" + seq + ":" + opId)`.
   - **Receiver verification order:** (a) derive `(K_op, expectedIv)` from `RK_e` and `header.salt16`; reject if `header.iv !== expectedIv`; (b) open AES-256-GCM with unified AAD; (c) recompute `opHash = SHA-256(inner)` and reject if `header.salt16 !== HMAC-SHA256(RK_e, "meshrooms-vfs-salt-v1|" || opHash)[0..16]`; (d) verify single ECDSA P-256 `signature` against `verifiedRoster` / `signerFor` and assert outer wire metadata matches decrypted `body`.
   - **Security properties:** Receiver can derive `K_op` before decrypting; outsiders without `RK_e` get zero confirmation oracle (IND-CPA); insiders cannot re-encrypt another member's op with a different IV/salt to split `cid` or `frontierHash`; and each op gets a unique 256-bit subkey, eliminating the 96-bit multi-writer AES-GCM birthday bound.

2. **CAS Binary Chunks (`0x06`), Manifests (`0x05`), Local Snapshots (`0x02`), & Local Records (`0x10`):**
   - **CAS Chunks (`0x06`, Phase 2):** Encrypted with a fresh random 256-bit block key `BK` + random `salt16` + random 12-byte `iv`; AAD `header[0..40] || utf8(roomId) || utf8(nodeId)`. `cid = SHA-256(VfsEnvelopeV1)`. The `{ cid, bk }` pairs and `plaintextSha256` live inside the `RK_e`-encrypted `manifest` (`0x05`), eliminating plaintext-hash confirmation/dedup oracles on disk and over the wire while preserving 100% CAS dedup across renames, commits, and reverts.
   - **Manifests (`0x05`):** Random `salt16` + random 12-byte `iv` under `RK_e` (AAD `bindingKey = nodeId`).
   - **Device-Local Records (`0x10` & local `0x02` snap caches):** Encrypted with random `salt16` + random 12-byte `iv` under `K_device_seal` (derived via `deriveStateKey` in `src/browser/relay-crypto.ts:956-993` from the device's non-extractable P-256 ECDH private key), with AAD `bindingKey = kvKey` to block WAL key-swap attacks.

### 4.3 Room Key Epochs (`RK_e`), Bootstrap, Delegation & Revocation
- **Epoch-1 host-only bootstrap:** The room host proactively mints random 256-bit `RK_1` (`epoch = 1`) on room creation or first VFS-capable host open, publishing a host-signed `VfsKeyEpochHeader`:
  `{ kind: 'vfs-key-epoch', v: 1, roomId, epoch, prevEpochHash, rosterVersion, hostDeviceId, at, epk, keyCommit }`
  where `keyCommit = SHA-256("vfs-rk-commit-v1|" || roomId || "|" || epoch || "|" || RK_e)` defeats host wrap-equivocation (every recipient verifies its unwrapped `RK_e` matches `keyCommit`). Recipient wraps (`VfsKeyWrapChunk`) reuse Meshrooms' audited P-256 ECDH+HKDF wrap (`relay-crypto.ts:735-828`, domain `"meshrooms-vfs-epoch-v1|..."`) chunked at `<= 64` recipients (~10 KB/chunk).
- **No dual-genesis forks:** Non-hosts **never** mint `epoch = 1`. Attempting to create the first document before `epoch = 1` arrives fails closed with `503 VFS_EPOCH_UNINITIALIZED` in CLI/MCP and an inline notice (*"Waiting for the room host to initialize shared docs…"*) in the UI.
- **Delegated key grants while host is offline (`VfsKeyGrantPacket`):** Once `epoch = 1` exists, any online admitted human device holding `RK_1..RK_e` may grant those keys to a newly admitted member, companion device, or agent whose entry verifies against `SignedRoster` / `verifyDelegatedRosterEntry` (`relay-crypto.ts:447`), attaching the original host-signed `VfsKeyEpochHeader`s so the newcomer verifies every `keyCommit` against the pinned host without requiring the host to be online.
- **Revocation (forward-only PCS):** When the host removes/revokes a device or member (`revoked: true`), the host publishes `SignedRoster v+1` AND `VfsKeyEpochHeader (epoch + 1)` wrapping a fresh independent `RK_{e+1}` strictly to active roster devices. Peers immediately switch writes to `RK_{e+1}` and reject any unheld ops signed by the revoked device (`signerFor`). If a non-host revokes their own lost device while the host is offline, peers disconnect and reject ops from it immediately, and the host rotates `RK_{e+1}` on next return. As with chat (`docs/flows/history-replication.md:146`), previously seen plaintext cannot be un-seen.
- **`historyForNewcomers` interaction:** Mirrors Tasks & Decisions (`docs/flows/history-replication.md:21-27`). In MVP (**Shared Workspace**), admitted newcomers receive `RK_1..RK_e` so current documents and their edit history are immediately usable, with explicit UI disclosure (*"Shared room documents and edit history are visible to anyone admitted to this room"*). In Phase 2, an optional strict mode rotates `RK_e -> RK_{e+1}` on join when `historyForNewcomers` is OFF, emitting a compacted current-state snapshot under `RK_{e+1}` and granting newcomers only `RK_{e+1}`.

---

## 5. Data Model: Text CRDT, Directory Tree, Reversion & Path Rules

### 5.1 Text CRDT — Signed Run-Length FugueMax (Pure TypeScript)
Room VFS adopts **Signed Run-Length FugueMax** (Weidner, Gentle, Kleppmann 2023) implemented in pure TypeScript (`~4–6 KB` gz, zero new npm dependencies, compatible with strict browser CSP `script-src 'self'` and single-file `build:agent`):

- **Code-point addressing:** Every inserted run of $L$ Unicode scalar values (rejecting lone UTF-16 surrogates, eliminating UTF-16/UTF-8 split corruption across JS/Zig) receives contiguous IDs `(deviceId, counterStart .. counterStart + L - 1)`. A signer may allocate IDs strictly under its own authenticated `deviceId`.
- **Deterministic FugueMax tree placement:** Inserting between visible `leftOrigin` (or `ROOT`) and its tree right neighbor:
  - If `leftOrigin` has no right children (including tombstones): `parent = leftOrigin`, `side = 'R'`, `rightOrigin = nextNodeInTree(leftOrigin)`.
  - Otherwise: `rightOrigin = leftmostDescendant(leftOrigin.rightChildren)`, `parent = rightOrigin`, `side = 'L'`.
  - Contiguous runs compress chained right-children `(D, c+i) -> (D, c+i-1)` and split lazily in O(1) on interior edits.
  - Sibling ordering: `'L'` children sort by `(deviceId, counter)` asc; `'R'` children sort by `rightOrigin` tree position desc (backward non-interleaving), then `(deviceId, counter)` asc. Rendered text is a pure in-order DFS, guaranteeing Strong Eventual Consistency independent of arrival order.
- **Deletions:** Commutative, idempotent set-union of tombstoned ranges `[originDeviceId, startCounter, len]`. Tombstoned runs drop UTF-8 text and keep only a ~40 B stub so offline peers referencing pre-delete origins still attach cleanly.

### 5.2 CAS Directory Tree — Kleppmann Move-Tree CRDT
- Every document, binary file, and folder has an immutable UUIDv4 `nodeId`. Renaming or moving a document never forks its CRDT text history. In MVP, all documents sit under `parentId = ROOT_DIR_ID` (`00000000-0000-0000-0000-000000000000`) while storing full normalized relative paths or parent links so Phase 2 nested folders unlock with zero wire break.
- Directory ops (`VfsTreeOpBody`: `create`, `move`, `delete` → virtual `TRASH`, `restore`, `set-blob`) fold deterministically in ascending `(lamport, deviceId, seq)` order—never wall-clock `at` (matching `src/browser/board.ts:114`).
- **Cycle prevention:** Folding skips any `move` that would make `newParentId` equal to `nodeId` or a descendant of `nodeId`.
- **Concurrent name collisions:** Case-folded per parent (`foldName = clean.toLocaleLowerCase('en-US')`). Lowest `(lamport, deviceId, seq)` keeps the clean name; any colliding live sibling deterministically renders as `<stem> (conflict-<nodeId[0..4]>).<ext>`. Neither document is ever silently overwritten or lost.
- **Delete vs. concurrent edit:** `delete` moves `nodeId` to virtual `TRASH`; concurrent CRDT ops still apply cleanly to `nodeId` and flag the trashed item as modified after delete for one-click restore.

### 5.3 Two-Tier History & CRDT-Safe Reversion (Zero Offline Resurrection)
Fine-grained coalesced `VfsDocOpBody` ops form the causal DAG; `VfsCommitBody` records human-meaningful milestones automatically on agent `write`/`patch`/`revert`, explicit human *Save checkpoint* / *Revert*, 60-second idle edit boundaries, and tree/blob mutations.

**Reverting NEVER rewinds heads, deletes ops, or un-tombstones deleted IDs** (which would cause reconnecting offline peers to resurrect reverted text):
1. Materialize target text $T_{\text{target}}$ by evaluating the causal cone of `targetCommit.docFrontier[nodeId]` (or target frontier digest).
2. Compute a minimal Myers diff from current visible FugueMax text $T_{\text{now}}$ (at frontier $F_{\text{now}}$) to $T_{\text{target}}$.
3. Emit **both**:
   - A forward compensating `VfsDocOpBody` (`parents = F_now`, `revertsCommit = targetCommitId`) deleting visible IDs in $T_{\text{now}} \setminus T_{\text{target}}$ and inserting restored runs under fresh `(reverterDeviceId, counter..)` IDs; and
   - A `VfsCommitBody` (`scope: 'doc'`, `revertsCommit = targetCommitId`).
4. **Offline peer convergence:** Offline peers holding ops $\subseteq F_{\text{now}}$ converge cleanly to $T_{\text{target}}$ with zero resurrection. If an offline peer had **unseen concurrent edits** outside $F_{\text{now}}$, FugueMax preserves those edits without silent data loss and both `vfs-history` JSON (`concurrentEditsDuringRevert: true`, `concurrentOpAuthors`) and the browser UI (`DocHistory.tsx` + inline banner in `DocEditor.tsx`) display a `concurrent-edit-during-revert` warning whenever an op's causal cone is incomparable with a revert op's `parents`. Tree/blob reverts emit forward higher-Lamport `move`/`restore`/`delete`/`set-blob` ops referencing immutable historical `manifestHash`es.

### 5.4 Canonical Path Rules (`src/browser/vfs-path.ts`) & Unified Limits
Enforced identically by CLI, `outboxProblem()`, browser UI, desktop `local-api.ts`, and every receiving peer:
- **Path format:** Relative POSIX path, NFC-normalized, **`1..240` UTF-8 bytes**, **`1..8` `/`-separated segments**, **`1..80` chars/segment**.
- **Rejections:** Leading or trailing `/`, `//`, `.` or `..` segments, all Unicode control/format chars `[\p{Cc}\p{Cf}]` (zero-width, bidi overrides), `\u2028-\u2029`, NUL `\0`, forbidden segment characters `/ \ : * ? " < > |`, leading or trailing dots/spaces per segment, Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without extensions), and reserved prefixes `.meshrooms/` and `.git/`.
- **Text content validation (MVP):** Valid UTF-8 with no NUL bytes; UTF-8 BOM stripped; CRLF normalized to LF while preserving trailing `\n`.

| Limit / Parameter | Canonical Value | Notes |
| --- | --- | --- |
| CRDT text doc size | **`256 KiB` soft MVP UI/agent default / `1 MiB` hard protocol ceiling** | Peers reject CRDT docs > `1 MiB`; larger files use Phase 2 binary CAS |
| Binary CAS file size (Phase 2) | **`10 MiB`** (`MAX_VFS_FILE_BYTES`) | Matches `MAX_ATTACHMENT_BYTES` (`src/browser/files.ts`) |
| CAS chunk / wire slice size | **`64 KiB` block** / **`12,000 B` wire slice** (`16,000` b64 chars) | Fits WebRTC 20 KB drop cap & relay `21 KiB` padded plaintext cap |
| Max op plaintext / sub-ops | **`12 KiB`** / **`64` sub-ops per op** | Pre-parse anti-DoS bound |
| Live docs / tree entries per room | **`256` live docs (`64`/member shared)** MVP / **`1,024`** full tree | Deterministic per-member fairness |
| Hot KV budget per room | **`32 MiB` browser** / **`64 MiB` desktop & bridge** | Protects WormDB RAM & WASM heap |
| Cold CAS budget per room | **`256 MiB` browser** / **`1 GiB` desktop & bridge** | 50% single-member cap when >1 member (`files.ts:85-101`) |
| Op checkpoint / compaction | Local snap every **`250 ops` / `256 KiB`**; hard compact at **`20,000` ops/doc** | Preserves history up to 200 commits / 30 days within budget |

---

## 6. P2P Replication Protocol & Relay Quota Pacing

### 6.1 Wire Packet Schemas (Backwards-Compatible; Unknown `kind`s Ignored)

```ts
export type VfsAuthorStamp = {
  v: 1; roomId: string; opId: string; deviceId: string; memberId: string;
  epoch: number; seq: number; lamport: number; at: number;
  visibility: 'room' | 'members'; audienceUntil?: number;
};

export type VfsDocOpBody = VfsAuthorStamp & {
  kind: 'vfs-doc-op'; nodeId: string; parents: string[]; counterStart: number;
  ops: (
    | { t: 'ins'; parent: [string, number] | null; side: 'L' | 'R'; rightOrigin?: [string, number] | null; text: string }
    | { t: 'del'; runs: [string, number, number][] }
  )[];
  revertsCommit?: string;
};

export type VfsTreeOpBody = VfsAuthorStamp & {
  kind: 'vfs-tree-op'; nodeId: string; parents: string[];
  action:
    | { t: 'create'; nodeKind: 'doc' | 'blob' | 'dir'; parentId: string; name: string; mime?: string; manifestHash?: string; size?: number }
    | { t: 'move'; parentId: string; name: string }
    | { t: 'delete' }
    | { t: 'restore'; parentId: string; name: string }
    | { t: 'set-blob'; manifestHash: string; size: number; mime: string; plaintextSha256: string };
};

export type VfsCommitBody = VfsAuthorStamp & {
  kind: 'vfs-commit'; commitId: string; scope: 'doc' | 'tree'; nodeId?: string;
  parentCommits: string[]; docFrontier: Record<string, string[]>; treeFrontier: string[];
  treeRootHash: string; contentSha256?: string; summary?: string; revertsCommit?: string;
};

// Outer replicated record carrying binary VfsEnvelopeV1 (base64 on JSON channels)
export type VfsRecordPacket = {
  kind: 'vfs-record'; v: 1; roomId: string; epoch: number;
  objKind: 0x01 | 0x03 | 0x04; nodeId: string; deviceId: string; seq: number; opId: string;
  env: string; // base64(VfsEnvelopeV1)
};
```

- **Anti-entropy frames (`PRIMARY_CHANNEL_LABEL` / relay `lane: 'primary'`):**
  - `vfs-have`: `{ kind: 'vfs-have', v: 1, roomId, vector: Record<deviceId, contiguousSeq>, haveSeqs?, conflictIds?, frontierHash?, cursor?: { r, d, s, i }, nodeId? }`
  - `vfs-ops`: `{ kind: 'vfs-ops', v: 1, roomId, entries: VfsRecordPacket[], more?: boolean, nextCursor?, done?: true, retryAfterMs?: number }`
  - `vfs-key-epoch` / `vfs-key-wrap` / `vfs-key-grant`: room epoch distribution frames (§4.3).
- **Bulk CAS block frames (`FILE_CHANNEL_LABEL` / relay `lane: 'file'`, Phase 2):**
  - `vfs-block-want` / `vfs-block-chunk` (`<= 12,000 B` raw) / `vfs-block-done` / `vfs-block-missing`, reusing `FileTransfers` (`src/browser/files.ts`, `HIGH_WATER = 256 KB`, `MAX_INFLIGHT_BYTES = 32 MB`, 15 s stall skip, 10 min bad-peer distrust).
- **Native MeshGuard:** Carries canonical `VfsEnvelopeV1` bytes over `meshrooms-v1` (952 B chunked) and cold CAS blocks over `XFER*`.

### 6.2 Anti-Entropy, Relay Pacing & Adversarial Bounds
- **O(1) fast-path + receipt-clock pagination:** `frontierHash = SHA-256(sorted cids)`. Matching `frontierHash` completes in 1 RTT with zero ops transferred. Otherwise the serving peer pages up to `MAX_VFS_OPS_PER_RESPONSE = 64` entries in chunks `<= 14,000 chars` (safe under WebRTC `20,000`-char drop cap and relay `21 KiB` padded plaintext cap) ordered strictly by serving peer receipt clock `(receivedAt desc, deviceId, seq, opId)` with `retryAfterMs` hints (mirroring `src/browser/history-sync.ts`). Optional `nodeId` filtering fetches the active open document first.
- **`VfsRelayBudget` pacer:** Under the relay's outer limit (`120 frames/min` and `2 MiB/min`, `server/browser/relay.ts:21-22`), reserve `>= 50%` capacity for chat, receipts, tasks, and decisions: cap outbound relay VFS sends at **`<= 48 frames/min` (`30` ops + `18` blocks) and `<= 900 KB/min`**, yielding immediately to chat. On relay `rate-limit` rejection, pause VFS with jittered backoff (`2 s -> 5 s -> 15 s`) preserving cursor. Mandatory keystroke coalescing: `300 ms` on WebRTC, `1,000 ms` on relay. Under HTTPS fallback (`16` envelopes / `56 KB` per `POST /api/relay/v1/send`), `900 KB/min` equals `< 0.3 req/s`—well within Nginx's `20 req/s` (`deploy/nginx/meshrooms-limits.conf:36`).
- **Strict Zero `hold: true` / `wake: true` Invariant:** No VFS frame ever sets `hold: true` or `wake: [...]`. Agents wake only via chat/tasks/decisions and pull VFS via `vfs-have` from online peers. **Honest Decision 1 trade-off:** a stateless cloud agent (`MESHROOMS_AGENT_KEY`) waking while every peer holding WormDB is offline cannot pull VFS documents until an online room peer connects (failing explicitly with `503 VFS_NO_ONLINE_PEER`).
- **Equivocation & DoS protection:**
  - Conflicting `(deviceId, seq)` entries are both retained (`<opHash8>` key suffix), `vector[dev]` halts before `firstConflictSeq`, `conflictIds` propagates evidence, and the UI shows a tamper warning. Overlapping FugueMax counter allocations deterministically apply only the lower `opHash` so honest peers converge identically.
  - Strict pre-apply bounds: `MAX_PENDING_VFS_OPS_PER_MEMBER = 128`, `MAX_PENDING_VFS_OPS_GLOBAL = 512`, `PENDING_VFS_OP_TTL_MS = 5 min`, `parents.length <= 16`, `counterJump <= 100_000`, `lamportJump <= 10_000` (prevents Lamport-freezing attacks like `src/browser/board.ts:253`), `del.len <= 65_536`.
  - Extend `ReceiveQuota` (`src/browser/quota.ts:13`) with `'vfs-op'` (`60/min`, burst `30`) and `'vfs-sync'` (`1,024 entries/min`, burst `512`), plus `PeerRateLimiter` (`60/min`, burst `24`) on `serveVfs` and `QuotaDrops` resync.

---

## 7. Agent CLI/MCP Interface, Sandbox-Safe IPC & Loop Safety

### 7.1 Single-Token `vfs-*` Subcommands & Room-Pinned MCP Tools
All VFS commands are **single top-level hyphenated verbs** (matching `task-add`, `decision-wait`) so all 6 wake confinement surfaces stay 1:1 with zero drift: `WAKE_COMMANDS` (`server/agent-watch.ts:349`), `MCP_TOOLS` / `TOOL_SCHEMAS` / `toolArgv` (`server/mcp.ts:31-115`), `HERMES_ROOM_TOOLS` (`server/agent-watch.ts:97`), `agy-confinement.ts` (`WAKE_SUBCOMMANDS`, `STDIN_FLAGS`, `PATH_FLAGS`), `wakeGuard()` (`server/agent-cli.ts:2277`), and `outboxProblem()` (`server/browser-agent.ts:700`). MCP schemas omit `room` (pinned by launch arg) and refuse `-` stdin values (`server/mcp.ts:91`).

| Command / MCP Tool | Key Flags / MCP Arguments | Behavior & Output |
| --- | --- | --- |
| **`vfs-list`** *(read)* | `[--prefix DIR/] [--include-deleted]` | Returns `{ roomId, vfsCursor, treeHead, files: [{ nodeId, path, kind, mime, rev, frontier, revSeq, sizeBytes, lineCount, contentSha256, updatedAt, updatedBy, deleted }], limits }`. |
| **`vfs-read`** *(read)* | `--path PATH \| --node-id UUID [--rev REV] [--start-line N] [--end-line N] [--max-bytes 65536]` | Returns `{ roomId, nodeId, path, mime, rev, frontier, revSeq, contentSha256, sizeBytes, totalLines, startLine, endLine, truncated, nextStartLine?, content, updatedAt, updatedBy }`. Supports historical `--rev` reads. |
| **`vfs-write`** *(write)* | `--request-id UUID --path PATH (--content TEXT \| --content-file FILE \| --content -) [--base-rev REV \| --create-only] [--summary TEXT] [--reply-to MSG_ID]` | New path assigns `nodeId = requestId` (idempotent retries). Existing path requires `--base-rev` (`400 VFS_BASE_REV_REQUIRED` if omitted) or fails `409 VFS_ALREADY_EXISTS` with `--create-only`; translates `diff(baseText, newText)` into minimal FugueMax ops and fails closed `409 VFS_CONFLICT` if `baseRev !== headRev`. |
| **`vfs-patch`** *(write)* | `--request-id UUID --path PATH --base-rev REV (--edits JSON \| --edits-file FILE \| --edits -) [--summary TEXT] [--reply-to MSG_ID]` | Safe concurrent anchor-hunk editor (§7.2). |
| **`vfs-history`** *(read)* | `[--path PATH \| --node-id UUID] [--limit 20] [--before REV]` | Returns reverse-chronological commits with `{ rev, commitId, parents, kind, summary?, author: { memberId, name, role, operatorId?, operatorName?, deviceId }, at, bytesDelta, linesAdded, linesRemoved, revertedTo?, concurrentEditsDuringRevert?, concurrentOpAuthors? }`. |
| **`vfs-diff`** *(read)* | `--path PATH --from REV_A [--to REV_B] [--context-lines 3]` (`--from prev` = `head~1`) | Returns `{ roomId, nodeId, path, fromRev, toRev, linesAdded, linesRemoved, truncated, diff, authorsBetween }`. |
| **`vfs-revert`** *(write)* | `--request-id UUID --path PATH --to-rev REV --base-rev HEAD_REV [--summary TEXT] [--reply-to MSG_ID]` | Emits compensating forward `VfsDocOpBody` (`parents = F_now`, `revertsCommit`) + `VfsCommitBody`. Fails `409 VFS_CONFLICT` if `baseRev !== headRev`. |
| **`vfs-delete`** *(write)* | `--request-id UUID --path PATH --base-rev HEAD_REV [--summary TEXT] [--reply-to MSG_ID]` | Soft-delete to virtual `TRASH` (restorable via `vfs-revert` / UI). Subject to agent permission policy (§7.4). |

*Phase 2 additions:* `vfs-mv`, `vfs-put`, `vfs-get` (binary CAS chunks confined to `wakeDir` during wakes, matching `attachment`), and `vfs-snapshot`.

`--content` and `--edits` are added to `TEXT_OPTIONS` (`server/agent-cli.ts:271`) and `agy-confinement.ts` (`STDIN_FLAGS` / `PATH_FLAGS`), confining `-file` arguments to `wakeDir` via `insideDir` during wakes while preserving trailing `\n`. `watchPrompt()` bumps pre-generated `requestIds()` from 3 to 5 UUIDs and marks VFS content as untrusted room data.

### 7.2 Concurrent-Safe LLM Patching (`vfs-patch` + Strict Contiguity)
- **Canonical `rev` identifiers:** Every document revision is either a `commitId` (UUID, resolving to `commit.docFrontier[nodeId]`) OR a canonical uncommitted frontier digest `f:<sha256(sortedOpHashes.join(','))[0..16]>` backed by `node:<nodeId>:head`'s local `frontierMap` (last 256 observed frontiers per doc). All `--rev`, `--base-rev`, `--from`, `--to` flags accept either form.
- **Structured `VfsEditHunk` schema** (avoids unified-diff line-number miscounts):
  ```ts
  export type VfsEditHunk =
    | { op: 'replace'; old: string; new: string; before?: string; after?: string }
    | { op: 'insert_after' | 'insert_before'; anchor: string; text: string; before?: string; after?: string }
    | { op: 'append' | 'prepend'; text: string };
  ```
- **5-step serialized application inside `runBridge`:**
  1. **Idempotency:** Check `${P}req:<actorId>:<requestId>`; if already applied, return `{ status: 'already-applied', nodeId, path, rev, vfsCursor }` without signing again.
  2. **Base-revision matching:** Reconstruct exact visible FugueMax code-point sequence at `baseRev`. Match every hunk uniquely against `baseRev` using optional `before`/`after` context (0 matches → `409 VFS_ANCHOR_NOT_FOUND`; >1 matches → `409 VFS_ANCHOR_AMBIGUOUS` with candidate line numbers; overlapping hunks in one call → `400 VFS_OVERLAPPING_HUNKS`).
  3. **Strict visible-DFS contiguity check (`baseRev` → `headRev`):**
     - Map each hunk's full matched span (`before? + old/anchor + after?`) to its ordered FugueMax code-point IDs `[e_0 .. e_{k-1}]` in `baseRev`.
     - In `headRev`'s visible DFS order, require that `e_0` is visible **and every `e_j` is the immediate next visible code point after `e_{j-1}`** (`headVisible[p + j].id === e_j` for all `j`)—guaranteeing **zero tombstones AND zero concurrent mid-span insertions**.
     - For zero-width `insert_after` / `insert_before` boundaries, also verify **zero newly inserted visible code points** exist between the original adjacent pair `(leftId, rightId)` from `baseRev` (and for `append`/`prepend`, verify the EOF/BOF visible neighbor ID is unchanged).
     - **Disjoint concurrent edits** (e.g., human typed in a different paragraph): translate each hunk via minimal Myers diff directly relative to `[e_0 .. e_{k-1}]` and emit ONE signed `VfsDocOpBody` + `VfsCommitBody`, preserving 100% of the human's concurrent edits (`rebased: true`).
     - **Any tombstone, mid-span insertion, seam insertion, or doc deletion:** fail closed with **`409 VFS_CONFLICT`** returning `{ code: 'VFS_CONFLICT', path, baseRev, currentRev, conflicts: [{ hunkIndex, reason, currentExcerpt }], hint }`.
  4. **Bounds & floor checks:** Verify `mayAgentSpeak`, path rules, `MAX_TEXT_DOC_BYTES`, and `MAX_OP_PLAINTEXT_BYTES` before signing.
  5. **Durable-first commit:** Persist to `VfsStore` (synchronous WAL / fenced IDB) before broadcasting over WebRTC/relay.

### 7.3 Single-Owner WormDB & Sandbox-Safe File-Mailbox IPC
Because WormDB is single-writer RAM-resident AND VFS records are sealed under `K_device_seal` (`identity.json`), **`run` (`runBridge`) exclusively owns `<roomDir>/vfs/wormdb/` and `identity.json`**. Add `<roomDir>/vfs/` to `wakeReadDenies()` (`server/agent-watch.ts:537`) beside `identity.json`.

Confined Codex wakes run with `permissions.meshrooms_wake.network.enabled=false` (`server/agent-watch.ts:629`), blocking loopback TCP and OS-sandboxed sockets, whereas `WAKE_WRITABLE = ['live', 'outbox', 'files', 'wants', 'wake']` (`server/agent-watch.ts:289`) works across every harness (Claude, Codex, Hermes MCP, Antigravity, DSH) on Linux, macOS, and Windows. All CLI and MCP VFS calls therefore share one **symlink-hardened ephemeral file-mailbox RPC**:

- **Reads (`vfs-list`, `vfs-read`, `vfs-history`, `vfs-diff`, and `listen`'s `{ vfsCursor, vfsChanges }`):**
  1. CLI generates UUID `queryId` and writes `{ type: 'vfs-query', id: queryId, op, ... }` atomically (`0o600`, `replaceFile`) to `<roomDir>/outbox/q-<queryId>.json`.
  2. `run` watches `outbox/` via `fs.watch` (10 ms debounce + 250 ms fallback poll, sub-20 ms RTT, decoupled from the 1 s network pass), checks `lstatSync(reqFile).isFile()` and `lstatSync(replyDir).isDirectory()` (rejecting/removing planted symlinks), reads directly from its RAM-resident WormDB + FugueMax state, writes the bounded JSON reply (`<= 64 KiB` default) via `replaceFile` (`0o600`, replacing rather than following any planted symlink) to `<roomDir>/live/vfs-reply/<queryId>.json`, and unlinks `q-<queryId>.json`.
  3. CLI reads and **immediately unlinks** `<roomDir>/live/vfs-reply/<queryId>.json` (`run` sweeps orphaned replies `> 30 s` old). **Zero plaintext document bodies, filenames, or summaries are persisted at rest on disk** (no persistent `vfs-summary.json`).
- **Writes (`vfs-write`, `vfs-patch`, `vfs-revert`, `vfs-delete`):** CLI writes `<roomDir>/outbox/<ts>-<requestId>.json`; `run` validates, commits synchronously, broadcasts, writes the receipt or structured error/conflict JSON to `<roomDir>/live/vfs-reply/<requestId>.json`, and unlinks the outbox file.
- **MCP & Desktop parity:** `server/mcp.ts` dispatches `agentCli(argv)` in-process (automatically using the exact same RPC). `server/local-api.ts` serves the desktop UI over its authenticated loopback HTTP API directly against the person runner (sharing the same `VfsIpcClient` boundary).
- **When `run` is stopped:** Outside a wake, `agentCli` runs `repairRunner()` first (`server/agent-cli.ts:2683`); for read-only inspection of a closed room (`room-closed.json`), outside-wake CLI acquires `runner.lock`, confirms no `run` PID is alive, opens `<roomDir>/vfs/wormdb/` read-only with `identity.json`, answers, and immediately closes. Inside a wake, `repairRunner()` never runs and timeouts fail cleanly as `runner-stopped` (`server/browser-agent.ts:2520-2523`).

### 7.4 Permissions, Attribution & Agent Loop Safety
- **Permissions:**
  - **Humans (admitted members & Host):** Create, edit, revert, soft-delete, and restore any document (matching the collaborative task board model in `src/browser/board.ts:276`).
  - **Agents (admitted, non-revoked):** Read commands are always allowed. Mutating commands (`vfs-write`, `vfs-patch`, `vfs-revert`) are **floor-gated by `mayAgentSpeak(view, memberId, item.replyTo)`** in both CLI and `runBridge.outboxProblem()`: in `humans-first` rooms, agents edit only when replying to an addressing human message (`--reply-to`) or holding an active assigned task; `operator-only` agents edit only on their operator's behalf. Soft-delete (`vfs-delete`) defaults to **humans-only** (or restricted to docs where `doc.createdBy === agent.memberId`, verified peer-side via `members`/`formerDevices` roles), and any human can always restore.
- **Cryptographic Attribution:** Author `deviceId` and `memberId` are verified against `verifiedRoster` / `signerFor`; display name, `role`, and `operatorId`/`operatorName` are derived from room membership (never self-asserted) and displayed as `AgentName (agent · for Operator)`.
- **Live pickup lease safety:** Include agent VFS ops in `lastActed()` (`server/agent-cli.ts:206`) and `ownActions()` (`server/agent-cli.ts:1010`) and call `agent.touchActivity()` on VFS writes so a live session actively patching documents keeps its `live.json` pickup lease and never triggers a competing headless wake.
- **Hard Non-Waking Invariant:** `peekWork()`, `evaluateWake()`, and `computeRelayWakeMeta()` **never** wake agents on VFS edits, creates, reverts, or `@mentions` inside document prose (eliminating typing-storm wake exhaustion, `loopGuard` bypasses, and in-doc prompt-injection wakes). Humans (or agents within `people-and-agents` `loopGuard`) hand off document work via normal chat `@mentions`, task assignments, or `plan-review` decisions. When `listen` already returns (`state: 'history' | 'addressed'`), it piggybacks `{ vfsCursor, vfsChanges }` (last 20 coalesced headers since `ListenCursor.vfsAfter`) fetched via the ephemeral file-mailbox RPC.

---

## 8. Work-First Browser & Desktop Room UX

The UI extends `docs/browser-room-surface.md` (navy rail, cool paper, Manrope typography, blue actions, 44 px targets, keyboard focus restoration, `< 1150 px` full-pane takeover) and flows through `RoomSource` / `RoomSession` (`src/browser/source.ts`, `src/browser/local-source.ts`) so hosted browser rooms and the desktop app share identical screens:

- **Header entry (`src/browser/BrowserRooms.tsx`):** Add a `Docs` button beside `Decisions` and `Tasks` in `.browser-room-actions` and `.browser-header-menu`, mutually exclusive with `Decisions`, `Tasks`, and `Room details`. Resizable via `BoardHandle` (`src/browser/panel.ts`: `DOCS_MIN = 360`, `DOCS_DEFAULT = 520`, `CONVERSATION_MIN = 360`, persisted to `localStorage`).
- **Document list:** `+ New doc` inline path input with live `vfs-path.ts` validation, sorted list grouped visually by `/` prefix, last editor (`for Operator` badge for agents), relative time, size, live presence dot, and `Show deleted (N)` toggle for one-click restore. Displays `"Waiting for the room host to initialize shared docs…"` when `epoch = 1` has not arrived.
- **Document view (`Edit` | `Preview` | `History`):**
  - **Edit:** Zero-dependency `<textarea>` bound to the local FugueMax CRDT (0 ms local latency; debounced `300 ms` WebRTC / `1,000 ms` relay wire flush; remote ops map `selectionStart`/`selectionEnd` through CRDT positions so concurrent agent patches never jump the user's cursor). Header shows sync state (`Saved locally` / `Synced to N devices`), ephemeral doc-level presence (`Alice is editing`), optional `Save checkpoint`, and inline-confirmed `Delete`.
  - **Preview:** Reuses existing CSP-safe `MentionText` / `parseMarkdown` (`src/markdown.ts`, `src/prototype/Collaboration.tsx`) for headings, tables, fenced code, `@mentions`, and `#42` pinned-repo links.
  - **History:** Reverse-chronological commits with author/operator badges, summaries, `+lines/-lines`, pure LCS line-by-line unified diff (`Changes in rN` vs. `Diff vs. Current`), `concurrent-edit-during-revert` warning banner when applicable, and one-click `Restore this version` (inline confirm → compensating CRDT revert).
  - Footer disclosure: *"Docs stay encrypted on room devices. Zero server storage."*
- **Compact room-stream activity (`src/browser/work-stream.ts`):** `VfsEvent` entries are derived projections from signed commits (never `MessageBody` packets, never consuming the 5,000-message window or unread mention badges), coalesced per `(memberId, nodeId)` over a **5-minute window (`VFS_EVENT_WINDOW = 300_000 ms`)**. In `focused` ("Humans & Outcomes") zoom, 2+ consecutive routine edits fold into `EventsFold` (`"3 doc updates · Show"`), while creates, deletes, and reverts remain single clickable lines.

---

## 9. Phased Implementation Plan & Test Strategy

### 9.1 Independently Shippable PR Slices
Zero changes are required to `server/browser/lobby.ts` or `server/browser/relay.ts` across all slices.

| PR | Scope | Primary Files / Modules |
| --- | --- | --- |
| **PR 1** | Pure VFS Core: `vfs-path`, FugueMax CRDT, Move-Tree, `VfsEnvelopeV1`, `vfs-patch` (strict contiguity + compensating revert), LCS `vfs-diff`, `vfsTimeline`, `VfsStore` interface | `src/browser/vfs-path.ts`, `vfs-crdt.ts`, `vfs-tree.ts`, `vfs-crypto.ts`, `vfs-patch.ts`, `vfs-diff.ts`, `vfs.ts`, `vfs-store.ts` (+ `*.test.ts`) |
| **PR 2** | Storage Adapters: fenced `IndexedDbVfsStore` (`meshrooms-browser-v1` v2), `WormDbFfiVfsStore` (expanding `server/persistence/wormdb.ts` FFI v0.3 bindings), `BunFileVfsStore` fallback, `MemoryVfsStore` | `src/browser/storage.ts`, `src/browser/vfs-idb.ts`, `server/persistence/wormdb.ts`, `server/persistence/vfs-wormdb.ts`, `server/persistence/vfs-bun-file.ts` (+ crash tests) |
| **PR 3** | P2P Replication & Pacing: `vfs-have`/`vfs-ops`/`vfs-key-*`, `VfsRelayBudget`, `ReceiveQuota` (`'vfs-op'`, `'vfs-sync'`), `QuotaDrops`, revocation & equivocation handling | `src/browser/quota.ts`, `src/browser/peers.ts`, `server/browser-agent.ts` (+ convergence fuzz tests) |
| **PR 4** | **Headless MVP** — Agent CLI, MCP, File-Mailbox RPC & 6-surface Confinement (`vfs-list/read/write/patch/history/diff/revert/delete`) | `server/browser-agent.ts`, `server/agent-cli.ts`, `server/mcp.ts`, `server/agent-watch.ts`, `server/agy-confinement.ts` (+ CLI/MCP/confinement tests) |
| **PR 5** | **Full MVP** — Browser & Desktop `Docs` UI, Live Editor, Preview, History/Diff/Revert, `EventsFold`, & `local-api.ts` Parity | `src/browser/DocsPanel.tsx`, `DocEditor.tsx`, `DocHistory.tsx`, `BrowserRooms.tsx`, `work-stream.ts`, `panel.ts`, `source.ts`, `local-source.ts`, `browser.css`, `server/local-api.ts`, `server/person.ts` |
| **PR 6** | **Phase 2 (Full VFS)** — Chunked `64 KiB` Binary CAS on `FILE_CHANNEL_LABEL`, Folders, Drag-and-Drop, `vfs-mv/put/get/snapshot`, Attachment Promotion, 256 MiB/1 GiB Quotas & GC | `src/browser/vfs-blocks.ts`, `src/browser/files.ts`, `DocsPanel.tsx`, `server/agent-cli.ts`, `server/mcp.ts` |
| **PR 7** | **Phase 2/3 (WormDB WASM+OPFS)** — Dedicated Worker `WormDbWasmVfsStore` + OPFS shim, Safari Private fallback, IDB→OPFS migration, `wormdb_checkpoint_sync`, CSP `'wasm-unsafe-eval'` (`server/browser/http.ts:119`) | `src/browser/vfs-wormdb-wasm.ts`, `src/browser/vfs-worker.ts`, `server/browser/http.ts` (+ upstream `wormdb` checkpoint PR) |

### 9.2 Verification & Test Strategy
1. **Unit & Property Tests (`bun test`):** `vfs-path.test.ts` (traversal, NUL, bidi, Windows reserved names, NFC, case-collision); `vfs-crypto.test.ts` (two-step HMAC+HKDF deterministic op envelope verification, tamper/malleability rejection, AAD mismatch, `keyCommit` wrap-equivocation rejection); `vfs-patch.test.ts` (ambiguous anchors, disjoint CRDT auto-rebase, overlapping/mid-span/seam `409 VFS_CONFLICT`, idempotent retries, compensating revert); `mcp.test.ts`, `wake-guard.test.ts`, `agy-confinement.test.ts`, `hermes-binding.test.ts` (room pinning, stdin `-` refusal, `wakeDir` file confinement, `outboxProblem` floor check, symlink rejection on file-mailbox RPC, `HERMES_ROOM_TOOLS === MCP_TOOLS`).
2. **Multi-Peer Convergence & Partition Fuzz (`src/browser/vfs-convergence.test.ts`):** 3–5 simulated peers with random drops, reorders, partitions, equivocating nodes, concurrent human typing + agent patching, and an offline peer syncing stale ops after a revert → assert bit-for-bit identical rendered text, tree state, and heads after heal, zero resurrected text, and zero agent wake loops.
3. **Crash-Recovery & Fencing (`server/persistence/vfs-wormdb.test.ts`, `src/browser/vfs-idb.test.ts`):** Immediate `SIGKILL` after write ack → reopen → zero loss; injected read-only WAL failure latches `vfsStorageFailed` and never broadcasts; browser `FenceError` aborts stale tab writes without corrupting the active tab; `QuotaExceededError` surfaces `storageProblem`.
4. **End-to-End Browser + Agent Bridge Smoke (`scripts/vfs-room-smoke.mjs`):** Isolated loopback coordinator + 2 Chromium profiles + real agent bridge: Host creates `spec.md` → Guest sees it live → Host mentions `@Agent` → Agent runs `vfs-list`/`vfs-read`/`vfs-patch` while Guest concurrently edits a disjoint paragraph → both edits converge cleanly → Host views diff and clicks `Restore this version` → all 3 peers converge → `bun scripts/check-public.ts --require-terms` reports 0 hits.

---

## 10. Open Decisions for Sign-Off

| # | Decision | Recommended Default | Alternative |
| --- | --- | --- | --- |
| 1 | **Text CRDT Engine** | **Pure-TS Signed Run-Length FugueMax** (0 new deps, ~4–6 KB gz, CSP-clean, native P-256 author-bound ops) | Yjs wrapped in signed envelopes (~25 KB gz, faster ProseMirror path later, weaker Byzantine isolation) |
| 2 | **`historyForNewcomers` vs. VFS History** | **Shared Workspace in MVP** (current docs + edit history shared with admitted newcomers like Tasks & Decisions, with explicit UI notice; optional `RK_{e+1}` snapshot-only redaction in Phase 2) | Strict redaction from day 1 (requires host-online epoch rotation on every join) |
| 3 | **Revocation Key Rotation Scope** | **Forward-only `RK_{e+1}` rotation** (new ops/blocks use `RK_{e+1}`; existing members retain older epoch keys) | Full re-encryption compaction of all live files on every revocation (high relay burst; marginal gain since revoked peer could copy seen files) |
| 4 | **Agent `vfs-delete` Permissions** | **Humans-only (or creator-only for an agent's own drafts)**, always soft-delete restorable by any human (writes/patches/reverts floor-gated via `mayAgentSpeak`) | Allow agents to soft-delete any document |
| 5 | **Upstream `wormdb_checkpoint_sync` Timing** | **Land ~25 LOC `wormdb_checkpoint_sync` PR in `wormdb` alongside MVP** (cleanly solves `sync_writes` WAL growth for desktop, bridge, and future WASM+OPFS) | Defer and use quiesced directory-swap compaction first |
| 6 | **Optional Local WORM Audit Log (`wormdb_append_log`)** | **Off by default, opt-in per desktop/bridge node** (avoids un-reclaimable WORM growth while enabling MMR audit proofs where desired) | Enable by default on all nodes |
| 7 | **Room-Stream VFS Activity** | **5-minute coalesced `VfsEvent` lines folded in `EventsFold`** (non-waking, non-message) | Keep VFS activity strictly inside the `Docs` panel |
