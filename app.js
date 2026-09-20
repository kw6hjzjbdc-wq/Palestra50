/* ============================================================================
   PALESTRA 50 — logica applicativa
   ----------------------------------------------------------------------------
   Struttura del file
     1. Stato e persistenza (localStorage)
     2. Caricamento dati (exercises.json, programs.json, poses.json)
     3. Illustrazioni: renderer SVG a partire dalla libreria di pose
     4. Motore di periodizzazione (profilo settimanale, dosi, carichi)
     5. Generazione della sessione del giorno
     6. Viste (Oggi, Sessione, Progressi, Programma)
     7. Timer di recupero, audio, wake lock
   ============================================================================ */

const KEY = 'palestra50.v1';
const DAYS_STRENGTH = [1, 3, 5];   // sessioni 1,3,5 = potenziamento
const DAYS_STRETCH  = [2, 4];      // sessioni 2,4 = stretching/mobilità
const BANDS = ['Azzurra (leggera)', 'Gialla (media)', 'Rossa (dura)', 'Viola (molto dura)'];

let DB = { exercises: [] }, PROG = null, POSES = null, QUOTES = [];
let S = null;              // stato persistente
let current = null;        // sessione in corso
let planCache = null;      // sessione di oggi già generata (per mantenere le sostituzioni)
let homeSel = 'session';   // cosa è selezionato nella home: 'session' o 'core'
let wakeLock = null, timerHandle = null;

/* ---------------------------------------------------------------------------
   1. STATO
--------------------------------------------------------------------------- */
const DEFAULT_STATE = {
  v: 1,
  setup: 'gym',            // 'gym' | 'home'
  programId: 'macro2027',
  macroMigrated: false,    // passaggio una tantum al macrociclo
  sessionIndex: 0,         // numero progressivo della prossima sessione da fare
  kneeCare: true,          // dà priorità agli esercizi a basso impatto sul ginocchio
  shoulderCare: true,      // esclude gli esercizi critici per il conflitto subacromiale
  pullupGoal: true,        // blocco trazioni in apertura delle sedute di forza
  perms: {},               // ordine delle 5 sedute all'interno di ciascuna settimana
  mobilityWeeks: [],       // settimane in cui si fa solo mobilità (il programma slitta)
  sound: true,             // campanella del timer
  disclaimerOk: false,
  logs: [],                // storico per esercizio
  sessionLog: [],          // storico per sessione (durata, note)
  lastExport: 0,            // timestamp dell'ultimo salvataggio JSON esportato
  quoteQueue: [],           // indici delle ultime 100 frasi mostrate all'avvio
  exNotes: {},              // nota personale per esercizio (regolazioni, accorgimenti)
  paceFactor: 1,            // calibrazione della durata stimata sulle sedute reali
  autoBackup: true,         // istantanea automatica a fine settimana
  snapshots: [],            // ultime 3 istantanee settimanali, ripristinabili
  resume: null,             // seduta interrotta, recuperabile dopo la chiusura dell'app
  lastRecap: 0              // ultima settimana di cui è stato mostrato il riepilogo
};

