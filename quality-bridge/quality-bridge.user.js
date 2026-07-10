// ==UserScript==
// @name         Quality Metrics Bridge (RFD2)
// @namespace    rfd2-quality
// @version      2.4.0
// @description  Single consolidated Quality Bridge script. Scrapes Piles report (Area Breakdown), auto-watches the piles landing page for new completed counts, EPP Compliance, PPA Compliance, TWMS Compliance, RoboScout UIS diverts — bridges to local server
// @match        https://ont-base.corp.amazon.com/RFD2/icqa/piles*
// @match        https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/0243f5c0-7de1-4ee2-ba5e-de2948e0802f*
// @match        https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/839b4877-6557-4e6b-a9d5-d3df4e36ff9f*
// @match        https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/apps/81460ff9-4d8f-40af-94fa-775cf0fa7140*
// @match        https://americas.roboscout.rom.robotics.a2z.com/d/uis-cosmos-uis-diverts*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

// Consolidated single script — the one file to install in Tampermonkey.
// Supersedes quality-bridge.user.js (v1.0.0) and the v2.2.0 backup; it is a
// union of all three. Sources: Piles report + landing-page auto-watcher,
// EPP / PPA / TWMS Compliance (QuickSight), and RoboScout UIS diverts.

(function () {
  'use strict';

  const BRIDGE_URL = 'http://127.0.0.1:4800/quality-bridge';
  const SCRAPE_INTERVAL = 30000;      // 30s between scrapes
  const AUDIT_POLL_INTERVAL = 60000;  // landing page: re-check for new counts every 60s
  const QS_LOAD_WAIT = 8000;          // QuickSight needs time to render

  // --- Utility ---
  function log(msg) {
    console.log(`[QualityBridge] ${msg}`);
  }

  function num(s) {
    if (s === null || s === undefined) return null;
    const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  function normName(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function detectSource() {
    if (window.__QB_FORCE_SOURCE) return window.__QB_FORCE_SOURCE; // test hook
    const url = location.href;
    if (url.includes('ont-base.corp.amazon.com') && url.includes('piles')) return 'piles';
    if (url.includes('0243f5c0-7de1-4ee2-ba5e-de2948e0802f')) return 'epp';
    if (url.includes('839b4877-6557-4e6b-a9d5-d3df4e36ff9f')) return 'ppa';
    if (url.includes('81460ff9-4d8f-40af-94fa-775cf0fa7140')) return 'twms';
    if (url.includes('roboscout') && url.includes('uis-diverts')) return 'diverts';
    return 'unknown';
  }

  function isPilesReport() {
    if (location.href.includes('/piles/report')) return true;
    // Fallback: the report page has an "Area Breakdown" heading
    return Array.from(document.querySelectorAll('h1,h2,h3,h4'))
      .some(h => /area\s*breakdown/i.test(h.textContent));
  }

  function getCurrentShift() {
    // RFD2 (Central Time). Two shifts a day, split into week-halves:
    //   Day   shift: 07:00 - 17:30 (MET extends to 18:30)
    //   Night shift: 19:00 - 05:30 (MET extends to 06:30 next day)
    //   Front Half (FH) = Sun/Mon/Tue shift-day · Back Half (BH) = Wed-Sat
    // Returns a 4-way code: FHD / FHN / BHD / BHN.
    const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const day = ct.getDay();   // 0=Sun ... 6=Sat
    const hour = ct.getHours();

    // Night = 19:00-06:59; pre-dawn (before 07:00) belongs to the previous
    // calendar day's night shift.
    const isNight = hour < 7 || hour >= 19;
    let shiftDay = day;
    if (isNight && hour < 7) shiftDay = (day + 6) % 7;

    const half = (shiftDay >= 0 && shiftDay <= 2) ? 'FH' : 'BH';
    return half + (isNight ? 'N' : 'D');
  }

  function writeBridge(source, data) {
    const payload = {
      source,
      shift: getCurrentShift(),
      timestamp: new Date().toISOString(),
      data
    };

    log(`Sending ${source} data: ${JSON.stringify(data).substring(0, 200)}...`);

    GM_xmlhttpRequest({
      method: 'POST',
      url: BRIDGE_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload),
      onload: (r) => log(`Bridge ${r.status}: ${r.responseText.substring(0, 100)}`),
      onerror: (e) => log(`Bridge error: ${e.statusText}`)
    });

    // Also cache locally
    GM_setValue(`quality_${source}`, JSON.stringify(payload));
  }

  // --- Floating status badge ---
  function createBadge(source, onClick) {
    const badge = document.createElement('div');
    badge.id = 'quality-bridge-badge';
    badge.style.cssText = `
      position: fixed; bottom: 12px; right: 12px; z-index: 99999;
      background: #232f3e; color: #ff9900; padding: 6px 12px;
      border-radius: 4px; font: bold 11px/1.4 "Amazon Ember", Arial, sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: pointer;
      transition: background 0.2s;
    `;
    badge.textContent = `Quality Bridge: ${source.toUpperCase()} ⏳`;
    badge.title = 'Click to force re-scrape';
    badge.addEventListener('click', () => onClick());
    document.body.appendChild(badge);
    return badge;
  }

  function updateBadge(msg, ok = true) {
    const badge = document.getElementById('quality-bridge-badge');
    if (badge) {
      badge.textContent = msg;
      badge.style.color = ok ? '#4caf50' : '#f44336';
    }
  }

  // ============================================================
  // TABLE GRID EXPANSION (handles rowspan/colspan merged cells)
  // ============================================================
  function expandTable(table) {
    const grid = [];
    const rows = table.querySelectorAll('tr');
    rows.forEach((tr, r) => {
      grid[r] = grid[r] || [];
      let c = 0;
      Array.from(tr.children).forEach(cell => {
        if (cell.tagName !== 'TD' && cell.tagName !== 'TH') return;
        while (grid[r][c] !== undefined) c++;
        const rs = parseInt(cell.getAttribute('rowspan') || '1', 10) || 1;
        const cs = parseInt(cell.getAttribute('colspan') || '1', 10) || 1;
        const text = cell.textContent.replace(/\s+/g, ' ').trim();
        for (let i = 0; i < rs; i++) {
          for (let j = 0; j < cs; j++) {
            grid[r + i] = grid[r + i] || [];
            grid[r + i][c + j] = text;
          }
        }
        c += cs;
      });
    });
    return grid;
  }

  // ============================================================
  // PILES REPORT SCRAPER (ont-base /piles/report — Area Breakdown)
  // Works on the live page (no args) or on a fetched document
  // (pass the parsed doc + the report URL for the audit params).
  // ============================================================
  function scrapePilesReport(doc, urlStr) {
    doc = doc || document;
    log('Scraping piles report (Area Breakdown)...');

    const data = {
      report: true,
      auditDate: null, auditShift: null, auditNumber: null,
      totalPiles: null,           // "Piles Total: NNNN" from the page header
      adjustedTotal: null,        // "Adjusted Total: NNNN"
      areaTotals: {},             // { 'Fluid Load': 450, ... } from Total column
      areaAdjusted: {},           // same, from Adjusted Total column
      areaRows: [],               // per-location detail rows
      departmentOverview: [],
      computedSum: null,          // sum of areaTotals
      computedAdjustedSum: null,
      sumMatchesReported: null,   // computedSum === totalPiles
      diagnostics: []
    };

    // Audit params from URL
    const q = new URL(urlStr || location.href, location.origin).searchParams;
    data.auditDate = q.get('audit_date');
    data.auditShift = q.get('audit_shift');
    data.auditNumber = q.get('audit_number');

    // Header totals (fetched docs have no layout, so innerText may be missing)
    const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
    let m = bodyText.match(/Piles\s*Total\s*:?\s*([\d,]+)/i);
    if (m) data.totalPiles = num(m[1]);
    m = bodyText.match(/Adjusted\s*Total\s*:?\s*([\d,]+)/i);
    if (m) data.adjustedTotal = num(m[1]);

    // Walk every table; Area Breakdown tables have "Physical Area"/"Physical Location" headers
    doc.querySelectorAll('table').forEach((table, ti) => {
      const grid = expandTable(table);
      if (!grid.length) return;

      // Locate the header row (may not be row 0)
      let hr = -1;
      for (let r = 0; r < Math.min(grid.length, 5); r++) {
        const low = (grid[r] || []).map(x => String(x || '').toLowerCase());
        if (low.some(x => x.includes('physical area')) || low.some(x => x.includes('physical location'))) {
          hr = r;
          break;
        }
      }

      if (hr === -1) {
        // Department Overview table (left panel)
        const low0 = (grid[0] || []).map(x => String(x || '').toLowerCase());
        if (low0.some(x => x.includes('department'))) {
          for (let r = 1; r < grid.length; r++) {
            const row = grid[r];
            if (!row || !row[0] || !String(row[0]).trim()) continue;
            const values = row.slice(1).map(num).filter(v => v !== null);
            if (values.length) {
              data.departmentOverview.push({ department: String(row[0]).trim(), values: values.slice(0, 4) });
            }
          }
        }
        return;
      }

      const head = grid[hr].map(x => String(x || '').toLowerCase());
      const idxArea = head.findIndex(x => x.includes('physical area'));
      const idxLoc = head.findIndex(x => x.includes('physical location'));
      const idxAdj = head.findIndex(x => x.includes('adjusted'));
      let idxTotal = -1;
      head.forEach((x, i) => {
        if (x.includes('total') && !x.includes('adjusted')) idxTotal = i;
      });

      // The report nests each area table inside an outer wrapper table whose
      // cells contain the *entire* inner table text, so "Physical Area" and
      // "Physical Location" land in the same merged column. Those rows are
      // garbage (all-null totals) — skip the wrapper entirely.
      if (idxArea !== -1 && idxArea === idxLoc) return;

      data.diagnostics.push({
        table: ti,
        headers: grid[hr].slice(0, 20),
        dataRows: grid.length - hr - 1,
        cols: { area: idxArea, loc: idxLoc, total: idxTotal, adjusted: idxAdj }
      });

      if (idxArea === -1 || (idxTotal === -1 && idxAdj === -1)) return;

      for (let r = hr + 1; r < grid.length; r++) {
        const row = grid[r];
        if (!row) continue;
        const areaRaw = row[idxArea];
        if (!areaRaw || !String(areaRaw).trim()) continue;
        const area = String(areaRaw).trim();
        // skip repeated header rows inside the same table
        if (/physical\s*(area|location)/i.test(area)) continue;

        data.areaRows.push({
          area,
          location: idxLoc !== -1 ? String(row[idxLoc] || '').trim() : '',
          total: idxTotal !== -1 ? num(row[idxTotal]) : null,
          adjusted: idxAdj !== -1 ? num(row[idxAdj]) : null
        });
      }
    });

    // Aggregate per area.
    // Prefer an explicit subtotal row (location empty, or location == area name);
    // otherwise sum the individual location rows.
    const byArea = {};
    data.areaRows.forEach(r => {
      (byArea[r.area] = byArea[r.area] || []).push(r);
    });

    Object.keys(byArea).forEach(area => {
      const rows = byArea[area];
      const subtotalRows = rows.filter(r => !r.location || normName(r.location) === normName(area));
      // Prefer a subtotal row that actually carries a number
      const subtotal = subtotalRows.find(r => r.total !== null || r.adjusted !== null) || subtotalRows[0];
      const locRows = rows.filter(r => r.location && normName(r.location) !== normName(area));

      let tot = null, adj = null;
      if (subtotal && subtotal.total !== null) tot = subtotal.total;
      else if (locRows.length) tot = locRows.reduce((s, r) => s + (r.total || 0), 0);
      else if (rows.length && rows[0].total !== null) tot = rows[0].total;

      if (subtotal && subtotal.adjusted !== null) adj = subtotal.adjusted;
      else if (locRows.length) adj = locRows.reduce((s, r) => s + (r.adjusted || 0), 0);
      else if (rows.length && rows[0].adjusted !== null) adj = rows[0].adjusted;

      if (tot !== null) data.areaTotals[area] = tot;
      if (adj !== null) data.areaAdjusted[area] = adj;
    });

    // Cross-check against the page's own reported totals
    data.computedSum = Object.values(data.areaTotals).reduce((s, v) => s + v, 0);
    data.computedAdjustedSum = Object.values(data.areaAdjusted).reduce((s, v) => s + v, 0);
    if (data.totalPiles !== null) {
      data.sumMatchesReported = data.computedSum === data.totalPiles;
    }

    log(`Piles report: ${Object.keys(data.areaTotals).length} areas, ` +
        `sum=${data.computedSum} vs reported=${data.totalPiles} ` +
        `(${data.sumMatchesReported === false ? 'MISMATCH!' : 'ok'})`);

    return data;
  }

  // ============================================================
  // LEGACY PILES SCRAPER (non-report piles pages, generic)
  // ============================================================
  function scrapePilesGeneric() {
    log('Scraping piles (generic)...');

    const data = {
      totalPiles: null,
      pilesOver48h: null,
      pilesOver24h: null,
      pilesUnder24h: null,
      tableRows: [],
      summary: {}
    };

    const statCards = document.querySelectorAll('.stat-card, .metric-card, .card, .summary-item, [class*="stat"], [class*="metric"]');
    statCards.forEach(card => {
      const text = card.textContent.trim();
      const numMatch = text.match(/(\d[\d,]*)/);
      if (numMatch) {
        const label = text.replace(numMatch[0], '').trim().toLowerCase();
        if (label.includes('total')) data.totalPiles = parseInt(numMatch[1].replace(/,/g, ''));
        if (label.includes('48') || label.includes('over 48')) data.pilesOver48h = parseInt(numMatch[1].replace(/,/g, ''));
        if (label.includes('24') && !label.includes('48')) data.pilesOver24h = parseInt(numMatch[1].replace(/,/g, ''));
      }
    });

    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
      const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th'))
        .map(th => th.textContent.trim());

      if (headers.length > 0) {
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
          if (cells.length > 0) {
            const rowObj = {};
            headers.forEach((h, i) => { rowObj[h] = cells[i] || ''; });
            data.tableRows.push(rowObj);
          }
        });
      }
    });

    if (data.totalPiles === null) {
      const headings = document.querySelectorAll('h1, h2, h3, .count, .total, [class*="count"], [class*="total"]');
      headings.forEach(el => {
        const n = el.textContent.trim().match(/^(\d[\d,]*)$/);
        if (n) {
          data.summary[el.className || el.tagName] = parseInt(n[1].replace(/,/g, ''));
        }
      });
    }

    // Aging breakdown fallback (carried over from v1.0.0) — dumps any
    // aging-tagged blocks into summary if the page exposes them.
    const agingElements = document.querySelectorAll('[class*="aging"], [class*="age"], .pile-age');
    agingElements.forEach(el => {
      data.summary[el.className] = el.textContent.trim();
    });

    if (data.tableRows.length === 0 && data.totalPiles === null) {
      const allText = document.body.innerText;
      const lines = allText.split('\n').filter(l => l.trim());
      lines.forEach(line => {
        const kv = line.match(/^(.+?)[\s:]+(\d[\d,]*)\s*$/);
        if (kv) {
          data.summary[kv[1].trim()] = kv[2].trim();
        }
      });
    }

    log(`Piles: ${data.tableRows.length} rows, total=${data.totalPiles}`);
    return data;
  }

  function scrapePiles() {
    return isPilesReport() ? scrapePilesReport() : scrapePilesGeneric();
  }

  // ============================================================
  // QUICKSIGHT SCRAPER (EPP + PPA)
  // ============================================================
  function scrapeQuickSight(dashboardType) {
    log(`Scraping QuickSight: ${dashboardType}...`);

    const data = {
      type: dashboardType,
      shift: getCurrentShift(),
      kpis: {},
      tables: [],
      visuals: []
    };

    const visuals = document.querySelectorAll(
      '.quicksight-visual, [class*="VisualContainer"], [class*="visual-container"], ' +
      '[class*="sheetVisual"], [data-testid*="visual"]'
    );

    visuals.forEach((visual, idx) => {
      const titleEl = visual.querySelector(
        '[class*="visual-title"], [class*="VisualTitle"], [class*="Title"], h2, h3'
      );
      const title = titleEl ? titleEl.textContent.trim() : `Visual_${idx}`;
      const content = visual.textContent.trim().substring(0, 500);
      const numbers = content.match(/[\d,]+\.?\d*%?/g) || [];
      data.visuals.push({ title, numbers: numbers.slice(0, 20), raw: content.substring(0, 200) });
    });

    const tables = document.querySelectorAll('table, [role="table"], [class*="Table"]');
    tables.forEach(table => {
      const headers = [];
      const rows = [];

      table.querySelectorAll('thead th, [role="columnheader"], [class*="header-cell"]').forEach(th => {
        headers.push(th.textContent.trim());
      });

      if (headers.length === 0) {
        const firstRow = table.querySelector('tr, [role="row"]');
        if (firstRow) {
          firstRow.querySelectorAll('th, td, [role="cell"], [role="columnheader"]').forEach(cell => {
            headers.push(cell.textContent.trim());
          });
        }
      }

      const dataRows = table.querySelectorAll('tbody tr, [role="row"]');
      dataRows.forEach((row, ri) => {
        if (ri === 0 && headers.length === 0) return;
        const cells = Array.from(row.querySelectorAll('td, [role="cell"], [role="gridcell"]'))
          .map(c => c.textContent.trim());
        if (cells.length > 0 && cells.some(c => c !== '')) {
          rows.push(cells);
        }
      });

      if (headers.length > 0 || rows.length > 0) {
        data.tables.push({ headers, rows: rows.slice(0, 50) });
      }
    });

    const allText = document.body.innerText;

    if (dashboardType === 'epp') {
      const complianceMatch = allText.match(/(?:compliance|EPP)[:\s]*(\d+\.?\d*)\s*%/i);
      if (complianceMatch) data.kpis.eppCompliance = complianceMatch[1] + '%';

      const pctMatches = allText.match(/(\d{1,3}\.\d{1,2})%/g);
      if (pctMatches) data.kpis.allPercentages = pctMatches.slice(0, 10);
    }

    if (dashboardType === 'ppa') {
      const shift = getCurrentShift();
      data.kpis.targetShift = shift;

      const complianceMatch = allText.match(/(?:compliance|PPA)[:\s]*(\d+\.?\d*)\s*%/i);
      if (complianceMatch) data.kpis.ppaCompliance = complianceMatch[1] + '%';

      const pctMatches = allText.match(/(\d{1,3}\.\d{1,2})%/g);
      if (pctMatches) data.kpis.allPercentages = pctMatches.slice(0, 10);
    }

    if (dashboardType === 'twms') {
      data.kpis.targetShift = getCurrentShift();

      const complianceMatch = allText.match(/(?:compliance|TWMS)[:\s]*(\d+\.?\d*)\s*%/i);
      if (complianceMatch) data.kpis.compliance = complianceMatch[1] + '%';

      const pctMatches = allText.match(/(\d{1,3}\.\d{1,2})%/g);
      if (pctMatches) data.kpis.allPercentages = pctMatches.slice(0, 10);
    }

    const svgs = document.querySelectorAll('svg');
    svgs.forEach((svg, i) => {
      const texts = Array.from(svg.querySelectorAll('text'))
        .map(t => t.textContent.trim())
        .filter(t => t && t.match(/\d/));
      if (texts.length > 0 && texts.length < 50) {
        data.visuals.push({ title: `Chart_SVG_${i}`, numbers: texts });
      }
    });

    log(`QuickSight ${dashboardType}: ${data.visuals.length} visuals, ${data.tables.length} tables`);
    return data;
  }

  // ============================================================
  // ROBOSCOUT SCRAPER (Grafana — UIS diverts, RFD2)
  // Grafana renders stat/table panels in the DOM; time-series are SVG.
  // Generic panel-oriented harvest (title + numbers + tables), same
  // tune-later approach as the QuickSight scraper.
  // ============================================================
  function scrapeRoboScout() {
    log('Scraping RoboScout UIS diverts...');
    const params = new URLSearchParams(location.search);
    const data = {
      type: 'diverts',
      shift: getCurrentShift(),
      site: params.get('var-site') || 'RFD2',
      station: params.get('var-station') || 'All',
      range: { from: params.get('from') || '', to: params.get('to') || '' },
      kpis: { targetShift: getCurrentShift() },
      panels: [],
      tables: []
    };

    const panelSel =
      '[data-testid^="data-testid Panel"], .panel-container, ' +
      '[class*="panel-container"], .react-grid-item';
    let panels = Array.from(document.querySelectorAll(panelSel));
    // keep only outermost panels (Grafana nests wrappers)
    panels = panels.filter(p => !panels.some(o => o !== p && o.contains(p)));
    if (!panels.length) panels = Array.from(document.querySelectorAll('section'));

    panels.forEach((panel, idx) => {
      const titleEl = panel.querySelector(
        '.panel-title, [class*="panel-title"], ' +
        '[data-testid="data-testid Panel header"], h2, h6'
      );
      let title = (titleEl ? titleEl.textContent : '').replace(/\s+/g, ' ').trim();
      if (!title) title = 'Panel_' + idx;
      if (title.length > 90) title = title.slice(0, 90);
      const txt = (panel.innerText || '').replace(/\s+/g, ' ').trim();
      if (!txt) return;
      const nums = (txt.match(/-?[\d,]+\.?\d*%?/g) || []).slice(0, 12);
      data.panels.push({ title, values: nums, raw: txt.slice(0, 160) });
    });

    // table panels (react-data-grid / role=table / plain tables)
    document.querySelectorAll('[role="table"], table, [class*="rdg"]').forEach(t => {
      const headers = Array.from(t.querySelectorAll('[role="columnheader"], thead th'))
        .map(h => h.textContent.trim()).filter(Boolean);
      const rows = [];
      t.querySelectorAll('[role="row"], tbody tr').forEach(r => {
        const cells = Array.from(r.querySelectorAll('[role="gridcell"], [role="cell"], td'))
          .map(c => c.textContent.trim());
        if (cells.length && cells.some(c => c !== '')) rows.push(cells);
      });
      if (headers.length || rows.length) data.tables.push({ headers, rows: rows.slice(0, 50) });
    });

    log(`RoboScout: ${data.panels.length} panels, ${data.tables.length} tables`);
    return data;
  }

  // ============================================================
  // AUDIT WATCHER (piles landing page — "Reporting" screen)
  // Re-fetches the landing page every AUDIT_POLL_INTERVAL, finds the
  // completed (green) counts, fetches each report and bridges it.
  // A new count finishing shows up here without anyone touching the tab.
  // ============================================================
  const sentAuditHashes = {}; // key -> hash of last payload sent

  function findAuditLinksIn(doc) {
    const seen = {};
    const out = [];
    doc.querySelectorAll('a[href*="piles/report"]').forEach(a => {
      let u;
      try { u = new URL(a.getAttribute('href'), location.origin); } catch (e) { return; }
      const date = u.searchParams.get('audit_date');
      const numStr = u.searchParams.get('audit_number');
      if (!date || !numStr) return;
      const key = `${date}|${u.searchParams.get('audit_shift') || ''}|${numStr}`;
      if (seen[key]) return;
      seen[key] = true;
      // Bootstrap-style buttons: green = btn-success (completed), red = btn-danger
      const cls = a.className + ' ' + (a.parentElement ? a.parentElement.className : '');
      out.push({
        key,
        url: u.href,
        label: a.textContent.trim() || key,
        completed: /success/i.test(cls) && !/danger/i.test(cls)
      });
    });
    return out;
  }

  function fetchDoc(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(html => new DOMParser().parseFromString(html, 'text/html'));
  }

  let watchCount = 0;
  function watchAudits() {
    watchCount++;
    fetchDoc(location.href).then(doc => {
      const links = findAuditLinksIn(doc);
      if (!links.length) {
        updateBadge('Quality Bridge: WATCH — no counts listed yet', false);
        return;
      }
      // Only completed counts; if the green/red classes ever change, fall back
      // to trying them all — empty reports are skipped below anyway.
      let targets = links.filter(l => l.completed);
      if (!targets.length) targets = links;
      updateBadge(`Quality Bridge: WATCH ${targets.length}/${links.length} counts ✓ (#${watchCount})`, true);

      let chain = Promise.resolve();
      targets.forEach(l => {
        chain = chain
          .then(() => fetchDoc(l.url))
          .then(reportDoc => {
            const data = scrapePilesReport(reportDoc, l.url);
            if (!data.areaRows.length && data.totalPiles === null) {
              log(`${l.label}: no data yet, skipping`);
              return;
            }
            const hash = JSON.stringify([data.totalPiles, data.adjustedTotal, data.areaTotals, data.areaAdjusted]);
            if (sentAuditHashes[l.key] === hash) return; // unchanged since last send
            sentAuditHashes[l.key] = hash;
            log(`New/updated count ${l.label} (${l.key}) — sending to bridge`);
            writeBridge('piles', data);
          })
          .catch(e => log(`${l.label}: ${e.message}`));
      });
    }).catch(e => updateBadge('Quality Bridge: WATCH ✗ ' + e.message, false));
  }

  // ============================================================
  // MAIN LOOP
  // ============================================================
  const source = detectSource();
  let scrapeCount = 0;

  function runScrape() {
    let data;
    try {
      switch (source) {
        case 'piles':
          data = scrapePiles();
          break;
        case 'epp':
          data = scrapeQuickSight('epp');
          break;
        case 'ppa':
          data = scrapeQuickSight('ppa');
          break;
        case 'twms':
          data = scrapeQuickSight('twms');
          break;
        case 'diverts':
          data = scrapeRoboScout();
          break;
        default:
          log('Unknown source, skipping');
          return;
      }

      scrapeCount++;
      writeBridge(source, data);

      let badgeMsg = `Quality Bridge: ${source.toUpperCase()} ✓ (#${scrapeCount})`;
      let badgeOk = true;
      if (data && data.report) {
        if (data.sumMatchesReported === false) {
          badgeMsg = `Quality Bridge: PILES ⚠ sum ${data.computedSum} ≠ ${data.totalPiles} (#${scrapeCount})`;
          badgeOk = false;
        } else if (data.totalPiles !== null) {
          badgeMsg = `Quality Bridge: PILES ✓ ${data.totalPiles} (#${scrapeCount})`;
        }
      }
      updateBadge(badgeMsg, badgeOk);
    } catch (err) {
      log(`Scrape error: ${err.message}`);
      updateBadge(`Quality Bridge: ${source.toUpperCase()} ✗ ${err.message}`, false);
    }
  }

  // Landing page ("Reporting" screen) gets the audit watcher instead of a scrape:
  // it re-fetches the page itself, so new counts are picked up automatically
  // without reloading the tab.
  const isPilesLanding = source === 'piles' && !isPilesReport();

  if (isPilesLanding) {
    log(`Piles landing page detected — watching for completed counts every ${AUDIT_POLL_INTERVAL / 1000}s`);
    createBadge('piles', watchAudits);
    setTimeout(() => {
      watchAudits();
      setInterval(watchAudits, AUDIT_POLL_INTERVAL);
    }, 2500);
  } else {
    // Wait for page to fully render before first scrape
    const initialDelay = source === 'piles' ? 3000 : QS_LOAD_WAIT;

    log(`Detected source: ${source}, first scrape in ${initialDelay / 1000}s`);
    createBadge(source, runScrape);

    setTimeout(() => {
      runScrape();
      setInterval(runScrape, SCRAPE_INTERVAL);
    }, initialDelay);
  }

})();
