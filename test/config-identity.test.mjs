import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';

test('configuration cannot redirect the discovered project or hide its configuration file', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-config-identity-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const previousMode = process.env.RENDER_GUARD_MODE;
  t.after(() => {
    if (previousMode === undefined) delete process.env.RENDER_GUARD_MODE;
    else process.env.RENDER_GUARD_MODE = previousMode;
  });

  for (const mode of ['css', 'svg']) {
    process.env.RENDER_GUARD_MODE = mode;
    for (const unified of [false, true]) {
      const root = path.join(temporary, `${mode}-${unified ? 'unified' : 'legacy'}`);
      const nested = path.join(root, 'src');
      await fs.mkdir(nested, { recursive: true });
      const file = path.join(root, unified ? 'render-guard.json' : `${mode}-guard.json`);
      const given = {
        root: path.join(temporary, 'other-project'),
        file: path.join(temporary, 'missing-config.json'),
        widths: [640],
        protectedFiles: ['src/shared.css']
      };
      await fs.writeFile(file, JSON.stringify(unified ? { [mode]: given } : given));

      const config = await loadConfig(nested);
      assert.equal(config.root, root);
      assert.equal(config.file, file);
      assert.deepEqual(config.widths, given.widths);
      assert.deepEqual(config.protectedFiles, given.protectedFiles);
      if (mode === 'svg') assert.equal(config._svgMode, true);
    }
  }
});