function load() {
  try { S = Object.assign({}, DEFAULT_STATE, JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch (e) { S = Object.assign({}, DEFAULT_STATE); }
  if (!S.exNotes) S.exNotes = {};
  if (!Array.isArray(S.snapshots)) S.snapshots = [];
}

/* ---------------------------------------------------------------------------
   ARCHIVIO DEI RISULTATI (IndexedDB)
   localStorage ha un limite di pochi megabyte e obbliga a riscrivere l'intero
   stato a ogni salvataggio: con cinque sedute a settimana per nove mesi i
   record diventano qualche migliaio, e ogni serie registrata costa di più.
   Qui le impostazioni restano in localStorage, mentre i record di allenamento
   vivono in IndexedDB. In memoria S.logs resta un normale array, così il resto
   del codice non cambia: la scrittura avviene in sottofondo.
   Se IndexedDB non è disponibile si continua con il solo localStorage.
--------------------------------------------------------------------------- */
const IDB_NAME = 'palestra50', IDB_STORE = 'logs';
let idb = null, idbReady = false;

function idbOpen() {
  return new Promise(resolve => {
    try {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const st = db.createObjectStore(IDB_STORE, { keyPath: 'k', autoIncrement: true });
          st.createIndex('exId', 'exId', { unique: false });
          st.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      setTimeout(() => resolve(req.result || null), 1500);   // non bloccare l'avvio
    } catch (e) { resolve(null); }
  });
}

function idbAll() {
  return new Promise(resolve => {
    if (!idb) return resolve(null);
    try {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

/* Riscrive l'archivio: chiamata in sottofondo dopo ogni modifica ai record. */
function idbWrite(logs) {
  if (!idb) return;
  try {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    const st = tx.objectStore(IDB_STORE);
    st.clear();
    logs.forEach((l, i) => st.put(Object.assign({ k: i + 1 }, l)));
  } catch (e) {}
}

/* All'avvio: apre l'archivio, recupera i record e li fonde con quelli ancora
   in localStorage (migrazione una tantum, senza perdere nulla). */
async function initStore() {
  idb = await idbOpen();
  idbReady = !!idb;
  if (!idb) return;
  const rows = await idbAll();
  if (rows === null) return;
  const clean = rows.map(r => { const o = Object.assign({}, r); delete o.k; return o; });
  if (clean.length && clean.length >= (S.logs || []).length) {
    S.logs = clean;                       // l'archivio è la fonte più aggiornata
  } else if ((S.logs || []).length) {
    idbWrite(S.logs);                     // prima migrazione da localStorage
  }
  S.idbMigrated = true;
  save();
}

/* ---------------------------------------------------------------------------
   PERSISTENZA DELLO SPAZIO DI ARCHIVIAZIONE
   Chiede al sistema di non cancellare i dati durante le pulizie automatiche.
   È l'unica difesa contro la scadenza per inutilizzo prolungato; non protegge
   dalla rimozione manuale dell'icona dalla schermata Home, per quella serve il
   backup. L'esito viene mostrato nella scheda Dati.
--------------------------------------------------------------------------- */
let storagePersisted = null;
async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) { storagePersisted = 'n/d'; return; }
    if (navigator.storage.persisted && await navigator.storage.persisted()) { storagePersisted = true; return; }
    storagePersisted = await navigator.storage.persist();
  } catch (e) { storagePersisted = 'n/d'; }
}

/* Esercizi rinominati: le registrazioni restano agganciate all'identificativo,
   qui si aggiorna solo il nome mostrato nello storico. */
const RENAMED = {
  g_backext: 'Iperestensioni orizzontali',
  g_calfseated: 'Calf raise in piedi alla macchina',
  g_calfstanding: 'Calf raise in piedi con manubri'
};
/* Il calf seduto è stato sostituito dal calf in piedi alla macchina: i carichi
   registrati sul vecchio attrezzo non sono confrontabili con quelli del nuovo,
   quindi vengono cancellati una volta sola per non falsare suggerimenti e
   valutazioni. Tutti gli altri esercizi restano intatti. */
function resetCalfLogs() {
  if (S.calfReset) return;
  S.calfReset = true;
  const before = S.logs.length;
  S.logs = S.logs.filter(l => l.exId !== 'g_calfseated');
  if (S.logs.length !== before) planCache = null;
  save();
}

/* I record salvati prima della versione 4.0 non hanno ripetizioni eseguite né
   RIR: si allineano al target, così i confronti restano possibili e la regola
   2-for-2 semplicemente non scatta finché non ci sono dati reali. */
function migrateLogFields() {
  let touched = false;
  S.logs.forEach(l => {
    if (l.repsTarget === undefined) { l.repsTarget = l.reps; touched = true; }
    if (l.repsDone === undefined) { l.repsDone = l.reps; touched = true; }
    if (l.rir === undefined) { l.rir = null; touched = true; }
  });
  if (touched) save();
}

/* ---------------------------------------------------------------------------
   PROPOSTA UNA TANTUM: settimana di sola mobilità
   L'utente ha annunciato una settimana senza sala pesi, ma l'impostazione vive
   nei dati sul telefono e va confermata da lui: qui l'app lo chiede una volta
   sola, lasciandogli scegliere se la pausa è questa settimana o la prossima.
--------------------------------------------------------------------------- */
function askMobilityWeek() {
  if (S.mobAsked) return;
  S.mobAsked = true; save();
  const meta = sessionMeta(S.sessionIndex);
  const q = meta.weekAbs, n = meta.weekAbs + 1;
  openModal(`<h2>Una settimana di sola mobilità?</h2>
    <p class="small muted">Hai detto che per una settimana potrai fare solo mobilità e stretching.
      Dimmi quale: tutte e cinque le sedute diventeranno di allungamento e il programma di forza
      <b>slitterà in avanti</b>, riprendendo da dove è rimasto. Nessuna settimana di lavoro va persa.</p>
    <p class="small muted">Sei alla sessione ${meta.pos} di 5 della settimana ${q}.</p>
    <button class="btn" id="mbNext" style="margin-top:12px">La prossima · settimana ${n}</button>
    <button class="btn ghost" id="mbThis" style="margin-top:10px">Quella in corso · settimana ${q}</button>
    <button class="btn ghost" id="mbNo" style="margin-top:10px">Per ora no</button>`);
  const set = w => { S.mobilityWeeks = [w]; planCache = null; save(); closeModal(() => { go('home'); }); };
  $('#mbNext').onclick = () => set(n);
  $('#mbThis').onclick = () => set(q);
  $('#mbNo').onclick = () => closeModal();
}

function migrateNames() {
  let touched = false;
  S.logs.forEach(l => {
    if (RENAMED[l.exId] && l.name !== RENAMED[l.exId]) { l.name = RENAMED[l.exId]; touched = true; }
  });
  if (touched) save();
}

/* Passaggio al macrociclo fino al 30 maggio 2027. Cambia solo il programma
   attivo: indice della settimana, storico dei carichi, valutazioni e backup
   restano intatti. Si può sempre tornare a un altro programma da Programma. */
function migrateToMacro() {
  if (S.macroMigrated) return;
  S.macroMigrated = true;
  if (PROG.programs.some(p => p.id === 'macro2027')) S.programId = 'macro2027';
  save();
}
function save() {
  try {
    // i record di allenamento vivono in IndexedDB: in localStorage resta tutto
    // il resto, così il salvataggio delle impostazioni non riscrive lo storico
    if (idbReady) {
      const light = Object.assign({}, S, { logs: [] });
      localStorage.setItem(KEY, JSON.stringify(light));
      idbWrite(S.logs);
    } else {
      localStorage.setItem(KEY, JSON.stringify(S));
    }
  } catch (e) {
    // quota superata: si tenta comunque il salvataggio senza lo storico
    try { localStorage.setItem(KEY, JSON.stringify(Object.assign({}, S, { logs: [] }))); } catch (e2) {}
  }
}

/* ---------------------------------------------------------------------------
   2. DATI
--------------------------------------------------------------------------- */
async function loadData() {
  const [ex, pr, po, qu] = await Promise.all([
    fetch('exercises.json').then(r => r.json()),
    fetch('programs.json').then(r => r.json()),
    fetch('poses.json').then(r => r.json()),
    fetch('quotes.json').then(r => r.json()).catch(() => ({ quotes: [] }))
  ]);
  DB = ex; PROG = pr; POSES = po; QUOTES = qu.quotes || [];
}
const exById = id => DB.exercises.find(e => e.id === id);

/* ---------------------------------------------------------------------------
   VALIDAZIONE DEI FILE DI DATI
   Tre illustrazioni sbagliate erano pose riciclate da altri esercizi: formalmente
   valide, visivamente assurde. Qui si controlla che ogni esercizio abbia pose
   esistenti, un attrezzo riconosciuto e i campi obbligatori, e che nessuna posa
   sia usata da esercizi di gruppi muscolari incompatibili. Gli errori compaiono
   nella console e, se gravi, in un avviso nella scheda Programma: meglio
   trovarli alla scrivania che in palestra.
--------------------------------------------------------------------------- */
const KNOWN_IMPLEMENTS = [
  null, 'barbell', 'barbellBack', 'dumbbells', 'dumbbell1', 'goblet', 'machine',
  'cable', 'wheel', 'platform', 'thighPad', 'grips', 'bar', 'barBand', 'pullbar',
  'bandVertical', 'bandTop', 'bandFront', 'bandBack', 'bandFeet', 'bandFoot',
  'bandKnees', 'bandAnkle', 'bandShoulder', 'bandSide'
];
const REQUIRED_FIELDS = ['id', 'name', 'setup', 'type', 'group', 'pattern', 'load',
                         'primary', 'equipment', 'art', 'steps', 'errors', 'safety', 'source'];
let dataIssues = [];

function validateData() {
  dataIssues = [];
  const seen = new Set();
  const poseNames = new Set(Object.keys(POSES.poses).concat(Object.keys(POSES.aliases || {})));
  const poseUse = {};

  DB.exercises.forEach(e => {
    const who = e.id || e.name || '(senza id)';
    REQUIRED_FIELDS.forEach(f => {
      if (e[f] === undefined || e[f] === null) dataIssues.push(`${who}: manca il campo "${f}"`);
    });
    if (seen.has(e.id)) dataIssues.push(`${who}: identificativo duplicato`);
    seen.add(e.id);
    if (!Array.isArray(e.setup) || !e.setup.length) dataIssues.push(`${who}: attrezzatura non indicata`);
    if (!['strength', 'core', 'stretch'].includes(e.type)) dataIssues.push(`${who}: tipo "${e.type}" sconosciuto`);
    if (!['weight', 'band', 'bodyweight', 'time'].includes(e.load)) dataIssues.push(`${who}: carico "${e.load}" sconosciuto`);
    const art = e.art || {};
    if (!Array.isArray(art.frames) || art.frames.length !== 2) {
      dataIssues.push(`${who}: servono esattamente due pose`);
    } else {
      art.frames.forEach(f => {
        if (!poseNames.has(f)) dataIssues.push(`${who}: posa "${f}" inesistente`);
        (poseUse[f] = poseUse[f] || []).push(e);
      });
      if (art.frames[0] === art.frames[1] && e.load !== 'time' && e.type !== 'stretch') {
        dataIssues.push(`${who}: le due pose sono identiche pur non essendo un esercizio a tempo`);
      }
    }
    if (KNOWN_IMPLEMENTS.indexOf(art.implement === undefined ? null : art.implement) < 0) {
      dataIssues.push(`${who}: attrezzo "${art.implement}" non riconosciuto dal disegnatore`);
    }
    if (e.levels && (!Array.isArray(e.levels) || e.levels.length < 2)) {
      dataIssues.push(`${who}: la progressione deve avere almeno due gradini`);
    }
  });

  // una posa condivisa da gruppi molto diversi è il segnale del riciclo sbagliato.
  // Le pose neutre di partenza sono legittimamente comuni e restano fuori dal controllo.
  const NEUTRAL = ['stand', 'seated', 'plank'];
  Object.keys(poseUse).forEach(f => {
    if (NEUTRAL.indexOf(f) >= 0) return;
    const groups = new Set(poseUse[f].map(e => e.group));
    if (groups.size > 3) {
      dataIssues.push(`posa "${f}" usata da ${groups.size} gruppi diversi (${Array.from(groups).join(', ')}): verificare la pertinenza`);
    }
  });

  if (dataIssues.length) {
    console.warn(`[Palestra 50] ${dataIssues.length} anomalie nei dati:`);
    dataIssues.forEach(m => console.warn('  · ' + m));
  }
  return dataIssues;
}
const program = () => PROG.programs.find(p => p.id === S.programId) || PROG.programs[0];

/* ---------------------------------------------------------------------------
   3. ILLUSTRAZIONI
   Ogni posa è uno scheletro 2D (vedi poses.json). Il renderer disegna gli arti
   in secondo piano più chiari, poi tronco, testa, braccia, e infine l'attrezzo.
--------------------------------------------------------------------------- */
function pose(name) {
  const p = POSES.poses[name] || POSES.poses[POSES.aliases[name]] || POSES.poses.stand;
  return p;
}
function implementSvg(kind, p) {
  if (!kind) return '';
  const h = p.hand, h2 = p.hand2 || [p.hand[0] - 6, p.hand[1]], n = p.neck, a = p.ankle;
  const bar = (pt, len) => `<line x1="${pt[0] - len}" y1="${pt[1]}" x2="${pt[0] + len}" y2="${pt[1]}" class="imp" stroke-width="3.4" stroke-linecap="round"/>`;
  const bell = pt => `<rect x="${pt[0] - 5}" y="${pt[1] - 3.2}" width="10" height="6.4" rx="2" class="impf"/>`;
  const band = (x, y) => `<path d="M ${h[0]} ${h[1]} L ${x} ${y}" class="band" stroke-width="2.6" stroke-dasharray="4 3" fill="none"/>`;
  switch (kind) {
    case 'barbell':      return bar(h, 17);
    case 'barbellBack':  return bar(n, 17);
    case 'dumbbells':    return bell(h) + bell(h2);
    case 'dumbbell1':    return bell(h);
    case 'goblet':       return `<rect x="${n[0] - 4}" y="${n[1] + 4}" width="8" height="13" rx="2.5" class="impf"/>`;
    case 'wheel':        return `<circle cx="${h[0]}" cy="${h[1] + 2}" r="6" class="imp" fill="none" stroke-width="3"/>`;
    case 'machine':      return `<line x1="108" y1="18" x2="108" y2="100" class="imp" stroke-width="3"/>` + band(108, h[1]);
    // pedana della leg press: piano inclinato appoggiato ai piedi
    case 'platform':     return `<line x1="${(p.toe || p.ankle)[0] - 6}" y1="${(p.toe || p.ankle)[1] - 14}" x2="${(p.toe || p.ankle)[0] + 10}" y2="${(p.toe || p.ankle)[1] + 10}" class="imp" stroke-width="4.5" stroke-linecap="round"/>`;
    // cuscino sulle cosce del calf seduto
    case 'thighPad':     return `<rect x="${(p.hip[0] + p.knee[0]) / 2 - 9}" y="${p.knee[1] - 11}" width="18" height="7" rx="3" class="impf"/>`;
    // impugnature parallele delle macchine guidate
    case 'grips':        return `<line x1="${h[0]}" y1="${h[1] - 6}" x2="${h[0]}" y2="${h[1] + 6}" class="imp" stroke-width="4" stroke-linecap="round"/>` +
                                `<line x1="${h2[0]}" y1="${h2[1] - 6}" x2="${h2[0]}" y2="${h2[1] + 6}" class="imp" stroke-width="3" stroke-linecap="round"/>`;
    case 'cable':        return `<line x1="112" y1="6" x2="112" y2="100" class="imp" stroke-width="3"/>` + band(112, Math.min(h[1], 30));
    // sbarra per trazioni: barra orizzontale appena sopra le mani
    case 'bar':          return `<line x1="${h[0] - 30}" y1="${h[1] - 4}" x2="${h[0] + 26}" y2="${h[1] - 4}" class="imp" stroke-width="3.6" stroke-linecap="round"/>`;
    // sbarra con elastico agganciato che scende fino al piede
    case 'barBand':      return `<line x1="${h[0] - 30}" y1="${h[1] - 4}" x2="${h[0] + 26}" y2="${h[1] - 4}" class="imp" stroke-width="3.6" stroke-linecap="round"/>` +
                                `<path d="M ${h[0] - 10} ${h[1] - 4} L ${(p.toe || p.ankle)[0]} ${(p.toe || p.ankle)[1]}" class="band" stroke-width="2.6" stroke-dasharray="4 3" fill="none"/>`;
    // macchina assistita: sbarra più pedana d'appoggio per le ginocchia
    case 'pullbar':      return `<line x1="${h[0] - 30}" y1="${h[1] - 4}" x2="${h[0] + 26}" y2="${h[1] - 4}" class="imp" stroke-width="3.6" stroke-linecap="round"/>` +
                                `<rect x="${p.ankle[0] - 14}" y="${p.ankle[1] + 2}" width="30" height="6" rx="3" class="impf"/>`;
    case 'bandVertical': return band(a[0], 99);
    case 'bandShoulder': return `<path d="M ${n[0]} ${n[1] + 3} L ${a[0]} 99" class="band" stroke-width="2.6" stroke-dasharray="4 3" fill="none"/>`;
    case 'bandTop':      return band(112, 6) + `<circle cx="112" cy="6" r="2.6" class="impf"/>`;
    case 'bandFront':    return band(h2[0], h2[1]);
    case 'bandBack':     return band(n[0], n[1] + 4);
    case 'bandFeet':     return band((p.toe || p.ankle)[0], (p.toe || p.ankle)[1]);
    case 'bandFoot':     return band((p.toe || p.ankle)[0], (p.toe || p.ankle)[1]);
    case 'bandKnees':    return `<path d="M ${p.knee[0]} ${p.knee[1] - 4} L ${(p.knee2 || p.knee)[0] - 6} ${p.knee[1] - 6}" class="band" stroke-width="2.6" stroke-dasharray="4 3"/>`;
    case 'bandAnkle':    return `<path d="M ${p.ankle[0]} ${p.ankle[1]} L ${(p.ankle2 || p.ankle)[0]} ${(p.ankle2 || p.ankle)[1]}" class="band" stroke-width="2.6" stroke-dasharray="4 3"/>`;
    case 'bandSide':     return band(114, h[1]);
    default:             return '';
  }
}
function figure(frameName, implement, opts) {
  const p = pose(frameName), o = opts || {};
  // Colori inline: l'SVG deve restare autonomo anche fuori dal foglio di stile.
  // Le illustrazioni sono contenuto informativo, non decorazione: se il
  // chiamante fornisce una descrizione, la figura viene esposta agli screen
  // reader con il proprio testo invece di essere nascosta.
  const lab = o.label ? ` role="img" aria-label="${esc(o.label)}"` : ' aria-hidden="true"';
  const s = `<svg viewBox="${POSES.viewBox}" xmlns="http://www.w3.org/2000/svg"${lab}>` +
            (o.label ? `<title>${esc(o.label)}</title>` : '');
  const cBack = '#5B7188', cBody = o.color || '#EAF1F8', cArm = o.accent || '#F5A524', cImp = '#B9CBDD';
  let g = '';
  if (o.ground !== false) g += `<line x1="4" y1="${POSES.ground}" x2="116" y2="${POSES.ground}" stroke="#2B3B4E" stroke-width="2"/>`;
  const L = (a, b, c, w) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
  if (p.knee2) { g += L(p.hip, p.knee2, cBack, 4.5) + L(p.knee2, p.ankle2 || p.knee2, cBack, 4.5) + (p.toe2 ? L(p.ankle2, p.toe2, cBack, 3.2) : ''); }
  if (p.elbow2) { g += L(p.neck, p.elbow2, cBack, 4.5) + L(p.elbow2, p.hand2, cBack, 4.5); }
  // tronco (con eventuale punto intermedio di colonna per gatto/cammello)
  if (p.spine) g += `<path d="M ${p.hip[0]} ${p.hip[1]} Q ${p.spine[0]} ${p.spine[1]} ${p.neck[0]} ${p.neck[1]}" stroke="${cBody}" stroke-width="5.5" fill="none" stroke-linecap="round"/>`;
  else g += L(p.hip, p.neck, cBody, 5.5);
  g += L(p.hip, p.knee, cBody, 5) + L(p.knee, p.ankle, cBody, 5);
  if (p.toe) g += L(p.ankle, p.toe, cBody, 3.4);
  g += L(p.neck, p.elbow, cArm, 5) + L(p.elbow, p.hand, cArm, 5);
  g += `<circle cx="${p.head[0]}" cy="${p.head[1]}" r="6.4" stroke="${cBody}" stroke-width="4" fill="none"/>`;
  g += implementSvg(implement, p).replace(/class="imp"/g, `stroke="${cImp}" fill="none"`)
                                .replace(/class="impf"/g, `fill="${cImp}"`)
                                .replace(/class="band"/g, `stroke="#4FC3A1" fill="none"`);
  return s + g + '</svg>';
}
const figureFor = (ex, frameIdx, opts) => figure(ex.art.frames[frameIdx || 0], ex.art.implement, opts);

/* Descrizione testuale della figura, ricavata dai dati già presenti nella
   scheda: nome dell'esercizio, fase e attrezzatura. */
function figureLabel(ex, frameIdx) {
  const fase = frameIdx ? 'posizione finale' : 'posizione iniziale';
  const att = (ex.equipment || []).join(', ');
  return `${ex.name}: ${fase}${att ? ', con ' + att.toLowerCase() : ', a corpo libero'}`;
}
const figureA11y = (ex, frameIdx, opts) =>
  figure(ex.art.frames[frameIdx || 0], ex.art.implement,
         Object.assign({ label: figureLabel(ex, frameIdx) }, opts || {}));

/* ---------------------------------------------------------------------------
   4. PERIODIZZAZIONE
   weekProfile() traduce la settimana del mesociclo in modificatori di volume e
   intensità: le settimane centrali costruiscono, l'ultima è di scarico.
   Riferimenti: ACSM (progressione di volume/intensità per adulti), NSCA
   (sovraccarico progressivo e periodizzazione lineare/ondulata).
--------------------------------------------------------------------------- */
function weekProfile(week, cycleWeeks) {
  if (week >= cycleWeeks) {
    return { week, label: 'Scarico', setsDelta: -1, loadFactor: 0.85, repsBias: 0.5,
             note: 'Settimana di scarico: volume ridotto per favorire il recupero.' };
  }
  const builds = Math.max(1, cycleWeeks - 1);
  const t = builds > 1 ? (week - 1) / (builds - 1) : 0;      // 0 → 1 nel mesociclo
  return {
    week,
    label: week === 1 ? 'Adattamento' : (week === builds ? 'Picco' : 'Costruzione'),
    setsDelta: week === builds ? 1 : 0,
    loadFactor: 1 + 0.025 * (week - 1),                       // ~2,5% a settimana
    repsBias: 1 - t,                                          // ripetizioni alte → basse
    note: week === 1
      ? 'Prima settimana del ciclo: prendi confidenza con i carichi, RPE 6-7.'
      : (week === builds ? 'Settimana di picco: carichi più alti e una serie in più.'
                         : 'Aumenta il carico del 2-3% rispetto alla settimana scorsa.')
  };
}

/* Nota della settimana per le sedute di mobilità e stretching.
   Qui non c'è carico da aumentare: la progressione si misura in ampiezza del
   movimento raggiunta senza dolore, e in controllo. Linee guida ACE:
   tensione moderata, mai dolore, respirazione regolare. */
function mobilityNote(profile, mobWeek) {
  if (mobWeek) return 'Settimana di sola mobilità: cinque sedute di allungamento, nessun carico. ' +
                      'Cerca ampiezza con calma, sempre sotto la soglia del dolore.';
  if (profile.label === 'Scarico') return 'Settimana leggera anche per la mobilità: movimenti morbidi, meno serie, nessuna forzatura.';
  if (profile.label === 'Adattamento') return 'Allunga senza forzare: tensione moderata, mai dolore, respiro lento e regolare.';
  if (profile.label === 'Picco') return 'Una serie in più per gruppo: mantieni la stessa tensione moderata, cambia solo la durata complessiva.';
  return 'Cerca un po\' più di ampiezza rispetto alla settimana scorsa, a parità di comfort: il progresso qui è il movimento, non il carico.';
}

/* Dose (serie, ripetizioni, recupero) per un obiettivo e una settimana.
   Gli esercizi unilaterali (un lato alla volta) ricevono sempre un numero PARI
   di serie, così destra e sinistra lavorano lo stesso numero di volte. */
function dose(goalKey, profile, ex) {
  const g = PROG.goals[goalKey];
  let sets = Math.min(6, Math.max(2, g.sets + (profile.setsDelta || 0)));
  const perSide = !!(ex && ex.perSide);
  if (perSide && sets % 2) sets++;                 // arrotonda al pari superiore
  const reps = Math.round(g.repsLow + (g.repsHigh - g.repsLow) * profile.repsBias);
  // la tenuta vale solo per gli esercizi a tempo (allungamenti, isometrie)
  const timed = goalKey === 'stretch' || !ex || ex.load === 'time';
  return {
    goal: goalKey, goalLabel: g.label, sets, reps, perSide,
    rest: g.rest, hold: timed ? (g.hold || 0) : 0, rpe: g.rpe, source: g.source
  };
}
/* Etichetta della singola serie: per gli unilaterali alterna sinistra e destra. */
function setLabel(it, i) {
  if (!it.perSide) return String(i + 1);
  return `${Math.floor(i / 2) + 1}${i % 2 ? ' Dx' : ' Sx'}`;
}

/* ---------------------------------------------------------------------------
   PROGRESSIONE DEL CARICO — regola 2-for-2 (NSCA)
   Il carico sale solo quando il miglioramento si è ripetuto: nelle ultime DUE
   sedute dello stesso esercizio devi aver completato almeno DUE ripetizioni
   oltre l'obiettivo nell'ultima serie. L'incremento resta nella fascia 2,5-10%
   raccomandata, più prudente sui piccoli gruppi muscolari. Le ripetizioni in
   riserva (RIR) e il feedback soggettivo servono come correttivo: se l'ultima
   volta sei arrivato al limite (RIR 0) il carico non sale comunque, se è stato
   troppo pesante scende.
   Riferimenti: NSCA, regola 2-for-2; ACSM, incremento del 2-10%.
--------------------------------------------------------------------------- */
const SMALL_GROUPS = ['Braccia', 'Spalle', 'Polpacci', 'Core'];

/* ---------------------------------------------------------------------------
   ESERCIZI AD ASSISTENZA
   In alcuni esercizi il numero che annoti non è un sovraccarico ma un aiuto:
   il contrappeso della macchina per le trazioni assistite, o l'elastico che
   solleva parte del peso corporeo. Lì il progresso va nella direzione opposta,
   cioè verso meno assistenza, e anche la band più dura è quella che aiuta di
   più. Tutta la logica dei carichi passa da qui, così il verso resta coerente
   in suggerimenti, valutazioni, grafici e avvisi.
--------------------------------------------------------------------------- */
const isAssist = ex => !!(ex && ex.assist);

/* ---------------------------------------------------------------------------
   CARICHI REALMENTE DISPONIBILI IN PALESTRA
   Suggerire "22,7 kg" è inutile se quel peso non si può comporre. Qui sono
   descritte le scale effettive degli attrezzi, e ogni suggerimento viene
   portato sul valore più vicino che esiste davvero:

   · bilanciere — barra da 10 kg, dischi da 2, 5, 10 e 20 kg montati a coppie:
     i totali componibili sono 10, 14, 18 e poi tutti i pari (12 e 16
     richiederebbero 1 e 3 kg per lato, che non ci sono);
   · manubri — rastrelliera da 2 a 40 kg; il numero annotato è il peso del
     SINGOLO manubrio, anche quando se ne usano due;
   · macchine, cavi e lat machine — pacco pesi da 10 a 120 kg a passi di 2,5;
   · casa — manubri da 1 e 2 kg, usabili anche in coppia.

   Da queste scale discende anche il passo minimo: serve a non segnalare come
   "salto" un incremento che è semplicemente il più piccolo possibile su quel
   ferro. Passare da 20 a 22 kg col bilanciere è +10%, ma è anche l'unico
   scalino disponibile.
--------------------------------------------------------------------------- */
function barbellScale() {
  // barra 10 kg + coppie di dischi da 2/5/10/20
  const disks = [2, 5, 10, 20];
  let sums = new Set([0]);
  for (let k = 0; k < 8; k++) {
    const next = new Set(sums);
    sums.forEach(v => disks.forEach(d => { if (v + d <= 95) next.add(v + d); }));
    sums = next;
  }
  return Array.from(sums).map(v => 10 + 2 * v).filter(v => v <= 200).sort((a, b) => a - b);
}
const RACKS = {
  barbell:  barbellScale(),
  dumbbell: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40],
  machine:  Array.from({ length: 45 }, (_, i) => 10 + i * 2.5),      // 10 → 120
  home:     [1, 2, 3, 4]                                             // 1+2 kg, anche in coppia
};
const rackOf = ex => (ex && RACKS[ex.rack]) ? RACKS[ex.rack] : null;

/* Riga di spiegazione della scala, mostrata sotto il selettore del carico. */
function rackNote(ex) {
  if (!ex || ex.load !== 'weight') return '';
  switch (ex.rack) {
    case 'barbell':  return 'Bilanciere da 10 kg con dischi da 2, 5, 10 e 20 kg a coppie: 12 e 16 kg non sono componibili.';
    case 'dumbbell': return 'Peso del singolo manubrio, dalla rastrelliera da 2 a 40 kg.';
    case 'machine':  return 'Pacco pesi da 10 a 120 kg, a scalini di 2,5 kg.';
    case 'home':     return 'Manubri da 1 e 2 kg, anche in coppia.';
    default: return '';
  }
}

/* Porta un valore sulla scala dell'attrezzo.
   dir  +1 = non scendere sotto il valore chiesto, -1 = non salire sopra,
        0 = semplicemente il più vicino.
   Se il valore cade fuori scala si resta agli estremi. */
function snapLoad(ex, v, dir) {
  const scale = rackOf(ex);
  if (!scale || !isFinite(v)) return v;
  if (v <= scale[0]) return scale[0];
  if (v >= scale[scale.length - 1]) return scale[scale.length - 1];
  if (dir > 0) { for (const x of scale) if (x >= v - 0.001) return x; return scale[scale.length - 1]; }
  if (dir < 0) { for (let i = scale.length - 1; i >= 0; i--) if (scale[i] <= v + 0.001) return scale[i]; return scale[0]; }
  let best = scale[0];
  scale.forEach(x => { if (Math.abs(x - v) < Math.abs(best - v)) best = x; });
  return best;
}

/* Valore successivo o precedente sulla scala, a partire da uno esistente. */
function stepOnScale(ex, v, dir) {
  const scale = rackOf(ex);
  if (!scale) return v + dir * (isAssist(ex) ? 5 : 1);
  const snapped = snapLoad(ex, v, 0);
  const i = scale.indexOf(snapped);
  if (i < 0) return snapLoad(ex, v + dir, dir);
  const j = Math.max(0, Math.min(scale.length - 1, i + dir));
  return scale[j];
}

/* Passo minimo realmente disponibile attorno a un certo carico. */
function minStepFor(ex, n) {
  const scale = rackOf(ex);
  if (scale) {
    const snapped = snapLoad(ex, n, 0);
    const i = scale.indexOf(snapped);
    const prev = i > 0 ? snapped - scale[i - 1] : Infinity;
    const next = i < scale.length - 1 ? scale[i + 1] - snapped : Infinity;
    const st = Math.min(prev, next);
    return isFinite(st) ? st : 2.5;
  }
  if (isAssist(ex)) return 5;
  if (!isFinite(n) || n < 10) return 0.5;
  return SMALL_GROUPS.includes(ex.group) ? 1 : 2.5;
}
/* +1 = si progredisce aumentando il numero, -1 = riducendolo */
const progressDir = ex => isAssist(ex) ? -1 : 1;
/* Parola giusta da mostrare: "carico" oppure "assistenza". */
const loadWord = ex => isAssist(ex) ? 'assistenza' : 'carico';
function lastEntry(exId) {
  for (let i = S.logs.length - 1; i >= 0; i--) if (S.logs[i].exId === exId) return S.logs[i];
  return null;
}
function lastEntries(exId, n) {
  return S.logs.filter(l => l.exId === exId).slice(-n);
}

/* Vero se in quella registrazione hai superato l'obiettivo di 2+ ripetizioni. */
function beatTarget(l) {
  if (!l || !isFinite(l.repsDone) || !isFinite(l.repsTarget)) return false;
  return l.repsDone >= l.repsTarget + 2;
}

/* Elenco dei gradini per gli esercizi a corpo libero con progressione. */
const levelsOf = ex => (ex && ex.levels) ? ex.levels : null;

function suggestLoad(ex) {
  const last = lastEntry(ex.id);
  if (!last) return null;
  const recent = lastEntries(ex.id, 2);
  const twoForTwo = recent.length >= 2 && recent.every(beatTarget);
  // due condizioni distinte: arrivare al limite una volta (RIR 0) blocca
  // l'aumento ma non fa scendere il carico; solo un "troppo difficile"
  // esplicito lo riduce.
  const tooHard = last.feedback === 'down';
  const atLimit = last.rir === 0;
  const info = { last, twoForTwo, reason: '' };

  // --- scale a gradini: band ed esercizi a corpo libero con progressione ---
  const steps = ex.load === 'band' ? BANDS : levelsOf(ex);
  const dir = progressDir(ex);          // -1 sugli esercizi ad assistenza
  if (steps) {
    let i = steps.indexOf(last.load);
    if (i < 0) i = 0;
    const canAdvance = dir > 0 ? i < steps.length - 1 : i > 0;
    const canEase    = dir > 0 ? i > 0 : i < steps.length - 1;
    if (twoForTwo && !tooHard && !atLimit && canAdvance) {
      i += dir;
      info.reason = isAssist(ex)
        ? 'Regola 2-for-2 soddisfatta: riduci l\'assistenza passando alla band più leggera.'
        : 'Regola 2-for-2 soddisfatta: passa al gradino successivo.';
    } else if (tooHard && canEase) {
      i -= dir;
      info.reason = isAssist(ex)
        ? 'L\'ultima volta è stata troppo impegnativa: aumenta l\'assistenza di un gradino.'
        : 'L\'ultima volta è stata troppo impegnativa: torna al gradino precedente.';
    } else if (atLimit) {
      info.reason = 'L\'ultima serie è finita al limite: consolida questo gradino prima di procedere.';
    } else {
      info.reason = twoForTwo ? 'Consolida su questo gradino.'
                              : 'Resta qui finché non superi l\'obiettivo di 2 ripetizioni per due sedute.';
    }
    return Object.assign(info, { value: steps[i], steps });
  }

  if (ex.load !== 'weight') return Object.assign(info, { value: null });
  const n = parseFloat(String(last.load).replace(',', '.'));
  if (!isFinite(n) || n <= 0) return Object.assign(info, { value: null });

  const small = SMALL_GROUPS.includes(ex.group);
  const pct = small && !isAssist(ex) ? 0.025 : 0.05;
  const scale = rackOf(ex);
  const base = snapLoad(ex, n, 0);           // il carico di partenza, sulla scala reale
  const atTop = scale && base >= scale[scale.length - 1];
  const atBottom = scale && base <= scale[0];
  let val = base;

  /* Cerca il valore successivo nella direzione voluta: prima quello che
     rispetta la percentuale, ma mai meno di uno scalino reale dell'attrezzo
     e mai più del tetto del 10% (salvo che lo scalino minimo lo superi). */
  const move = (up, ratio) => {
    const target = base * ratio;
    let v = snapLoad(ex, target, up ? 1 : -1);
    if (up && v <= base) v = stepOnScale(ex, base, 1);
    if (!up && v >= base) v = stepOnScale(ex, base, -1);
    const capped = snapLoad(ex, base * (up ? 1 + SAFE_STEP : 1 - SAFE_STEP), up ? -1 : 1);
    const oneStep = stepOnScale(ex, base, up ? 1 : -1);
    if (up && v > capped && capped > base) v = capped;
    if (!up && v < capped && capped < base) v = capped;
    // uno scalino è sempre ammesso, anche se in percentuale sfora
    if (up && v <= base) v = oneStep;
    if (!up && v >= base) v = oneStep;
    return v;
  };

  const kg = x => String(Math.round(x * 10) / 10).replace('.', ',');

  if (tooHard) {
    // "troppo difficile": meno carico, oppure PIÙ assistenza
    val = isAssist(ex) ? move(true, 1.07) : move(false, 0.93);
    info.reason = isAssist(ex)
      ? `L'ultima volta è stata troppo impegnativa: assistenza a ${kg(val)} kg.`
      : `L'ultima volta è stata troppo impegnativa: scendi a ${kg(val)} kg.`;
  } else if (atLimit) {
    info.reason = `L'ultima serie è finita al limite: consolida questa ${loadWord(ex)} prima di procedere.`;
  } else if (twoForTwo) {
    if (isAssist(ex)) {
      val = atBottom ? 0 : move(false, 1 - pct);
      if (val <= (scale ? scale[0] : 0) && base <= (scale ? scale[0] : 0)) val = 0;
      info.reason = val <= 0
        ? 'Regola 2-for-2 soddisfatta: sei pronto a provare senza assistenza.'
        : `Regola 2-for-2 soddisfatta: assistenza ridotta a ${kg(val)} kg, uno scalino del pacco pesi.`;
    } else if (atTop) {
      info.reason = 'Sei al carico più alto disponibile su questo attrezzo: aumenta le ripetizioni o passa a una variante più difficile.';
    } else {
      val = move(true, 1 + pct);
      const d = val - base;
      info.reason = `Regola 2-for-2 soddisfatta nelle ultime due sedute: ${kg(val)} kg, ` +
                    `+${kg(d)} kg (${Math.round((val / base - 1) * 100)}%), il primo scalino utile su questo attrezzo.`;
    }
  } else {
    info.reason = recent.length < 2
      ? 'Serve una seconda seduta sopra l\'obiettivo prima di procedere.'
      : `Mantieni ${isAssist(ex) ? 'questa assistenza' : 'il carico'}: l'obiettivo non è stato superato di 2 ripetizioni per due sedute.`;
  }
  return Object.assign(info, { value: String(val % 1 === 0 ? val : val.toFixed(1)), scale });
}

/* Frase dell'intro: si pesca a caso fra quelle non ancora uscite nelle ultime
   100 aperture. La coda è lunga 100, quindi una frase non può ripetersi prima
   di altre cento aperture (l'elenco ne contiene più di 100). */
function pickQuote() {
  if (!QUOTES.length) return '';
  const q = S.quoteQueue || [];
  let pool = QUOTES.map((_, i) => i).filter(i => q.indexOf(i) < 0);
  if (!pool.length) pool = QUOTES.map((_, i) => i);
  const i = pool[Math.floor(Math.random() * pool.length)];
  q.push(i);
  while (q.length > Math.min(100, QUOTES.length - 1)) q.shift();
  S.quoteQueue = q; save();
  return QUOTES[i];
}

/* ---------------------------------------------------------------------------
   VALUTAZIONE DEI PROGRESSI (stelle da 1 a 5)
   Il punteggio confronta quanto hai registrato con quanto l'algoritmo si
   aspettava: dentro il mesociclo il modello prevede circa +2,5% di carico a
   settimana. La fascia di sicurezza per un singolo incremento è il 2-10%
   (raccomandazione ACSM: aumentare il carico del 2-10% quando si completano
   una o due ripetizioni oltre l'obiettivo). Oltre il 10% l'app segnala il salto,
   perché un aumento troppo brusco è la via più comune al sovraccarico dei
   tendini e alle interruzioni per dolore, specie sopra i 50 anni.
--------------------------------------------------------------------------- */
const SAFE_STEP = 0.10;          // incremento massimo consigliato per volta

/* Valore confrontabile di una registrazione: kg, gradino della scala (band o
   progressione a corpo libero), oppure niente. */
function logValue(l) {
  const ex = exById(l.exId);
  if (!ex) return null;
  const steps = ex.load === 'band' ? BANDS : levelsOf(ex);
  if (steps) { const i = steps.indexOf(l.load); return i >= 0 ? i + 1 : null; }
  const n = parseFloat(String(l.load || '').replace(',', '.'));
  return (isFinite(n) && n >= 0) ? n : null;
}

/* Valore "di merito": cresce sempre quando migliori, anche dove il numero
   annotato è un aiuto. Sugli esercizi ad assistenza il gradino viene ribaltato
   e i chilogrammi diventano il complemento rispetto all'assistenza iniziale,
   così un contrappeso che scende da 40 a 35 kg risulta un progresso e non un calo. */
const ASSIST_BASE = 80;          // riferimento fisso per rendere confrontabili le sedute
function meritValue(l) {
  const ex = exById(l.exId);
  const v = logValue(l);
  if (v === null || !ex) return v;
  if (!isAssist(ex)) return v;
  const steps = ex.load === 'band' ? BANDS : levelsOf(ex);
  if (steps) return steps.length + 1 - v;       // band più leggera = più merito
  return Math.max(1, ASSIST_BASE - v);          // meno assistenza = più merito
}

/* Volume reale: serie completate per ripetizioni effettivamente eseguite.
   Se le ripetizioni reali non sono state annotate (registrazioni vecchie) si
   ricade sul target, segnalandolo al chiamante. */
function volValue(l) {
  const reps = isFinite(l.repsDone) && l.repsDone > 0 ? l.repsDone : (l.reps || 0);
  return (l.sets || 0) * reps;
}

/* Massimale stimato con la formula di Epley: carico x (1 + ripetizioni/30).
   Serve a confrontare sedute con obiettivi diversi — 60 kg x 6 e 60 kg x 11
   sono lo stesso carico ma non lo stesso risultato. Vale solo per gli esercizi
   con un carico numerico; per le scale a gradini si usa il gradino stesso.
   La formula perde precisione oltre le 12-15 ripetizioni, quindi l'app la
   applica solo fino a 15. */
function e1rm(l) {
  const ex = exById(l.exId);
  if (!ex || ex.load !== 'weight') return null;
  // sugli esercizi assistiti il numero è un aiuto, non un carico sollevato:
  // il massimale stimato non avrebbe significato
  if (isAssist(ex)) return null;
  const w = parseFloat(String(l.load || '').replace(',', '.'));
  const r = isFinite(l.repsDone) && l.repsDone > 0 ? l.repsDone : l.reps;
  if (!isFinite(w) || w <= 0 || !isFinite(r) || r <= 0 || r > 15) return null;
  return w * (1 + r / 30);
}

/* Metrica di confronto preferita: massimale stimato se disponibile, altrimenti
   il gradino della scala, altrimenti il volume. */
function progressMetric(l) {
  const e = e1rm(l);
  if (e !== null) return { v: e, what: 'massimale stimato' };
  const ex = exById(l.exId);
  const g = meritValue(l);
  if (g !== null) return { v: g, what: isAssist(ex) ? 'assistenza' : 'gradino' };
  const vol = volValue(l);
  return vol ? { v: vol, what: 'volume' } : null;
}

/* Confronta una registrazione con la precedente dello stesso esercizio. */
function rateLog(cur, prev, deload) {
  const ex = exById(cur.exId);
  // allungamenti e mobilità non hanno un carico da confrontare: niente punteggio
  if (ex && ex.type === 'stretch') return { stars: 0, text: '' };
  if (!prev) return { stars: 0, text: 'Prima registrazione: da qui parte il confronto.' };

  // scale a gradini (band e progressioni a corpo libero): un gradino in più è
  // già la progressione prevista, due insieme sono un salto da segnalare
  const steps = ex ? (ex.load === 'band' ? BANDS : levelsOf(ex)) : null;
  if (steps) {
    const ia = steps.indexOf(cur.load), ib = steps.indexOf(prev.load);
    if (ia >= 0 && ib >= 0) {
      // sugli esercizi assistiti il verso è invertito: scendere di band è un progresso
      const step = (ia - ib) * progressDir(ex);
      const nome = ex.load === 'band' ? 'band' : 'livelli';
      if (step >= 2) return { stars: 3, warn: 'salto',
        text: `Due ${nome} più difficili in una volta sola: è un salto di carico importante.`,
        advice: 'Torna al gradino intermedio per una seduta e sali solo quando superi l\'obiettivo di due ripetizioni per due sedute.' };
      if (step === 1) return { stars: 5, text: 'Sei passato al gradino successivo: progressione riuscita.' };
      if (step === 0) {
        const va = volValue(cur), vb = volValue(prev);
        if (vb && va / vb > 1.02) return { stars: 4, text: `Stesso gradino, ${va - vb} ripetizioni in più completate.` };
        if (vb && va / vb < 0.9) return { stars: 2, text: 'Stesso gradino, ma meno ripetizioni della volta scorsa.' };
        return { stars: 3, text: 'Stesso gradino della volta scorsa: consolidamento.' };
      }
      return { stars: 1, text: 'Sei sceso a un gradino più facile rispetto alla volta scorsa.' };
    }
  }

  const ma = progressMetric(cur), mb = progressMetric(prev);
  if (!ma || !mb || !mb.v) return { stars: 0, text: 'Dati insufficienti per il confronto.' };
  const ratio = ma.v / mb.v;
  const what = ma.what === mb.what ? ma.what : 'risultato';
  const weeks = Math.max(0, Math.floor((cur.sIdx || 0) / 5) - Math.floor((prev.sIdx || 0) / 5));
  const expected = weeks > 0 ? 1 + 0.025 * weeks : 1;
  const pct = Math.round((ratio - 1) * 100);

  // il salto va misurato sul carico effettivo, non sul massimale stimato:
  // aumentare le ripetizioni non è un rischio, aumentare il peso sì.
  // Sugli esercizi assistiti il salto è una riduzione troppo brusca dell'aiuto.
  const la = logValue(cur), lb = logValue(prev);
  if (la !== null && lb) {
    const jump = isAssist(ex) ? (lb - la) / lb : (la - lb) / lb;
    // oltre il 10%, ma solo se la variazione supera anche il passo minimo
    // dell'attrezzo: altrimenti si segnalerebbe come imprudente proprio
    // l'incremento più piccolo che quella macchina consente
    const minStep = minStepFor(ex, lb);
    if (jump > SAFE_STEP && Math.abs(la - lb) > minStep + 0.001) {
      return { stars: 3, warn: 'salto',
        text: isAssist(ex)
          ? `Assistenza ridotta del ${Math.round(jump * 100)}% in una volta: oltre la fascia del 2-10% consigliata per singolo passo.`
          : `Carico aumentato del ${Math.round(jump * 100)}%: oltre la fascia del 2-10% consigliata per singolo incremento.`,
        advice: isAssist(ex)
          ? 'Togli l\'aiuto un pacco alla volta: scendere troppo in fretta fa perdere le ultime ripetizioni pulite.'
          : 'Resta su questo carico almeno una seduta e verifica che la tecnica regga: la progressione lenta è quella che dura.' };
    }
  }
  if (deload && ratio > 1.02) {
    return { stars: 3, warn: 'scarico',
      text: `Settimana di scarico: hai aumentato del ${pct}% invece di ridurre.`,
      advice: 'Lo scarico serve al recupero di tendini e articolazioni: la settimana prossima riparti più forte.' };
  }
  if (cur.rir === 0 && prev.rir === 0) {
    return { stars: 3, warn: 'cedimento',
      text: 'Seconda seduta di fila portata a zero ripetizioni di riserva su questo esercizio.',
      advice: 'Lavorare sempre al limite accumula fatica senza aggiungere stimolo: tieni 1-2 ripetizioni di margine.' };
  }
  if (ratio < 0.97) return { stars: 1, text: `Calo del ${Math.abs(pct)}% ${suRif(what)} rispetto alla volta scorsa.` };
  if (ratio < expected - 0.005) return { stars: 2, text: `Stabile: atteso circa +${Math.round((expected - 1) * 100)}% ${suRif(what)}.` };
  if (ratio <= expected + 0.02) return { stars: 3, text: `In linea con la progressione prevista (+${pct}% ${suRif(what)}).` };
  if (ratio <= 1 + SAFE_STEP / 2) return { stars: 4, text: `Sopra le attese: +${pct}% ${suRif(what)}, ne era previsto +${Math.round((expected - 1) * 100)}%.` };
  return { stars: 5, text: `Progresso netto: +${pct}% ${suRif(what)}, dentro la fascia di sicurezza.` };
}

/* Preposizione corretta davanti al nome della metrica ("sul volume", ma
   "sull'assistenza"): l'elisione va gestita, altrimenti si legge "sul assistenza". */
const suRif = w => /^[aeiou]/i.test(w) ? `sull'${w}` : `sul ${w}`;

const starsHtml = n => n ? `<span class="stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>` : '';

/* ---------------------------------------------------------------------------
   5. GENERAZIONE DELLA SESSIONE
   La sessione è deterministica: dipende solo da (indice sessione, programma,
   attrezzatura). Cambiando mesociclo la rotazione sposta la scelta nel pool,
   così gli esercizi cambiano automaticamente ogni ciclo.
--------------------------------------------------------------------------- */
/* Ordine delle 5 sedute dentro una settimana. Di base è 1..5 (forza, mobilità,
   forza, mobilità, forza); scambiando due sedute la permutazione viene salvata,
   così la seduta rinviata resta in programma e non va persa. */
function weekPerm(week) {
  return (S.perms && S.perms[week]) ? S.perms[week].slice() : [1, 2, 3, 4, 5];
}
function swapDay(posA, posB) {
  const week = Math.floor(S.sessionIndex / 5) + 1;
  const perm = weekPerm(week);
  const t = perm[posA]; perm[posA] = perm[posB]; perm[posB] = t;
  S.perms = S.perms || {};
  S.perms[week] = perm;
  planCache = null;
  save();
}

/* Nei programmi a fasi (macrociclo) ogni fase ha il proprio obiettivo e la
   propria durata; dentro la fase si lavora a blocchi di 4 settimane con la
   quarta di scarico. Restituisce la fase e la settimana al suo interno. */
function phaseOf(p, weekAbs) {
  if (!p.phases) return null;
  let acc = 0;
  for (let i = 0; i < p.phases.length; i++) {
    const ph = p.phases[i];
    if (weekAbs <= acc + ph.weeks) return { ph, index: i, weekInPhase: weekAbs - acc, start: acc };
    acc += ph.weeks;
  }
  const last = p.phases[p.phases.length - 1];       // oltre la fine: si resta sull'ultima fase
  return { ph: last, index: p.phases.length - 1, weekInPhase: ((weekAbs - acc - 1) % last.weeks) + 1, start: acc, over: true };
}
const totalWeeks = p => (p.phases ? p.phases.reduce((a, f) => a + f.weeks, 0) : 0);

/* ---------------------------------------------------------------------------
   SETTIMANE DI SOLA MOBILITÀ
   Capita di non poter andare in sala pesi per una settimana: viaggio, impegni,
   un fastidio da lasciar passare. In quel caso tutte e cinque le sedute
   diventano mobilità e stretching, e — cosa che conta di più — il macrociclo
   NON perde una settimana di lavoro: semplicemente slitta in avanti, perché
   nel conteggio delle settimane di fase quelle di sola mobilità non contano.
   Il programma di forza riprende esattamente da dove era rimasto.
--------------------------------------------------------------------------- */
const isMobilityWeek = w => Array.isArray(S.mobilityWeeks) && S.mobilityWeeks.indexOf(w) >= 0;

/* Settimane di forza effettivamente svolte fino a quella indicata (inclusa):
   è l'indice con cui si legge la fase del macrociclo. */
function trainingWeekOf(weekAbs) {
  const skipped = (S.mobilityWeeks || []).filter(w => w <= weekAbs && w !== weekAbs).length;
  return Math.max(1, weekAbs - skipped);
}

function sessionMeta(idx) {
  const p = program();
  const weekAbs = Math.floor(idx / 5) + 1;
  const dayInWeek = weekPerm(weekAbs)[idx % 5];
  const mobWeek = isMobilityWeek(weekAbs);
  // in una settimana di sola mobilità nessuna seduta è di potenziamento
  const isStrength = !mobWeek && DAYS_STRENGTH.includes(dayInWeek);
  const ph = phaseOf(p, trainingWeekOf(weekAbs));

  let weekInCycle, mesocycle, cycleLen, profile;
  if (ph) {
    cycleLen = 4;                                   // blocchi di 4 settimane dentro la fase
    weekInCycle = ph.ph.deload ? 4 : ((ph.weekInPhase - 1) % 4) + 1;   // fase di rifinitura = scarico
    mesocycle = ph.index * 3 + Math.floor((ph.weekInPhase - 1) / 4) + 1;
    profile = weekProfile(weekInCycle, cycleLen);
  } else {
    const tw = trainingWeekOf(weekAbs);
    cycleLen = p.cycleWeeks;
    weekInCycle = ((tw - 1) % cycleLen) + 1;
    mesocycle = Math.floor((tw - 1) / cycleLen) + 1;
    profile = weekProfile(weekInCycle, cycleLen);
  }
  // le cinque sedute di una settimana di mobilità alternano i due schemi,
  // con la rotazione che cambia posizione per non ripetere gli stessi esercizi
  const tmplIdx = isStrength
    ? DAYS_STRENGTH.indexOf(dayInWeek)
    : (mobWeek ? ((idx % 5) % 2) : DAYS_STRETCH.indexOf(dayInWeek));
  return { idx, dayInWeek, pos: (idx % 5) + 1, weekAbs, weekInCycle, cycleLen, mesocycle, isStrength,
           mobilityWeek: mobWeek, trainingWeek: trainingWeekOf(weekAbs),
           phase: ph, tmplIdx, profile, program: p };
}

/* Filtri di sicurezza applicati a ogni pool di esercizi.
   - ginocchio: preferisce gli esercizi a basso impatto femoro-rotuleo
   - spalla: esclude spinte sopra la testa a presa prona, aperture in massima
     estensione e trazioni a presa larga, tipiche fonti di dolore in caso di
     conflitto subacromiale e sofferenza del capo lungo del bicipite
   Se il filtro svuoterebbe il pool, si mantiene l'elenco completo. */
function applyCare(pool) {
  if (S.kneeCare) {
    const safe = pool.filter(e => e.kneeFriendly);
    if (safe.length) pool = safe;
  }
  if (S.shoulderCare) {
    const safe = pool.filter(e => !e.shoulderRisk);
    if (safe.length) pool = safe;
  }
  return pool;
}

function pickFrom(pool, rotation, used) {
  if (!pool.length) return null;
  for (let k = 0; k < pool.length; k++) {
    const cand = pool[(rotation + k) % pool.length];
    if (!used.has(cand.id)) { used.add(cand.id); return cand; }
  }
  return pool[rotation % pool.length];
}

/* ---------------------------------------------------------------------------
   BLOCCO TRAZIONI
   Tre sedute a settimana, sempre in apertura della seduta di forza (a fresco,
   come vuole l'ordine degli esercizi NSCA: il movimento obiettivo per primo).
   L'onda settimanale segue le evidenze sulla progressione alla trazione:
     giorno A → eccentriche lente (il lavoro che trasferisce di più)
     giorno B → tenute isometriche nell'angolo in cui si cede
     giorno C → volume con assistenza elastica o macchina
   Ogni blocco si apre con attivazione scapolare o sospensione, la fase che
   quasi tutti saltano e che insegna l'avvio della trazione.
   Criterio di avanzamento: quando tieni 5 secondi con il mento sopra la sbarra
   e scendi in 5 secondi controllati, prova la trazione completa; riduci la band
   (viola → rossa → gialla → azzurra) appena le ripetizioni diventano facili.
--------------------------------------------------------------------------- */
const PULL_GOALS = { activation: 'pullupActivation', eccentric: 'pullupStrength',
                     isometric: 'pullupIso', volume: 'pullupVolume', row: 'pullupVolume' };

function pullPool(role) {
  let pool = DB.exercises.filter(e => e.pattern === 'pullup' && e.setup.includes(S.setup) &&
                                      e.pullRole === role);
  if (!pool.length) {          // a casa, senza sbarra, alcuni ruoli non esistono
    pool = DB.exercises.filter(e => e.pattern === 'pullup' && e.setup.includes(S.setup) &&
                                    e.pullRole !== 'activation');
  }
  return applyCare(pool).sort((a, b) => a.id.localeCompare(b.id));
}

function buildPullBlock(meta, used) {
  const cfg = PROG.pullupBlock;
  if (!cfg || !S.pullupGoal) return [];
  const roles = cfg.days[meta.tmplIdx % cfg.days.length];
  const items = [];
  roles.forEach((role, i) => {
    const pool = pullPool(role);
    const ex = pickFrom(pool, (meta.mesocycle - 1) + i, used);
    if (!ex) return;
    const goalKey = PULL_GOALS[ex.pullRole] || PULL_GOALS[role];
    items.push({ exId: ex.id, note: 'Obiettivo trazioni', goalKey, block: 'pullup',
                 alt: { patterns: ['pullup'], types: ['strength'], roles: [role] },
                 ...dose(goalKey, meta.profile, ex) });
  });
  return items;
}

function buildStrength(meta) {
  const tmpl = meta.program.strengthDays[meta.tmplIdx];
  const used = new Set(), items = [];
  // il blocco trazioni apre la seduta e non viene mai tagliato dal budget tempo
  buildPullBlock(meta, used).forEach(it => items.push(it));
  tmpl.slots.forEach((slot, i) => {
    // Il pool si costruisce pattern per pattern: così il filtro "ginocchio" non
    // cancella un intero schema di movimento (es. gli affondi) lasciando in piedi
    // solo un altro pattern dello stesso slot.
    let pool = [];
    slot.patterns.forEach(pat => {
      let sub = DB.exercises.filter(e => e.setup.includes(S.setup) &&
        (e.type === 'strength' || e.type === 'core') && e.pattern === pat);
      sub = applyCare(sub);
      pool = pool.concat(sub.sort((a, b) => a.id.localeCompare(b.id)));
    });
    const rot = (meta.mesocycle - 1) * (meta.tmplIdx + 2) + i;   // rotazione per mesociclo
    const ex = pickFrom(pool, rot, used);
    if (!ex) return;
    // nei programmi a fasi l'obiettivo del giorno lo decide la fase in corso
    const dayGoal = (meta.phase && meta.phase.ph.goals && meta.phase.ph.goals[meta.tmplIdx]) || tmpl.goal;
    const goalKey = slot.goal || dayGoal;
    items.push({ exId: ex.id, note: slot.note || '', goalKey,
                 alt: { patterns: slot.patterns.slice(), types: ['strength', 'core'] },
                 ...dose(goalKey, meta.profile, ex) });
  });
  const gLabel = meta.phase && PROG.goals[(meta.phase.ph.goals || [])[meta.tmplIdx]]
    ? PROG.goals[meta.phase.ph.goals[meta.tmplIdx]].label : '';
  return { label: tmpl.label, type: 'strength', items, dayGoalLabel: gLabel };
}

function buildStretch(meta) {
  const tmpl = meta.program.stretchDays[meta.tmplIdx];
  const used = new Set(), items = [];
  const dyn = DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'mobility' && e.setup.includes(S.setup));
  const stat = DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'static' && e.setup.includes(S.setup)
                                        && tmpl.staticGroups.includes(e.group));
  dyn.sort((a, b) => a.id.localeCompare(b.id));
  stat.sort((a, b) => a.id.localeCompare(b.id));
  let rot = (meta.mesocycle - 1) * 2 + meta.tmplIdx + (meta.weekInCycle - 1);
  // in una settimana di sola mobilità le sedute sono cinque: la rotazione
  // scorre a ogni seduta, così non si ripetono gli stessi allungamenti
  if (meta.mobilityWeek) rot += (meta.idx % 5) * 2;
  for (let i = 0; i < tmpl.dynamic; i++) {
    const ex = pickFrom(dyn, rot + i, used);
    if (ex) items.push({ exId: ex.id, note: 'Riscaldamento', goalKey: 'mobility',
                         alt: { patterns: ['mobility'], types: ['stretch'] },
                         ...dose('mobility', meta.profile, ex) });
  }
  for (let i = 0; i < tmpl.count; i++) {
    const ex = pickFrom(stat, rot + i, used);
    if (ex) items.push({ exId: ex.id, note: '', goalKey: 'stretch',
                         alt: { patterns: ['static'], types: ['stretch'], groups: tmpl.staticGroups.slice() },
                         ...dose('stretch', meta.profile, ex) });
  }
  const label = meta.mobilityWeek ? `${tmpl.label} · seduta ${meta.pos} di 5` : tmpl.label;
  return { label, type: 'stretch', items };
}

