import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const stableMetadataUrl = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json';
export const packages = ['chrome-devtools-mcp', '@puppeteer/browsers', 'pixelmatch', 'pngjs'];
export const repository = path.resolve(import.meta.dirname, '..');
export const chromeHome = () => process.env.RENDER_GUARD_BROWSER_HOME || path.join(os.homedir(), '.cache/design-guard/chrome');

export function chromeExecutable(home = chromeHome()) {
  try {
    const { executable } = JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));
    if (!path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('missing executable');
    return executable;
  } catch {
    throw new Error('Managed Chrome is unavailable. Run render-guard css update before measuring.');
  }
}

export function chromeVersion(home = chromeHome()) {
  const result = spawnSync(chromeExecutable(home), ['--version'], { encoding: 'utf8', timeout: 5000 });
  const version = result.stdout?.match(/\b(\d+\.\d+\.\d+\.\d+)\b/)?.[1];
  if (result.error || result.status !== 0 || !version) throw new Error('Cannot read the installed Chrome version.');
  return version;
}

export async function latestChromeVersion(fetcher = fetch) {
  const response = await fetcher(stableMetadataUrl, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Cannot check the official Chrome Stable release.');
  const version = (await response.json()).channels?.Stable?.version;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Chrome Stable metadata.');
  return version;
}

export async function installChrome(version, home = chromeHome()) {
  const { install, Browser, detectBrowserPlatform } = await import('@puppeteer/browsers');
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error('Chrome for Testing is unavailable on this platform.');
  const browser = await install({ browser: Browser.CHROME, buildId: version, cacheDir: home, platform });
  await fsp.mkdir(home, { recursive: true });
  const temporary = path.join(home, `current.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, JSON.stringify({ version, executable: browser.executablePath }));
    await fsp.rename(temporary, path.join(home, 'current.json'));
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  if (chromeVersion(home) !== version) throw new Error('Installed Chrome does not match the checked Stable release.');
}

export function mcpExecutable(directory = repository) {
  const root = path.join(directory, 'node_modules/chrome-devtools-mcp');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return path.join(root, pkg.bin['chrome-devtools-mcp']);
}

export const privacyArguments = ['--no-usage-statistics', '--no-performance-crux', '--categoryExtensions=false'];
