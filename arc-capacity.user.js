// ==UserScript==
// @name         ARC Capacity — Predictive Arc Heaviness (Crossdock + DockFlow IB/OB + CC)
// @namespace    rb20.arc-capacity
// @version      3.0.0
// @description  Predicts which destination Arc (DTW1, LUK2, KRB6, MSP1, …) will be extremely heavy in which upcoming hour, by blending Crossdock Manager per-Arc capacity plan with the live inbound throw from DockFlow IXDInbound + Command Center and live outbound Sorter utilization. Auto-captures every source from the pages' own network calls, shares captures across tabs, and projects a lead-time-shifted Arc × hour heaviness grid.
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
  const SOURCES = ["crossdock","sorter","alloc","profiles","doors","inProfiles","inDoors","cc"];

  const BLUE_RAMP = ["#cde2fb","#b7d3f6","#9ec5f4","#86b6ef","#6da7ec","#5598e7",
                     "#3987e5","#2a78d6","#256abf","#1c5cab","#184f95","#104281","#0d366b"];
  const CRITICAL = "#d03b3b", AQUA = "#1baf7a", ORANGE = "#eb6834", GOLD = "#eda100", VIOLET = "#6d5bd0";

  // Field-name candidates (matched case/whitespace-insensitively)
  const DATE_KEYS = ["date","day","dateString","businessDate","planDate","localDate","dateLocal"];
  const TIME_KEYS = ["timestamp","time","startTime","intervalStart","dateTime","datetime","epoch","epochMillis","start","periodStart"];
  const HOUR_KEYS = ["hour","hourOfDay","hr","hourStart","intervalHour"];
  const LOAD_KEYS = ["load","arcLoad","arcLoadUnits","actualLoad","projectedLoad","forecastLoad","volume","units","value","loadUnits","demand","planned","plannedUnits"];
  const CAP_KEYS  = ["capacity","arcCapacity","maxCapacity","plannedCapacity","cap","capacityUnits","effectiveCapacity","targetCapacity"];
  const NODE_KEYS = ["nodes","warehouses","stations","byNode","data"];
  const ARC_KEYS      = ["arc","arcId","arcName","arccode","destinationarc","sortarc"];
  const WORKCELL_KEYS = ["name","workcell","workcellName","cell","id"];
  const UTIL_KEYS     = ["utilization","util","utilizationPct","utilizationPercent","utilisation"];
  const RECIRC_KEYS   = ["recircs","recirc","recirculations","recircs15min","recircslast15min","totalrecircs"];
  const STATUS_KEYS   = ["status","state"];
  const DEST_KEYS     = ["destination","dest","destinationid","destcode","lane","arc","node"];
  const ALLOC_KEYS    = ["allocation","allocated","allocatedunits","plannedunits","planned","allocationunits","count","units","volume"];
  const PROFILE_KEYS  = ["routingprofile","profile","routingprofilename","profilename"];
  const PID_KEYS      = ["pidtotal","pid","pidcount","totalpid","pids"];
  const DOOR_KEYS     = ["door","loaddoor","doorid","doorname","dock","dockdoor"];
  const SIDE_KEYS     = ["side","zone","cluster","group"];
  const INBOUND_KEYS  = ["inbound","inboundunits","received","receivedunits","arriving","arrivals","throw","thrown","incoming","backlog"];

  const STORE = {}; SOURCES.forEach(s => STORE[s] = null);
  let DEMO = false, shadow = null;
  const PARAMS = { leadMin: 90, horizon: 6, threshold: 1.0, topN: 15 };
  const q  = s => shadow && shadow.querySelector(s);
  const qa = s => shadow ? [...shadow.querySelectorAll(s)] : [];
  const GM_OK = (typeof GM_setValue === "function" && typeof GM_getValue === "function");

  // ══════════════════════════════════════════════════════════════════════════
  //  CAPTURE
  // ══════════════════════════════════════════════════════════════════════════
  function hookNetwork() {
    try { const of = PAGE.fetch;
      if (typeof of === "function") PAGE.fetch = function (...a) { const p = of.apply(this, a);
        try { p.then(res => { try { const c = res.clone(); if ((c.headers.get("content-type")||"").toLowerCase().includes("json")) c.json().then(consider).catch(()=>{}); } catch(e){} }).catch(()=>{}); } catch(e){}
        return p; };
    } catch(e){}
    try { const X = PAGE.XMLHttpRequest;
      if (X && X.prototype) { const o = X.prototype.open, s = X.prototype.send;
        X.prototype.open = function(m,u){ this.__u=u; return o.apply(this,arguments); };
        X.prototype.send = function(){ this.addEventListener("load", function(){ try { const t=this.responseText||"";
          const ct=(this.getResponseHeader&&(this.getResponseHeader("content-type")||"")).toLowerCase();
          if (ct.includes("json")||/^\s*[\[{]/.test(t)) consider(JSON.parse(t)); } catch(e){} }); return s.apply(this,arguments); };
      }
    } catch(e){}
  }
  function pageContext() {
    const p = ((PAGE.location.pathname||"")+(PAGE.location.hash||"")).toLowerCase();
    if (p.includes("ixdinbound") || p.includes("/inbound")) return "inbound";
    if (p.includes("ixdoutbound") || p.includes("/outbound")) return "outbound";
    if (/\/cc(\b|\/|\?)/.test(p) || p.includes("commandcenter")) return "cc";
    return "other";
  }
  function consider(json) {
    try {
      const ctx = pageContext(), keys = rowKeys(json);
      if (hasAny(keys, LOAD_KEYS) && (hasAny(keys, CAP_KEYS) || hasAny(keys, HOUR_KEYS) || hasAny(keys, DATE_KEYS) || hasAny(keys, TIME_KEYS))) {
        const recs = normalizeArcRecords(json, currentNode(), currentStart());
        if (recs.filter(r => r.load != null).length >= 6) return save("crossdock", { records: recs });
      }
      if (hasAny(keys, ARC_KEYS) && (hasAny(keys, UTIL_KEYS) || hasAny(keys, RECIRC_KEYS)) && !hasAny(keys, PID_KEYS)) {
        const s = normalizeSorter(json); if (s && s.workcells.length >= 3) return save("sorter", s);
      }
      if (ctx === "cc" && hasAny(keys, ARC_KEYS)) { const c = normalizeCC(json); if (c && c.rows.length >= 2) return save("cc", c); }
      if (hasAny(keys, PROFILE_KEYS) || hasAny(keys, PID_KEYS)) { const p = normalizeProfiles(json);
        if (p && p.length >= 2) return save(ctx === "inbound" ? "inProfiles" : "profiles", { rows: p }); }
      if (hasAny(keys, DOOR_KEYS) && hasAny(keys, RECIRC_KEYS)) { const d = normalizeDoors(json);
        if (d && d.length >= 2) return save(ctx === "inbound" ? "inDoors" : "doors", { rows: d }); }
      if (hasAny(keys, DEST_KEYS) && !hasAny(keys, UTIL_KEYS)) { const a = normalizeAllocation(json); if (a && a.length >= 2) return save("alloc", { rows: a }); }
    } catch(e){}
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  function norm(s){ return String(s).toLowerCase().replace(/[^a-z0-9]/g,""); }
  function pick(obj, names){ if(!obj||typeof obj!=="object") return undefined; const w=names.map(norm);
    for (const k of Object.keys(obj)) if (w.includes(norm(k)) && obj[k]!=null && obj[k]!=="") return obj[k]; }
  function firstKey(obj, keys){ for (const k of keys) if (obj!=null && obj[k]!=null && obj[k]!=="") return obj[k]; }
  function toNum(v){ if(v==null) return null; if(typeof v==="number") return isFinite(v)?v:null; const n=parseFloat(String(v).replace(/[, %]/g,"")); return isNaN(n)?null:n; }
  function toUtil(v){ let n=toNum(v); if(n==null) return null; if(n>1.5) n/=100; return n; }
  function isoDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
  function isArcCode(s){ return typeof s==="string" && /^[A-Z]{2,4}\d{1,2}$/i.test(s.trim()); }
  function unwrap(json, node){ let cur=json;
    for (let i=0;i<6&&cur&&!Array.isArray(cur);i++){
      if (node&&cur[node]!=null){ cur=cur[node]; continue; }
      const nm=NODE_KEYS.map(k=>cur[k]).find(v=>v&&typeof v==="object"); if (nm&&node&&nm[node]!=null){ cur=nm[node]; continue; }
      const w=["data","rows","records","items","results","intervals","buckets","series","hours","points","content","payload","table","entries","values"].map(k=>cur[k]).find(v=>v!=null);
      if (w!=null){ cur=w; continue; } break;
    } return cur; }
  function rowKeys(json){ let c=unwrap(json,currentNode());
    if (Array.isArray(c)&&c.length&&typeof c[0]==="object"&&c[0]) return new Set(Object.keys(c[0]).map(norm));
    if (c&&typeof c==="object") return new Set(Object.keys(c).map(norm)); return new Set(); }
  function hasAny(set, names){ return names.some(n=>set.has(norm(n))); }

  function parseWhen(v){ if(v==null) return null; const s=String(v);
    const dm=s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}))?/);
    if (dm&&!/^\d+$/.test(s)) return { dateISO:`${dm[1]}-${dm[2]}-${dm[3]}`, hour: dm[4]!=null?parseInt(dm[4],10):null };
    if (typeof v==="number"||/^\d+$/.test(s)){ let n=Number(v); if(n<1e11)n*=1000; const d=new Date(n); return isNaN(d.getTime())?null:{dateISO:isoDate(d),hour:d.getHours()}; }
    const p=Date.parse(s); if(isNaN(p)) return null; const d=new Date(p); return {dateISO:isoDate(d),hour:d.getHours()}; }

  function normalizeArcRecords(json, node, fb){
    const out=[]; let cur=unwrap(json,node);
    if (cur&&!Array.isArray(cur)&&typeof cur==="object"){ const la=firstKey(cur,LOAD_KEYS), ca=firstKey(cur,CAP_KEYS);
      if (Array.isArray(la)){ const day=fb||isoDate(new Date()); la.forEach((lv,h)=>out.push({arc:"ALL",dateISO:day,hour:h%24,load:toNum(lv),capacity:Array.isArray(ca)?toNum(ca[h]):toNum(ca)})); return out; } }
    if (!Array.isArray(cur)) return out;
    cur.forEach((row,idx)=>{ if(row==null) return;
      if (typeof row==="number"){ out.push({arc:"ALL",dateISO:fb||isoDate(new Date()),hour:idx%24,load:row,capacity:null}); return; }
      let dISO=null,hour=null; const dR=firstKey(row,DATE_KEYS),hR=firstKey(row,HOUR_KEYS),tR=firstKey(row,TIME_KEYS);
      const wd=dR!=null?parseWhen(dR):null, wt=tR!=null?parseWhen(tR):null;
      if (wd) dISO=wd.dateISO; if (dISO==null&&wt) dISO=wt.dateISO;
      if (hR!=null) hour=toNum(hR); if (hour==null&&wt&&wt.hour!=null) hour=wt.hour; if (hour==null&&wd&&wd.hour!=null) hour=wd.hour;
      if (dISO==null) dISO=fb||isoDate(new Date()); if (hour==null) hour=idx%24;
      const arcRaw = pick(row, ARC_KEYS) ?? pick(row, ["destination","dest"]);
      out.push({ arc: arcRaw!=null?String(arcRaw).toUpperCase():"ALL", dateISO:dISO, hour:((toNum(hour)||0)%24+24)%24,
        load:toNum(firstKey(row,LOAD_KEYS)), capacity:toNum(firstKey(row,CAP_KEYS)) }); });
    return out;
  }
  function summarizeSorter(wc){
    const byArc=new Map();
    for (const w of wc){ const g=byArc.get(w.arc)||{arc:w.arc,utils:[],recircs:0,n:0}; if(w.utilization!=null)g.utils.push(w.utilization); if(w.recircs!=null)g.recircs+=w.recircs; g.n++; byArc.set(w.arc,g); }
    const arcs=[...byArc.values()].map(g=>({arc:g.arc,util:g.utils.length?g.utils.reduce((s,x)=>s+x,0)/g.utils.length:null,utilMax:g.utils.length?Math.max(...g.utils):null,recircs:g.recircs,cells:g.n})).sort((a,b)=>(b.util??-1)-(a.util??-1));
    const all=wc.map(w=>w.utilization).filter(u=>u!=null);
    return { workcells:wc, arcs, nodeUtil:all.length?all.reduce((s,x)=>s+x,0)/all.length:null, nodeUtilPeak:all.length?Math.max(...all):null, totalRecircs:wc.reduce((s,w)=>s+(w.recircs||0),0) };
  }
  function normalizeSorter(json){ let cur=unwrap(json,currentNode()); if(!Array.isArray(cur)) return null; const wc=[];
    for (const r of cur){ if(!r||typeof r!=="object") continue; const arc=pick(r,ARC_KEYS);
      wc.push({workcell:pick(r,WORKCELL_KEYS)||"",arc:arc!=null?String(arc).toUpperCase():"—",status:pick(r,STATUS_KEYS)||"",utilization:toUtil(pick(r,UTIL_KEYS)),recircs:toNum(pick(r,RECIRC_KEYS))}); }
    return wc.length?summarizeSorter(wc):null; }
  function normalizeAllocation(json){ let cur=unwrap(json,currentNode()); if(!Array.isArray(cur)) return null; const rows=[];
    for (const r of cur){ if(!r||typeof r!=="object") continue; const d=pick(r,DEST_KEYS); if(d==null) continue;
      rows.push({destination:String(d).toUpperCase(),units:toNum(pick(r,ALLOC_KEYS)),doors:toNum(pick(r,["doors","doorcount"]))}); }
    return rows.length?rows.sort((a,b)=>(b.units??-1)-(a.units??-1)):null; }
  function normalizeProfiles(json){ let cur=unwrap(json,currentNode()); if(!Array.isArray(cur)) return null; const rows=[];
    for (const r of cur){ if(!r||typeof r!=="object") continue; const p=pick(r,PROFILE_KEYS), pid=toNum(pick(r,PID_KEYS)); if(p==null&&pid==null) continue;
      const arcRaw=pick(r,ARC_KEYS)??pick(r,["destination","dest"])??(isArcCode(p)?p:null);
      rows.push({profile:p!=null?String(p):"—",arc:arcRaw!=null?String(arcRaw).toUpperCase():null,pidTotal:pid,recircs:toNum(pick(r,RECIRC_KEYS))}); }
    return rows.length?rows.sort((a,b)=>(b.pidTotal??-1)-(a.pidTotal??-1)):null; }
  function normalizeDoors(json){ let cur=unwrap(json,currentNode()); if(!Array.isArray(cur)) return null; const rows=[];
    for (const r of cur){ if(!r||typeof r!=="object") continue; const d=pick(r,DOOR_KEYS); if(d==null) continue;
      const arcRaw=pick(r,ARC_KEYS)??pick(r,["destination","dest"]);
      rows.push({door:String(d),arc:arcRaw!=null?String(arcRaw).toUpperCase():null,recircs:toNum(pick(r,RECIRC_KEYS)),side:pick(r,SIDE_KEYS)||null}); }
    return rows.length?rows.sort((a,b)=>(b.recircs??-1)-(a.recircs??-1)):null; }
  function normalizeCC(json){ let cur=unwrap(json,currentNode()); if(!Array.isArray(cur)) return null; const rows=[];
    for (const r of cur){ if(!r||typeof r!=="object") continue; const arc=pick(r,ARC_KEYS); if(arc==null) continue;
      rows.push({arc:String(arc).toUpperCase(),inbound:toNum(pick(r,INBOUND_KEYS)),recircs:toNum(pick(r,RECIRC_KEYS)),util:toUtil(pick(r,UTIL_KEYS)),status:pick(r,STATUS_KEYS)||""}); }
    return rows.length?{rows}:null; }

  // ══════════════════════════════════════════════════════════════════════════
  //  STATS + PREDICTION
  // ══════════════════════════════════════════════════════════════════════════
  function quantile(a,p){ if(!a.length) return null; const pos=(a.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos); return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(pos-lo); }
  const median = a => quantile(a.slice().sort((x,y)=>x-y),0.5);

  // Crossdock per-Arc hourly plan (median load & capacity across captured days).
  function arcHourPlan(records){
    const m=new Map();
    for (const r of records){ const a=r.arc||"ALL"; if(!m.has(a)) m.set(a,Array.from({length:24},()=>({loads:[],caps:[]})));
      const c=m.get(a)[r.hour]; if(r.load!=null)c.loads.push(r.load); if(r.capacity!=null)c.caps.push(r.capacity); }
    const out=new Map();
    for (const [a,hours] of m) out.set(a, hours.map(h=>({ load: h.loads.length?median(h.loads):null, cap: h.caps.length?median(h.caps):null })));
    return out;
  }
  // Live inbound throw per Arc, blended from whatever inbound signals are present.
  function inboundByArc(){
    const m=new Map(); const add=(arc,v)=>{ if(arc==null||v==null) return; const a=String(arc).toUpperCase(); m.set(a,(m.get(a)||0)+v); };
    (STORE.inProfiles?.rows||[]).forEach(r=> add(r.arc||(isArcCode(r.profile)?r.profile:null), r.pidTotal ?? r.recircs));
    (STORE.inDoors?.rows||[]).forEach(r=> add(r.arc, r.recircs));
    (STORE.cc?.rows||[]).forEach(r=> add(r.arc, r.inbound ?? r.recircs));
    return m;
  }
  function windowHours(nowHour, horizon){ const out=[]; for(let k=0;k<=horizon;k++) out.push((nowHour+k)%24); return out; }

  function predict(){
    const cd=(STORE.crossdock?.records||[]).filter(r=>r.load!=null);
    const plan=arcHourPlan(cd);
    const inbound=inboundByArc();
    const liveUtil=new Map(), liveRec=new Map();
    (STORE.sorter?.arcs||[]).forEach(a=>{ liveUtil.set(a.arc,a.util); liveRec.set(a.arc,a.recircs); });
    const arcs=new Set([...plan.keys()].filter(a=>a!=="ALL"));
    inbound.forEach((_,a)=>arcs.add(a)); liveUtil.forEach((_,a)=>{ if(a!=="—") arcs.add(a); });
    if (!arcs.size && plan.has("ALL")) arcs.add("ALL");

    const nowHour=new Date().getHours(), leadH=PARAMS.leadMin/60;
    // planned share over the horizon window (denominator for "expected" inbound distribution)
    const planTot=new Map(); let planSum=0;
    for (const a of arcs){ const arr=plan.get(a); let s=0; if(arr) for(let k=0;k<=PARAMS.horizon;k++){ const h=(nowHour+k)%24; s+=(arr[h].load||0); } planTot.set(a,s); planSum+=s; }
    const inSum=[...inbound.values()].reduce((s,x)=>s+x,0);
    const pressure=new Map();
    for (const a of arcs){ const inShare=inSum?(inbound.get(a)||0)/inSum:0, planShare=planSum?(planTot.get(a)||0)/planSum:0;
      let p = planShare>0 ? inShare/planShare : (inShare>0?2:1); if(!isFinite(p)||p<=0) p=1; pressure.set(a,Math.min(p,4)); }

    const grid=new Map();
    for (const a of arcs){ const arr=plan.get(a); const row=[];
      for (let h=0;h<24;h++){ const cell=arr?arr[h]:null; const base=(cell&&cell.cap)?(cell.load/cell.cap):(cell&&cell.load!=null?null:null);
        let pred=base, applied=false; const ahead=(h-nowHour+24)%24;
        if (base!=null && ahead>=leadH && ahead<=PARAMS.horizon){ pred=base*pressure.get(a); applied=true; }
        if (h===nowHour && liveUtil.get(a)!=null) pred = base!=null ? Math.max(pred,liveUtil.get(a)) : liveUtil.get(a);
        row.push({ plan:base, pred, applied }); }
      grid.set(a,row); }
    return { grid, arcs:[...arcs], pressure, inbound, liveUtil, liveRec, nowHour, plan };
  }

  function rankedArcs(model, n){
    const win=windowHours(model.nowHour,PARAMS.horizon);
    const scored=model.arcs.map(a=>{ const row=model.grid.get(a); let peak=-1; for(const h of win){ const p=row[h].pred; if(p!=null&&p>peak) peak=p; } return {arc:a,peak}; })
      .filter(x=>x.peak>=0).sort((a,b)=>b.peak-a.peak);
    return scored.slice(0,n).map(x=>x.arc);
  }
  function hotspots(model){
    const win=windowHours(model.nowHour,PARAMS.horizon), out=[];
    for (const a of model.arcs){ const row=model.grid.get(a); for(const h of win){ const c=row[h]; if(c.pred!=null&&c.pred>=PARAMS.threshold) out.push({arc:a,hour:h,pred:c.pred,plan:c.plan,pressure:model.pressure.get(a)}); } }
    return out.sort((a,b)=>b.pred-a.pred);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FORMAT / COLOR
  // ══════════════════════════════════════════════════════════════════════════
  function fmt(n,d=0){ return (n==null||isNaN(n))?"—":Number(n).toLocaleString(undefined,{maximumFractionDigits:d,minimumFractionDigits:d}); }
  function pct(u){ return u==null?"—":Math.round(u*100)+"%"; }
  function fmtX(n){ return n==null?"—":"×"+Number(n).toFixed(2); }
  function hh(h){ return String(h).padStart(2,"0")+":00"; }
  function hex(h){ h=h.replace("#",""); if(h.length===3)h=h.split("").map(c=>c+c).join(""); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
  function mix(a,b,t){ const ca=hex(a),cb=hex(b); return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`; }
  function heavinessColor(u){ if(u==null) return "var(--surf)"; if(u>1){const t=Math.min((u-1)/.5,1);return mix(CRITICAL,"#7a1414",t);} const i=Math.min(u,1)*(BLUE_RAMP.length-1),lo=Math.floor(i),hi=Math.min(lo+1,BLUE_RAMP.length-1); return mix(BLUE_RAMP[lo],BLUE_RAMP[hi],i-lo); }
  function textOn(u){ return (u!=null && u>0.55) ? "#fff" : "var(--ink)"; }
  function esc(s){ return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function urlParams(){ const out={}; const g=qs=>{ const m=qs&&qs.indexOf("?")>=0?qs.slice(qs.indexOf("?")+1):""; new URLSearchParams(m).forEach((v,k)=>out[k]=v); }; g(PAGE.location.hash); g(PAGE.location.search); return out; }
  function currentNode(){ const host=PAGE.location.host||"";
    if (host.includes("dockflow")){ const seg=(PAGE.location.pathname||"").split("/").filter(Boolean)[0]; if(seg&&/^[a-z0-9]{3,6}$/i.test(seg)) return seg.toUpperCase(); }
    const p=urlParams(); return (p.nodes||p.node||p.warehouseId||"RFD2").split(",")[0].trim().toUpperCase(); }
  function currentStart(){ return urlParams().startDate || (STORE.crossdock?.records?.[0]?.dateISO) || null; }
  function currentEnd(){ return urlParams().endDate || null; }

  // ══════════════════════════════════════════════════════════════════════════
  //  STORAGE
  // ══════════════════════════════════════════════════════════════════════════
  function gmKey(src){ return `arc:${currentNode()}:${src}`; }
  function save(src,obj){ STORE[src]=Object.assign({},obj,{at:Date.now(),node:currentNode()}); DEMO=false;
    if (GM_OK){ try{ GM_setValue(gmKey(src),JSON.stringify(STORE[src])); }catch(e){} } onCaptured(); }
  function loadFromGM(){ if(!GM_OK) return; for(const src of SOURCES){ try{ const v=GM_getValue(gmKey(src)); if(v){ const o=JSON.parse(v); if(o&&o.node===currentNode()) STORE[src]=o; } }catch(e){} } }
  function watchGM(){ if(typeof GM_addValueChangeListener!=="function") return; for(const src of SOURCES){ try{ GM_addValueChangeListener(gmKey(src),()=>{ loadFromGM(); if(isOpen()) render(); updateBadge(); }); }catch(e){} } }
  function sourcesPresent(){ return SOURCES.filter(s=>STORE[s]).length; }

  // ══════════════════════════════════════════════════════════════════════════
  //  PANEL
  // ══════════════════════════════════════════════════════════════════════════
  function buildPanel(){ if(shadow) return;
    const host=document.createElement("div"); host.id="arc-tm-host"; host.style.cssText="all:initial"; (document.body||document.documentElement).appendChild(host);
    shadow=host.attachShadow({mode:"open"}); shadow.innerHTML=STYLE+MARKUP;
    q(".arc-launch").addEventListener("click",()=>{ openDrawer(); render(); });
    q("#arc-close").addEventListener("click",closeDrawer);
    q("#arc-demo").addEventListener("click",loadDemo);
    q("#arc-paste").addEventListener("click",showPaste);
    q("#arc-paste-cancel").addEventListener("click",hidePaste);
    q("#arc-paste-go").addEventListener("click",applyPaste);
    q("#arc-bridge").addEventListener("click",sendToBridge);
    ["lead","horizon","thr","topn"].forEach(id=> q("#arc-"+id).addEventListener("input",onParam));
    loadFromGM(); watchGM(); updateBadge();
  }
  function openDrawer(){ q(".arc-drawer").hidden=false; } function closeDrawer(){ q(".arc-drawer").hidden=true; }
  function isOpen(){ return shadow && !q(".arc-drawer").hidden; }
  function onCaptured(){ if(!shadow) return; updateBadge(); if(isOpen()) render(); }
  function onParam(){ PARAMS.leadMin=+q("#arc-lead").value; PARAMS.horizon=+q("#arc-horizon").value; PARAMS.threshold=(+q("#arc-thr").value)/100; PARAMS.topN=+q("#arc-topn").value;
    q("#arc-lead-v").textContent=PARAMS.leadMin+"m"; q("#arc-horizon-v").textContent=PARAMS.horizon+"h"; q("#arc-thr-v").textContent=Math.round(PARAMS.threshold*100)+"%"; q("#arc-topn-v").textContent=PARAMS.topN;
    render(); }

  const GROUPS = [["Plan",["crossdock"]],["Inbound",["inProfiles","inDoors"]],["CC",["cc"]],["Live out",["sorter"]],["Alloc/Routing",["alloc","profiles","doors"]]];
  function updateBadge(){ const b=q(".arc-badge"); if(!b) return; const n=sourcesPresent(); b.textContent=n; b.hidden=n===0;
    const s=q("#arc-status"); if(s) s.innerHTML = n ? GROUPS.map(([lab,ks])=>`${lab} ${ks.some(k=>STORE[k])?"<b style='color:"+AQUA+"'>✓</b>":"<span style='opacity:.45'>—</span>"}`).join(" · ")+(DEMO?" · <i>demo</i>":"") : "Waiting for data — open arc-capacity, IXDInbound, IxdOutbound/Sorter, and cc for your node, or click Demo."; }

  function render(){ if(!shadow) return;
    q("#arc-node").value=currentNode();
    if (sourcesPresent()===0){ q("#arc-empty").hidden=false; q("#arc-results").hidden=true; updateBadge(); return; }
    q("#arc-empty").hidden=true; q("#arc-results").hidden=false;
    const model=predict();
    q("#arc-scope").textContent = `${currentNode()} · ${model.arcs.length} arcs · lead ${PARAMS.leadMin}m · +${PARAMS.horizon}h`;
    renderKpis(model); renderPredGrid(model); renderHotspots(model); renderInbound(model); renderLiveArcs(); renderAlloc(); renderRouting();
    updateBadge();
  }
  function show(sel,on){ const e=q(sel); if(e) e.hidden=!on; }
  function kpi(label,val,note,hot){ return `<div class="arc-kpi ${hot?'hot':''}"><div class="k-label">${label}</div><div class="k-val">${val}</div><div class="k-note">${note}</div></div>`; }

  function renderKpis(model){
    const hs=hotspots(model), win=windowHours(model.nowHour,PARAMS.horizon);
    const top=hs[0];
    const surge=model.arcs.map(a=>({a,p:model.pressure.get(a)})).sort((x,y)=>y.p-x.p)[0];
    const inTot=[...model.inbound.values()].reduce((s,x)=>s+x,0);
    q("#arc-kpi-sub").innerHTML = top
      ? `Predicted hottest: <b>Arc ${esc(top.arc)}</b> at <b>${hh(top.hour)}</b> → <b style="color:${CRITICAL}">${pct(top.pred)}</b> of capacity (plan ${pct(top.plan)}, inbound surge <b>${fmtX(top.pressure)}</b>). Lead ${PARAMS.leadMin}m.`
      : `No Arc is predicted to exceed ${Math.round(PARAMS.threshold*100)}% in the next ${PARAMS.horizon}h. ${model.inbound.size?'':'(No inbound signal captured yet — open IXDInbound.)'}`;
    q("#arc-kpi").innerHTML=[
      kpi("Hottest Arc/period", top?`${esc(top.arc)} @ ${hh(top.hour)}`:"—", top?pct(top.pred):"none over threshold", !!top),
      kpi("Arc-hours over cap", hs.length+"", `pred ≥ ${Math.round(PARAMS.threshold*100)}% · next ${PARAMS.horizon}h`, hs.length>0),
      kpi("Biggest inbound surge", surge&&surge.p>1?`Arc ${esc(surge.a)}`:"—", surge?fmtX(surge.p)+" vs plan":"no inbound", surge&&surge.p>1.2),
      kpi("Live inbound total", inTot?fmt(inTot):"—", model.inbound.size?`${model.inbound.size} arcs`:"open IXDInbound"),
      kpi("Lead / horizon", `${PARAMS.leadMin}m`, `+${PARAMS.horizon}h ahead`),
    ].join("");
  }

  function renderPredGrid(model){
    const arcs=rankedArcs(model,PARAMS.topN), win=windowHours(model.nowHour,PARAMS.horizon);
    if (!arcs.length){ q("#arc-grid").innerHTML=`<div class="src-hint">No per-Arc plan yet — open the Crossdock arc-capacity view (per-Arc load & capacity).</div>`; return; }
    const cellW=58,cellH=26,labelW=64,top=26,gap=2, W=labelW+win.length*cellW+8, H=top+arcs.length*cellH+30;
    let svg=`<svg viewBox="0 0 ${W} ${H}" role="img">`;
    win.forEach((h,ci)=>{ const xx=labelW+ci*cellW; svg+=`<text class="ax" x="${xx+cellW/2}" y="${top-9}" text-anchor="middle">${String(h).padStart(2,"0")}</text>`; });
    svg+=`<text class="ax" x="${labelW+cellW/2}" y="${top-20}" text-anchor="middle" fill="${GOLD}" font-weight="700">now</text>`;
    arcs.forEach((a,ri)=>{ const yy=top+ri*cellH, row=model.grid.get(a);
      svg+=`<text class="ax" x="${labelW-8}" y="${yy+cellH/2+3}" text-anchor="end" font-weight="600">${esc(a)}</text>`;
      win.forEach((h,ci)=>{ const c=row[h], xx=labelW+ci*cellW; const over=c.pred!=null&&c.pred>=PARAMS.threshold;
        const fill=heavinessColor(c.pred); const stroke=over?CRITICAL:(c.applied?GOLD:"var(--grid)"); const sw=over?1.8:(c.applied?1.4:1);
        const label=c.pred!=null?Math.round(c.pred*100):"";
        svg+=`<rect x="${xx+gap/2}" y="${yy+gap/2}" width="${cellW-gap}" height="${cellH-gap}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" data-tip="Arc ${esc(a)} · ${hh(h)}<br>predicted <b>${pct(c.pred)}</b> (plan ${pct(c.plan)})${c.applied?'<br>inbound surge '+fmtX(model.pressure.get(a)):''}"></rect>`;
        if (label!=="") svg+=`<text x="${xx+cellW/2}" y="${yy+cellH/2+3.5}" text-anchor="middle" font-size="10.5" font-weight="${over?700:500}" fill="${textOn(c.pred)}" pointer-events="none">${label}</text>`;
      });
    });
    svg+=`</svg>`;
    q("#arc-grid").innerHTML=svg;
    qa("#arc-grid rect").forEach(r=>{ r.style.cursor="crosshair"; r.addEventListener("mousemove",ev=>tip(ev,r.dataset.tip)); r.addEventListener("mouseleave",hideTip); });
  }

  function renderHotspots(model){
    const hs=hotspots(model).slice(0,10);
    if (!hs.length){ q("#arc-hotspots").innerHTML=`<div class="src-hint">No predicted hotspots over ${Math.round(PARAMS.threshold*100)}% in the window. Lower the threshold or extend the horizon.</div>`; return; }
    q("#arc-hotspots").innerHTML = `<div class="hs-list">`+hs.map(h=>`<div class="hs-row"><span class="hs-dot" style="background:${heavinessColor(h.pred)}"></span><b>Arc ${esc(h.arc)}</b><span class="hs-hr">${hh(h.hour)}</span><span class="hs-pred" style="color:${h.pred>=1?CRITICAL:'var(--ink)'}">${pct(h.pred)}</span><span class="hs-meta">plan ${pct(h.plan)} · surge ${fmtX(h.pressure)}</span></div>`).join("")+`</div>`;
  }

  function hbars(items,{max,color,valFmt}){ const mx=max??Math.max(...items.map(i=>i.value||0),1);
    return `<div class="bars">`+items.map(i=>{ const w=Math.max(2,Math.min(100,((i.value||0)/mx)*100)); const c=typeof color==="function"?color(i):color;
      return `<div class="bar-row"><div class="bar-lab" title="${esc(i.label)}">${esc(i.label)}</div><div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${c}"></div></div><div class="bar-val">${valFmt?valFmt(i):fmt(i.value)}</div></div>`; }).join("")+`</div>`; }
  function moreNote(t,s){ return t>s?`<div class="more">+${t-s} more</div>`:""; }

  function renderInbound(model){
    show("#card-inbound", model.inbound.size>0);
    if (!model.inbound.size) return;
    const rows=[...model.inbound.entries()].map(([arc,v])=>({label:`Arc ${arc}`,value:v,_p:model.pressure.get(arc)})).sort((a,b)=>b.value-a.value).slice(0,14);
    q("#arc-dock-inbound").innerHTML=hbars(rows,{color:i=>i._p>1.2?ORANGE:VIOLET,valFmt:i=>`${fmt(i.value)} · ${fmtX(i._p)}`})+moreNote(model.inbound.size,14);
  }
  function renderLiveArcs(){ show("#card-arcs",!!STORE.sorter);
    if (!STORE.sorter) return; const arcs=STORE.sorter.arcs.slice(0,14);
    const items=arcs.map(a=>({label:`Arc ${a.arc}`,value:(a.util??0)*100,_u:a.util,_r:a.recircs}));
    q("#arc-dock-arcs").innerHTML=hbars(items,{max:Math.max(100,...items.map(i=>i.value)),color:i=>heavinessColor(i._u??0),valFmt:i=>`${pct(i._u)} · ${fmt(i._r)} rc`})+moreNote(STORE.sorter.arcs.length,14); }
  function renderAlloc(){ show("#card-alloc",!!STORE.alloc);
    if (!STORE.alloc) return; const rows=STORE.alloc.rows.slice(0,14);
    q("#arc-dock-alloc").innerHTML=hbars(rows.map(r=>({label:r.destination,value:r.units||0})),{color:"var(--s1)"})+moreNote(STORE.alloc.rows.length,14); }
  function renderRouting(){ show("#card-routing",!!(STORE.profiles||STORE.doors));
    if (!(STORE.profiles||STORE.doors)) return; let html=`<div class="dock-cols"><div><h4>Top routing profiles (PID total)</h4>`;
    html+= STORE.profiles?hbars(STORE.profiles.rows.slice(0,10).map(r=>({label:r.profile,value:r.pidTotal||0})),{color:AQUA})+moreNote(STORE.profiles.rows.length,10):`<div class="src-hint">Open IxdOutbound to capture routing profiles.</div>`;
    html+=`</div><div><h4>Fluid load doors (recircs)</h4>`;
    html+= STORE.doors?hbars(STORE.doors.rows.slice(0,10).map(r=>({label:r.door+(r.side?` · ${r.side}`:""),value:r.recircs||0})),{color:ORANGE})+moreNote(STORE.doors.rows.length,10):`<div class="src-hint">Open IxdOutbound to capture load doors.</div>`;
    html+=`</div></div>`; q("#arc-dock-routing").innerHTML=html; }

  function tip(ev,html){ const t=q("#arc-tip"); t.innerHTML=html; t.classList.add("show");
    let x=ev.clientX+14,y=ev.clientY+14; const r=t.getBoundingClientRect();
    if(x+r.width>PAGE.innerWidth-8)x=ev.clientX-r.width-14; if(y+r.height>PAGE.innerHeight-8)y=ev.clientY-r.height-14; t.style.left=x+"px"; t.style.top=y+"px"; }
  function hideTip(){ const t=q("#arc-tip"); if(t)t.classList.remove("show"); }

  function showPaste(){ q("#arc-paste-box").hidden=false; } function hidePaste(){ q("#arc-paste-box").hidden=true; }
  function applyPaste(){ const raw=q("#arc-paste-input").value.trim(); if(!raw) return; let json; try{ json=JSON.parse(raw); }catch(e){ alert("Not valid JSON: "+e.message); return; }
    const before=sourcesPresent(); consider(json); if(sourcesPresent()===before){ alert("Couldn't recognize that payload (arc-capacity / sorter / inbound profiles / doors / allocation / cc). Share one record's shape and I'll map it."); return; } hidePaste(); render(); }

  function sendToBridge(){ if(typeof GM_xmlhttpRequest!=="function"){ alert("GM_xmlhttpRequest not granted."); return; }
    GM_xmlhttpRequest({ method:"POST", url:BRIDGE_URL, headers:{"Content-Type":"application/json"}, data:JSON.stringify({source:"arcCapacity",node:currentNode(),params:PARAMS,store:STORE,capturedAt:Date.now()}),
      onload:()=>flash("Sent to dashboard ✓"), onerror:()=>flash("Bridge not reachable — run server.py :5220"), ontimeout:()=>flash("Bridge timed out") }); }
  function flash(m){ const s=q("#arc-status"); if(!s) return; s.textContent=m; setTimeout(updateBadge,2500); }

  // ── Demo: realistic multi-Arc scenario with a couple of inbound surges ─────
  function hashStr(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return (h>>>0); }
  const DEMO_ARCS = ["DTW1","LUK2","KRB6","MSP1","ORD5","ATL6","DFW7","PHX3","SLC2","BOS1","JFK8","LAX9"];
  function loadDemo(){
    const node=currentNode(), recs=[], today=new Date();
    const days=[4,3,2,1,0].map(i=>{ const d=new Date(today); d.setDate(d.getDate()-i); return isoDate(d); });
    DEMO_ARCS.forEach((arc,ai)=>{ const cap=180+(hashStr(arc)%120); const peakHr=(9+ai*1.3)%24;
      days.forEach(d=>{ for(let h=0;h<24;h++){ const hump=Math.exp(-((h-peakHr)**2)/16)*0.9+Math.exp(-((h-(peakHr+10)%24)**2)/12)*0.6;
        const load=Math.round(cap*(0.08+hump)*(0.9+(hashStr(arc+d+h)%20)/100)); recs.push({arc,dateISO:d,hour:h,load,capacity:cap}); } }); });
    STORE.crossdock={records:recs,node,at:Date.now()};
    // live outbound sorter (per-arc util)
    const wc=[]; DEMO_ARCS.forEach((arc,ai)=>{ const base=0.45+((ai%4)*0.12); for(let k=0;k<3;k++){ const u=Math.min(1.25,base+(hashStr(arc+"w"+k)%25)/100); wc.push({workcell:arc+"-"+k,arc,status:u>1?"Overloaded":"Running",utilization:u,recircs:Math.round((u>0.9?1:0.3)*(hashStr(arc+"r"+k)%40))}); } });
    STORE.sorter=Object.assign(summarizeSorter(wc),{node,at:Date.now()});
    // inbound routing profiles → arc (two arcs surging: DTW1, MSP1)
    const surge={DTW1:2.6,MSP1:2.2,ATL6:1.7};
    STORE.inProfiles={rows:DEMO_ARCS.map((arc,i)=>({profile:"IB-"+arc,arc,pidTotal:Math.round((900+(hashStr(arc)%600))*(surge[arc]||0.85))})).sort((a,b)=>b.pidTotal-a.pidTotal),node,at:Date.now()};
    STORE.inDoors={rows:["D01","D02","D03","D04","D05","D06"].map((d,i)=>({door:d,arc:DEMO_ARCS[i],side:i<3?"West":"East",recircs:Math.round(120*(1-i*0.12))})),node,at:Date.now()};
    STORE.cc={rows:DEMO_ARCS.map(arc=>({arc,inbound:Math.round((400+(hashStr(arc+"cc")%300))*(surge[arc]||0.8)),recircs:hashStr(arc)%30,util:null,status:""})),node,at:Date.now()};
    STORE.alloc={rows:DEMO_ARCS.map((d,i)=>({destination:d,units:Math.round(4200*(1-i*0.06)),doors:2+(i%3)})).sort((a,b)=>b.units-a.units),node,at:Date.now()};
    STORE.profiles={rows:["P-A","P-B","P-C","P-D","P-E"].map((p,i)=>({profile:p,arc:DEMO_ARCS[i],pidTotal:Math.round(3200*(1-i*0.14)),recircs:Math.round(180*(1-i*0.1))})),node,at:Date.now()};
    STORE.doors={rows:["D01","D02","D03","D04","D05","D06"].map((d,i)=>({door:d,side:i<3?"West":"East",recircs:Math.round(160*(1-i*0.1)+(hashStr(d)%25))})).sort((a,b)=>b.recircs-a.recircs),node,at:Date.now()};
    DEMO=true; render();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STYLE + MARKUP
  // ══════════════════════════════════════════════════════════════════════════
  const STYLE = `<style>
    :host,* { box-sizing:border-box; }
    :host { --surf:#fcfcfb; --plane:#fff; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781; --grid:#e1e0d9; --base:#c3c2b7;
      --s1:#2a78d6; --band:rgba(42,120,214,.16); --border:rgba(11,11,11,.10); --hdr:#1a1a2e; --chip:#eef1f5; --chipb:#d9dee6;
      font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
    @media (prefers-color-scheme: dark){ :host { --surf:#1a1a19; --plane:#201f1e; --ink:#fff; --ink2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --base:#383835;
      --s1:#3987e5; --band:rgba(57,135,229,.20); --border:rgba(255,255,255,.12); --hdr:#101019; --chip:#2a2a28; --chipb:#3a3a37; } }
    .arc-launch { position:fixed; right:18px; bottom:18px; z-index:2147483000; background:var(--s1); color:#fff; border:none; border-radius:22px; padding:10px 16px; font:600 13px/1 system-ui; cursor:pointer; box-shadow:0 4px 14px rgba(0,0,0,.3); }
    .arc-launch:hover{ filter:brightness(1.06); } .arc-badge{ position:absolute; top:-6px; right:-6px; background:${AQUA}; color:#fff; border:2px solid var(--plane); border-radius:10px; min-width:18px; height:18px; padding:0 4px; font:700 10px/14px system-ui; text-align:center; }
    [hidden]{ display:none !important; }
    .arc-drawer{ position:fixed; inset:0 0 0 auto; width:min(1060px,97vw); z-index:2147483001; background:var(--plane); color:var(--ink); box-shadow:-8px 0 40px rgba(0,0,0,.35); display:flex; flex-direction:column; font-size:13px; }
    .arc-head{ background:var(--hdr); color:#fff; padding:11px 16px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .arc-head h1{ font-size:15px; font-weight:600; flex:1; min-width:150px; } .arc-head .scope{ font-size:11px; color:#b7c0d0; font-weight:400; }
    .arc-btn{ background:rgba(255,255,255,.14); color:#fff; border:1px solid rgba(255,255,255,.18); border-radius:5px; padding:5px 10px; font:600 12px system-ui; cursor:pointer; }
    .arc-btn:hover{ background:rgba(255,255,255,.24); } .arc-btn.primary{ background:var(--s1); border-color:var(--s1); }
    .arc-sub{ padding:7px 16px; background:var(--surf); border-bottom:1px solid var(--border); display:flex; gap:14px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--ink2); }
    .arc-sub input[type=text]{ font:inherit; font-size:12px; padding:3px 7px; border-radius:4px; border:1px solid var(--chipb); background:var(--plane); color:var(--ink); width:70px; }
    #arc-status{ margin-left:auto; color:var(--muted); font-size:11px; }
    .arc-ctrls{ padding:8px 16px; background:var(--surf); border-bottom:1px solid var(--border); display:flex; gap:18px; align-items:center; flex-wrap:wrap; }
    .ctrl{ display:flex; align-items:center; gap:8px; font-size:11px; color:var(--ink2); } .ctrl label{ font-weight:700; text-transform:uppercase; letter-spacing:.3px; color:var(--muted); }
    .ctrl input[type=range]{ width:118px; accent-color:var(--s1); } .ctrl b{ color:var(--ink); min-width:34px; text-align:right; font-variant-numeric:tabular-nums; }
    .arc-body{ padding:14px 16px; overflow-y:auto; }
    .arc-card{ background:var(--surf); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:14px; }
    .arc-card h2{ font-size:14px; font-weight:700; margin:0 0 2px; } .arc-card p{ font-size:11.5px; color:var(--ink2); margin:0 0 8px; line-height:1.5; }
    .arc-kpis{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
    .arc-kpi{ background:var(--plane); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
    .arc-kpi .k-label{ font:700 10px system-ui; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); }
    .arc-kpi .k-val{ font-size:22px; font-weight:650; margin-top:3px; letter-spacing:-.5px; } .arc-kpi .k-note{ font-size:11px; color:var(--ink2); margin-top:1px; } .arc-kpi.hot .k-val{ color:${CRITICAL}; }
    svg{ display:block; width:100%; height:auto; overflow:visible; } .ax{ fill:var(--muted); font-size:10px; }
    .legend{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-top:10px; font-size:11px; color:var(--ink2); }
    .ramp{ width:120px; height:12px; border-radius:3px; border:1px solid var(--border); background:linear-gradient(90deg,#cde2fb,#9ec5f4,#5598e7,#2a78d6,#1c5cab,#104281); }
    .swatch{ width:13px; height:13px; border-radius:3px; display:inline-block; vertical-align:-2px; } .sw-red{ background:${CRITICAL}; } .sw-gold{ background:transparent; border:2px solid ${GOLD}; }
    .hs-list{ display:flex; flex-direction:column; gap:5px; } .hs-row{ display:flex; align-items:center; gap:9px; font-size:12.5px; padding:5px 8px; background:var(--plane); border:1px solid var(--border); border-radius:6px; }
    .hs-dot{ width:11px; height:11px; border-radius:3px; } .hs-hr{ color:var(--muted); font-variant-numeric:tabular-nums; } .hs-pred{ font-weight:700; font-variant-numeric:tabular-nums; } .hs-meta{ margin-left:auto; color:var(--muted); font-size:11.5px; }
    .bars{ display:flex; flex-direction:column; gap:6px; } .bar-row{ display:grid; grid-template-columns:110px 1fr auto; gap:8px; align-items:center; font-size:11.5px; }
    .bar-lab{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink2); } .bar-track{ background:var(--chip); border-radius:4px; height:14px; overflow:hidden; } .bar-fill{ height:100%; border-radius:4px; }
    .bar-val{ font-variant-numeric:tabular-nums; color:var(--ink); min-width:104px; text-align:right; } .more{ font-size:11px; color:var(--muted); margin-top:7px; }
    .dock-cols{ display:grid; grid-template-columns:1fr 1fr; gap:20px; } @media (max-width:720px){ .dock-cols{ grid-template-columns:1fr; } }
    .dock-cols h4{ font:700 11px system-ui; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); margin:0 0 8px; } .src-hint{ font-size:11.5px; color:var(--muted); font-style:italic; }
    .arc-empty{ text-align:center; padding:44px 20px; color:var(--ink2); } .arc-empty .i{ font-size:34px; } .arc-empty h3{ margin:8px 0 6px; color:var(--ink); font-size:15px; } .arc-empty p{ font-size:12px; line-height:1.6; max-width:500px; margin:0 auto; }
    #arc-paste-box{ padding:0 16px 14px; } #arc-paste-input{ width:100%; height:110px; font:11px/1.4 ui-monospace,monospace; padding:8px; border:1px solid var(--chipb); border-radius:6px; background:var(--surf); color:var(--ink); resize:vertical; }
    .arc-paste-row{ display:flex; gap:8px; justify-content:flex-end; margin-top:8px; }
    #arc-tip{ position:fixed; z-index:2147483002; pointer-events:none; opacity:0; transition:opacity .08s; background:var(--ink); color:var(--plane); font-size:11.5px; line-height:1.45; padding:7px 9px; border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,.3); max-width:240px; } #arc-tip.show{ opacity:1; }
    code{ background:var(--chip); border:1px solid var(--chipb); border-radius:3px; padding:1px 5px; font-size:11px; }
  </style>`;

  const MARKUP = `
    <button class="arc-launch" title="ARC Capacity — predictive Arc heaviness">📊 ARC<span class="arc-badge" hidden>0</span></button>
    <section class="arc-drawer" hidden>
      <div class="arc-head">
        <h1>ARC Heaviness Forecast <span class="scope" id="arc-scope"></span></h1>
        <button class="arc-btn" id="arc-demo">✨ Demo</button>
        <button class="arc-btn" id="arc-paste">📋 Paste JSON</button>
        <button class="arc-btn" id="arc-bridge">↗ Dashboard</button>
        <button class="arc-btn" id="arc-close">✕ Close</button>
      </div>
      <div class="arc-sub">
        <span>Node <input id="arc-node" type="text" value="RFD2" readonly></span>
        <span id="arc-status">Waiting for data…</span>
      </div>
      <div class="arc-ctrls">
        <div class="ctrl"><label>Lead</label><input id="arc-lead" type="range" min="0" max="240" step="15" value="90"><b id="arc-lead-v">90m</b></div>
        <div class="ctrl"><label>Horizon</label><input id="arc-horizon" type="range" min="1" max="12" step="1" value="6"><b id="arc-horizon-v">6h</b></div>
        <div class="ctrl"><label>Heavy ≥</label><input id="arc-thr" type="range" min="70" max="150" step="5" value="100"><b id="arc-thr-v">100%</b></div>
        <div class="ctrl"><label>Top arcs</label><input id="arc-topn" type="range" min="5" max="30" step="1" value="15"><b id="arc-topn-v">15</b></div>
      </div>
      <div id="arc-paste-box" hidden>
        <textarea id="arc-paste-input" placeholder="Paste any arc-capacity / sorter / inbound-profiles / doors / allocation / cc JSON…"></textarea>
        <div class="arc-paste-row"><button class="arc-btn" id="arc-paste-cancel">Cancel</button><button class="arc-btn primary" id="arc-paste-go">Analyze</button></div>
      </div>
      <div class="arc-body">
        <div id="arc-empty" class="arc-empty"><div class="i">🔮</div><h3>Waiting for ARC data</h3>
          <p>Open, for your node: Crossdock <b>arc-capacity</b> (per-Arc plan), DockFlow <b>IXDInbound</b> (inbound throw), <b>IxdOutbound / Sorter</b> (live outbound), and <b>cc</b> (command center). This script captures each and forecasts which Arc goes heavy when. Or click <b>✨ Demo</b>.</p></div>
        <div id="arc-results" hidden>
          <div class="arc-card"><h2>Forecast summary</h2><p id="arc-kpi-sub"></p><div class="arc-kpis" id="arc-kpi"></div></div>
          <div class="arc-card"><h2>Predicted heaviness — Arc × upcoming hour</h2>
            <p>Each cell = <b>predicted</b> heaviness (load ÷ capacity) for that Arc in that hour = Crossdock plan × lead-shifted live inbound surge. Darker = heavier; <b style="color:${CRITICAL}">red = over capacity</b>; <b style="color:${GOLD}">gold border</b> = hours the inbound surge is applied (after lead time).</p>
            <div id="arc-grid"></div>
            <div class="legend"><span>0%</span><span class="ramp"></span><span>100%</span><span><span class="swatch sw-red"></span> over cap</span><span><span class="swatch sw-gold"></span> surge applied</span></div>
          </div>
          <div class="arc-card"><h2>Predicted hotspots</h2><p>Arc/hours predicted to exceed the threshold, worst first.</p><div id="arc-hotspots"></div></div>
          <div class="arc-card" id="card-inbound"><h2>Live inbound throw by Arc</h2><p>Blended inbound signal per Arc (IXDInbound routing profiles + load doors + Command Center). Orange = surging vs plan.</p><div id="arc-dock-inbound"></div></div>
          <div class="arc-card" id="card-arcs"><h2>Live outbound Arc utilization</h2><p>Per-Arc utilization + recircs from DockFlow Sorter (the current backlog the forecast builds on).</p><div id="arc-dock-arcs"></div></div>
          <div class="arc-card" id="card-alloc"><h2>Allocation plan by destination</h2><p>Planned outbound allocation per destination (IxdOutbound).</p><div id="arc-dock-alloc"></div></div>
          <div class="arc-card" id="card-routing"><h2>Routing profiles &amp; load doors</h2><p>Outbound routing profiles by PID total and fluid load doors by recircs.</p><div id="arc-dock-routing"></div></div>
        </div>
      </div>
    </section>
    <div id="arc-tip"></div>`;

  hookNetwork();
  const ready = fn => (document.readyState==="loading") ? document.addEventListener("DOMContentLoaded",fn,{once:true}) : fn();
  ready(buildPanel);
})();
