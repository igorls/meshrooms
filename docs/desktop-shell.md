# Desktop app

Status: development preview (0.1.0-alpha.7). Windows x64 builds an NSIS installer; macOS arm64 builds an app and DMG.

`desktop/` is a small Tauri 2 tray app that keeps the agent bridge's machine daemon running, so the daemon no longer
lives inside individual agent sessions. It follows the one-owner rule of the machine daemon: the app never runs the
daemon itself. It drives the bridge's own CLI (`meshrooms daemon start|stop|status|uninstall`, `meshrooms bindings
--json`), exactly as an operator would, and the daemon's lock stays the backstop against a second copy.

## Lifecycle

- **With the app:** the app owns start at login through the OS login item (Windows: the per-user Run key value
  `Meshrooms` = `"<app exe>" --background`; macOS: a Login Item, no Dock icon). The login item starts the app; the
  app starts the daemon whenever `daemon status` says it isn't running, unless the person stopped it from the tray.
- **Headless:** without the app, `meshrooms daemon install` registers the bridge's own login item.
- **Never both:** turning on *Start at login* in the app registers the app's login item and then runs `daemon
  uninstall`, which removes the bridge's own. If registering fails, nothing is removed; if removing fails, the tray
  keeps offering the move. While the bridge's item is registered, the tray shows the checkbox off
  and says the daemon starts on its own.
- **Quitting the app leaves the daemon running.** Stopping the daemon from the tray keeps it stopped until it is
  started again from the tray or the app restarts.

## Behavior

- **Tray:** the daemon's status, polled every 10 seconds; a *Rooms* submenu with every agent on the machine (room
  title, wake state, last wake, harness) under **Agent connections**; Start / Stop background service; *Start at login*; Show Meshrooms; Open logs
  folder; Quit (the daemon keeps running).
- **Window:** a normal launch opens the desktop status window. It shows whether the background service is running,
  stopped, starting or unavailable, and provides **Open your rooms**, agent review, approvals with waiting counts,
  start/stop, start at login, refresh and logs. The tray calls the browser action **Open rooms in browser**, and the
  window action **Desktop status…**. `--background` (the login item) starts tray-only, with no window and no activation.
  Launching again shows the window; closing it hides it. On macOS, other visible app windows retain the Dock icon.
  Reopening the hidden macOS app shows its status window. When the service is stopped, the primary action becomes
  **Start and open your rooms**: it starts the service, then requests a fresh local browser link. A failed start keeps
  the retry backoff, so one click cannot start it twice. Stopping the service leaves existing room runners running.
- **Room shortcuts:** **Your rooms** in the tray and status window opens a specific personal room directly in the
  default browser, with unread/mention and admission indicators. The status window is 500 × 760 by default; its room
  list scrolls independently and the full window remains scrollable at small sizes. Counts update without replacing
  focused room buttons. Failed room reads remove stale shortcuts. Only cached personal room ids can be selected;
  the bridge rechecks membership and the native shell validates the exact loopback room URL before opening it.
- **Status updates:** the window reads the tray's cached state without reloading its page, so updates retain keyboard
  focus. Service actions show progress and disable repeat presses. Failed actions stay visible with service retry,
  status refresh and logs available. The bundled status window alone has the fixed home commands; each call checks its
  label and bundled address. Local browser room pages receive no native commands.
- **Untrusted text:** room titles, agent names and reasons come from rooms. Before the tray or window shows them they
  become one short line: control characters, bidi overrides and other invisible formatting are removed, line breaks
  collapse, and the length is capped. Windows set returned values as text only.

## Room notifications and links

Room details on the local page includes **Desktop notifications**: Mentions and replies (the default), All messages,
or Off. It applies to that room on this computer, persists across restarts, and is available to hosts and guests.
Off silences message notifications; join requests, agent issues and approvals still notify. The control confirms a
successful save and keeps the previous selection when a save fails. These preferences are absent from hosted pages.

Deep links are parsed and passed to one worker through a bounded queue before their windows open. In particular,
creating the pairing window inside Tauri's macOS URL event callback would deadlock its plugin-store lock.

After successful pairing, **Open Meshrooms** opens one of the rooms that joined. The local `/rooms` page lists
existing rooms first and keeps room creation collapsed until requested. An invite code applies only to creating a
new room during the beta; opening an already paired room never requires one.

After the app sends its requests, the browser confirms them. Its room header shows **Finish desktop pairing** while
that setup is active and opens the confirmation button directly. The native window also offers **Cancel pairing**:
it withdraws pending companion requests, stops those rooms' runners, and keeps the computer's key, cached data and
any rooms already admitted. Cancellation failures offer a retry; a successful cancellation permits another link
immediately. Closing the window continues the pairing in the background.

## Bridge resolution

1. Debug builds only: `MESHROOMS_BRIDGE_HOME`, a directory that holds `bun` (`bun.exe`) and `meshrooms.js`.
2. Debug builds only: this checkout's `packages/meshrooms/bin/meshrooms.js` (`bun run build:bridge`), with Bun from
   `PATH` or `~/.bun/bin`.
3. The bridge bundled in the app, in `~/.meshrooms/app/bridge/<version>-<hash>/`: `<version>` is the bridge version in
   the bundled manifest and `<hash>` the first 12 hex digits of the manifest's SHA-256, so a new build never replaces a
   folder a running daemon started from. Each time the app starts, that folder is checked against the bundled
   manifest: the manifest itself and every file's SHA-256. If anything differs or is missing, the folder is moved
   aside (never deleted) and the bundle is installed again: only manifest-listed files are copied, each SHA-256 is
   checked before and after copying, and a staging directory is renamed into place.

Release builds never take the bridge's location from the environment.

Every command runs as `bun --no-env-file meshrooms.js <args>` from `~/.meshrooms/daemon` (created private to the
user: Bun reads `bunfig.toml` from its working folder), without a console window on Windows, and with no `MESHROOMS_*`
variable passed on, so `status`, `start` and `stop` always see the same daemon. Status and listing commands are
stopped after 30 seconds, and starting, stopping and login changes after 60 seconds, so a hung command can't freeze
the tray. The bridge then installs its launcher into `~/.meshrooms/bin` and starts the daemon from there, as it does
from a terminal.

## Build

```sh
bun install --frozen-lockfile
bun run desktop:dev            # debug app on this checkout (builds the bridge first)
bun run desktop:bridge         # bridge bundle: Bun, meshrooms.js, notices, manifest.json
bun run desktop:build          # Windows: NSIS installer; macOS: Meshrooms.app and .dmg
```

`desktop:bridge` refuses to overwrite `.local/packages/desktop-bridge`; move the previous bundle aside first.
`desktop:build` bundles it as the app's `bridge/` resource. Rust tests: `cargo test` in `desktop/src-tauri`
(`cargo test -- --ignored` also round-trips a throwaway Run key value on Windows).

`node scripts/desktop-home-smoke.mjs` checks the bundled status page against a deterministic IPC fixture, including
unknown/stopped/running states, progress, action routing, approval counts, login state, retained focus, inert error text,
light/dark appearance and narrow-window recovery. Rust tests cover the native caller and capability boundaries.

Browser message drafts (text and reply target) stay in the current tab's session storage, scoped to the device and
room. Room navigation and reload restore them; sending clears them. They are never sent as preferences or room events.
Attachments stay in memory until sent, so leaving with unsent files asks before discarding them. A failed draft save
is shown beside the composer and also guards navigation. The hosted and local UI browser smokes exercise this flow.

For isolated checks, run the app with a temporary `USERPROFILE` (Windows) or `HOME` (macOS): Bun's home folder
follows it, so the bridge, the daemon and its registry all live under it. `MESHROOMS_*` variables such as
`MESHROOMS_DAEMON_DIR` don't isolate anything: the app never passes them to the bridge. In debug builds,
`MESHROOMS_DEV_LOGIN_VALUE` renames the app's Run key value so a check never touches an installed app's entry, and a
second launch with `--dev-action=<start|stop|login|logs|window|quit>` runs that tray item.

## Code signing

Windows builds are **not code signed**: no signing certificate is available yet. Windows SmartScreen warns on the
installer and on first launch ("Windows protected your PC"; *More info*, then *Run anyway*). The installer is
per-user (no administrator prompt). Check its SHA-256 against the published one before running it.

## Signed macOS release

```sh
bun run desktop:release
```

[`scripts/macos-release.sh`](../scripts/macos-release.sh) needs a Developer ID Application identity and a saved
`notarytool` Keychain profile named `meshrooms-notary` by default (create it with `xcrun notarytool
store-credentials meshrooms-notary`, or set `APPLE_NOTARY_KEYCHAIN_PROFILE` to the name of an existing profile). It
strips Apple credential variables from the environment, builds from a temporary worktree of a commit (`--ref`,
default `HEAD`), signs, notarizes and staples the app and the DMG.

## Not yet done

Windows code signing, bridge upgrades beyond installing a new version directory, Linux, and a login item on Linux
(use `meshrooms daemon install` there).

### Browser connection recovery

The local page reports event-feed failures as well as room-read failures. It keeps the conversation and unpublished
composer contents in place, replaces cached green connection status with **Reconnecting…**, and rereads the room when
the event feed recovers, even if no new events arrived. **Try again** reopens the same room without re-pairing it.
An expired session asks the person to choose **Open your rooms** in the app for a fresh sign-in link; it does not show
a create-room or join form in place of an unreadable room. A late response cannot revive a rejected session.
Navigation while a message awaits send confirmation warns before leaving, including text-only messages. New typing is
retained if the send fails. This warning protects navigation; it does not promise recovery of an in-flight send after
a browser crash.

The browser composer confirms when a draft is saved in this tab; other rooms with an unpublished draft show a **Draft**
marker in the sidebar. This does not sync draft text to another tab or device. Unsent attachments remain in memory and
are identified separately. Loading earlier local history shows progress without blocking typing, preserves the visible
message's position on desktop/mobile, and retains composer focus if the person keeps typing during the fetch.
