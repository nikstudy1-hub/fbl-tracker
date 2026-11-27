/* FBL Tracker — BLE, запись сессий, хранение, экраны */
const SERVICE='a0f10000-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const EVENT  ='a0f10001-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const CTRL   ='a0f10002-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const DATA   ='a0f10003-5a2b-4e6c-9c3d-1f2e3d4c5b6a';

const EV = {KICK:{e:'⚽',svg:'i-ball',n:'KICK',c:'#ff7a3c'},
  IDLE:{e:'🧍',n:'IDLE',c:'#7a86a1'},WALK:{e:'🚶',n:'WALK',c:'#2dd4bf'},RUN:{e:'🏃',n:'RUN',c:'#37d67a'}};
// иконка события: вектор (мяч) если задан svg, иначе эмодзи-статус текстом
function svgIco(sym,color,size){ return `<svg class="ic" style="width:${size}px;height:${size}px;stroke:${color}"><use href="#${sym}"/></svg>`; }
function evIcon(info,size){ return (info&&info.svg) ? svgIco(info.svg,info.c,size) : (info?info.e:''); }

const $=id=>document.getElementById(id);
let dev=null, ctrlCh=null, connected=false, streaming=false, detector=null;
let prevState=null;
let dCounts={KICK:0};

// запись
let rec=null;              // {startMs, events:[], raw:{ax..}, samples}
let recTimer=null, healthTimer=null, wakeLock=null;

// ================= BLE =================
let wantConnected=false, connecting=false, reconnectTimer=null, retry=0;
$('connectBtn').onclick=()=>{ wantConnected ? userDisconnect() : connect(); };

// первый коннект: выбор устройства из системного диалога
async function connect(){
  if(!navigator.bluetooth){ alert('Chrome on Android required (Web Bluetooth).'); return; }
  try{
    setConn('searching…',false);
    dev=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[SERVICE]});
    dev.addEventListener('gattserverdisconnected',onDisc);
    wantConnected=true; retry=0;
    await connectGatt();
  }catch(e){ wantConnected=false; setConn('error',false); console.error(e); }
}

// (пере)подключение GATT к уже выбранному устройству — без повторного диалога
async function connectGatt(){
  if(connecting || !dev) return;
  connecting=true;
  try{
    setConn(retry?`reconnecting… (${retry})`:'connecting…',false);
    const srv=await dev.gatt.connect();
    const svc=await srv.getPrimaryService(SERVICE);
    const evc=await svc.getCharacteristic(EVENT);
    await evc.startNotifications();
    evc.addEventListener('characteristicvaluechanged',e=>onEvent(new TextDecoder().decode(e.target.value).trim()));
    const dc=await svc.getCharacteristic(DATA);
    await dc.startNotifications();
    dc.addEventListener('characteristicvaluechanged',e=>onData(e.target.value));
    ctrlCh=await svc.getCharacteristic(CTRL);
    connected=true; retry=0; sdOk=null; setConn('connected · '+(dev.name||'sensor'),true);
    $('connectBtn').textContent='Disconnect'; $('recBtn').disabled=false;
    // распознавание — на телефоне, по личным порогам; датчик просто стримит сырьё
    if(!detector) detector=new Detector({onEvent:onDetEvent, onState:onDetState});
    requestWake();   // держим экран, пока подключены — иначе Web Bluetooth рвёт связь при гашении
    // сперва узнаём состояние сессии на устройстве, затем синхронизируем офлайн-сессии
    requestStat();
    setTimeout(()=>startSync(), 500);   // разносим команды: у прошивки один буфер команд
    // прочитать статус SD (отправлен при подключении)
    const rd=async()=>{try{onEvent(new TextDecoder().decode(await evc.readValue()).trim());}catch(e){}};
    rd(); setTimeout(rd,400); setTimeout(rd,1200);
  }catch(e){
    console.error('connectGatt failed',e); connected=false;
    if(wantConnected) scheduleReconnect();
  }finally{ connecting=false; }
}

// разрыв соединения (само, не по кнопке) — держим запись и авто-переподключаемся
function onDisc(){
  connected=false; streaming=false; sync=null;
  const ss=$('syncStatus'); if(ss) ss.style.display='none';
  releaseWake();
  // автономная запись продолжается на устройстве — показываем это
  if(rec && rec.mode==='auto'){ $('recState').textContent='● recording on device (offline)'; $('recState').style.color='#ff4d6d'; }
  if(!wantConnected){
    detector=null;
    setConn('disconnected',false);
    $('connectBtn').textContent='Connect sensor'; $('recBtn').disabled=true;
    return;
  }
  $('recBtn').disabled=true;
  scheduleReconnect();
}
function scheduleReconnect(){
  clearTimeout(reconnectTimer);
  const delay=Math.min(1200*Math.pow(1.6,retry), 8000); retry++;
  setConn(`reconnecting… (${retry})`,false);
  reconnectTimer=setTimeout(()=>{ if(wantConnected) connectGatt(); }, delay);
}
// разрыв по кнопке пользователя — глушим авто-реконнект
function userDisconnect(){
  wantConnected=false; clearTimeout(reconnectTimer); retry=0;
  releaseWake();
  // live-режим: сохраняем накопленное ДО разрыва (команд на устройство не шлёт).
  // автономный: НЕ трогаем — запись продолжается на устройстве, в этом весь смысл режима.
  if(rec && rec.mode==='live') stopRec(true);
  try{ if(dev&&dev.gatt&&dev.gatt.connected) dev.gatt.disconnect(); }catch(e){}
  connected=false; streaming=false; detector=null;
  setConn('disconnected',false);
  $('connectBtn').textContent='Connect sensor'; $('recBtn').disabled=true;
  if(rec && rec.mode==='auto'){ $('recState').textContent='● recording on device (offline)'; $('recState').style.color='#ff4d6d'; }
}
// wake lock: удержание экрана. Освобождается системой при уходе со вкладки — берём заново при возврате.
async function requestWake(){
  if(wakeLock) return;
  try{ if('wakeLock' in navigator && document.visibilityState==='visible'){ wakeLock=await navigator.wakeLock.request('screen'); } }catch(e){}
}
function releaseWake(){ if(wakeLock){ try{wakeLock.release();}catch(e){} wakeLock=null; } }
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible' && wantConnected){
    requestWake();
    if(!connected && !connecting){ retry=0; connectGatt(); }   // экран вернулся — сразу переподключаемся
  }
});

