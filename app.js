/* FBL Tracker — BLE, запись сессий, хранение, экраны */
const SERVICE='a0f10000-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const EVENT  ='a0f10001-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const CTRL   ='a0f10002-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const DATA   ='a0f10003-5a2b-4e6c-9c3d-1f2e3d4c5b6a';

const EV = {KICK:{e:'⚽',n:'KICK',c:'#ff7a3c'},JUMP:{e:'🦘',n:'JUMP',c:'#b06bff'},
  IDLE:{e:'🧍',n:'IDLE',c:'#7a86a1'},WALK:{e:'🚶',n:'WALK',c:'#2dd4bf'},RUN:{e:'🏃',n:'RUN',c:'#37d67a'}};

const $=id=>document.getElementById(id);
let dev=null, ctrlCh=null, connected=false, streaming=false, detector=null;
let prevState=null;
let dCounts={KICK:0,JUMP:0};

// запись
let rec=null;              // {startMs, events:[], raw:{ax..}, samples}
let recTimer=null, healthTimer=null, wakeLock=null;

// ================= BLE =================
$('connectBtn').onclick=connect;
async function connect(){
  if(!navigator.bluetooth){ alert('Chrome on Android required (Web Bluetooth).'); return; }
  try{
    setConn('searching…',false);
    dev=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[SERVICE]});
    dev.addEventListener('gattserverdisconnected',onDisc);
    setConn('connecting…',false);
    const srv=await dev.gatt.connect();
    const svc=await srv.getPrimaryService(SERVICE);
    const evc=await svc.getCharacteristic(EVENT);
    await evc.startNotifications();
    evc.addEventListener('characteristicvaluechanged',e=>onEvent(new TextDecoder().decode(e.target.value).trim()));
    const dc=await svc.getCharacteristic(DATA);
    await dc.startNotifications();
    dc.addEventListener('characteristicvaluechanged',e=>onData(e.target.value));
    ctrlCh=await svc.getCharacteristic(CTRL);
    connected=true; setConn('connected',true);
    $('connectBtn').textContent='Connected ✓'; $('recBtn').disabled=false;
    // распознавание — на телефоне, по личным порогам; датчик просто стримит сырьё
    detector=new Detector({onEvent:onDetEvent, onState:onDetState});
    try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 1')); streaming=true; }catch(e){}
    // прочитать статус SD (отправлен при подключении)
    const rd=async()=>{try{onEvent(new TextDecoder().decode(await evc.readValue()).trim());}catch(e){}};
    rd(); setTimeout(rd,400); setTimeout(rd,1200);
  }catch(e){ setConn('error',false); console.error(e); }
}
function onDisc(){
  connected=false; streaming=false; detector=null;
  setConn('disconnected',false);
  $('connectBtn').textContent='Reconnect'; $('recBtn').disabled=true;
  if(rec) stopRec(true);
}

// ---- текстовые сообщения датчика: только статус SD (движения ловит телефон) ----
function onEvent(msg){
  if(msg.startsWith('SD')||msg.startsWith('NO SD')){ $('sdPill').textContent='💾 '+msg; }
}
// ---- события от детектора на телефоне (по личным порогам) ----
function onDetEvent(type,data){
  const info=EV[type]; if(!info) return;
  const msg = (type==='JUMP') ? `JUMP air=${Math.round(data.air||0)}ms h=${Math.round(data.h||0)}cm`
            : `${type} a=${(data.a||0).toFixed(1)}g g=${Math.round(data.g||0)}`;
  hero(info,msg);
  if(dCounts[type]!==undefined){ dCounts[type]++; if(rec)recCount(type); }
  refreshCounts(); addLive(info,msg);
  if(rec) rec.events.push({t:Date.now()-rec.startMs,type,a:data.a,g:data.g,air:data.air,h:data.h});
  // после разового события (удар/прыжок) вернуть плашку к текущему состоянию,
  // иначе "KICK" висит, пока не сменится зона (при беге состояние не меняется → onDetState молчит)
  clearTimeout(heroRevertTimer);
  heroRevertTimer=setTimeout(revertHeroToState, 800);
}
let heroRevertTimer=null;
function revertHeroToState(){
  const info=EV[prevState]; if(info) hero(info, prevState);
}
function onDetState(state,act){
  const info=EV[state]; if(!info) return;
  clearTimeout(heroRevertTimer);   // живое состояние важнее «висящего» события
  hero(info,`${state} a=${act.toFixed(2)}g`);
  prevState=state;
  if(rec) rec.events.push({t:Date.now()-rec.startMs,type:state,a:act});
}
function hero(info,msg){ $('heroE').textContent=info.e; $('heroN').textContent=info.n; $('heroN').style.color=info.c; $('heroD').textContent=msg; }
function refreshCounts(){ $('dKick').textContent=dCounts.KICK; $('dJump').textContent=dCounts.JUMP; }
function recCount(type){
  if(type==='KICK')$('sKick').textContent=+($('sKick').textContent)+1;
  if(type==='JUMP')$('sJump').textContent=+($('sJump').textContent)+1;
}

