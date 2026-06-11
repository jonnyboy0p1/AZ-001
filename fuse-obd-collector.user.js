// ==UserScript==
// @name         FUSE OBD Collector
// @namespace    fuse.obd.rfd2
// @version      0.1.0
// @description  Scrape YMS / SSP / DockFlow inside the authenticated pages and push to the local FUSE proxy (/collect) for the OBD East/West board. No credentials leave the browser.
// @author       FUSE
// @match        https://prod-na.dockflow.robotics.a2z.com/*
// @match        https://trans-logistics.amazon.com/ssp/*
// @match        https://trans-logistics.amazon.com/yms/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

/*
 * HOW IT WORKS
 * ------------
 * This userscript runs *inside* the already-authenticated YMS / SSP / DockFlow tabs.
 * It scrapes the rendered tables (and harvests JSON the SPAs fetch) and POSTs normalized
 * rows to your local proxy at  http://localhost:8765/collect . The OBD dashboard then
 * reads /collect and joins everything: VRID links SSP↔door, ARC links DockFlow↔forecast.
 *
 * Why a userscript instead of the dashboard fetching directly: the dashboard is http/file
 * and the source pages are https behind Midway. A page can't read another origin, and
 * https→http-localhost is blocked as mixed content. GM_xmlhttpRequest is privileged and
 * bypasses both — and your Midway cookie never leaves the browser.
 *
 * Open each page (YMS yard, SSP OB dock, DockFlow Arcs/Sorter) with this active. The little
 * FUSE panel (bottom-right) shows what it captured and lets you Send now / toggle auto.
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const PROXY = () => (GM_getValue('fuse_proxy', 'http://localhost:8765') || 'http://localhost:8765').replace(/\/+$/, '');
  const NODE  = (location.href.match(/RFD2|[A-Z]{3}\d/) || ['RFD2'])[0];
  const AUTO_MS = 20000;

  const SOURCE = (() => {
    const h = location.hostname, p = location.pathname;
    if (h.includes('dockflow')) return 'dockflow';
    if (p.includes('/ssp/')) return 'ssp';
    if (p.includes('/yms/')) return 'yms';
    return 'unknown';
  })();

  // Per-source row cache; flush() posts whatever is freshest.
  const cache = {};            // sourceKey -> { rows, at }
  let lastSentSig = {};        // sourceKey -> signature (avoid resending identical)

  const log = (...a) => console.log('%c[FUSE]', 'color:#c2410c;font-weight:700', ...a);

  // ── Tiny helpers ────────────────────────────────────────────────────────────
  const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const ownerToTrailer = (o) => String(o || '').split('(')[0].trim().split(/\s+/)[0] || '';
  const destFromText = (s) => { const m = String(s || '').match(/->\s*([A-Z0-9]{3,5})/i); return m ? m[1].toUpperCase() : ''; };
  const vridFromText = (s) => { const m = String(s || '').match(/VRID\s*[:#]?\s*([A-Z0-9]{6,})/i); return m ? m[1].toUpperCase() : ''; };
  const doorFromText = (s) => { const m = String(s || '').match(/DD\s*0*(\d{2,4})/i); return m ? m[1] : ''; };

  // Convert an HTML <table> into array-of-objects keyed by lowercased header text.
  function tableToObjects(table) {
    if (!table) return [];
    const rows = [...table.querySelectorAll('tr')];
    if (rows.length < 2) return [];
    // header = first row with >1 th, else first row
    let hi = rows.findIndex(r => r.querySelectorAll('th').length > 1);
    if (hi < 0) hi = 0;
    const headers = [...rows[hi].children].map(c => txt(c).toLowerCase().replace(/[^a-z0-9]/g, ''));
    const out = [];
    for (let i = hi + 1; i < rows.length; i++) {
      const cells = [...rows[i].children];
      if (!cells.length) continue;
      const o = {}; let any = false;
      headers.forEach((h, j) => { if (h) { o[h] = txt(cells[j]); if (o[h]) any = true; } });
      o._text = txt(rows[i]);
      if (any) out.push(o);
    }
    return out;
  }

  function pickDataTable(matchRe) {
    const tables = [...document.querySelectorAll('table')];
    return tables.find(t => matchRe.test(t.textContent || '')) || null;
  }

  // ── YMS scraper ─────────────────────────────────────────────────────────────
  // Columns seen: Location(DD###) · Vehicle ID · Owner(Operator) · Load identifier(s)
  // (carries "RFD2->DEST" and "VRID xxxx") · Visit Reason.
  function scrapeYMS() {
    const rows = [];
    const table = pickDataTable(/load identifier|owner.*operator|vehicle id/i);
    if (table) {
      for (const o of tableToObjects(table)) {
        const door = doorFromText(o.location || o.loc || o._text);
        if (!door) continue;
        const loads = o.loadidentifiers || o.loadidentifier || o.loads || o._text;
        rows.push({
          door,
          owner: o.owneroperator || o.owner || '',
          trailer_type: ownerToTrailer(o.owneroperator || o.owner || ''),
          vehicle_id: o.vehicleid || '',
          vrid: vridFromText(loads) || (o.vrid || ''),
          dest: destFromText(loads),
          visit_reason: o.visitreason || '',
          license_plate: o.licenseplate || ''
        });
      }
    }
    // Fallback: scan any element that starts a DD row.
    if (!rows.length) {
      const seen = new Set();
      document.querySelectorAll('*').forEach(el => {
        if (el.children.length) return;
        const door = doorFromText(el.textContent || '');
        if (!door || seen.has(door)) return;
        const row = el.closest('tr,[role="row"],li,div'); if (!row) return;
        const t = txt(row);
        if (!/VRID|->|OUTBOUND|INBOUND|HV|SV|V\d/.test(t)) return;
        seen.add(door);
        rows.push({ door, vrid: vridFromText(t), dest: destFromText(t), _text: t.slice(0, 200) });
      });
    }
    return rows;
  }

  // ── SSP scraper ─────────────────────────────────────────────────────────────
  // Shape unknown here, so push header-keyed table objects; the dashboard's field
  // matcher picks vrid / weight / jobs / sdt / cdt by name.
  function scrapeSSP() {
    const table = pickDataTable(/vrid|cdt|sdt|departure|payload|weight/i)
               || document.querySelector('table');
    const objs = tableToObjects(table);
    // keep only rows that carry a VRID or a weight-ish/departure-ish field
    return objs.filter(o => /VRID|\d{4,}|:\d{2}/.test(o._text));
  }

  // ── DockFlow Arcs scraper ─────────────────────────────────────────────────────
  // Left list = Name + Rate for every ARC. The open ARC also shows a Future forecast
  // (15m/30m/1h/2h/4h/8h/24h) — capture it and attach to that ARC as you click around.
  function scrapeArcs() {
    const out = {};
    // 1) the arcs list (Name | Rate)
    const list = pickDataTable(/\b(name)\b[\s\S]*\brate\b/i);
    if (list) {
      for (const o of tableToObjects(list)) {
        const name = (o.name || '').toUpperCase();
        if (!/^[A-Z0-9]{2,6}(_[A-Z0-9]+)?$/.test(name)) continue;
        out[name] = Object.assign(out[name] || { arc: name }, { rate: parseFloat((o.rate || '0').replace(/[^0-9.]/g, '')) || 0 });
      }
    }
    // 2) the open arc's Future forecast
    try {
      const head = [...document.querySelectorAll('h1,h2,h3,[class*="title"],[class*="header"]')]
        .map(txt).find(t => /^[A-Z0-9]{2,6}(_[A-Z0-9]+)?$/.test(t));
      const futureLabel = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /^future$/i.test(txt(e)));
      if (head && futureLabel) {
        // grab the numbers in the Future block: nearest table/grid after the label
        const block = futureLabel.closest('div,section,table') || futureLabel.parentElement;
        const nums = (txt(block).match(/\b\d[\d,]*\b/g) || []).map(n => +n.replace(/,/g, ''));
        // the Future row has 7 horizon values (15m..24h) — take the last 7 numbers
        if (nums.length >= 7) {
          const f = nums.slice(-7);
          const name = head.toUpperCase();
          out[name] = Object.assign(out[name] || { arc: name }, {
            future: { '15min': f[0], '30min': f[1], '1hr': f[2], '2hr': f[3], '4hr': f[4], '8hr': f[5], '24hr': f[6] }
          });
        }
      }
    } catch (e) { /* ignore */ }
    return Object.values(out);
  }

  // ── Network harvest (best-effort) ────────────────────────────────────────────
  // DockFlow/SSP fetch their data as JSON. Walk responses for arc-like records
  // (name + rate + forecast). This is what fills the forecast for ALL arcs at once.
  function harvestArcsFromJson(json) {
    const found = {};
    const visit = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      const name = String(v.arc || v.arcName || v.name || v.arcId || '').toUpperCase();
      const rate = v.currentRate ?? v.rate ?? v.jobsPerHour ?? v.ratePerHour;
      const fut  = v.future || v.forecast || v.futureForecast || v.forecasts;
      if (/^[A-Z0-9]{2,6}(_[A-Z0-9]+)?$/.test(name) && (rate != null || fut != null)) {
        const rec = found[name] || { arc: name };
        if (rate != null) rec.rate = parseFloat(String(rate).replace(/[^0-9.]/g, '')) || 0;
        if (fut != null) rec.future = fut;
        found[name] = rec;
      }
      for (const k in v) { try { visit(v[k]); } catch (e) {} }
    };
    try { visit(json); } catch (e) {}
    return Object.values(found);
  }

  function onJsonResponse(url, json) {
    try {
      if (SOURCE === 'dockflow') {
        const arcs = harvestArcsFromJson(json);
        if (arcs.length) { stash('dockflow-arcs', mergeArcRows(cache['dockflow-arcs']?.rows, arcs)); }
      }
      // (SSP/YMS JSON shapes unknown — DOM scrape covers them. Raw stays in console.)
    } catch (e) {}
  }
  function mergeArcRows(prev, next) {
    const m = {}; (prev || []).forEach(r => m[r.arc] = r);
    next.forEach(r => m[r.arc] = Object.assign(m[r.arc] || {}, r));
    return Object.values(m);
  }

  function hookNetwork() {
    const of = window.fetch;
    window.fetch = function (...args) {
      return of.apply(this, args).then(res => {
        try {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('json')) res.clone().json().then(j => onJsonResponse(args[0], j)).catch(() => {});
        } catch (e) {}
        return res;
      });
    };
    const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this._fuseUrl = u; return oo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', () => {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (ct.includes('json') && this.responseText) onJsonResponse(this._fuseUrl, JSON.parse(this.responseText));
        } catch (e) {}
      });
      return os.apply(this, arguments);
    };
  }

  // ── Stash + flush ─────────────────────────────────────────────────────────────
  function stash(key, rows) {
    if (!rows || !rows.length) return;
    cache[key] = { rows, at: Date.now() };
    updatePanel();
  }
  function sig(rows) { try { return JSON.stringify(rows).length + ':' + rows.length; } catch (e) { return String(Math.random()); } }

  function flush(manual) {
    const keys = Object.keys(cache);
    if (!keys.length) { if (manual) setStatus('nothing captured yet — open the data view', true); return; }
    keys.forEach(key => {
      const entry = cache[key]; if (!entry || !entry.rows.length) return;
      const s = sig(entry.rows);
      if (!manual && lastSentSig[key] === s) return;  // unchanged
      GM_xmlhttpRequest({
        method: 'POST',
        url: PROXY() + '/collect',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ source: key, capturedAt: entry.at, node: NODE, url: location.href, rows: entry.rows }),
        onload: (r) => { lastSentSig[key] = s; setStatus(`sent ${key}: ${entry.rows.length} rows`); },
        onerror: () => setStatus('proxy unreachable — is python proxy.py running?', true),
        ontimeout: () => setStatus('proxy timeout', true),
        timeout: 8000
      });
    });
  }

  // Scrape the right source for this page and stash.
  function scrapeNow() {
    try {
      if (SOURCE === 'yms') stash('yms', scrapeYMS());
      else if (SOURCE === 'ssp') stash('ssp', scrapeSSP());
      else if (SOURCE === 'dockflow') stash('dockflow-arcs', mergeArcRows(cache['dockflow-arcs']?.rows, scrapeArcs()));
    } catch (e) { log('scrape error', e); }
  }

  // ── Panel UI ──────────────────────────────────────────────────────────────────
  let panel, statusEl, countEl;
  function buildPanel() {
    GM_addStyle(`
      #fuse-panel{position:fixed;right:14px;bottom:14px;z-index:2147483647;width:230px;
        font:12px/1.4 -apple-system,Segoe UI,system-ui,sans-serif;color:#14213d;background:#fff;
        border:1px solid #d9e2ec;border-radius:10px;box-shadow:0 8px 28px rgba(20,33,61,.22);overflow:hidden}
      #fuse-panel .hd{background:#14213d;color:#ffb703;font-weight:800;letter-spacing:.06em;padding:7px 10px;display:flex;justify-content:space-between;align-items:center}
      #fuse-panel .hd small{color:rgba(255,255,255,.5);font-weight:600;letter-spacing:0}
      #fuse-panel .bd{padding:9px 10px;display:grid;gap:7px}
      #fuse-panel .cnt{font-size:11px;color:#64748b;min-height:30px}
      #fuse-panel .st{font-size:11px;color:#166534;word-break:break-word}
      #fuse-panel .st.err{color:#991b1b}
      #fuse-panel button{height:28px;border:1px solid #d9e2ec;border-radius:6px;background:#fff;font:600 12px inherit;color:#14213d;cursor:pointer}
      #fuse-panel button.primary{background:#9a3412;border-color:#9a3412;color:#fff}
      #fuse-panel .row{display:flex;gap:6px;align-items:center}
      #fuse-panel input[type=text]{flex:1;height:26px;border:1px solid #d9e2ec;border-radius:6px;padding:0 6px;font:inherit;font-size:11px}
      #fuse-panel label{font-size:11px;color:#64748b;display:flex;align-items:center;gap:5px;cursor:pointer}
    `);
    panel = document.createElement('div');
    panel.id = 'fuse-panel';
    panel.innerHTML = `
      <div class="hd">FUSE COLLECTOR <small>${SOURCE.toUpperCase()}</small></div>
      <div class="bd">
        <div class="cnt" id="fuse-cnt">No captures yet.</div>
        <div class="row">
          <button class="primary" id="fuse-send" style="flex:1">⤴ Send now</button>
          <label><input type="checkbox" id="fuse-auto"> auto</label>
        </div>
        <div class="row"><input type="text" id="fuse-proxy" value="${PROXY()}" title="Proxy base URL"></div>
        <div class="st" id="fuse-st">Ready.</div>
      </div>`;
    document.body.appendChild(panel);
    statusEl = panel.querySelector('#fuse-st');
    countEl = panel.querySelector('#fuse-cnt');
    panel.querySelector('#fuse-send').onclick = () => { scrapeNow(); flush(true); };
    const auto = panel.querySelector('#fuse-auto');
    auto.checked = GM_getValue('fuse_auto', true);
    auto.onchange = () => { GM_setValue('fuse_auto', auto.checked); setAuto(auto.checked); };
    panel.querySelector('#fuse-proxy').onchange = (e) => GM_setValue('fuse_proxy', e.target.value.trim());
    setAuto(auto.checked);
  }
  function setStatus(s, err) { if (statusEl) { statusEl.textContent = s; statusEl.className = 'st' + (err ? ' err' : ''); } log(s); }
  function updatePanel() {
    if (!countEl) return;
    const parts = Object.entries(cache).map(([k, v]) => `${k}: ${v.rows.length}`);
    countEl.textContent = parts.length ? parts.join('  ·  ') : 'No captures yet.';
  }

  let autoTimer = null, scrapeTimer = null;
  function setAuto(on) {
    if (autoTimer) clearInterval(autoTimer);
    if (scrapeTimer) clearInterval(scrapeTimer);
    autoTimer = scrapeTimer = null;
    if (on) {
      scrapeTimer = setInterval(scrapeNow, 5000);
      autoTimer = setInterval(() => flush(false), AUTO_MS);
      scrapeNow();
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  function boot() {
    if (SOURCE === 'unknown') return;
    hookNetwork();
    buildPanel();
    // give the SPA a moment to render, then first scrape
    setTimeout(scrapeNow, 2500);
    log('collector active on', SOURCE, '→', PROXY());
  }
  if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
})();
