import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../lib/browser.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-static-boundary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'public');
  const outside = path.join(directory, 'public-private');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'index.html'), '<p>public</p>');
  await fs.writeFile(path.join(outside, 'canary.txt'), 'outside fixture');
  return { directory, root, outside };
}

async function requests(t, root) {
  let handler;
  // Exercise the actual request handler without opening a socket or browser.
  t.mock.method(http, 'createServer', (callback) => {
    handler = callback;
    return {
      once() {},
      listen(port, host, ready) { assert.equal(host, '127.0.0.1'); ready(); },
      address() { return { port: 12345 }; },
      close(done) { done(); }
    };
  });
  const server = await serveStatic(root);
  t.after(() => server.close());
  return (url) => new Promise((resolve, reject) => {
    let status, headers;
    Promise.resolve(handler({ url }, {
      writeHead(code, values) { status = code; headers = values; return this; },
      end(body) { resolve({ status, headers, body: body?.toString() }); }
    })).catch(reject);
  });
}

test('static responses reject links to files and directories outside the served tree', async (t) => {
  const { root, outside } = await fixture(t);
  await fs.symlink(path.join(outside, 'canary.txt'), path.join(root, 'file.txt'));
  await fs.symlink(outside, path.join(root, 'directory'), 'dir');
  await fs.symlink('directory/canary.txt', path.join(root, 'chain.txt'));
  const request = await requests(t, root);
  for (const url of ['/file.txt', '/directory/canary.txt', '/chain.txt', '/%2e%2e%2fpublic-private/canary.txt']) {
    assert.deepEqual(await request(url), { status: 403, headers: undefined, body: 'forbidden' });
  }
});

test('static responses preserve linked roots, internal links, MIME types and error responses', async (t) => {
  const { directory, root } = await fixture(t);
  const alias = path.join(directory, 'linked-root');
  await fs.symlink(root, alias, 'dir');
  await fs.symlink('index.html', path.join(root, 'alias.html'));
  const request = await requests(t, alias);
  for (const url of ['/', '/alias.html']) {
    assert.deepEqual(await request(url), {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<p>public</p>'
    });
  }
  assert.equal((await request('/missing.txt')).status, 404);
  assert.equal((await request('/%zz')).status, 400);
});
