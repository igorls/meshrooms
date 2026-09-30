# Runtime Discovery & Daemon Lifecycle

Meshrooms operates as a single-instance local node per machine / data directory. Multiple browser sessions, agent connections, and skill invocations attach to this existing daemon rather than launching redundant processes or colliding on exclusive file/mutex locks.

The runtime discovery module (`server/runtime.ts`) provides bounded loopback discovery, HMAC-authenticated health verification, and concurrent startup convergence.

## Architecture & Data Contracts

### 1. Control Secret (`control.key`)
To prevent unprivileged loopback port scanners or unauthorized local callers from impersonating the daemon, each data directory contains a persistent secret token:
- **Location:** `<dataDir>/control.key`
- **Format:** High-entropy cryptographically secure random base64url string (`>= 32` bytes).
- **Filesystem Permissions:** Requests mode `0600`, parent directory `0700`; these modes do not create a Windows ACL boundary against other processes owned by the same user.
- **Invariants:** The secret is generated with exclusive create-only semantics (`wx` flag). Discovery never sends it. After verifying the daemon, the owner CLI uses it in loopback bearer headers for control operations. It is never put in URLs, command-line arguments, or logs.

### 2. Runtime Record (`runtime.json`)
The active daemon writes an atomic marker upon reaching readiness:
- **Location:** `<dataDir>/runtime.json`
- **Schema:**
  ```typescript
  type RuntimeRecord = {
    version: 1;
    apiVersion: 2;
    pid: number;
    url: string;
    nodeId: string;
    instanceId: string;
  };
  ```
- **Atomicity:** Written via unique temporary file (`.runtime.json.tmp.<pid>.<uuid>`) with mode `0600` and renamed atomically (`renameSync`).
- **Cleanup Ownership:** `registerRuntime` returns an idempotent cleanup handle. When invoked, it reads `runtime.json` and deletes the file **only** if both `instanceId` and `pid` match its own registration. A stale cleanup call from an older daemon cannot delete a newer running daemon's marker.

### 3. Cryptographic Proof of Liveness
A present `runtime.json` does not guarantee a live, responsive daemon. Discovery requires proving that the process listening on the designated port holds the matching data directory and secret:
- **Challenge Nonce:** `probeRuntime` generates a random 16-byte hex challenge nonce.
- **Probe Request:** Sent via loopback HTTP with a 2-second timeout:
  ```http
  GET /api/node/health?challenge=<nonce> HTTP/1.1
  Host: 127.0.0.1:<port>
  Accept: application/json
  ```
- **HMAC-SHA256 Proof Construction:**
  The server signs a deterministic JSON array of 5 elements:
  ```typescript
  const payload = JSON.stringify([
    challenge,
    record.instanceId,
    record.nodeId,
    record.pid,
    record.apiVersion,
  ]);
  const proof = createHmac('sha256', controlToken).update(payload).digest('hex');
  ```
- **Verification:** `probeRuntime` loads the existing `control.key` from disk, computes the expected HMAC, and verifies the server's returned `proof` using constant-time comparison (`timingSafeEqual`).
- **Fail-Closed:** If `control.key` is missing, `probeRuntime` does not generate one and fails closed (returns `null`). If the probe fails, times out, returns mismatched metadata, or provides an invalid proof, it returns `null`.

## Lifecycle & Startup Convergence

`ensureRunning(options)` coordinates daemon reuse and bounded startup:

1. **Fast Path (Live Daemon Reuse):**
   `probeRuntime(dataDir)` is evaluated first. If an active daemon is verified (even on a non-default custom port), its `RuntimeRecord` is returned immediately with zero child processes spawned.
2. **Slow Path (Bounded Startup):**
   If no running daemon responds:
   - Spawns `daemon.ts` detached using direct argument vectors (`process.execPath + daemonPath`, `--data-dir`, `--library`, `--port`, and optional `--dev-origin`).
   - No shell string interpolation is used (`shell: false`).
   - Windows consoles are hidden (`windowsHide: true`).
   - Stdio is detached (`detached: true`, `stdio: 'ignore'`).
3. **Concurrent Convergence:**
   If multiple processes invoke `ensureRunning` simultaneously for the same `dataDir`:
   - Both poll `probeRuntime` up to a 10-second bounded deadline.
   - The underlying data directory lock (`server/instance.ts` Win32 Named Mutex / Unix `flock`) serializes daemon startup. The winner acquires the lock, serves HTTP, and writes `runtime.json`. The loser exits cleanly on lock collision.
   - Both callers in `ensureRunning` converge on the winner's verified `RuntimeRecord`.
   - No user processes are killed (`no pkill`), and no lock bypasses are attempted.

## Security Controls

| Constraint | Enforcement |
| --- | --- |
| Loopback Isolation | `parseLoopbackUrl` restricts `record.url` strictly to `http://127.0.0.1:<port>` or `http://localhost:<port>`. Public IPs, hostnames, HTTPS schemes, or embedded user/password credentials are immediately rejected. |
| Discovery proof | Probes pass only a public challenge nonce and reject redirects. Control calls use the key only after proof verification. Runtime URLs must have the canonical room path and no query or fragment. |
| Timing-Safe Comparison | Proof hashes are compared with `crypto.timingSafeEqual` over fixed-length buffer digests to prevent side-channel timing leaks. |
| Guarded Cleanup | All recursive temp file cleanups verify that paths reside within designated test directories and match expected prefixes. |
