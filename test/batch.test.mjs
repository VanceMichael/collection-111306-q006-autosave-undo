import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTEMPT, UNDO, createBatch, normalizePlan, recordRead, recordAttempt,
  verifyAttempt, planUndo, applyUndoResult, summarize, openQuestions,
  pendingPlanItems, unconfirmedKeys, planProgress, finishIfComplete, cellKey
} from '../src/batch.mjs';

const baseRows = (overrides = {}) => [
  { id: 'a', price: overrides.aPrice ?? 12, quantity: 2, total: overrides.aTotal ?? 24 },
  { id: 'b', price: 8, quantity: 3, total: 24 }
];

function baseline(rows = baseRows(), revision = 1) {
  return { revision, rows, origin: 'baseline' };
}

test('批次开始前只记录确实读到过的基线值，未读单元格没有基线', () => {
  const batch = createBatch([{ id: 'a', column: 'price', value: 20 }]);
  recordRead(batch, { revision: 1, rows: [{ id: 'a', price: 12, quantity: 2, total: 24 }], origin: 'baseline' });
  assert.equal(batch.baseline['a:price'], 12);
  assert.equal(batch.baseline['b:price'], undefined);
  assert.equal(batch.baseline['a:total'], 24);
});

test('计划校验拒绝派生列与非法数值', () => {
  assert.throws(() => normalizePlan([{ id: 'a', column: 'total', value: 1 }]), /可写列/);
  assert.throws(() => normalizePlan([{ id: 'a', column: 'price', value: NaN }]), /有效数值/);
  assert.throws(() => normalizePlan([]), /至少/);
  assert.equal(cellKey('a', 'price'), 'a:price');
});

test('回包丢失的写入保持未确认，既不算成功也不算失败', () => {
  const batch = createBatch([{ id: 'a', column: 'price', value: 20 }]);
  recordRead(batch, baseline());
  const attempt = recordAttempt(batch, { id: 'a', column: 'price', value: 20, fromValue: 12, status: ATTEMPT.UNCONFIRMED });
  assert.equal(batch.state, 'interrupted');
  assert.equal(attempt.status, 'unconfirmed');
  assert.deepEqual(unconfirmedKeys(batch), ['a:price']);
});

test('未确认写入经回读核实为已落地时转 confirmed 并附 revision', () => {
  const batch = createBatch([{ id: 'a', column: 'price', value: 20 }]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 20, fromValue: 12, status: ATTEMPT.UNCONFIRMED });
  const verdict = verifyAttempt(batch, 'a:price', { revision: 2, rows: baseRows({ aPrice: 20, aTotal: 40 }), origin: 'verify' });
  assert.equal(verdict.outcome, 'confirmed');
  assert.equal(latest(batch, 'a:price').status, ATTEMPT.CONFIRMED);
  assert.equal(latest(batch, 'a:price').confirmedRevision, 2);
  assert.equal(batch.state, 'open');
});

test('回读仍是原值时未确认写入转 failed，而不是猜测成功', () => {
  const batch = createBatch([{ id: 'a', column: 'price', value: 20 }]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 20, fromValue: 12, status: ATTEMPT.UNCONFIRMED });
  const verdict = verifyAttempt(batch, 'a:price', { revision: 2, rows: baseRows(), origin: 'verify' });
  assert.equal(verdict.outcome, 'failed');
  assert.equal(latest(batch, 'a:price').status, ATTEMPT.FAILED);
});

test('回读发现别人改过同一单元格时标冲突，不把别人的值冒充为自己的结果', () => {
  const batch = createBatch([{ id: 'a', column: 'price', value: 20 }]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 20, fromValue: 12, status: ATTEMPT.UNCONFIRMED });
  // revision 增加且值为第三方值，无法归因于本批次
  const verdict = verifyAttempt(batch, 'a:price', { revision: 3, rows: baseRows({ aPrice: 99 }), origin: 'verify' });
  assert.equal(verdict.outcome, 'conflict');
  assert.equal(latest(batch, 'a:price').status, ATTEMPT.UNCONFIRMED);
  assert.ok(latest(batch, 'a:price').conflict);
  assert.deepEqual(openQuestions(batch).map(q => q.单元格), ['a:price']);
});

test('撤回只恢复本批确认写入，外部修改的单元格停下报冲突且不覆盖', () => {
  const batch = createBatch([
    { id: 'a', column: 'price', value: 30 },
    { id: 'b', column: 'price', value: 9 }
  ]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 30, fromValue: 12, status: ATTEMPT.CONFIRMED });
  recordAttempt(batch, { id: 'b', column: 'price', value: 9, fromValue: 8, status: ATTEMPT.CONFIRMED });
  // 撤回前：a 被人工改成 33，b 仍是机器人写的 9
  const planned = planUndo(batch, {
    revision: 4,
    rows: [
      { id: 'a', price: 33, quantity: 2, total: 66 },
      { id: 'b', price: 9, quantity: 3, total: 27 }
    ],
    origin: 'undo'
  });
  const aCell = planned.find(cell => cell.key === 'a:price');
  const bCell = planned.find(cell => cell.key === 'b:price');
  assert.equal(aCell.outcome, 'conflict');
  assert.deepEqual({ baseline: aCell.baseline, written: aCell.written, current: aCell.current }, { baseline: 12, written: 30, current: 33 });
  assert.equal(bCell.outcome, 'pending-restore');
  const finalized = applyUndoResult(batch, planned.map(cell =>
    cell.key === 'b:price' ? { ...cell, result: { status: 'restored' } } : cell));
  assert.equal(finalized.find(c => c.key === 'a:price').outcome, UNDO.CONFLICT);
  assert.equal(finalized.find(c => c.key === 'b:price').outcome, UNDO.RESTORED);
  assert.equal(batch.state, 'interrupted');
});

