// Inert notice window (desktop/src-tauri/src/links.rs): renders ?detail= as plain text only. Its one capability is
// closing itself (capabilities/notice.json); window.close() is the fallback where the app's command is unavailable.
const detail = new URLSearchParams(location.search).get('detail');
document.getElementById('detail').textContent = detail && detail.trim() ? detail : 'No action was taken.';
document.getElementById('close').addEventListener('click', () => {
  const invoke = window.__TAURI__?.core?.invoke;
  (invoke ? invoke('notice_close') : Promise.reject()).catch(() => window.close());
});
