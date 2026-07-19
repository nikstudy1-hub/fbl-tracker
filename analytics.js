/* Движок аналитики: из сырых сэмплов IMU + событий считает метрики.
   Сэмплы: массивы ax,ay,az (g), gx,gy,gz (dps), ~100 Гц.
   События: [{t, type, a, g, air, h}] (t — мс от старта сессии). */

// пороги зон — берём персональные (из калибровки) либо дефолт под лодыжку
function getZ(){ const d={idle:0.086,walk:0.379,run:0.699};
  try{ return Object.assign(d, JSON.parse(localStorage.getItem('fbl_zones')||'{}')); }catch(e){ return d; } }
const RAW_HZ = 100;

function analyze(session, profile){
  const s = session.raw || {ax:[],ay:[],az:[],gx:[],gy:[],gz:[]};
  const N = s.ax.length;
  const durS = session.durationMs/1000 || (N/RAW_HZ) || 1;
  const Z = getZ();

  // модули
  const aMag = new Float32Array(N), gMag = new Float32Array(N), aDyn = new Float32Array(N);
  for(let i=0;i<N;i++){
    const am = Math.hypot(s.ax[i],s.ay[i],s.az[i]);
    aMag[i]=am; aDyn[i]=Math.abs(am-1);
    gMag[i]=Math.hypot(s.gx[i],s.gy[i],s.gz[i]);
  }

  // ---- шаги (пик-детект по aDyn) ----
  let steps=0, lastPeak=-999; const stepTimes=[];
  const MINPK=0.35, REFRAC=Math.round(0.25*RAW_HZ); // мин высота, мин интервал
  for(let i=1;i<N-1;i++){
    if(aDyn[i]>MINPK && aDyn[i]>=aDyn[i-1] && aDyn[i]>aDyn[i+1] && (i-lastPeak)>REFRAC){
      steps++; lastPeak=i; stepTimes.push(i/RAW_HZ);
    }
  }
  const cadence = durS>0 ? Math.round(steps/durS*60) : 0;

  // ---- зоны по окнам 0.7с ----
  const W=Math.round(0.7*RAW_HZ); const zoneT={idle:0,walk:0,run:0}; const timeline=[];
  for(let i=0;i<N;i+=W){
    let sum=0,c=0; for(let j=i;j<Math.min(i+W,N);j++){sum+=aDyn[j];c++;}
    const act=c?sum/c:0;
    let z = act<Z.idle?'idle':act<Z.walk?'walk':'run';
    zoneT[z]+=c/RAW_HZ;
    timeline.push({t:i/RAW_HZ, act, z});
  }

  // ---- ускорения/торможения (всплески) ----
  let bursts=0, lastB=-999;
  for(let i=1;i<N-1;i++){
    if(aDyn[i]>1.2 && aDyn[i]>=aDyn[i-1] && aDyn[i]>aDyn[i+1] && (i-lastB)>Math.round(0.4*RAW_HZ)){ bursts++; lastB=i; }
  }

  // ---- смена направления (пики yaw-скорости gz) ----
  let turns=0, lastT=-999;
  for(let i=1;i<N-1;i++){
    const az2=Math.abs(s.gz[i]);
    if(az2>200 && az2>=Math.abs(s.gz[i-1]) && az2>Math.abs(s.gz[i+1]) && (i-lastT)>Math.round(0.4*RAW_HZ)){ turns++; lastT=i; }
  }

  // ---- усталость: падение каденса (первая треть vs последняя) ----
  let fatigue=0;
  if(stepTimes.length>=6){
    const third=durS/3;
    const c1=stepTimes.filter(t=>t<third).length/third*60;
    const c3=stepTimes.filter(t=>t>=2*third).length/third*60;
    if(c1>10) fatigue=Math.max(0,Math.round((1-c3/c1)*100));
  }

  // ---- события ----
  const ev = session.events||[];
  const kicks = ev.filter(e=>e.type==='KICK');
  const jumps = ev.filter(e=>e.type==='JUMP');
  const impacts = ev.filter(e=>e.type==='IMPACT');
  const sprints = countStateEntries(ev,'SPRINT');

  // скорость удара: v = ω·r, ω из пика гироскопа (dps), r = длина стопы
  const r = ((profile&&+profile.footLen)||25)/100; // м
  const kicksAn = kicks.map(k=>{
    const wdps = k.g||0; const wrad = wdps*Math.PI/180;
    const footMs = wrad*r; const ballKmh = footMs*1.2*3.6;
    return {t:k.t, g:wdps, a:k.a||0, ball:ballKmh};
  });
  const maxKick = kicksAn.reduce((m,k)=>k.ball>m?k.ball:m,0);
  const maxJump = jumps.reduce((m,j)=>(j.h||0)>m?(j.h||0):m,0);

  // дистанция/скорость (приблизительно): шаг ≈ рост*0.42
  const strideM = ((profile&&+profile.height)||175)/100*0.42;
  const distM = steps*strideM;
  const avgKmh = durS>0 ? distM/durS*3.6 : 0;

  // ground contact time (грубо): средняя ширина пика опоры
  const gct = estimateGCT(aDyn, stepTimes);

  return {
    durS, steps, cadence, bursts, turns, fatigue,
    zones:zoneT, timeline,
    kicks:kicksAn.length, jumps:jumps.length, impacts:impacts.length, sprints,
    maxKickKmh:maxKick, maxJumpCm:maxJump, kicksAn, jumpsAn:jumps,
    distM, avgKmh, gctMs:gct, strideM,
    hasRaw:N>0
  };
}