// ---- сырые данные (бинарь) ----
function onData(dv){
  if(dv.getUint8(0)!==0x52) return;            // не 'R' (напр. файл-синк) — игнор
  const n=Math.floor((dv.byteLength-3)/12);
  for(let i=0;i<n;i++){
    const o=3+i*12;
    const ax=dv.getInt16(o,true)/1000, ay=dv.getInt16(o+2,true)/1000, az=dv.getInt16(o+4,true)/1000;
    const gx=dv.getInt16(o+6,true)/10,  gy=dv.getInt16(o+8,true)/10,  gz=dv.getInt16(o+10,true)/10;
    if(detector) detector.push(ax,ay,az,gx,gy,gz);     // распознавание по личным порогам
    if(rec){ rec.raw.ax.push(ax);rec.raw.ay.push(ay);rec.raw.az.push(az);rec.raw.gx.push(gx);rec.raw.gy.push(gy);rec.raw.gz.push(gz); }
    if(calib.recording){ calibSample(ax,ay,az,gx,gy,gz); }
    // отладка
    const aM=Math.hypot(ax,ay,az), gM=Math.hypot(gx,gy,gz);
    dbg.n++; dbg.lastA=aM; if(aM>dbg.peakA)dbg.peakA=aM; if(gM>dbg.peakG)dbg.peakG=gM;
    dbg.sumDyn+=Math.abs(aM-1); dbg.cntDyn++;
  }
  if(rec) rec.samples+=n;
}
let dbg={n:0,peakA:0,peakG:0,lastA:1,sumDyn:0,cntDyn:0};
setInterval(()=>{
  const el=$('dbg'); if(!el)return;
  if(!connected){ el.textContent='no data — connect sensor'; return; }
  let t={}; try{ t=JSON.parse(localStorage.getItem('fbl_calib')||'{}'); }catch(e){}
  const kickThr = (t.kickManual!=null ? t.kickManual : (t.kickAcc!=null ? t.kickAcc : '—'));
  const act=dbg.cntDyn?dbg.sumDyn/dbg.cntDyn:0;
  el.innerHTML=`stream ${dbg.n*2} Hz · a=${dbg.lastA.toFixed(1)}g<br>`+
    `<b style="color:#ff7a3c">PEAK acc=${dbg.peakA.toFixed(1)}g</b> · peak gyro=${Math.round(dbg.peakG)}<br>`+
    `act=${act.toFixed(2)} · state ${prevState||'—'}<br>`+
    `kick thr &gt;${kickThr}g${t.kickManual!=null?' (manual)':''} · run thr &gt;${t.zones?t.zones.walk.toFixed(2):'—'}`;
  dbg.n=0;dbg.peakA=0;dbg.peakG=0;dbg.sumDyn=0;dbg.cntDyn=0;
},500);

