import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cli, json, repo, tempProject } from './helpers.mjs';

test('snap は基準から変化ピクセル数を出し、無変更なら 0', async () => {
  const project = await tempProject(); const site = path.join(project.root, 'site'); await fs.cp(path.join(repo, 'test/fixtures/site'), site, { recursive: true });
  await fs.writeFile(path.join(project.root, 'css-guard.json'), JSON.stringify({ static: 'site', routes: ['/index.html'], widths: [375] }));
  const baseline = json(await cli(project, ['snap'])); assert.equal(baseline.entries[0].createdBaseline, true);
  await fs.appendFile(path.join(site, 'site.css'), '\nbody { background: black; }\n');
  const changed = json(await cli(project, ['snap'])); assert.ok(changed.entries[0].changedPixels > 0); await fs.access(changed.entries[0].diff);
  json(await cli(project, ['snap', '--baseline']));
  const same = json(await cli(project, ['snap'])); assert.equal(same.entries[0].changedPixels, 0);
});

test('snap preserves old baselines and refuses changed or unrecorded browser versions', async t => {
  const project = await tempProject({ widths: [375] });
  t.after(async () => { await fs.rm(project.root, { recursive: true, force: true }); await fs.rm(project.home, { recursive: true, force: true }); });
  const first = json(await cli(project, ['snap']));
  const file = first.entries[0].baseline;
  const original = await fs.readFile(file);
  const metadata = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
  await fs.writeFile(`${file}.json`, JSON.stringify({ ...metadata, chrome: 'old-version' }));
  const stale = await cli(project, ['snap']);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /baseline tool versions differ/);
  assert.deepEqual(await fs.readFile(file), original);
  await fs.rm(`${file}.json`);
  const missing = await cli(project, ['snap']);
  assert.equal(missing.code, 1);
  assert.deepEqual(await fs.readFile(file), original);
  json(await cli(project, ['snap', '--baseline']));
  assert.equal(json(await cli(project, ['snap'])).entries[0].changedPixels, 0);
});
