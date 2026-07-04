// ==UserScript==
// @name         OB EOL Bridge — Fluid + Dock Pallet Loader (RFD2)
// @namespace    ob-period-report.bridge
// @version      1.4.0
// @description  Floating panel that collects OB goals (Fluid/MP/RWC/Pallets) and EOL Dock Pallet Loader actuals (Pallets Loaded, PL Rate, HC) and feeds the OB Period Report dashboard. Excludes Manual Palletize HC & Rate.
// @author       you
// @match        https://fclm-portal.amazon.com/*
// @match        https://*.amazon.com/*
// @match        https://*.amazon.dev/*
// @match        file:///*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      fclm-portal.amazon.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.4.0';
  const SHARED_KEY = 'OB_BRIDGE_SHARED_PAYLOAD';                // GM store shared across tabs
  const POS_KEY = 'OB_EOL_BRIDGE_POS';                          // panel position (per page)
  const MIN_KEY = 'OB_EOL_BRIDGE_MIN';                          // panel minimized flag
  const LS_KEYS = ['OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE', 'OB_PERIOD_REPORT_CARD_BRIDGE'];

  // ---------------- number / cell helpers ----------------
  const fmt = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const firstNum = (t) => { const m = String(t ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : 0; };
  const cellText = (c) => (c?.textContent || '').trim().replace(/\s+/g, ' ');

  function rowLabel(tr) {
    for (const c of tr.querySelectorAll('th,td')) {
      const t = cellText(c).toLowerCase();
      if (/[a-z]/.test(t)) return t;
    }
    return '';
  }

  function lastNumericCells(tr, count) {
    const cs = tr.querySelectorAll('th,td'), out = [];
    for (let i = cs.length - 1; i >= 0 && out.length < count; i--) {
      const t = cellText(cs[i]);
      if (/\d/.test(t)) out.push(firstNum(t));
    }
    return out;
  }

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's ago';
  }

  // ---------------- OB goal-column scrape (right-hand targets) ----------------
  const OB_GOAL_ROWS = {
    'fluid load jobs': 'fluidLoadJobs',
    'manual palletize jobs': 'manualPalletizeJobs',
    'rwc jobs': 'rwcJobs',
    'fluid load rate': 'fluidLoadRate',
    'fluid load (incl. wall builder) hc': 'fluidLoadHC',
    'pallets loaded': 'palletsLoadedJobs',
    'pallets loaded rate': 'palletsLoadedRate',
    'dock pallet loader hc': 'dockPalletLoaderHC'
    // Manual Palletize Rate & HC intentionally excluded.
  };

  function scrapeObGoals(root = document) {
    const neo = {};
    for (const tr of root.querySelectorAll('tr')) {
      const field = OB_GOAL_ROWS[rowLabel(tr)];
      if (!field) continue;
      const n = lastNumericCells(tr, 1);
      if (n.length) neo[field] = n[0];
    }
    return Object.keys(neo).length ? neo : null;
  }

  // ---------------- EOL: Dock Pallet Loader actuals ----------------
  function scrapeDock(root = document) {
    const hasUph = [...root.querySelectorAll('th')].some((th) => /uph/i.test(cellText(th)));
    if (!hasUph) return null;

    let totalRow = root.querySelector('tr.total-row, tr.total, tfoot tr');
    if (!totalRow) {
      const rows = root.querySelectorAll('table tr');
      for (let i = rows.length - 1; i >= 0; i--) {
        if (/^total\b/i.test(rowLabel(rows[i]))) { totalRow = rows[i]; break; }
      }
    }
    if (!totalRow) return null;

    const nums = lastNumericCells(totalRow, 2);                 // [Pallet UPH, Pallet UNIT]
    if (nums.length < 2) return null;

    let hc = 0;                                                 // one login link per AA row
    for (const tr of root.querySelectorAll('table tr')) {
      if (tr.querySelector('a') && !/^total\b/i.test(rowLabel(tr))) hc++;
    }
    return { palletsLoaded: nums[1], rate: nums[0], hc };
  }

  // ---------------- shared GM store + relay ----------------
  function readShared() {
    try { return JSON.parse(GM_getValue(SHARED_KEY, '{}')) || {}; } catch (e) { return {}; }
  }

  function mergeStore(partial) {
    const cur = readShared();
    const next = { source: 'tampermonkey', updatedAt: Date.now(), neo: cur.neo, dock: cur.dock, neoAt: cur.neoAt, dockAt: cur.dockAt };
    if (partial.neo) { next.neo = Object.assign({}, cur.neo, partial.neo); next.neoAt = Date.now(); }
    if (partial.dock) { next.dock = Object.assign({}, cur.dock, partial.dock); next.dockAt = Date.now(); }
    GM_setValue(SHARED_KEY, JSON.stringify(next));
    return next;
  }

  function isDashboard() {
    return !!(document.getElementById('fclmSourceLinks') || document.getElementById('periodPulse') || document.getElementById('bridgeJson'));
  }

  function relayToDashboard(payload) {
    if (!payload || (!payload.neo && !payload.dock)) return;
    try { LS_KEYS.forEach((k) => localStorage.setItem(k, JSON.stringify(payload))); } catch (e) {}
    try { window.postMessage({ type: 'PRC_V2_HYBRID_DATA', payload }, '*'); } catch (e) {}
  }

  // ---------------- Dock fetch (dashboard side, via Midway session) ----------------
  const pad = (n) => String(n).padStart(2, '0');

  function buildDockUrl(shiftDate, includeMET) {
    const [y, m, d] = String(shiftDate || '').split('-').map(Number);
    if (!y) return '';
    const nd = new Date(Date.UTC(y, m - 1, d + 1, 12));         // shift ends the next calendar day
    const u = new URL('https://fclm-portal.amazon.com/reports/functionRollup');
    u.search = new URLSearchParams({
      reportFormat: 'HTML', warehouseId: 'RFD2', processId: '1003022', maxIntradayDays: '1', spanType: 'Intraday',
      startDateIntraday: y + '/' + pad(m) + '/' + pad(d), startHourIntraday: '19', startMinuteIntraday: '0',
      endDateIntraday: nd.getUTCFullYear() + '/' + pad(nd.getUTCMonth() + 1) + '/' + pad(nd.getUTCDate()),
      endHourIntraday: includeMET ? '6' : '5', endMinuteIntraday: '30'
    }).toString();
    return u.toString();
  }

  const dashShiftDate = () => document.getElementById('shiftDate')?.value || new Date().toISOString().slice(0, 10);
  const dashMET = () => document.getElementById('useMET')?.value === 'true';

  let dockBusy = false;
  function fetchDock(cb) {
    if (dockBusy || typeof GM_xmlhttpRequest === 'undefined') { cb && cb(null); return; }
    const url = buildDockUrl(dashShiftDate(), dashMET());
    if (!url) { cb && cb(null); return; }
    dockBusy = true;
    const done = (result) => { dockBusy = false; cb && cb(result); };
    GM_xmlhttpRequest({
      method: 'GET', url, timeout: 25000,
      onload(r) {
        if (r.status < 200 || r.status >= 300) { done(null); return; }
        try { done(scrapeDock(new DOMParser().parseFromString(r.responseText, 'text/html'))); } catch (e) { done(null); }
      },
      onerror: () => done(null),
      ontimeout: () => done(null)
    });
  }

  // ---------------- Floating panel UI ----------------
  function injectStyle() {
    if (document.getElementById('obxStyle')) return;
    const s = document.createElement('style');
    s.id = 'obxStyle';
    s.textContent = `
#obEolBridge{position:fixed;z-index:2147483647;top:80px;left:16px;width:300px;background:#0b1220;color:#e8eefb;border:1px solid #233248;border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.5);font:500 12px/1.35 Inter,Segoe UI,Arial,sans-serif;overflow:hidden;}
#obEolBridge .obx-head{display:flex;flex-direction:column;gap:2px;padding:10px 12px;background:#101a2e;cursor:move;border-bottom:1px solid #233248;}
#obEolBridge .obx-title{font-weight:900;font-size:13px;}
#obEolBridge .obx-ver{color:#9aa8bd;font-weight:700;font-size:10px;}
#obEolBridge .obx-sub{color:#9aa8bd;font-size:10px;}
#obEolBridge .obx-btns{display:flex;gap:6px;padding:8px 12px 0;}
#obEolBridge button{flex:1;border:0;border-radius:8px;padding:8px 10px;font-weight:900;cursor:pointer;font-size:12px;}
#obEolBridge .obx-collect{background:#2f6fea;color:#fff;}
#obEolBridge .obx-reset,#obEolBridge .obx-min{flex:0 0 auto;background:#1e293b;color:#cdd7ea;}
#obEolBridge .obx-status{padding:7px 12px 2px;color:#72f0a4;font-size:11px;font-weight:700;}
#obEolBridge .obx-sec{margin:8px 12px 2px;color:#7aa2ff;font-size:10px;font-weight:950;text-transform:uppercase;letter-spacing:.06em;}
#obEolBridge .obx-row{display:flex;justify-content:space-between;gap:10px;padding:4px 12px;}
#obEolBridge .obx-row span{color:#9aa8bd;}
#obEolBridge .obx-row b{color:#e8eefb;font-variant-numeric:tabular-nums;}
#obEolBridge .obx-row b.g{color:#72f0a4;}
#obEolBridge .obx-when{padding:2px 12px 4px;color:#6b7a90;font-size:10px;text-align:right;}
#obEolBridge .obx-body{padding-bottom:10px;}
#obEolBridge.min .obx-body{display:none;}`;
    (document.head || document.documentElement).appendChild(s);
  }

  function buildPanel() {
    if (document.getElementById('obEolBridge')) return;
    injectStyle();
    const box = document.createElement('div');
    box.id = 'obEolBridge';
    box.innerHTML = `
<div class="obx-head" id="obxDrag">
  <div class="obx-title">OB EOL Bridge <span class="obx-ver">v${VERSION}</span></div>
  <div class="obx-sub" id="obxContext">—</div>
</div>
<div class="obx-btns">
  <button class="obx-collect" id="obxCollect">↻ Collect / Pull Now</button>
  <button class="obx-reset" id="obxReset" title="Clear collected data and panel position">⟲</button>
  <button class="obx-min" id="obxMin">–</button>
</div>
<div class="obx-status" id="obxStatus">Ready.</div>
<div class="obx-body">
  <div class="obx-sec">EOL — Dock Pallet Loader</div>
  <div class="obx-row"><span>Pallets Loaded</span><b id="obxPallets">—</b></div>
  <div class="obx-row"><span>PL Rate</span><b id="obxRate">—</b></div>
  <div class="obx-row"><span>HC (AAs)</span><b id="obxHc">—</b></div>
  <div class="obx-when" id="obxDockWhen"></div>
  <div class="obx-sec">FCLM Goals (NEO / OB report)</div>
  <div class="obx-row"><span>Fluid</span><b id="obxFluid">—</b></div>
  <div class="obx-row"><span>MP</span><b id="obxMp">—</b></div>
  <div class="obx-row"><span>RWC</span><b id="obxRwc">—</b></div>
  <div class="obx-row"><span>Pallets Goal</span><b id="obxPalletsGoal">—</b></div>
  <div class="obx-row"><span>PL Rate Goal</span><b id="obxRateGoal">—</b></div>
  <div class="obx-when" id="obxNeoWhen"></div>
</div>`;
    document.body.appendChild(box);

    // restore position + minimized
    try {
      const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (pos) { box.style.left = pos.left; box.style.top = pos.top; }
    } catch (e) {}
    if (localStorage.getItem(MIN_KEY) === '1') box.classList.add('min');

    document.getElementById('obxCollect').addEventListener('click', collect);
    document.getElementById('obxReset').addEventListener('click', resetBridge);
    document.getElementById('obxMin').addEventListener('click', () => {
      box.classList.toggle('min');
      localStorage.setItem(MIN_KEY, box.classList.contains('min') ? '1' : '0');
    });
    makeDraggable(box, document.getElementById('obxDrag'));
    renderPanel();
  }

  function makeDraggable(box, handle) {
    let ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = box.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      box.style.left = Math.max(0, e.clientX - ox) + 'px';
      box.style.top = Math.max(0, e.clientY - oy) + 'px';
      box.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      try { localStorage.setItem(POS_KEY, JSON.stringify({ left: box.style.left, top: box.style.top })); } catch (e) {}
    });
  }

  function setText(id, t, green) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = t;
    el.className = green ? 'g' : '';
  }

  function status(msg, green) {
    const el = document.getElementById('obxStatus');
    if (el) { el.textContent = msg; el.style.color = green === false ? '#ff8f9a' : '#72f0a4'; }
  }

  function renderPanel() {
    const s = readShared(), dock = s.dock || {}, neo = s.neo || {};
    setText('obxPallets', dock.palletsLoaded != null ? fmt(dock.palletsLoaded) : '—', dock.palletsLoaded != null);
    setText('obxRate', dock.rate != null ? fmt(dock.rate, 2) : '—', dock.rate != null);
    setText('obxHc', dock.hc != null ? fmt(dock.hc) : '—', dock.hc != null);
    const dw = document.getElementById('obxDockWhen');
    if (dw) dw.textContent = s.dockAt ? 'updated ' + ago(s.dockAt) : 'not collected yet';
    setText('obxFluid', neo.fluidLoadJobs != null ? fmt(neo.fluidLoadJobs) : '—', neo.fluidLoadJobs != null);
    setText('obxMp', neo.manualPalletizeJobs != null ? fmt(neo.manualPalletizeJobs) : '—', neo.manualPalletizeJobs != null);
    setText('obxRwc', neo.rwcJobs != null ? fmt(neo.rwcJobs) : '—', neo.rwcJobs != null);
    setText('obxPalletsGoal', neo.palletsLoadedJobs != null ? fmt(neo.palletsLoadedJobs) : '—', neo.palletsLoadedJobs != null);
    setText('obxRateGoal', neo.palletsLoadedRate != null ? fmt(neo.palletsLoadedRate, 2) : '—', neo.palletsLoadedRate != null);
    const nw = document.getElementById('obxNeoWhen');
    if (nw) nw.textContent = s.neoAt ? 'updated ' + ago(s.neoAt) : 'not collected yet';
    const ctx = document.getElementById('obxContext');
    if (ctx) {
      ctx.textContent = isDashboard() ? 'On dashboard — pulls EOL from FCLM'
        : scrapeDock(document) ? 'On Dock Pallet Loader report'
        : scrapeObGoals(document) ? 'On OB goals report'
        : 'Open a report or the dashboard';
    }
  }

  function collect() {
    const onDock = scrapeDock(document), onGoals = scrapeObGoals(document);
    if (onDock) {
      relayToDashboard(mergeStore({ dock: onDock }));
      status('Collected EOL: ' + fmt(onDock.palletsLoaded) + ' @ ' + fmt(onDock.rate, 2) + ' · HC ' + fmt(onDock.hc));
      renderPanel();
      return;
    }
    if (onGoals) {
      relayToDashboard(mergeStore({ neo: onGoals }));
      status('Collected ' + Object.keys(onGoals).length + ' goal field(s)');
      renderPanel();
      return;
    }
    if (isDashboard()) {
      status('Pulling EOL from FCLM…');
      fetchDock((dock) => {
        if (dock) {
          relayToDashboard(mergeStore({ dock }));
          status('Pulled EOL: ' + fmt(dock.palletsLoaded) + ' @ ' + fmt(dock.rate, 2) + ' · HC ' + fmt(dock.hc));
        } else {
          status('Could not pull Dock report (check Midway login).', false);
        }
        renderPanel();
      });
      return;
    }
    status('Open the Dock report, the OB goals page, or the dashboard.', false);
  }

  function resetBridge() {
    try { GM_setValue(SHARED_KEY, '{}'); } catch (e) {}
    try { localStorage.removeItem(POS_KEY); localStorage.removeItem(MIN_KEY); } catch (e) {}
    const box = document.getElementById('obEolBridge');
    if (box) { box.classList.remove('min'); box.style.left = '16px'; box.style.top = '80px'; }
    status('Bridge reset — collected data cleared.');
    renderPanel();
  }

  // ---------------- boot ----------------
  function start() {
    buildPanel();
    setInterval(renderPanel, 15000);                            // refresh the "ago" times
    try { GM_addValueChangeListener(SHARED_KEY, renderPanel); } catch (e) {}

    if (isDashboard()) {
      try { window.postMessage({ type: 'PRC_V2_LIVE_BRIDGE_READY', version: VERSION }, '*'); } catch (e) {}
      relayToDashboard(readShared());                           // push whatever's already collected
      window.addEventListener('message', (ev) => {
        const t = ev.data && ev.data.type;
        if (t === 'PRC_V2_HYBRID_SOURCE_PULL' || t === 'PRC_V2_HYBRID_FCLM_PULL' || t === 'PRC_V2_HYBRID_PULL_REQUEST') {
          relayToDashboard(readShared());
          fetchDock((dock) => { if (dock) { relayToDashboard(mergeStore({ dock })); renderPanel(); } });
        }
      });
      return;
    }
    // report pages: auto-collect once if this page has data
    if (scrapeDock(document) || scrapeObGoals(document)) collect();
  }

  if (document.body) start(); else window.addEventListener('DOMContentLoaded', start);
})();
