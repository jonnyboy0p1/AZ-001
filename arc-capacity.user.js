// ==UserScript==
// @name         ARC Capacity — Load Median & Heaviness (Crossdock + DockFlow)
// @namespace    rb20.arc-capacity
// @version      2.0.0
// @description  Blends Crossdock Manager arc-capacity (planned load ÷ capacity, hour by hour) with live DockFlow data (Sorter Arc utilization + recircs, allocation plan by destination, routing profiles & load doors) into one heaviness view. Auto-captures each source from the page's own network calls and shares captures across tabs — no proxy, no cookie handling.
// @author       RB20
// @match        https://crossdock-manager.harmony.a2z.com/*
// @match        https://*.harmony.a2z.com/*
// @match        https://*.dockflow.robotics.a2z.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const PAGE = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
  const BRIDGE_URL = "http://localhost:5220/bridge";
  const SOURCES = ["crossdock", "sorter", "alloc", "profiles", "doors"];

  // ── Palette (validated data-viz reference) ────────────────────────────────
  const BLUE_RAMP = ["#cde2fb","#b7d3f6","#9ec5f4","#86b6ef","#6da7ec","#5598e7",
                     "#3987e5","#2a78d6","#256abf","#1c5cab","#184f95","#104281","#0d366b"];
  const CRITICAL = "#d03b3b", AQUA = "#1baf7a", ORANGE = "#eb6834", INK_RING = "#eda100";

  // ── Field-name candidates ─────────────────────────────────────────────────
  const DATE_KEYS = ["date","day","dateString","businessDate","planDate","localDate","dateLocal"];
  const TIME_KEYS = ["timestamp","time","startTime","intervalStart","dateTime","datetime","epoch","epochMillis","start","periodStart"];
  const HOUR_KEYS = ["hour","hourOfDay","hr","hourStart","intervalHour"];
  const LOAD_KEYS = ["load","arcLoad","arcLoadUnits","actualLoad","projectedLoad","forecastLoad","volume","units","value","loadUnits","demand"];
  const CAP_KEYS  = ["capacity","arcCapacity","maxCapacity","plannedCapacity","cap","capacityUnits","effectiveCapacity","targetCapacity"];
  const NODE_KEYS = ["nodes","warehouses","stations","byNode","data"];
  // DockFlow
  const ARC_KEYS      = ["arc","arcId","arcName","arcs"];
  const WORKCELL_KEYS = ["name","workcell","workcellName","cell","id"];
  const UTIL_KEYS     = ["utilization","util","utilizationPct","utilizationPercent","utilisation"];
  const RECIRC_KEYS   = ["recircs","recirc","recirculations","recircs15min","recircslast15min","totalrecircs"];
  const STATUS_KEYS   = ["status","state"];
  const RELATED_KEYS  = ["arcrelatedworkcells","relatedworkcells","related"];
  const DEST_KEYS     = ["destination","dest","destinationid","destcode","lane"];
  const ALLOC_KEYS    = ["allocation","allocated","allocatedunits","plannedunits","planned","allocationunits","count","units","volume"];
  const PROFILE_KEYS  = ["routingprofile","profile","routingprofilename","profilename"];
  const PID_KEYS      = ["pidtotal","pid","pidcount","totalpid"];
  const DOOR_KEYS     = ["door","loaddoor","doorid","doorname","dock","dockdoor"];
  const SIDE_KEYS     = ["side","zone","cluster","group"];

  // ── State ─────────────────────────────────────────────────────────────────
  const STORE = { crossdock:null, sorter:null, alloc:null, profiles:null, doors:null };
  let DEMO = false;
  let shadow = null;
  const q  = s => shadow && shadow.querySelector(s);
  const qa = s => shadow ? [...shadow.querySelectorAll(s)] : [];
  const GM_OK = (typeof GM_setValue === "function" && typeof GM_getValue === "function");

  // ══════════════════════════════════════════════════════════════════════════
  //  1. NETWORK CAPTURE (installed immediately)
  // ══════════════════════════════════════════════════════════════════════════
  function hookNetwork() {
    try {
      const origFetch = PAGE.fetch;
      if (typeof origFetch === "function") {
        PAGE.fetch = function (...args) {
          const p = origFetch.apply(this, args);
          try { p.then(res => { try {
            const c = res.clone(); const ct = (c.headers.get("content-type") || "").toLowerCase();
            if (ct.includes("json")) c.json().then(consider).catch(() => {});
          } catch (e) {} }).catch(() => {}); } catch (e) {}
          return p;
        };
      }
    } catch (e) {}
    try {
      const XHR = PAGE.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        const open = XHR.prototype.open, send = XHR.prototype.send;
        XHR.prototype.open = function (m, u) { this.__u = u; return open.apply(this, arguments); };
        XHR.prototype.send = function () {
          this.addEventListener("load", function () {
            try {
              const t = this.responseText || "";
              const ct = (this.getResponseHeader && (this.getResponseHeader("content-type") || "")).toLowerCase();
              if (ct.includes("json") || /^\s*[\[{]/.test(t)) consider(JSON.parse(t));
            } catch (e) {}
          });
          return send.apply(this, arguments);
        };
      }
    } catch (e) {}
  }

  // Route a captured JSON payload to whichever source it matches (signature-based).
  function consider(json) {
    try {
      const keys = rowKeys(json);
      if (hasAny(keys, LOAD_KEYS) && (hasAny(keys, CAP_KEYS) || hasAny(keys, HOUR_KEYS) || hasAny(keys, DATE_KEYS) || hasAny(keys, TIME_KEYS))) {
        const recs = normalizeArcRecords(json, currentNode(), currentStart());
        if (recs.filter(r => r.load != null).length >= 6) return save("crossdock", { records: recs });
      }
      if (hasAny(keys, ARC_KEYS) && (hasAny(keys, UTIL_KEYS) || hasAny(keys, RECIRC_KEYS))) {
        const s = normalizeSorter(json); if (s && s.workcells.length >= 3) return save("sorter", s);
      }
      if (hasAny(keys, DEST_KEYS)) { const a = normalizeAllocation(json); if (a && a.length >= 2) return save("alloc", { rows: a }); }
      if (hasAny(keys, DOOR_KEYS) && hasAny(keys, RECIRC_KEYS)) { const d = normalizeDoors(json); if (d && d.length >= 2) return save("doors", { rows: d }); }
      if (hasAny(keys, PROFILE_KEYS) || hasAny(keys, PID_KEYS)) { const p = normalizeProfiles(json); if (p && p.length >= 2) return save("profiles", { rows: p }); }
    } catch (e) {}
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  2. GENERIC HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function pick(obj, names) {
    if (!obj || typeof obj !== "object") return undefined;
    const want = names.map(norm);
    for (const k of Object.keys(obj)) if (want.includes(norm(k)) && obj[k] != null && obj[k] !== "") return obj[k];
  }
  function firstKey(obj, keys) { for (const k of keys) if (obj != null && obj[k] != null && obj[k] !== "") return obj[k]; }
  function toNum(v) { if (v == null) return null; if (typeof v === "number") return isFinite(v) ? v : null;
    const n = parseFloat(String(v).replace(/[, %]/g, "")); return isNaN(n) ? null : n; }
  function toUtil(v) { let n = toNum(v); if (n == null) return null; if (n > 1.5) n /= 100; return n; }
  function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
  function unwrap(json, node) {
    let cur = json;
    for (let i = 0; i < 6 && cur && !Array.isArray(cur); i++) {
      if (node && cur[node] != null) { cur = cur[node]; continue; }
      const nm = NODE_KEYS.map(k => cur[k]).find(v => v && typeof v === "object");
      if (nm && node && nm[node] != null) { cur = nm[node]; continue; }
      const w = ["data","rows","records","items","results","intervals","buckets","series","hours","points","content","payload","table","entries","values"]
        .map(k => cur[k]).find(v => v != null);
      if (w != null) { cur = w; continue; }
      break;
    }
    return cur;
  }
  function rowKeys(json) {
    let cur = unwrap(json, currentNode());
    if (Array.isArray(cur) && cur.length && typeof cur[0] === "object" && cur[0]) return new Set(Object.keys(cur[0]).map(norm));
    if (cur && typeof cur === "object") return new Set(Object.keys(cur).map(norm));
    return new Set();
  }
  function hasAny(set, names) { return names.some(n => set.has(norm(n))); }

  // ── Crossdock normalizer ──────────────────────────────────────────────────
  function parseWhen(v) {
    if (v == null) return null;
    const s = String(v);
    const dm = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}))?/);
    if (dm && !/^\d+$/.test(s)) return { dateISO: `${dm[1]}-${dm[2]}-${dm[3]}`, hour: dm[4] != null ? parseInt(dm[4],10) : null };
    if (typeof v === "number" || /^\d+$/.test(s)) { let n = Number(v); if (n < 1e11) n *= 1000; const d = new Date(n); return isNaN(d.getTime()) ? null : { dateISO: isoDate(d), hour: d.getHours() }; }
    const p = Date.parse(s); if (isNaN(p)) return null; const d = new Date(p); return { dateISO: isoDate(d), hour: d.getHours() };
  }
  function normalizeArcRecords(json, node, fallbackStartISO) {
    const out = []; let cur = unwrap(json, node);
    if (cur && !Array.isArray(cur) && typeof cur === "object") {
      const loadArr = firstKey(cur, LOAD_KEYS), capArr = firstKey(cur, CAP_KEYS);
      if (Array.isArray(loadArr)) { const day = fallbackStartISO || isoDate(new Date());
        loadArr.forEach((lv, h) => out.push({ dateISO: day, hour: h % 24, load: toNum(lv), capacity: Array.isArray(capArr) ? toNum(capArr[h]) : toNum(capArr) }));
        return out; }
    }
    if (!Array.isArray(cur)) return out;
    cur.forEach((row, idx) => {
      if (row == null) return;
      if (typeof row === "number") { out.push({ dateISO: fallbackStartISO || isoDate(new Date()), hour: idx % 24, load: row, capacity: null }); return; }
      let dateISO = null, hour = null;
      const dRaw = firstKey(row, DATE_KEYS), hRaw = firstKey(row, HOUR_KEYS), tRaw = firstKey(row, TIME_KEYS);
      const wd = dRaw != null ? parseWhen(dRaw) : null, wt = tRaw != null ? parseWhen(tRaw) : null;
      if (wd) dateISO = wd.dateISO;
      if (dateISO == null && wt) dateISO = wt.dateISO;
      if (hRaw != null) hour = toNum(hRaw);
      if (hour == null && wt && wt.hour != null) hour = wt.hour;
      if (hour == null && wd && wd.hour != null) hour = wd.hour;
      if (dateISO == null) dateISO = fallbackStartISO || isoDate(new Date());
      if (hour == null) hour = idx % 24;
      out.push({ dateISO, hour: ((toNum(hour) || 0) % 24 + 24) % 24, load: toNum(firstKey(row, LOAD_KEYS)), capacity: toNum(firstKey(row, CAP_KEYS)) });
    });
    return out;
  }

  // ── DockFlow normalizers ──────────────────────────────────────────────────
  function summarizeSorter(wc) {
    const byArc = new Map();
    for (const w of wc) { const g = byArc.get(w.arc) || { arc: w.arc, utils: [], recircs: 0, n: 0 };
      if (w.utilization != null) g.utils.push(w.utilization); if (w.recircs != null) g.recircs += w.recircs; g.n++; byArc.set(w.arc, g); }
    const arcs = [...byArc.values()].map(g => ({ arc: g.arc,
      util: g.utils.length ? g.utils.reduce((s,x)=>s+x,0)/g.utils.length : null,
      utilMax: g.utils.length ? Math.max(...g.utils) : null, recircs: g.recircs, cells: g.n }))
      .sort((a,b) => (b.util ?? -1) - (a.util ?? -1));
    const all = wc.map(w => w.utilization).filter(u => u != null);
    return { workcells: wc, arcs, nodeUtil: all.length ? all.reduce((s,x)=>s+x,0)/all.length : null,
      nodeUtilPeak: all.length ? Math.max(...all) : null, totalRecircs: wc.reduce((s,w)=>s+(w.recircs||0),0) };
  }
  function normalizeSorter(json) {
    let cur = unwrap(json, currentNode()); if (!Array.isArray(cur)) return null;
    const wc = [];
    for (const r of cur) { if (!r || typeof r !== "object") continue;
      const arc = pick(r, ARC_KEYS);
      wc.push({ workcell: pick(r, WORKCELL_KEYS) || "", arc: arc != null ? String(arc) : "—",
        status: pick(r, STATUS_KEYS) || "", utilization: toUtil(pick(r, UTIL_KEYS)),
        recircs: toNum(pick(r, RECIRC_KEYS)), related: pick(r, RELATED_KEYS) || "" }); }
    return wc.length ? summarizeSorter(wc) : null;
  }
  function normalizeAllocation(json) {
    let cur = unwrap(json, currentNode()); if (!Array.isArray(cur)) return null;
    const rows = [];
    for (const r of cur) { if (!r || typeof r !== "object") continue; const d = pick(r, DEST_KEYS); if (d == null) continue;
      rows.push({ destination: String(d), units: toNum(pick(r, ALLOC_KEYS)), doors: toNum(pick(r, ["doors","doorcount"])) }); }
    return rows.length ? rows.sort((a,b) => (b.units ?? -1) - (a.units ?? -1)) : null;
  }
  function normalizeProfiles(json) {
    let cur = unwrap(json, currentNode()); if (!Array.isArray(cur)) return null;
    const rows = [];
    for (const r of cur) { if (!r || typeof r !== "object") continue; const p = pick(r, PROFILE_KEYS), pid = toNum(pick(r, PID_KEYS));
      if (p == null && pid == null) continue; rows.push({ profile: p != null ? String(p) : "—", pidTotal: pid, recircs: toNum(pick(r, RECIRC_KEYS)) }); }
    return rows.length ? rows.sort((a,b) => (b.pidTotal ?? -1) - (a.pidTotal ?? -1)) : null;
  }
  function normalizeDoors(json) {
    let cur = unwrap(json, currentNode()); if (!Array.isArray(cur)) return null;
    const rows = [];
    for (const r of cur) { if (!r || typeof r !== "object") continue; const d = pick(r, DOOR_KEYS); if (d == null) continue;
      rows.push({ door: String(d), recircs: toNum(pick(r, RECIRC_KEYS)), side: pick(r, SIDE_KEYS) || null }); }
    return rows.length ? rows.sort((a,b) => (b.recircs ?? -1) - (a.recircs ?? -1)) : null;
  }

  // ── Stats (crossdock) ─────────────────────────────────────────────────────
  function quantile(a,p){ if(!a.length) return null; const pos=(a.length-1)*p, lo=Math.floor(pos), hi=Math.ceil(pos); return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(pos-lo); }
  const median = a => quantile(a,0.5);
  function hourlyStats(records) {
    const byHour = Array.from({length:24}, () => ({loads:[],caps:[]}));
    for (const r of records) { if (r.load != null) byHour[r.hour].loads.push(r.load); if (r.capacity != null) byHour[r.hour].caps.push(r.capacity); }
    return byHour.map((h,hour) => { const loads=h.loads.slice().sort((a,b)=>a-b), caps=h.caps.slice().sort((a,b)=>a-b);
      const medLoad=median(loads), medCap=median(caps);
      return { hour, medLoad, minLoad:loads[0]??null, maxLoad:loads[loads.length-1]??null, q1:quantile(loads,.25), q3:quantile(loads,.75),
        medCap, medUtil:(medLoad!=null&&medCap)?medLoad/medCap:null, n:loads.length }; });
  }
  function grid(records) {
    const dates = [...new Set(records.map(r=>r.dateISO))].sort(); const map = new Map();
    for (const r of records) { const k=r.dateISO+"|"+r.hour, c=map.get(k)||{load:0,capacity:null,n:0};
      if (r.load!=null){c.load+=r.load;c.n++;} if (r.capacity!=null)c.capacity=(c.capacity||0)+r.capacity; map.set(k,c); }
    for (const c of map.values()) c.util=(c.capacity&&c.n)?c.load/c.capacity:null;
    return { dates, cell:(d,h)=>map.get(d+"|"+h)||null };
  }

  // ── Format / color ────────────────────────────────────────────────────────
  function fmt(n,d=0){ return (n==null||isNaN(n))?"—":Number(n).toLocaleString(undefined,{maximumFractionDigits:d,minimumFractionDigits:d}); }
  function pct(u){ return u==null?"—":Math.round(u*100)+"%"; }
  function signPP(x){ if(x==null||isNaN(x))return"—"; const v=Math.round(x*100); return (v>0?"+":"")+v+" pp"; }
  function hh(h){ return String(h).padStart(2,"0")+":00"; }
  function dowLabel(iso){ const d=new Date(iso+"T00:00:00"); return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]+" "+iso.slice(5); }
  function hex(h){ h=h.replace("#",""); if(h.length===3)h=h.split("").map(c=>c+c).join(""); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
  function mix(a,b,t){ const ca=hex(a),cb=hex(b); return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`; }
  function heavinessColor(u){ if(u>1){const t=Math.min((u-1)/.5,1);return mix(CRITICAL,"#7a1414",t);} const i=Math.min(u,1)*(BLUE_RAMP.length-1),lo=Math.floor(i),hi=Math.min(lo+1,BLUE_RAMP.length-1); return mix(BLUE_RAMP[lo],BLUE_RAMP[hi],i-lo); }
  function niceNum(x){ const e=Math.pow(10,Math.floor(Math.log10(x))); const f=x/e; return (f<1.5?1:f<3?2:f<7?5:10)*e; }
  function niceTicks(max,n){ const s=niceNum(max/n),o=[]; for(let v=0;v<=max;v+=s)o.push(v); return o; }
  function esc(s){ return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // ── Node / dates from URL (crossdock hash params OR dockflow path) ─────────
  function urlParams(){ const out={}; const g=qs=>{ const m=qs&&qs.indexOf("?")>=0?qs.slice(qs.indexOf("?")+1):""; new URLSearchParams(m).forEach((v,k)=>out[k]=v); }; g(PAGE.location.hash); g(PAGE.location.search); return out; }
  function currentNode(){
    const host = PAGE.location.host || "";
    if (host.includes("dockflow")) { const seg=(PAGE.location.pathname||"").split("/").filter(Boolean)[0]; if(seg&&/^[a-z0-9]{3,6}$/i.test(seg)) return seg.toUpperCase(); }
    const p = urlParams(); return (p.nodes||p.node||p.warehouseId||"RFD2").split(",")[0].trim().toUpperCase();
  }
  function currentStart(){ return urlParams().startDate || (STORE.crossdock && STORE.crossdock.records && STORE.crossdock.records[0] && STORE.crossdock.records[0].dateISO) || null; }
  function currentEnd(){ return urlParams().endDate || null; }

  // ══════════════════════════════════════════════════════════════════════════
  //  3. SHARED STORAGE (cross-tab)
  // ══════════════════════════════════════════════════════════════════════════
  function gmKey(src){ return `arc:${currentNode()}:${src}`; }
  function save(src, obj){
    STORE[src] = Object.assign({}, obj, { at: Date.now(), node: currentNode() });
    DEMO = false;
    if (GM_OK) { try { GM_setValue(gmKey(src), JSON.stringify(STORE[src])); } catch(e){} }
    onCaptured();
  }
  function loadFromGM(){
    if (!GM_OK) return;
    for (const src of SOURCES) { try { const v = GM_getValue(gmKey(src)); if (v) { const o = JSON.parse(v); if (o && o.node === currentNode()) STORE[src] = o; } } catch(e){} }
  }
  function watchGM(){
    if (typeof GM_addValueChangeListener !== "function") return;
    for (const src of SOURCES) { try { GM_addValueChangeListener(gmKey(src), () => { loadFromGM(); if (isOpen()) render(); updateBadge(); }); } catch(e){} }
  }
  function sourcesPresent(){ return SOURCES.filter(s => STORE[s]).length; }

  // ══════════════════════════════════════════════════════════════════════════
  //  4. PANEL
  // ══════════════════════════════════════════════════════════════════════════
  function buildPanel(){
    if (shadow) return;
    const host = document.createElement("div"); host.id = "arc-tm-host"; host.style.cssText = "all:initial";
    (document.body || document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = STYLE + MARKUP;
    q(".arc-launch").addEventListener("click", () => { openDrawer(); render(); });
    q("#arc-close").addEventListener("click", closeDrawer);
    q("#arc-rescan").addEventListener("click", render);
    q("#arc-demo").addEventListener("click", loadDemo);
    q("#arc-paste").addEventListener("click", showPaste);
    q("#arc-paste-cancel").addEventListener("click", hidePaste);
    q("#arc-paste-go").addEventListener("click", applyPaste);
    q("#arc-bridge").addEventListener("click", sendToBridge);
    q("#arc-tbl-toggle").addEventListener("click", toggleTable);
    loadFromGM(); watchGM(); updateBadge();
  }
  function openDrawer(){ q(".arc-drawer").hidden = false; }
  function closeDrawer(){ q(".arc-drawer").hidden = true; }
  function isOpen(){ return shadow && !q(".arc-drawer").hidden; }
  function onCaptured(){ if (!shadow) return; updateBadge(); if (isOpen()) render(); }

  const SRC_LABEL = { crossdock:"Crossdock", sorter:"Sorter", alloc:"Alloc", profiles:"Profiles", doors:"Doors" };
  function updateBadge(){
    const b = q(".arc-badge"); if (!b) return;
    const n = sourcesPresent(); b.textContent = n; b.hidden = n === 0;
    const s = q("#arc-status");
    if (s) s.innerHTML = n
      ? SOURCES.map(k => `${SRC_LABEL[k]} ${STORE[k] ? "<b style='color:"+AQUA+"'>✓</b>" : "<span style='opacity:.5'>—</span>"}`).join(" · ") + (DEMO ? " · <i>demo</i>" : "")
      : "Waiting for data — open the arc-capacity / Sorter / IxdOutbound views, or click Demo.";
  }

  // ── Blend helper: plan (crossdock) vs live actual (sorter) for "now" ──────
  function blendNow(stats, g){
    const s = STORE.sorter;
    const at = s ? new Date(s.at) : new Date();
    const hour = at.getHours(), dISO = isoDate(at);
    let plan = null;
    if (stats) { const st = stats[hour]; plan = st ? st.medUtil : null; if (g) { const c = g.cell(dISO, hour); if (c && c.util != null) plan = c.util; } }
    return { live: s ? s.nodeUtil : null, plan, hour, dISO, recircs: s ? s.totalRecircs : null,
             peakArc: (s && s.arcs && s.arcs[0]) ? s.arcs[0] : null };
  }

  function render(){
    if (!shadow) return;
    const node = currentNode();
    q("#arc-node").value = node;
    const s = currentStart(), e = currentEnd();
    q("#arc-start").textContent = s || "—"; q("#arc-end").textContent = e || "—";

    if (sourcesPresent() === 0) { q("#arc-empty").hidden = false; q("#arc-results").hidden = true; updateBadge(); return; }
    q("#arc-empty").hidden = true; q("#arc-results").hidden = false;

    const cd = (STORE.crossdock && STORE.crossdock.records || []).filter(r => r.load != null);
    let stats = null, g = null;
    if (cd.length) { stats = hourlyStats(cd); g = grid(cd);
      q("#arc-scope").textContent = `${node} · ${g.dates[0]}→${g.dates[g.dates.length-1]} · ${g.dates.length} day(s)`; }
    else q("#arc-scope").textContent = `${node} · live DockFlow only`;

    const live = blendNow(stats, g);
    renderKpis(stats, g, live);
    show("#card-trend", !!stats); show("#card-heat", !!stats); show("#card-table", !!stats);
    if (stats) { renderTrend(stats); renderHeatmap(stats, g, live); renderTable(stats, g); }
    renderDock();
    updateBadge();
  }
  function show(sel,on){ const e=q(sel); if(e) e.hidden = !on; }

  function sumDay(g,d){ let s=0; for(let h=0;h<24;h++){ const c=g.cell(d,h); if(c)s+=c.load; } return s; }
  function kpi(label,val,note,hot){ return `<div class="arc-kpi ${hot?'hot':''}"><div class="k-label">${label}</div><div class="k-val">${val}</div><div class="k-note">${note}</div></div>`; }
  function renderKpis(stats, g, live){
    const s = STORE.sorter;
    if (s) {
      const delta = (live.live != null && live.plan != null) ? live.live - live.plan : null;
      q("#arc-kpi-sub").innerHTML = live.plan != null
        ? `Live Arc utilization is <b>${pct(live.live)}</b> vs a planned <b>${pct(live.plan)}</b> for ${hh(live.hour)} — actual is <b style="color:${delta>0?CRITICAL:AQUA}">${signPP(delta)}</b> vs plan.`
        : `Live Arc utilization is <b>${pct(live.live)}</b> across ${s.workcells.length} workcells.`;
      q("#arc-kpi").innerHTML = [
        kpi("Live Arc utilization", pct(live.live), `${s.workcells.length} workcells`, live.live > 1),
        kpi("Plan heaviness", live.plan != null ? pct(live.plan) : "—", `at ${hh(live.hour)}`),
        kpi("Actual − plan", signPP(delta), delta != null ? (delta > 0 ? "over plan" : "under plan") : "no plan yet", delta != null && delta > 0),
        kpi("Peak live Arc", live.peakArc ? `Arc ${esc(live.peakArc.arc)}` : "—", live.peakArc ? pct(live.peakArc.util) : "no arc data", live.peakArc && live.peakArc.util > 1),
        kpi("Live recircs", fmt(live.recircs), "sorter total", false),
      ].join("");
      return;
    }
    // crossdock-only KPIs
    const wl = stats ? stats.filter(x=>x.medLoad!=null) : [];
    const peak = wl.reduce((a,b)=> b.medLoad>(a?.medLoad??-1)?b:a, null);
    const wu = stats ? stats.filter(x=>x.medUtil!=null) : [];
    const peakU = wu.reduce((a,b)=> b.medUtil>(a?.medUtil??-1)?b:a, null);
    const avgU = wu.length ? wu.reduce((s,x)=>s+x.medUtil,0)/wu.length : null;
    const over = wu.filter(x=>x.medUtil>1).length;
    const busiest = g ? g.dates.map(d=>({d,t:sumDay(g,d)})).reduce((a,b)=> b.t>(a?.t??-1)?b:a, null) : null;
    q("#arc-kpi-sub").textContent = peakU ? `Heaviest hour (median) is ${hh(peakU.hour)} at ${pct(peakU.medUtil)} of capacity.` : "Capacity not present — heaviness needs a capacity field.";
    q("#arc-kpi").innerHTML = [
      kpi("Peak median load", peak?fmt(peak.medLoad):"—", peak?`at ${hh(peak.hour)}`:"no load field"),
      kpi("Peak median heaviness", peakU?pct(peakU.medUtil):"—", peakU?`at ${hh(peakU.hour)}`:"no capacity field", peakU&&peakU.medUtil>1),
      kpi("Avg heaviness", avgU!=null?pct(avgU):"—", wu.length?`${wu.length} hrs`:"—"),
      kpi("Hours over capacity", over+"", over?"median &gt;100%":"none", over>0),
      kpi("Busiest day", busiest?busiest.d.slice(5):"—", busiest?`${fmt(busiest.t)} load`:"—"),
    ].join("");
  }

  function renderTrend(stats){
    const W=1100,H=340,m={t:16,r:16,b:42,l:60},iw=W-m.l-m.r,ih=H-m.t-m.b;
    const pts=stats.filter(s=>s.medLoad!=null); if(!pts.length){ q("#arc-trend").innerHTML=""; return; }
    const maxY=Math.max(...stats.map(s=>s.maxLoad??s.medLoad??0),1)*1.08;
    const x=h=>m.l+(h/23)*iw, y=v=>m.t+ih-(v/maxY)*ih;
    let g=""; for(const t of niceTicks(maxY,5)) g+=`<line class="grid" x1="${m.l}" y1="${y(t)}" x2="${m.l+iw}" y2="${y(t)}"/><text class="ax" x="${m.l-8}" y="${y(t)+3}" text-anchor="end">${fmt(t)}</text>`;
    let xl=""; for(let h=0;h<24;h+=2) xl+=`<text class="ax" x="${x(h)}" y="${m.t+ih+16}" text-anchor="middle">${String(h).padStart(2,"0")}</text>`;
    xl+=`<text class="axt" x="${m.l+iw/2}" y="${H-4}" text-anchor="middle">Hour of day</text><text class="axt" transform="translate(14,${m.t+ih/2}) rotate(-90)" text-anchor="middle">Load (units)</text>`;
    let band="";
    if (stats.some(s=>s.maxLoad!=null&&s.minLoad!=null&&s.maxLoad!==s.minLoad)) {
      const top=stats.filter(s=>s.medLoad!=null).map(s=>`${x(s.hour)},${y(s.maxLoad??s.medLoad)}`);
      const bot=stats.filter(s=>s.medLoad!=null).map(s=>`${x(s.hour)},${y(s.minLoad??s.medLoad)}`).reverse();
      band=`<polygon points="${top.concat(bot).join(" ")}" fill="var(--band)" stroke="none"/>`;
    }
    const line=pts.map((s,i)=>`${i?'L':'M'}${x(s.hour)},${y(s.medLoad)}`).join(" ");
    let dots=""; for(const s of pts) dots+=`<circle cx="${x(s.hour)}" cy="${y(s.medLoad)}" r="3.4" fill="var(--s1)" data-h="${s.hour}" data-med="${s.medLoad}" data-min="${s.minLoad}" data-max="${s.maxLoad}" data-util="${s.medUtil??''}"/>`;
    q("#arc-trend").innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img">${g}${band}<line class="base" x1="${m.l}" y1="${m.t+ih}" x2="${m.l+iw}" y2="${m.t+ih}"/><path d="${line}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>${dots}${xl}</svg>`;
    qa("#arc-trend circle").forEach(c=>{ c.style.cursor="crosshair";
      c.addEventListener("mousemove",ev=>{ c.setAttribute("r","5"); const d=c.dataset,u=d.util?` · <b>${pct(+d.util)}</b> of cap`:""; tip(ev,`<b>${hh(+d.h)}</b><br>median <b>${fmt(+d.med)}</b>${u}<br>range ${fmt(+d.min)}–${fmt(+d.max)}`); });
      c.addEventListener("mouseleave",()=>{ c.setAttribute("r","3.4"); hideTip(); }); });
  }

  function renderHeatmap(stats, g, live){
    const rows=g.dates.length, cellW=40, cellH=30, labelW=92, top=24, gap=2;
    const W=labelW+24*cellW+12, H=top+rows*cellH+34;
    let svg=`<svg viewBox="0 0 ${W} ${H}" role="img">`;
    for(let h=0;h<24;h++) if(h%2===0) svg+=`<text class="ax" x="${labelW+h*cellW+cellW/2}" y="${top-8}" text-anchor="middle">${String(h).padStart(2,"0")}</text>`;
    svg+=`<text class="axt" x="${labelW+24*cellW/2}" y="${H-6}" text-anchor="middle">Hour of day →</text>`;
    let liveMark="";
    g.dates.forEach((d,ri)=>{ const yy=top+ri*cellH;
      svg+=`<text class="ax" x="${labelW-10}" y="${yy+cellH/2+3}" text-anchor="end">${dowLabel(d)}</text>`;
      for(let h=0;h<24;h++){ const c=g.cell(d,h), xx=labelW+h*cellW;
        let fill="var(--surf)", stroke="var(--grid)", tp="no data";
        if(c&&c.util!=null){ fill=heavinessColor(c.util); if(c.util>1)stroke=CRITICAL; tp=`plan ${pct(c.util)} · load ${fmt(c.load)} / cap ${fmt(c.capacity)}`; }
        else if(c&&c.load){ fill="var(--chip)"; tp=`load ${fmt(c.load)} · no capacity`; }
        // live-actual overlay on the current (date,hour) cell
        if(live && live.live!=null && d===live.dISO && h===live.hour){
          const planTxt = (c&&c.util!=null)?pct(c.util):"—";
          tp=`LIVE actual ${pct(live.live)} vs plan ${planTxt}`;
          liveMark=`<rect x="${xx+2}" y="${yy+2}" width="${cellW-4}" height="${cellH-4}" rx="3" fill="none" stroke="${INK_RING}" stroke-width="2.5"/>`
            + `<circle cx="${xx+cellW-6}" cy="${yy+6}" r="3.2" fill="${INK_RING}"/>`;
        }
        svg+=`<rect x="${xx+gap/2}" y="${yy+gap/2}" width="${cellW-gap}" height="${cellH-gap}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="${(c&&c.util>1)?1.6:1}" data-tip="${d} ${hh(h)}<br>${tp}"></rect>`;
      }
    });
    svg+=liveMark+`</svg>`;
    q("#arc-heat").innerHTML=svg;
    qa("#arc-heat rect").forEach(r=>{ r.style.cursor="crosshair"; r.addEventListener("mousemove",ev=>tip(ev,r.dataset.tip)); r.addEventListener("mouseleave",hideTip); });

    // live chip (shown always when sorter present; explains the ring / covers out-of-range dates)
    const chip=q("#arc-livechip");
    if(live && live.live!=null){ const inGrid=g.dates.includes(live.dISO);
      const delta=(live.plan!=null)?live.live-live.plan:null;
      chip.hidden=false;
      chip.innerHTML=`<span style="width:10px;height:10px;border-radius:2px;border:2.5px solid ${INK_RING};display:inline-block"></span>`
        + `<span><b>Live now</b> (${hh(live.hour)}): Arc utilization <b>${pct(live.live)}</b>`
        + (live.plan!=null?` vs plan <b>${pct(live.plan)}</b> (<b style="color:${delta>0?CRITICAL:AQUA}">${signPP(delta)}</b>)`:"")
        + (inGrid?` — ringed on the grid.`:` — current day not in the planned range above.`)+`</span>`;
    } else chip.hidden=true;
  }

  function renderTable(stats, g){
    let h=`<table class="arc-data"><thead><tr><th>Hour</th><th>Median load</th><th>Min</th><th>Max</th><th>Median cap</th><th>Median heaviness</th>`;
    h+=g.dates.map(d=>`<th>${dowLabel(d)}</th>`).join("")+`</tr></thead><tbody>`;
    for(const s of stats){ h+=`<tr><td>${hh(s.hour)}</td><td class="n">${fmt(s.medLoad)}</td><td class="n">${fmt(s.minLoad)}</td><td class="n">${fmt(s.maxLoad)}</td><td class="n">${fmt(s.medCap)}</td><td class="n" style="${s.medUtil>1?'color:'+CRITICAL+';font-weight:700':''}">${pct(s.medUtil)}</td>`;
      h+=g.dates.map(d=>{ const c=g.cell(d,s.hour); return `<td class="n" style="${c&&c.util>1?'color:'+CRITICAL+';font-weight:700':''}">${c?pct(c.util):'—'}</td>`; }).join("")+`</tr>`; }
    q("#arc-table").innerHTML=h+`</tbody></table>`;
  }
  function toggleTable(){ const t=q("#arc-table"); const open=t.hidden; t.hidden=!open; q("#arc-tbl-toggle").textContent=open?"Hide data table ▴":"Show data table ▾"; }

  // ── DockFlow detail cards ────────────────────────────────────────────────
  function hbars(items,{max,color,valFmt}){
    const mx=max ?? Math.max(...items.map(i=>i.value||0),1);
    return `<div class="bars">`+items.map(i=>{ const w=Math.max(2,Math.min(100,((i.value||0)/mx)*100)); const c=typeof color==="function"?color(i):color;
      return `<div class="bar-row"><div class="bar-lab" title="${esc(i.label)}">${esc(i.label)}</div><div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${c}"></div></div><div class="bar-val">${valFmt?valFmt(i):fmt(i.value)}</div></div>`; }).join("")+`</div>`;
  }
  function moreNote(total,shown){ return total>shown?`<div class="more">+${total-shown} more</div>`:""; }
  function renderDock(){
    show("#card-arcs", !!STORE.sorter);
    if (STORE.sorter){ const arcs=STORE.sorter.arcs.slice(0,14);
      const items=arcs.map(a=>({label:`Arc ${a.arc}`, value:(a.util??0)*100, _u:a.util, _r:a.recircs}));
      q("#arc-dock-arcs").innerHTML = hbars(items,{ max:Math.max(100,...items.map(i=>i.value)), color:i=>heavinessColor(i._u??0), valFmt:i=>`${pct(i._u)} · ${fmt(i._r)} rc` }) + moreNote(STORE.sorter.arcs.length,14);
    }
    show("#card-alloc", !!STORE.alloc);
    if (STORE.alloc){ const rows=STORE.alloc.rows.slice(0,14);
      q("#arc-dock-alloc").innerHTML = hbars(rows.map(r=>({label:r.destination, value:r.units||0})),{ color:"var(--s1)", valFmt:i=>fmt(i.value) }) + moreNote(STORE.alloc.rows.length,14);
    }
    show("#card-routing", !!(STORE.profiles||STORE.doors));
    if (STORE.profiles||STORE.doors){
      let html=`<div class="dock-cols">`;
      html+=`<div><h4>Top routing profiles (PID total)</h4>`;
      html+= STORE.profiles ? hbars(STORE.profiles.rows.slice(0,10).map(r=>({label:r.profile, value:r.pidTotal||0})),{ color:AQUA }) + moreNote(STORE.profiles.rows.length,10) : `<div class="src-hint">Open the IxdOutbound view to capture routing profiles.</div>`;
      html+=`</div><div><h4>Fluid load doors (recircs)</h4>`;
      html+= STORE.doors ? hbars(STORE.doors.rows.slice(0,10).map(r=>({label:r.door+(r.side?` · ${r.side}`:""), value:r.recircs||0})),{ color:ORANGE }) + moreNote(STORE.doors.rows.length,10) : `<div class="src-hint">Open the IxdOutbound view to capture load doors.</div>`;
      html+=`</div></div>`;
      q("#arc-dock-routing").innerHTML=html;
    }
  }

  // ── Tooltip ──────────────────────────────────────────────────────────────
  function tip(ev,html){ const t=q("#arc-tip"); t.innerHTML=html; t.classList.add("show");
    let x=ev.clientX+14,y=ev.clientY+14; const r=t.getBoundingClientRect();
    if(x+r.width>PAGE.innerWidth-8)x=ev.clientX-r.width-14; if(y+r.height>PAGE.innerHeight-8)y=ev.clientY-r.height-14;
    t.style.left=x+"px"; t.style.top=y+"px"; }
  function hideTip(){ const t=q("#arc-tip"); if(t)t.classList.remove("show"); }

  // ── Paste-JSON fallback ──────────────────────────────────────────────────
  function showPaste(){ q("#arc-paste-box").hidden=false; }
  function hidePaste(){ q("#arc-paste-box").hidden=true; }
  function applyPaste(){ const raw=q("#arc-paste-input").value.trim(); if(!raw)return;
    let json; try{ json=JSON.parse(raw); }catch(e){ alert("Not valid JSON: "+e.message); return; }
    const before=sourcesPresent(); consider(json);
    if(sourcesPresent()===before){ alert("Couldn't recognize that as arc-capacity, sorter, allocation, profiles, or doors data. Share one record's shape and I'll map it."); return; }
    hidePaste(); render();
  }

  // ── Bridge ───────────────────────────────────────────────────────────────
  function sendToBridge(){
    if (typeof GM_xmlhttpRequest !== "function") { alert("GM_xmlhttpRequest not granted — bridge unavailable."); return; }
    const payload = { source:"arcCapacity", node:currentNode(), startDate:currentStart(), endDate:currentEnd(), capturedAt:Date.now(), store:STORE };
    GM_xmlhttpRequest({ method:"POST", url:BRIDGE_URL, headers:{"Content-Type":"application/json"}, data:JSON.stringify(payload),
      onload:()=>flash("Sent to dashboard ✓"), onerror:()=>flash("Bridge not reachable — is server.py running on :5220?"), ontimeout:()=>flash("Bridge timed out") });
  }
  function flash(msg){ const s=q("#arc-status"); if(!s)return; s.textContent=msg; setTimeout(updateBadge,2500); }

  // ── Demo (seeds all sources; in-memory only, not persisted) ──────────────
  function hashStr(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return (h>>>0); }
  function demoDays(){ const out=[]; const t=new Date(); for(let i=4;i>=0;i--){ const d=new Date(t); d.setDate(d.getDate()-i); out.push(isoDate(d)); } return out; }
  function loadDemo(){
    const node=currentNode(), CAP=1250, recs=[];
    demoDays().forEach(d=>{ for(let h=0;h<24;h++){ const hump=Math.exp(-((h-10)**2)/12)*0.85+Math.exp(-((h-20)**2)/9)*1.0;
      const load=Math.round(CAP*(0.10+hump)*(0.90+(hashStr(d+h)%20)/100)); recs.push({dateISO:d,hour:h,load,capacity:CAP+((hashStr(d+"c"+h)%80)-40)}); } });
    STORE.crossdock={records:recs, node, at:Date.now()};
    const wc=[]; ["A1","A2","A3","B1","B2","C1"].forEach((a,ai)=>{ const base=0.55+(ai%3)*0.18;
      for(let k=0;k<4;k++){ const u=Math.min(1.35, base+(hashStr(a+k)%28)/100); wc.push({workcell:a+"-"+(k+1), arc:a, status:u>1?"Overloaded":"Running", utilization:u, recircs:Math.round((u>0.9?1:0.3)*(hashStr(a+"r"+k)%45))}); } });
    STORE.sorter=Object.assign(summarizeSorter(wc), {node, at:Date.now()});
    STORE.alloc={rows:["SEA","PDX","SFO","LAX","DEN","PHX","SLC","BOI","GEG","MSO"].map((d,i)=>({destination:d, units:Math.round(4200*(1-i*0.08)*(0.8+(hashStr(d)%40)/100)), doors:2+(i%3)})).sort((a,b)=>b.units-a.units), node, at:Date.now()};
    STORE.profiles={rows:["Profile-A","Profile-B","Profile-C","Profile-D","Profile-E","Profile-F"].map((p,i)=>({profile:p, pidTotal:Math.round(3200*(1-i*0.14)), recircs:Math.round(180*(1-i*0.1))})), node, at:Date.now()};
    STORE.doors={rows:["D01","D02","D03","D04","D05","D06","D07","D08"].map((d,i)=>({door:d, side:i<4?"West":"East", recircs:Math.round(160*(1-i*0.1)+(hashStr(d)%25))})).sort((a,b)=>b.recircs-a.recircs), node, at:Date.now()};
    DEMO=true; render();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  5. STYLE + MARKUP
  // ══════════════════════════════════════════════════════════════════════════
  const STYLE = `<style>
    :host, * { box-sizing:border-box; }
    :host {
      --surf:#fcfcfb; --plane:#ffffff; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
      --grid:#e1e0d9; --base:#c3c2b7; --s1:#2a78d6; --band:rgba(42,120,214,.16);
      --border:rgba(11,11,11,.10); --hdr:#1a1a2e; --chip:#eef1f5; --chipb:#d9dee6;
      font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    }
    @media (prefers-color-scheme: dark) { :host {
      --surf:#1a1a19; --plane:#201f1e; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
      --grid:#2c2c2a; --base:#383835; --s1:#3987e5; --band:rgba(57,135,229,.20);
      --border:rgba(255,255,255,.12); --hdr:#101019; --chip:#2a2a28; --chipb:#3a3a37;
    } }
    .arc-launch { position:fixed; right:18px; bottom:18px; z-index:2147483000; background:var(--s1); color:#fff; border:none; border-radius:22px; padding:10px 16px; font:600 13px/1 system-ui,sans-serif; cursor:pointer; box-shadow:0 4px 14px rgba(0,0,0,.3); }
    .arc-launch:hover{ filter:brightness(1.06); }
    .arc-badge { position:absolute; top:-6px; right:-6px; background:${AQUA}; color:#fff; border:2px solid var(--plane); border-radius:10px; min-width:18px; height:18px; padding:0 4px; font:700 10px/14px system-ui,sans-serif; text-align:center; }
    [hidden]{ display:none !important; }
    .arc-drawer { position:fixed; inset:0 0 0 auto; width:min(1020px,96vw); z-index:2147483001; background:var(--plane); color:var(--ink); box-shadow:-8px 0 40px rgba(0,0,0,.35); display:flex; flex-direction:column; font-size:13px; }
    .arc-head { background:var(--hdr); color:#fff; padding:11px 16px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .arc-head h1 { font-size:15px; font-weight:600; flex:1; min-width:170px; }
    .arc-head .scope { font-size:11px; color:#b7c0d0; font-weight:400; }
    .arc-btn { background:rgba(255,255,255,.14); color:#fff; border:1px solid rgba(255,255,255,.18); border-radius:5px; padding:5px 10px; font:600 12px system-ui,sans-serif; cursor:pointer; }
    .arc-btn:hover{ background:rgba(255,255,255,.24); } .arc-btn.primary{ background:var(--s1); border-color:var(--s1); }
    .arc-sub { padding:7px 16px; background:var(--surf); border-bottom:1px solid var(--border); display:flex; gap:14px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--ink2); }
    .arc-sub input { font:inherit; font-size:12px; padding:3px 7px; border-radius:4px; border:1px solid var(--chipb); background:var(--plane); color:var(--ink); width:78px; }
    #arc-status { margin-left:auto; color:var(--muted); font-size:11px; }
    .arc-body { padding:14px 16px; overflow-y:auto; }
    .arc-card { background:var(--surf); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:14px; }
    .arc-card h2 { font-size:14px; font-weight:700; margin:0 0 2px; }
    .arc-card p { font-size:11.5px; color:var(--ink2); margin:0 0 8px; line-height:1.5; }
    .arc-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
    .arc-kpi { background:var(--plane); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
    .arc-kpi .k-label{ font:700 10px system-ui; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); }
    .arc-kpi .k-val{ font-size:23px; font-weight:650; margin-top:3px; letter-spacing:-.5px; }
    .arc-kpi .k-note{ font-size:11px; color:var(--ink2); margin-top:1px; }
    .arc-kpi.hot .k-val{ color:${CRITICAL}; }
    svg { display:block; width:100%; height:auto; overflow:visible; }
    .ax{ fill:var(--muted); font-size:10px; } .axt{ fill:var(--ink2); font-size:11px; font-weight:600; }
    .grid{ stroke:var(--grid); stroke-width:1; } .base{ stroke:var(--base); stroke-width:1.5; }
    .legend{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-top:10px; font-size:11px; color:var(--ink2); }
    .ramp{ width:130px; height:12px; border-radius:3px; border:1px solid var(--border); background:linear-gradient(90deg,#cde2fb,#9ec5f4,#5598e7,#2a78d6,#1c5cab,#104281); }
    .swatch{ width:14px; height:14px; border-radius:3px; display:inline-block; vertical-align:-2px; background:${CRITICAL}; }
    .link{ color:var(--s1); cursor:pointer; font-weight:600; font-size:11.5px; margin-left:auto; } .link:hover{ text-decoration:underline; }
    .livechip{ display:flex; gap:9px; align-items:center; margin-top:10px; font-size:12px; background:var(--chip); border:1px solid var(--border); border-radius:6px; padding:7px 11px; line-height:1.4; }
    table.arc-data{ width:100%; border-collapse:collapse; font-size:12px; margin-top:12px; }
    table.arc-data th,table.arc-data td{ padding:4px 8px; border-bottom:1px solid var(--grid); text-align:right; white-space:nowrap; }
    table.arc-data th{ color:var(--muted); font:700 10.5px system-ui; text-transform:uppercase; letter-spacing:.3px; }
    table.arc-data td:first-child,table.arc-data th:first-child{ text-align:left; }
    .n{ font-variant-numeric:tabular-nums; }
    .bars{ display:flex; flex-direction:column; gap:6px; }
    .bar-row{ display:grid; grid-template-columns:118px 1fr auto; gap:8px; align-items:center; font-size:11.5px; }
    .bar-lab{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink2); }
    .bar-track{ background:var(--chip); border-radius:4px; height:14px; overflow:hidden; }
    .bar-fill{ height:100%; border-radius:4px; }
    .bar-val{ font-variant-numeric:tabular-nums; color:var(--ink); min-width:96px; text-align:right; }
    .more{ font-size:11px; color:var(--muted); margin-top:7px; }
    .dock-cols{ display:grid; grid-template-columns:1fr 1fr; gap:20px; }
    @media (max-width:720px){ .dock-cols{ grid-template-columns:1fr; } }
    .dock-cols h4{ font:700 11px system-ui; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); margin:0 0 8px; }
    .src-hint{ font-size:11.5px; color:var(--muted); font-style:italic; }
    .arc-empty{ text-align:center; padding:48px 20px; color:var(--ink2); } .arc-empty .i{ font-size:34px; }
    .arc-empty h3{ margin:8px 0 6px; color:var(--ink); font-size:15px; } .arc-empty p{ font-size:12px; line-height:1.6; max-width:470px; margin:0 auto; }
    #arc-paste-box{ padding:0 16px 14px; } #arc-paste-input{ width:100%; height:120px; font:11px/1.4 ui-monospace,monospace; padding:8px; border:1px solid var(--chipb); border-radius:6px; background:var(--surf); color:var(--ink); resize:vertical; }
    .arc-paste-row{ display:flex; gap:8px; justify-content:flex-end; margin-top:8px; }
    #arc-tip{ position:fixed; z-index:2147483002; pointer-events:none; opacity:0; transition:opacity .08s; background:var(--ink); color:var(--plane); font-size:11.5px; line-height:1.45; padding:7px 9px; border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,.3); max-width:230px; } #arc-tip.show{ opacity:1; }
    code{ background:var(--chip); border:1px solid var(--chipb); border-radius:3px; padding:1px 5px; font-size:11px; }
  </style>`;

  const MARKUP = `
    <button class="arc-launch" title="ARC Capacity — Crossdock + DockFlow">📊 ARC<span class="arc-badge" hidden>0</span></button>
    <section class="arc-drawer" hidden>
      <div class="arc-head">
        <h1>ARC Capacity <span class="scope" id="arc-scope"></span></h1>
        <button class="arc-btn" id="arc-rescan">⟳ Re-scan</button>
        <button class="arc-btn" id="arc-demo">✨ Demo</button>
        <button class="arc-btn" id="arc-paste">📋 Paste JSON</button>
        <button class="arc-btn" id="arc-bridge">↗ Dashboard</button>
        <button class="arc-btn" id="arc-close">✕ Close</button>
      </div>
      <div class="arc-sub">
        <span>Node <input id="arc-node" value="RFD2" readonly></span>
        <span>Start <b id="arc-start">—</b></span><span>End <b id="arc-end">—</b></span>
        <span id="arc-status">Waiting for data…</span>
      </div>
      <div id="arc-paste-box" hidden>
        <textarea id="arc-paste-input" placeholder="Paste any arc-capacity / Sorter / allocation / profiles / doors JSON response…"></textarea>
        <div class="arc-paste-row"><button class="arc-btn" id="arc-paste-cancel">Cancel</button><button class="arc-btn primary" id="arc-paste-go">Analyze</button></div>
      </div>
      <div class="arc-body">
        <div id="arc-empty" class="arc-empty">
          <div class="i">📦</div><h3>Waiting for ARC data</h3>
          <p>Open the Crossdock Manager <b>arc-capacity</b> view and the DockFlow <b>MainSorter/Sorter</b> and <b>IxdOutbound</b> views for your node — this script captures each from the page's own network calls and blends them here. Or click <b>✨ Demo</b> to preview, or <b>📋 Paste JSON</b>.</p>
        </div>
        <div id="arc-results" hidden>
          <div class="arc-card"><h2>Summary — plan vs. live</h2><p id="arc-kpi-sub"></p><div class="arc-kpis" id="arc-kpi"></div></div>
          <div class="arc-card" id="card-trend"><h2>ARC load median, hour by hour</h2><p>Median load across the selected days for each hour (line), with the day-to-day spread (band = min→max). From Crossdock Manager.</p><div id="arc-trend"></div></div>
          <div class="arc-card" id="card-heat">
            <h2>Heaviness — plan (grid) with live actual overlaid</h2>
            <p>Grid = Crossdock <b>planned</b> heaviness (load ÷ capacity). Darker blue = closer to capacity; <b style="color:${CRITICAL}">red = over capacity</b>. The <b style="color:${INK_RING}">◻ gold ring</b> marks the current hour with DockFlow's <b>live actual</b> Arc utilization.</p>
            <div id="arc-heat"></div>
            <div id="arc-livechip" class="livechip" hidden></div>
            <div class="legend"><span>0%</span><span class="ramp"></span><span>100%</span><span><span class="swatch"></span> Over capacity</span><span class="link" id="arc-tbl-toggle">Show data table ▾</span></div>
            <div id="arc-table" hidden></div>
          </div>
          <div class="arc-card" id="card-arcs"><h2>Live Arc utilization &amp; recircs</h2><p>Per-Arc utilization from DockFlow MainSorter/Sorter (averaged over its workcells). Bar color = heaviness; red = over 100%.</p><div id="arc-dock-arcs"></div></div>
          <div class="arc-card" id="card-alloc"><h2>Allocation plan by destination</h2><p>Planned outbound allocation per destination, from DockFlow IxdOutbound.</p><div id="arc-dock-alloc"></div></div>
          <div class="arc-card" id="card-routing"><h2>Routing profiles &amp; load doors</h2><p>Top routing profiles by PID total and fluid load doors by recircs, from DockFlow IxdOutbound.</p><div id="arc-dock-routing"></div></div>
        </div>
      </div>
    </section>
    <div id="arc-tip"></div>`;

  // ── Boot ──────────────────────────────────────────────────────────────────
  hookNetwork();
  const ready = fn => (document.readyState === "loading") ? document.addEventListener("DOMContentLoaded", fn, { once:true }) : fn();
  ready(buildPanel);
})();
