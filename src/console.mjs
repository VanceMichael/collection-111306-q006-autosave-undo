// 接收器侧批次管理台：独立于本地资料源的 HTTP 服务，浏览器可见的批次执行/恢复/撤回入口。
// 业务操作仍由 robot.mjs 通过门户可见页面完成，本服务只编排批次领域与持久化。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startSource } from './source.mjs';
import { BatchStore } from './batch-store.mjs';
import {
  ATTEMPT, UNDO, createBatch, recordRead, recordAttempt, verifyAttempt,
  planUndo, applyUndoResult, summarize, openQuestions,
  pendingPlanItems, unconfirmedKeys, planProgress, finishIfComplete, cellKey
} from './batch.mjs';
import { launchBrowser, openPage, closePage, observe, editCell } from './robot.mjs';

const BATCH_DIR = process.env.BATCH_DIR ?? 'var/batches';

async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1048576) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// 每次请求一个短生命周期浏览器会话，批次本身已在磁盘持久化，不依赖内存状态。
async function withPortalSession(sourceUrl, work) {
  const browser = await launchBrowser();
  try {
    const session = await openPage(browser, sourceUrl);
    try { return await work(session); }
    finally { await closePage(session); }
  } finally { await browser.close(); }
}

export async function startConsole({ port = 0, sourceUrl = null } = {}) {
  const owned = sourceUrl ? null : await startSource();
  const portal = sourceUrl ?? owned.url;
  const store = new BatchStore(resolve(BATCH_DIR));

  async function handleApi(pathname, request, response, send) {
    if (request.method === 'GET' && pathname === '/api/portal') return send({ portal });
    if (request.method === 'GET' && pathname === '/api/batches') {
      const files = await store.list();
      const batches = [];
      for (const file of files) {
        const batch = await store.load(file.replace(/\.json$/, ''));
        batches.push({ id: batch.id, state: batch.state, 汇总: summarize(batch), 待人工问题: openQuestions(batch) });
      }
      return send(batches);
    }
    if (request.method === 'POST' && pathname === '/api/batches/run') {
      const body = await jsonBody(request);
      let batch;
      if (body.batchId) {
        batch = await store.load(body.batchId);
        if (!batch) throw new Error(`批次不存在：${body.batchId}`);
      } else {
        batch = await store.saveNew(createBatch(body.plan, { source: portal }));
      }
      const result = await withPortalSession(portal, async (session) => {
        const initial = await observe(session.page, 'baseline');
        await store.update(batch.id, current => { recordRead(current, initial); return current; });
        const interrupted = [];
        for (const item of pendingPlanItems(await store.load(batch.id))) {
          const edit = await editCell(session.page, item);
          const saved = await store.update(batch.id, current => {
            recordAttempt(current, {
              id: item.id, column: item.column, value: item.value,
              fromValue: edit.fromValue,
              status: edit.outcome === 'unconfirmed' ? ATTEMPT.UNCONFIRMED : ATTEMPT.CONFIRMED,
              reason: edit.outcome === 'unconfirmed' ? '自动保存确认回包丢失，实际是否落地未知'
                : edit.outcome === 'unchanged' ? '当前值已是目标值' : '收到自动保存成功回包'
            });
            finishIfComplete(current);
            return current;
          });
          if (saved.attempts.at(-1).status === ATTEMPT.UNCONFIRMED) {
            interrupted.push(cellKey(item.id, item.column));
            break;
          }
          const refresh = await observe(session.page, 'refresh');
          await store.update(batch.id, current => { recordRead(current, refresh); return current; });
        }
        return interrupted;
      });
      const latest = await store.load(batch.id);
      return send({ 批次: batch.id, 中断项: result, 进度: planProgress(latest), 汇总: summarize(latest), 待人工问题: openQuestions(latest) });
    }
    if (request.method === 'POST' && pathname === '/api/batches/recover') {
      const { batchId, continue: keepGoing = false } = await jsonBody(request);
      const batch = await store.load(batchId);
      if (!batch) throw new Error(`批次不存在：${batchId}`);
      const verdicts = await withPortalSession(portal, async (session) => {
        const outcomes = [];
        for (const key of unconfirmedKeys(await store.load(batchId))) {
          const verifyRead = await observe(session.page, 'verify');
          const outcome = await store.update(batchId, current => {
            const result = verifyAttempt(current, key, verifyRead);
            finishIfComplete(current);
            return { result, batch: current };
          });
          outcomes.push({ 单元格: key, 核实结论: outcome.result.outcome, 回读值: outcome.result.observed ?? null });
          if (outcome.result.outcome === 'conflict') break;
        }
        if (keepGoing) {
          for (const item of pendingPlanItems(await store.load(batchId))) {
            const edit = await editCell(session.page, item);
            const saved = await store.update(batchId, current => {
              recordAttempt(current, {
                id: item.id, column: item.column, value: item.value,
                fromValue: edit.fromValue,
                status: edit.outcome === 'unconfirmed' ? ATTEMPT.UNCONFIRMED : ATTEMPT.CONFIRMED,
                reason: edit.outcome === 'unconfirmed' ? '续跑时确认回包再次丢失' : '续跑写入已确认'
              });
              finishIfComplete(current);
              return current;
            });
            if (saved.attempts.at(-1).status === ATTEMPT.UNCONFIRMED) break;
          }
        }
        return outcomes;
      });
      const latest = await store.load(batchId);
      return send({ 批次: batchId, 核实: verdicts, 汇总: summarize(latest), 待人工问题: openQuestions(latest) });
    }
    if (request.method === 'POST' && pathname === '/api/batches/undo') {
      const { batchId } = await jsonBody(request);
      const batch = await store.load(batchId);
      if (!batch) throw new Error(`批次不存在：${batchId}`);
      const finalized = await withPortalSession(portal, async (session) => {
        const undoRead = await observe(session.page, 'undo');
        const planned = (await store.update(batchId, current => ({ result: planUndo(current, undoRead), batch: current }))).result;
        const results = [];
        for (const cell of planned) {
          if (cell.outcome !== 'pending-restore') { results.push(cell); continue; }
          const fresh = await observe(session.page, 'undo');
          const [freshId, freshColumn] = cell.key.split(':');
          const currentValue = fresh.rows.find(row => row.id === freshId)[freshColumn];
          if (currentValue !== cell.written) {
            results.push({ ...cell, outcome: UNDO.CONFLICT, reason: '恢复写回前发现单元格已被其他人修改', current: currentValue });
            continue;
          }
          const [id, column] = cell.key.split(':');
          const edit = await editCell(session.page, { id, column, value: cell.baseline });
          results.push({ ...cell, result: { status: edit.outcome === 'unconfirmed' ? 'failed' : 'restored', detail: edit.statusText } });
        }
        const done = (await store.update(batchId, current => ({ result: applyUndoResult(current, results), batch: current }))).result;
        const postRead = await observe(session.page, 'undo');
        await store.update(batchId, current => { recordRead(current, postRead); return current; });
        return done;
      });
      const latest = await store.load(batchId);
      return send({
        批次: batchId,
        撤回明细: finalized.map(cell => ({ 单元格: cell.key, 结论: cell.outcome, 说明: cell.reason ?? cell.detail ?? null })),
        汇总: summarize(latest), 待人工问题: openQuestions(latest)
      });
    }
    if (request.method === 'GET' && pathname.startsWith('/api/batches/')) {
      const batchId = pathname.split('/').pop();
      const batch = await store.load(batchId);
      if (!batch) throw new Error(`批次不存在：${batchId}`);
      return send({ 汇总: summarize(batch), 批次: batch, 待人工问题: openQuestions(batch) });
    }
    throw new Error('无此接口');
  }

  const server = createServer((request, response) => {
    const send = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    const url = new URL(request.url, 'http://127.0.0.1');
    (async () => {
      if (url.pathname === '/' || url.pathname === '/console.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return response.end(await readFile(new URL('../public/console.html', import.meta.url)));
      }
      if (url.pathname === '/console.mjs') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return response.end(await readFile(new URL('../public/console.mjs', import.meta.url)));
      }
      await handleApi(url.pathname, request, response, send);
    })().catch(error => send({ error: error.message }, 400));
  });

  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    portal,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (owned) await owned.close();
    }
  };
}
