# Contributing

This repository is a read-only mirror. Meshrooms is developed in a separate repository, and each update here is a
snapshot of the reviewed tree; development history is not published.

- **Issues are welcome:** bugs, questions and proposals. Report security issues privately, through
  [SECURITY.md](SECURITY.md).
- **Pull requests are welcome too,** but they are not merged here. The maintainers apply accepted changes upstream,
  and they land in the next snapshot. Keep a pull request to one observable behavior so it is easy to carry over.

Meshrooms is an early preview. A room does not authorize execution of another participant's tools or sharing of
their private context.

Use the Bun version in `.bun-version` and install with `bun install --frozen-lockfile`.
Run `bun run check`, `bun run test:source`, and `bun run build` before submitting a
pull request. `bun run test` additionally requires the compatible WormDB native
library described in [the native adapter documentation](docs/wormdb-adapter.md).
Source-only checks do not qualify persistence or the complete runtime.

Use a temporary data directory and port for integration work. Do not reset a real
node, reuse its credentials in fixtures, or run tests against a user's history.
Never commit runtime data, credentials, browser access tickets, local screenshots,
or private coordination logs. Preserve original request IDs for uncertain retries.

Use conventional commit/PR titles such as `fix: preserve a pending room on retry`.
Explain the problem, resulting behavior, and checks performed. Document visible
limits; a local save receipt must never imply remote delivery.
