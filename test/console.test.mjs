import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startSource } from '../src/source.mjs';
import { startConsole } from '../src/console.mjs';

async function action(source, name) {
  await fetch(`${source.url}/api/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: name })
  });
}

test('批次管理台在浏览器中提供执行、恢复、撤回入口并展示冲突', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'console-e2e-'));
  process.env.BATCH_DIR = join(root, 'batches');
  const source = await startSource();
  const consoleServer = await startConsole({ sourceUrl: source.url });
  const browser = await chromium.launch({ headless: true });
  try {
    // API 层：回包丢失 -> 恢复核实 -> 撤回 的完整链路
    await action(source, 'reset');
    await action(source, 'lost-reply');
    const run = await fetch(`${consoleServer.url}/api/batches/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: [{ id: 'a', column: 'price', value: 20 }] })
    }).then(response => response.json());
    assert.deepEqual(run.中断项, ['a:price']);
    assert.equal(run.汇总.未确认写入, 1);
    await action(source, 'normal-reply');
    const recovered = await fetch(`${consoleServer.url}/api/batches/recover`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: run.批次 })
    }).then(response => response.json());
    assert.equal(recovered.核实[0].核实结论, 'confirmed');
    const undone = await fetch(`${consoleServer.url}/api/batches/undo`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: run.批次 })
    }).then(response => response.json());
    assert.equal(undone.撤回明细[0].结论, 'restored');

    // UI 层：页面可打开、列表展示批次、按钮齐全，且原门户预览链接可用
    const page = await browser.newPage();
    await page.goto(consoleServer.url);
    await page.waitForSelector('#batch-rows tr');
    const rowCount = await page.locator('#batch-rows tr').count();
    assert.ok(rowCount >= 1);
    assert.equal(await page.locator('#btn-run').count(), 1);
    assert.equal(await page.locator('#batch-rows button', { hasText: '撤回' }).first().textContent(), '撤回');
    const portalHref = await page.locator('#portal-link').getAttribute('href');
    assert.equal(portalHref, source.url);
    await page.goto(source.url);
    await page.waitForFunction(() => window.portalReady === true);
    assert.equal(await page.locator('#rows tr').count(), 2); // 原门户预览保持可用
    await page.close();
  } finally {
    await browser.close();
    await consoleServer.close();
    await source.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.BATCH_DIR;
  }
});
