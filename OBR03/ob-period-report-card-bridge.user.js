// ==UserScript==
// @name         OB Period Report Card V2.1 Hybrid Bridge
// @namespace    http://tampermonkey.net/
// @version      2026-04-20.7
// @description  V2 Hybrid bridge: automates NEO shift goals and FCLM JPLH per period only. FL Utilization and Battle of the Belt stay manual.
// @author       JR
// @match        https://neo.meta.amazon.dev/planning*
// @match        https://fclm-portal.amazon.com/reports/functionRollup*
// @match        https://monitorportal.amazon.com/igraph*
// @match        https://zone-ra.amazon.dev/roster/rfd2/ob/fluid/*
// @match        file:///C:/Users/jonavroa/Desktop/OBR03/dashboard.html*
// @match        http://localhost:5173/*
// @match        http://127.0.0.1:5173/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=undefined.
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      neo.meta.amazon.dev
// @connect      fclm-portal.amazon.com
// @connect      monitorportal.amazon.com
// @connect      zone-ra.amazon.dev
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    bridgeKey: 'OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE',
    dashboardUrl: 'file:///C:/Users/jonavroa/Desktop/OBR03/dashboard.html',
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
  const isDashboard =
    HREF.startsWith('file:///C:/Users/jonavroa/Desktop/OBR03/dashboard.html') ||
    HREF.startsWith('http://localhost:5173/') ||
    HREF.startsWith('http://127.0.0.1:5173/');
  let fclmPullContext = null;

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

  function cleanText(str){return String(str||'').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim();}
  function normalizeText(str){return cleanText(str).replace(/[â€“â€”]/g,'-').toLowerCase();}
  function parseNumber(v){if(v==null||v==='')return NaN; const n=Number(String(v).replace(/,/g,'').replace(/[^0-9.\-]/g,'').trim()); return Number.isFinite(n)?n:NaN;}
  function extractNumbers(text){const m=String(text||'').match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g); return (m||[]).map(parseNumber).filter(Number.isFinite);}
  function firstNumberOutsideParens(text){const nums=extractNumbers(String(text||'').replace(/\([^)]*\)/g,' ')); return nums.length?nums[0]:NaN;}
  function isVisible(el){if(!el)return false; const s=getComputedStyle(el), r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;}
  function safeClone(o){try{return JSON.parse(JSON.stringify(o||{}))}catch{return {}}}
  function fmt(n,d=0){const x=parseNumber(n);return Number.isFinite(x)?x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'--'}

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
      const metric=belt?`actDestStatus-FL_${belt} SUCCESS`:'actDestStatus-FL SUCCESS';
      u.searchParams.set(`SchemaName${n}`,'Search');
      u.searchParams.set(`Pattern${n}`,`RFD2 FL SUCCESS metric=$${metric}$ schemaname=Service methodname=$SortationOrchestrator.divert$`);
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
    pushDesktopBridge(saved);
    if(isDashboard) fillDashboard(saved);
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
      bridge.fclmFull={...(bridge.fclmFull||{}),...payload};
    } else {
      bridge.fclmPeriods[period]={...(bridge.fclmPeriods[period]||{}),...payload};
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
          bridge.fclmFull={...(bridge.fclmFull||{}),...payload};
        } else {
          bridge.fclmPeriods[key]={...(bridge.fclmPeriods[key]||{}),...payload};
        }
      }

      markLastPull(bridge,options.source || (options.includeMonitor?'all':'fclm'),pullPeriods.map(k=>k.toUpperCase()).join(', '));
      const saved=writeBridge(bridge);
      fillDashboard(saved);
      updatePanel(saved,failures.length?`${sourceLabel(options.source || 'fclm')} partial pull complete; ${failures.length} window(s) failed`:`${sourceLabel(options.source || 'fclm')} pull complete`);
      if(options.includeMonitor){
        await pullMonitorInBackground(pullPeriods,options.monitorTypes || ['flUtil','belt'],options.source || 'all');
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
      const patterns=[
        new RegExp(`${escaped}\\s*\\[?\\s*total\\s*:?\\s*([\\d,]+(?:\\.\\d+)?)`,'i'),
        new RegExp(`${escaped}\\s*[:\\-]?\\s*([\\d,]+(?:\\.\\d+)?)`,'i'),
        new RegExp(`\\{?${escaped}\\}?\\s*[:\\-]?\\s*([\\d,]+(?:\\.\\d+)?)`,'i')
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

      target.flUtil={
        mp:Number.isFinite(mp)?mp:target.flUtil?.mp,
        fl:Number.isFinite(fl)?fl:target.flUtil?.fl,
        rwc:Number.isFinite(rwc)?rwc:target.flUtil?.rwc,
        updatedAt:now(),
        period
      };

      markLastPull(bridge,'flUtil',period.toUpperCase());
      const saved=writeBridge(bridge);
      updatePanel(saved,`Monitor ${period.toUpperCase()} FL collected`);
      return;
    }

    if(type==='belt'){
      const west=numberAfterLabels(text,['West Side']);
      const east=numberAfterLabels(text,['East Side']);

      target.belt={
        east:Number.isFinite(east)?east:target.belt?.east,
        west:Number.isFinite(west)?west:target.belt?.west,
        updatedAt:now(),
        period
      };

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
    const attempt=()=>new Promise((resolve,reject)=>{
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
    return withRetry(attempt);
  }

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
      if(type==='flUtil') target.flUtil={...(target.flUtil||{}),...payload.flUtil};
      if(type==='belt') target.belt={...(target.belt||{}),...payload.belt};
    }

    markLastPull(bridge,sourceKey,periods.map(k=>k.toUpperCase()).join(', '));
    const saved=writeBridge(bridge);
    fillDashboard(saved);
    updatePanel(saved,failures.length?`${sourceLabel(sourceKey)} partial pull complete; ${failures.length} chart(s) failed`:`${sourceLabel(sourceKey)} pull complete`);
    return saved;
  }

  /******************************************************************
   * DASHBOARD PUSH
   ******************************************************************/

  function fillDashboard(payload=readBridge()){
    if(!isDashboard) return;

    try{
      localStorage.setItem(CONFIG.bridgeKey,JSON.stringify(payload));
      localStorage.setItem('OB_PERIOD_REPORT_CARD_BRIDGE',JSON.stringify(payload));
    }catch{}

    window.postMessage({type:'PRC_V2_HYBRID_DATA',payload},'*');
    updatePanel(payload,'Dashboard bridge pulled');
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

  function openFullSetup(){
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
            Drag me â€¢ Source: <b>${source}</b>
          </div>
        </div>

        <div style="display:flex;gap:5px;">
          <button id="prcV2HybridMinBtn" class="prcBtn smallBtn" type="button">Minimize</button>
          <button id="prcV2HybridResetBtn" class="prcBtn smallBtn" type="button">Reset</button>
        </div>
      </div>

      <div id="prcV2HybridPanelBody" style="padding:10px 12px;">
        <button class="prcBtn blue" id="collectNow" type="button" style="width:100%;padding:9px;font-size:13px;margin-bottom:8px;">&#8635; Collect / Pull Now</button>

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

    document.getElementById('collectNow')?.addEventListener('click', () => {
      run();
      if(isDashboard){
        pullFluidRosterInBackground();
        pullFclmInBackground(undefined,{
          shiftDate: document.getElementById('shiftDate')?.value || '',
          includeMET: document.getElementById('useMET')?.value === 'true',
          includeMonitor: true,
          source: 'all'
        });
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
const row=(label,value)=>
      `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:1px 0;">
        <span style="color:#94a3b8;font-size:11px;">${label}</span>
        <span style="font-weight:700;text-align:right;">${value}</span>
      </div>`;

    const sep=()=>`<div style="border-top:1px solid rgba(148,163,184,.18);margin:6px 0;"></div>`;

    const sectionLabel=(txt)=>
      `<div style="color:#38bdf8;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;margin-bottom:3px;">${txt}</div>`;

    const fmtAge=(ts)=>ts?`<span style="color:#a3e635;">${age(ts)}</span>`:`<span style="color:#475569;">—</span>`;

    const zoneRows=(roster.groups||[]).map(g=>{
      const gap=g.target?g.current-g.target:null;
      const gapStr=gap!==null?` <span style="color:${gap>=0?'#4ade80':'#f87171'}">(${gap>=0?'+':''}${fmt(gap)})</span>`:'';
      return row(g.label,`${fmt(g.current)}${g.target?`/${fmt(g.target)}`:''}${gapStr}`);
    }).join('');

    const rosterGap=roster.gap!=null?` <span style="color:${roster.gap>=0?'#4ade80':'#f87171'}">(${roster.gap>=0?'+':''}${fmt(roster.gap)})</span>`:'';

    body.innerHTML=`
      ${msg?`<div style="color:#fde68a;font-weight:900;padding:4px 0 6px;">${msg}</div>`:''}

      ${sectionLabel('Sources')}
      ${row('NEO',fmtAge(payload.neo?.updatedAt))}
      ${row('Fluid Roster',fmtAge(roster.updatedAt))}
      ${row('FCLM Full',fmtAge(payload.fclmFull?.updatedAt))}
      ${row('Last Pull',lastPull?.label?`${lastPull.label} ${fmtAge(lastPull.updatedAt)}`:`<span style="color:#475569;">Waiting</span>`)}

      ${sep()}
      ${sectionLabel('Fluid Roster')}
      ${row('Headcount',`${fmt(roster.headcount)}${roster.target?`/${fmt(roster.target)}`:''}${rosterGap}`)}
      ${zoneRows}

      ${sep()}
      ${sectionLabel('FCLM')}
      ${row('P1',`Jobs ${fmt(p.p1?.totalJobs)} &nbsp; JPLH ${fmt(p.p1?.jplh,2)} &nbsp; ${fmtAge(p.p1?.updatedAt)}`)}
      ${row('P2',`Jobs ${fmt(p.p2?.totalJobs)} &nbsp; JPLH ${fmt(p.p2?.jplh,2)} &nbsp; ${fmtAge(p.p2?.updatedAt)}`)}
      ${row('P3',`Jobs ${fmt(p.p3?.totalJobs)} &nbsp; JPLH ${fmt(p.p3?.jplh,2)} &nbsp; ${fmtAge(p.p3?.updatedAt)}`)}
      ${includeMET?row('MET',`Jobs ${fmt(p.met?.totalJobs)} &nbsp; JPLH ${fmt(p.met?.jplh,2)} &nbsp; ${fmtAge(p.met?.updatedAt)}`):''}

      ${sep()}
      ${sectionLabel('Monitor')}
      ${row('P1',`FL ${fmtAge(m.p1?.flUtil?.updatedAt)} &nbsp; Belt ${fmtAge(m.p1?.belt?.updatedAt)}`)}
      ${row('P2',`FL ${fmtAge(m.p2?.flUtil?.updatedAt)} &nbsp; Belt ${fmtAge(m.p2?.belt?.updatedAt)}`)}
      ${row('P3',`FL ${fmtAge(m.p3?.flUtil?.updatedAt)} &nbsp; Belt ${fmtAge(m.p3?.belt?.updatedAt)}`)}
      ${includeMET?row('MET',`FL ${fmtAge(m.met?.flUtil?.updatedAt)} &nbsp; Belt ${fmtAge(m.met?.belt?.updatedAt)}`):''}
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

  function boot(){
    createPanel();

    setTimeout(run,1300);
    setInterval(run,15000);
    setInterval(maybeRefresh,10000);

    if(isDashboard && typeof GM_addValueChangeListener==='function'){
      GM_addValueChangeListener(CONFIG.bridgeKey,(_name,_old,newVal)=>fillDashboard(newVal||{}));
    }

    if(isDashboard){
      window.addEventListener('message',(event)=>{
        if(event.source!==window) return;
        if(event.data?.type==='PRC_V2_HYBRID_PULL_REQUEST'){
          fillDashboard(readBridge());
          return;
        }
        if(event.data?.type==='PRC_V2_HYBRID_FCLM_PULL'){
          pullFclmInBackground(event.data.periods,{
            shiftDate: event.data.shiftDate,
            includeMET: event.data.includeMET,
            includeMonitor: event.data.includeMonitor,
            source: event.data.includeMonitor ? 'all' : 'fclm'
          });
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
            pullMonitorInBackground(periods,['flUtil'],'flUtil');
            return;
          }
          if(source==='belt'){
            pullMonitorInBackground(periods,['belt'],'belt');
            return;
          }
          pullFclmInBackground(periods,{...options,includeMonitor:true,monitorTypes:['flUtil','belt']});
        }
        if(event.data?.type==='PRC_V2_HYBRID_RESET'){
          const saved=writeBridge(event.data.payload||emptyBridge());
          fillDashboard(saved);
          updatePanel(saved,'Bridge reset');
        }
      });
    }

    if(isDashboard){
      setTimeout(()=>pullFluidRosterInBackground(),3000);
      setInterval(()=>pullFluidRosterInBackground(),30*60*1000);
    }

    if(isDashboard){
      setTimeout(()=>pullMonitorInBackground(undefined,['flUtil','belt'],'all'),5000);
      setInterval(()=>pullMonitorInBackground(undefined,['flUtil','belt'],'all'),5*60*1000);
    }

    if(isDashboard){
      const autoFclm=()=>pullFclmInBackground(null,{
        shiftDate:document.getElementById('shiftDate')?.value||'',
        includeMET:document.getElementById('useMET')?.value==='true',
        includeMonitor:false,
        source:'fclm'
      });
      setTimeout(autoFclm,7000);
      setInterval(autoFclm,5*60*1000);
    }

    updatePanel(readBridge());
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',boot,{once:true});
  } else {
    boot();
  }
})();
