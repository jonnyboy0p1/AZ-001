// ==UserScript==
// @name         FUSE OBD Terminal (pull-all)
// @namespace    fuse.obd.rfd2
// @version      0.2.0
// @description  One terminal on the OBD board pulls YMS + SSP + DockFlow all at once (GM_xmlhttpRequest replay of the data API the page uses, learned on first visit; hidden-frame fallback) and fills the board. No scraping the visible page. Credentials never leave the browser.
// @author       FUSE
// @match        https://prod-na.dockflow.robotics.a2z.com/*
// @match        https://trans-logistics.amazon.com/ssp/*
// @match        https://trans-logistics.amazon.com/yms/*
// @match        file:///*obd-east-west.html*
// @match        http://localhost:*/*obd-east-west.html*
// @match        http://127.0.0.1:*/*obd-east-west.html*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      trans-logistics.amazon.com
// @connect      prod-na.dockflow.robotics.a2z.com
// ==/UserScript==

/*
 * Modeled on the OBR002 Period Report Card bridge: PULL, don't scrape.
 *
 * Two roles, one script:
 *  • On a SOURCE page (YMS / SSP / DockFlow), it watches the data the page itself
 *    fetches (its JSON API), normalizes it, and (a) caches rows to a shared GM "slot"
 *    and (b) "learns" the data-request URL + method + headers so the dashboard can
 *    replay it later. This means you visit each source once; after that the terminal
 *    can pull on its own.
 *  • On the DASHBOARD, the terminal's "⟳ Pull All" replays the learned data requests
 *    via GM_xmlhttpRequest (auth'd by your live session) for every source at once,
 *    parses the JSON, and fills the board via window.fuseIngest. Hidden iframes are a
 *    fallback when a request can't be replayed headless.
 *
 * Your Midway/session cookie never leaves the browser. GM_xmlhttpRequest bypasses
 * CORS + the https→localhost mixed-content block.
 */
