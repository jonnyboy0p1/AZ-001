// ==UserScript==
// @name         OB Period Report — FCLM/NEO Bridge (RFD2)
// @namespace    ob-period-report.bridge
// @version      1.1.0
// @description  Scrapes the OB goal column (right-hand targets) + the Dock Pallet Loader actuals and feeds them to the OB Period Report dashboard. Excludes Manual Palletize HC & Rate.
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

/*
  HOW IT WORKS
  ------------
  ONE script runs on two kinds of pages:

  1) Report pages (the OB goal report, and the Dock Pallet Loader report):
       - Scrapes the numbers and saves them to Tampermonkey shared storage
         (GM_setValue) which is shared across ALL tabs/origins.
       - Shows a "Push to OB Dashboard" button + auto-pushes on load.

  2) The dashboard page (your index.html, wherever you open it):
       - Reads the shared storage and relays it to the dashboard via the same
         protocol the dashboard already listens for:
           window.postMessage({type:'PRC_V2_HYBRID_DATA', payload}, '*')
           localStorage['OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE'] = payload
       - Re-pushes whenever a report tab scrapes new data (live), and when the
         dashboard asks for a pull it also fetches the Dock report directly via
         GM_xmlhttpRequest (uses your logged-in Midway session).

  WHAT IT PULLS  (all goal numbers come from the RIGHT-HAND target column)
       Fluid Load Jobs ............................ neo.fluidLoadJobs
       Manual Palletize Jobs ...................... neo.manualPalletizeJobs
       RWC Jobs ................................... neo.rwcJobs
       Fluid Load Rate ........................... neo.fluidLoadRate
       Fluid Load (incl. Wall Builder) HC ........ neo.fluidLoadHC      (first #)
       Pallets Loaded ............................ neo.palletsLoadedJobs
       Pallets Loaded Rate ....................... neo.palletsLoadedRate
       Dock Pallet Loader HC ..................... neo.dockPalletLoaderHC (first #)
       (Manual Palletize Rate & Manual Palletize HC are intentionally skipped.)

       Dock Pallet Loader report (actuals):
       Pallet UNIT (total) ....................... dock.palletsLoaded   (e.g. 1037)
       Pallet UPH  (total) ....................... dock.rate            (e.g. 28.47)
       loader row count .......................... dock.hc              (best effort)

  NOTE: If your dashboard opens from a URL not covered above, add it to @match.
*/

