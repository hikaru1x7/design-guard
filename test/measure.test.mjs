import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { cli, json, repo, tempProject } from './helpers.mjs';
import { serveStatic } from '../lib/browser.mjs';

test('実測は計算後スタイル、矩形、カスケード行番号、前回との差分とスクショを保存する', async () => {
  const project = await tempProject(); const first = json(await cli(project, ['measure', '/index.html', '#b', '--widths', '1280,375']));
  assert.equal(first.widths[0].target.styles.display, 'block'); assert.equal(first.widths[0].target.rect.width, 128); assert.ok(first.widths[0].cascade.some((item) => item.selector.includes('#b') && /site\.css:\d+/.test(item.source)), JSON.stringify(first.widths[0].cascade));
  await fs.access(first.widths[0].screenshot); await fs.access(first.widths[0].elementShot);
  const second = json(await cli(project, ['measure', '/index.html', '#b', '--actions', 'click:#toggle'])); assert.ok(second.previous.changes.some((item) => item.path === 'target.styles.width' && item.after === '220px'));
});

test('cascade は割合、変数、ショートハンド、important、継承の宣言元を返す', async () => {
  const project = await tempProject({ static: `${repo}/test/fixtures/cascade` });
  const result = json(await cli(project, ['measure', '/index.html', '#cascade', '--widths', '1280']));
  const cascade = result.widths[0].cascade;
  const property = (name) => cascade.find((entry) => entry.property === name);

  assert.deepEqual(Object.keys(property('width')).sort(), ['computed', 'declared', 'important', 'property', 'selector', 'source'].sort());
  assert.equal(property('width').selector, '#cascade');
  assert.equal(property('width').declared, '100%');
  assert.match(property('width').computed, /px$/);
  assert.equal(property('padding-left').declared, 'var(--gap)');
  assert.equal(property('padding-left').computed, '12px');
  assert.match(property('margin-left').declared, /auto/);
  assert.equal(property('color').important, true);
  assert.equal(property('font-size').declared, '18px');
  assert.equal(property('font-size').inheritedFrom, '.cascade-parent');
  assert.match(property('font-size').source, /site\.css:\d+/);
});

test('完全な URL の measure は baseUrl と static を要求しない', async () => {
  const project = await tempProject({ static: undefined });
  const server = await serveStatic(`${repo}/test/fixtures/site`);

  try {
    const result = json(await cli(project, ['measure', `${server.baseUrl}/index.html`, '#b', '--widths', '1280']));
    assert.equal(result.widths[0].target.id, 'b');
  } finally {
    await server.close();
  }
});

test('cascade は important の逆レイヤー順と同一レイヤーの優先度、後のinline宣言を守る', async (t) => {
  const project = await tempProject({ static: `${repo}/test/fixtures/cascade-priority` });
  t.after(async () => { await fs.rm(project.root, { recursive: true, force: true }); await fs.rm(project.home, { recursive: true, force: true }); });
  for (const [id, expected, selector] of [
    ['layered', '24px', '#layered'], ['nested', '31px', '#nested'],
    ['specific', '42px', '#specific'], ['inline', '45px', 'style attribute'], ['normal', '13px', '#normal']
  ]) {
    const result = json(await cli(project, ['measure', '/index.html', `#${id}`, '--widths', '1280']));
    const source = result.widths[0].cascade.find(item => item.property === 'padding-left');
    assert.equal(source.declared, expected, id);
    assert.equal(source.computed, expected, id);
    assert.equal(source.selector, selector, id);
  }
});

test('cascade は方向別の論理指定とショートハンドの宣言順を反映し、無効な宣言を除く', async (t) => {
  const project = await tempProject({ static: `${repo}/test/fixtures/cascade-priority` });
  t.after(async () => { await fs.rm(project.root, { recursive: true, force: true }); await fs.rm(project.home, { recursive: true, force: true }); });
  for (const [id, property, declared, computed] of [
    ['ltr', 'padding-left', '22px', '22px'], ['rtl', 'padding-right', '23px', '23px'],
    ['vertical', 'padding-top', '25px', '25px'], ['mixed', 'padding-left', '10px 30px', '10px'],
    ['mixed', 'padding-right', '7px', '7px'], ['invalid', 'width', '170px', '170px']
  ]) {
    const result = json(await cli(project, ['measure', '/index.html', `#${id}`, '--widths', '1280']));
    const source = result.widths[0].cascade.find(item => item.property === property);
    assert.equal(source.declared, declared, `${id} ${property}`);
    assert.equal(source.computed, computed, `${id} ${property}`);
    assert.match(source.source, /site\.css:\d+$/);
  }
});