function buildCore(meta) {
  const cfg = PROG.coreSession;
  const pool = DB.exercises.filter(e => e.type === 'core' && e.setup.includes(S.setup))
                           .sort((a, b) => a.id.localeCompare(b.id));
  const used = new Set(), items = [];
  for (let i = 0; i < cfg.count; i++) {
    const ex = pickFrom(pool, (meta.idx + i), used);
    if (ex) items.push({ exId: ex.id, note: '', goalKey: cfg.goal,
                         alt: { patterns: ['coreAnti', 'coreFlex'], types: ['core'] },
                         ...dose(cfg.goal, meta.profile, ex) });
  }
  return { label: cfg.label, type: 'core', items };
}

function buildSession(idx, kind) {
  const meta = sessionMeta(idx);
  const body = kind === 'core' ? buildCore(meta) : (meta.isStrength ? buildStrength(meta) : buildStretch(meta));
  // budget tempo: 35 minuti per le sedute complete (tetto operativo 38), 14 per il core
  const pullCount = body.items.filter(it => it.block === 'pullup').length;
  const trimmed = fitToTime(body.items, kind === 'core' ? 14 : 35, Math.max(1, pullCount));
  const minutes = estimateMinutes(body.items);
  return Object.assign({}, meta, body, { minutes, trimmed, kind: kind || (meta.isStrength ? 'strength' : 'stretch') });
}

/* Stima del tempo: lavoro + recuperi. Gli allungamenti statici si contano su
   entrambi i lati, gli esercizi a tempo usano la durata della tenuta. */
function estimateMinutes(items) {
  let sec = 120; // preparazione e transizioni iniziali
  items.forEach(it => {
    let work;
    if (it.goal === 'stretch') work = it.hold;
    else if (it.hold) work = it.hold;
    else {
      const ex = exById(it.exId);
      work = (ex && ex.load === 'time') ? 20 + it.reps : it.reps * 3.5;
    }
    sec += it.sets * (work + it.rest);
  });
  // fattore di calibrazione appreso dalle sedute reali (vedi calibratePace)
  const f = (S && isFinite(S.paceFactor) && S.paceFactor > 0) ? S.paceFactor : 1;
  return Math.round(sec * f / 60);
}

/* ---------------------------------------------------------------------------
   CALIBRAZIONE DELLA DURATA
   La stima parte da 3,5 secondi per ripetizione, un valore fisso che ignora i
   tempi di transizione fra le macchine. A fine seduta si confrontano i minuti
   stimati con quelli reali e si corregge il coefficiente con una media mobile
   lenta, così il vincolo dei 35 minuti lavora su un numero vero.
   Le sedute interrotte a metà e i valori anomali non entrano nella media.
--------------------------------------------------------------------------- */
function calibratePace(sess, realMinutes) {
  if (!sess || !realMinutes || realMinutes < 5 || realMinutes > 120) return;
  if (sess.kind === 'core') return;
  const base = estimateMinutes(sess.items) / (S.paceFactor || 1);   // stima grezza
  if (!base) return;
  const observed = realMinutes / base;
  if (observed < 0.5 || observed > 2.5) return;                     // valore anomalo
  const prev = isFinite(S.paceFactor) && S.paceFactor > 0 ? S.paceFactor : 1;
  S.paceFactor = Math.max(0.7, Math.min(1.8, prev * 0.8 + observed * 0.2));
  planCache = null;
}

/* Vincolo dei 30 minuti: se la seduta è troppo lunga si riduce prima il volume
   degli esercizi accessori (mai il primo, che è il movimento principale) e solo
   in ultima istanza si toglie l'ultimo esercizio. */
function fitToTime(items, maxMin, protect) {
  const keep = Math.max(1, protect || 1);       // esercizi intoccabili in apertura
  let trimmed = false, guard = 0;
  while (estimateMinutes(items) > maxMin && guard++ < 40) {
    let i = -1;
    for (let k = items.length - 1; k >= keep; k--) if (items[k].sets > 2) { i = k; break; }
    if (i >= 0) { items[i].sets -= items[i].perSide ? 2 : 1; trimmed = true; continue; }
    if (items.length > keep + 3) { items.pop(); trimmed = true; continue; }
    break;
  }
  return trimmed;
}

/* ---------------------------------------------------------------------------
   6. VISTE
--------------------------------------------------------------------------- */
const $ = sel => document.querySelector(sel);
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function go(view) {
  // uscendo dalla schermata della sessione il timer NON si ferma: si riduce da
  // solo alla barretta in basso e continua a scorrere mentre navighi
  if (timerRunning() && view !== 'session' && $('#timer').classList.contains('on')) minimizeTimer();
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.go === view));
  // la barra comandi fissa appartiene alla sola schermata della sessione
  document.body.classList.toggle('in-session', view === 'session');
  if (view !== 'session') $('#actionBar').classList.remove('on');
  window.scrollTo(0, 0);
  if (view === 'home') renderHome();
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  if (view === 'catalog') renderCatalog();
}

function doseText(it) {
  const side = it.perSide ? ` (${it.sets / 2} per lato)` : '';
  if (it.goal === 'stretch') return `${it.sets}× ${it.hold}s${side}`;
  if (it.goal === 'mobility') return `${it.sets}× ${it.reps}${side}`;
  const ex = exById(it.exId);
  if (ex && ex.load === 'time') return `${it.sets}× ${it.hold || (20 + it.reps)}s${side}`;
  return `${it.sets}× ${it.reps}${side}`;
}

/* --- SOSTITUZIONE DI UN ESERCIZIO -------------------------------------------
   Le alternative rispettano lo stesso schema di movimento (o lo stesso gruppo,
   per lo stretching), l'attrezzatura scelta e il filtro ginocchio: l'esercizio
   sostitutivo resta quindi coerente con l'obiettivo della seduta. */
function alternativesFor(item, sess) {
  const alt = item.alt || {};
  const inUse = new Set((sess ? sess.items : []).map(i => i.exId));
  let pool = DB.exercises.filter(e =>
    e.setup.includes(S.setup) &&
    (alt.types || ['strength']).includes(e.type) &&
    (alt.patterns || []).includes(e.pattern) &&
    (!alt.groups || alt.groups.includes(e.group)) &&
    (!alt.roles || alt.roles.includes(e.pullRole)));
  if (alt.roles && pool.length < 2) {
    pool = DB.exercises.filter(e => e.setup.includes(S.setup) && e.pattern === 'pullup');
  }
  pool = applyCare(pool);
  pool.sort((a, b) => a.id.localeCompare(b.id));
  return pool.filter(e => e.id === item.exId || !inUse.has(e.id));
}

/* Mette un esercizio preciso nello slot, ricalcolando la dose su di esso. */
function applyExercise(item, sess, ex) {
  if (!ex || ex.id === item.exId) return false;
  const d = dose(item.goalKey || item.goal, sess.profile, ex);
  item.exId = ex.id;
  item.sets = d.sets; item.reps = d.reps; item.rest = d.rest;
  item.hold = d.hold; item.perSide = d.perSide; item.source = d.source;
  return true;
}

/* Quanto un esercizio è pertinente come sostituto di quello in programma:
   conta lo schema di movimento, il ruolo nel blocco trazioni, il gruppo, i
   muscoli primari condivisi e il tipo di carico. Serve solo a ordinare la
   lista, la scelta resta all'utente. */
function relevance(ex, cur, item) {
  if (!cur) return 0;
  let n = 0;
  if (ex.pattern === cur.pattern) n += 6;
  else if ((item.alt && item.alt.patterns || []).includes(ex.pattern)) n += 4;
  if (ex.pullRole && ex.pullRole === cur.pullRole) n += 3;
  if (ex.group === cur.group) n += 3;
  const prim = new Set(cur.primary || []);
  (ex.primary || []).forEach(m => { if (prim.has(m)) n += 2; });
  (ex.secondary || []).forEach(m => { if (prim.has(m)) n += 1; });
  if (ex.load === cur.load) n += 1;
  if (ex.type === cur.type) n += 1;
  return n;
}

function whyLabel(ex, cur, item) {
  if (!cur) return '';
  if (ex.id === cur.id) return 'in programma';
  if (ex.pattern === cur.pattern) return 'stesso schema di movimento';
  if (ex.group === cur.group) return 'stesso gruppo muscolare';
  const prim = new Set(cur.primary || []);
  if ((ex.primary || []).some(m => prim.has(m))) return 'stesso muscolo principale';
  return 'alternativa possibile';
}

/* Pagina di scelta: elenco ordinato per pertinenza, con la possibilità di
   tenere l'esercizio originale. */
function openExercisePicker(item, sess, after, opts) {
  const o = opts || {};
  const cur = exById(item.exId);
  let pool = o.pool || alternativesFor(item, sess);
  if (!pool.some(e => e.id === item.exId) && cur) pool = [cur].concat(pool);
  pool = pool.slice().sort((a, b) => relevance(b, cur, item) - relevance(a, cur, item) ||
                                     a.name.localeCompare(b.name));

  const rows = pool.map(ex => {
    const isCur = ex.id === item.exId;
    return `<li class="${isCur ? 'cur' : ''}" data-pickex="${ex.id}">
      <div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm"><b>${esc(ex.name)}</b>
        <div class="small muted">${esc(ex.group)} · ${esc(ex.equipment.join(', ') || 'corpo libero')}</div>
        <div class="why">${esc(whyLabel(ex, cur, item))}</div></div>
      <button class="pick">${isCur ? 'Mantieni' : 'Scegli'}</button></li>`;
  }).join('');

  openModal(`<h2>${esc(o.title || 'Sostituisci esercizio')}</h2>
    <p class="small muted">${esc(o.subtitle || 'In ordine di pertinenza rispetto a “' + (cur ? cur.name : '') + '”. Puoi anche tenere quello previsto dal programma.')}</p>
    <ul class="picker">${rows || '<li><span class="small muted">Nessuna alternativa disponibile con l\'attrezzatura selezionata.</span></li>'}</ul>
    <button class="btn ghost" id="pickKeep" style="margin-top:14px">Indietro</button>`);

  document.querySelectorAll('[data-pickex]').forEach(li => li.onclick = () => {
    const ex = exById(li.dataset.pickex);
    const changed = applyExercise(item, sess, ex);
    closeModal(() => { if (after) after(changed); });
  });
  // "Indietro" chiude il pannello e riporta alla pagina sottostante senza modifiche
  $('#pickKeep').onclick = () => closeModal();
}

/* Elenco degli esercizi che coinvolgono un gruppo muscolare, richiamato
   toccando una delle etichette nella scheda esercizio. */
function openMusclePicker(muscle, item, sess, after) {
  let pool = DB.exercises.filter(e => e.setup.includes(S.setup) &&
    ((e.primary || []).includes(muscle) || (e.secondary || []).includes(muscle)));
  pool = applyCare(pool);
  if (!item || !sess) {
    const rows = pool.sort((a, b) => a.name.localeCompare(b.name)).map(ex => `<li>
      <div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm"><b>${esc(ex.name)}</b><div class="small muted">${esc(ex.group)}</div></div></li>`).join('');
    openModal(`<h2>${esc(muscle)}</h2>
      <p class="small muted">Esercizi disponibili con l'attrezzatura selezionata.</p>
      <ul class="picker">${rows}</ul>
      <button class="btn secondary" id="mpClose" style="margin-top:14px">Chiudi</button>`);
    $('#mpClose').onclick = closeModal;
    return;
  }
  openExercisePicker(item, sess, after, {
    pool,
    title: muscle,
    subtitle: `Esercizi che coinvolgono questo muscolo, in ordine di pertinenza rispetto a quello in programma. Tocca “Scegli” per sostituirlo, oppure tieni quello previsto.`
  });
}

/* La seduta del giorno viene generata una volta sola e tenuta in memoria: così
   le sostituzioni fatte dalla home restano valide quando si preme "Inizia". */
function weeksLeftText(p, weekAbs) {
  const tot = totalWeeks(p);
  if (!tot) return '';
  const left = tot - weekAbs;
  if (left > 0) return `, ${left} alla chiusura del 30 maggio 2027`;
  return ', ultima settimana del programma';
}

function todaySession(kind) {
  const key = `${S.programId}|${S.setup}|${S.sessionIndex}|${kind || ''}`;
  if (!planCache || planCache.key !== key) planCache = { key, sess: buildSession(S.sessionIndex, kind) };
  return planCache.sess;
}

