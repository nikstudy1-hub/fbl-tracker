/* FBL Tracker вЂ” BLE, Р·Р°РїРёСЃСЊ СЃРµСЃСЃРёР№, С…СЂР°РЅРµРЅРёРµ, СЌРєСЂР°РЅС‹ */
const SERVICE='a0f10000-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const EVENT  ='a0f10001-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const CTRL   ='a0f10002-5a2b-4e6c-9c3d-1f2e3d4c5b6a';
const DATA   ='a0f10003-5a2b-4e6c-9c3d-1f2e3d4c5b6a';

const EV = {KICK:{e:'вљЅ',svg:'i-ball',n:'KICK',c:'#ff7a3c'},JUMP:{e:'рџ¦',svg:'i-jump',n:'JUMP',c:'#b06bff'},
  IDLE:{e:'рџ§Ќ',n:'IDLE',c:'#7a86a1'},WALK:{e:'рџљ¶',n:'WALK',c:'#2dd4bf'},RUN:{e:'рџЏѓ',n:'RUN',c:'#37d67a'}};
// РёРєРѕРЅРєР° СЃРѕР±С‹С‚РёСЏ: РІРµРєС‚РѕСЂ (РјСЏС‡/РїСЂС‹Р¶РѕРє) РµСЃР»Рё Р·Р°РґР°РЅ svg, РёРЅР°С‡Рµ СЌРјРѕРґР·Рё-СЃС‚Р°С‚СѓСЃ С‚РµРєСЃС‚РѕРј
function svgIco(sym,color,size){ return `<svg class="ic" style="width:${size}px;height:${size}px;stroke:${color}"><use href="#${sym}"/></svg>`; }
function evIcon(info,size){ return (info&&info.svg) ? svgIco(info.svg,info.c,size) : (info?info.e:''); }

const $=id=>document.getElementById(id);
let dev=null, ctrlCh=null, connected=false, streaming=false, detector=null;
let prevState=null;
let dCounts={KICK:0,JUMP:0};

// Р·Р°РїРёСЃСЊ
let rec=null;              // {startMs, events:[], raw:{ax..}, samples}
let recTimer=null, healthTimer=null, wakeLock=null;

// ================= BLE =================
let wantConnected=false, connecting=false, reconnectTimer=null, retry=0;
$('connectBtn').onclick=()=>{ wantConnected ? userDisconnect() : connect(); };

// РїРµСЂРІС‹Р№ РєРѕРЅРЅРµРєС‚: РІС‹Р±РѕСЂ СѓСЃС‚СЂРѕР№СЃС‚РІР° РёР· СЃРёСЃС‚РµРјРЅРѕРіРѕ РґРёР°Р»РѕРіР°
async function connect(){
  if(!navigator.bluetooth){ alert('Chrome on Android required (Web Bluetooth).'); return; }
  try{
    setConn('searchingвЂ¦',false);
    dev=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[SERVICE]});
    dev.addEventListener('gattserverdisconnected',onDisc);
    wantConnected=true; retry=0;
    await connectGatt();
  }catch(e){ wantConnected=false; setConn('error',false); console.error(e); }
}

// (РїРµСЂРµ)РїРѕРґРєР»СЋС‡РµРЅРёРµ GATT Рє СѓР¶Рµ РІС‹Р±СЂР°РЅРЅРѕРјСѓ СѓСЃС‚СЂРѕР№СЃС‚РІСѓ вЂ” Р±РµР· РїРѕРІС‚РѕСЂРЅРѕРіРѕ РґРёР°Р»РѕРіР°
async function connectGatt(){
  if(connecting || !dev) return;
  connecting=true;
  try{
    setConn(retry?`reconnectingвЂ¦ (${retry})`:'connectingвЂ¦',false);
    const srv=await dev.gatt.connect();
    const svc=await srv.getPrimaryService(SERVICE);
    const evc=await svc.getCharacteristic(EVENT);
    await evc.startNotifications();
    evc.addEventListener('characteristicvaluechanged',e=>onEvent(new TextDecoder().decode(e.target.value).trim()));
    const dc=await svc.getCharacteristic(DATA);
    await dc.startNotifications();
    dc.addEventListener('characteristicvaluechanged',e=>onData(e.target.value));
    ctrlCh=await svc.getCharacteristic(CTRL);
    connected=true; retry=0; setConn('connected',true);
    $('connectBtn').textContent='Disconnect'; $('recBtn').disabled=false;
    // СЂР°СЃРїРѕР·РЅР°РІР°РЅРёРµ вЂ” РЅР° С‚РµР»РµС„РѕРЅРµ, РїРѕ Р»РёС‡РЅС‹Рј РїРѕСЂРѕРіР°Рј; РґР°С‚С‡РёРє РїСЂРѕСЃС‚Рѕ СЃС‚СЂРёРјРёС‚ СЃС‹СЂСЊС‘
    if(!detector) detector=new Detector({onEvent:onDetEvent, onState:onDetState});
    requestWake();   // РґРµСЂР¶РёРј СЌРєСЂР°РЅ, РїРѕРєР° РїРѕРґРєР»СЋС‡РµРЅС‹ вЂ” РёРЅР°С‡Рµ Web Bluetooth СЂРІС‘С‚ СЃРІСЏР·СЊ РїСЂРё РіР°С€РµРЅРёРё
    // СЃРЅР°С‡Р°Р»Р° СЃРёРЅС…СЂРѕРЅРёР·РёСЂСѓРµРј РѕС„Р»Р°Р№РЅ-СЃРµСЃСЃРёРё СЃ РєР°СЂС‚С‹, РїРѕС‚РѕРј РІРєР»СЋС‡Р°РµРј live-СЃС‚СЂРёРј
    startSync();
    // РїСЂРѕС‡РёС‚Р°С‚СЊ СЃС‚Р°С‚СѓСЃ SD (РѕС‚РїСЂР°РІР»РµРЅ РїСЂРё РїРѕРґРєР»СЋС‡РµРЅРёРё)
    const rd=async()=>{try{onEvent(new TextDecoder().decode(await evc.readValue()).trim());}catch(e){}};
    rd(); setTimeout(rd,400); setTimeout(rd,1200);
  }catch(e){
    console.error('connectGatt failed',e); connected=false;
    if(wantConnected) scheduleReconnect();
  }finally{ connecting=false; }
}

