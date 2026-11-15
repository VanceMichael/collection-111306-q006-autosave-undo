const output = document.querySelector('#output');
const batchRows = document.querySelector('#batch-rows');

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '请求失败');
  return data;
}

function show(value) { output.textContent = JSON.stringify(value, null, 2); }

async function loadPortal() {
  const info = await api('/api/portal');
  document.querySelector('#portal').textContent = info.portal;
  document.querySelector('#portal-link').href = info.portal;
}

function statusClass(text) {
  if (['confirmed', 'restored'].includes(text)) return 'confirmed';
  if (['unconfirmed', 'conflict'].includes(text)) return text;
  if (text === 'failed') return 'failed';
  if (['noop', 'skipped'].includes(text)) return text;
  return '';
}

async function refreshBatches() {
  const batches = await api('/api/batches');
  batchRows.replaceChildren();
  for (const item of batches) {
    const tr = document.createElement('tr');
    const s = item.汇总;
    tr.innerHTML = `
      <td>${item.id}</td>
      <td>${item.state}</td>
      <td><span class="confirmed">${s.已确认写入}</span> / <span class="unconfirmed">${s.未确认写入}</span> / <span class="failed">${s.确认失败}</span></td>
      <td>恢复 ${s.撤回已恢复} · 冲突 ${s.撤回冲突待人工} · 跳过 ${s.撤回跳过}</td>
      <td>${item.待人工问题.length ? item.待人工问题.map(q => `<span class="conflict">${q.单元格}</span>`).join('，') : '无'}</td>
      <td></td>`;
    const actions = tr.querySelector('td:last-child');
    const detail = document.createElement('button');
    detail.textContent = '详情';
    detail.onclick = async () => show(await api(`/api/batches/${item.id}`));
    actions.append(detail);
    const recover = document.createElement('button');
    recover.textContent = '恢复核实';
    recover.onclick = async () => { try { show(await api('/api/batches/recover', { method: 'POST', body: { batchId: item.id } })); await refreshBatches(); } catch (e) { show({ error: e.message }); } };
    actions.append(recover);
    const keep = document.createElement('button');
    keep.textContent = '核实并继续';
    keep.onclick = async () => { try { show(await api('/api/batches/recover', { method: 'POST', body: { batchId: item.id, continue: true } })); await refreshBatches(); } catch (e) { show({ error: e.message }); } };
    actions.append(keep);
    const undo = document.createElement('button');
    undo.textContent = '撤回';
    undo.onclick = async () => { try { show(await api('/api/batches/undo', { method: 'POST', body: { batchId: item.id } })); await refreshBatches(); } catch (e) { show({ error: e.message }); } };
    actions.append(undo);
    batchRows.append(tr);
  }
}

document.querySelector('#btn-run').onclick = async () => {
  try {
    const plan = JSON.parse(document.querySelector('#plan').value);
    show(await api('/api/batches/run', { method: 'POST', body: { plan } }));
    await refreshBatches();
  } catch (error) { show({ error: error.message }); }
};
document.querySelector('#btn-continue').onclick = async () => {
  try {
    const batchId = document.querySelector('#continue-id').value.trim();
    show(await api('/api/batches/run', { method: 'POST', body: { batchId } }));
    await refreshBatches();
  } catch (error) { show({ error: error.message }); }
};
document.querySelector('#btn-refresh').onclick = refreshBatches;

await loadPortal();
await refreshBatches();