function renderHome() {
  const p = program();
  const here = S.sessionIndex % 5;                 // posizione prevista dal programma
  const weekStart = S.sessionIndex - here;
  const core = homeSel === 'core';
  const s = todaySession(core ? 'core' : null);

  $('#topTitle').textContent = 'Oggi';
  $('#topChip').textContent = `Sett. ${s.weekInCycle}/${p.cycleWeeks} · ciclo ${s.mesocycle}`;
  $('#topChip').className = 'chip ' + (s.isStrength && !core ? 'strength' : 'mobility');

  // --- calendario della settimana: le 5 sedute previste, più il blocco core ---
  let week = '';
  for (let q = 0; q < 5; q++) {
    const alt = buildSession(weekStart + q);
    // "da programma" resta attaccata alla seduta che il programma prevede come
    // prossima (il suo giorno di calendario), anche dopo uno scambio di ordine;
    // la posizione scelta per oggi è marcata a parte come "scelta per oggi".
    const isPlanned = alt.dayInWeek === here + 1;
    const state = q < here ? 'done' : (q === here ? 'now' : 'next');
    const badge = q < here ? '<span class="wkbadge done">svolta</span>'
                : isPlanned ? '<span class="wkbadge">da programma</span>'
                : q === here ? '<span class="wkbadge alt">scelta per oggi</span>'
                : '<span class="chev">›</span>';
    week += `<li class="wk ${state}${(!core && q === here) ? ' sel' : ''}" data-day="${q}">
      <span class="wknum ${alt.isStrength ? 'strength' : 'mobility'}">${q + 1}</span>
      <div class="nm"><b>${esc(alt.label)}</b>
        <div class="small muted">${alt.isStrength ? 'potenziamento' : 'mobilità'} · ${alt.minutes} min${alt.items.some(i => i.block === 'pullup') ? ' · trazioni' : ''}</div></div>
      ${badge}</li>`;
  }
  const coreS = buildSession(S.sessionIndex, 'core');
  week += `<li class="wk next${core ? ' sel' : ''}" data-core="1">
      <span class="wknum core">+</span>
      <div class="nm"><b>Solo blocco core</b>
        <div class="small muted">facoltativo · ${coreS.minutes} min</div></div>
      <span class="chev">›</span></li>`;

  // --- elenco esercizi della seduta selezionata ---
  const rows = s.items.map((it, i) => {
    const ex = exById(it.exId);
    return `<li data-plan="${i}" class="${it.block === 'pullup' ? 'pullrow' : ''}"><div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm"><b>${esc(ex.name)}</b><span class="small muted">${esc(ex.group)}${it.note ? ' · ' + esc(it.note) : ''}</span></div>
      <div class="dose">${doseText(it)}</div><div class="chev">›</div></li>`;
  }).join('');

  // promemoria di backup: compare se ci sono dati non ancora salvati da almeno
  // 7 giorni, o se non è mai stato fatto un export pur avendo dello storico
  const daysSince = S.lastExport ? (Date.now() - S.lastExport) / 86400000 : Infinity;
  const backupNag = (S.logs.length > 0 && daysSince > 7)
    ? `<div class="notice" style="margin-top:14px;display:flex;align-items:center;gap:12px">
         <span style="flex:1">${S.lastExport ? 'Backup non aggiornato da un po\'' : 'Non hai ancora un backup'}: se rimuovi l'app dalla Home, i dati si perdono.</span>
         <button class="btn secondary" id="nagExport" style="width:auto;min-height:44px;font-size:15px">Esporta ora</button>
       </div>` : '';

  // banner di ripresa se una sessione è rimasta aperta
  // seduta in corso in memoria, oppure interrotta e salvata su disco
  const saved = (!current || current.finished) ? resumableSession() : null;
  const resume = (current && !current.finished)
    ? `<div class="notice" style="margin-top:14px;display:flex;align-items:center;gap:12px">
         <span style="flex:1">Sessione in corso: ${esc(current.sess.label)}</span>
         <button class="btn" id="resumeBtn" style="width:auto;min-height:44px;font-size:17px">Riprendi</button>
       </div>`
    : saved
    ? `<div class="notice" style="margin-top:14px;display:flex;align-items:center;gap:12px">
         <span style="flex:1">Seduta lasciata a metà: ${esc(saved.label)}, esercizio ${saved.pos + 1} di ${saved.items.length}
           (${new Date(saved.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}).</span>
         <button class="btn" id="restoreBtn" style="width:auto;min-height:44px;font-size:17px">Riprendi</button>
       </div>
       <button class="btn ghost" id="dropResume" style="margin-top:8px">Scarta la seduta interrotta</button>` : '';

  $('#view-home').innerHTML = `
    ${resume}
    ${resume ? '' : backupNag}
    <div class="seg" role="group" aria-label="Attrezzatura">
      <button data-setup="gym" aria-pressed="${S.setup === 'gym'}">Palestra</button>
      <button data-setup="home" aria-pressed="${S.setup === 'home'}">Casa</button>
    </div>

    <div class="card">
      <div class="kicker" style="font-family:var(--cond);letter-spacing:.06em;text-transform:uppercase;font-size:13px;color:var(--muted)">
        ${s.mobilityWeek ? 'Settimana di sola mobilità'
          : s.phase ? `Fase ${s.phase.index + 1} di ${p.phases.length} · ${esc(s.phase.ph.name)}`
                    : `Settimana ${s.weekInCycle} di ${p.cycleWeeks} · ${esc(p.name)}`}</div>
      <h2 style="margin-top:2px">La tua settimana</h2>
      ${s.mobilityWeek
        ? `<p class="small muted" style="margin:6px 0 0">Tutte e cinque le sedute sono di mobilità e stretching. Il programma di forza riprende la settimana ${s.weekAbs + 1} da dove era rimasto: nessuna settimana di lavoro va persa.</p>`
        : s.phase ? `<p class="small muted" style="margin:6px 0 0">Settimana ${s.phase.weekInPhase} di ${s.phase.ph.weeks} della fase, ${s.trainingWeek} di ${totalWeeks(p)} del programma${weeksLeftText(p, s.trainingWeek)}. ${esc(s.phase.ph.aim)}</p>` : ''}
      <ul class="week">${week}</ul>
      <p class="small muted" style="margin-top:10px">Tocca la seduta che vuoi fare adesso: quella prevista oggi prenderà il suo posto più avanti nella settimana.</p>
    </div>

    <div class="card">
      <div class="session-head ${(s.isStrength && !core) ? '' : 'mobility'}">
        <div>
          <div class="kicker">${core ? 'Blocco core facoltativo' : `Sessione ${s.pos} di 5 · ${s.isStrength ? 'potenziamento' : 'mobilità'}`}</div>
          <h2>${esc(s.label)}</h2>
          <p class="small muted" style="margin:6px 0 0">${core ? 'Blocco breve da aggiungere quando hai tempo: non avanza la settimana del programma.'
                 : esc(s.isStrength ? s.profile.note : mobilityNote(s.profile, s.mobilityWeek))} Durata stimata ${s.minutes} minuti.${s.trimmed ? ' Volume adattato per restare nei 30 minuti.' : ''}</p>
        </div>
      </div>
      <ul class="plan">${rows}</ul>
      <p class="small muted" style="margin-top:10px">Tocca un esercizio per aprire la scheda con esecuzione, muscoli coinvolti ed errori da evitare.</p>
    </div>

    <button class="btn ${(s.isStrength && !core) ? '' : 'teal'}" id="startBtn">${core ? 'Inizia il blocco core' : 'Inizia la sessione'}</button>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn ghost" id="freeBtn">Seduta libera</button>
      <button class="btn ghost" id="skipBtn">Salta a domani</button>
    </div>
    <p class="small muted" style="margin-top:16px">Programma attivo: ${esc(p.name)} · ${esc(p.periodization)}.</p>
  `;

  document.querySelectorAll('[data-setup]').forEach(b => b.onclick = () => {
    if (current && !current.finished) return;   // non cambiare attrezzatura a sessione aperta
    S.setup = b.dataset.setup; save(); renderHome();
  });

  // selezione della seduta dal calendario settimanale
  document.querySelectorAll('[data-day]').forEach(li => li.onclick = () => {
    const q = +li.dataset.day;
    if (q < here) return;                       // le sedute già svolte non si riaprono
    homeSel = 'session';
    if (q > here) swapDay(here, q);             // la scelta diventa la seduta di oggi
    planCache = null;
    renderHome();
  });
  const coreLi = document.querySelector('[data-core]');
  if (coreLi) coreLi.onclick = () => { homeSel = 'core'; planCache = null; renderHome(); };

  // ogni riga dell'elenco apre la scheda illustrativa dell'esercizio
  document.querySelectorAll('[data-plan]').forEach(li => li.onclick = () => {
    const it = s.items[+li.dataset.plan];
    openSheet(exById(it.exId), it, { sess: s, after: () => renderHome() });
  });
  if ($('#resumeBtn')) $('#resumeBtn').onclick = () => { go('session'); renderSession(); };
  if ($('#restoreBtn')) $('#restoreBtn').onclick = () => restoreSession(saved);
  if ($('#dropResume')) $('#dropResume').onclick = () => confirmAction('Scartare la seduta interrotta?',
    'Gli esercizi già conclusi restano nello storico; i dati non ancora registrati vengono persi.',
    'Scarta', () => { clearResume(); renderHome(); });
  if ($('#nagExport')) $('#nagExport').onclick = exportData;

  const begin = kind => {
    if (current && !current.finished) {
      confirmAction('Sessione già in corso', 'Vuoi abbandonarla e iniziarne una nuova? Gli esercizi già conclusi restano nello storico.',
        'Inizia una nuova sessione', () => startSession(todaySession(kind)));
    } else startSession(todaySession(kind));
  };
  $('#startBtn').onclick = () => begin(core ? 'core' : null);
  $('#freeBtn').onclick = () => {
    if (current && !current.finished) {
      confirmAction('Sessione già in corso', 'Vuoi abbandonarla e iniziare una seduta libera? Gli esercizi già conclusi restano nello storico.',
        'Inizia la seduta libera', openFreeSession);
    } else openFreeSession();
  };
  $('#skipBtn').onclick = () => confirmAction('Saltare la seduta di oggi?',
    'Passerai alla sessione successiva del programma senza registrare questa.',
    'Salta', () => { S.sessionIndex++; planCache = null; homeSel = 'session'; save(); renderHome(); });
}

/* ---------- sessione in corso ---------- */
/* Testo di aiuto della scala RIR (ripetizioni in riserva). */
const RIR_HINT = {
  '-1': 'tocca un numero a fine serie',
  0: 'al limite, nessuna in riserva',
  1: 'una in riserva: intensità alta',
  2: 'due in riserva: la fascia ideale',
  3: 'tre o più: c\'era margine'
};

function startSession(sess) {
  current = { sess, pos: 0, setsDone: sess.items.map(() => 0), loads: sess.items.map(() => ''),
              feedback: sess.items.map(() => null), logRef: sess.items.map(() => null),
              repsDone: sess.items.map(() => null), rir: sess.items.map(() => null),
              started: Date.now() };
  requestWakeLock();
  unlockAudio();
  prewarmBells(sess.items);        // tracce audio pronte prima della prima serie
  saveResume();
  go('session');
  renderSession();
}

function renderSession() {
  const c = current, s = c.sess, it = s.items[c.pos], ex = exById(it.exId);
  const sug = suggestLoad(ex);
  $('#topTitle').textContent = s.type === 'stretch' ? 'Mobilità' : 'Sessione';
  $('#topChip').textContent = `${c.pos + 1}/${s.items.length}`;
  $('#topChip').className = 'chip ' + (s.type === 'stretch' ? 'mobility' : 'strength');

  const bars = s.items.map((_, i) =>
    `<span class="${i < c.pos ? 'done' : (i === c.pos ? 'now' : '')}"></span>`).join('');

  const setBtns = Array.from({ length: it.sets }, (_, i) =>
    `<button data-set="${i}" class="${i < c.setsDone[c.pos] ? 'done' : ''}">${setLabel(it, i)}</button>`).join('');

  // --- carico: numerico, band o gradino della progressione a corpo libero ---
  const steps = ex.load === 'band' ? BANDS : levelsOf(ex);
  const curLoad = c.loads[c.pos] || (sug && sug.value) || '';
  let loadCtl;
  if (steps) {
    loadCtl = `<select id="loadIn" aria-label="Livello">${steps.map(b =>
      `<option ${curLoad === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>`;
  } else if (ex.load === 'weight') {
    // fra i carichi che l'attrezzo permette davvero: niente valori impossibili
    const scale = rackOf(ex);
    if (scale) {
      const cur = curLoad === '' ? '' : String(snapLoad(ex, parseFloat(String(curLoad).replace(',', '.')), 0));
      const opts = scale.map(v => `<option value="${v}" ${String(v) === cur ? 'selected' : ''}>${String(v).replace('.', ',')} kg</option>`).join('');
      loadCtl = `<select id="loadIn" aria-label="${isAssist(ex) ? 'Assistenza in chilogrammi' : 'Carico in chilogrammi'}">
        <option value="" ${cur === '' ? 'selected' : ''}>— ${isAssist(ex) ? 'aiuto' : 'carico'} —</option>${opts}</select>`;
    } else {
      loadCtl = `<input id="loadIn" type="number" inputmode="decimal" step="0.5" placeholder="kg"
                   aria-label="Carico in chilogrammi" value="${esc(curLoad)}">`;
    }
  } else {
    loadCtl = `<input id="loadIn" type="text" placeholder="nota sul carico" aria-label="Carico"
                 value="${esc(c.loads[c.pos] || '')}">`;
  }

  const nAlt = alternativesFor(it, s).length;
  // mobilità e allungamenti: nessun carico da annotare, niente frecce né RIR
  const noLoad = ex.type === 'stretch';

  // esercizi a tempo: stretching statico, plank, wall sit, tenute isometriche
  const timed = isTimedItem(it, ex);
  const hold = holdOf(it, ex);

  // --- ripetizioni davvero eseguite nell'ultima serie (proposta 1) ---
  const repsVal = (c.repsDone[c.pos] === null || c.repsDone[c.pos] === undefined)
    ? it.reps : c.repsDone[c.pos];
  const repsCtl = (timed || ex.type === 'stretch') ? '' : `
    <div class="repsrow">
      <span class="lab">Ripetizioni ultima serie</span>
      <div class="stepper">
        <button data-rep="-1" aria-label="Una ripetizione in meno">−</button>
        <b class="num" id="repsVal">${repsVal}</b>
        <button data-rep="1" aria-label="Una ripetizione in più">+</button>
      </div>
      <span class="small muted">obiettivo ${it.reps}</span>
    </div>`;

  // --- ripetizioni in riserva (proposta 3) ---
  const rirVal = c.rir[c.pos];
  const rirCtl = `
    <div class="rirrow">
      <span class="lab">Quante ne avresti fatte ancora?</span>
      <div class="rirbtns" role="group" aria-label="Ripetizioni di riserva">
        ${[0, 1, 2, 3].map(v => `<button data-rir="${v}" aria-pressed="${rirVal === v}">${v === 3 ? '3+' : v}</button>`).join('')}
      </div>
      <span class="small muted">${RIR_HINT[rirVal === undefined || rirVal === null ? -1 : rirVal]}</span>
    </div>`;

  // --- storico e suggerimento ---
  let lastTxt;
  if (sug && sug.last) {
    const l = sug.last;
    const det = [];
    if (isFinite(l.repsDone)) det.push(`${l.sets}×${l.repsDone}`);
    if (isFinite(l.rir)) det.push(`RIR ${l.rir}`);
    const e = e1rm(l);
    if (e) det.push(`max stimato ${e.toFixed(1)} kg`);
    lastTxt = `Ultima volta: <b>${esc(l.load || '—')}</b>${det.length ? ' · ' + det.join(' · ') : ''} · ${new Date(l.ts).toLocaleDateString('it-IT')} ${starsHtml(l.stars)}`;
    if (sug.reason) lastTxt += `<br><span class="small">${esc(sug.reason)}</span>`;
  } else {
    lastTxt = 'Prima volta con questo esercizio: parti prudente e annota carico e ripetizioni.';
  }

  // avviso immediato se il passo rispetto alla volta scorsa è troppo ampio
  // (più carico, oppure meno assistenza di quanto sia prudente)
  let jump = '';
  if (sug && sug.last) {
    const prevV = logValue(sug.last);
    const nowV = logValue({ exId: it.exId, load: c.loads[c.pos] });
    if (prevV && nowV !== null) {
      const d = isAssist(ex) ? (prevV - nowV) / prevV : (nowV - prevV) / prevV;
      // un solo passo dell'attrezzo non è mai un salto, qualunque percentuale sia
      if (d > SAFE_STEP && Math.abs(nowV - prevV) > minStepFor(ex, prevV) + 0.001) {
        jump = isAssist(ex)
          ? `<div class="warnbox">Stai togliendo il ${Math.round(d * 100)}% dell'assistenza rispetto alla volta scorsa. Meglio un pacco pesi alla volta: le linee guida indicano passi del 2-10%, e qui il rischio è perdere le ultime ripetizioni pulite.</div>`
          : `<div class="warnbox">Stai salendo del ${Math.round(d * 100)}% rispetto alla volta scorsa. Le linee guida suggeriscono incrementi del 2-10% per volta: valuta un passo più piccolo, soprattutto se la tecnica peggiora nelle ultime ripetizioni.</div>`;
      }
    }
  }

  const nota = S.exNotes[it.exId] || '';

  $('#view-session').innerHTML = `
    <div class="progress">${bars}</div>
    <div class="exercise">
      <div class="fig-large">${figureA11y(ex, 1)}</div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-top:14px">
        <div><h2>${esc(ex.name)}</h2>
          <div class="small muted">${esc(ex.group)} · ${esc(it.goalLabel)} · RPE ${esc(it.rpe)}</div></div>
        <div class="dose-big num">${doseText(it)}<br><small>rec. ${it.rest}s</small></div>
      </div>

      ${nota ? `<div class="exnote" id="noteShow">📌 ${esc(nota)}</div>` : ''}

      <div class="setdots">${setBtns}</div>

      ${noLoad ? '' : `
      ${isAssist(ex) ? `<div class="assistnote">Il numero è <b>l'aiuto</b>, non il peso sollevato: più è basso, più sei forte. Progredire significa ridurlo.</div>` : ''}
      ${rackNote(ex) ? `<p class="small muted" style="margin-top:10px">${esc(rackNote(ex))}</p>` : ''}
      <div class="loadrow">
        ${loadCtl}
        <div class="feedback">
          <button data-fb="up"   aria-pressed="${c.feedback[c.pos] === 'up'}" aria-label="Più facile del previsto${isAssist(ex) ? ': la prossima volta meno assistenza' : ''}">↑</button>
          <button data-fb="same" aria-pressed="${c.feedback[c.pos] === 'same'}" aria-label="Invariato">–</button>
          <button data-fb="down" aria-pressed="${c.feedback[c.pos] === 'down'}" aria-label="Più difficile del previsto">↓</button>
        </div>
      </div>
      ${repsCtl}
      ${rirCtl}
      <p class="lasttime">${lastTxt}</p>
      ${jump}`}

      ${timerRunning() && !chainHasWork() ? `<p class="small muted" style="margin-top:14px">Recupero in corso: il pulsante si riattiva allo scadere. Intanto puoi aprire la scheda dell'esercizio; «Salta» sulla barretta lo chiude in anticipo.</p>` : ''}
      ${chainHasWork() ? `<p class="small muted" style="margin-top:14px">Sequenza in corso: il timer avanza da solo fra tenute e pause e conta le serie.</p>` : ''}
      ${timed && !chainHasWork() && c.setsDone[c.pos] < it.sets ? `<p class="small muted" style="margin-top:14px">${
        it.sets - c.setsDone[c.pos] > 1
          ? `Un solo tocco avvia tutta la sequenza: 3 secondi di preparazione, poi ${it.sets - c.setsDone[c.pos]} tenute da ${hold} secondi con ${it.rest} secondi di pausa fra una e l'altra${c.pos < s.items.length - 1 ? ', infine il recupero prima dell\'esercizio successivo' : ''}. Il timer avanza da solo: rintocchi nei 3 secondi prima di ogni tenuta, un colpo acuto quando la tenuta finisce.`
          : `3 secondi di preparazione, poi una tenuta da ${hold} secondi. Rintocchi nei 3 secondi prima dell'inizio, un colpo acuto alla fine.`
        }${it.perSide ? ' Le tenute alternano sinistra e destra.' : ''}</p>` : ''}

      <div class="btn-row" style="margin-top:14px">
        <button class="btn ghost" id="infoBtn">Scheda esercizio</button>
        <button class="btn ghost" id="swapBtn">Cambia esercizio${nAlt > 1 ? ` (${nAlt - 1})` : ''}</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="noteBtn">${nota ? 'Modifica nota' : 'Aggiungi nota'}</button>
        <button class="btn ghost" id="orderBtn" ${c.pos === s.items.length - 1 ? 'disabled' : ''}>Ordine esercizi</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="postponeBtn" ${c.pos === s.items.length - 1 ? 'disabled' : ''}>Rimanda a dopo</button>
        <button class="btn ghost" id="prevBtn" ${c.pos === 0 ? 'disabled' : ''}>‹ Precedente</button>
      </div>
      <p class="small muted" style="margin-top:14px">${esc(it.source)}${it.note ? ' · ' + esc(it.note) : ''}</p>
      <button class="btn ghost" id="abortBtn" style="margin-top:14px">Interrompi</button>
    </div>`;

  // --- barra dei comandi fissa in basso, nella zona del pollice (proposta 19) ---
  // il pulsante dice sempre quale serie sta per chiudere: nessuna ambiguità su
  // quante ne restano, e si vede subito se il conteggio si è disallineato
  const nDone = c.setsDone[c.pos], nNext = Math.min(nDone + 1, it.sets);
  const allDone = nDone >= it.sets;
  const sideTag = it.perSide ? ' · ' + (nDone % 2 ? 'Dx' : 'Sx') : '';
  const doneLabel = allDone
    ? 'Concludi l\'esercizio'
    : (timed ? `Avvia ${hold} s · serie ${nNext} di ${it.sets}${sideTag}`
             : `Ho finito la serie ${nNext} di ${it.sets}${sideTag}`);

  $('#actionBar').innerHTML = `
    <button class="btn ${timed && !allDone ? 'teal' : ''}" id="doneSet" ${timerRunning() ? 'disabled' : ''}>${doneLabel}</button>
    <button class="btn secondary" id="nextBtn">${c.pos === s.items.length - 1 ? 'Chiudi' : 'Avanti ›'}</button>`;
  $('#actionBar').classList.add('on');

  // I pallini servono a CORREGGERE il conteggio, non ad avanzarlo: toccarne uno
  // già spento non conclude la serie, la marca soltanto. Portare il conteggio
  // al massimo con un tocco chiede conferma, perché equivale a dichiarare
  // l'esercizio finito e prima era il modo più facile per perdere una serie.
  document.querySelectorAll('[data-set]').forEach(b => b.onclick = () => {
    const i = +b.dataset.set;
    const now = c.setsDone[c.pos];
    const val = (now === i + 1) ? i : i + 1;
    const apply = () => { c.setsDone[c.pos] = val; saveResume(); renderSession(); };
    if (val >= it.sets && now < it.sets) {
      confirmAction('Segnare tutte le serie come fatte?',
        `Stai marcando ${it.sets} serie su ${it.sets} di ${ex.name}: l'esercizio risulterà concluso. ` +
        'Per svolgere normalmente le serie usa il pulsante in basso.',
        'Sì, sono tutte fatte', apply);
    } else apply();
  });
  document.querySelectorAll('[data-fb]').forEach(b => b.onclick = () => {
    c.feedback[c.pos] = c.feedback[c.pos] === b.dataset.fb ? null : b.dataset.fb;
    captureLoad(); saveResume(); renderSession();
  });
  document.querySelectorAll('[data-rep]').forEach(b => b.onclick = () => {
    const base = (c.repsDone[c.pos] === null || c.repsDone[c.pos] === undefined) ? it.reps : c.repsDone[c.pos];
    c.repsDone[c.pos] = Math.max(0, Math.min(99, base + (+b.dataset.rep)));
    captureLoad(); saveResume(); renderSession();
  });
  document.querySelectorAll('[data-rir]').forEach(b => b.onclick = () => {
    const v = +b.dataset.rir;
    c.rir[c.pos] = (c.rir[c.pos] === v) ? null : v;
    captureLoad(); saveResume(); renderSession();
  });
  if ($('#loadIn')) $('#loadIn').onchange = () => { captureLoad(); saveResume(); renderSession(); };

  /* Conclude la serie in corso e avvia il recupero.
     Il conteggio avanza solo qui, di una serie per volta, e l'esercizio si
     considera concluso soltanto se è stata questa pressione a completarlo:
     prima il controllo guardava il totale, così un pallino toccato per sbaglio
     poteva far saltare l'ultima serie. */
  /* Conclude la serie in corso. Fra una serie e l'altra parte il recupero a
     schermo intero; con l'ultima serie l'esercizio viene registrato SUBITO e
     compare la schermata del successivo, mentre il recupero conclusivo scorre
     nella barretta in basso: intanto puoi aprire la scheda e ripassarla. */
  const closeSet = () => {
    captureLoad();
    const before = c.setsDone[c.pos];
    if (before < it.sets) c.setsDone[c.pos] = before + 1;
    const done = c.setsDone[c.pos];
    saveResume();
    if (done >= it.sets) { concludeExercise(); return; }
    renderSession();
    startTimer(it.rest, `Serie ${done + 1} di ${it.sets}${it.perSide ? ' · ' + (done % 2 ? 'Dx' : 'Sx') : ''} · ${ex.name}`, null, 'rest');
  };

  /* Esercizi a tempo: un solo tocco avvia l'intera sequenza
     preparazione → tenuta → pausa → tenuta … → recupero conclusivo.
     Ogni tenuta completata conta una serie; le azioni sono legate a questo
     esercizio in questa posizione, così uno spostamento non fa contare le
     tenute sull'esercizio sbagliato. */
  const runHolds = () => {
    const atPos = c.pos, atSid = c.started, atIt = it, atEx = it.exId;
    const valid = () => current && !current.finished && current.started === atSid &&
      current.pos === atPos && current.sess.items[atPos] === atIt && atIt.exId === atEx;
    const last = c.pos === s.items.length - 1;
    const nextName = last ? '' : exById(s.items[c.pos + 1].exId).name;
    const side = k => it.perSide ? ' · ' + (k % 2 ? 'Dx' : 'Sx') : '';
    const defs = holdChainDefs(it, ex, c.setsDone[c.pos], last);
    defs.forEach((d, i) => {
      if (d.kind === 'work') {
        d.what = `Tenuta ${d.set + 1} di ${it.sets}${side(d.set)} · ${ex.name}`;
        d.onEnd = () => {
          if (!valid()) return false;
          c.setsDone[c.pos] = Math.min(it.sets, c.setsDone[c.pos] + 1);
          saveResume();
          if (c.setsDone[c.pos] >= it.sets) { concludeExercise(true); return true; }
          renderSession();
          return true;
        };
      } else if (d.kind === 'rest' && d.final) {
        d.what = `Recupero · poi ${nextName}`;
        d.onStart = () => minimizeTimer();       // lascia vedere il prossimo esercizio
      } else if (d.kind === 'rest') {
        const nx = defs[i + 1];
        d.what = `Pausa · poi tenuta ${nx.set + 1} di ${it.sets}${side(nx.set)}`;
      }
    });
    defs[0].what = defs[1].what;                 // la preparazione annuncia la prima tenuta
    runChain(defs);
    renderSession();
  };

  $('#doneSet').onclick = () => {
    if (timerRunning()) return;                  // un timer è già in corso
    captureLoad();
    // con tutte le serie già segnate non c'è una tenuta da cronometrare:
    // il pulsante chiude e basta
    if (timed && !allDone) runHolds();
    else closeSet();
  };
  $('#infoBtn').onclick = () => openSheet(ex, it, { sess: s, after: () => renderSession() });
  $('#swapBtn').onclick = () => openExercisePicker(it, s, changed => {
    if (changed) {
      if (chainHasWork()) stopTimer();          // le tenute in corso erano dell'esercizio sostituito
      c.setsDone[c.pos] = 0; c.loads[c.pos] = ''; c.feedback[c.pos] = null;
      c.repsDone[c.pos] = null; c.rir[c.pos] = null;
    }
    saveResume(); renderSession();
  });
  $('#noteBtn').onclick = () => editNote(it.exId, () => renderSession());
  if ($('#noteShow')) $('#noteShow').onclick = () => editNote(it.exId, () => renderSession());
  $('#postponeBtn').onclick = () => { captureLoad(); releaseTimerForMove(); postponeCurrent(); };
  $('#orderBtn').onclick = () => { captureLoad(); openReorder(); };
  $('#prevBtn').onclick = () => { captureLoad(); if (c.pos > 0) { releaseTimerForMove(); c.pos--; saveResume(); renderSession(); } };

  // il timer di recupero accompagna al prossimo esercizio: passando avanti
  // continua a scorrere, si stacca solo l'azione automatica che aveva in coda
  const goNext = () => { releaseTimerForMove(); nextExercise(); };
  $('#nextBtn').onclick = () => {
    captureLoad();
    if (c.pos === s.items.length - 1) {
      confirmAction('Chiudere la sessione?', 'Stai per concludere l\'ultimo esercizio e chiudere la seduta.',
        'Chiudi la sessione', () => { stopTimer(); nextExercise(); });
    } else if (c.setsDone[c.pos] < it.sets) {
      confirmAction('Passare al prossimo esercizio?',
        `Hai completato ${c.setsDone[c.pos]} serie su ${it.sets}.`, 'Vai avanti', goNext);
    } else goNext();
  };
  $('#abortBtn').onclick = () => confirmAction('Interrompere la sessione?',
    'Gli esercizi già conclusi restano nello storico, il resto della seduta viene abbandonato.',
    'Interrompi', () => { stopTimer(); releaseWakeLock(); current = null; clearResume(); go('home'); });
}

