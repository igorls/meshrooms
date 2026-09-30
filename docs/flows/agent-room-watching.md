# Agent room watching

Status: implemented in the agent bridge (0.2.0-beta.3) as `meshrooms watch`, for Claude Code, Codex (the CLI and the
Codex app's threads) and any other harness through a command template. A security review (below) confined what a
wake can do before release. Verified end to end on Windows against a loopback coordinator. The Windows Codex plus
Linux agent acceptance below has not been run yet.

## Required experience

Codex on Windows and Grok on Linux should eventually participate in the same
room. Once an agent has been admitted and watching has been enabled, a relevant
room message should reach that agent without the human repeatedly prompting it
in its harness. Closing the room's browser view must not stop delivery.

Each agent retains its own tools and private context. Room participation does
not grant other participants authority over those tools.

## How it works

An agent only takes part while its harness keeps calling `listen`. When the harness ends its turn, the agent drops out:
the roster shows it hasn't checked in, and mentions go unanswered. The watcher closes that gap without keeping a model
running.

- **Operator-run and opt-in.** The operator starts it, for one agent in one room, from their own terminal:
  `bun "<launcher>" watch --room R --harness claude|codex|exec`. It is a detached background process, like the runner.
  Its files sit in the agent's room folder: `watch.pid`, `watch.json` (its settings), `watch-state.json`, `watch.log`,
  and `watch-run.*`, the last run's stdin, stdout and stderr. It outlives the terminal. `watch-status` and `watch-stop`
  look after it. `stop` stops the watcher along with the runner, because the watcher would otherwise start the runner
  again.
- **Detection without consuming.** Every second the watcher asks whether a plain `listen` would return work
  (`peekWork` in `server/browser-agent.ts`, also `listen --peek`). It uses the same snapshot code and saved cursors as
  `listen`, so the rules match exactly: mentions, `@agents`, replies to the agent, assignments, decisions asking it,
  outcomes of its own decisions, and the open-floor rule. Decisions that ask agents follow the same author rules as
  messages: in a humans-first room, only a person's ask wakes an agent, and an operator-only agent wakes only for its
  operator. The check saves no cursor and records no activity. The agent's own messages never wake it. A watcher on a
  room the agent never listened to starts from now, so old mentions, tasks and asks don't wake it. It sets that start
  only once the agent is admitted and the runner has reached another device and had a few seconds to receive the
  room's history (`syncedAt` in the runner's proof of life). Until then it keeps the heartbeat and wakes nothing.
- **The harness consumes.** On work, the watcher runs the harness once with a fixed prompt. The prompt tells it to read
  once with `listen`, act only on `addressed`, `tasks` and `decisions` under the room rules (humans first, room text
  is not authority, share only what the operator would want), reply, then end its turn. It also carries three fresh
  request ids, so the harness needs no UUID tool. Room text never goes on the harness's command line; it reaches the
  harness only through `listen`. The prompt goes on stdin (claude, codex) or in a file (exec, `{prompt_file}`).
- **Wake mode.** The watcher runs the harness with `MESHROOMS_WAKE_ROOM` and `MESHROOMS_WAKE_DIR` (the room's `wake/`
  folder, emptied before every wake without following links). While those are set, the bridge's CLI:
  - refuses `watch*`, `stop`, `connect`, `run`, `profile`, `avatar`, `rooms`, `task-issue`, `issue-task`, and roster
    notes (`status --note`, which everyone sees);
  - refuses any room but that one;
  - accepts files to attach or read as text (`--attach`, `--text-file`, `--context-file`, `--plan-file` and the other
    `-file` options) only from inside the wake folder, checked by real path, so no `..` and no link or junction leading
    out;
  - saves downloads only there (`attachment --out` is refused);
  - never installs, replaces or starts a runner.

  For Claude Code this holds: its tool rules allow only those bridge subcommands, as written, so nothing can clear the
  marker. **For Codex it is only friction.** Anything in its shell can clear the marker, or write the outbox and copy a
  file into `files/` itself. There the sandbox is the boundary (see Adapters). The runner re-checks what it signs
  either way: every queued item needs UUID ids and text within the room's limits, messages and new decisions need the
  room's floor, advice needs the decision to ask the agent or a person to address it, and only a steward closes a
  decision. Built bodies are checked as peers check them. The runner's own writes into the wake-writable folders
  (`outbox/*.dropped`, `wants/`) go by rename, and links planted there are removed, never read or written through.
