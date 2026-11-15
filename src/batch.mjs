// 可撤销录入批次的纯领域逻辑：不做任何 I/O，所有判断按业务单元格标识（rowId:column）关联，
// 不依赖页面行位置。排序改变后，同一业务项仍然指向同一个 cell 标识。
import { randomUUID } from 'node:crypto';

export const WRITABLE_COLUMNS = ['price', 'quantity'];
// total 是门户根据 price*quantity 计算出的派生值，机器人永远不主动写它。
export const DERIVED_COLUMN = 'total';

export const ATTEMPT = Object.freeze({
  CONFIRMED: 'confirmed', // 已收到成功回包或经回读核实
  UNCONFIRMED: 'unconfirmed', // 发出后确认回包丢失，不能当作成功也不能当作失败
  FAILED: 'failed' // 确认没有落地的写入
});

export const UNDO = Object.freeze({
  RESTORED: 'restored', // 已恢复为批次前读到的原值
  CONFLICT: 'conflict', // 撤回时发现别人后来改过，停下交人工决定，不覆盖
  SKIPPED: 'skipped', // 无需恢复（未确认 / 失败 / 已是原值）
  NOOP: 'noop' // 上次已恢复，重复撤回不二次写入
});

export function cellKey(rowId, column) {
  if (!WRITABLE_COLUMNS.includes(column) && column !== DERIVED_COLUMN) throw new Error('未知单元格');
  return `${rowId}:${column}`;
}

function nowIso() { return new Date().toISOString(); }

// 计划项是业务项层面的目标值，与行位置无关。
export function normalizePlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) throw new Error('批次计划至少包含一个计价项');
  return plan.map(item => {
    if (!item || typeof item.id !== 'string' || !WRITABLE_COLUMNS.includes(item.column)) {
      throw new Error('计划项必须包含业务 id 与可写列 price/quantity');
    }
    if (!Number.isFinite(item.value)) throw new Error(`计划项 ${item.id}:${item.column} 缺少有效数值`);
    return { id: item.id, column: item.column, value: item.value };
  });
}

export function createBatch(plan, { id = randomUUID(), at = nowIso(), source = null } = {}) {
  return {
    id,
    source, // 该批次操作的门户地址，恢复与撤回时必须回到同一门户
    createdAt: at,
    updatedAt: at,
    plan: normalizePlan(plan),
    state: 'open', // open（可继续）/ interrupted（存在未确认写入，等待核实）/ undone / finished
    // 批次开始前确实读到过的值；没有读过的单元格不会有基线，撤回时按未读处理
    baseline: {},
    // 每次写入尝试，按业务单元格归集；同一单元格多次尝试保留完整历史
    attempts: [],
    // 门户计算出的派生值回读记录（total），仅审计，绝不作为主动写入
    derived: {},
    // 历次观察到的服务端 revision，用于判断观察之间是否有其他人的写入
    reads: [],
    undo: { done: false, at: null, cells: [] }
  };
}

