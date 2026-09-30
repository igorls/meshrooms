# Security resource-fairness fixes

Date: 2026-09-22

Outcome: **fixed**; source integration does not deploy a runtime or publish a release.

## Scope and evidence

Two validated low-severity findings from an automated security scan:

- Stream exhaustion: one authenticated room agent could occupy all
  sixteen event streams, denying new streams to the owner and other rooms.
- Assembly exhaustion: one explicitly paired peer could occupy all
  sixteen incomplete message assemblies and delay unrelated rooms.

Both original paths reproduced through real handlers before the fix. The peer
regression failed with zero messages received in an unrelated room after an
attacker filled the assembly table. SSE tests demonstrated unrestricted extra
views and missing identity accounting. These are availability/fairness defects,
not evidence of cross-room data disclosure.

## Narrow enforcement boundaries

`server/http.ts` accounts by authenticated participant, room and view at stream
admission. It retains the sixteen-stream backstop, limits agents to two streams
per participant and four per room, and reserves four of the sixteen slots from
agent use. Owner cookies and bearer authentication share the same owner identity.
Duplicate active view IDs for one identity return 429. Guarded cleanup releases
once on abort, cancellation or setup failure. Ordinary multi-tab owner access,
scoped snapshots and reconnect-after-cleanup remain supported.

`server/peer-bridge.ts` admits new assemblies only after pairing and frame
validation. The existing bounded map is the source of accounting: four assemblies
per authenticated sender across its rooms, two per room, sixteen globally.
Existing assemblies can complete at capacity; ACKs bypass allocation. Expiry
runs at the allocation boundary as well as during pumping, at the original
thirty-second deadline. Duplicates cannot extend that deadline. Completion,
including invalid content, and close release slots. No protocol or persisted
schema changes are required.

These shared admission points cover the actual resource allocation paths without
changing authentication, durable writes, pairing, or message formats.

## Changed files

- `server/http.ts`, `server/peer-bridge.ts`: enforcement and lifecycle.
- `server/http.test.ts`, `server/peer-bridge.test.ts`: nine regression groups.
- `server/first-run.test.ts`: one real-daemon HTTP/SSE regression.
- `docs/local-daemon.md`, `docs/peer-delivery.md`: documented limits.
- This report.

## Ordered verification

### 1. Candidate, syntax and imports

- Final diff inspected; `git diff --check`: pass.
- `bun run check` on Windows / Bun 1.4.2: pass.
- Independent read-only investigation and one independent candidate review:
  completed; no concrete surviving bypass or regression reported.

### 2. Original triggers and alternate inputs

- `bun test ./server/http.test.ts ./server/peer-bridge.test.ts`:
  **22 pass**, 146 assertions on Windows.
- Same focused command on Ubuntu WSL / Bun 1.3.13: **22 pass**.
  This is supplemental evidence, not release qualification for that Bun version.
- Rotating and duplicate SSE IDs cannot exceed an agent's budget; owner and a
  second room's agent still receive scoped snapshots.
- Cookies and bearer owner access share accounting. Agent saturation leaves four
  owner slots; sixteen remains the total backstop.
- Abort, cancel, double cleanup and already-aborted requests release correctly.
- Rotating peer message IDs/hashes and using multiple paired rooms cannot evade
  sender accounting. Another admitted peer completes a fragmented message and
  receives an ACK while the attacker's quota is full.
- Existing assemblies, reversed/duplicate chunks, completion, expiry at exactly
  thirty seconds, retries, malformed/unpaired chunks, invalid completed hashes,
  global saturation and inbound ACK handling are covered.
- Added real-daemon test passes: agent saturation does not block another agent or
  owner; an aborted network stream can reconnect and reclaim exactly one slot.
- Independent reviewer tested 100 immediate same-ID abort/reconnect cycles through
  a real Bun HTTP server; all returned 200.

### 3. Legitimate behavior and owning-package checks

- `bun run test:source`: **49 pass**, zero failures.
- `bun run build`: pass (TypeScript and production Vite build).
- `bun test ./server ./scripts`: **76 pass**, zero failures, zero skips,
  478 assertions on Windows with the reviewed native dependency.
- Native dependency verification:
  `./scripts/build-native.ps1 -VerifyOnly -OutDir .local/native-release-verification`:
  pass; DLL SHA-256
  `80789092f71c1839e91385d9d795f5ceb1828edc544c0f26d2b23a19896733de`
  matches `native/wormdb.lock.json`.
- The full suite used that DLL via `WORMDB_LIBRARY_PATH`. A newly built stock
  WormDB DLL without `wormdb_open_sync` was supplied via
  `WORMDB_LEGACY_LIBRARY_PATH`, so incompatible-symbol rejection was exercised
  rather than skipped.
- Existing Unicode/max-size fragmented delivery, lost-receipt retries, restart
  recovery, persistence failures, HTTP onboarding, scoped agent CLI, packaging,
  and installer tests remain passing.

## Native dependency integration gap

An initial full-suite run against the newly built WormDB security branch failed:
that stock DLL does not export `wormdb_open_sync`. This is an existing upstream
integration gap, not a quota-patch regression. Meshrooms correctly fails closed
rather than weakening its synchronous durability contract. Rerunning with its
hash-verified locked DLL passed all 76 tests.

The local default development DLL also differs from the reviewed lockfile hash;
it was not substituted or repinned. The verified release artifact was selected
explicitly for validation. No production native library or lockfile was changed.

Follow-up integration combined `wormdb-sync-open` with the security fixes and
qualified a separate ReleaseFast artifact before updating the native pin. See
[the native integration record](native-security-integration.md) for the new source
commit, artifact hash and repeated validation. The old DLL evidence above records
the original quota-fix validation, not the newly pinned artifact.

## Limits

No browser-native EventSource UI session or actual multi-host MeshGuard exchange
was run for this patch. The native IPC adapter test uses a real local control
socket with a fixture server; peer fairness tests use admitted identities with
in-memory transport. No installer release, running user daemon, startup
registration, room data or deployed service was changed. The subsequent native-pin
update is recorded separately in the integration record linked above.

The shared global caps still bound overload; several admitted identities can
saturate them. These fixes do not claim general flood resistance, throughput
fairness or production qualification. WormDB's other findings and its deferred
audit coverage are separate work.