/* Nota personale per esercizio: regolazioni della macchina, accorgimenti,
   sensazioni ricorrenti. Resta legata all'esercizio e ricompare ogni volta. */
function editNote(exId, after) {
  const ex = exById(exId), cur = S.exNotes[exId] || '';
  openModal(`<h2>Nota su ${esc(ex.name)}</h2>
    <p class="small muted">Resta salvata e ricompare ogni volta che incontri questo esercizio: regolazioni del sedile, presa, accorgimenti.</p>
    <div class="field"><input id="noteIn" type="text" maxlength="120" placeholder="es. sedile al foro 4, presa stretta" value="${esc(cur)}"></div>
    <button class="btn" id="noteOk">Salva</button>
    ${cur ? `<button class="btn ghost" id="noteDel" style="margin-top:10px">Elimina la nota</button>` : ''}
    <button class="btn ghost" id="noteNo" style="margin-top:10px">Annulla</button>`);
  $('#noteOk').onclick = () => {
    const v = ($('#noteIn').value || '').trim();
    if (v) S.exNotes[exId] = v; else delete S.exNotes[exId];
    save(); closeModal(after);
  };
  if ($('#noteDel')) $('#noteDel').onclick = () => { delete S.exNotes[exId]; save(); closeModal(after); };
  $('#noteNo').onclick = () => closeModal();
}

/* Sposta un esercizio nella scaletta insieme ai dati già inseriti (serie fatte,
   carico, ripetizioni, RIR, feedback), così l'ordine può essere adattato al volo
   se una macchina o un attrezzo è occupato. Si possono spostare solo gli
   esercizi non ancora conclusi, cioè dalla posizione corrente in poi. */
function moveItem(from, to) {
  const c = current, s = c.sess;
  if (from === to || from < c.pos || to < c.pos || to >= s.items.length) return;
  // l'esercizio in corso cambia posto: una sequenza di tenute aperta si ferma
  if (from === c.pos || to === c.pos) releaseTimerForMove();
  [s.items, c.setsDone, c.loads, c.feedback, c.logRef, c.repsDone, c.rir].forEach(arr => {
    const v = arr.splice(from, 1)[0];
    arr.splice(to, 0, v);
  });
  saveResume();
}

/* Rimanda l'esercizio corrente in fondo alla seduta. */
function postponeCurrent() {
  const c = current, s = c.sess;
  if (c.pos >= s.items.length - 1) return;
  moveItem(c.pos, s.items.length - 1);
  renderSession();
}

/* Pannello di riordino: frecce su/giù sugli esercizi ancora da fare. */
function openReorder() {
  const c = current, s = c.sess;
  const draw = () => {
    const rows = s.items.map((it, i) => {
      if (i < c.pos) return '';
      const ex = exById(it.exId);
      return `<li style="align-items:center">
        <div class="nm" style="flex:1" data-openex="${i}"><b>${esc(ex.name)}</b>
          <div class="small muted">${esc(ex.group)} · ${doseText(it)}${i === c.pos ? ' · in corso' : ''} · scheda ›</div></div>
        <button class="mini-skip" data-up="${i}" ${i === c.pos ? 'disabled' : ''}>▲</button>
        <button class="mini-skip" data-down="${i}" ${i === s.items.length - 1 ? 'disabled' : ''}>▼</button>
      </li>`;
    }).join('');
    openModal(`<h2>Ordine degli esercizi</h2>
      <p class="small muted">Sposta in avanti quello che puoi fare adesso: utile se una macchina o un attrezzo è occupato. I dati già inseriti seguono l'esercizio.</p>
      <ul class="hist">${rows}</ul>
      <button class="btn" id="reorderOk" style="margin-top:14px">Fatto</button>`);
    document.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { moveItem(+b.dataset.up, +b.dataset.up - 1); draw(); });
    document.querySelectorAll('[data-down]').forEach(b => b.onclick = () => { moveItem(+b.dataset.down, +b.dataset.down + 1); draw(); });
    document.querySelectorAll('[data-openex]').forEach(el => el.onclick = () => {
      const i = +el.dataset.openex, item = s.items[i];
      closeModal(() => openSheet(exById(item.exId), item, { sess: s, after: () => renderSession() }));
    });
    $('#reorderOk').onclick = () => { closeModal(); renderSession(); };
  };
  draw();
}

function captureLoad() {
  const el = $('#loadIn');
  if (el && current) current.loads[current.pos] = el.value;
}

/* ---------------------------------------------------------------------------
   RIPRESA DI UNA SEDUTA INTERROTTA
   La sessione in corso viene salvata a ogni modifica, non solo tenuta in
   memoria: se iOS chiude l'app per liberare memoria — cosa normale mentre
   ascolti musica e usi altre app in palestra — al riavvio ritrovi esercizio
   corrente, serie completate, carichi, ripetizioni e RIR già inseriti.
--------------------------------------------------------------------------- */
const RESUME_MAX_H = 6;          // oltre sei ore la seduta è considerata chiusa

function saveResume() {
  if (!current || current.finished) return;
  const c = current;
  S.resume = {
    ts: Date.now(), started: c.started, pos: c.pos,
    kind: c.sess.kind, idx: c.sess.idx,
    items: c.sess.items,                      // la seduta può essere stata riordinata
    label: c.sess.label, type: c.sess.type,
    setsDone: c.setsDone, loads: c.loads, feedback: c.feedback,
    repsDone: c.repsDone, rir: c.rir, logRef: c.logRef
  };
  save();
}
function clearResume() { S.resume = null; save(); }

/* Ricostruisce la sessione dallo stato salvato, se è ancora recente. */
function resumableSession() {
  const r = S.resume;
  if (!r || !r.items || !r.items.length) return null;
  if ((Date.now() - r.ts) > RESUME_MAX_H * 3600 * 1000) return null;
  if (r.items.some(it => !exById(it.exId))) return null;
  return r;
}
function restoreSession(r) {
  const meta = sessionMeta(r.idx);
  const sess = Object.assign({}, meta, {
    label: r.label, type: r.type, kind: r.kind, items: r.items,
    minutes: estimateMinutes(r.items)
  });
  current = { sess, pos: r.pos, setsDone: r.setsDone, loads: r.loads,
              feedback: r.feedback, logRef: r.logRef,
              repsDone: r.repsDone || r.items.map(() => null),
              rir: r.rir || r.items.map(() => null),
              started: r.started };
  requestWakeLock(); unlockAudio();
  go('session'); renderSession();
}
const arrow = f => f === 'up' ? '<span class="trend-up">↑</span>' : f === 'down' ? '<span class="trend-down">↓</span>' : '–';

/* Chiude l'esercizio corrente appena completata l'ultima serie: lo registra,
   mostra il successivo e avvia il recupero conclusivo nella barretta in basso.
   inChain = true quando il recupero fa già parte della sequenza di tenute in
   corso (lì non va avviato un secondo timer). Sull'ultimo esercizio nessun
   recupero: si passa direttamente al riepilogo della seduta. */
function concludeExercise(inChain) {
  const c = current, s = c.sess;
  const it = s.items[c.pos], ex = exById(it.exId);
  const last = c.pos >= s.items.length - 1;
  if (!inChain) stopTimer();
  nextExercise();
  if (last || !current || current.finished) return;
  if (!inChain) {
    const nx = exById(s.items[c.pos].exId);
    startTimer(finalRestOf(it, ex), `Recupero · poi ${nx.name}`, null, 'rest', 0, { mini: true });
    renderSession();                             // il pulsante resta in attesa del recupero
  }
}

function nextExercise() {
  const c = current, s = c.sess;
  if (c.finished) return;              // evita doppie registrazioni sull'ultimo esercizio
  // registra l'esercizio appena concluso (o aggiorna il record, se ci si era
  // tornati sopra con "Esercizio precedente": niente doppioni nello storico)
  const it = s.items[c.pos];
  const rd = c.repsDone[c.pos];
  const entry = { ts: Date.now(), sid: c.started, sIdx: s.idx, exId: it.exId, name: exById(it.exId).name,
                  setup: S.setup, load: c.loads[c.pos] || '', feedback: c.feedback[c.pos] || 'same',
                  sets: c.setsDone[c.pos],
                  repsTarget: it.reps,                                   // obiettivo previsto
                  repsDone: (rd === null || rd === undefined) ? it.reps : rd,  // eseguite davvero
                  rir: (c.rir[c.pos] === null || c.rir[c.pos] === undefined) ? null : c.rir[c.pos],
                  reps: it.reps,                                         // compatibilità storico
                  goal: it.goal, week: s.weekInCycle };
  // valutazione automatica rispetto alla registrazione precedente dello stesso esercizio
  const ref0 = c.logRef[c.pos];
  const prev = S.logs.filter((g, gi) => g.exId === it.exId && gi !== ref0).pop() || null;
  const r = rateLog(entry, prev, s.weekInCycle >= program().cycleWeeks);
  entry.stars = r.stars; entry.rateText = r.text; entry.warn = r.warn || ''; entry.advice = r.advice || '';
  const ref = c.logRef[c.pos];
  if (ref !== null && S.logs[ref]) S.logs[ref] = entry;
  else { c.logRef[c.pos] = S.logs.length; S.logs.push(entry); }
  save();
  if (c.pos < s.items.length - 1) { c.pos++; saveResume(); renderSession(); }
  else { c.finished = true; endSession(); }
}

/* ---------- fine sessione: riepilogo e salvataggio ---------- */
function endSession() {
  stopTimer(); releaseWakeLock();
  const s = current.sess, mins = Math.round((Date.now() - current.started) / 60000);
  openModal(`
    <h2>Sessione completata</h2>
    <p class="small muted">${esc(s.label)} · ${mins} minuti effettivi.</p>
    <div class="field"><label>Note</label><input id="sNote" type="text" placeholder="sensazioni, ginocchio, ecc."></div>
    <button class="btn" id="saveSession">Salva e chiudi</button>
    <button class="btn ghost" id="skipSave" style="margin-top:10px">Chiudi senza note</button>
  `);
  const finish = (withNote) => {
    const sid = current ? current.started : 0;
    S.sessionLog.push({ ts: Date.now(), sid: sid, idx: s.idx,
      label: s.label, kind: s.kind, minutes: mins,
      note: withNote ? ($('#sNote').value || '') : '' });
    if (s.kind !== 'core' && s.kind !== 'free') S.sessionIndex++;
    planCache = null; homeSel = 'session';
    const weekDone = (s.kind !== 'core' && s.kind !== 'free' && S.sessionIndex % 5 === 0) ? S.sessionIndex / 5 : 0;
    if (weekDone) S.lastRecap = weekDone;
    calibratePace(s, mins);            // la stima dei tempi impara dalla realtà
    clearResume();                     // la seduta è chiusa: niente da riprendere
    if (weekDone) takeSnapshot(weekDone);
    save();

    // statistiche della seduta appena chiusa, per il pop up di complimenti
    const done = S.logs.filter(l => l.sid === sid);
    const rated = done.filter(l => l.stars > 0);
    const avg = rated.length ? rated.reduce((a, l) => a + l.stars, 0) / rated.length : 0;

    current = null;
    closeModal(() => celebrate({ label: s.label, mins, count: done.length, avg, weekDone }));
  };

  $('#saveSession').onclick = () => finish(true);
  $('#skipSave').onclick = () => finish(false);
}

/* Pop up di complimenti: cerchio che si disegna, spunta, scintille e numeri
   della seduta. Alla chiusura, se la settimana è completa, lascia il posto al
   riepilogo settimanale. */
function celebrate(st) {
  const line = st.avg >= 4 ? 'Seduta sopra le attese: stai andando meglio del programma.'
    : st.avg >= 3 ? 'Progressione perfettamente in linea con il programma.'
    : st.avg >= 2 ? 'Seduta solida: il mantenimento è già un risultato.'
    : 'Fatto. Presentarsi nei giorni storti vale più di una seduta brillante.';

  const sparks = [[60, 8], [102, 30], [102, 90], [60, 112], [18, 90], [18, 30]]
    .map((p, i) => `<circle class="spark" cx="${p[0]}" cy="${p[1]}" r="3.4" fill="#4FC3A1" style="animation-delay:${1 + i * 0.05}s"/>`).join('');

  openModal(`<div class="cheer">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      ${sparks}
      <circle class="ring" cx="60" cy="60" r="45" fill="none" stroke="#F5A524" stroke-width="7"
              stroke-linecap="round" transform="rotate(-90 60 60)"/>
      <path class="tick" d="M40 61 L54 75 L81 46" fill="none" stroke="#EAF1F8" stroke-width="8"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <h2>Seduta completata!</h2>
    <p class="sub small muted">${esc(st.label)}</p>
    <div class="statline">
      <div class="stat"><b>${st.mins}</b><span>minuti</span></div>
      <div class="stat"><b>${st.count}</b><span>esercizi</span></div>
      <div class="stat"><b>${st.avg ? st.avg.toFixed(1) : '—'}</b><span>stelle medie</span></div>
    </div>
    <p class="sub small" style="margin-top:12px">${line}</p>
    <button class="btn" id="cheerOk" style="margin-top:18px">Continua</button>
  </div>`);

  $('#cheerOk').onclick = () => closeModal(() => {
    go('home');
    if (st.weekDone) setTimeout(() => openWeekReport(st.weekDone), 260);
  });
}

/* ---------- scheda esercizio ---------- */
function openSheet(ex, it, ctx) {
  $('#sheetPanel').innerHTML = `
    <h2>${esc(ex.name)}</h2>
    <div class="small muted">${esc(ex.group)} · ${esc(ex.equipment.join(', ') || 'corpo libero')}</div>
    <div class="frames">
      <div>${figureA11y(ex, 0)}<div class="small muted" style="text-align:center">posizione iniziale</div></div>
      <div>${figureA11y(ex, 1)}<div class="small muted" style="text-align:center">posizione finale</div></div>
    </div>
    ${it ? `<p class="small muted">Oggi: ${doseText(it)}, recupero ${it.rest}s, RPE ${esc(it.rpe)}. ${esc(it.source)}</p>` : ''}
    ${(() => {
      const sug = suggestLoad(ex), last = sug && sug.last;
      if (!last) return `<div class="notice" style="margin-top:10px">Nessuna registrazione precedente per questo esercizio: parti prudente e annota ${loadWord(ex)} e ripetizioni.</div>`;
      const det = [];
      if (isFinite(last.repsDone)) det.push(`${last.sets}×${last.repsDone} rip`);
      if (isFinite(last.rir) && last.rir !== null) det.push(`RIR ${last.rir}`);
      const em = e1rm(last);
      if (em) det.push(`max stimato ${em.toFixed(1)} kg`);
      return `<div class="notice" style="margin-top:10px">
        <b>Ultima volta</b> (${new Date(last.ts).toLocaleDateString('it-IT')}): ${esc(last.load || '—')}${det.length ? ' · ' + det.join(' · ') : ''} ${arrow(last.feedback)} ${starsHtml(last.stars)}
        ${last.rateText ? `<div class="small" style="opacity:.85">${esc(last.rateText)}</div>` : ''}
        ${sug.value ? `<div style="margin-top:6px"><b>${isAssist(ex) ? 'Assistenza suggerita oggi' : 'Suggerito oggi'}:</b> ${esc(sug.value)}</div>` : ''}
        ${sug.reason ? `<div class="small" style="opacity:.85">${esc(sug.reason)}</div>` : ''}
      </div>`;
    })()}
    ${ex.assistNote ? `<div class="assistnote">${esc(ex.assistNote)}</div>` : ''}
    ${rackNote(ex) ? `<p class="small muted">${esc(rackNote(ex))}</p>` : ''}
    ${S.exNotes[ex.id] ? `<div class="exnote" style="cursor:default">📌 ${esc(S.exNotes[ex.id])}</div>` : ''}
    <div class="block"><h3>Esecuzione</h3><ol>${ex.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>
    ${ex.levels ? `<div class="block"><h3>Progressione</h3>
      <p class="small muted">Gradini dal più facile al più difficile: si sale quando superi l'obiettivo di due ripetizioni per due sedute.</p>
      <ol>${ex.levels.map(l => `<li>${esc(l)}</li>`).join('')}</ol></div>` : ''}
    <div class="block"><h3>Muscoli coinvolti</h3>
      <div class="tags">${ex.primary.map(m => `<span data-muscle="${esc(m)}">${esc(m)} ›</span>`).join('')}
      ${ex.secondary.map(m => `<span data-muscle="${esc(m)}">${esc(m)} (secondario) ›</span>`).join('')}</div>
      <p class="small muted" style="margin-top:8px">Tocca un muscolo per vedere tutti gli esercizi che lo coinvolgono${ctx ? ' e, se vuoi, sostituire quello in programma' : ''}.</p></div>
    <div class="block warnblock"><h3>Errori e rischi</h3>
      <ul>${ex.errors.map(e => `<li>${esc(e)}</li>`).join('')}${ex.safety.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>
    <div class="block"><h3>Riferimento</h3><p class="small muted">${esc(ex.source)}</p></div>
    ${ctx ? `<button class="btn ghost" id="sheetSwap" style="margin-top:18px">Sostituisci con un altro esercizio</button>` : ''}
    <button class="btn secondary" id="closeSheet" style="margin-top:10px">Chiudi</button>`;
  $('#sheet').classList.add('on');
  $('#sheetPanel').scrollTop = 0;                // si apre sempre dalla cima
  $('#closeSheet').onclick = closeSheet;
  if (ctx && $('#sheetSwap')) $('#sheetSwap').onclick = () => {
    closeSheet();
    setTimeout(() => openExercisePicker(it, ctx.sess, ctx.after), 240);
  };
  document.querySelectorAll('[data-muscle]').forEach(t => t.onclick = () => {
    const m = t.dataset.muscle;
    closeSheet();
    setTimeout(() => openMusclePicker(m, ctx ? it : null, ctx ? ctx.sess : null, ctx ? ctx.after : null), 240);
  });
}
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

