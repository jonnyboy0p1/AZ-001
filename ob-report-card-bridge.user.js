// ==UserScript==
// @name         OB Period Report Card Bridge (OB02 All-In-One)
// @namespace    http://tampermonkey.net/
// @version      2026-06-15.1
// @description  All-in-one bridge: NEO shift goals, FCLM JPLH per period, FL Utilization / Battle of the Belt via LIVE graph tabs, plus the Live Metrics CORS fetch bridge. Live-tab mode: monitorportal renders numbers with JS and blocks iframing, so leave the FL Util / Belt graph tabs open and they self-collect into the shared bridge -> dashboard. Safe merges so empty P3 pulls never clobber good data.
// @author       JR
// @match        https://neo.meta.amazon.dev/planning*
// @match        https://fclm-portal.amazon.com/reports/functionRollup*
// @match        https://monitorportal.amazon.com/igraph*
// @match        https://zone-ra.amazon.dev/roster/rfd2/ob/fluid/*
// @match        file:///C:/Users/jonavroa/Desktop/RBv01/ROBv01/index.html*
// @match        file:///C:/Users/jonavroa/Desktop/OB02/index.html*
// @match        file:///C:/Users/jonavroa/Desktop/OB02/pace.html*
// @match        file:///C:/Users/jonavroa/Desktop/OBR03/dashboard.html*
// @match        file:///C:/Users/jonavroa/Desktop/OB-REPORT%20CARD/index.html*
// @match        file:///C:/Users/jonavroa/Desktop/OB-REPORT%20CARD/dashboard.html*
// @match        http://localhost:5173/*
// @match        http://127.0.0.1:5173/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      neo.meta.amazon.dev
// @connect      fclm-portal.amazon.com
// @connect      zone-ra.amazon.dev
// @connect      monitorportal.amazon.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const INSTANCE_ATTR = 'data-ob-prc-bridge-active';
  if (document.documentElement?.getAttribute(INSTANCE_ATTR) === 'true') return;
  document.documentElement?.setAttribute(INSTANCE_ATTR, 'true');

  const CONFIG = {
    bridgeKey: 'OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE',
    dashboardUrl: 'file:///C:/Users/jonavroa/Desktop/RBv01/ROBv01/index.html',
    dashboardServerUrl: 'http://localhost:5173/',
    neoUrl: 'https://neo.meta.amazon.dev/planning',
    fluidRosterUrl: 'https://zone-ra.amazon.dev/roster/rfd2/ob/fluid/',
    warehouseId: 'RFD2',
    processId: '1003021',
    desktopBridgeUrl: 'http://127.0.0.1:4765/bridge',
    refreshMinutes: 15,
    debug: false
  };

  const HOST = location.hostname;
  const HREF = location.href;
  const isNeo = HOST.includes('neo.meta.amazon.dev');
  const isFclm = HOST.includes('fclm-portal.amazon.com');
  const isMonitor = HOST.includes('monitorportal.amazon.com');
  const isFluidRoster = HOST.includes('zone-ra.amazon.dev') && location.pathname.includes('/roster/rfd2/ob/fluid');
  // Every local dashboard file this one script supports (OB02 / OBR03 / OB-REPORT
  // CARD / RBv01). Add a new dashboard path here AND to the @match block above and
  // the single script covers that folder too. Merged from the older OB02 / OBR03
  // bridge variants so they can all be retired in favor of this one file.
  const DASHBOARD_FILES = [
    'file:///C:/Users/jonavroa/Desktop/RBv01/ROBv01/index.html',
    'file:///C:/Users/jonavroa/Desktop/OB02/index.html',
    'file:///C:/Users/jonavroa/Desktop/OB02/pace.html',
    'file:///C:/Users/jonavroa/Desktop/OBR03/dashboard.html',
    'file:///C:/Users/jonavroa/Desktop/OB-REPORT%20CARD/index.html',
    'file:///C:/Users/jonavroa/Desktop/OB-REPORT%20CARD/dashboard.html'
  ];
  const isFileDashboard = DASHBOARD_FILES.some(p => HREF.startsWith(p));
  const isDashboard =
    isFileDashboard ||
    HREF.startsWith('http://localhost:5173/') ||
    HREF.startsWith('http://127.0.0.1:5173/');
  // Any local file:// dashboard runs "quiet" (no scraping UI, just renders bridge
  // data). FIX 1 also lives here: the original had a dangling `||` -> SyntaxError.
  const isOb02FileDashboard = isFileDashboard;

  const quietDashboard = isDashboard && (
    isOb02FileDashboard ||
    Boolean(document.querySelector('meta[name="ob-report-card"]'))
  );
  let fclmPullContext = null;
  let lastDashboardPushKey = '';

  const now = () => Date.now();
  const log = (...a) => CONFIG.debug && console.log('[PRC V2 Hybrid]', ...a);
  const SOURCE_LABELS = {
    all: 'FCLM, FL Utilization, and Battle of the Belt',
    fclm: 'FCLM',
    flUtil: 'FL Utilization',
    belt: 'Battle of the Belt',
    neo: 'NEO',
    roster: 'Fluid Roster'
  };

  function cleanText(str){return String(str||'').replace(/ /g,' ').replace(/\s+/g,' ').trim();}
  function normalizeText(str){return cleanText(str).replace(/[–—]/g,'-').toLowerCase();}
  function parseNumber(v){if(v==null||v==='')return NaN; const n=Number(String(v).replace(/,/g,'').replace(/[^0-9.\-]/g,'').trim()); return Number.isFinite(n)?n:NaN;}
  function extractNumbers(text){const m=String(text||'').match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g); return (m||[]).map(parseNumber).filter(Number.isFinite);}
  function firstNumberOutsideParens(text){const nums=extractNumbers(String(text||'').replace(/\([^)]*\)/g,' ')); return nums.length?nums[0]:NaN;}
  function isVisible(el){if(!el)return false; const s=getComputedStyle(el), r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;}
  function safeClone(o){try{return JSON.parse(JSON.stringify(o||{}))}catch{return {}}}
  function fmt(n,d=0){const x=parseNumber(n);return Number.isFinite(x)?x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'--'}

  // Safe merges: an incoming 0/NaN never overwrites an existing good value,
  // so an early P3 pull (before the period has data) can't blank the board.
  function mergeFclmPayload(existing, incoming){
    const out={...(existing||{})};
    if(!incoming) return out;
    ['totesJobs','casesJobs','totalJobs','wallBuilderRate','jplh'].forEach((key)=>{
      const v=parseNumber(incoming[key]);
      if(!Number.isFinite(v)) return;
      const cur=parseNumber(out[key]);
      if(v===0 && Number.isFinite(cur) && cur>0) return;
      out[key]=v;
    });
    const jobs=parseNumber(incoming.totalJobs);
    const wb=parseNumber(incoming.wallBuilderRate);
    if((Number.isFinite(jobs) && jobs>0) || (Number.isFinite(wb) && wb>0)){
      out.updatedAt=incoming.updatedAt||now();
      if(incoming.period) out.period=incoming.period;
    }
    return out;
  }

  function mergeFlUtil(existing, incoming){
    const out={...(existing||{})};
    if(!incoming) return out;
    let touched=false;
    ['mp','fl','rwc'].forEach((key)=>{
      const v=parseNumber(incoming[key]);
      if(!Number.isFinite(v)) return;
      out[key]=v;
      if(v>0) touched=true;
    });
    if(touched){
      out.updatedAt=incoming.updatedAt||now();
      if(incoming.period) out.period=incoming.period;
    }
    return out;
  }

  function mergeBelt(existing, incoming){
    const out={...(existing||{})};
    if(!incoming) return out;
    let touched=false;
    ['east','west'].forEach((key)=>{
      const v=parseNumber(incoming[key]);
      if(!Number.isFinite(v)) return;
      out[key]=v;
      if(v>0) touched=true;
    });
    if(touched){
      out.updatedAt=incoming.updatedAt||now();
      if(incoming.period) out.period=incoming.period;
    }
    return out;
  }

  /******************************************************************
   * SHIFT DATE + FCLM URLS
   ******************************************************************/

  function getOffsetMinutes(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, timeZoneName:'shortOffset', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
    }).formatToParts(date);
    const tzName = parts.find(p=>p.type==='timeZoneName')?.value || 'GMT-0';
    const match = tzName.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/i);
    if(!match) return 0;
    const h=Number(match[1]), m=Number(match[2]||0), sign=h>=0?1:-1;
    return h*60+sign*m;
  }

  function zonedParts(date, timeZone){
    const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
    const map={}; for(const p of parts) map[p.type]=p.value;
    return {year:Number(map.year),month:Number(map.month),day:Number(map.day),hour:Number(map.hour),minute:Number(map.minute)};
  }

  function addDays(y,m,d,days){
    const x=new Date(Date.UTC(y,m-1,d+days,12,0,0));
    return {year:x.getUTCFullYear(),month:x.getUTCMonth()+1,day:x.getUTCDate()}
  }

  const pad2=n=>String(n).padStart(2,'0');

  function ymd(o,slash=true){
    const sep=slash?'/':'-';
    return `${o.year}${sep}${pad2(o.month)}${sep}${pad2(o.day)}`
  }

  function parseShiftDate(value){
    const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return null;
    return {year:Number(m[1]),month:Number(m[2]),day:Number(m[3])};
  }

  function shiftStartDate(){
    const picked=parseShiftDate(fclmPullContext?.shiftDate) ||
      (isDashboard?parseShiftDate(document.getElementById('shiftDate')?.value):null);
    if(picked) return picked;
    const c=zonedParts(new Date(),'America/Chicago');
    return c.hour<12?addDays(c.year,c.month,c.day,-1):{year:c.year,month:c.month,day:c.day};
  }

  function includeMETSelected(){
    if(fclmPullContext?.includeMET !== undefined) return Boolean(fclmPullContext.includeMET);
    if(isDashboard) return document.getElementById('useMET')?.value === 'true';
    return Boolean(readBridge().shift?.includeMET);
  }

  function windows(){
    const start=shiftStartDate(), next=addDays(start.year,start.month,start.day,1);
    const includeMET=includeMETSelected();
    return {
      shiftDate: ymd(start,false),
      full:{key:'full',startDate:start,endDate:next,sh:19,sm:0,eh:includeMET?6:5,em:30},
      p1:{key:'p1',startDate:start,endDate:start,sh:19,sm:0,eh:23,em:0},
      p2:{key:'p2',startDate:start,endDate:next,sh:23,sm:30,eh:2,em:30},
      p3:{key:'p3',startDate:next,endDate:next,sh:3,sm:0,eh:5,em:30},
      met:{key:'met',startDate:next,endDate:next,sh:5,sm:30,eh:6,em:30}
    };
  }

  function buildFclmUrl(key='full'){
    const w=windows()[key] || windows().full;
    const u=new URL('https://fclm-portal.amazon.com/reports/functionRollup');

    u.searchParams.set('reportFormat','HTML');
    u.searchParams.set('warehouseId',CONFIG.warehouseId);
    u.searchParams.set('processId',CONFIG.processId);
    u.searchParams.set('maxIntradayDays','1');
    u.searchParams.set('spanType','Intraday');
    u.searchParams.set('startDateIntraday',ymd(w.startDate,true));
    u.searchParams.set('startHourIntraday',String(w.sh));
    u.searchParams.set('startMinuteIntraday',String(w.sm));
    u.searchParams.set('endDateIntraday',ymd(w.endDate,true));
    u.searchParams.set('endHourIntraday',String(w.eh));
    u.searchParams.set('endMinuteIntraday',String(w.em));

    return u.toString();
  }

  function localTimeToUtcIso(day,hour,minute){
    const roughUtc=new Date(Date.UTC(day.year,day.month-1,day.day,hour,minute));
    const offsetMinutes=getOffsetMinutes(roughUtc,'America/Chicago');
    return new Date(roughUtc.getTime()-offsetMinutes*60*1000).toISOString().replace('.000Z','Z');
  }

  function applyMonitorWindow(url,key,title){
    const w=windows()[key] || windows().full;
    url.searchParams.set('GraphTitle',`${title} - ${(key||'full').toUpperCase()}`);
    url.searchParams.set('TZ','America/Chicago@TZ: Chicago');
    url.searchParams.set('StartTime1',localTimeToUtcIso(w.startDate,w.sh,w.sm));
    url.searchParams.set('EndTime1',localTimeToUtcIso(w.endDate,w.eh,w.em));
    return url;
  }

  function buildMonitorFlUtilUrl(key='p1'){
    const u=new URL('https://monitorportal.amazon.com/igraph');
    ['MP','FL','RP'].forEach((dest,index)=>{
      const n=index+1;
      u.searchParams.set(`SchemaName${n}`,'Search');
      u.searchParams.set(`Pattern${n}`,`dataset=$Prod$ schemaname=Service marketplace=$RFD2-MainSorter1Controller$ hostgroup=$ALL$ host=$ALL$ servicename=$WarehouseControlService$ methodname=$SortationOrchestrator.divert$ client=$ALL$ metricclass=$NONE$ instance=$NONE$ schemaname=Service metric=$finalActualDestination-${dest} AND :SUCCESS$`);
    });
    u.searchParams.set('Period1','OneMinute');
    u.searchParams.set('Stat1','sum');
    u.searchParams.set('HeightInPixels','300');
    u.searchParams.set('WidthInPixels','600');
    u.searchParams.set('DecoratePoints','true');
    u.searchParams.set('GraphType','pie');
    ['MP','FL','RWC'].forEach((label,index)=>{
      const n=index+1;
      u.searchParams.set(`FunctionExpression${n}`,`SUM(S${n})`);
      u.searchParams.set(`FunctionLabel${n}`,`TOTAL ${label}[total: {sum}]`);
      u.searchParams.set(`FunctionYAxisPreference${n}`,'left');
    });
    return applyMonitorWindow(u,key,'FL Utilization').toString();
  }

  function buildMonitorBeltUrl(key='p1'){
    const u=new URL('https://monitorportal.amazon.com/igraph');
    const westBelts=[350,355,354,353,352,351,349,348,347,346,345,344,343,342,341,340,339,338];
    const eastBelts=Array.from({length:19},(_,i)=>104+i);
    const allBelts=[null,...westBelts,...eastBelts];
    allBelts.forEach((belt,index)=>{
      const n=index+1;
      const metric=belt?`actDestStatus-FL_${belt} AND :SUCCESS`:'actDestStatus-FL AND :SUCCESS';
      u.searchParams.set(`SchemaName${n}`,'Search');
      u.searchParams.set(`Pattern${n}`,`dataset=$Prod$ schemaname=Service marketplace=$RFD2-MainSorter1Controller$ hostgroup=$ALL$ host=$ALL$ servicename=$WarehouseControlService$ methodname=$SortationOrchestrator.divert$ client=$ALL$ metricclass=$NONE$ instance=$NONE$ schemaname=Service metric=$${metric}$`);
    });
    u.searchParams.set('Period1','FiveMinute');
    u.searchParams.set('Stat1','sum');
    u.searchParams.set('HeightInPixels','500');
    u.searchParams.set('WidthInPixels','1460');
    u.searchParams.set('DecoratePoints','true');
    u.searchParams.set('GraphType','pie');
    u.searchParams.set('LabelLeft','Total Number of Totes');
    u.searchParams.set('FunctionExpression1',`SUM(${westBelts.map((_,i)=>`S${i+2}`).join(',')})`);
    u.searchParams.set('FunctionLabel1','{West Side}');
    u.searchParams.set('FunctionYAxisPreference1','left');
    u.searchParams.set('FunctionExpression2',`SUM(${eastBelts.map((_,i)=>`S${i+20}`).join(',')})`);
    u.searchParams.set('FunctionLabel2','{East Side}');
    u.searchParams.set('FunctionYAxisPreference2','left');
    return applyMonitorWindow(u,key,'Battle of the Belt II (Successful Divert)').toString();
  }

  function classifyFclmPeriod(){
    if(!isFclm) return 'unknown';

    const u=new URL(location.href);
    const sh=Number(u.searchParams.get('startHourIntraday'));
    const sm=Number(u.searchParams.get('startMinuteIntraday'));
    const eh=Number(u.searchParams.get('endHourIntraday'));
    const em=Number(u.searchParams.get('endMinuteIntraday'));

    if(sh===19&&sm===0&&eh===23&&em===0) return 'p1';
    if(sh===23&&sm===30&&eh===2&&em===30) return 'p2';
    if(sh===3&&sm===0&&eh===5&&em===30) return 'p3';
    if(sh===5&&sm===30&&eh===6&&em===30) return 'met';
    if(sh===19&&sm===0) return 'full';

    return 'unknown';
  }

  function classifyMonitorPeriod(){
    if(!isMonitor) return 'unknown';

    const title=cleanText(new URL(location.href).searchParams.get('GraphTitle')||'');
    const m=title.match(/\s-\s(P1|P2|P3|MET|Full)\s*$/i);

    if(m){
      const key=m[1].toLowerCase();
      return key==='full'?'full':key;
    }

    return 'unknown';
  }

  function classifyMonitorType(){
    if(!isMonitor) return 'unknown';

    const title=cleanText(new URL(location.href).searchParams.get('GraphTitle')||document.title||'');

    if(/battle of the belt|east vs west/i.test(title)) return 'belt';
    if(/fl utilization|mp \/ fl \/ rwc|fl \/ mp \/ rwc/i.test(title)) return 'flUtil';

    return 'unknown';
  }

  /******************************************************************
   * STORAGE
   ******************************************************************/

  function readBridge(){
    try{return GM_getValue(CONFIG.bridgeKey,{})||{}}
    catch{return {}}
  }

  function writeBridge(payload){
    const next=safeClone(payload);
    next.updatedAt=now();

    GM_setValue(CONFIG.bridgeKey,next);

    try{
      localStorage.setItem(CONFIG.bridgeKey,JSON.stringify(next));
      localStorage.setItem('OB_PERIOD_REPORT_CARD_BRIDGE',JSON.stringify(next));
    }catch{}

    pushToDesktop(next);

    return next;
  }

  function pushToDesktop(payload){
    const body=JSON.stringify(payload||{});

    try{
      if(typeof GM_xmlhttpRequest==='function'){
        GM_xmlhttpRequest({
          method:'POST',
          url:CONFIG.desktopBridgeUrl,
          headers:{'Content-Type':'application/json'},
          data:body,
          timeout:4000,
          onload:()=>log('Desktop bridge push ok'),
          onerror:(err)=>log('Desktop bridge push failed',err),
          ontimeout:()=>log('Desktop bridge push timed out')
        });
        return;
      }
    }catch(err){
      log('Desktop bridge GM push exception',err);
    }

    try{
      fetch(CONFIG.desktopBridgeUrl,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body
      }).catch((err)=>log('Desktop bridge fetch failed',err));
    }catch(err){
      log('Desktop bridge fetch exception',err);
    }
  }

  function emptyBridge(){
    const w=windows();
    const includeMET=includeMETSelected();
    return {
      shift:{
        shiftDate:w.shiftDate,
        includeMET,
        refreshMinutes:CONFIG.refreshMinutes
      },
      neo:{},
      fclmPeriods:{},
      fclmFull:{},
      monitorPeriods:{},
      monitorFull:{},
      roster:{},
      lastPull:null
    };
  }

  function sourceLabel(source){
    return SOURCE_LABELS[source] || source || 'Bridge';
  }

  function markLastPull(bridge,source,detail=''){
    bridge.lastPull={
      source,
      label:sourceLabel(source),
      detail,
      updatedAt:now()
    };
    return bridge;
  }

  function baseBridge(){
    const existing=readBridge();
    const w=windows();
    const includeMET=includeMETSelected();
    const existingShift=existing.shift||{};
    const sameShift=existingShift.shiftDate===w.shiftDate && Boolean(existingShift.includeMET)===includeMET;
    const b=sameShift?existing:emptyBridge();

    b.shift={
      shiftDate:w.shiftDate,
      includeMET,
      refreshMinutes:CONFIG.refreshMinutes
    };

    return b;
  }

  function resetBridgeData(){
    const cleared=emptyBridge();
    const saved=writeBridge(cleared);
    try{
      localStorage.setItem(CONFIG.bridgeKey,JSON.stringify(saved));
      localStorage.setItem('OB_PERIOD_REPORT_CARD_BRIDGE',JSON.stringify(saved));
    }catch{}
    pushToDesktop(saved);
    if(isDashboard) fillDashboard(saved,{force:true});
    updatePanel(saved,'Bridge reset to standard shift');
    return saved;
  }

  /******************************************************************
   * NEO COLLECTOR
   ******************************************************************/

  function findTransferOutDirectSection(){
    const candidates=[...document.querySelectorAll('div,section,article,tr,[role="row"]')].filter(isVisible);
    let best=null, score=-1;

    for(const el of candidates){
      const t=normalizeText(el.innerText||el.textContent||'');

      if(!t.includes('transfer out - direct')) continue;

      let s=0;

      ['fluid load jobs','manual palletize jobs','rwc jobs','fluid load rate','wall builder'].forEach(k=>{
        if(t.includes(k)) s+=10;
      });

      const len=(el.innerText||'').length;

      if(len<7000) s+=8;
      if(len<3500) s+=8;

      if(s>score){
        score=s;
        best=el;
      }
    }

    return best;
  }

  function getSectionRows(section){
    if(!section) return [];

    return [...section.querySelectorAll('tr,[role="row"],div')]
      .filter(isVisible)
      .filter(el=>{
        const t=normalizeText(el.innerText||el.textContent||'');
        return t&&t.length<2500;
      });
  }

  function findRowInSection(section,label){
    const rows=getSectionRows(section);
    const target=normalizeText(label);
    let best=null, bestScore=-1;

    for(const row of rows){
      const t=normalizeText(row.innerText||row.textContent||'');

      if(!t.includes(target)) continue;

      let s=0;

      if(t.startsWith(target)) s+=50;
      if(t.includes(target)) s+=20;
      if([...row.children].filter(isVisible).length>=2) s+=10;

      s+=Math.min(extractNumbers(row.innerText||row.textContent||'').length,8);

      if(t.length<220) s+=15;
      if(t.length<380) s+=5;

      if(s>bestScore){
        bestScore=s;
        best=row;
      }
    }

    return best;
  }

  function getParts(row){
    if(!row) return [];

    let kids=[...row.children].filter(isVisible);

    if(kids.length<2){
      kids=[...row.querySelectorAll(':scope > div,:scope > span,:scope > td,:scope > th')].filter(isVisible);
    }

    if(kids.length>=2){
      return kids.map((kid,idx)=>({
        idx,
        text:normalizeText(kid.innerText||kid.textContent||''),
        rawText:kid.innerText||kid.textContent||'',
        nums:extractNumbers(kid.innerText||kid.textContent||'')
      }));
    }

    return [{
      idx:0,
      text:normalizeText(row.innerText||row.textContent||''),
      rawText:row.innerText||row.textContent||'',
      nums:extractNumbers(row.innerText||row.textContent||'')
    }];
  }

  function detectPlanColumnValue(section,label){
    const row=findRowInSection(section,label);
    if(!row) return NaN;

    const parts=getParts(row);
    const rowNums=extractNumbers(row.innerText||row.textContent||'');
    const labelNorm=normalizeText(label);

    let labelIdx=parts.findIndex(p=>p.text.includes(labelNorm));
    if(labelIdx===-1) labelIdx=0;

    const right=parts.filter(p=>p.idx>labelIdx);

    if(!right.length) return rowNums.length?rowNums[rowNums.length-1]:NaN;

    if(['fluid load jobs','manual palletize jobs','rwc jobs'].includes(labelNorm)){
      const c=[];

      for(const p of right){
        for(const num of p.nums){
          let s=0;

          if(num>=1000) s+=50;
          if(p.idx>=labelIdx+2) s+=15;
          if(p.idx>=labelIdx+3) s+=25;
          if(p.idx>=labelIdx+4) s+=25;

          c.push({num,score:s,idx:p.idx});
        }
      }

      if(c.length) return c.sort((a,b)=>b.score-a.score||b.idx-a.idx)[0].num;

      const big=rowNums.filter(n=>n>=1000);
      return big.length?big[big.length-1]:NaN;
    }

    if(labelNorm==='fluid load rate'){
      const c=[];

      for(const p of right){
        const out=firstNumberOutsideParens(p.rawText);

        if(Number.isFinite(out)){
          let s=0;

          if(out>0&&out<350) s+=60;
          if(p.idx>=labelIdx+2) s+=20;
          if(p.idx>=labelIdx+3) s+=25;

          c.push({num:out,score:s,idx:p.idx});
        }
      }

      if(c.length) return c.sort((a,b)=>b.score-a.score||b.idx-a.idx)[0].num;

      const nums=rowNums.filter(n=>n>0&&n<350);
      return nums.length?nums[nums.length-1]:NaN;
    }

    if(labelNorm.includes('wall builder')&&labelNorm.includes('hc')){
      const c=[];

      for(const p of right){
        const out=firstNumberOutsideParens(p.rawText);

        if(Number.isFinite(out)){
          let s=0;

          if(out>0&&out<500) s+=60;
          if(p.idx>=labelIdx+2) s+=20;
          if(p.idx>=labelIdx+3) s+=25;

          c.push({num:out,score:s,idx:p.idx});
        }
      }

      if(c.length) return c.sort((a,b)=>b.score-a.score||b.idx-a.idx)[0].num;
    }

    return rowNums.length?rowNums[rowNums.length-1]:NaN;
  }

  function findPlanSummarySection(){
    const candidates=[...document.querySelectorAll('div,section,article')].filter(isVisible);
    let best=null,bestScore=-1;

    for(const el of candidates){
      const t=normalizeText(el.innerText||el.textContent||'');

      if(!t.includes('plan summary')) continue;

      let s=0;

      if(t.includes('ship sort diverts')) s+=50;
      if(t.includes('fl & palletize jobs')) s+=20;

      if(s>bestScore){
        bestScore=s;
        best=el;
      }
    }

    return best;
  }

  function detectShipSortDiverts(section){
    if(!section) return NaN;

    const text=section.innerText||section.textContent||'';

    for(const line of text.split('\n').map(s=>s.trim()).filter(Boolean)){
      if(normalizeText(line).includes('ship sort diverts')){
        const nums=extractNumbers(line);
        if(nums.length) return nums[nums.length-1];
      }
    }

    const m=text.match(/Ship Sort Diverts\s*\(FL\s*&\s*Palletize Jobs\)\s*:?\s*([\d,]+)/i);
    return m?parseNumber(m[1]):NaN;
  }

  function collectNeo(){
    const section=findTransferOutDirectSection();
    const summary=findPlanSummarySection();
    const bridge=baseBridge();

    bridge.neo={
      fluidLoadJobs:detectPlanColumnValue(section,'Fluid Load Jobs'),
      manualPalletizeJobs:detectPlanColumnValue(section,'Manual Palletize Jobs'),
      rwcJobs:detectPlanColumnValue(section,'RWC Jobs'),
      fluidLoadRate:detectPlanColumnValue(section,'Fluid Load Rate'),
      fluidLoadHC:detectPlanColumnValue(section,'Fluid Load (incl. Wall Builder) HC'),
      shipSortDiverts:detectShipSortDiverts(summary),
      updatedAt:now()
    };
    markLastPull(bridge,'neo','Shift goals');

    const saved=writeBridge(bridge);
    updatePanel(saved,'NEO goals collected');
  }

  /******************************************************************
   * FLUID ROSTER COLLECTOR
   ******************************************************************/

  function rosterSectionsFromText(doc=document){
    const text=doc.body?.innerText || doc.body?.textContent || '';
    const sections=[];
    const seen=new Set();
    const linePattern=/\b([A-Z][A-Z0-9 -]{1,40}?)\s+(\d+)\s*\/\s*(\d+)\b/g;

    const lines=text.split(/\n+/).map(cleanText).filter(Boolean);
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(!line) continue;
      linePattern.lastIndex=0;
      let match;
      while((match=linePattern.exec(line))){
        const label=cleanText(match[1]);
        if(!/[A-Z]/.test(label) || /^DD\d+/i.test(label)) continue;
        const current=parseNumber(match[2]);
        const target=parseNumber(match[3]);
        if(!Number.isFinite(current) || !Number.isFinite(target)) continue;
        const key=`${label}|${current}|${target}`;
        if(seen.has(key)) continue;
        seen.add(key);
        sections.push({
          label,
          current,
          target,
          gap: current - target
        });
      }

      const nextLine=lines[i+1]||'';
      const adjacentMatch=nextLine.match(/^(\d+)\s*\/\s*(\d+)$/);
      if(adjacentMatch && /^[A-Z][A-Z0-9 -]{1,40}$/.test(line) && !/^DD\d+/i.test(line)){
        const current=parseNumber(adjacentMatch[1]);
        const target=parseNumber(adjacentMatch[2]);
        const key=`${line}|${current}|${target}`;
        if(Number.isFinite(current) && Number.isFinite(target) && !seen.has(key)){
          seen.add(key);
          sections.push({
            label:line,
            current,
            target,
            gap: current - target
          });
        }
      }
    }

    return sections;
  }

  function normalizeFluidRosterBuckets(sections){
    const buckets=[
      { key:'west', label:'WEST-DOORS', fallbackTarget:34 },
      { key:'east', label:'EAST-DOORS', fallbackTarget:36 },
      { key:'floater', label:'FLOATER', fallbackTarget:4 }
    ];

    return buckets.map((bucket)=>{
      const hit=(sections||[]).find((item)=>{
        const label=normalizeText(item.label);
        if(bucket.key==='floater') return label.includes('floater');
        return label.includes(bucket.key) && label.includes('doors');
      });
      const current=hit && Number.isFinite(parseNumber(hit.current)) ? parseNumber(hit.current) : 0;
      const target=hit && Number.isFinite(parseNumber(hit.target)) ? parseNumber(hit.target) : bucket.fallbackTarget;
      return {
        label:bucket.label,
        current,
        target,
        gap:current - target
      };
    });
  }

  function rosterSectionsFromCheckedBoxes(){
    const checked=[...document.querySelectorAll('input[type="checkbox"]:checked')]
      .filter(isVisible)
      .map((input)=>{
        let node=input.parentElement;
        let depth=0;
        while(node && depth<8){
          const text=cleanText(node.innerText||node.textContent||'');
          const match=text.match(/\b([A-Z][A-Z0-9 -]{1,40}?)\s*\(\s*(\d+)\s*\)/);
          if(match){
            const label=cleanText(match[1]);
            const count=parseNumber(match[2]);
            return {
              label,
              current: Number.isFinite(count) ? count : 1,
              target: 0,
              gap: Number.isFinite(count) ? count : 1
            };
          }
          node=node.parentElement;
          depth++;
        }
        return null;
      })
      .filter(Boolean);

    const seen=new Set();
    return checked.filter((item)=>{
      const key=`${item.label}|${item.current}`;
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function collectFluidRoster(){
    const sections=rosterSectionsFromText();
    const groups=sections.length ? normalizeFluidRosterBuckets(sections) : normalizeFluidRosterBuckets(rosterSectionsFromCheckedBoxes());
    const headcount=groups.reduce((sum,item)=>sum+item.current,0);
    const target=groups.reduce((sum,item)=>sum+item.target,0);
    const bridge=baseBridge();
    bridge.roster=bridge.roster||{};
    bridge.roster.fluid={
      headcount,
      target,
      gap: headcount - target,
      groups,
      updatedAt:now(),
      url:location.href
    };
    markLastPull(bridge,'roster',target>0 ? `${fmt(headcount)}/${fmt(target)} Fluid HC` : `${fmt(headcount)} Fluid HC`);

    const saved=writeBridge(bridge);
    updatePanel(saved,target>0 ? `Fluid roster HC collected: ${fmt(headcount)}/${fmt(target)}` : `Fluid roster HC collected: ${fmt(headcount)}`);
  }

  async function pullFluidRosterInBackground(){
    if(!isDashboard){
      updatePanel(readBridge(),'Open the dashboard to use background Fluid Roster pull');
      return;
    }
    if(typeof GM_xmlhttpRequest!=='function'){
      updatePanel(readBridge(),'GM_xmlhttpRequest unavailable for Fluid Roster pull');
      return;
    }
    updatePanel(readBridge(),'Pulling Fluid Roster in background...');
    return new Promise((resolve)=>{
      GM_xmlhttpRequest({
        method:'GET',
        url:CONFIG.fluidRosterUrl,
        timeout:20000,
        onload:(res)=>{
          if(res.status<200||res.status>=300){
            updatePanel(readBridge(),`Fluid Roster pull failed: HTTP ${res.status}`);
            resolve(readBridge());
            return;
          }
          const doc=new DOMParser().parseFromString(res.responseText||'','text/html');
          const sections=rosterSectionsFromText(doc);
          const groups=normalizeFluidRosterBuckets(sections.length?sections:[]);
          const headcount=groups.reduce((sum,item)=>sum+item.current,0);
          const target=groups.reduce((sum,item)=>sum+item.target,0);
          const bridge=baseBridge();
          bridge.roster=bridge.roster||{};
          bridge.roster.fluid={
            headcount,
            target,
            gap:headcount-target,
            groups,
            updatedAt:now(),
            url:CONFIG.fluidRosterUrl
          };
          markLastPull(bridge,'roster',target>0?`${fmt(headcount)}/${fmt(target)} Fluid HC`:`${fmt(headcount)} Fluid HC`);
          const saved=writeBridge(bridge);
          fillDashboard(saved);
          updatePanel(saved,target>0?`Fluid roster: ${fmt(headcount)}/${fmt(target)} HC collected`:`Fluid roster: ${fmt(headcount)} HC collected`);
          resolve(saved);
        },
        onerror:()=>{
          updatePanel(readBridge(),'Fluid Roster pull failed: request error');
          resolve(readBridge());
        },
        ontimeout:()=>{
          updatePanel(readBridge(),'Fluid Roster pull timed out');
          resolve(readBridge());
        }
      });
    });
  }

  /******************************************************************
   * FCLM COLLECTOR
   ******************************************************************/

  function visibleTextElements(){
    return Array.from(document.querySelectorAll('td,th,div,span,a')).filter(el=>{
      const txt=cleanText(el.textContent);
      if(!txt) return false;

      const st=getComputedStyle(el);
      return st.display!=='none'&&st.visibility!=='hidden';
    });
  }

  function findElementExact(text){
    const target=cleanText(text).toLowerCase();
    return visibleTextElements().find(el=>cleanText(el.textContent).toLowerCase()===target)||null;
  }

  function findElementContaining(text){
    const target=cleanText(text).toLowerCase();
    return visibleTextElements().find(el=>cleanText(el.textContent).toLowerCase().includes(target))||null;
  }

  function getRowCells(row){
    if(!row) return [];
    return Array.from(row.querySelectorAll('td,th')).map(c=>cleanText(c.textContent));
  }

  function findNumericValuesInRow(row){
    return getRowCells(row).map(parseNumber).filter(Number.isFinite);
  }

  function findSectionTotalJobs(sectionLabel){
    const sectionEl=findElementExact(sectionLabel)||findElementContaining(sectionLabel);
    const sectionRow=sectionEl?sectionEl.closest('tr'):null;

    if(!sectionRow) return NaN;

    let row=sectionRow;
    let safety=0;

    while(row&&safety<30){
      const cells=getRowCells(row).map(t=>t.toLowerCase());
      const rowText=cleanText(row.textContent).toLowerCase();

      if(cells.includes('total')||rowText.includes(' total ')){
        const nums=findNumericValuesInRow(row);
        const jobs=nums.find(n=>Number.isInteger(n)&&n>0);

        if(Number.isFinite(jobs)) return jobs;
      }

      row=row.nextElementSibling;
      safety++;
    }

    return NaN;
  }

  function findWallBuilderRate(){
    const wbEl=findElementExact('Wall Builder')||findElementContaining('Wall Builder');
    const wbRow=wbEl?wbEl.closest('tr'):null;

    if(!wbRow) return NaN;

    let row=wbRow;
    let safety=0;

    while(row&&safety<16){
      const cells=getRowCells(row).map(t=>t.toLowerCase());
      const rowText=cleanText(row.textContent).toLowerCase();

      if(cells.includes('total')||rowText.includes(' total ')){
        const nums=findNumericValuesInRow(row);

        const dec=nums.find(n=>!Number.isInteger(n)&&n>0);
        if(Number.isFinite(dec)) return dec;

        const fallback=nums.find(n=>n>0);
        if(Number.isFinite(fallback)) return fallback;
      }

      row=row.nextElementSibling;
      safety++;
    }

    return NaN;
  }

  function collectFclm(){
    const period=classifyFclmPeriod();
    const totesJobs=findSectionTotalJobs('Fluid Load - Tote');
    const casesJobs=findSectionTotalJobs('Fluid Load - Case');

    const totalJobs=
      (Number.isFinite(totesJobs)?totesJobs:0)+
      (Number.isFinite(casesJobs)?casesJobs:0);

    const wallBuilderRate=findWallBuilderRate();

    const jplh=
      Number.isFinite(wallBuilderRate)&&wallBuilderRate>0
        ? totalJobs/wallBuilderRate
        : NaN;

    const payload={
      totesJobs,
      casesJobs,
      totalJobs,
      wallBuilderRate,
      jplh,
      updatedAt:now(),
      period
    };

    const bridge=baseBridge();
    bridge.fclmPeriods=bridge.fclmPeriods||{};

    if(period==='full'||period==='unknown'){
      bridge.fclmFull=mergeFclmPayload(bridge.fclmFull,payload);
    } else {
      bridge.fclmPeriods[period]=mergeFclmPayload(bridge.fclmPeriods[period],payload);
    }
    markLastPull(bridge,'fclm',period.toUpperCase());

    const saved=writeBridge(bridge);
    updatePanel(saved,`FCLM ${period.toUpperCase()} collected`);
  }

  function parseFclmDocument(doc,period){
    const textEls=()=>Array.from(doc.querySelectorAll('td,th,div,span,a')).filter(el=>cleanText(el.textContent));
    const exact=(text)=>{
      const target=cleanText(text).toLowerCase();
      return textEls().find(el=>cleanText(el.textContent).toLowerCase()===target)||null;
    };
    const containing=(text)=>{
      const target=cleanText(text).toLowerCase();
      return textEls().find(el=>cleanText(el.textContent).toLowerCase().includes(target))||null;
    };
    const rowCells=(row)=>row?Array.from(row.querySelectorAll('td,th')).map(c=>cleanText(c.textContent)):[];
    const numsInRow=(row)=>rowCells(row).map(parseNumber).filter(Number.isFinite);
    const sectionTotal=(sectionLabel)=>{
      const sectionEl=exact(sectionLabel)||containing(sectionLabel);
      const sectionRow=sectionEl?sectionEl.closest('tr'):null;
      if(!sectionRow) return NaN;
      let row=sectionRow,safety=0;
      while(row&&safety<30){
        const cells=rowCells(row).map(t=>t.toLowerCase());
        const rowText=cleanText(row.textContent).toLowerCase();
        if(cells.includes('total')||rowText.includes(' total ')){
          const nums=numsInRow(row);
          const jobs=nums.find(n=>Number.isInteger(n)&&n>0);
          if(Number.isFinite(jobs)) return jobs;
        }
        row=row.nextElementSibling;
        safety++;
      }
      return NaN;
    };
    const wallBuilder=()=>{
      const wbEl=exact('Wall Builder')||containing('Wall Builder');
      const wbRow=wbEl?wbEl.closest('tr'):null;
      if(!wbRow) return NaN;
      let row=wbRow,safety=0;
      while(row&&safety<16){
        const cells=rowCells(row).map(t=>t.toLowerCase());
        const rowText=cleanText(row.textContent).toLowerCase();
        if(cells.includes('total')||rowText.includes(' total ')){
          const nums=numsInRow(row);
          const dec=nums.find(n=>!Number.isInteger(n)&&n>0);
          if(Number.isFinite(dec)) return dec;
          const fallback=nums.find(n=>n>0);
          if(Number.isFinite(fallback)) return fallback;
        }
        row=row.nextElementSibling;
        safety++;
      }
      return NaN;
    };

    const totesJobs=sectionTotal('Fluid Load - Tote');
    const casesJobs=sectionTotal('Fluid Load - Case');
    const totalJobs=(Number.isFinite(totesJobs)?totesJobs:0)+(Number.isFinite(casesJobs)?casesJobs:0);
    const wallBuilderRate=wallBuilder();
    const jplh=Number.isFinite(wallBuilderRate)&&wallBuilderRate>0?totalJobs/wallBuilderRate:NaN;

    return {totesJobs,casesJobs,totalJobs,wallBuilderRate,jplh,updatedAt:now(),period};
  }

  function withRetry(factory,maxRetries=2,baseDelay=2000){
    const attempt=(n)=>factory().catch(err=>{
      if(n>=maxRetries) throw err;
      return new Promise(r=>setTimeout(r,baseDelay*(n+1))).then(()=>attempt(n+1));
    });
    return attempt(0);
  }

  function fetchFclmPayload(key){
    const url=buildFclmUrl(key);
    const attempt=()=>new Promise((resolve,reject)=>{
      if(typeof GM_xmlhttpRequest!=='function'){
        reject(new Error('GM_xmlhttpRequest unavailable'));
        return;
      }
      GM_xmlhttpRequest({
        method:'GET',
        url,
        timeout:20000,
        onload:(res)=>{
          if(res.status<200||res.status>=300){
            reject(new Error(`FCLM ${key.toUpperCase()} HTTP ${res.status}`));
            return;
          }
          const doc=new DOMParser().parseFromString(res.responseText||'','text/html');
          resolve(parseFclmDocument(doc,key));
        },
        onerror:()=>reject(new Error(`FCLM ${key.toUpperCase()} request failed`)),
        ontimeout:()=>reject(new Error(`FCLM ${key.toUpperCase()} request timed out`))
      });
    });
    return withRetry(attempt);
  }

  async function pullFclmInBackground(periods=null,options={}){
    if(!isDashboard){
      updatePanel(readBridge(),'Open the dashboard to use background FCLM pull');
      return;
    }

    const includeMET=Boolean(options.includeMET);
    const pullPeriods=periods || (includeMET?['full','p1','p2','p3','met']:['full','p1','p2','p3']);
    fclmPullContext={
      shiftDate: options.shiftDate || document.getElementById('shiftDate')?.value || '',
      includeMET
    };

    updatePanel(readBridge(),'Pulling FCLM in background...');

    try{
      const settled=await Promise.allSettled(pullPeriods.map(k=>fetchFclmPayload(k).then(payload=>[k,payload])));
      const results=settled.filter(item=>item.status==='fulfilled').map(item=>item.value);
      const failures=settled.filter(item=>item.status==='rejected').map(item=>item.reason?.message||String(item.reason));
      const bridge=baseBridge();
      bridge.fclmPeriods=bridge.fclmPeriods||{};

      for(const [key,payload] of results){
        if(key==='full'||key==='unknown'){
          bridge.fclmFull=mergeFclmPayload(bridge.fclmFull,payload);
        } else {
          bridge.fclmPeriods[key]=mergeFclmPayload(bridge.fclmPeriods[key],payload);
        }
      }

      markLastPull(bridge,options.source || (options.includeMonitor?'all':'fclm'),pullPeriods.map(k=>k.toUpperCase()).join(', '));
      const saved=writeBridge(bridge);
      fillDashboard(saved);
      updatePanel(saved,failures.length?`${sourceLabel(options.source || 'fclm')} partial pull complete; ${failures.length} window(s) failed`:`${sourceLabel(options.source || 'fclm')} pull complete`);
      if(options.includeMonitor){
        // Live-tab mode: monitor numbers are JS-rendered and monitorportal blocks
        // framing, so we cannot pull them silently. Open the graph tabs instead.
        openMonitorPeriods(options.monitorTypes || ['flUtil','belt']);
      }
    }catch(err){
      console.warn('[PRC V2 Hybrid] FCLM background pull failed:',err);
      updatePanel(readBridge(),`FCLM pull failed: ${err.message}`);
    }finally{
      fclmPullContext=null;
    }
  }

  /******************************************************************
   * MONITORPORTAL COLLECTOR
   ******************************************************************/

  function monitorText(){
    const parts=[cleanText(document.body?.innerText||document.body?.textContent||'')];

    document.querySelectorAll('svg text,text,td,th,div,span,a').forEach(el=>{
      const t=cleanText(el.textContent);
      if(t) parts.push(t);
    });

    return parts.join('\n');
  }

  function numberAfterLabels(text, labels){
    for(const label of labels){
      const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      // igraph renders legends in several shapes depending on DecoratePoints:
      //   West Side: 102,394        {West Side}: 102,394
      //   West Side[total: 102,394.00]    {West Side}[total: 102,394.00]: 102,394 (52.1%)
      // The [total: X] value is authoritative, so try those shapes first.
      const patterns=[
        new RegExp(`\\{?${escaped}\\}?\\s*\\[?\\s*total\\s*:?\\s*([\\d,]+(?:\\.\\d+)?)`,'i'),
        new RegExp(`${escaped}\\s*[:\\-]?\\s*([\\d,]+(?:\\.\\d+)?)`,'i'),
        new RegExp(`\\{?${escaped}\\}?\\s*[:\\-]?\\s*([\\d,]+(?:\\.\\d+)?)`,'i'),
        new RegExp(`\\{?${escaped}\\}?[^0-9\\n]{0,16}([\\d,]+(?:\\.\\d+)?)`,'i')
      ];

      for(const pattern of patterns){
        const match=text.match(pattern);
        if(match) return parseNumber(match[1]);
      }
    }

    return NaN;
  }

  function monitorMetricTotal(text,label){
    const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const patterns=[
      new RegExp(`TOTAL\\s+${escaped}\\s*\\[\\s*total\\s*:\\s*([\\d,]+(?:\\.\\d+)?)\\s*\\]`,'i'),
      new RegExp(`TOTAL\\s+${escaped}\\s*\\{?\\s*total\\s*:?\\s*([\\d,]+(?:\\.\\d+)?)`,'i'),
      new RegExp(`TOTAL\\s+${escaped}\\s*[:\\-]?\\s*([\\d,]+(?:\\.\\d+)?)`,'i')
    ];
    for(const pattern of patterns){
      const match=text.match(pattern);
      if(match) return parseNumber(match[1]);
    }
    return numberAfterLabels(text,[`TOTAL ${label}`,label]);
  }

  function collectMonitor(){
    const period=classifyMonitorPeriod();
    const type=classifyMonitorType();
    const text=monitorText();
    const bridge=baseBridge();

    bridge.monitorPeriods=bridge.monitorPeriods||{};
    bridge.monitorFull=bridge.monitorFull||{};

    const target=period==='full'||period==='unknown'
      ? bridge.monitorFull
      : (bridge.monitorPeriods[period]=bridge.monitorPeriods[period]||{});

    if(type==='flUtil'){
      const mp=monitorMetricTotal(text,'MP');
      const fl=monitorMetricTotal(text,'FL');
      const rwc=monitorMetricTotal(text,'RWC');

      if(![mp,fl,rwc].some(Number.isFinite)){
        updatePanel(readBridge(),`Monitor ${period.toUpperCase()} FL waiting for chart render...`);
        return;
      }

      target.flUtil=mergeFlUtil(target.flUtil,{
        mp:Number.isFinite(mp)?mp:undefined,
        fl:Number.isFinite(fl)?fl:undefined,
        rwc:Number.isFinite(rwc)?rwc:undefined,
        updatedAt:now(),
        period
      });

      markLastPull(bridge,'flUtil',period.toUpperCase());
      const saved=writeBridge(bridge);
      updatePanel(saved,`Monitor ${period.toUpperCase()} FL collected`);
      return;
    }

    if(type==='belt'){
      const west=numberAfterLabels(text,['West Side']);
      const east=numberAfterLabels(text,['East Side']);

      if(![west,east].some(Number.isFinite)){
        updatePanel(readBridge(),`Monitor ${period.toUpperCase()} Belt waiting for chart render...`);
        return;
      }

      target.belt=mergeBelt(target.belt,{
        east:Number.isFinite(east)?east:undefined,
        west:Number.isFinite(west)?west:undefined,
        updatedAt:now(),
        period
      });

      markLastPull(bridge,'belt',period.toUpperCase());
      const saved=writeBridge(bridge);
      updatePanel(saved,`Monitor ${period.toUpperCase()} Belt collected`);
      return;
    }

    updatePanel(readBridge(),'Monitor graph type not recognized');
  }

  function parseMonitorPayload(type,period,doc){
    const text=monitorTextFromDocument(doc);
    if(type==='flUtil'){
      const mp=monitorMetricTotal(text,'MP');
      const fl=monitorMetricTotal(text,'FL');
      const rwc=monitorMetricTotal(text,'RWC');
      return {
        flUtil:{
          mp:Number.isFinite(mp)?mp:undefined,
          fl:Number.isFinite(fl)?fl:undefined,
          rwc:Number.isFinite(rwc)?rwc:undefined,
          updatedAt:now(),
          period
        }
      };
    }

    const west=numberAfterLabels(text,['West Side']);
    const east=numberAfterLabels(text,['East Side']);
    return {
      belt:{
        east:Number.isFinite(east)?east:undefined,
        west:Number.isFinite(west)?west:undefined,
        updatedAt:now(),
        period
      }
    };
  }

  function monitorTextFromDocument(doc){
    const parts=[cleanText(doc.body?.innerText||doc.body?.textContent||'')];
    doc.querySelectorAll('svg text,text,td,th,div,span,a').forEach(el=>{
      const t=cleanText(el.textContent);
      if(t) parts.push(t);
    });
    return parts.join('\n');
  }

  function fetchMonitorPayload(type,key){
    const url=type==='belt'?buildMonitorBeltUrl(key):buildMonitorFlUtilUrl(key);
    return new Promise((resolve,reject)=>{
      if(typeof GM_xmlhttpRequest!=='function'){
        reject(new Error('GM_xmlhttpRequest unavailable'));
        return;
      }
      GM_xmlhttpRequest({
        method:'GET',
        url,
        timeout:25000,
        onload:(res)=>{
          if(res.status<200||res.status>=300){
            reject(new Error(`Monitor ${key.toUpperCase()} ${type} HTTP ${res.status}`));
            return;
          }
          const doc=new DOMParser().parseFromString(res.responseText||'','text/html');
          resolve([key,type,parseMonitorPayload(type,key,doc)]);
        },
        onerror:()=>reject(new Error(`Monitor ${key.toUpperCase()} ${type} request failed`)),
        ontimeout:()=>reject(new Error(`Monitor ${key.toUpperCase()} ${type} request timed out`))
      });
    });
  }

  // NOTE: kept for completeness, but in LIVE-TAB MODE this raw background fetch
  // returns only monitorportal's empty JS app shell (no numbers) - the diagnostic
  // confirms the totals are drawn client-side. The live graph tabs are the source.
  async function pullMonitorInBackground(periods=['full','p1','p2','p3'],types=['flUtil','belt'],source=null){
    if(!isDashboard){
      updatePanel(readBridge(),'Open the dashboard to use background Monitor pull');
      return readBridge();
    }

    const monitorTypes=(types||['flUtil','belt']).filter(type=>['flUtil','belt'].includes(type));
    const sourceKey=source || (monitorTypes.length===1?monitorTypes[0]:'all');
    updatePanel(readBridge(),`Pulling ${sourceLabel(sourceKey)}...`);
    const jobs=[];
    periods.forEach(key=>{
      monitorTypes.forEach(type=>jobs.push(fetchMonitorPayload(type,key)));
    });

    const settled=await Promise.allSettled(jobs);
    const results=settled.filter(item=>item.status==='fulfilled').map(item=>item.value);
    const failures=settled.filter(item=>item.status==='rejected').map(item=>item.reason?.message||String(item.reason));
    const bridge=baseBridge();
    bridge.monitorPeriods=bridge.monitorPeriods||{};
    bridge.monitorFull=bridge.monitorFull||{};

    for(const [key,type,payload] of results){
      const target=key==='full'||key==='unknown'
        ? bridge.monitorFull
        : (bridge.monitorPeriods[key]=bridge.monitorPeriods[key]||{});
      if(type==='flUtil') target.flUtil=mergeFlUtil(target.flUtil,payload.flUtil);
      if(type==='belt') target.belt=mergeBelt(target.belt,payload.belt);
    }

    markLastPull(bridge,sourceKey,periods.map(k=>k.toUpperCase()).join(', '));
    const saved=writeBridge(bridge);
    fillDashboard(saved);
    updatePanel(saved,failures.length?`${sourceLabel(sourceKey)} partial pull complete; ${failures.length} chart(s) failed`:`${sourceLabel(sourceKey)} pull complete`);
    return saved;
  }

  /******************************************************************
   * HIDDEN-FRAME MONITOR PULL  (legacy / fallback)
   *
   * monitorportal draws its totals with JavaScript, so a raw HTML fetch only
   * returns an empty app shell. The hidden-iframe approach loads each graph in
   * an OFF-SCREEN iframe so the browser runs monitorportal's JS there. This ONLY
   * works if monitorportal permits being framed (no X-Frame-Options / CSP
   * frame-ancestors). At RFD2 it is blocked, which is why LIVE-TAB MODE (open
   * graph tabs) is now the default. These functions are retained as a fallback.
   ******************************************************************/

  const monitorSlotKey=(type,period)=>`PRC_MONITOR_SLOT_${type}_${period}`;
  const monitorAllPeriods=()=>includeMETSelected()?['full','p1','p2','p3','met']:['full','p1','p2','p3'];

  // Runs INSIDE a hidden pull frame: read this graph's rendered totals and write
  // them to a per-slot GM key. Only the dashboard merges slots into the bridge,
  // so independent frames never clobber each other.
  function storeMonitorSlotFromFrame(){
    const type=classifyMonitorType()==='belt'?'belt':'flUtil';
    const period=classifyMonitorPeriod();
    const payload=parseMonitorPayload(type,period,document);
    const isNum=(n)=>typeof n==='number'&&Number.isFinite(n);
    const v=(type==='flUtil'?payload.flUtil:payload.belt)||{};
    const hasData=type==='flUtil'
      ? [v.mp,v.fl,v.rwc].some(isNum)
      : [v.west,v.east].some(isNum);
    if(!hasData) return false; // chart not rendered yet
    GM_setValue(monitorSlotKey(type,period),{type,period,payload,updatedAt:now()});
    return true;
  }

  // Runs on the DASHBOARD: pull fresh per-slot values into the bridge.
  function harvestMonitorSlots(label){
    const bridge=baseBridge();
    bridge.monitorPeriods=bridge.monitorPeriods||{};
    bridge.monitorFull=bridge.monitorFull||{};
    let any=false;
    ['flUtil','belt'].forEach(type=>monitorAllPeriods().forEach(period=>{
      const slot=GM_getValue(monitorSlotKey(type,period),null);
      if(!slot||!slot.payload) return;
      const target=(period==='full'||period==='unknown')
        ? bridge.monitorFull
        : (bridge.monitorPeriods[period]=bridge.monitorPeriods[period]||{});
      if(type==='flUtil'&&slot.payload.flUtil){ target.flUtil=mergeFlUtil(target.flUtil,slot.payload.flUtil); any=true; }
      if(type==='belt'&&slot.payload.belt){ target.belt=mergeBelt(target.belt,slot.payload.belt); any=true; }
    }));
    if(any){
      markLastPull(bridge,'all',label||'hidden-frame pull');
      const saved=writeBridge(bridge);
      fillDashboard(saved);
    }
    return any;
  }

  function ensureMonitorFrameHost(){
    let host=document.getElementById('prcMonitorFrameHost');
    if(!host){
      host=document.createElement('div');
      host.id='prcMonitorFrameHost';
      host.style.cssText='position:fixed;left:-12000px;top:0;width:1500px;height:680px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;';
      document.body.appendChild(host);
    }
    return host;
  }

  function pullMonitorViaFrames(types=['flUtil','belt']){
    if(!isDashboard){
      updatePanel(readBridge(),'Open the dashboard to pull monitor data');
      return;
    }
    const monitorTypes=(types||['flUtil','belt']).filter(t=>['flUtil','belt'].includes(t));
    const periods=monitorAllPeriods();
    const jobs=[];
    monitorTypes.forEach(type=>periods.forEach(period=>jobs.push({type,period})));

    const label=monitorTypes.map(sourceLabel).join(' + ');
    updatePanel(readBridge(),`Pulling ${label} in hidden frames...`);

    monitorTypes.forEach(type=>periods.forEach(period=>GM_setValue(monitorSlotKey(type,period),null)));

    const host=ensureMonitorFrameHost();
    const FRAME_LIFETIME_MS=34000;

    jobs.forEach((job,i)=>{
      setTimeout(()=>{
        const url=job.type==='belt'?buildMonitorBeltUrl(job.period):buildMonitorFlUtilUrl(job.period);
        const frame=document.createElement('iframe');
        frame.src=url;
        frame.width='1460';
        frame.height='600';
        frame.setAttribute('aria-hidden','true');
        frame.style.cssText='border:0;width:1460px;height:600px;';
        host.appendChild(frame);
        setTimeout(()=>{ try{ frame.remove(); }catch(e){} },FRAME_LIFETIME_MS);
      }, i*1500);
    });

    const totalMs=jobs.length*1500 + FRAME_LIFETIME_MS;
    const poll=setInterval(()=>harvestMonitorSlots(`${label} hidden-frame pull`),3000);
    setTimeout(()=>{
      clearInterval(poll);
      const got=harvestMonitorSlots(`${label} hidden-frame pull`);
      updatePanel(readBridge(),got
        ? `${label} hidden-frame pull complete`
        : `${label} hidden-frame pull returned no data (monitorportal blocks framing - use live tabs)`);
    }, totalMs);
  }

  /******************************************************************
   * MONITOR PULL DIAGNOSTIC  (read-only; writes nothing to the bridge)
   *
   * Answers one question: does the raw background GM_xmlhttpRequest
   * response for this graph contain the totals (the path a live pull
   * would use), or are they only drawn in the live browser page?
   * Renders its own box and never touches NEO / FCLM / roster data.
   * No longer auto-opens - call window.__prcMonitorDiag() to run it.
   ******************************************************************/

  function diagFmt(n){
    return Number.isFinite(n) ? n.toLocaleString('en-US') : 'NOT FOUND';
  }

  function monitorDiagnosticSummary(text,type){
    if(type==='belt'){
      return {
        hasLabel:/West\s*Side|East\s*Side/i.test(text),
        values:[
          ['West', numberAfterLabels(text,['West Side'])],
          ['East', numberAfterLabels(text,['East Side'])]
        ],
        matches:(text.match(/(West|East)\s*Side[^\n<]{0,40}/gi)||[]).slice(0,6)
      };
    }
    return {
      hasLabel:/TOTAL\s+(MP|FL|RWC)/i.test(text),
      values:[
        ['MP', monitorMetricTotal(text,'MP')],
        ['FL', monitorMetricTotal(text,'FL')],
        ['RWC', monitorMetricTotal(text,'RWC')]
      ],
      matches:(text.match(/TOTAL\s+(MP|FL|RWC)[^\n<]{0,40}/gi)||[]).slice(0,6)
    };
  }

  function renderMonitorDiagnostic(state){
    const { type, liveInfo, rawInfo, rawError, rawHead, rawLen } = state;
    const old=document.getElementById('prcMonitorDiag');
    if(old) old.remove();

    const box=document.createElement('div');
    box.id='prcMonitorDiag';
    box.style.cssText='position:fixed;top:14px;right:14px;z-index:2147483647;width:560px;max-height:90vh;overflow:auto;background:#020817;color:#e5edf8;border:2px solid #2563eb;border-radius:12px;padding:14px 16px;font:12px/1.45 Consolas,monospace;box-shadow:0 10px 30px rgba(0,0,0,.5);';

    const r=(k,v)=>`<div style="display:flex;gap:8px;"><b style="min-width:165px;color:#93c5fd;">${k}</b><span>${v}</span></div>`;
    const valuesLine=(info)=> info.values.map(([k,v])=>`${k} ${diagFmt(v)}`).join('  /  ');

    const rawBlock = rawError ? `
      <div style="font-weight:900;color:#fca5a5;margin:10px 0 4px;">RAW BACKGROUND FETCH (live-pull path)</div>
      ${r('result','ERROR: '+rawError)}
    ` : `
      <div style="font-weight:900;color:#fde68a;margin:10px 0 4px;">RAW BACKGROUND FETCH (live-pull path)</div>
      ${r('response length', diagFmt(rawLen)+' chars')}
      ${r('label found?', rawInfo.hasLabel?'YES &#9989;':'NO &#10060;')}
      ${r('values', valuesLine(rawInfo))}
      ${r('label matches', rawInfo.matches.length?rawInfo.matches.join('  |  '):'(none)')}
      <div style="font-weight:900;color:#93c5fd;margin:8px 0 2px;">first 600 chars of raw response:</div>
      <textarea readonly style="width:100%;height:120px;background:#0b1220;color:#cbd5e1;border:1px solid #334155;border-radius:6px;font:11px/1.4 monospace;">${(rawHead||'').replace(/</g,'&lt;')}</textarea>
    `;

    const liveBlock = `
      <div style="font-weight:900;color:#fde68a;margin:10px 0 4px;">LIVE RENDERED PAGE (on-page reader)</div>
      ${r('label found?', liveInfo.hasLabel?'YES':'NO')}
      ${r('values', valuesLine(liveInfo))}
      ${r('label matches', liveInfo.matches.length?liveInfo.matches.join('  |  '):'(none)')}
    `;

    const verdict = rawError
      ? '&#9888; Background fetch failed (see error). If 401/403, the raw fetch is not authenticated &rarr; we read the live page instead.'
      : (rawInfo.hasLabel
          ? '&#9989; Numbers ARE in the raw response &rarr; a background pull could work for this graph.'
          : '&#10060; Numbers NOT in raw response (page draws them with JS) &rarr; use LIVE-TAB MODE (leave this tab open).');

    box.innerHTML=`
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:900;font-size:14px;">Monitor Pull Diagnostic &mdash; ${type==='belt'?'Battle of the Belt':'FL Utilization'}</div>
        <div>
          <button id="prcMonitorDiagRerun" style="background:#2563eb;color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;margin-right:4px;">Re-run</button>
          <button id="prcMonitorDiagClose" style="background:#1e293b;color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;">&#10005;</button>
        </div>
      </div>
      <div style="margin:8px 0;padding:8px;border-radius:8px;background:#0b1220;font-weight:900;">${verdict}</div>
      ${rawBlock}
      ${liveBlock}
      <div style="margin-top:10px;color:#94a3b8;">Screenshot this box and send it back. Tested URL = this page.</div>
    `;
    document.body.appendChild(box);
    document.getElementById('prcMonitorDiagClose')?.addEventListener('click',()=>box.remove());
    document.getElementById('prcMonitorDiagRerun')?.addEventListener('click',runMonitorDiagnostic);
  }

  function runMonitorDiagnostic(){
    if(!isMonitor) return;
    const type=classifyMonitorType()==='belt'?'belt':'flUtil';
    const liveInfo=monitorDiagnosticSummary(monitorText(),type);

    if(typeof GM_xmlhttpRequest!=='function'){
      renderMonitorDiagnostic({type,liveInfo,rawError:'GM_xmlhttpRequest unavailable (check @grant)'});
      return;
    }

    GM_xmlhttpRequest({
      method:'GET',
      url:location.href,
      timeout:25000,
      onload:(res)=>{
        const raw=res.responseText||'';
        if(res.status<200||res.status>=300){
          renderMonitorDiagnostic({type,liveInfo,rawError:`HTTP ${res.status}`,rawHead:raw.slice(0,600),rawLen:raw.length});
          return;
        }
        const doc=new DOMParser().parseFromString(raw,'text/html');
        const rawInfo=monitorDiagnosticSummary(monitorTextFromDocument(doc),type);
        renderMonitorDiagnostic({type,liveInfo,rawInfo,rawHead:raw.slice(0,600),rawLen:raw.length});
      },
      onerror:()=>renderMonitorDiagnostic({type,liveInfo,rawError:'request error (network/connect blocked)'}),
      ontimeout:()=>renderMonitorDiagnostic({type,liveInfo,rawError:'request timed out'})
    });
  }

  /******************************************************************
   * DASHBOARD PUSH
   ******************************************************************/

  function fillDashboard(payload=readBridge(),options={}){
    if(!isDashboard) return;

    const body=payload||{};
    const pushKey=`${body.updatedAt||0}|${body.lastPull?.updatedAt||0}|${body.lastPull?.detail||''}`;
    if(!options.force && pushKey && pushKey===lastDashboardPushKey) return;
    lastDashboardPushKey=pushKey;

    try{
      localStorage.setItem(CONFIG.bridgeKey,JSON.stringify(body));
      localStorage.setItem('OB_PERIOD_REPORT_CARD_BRIDGE',JSON.stringify(body));
    }catch{}

    window.postMessage({type:'PRC_V2_HYBRID_DATA',payload:body},'*');
    if(options.updatePanel) updatePanel(body,options.msg||'');
  }

  /******************************************************************
   * LIVE METRICS FETCH BRIDGE
   *
   * CORS fetch bridge so the dashboard can pull MonitorPortal Search-API
   * metric data in the background. No parsing here - the dashboard does
   * all of that via PRC_V2_LIVE_FETCH_REQUEST / PRC_V2_LIVE_FETCH_RESULT.
   ******************************************************************/

  const LIVE_BRIDGE_VERSION='1.1.0';
  const LIVE_MAX_BODY=800000;

  function liveFetchOne(item){
    return new Promise((resolve)=>{
      try{
        GM_xmlhttpRequest({
          method:'GET',
          url:item.url,
          timeout:25000,
          headers:{ Accept:'application/json, text/csv, text/plain, */*' },
          anonymous:false,
          onload:(res)=>resolve({
            id:item.id,
            url:item.url,
            finalUrl:res.finalUrl||item.url,
            ok:res.status>=200&&res.status<300,
            status:res.status,
            body:String(res.responseText||'').slice(0,LIVE_MAX_BODY)
          }),
          onerror:(err)=>resolve({
            id:item.id,
            url:item.url,
            ok:false,
            status:0,
            error:(err&&(err.error||err.message))||'network error'
          }),
          ontimeout:()=>resolve({ id:item.id, url:item.url, ok:false, status:0, error:'timeout' })
        });
      }catch(err){
        resolve({ id:item.id, url:item.url, ok:false, status:0, error:String((err&&err.message)||err) });
      }
    });
  }

  function setupLiveMetricsBridge(){
    if(!isDashboard || window.top!==window.self) return;
    if(typeof GM_xmlhttpRequest!=='function') return;

    window.addEventListener('message', async (event)=>{
      const data=event.data;
      if(!data || data.type!=='PRC_V2_LIVE_FETCH_REQUEST' || !Array.isArray(data.urls)) return;
      const results=await Promise.all(data.urls.map(liveFetchOne));
      window.postMessage({
        type:'PRC_V2_LIVE_FETCH_RESULT',
        requestId:data.requestId,
        results,
        finishedAt:Date.now()
      },'*');
    });

    const announce=()=>window.postMessage({ type:'PRC_V2_LIVE_BRIDGE_READY', version:LIVE_BRIDGE_VERSION },'*');
    announce();
    // The dashboard binds its listener during init - re-announce so it never misses us.
    setTimeout(announce,3000);
    setTimeout(announce,10000);
  }

  /******************************************************************
   * PANEL
   ******************************************************************/

  function age(ts){
    if(!ts) return 'waiting';

    const sec=Math.max(0,Math.round((now()-Number(ts))/1000));
    return sec<60?`${sec}s ago`:`${Math.floor(sec/60)}m ${sec%60}s ago`;
  }

  function openUrl(url){
    window.open(url,'_blank','noopener,noreferrer');
  }

  function openFclmPeriods(){
    const periods=includeMETSelected()?['p1','p2','p3','met']:['p1','p2','p3'];
    periods.forEach((k,i)=>setTimeout(()=>openUrl(buildFclmUrl(k)),i*250));
  }

  // Open the live FL Util / Belt graph tabs. Each tab self-collects on render and
  // self-reloads every 15 minutes, feeding fresh numbers to the dashboard.
  function openMonitorPeriods(types){
    const periods=includeMETSelected()?['p1','p2','p3','met']:['p1','p2','p3'];
    const builders=[];
    if(types.includes('flUtil')) periods.forEach(k=>builders.push(()=>openUrl(buildMonitorFlUtilUrl(k))));
    if(types.includes('belt')) periods.forEach(k=>builders.push(()=>openUrl(buildMonitorBeltUrl(k))));
    builders.forEach((fn,i)=>setTimeout(fn,i*250));
  }

  function openFullSetup(){
    // Opens the dashboard + NEO + FCLM tabs. FL Utilization and Battle of the Belt
    // are opened separately via openMonitorPeriods (live-tab mode).
    openUrl(CONFIG.dashboardUrl);
    setTimeout(()=>openUrl(CONFIG.neoUrl),250);
    setTimeout(()=>openUrl(buildFclmUrl('full')),500);
    setTimeout(openFclmPeriods,750);
  }

  function setupPanelDragAndMinimize(panel) {
    const POS_KEY = 'PRC_V2_HYBRID_PANEL_POSITION';
    const MIN_KEY = 'PRC_V2_HYBRID_PANEL_MINIMIZED';

    const header = document.getElementById('prcV2HybridHeader');
    const body = document.getElementById('prcV2HybridPanelBody');
    const minBtn = document.getElementById('prcV2HybridMinBtn');
    const resetBtn = document.getElementById('prcV2HybridResetBtn');

    function savePosition() {
      const rect = panel.getBoundingClientRect();

      GM_setValue(POS_KEY, {
        left: rect.left,
        top: rect.top
      });
    }

    function applySavedPosition() {
      const saved = GM_getValue(POS_KEY, null);

      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        panel.style.left = `${saved.left}px`;
        panel.style.top = `${saved.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      }
    }

    function setMinimized(isMinimized) {
      GM_setValue(MIN_KEY, !!isMinimized);

      if (body) {
        body.style.display = isMinimized ? 'none' : 'block';
      }

      if (minBtn) {
        minBtn.textContent = isMinimized ? 'Expand' : 'Minimize';
      }

      panel.style.width = isMinimized ? '285px' : '390px';
    }

    applySavedPosition();
    setMinimized(!!GM_getValue(MIN_KEY, false));

    minBtn?.addEventListener('click', () => {
      const currentlyMinimized = body?.style.display === 'none';
      setMinimized(!currentlyMinimized);
    });

    resetBtn?.addEventListener('click', () => {
      if(!confirm('Reset bridge data for a standard non-MET shift? Saved dashboard logs stay in the HTML app.')) return;
      GM_setValue(POS_KEY, null);

      panel.style.left = '14px';
      panel.style.bottom = '14px';
      panel.style.top = 'auto';
      panel.style.right = 'auto';

      savePosition();
      resetBridgeData();
    });

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    header?.addEventListener('mousedown', (event) => {
      if (event.target.closest('button')) return;

      dragging = true;

      const rect = panel.getBoundingClientRect();

      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';

      document.body.style.userSelect = 'none';
      header.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (event) => {
      if (!dragging) return;

      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      let nextLeft = startLeft + dx;
      let nextTop = startTop + dy;

      const maxLeft = window.innerWidth - panel.offsetWidth - 8;
      const maxTop = window.innerHeight - panel.offsetHeight - 8;

      nextLeft = Math.max(8, Math.min(nextLeft, maxLeft));
      nextTop = Math.max(8, Math.min(nextTop, maxTop));

      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;

      dragging = false;
      document.body.style.userSelect = '';

      if (header) {
        header.style.cursor = 'grab';
      }

      savePosition();
    });
  }

  function createPanel(){
    if(document.getElementById('prcV2HybridPanel')) return;

    const panel = document.createElement('div');
    panel.id = 'prcV2HybridPanel';

    panel.style.cssText = `
      position: fixed;
      left: 14px;
      bottom: 14px;
      z-index: 999999;
      width: 390px;
      background: rgba(2, 8, 23, .96);
      color: #e5edf8;
      border: 1px solid rgba(148, 163, 184, .32);
      border-radius: 14px;
      box-shadow: 0 10px 28px rgba(0,0,0,.35);
      font-family: Arial, sans-serif;
      font-size: 12px;
      line-height: 1.35;
      overflow: hidden;
    `;

    const source = isNeo
      ? 'NEO Shift Goals'
      : isFclm
        ? `FCLM ${classifyFclmPeriod().toUpperCase()} JPLH`
        : isMonitor
          ? `Monitor ${classifyMonitorPeriod().toUpperCase()} ${classifyMonitorType()}`
          : isDashboard
            ? 'Dashboard'
            : 'Unknown';

    panel.innerHTML = `
      <div id="prcV2HybridHeader" style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        background: rgba(15, 23, 42, .98);
        border-bottom: 1px solid rgba(148, 163, 184, .25);
        cursor: grab;
      ">
        <div>
          <div style="font-weight:900;font-size:13px;">
            OB Report Card V2.1 Hybrid
          </div>
          <div style="color:#94a3b8;font-size:11px;">
            Drag me &bull; Source: <b>${source}</b>
          </div>
        </div>

        <div style="display:flex;gap:5px;">
          <button id="prcV2HybridMinBtn" class="prcBtn smallBtn" type="button">Minimize</button>
          <button id="prcV2HybridResetBtn" class="prcBtn smallBtn" type="button">Reset</button>
        </div>
      </div>

      <div id="prcV2HybridPanelBody" style="padding:10px 12px;">
        <button class="prcBtn blue" id="collectNow" type="button" style="width:100%;padding:9px;font-size:13px;margin-bottom:8px;">&#8635; Collect / Pull Now</button>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
          <button class="prcBtn" id="openFlUtil" type="button">Open FL&nbsp;Util tabs</button>
          <button class="prcBtn" id="openBelt" type="button">Open Belt tabs</button>
          <button class="prcBtn" id="openFclm" type="button">Open FCLM tabs</button>
          <button class="prcBtn" id="openAll" type="button">Open EVERYTHING</button>
        </div>

        <div id="prcV2HybridBody">Starting...</div>
      </div>
    `;

    if (!document.getElementById('prcV2HybridPanelStyle')) {
      const style = document.createElement('style');
      style.id = 'prcV2HybridPanelStyle';

      style.textContent = `
        .prcBtn {
          border: 0;
          border-radius: 9px;
          background: #334155;
          color: white;
          font-weight: 900;
          padding: 7px;
          cursor: pointer;
          font-family: Arial, sans-serif;
        }

        .prcBtn:hover {
          filter: brightness(1.15);
        }

        .prcBtn.blue {
          background: #2563eb;
        }

        .prcBtn.smallBtn {
          font-size: 10px;
          padding: 5px 7px;
          border-radius: 7px;
          background: #1e293b;
          white-space: nowrap;
        }
      `;

      document.head.appendChild(style);
    }

    document.body.appendChild(panel);

    // FIX 3: wire the open-tab buttons (live-tab mode entry points).
    document.getElementById('openFlUtil')?.addEventListener('click',()=>openMonitorPeriods(['flUtil']));
    document.getElementById('openBelt')?.addEventListener('click',()=>openMonitorPeriods(['belt']));
    document.getElementById('openFclm')?.addEventListener('click',()=>openFclmPeriods());
    document.getElementById('openAll')?.addEventListener('click',()=>{ openFullSetup(); openMonitorPeriods(['flUtil','belt']); });

    document.getElementById('collectNow')?.addEventListener('click', () => {
      run();
      if(isDashboard){
        pullFluidRosterInBackground();
        pullFclmInBackground(undefined,{
          shiftDate: document.getElementById('shiftDate')?.value || '',
          includeMET: document.getElementById('useMET')?.value === 'true',
          includeMonitor: false,
          source: 'fclm'
        });
        // Monitor numbers come from open FL Util / Belt tabs (live-tab mode), not a
        // silent pull. Re-push whatever those tabs have already written.
        fillDashboard(readBridge(),{force:true});
        updatePanel(readBridge(),'Pulled FCLM + roster. For FL Util / Belt, click "Open FL Util / Belt tabs".');
      }
    });

    setupPanelDragAndMinimize(panel);
  }

  function updatePanel(payload=readBridge(),msg=''){
    const body=document.getElementById('prcV2HybridBody');
    if(!body) return;

    const p=payload.fclmPeriods||{};
    const m=payload.monitorPeriods||{};
    const roster=payload.roster?.fluid||{};
    const includeMET=Boolean(payload.shift?.includeMET) || document.getElementById('useMET')?.value === 'true';
    const lastPull=payload.lastPull;

    body.innerHTML=`
      ${msg?`<div style="color:#fde68a;font-weight:900;margin-bottom:6px;">${msg}</div>`:''}

      <div>Last Pull: <b>${lastPull?.label || 'Waiting'}</b>${lastPull?.updatedAt?` | ${age(lastPull.updatedAt)}`:''}</div>

      <div>NEO: <b>${age(payload.neo?.updatedAt)}</b></div>
      <div>Fluid Roster: <b>${age(roster.updatedAt)}</b> | HC ${fmt(roster.headcount)}${roster.target?`/${fmt(roster.target)} (${roster.gap>=0?'+':''}${fmt(roster.gap)})`:''}${roster.groups?.length?` | ${roster.groups.map((g)=>`${g.label} ${fmt(g.current)}${g.target?`/${fmt(g.target)}`:''}`).join(', ')}`:''}</div>
      <div>FCLM Full: <b>${age(payload.fclmFull?.updatedAt)}</b></div>

      <hr style="border:0;border-top:1px solid rgba(148,163,184,.25);margin:7px 0;">

      <div>P1: <b>${age(p.p1?.updatedAt)}</b> | Jobs ${fmt(p.p1?.totalJobs)} | JPLH ${fmt(p.p1?.jplh,2)}</div>
      <div>P2: <b>${age(p.p2?.updatedAt)}</b> | Jobs ${fmt(p.p2?.totalJobs)} | JPLH ${fmt(p.p2?.jplh,2)}</div>
      <div>P3: <b>${age(p.p3?.updatedAt)}</b> | Jobs ${fmt(p.p3?.totalJobs)} | JPLH ${fmt(p.p3?.jplh,2)}</div>
      ${includeMET?`<div>MET: <b>${age(p.met?.updatedAt)}</b> | Jobs ${fmt(p.met?.totalJobs)} | JPLH ${fmt(p.met?.jplh,2)}</div>`:''}

      <hr style="border:0;border-top:1px solid rgba(148,163,184,.25);margin:7px 0;">

      <div>Monitor P1: FL <b>${age(m.p1?.flUtil?.updatedAt)}</b> | Belt <b>${age(m.p1?.belt?.updatedAt)}</b></div>
      <div>Monitor P2: FL <b>${age(m.p2?.flUtil?.updatedAt)}</b> | Belt <b>${age(m.p2?.belt?.updatedAt)}</b></div>
      <div>Monitor P3: FL <b>${age(m.p3?.flUtil?.updatedAt)}</b> | Belt <b>${age(m.p3?.belt?.updatedAt)}</b></div>
      ${includeMET?`<div>Monitor MET: FL <b>${age(m.met?.flUtil?.updatedAt)}</b> | Belt <b>${age(m.met?.belt?.updatedAt)}</b></div>`:''}
    `;
  }

  /******************************************************************
   * RUNNERS
   ******************************************************************/

  let lastRefresh=GM_getValue('PRC_V2_HYBRID_LAST_REFRESH_'+location.href.slice(0,90),0);

  function maybeRefresh(){
    if(!isFclm) return;

    if(now()-Number(lastRefresh||0)<CONFIG.refreshMinutes*60*1000) return;

    lastRefresh=now();
    GM_setValue('PRC_V2_HYBRID_LAST_REFRESH_'+location.href.slice(0,90),lastRefresh);

    collectFclm();

    setTimeout(()=>location.replace(buildFclmUrl(classifyFclmPeriod())),800);
  }

  // monitorportal draws the totals with JavaScript, so they can only be read
  // from a rendered tab. Each open FL Util / Belt graph tab self-collects and
  // reloads every 15 minutes to keep the bridge -> dashboard numbers live.
  let lastMonitorRefresh=GM_getValue('PRC_MONITOR_LAST_REFRESH_'+location.href.slice(0,90),0);

  function maybeMonitorRefresh(){
    if(!isMonitor) return;

    if(now()-Number(lastMonitorRefresh||0)<15*60*1000) return;

    lastMonitorRefresh=now();
    GM_setValue('PRC_MONITOR_LAST_REFRESH_'+location.href.slice(0,90),lastMonitorRefresh);

    try{ collectMonitor(); }catch(e){ log('monitor collect before reload failed',e); }

    setTimeout(()=>location.reload(),1500);
  }

  function run(){
    try{
      if(isNeo) collectNeo();
      if(isFluidRoster) collectFluidRoster();
      if(isFclm) collectFclm();
      if(isMonitor) collectMonitor();
      if(isDashboard) fillDashboard(readBridge());
    }catch(e){
      console.warn('[PRC V2 Hybrid] run failed:',e);
      updatePanel(readBridge(),'Collection failed');
    }
  }

  const inHiddenPullFrame = isMonitor && window.top !== window.self;

  function boot(){
    if(inHiddenPullFrame){
      // This instance is running inside a dashboard-created off-screen iframe.
      // No UI: as the chart renders, write this graph's totals to a per-slot key
      // that the dashboard merges (avoids cross-frame write races on the bridge).
      [2500,5000,8000,12000,16000,20000,26000].forEach(ms=>setTimeout(()=>{
        try{ storeMonitorSlotFromFrame(); }catch(e){ log('frame slot store failed',e); }
      },ms));
      return;
    }

    createPanel();

    if(!quietDashboard){
      setTimeout(run,1300);
      setInterval(run,15000);
    } else {
      // FIX 2: quiet dashboard (your index.html) still pushes the latest bridge
      // data into the page on load and on a steady cadence, so live-tab updates
      // and background pulls actually show up.
      setTimeout(()=>{ if(isDashboard) fillDashboard(readBridge(),{force:true}); },1200);
      setInterval(()=>{
        if(isDashboard) fillDashboard(readBridge());
        updatePanel(readBridge());
      },15000);
    }
    setInterval(maybeRefresh,10000);

    if(isDashboard && typeof GM_addValueChangeListener==='function'){
      // Cross-tab sync: when a live graph tab (or NEO/FCLM/roster tab) writes the
      // bridge, push the new value straight into this dashboard page.
      GM_addValueChangeListener(CONFIG.bridgeKey,(_name,_old,newVal)=>fillDashboard(newVal||{}));
    }

    setupLiveMetricsBridge();

    if(isDashboard){
      window.addEventListener('message',(event)=>{
        if(event.source!==window) return;
        if(event.data?.type==='PRC_V2_HYBRID_PULL_REQUEST'){
          fillDashboard(readBridge(),{force:true});
          return;
        }
        if(event.data?.type==='PRC_V2_HYBRID_FCLM_PULL'){
          pullFclmInBackground(event.data.periods,{
            shiftDate: event.data.shiftDate,
            includeMET: event.data.includeMET,
            includeMonitor: false,
            source: event.data.includeMonitor ? 'all' : 'fclm'
          });
          if(event.data.includeMonitor) openMonitorPeriods(['flUtil','belt']);
        }
        if(event.data?.type==='PRC_V2_HYBRID_SOURCE_PULL'){
          const source=event.data.source || 'all';
          const periods=event.data.periods;
          const options={
            shiftDate: event.data.shiftDate,
            includeMET: event.data.includeMET,
            source
          };
          if(source==='fclm'){
            pullFclmInBackground(periods,{...options,includeMonitor:false});
            return;
          }
          if(source==='flUtil'){
            openMonitorPeriods(['flUtil']);
            return;
          }
          if(source==='belt'){
            openMonitorPeriods(['belt']);
            return;
          }
          pullFclmInBackground(periods,{...options,includeMonitor:false});
          openMonitorPeriods(['flUtil','belt']);
        }
        if(event.data?.type==='PRC_V2_HYBRID_RESET'){
          const saved=writeBridge(event.data.payload||emptyBridge());
          fillDashboard(saved,{force:true});
          updatePanel(saved,'Bridge reset');
        }
      });
    }

    // FIX (un-gate): auto-pull FCLM + roster on ALL dashboards, including the
    // "quiet" file dashboard, so it refreshes on its own every few minutes.
    if(isDashboard){
      setTimeout(()=>pullFluidRosterInBackground(),3000);
      setInterval(()=>pullFluidRosterInBackground(),30*60*1000);
    }

    if(isDashboard){
      // LIVE-TAB MODE: monitorportal renders numbers with JS and blocks iframing,
      // so we do NOT spawn hidden frames. Open the FL Util / Belt graph tabs from
      // the panel and leave them open - each tab self-collects and writes the
      // shared bridge, which the value-change listener pushes to the page. This
      // interval is a steady backstop re-push (and harvests any legacy frame slots).
      setInterval(()=>{
        harvestMonitorSlots('live-tab pull');
        fillDashboard(readBridge());
      },30000);
    }

    if(isDashboard){
      const autoFclm=()=>pullFclmInBackground(null,{
        shiftDate:document.getElementById('shiftDate')?.value||'',
        includeMET:document.getElementById('useMET')?.value==='true',
        includeMonitor:false,
        source:'fclm'
      });
      setTimeout(autoFclm,8000);
      setInterval(autoFclm,5*60*1000);
    }

    if(isMonitor){
      // LIVE TAB MODE: leave this graph tab open. The chart renders async, so try
      // collecting at staggered delays after load, then keep re-collecting every
      // 60s - whenever the page redraws (its own Reload timer or ours), fresh
      // totals reach the dashboard within a minute. collectMonitor() skips writes
      // until numbers actually appear, so empty renders never overwrite good data.
      const tryCollect=()=>{ try{ collectMonitor(); }catch(e){ log('monitor collect failed',e); } };
      [4000,8000,15000,25000].forEach(ms=>setTimeout(tryCollect,ms));
      setInterval(tryCollect,60*1000);
      setInterval(maybeMonitorRefresh,10000);
      // FIX 5: diagnostic no longer auto-opens (it popped on every monitor tab).
      // Run it from the console when needed:  window.__prcMonitorDiag()
      window.__prcMonitorDiag = runMonitorDiagnostic;
    }

    updatePanel(readBridge());
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',boot,{once:true});
  } else {
    boot();
  }
})();
