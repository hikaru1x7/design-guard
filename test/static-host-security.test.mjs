import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../lib/browser-common.mjs';

function request(baseUrl, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + '/index.html', {
      agent: false,
      ...(host === undefined ? {} : { headers: { host } })
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Local static request timed out')));
  });
}

test('static files are served only for the advertised loopback authority', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-static-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'index.html'), 'local fixture contents');
  const server = await serveStatic(root);
  t.after(() => server.close());
  const { host, port } = new URL(server.baseUrl);

  // Connect directly to loopback while retaining the attacker's Host, as a
  // browser would after its foreign hostname resolves to the loopback address.
  for (const foreignHost of [`attacker.example:${port}`, `127.0.0.1.attacker.example:${port}`, '127.0.0.1:1']) {
    assert.deepEqual(await request(server.baseUrl, foreignHost), { status: 403, body: 'forbidden' });
  }
  assert.deepEqual(await request(server.baseUrl, host), { status: 200, body: 'local fixture contents' });
  assert.deepEqual(await request(server.baseUrl), { status: 200, body: 'local fixture contents' });
});
