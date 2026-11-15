#!/usr/bin/env node
// 可撤销录入批次的命令行入口：执行、恢复、撤回、状态、排序。
// 批次状态落在 var/batches（可用 BATCH_DIR 覆盖），进程退出后仍可恢复或撤回。
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { startSource } from './source.mjs';
import { BatchStore } from './batch-store.mjs';
import {
  ATTEMPT, UNDO, createBatch, recordRead, recordAttempt, verifyAttempt,
  planUndo, applyUndoResult, summarize, openQuestions,
  pendingPlanItems, unconfirmedKeys, planProgress, finishIfComplete, cellKey
} from './batch.mjs';
import { launchBrowser, openPage, closePage, observe, editCell, sortViaPage } from './robot.mjs';

const BATCH_DIR = process.env.BATCH_DIR ?? 'var/batches';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token.startsWith('--')) {
      if (token.includes('=')) {
        const [key, value] = token.slice(2).split('=');
        flags[key] = value;
      } else {
        const key = token.slice(2);
        // 布尔标志（如 --continue）后面不接值；其余标志取下一个 token 作为值
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) flags[key] = true;
        else { flags[key] = next; index++; }
      }
    } else positional.push(token);
  }
  return { positional, flags };
}

async function loadPlan(flag) {
  if (!flag) throw new Error('需要 --plan=<json字符串或文件路径>');
  if (isAbsolute(flag) || flag.endsWith('.json')) {
    return JSON.parse(await readFile(resolve(flag), 'utf8'));
  }
  return JSON.parse(flag);
}

async function withPortal(sourceUrl, work) {
  const owned = sourceUrl ? null : await startSource();
  const url = sourceUrl ?? owned.url;
  const browser = await launchBrowser();
  try {
    const session = await openPage(browser, url);
    try { return await work(session, url); }
    finally { await closePage(session); }
  } finally {
    await browser.close();
    if (owned) await owned.close();
  }
}

function print(result, code = 0) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = code;
}

// run：新建批次或继续既有批次；遇到未确认写入立即停下，不把它当成功或失败。
async function run(flags) {
  const store = new BatchStore(resolve(BATCH_DIR));
  let batchId = flags.batch ?? null;
  const portal = flags.source ?? null;
  await withPortal(portal, async (session, url) => {
    let batch;
    if (batchId) {
      batch = await store.load(batchId);
      if (!batch) throw new Error(`批次不存在：${batchId}`);
      if (batch.source && url !== batch.source) {
        throw new Error(`该批次属于门户 ${batch.source}，不能对 ${url} 操作`);
      }
    } else {
      const plan = await loadPlan(flags.plan);
      batch = await store.saveNew(createBatch(plan, { source: url }));
      batchId = batch.id;
    }
    // 开始/继续前先回读建立或补充基线：只记录确实读到的值
    const baselineRead = await observe(session.page, 'baseline');
    await store.update(batchId, current => { recordRead(current, baselineRead); return current; });
    batch = await store.load(batchId);

    const items = pendingPlanItems(batch);
    const interruptedAt = [];
    for (const item of items) {
      const edit = await editCell(session.page, item);
      const saved = await store.update(batchId, current => {
        if (edit.outcome === 'confirmed' || edit.outcome === 'unchanged') {
          recordAttempt(current, {
            id: item.id, column: item.column, value: item.value,
            fromValue: edit.fromValue, status: ATTEMPT.CONFIRMED,
            reason: edit.outcome === 'unchanged' ? '当前值已是目标值，无需写入' : '收到自动保存成功回包'
          });
        } else {
          recordAttempt(current, {
            id: item.id, column: item.column, value: item.value,
            fromValue: edit.fromValue, status: ATTEMPT.UNCONFIRMED,
            reason: '自动保存确认回包丢失，实际是否落地未知'
          });
        }
        finishIfComplete(current);
        return current;
      });
      const latest = saved.attempts[saved.attempts.length - 1];
      if (latest.status === ATTEMPT.UNCONFIRMED) {
        interruptedAt.push(item);
        break;
      }
      // 成功后再回读一次，登记门户计算出的派生 total（只读不写）
      const after = await observe(session.page, 'refresh');
      await store.update(batchId, current => { recordRead(current, after); return current; });
    }
    const finalBatch = await store.load(batchId);
    print({
      动作: 'run', 批次: batchId, 门户: url,
      中断: finalBatch.state === 'interrupted',
      中断项: interruptedAt.map(item => cellKey(item.id, item.column)),
      进度: planProgress(finalBatch).map(item => ({ 单元格: item.key, 阶段: item.phase })),
      待人工问题: openQuestions(finalBatch),
      汇总: summarize(finalBatch)
    }, finalBatch.state === 'interrupted' ? 2 : 0);
  });
}

