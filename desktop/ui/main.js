// The shell passes progress and errors in the query; this page never receives room data.
const params = new URLSearchParams(location.search);
if (params.has('title')) document.getElementById('title').textContent = params.get('title');
if (params.has('detail')) document.getElementById('detail').textContent = params.get('detail');
document.body.classList.toggle('failed', params.get('failed') === '1');