// ---- текстовые сообщения датчика: только статус SD (движения ловит телефон) ----
function onEvent(msg){
  if(msg.startsWith('SD')||msg.startsWith('NO SD')){ const el=$('sdText')||$('sdPill'); el.textContent=msg;
    sdOk = msg.startsWith('SD OK') ? true : false; return; }
  if(msg.startsWith('BAT')){                     // "BAT <volts> <percent>"
    const p=msg.split(/\s+/); const v=parseFloat(p[1]), pct=parseInt(p[2]);
    const el=$('batText'); const pill=$('batPill');
    if(el && !isNaN(pct)){
      el.textContent = pct+'% · '+(isNaN(v)?'':v.toFixed(2)+'V');
      if(pill) pill.style.color = pct<=15 ? 'var(--impact)' : (pct<=40 ? 'var(--sprint)' : 'var(--run)');
    }
    return;
  }
  // состояние автономной сессии (ответ на STAT или уведомление при старте/стопе)
  if(msg.startsWith('SESSION ON')){
    if(stopping) return;                            // ждём подтверждения стопа — старый статус не воскрешает запись
    if(!rec) rec={mode:'auto', startMs:Date.now()};
    if(rec.mode==='auto'){ rec.pending=false; clearSesTimers(); recUI(true, false); }  // подтверждено устройством
    return;
  }
  if(msg.startsWith('SESSION OFF')){
    if(stopping){ stopping=false; clearSesTimers(); recUI(false); setTimeout(()=>startSync(), 300); return; }  // стоп подтверждён → тянем файл
    if(rec && rec.mode==='auto' && !rec.pending){ rec=null; recUI(false); }
    return;
  }
}
// ---- события от детектора на телефоне (по личным порогам) ----
function onDetEvent(type,data){
  const info=EV[type]; if(!info) return;
  const msg = `${type} a=${(data.a||0).toFixed(1)}g g=${Math.round(data.g||0)}`;
  hero(info,msg);
  if(dCounts[type]!==undefined){ dCounts[type]++; if(rec)recCount(type); }
  refreshCounts(); addLive(info,msg);
  if(rec && rec.events) rec.events.push({t:Date.now()-rec.startMs,type,a:data.a,g:data.g});
  // после разового события (удар) вернуть плашку к текущему состоянию,
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
  if(rec && rec.events) rec.events.push({t:Date.now()-rec.startMs,type:state,a:act});
}
function hero(info,msg){
  const e=$('heroE');
  if(info.svg){ e.innerHTML=svgIco(info.svg,info.c,58); }
  else { e.innerHTML=''; e.textContent=info.e; }
  $('heroN').textContent=info.n; $('heroN').style.color=info.c; $('heroD').textContent=msg;
}
function refreshCounts(){ $('dKick').textContent=dCounts.KICK; }
function recCount(type){
  if(type==='KICK')$('sKick').textContent=+($('sKick').textContent)+1;
}

