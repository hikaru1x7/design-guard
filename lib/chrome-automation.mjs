import fs from 'node:fs/promises';
import { withBrowser, preparePage } from './browser.mjs';
import { updateDay } from './session-maintenance.mjs';

// Shared browser operations for project checks. Guard measurements keep scale 1.
export async function withChrome(work, options = {}) {
  await updateDay();
  return withBrowser(async browser => {
    const pages = new Set();
    let failed = false;
    try {
      return await work({ newPage: async settings => {
        const page = await openPage(browser, settings);
        const close = page.close;
        page.close = async () => { try { await close(); } finally { pages.delete(page); } };
        pages.add(page);
        return page;
      } });
    } catch (error) { failed = true; throw error; }
    finally {
      const results = await Promise.allSettled([...pages].map(page => page.close()));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (!failed && errors.length) throw new AggregateError(errors, 'Chrome page cleanup failed.');
    }
  }, options);
}

async function openPage(browser, { viewport = { width: 1280, height: 720 }, deviceScaleFactor = 1 } = {}) {
  let size = { ...viewport };
  const base = await preparePage(browser, size.width, { heights: { [size.width]: size.height } }, { deviceScaleFactor });
  const cdp = await base.context().newCDPSession(base);
  // Capture uses this CDP session's metrics, independently of MCP's session.
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor, mobile: false });
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');
  const { frameTree } = await cdp.send('Page.getFrameTree');
  let responseStatus, routeError, closed = false;
  const evaluate = async (...args) => { if (routeError) throw routeError; return base.evaluate(...args); };
  cdp.on('Network.responseReceived', event => {
    if (event.type === 'Document' && event.frameId === frameTree.frame.id) responseStatus = event.response.status;
  });
  const waitForFunction = (fn, arg, { timeout = 30000 } = {}) => evaluate(`async arg => {
    const deadline = Date.now() + ${JSON.stringify(timeout)};
    while (Date.now() < deadline) {
      if (await (${fn.toString()})(arg)) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timeout: Chrome condition did not become true.');
  }`, arg);
  async function capture({ path: file, fullPage = false, clip, omitBackground = false } = {}) {
    await evaluate(() => document.fonts?.ready);
    if (omitBackground) await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    try {
      const layout = await cdp.send('Page.getLayoutMetrics');
      const content = layout.cssContentSize || layout.contentSize;
      const region = clip || { x: 0, y: 0, width: fullPage ? Math.max(size.width, Math.ceil(content.width)) : size.width,
        height: fullPage ? Math.max(size.height, Math.ceil(content.height)) : size.height };
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true,
        captureBeyondViewport: true, clip: { ...region, scale: 1 } });
      const png = Buffer.from(data, 'base64');
      if (file) await fs.writeFile(file, png);
      return png;
    } finally { if (omitBackground) await cdp.send('Emulation.setDefaultBackgroundColorOverride'); }
  }
  const locator = (selector, index = 0) => {
    const evaluateNode = (fn, arg) => evaluate(`({ selector, index, arg }) => {
      const nodes = document.querySelectorAll(selector);
      const node = nodes[index < 0 ? nodes.length + index : index];
      if (!node) throw new Error('Chrome target not found: ' + selector);
      return (${fn.toString()})(node, arg);
    }`, { selector, index, arg });
    const mouse = async click => {
      await waitForFunction(({ selector, index }) => {
        const nodes = document.querySelectorAll(selector), node = nodes[index < 0 ? nodes.length + index : index];
        if (!node || node.matches(':disabled')) return false;
        node.scrollIntoView({ block: 'center', inline: 'center' });
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && node.checkVisibility({ visibilityProperty: true }) && node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }, { selector, index });
      const point = await evaluateNode(async node => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      if (click) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
        await evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      }
    };
    return {
      first: () => locator(selector), last: () => locator(selector, -1), nth: value => locator(selector, value),
      count: () => evaluate(selector => document.querySelectorAll(selector).length, selector),
      evaluate: evaluateNode,
      boundingBox: () => evaluateNode(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }),
      click: () => mouse(true), hover: () => mouse(false),
      screenshot: async options => {
        const clip = await evaluateNode(node => {
          node.scrollIntoView({ block: 'center', inline: 'center' });
          const r = node.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
        });
        if (clip.width <= 0 || clip.height <= 0) throw new Error('Chrome screenshot target has no area.');
        return capture({ ...options, clip });
      }
    };
  };
  return {
    ...base, evaluate, locator,
    $: async selector => await locator(selector).count() ? locator(selector) : null,
    $$eval: (selector, fn, arg) => evaluate(`({ selector, arg }) => (${fn.toString()})([...document.querySelectorAll(selector)], arg)`, { selector, arg }),
    goto: async (url, options) => {
      responseStatus = undefined;
      try { await base.goto(url, options); } catch (error) { throw routeError || error; }
      if (routeError) throw routeError;
      const status = responseStatus;
      return status === undefined ? null : { status: () => status };
    },
    waitForFunction,
    waitForSelector: (selector, options) => waitForFunction(selector => {
      const node = document.querySelector(selector);
      return Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    }, selector, options),
    click: selector => locator(selector).click(), hover: selector => locator(selector).hover(),
    screenshot: capture,
    viewportSize: () => ({ ...size }),
    setViewportSize: async viewport => {
      size = { ...viewport };
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor, mobile: false });
    },
    setContent: async html => {
      await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
      await waitForFunction(() => document.readyState === 'complete');
      await evaluate(() => document.fonts?.ready);
    },
    content: () => evaluate(() => (document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\n' : '') + document.documentElement.outerHTML),
    on: (event, listener) => {
      if (event === 'request') cdp.on('Network.requestWillBeSent', message => listener({ url: () => message.request.url }));
      else if (event === 'pageerror') cdp.on('Runtime.exceptionThrown', message => listener(new Error(message.exceptionDetails.exception?.description || message.exceptionDetails.text)));
      else throw new Error('Unsupported Chrome event: ' + event);
    },
    route: async (pattern, handler) => {
      if (pattern !== '**/*') throw new Error('Chrome request interception requires the explicit **/* pattern.');
      cdp.on('Fetch.requestPaused', message => {
        let handled = false;
        const send = (method, params = {}) => { if (handled) throw new Error('Request already handled.'); handled = true; return cdp.send(method, { requestId: message.requestId, ...params }); };
        Promise.resolve().then(() => handler({ request: () => ({ url: () => message.request.url }),
          abort: () => send('Fetch.failRequest', { errorReason: 'BlockedByClient' }),
          continue: () => send('Fetch.continueRequest'),
          fulfill: ({ status = 200, contentType = 'text/html; charset=utf-8', body = '' }) => send('Fetch.fulfillRequest', {
            responseCode: status, responseHeaders: [{ name: 'Content-Type', value: contentType }], body: Buffer.from(body).toString('base64')
          })
        })).then(() => { if (!handled) throw new Error('Chrome request was not handled.'); }).catch(error => {
          routeError = error;
          if (!handled) cdp.send('Fetch.failRequest', { requestId: message.requestId, errorReason: 'Aborted' }).catch(() => {});
        });
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    },
    evaluateFrame: async (selector, fn, arg) => {
      await cdp.send('DOM.enable');
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { node } = await cdp.send('DOM.describeNode', { nodeId });
      const frameId = node.frameId || node.contentDocument?.frameId;
      if (!frameId) throw new Error('Chrome iframe not found: ' + selector);
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'design-guard-review' });
      const result = await cdp.send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg) || ''})`, contextId: executionContextId, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    close: async () => { if (closed) return; closed = true; try { await base.close(); } finally { await cdp.detach().catch(() => {}); } }
  };
}
