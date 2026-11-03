import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { mcpExecutable, privacyArguments } from './chrome-runtime.mjs';

export async function connectChrome({ browserUrl, roots }) {
  const child = spawn(process.execPath, [mcpExecutable(), '--browserUrl', browserUrl, ...privacyArguments,
    ...roots.flatMap(root => ['--workspace', root])], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' } });
  let seq = 0, buffer = '', stderr = '';
  const pending = new Map(), calls = [];
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'roots/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { roots: roots.map(root => ({ uri: pathToFileURL(root).href, name: 'measurement-evidence' })) } });
      } else if (message.method && message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
      } else if (pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      }
    }
  });
  const rejectPending = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.on('error', rejectPending);
  child.stdin.on('error', rejectPending);
  child.once('exit', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Chrome MCP exited: ${stderr}`)); }
    pending.clear();
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer }); send({ jsonrpc: '2.0', id, method, params });
  });
  const textOf = result => result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '';
  async function callRaw(name, args) {
    const start = performance.now();
    const result = await request('tools/call', { name, arguments: args });
    calls.push({ name, args, ms: performance.now() - start, isError: Boolean(result.isError) });
    return result;
  }
  async function call(name, args) {
    const result = await callRaw(name, args);
    if (result.isError) throw new Error(`${name}: ${textOf(result)}`);
    return textOf(result);
  }
  async function close() {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 6000);
      try { await exited; } finally { clearTimeout(timer); clearTimeout(killTimer); }
    }
  }
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'design-guard', version: '1.0' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = await request('tools/list');
    return { initialized, tools, call, callRaw, textOf, calls, close, stderr: () => stderr };
  } catch (error) { await close(); throw error; }
}

export function scriptResult(text) {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) throw new Error(`Missing JSON script result: ${text}`);
  if (match[1].trim() === 'undefined') return undefined;
  return JSON.parse(match[1]);
}
