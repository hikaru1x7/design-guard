import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { withChrome } from '../lib/chrome-automation.mjs';
import { dayId, saveSession } from '../lib/session-maintenance.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-automation-test-'));
  const previous = process.env.CSS_GUARD_HOME;
  process.env.CSS_GUARD_HOME = home;
  await saveSession(dayId(), { status: 'current' }, home);
  t.after(async () => { if (previous === undefined) delete process.env.CSS_GUARD_HOME; else process.env.CSS_GUARD_HOME = previous; await fs.rm(home, { recursive: true, force: true }); });
}

test('Chrome automation preserves actual high-DPI pixels, transparency and resizing', async t => {
  await fixture(t);
  await withChrome(async browser => {
    const page = await browser.newPage({ viewport: { width: 320, height: 200 }, deviceScaleFactor: 8 });
    await page.setContent('<style>html,body{margin:0;background:transparent}input{box-sizing:border-box;width:100px;height:20px}</style><input placeholder="Test">');
    assert.equal(await page.evaluate(() => devicePixelRatio), 8);
    const element = await page.$('input');
    assert.deepEqual(await element.boundingBox(), { x: 0, y: 0, width: 100, height: 20 });
    const shot = PNG.sync.read(await element.screenshot());
    assert.deepEqual([shot.width, shot.height], [800, 160]);
    await page.setViewportSize({ width: 120, height: 80 });
    const resized = PNG.sync.read(await page.screenshot({ omitBackground: true }));
    assert.deepEqual([resized.width, resized.height], [960, 640]);
    assert.equal(resized.data.at(-1), 0);
  });
});

test('Chrome automation fulfills saved pages, evaluates frames and propagates interception errors', async t => {
  await fixture(t);
  await withChrome(async browser => {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ body: '<h1>Saved fixture</h1>' }));
    const response = await page.goto('https://fixture.invalid/search');
    assert.equal(response.status(), 200);
    assert.equal(await page.locator('h1').evaluate(node => node.textContent), 'Saved fixture');
    await page.close();
    const frame = await browser.newPage();
    await frame.setContent('<iframe srcdoc="<h1>Child frame</h1>"></iframe>');
    assert.equal(await frame.evaluateFrame('iframe', () => document.querySelector('h1').textContent), 'Child frame');
    await frame.close();
    const broken = await browser.newPage();
    await broken.route('**/*', () => { throw new Error('fixture interception failed'); });
    await assert.rejects(broken.goto('https://fixture.invalid/blocked'), /fixture interception failed/);
  });
});

test('DOMContentLoaded does not wait for a pending image, while load does', async t => {
  await fixture(t);
  const http = await import('node:http');
  let pending;
  const server = http.createServer((request, response) => {
    if (request.url === '/pending.svg') { pending = response; return; }
    response.writeHead(200, { 'content-type': 'text/html' }).end('<img src="/pending.svg"><h1>DOM ready</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  try {
    await withChrome(async browser => {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded', timeout: 5000 });
      assert.equal(await page.evaluate(() => document.readyState), 'interactive');
      assert.ok(pending);
      pending.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      await page.waitForLoadState('load');
      assert.equal(await page.evaluate(() => document.readyState), 'complete');
    });
  } finally { pending?.end(); }
});
