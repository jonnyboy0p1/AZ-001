// ==UserScript==
// @name         Dockflow → Google Sheets (Live Recirc Feed)
// @namespace    az-001
// @version      1.0.0
// @description  Scrapes Dock Door / Utilization / Recirc / Cause from Dockflow and pushes it to a Google Sheet every minute.
// @match        https://dockflow.amazon.com/*
// @match        https://*.amazon.com/dockflow*
// @match        https://dockflow-na.corp.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * SETUP (one time):
 *  1. Deploy google-apps-script.gs as a Web App (see README.md) and copy its URL.
 *  2. Open Dockflow, click the Tampermonkey icon → "Set Sheets Web App URL", paste it.
 *  3. If your Dockflow URL differs from the @match lines above, edit them in the
 *     Tampermonkey editor to your actual Dockflow address.
 *
 * The script then scrapes the page every PUSH_INTERVAL_MS and pushes to the sheet.
 */

(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────────────────────────
  const PUSH_INTERVAL_MS = 60 * 1000;       // push to Sheets every 1 min
  const RELOAD_EVERY_MS  = 10 * 60 * 1000;  // hard-reload page every 10 min (0 = never).
                                            // Keeps data fresh if Dockflow doesn't live-update its own DOM.
  const SHARED_SECRET    = "change-me";     // must match SHARED_SECRET in google-apps-script.gs

  // Column header matching (case-insensitive). Adjust if Dockflow labels differ.
  const COLUMN_PATTERNS = {
    door:        /door|dock\s*door|^dd$|arc/i,
    utilization: /util/i,
    recirc:      /recirc|recric/i,
    cause:       /cause|reason|status/i,
  };

  // ── State / UI ──────────────────────────────────────────────────────────────
  const getEndpoint = () => GM_getValue("sheetsEndpoint", "");

  GM_registerMenuCommand("Set Sheets Web App URL", () => {
    const url = prompt("Paste the Google Apps Script Web App URL (ends in /exec):", getEndpoint());
    if (url !== null) {
      GM_setValue("sheetsEndpoint", url.trim());
      badge(url.trim() ? "Endpoint saved — pushing every 1 min" : "Endpoint cleared", "ok");
    }
  });

  GM_registerMenuCommand("Push to Sheets now", () => scrapeAndPush(true));

  // Small status badge in the corner of the Dockflow page
  const badgeEl = document.createElement("div");
  badgeEl.style.cssText =
    "position:fixed;bottom:12px;right:12px;z-index:99999;font:11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;" +
    "padding:6px 12px;border-radius:14px;color:#fff;background:#444;opacity:.92;pointer-events:none;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.3);transition:background .3s;";
  badgeEl.textContent = "Sheets feed: starting…";
  document.body.appendChild(badgeEl);

  function badge(msg, state) {
    badgeEl.textContent = "Sheets feed: " + msg;
    badgeEl.style.background =
      state === "ok" ? "#2f855a" : state === "warn" ? "#c05621" : state === "err" ? "#c53030" : "#444";
  }

  // ── Scraper ─────────────────────────────────────────────────────────────────

  /** Find the table whose headers best match the columns we care about. */
  function findDataTable() {
    let best = null;
    let bestScore = 0;

    for (const table of document.querySelectorAll("table")) {
      const headers = headerCells(table).map((c) => c.textContent.trim());
      if (!headers.length) continue;

      let score = 0;
      for (const pattern of Object.values(COLUMN_PATTERNS)) {
        if (headers.some((h) => pattern.test(h))) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = table;
      }
    }
    // Require at least door + one metric so we don't grab a random table
    return bestScore >= 2 ? best : null;
  }

  function headerCells(table) {
    const thead = table.querySelector("thead tr");
    if (thead) return [...thead.children];
    const firstRow = table.querySelector("tr");
    return firstRow ? [...firstRow.children] : [];
  }

  /** Map our field names → column index for this table. */
  function mapColumns(table) {
    const headers = headerCells(table).map((c) => c.textContent.trim());
    const map = {};
    for (const [field, pattern] of Object.entries(COLUMN_PATTERNS)) {
      const idx = headers.findIndex((h) => pattern.test(h));
      if (idx !== -1) map[field] = idx;
    }
    return map;
  }

  function scrapeRows() {
    const table = findDataTable();
    if (!table) return null;

    const cols = mapColumns(table);
    const bodyRows = table.tBodies.length
      ? [...table.tBodies[0].rows]
      : [...table.rows].slice(1);

    const rows = [];
    for (const tr of bodyRows) {
      const cells = [...tr.cells].map((c) => c.textContent.trim());
      if (!cells.length) continue;

      const row = {
        door:        cols.door        != null ? cells[cols.door]        : "",
        utilization: cols.utilization != null ? cells[cols.utilization] : "",
        recirc:      cols.recirc      != null ? cells[cols.recirc]      : "",
        cause:       cols.cause       != null ? cells[cols.cause]       : "",
      };
      if (row.door) rows.push(row);
    }
    return rows;
  }

  // ── Push ────────────────────────────────────────────────────────────────────

  function scrapeAndPush(manual = false) {
    const endpoint = getEndpoint();
    if (!endpoint) {
      badge("no endpoint — set it via Tampermonkey menu", "warn");
      return;
    }

    const rows = scrapeRows();
    if (!rows || !rows.length) {
      badge("no data table found on page", "warn");
      return;
    }

    const payload = {
      secret:    SHARED_SECRET,
      source:    location.href,
      timestamp: new Date().toISOString(),
      rows,
    };

    GM_xmlhttpRequest({
      method: "POST",
      url: endpoint,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(payload),
      timeout: 20000,
      onload: (resp) => {
        if (resp.status >= 200 && resp.status < 400) {
          badge(`${rows.length} doors pushed · ${new Date().toLocaleTimeString()}`, "ok");
        } else {
          badge(`push failed (HTTP ${resp.status})`, "err");
        }
      },
      onerror:   () => badge("push failed (network)", "err"),
      ontimeout: () => badge("push timed out", "err"),
    });

    if (manual) console.log("[Dockflow→Sheets] payload:", payload);
  }

  // ── Schedule ────────────────────────────────────────────────────────────────
  setTimeout(() => scrapeAndPush(), 5000);          // first push shortly after load
  setInterval(() => scrapeAndPush(), PUSH_INTERVAL_MS);

  if (RELOAD_EVERY_MS > 0) {
    setTimeout(() => location.reload(), RELOAD_EVERY_MS);
  }
})();
