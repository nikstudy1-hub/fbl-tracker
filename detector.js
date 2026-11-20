/* Детектор движений на телефоне — работает из сырого потока по ЛИЧНЫМ порогам.
   push(ax,ay,az,gx,gy,gz) вызывается на каждый сэмпл (~100 Гц).
   Колбэки: onEvent(type,{a,g}), onState(state,activity). */

// Базовая (предустановленная) калибровка — эталонная запись (24.07.2026, датчик на лодыжке), без прыжков.
// stats — для таблицы на экране калибровки: сэмплы, активность, пик ускорения (g), пик гиро (dps).
const PRESET_CALIB={
  zones:{idle:0.144, walk:0.765, run:1.879}, kickAcc:18.5,
  stats:{ IDLE:{n:273,act:0.01,acc:1.0,gyro:29}, WALK:{n:786,act:0.28,acc:4.5,gyro:390},
          RUN:{n:621,act:1.25,acc:16.1,gyro:833}, KICK:{n:429,act:1.01,acc:19.9,gyro:1274} }
};
function readCalib(){ try{ return JSON.parse(localStorage.getItem('fbl_calib')||'{}')||{}; }catch(e){ return {}; } }
// режим: 'preset' | 'custom'. Если не выбран — своя, если она уже посчитана, иначе базовая.
function calibMode(){
  let m=null; try{ m=localStorage.getItem('fbl_calibmode'); }catch(e){}
  if(m==='preset'||m==='custom') return m;
  return readCalib().zones ? 'custom' : 'preset';
}
// действующие пороги. Своя калибровка без расчёта → базовые. Ручной порог удара перебивает оба режима.
function activeCalib(){
  const c=readCalib();
  const usePreset = calibMode()==='preset' || !c.zones;
  const zones = Object.assign({}, usePreset ? PRESET_CALIB.zones : c.zones);
  const autoKick = usePreset ? PRESET_CALIB.kickAcc : (c.kickAcc || PRESET_CALIB.kickAcc);
  const manual = c.kickManual!=null;
  return { mode:calibMode(), source:usePreset?'preset':'custom', zones, autoKick, manual,
           kickAcc: manual ? +c.kickManual : autoKick };
}

function loadThresholds(){
  const a=activeCalib(), z=a.zones;
  return {
    idle:z.idle, walk:z.walk, run:z.run,
    // g — пик касания мяча (выше бегового пика). Ручной override (kickManual) перебивает автоформулу.
    kickAcc: a.kickAcc,
    capMs:80, coolMs:350, winMs:700, idleGyro:30, dt:10
  };
}

class Detector {
  constructor(cb){ this.cb=cb||{}; this.T=loadThresholds(); this.reset(); }
  reloadThresholds(){ this.T=loadThresholds(); }
  reset(){
    this.t=0; this.cap=false; this.capStart=0; this.pa=0; this.pg=0; this.cool=0;
    this.actSum=0; this.gSum=0; this.actN=0; this.winStart=0; this.state='IDLE';
    this.cand=null; this.candN=0;
  }
  push(ax,ay,az,gx,gy,gz){
    const T=this.T, now=this.t; this.t+=T.dt;
    const aMag=Math.hypot(ax,ay,az), gMag=Math.hypot(gx,gy,gz), aDyn=Math.abs(aMag-1);
    const inCool = now < this.cool;

    // --- удар (по ПИКУ ускорения = касание мяча; выше бегового пика) ---
    if(!this.cap && !inCool && aMag>T.kickAcc){ this.cap=true; this.capStart=now; this.pa=aMag; this.pg=gMag; }
    if(this.cap){
      if(aMag>this.pa)this.pa=aMag; if(gMag>this.pg)this.pg=gMag;
      if(now-this.capStart>=T.capMs){
        this.emit('KICK',{a:this.pa,g:this.pg}); this.cap=false; this.cool=now+T.coolMs;
      }
    }

    // --- состояние (зоны) с гистерезисом: смена только после 2 окон подряд ---
    this.actSum+=aDyn; this.gSum+=gMag; this.actN++;
    if(now-this.winStart>=T.winMs && this.actN>0){
      const act=this.actSum/this.actN, gAvg=this.gSum/this.actN;
      let st = (act<T.idle && gAvg<T.idleGyro)?'IDLE': act<T.walk?'WALK':'RUN';
      if(st!==this.state){
        if(st===this.cand){ if(++this.candN>=2){ this.state=st; this.cand=null; if(this.cb.onState)this.cb.onState(st,act); } }
        else { this.cand=st; this.candN=1; }
      } else { this.cand=null; }
      this.actSum=0; this.gSum=0; this.actN=0; this.winStart=now;
    }
  }
  emit(type,data){ if(this.cb.onEvent)this.cb.onEvent(type,data); }
}