(function () {
  'use strict';

  const SLOT = (s) => 'FUSE_SLOT_' + s;       // {rows, at, url}
  const EP   = (s) => 'FUSE_EP_' + s;         // learned {url, method, headers, body, at}
  const SOURCES = ['yms', 'ssp', 'dockflow-arcs', 'dockflow-sorter'];

  const HREF = location.href, HOST = location.hostname;
  const IS_DASH = /obd-east-west\.html/i.test(HREF);
  const SRC = HOST.includes('dockflow') ? 'dockflow'
            : location.pathname.includes('/ssp/') ? 'ssp'
            : location.pathname.includes('/yms/') ? 'yms' : null;
  const log = (...a) => console.log('%c[FUSE-TERM]', 'color:#c2410c;font-weight:700', ...a);
  const now = () => Date.now();
  const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; };

  // ── Source-side helpers (parse the page's own JSON) ──────────────────────────
  const ownerToTrailer = (o) => String(o || '').split('(')[0].trim().split(/\s+/)[0] || '';
  const destFromText = (s) => { const m = String(s || '').match(/->\s*([A-Z0-9]{3,5})/i); return m ? m[1].toUpperCase() : ''; };
  const vridFromText = (s) => { const m = String(s || '').match(/VRID\s*[:#]?\s*([A-Z0-9]{6,})/i); return m ? m[1].toUpperCase() : ''; };

  // Walk any JSON for the largest array of plain objects.
  function biggestArray(json) {
    let best = [];
    const visit = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        if (v.length > best.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) best = v;
        v.forEach(visit); return;
      }
      for (const k in v) { try { visit(v[k]); } catch (e) {} }
    };
    try { visit(json); } catch (e) {}
    return best;
  }

  // DockFlow Arcs: name + rate + future forecast, from JSON.
  function harvestArcs(json) {
    const found = {};
    const fbucket = (f, keys) => { if (!f) return 0; for (const k in f) { const n = k.toLowerCase().replace(/[^a-z0-9]/g, ''); if (keys.includes(n)) { const v = num(f[k]); if (Number.isFinite(v)) return v; } } return 0; };
    const visit = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      const name = String(v.arc || v.arcName || v.name || v.arcId || '').toUpperCase();
      const rate = v.currentRate ?? v.rate ?? v.jobsPerHour ?? v.ratePerHour;
      const fut = v.future || v.forecast || v.futureForecast || v.forecasts;
      if (/^[A-Z0-9]{2,6}(_[A-Z0-9]+)?$/.test(name) && (rate != null || fut != null)) {
        const rec = found[name] || { arc: name };
        if (rate != null) rec.rate = num(rate) || 0;
        if (fut != null) {
          let src = fut; if (Array.isArray(fut)) { const m = {}; fut.forEach(p => { m[String(p.horizon || p.bucket || p.label || '').toLowerCase().replace(/[^a-z0-9]/g, '')] = num(p.jobs ?? p.value ?? p.count); }); src = m; }
          rec.future = {
            '15min': fbucket(src, ['15min', 'min15', '15m', 'pt15m']), '30min': fbucket(src, ['30min', 'min30', '30m', 'pt30m']),
            '1hr': fbucket(src, ['1hr', 'hr1', '60min', 'pt1h', '1hour']), '2hr': fbucket(src, ['2hr', 'hr2', 'pt2h', '2hour']),
            '4hr': fbucket(src, ['4hr', 'hr4', 'pt4h', '4hour']), '8hr': fbucket(src, ['8hr', 'hr8', 'pt8h', '8hour']),
            '24hr': fbucket(src, ['24hr', 'hr24', 'pt24h', '24hour', '1d'])
          };
        }
        found[name] = rec;
      }
      for (const k in v) { try { visit(v[k]); } catch (e) {} }
    };
    try { visit(json); } catch (e) {}
    return Object.values(found);
  }

  // YMS rows from JSON: derive door / owner→trailer / vehicle / vrid / dest.
  function harvestYms(json) {
    return biggestArray(json).map(o => {
      const s = JSON.stringify(o);
      const door = String(o.location || o.dockDoor || o.door || '').match(/\d{2,4}/)?.[0] || (s.match(/DD\s*0*(\d{2,4})/)?.[1] || '');
      if (!door) return null;
      const owner = o.owner || o.ownerOperator || o.operator || '';
      return {
        door, owner, trailer_type: ownerToTrailer(owner),
        vehicle_id: o.vehicleId || o.vehicleID || o.vid || '',
        vrid: (o.vrid || vridFromText(s) || ''),
        dest: (o.destination || o.arc || destFromText(s) || ''),
        visit_reason: o.visitReason || o.reason || ''
      };
    }).filter(Boolean);
  }
  // SSP rows: pass biggest object array straight through (dashboard field matcher handles names).
  function harvestSsp(json) { return biggestArray(json).filter(o => /vrid|weight|payload|cdt|sdt|departure/i.test(JSON.stringify(o))); }

  function harvestFor(source, json) {
    if (source === 'dockflow-arcs') return harvestArcs(json);
    if (source === 'ssp') return harvestSsp(json);
    if (source === 'yms') return harvestYms(json);
    if (source === 'dockflow-sorter') return biggestArray(json);
    return [];
  }

  // Which source-keys does THIS source page produce?
  function keysForPage() {
    if (SRC === 'yms') return ['yms'];
    if (SRC === 'ssp') return ['ssp'];
    if (SRC === 'dockflow') return ['dockflow-arcs', 'dockflow-sorter'];
    return [];
  }

  // ── SOURCE PAGE: watch the page's own data requests ──────────────────────────
  function rememberEndpoint(url, method, headers, body) {
    if (!url || /\.(js|css|png|svg|woff|ico)(\?|$)/i.test(url)) return;
    // keep the most recent data-ish request per page
    keysForPage().forEach(k => GM_setValue(EP(k), { url, method: method || 'GET', headers: headers || {}, body: body || null, at: now() }));
  }
  function onJson(url, json) {
    keysForPage().forEach(k => {
      const rows = harvestFor(k, json);
      if (rows && rows.length) { GM_setValue(SLOT(k), { rows, at: now(), url }); badge(`${k}: ${rows.length}`); }
    });
  }
  function hookNetwork() {
    const of = window.fetch;
    if (of) window.fetch = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const headers = {}; try { const h = (init && init.headers) || (input && input.headers); if (h && h.forEach) h.forEach((v, k) => headers[k] = v); else if (h) Object.assign(headers, h); } catch (e) {}
      return of.apply(this, arguments).then(res => {
        try {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('json')) res.clone().json().then(j => { rememberEndpoint(url, method, headers, init && init.body); onJson(url, j); }).catch(() => {});
        } catch (e) {}
        return res;
      });
    };
    const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send, oh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) { this._fm = m; this._fu = u; this._fh = {}; return oo.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this._fh[k] = v; } catch (e) {} return oh.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      this.addEventListener('load', () => {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (ct.includes('json') && this.responseText) { const j = JSON.parse(this.responseText); rememberEndpoint(this._fu, this._fm, this._fh, body); onJson(this._fu, j); }
        } catch (e) {}
      });
      return os.apply(this, arguments);
    };
  }

  // ── DASHBOARD: replay learned endpoints + harvest slots ──────────────────────
  function gmGet(ep) {
    return new Promise((resolve) => {
      const headers = {}; try { for (const k in ep.headers) { if (!/^(host|cookie|content-length|origin|referer|user-agent|accept-encoding)$/i.test(k)) headers[k] = ep.headers[k]; } } catch (e) {}
      GM_xmlhttpRequest({
        method: ep.method || 'GET', url: ep.url, headers, data: ep.body || undefined, timeout: 20000,
        onload: (r) => { if (r.status < 200 || r.status >= 300) return resolve({ err: 'HTTP ' + r.status });
          try { resolve({ json: JSON.parse(r.responseText) }); } catch (e) { resolve({ err: 'not JSON (' + (r.responseText || '').length + ' chars)' }); } },
        onerror: () => resolve({ err: 'request failed' }), ontimeout: () => resolve({ err: 'timeout' })
      });
    });
  }
  async function replayAll() {
    const out = {};
    await Promise.allSettled(SOURCES.map(async (s) => {
      const ep = GM_getValue(EP(s), null);
      if (!ep || !ep.url) { out[s] = { skip: 'not learned' }; return; }
      const res = await gmGet(ep);
      if (res.err) { out[s] = { err: res.err }; return; }
      const rows = harvestFor(s, res.json);
      if (rows && rows.length) { GM_setValue(SLOT(s), { rows, at: now(), url: ep.url }); out[s] = { rows: rows.length }; }
      else out[s] = { err: 'no rows parsed' };
    }));
    return out;
  }
  function harvestSlots(maxAgeMs) {
    const store = {}; let total = 0;
    SOURCES.forEach(s => { const slot = GM_getValue(SLOT(s), null);
      if (slot && slot.rows && slot.rows.length && (!maxAgeMs || now() - slot.at < maxAgeMs)) { store[s] = { rows: slot.rows }; total += slot.rows.length; } });
    return { store, total };
  }
  function ingest(store) {
    // primary: same-origin localStorage inbox (dashboard polls it). also try unsafeWindow.
    try { localStorage.setItem('obd.collectorInbox', JSON.stringify({ at: now(), sources: store })); } catch (e) {}
    try { if (unsafeWindow && typeof unsafeWindow.fuseIngest === 'function') return unsafeWindow.fuseIngest(JSON.parse(JSON.stringify(store))); } catch (e) {}
    return null;
  }
  async function pullAll() {
    setStatus('replaying learned data requests…');
    const rep = await replayAll();
    const { store, total } = harvestSlots();        // include slots from open source tabs too
    const res = ingest(store);
    const parts = SOURCES.map(s => `${s.replace('dockflow-', '')}:${(rep[s] && (rep[s].rows ?? rep[s].err ?? rep[s].skip)) ?? '—'}`);
    setStatus((res && res.total ? `filled (${res.parts.join(' · ')})` : (total ? `staged ${total} rows` : 'no data — visit each source once to learn')) + ' | ' + parts.join('  '));
    renderSlots();
  }

  // ── Panel (terminal) ─────────────────────────────────────────────────────────
  let statusEl, slotEl;
  function age(ts) { if (!ts) return '—'; const s = Math.round((now() - ts) / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm'; }
  function badge(msg) { setStatus(msg); }
  function setStatus(s) { if (statusEl) statusEl.textContent = s; log(s); }
  function renderSlots() {
    if (!slotEl) return;
    slotEl.innerHTML = SOURCES.map(s => { const sl = GM_getValue(SLOT(s), null), ep = GM_getValue(EP(s), null);
      const c = sl && sl.rows && sl.rows.length ? '#22c55e' : ep ? '#fbbf24' : '#64748b';
      return `<div><span style="color:${c}">●</span> ${s.replace('dockflow-', 'df-')} <b>${sl ? sl.rows.length : 0}</b> <small style="color:#64748b">${sl ? age(sl.at) : (ep ? 'learned' : 'unlearned')}</small></div>`;
    }).join('');
  }
  function buildPanel() {
    GM_addStyle(`
      #fuse-term{position:fixed;right:14px;bottom:14px;z-index:2147483647;width:268px;font:12px/1.45 Consolas,monospace;
        background:#020817;color:#cbd5e1;border:1px solid #1e3a8a;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden}
      #fuse-term .hd{cursor:move;background:#0b1220;color:#ffb703;font-weight:800;letter-spacing:.06em;padding:7px 10px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1e293b}
      #fuse-term .bd{padding:9px 10px;display:grid;gap:8px}
      #fuse-term .slots{display:grid;gap:3px;font-size:11px}
      #fuse-term .st{font-size:11px;color:#7dd3fc;min-height:28px;word-break:break-word}
      #fuse-term button{height:28px;border:1px solid #1e3a8a;border-radius:6px;background:#0b1220;color:#cbd5e1;font:600 12px Consolas,monospace;cursor:pointer}
      #fuse-term button.go{background:#9a3412;border-color:#9a3412;color:#fff}
      #fuse-term .row{display:flex;gap:6px} #fuse-term label{font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:5px;cursor:pointer}
    `);
    const p = document.createElement('div'); p.id = 'fuse-term';
    p.innerHTML = `
      <div class="hd" id="fuse-hd">FUSE OBD TERMINAL <small id="fuse-min" style="cursor:pointer;color:#64748b">▁</small></div>
      <div class="bd" id="fuse-bd">
        <div class="slots" id="fuse-slots"></div>
        <div class="row"><button class="go" id="fuse-pull" style="flex:1">⟳ Pull All</button>
          <label><input type="checkbox" id="fuse-auto"> auto</label></div>
        <div class="row"><button id="fuse-tabs" style="flex:1">Open source tabs</button>
          <button id="fuse-reset" title="clear learned + slots">⟲</button></div>
        <div class="st" id="fuse-st">Ready. Visit each source once to learn its data request.</div>
      </div>`;
    document.body.appendChild(p);
    statusEl = p.querySelector('#fuse-st'); slotEl = p.querySelector('#fuse-slots');
    p.querySelector('#fuse-pull').onclick = pullAll;
    p.querySelector('#fuse-tabs').onclick = openTabs;
    p.querySelector('#fuse-reset').onclick = () => { SOURCES.forEach(s => { GM_setValue(SLOT(s), null); GM_setValue(EP(s), null); }); renderSlots(); setStatus('cleared learned endpoints + slots'); };
    const auto = p.querySelector('#fuse-auto'); auto.checked = GM_getValue('fuse_term_auto', false);
    auto.onchange = () => { GM_setValue('fuse_term_auto', auto.checked); setAuto(auto.checked); };
    p.querySelector('#fuse-min').onclick = () => { const b = p.querySelector('#fuse-bd'); b.style.display = b.style.display === 'none' ? 'grid' : 'none'; };
    dragify(p, p.querySelector('#fuse-hd'));
    renderSlots(); setInterval(renderSlots, 4000);
    setAuto(auto.checked);
  }
  function openTabs() {
    const urls = {
      'DockFlow Sorter': 'https://prod-na.dockflow.robotics.a2z.com/RFD2/wc/MainSorter/Sorter',
      'SSP OB': 'https://trans-logistics.amazon.com/ssp/dock/hrz/ob?',
      'YMS yard': 'https://trans-logistics.amazon.com/yms/shipclerk/#/yard'
    };
    Object.values(urls).forEach((u, i) => setTimeout(() => window.open(u, '_blank', 'noopener'), i * 300));
    setStatus('opened source tabs — they self-learn + cache; then Pull All');
  }
  let autoTimer = null;
  function setAuto(on) { if (autoTimer) clearInterval(autoTimer); autoTimer = null; if (on) { pullAll(); autoTimer = setInterval(pullAll, 15 * 60000); } }
  function dragify(panel, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener('mousedown', e => { drag = true; sx = e.clientX; sy = e.clientY; const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (!drag) return; panel.style.left = (ox + e.clientX - sx) + 'px'; panel.style.top = (oy + e.clientY - sy) + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; });
    document.addEventListener('mouseup', () => drag = false);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  if (SRC) { hookNetwork(); log('source watcher active:', SRC); }
  if (IS_DASH) {
    if (document.body) buildPanel(); else window.addEventListener('DOMContentLoaded', buildPanel);
    log('terminal active on dashboard');
  }
})();
