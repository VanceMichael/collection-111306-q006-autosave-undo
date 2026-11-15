import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchStore } from '../src/batch-store.mjs';
import { createBatch } from '../src/batch.mjs';

async function tempStore() {
  const root = await mkdtemp(join(tmpdir(), 'batch-store-'));
  return { root, store: new BatchStore(join(root, 'batches')) };
}

test('批次保存后可在新实例中读回，带校验和防篡改', async () => {
  const { root, store } = await tempStore();
  try {
    const batch = createBatch([{ id: 'a', column: 'price', value: 1 }]);
    await store.saveNew(batch);
    const reopened = await new BatchStore(join(root, 'batches')).load(batch.id);
    assert.equal(reopened.id, batch.id);
    assert.deepEqual(reopened.plan, batch.plan);
    const files = await store.list();
    assert.equal(files.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('批次文件损坏时报校验失败而不是返回伪造数据', async () => {
  const { root, store } = await tempStore();
  try {
    const batch = createBatch([{ id: 'a', column: 'price', value: 1 }]);
    await store.saveNew(batch);
    const file = store.fileFor(batch.id);
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.checksum = '0'.repeat(64);
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(store.load(batch.id), /校验/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('锁内更新串行化并发修改，更新不会互相覆盖', async () => {
  const { root, store } = await tempStore();
  try {
    const batch = await store.saveNew(createBatch([{ id: 'a', column: 'price', value: 1 }]));
    await Promise.all([
      store.update(batch.id, current => { current.state = 'finished'; return current; }),
      store.update(batch.id, current => { current.updatedAt = '2026-01-01T00:00:00.000Z'; return current; })
    ]);
    const finalBatch = await store.load(batch.id);
    assert.equal(finalBatch.state, 'finished');
    assert.equal(finalBatch.updatedAt, '2026-01-01T00:00:00.000Z');
    // 锁已释放
    assert.deepEqual((await readdir(join(root, 'batches'))).filter(name => name.endsWith('.lock')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('批次 id 重复不能覆盖既有批次', async () => {
  const { root, store } = await tempStore();
  try {
    const first = createBatch([{ id: 'a', column: 'price', value: 1 }], { id: 'dup' });
    const second = createBatch([{ id: 'b', column: 'price', value: 2 }], { id: 'dup' });
    await store.saveNew(first);
    await assert.rejects(store.saveNew(second), /已存在/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
