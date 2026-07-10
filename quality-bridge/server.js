// Quality Metrics Bridge Server
// Collects data from Tampermonkey scrapes of Piles, EPP, PPA
// Run: node server.js
// Endpoints:
//   POST /quality-bridge   — receive scraped data
//   GET  /quality-data     — return latest from all sources
//   GET  /quality-report   — human-readable summary
//   GET  /                 — simple status page

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.QUALITY_PORT || '4800');

// In-memory store of latest data per source.
// `piles` holds the most-recent piles scrape (back-compat); `pilesCounts`
// keeps every distinct audit count keyed by "date|shift|number" so the two
// nightly counts (#1, #2, ...) coexist instead of clobbering each other.
const store = {
  piles: null,
  pilesCounts: {},
  epp: null,
  ppa: null,
  twms: null,
  diverts: null
};

function auditKey(data) {
  if (!data || !data.auditDate || data.auditNumber === null || data.auditNumber === undefined) return null;
  return [data.auditDate, data.auditShift || '', data.auditNumber].join('|');
}

// History log
const LOG_DIR = path.join(__dirname, 'quality-log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logEntry(source, payload) {
  const date = new Date().toISOString().split('T')[0];
  const file = path.join(LOG_DIR, `${date}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), source, payload }) + '\n';
  fs.appendFileSync(file, line);
}

function handlePost(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const { source, data, shift, timestamp } = payload;

      if (!source || !data) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing source or data' }));
        return;
      }

      const entry = { data, shift, timestamp, receivedAt: new Date().toISOString() };
      store[source] = entry;

      // Keep each distinct piles audit count addressable by its own key so the
      // dashboard can pull #1 vs #2 accurately instead of getting whichever
      // landed last.
      let key = null;
      if (source === 'piles') {
        key = auditKey(data);
        if (key) store.pilesCounts[key] = Object.assign({ key: key }, entry);
      }

      logEntry(source, payload);

      console.log(`[${new Date().toISOString()}] Received ${source} (shift=${shift})` +
        (key ? ` [count ${key}]` : ''));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, source, shift, key }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleGetData(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(store, null, 2));
}

function handleGetReport(req, res) {
  const lines = ['=== RFD2 Quality Metrics Report ===', ''];
  const now = new Date().toISOString();
  lines.push(`Generated: ${now}`);
  lines.push('');

  // Piles
  if (store.piles) {
    lines.push('--- PILES ---');
    const p = store.piles.data;
    if (p.totalPiles !== null) lines.push(`  Total Piles: ${p.totalPiles}`);
    if (p.pilesOver48h !== null) lines.push(`  Over 48h: ${p.pilesOver48h}`);
    if (p.pilesOver24h !== null) lines.push(`  Over 24h: ${p.pilesOver24h}`);
    if (p.tableRows && p.tableRows.length > 0) {
      lines.push(`  Table rows: ${p.tableRows.length}`);
      p.tableRows.slice(0, 5).forEach(r => lines.push(`    ${JSON.stringify(r)}`));
    }
    if (Object.keys(p.summary || {}).length > 0) {
      lines.push(`  Summary: ${JSON.stringify(p.summary)}`);
    }
    lines.push(`  Last update: ${store.piles.timestamp}`);
  } else {
    lines.push('--- PILES: No data yet ---');
  }
  lines.push('');

  // EPP
  if (store.epp) {
    lines.push('--- EPP COMPLIANCE ---');
    const e = store.epp.data;
    if (e.kpis.eppCompliance) lines.push(`  EPP Compliance: ${e.kpis.eppCompliance}`);
    if (e.kpis.allPercentages) lines.push(`  Percentages found: ${e.kpis.allPercentages.join(', ')}`);
    if (e.tables.length > 0) {
      lines.push(`  Tables: ${e.tables.length}`);
      e.tables.forEach((t, i) => {
        lines.push(`    Table ${i}: ${t.headers.join(' | ')}`);
        t.rows.slice(0, 3).forEach(r => lines.push(`      ${r.join(' | ')}`));
      });
    }
    if (e.visuals.length > 0) {
      lines.push(`  Visuals: ${e.visuals.length}`);
      e.visuals.slice(0, 5).forEach(v => lines.push(`    ${v.title}: ${(v.numbers || []).join(', ')}`));
    }
    lines.push(`  Last update: ${store.epp.timestamp}`);
  } else {
    lines.push('--- EPP COMPLIANCE: No data yet ---');
  }
  lines.push('');

  // PPA
  if (store.ppa) {
    lines.push('--- PPA COMPLIANCE ---');
    const a = store.ppa.data;
    lines.push(`  Target shift: ${a.kpis.targetShift || store.ppa.shift}`);
    if (a.kpis.ppaCompliance) lines.push(`  PPA Compliance: ${a.kpis.ppaCompliance}`);
    if (a.kpis.allPercentages) lines.push(`  Percentages found: ${a.kpis.allPercentages.join(', ')}`);
    if (a.tables.length > 0) {
      lines.push(`  Tables: ${a.tables.length}`);
      a.tables.forEach((t, i) => {
        lines.push(`    Table ${i}: ${t.headers.join(' | ')}`);
        t.rows.slice(0, 3).forEach(r => lines.push(`      ${r.join(' | ')}`));
      });
    }
    if (a.visuals.length > 0) {
      lines.push(`  Visuals: ${a.visuals.length}`);
      a.visuals.slice(0, 5).forEach(v => lines.push(`    ${v.title}: ${(v.numbers || []).join(', ')}`));
    }
    lines.push(`  Last update: ${store.ppa.timestamp}`);
  } else {
    lines.push('--- PPA COMPLIANCE: No data yet ---');
  }

  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end(lines.join('\n'));
}

function handleIndex(req, res) {
  const html = `<!DOCTYPE html>
<html><head><title>RFD2 Quality Bridge</title>
<style>
  body { font-family: "Amazon Ember", Arial, sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
  h1 { color: #ff9900; }
  .source { background: #232f3e; padding: 16px; border-radius: 8px; margin: 12px 0; }
  .source h2 { color: #ff9900; margin-top: 0; }
  .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
  .online { background: #4caf50; }
  .offline { background: #f44336; }
  pre { background: #0d1117; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
  .refresh { color: #ff9900; cursor: pointer; text-decoration: underline; }
</style>
</head><body>
<h1>RFD2 Quality Metrics Bridge</h1>
<p>Shift: <strong id="shift"></strong> | Updated: <span id="updated"></span>
   | <span class="refresh" onclick="load()">Refresh</span></p>
<div id="sources"></div>
<h3>Raw JSON</h3>
<pre id="raw"></pre>
<script>
function load() {
  fetch('/quality-data').then(r=>r.json()).then(d => {
    document.getElementById('raw').textContent = JSON.stringify(d, null, 2);
    document.getElementById('updated').textContent = new Date().toLocaleTimeString();

    // Determine shift
    const now = new Date();
    const ct = new Date(now.toLocaleString('en-US',{timeZone:'America/Chicago'}));
    const day = ct.getDay(), hour = ct.getHours();
    let sd = day; if(hour<7) sd=(day+6)%7;
    document.getElementById('shift').textContent = sd<=2?'FH':'BH';

    let html = '';
    ['piles','epp','ppa'].forEach(src => {
      const s = d[src];
      const online = !!s;
      const age = s ? Math.round((Date.now()-new Date(s.receivedAt).getTime())/1000) : null;
      html += '<div class="source"><h2><span class="status '+(online?'online':'offline')+'"></span>'
        + src.toUpperCase()+'</h2>';
      if(s) {
        html += '<p>Last: '+s.timestamp+' ('+age+'s ago)</p>';
        html += '<pre>'+JSON.stringify(s.data,null,2).substring(0,1000)+'</pre>';
      } else {
        html += '<p>No data received yet. Open the source page with Tampermonkey active.</p>';
      }
      html += '</div>';
    });
    document.getElementById('sources').innerHTML = html;
  });
}
load();
setInterval(load, 10000);
</script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  if (req.method === 'POST' && url === '/quality-bridge') return handlePost(req, res);
  if (req.method === 'GET' && url === '/quality-data') return handleGetData(req, res);
  if (req.method === 'GET' && url === '/quality-report') return handleGetReport(req, res);
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) return handleIndex(req, res);

  // Serve the FHNs Quality page if it sits next to server.js
  // (accepts either filename: fhnsquality.html or fhns-quality.html)
  if (req.method === 'GET' && (url === '/fhns' || url === '/fhns-quality.html' || url === '/fhnsquality.html')) {
    const f = ['fhnsquality.html', 'fhns-quality.html']
      .map(n => path.join(__dirname, n))
      .find(p => fs.existsSync(p));
    if (f) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(f));
    } else {
      res.writeHead(404);
      res.end('fhnsquality.html not found next to server.js');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Quality Bridge Server running at http://127.0.0.1:${PORT}`);
  console.log(`  POST /quality-bridge   — receive scraped data`);
  console.log(`  GET  /quality-data     — JSON of all sources`);
  console.log(`  GET  /quality-report   — text summary`);
  console.log(`  GET  /                 — dashboard UI`);
  console.log(`\nShift: ${getCurrentShiftLabel()}`);
});

function getCurrentShiftLabel() {
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const day = ct.getDay(), hour = ct.getHours();
  let sd = day; if (hour < 7) sd = (day + 6) % 7;
  return sd <= 2 ? 'Front Half (FH)' : 'Back Half (BH)';
}
