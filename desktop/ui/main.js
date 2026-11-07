// Only this bundled window gets the home capability. All values are inert text; status updates preserve focus.
const $ = id => document.getElementById(id);
const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
let view, requesting = false, refreshing = false, problem = '', readProblem = '';
const roomRows = new Map();

function renderRooms(busy, running) {
  const focusedRoom = document.activeElement?.closest('#rooms-list button');
  const rooms = Array.isArray(view?.rooms) ? view.rooms : [];
  $('your-rooms').hidden = !Array.isArray(view?.rooms) && !view?.roomsProblem;
  const note = view?.roomsProblem || (Array.isArray(view?.rooms) && !rooms.length ? 'No rooms paired yet. Open your rooms to get started.' : '');
  text('rooms-problem', note); $('rooms-problem').hidden = !note;
  const kept = new Set();
  for (const [index, room] of rooms.entries()) {
    kept.add(room.id);
    let row = roomRows.get(room.id);
    if (!row) {
      const item = document.createElement('li'), button = document.createElement('button');
      const label = document.createElement('strong'), detail = document.createElement('small'), badge = document.createElement('span');
      button.className = 'home-room'; badge.className = 'home-room-count'; badge.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span'); copy.append(label, detail); button.append(copy, badge); item.append(button);
      button.addEventListener('click', () => act('room', room.id));
      row = { item, button, label, detail, badge }; roomRows.set(room.id, row);
    }
    const notes = [];
    if (room.unread > 0) notes.push(`${room.unread} unread`);
    if (room.mentions > 0) notes.push(`${room.mentions} ${room.mentions === 1 ? 'mention' : 'mentions'}`);
    if (room.waiting > 0) notes.push(`${room.waiting} waiting to join`);
    const state = { waiting: 'Waiting for approval', starting: 'Connecting to room', declined: 'Request declined', expired: 'Request expired' }[room.state];
    const detail = notes.join(' · ') || state || (running === false ? 'Start service and open' : 'Open in browser');
    if (row.label.textContent !== room.title) row.label.textContent = room.title;
    if (row.detail.textContent !== detail) row.detail.textContent = detail;
    row.button.title = room.title;
    row.button.setAttribute('aria-label', `${running === false ? 'Start and open' : 'Open'} ${room.title}, ${detail}`);
    row.button.disabled = busy || typeof running !== 'boolean';
    row.badge.hidden = !room.unread;
    row.badge.textContent = room.unread > 99 ? '99+' : String(room.unread || '');
    row.button.classList.toggle('has-mentions', room.mentions > 0);
    // A count update must not replace the focused button or rebuild the whole list.
    if ($('rooms-list').children[index] !== row.item) $('rooms-list').insertBefore(row.item, $('rooms-list').children[index] || null);
  }
  for (const [id, row] of roomRows) if (!kept.has(id)) { row.item.remove(); roomRows.delete(id); }
  if (focusedRoom?.isConnected && document.activeElement !== focusedRoom) focusedRoom.focus({ preventScroll: true });
}

function render() {
  const busy = requesting || !!view?.busy;
  const running = readProblem ? undefined : view?.running;
  const failed = !!(problem || readProblem || view?.problem);
  text('connection', running === true ? 'Background service running'
    : running === false ? 'Background service stopped' : failed ? 'Status unavailable' : 'Checking background service…');
  $('status-dot').className = running === true ? 'is-running' : running === false || failed ? 'is-stopped' : 'is-checking';
  text('detail', running === true ? 'Rooms and agents can stay connected while you work.'
    : running === false ? 'Start the service to open your rooms. Existing room connections keep running.' : view?.detail || 'Reading this computer’s status.');
  $('detail').title = view?.detail || '';
  text('problem', problem || readProblem || view?.problem || '');
  $('problem').hidden = !failed;
  for (const button of document.querySelectorAll('[data-action]')) button.disabled = busy;
  $('open').disabled = busy || typeof running !== 'boolean';
  text('open-label', running === false ? 'Start and open your rooms' : 'Open your rooms');
  $('service').disabled = busy || typeof running !== 'boolean';
  $('service').dataset.action = running ? 'stop' : 'start';
  text('service', running ? 'Stop background service' : 'Start background service');
  $('login').checked = !!view?.loginOn;
  $('login').disabled = busy || !view?.loginEnabled;
  text('login-detail', view?.loginOn ? 'Meshrooms will open in the tray.'
    : view?.loginLabel?.includes('daemon starts on its own') ? 'The service currently starts without the app.'
      : view?.loginEnabled ? 'Open Meshrooms automatically when you sign in.' : view?.loginLabel || 'Checking login settings…');
  const waiting = view?.approvals;
  text('approvals-detail', typeof waiting === 'number' && waiting > 0 ? `${waiting} ${waiting === 1 ? 'request' : 'requests'} waiting for you` : 'Review requests before they run');
  $('approvals').classList.toggle('has-waiting', typeof waiting === 'number' && waiting > 0);
  text('activity', busy ? view?.activity || 'Working…' : '');
  $('open').setAttribute('aria-busy', String(!!(busy && view?.activity?.startsWith('Opening'))));
  renderRooms(busy, running);
}

async function refresh() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try { view = await invoke('home_view'); readProblem = ''; }
  catch (error) { readProblem = `Cannot read desktop status. ${String(error)}`; }
  finally { refreshing = false; render(); }
}

async function act(action, room) {
  if (requesting || view?.busy) return;
  requesting = true; problem = ''; render();
  try { await invoke('home_action', { action, ...(room ? { room } : {}) }); }
  catch (error) { problem = String(error); }
  finally { requesting = false; await refresh(); render(); }
}

for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => act(button.dataset.action));
$('login').addEventListener('change', () => act('login'));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
refresh();
setInterval(refresh, 1000);