/* ---------- progressi ---------- */
function renderHistory() {
  $('#topTitle').textContent = 'Progressi';
  $('#topChip').textContent = `${S.logs.length} esercizi registrati`;
  $('#topChip').className = 'chip';

  const byEx = {};
  S.logs.forEach(l => { (byEx[l.exId] = byEx[l.exId] || []).push(l); });
  const keys = Object.keys(byEx).sort((a, b) =>
    byEx[b][byEx[b].length - 1].ts - byEx[a][byEx[a].length - 1].ts);

  if (!keys.length) {
    $('#view-history').innerHTML = `<div class="card"><h2>Ancora nessun dato</h2>
      <p class="muted small">Completa una sessione: qui troverai l'andamento dei carichi esercizio per esercizio e il riepilogo delle sedute.</p></div>`;
    return;
  }

  const rows = keys.map(k => {
    const logs = byEx[k], last = logs[logs.length - 1];
    // la linea segue il massimale stimato: così migliorare le ripetizioni a
    // parità di carico si vede, mentre prima il grafico restava piatto
    const nums = logs.map(l => { const m = progressMetric(l); return m ? m.v : NaN; })
                     .filter(n => isFinite(n));
    const e = e1rm(last);
    return `<li data-ex="${k}">
      <div class="spark">${sparkline(nums)}</div>
      <div class="nm" style="flex:1"><b>${esc(last.name)}</b>
        <div class="small muted">${logs.length} sedute · ultima ${new Date(last.ts).toLocaleDateString('it-IT')}${e ? ' · max stimato ' + e.toFixed(1) + ' kg' : ''}</div></div>
      <div class="val">${esc(last.load || '—')}${isAssist(exById(k)) ? ' <span class="small muted">aiuto</span>' : ''} ${arrow(last.feedback)}<br>${starsHtml(last.stars)}</div></li>`;
  }).join('');

  const sess = S.sessionLog.map((x, i) => [x, i]).slice(-10).reverse().map(pair => {
    const x = pair[0], i = pair[1];
    return `<li data-sess="${i}"><div class="nm" style="flex:1"><b>${esc(x.label)}</b>
      <div class="small muted">${new Date(x.ts).toLocaleDateString('it-IT')} · ${x.minutes} min${x.note ? ' · ' + esc(x.note) : ''}</div></div>
      <div class="chev">›</div></li>`;
  }).join('');

  const wks = weeksWithData().slice(0, 4).map(w =>
    `<button class="btn ghost" data-week="${w}" style="margin-top:8px">Settimana ${w} · ${weekReport(w).sessions} sedute</button>`).join('');

  const curWeek = Math.floor(S.sessionIndex / 5) + 1;
  const volAna = volumeAnalysis(curWeek);
  const vol = volumeHtml(curWeek, volAna);

  $('#view-history').innerHTML = `
    ${vol ? `<div class="card"><h2>Volume della settimana ${curWeek}</h2>
      <p class="small muted">Serie fatte / previste dal programma, per gruppo muscolare. Una serie conta 1 per i muscoli
      che la eseguono e ½ per quelli che collaborano (i tricipiti nella panca, i bicipiti nelle trazioni).
      La tacca chiara segna le 10 serie settimanali, volume oltre il quale la letteratura mostra i risultati migliori
      sull'ipertrofia; sotto le 5 la barra diventa rossa.</p>
      <div style="margin-top:10px">${vol}</div>
      ${volAna.advice.length ? `<ul class="small" style="margin-top:12px;padding-left:18px">${volAna.advice.map(t => `<li style="margin-top:6px">${esc(t)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    ${wks ? `<div class="card"><h2>Riepilogo settimanale</h2>
      <p class="small muted">Traguardi migliori e punti a cui fare attenzione, dalla valutazione automatica dei progressi.</p>${wks}</div>` : ''}
    <div class="card"><h2>Carichi per esercizio</h2>
      <p class="small muted">La linea segue il massimale stimato, non il solo peso: migliorare le ripetizioni a parità di carico si vede.</p>
      <ul class="hist">${rows}</ul></div>
    ${sess ? `<div class="card"><h2>Ultime sedute</h2><ul class="hist">${sess}</ul></div>` : ''}`;

  document.querySelectorAll('[data-ex]').forEach(li => li.onclick = () => detailFor(li.dataset.ex, byEx[li.dataset.ex]));
  document.querySelectorAll('[data-sess]').forEach(li => li.onclick = () => openSessionDetail(+li.dataset.sess));
  document.querySelectorAll('[data-week]').forEach(b => b.onclick = () => openWeekReport(+b.dataset.week));
}

/* Esercizi appartenenti a una seduta già conclusa: si usa l'identificativo di
   sessione salvato nei record; per i dati più vecchi si ricade sulla finestra
   temporale della seduta. */
function logsOfSession(x) {
  if (x.sid) {
    const l = S.logs.filter(g => g.sid === x.sid);
    if (l.length) return l;
  }
  const start = x.ts - (x.minutes + 3) * 60000;
  return S.logs.filter(g => g.ts >= start && g.ts <= x.ts + 60000);
}

/* Riepilogo completo di una seduta già chiusa. */
function openSessionDetail(i) {
  const x = S.sessionLog[i], logs = logsOfSession(x);
  const d = new Date(x.ts);
  const rows = logs.map(l => `<li>
      <div class="nm" style="flex:1"><b>${esc(l.name)}</b>
        <div class="small muted">${l.sets}×${l.reps} · ${l.goal === 'stretch' ? 'allungamento' : esc(l.goal)}</div></div>
      <div class="val">${esc(l.load || '—')} ${arrow(l.feedback)}</div></li>`).join('');
  openModal(`<h2>${esc(x.label)}</h2>
    <p class="small muted">${d.toLocaleDateString('it-IT')} alle ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} · ${x.minutes} minuti · ${logs.length} esercizi${x.kind === 'core' ? ' · blocco core' : ''}</p>
    ${x.note ? `<div class="notice" style="margin-bottom:10px">${esc(x.note)}</div>` : ''}
    <ul class="hist">${rows || '<li><span class="small muted">Nessun esercizio registrato per questa seduta.</span></li>'}</ul>
    <button class="btn secondary" id="closeModal2" style="margin-top:16px">Chiudi</button>`);
  $('#closeModal2').onclick = closeModal;
}

/* ---------------------------------------------------------------------------
   RIEPILOGO SETTIMANALE
   Alla fine delle 5 sedute l'app raccoglie le valutazioni della settimana e
   mostra i traguardi migliori e i punti a cui fare attenzione. Richiamabile in
   qualsiasi momento dalla scheda Progressi.
--------------------------------------------------------------------------- */
function weekReport(weekAbs) {
  const logs = S.logs.filter(l => l.sIdx != null && Math.floor(l.sIdx / 5) + 1 === weekAbs);
  const sessions = new Set(logs.map(l => l.sid)).size;
  const rated = logs.filter(l => l.stars > 0);
  const avg = rated.length ? rated.reduce((a, l) => a + l.stars, 0) / rated.length : 0;
  const best = rated.slice().sort((a, b) => (b.stars - a.stars) || (b.ts - a.ts)).slice(0, 3);
  const warns = logs.filter(l => l.warn);
  const hard = logs.filter(l => l.feedback === 'down');
  return { weekAbs, logs, sessions, rated, avg, best, warns, hard };
}

/* Quante sedute di programma risultano davvero completate: è il valore che
   l'indice dovrebbe avere. Blocchi core e sedute libere non fanno avanzare il
   programma, quindi non contano. Serve a rimettere in pari la posizione quando
   una seduta è stata saltata senza registrarla. */
function countProgramSessions() {
  return S.sessionLog.filter(x => x.kind !== 'core' && x.kind !== 'free').length;
}

/* ---------------------------------------------------------------------------
   RIALLINEAMENTO DELLO STORICO ALLA POSIZIONE NEL PROGRAMMA
   Ogni esercizio registrato porta con sé l'indice della seduta (sIdx), da cui
   si ricava la settimana. Finché la posizione nel programma era sfasata (la
   correzione del 17/09), alcune sedute sono state salvate con l'indice
   sbagliato: nel riepilogo finivano in un'altra settimana, e la settimana 1
   sembrava avere 2 sedute di forza invece di 3.
   Qui le sedute di programma vengono rinumerate a ritroso a partire dalla
   posizione attuale, che è quella confermata: l'ultima seduta chiusa è la
   posizione attuale meno 1, la penultima meno 2, e così via. Blocchi core e
   sedute libere prendono la settimana della seduta di programma che le
   precede. Gli esercizi seguono la loro seduta tramite l'identificativo sid.
   Nessun dato viene cancellato: cambia solo l'etichetta della settimana.
--------------------------------------------------------------------------- */
function realignHistory() {
  const list = S.sessionLog.slice().sort((a, b) => a.ts - b.ts);
  const prog = list.filter(x => x.kind !== 'core' && x.kind !== 'free');
  let k = S.sessionIndex - 1;
  // le sedute più vecchie dell'inizio del programma (prove, versioni
  // precedenti) restano nello storico ma fuori da ogni settimana
  for (let i = prog.length - 1; i >= 0; i--, k--) prog[i].idx = k >= 0 ? k : null;
  let lastIdx = null;
  list.forEach(x => {
    if (x.kind !== 'core' && x.kind !== 'free') lastIdx = x.idx;
    else x.idx = lastIdx;
  });
  // gli esercizi seguono la seduta a cui appartengono (per sid, o per orario
  // nelle registrazioni più vecchie che non lo avevano)
  let moved = 0;
  list.forEach(x => logsOfSession(x).forEach(l => {
    if (l.sIdx !== x.idx) { l.sIdx = x.idx; moved++; }
  }));
  planCache = null;
  return moved;
}

/* Una sola volta, all'avvio della 4.6: corregge le sedute salvate prima
   dell'allineamento della posizione. */
function migrateRealign() {
  if (S.realigned1) return;
  S.realigned1 = true;
  realignHistory();
  save();
}

/* Sedute di forza davvero chiuse nella settimana, dal registro delle sedute:
   conta il tipo registrato, non gli esercizi, così un blocco core facoltativo
   non passa per una seduta di forza. */
function strengthSessionsIn(weekAbs) {
  return S.sessionLog.filter(x => x.idx != null && Math.floor(x.idx / 5) + 1 === weekAbs &&
    (x.kind === 'strength' || (!x.kind && /^Forza/.test(x.label || '')))).length;
}

function weeksWithData() {
  const set = new Set(S.logs.filter(l => l.sIdx != null).map(l => Math.floor(l.sIdx / 5) + 1));
  return Array.from(set).sort((a, b) => b - a);
}

/* ---------------------------------------------------------------------------
   VOLUME SETTIMANALE PER GRUPPO MUSCOLARE
   Riferimento: Schoenfeld, Ogborn, Krieger (2017), Journal of Sports
   Sciences — meno di 5 serie settimanali per muscolo +5,4% di crescita, da 5 a
   9 +6,6%, 10 o più +9,8%. Da qui le soglie 5 (minimo) e 10 (obiettivo).

   Come si conta, perché il numero sia confrontabile con quelle soglie:
   · per GRUPPO, non per singolo muscolo anatomico: "Bicipiti", "Brachiale" e
     "Brachioradiale" sono tutti Braccia, e una serie di curl vale una serie,
     non tre;
   · serie DIRETTE = 1 (il gruppo è motore principale dell'esercizio),
     serie INDIRETTE = 0,5 (il gruppo collabora: i tricipiti nella spinta, i
     bicipiti nella trazione) — è la convenzione più usata nella pratica;
   · negli esercizi monolaterali le serie registrate sono di entrambi i lati,
     quindi ogni lato riceve la metà;
   · mobilità e allungamenti non contano: non sono lavoro di ipertrofia.
   Il valore della settimana si confronta anche con quello PREVISTO dal
   programma per la stessa settimana: così il messaggio distingue fra "hai
   saltato qualcosa" e "è il programma a prevedere poco", che richiedono
   provvedimenti diversi.
--------------------------------------------------------------------------- */
const VOL_MIN = 5, VOL_TARGET = 10;

const VOL_GROUPS = ['Petto', 'Dorso', 'Spalle', 'Braccia', 'Quadricipiti', 'Glutei e femorali', 'Polpacci', 'Core'];
function muscleGroup(m) {
  const t = String(m).toLowerCase();
  if (/pettorale|^petto|torace/.test(t)) return 'Petto';
  if (/dorsal|romboid|trapezio|elevatore della scapola/.test(t)) return 'Dorso';
  if (/deltoid|spall|cuffia|sovraspinato/.test(t)) return 'Spalle';
  if (/bicipit|brachial|brachioradial|tricipit|anconeo|avambracci|presa/.test(t)) return 'Braccia';
  if (/quadricipit|vasto|retto femorale/.test(t)) return 'Quadricipiti';
  if (/glute|femoral|erettori|adduttori/.test(t)) return 'Glutei e femorali';
  if (/gastrocnemio|soleo|polpacc/.test(t)) return 'Polpacci';
  if (/core|addom|retto dell|obliqu|trasverso|quadrato dei lombi|flessor|ileopsoas/.test(t)) return 'Core';
  return null;                    // articolazioni e stabilizzatori: nessun gruppo
}

/* Serie effettive per gruppo di un esercizio con "sets" serie registrate. */
function groupSetsOf(ex, sets) {
  const out = {};
  if (!ex || ex.type === 'stretch' || !sets) return out;
  const n = ex.perSide ? sets / 2 : sets;
  (ex.primary || []).forEach(m => { const g = muscleGroup(m); if (g) out[g] = n; });
  (ex.secondary || []).forEach(m => { const g = muscleGroup(m); if (g && out[g] === undefined) out[g] = n * 0.5; });
  return out;
}
const addInto = (acc, part) => Object.keys(part).forEach(g => { acc[g] = (acc[g] || 0) + part[g]; });

function weekLogs(weekAbs) {
  return S.logs.filter(l => l.sIdx != null && Math.floor(l.sIdx / 5) + 1 === weekAbs);
}

/* Serie effettivamente completate nella settimana. */
function weeklyVolume(weekAbs) {
  const acc = {};
  weekLogs(weekAbs).forEach(l => addInto(acc, groupSetsOf(exById(l.exId), l.sets || 0)));
  return acc;
}

/* Serie previste dal programma per la stessa settimana (sedute generate con
   le impostazioni attuali: è una stima, ma fedele a quello che l'app propone). */
function plannedVolume(weekAbs) {
  const acc = {};
  let strength = 0;
  for (let k = 0; k < 5; k++) {
    const idx = (weekAbs - 1) * 5 + k;
    let sess;
    try { sess = buildSession(idx); } catch (e) { continue; }
    if (sess.type === 'stretch') continue;
    strength++;
    sess.items.forEach(it => addInto(acc, groupSetsOf(exById(it.exId), it.sets)));
  }
  return { acc, strength };
}

const fmtSets = v => (Math.round(v * 2) / 2).toString().replace('.', ',');

/* Analisi della settimana: righe per le barre e indicazioni pratiche. */
function volumeAnalysis(weekAbs) {
  const meta = sessionMeta((weekAbs - 1) * 5);
  const done = weeklyVolume(weekAbs);
  const plan = plannedVolume(weekAbs);
  const strengthDone = strengthSessionsIn(weekAbs);
  const rows = VOL_GROUPS.filter(g => done[g] || plan.acc[g])
    .map(g => ({ group: g, sets: done[g] || 0, planned: plan.acc[g] || 0 }));

  const curWeek = Math.floor(S.sessionIndex / 5) + 1;
  const inProgress = weekAbs === curWeek;
  const deload = meta.profile && meta.profile.label === 'Scarico';
  const low = rows.filter(r => r.sets < VOL_MIN);
  const advice = [];

  if (meta.mobilityWeek) {
    advice.push('Settimana di sola mobilità: nessun lavoro di forza previsto, il volume non si valuta. Si riparte dalla settimana successiva.');
    return { rows: [], advice, low: [], meta };
  }
  if (!low.length) return { rows, advice, low, meta };

  const missing = Math.max(0, plan.strength - strengthDone);
  if (missing > 0) {
    advice.push(inProgress
      ? `Settimana ancora in corso: ${missing === 1 ? 'manca 1 seduta' : `mancano ${missing} sedute`} di forza su ${plan.strength}. Le barre si allungano man mano; per ora nessun provvedimento.`
      : `${strengthDone === 1 ? 'È stata svolta 1 seduta' : `Sono state svolte ${strengthDone} sedute`} di forza su ${plan.strength}: il volume basso dipende soprattutto da questo. Provvedimento: nella prossima settimana cerca di completarle tutte; se capita spesso, riduci la durata delle sedute nelle impostazioni invece di saltarle.`);
  }
  if (deload) {
    advice.push('È una settimana di scarico: il volume ridotto è voluto e serve a recuperare. Nessun provvedimento.');
  }
  if (!deload && !(inProgress && missing > 0)) {
    // gruppi rimasti sotto per serie saltate o esercizi chiusi prima del previsto
    const short = low.filter(r => r.planned >= VOL_MIN && r.sets < r.planned - 0.9);
    if (short.length && !missing) {
      advice.push(`${short.map(r => r.group).join(', ')}: il programma prevedeva più serie di quelle registrate (${short.map(r => `${fmtSets(r.sets)} su ${fmtSets(r.planned)}`).join(', ')}). Provvedimento: controlla nello storico gli esercizi chiusi in anticipo o sostituiti con uno che lavora altri muscoli.`);
    }
    // gruppi che il programma stesso tiene bassi
    const byDesign = low.filter(r => r.planned < VOL_MIN);
    const core = byDesign.find(r => r.group === 'Core');
    if (core) advice.push('Core: il programma gli dedica poche serie dirette perché lavora già come stabilizzatore in squat, stacchi e trazioni. Se vuoi di più, in Home scegli il blocco core facoltativo (circa 14 minuti), una o due volte a settimana dopo una seduta di mobilità.');
    const small = byDesign.filter(r => r.group === 'Braccia' || r.group === 'Polpacci');
    if (small.length) advice.push(`${small.map(r => r.group).join(' e ')}: ${small.length > 1 ? 'ricevono' : 'riceve'} soprattutto lavoro indiretto (${small.map(r => r.group === 'Braccia' ? 'trazioni e spinte per le braccia' : 'squat e affondi per i polpacci').join(', ')}). Va bene così per il tuo obiettivo; se vuoi insistere, aggiungi 2-3 serie di un esercizio specifico con una seduta libera dal catalogo.`);
    const big = byDesign.filter(r => !['Core', 'Braccia', 'Polpacci'].includes(r.group));
    if (big.length) advice.push(`${big.map(r => r.group).join(', ')}: in questa fase (${meta.phase ? meta.phase.ph.name : 'programma'}) il programma distribuisce il volume su altri gruppi e li riprende nelle settimane successive. Nessun provvedimento, a meno che non si ripeta per più settimane di fila.`);
  }
  return { rows, advice, low, meta };
}

function volumeHtml(weekAbs, ana) {
  const a = ana || volumeAnalysis(weekAbs);
  if (!a.rows.length || !a.rows.some(r => r.sets > 0)) return '';
  const max = Math.max(VOL_TARGET + 2, ...a.rows.map(r => Math.max(r.sets, r.planned)));
  return a.rows.map(r => {
    const cls = r.sets < VOL_MIN ? 'low' : (r.sets >= VOL_TARGET ? 'good' : '');
    return `<div class="volrow">
      <span class="nm">${esc(r.group)}</span>
      <span class="volbar"><i class="${cls}" style="width:${Math.min(100, r.sets / max * 100)}%"></i>
        <span class="voltarget" style="left:${VOL_TARGET / max * 100}%"></span></span>
      <span class="val">${fmtSets(r.sets)}<small class="muted"> / ${fmtSets(r.planned)}</small></span></div>`;
  }).join('');
}

function openWeekReport(weekAbs) {
  const r = weekReport(weekAbs);
  if (!r.logs.length) {
    openModal(`<h2>Settimana ${weekAbs}</h2><p class="small muted">Nessun dato registrato in questa settimana.</p>
      <button class="btn secondary" id="wrClose" style="margin-top:14px">Chiudi</button>`);
    $('#wrClose').onclick = closeModal; return;
  }
  const medals = r.best.map((l, i) => `<div class="medal">
      <div class="pos">${i + 1}</div>
      <div class="nm" style="flex:1"><b>${esc(l.name)}</b>
        <div class="small muted">${esc(l.load || '—')} · ${esc(l.rateText || '')}</div></div>
      ${starsHtml(l.stars)}</div>`).join('');

  const cautions = r.warns.map(l => `<li><b>${esc(l.name)}</b> — ${esc(l.rateText)}${l.advice ? ' ' + esc(l.advice) : ''}</li>`).join('');
  const fatigue = r.hard.length >= 3
    ? `<li>${r.hard.length} esercizi segnati come più difficili del previsto: se si ripete la prossima settimana, tieni i carichi fermi e controlla sonno e recupero.</li>` : '';

  const tone = r.avg >= 4 ? 'Settimana sopra le attese: la progressione sta andando meglio del previsto.'
    : r.avg >= 3 ? 'Settimana in linea con il programma: è esattamente così che si costruisce.'
    : r.avg >= 2 ? 'Settimana di mantenimento: nessun passo indietro, e va benissimo così.'
    : 'Settimana in calo: capita, spesso dipende da sonno o stress. Riparti dal carico dell\'ultima seduta riuscita.';

  // volume per gruppo muscolare, con indicazioni pratiche se qualcosa è sotto soglia
  const ana = volumeAnalysis(weekAbs);
  const vol = volumeHtml(weekAbs, ana);
  const volAdvice = ana.advice.map(t => `<li>${esc(t)}</li>`).join('');

  openModal(`<h2>Riepilogo settimana ${weekAbs}</h2>
    <p class="small muted">${r.sessions} sedute completate · ${r.logs.length} esercizi registrati · media ${r.avg.toFixed(1)} stelle</p>
    <div style="margin:10px 0">${starsHtml(Math.round(r.avg))}</div>
    <p class="small">${tone}</p>
    ${medals ? `<div class="block" style="margin-top:16px"><h3 style="font-size:16px;color:var(--muted)">Migliori traguardi</h3>${medals}</div>` : ''}
    ${vol ? `<div class="block" style="margin-top:16px"><h3 style="font-size:16px;color:var(--muted)">Serie per gruppo muscolare</h3>
      <p class="small muted">Serie fatte / previste dal programma. Diretta = 1, indiretta = ½. Tacca a 10: volume ottimale; barra rossa sotto 5.</p>${vol}</div>` : ''}
    ${(cautions || fatigue || volAdvice) ? `<div class="block warnblock" style="margin-top:16px"><h3>Da tenere d'occhio</h3><ul>${cautions}${fatigue}${volAdvice}</ul></div>`
      : '<p class="small muted" style="margin-top:14px">Nessun incremento fuori scala e volume adeguato su tutti i gruppi.</p>'}
    ${S.autoBackup ? `<button class="btn" id="wrBackup" style="margin-top:18px">Salva il backup della settimana</button>
      <button class="btn ghost" id="wrOk" style="margin-top:10px">Chiudi</button>`
      : `<button class="btn" id="wrOk" style="margin-top:18px">Chiudi</button>`}`);
  if ($('#wrBackup')) $('#wrBackup').onclick = () => { exportData(); closeModal(); };
  $('#wrOk').onclick = closeModal;
}

function sparkline(vals) {
  if (vals.length < 2) return `<svg viewBox="0 0 86 34"><line x1="2" y1="30" x2="84" y2="30" stroke="#2B3B4E" stroke-width="2"/></svg>`;
  const min = Math.min(...vals), max = Math.max(...vals), r = (max - min) || 1;
  const pts = vals.map((v, i) => `${2 + i * (82 / (vals.length - 1))},${30 - ((v - min) / r) * 24}`).join(' ');
  return `<svg viewBox="0 0 86 34"><polyline points="${pts}" fill="none" stroke="#F5A524" stroke-width="2.4" stroke-linejoin="round"/></svg>`;
}

function detailFor(exId, logs) {
  const ex = exById(exId);
  const rows = logs.slice().reverse().map(l => {
    const r = isFinite(l.repsDone) ? l.repsDone : l.reps;
    const e = e1rm(l);
    const extra = [`${l.sets}×${r}`];
    if (isFinite(l.rir) && l.rir !== null) extra.push(`RIR ${l.rir}`);
    if (e) extra.push(`max ${e.toFixed(1)} kg`);
    extra.push(l.setup === 'gym' ? 'palestra' : 'casa');
    return `<li><div class="nm" style="flex:1"><b>${esc(l.load || '—')}</b>
      <div class="small muted">${new Date(l.ts).toLocaleDateString('it-IT')} · ${extra.join(' · ')}</div>
      ${l.rateText ? `<div class="small muted">${esc(l.rateText)}</div>` : ''}</div>
      <div class="val">${arrow(l.feedback)}<br>${starsHtml(l.stars)}</div></li>`;
  }).join('');
  openModal(`<h2>${esc(ex.name)}</h2>
    <div style="height:110px;margin:10px 0">${bigChart(logs)}</div>
    <ul class="hist">${rows}</ul>
    <button class="btn secondary" id="closeModal" style="margin-top:16px">Chiudi</button>
    <button class="btn ghost" id="wipeEx" style="margin-top:10px">Cancella lo storico di questo esercizio</button>`);
  $('#closeModal').onclick = closeModal;
  $('#wipeEx').onclick = () => confirmAction('Cancellare lo storico?',
    `Verranno eliminate le ${logs.length} registrazioni di ${ex.name}. Gli altri esercizi non vengono toccati e l'operazione non è reversibile.`,
    'Cancella', () => {
      S.logs = S.logs.filter(l => l.exId !== exId);
      save(); renderHistory();
    });
}
/* Grafico del dettaglio: due linee quando è possibile, il massimale stimato
   (piena) e il carico usato (tratteggiata), così si distingue un progresso di
   forza da un semplice aumento di peso. */
function bigChart(logs) {
  const met = logs.map(l => { const m = progressMetric(l); return m ? m.v : NaN; });
  const raw = logs.map(l => { const v = logValue(l); return v === null ? NaN : v; });
  const vals = met.filter(n => isFinite(n));
  if (vals.length < 2) return `<p class="small muted">Servono almeno due sedute registrate per il grafico.</p>`;
  const all = vals.concat(raw.filter(n => isFinite(n)));
  const min = Math.min(...all), max = Math.max(...all), r = (max - min) || 1;
  const X = i => 6 + i * (288 / (logs.length - 1 || 1));
  const Y = v => 96 - ((v - min) / r) * 80;
  const line = (arr, color, dash) => {
    const pts = arr.map((v, i) => isFinite(v) ? `${X(i)},${Y(v)}` : null).filter(Boolean).join(' ');
    return pts ? `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${dash ? 2 : 3}"
      stroke-linejoin="round" ${dash ? 'stroke-dasharray="5 4" opacity=".65"' : ''}/>` : '';
  };
  const showRaw = raw.some((v, i) => isFinite(v) && isFinite(met[i]) && Math.abs(v - met[i]) > 0.01);
  return `<svg viewBox="0 0 300 110" style="width:100%;height:100%" role="img"
      aria-label="Andamento del massimale stimato su ${vals.length} sedute">
    <line x1="6" y1="100" x2="294" y2="100" stroke="#2B3B4E" stroke-width="1.5"/>
    ${showRaw ? line(raw, '#93A7BC', true) : ''}
    ${line(met, '#F5A524', false)}
    <text x="6" y="14" fill="#93A7BC" font-size="11">${max.toFixed(1)}</text>
    <text x="6" y="96" fill="#93A7BC" font-size="11">${min.toFixed(1)}</text>
    ${showRaw ? '<text x="200" y="14" fill="#93A7BC" font-size="9">— max stimato · -- carico</text>' : ''}</svg>`;
}

/* ---------------------------------------------------------------------------
   CATALOGO ESERCIZI
   109 esercizi che prima si potevano incontrare solo dentro una seduta. Qui
   sono cercabili per nome, gruppo muscolare e attrezzatura, con la scheda
   completa a un tocco: utile anche in palestra, quando una macchina è occupata
   e serve capire cosa si sa fare al suo posto.
--------------------------------------------------------------------------- */
let catQuery = '', catFilter = 'tutti', catSetupOnly = true;

function catalogGroups() {
  const g = new Set(DB.exercises.map(e => e.group));
  return ['tutti'].concat(Array.from(g).sort((a, b) => a.localeCompare(b)));
}

