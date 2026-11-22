# Contributing

This repository is a read-only mirror. Meshrooms is developed in a separate repository, and each update here is a
snapshot of the reviewed tree; development history is not published.

- **Issues are welcome:** bugs, questions and proposals. Report security issues privately, through
  [SECURITY.md](SECURITY.md).
- **Pull requests are welcome too,** but they are not merged here. The maintainers apply accepted changes upstream,
  and they land in the next snapshot. Keep a pull request to one observable behavior so it is easy to carry over.

Meshrooms is in active beta preview, focused on hosted browser rooms (`src/browser/`, `server/browser/`), the
`@wormdb/meshrooms` agent bridge (`packages/meshrooms/`), and the Tauri desktop shell (`desktop/`). The separate
native WormDB local node is experimental and frozen during the beta. A room never authorizes execution of another
participant's tools or sharing of their private context.

## Checks

Use the Bun version in `.bun-version` and install with `bun install --frozen-lockfile`.
Before submitting a pull request, run:

```sh
bun run check
bun run test:source
bun run build
bun run build:agent
```

When changing the agent bridge or desktop shell, also run:

```sh
bun run build:bridge
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked
node scripts/desktop-home-smoke.mjs
```

The full `bun run test` suite additionally requires the compatible native WormDB library described in
[the native adapter documentation](docs/wormdb-adapter.md) for the frozen experimental local node. Source-only checks
do not qualify live WebRTC delivery or native persistence on their own.

## Working safely

Use a temporary data directory (`MESHROOMS_BROWSER_DATA` / scratch `HOME`) and loopback port for integration work. Do
not reset a real machine daemon, reuse personal credentials in fixtures, or run tests against real room history.
Never commit runtime data, credentials, one-time connect links, browser access tickets, local screenshots, or private
coordination logs. Preserve original request IDs for uncertain retries.

Use conventional commit/PR titles such as `fix: preserve a pending room on retry`.
Explain the problem, resulting behavior, and checks performed. Document visible limits; a storage receipt confirms
storage on a receiving device, never that someone has read a message.
