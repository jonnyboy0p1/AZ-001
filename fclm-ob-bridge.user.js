// ==UserScript==
// @name         OB EOL Bridge — Fluid + Dock Pallet Loader (RFD2)
// @namespace    ob-period-report.bridge
// @version      1.3.0
// @description  Floating panel that collects OB goals (Fluid/MP/RWC/Pallets) and EOL Dock Pallet Loader actuals (Pallets Loaded, PL Rate, HC) and feeds the OB Period Report dashboard. Excludes Manual Palletize HC & Rate.
// @author       you
// @match        https://fclm-portal.amazon.com/*
// @match        https://*.amazon.com/*
// @match        https://*.amazon.dev/*
// @match        file:///*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      fclm-portal.amazon.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  var SHARED_KEY = 'OB_BRIDGE_SHARED_PAYLOAD';
  var POS_KEY = 'OB_EOL_BRIDGE_POS';
  var MIN_KEY = 'OB_EOL_BRIDGE_MIN';
  var LS_KEYS = ['OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE', 'OB_PERIOD_REPORT_CARD_BRIDGE'];
  var VERSION = '1.3.0';

  // ---------------- number / cell helpers ----------------
  function num(v){ if(v==null||v==='')return 0; var n=Number(String(v).replace(/,/g,'').replace(/[^0-9.\-]/g,'')); return isFinite(n)?n:0; }
  function fmt(n,d){ d=d||0; return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}); }
  function firstNum(t){ var m=String(t==null?'':t).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/); return m?Number(m[0]):0; }
  function cellText(c){ return (c&&c.textContent?c.textContent:'').trim().replace(/\s+/g,' '); }
  function rowLabel(tr){ var cs=tr.querySelectorAll('th,td'); for(var i=0;i<cs.length;i++){ var t=cellText(cs[i]).toLowerCase(); if(/[a-z]/.test(t)) return t; } return ''; }
  function lastNumericCells(tr,count){ var cs=tr.querySelectorAll('th,td'),out=[]; for(var i=cs.length-1;i>=0&&out.length<count;i--){ var t=cellText(cs[i]); if(/\d/.test(t)) out.push(firstNum(t)); } return out; }
  function ago(ts){ if(!ts) return ''; var s=Math.max(0,Math.round((Date.now()-ts)/1000)); if(s<60) return s+'s ago'; var m=Math.floor(s/60); return m+'m '+(s%60)+'s ago'; }

  // ---------------- OB goal-column scrape (right-hand targets) ----------------
  var OB_GOAL_ROWS = {
    'fluid load jobs':'fluidLoadJobs', 'manual palletize jobs':'manualPalletizeJobs', 'rwc jobs':'rwcJobs',
    'fluid load rate':'fluidLoadRate', 'fluid load (incl. wall builder) hc':'fluidLoadHC',
    'pallets loaded':'palletsLoadedJobs', 'pallets loaded rate':'palletsLoadedRate', 'dock pallet loader hc':'dockPalletLoaderHC'
    // Manual Palletize Rate & HC intentionally excluded.
  };
  function scrapeObGoals(root){ root=root||document; var neo={}; var rows=root.querySelectorAll('tr');
    for(var i=0;i<rows.length;i++){ var f=OB_GOAL_ROWS[rowLabel(rows[i])]; if(!f) continue; var n=lastNumericCells(rows[i],1); if(n.length) neo[f]=n[0]; }
    return Object.keys(neo).length?neo:null; }

  // ---------------- EOL: Dock Pallet Loader actuals ----------------
  function scrapeDock(root){ root=root||document;
    var ths=root.querySelectorAll('th'),hasUph=false;
    for(var i=0;i<ths.length;i++){ if(/uph/i.test(cellText(ths[i]))){ hasUph=true; break; } }
    if(!hasUph) return null;
    var totalRow=root.querySelector('tr.total-row, tr.total, tfoot tr');
    if(!totalRow){ var rows=root.querySelectorAll('table tr'); for(var j=rows.length-1;j>=0;j--){ if(/^total\b/i.test(rowLabel(rows[j]))){ totalRow=rows[j]; break; } } }
    if(!totalRow) return null;
    var nums=lastNumericCells(totalRow,2); if(nums.length<2) return null;   // [Pallet UPH, Pallet UNIT]
    var bodyRows=root.querySelectorAll('table tr'),hc=0;
    for(var k=0;k<bodyRows.length;k++){ if(bodyRows[k].querySelector('a') && !/^total\b/i.test(rowLabel(bodyRows[k]))) hc++; }
    return { palletsLoaded:nums[1], rate:nums[0], hc:hc };
  }

  // ---------------- shared GM store + relay ----------------
  function readShared(){ try{ return JSON.parse(GM_getValue(SHARED_KEY,'{}'))||{}; }catch(e){ return {}; } }
  function mergeStore(partial){ var cur=readShared(); var next={source:'tampermonkey',updatedAt:Date.now()};
    if(cur.neo) next.neo=cur.neo; if(cur.dock) next.dock=cur.dock; next.neoAt=cur.neoAt; next.dockAt=cur.dockAt;
    if(partial.neo){ next.neo=Object.assign({},cur.neo,partial.neo); next.neoAt=Date.now(); }
    if(partial.dock){ next.dock=Object.assign({},cur.dock,partial.dock); next.dockAt=Date.now(); }
    GM_setValue(SHARED_KEY,JSON.stringify(next)); return next; }
  function isDashboard(){ return !!(document.getElementById('fclmSourceLinks')||document.getElementById('periodPulse')||document.getElementById('bridgeJson')); }
  function relayToDashboard(payload){ if(!payload||(!payload.neo&&!payload.dock)) return;
    try{ LS_KEYS.forEach(function(k){ localStorage.setItem(k,JSON.stringify(payload)); }); }catch(e){}
    try{ window.postMessage({type:'PRC_V2_HYBRID_DATA',payload:payload},'*'); }catch(e){} }

  // ---------------- Dock fetch (dashboard side, via Midway session) ----------------
  function pad(n){ return String(n).padStart(2,'0'); }
  function buildDockUrl(shiftDate,includeMET){ var p=String(shiftDate||'').split('-').map(Number),y=p[0],m=p[1],d=p[2];
    if(!y) return ''; var nd=new Date(Date.UTC(y,m-1,d+1,12));
    var u=new URL('https://fclm-portal.amazon.com/reports/functionRollup');
    u.search=new URLSearchParams({ reportFormat:'HTML',warehouseId:'RFD2',processId:'1003022',maxIntradayDays:'1',spanType:'Intraday',
      startDateIntraday:y+'/'+pad(m)+'/'+pad(d),startHourIntraday:'19',startMinuteIntraday:'0',
      endDateIntraday:nd.getUTCFullYear()+'/'+pad(nd.getUTCMonth()+1)+'/'+pad(nd.getUTCDate()),
      endHourIntraday:includeMET?'6':'5',endMinuteIntraday:'30' }).toString();
    return u.toString(); }
  function dashShiftDate(){ var el=document.getElementById('shiftDate'); return (el&&el.value)|| new Date().toISOString().slice(0,10); }
  function dashMET(){ var el=document.getElementById('useMET'); return !!el && el.value==='true'; }
  var dockBusy=false;
  function fetchDock(cb){ if(dockBusy||typeof GM_xmlhttpRequest==='undefined'){ cb&&cb(null); return; }
    var url=buildDockUrl(dashShiftDate(),dashMET()); if(!url){ cb&&cb(null); return; } dockBusy=true;
    GM_xmlhttpRequest({ method:'GET',url:url,timeout:25000,
      onload:function(r){ dockBusy=false; if(r.status<200||r.status>=300){ cb&&cb(null); return; }
        try{ cb&&cb(scrapeDock(new DOMParser().parseFromString(r.responseText,'text/html'))); }catch(e){ cb&&cb(null); } },
      onerror:function(){ dockBusy=false; cb&&cb(null); }, ontimeout:function(){ dockBusy=false; cb&&cb(null); } });
  }

  // ---------------- Floating panel UI ----------------
  function injectStyle(){
    if(document.getElementById('obxStyle')) return;
    var s=document.createElement('style'); s.id='obxStyle';
    s.textContent=[
      '#obEolBridge{position:fixed;z-index:2147483647;top:80px;left:16px;width:300px;background:#0b1220;color:#e8eefb;',
      'border:1px solid #233248;border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.5);font:500 12px/1.35 Inter,Segoe UI,Arial,sans-serif;overflow:hidden;}',
      '#obEolBridge .obx-head{display:flex;flex-direction:column;gap:2px;padding:10px 12px;background:#101a2e;cursor:move;border-bottom:1px solid #233248;}',
      '#obEolBridge .obx-title{font-weight:900;font-size:13px;}',
      '#obEolBridge .obx-ver{color:#9aa8bd;font-weight:700;font-size:10px;}',
      '#obEolBridge .obx-sub{color:#9aa8bd;font-size:10px;}',
      '#obEolBridge .obx-btns{display:flex;gap:6px;padding:8px 12px 0;}',
      '#obEolBridge button{flex:1;border:0;border-radius:8px;padding:8px 10px;font-weight:900;cursor:pointer;font-size:12px;}',
      '#obEolBridge .obx-collect{background:#2f6fea;color:#fff;}',
      '#obEolBridge .obx-min{flex:0 0 auto;background:#1e293b;color:#cdd7ea;}',
      '#obEolBridge .obx-status{padding:7px 12px 2px;color:#72f0a4;font-size:11px;font-weight:700;}',
      '#obEolBridge .obx-sec{margin:8px 12px 2px;color:#7aa2ff;font-size:10px;font-weight:950;text-transform:uppercase;letter-spacing:.06em;}',
      '#obEolBridge .obx-row{display:flex;justify-content:space-between;gap:10px;padding:4px 12px;}',
      '#obEolBridge .obx-row span{color:#9aa8bd;}',
      '#obEolBridge .obx-row b{color:#e8eefb;font-variant-numeric:tabular-nums;}',
      '#obEolBridge .obx-row b.g{color:#72f0a4;}',
      '#obEolBridge .obx-when{padding:2px 12px 4px;color:#6b7a90;font-size:10px;text-align:right;}',
      '#obEolBridge .obx-body{padding-bottom:10px;}',
      '#obEolBridge.min .obx-body{display:none;}'
    ].join('');
    (document.head||document.documentElement).appendChild(s);
  }

  function buildPanel(){
    if(document.getElementById('obEolBridge')) return;
    injectStyle();
    var box=document.createElement('div'); box.id='obEolBridge';
    box.innerHTML=[
      '<div class="obx-head" id="obxDrag">',
      '  <div class="obx-title">OB EOL Bridge <span class="obx-ver">v',VERSION,'</span></div>',
      '  <div class="obx-sub" id="obxContext">—</div>',
      '</div>',
      '<div class="obx-btns">',
      '  <button class="obx-collect" id="obxCollect">↻ Collect / Pull Now</button>',
      '  <button class="obx-min" id="obxMin">–</button>',
      '</div>',
      '<div class="obx-status" id="obxStatus">Ready.</div>',
      '<div class="obx-body">',
      '  <div class="obx-sec">EOL — Dock Pallet Loader</div>',
      '  <div class="obx-row"><span>Pallets Loaded</span><b id="obxPallets">—</b></div>',
      '  <div class="obx-row"><span>PL Rate</span><b id="obxRate">—</b></div>',
      '  <div class="obx-row"><span>HC (AAs)</span><b id="obxHc">—</b></div>',
      '  <div class="obx-when" id="obxDockWhen"></div>',
      '  <div class="obx-sec">FCLM Goals (NEO / OB report)</div>',
      '  <div class="obx-row"><span>Fluid</span><b id="obxFluid">—</b></div>',
      '  <div class="obx-row"><span>MP</span><b id="obxMp">—</b></div>',
      '  <div class="obx-row"><span>RWC</span><b id="obxRwc">—</b></div>',
      '  <div class="obx-row"><span>Pallets Goal</span><b id="obxPalletsGoal">—</b></div>',
      '  <div class="obx-row"><span>PL Rate Goal</span><b id="obxRateGoal">—</b></div>',
      '  <div class="obx-when" id="obxNeoWhen"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(box);

    // restore position + minimized
    try{ var pos=JSON.parse(localStorage.getItem(POS_KEY)||'null'); if(pos){ box.style.left=pos.left; box.style.top=pos.top; } }catch(e){}
    if(localStorage.getItem(MIN_KEY)==='1') box.classList.add('min');

    document.getElementById('obxCollect').addEventListener('click', collect);
    document.getElementById('obxMin').addEventListener('click', function(){ box.classList.toggle('min'); localStorage.setItem(MIN_KEY, box.classList.contains('min')?'1':'0'); });
    makeDraggable(box, document.getElementById('obxDrag'));
    renderPanel();
  }

  function makeDraggable(box, handle){
    var ox=0,oy=0,dragging=false;
    handle.addEventListener('mousedown', function(e){ dragging=true; var r=box.getBoundingClientRect(); ox=e.clientX-r.left; oy=e.clientY-r.top; e.preventDefault(); });
    document.addEventListener('mousemove', function(e){ if(!dragging) return; box.style.left=Math.max(0,e.clientX-ox)+'px'; box.style.top=Math.max(0,e.clientY-oy)+'px'; box.style.right='auto'; });
    document.addEventListener('mouseup', function(){ if(!dragging) return; dragging=false; try{ localStorage.setItem(POS_KEY, JSON.stringify({left:box.style.left,top:box.style.top})); }catch(e){} });
  }

  function setText(id,t,green){ var el=document.getElementById(id); if(!el) return; el.textContent=t; el.className=green?'g':''; }
  function status(msg,green){ var el=document.getElementById('obxStatus'); if(el){ el.textContent=msg; el.style.color=green===false?'#ff8f9a':'#72f0a4'; } }

  function renderPanel(){
    var s=readShared(), dock=s.dock||{}, neo=s.neo||{};
    setText('obxPallets', dock.palletsLoaded!=null?fmt(dock.palletsLoaded):'—', dock.palletsLoaded!=null);
    setText('obxRate', dock.rate!=null?fmt(dock.rate,2):'—', dock.rate!=null);
    setText('obxHc', dock.hc!=null?fmt(dock.hc):'—', dock.hc!=null);
    var dw=document.getElementById('obxDockWhen'); if(dw) dw.textContent=s.dockAt?('updated '+ago(s.dockAt)):'not collected yet';
    setText('obxFluid', neo.fluidLoadJobs!=null?fmt(neo.fluidLoadJobs):'—', neo.fluidLoadJobs!=null);
    setText('obxMp', neo.manualPalletizeJobs!=null?fmt(neo.manualPalletizeJobs):'—', neo.manualPalletizeJobs!=null);
    setText('obxRwc', neo.rwcJobs!=null?fmt(neo.rwcJobs):'—', neo.rwcJobs!=null);
    setText('obxPalletsGoal', neo.palletsLoadedJobs!=null?fmt(neo.palletsLoadedJobs):'—', neo.palletsLoadedJobs!=null);
    setText('obxRateGoal', neo.palletsLoadedRate!=null?fmt(neo.palletsLoadedRate,2):'—', neo.palletsLoadedRate!=null);
    var nw=document.getElementById('obxNeoWhen'); if(nw) nw.textContent=s.neoAt?('updated '+ago(s.neoAt)):'not collected yet';
    var ctx=document.getElementById('obxContext');
    if(ctx) ctx.textContent = isDashboard()?'On dashboard — pulls EOL from FCLM':(scrapeDock(document)?'On Dock Pallet Loader report':(scrapeObGoals(document)?'On OB goals report':'Open a report or the dashboard'));
  }

  function collect(){
    var onDock=scrapeDock(document), onGoals=scrapeObGoals(document);
    if(onDock){ var p=mergeStore({dock:onDock}); relayToDashboard(p); status('Collected EOL: '+fmt(onDock.palletsLoaded)+' @ '+fmt(onDock.rate,2)+' · HC '+fmt(onDock.hc)); renderPanel(); return; }
    if(onGoals){ var p2=mergeStore({neo:onGoals}); relayToDashboard(p2); status('Collected '+Object.keys(onGoals).length+' goal field(s)'); renderPanel(); return; }
    if(isDashboard()){ status('Pulling EOL from FCLM…'); fetchDock(function(dock){ if(dock){ var p3=mergeStore({dock:dock}); relayToDashboard(p3); status('Pulled EOL: '+fmt(dock.palletsLoaded)+' @ '+fmt(dock.rate,2)+' · HC '+fmt(dock.hc)); } else { status('Could not pull Dock report (check Midway login).',false); } renderPanel(); }); return; }
    status('Open the Dock report, the OB goals page, or the dashboard.',false);
  }

  // ---------------- boot ----------------
  function start(){
    buildPanel();
    setInterval(renderPanel, 15000); // refresh the "ago" times
    try{ GM_addValueChangeListener(SHARED_KEY, function(){ renderPanel(); }); }catch(e){}

    if(isDashboard()){
      try{ window.postMessage({type:'PRC_V2_LIVE_BRIDGE_READY',version:VERSION},'*'); }catch(e){}
      relayToDashboard(readShared());                       // push whatever's already collected
      window.addEventListener('message', function(ev){ var t=ev.data&&ev.data.type;
        if(t==='PRC_V2_HYBRID_SOURCE_PULL'||t==='PRC_V2_HYBRID_FCLM_PULL'||t==='PRC_V2_HYBRID_PULL_REQUEST'){
          relayToDashboard(readShared()); fetchDock(function(dock){ if(dock){ relayToDashboard(mergeStore({dock:dock})); renderPanel(); } });
        } });
      return;
    }
    // report pages: auto-collect once if this page has data
    if(scrapeDock(document)||scrapeObGoals(document)) collect();
  }

  if(document.body) start(); else window.addEventListener('DOMContentLoaded', start);
})();
