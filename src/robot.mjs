// 录入机器人：所有业务操作都走门户的可见页面（填写输入框、Tab 触发 change、点排序按钮），
// 不调用 /api/edit、/api/human 这类源端接口。定位一律用 tr[data-id] 业务标识，
// 页面排序或服务端重排后同一业务项仍能被找到。
import { chromium } from 'playwright';

export async function launchBrowser() {
  return chromium.launch({ headless: true });
}

export async function openPage(browser, portalUrl) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(portalUrl);
  await page.waitForFunction(() => window.portalReady === true);
  return { context, page };
}

// 一次真实回读：重新导航到页面后读取可见表格。返回业务 id 层面的值，行顺序无关。
export async function observe(page, origin = 'refresh') {
  await page.reload();
  await page.waitForFunction(() => window.portalReady === true);
  const snapshot = await page.evaluate(() => ({
    revision: window.portalState.revision,
    rows: [...document.querySelectorAll('#rows tr')].map(element => ({
      id: element.dataset.id,
      price: Number(element.querySelector('[data-column=price]').value),
      quantity: Number(element.querySelector('[data-column=quantity]').value),
      total: Number(element.querySelector('[data-column=total]').textContent)
    }))
  }));
  return { ...snapshot, origin, at: new Date().toISOString() };
}

// 通过页面录入一个计价项。返回状态只区分“已确认 / 确认丢失”，
// 确认丢失既不算成功也不算失败，交给批次层回读核实。
export async function editCell(page, { id, column, value }) {
  const selector = `tr[data-id="${id}"] input[data-column="${column}"]`;
  const input = page.locator(selector);
  const fromValue = Number(await input.inputValue());
  if (fromValue === value) {
    return { outcome: 'unchanged', fromValue, value, revision: null, statusText: await page.locator('#save-status').textContent() };
  }
  await input.fill(String(value));
  await input.press('Tab'); // change 事件触发门户自动保存
  await page.waitForFunction(() => document.querySelector('#save-status').textContent !== '保存中', null, { timeout: 10000 });
  const statusText = (await page.locator('#save-status').textContent()).trim();
  const saved = /^已保存\s+(\d+)$/.exec(statusText);
  if (saved) return { outcome: 'confirmed', fromValue, value, revision: Number(saved[1]), statusText };
  if (statusText === '确认丢失') return { outcome: 'unconfirmed', fromValue, value, revision: null, statusText };
  return { outcome: 'unconfirmed', fromValue, value, revision: null, statusText };
}

// 使用页面自身的排序按钮改变展示顺序（纯界面操作）。
export async function sortViaPage(page) {
  await page.click('#sort');
  await page.waitForFunction(() => window.portalReady === true);
  const order = await page.evaluate(() => [...document.querySelectorAll('#rows tr')].map(element => element.dataset.id));
  return order;
}

export async function closePage({ context }) {
  await context.close();
}