(function () {
  'use strict';

  var SHARED_KEY = 'OB_BRIDGE_SHARED_PAYLOAD'; // GM storage, shared across tabs/origins
  var LS_KEYS = ['OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE', 'OB_PERIOD_REPORT_CARD_BRIDGE'];
  var VERSION = '1.1.0';

  // ---------------- number / cell helpers ----------------
  function firstNum(t) {
    var m = String(t == null ? '' : t).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }
  function cellText(c) {
    return (c && c.textContent ? c.textContent : '').trim().replace(/\s+/g, ' ');
  }
  function rowLabel(tr) {
    var cells = tr.querySelectorAll('th,td');
    for (var i = 0; i < cells.length; i++) {
      var t = cellText(cells[i]).toLowerCase();
      if (/[a-z]/.test(t)) return t;
    }
    return '';
  }
  // last `count` cells (scanning right -> left) whose TEXT contains a digit.
  function lastNumericCells(tr, count) {
    var cells = tr.querySelectorAll('th,td');
    var out = [];
    for (var i = cells.length - 1; i >= 0 && out.length < count; i--) {
      var t = cellText(cells[i]);
      if (/\d/.test(t)) out.push(firstNum(t));
    }
    return out; // ordered right -> left
  }

  // ---------------- OB goal-column scrape ----------------
  var OB_GOAL_ROWS = {
    'fluid load jobs': 'fluidLoadJobs',
    'manual palletize jobs': 'manualPalletizeJobs',
    'rwc jobs': 'rwcJobs',
    'fluid load rate': 'fluidLoadRate',
    'fluid load (incl. wall builder) hc': 'fluidLoadHC',
    'pallets loaded': 'palletsLoadedJobs',
    'pallets loaded rate': 'palletsLoadedRate',
    'dock pallet loader hc': 'dockPalletLoaderHC'
    // Manual Palletize Rate & Manual Palletize HC intentionally excluded.
  };
  function scrapeObGoals(root) {
    root = root || document;
    var neo = {};
    var rows = root.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var field = OB_GOAL_ROWS[rowLabel(rows[i])];
      if (!field) continue;
      var nums = lastNumericCells(rows[i], 1); // right-hand goal value
      if (nums.length) neo[field] = nums[0];
    }
    return Object.keys(neo).length ? neo : null;
  }

  // ---------------- Dock Pallet Loader actuals scrape ----------------
  function scrapeDock(root) {
    root = root || document;
    // The Dock function rollup is the only page with "UPH" column headers.
    var ths = root.querySelectorAll('th');
    var hasUph = false;
    for (var i = 0; i < ths.length; i++) { if (/uph/i.test(cellText(ths[i]))) { hasUph = true; break; } }
    if (!hasUph) return null;

    // Find the totals row.
    var totalRow = root.querySelector('tr.total-row, tr.total, tfoot tr');
    if (!totalRow) {
      var rows = root.querySelectorAll('table tr');
      for (var j = rows.length - 1; j >= 0; j--) {
        if (/^total\b/i.test(rowLabel(rows[j]))) { totalRow = rows[j]; break; }
      }
    }
    if (!totalRow) return null;

    // Rightmost group is "Pallet": ... | Pallet UNIT | Pallet UPH.
    var nums = lastNumericCells(totalRow, 2); // [Pallet UPH, Pallet UNIT]
    if (nums.length < 2) return null;
    var dock = { palletsLoaded: nums[1], rate: nums[0] };

    // HC ~= number of associate data rows (rows with a person link). Best effort.
    var bodyRows = root.querySelectorAll('table tr');
    var hc = 0;
    for (var k = 0; k < bodyRows.length; k++) {
      if (bodyRows[k].querySelector('a') && !/^total\b/i.test(rowLabel(bodyRows[k]))) hc++;
    }
    if (hc) dock.hc = hc;
    return dock;
  }

  // ---------------- shared storage (merge) ----------------
  function readShared() {
    try { return JSON.parse(GM_getValue(SHARED_KEY, '{}')) || {}; } catch (e) { return {}; }
  }
  function mergeStore(partial) {
    var cur = readShared();
    var next = { source: 'tampermonkey', updatedAt: Date.now() };
    if (cur.neo) next.neo = cur.neo;
    if (cur.dock) next.dock = cur.dock;
    if (partial.neo) next.neo = Object.assign({}, cur.neo, partial.neo);
    if (partial.dock) next.dock = Object.assign({}, cur.dock, partial.dock);
    GM_setValue(SHARED_KEY, JSON.stringify(next));
    return next;
  }

  // ---------------- dashboard relay ----------------
  function isDashboard() {
    return !!(document.getElementById('fclmSourceLinks') ||
              document.getElementById('periodPulse') ||
              document.getElementById('bridgeJson'));
  }
  function relayToDashboard(payload) {
    if (!payload || (!payload.neo && !payload.dock)) return;
    try { LS_KEYS.forEach(function (k) { localStorage.setItem(k, JSON.stringify(payload)); }); } catch (e) {}
    try { window.postMessage({ type: 'PRC_V2_HYBRID_DATA', payload: payload }, '*'); } catch (e) {}
  }

  // ---------------- Dock fetch (dashboard side, via Midway session) ----------------
  function pad(n) { return String(n).padStart(2, '0'); }
  function buildDockUrl(shiftDate, includeMET) {
    var p = String(shiftDate || '').split('-').map(Number);
    var y = p[0], m = p[1], d = p[2];
    if (!y) return '';
    var nd = new Date(Date.UTC(y, m - 1, d + 1, 12));
    var u = new URL('https://fclm-portal.amazon.com/reports/functionRollup');
    u.searchParams.set('reportFormat', 'HTML');
    u.searchParams.set('warehouseId', 'RFD2');
    u.searchParams.set('processId', '1003022');
    u.searchParams.set('maxIntradayDays', '1');
    u.searchParams.set('spanType', 'Intraday');
    u.searchParams.set('startDateIntraday', y + '/' + pad(m) + '/' + pad(d));
    u.searchParams.set('startHourIntraday', '19');
    u.searchParams.set('startMinuteIntraday', '0');
    u.searchParams.set('endDateIntraday', nd.getUTCFullYear() + '/' + pad(nd.getUTCMonth() + 1) + '/' + pad(nd.getUTCDate()));
    u.searchParams.set('endHourIntraday', includeMET ? '6' : '5');
    u.searchParams.set('endMinuteIntraday', '30');
    return u.toString();
  }
  var dockBusy = false;
  function fetchDock(req) {
    if (dockBusy || typeof GM_xmlhttpRequest === 'undefined') return;
    var url = buildDockUrl(req && req.shiftDate, req && req.includeMET);
    if (!url) return;
    dockBusy = true;
    GM_xmlhttpRequest({
      method: 'GET', url: url, timeout: 25000,
      onload: function (res) {
        dockBusy = false;
        if (res.status < 200 || res.status >= 300) return;
        try {
          var doc = new DOMParser().parseFromString(res.responseText, 'text/html');
          var dock = scrapeDock(doc);
          if (dock) relayToDashboard(mergeStore({ dock: dock }));
        } catch (e) {}
      },
      onerror: function () { dockBusy = false; },
      ontimeout: function () { dockBusy = false; }
    });
  }

  // ---------------- report-page UI ----------------
  function toast(msg) {
    var t = document.getElementById('obBridgeToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'obBridgeToast';
      t.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:62px;padding:8px 12px;' +
        'background:#0b1220;color:#e8eefb;border:1px solid #2f6fea;border-radius:8px;' +
        'font:600 12px sans-serif;max-width:340px;transition:opacity .3s';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = '0'; }, 2800);
  }
  function addButton() {
    if (document.getElementById('obBridgeBtn')) return;
    var b = document.createElement('button');
    b.id = 'obBridgeBtn';
    b.type = 'button';
    b.textContent = '⬆ Push to OB Dashboard';
    b.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:10px 14px;' +
      'background:#2f6fea;color:#fff;border:0;border-radius:10px;font:700 13px sans-serif;' +
      'cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.3)';
    b.addEventListener('click', function () { runScrape(true); });
    document.body.appendChild(b);
  }
  function runScrape(showToast) {
    var neo = scrapeObGoals(document);
    var dock = scrapeDock(document);
    if (!neo && !dock) { if (showToast) toast('No OB goal rows or Dock totals found on this page.'); return; }
    var payload = mergeStore({ neo: neo, dock: dock });
    relayToDashboard(payload); // in case the dashboard is this same page
    if (showToast) {
      var bits = [];
      if (neo) bits.push(Object.keys(neo).length + ' goal field(s)');
      if (dock) bits.push('Dock ' + (dock.palletsLoaded || 0) + ' @ ' + (dock.rate || 0));
      toast('Pushed to OB dashboard: ' + bits.join('  ·  '));
    }
  }

  // ---------------- boot ----------------
  if (isDashboard()) {
    // DASHBOARD PAGE: relay shared data + listen for pull requests.
    try { window.postMessage({ type: 'PRC_V2_LIVE_BRIDGE_READY', version: VERSION }, '*'); } catch (e) {}
    var pushLatest = function () { relayToDashboard(readShared()); };
    pushLatest();
    try {
      GM_addValueChangeListener(SHARED_KEY, function (name, oldV, newV) {
        try { relayToDashboard(JSON.parse(newV)); } catch (e) {}
      });
    } catch (e) {}
    window.addEventListener('message', function (ev) {
      var t = ev.data && ev.data.type;
      if (t === 'PRC_V2_HYBRID_SOURCE_PULL' || t === 'PRC_V2_HYBRID_FCLM_PULL' || t === 'PRC_V2_HYBRID_PULL_REQUEST') {
        pushLatest();
        fetchDock(ev.data); // refresh Dock actuals straight from FCLM
      }
    });
    return;
  }

  // REPORT PAGE: only show the button when there is actually data to push.
  var neo0 = scrapeObGoals(document);
  var dock0 = scrapeDock(document);
  if (neo0 || dock0) {
    addButton();
    relayToDashboard(mergeStore({ neo: neo0, dock: dock0 }));
  }
})();
