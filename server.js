const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5220;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.user.js': 'application/javascript; charset=utf-8'
};

let bridgeData = null;
let bridgeReceivedAt = 0;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

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
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
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
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ payload: bridgeData, receivedAt: bridgeReceivedAt }));
    return;
  }

  res.writeHead(405, CORS);
  res.end('Method Not Allowed');
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (urlPath === '/bridge') {
    handleBridge(req, res);
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
  console.log(`RB20 dashboard:  http://127.0.0.1:${PORT}/`);
  console.log(`RB20 bridge API: http://127.0.0.1:${PORT}/bridge`);
});