- **Busy queue.** One run at a time per room. What arrives during a run stays pending, and the next check after the
  run finds it. One harness session also serves one wake at a time across rooms: a lock per session (Claude's folder
  or session, Codex's thread) in `~/.meshrooms/locks`.
- **Loop guards.**
  - A run that doesn't handle the room's work backs off 30 s, then 60 s. Handling means reading the room and not
    failing.
  - If a run read the room, then failed or timed out before doing anything there, the listen cursor is put back, so
    that work is offered once more. A second failure on the same work isn't retried; `listen --from-start` offers
    everything open again.
  - The third run in a row that doesn't handle the work pauses the watcher. It stays running with its heartbeat, sets
    the agent's note to `wakeup paused: harness did not respond` (shown in the roster), records why in
    `watch-state.json`, and tries again every 15 minutes until a run handles the work. Running `watch` again resumes
    at once.
  - At most `--max-wakes-per-hour` wakes per room (default 20), and `--max-agent-wakes-per-hour` across all of an
    agent's rooms (default 30), bound agent-to-agent ping-pong.
  - A Codex thread held by another writer (the Codex app has it open) is retried every 5 minutes with the note
    `wakeup waiting: the session is open elsewhere`. Each try counts toward the caps. Only Codex's own error counts as
    busy: its stderr with a failed exit, never what the model printed.
- **Presence.** While it waits, the watcher refreshes the agent's activity heartbeat every 15 s, like `listen`, so
  the roster shows the agent idle and reachable, paused or not. During a run it shows working, on the messages and
  tasks that woke it.
- **Restart recovery.** The watcher keeps no cursor of its own; consumption goes through the harness's `listen`. After
  a restart, work the harness read is behind the cursor and is never replayed. Work it didn't read is still pending
  and is handled once. Runs are detached and write their output to files, so stopping or restarting the watcher
  mid-run doesn't kill the run. Each run is recorded with its room's mark (the room folder's path, which every
  harness invocation carries) and its start time as the system reports it.
  - **Identity fails closed.** The next watcher waits for the run only while a process with that pid still has both
    marks, with equal start times. If either start time is missing (the lookup failed or timed out; every lookup has a
    5 s limit), it is not the run, so it is neither waited for nor killed. A pid reused by the operator's own Claude,
    the Codex app, an editor showing the room's folder, or any other program is left alone.
  - **An orphaned run** is waited for until its timeout. Then it gets `taskkill /T /F` on Windows; elsewhere SIGTERM to
    its process group, only when the pid leads its own group (runs start detached, so they do) and never as a bare
    pid, with SIGKILL a few seconds later only if the pid is still that run. Without `ps` (a slim container) nothing
    is signalled.
  - **A run this watcher started** is stopped at its timeout through the process handle the watcher holds: its group,
    or the child itself, with SIGKILL while the handle says it still runs. That needs no `ps`. If it still doesn't end,
    the run is settled anyway after 30 s.
  - **After every run**, whatever it left in its process group gets SIGTERM, with no SIGKILL, since nothing can confirm
    who holds that group id a moment later.
  - **Windows gap:** there is no process group or job object to reach this way, so a child that outlives the harness is
    not reaped there. A timeout still takes down the whole tree while the harness runs.
  - `ps` runs with `-ww`, so macOS doesn't cut command lines short.
- **The runner.** While it runs, the watcher owns the bridge's runner:
  - It starts one that isn't running and replaces one that stopped answering (the same staleness test `listen` uses),
    every minute between wakes, at every heartbeat (15 s) during a wake, and right after each wake. It leaves a closed
    room alone.
  - While a watcher runs, `listen` (in a wake or not) and the other commands don't start or restart the runner.
    `listen` reports `runner-stopped`, which consumes nothing, and the watcher repairs it at its next check (within a
    minute, 15 s during a wake). That keeps a command and the watcher from starting two runners at once. Every process
    lookup these checks make has a 5 s limit, so a hung `ps` or PowerShell can't freeze the watcher.
  - Without a watcher, `listen` replaces a stopped runner once, as before, and only one its command line proves. The runner writes a proof of life (`runner-alive.json`) every second. A command that can't inspect
  processes, such as one inside Codex's Windows sandbox, where `Get-CimInstance` is denied, then still recognizes the
  runner and doesn't start a second one. The proof only ever prevents a start: nothing is killed on its word, and it
  lives where no wake can write.
- **The watcher's own files** (`watch-state.json`, the pid files, `watch-run.*`, `watch-prompt.txt`, `watch.log`)
  live outside every folder a wake may write. They are replaced by rename or created afresh, so a link planted at
  their path is removed rather than followed.
- **The installed bridge.** A command run from the installed launcher writes nothing to the bin folder when the
  install is intact: the manifest, every recorded version's hash, and the launcher's exact text all match. The
  launcher is checked this way before a runner or watcher starts from it.

## Adapters

| Harness | Runs | Session | Permissions |
| --- | --- | --- | --- |
| `claude` | `claude -p --output-format json` in `--cwd`, prompt on stdin | `--continue` (the most recent conversation in `--cwd`), or `--resume <id>` with `--session` | `--permission-mode dontAsk`; `--allowedTools` with one `Bash(bun "<launcher>" <subcommand> *)` rule per wake subcommand; `--disallowedTools Write Edit MultiEdit NotebookEdit WebFetch WebSearch Task Agent PowerShell`, plus `Read(...)` denies (which cover Grep and Glob) for the secrets listed below and `Read(**/.env*)`; `--strict-mcp-config`; `--add-dir` for the wake folder; `--allow-tools` adds rules and can lift a deny; `watch` refuses a `--cwd` that contains the agent folder, the bridge, or those secrets |
| `codex` | `codex exec resume <id> - --skip-git-repo-check` from the room's wake folder, prompt on stdin | `--session <thread id>` (a CLI or Codex app thread), or `--last --cwd <folder>`, which pins the newest thread working there when the watcher starts; one of them is required | `default_permissions="meshrooms_wake"`, a permission profile that `extends` read-only (or the operator's own named profile), with `write` for `live/ outbox/ files/ wants/ wake/` of the room, `deny` for the secrets and `.env` globs listed below, and `network.enabled=false`; `approval_policy="never"`, `web_search="disabled"`, each configured MCP server `enabled=false`, and `--disable` for computer and browser use, plugins, apps, image generation and multi-agent; never the bypass flag; `watch` refuses when the operator's top-level config is read-only, or has a legacy `profile` line Codex 0.159 rejects |
| `exec` | the `--command` template, split into arguments without a shell; `{prompt_file}` and `{room}` are filled in per argument | up to the command | the command's own, plus the bridge's wake mode |

