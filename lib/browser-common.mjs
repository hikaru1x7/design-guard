import fs from 'node:fs/promises';
import fssync from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

export async function serveStatic(root) {
  // 指定ディレクトリを一時 HTTP サーバとして配信する。
  const base = await fs.realpath(path.resolve(root));
  const withinRoot = (file) => {
    const relative = path.relative(base, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const server = http.createServer((req, res) => {
    // Loopback binding alone does not prevent a foreign hostname from resolving
    // here (DNS rebinding). Only serve the authority returned in baseUrl.
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let raw;

    try {
      raw = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (raw.includes('\0')) {
      res.writeHead(400).end();
      return;
    }

    if (raw === '/') {
      raw = '/index.html';
    }

    const target = path.resolve(base, `.${raw}`);

    if (!withinRoot(target)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    // リンク先も配信範囲内か確認し、その実際のパスを読む。
    fssync.realpath(target, (error, resolved) => {
      if (error) {
        res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('not found');
        return;
      }

      if (!withinRoot(resolved)) {
        res.writeHead(403).end('forbidden');
        return;
      }

      fssync.readFile(resolved, (error, body) => {
        if (error) {
          res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('not found');
          return;
        }

        res.writeHead(200, {
          'content-type': mime[path.extname(target).toLowerCase()] || 'application/octet-stream'
        });
        res.end(body);
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export function heightFor(width, config) {
  // 画面幅と設定から viewport の高さを決める。
  return config.heights?.[String(width)] || config.heights?.[width] || (width < 600 ? 800 : 900);
}

export async function settle(page, url) {
  // 通常は通信待ちまで待ち、終わらない画面は表示後に続行する。
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    await page.evaluate(() => document.fonts?.ready);
    return true;
  } catch (error) {
    if (!/Timeout/i.test(error.message)) {
      throw error;
    }

    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    return false;
  }
}

export async function runActions(page, actions, baseUrl) {
  // 許可された画面操作を指定順に実行する。
  if (!actions) {
    return;
  }

  for (const action of actions.split(';').filter(Boolean)) {
    if (action.startsWith('click:')) {
      await page.click(action.slice(6));
    } else if (action.startsWith('hover:')) {
      await page.hover(action.slice(6));
    } else if (action.startsWith('wait:')) {
      await page.waitForTimeout(Number(action.slice(5)));
    } else if (action.startsWith('fill:')) {
      const index = action.indexOf('=', 5);

      if (index < 0) {
        throw new Error(`Invalid fill action: ${action}`);
      }

      await page.fill(action.slice(5, index), action.slice(index + 1));
    } else if (action.startsWith('goto:')) {
      await settle(page, new URL(action.slice(5), baseUrl).href);
    } else {
      throw new Error(`Unsupported action: ${action}`);
    }
  }
}

export async function pathExists(file) {
  // ファイルまたはディレクトリの有無を返す。
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
