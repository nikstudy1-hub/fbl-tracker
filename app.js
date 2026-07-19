/* FBL Tracker — BLE, запись сессий, хранение, экраны */
const SERVICE='a0f10000-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const EVENT  ='a0f10001-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const CTRL   ='a0f10002-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const DATA   ='a0f10003-5a2b-4e6c-9c3d-1f2e3d4c5b6a';

const EV = {KICK:{e:'⚽',n:'УДАР',c:'#ff7a3c'},JUMP:{e:'🦘',n:'ПРЫЖОК',c:'#b06bff'},IMPACT:{e:'💥',n:'СТОЛКНОВЕНИЕ',c:'#ff4d6d'},
  IDLE:{e:'🧍',n:'ПОКОЙ',c:'#7a86a1'},WALK:{e:'🚶',n:'ХОДЬБА',c:'#2dd4bf'},RUN:{e:'🏃',n:'БЕГ',c:'#37d67a'},SPRINT:{e:'⚡',n:'СПРИНТ',c:'#ffd23f'}};

const $=id=>document.getElementById(id);
let dev=null, ctrlCh=null, connected=false;
let liveState=null, prevState=null;
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
    // прочитать статус SD (отправлен при подключении)
    const rd=async()=>{try{onEvent(new TextDecoder().decode(await evc.readValue()).trim());}catch(e){}};
    rd(); setTimeout(rd,400); setTimeout(rd,1200);
  }catch(e){ setConn('ошибка',false); console.error(e); }
}
function onDisc(){
  connected=false; setConn('отключено',false);
  $('connectBtn').textContent='Переподключить'; $('recBtn').disabled=true;
  if(rec) stopRec(true);
}

// ---- события (текст) ----
function onEvent(msg){
  const p=msg.split(/\s+/); const type=p[0];
  const a=num(p,'a'), g=num(p,'g'), air=num(p,'air'), h=num(p,'h');

  if(type==='SD'){ $('sdPill').textContent='💾 '+msg; return; }
  if(type==='REC'){ return; }
  const info=EV[type]; if(!info) return;

  const isState=['IDLE','WALK','RUN','SPRINT'].includes(type);
  if(isState){
    $('heroE').textContent=info.e; $('heroN').textContent=info.n; $('heroN').style.color=info.c; $('heroD').textContent=msg;
    if(type==='SPRINT'&&prevState!=='SPRINT'){ dCounts.SPRINT++; if(rec)recCount('SPRINT'); }
    prevState=type;
  }else{
    $('heroE').textContent=info.e; $('heroN').textContent=info.n; $('heroN').style.color=info.c; $('heroD').textContent=msg;
    if(dCounts[type]!==undefined){ dCounts[type]++; if(rec)recCount(type); }
    addLive(info,msg);
  }
  $('dKick').textContent=dCounts.KICK; $('dJump').textContent=dCounts.JUMP; $('dSprint').textContent=dCounts.SPRINT;

  if(rec){ rec.events.push({t:Date.now()-rec.startMs,type,a,g,air,h}); }
}
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
    if(rec){ rec.raw.ax.push(ax);rec.raw.ay.push(ay);rec.raw.az.push(az);rec.raw.gx.push(gx);rec.raw.gy.push(gy);rec.raw.gz.push(gz); }
    if(calib.on && calib.label){ calibSample(ax,ay,az,gx,gy,gz); }
  }
  if(rec) rec.samples+=n;
  if(calib.on && calib.label){ calib.count+=n; updateCalibUI(); }
}

