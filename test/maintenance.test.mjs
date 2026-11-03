import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { updateDependencies, installedVersions } from '../lib/maintenance.mjs';
import { latestChromeVersion, packages } from '../lib/chrome-runtime.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-maintenance-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of packages) {
    const target = path.join(directory, 'node_modules', name);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  }
  let chrome = '155.0.0.1';
  return { directory, latestBrowser: async () => '156.0.0.1',
    installBrowser: async version => { chrome = version; },
    installed: () => installedVersions(directory, { readChrome: () => chrome }) };
}

test('update installs stable tools and Chrome, then records only after tests and startup pass', async t => {
  const options = await fixture(t), calls = [];
  const result = await updateDependencies({ ...options, run: (...args) => calls.push(args) });
  assert.deepEqual(calls[0][1].slice(-packages.length), packages.map(name => `${name}@latest`));
  assert.ok(calls[0][1].includes('--engine-strict'));
  assert.deepEqual(calls[1].slice(0, 2), ['npm', ['test']]);
  assert.match(calls[2][1][0], /chrome-devtools\.mjs$/);
  assert.equal(calls[2][1][1], 'probe');
  assert.deepEqual(result.versions, await options.installed());
  assert.equal(result.versions.chrome, '156.0.0.1');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.directory, '.guard-maintenance.json'))), result);
});

test('a checked version skips duplicate tests but still checks stable Chrome and startup', async t => {
  const options = await fixture(t), calls = [];
  await updateDependencies({ ...options, run: () => {} });
  await updateDependencies({ ...options, run: (...args) => calls.push(args) });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'npm');
  assert.equal(calls[1][1][1], 'probe');
});

test('a Chrome-only update reruns validation even when npm versions are unchanged', async t => {
  const options = await fixture(t), calls = [];
  await updateDependencies({ ...options, run: () => {} });
  await updateDependencies({ ...options, latestBrowser: async () => '157.0.0.1', run: (...args) => calls.push(args) });
  assert.deepEqual(calls[1].slice(0, 2), ['npm', ['test']]);
});

test('failed installation, browser mismatch, tests or startup remove the success receipt', async t => {
  const options = await fixture(t);
  for (const failure of [
    { run: () => { throw new Error('offline'); } },
    { installBrowser: async () => { throw new Error('offline'); } },
    { latestBrowser: async () => '159.0.0.1', installBrowser: async () => {} },
    { run: (command, args) => { if (command === 'npm' && args[0] === 'test') throw new Error('tests failed'); }, latestBrowser: async () => '158.0.0.1' },
    { run: (command, args) => { if (args.at(-1) === 'probe') throw new Error('startup failed'); } }
  ]) {
    await updateDependencies({ ...options, run: () => {} });
    await assert.rejects(updateDependencies({ ...options, run: () => {}, ...failure }));
    await assert.rejects(fs.access(path.join(options.directory, '.guard-maintenance.json')));
  }
});

test('browser updates select only official Stable metadata and reject missing/invalid releases', async () => {
  assert.equal(await latestChromeVersion(async () => ({ ok: true, json: async () => ({ channels: {
    Stable: { version: '156.0.0.1' }, Canary: { version: '159.0.0.1' }
  } }) })), '156.0.0.1');
  await assert.rejects(latestChromeVersion(async () => ({ ok: false })), /official/);
  await assert.rejects(latestChromeVersion(async () => ({ ok: true, json: async () => ({ channels: { Canary: { version: '159.0.0.1' } } }) })), /metadata/);
});