function catalogList() {
  const q = catQuery.trim().toLowerCase();
  return DB.exercises.filter(e => {
    if (catSetupOnly && !e.setup.includes(S.setup)) return false;
    if (catFilter !== 'tutti' && e.group !== catFilter) return false;
    if (!q) return true;
    const hay = [e.name, e.group, (e.equipment || []).join(' '),
                 (e.primary || []).join(' '), (e.secondary || []).join(' ')].join(' ').toLowerCase();
    return q.split(/\s+/).every(w => hay.indexOf(w) >= 0);
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function renderCatalog() {
  $('#topTitle').textContent = 'Esercizi';
  const list = catalogList();
  $('#topChip').textContent = `${list.length} di ${DB.exercises.length}`;
  $('#topChip').className = 'chip';

  const chips = catalogGroups().map(g =>
    `<button data-cat="${esc(g)}" aria-pressed="${catFilter === g}">${g === 'tutti' ? 'Tutti' : esc(g)}</button>`).join('');

  const rows = list.map(ex => {
    const last = lastEntry(ex.id);
    return `<li data-catex="${ex.id}">
      <div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm"><b>${esc(ex.name)}</b>
        <div class="small muted">${esc(ex.group)} · ${esc((ex.equipment || []).join(', ') || 'corpo libero')}</div>
        ${last ? `<div class="why">ultima volta ${esc(last.load || '—')} · ${new Date(last.ts).toLocaleDateString('it-IT')}</div>` : ''}</div>
      <div class="chev">›</div></li>`;
  }).join('');

  $('#view-catalog').innerHTML = `
    <input class="search" id="catSearch" type="search" placeholder="Cerca per nome, muscolo o attrezzo"
           aria-label="Cerca un esercizio" value="${esc(catQuery)}">
    <div class="filters">${chips}</div>
    <div class="switch" style="border:0;padding-top:0">
      <span class="small muted">Solo esercizi disponibili ${S.setup === 'gym' ? 'in palestra' : 'a casa'}</span>
      <input type="checkbox" id="catSetup" ${catSetupOnly ? 'checked' : ''}></div>
    <div class="card"><ul class="picker">${rows || '<li><span class="small muted">Nessun esercizio corrisponde alla ricerca.</span></li>'}</ul></div>`;

  const inp = $('#catSearch');
  inp.oninput = () => {
    catQuery = inp.value;
    const pos = inp.selectionStart;
    renderCatalog();
    const el = $('#catSearch'); el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {}
  };
  document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { catFilter = b.dataset.cat; renderCatalog(); });
  $('#catSetup').onchange = e => { catSetupOnly = e.target.checked; renderCatalog(); };
  document.querySelectorAll('[data-catex]').forEach(li => li.onclick = () => openSheet(exById(li.dataset.catex), null, null));
}

/* ---------------------------------------------------------------------------
   SEDUTA LIBERA
   Allenamento fuori programma: si scelgono gli esercizi al momento, il timer e
   la registrazione dei carichi funzionano come sempre, ma la settimana del
   programma non avanza. Serve a non perdere i dati di una sessione improvvisata.
--------------------------------------------------------------------------- */
function buildFreeSession(exIds) {
  const meta = sessionMeta(S.sessionIndex);
  const items = exIds.map(id => {
    const ex = exById(id);
    const goalKey = ex.type === 'stretch' ? 'stretch' : (ex.type === 'core' ? 'core' : 'hypertrophy');
    return Object.assign({ exId: id, note: 'Seduta libera', goalKey,
      alt: { patterns: [ex.pattern], types: [ex.type] } }, dose(goalKey, meta.profile, ex));
  });
  return Object.assign({}, meta, {
    label: 'Seduta libera', type: 'free', kind: 'free', items,
    minutes: estimateMinutes(items), trimmed: false
  });
}

function openFreeSession() {
  let picked = [];
  const draw = () => {
    const list = catalogList().slice(0, 60);
    const rows = list.map(ex => `<li class="${picked.indexOf(ex.id) >= 0 ? 'cur' : ''}" data-freeex="${ex.id}">
      <div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm"><b>${esc(ex.name)}</b>
        <div class="small muted">${esc(ex.group)} · ${esc((ex.equipment || []).join(', ') || 'corpo libero')}</div></div>
      <button class="pick">${picked.indexOf(ex.id) >= 0 ? '✓ scelto' : 'Aggiungi'}</button></li>`).join('');
    openModal(`<h2>Seduta libera</h2>
      <p class="small muted">Scegli gli esercizi che vuoi fare adesso. Timer e registrazione funzionano normalmente, ma la settimana del programma non avanza.</p>
      <input class="search" id="freeSearch" type="search" placeholder="Cerca un esercizio" value="${esc(catQuery)}">
      <ul class="picker">${rows}</ul>
      <button class="btn" id="freeGo" ${picked.length ? '' : 'disabled'}>Inizia con ${picked.length} eserciz${picked.length === 1 ? 'io' : 'i'}</button>
      <button class="btn ghost" id="freeNo" style="margin-top:10px">Annulla</button>`);
    const fi = $('#freeSearch');
    fi.oninput = () => { catQuery = fi.value; draw(); setTimeout(() => { const e2 = $('#freeSearch'); if (e2) e2.focus(); }, 10); };
    document.querySelectorAll('[data-freeex]').forEach(li => li.onclick = () => {
      const id = li.dataset.freeex, i = picked.indexOf(id);
      if (i >= 0) picked.splice(i, 1); else picked.push(id);
      draw();
    });
    $('#freeGo').onclick = () => { if (picked.length) closeModal(() => startSession(buildFreeSession(picked))); };
    $('#freeNo').onclick = () => closeModal();
  };
  draw();
}

/* ---------- programma e impostazioni ---------- */
function renderSettings() {
  const p = program(), meta = sessionMeta(S.sessionIndex);
  $('#topTitle').textContent = 'Programma';
  $('#topChip').textContent = p.name;
  $('#topChip').className = 'chip';
  $('#view-settings').innerHTML = `
    <div class="card">
      <h2>Programma attivo</h2>
      <div class="field"><label>Ciclo di allenamento</label>
        <select id="progSel">${PROG.programs.map(x =>
          `<option value="${x.id}" ${x.id === S.programId ? 'selected' : ''}>${esc(x.name)} · ${x.cycleWeeks} settimane</option>`).join('')}</select></div>
      <p class="small muted">${esc(p.summary)}</p>
      <p class="small muted">Periodizzazione: ${esc(p.periodization)}.</p>
      <p class="small muted">Per scegliere quale seduta svolgere o cambiarne l'ordine, usa il calendario della settimana nella schermata Oggi.</p>
    </div>

    <div class="card">
      <h2>Dove sei nel programma</h2>
      <p class="small muted">Prossima seduta prevista: <b>sessione ${meta.pos} di 5 della settimana ${meta.weekAbs}</b>${meta.phase ? ' · fase ' + esc(meta.phase.ph.name) : ''}.
        Sedute di programma registrate finora: ${countProgramSessions()}.</p>
      <div class="btn-row" style="margin-top:12px">
        <div class="field" style="flex:1;margin:0"><label>Settimana</label>
          <select id="posWeek">${Array.from({ length: Math.max(12, meta.weekAbs + 4) }, (_, i) => i + 1).map(w =>
            `<option value="${w}" ${w === meta.weekAbs ? 'selected' : ''}>Settimana ${w}</option>`).join('')}</select></div>
        <div class="field" style="flex:1;margin:0"><label>Sessione</label>
          <select id="posDay">${[1, 2, 3, 4, 5].map(d =>
            `<option value="${d}" ${d === meta.pos ? 'selected' : ''}>Sessione ${d} · ${sessionMeta((meta.weekAbs - 1) * 5 + d - 1).isStrength ? 'potenziamento' : 'mobilità'}</option>`).join('')}</select></div>
      </div>
      <button class="btn ghost" id="posSet" style="margin-top:10px">Imposta questa posizione</button>
      <button class="btn ghost" id="posAuto" style="margin-top:10px">Ricalcola dalle sedute registrate</button>
    </div>

    <div class="card">
      <h2>Settimane di sola mobilità</h2>
      <p class="small muted">Quando non puoi andare in sala pesi, tutte e cinque le sedute della settimana diventano mobilità e stretching.
        Il programma di forza non perde nulla: <b>slitta in avanti</b>, e riprende esattamente da dove era rimasto.</p>
      ${(S.mobilityWeeks || []).length
        ? `<p class="small">Impostate: ${S.mobilityWeeks.slice().sort((a, b) => a - b).map(w => 'settimana ' + w).join(', ')}.</p>`
        : '<p class="small muted">Nessuna settimana impostata.</p>'}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn ghost" id="mobNext">Solo mobilità la prossima settimana</button>
        <button class="btn ghost" id="mobThis">…questa settimana</button>
      </div>
      ${(S.mobilityWeeks || []).length
        ? `<button class="btn ghost" id="mobClear" style="margin-top:10px">Annulla tutte</button>` : ''}
      <p class="small muted" style="margin-top:8px">Serve quando l'indice non corrisponde più a ciò che hai davvero svolto, per esempio dopo aver saltato una seduta senza registrarla. Lo storico dei carichi non viene toccato.</p>
    </div>

    <div class="card">
      <h2>Profilo</h2>
      <div class="switch"><span>Attrezzatura predefinita</span>
        <select id="setupSel" style="width:150px;min-height:44px;background:var(--surface2);border:1px solid var(--line);border-radius:10px;padding:0 10px">
          <option value="gym" ${S.setup === 'gym' ? 'selected' : ''}>Palestra</option>
          <option value="home" ${S.setup === 'home' ? 'selected' : ''}>Casa</option></select></div>
      <div class="switch"><span>Priorità agli esercizi che proteggono il ginocchio</span>
        <input type="checkbox" id="kneeChk" ${S.kneeCare ? 'checked' : ''}></div>
      <div class="switch"><span>Escludi gli esercizi critici per la spalla (conflitto subacromiale)</span>
        <input type="checkbox" id="shoulderChk" ${S.shoulderCare ? 'checked' : ''}></div>
      <div class="switch"><span>Obiettivo trazioni alla sbarra<br><span class="small muted">Blocco dedicato in apertura delle tre sedute di forza</span></span>
        <input type="checkbox" id="pullChk" ${S.pullupGoal ? 'checked' : ''}></div>
      <div class="switch"><span>Campanella del timer</span>
        <input type="checkbox" id="soundChk" ${S.sound !== false ? 'checked' : ''}></div>

      <div class="switch" style="border:0"><span>Schermo sempre acceso</span><span class="small muted" id="wlStatus">—</span></div>
      <button class="btn ghost" id="testSound" style="margin-top:12px">Prova la campanella</button>
      <p class="small muted" style="margin-top:8px">La campanella si sovrappone a Spotify o YouTube abbassandoli per il tempo di un rintocco, senza mai metterli in pausa. Perché si senta, la modalità silenziosa dell'iPhone deve essere disattivata: tocca "Prova la campanella" e alza il volume con i tasti laterali mentre suona.</p>
    </div>

    <div class="card">
      <h2>Dati</h2>
      <p class="small muted">${S.lastExport ? 'Ultimo salvataggio: ' + new Date(S.lastExport).toLocaleDateString('it-IT') : 'Non hai ancora salvato un backup.'} ${S.logs.length} esercizi e ${S.sessionLog.length} sedute registrate su questo telefono.</p>
      <p class="small muted">Archiviazione: ${idbReady ? 'database locale' : 'memoria del browser'} ·
        ${storagePersisted === true ? 'protetta dalle pulizie automatiche'
          : storagePersisted === false ? 'non protetta: il sistema ha negato la richiesta'
          : 'protezione non disponibile su questo browser'}.</p>
      <div class="switch"><span>Istantanea automatica a fine settimana</span>
        <input type="checkbox" id="backupChk" ${S.autoBackup ? 'checked' : ''}></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn ghost" id="exportBtn">Esporta JSON</button>
        <button class="btn ghost" id="csvBtn">Esporta CSV</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="importBtn">Importa backup</button>
        <button class="btn ghost" id="resetBtn">Azzera tutto</button>
      </div>
      <input type="file" id="importFile" accept="application/json,.json" style="display:none">
      ${(S.snapshots || []).length ? `<div style="margin-top:14px">
        <h3 style="font-size:15px;color:var(--muted);font-family:var(--sans)">Istantanee conservate</h3>
        ${S.snapshots.slice().reverse().map((sn, i) => {
          const realIdx = S.snapshots.length - 1 - i;
          return `<button class="btn ghost" data-snap="${realIdx}" style="margin-top:8px">Fine settimana ${sn.week} · ${sn.logs} esercizi · ${new Date(sn.ts).toLocaleDateString('it-IT')}</button>`;
        }).join('')}</div>` : ''}
      <div class="notice" style="margin-top:12px">Su iPhone, se rimuovi l'icona dell'app dalla schermata Home, iOS cancella anche i dati salvati al suo interno. Le istantanee vivono nella stessa memoria: per essere al sicuro serve un backup esportato fuori dall'app, che il riepilogo di fine settimana ti propone da solo.</div>
    </div>

    <div class="card flat">
      <h2>Avvertenza</h2>
      <p class="small muted">Questa app propone programmi generici costruiti sulle linee guida ACSM, NSCA, ACE e OMS per adulti sani. Non sostituisce una valutazione medica. Prima di iniziare, e in particolare per la sensibilità al ginocchio, consulta un medico o un fisioterapista. Interrompi subito in caso di dolore acuto, vertigini o dolore toracico.</p>
    </div>`;

  const setMobWeek = w => {
    const list = (S.mobilityWeeks || []).slice();
    const i = list.indexOf(w);
    if (i >= 0) { list.splice(i, 1); }
    else list.push(w);
    S.mobilityWeeks = list; planCache = null; save(); renderSettings();
  };
  $('#mobNext').onclick = () => {
    const w = meta.weekAbs + 1;
    confirmAction(isMobilityWeek(w) ? 'Ripristinare la settimana normale?' : 'Solo mobilità la prossima settimana?',
      isMobilityWeek(w)
        ? `La settimana ${w} tornerà a prevedere tre sedute di potenziamento e due di mobilità.`
        : `Nella settimana ${w} tutte e cinque le sedute saranno di mobilità e stretching. Il programma di forza slitta di una settimana: non perdi nulla.`,
      isMobilityWeek(w) ? 'Ripristina' : 'Imposta', () => setMobWeek(w));
  };
  $('#mobThis').onclick = () => {
    const w = meta.weekAbs;
    confirmAction(isMobilityWeek(w) ? 'Ripristinare la settimana normale?' : 'Solo mobilità questa settimana?',
      isMobilityWeek(w)
        ? `La settimana ${w} tornerà a prevedere tre sedute di potenziamento e due di mobilità.`
        : `Nella settimana ${w} tutte e cinque le sedute saranno di mobilità e stretching. Il programma di forza slitta di una settimana: non perdi nulla.`,
      isMobilityWeek(w) ? 'Ripristina' : 'Imposta', () => setMobWeek(w));
  };
  if ($('#mobClear')) $('#mobClear').onclick = () => confirmAction('Annullare tutte le settimane di sola mobilità?',
    'Le settimane interessate torneranno a prevedere tre sedute di potenziamento e due di mobilità.',
    'Annulla tutte', () => { S.mobilityWeeks = []; planCache = null; save(); renderSettings(); });
  $('#posSet').onclick = () => {
    const w = +$('#posWeek').value, d = +$('#posDay').value;
    const idx = (w - 1) * 5 + (d - 1);
    const alt = buildSession(idx);
    confirmAction('Spostare la posizione nel programma?',
      `La prossima seduta diventerà "${alt.label}", sessione ${d} di 5 della settimana ${w}. Lo storico dei carichi e le valutazioni restano invariati.`,
      'Imposta', () => { S.sessionIndex = idx; planCache = null; homeSel = 'session'; save(); renderSettings(); });
  };
  $('#posAuto').onclick = () => {
    const n = countProgramSessions();
    const alt = buildSession(n);
    confirmAction('Ricalcolare la posizione?',
      `Risultano ${n} sedute di programma registrate, quindi la prossima sarebbe "${alt.label}", ` +
      `sessione ${(n % 5) + 1} di 5 della settimana ${Math.floor(n / 5) + 1}. Blocchi core e sedute libere non contano.`,
      'Allinea alla cronologia', () => { S.sessionIndex = n; realignHistory(); planCache = null; homeSel = 'session'; save(); renderSettings(); });
  };
  $('#progSel').onchange = e => { S.programId = e.target.value; save(); renderSettings(); };
  $('#setupSel').onchange = e => { S.setup = e.target.value; save(); };
  $('#kneeChk').onchange = e => { S.kneeCare = e.target.checked; save(); };
  $('#pullChk').onchange = e => { S.pullupGoal = e.target.checked; planCache = null; save(); };
  $('#shoulderChk').onchange = e => { S.shoulderCare = e.target.checked; planCache = null; save(); };
  $('#soundChk').onchange = e => { S.sound = e.target.checked; save(); if (e.target.checked) testBells(); };
  $('#testSound').onclick = testBells;
  $('#backupChk').onchange = e => { S.autoBackup = e.target.checked; save(); };
  $('#csvBtn').onclick = () => dangerAction('Esportare i dati in CSV?',
    `Verrà creato un foglio con ${S.logs.length} righe, una per esercizio registrato, apribile in Numbers o Excel. Il file finisce nei Download del telefono: chiunque vi acceda può leggerlo.`,
    'Esporta il CSV', exportCsv);
  document.querySelectorAll('[data-snap]').forEach(b => b.onclick = () => restoreSnapshot(+b.dataset.snap));
  $('#exportBtn').onclick = () => dangerAction('Esportare i tuoi dati?',
    `Verrà creato un file con ${S.logs.length} esercizi registrati, ${S.sessionLog.length} sedute e le tue impostazioni. Il file finisce nei Download del telefono: chiunque vi acceda può leggerlo.`,
    'Esporta il backup', exportData);
  $('#importBtn').onclick = () => dangerAction('Importare un backup?',
    `Il file scelto sostituirà i dati ora presenti sul telefono: ${S.logs.length} esercizi registrati e ${S.sessionLog.length} sedute andranno persi. Se ti servono ancora, esporta prima un backup.`,
    'Scegli il file da importare', () => $('#importFile').click());
  $('#importFile').onchange = e => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  $('#resetBtn').onclick = () => dangerAction('Azzerare tutto?',
    `Verranno cancellati ${S.logs.length} esercizi registrati, ${S.sessionLog.length} sedute, le valutazioni e le impostazioni. L'operazione non è reversibile e nessun dato è conservato altrove.`,
    'Azzera definitivamente',
    () => { localStorage.removeItem(KEY); load(); planCache = null; go('home'); });
  $('#wlStatus').textContent = ('wakeLock' in navigator) ? 'attivo durante le sessioni' : 'non supportato su questo browser';
}

/* Scarica un file, oppure lo passa al foglio di condivisione di iOS quando
   disponibile: da lì può finire su iCloud Drive o in una mail a sé stessi. */
async function deliverFile(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return true;
    }
  } catch (e) { /* condivisione annullata: si ricade sul download */ }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}

function exportData() {
  S.lastExport = Date.now(); save();
  deliverFile(`palestra50-${new Date().toISOString().slice(0, 10)}.json`,
              JSON.stringify(S, null, 2), 'application/json');
  renderSettings();
}

/* Esportazione in CSV: una riga per esercizio registrato, apribile in Numbers
   o Excel. Serve ad avere dati di cui si può fare qualcosa fuori dall'app. */