// recover：对未确认写入逐个重新回读核实；--continue 核实清楚后接着跑完剩余计划。
async function recover(flags) {
  if (!flags.batch) throw new Error('需要 --batch=<批次id>');
  const store = new BatchStore(resolve(BATCH_DIR));
  const existing = await store.load(flags.batch);
  if (!existing) throw new Error(`批次不存在：${flags.batch}`);
  await withPortal(flags.source ?? existing.source, async (session) => {
    let keys = unconfirmedKeys(await store.load(flags.batch));
    const verdicts = [];
    for (const key of keys) {
      const read = await observe(session.page, 'verify');
      const outcome = await store.update(flags.batch, current => {
        const result = verifyAttempt(current, key, read);
        finishIfComplete(current);
        return { result, batch: current };
      });
      verdicts.push({ 单元格: key, 核实结论: outcome.result.outcome, 回读值: outcome.result.observed ?? null });
      if (outcome.result.outcome === 'conflict') break;
      keys = unconfirmedKeys(await store.load(flags.batch));
    }
    let continuation = null;
    if (flags.continue) {
      const current = await store.load(flags.batch);
      const remaining = pendingPlanItems(current);
      const done = [];
      for (const item of remaining) {
        if (current.undo.done) break;
        const edit = await editCell(session.page, item);
        const saved = await store.update(flags.batch, active => {
          recordAttempt(active, {
            id: item.id, column: item.column, value: item.value,
            fromValue: edit.fromValue,
            status: edit.outcome === 'unconfirmed' ? ATTEMPT.UNCONFIRMED : ATTEMPT.CONFIRMED,
            reason: edit.outcome === 'unconfirmed' ? '续跑时确认回包再次丢失' : edit.outcome === 'unchanged' ? '当前值已是目标值' : '续跑写入已确认'
          });
          finishIfComplete(active);
          return active;
        });
        done.push(cellKey(item.id, item.column));
        if (saved.attempts.at(-1).status === ATTEMPT.UNCONFIRMED) break;
        const refresh = await observe(session.page, 'refresh');
        await store.update(flags.batch, active => { recordRead(active, refresh); return active; });
      }
      continuation = done;
    }
    const finalBatch = await store.load(flags.batch);
    print({
      动作: 'recover', 批次: flags.batch,
      核实: verdicts, 续跑项: continuation,
      待人工问题: openQuestions(finalBatch),
      汇总: summarize(finalBatch)
    }, finalBatch.state === 'interrupted' ? 2 : 0);
  });
}

// undo：按业务单元格撤回已确认写入；检测到外部修改即停下标冲突，不覆盖任何人的值。
async function undo(flags) {
  if (!flags.batch) throw new Error('需要 --batch=<批次id>');
  const store = new BatchStore(resolve(BATCH_DIR));
  const existing = await store.load(flags.batch);
  if (!existing) throw new Error(`批次不存在：${flags.batch}`);
  await withPortal(flags.source ?? existing.source, async (session) => {
    const preRead = await observe(session.page, 'undo');
    const planned = (await store.update(flags.batch, current => ({ result: planUndo(current, preRead), batch: current }))).result;
    const results = [];
    for (const cell of planned) {
      if (cell.outcome !== 'pending-restore') {
        results.push({ ...cell });
        continue;
      }
      // 写回前再回读一次，防止在分类之后、写入之前有人插入修改
      const fresh = await observe(session.page, 'undo');
      const [freshId, freshColumn] = cell.key.split(':');
      const currentValue = fresh.rows.find(row => row.id === freshId)[freshColumn];
      if (currentValue !== cell.written) {
        results.push({ ...cell, outcome: UNDO.CONFLICT, reason: '恢复写回前发现单元格已被其他人修改', current: currentValue });
        continue;
      }
      const [id, column] = cell.key.split(':');
      const edit = await editCell(session.page, { id, column, value: cell.baseline });
      if (edit.outcome === 'unconfirmed') {
        results.push({ ...cell, result: { status: 'failed', detail: '恢复写回确认回包丢失，未登记为成功' } });
      } else {
        results.push({ ...cell, result: { status: 'restored', detail: edit.statusText } });
      }
    }
    const finalized = (await store.update(flags.batch, current => ({ result: applyUndoResult(current, results), batch: current }))).result;
    // 撤回后再回读，记录派生 total 的重算结果，说明派生值未被机器人主动写过
    const postRead = await observe(session.page, 'undo');
    await store.update(flags.batch, current => { recordRead(current, postRead); return current; });
    const finalBatch = await store.load(flags.batch);
    print({
      动作: 'undo', 批次: flags.batch,
      撤回明细: finalized.map(cell => ({
        单元格: cell.key, 结论: cell.outcome, 说明: cell.reason ?? cell.detail ?? null,
        基线: cell.baseline ?? null, 本批写入: cell.written ?? null, 撤回前现值: cell.current ?? null
      })),
      待人工问题: openQuestions(finalBatch),
      汇总: summarize(finalBatch)
    }, finalized.some(cell => cell.outcome === UNDO.CONFLICT) ? 2 : 0);
  });
}

async function status(flags) {
  if (!flags.batch) throw new Error('需要 --batch=<批次id>');
  const store = new BatchStore(resolve(BATCH_DIR));
  const batch = await store.load(flags.batch);
  if (!batch) throw new Error(`批次不存在：${flags.batch}`);
  print({ 动作: 'status', 汇总: summarize(batch), 待人工问题: openQuestions(batch), 观察次数: batch.reads.length });
}

async function sortCommand(flags) {
  await withPortal(flags.source ?? null, async (session) => {
    const order = await sortViaPage(session.page);
    print({ 动作: 'sort', 页面行顺序: order });
  });
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];
try {
  if (command === 'run') await run(flags);
  else if (command === 'recover') await recover(flags);
  else if (command === 'undo') await undo(flags);
  else if (command === 'status') await status(flags);
  else if (command === 'sort') await sortCommand(flags);
  else {
    process.stderr.write('用法: batch-cli.mjs <run|recover|undo|status|sort> [--batch=id] [--plan=...] [--source=url] [--continue]\n');
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`批次操作失败: ${error.message}\n`);
  process.exit(1);
}