// ---- сырые данные (бинарь) ----
function onData(dv){
  if(dv.getUint8(0)!==0x52){ onSyncPacket(dv); return; }   // 'R' = live-сырьё; иначе пакет файл-синка
  const n=Math.floor((dv.byteLength-3)/12);
  // номер пакета: пропуск = потерянные сэмплы (датчик обнуляет номер на каждый REC 1)
  const seq=dv.getUint16(1,true);
  if(lastSeq!=null && seq!==0){ const miss=(seq-lastSeq-1)&0xFFFF; if(miss>0 && miss<1000){ liveLost+=miss; if(rec&&rec.raw) rec.lostPkts=(rec.lostPkts||0)+miss; } }
  lastSeq=seq;
  for(let i=0;i<n;i++){
    const o=3+i*12;
    const ax=dv.getInt16(o,true)/1000, ay=dv.getInt16(o+2,true)/1000, az=dv.getInt16(o+4,true)/1000;
    const gx=dv.getInt16(o+6,true)/10,  gy=dv.getInt16(o+8,true)/10,  gz=dv.getInt16(o+10,true)/10;
    if(detector) detector.push(ax,ay,az,gx,gy,gz);     // распознавание по личным порогам
    if(rec && rec.raw){ rec.raw.ax.push(ax);rec.raw.ay.push(ay);rec.raw.az.push(az);rec.raw.gx.push(gx);rec.raw.gy.push(gy);rec.raw.gz.push(gz); }
    if(calib.recording){ calibSample(ax,ay,az,gx,gy,gz); }
    // отладка
    const aM=Math.hypot(ax,ay,az), gM=Math.hypot(gx,gy,gz);
    dbg.n++; dbg.lastA=aM; if(aM>dbg.peakA)dbg.peakA=aM; if(gM>dbg.peakG)dbg.peakG=gM;
    dbg.sumDyn+=Math.abs(aM-1); dbg.cntDyn++;
  }
  if(rec && rec.raw) rec.samples+=n;
}
let dbg={n:0,peakA:0,peakG:0,lastA:1,sumDyn:0,cntDyn:0};
let lastSeq=null, liveLost=0;
setInterval(()=>{
  const el=$('dbg'); if(!el)return;
  if(!connected){ el.textContent='no data — connect sensor'; return; }
  // показываем РЕАЛЬНЫЙ действующий порог (как его видит детектор): manual → своя/базовая калибровка
  const a=activeCalib();
  const kickTag = a.manual ? ' (manual)' : (a.source==='preset' ? ' (base)' : ' (mine)');
  const act=dbg.cntDyn?dbg.sumDyn/dbg.cntDyn:0;
  el.innerHTML=`stream ${dbg.n*2} Hz · a=${dbg.lastA.toFixed(1)}g<br>`+
    `<b style="color:#ff7a3c">PEAK acc=${dbg.peakA.toFixed(1)}g</b> · peak gyro=${Math.round(dbg.peakG)}<br>`+
    `act=${act.toFixed(2)} · state ${prevState||'—'}${liveLost?` · lost pkts ${liveLost}`:''}<br>`+
    `kick thr &gt;${a.kickAcc}g${kickTag} + swing &gt;${a.kickGyro}°/s${a.manualGyro?' (manual)':''} · run thr &gt;${a.zones.walk.toFixed(2)}`;
  dbg.n=0;dbg.peakA=0;dbg.peakG=0;dbg.sumDyn=0;dbg.cntDyn=0;
},500);

// ================= ЗАПИСЬ =================
$('recBtn').onclick=()=>{ rec?stopRec(false):startRec(); };
// ---- режимы записи: 'auto' (устройство пишет на карту) / 'live' (телефон копит поток) ----
let recMode = localStorage.getItem('fbl_recmode') || 'auto';
function setMode(m){
  if(rec) return;                                  // не менять во время записи
  recMode=m; localStorage.setItem('fbl_recmode',m);
  document.querySelectorAll('.modeBtn').forEach(b=>{ const on=b.dataset.mode===m;
    b.style.borderColor=on?'var(--accent)':'var(--line)'; b.style.background=on?'#12233d':'var(--card2)'; });
  const h=$('modeHint'); if(h) h.textContent = m==='live'
    ? 'Live: телефон копит поток, сессия сохраняется сразу по Stop. Держи приложение открытым.'
    : 'Autonomous: устройство пишет на свою карту, телефон можно убрать. Подтянется по Stop.';
}

// автономка подтверждается устройством ("SESSION ON/OFF"): без подтверждения запись не считаем начатой/остановленной
let sdOk=null, stopping=false, sesTimers=[];
function clearSesTimers(){ sesTimers.forEach(clearTimeout); sesTimers=[]; }
function recWarn(msg){ $('recHealth').innerHTML=`<span style="color:var(--sprint)">⚠ ${msg}</span>`; }

async function startRec(){
  if(!connected || !ctrlCh){ recWarn('sensor not connected — connect it on the Sensor tab'); return; }
  if(recMode==='live'){
    rec={mode:'live', startMs:Date.now(), raw:{ax:[],ay:[],az:[],gx:[],gy:[],gz:[]}, events:[], samples:0};
    lastSeq=null; try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 1')); streaming=true; }catch(e){}
    recUI(true);
    return;
  }
  if(sdOk===false){ recWarn('no SD card in the sensor — Autonomous records to the card. Insert a card and restart the sensor, or use Live.'); return; }
  try{ await ctrlCh.writeValue(new TextEncoder().encode('SES 1')); }
  catch(e){ recWarn('sensor did not respond — try again'); return; }
  rec={mode:'auto', startMs:Date.now(), pending:true};
  recUI(true);
  $('recState').textContent='… starting on the sensor';
  clearSesTimers();
  sesTimers.push(setTimeout(()=>requestStat(), 1500));             // уведомление могло потеряться — переспросим
  sesTimers.push(setTimeout(()=>{
    if(rec && rec.pending){ rec=null; recUI(false);
      recWarn('the sensor did not start recording (check the SD card: the SD badge must show "SD OK"). Nothing is being recorded.'); }
  }, 4500));
}
async function stopRec(silent){
  if(!rec) return;
  if(rec.mode==='live'){                           // сохраняем сессию из телефона сразу
    const r=rec; rec=null; recUI(false);
    if(r.samples>0 || r.events.length>0){
      const sess={ id:Date.now(), date:new Date().toISOString(), type:$('sType').value, note:$('sNote').value,
        durationMs:Date.now()-r.startMs, events:r.events, raw:r.raw, samples:r.samples, lostPkts:r.lostPkts||0 };
      await dbAdd(sess); if(!silent){ renderHistory(); openAnalytics(sess.id); }
    }
    return;
  }
  // автономка: стоп только при живой связи, иначе датчик продолжит писать, а мы бы «забыли» о записи
  if(!connected || !ctrlCh){ recWarn('sensor not connected — the sensor is still recording. Reconnect and press Stop again.'); return; }
  try{ await ctrlCh.writeValue(new TextEncoder().encode('SES 0')); }
  catch(e){ recWarn('sensor did not respond — it is still recording. Press Stop again.'); return; }
  rec=null; stopping=true; recUI(false);
  $('recState').textContent='… stopping on the sensor';
  clearSesTimers();
  sesTimers.push(setTimeout(()=>requestStat(), 1500));
  sesTimers.push(setTimeout(()=>{                  // подтверждение не пришло — всё равно пробуем синк
    if(stopping){ stopping=false; recUI(false); if(connected) startSync(); }
  }, 5000));
}
function recUI(on, resetCounts){
  if(on){
    if(resetCounts!==false){ dCounts={KICK:0}; $('sKick').textContent='0'; }
    requestWake();
    $('recBtn').textContent='■ Stop training'; $('recState').textContent='● recording'; $('recState').style.color='#ff4d6d';
    $('recHealth').innerHTML = (rec&&rec.mode==='live') ? 'live-запись в телефон — держи приложение открытым' : 'можно заблокировать телефон — запись идёт на устройстве';
    clearInterval(recTimer);
    recTimer=setInterval(()=>{ if(rec){ const s=Math.floor((Date.now()-rec.startMs)/1000); $('recTime').textContent=mmss(s); } },500);
  } else {
    clearInterval(recTimer);
    $('recBtn').textContent='● Start training'; $('recState').textContent='not recording'; $('recState').style.color='';
    $('recTime').textContent='00:00'; $('recHealth').innerHTML='';
  }
}
document.querySelectorAll('.modeBtn').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
setMode(recMode);