// ================= ЗАПИСЬ =================
$('recBtn').onclick=()=>{ rec?stopRec(false):startRec(); };
async function startRec(){
  if(!connected) return;
  rec={startMs:Date.now(), events:[], raw:{ax:[],ay:[],az:[],gx:[],gy:[],gz:[]}, samples:0};
  dCounts={KICK:0,JUMP:0,SPRINT:0};
  $('sKick').textContent='0';$('sJump').textContent='0';$('sSprint').textContent='0';
  try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 1')); }catch(e){ alert('не удалось начать: '+e.message); rec=null; return; }
  try{ wakeLock=await navigator.wakeLock.request('screen'); }catch(e){}
  $('recBtn').textContent='■ Остановить'; $('recState').textContent='● идёт запись'; $('recState').style.color='#ff4d6d';
  recTimer=setInterval(()=>{ const s=Math.floor((Date.now()-rec.startMs)/1000); $('recTime').textContent=mmss(s); },500);
  healthTimer=setInterval(()=>{ const el=(Date.now()-rec.startMs)/1000; const hz=el>0?Math.round(rec.samples/el):0;
    $('recHealth').innerHTML=`поток: <b>${hz}</b> Гц · сэмплов: ${rec.samples}`; },1000);
}
async function stopRec(silent){
  const r=rec; rec=null;
  clearInterval(recTimer); clearInterval(healthTimer);
  try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 0')); }catch(e){}
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
let calib={on:false,label:null,count:0,data:{}};

function buildCalib(){
  $('calibLabels').innerHTML=CALIB_LABELS.map(([k,n])=>
    `<button class="ghost" id="cl_${k}" onclick="calibSelect('${k}')">${n}<div class="muted" id="cc_${k}">0</div></button>`).join('')+
    `<button class="ghost" onclick="calibPause()">⏸ Пауза</button>`;
  showSavedCalib();
}
function showSavedCalib(){
  let s=null; try{ s=JSON.parse(localStorage.getItem('fbl_calib')||'null'); }catch(e){}
  if(s&&s.zones){
    const d=new Date(s.ts);
    $('calibResult').innerHTML=`✅ <b>Сохранённая калибровка</b> · ${d.toLocaleString('ru-RU')}<br>
      Пороги активности: покой&lt;${s.zones.idle.toFixed(3)} · ходьба&lt;${s.zones.walk.toFixed(3)} · бег&lt;${s.zones.run.toFixed(3)}${s.kickGyro?` · удар&gt;${Math.round(s.kickGyro)}°/с`:''}<br>
      <span class="muted">эти пороги уже применяются в аналитике сессий</span>`;
  } else {
    $('calibResult').innerHTML='<span class="muted">калибровка ещё не сохранена — поделай движения и нажми «Рассчитать»</span>';
  }
}
async function calibSelect(label){
  if(!connected){ $('calibStatus').textContent='сначала подключи датчик (вкладка Датчик)'; return; }
  if(rec){ $('calibStatus').textContent='останови запись сессии перед калибровкой'; return; }
  if(!calib.on){ try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 1')); calib.on=true; }catch(e){ $('calibStatus').textContent='ошибка старта потока'; return; } }
  calib.label=label; if(!calib.data[label])calib.data[label]={act:[],gyro:[]};
  updateCalibUI();
}
function calibSample(ax,ay,az,gx,gy,gz){
  const d=calib.data[calib.label]; if(!d)return;
  d.act.push(Math.abs(Math.hypot(ax,ay,az)-1));
  d.gyro.push(Math.hypot(gx,gy,gz));
}
function calibPause(){ calib.label=null; updateCalibUI(); }
function updateCalibUI(){
  CALIB_LABELS.forEach(([k])=>{ const b=$('cl_'+k); if(b)b.style.borderColor=(calib.label===k)?'var(--accent)':'var(--line)';
    const c=$('cc_'+k); if(c)c.textContent=(calib.data[k]?calib.data[k].act.length:0); });
  const lbl=calib.label?(CALIB_LABELS.find(x=>x[0]===calib.label)||[])[1]:null;
  $('calibStatus').innerHTML = calib.label? `● запись: <b style="color:#ff4d6d">${lbl}</b> — делай движение` : (calib.on?'⏸ пауза — выбери движение':'выбери движение');
}
async function calibCalc(){
  const D=calib.data; const mean=a=>a&&a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const pct=(a,p)=>{if(!a||!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p/100*s.length))];};
  const mid=(a,b)=>(a!=null&&b!=null)?(a+b)/2:null;
  const idle=mean(D.IDLE&&D.IDLE.act), walk=mean(D.WALK&&D.WALK.act), run=mean(D.RUN&&D.RUN.act), sprint=mean(D.SPRINT&&D.SPRINT.act);
  if(idle==null&&walk==null&&run==null){ $('calibResult').textContent='мало данных — поделай хотя бы покой/ходьбу/бег'; return; }
  const zones={ idle: mid(idle,walk)??0.086, walk: mid(walk,run)??0.379, run: mid(run,sprint)??0.699 };
  const kickG = pct(D.KICK&&D.KICK.gyro,80);
  const saved={zones, kickGyro:kickG||null, ts:Date.now()};
  localStorage.setItem('fbl_zones',JSON.stringify(zones));
  localStorage.setItem('fbl_calib',JSON.stringify(saved));
  // остановить поток
  if(calib.on){ try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 0')); }catch(e){} calib.on=false; calib.label=null; }
  $('calibResult').innerHTML=`✓ сохранено. Пороги активности: покой&lt;${zones.idle.toFixed(3)} · ходьба&lt;${zones.walk.toFixed(3)} · бег&lt;${zones.run.toFixed(3)}${kickG?` · удар&gt;${Math.round(kickG)}°/с`:''}<br>Замеры: покой ${fmt(idle)} · ходьба ${fmt(walk)} · бег ${fmt(run)} · спринт ${fmt(sprint)}`;
  updateCalibUI();
  function fmt(v){return v==null?'—':v.toFixed(3);}
}
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
  // покидаем калибровку — остановить поток
  if(name!=='calib' && calib.on && !rec){ if(ctrlCh)ctrlCh.writeValue(new TextEncoder().encode('REC 0')).catch(()=>{}); calib.on=false; calib.label=null; }
  document.querySelectorAll('section').forEach(s=>s.classList.toggle('act',s.id==='tab-'+name));
  document.querySelectorAll('.nav a').forEach(a=>a.classList.toggle('act',a.dataset.tab===name));
  if(name==='history')renderHistory();
  if(name==='calib')buildCalib();
}

fillProfile(); renderHistory();
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
