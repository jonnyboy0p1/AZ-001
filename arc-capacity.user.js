// ==UserScript==
// @name         ARC Capacity — Load Median & Heaviness
// @namespace    rb20.arc-capacity
// @version      1.0.0
// @description  Hour-by-hour ARC load median and a day×hour heaviness (load ÷ capacity) heatmap for a crossdock node, rendered right on the Crossdock Manager page. Auto-captures the arc-capacity data by watching the page's own network calls — no proxy, no cookie handling.
// @author       RB20
// @match        https://crossdock-manager.harmony.a2z.com/*
// @match        https://*.harmony.a2z.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // Page's real window (so we can hook the page's own fetch / XHR from the sandbox).
  const PAGE = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
  const BRIDGE_URL = "http://localhost:5220/bridge";

  // ── Palette (validated data-viz reference) ────────────────────────────────
  const BLUE_RAMP = ["#cde2fb","#b7d3f6","#9ec5f4","#86b6ef","#6da7ec","#5598e7",
                     "#3987e5","#2a78d6","#256abf","#1c5cab","#184f95","#104281","#0d366b"];
  const CRITICAL = "#d03b3b";

  // ── Field-name candidates for the tolerant normalizer ─────────────────────
  const DATE_KEYS = ["date","day","dateString","businessDate","planDate","localDate","dateLocal"];
  const TIME_KEYS = ["timestamp","time","startTime","intervalStart","dateTime","datetime","epoch","epochMillis","start","periodStart"];
  const HOUR_KEYS = ["hour","hourOfDay","hr","hourStart","intervalHour"];
  const LOAD_KEYS = ["load","arcLoad","arcLoadUnits","actualLoad","projectedLoad","forecastLoad","volume","units","value","loadUnits","demand"];
  const CAP_KEYS  = ["capacity","arcCapacity","maxCapacity","plannedCapacity","cap","capacityUnits","effectiveCapacity","targetCapacity"];
  const NODE_KEYS = ["nodes","warehouses","stations","byNode","data"];

  // ── State ─────────────────────────────────────────────────────────────────
  let RECORDS = [];        // normalized [{dateISO,hour,load,capacity}]
  let LAST_RAW = null;     // most recent usable raw payload (for bridge)
  let CAPTURE_COUNT = 0;
  let shadow = null;       // panel shadow root
  const q  = s => shadow && shadow.querySelector(s);
  const qa = s => shadow ? [...shadow.querySelectorAll(s)] : [];

  // ══════════════════════════════════════════════════════════════════════════
  //  1. NETWORK CAPTURE — installed immediately (run-at document-start)
  // ══════════════════════════════════════════════════════════════════════════
  function hookNetwork() {
    // fetch
    try {
      const origFetch = PAGE.fetch;
      if (typeof origFetch === "function") {
        PAGE.fetch = function (...args) {
          const p = origFetch.apply(this, args);
          try {
            p.then(res => {
              try {
                const clone = res.clone();
                const ct = (clone.headers.get("content-type") || "").toLowerCase();
                if (ct.includes("json")) clone.json().then(j => consider(j)).catch(() => {});
              } catch (e) {}
            }).catch(() => {});
          } catch (e) {}
          return p;
        };
      }
    } catch (e) {}

    // XMLHttpRequest
    try {
      const XHR = PAGE.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        const open = XHR.prototype.open, send = XHR.prototype.send;
        XHR.prototype.open = function (m, u) { this.__arcUrl = u; return open.apply(this, arguments); };
        XHR.prototype.send = function () {
          this.addEventListener("load", function () {
            try {
              const txt = this.responseText || "";
              const ct = (this.getResponseHeader && (this.getResponseHeader("content-type") || "")).toLowerCase();
              if (ct.includes("json") || /^\s*[\[{]/.test(txt)) consider(JSON.parse(txt));
            } catch (e) {}
          });
          return send.apply(this, arguments);
        };
      }
    } catch (e) {}
  }

  // A response is "arc data" if it normalizes to a decent set of load values.
  function consider(json) {
    let recs;
    try { recs = normalizeArcRecords(json, currentNode(), currentStart()); } catch (e) { return; }
    const usable = recs.filter(r => r.load != null);
    if (usable.length < 6) return;                 // too thin to be the capacity grid
    RECORDS = recs;
    LAST_RAW = json;
    CAPTURE_COUNT++;
    onCaptured();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  2. NORMALIZER + STATS  (same logic as arc-capacity.html)
  // ══════════════════════════════════════════════════════════════════════════
  function firstKey(obj, keys) { for (const k of keys) if (obj != null && obj[k] != null && obj[k] !== "") return obj[k]; }
  function toNum(v) {
    if (v == null) return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const n = parseFloat(String(v).replace(/[, ]/g, ""));
    return isNaN(n) ? null : n;
  }
  function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
  function parseWhen(v) {
    if (v == null) return null;
    const s = String(v);
    // Date, optionally with a time component. Build the ISO date from the
    // matched digits so a bare "YYYY-MM-DD" is NOT timezone-shifted, and only
    // yields an hour when a time is actually present.
    const dm = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}))?/);
    if (dm && !/^\d+$/.test(s)) {
      return { dateISO: `${dm[1]}-${dm[2]}-${dm[3]}`, hour: dm[4] != null ? parseInt(dm[4], 10) : null };
    }
    // Epoch number (seconds or milliseconds).
    if (typeof v === "number" || /^\d+$/.test(s)) {
      let n = Number(v); if (n < 1e11) n *= 1000; const d = new Date(n);
      return isNaN(d.getTime()) ? null : { dateISO: isoDate(d), hour: d.getHours() };
    }
    // Any other parseable datetime.
    const p = Date.parse(s);
    if (isNaN(p)) return null;
    const d = new Date(p);
    return { dateISO: isoDate(d), hour: d.getHours() };
  }
  function unwrap(json, node) {
    let cur = json;
    for (let i = 0; i < 6 && cur && !Array.isArray(cur); i++) {
      if (node && cur[node] != null) { cur = cur[node]; continue; }
      const nodeMap = NODE_KEYS.map(k => cur[k]).find(v => v && typeof v === "object");
      if (nodeMap && node && nodeMap[node] != null) { cur = nodeMap[node]; continue; }
      const w = ["data","rows","records","items","results","intervals","buckets","series","hours","points","content","payload"]
        .map(k => cur[k]).find(v => v != null);
      if (w != null) { cur = w; continue; }
      break;
    }
    return cur;
  }
  function normalizeArcRecords(json, node, fallbackStartISO) {
    const out = [];
    let cur = unwrap(json, node);
    if (cur && !Array.isArray(cur) && typeof cur === "object") {
      const loadArr = firstKey(cur, LOAD_KEYS), capArr = firstKey(cur, CAP_KEYS);
      if (Array.isArray(loadArr)) {
        const day = fallbackStartISO || isoDate(new Date());
        loadArr.forEach((lv, h) => out.push({ dateISO: day, hour: h % 24, load: toNum(lv),
          capacity: Array.isArray(capArr) ? toNum(capArr[h]) : toNum(capArr) }));
        return out;
      }
    }
    if (!Array.isArray(cur)) return out;
    cur.forEach((row, idx) => {
      if (row == null) return;
      if (typeof row === "number") { out.push({ dateISO: fallbackStartISO || isoDate(new Date()), hour: idx % 24, load: row, capacity: null }); return; }
      let dateISO = null, hour = null;
      const dRaw = firstKey(row, DATE_KEYS), hRaw = firstKey(row, HOUR_KEYS), tRaw = firstKey(row, TIME_KEYS);
      const wd = dRaw != null ? parseWhen(dRaw) : null;
      const wt = tRaw != null ? parseWhen(tRaw) : null;
      if (wd) dateISO = wd.dateISO;
      if (dateISO == null && wt) dateISO = wt.dateISO;
      if (hRaw != null) hour = toNum(hRaw);                 // explicit hour field wins
      if (hour == null && wt && wt.hour != null) hour = wt.hour;
      if (hour == null && wd && wd.hour != null) hour = wd.hour;
      if (dateISO == null) dateISO = fallbackStartISO || isoDate(new Date());
      if (hour == null) hour = idx % 24;
      out.push({ dateISO, hour: ((toNum(hour) || 0) % 24 + 24) % 24,
        load: toNum(firstKey(row, LOAD_KEYS)), capacity: toNum(firstKey(row, CAP_KEYS)) });
    });
    return out;
  }
  function quantile(a, p) { if (!a.length) return null; const pos=(a.length-1)*p, lo=Math.floor(pos), hi=Math.ceil(pos);
    return lo===hi ? a[lo] : a[lo]+(a[hi]-a[lo])*(pos-lo); }
  const median = a => quantile(a, 0.5);
  function hourlyStats(records) {
    const byHour = Array.from({length:24}, () => ({ loads: [], caps: [] }));
    for (const r of records) { if (r.load != null) byHour[r.hour].loads.push(r.load); if (r.capacity != null) byHour[r.hour].caps.push(r.capacity); }
    return byHour.map((h, hour) => {
      const loads = h.loads.slice().sort((a,b)=>a-b), caps = h.caps.slice().sort((a,b)=>a-b);
      const medLoad = median(loads), medCap = median(caps);
      return { hour, medLoad, minLoad: loads[0] ?? null, maxLoad: loads[loads.length-1] ?? null,
        q1: quantile(loads,0.25), q3: quantile(loads,0.75), medCap,
        medUtil: (medLoad != null && medCap) ? medLoad/medCap : null, n: loads.length };
    });
  }
  function grid(records) {
    const dates = [...new Set(records.map(r => r.dateISO))].sort();
    const map = new Map();
    for (const r of records) {
      const key = r.dateISO + "|" + r.hour, cell = map.get(key) || { load:0, capacity:null, n:0 };
      if (r.load != null) { cell.load += r.load; cell.n++; }
      if (r.capacity != null) cell.capacity = (cell.capacity || 0) + r.capacity;
      map.set(key, cell);
    }
    for (const c of map.values()) c.util = (c.capacity && c.n) ? c.load/c.capacity : null;
    return { dates, cell: (d,h) => map.get(d+"|"+h) || null };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  3. FORMAT / COLOR HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  function fmt(n, d=0) { return (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString(undefined, {maximumFractionDigits:d, minimumFractionDigits:d}); }
  function pct(u) { return u == null ? "—" : Math.round(u*100) + "%"; }
  function hh(h) { return String(h).padStart(2,"0") + ":00"; }
  function dowLabel(iso){ const d=new Date(iso+"T00:00:00"); return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()] + " " + iso.slice(5); }
  function hex(h){ h=h.replace("#",""); if(h.length===3) h=h.split("").map(c=>c+c).join(""); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
  function mix(a,b,t){ const ca=hex(a), cb=hex(b); return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`; }
  function heavinessColor(u){
    if (u > 1) { const t = Math.min((u-1)/0.5, 1); return mix(CRITICAL, "#7a1414", t); }
    const idx = Math.min(u,1)*(BLUE_RAMP.length-1), lo=Math.floor(idx), hi=Math.min(lo+1, BLUE_RAMP.length-1);
    return mix(BLUE_RAMP[lo], BLUE_RAMP[hi], idx-lo);
  }
  function niceNum(x){ const e=Math.pow(10,Math.floor(Math.log10(x))); const f=x/e; return (f<1.5?1:f<3?2:f<7?5:10)*e; }
  function niceTicks(max,n){ const s=niceNum(max/n), out=[]; for(let v=0; v<=max; v+=s) out.push(v); return out; }

  // ── Read node / dates from the Crossdock Manager URL (hash query) ──────────
  function urlParams() {
    const out = {};
    const grab = qs => { const m = qs && qs.indexOf("?") >= 0 ? qs.slice(qs.indexOf("?")+1) : ""; new URLSearchParams(m).forEach((v,k)=>out[k]=v); };
    grab(PAGE.location.hash); grab(PAGE.location.search);
    return out;
  }
  function currentNode()  { const p = urlParams(); return (p.nodes || p.node || p.warehouseId || "RFD2").split(",")[0].trim(); }
  function currentStart() { return urlParams().startDate || null; }
  function currentEnd()   { return urlParams().endDate || null; }

  // ══════════════════════════════════════════════════════════════════════════
  //  4. PANEL UI (Shadow DOM — isolated from the host page's CSS)
  // ══════════════════════════════════════════════════════════════════════════
  function buildPanel() {
    if (shadow) return;
    const host = document.createElement("div");
    host.id = "arc-tm-host";
    host.style.cssText = "all:initial";
    (document.body || document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = STYLE + MARKUP;

    q(".arc-launch").addEventListener("click", () => { openDrawer(); render(); });
    q("#arc-close").addEventListener("click", closeDrawer);
    q("#arc-rescan").addEventListener("click", render);
    q("#arc-paste").addEventListener("click", showPaste);
    q("#arc-paste-cancel").addEventListener("click", hidePaste);
    q("#arc-paste-go").addEventListener("click", applyPaste);
    q("#arc-bridge").addEventListener("click", sendToBridge);
    q("#arc-tbl-toggle").addEventListener("click", toggleTable);
    updateBadge();
  }

  function openDrawer() { q(".arc-drawer").hidden = false; }
  function closeDrawer() { q(".arc-drawer").hidden = true; }
  function isOpen() { return shadow && !q(".arc-drawer").hidden; }

  function onCaptured() { if (!shadow) return; updateBadge(); if (isOpen()) render(); }
  function updateBadge() {
    const b = q(".arc-badge"); if (!b) return;
    b.textContent = CAPTURE_COUNT; b.hidden = CAPTURE_COUNT === 0;
    const s = q("#arc-status");
    if (s) s.textContent = CAPTURE_COUNT
      ? `Captured ${CAPTURE_COUNT} arc-capacity response(s)`
      : "Waiting for data — open the ARC capacity view (or use Paste JSON)";
  }

  function render() {
    if (!shadow) return;
    const node = currentNode(), s = currentStart(), e = currentEnd();
    q("#arc-node").value = node;
    if (s) q("#arc-start").textContent = s;
    if (e) q("#arc-end").textContent = e;

    if (!RECORDS.filter(r => r.load != null).length) {
      q("#arc-empty").hidden = false; q("#arc-results").hidden = true; updateBadge(); return;
    }
    q("#arc-empty").hidden = true; q("#arc-results").hidden = false;

    const stats = hourlyStats(RECORDS), g = grid(RECORDS);
    q("#arc-scope").textContent = `${node} · ${g.dates[0]}→${g.dates[g.dates.length-1]} · ${g.dates.length} day(s)`;
    renderKpis(stats, g); renderTrend(stats); renderHeatmap(stats, g); renderTable(stats, g);
    updateBadge();
  }

  function sumDay(g,d){ let s=0; for(let h=0;h<24;h++){ const c=g.cell(d,h); if(c) s+=c.load; } return s; }
  function kpi(label,val,note,hot){ return `<div class="arc-kpi ${hot?'hot':''}"><div class="k-label">${label}</div><div class="k-val">${val}</div><div class="k-note">${note}</div></div>`; }
  function renderKpis(stats, g) {
    const wl = stats.filter(s=>s.medLoad!=null);
    const peak = wl.reduce((a,b)=> b.medLoad>(a?.medLoad??-1)?b:a, null);
    const wu = stats.filter(s=>s.medUtil!=null);
    const peakU = wu.reduce((a,b)=> b.medUtil>(a?.medUtil??-1)?b:a, null);
    const avgU = wu.length ? wu.reduce((s,x)=>s+x.medUtil,0)/wu.length : null;
    const over = wu.filter(s=>s.medUtil>1).length;
    const busiest = g.dates.map(d=>({d,t:sumDay(g,d)})).reduce((a,b)=> b.t>(a?.t??-1)?b:a, null);
    q("#arc-kpi-sub").textContent = peakU
      ? `Heaviest hour (by median utilization) is ${hh(peakU.hour)} at ${pct(peakU.medUtil)} of capacity.`
      : "Capacity not present in the data — heaviness needs a capacity field.";
    q("#arc-kpi").innerHTML = [
      kpi("Peak median load", peak?fmt(peak.medLoad):"—", peak?`at ${hh(peak.hour)}`:"no load field"),
      kpi("Peak median heaviness", peakU?pct(peakU.medUtil):"—", peakU?`at ${hh(peakU.hour)}`:"no capacity field", peakU&&peakU.medUtil>1),
      kpi("Avg heaviness (all hrs)", avgU!=null?pct(avgU):"—", wu.length?`${wu.length} hrs measured`:"—"),
      kpi("Hours over capacity", over+"", over?"median &gt;100%":"none at median", over>0),
      kpi("Busiest day", busiest?busiest.d.slice(5):"—", busiest?`${fmt(busiest.t)} total load`:"—"),
    ].join("");
  }

  function renderTrend(stats) {
    const W=1100, H=340, m={t:16,r:16,b:42,l:60}, iw=W-m.l-m.r, ih=H-m.t-m.b;
    const pts = stats.filter(s=>s.medLoad!=null);
    if (!pts.length) { q("#arc-trend").innerHTML = ""; return; }
    const maxY = Math.max(...stats.map(s=>s.maxLoad??s.medLoad??0),1)*1.08;
    const x=h=>m.l+(h/23)*iw, y=v=>m.t+ih-(v/maxY)*ih;
    let g=""; for(const t of niceTicks(maxY,5)){ g+=`<line class="grid" x1="${m.l}" y1="${y(t)}" x2="${m.l+iw}" y2="${y(t)}"/><text class="ax" x="${m.l-8}" y="${y(t)+3}" text-anchor="end">${fmt(t)}</text>`; }
    let xl=""; for(let h=0;h<24;h+=2) xl+=`<text class="ax" x="${x(h)}" y="${m.t+ih+16}" text-anchor="middle">${String(h).padStart(2,"0")}</text>`;
    xl+=`<text class="axt" x="${m.l+iw/2}" y="${H-4}" text-anchor="middle">Hour of day</text><text class="axt" transform="translate(14,${m.t+ih/2}) rotate(-90)" text-anchor="middle">Load (units)</text>`;
    let band="";
    if (stats.some(s=>s.maxLoad!=null&&s.minLoad!=null&&s.maxLoad!==s.minLoad)) {
      const top=stats.filter(s=>s.medLoad!=null).map(s=>`${x(s.hour)},${y(s.maxLoad??s.medLoad)}`);
      const bot=stats.filter(s=>s.medLoad!=null).map(s=>`${x(s.hour)},${y(s.minLoad??s.medLoad)}`).reverse();
      band=`<polygon points="${top.concat(bot).join(" ")}" fill="var(--band)" stroke="none"/>`;
    }
    const line = pts.map((s,i)=>`${i?'L':'M'}${x(s.hour)},${y(s.medLoad)}`).join(" ");
    let dots=""; for(const s of pts) dots+=`<circle cx="${x(s.hour)}" cy="${y(s.medLoad)}" r="3.4" fill="var(--s1)" data-h="${s.hour}" data-med="${s.medLoad}" data-min="${s.minLoad}" data-max="${s.maxLoad}" data-util="${s.medUtil??''}"/>`;
    q("#arc-trend").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Median ARC load by hour">${g}${band}<line class="base" x1="${m.l}" y1="${m.t+ih}" x2="${m.l+iw}" y2="${m.t+ih}"/><path d="${line}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>${dots}${xl}</svg>`;
    qa("#arc-trend circle").forEach(c=>{
      c.style.cursor="crosshair";
      c.addEventListener("mousemove",ev=>{ c.setAttribute("r","5"); const d=c.dataset, u=d.util?` · <b>${pct(+d.util)}</b> of cap`:""; tip(ev,`<b>${hh(+d.h)}</b><br>median <b>${fmt(+d.med)}</b>${u}<br>range ${fmt(+d.min)}–${fmt(+d.max)}`); });
      c.addEventListener("mouseleave",()=>{ c.setAttribute("r","3.4"); hideTip(); });
    });
  }

  function renderHeatmap(stats, g) {
    const rows=g.dates.length, cellW=40, cellH=30, labelW=92, top=24, gap=2;
    const W=labelW+24*cellW+12, H=top+rows*cellH+34;
    let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="ARC heaviness by day and hour">`;
    for(let h=0;h<24;h++) if(h%2===0) svg+=`<text class="ax" x="${labelW+h*cellW+cellW/2}" y="${top-8}" text-anchor="middle">${String(h).padStart(2,"0")}</text>`;
    svg+=`<text class="axt" x="${labelW+24*cellW/2}" y="${H-6}" text-anchor="middle">Hour of day →</text>`;
    g.dates.forEach((d,ri)=>{
      const yy=top+ri*cellH;
      svg+=`<text class="ax" x="${labelW-10}" y="${yy+cellH/2+3}" text-anchor="end">${dowLabel(d)}</text>`;
      for(let h=0;h<24;h++){
        const c=g.cell(d,h), xx=labelW+h*cellW;
        let fill="var(--surf)", stroke="var(--grid)", tp="no data";
        if(c&&c.util!=null){ fill=heavinessColor(c.util); if(c.util>1) stroke=CRITICAL; tp=`${pct(c.util)} · load ${fmt(c.load)} / cap ${fmt(c.capacity)}`; }
        else if(c&&c.load){ fill="var(--chip)"; tp=`load ${fmt(c.load)} · no capacity`; }
        svg+=`<rect x="${xx+gap/2}" y="${yy+gap/2}" width="${cellW-gap}" height="${cellH-gap}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="${(c&&c.util>1)?1.6:1}" data-tip="${d} ${hh(h)}<br>${tp}"></rect>`;
      }
    });
    svg+=`</svg>`;
    q("#arc-heat").innerHTML = svg;
    qa("#arc-heat rect").forEach(r=>{ r.style.cursor="crosshair";
      r.addEventListener("mousemove",ev=>tip(ev,r.dataset.tip)); r.addEventListener("mouseleave",hideTip); });
  }

  function renderTable(stats, g) {
    let h=`<table class="arc-data"><thead><tr><th>Hour</th><th>Median load</th><th>Min</th><th>Max</th><th>Median cap</th><th>Median heaviness</th>`;
    h+=g.dates.map(d=>`<th>${dowLabel(d)}</th>`).join("")+`</tr></thead><tbody>`;
    for(const s of stats){
      h+=`<tr><td>${hh(s.hour)}</td><td class="n">${fmt(s.medLoad)}</td><td class="n">${fmt(s.minLoad)}</td><td class="n">${fmt(s.maxLoad)}</td><td class="n">${fmt(s.medCap)}</td><td class="n" style="${s.medUtil>1?'color:'+CRITICAL+';font-weight:700':''}">${pct(s.medUtil)}</td>`;
      h+=g.dates.map(d=>{ const c=g.cell(d,s.hour); return `<td class="n" style="${c&&c.util>1?'color:'+CRITICAL+';font-weight:700':''}">${c?pct(c.util):'—'}</td>`; }).join("")+`</tr>`;
    }
    q("#arc-table").innerHTML = h+`</tbody></table>`;
  }
  function toggleTable(){ const t=q("#arc-table"); const open=t.hidden; t.hidden=!open; q("#arc-tbl-toggle").textContent = open ? "Hide data table ▴" : "Show data table ▾"; }

  // ── Tooltip ─────────────────────────────────────────────────────────────
  function tip(ev, html) {
    const t = q("#arc-tip"); t.innerHTML = html; t.classList.add("show");
    let x=ev.clientX+14, y=ev.clientY+14; const r=t.getBoundingClientRect();
    if (x+r.width > PAGE.innerWidth-8) x = ev.clientX-r.width-14;
    if (y+r.height > PAGE.innerHeight-8) y = ev.clientY-r.height-14;
    t.style.left=x+"px"; t.style.top=y+"px";
  }
  function hideTip(){ const t=q("#arc-tip"); if(t) t.classList.remove("show"); }

  // ── Paste-JSON fallback ─────────────────────────────────────────────────
  function showPaste(){ q("#arc-paste-box").hidden=false; }
  function hidePaste(){ q("#arc-paste-box").hidden=true; }
  function applyPaste(){
    const raw=q("#arc-paste-input").value.trim(); if(!raw) return;
    let json; try{ json=JSON.parse(raw); }catch(e){ alert("Not valid JSON: "+e.message); return; }
    const recs=normalizeArcRecords(json, currentNode(), currentStart());
    if(!recs.filter(r=>r.load!=null).length){ alert("Couldn't find load/capacity/hour fields in that JSON. Share one record's shape and I'll map it."); return; }
    RECORDS=recs; LAST_RAW=json; CAPTURE_COUNT++; hidePaste(); render();
  }

  // ── Bridge to local dashboard (optional) ────────────────────────────────
  function sendToBridge() {
    if (typeof GM_xmlhttpRequest !== "function") { alert("GM_xmlhttpRequest not granted — bridge unavailable."); return; }
    const payload = { source:"arcCapacity", node:currentNode(), startDate:currentStart(), endDate:currentEnd(),
                      capturedAt:Date.now(), records:RECORDS, raw:LAST_RAW };
    GM_xmlhttpRequest({
      method:"POST", url:BRIDGE_URL, headers:{"Content-Type":"application/json"}, data:JSON.stringify(payload),
      onload:  () => flash("Sent to dashboard ✓"),
      onerror: () => flash("Bridge not reachable — is server.py running on :5220?"),
      ontimeout: () => flash("Bridge timed out"),
    });
  }
  function flash(msg){ const s=q("#arc-status"); if(!s) return; const old=s.textContent; s.textContent=msg; setTimeout(()=>updateBadge(),2500); }

  // ══════════════════════════════════════════════════════════════════════════
  //  5. STYLE + MARKUP (inside the shadow root)
  // ══════════════════════════════════════════════════════════════════════════
  const STYLE = `<style>
    :host, * { box-sizing:border-box; }
    :host {
      --surf:#fcfcfb; --plane:#ffffff; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
      --grid:#e1e0d9; --base:#c3c2b7; --s1:#2a78d6; --band:rgba(42,120,214,.16);
      --border:rgba(11,11,11,.10); --hdr:#1a1a2e; --chip:#eef1f5; --chipb:#d9dee6;
      font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --surf:#1a1a19; --plane:#201f1e; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
        --grid:#2c2c2a; --base:#383835; --s1:#3987e5; --band:rgba(57,135,229,.20);
        --border:rgba(255,255,255,.12); --hdr:#101019; --chip:#2a2a28; --chipb:#3a3a37;
      }
    }
    .arc-launch {
      position:fixed; right:18px; bottom:18px; z-index:2147483000;
      background:var(--s1); color:#fff; border:none; border-radius:22px; padding:10px 16px;
      font:600 13px/1 system-ui,sans-serif; cursor:pointer; box-shadow:0 4px 14px rgba(0,0,0,.3);
    }
    .arc-launch:hover{ filter:brightness(1.06); }
    .arc-badge { position:absolute; top:-6px; right:-6px; background:var(--s1); color:#fff;
      border:2px solid var(--plane); border-radius:10px; min-width:18px; height:18px; padding:0 4px;
      font:700 10px/14px system-ui,sans-serif; text-align:center; }
    .arc-drawer[hidden], [hidden]{ display:none !important; }
    .arc-drawer {
      position:fixed; inset:0 0 0 auto; width:min(1000px,96vw); z-index:2147483001;
      background:var(--plane); color:var(--ink); box-shadow:-8px 0 40px rgba(0,0,0,.35);
      display:flex; flex-direction:column; font-size:13px;
    }
    .arc-head { background:var(--hdr); color:#fff; padding:11px 16px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .arc-head h1 { font-size:15px; font-weight:600; flex:1; min-width:180px; }
    .arc-head .scope { font-size:11px; color:#b7c0d0; }
    .arc-btn { background:rgba(255,255,255,.14); color:#fff; border:1px solid rgba(255,255,255,.18);
      border-radius:5px; padding:5px 11px; font:600 12px system-ui,sans-serif; cursor:pointer; }
    .arc-btn:hover{ background:rgba(255,255,255,.24); }
    .arc-btn.primary{ background:var(--s1); border-color:var(--s1); }
    .arc-sub { padding:8px 16px; background:var(--surf); border-bottom:1px solid var(--border);
      display:flex; gap:16px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--ink2); }
    .arc-sub input { font:inherit; font-size:12px; padding:3px 7px; border-radius:4px; border:1px solid var(--chipb);
      background:var(--plane); color:var(--ink); width:90px; }
    #arc-status { margin-left:auto; color:var(--muted); }
    .arc-body { padding:14px 16px; overflow-y:auto; }
    .arc-card { background:var(--surf); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:14px; }
    .arc-card h2 { font-size:14px; font-weight:700; margin:0 0 2px; }
    .arc-card p { font-size:11.5px; color:var(--ink2); margin:0 0 8px; line-height:1.5; }
    .arc-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
    .arc-kpi { background:var(--plane); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
    .arc-kpi .k-label{ font:700 10px system-ui; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); }
    .arc-kpi .k-val{ font-size:24px; font-weight:650; margin-top:3px; letter-spacing:-.5px; }
    .arc-kpi .k-note{ font-size:11px; color:var(--ink2); margin-top:1px; }
    .arc-kpi.hot .k-val{ color:${CRITICAL}; }
    svg { display:block; width:100%; height:auto; overflow:visible; }
    .ax{ fill:var(--muted); font-size:10px; } .axt{ fill:var(--ink2); font-size:11px; font-weight:600; }
    .grid{ stroke:var(--grid); stroke-width:1; } .base{ stroke:var(--base); stroke-width:1.5; }
    .legend{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-top:10px; font-size:11px; color:var(--ink2); }
    .ramp{ width:130px; height:12px; border-radius:3px; border:1px solid var(--border);
      background:linear-gradient(90deg,#cde2fb,#9ec5f4,#5598e7,#2a78d6,#1c5cab,#104281); }
    .swatch{ width:14px; height:14px; border-radius:3px; display:inline-block; vertical-align:-2px; background:${CRITICAL}; }
    .link{ color:var(--s1); cursor:pointer; font-weight:600; font-size:11.5px; margin-left:auto; }
    .link:hover{ text-decoration:underline; }
    table.arc-data{ width:100%; border-collapse:collapse; font-size:12px; margin-top:12px; }
    table.arc-data th,table.arc-data td{ padding:4px 8px; border-bottom:1px solid var(--grid); text-align:right; white-space:nowrap; }
    table.arc-data th{ color:var(--muted); font:700 10.5px system-ui; text-transform:uppercase; letter-spacing:.3px; }
    table.arc-data td:first-child,table.arc-data th:first-child{ text-align:left; }
    .n{ font-variant-numeric:tabular-nums; }
    .arc-empty{ text-align:center; padding:48px 20px; color:var(--ink2); }
    .arc-empty .i{ font-size:34px; } .arc-empty h3{ margin:8px 0 6px; color:var(--ink); font-size:15px; }
    .arc-empty p{ font-size:12px; line-height:1.6; max-width:440px; margin:0 auto; }
    #arc-paste-box{ padding:0 16px 14px; }
    #arc-paste-input{ width:100%; height:120px; font:11px/1.4 ui-monospace,monospace; padding:8px;
      border:1px solid var(--chipb); border-radius:6px; background:var(--surf); color:var(--ink); resize:vertical; }
    .arc-paste-row{ display:flex; gap:8px; justify-content:flex-end; margin-top:8px; }
    #arc-tip{ position:fixed; z-index:2147483002; pointer-events:none; opacity:0; transition:opacity .08s;
      background:var(--ink); color:var(--plane); font-size:11.5px; line-height:1.45; padding:7px 9px;
      border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,.3); max-width:220px; }
    #arc-tip.show{ opacity:1; }
    code{ background:var(--chip); border:1px solid var(--chipb); border-radius:3px; padding:1px 5px; font-size:11px; }
  </style>`;

  const MARKUP = `
    <button class="arc-launch" title="ARC Capacity — load median & heaviness">📊 ARC<span class="arc-badge" hidden>0</span></button>
    <section class="arc-drawer" hidden>
      <div class="arc-head">
        <h1>ARC Capacity <span class="scope" id="arc-scope"></span></h1>
        <button class="arc-btn" id="arc-rescan">⟳ Re-scan</button>
        <button class="arc-btn" id="arc-paste">📋 Paste JSON</button>
        <button class="arc-btn" id="arc-bridge">↗ Dashboard</button>
        <button class="arc-btn" id="arc-close">✕ Close</button>
      </div>
      <div class="arc-sub">
        <span>Node <input id="arc-node" value="RFD2" readonly></span>
        <span>Start <b id="arc-start">—</b></span>
        <span>End <b id="arc-end">—</b></span>
        <span id="arc-status">Waiting for data…</span>
      </div>
      <div id="arc-paste-box" hidden>
        <textarea id="arc-paste-input" placeholder='Paste the arc-capacity JSON response here…'></textarea>
        <div class="arc-paste-row"><button class="arc-btn" id="arc-paste-cancel">Cancel</button><button class="arc-btn primary" id="arc-paste-go">Analyze</button></div>
      </div>
      <div class="arc-body">
        <div id="arc-empty" class="arc-empty">
          <div class="i">📦</div><h3>Waiting for ARC data</h3>
          <p>Open the <b>arc-capacity</b> view in Crossdock Manager for your node — this script watches the page's network calls and captures the load/capacity data automatically. Or click <b>📋 Paste JSON</b> to analyze a response you copied.</p>
        </div>
        <div id="arc-results" hidden>
          <div class="arc-card"><h2>Summary — median hourly profile</h2><p id="arc-kpi-sub"></p><div class="arc-kpis" id="arc-kpi"></div></div>
          <div class="arc-card"><h2>ARC load median, hour by hour</h2><p>Median load across the selected days for each hour (line), with the day-to-day spread (band = min→max).</p><div id="arc-trend"></div></div>
          <div class="arc-card">
            <h2>How heavy is the ARC — by day &amp; hour</h2>
            <p>Heaviness = load ÷ capacity. Darker blue = closer to capacity; <b style="color:${CRITICAL}">red = over capacity (&gt;100%)</b>.</p>
            <div id="arc-heat"></div>
            <div class="legend"><span>0%</span><span class="ramp"></span><span>100%</span><span><span class="swatch"></span> Over capacity</span><span class="link" id="arc-tbl-toggle">Show data table ▾</span></div>
            <div id="arc-table" hidden></div>
          </div>
        </div>
      </div>
    </section>
    <div id="arc-tip"></div>`;

  // ══════════════════════════════════════════════════════════════════════════
  //  6. BOOT
  // ══════════════════════════════════════════════════════════════════════════
  hookNetwork();
  const ready = fn => (document.readyState === "loading")
    ? document.addEventListener("DOMContentLoaded", fn, { once:true }) : fn();
  ready(buildPanel);
})();
