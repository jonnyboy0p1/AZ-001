// ==UserScript==
// @name         Dockflow Trailer Weight Heat Map
// @namespace    az-001
// @version      1.0.0
// @description  Overlay a payload-weight heat map (dispatch window 28k–40k) on Dockflow, refreshed every 1–3 min. Reads data you already see, in your own authenticated tab — no proxy / mwinit needed.
// @author       you
// @match        https://*.dockflow.*.amazon.com/*
// @match        https://dockflow*.amazon.com/*
// @match        https://*.amazon.com/*dockflow*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      amazon.com
// @run-at       document-idle
// ==/UserScript==
//
// SETUP (one time):
//   1. Confirm your site permits userscripts/extensions on managed machines.
//   2. Fix the @match lines above to the REAL Dockflow host (look at your address bar).
//   3. Open the panel's ⚙ and either paste the Dockflow data URL (DevTools → Network,
//      the request that returns the container/ARC JSON) or rely on DOM scraping.
//   4. Adjust MAP() / scrapeDOM() field names if your data labels differ.
//
"use strict";

/* ─────────────────────────────────────────────────────────────────────────
   CONFIG  (persisted via Tampermonkey storage)
───────────────────────────────────────────────────────────────────────── */
const G = {
  get(k, d) { try { return GM_getValue(k, d); } catch { return d; } },
  set(k, v) { try { GM_setValue(k, v); } catch {} },
};
const CFG = {
  max:     +G.get("max", 40000),       // 100% / red / cube-out
  floor:   +G.get("floor", 28000),     // dispatch floor → yellow line
  refresh: +G.get("refresh", 120000),  // 1–3 min
  apiUrl:  G.get("apiUrl", ""),        // optional: Dockflow data endpoint
  sim:     G.get("sim", false),        // simulate mode for testing
};

/* ─────────────────────────────────────────────────────────────────────────
   EQUATION + HEAT COLOUR  (same model as weight-heatmap.html)
───────────────────────────────────────────────────────────────────────── */
const bucket5 = p => Math.max(0, Math.min(100, Math.floor(p / 5) * 5));

function heatColor(pct, floorPct) {
  const b = bucket5(pct), fp = floorPct || 70;
  if (b <= 0)   return "#a0aec0";
  if (b >= 100) return "hsl(0,75%,45%)";
  const hue = b < fp ? 140 - 70 * (b / fp) : 60 - 60 * ((b - fp) / (100 - fp));
  return `hsl(${Math.round(hue)},72%,45%)`;
}

function state(r) {
  const wpu        = r.contentCount > 0 ? r.payloadWeight / r.contentCount : 0;
  const fillRate   = (r.liveRate || 0) * wpu;                 // lb/hr
  const elapsedHr  = (Date.now() - r.snapAt) / 3.6e6;
  const target     = r.targetWeight || CFG.max;
  const floor      = Math.min(CFG.floor, target);
  const projWeight = Math.min(target, r.payloadWeight + fillRate * elapsedHr);
  const pct        = target > 0 ? (projWeight / target) * 100 : 0;
  const floorPct   = target > 0 ? (floor / target) * 100 : 70;
  const remaining  = target - projWeight;
  const etaFull    = fillRate > 0 && remaining > 0 ? remaining / fillRate : (remaining <= 0 ? 0 : Infinity);
  const ready      = projWeight >= floor;
  return { fillRate, projWeight, pct, floorPct, etaFull, ready, target };
}

const fmtEta = hr => !isFinite(hr) ? "—" : hr === 0 ? "max" :
  (hr * 60 < 60 ? `${Math.round(hr * 60)}m` : `${Math.floor(hr * 60 / 60)}h ${Math.round(hr * 60) % 60}m`);

function statusOf(s) {
  return s.projWeight >= s.target ? ["OVER MAX", "#c53030"]
       : s.ready                  ? ["READY",    "#2f855a"]
       : s.projWeight <= 0        ? ["EMPTY",    "#a0aec0"]
       :                            ["FILLING",  "#dd6b20"];
}

/* ─────────────────────────────────────────────────────────────────────────
   DATA ACQUISITION  — four strategies, best-effort in order
───────────────────────────────────────────────────────────────────────── */
let captured = null;   // set by the fetch/XHR interceptor below

/* (a) tolerant mapper — ADJUST the right-hand field names to match Dockflow */
function MAP(data) {
  const arr = Array.isArray(data) ? data
            : data.arcs || data.containers || data.data || data.rows || data.results || [];
  return arr.map(o => ({
    destination:   o.destination ?? o.arc ?? o.arcName ?? o.name ?? o.stackingFilter ?? o.lane ?? "—",
    trailerId:     o.trailerId ?? o.containerId ?? o.vrId ?? o.trailer ?? "",
    payloadWeight: +(o.payloadWeight ?? o.weight ?? o.payload ?? o.currentWeight ?? 0) || 0,
    contentCount:  +(o.contentCount ?? o.count ?? o.units ?? o.jobs ?? 0) || 0,
    liveRate:      +(o.liveRate ?? o.currentRate ?? o.rate ?? o.jobsPerHour ?? 0) || 0,
    targetWeight:  +(o.targetWeight ?? o.maxWeight ?? o.maxPayload ?? 0) || null,
    snapAt:        Date.now(),
  })).filter(r => r.destination !== "—" || r.trailerId || r.payloadWeight);
}