function exportCsv() {
  const q = v => {
    const t = String(v === null || v === undefined ? '' : v);
    return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const head = ['data', 'ora', 'settimana', 'esercizio', 'gruppo', 'attrezzatura',
                'carico', 'serie', 'rip_obiettivo', 'rip_eseguite', 'rir',
                'max_stimato_kg', 'stelle', 'obiettivo', 'nota_valutazione'];
  const rows = S.logs.map(l => {
    const ex = exById(l.exId), d = new Date(l.ts), e = e1rm(l);
    return [
      d.toLocaleDateString('it-IT'), d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
      l.sIdx != null ? Math.floor(l.sIdx / 5) + 1 : '',
      l.name, ex ? ex.group : '', l.setup === 'gym' ? 'palestra' : 'casa',
      l.load, l.sets, l.repsTarget != null ? l.repsTarget : l.reps,
      l.repsDone != null ? l.repsDone : '', l.rir != null ? l.rir : '',
      e ? e.toFixed(1) : '', l.stars || '', l.goal || '', l.rateText || ''
    ].map(q).join(';');
  });
  const csv = '﻿' + [head.join(';')].concat(rows).join('\n');   // BOM per Excel
  deliverFile(`palestra50-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
}

/* ---------------------------------------------------------------------------
   BACKUP AUTOMATICO
   A settimana conclusa l'app conserva un'istantanea dei dati (le ultime tre) e
   propone il salvataggio esterno nel momento in cui hai già in mano il
   telefono, cioè con il riepilogo aperto. Un backup che non dipende dalla
   memoria dell'utente è l'unica difesa reale contro la perdita dei dati.
--------------------------------------------------------------------------- */
function takeSnapshot(weekAbs) {
  if (!S.autoBackup) return;
  const snap = {
    ts: Date.now(), week: weekAbs, logs: S.logs.length, sessions: S.sessionLog.length,
    data: JSON.stringify(Object.assign({}, S, { snapshots: [], resume: null }))
  };
  S.snapshots = (S.snapshots || []).filter(x => x.week !== weekAbs);
  S.snapshots.push(snap);
  while (S.snapshots.length > 3) S.snapshots.shift();   // solo le ultime tre
  save();
}

function restoreSnapshot(i) {
  const snap = S.snapshots[i];
  if (!snap) return;
  dangerAction('Ripristinare questa istantanea?',
    `Tornerai ai dati di fine settimana ${snap.week} (${snap.logs} esercizi, ${snap.sessions} sedute). ` +
    'Quanto registrato dopo quella data andrà perso.',
    'Ripristina', () => {
      try {
        const data = JSON.parse(snap.data);
        const keep = S.snapshots;
        S = Object.assign({}, DEFAULT_STATE, data);
        S.snapshots = keep;
        planCache = null; save(); go('home');
      } catch (e) {}
    });
}

/* Importa un backup esportato in precedenza: sostituisce i dati correnti dopo
   conferma, perché su iOS i dati di un'app rimossa dalla Home vengono
   cancellati e questo è l'unico modo per recuperarli. */
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { openModal(`<h2>File non valido</h2><p class="small muted">Il file scelto non è un backup JSON di Palestra 50.</p><button class="btn secondary" id="impClose" style="margin-top:14px">Chiudi</button>`); $('#impClose').onclick = closeModal; return; }
    if (!data || !Array.isArray(data.logs)) {
      openModal(`<h2>File non valido</h2><p class="small muted">Il file non sembra un backup di Palestra 50.</p><button class="btn secondary" id="impClose2" style="margin-top:14px">Chiudi</button>`);
      $('#impClose2').onclick = closeModal; return;
    }
    confirmAction('Ripristinare questo backup?',
      `Contiene ${data.logs.length} esercizi registrati e ${(data.sessionLog || []).length} sedute. I dati attualmente sul telefono verranno sostituiti.`,
      'Ripristina', () => {
        S = Object.assign({}, DEFAULT_STATE, data);
        save(); planCache = null; go('home'); renderSettings();
      });
  };
  reader.readAsText(file);
}

/* ---------------------------------------------------------------------------
   7. TIMER, AUDIO, WAKE LOCK
--------------------------------------------------------------------------- */
/* --- CAMPANELLE (riscritte da zero) -----------------------------------------
   Idea di fondo: invece di programmare molti suoni con dei timer — soluzione
   che su iOS produce rintocchi sfasati e, con l'app in secondo piano, nessun
   suono — l'app costruisce UNA sola traccia audio che contiene già il silenzio
   e i rintocchi nei punti esatti, e la manda in riproduzione all'avvio del
   timer. Da lì in poi il tempo lo tiene il motore audio del telefono:
     · i rintocchi cadono precisi al campione, mai accavallati;
     · continuano se apri un'altra schermata dell'app;
     · continuano finché iOS lascia proseguire la riproduzione in background.
   La sessione audio è dichiarata 'ambient': si mescola all'audio delle altre
   app, quindi Spotify o YouTube non vengono mai interrotti né abbassati, e la
   campanella si sovrappone alla musica.
----------------------------------------------------------------------------- */
const BELL_SR = 8000;            // basta per una campana a 880 Hz
const BELL_LOW = 880;            // rintocco dei secondi
const BELL_HIGH = 1319;          // colpo di via e colpo finale

let bellTrack = null, bellUrl = null;

function setAudioSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
  } catch (e) {}
}

/* Scrive l'intestazione WAV e restituisce la vista sui campioni. */
function wavBuffer(samples) {
  const bytes = new Uint8Array(44 + samples * 2), dv = new DataView(bytes.buffer);
  const wr = (o, t) => { for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + samples * 2, true); wr(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, BELL_SR, true); dv.setUint32(28, BELL_SR * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, samples * 2, true);
  return { bytes, dv };
}

/* Disegna un singolo rintocco nella traccia, a partire dal secondo indicato.
   Una sola sinusoide: una campana per volta, nessuna sovrapposizione. */
function renderTock(dv, total, atSec, high) {
  const f = high ? BELL_HIGH : BELL_LOW;
  const dur = high ? 1.1 : 0.55, decay = high ? 4.2 : 7;
  let i0 = Math.round(atSec * BELL_SR);
  if (i0 < 0) return;
  const n = Math.min(Math.round(dur * BELL_SR), total - i0);
  for (let i = 0; i < n; i++) {
    const t = i / BELL_SR;
    const attack = Math.min(1, t / 0.005);
    const v = Math.sin(2 * Math.PI * f * t) * attack * Math.exp(-t * decay) * 0.97;
    dv.setInt16(44 + (i0 + i) * 2, v * 32767, true);
  }
}

/* ---------------------------------------------------------------------------
   COSTRUZIONE DELLA TRACCIA — fuori dal thread principale
   Generare il WAV campione per campione costa: circa 1,4 MB per un recupero di
   90 secondi. Farlo nel thread principale bloccava l'interfaccia proprio nel
   momento in cui si preme "Ho finito la serie". Qui il lavoro va in un Web
   Worker creato al volo (nessun file aggiuntivo da pubblicare) e i formati
   ricorrenti vengono tenuti in memoria e riutilizzati: dopo la prima serie la
   traccia è già pronta. Se i Worker non sono disponibili si costruisce come
   prima, in modo sincrono.
--------------------------------------------------------------------------- */
const BELL_CACHE_MAX = 10;
let bellCache = [], bellWorker = null;

/* ---------------------------------------------------------------------------
   DOVE CADONO I RINTOCCHI
   Il timer è una catena di segmenti: preparazione, tenuta, pausa, tenuta, …,
   recupero conclusivo. La campanella suona:
     · nei 3 secondi che precedono l'inizio di ogni tenuta (fine della
       preparazione o della pausa fra una tenuta e l'altra), con il colpo
       acuto di "via";
     · negli ultimi 3 secondi di ogni recupero, con il colpo acuto finale;
     · con un solo colpo acuto alla fine di ogni tenuta: "puoi rilasciare".
   I rintocchi troppo vicini a un colpo appena suonato vengono omessi, così una
   pausa brevissima non produce mai campane sovrapposte.
--------------------------------------------------------------------------- */
function marksOf(segs) {
  const raw = [];
  segs.forEach(s => {
    if (s.kind === 'work') { raw.push([s.end, true]); return; }
    for (let k = 3; k >= 1; k--) if (s.end - k >= s.start - 0.001) raw.push([s.end - k, false]);
    raw.push([s.end, true]);
  });
  raw.sort((a, b) => a[0] - b[0] || (b[1] - a[1]));
  const out = [];
  raw.forEach(m => {
    if (m[0] < 0) return;
    const p = out[out.length - 1];
    if (p && Math.abs(p[0] - m[0]) < 0.01) { if (m[1]) p[1] = true; return; }
    if (p && p[1] && m[0] - p[0] < 0.9 && !m[1]) return;      // dentro la coda del colpo acuto
    out.push([Math.round(m[0] * 100) / 100, m[1]]);
  });
  return out;
}

/* Segmenti in secondi relativi, a partire da durate [{kind, dur}]. */
function relSegs(defs) {
  let t = 0;
  return defs.map(d => { const s = { kind: d.kind, start: t, end: t + d.dur }; t = s.end; return s; });
}
const specOf = segs => ({ marks: marksOf(segs), total: segs.length ? segs[segs.length - 1].end : 0 });

/* Corpo del worker: costruisce il WAV con i rintocchi nei punti indicati. */
function bellWorkerSource() {
  return `
const SR=${BELL_SR}, LOW=${BELL_LOW}, HIGH=${BELL_HIGH};
function build(marks,len){
  const total=Math.ceil((len+1.3)*SR);
  const bytes=new Uint8Array(44+total*2), dv=new DataView(bytes.buffer);
  const wr=(o,t)=>{for(let i=0;i<t.length;i++)bytes[o+i]=t.charCodeAt(i);};
  wr(0,'RIFF');dv.setUint32(4,36+total*2,true);wr(8,'WAVEfmt ');
  dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);
  dv.setUint32(24,SR,true);dv.setUint32(28,SR*2,true);
  dv.setUint16(32,2,true);dv.setUint16(34,16,true);
  wr(36,'data');dv.setUint32(40,total*2,true);
  marks.forEach(m=>{
    const f=m[1]?HIGH:LOW, d=m[1]?1.1:0.55, dec=m[1]?4.2:7;
    const i0=Math.round(m[0]*SR); if(i0<0) return;
    const n=Math.min(Math.round(d*SR), total-i0);
    for(let i=0;i<n;i++){
      const t=i/SR, at=Math.min(1,t/0.005);
      dv.setInt16(44+(i0+i)*2, Math.sin(2*Math.PI*f*t)*at*Math.exp(-t*dec)*0.97*32767, true);
    }
  });
  return bytes;
}
self.onmessage = e => {
  const {marks,total,id} = e.data;
  const bytes = build(marks,total);
  self.postMessage({id, buf: bytes.buffer}, [bytes.buffer]);
};`;
}

function getBellWorker() {
  if (bellWorker !== null) return bellWorker;
  try {
    const url = URL.createObjectURL(new Blob([bellWorkerSource()], { type: 'text/javascript' }));
    bellWorker = new Worker(url);
  } catch (e) { bellWorker = false; }
  return bellWorker;
}

/* Versione sincrona, usata come ricaduta. */
function bellTrackFor(spec) {
  const total = Math.ceil((spec.total + 1.3) * BELL_SR);
  const { bytes, dv } = wavBuffer(total);
  spec.marks.forEach(m => renderTock(dv, total, m[0], m[1]));
  return new Blob([bytes], { type: 'audio/wav' });
}

const bellKey = spec => `${Math.round(spec.total * 100)}|` + spec.marks.map(m => m[0] + (m[1] ? 'h' : '')).join(',');
function cachedTrack(spec) {
  const k = bellKey(spec);
  const hit = bellCache.find(x => x.k === k);
  return hit ? hit.url : null;
}
function cacheTrack(spec, url) {
  const k = bellKey(spec);
  if (bellCache.some(x => x.k === k)) { URL.revokeObjectURL(url); return; }
  bellCache.push({ k, url });
  while (bellCache.length > BELL_CACHE_MAX) {
    const old = bellCache.shift();
    try { URL.revokeObjectURL(old.url); } catch (e) {}
  }
}

/* Restituisce l'URL della traccia, dal riuso o costruendola. */
function trackUrl(spec, cb) {
  const hit = cachedTrack(spec);
  if (hit) return cb(hit, true);
  const w = getBellWorker();
  if (w) {
    const id = Math.random().toString(36).slice(2);
    const onMsg = e => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', onMsg);
      const url = URL.createObjectURL(new Blob([new Uint8Array(e.data.buf)], { type: 'audio/wav' }));
      cacheTrack(spec, url);
      cb(url, false);
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ marks: spec.marks, total: spec.total, id });
    return;
  }
  const url = URL.createObjectURL(bellTrackFor(spec));
  cacheTrack(spec, url);
  cb(url, false);
}

/* Le sequenze che ricorrono nella seduta, preparate in anticipo: dopo la
   prima serie nessun avvio paga più l'attesa della costruzione. */
function prewarmBells(items) {
  const specs = new Map();
  const add = defs => { const sp = specOf(relSegs(defs)); specs.set(bellKey(sp), sp); };
  (items || []).forEach((it, i) => {
    const ex = exById(it.exId);
    if (!ex) return;
    const last = i === items.length - 1;
    if (isTimedItem(it, ex)) add(holdChainDefs(it, ex, 0, last));
    else {
      add([{ kind: 'rest', dur: it.rest }]);
      if (!last) add([{ kind: 'rest', dur: finalRestOf(it, ex) }]);
    }
  });
  Array.from(specs.values()).slice(0, BELL_CACHE_MAX).forEach(sp => trackUrl(sp, () => {}));
}

let bellPlayToken = 0;

function stopBells() {
  bellPlayToken++;
  if (bellTrack) { try { bellTrack.pause(); } catch (e) {} }
  bellTrack = null;               // gli URL restano in cache per il riuso
}

/* Avvia la traccia. offset = secondi già trascorsi (per riallineare al rientro
   in primo piano). */
function playBells(spec, offset) {
  stopBells();
  if (S && S.sound === false) return;
  const token = bellPlayToken;
  setAudioSession();
  trackUrl(spec, url => {
    if (token !== bellPlayToken) return;          // nel frattempo il timer è cambiato
    try {
      bellTrack = new Audio(url);
      bellTrack.preload = 'auto';
      bellTrack.volume = 1;
      const seek = () => { try { if (offset > 0) bellTrack.currentTime = offset; } catch (e) {} };
      bellTrack.addEventListener('loadedmetadata', seek, { once: true });
      seek();
      const p = bellTrack.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  });
}

/* Riallinea la traccia al contatore: usata al rientro in primo piano. */
function resyncBells(elapsed) {
  if (!bellTrack) return;
  try {
    if (Math.abs(bellTrack.currentTime - elapsed) > 0.35) bellTrack.currentTime = elapsed;
    if (bellTrack.paused) { const p = bellTrack.play(); if (p && p.catch) p.catch(() => {}); }
  } catch (e) {}
}

/* Prova della campanella dalle impostazioni: tre rintocchi e colpo di via. */
function testBells() {
  playBells(specOf(relSegs([{ kind: 'prep', dur: 4 }])), 0);
}

/* Sblocco dell'audio al primo tocco dell'utente, richiesto da Safari. */
function unlockAudio() { setAudioSession(); }

/* --- ESERCIZI A TEMPO -------------------------------------------------------
   Regole comuni a schermata, catena del timer e preparazione delle tracce.
--------------------------------------------------------------------------- */
const isTimedItem = (it, ex) => it.goal === 'stretch' || it.hold > 0 || ex.load === 'time';
const holdOf = (it, ex) => it.hold ? it.hold : (ex.load === 'time' ? 20 + it.reps : 30);
/* recupero che chiude l'esercizio: un po' più lungo di quello fra le serie,
   il tempo di preparare l'attrezzo o la posizione successiva */
const finalRestOf = (it, ex) => Math.max(it.rest, ex.type === 'stretch' ? 30 : 45);

/* Catena delle tenute da "from" serie già fatte: preparazione di 3 s, poi
   tenuta / pausa / tenuta … e, se non è l'ultimo esercizio, il recupero
   conclusivo. */
function holdChainDefs(it, ex, from, isLast) {
  const hold = holdOf(it, ex), n = Math.max(0, it.sets - from);
  const defs = [{ kind: 'prep', dur: 3 }];
  for (let k = 0; k < n; k++) {
    defs.push({ kind: 'work', dur: hold, set: from + k });
    if (k < n - 1) defs.push({ kind: 'rest', dur: it.rest });
  }
  if (!isLast) defs.push({ kind: 'rest', dur: finalRestOf(it, ex), final: true });
  return defs;
}

/* --- TIMER ------------------------------------------------------------------
   Un solo timer per tutta l'app, organizzato come CATENA DI SEGMENTI:
     'prep' → 3 secondi per mettersi in posizione
     'work' → tenuta a tempo (stretching statico, plank, wall sit)
     'rest' → pausa fra serie o recupero che chiude l'esercizio
   Il timer passa da un segmento all'altro da solo; ogni segmento può eseguire
   un'azione all'inizio (onStart) e alla fine (onEnd). Il tempo è calcolato
   sull'orologio, non sul numero di tick: se iOS sospende la pagina, al rientro
   i segmenti scaduti vengono chiusi nell'ordine giusto.
   Può essere ridotto a barretta: continua a girare mentre si naviga.
----------------------------------------------------------------------------- */
let chain = null;

function runChain(defs, opts) {
  stopTimer();
  const t0 = Date.now();
  let t = t0;
  const segs = defs.map(d => {
    const s = Object.assign({}, d, { start: t, end: t + d.dur * 1000 });
    t = s.end; return s;
  });
  chain = { segs, idx: 0, audioT0: t0 };
  const mini = opts && opts.mini;
  $('#timer').classList.toggle('on', !mini);
  $('#miniTimer').classList.toggle('on', !!mini);
  document.body.classList.toggle('mini-on', !!mini);
  unlockAudio();
  playBells(specOf(relSegs(defs)), 0);           // una sola traccia per tutta la catena
  enterSeg();
  timerHandle = setInterval(tick, 100);
  tick();
}

/* Compatibilità: timer semplice, eventualmente preceduto da una preparazione. */
function startTimer(seconds, what, cb, mode, lead, opts) {
  const defs = [];
  if (lead) defs.push({ kind: 'prep', dur: lead, what });
  defs.push({ kind: mode || 'rest', dur: seconds, what, onEnd: cb || null });
  runChain(defs, opts);
}

/* Ricostruisce la traccia dal momento attuale, dopo uno spostamento dei tempi. */
function restartBells() {
  if (!chain) return;
  const now = Date.now();
  chain.audioT0 = now;
  const segs = chain.segs.slice(chain.idx).map(s => ({
    kind: s.kind, start: (s.start - now) / 1000, end: (s.end - now) / 1000 }));
  playBells(specOf(segs), 0);
}

function enterSeg() {
  const seg = chain.segs[chain.idx];
  const next = chain.segs[chain.idx + 1];
  const what = seg.what || '';
  $('#timerWhat').textContent = (seg.kind === 'prep' ? 'Preparati · ' : '') + what;
  $('#miniWhat').textContent = what;
  const work = seg.kind === 'work';
  $('#timer').classList.toggle('work', work);
  $('#miniTimer').classList.toggle('work', work);
  $('#timerSkip').textContent = seg.kind === 'prep' ? 'Parti ora'
    : work ? 'Termina la tenuta'
    : (next ? 'Accorcia la pausa' : 'Riprendi ora');
  if (seg.onStart) seg.onStart();
}

function tick() {
  if (!chain) return;
  const now = Date.now();
  let redrawn = false;
  // chiude in ordine tutti i segmenti scaduti (anche più d'uno, al rientro)
  while (chain && chain.idx < chain.segs.length && now >= chain.segs[chain.idx].end) {
    const ch = chain, seg = ch.segs[ch.idx++];
    if (seg.onEnd && seg.onEnd() === true) redrawn = true;
    if (chain !== ch) return;                    // il callback ha fermato o sostituito il timer
    if (ch.idx < ch.segs.length) enterSeg();
  }
  if (!chain) return;
  if (chain.idx >= chain.segs.length) {
    stopTimer();
    // in ogni caso la schermata va ridisegnata, altrimenti il pulsante di avvio
    // resterebbe disabilitato
    if (!redrawn && current && !current.finished) renderSession();
    notifyTimerEnd();
    return;
  }
  const seg = chain.segs[chain.idx];
  const prep = seg.kind === 'prep';
  const dur = Math.max(1, (seg.end - seg.start) / 1000);
  const left = Math.max(0, Math.ceil((seg.end - now) / 1000));
  // in preparazione si mostra solo la cifra che scorre: resta centrata nel cerchio
  const txt = prep ? String(left) : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  $('#timerCount').textContent = txt;
  $('#miniCount').textContent = txt;
  $('#ringFill').setAttribute('stroke-dashoffset', String(prep ? 0 : 283 * (1 - Math.min(1, left / dur))));
  $('#timer').classList.toggle('prep', prep);
  $('#miniTimer').classList.toggle('prep', prep);
  $('#timer').classList.toggle('warn', seg.kind === 'rest' && left <= 3);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null; chain = null;
  stopBells();
  $('#timer').classList.remove('on', 'warn', 'prep', 'work');
  $('#miniTimer').classList.remove('on', 'prep', 'work');
  document.body.classList.remove('mini-on');
}
const timerRunning = () => !!chain;

/* Restano tenute da fare nella catena in corso? */
const chainHasWork = () => !!chain && chain.segs.slice(chain.idx).some(s => s.kind !== 'rest');

/* Stacca le azioni in coda: il tempo continua a scorrere ma non tocca più
   la seduta (serve quando ci si sposta su un altro esercizio). */
function detachTimer() {
  if (!chain) return;
  chain.segs.forEach((s, i) => { if (i >= chain.idx) { s.onEnd = null; s.onStart = null; } });
}

/* Prima di cambiare esercizio: una sequenza di tenute ancora aperta si ferma
   (non avrebbe senso cronometrare l'esercizio che hai lasciato), un semplice
   recupero invece continua a scorrere. */
function releaseTimerForMove() {
  if (chainHasWork()) stopTimer(); else detachTimer();
}

/* Sposta di delta ms la fine del segmento corrente e tutti i successivi. */
function shiftChain(deltaMs) {
  chain.segs.forEach((s, i) => {
    if (i < chain.idx) return;
    if (i > chain.idx) s.start += deltaMs;
    s.end += deltaMs;
  });
}

function minimizeTimer() {
  if (!chain) return;
  const t = $('#timer');
  if (!t.classList.contains('on')) return;
  t.classList.add('closing');                    // il pannello rimpicciolisce verso il basso
  setTimeout(() => {
    t.classList.remove('on', 'closing');
    if (!chain) return;
    $('#miniTimer').classList.add('on');         // la barretta entra dal basso
    document.body.classList.add('mini-on');
    if (current && !current.finished) renderSession();   // aggiorna lo stato del pulsante di avvio
  }, 260);
}
function expandTimer() {
  if (!chain) return;
  const m = $('#miniTimer');
  m.classList.add('closing');
  setTimeout(() => {
    m.classList.remove('on', 'closing');
    document.body.classList.remove('mini-on');
    if (chain) $('#timer').classList.add('on');  // il pannello si riapre ingrandendosi
  }, 180);
}

/* "Riprendi ora" / "Termina la tenuta" / "Accorcia la pausa":
     · preparazione o tenuta → finiscono subito, la catena prosegue;
     · pausa fra due tenute → scende a 3 secondi, così i rintocchi di
       preavviso suonano comunque prima della tenuta successiva;
     · recupero finale → finisce subito ed esegue ciò che aveva in coda. */
function skipTimer() {
  if (!chain) return;
  const now = Date.now(), seg = chain.segs[chain.idx], next = chain.segs[chain.idx + 1];
  let target = now;
  if (seg.kind === 'rest' && next && next.kind === 'work' && seg.end - now > 3300) target = now + 3000;
  shiftChain(target - seg.end);
  restartBells();
  tick();
}

/* Se il recupero finisce mentre stai consultando un'altra schermata, una
   barretta lo segnala e riporta alla seduta con un tocco: senza, il pulsante
   per la serie successiva resterebbe fuori vista. */
function notifyTimerEnd() {
  if (!current || current.finished) return;
  if (document.querySelector('#view-session').classList.contains('active')) return;
  if ($('#endBar')) return;
  const bar = document.createElement('div');
  bar.className = 'updbar'; bar.id = 'endBar';
  bar.innerHTML = `<span>Recupero finito</span>
    <button class="pick" id="endGo">Torna alla seduta</button>
    <button class="mini-skip" id="endNo" aria-label="Chiudi">✕</button>`;
  document.body.appendChild(bar);
  requestAnimationFrame(() => bar.classList.add('on'));
  $('#endGo').onclick = () => { bar.remove(); go('session'); renderSession(); };
  $('#endNo').onclick = () => bar.remove();
  setTimeout(() => { const b = $('#endBar'); if (b) b.remove(); }, 20000);
}

/* "Ferma": annulla il timer senza eseguire nulla. Le tenute già concluse
   restano contate, nessun esercizio viene chiuso: serve quando il timer è
   partito per sbaglio o l'allenamento si interrompe. */
function cancelTimer() {
  stopTimer();
  if (current && !current.finished) renderSession();
}

$('#timerSkip').onclick = skipTimer;
$('#timerStop').onclick = cancelTimer;
$('#miniSkip').onclick = skipTimer;
$('#miniStop').onclick = cancelTimer;
$('#timerMin').onclick = minimizeTimer;
$('#miniExpand').onclick = expandTimer;
$('#timerPlus').onclick = () => {
  if (!chain || chain.segs[chain.idx].kind === 'prep') return;
  shiftChain(15000); restartBells(); tick();
};
$('#timerMinus').onclick = () => {
  if (!chain || chain.segs[chain.idx].kind === 'prep') return;
  const seg = chain.segs[chain.idx];
  const newEnd = Math.max(Date.now() + 1000, seg.end - 15000);
  shiftChain(newEnd - seg.end); restartBells(); tick();
};

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { wakeLock = null; }
}
function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (current) requestWakeLock();
    // al rientro in primo piano si riallinea la traccia al contatore
    if (chain) { tick(); if (chain) resyncBells((Date.now() - chain.audioT0) / 1000); }
  }
});

/* ---------------------------------------------------------------------------
   MODALE, NAV, AVVIO
--------------------------------------------------------------------------- */
function confirmAction(title, text, okLabel, onOk) {
  openModal(`<h2>${esc(title)}</h2><p class="small muted">${esc(text)}</p>
    <button class="btn" id="cfOk" style="margin-top:12px">${esc(okLabel)}</button>
    <button class="btn ghost" id="cfNo" style="margin-top:10px">Annulla</button>`);
  $('#cfOk').onclick = () => { closeModal(); onOk(); };
  $('#cfNo').onclick = closeModal;
}

/* Conferma "rossa" per le operazioni che toccano l'archivio dei dati
   (esportazione, ripristino, azzeramento): riquadro bordato di rosso, titolo
   di allerta e pulsante di conferma rosso, così l'azione non parte mai per un
   tocco involontario. */
function dangerAction(title, text, okLabel, onOk) {
  openModal(`<div class="danger">
    <div class="danger-head"><span class="danger-ico">!</span><h2>${esc(title)}</h2></div>
    <p class="small">${esc(text)}</p>
    <button class="btn btn-danger" id="dgOk" style="margin-top:16px">${esc(okLabel)}</button>
    <button class="btn ghost" id="dgNo" style="margin-top:10px">Annulla</button>
  </div>`);
  $('#modal').classList.add('danger-modal');     // fallback per i browser senza :has()
  const close = then => { $('#modal').classList.remove('danger-modal'); closeModal(then); };
  $('#dgOk').onclick = () => close(() => onOk());
  $('#dgNo').onclick = () => close();
}

function openModal(html) {
  const m = $('#modal');
  m.classList.remove('closing');
  $('#modalBox').innerHTML = html;
  m.classList.add('on');
}
function closeModal(then) {
  const m = $('#modal');
  if (!m.classList.contains('on')) { if (then) then(); return; }
  m.classList.add('closing');                    // dissolvenza e rientro verso il basso
  setTimeout(() => {
    m.classList.remove('on', 'closing');
    if (then) then();
  }, 200);
}
function closeSheet() {
  const sh = $('#sheet');
  if (!sh.classList.contains('on')) return;
  sh.classList.add('closing');
  setTimeout(() => sh.classList.remove('on', 'closing'), 220);
}

document.querySelectorAll('.nav button').forEach(b => b.onclick = () => {
  if (current && b.dataset.go !== 'session') { /* la sessione resta in memoria */ }
  go(b.dataset.go);
});

function disclaimer() {
  openModal(`<h2>Prima di iniziare</h2>
    <p class="small">I programmi di questa app sono costruiti su linee guida generali (ACSM, NSCA, ACE, OMS) per adulti sani e non sostituiscono il parere di un professionista sanitario.</p>
    <p class="small">Vista la sensibilità al ginocchio indicata nel profilo, fai valutare la situazione da un medico o da un fisioterapista prima di cominciare. Durante gli esercizi, fermati se compare dolore articolare acuto, e riduci escursione o carico se il fastidio si ripresenta.</p>
    <p class="small">Interrompi immediatamente in caso di dolore al petto, mancanza di respiro insolita o vertigini.</p>
    <div class="notice">L'app suggerisce carichi solo a partire da ciò che annoti tu: il primo carico scegli sempre in modo prudente.</div>
    <button class="btn" id="okDisc" style="margin-top:16px">Ho capito, iniziamo</button>`);
  $('#okDisc').onclick = () => { S.disclaimerOk = true; save(); closeModal(); };
}

/* ---------------------------------------------------------------------------
   AGGIORNAMENTO DELL'APP
   Il service worker nuovo non si attiva da solo: quando è pronto l'app mostra
   un avviso, e l'aggiornamento viene applicato quando l'utente lo sceglie —
   mai a metà seduta. Prima bastava dimenticare di cambiare il numero di cache
   perché l'iPhone continuasse a servire la versione vecchia.
--------------------------------------------------------------------------- */
function showUpdateBanner(reg) {
  if ($('#updBar')) return;
  const bar = document.createElement('div');
  bar.className = 'updbar';
  bar.id = 'updBar';
  bar.innerHTML = `<span>Aggiornamento pronto</span>
    <button class="pick" id="updNow">Applica</button>
    <button class="mini-skip" id="updLater" aria-label="Più tardi">✕</button>`;
  document.body.appendChild(bar);
  requestAnimationFrame(() => bar.classList.add('on'));
  $('#updNow').onclick = () => {
    if (current && !current.finished) {
      confirmAction('Applicare ora l\'aggiornamento?',
        'La seduta in corso è già salvata e la ritroverai al riavvio, ma l\'app si ricaricherà.',
        'Applica', () => applyUpdate(reg));
    } else applyUpdate(reg);
  };
  $('#updLater').onclick = () => bar.remove();
}
function applyUpdate(reg) {
  try {
    saveResume();
    if (reg.waiting) reg.waiting.postMessage('skipWaiting');
    setTimeout(() => location.reload(), 400);
  } catch (e) { location.reload(); }
}
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting) showUpdateBanner(reg);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(reg);
      });
    });
    // un controllo all'apertura e uno ogni ora: l'aggiornamento non dipende
    // più dal ricordarsi di chiudere l'app dal multitasking
    reg.update().catch(() => {});
    setInterval(() => reg.update().catch(() => {}), 3600 * 1000);
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return; reloaded = true; location.reload();
  });
}

(async function boot() {
  load();
  try { await loadData(); }
  catch (e) {
    document.body.innerHTML = '<p style="padding:24px">Impossibile caricare i dati degli esercizi. Apri l\'app da un server web (o dalla schermata Home dopo l\'installazione), non da file locale.</p>';
    return;
  }
  await initStore();               // archivio dei risultati (IndexedDB)
  requestPersistence();            // chiede di non cancellare i dati
  validateData();                  // controllo di coerenza dei file JSON
  migrateToMacro();
  migrateNames();
  resetCalfLogs();
  migrateLogFields();
  migrateRealign();
  go('home');
  // l'intro si anima per 3 secondi e resta sull'ultimo fotogramma: sparisce solo
  // quando l'utente tocca lo schermo, e solo dopo compare l'avvertenza
  const splash = document.getElementById('splash');
  const afterSplash = () => {
    const poi = () => { if (!S.disclaimerOk) disclaimer(); else askMobilityWeek(); };
    if (!splash || splash.dataset.done) { poi(); return; }
    splash.dataset.done = '1';
    splash.classList.add('hide');
    setTimeout(() => {
      if (splash.parentNode) splash.parentNode.removeChild(splash);
      poi();
    }, 420);
  };
  const qEl = document.getElementById('splashQuote');
  if (qEl) qEl.textContent = pickQuote();
  if (splash) splash.onclick = afterSplash; else afterSplash();
  registerServiceWorker();
})();