// ================= IndexedDB =================
let _db=null;
function db(){ return new Promise((res,rej)=>{ if(_db)return res(_db);
  const q=indexedDB.open('fbl',1); q.onupgradeneeded=()=>q.result.createObjectStore('sessions',{keyPath:'id'});
  q.onsuccess=()=>{_db=q.result;res(_db);}; q.onerror=()=>rej(q.error); }); }
async function dbAdd(s){ const d=await db(); return new Promise(r=>{ d.transaction('sessions','readwrite').objectStore('sessions').put(s).onsuccess=r; }); }
async function dbAll(){ const d=await db(); return new Promise(r=>{ const rq=d.transaction('sessions').objectStore('sessions').getAll(); rq.onsuccess=()=>r(rq.result||[]); }); }
async function dbGet(id){ const d=await db(); return new Promise(r=>{ const rq=d.transaction('sessions').objectStore('sessions').get(id); rq.onsuccess=()=>r(rq.result); }); }
async function dbDel(id){ const d=await db(); return new Promise(r=>{ d.transaction('sessions','readwrite').objectStore('sessions').delete(id).onsuccess=r; }); }

// ================= OFFLINE-СИНХРОНИЗАЦИЯ (SES*.BIN сырьё с карты) =================
let sync=null, syncMsgTimer=null;
function syncedSet(){ try{ return new Set(JSON.parse(localStorage.getItem('fbl_synced_ses')||'[]')); }catch(e){ return new Set(); } }
function markSynced(name){ const s=syncedSet(); s.add(name); localStorage.setItem('fbl_synced_ses', JSON.stringify([...s])); }
// ключ «уже выгружено» — с именем датчика: у каждого датчика своя нумерация SES00000…, без имени файлы
// второго датчика с теми же номерами считались бы выгруженными и молча пропускались
function syncKey(file){ return ((dev&&dev.name)||'?')+'/'+file; }
function setSync(msg, hideAfter){ const el=$('syncStatus'); if(!el)return; el.textContent='🔄 '+msg; el.style.display='block';
  clearTimeout(syncMsgTimer); if(hideAfter) syncMsgTimer=setTimeout(()=>{ el.style.display='none'; }, hideAfter); }