// ================= ЗАПИСЬ =================
$('recBtn').onclick=()=>{ rec?stopRec(false):startRec(); };
async function startRec(){
  if(!connected) return;
  rec={startMs:Date.now(), events:[], raw:{ax:[],ay:[],az:[],gx:[],gy:[],gz:[]}, samples:0};
  dCounts={KICK:0,JUMP:0};
  $('sKick').textContent='0';$('sJump').textContent='0';
  // поток уже идёт (включён при подключении) — просто начинаем копить
  try{ wakeLock=await navigator.wakeLock.request('screen'); }catch(e){}
  $('recBtn').textContent='■ Stop'; $('recState').textContent='● recording'; $('recState').style.color='#ff4d6d';
  recTimer=setInterval(()=>{ const s=Math.floor((Date.now()-rec.startMs)/1000); $('recTime').textContent=mmss(s); },500);
  healthTimer=setInterval(()=>{ const el=(Date.now()-rec.startMs)/1000; const hz=el>0?Math.round(rec.samples/el):0;
    $('recHealth').innerHTML=`stream: <b>${hz}</b> Hz · samples: ${rec.samples}`; },1000);
}
async function stopRec(silent){
  const r=rec; rec=null;
  clearInterval(recTimer); clearInterval(healthTimer);
  // поток НЕ выключаем — он нужен для live-детекции; просто перестаём копить
  if(wakeLock){ try{wakeLock.release();}catch(e){} wakeLock=null; }
  $('recBtn').textContent='● Start recording'; $('recState').textContent='not recording'; $('recState').style.color='';
  $('recTime').textContent='00:00'; $('recHealth').innerHTML='stream: — Hz · samples: 0';
  if(!r || (r.samples===0 && r.events.length===0)) return;
  const sess={ id:Date.now(), date:new Date().toISOString(), type:$('sType').value, note:$('sNote').value,
    durationMs:Date.now()-r.startMs, events:r.events, raw:r.raw, samples:r.samples };
  await dbAdd(sess);
  if(!silent){ renderHistory(); openAnalytics(sess.id); }
}

// ================= IndexedDB =================
let _db=null;
function db(){ return new Promise((res,rej)=>{ if(_db)return res(_db);
  const q=indexedDB.open('fbl',1); q.onupgradeneeded=()=>q.result.createObjectStore('sessions',{keyPath:'id'});
  q.onsuccess=()=>{_db=q.result;res(_db);}; q.onerror=()=>rej(q.error); }); }
async function dbAdd(s){ const d=await db(); return new Promise(r=>{ d.transaction('sessions','readwrite').objectStore('sessions').put(s).onsuccess=r; }); }
async function dbAll(){ const d=await db(); return new Promise(r=>{ const rq=d.transaction('sessions').objectStore('sessions').getAll(); rq.onsuccess=()=>r(rq.result||[]); }); }
async function dbGet(id){ const d=await db(); return new Promise(r=>{ const rq=d.transaction('sessions').objectStore('sessions').get(id); rq.onsuccess=()=>r(rq.result); }); }
async function dbDel(id){ const d=await db(); return new Promise(r=>{ d.transaction('sessions','readwrite').objectStore('sessions').delete(id).onsuccess=r; }); }

// ================= ИСТОРИЯ =================
async function renderHistory(){
  const list=await dbAll(); list.sort((a,b)=>b.id-a.id);
  if(!list.length){ $('histList').innerHTML='<div class="muted">no recorded sessions yet</div>'; return; }
  $('histList').innerHTML=list.map(s=>{
    const d=new Date(s.id); const dur=mmss(Math.floor(s.durationMs/1000));
    const k=s.events.filter(e=>e.type==='KICK').length, j=s.events.filter(e=>e.type==='JUMP').length;
    return `<div class="row" onclick="openAnalytics(${s.id})" style="cursor:pointer">
      <span class="ico">📊</span>
      <span style="flex:1"><b>${s.type}</b> · ${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}
        <div class="muted">${dur} · ⚽${k} 🦘${j} · ${s.samples} samples</div></span>
      <span class="muted">›</span></div>`;
  }).join('');
}

