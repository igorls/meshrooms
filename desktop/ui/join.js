// The join window (desktop/src-tauri/src/join.rs). It shows a meshrooms://join link as the claim it is (the room's
// public title and its address), asks before joining, and follows the request until the host lets this computer in.
// When this computer can't join from the link (not paired, or paired with someone at another address), it says why and
// offers the room in the browser. Everything from the app is shown as text, never as markup.
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = id => document.getElementById(id);
let stage = '', shown, joining = false;

function text(title, lead, note) {
  $('title').textContent = title;
  $('lead').textContent = lead;
  $('note').textContent = note || '';
  $('note').hidden = !note;
}

function render(view) {
  stage = view.stage;
  shown = view.id;
  // Disabled only while a Join is on its way: a refused one, or a new link in this window, can be joined again.
  $('join').disabled = joining;
  const room = view.known ? `“${view.title}”` : 'a room (its name couldn’t be read)';
  $('ask').hidden = !(view.stage === 'confirm' && view.titled === true);
  $('after').hidden = ['checking', 'confirm', 'sending'].includes(view.stage);
  $('browse').hidden = !['not-paired', 'other-service', 'failed'].includes(view.stage);
  $('steps').hidden = view.stage !== 'not-paired';
  $('problem').textContent = view.problem || '';
  if (view.stage === 'checking') text('Opening the room link…', '');
  else if (view.stage === 'not-paired') text('Pair this computer first',
    'Meshrooms on this computer isn’t paired with your browser yet, so it can’t join rooms for you. Pair it from your browser’s Use the desktop app:',
    `Until then, you can join this room in your browser, at ${view.origin}.`);
  else if (view.stage === 'other-service') text('This link is for another Meshrooms',
    `This app is paired with ${view.pairedName} at ${view.pairedOrigin}. The link asks to join a room at ${view.origin}, and one app holds one person, so it won’t join here.`,
    'Open the room in your browser instead, or unpair this computer from the tray first.');
  else if (view.stage === 'confirm') {
    if (view.titled !== true) text('Join this room?', `Reading the room’s name from ${view.origin}…`);
    else text('Join this room?', `A link asks this computer to join ${room} at ${view.origin}, as ${view.name}. The host decides who comes in.`,
      'The name and address come from the link and that room service, not from Meshrooms: only join a room you meant to open. If you are already in this room from your browser, pair it instead (Room details, then Use the desktop app), so this computer joins as you rather than as a new member.');
  }
  else if (view.stage === 'sending') text('Asking to join…', `Sending the request to ${view.origin}.`);
  else if (view.stage === 'waiting') text('Waiting for the host to let you in', `Your request is with ${room} at ${view.origin}. Meshrooms opens the room in your browser once you’re in.`,
    'Closing this window stops waiting here. Your request stays with the host; once you’re in, the room is in Meshrooms.');
  else if (view.stage === 'done') text('You’re in', `Opening ${room} in your browser.`);
  else if (view.stage === 'failed') text('Not joined', '');
  else if (view.stage === 'expired') text('This link expired', 'Open it again from your browser.');
  else text('No room link is waiting', 'Open a room from Meshrooms in your browser.');
}

async function refresh() {
  try { render(await invoke('join_view')); } catch { /* The next refresh tries again. */ }
}
const cancel = () => invoke('join_cancel').catch(() => window.close());

$('join').addEventListener('click', async () => {
  if (joining || shown === undefined) return;
  joining = true;
  $('join').disabled = true;
  try { await invoke('join_confirm', { id: shown }); } catch (error) { $('problem').textContent = String(error); }
  joining = false;
  refresh();
});
$('cancel').addEventListener('click', cancel);
$('browse').addEventListener('click', () => invoke('join_browse').catch(error => { $('problem').textContent = String(error); }));
$('close').addEventListener('click', cancel);
refresh();
setInterval(refresh, 700);
