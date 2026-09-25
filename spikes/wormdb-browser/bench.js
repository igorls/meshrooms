// Runs the step-1 gates in a worker and shows them against their targets. `window.spike` is what the automated
// runner (run.mjs) drives, including the crash test, which needs the page to be killed mid-write.
const GATES = {
  size: { target: '≤ 300 KB gzipped', pass: r => r.gzipKB <= 300, show: r => `${r.gzipKB.toFixed(1)} KB gzipped (${r.rawKB.toFixed(1)} KB raw)` },
  writes: { target: 'p50 ≤ 5 ms, p95 ≤ 20 ms', pass: r => r.p50 <= 5 && r.p95 <= 20, show: r => `p50 ${r.p50.toFixed(2)} ms · p95 ${r.p95.toFixed(2)} ms · max ${r.max.toFixed(1)} ms (${r.count} × ${r.size} B, flush each)` },
  coldOpen: { target: '10,000 records ≤ 250 ms', pass: r => r.ms <= 250 && r.found === r.count && r.readsOk, show: r => `${r.ms.toFixed(0)} ms for ${r.found} records${r.readsOk ? '' : ' · reads wrong'}` },
  crash: { target: 'recovers to last flush', pass: r => r.recovered, show: r => `${r.found} records after a kill at ${r.flushed + 1} flushed` },
};

let worker, seq = 0;
const pending = new Map();
function call(task, args = {}) {
  worker ||= Object.assign(new Worker('worker.js'), { onmessage: ({ data }) => {
    if (data.progress !== undefined) { window.spikeProgress = data.progress; return; }
    const p = pending.get(data.id); pending.delete(data.id);
    data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
  } });
  return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ id, task, ...args }); });
}

async function wasmSize() {
  const response = await fetch('wormdb.wasm');
  if (!response.ok) throw new Error('wormdb.wasm is not in this folder yet.');
  const raw = new Uint8Array(await response.arrayBuffer());
  const gzip = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return { rawKB: raw.length / 1024, gzipKB: gzip.byteLength / 1024 };
}

function show(gate, result, error) {
  const row = document.getElementById(`gate-${gate}`) || document.getElementById('results').appendChild(Object.assign(document.createElement('tr'), { id: `gate-${gate}` }));
  const ok = !error && GATES[gate].pass(result);
  const cells = [gate, GATES[gate].target, error ? `error: ${error}` : GATES[gate].show(result), ok ? 'pass' : 'fail'].map(text => Object.assign(document.createElement('td'), { textContent: text }));
  cells[3].className = ok ? 'pass' : 'fail';
  row.replaceChildren(...cells);
  return ok;
}

window.spike = {
  async run(engine) {
    const out = {};
    if (engine === 'wasm') { try { out.size = await wasmSize(); show('size', out.size); } catch (e) { show('size', null, e.message); } }
    for (const gate of ['writes', 'coldOpen']) {
      try { out[gate] = await call(gate, { engine }); show(gate, out[gate]); } catch (e) { out[gate] = { error: e.message }; show(gate, null, e.message); }
    }
    return out;
  },
  crashWrite: (engine) => { call('crashWrite', { engine }); },
  async crashVerify(engine, flushed) { const r = await call('crashVerify', { engine, flushed }); show('crash', r); return r; },
  pass: (gate, result) => GATES[gate].pass(result),
};

document.getElementById('run').addEventListener('click', async () => {
  document.getElementById('note').textContent = 'Running… (the crash test runs from run.mjs, since it has to kill the page)';
  await window.spike.run(document.getElementById('engine').value);
  document.getElementById('note').textContent = '';
});