// 记录一次真实观察。read: { revision, rows: [{id, price, quantity, total}], at, origin, ignoreExternal }
// origin: baseline（开始前读）/ verify（未确认核实）/ undo（撤回前核对）/ refresh（运行中刷新）
// ignoreExternal: 本次观察中不参与“外部修改”判定的业务单元格（如未确认写入的核实对象）
export function recordRead(batch, read) {
  const at = read.at ?? nowIso();
  const previousRevision = batch.reads.length ? batch.reads[batch.reads.length - 1].revision : null;
  const observed = {};
  for (const row of read.rows) {
    for (const column of [...WRITABLE_COLUMNS, DERIVED_COLUMN]) {
      observed[cellKey(row.id, column)] = row[column];
    }
  }
  const ignored = new Set(read.ignoreExternal ?? []);
  const entry = { revision: read.revision, at, origin: read.origin ?? 'refresh', observed };
  batch.reads.push(entry);
  // 开始前的观察建立基线；只记录“确实读到过”的值，后续观察不覆盖基线
  if (read.origin === 'baseline') {
    for (const [key, value] of Object.entries(observed)) {
      if (!(key in batch.baseline)) batch.baseline[key] = value;
    }
  }
  // 派生值单独留痕，便于说明 total 是门户算出来的而不是机器人写的
  for (const row of read.rows) {
    batch.derived[cellKey(row.id, DERIVED_COLUMN)] = {
      value: row.total,
      revision: read.revision,
      at
    };
  }
  // 与上一次观察之间出现的、且不能归因于本批次已确认写入的值变化，标记为外部修改
  if (previousRevision !== null && read.revision > previousRevision) {
    const last = batch.reads[batch.reads.length - 2];
    for (const [key, value] of Object.entries(observed)) {
      if (key.endsWith(`:${DERIVED_COLUMN}`) || ignored.has(key)) continue;
      if (last.observed[key] === value) continue;
      const mine = latestAttempt(batch, key);
      // 本批次最近一次写入目标值就是现值，则归因于本批次（回包内的 revision 归 CLI 另行登记）
      const attributedToMe = mine && mine.status === ATTEMPT.CONFIRMED && mine.value === value;
      if (!attributedToMe) entry.externalChanges = { ...(entry.externalChanges ?? {}), [key]: { from: last.observed[key], to: value } };
    }
  }
  batch.updatedAt = at;
  return entry;
}

export function latestAttempt(batch, key) {
  for (let index = batch.attempts.length - 1; index >= 0; index--) {
    if (batch.attempts[index].key === key) return batch.attempts[index];
  }
  return null;
}

// 记录一次通过页面发起的写入尝试。
export function recordAttempt(batch, { id, column, value, fromValue, status, at = nowIso(), reason = null }) {
  const key = cellKey(id, column);
  const attempt = {
    key, id, column, value, fromValue: fromValue ?? null,
    status, reason, at,
    confirmedRevision: null,
    verifiedAt: null
  };
  batch.attempts.push(attempt);
  if (status === ATTEMPT.UNCONFIRMED) batch.state = 'interrupted';
  batch.updatedAt = at;
  return attempt;
}

// 对未确认写入做回读核实：以页面重新观察到的服务端值为准。
// 返回核实结论；外部修改优先标注冲突，绝不把别人的值冒充成自己的写入结果。
export function verifyAttempt(batch, key, read) {
  const attempt = latestAttempt(batch, key);
  if (!attempt) throw new Error(`没有待核实的写入：${key}`);
  // 核实对象本身的变化由本函数按回读值判定，不走通用的“外部修改”归因
  const entry = recordRead(batch, { ...read, ignoreExternal: [key] });
  const observedValue = entry.observed[key];
  const previous = batch.reads.length > 1 ? batch.reads[batch.reads.length - 2].observed[key] : undefined;
  if (attempt.status !== ATTEMPT.UNCONFIRMED && attempt.status !== ATTEMPT.FAILED) {
    return { key, outcome: 'unchanged', attempt };
  }
  if (observedValue === attempt.value) {
    if (attempt.status === ATTEMPT.UNCONFIRMED) attempt.initialReason = attempt.reason;
    attempt.status = ATTEMPT.CONFIRMED;
    attempt.reason = '确认回包丢失，经回读核实实际已保存';
    attempt.confirmedRevision = read.revision;
    attempt.verifiedAt = entry.at;
    delete attempt.conflict;
    if (!batch.attempts.some(candidate => candidate.status === ATTEMPT.UNCONFIRMED)) batch.state = 'open';
    return { key, outcome: 'confirmed', attempt, observed: observedValue };
  }
  if (observedValue === attempt.fromValue || (previous !== undefined && observedValue === previous)) {
    if (attempt.status === ATTEMPT.UNCONFIRMED) attempt.initialReason = attempt.reason;
    attempt.status = ATTEMPT.FAILED;
    attempt.reason = '回读值仍为写入前的值，该写入未落地';
    if (!batch.attempts.some(candidate => candidate.status === ATTEMPT.UNCONFIRMED)) batch.state = 'open';
    return { key, outcome: 'failed', attempt, observed: observedValue };
  }
  // 值既不是我写的、也不是原值：只能交人工，不能猜
  attempt.status = ATTEMPT.UNCONFIRMED;
  attempt.reason = '回读值与写入值和原值均不一致，需人工决定';
  attempt.conflict = { observed: observedValue, expected: attempt.value, at: entry.at };
  batch.state = 'interrupted';
  return { key, outcome: 'conflict', attempt, observed: observedValue };
}