// спросить у устройства, идёт ли автономная сессия (ответ придёт как "SESSION ON/OFF")
async function requestStat(){
  if(!ctrlCh) return;
  try{ await ctrlCh.writeValue(new TextEncoder().encode('STAT')); }catch(e){}
}
async function startSync(){
  if(!ctrlCh || sync){ enableLive(); return; }
  sync={ files:[], queue:[], cur:null, done:0 };
  setSync('checking device…');
  try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 0')); streaming=false; }catch(e){}  // глушим live-стрим
  try{ await ctrlCh.writeValue(new TextEncoder().encode('LIST')); }catch(e){ finishSync(); }
}
function onSyncPacket(dv){
  if(!sync) return;
  const type=String.fromCharCode(dv.getUint8(0));
  if(type==='D'){                                   // бинарный кусок файла
    if(sync.cur){ const b=new Uint8Array(dv.buffer.slice(dv.byteOffset+1, dv.byteOffset+dv.byteLength));
      sync.cur.parts.push(b); sync.cur.recv+=b.length;
      const now=performance.now();
      if(sync.cur.size && now-(sync.cur.uiT||0)>250){ sync.cur.uiT=now;
        setSync(`downloading ${sync.cur.name}: ${Math.round(100*sync.cur.recv/sync.cur.size)}%${sync.retry?` (try ${sync.retry.tries+1}/${SYNC_TRIES})`:''}`); } }
    return;
  }
  const s=new TextDecoder().decode(dv), payload=s.slice(1);
  if(type==='L'){ const c=payload.split(','); sync.files.push({name:c[0], size:parseInt(c[1])||0}); }
  else if(type==='E' && payload==='LIST'){ onListDone(); }
  else if(type==='B'){ const c=payload.split(','); sync.cur={name:c[0], size:parseInt(c[1])||0, parts:[], recv:0}; }
  else if(type==='E' && payload==='FILE'){ onFileDone(); }
}
function onListDone(){
  const done=syncedSet();
  sync.queue = sync.files.filter(f=>/^SES\d+\.(CSV|BIN)$/i.test(f.name) && f.size>=500 && !done.has(syncKey(f.name)));
  if(!sync.queue.length){ setSync('no new sessions', 2500); finishSync(); return; }
  setSync(`${sync.queue.length} new session(s) to download`);
  nextInQueue();
}
async function nextInQueue(){
  const f=sync.queue.shift();
  if(!f){ setSync(`✓ synced ${sync.done} session(s)`, 4000); finishSync(); return; }
  setSync(`downloading ${f.name}…`);
  try{ await ctrlCh.writeValue(new TextEncoder().encode('GET '+f.name)); }catch(e){ finishSync(); }
}
// недокачка (часть BLE-пакетов не дошла) → качаем файл ещё раз, до SYNC_TRIES раз всего, берём самый полный
const SYNC_TRIES=3;
async function onFileDone(){
  const c=sync.cur; sync.cur=null;
  if(c){
    try{
      let buf=new Uint8Array(await new Blob(c.parts).arrayBuffer());
      const r = (sync.retry && sync.retry.name===c.name) ? sync.retry : {name:c.name, tries:0, best:null};
      r.tries++; if(!r.best || buf.length>r.best.length) r.best=buf;
      const complete = !c.size || buf.length===c.size;
      if(!complete && r.tries<SYNC_TRIES && connected && ctrlCh){
        sync.retry=r;
        setSync(`${c.name}: ${(100*buf.length/c.size).toFixed(1)}% arrived — downloading again (${r.tries+1}/${SYNC_TRIES})…`);
        try{ await ctrlCh.writeValue(new TextEncoder().encode('GET '+c.name)); return; }catch(e){}
      }
      sync.retry=null; buf=complete ? buf : r.best;
      const sess=sessionFromRaw(c.name, buf, c.size, r.tries);
      if(sess){ sess.note=((dev&&dev.name)?dev.name+' · ':'')+sess.note;
                await dbAdd(sess); markSynced(syncKey(c.name)); sync.done++; renderHistory();
                if(sess.diag) setSync(sess.diag, 15000); }
      else markSynced(syncKey(c.name));   // мусорный/пустой файл — не тянем повторно
    }catch(e){ console.error('parse fail',e); }
  }
  nextInQueue();
}
// Собираем объект сессии из CSV-сырья + прогон детектора по личным порогам.
// Формат строки: ax,ay,az,gx,gy,gz (ускорение в мg, гироскоп в dps*10).
// declared — размер файла, заявленный устройством (проверка целостности выгрузки).
function sessionFromRaw(name, buf, declared, tries){
  const lines=new TextDecoder().decode(buf).split('\n');
  const raw={ax:[],ay:[],az:[],gx:[],gy:[],gz:[]};
  let skipped=0;
  for(const line of lines){
    const t=line.trim(); if(!t) continue;
    if(t.charCodeAt(0)>57){ skipped++; continue; }          // заголовок/мусор — не цифра и не минус
    const v=t.split(',');
    if(v.length!==6){ skipped++; continue; }                 // оборванная строка — пропускаем целиком
    const ax=+v[0]/1000, ay=+v[1]/1000, az=+v[2]/1000, gx=+v[3]/10, gy=+v[4]/10, gz=+v[5]/10;
    if(![ax,ay,az,gx,gy,gz].every(Number.isFinite)){ skipped++; continue; }
    raw.ax.push(ax); raw.ay.push(ay); raw.az.push(az); raw.gx.push(gx); raw.gy.push(gy); raw.gz.push(gz);
  }
  const rec=raw.ax.length; if(rec<50) return null;
  // сырьё в базе храним как пришло; события считаем по очищенному (битые склейки строк → вне диапазона)
  const cl=cleanRaw(raw);
  const events=detectEvents(cl.raw);
  const kicks=events.filter(e=>e.type==='KICK').length;
  const sizeOk = !declared || buf.length===declared;
  const lostPct = declared ? Math.max(0, 100*(1-buf.length/declared)) : 0;
  const diag = `${name}: ${rec} smp · broken ${cl.nRange+cl.nSpike} · skip ${skipped} · kicks ${kicks} · ${sizeOk?'size OK':'lost '+lostPct.toFixed(1)+'%'}`;
  console.log('SYNC DIAG', diag);
  return { id:Date.now()+Math.floor(Math.random()*1000), date:new Date().toISOString(),
           type:'Offline', note:name+(sizeOk?'':` ⚠ incomplete (−${lostPct.toFixed(1)}%)`), durationMs:rec*10,
           events, raw, samples:rec, offline:true, diag,
           xfer:{ declared:declared||0, got:buf.length, skipped, tries:tries||1 } };
}
function finishSync(){ sync=null; enableLive(); }
// включаем live-стрим (после завершения синка)
async function enableLive(){ if(connected && ctrlCh){ lastSeq=null; try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 1')); streaming=true; }catch(e){} } }

// ================= ИСТОРИЯ =================
async function renderHistory(){
  const list=await dbAll(); list.sort((a,b)=>b.id-a.id);
  if(!list.length){ $('histList').innerHTML='<div class="muted">no recorded sessions yet</div>'; return; }
  $('histList').innerHTML=list.map(s=>{
    const d=new Date(s.id); const dur=mmss(Math.floor(s.durationMs/1000));
    const k=sessionKicks(s);
    return `<div class="row" onclick="openAnalytics(${s.id})" style="cursor:pointer">
      <span class="ico">📊</span>
      <span style="flex:1"><b>${s.type}</b> · ${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}
        <div class="muted">${dur} · ${svgIco('i-ball','var(--kick)',12)}${k} · ${s.samples} samples</div></span>
      <span class="muted">›</span></div>`;
  }).join('');
}

// ================= АНАЛИТИКА =================
async function openAnalytics(id){
  const s0=await dbGet(id); if(!s0) return;
  const s=sessionView(s0);           // сырьё очищено, события пересчитаны по текущим порогам
  const prof=loadProfile();
  const m=analyze(s,prof);
  const d=new Date(s.id);
  $('analytics').innerHTML=`
    <div class="card">
      <h2>${s.type} · ${d.toLocaleDateString('en-GB')}</h2>
      <div class="muted">${d.toLocaleTimeString('en-GB')} · duration ${mmss(Math.floor(m.durS))}${s.note?' · '+s.note:''}</div>
      ${qualityLine(s)}
    </div>
    <div class="grid2">
      <div class="tile"><div class="n" style="color:var(--kick)">${m.kicks}</div><div class="l"><svg class="ic" style="stroke:var(--kick)"><use href="#i-ball"/></svg>kicks</div></div>
      <div class="tile"><div class="n" style="color:var(--kick)">${m.maxKickG?m.maxKickG.toFixed(1):'—'}</div><div class="l">peak kick, g</div></div>
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
    <div class="card"><h3>Running</h3>
      <div class="grid3" style="margin-top:10px">
        <div class="tile"><div class="n">${(m.distM/1000).toFixed(2)}</div><div class="l">distance, km*</div></div>
        <div class="tile"><div class="n">${m.avgKmh.toFixed(1)}</div><div class="l">avg speed, km/h*</div></div>
        <div class="tile"><div class="n">${m.gctMs||'—'}</div><div class="l">foot contact, ms</div></div>
      </div>
      <div class="muted" style="margin-top:6px">* approximate (from cadence and stride)</div>
    </div>
    <div class="card">
      <button class="big ghost" onclick="exportCSV('download')">⬇ Download CSV (for ML)</button>
      ${canShareFiles()?'<button class="big ghost" style="margin-top:10px" onclick="exportCSV(\'share\')">📤 Share / save to Files</button>':''}
      <button class="big ghost" style="margin-top:10px" onclick="exportCSV('copy')">📋 Copy CSV as text</button>
      <div class="muted" id="exportMsg" style="margin-top:8px"></div>
      <button class="big ghost" style="margin-top:10px" onclick="delSession(${s.id})">🗑 Delete session</button>
    </div>`;
  curSession=s;
  showTab('analytics');
}
// качество данных: сколько сэмплов починено, сколько не доехало
function qualityLine(s){
  const parts=[];
  if(s.clean){ const fixed=s.clean.nRange+s.clean.nSpike;
    parts.push(fixed ? `🧹 ${fixed} broken samples fixed (${(100*fixed/Math.max(1,s.clean.n)).toFixed(2)}%)` : '✓ no broken samples'); }
  if(s.xfer && s.xfer.declared && s.xfer.got<s.xfer.declared)
    parts.push(`⚠ ${(100*(1-s.xfer.got/s.xfer.declared)).toFixed(1)}% of the file did not arrive`);
  if(s.lostPkts) parts.push(`⚠ ${s.lostPkts} live packets lost`);
  return parts.length ? `<div class="muted" style="margin-top:4px;font-size:12px">${parts.join(' · ')}</div>` : '';
}
async function delSession(id){ if(confirm('Delete session?')){ await dbDel(id); renderHistory(); showTab('history'); } }

// экспорт: сырьё + события в CSV. Сессия берётся из уже открытой аналитики (curSession), а не из базы:
// «Поделиться» на iPhone требует вызова прямо из нажатия, ожидание IndexedDB этот признак теряет.
let curSession=null;
function canShareFiles(){
  try{ return !!(navigator.canShare && navigator.canShare({files:[new File(['x'],'t.csv',{type:'text/csv'})]})); }catch(e){ return false; }
}
function sessionCSV(s){
  const out=['# events','t_ms,type,a_g,gyro_dps'];
  s.events.forEach(e=>out.push(`${e.t},${e.type},${e.a??''},${e.g??''}`));
  // flag: 0 — как есть, 1 — было вне диапазона датчика, 2 — одиночный всплеск ускорения, 3 — скачок гиро (1–3 заменены интерполяцией)
  out.push('','# raw @100Hz (cleaned; flag>0 = sample was broken and interpolated)','i,ax,ay,az,gx,gy,gz,flag');
  const R=s.raw||{ax:[]}; const r=v=>Math.round(v*1000)/1000; const F=s.clean&&s.clean.flag;
  for(let i=0;i<R.ax.length;i++) out.push(`${i},${r(R.ax[i])},${r(R.ay[i])},${r(R.az[i])},${r(R.gx[i])},${r(R.gy[i])},${r(R.gz[i])},${F?F[i]:0}`);
  return out.join('\n')+'\n';
}
async function exportCSV(how){
  const s=curSession; const msg=$('exportMsg'); if(!s) return;
  const d=new Date(s.id), p=n=>String(n).padStart(2,'0');
  const name=`fbl_${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.csv`;
  const csv=sessionCSV(s);
  try{
    if(how==='share'){
      await navigator.share({files:[new File([csv],name,{type:'text/csv'})], title:name});
      if(msg) msg.textContent='✓ shared';
    } else if(how==='copy'){
      await navigator.clipboard.writeText(csv);
      if(msg) msg.textContent=`✓ copied (${Math.round(csv.length/1024)} KB) — paste into Notes / Telegram / email`;
    } else {
      // ссылку кладём в документ и отзываем не сразу: Chrome на Android скачивает blob асинхронно,
      // и при отзыве через 1 с (как было) файл не сохранялся
      const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
      const a=document.createElement('a'); a.href=url; a.download=name; a.style.display='none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 60000);
      if(msg) msg.textContent=`⬇ ${name} — look in Downloads. Nothing saved? Use ${canShareFiles()?'"Share" or ':''}"Copy".`;
    }
  }catch(e){
    if(e && e.name==='AbortError') return;          // пользователь закрыл окно «Поделиться»
    console.error('export failed',e);
    if(msg) msg.innerHTML=`<span style="color:var(--sprint)">⚠ ${how} failed on this browser — try another button</span>`;
  }
}

// ================= КАЛИБРОВКА =================
const CALIB_LABELS=[['IDLE','🧍 Idle'],['WALK','🚶 Walk'],['RUN','🏃 Run'],['KICK','⚽ Kick']];
let calib={recording:null, startMs:0, timer:null, data:{}};

// ---- режим калибровки: базовая (предустановленная) / своя ----
function setCalibMode(m){
  if(calib.recording) calibStop();
  try{ localStorage.setItem('fbl_calibmode', m); }catch(e){}
  if(detector) detector.reloadThresholds();
  buildCalib();
}
document.querySelectorAll('.calModeBtn').forEach(b=>b.onclick=()=>setCalibMode(b.dataset.cmode));
function renderCalibMode(){
  const m=calibMode();
  document.querySelectorAll('.calModeBtn').forEach(b=>{ const on=b.dataset.cmode===m;
    b.style.borderColor=on?'var(--accent)':'var(--line)'; b.style.background=on?'#12233d':'var(--card2)'; });
  $('calModeHint').textContent = m==='preset'
    ? 'Base: ready-made thresholds from a reference recording (sensor on the ankle). Works right away, no calibration needed.'
    : 'Mine: thresholds from your own movements. Until you tap "Calculate", the base thresholds are used.';
  $('calibCustomCard').style.display = m==='custom' ? 'block' : 'none';
}

function buildCalib(){
  loadCalibData();
  renderCalibMode();
  loadKickManual();
  if(calibMode()==='preset'){
    const P=PRESET_CALIB;
    renderCalibSummary(P.stats, P.zones, 'Base calibration', false);
    return;
  }
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
  const s=readCalib();
  if(s.zones){ const d=new Date(s.ts);
    $('calibResult').innerHTML=`✅ <b>Saved</b> ${d.toLocaleString('en-GB')} · kick&gt;${s.kickAcc||'—'}g`;
    renderCalibSummary(statsFromData(calib.data), s.zones, 'My calibration', true);
  } else {
    $('calibResult').innerHTML='<span class="muted">do the movements and tap "Calculate" — until then the base thresholds are used</span>';
    $('calibSummaryCard').style.display='none';
  }
}
// статистика своей записи — в том же виде, что PRESET_CALIB.stats
function statsFromData(D){
  const s={};
  CALIB_LABELS.forEach(([k])=>{ const d=D[k]; if(!d||!d.act||!d.act.length) return;
    s[k]={ n:d.act.length, act:d.act.reduce((x,y)=>x+y,0)/d.act.length,
           acc:d.acc.reduce((m,v)=>v>m?v:m,0), gyro:d.gyro.reduce((m,v)=>v>m?v:m,0) }; });
  return s;
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
  const maxG=a=>a&&a.length?a.reduce((m,v)=>v>m?v:m,0):0;
  const kickGyro=kickGyroFrom(maxG(D.RUN&&D.RUN.gyro), maxG(D.KICK&&D.KICK.gyro));   // null → базовый
  return {zones, kickAcc, kickGyro, runAccMax, kickAccMax};
}
function calibCalc(){
  if(calib.recording) calibStop();
  const t=computeThresholds(calib.data);
  if(!t){ $('calibResult').innerHTML='<span style="color:var(--sprint)">record at least Walk and Run</span>'; return; }
  let prev={}; try{prev=JSON.parse(localStorage.getItem('fbl_calib')||'{}');}catch(e){}
  const saved={zones:t.zones, kickAcc:t.kickAcc, ts:Date.now()};
  if(t.kickGyro) saved.kickGyro=t.kickGyro;
  if(prev.kickManual!=null) saved.kickManual=prev.kickManual;   // ручной override не затираем
  if(prev.kickGyroManual!=null) saved.kickGyroManual=prev.kickGyroManual;
  localStorage.setItem('fbl_zones',JSON.stringify(t.zones));
  localStorage.setItem('fbl_calib',JSON.stringify(saved));
  localStorage.setItem('fbl_calibmode','custom');
  saveCalibData();
  if(detector) detector.reloadThresholds();
  $('calibResult').innerHTML='<span style="color:var(--run)">✓ Saved permanently and applied — to the home screen and analytics.</span>';
  renderCalibSummary(statsFromData(calib.data), saved.zones, 'My calibration', true);
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
    if(t.kickGyro) saved.kickGyro=t.kickGyro;
    if(prev.kickManual!=null) saved.kickManual=prev.kickManual;   // ручной override не затираем
    if(prev.kickGyroManual!=null) saved.kickGyroManual=prev.kickGyroManual;
    localStorage.setItem('fbl_calib',JSON.stringify(saved)); }
}
// ---- ручной порог удара (override): перебивает автоформулу, не затирается пересчётом ----
function loadKickManual(){
  const c=readCalib();
  if($('kickManual')) $('kickManual').value = (c.kickManual!=null ? c.kickManual : '');
  if($('kickGyroManual')) $('kickGyroManual').value = (c.kickGyroManual!=null ? c.kickGyroManual : '');
  updateKickManualMsg();
}
function updateKickManualMsg(){
  const el=$('kickManualMsg'); if(!el)return;
  const a=activeCalib(), src=a.source==='preset'?'base':'mine';
  const accTxt = a.manual ? `<span style="color:var(--run)"><b>${a.kickAcc}g</b> manual (${src}: ${a.autoKick}g)</span>` : `<b>${a.autoKick}g</b> auto (${src})`;
  const gyrTxt = a.manualGyro ? `<span style="color:var(--run)"><b>${a.kickGyro}°/s</b> manual (${src}: ${a.autoGyro}°/s)</span>` : `<b>${a.autoGyro}°/s</b> auto (${src})`;
  el.innerHTML=`Kick = impact over ${accTxt}<br>and leg swing over ${gyrTxt}`;
}
function applyKickManual(){
  let c={}; try{ c=JSON.parse(localStorage.getItem('fbl_calib')||'{}'); }catch(e){}
  const v=($('kickManual').value||'').trim(), vg=(($('kickGyroManual')&&$('kickGyroManual').value)||'').trim();
  const bad=()=>{ $('kickManualMsg').innerHTML='<span style="color:var(--sprint)">enter a positive number (or leave empty for auto)</span>'; };
  if(v===''){ delete c.kickManual; }
  else { const n=parseFloat(v); if(isNaN(n)||n<=0) return bad(); c.kickManual=+n.toFixed(1); }
  if(vg===''){ delete c.kickGyroManual; }
  else { const n=parseFloat(vg); if(isNaN(n)||n<0) return bad(); c.kickGyroManual=Math.round(n); }
  localStorage.setItem('fbl_calib',JSON.stringify(c));
  if(detector) detector.reloadThresholds();
  updateKickManualMsg();
  if(calibMode()==='preset') buildCalib();                 // обновить строку порога в таблице базовой
  else if(c.zones) renderCalibSummary(statsFromData(calib.data), c.zones, 'My calibration', true);
}
// таблица калибровки: stats {KEY:{n,act,acc,gyro}}, зоны, заголовок, кнопка сброса (только у своей)
function renderCalibSummary(stats, zones, title, canReset){
  const a=activeCalib();
  const td=v=>`<td style="padding:5px 6px">${v}</td>`;
  const rows=CALIB_LABELS.map(([k,n])=>{
    const d=stats[k]; if(!d) return `<tr>${td(n)}<td colspan="4" class="muted" style="padding:5px 6px">none</td></tr>`;
    return `<tr>${td(n)}${td(d.n)}${td(d.act.toFixed(2))}${td(d.acc.toFixed(1)+'g')}${td(Math.round(d.gyro))}</tr>`;
  }).join('');
  $('calibSummaryTitle').textContent=title;
  $('calibSummary').innerHTML=`
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr class="muted">${td('movement')}${td('samples')}${td('activity')}${td('peak acc')}${td('gyro')}</tr>
      ${rows}</table></div>
    <div style="margin-top:12px;font-size:14px"><b>Thresholds (applied):</b><br>
      zones: idle&lt;${zones.idle.toFixed(3)} · walk&lt;${zones.walk.toFixed(3)} · run&lt;${zones.run.toFixed(3)}<br>
      kick: acceleration&gt;${a.kickAcc}g${a.manual?' (manual)':''} and leg swing&gt;${a.kickGyro}°/s${a.manualGyro?' (manual)':''}</div>
    ${canReset?'<button class="big ghost" style="margin-top:14px" onclick="calibReset()">↻ Restart calibration</button>':''}`;
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
  r.innerHTML=`<span class="ico">${evIcon(info,18)}</span><span class="t" style="color:${info.c}">${info.n}</span><span class="d">${msg}</span><span class="tm">${t}</span>`;
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

const APP_VERSION='v2.11';
if($('ver')) $('ver').textContent=APP_VERSION;
applyCalibFromData();   // подхватить и пересчитать сохранённую калибровку
fillProfile(); renderHistory();
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