// СЂР°Р·СЂС‹РІ СЃРѕРµРґРёРЅРµРЅРёСЏ (СЃР°РјРѕ, РЅРµ РїРѕ РєРЅРѕРїРєРµ) вЂ” РґРµСЂР¶РёРј Р·Р°РїРёСЃСЊ Рё Р°РІС‚Рѕ-РїРµСЂРµРїРѕРґРєР»СЋС‡Р°РµРјСЃСЏ
function onDisc(){
  connected=false; streaming=false; sync=null;
  const ss=$('syncStatus'); if(ss) ss.style.display='none';
  releaseWake();
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
  setConn(`reconnectingвЂ¦ (${retry})`,false);
  reconnectTimer=setTimeout(()=>{ if(wantConnected) connectGatt(); }, delay);
}
// СЂР°Р·СЂС‹РІ РїРѕ РєРЅРѕРїРєРµ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ вЂ” РіР»СѓС€РёРј Р°РІС‚Рѕ-СЂРµРєРѕРЅРЅРµРєС‚
function userDisconnect(){
  wantConnected=false; clearTimeout(reconnectTimer); retry=0;
  releaseWake();
  try{ if(dev&&dev.gatt&&dev.gatt.connected) dev.gatt.disconnect(); }catch(e){}
  connected=false; streaming=false; detector=null;
  if(rec) stopRec(true);
  setConn('disconnected',false);
  $('connectBtn').textContent='Connect sensor'; $('recBtn').disabled=true;
}
// wake lock: СѓРґРµСЂР¶Р°РЅРёРµ СЌРєСЂР°РЅР°. РћСЃРІРѕР±РѕР¶РґР°РµС‚СЃСЏ СЃРёСЃС‚РµРјРѕР№ РїСЂРё СѓС…РѕРґРµ СЃРѕ РІРєР»Р°РґРєРё вЂ” Р±РµСЂС‘Рј Р·Р°РЅРѕРІРѕ РїСЂРё РІРѕР·РІСЂР°С‚Рµ.
async function requestWake(){
  if(wakeLock) return;
  try{ if('wakeLock' in navigator && document.visibilityState==='visible'){ wakeLock=await navigator.wakeLock.request('screen'); } }catch(e){}
}
function releaseWake(){ if(wakeLock){ try{wakeLock.release();}catch(e){} wakeLock=null; } }
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible' && wantConnected){
    requestWake();
    if(!connected && !connecting){ retry=0; connectGatt(); }   // СЌРєСЂР°РЅ РІРµСЂРЅСѓР»СЃСЏ вЂ” СЃСЂР°Р·Сѓ РїРµСЂРµРїРѕРґРєР»СЋС‡Р°РµРјСЃСЏ
  }
});

