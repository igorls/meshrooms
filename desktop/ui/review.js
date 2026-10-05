// The Review window (desktop/src-tauri/src/review.rs): every agent the person bound, its room and whether it is live and
// listening, paused (and why), waiting, starting or failed, with Pause or Resume. An agent whose watcher holds its wakes
// (a broken confinement, an approval wall, a halt) has no Pause, and Resume asks first, naming why waking stopped.
// Everything from the app is shown as text, never as markup.
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = id => document.getElementById(id);
const STATES = { live: 'Live and listening', starting: 'Starting', waiting: 'Waiting for the host', paused: 'Paused', failed: 'Did not come back' };
let shown = '';
/** The agent whose Resume is being confirmed (room and member), with the hold it names. */
let confirming;

function line(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}
function button(text, className, onClick, disabled) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (className) b.className = className;
  b.disabled = !!disabled;
  b.addEventListener('click', onClick);
  return b;
}
async function act(command, args) {
  try { await invoke(command, args); } catch (error) { $('problem').textContent = String(error); }
  refresh();
}
const same = (agent, other) => !!other && agent.roomId === other.roomId && agent.memberId === other.memberId;

function render(view) {
  const key = JSON.stringify([view, confirming]);
  if (key === shown) return;
  shown = key;
  const agents = view.agents || [];
  const live = view.summary && typeof view.summary.live === 'number' ? view.summary.live : 0;
  const rooms = view.summary && typeof view.summary.rooms === 'number' ? view.summary.rooms : 0;
  $('lead').textContent = !view.loaded ? 'Reading your agents…'
    : !agents.length ? 'No agent of yours is bound to a session yet. Bind one from a room in Meshrooms.'
      : `${live} ${live === 1 ? 'agent is' : 'agents are'} live and listening, in ${rooms} ${rooms === 1 ? 'room' : 'rooms'}.`;
  $('problem').textContent = view.problem || '';
  // A confirm step for a hold that is gone (or changed) is dropped.
  if (confirming && !agents.some(a => same(a, confirming) && a.hold && a.hold.at === confirming.at)) confirming = undefined;
  const list = $('agents');
  list.replaceChildren(...agents.map(agent => {
    const item = document.createElement('li');
    item.className = agent.state;
    item.append(line('who', agent.name || 'An agent'), line('where', agent.title ? `In ${agent.title}` : 'In a room'), line('state', STATES[agent.state] || agent.state));
    if (agent.reason) item.append(line('why', agent.reason));
    if (agent.hold && same(agent, confirming)) {
      // The confirm step: the reason, the process a halt is checking, and only then Resume anyway.
      const ask = document.createElement('div');
      ask.className = 'confirm';
      ask.append(line('ask', `Waking stopped because ${agent.hold.reason}.${agent.hold.pid ? ` The run it is checking is process ${agent.hold.pid}: make sure it has ended.` : ''} Resume anyway?`),
        button('Resume anyway', 'danger', () => { const at = confirming.at; confirming = undefined; act('review_resume', { room: agent.roomId, member: agent.memberId, confirm: at }); }, view.busy),
        button('Cancel', '', () => { confirming = undefined; shown = ''; refresh(); }));
      item.append(ask);
    } else if (agent.canResume) {
      item.append(button('Resume', '', () => {
        if (agent.hold) { confirming = { roomId: agent.roomId, memberId: agent.memberId, at: agent.hold.at }; shown = ''; refresh(); }
        else act('review_resume', { room: agent.roomId, member: agent.memberId });
      }, view.busy));
    } else if (agent.canPause && !agent.hold) {
      item.append(button('Pause', '', () => act('review_pause', { room: agent.roomId, member: agent.memberId }), view.busy));
    }
    return item;
  }));
}

async function refresh() {
  try { render(await invoke('review_view')); } catch { /* The next refresh tries again. */ }
}
$('close').addEventListener('click', () => invoke('review_close').catch(() => window.close()));
refresh();
setInterval(refresh, 1000);