test('未确认和失败的写入撤回时跳过，不当成功处理', () => {
  const batch = createBatch([
    { id: 'a', column: 'price', value: 30 },
    { id: 'b', column: 'price', value: 9 }
  ]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 30, fromValue: 12, status: ATTEMPT.UNCONFIRMED });
  recordAttempt(batch, { id: 'b', column: 'price', value: 9, fromValue: 8, status: ATTEMPT.FAILED });
  const planned = planUndo(batch, { revision: 2, rows: baseRows(), origin: 'undo' });
  assert.ok(planned.every(cell => cell.outcome === UNDO.SKIPPED));
  assert.ok(planned.every(cell => /没有已确认落地/.test(cell.reason)));
});

test('重复撤回为 noop，不产生第二次写入', () => {
  const batch = createBatch([{ id: 'a', column: 'price', value: 30 }]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 30, fromValue: 12, status: ATTEMPT.CONFIRMED });
  const first = planUndo(batch, { revision: 2, rows: baseRows({ aPrice: 30, aTotal: 60 }), origin: 'undo' });
  applyUndoResult(batch, first.map(cell => ({ ...cell, result: { status: 'restored' } })));
  const second = planUndo(batch, { revision: 3, rows: baseRows(), origin: 'undo' });
  assert.equal(second[0].outcome, UNDO.NOOP);
  assert.match(second[0].reason, /不二次覆盖/);
});

test('派生 total 只登记观察，从不出现在写入计划或撤回目标中', () => {
  const batch = createBatch([{ id: 'a', column: 'price', value: 30 }]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 30, fromValue: 12, status: ATTEMPT.CONFIRMED });
  recordRead(batch, { revision: 2, rows: baseRows({ aPrice: 30, aTotal: 60 }), origin: 'refresh' });
  assert.equal(batch.derived['a:total'].value, 60);
  const planned = planUndo(batch, { revision: 2, rows: baseRows({ aPrice: 30, aTotal: 60 }), origin: 'undo' });
  assert.deepEqual(planned.map(cell => cell.key), ['a:price']);
});

test('计划进度区分 done/unconfirmed/failed/pending，全部完成才 finished', () => {
  const batch = createBatch([
    { id: 'a', column: 'price', value: 30 },
    { id: 'b', column: 'price', value: 9 }
  ]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 30, fromValue: 12, status: ATTEMPT.CONFIRMED });
  assert.deepEqual(planProgress(batch).map(item => item.phase), ['done', 'pending']);
  assert.equal(pendingPlanItems(batch).length, 1);
  assert.equal(batch.state, 'open');
  recordAttempt(batch, { id: 'b', column: 'price', value: 9, fromValue: 8, status: ATTEMPT.CONFIRMED });
  finishIfComplete(batch);
  assert.equal(batch.state, 'finished');
  assert.equal(pendingPlanItems(batch).length, 0);
});

test('观察之间的外部修改被显式记录，本批确认写入不被误报', () => {
  const batch = createBatch([{ id: 'a', column: 'price', value: 20 }]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 20, fromValue: 12, status: ATTEMPT.CONFIRMED });
  // 本批次确认写入导致的 revision 变化：现值等于本批目标值，归因于本批次
  const own = recordRead(batch, { revision: 2, rows: baseRows({ aPrice: 20, aTotal: 40 }), origin: 'refresh' });
  assert.equal(own.externalChanges, undefined);
  const external = recordRead(batch, { revision: 3, rows: baseRows({ aPrice: 77, aTotal: 154 }), origin: 'refresh' });
  assert.deepEqual(external.externalChanges['a:price'], { from: 20, to: 77 });
});

test('汇总明确区分恢复、冲突、跳过与未确认项', () => {
  const batch = createBatch([{ id: 'a', column: 'price', value: 30 }]);
  recordRead(batch, baseline());
  recordAttempt(batch, { id: 'a', column: 'price', value: 30, fromValue: 12, status: ATTEMPT.CONFIRMED });
  const planned = planUndo(batch, { revision: 2, rows: baseRows({ aPrice: 30, aTotal: 60 }), origin: 'undo' });
  applyUndoResult(batch, planned.map(cell => ({ ...cell, result: { status: 'restored' } })));
  const summary = summarize(batch);
  assert.equal(summary.撤回已恢复, 1);
  assert.equal(summary.撤回冲突待人工, 0);
  assert.equal(summary.明细[0].基线值, 12);
});

function latest(batch, key) {
  return batch.attempts.filter(attempt => attempt.key === key).at(-1);
}
