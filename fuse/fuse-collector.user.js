// ==UserScript==
// @name         FUSE Collector — live feed + theory bridge
// @namespace    fuse-v001
// @version      1.0.0
// @description  Feeds the FUSE dashboards (IXD/IBD/ANTI/OBD/CDT·WM) from YMS, SSP, NEO & DockFlow, and bakes in the weight-heat + close-out (RTD) ETA theory. Scrapes on the source tabs, injects on the FUSE tabs via GM storage.
// @author       you
// @match        *://*/*fuse-ixd.html*
// @match        *://*/*fuse-ibd.html*
// @match        *://*/*fuse-anti.html*
// @match        *://*/*fuse-obd.html*
// @match        *://*/*fuse-cdt.html*
// @match        file:///*fuse-*.html*
// @match        *://tamarin.aces.amazon.dev/*fuse*
// @match        *://trans-logistics.amazon.com/yms/shipclerk*
// @match        *://trans-logistics.amazon.com/ssp/dock/hrz/ob*
// @match        *://neo.meta.amazon.dev/*
// @match        *://*.dockflow.robotics.a2z.com/*
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        unsafeWindow
// @connect      trans-logistics.amazon.com
// @connect      ii51s3lexd.execute-api.us-east-1.amazonaws.com
// @connect      neo.meta.amazon.dev
// @connect      dockflow.robotics.a2z.com
// @connect      amazon.dev
// ==/UserScript==
//
// HOW IT WORKS
//   • On a SOURCE tab (YMS / SSP / NEO / DockFlow) it scrapes and writes to GM
//     storage (cross-origin shared via Tampermonkey).
//   • On a FUSE tab it copies GM storage into the page's localStorage (ff.*),
//     computes close-out ETAs (theory) into ff.cdt, intercepts the page's
//     /api/* "Pull" buttons, and re-renders.
//   Keep a YMS + SSP tab open (pinned) and the FUSE board fills itself.
//
// ADJUST: the @match host for your FUSE board, the SITE code, and the NEO /
//   DockFlow scrapers (marked TODO) once you confirm their DOM / JSON.

