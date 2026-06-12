// ==UserScript==
// @name         OB Report Card - Live Metrics Fetch Bridge
// @namespace    ob-report-card
// @version      1.0.0
// @description  CORS fetch bridge so the OB Period Report Card can pull MonitorPortal Search-API metric data in the background. No parsing here - the dashboard does all of that.
// @match        file:///*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      monitorportal.amazon.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // Only run on the OB Report Card dashboard page.
  if (!document.querySelector('meta[name="ob-report-card"]') && !/OB Period Report Card/i.test(document.title)) return;

  const gmFetch = typeof GM_xmlhttpRequest === 'function'
    ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);
  if (!gmFetch) return;

  const VERSION = '1.0.0';
  const MAX_BODY = 800000;

  function fetchOne(item) {
    return new Promise((resolve) => {
      try {
        gmFetch({
          method: 'GET',
          url: item.url,
          timeout: 25000,
          headers: { Accept: 'application/json, text/csv, text/plain, */*' },
          anonymous: false,
          onload: (res) => resolve({
            id: item.id,
            url: item.url,
            finalUrl: res.finalUrl || item.url,
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            body: String(res.responseText || '').slice(0, MAX_BODY)
          }),
          onerror: (err) => resolve({
            id: item.id,
            url: item.url,
            ok: false,
            status: 0,
            error: (err && (err.error || err.message)) || 'network error'
          }),
          ontimeout: () => resolve({ id: item.id, url: item.url, ok: false, status: 0, error: 'timeout' })
        });
      } catch (err) {
        resolve({ id: item.id, url: item.url, ok: false, status: 0, error: String((err && err.message) || err) });
      }
    });
  }

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || data.type !== 'PRC_V2_LIVE_FETCH_REQUEST' || !Array.isArray(data.urls)) return;
    const results = await Promise.all(data.urls.map(fetchOne));
    window.postMessage({
      type: 'PRC_V2_LIVE_FETCH_RESULT',
      requestId: data.requestId,
      results,
      finishedAt: Date.now()
    }, '*');
  });

  const announce = () => window.postMessage({ type: 'PRC_V2_LIVE_BRIDGE_READY', version: VERSION }, '*');
  announce();
  // The dashboard binds its listener during init - re-announce so it never misses us.
  setTimeout(announce, 3000);
  setTimeout(announce, 10000);
})();