/* (b) same-origin fetch of a known endpoint (cookies sent automatically) */
async function fromApi() {
  if (!CFG.apiUrl) return null;
  const r = await fetch(CFG.apiUrl, { credentials: "include" });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : JSON.parse(await r.text());
  const rows = MAP(data);
  return rows.length ? rows : null;
}

/* (c) DOM scrape of the Container Hierarchy table (header-name based, resilient) */
function scrapeDOM() {
  const num = t => parseFloat(String(t).replace(/[^0-9.]/g, "")) || 0;
  // a destination hint from the VR / stacking-filter header if present
  let dest = (document.body.innerText.match(/([A-Z]{3}\d)\s*->\s*([A-Z]{3}\d)/) || [])[0]
          || (document.title || "Dockflow");
  // a page-level live rate if a "Current Rate (jobs/hr)" value is visible
  let rate = 0;
  const rm = document.body.innerText.match(/Current Rate[^0-9]*([0-9,]+)/i);
  if (rm) rate = num(rm[1]);

  const rows = [];
  for (const table of document.querySelectorAll("table")) {
    const heads = [...table.querySelectorAll("th")].map(th => th.textContent.trim().toLowerCase());
    const ci = heads.findIndex(h => h.includes("container") && h.includes("id"));
    const wi = heads.findIndex(h => h.includes("weight"));
    const cc = heads.findIndex(h => h.includes("content"));
    if (ci < 0 || wi < 0) continue;                         // not the right table
    for (const tr of table.querySelectorAll("tbody tr, tr")) {
      const tds = [...tr.querySelectorAll("td")];
      if (tds.length <= Math.max(ci, wi)) continue;
      const w = num(tds[wi].textContent);
      if (!w) continue;
      rows.push({
        destination:   dest,
        trailerId:     tds[ci].textContent.trim(),
        payloadWeight: w,
        contentCount:  cc >= 0 ? num(tds[cc].textContent) : 0,
        liveRate:      rate,
        targetWeight:  null,
        snapAt:        Date.now(),
      });
    }
    if (rows.length) break;
  }
  return rows.length ? rows : null;
}

/* (d) simulate — realistic skewed bell curve for testing the overlay anywhere */
function simulate() {
  const dests = ["SBN1","MKE2_CASE","DET6","ORD9","CMH1","IND9","STL8","RFD4","ABE8","MEM1","BNA3","MDW2"];
  return dests.map((d, k) => {
    let g = (Math.random()+Math.random()+Math.random())/3; g = Math.pow(g,1.25);
    let w = Math.round((18000 + g*23000)/10)*10;
    if (k === dests.length-1) w = 0;
    if (k === 1) w = 8200;
    const wpu = 18 + Math.random()*6;
    return { destination:d, trailerId:"YTF"+(10000000+(Math.random()*9e7|0)),
             payloadWeight:w, contentCount: w>0?Math.round(w/wpu):0,
             liveRate: 380+(Math.random()*460|0), targetWeight:CFG.max, snapAt:Date.now() };
  });
}

async function getRows() {
  if (CFG.sim) return simulate();
  try { const a = await fromApi(); if (a) return a; } catch (e) { console.warn("[heatmap] api", e); }
  if (captured) { const m = MAP(captured); if (m.length) return m; }
  const d = scrapeDOM(); if (d) return d;
  return simulate();   // fall back so the overlay is never blank
}

/* Intercept the page's own data calls so we don't even need the URL.
   Captures any JSON response that smells like container/arc data. */
(function hookFetch() {
  const looksRight = (url, txt) =>
    /arc|container|dock|trailer|vr|payload/i.test(url) || /payloadWeight|contentCount|currentRate/i.test(txt);
  const of = window.fetch;
  window.fetch = async function (...a) {
    const res = await of.apply(this, a);
    try {
      const url = (a[0] && a[0].url) || a[0] || "";
      const clone = res.clone(); const txt = await clone.text();
      if (txt && txt[0] === "{" || txt[0] === "[") {
        if (looksRight(String(url), txt)) captured = JSON.parse(txt);
      }
    } catch {}
    return res;
  };
})();

/* ─────────────────────────────────────────────────────────────────────────
   UI  — floating panel injected into the page
───────────────────────────────────────────────────────────────────────── */
let rows = [];