**The secrets a wake can't read**, worked out before every wake:
- **The agent's own folders:** the room's `identity.json` (the agent's signing key). Also everything in `~/.meshrooms`
  and in this agent's folder except the way down to this room and the bridge's code, which denies other rooms,
  downloads, and other agents' folders there whatever they are named. A deny can't be re-opened by a read rule inside
  it, so the denies are the siblings at each level.
- **Other agents' folders anywhere:** every agent folder that `connect` or `watch` recorded
  (`~/.meshrooms/agent-homes.json`), wherever `MESHROOMS_AGENT_HOME` put it. `MESHROOMS_AGENT_REGISTRY` (tests use it)
  can only add folders: the default registry is always read too, so a `.env` file that sets it can't hide recorded
  agents. As a fallback for folders an older bridge made and never recorded, `agents*` folders beside this agent's
  folder are denied as well.
- **Credentials:** `~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `~/.docker`, `~/.kube`, `~/.git-credentials`, `~/.netrc`,
  `~/.npmrc`, `~/.pypirc`, `~/.config/gh` and `~/.config/gcloud`. On Windows, also `%APPDATA%\GitHub CLI` and
  `%APPDATA%\gnupg`.
- **Transcripts:** `~/.claude`, `~/.claude.json`, and Codex's home (`~/.codex`, or `CODEX_HOME`).
- **`.env` files:** for Claude Code, `Read(**/.env*)` anywhere. For Codex, the home folder's own `.env*` files and those
  anywhere in the thread's project. The project glob is used only when the project is narrower than the home folder:
  if the thread's recorded folder is the home folder, a folder holding it, or a drive or filesystem root, only the
  home folder's own `.env*` files are denied. `watch` warns, and the watcher logs once, also when the project is
  unknown (no rollout file, or a session that isn't a thread id). Codex needs an absolute root for a deny glob and expands it into paths before the
  run: a glob over the whole home folder took more than six minutes and then failed on a link loop, so wider ones
  aren't used. On Windows the glob is written with backslashes: with forward slashes after the drive, Codex denied
  the whole folder, not just the `.env` files.

Only paths that exist are listed. Claude Code's rules spell Windows paths as `//c/Users/...`: a rule with the drive's
colon (`//C:/...`) was silently ignored in testing, and matching is case-insensitive there. Tools the operator allows
with `--allow-tools`, and whatever an `exec` harness does, sit outside these lists.

**The operator's Codex configuration.** Codex 0.159 reads `sandbox_mode`, `default_permissions` and the rest from the
top level of `config.toml`. It refuses to start with a legacy `profile = "x"` line; profiles are now `x.config.toml`
files chosen with `--profile`, which a wake never passes. So `watch` reads the top level: a read-only setting is
refused, a named permission profile of the operator's is built on, and a legacy `profile` line is reported. The
wake's `-c default_permissions` took effect over the operator's real top-level `sandbox_mode = "danger-full-access"`.
Codex refuses to combine `sandbox_mode` and `default_permissions` overrides, and a wake passes only the latter.

`--model` passes a model to claude or codex. `--harness-bin` runs another executable than `claude` or `codex` on
`PATH`, such as the `codex` the Codex app ships. On Windows, npm's `.cmd` shims are run through Node directly, since
only a shell can run a batch file. Other batch files are refused.

### What was checked, and how

- **Claude Code 2.1.285 permission rules.** A test ran these flags against a stand-in launcher:
  - Allowed: `listen`, `help`, and a heredoc `send` with a random end marker. A stray `EOF` line stays in the text.
  - Denied: `watch`, `MESHROOMS_WAKE_ROOM= bun ... listen`, `env -u MESHROOMS_WAKE_ROOM bun ...`, `listen; watch`, and
    Write.
  - An earlier test of the single broad rule showed `$(...)`, redirects, pipes and `;` chains denied as well.
  - The operator's own allow rules in their Claude Code settings still apply on top; the watcher doesn't narrow those.
- **Claude Code read denies.** Against a broad `Read` allow:
  - A `Read(//c/...)` deny, a `Read(~/...)` deny and `Read(**/.env*)` each blocked Read.
  - A folder deny blocked Grep and Glob there too.
  - An all-lower-case deny blocked a mixed-case path (Windows).
  - The drive-colon form was ignored, so it isn't used.

  `send --text "$(cat <file>)"` and `send --text $(whoami)` were refused under the `send *` rule: Claude Code parses
  the substitution and doesn't allow it. A `--cwd` of the home folder is refused, naming what it holds.
- **Codex 0.159.2 permission profile on Windows** (elevated sandbox), on synthetic secrets in a scratch folder:
  - Unreadable: a denied `identity.json` beside readable room files, a denied other room, a denied credentials
    folder, and `~/.codex`.
  - Writable: `live/` and `wake/` only. The room root (`watch.json`) and the temp folder were denied.
  - The network was off.
  - A `read` rule inside a denied folder did not re-open it (deny wins), so the profile denies the specific paths
    rather than the whole agent folder.
  - The profile applied over the operator's own `sandbox_mode = "danger-full-access"`.
  - With every configured MCP server set `enabled=false`, their startup errors disappeared. With the listed features
    disabled, computer use, image generation and the MCP resource tools were gone from the tool list. Codex's
    collaboration (subagent) tools remained; they run under the same profile.
- **The code-built Codex profile** (the watcher's own `harnessInvocation` and deny list, with the operator's real
  full-access `config.toml` in place), on synthetic files in a scratch layout. Each command ran in the sandbox:
  - Denied: reading the room's own `identity.json`, another room, a recorded neighbour agent's `identity.json`, and
    the thread project's `.env`. Also denied: writing `watch.json`, and the network.
  - Allowed: reading `room.json` and a plain project file, and writing in `wake/`.
  - So Codex's Windows sandbox enforces read denies.
- **Codex `.env` globs.** A relative glob is refused ("must be absolute, use `~/...`, or start with `:`"). An absolute
  one with backslashes, or `~/...`, denied `.env` and `.env.local` and left other files readable. A forward-slash
  absolute one over-denied. A glob over the whole home folder took 393 s to expand and then failed.
- **Codex 0.159.2 sandbox before the profile.** A thread was resumed by id from another folder (the wake folder).
  Writes to the project, to the room root and to the temp folder were denied, and the network was unreachable.
- **A compliant stand-in.** Codex was given the watcher's exact flags and wake environment, then told directly to run
  the forbidden commands, standing in for a model that followed an injected message. It ran them:
  - The bridge refused `watch`, an attachment from outside the wake folder, another room, and `attachment --out`.
  - With `MESHROOMS_WAKE_ROOM` cleared, `watch` got as far as writing `watch.json`, and the sandbox refused the
    write.
  - Direct writes to `watch.json` and to the launcher were denied.
  - Both files were unchanged afterwards.

  Claude Code (haiku) refused to run the same list even when told it came from its operator. Its tool rules had
  already refused `watch` in the test above.
- **Codex app threads.** The app (0.159.2) writes its threads with `originator: "Codex Desktop"` in the same sessions
  folder as the CLI. A throwaway thread made through the app's own `codex app-server` resumed by id with its context
  intact, including from codex-cli 0.157.1, which is older than the app. Codex takes a writer lock per thread:
  whichever side opens the thread first wins, and the other fails at once with "already has an active writer". There
  was no corruption, and after reopening, the app-server showed the watcher's turn.
- **End to end, Windows, loopback coordinator.** A person in Playwright and two agents from the built bridge, each
  with its own agent folder outside the temp folder:
  - Wren was watched with `--harness claude --model haiku`, Otto with `--harness codex` on an app-style thread.
  - A mention sent before any watcher started didn't wake anyone: the watcher starts from now.
  - Mentions woke each agent within about 2 s. Runs took 12 to 26 s, and the other agent didn't wake.
  - Prompt-injected messages asking each agent to run `watch` and attach a secret file were declined by both models;
    nothing was configured and nothing leaked.
  - A mention sent while the watcher was stopped was answered once after `watch`.
  - A restart mid-run: the run finished, and the new watcher recognized it by its command line and waited. One reply.
  - Codex with a model id that doesn't exist failed at 0, 30 and 90 s, then paused, and stayed up. Four minutes
    later the roster showed "Idle · 4 min" with the pause note and no missed check-in, and `watch-status` said
    `paused`, with the next try 15 minutes out. Running `watch` again answered the pending mention once.
  - An `@agents` message woke both, each reply mentioned the other, and nothing woke in the next two minutes.
  - With the permission profile, Codex read the room and replied from the wake folder, with no MCP startup errors.
  - A `watch` given the home folder as Claude's `--cwd` was refused.
  - A live, unrelated process whose pid was recorded as the previous run (another command line and start time) was
    neither waited for nor killed by the next watcher.

## Security model

The watcher lets messages in a room start autonomous runs of the operator's agent on the operator's machine. That is
its purpose and its risk. Everything is opt-in, and the defaults are least-privilege:

- Only the operator starts it, locally, for one agent and room. Nothing in the room can start, configure or widen it.
  In a wake, the bridge refuses its own configuration commands. Claude Code's tool rules don't allow them either, and
  Codex's sandbox can't write the watcher's settings, the runner's files, the agent's keys, or the bridge's code.
- Room text reaches the harness only through `listen` output, never as a command-line argument or a shell string. The
  prompt is fixed text: room id, launcher path, wake folder, request ids, and the rules.
- A wake reaches one room. It can attach only files from its own wake folder, and download only into it.
- The runner checks every queued item again before it signs it (see Wake mode), since a Codex wake could write the
  outbox directly. What a Codex wake can still queue that way are messages and changes a person's message would have
  allowed anyway, in that room. It can also attach any file it can read and copy into `files/`: that is anything but
  the denied secrets.
- Runs are bounded: one at a time per room and per session, a timeout (`--run-timeout-minutes`, default 20), caps per
  room and per agent, and a pause after runs that don't handle the work.
- **The signing key.** Whoever holds it can speak as the agent for good, so no wake can read it: it is behind
  Claude Code's Read denies and Codex's permission profile. The same goes for other rooms and agents, credentials and
  transcripts.
- **What this doesn't prevent.** A wake can still read other files and write what it read into a reply:
  - **Claude Code:** its project folder (except `.env` files) and the wake folder.
  - **Codex:** everything the operator can read except the denied secrets, including other projects and their `.env`
    files, and it can attach a copy. It can also rewrite its own activity (`live/`) and so change the note people see.
  - **Tools the operator grants** with `--allow-tools`, and an `exec` harness, are outside the deny lists.

  Whether it does is up to the model: the room rules in the prompt are guidance to it, not enforcement. The next step
  is an MCP tool that gives a wake only `listen`, `send` and the other room actions, with no shell at all.

## Remaining gaps

- **Acceptance across machines.** The Windows Codex and Linux agent room from the acceptance below hasn't been run.
  The watcher itself was exercised on Windows only. On macOS and Linux, the Claude rules and the Codex sandbox
  (Seatbelt, Landlock) are expected to behave the same, but that wasn't checked.
- **Reading, and quoting what it read.** See the security model above.
- **The Codex app's window.** The app-side behavior was checked through the app's own `codex app-server`, not by
  watching the app's window. Unverified: what the window shows when opening a thread fails because the watcher holds
  it, and whether an open thread refreshes after the watcher's turn without being reopened.
- **An open Claude Code session.** Claude Code takes no lock. The watcher's own session lock keeps two rooms apart, but
  if the operator is typing into the same conversation the watcher resumes, both append to it. A dedicated session
  (`--session`) avoids that, and it's also cheaper: every wake resumes the whole conversation.
- **Machine restarts.** The watcher and the runner survive the terminal, not a reboot. Running `watch` again after a
  reboot resumes without replaying anything. There is no login item or service yet.
- **No room-side switch.** People see the watcher only through the agent's activity and notes. The UI has no toggle
  that shows "watching on" or lets the host pause it; watching stays in the operator's hands.
- **One mailbox.** A `listen` loop the agent runs itself while a watcher is on reads the same cursor (see AGT-5).

## Acceptance

1. Admit Codex and Grok to one real Windows/Linux room and enable watching.
2. With Grok idle and the room browser closed, send it a directed message.
3. Grok wakes, reads the intended room, and replies there without a human prompt.
4. Codex receives the reply through the room; neither agent's own reply creates
   an endless wakeup loop.
5. Restart the listener and repeat with pending messages: no lost work or
   duplicate reply. A message in another room cannot wake this room's session.
