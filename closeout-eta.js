/* ============================================================================
   closeout-eta.js  —  "When will this trailer close out (finish loading / RTD)?"

   Pure helpers that reuse the exact signals nIXD OB Insights already pulls:

     SSP load   : { vrid, status, route, sdt, dwellMin, ... }
     YMS metric : { vrId, startTs(s), completeTs(s), startToFinish(min) }

   Two estimators, auto-selected:
     • time-based  : predictedClose = startTs + avg(startToFinish), per-dest when
                     there are enough samples. Uses OB_DOCK_STARTED + the historical
                     loading duration the script already computes.
     • weight-based: eta = (target - payloadWeight) / fillRate, where
                     fillRate(lb/hr) = liveRate(jobs/hr) * payloadWeight/contentCount.
                     Used automatically when Dockflow weight + rate are merged onto
                     the load (same maths as the weight heat map's ETA-to-40k).

   Every estimate is compared to SDT to produce slack + a risk flag
   (ON_TRACK / AT_RISK / MISS), which is the bit OB ops actually act on.

   Works in Node (module.exports) and in the browser / Tampermonkey
   (window.CloseoutETA / unsafeWindow.CloseoutETA).
============================================================================ */
(function (factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.CloseoutETA = api;
  if (typeof unsafeWindow !== "undefined") unsafeWindow.CloseoutETA = api;
})(function () {
  "use strict";

  const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const avg = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;

  /* "RFD2->SBN1" → "SBN1" */
  function destFromRoute(route) {
    return route ? (String(route).split("->")[1] || null) : null;
  }

  /* SSP sdt string "16-Jun-26 00:54" → epoch SECONDS (mirrors the script's parseSDT) */
  function parseSdtToEpochS(sdt) {
    const m = (sdt || "").match(/(\d{2})-([A-Za-z]{3})-(\d{2})\s+(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(2000 + +m[3], MONTHS[m[2]], +m[1], +m[4], +m[5]);
    return Math.floor(d.getTime() / 1000);
  }

  /* Build expected loading-duration model (minutes), overall + per destination.
     metrics: [{ startToFinish(min), dest? }]  */
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

  /* per-dest avg when we have >= minSamples, else the site-wide avg */
  function expectedDuration(model, dest, minSamples) {
    const d = dest && model.dest[dest];
    return (d && d.n >= (minSamples || 3)) ? d.avg : model.overall;
  }

  /* weight heat-map fill rate, lb/hr */
  function fillRateLbHr(payloadWeight, contentCount, liveRateJobsHr) {
    if (!contentCount || !liveRateJobsHr) return 0;
    return liveRateJobsHr * (payloadWeight / contentCount);
  }

  /* ── core: close-out ETA for ONE load ──────────────────────────────────────
     load: { status, startTs?(s), completeTs?(s), sdtTs?(s), dest?,
             payloadWeight?, contentCount?, liveRate?, targetWeight? }
     returns { method, etaMin, predictedCloseTs(s), progressPct, slackMin, risk } */
  function closeoutEta(load, model, opts) {
    opts = opts || {};
    const now    = opts.now || Math.floor(Date.now() / 1000);
    const target = load.targetWeight || opts.targetWeight || 40000;
    const buffer = opts.sdtBufferMin != null ? opts.sdtBufferMin : 30;

    // already closed / RTD
    if (load.status === "FINISHED_LOADING") {
      return finalize({ method:"closed", etaMin:0,
        predictedCloseTs: load.completeTs || now, progressPct:100 }, load, now, buffer);
    }

    // weight-based (preferred when a live rate + weight are present)
    const fr = fillRateLbHr(load.payloadWeight, load.contentCount, load.liveRate);
    if (fr > 0 && load.payloadWeight != null) {
      const remaining = Math.max(0, target - load.payloadWeight);
      const etaMin = remaining / fr * 60;
      return finalize({ method:"weight", etaMin,
        predictedCloseTs: now + etaMin * 60,
        progressPct: Math.min(100, load.payloadWeight / target * 100) }, load, now, buffer);
    }

    // time-based (historical loading duration)
    const durMin = expectedDuration(model, load.dest, opts.minSamples);
    if (load.status === "LOADING_IN_PROGRESS" && load.startTs) {
      const predicted   = load.startTs + durMin * 60;
      const elapsedMin  = (now - load.startTs) / 60;
      return finalize({ method:"time", etaMin: (predicted - now) / 60,
        predictedCloseTs: predicted,
        progressPct: durMin > 0 ? Math.min(100, Math.max(0, elapsedMin / durMin * 100)) : 0 },
        load, now, buffer);
    }

    // not started yet — optimistic "if it started now"
    return finalize({ method:"not-started", etaMin: durMin,
      predictedCloseTs: now + durMin * 60, progressPct: 0 }, load, now, buffer);
  }

  function finalize(r, load, now, buffer) {
    if (load.sdtTs) {
      r.slackMin = Math.round((load.sdtTs - r.predictedCloseTs) / 60);
      r.risk = r.slackMin < 0 ? "MISS" : r.slackMin < buffer ? "AT_RISK" : "ON_TRACK";
    } else {
      r.slackMin = null;
      r.risk = "UNKNOWN";
    }
    r.etaMin = Math.round(r.etaMin);
    r.progressPct = Math.round(r.progressPct);
    return r;
  }

  /* ── integration: enrich nIXD's SSP loads with .closeout ────────────────────
     sspLoads    : dashData.loads          (from processData)
     loadMetrics : dashEvents.loadMetrics  (from the YMS scraper)
     Returns the same loads, each with a `.closeout` object. */
  function enrichWithCloseout(sspLoads, loadMetrics, opts) {
    opts = opts || {};
    const byVr = {};
    for (const m of loadMetrics || []) if (m.vrId) byVr[m.vrId] = m;

    // tag each metric with the load's destination so the model can be per-dest
    const tagged = (loadMetrics || []).map(m => {
      const s = sspLoads.find(l => l.vrid === m.vrId);
      return { startToFinish: m.startToFinish, dest: s ? destFromRoute(s.route) : null };
    });
    const model = buildDurationModel(tagged);

    return sspLoads.map(l => {
      const m = byVr[l.vrid] || {};
      const load = {
        status:        l.status,
        startTs:       m.startTs || null,
        completeTs:    m.completeTs || null,
        sdtTs:         parseSdtToEpochS(l.sdt),
        dest:          destFromRoute(l.route),
        payloadWeight: l.payloadWeight,   // present only if Dockflow weights are merged in
        contentCount:  l.contentCount,
        liveRate:      l.liveRate,
        targetWeight:  l.targetWeight,
      };
      return Object.assign({}, l, { closeout: closeoutEta(load, model, opts) });
    });
  }

  /* fleet roll-up for a summary card */
  function fleetCloseoutSummary(enriched) {
    const open = enriched.filter(l => l.closeout && l.closeout.method !== "closed");
    const risk = { ON_TRACK:0, AT_RISK:0, MISS:0, UNKNOWN:0 };
    let next = null;
    for (const l of open) {
      risk[l.closeout.risk] = (risk[l.closeout.risk] || 0) + 1;
      if (l.closeout.predictedCloseTs && (!next || l.closeout.predictedCloseTs < next.closeout.predictedCloseTs))
        next = l;
    }
    return { openLoads: open.length, risk, next };
  }

  /* "1h 11m" / "12m" / "−18m" */
  function fmtEta(min) {
    if (min == null || isNaN(min)) return "—";
    const s = min < 0 ? "−" : "";
    const a = Math.abs(Math.round(min));
    return a < 60 ? `${s}${a}m` : `${s}${Math.floor(a/60)}h ${a%60}m`;
  }

  return {
    destFromRoute, parseSdtToEpochS, buildDurationModel, expectedDuration,
    fillRateLbHr, closeoutEta, enrichWithCloseout, fleetCloseoutSummary, fmtEta,
  };
});
