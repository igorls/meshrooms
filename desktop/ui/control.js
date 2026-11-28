// The enrolment window (desktop/src-tauri/src/control.rs): a browser asking to control this computer's agents. It shows the
// link's claim (a name and an address), takes the typed words, then the choices (which harnesses remote prompts may reach,
// whether this browser may send them) before Let this browser in. It never receives the words or the secret: the app
// checks what is typed. Everything from the app is shown as text, never as markup.
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = id => document.getElementById(id);
let focused = false, stage = '', shownHarnesses = '', shownId;

function text(title, lead) { $('title').textContent = title; $('lead').textContent = lead; }

/** The harness choices, built once per policy read so the person's ticks aren't undone by the next refresh. */
function harnesses(view) {
  const key = JSON.stringify(view.harnesses || []) + view.policyKnown;
  if (key === shownHarnesses) return;
  shownHarnesses = key;
  const box = $('harnesses');
  box.replaceChildren(...(view.harnesses || []).map(h => {
    const label = document.createElement('label'), input = document.createElement('input');
    label.className = 'check';
    input.type = 'checkbox'; input.value = h.harness; input.checked = !!h.allowed;
    label.append(input, ` ${h.label}${h.detected ? '' : ' (not found on this computer)'}`);
    return label;
  }));
  $('harnesses-box').hidden = !view.policyKnown;
  $('harnesses-note').textContent = view.policyKnown
    ? (view.enabled ? 'Remote control is on here. Untick them all to turn it off.' : 'Remote control is off here. Tick a harness to turn it on.')
    : '';
}

function render(view) {
  stage = view.stage;
  // Another browser's enrolment: nothing ticked for the last one carries over.
  if (view.id !== shownId) {
    shownId = view.id;
    $('trusted').checked = false;
    shownHarnesses = '';
    $('enrol').disabled = false;
    focused = false;
  }
  $('from').textContent = view.origin ? `From ${view.origin}` : '';
  $('ask').hidden = view.stage !== 'asking';
  $('review').hidden = !(view.stage === 'reviewing' && view.read === true);
  $('after').hidden = ['asking', 'reviewing', 'sending'].includes(view.stage);
  $('after-problem').textContent = view.problem || '';
  if (view.stage === 'asking') {
    text('Let this browser control this computer?', `A browser calling itself “${view.name}” asks to control the agents on this computer: to see its sessions and send them prompts.`);
    if (!focused) { focused = true; $('words').focus(); }
    return;
  }
  if (view.stage === 'reviewing') {
    if (view.read !== true) { text('The words match', 'Reading this computer’s remote control settings…'); return; }
    harnesses(view);
    text('Let this browser in?', view.policyKnown
      ? `The words match. Choose what ${view.name} may do here. You can change this, or remove the browser, in the Meshrooms app at any time.`
      : `The words match. This computer’s remote control settings couldn’t be read, so they stay as they are.`);
    return;
  }
  if (view.stage === 'sending') text('Letting the browser in…', `Adding ${view.name} to this computer.`);
  else if (view.stage === 'done') text('Done', `${view.name} can reach this computer now. Go back to that browser: it connects in a moment.`);
  else if (view.stage === 'failed') text('The browser wasn’t let in', '');
  else if (view.stage === 'expired') text('This expired', 'Start again from your browser.');
  else text('Nothing is waiting', 'Start from Meshrooms in your browser.');
}

async function refresh() {
  try { render(await invoke('control_view')); } catch { /* The next refresh tries again. */ }
}
const reject = () => invoke('control_reject').catch(() => invoke('control_close'));

$('words').addEventListener('input', async () => {
  $('problem').textContent = '';
  try { $('next').disabled = !(await invoke('control_check', { typed: $('words').value })); } catch { $('next').disabled = true; }
});
$('ask').addEventListener('submit', async event => {
  event.preventDefault();
  $('next').disabled = true;
  try { await invoke('control_verify', { typed: $('words').value }); $('words').value = ''; }
  catch (error) { $('problem').textContent = String(error); }
  refresh();
});
$('review').addEventListener('submit', async event => {
  event.preventDefault();
  $('enrol').disabled = true;
  const allow = [...document.querySelectorAll('#harnesses input:checked')].map(input => input.value);
  try { await invoke('control_confirm', { trusted: $('trusted').checked, allow }); } catch (error) { $('after-problem').textContent = String(error); $('enrol').disabled = false; }
  refresh();
});
for (const id of ['reject', 'reject2']) $(id).addEventListener('click', reject);
$('close').addEventListener('click', () => (stage === 'sending' ? invoke('control_close') : reject()).catch(() => {}));
refresh();
setInterval(refresh, 700);
