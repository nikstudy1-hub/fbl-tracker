/* Детектор движений на телефоне — работает из сырого потока по ЛИЧНЫМ порогам.
   push(ax,ay,az,gx,gy,gz) вызывается на каждый сэмпл (~100 Гц).
   Колбэки: onEvent(type,{a,g,air,h}), onState(state,activity). */

function loadThresholds(){
  let c={}; try{ c=JSON.parse(localStorage.getItem('fbl_calib')||'{}'); }catch(e){}
  const z=(c.zones)||{idle:0.086,walk:0.379,run:0.699};
  return {
    idle:z.idle, walk:z.walk, run:z.run,
    // порог удара не может быть ниже беговых пиков (~1300°/с на лодыжке) — страховка от заниженной калибровки
    kickGyro: Math.max(c.kickGyro || 1400, 1300),
    freefall:0.35, freefallMin:60, landing:2.5,
    capMs:80, coolMs:350, winMs:700, idleGyro:30, dt:10
  };
}

class Detector {
  constructor(cb){ this.cb=cb||{}; this.T=loadThresholds(); this.reset(); }
  reloadThresholds(){ this.T=loadThresholds(); }
  reset(){
    this.t=0; this.cap=false; this.capStart=0; this.pa=0; this.pg=0; this.cool=0;
    this.air=false; this.ffStart=0;
    this.actSum=0; this.gSum=0; this.actN=0; this.winStart=0; this.state='IDLE';
  }
  push(ax,ay,az,gx,gy,gz){
    const T=this.T, now=this.t; this.t+=T.dt;
    const aMag=Math.hypot(ax,ay,az), gMag=Math.hypot(gx,gy,gz), aDyn=Math.abs(aMag-1);
    const inCool = now < this.cool;

    // --- прыжок (свободное падение + приземление) ---
    if(!this.air && aMag<T.freefall){ if(this.ffStart===0)this.ffStart=now; if(now-this.ffStart>=T.freefallMin)this.air=true; }
    else if(!this.air && aMag>=T.freefall){ this.ffStart=0; }
    if(this.air){
      if(aMag>T.landing){
        const air=now-this.ffStart; const t=air/1000; const h=(9.81*t*t/8)*100;
        this.emit('JUMP',{air,h}); this.air=false; this.ffStart=0; this.cool=now+T.coolMs;
      } else if(now-this.ffStart>1200){ this.air=false; this.ffStart=0; }
    } else {
      // --- удар (по вращению стопы; порог выше бегового) ---
      if(!this.cap && !inCool && gMag>T.kickGyro){ this.cap=true; this.capStart=now; this.pa=aMag; this.pg=gMag; }
      if(this.cap){
        if(aMag>this.pa)this.pa=aMag; if(gMag>this.pg)this.pg=gMag;
        if(now-this.capStart>=T.capMs){
          this.emit('KICK',{a:this.pa,g:this.pg}); this.cap=false; this.cool=now+T.coolMs;
        }
      }
    }

    // --- состояние (зоны) ---
    this.actSum+=aDyn; this.gSum+=gMag; this.actN++;
    if(now-this.winStart>=T.winMs && this.actN>0){
      const act=this.actSum/this.actN, gAvg=this.gSum/this.actN;
      let st = (act<T.idle && gAvg<T.idleGyro)?'IDLE': act<T.walk?'WALK': act<T.run?'RUN':'SPRINT';
      if(st!==this.state){ this.state=st; if(this.cb.onState)this.cb.onState(st,act); }
      this.actSum=0; this.gSum=0; this.actN=0; this.winStart=now;
    }
  }
  emit(type,data){ if(this.cb.onEvent)this.cb.onEvent(type,data); }
}
