// ==UserScript==
// @name         Zone-RA Unified Suite
// @version      2.2
// @description  All-in-one: Labor Tracker, Enhancement Suite, Staffing Lookup - unified left-side toolbar (any site)
// @author       zavaedua
// @match        https://zone-ra.amazon.dev/*
// @match        https://durable.corp.amazon.com/*/simba/audits/new_audit*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @connect      fcmenu-iad-regionalized.corp.amazon.com
// @connect      atoz.amazon.work
// @connect      zone-ra.amazon.dev
// @connect      internal-cdn.amazon.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================================
    //  SECTION 1 — CONFIG & CONSTANTS
    // ==========================================================
    const FCMENU_BASE = 'https://fcmenu-iad-regionalized.corp.amazon.com';
    const KIOSK_URL   = FCMENU_BASE + '/do/laborTrackingKiosk';
    const LENEL_API   = 'https://atoz.amazon.work/apis/AMEXService/get-lenel-data?clientId=ATOZ_AMX_SERVICE';
    // Auto-detect site from Zone-RA URL path
    const SITE = (function() {
        const m = window.location.pathname.match(/\/(?:roster|staffing-history)\/([a-z0-9]+)\//i);
        if (m) return m[1].toLowerCase();
        const stored = GM_getValue('lt_site', '');
        if (stored) return stored;
        const prompted = prompt('ZoneRa: Enter your site code:');
        if (prompted) { GM_setValue('lt_site', prompted.trim().toLowerCase()); return prompted.trim().toLowerCase(); }
        return '';
    })();
    const STAFFING_BASE = `https://zone-ra.amazon.dev/staffing-history/${SITE}/api/data/`;
    const PHOTO_URL   = login => `https://internal-cdn.amazon.com/badgephotos.amazon.com/?uid=${encodeURIComponent(login)}`;
    const STAFFING_MAX_PAGES = 200;
    const STAFFING_BATCH     = 10;

    // Labor Tracker — User-Configurable AREAS
    let LT_CODES = JSON.parse(GM_getValue('lt_codes', '[]'));
    function ltSaveCodes() { GM_setValue('lt_codes', JSON.stringify(LT_CODES)); }
    const URL_MAP = {'/ob/obd/':'OB Dock','/ob/rsort/':'Sort','/ib/ibd/':'IB Dock','/icqa/icqa/':'ISS','/ob/flow/':'Flow','/ib/rpn/':'RPND'};
    function getAreaFromURL() { const p=window.location.pathname; for(const[k,v]of Object.entries(URL_MAP)){if(p.includes(k))return v;} return null; }

    // ==========================================================
    //  SECTION 2 — SHARED STATE
    // ==========================================================
    let ltTrackingMode=false, ltSessionReady=false, ltActiveCalmCode=null, ltActiveCalmLabel='', ltActiveArea='', ltActiveSubArea='';
    let ltPanelLevel='closed'; // 'closed' | 'codes' | 'subs' | 'areas'
    let ltTrackedBadges=new Map(), ltProcessing=new Set();
    let jsBarcodeReady=false; const badgeDataStore=new Map(); let selectedLinkType='timecard';
    let currentLenelEmployee=null;
    let staffAllResults=[], staffCurrentFilter='all', staffIsFetching=false;


    // ==========================================================
    //  SECTION 3 — ALL STYLES
    // ==========================================================
    GM_addStyle(`
        /* ============ LEFT SIDEBAR TOOLBAR — GLASSMORPHISM ============ */
        #zru-toolbar{position:fixed;bottom:24px;left:24px;width:190px;background:linear-gradient(160deg,rgba(15,15,25,0.92),rgba(10,10,20,0.96));backdrop-filter:blur(20px) saturate(1.8);border:1px solid rgba(255,255,255,0.06);border-radius:20px;box-shadow:0 12px 48px rgba(0,0,0,0.55),0 0 0 1px rgba(255,255,255,0.04),inset 0 1px 0 rgba(255,255,255,0.05);z-index:99999;display:flex;flex-direction:column;overflow:hidden;font-family:'Amazon Ember',-apple-system,BlinkMacSystemFont,sans-serif;transition:transform .35s cubic-bezier(.4,0,.2,1),opacity .35s ease}
        #zru-toolbar.collapsed{transform:translateX(-220px);opacity:0;pointer-events:none}
        #zru-toolbar-toggle{position:fixed;bottom:24px;left:12px;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,rgba(15,15,25,0.92),rgba(10,10,20,0.96));backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:16px;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.4);transition:all .2s}
        #zru-toolbar-toggle:hover{background:linear-gradient(135deg,rgba(0,115,187,0.3),rgba(0,80,140,0.3));color:#fff;transform:scale(1.1);box-shadow:0 6px 28px rgba(0,115,187,0.25)}
        #zru-toolbar-toggle.show{display:flex}
        .zru-collapse-row{display:flex;align-items:center;justify-content:space-between;padding:8px 12px 4px;flex-shrink:0}
        .zru-collapse-row .zru-suite-label{font-size:10px;font-weight:700;color:rgba(255,255,255,0.25);letter-spacing:0.8px}
        .zru-collapse-btn{background:rgba(255,255,255,0.06);border:none;color:rgba(255,255,255,0.3);width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}
        .zru-collapse-btn:hover{background:rgba(244,67,54,0.4);color:#fff;transform:scale(1.1)}
        #zru-toolbar .zru-section{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.04)}
        #zru-toolbar .zru-section:last-child{border-bottom:none}
        .zru-section-label{font-size:9px;font-weight:700;color:rgba(255,255,255,0.2);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;padding:0 6px}
        .zru-btn{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;background:0 0;border:none;color:rgba(255,255,255,0.5);font-size:12px;font-family:inherit;font-weight:500;cursor:pointer;text-align:left;border-radius:10px;transition:all .2s cubic-bezier(.4,0,.2,1)}
        .zru-btn:hover{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.85);transform:translateX(2px)}
        .zru-btn:active{transform:scale(.97) translateX(2px)}
        .zru-btn .zru-icon{font-size:16px;width:24px;text-align:center;flex-shrink:0;filter:drop-shadow(0 0 4px rgba(255,255,255,0.1))}
        .zru-btn .zru-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .zru-link-btn{padding:7px 10px;font-size:11px;border-radius:8px;position:relative;overflow:hidden}
        .zru-link-btn::before{content:'';position:absolute;inset:0;border-radius:8px;background:linear-gradient(135deg,rgba(0,150,255,0.12),rgba(0,200,255,0.06));opacity:0;transition:opacity .2s}
        .zru-link-btn:hover::before{opacity:1}
        .zru-link-btn.active{background:linear-gradient(135deg,rgba(0,115,187,0.2),rgba(0,180,255,0.1))!important;color:#5dd8ff!important;font-weight:600;box-shadow:inset 0 0 0 1px rgba(0,150,255,0.3),0 0 12px rgba(0,150,255,0.08)}
        .zru-link-status{font-size:10px;color:rgba(255,255,255,0.18);text-align:center;padding:6px 0 2px;font-style:italic}
        .zru-btn.xt-scanning{color:#ff9800!important;animation:xt-scan-pulse 1.5s infinite}
        .zru-btn.xt-active{color:#4caf50!important;text-shadow:0 0 8px rgba(76,175,80,0.3)}
        @keyframes xt-scan-pulse{0%,100%{opacity:1}50%{opacity:.6}}
        /* ============ LABOR TRACKER FAB ============ */
        #lt-fab{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;background:linear-gradient(135deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));border:none;color:rgba(255,255,255,0.45);font-size:13px;font-family:'Amazon Ember',-apple-system,sans-serif;font-weight:600;cursor:pointer;text-align:left;transition:all .3s cubic-bezier(.4,0,.2,1);user-select:none;border-top:1px solid rgba(255,255,255,0.04);border-radius:0 0 20px 20px}
        #lt-fab:hover{background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.7)}
        #lt-fab.active{background:linear-gradient(135deg,#0073bb,#005a9c)!important;color:#fff!important;box-shadow:0 4px 20px rgba(0,115,187,0.3),inset 0 1px 0 rgba(255,255,255,0.15)}
        #lt-fab .lt-conn-dot{width:8px;height:8px;border-radius:50%;background:#444;flex-shrink:0;box-shadow:0 0 6px rgba(0,0,0,0.3)}
        #lt-fab .lt-conn-dot.green{background:#4caf50;box-shadow:0 0 8px rgba(76,175,80,0.5)}
        #lt-fab .lt-conn-dot.yellow{background:#ff9800;animation:lt-pulse 1.5s infinite;box-shadow:0 0 8px rgba(255,152,0,0.5)}
        #lt-fab .lt-conn-dot.red{background:#f44336;box-shadow:0 0 8px rgba(244,67,54,0.5)}
        @keyframes lt-pulse{0%,100%{opacity:1}50%{opacity:.35}}
        #lt-fab .lt-count{background:rgba(255,255,255,0.08);padding:2px 8px;border-radius:12px;font-size:10px;min-width:16px;text-align:center;margin-left:auto;border:1px solid rgba(255,255,255,0.06)}
        #lt-fab.active .lt-count{background:rgba(255,255,255,0.2);border-color:rgba(255,255,255,0.15)}
        #lt-fab .lt-close{display:none;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.15);color:#fff;font-size:13px;line-height:1;cursor:pointer;margin-left:6px;flex-shrink:0;transition:background .15s}
        #lt-fab .lt-close:hover{background:rgba(244,67,54,0.7)}
        #lt-fab.active .lt-close{display:flex}
        /* ============ LT AREA PANEL ============ */
        #lt-area-panel{position:fixed;bottom:24px;left:226px;width:320px;max-height:520px;background:linear-gradient(160deg,rgba(15,15,25,0.96),rgba(8,8,16,0.98));backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.06);border-radius:18px;box-shadow:0 16px 56px rgba(0,0,0,0.65),0 0 0 1px rgba(255,255,255,0.03);z-index:99998;display:none;flex-direction:column;overflow:hidden;font-family:'Amazon Ember',-apple-system,sans-serif;color:#e0e0e0}
        #lt-area-panel.open{display:flex}
        .lt-panel-header{padding:16px 20px;background:linear-gradient(135deg,#0073bb,#005a9c);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;box-shadow:0 2px 12px rgba(0,115,187,0.2)}
        .lt-panel-header h3{margin:0;font-size:15px;font-weight:700;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.2)}
        .lt-panel-header .lt-back-btn{background:rgba(255,255,255,0.15);border:none;color:#fff;padding:5px 14px;border-radius:10px;cursor:pointer;font-size:12px;font-weight:600;backdrop-filter:blur(4px);transition:all .15s}
        .lt-panel-header .lt-back-btn:hover{background:rgba(255,255,255,0.28);transform:translateX(-2px)}
        .lt-panel-header .lt-panel-close{background:rgba(255,255,255,0.12);border:none;color:rgba(255,255,255,0.7);width:26px;height:26px;border-radius:8px;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0;margin-left:6px}
        .lt-panel-header .lt-panel-close:hover{background:rgba(244,67,54,0.5);color:#fff;transform:scale(1.1)}
        #lt-active-bar{padding:10px 20px;background:rgba(255,255,255,0.02);border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;color:rgba(255,255,255,0.4);display:none;align-items:center;gap:8px;flex-shrink:0}
        #lt-active-bar.show{display:flex}
        #lt-active-bar .lt-active-code{background:linear-gradient(135deg,#0073bb,#0097e6);color:#fff;padding:3px 12px;border-radius:12px;font-weight:600;font-size:11px;box-shadow:0 2px 8px rgba(0,115,187,0.25)}
        #lt-active-bar .lt-active-label{color:rgba(255,255,255,0.6);font-weight:500}
        .lt-panel-body{overflow-y:auto;flex:1;max-height:420px;padding:8px 0}
        .lt-panel-body::-webkit-scrollbar{width:5px}
        .lt-panel-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:3px}
        .lt-area-btn{display:flex;align-items:center;gap:14px;width:100%;padding:14px 20px;background:0 0;border:none;color:rgba(255,255,255,0.75);font-size:14px;font-family:inherit;font-weight:500;cursor:pointer;text-align:left;transition:all .15s;border-bottom:1px solid rgba(255,255,255,0.03)}
        .lt-area-btn:hover{background:rgba(255,255,255,0.04);color:#fff;padding-left:24px}
        .lt-area-btn .lt-area-icon{font-size:22px;width:30px;text-align:center;filter:drop-shadow(0 0 4px rgba(255,255,255,0.1))}
        .lt-area-btn .lt-area-name{flex:1}
        .lt-area-btn .lt-area-arrow{color:rgba(255,255,255,0.2);font-size:16px}
        .lt-area-btn.disabled{opacity:.3;cursor:not-allowed}
        .lt-sub-btn{display:flex;align-items:center;gap:12px;width:100%;padding:13px 20px 13px 32px;background:0 0;border:none;color:rgba(255,255,255,0.6);font-size:13px;font-family:inherit;font-weight:500;cursor:pointer;text-align:left;transition:all .15s;border-bottom:1px solid rgba(255,255,255,0.02)}
        .lt-sub-btn:hover{background:rgba(255,255,255,0.04);color:#fff}
        .lt-sub-btn .lt-sub-name{flex:1}
        .lt-sub-btn .lt-sub-count{color:rgba(255,255,255,0.25);font-size:11px}
        .lt-sub-btn .lt-sub-arrow{color:rgba(255,255,255,0.15);font-size:14px}
        .lt-code-btn{display:flex;align-items:center;gap:12px;width:100%;padding:13px 20px;background:0 0;border:none;color:rgba(255,255,255,0.75);font-size:13px;font-family:inherit;cursor:pointer;text-align:left;transition:all .15s;border-bottom:1px solid rgba(255,255,255,0.02)}
        .lt-code-btn:hover{background:rgba(0,115,187,0.08);color:#fff}
        .lt-code-btn .lt-code-id{font-family:'Cascadia Code',Consolas,monospace;font-weight:700;color:#4dc3ff;min-width:80px;font-size:13px}
        .lt-code-btn .lt-code-label{flex:1;color:rgba(255,255,255,0.5)}
        .lt-code-btn .lt-code-check{color:#4caf50;font-size:16px;display:none}
        .lt-code-btn.selected .lt-code-check{display:inline}
        .lt-code-btn.selected{background:linear-gradient(90deg,rgba(0,115,187,0.15),transparent);border-left:3px solid #0097e6}
        body.lt-tracking-mode .new-associate-card,body.lt-tracking-mode .associate-card{cursor:crosshair!important}
        body.lt-tracking-mode .new-associate-card:hover,body.lt-tracking-mode .associate-card:hover{outline:3px solid #0097e6!important;outline-offset:-3px;box-shadow:0 0 16px rgba(0,151,230,0.2)!important}
        .lt-tracking{outline:3px solid #ff9800!important;outline-offset:-3px;opacity:.7!important;pointer-events:none!important}
        .lt-tracked{outline:3px solid #4caf50!important;outline-offset:-3px}
        .lt-track-failed{outline:3px solid #f44336!important;outline-offset:-3px}
        .lt-badge-indicator{position:absolute!important;top:5px!important;left:5px!important;width:22px!important;height:22px!important;border-radius:50%!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:12px!important;z-index:101!important;box-shadow:0 2px 8px rgba(0,0,0,0.3)!important;pointer-events:none!important}
        .lt-badge-indicator.ok{background:#4caf50!important;box-shadow:0 0 8px rgba(76,175,80,0.4)!important}
        .lt-badge-indicator.fail{background:#f44336!important}
        .lt-badge-indicator.pending{background:#ff9800!important}
        /* ============ TOAST ============ */
        #lt-toast-container{position:fixed;top:16px;right:16px;z-index:100000;display:flex;flex-direction:column;gap:8px;pointer-events:none}
        .lt-toast{padding:12px 18px;border-radius:12px;font-family:'Amazon Ember',-apple-system,sans-serif;font-size:13px;font-weight:500;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,0.3);animation:lt-toast-in .3s cubic-bezier(.34,1.56,.64,1),lt-toast-out .3s ease 2.7s forwards;max-width:360px;backdrop-filter:blur(8px)}
        .lt-toast.success{background:linear-gradient(135deg,rgba(46,125,50,0.95),rgba(27,94,32,0.95))}.lt-toast.error{background:linear-gradient(135deg,rgba(198,40,40,0.95),rgba(183,28,28,0.95))}.lt-toast.info{background:linear-gradient(135deg,rgba(21,101,192,0.95),rgba(13,71,161,0.95))}.lt-toast.warning{background:linear-gradient(135deg,rgba(230,81,0,0.95),rgba(191,54,12,0.95))}
        @keyframes lt-toast-in{from{opacity:0;transform:translateX(40px) scale(.9)}to{opacity:1;transform:translateX(0) scale(1)}}
        @keyframes lt-toast-out{from{opacity:1}to{opacity:0;transform:translateY(-10px)}}
        /* ============ TRACKED LIST ============ */
        #lt-list-panel{position:fixed;bottom:24px;left:562px;width:280px;max-height:400px;background:linear-gradient(160deg,rgba(15,15,25,0.96),rgba(8,8,16,0.98));backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.06);border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,0.5);z-index:99997;display:none;flex-direction:column;overflow:hidden;font-family:'Amazon Ember',-apple-system,sans-serif;color:#e0e0e0}
        #lt-list-panel.open{display:flex}
        #lt-list-header{padding:14px 18px;background:linear-gradient(135deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02));font-size:13px;font-weight:600;color:rgba(255,255,255,0.8);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.04)}
        #lt-list-header button{background:rgba(255,255,255,0.08);border:none;color:rgba(255,255,255,0.5);padding:5px 12px;border-radius:8px;cursor:pointer;font-size:11px;transition:all .15s}
        #lt-list-header button:hover{background:rgba(255,255,255,0.15);color:#fff}
        #lt-list-body{overflow-y:auto;flex:1;max-height:340px}
        .lt-list-entry{padding:10px 18px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.03);font-size:12px;transition:background .1s}
        .lt-list-entry:hover{background:rgba(255,255,255,0.02)}
        .lt-list-entry .lt-le-status{width:8px;height:8px;border-radius:50%;flex-shrink:0}
        .lt-list-entry .lt-le-status.ok{background:#4caf50;box-shadow:0 0 6px rgba(76,175,80,0.4)}.lt-list-entry .lt-le-status.fail{background:#f44336}
        .lt-list-entry .lt-le-name{font-weight:600;color:rgba(255,255,255,0.85);flex:1}
        .lt-list-entry .lt-le-code{color:#4dc3ff;font-size:10px;font-family:'Cascadia Code',monospace}
        .lt-list-entry .lt-le-time{color:rgba(255,255,255,0.25);font-size:11px}
        .lt-list-empty{padding:32px;text-align:center;color:rgba(255,255,255,0.2);font-size:13px;font-style:italic}
        /* ============ ENHANCEMENT SUITE CARDS ============ */
        .new-associate-card.associate-card{position:relative!important}
        .associates-panel-container{position:sticky!important;top:20px!important;max-height:calc(100vh - 40px)!important;overflow-y:auto!important}
        html{scroll-behavior:smooth}
        .card:has(.card-title){position:sticky!important;top:20px!important;max-height:calc(100vh - 40px)!important;overflow-y:auto!important;z-index:999!important}
        /* ============ LENEL MODAL ============ */
        #zr-lenel-modal{display:none;position:fixed;z-index:999999;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);animation:zr-fadeIn .25s ease}
        @keyframes zr-fadeIn{from{opacity:0}to{opacity:1}}
        .zr-modal-content{background:#f7f8fa;margin:4vh auto;width:92%;max-width:780px;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,0.25);font-family:-apple-system,BlinkMacSystemFont,"Amazon Ember",sans-serif;display:flex;flex-direction:column;max-height:92vh;animation:zr-slideIn .3s cubic-bezier(.16,1,.3,1);overflow:hidden}
        @keyframes zr-slideIn{from{transform:translateY(-20px) scale(.98);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}
        .zr-modal-header{padding:18px 24px;background:linear-gradient(135deg,#1a1a2e,#16213e);border-bottom:3px solid #ff9900;display:flex;justify-content:space-between;align-items:center}
        .zr-modal-header h2{margin:0;font-size:17px;font-weight:700;color:#fff;display:flex;align-items:center;gap:10px}
        .zr-modal-close{color:rgba(255,255,255,0.4);font-size:24px;font-weight:700;cursor:pointer;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px;transition:all .15s}
        .zr-modal-close:hover{color:#fff;background:rgba(255,255,255,0.1)}
        .zr-modal-body{padding:20px 24px;flex-grow:1;overflow-y:auto;background:#f7f8fa}
        .zr-employee-banner{display:flex;align-items:center;gap:16px;padding:14px 18px;margin-bottom:16px;background:#fff;border:1px solid #e8ecec;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.04)}
        .zr-emp-photo{width:50px;height:50px;border-radius:12px;background-size:cover;background-position:center;flex-shrink:0;border:2px solid #e8ecec}
        .zr-emp-info{display:flex;flex-direction:column;gap:2px}
        .zr-emp-name{font-size:16px;font-weight:700;color:#16191f}
        .zr-emp-detail{font-size:12px;color:#545b64}
        .zr-emp-detail b{color:#232f3e;font-weight:600}
        .zr-filters{padding:14px 16px;margin-bottom:16px;background:#fff;border:1px solid #e8ecec;border-radius:12px;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
        .zr-filters label{font-weight:600;font-size:12px;color:#545b64;text-transform:uppercase;letter-spacing:.5px}
        .zr-filters input[type="date"],.zr-filters select{padding:6px 10px;border:1px solid #d5dbdb;border-radius:8px;font-size:13px;color:#16191f;background:#fff}
        .zr-time-sep{font-weight:700;color:#879596;font-size:14px}
        .zr-filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .zr-filter-row+.zr-filter-row{margin-top:8px;padding-top:8px;border-top:1px solid #e8ecec}
        .zr-filter-actions{display:flex;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid #e8ecec}
        .zr-apply-btn{padding:8px 20px;font-size:13px;font-weight:600;color:#fff;background:linear-gradient(135deg,#ff9900,#e88b00);border:none;border-radius:8px;cursor:pointer;box-shadow:0 2px 8px rgba(255,153,0,0.3);transition:all .15s}
        .zr-apply-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(255,153,0,0.4)}
        .zr-clear-btn{padding:8px 20px;font-size:13px;font-weight:600;color:#545b64;background:#fff;border:1px solid #d5dbdb;border-radius:8px;cursor:pointer}
        #zr-lenel-data{border:1px solid #e8ecec;border-radius:12px;overflow:hidden;background:#fff}
        .zr-table{width:100%;border-collapse:collapse;font-size:13px;color:#16191f}
        .zr-table th{padding:10px 16px;text-align:left;background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.6px;position:sticky;top:0;z-index:1;border-bottom:2px solid #ff9900}
        .zr-table td{padding:10px 16px;text-align:left;border-bottom:1px solid #f0f0f0}
        .zr-table tbody tr:nth-child(even){background:rgba(247,248,250,0.6)}
        .zr-table tbody tr:hover{background:rgba(255,153,0,0.03)}
        .zr-dir-in{color:#067d62;font-weight:700;font-size:12px;padding:3px 10px;background:rgba(6,125,98,0.08);border-radius:6px;display:inline-block}
        .zr-dir-out{color:#d13212;font-weight:700;font-size:12px;padding:3px 10px;background:rgba(209,50,18,0.08);border-radius:6px;display:inline-block}
        .zr-dir-unknown{color:#E67E22;font-weight:700;font-size:12px;padding:3px 10px;background:rgba(230,126,34,0.08);border-radius:6px;display:inline-block}
        .zr-modal-footer{padding:14px 24px;background:#fff;border-top:1px solid #e8ecec;display:flex;justify-content:space-between;align-items:center;border-radius:0 0 16px 16px}
        .zr-footer-info{font-size:11px;color:#879596}
        .zr-copy-btn{padding:8px 20px;font-size:13px;font-weight:600;color:#fff;background:linear-gradient(135deg,#0073bb,#005a9c);border:none;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(0,115,187,0.25);transition:all .15s}
        .zr-copy-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,115,187,0.35)}
        .zr-loading{display:flex;flex-direction:column;align-items:center;padding:40px 20px;gap:14px}
        .zr-spinner{width:32px;height:32px;border:3px solid #e8ecec;border-top-color:#ff9900;border-radius:50%;animation:zr-spin .7s linear infinite}
        @keyframes zr-spin{to{transform:rotate(360deg)}}
        .zr-loading-text{font-size:13px;color:#879596;font-weight:500}
        .zr-empty{display:flex;flex-direction:column;align-items:center;padding:40px 20px;gap:10px;color:#879596;text-align:center}
        .zr-error{display:flex;flex-direction:column;align-items:center;padding:30px 20px;gap:8px;color:#d13212;text-align:center}
        /* ============ STAFFING MODAL — MIDNIGHT TEAL ============ */
        #zra-staffing-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(2,6,12,0.7);backdrop-filter:blur(8px);z-index:99998;display:flex;align-items:center;justify-content:center;animation:zraFadeIn .2s ease-out}
        @keyframes zraFadeIn{from{opacity:0}to{opacity:1}}
        @keyframes zraSlideUp{from{opacity:0;transform:translateY(24px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
        @keyframes zraCardIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
        @keyframes zraPulseGlow{0%,100%{box-shadow:0 0 20px rgba(45,212,191,0.08)}50%{box-shadow:0 0 30px rgba(45,212,191,0.15)}}
        #zra-staffing-modal{background:linear-gradient(165deg,#060d17,#081420,#071018);border-radius:22px;width:940px;max-width:96vw;max-height:90vh;display:flex;flex-direction:column;color:#d0e8e4;font-family:'Segoe UI','Amazon Ember',Arial,sans-serif;font-size:13px;box-shadow:0 40px 100px rgba(0,0,0,0.85),0 0 0 1px rgba(45,212,191,0.08),0 0 60px rgba(45,212,191,0.03);animation:zraSlideUp .35s cubic-bezier(.34,1.56,.64,1);overflow:hidden}
        #zra-modal-header{background:linear-gradient(135deg,rgba(6,18,32,0.98),rgba(8,24,40,0.95));padding:18px 22px 14px;border-bottom:1px solid rgba(45,212,191,0.1);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
        #zra-modal-title{display:flex;align-items:center;gap:12px}
        #zra-modal-title .zra-title-icon{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#0d9488,#14b8a6);display:flex;align-items:center;justify-content:center;font-size:17px;box-shadow:0 4px 16px rgba(20,184,166,0.35),inset 0 1px 0 rgba(255,255,255,0.15)}
        #zra-modal-title h2{margin:0;font-size:17px;font-weight:700;color:#ccfbf1;letter-spacing:0.2px;text-shadow:0 0 20px rgba(45,212,191,0.15)}
        #zra-modal-title .zra-site-chip{background:rgba(45,212,191,0.08);border:1px solid rgba(45,212,191,0.2);color:#5eead4;font-size:11px;font-weight:700;padding:3px 12px;border-radius:20px;letter-spacing:0.5px}
        #zra-modal-close{width:32px;height:32px;border-radius:10px;border:none;background:rgba(248,113,113,0.08);color:#fca5a5;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
        #zra-modal-close:hover{background:rgba(248,113,113,0.2);color:#fecaca;transform:scale(1.1);box-shadow:0 0 12px rgba(248,113,113,0.15)}
        #zra-modal-controls{padding:14px 22px;background:rgba(255,255,255,0.01);border-bottom:1px solid rgba(255,255,255,0.04);display:flex;flex-direction:column;gap:10px;flex-shrink:0}
        .zra-time-row{display:flex;gap:8px;align-items:center}
        .zra-time-label{font-size:10px;color:rgba(94,234,212,0.5);white-space:nowrap;font-weight:700;text-transform:uppercase;letter-spacing:1px}
        .zra-input{padding:9px 14px;border-radius:10px;border:1px solid rgba(45,212,191,0.08);background:rgba(45,212,191,0.03);color:#d0e8e4;font-size:12px;flex:1;min-width:140px;transition:all .2s}
        .zra-input:focus{outline:none;border-color:rgba(45,212,191,0.35);background:rgba(45,212,191,0.06);box-shadow:0 0 16px rgba(45,212,191,0.1),0 0 0 3px rgba(45,212,191,0.04)}
        .zra-search-row{display:flex;gap:8px;align-items:center}
        .zra-search-wrap{flex:1;position:relative}
        .zra-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:13px;color:rgba(94,234,212,0.35);pointer-events:none}
        #zra-search-input{width:100%;padding:9px 14px 9px 34px;border-radius:10px;border:1px solid rgba(45,212,191,0.08);background:rgba(45,212,191,0.03);color:#d0e8e4;font-size:12px;box-sizing:border-box;transition:all .2s}
        #zra-search-input:focus{outline:none;border-color:rgba(45,212,191,0.35);box-shadow:0 0 16px rgba(45,212,191,0.1),0 0 0 3px rgba(45,212,191,0.04)}
        #zra-search-input::placeholder{color:rgba(94,234,212,0.25)}
        select.zra-input{flex:0;min-width:120px;cursor:pointer}
        .zra-btn{padding:9px 18px;border-radius:10px;border:none;font-weight:600;font-size:12px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:6px;transition:all .2s}
        .zra-btn:hover{transform:translateY(-1px)}.zra-btn:disabled{opacity:.3;cursor:not-allowed;transform:none}
        .zra-btn-search{background:linear-gradient(135deg,#0d9488,#14b8a6);color:#fff;box-shadow:0 4px 18px rgba(20,184,166,0.3),inset 0 1px 0 rgba(255,255,255,0.12)}
        .zra-btn-search:hover{box-shadow:0 6px 24px rgba(20,184,166,0.4);background:linear-gradient(135deg,#0f766e,#0d9488)}
        .zra-btn-export{background:0 0;color:#6ee7b7;border:1px solid rgba(110,231,183,0.25);border-radius:10px}
        .zra-btn-export:hover{background:rgba(110,231,183,0.06);border-color:rgba(110,231,183,0.4)}
        #zra-modal-filterbar{padding:10px 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.04);flex-shrink:0}
        .zra-filter-tabs{display:flex;gap:4px}
        .zra-tab{padding:6px 16px;border-radius:20px;border:1px solid rgba(45,212,191,0.06);background:0 0;color:rgba(94,234,212,0.4);font-size:11px;font-weight:500;cursor:pointer;transition:all .2s}
        .zra-tab:hover{color:#5eead4;border-color:rgba(45,212,191,0.2);background:rgba(45,212,191,0.04)}
        .zra-tab.active{background:linear-gradient(135deg,rgba(45,212,191,0.1),rgba(20,184,166,0.06));border-color:rgba(45,212,191,0.35);color:#5eead4;font-weight:600;box-shadow:0 0 14px rgba(45,212,191,0.08)}
        .zra-status-bar{font-size:11px;color:rgba(94,234,212,0.3);background:rgba(45,212,191,0.03);padding:4px 14px;border-radius:20px;border:1px solid rgba(45,212,191,0.06)}
        #zra-progress{margin:8px 22px;font-size:11px;color:#5eead4;text-align:center;padding:10px 16px;background:rgba(45,212,191,0.04);border:1px solid rgba(45,212,191,0.1);border-radius:12px;display:none;flex-shrink:0}
        .zra-prog-bar{height:3px;background:rgba(45,212,191,0.08);border-radius:2px;margin-top:6px;overflow:hidden}
        .zra-prog-fill{height:100%;background:linear-gradient(90deg,#0d9488,#2dd4bf,#5eead4);border-radius:2px;transition:width .3s ease;box-shadow:0 0 8px rgba(45,212,191,0.4)}
        #zra-staffing-results{overflow-y:auto;flex:1;padding:14px 22px;background:rgba(2,6,12,0.4)}
        #zra-staffing-results::-webkit-scrollbar{width:5px}
        #zra-staffing-results::-webkit-scrollbar-thumb{background:rgba(45,212,191,0.12);border-radius:3px}
        #zra-staffing-results::-webkit-scrollbar-thumb:hover{background:rgba(45,212,191,0.22)}
        .zra-card{background:linear-gradient(165deg,rgba(8,20,35,0.85),rgba(6,15,28,0.92));border-radius:16px;padding:16px 18px;margin-bottom:10px;border:1px solid rgba(45,212,191,0.05);box-shadow:0 4px 24px rgba(0,0,0,0.4);animation:zraCardIn .3s ease-out both;transition:all .25s cubic-bezier(.4,0,.2,1)}
        .zra-card:hover{border-color:rgba(45,212,191,0.18);transform:translateY(-2px);box-shadow:0 8px 36px rgba(0,0,0,0.5),0 0 24px rgba(45,212,191,0.04)}
        .zra-card-header{display:flex;align-items:center;gap:12px;margin-bottom:12px}
        .zra-avatar-wrap{width:50px;height:50px;border-radius:50%;flex-shrink:0;overflow:hidden;border:2px solid rgba(45,212,191,0.25);box-shadow:0 0 18px rgba(45,212,191,0.12);background:linear-gradient(135deg,#0a1f2e,#061520);display:flex;align-items:center;justify-content:center;transition:all .2s}
        .zra-card:hover .zra-avatar-wrap{border-color:rgba(45,212,191,0.4);box-shadow:0 0 24px rgba(45,212,191,0.18)}
        .zra-avatar-wrap img{width:100%;height:100%;object-fit:cover}
        .zra-avatar-initials{font-size:16px;font-weight:700;color:#5eead4;text-transform:uppercase}
        .zra-card-info{flex:1;min-width:0}
        .zra-card-name{font-weight:700;font-size:14px;color:#ccfbf1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .zra-card-login{font-size:11px;color:rgba(94,234,212,0.35);margin-top:2px;font-family:'Cascadia Code','Fira Code',monospace;letter-spacing:0.3px}
        .zra-badge-active{display:inline-flex;align-items:center;gap:4px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);color:#6ee7b7;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:600;margin-top:4px}
        .zra-badge-inactive{display:inline-flex;align-items:center;gap:4px;background:rgba(100,116,139,0.1);border:1px solid rgba(100,116,139,0.2);color:rgba(148,163,184,0.7);padding:2px 10px;border-radius:20px;font-size:10px;font-weight:600;margin-top:4px}
        .zra-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
        .zra-slot{border-radius:12px;padding:12px 14px;background:rgba(45,212,191,0.02);border:1px solid rgba(45,212,191,0.05);position:relative;transition:all .2s}
        .zra-slot:hover{background:rgba(45,212,191,0.05);border-color:rgba(45,212,191,0.12)}
        .zra-slot.slot-active{background:rgba(52,211,153,0.04);border-color:rgba(52,211,153,0.2);box-shadow:inset 0 0 12px rgba(52,211,153,0.03)}
        .zra-slot.slot-empty{opacity:.2;border-style:dashed}
        .zra-slot-num{position:absolute;top:8px;right:8px;font-size:9px;color:rgba(94,234,212,0.15);background:rgba(45,212,191,0.04);padding:1px 7px;border-radius:10px;font-weight:600}
        .zra-slot-label{font-size:9px;color:rgba(94,234,212,0.35);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;font-weight:700}
        .zra-slot-location{font-size:20px;font-weight:800;color:#2dd4bf;margin-bottom:6px;line-height:1.1}
        .zra-slot.slot-active .zra-slot-location{color:#6ee7b7;text-shadow:0 0 16px rgba(110,231,183,0.15)}
        .zra-slot-location.empty-loc{font-size:13px;font-weight:400;color:rgba(45,212,191,0.15)}
        .zra-slot-meta{display:flex;flex-direction:column;gap:3px;font-size:11px}
        .zra-slot-meta-row{display:flex;gap:5px;align-items:flex-start}
        .zra-slot-meta-row label{color:rgba(94,234,212,0.25);min-width:62px;flex-shrink:0;font-size:10px;padding-top:1px}
        .zra-slot-meta-row span{color:rgba(208,232,228,0.6)}
        .zra-slot-still-active{font-size:10px;color:#34d399;margin-top:2px;display:flex;align-items:center;gap:4px;font-weight:500}
        .zra-no-results{text-align:center;color:rgba(94,234,212,0.3);padding:50px 20px;font-size:14px;line-height:1.6}
        .zra-no-results .zra-empty-icon{font-size:40px;margin-bottom:12px;filter:drop-shadow(0 0 8px rgba(45,212,191,0.2))}
    `);

    // ==========================================================
    //  SECTION 4 — SHARED HELPERS
    // ==========================================================
    function toast(type, msg) {
        const c = document.getElementById('lt-toast-container'); if (!c) return;
        const t = document.createElement('div'); t.className = `lt-toast ${type}`; t.textContent = msg;
        c.appendChild(t); setTimeout(() => t.remove(), 3000);
    }
    function storeBadgeData(login, badgeId, employeeId) { badgeDataStore.set(login, { badgeId, employeeId, timestamp: Date.now() }); }
    function getBadgeData(login) { return badgeDataStore.get(login); }
    function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // Place a panel beside the toolbar's current location (flips to the left edge if no room)
    function zruPositionPanel(panel) {
        const tb = document.getElementById('zru-toolbar'); if (!tb || !panel) return;
        const r = tb.getBoundingClientRect();
        const pw = panel.offsetWidth || 320, ph = panel.offsetHeight || 400;
        let x = r.right + 12;
        if (x + pw > window.innerWidth - 8) x = Math.max(8, r.left - 12 - pw);
        const y = Math.min(Math.max(r.bottom - ph, 8), Math.max(8, window.innerHeight - ph - 8));
        panel.style.left = x + 'px'; panel.style.top = y + 'px'; panel.style.bottom = 'auto'; panel.style.right = 'auto';
    }
    function zruRepositionOpenPanels() {
        ['lt-area-panel','lt-list-panel'].forEach(id => { const p = document.getElementById(id); if (p && p.classList.contains('open')) zruPositionPanel(p); });
    }
    // Generic Alt+Click drag for any fixed-position element
    function zruMakeAltDraggable(el, opts) {
        opts = opts || {};
        let dragging = false, offX = 0, offY = 0;
        el.addEventListener('mousedown', e => {
            if (!e.altKey) return;
            e.preventDefault(); e.stopPropagation();
            const r = el.getBoundingClientRect();
            offX = e.clientX - r.left; offY = e.clientY - r.top;
            dragging = true; el.style.transition = 'none'; el.style.cursor = 'grabbing';
        }, true);
        // Alt+Click is reserved for moving — swallow it so buttons don't fire
        el.addEventListener('click', e => { if (e.altKey || dragging) { e.preventDefault(); e.stopPropagation(); } }, true);
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            e.preventDefault();
            const x = Math.min(Math.max(e.clientX - offX, 0), window.innerWidth - el.offsetWidth);
            const y = Math.min(Math.max(e.clientY - offY, 0), window.innerHeight - el.offsetHeight);
            el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.bottom = 'auto'; el.style.right = 'auto';
            if (opts.onMove) opts.onMove(el);
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false; el.style.transition = ''; el.style.cursor = '';
            if (opts.onDrop) opts.onDrop(el);
        });
    }

    // ==========================================================
    //  SECTION 5 — BUILD LEFT TOOLBAR + ALL PANELS
    // ==========================================================
    function buildUI() {
        // Toast container
        const tc = document.createElement('div'); tc.id = 'lt-toast-container'; document.body.appendChild(tc);

        // === LEFT TOOLBAR ===
        const tb = document.createElement('div'); tb.id = 'zru-toolbar';
        tb.innerHTML = `
            <div class="zru-collapse-row"><span class="zru-suite-label">SUITE</span><button class="zru-collapse-btn" id="zru-collapse" title="Hide toolbar">\u2715</button></div>
            <div class="zru-section">
                <div class="zru-section-label">Tools</div>
                <button class="zru-btn" id="zru-staffing-btn"><span class="zru-icon">\ud83d\udccb</span><span class="zru-label">Staffing</span></button>
            </div>
            <div class="zru-section">
                <div class="zru-section-label">Click Name \u2192</div>
                <button class="zru-btn zru-link-btn active" data-link="timecard"><span class="zru-icon">\ud83d\udd52</span><span class="zru-label">Timecard</span></button>
                <button class="zru-btn zru-link-btn" data-link="simba"><span class="zru-icon">\ud83d\udcca</span><span class="zru-label">SIMBA</span></button>
                <div class="zru-link-status" id="zru-link-status">Click name \u2192 Timecard</div>
            </div>
        `;
        // Labor Tracker FAB at bottom
        const fab = document.createElement('button'); fab.id = 'lt-fab';
        fab.innerHTML = '<span class="lt-conn-dot"></span><span>\u23f1 Labor Track</span><span class="lt-count">0</span>';
        fab.addEventListener('click', handleFabClick);
        fab.addEventListener('contextmenu', e => { e.preventDefault(); toggleListPanel(); });
        tb.appendChild(fab);
        document.body.appendChild(tb);

        // === ALT+CLICK DRAG — hold Alt and drag the toolbar anywhere; open panels follow ===
        tb.title = 'Alt + Click to move';
        const savedPos = (function(){ try { return JSON.parse(GM_getValue('zru_toolbar_pos', 'null')); } catch(e) { return null; } })();
        if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
            tb.style.left = Math.min(Math.max(savedPos.left, 0), window.innerWidth - tb.offsetWidth) + 'px';
            tb.style.top = Math.min(Math.max(savedPos.top, 0), window.innerHeight - tb.offsetHeight) + 'px';
            tb.style.bottom = 'auto';
        }
        zruMakeAltDraggable(tb, {
            onMove: zruRepositionOpenPanels,
            onDrop: () => GM_setValue('zru_toolbar_pos', JSON.stringify({ left: tb.offsetLeft, top: tb.offsetTop }))
        });

        // === TOOLBAR TOGGLE PILL (shows when collapsed) ===
        const togglePill = document.createElement('div'); togglePill.id = 'zru-toolbar-toggle'; togglePill.title = 'Show toolbar';
        togglePill.innerHTML = '\u2630';
        document.body.appendChild(togglePill);

        // Wire collapse / expand
        document.getElementById('zru-collapse').addEventListener('click', () => {
            tb.classList.add('collapsed'); togglePill.classList.add('show');
        });
        togglePill.addEventListener('click', () => {
            tb.classList.remove('collapsed'); togglePill.classList.remove('show');
        });

        // Wire link buttons
        tb.querySelectorAll('.zru-link-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                tb.querySelectorAll('.zru-link-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedLinkType = btn.dataset.link;
                const labels = { timecard:'Timecard', simba:'SIMBA' };
                document.getElementById('zru-link-status').textContent = `Click name \u2192 ${labels[selectedLinkType]}`;
            });
        });

        // Wire staffing button
        document.getElementById('zru-staffing-btn').addEventListener('click', openStaffingModal);

        // === LT AREA PANEL ===
        const ap = document.createElement('div'); ap.id = 'lt-area-panel'; document.body.appendChild(ap);
        zruMakeAltDraggable(ap);

        // === LT LIST PANEL ===
        const lp = document.createElement('div'); lp.id = 'lt-list-panel';
        lp.innerHTML = '<div id="lt-list-header"><span>\ud83d\udccb Tracked This Session</span><button id="lt-clear-all">Clear</button></div><div id="lt-list-body"><div class="lt-list-empty">No badges tracked yet</div></div>';
        document.body.appendChild(lp);
        zruMakeAltDraggable(lp);
        document.getElementById('lt-clear-all').addEventListener('click', ltClearAll);

        // Card click handler for labor tracking
        document.addEventListener('click', handleLTCardClick, true);
    }

    // ==========================================================
    //  SECTION 6 — LABOR TRACKER LOGIC
    // ==========================================================
    function handleFabClick() {
        if (!ltTrackingMode) { ltShowAreaList(); return; }
        var panel = document.getElementById('lt-area-panel');
        if (!panel.classList.contains('open')) { ltShowAreaList(); }
        else { ltDeactivate(); }
    }

    function ltDeactivate() {
        ltTrackingMode=false; ltActiveCalmCode=null; ltActiveCalmLabel=''; ltActiveArea=''; ltActiveSubArea=''; ltSessionReady=false;
        ltPanelLevel='closed';
        document.getElementById('lt-fab').classList.remove('active');
        document.body.classList.remove('lt-tracking-mode');
        ltUpdateConnDot(''); ltClosePanels(); ltUpdateFabLabel('\u23f1 Labor Track');
        toast('info','\u23f1 Labor tracking OFF');
    }
    function ltActivate(code, label, area, subArea) {
        ltActiveCalmCode=code; ltActiveCalmLabel=label; ltActiveArea=area; ltActiveSubArea=subArea; ltTrackingMode=true;
        ltPanelLevel='closed';
        document.getElementById('lt-fab').classList.add('active');
        document.body.classList.add('lt-tracking-mode');
        ltUpdateFabLabel(`\u23f1 ${code} \u2014 ${label}`); ltClosePanels();
        toast('success',`Tracking with ${code} (${label}) \u2014 ${area} \u203a ${subArea}`);
        ltInitSession();
    }

    function ltUpdateFabLabel(text) {
        const fab=document.getElementById('lt-fab');
        const dot=fab.querySelector('.lt-conn-dot').outerHTML;
        const count=fab.querySelector('.lt-count').outerHTML;
        fab.innerHTML=`${dot}<span>${text}</span>${count}<span class="lt-close" title="Stop tracking">\u2715</span>`;
        fab.querySelector('.lt-close').addEventListener('click',function(e){e.stopPropagation();ltDeactivate();});
    }

    function ltShowAreaList() {
        var panel=document.getElementById('lt-area-panel');
        var wasOpen=panel.classList.contains('open');
        panel.classList.add('open');
        ltPanelLevel='codes';
        var codesHtml = LT_CODES.map(function(c){ return '<button class="lt-code-btn '+(ltActiveCalmCode===c?'selected':'')+'" data-code="'+c+'"><span class="lt-code-id">'+c+'</span><span class="lt-code-check">\u2713</span></button>'; }).join('');
        if (!codesHtml) codesHtml = '<div style="color:#888;font-size:11px;text-align:center;padding:16px;">No codes yet. Type below and press +</div>';
        panel.innerHTML='<div class="lt-panel-header"><h3>\u23f1 My Codes</h3><button class="lt-panel-close" id="lt-panel-x">\u2715</button></div><div id="lt-active-bar" class="'+(ltActiveCalmCode?'show':'')+'"><span>Active:</span><span class="lt-active-code">'+(ltActiveCalmCode||'')+'</span></div><div class="lt-panel-body" id="lt-panel-content">'+codesHtml+'</div><div style="padding:8px 12px;border-top:1px solid #333;display:flex;gap:6px;"><input id="lt-new-code-input" placeholder="CALM code" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid #444;background:#1a1a2e;color:#fff;font-size:12px;text-transform:uppercase;font-weight:600;"><button id="lt-add-code-btn" style="padding:6px 12px;border-radius:6px;border:none;background:#4CAF50;color:#fff;font-weight:700;font-size:13px;cursor:pointer;">+</button></div>';
        document.getElementById('lt-panel-x').addEventListener('click', ltClosePanels);
        document.getElementById('lt-add-code-btn').addEventListener('click', ltAddCode);
        document.getElementById('lt-new-code-input').addEventListener('keydown', function(e){ if(e.key==='Enter') ltAddCode(); });
        panel.querySelectorAll('.lt-code-btn').forEach(function(btn){
            btn.addEventListener('click', function(){ ltActivate(btn.dataset.code, btn.dataset.code, 'Custom', 'Custom'); });
            btn.addEventListener('contextmenu', function(e){ e.preventDefault(); ltRemoveCode(btn.dataset.code); });
        });
        if(!wasOpen) zruPositionPanel(panel);
    }

    function ltAddCode() {
        var input = document.getElementById('lt-new-code-input');
        var code = (input.value||'').trim().toUpperCase();
        if (!code) return;
        if (LT_CODES.indexOf(code) !== -1) { toast('error', code+' already exists'); return; }
        LT_CODES.push(code);
        ltSaveCodes();
        toast('success', '\u2713 Added '+code);
        ltShowAreaList();
    }

    function ltRemoveCode(code) {
        LT_CODES = LT_CODES.filter(function(c){ return c !== code; });
        ltSaveCodes();
        toast('info', 'Removed '+code);
        ltShowAreaList();
    }

    function ltShowAllAreas() { ltShowAreaList(); }
    function ltShowSubAreas() { ltShowAreaList(); }
    function ltShowCodes() { ltShowAreaList(); }

    function ltClosePanels() { document.getElementById('lt-area-panel').classList.remove('open'); ltPanelLevel='closed'; }
    function toggleListPanel() { var p=document.getElementById('lt-list-panel'); p.classList.toggle('open'); if(p.classList.contains('open')) zruPositionPanel(p); }

    function handleLTCardClick(e) {
        if(!ltTrackingMode||!ltActiveCalmCode) return;
        const card=e.target.closest('.new-associate-card, .associate-card'); if(!card) return;
        if(e.target.closest('.quick-remove-btn')) return;
        const badgeId=card.getAttribute('data-badge-id'); if(!badgeId||ltProcessing.has(badgeId)) return;
        e.preventDefault(); e.stopPropagation();
        const name=card.getAttribute('data-employee-f-name')||'Unknown';
        const login=card.getAttribute('data-user-id')||'';
        ltProcessing.add(badgeId); card.classList.add('lt-tracking'); ltAddBadgeIndicator(card,'pending','\u23f3');
        ltTrackBadge(badgeId,name,login,card);
    }

    function ltInitSession() {
        ltUpdateConnDot('yellow');
        GM_xmlhttpRequest({ method:'GET', url:KIOSK_URL, headers:{'Accept':'text/html,application/xhtml+xml'},
            onload:r=>{ if(r.status===200) ltSubmitCalmCode(r.responseText); else { ltUpdateConnDot('red'); toast('error',`FCMenu error (${r.status})`); } },
            onerror:()=>{ ltUpdateConnDot('red'); toast('error','Cannot reach FCMenu'); }
        });
    }

    function ltSubmitCalmCode(pageHtml) {
        let formData=`calmCode=${encodeURIComponent(ltActiveCalmCode)}`;
        const doc=new DOMParser().parseFromString(pageHtml,'text/html'); const form=doc.querySelector('form');
        if(form) form.querySelectorAll('input[type="hidden"]').forEach(inp=>{ if(inp.name) formData+=`&${encodeURIComponent(inp.name)}=${encodeURIComponent(inp.value||'')}`; });
        GM_xmlhttpRequest({ method:'POST', url:KIOSK_URL, headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'text/html,application/xhtml+xml','Referer':KIOSK_URL}, data:formData,
            onload:r=>{ if(r.status===200){ if(r.responseText.includes('trackingBadgeId')||!r.responseText.includes('calmCode')){ ltSessionReady=true; ltUpdateConnDot('green'); } else ltTryAlternateSubmit(r.responseText); } else ltUpdateConnDot('red'); },
            onerror:()=>{ ltUpdateConnDot('red'); toast('error','Failed to submit CALM code'); }
        });
    }

    function ltTryAlternateSubmit(pageHtml) {
        const doc=new DOMParser().parseFromString(pageHtml,'text/html'); const form=doc.querySelector('form');
        let formData=`calmCode=${encodeURIComponent(ltActiveCalmCode)}`;
        if(form) form.querySelectorAll('input[type="hidden"]').forEach(inp=>{ if(inp.name) formData+=`&${encodeURIComponent(inp.name)}=${encodeURIComponent(inp.value||'')}`; });
        const actionUrl=form&&form.action?form.action:KIOSK_URL;
        const fullUrl=actionUrl.startsWith('http')?actionUrl:FCMENU_BASE+(actionUrl.startsWith('/')?'':'/')+actionUrl;
        GM_xmlhttpRequest({ method:'POST', url:fullUrl, headers:{'Content-Type':'application/x-www-form-urlencoded','Referer':KIOSK_URL}, data:formData,
            onload:()=>{ ltSessionReady=true; ltUpdateConnDot('green'); },
            onerror:()=>{ ltSessionReady=true; ltUpdateConnDot('yellow'); }
        });
    }

    function ltTrackBadge(badgeId, name, login, card) {
        if(!ltSessionReady){ ltInitSession(); setTimeout(()=>ltTrackBadge(badgeId,name,login,card),3000); return; }
        GM_xmlhttpRequest({ method:'POST', url:KIOSK_URL,
            headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'text/html,application/xhtml+xml','Referer':KIOSK_URL},
            data:`calmCode=${encodeURIComponent(ltActiveCalmCode)}&trackingBadgeId=${encodeURIComponent(badgeId)}`,
            onload:r=>{ ltProcessing.delete(badgeId); card.classList.remove('lt-tracking');
                const success=r.status===200&&ltParseResponse(r.responseText,badgeId);
                if(success){ card.classList.add('lt-tracked'); ltAddBadgeIndicator(card,'ok','\u2713'); toast('success',`\u2713 ${name} (${login}) \u2192 ${ltActiveCalmCode}`); ltRecordBadge(badgeId,name,login,true); }
                else { card.classList.add('lt-track-failed'); ltAddBadgeIndicator(card,'fail','\u2717'); toast('error',`\u2717 ${name} \u2014 tracking failed`); ltRecordBadge(badgeId,name,login,false); }
                setTimeout(()=>card.classList.remove('lt-tracked','lt-track-failed'),5000); ltUpdateCount();
            },
            onerror:()=>{ ltProcessing.delete(badgeId); card.classList.remove('lt-tracking'); card.classList.add('lt-track-failed'); ltAddBadgeIndicator(card,'fail','\u2717'); toast('error',`\u2717 ${name} \u2014 network error`); ltRecordBadge(badgeId,name,login,false); ltUpdateCount(); }
        });
    }

    function ltParseResponse(html, badgeId) {
        if(html.includes('trackingBadgeId')) return true;
        if(html.includes(badgeId)) return true;
        if(html.includes('calmCode')&&!html.includes('trackingBadgeId')){ ltSessionReady=false; ltUpdateConnDot('yellow'); ltInitSession(); return false; }
        return true;
    }

    function ltAddBadgeIndicator(card, cls, icon) {
        const existing=card.querySelector('.lt-badge-indicator'); if(existing) existing.remove();
        if(getComputedStyle(card).position==='static') card.style.position='relative';
        const ind=document.createElement('div'); ind.className=`lt-badge-indicator ${cls}`; ind.textContent=icon; card.appendChild(ind);
    }
    function ltUpdateConnDot(color) { const d=document.querySelector('#lt-fab .lt-conn-dot'); if(d) d.className=`lt-conn-dot ${color}`; }
    function ltUpdateCount() { const el=document.querySelector('#lt-fab .lt-count'); if(el) el.textContent=[...ltTrackedBadges.values()].filter(b=>b.status).length; }
    function ltRecordBadge(badgeId,name,login,status) {
        const time=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        ltTrackedBadges.set(badgeId,{name,login,time,status,code:ltActiveCalmCode}); ltRenderList();
    }
    function ltRenderList() {
        const body=document.getElementById('lt-list-body'); if(!body) return;
        if(ltTrackedBadges.size===0){ body.innerHTML='<div class="lt-list-empty">No badges tracked yet</div>'; return; }
        body.innerHTML=[...ltTrackedBadges.entries()].reverse().map(([id,b])=>`<div class="lt-list-entry"><span class="lt-le-status ${b.status?'ok':'fail'}"></span><span class="lt-le-name">${b.name}</span><span class="lt-le-code">${b.code}</span><span class="lt-le-time">${b.time}</span></div>`).join('');
    }
    function ltClearAll() {
        ltTrackedBadges.clear(); ltProcessing.clear(); ltRenderList(); ltUpdateCount();
        document.querySelectorAll('.lt-badge-indicator').forEach(el=>el.remove());
        document.querySelectorAll('.lt-tracked,.lt-track-failed').forEach(el=>el.classList.remove('lt-tracked','lt-track-failed'));
        toast('info','Tracking list cleared');
    }


    // ==========================================================
    //  SECTION 7 — BARCODE (JsBarcode)
    // ==========================================================
    function generateBarcode(badgeId) {
        const canvas=document.createElement('canvas');
        const iv=setInterval(()=>{ if(typeof JsBarcode!=='undefined'){ clearInterval(iv); try{JsBarcode(canvas,badgeId,{format:"CODE128",width:2,height:60,displayValue:false,margin:10,background:"#ffffff"});}catch(e){} }},100);
        return canvas;
    }

    function addBarcodeToCards() {
        document.querySelectorAll('.new-associate-photo').forEach(photoEl=>{
            if(photoEl.hasAttribute('data-barcode-enabled')) return;
            photoEl.setAttribute('data-barcode-enabled','true');
            const card=photoEl.closest('.new-associate-card'); if(!card) return;
            const badgeId=card.getAttribute('data-badge-id'); const login=card.getAttribute('data-user-id'); if(!badgeId) return;
            const employeeId=card.getAttribute('data-employee-id');
            if(login) storeBadgeData(login,badgeId,employeeId);
            const overlay=document.createElement('div'); overlay.className='zone-ra-barcode-overlay';
            overlay.style.cssText='position:fixed;background:#fff;border:3px solid #ff9900;border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,0.3);z-index:10000;display:none;flex-direction:column;align-items:center;gap:15px;cursor:pointer;pointer-events:auto;';
            const bc=generateBarcode(badgeId); bc.style.cssText='border:1px solid #ddd;border-radius:4px;';
            const info=document.createElement('div'); info.style.cssText='font-family:"Segoe UI",sans-serif;font-size:16px;font-weight:bold;color:#232f3e;text-align:center;user-select:all;'; info.textContent=badgeId;
            const hint=document.createElement('div'); hint.style.cssText='font-size:12px;color:#666;text-align:center;'; hint.textContent='Click to copy Badge ID';
            overlay.addEventListener('click',e=>{e.stopPropagation(); navigator.clipboard.writeText(badgeId).then(()=>{ overlay.style.border='3px solid #00aa00'; hint.textContent='\u2713 Copied!'; hint.style.color='#00aa00'; setTimeout(()=>{overlay.style.border='3px solid #ff9900';hint.textContent='Click to copy Badge ID';hint.style.color='#666';},1500); }); });
            overlay.appendChild(bc); overlay.appendChild(info); overlay.appendChild(hint); document.body.appendChild(overlay);
            let hoverTimeout;
            photoEl.addEventListener('mouseenter',()=>{ hoverTimeout=setTimeout(()=>{ const rect=photoEl.getBoundingClientRect(); overlay.style.left=`${rect.left+(rect.width/2)}px`; overlay.style.top=`${rect.top-10}px`; overlay.style.transform='translate(-50%,-100%)'; overlay.style.display='flex'; },300); });
            photoEl.addEventListener('mouseleave',()=>{ clearTimeout(hoverTimeout); setTimeout(()=>{ if(!overlay.matches(':hover')) overlay.style.display='none'; },200); });
            overlay.addEventListener('mouseenter',function(){this.style.display='flex';});
            overlay.addEventListener('mouseleave',function(){this.style.display='none';});
            photoEl.style.cursor='pointer'; photoEl.style.transition='all 0.3s'; photoEl.title='Hover to show barcode';
            photoEl.addEventListener('mouseenter',function(){this.style.transform='scale(1.05)';this.style.boxShadow='0 4px 12px rgba(255,153,0,0.4)';});
            photoEl.addEventListener('mouseleave',function(){this.style.transform='scale(1)';this.style.boxShadow='';});
        });
    }

    // ==========================================================
    //  SECTION 8 — ENHANCE ASSOCIATE CARDS
    // ==========================================================
    function enhanceAssociateCards() {
        document.querySelectorAll('.new-associate-card.associate-card').forEach(card=>{
            const login=card.getAttribute('data-user-id'); const nameDiv=card.querySelector('.new-associate-name');
            if(!login||!nameDiv) return;
            const employeeId=card.getAttribute('data-employee-id'); const badgeId=card.getAttribute('data-badge-id');
            if(badgeId) storeBadgeData(login,badgeId,employeeId);

            // Quick remove button
            if(!card.querySelector('.quick-remove-btn')){
                const qr=document.createElement('button'); qr.textContent='\u00d7'; qr.className='quick-remove-btn'; qr.title='Remove this associate';
                qr.style.cssText='position:absolute!important;top:5px!important;right:5px!important;width:24px!important;height:24px!important;padding:0!important;background:linear-gradient(135deg,#3498db,#2980b9)!important;color:#fff!important;border:none!important;border-radius:50%!important;font-weight:bold!important;font-size:18px!important;cursor:pointer!important;transition:all .3s!important;box-shadow:0 2px 4px rgba(0,0,0,0.2)!important;display:flex!important;align-items:center!important;justify-content:center!important;line-height:1!important;z-index:100!important;opacity:.7!important;';
                qr.onmouseenter=()=>{qr.style.transform='scale(1.15) rotate(90deg)';qr.style.opacity='1';};
                qr.onmouseleave=()=>{qr.style.transform='scale(1) rotate(0deg)';qr.style.opacity='0.7';};
                qr.onclick=e=>{e.stopPropagation();e.preventDefault(); const sp=window.scrollY; card.click(); setTimeout(()=>{const rb=document.querySelector('#removeAssociateBtnV2');if(rb){rb.click();setTimeout(()=>window.scrollTo(0,sp),100);}},500);};
                if(getComputedStyle(card).position==='static') card.style.position='relative';
                card.appendChild(qr);
            }

            // Make name clickable for links
            if(!nameDiv.classList.contains('link-enabled')){
                nameDiv.classList.add('link-enabled'); nameDiv.style.cursor='pointer'; nameDiv.style.transition='all 0.2s';
                nameDiv.addEventListener('mouseenter',function(){this.style.color='#2D9CDB';this.style.textDecoration='underline';this.style.transform='scale(1.02)';});
                nameDiv.addEventListener('mouseleave',function(){this.style.color='';this.style.textDecoration='none';this.style.transform='scale(1)';});
                nameDiv.addEventListener('click',function(e){
                    e.stopPropagation();
                    const sd=getBadgeData(login); const useEmpId=sd?.employeeId||employeeId; const useBadge=sd?.badgeId||badgeId;
                    if(selectedLinkType==='timecard'&&useEmpId) window.open(`https://fclm-portal.amazon.com/employee/timeDetails?employeeId=${useEmpId}`,'_blank');
                    else if(selectedLinkType==='simba'){ GM_setValue('simba_login',login); window.open(`https://durable.corp.amazon.com/${SITE.toUpperCase()}/simba/audits/new_audit?fc_type=${SITE.toUpperCase()}`, '_blank'); }
                    else if(selectedLinkType==='timehub'&&login) window.open(`https://atoz.amazon.work/timecard/managerView/employeeDetails/${login}`,'_blank');
                    else if(selectedLinkType==='lenel'&&useEmpId){ const empName=card.getAttribute('data-employee-f-name')||login; openLenelForEmployee(login,useEmpId,useBadge,empName); }
                });
            }

            // Login display
            if(!card.querySelector('.login-display')){
                const ld=document.createElement('div'); ld.className='login-display'; ld.textContent=login;
                ld.style.cssText='font-size:11px!important;color:#ff9900!important;margin-top:2px!important;cursor:pointer!important;padding:3px 6px!important;background:#f0f0f0!important;border-radius:4px!important;transition:all .2s!important;user-select:all!important;border:1px solid transparent!important;';
                ld.addEventListener('mouseenter',function(){this.style.background='#e8f4f8';this.style.color='#232f3e';this.style.borderColor='#ff9900';});
                ld.addEventListener('mouseleave',function(){this.style.background='#f0f0f0';this.style.color='#ff9900';this.style.borderColor='transparent';});
                ld.addEventListener('click',function(e){e.stopPropagation(); navigator.clipboard.writeText(login).then(()=>{const ot=this.textContent;this.style.background='#00aa00';this.style.color='#fff';this.textContent='\u2713 Copied!';setTimeout(()=>{this.style.background='#f0f0f0';this.style.color='#ff9900';this.textContent=ot;},1000);}); });
                nameDiv.parentNode.insertBefore(ld,nameDiv.nextSibling);
            }
        });
    }

    // ==========================================================
    //  SECTION 9 — LENEL
    // ==========================================================
    function getTimezoneOffset(){const o=new Date().getTimezoneOffset();const s=o<=0?'+':'-';const a=Math.abs(o);return`${s}${String(Math.floor(a/60)).padStart(2,'0')}:${String(a%60).padStart(2,'0')}`;}
    function formatWithOffset(utcMs,off){const m=off.match(/^([+-])(\d{2}):(\d{2})$/);if(!m)return new Date(utcMs).toISOString();const sign=m[1]==='+'?1:-1;const offMs=sign*(parseInt(m[2],10)*60+parseInt(m[3],10))*60000;const l=new Date(utcMs+offMs);const p=(n,len=2)=>String(n).padStart(len,'0');return`${l.getUTCFullYear()}-${p(l.getUTCMonth()+1)}-${p(l.getUTCDate())}T${p(l.getUTCHours())}:${p(l.getUTCMinutes())}:${p(l.getUTCSeconds())}.${p(l.getUTCMilliseconds(),3)}${off}`;}
    function localPartsToUTCMs(y,mo,d,h,mi,s,ms,off){const m=off.match(/^([+-])(\d{2}):(\d{2})$/);const loc=Date.UTC(y,mo-1,d,h,mi,s,ms);if(!m)return loc;const sign=m[1]==='+'?1:-1;return loc-sign*(parseInt(m[2],10)*60+parseInt(m[3],10))*60000;}
    function getTodayRange(){const tz=getTimezoneOffset();const n=new Date();const sMs=localPartsToUTCMs(n.getFullYear(),n.getMonth()+1,n.getDate(),0,0,0,0,tz);const eMs=localPartsToUTCMs(n.getFullYear(),n.getMonth()+1,n.getDate(),23,59,59,999,tz);return{startDateTime:formatWithOffset(sMs,tz),endDateTime:formatWithOffset(eMs,tz)};}
    function getSiteId(){const urlMatch=window.location.href.match(/[?&/](site|node|warehouse|fc)[=\/]([A-Z]{3}\d{1,2})/i);if(urlMatch)return urlMatch[2].toUpperCase();const headers=document.querySelectorAll('h1,h2,h3,.header,.site-header');for(const h of headers){const m=h.textContent.match(/\b([A-Z]{3}\d{1,2})\b/);if(m)return m[1];}const tm=document.title.match(/\b([A-Z]{3}\d{1,2})\b/);if(tm)return tm[1];return null;}
    function hourOptions(sel){return Array.from({length:24},(_,i)=>`<option value="${i}"${i===sel?' selected':''}>${String(i).padStart(2,'0')}</option>`).join('');}
    function minuteOptions(sel){return[0,15,30,45].map(m=>`<option value="${m}"${m===sel?' selected':''}>${String(m).padStart(2,'0')}</option>`).join('');}

    function createLenelModal(){
        if(document.getElementById('zr-lenel-modal'))return;
        const tz=getTimezoneOffset();
        document.body.insertAdjacentHTML('beforeend',`<div id="zr-lenel-modal"><div class="zr-modal-content"><div class="zr-modal-header"><h2>\ud83d\udd12 Lenel Activity</h2><span class="zr-modal-close">&times;</span></div><div class="zr-modal-body"><div id="zr-emp-banner" class="zr-employee-banner" style="display:none;"></div><div class="zr-filters"><div class="zr-filter-row"><label>Start</label><input type="date" id="zr_start_date"><select id="zr_start_hour">${hourOptions(0)}</select><span class="zr-time-sep">:</span><select id="zr_start_min">${minuteOptions(0)}</select></div><div class="zr-filter-row"><label>End</label><input type="date" id="zr_end_date"><select id="zr_end_hour">${hourOptions(23)}</select><span class="zr-time-sep">:</span><select id="zr_end_min">${minuteOptions(45)}</select></div><div class="zr-filter-actions"><button id="zr-apply-btn" class="zr-apply-btn">Apply Filter</button><button id="zr-clear-btn" class="zr-clear-btn">Clear</button></div></div><div id="zr-lenel-data"></div></div><div class="zr-modal-footer"><span class="zr-footer-info">Timezone: ${tz}</span><button id="zr-copy-btn" class="zr-copy-btn">\ud83d\udccb Copy Table</button></div></div></div>`);
        const modal=document.getElementById('zr-lenel-modal');
        modal.querySelector('.zr-modal-close').onclick=()=>modal.style.display='none';
        modal.addEventListener('click',e=>{if(e.target===modal)modal.style.display='none';});
        document.getElementById('zr-copy-btn').onclick=copyLenelTable;
        document.getElementById('zr-clear-btn').onclick=()=>{document.getElementById('zr_start_date').value='';document.getElementById('zr_end_date').value='';document.getElementById('zr_start_hour').value='0';document.getElementById('zr_start_min').value='0';document.getElementById('zr_end_hour').value='23';document.getElementById('zr_end_min').value='45';};
    }

    function populateLenelDates(sDT,eDT){
        const p=dt=>dt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
        const s=p(sDT);if(s){document.getElementById('zr_start_date').value=`${s[1]}-${s[2]}-${s[3]}`;document.getElementById('zr_start_hour').value=parseInt(s[4],10);document.getElementById('zr_start_min').value=parseInt(s[5],10);}
        const e=p(eDT);if(e){let ed=`${e[1]}-${e[2]}-${e[3]}`,eh=parseInt(e[4],10),em=parseInt(e[5],10);if(parseInt(e[6],10)===59&&parseInt(e[7],10)===999){em++;if(em>=60){em=0;eh++;}if(eh>=24){eh=0;const d2=new Date(ed+'T12:00:00');d2.setDate(d2.getDate()+1);ed=d2.toISOString().split('T')[0];}}document.getElementById('zr_end_date').value=ed;document.getElementById('zr_end_hour').value=eh;document.getElementById('zr_end_min').value=em;}
    }

    function getLenelModalDateRange(){
        const tz=getTimezoneOffset();const sd=document.getElementById('zr_start_date'),ed=document.getElementById('zr_end_date');
        if(!sd?.value||!ed?.value)return null;
        const sp=sd.value.split('-').map(Number),ep=ed.value.split('-').map(Number);if(sp.length!==3||ep.length!==3)return null;
        const sH=parseInt(document.getElementById('zr_start_hour')?.value||'0',10),sM=parseInt(document.getElementById('zr_start_min')?.value||'0',10);
        const eH=parseInt(document.getElementById('zr_end_hour')?.value||'23',10),eM=parseInt(document.getElementById('zr_end_min')?.value||'59',10);
        const sMs=localPartsToUTCMs(sp[0],sp[1],sp[2],sH,sM,0,0,tz),eMs=localPartsToUTCMs(ep[0],ep[1],ep[2],eH,eM,0,0,tz);
        return{startDateTime:formatWithOffset(sMs,tz),endDateTime:formatWithOffset(eMs-1,tz)};
    }

    function fetchLenel(employeeId,siteId,empInfo,retryCount){
        retryCount=retryCount||0;const modal=document.getElementById('zr-lenel-modal');const dc=document.getElementById('zr-lenel-data');if(!modal||!dc)return;
        currentLenelEmployee={employeeId,siteId,empInfo};
        const banner=document.getElementById('zr-emp-banner');
        if(banner&&empInfo){banner.style.display='flex';banner.innerHTML=`<div class="zr-emp-photo" style="background-image:url('https://cdn.prod.badgephotos.side.amazon.dev/?uid=${empInfo.login}')"></div><div class="zr-emp-info"><span class="zr-emp-name">${empInfo.name||empInfo.login}</span><span class="zr-emp-detail"><b>Login:</b> ${empInfo.login} | <b>ID:</b> ${employeeId} | <b>Badge:</b> ${empInfo.badge||'\u2014'}</span><span class="zr-emp-detail"><b>Site:</b> ${siteId}</span></div>`;}
        dc.innerHTML='<div class="zr-loading"><div class="zr-spinner"></div><span class="zr-loading-text">Fetching Lenel activity data...</span></div>';
        modal.style.display='block';
        let dateRange=getLenelModalDateRange(); if(!dateRange) dateRange=getTodayRange();
        populateLenelDates(dateRange.startDateTime,dateRange.endDateTime);
        document.getElementById('zr-apply-btn').onclick=()=>{if(currentLenelEmployee)fetchLenel(currentLenelEmployee.employeeId,currentLenelEmployee.siteId,currentLenelEmployee.empInfo);};
        const payload={concernedEmployeeId:employeeId,siteId,startDateTime:dateRange.startDateTime,endDateTime:dateRange.endDateTime,userExperience:'NEW_UX_EXPERIENCE'};
        GM_xmlhttpRequest({method:'POST',url:LENEL_API,data:JSON.stringify(payload),headers:{'Content-Type':'application/json','Accept':'application/json','X-Requested-With':'XMLHttpRequest'},anonymous:false,nocache:true,
            onload:r=>{
                if(r.status===404&&r.responseText.includes('http method GET')&&retryCount<2){dc.innerHTML='<div class="zr-loading"><div class="zr-spinner"></div><span class="zr-loading-text">Retrying...</span></div>';setTimeout(()=>fetchLenel(employeeId,siteId,empInfo,retryCount+1),1500);return;}
                if(r.status>=200&&r.status<300){try{const data=JSON.parse(r.responseText);dc.innerHTML=(data.presence&&data.presence.length>0)?buildLenelTable(data.presence,siteId):'<div class="zr-empty"><span style="font-size:32px;">\ud83d\udced</span><span>No Lenel activity found.</span></div>';}catch(e){dc.innerHTML='<div class="zr-error"><b>Parse Error</b></div>';}}
                else if(r.status===401||r.status===403){dc.innerHTML=`<div class="zr-error"><b>Auth Error (${r.status})</b><span>Log into <a href="https://atoz.amazon.work" target="_blank" style="color:#0073bb;">A to Z</a> and try again.</span></div>`;}
                else{dc.innerHTML=`<div class="zr-error"><b>Request Failed (${r.status})</b></div>`;}
            },
            onerror:()=>{if(retryCount<2){dc.innerHTML='<div class="zr-loading"><div class="zr-spinner"></div><span class="zr-loading-text">Retrying...</span></div>';setTimeout(()=>fetchLenel(employeeId,siteId,empInfo,retryCount+1),1500);}else dc.innerHTML='<div class="zr-error"><b>Network Error</b></div>';},
            ontimeout:()=>{dc.innerHTML='<div class="zr-error"><b>Timeout</b></div>';}
        });
    }

    function buildLenelTable(data,siteId){
        data.sort((a,b)=>a.dateTime-b.dateTime);
        const sp=siteId?new RegExp(`^${siteId}-[\\d.]+-L\\d+\\s*`,'i'):null;
        const rows=data.filter(i=>i.status==='SUCCESS').map(i=>{const d=new Date(parseInt(i.dateTime,10)*1000);const dn=sp?i.deviceName.replace(sp,''):i.deviceName;return`<tr><td>${d.toLocaleDateString()}</td><td>${d.toLocaleTimeString()}</td><td>${dn}</td><td><span class="zr-dir-${i.direction.toLowerCase()}">${i.direction}</span></td></tr>`;}).join('');
        return`<table class="zr-table"><thead><tr><th>Date</th><th>Time</th><th>Device Name</th><th>Direction</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    function copyLenelTable(){
        const table=document.querySelector('#zr-lenel-data .zr-table');if(!table)return;
        let text=Array.from(table.querySelectorAll('thead th')).map(th=>th.textContent.trim()).join('\t')+'\n';
        table.querySelectorAll('tbody tr').forEach(row=>{text+=Array.from(row.querySelectorAll('td')).map(td=>td.textContent.trim()).join('\t')+'\n';});
        GM_setClipboard(text.trim());
    }

    function openLenelForEmployee(login,employeeId,badgeId,name){
        let siteId=getSiteId();if(!siteId){siteId=prompt('Enter site code (e.g. IAH3):');if(!siteId)return;}
        fetchLenel(employeeId,siteId,{login,name,badge:badgeId});
    }

    // SIMBA auto-fill
    function autoFillSimbaLogin(){
        if(window.location.href.includes('durable.corp.amazon.com')&&window.location.href.includes('/simba/audits/new_audit')){
            const inp=document.querySelector('#audited_login');const stored=GM_getValue('simba_login');
            if(inp&&stored){setTimeout(()=>{inp.value=stored;inp.focus();GM_setValue('simba_login','');inp.style.background='#d4edda';setTimeout(()=>inp.style.background='',1000);},500);}
        }
    }


    // ==========================================================
    //  SECTION 10 — STAFFING LOOKUP
    // ==========================================================
    function getDefaultStart(){const n=new Date();const s=new Date(n);s.setHours(6,0,0,0);if(n.getHours()<6)s.setDate(s.getDate()-1);return toLocalDT(s);}
    function getDefaultEnd(){const s=getDefaultStart();const[dp]=s.split('T');const[y,mo,d]=dp.split('-').map(Number);return toLocalDT(new Date(y,mo-1,d+1,5,59,0,0));}
    function toLocalDT(date){const p=n=>String(n).padStart(2,'0');return`${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;}

    function openStaffingModal(){
        if(document.getElementById('zra-staffing-overlay'))return;
        const overlay=document.createElement('div');overlay.id='zra-staffing-overlay';
        overlay.innerHTML=`<div id="zra-staffing-modal"><div id="zra-modal-header"><div id="zra-modal-title"><div class="zra-title-icon">\ud83d\udccb</div><h2>Staffing Lookup</h2><span class="zra-site-chip">${SITE.toUpperCase()}</span></div><button id="zra-modal-close" title="Close">\u2715</button></div><div id="zra-modal-controls"><div class="zra-time-row"><span class="zra-time-label">FROM</span><input class="zra-input" id="zra-start" type="datetime-local" value="${getDefaultStart()}"/><span class="zra-time-label">TO</span><input class="zra-input" id="zra-end" type="datetime-local" value="${getDefaultEnd()}"/></div><div class="zra-search-row"><div class="zra-search-wrap"><span class="zra-search-icon">\ud83d\udd0d</span><input id="zra-search-input" placeholder="Search by login, name, or location"/></div><select class="zra-input" id="zra-search-type"><option value="login">By Login</option><option value="location">By Location</option><option value="both" selected>Both</option></select><button class="zra-btn zra-btn-search" id="zra-fetch-btn"><span>Search</span></button><button class="zra-btn zra-btn-export" id="zra-export-btn" style="display:none;">\u2b07 CSV</button></div></div><div id="zra-progress"></div><div id="zra-modal-filterbar"><div class="zra-filter-tabs"><button class="zra-tab active" data-filter="all">All</button><button class="zra-tab" data-filter="active">\u25cf Active</button><button class="zra-tab" data-filter="inactive">\u25cb Inactive</button></div><div class="zra-status-bar" id="zra-status">Ready</div></div><div id="zra-staffing-results"><div class="zra-no-results"><div class="zra-empty-icon">\ud83d\udd0d</div>Enter a login or location above and click <strong>Search</strong>.</div></div></div>`;
        document.body.appendChild(overlay);
        document.getElementById('zra-modal-close').addEventListener('click',closeStaffingModal);
        overlay.addEventListener('click',e=>{if(e.target===overlay)closeStaffingModal();});
        document.getElementById('zra-fetch-btn').addEventListener('click',doStaffingSearch);
        document.getElementById('zra-search-input').addEventListener('keydown',e=>{if(e.key==='Enter')doStaffingSearch();});
        document.getElementById('zra-export-btn').addEventListener('click',staffExportCSV);
        overlay.querySelectorAll('.zra-tab').forEach(tab=>{
            tab.addEventListener('click',()=>{overlay.querySelectorAll('.zra-tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');staffCurrentFilter=tab.dataset.filter;staffRenderResults(staffAllResults);});
        });
    }

    function closeStaffingModal(){const o=document.getElementById('zra-staffing-overlay');if(o)o.remove();staffAllResults=[];staffCurrentFilter='all';staffIsFetching=false;}

    function gmFetch(url){return new Promise((resolve,reject)=>{GM_xmlhttpRequest({method:'GET',url,withCredentials:true,headers:{'Accept':'application/json','X-Requested-With':'XMLHttpRequest'},onload:r=>{if(r.status===404){resolve({results:[]});return;}if(r.status===0||r.status>=500){reject(new Error(`HTTP ${r.status}`));return;}try{resolve(JSON.parse(r.responseText));}catch(e){reject(new Error(`Invalid JSON (HTTP ${r.status})`));}},onerror:()=>reject(new Error('Network error')),ontimeout:()=>reject(new Error('Timeout'))});});}

    async function fetchAllStaffPages(startTime,endTime,status='all'){
        const buildUrl=page=>`${STAFFING_BASE}?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}&status=${status}&page_size=200&page=${page}`;
        staffUpdateProgress('Fetching page 1...',0,1);
        let page1;try{page1=await gmFetch(buildUrl(1));}catch(err){throw new Error(`Failed: ${err.message}`);}
        const page1Recs=Array.isArray(page1.results)?page1.results:[];
        if(!page1Recs.length){staffUpdateProgress(null);return[];}
        const totalPages=(page1.total_pages&&page1.total_pages>0)?Math.min(page1.total_pages,STAFFING_MAX_PAGES):1;
        staffUpdateProgress(`${totalPages} page(s) \u2014 ${page1.total||'?'} records`,1,totalPages);
        const allData=page1Recs;
        if(totalPages>1){
            const remaining=Array.from({length:totalPages-1},(_,i)=>i+2);let fetched=1;
            for(let i=0;i<remaining.length;i+=STAFFING_BATCH){
                const batch=remaining.slice(i,i+STAFFING_BATCH);
                const results=await Promise.allSettled(batch.map(p=>gmFetch(buildUrl(p))));
                for(let j=0;j<results.length;j++){if(results[j].status==='rejected')continue;const recs=Array.isArray(results[j].value.results)?results[j].value.results:[];allData.push(...recs);}
                fetched+=batch.length;staffUpdateProgress(`Fetching pages... ${fetched}/${totalPages}`,fetched,totalPages);
            }
        }
        staffUpdateProgress(null);return allData;
    }

    function staffGroupByAssociate(records){
        const map=new Map();
        for(const r of records){const k=r.associate||'unknown';if(!map.has(k))map.set(k,{associate:r.associate,associate_name:r.associate_name,records:[]});map.get(k).records.push(r);}
        const grouped=[];
        for(const[,entry]of map){entry.records.sort((a,b)=>{const ta=a.start_time?new Date(a.start_time).getTime():0;const tb=b.start_time?new Date(b.start_time).getTime():0;return tb-ta;});entry.last3=entry.records.slice(0,3);entry.isActive=entry.last3[0]?!!entry.last3[0].is_active:false;grouped.push(entry);}
        grouped.sort((a,b)=>{if(a.isActive!==b.isActive)return a.isActive?-1:1;return(a.associate_name||a.associate||'').localeCompare(b.associate_name||b.associate||'');});
        return grouped;
    }

    async function doStaffingSearch(){
        if(staffIsFetching)return;
        const query=document.getElementById('zra-search-input').value.trim().toLowerCase();
        const searchType=document.getElementById('zra-search-type').value;
        const startTime=document.getElementById('zra-start').value;const endTime=document.getElementById('zra-end').value;
        if(!startTime||!endTime){staffSetStatus('\u26a0 Set start and end times.');return;}
        const resultsEl=document.getElementById('zra-staffing-results');const fetchBtn=document.getElementById('zra-fetch-btn');
        resultsEl.innerHTML='<div class="zra-loading-staff"><div class="zra-spinner-staff"></div>Fetching staffing data...</div>';
        document.getElementById('zra-export-btn').style.display='none';fetchBtn.disabled=true;staffIsFetching=true;staffAllResults=[];
        try{
            const rawData=await fetchAllStaffPages(startTime,endTime,'all');
            if(!rawData.length){resultsEl.innerHTML='<div class="zra-no-results"><div class="zra-empty-icon">\ud83d\udced</div>No staffing records found.</div>';staffSetStatus('No records.');fetchBtn.disabled=false;staffIsFetching=false;return;}
            let filtered=rawData;
            if(query){filtered=rawData.filter(r=>{const lo=(r.associate||'').toLowerCase();const na=(r.associate_name||'').toLowerCase();const loc=(r.location||'').toLowerCase();const sec=(r.section||'').toLowerCase();const zo=(r.zone||'').toLowerCase();if(searchType==='login')return lo.includes(query)||na.includes(query);if(searchType==='location')return loc.includes(query)||sec.includes(query)||zo.includes(query);return lo.includes(query)||na.includes(query)||loc.includes(query)||sec.includes(query)||zo.includes(query);});}
            staffAllResults=staffGroupByAssociate(filtered);
            staffSetStatus(`${rawData.length} total \u2014 ${filtered.length} match \u2014 ${staffAllResults.length} associate(s)`);
            document.getElementById('zra-export-btn').style.display=staffAllResults.length?'':'none';
            staffRenderResults(staffAllResults);
        }catch(err){resultsEl.innerHTML=`<div class="zra-error-staff">\u274c ${err.message}</div>`;staffSetStatus('Error.');}
        fetchBtn.disabled=false;staffIsFetching=false;
    }

    function staffRenderResults(grouped){
        const resultsEl=document.getElementById('zra-staffing-results');
        let filtered=grouped;
        if(staffCurrentFilter==='active')filtered=grouped.filter(g=>g.isActive);
        if(staffCurrentFilter==='inactive')filtered=grouped.filter(g=>!g.isActive);
        if(!filtered.length){resultsEl.innerHTML='<div class="zra-no-results"><div class="zra-empty-icon">\ud83d\udd0d</div>No records match the current filter.</div>';staffSetStatus('0 associates');return;}
        const frag=document.createDocumentFragment();
        for(let i=0;i<filtered.length;i++){const div=document.createElement('div');div.innerHTML=staffBuildCard(filtered[i]);const card=div.firstElementChild;card.style.animationDelay=`${Math.min(i*30,300)}ms`;frag.appendChild(card);}
        resultsEl.innerHTML='';resultsEl.appendChild(frag);staffSetStatus(`Showing ${filtered.length} associate(s)`);
    }

    function staffGetInitials(name){if(!name)return'??';const cs=name.split(',');if(cs.length>=2)return((cs[1].trim()[0]||'')+(cs[0].trim()[0]||'')).toUpperCase();const ss=name.trim().split(/\s+/);if(ss.length>=2)return((ss[0][0]||'')+(ss[ss.length-1][0]||'')).toUpperCase();return name.slice(0,2).toUpperCase();}

    function staffBuildCard(entry){
        const{associate,associate_name,last3,isActive}=entry;
        const initials=staffGetInitials(associate_name||associate);
        const photoHtml=`<div class="zra-avatar-wrap"><img src="${PHOTO_URL(associate)}" alt="${escHtml(associate)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"/><div class="zra-avatar-initials" style="display:none;">${escHtml(initials)}</div></div>`;
        const badge=isActive?'<span class="zra-badge-active">\u25cf Active</span>':'<span class="zra-badge-inactive">\u25cb Inactive</span>';
        const slots=[0,1,2].map(i=>staffBuildSlot(last3[i],i)).join('');
        return`<div class="zra-card"><div class="zra-card-header">${photoHtml}<div class="zra-card-info"><div class="zra-card-name">${escHtml(associate_name||associate||'\u2014')}</div><div class="zra-card-login">${escHtml(associate||'\u2014')}</div>${badge}</div></div><div class="zra-slots">${slots}</div></div>`;
    }

    function staffBuildSlot(record,index){
        const labels=['Most Recent','2nd Assignment','3rd Assignment'];
        if(!record)return`<div class="zra-slot slot-empty"><div class="zra-slot-num">#${index+1}</div><div class="zra-slot-label">${labels[index]}</div><div class="zra-slot-location empty-loc">\u2014</div></div>`;
        const isActive=record.is_active;const location=record.location||record.zone||record.section||'\u2014';
        const startFmt=record.start_time?staffFormatDT(record.start_time):'\u2014';const staffedBy=record.staffed_by||'\u2014';const removedBy=record.unstaffed_by||null;
        return`<div class="zra-slot ${isActive?'slot-active':''}"><div class="zra-slot-num">#${index+1}</div><div class="zra-slot-label">${labels[index]}</div><div class="zra-slot-location">${escHtml(location)}</div><div class="zra-slot-meta"><div class="zra-slot-meta-row"><label>Start</label><span>${startFmt}</span></div><div class="zra-slot-meta-row"><label>Staffed by</label><span>${escHtml(staffedBy)}</span></div>${removedBy?`<div class="zra-slot-meta-row"><label>Removed by</label><span>${escHtml(removedBy)}</span></div>`:`<div class="zra-slot-still-active">\u25cf Still active</div>`}</div></div>`;
    }

    function staffUpdateProgress(msg,current,total){const el=document.getElementById('zra-progress');if(!el)return;if(msg===null){el.style.display='none';el.innerHTML='';}else{el.style.display='block';const pct=(total&&total>0)?Math.round((current/total)*100):0;el.innerHTML=`<div>\u23f3 ${msg}</div><div class="zra-prog-bar"><div class="zra-prog-fill" style="width:${pct}%"></div></div>`;}}
    function staffSetStatus(msg){const el=document.getElementById('zra-status');if(el)el.textContent=msg;}
    function staffFormatDT(iso){try{return new Date(iso).toLocaleString('en-US',{month:'2-digit',day:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});}catch{return iso;}}

    function staffExportCSV(){
        let filtered=staffAllResults;
        if(staffCurrentFilter==='active')filtered=staffAllResults.filter(g=>g.isActive);
        if(staffCurrentFilter==='inactive')filtered=staffAllResults.filter(g=>!g.isActive);
        if(!filtered.length)return;
        const headers=['Associate','Name','Slot','Location','Start Time','Staffed By','Removed By','Active'];const rows=[];
        for(const entry of filtered){entry.last3.forEach((r,i)=>{rows.push([entry.associate||'',entry.associate_name||'',`Slot ${i+1}`,r.location||r.zone||r.section||'',r.start_time||'',r.staffed_by||'',r.unstaffed_by||'',r.is_active?'Yes':'No'].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));});}
        const csv=[headers.join(','),...rows].join('\n');const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);
        const a=document.createElement('a');a.href=url;a.download=`staffing_${new Date().toISOString().slice(0,16).replace('T','_')}.csv`;a.click();URL.revokeObjectURL(url);
    }


    // ==========================================================
    //  SECTION 13 — STICKY POSITIONING
    // ==========================================================
    function makeAvailableAssociatesSticky(){
        const h=document.querySelector('.card-title');
        if(h&&h.textContent.includes('Available Associates')){const c=h.closest('.card');if(c){c.style.position='sticky';c.style.top='20px';c.style.zIndex='999';c.style.maxHeight='calc(100vh - 40px)';c.style.overflowY='auto';}}
    }

    // ==========================================================
    //  SECTION 14 — INITIALIZATION
    // ==========================================================
    if(window.location.href.includes('durable.corp.amazon.com')&&window.location.href.includes('/simba/audits/new_audit')){
        autoFillSimbaLogin();
    } else {
        // Load JsBarcode
        if(typeof JsBarcode==='undefined'){const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js';s.onload=()=>{jsBarcodeReady=true;};document.head.appendChild(s);}else jsBarcodeReady=true;

        setTimeout(()=>{
            buildUI();
            enhanceAssociateCards();
            addBarcodeToCards();
            makeAvailableAssociatesSticky();
            createLenelModal();
        },2000);

        const observer=new MutationObserver(mutations=>{
            let hasNewCards=false;
            mutations.forEach(mutation=>{
                if(mutation.addedNodes.length){
                    mutation.addedNodes.forEach(node=>{
                        if(node.nodeType!==1)return;
                        if(node.classList&&(node.classList.contains('new-associate-card')||node.classList.contains('associate-card'))){hasNewCards=true;enhanceAssociateCards();}
                        if(node.classList&&node.classList.contains('new-associate-photo')){addBarcodeToCards();}
                        // Also check children (Zone-RA often adds wrapper divs containing cards)
                        if(node.querySelector&&node.querySelector('.associate-card[data-employee-id]')){hasNewCards=true;enhanceAssociateCards();addBarcodeToCards();}
                    });
                }
            });
            if(hasNewCards) xtAutoScanNewCards();
        });


        observer.observe(document.body,{childList:true,subtree:true});

        // Backup interval
        setInterval(()=>{enhanceAssociateCards();addBarcodeToCards();},5000);
        setTimeout(makeAvailableAssociatesSticky,3000);
    }

    console.log('\u2705 Zone-RA Unified Suite v1.5 loaded!');
    console.log('\ud83c\udfaf Modules: Labor Tracker | Enhancement Suite | Staffing Lookup');
    console.log('\ud83d\udccb All tools on left sidebar');
})();
