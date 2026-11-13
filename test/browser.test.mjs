import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {startSource} from '../src/source.mjs';
test('真实浏览器呈现及操作保留源端特殊情形',{timeout:20000},async()=>{
 const source=await startSource();const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 const action=async action=>{const response=await fetch(source.url+'/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});assert.equal(response.status,200);return response.json();};
 try{await page.goto(source.url);await page.waitForFunction(()=>window.portalReady);await action('lost-reply');
const input=page.locator('tr[data-id=a] input[data-column=price]');await input.fill('14');await input.press('Tab');
await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='确认丢失');
const current=await(await fetch(source.url+'/api/snapshot')).json();
assert.equal(current.rows.find(row=>row.id==='a').price,14);
assert.equal(current.rows.find(row=>row.id==='a').total,28);
await page.click('#sort');assert.equal(await page.locator('tr').first().getAttribute('data-id'),'b');}
 finally{await browser.close();await source.close();}
});