// 撤回前逐个业务单元格分类。派生列不在撤回计划内（门户会随可写列重算）。
// 这里的回读只用于本次分类，不写入 reads 观察日志——否则会改变后续核实
// 所依赖的“上一次观察”；撤回前后的完整观察由调用方另行登记。
export function planUndo(batch, read) {
  const observed = {};
  for (const row of read.rows) {
    for (const column of [...WRITABLE_COLUMNS, DERIVED_COLUMN]) {
      observed[cellKey(row.id, column)] = row[column];
    }
  }
  const keys = new Set(batch.attempts.map(attempt => attempt.key));
  const cells = [];
  for (const key of keys) {
    const attempt = latestAttempt(batch, key);
    const current = observed[key];
    // 已经恢复过：重复撤回是 no-op，不产生第二次写入
    const prior = batch.undo.cells.find(cell => cell.key === key);
    if (prior && prior.outcome === UNDO.RESTORED) {
      cells.push({ key, outcome: UNDO.NOOP, reason: '上一次撤回已恢复，不二次覆盖' });
      continue;
    }
    if (attempt.status !== ATTEMPT.CONFIRMED) {
      cells.push({ key, outcome: UNDO.SKIPPED, reason: `写入状态为 ${attempt.status}，没有已确认落地的值可恢复` });
      continue;
    }
    if (!(key in batch.baseline)) {
      cells.push({ key, outcome: UNDO.CONFLICT, reason: '批次开始前未确实读到该单元格原值，无法安全恢复', current });
      continue;
    }
    const baseline = batch.baseline[key];
    if (current === baseline) {
      cells.push({ key, outcome: UNDO.NOOP, reason: '当前值已是批次前原值', current });
      continue;
    }
    if (current !== attempt.value) {
      // 当前值既不是我写进去的值，也不是原值：别人后来改过
      cells.push({
        key, outcome: UNDO.CONFLICT,
        reason: '撤回核对发现其他人后来修改过该单元格，停止覆盖并交人工决定',
        baseline, written: attempt.value, current
      });
      continue;
    }
    cells.push({ key, outcome: 'pending-restore', baseline, current, written: attempt.value });
  }
  return cells;
}

// 机器人对 pending-restore 单元格逐个执行恢复写回后，登记结果。
// result: { key, status: 'restored'|'conflict'|'failed', detail }
export function applyUndoResult(batch, cells, at = nowIso()) {
  const finalized = cells.map(cell => {
    if (cell.outcome !== 'pending-restore') return cell;
    if (cell.result?.status === 'restored') {
      return { ...cell, outcome: UNDO.RESTORED, restoredTo: cell.baseline, at, detail: cell.result.detail ?? null };
    }
    if (cell.result?.status === 'conflict') {
      return { ...cell, outcome: UNDO.CONFLICT, at, detail: cell.result.detail ?? '恢复写回时发现冲突' };
    }
    return { ...cell, outcome: UNDO.SKIPPED, at, detail: cell.result?.detail ?? '恢复写回未确认，留待人工' };
  });
  for (const cell of finalized) {
    const index = batch.undo.cells.findIndex(existing => existing.key === cell.key);
    if (index >= 0) batch.undo.cells[index] = cell;
    else batch.undo.cells.push(cell);
  }
  batch.undo.done = true;
  batch.undo.at = at;
  batch.state = finalized.some(cell => cell.outcome === UNDO.CONFLICT) ? 'interrupted' : 'undone';
  batch.updatedAt = at;
  return finalized;
}

