/* ============================================================================
   fuse-theory.js  —  shared "theory" for the FUSE suite

   One module, used by the FUSE pages (window.FUSE_THEORY), the collector
   userscript, and Node tests (module.exports). It carries the analytics the
   suite is built on:

     • weightHeat()    — trailer payload as a dispatch-window heat colour
                         (grey 0 → green filling → yellow @ floor → red @ cube-out)
     • close-out ETA   — predict when an OB trailer finishes loading (RTD) and
                         whether it beats SDT  (time-based from YMS start events,
                         or weight-based when payload + rate are known)
     • cdtRisk()       — CDT-proximity + weight → urgent/warn/ok status
     • parseCsv()      — same delimiter-sniffing parser the pages use
============================================================================ */
(function (factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.FUSE_THEORY = api;
  if (typeof unsafeWindow !== "undefined") unsafeWindow.FUSE_THEORY = api;
})(function () {
  "use strict";

  const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const avg = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
  const bucket5 = p => Math.max(0, Math.min(100, Math.floor(p/5)*5));

  /* ── weight heat: dispatch window (default 28k floor / 40k cube-out) ──────── */
  function weightHeat(weight, opts) {
    opts = opts || {};
    const target = opts.target || 40000, floor = opts.floor || 28000;
    const pct = target > 0 ? Math.max(0, Math.min(100, weight / target * 100)) : 0;
    const b = bucket5(pct);
    const fp = target > 0 ? floor / target * 100 : 70;
    let bg, fg = "#fff", label;
    if (weight <= 0)       { bg = "#94a3b8"; label = "EMPTY"; }
    else if (b >= 100)     { bg = "hsl(0,75%,45%)"; label = "CUBE-OUT"; }
    else {
      const hue = b < fp ? 140 - 70 * (b / fp) : 60 - 60 * ((b - fp) / (100 - fp));
      bg = `hsl(${Math.round(hue)},72%,42%)`;
      label = weight >= floor ? "READY" : "FILLING";
      if (hue > 75) fg = "#16310f";   // readable text on yellow-greens
    }
    return { bg, fg, pct: Math.round(pct), bucket: b, label };
  }

  /* ── close-out / RTD ETA ─────────────────────────────────────────────────── */
  function destFromRoute(route) { return route ? (String(route).split("->")[1] || null) : null; }

  function parseSdtToEpochS(sdt) {
    if (sdt == null || sdt === "") return null;
    // numeric/Date-ish (e.g. "6/18/2026 6:32")
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(sdt)) { const t = Date.parse(sdt); return isNaN(t) ? null : Math.floor(t/1000); }
    // SSP "16-Jun-26 00:54"
    const m = String(sdt).match(/(\d{2})-([A-Za-z]{3})-(\d{2})\s+(\d{1,2}):(\d{2})/);
    if (!m) { const t = Date.parse(sdt); return isNaN(t) ? null : Math.floor(t/1000); }
    return Math.floor(new Date(2000+ +m[3], MONTHS[m[2]], +m[1], +m[4], +m[5]).getTime()/1000);
  }

  function buildDurationModel(metrics) {
    const all = [], byDest = {};
    for (const m of metrics || []) {
      if (m.startToFinish == null || m.startToFinish <= 0) continue;
      all.push(m.startToFinish);
      if (m.dest) (byDest[m.dest] = byDest[m.dest] || []).push(m.startToFinish);
    }
    const dest = {};
    for (const d in byDest) dest[d] = { avg: avg(byDest[d]), n: byDest[d].length };
    return { overall: avg(all), dest, n: all.length };
  }
  function expectedDuration(model, dest, minSamples) {
    const d = dest && model.dest[dest];
    return (d && d.n >= (minSamples || 3)) ? d.avg : model.overall;
  }
  function fillRateLbHr(payloadWeight, contentCount, liveRateJobsHr) {
    if (!contentCount || !liveRateJobsHr) return 0;
    return liveRateJobsHr * (payloadWeight / contentCount);
  }

  function closeoutEta(load, model, opts) {
    opts = opts || {};
    const now    = opts.now || Math.floor(Date.now()/1000);
    const target = load.targetWeight || opts.targetWeight || 40000;
    const buffer = opts.sdtBufferMin != null ? opts.sdtBufferMin : 30;

    if (load.status === "FINISHED_LOADING")
      return finalize({ method:"closed", etaMin:0, predictedCloseTs: load.completeTs || now, progressPct:100 }, load, buffer);

    const fr = fillRateLbHr(load.payloadWeight, load.contentCount, load.liveRate);
    if (fr > 0 && load.payloadWeight != null) {
      const etaMin = Math.max(0, target - load.payloadWeight) / fr * 60;
      return finalize({ method:"weight", etaMin, predictedCloseTs: now + etaMin*60,
        progressPct: Math.min(100, load.payloadWeight/target*100) }, load, buffer);
    }
    const durMin = expectedDuration(model || {overall:0,dest:{}}, load.dest, opts.minSamples);
    if (load.status === "LOADING_IN_PROGRESS" && load.startTs) {
      const predicted = load.startTs + durMin*60;
      const elapsedMin = (now - load.startTs)/60;
      return finalize({ method:"time", etaMin:(predicted-now)/60, predictedCloseTs:predicted,
        progressPct: durMin>0 ? Math.min(100, Math.max(0, elapsedMin/durMin*100)) : 0 }, load, buffer);
    }
    return finalize({ method:"not-started", etaMin:durMin, predictedCloseTs: now + durMin*60, progressPct:0 }, load, buffer);

    function finalize(r, l, buf) {
      if (l.sdtTs) { r.slackMin = Math.round((l.sdtTs - r.predictedCloseTs)/60);
        r.risk = r.slackMin < 0 ? "MISS" : r.slackMin < buf ? "AT_RISK" : "ON_TRACK"; }
      else { r.slackMin = null; r.risk = "UNKNOWN"; }
      r.etaMin = Math.round(r.etaMin); r.progressPct = Math.round(r.progressPct);
      return r;
    }
  }

  function enrichWithCloseout(loads, loadMetrics, opts) {
    const byVr = {};
    for (const m of loadMetrics || []) if (m.vrId) byVr[m.vrId] = m;
    const tagged = (loadMetrics||[]).map(m => {
      const s = (loads||[]).find(l => (l.vrid||l.vrId) === m.vrId);
      return { startToFinish: m.startToFinish, dest: s ? destFromRoute(s.route) : null };
    });
    const model = buildDurationModel(tagged);
    return (loads||[]).map(l => {
      const m = byVr[l.vrid || l.vrId] || {};
      const load = { status:l.status, startTs:m.startTs||null, completeTs:m.completeTs||null,
        sdtTs: parseSdtToEpochS(l.sdt), dest: destFromRoute(l.route),
        payloadWeight:l.payloadWeight, contentCount:l.contentCount, liveRate:l.liveRate, targetWeight:l.targetWeight };
      return Object.assign({}, l, { closeout: closeoutEta(load, model, opts) });
    });
  }

  /* ── CDT proximity + weight → status ─────────────────────────────────────── */
  function cdtRisk(minRemaining, weight, opts) {
    opts = opts || {};
    const crit = opts.criticalMin || 30, watch = opts.watchMin || 90;
    let level = minRemaining <= crit ? "urgent" : minRemaining <= watch ? "warn" : "ok";
    // critically light/heavy trailer this close to CDT is at least a warn
    if (level === "ok" && weight != null && (weight < (opts.floor||28000) - 6000)) level = "warn";
    return { level };
  }

  function fmtEta(min) {
    if (min == null || isNaN(min)) return "—";
    const s = min < 0 ? "−" : "", a = Math.abs(Math.round(min));
    return a < 60 ? `${s}${a}m` : `${s}${Math.floor(a/60)}h ${a%60}m`;
  }

  function parseCsv(text) {
    if (!text) return [];
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    const delim = lines[0].includes("\t") ? "\t" : ",";
    const headers = lines[0].split(delim).map(h => h.trim());
    return lines.slice(1).map(line => {
      const cols = line.split(delim);
      return headers.reduce((r,h,i)=>{ r[h] = (cols[i]||"").trim(); return r; }, {});
    });
  }

  return { weightHeat, closeoutEta, enrichWithCloseout, buildDurationModel, expectedDuration,
           fillRateLbHr, destFromRoute, parseSdtToEpochS, cdtRisk, fmtEta, parseCsv };
});
