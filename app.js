/* FBL Tracker — BLE, запись сессий, хранение, экраны */
const SERVICE='a0f10000-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const EVENT  ='a0f10001-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const CTRL   ='a0f10002-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const DATA   ='a0f10003-5a2b-4e6c-9c3d-1f2e3d4c5b6a';

const EV = {KICK:{e:'⚽',n:'УДАР',c:'#ff7a3c'},JUMP:{e:'🦘',n:'ПРЫЖОК',c:'#b06bff'},IMPACT:{e:'💥',n:'СТОЛКНОВЕНИЕ',c:'#ff4d6d'},
  IDLE:{e:'🧍',n:'ПОКОЙ',c:'#7a86a1'},WALK:{e:'🚶',n:'ХОДЬБА',c:'#2dd4bf'},RUN:{e:'🏃',n:'БЕГ',c:'#37d67a'},SPRINT:{e:'⚡',n:'СПРИНТ',c:'#ffd23f'}};

const $=id=>document.getElementById(id);
let dev=null, ctrlCh=null, connected=false, streaming=false, detector=null;
let prevState=null;
let dCounts={KICK:0,JUMP:0,SPRINT:0};

// запись
let rec=null;              // {startMs, events:[], raw:{ax..}, samples}
let recTimer=null, healthTimer=null, wakeLock=null;

// ================= BLE =================
$('connectBtn').onclick=connect;
async function connect(){
  if(!navigator.bluetooth){ alert('Нужен Chrome на Android (Web Bluetooth).'); return; }
  try{
    setConn('поиск…',false);
    dev=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[SERVICE]});
    dev.addEventListener('gattserverdisconnected',onDisc);
    setConn('соединение…',false);
    const srv=await dev.gatt.connect();
    const svc=await srv.getPrimaryService(SERVICE);
    const evc=await svc.getCharacteristic(EVENT);
    await evc.startNotifications();
    evc.addEventListener('characteristicvaluechanged',e=>onEvent(new TextDecoder().decode(e.target.value).trim()));
    const dc=await svc.getCharacteristic(DATA);
    await dc.startNotifications();
    dc.addEventListener('characteristicvaluechanged',e=>onData(e.target.value));
    ctrlCh=await svc.getCharacteristic(CTRL);
    connected=true; setConn('подключено',true);
    $('connectBtn').textContent='Подключено ✓'; $('recBtn').disabled=false;
    // распознавание — на телефоне, по личным порогам; датчик просто стримит сырьё
    detector=new Detector({onEvent:onDetEvent, onState:onDetState});
    try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 1')); streaming=true; }catch(e){}
    // прочитать статус SD (отправлен при подключении)
    const rd=async()=>{try{onEvent(new TextDecoder().decode(await evc.readValue()).trim());}catch(e){}};
    rd(); setTimeout(rd,400); setTimeout(rd,1200);
  }catch(e){ setConn('ошибка',false); console.error(e); }
}
function onDisc(){
  connected=false; streaming=false; detector=null;
  setConn('отключено',false);
  $('connectBtn').textContent='Переподключить'; $('recBtn').disabled=true;
  if(rec) stopRec(true);
}