// 面向用户与演示的中文汇总：明确哪些恢复、哪些要人工、哪些未确认。
export function summarize(batch) {
  const attemptsByKey = new Map();
  for (const attempt of batch.attempts) {
    if (!attemptsByKey.has(attempt.key)) attemptsByKey.set(attempt.key, []);
    attemptsByKey.get(attempt.key).push(attempt);
  }
  const items = [...attemptsByKey.entries()].map(([key, history]) => {
    const latest = history[history.length - 1];
    return {
      单元格: key,
      目标值: latest.value,
      基线值: batch.baseline[key] ?? null,
      写入状态: latest.status,
      状态说明: latest.reason,
      最新派生total: batch.derived[`${latest.id}:${DERIVED_COLUMN}`]?.value ?? null,
      撤回结论: batch.undo.cells.find(cell => cell.key === key)?.outcome ?? null,
      撤回说明: batch.undo.cells.find(cell => cell.key === key)?.reason ?? null,
      冲突详情: latest.conflict ?? batch.undo.cells.find(cell => cell.key === key)?.current ?? null
    };
  });
  const undoCells = batch.undo.cells;
  return {
    批次: batch.id,
    批次状态: batch.state,
    计划项数: batch.plan.length,
    已确认写入: batch.attempts.filter(a => a.status === ATTEMPT.CONFIRMED).length,
    未确认写入: batch.attempts.filter(a => a.status === ATTEMPT.UNCONFIRMED).length,
    确认失败: batch.attempts.filter(a => a.status === ATTEMPT.FAILED).length,
    撤回已恢复: undoCells.filter(c => c.outcome === UNDO.RESTORED).length,
    撤回冲突待人工: undoCells.filter(c => c.outcome === UNDO.CONFLICT).length,
    撤回跳过: undoCells.filter(c => c.outcome === UNDO.SKIPPED || c.outcome === UNDO.NOOP).length,
    明细: items
  };
}

export function openQuestions(batch) {
  const questions = [];
  for (const attempt of batch.attempts) {
    if (attempt.status === ATTEMPT.UNCONFIRMED) {
      questions.push({ 单元格: attempt.key, 问题: attempt.reason ?? '写入确认回包丢失，等待回读核实或人工决定' });
    }
  }
  for (const cell of batch.undo.cells) {
    if (cell.outcome === UNDO.CONFLICT) questions.push({ 单元格: cell.key, 问题: cell.reason });
  }
  return questions;
}

// 计划中每个业务单元格当前执行到哪一步，用于断点恢复与“继续已执行部分”。
export function planProgress(batch) {
  const target = batch.plan.map(item => ({ ...item, key: cellKey(item.id, item.column) }));
  return target.map(item => {
    const attempt = latestAttempt(batch, item.key);
    let phase = 'pending';
    if (attempt) {
      if (attempt.status === ATTEMPT.CONFIRMED) phase = 'done';
      else if (attempt.status === ATTEMPT.FAILED) phase = 'failed';
      else phase = 'unconfirmed';
    }
    return { ...item, phase };
  });
}

export function pendingPlanItems(batch) {
  return planProgress(batch).filter(item => item.phase === 'pending' || item.phase === 'failed');
}

export function unconfirmedKeys(batch) {
  const keys = new Set();
  for (const attempt of batch.attempts) {
    if (attempt.status === ATTEMPT.UNCONFIRMED) keys.add(attempt.key);
  }
  return [...keys];
}

export function finishIfComplete(batch, at = nowIso()) {
  if (batch.undo.done) return batch;
  if (batch.attempts.some(attempt => attempt.status === ATTEMPT.UNCONFIRMED)) return batch;
  const allDone = pendingPlanItems(batch).length === 0;
  if (allDone) {
    batch.state = 'finished';
    batch.updatedAt = at;
  }
  return batch;
}

export function batchFromEnvelope(envelope) {
  // 从持久化文件读出的普通对象恢复为可用批次；当前无方法状态，做结构校验即可。
  if (!envelope || !Array.isArray(envelope.plan) || !Array.isArray(envelope.attempts)) {
    throw new Error('批次文件结构不完整');
  }
  return envelope;
}
