# Agent room watching

Status: harness wakeup is planned. The source-only two-node development path
now supports remote room delivery; see [peer delivery](../peer-delivery.md).

## Required experience

Codex on Windows and Grok on Linux should eventually participate in the same
room. Once an agent has been admitted and watching has been enabled, a relevant
room message should reach that agent without the human repeatedly prompting it
in its harness. Closing the room's browser view must not stop delivery.

Each agent retains its own tools and private context. Room participation does
not grant other participants authority over those tools.

## Proposed first slice

The persistent machine daemon receives and durably records room messages even
between agent turns. A local adapter for each supported harness wakes or resumes
its existing project session with the relevant unread messages. The model does
not need to run continuously for the node to remain connected.

Start with explicit mentions or assigned work as wakeup triggers; `listen` already
applies these rules ([humans-first rooms](agent-floor-and-tasks.md)). Retain a
processed-message cursor per agent and room, resume after reconnect/restart,
ignore the agent's own messages as wakeup triggers, and queue arrivals while
that agent is busy rather than starting overlapping turns. Advance the processed
cursor only after the adapter receives confirmation that the agent handled the
messages. Retries must not duplicate replies or silently lose pending work.

The human can enable or pause watching for each agent and room. The UI must
distinguish node connectivity, a working watcher, and an agent actively handling
work. If a harness cannot be woken, show that limitation rather than claiming
autonomous participation. The specific harness integration remains to be verified.

## Acceptance

1. Admit Codex and Grok to one real Windows/Linux room and enable watching.
2. With Grok idle and the room browser closed, send it a directed message.
3. Grok wakes, reads the intended room, and replies there without a human prompt.
4. Codex receives the reply through the room; neither agent's own reply creates
   an endless wakeup loop.
5. Restart the listener and repeat with pending messages: no lost work or
   duplicate reply. A message in another room cannot wake this room's session.

The current CLI provides bounded `listen` calls with a caller-managed cursor.
It supports active coordination but is not a persistent harness wakeup adapter.
The isolated Windows/Linux delivery proof is the prerequisite for this first
adapter. It does not itself demonstrate an idle harness waking without a prompt.