function countStateEntries(ev, name){
  let c=0, prev=null;
  for(const e of ev){ if(e.type&&['IDLE','WALK','RUN','SPRINT'].includes(e.type)){ if(e.type===name&&prev!==name)c++; prev=e.type; } }
  return c;
}
function estimateGCT(aDyn, stepTimes){
  if(stepTimes.length<3) return 0;
  // очень грубо: доля времени, когда стопа «нагружена» (aDyn>0.2), делённая на число шагов
  let loaded=0; for(let i=0;i<aDyn.length;i++) if(aDyn[i]>0.2) loaded++;
  const totalS=aDyn.length/RAW_HZ;
  return Math.round(loaded/RAW_HZ/stepTimes.length*1000);
}

// ================= SVG-графики =================
const ZC={idle:'#7a86a1',walk:'#2dd4bf',run:'#37d67a',sprint:'#ffd23f'};
const ZN={idle:'Покой',walk:'Ходьба',run:'Бег',sprint:'Спринт'};

function svgDonut(zones){
  const total=Object.values(zones).reduce((a,b)=>a+b,0)||1;
  let off=0; const R=52,C=2*Math.PI*R; const segs=[];
  for(const k of ['idle','walk','run']){
    const frac=zones[k]/total; const len=frac*C;
    segs.push(`<circle cx="70" cy="70" r="${R}" fill="none" stroke="${ZC[k]}" stroke-width="16"
      stroke-dasharray="${len} ${C-len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`);
    off+=len;
  }
  const legend=['idle','walk','run'].map(k=>
    `<div style="display:flex;align-items:center;gap:6px;font-size:13px">
       <span style="width:10px;height:10px;border-radius:2px;background:${ZC[k]}"></span>
       ${ZN[k]} · ${Math.round(zones[k])}с</div>`).join('');
  return `<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
    <svg width="140" height="140" viewBox="0 0 140 140">${segs.join('')}</svg>
    <div style="display:flex;flex-direction:column;gap:6px">${legend}</div></div>`;
}

function svgTimeline(timeline){
  if(!timeline.length) return '<div class="muted">нет данных</div>';
  const W=580,H=120,pad=6;
  const maxA=Math.max(0.8,...timeline.map(p=>p.act));
  const maxT=timeline[timeline.length-1].t||1;
  const pts=timeline.map(p=>`${pad+(p.t/maxT)*(W-2*pad)},${H-pad-(p.act/maxA)*(H-2*pad)}`).join(' ');
  // цветные подложки по зонам
  const bars=timeline.map((p,i)=>{
    const x=pad+(p.t/maxT)*(W-2*pad); const w=(W-2*pad)/timeline.length+1;
    return `<rect x="${x}" y="0" width="${w}" height="${H}" fill="${ZC[p.z]}" opacity="0.14"/>`;
  }).join('');
  return `<div style="overflow-x:auto"><svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="min-width:320px">
    ${bars}<polyline points="${pts}" fill="none" stroke="#3aa0ff" stroke-width="2"/></svg></div>
    <div class="muted" style="text-align:center">интенсивность по ходу сессии</div>`;
}

function svgBars(vals, color, unit){
  if(!vals.length) return '<div class="muted">нет данных</div>';
  const max=Math.max(...vals)||1;
  return `<div style="display:flex;align-items:flex-end;gap:4px;height:80px">`+
    vals.map(v=>`<div title="${v.toFixed(1)}${unit||''}" style="flex:1;background:${color};border-radius:3px 3px 0 0;height:${Math.max(4,v/max*100)}%"></div>`).join('')+
    `</div>`;
}
