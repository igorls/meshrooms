# Agent activity in browser rooms

Status: implemented in browser rooms (`meshrooms-browser-v1`) and the agent
bridge.

## Why

With several agents in a room, people need to see at a glance which agents are
waiting to be asked and which are busy, and with what. Room text cannot answer
that: an agent that is working says nothing until it replies.

## Experience

- **Roster** (Room details → People and agents): every agent has a status dot on
  its picture and a line of text. The text carries the state; the dot only
  repeats it (grey offline, green idle, amber working, faded when there has been
  no check-in).
  - `Offline`: this browser has no open channel to any of the agent's devices.
  - `Online`: connected, but its bridge has not reported activity (a bridge from
    before this feature, or an agent that has not called `listen` yet).
  - `Idle · 12 min`: waiting in `listen`, counted from when it went idle.
  - `Working on “Fix header” · 4 min`: the task links to the board card.
  - `Replying to Igor · 1 min`: woken by a message; the name links to the message
    (several authors read "Igor and Ana"; the viewer reads "you").
  - `Working · 1 min`: woken by something this browser does not have.
  - The agent's note, if any, in muted italics below.
- **Header**: "2 people and 3 agents in this room · 1 working".
- **Task board**: a card an agent is working on shows "Wren working".
- **Agents**: nothing to do beyond the normal loop. `status --room R --note
  'Running the test suite'` adds a note; `--note ''` clears it. `status` prints
  the current `activity`.

## How the bridge knows

Activity is derived from the agent's own commands; the agent never declares
`idle` or `working` itself. Each command writes `activity.json` in the room
directory (`{state, since, heartbeat, on?, note?}`, agent machine clock):

| Command | Effect |
| --- | --- |
| `listen` (starts) | `idle`. `since` is kept if it was already idle, so timeouts keep counting from when it went idle. |
| `listen` (waiting) | Refreshes `heartbeat` every 15 s, and once more on `timeout`. |
| `listen` returns `addressed` | `working`, `on: {messages: addressed, tasks: task ids}`, new `since`. `history` that addresses the agent counts too; `history` with nothing for it stays idle. |
| `send` | Refreshes `heartbeat` while working. |
| `task-update --status doing` (or `task-add --status doing`) | `working`, with that task first in `on.tasks` (keeps the woken messages). |
| `task-update --status todo\|done`, `task-remove` | Drops that task from `on.tasks`; still working until the next `listen`. Any other task change refreshes `heartbeat` while working. |
| `status --note TEXT` | Sets or clears the note (one line, at most 140 characters, no control, separator or bidi characters). Before any `listen` it creates a `working` activity. |

A change between idle and working starts a new `since` and drops the note: it
described the previous state. A note set while idle survives idle timeouts.

`run` reads `activity.json` every second and sends a packet to every open
channel when state, `since`, `on` or the note changes, repeats the current
state every 30 s (with the latest heartbeat), and sends it once to each channel
as it opens. Nothing is sent before the agent's first `listen`, or when the file
is damaged.

## Wire format

An unsigned envelope without a `body`, like file transfer packets:

```json
{ "kind": "activity", "roomId": "…", "at": 1790000030000,
  "state": "working", "since": 1790000000000, "heartbeat": 1790000025000,
  "on": { "messages": ["<uuid>"], "tasks": ["<uuid>"] }, "note": "Running the test suite" }
```

`at` is the sender's clock at sending. Receivers turn `since` and `heartbeat`
into ages on that clock (`at - since`) and rebase them on their own, so clock
skew between machines cancels out. Receivers accept exactly these keys:
`state` `idle|working`; `since <= heartbeat <= at`, all positive safe integers;
`on` only when working, with only `messages`/`tasks`, each 1 to 8 distinct
UUIDs; `note` 1 to 140 characters, not blank, without C0/C1 controls, U+2028/9
or bidi overrides. The largest valid packet is under 2,000 characters, far below
the 20,000-character channel limit.

It is unsigned because it asserts nothing durable: it is never stored or
relayed, and a browser accepts it only on the data channel of the device it
describes, and only when that device belongs to an agent member. A browser
never sends activity packets; bridges ignore those they receive.

## Browsers

`BrowserPeers` keeps the latest packet per agent device in memory only (no
IndexedDB, nothing to the room service) and forgets it when that channel
closes or the peer is replaced. The roster derives each agent's state from its
connected devices, taking the freshest report (`deriveActivity` in
`src/browser/activity.ts`), and re-renders every 15 s so ages move:

- No open channel to any of its devices: offline.
- Idle, but no packet for 90 s or no `listen` heartbeat for 3 minutes:
  "Idle · no check-in for N min". The heartbeat rule catches the common case of
  the agent's harness stopping while the detached `run` keeps its channels open.
- Working with a heartbeat older than 30 minutes: "Busy · no check-in for N
  min", and no board marker.

## Old peers

Deployed browsers and bridges (`feat/browser-room-agents`) parse every
channel message as JSON and then require `packet.body` (after checking
`kind === 'board'`); an activity packet has neither, so they drop it without
effect. It briefly occupies one slot of their incoming queue, once per change
or 30 s. Current bridges drop it before the queue. A new browser with an old
bridge shows its agent as `Online`.

## Not covered

- Activity from agents in native (local daemon) rooms.
- A history of activity: only the current state is ever known.
