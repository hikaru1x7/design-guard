import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withBrowser, preparePage, settle, renderedScreenshot } from '../lib/browser.mjs';
import { installedVersions } from '../lib/maintenance.mjs';

test('Chrome sends real input, waits for enabled controls, captures PNG and uses an isolated profile', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-browser-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await withBrowser(async browser => {
    const page = await preparePage(browser, 375, {});
    try {
      await settle(page, `data:text/html,${encodeURIComponent('<input id="input" value="old"><div id="edit" contenteditable>Old</div><button id="button">Click</button>')}`);
      await page.evaluate(() => {
        window.events = [];
        for (const type of ['click', 'input', 'mouseover']) document.addEventListener(type, e => window.events.push({ type, trusted: e.isTrusted }));
        document.querySelector('#button').disabled = true;
        setTimeout(() => { document.querySelector('#button').disabled = false; }, 200);
      });
      await page.click('#button');
      await page.fill('#input', 'replacement');
      assert.equal(await page.evaluate(() => document.querySelector('#input').value), 'replacement');
      await page.fill('#input', '');
      assert.equal(await page.evaluate(() => document.querySelector('#input').value), '');
      await page.fill('#edit', 'New content');
      assert.equal(await page.evaluate(() => document.querySelector('#edit').textContent), 'New content');
      await page.hover('#button');
      const events = await page.evaluate(() => window.events);
      for (const type of ['click', 'input', 'mouseover']) assert.ok(events.some(e => e.type === type && e.trusted), type);
      assert.equal(await page.evaluate(() => devicePixelRatio), 1);
      await renderedScreenshot(page, path.join(root, 'screen.png'));
      assert.equal((await fs.readFile(path.join(root, 'screen.png'))).subarray(1, 4).toString(), 'PNG');
      assert.equal((await installedVersions()).backend, 'chrome-devtools');
    } finally { await page.close(); }
  }, { roots: [root] });
});