// ================= АНАЛИТИКА =================
async function openAnalytics(id){
  const s=await dbGet(id); if(!s) return;
  const prof=loadProfile();
  const m=analyze(s,prof);
  const d=new Date(s.id);
  $('analytics').innerHTML=`
    <div class="card">
      <h2>${s.type} · ${d.toLocaleDateString('en-GB')}</h2>
      <div class="muted">${d.toLocaleTimeString('en-GB')} · duration ${mmss(Math.floor(m.durS))}${s.note?' · '+s.note:''}</div>
    </div>
    <div class="grid2">
      <div class="tile"><div class="n" style="color:var(--kick)">${m.kicks}</div><div class="l">⚽ kicks</div></div>
      <div class="tile"><div class="n" style="color:var(--jump)">${m.jumps}</div><div class="l">🦘 jumps</div></div>
    </div>
    <div class="grid3" style="margin-top:10px">
      <div class="tile"><div class="n">${m.steps}</div><div class="l">steps</div></div>
      <div class="tile"><div class="n">${m.cadence}</div><div class="l">cadence /min</div></div>
      <div class="tile"><div class="n">${m.bursts}</div><div class="l">bursts</div></div>
    </div>
    <div class="grid2" style="margin-top:10px">
      <div class="tile"><div class="n">${m.turns}</div><div class="l">turns</div></div>
      <div class="tile"><div class="n">${m.fatigue}%</div><div class="l">fatigue</div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3 style="margin-bottom:10px">Intensity zones</h3>${svgDonut(m.zones)}</div>
    <div class="card"><h3 style="margin-bottom:10px">Session dynamics</h3>${svgTimeline(m.timeline)}</div>
    <div class="card"><h3>Kicks</h3>
      <div class="grid2" style="margin:10px 0">
        <div class="tile"><div class="n" style="color:var(--kick)">${m.maxKickKmh?m.maxKickKmh.toFixed(0):'—'}</div><div class="l">max ball speed, km/h*</div></div>
        <div class="tile"><div class="n">${m.kicks}</div><div class="l">total kicks</div></div>
      </div>
      ${svgBars(m.kicksAn.map(k=>k.ball), 'var(--kick)', ' km/h')}
      <div class="muted" style="margin-top:6px">* estimated from foot rotation (ω·r), ±10-15%</div>
    </div>
    <div class="card"><h3>Jumps and running</h3>
      <div class="grid2" style="margin-top:10px">
        <div class="tile"><div class="n" style="color:var(--jump)">${m.maxJumpCm?m.maxJumpCm.toFixed(0):'—'}</div><div class="l">max height, cm</div></div>
        <div class="tile"><div class="n">${(m.distM/1000).toFixed(2)}</div><div class="l">distance, km*</div></div>
        <div class="tile"><div class="n">${m.avgKmh.toFixed(1)}</div><div class="l">avg speed, km/h*</div></div>
        <div class="tile"><div class="n">${m.gctMs||'—'}</div><div class="l">foot contact, ms</div></div>
      </div>
      <div class="muted" style="margin-top:6px">* approximate (from cadence and stride)</div>
    </div>
    <div class="card">
      <button class="big ghost" onclick="exportCSV(${s.id})">⬇ Export CSV (for ML)</button>
      <button class="big ghost" style="margin-top:10px" onclick="delSession(${s.id})">🗑 Delete session</button>
    </div>`;
  showTab('analytics');
}
async function delSession(id){ if(confirm('Delete session?')){ await dbDel(id); renderHistory(); showTab('history'); } }

