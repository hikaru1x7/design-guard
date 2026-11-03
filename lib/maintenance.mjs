import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { packages, repository, chromeVersion, latestChromeVersion, installChrome } from './chrome-runtime.mjs';

export async function installedVersions(directory = repository, { readChrome = chromeVersion } = {}) {
  const versions = Object.fromEntries(await Promise.all(packages.map(async (name) => {
    const value = JSON.parse(await fs.readFile(path.join(directory, 'node_modules', name, 'package.json'), 'utf8'));
    return [name, value.version];
  })));
  return { backend: 'chrome-devtools', chrome: readChrome(), ...versions };
}

export async function updateDependencies({ directory = repository, run = runCommand,
  latestBrowser = latestChromeVersion, installBrowser = installChrome, installed = () => installedVersions(directory) } = {}) {
  const receipt = path.join(directory, '.guard-maintenance.json');
  let previous;
  try { previous = JSON.parse(await fs.readFile(receipt, 'utf8')); } catch {}
  await fs.rm(receipt, { force: true });
  run('npm', ['install', '--save-exact', '--engine-strict', '--no-audit', '--no-fund',
    ...packages.map((name) => `${name}@latest`)], directory);
  const stable = await latestBrowser();
  await installBrowser(stable);
  const versions = await installed();
  if (versions.chrome !== stable) throw new Error('Installed Chrome does not match the checked Stable release.');
  if (JSON.stringify(previous?.versions) !== JSON.stringify(versions)) {
    run('npm', ['test'], directory);
  }
  run(process.execPath, [path.join(directory, 'bin/chrome-devtools.mjs'), 'probe'], directory);
  const result = { checkedAt: new Date().toISOString(), versions };
  await fs.writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', 2, 2], timeout: 600000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} update/validation failed. Resolve the cause and rerun update before measuring.`);
}
