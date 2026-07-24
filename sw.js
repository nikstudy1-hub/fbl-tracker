const CACHE='fbl-v3';
const ASSETS=['./','index.html','app.js','analytics.js','manifest.webmanifest','icon.svg'];
self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
// network-first + обход HTTP-кэша: cache:'reload' заставляет браузер тянуть свежак
// с сервера, игнорируя max-age от GitHub Pages. Кэш SW — только для оффлайна.
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  e.respondWith(
    fetch(e.request,{cache:'reload'}).then(resp=>{ const cp=resp.clone(); caches.open(CACHE).then(c=>c.put(e.request,cp)); return resp; })
    .catch(()=>caches.match(e.request))
  );
});
