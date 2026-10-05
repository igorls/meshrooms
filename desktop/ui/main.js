// The app passes the daemon's status in the query; this page never receives room data and never runs it as markup.
const params = new URLSearchParams(location.search);
if (params.has('title')) document.getElementById('title').textContent = params.get('title');
if (params.has('detail')) document.getElementById('detail').textContent = params.get('detail');
document.body.classList.toggle('failed', params.get('failed') === '1');