// ---- текстовые сообщения датчика: только статус SD (движения ловит телефон) ----
function onEvent(msg){
  if(msg.startsWith('SD')||msg.startsWith('NO SD')){ $('sdPill').textContent='💾 '+msg; }
}
// ---- события от детектора на телефоне (по личным порогам) ----
function onDetEvent(type,data){
  const info=EV[type]; if(!info) return;
  const msg = (type==='JUMP') ? `JUMP air=${Math.round(data.air||0)}ms h=${Math.round(data.h||0)}см`
            : `${type} a=${(data.a||0).toFixed(1)}g g=${Math.round(data.g||0)}`;
  hero(info,msg);
  if(dCounts[type]!==undefined){ dCounts[type]++; if(rec)recCount(type); }
  refreshCounts(); addLive(info,msg);
  if(rec) rec.events.push({t:Date.now()-rec.startMs,type,a:data.a,g:data.g,air:data.air,h:data.h});
}
function onDetState(state,act){
  const info=EV[state]; if(!info) return;
  hero(info,`${state} a=${act.toFixed(2)}g`);
  if(state==='SPRINT'&&prevState!=='SPRINT'){ dCounts.SPRINT++; if(rec)recCount('SPRINT'); refreshCounts(); }
  prevState=state;
  if(rec) rec.events.push({t:Date.now()-rec.startMs,type:state,a:act});
}
function hero(info,msg){ $('heroE').textContent=info.e; $('heroN').textContent=info.n; $('heroN').style.color=info.c; $('heroD').textContent=msg; }
function refreshCounts(){ $('dKick').textContent=dCounts.KICK; $('dJump').textContent=dCounts.JUMP; $('dSprint').textContent=dCounts.SPRINT; }
function recCount(type){
  if(type==='KICK')$('sKick').textContent=+($('sKick').textContent)+1;
  if(type==='JUMP')$('sJump').textContent=+($('sJump').textContent)+1;
  if(type==='SPRINT')$('sSprint').textContent=+($('sSprint').textContent)+1;
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
  }
  if(rec) rec.samples+=n;
}

