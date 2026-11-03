import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chromeExecutable } from './chrome-runtime.mjs';
import { connectChrome, scriptResult } from './chrome-mcp.mjs';
import { heightFor, runActions, settle, serveStatic } from './browser-common.mjs';

export { installedVersions } from './maintenance.mjs';
export { runActions, settle, serveStatic };
export { heightFor, pathExists } from './browser-common.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Protocol {
  constructor(socket) {
    this.socket = socket; this.seq = 0; this.pending = new Map(); this.events = new EventEmitter();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(`${request.method}: ${message.error.message}`)) : request.resolve(message.result);
      } else this.events.emit(`${message.sessionId || ''}:${message.method}`, message.params);
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Chrome connection closed.')); }
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chrome connection is not open.'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async session(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const listeners = [];
    return {
      send: (method, params) => this.send(method, params, sessionId),
      on: (name, listener) => { const event = `${sessionId}:${name}`; this.events.on(event, listener); listeners.push([event, listener]); },
      detach: async () => { for (const [event, listener] of listeners) this.events.off(event, listener); await this.send('Target.detachFromTarget', { sessionId }); }
    };
  }
}

export async function withBrowser(fn, { roots = [process.cwd(), os.tmpdir()] } = {}) {
  const executable = chromeExecutable();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'design-guard-chrome-'));
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--metrics-recording-only', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stopped = new Promise(resolve => child.once('close', resolve));
  let stderr = '', launchError;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.on('error', error => { launchError = error; });
  let protocol, mcp, socket;
  try {
    let port;
    for (let index = 0; index < 150; index++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Chrome failed to start: ${stderr}`);
      try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
      await sleep(100);
    }
    if (!port) throw new Error('Timed out waiting for Chrome startup.');
    const browserUrl = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${browserUrl}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout: Chrome connection')), 15000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true });
    });
    protocol = new Protocol(socket);
    mcp = await connectChrome({ browserUrl, roots: [...new Set([...roots, os.tmpdir()])] });
    return await fn({ protocol, mcp, chromeVersion: version.Browser?.match(/\d+\.\d+\.\d+\.\d+/)?.[0] });
  } finally {
    await mcp?.close().catch(() => {});
    if (protocol) await protocol.send('Browser.close').catch(() => {});
    socket?.close();
    const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 6000);
    try { await stopped; } finally { clearTimeout(timer); clearTimeout(killTimer); }
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export async function preparePage(browser, width, config) {
  const { protocol, mcp } = browser;
  const { browserContextId } = await protocol.send('Target.createBrowserContext');
  const marker = `about:blank#design-guard-${randomUUID()}`;
  let cdp;
  try {
    const { targetId } = await protocol.send('Target.createTarget', { url: marker, browserContextId });
    cdp = await protocol.session(targetId);
    const listing = await mcp.call('list_pages', {});
    const line = listing.split('\n').find(line => line.includes(marker));
    if (!line) throw new Error('Chrome MCP could not find the measurement tab.');
    const pageId = Number(line.match(/^(\d+):/)[1]);
    const viewport = { width, height: heightFor(width, config) };
    await mcp.call('emulate', { pageId, viewport: `${width}x${viewport.height}x1` });
    await cdp.send('Page.enable'); await cdp.send('Network.enable');
    const requests = new Set();
    let loaded = false, activity = Date.now();
    cdp.on('Page.loadEventFired', () => { loaded = true; });
    cdp.on('Network.requestWillBeSent', event => { requests.add(event.requestId); activity = Date.now(); });
    for (const event of ['Network.loadingFinished', 'Network.loadingFailed']) cdp.on(event, ({ requestId }) => { requests.delete(requestId); activity = Date.now(); });
    const evaluate = async (fn, arg) => scriptResult(await mcp.call('evaluate_script', {
      pageId, function: `async () => (${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`, waitForStableDom: false
    }));
    const waitState = async (networkIdle, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (loaded && (!networkIdle || requests.size === 0 && Date.now() - activity >= 500)) return;
        await sleep(50);
      }
      throw new Error('Timeout: waiting for Chrome rendering');
    };
    const point = async (selector, enabled = false, editable = false) => evaluate(async ({ selector, enabled, editable }) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const node = document.querySelector(selector);
        if (node) {
          node.scrollIntoView({ block: 'center', inline: 'center' });
          const first = node.getBoundingClientRect();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
          const stable = ['x', 'y', 'width', 'height'].every(key => first[key] === r[key]);
          if (stable && r.width && r.height && node.checkVisibility({ visibilityProperty: true }) && node.contains(document.elementFromPoint(x, y)) &&
            (!enabled || !node.matches(':disabled')) && (!editable || !node.readOnly)) return { x, y };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Timeout: element did not become actionable: ${selector}`);
    }, { selector, enabled, editable });
    const page = {
      evaluate,
      context: () => ({ newCDPSession: () => protocol.session(targetId) }),
      viewportSize: () => viewport,
      goto: async (url, options = {}) => {
        loaded = false; requests.clear(); activity = Date.now();
        const result = await cdp.send('Page.navigate', { url });
        if (result.errorText) throw new Error(result.errorText);
        await waitState(options.waitUntil === 'networkidle', options.timeout);
      },
      waitForLoadState: async (_, options) => { if (await evaluate(() => document.readyState !== 'loading')) return; await waitState(false, options?.timeout); },
      waitForTimeout: sleep,
      hover: async selector => { const coordinates = await point(selector); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...coordinates }); },
      click: async selector => {
        const coordinates = await point(selector, true);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...coordinates });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...coordinates });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...coordinates });
        await evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      },
      fill: async (selector, value) => {
        await point(selector, true, true);
        await evaluate(selector => {
          const node = document.querySelector(selector);
          if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable)) throw new Error('Select an editable input, textarea or contenteditable element.');
          node.focus();
        }, selector);
        const modifiers = process.platform === 'darwin' ? 4 : 2;
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers });
        if (value) await cdp.send('Input.insertText', { text: value });
        else {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        }
      },
      screenshot: async ({ path: file, fullPage }) => {
        await mcp.call('take_screenshot', { pageId, filePath: file, fullPage: Boolean(fullPage), format: 'png' });
      },
      locator: selector => {
        const locator = {
          first: () => locator,
          evaluate: fn => evaluate(`selector => { const node = document.querySelector(selector); if (!node) throw new Error('Target not found'); return (${fn.toString()})(node); }`, selector),
          screenshot: async ({ path: file }) => {
            const clip = await locator.evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 }; });
            if (clip.width <= 0 || clip.height <= 0) throw new Error('The screenshot target has no visible area.');
            const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip });
            await fs.writeFile(file, Buffer.from(result.data, 'base64'));
          }
        };
        return locator;
      },
      close: async () => { await cdp.detach(); await protocol.send('Target.disposeBrowserContext', { browserContextId }); }
    };
    return page;
  } catch (error) {
    await cdp?.detach().catch(() => {});
    await protocol.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    throw error;
  }
}

export async function renderedScreenshot(page, file) {
  await page.screenshot({ path: file, fullPage: true });
}
