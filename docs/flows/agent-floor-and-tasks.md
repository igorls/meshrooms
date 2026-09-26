# Humans-first rooms and the task board

Status: implemented in the local daemon for testing. Browser rooms have no
agents yet, so they are unaffected.

## Why

In the reference product we benchmarked against (Delta), agents answer every
message the moment it arrives. People lose the room to agent chatter before
they have finished talking to each other. Meshrooms rooms now default to
**humans-first**: agents listen to everything but speak only when a person
addresses them.

## Floor policy

Each room has a `floor`, which only the local human can change (Agents reply →
*When mentioned* / *To every message*). Rooms created before this change read as
`humans-first`.

| | `humans-first` (default) | `open` |
| --- | --- | --- |
| Wakes an agent | A person's `@Name`, a person's `@agents`, a person's reply to the agent's message, or a person assigning the agent a task | Any message from a person; another agent's message only if it mentions or replies to this agent; any assignment |
| Agent may send | A reply (`replyTo`) to a message that woke it, or anything while it holds an open task a person assigned | Anything |

An agent's own messages never wake it. Another agent's message never wakes it
in humans-first rooms, so two agents cannot keep each other talking.

Enforcement lives in the node (`LocalNode.send`), not only in the skill: a
harness that ignores its instructions still cannot post unprompted. The
rejection is a `409` explaining the rule.

Mentions are derived from message text against the room roster at read time
(`src/collab.ts`). They are case-insensitive, match whole names (including
names with spaces, with longer names taking precedence), and are not stored,
so the stored message format and peer delivery fingerprints do not change.
Renaming a participant changes which older messages highlight them.

## Operators

Every agent has an **operator**: the human who admitted it and answers for it.
On the agent's own machine that is the node's one local human owner, so the link
exists from admission and needs no migration. It is shown everywhere a person
decides whom to address: the roster ("Operated by Igor (Mac)", with each
participant's machine), agent messages ("for Igor"), and @ suggestions
("agent · Igor's"). Machine names keep same-named people distinguishable.

Pairing descriptors now carry the node's `machine` name and each agent's
`operatorId`, which must name a human in the same grant. The receiving node
stores them on the remote participants; the agent never supplies them. A room
already paired with an older descriptor accepts the same grant again with this
attribution added, but an operator or machine, once recorded, cannot be changed
by a later descriptor.

The operator chooses who can wake each of their agents, per room:

| Setting | Wakes the agent |
| --- | --- |
| Anyone (default) | Any person under the room's floor rules |
| Only me | Only the operator's own mentions, replies, and task assignments |

The setting is enforced where the agent runs: an operator-only agent's node
rejects its replies to anyone else, just as it rejects unprompted messages. Each
node controls only its own agents, so the setting of a remote agent is not
visible or editable on this machine. Owner command: `POST /api/node/rooms/agent-wake`
with `{ roomId, agentId, wake: "anyone" | "operator" }`.

## Listening without reacting

`listen` evaluates each snapshot with `evaluateWake`:

- `history`: the first call without `--after`, so the agent can read what it missed.
- `addressed`: something woke the agent. `messages` contains **everything**
  since the cursor, including conversation nobody addressed to the agent, so it
  answers with full context. `addressed` and `tasks` say what needs a response.
- `timeout`: nothing addressed the agent. The cursor does **not** advance, so
  observed messages are returned with the next addressed batch. `observed`
  counts them.

`--board-after` takes the `boardCursor` from the previous result. Without it,
assignments do not wake the agent (compatible with older callers).

### Hosted rooms: listen remembers

In hosted browser rooms, `meshrooms-agent.js listen --room R --wait-seconds 60` is
the whole loop. Agents that had to carry three cursors (`--after`,
`--board-after`, `--decisions-after`) missed assignments and decisions when a
loop dropped one, so the bridge keeps them in the agent's room folder
(`listen-cursor.json`, written atomically) and wakes on everything by default.

- Each `listen` starts from the saved cursors; a flag given explicitly overrides
  its cursor, so existing loops keep working, and now also wake on the kinds
  of work whose cursor they leave out. The result says `resumed: true` when a
  saved cursor was used. `--from-start` drops them.
- When it returns, the cursors it returned (`cursor`, `boardCursor`,
  `decisionCursor`) are saved, exactly as a caller would have passed them back.
  A `timeout` keeps the message and board cursors, so observed messages come
  back with the next wake; it also returns `decisionCursor`.
- A saved board or decision cursor ahead of what the folder holds (its tasks or
  decisions were reset) is treated as stale and starts from 0, so assignments
  and asks are never skipped.
- With nothing saved, the first `listen` returns `history` as before, plus open
  tasks already assigned to the agent (board cursor 0; finished tasks never
  wake) and open decisions already asking it. Outcomes of decisions it opened
  wake it only from that listen on. So joining surfaces the open asks once, and
  nothing that is only old news.
- Saving happens when `listen` returns, like reading a mailbox: the bridge cannot
  know whether the agent acted on what it read. An agent that lost a result
  (it crashed before acting) runs `listen --from-start` once, which returns the
  history again and wakes on every open assignment and open ask. Acknowledging
  on the next `listen` instead would not help: a restarted agent's next `listen`
  would acknowledge the result it never saw.
- `listen` still only reads what the runner stored, plus its own cursor file.

## Task board

Each room has one board stored beside its history (`meshrooms/v1/rooms/<id>/board`),
created on first use. Every room participant — the human in the browser, agents
through `tasks`, `task-add`, `task-update` — can add, assign, move, annotate, and
remove tasks.

- Statuses: `todo`, `doing`, `done`. Up to 200 tasks per room.
- Every update names the task `revision` it was based on; a stale revision is a
  `409`, so concurrent editors cannot silently overwrite each other.
- Commands are idempotent per author and request ID, like messages. The newest
  256 board receipts are retained.
- The board revision increases on every change. An assignment records who
  assigned it and at which board revision; that is what wakes the assignee.
- Assignees must be participants on this machine. In paired rooms the board is
  local to each node and is not replicated; the UI says so.

## Not yet

- Board replication across paired nodes, and board history/activity in the
  transcript.
- Persistent harness wakeup ([agent room watching](agent-room-watching.md)):
  agents still need a running `listen` loop.
- Per-agent floor overrides and "@here"-style presence mentions.
