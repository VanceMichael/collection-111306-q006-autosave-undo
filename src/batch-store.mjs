// 批次持久化：每个批次一个带 sha256 校验和的文件，tmp + rename 原子替换。
// 跨进程互斥用 mkdir 锁（POSIX 原子），保证 CLI、控制台、演示脚本不会互相覆盖批次状态。
import { mkdir, readFile, rename, open, rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function checksum(text) { return createHash('sha256').update(text).digest('hex'); }

async function acquireLock(directory, batchId, timeoutMs = 5000) {
  const lock = join(directory, `${batchId}.lock`);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started > timeoutMs) throw new Error(`批次 ${batchId} 正在被其他进程占用`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
}

export class BatchStore {
  constructor(directory) {
    this.directory = directory;
  }

  fileFor(batchId) { return join(this.directory, `${batchId}.json`); }

  async list() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory);
    return entries.filter(name => name.endsWith('.json')).sort();
  }

  async load(batchId) {
    let text;
    try { text = await readFile(this.fileFor(batchId), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const envelope = JSON.parse(text);
    if (checksum(envelope.body) !== envelope.checksum) throw new Error(`批次 ${batchId} 文件校验失败`);
    return JSON.parse(envelope.body);
  }

  // 在锁内读取-修改-写回；mutator 返回完整批次对象，或 { result, batch } 包装。
  async update(batchId, mutator) {
    await mkdir(this.directory, { recursive: true });
    const lock = await acquireLock(this.directory, batchId);
    try {
      const batch = await this.load(batchId);
      if (!batch) throw new Error(`批次不存在：${batchId}`);
      const returned = await mutator(structuredClone(batch));
      const next = returned && returned.batch && Array.isArray(returned.batch.attempts) ? returned.batch : returned;
      if (!next || !Array.isArray(next.plan) || !Array.isArray(next.attempts) || next.id !== batchId) {
        throw new Error('批次更新必须返回完整的批次对象，不能返回结论片段');
      }
      await this.persist(next);
      return returned;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async saveNew(batch) {
    await mkdir(this.directory, { recursive: true });
    const lock = await acquireLock(this.directory, batch.id);
    try {
      const existing = await this.load(batch.id);
      if (existing) throw new Error(`批次已存在：${batch.id}`);
      await this.persist(batch);
      return batch;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async persist(batch) {
    const body = JSON.stringify(batch);
    const temporary = join(this.directory, `${batch.id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ checksum: checksum(body), body }));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, this.fileFor(batch.id));
  }
}
