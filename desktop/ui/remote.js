// The Remote control window (desktop/src-tauri/src/remote.rs): the harnesses remote prompts may reach here, and the
// browsers that can control this computer, each with whether it may send prompts and a Remove that asks first. Every
// change goes to the app, which hands it to the daemon. Everything from the app is shown as text, never as markup.
//
// Lists are rebuilt only when what they show changed (focus and clicks survive the refresh), and always from the app's
// view, so a change that failed shows things as they are, not as clicked; the failure stays shown until the next change.
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = id => document.getElementById(id);
let shownHarnesses = '', shownBrowsers = '', asking = '', localError = '';

const when = ms => { try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; } };

function harnesses(view, locked) {
  // While a change runs, the boxes stay as clicked (only disabled); they are rebuilt from the view once it's done.
  if (view.busy && shownHarnesses) { for (const input of document.querySelectorAll('#harnesses input')) input.disabled = true; return; }
  const key = JSON.stringify([view.harnesses, locked]);
  if (key === shownHarnesses) return;
  shownHarnesses = key;
  $('harnesses').replaceChildren(...view.harnesses.map(h => {
    const label = document.createElement('label'), input = document.createElement('input');
    label.className = 'check';
    input.type = 'checkbox'; input.value = h.harness; input.checked = h.allowed; input.disabled = locked;
    input.addEventListener('change', allow);
    label.append(input, ` ${h.label}${h.detected === false ? ' (not found on this computer)' : ''}`);
    return label;
  }));
}

function browsers(view, locked) {
  // A Remove asked for a browser no longer listed is forgotten: it never shows armed for another.
  if (asking && !view.browsers.some(b => b.device === asking)) asking = '';
  if (view.busy && shownBrowsers) { for (const control of document.querySelectorAll('#browsers input, #browsers button')) control.disabled = true; return; }
  const ready = new Set(view.connections.filter(c => c.state === 'ready').map(c => c.origin));
  const key = JSON.stringify([view.browsers, locked, view.stale, asking, [...ready]]);
  if (key === shownBrowsers) return;
  shownBrowsers = key;
  $('browsers').replaceChildren(...view.browsers.map(b => {
    const li = document.createElement('li'), head = document.createElement('div'), name = document.createElement('strong'), state = document.createElement('span');
    name.textContent = b.name;
    state.className = b.online && !view.stale ? 'online' : 'offline';
    // Online or offline is known only through a connection to that browser's service that is up.
    state.textContent = view.stale || !view.machineKnown || !ready.has(b.origin) ? "Can't tell" : b.online ? 'Online' : b.lastSeen ? `Last seen ${when(b.lastSeen)}` : 'Offline';
    head.append(name, state);
    const meta = document.createElement('p');
    meta.className = 'note';
    meta.textContent = `${b.origin}${b.addedAt ? ` · let in ${when(b.addedAt)}` : ''}`;
    const trust = document.createElement('label'), box = document.createElement('input');
    trust.className = 'check';
    box.type = 'checkbox'; box.checked = b.trusted; box.disabled = locked || !view.policyKnown;
    box.addEventListener('change', () => change('remote_trust', { device: b.device, trusted: box.checked }));
    trust.append(box, ' May send prompts');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (asking === b.device) {
      const sure = document.createElement('span'), yes = document.createElement('button'), no = document.createElement('button');
      sure.textContent = `Remove ${b.name}? It can no longer reach this computer, and its prompts running here stop.`;
      yes.type = 'button'; yes.className = 'danger'; yes.textContent = 'Remove'; yes.disabled = locked;
      yes.addEventListener('click', () => { asking = ''; change('remote_revoke', { device: b.device }); });
      no.type = 'button'; no.textContent = 'Cancel';
      no.addEventListener('click', () => { asking = ''; refresh(); });
      actions.append(sure, yes, no);
    } else {
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = 'Remove…'; remove.disabled = locked;
      remove.addEventListener('click', () => { asking = b.device; refresh(); });
      actions.append(remove);
    }
    li.append(head, meta, trust, actions);
    return li;
  }));
}

function render(view) {
  // Nothing changes while a change runs, while what is shown can't be trusted to be current, or while the policy is unknown.
  const locked = view.busy || view.stale;
  $('settings').hidden = !view.loaded || !view.harnessesLoaded || !view.policyKnown;
  $('browsers-title').hidden = $('browsers').hidden = !view.loaded || !view.browsers.length;
  $('empty').hidden = !view.loaded || view.browsers.length > 0;
  $('problem').textContent = view.problem || localError || '';
  $('off').hidden = !view.loaded || !view.policyKnown || !view.enabled;
  $('off').disabled = locked;
  if (!view.loaded) return;
  $('lead').textContent = view.stale ? "Can't read this computer's remote control right now; what's below may be out of date."
    : !view.policyKnown ? `${view.policyProblem} Nothing here can be changed until it can be read.`
    : view.enabled ? 'Remote control is on: the browsers below can send prompts to the harnesses ticked here, if you let them.'
    : 'Remote control is off: no remote prompt runs on this computer. Tick a harness to turn it on.';
  if (view.harnessesLoaded && view.policyKnown) harnesses(view, locked);
  $('harnesses-note').textContent = view.enabled ? 'Untick them all, or press Turn off, to turn remote control off. Prompts running here stop at once.' : '';
  browsers(view, locked);
  const connected = view.connections.filter(c => c.state === 'ready').map(c => c.origin);
  $('machine').textContent = !view.browsers.length || view.stale ? ''
    : view.machineProblem ? `This computer isn't reachable: ${view.machineProblem}`
    : !view.machineKnown ? "Can't tell whether this computer is connected."
    : connected.length ? `This computer is connected to ${connected.join(', ')}.` : 'This computer is connecting…';
}

async function refresh() {
  try { render(await invoke('remote_view')); } catch { /* The next refresh tries again. */ }
}
async function change(command, args) {
  localError = '';
  // Refused before it started (another change runs, a browser no longer listed): nothing changed, so the lists are
  // rebuilt from the view at once. One that runs is rebuilt from the view when it's done, whatever it did.
  try { await invoke(command, args); } catch (error) { localError = String(error); shownHarnesses = shownBrowsers = ''; }
  refresh();
}
function allow() {
  change('remote_allow', { allow: [...document.querySelectorAll('#harnesses input:checked')].map(input => input.value) });
}
$('off').addEventListener('click', () => change('remote_allow', { allow: [] }));
$('close').addEventListener('click', () => invoke('remote_close').catch(() => {}));
refresh();
setInterval(refresh, 1000);