// экспорт: сырьё + события в CSV
async function exportCSV(id){
  const s=await dbGet(id); if(!s) return;
  let csv='# events\nt_ms,type,a_g,gyro_dps,air_ms,h_cm\n';
  s.events.forEach(e=>csv+=`${e.t},${e.type},${e.a??''},${e.g??''},${e.air??''},${e.h??''}\n`);
  csv+='\n# raw @100Hz\ni,ax,ay,az,gx,gy,gz\n';
  const R=s.raw; for(let i=0;i<R.ax.length;i++) csv+=`${i},${R.ax[i]},${R.ay[i]},${R.az[i]},${R.gx[i]},${R.gy[i]},${R.gz[i]}\n`;
  const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='session_'+id+'.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// ================= КАЛИБРОВКА =================
const CALIB_LABELS=[['IDLE','🧍 Idle'],['WALK','🚶 Walk'],['RUN','🏃 Run'],['KICK','⚽ Kick'],['JUMP','🦘 Jump']];
let calib={recording:null, startMs:0, timer:null, data:{}};

function buildCalib(){
  loadCalibData();
  $('calibList').innerHTML=CALIB_LABELS.map(([k,n])=>{
    const has=calib.data[k]&&calib.data[k].act&&calib.data[k].act.length;
    return `
    <div class="tile" style="text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px">
      <div style="flex:1"><b>${n}</b><div class="muted" id="cr_${k}" style="font-size:12px;margin-top:2px">not recorded</div></div>
      <button class="ghost" id="cb_${k}" onclick="calibToggle('${k}')" style="padding:9px 14px">${has?'↻ Re-record':'● Record'}</button>
    </div>`;
  }).join('');
  CALIB_LABELS.forEach(([k])=>{ if(calib.data[k]&&calib.data[k].act&&calib.data[k].act.length) updateCalibRow(k,true); });
  showSavedCalib();
  loadKickManual();
}
function calibToggle(label){
  if(!connected){ $('calibResult').innerHTML='<span style="color:var(--sprint)">connect the sensor first (Sensor tab)</span>'; return; }
  if(rec){ $('calibResult').innerHTML='<span style="color:var(--sprint)">stop the session recording</span>'; return; }
  if(calib.recording===label){ calibStop(); return; }
  if(calib.recording) calibStop();
  calib.recording=label; calib.startMs=Date.now();
  calib.data[label]={act:[],acc:[],gyro:[]};
  const b=$('cb_'+label); b.textContent='■ Stop'; b.style.background='var(--impact)'; b.style.color='#fff';
  calib.timer=setInterval(()=>updateCalibRow(label,false),300);
  updateCalibRow(label,false);
}
function calibStop(){
  const label=calib.recording; if(!label)return;
  clearInterval(calib.timer); calib.timer=null; calib.recording=null;
  const b=$('cb_'+label); if(b){ b.textContent='↻ Re-record'; b.style.background=''; b.style.color=''; }
  updateCalibRow(label,true);
  saveCalibData();   // сразу сохраняем — данные не потеряются
}
function calibSample(ax,ay,az,gx,gy,gz){
  const d=calib.data[calib.recording]; if(!d)return;
  const aMag=Math.hypot(ax,ay,az);
  d.act.push(Math.abs(aMag-1)); d.acc.push(aMag); d.gyro.push(Math.hypot(gx,gy,gz));
}
function updateCalibRow(label,done){
  const d=calib.data[label], el=$('cr_'+label); if(!d||!el)return;
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0, max=a=>a.length?Math.max(...a):0;
  if(!done && calib.recording===label){
    const dur=((Date.now()-calib.startMs)/1000).toFixed(0);
    el.innerHTML=`<span style="color:#ff4d6d">● recording ${dur}s · ${d.act.length} samples</span>`;
  } else {
    el.innerHTML=`✓ ${d.act.length} samples · activity ${mean(d.act).toFixed(2)} · peak ${max(d.acc).toFixed(1)}g · gyro ${Math.round(max(d.gyro))}°/s`;
  }
}
function showSavedCalib(){
  let s=null; try{ s=JSON.parse(localStorage.getItem('fbl_calib')||'null'); }catch(e){}
  if(s&&s.zones){ const d=new Date(s.ts);
    $('calibResult').innerHTML=`✅ <b>Saved</b> ${d.toLocaleString('en-GB')} · kick&gt;${s.kickAcc||'—'}g`;
    renderCalibSummary(calib.data, s);
  } else { $('calibResult').innerHTML='<span class="muted">do the movements and tap "Calculate"</span>'; }
}
// вычисление порогов из записанных движений (без спринта)
function computeThresholds(D){
  const mean=a=>a&&a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const maxA=a=>a&&a.length?Math.max(...a):null;
  const mid=(a,b)=>(a!=null&&b!=null)?(a+b)/2:null;
  const idle=mean(D.IDLE&&D.IDLE.act), walk=mean(D.WALK&&D.WALK.act), run=mean(D.RUN&&D.RUN.act);
  if(run==null&&walk==null) return null;
  const zones={ idle: mid(idle,walk)??0.086, walk: mid(walk,run)??0.379, run: (run!=null? run*1.5 : 0.9) };
  // порог удара — у самого пика удара (касание мяча), но гарантированно выше бегового пика.
  // раньше брали середину (run+kick)/2 → порог падал вдвое ниже реального удара. Спринт НЕ учитываем (он убран).
  const runAccMax  = maxA(D.RUN&&D.RUN.acc)||0;
  const kickAccMax = maxA(D.KICK&&D.KICK.acc)||0;
  let kickAcc;
  if(kickAccMax>runAccMax && runAccMax>0){ kickAcc = +(Math.max(runAccMax*1.15, kickAccMax*0.85)).toFixed(1); } // у удара, но выше бега
  else if(runAccMax>0){ kickAcc = +(runAccMax*1.25).toFixed(1); }
  else { kickAcc = 6; }
  return {zones, kickAcc, runAccMax, kickAccMax};
}
function calibCalc(){
  if(calib.recording) calibStop();
  const t=computeThresholds(calib.data);
  if(!t){ $('calibResult').innerHTML='<span style="color:var(--sprint)">record at least Walk and Run</span>'; return; }
  let prev={}; try{prev=JSON.parse(localStorage.getItem('fbl_calib')||'{}');}catch(e){}
  const saved={zones:t.zones, kickAcc:t.kickAcc, ts:Date.now()};
  if(prev.kickManual!=null) saved.kickManual=prev.kickManual;   // ручной override не затираем
  localStorage.setItem('fbl_zones',JSON.stringify(t.zones));
  localStorage.setItem('fbl_calib',JSON.stringify(saved));
  saveCalibData();
  if(detector) detector.reloadThresholds();
  $('calibResult').innerHTML='<span style="color:var(--run)">✓ Saved permanently and applied — to the home screen and analytics.</span>';
  renderCalibSummary(calib.data, saved);
  loadKickManual();
}
function saveCalibData(){ try{ localStorage.setItem('fbl_calibdata', JSON.stringify(calib.data)); }catch(e){} }
function loadCalibData(){ try{ const d=JSON.parse(localStorage.getItem('fbl_calibdata')||'null'); if(d)calib.data=d; }catch(e){} }
// пересчитать пороги из уже записанных данных по НОВОЙ формуле (без перезаписи движений)
function applyCalibFromData(){
  loadCalibData();
  const t=computeThresholds(calib.data);
  if(t){ let prev={}; try{prev=JSON.parse(localStorage.getItem('fbl_calib')||'{}');}catch(e){}
    localStorage.setItem('fbl_zones',JSON.stringify(t.zones));
    const saved={zones:t.zones,kickAcc:t.kickAcc,ts:prev.ts||Date.now()};
    if(prev.kickManual!=null) saved.kickManual=prev.kickManual;   // ручной override не затираем
    localStorage.setItem('fbl_calib',JSON.stringify(saved)); }
}
// ---- ручной порог удара (override): перебивает автоформулу, не затирается пересчётом ----
function loadKickManual(){
  let c={}; try{ c=JSON.parse(localStorage.getItem('fbl_calib')||'{}'); }catch(e){}
  if($('kickManual')) $('kickManual').value = (c.kickManual!=null ? c.kickManual : '');
  updateKickManualMsg(c);
}
function updateKickManualMsg(c){
  const el=$('kickManualMsg'); if(!el)return;
  if(c.kickManual!=null) el.innerHTML=`<span style="color:var(--run)">Manual: kicks counted from <b>${c.kickManual}g</b> (overrides auto ${c.kickAcc!=null?c.kickAcc+'g':'—'})</span>`;
  else el.innerHTML=`Auto: kicks counted from <b>${c.kickAcc!=null?c.kickAcc+'g':'—'}</b>`;
}
function applyKickManual(){
  let c={}; try{ c=JSON.parse(localStorage.getItem('fbl_calib')||'{}'); }catch(e){}
  const v=($('kickManual').value||'').trim();
  if(v===''){ delete c.kickManual; }
  else { const n=parseFloat(v); if(isNaN(n)||n<=0){ $('kickManualMsg').innerHTML='<span style="color:var(--sprint)">enter a positive number</span>'; return; } c.kickManual=+n.toFixed(1); }
  localStorage.setItem('fbl_calib',JSON.stringify(c));
  if(detector) detector.reloadThresholds();
  updateKickManualMsg(c);
}
function renderCalibSummary(D, saved){
  const mean=a=>a&&a.length?a.reduce((x,y)=>x+y,0)/a.length:null, max=a=>a&&a.length?Math.max(...a):null;
  const rows=CALIB_LABELS.map(([k,n])=>{
    const d=D[k]; if(!d||!d.act.length) return `<tr><td style="padding:5px 6px">${n}</td><td colspan="4" class="muted" style="padding:5px 6px">none</td></tr>`;
    return `<tr><td style="padding:5px 6px">${n}</td><td style="padding:5px 6px">${d.act.length}</td><td style="padding:5px 6px">${mean(d.act).toFixed(2)}</td><td style="padding:5px 6px">${max(d.acc).toFixed(1)}g</td><td style="padding:5px 6px">${Math.round(max(d.gyro))}</td></tr>`;
  }).join('');
  $('calibSummary').innerHTML=`
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr class="muted"><td style="padding:5px 6px">movement</td><td style="padding:5px 6px">samples</td><td style="padding:5px 6px">activity</td><td style="padding:5px 6px">peak acc</td><td style="padding:5px 6px">gyro</td></tr>
      ${rows}</table></div>
    <div style="margin-top:12px;font-size:14px"><b>Thresholds (applied):</b><br>
      zones: idle&lt;${saved.zones.idle.toFixed(3)} · walk&lt;${saved.zones.walk.toFixed(3)} · run&lt;${saved.zones.run.toFixed(3)}<br>
      kick: acceleration&gt;${saved.kickManual!=null?saved.kickManual+'g (manual)':saved.kickAcc+'g'}</div>
    <button class="big ghost" style="margin-top:14px" onclick="calibReset()">↻ Restart calibration</button>`;
  $('calibSummaryCard').style.display='block';
}
function calibReset(){ if(calib.recording)calibStop(); calib.data={}; $('calibSummaryCard').style.display='none'; buildCalib(); $('calibResult').innerHTML='<span class="muted">do the movements and tap "Calculate"</span>'; }
$('calibCalc').onclick=calibCalc;
$('kickManualApply').onclick=applyKickManual;

// ================= ПРОФИЛЬ =================
function loadProfile(){ try{return JSON.parse(localStorage.getItem('fbl_profile')||'{}');}catch(e){return {};} }
function fillProfile(){ const p=loadProfile(); $('pName').value=p.name||''; $('pFoot').value=p.foot||'Right'; $('pHeight').value=p.height||''; $('pFootLen').value=p.footLen||''; }
$('saveProfile').onclick=()=>{
  const p={name:$('pName').value,foot:$('pFoot').value,height:$('pHeight').value,footLen:$('pFootLen').value};
  localStorage.setItem('fbl_profile',JSON.stringify(p)); $('profSaved').textContent='✓ saved';
  setTimeout(()=>$('profSaved').textContent='',1500);
};

// ================= UI =================
function setConn(t,on){ $('connTxt').textContent=t; $('dot').classList.toggle('on',on); }
function addLive(info,msg){
  const f=$('liveFeed'); if(f.querySelector('.muted'))f.innerHTML='';
  const now=new Date(); const t=now.toLocaleTimeString('en-GB',{hour12:false});
  const r=document.createElement('div'); r.className='row';
  r.innerHTML=`<span class="ico">${info.e}</span><span class="t" style="color:${info.c}">${info.n}</span><span class="d">${msg}</span><span class="tm">${t}</span>`;
  f.prepend(r); while(f.children.length>60)f.removeChild(f.lastChild);
}
function num(parts,key){ const t=parts.find(x=>x.startsWith(key+'=')); if(!t)return null; return parseFloat(t.slice(key.length+1)); }
function mmss(s){ const m=Math.floor(s/60); return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }

document.querySelectorAll('.nav a').forEach(a=>a.onclick=e=>{e.preventDefault();showTab(a.dataset.tab);});
function showTab(name){
  if(name!=='calib' && calib.recording) calibStop();   // уходя с калибровки — остановить запись
  document.querySelectorAll('section').forEach(s=>s.classList.toggle('act',s.id==='tab-'+name));
  document.querySelectorAll('.nav a').forEach(a=>a.classList.toggle('act',a.dataset.tab===name));
  if(name==='history')renderHistory();
  if(name==='calib')buildCalib();
}

const APP_VERSION='v1.5';
if($('ver')) $('ver').textContent=APP_VERSION;
applyCalibFromData();   // подхватить и пересчитать сохранённую калибровку
fillProfile(); renderHistory();
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
