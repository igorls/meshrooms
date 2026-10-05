// The pairing window (desktop/src-tauri/src/pair.rs). It shows the link's claim (a name and an address), takes the
// typed phrase, lists the rooms' public titles before the final Pair, and follows the rooms; it also asks before the app
// is unpaired. It never receives the phrase or the secret: the app checks what is typed. Everything from the app is
// shown as text, never as markup.
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = id => document.getElementById(id);
const stateText = { waiting: 'Waiting for your browser', joined: 'Joined', failed: 'Not paired' };
let focused = false, stage = '';

function rooms(list, showState, noted = false) {
  const ul = $('rooms');
  ul.replaceChildren(...list.map(room => {
    const li = document.createElement('li'), title = document.createElement('span'), state = document.createElement('span');
    li.className = room.state; title.textContent = room.title;
    state.textContent = noted ? room.note : showState ? stateText[room.state] || room.state : room.known ? '' : 'Title unavailable';
    li.append(title, state);
    return li;
  }));
  ul.hidden = !list.length;
}

/** Room names the app gives as plain text, each with the same note. */
function names(list, note) {
  rooms(list.map(title => ({ title, state: 'failed', note })), false, true);
}

function text(title, lead) { $('title').textContent = title; $('lead').textContent = lead; }

function render(view) {
  stage = view.stage;
  const count = view.roomCount === 1 ? '1 room' : `${view.roomCount} rooms`;
  // Exactly one stage's controls: the phrase, then the rooms (once their titles are read), then progress, or unpairing.
  $('ask').hidden = view.stage !== 'asking';
  $('review').hidden = !(view.stage === 'reviewing' && view.titled === true);
  $('unpair').hidden = !['unpair', 'unpair-failed'].includes(view.stage);
  $('unpair-go').disabled = false;
  $('unpair-go').textContent = view.stage === 'unpair-failed' ? 'Try again' : view.soleHost?.length ? 'Unpair anyway' : 'Unpair';
  $('unpair-cancel').textContent = view.stage === 'unpair-failed' ? 'Close' : 'Cancel';
  $('after').hidden = ['asking', 'reviewing', 'unpair', 'unpair-failed', 'sending', 'unpairing'].includes(view.stage);
  $('open').hidden = view.stage !== 'done';
  $('after-problem').textContent = view.problem || '';
  if (view.stage === 'asking') {
    text('Pair this computer?', `A browser calling itself ${view.name}, at ${view.origin}, asks to add ${count} to this computer.`);
    if (!focused) { focused = true; $('phrase').focus(); }
    rooms([], false);
    return;
  }
  if (view.stage === 'reviewing') {
    if (view.titled !== true) { text('The phrase matches', `Reading the rooms' names from ${view.origin}…`); rooms([], false); return; }
    text('Pair these rooms?', `The phrase matches. ${view.origin} lists these rooms; this computer will join them as one of ${view.name}'s devices.`);
    rooms(view.rooms || [], false);
    return;
  }
  if (view.stage === 'unpair') {
    const where = `This app is paired with ${view.name}${view.origin ? ` at ${view.origin}` : ''}.`;
    const reach = view.unreachable ? ` ${view.unreachable === 1 ? 'One room doesn\'t' : `${view.unreachable} rooms don't`} answer right now: unpairing stops there, deleting nothing, until it does.` : '';
    if (view.soleHost?.length) text('Unpair this computer?', `${where} This computer is the only host device of the rooms below: unpairing anyway leaves them without a host (they keep this computer as a member nobody can use). Cancel to add another host device first.${reach}`);
    else text('Unpair this computer?', `${where} Unpairing takes this computer out of ${view.roomCount === 1 ? 'its room' : `its ${view.roomCount} rooms`} and deletes this computer's key for them. You can pair again later.${reach}`);
    names(view.listed || [], 'Loses its host');
    return;
  }
  if (view.stage === 'unpair-failed') {
    text('Unpairing stopped', 'This computer still holds your rooms and its key.');
    names(view.listed || [], 'Couldn\'t be left');
    return;
  }
  if (view.stage === 'unpaired-kept') {
    text('Unpaired, with rooms left without a host', 'This computer no longer holds your rooms. The rooms below kept it as their only host device, so they have no host now.');
    names(view.listed || [], 'No host');
    return;
  }
  rooms(['sending', 'waiting', 'done', 'failed'].includes(view.stage) ? view.rooms || [] : [], true);
  if (view.stage === 'sending') text('Asking to join your rooms…', `Sending the requests to ${view.origin}.`);
  else if (view.stage === 'waiting') text('Now confirm in your browser', `The requests are sent. In ${view.name}'s browser, press Confirm pairing.`);
  else if (view.stage === 'done') text('Paired', 'Your rooms are on this computer now.');
  else if (view.stage === 'failed') text('Pairing failed', '');
  else if (view.stage === 'expired') text('This pairing expired', 'Start again from your browser.');
  else if (view.stage === 'unpairing') text('Unpairing…', 'Taking this computer out of your rooms.');
  else if (view.stage === 'unpaired') text('Unpaired', 'This computer no longer holds your rooms. Pair again from your browser whenever you like.');
  else if (view.stage === 'unpair-failed') text('Unpairing failed', '');
  else text('No pairing is waiting', 'Start pairing from Meshrooms in your browser.');
}

async function refresh() {
  try { render(await invoke('pair_view')); } catch { /* The next refresh tries again. */ }
}
// Reject drops what waits in the window; Close only closes it (what is under way carries on). The page can't close itself:
// it has no core permissions, so the app does.
const close = () => invoke('pair_reject').catch(() => invoke('pair_close'));

$('phrase').addEventListener('input', async () => {
  $('problem').textContent = '';
  try { $('next').disabled = !(await invoke('pair_check', { typed: $('phrase').value })); } catch { $('next').disabled = true; }
});
$('ask').addEventListener('submit', async event => {
  event.preventDefault();
  $('next').disabled = true;
  try { await invoke('pair_verify', { typed: $('phrase').value }); $('phrase').value = ''; }
  catch (error) { $('problem').textContent = String(error); }
  refresh();
});
$('pair').addEventListener('click', async () => {
  $('pair').disabled = true;
  try { await invoke('pair_confirm'); } catch (error) { $('after-problem').textContent = String(error); }
  refresh();
});
$('unpair-go').addEventListener('click', async () => {
  $('unpair-go').disabled = true;
  try { await invoke('pair_unpair'); } catch (error) { $('after-problem').textContent = String(error); }
  refresh();
});
for (const id of ['reject', 'reject2', 'unpair-cancel']) $(id).addEventListener('click', close);
$('close').addEventListener('click', () => (['sending', 'waiting', 'unpairing'].includes(stage) ? invoke('pair_close') : close()).catch(() => {}));
$('open').addEventListener('click', () => invoke('pair_open').catch(() => {}));
refresh();
setInterval(refresh, 700);
