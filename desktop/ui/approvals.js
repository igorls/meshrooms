// The Approvals window (desktop/src-tauri/src/approvals.rs): what waits for the person's approval, each request with
// everything it would apply, and a Reject and an Approve for each. Approve sends back the digest of the request exactly as
// shown here; a request that changed since is shown again, marked, never approved on its own. Approve takes a deliberate
// click: nothing focuses it, Enter never presses it, and it waits a moment after a request appears or changes. The
// custom-command form makes an agent whose command runs on this computer: Review shows the command exactly as the app
// read it back, with the program and each argument a wake runs, and Make this agent (as deliberate as Approve) makes
// exactly that. Everything from the app is shown as text, never as markup.
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = id => document.getElementById(id);
/** How long Approve waits after a request (as it now reads) first shows, so a click meant for something else can't land on it. */
const SETTLE_MS = 1500;
let shown = '';
/** When each request, by id and digest (and the custom-command confirmation), was first shown. */
const firstShown = new Map();
/** The ids of the requests last shown: when they change, every wait starts again (the list moved under the pointer). */
let shownIds = '';
/** Every wait starts again: the window came back into focus, or the requests on it changed. */
const rearm = () => { firstShown.clear(); shown = ''; };
/** The custom-command confirmation's wait starts again the next time one shows (after Edit or Make). */
const rearmCustom = () => { for (const key of [...firstShown.keys()]) if (key.startsWith('custom:')) firstShown.delete(key); shown = ''; };
/** Marks a name or folder that holds a non-ASCII character, which may look like another one. */
const NON_ASCII = 'Contains non-ASCII characters';
let made = 0;
/** The command the custom-command confirmation shows: Make this agent sends it back. */
let shownCustom = '';

function line(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  // Paths and commands read left to right whatever they hold, isolated from the text around them.
  if (className && className.split(' ').includes('path')) el.dir = 'ltr';
  el.textContent = text;
  return el;
}
/** A value, with the non-ASCII marker after it when it holds one. */
function value(className, text, nonAscii) {
  const dd = line('dd', className, text);
  if (nonAscii) {
    const mark = document.createElement('dd');
    mark.className = 'non-ascii';
    mark.textContent = NON_ASCII;
    return [dd, mark];
  }
  return [dd];
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
/** Each argument a wake runs, numbered, one per line. */
function argList(args) {
  const dd = document.createElement('dd');
  dd.className = 'path';
  dd.append(...args.map((arg, i) => line('div', '', `${i + 1}. ${arg}`)));
  return dd;
}
async function act(command, args) {
  try { await invoke(command, args); } catch (error) { $('problem').textContent = String(error); }
  refresh();
}

function render(view) {
  const now = Date.now(), items = view.items || [];
  const ids = items.map(item => item.id).join(',');
  if (ids !== shownIds) { shownIds = ids; rearm(); }
  for (const item of items) if (!firstShown.has(`${item.id}:${item.digest}`)) firstShown.set(`${item.id}:${item.digest}`, now);
  const settled = item => now - firstShown.get(`${item.id}:${item.digest}`) >= SETTLE_MS;
  const custom = view.custom ? `custom:${JSON.stringify(view.custom)}` : '';
  if (custom && !firstShown.has(custom)) firstShown.set(custom, now);
  const customSettled = !!custom && now - firstShown.get(custom) >= SETTLE_MS;
  const key = JSON.stringify([view, items.map(settled), customSettled]);
  if (key === shown) return;
  shown = key;
  $('lead').textContent = !view.loaded ? (view.problem ? 'The requests could not be read.' : 'Reading what waits for you…')
    : !items.length ? 'Nothing waits for your approval.'
      : `${items.length === 1 ? 'One request waits' : `${items.length} requests wait`} for you. Read each one before you approve it.`;
  $('problem').textContent = view.problem || '';
  $('note').textContent = view.note || '';
  $('custom-problem').textContent = view.customProblem || '';
  $('custom-check').disabled = !!view.busy;
  // The confirmation: exactly what the app read back, and what each wake runs.
  $('custom-confirm').hidden = !view.custom;
  $('custom-ask').hidden = !!view.custom;
  for (const id of ['custom-name', 'custom-command', 'custom-model']) $(id).disabled = !!view.custom;
  $('custom-make').disabled = !!view.busy || !customSettled;
  shownCustom = view.custom ? view.custom.command : '';
  if (view.custom) {
    const c = view.custom, args = c.args || [];
    const marks = c.nonAscii || {};
    $('custom-shown').replaceChildren(line('dt', '', 'Name'), ...value('', c.name, marks.name), line('dt', '', 'Command'), ...value('path', c.command, marks.command),
      line('dt', '', 'Program'), line('dd', 'path', c.program), line('dt', '', args.length === 1 ? 'Argument' : 'Arguments'),
      args.length ? argList(args) : line('dd', '', 'None'),
      line('dt', '', 'Model'), line('dd', '', c.model || 'None'));
  }
  if (typeof view.made === 'number' && view.made > made) {
    made = view.made;
    for (const id of ['custom-name', 'custom-command', 'custom-model']) $(id).value = '';
  }
  $('items').replaceChildren(...items.map(item => {
    const li = document.createElement('li');
    li.className = ['request', item.changed ? 'changed' : '', item.refused ? 'refused' : ''].filter(Boolean).join(' ');
    li.append(line('h2', 'heading', item.heading));
    if (item.asked) li.append(line('p', 'asked', `Asked ${item.asked}`));
    const rows = document.createElement('dl');
    for (const row of item.rows || []) rows.append(line('dt', '', row.label), ...value(row.label === 'Working folder' ? 'path' : '', row.value, row.nonAscii));
    li.append(rows, line('p', 'who', item.who));
    if (item.changed) li.append(line('p', 'notice', item.changed));
    if (item.refused) li.append(line('p', 'notice', item.refused));
    if (!item.canApprove) li.append(line('p', 'notice', 'Part of this request can\'t be shown exactly as it is, so it can only be rejected here.'));
    const approve = button('Approve', 'primary', () => act('approvals_approve', { id: item.id, digest: item.digest }),
      view.busy || !item.canApprove || !settled(item));
    // Enter never approves (a stray Enter meant for something else); a click, or Space on the focused button, does.
    approve.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(button('Reject', '', () => act('approvals_reject', { id: item.id }), view.busy), approve);
    li.append(actions);
    return li;
  }));
}

async function refresh() {
  try { render(await invoke('approvals_view')); } catch { /* The next refresh tries again. */ }
}
$('custom-check').addEventListener('click', () => act('approvals_custom_check', { name: $('custom-name').value, command: $('custom-command').value, model: $('custom-model').value }));
$('custom-edit').addEventListener('click', () => { rearmCustom(); act('approvals_custom_edit'); });
// Make sends the command the confirmation shows, and only that is made. Enter never presses it.
$('custom-make').addEventListener('click', () => { const command = shownCustom; rearmCustom(); act('approvals_custom_make', { command }); });
// Back in focus: every wait starts again, so a click that brought the window forward can't land on Approve or Make.
window.addEventListener('focus', () => { rearm(); refresh(); });
$('custom-make').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
$('close').addEventListener('click', () => invoke('approvals_close').catch(() => window.close()));
refresh();
setInterval(refresh, 500);
