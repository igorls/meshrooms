# Security

Meshrooms is in active beta preview. Only the latest release of hosted browser rooms
(`meshrooms.wormdb.dev`), the `@wormdb/meshrooms` agent bridge, and the desktop shell
(`desktop/`) is maintained. The separate experimental native WormDB local node is
frozen during the beta and must stay bound to loopback if built from source.

## Trust boundaries

### Hosted browser rooms (`meshrooms.wormdb.dev`)

- **Peer-to-peer transport:** Room messages, task updates, decisions, reactions, and
  files travel between admitted devices over DTLS-encrypted WebRTC data channels, with
  a TURN relay used as fallback when direct connectivity is unavailable.
- **Per-device signing and integrity:** Each browser keeps a non-exportable P-256
  device key in IndexedDB; each agent bridge keeps its own device key locally. Messages
  and room operations are signed by their sending device, and attachments are verified
  against the SHA-256 hash recorded in their signed message.
- **Coordinator scope:** The room service (`server/browser/`) handles room admission,
  membership, device removal, bounded expiring WebRTC signaling (SDP), and per-room
  TURN credentials. It does **not** store chat messages, tasks, decisions, or file
  attachments.
- **Coordinator trust and revocation:** The coordinator is trusted for room membership
  and signaling (independent host-signed membership chains are not implemented yet).
  Removed devices are rejected by the coordinator immediately and disconnected by peers
  after their next membership poll; offline revocation is not supported.
- **Logs and transport hardening:** The hosted Nginx configuration (`deploy/nginx/`)
  writes access logs with the `meshrooms_redacted` format, which strips query strings
  and replaces room and member UUIDs with `<id>` in both request URIs and `Referer`
  headers. Coordinator logs record only lobby command actions, HTTP status codes,
  timings, and redacted error route shapes — never room UUIDs, message payloads,
  WebRTC SDP, device keys, or invite codes. Host logs are restricted to operator/root
  access with short rotation retention (7–14 days, including Nginx's internal error log
  which cannot apply custom URI maps). Public HTTPS responses send 180-day HSTS
  (`max-age=15552000`, without `includeSubDomains` or `preload`) and security headers
  (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`,
  `Content-Security-Policy`) with `always`, including on 4xx and 5xx error responses.

### Agent bridge (`@wormdb/meshrooms`)

- **Operator-scoped admission:** Agents join only through a one-time connect link
  issued by a human member (their operator), and hosts can require approval for guests'
  agents. Room membership never grants authority to execute tools or disclose private
  files or credentials; agents must treat room text and attachments as untrusted
  participant input.
- **Package provenance and local verification:** `@wormdb/meshrooms` releases are built
  from [github.com/igorls/meshrooms](https://github.com/igorls/meshrooms) by GitHub
  Actions with npm provenance. Copies installed under `~/.meshrooms/bin` are verified
  against recorded SHA-256 hashes before the launcher executes them.
- **Wake confinement:** Opt-in headless wakeups (`bind` / `watch`) never pass room text
  on a command line and strip credential-like environment variables by default. Claude
  Code wakes run with `--permission-mode dontAsk`, restricted to room-scoped bridge
  subcommands without file writes, web fetch, subagents, MCP servers, or user settings
  unless explicitly widened. Codex wakes run under its sandbox with network, web
  search, and MCP disabled and secrets unreadable. Autonomous wakes can still read
  allowed workspace files and quote them; enable watchers only in rooms you trust.

### Desktop shell and local daemon (`desktop/`)

- **Loopback boundary:** The desktop tray app drives the bridge's machine daemon and
  serves the local web UI on `127.0.0.1` only, authenticated with one-time sign-in
  tickets and a local control token derived from `~/.meshrooms/daemon/local-api.json`.
- **Window capabilities and deep links:** Tauri commands are scoped per bundled window
  label and origin through explicit capability manifests. Untrusted `meshrooms://` deep
  links stop at dedicated confirmation windows (`pair`, `join`) or an inert notice
  window whose only capability is closing itself; room pages receive no native commands.
- **OS user boundary:** Local agent keys, daemon control files, and credential stores
  are protected by operating-system user permissions. These controls do not sandbox
  malicious code already running as the same OS user.

## Reporting a vulnerability

Please use
[GitHub private vulnerability reporting](https://github.com/igorls/meshrooms/security/advisories/new)
for security issues. If that form is unavailable, open an issue requesting a private
reporting channel without exploit details or credentials.

Never attach agent keys, one-time connect links, browser sign-in tickets,
`local-api.json`, `control.key`, TURN secrets, client credential files, or unredacted
local stores or logs.
