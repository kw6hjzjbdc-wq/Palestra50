/* ============================================================================
   Service worker di Palestra 50
   ----------------------------------------------------------------------------
   Due strategie, perché i file hanno esigenze diverse:

   · APP SHELL (index.html, app.js, styles.css, i JSON dei dati)
     network-first con ricaduta sulla cache. Quando c'è rete l'app carica
     sempre la versione più recente, quindi un aggiornamento pubblicato arriva
     da solo al primo avvio utile; senza rete si usa la copia in cache e tutto
     continua a funzionare offline, com'è indispensabile in palestra.

   · RISORSE STATICHE (icone, schermate di avvio)
     cache-first: non cambiano quasi mai e non vale la pena interrogare la rete.

   Alla fine dell'installazione il nuovo worker NON si attiva da solo: avvisa
   la pagina, che mostra all'utente "aggiornamento pronto". È l'utente a
   decidere quando applicarlo, così un aggiornamento non irrompe a metà seduta.
   ========================================================================== */
const CACHE = 'palestra50-v25';

const SHELL = [
  './', './index.html', './styles.css', './app.js',
  './exercises.json', './programs.json', './poses.json', './quotes.json',
  './manifest.webmanifest'
];
const STATIC = [
  './icon-192.png', './icon-512.png', './icon-512-maskable.png',
  './splash-1170x2532.png', './splash-1125x2436.png',
  './splash-1284x2778.png', './splash-1179x2556.png'
];

const isShell = url =>
  SHELL.some(p => url.pathname.endsWith(p.replace('./', '/'))) ||
  url.pathname.endsWith('/') ;

self.addEventListener('install', e => {
  // addAll fallisce in blocco se manca un file: le risorse statiche si
  // aggiungono una per una, così un'icona assente non impedisce l'installazione
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    await Promise.all(STATIC.map(u => c.add(u).catch(() => {})));
  })());
  // niente skipWaiting: il nuovo worker resta in attesa finché l'utente accetta
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* La pagina chiede di applicare subito l'aggiornamento. */
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (isShell(url)) {
    // network-first: la rete decide, la cache salva la situazione
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        return hit || caches.match('./index.html');
      }
    })());
    return;
  }

  // cache-first per tutto il resto
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      const c = await caches.open(CACHE);
      c.put(req, res.clone());
      return res;
    } catch (err) {
      return caches.match('./index.html');
    }
  })());
});
