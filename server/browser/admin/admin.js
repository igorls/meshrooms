'use strict';
const $ = id => document.getElementById(id);
let csrf = '', issued = false;
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function auth(signedIn) { $('login').hidden = signedIn; $('panel').hidden = !signedIn; $('logout').hidden = !signedIn; }
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) { auth(false); clearCode(); } throw new Error(result.error || 'Request failed.'); }
  return result;
}
async function act(button, work) { error(''); button.disabled = true; try { await work(); } catch (e) { error(e.message); } finally { button.disabled = false; } }
const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
function cell(row, text) { const td = document.createElement('td'); td.textContent = String(text); row.append(td); return td; }
function clearCode() { $('issued').hidden = true; $('code').textContent = ''; $('copy-status').textContent = ''; issued = false; }
async function refresh() {
  const state = await api('/api/state'); csrf = state.csrf; auth(true);
  $('people-count').textContent = state.people.length;
  $('room-count').textContent = state.rooms.length;
  $('invite-count').textContent = state.invites.reduce((sum, i) => sum + (!i.revokedAt && i.expiresAt > Date.now() ? i.remaining : 0), 0);
  $('invites').replaceChildren(); $('rooms').replaceChildren(); $('no-invites').hidden = state.invites.length > 0;
  for (const invite of [...state.invites].reverse()) {
    const row = document.createElement('tr'), label = cell(row, invite.note || 'Untitled invitation'), id = document.createElement('small'); id.textContent = invite.id; label.append(id);
    const status = invite.revokedAt ? 'Revoked' : invite.expiresAt <= Date.now() ? 'Expired' : invite.remaining ? 'Active' : 'Used';
    const badge = document.createElement('span'); badge.className = `badge ${status.toLowerCase()}`; badge.textContent = status; cell(row, '').append(badge);
    cell(row, `${invite.uses - invite.remaining} / ${invite.uses}`); cell(row, date(invite.expiresAt)); const action = cell(row, '');
    if (status === 'Active') { const button = document.createElement('button'); button.textContent = 'Revoke'; button.className = 'quiet'; button.setAttribute('aria-label', `Revoke ${invite.note || invite.id}`); button.onclick = () => { if (confirm(`Revoke ${invite.note || invite.id}? People already admitted keep access.`)) void act(button, async () => { await api(`/api/invites/${invite.id}/revoke`, {}); await refresh(); }); }; action.append(button); }
    $('invites').append(row);
  }
  for (const room of state.rooms) { const row = document.createElement('tr'); cell(row, room.title); cell(row, room.members); cell(row, room.devices); cell(row, date(room.lastActiveAt)); $('rooms').append(row); }
}
$('login-form').onsubmit = event => { event.preventDefault(); void act(event.submitter, async () => { const r = await api('/api/login', { password: $('password').value }); $('password').value = ''; csrf = r.csrf; await refresh(); }); };
$('mint-form').onsubmit = event => { event.preventDefault(); if (issued && !confirm('The previous code will disappear. Have you saved it?')) return; void act(event.submitter, async () => { const r = await api('/api/invites', { uses: Number($('uses').value), days: Number($('days').value), note: $('note').value }); $('code').textContent = r.code; $('issued').hidden = false; issued = true; $('copy-status').textContent = ''; await refresh(); $('issued').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }); };
$('copy').onclick = () => void act($('copy'), async () => { await navigator.clipboard.writeText($('code').textContent); $('copy-status').textContent = 'Code copied.'; });
$('dismiss').onclick = clearCode;
$('refresh').onclick = () => void act($('refresh'), refresh);
$('logout').onclick = () => void act($('logout'), async () => { await api('/api/logout', {}); csrf = ''; clearCode(); auth(false); });
addEventListener('beforeunload', event => { if (issued) { event.preventDefault(); event.returnValue = ''; } });
refresh().catch(e => { if (!e.message.includes('Sign in')) error(e.message); });
