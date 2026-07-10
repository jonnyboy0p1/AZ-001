const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const PORT = 5220;
const ROOT = __dirname;
const COOKIE_FILE = path.join(os.homedir(), '.midway', 'cookie');
const COOKIE_MAX_AGE = 12 * 3600;

const ALLOWED_PROXY_HOSTS = [
  'fclm-portal.amazon.com',
  'monitorportal.amazon.com',
  'neo.meta.amazon.dev',
  'zone-ra.amazon.dev'
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

let bridgeData = null;
let bridgeReceivedAt = 0;
let manualCookie = '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function loadCookieHeader() {
  if (manualCookie) return manualCookie;
  if (!fs.existsSync(COOKIE_FILE)) return '';
  const raw = fs.readFileSync(COOKIE_FILE, 'utf8');
  const pairs = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0];
    const name = parts[5];
    const value = parts[6];
    if (domain.includes('amazon.com') || domain.includes('amazon.dev')) {
      pairs.push(`${name}=${value}`);
    }
  }
  return pairs.join('; ');
}

function cookieFileAgeSeconds() {
  if (!fs.existsSync(COOKIE_FILE)) return null;
  return (Date.now() - fs.statSync(COOKIE_FILE).mtimeMs) / 1000;
}

function proxyAllowed(url) {
  try {
    const host = new URL(url).hostname;
    return ALLOWED_PROXY_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
  } catch {
    return false;
  }
}

function fetchUpstream(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          Cookie: loadCookieHeader(),
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          Referer: `${target.protocol}//${target.host}/`
        },
        timeout: 25000
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            contentType: res.headers['content-type'] || 'application/octet-stream',
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function sendJson(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json', ...extra });
  res.end(body);
}

function handleBridge(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        bridgeData = JSON.parse(body);
        bridgeReceivedAt = Date.now();
        sendJson(res, 200, { ok: true });
      } catch {
        res.writeHead(400, CORS);
        res.end('Bad JSON');
      }
    });
    return;
  }

  if (req.method === 'GET') {
    if (!bridgeData) {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    sendJson(res, 200, { payload: bridgeData, receivedAt: bridgeReceivedAt });
    return;
  }

  res.writeHead(405, CORS);
  res.end('Method Not Allowed');
}

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;

  if (urlPath === '/bridge') {
    handleBridge(req, res);
    return;
  }

  if (urlPath === '/health' && req.method === 'GET') {
    const age = cookieFileAgeSeconds();
    let state = 'ok';
    if (age == null) state = 'no_cookie_file';
    else if (age > COOKIE_MAX_AGE) state = 'stale';
    else if (!loadCookieHeader()) state = 'empty';
    sendJson(res, 200, {
      status: state,
      cookieFile: COOKIE_FILE,
      cookieAge: age == null ? null : Math.round(age),
      manualCookie: Boolean(manualCookie)
    });
    return;
  }

  if (urlPath === '/set-cookie' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        manualCookie = (JSON.parse(body).cookie || '').trim();
        sendJson(res, 200, { status: 'ok', cookieSet: Boolean(manualCookie) });
      } catch (err) {
        sendJson(res, 400, { error: String(err.message || err) });
      }
    });
    return;
  }

  if (urlPath === '/api/proxy' && req.method === 'GET') {
    const target = query.get('url') || '';
    if (!target || !proxyAllowed(target)) {
      sendJson(res, 400, { error: 'invalid or disallowed url' });
      return;
    }
    try {
      const upstream = await fetchUpstream(target);
      res.writeHead(200, {
        ...CORS,
        'Content-Type': upstream.contentType,
        'X-Upstream-Status': String(upstream.status),
        'X-Upstream-Content-Type': upstream.contentType
      });
      res.end(upstream.body);
    } catch (err) {
      sendJson(res, 200, { error: String(err.message || err) });
    }
    return;
  }

  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OB Period Report Card: http://127.0.0.1:${PORT}/`);
  console.log(`Bridge API:            http://127.0.0.1:${PORT}/bridge`);
  console.log(`Proxy API:             http://127.0.0.1:${PORT}/api/proxy?url=...`);
});
