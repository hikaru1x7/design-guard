#!/usr/bin/env node
import os from 'node:os';
import { spawn } from 'node:child_process';
import { chromeExecutable, mcpExecutable, privacyArguments } from '../lib/chrome-runtime.mjs';

const command = process.argv[2];
try {
  if (command === 'probe') {
    const { withBrowser, preparePage } = await import('../lib/browser.mjs');
    await withBrowser(async browser => {
      const page = await preparePage(browser, 375, {});
      try {
        if (await page.evaluate(() => devicePixelRatio) !== 1) throw new Error('Chrome device scale must be 1.');
      } finally { await page.close(); }
    });
  } else if (command === 'mcp') {
    const child = spawn(process.execPath, [mcpExecutable(), '--headless', '--isolated', '--executablePath', chromeExecutable(),
      ...privacyArguments, '--workspace', process.cwd(), '--workspace', os.tmpdir()], {
      stdio: 'inherit', env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } else throw new Error('Use chrome-devtools.mjs mcp or probe.');
} catch (error) {
  console.error(`Chrome DevTools: ${error.message}`);
  process.exitCode = 1;
}
