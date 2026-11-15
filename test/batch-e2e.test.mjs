import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../src/source.mjs';
import { BatchStore } from '../src/batch-store.mjs';
import {
  ATTEMPT, UNDO, createBatch, recordRead, recordAttempt, verifyAttempt,
  planUndo, applyUndoResult, finishIfComplete, unconfirmedKeys, summarize
} from '../src/batch.mjs';
import { launchBrowser, openPage, closePage, observe, editCell, sortViaPage } from '../src/robot.mjs';

async function action(source, name) {
  const response = await fetch(`${source.url}/api/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: name })
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function snapshot(source) {
  return (await fetch(`${source.url}/api/snapshot`)).json();
}

async function withEnvironment(work) {
  const root = await mkdtemp(join(tmpdir(), 'batch-e2e-'));
  const source = await startSource();
  const store = new BatchStore(join(root, 'batches'));
  const browser = await launchBrowser();
  try { await work({ root, source, store, browser }); }
  finally {
    await browser.close();
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('回包丢失后回读核实为已落地，撤回恢复原值且 total 由门户重算', { timeout: 30000 }, async () => {
  await withEnvironment(async ({ source, store, browser }) => {
    const session = await openPage(browser, source.url);
    try {
      const batch = await store.saveNew(createBatch([{ id: 'a', column: 'price', value: 20 }], { source: source.url }));
      const initialRead = await observe(session.page, 'baseline');
      await store.update(batch.id, current => { recordRead(current, initialRead); return current; });
      await action(source, 'lost-reply');
      const edit = await editCell(session.page, { id: 'a', column: 'price', value: 20 });
      assert.equal(edit.outcome, 'unconfirmed');
      await store.update(batch.id, current => {
        recordAttempt(current, { id: 'a', column: 'price', value: 20, fromValue: edit.fromValue, status: ATTEMPT.UNCONFIRMED, reason: '确认回包丢失' });
        return current;
      });
      // 落地事实：源端已经保存，只是回包丢了
      assert.equal((await snapshot(source)).rows.find(row => row.id === 'a').price, 20);
      await action(source, 'normal-reply');
      // 新页面上下文做回读核实
      const verdictRead = await observe(session.page, 'verify');
      const verdictOutcome = await store.update(batch.id, current => {
        const result = verifyAttempt(current, 'a:price', verdictRead);
        finishIfComplete(current);
        return { result, batch: current };
      });
      assert.equal(verdictOutcome.result.outcome, 'confirmed');
      // 撤回
      const undoRead = await observe(session.page, 'undo');
      const planned = (await store.update(batch.id, current => ({ result: planUndo(current, undoRead), batch: current }))).result;
      assert.equal(planned[0].outcome, 'pending-restore');
      const [rowId, column] = planned[0].key.split(':');
      const restore = await editCell(session.page, { id: rowId, column, value: planned[0].baseline });
      assert.notEqual(restore.outcome, 'unconfirmed');
      await store.update(batch.id, current => { applyUndoResult(current, planned.map(cell => ({ ...cell, result: { status: 'restored' } }))); return current; });
      const finalState = await snapshot(source);
      const row = finalState.rows.find(value => value.id === 'a');
      assert.equal(row.price, 12);
      assert.equal(row.total, 24); // 派生值由门户重算，机器人没有写过 total
      const saved = await store.load(batch.id);
      assert.equal(summarize(saved).撤回已恢复, 1);
      assert.ok(!saved.attempts.some(attempt => attempt.key === 'a:total'));
    } finally { await closePage(session); }
  });
});

test('人工插入修改后撤回：冲突项停下不覆盖，其余业务项正常恢复', { timeout: 30000 }, async () => {
  await withEnvironment(async ({ source, store, browser }) => {
    const session = await openPage(browser, source.url);
    try {
      const batch = await store.saveNew(createBatch([
        { id: 'a', column: 'price', value: 30 },
        { id: 'b', column: 'price', value: 9 }
      ], { source: source.url }));
      const initialRead = await observe(session.page, 'baseline');
      await store.update(batch.id, current => { recordRead(current, initialRead); return current; });
      for (const item of [{ id: 'a', column: 'price', value: 30 }, { id: 'b', column: 'price', value: 9 }]) {
        const edit = await editCell(session.page, item);
        assert.equal(edit.outcome, 'confirmed');
        await store.update(batch.id, current => {
          recordAttempt(current, { ...item, fromValue: edit.fromValue, status: ATTEMPT.CONFIRMED, reason: '已确认' });
          return current;
        });
      }
      // 人工通过源端入口修改 a 项（机器人从不使用该入口）
      const human = await fetch(`${source.url}/api/human`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'a', column: 'price', value: 33 })
      });
      assert.equal(human.status, 200);
      const undoRead = await observe(session.page, 'undo');
      const planned = (await store.update(batch.id, current => ({ result: planUndo(current, undoRead), batch: current }))).result;
      const conflict = planned.find(cell => cell.key === 'a:price');
      const restorable = planned.find(cell => cell.key === 'b:price');
      assert.equal(conflict.outcome, 'conflict');
      assert.equal(restorable.outcome, 'pending-restore');
      // 只恢复 b，冲突的 a 完全不写
      const restore = await editCell(session.page, { id: 'b', column: 'price', value: restorable.baseline });
      assert.equal(restore.outcome, 'confirmed');
      await store.update(batch.id, current => { applyUndoResult(current, planned.map(cell =>
        cell.key === 'b:price' ? { ...cell, result: { status: 'restored' } } : cell)); return current; });
      const rows = (await snapshot(source)).rows;
      assert.equal(rows.find(row => row.id === 'a').price, 33); // 人工值保留
      assert.equal(rows.find(row => row.id === 'b').price, 8); // 已恢复
      const saved = await store.load(batch.id);
      assert.equal(saved.state, 'interrupted');
      assert.equal(unconfirmedKeys(saved).length, 0);
      assert.equal(summarize(saved).撤回冲突待人工, 1);
    } finally { await closePage(session); }
  });
});

test('排序与服务端重排后按业务 id 继续执行和撤回，未确认项被跳过', { timeout: 30000 }, async () => {
  await withEnvironment(async ({ source, store, browser }) => {
    const session = await openPage(browser, source.url);
    try {
      const batch = await store.saveNew(createBatch([
        { id: 'a', column: 'price', value: 40 },
        { id: 'b', column: 'quantity', value: 7 }
      ], { source: source.url }));
      const initialRead = await observe(session.page, 'baseline');
      await store.update(batch.id, current => { recordRead(current, initialRead); return current; });
      const first = await editCell(session.page, { id: 'a', column: 'price', value: 40 });
      assert.equal(first.outcome, 'confirmed');
      await store.update(batch.id, current => {
        recordAttempt(current, { id: 'a', column: 'price', value: 40, fromValue: first.fromValue, status: ATTEMPT.CONFIRMED, reason: '已确认' });
        return current;
      });
      // 页面排序，再服务端重排，机器人仍按 id 找到 b
      const orderAfterSort = await sortViaPage(session.page);
      assert.deepEqual(orderAfterSort, ['b', 'a']);
      await action(source, 'reorder');
      await action(source, 'lost-reply');
      const second = await editCell(session.page, { id: 'b', column: 'quantity', value: 7 });
      assert.equal(second.outcome, 'unconfirmed');
      await store.update(batch.id, current => {
        recordAttempt(current, { id: 'b', column: 'quantity', value: 7, fromValue: second.fromValue, status: ATTEMPT.UNCONFIRMED, reason: '回包丢失' });
        return current;
      });
      await action(source, 'normal-reply');
      // 不先核实直接撤回
      const undoRead = await observe(session.page, 'undo');
      const planned = (await store.update(batch.id, current => ({ result: planUndo(current, undoRead), batch: current }))).result;
      assert.equal(planned.find(cell => cell.key === 'a:price').outcome, 'pending-restore');
      assert.equal(planned.find(cell => cell.key === 'b:quantity').outcome, UNDO.SKIPPED);
      // 只恢复已确认的 a；排序状态下仍按 id 定位
      const restoreCell = planned.find(cell => cell.outcome === 'pending-restore');
      const [rowId, column] = restoreCell.key.split(':');
      const restore = await editCell(session.page, { id: rowId, column, value: restoreCell.baseline });
      assert.equal(restore.outcome, 'confirmed');
      await store.update(batch.id, current => { applyUndoResult(current, planned.map(cell =>
        cell.outcome === 'pending-restore' ? { ...cell, result: { status: 'restored' } } : cell)); return current; });
      const rows = (await snapshot(source)).rows;
      assert.equal(rows.find(row => row.id === 'a').price, 12);
      assert.equal(rows.find(row => row.id === 'b').quantity, 7); // 未确认写入实际落地但撤回跳过，保留待人工
      // 重复撤回幂等
      const againRead = await observe(session.page, 'undo');
      const again = (await store.update(batch.id, current => ({ result: planUndo(current, againRead), batch: current }))).result;
      assert.equal(again.find(cell => cell.key === 'a:price').outcome, UNDO.NOOP);
    } finally { await closePage(session); }
  });
});

test('恢复写回前检测到新插入的人工修改时该单元格报冲突且不写', { timeout: 30000 }, async () => {
  await withEnvironment(async ({ source, store, browser }) => {
    const session = await openPage(browser, source.url);
    try {
      const batch = await store.saveNew(createBatch([{ id: 'a', column: 'price', value: 30 }], { source: source.url }));
      const initialRead = await observe(session.page, 'baseline');
      await store.update(batch.id, current => { recordRead(current, initialRead); return current; });
      const edit = await editCell(session.page, { id: 'a', column: 'price', value: 30 });
      await store.update(batch.id, current => {
        recordAttempt(current, { id: 'a', column: 'price', value: 30, fromValue: edit.fromValue, status: ATTEMPT.CONFIRMED, reason: '已确认' });
        return current;
      });
      const undoRead = await observe(session.page, 'undo');
      const planned = (await store.update(batch.id, current => ({ result: planUndo(current, undoRead), batch: current }))).result;
      // 分类之后、写回之前插入人工修改
      await fetch(`${source.url}/api/human`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'a', column: 'price', value: 55 })
      });
      const fresh = await observe(session.page, 'undo');
      const cell = planned[0];
      const [cellId, cellColumn] = cell.key.split(':');
      const freshValue = fresh.rows.find(row => row.id === cellId)[cellColumn];
      assert.notEqual(freshValue, cell.written);
      await store.update(batch.id, current => { applyUndoResult(current,
        [{ ...cell, outcome: UNDO.CONFLICT, reason: '恢复写回前发现单元格已被其他人修改', current: freshValue }]); return current; });
      assert.equal((await snapshot(source)).rows.find(row => row.id === 'a').price, 55);
      const saved = await store.load(batch.id);
      assert.equal(saved.undo.cells[0].outcome, UNDO.CONFLICT);
    } finally { await closePage(session); }
  });
});