(async function () {
  "use strict";

  const SITE = new URLSearchParams(location.search).get("nodeId") || "RFD2";
  const TARGET = 40000, FLOOR = 28000;        // dispatch window for the weight heat
  const YMS_API = "https://ii51s3lexd.execute-api.us-east-1.amazonaws.com/call/";

  const G = {
    get: async (k, fb) => { try { return await GM.getValue(k, fb); } catch { return fb; } },
    set: async (k, v) => { try { await GM.setValue(k, v); } catch {} },
  };
  const xhr = o => new Promise((res, rej) =>
    GM.xmlHttpRequest({ timeout: 30000, ...o, onload: res, onerror: rej, ontimeout: () => rej("timeout") }));
  const num = t => parseFloat(String(t).replace(/[^0-9.]/g, "")) || 0;

  /* ── inlined theory (close-out ETA + cdt risk) — mirrors fuse-theory.js ───── */
  const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  function parseSdt(sdt) {
    if (!sdt) return null;
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(sdt)) { const t = Date.parse(sdt); return isNaN(t)?null:Math.floor(t/1000); }
    const m = String(sdt).match(/(\d{2})-([A-Za-z]{3})-(\d{2})\s+(\d{1,2}):(\d{2})/);
    if (!m) { const t = Date.parse(sdt); return isNaN(t)?null:Math.floor(t/1000); }
    return Math.floor(new Date(2000+ +m[3], MONTHS[m[2]], +m[1], +m[4], +m[5]).getTime()/1000);
  }
  const avg = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
  function durationModel(metrics, sspByVr) {
    const all = [], byDest = {};
    for (const m of metrics || []) {
      if (!(m.startToFinish > 0)) continue;
      all.push(m.startToFinish);
      const s = sspByVr[m.vrId]; const d = s && s.route ? s.route.split("->")[1] : null;
      if (d) (byDest[d] = byDest[d] || []).push(m.startToFinish);
    }
    const dest = {}; for (const d in byDest) dest[d] = { avg: avg(byDest[d]), n: byDest[d].length };
    return { overall: avg(all), dest };
  }
  function closeout(load, model, now) {
    const target = load.targetWeight || TARGET, buf = 30;
    const fin = r => {
      if (load.sdtTs) { r.slackMin = Math.round((load.sdtTs - r.predictedCloseTs)/60);
        r.risk = r.slackMin<0?"MISS":r.slackMin<buf?"AT_RISK":"ON_TRACK"; }
      else { r.slackMin = null; r.risk = "UNKNOWN"; }
      r.etaMin = Math.round(r.etaMin); return r;
    };
    if (load.status === "FINISHED_LOADING") return fin({ method:"closed", etaMin:0, predictedCloseTs: load.completeTs||now });
    if (load.fillRate > 0 && load.weight != null)
      return fin({ method:"weight", etaMin: Math.max(0,target-load.weight)/load.fillRate*60, predictedCloseTs: now + Math.max(0,target-load.weight)/load.fillRate*3600 });
    const dur = (load.dest && model.dest[load.dest] && model.dest[load.dest].n>=3) ? model.dest[load.dest].avg : model.overall;
    if (load.status === "LOADING_IN_PROGRESS" && load.startTs)
      return fin({ method:"time", etaMin: (load.startTs+dur*60-now)/60, predictedCloseTs: load.startTs+dur*60 });
    return fin({ method:"not-started", etaMin: dur, predictedCloseTs: now + dur*60 });
  }
  function cdtRisk(minRemaining, weight) {
    let lvl = minRemaining<=30?"urgent":minRemaining<=90?"warn":"ok";
    if (lvl==="ok" && weight!=null && weight < FLOOR-6000) lvl="warn";
    return lvl;
  }

  const badge = (text, color) => {
    let el = document.getElementById("fuse-badge");
    if (!el) { el = document.createElement("div"); el.id = "fuse-badge";
      el.style.cssText = "position:fixed;bottom:10px;right:10px;z-index:2147483647;background:#14213d;color:#ffb703;padding:6px 12px;border-radius:6px;font:600 12px system-ui;border:1px solid #ffb703;box-shadow:0 4px 16px rgba(0,0,0,.3)";
      document.body.appendChild(el); }
    el.textContent = text; el.style.color = color || "#ffb703";
  };

  const host = location.hostname, path = location.pathname + location.href;
  if (/fuse-(ixd|ibd|anti|obd|cdt)/.test(path)) return fusePage();
  if (host.includes("trans-logistics.amazon.com") && location.pathname.includes("/yms/shipclerk")) return ymsSource();
  if (host.includes("trans-logistics.amazon.com") && location.pathname.includes("/ssp/dock")) return sspSource();
  if (host.includes("neo.meta.amazon.dev")) return neoSource();
  if (host.includes("dockflow")) return dockflowSource();

  /* ════════════════════════════════════════════════════════════════════════
     FUSE PAGE — pour GM storage into ff.* localStorage, compute ff.cdt, hook /api
  ════════════════════════════════════════════════════════════════════════ */
  async function fusePage() {
    const T = unsafeWindow.FUSE_THEORY;   // page loads fuse-theory.js
    const win = unsafeWindow;

    async function sync() {
      const [goalsCsv, trailersCsv, doorsCsv, liveFeed, dockHub, ssp, events] = await Promise.all([
        G.get("fuse.goalsCsv", null), G.get("fuse.trailersCsv", null), G.get("fuse.doorsCsv", null),
        G.get("fuse.liveFeed", null), G.get("fuse.dockHub", null),
        G.get("fuse.ssp", null), G.get("fuse.events", null),
      ]);
      const put = (k, v) => { if (v != null) win.localStorage.setItem(k, typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)); };
      // page STORE uses JSON.stringify; goalsCsv etc. are strings → store as JSON string
      if (goalsCsv)    win.localStorage.setItem("ff.goalsCsv", JSON.stringify(goalsCsv));
      if (trailersCsv) win.localStorage.setItem("ff.trailersCsv", JSON.stringify(trailersCsv));
      if (doorsCsv)    win.localStorage.setItem("ff.doorsCsv", JSON.stringify(doorsCsv));
      if (liveFeed)    win.localStorage.setItem("ff.liveFeed", JSON.stringify(liveFeed));
      if (dockHub)     win.localStorage.setItem("ff.dockHubCapture", JSON.stringify(dockHub));

      // ── compute ff.cdt with the theory (close-out ETA + status) ──
      if (ssp && ssp.length) {
        const now = Math.floor(Date.now()/1000);
        const sspByVr = {}; ssp.forEach(s => sspByVr[s.vrid] = s);
        const model = durationModel(events || [], sspByVr);
        const metByVr = {}; (events||[]).forEach(m => metByVr[m.vrId] = m);
        const cdt = ssp.map(s => {
          const m = metByVr[s.vrid] || {};
          const sdtTs = parseSdt(s.sdt);
          const co = closeout({ status:s.status, startTs:m.startTs, completeTs:m.completeTs,
            sdtTs, dest: s.route ? s.route.split("->")[1] : null, weight:s.weight,
            fillRate: s.fillRate || 0 }, model, now);
          const minRemaining = sdtTs ? Math.max(0, Math.round((sdtTs-now)/60)) : (s.minRemaining ?? 999);
          return { vrid:s.vrid, type:s.type||"—", cdt: s.cdt || (sdtTs?new Date(sdtTs*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):""),
            minRemaining, weight: s.weight||0, gwOpen: !!s.gwOpen, closeout: co, status: cdtRisk(minRemaining, s.weight) };
        });
        win.localStorage.setItem("ff.cdt", JSON.stringify(cdt));
      }
      if (typeof win.renderAll === "function") { try { win.renderAll(); } catch {} }
      badge("⚡ FUSE: live data synced " + new Date().toLocaleTimeString(), "#66bb6a");
    }

    // intercept the page's /api/* Pull buttons → serve GM data
    const of = win.fetch;
    win.fetch = async function (url, opts) {
      const u = String(url || "");
      if (u.startsWith("/api/")) {
        if (u.includes("neo-goals"))  { const c = await G.get("fuse.goalsCsv", null); if (c) return jsonResp({ csv: c }); }
        if (u.includes("dock-hub"))   { const d = await G.get("fuse.dockHub", null);  if (d) return jsonResp(d); }
        if (u.includes("live-feed"))  { const l = await G.get("fuse.liveFeed", null);  if (l) return jsonResp(l); }
        return new Response("{}", { status: 404 });
      }
      return of.apply(this, arguments);
    };
    function jsonResp(o){ return new Response(JSON.stringify(o), { status:200, headers:{ "Content-Type":"application/json" } }); }

    badge("⚡ FUSE collector active", "#ffb703");
    await sync();
    setInterval(sync, 60000);
  }

  /* ════════════════════════════════════════════════════════════════════════
     YMS SOURCE — trailers, doors, and OB loading-duration events
  ════════════════════════════════════════════════════════════════════════ */
  async function ymsSource() {
    badge("⚡ FUSE: scanning YMS…", "#4fc3f7");
    try {
      let token = null;
      document.querySelectorAll("script").forEach(s => { const m = s.textContent.match(/ymsSecurityToken\s*=\s*"([^"]+)"/); if (m) token = m[1]; });
      if (!token) { const m = document.documentElement.outerHTML.match(/ymsSecurityToken\s*=\s*"([^"]+)"/); if (m) token = m[1]; }
      if (!token) { badge("⚡ FUSE: no YMS token", "#ff6b6b"); return; }
      const yard = (() => { try { return JSON.parse(atob(token.split(".")[1])).context?.yard || SITE; } catch { return SITE; } })();
      const api = (name, body) => xhr({ method:"POST", url: YMS_API+name,
        headers:{ "Content-Type":"application/json", token, api:name, method:"POST" }, data: JSON.stringify(body) })
        .then(r => JSON.parse(r.responseText));

      const now = Math.floor(Date.now()/1000), from = now - 86400;
      const evReq = (eventType) => ({ requester:{system:"YMSWebApp"}, yard, eventType, fromDate:from, toDate:now,
        firstRow:0, rowCount:200, annotation:"", loadIdentifier:"", loadIdentifierType:"", location:"", seal:"",
        userId:"", vehicleNumber:"", vehicleOwner:"", vehicleType:"", visitReason:"" });

      const [yardData, started, completed] = await Promise.all([
        api("getYardStateWithPendingMoves", { requester:{system:"YMSWebApp"}, yard }),
        api("getEventReport", evReq("OB_DOCK_STARTED")),
        api("getEventReport", evReq("OB_DOCK_COMPLETED")),
      ]);

      // loading-duration metrics (close-out ETA model)
      const startMap = {}, compMap = {};
      (started.events||[]).forEach(e => { if (e.visitId) startMap[e.visitId] = { vrId:e.vrId, ts:e.timestamp }; });
      (completed.events||[]).forEach(e => { if (e.visitId) compMap[e.visitId] = e.timestamp; });
      const events = Object.keys(startMap).map(vid => {
        const s = startMap[vid], c = compMap[vid];
        return { vrId:s.vrId, startTs:s.ts, completeTs:c||null,
          startToFinish: c && c>=s.ts ? Math.round((c-s.ts)/60) : null };
      });

      // trailers + doors from yard state
      const trailers = [["vrid","isa","yard_location","arrival_time","dwell_hours","freight_type","totes_pct","cases_pct","status","is_live_load"]];
      const doors = [["door","door_type","status","current_trailer","reserved_for_live","estimated_completion"]];
      (yardData.locationsSummaries||[]).forEach(sum => (sum.locations||[]).forEach(loc => {
        const code = (loc.locationName||loc.name||loc.code||"").toString();
        const isDoor = /^\d+$/.test(code) || /^DD/i.test(code);
        const assets = loc.yardAssets||[];
        if (isDoor) {
          const a = assets[0];
          doors.push([code, loc.locationType||"Dock Door",
            a ? "Occupied" : (loc.status||"Open"), a ? (a.vehicleNumber||"") : "",
            String(!!(a && a.reservedForLive)), ""]);
        }
        assets.forEach(a => {
          const arrival = a.checkInTime || a.arrivalTime || "";
          const dwellH = arrival ? Math.round((Date.now()-Date.parse(arrival))/3.6e6) : "";
          // freight_type / totes_pct / cases_pct are not in YMS — left blank (TODO: enrich from SSP/DockFlow)
          trailers.push([a.vehicleNumber||"", a.visitId||"", code, arrival, dwellH, "", "", "",
            a.status||"Ready", String(!!a.liveLoad)]);
        });
      }));

      await G.set("fuse.trailersCsv", trailers.map(r => r.join(",")).join("\n"));
      await G.set("fuse.doorsCsv", doors.map(r => r.join(",")).join("\n"));
      await G.set("fuse.events", events);
      badge(`⚡ FUSE: YMS ok — ${trailers.length-1} trailers, ${doors.length-1} doors, ${events.length} loads`, "#66bb6a");
    } catch (e) { console.error("[FUSE/YMS]", e); badge("⚡ FUSE: YMS error", "#ff6b6b"); }
  }

  /* ════════════════════════════════════════════════════════════════════════
     SSP OB SOURCE — outbound loads (status, route, SDT, weight) for CDT + theory
  ════════════════════════════════════════════════════════════════════════ */
  async function sspSource() {
    badge("⚡ FUSE: scanning SSP…", "#4fc3f7");
    try {
      const r = await fetch(`/ssp/dock/hrz/ob/fetchdata?entity=getDefaultOutboundDockView&nodeId=${SITE}`, { credentials:"include" });
      const raw = await r.json();
      const ssp = (raw.ret?.aaData || raw.aaData || []).map(item => {
        const l = item.load||{}, t = item.trailer||{}, res = (item.resource||[])[0]||{};
        const dest = (l.route||"").split("->")[1] || "";
        return {
          vrid: l.vrId, status: l.status, route: l.route, sdt: l.scheduledDepartureTime,
          location: res.label || t.location, type: l.freightType || dest || "—",
          // weight: SSP OB view may expose load/trailer weight — TODO confirm exact field
          weight: num(l.weight ?? l.payloadWeight ?? t.weight ?? 0) || 0,
          contentCount: num(l.unitCount ?? l.containerCount ?? 0) || 0,
          dwellMin: num(l.dwellTime), gwOpen: !!(l.alertStatus && l.alertStatus.gatekeeping),
        };
      }).filter(x => x.vrid);
      await G.set("fuse.ssp", ssp);
      badge(`⚡ FUSE: SSP ok — ${ssp.length} OB loads`, "#66bb6a");
    } catch (e) { console.error("[FUSE/SSP]", e); badge("⚡ FUSE: SSP error", "#ff6b6b"); }
  }

  /* ════════════════════════════════════════════════════════════════════════
     NEO SOURCE — goals  (TODO: confirm NEO's table/JSON, then map to goalsCsv)
  ════════════════════════════════════════════════════════════════════════ */
  async function neoSource() {
    badge("⚡ FUSE: NEO — set up scraper", "#ffa726");
    try {
      // Best-effort DOM scrape: rows of "subtype  goal  actual". ADJUST selectors.
      const rows = [["department","subtype","goal","actual","period"]];
      document.querySelectorAll("table tr").forEach(tr => {
        const c = [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
        if (c.length >= 3 && /\d/.test(c[1]) && /\d/.test(c[2])) {
          rows.push(["OBDock", c[0], num(c[1]), num(c[2]), "P1"]);   // TODO: split IB/OB, real columns
        }
      });
      if (rows.length > 1) { await G.set("fuse.goalsCsv", rows.map(r => r.join(",")).join("\n"));
        badge(`⚡ FUSE: NEO ok — ${rows.length-1} goals`, "#66bb6a"); }
      else badge("⚡ FUSE: NEO — no rows matched (edit neoSource)", "#ffa726");
    } catch (e) { console.error("[FUSE/NEO]", e); badge("⚡ FUSE: NEO error", "#ff6b6b"); }
  }

  /* ════════════════════════════════════════════════════════════════════════
     DOCKFLOW SOURCE — divert / sorter weight  (TODO: confirm API/DOM)
  ════════════════════════════════════════════════════════════════════════ */
  async function dockflowSource() {
    badge("⚡ FUSE: DockFlow — set up scraper", "#ffa726");
    try {
      // Prefer intercepting DockFlow's own data calls; fallback to a manual capture.
      const cap = { capturedAt: Date.now(), site: SITE, divert: null /* TODO: parse divert mix + sorter weight */ };
      await G.set("fuse.dockHub", cap);
      badge("⚡ FUSE: DockFlow capture stored", "#66bb6a");
    } catch (e) { console.error("[FUSE/DockFlow]", e); badge("⚡ FUSE: DockFlow error", "#ff6b6b"); }
  }
})();
