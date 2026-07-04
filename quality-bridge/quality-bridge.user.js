// ==UserScript==
// @name         Quality Metrics Bridge (RFD2)
// @namespace    rfd2-quality
// @version      1.0.0
// @description  Scrapes Piles, EPP Compliance, PPA Compliance and bridges to local server
// @match        https://ont-base.corp.amazon.com/RFD2/icqa/piles*
// @match        https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/0243f5c0-7de1-4ee2-ba5e-de2948e0802f*
// @match        https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/839b4877-6557-4e6b-a9d5-d3df4e36ff9f*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BRIDGE_URL = 'http://127.0.0.1:4800/quality-bridge';
  const SCRAPE_INTERVAL = 30000; // 30s between scrapes
  const QS_LOAD_WAIT = 8000;    // QuickSight needs time to render

  // --- Utility ---
  function log(msg) {
    console.log(`[QualityBridge] ${msg}`);
  }

  function detectSource() {
    const url = location.href;
    if (url.includes('ont-base.corp.amazon.com') && url.includes('piles')) return 'piles';
    if (url.includes('0243f5c0-7de1-4ee2-ba5e-de2948e0802f')) return 'epp';
    if (url.includes('839b4877-6557-4e6b-a9d5-d3df4e36ff9f')) return 'ppa';
    return 'unknown';
  }

  function getCurrentShift() {
    // RFD2 night shift schedule (Central Time)
    // Sun-Wed = Front Half (FH), Wed-Sat = Back Half (BH)
    // Wed night counts as BH start
    const now = new Date();
    // Convert to Central Time
    const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const day = ct.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
    const hour = ct.getHours();

    // Night shift: 19:00 - 06:30 CT
    // If before 06:30, the "shift day" is the previous calendar day
    let shiftDay = day;
    if (hour < 7) {
      shiftDay = (day + 6) % 7; // previous day
    }

    // FH = Sun(0), Mon(1), Tue(2), Wed(3) nights
    // BH = Wed(3), Thu(4), Fri(5), Sat(6) nights
    // Wed is overlap — night shift starting Wed evening is BH
    if (shiftDay >= 0 && shiftDay <= 2) return 'FH';
    if (shiftDay >= 3 && shiftDay <= 6) return 'BH';
    return 'FH';
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
  function createBadge(source) {
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
    badge.addEventListener('click', () => runScrape());
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
  // PILES SCRAPER (ont-base)
  // ============================================================
  function scrapePiles() {
    log('Scraping piles...');

    const data = {
      totalPiles: null,
      pilesOver48h: null,
      pilesOver24h: null,
      pilesUnder24h: null,
      tableRows: [],
      summary: {}
    };

    // ont-base typically renders a table with pile info
    // Look for summary/stats first
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

    // Grab the main data table
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

    // Fallback: look for any prominent numbers on the page
    if (data.totalPiles === null) {
      // Try looking for h1/h2/h3 with numbers, or specific selectors
      const headings = document.querySelectorAll('h1, h2, h3, .count, .total, [class*="count"], [class*="total"]');
      headings.forEach(el => {
        const num = el.textContent.trim().match(/^(\d[\d,]*)$/);
        if (num) {
          data.summary[el.className || el.tagName] = parseInt(num[1].replace(/,/g, ''));
        }
      });
    }

    // Also grab any aging breakdown if visible
    const agingElements = document.querySelectorAll('[class*="aging"], [class*="age"], .pile-age');
    agingElements.forEach(el => {
      data.summary[el.className] = el.textContent.trim();
    });

    // Broad fallback: grab all visible text blocks that look like key-value pairs
    if (data.tableRows.length === 0 && data.totalPiles === null) {
      const allText = document.body.innerText;
      const lines = allText.split('\n').filter(l => l.trim());
      // Look for "Label: Value" or "Label\tValue" patterns
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

    // QuickSight renders visuals in containers
    // Strategy: find all visual containers and extract their content

    // 1. KPI / single-number visuals (large prominent numbers)
    const kpiSelectors = [
      '[class*="kpi"]', '[class*="KPI"]',
      '[class*="metric-value"]', '[class*="MetricValue"]',
      '[class*="insight"]', '[class*="Insight"]',
      '.visual-container', '[data-testid*="visual"]'
    ];

    // Look for visual titles + their associated values
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

      // Extract numbers from the visual
      const numbers = content.match(/[\d,]+\.?\d*%?/g) || [];

      data.visuals.push({ title, numbers: numbers.slice(0, 20), raw: content.substring(0, 200) });
    });

    // 2. Tables inside QuickSight
    const tables = document.querySelectorAll('table, [role="table"], [class*="Table"]');
    tables.forEach(table => {
      const headers = [];
      const rows = [];

      // Try standard table structure
      table.querySelectorAll('thead th, [role="columnheader"], [class*="header-cell"]').forEach(th => {
        headers.push(th.textContent.trim());
      });

      // If no thead, try first row
      if (headers.length === 0) {
        const firstRow = table.querySelector('tr, [role="row"]');
        if (firstRow) {
          firstRow.querySelectorAll('th, td, [role="cell"], [role="columnheader"]').forEach(cell => {
            headers.push(cell.textContent.trim());
          });
        }
      }

      // Get data rows
      const dataRows = table.querySelectorAll('tbody tr, [role="row"]');
      dataRows.forEach((row, ri) => {
        if (ri === 0 && headers.length === 0) return; // skip if we used first row as headers
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

    // 3. Look for percentage/compliance values specifically
    const allText = document.body.innerText;

    if (dashboardType === 'epp') {
      // EPP Compliance - look for compliance percentage
      const complianceMatch = allText.match(/(?:compliance|EPP)[:\s]*(\d+\.?\d*)\s*%/i);
      if (complianceMatch) data.kpis.eppCompliance = complianceMatch[1] + '%';

      // Look for any percentage that seems like the main KPI
      const pctMatches = allText.match(/(\d{1,3}\.\d{1,2})%/g);
      if (pctMatches) data.kpis.allPercentages = pctMatches.slice(0, 10);
    }

    if (dashboardType === 'ppa') {
      // PPA Compliance - shift-aware
      const shift = getCurrentShift();
      data.kpis.targetShift = shift;

      const complianceMatch = allText.match(/(?:compliance|PPA)[:\s]*(\d+\.?\d*)\s*%/i);
      if (complianceMatch) data.kpis.ppaCompliance = complianceMatch[1] + '%';

      const pctMatches = allText.match(/(\d{1,3}\.\d{1,2})%/g);
      if (pctMatches) data.kpis.allPercentages = pctMatches.slice(0, 10);
    }

    // 4. SVG chart data (QuickSight renders charts as SVG)
    const svgs = document.querySelectorAll('svg');
    svgs.forEach((svg, i) => {
      // Look for text elements in charts that might contain values
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
        default:
          log('Unknown source, skipping');
          return;
      }

      scrapeCount++;
      writeBridge(source, data);
      updateBadge(`Quality Bridge: ${source.toUpperCase()} ✓ (#${scrapeCount})`, true);
    } catch (err) {
      log(`Scrape error: ${err.message}`);
      updateBadge(`Quality Bridge: ${source.toUpperCase()} ✗ ${err.message}`, false);
    }
  }

  // Wait for page to fully render before first scrape
  const initialDelay = source === 'piles' ? 3000 : QS_LOAD_WAIT;

  log(`Detected source: ${source}, first scrape in ${initialDelay / 1000}s`);
  createBadge(source);

  setTimeout(() => {
    runScrape();
    setInterval(runScrape, SCRAPE_INTERVAL);
  }, initialDelay);

})();