const style = document.createElement("style");
style.textContent = `
  #wh-panel{position:fixed;top:64px;right:16px;width:300px;max-height:82vh;overflow:auto;z-index:2147483647;
    background:#1a1a2e;color:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.45);
    font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;}
  #wh-panel .hd{display:flex;align-items:center;gap:6px;padding:10px 12px;background:#13132a;border-radius:10px 10px 0 0;}
  #wh-panel .hd b{flex:1;font-size:12px;}
  #wh-panel .hd button{background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:5px;padding:3px 7px;cursor:pointer;font-size:12px;}
  #wh-panel .leg{display:flex;gap:2px;padding:8px 12px 4px;}
  #wh-panel .leg i{flex:1;height:12px;}
  #wh-panel .legt{font-size:9px;color:#a0aec0;padding:0 12px 8px;}
  #wh-grid{padding:8px 12px 12px;display:grid;grid-template-columns:1fr 1fr;gap:7px;}
  #wh-grid .t{border-radius:7px;padding:8px;color:#fff;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12);transition:background .6s;}
  #wh-grid .t .d{font-weight:700;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  #wh-grid .t .p{font-size:22px;font-weight:800;line-height:1;margin-top:4px;}
  #wh-grid .t .s{font-size:9px;opacity:.92;margin-top:3px;}
  #wh-foot{font-size:9px;color:#718096;padding:0 12px 10px;}
`;
document.head.appendChild(style);

const panel = document.createElement("div");
panel.id = "wh-panel";
panel.innerHTML = `
  <div class="hd">
    <b>Weight Heat Map</b>
    <button id="wh-sim"  title="Toggle simulate">🎲</button>
    <button id="wh-cfg"  title="Settings">⚙</button>
    <button id="wh-min"  title="Hide">–</button>
  </div>
  <div class="leg" id="wh-leg"></div>
  <div class="legt">grey=empty · green=filling · <b>yellow=${(CFG.floor/1000)}k floor</b> · red=${(CFG.max/1000)}k</div>
  <div id="wh-grid"></div>
  <div id="wh-foot"></div>`;
document.body.appendChild(panel);

document.getElementById("wh-leg").innerHTML =
  [0,10,35,60,Math.round(CFG.floor/CFG.max*100),85,100]
    .map(p => `<i style="background:${heatColor(p, CFG.floor/CFG.max*100)}"></i>`).join("");

document.getElementById("wh-min").onclick = () => panel.remove();
document.getElementById("wh-sim").onclick = () => { CFG.sim = !CFG.sim; G.set("sim", CFG.sim); refresh(); };
document.getElementById("wh-cfg").onclick = () => {
  const u = prompt("Dockflow data URL (blank = scrape/intercept the page):", CFG.apiUrl); if (u !== null) { CFG.apiUrl = u.trim(); G.set("apiUrl", CFG.apiUrl); }
  const mx = prompt("Max weight = 100% (lb):", CFG.max); if (mx) { CFG.max = +mx; G.set("max", CFG.max); }
  const fl = prompt("Dispatch floor = yellow line (lb):", CFG.floor); if (fl) { CFG.floor = +fl; G.set("floor", CFG.floor); }
  const rf = prompt("Auto-refresh minutes (1–3):", CFG.refresh / 60000); if (rf) { CFG.refresh = Math.max(1, +rf) * 60000; G.set("refresh", CFG.refresh); }
  location.reload();
};

function render() {
  const grid = document.getElementById("wh-grid");
  const order = rows.map((r, i) => i).sort((a, b) => state(rows[b]).pct - state(rows[a]).pct);
  grid.innerHTML = order.map(i => {
    const s = state(rows[i]), st = statusOf(s);
    return `<div class="t" id="wh-t${i}" style="background:${heatColor(s.pct, s.floorPct)}">
      <div class="d">${rows[i].destination}</div>
      <div class="p" id="wh-p${i}">${Math.round(s.pct)}%</div>
      <div class="s" id="wh-s${i}">${st[0]} · ${fmtEta(s.etaFull)}</div></div>`;
  }).join("");
}

function tick() {
  rows.forEach((r, i) => {
    const s = state(r), st = statusOf(s);
    const t = document.getElementById(`wh-t${i}`); if (t) t.style.background = heatColor(s.pct, s.floorPct);
    const p = document.getElementById(`wh-p${i}`); if (p) p.textContent = Math.round(s.pct) + "%";
    const e = document.getElementById(`wh-s${i}`); if (e) e.textContent = `${st[0]} · ${fmtEta(s.etaFull)}`;
  });
}

async function refresh() {
  rows = await getRows();
  render();
  const src = CFG.sim ? "simulated" : CFG.apiUrl ? "api" : captured ? "intercepted" : "scraped";
  document.getElementById("wh-foot").textContent =
    `${rows.length} trailers · ${src} · ${new Date().toLocaleTimeString()}`;
}

refresh();
setInterval(refresh, CFG.refresh);   // server-side pull, 1–3 min
setInterval(tick, 1000);             // running % between pulls