// ---- С‚РµРєСЃС‚РѕРІС‹Рµ СЃРѕРѕР±С‰РµРЅРёСЏ РґР°С‚С‡РёРєР°: С‚РѕР»СЊРєРѕ СЃС‚Р°С‚СѓСЃ SD (РґРІРёР¶РµРЅРёСЏ Р»РѕРІРёС‚ С‚РµР»РµС„РѕРЅ) ----
function onEvent(msg){
  if(msg.startsWith('SD')||msg.startsWith('NO SD')){ const el=$('sdText')||$('sdPill'); el.textContent=msg; return; }
  if(msg.startsWith('BAT')){                     // "BAT <volts> <percent>"
    const p=msg.split(/\s+/); const v=parseFloat(p[1]), pct=parseInt(p[2]);
    const el=$('batText'); const pill=$('batPill');
    if(el && !isNaN(pct)){
      el.textContent = pct+'% В· '+(isNaN(v)?'':v.toFixed(2)+'V');
      if(pill) pill.style.color = pct<=15 ? 'var(--impact)' : (pct<=40 ? 'var(--sprint)' : 'var(--run)');
    }
    return;
  }
  if(msg.startsWith('SESSION ON')){ if(!rec){ rec={mode:'auto',startMs:Date.now()}; recUI(true); } return; }   // РЅР° СѓСЃС‚СЂРѕР№СЃС‚РІРµ РёРґС‘С‚ Р·Р°РїРёСЃСЊ
  if(msg.startsWith('SESSION OFF')){ if(rec && rec.mode==='auto'){ rec=null; recUI(false); } return; }
}
// ---- СЃРѕР±С‹С‚РёСЏ РѕС‚ РґРµС‚РµРєС‚РѕСЂР° РЅР° С‚РµР»РµС„РѕРЅРµ (РїРѕ Р»РёС‡РЅС‹Рј РїРѕСЂРѕРіР°Рј) ----
function onDetEvent(type,data){
  const info=EV[type]; if(!info) return;
  const msg = (type==='JUMP') ? `JUMP air=${Math.round(data.air||0)}ms h=${Math.round(data.h||0)}cm`
            : `${type} a=${(data.a||0).toFixed(1)}g g=${Math.round(data.g||0)}`;
  hero(info,msg);
  if(dCounts[type]!==undefined){ dCounts[type]++; if(rec)recCount(type); }
  refreshCounts(); addLive(info,msg);
  if(rec && rec.events) rec.events.push({t:Date.now()-rec.startMs,type,a:data.a,g:data.g,air:data.air,h:data.h});
  // РїРѕСЃР»Рµ СЂР°Р·РѕРІРѕРіРѕ СЃРѕР±С‹С‚РёСЏ (СѓРґР°СЂ/РїСЂС‹Р¶РѕРє) РІРµСЂРЅСѓС‚СЊ РїР»Р°С€РєСѓ Рє С‚РµРєСѓС‰РµРјСѓ СЃРѕСЃС‚РѕСЏРЅРёСЋ,
  // РёРЅР°С‡Рµ "KICK" РІРёСЃРёС‚, РїРѕРєР° РЅРµ СЃРјРµРЅРёС‚СЃСЏ Р·РѕРЅР° (РїСЂРё Р±РµРіРµ СЃРѕСЃС‚РѕСЏРЅРёРµ РЅРµ РјРµРЅСЏРµС‚СЃСЏ в†’ onDetState РјРѕР»С‡РёС‚)
  clearTimeout(heroRevertTimer);
  heroRevertTimer=setTimeout(revertHeroToState, 800);
}
let heroRevertTimer=null;
function revertHeroToState(){
  const info=EV[prevState]; if(info) hero(info, prevState);
}
function onDetState(state,act){
  const info=EV[state]; if(!info) return;
  clearTimeout(heroRevertTimer);   // Р¶РёРІРѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ РІР°Р¶РЅРµРµ В«РІРёСЃСЏС‰РµРіРѕВ» СЃРѕР±С‹С‚РёСЏ
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
function refreshCounts(){ $('dKick').textContent=dCounts.KICK; $('dJump').textContent=dCounts.JUMP; }
function recCount(type){
  if(type==='KICK')$('sKick').textContent=+($('sKick').textContent)+1;
  if(type==='JUMP')$('sJump').textContent=+($('sJump').textContent)+1;
}

// ---- СЃС‹СЂС‹Рµ РґР°РЅРЅС‹Рµ (Р±РёРЅР°СЂСЊ) ----
function onData(dv){
  if(dv.getUint8(0)!==0x52){ onSyncPacket(dv); return; }   // 'R' = live-СЃС‹СЂСЊС‘; РёРЅР°С‡Рµ РїР°РєРµС‚ С„Р°Р№Р»-СЃРёРЅРєР°
  const n=Math.floor((dv.byteLength-3)/12);
  for(let i=0;i<n;i++){
    const o=3+i*12;
    const ax=dv.getInt16(o,true)/1000, ay=dv.getInt16(o+2,true)/1000, az=dv.getInt16(o+4,true)/1000;
    const gx=dv.getInt16(o+6,true)/10,  gy=dv.getInt16(o+8,true)/10,  gz=dv.getInt16(o+10,true)/10;
    if(detector) detector.push(ax,ay,az,gx,gy,gz);     // СЂР°СЃРїРѕР·РЅР°РІР°РЅРёРµ РїРѕ Р»РёС‡РЅС‹Рј РїРѕСЂРѕРіР°Рј
    if(rec && rec.raw){ rec.raw.ax.push(ax);rec.raw.ay.push(ay);rec.raw.az.push(az);rec.raw.gx.push(gx);rec.raw.gy.push(gy);rec.raw.gz.push(gz); }
    if(calib.recording){ calibSample(ax,ay,az,gx,gy,gz); }
    // РѕС‚Р»Р°РґРєР°
    const aM=Math.hypot(ax,ay,az), gM=Math.hypot(gx,gy,gz);
    dbg.n++; dbg.lastA=aM; if(aM>dbg.peakA)dbg.peakA=aM; if(gM>dbg.peakG)dbg.peakG=gM;
    dbg.sumDyn+=Math.abs(aM-1); dbg.cntDyn++;
  }
  if(rec && rec.raw) rec.samples+=n;
}
let dbg={n:0,peakA:0,peakG:0,lastA:1,sumDyn:0,cntDyn:0};
setInterval(()=>{
  const el=$('dbg'); if(!el)return;
  if(!connected){ el.textContent='no data вЂ” connect sensor'; return; }
  let t={}; try{ t=JSON.parse(localStorage.getItem('fbl_calib')||'{}'); }catch(e){}
  // РїРѕРєР°Р·С‹РІР°РµРј Р Р•РђР›Р¬РќР«Р™ РґРµР№СЃС‚РІСѓСЋС‰РёР№ РїРѕСЂРѕРі (РєР°Рє РµРіРѕ РІРёРґРёС‚ РґРµС‚РµРєС‚РѕСЂ): manual в†’ СЃРѕС…СЂР°РЅС‘РЅРЅС‹Р№ в†’ РґРµС„РѕР»С‚ 8
  const hasManual = t.kickManual!=null;
  const kickThr = hasManual ? t.kickManual : (t.kickAcc!=null ? t.kickAcc : 8);
  const kickTag = hasManual ? ' (manual)' : (t.kickAcc!=null ? '' : ' (default)');
  const act=dbg.cntDyn?dbg.sumDyn/dbg.cntDyn:0;
  el.innerHTML=`stream ${dbg.n*2} Hz В· a=${dbg.lastA.toFixed(1)}g<br>`+
    `<b style="color:#ff7a3c">PEAK acc=${dbg.peakA.toFixed(1)}g</b> В· peak gyro=${Math.round(dbg.peakG)}<br>`+
    `act=${act.toFixed(2)} В· state ${prevState||'вЂ”'}<br>`+
    `kick thr &gt;${kickThr}g${kickTag} В· run thr &gt;${t.zones?t.zones.walk.toFixed(2):'вЂ”'}`;
  dbg.n=0;dbg.peakA=0;dbg.peakG=0;dbg.sumDyn=0;dbg.cntDyn=0;
},500);

// ================= Р—РђРџРРЎР¬ =================
$('recBtn').onclick=()=>{ rec?stopRec(false):startRec(); };
// ---- СЂРµР¶РёРјС‹ Р·Р°РїРёСЃРё: 'auto' (СѓСЃС‚СЂРѕР№СЃС‚РІРѕ РїРёС€РµС‚ РЅР° РєР°СЂС‚Сѓ) / 'live' (С‚РµР»РµС„РѕРЅ РєРѕРїРёС‚ РїРѕС‚РѕРє) ----
let recMode = localStorage.getItem('fbl_recmode') || 'auto';
function setMode(m){
  if(rec) return;                                  // РЅРµ РјРµРЅСЏС‚СЊ РІРѕ РІСЂРµРјСЏ Р·Р°РїРёСЃРё
  recMode=m; localStorage.setItem('fbl_recmode',m);
  document.querySelectorAll('.modeBtn').forEach(b=>{ const on=b.dataset.mode===m;
    b.style.borderColor=on?'var(--accent)':'var(--line)'; b.style.background=on?'#12233d':'var(--card2)'; });
  const h=$('modeHint'); if(h) h.textContent = m==='live'
    ? 'Live: С‚РµР»РµС„РѕРЅ РєРѕРїРёС‚ РїРѕС‚РѕРє, СЃРµСЃСЃРёСЏ СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ СЃСЂР°Р·Сѓ РїРѕ Stop. Р”РµСЂР¶Рё РїСЂРёР»РѕР¶РµРЅРёРµ РѕС‚РєСЂС‹С‚С‹Рј.'
    : 'Autonomous: СѓСЃС‚СЂРѕР№СЃС‚РІРѕ РїРёС€РµС‚ РЅР° СЃРІРѕСЋ РєР°СЂС‚Сѓ, С‚РµР»РµС„РѕРЅ РјРѕР¶РЅРѕ СѓР±СЂР°С‚СЊ. РџРѕРґС‚СЏРЅРµС‚СЃСЏ РїРѕ Stop.';
}

async function startRec(){
  if(!connected || !ctrlCh) return;
  if(recMode==='live'){
    rec={mode:'live', startMs:Date.now(), raw:{ax:[],ay:[],az:[],gx:[],gy:[],gz:[]}, events:[], samples:0};
    try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 1')); streaming=true; }catch(e){}
  } else {
    try{ await ctrlCh.writeValue(new TextEncoder().encode('SES 1')); }catch(e){ return; }
    rec={mode:'auto', startMs:Date.now()};
  }
  recUI(true);
}
async function stopRec(silent){
  const r=rec; rec=null; recUI(false);
  if(!r) return;
  if(r.mode==='live'){                             // СЃРѕС…СЂР°РЅСЏРµРј СЃРµСЃСЃРёСЋ РёР· С‚РµР»РµС„РѕРЅР° СЃСЂР°Р·Сѓ
    if(r.samples>0 || r.events.length>0){
      const sess={ id:Date.now(), date:new Date().toISOString(), type:$('sType').value, note:$('sNote').value,
        durationMs:Date.now()-r.startMs, events:r.events, raw:r.raw, samples:r.samples };
      await dbAdd(sess); if(!silent){ renderHistory(); openAnalytics(sess.id); }
    }
  } else {                                          // Р°РІС‚РѕРЅРѕРјРєР°: СЃС‚РѕРї РЅР° СѓСЃС‚СЂРѕР№СЃС‚РІРµ + СЃРёРЅРє
    if(ctrlCh){ try{ await ctrlCh.writeValue(new TextEncoder().encode('SES 0')); }catch(e){} }
    if(!silent && connected){ setTimeout(()=>startSync(), 900); }
  }
}
function recUI(on){
  if(on){
    dCounts={KICK:0,JUMP:0}; $('sKick').textContent='0'; $('sJump').textContent='0';
    requestWake();
    $('recBtn').textContent='в–  Stop training'; $('recState').textContent='в—Џ recording'; $('recState').style.color='#ff4d6d';
    $('recHealth').innerHTML = (rec&&rec.mode==='live') ? 'live-Р·Р°РїРёСЃСЊ РІ С‚РµР»РµС„РѕРЅ вЂ” РґРµСЂР¶Рё РїСЂРёР»РѕР¶РµРЅРёРµ РѕС‚РєСЂС‹С‚С‹Рј' : 'РјРѕР¶РЅРѕ Р·Р°Р±Р»РѕРєРёСЂРѕРІР°С‚СЊ С‚РµР»РµС„РѕРЅ вЂ” Р·Р°РїРёСЃСЊ РёРґС‘С‚ РЅР° СѓСЃС‚СЂРѕР№СЃС‚РІРµ';
    clearInterval(recTimer);
    recTimer=setInterval(()=>{ if(rec){ const s=Math.floor((Date.now()-rec.startMs)/1000); $('recTime').textContent=mmss(s); } },500);
  } else {
    clearInterval(recTimer);
    $('recBtn').textContent='в—Џ Start training'; $('recState').textContent='not recording'; $('recState').style.color='';
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

// ================= OFFLINE-РЎРРќРҐР РћРќРР—РђР¦РРЇ (SES*.BIN СЃС‹СЂСЊС‘ СЃ РєР°СЂС‚С‹) =================
let sync=null, syncMsgTimer=null;
function syncedSet(){ try{ return new Set(JSON.parse(localStorage.getItem('fbl_synced_ses')||'[]')); }catch(e){ return new Set(); } }
function markSynced(name){ const s=syncedSet(); s.add(name); localStorage.setItem('fbl_synced_ses', JSON.stringify([...s])); }
function setSync(msg, hideAfter){ const el=$('syncStatus'); if(!el)return; el.textContent='рџ”„ '+msg; el.style.display='block';
  clearTimeout(syncMsgTimer); if(hideAfter) syncMsgTimer=setTimeout(()=>{ el.style.display='none'; }, hideAfter); }

async function startSync(){
  if(!ctrlCh || sync){ enableLive(); return; }
  sync={ files:[], queue:[], cur:null, done:0 };
  setSync('checking deviceвЂ¦');
  try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 0')); streaming=false; }catch(e){}  // РіР»СѓС€РёРј live-СЃС‚СЂРёРј
  try{ await ctrlCh.writeValue(new TextEncoder().encode('LIST')); }catch(e){ finishSync(); }
}
function onSyncPacket(dv){
  if(!sync) return;
  const type=String.fromCharCode(dv.getUint8(0));
  if(type==='D'){                                   // Р±РёРЅР°СЂРЅС‹Р№ РєСѓСЃРѕРє С„Р°Р№Р»Р°
    if(sync.cur){ const b=new Uint8Array(dv.buffer.slice(dv.byteOffset+1, dv.byteOffset+dv.byteLength));
      sync.cur.parts.push(b); sync.cur.recv+=b.length;
      if(sync.cur.size) setSync(`downloading ${sync.cur.name}: ${Math.round(100*sync.cur.recv/sync.cur.size)}%`); }
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
  sync.queue = sync.files.filter(f=>/^SES\d+\.BIN$/i.test(f.name) && f.size>=120 && !done.has(f.name));
  if(!sync.queue.length){ setSync('no new sessions', 2500); finishSync(); return; }
  setSync(`${sync.queue.length} new session(s) to download`);
  nextInQueue();
}
async function nextInQueue(){
  const f=sync.queue.shift();
  if(!f){ setSync(`вњ“ synced ${sync.done} session(s)`, 4000); finishSync(); return; }
  setSync(`downloading ${f.name}вЂ¦`);
  try{ await ctrlCh.writeValue(new TextEncoder().encode('GET '+f.name)); }catch(e){ finishSync(); }
}
async function onFileDone(){
  const c=sync.cur; sync.cur=null;
  if(c){
    try{
      const buf=new Uint8Array(await new Blob(c.parts).arrayBuffer());
      const sess=sessionFromRaw(c.name, buf);
      if(sess){ await dbAdd(sess); markSynced(c.name); sync.done++; renderHistory(); }
      else markSynced(c.name);   // РјСѓСЃРѕСЂРЅС‹Р№/РїСѓСЃС‚РѕР№ С„Р°Р№Р» вЂ” РЅРµ С‚СЏРЅРµРј РїРѕРІС‚РѕСЂРЅРѕ
    }catch(e){ console.error('parse fail',e); }
  }
  nextInQueue();
}
// РЎРѕР±РёСЂР°РµРј РѕР±СЉРµРєС‚ СЃРµСЃСЃРёРё РёР· СЃС‹СЂСЊСЏ + РїСЂРѕРіРѕРЅ РґРµС‚РµРєС‚РѕСЂР° РїРѕ Р»РёС‡РЅС‹Рј РїРѕСЂРѕРіР°Рј
function sessionFromRaw(name, buf){
  const rec=Math.floor(buf.length/12); if(rec<50) return null;
  const dv=new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const raw={ax:[],ay:[],az:[],gx:[],gy:[],gz:[]};
  for(let i=0;i<rec;i++){ const o=i*12;
    raw.ax.push(dv.getInt16(o,true)/1000); raw.ay.push(dv.getInt16(o+2,true)/1000); raw.az.push(dv.getInt16(o+4,true)/1000);
    raw.gx.push(dv.getInt16(o+6,true)/10);  raw.gy.push(dv.getInt16(o+8,true)/10);  raw.gz.push(dv.getInt16(o+10,true)/10);
  }
  let det; const events=[];
  det=new Detector({ onEvent:(t,d)=>events.push({t:det.t, type:t, a:d.a, g:d.g, air:d.air, h:d.h}),
                     onState:(st,act)=>events.push({t:det.t, type:st, a:act}) });
  for(let i=0;i<rec;i++) det.push(raw.ax[i],raw.ay[i],raw.az[i],raw.gx[i],raw.gy[i],raw.gz[i]);
  return { id:Date.now()+Math.floor(Math.random()*1000), date:new Date().toISOString(),
           type:'Offline', note:name, durationMs:rec*10, events, raw, samples:rec, offline:true };
}
function finishSync(){ sync=null; enableLive(); }
// РІРєР»СЋС‡Р°РµРј live-СЃС‚СЂРёРј (РїРѕСЃР»Рµ Р·Р°РІРµСЂС€РµРЅРёСЏ СЃРёРЅРєР°)
async function enableLive(){ if(connected && ctrlCh){ try{ await ctrlCh.writeValue(new TextEncoder().encode('REC 1')); streaming=true; }catch(e){} } }

// ================= РРЎРўРћР РРЇ =================
async function renderHistory(){
  const list=await dbAll(); list.sort((a,b)=>b.id-a.id);
  if(!list.length){ $('histList').innerHTML='<div class="muted">no recorded sessions yet</div>'; return; }
  $('histList').innerHTML=list.map(s=>{
    const d=new Date(s.id); const dur=mmss(Math.floor(s.durationMs/1000));
    const k=s.events.filter(e=>e.type==='KICK').length, j=s.events.filter(e=>e.type==='JUMP').length;
    return `<div class="row" onclick="openAnalytics(${s.id})" style="cursor:pointer">
      <span class="ico">рџ“Љ</span>
      <span style="flex:1"><b>${s.type}</b> В· ${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}
        <div class="muted">${dur} В· ${svgIco('i-ball','var(--kick)',12)}${k} ${svgIco('i-jump','var(--jump)',12)}${j} В· ${s.samples} samples</div></span>
      <span class="muted">вЂє</span></div>`;
  }).join('');
}

// ================= РђРќРђР›РРўРРљРђ =================
async function openAnalytics(id){
  const s=await dbGet(id); if(!s) return;
  const prof=loadProfile();
  const m=analyze(s,prof);
  const d=new Date(s.id);
  $('analytics').innerHTML=`
    <div class="card">
      <h2>${s.type} В· ${d.toLocaleDateString('en-GB')}</h2>
      <div class="muted">${d.toLocaleTimeString('en-GB')} В· duration ${mmss(Math.floor(m.durS))}${s.note?' В· '+s.note:''}</div>
    </div>
    <div class="grid2">
      <div class="tile"><div class="n" style="color:var(--kick)">${m.kicks}</div><div class="l"><svg class="ic" style="stroke:var(--kick)"><use href="#i-ball"/></svg>kicks</div></div>
      <div class="tile"><div class="n" style="color:var(--jump)">${m.jumps}</div><div class="l"><svg class="ic" style="stroke:var(--jump)"><use href="#i-jump"/></svg>jumps</div></div>
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
        <div class="tile"><div class="n" style="color:var(--kick)">${m.maxKickKmh?m.maxKickKmh.toFixed(0):'вЂ”'}</div><div class="l">max ball speed, km/h*</div></div>
        <div class="tile"><div class="n">${m.kicks}</div><div class="l">total kicks</div></div>
      </div>
      ${svgBars(m.kicksAn.map(k=>k.ball), 'var(--kick)', ' km/h')}
      <div class="muted" style="margin-top:6px">* estimated from foot rotation (П‰В·r), В±10-15%</div>
    </div>
    <div class="card"><h3>Jumps and running</h3>
      <div class="grid2" style="margin-top:10px">
        <div class="tile"><div class="n" style="color:var(--jump)">${m.maxJumpCm?m.maxJumpCm.toFixed(0):'вЂ”'}</div><div class="l">max height, cm</div></div>
        <div class="tile"><div class="n">${(m.distM/1000).toFixed(2)}</div><div class="l">distance, km*</div></div>
        <div class="tile"><div class="n">${m.avgKmh.toFixed(1)}</div><div class="l">avg speed, km/h*</div></div>
        <div class="tile"><div class="n">${m.gctMs||'вЂ”'}</div><div class="l">foot contact, ms</div></div>
      </div>
      <div class="muted" style="margin-top:6px">* approximate (from cadence and stride)</div>
    </div>
    <div class="card">
      <button class="big ghost" onclick="exportCSV(${s.id})">в¬‡ Export CSV (for ML)</button>
      <button class="big ghost" style="margin-top:10px" onclick="delSession(${s.id})">рџ—‘ Delete session</button>
    </div>`;
  showTab('analytics');
}
async function delSession(id){ if(confirm('Delete session?')){ await dbDel(id); renderHistory(); showTab('history'); } }

// СЌРєСЃРїРѕСЂС‚: СЃС‹СЂСЊС‘ + СЃРѕР±С‹С‚РёСЏ РІ CSV
async function exportCSV(id){
  const s=await dbGet(id); if(!s) return;
  let csv='# events\nt_ms,type,a_g,gyro_dps,air_ms,h_cm\n';
  s.events.forEach(e=>csv+=`${e.t},${e.type},${e.a??''},${e.g??''},${e.air??''},${e.h??''}\n`);
  csv+='\n# raw @100Hz\ni,ax,ay,az,gx,gy,gz\n';
  const R=s.raw; for(let i=0;i<R.ax.length;i++) csv+=`${i},${R.ax[i]},${R.ay[i]},${R.az[i]},${R.gx[i]},${R.gy[i]},${R.gz[i]}\n`;
  const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='session_'+id+'.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// ================= РљРђР›РР‘Р РћР’РљРђ =================
const CALIB_LABELS=[['IDLE','рџ§Ќ Idle'],['WALK','рџљ¶ Walk'],['RUN','рџЏѓ Run'],['KICK','вљЅ Kick'],['JUMP','рџ¦ Jump']];
let calib={recording:null, startMs:0, timer:null, data:{}};

function buildCalib(){
  loadCalibData();
  $('calibList').innerHTML=CALIB_LABELS.map(([k,n])=>{
    const has=calib.data[k]&&calib.data[k].act&&calib.data[k].act.length;
    return `
    <div class="tile" style="text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px">
      <div style="flex:1"><b>${n}</b><div class="muted" id="cr_${k}" style="font-size:12px;margin-top:2px">not recorded</div></div>
      <button class="ghost" id="cb_${k}" onclick="calibToggle('${k}')" style="padding:9px 14px">${has?'в†» Re-record':'в—Џ Record'}</button>
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
  const b=$('cb_'+label); b.textContent='в–  Stop'; b.style.background='var(--impact)'; b.style.color='#fff';
  calib.timer=setInterval(()=>updateCalibRow(label,false),300);
  updateCalibRow(label,false);
}
function calibStop(){
  const label=calib.recording; if(!label)return;
  clearInterval(calib.timer); calib.timer=null; calib.recording=null;
  const b=$('cb_'+label); if(b){ b.textContent='в†» Re-record'; b.style.background=''; b.style.color=''; }
  updateCalibRow(label,true);
  saveCalibData();   // СЃСЂР°Р·Сѓ СЃРѕС…СЂР°РЅСЏРµРј вЂ” РґР°РЅРЅС‹Рµ РЅРµ РїРѕС‚РµСЂСЏСЋС‚СЃСЏ
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
    el.innerHTML=`<span style="color:#ff4d6d">в—Џ recording ${dur}s В· ${d.act.length} samples</span>`;
  } else {
    el.innerHTML=`вњ“ ${d.act.length} samples В· activity ${mean(d.act).toFixed(2)} В· peak ${max(d.acc).toFixed(1)}g В· gyro ${Math.round(max(d.gyro))}В°/s`;
  }
}
function showSavedCalib(){
  let s=null; try{ s=JSON.parse(localStorage.getItem('fbl_calib')||'null'); }catch(e){}
  if(s&&s.zones){ const d=new Date(s.ts);
    $('calibResult').innerHTML=`вњ… <b>Saved</b> ${d.toLocaleString('en-GB')} В· kick&gt;${s.kickAcc||'вЂ”'}g`;
    renderCalibSummary(calib.data, s);
  } else { $('calibResult').innerHTML='<span class="muted">do the movements and tap "Calculate"</span>'; }
}
// РІС‹С‡РёСЃР»РµРЅРёРµ РїРѕСЂРѕРіРѕРІ РёР· Р·Р°РїРёСЃР°РЅРЅС‹С… РґРІРёР¶РµРЅРёР№ (Р±РµР· СЃРїСЂРёРЅС‚Р°)
function computeThresholds(D){
  const mean=a=>a&&a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const maxA=a=>a&&a.length?Math.max(...a):null;
  const mid=(a,b)=>(a!=null&&b!=null)?(a+b)/2:null;
  const idle=mean(D.IDLE&&D.IDLE.act), walk=mean(D.WALK&&D.WALK.act), run=mean(D.RUN&&D.RUN.act);
  if(run==null&&walk==null) return null;
  const zones={ idle: mid(idle,walk)??0.086, walk: mid(walk,run)??0.379, run: (run!=null? run*1.5 : 0.9) };
  // РїРѕСЂРѕРі СѓРґР°СЂР° вЂ” Сѓ СЃР°РјРѕРіРѕ РїРёРєР° СѓРґР°СЂР° (РєР°СЃР°РЅРёРµ РјСЏС‡Р°), РЅРѕ РіР°СЂР°РЅС‚РёСЂРѕРІР°РЅРЅРѕ РІС‹С€Рµ Р±РµРіРѕРІРѕРіРѕ РїРёРєР°.
  // СЂР°РЅСЊС€Рµ Р±СЂР°Р»Рё СЃРµСЂРµРґРёРЅСѓ (run+kick)/2 в†’ РїРѕСЂРѕРі РїР°РґР°Р» РІРґРІРѕРµ РЅРёР¶Рµ СЂРµР°Р»СЊРЅРѕРіРѕ СѓРґР°СЂР°. РЎРїСЂРёРЅС‚ РќР• СѓС‡РёС‚С‹РІР°РµРј (РѕРЅ СѓР±СЂР°РЅ).
  const runAccMax  = maxA(D.RUN&&D.RUN.acc)||0;
  const kickAccMax = maxA(D.KICK&&D.KICK.acc)||0;
  let kickAcc;
  if(kickAccMax>runAccMax && runAccMax>0){ kickAcc = +(Math.max(runAccMax*1.15, kickAccMax*0.85)).toFixed(1); } // Сѓ СѓРґР°СЂР°, РЅРѕ РІС‹С€Рµ Р±РµРіР°
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
  if(prev.kickManual!=null) saved.kickManual=prev.kickManual;   // СЂСѓС‡РЅРѕР№ override РЅРµ Р·Р°С‚РёСЂР°РµРј
  localStorage.setItem('fbl_zones',JSON.stringify(t.zones));
  localStorage.setItem('fbl_calib',JSON.stringify(saved));
  saveCalibData();
  if(detector) detector.reloadThresholds();
  $('calibResult').innerHTML='<span style="color:var(--run)">вњ“ Saved permanently and applied вЂ” to the home screen and analytics.</span>';
  renderCalibSummary(calib.data, saved);
  loadKickManual();
}
function saveCalibData(){ try{ localStorage.setItem('fbl_calibdata', JSON.stringify(calib.data)); }catch(e){} }
function loadCalibData(){ try{ const d=JSON.parse(localStorage.getItem('fbl_calibdata')||'null'); if(d)calib.data=d; }catch(e){} }
// РїРµСЂРµСЃС‡РёС‚Р°С‚СЊ РїРѕСЂРѕРіРё РёР· СѓР¶Рµ Р·Р°РїРёСЃР°РЅРЅС‹С… РґР°РЅРЅС‹С… РїРѕ РќРћР’РћР™ С„РѕСЂРјСѓР»Рµ (Р±РµР· РїРµСЂРµР·Р°РїРёСЃРё РґРІРёР¶РµРЅРёР№)
function applyCalibFromData(){
  loadCalibData();
  const t=computeThresholds(calib.data);
  if(t){ let prev={}; try{prev=JSON.parse(localStorage.getItem('fbl_calib')||'{}');}catch(e){}
    localStorage.setItem('fbl_zones',JSON.stringify(t.zones));
    const saved={zones:t.zones,kickAcc:t.kickAcc,ts:prev.ts||Date.now()};
    if(prev.kickManual!=null) saved.kickManual=prev.kickManual;   // СЂСѓС‡РЅРѕР№ override РЅРµ Р·Р°С‚РёСЂР°РµРј
    localStorage.setItem('fbl_calib',JSON.stringify(saved)); }
}
// ---- СЂСѓС‡РЅРѕР№ РїРѕСЂРѕРі СѓРґР°СЂР° (override): РїРµСЂРµР±РёРІР°РµС‚ Р°РІС‚РѕС„РѕСЂРјСѓР»Сѓ, РЅРµ Р·Р°С‚РёСЂР°РµС‚СЃСЏ РїРµСЂРµСЃС‡С‘С‚РѕРј ----
function loadKickManual(){
  let c={}; try{ c=JSON.parse(localStorage.getItem('fbl_calib')||'{}'); }catch(e){}
  if($('kickManual')) $('kickManual').value = (c.kickManual!=null ? c.kickManual : '');
  updateKickManualMsg(c);
}
function updateKickManualMsg(c){
  const el=$('kickManualMsg'); if(!el)return;
  if(c.kickManual!=null) el.innerHTML=`<span style="color:var(--run)">Manual: kicks counted from <b>${c.kickManual}g</b> (overrides auto ${c.kickAcc!=null?c.kickAcc+'g':'вЂ”'})</span>`;
  else el.innerHTML=`Auto: kicks counted from <b>${c.kickAcc!=null?c.kickAcc+'g':'вЂ”'}</b>`;
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
      zones: idle&lt;${saved.zones.idle.toFixed(3)} В· walk&lt;${saved.zones.walk.toFixed(3)} В· run&lt;${saved.zones.run.toFixed(3)}<br>
      kick: acceleration&gt;${saved.kickManual!=null?saved.kickManual+'g (manual)':saved.kickAcc+'g'}</div>
    <button class="big ghost" style="margin-top:14px" onclick="calibReset()">в†» Restart calibration</button>`;
  $('calibSummaryCard').style.display='block';
}
function calibReset(){ if(calib.recording)calibStop(); calib.data={}; $('calibSummaryCard').style.display='none'; buildCalib(); $('calibResult').innerHTML='<span class="muted">do the movements and tap "Calculate"</span>'; }
$('calibCalc').onclick=calibCalc;
$('kickManualApply').onclick=applyKickManual;

// ================= РџР РћР¤РР›Р¬ =================
function loadProfile(){ try{return JSON.parse(localStorage.getItem('fbl_profile')||'{}');}catch(e){return {};} }
function fillProfile(){ const p=loadProfile(); $('pName').value=p.name||''; $('pFoot').value=p.foot||'Right'; $('pHeight').value=p.height||''; $('pFootLen').value=p.footLen||''; }
$('saveProfile').onclick=()=>{
  const p={name:$('pName').value,foot:$('pFoot').value,height:$('pHeight').value,footLen:$('pFootLen').value};
  localStorage.setItem('fbl_profile',JSON.stringify(p)); $('profSaved').textContent='вњ“ saved';
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
  if(name!=='calib' && calib.recording) calibStop();   // СѓС…РѕРґСЏ СЃ РєР°Р»РёР±СЂРѕРІРєРё вЂ” РѕСЃС‚Р°РЅРѕРІРёС‚СЊ Р·Р°РїРёСЃСЊ
  document.querySelectorAll('section').forEach(s=>s.classList.toggle('act',s.id==='tab-'+name));
  document.querySelectorAll('.nav a').forEach(a=>a.classList.toggle('act',a.dataset.tab===name));
  if(name==='history')renderHistory();
  if(name==='calib')buildCalib();
}

const APP_VERSION='v2.3';
if($('ver')) $('ver').textContent=APP_VERSION;
applyCalibFromData();   // РїРѕРґС…РІР°С‚РёС‚СЊ Рё РїРµСЂРµСЃС‡РёС‚Р°С‚СЊ СЃРѕС…СЂР°РЅС‘РЅРЅСѓСЋ РєР°Р»РёР±СЂРѕРІРєСѓ
fillProfile(); renderHistory();
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