// ================= ЗАПИСЬ =================
$('recBtn').onclick=()=>{ rec?stopRec(false):startRec(); };
async function startRec(){
  if(!connected) return;
  rec={startMs:Date.now(), events:[], raw:{ax:[],ay:[],az:[],gx:[],gy:[],gz:[]}, samples:0};
  dCounts={KICK:0,JUMP:0,SPRINT:0};
  $('sKick').textContent='0';$('sJump').textContent='0';$('sSprint').textContent='0';
  // поток уже идёт (включён при подключении) — просто начинаем копить
  try{ wakeLock=await navigator.wakeLock.request('screen'); }catch(e){}
  $('recBtn').textContent='■ Остановить'; $('recState').textContent='● идёт запись'; $('recState').style.color='#ff4d6d';
  recTimer=setInterval(()=>{ const s=Math.floor((Date.now()-rec.startMs)/1000); $('recTime').textContent=mmss(s); },500);
  healthTimer=setInterval(()=>{ const el=(Date.now()-rec.startMs)/1000; const hz=el>0?Math.round(rec.samples/el):0;
    $('recHealth').innerHTML=`поток: <b>${hz}</b> Гц · сэмплов: ${rec.samples}`; },1000);
}
async function stopRec(silent){
  const r=rec; rec=null;
  clearInterval(recTimer); clearInterval(healthTimer);
  // поток НЕ выключаем — он нужен для live-детекции; просто перестаём копить
  if(wakeLock){ try{wakeLock.release();}catch(e){} wakeLock=null; }
  $('recBtn').textContent='● Начать запись'; $('recState').textContent='не записывается'; $('recState').style.color='';
  $('recTime').textContent='00:00'; $('recHealth').innerHTML='поток: — Гц · сэмплов: 0';
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
  if(!list.length){ $('histList').innerHTML='<div class="muted">пока нет записанных сессий</div>'; return; }
  $('histList').innerHTML=list.map(s=>{
    const d=new Date(s.id); const dur=mmss(Math.floor(s.durationMs/1000));
    const k=s.events.filter(e=>e.type==='KICK').length, j=s.events.filter(e=>e.type==='JUMP').length;
    return `<div class="row" onclick="openAnalytics(${s.id})" style="cursor:pointer">
      <span class="ico">📊</span>
      <span style="flex:1"><b>${s.type}</b> · ${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}
        <div class="muted">${dur} · ⚽${k} 🦘${j} · ${s.samples} сэмпл.</div></span>
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
      <h2>${s.type} · ${d.toLocaleDateString('ru-RU')}</h2>
      <div class="muted">${d.toLocaleTimeString('ru-RU')} · длительность ${mmss(Math.floor(m.durS))}${s.note?' · '+s.note:''}</div>
    </div>
    <div class="grid3">
      <div class="tile"><div class="n" style="color:var(--kick)">${m.kicks}</div><div class="l">⚽ удары</div></div>
      <div class="tile"><div class="n" style="color:var(--jump)">${m.jumps}</div><div class="l">🦘 прыжки</div></div>
      <div class="tile"><div class="n" style="color:var(--sprint)">${m.sprints}</div><div class="l">⚡ спринты</div></div>
    </div>
    <div class="grid3" style="margin-top:10px">
      <div class="tile"><div class="n">${m.steps}</div><div class="l">шаги</div></div>
      <div class="tile"><div class="n">${m.cadence}</div><div class="l">каденс /мин</div></div>
      <div class="tile"><div class="n">${m.bursts}</div><div class="l">рывки</div></div>
    </div>
    <div class="grid3" style="margin-top:10px">
      <div class="tile"><div class="n">${m.turns}</div><div class="l">повороты</div></div>
      <div class="tile"><div class="n">${m.fatigue}%</div><div class="l">усталость</div></div>
      <div class="tile"><div class="n">${m.sprints+m.bursts}</div><div class="l">выс. интенс.</div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3 style="margin-bottom:10px">Зоны интенсивности</h3>${svgDonut(m.zones)}</div>
    <div class="card"><h3 style="margin-bottom:10px">Динамика сессии</h3>${svgTimeline(m.timeline)}</div>
    <div class="card"><h3>Удары</h3>
      <div class="grid2" style="margin:10px 0">
        <div class="tile"><div class="n" style="color:var(--kick)">${m.maxKickKmh?m.maxKickKmh.toFixed(0):'—'}</div><div class="l">макс скорость мяча, км/ч*</div></div>
        <div class="tile"><div class="n">${m.kicks}</div><div class="l">всего ударов</div></div>
      </div>
      ${svgBars(m.kicksAn.map(k=>k.ball), 'var(--kick)', ' км/ч')}
      <div class="muted" style="margin-top:6px">* оценка по вращению стопы (ω·r), ±10-15%</div>
    </div>
    <div class="card"><h3>Прыжки и бег</h3>
      <div class="grid2" style="margin-top:10px">
        <div class="tile"><div class="n" style="color:var(--jump)">${m.maxJumpCm?m.maxJumpCm.toFixed(0):'—'}</div><div class="l">макс высота, см</div></div>
        <div class="tile"><div class="n">${(m.distM/1000).toFixed(2)}</div><div class="l">дистанция, км*</div></div>
        <div class="tile"><div class="n">${m.avgKmh.toFixed(1)}</div><div class="l">ср. скорость, км/ч*</div></div>
        <div class="tile"><div class="n">${m.gctMs||'—'}</div><div class="l">контакт стопы, мс</div></div>
      </div>
      <div class="muted" style="margin-top:6px">* приблизительно (по каденсу и шагу)</div>
    </div>
    <div class="card">
      <button class="big ghost" onclick="exportCSV(${s.id})">⬇ Экспорт CSV (для ML)</button>
      <button class="big ghost" style="margin-top:10px" onclick="delSession(${s.id})">🗑 Удалить сессию</button>
    </div>`;
  showTab('analytics');
}
async function delSession(id){ if(confirm('Удалить сессию?')){ await dbDel(id); renderHistory(); showTab('history'); } }

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
const CALIB_LABELS=[['IDLE','🧍 Покой'],['WALK','🚶 Ходьба'],['RUN','🏃 Бег'],['SPRINT','⚡ Спринт'],['KICK','⚽ Удар'],['JUMP','🦘 Прыжок']];
let calib={recording:null, startMs:0, timer:null, data:{}};

function buildCalib(){
  $('calibList').innerHTML=CALIB_LABELS.map(([k,n])=>`
    <div class="tile" style="text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px">
      <div style="flex:1"><b>${n}</b><div class="muted" id="cr_${k}" style="font-size:12px;margin-top:2px">не записано</div></div>
      <button class="ghost" id="cb_${k}" onclick="calibToggle('${k}')" style="padding:9px 14px">● Записать</button>
    </div>`).join('');
  showSavedCalib();
}
function calibToggle(label){
  if(!connected){ $('calibResult').innerHTML='<span style="color:var(--sprint)">сначала подключи датчик (вкладка Датчик)</span>'; return; }
  if(rec){ $('calibResult').innerHTML='<span style="color:var(--sprint)">останови запись сессии</span>'; return; }
  if(calib.recording===label){ calibStop(); return; }
  if(calib.recording) calibStop();
  calib.recording=label; calib.startMs=Date.now();
  calib.data[label]={act:[],acc:[],gyro:[]};
  const b=$('cb_'+label); b.textContent='■ Стоп'; b.style.background='var(--impact)'; b.style.color='#fff';
  calib.timer=setInterval(()=>updateCalibRow(label,false),300);
  updateCalibRow(label,false);
}
function calibStop(){
  const label=calib.recording; if(!label)return;
  clearInterval(calib.timer); calib.timer=null; calib.recording=null;
  const b=$('cb_'+label); if(b){ b.textContent='↻ Переписать'; b.style.background=''; b.style.color=''; }
  updateCalibRow(label,true);
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
    el.innerHTML=`<span style="color:#ff4d6d">● запись ${dur}с · ${d.act.length} сэмпл.</span>`;
  } else {
    el.innerHTML=`✓ ${d.act.length} сэмпл · активность ${mean(d.act).toFixed(2)} · пик ${max(d.acc).toFixed(1)}g · гиро ${Math.round(max(d.gyro))}°/с`;
  }
}
function showSavedCalib(){
  let s=null; try{ s=JSON.parse(localStorage.getItem('fbl_calib')||'null'); }catch(e){}
  if(s&&s.zones){ const d=new Date(s.ts);
    $('calibResult').innerHTML=`✅ <b>Сохранено</b> ${d.toLocaleString('ru-RU')} · удар&gt;${Math.round(s.kickGyro||0)}°/с · столкн&gt;${s.impactAcc||'—'}g`;
    renderCalibSummary(calib.data, s);
  } else { $('calibResult').innerHTML='<span class="muted">поделай движения и нажми «Рассчитать»</span>'; }
}
function calibCalc(){
  if(calib.recording) calibStop();
  const D=calib.data;
  const mean=a=>a&&a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const pct=(a,p)=>{if(!a||!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p/100*s.length))];};
  const mid=(a,b)=>(a!=null&&b!=null)?(a+b)/2:null;
  const cat=(...as)=>as.filter(Boolean).reduce((r,a)=>r.concat(a),[]);
  const idle=mean(D.IDLE&&D.IDLE.act), walk=mean(D.WALK&&D.WALK.act), run=mean(D.RUN&&D.RUN.act), sprint=mean(D.SPRINT&&D.SPRINT.act);
  if(run==null&&walk==null){ $('calibResult').innerHTML='<span style="color:var(--sprint)">запиши хотя бы Ходьбу и Бег</span>'; return; }
  const zones={ idle: mid(idle,walk)??0.086, walk: mid(walk,run)??0.379, run: mid(run,sprint)??0.699 };
  const runAcc = pct(cat(D.RUN&&D.RUN.acc, D.SPRINT&&D.SPRINT.acc), 95);
  const runGyro= pct(cat(D.RUN&&D.RUN.gyro, D.SPRINT&&D.SPRINT.gyro), 95);
  const impactAcc = runAcc? Math.max(4, +(runAcc*1.2).toFixed(1)) : 5.0;
  const kickGyro  = runGyro? Math.max(600, Math.round(runGyro*1.2)) : 900;
  const saved={zones, kickGyro, impactAcc, ts:Date.now()};
  localStorage.setItem('fbl_zones',JSON.stringify(zones));
  localStorage.setItem('fbl_calib',JSON.stringify(saved));
  if(detector) detector.reloadThresholds();
  $('calibResult').innerHTML='<span style="color:var(--run)">✓ Сохранено и применено — к главному экрану и аналитике.</span>';
  renderCalibSummary(D, saved);
}
function renderCalibSummary(D, saved){
  const mean=a=>a&&a.length?a.reduce((x,y)=>x+y,0)/a.length:null, max=a=>a&&a.length?Math.max(...a):null;
  const rows=CALIB_LABELS.map(([k,n])=>{
    const d=D[k]; if(!d||!d.act.length) return `<tr><td style="padding:5px 6px">${n}</td><td colspan="4" class="muted" style="padding:5px 6px">нет</td></tr>`;
    return `<tr><td style="padding:5px 6px">${n}</td><td style="padding:5px 6px">${d.act.length}</td><td style="padding:5px 6px">${mean(d.act).toFixed(2)}</td><td style="padding:5px 6px">${max(d.acc).toFixed(1)}g</td><td style="padding:5px 6px">${Math.round(max(d.gyro))}</td></tr>`;
  }).join('');
  $('calibSummary').innerHTML=`
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr class="muted"><td style="padding:5px 6px">движение</td><td style="padding:5px 6px">сэмпл</td><td style="padding:5px 6px">актив.</td><td style="padding:5px 6px">пик уск.</td><td style="padding:5px 6px">гиро</td></tr>
      ${rows}</table></div>
    <div style="margin-top:12px;font-size:14px"><b>Пороги (применены):</b><br>
      зоны: покой&lt;${saved.zones.idle.toFixed(3)} · ходьба&lt;${saved.zones.walk.toFixed(3)} · бег&lt;${saved.zones.run.toFixed(3)}<br>
      удар: гиро&gt;${saved.kickGyro}°/с · столкновение: ускор&gt;${saved.impactAcc}g</div>
    <button class="big ghost" style="margin-top:14px" onclick="calibReset()">↻ Начать калибровку заново</button>`;
  $('calibSummaryCard').style.display='block';
}
function calibReset(){ if(calib.recording)calibStop(); calib.data={}; $('calibSummaryCard').style.display='none'; buildCalib(); $('calibResult').innerHTML='<span class="muted">поделай движения и нажми «Рассчитать»</span>'; }
$('calibCalc').onclick=calibCalc;

// ================= ПРОФИЛЬ =================
function loadProfile(){ try{return JSON.parse(localStorage.getItem('fbl_profile')||'{}');}catch(e){return {};} }
function fillProfile(){ const p=loadProfile(); $('pName').value=p.name||''; $('pFoot').value=p.foot||'Правая'; $('pHeight').value=p.height||''; $('pFootLen').value=p.footLen||''; }
$('saveProfile').onclick=()=>{
  const p={name:$('pName').value,foot:$('pFoot').value,height:$('pHeight').value,footLen:$('pFootLen').value};
  localStorage.setItem('fbl_profile',JSON.stringify(p)); $('profSaved').textContent='✓ сохранено';
  setTimeout(()=>$('profSaved').textContent='',1500);
};

// ================= UI =================
function setConn(t,on){ $('connTxt').textContent=t; $('dot').classList.toggle('on',on); }
function addLive(info,msg){
  const f=$('liveFeed'); if(f.querySelector('.muted'))f.innerHTML='';
  const now=new Date(); const t=now.toLocaleTimeString('ru-RU',{hour12:false});
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

const APP_VERSION='v0.6';
if($('ver')) $('ver').textContent=APP_VERSION;
fillProfile(); renderHistory();
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
