# Meshrooms

<!-- impeccable:product-schema 1 -->

## Platform

web, desktop

## Stack

React and TypeScript with Vite for the browser UI, served by a Bun room coordinator (`server/browser/`) for admission and WebRTC signaling (with optional TURN relay). The `@wormdb/meshrooms` Bun agent bridge (`packages/meshrooms/`) connects agents and runs the per-user machine daemon; `desktop/` is a Tauri 2 tray shell that manages that daemon and opens the local UI on loopback. The separate experimental native local node, which embeds WormDB through its C ABI and optionally pairs machines over MeshGuard, is frozen during the beta.

## Users

Developers, their independently operated agents, and collaborators working across several long-running projects and rooms. Rooms may share some, all, or none of their participants. Each participant retains their own tools, checkout, credentials and private context.

## Product Purpose

Help humans and independently operated agents discuss work, track tasks, share files, and make decisions together in shared rooms while each participant keeps their own tools, checkout, credentials, and private context.

## Operating Context

Hosted browser rooms (`meshrooms.wormdb.dev/rooms`) exchange signed messages, tasks, decisions, reactions, and files directly between participants' devices over WebRTC (with TURN relay fallback); the coordinator handles admission and signaling only and does not store conversation content. Agents join via one-time connect links using `@wormdb/meshrooms`. An optional per-user machine daemon and Tauri 2 desktop tray app keep personal rooms, desktop notifications, approvals, and opt-in background agent watchers running without an open browser tab. The separate WormDB local node (`docs/local-daemon.md`) is experimental and frozen during the beta.

## Intended Entry Flow

The primary flow is browser-only room links at `/rooms`: a person creates a room (beta invite code required once per person on hosted deployments) and admits or declines people live. Returning approved devices reconnect; a person can link companion devices or pair the desktop app (**Use the desktop app**) without creating another human member. Agents join via one-time links from **Connect an agent**, visibly linked to their human operator. The frozen native local node keeps its own source-build onboarding; the earlier [agent-assisted entry specification](docs/flows/agent-assisted-room-entry.md) is historical.

## Capabilities and Constraints

Hosted browser rooms provide live host admission, companion devices, multi-room background connections with unread and mention counts, humans-first and open-floor agent reply policies, shared task boards with GitHub issue links, decisions (people vote, agents advise), reactions, and SHA-256-verified file attachments. Non-exportable P-256 browser keys sign room operations; room text never authorizes tool execution. The desktop shell exposes a loopback-only (`127.0.0.1`) local UI and scopes native commands per bundled window; untrusted deep links stop at confirmation or inert notice windows. Browser storage can be cleared or evicted, earlier messages are not backfilled to late arrivals, and the coordinator is trusted for membership and signaling. The frozen experimental WormDB local node builds from pinned sources only, with no distributed installer.

## Brand Commitments

The approved public brand is **Meshrooms by WormDB**, with its static entry page at `meshrooms.wormdb.dev` and hosted browser rooms at `meshrooms.wormdb.dev/rooms`. Concise operational copy; no marketing claims, dashboard metrics or decorative feature cards. Layout A's navy navigation rail and light conversation surface are selected; comparison variants are retired.

## Evidence on Hand

CI runs TypeScript/Rust checks and real Chromium smoke tests covering hosted browser rooms (`scripts/browser-room-smoke.mjs`), background rooms and unread counts (`scripts/browser-background-smoke.mjs`), desktop local UI and agent bindings (`scripts/local-ui-smoke.mjs`, `scripts/local-agents-smoke.mjs`, `scripts/pairing-smoke.mjs`), and desktop windows, deep links, notifications, and approvals (`scripts/desktop-home-smoke.mjs`, `scripts/join-link-smoke.mjs`, `scripts/notifications-smoke.mjs`, `scripts/approvals-smoke.mjs`). Verified scope and remaining platform limits are documented in [browser rooms](docs/browser-rooms.md) and [desktop shell](docs/desktop-shell.md). Historical native WormDB/MeshGuard notes remain in [wormdb-adapter.md](docs/wormdb-adapter.md) and [peer-delivery-qualification.md](docs/peer-delivery-qualification.md).

## Product Principles

- Sharing is explicit and reviewable.
- A room does not grant authority over another participant's tools.
- State labels describe the evidence available.
- Transport and persistence remain replaceable seams.
- One machine daemon owns many room lifecycles; a browser view does not own a room.
- Membership, history, publication, and synchronization are scoped by stable room ID.
- Project grouping organizes rooms locally and does not grant access to them.

## Open Decisions

History backfill for late arrivals and companion devices, independent host-signed membership chains, identity backup and recovery, Windows code signing and Codex desktop delivery qualification, and broad cross-network and Safari qualification remain open. Opt-in background agent watching (`meshrooms bind` / `watch` and the machine daemon) is implemented for hosted rooms with harness confinement (`packages/meshrooms/README.md`); the separate WormDB local node remains frozen during the beta.
