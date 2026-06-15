// ==UserScript==
// @name         FlowFone — DockFlow Sorter → Google Sheets
// @namespace    flowfone.dockflow
// @version      1.1.0
// @description  Scrape the DockFlow Sorter workcell table in your logged-in browser tab and push it to a Google Sheet, so you can watch it from your phone while away from the laptop.
// @author       you
// @match        https://prod-na.dockflow.robotics.a2z.com/*
// @match        https://*.dockflow.robotics.a2z.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      script.google.com
// @connect      googleusercontent.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * WHY A USERSCRIPT (and not Apps Script fetching the URL directly)?
 * ----------------------------------------------------------------
 * DockFlow lives behind Amazon Midway SSO + the corporate network. Google's
 * servers (where Apps Script / UrlFetchApp run) cannot reach it or log in.
 * This script runs *inside your already-authenticated browser tab*, reads the
 * table the page has rendered, and POSTs it to a Google Apps Script web app,
 * which writes it into a Sheet your phone can open. No auth to handle here —
 * we piggyback on the session you're already logged into.
 *
 * Pair this with flowfone/google-apps-script.gs (deployed as a web app).
 */

(function () {
  "use strict";

  // ── Config persistence ──────────────────────────────────────────────────────
  const DEFAULTS = {
    url: "",          // Apps Script web app /exec URL
    token: "",        // shared secret — must match CONFIG.TOKEN in the .gs file
    interval: 60,     // seconds between pushes
    reloadMin: 0,     // reload the page every N minutes to force fresh data (0 = off)
    enabled: false,   // auto-start on page load
    minimized: false,
  };

  function getCfg() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(GM_getValue("flowfone.cfg", "{}")));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveCfg(cfg) {
    GM_setValue("flowfone.cfg", JSON.stringify(cfg));
  }

  // ── Small helpers ───────────────────────────────────────────────────────────
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const timeNow = () =>
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const areaFromPath = () => location.pathname.split("/").filter(Boolean).join(" / ");

  // ── Table scraping ──────────────────────────────────────────────────────────
  // Pick the most "data-like" table on the page by header keywords + row count.
  const KEYWORDS = ["recircs", "utilization", "arc", "status", "workcell", "dwell", "defects", "re-inject"];

  function pickTable() {
    const tables = [...document.querySelectorAll("table")];
    let best = null;
    let bestScore = -1;
    for (const t of tables) {
      const headEl = t.tHead || (t.rows[0] ? t.rows[0] : null);
      const headText = (headEl ? headEl.textContent : "").toLowerCase();
      const kwScore = KEYWORDS.reduce((s, k) => s + (headText.indexOf(k) >= 0 ? 1 : 0), 0);
      const bodyRows = t.tBodies[0] ? t.tBodies[0].rows.length : Math.max(0, t.rows.length - 1);
      const score = kwScore * 1000 + Math.min(bodyRows, 500);
      if (kwScore > 0 && score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  function scrape() {
    const t = pickTable();
    if (!t) return { error: "no-table" };

    // Use the LAST header row (Cloudscape can stack header rows).
    const headRow = t.tHead && t.tHead.rows.length
      ? t.tHead.rows[t.tHead.rows.length - 1]
      : t.rows[0];
    if (!headRow) return { error: "no-header" };

    // Keep only columns that actually have a header label (drops the selection /
    // settings columns that Cloudscape adds). Remember each kept column's index so
    // we can read the matching body cell.
    const cols = [];
    [...headRow.cells].forEach((cell, i) => {
      const name = clean(cell.textContent);
      if (name) cols.push({ i, name });
    });
    if (!cols.length) return { error: "no-columns" };

    const headers = cols.map((c) => c.name);
    const bodyRows = t.tBodies[0] ? [...t.tBodies[0].rows] : [...t.rows].slice(1);

    const rows = [];
    for (const tr of bodyRows) {
      const cells = [...tr.cells];
      const r = cols.map((c) => clean((cells[c.i] || { textContent: "" }).textContent));
      if (r.some((v) => v !== "")) rows.push(r);
    }
    return { headers, rows };
  }

  // ── Push to Apps Script ─────────────────────────────────────────────────────
  function push() {
    const cfg = getCfg();
    if (!cfg.url) {
      setStatus("Set the Web App URL first", true);
      return;
    }
    const data = scrape();
    if (data.error) {
      setStatus("No Sorter table found yet (" + data.error + ")", true);
      return;
    }

    const payload = {
      app: "FlowFone",
      source: location.hostname + location.pathname,
      area: areaFromPath(),
      capturedAt: new Date().toISOString(),
      token: cfg.token,
      headers: data.headers,
      rows: data.rows,
    };

    setStatus("Pushing " + data.rows.length + " rows…");

    // GM_xmlhttpRequest bypasses CORS — we use text/plain to avoid a preflight
    // that Apps Script's 302 redirect would otherwise break.
    GM_xmlhttpRequest({
      method: "POST",
      url: cfg.url,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      data: JSON.stringify(payload),
      timeout: 20000,
      onload: function (res) {
        let ok = res.status >= 200 && res.status < 300;
        let detail = "";
        try {
          const j = JSON.parse(res.responseText);
          if (typeof j.ok === "boolean") ok = j.ok;
          if (typeof j.rows === "number") detail = " (" + j.rows + " rows)";
          if (j.error) detail = " — " + j.error;
        } catch (e) { /* non-JSON response (e.g. login HTML) */ }
        setStatus((ok ? "✓ pushed" : "✗ failed") + detail + " @ " + timeNow(), !ok);
      },
      onerror: function () {
        setStatus("✗ network error — check the URL / @connect", true);
      },
      ontimeout: function () {
        setStatus("✗ timed out", true);
      },
    });
  }

  // ── Connection test (proves the web app is reachable, before scraping) ───────
  function testConnection() {
    const cfg = getCfg();
    if (!cfg.url) {
      setStatus("Set the Web App URL first", true);
      return;
    }
    setStatus("Testing web app…");
    GM_xmlhttpRequest({
      method: "GET",
      url: cfg.url,
      timeout: 20000,
      onload: function (res) {
        let ok = false;
        let info = "HTTP " + res.status;
        const txt = (res.responseText || "").trim();
        try {
          const j = JSON.parse(txt);
          if (j.ok) { ok = true; info = "reachable (" + (j.app || "ok") + ")"; }
          else info = j.error || info;
        } catch (e) {
          // Not JSON → almost always a Google login/HTML page.
          if (txt.charAt(0) === "<") {
            info = 'got an HTML/login page — set access to "Anyone" and use the /exec URL';
          } else if (txt) {
            info = txt.slice(0, 80);
          }
        }
        setStatus((ok ? "✓ web app " : "✗ ") + info, !ok);
      },
      onerror: function () {
        setStatus("✗ cannot reach URL (wrong URL, or not deployed)", true);
      },
      ontimeout: function () {
        setStatus("✗ timeout reaching web app", true);
      },
    });
  }

  // ── Scheduler ───────────────────────────────────────────────────────────────
  let timer = null;
  let reloadTimer = null;

  function start() {
    stop(true);
    const cfg = getCfg();
    cfg.enabled = true;
    saveCfg(cfg);
    push();
    timer = setInterval(push, Math.max(15, cfg.interval) * 1000);
    if (cfg.reloadMin > 0) {
      reloadTimer = setTimeout(function () {
        if (getCfg().enabled) location.reload();
      }, cfg.reloadMin * 60000);
    }
    reflect();
  }

  function stop(keepEnabled) {
    if (timer) clearInterval(timer);
    if (reloadTimer) clearTimeout(reloadTimer);
    timer = null;
    reloadTimer = null;
    if (!keepEnabled) {
      const cfg = getCfg();
      cfg.enabled = false;
      saveCfg(cfg);
      reflect();
    }
  }

  // ── UI ──────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    #flowfone {
      position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
      width: 290px; font: 12px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #1a1a2e; color: #e6edf3; border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,.45); overflow: hidden;
    }
    #flowfone .ff-head {
      display: flex; align-items: center; gap: 8px; padding: 9px 12px;
      background: #2d6a9f; cursor: default; user-select: none;
    }
    #flowfone .ff-head b { flex: 1; font-size: 13px; }
    #flowfone .ff-head button {
      background: rgba(255,255,255,.18); color: #fff; border: 0; border-radius: 4px;
      width: 22px; height: 22px; cursor: pointer; font-size: 13px; line-height: 1;
    }
    #flowfone .ff-body { padding: 10px 12px; display: grid; gap: 8px; }
    #flowfone label { display: grid; gap: 3px; font-size: 11px; color: #9fb3c8; }
    #flowfone input {
      width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 5px;
      border: 1px solid #33415a; background: #0f1626; color: #e6edf3; font-size: 12px;
    }
    #flowfone .ff-row { display: flex; gap: 8px; }
    #flowfone .ff-row label { flex: 1; }
    #flowfone .ff-actions { display: flex; gap: 8px; margin-top: 2px; }
    #flowfone .ff-actions button {
      flex: 1; padding: 7px; border: 0; border-radius: 6px; cursor: pointer;
      font-weight: 600; font-size: 12px; color: #fff;
    }
    #flowfone #ff-toggle { background: #38a169; }
    #flowfone #ff-toggle.on { background: #e53e3e; }
    #flowfone #ff-now { background: #3a4a63; }
    #flowfone #ff-test { background: #2d6a9f; }
    #flowfone .ff-status {
      font-size: 11px; padding: 6px 8px; border-radius: 5px; background: #0f1626;
      color: #9fb3c8; min-height: 16px; word-break: break-word;
    }
    #flowfone .ff-status.err { color: #ffb4a8; }
    #flowfone.min .ff-body { display: none; }
  `);

  let panel, elStatus, elUrl, elToken, elInterval, elReload, elToggle;

  function buildUI() {
    panel = document.createElement("div");
    panel.id = "flowfone";
    panel.innerHTML = `
      <div class="ff-head">
        <span>📲</span><b>FlowFone</b>
        <button id="ff-min" title="Minimize">–</button>
      </div>
      <div class="ff-body">
        <label>Apps Script Web App URL
          <input id="ff-url" type="text" placeholder="https://script.google.com/macros/s/…/exec" />
        </label>
        <label>Shared token (must match the .gs file)
          <input id="ff-token" type="text" placeholder="flowfone-secret" />
        </label>
        <div class="ff-row">
          <label>Every (sec)<input id="ff-interval" type="number" min="15" /></label>
          <label>Reload (min, 0=off)<input id="ff-reload" type="number" min="0" /></label>
        </div>
        <div class="ff-status" id="ff-status">Idle.</div>
        <div class="ff-actions">
          <button id="ff-test">Test</button>
          <button id="ff-now">Push now</button>
          <button id="ff-toggle">Start</button>
        </div>
      </div>`;
    document.body.appendChild(panel);

    elStatus = panel.querySelector("#ff-status");
    elUrl = panel.querySelector("#ff-url");
    elToken = panel.querySelector("#ff-token");
    elInterval = panel.querySelector("#ff-interval");
    elReload = panel.querySelector("#ff-reload");
    elToggle = panel.querySelector("#ff-toggle");

    const cfg = getCfg();
    elUrl.value = cfg.url;
    elToken.value = cfg.token;
    elInterval.value = cfg.interval;
    elReload.value = cfg.reloadMin;
    if (cfg.minimized) panel.classList.add("min");

    // Persist field edits.
    const persist = () => {
      const c = getCfg();
      c.url = elUrl.value.trim();
      c.token = elToken.value.trim();
      c.interval = Math.max(15, parseInt(elInterval.value, 10) || 60);
      c.reloadMin = Math.max(0, parseInt(elReload.value, 10) || 0);
      saveCfg(c);
    };
    [elUrl, elToken, elInterval, elReload].forEach((el) => el.addEventListener("change", persist));

    panel.querySelector("#ff-min").addEventListener("click", () => {
      panel.classList.toggle("min");
      const c = getCfg();
      c.minimized = panel.classList.contains("min");
      saveCfg(c);
    });
    panel.querySelector("#ff-test").addEventListener("click", () => { persist(); testConnection(); });
    panel.querySelector("#ff-now").addEventListener("click", () => { persist(); push(); });
    elToggle.addEventListener("click", () => {
      persist();
      if (timer) stop();
      else start();
    });

    reflect();
  }

  function reflect() {
    if (!elToggle) return;
    const running = !!timer;
    elToggle.textContent = running ? "Stop" : "Start";
    elToggle.classList.toggle("on", running);
  }

  function setStatus(msg, isErr) {
    if (!elStatus) return;
    elStatus.textContent = msg;
    elStatus.classList.toggle("err", !!isErr);
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  function boot() {
    if (document.getElementById("flowfone")) return;
    buildUI();
    if (getCfg().enabled) {
      setStatus("Auto-starting in 5s…");
      setTimeout(start, 5000); // give the SPA time to render the table
    }
  }

  if (document.body) boot();
  else window.addEventListener("DOMContentLoaded", boot);
})();
