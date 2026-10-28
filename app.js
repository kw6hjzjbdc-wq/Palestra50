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
const DAY_MS_8 = 864e5;
const BANDS = ['Azzurra (leggera)', 'Gialla (media)', 'Rossa (dura)', 'Viola (molto dura)'];

let DB = { exercises: [] }, PROG = null, POSES = null, QUOTES = [];
let S = null;              // stato persistente
let current = null;        // sessione in corso
let planCache = null;      // sessione di oggi già generata (per mantenere le sostituzioni)
let homeSel = 'session';   // cosa è selezionato nella home: 'session' o 'core'
let homeView = null;       // Oggi: null = scelta, 'morning' = mobilità breve, 'lunch' = allenamento del giorno, 'week' = programma della settimana
let morningSel = null;     // mattina scelta nella card della mobilità del mattino
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
  shoulderCare: true,      // evita gli esercizi di solito dolorosi con la tendinopatia della cuffia
  pullupGoal: true,        // trazioni e muscle-up nelle sedute di forza (obiettivo del programma, dalla 6.4)
  perms: {},               // ordine delle 5 sedute all'interno di ciascuna settimana
  mobilityWeeks: [],       // settimane in cui si fa solo mobilità (il programma slitta)
  sound: true,             // campanella del timer
  disclaimerOk: false,
  logs: [],                // storico per esercizio
  sessionLog: [],          // storico per sessione (durata, note)
  lastExport: 0,            // timestamp dell'ultimo salvataggio JSON esportato
  quoteQueue: [],           // indici delle ultime 100 frasi mostrate all'avvio
  exNotes: {},              // nota personale per esercizio (regolazioni, accorgimenti)
  pace: { strength: 1, stretch: 1, cardio: 1 },   // ritmo personale appreso dalle sedute reali
  durPref: 45,             // durata scelta per la prossima seduta (45 dalla 8.3)
  finisher: 'a_spinning',  // finale metabolico a basso impatto per il ginocchio
  measures: [],            // girovita e peso
  morningMin: 10,          // durata della mobilità del mattino (10 o 15 minuti)
  autoBackup: true,         // istantanea automatica a fine settimana
  snapshots: [],            // ultime 3 istantanee settimanali, ripristinabili
  sessPick: {},             // seduta aerobica o di mobilità scelta al posto di quella prevista
  resume: null,             // seduta interrotta, recuperabile dopo la chiusura dell'app
  lastRecap: 0,             // ultima settimana di cui è stato mostrato il riepilogo
  pullSelf: null,           // massimo di trazioni e muscle-up dichiarato: { n, mu, ts }
  bigScreen: true,          // (8) numeri grandi in seduta, leggibili a un metro
  theme: 'dark',            // (8) 'dark' | 'light' | 'auto'
  spartan: true,            // preparazione alla Spartan Race Sprint di Orte (dalla 7S 0)
  spartanRuns: [],          // corse-camminate svolte, con il riscontro del ginocchio il giorno dopo
  spSelf: null              // sospensione e burpees dichiarati a mano: { hang, burpee, burpeeLevel, ts }
};

function load() {
  try { S = Object.assign({}, DEFAULT_STATE, JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch (e) { S = Object.assign({}, DEFAULT_STATE); }
  if (!S.exNotes) S.exNotes = {};
  if (!S.sessPick || typeof S.sessPick !== 'object') S.sessPick = {};
  // valori fuori scala in arrivo da un backup manomesso: riportati nel campo
  S.sessionIndex = Math.max(0, Math.round(S.sessionIndex) || 0);
  if (!Array.isArray(S.mobilityWeeks)) S.mobilityWeeks = [];
  if (!Array.isArray(S.measures)) S.measures = [];
  if (S.pullSelf && (typeof S.pullSelf !== 'object' || !isFinite(S.pullSelf.ts))) S.pullSelf = null;
  if (!S.perms || typeof S.perms !== 'object') S.perms = {};
  if (!Array.isArray(S.snapshots)) S.snapshots = [];
  // (7S 0) preparazione Spartan: registro delle corse e valori dichiarati
  if (!Array.isArray(S.spartanRuns)) S.spartanRuns = [];
  if (S.spSelf && (typeof S.spSelf !== 'object' || !isFinite(S.spSelf.ts))) S.spSelf = null;
  // (8.3) registro del dolore e durata predefinita portata a 45 minuti (una volta sola)
  if (!Array.isArray(S.painLog)) S.painLog = [];
  if (!S.dur45) { S.durPref = 45; S.dur45 = true; }
  if (![35, 40, 45, 50].includes(S.durPref)) S.durPref = 45;
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
  /* DISATTIVATA dalla 4.7. Nelle versioni precedenti cancellava una volta le
     registrazioni del calf alla macchina: così è andata persa anche la serie
     di calf della settimana 1. Una migrazione non deve mai cancellare
     risultati; in più, ripristinando un backup senza il contrassegno
     "calfReset" la cancellazione sarebbe ripartita. Ora non fa nulla: le
     registrazioni restano tutte. */
  S.calfReset = true;
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
      Dimmi quale: tutte le sedute diventeranno di allungamento e il programma di forza
      <b>slitterà in avanti</b>, riprendendo da dove è rimasto. Nessuna settimana di lavoro va persa.</p>
    <p class="small muted">Sei alla ${whereText(meta)}.</p>
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
/* Numero di revisione dello storico: cresce di uno a ogni modifica reale dei
   record. Serve a due cose — evitare di riscrivere l'archivio quando non è
   cambiato nulla, e svuotare la memoria delle sedute già costruite, che
   dipendono anche dai risultati registrati. */
let logsRev = 0, logsSer = null;
function logsTouched() {
  const ser = JSON.stringify(S.logs);
  if (ser === logsSer) return false;
  logsSer = ser; logsRev++;
  return true;
}

function save() {
  try {
    // i record di allenamento vivono in IndexedDB: in localStorage resta tutto
    // il resto, così il salvataggio delle impostazioni non riscrive lo storico
    if (idbReady) {
      const light = Object.assign({}, S, { logs: [] });
      localStorage.setItem(KEY, JSON.stringify(light));
      // riscrivere migliaia di record a ogni salvataggio costava quanto tutto
      // il resto messo insieme: ora si riscrive solo quando qualcosa è cambiato
      if (logsTouched()) idbWrite(S.logs);
    } else {
      // senza archivio separato lo storico viene riscritto comunque: inutile
      // pagare un secondo confronto, basta considerarlo cambiato
      logsRev++;
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
  // gli esercizi "ritirati" (attrezzi non più disponibili) restano noti per
  // leggere lo storico, ma non vengono più proposti né elencati
  DB = { all: ex.exercises, exercises: ex.exercises.filter(e => !e.retired), version: ex.version };
  PROG = pr; POSES = po; QUOTES = qu.quotes || [];
}
const exById = id => (DB.all || DB.exercises).find(e => e.id === id);

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
  null, 'spinBike', 'recumbent', 'barbell', 'barbellBack', 'dumbbells', 'dumbbell1', 'goblet', 'machine',
  'kettlebell', 'kettlebellGoblet',
  'cable', 'wheel', 'platform', 'thighPad', 'grips', 'bar', 'barBand', 'pullbar',
  'bandVertical', 'bandTop', 'bandFront', 'bandBack', 'bandFeet', 'bandFoot',
  'bandKnees', 'bandAnkle', 'bandShoulder', 'bandSide', 'cableAnkle'
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
    if (e.rack && !RACKS[e.rack]) dataIssues.push(`${who}: scala dei carichi "${e.rack}" sconosciuta`);
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
    // kettlebell appeso alla mano: maniglia ad arco e campana arrotondata
    case 'kettlebell':   return `<path d="M ${h[0] - 3.6} ${h[1] + 4} a 3.6 3.6 0 0 1 7.2 0" class="imp" stroke-width="2.2"/>` +
                                `<path d="M ${h[0] - 5.4} ${h[1] + 6.5} a 5.4 5.4 0 1 0 10.8 0 z" class="impf"/>`;
    // kettlebell tenuto al petto per il goblet squat
    case 'kettlebellGoblet': return `<path d="M ${n[0] - 3.2} ${n[1] + 6} a 3.2 3.2 0 0 1 6.4 0" class="imp" stroke-width="2.2"/>` +
                                `<path d="M ${n[0] - 5} ${n[1] + 8} a 5 5 0 1 0 10 0 z" class="impf"/>`;
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
    // bici da spinning: sella, manubrio alto, volano davanti e pedivella
    case 'spinBike':     return `<g>
      <circle cx="86" cy="84" r="10" class="imp" stroke-width="3"/>
      <circle cx="63" cy="88" r="8" class="imp" stroke-width="2"/>
      <circle cx="63" cy="88" r="1.8" class="impf"/>
      <line x1="63" y1="88" x2="86" y2="84" class="imp" stroke-width="3"/>
      <line x1="63" y1="88" x2="50" y2="74" class="imp" stroke-width="3"/>
      <line x1="50" y1="74" x2="80" y2="60" class="imp" stroke-width="2.6"/>
      <line x1="80" y1="60" x2="86" y2="84" class="imp" stroke-width="3"/>
      <line x1="72" y1="58" x2="84" y2="58" class="imp" stroke-width="3" stroke-linecap="round"/>
      <line x1="80" y1="60" x2="80" y2="56" class="imp" stroke-width="2.6"/>
      <rect x="42" y="71" width="16" height="4" rx="2" class="impf"/>
      <line x1="56" y1="99" x2="70" y2="99" class="imp" stroke-width="3" stroke-linecap="round"/>
      <line x1="63" y1="88" x2="63" y2="99" class="imp" stroke-width="2.4"/>
      <line x1="86" y1="94" x2="86" y2="99" class="imp" stroke-width="2.4"/>
      <line x1="80" y1="99" x2="94" y2="99" class="imp" stroke-width="3" stroke-linecap="round"/>
    </g>`;
    // cyclette orizzontale: schienale, sedile basso e pedivella davanti
    case 'recumbent':    return `<g>
      <rect x="${p.hip[0] - 10}" y="${p.hip[1] + 2}" width="22" height="4" rx="2" class="impf"/>
      <line x1="${p.hip[0] - 10}" y1="${p.hip[1] + 2}" x2="${p.hip[0] - 16}" y2="${p.hip[1] - 20}" class="imp" stroke-width="3.4"/>
      <circle cx="${(p.toe || p.ankle)[0] + 6}" cy="${(p.toe || p.ankle)[1] + 2}" r="7" class="imp" stroke-width="2.6"/>
      <line x1="${p.hip[0] + 10}" y1="${p.hip[1] + 4}" x2="${(p.toe || p.ankle)[0] + 6}" y2="${(p.toe || p.ankle)[1] + 2}" class="imp" stroke-width="3"/>
      <line x1="${p.hip[0] - 14}" y1="99" x2="${(p.toe || p.ankle)[0] + 12}" y2="99" class="imp" stroke-width="3" stroke-linecap="round"/>
    </g>`;
    case 'bandSide':     return band(114, h[1]);
    case 'cableAnkle':   return `<line x1="112" y1="40" x2="112" y2="100" class="imp" stroke-width="3"/>` +
      `<path d="M ${a[0]} ${a[1]} L 112 ${a[1]}" class="band" stroke-width="2.6" stroke-dasharray="4 3" fill="none"/>`;
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
  // (8) le parti che lavorano in arancio: braccia, gambe, tronco
  const work = o.work || { arms: true };
  const cA = work.arms ? cArm : cBody, cL = work.legs ? cArm : cBody, cT = work.torso ? cArm : cBody;
  let g = '';
  if (o.ground !== false) g += `<line x1="4" y1="${POSES.ground}" x2="116" y2="${POSES.ground}" stroke="#2B3B4E" stroke-width="2"/>`;
  const L = (a, b, c, w) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
  if (p.knee2) { g += L(p.hip, p.knee2, cBack, 4.5) + L(p.knee2, p.ankle2 || p.knee2, cBack, 4.5) + (p.toe2 ? L(p.ankle2, p.toe2, cBack, 3.2) : ''); }
  if (p.elbow2) { g += L(p.neck, p.elbow2, cBack, 4.5) + L(p.elbow2, p.hand2, cBack, 4.5); }
  // tronco (con eventuale punto intermedio di colonna per gatto/cammello)
  if (p.spine) g += `<path d="M ${p.hip[0]} ${p.hip[1]} Q ${p.spine[0]} ${p.spine[1]} ${p.neck[0]} ${p.neck[1]}" stroke="${cT}" stroke-width="5.5" fill="none" stroke-linecap="round"/>`;
  else g += L(p.hip, p.neck, cT, 5.5);
  g += L(p.hip, p.knee, cL, 5) + L(p.knee, p.ankle, cL, 5);
  if (p.toe) g += L(p.ankle, p.toe, cL, 3.4);
  g += L(p.neck, p.elbow, cA, 5) + L(p.elbow, p.hand, cA, 5);
  g += `<circle cx="${p.head[0]}" cy="${p.head[1]}" r="6.4" stroke="${cBody}" stroke-width="4" fill="none"/>`;
  g += implementSvg(implement, p).replace(/class="imp"/g, `stroke="${cImp}" fill="none"`)
                                .replace(/class="impf"/g, `fill="${cImp}"`)
                                .replace(/class="band"/g, `stroke="#4FC3A1" fill="none"`);
  return s + g + '</svg>';
}
const figureFor = (ex, frameIdx, opts) => figure(ex.art.frames[frameIdx || 0], ex.art.implement, Object.assign({ work: workParts(ex) }, opts || {}));
/* (8) Quali parti del corpo colorare: dai muscoli principali dell'esercizio. */
function workParts(ex) {
  const w = {};
  ((ex && ex.primary) || []).forEach(m => {
    const g = muscleGroup(m), t = String(m).toLowerCase();
    if (g === 'Quadricipiti' || g === 'Glutei e femorali' || g === 'Polpacci' || /cardio/.test(t)) w.legs = true;
    if (g === 'Braccia' || g === 'Spalle' || /presa|mano/.test(t)) w.arms = true;
    if (g === 'Petto' || g === 'Dorso' || g === 'Core') w.torso = true;
    if (g === 'Petto' || g === 'Dorso') w.arms = true;
  });
  if (!w.legs && !w.arms && !w.torso) w.arms = true;
  return w;
}
/* (8) Figura animata: la stessa sagoma passa dalla posizione iniziale a quella
   finale e ritorna, in 3 secondi, con le parti che lavorano in arancio. */
function figureMotion(ex, opts) {
  // (8.6) «motion» (facoltativo) elenca più posizioni chiave per i gesti che
  // due sole non descrivono (burpee: in piedi → accosciata con le mani a terra
  // → plank → petto a terra → di nuovo accosciata); senza, si usano i due
  // fotogrammi delle miniature
  const fr = (Array.isArray(ex.art.motion) && ex.art.motion.length >= 2) ? ex.art.motion : (ex.art.frames || []);
  const o = opts || {};
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || fr.length < 2 || fr.every(f => f === fr[0])) return figureFor(ex, 1, o);
  const P = fr.map(pose), n = P.length, dur = (n > 2 ? 1.1 * n : 3).toFixed(1) + 's';
  const kt = Array.from({ length: n + 1 }, (_, i) => (i / n).toFixed(4)).join(';');
  const ks = Array.from({ length: n }, () => '.45 0 .55 1').join(';');
  const work = workParts(ex);
  const cBack = '#5B7188', cBody = '#EAF1F8', cArm = '#F5A524', cImp = '#B9CBDD';
  const cA = work.arms ? cArm : cBody, cL = work.legs ? cArm : cBody, cT = work.torso ? cArm : cBody;
  const pt = (p, k, alt) => p[k] || p[alt] || null;
  const anim = (attr, vals) => `<animate attributeName="${attr}" values="${vals.concat([vals[0]]).join(';')}" keyTimes="${kt}" dur="${dur}" repeatCount="indefinite" calcMode="spline" keySplines="${ks}"/>`;
  const seg = (k1, k2, c, w, alt1, alt2) => {
    const p1s = P.map(p => pt(p, k1, alt1)), p2s = P.map(p => pt(p, k2, alt2));
    if (!p1s[0] || !p2s[0]) return '';
    const f1 = p1s.map(q => q || p1s[0]), f2 = p2s.map(q => q || p2s[0]);
    return `<line x1="${f1[0][0]}" y1="${f1[0][1]}" x2="${f2[0][0]}" y2="${f2[0][1]}" stroke="${c}" stroke-width="${w}" stroke-linecap="round">` +
      anim('x1', f1.map(q => q[0])) + anim('y1', f1.map(q => q[1])) + anim('x2', f2.map(q => q[0])) + anim('y2', f2.map(q => q[1])) + '</line>';
  };
  let g = `<line x1="4" y1="${POSES.ground}" x2="116" y2="${POSES.ground}" stroke="#2B3B4E" stroke-width="2"/>`;
  if (P.some(p => p.knee2)) g += seg('hip', 'knee2', cBack, 4.5, null, 'knee') + seg('knee2', 'ankle2', cBack, 4.5, 'knee', 'ankle');
  if (P.some(p => p.elbow2)) g += seg('neck', 'elbow2', cBack, 4.5, null, 'elbow') + seg('elbow2', 'hand2', cBack, 4.5, 'elbow', 'hand');
  g += seg('hip', 'neck', cT, 5.5) + seg('hip', 'knee', cL, 5) + seg('knee', 'ankle', cL, 5);
  if (P.some(p => p.toe)) g += seg('ankle', 'toe', cL, 3.4, null, 'ankle');
  g += seg('neck', 'elbow', cA, 5) + seg('elbow', 'hand', cA, 5);
  const hs = P.map(p => p.head || P[0].head);
  g += `<circle cx="${hs[0][0]}" cy="${hs[0][1]}" r="6.4" stroke="${cBody}" stroke-width="4" fill="none">${anim('cx', hs.map(h => h[0]))}${anim('cy', hs.map(h => h[1]))}</circle>`;
  // attrezzo: dissolvenza fra le posizioni
  const imp = p => implementSvg(ex.art.implement, p).replace(/class="imp"/g, `stroke="${cImp}" fill="none"`)
    .replace(/class="impf"/g, `fill="${cImp}"`).replace(/class="band"/g, `stroke="#4FC3A1" fill="none"`);
  if (ex.art.implement) P.forEach((p, i) => {
    const vals = Array.from({ length: n + 1 }, (_, k) => (k % n) === i ? 1 : 0).join(';');
    g += `<g opacity="${i === 0 ? 1 : 0}">${imp(p)}<animate attributeName="opacity" values="${vals}" keyTimes="${kt}" dur="${dur}" repeatCount="indefinite"/></g>`;
  });
  const lab = o.label || figureLabel(ex, 1);
  return `<svg viewBox="${POSES.viewBox}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(lab)}"><title>${esc(lab)}</title>${g}</svg>`;
}

/* Descrizione testuale della figura, ricavata dai dati già presenti nella
   scheda: nome dell'esercizio, fase e attrezzatura. */
function figureLabel(ex, frameIdx) {
  const fase = frameIdx ? 'posizione finale' : 'posizione iniziale';
  const att = (ex.equipment || []).join(', ');
  return `${ex.name}: ${fase}${att ? ', con ' + att.toLowerCase() : ', a corpo libero'}`;
}
const figureA11y = (ex, frameIdx, opts) =>
  figure(ex.art.frames[frameIdx || 0], ex.art.implement,
         Object.assign({ label: figureLabel(ex, frameIdx), work: workParts(ex) }, opts || {}));

/* ---------------------------------------------------------------------------
   4. PERIODIZZAZIONE
   weekProfile() traduce la settimana del mesociclo in modificatori di volume e
   intensità: le settimane centrali costruiscono, l'ultima è di scarico.
   Riferimenti: ACSM (progressione di volume/intensità per adulti), NSCA
   (sovraccarico progressivo e periodizzazione lineare/ondulata).
--------------------------------------------------------------------------- */
function weekProfile(week, cycleWeeks) {
  /* Nel programma il carico NON sale per calendario: sale con la regola
     2-for-2 quando superi di 2 ripetizioni l'obiettivo per due sedute.
     La settimana cambia serie e ripetizioni; i messaggi dicono esattamente
     questo, senza promettere aumenti percentuali che l'app non applica. */
  if (week >= cycleWeeks) {
    return { week, label: 'Scarico', setsDelta: -1, repsBias: 0.5,
             note: 'Settimana di scarico: stessi carichi, una serie e qualche ripetizione in meno per recuperare. Il carico suggerito resta fermo.' };
  }
  const builds = Math.max(1, cycleWeeks - 1);
  const t = builds > 1 ? (week - 1) / (builds - 1) : 0;      // 0 → 1 nel mesociclo
  return {
    week,
    label: week === 1 ? 'Adattamento' : (week === builds ? 'Picco' : 'Costruzione'),
    setsDelta: week === builds ? 1 : 0,
    repsBias: 1 - t,                                          // ripetizioni alte → basse
    note: week === 1
      ? 'Prima settimana del ciclo: prendi confidenza con i carichi, 3 ripetizioni di riserva.'
      : (week === builds ? 'Settimana di picco: una serie in più e ripetizioni più basse. Il carico sale dove hai soddisfatto la regola 2-for-2.'
                         : 'Ripetizioni un po\' più basse della settimana scorsa. Il carico sale solo dove hai superato l\'obiettivo di 2 ripetizioni per due sedute: il suggerimento lo indica esercizio per esercizio.')
  };
}

/* Nota della settimana per le sedute di mobilità e stretching.
   Qui non c'è carico da aumentare: la progressione si misura in ampiezza del
   movimento raggiunta senza dolore, e in controllo: tensione moderata, mai
   dolore, respirazione regolare (ACSM, Garber et al. 2011). */
function mobilityNote(profile, mobWeek) {
  if (mobWeek) return 'Settimana di sola mobilità: tutte le sedute sono di allungamento, nessun carico. ' +
                      'Cerca ampiezza con calma, sempre sotto la soglia del dolore.';
  if (profile.label === 'Scarico') return 'Settimana leggera anche per la mobilità: movimenti morbidi, meno serie, nessuna forzatura.';
  if (profile.label === 'Adattamento') return 'Allunga senza forzare: tensione moderata, mai dolore, respiro lento e regolare.';
  if (profile.label === 'Picco') return 'Una serie in più per gruppo: mantieni la stessa tensione moderata, cambia solo la durata complessiva.';
  return 'Cerca un po\' più di ampiezza rispetto alla settimana scorsa, a parità di comfort: il progresso qui è il movimento, non il carico.';
}

/* Dose (serie, ripetizioni, recupero) per un obiettivo e una settimana.
   Gli esercizi unilaterali (un lato alla volta) ricevono sempre un numero PARI
   di serie, così destra e sinistra lavorano lo stesso numero di volte. */
/* Allungamento della tenuta negli esercizi a tempo: ogni due registrazioni di
   fila chiuse con almeno 10 secondi di margine, la tenuta suggerita cresce di
   5 secondi (fino a +30). È l'equivalente della regola 2-for-2 per il carico:
   si progredisce quando il margine c'è, non per calendario. */
function holdBonus(ex) {
  if (!ex || ex.load !== 'time' || ex.type === 'stretch') return 0;
  const all = S.logs.filter(l => l.exId === ex.id && !isDeloadLog(l));
  // (6.9) la tenuta già guadagnata prima della ripartenza resta il punto di
  // partenza; il conteggio delle coppie di sedute con margine riparte da zero
  const pairs = logs => { let b = 0; for (let i = 1; i < logs.length; i++) {
    const a = logs[i - 1], c = logs[i];
    if (a.rirUnit === 's' && c.rirUnit === 's' && a.rir >= 10 && c.rir >= 10) { b += 5; i++; } } return b; };
  const bonus = pairs(all.filter(isPreEpoch)) + pairs(all.filter(l => !isPreEpoch(l)));
  return Math.min(30, bonus);
}

function dose(goalKey, profile, ex) {
  const g = PROG.goals[goalKey];
  let sets = Math.min(6, Math.max(2, g.sets + (profile.setsDelta || 0)));
  const perSide = !!(ex && ex.perSide);
  if (perSide && sets % 2) sets++;                 // arrotonda al pari superiore
  const reps = Math.round(g.repsLow + (g.repsHigh - g.repsLow) * profile.repsBias);
  // la tenuta vale solo per gli esercizi a tempo (allungamenti, isometrie)
  const timed = goalKey === 'stretch' || !ex || ex.load === 'time';
  const bonus = timed ? holdBonus(ex) : 0;
  // se l'obiettivo non indica una tenuta (plank, wall sit dentro un blocco
  // core) la si ricava dall'esercizio: senza questo numero la seduta non
  // registrava i secondi e l'esercizio restava senza valutazione
  const baseHold = g.hold || (ex && ex.load === 'time' ? 20 + reps : 30);
  return {
    goal: goalKey, goalLabel: g.label, sets, reps, perSide,
    rest: g.rest, hold: timed ? baseHold + bonus : 0, holdBonus: bonus, rpe: g.rpe, source: g.source
  };
}
/* Etichetta della singola serie: per gli unilaterali alterna sinistra e destra. */
function setLabel(it, i) {
  if (!it.perSide) return String(i + 1);
  return `${Math.floor(i / 2) + 1}${i % 2 ? ' Dx' : ' Sx'}`;
}

/* ---------------------------------------------------------------------------
   PROGRESSIONE DEL CARICO — regola 2-for-2
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
   · kettlebell — da 8 a 24 kg, un ferro ogni 2 kg;
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
  dumbbell: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40],
  machine:  Array.from({ length: 45 }, (_, i) => 10 + i * 2.5),      // 10 → 120
  // kettlebell della sala: da 8 a 24 kg, un ferro ogni 2 kg
  kettlebell: Array.from({ length: 9 }, (_, i) => 8 + i * 2),         // 8 → 24
  home:     [1, 2, 3, 4]                                             // 1+2 kg, anche in coppia
};
const rackOf = ex => (ex && RACKS[ex.rack]) ? RACKS[ex.rack] : null;

/* (8.5) Dischi per lato del bilanciere, con il minor numero di dischi:
   48 kg → 10 + 5 + 2 + 2. Se un disco è occupato, il carico vicino si sceglie
   dal selettore e la valutazione tiene conto di carico e ripetizioni insieme. */
function platesFor(total) {
  const side = (numLoad(total) - 10) / 2;
  if (!(side > 0) || Math.abs(side - Math.round(side)) > 1e-6) return side === 0 ? [] : null;
  const n = Math.round(side), disks = [20, 10, 5, 2], best = new Array(n + 1).fill(null);
  best[0] = [];
  for (let v = 1; v <= n; v++) disks.forEach(d => {
    if (d <= v && best[v - d] && (!best[v] || best[v - d].length + 1 < best[v].length)) best[v] = best[v - d].concat([d]);
  });
  return best[n] ? best[n].sort((a, b) => b - a) : null;
}
function platesText(total) {
  const p = platesFor(total);
  if (p === null) return '';
  return p.length ? `${String(total).replace('.', ',')} kg = bilanciere + per lato ${p.join(' + ')} kg.` : 'Solo il bilanciere (10 kg).';
}
/* Riga di spiegazione della scala, mostrata sotto il selettore del carico. */
function rackNote(ex) {
  if (!ex || ex.load !== 'weight') return '';
  switch (ex.rack) {
    case 'barbell':  return 'Bilanciere da 10 kg con dischi da 2, 5, 10 e 20 kg a coppie: 12 e 16 kg non sono componibili.' + (arguments[1] ? ' ' + platesText(arguments[1]) : '');
    case 'dumbbell': return 'Peso del singolo manubrio, dalla rastrelliera da 2 a 40 kg.';
    case 'machine':  return 'Pacco pesi da 10 a 120 kg, a scalini di 2,5 kg.';
    case 'kettlebell': return 'Kettlebell da 8 a 24 kg, un ferro ogni 2 kg: il passo è fisso, non si compone.';
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
/* Dalla 6.8 le prestazioni della settimana di scarico non sono dati di
   progressione: restano nello storico (nulla si cancella) ma non fanno da
   «ultima volta» per il carico suggerito, la regola 2-for-2 e le tenute. */
function lastEntry(exId) {
  for (let i = S.logs.length - 1; i >= 0; i--) if (S.logs[i].exId === exId && !isDeloadLog(S.logs[i])) return S.logs[i];
  return null;
}
function lastEntries(exId, n) {
  // (6.9) la serie di sedute valide per la regola 2-for-2 riparte da zero
  return S.logs.filter(l => l.exId === exId && !isDeloadLog(l) && !isPreEpoch(l)).slice(-n);
}

/* Vero se in quella registrazione hai superato l'obiettivo di 2+ ripetizioni. */
function beatTarget(l) {
  if (!l || !isFinite(l.repsDone) || !isFinite(l.repsTarget)) return false;
  return l.repsDone >= l.repsTarget + 2;
}

/* Elenco dei gradini per gli esercizi a corpo libero con progressione. */
const levelsOf = ex => (ex && ex.levels) ? ex.levels : null;

/* ---------------------------------------------------------------------------
   SETTIMANA DI SCARICO BEN VISIBILE (dalla 5.13)
   Ogni quarta settimana del blocco è di scarico: stessi carichi, una serie e
   qualche ripetizione in meno. L'app già congela il carico suggerito, ma
   l'informazione viveva in una riga di nota che si poteva non leggere, e
   bastava alzare il peso a mano per vanificare il recupero. Ora c'è una fascia
   rossa in cima allo schermo, presente in tutte le schermate e anche durante
   la seduta, che lo ricorda finché la settimana non è passata.
--------------------------------------------------------------------------- */
function isDeloadWeek(idx) {
  try {
    const m = sessionMeta(idx == null ? S.sessionIndex : idx);
    return !m.mobilityWeek && !!m.profile && m.profile.label === 'Scarico';
  } catch (e) { return false; }
}
function deloadText() {
  try { return `Settimana ${sessionMeta(S.sessionIndex).weekAbs} di scarico · non aumentare i carichi`; }
  catch (e) { return 'Settimana di scarico · non aumentare i carichi'; }
}
/* Aggiorna la fascia in cima e quella del timer a tutto schermo. */
function refreshDeload() {
  const on = isDeloadWeek();
  const txt = on ? '⚠ ' + deloadText() : '';
  const bar = $('#deloadBar'), strip = $('#deloadTimerBar');
  if (bar) { bar.hidden = !on; bar.textContent = txt; bar.onclick = openDeloadInfo; }
  if (strip) { strip.hidden = !on; strip.textContent = txt; }
}
function openDeloadInfo() {
  let note = '';
  try { note = sessionMeta(S.sessionIndex).profile.note || ''; } catch (e) {}
  openModal(`<h2>Settimana di scarico</h2>
    <p class="small muted">${esc(note)}</p>
    <p class="small muted">Serve a far recuperare tendini, articolazioni e sistema nervoso: è la settimana che rende possibile l'aumento di carico in quella successiva, non una settimana persa.
      Per questo l'app <b>congela il carico suggerito</b> anche dove hai soddisfatto la regola 2-for-2: l'aumento guadagnato scatta la settimana prossima.</p>
    <p class="small muted">Se oggi ti senti bene, la tentazione è alzare il peso a mano: è proprio quello che toglie senso allo scarico. Tieni i carichi della settimana scorsa e chiudi le serie con due o tre ripetizioni di riserva.</p>
    <p class="small muted">Le prestazioni di questa settimana restano nello storico ma <b>non entrano nei dati della progressione</b>: non prendono stelle, non compaiono nei grafici e nella tendenza, non contano per il carico suggerito né per il massimo di trazioni. Il test delle trazioni cade la settimana prossima, a recupero fatto.</p>
    <button class="btn secondary" id="dlOk" style="margin-top:14px">Ho capito</button>`);
  $('#dlOk').onclick = () => closeModal();
}
/* Riquadro esteso, nelle schermate di Oggi. */
function deloadCardHtml() {
  if (!isDeloadWeek()) return '';
  let note = '';
  try { note = sessionMeta(S.sessionIndex).profile.note || ''; } catch (e) {}
  return `<div class="card deload-card">
    <div class="kicker">⚠ Settimana di scarico</div>
    <h2 style="margin-top:2px">Non aumentare i carichi</h2>
    <p class="small" style="margin:6px 0 0">${esc(note)}</p>
    <p class="small" style="margin:6px 0 0">Il carico suggerito resta quello della settimana scorsa anche dove hai soddisfatto la regola 2-for-2: l'aumento scatta la settimana prossima.</p>
    <p class="small" style="margin:6px 0 0">Quello che fai questa settimana resta nello storico ma non entra nella progressione: niente stelle, niente punti nei grafici, e la prossima settimana il confronto si fa con l'ultima seduta normale.</p>
  </div>`;
}

function suggestLoad(ex, it) {
  // in settimana di scarico nessun aumento: si recupera a carico invariato
  const deloadNow = isDeloadWeek();
  const r = suggestLoadCore(ex, deloadNow, it);
  // (8 / 8.3) dolore segnato o in aumento: l'esercizio collegato si alleggerisce
  const pi = r ? painInfo(ex, it) : null;
  if (pi && r.value) {
    const lv = lighterValue(ex, r.value, it);
    if (lv) { r.value = lv.value; r.reason = `${PAIN_NAME[pi.part]}: ${pi.why}, ${lv.how}. ` + (r.reason || ''); }
    r.pain = pi.part;
  }
  if (r && deloadNow && r.heldForDeload) {
    r.reason = 'Settimana di scarico: il carico resta fermo. L\'aumento guadagnato con la regola 2-for-2 scatta la settimana prossima.';
  }
  return r;
}
/* ---------------------------------------------------------------------------
   CARICO COMMISURATO ALLE RIPETIZIONI (dalla 7S 1)
   Quando le ripetizioni previste oggi sono diverse da quelle dell'ultima
   seduta (per esempio 3×6 dopo 3×15), lo stesso carico non va bene: si stima
   il massimale dall'ultima seduta, contando anche le ripetizioni che restavano
   in riserva, e si ricava il carico per le ripetizioni di oggi con il margine
   previsto dall'obiettivo. Formula di Epley (la stessa usata per il massimale
   stimato nei grafici) con le ripetizioni in riserva della scala di Zourdos
   et al. 2016: regola operativa dell'app. Il risultato si arrotonda PER
   DIFETTO al carico disponibile, perché la relazione fra ripetizioni e
   percentuale del massimale varia molto da persona a persona e da esercizio a
   esercizio (Nuzzo et al. 2024, Sports Med 54(2):303-321: a parità di
   percentuale nella leg press si fanno più ripetizioni che nella panca).
   La prima serie fa da verifica: il consiglio lo dice. In settimana di
   scarico il carico non sale mai.
--------------------------------------------------------------------------- */
/* Ripetizioni in riserva previste dall'obiettivo (RPE 7-8 → 2,5; 8 → 2). */
function rirOfGoal(goalKey) {
  const g = PROG.goals[goalKey];
  if (!g) return 2;
  const v = (String(g.rpe || '').match(/\d+(?:[.,]\d+)?/g) || [])
    .map(x => parseFloat(x.replace(',', '.'))).filter(x => x >= 5 && x <= 10);
  if (!v.length) return 2;
  return clampN(10 - v.reduce((a, b) => a + b, 0) / v.length, 1, 4);
}
/* Ultima seduta vera di un esercizio: fuori scarico, non segnata come fatta,
   con un carico annotato. */
function lastRealEntry(exId) {
  for (let i = S.logs.length - 1; i >= 0; i--) {
    const l = S.logs[i];
    if (l && l.exId === exId && !l.planned && !isDeloadLog(l) && numLoad(l.load) > 0) return l;
  }
  return null;
}
/* Massimale stimato con le ripetizioni in riserva: la serie migliore. */
function e1rmWithRir(l) {
  const ex = exById(l.exId);
  if (!ex || ex.load !== 'weight' || isAssist(ex)) return null;
  const rows = setRows(l) || [{ load: l.load, reps: isFinite(l.repsDone) ? l.repsDone : l.reps, rir: l.rir }];
  const goalRir = rirOfGoal(l.goal);
  const has = v => v !== null && v !== undefined && v !== '' && isFinite(v);
  // contano le serie con la riserva annotata (di solito l'ultima); se non ce
  // n'è nessuna, si usa la riserva prevista dall'obiettivo di quella seduta
  const cand = [];
  rows.forEach((r, i) => {
    const w = numLoad(has(numLoad(r.load)) ? r.load : l.load), rp = +r.reps;
    if (w === null || w <= 0 || !isFinite(rp) || rp <= 0) return;
    const known = has(r.rir) ? +r.rir : (i === rows.length - 1 && has(l.rir) ? +l.rir : null);
    const rir = known === null ? goalRir : known;
    cand.push({ v: w * (1 + Math.min(25, rp + rir) / 30), w, rp, rir, known: known !== null });
  });
  const pool = cand.some(c => c.known) ? cand.filter(c => c.known) : cand;
  return pool.reduce((a, c) => (!a || c.v > a.v) ? c : a, null);
}
/* Testo compatto dell'ultima seduta: «3×15 a 52,5 kg» o serie per serie. */
function lastSetsText(l) {
  const kg = x => String(x).replace('.', ',');
  const rows = setRows(l);
  if (rows) {
    const same = rows.every(r => String(r.load) === String(rows[0].load) && r.reps === rows[0].reps);
    if (same) return `${rows.length}×${rows[0].reps} a ${kg(rows[0].load || l.load)} kg`;
    return rows.map(r => `${kg(r.load || l.load)}×${r.reps}`).join(' · ') + ' kg';
  }
  return `${l.sets}×${isFinite(l.repsDone) ? l.repsDone : l.reps} a ${kg(l.load)} kg`;
}
function convertedLoad(ex, it, deloadNow) {
  if (!it || !ex || ex.load !== 'weight' || isAssist(ex) || !isFinite(it.reps) || it.reps <= 0) return null;
  const ref = lastRealEntry(ex.id);
  if (!ref) return null;
  const refTarget = isFinite(ref.repsTarget) ? ref.repsTarget : ref.reps;
  if (!isFinite(refTarget) || Math.abs(it.reps - refTarget) < 2) return null;
  const e = e1rmWithRir(ref);
  if (!e) return null;
  const rirT = rirOfGoal(it.goal || it.goalKey);
  let target = e.v / (1 + Math.min(25, it.reps + rirT) / 30);
  const tooHard = ref.feedback === 'down';
  if (tooHard) target *= 0.95;
  const scale = rackOf(ex);
  let v = scale ? snapLoad(ex, target, -1) : Math.floor(target * 2) / 2;
  const base = scale ? snapLoad(ex, numLoad(ref.load), 0) : numLoad(ref.load);
  let held = false;
  if (deloadNow && v > base) { v = base; held = true; }
  const kg = x => String(Math.round(x * 10) / 10).replace('.', ',');
  const rirTxt = String(Math.round(rirT * 2) / 2).replace('.', ',');
  const reason = held
    ? `Ultima seduta ${lastSetsText(ref)}: con ${it.reps} ripetizioni il carico salirebbe a circa ${kg(target)} kg, ma in settimana di scarico resta fermo a ${kg(v)} kg.`
    : `Ultima seduta ${lastSetsText(ref)}, ${e.known ? `${String(e.rir).replace('.', ',')} ${e.rir === 1 ? 'ripetizione' : 'ripetizioni'} di riserva` : 'riserva non annotata'}: per ${it.reps} ripetizioni con circa ${rirTxt} di riserva servono circa ${kg(target)} kg → ${kg(v)} kg, arrotondato per difetto${tooHard ? ' e ridotto perché l\'ultima volta era troppo pesante' : ''}. È una stima: se la prima serie ti lascia più margine, sali di uno scalino; se non arrivi a ${it.reps}, scendi.`;
  return { val: v, target, ref, rirT, reason, up: v > base, held };
}

function suggestLoadCore(ex, deloadNow, it) {
  const last = lastEntry(ex.id);
  if (!last) return null;
  // (7S 1) ripetizioni diverse dall'ultima seduta: carico ricalcolato
  const conv = convertedLoad(ex, it, deloadNow);
  if (conv) {
    const v = conv.val;
    return { last: conv.ref, twoForTwo: false, heldForDeload: false, converted: conv, reason: conv.reason,
             value: String(v % 1 === 0 ? v : v.toFixed(1)), scale: rackOf(ex) };
  }
  const recent = lastEntries(ex.id, 2);
  let twoForTwo = recent.length >= 2 && recent.every(beatTarget);
  const heldForDeload = twoForTwo && deloadNow;
  if (deloadNow) twoForTwo = false;
  // due condizioni distinte: arrivare al limite una volta (RIR 0) blocca
  // l'aumento ma non fa scendere il carico; solo un "troppo difficile"
  // esplicito lo riduce.
  const tooHard = last.feedback === 'down';
  const atLimit = last.rir === 0;
  const info = { last, twoForTwo, reason: '', heldForDeload };

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
/* Righe delle singole serie, quando ci sono: dalla 5.11 ogni serie ha le sue
   ripetizioni, il suo carico e i suoi secondi. */
const setRows = l => (Array.isArray(l.setLog) && l.setLog.length) ? l.setLog : null;
const numLoad = v => { const n = parseFloat(String(v === undefined ? '' : v).replace(',', '.')); return isFinite(n) ? n : null; };

/* Tonnellaggio reale: somma di carico x ripetizioni serie per serie. Sugli
   esercizi assistiti si usa il merito (meno aiuto = più merito). */
function tonnage(l) {
  const ex = exById(l.exId);
  if (!ex || ex.load !== 'weight') return null;
  const rows = setRows(l);
  const w = v => { const n = numLoad(v); if (n === null) return null; return isAssist(ex) ? Math.max(1, ASSIST_BASE - n) : n; };
  if (rows) {
    let tot = 0;
    for (const r of rows) { const x = w(r.load); if (x === null) return null; tot += x * (r.reps || 0); }
    return tot || null;
  }
  const x = w(l.load);
  return x === null ? null : x * volValue(l);
}

function volValue(l) {
  const ex = exById(l.exId);
  const rows = setRows(l);
  if (rows) {
    if (ex && ex.load === 'time') return rows.reduce((a, r) => a + (r.hold || 0), 0);
    return rows.reduce((a, r) => a + (r.reps || 0), 0);
  }
  // negli esercizi a tempo il volume sono i secondi tenuti, non le ripetizioni
  if (ex && ex.load === 'time') return (l.sets || 0) * (l.hold || (20 + (l.reps || 0)));
  const reps = isFinite(l.repsDone) && l.repsDone > 0 ? l.repsDone : (l.reps || 0);
  return (l.sets || 0) * reps;
}

/* Due registrazioni si confrontano solo sulla STESSA grandezza.
   Prima il confronto usava per ciascuna la metrica "migliore" disponibile: se
   in una seduta le ripetizioni superavano le 15, il massimale stimato non era
   più calcolabile e il volume della seduta nuova finiva paragonato al
   massimale della precedente. Numeri di scala diversa, risultato assurdo:
   aumentando le ripetizioni la valutazione scendeva a una stella.
   Ordine di preferenza: massimale stimato (se calcolabile per entrambe) →
   lavoro totale, cioè carico per serie per ripetizioni (o merito per volume
   sugli esercizi assistiti) → volume semplice. */
/* Numero di serie di una registrazione (righe serie per serie, se ci sono). */
const setsOf = l => { const rows = setRows(l); return Math.max(1, rows ? rows.length : (l.sets || 1)); };

/* Dalla 6.5 le grandezze di volume (tenuta, lavoro totale, ripetizioni) si
   confrontano PER SERIE: il numero di serie lo decide il programma (durata
   scelta in Oggi, settimana di scarico), non la prestazione. Prima una seduta
   da 35 minuti dopo una da 50, con le stesse ripetizioni in ogni serie,
   risultava un calo del 33% e prendeva una stella. Il massimale stimato è già
   per serie (la migliore) e non cambia. */
function comparePair(cur, prev) {
  const ex = exById(cur.exId);
  const per = (v, l) => v / setsOf(l);
  // esercizi a tempo: conta quanto hai tenuto, più metà del margine dichiarato
  // (la riserva è capacità, non lavoro svolto)
  if (ex && ex.load === 'time' && ex.type !== 'stretch') {
    const cap = l => {
      const rows = setRows(l);
      if (rows) return rows.reduce((a, r) => a + (r.hold || 0) + 0.5 * (isFinite(r.rir) ? r.rir : 0), 0);
      return (l.sets || 0) * ((l.hold || 0) + 0.5 * (l.rirUnit === 's' && isFinite(l.rir) ? l.rir : 0));
    };
    const a = cap(cur), b = cap(prev);
    if (a && b) return { a: per(a, cur), b: per(b, prev), what: 'tenuta per serie' };
  }
  const ea = e1rm(cur), eb = e1rm(prev);
  if (ea && eb) return { a: ea, b: eb, what: 'massimale stimato' };
  if (ex && ex.load === 'weight') {
    const ta = tonnage(cur), tb = tonnage(prev);
    if (ta && tb) return { a: per(ta, cur), b: per(tb, prev), what: isAssist(ex) ? 'lavoro per serie (aiuto e ripetizioni)' : 'lavoro per serie (carico per ripetizioni)' };
    const ma = meritValue(cur), mb = meritValue(prev);
    if (ma !== null && mb !== null && ma > 0 && mb > 0) {
      const va = volValue(cur), vb = volValue(prev);
      if (va && vb) return { a: per(ma * va, cur), b: per(mb * vb, prev), what: isAssist(ex) ? 'lavoro per serie (aiuto e ripetizioni)' : 'lavoro per serie (carico per ripetizioni)' };
      return { a: ma, b: mb, what: isAssist(ex) ? 'assistenza' : 'carico' };
    }
  }
  const va = volValue(cur), vb = volValue(prev);
  if (va && vb) return { a: per(va, cur), b: per(vb, prev), what: (ex && ex.load === 'time') ? 'secondi per serie' : 'ripetizioni per serie' };
  return null;
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
  // con le serie registrate una per una vale la migliore, come si fa di norma
  const rows = setRows(l);
  if (rows && !isAssist(ex)) {
    let best = null;
    rows.forEach(r => {
      const w = numLoad(r.load), rp = r.reps;
      if (w === null || w <= 0 || !isFinite(rp) || rp <= 0 || rp > 15) return;
      const v = w * (1 + rp / 30);
      if (best === null || v > best) best = v;
    });
    if (best !== null) return best;
  }
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

/* Serie di valori confrontabili fra loro per lo stesso esercizio: una sola
   metrica per tutta la serie, scelta in base a ciò che è disponibile per
   TUTTE le registrazioni. Mescolare massimale stimato e volume dentro lo
   stesso grafico faceva sembrare un crollo il passaggio a serie più lunghe. */
function seriesValues(logs) {
  if (!logs.length) return { vals: [], what: '' };
  const ex = exById(logs[0].exId);
  if (logs.every(l => e1rm(l))) return { vals: logs.map(l => e1rm(l)), what: 'massimale stimato' };
  if (ex && ex.load === 'weight' && logs.every(l => meritValue(l) !== null && volValue(l))) {
    return { vals: logs.map(l => meritValue(l) * volValue(l)), what: 'lavoro totale' };
  }
  if (logs.every(l => meritValue(l) !== null)) return { vals: logs.map(l => meritValue(l)), what: 'gradino' };
  return { vals: logs.map(l => volValue(l)), what: (ex && ex.load === 'time') ? 'secondi totali' : 'volume' };
}

/* Confronta una registrazione con la precedente dello stesso esercizio. */
/* (8.8) Numero vero (isFinite(null) è true: il «null» finiva a schermo). */
const hasNum = v => v !== null && v !== undefined && v !== '' && isFinite(v);
/* (8.4) Carico che l'app propone dopo un cambio di obiettivo, ricavato dalla
   registrazione precedente come in convertedLoad. */
function goalShiftProposal(cur, prev) {
  const ex = exById(cur.exId);
  if (!ex || ex.load !== 'weight' || isAssist(ex)) return null;
  const reps = isFinite(cur.repsTarget) ? cur.repsTarget : cur.reps;
  if (!isFinite(reps) || reps <= 0) return null;
  const e = e1rmWithRir(prev);
  if (!e) return null;
  const t = e.v / (1 + Math.min(25, reps + rirOfGoal(cur.goal)) / 30);
  return rackOf(ex) ? snapLoad(ex, t, -1) : Math.floor(t * 2) / 2;
}
/* (8.4) Registrazione con carico alleggerito per il dolore. */
const painLightened = l => !!l && (!!l.painAdj || !!(l.pain && l.pain.v >= PAIN_LIGHT));

function rateLog(cur, prev, deload) {
  const ex = exById(cur.exId);
  // allungamenti e mobilità non hanno un carico da confrontare: niente punteggio
  if (ex && ex.type === 'stretch') return { stars: 0, text: '' };
  if (!prev) return { stars: 0, text: 'Prima registrazione: da qui parte il confronto.' };

  // scale a gradini (band e progressioni a corpo libero): un gradino in più è
  // già la progressione prevista, due insieme sono un salto da segnalare
  const steps = ex && !cur._sameStep ? (ex.load === 'band' ? BANDS : levelsOf(ex)) : null;
  if (steps) {
    const ia = steps.indexOf(cur.load), ib = steps.indexOf(prev.load);
    if (ia >= 0 && ib >= 0) {
      // sugli esercizi assistiti il verso è invertito: scendere di band è un progresso
      const step = (ia - ib) * progressDir(ex);
      const nome = ex.load === 'band' ? 'band' : 'livelli';
      const shifted = cur.goal && prev.goal && cur.goal !== prev.goal;
      // in scarico il gradino resta quello: salire è un errore, scendere è tollerato
      if (deload) {
        if (step >= 1) return { stars: 3, warn: 'scarico', text: 'Settimana di scarico: sei salito di gradino invece di restare dov\'eri.',
          advice: 'Lo scarico serve al recupero di tendini e articolazioni: il gradino nuovo lo provi la settimana prossima.' };
        if (step === 0) return { stars: 3, text: 'Settimana di scarico: stesso gradino, volume ridotto come previsto.' };
        return { stars: 2, text: 'Settimana di scarico: gradino più facile del solito; bastava ridurre le serie.' };
      }
      // un gradino più difficile imposto dal programma (nuovo obiettivo, per
      // esempio dalle trazioni assistite alle serie pulite) non è un salto
      if (step >= 1 && shifted) return { stars: 5, text: 'Gradino più difficile con il nuovo obiettivo del programma.' };
      if (step >= 2) return { stars: 3, warn: 'salto',
        text: `Due ${nome} più difficili in una volta sola: è un salto di carico importante.`,
        advice: 'Torna al gradino intermedio per una seduta e sali solo quando superi l\'obiettivo di due ripetizioni per due sedute.' };
      if (step === 1) return { stars: 5, text: 'Sei passato al gradino successivo: progressione riuscita.' };
      // stesso gradino: si confrontano le ripetizioni (o i secondi) per serie
      // con la stessa regola degli esercizi a carico, attesa compresa
      if (step === 0) return rateLog(Object.assign({}, cur, { _sameStep: true }), Object.assign({}, prev, { _sameStep: true }), deload);
      return { stars: 1, text: 'Sei sceso a un gradino più facile rispetto alla volta scorsa.' };
    }
  }

  const cmp = comparePair(cur, prev);
  if (!cmp || !cmp.b) return { stars: 0, text: 'Dati insufficienti per il confronto.' };
  let ratio = cmp.a / cmp.b;
  const what = cmp.what;
  // obiettivo diverso dalla volta scorsa (per esempio forza dopo resistenza):
  // il confronto si fa sul lavoro totale e va detto, altrimenti sembra un
  // crollo o un balzo che non c'è
  const goalShift = cur.goal && prev.goal && cur.goal !== prev.goal
    ? ` Obiettivo diverso dalla volta scorsa (${(PROG.goals[prev.goal] || {}).label || prev.goal} → ${(PROG.goals[cur.goal] || {}).label || cur.goal}).` : '';
  // settimane di allenamento passate dall'ultima volta: quelle di scarico non
  // contano, perché lì la progressione è sospesa per scelta
  const w0 = weekOfIdx(prev.sIdx || 0), w1 = weekOfIdx(cur.sIdx || 0);
  let weeks = 0;
  for (let w = w0 + 1; w <= w1 && weeks < 2; w++) if (!isDeloadWeek(weekStart(w))) weeks++;
  // l'attesa cresce col tempo passato dall'ultima volta, ma si ferma a +5%:
  // un esercizio ripreso dopo un mese non deve pretendere un salto del 10%
  let expected = weeks > 0 ? 1 + 0.025 * Math.min(weeks, 2) : 1;
  // (8.4) obiettivo cambiato dal programma (per esempio da 5 a 10
  // ripetizioni): la prima seduta al nuovo obiettivo non deve progredire, e
  // chi usa il carico proposto dall'app (ricalcolato e arrotondato per
  // difetto al carico disponibile) e chiude le ripetizioni è in linea, non
  // «stabile» o «in calo» per effetto dell'arrotondamento
  // (8.5) il confronto è con quanto l'app chiedeva (carico proposto ×
  // ripetizioni obiettivo, formula di Epley): con un carico diverso da quello
  // proposto, per esempio 2 kg in più e 2 ripetizioni in meno, vale lo stesso
  // (8.8) stesso obiettivo ma ripetizioni prescritte diverse (il programma
  // cambia le dosi con le fasi e le settimane: 15 → 14, per esempio). Chi fa
  // le ripetizioni chieste non è «in calo»: il confronto si fa rispetto
  // all'obiettivo di ciascuna seduta, e la prima seduta alla dose nuova non
  // deve progredire
  const tc = hasNum(cur.repsTarget) ? +cur.repsTarget : null, tp = hasNum(prev.repsTarget) ? +prev.repsTarget : null;
  const targetShift = !goalShift && tc > 0 && tp > 0 && tc !== tp && !(ex && ex.load === 'time');
  const shiftNote = targetShift ? ` Ripetizioni prescritte diverse dalla volta scorsa (${tp} → ${tc}): il confronto tiene conto dell'obiettivo.` : '';
  if (goalShift || targetShift) {
    expected = 1;
    const prop = goalShiftProposal(cur, prev);
    const target = isFinite(cur.repsTarget) ? cur.repsTarget : cur.reps;
    if (prop && cmp.what === 'massimale stimato' && isFinite(target) && target > 0 && target <= 15) {
      const rp = cmp.a / (prop * (1 + target / 30));
      if (rp >= 0.97 && ratio < 1) ratio = rp >= 1 ? rp : 1;
    }
    if (targetShift && /ripetizioni per serie/.test(what)) {
      const rel = (cmp.a / tc) / (cmp.b / tp);
      if (rel > ratio) ratio = rel;
    }
  }
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
  // in scarico un calo moderato è proprio quello che si chiede: carico fermo,
  // qualche ripetizione e una serie in meno
  if (deload) {
    if (ratio >= 0.85) return { stars: 3, text: `Settimana di scarico: ${pct < 0 ? `${Math.abs(pct)}% in meno ${suRif(what)}, ` : ''}riduzione in linea con lo scarico.` };
    return { stars: 2, text: `Settimana di scarico: calo del ${Math.abs(pct)}% ${suRif(what)}, più marcato del necessario.` };
  }
  // due sedute di fila al limite: lo si segnala solo se non è arrivato nemmeno
  // un miglioramento, altrimenti si toglierebbe merito a un progresso vero
  if (cur.rir === 0 && prev.rir === 0 && ratio <= 1.02) {
    const sec = cur.rirUnit === 's';
    return { stars: 3, warn: 'cedimento',
      text: sec ? 'Seconda tenuta di fila portata fino al limite, senza guadagno.'
                : 'Seconda seduta di fila portata a zero ripetizioni di riserva su questo esercizio.',
      advice: sec ? 'Tieni qualche secondo di margine: l\'isometria rende di più se non arrivi al tremore.'
                  : 'Lavorare sempre al limite accumula fatica senza aggiungere stimolo: tieni 1-2 ripetizioni di margine.' };
  }
  if (ratio < 0.97) return { stars: goalShift ? 2 : 1, text: `Calo del ${Math.abs(pct)}% ${suRif(what)} rispetto alla volta scorsa.${goalShift}${shiftNote}` };
  if (ratio < expected - 0.005) return { stars: 2, text: expected > 1
    ? `Stabile: atteso circa +${Math.round((expected - 1) * 100)}% ${suRif(what)}.${goalShift}${shiftNote}`
    : `Poco sotto la volta scorsa (${pct}% ${suRif(what)}).${goalShift}${shiftNote}` };
  if (ratio <= expected + 0.02) return { stars: 3, text: `In linea con la progressione prevista (${pct >= 0 ? '+' : ''}${pct}% ${suRif(what)}).${goalShift}${shiftNote}` };
  // la fascia delle 4 stelle segue l'atteso: con +5% previsto (due settimane)
  // prima andava da +7% a +5%, cioè non esisteva
  if (ratio <= Math.max(expected + 0.05, 1 + SAFE_STEP / 2)) return { stars: 4, text: `Sopra le attese: +${pct}% ${suRif(what)}, ne era previsto +${Math.round((expected - 1) * 100)}%.${goalShift}${shiftNote}` };
  return { stars: (goalShift || targetShift) ? 4 : 5, text: `Progresso netto: +${pct}% ${suRif(what)}.${goalShift}${shiftNote}` };
}

/* ---------------------------------------------------------------------------
   VALUTAZIONE: UN SOLO PUNTO DI INGRESSO (dalla 6.5)
   Prima ogni punto dell'app sceglieva a modo suo la registrazione con cui
   confrontare e se la settimana fosse di scarico: la seduta registrata dal
   vivo, quella segnata come fatta, l'esercizio aggiunto a mano e il ricalcolo
   dello storico davano giudizi diversi sugli stessi numeri. Ora:
     · niente stelle a ciò che non ha una prestazione da misurare: allungamenti,
       aerobico, finale metabolico, sedute segnate come fatte alle dosi previste;
     · il riferimento è l'ultima registrazione reale dello stesso esercizio,
       mai una segnata come fatta; un test si confronta con il test precedente
       e le serie normali con le serie normali; fuori dallo scarico si salta la
       settimana di scarico, che altrimenti gonfierebbe il progresso successivo;
     · lo scarico si riconosce sempre allo stesso modo (isDeloadWeek).
--------------------------------------------------------------------------- */
const TEST_GOALS = ['pullupTest', 'muTest', 'burpeeTest', 'hangTest'];
// (6.6) i nomi veri degli obiettivi aerobici: nella 6.5 la lista usava nomi
// che il programma non ha, e reggeva solo grazie al controllo sull'attrezzo
const UNRATED_GOALS = ['cardioWarm', 'cardioCool', 'cardioHiit', 'cardioSteady', 'cardioRun', 'finisher', 'stretch', 'mobility'];
/* Aerobico e finale metabolico: intensità e durata le decide il programma
   (riscaldamento, parte centrale, defaticamento), quindi non sono prestazioni
   da confrontare. */
const isCardioEx = ex => !!ex && (ex.pattern === 'cardio' || ex.pattern === 'finisher' ||
  !!(ex.cardioModes && ex.cardioModes.length) || /^f_/.test(ex.id));
function isRatable(l) {
  const ex = exById(l.exId);
  if (!ex || l.planned) return false;
  if (ex.type === 'stretch' || isCardioEx(ex)) return false;
  return !UNRATED_GOALS.includes(l.goal);
}
/* Sedute distinte in un elenco di registrazioni: una seduta aerobica registra
   lo stesso attrezzo tre volte (riscaldamento, parte centrale, defaticamento),
   e contarle come tre sedute era sbagliato. */
const sessionKey = l => l.sid != null ? 's' + l.sid : 'd' + new Date(l.ts || 0).toDateString();
const sessionsCount = logs => new Set(logs.map(sessionKey)).size;
const isDeloadLog = l => !!l && l.sIdx != null && isDeloadWeek(l.sIdx);

/* ---------------------------------------------------------------------------
   RIPARTENZA DELLA PROGRESSIONE (dalla 6.9)
   Su richiesta dell'utente i conteggi della progressione ripartono dalla
   prima seduta DOPO la settimana di scarico (S.progressEpoch, posizione nel
   programma). Le registrazioni precedenti restano tutte nello storico ma non
   entrano più nei conteggi: niente stelle, niente punti nei grafici e nella
   tendenza, nessuna seduta valida per la regola 2-for-2. Per ogni esercizio
   l'ultima seduta normale prima dello scarico resta il RIFERIMENTO di partenza:
   carico suggerito, confronto della prima seduta dopo la ripartenza, primo
   punto della linea, tenute già guadagnate, massimo di trazioni.
--------------------------------------------------------------------------- */
const isPreEpoch = l => !!l && S.progressEpoch != null &&
  (l.sIdx != null ? l.sIdx < S.progressEpoch : (l.ts || 0) < (S.progressEpochTs || 0));
/* Riferimento di partenza di un esercizio: ultima seduta reale, fuori dallo
   scarico, prima della ripartenza. */
function epochBaseline(exId) {
  if (S.progressEpoch == null) return null;
  for (let i = S.logs.length - 1; i >= 0; i--) {
    const l = S.logs[i];
    if (l.exId === exId && isPreEpoch(l) && !l.planned && !isDeloadLog(l)) return l;
  }
  return null;
}
/* Registrazioni che entrano nella linea e nella tendenza: il riferimento più
   quelle dopo la ripartenza, senza scarico e sedute segnate come fatte. */
function progressLogs(exId, logs) {
  const src = (logs || S.logs.filter(l => l.exId === exId)).filter(l => !l.planned && !isDeloadLog(l));
  if (S.progressEpoch == null) return src;
  const base = epochBaseline(exId);
  return (base ? [base] : []).concat(src.filter(l => !isPreEpoch(l)));
}
/* Frase da mostrare: da quando conta la progressione. */
function epochNote() {
  if (S.progressEpoch == null) return '';
  let w = '';
  try { w = weekText(sessionMeta(S.progressEpoch)); } catch (e) { w = ''; }
  const started = (S.sessionIndex || 0) >= S.progressEpoch;
  return `Conteggio della progressione azzerato: ${started ? 'riparte' : 'ripartirà'} dalla ${w || 'settimana dopo lo scarico'}, dopo lo scarico. Riferimento di partenza: l'ultima seduta di ogni esercizio prima dello scarico.`;
}

/* Prima seduta della settimana che segue lo scarico più recente (o il
   prossimo, se non ce n'è ancora stato uno). */
function computeProgressEpoch() {
  const cur = S.sessionIndex || 0, wNow = weekOfIdx(cur);
  let d = null;
  for (let w = wNow; w >= 1; w--) if (isDeloadWeek(weekStart(w))) { d = w; break; }
  if (d === null) for (let w = wNow + 1; w <= wNow + 12; w++) if (isDeloadWeek(weekStart(w))) { d = w; break; }
  return d === null ? cur : weekStart(d + 1);
}
function ratingRef(cur, candidates) {
  const test = TEST_GOALS.includes(cur.goal);
  // le registrazioni della settimana di scarico non fanno mai da riferimento
  const c = (candidates || []).filter(l => l !== cur && l.exId === cur.exId && !l.planned && !isDeloadLog(l) &&
    !(cur.sid != null && l.sid === cur.sid) && TEST_GOALS.includes(l.goal) === test);
  // (8.4) una seduta alleggerita per il dolore non fa da riferimento (il
  // ritorno al carico normale sembrerebbe un progresso); se è l'unica, vale lei
  const ok = c.filter(l => !painLightened(l));
  const src = ok.length ? ok : c;
  return src.length ? src[src.length - 1] : null;
}
/* (8.7) Per il confronto contano solo le serie previste. */
function plannedPart(l) {
  if (!l || !l.extraSets || !Array.isArray(l.setLog)) return l;
  const n = Math.max(1, (l.sets || l.setLog.length) - l.extraSets);
  const rows = l.setLog.slice(0, n), last = rows[rows.length - 1] || {};
  return Object.assign({}, l, { setLog: rows, sets: rows.length, repsDone: isFinite(last.reps) ? last.reps : l.repsDone,
    rir: last.rir !== undefined && last.rir !== null ? last.rir : l.rir, extraSets: 0 });
}
function rateFor(cur0, candidates0) {
  const cur = plannedPart(cur0);
  const candidates = (candidates0 || []).map(l => l === cur0 ? cur : plannedPart(l));
  if (!isRatable(cur)) return { stars: 0, text: cur.planned ? 'Segnata come fatta alle dosi previste: senza dati reali non c\'è valutazione.' : '' };
  // (6.9) prima della ripartenza: fuori dal conteggio, fa solo da riferimento
  if (isPreEpoch(cur)) {
    const base = epochBaseline(cur.exId) === cur;
    return { stars: 0, text: base
      ? 'Riferimento di partenza: la progressione riparte dopo lo scarico confrontandosi con questa seduta.'
      : 'Prima della ripartenza dopo lo scarico: resta nello storico, fuori dal conteggio della progressione.' };
  }
  // (6.8) la settimana di scarico non entra nella progressione: niente stelle;
  // resta solo l'avviso se il carico è salito invece di restare fermo
  if (isDeloadLog(cur)) {
    const prev = ratingRef(cur, candidates);
    const r = prev ? rateLog(cur, prev, true) : null;
    const base = 'Settimana di scarico: registrata nello storico, non entra nei dati della progressione.';
    if (r && (r.warn === 'scarico' || r.warn === 'salto')) return { stars: 0, warn: 'scarico',
      text: base + ' ' + (r.warn === 'salto' ? r.text.replace(/^Carico aumentato/, 'Carico aumentato in settimana di scarico') : r.text),
      advice: 'Lo scarico serve al recupero di tendini e articolazioni: tieni i carichi della settimana prima, l\'aumento lo provi la settimana prossima.' };
    return { stars: 0, text: base };
  }
  const r = rateLog(cur, ratingRef(cur, candidates), false);
  // (8.4) carico alleggerito per il dolore (dall'app o segnato durante
  // l'esercizio): il calo non è una prestazione confrontabile
  if (painLightened(cur) && r.stars > 0 && r.stars < 3)
    return { stars: 0, text: `Carico alleggerito per il dolore: fuori dal confronto. (${r.text})` };
  return r;
}
/* Ricalcola in ordine di data le stelle di un esercizio (per esempio dopo
   l'aggiunta a mano di una registrazione nel passato). Tocca solo il giudizio. */
function rerateExercise(exId) {
  const logs = S.logs.filter(l => l.exId === exId).sort((a, b) => a.ts - b.ts);
  logs.forEach((l, i) => {
    const r = rateFor(l, logs.slice(0, i));
    l.stars = r.stars; l.rateText = r.text; l.warn = r.warn || ''; l.advice = r.advice || '';
  });
}

/* Preposizione corretta davanti al nome della metrica ("sul volume", ma
   "sull'assistenza"): l'elisione va gestita, altrimenti si legge "sul assistenza". */
const suRif = w => /^secondi/i.test(w) ? `sui ${w}`
  : /^ripetizioni/i.test(w) ? `sulle ${w}`
  : /^(tenuta|serie|progressione)/i.test(w) ? `sulla ${w}`
  : /^[aeiou]/i.test(w) ? `sull'${w}` : `sul ${w}`;

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
/* ---------------------------------------------------------------------------
   SETTIMANA DA 6 SEDUTE (dalla 5.0)
   Fino alla 4.8 la settimana aveva 5 sedute; dalla 5.0 ne ha 6. Le settimane
   già iniziate con il vecchio schema restano da 5, così indici, storico e
   riepiloghi del passato non cambiano: S.week6From è l'indice della prima
   seduta della prima settimana da 6. Tutto il codice passa da queste funzioni
   invece di dividere per 5.
--------------------------------------------------------------------------- */
const OLD_WEEK = 5;
/* Il passaggio alle settimane da 6 sedute avviene sempre a inizio settimana,
   quindi week6From è per costruzione un multiplo di 5 (migrateWeek6 lo calcola
   così). Un valore diverso — un backup modificato a mano, un file importato da
   un'altra installazione — mandava weekStart oltre l'indice e posOfIdx a -1:
   la prima seduta del programma usciva senza tipo, costruita come mobilità e
   registrata con kind indefinito, quindi invisibile ai conteggi delle sedute
   di forza. Qui il valore viene riportato all'inizio della sua settimana. */
const week6From = () => {
  if (!S || !isFinite(S.week6From)) return 0;
  const v = Math.max(0, Math.round(S.week6From));
  return v - (v % OLD_WEEK);
};
const week6No = () => Math.floor(week6From() / OLD_WEEK) + 1;
function weekOfIdx(idx) {
  const f = week6From();
  if (idx < f) return Math.floor(idx / OLD_WEEK) + 1;
  return week6No() + Math.floor((idx - f) / weekDays());
}
function weekStart(w) {
  return w < week6No() ? (w - 1) * OLD_WEEK : week6From() + (w - week6No()) * weekDays();
}
const weekLen = w => w < week6No() ? OLD_WEEK : weekDays();
const posOfIdx = idx => idx - weekStart(weekOfIdx(idx));
const weekDays = () => (PROG && PROG.week && PROG.week.days) || 6;
/* tipo di seduta per giorno: 'strength' | 'cardio' | 'stretch' */
function dayPattern(w) {
  if (weekLen(w) === OLD_WEEK) return ['strength', 'stretch', 'strength', 'stretch', 'strength'];
  return (PROG.week && PROG.week.pattern) || ['strength', 'cardio', 'strength', 'cardio', 'strength', 'stretch'];
}

/* Una volta sola: la settimana in corso resta com'era, le 6 sedute partono
   dalla prossima (o da subito, se la settimana non è ancora cominciata). */
function migrateWeek6() {
  if (isFinite(S.week6From)) return;
  const i = S.sessionIndex || 0;
  S.week6From = (i % OLD_WEEK === 0) ? i : i + (OLD_WEEK - i % OLD_WEEK);
  planCache = null;
  save();
}

/* Ordine delle sedute dentro una settimana. Di base segue lo schema; scambiando
   due sedute la permutazione viene salvata, così la seduta rinviata resta in
   programma e non va persa. */
function weekPerm(week) {
  const n = weekLen(week);
  const p = (S.perms && S.perms[week]) ? S.perms[week].slice() : [];
  return p.length === n ? p : Array.from({ length: n }, (_, i) => i + 1);
}
function swapDay(posA, posB) {
  const week = weekOfIdx(S.sessionIndex);
  const perm = weekPerm(week);
  const t = perm[posA]; perm[posA] = perm[posB]; perm[posB] = t;
  S.perms = S.perms || {};
  S.perms[week] = perm;
  // (8.4) l'attrezzo scelto per una seduta la segue quando cambia giorno
  if (S.sessPick) {
    const a = String(weekStart(week) + posA), b = String(weekStart(week) + posB);
    const pa = S.sessPick[a], pb = S.sessPick[b];
    delete S.sessPick[a]; delete S.sessPick[b];
    if (pb) S.sessPick[a] = pb;
    if (pa) S.sessPick[b] = pa;
  }
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
   un fastidio da lasciar passare. In quel caso tutte le sedute
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

/* ---------------------------------------------------------------------------
   DOVE SEI NEL PROGRAMMA — UN SOLO MODO DI DIRLO (dalla 5.12)
   La stessa informazione veniva scritta in quattro modi diversi: la Home
   mostrava la settimana di calendario, il riquadro Progressi quella di
   allenamento (che non conta le settimane di sola mobilità) e le Impostazioni
   un terzo conteggio ancora. Da qui in avanti il numero principale è sempre la
   settimana di calendario; la settimana di allenamento compare accanto solo
   quando le due differiscono, cioè quando c'è stata una settimana di sola
   mobilità. Ogni schermata usa queste tre funzioni, nessuna scrive più la
   posizione per conto proprio.
--------------------------------------------------------------------------- */
function weekText(meta, opt) {
  const o = opt || {};
  const p = meta.program || program();
  const total = totalWeeks(p) || p.cycleWeeks || 0;
  let t = `settimana ${meta.weekAbs}`;
  if (total) {
    t += (meta.trainingWeek === meta.weekAbs)
      ? ` di ${total}`
      : ` di calendario · allenamento ${meta.trainingWeek} di ${total}`;
  }
  return o.cap ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
function whereText(meta, opt) {
  const o = opt || {};
  const t = `sessione ${meta.pos} di ${meta.days} · ${weekText(meta)}`;
  return o.cap ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
/* Versione corta per le etichette in alto, dove lo spazio è poco. */
const shortWhere = meta => `Sett. ${meta.weekAbs} · sess. ${meta.pos} di ${meta.days}`;

function sessionMeta(idx) {
  // nessuna posizione prima della prima: un indice negativo arrivava da un
  // file importato o modificato a mano e faceva saltare tutte le schermate
  idx = Math.max(0, Math.round(idx) || 0);
  const p = program();
  const weekAbs = weekOfIdx(idx);
  const pos0 = Math.max(0, Math.min(weekLen(weekAbs) - 1, posOfIdx(idx)));
  const perm = weekPerm(weekAbs);
  const dayInWeek = perm[pos0] || pos0 + 1;
  const mobWeek = isMobilityWeek(weekAbs);
  const pattern = dayPattern(weekAbs);
  // in una settimana di sola mobilità nessuna seduta è di forza o aerobica
  const dayType = mobWeek ? 'stretch' : (pattern[dayInWeek - 1] || pattern[0]);
  const isStrength = dayType === 'strength';
  const isCardio = dayType === 'cardio';
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
  // indice del modello: A/B/C per la forza, intervalli/costante per
  // l'aerobico; per la mobilità si alternano i due schemi (nella settimana da
  // 6 ce n'è una sola, quindi si alterna di settimana in settimana)
  const nth = t => pattern.slice(0, dayInWeek - 1).filter(x => x === t).length;
  let tmplIdx;
  if (isStrength) tmplIdx = nth('strength');
  else if (isCardio) tmplIdx = nth('cardio');
  else if (mobWeek) tmplIdx = pos0 % 2;
  else tmplIdx = weekLen(weekAbs) === OLD_WEEK ? nth('stretch') : (weekAbs % 2);
  return { idx, dayInWeek, pos: pos0 + 1, days: weekLen(weekAbs), weekAbs, weekInCycle, cycleLen, mesocycle,
           isStrength, isCardio, dayType,
           mobilityWeek: mobWeek, trainingWeek: trainingWeekOf(weekAbs),
           phase: ph, tmplIdx, profile, program: p };
}

/* Filtri di sicurezza applicati a ogni pool di esercizi.
   - ginocchio: preferisce gli esercizi a basso impatto femoro-rotuleo
   - spalla: esclude spinte sopra la testa a presa prona, aperture in massima
     estensione e trazioni a presa larga, tipiche fonti di dolore in caso di
     conflitto subacromiale e sofferenza del capo lungo del bicipite
   Se il filtro svuoterebbe il pool, si mantiene l'elenco completo. */
function avoidListHtml() {
  const ids = Object.keys(S.avoid || {}).filter(isAvoided);
  if (!ids.length) return '';
  return `<div class="block" style="margin-top:12px"><h3 style="font-size:15px">Esercizi esclusi perché fastidiosi</h3>
    <ul class="hist">${ids.map(id => `<li><div class="nm" style="flex:1"><b>${esc((exById(id) || {}).name || id)}</b><div class="small muted">fino al ${dateIt(S.avoid[id])}</div></div>
      <button class="selbtn" data-unavoid="${esc(id)}">Riattiva</button></li>`).join('')}</ul></div>`;
}
/* (8) Esercizi segnati come fastidiosi: fuori dalle proposte per 4 settimane. */
const AVOID_MS = 28 * DAY_MS_8;
function isAvoided(id) { return !!(S.avoid && S.avoid[id] && S.avoid[id] > Date.now()); }
function applyCare(pool) {
  // (8) gli esercizi segnati «mi dà fastidio» escono, se resta un'alternativa
  if (S.avoid) { const ok = pool.filter(e => !isAvoided(e.id)); if (ok.length) pool = ok; }
  const pc = painCare();       // (8.3) dolore forte nell'ultima seduta: precauzioni temporanee
  if (S.kneeCare || pc.knee) {
    const safe = pool.filter(e => e.kneeFriendly);
    if (safe.length) pool = safe;
  }
  if (S.shoulderCare || pc.shoulder) {
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
   BLOCCO TRAZIONI E MUSCLE-UP (dalla 6.4)
   Obiettivo del programma: 15 trazioni pulite di fila e 2 muscle-up al
   30 maggio 2027. Tre sedute a settimana, sempre dopo i due esercizi
   fondamentali; attivazione scapolare o sospensione in chiusura se resta tempo.
   Il lavoro non cambia per calendario ma per TAPPE, secondo il massimo di
   trazioni pulite (pullMax) e di muscle-up (muMax) registrato:
     0      → prima trazione: negative, tenute isometriche, volume assistito;
     1-5    → prime ripetizioni: tante serie brevi pulite, negative, assistite;
     6-11   → volume a corpo libero: serie pulite, trazioni esplosive al petto;
     12+    → verso il muscle-up: dip e transizione alla sbarra bassa;
     12 + 1 muscle-up → serie di muscle-up.
   Le soglie sono regole operative dell'app: nessuna fonte verificata fissa
   prerequisiti numerici per il muscle-up. Le tappe del muscle-up richiedono
   anche che "evita gli esercizi dolorosi per la spalla" sia spento: il
   muscle-up è fra i gesti ginnici indicati come causa di infortuni alla spalla
   (Summitt et al. 2016) e va iniziato solo senza dolore.
   Serie pulite: massimo − 2 ripetizioni (sempre 2 di margine), mai a cedimento
   (Sánchez-Moreno et al. 2020: oltre una fatica moderata nessun guadagno in
   più). Il massimo si misura con un test nella prima settimana di ogni blocco,
   subito dopo lo scarico (Forza A; muscle-up in Forza B), ed è aggiornato
   anche dalle serie pulite registrate. Dalla 6.8 le prestazioni della
   settimana di scarico non entrano nei dati di progressione, quindi il test
   non può più stare lì.
--------------------------------------------------------------------------- */
const PULL_GOALS = { activation: 'pullupActivation', eccentric: 'pullupStrength',
                     isometric: 'pullupIso', volume: 'pullupVolume', row: 'pullupVolume',
                     strict: 'pullupStrict', power: 'pullupPower', dip: 'dipStrength',
                     skill: 'muSkill', mu: 'muPractice' };
const STRICT_LEVELS = ['Completa', 'Completa con tenuta di 2 s in alto', 'Completa con tempo lento'];
const PULL_RECENT_MS = 42 * 864e5;     // sei settimane: oltre, il dato è vecchio

/* Ripetizioni migliori di una registrazione (serie per serie se ci sono). */
function bestRepsOf(l) {
  const rows = setRows(l);
  const vals = rows ? rows.map(r => +r.reps) : [+(l.repsDone != null ? l.repsDone : l.reps)];
  return Math.max(0, ...vals.filter(isFinite));
}
/* Ripetizioni migliori di una registrazione contando solo le serie al livello
   richiesto (una serie annotata come assistita non vale come pulita). */
function bestAtLevels(l, okLevels) {
  const rows = setRows(l);
  if (rows) {
    const ok = rows.filter(r => okLevels.includes(r.load || l.load)).map(r => +r.reps).filter(isFinite);
    return ok.length ? Math.max(...ok) : 0;
  }
  return okLevels.includes(l.load) ? bestRepsOf(l) : 0;
}
/* Massimo attuale: il migliore fra test, serie registrate e valore dichiarato
   delle ultime sei settimane; se non c'è nulla di recente, l'ultimo dato. */
function liftMax(exId, okLevels, selfKey) {
  const cand = [];
  (S.logs || []).forEach(l => {
    if (l.exId !== exId || l.planned || isDeloadLog(l)) return;
    const n = bestAtLevels(l, okLevels);
    if (n > 0 || l.goal === 'pullupTest' || l.goal === 'muTest')
      cand.push({ n, ts: l.ts || 0, src: (l.goal === 'pullupTest' || l.goal === 'muTest') ? 'test' : 'serie' });
  });
  if (S.pullSelf && isFinite(S.pullSelf[selfKey]))
    cand.push({ n: Math.max(0, Math.round(S.pullSelf[selfKey])), ts: S.pullSelf.ts, src: 'dichiarato' });
  if (!cand.length) return { n: 0, ts: 0, src: 'nessuno' };
  const now = Date.now();
  const recent = cand.filter(c => now - c.ts <= PULL_RECENT_MS);
  if (recent.length) return recent.reduce((a, b) => (b.n > a.n || (b.n === a.n && b.ts > a.ts)) ? b : a);
  return cand.reduce((a, b) => b.ts > a.ts ? b : a);
}
const pullMax = () => liftMax('g_pullup', STRICT_LEVELS, 'n');
const muMax = () => liftMax('g_muscleup', ['Completo'], 'mu');

/* Tappa attuale del blocco trazioni. blocked = la tappa che spetterebbe ma
   resta chiusa per la precauzione sulla spalla. */
function pullStage() {
  const st = PROG.pullupBlock && PROG.pullupBlock.stages;
  if (!st || !st.length) return null;
  const m = pullMax().n, mu = muMax().n;
  let pick = st[0], blocked = null;
  st.forEach(x => {
    if (m >= x.min && mu >= (x.minMu || 0)) {
      if (x.needsShoulder && S.shoulderCare) { if (!blocked) blocked = x; return; }
      pick = x;
    }
  });
  const next = st[st.indexOf(pick) + 1] || null;
  return { stage: pick, idx: st.indexOf(pick), next, blocked, m, mu };
}
/* Il test cade nella prima settimana del blocco, dopo lo scarico (e nella
   prima del programma): trazioni in Forza A, muscle-up in Forza B quando sono
   già in programma. */
function pullTestFor(meta, ps) {
  if (!meta.profile || meta.weekInCycle !== 1 || meta.profile.label === 'Scarico' || meta.mobilityWeek || S.setup !== 'gym' || !ps) return null;
  if (meta.tmplIdx === 0) return 'pull';
  if (meta.tmplIdx === 1 && ps.stage.id === 'mu') return 'mu';
  return null;
}
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  const ps = pullStage();
  const days = ps ? ps.stage.days : cfg.days;
  const roles = days[meta.tmplIdx % days.length];
  const test = pullTestFor(meta, ps);
  const items = [];
  roles.forEach((role, i) => {
    let ex = null;
    if (role === 'strict' && S.setup === 'gym' && !isAvoided('g_pullup')) ex = exById('g_pullup');
    if (!ex) ex = pickFrom(pullPool(role === 'strict' ? 'volume' : role), (meta.mesocycle - 1) + i, used);
    if (!ex) return;
    used.add(ex.id);
    const own = ex.id === 'g_pullup' && role === 'strict';
    const goalKey = (own || ex.pullRole === role) ? PULL_GOALS[role] : (PULL_GOALS[ex.pullRole] || PULL_GOALS[role]);
    const d = dose(goalKey, meta.profile, ex);
    let note = ps ? `Trazioni · ${ps.stage.label}` : 'Obiettivo trazioni', level = null, gk = goalKey;
    if (own) {
      level = 'Completa';
      if (test === 'pull') {
        gk = 'pullupTest';
        // (7S 0) fino alla gara il test è anche lo Spartan Race check delle trazioni
        const spc = spCheckKinds(meta).includes('pull') ? spCheckFor(meta.idx, 'pull') : null;
        Object.assign(d, { goal: gk, goalLabel: PROG.goals.pullupTest.label, rpe: PROG.goals.pullupTest.rpe,
                           source: PROG.goals.pullupTest.source, sets: 1, rest: 0, reps: Math.max(1, ps.m + 1, spc ? spc.goal : 0) },
                         spc ? { spKind: 'pull', spCheck: true } : {});
        note = spc ? `${spCheckLabel('pull', spc.goal, spc.first)} · a fine programma ${pullTarget().n}`
                   : `Test del mese · prova a superare ${ps.m} ${ps.m === 1 ? 'trazione' : 'trazioni'}`;
      } else {
        // sempre due ripetizioni di margine rispetto al massimo
        d.reps = clampN(ps.m - 2, 1, 12);
        d.sets = clampN((ps.m <= 5 ? 5 : 4) + (meta.profile.setsDelta || 0), 2, 6);
      }
    }
    if (ex.id === 'g_muscleup') {
      level = 'Completo';
      if (test === 'mu') {
        gk = 'muTest';
        Object.assign(d, { goal: gk, goalLabel: PROG.goals.muTest.label, rpe: PROG.goals.muTest.rpe,
                           source: PROG.goals.muTest.source, sets: 1, rest: 0, reps: ps.mu + 1 });
        note = `Test del mese · prova a superare ${ps.mu} muscle-up`;
      } else d.reps = clampN(ps.mu - 1, 1, 5);
    }
    items.push(Object.assign({ exId: ex.id, note, goalKey: gk, block: 'pullup', role: role === 'activation' ? 'activation' : 'pull',
                 alt: { patterns: ['pullup'], types: ['strength'], roles: [role] } }, d, level ? { level } : {}));
  });
  return items;
}

function slotPool(patterns) {
  // Il pool si costruisce pattern per pattern: così il filtro "ginocchio" non
  // cancella un intero schema di movimento (es. gli affondi) lasciando in piedi
  // solo un altro pattern dello stesso slot.
  let pool = [];
  patterns.forEach(pat => {
    let sub = DB.exercises.filter(e => e.setup.includes(S.setup) &&
      (e.type === 'strength' || e.type === 'core') && e.pattern === pat);
    sub = applyCare(sub);
    pool = pool.concat(sub.sort((a, b) => a.id.localeCompare(b.id)));
  });
  return pool;
}

/* ---------------------------------------------------------------------------
   MUSCOLI SPECIFICI (dalla 8.3)
   Alcuni slot non chiedono uno schema di movimento ma un muscolo preciso
   (campo «focus» dell'esercizio): capo lungo del tricipite, bicipite,
   brachiale, avambracci, deltoide posteriore, trapezio superiore, obliqui,
   addome, fasci alti del petto. Le precauzioni per ginocchio e spalla qui sono
   rigide (nessun esercizio a rischio come ripiego): se non resta nulla si passa
   al «fallback» dello slot (per esempio dal capo lungo al push-down), poi,
   solo se lo slot lo consente («loose»), allo schema di movimento generico.
--------------------------------------------------------------------------- */
function strictCare(pool) {
  const pc = painCare();
  return pool.filter(e => !isAvoided(e.id) && (!(S.kneeCare || pc.knee) || e.kneeFriendly) &&
    (!(S.shoulderCare || pc.shoulder) || !e.shoulderRisk));
}
function focusPool(focus) {
  const sub = DB.exercises.filter(e => e.setup.includes(S.setup) && (e.type === 'strength' || e.type === 'core') &&
    (e.focus || []).some(f => focus.includes(f)));
  return strictCare(sub).sort((a, b) => a.id.localeCompare(b.id));
}
function slotPoolFor(slot) {
  if (!slot.focus) return slotPool(slot.patterns);
  let pool = focusPool(slot.focus);
  if (!pool.length && slot.fallback) pool = focusPool(slot.fallback);
  if (!pool.length && slot.loose) pool = slotPool(slot.patterns);
  return pool;
}

/* Finale metabolico scelto in Programma (a casa si ripiega sull'unico
   disponibile senza attrezzi). */
/* i finali della 4.8 su attrezzi non disponibili portano al più vicino */
const FINISHER_MAP = { f_bikehiit: 'a_spinning', f_armergo: 'a_recumbent', f_inclinewalk: 'a_recumbent' };
function finisherExercise() {
  const want = FINISHER_MAP[S.finisher] || S.finisher || 'a_spinning';
  if (want === 'none') return null;
  let ex = exById(want);
  if (!ex || ex.retired || !ex.setup.includes(S.setup)) ex = DB.exercises.find(e => (e.cardioModes || []).includes('hiit') && e.setup.includes(S.setup));
  return ex || null;
}
function finisherItem(meta, forceId) {
  const ex = forceId ? exById(forceId) : finisherExercise();
  if (!ex) return null;
  const g = PROG.goals.finisher, iv = ex.interval || { sets: g.sets, work: g.hold, rest: g.rest };
  // in settimana di scarico il finale si accorcia come il resto del volume
  const sets = meta.profile.label === 'Scarico' ? Math.max(1, Math.ceil(iv.sets * 0.6)) : iv.sets;
  return { exId: ex.id, note: 'Per il grasso addominale · se resta tempo', goalKey: 'finisher', role: 'finisher',
           alt: { patterns: ['finisher'], types: ['strength'] },
           goal: 'finisher', goalLabel: g.label, sets, reps: 1, perSide: false,
           rest: iv.rest, hold: iv.work, rpe: g.rpe, source: g.source,
           workLabel: iv.sets > 1 ? 'Scatto' : 'Lavoro', restLabel: 'Ritmo tranquillo' };
}

/* ---------------------------------------------------------------------------
   SEDUTA DI FORZA
   Ordine e priorità (dalla 4.8):
     1. i due esercizi principali del giorno, a fresco;
     2. il blocco trazioni e muscle-up, per tappe (vedi buildPullBlock):
        dopo i fondamentali; dalla 6.4 quando si accorcia la seduta si tagliano
        prima i complementari;
     3. gli altri esercizi del giorno;
     4. se resta tempo: esercizi supplementari, il finale metabolico e, per
        ultima, la sospensione alla sbarra. Dalla 6.3 i supplementari non
        vengono da una lista fissa: li sceglie weekNeeds, per i gruppi che
        nella settimana restano sotto le 10 serie (minimo ACSM 2026) tenendo
        conto di quanto il programma prevede e di quanto hai fatto davvero.
        Mai nelle settimane di scarico.
   La durata scelta in Home (35-50 minuti) decide quanto di tutto questo entra:
   vedi fitToTime e fillToTime.
--------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
   DI COSA HA BISOGNO LA SETTIMANA (dalla 6.3)
   Per ogni gruppo muscolare si stima dove arriverà la settimana:
     · sedute già passate (prima della seduta corrente del programma): le
       serie REGISTRATE, quindi anche quelle saltate o accorciate;
     · seduta in esame e successive: le serie che il programma PREVEDE, senza
       supplementari.
   Ai gruppi che restano sotto VOL_TARGET (10 serie) vanno i supplementari,
   prima ai più indietro. Le registrazioni della seduta in esame non entrano
   (salvo includeSelf, per gli esercizi in più a fine seduta): così la seduta
   di oggi non cambia mentre la si registra.
   Le sedute di base si costruiscono con volProbe attivo, che spegne i
   supplementari: nessuna ricorsione.
--------------------------------------------------------------------------- */
let volProbe = false, baseVolMemo = new Map(), baseVolKey = null;
function baseSessionVolumes(weekAbs) {
  const sig = planSignature();
  if (sig !== baseVolKey) { baseVolMemo.clear(); baseVolKey = sig; }
  if (baseVolMemo.has(weekAbs)) return baseVolMemo.get(weekAbs);
  const out = [];
  const was = volProbe;
  volProbe = true;
  try {
    for (let k = 0; k < weekLen(weekAbs); k++) {
      const idx = weekStart(weekAbs) + k, acc = {};
      let sess = null;
      try { sess = buildSession(idx); } catch (e) { sess = null; }
      if (sess && sess.type === 'strength')
        sess.items.forEach(it => addInto(acc, groupSetsOf(exById(it.exId), it.sets)));
      out.push({ idx, acc });
    }
  } finally { volProbe = was; }
  baseVolMemo.set(weekAbs, out);
  return out;
}
/* Volume previsto dal programma per la settimana, senza supplementari. */
function weekBaseVolume(weekAbs) {
  const acc = {};
  baseSessionVolumes(weekAbs).forEach(x => addInto(acc, x.acc));
  return acc;
}
/* Serie registrate per gruppo nella seduta idx. */
function doneInSession(idx) {
  const acc = {};
  S.logs.forEach(l => { if (l.sIdx === idx && !l.spartan) addInto(acc, groupSetsOf(exById(l.exId), l.sets || 0)); });
  return acc;
}
/* Proiezione della settimana vista dalla seduta idx e gruppi sotto il minimo,
   dal più indietro. */
function weekNeeds(idx, opt) {
  const o = opt || {};
  const proj = {};
  baseSessionVolumes(weekOfIdx(idx)).forEach(x => {
    const past = x.idx < idx && x.idx < S.sessionIndex;
    const self = x.idx === idx && o.includeSelf;
    addInto(proj, past || self ? doneInSession(x.idx) : x.acc);
  });
  const groups = VOL_GROUPS.filter(g => (proj[g] || 0) < VOL_TARGET)
    .sort((a, b) => (proj[a] || 0) - (proj[b] || 0));
  return { proj, groups };
}
/* Gruppi principali di un esercizio (solo i muscoli primari). */
const primaryGroups = ex => [...new Set((ex.primary || []).map(muscleGroup).filter(Boolean))];
/* Schemi di movimento con cui si allena in modo mirato ciascun gruppo. */
const EXTRA_PATTERNS = {
  'Petto': ['pushH'], 'Dorso': ['pullH', 'pullV'], 'Spalle': ['shoulderIso', 'pushV'],
  'Braccia': ['arms'], 'Quadricipiti': ['quadIso', 'squat'], 'Glutei e femorali': ['hamIso', 'hinge'],
  'Polpacci': ['calf'], 'Core': ['coreAnti', 'coreFlex']
};
const MAX_EXTRAS = 2;
const LEG_GROUPS = ['Quadricipiti', 'Glutei e femorali', 'Polpacci'];

function buildStrength(meta, budget) {
  const tmpl = meta.program.strengthDays[meta.tmplIdx];
  const used = new Set(), items = [];
  const pull = buildPullBlock(meta, used);
  const pullMain = pull.filter(it => it.role !== 'activation');
  const pullTail = pull.filter(it => it.role === 'activation');
  const dayGoal = (meta.phase && meta.phase.ph.goals && meta.phase.ph.goals[meta.tmplIdx]) || tmpl.goal;

  const main = [];
  // (8.3) i muscoli che il giorno allena con uno slot dedicato non occupano gli
  // slot generici (per esempio le alzate posteriori al posto del rematore)
  const dayFocus = new Set();
  tmpl.slots.forEach(sl => (sl.focus || []).concat(sl.fallback || []).forEach(f => dayFocus.add(f)));
  tmpl.slots.forEach((slot, i) => {
    if (slot.skipIfPullBlock && pullMain.length) return;   // la tirata verticale c'è già
    let pool = slotPoolFor(slot);
    // (8.3) in superserie solo esercizi a ripetizioni: con le tenute a tempo
    // il timer farebbe tutta la sequenza di fila e l'alternanza salterebbe
    if (slot.ss) { const reps = pool.filter(e => e.load !== 'time'); if (reps.length) pool = reps; }
    if (!slot.focus && dayFocus.size) {
      const free = pool.filter(e => !(e.focus || []).some(f => dayFocus.has(f)));
      if (free.length) pool = free;
    }
    const rot = (meta.mesocycle - 1) * (meta.tmplIdx + 2) + i;   // rotazione per mesociclo
    const ex = pickFrom(pool, rot, used);
    if (!ex) return;
    let goalKey = slot.goal || dayGoal;
    // (8.7) slot con un muscolo preciso ripiegato sullo schema generico (per
    // esempio a casa senza kettlebell per lo slancio): obiettivo di ripiego
    if (slot.looseGoal && slot.focus && !(ex.focus || []).some(f => slot.focus.includes(f))) goalKey = slot.looseGoal;
    // con un focus lo slot conta solo per il muscolo: il primo resta comunque 'key'
    main.push({ exId: ex.id, note: slot.note || '', baseNote: slot.note || '', goalKey, role: main.length < 2 ? 'key' : 'main',
                alt: { patterns: slot.patterns.slice(), types: ['strength', 'core'], ...(slot.focus ? { focus: slot.focus.concat(slot.fallback || []) } : {}) },
                ...(slot.ss ? { ssSlot: slot.ss } : {}),
                ...dose(goalKey, meta.profile, ex) });
    main[main.length - 1].doseSets = main[main.length - 1].sets;
  });
  // (8.3) superserie previste dal programma: i due slot con lo stesso «ss»
  presetSupersets(main);
  main.slice(0, 2).forEach(it => items.push(it));
  pullMain.forEach(it => items.push(it));
  main.slice(2).forEach(it => items.push(it));

  // riserva per il tempo in più: supplementari, finale, sospensione
  // i supplementari vanno ai gruppi che la settimana lascia sotto il minimo,
  // tenendo conto del programma e di quanto è stato fatto; mai in scarico,
  // dove il volume più basso è voluto
  const extras = [];
  const deloadWeek = meta.profile && meta.profile.label === 'Scarico';
  if (!volProbe && !deloadWeek) {
    const need = weekNeeds(meta.idx);
    const p = Object.assign({}, need.proj);
    need.groups.forEach(g => {
      if (extras.length >= MAX_EXTRAS || (p[g] || 0) >= VOL_TARGET) return;
      // (8.7) gambe: l'obiettivo è tono, forza e sostegno del ginocchio, non
      // l'ipertrofia: le 10 serie (soglia per l'ipertrofia) non si inseguono
      if (LEG_GROUPS.includes(g)) return;
      const pats = EXTRA_PATTERNS[g] || [];
      const pool = slotPool(pats).filter(e => !used.has(e.id) && e.type === 'strength' && primaryGroups(e).includes(g));
      const ex = pickFrom(pool, (meta.mesocycle - 1) + extras.length, used);
      if (!ex) return;
      const goalKey = dayGoal === 'strength' ? 'hypertrophy' : dayGoal;   // i complementari restano a ripetizioni medie
      const d = dose(goalKey, meta.profile, ex);
      d.sets = Math.max(2, d.sets - 1);
      if (d.perSide && d.sets % 2) d.sets++;
      const why = `${g} a ${fmtSets(p[g] || 0)} serie su ${VOL_TARGET} questa settimana`;
      addInto(p, groupSetsOf(ex, d.sets));   // il prossimo supplementare tiene conto di questo
      extras.push({ exId: ex.id, note: `Supplementare · ${why} · se resta tempo`, goalKey, role: 'extra',
                    alt: { patterns: pats.slice(), types: ['strength'] }, ...d });
    });
  }
  const fin = finisherItem(meta);
  pullTail.forEach(it => { it.note = 'Trazioni · in chiusura, se resta tempo'; });

  // a 50 minuti una decina di minuti restano riservati al finale
  // metabolico: il resto della seduta si adatta al tempo che rimane
  const reserve = (fin && budget >= 50) ? FINISHER_RESERVE : 0;
  // (8) con 35 minuti i complementari vanno in superserie
  if (budget <= 35) pairSupersets(items);
  const trimmed = fitToTime(items, budget - reserve, pullTail);
  fillToTime(items, budget, { extras, finisher: fin, tail: pullTail, reserve });
  finalizeSupersets(items);

  const gLabel = meta.phase && PROG.goals[(meta.phase.ph.goals || [])[meta.tmplIdx]]
    ? PROG.goals[meta.phase.ph.goals[meta.tmplIdx]].label : '';
  return { label: tmpl.label, type: 'strength', items, dayGoalLabel: gLabel, trimmed };
}

function buildStretch(meta, budget) {
  const chosen = pickOf(meta.idx) || {};
  const sDays = meta.program.stretchDays;
  const ti = (chosen.stretch != null && sDays[chosen.stretch]) ? chosen.stretch : meta.tmplIdx;
  const tmpl = sDays[ti];
  const used = new Set(), items = [];
  const dyn = DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'mobility' && e.setup.includes(S.setup));
  const stat = DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'static' && e.setup.includes(S.setup)
                                        && tmpl.staticGroups.includes(e.group));
  dyn.sort((a, b) => a.id.localeCompare(b.id));
  stat.sort((a, b) => a.id.localeCompare(b.id));
  let rot = (meta.mesocycle - 1) * 2 + ti + (meta.weekInCycle - 1);
  // in una settimana di sola mobilità tutte le sedute sono di allungamento: la rotazione
  // scorre a ogni seduta, così non si ripetono gli stessi allungamenti
  if (meta.mobilityWeek) rot += (meta.pos - 1) * 2;
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
  const label = meta.mobilityWeek ? `${tmpl.label} · seduta ${meta.pos} di ${meta.days}` : tmpl.label;
  const trimmed = fitToTime(items, budget || 35, []);
  // tempo in più: altri allungamenti dello stesso schema, poi una tenuta in più
  if (!trimmed) {
    // oltre ai gruppi del giorno, qualunque allungamento statico non ancora usato
    const anyStat = DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'static' && e.setup.includes(S.setup))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (let i = tmpl.count; i < tmpl.count + 6; i++) {
      let cand = stat.filter(e => !used.has(e.id));
      if (!cand.length) cand = anyStat.filter(e => !used.has(e.id));
      if (!cand.length) break;
      const ex = cand[(rot + i) % cand.length];
      const it = { exId: ex.id, note: 'Se resta tempo', goalKey: 'stretch',
                   alt: { patterns: ['static'], types: ['stretch'], groups: tmpl.staticGroups.slice() },
                   ...dose('stretch', meta.profile, ex) };
      if (estimateMinutes(items.concat([it])) > (budget || 35)) break;
      used.add(ex.id); items.push(it);
    }
    // tenute più lunghe: 30-60 secondi è l'indicazione per gli adulti più
    // anziani (ACSM, Garber et al. 2011: "in older persons")
    items.forEach(it => {
      if (it.goal !== 'stretch' || it.hold >= 45) return;
      const h = it.hold; it.hold = 45;
      if (estimateMinutes(items) > (budget || 35)) it.hold = h;
    });
    items.forEach(it => {
      if (it.goal !== 'stretch' || it.sets >= 4) return;
      it.sets += it.perSide ? 2 : 1;
      if (estimateMinutes(items) > (budget || 35)) it.sets -= it.perSide ? 2 : 1;
    });
  }
  return { label, type: 'stretch', items, trimmed };
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

/* ---------------------------------------------------------------------------
   DURATA DELLE SEDUTE
   La stima conta il lavoro, i recuperi FRA le serie e, per ogni esercizio, il
   tempo di cambio: spostarsi, regolare la macchina, preparare il carico. Prima
   del 4.8 il cambio non c'era, e le sedute stimate in 35 minuti ne duravano
   47-57. Il primo esercizio di forza include anche le serie di avvicinamento.
   Il ritmo personale si impara dalle sedute reali, separatamente per forza e
   mobilità (i due tipi di seduta hanno tempi morti molto diversi).
--------------------------------------------------------------------------- */
const DURATIONS = [35, 40, 45, 50];
const CHANGE_SEC = { strength: 75, stretch: 15, finisher: 60, warmup: 30, cardio: 10, cooldown: 10, spartan: 45 };
const CARDIO_ROLES = ['warmup', 'cardio', 'cooldown'];
const WARMUP_SEC = 150;          // serie di avvicinamento sul primo esercizio di forza

const sessionKindOf = items => items.some(it => CARDIO_ROLES.includes(it.role)) ? 'cardio'
  : items.every(it => { const e = exById(it.exId); return e && e.type === 'stretch'; }) ? 'stretch' : 'strength';

function workSecOf(it) {
  if (it.goal === 'stretch' || it.hold) return it.hold || 30;
  const ex = exById(it.exId);
  if (ex && ex.carry) return it.reps * 1.2;        // trasporti: le ripetizioni sono passi
  return (ex && ex.load === 'time') ? 20 + it.reps : it.reps * 3.5;
}
function rawSeconds(items) {
  const kind = sessionKindOf(items);
  let sec = kind === 'strength' ? 60 + WARMUP_SEC : 60;   // l'aerobico ha il suo riscaldamento
  items.forEach(it => {
    const ex = exById(it.exId);
    const change = CHANGE_SEC[it.role] !== undefined && it.role !== 'strength' ? CHANGE_SEC[it.role]
                 : (ex && ex.type === 'stretch') ? CHANGE_SEC.stretch : CHANGE_SEC.strength;
    // (8) superserie: il recupero è uno solo per giro, il secondo esercizio
    // paga solo il passaggio di pochi secondi
    const mate = it.ss ? items.find(x => x !== it && x.ss === it.ss) : null;
    if (mate && it.ssRole === 'B') { sec += it.sets * workSecOf(it) + it.sets * SS_TRANSFER + 20; return; }
    if (mate && it.ssRole === 'A') {
      const rounds = Math.max(it.sets, mate.sets);
      sec += it.sets * workSecOf(it) + Math.max(0, rounds - 1) * Math.max(it.rest, mate.rest) + change; return;
    }
    sec += it.sets * workSecOf(it) + Math.max(0, it.sets - 1) * it.rest + change;
  });
  return sec;
}
const SS_TRANSFER = 20;          // secondi per passare da un esercizio all'altro della superserie

/* ---------------------------------------------------------------------------
   SUPERSERIE FRA GRUPPI DIVERSI (dalla 8)
   Con 35 minuti i complementari si accoppiano a due a due, alternando le
   serie: prima l'uno, 20 secondi per spostarsi, poi l'altro, quindi il
   recupero. Si accoppiano solo gruppi diversi, di preferenza antagonisti
   (spinta con tirata, gambe con parte alta): Zhang et al. 2025 (Sports Med,
   meta-analisi) trovano con le superserie lo stesso volume in meno tempo e
   nessuna differenza su forza e ipertrofia; quelle agonista-antagonista
   mantengono il volume, quelle sullo stesso muscolo lo riducono. Sono più
   faticose (RPE e lattato più alti). I due esercizi principali e il blocco
   trazioni restano con il recupero pieno. Il tempo risparmiato va ai
   supplementari (fillToTime).
--------------------------------------------------------------------------- */
const SS_FAMILY = { pushH: 'push', pushV: 'push', shoulderIso: 'push', pullH: 'pull', pullV: 'pull', arms: 'arms', forearm: 'arms', traps: 'pull',
  squat: 'legs', lunge: 'legs', quadIso: 'legs', hamIso: 'legs', hinge: 'legs', calf: 'legs', hipAdd: 'legs', hipAbd: 'legs', coreAnti: 'core', coreFlex: 'core' };
function pairSupersets(items) {
  const famOf = it => SS_FAMILY[(exById(it.exId) || {}).pattern] || 'other';
  const grpOf = it => primaryGroups(exById(it.exId) || {})[0] || '';
  const score = (a, b) => {
    const fa = famOf(a), fb = famOf(b);
    if (grpOf(a) && grpOf(a) === grpOf(b)) return -1;            // stesso gruppo: mai
    if (fa === fb && fa !== 'other') return -1;
    if ((fa === 'push' && fb === 'pull') || (fa === 'pull' && fb === 'push')) return 3;
    if ((fa === 'legs') !== (fb === 'legs')) return 2;
    return 1;
  };
  const pool = items.filter(it => it.role === 'main' && !it.ss && (exById(it.exId) || {}).load !== 'time');
  let n = 0;
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (a.ss) continue;
    let best = null, bs = 0;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j];
      if (b.ss) continue;
      const sc = score(a, b);
      if (sc > bs) { bs = sc; best = b; }
    }
    if (!best) continue;
    n++;
    const id = 'ss' + n;
    a.ss = id; a.ssRole = 'A'; best.ss = id; best.ssRole = 'B';
    // il secondo esercizio subito dopo il primo
    items.splice(items.indexOf(best), 1);
    items.splice(items.indexOf(a) + 1, 0, best);
  }
  return n;
}
/* (8.3) Superserie scritte nel programma: valgono a qualunque durata. */
function presetSupersets(list) {
  const by = {};
  list.forEach(it => { if (it.ssSlot) (by[it.ssSlot] = by[it.ssSlot] || []).push(it); });
  Object.keys(by).forEach(k => {
    const g = by[k];
    if (g.length !== 2 || g.some(it => (exById(it.exId) || {}).load === 'time')) return;
    g[0].ss = 'p' + k; g[0].ssRole = 'A'; g[1].ss = 'p' + k; g[1].ssRole = 'B';
  });
}
/* Dopo i tagli e le aggiunte: coppie ancora intere, una accanto all'altra,
   numerate nell'ordine della seduta, con la nota che dice come si svolgono. */
function finalizeSupersets(items, opt) {
  const noMove = opt && opt.noMove;     // seduta in corso: le posizioni non si toccano
  const ids = [...new Set(items.filter(it => it.ss).map(it => it.ss))];
  ids.forEach(id => {
    const g = items.filter(it => it.ss === id);
    if (g.length !== 2) { g.forEach(it => { delete it.ss; delete it.ssRole; }); return; }
    const a = g.find(it => it.ssRole === 'A') || g[0], b = g.find(it => it !== a);
    a.ssRole = 'A'; b.ssRole = 'B';
    if (noMove) return;
    items.splice(items.indexOf(b), 1);
    items.splice(items.indexOf(a) + 1, 0, b);
  });
  let n = 0;
  items.forEach(it => {
    if (it.baseNote === undefined) it.baseNote = it.note || '';
    if (!it.ss) { it.note = it.baseNote; delete it.ssN; return; }
    if (it.ssRole === 'A') n++;
    it.ssN = it.ssRole === 'A' ? n : (items.find(x => x !== it && x.ss === it.ss) || {}).ssN || n;
    const mate = items.find(x => x !== it && x.ss === it.ss);
    const mn = (exById(mate.exId) || {}).name || '';
    it.note = `Superserie ${it.ssN} · ${it.ssRole === 'A' ? '1°' : '2°'} esercizio, alternato con ${mn}${it.baseNote ? ' · ' + it.baseNote : ''}`;
  });
}
function paceOf(kind) {
  const p = S && S.pace && isFinite(S.pace[kind]) && S.pace[kind] > 0 ? S.pace[kind] : 1;
  return p;
}
/* Minuti che costa un singolo esercizio in più: lavoro, recuperi fra le serie
   e il tempo per prepararlo. Non include il "costo fisso" della seduta, che è
   già stato pagato. */
function itemMinutes(it) {
  const ex = exById(it.exId);
  const change = CHANGE_SEC[it.role] !== undefined && it.role !== 'strength' ? CHANGE_SEC[it.role]
    : (ex && ex.type === 'stretch') ? CHANGE_SEC.stretch : CHANGE_SEC.strength;
  const sec = it.sets * workSecOf(it) + Math.max(0, it.sets - 1) * it.rest + change;
  return Math.round(sec * paceOf(sessionKindOf([it])) / 60);
}

function estimateMinutes(items) {
  if (!items.length) return 0;
  return Math.round(rawSeconds(items) * paceOf(sessionKindOf(items)) / 60);
}

/* A fine seduta confronta la durata reale con la stima grezza e aggiorna il
   ritmo del tipo di seduta (media mobile: pesa per un terzo l'ultima seduta,
   così due o tre sedute bastano ad allinearsi). Le sedute interrotte o con
   pause lunghe (fuori dall'intervallo 0,6-2) non vengono considerate. */
function calibratePace(sess, realMinutes) {
  if (!sess || !realMinutes || realMinutes < 5 || realMinutes > 150) return;
  if (!isProgramKind(sess.kind)) return;
  const raw = rawSeconds(sess.items) / 60;
  if (!raw) return;
  const observed = realMinutes / raw;
  if (observed < 0.6 || observed > 2) return;
  const kind = sessionKindOf(sess.items);
  S.pace = Object.assign({ strength: 1, stretch: 1, cardio: 1 }, S.pace || {});
  S.pace[kind] = Math.max(0.75, Math.min(1.6, S.pace[kind] * (2 / 3) + observed / 3));
  planCache = null;
}

/* Una volta sola (4.8): ricava il ritmo dalle sedute già registrate, così la
   prima stima è già realistica senza aspettare nuove sedute. */
function seedPaceFromHistory() {
  if (S.paceSeeded) return;
  S.paceSeeded = true;
  const acc = { strength: [], stretch: [], cardio: [] };
  S.sessionLog.slice(-12).forEach(x => {
    if (!isProgramKind(x.kind) || !x.minutes) return;
    const logs = x.sid ? S.logs.filter(l => l.sid === x.sid) : logsOfSession(x);
    if (logs.length < 3) return;
    const items = logs.map(l => {
      const g = PROG.goals[l.goal] || PROG.goals.hypertrophy;
      const ex = exById(l.exId);
      const timed = l.goal === 'stretch' || (ex && ex.load === 'time');
      return { exId: l.exId, sets: l.sets || 0, reps: l.repsDone || l.reps || g.repsLow,
               rest: g.rest, hold: timed ? (g.hold || (ex && ex.load === 'time' ? 20 + (l.reps || 10) : 30)) : 0, goal: l.goal };
    }).filter(it => it.sets > 0 && exById(it.exId));
    if (!items.length) return;
    const obs = x.minutes / (rawSeconds(items) / 60);
    if (obs >= 0.6 && obs <= 2) acc[sessionKindOf(items)].push(obs);
  });
  S.pace = { strength: 1, stretch: 1, cardio: 1 };
  Object.keys(acc).forEach(k => {
    const v = acc[k];
    if (v.length) S.pace[k] = Math.max(0.75, Math.min(1.6, v.reduce((a, b) => a + b, 0) / v.length));
  });
  save();
}

/* Riduce la seduta finché sta nel tempo scelto. Ordine dei tagli, dal meno
   al più importante per i tuoi obiettivi:
     1. la sospensione alla sbarra in chiusura;
     2. una serie del lavoro per le trazioni (non sotto 3);
     3. una serie agli esercizi complementari, dall'ultimo (non sotto 2);
     4. il lavoro per le trazioni fino a 2 serie;
     5. i due esercizi principali fino a 2 serie (mai meno: ACSM 2026 indica
        2-3 serie per esercizio per la forza);
     6. l'ultimo esercizio complementare, lasciandone almeno quattro. */
function fitToTime(items, maxMin, tail) {
  let trimmed = false, guard = 0;
  const minus = it => { it.sets -= it.perSide ? 2 : 1; trimmed = true; };
  const over = () => estimateMinutes(items) > maxMin;
  if (tail && tail.length && over()) { tail.length = 0; trimmed = true; }
  while (over() && guard++ < 60) {
    // dalla 6.4 trazioni e muscle-up sono un obiettivo del programma: prima si
    // accorciano i complementari, poi le serie in più del blocco trazioni
    // (8.3) fra i complementari si accorcia prima quello con più serie
    // (a parità, l'ultimo): così le superserie non restano a 2 serie mentre
    // un altro complementare ne tiene 4
    const acc = items.slice().reverse().filter(it => (it.role === 'main' || !it.role) && it.sets > 2)
      .reduce((a, it) => (!a || it.sets > a.sets) ? it : a, null);
    if (acc) { minus(acc); continue; }
    const pull = items.find(it => it.role === 'pull' && it.sets > 3);
    if (pull) { minus(pull); continue; }
    const pull2 = items.find(it => it.role === 'pull' && it.sets > 2);
    if (pull2) { minus(pull2); continue; }
    const key = items.slice().reverse().find(it => it.role === 'key' && it.sets > 2);
    if (key) { minus(key); continue; }
    const last = items.map((it, i) => [it, i]).reverse().find(([it]) => it.role === 'main' || !it.role);
    if (last && items.length > 4) { items.splice(last[1], 1); trimmed = true; continue; }
    break;
  }
  return trimmed;
}

/* Con tempo in più (40-50 minuti) la seduta si allunga nell'ordine:
     1. esercizi supplementari, solo per i gruppi che il programma lascia
        sotto le 10 serie settimanali (scelti in buildStrength);
     2. una serie in più agli esercizi di petto e gambe (fino a 4);
     3. il finale metabolico per il grasso addominale;
     4. per ultima, la sospensione alla sbarra. */
function fillToTime(items, maxMin, opt) {
  const reserve = opt.reserve || 0;
  const fitsIn = (extra, lim) => estimateMinutes(items.concat(extra)) <= lim;
  // 1. supplementari per i gruppi in ritardo
  (opt.extras || []).forEach(x => { if (fitsIn([x], maxMin - reserve)) items.push(x); });
  // 2. finale metabolico, adattato al tempo che resta (almeno 4 scatti o 6 minuti)
  const f = opt.finisher;
  if (f) {
    const room = maxMin * 60 / paceOf('strength') - rawSeconds(items) - CHANGE_SEC.finisher;
    if (f.sets > 1) {
      const n = Math.min(f.sets, Math.floor((room + f.rest) / (f.hold + f.rest)));
      if (n >= 4) { f.sets = n; items.push(f); }
    } else if (room >= 360) {
      f.hold = Math.min(f.hold, Math.floor(room / 60) * 60);
      items.push(f);
    }
  }
  // 3. la sospensione alla sbarra, in chiusura
  (opt.tail || []).forEach(x => { if (fitsIn([x], maxMin)) items.push(x); });
  // 3b. (8.3) prima di allungare petto e gambe, i complementari accorciati
  // tornano alle serie previste (le superserie con il lavoro diretto sui
  // muscoli piccoli)
  let back = true, g2 = 0;
  while (back && g2++ < 20) {
    back = false;
    for (const it of items) {
      if (it.role !== 'main' || !it.doseSets || it.sets >= it.doseSets) continue;
      it.sets += it.perSide ? 2 : 1;
      if (estimateMinutes(items) <= maxMin) back = true;
      else it.sets -= it.perSide ? 2 : 1;
    }
  }
  // 4. una serie in più a petto e gambe (fino a 4), senza toccare il finale
  const growable = items.filter(it => (it.role === 'key' || it.role === 'main' || it.role === 'extra') && it.goal !== 'core' && (() => {
    const g = muscleGroup(((exById(it.exId) || {}).primary || [])[0] || '');
    return g === 'Petto';     // (8.7) le gambe non si allungano per volume: obiettivo tono e forza
  })());
  let again = true, guard = 0;
  while (again && guard++ < 20) {
    again = false;
    for (const it of growable) {
      if (it.sets >= 4) continue;
      it.sets += it.perSide ? 2 : 1;
      if (estimateMinutes(items) <= maxMin) again = true;
      else it.sets -= it.perSide ? 2 : 1;
    }
  }
  // gli esercizi di coda restano in fondo: finale e poi sospensione
  const tail = items.filter(it => it.role === 'finisher' || it.role === 'activation');
  const rest = items.filter(it => it.role !== 'finisher' && it.role !== 'activation');
  tail.sort((a, b) => (a.role === 'finisher' ? 0 : 1) - (b.role === 'finisher' ? 0 : 1));
  items.length = 0; rest.concat(tail).forEach(it => items.push(it));
}
const FINISHER_RESERVE = 10;     // minuti riservati al finale con 50 minuti a disposizione

/* ---------------------------------------------------------------------------
   SEDUTE AEROBICHE (dalla 5.0)
   Due a settimana, fra le sedute di forza:
     · INTERVALLI: scatti brevi e recuperi attivi. È la modalità più efficace
       sul grasso viscerale (Chang et al. 2026, 61 studi randomizzati; Xu et
       al. 2026, 60 studi, stessa graduatoria). Attenzione alla dose: 400
       MET-min a settimana sono il MINIMO efficace per l'HIIT, non l'obiettivo;
       l'effetto massimo si colloca verso 1000-1100 MET-min a settimana, pari
       a circa 230 minuti di camminata veloce. Le due sedute aerobiche e il
       finale metabolico servono proprio ad avvicinarsi a quella dose.
     · RITMO COSTANTE: lavoro moderato continuo, "riesci a parlare a frasi
       brevi". Accumula i minuti raccomandati dall'OMS (150-300 a settimana di
       attività moderata, o metà se vigorosa) senza aggiungere fatica.
   Struttura: riscaldamento 5 min → parte centrale (adattata al tempo scelto)
   → defaticamento 3 min → due allungamenti per anche e polpacci.
   Attrezzi della palestra: bici da spinning, cyclette orizzontale, sacco da
   pugilato, vogatore, macchina a scalini. Con la priorità al ginocchio attiva
   vogatore e scalini non vengono proposti in automatico (flessione profonda
   sotto carico), ma restano selezionabili con «Cambia esercizio».
--------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
   CAMBIARE LA SEDUTA AEROBICA O DI MOBILITÀ (dalla 5.12)
   Le sedute di forza hanno un ordine che serve a qualcosa: A, B e C si
   alternano per non caricare due volte gli stessi distretti. L'aerobico e la
   mobilità no: che i minuti arrivino dalla cyclette, dal sacco o dalla bici da
   spinning cambia poco per il risultato, e molto per la voglia di farli (e per
   l'attrezzo libero in sala). Da qui la scelta libera dell'attrezzo e dello
   schema di mobilità.
   La scelta è legata alla POSIZIONE nel programma, non all'esercizio: così
   sopravvive al ricalcolo della seduta, alla durata cambiata e alla chiusura
   dell'app, e sparisce da sola quando quella seduta è passata. Resta invece
   intatta la regola della mobilità in chiusura di settimana: qui si cambia il
   contenuto della seduta, mai il suo posto nella settimana.
--------------------------------------------------------------------------- */
const pickOf = idx => (S.sessPick || {})[String(idx)] || null;

function setPick(idx, p) {
  S.sessPick = S.sessPick || {};
  if (p) S.sessPick[String(idx)] = p; else delete S.sessPick[String(idx)];
  // le scelte delle sedute ormai passate non servono più
  Object.keys(S.sessPick).forEach(k => { if (+k < S.sessionIndex) delete S.sessPick[k]; });
  planCache = null;
  save();
}
/* Firma della scelta: entra nella chiave della seduta tenuta in memoria, così
   cambiare attrezzo ricostruisce davvero la seduta. */
function pickKey(idx) {
  const p = pickOf(idx);
  return p ? `${p.exId || ''}/${p.mode || ''}/${p.stretch == null ? '' : p.stretch}` : '';
}

function cardioPool(mode) {
  let pool = DB.exercises.filter(e => (e.pattern === 'cardio' || e.pattern === 'finisher') &&
    e.setup.includes(S.setup) && (e.cardioModes || []).includes(mode));
  return applyCare(pool).sort((a, b) => a.id.localeCompare(b.id));
}

/* Progressione degli intervalli con le settimane di allenamento: si parte con
   recuperi lunghi e si accorciano, poi si allunga lo scatto. */
function hiitScheme(meta) {
  const tw = meta.trainingWeek;
  if (tw <= 4) return { work: 30, rest: 90 };
  if (tw <= 12) return { work: 30, rest: 60 };
  if (tw <= 24) return { work: 45, rest: 60 };
  return { work: 60, rest: 60 };
}

/* Due allungamenti dopo l'aerobico, per anche, polpacci e cosce: i distretti
   più sollecitati da bici e corsa. */
function cardioStretches(meta, used) {
  const stretchPool = DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'static' &&
    e.setup.includes(S.setup) && ['Anca', 'Polpacci', 'Catena posteriore', 'Quadricipiti'].includes(e.group))
    .sort((a, b) => a.id.localeCompare(b.id));
  const out = [];
  for (let i = 0; i < 2; i++) {
    const se = pickFrom(stretchPool, meta.weekAbs + i * 3, used);
    if (!se) continue;
    const d = dose('stretch', meta.profile, se);
    d.sets = 2;
    out.push({ exId: se.id, note: 'Dopo l\'aerobico', goalKey: 'stretch',
               alt: { patterns: ['static'], types: ['stretch'] }, ...d });
  }
  return out;
}

function buildCardio(meta, budget) {
  const chosen = pickOf(meta.idx) || {};
  // (7S 0) da dicembre la seduta a ritmo costante diventa corsa-camminata,
  // salvo che per quella seduta tu abbia scelto un altro attrezzo
  if (runDay(meta)) return buildRun(meta, budget);
  const days = PROG.cardioDays || [];
  let tmpl = days[meta.tmplIdx] || { label: 'Aerobico', mode: 'steady' };
  // modalità scelta a mano (intervalli o ritmo costante) al posto di quella del giorno
  if (chosen.mode && chosen.mode !== tmpl.mode) tmpl = days.find(t => t.mode === chosen.mode) || tmpl;
  const mode = tmpl.mode;
  const used = new Set();
  let pool = cardioPool(mode);
  if (!pool.length) pool = cardioPool(mode === 'hiit' ? 'steady' : 'hiit');
  // attrezzo scelto a mano: vale solo se è davvero disponibile e adatto alla modalità
  let ex = chosen.exId ? exById(chosen.exId) : null;
  if (ex && (ex.retired || !ex.setup.includes(S.setup) || !(ex.cardioModes || []).includes(mode))) ex = null;
  if (ex) used.add(ex.id);
  else ex = pickFrom(pool, (meta.weekAbs - 1) + meta.tmplIdx, used);
  const items = [];
  if (!ex) return { label: tmpl.label, type: 'cardio', items, mode };
  const deload = meta.profile.label === 'Scarico';
  const alt = { patterns: ['cardio', 'finisher'], types: ['strength'], modes: [mode] };
  const timed = (role, goalKey, label, sets, hold, rest, note, extra) => Object.assign({
    exId: ex.id, role, goal: goalKey, goalKey, goalLabel: label, sets, reps: 1, perSide: false,
    hold, rest, rpe: '', source: ex.source, note, workLabel: label, restLabel: 'Ritmo tranquillo', alt
  }, extra || {});

  items.push(timed('warmup', 'cardioWarm', 'Riscaldamento', 1, 300, 0, 'Ritmo facile, 3-4 su 10'));
  const cool = timed('cooldown', 'cardioCool', 'Defaticamento', 1, 180, 0, 'Ritmo facile, respiro che rallenta');
  const stretches = cardioStretches(meta, used);
  // (7S 0) nella seduta a intervalli, dopo il riscaldamento e a fresco:
  // burpees, sospensione alla sbarra e (da dicembre) trasporti per la Spartan
  const spItems = meta.tmplIdx === 0 ? spartanBlock(meta, used) : [];

  // parte centrale: tutto il tempo che resta
  const main = mode === 'hiit'
    ? (() => {
        const sch = hiitScheme(meta);
        const g = PROG.goals.cardioHiit;
        return timed('cardio', 'cardioHiit', 'Scatto', 4, sch.work, sch.rest,
          tmpl.note || '', { rpe: g.rpe, source: g.source, goalLabel: g.label });
      })()
    : (() => {
        const g = PROG.goals.cardioSteady;
        return timed('cardio', 'cardioSteady', 'Ritmo costante', 1, 900, 0,
          tmpl.note || '', { rpe: g.rpe, source: g.source, goalLabel: g.label });
      })();
  const hiitOk = mode === 'hiit' && (ex.interval || {}).sets !== 1;
  const roomOf = () => budget * 60 / paceOf('cardio') -
    rawSeconds(items.concat(spItems, [cool], stretches, [Object.assign({}, main, { sets: 0 })]));
  // il blocco Spartan si accorcia se toglierebbe all'aerobico più della parte
  // minima (4 scatti o 10 minuti): prima i trasporti, poi la sospensione, poi
  // i burpees, mai sotto 2 serie; i check non si toccano
  const minMain = hiitOk ? 4 * main.hold + 3 * main.rest : 600;
  let guard = 0;
  while (spItems.length && roomOf() < minMain && guard++ < 20) {
    const cut = ['carry', 'hang', 'burpee'].map(k => spItems.find(it => it.spKind === k && !it.spCheck && it.sets > 2)).find(Boolean);
    if (cut) { cut.sets--; continue; }
    const drop = spItems.findIndex(it => it.spKind === 'carry');
    if (drop >= 0) { spItems.splice(drop, 1); continue; }
    break;
  }
  let tail = null;
  const roomSec = roomOf();
  if (hiitOk) {
    let n = Math.floor((roomSec + main.rest) / (main.hold + main.rest));
    n = Math.max(4, Math.min(12, n));
    if (deload) n = Math.max(4, Math.round(n * 0.6));
    main.sets = n;
    // il tetto di 12 scatti protegge articolazioni e recupero: il tempo che
    // avanza diventa ritmo costante, che aggiunge minuti senza aggiungere fatica
    const left = roomSec - (n * main.hold + (n - 1) * main.rest) - CHANGE_SEC.cardio;
    if (left >= 300) {
      const g = PROG.goals.cardioSteady;
      tail = timed('cardio', 'cardioSteady', 'Ritmo costante', 1, Math.min(1200, Math.floor(left / 60) * 60), 0,
        'Dopo gli scatti, ritmo moderato', { rpe: g.rpe, source: g.source, goalLabel: g.label });
    }
  } else {
    // attrezzo senza intervalli (camminata, scalini) o giorno a ritmo costante
    let sec = Math.floor(Math.max(600, roomSec) / 60) * 60;
    sec = Math.min(2700, sec);
    if (deload) sec = Math.max(600, Math.round(sec * 0.8 / 60) * 60);
    main.goal = main.goalKey = 'cardioSteady'; main.workLabel = 'Ritmo costante';
    main.goalLabel = PROG.goals.cardioSteady.label; main.rpe = PROG.goals.cardioSteady.rpe;
    main.sets = 1; main.hold = sec; main.rest = 0;
  }
  spItems.forEach(it => items.push(it));
  items.push(main);
  if (tail) items.push(tail);
  items.push(cool);
  stretches.forEach(it => items.push(it));
  const spTag = spItems.length ? (spItems.some(it => it.spCheck) ? ' · Spartan Race check' : ' · burpees') : '';
  return { label: `${tmpl.label} · ${ex.name}${spTag}`, type: 'cardio', items, mode };
}

/* ===========================================================================
   SPARTAN RACE SPRINT · ORTE (dalla 7S 0)
   Obiettivo dell'utente: arrivare alla Sprint del 24-25 aprile 2027 (5 km, 20
   ostacoli) per divertirsi e superare gli ostacoli in sicurezza, con forma
   corretta e disinvoltura; tempo e velocità non contano. Il giavellotto non
   si tenta: si fanno i 30 burpees di penalità.
   Che cosa cambia, e dove (le sedute di forza A, B e C restano com'erano):
     · seduta a INTERVALLI: dopo il riscaldamento, burpees (per livelli),
       sospensione alla sbarra e, da dicembre, trasporti; poi gli scatti;
     · seduta a RITMO COSTANTE: dal 7 dicembre 2026 diventa corsa-camminata
       all'aperto, una volta a settimana, con livelli che avanzano solo se il
       ginocchio risponde bene il giorno dopo (criteri di Esculier et al.
       2018: dolore entro 2/10 durante, passato entro un'ora, mattina dopo
       come prima). Si può sempre tornare alla bici con «Cambia attrezzo»;
     · SPARTAN RACE CHECK nella prima settimana di ogni blocco, dopo lo
       scarico: trazioni (Forza A, è il test che c'era già), burpees e
       sospensione (intervalli), corsa-camminata (dal blocco successivo al
       7 dicembre). Ogni check ha un obiettivo intermedio sulla strada del
       traguardo per la gara;
     · settimana della gara: tutto più leggero, nessun check; dopo la gara il
       piano torna com'era.
   Le registrazioni del blocco Spartan non entrano nel volume dei gruppi
   muscolari: sono condizionamento, non serie per l'ipertrofia.
=========================================================================== */
const SP = () => (PROG && PROG.spartan) || null;
const spOn = () => !!SP() && S.spartan !== false;
const DAY_MS = DAY_MS_8;
const noonOf = d => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };
const isoNoon = iso => new Date(iso + 'T12:00:00');

/* Data prevista di una seduta: quella reale se è già stata registrata,
   altrimenti contata da oggi (una seduta al giorno, sette giorni per settimana
   di calendario). */
function sessDate(idx) {
  const cur = S.sessionIndex || 0;
  idx = Math.max(0, Math.round(idx) || 0);
  const logged = (S.sessionLog || []).filter(y => y && y.idx === idx && isProgramKind(y.kind) && y.ts).pop();
  if (idx < cur && logged) return noonOf(logged.ts);
  const doneToday = (S.sessionLog || []).some(y => y && isProgramKind(y.kind) && sameDay(y.ts, Date.now()));
  const base = noonOf(Date.now() + (doneToday && idx >= cur ? DAY_MS : 0));
  const days = (weekOfIdx(idx) - weekOfIdx(cur)) * 7 + (posOfIdx(idx) - posOfIdx(cur));
  return new Date(base.getTime() + days * DAY_MS);
}
const metaDate = meta => meta._date || (meta._date = sessDate(meta.idx));

/* Fase della preparazione in una data: 'base' (burpees e sospensione),
   'run' (anche corsa-camminata e trasporti), 'race' (settimana della gara,
   tutto leggero), 'off' (preparazione spenta o gara passata). */
function spPhase(date) {
  const sp = SP();
  if (!spOn()) return 'off';
  const d = noonOf(date);
  const race = isoNoon(sp.date), end = isoNoon(sp.dateTo || sp.date);
  if (!(d <= end)) return 'off';
  if (d >= new Date(race.getTime() - 6 * DAY_MS)) return 'race';
  if (d >= isoNoon(sp.runFrom)) return 'run';
  return 'base';
}
const spDateText = () => { const sp = SP(); return sp ? `${isoNoon(sp.date).getDate()}-${dateIt(isoNoon(sp.dateTo || sp.date))}` : ''; };
const weeksToRace = () => { const sp = SP(); return sp ? Math.max(0, Math.ceil((isoNoon(sp.date) - noonOf(Date.now())) / (7 * DAY_MS))) : 0; };

/* Il migliore recente (ultime sei settimane) o, se non c'è nulla di recente,
   l'ultimo dato: stessa regola del massimo di trazioni. */
function bestRecent(cand) {
  if (!cand.length) return { n: 0, ts: 0, src: 'nessuno' };
  const now = Date.now();
  const recent = cand.filter(c => now - c.ts <= PULL_RECENT_MS);
  if (recent.length) return recent.reduce((a, b) => (b.n > a.n || (b.n === a.n && b.ts > a.ts)) ? b : a);
  return cand.reduce((a, b) => b.ts > a.ts ? b : a);
}

/* Sospensione: secondi migliori tenuti alla sbarra (test, serie del blocco
   Spartan o della chiusura delle sedute di forza, valore dichiarato). */
function hangBest() {
  const cand = [], deload = [];
  (S.logs || []).forEach(l => {
    if (!l || l.exId !== 'g_deadhang' || l.planned) return;
    const rows = setRows(l);
    const v = rows ? Math.max(0, ...rows.map(r => +r.hold || 0).filter(isFinite)) : (+l.hold || 0);
    if (!(v > 0)) return;
    const c = { n: Math.round(v), ts: l.ts || 0, src: l.goal === 'hangTest' ? 'test' : 'serie' };
    (isDeloadLog(l) ? deload : cand).push(c);
  });
  const me = S.spSelf || {};
  if (isFinite(me.hang) && me.hang > 0) cand.push({ n: Math.round(me.hang), ts: me.ts || 0, src: 'dichiarato' });
  return withDeload(bestRecent(cand), deload);
}
/* (7S 5) Nei traguardi Spartan si vede anche ciò che hai fatto in settimana
   di scarico, segnalato come tale: è una capacità dimostrata. Le dosi, i
   livelli e gli obiettivi dei check restano calcolati senza lo scarico, che
   per regola non entra nei dati della progressione. */
function withDeload(best, deload) {
  const d = bestRecent(deload);
  const show = d.n > best.n ? d : best;
  return Object.assign({}, best, { nShow: show.n, tsShow: show.ts, srcShow: show.src, fromDeload: d.n > best.n });
}

/* Burpees: livello e massimo di fila.
   · Una serie a un livello più difficile vale anche per quelli più facili:
     10 burpees regolamentari dimostrano almeno 10 burpees a passi (7S 5;
     prima contavano solo le serie al livello esatto, e 10 regolamentari
     risultavano 0).
   · Livello: si sale con 15 di fila al primo e 20 al secondo; con la
     priorità al ginocchio l'app da sola non propone il salto. Se però nelle
     ultime sei settimane hai scelto tu un livello più alto, si resta su quello:
     è una tua scelta, e la preferenza ginocchio non è un divieto. */
function burpeeState() {
  const sp = SP(), ex = exById((sp && sp.burpee && sp.burpee.exId) || 'g_burpee');
  const lv = (ex && ex.levels) || ['Burpee'];
  const adv = (sp && sp.burpee && sp.burpee.advance) || [15, 20];
  const jump = (sp && sp.burpee && sp.burpee.jumpLevel) || lv.length - 1;
  const maxL = S.kneeCare ? Math.min(lv.length - 1, jump - 1) : lv.length - 1;
  const lvIdx = v => Math.max(0, lv.indexOf(v));
  // per ogni registrazione: ripetizioni migliori di fila per livello
  const recs = [];
  (S.logs || []).forEach(l => {
    if (!l || !ex || l.exId !== ex.id || l.planned) return;
    const rows = setRows(l) || [{ load: l.load, reps: isFinite(l.repsDone) ? l.repsDone : l.reps }];
    rows.forEach(r => {
      const n = +r.reps;
      if (!isFinite(n) || n <= 0) return;
      recs.push({ i: lvIdx(r.load || l.load), n, ts: l.ts || 0, dl: isDeloadLog(l), src: l.goal === 'burpeeTest' ? 'test' : 'serie' });
    });
  });
  const me = S.spSelf || {};
  if (isFinite(me.burpee) && me.burpee > 0)
    recs.push({ i: clampN(Math.round(me.burpeeLevel || 0), 0, lv.length - 1), n: Math.round(me.burpee), ts: me.ts || 0, dl: false, src: 'dichiarato' });
  const at = (i, dl) => recs.filter(r => r.i >= i && r.dl === dl).map(r => ({ n: r.n, ts: r.ts, src: r.src }));
  let L = 0;
  for (let i = 0; i < maxL; i++) {
    const all = at(i, false);
    if (all.length && Math.max(...all.map(c => c.n)) >= (adv[i] || 99)) L = i + 1; else break;
  }
  const now = Date.now();
  const chosen = recs.filter(r => now - r.ts <= PULL_RECENT_MS).reduce((m, r) => Math.max(m, r.i), 0);
  const byChoice = chosen > L;
  if (byChoice) L = chosen;
  const cur = withDeload(bestRecent(at(L, false)), at(L, true));
  return { L, maxL, level: lv[L], levels: lv, n: cur.n, ts: cur.ts, src: cur.src,
           nShow: cur.nShow, tsShow: cur.tsShow, srcShow: cur.srcShow, fromDeload: cur.fromDeload,
           top: L === lv.length - 1, capped: maxL < lv.length - 1 && L < lv.length - 1, byChoice,
           next: L < lv.length - 1 ? (adv[L] || null) : null };
}

/* Corsa-camminata: livello attuale ricavato dal registro delle corse. Si sale
   di un livello solo dopo una corsa completa al livello attuale, fuori da
   scarico e settimana della gara, con il ginocchio tranquillo il giorno dopo;
   si scende di uno se la mattina dopo il ginocchio andava peggio; senza
   risposta il livello resta fermo. */
function runState() {
  const sp = SP();
  const lv = (sp && sp.run && sp.run.levels) || [{ run: 60, walk: 120, reps: 6 }];
  const max = lv.length - 1;
  const runs = (Array.isArray(S.spartanRuns) ? S.spartanRuns : []).filter(r => r && isFinite(r.ts)).slice().sort((a, b) => a.ts - b.ts);
  let L = 0, worse = 0;
  runs.forEach(r => {
    if (r.knee === 2) { L = Math.max(0, L - 1); worse++; }
    else {
      if (r.knee === 0) worse = 0;
      if (r.knee === 0 && r.full && !r.light && (r.level == null || r.level === L)) L = Math.min(max, L + 1);
    }
  });
  const kms = runs.filter(r => r.knee !== 2 && isFinite(r.km) && r.km > 0).map(r => +r.km);
  const now = Date.now();
  const pending = runs.filter(r => r.knee == null && !sameDay(r.ts, now) && now - r.ts < 4 * DAY_MS).pop() || null;
  return { L, max, spec: lv[L], levels: lv, runs, km: kms.length ? Math.max(...kms) : 0, pending, worse };
}
const runSpecText = sp => {
  const m = v => v % 60 ? `${Math.floor(v / 60) ? Math.floor(v / 60) + '′' : ''}${v % 60}″` : `${v / 60}′`;
  return `${sp.reps} × ${m(sp.run)} di corsa e ${m(sp.walk)} di camminata`;
};

/* La seduta idx è quella di corsa-camminata? Seduta a ritmo costante (la
   seconda aerobica), da dicembre fino alla gara, salvo un attrezzo scelto a
   mano per quella seduta. */
function runDay(meta) {
  if (!meta || !meta.isCardio || meta.tmplIdx !== 1 || meta.mobilityWeek) return false;
  const ph = spPhase(metaDate(meta));
  if (ph !== 'run' && ph !== 'race') return false;
  const p = pickOf(meta.idx);
  if (p && ((p.exId && p.exId !== (SP().run || {}).exId) || (p.mode && p.mode !== 'run'))) return false;
  if (isAvoided((SP().run || {}).exId)) return false;           // (8) segnata come fastidiosa
  return true;
}

/* Settimana dei check: la prima del blocco, dopo lo scarico. */
const spCheckWeek = meta => meta.weekInCycle === 1 && meta.profile && meta.profile.label !== 'Scarico' && !meta.mobilityWeek;

/* Quali Spartan Race check cadono nella seduta. */
function spCheckKinds(meta, date) {
  if (!spOn() || !meta) return [];
  const ph = spPhase(date || metaDate(meta));
  if ((ph !== 'base' && ph !== 'run') || !spCheckWeek(meta)) return [];
  const out = [];
  // il check delle trazioni è il test di Forza A: c'è quando la tappa prevede
  // già le trazioni pulite (dalla prima trazione in poi)
  if (meta.isStrength && meta.tmplIdx === 0 && S.pullupGoal && S.setup === 'gym') {
    const ps = pullStage();
    if (ps && ((ps.stage.days || [])[0] || []).includes('strict')) out.push('pull');
  }
  if (meta.isCardio && meta.tmplIdx === 0) { out.push('burpee'); if (S.setup === 'gym') out.push('hang'); }
  if (meta.isCardio && meta.tmplIdx === 1 && ph === 'run' && runDay(meta)) out.push('run');
  return out;
}

/* Valore attuale e traguardo per la gara di ciascuna qualità. */
function spMetric(kind) {
  const sp = SP(), t = (sp && sp.targets) || {};
  if (kind === 'pull') { const r = pullMax(); return { n: r.n, T: t.pullups || 8, unit: 'trazioni pulite di fila', src: r.src, ts: r.ts }; }
  if (kind === 'hang') { const r = hangBest(); return { n: r.n, T: t.hang || 60, unit: 'secondi', src: r.src, ts: r.ts, show: r.nShow, srcShow: r.srcShow, tsShow: r.tsShow, fromDeload: r.fromDeload }; }
  if (kind === 'burpee') { const b = burpeeState(); return { n: b.n, T: t.burpees || 30, unit: 'di fila in forma corretta', src: b.src, ts: b.ts, b, show: b.nShow, srcShow: b.srcShow, tsShow: b.tsShow, fromDeload: b.fromDeload }; }
  const rs = runState();
  return { n: rs.L, T: rs.max, unit: 'livello', km: rs.km, rs };
}

/* Calendario dei check da oggi alla gara, con l'obiettivo intermedio di
   ciascuno: il traguardo si divide in parti uguali fra i check rimasti
   (almeno una ripetizione, o 5 secondi, in più del valore attuale). */
let spPlanMemo = null;
function spCheckPlan() {
  const key = planSignature() + '|' + spSig();
  if (spPlanMemo && spPlanMemo.key === key) return spPlanMemo.list;
  const list = [];
  const sp = SP();
  if (spOn()) {
    const end = isoNoon(sp.dateTo || sp.date);
    for (let idx = S.sessionIndex || 0, g = 0; g < 400; idx++, g++) {
      const d = sessDate(idx);
      if (d > end) break;
      const meta = sessionMeta(idx);
      spCheckKinds(meta, d).forEach(kind => list.push({ idx, date: d, kind }));
    }
    ['pull', 'hang', 'burpee', 'run'].forEach(kind => {
      const mine = list.filter(c => c.kind === kind);
      const m = spMetric(kind), k = mine.length;
      mine.forEach((c, i) => {
        if (kind === 'run') { c.goal = Math.min(m.T, m.n + i); return; }
        c.first = !(m.show || m.n) && i === 0;          // nessun dato ancora: il primo check misura il punto di partenza
        const step = kind === 'hang' ? 5 : 1;
        let g = m.n >= m.T ? m.T : m.n + (m.T - m.n) * (i + 1) / k;
        g = Math.ceil(g / step) * step;
        if (m.n < m.T) g = Math.max(g, m.n + step);
        c.goal = Math.min(Math.max(g, step), Math.max(m.T, m.n + step));
      });
    });
  }
  spPlanMemo = { key, list };
  return list;
}
function spCheckFor(idx, kind) {
  const c = spCheckPlan().find(x => x.idx === idx && x.kind === kind);
  if (c) return c;
  const m = spMetric(kind);
  return { idx, kind, goal: kind === 'run' ? m.n : Math.max(m.n + (kind === 'hang' ? 5 : 1), 1), first: kind !== 'run' && !(m.show || m.n) };
}
/* «Spartan Race check», seguito dal dettaglio dell'obiettivo. */
function spCheckLabel(kind, goal, first) {
  const sp = SP(), t = (sp && sp.targets) || {};
  if (kind === 'pull') return first ? `Spartan Race check · trazioni: primo check, quante pulite di fila (per la gara ${t.pullups || 8})`
    : `Spartan Race check · trazioni: obiettivo ${goal} pulite di fila (per la gara ${t.pullups || 8})`;
  if (kind === 'hang') return first ? `Spartan Race check · sospensione alla sbarra: primo check, quanti secondi tieni (per la gara ${t.hang || 60})`
    : `Spartan Race check · sospensione alla sbarra: obiettivo ${goal} secondi (per la gara ${t.hang || 60})`;
  if (kind === 'burpee') {
    const b = burpeeState();
    return first ? `Spartan Race check · burpees: primo check, quanti di fila in forma corretta, livello «${b.level}» (per la gara ${t.burpees || 30})`
      : `Spartan Race check · burpees: obiettivo ${goal} di fila in forma corretta, livello «${b.level}» (per la gara ${t.burpees || 30})`;
  }
  const rs = runState(), lv = rs.levels[Math.min(rs.max, goal)] || rs.spec;
  return `Spartan Race check · corsa-camminata: obiettivo ${runSpecText(lv)}, ginocchio tranquillo il giorno dopo (per la gara circa ${(SP().targets || {}).runKm || 5} km)`;
}
const spSig = () => [S.spartan !== false, new Date().toDateString(),
  (Array.isArray(S.spartanRuns) ? S.spartanRuns : []).map(r => `${r && r.knee}${r && r.full ? 1 : 0}${r && r.level}`).join(','),
  JSON.stringify(S.spSelf || null)].join('|');

/* Blocco Spartan della seduta a intervalli. */
function spItem(ex, goalKey, d, extra) {
  const g = PROG.goals[goalKey];
  return Object.assign({ exId: ex.id, goalKey, goal: goalKey, goalLabel: g.label, perSide: false,
    rpe: g.rpe, source: g.source, role: 'spartan', block: 'spartan',
    alt: { patterns: [ex.pattern], types: ['strength'] } }, d, extra || {});
}
function spartanBlock(meta, used) {
  const sp = SP();
  if (!sp || meta.mobilityWeek) return [];
  const date = metaDate(meta), ph = spPhase(date);
  if (ph === 'off') return [];
  const deload = meta.profile && meta.profile.label === 'Scarico';
  const light = deload || ph === 'race';
  const checks = spCheckKinds(meta, date);
  const out = [];
  // burpees
  const bx = exById(sp.burpee.exId);
  if (bx && !isAvoided(bx.id)) {
    used.add(bx.id);
    const b = burpeeState();
    if (checks.includes('burpee')) {
      const c = spCheckFor(meta.idx, 'burpee');
      out.push(spItem(bx, 'burpeeTest', { sets: 1, reps: c.goal, rest: 0, hold: 0 },
        { level: b.level, spKind: 'burpee', spCheck: true, note: spCheckLabel('burpee', c.goal, c.first) }));
    } else {
      let reps = b.n ? clampN(Math.round(b.n * (b.n >= 20 ? 0.7 : 0.6)), 5, 20) : 6;
      let sets = b.n && b.n >= 10 ? 3 : 4;
      sets = Math.max(2, Math.min(sets, Math.floor(45 / reps)));
      if (light) { sets = 2; reps = Math.max(4, Math.min(8, Math.round(reps * 0.7))); }
      const why = ph === 'race' ? 'settimana della gara: pochi e facili'
        : deload ? 'settimana di scarico: meno serie'
        : b.n ? `${Math.round(reps / b.n * 100)}% del tuo massimo di ${b.n}, livello «${b.level}»`
        : `livello «${b.level}»: ancora nessun massimo, si parte prudenti`;
      out.push(spItem(bx, 'burpee', { sets, reps, rest: PROG.goals.burpee.rest, hold: 0 },
        { level: b.level, spKind: 'burpee', note: `Spartan · ${why}` }));
    }
  }
  // sospensione alla sbarra (solo in palestra)
  const hx = exById('g_deadhang');
  if (S.setup === 'gym' && hx && !hx.retired && !isAvoided(hx.id)) {
    used.add(hx.id);
    const h = hangBest();
    if (checks.includes('hang')) {
      const c = spCheckFor(meta.idx, 'hang');
      out.push(spItem(hx, 'hangTest', { sets: 1, reps: 1, rest: 0, hold: c.goal, holdBonus: 0 },
        { spKind: 'hang', spCheck: true, workLabel: 'Sospensione',
          note: spCheckLabel('hang', c.goal, c.first) + ' · usa «Cronometro: tieni finché riesci»' }));
    } else {
      const hold = h.n ? clampN(Math.round(h.n * 0.6 / 5) * 5, 15, 45) : 20;
      out.push(spItem(hx, 'spHang', { sets: light ? 2 : 3, reps: 1, rest: PROG.goals.spHang.rest, hold, holdBonus: 0 },
        { spKind: 'hang', workLabel: 'Sospensione',
          alt: { patterns: ['pullup'], types: ['strength'], roles: ['activation'] },
          note: `Spartan · presa per monkey bars, multi-rig e fune${h.n ? ` · 60% del tuo massimo di ${h.n} s` : ''}` }));
    }
  }
  // trasporti: da dicembre, in palestra, fuori da scarico e settimana della gara
  if (S.setup === 'gym' && ph === 'run' && !deload) {
    const pool = (sp.carries || []).map(exById).filter(e => e && !e.retired && e.setup.includes(S.setup) && !isAvoided(e.id));
    const cx = pool.length ? pool[(meta.weekAbs || 0) % pool.length] : null;
    if (cx) {
      used.add(cx.id);
      const d = dose('carry', meta.profile, cx);
      out.push(spItem(cx, 'carry', { sets: 3, reps: d.reps, rest: d.rest, hold: 0 },
        { spKind: 'carry', note: `Spartan · le ripetizioni sono i passi${cx.id === 'g_farmercarry' ? ' (un manubrio per mano: simula taniche e secchi)' : ' (simula il sacco e la pietra)'}` }));
    }
  }
  return out;
}

/* Seduta di corsa-camminata (al posto del ritmo costante, da dicembre). */
function buildRun(meta, budget) {
  const sp = SP(), ex = exById(sp.run.exId);
  if (!ex) return { label: 'Corsa-camminata', type: 'cardio', items: [], mode: 'run' };
  const date = metaDate(meta), ph = spPhase(date);
  const rs = runState(), spec = rs.spec;
  const deload = meta.profile.label === 'Scarico';
  const light = deload || ph === 'race';
  const check = spCheckKinds(meta, date).includes('run');
  const used = new Set([ex.id]);
  const alt = { patterns: ['cardio', 'finisher'], types: ['strength'], modes: ['run'] };
  const timed = (role, goalKey, label, sets, hold, rest, note, extra) => Object.assign({
    exId: ex.id, role, goal: goalKey, goalKey, goalLabel: label, sets, reps: 1, perSide: false,
    hold, rest, rpe: '', source: ex.source, note, workLabel: label, restLabel: 'Camminata', alt
  }, extra || {});
  const g = PROG.goals.cardioRun;
  const warm = timed('warmup', 'cardioWarm', 'Camminata svelta', 1, 300, 0, 'Passo svelto, braccia che accompagnano');
  const cool = timed('cooldown', 'cardioCool', 'Camminata lenta', 1, 180, 0, 'Respiro che rallenta');
  let reps = light ? Math.max(2, Math.round(spec.reps * 0.6)) : spec.reps;
  const main = timed('cardio', 'cardioRun', 'Corsa', reps, spec.run, spec.walk,
    check ? spCheckLabel('run', rs.L)
      : `Livello ${rs.L + 1} di ${rs.max + 1}: ${runSpecText(spec)}${light ? (ph === 'race' ? ' · settimana della gara: accorciata' : ' · scarico: accorciata') : ''}`,
    { rpe: g.rpe, source: g.source, goalLabel: g.label, spKind: 'run', spCheck: check });
  const stretches = cardioStretches(meta, used);
  // (8) da marzo, nella seconda settimana di ogni blocco: simulazione Spartan
  // dopo la corsa (burpees della penalità, sospensione, trasporto in fila)
  const sim = S.setup === 'gym' && ph === 'run' && !light && !check && meta.weekInCycle === 2 &&
    sp.simFrom && date >= isoNoon(sp.simFrom) ? spartanSim(meta, used) : [];
  const items = [warm, main].concat(sim, [cool], stretches);
  // nel tempo scelto: si tolgono ripetute, mai sotto 2 (e allora il livello
  // non avanza, perché la corsa non è completa)
  let guard = 0;
  while (estimateMinutes(items) > budget && main.sets > 2 && guard++ < 20) main.sets--;
  // con i primi livelli la corsa dura poco: il tempo che avanza diventa
  // camminata svelta (minuti aerobici moderati, carico basso sul ginocchio)
  const leftSec = budget * 60 / paceOf('cardio') - rawSeconds(items) - CHANGE_SEC.cardio;
  if (leftSec >= 300 && !light) {
    const gs = PROG.goals.cardioSteady;
    items.splice(2, 0, timed('cardio', 'cardioSteady', 'Camminata svelta', 1, Math.min(1200, Math.floor(leftSec / 60) * 60), 0,
      'Dopo la corsa, passo svelto in piano', { rpe: gs.rpe, source: gs.source, goalLabel: 'Camminata svelta', restLabel: 'Camminata' }));
  }
  // la simulazione non fa salire il livello della corsa: lì conta la sequenza
  const full = !light && !sim.length && main.sets >= spec.reps;
  return { label: sim.length ? 'Simulazione Spartan · corsa e ostacoli' : `Corsa-camminata · Spartan${check ? ' · Spartan Race check' : ''}`, type: 'cardio', items, mode: 'run',
           run: { level: rs.L, planned: main.sets, full, light, check, sim: !!sim.length } };
}
/* (8) Mini-percorso a ostacoli: dopo la corsa-camminata, senza pause lunghe,
   30 burpees al tuo livello (la penalità del giavellotto), una sospensione
   lunga e un trasporto. Serve a sentire la gara in sequenza, non a fare
   record: conta la forma. Regola operativa dell'app. */
function spartanSim(meta, used) {
  const sp = SP(), out = [];
  const bx = exById(sp.burpee.exId);
  if (bx && !isAvoided(bx.id)) {
    const b = burpeeState();
    out.push(spItem(bx, 'burpee', { sets: 1, reps: (sp.targets || {}).burpees || 30, rest: 0, hold: 0 },
      { level: b.level, spKind: 'burpee', note: 'Simulazione Spartan · 30 burpees come la penalità: puoi spezzarli, conta la forma' }));
  }
  const hx = exById('g_deadhang');
  if (hx && !hx.retired && !isAvoided(hx.id)) {
    const h = hangBest();
    out.push(spItem(hx, 'spHang', { sets: 1, reps: 1, rest: 0, hold: clampN(Math.round((h.n || 25) * 0.8 / 5) * 5, 20, 60), holdBonus: 0 },
      { spKind: 'hang', workLabel: 'Sospensione', note: 'Simulazione Spartan · come sulle monkey bars, con il fiato corto' }));
  }
  const cx = (sp.carries || []).map(exById).find(e => e && !e.retired && e.setup.includes(S.setup) && !isAvoided(e.id));
  if (cx) out.push(spItem(cx, 'carry', { sets: 2, reps: 40, rest: 60, hold: 0 },
    { spKind: 'carry', note: 'Simulazione Spartan · le ripetizioni sono i passi' }));
  out.forEach(it => used.add(it.exId));
  return out;
}

/* Minuti aerobici della settimana, nel conto dell'OMS: un minuto vigoroso
   (scatti, finale metabolico) vale due minuti moderati. Riscaldamento e
   defaticamento non contano. */
function aerobicMinutes(weekAbs) {
  let mod = 0, vig = 0;
  weekLogs(weekAbs).forEach(l => {
    const ex = exById(l.exId);
    if (!ex || (ex.pattern !== 'cardio' && ex.pattern !== 'finisher')) return;
    if (l.goal === 'cardioWarm' || l.goal === 'cardioCool') return;
    const sets = l.sets || 0, hold = l.hold || 0, rest = l.rest || 0;
    if (!sets || !hold) return;
    if (l.goal === 'cardioSteady' || sets === 1) mod += sets * hold / 60;
    else { vig += sets * hold / 60; mod += Math.max(0, sets - 1) * rest / 60; }
  });
  return { mod: Math.round(mod), vig: Math.round(vig), eq: Math.round(mod + 2 * vig) };
}

/* ---------------------------------------------------------------------------
   MOBILITÀ DEL MATTINO (dalla 5.1)
   Porzione a sé stante: cinque sessioni brevi (10 o 15 minuti) al mattino,
   nei giorni 1-5 della settimana, in aggiunta alle sedute di pranzo. Il sesto
   giorno c'è soltanto la mobilità a pranzo.
   Perché funziona: l'ACSM indica che allungare quasi ogni giorno dà i
   risultati migliori sulla flessibilità, con tenute di 30-60 s negli adulti più anziani e
   circa 60 s totali per muscolo; poche decine di secondi per muscolo, ore
   prima dell'allenamento, non riducono forza e prestazione.
   Struttura: mobilità dinamica per "svegliare" le articolazioni, poi
   allungamenti statici sui distretti che lavoreranno nella seduta di pranzo
   dello stesso giorno. Si fa a casa, con tappetino e poco altro; non fa
   avanzare il programma e non conta nel volume dei pesi.
--------------------------------------------------------------------------- */
const MORNING_DAYS = 5;
/* Etichetta mostrata di una seduta registrata: quelle salvate prima della 6.7
   si chiamavano «Mattino · giorno N». Il registro non si tocca, cambia solo il
   testo a schermo. */
const sessLabel = x => String((x && x.label) || '').replace(/^Mattino · /, 'Mobilità breve · ').replace(/^Mattino saltato$/, 'Mobilità breve saltata');
// 'skipped' vale come seduta di programma: ha consumato il suo posto in
// calendario, quindi l'indice avanza e lo storico resta allineato
// 'extra': attività fuori programma registrate con la 6.11 (funzione poi tolta
// nella 6.12). Restano nello storico ma non sono sedute del programma.
const isProgramKind = k => k !== 'core' && k !== 'free' && k !== 'morning' && k !== 'extra';
const isSkipped = x => x.kind === 'skipped';

/* Giorni della settimana con la mobilità breve (dalla 6.10). Nella settimana
   da 6 sono i cinque giorni che NON hanno la seduta di mobilità del programma:
   la mobilità è ultima di default, ma si può spostare in qualunque giorno, e
   la mobilità breve si sposta con lei. Nelle settimane vecchie da 5 sedute e
   in quelle di sola mobilità restano i giorni 1-5. */
function morningAvail(w, day) {
  if (!(day >= 1) || day > weekLen(w)) return false;
  if (weekLen(w) <= MORNING_DAYS) return day <= MORNING_DAYS;
  let m;
  try { m = sessionMeta(weekStart(w) + day - 1); } catch (e) { return day <= MORNING_DAYS; }
  if (m.mobilityWeek) return day <= MORNING_DAYS;
  return m.dayType !== 'stretch';
}
const morningDaysOf = w => Array.from({ length: weekLen(w) }, (_, i) => i + 1).filter(d => morningAvail(w, d));

/* Mobilità brevi già fatte nella settimana indicata (numeri di giorno). */
function morningsDone(weekAbs) {
  return S.sessionLog.filter(x => x.kind === 'morning' && x.mWeek === weekAbs).map(x => x.mDay);
}
function morningsSkipped(weekAbs) {
  return S.sessionLog.filter(x => isSkipped(x) && x.realKind === 'morning' && x.mWeek === weekAbs).map(x => x.mDay);
}

function buildMorning(weekAbs, day, minutes) {
  const idx = weekStart(weekAbs) + Math.min(day, weekLen(weekAbs)) - 1;
  const meta = sessionMeta(idx);                      // la seduta di pranzo dello stesso giorno
  const cfg = PROG.morning || {};
  const key = meta.dayType === 'stretch' ? 'stretch' : `${meta.dayType}-${meta.tmplIdx}`;
  const focus = (cfg.focus || {})[key] || (cfg.focus || {}).stretch || { dyn: [], stat: [], label: '' };
  const budget = minutes || S.morningMin || 10;
  const home = e => e.setup.includes('home');
  const used = new Set(), items = [];
  const rot = weekAbs + day;
  const pickGroups = (pool, groups) => {
    const pref = pool.filter(e => groups.includes(e.group)).sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.id.localeCompare(b.id));
    const rest = pool.filter(e => !groups.includes(e.group)).sort((a, b) => a.id.localeCompare(b.id));
    return { pref, rest };
  };
  const dynPool = pickGroups(DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'mobility' && home(e)), focus.dyn || []);
  const statPool = pickGroups(DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'static' && home(e)), focus.stat || []);
  const add = (ex, goalKey, note, full) => {
    const d = dose(goalKey, meta.profile, ex);
    if (goalKey === 'mobility') { d.sets = ex.perSide ? 2 : 1; d.rest = 10; }   // un giro, un lato per volta
    // distretti di oggi: 2 tenute da 30 s per muscolo (circa 60 s totali,
    // indicazione ACSM); gli altri: una tenuta per muscolo
    else { d.sets = (full ? 2 : 1) * (ex.perSide ? 2 : 1); d.hold = 30; d.rest = 10; }
    const it = { exId: ex.id, note, goalKey, alt: { patterns: [ex.pattern], types: ['stretch'] }, ...d };
    used.add(ex.id);
    return it;
  };
  // 1. mobilità dinamica: 2 esercizi a 10 minuti, 3 a 15
  const nDyn = budget >= 15 ? 3 : 2;
  const rotate = (arr, k) => arr.length ? arr.slice(k % arr.length).concat(arr.slice(0, k % arr.length)) : arr;
  const dynList = rotate(dynPool.pref, rot).concat(rotate(dynPool.rest, rot));
  for (let i = 0; i < dynList.length && items.filter(x => x.goal === 'mobility').length < nDyn; i++) {
    const ex = dynList[i];
    if (!used.has(ex.id)) items.push(add(ex, 'mobility', 'Risveglio articolare'));
  }
  // 2. allungamenti statici dei distretti di oggi, finché c'è tempo
  const statList = statPool.pref.concat(statPool.rest);
  for (let i = 0; i < statList.length; i++) {
    const ex = statList[i];
    if (used.has(ex.id)) continue;
    const mine = statPool.pref.includes(ex);
    const it = add(ex, 'stretch', mine ? 'Per la seduta di oggi' : '', mine);
    if (estimateMinutes(items.concat([it])) > budget) { used.delete(ex.id); continue; }
    items.push(it);
  }
  // 3. tempo avanzato: tenute da 45 s (30-60 s negli adulti più anziani),
  //    poi un secondo giro sui distretti di oggi
  items.forEach(it => {
    if (it.goal !== 'stretch') return;
    it.hold = 45;
    if (estimateMinutes(items) > budget) it.hold = 30;
  });
  items.forEach(it => {
    if (it.goal !== 'stretch' || statPool.pref.some(e => e.id === it.exId)) return;
    it.sets += it.perSide ? 2 : 1;                // anche gli altri a 2 tenute, se c'è tempo
    if (estimateMinutes(items) > budget) it.sets -= it.perSide ? 2 : 1;
  });
  return Object.assign({}, meta, {
    label: `Mobilità breve · giorno ${day}`, type: 'stretch', kind: 'morning', items,
    minutes: estimateMinutes(items), budget, mWeek: weekAbs, mDay: day,
    focusLabel: focus.label || '', focusKey: key, lunchLabel: sessionFor(idx).label
  });
}

/* Giorno del mattino da proporre: quello della seduta di pranzo in
   programma oggi, se è fra i primi cinque e non è già stato fatto. */
function morningToday() {
  const w = weekOfIdx(S.sessionIndex);
  const day = posOfIdx(S.sessionIndex) + 1;
  return { w, day, available: morningAvail(w, day) };
}

function morningHtml() {
  const t = morningToday();
  const done = morningsDone(t.w);
  if (morningSel === null || morningSel.w !== t.w) morningSel = { w: t.w, day: t.available ? t.day : null };
  const day = morningSel.day;
  const skipped = morningsSkipped(t.w);
  const dots = morningDaysOf(t.w).map(d =>
    `<button class="mdot ${done.includes(d) ? 'done' : (skipped.includes(d) ? 'skip' : '')} ${d === day ? 'sel' : ''}" data-mday="${d}" aria-label="Mobilità breve del giorno ${d}${done.includes(d) ? ', fatto' : (skipped.includes(d) ? ', saltato' : '')}">${done.includes(d) ? '✓' : (skipped.includes(d) ? '–' : d)}</button>`).join('');
  let body;
  if (!day) {
    body = `<p class="small muted" style="margin-top:10px">Oggi c'è la seduta di mobilità del programma: niente mobilità breve. Se vuoi recuperarne una saltata, toccane il numero.</p>`;
  } else {
    const m = buildMorning(t.w, day, S.morningMin || 10);
    // la mattina segue sempre la seduta di pranzo di quel giorno: se la cambi
    // nel calendario, qui cambiano focus ed esercizi. Se era già stata fatta
    // pensando a un'altra seduta, lo si segnala.
    const doneEntry = S.sessionLog.filter(x => x.kind === 'morning' && x.mWeek === t.w && x.mDay === day).pop();
    const changed = doneEntry && doneEntry.mFocus && doneEntry.mFocus !== m.focusKey;
    const rows = m.items.map((it, i) => {
      const ex = exById(it.exId);
      return `<li data-mplan="${i}"><div class="fig">${figureFor(ex, 1, { ground: false })}</div>
        <div class="nm"><b>${esc(ex.name)}</b><span class="small muted">${esc(ex.group)}${it.note ? ' · ' + esc(it.note) : ''}</span></div>
        <div class="dose">${doseText(it)}</div><div class="chev">›</div></li>`;
    }).join('');
    body = `
      <p class="small muted" style="margin:10px 0 0">Giorno ${day} · allenamento: <b>${esc(m.lunchLabel)}</b>. ${m.focusLabel ? 'Focus ' + esc(m.focusLabel.replace(/^in vista d\S+ [^:]+: /, '')) + '.' : ''}
        Se cambi l'allenamento del giorno nel calendario qui sotto, questa sessione si aggiorna da sola.
        ${changed ? `<br><span style="color:var(--amber)">Oggi l'avevi fatta in vista di «${esc(doneEntry.mLunch || '')}»: se vuoi preparare i distretti della nuova seduta, puoi ripeterla adesso.</span>`
          : (done.includes(day) ? 'Già fatta: puoi ripeterla.' : '')}</p>
      <div class="seg dur" role="group" aria-label="Durata della mobilità breve" style="margin-top:10px">
        ${((PROG.morning || {}).durations || [10, 15]).map(v => `<button data-mmin="${v}" aria-pressed="${(S.morningMin || 10) === v}">${v}′</button>`).join('')}
      </div>
      <p class="small muted" style="margin:6px 0 0">Durata stimata ${m.minutes} minuti · a casa, serve solo un tappetino.</p>
      <ul class="plan">${rows}</ul>
      <button class="btn teal" id="morningGo" style="margin-top:10px">Inizia la mobilità breve</button>
      ${done.includes(day) ? '' : `<button class="btn ghost" id="morningMark" style="margin-top:8px">L'ho già fatta: segnala come svolta</button>
      <button class="btn ghost" id="morningSkip" style="margin-top:8px">Non la faccio: salta</button>`}`;
  }
  return `<div class="card morning" id="mCard">
    <div class="kicker" style="font-family:var(--cond);letter-spacing:.06em;text-transform:uppercase;font-size:13px;color:var(--teal)">A casa · a sé stante</div>
    <h2 style="margin-top:2px">Mobilità breve</h2>
    <p class="small muted" style="margin:6px 0 0">Cinque sessioni brevi nei giorni 1-5, in aggiunta all'allenamento del giorno. Non fanno avanzare il programma.</p>
    <div class="mdots" role="group" aria-label="Mobilità brevi della settimana">${dots}</div>
    ${body}
  </div>`;
}
function bindMorning() {
  const t = morningToday();
  document.querySelectorAll('[data-mday]').forEach(b => b.onclick = () => {
    morningSel = { w: t.w, day: +b.dataset.mday }; renderHome();
  });
  document.querySelectorAll('[data-mmin]').forEach(b => b.onclick = () => {
    S.morningMin = +b.dataset.mmin; save(); renderHome();
  });
  if (!morningSel || !morningSel.day) return;
  const m = buildMorning(t.w, morningSel.day, S.morningMin || 10);
  document.querySelectorAll('[data-mplan]').forEach(li => li.onclick = () => {
    const it = m.items[+li.dataset.mplan];
    openSheet(exById(it.exId), it, { sess: m, after: () => renderHome() });
  });
  if ($('#morningMark')) $('#morningMark').onclick = () => confirmAction(
    'Segnare la mobilità breve come svolta?',
    `Verranno registrati i ${m.items.length} esercizi alle dosi previste (${m.minutes} minuti). Serve quando l'hai fatta senza aprire l'app.`,
    'Segna come fatta', () => { markSessionDone(m); renderHome(); });
  if ($('#morningSkip')) $('#morningSkip').onclick = () => confirmAction(
    'Saltare la mobilità breve?',
    'Resta segnata come saltata nei pallini della settimana. L\'allenamento del giorno non cambia.',
    'Sì, la salto', () => { skipSession(m, 'Mobilità breve saltata'); renderHome(); });
  if ($('#morningGo')) $('#morningGo').onclick = () => {
    if (current && !current.finished) {
      confirmAction('Sessione già in corso', 'Vuoi abbandonarla e iniziare la mobilità breve? Gli esercizi già conclusi restano nello storico.',
        'Inizia la mobilità', () => startSession(m));
    } else startSession(m);
  };
}

/* ---------------------------------------------------------------------------
   MEMORIA DELLE SEDUTE GIÀ COSTRUITE (dalla 6.0)
   Costruire una seduta non è gratis: filtra i pool, applica le precauzioni,
   calcola le dosi e fa stare tutto nel tempo scelto. La stessa posizione veniva
   però ricostruita più volte nella stessa schermata — il calendario della
   settimana ne costruisce sei, la mobilità del mattino un'altra solo per
   leggerne l'etichetta, il volume previsto tutte quelle di forza.
   La chiave contiene tutto ciò da cui una seduta dipende, risultati registrati
   compresi: quando cambia qualcosa la memoria si svuota da sola, senza doverci
   pensare nei punti di modifica.
   ATTENZIONE: l'oggetto restituito è condiviso. Va usato in sola lettura
   (etichette, tipo, minuti, elenco). Chi deve modificare una seduta — le
   sostituzioni di esercizio della seduta di oggi — passa da todaySession(),
   che tiene una copia sua.
--------------------------------------------------------------------------- */
let sessMemo = new Map(), sessMemoKey = null;
function planSignature() {
  return [S.programId, S.setup, S.durPref || 45, S.finisher || '', S.kneeCare, S.shoulderCare,
          S.pullupGoal, JSON.stringify(S.pullSelf || null), S.week6From || 0, logsRev, (S.mobilityWeeks || []).join('.'),
          JSON.stringify(S.perms || {}), JSON.stringify(S.sessPick || {}), spSig(), painSig()].join('|');
}
function sessionFor(idx, kind) {
  const sig = planSignature();
  if (sig !== sessMemoKey) { sessMemo.clear(); sessMemoKey = sig; }
  const k = idx + '|' + (kind || '');
  let sess = sessMemo.get(k);
  if (!sess) { sess = buildSession(idx, kind); sessMemo.set(k, sess); }
  return sess;
}

/* Seduta completa per la posizione idx del programma. minutes = durata scelta
   in Home (35, 40, 45 o 50); il blocco core facoltativo resta sui 14 minuti. */
function buildSession(idx, kind, minutes) {
  const meta = sessionMeta(idx);
  const budget = kind === 'core' ? 14 : (minutes || S.durPref || 45);
  let body;
  if (kind === 'core') {
    body = buildCore(meta);
    body.trimmed = fitToTime(body.items, budget, []);
  } else if (meta.isStrength) body = buildStrength(meta, budget);
  else if (meta.isCardio) body = buildCardio(meta, budget);
  else body = buildStretch(meta, budget);
  const minutesEst = estimateMinutes(body.items);
  return Object.assign({}, meta, body, { minutes: minutesEst, budget, kind: kind || meta.dayType });
}

/* Stima del tempo: lavoro + recuperi. Gli allungamenti statici si contano su
   entrambi i lati, gli esercizi a tempo usano la durata della tenuta. */

/* ---------------------------------------------------------------------------
   CALIBRAZIONE DELLA DURATA
   La stima parte da 3,5 secondi per ripetizione, un valore fisso che ignora i
   tempi di transizione fra le macchine. A fine seduta si confrontano i minuti
   stimati con quelli reali e si corregge il coefficiente con una media mobile
   lenta, così il vincolo dei 35 minuti lavora su un numero vero.
   Le sedute interrotte a metà e i valori anomali non entrano nella media.
--------------------------------------------------------------------------- */


/* ---------------------------------------------------------------------------
   6. VISTE
--------------------------------------------------------------------------- */
const $ = sel => document.querySelector(sel);
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------------------------------------------------------------------
   SEDUTE DA REGISTRARE A POSTERIORI (dalla 5.5)
   Due casi:
   · hai svolto la seduta ma non l'hai aperta nell'app ("Segna come già
     fatta"): ogni esercizio viene registrato alle dosi previste;
   · l'app si è chiusa prima del riepilogo: gli esercizi già conclusi sono nello
     storico ma la seduta non risulta svolta. All'avvio l'app se ne accorge e
     propone di completarla, aggiungendo gli esercizi mancanti alle dosi
     previste.
   In nessuno dei due casi si cancella qualcosa: si aggiunge ciò che manca.
--------------------------------------------------------------------------- */
function plannedEntry(sess, it, sid, ts) {
  const ex = exById(it.exId);
  const entry = { ts, sid, sIdx: sess.idx, exId: it.exId, name: ex ? ex.name : it.exId,
    setup: S.setup, load: '', feedback: 'same', sets: it.sets,
    repsTarget: it.reps, repsDone: it.reps, rir: null, reps: it.reps,
    goal: it.goal, week: sess.weekInCycle, hold: it.hold || 0, rest: it.rest || 0,
    setsPlanned: it.sets, planned: true, ...(it.block === 'spartan' ? { spartan: true } : {}) };
  const r = rateFor(entry, S.logs);
  entry.stars = r.stars; entry.rateText = r.text; entry.warn = ''; entry.advice = r.advice || '';
  return entry;
}

/* Registra la seduta alle dosi previste. Gli esercizi già registrati con lo
   stesso identificativo restano come sono. */
function markSessionDone(sess, when, sid) {
  const ts = when || Date.now();
  sid = sid || ts;
  const already = new Set(S.logs.filter(l => l.sid === sid).map(l => l.exId));
  sess.items.forEach((it, i) => {
    if (already.has(it.exId)) return;
    S.logs.push(plannedEntry(sess, it, sid, ts - (sess.items.length - i) * 60000));
  });
  if (!S.sessionLog.some(x => x.sid === sid)) {
    S.sessionLog.push({ ts, sid, idx: sess.idx, label: sess.label, kind: sess.kind,
      minutes: sess.minutes || estimateMinutes(sess.items), planned: true,
      ...(sess.kind === 'morning' ? { mWeek: sess.mWeek, mDay: sess.mDay, mFocus: sess.focusKey, mLunch: sess.lunchLabel } : {}),
      note: 'Registrata a posteriori' });
    if (isProgramKind(sess.kind)) S.sessionIndex++;
    // (7S 0) corsa-camminata dichiarata fatta: entra nel registro delle corse,
    // il giorno dopo l'app chiede del ginocchio come per le altre
    if (sess.run) recordRun(sess, (sess.run || {}).planned || 0, sid, ts);
  }
  planCache = null;
  save();
}

/* (7S 0) Registro delle corse-camminate: livello, se è stata completa e, il
   giorno dopo, come ha risposto il ginocchio. Non si cancella mai nulla. */
function recordRun(sess, done, sid, ts) {
  const r = sess.run || {};
  S.spartanRuns = Array.isArray(S.spartanRuns) ? S.spartanRuns : [];
  if (S.spartanRuns.some(x => x && x.sid === sid)) return;
  S.spartanRuns.push({ ts: ts || Date.now(), sid, idx: sess.idx, level: r.level || 0,
    planned: r.planned || 0, done: done || 0, full: !!r.full && (done || 0) >= (r.planned || 0),
    light: !!r.light, check: !!r.check, knee: null, km: null });
}

/* ---------------------------------------------------------------------------
   SEDUTA SALTATA (dalla 5.7)
   Capita di non poterla fare: invece di lasciarla in sospeso o di far finta di
   nulla, la si dichiara saltata. La seduta resta nello storico con il suo
   motivo e il programma avanza a quella successiva, così l'indice non si
   disallinea. Nulla viene registrato come svolto: nel volume settimanale
   quella seduta continua a risultare mancante, ed è giusto che si veda.
--------------------------------------------------------------------------- */
function skipSession(sess, why) {
  const ts = Date.now();
  S.sessionLog.push({ ts, sid: ts, idx: sess.idx, label: sess.label,
    kind: 'skipped', realKind: sess.kind, minutes: 0,
    ...(sess.kind === 'morning' ? { mWeek: sess.mWeek, mDay: sess.mDay } : {}),
    note: why || 'Saltata' });
  if (sess.kind !== 'morning') {
    S.sessionIndex++;
    const weekDone = posOfIdx(S.sessionIndex) === 0 ? weekOfIdx(S.sessionIndex) - 1 : 0;
    if (weekDone) { S.lastRecap = weekDone; takeSnapshot(weekDone); }
  }
  planCache = null; homeSel = 'session';
  clearResume();
  save();
}

/* Sedute rimaste aperte: esercizi registrati con un identificativo di seduta
   che non compare fra le sedute chiuse. */
function orphanSessions() {
  const closed = new Set(S.sessionLog.filter(x => x.sid).map(x => x.sid));
  const open = S.resume ? S.resume.started : null;
  const by = new Map();
  S.logs.forEach(l => {
    if (!l.sid || closed.has(l.sid) || l.sid === open) return;
    const g = by.get(l.sid) || { sid: l.sid, logs: [] };
    g.logs.push(l); by.set(l.sid, g);
  });
  const out = [];
  by.forEach(g => {
    const last = Math.max(...g.logs.map(l => l.ts));
    if (Date.now() - last < 3 * 3600 * 1000) return;     // potrebbe essere ancora in corso
    const idx = g.logs[0].sIdx;
    const allStretch = g.logs.every(l => { const e = exById(l.exId); return e && e.type === 'stretch'; });
    out.push({ sid: g.sid, logs: g.logs, ts: last, idx, allStretch });
  });
  return out.sort((a, b) => a.ts - b.ts);
}

function fixOrphanSessions() {
  const list = orphanSessions();
  if (!list.length) return;
  const o = list[0];
  const meta = (o.idx != null) ? sessionMeta(o.idx) : sessionMeta(S.sessionIndex);
  const d = new Date(o.ts);
  const morningLikely = o.allStretch && meta.dayType !== 'stretch' && morningAvail(weekOfIdx(meta.idx), posOfIdx(meta.idx) + 1);
  const day = new Date(o.ts).toLocaleDateString('it-IT');
  // (8.5) niente ora a schermo (regola permanente): solo il giorno
  openModal(`<h2>Una seduta è rimasta aperta</h2>
    <p class="small muted">Il ${day} hai registrato ${o.logs.length} esercizi, ma la seduta non è stata chiusa: l'app si è chiusa prima del riepilogo. Com'era?</p>
    <button class="btn" id="orMorning" style="margin-top:12px">${morningLikely ? 'Sì: era la mobilità breve' : 'Era la mobilità breve'}</button>
    <button class="btn ${morningLikely ? 'ghost' : ''}" id="orLunch" style="margin-top:10px">Era la seduta del giorno (${esc(buildSession(o.idx != null ? o.idx : S.sessionIndex).label)})</button>
    <button class="btn ghost" id="orFree" style="margin-top:10px">Era una seduta libera</button>
    <button class="btn ghost" id="orNo" style="margin-top:10px">Lascia com'è</button>
    <p class="small muted" style="margin-top:12px">Con le prime due la seduta risulta svolta per intero: gli esercizi che mancano vengono aggiunti alle dosi previste. Con «seduta libera» resta registrato soltanto quello che hai davvero fatto, e il programma non avanza: la seduta prevista rimane da svolgere. In nessun caso si cancella qualcosa.</p>`);
  const close = fn => closeModal(() => { if (fn) fn(); goToday(); });
  $('#orMorning').onclick = () => close(() => {
    const w = weekOfIdx(meta.idx);
    let day2 = posOfIdx(meta.idx) + 1;
    if (!morningAvail(w, day2)) day2 = morningDaysOf(w).filter(d => d <= day2).pop() || morningDaysOf(w)[0] || 1;
    markSessionDone(buildMorning(w, day2, S.morningMin || 10), o.ts, o.sid);
  });
  $('#orLunch').onclick = () => close(() => {
    markSessionDone(buildSession(o.idx != null ? o.idx : S.sessionIndex), o.ts, o.sid);
  });
  $('#orFree').onclick = () => close(() => closeAsFree(o));
  $('#orNo').onclick = () => close(() => {
    // niente cancellazioni: si segna solo di non richiederlo più
    S.orphanIgnored = (S.orphanIgnored || []).concat([o.sid]);
    S.sessionLog.push({ ts: o.ts, sid: o.sid, idx: o.idx, label: 'Seduta non chiusa (ignorata)',
      kind: 'free', minutes: 0, note: 'Esercizi registrati, seduta non conteggiata' });
    save();
  });
}

/* Chiude come seduta libera una seduta rimasta aperta: restano registrati
   soltanto gli esercizi davvero svolti (nessuna dose aggiunta d'ufficio) e il
   programma non avanza, perché la seduta prevista è ancora da fare. I minuti
   si ricavano dall'intervallo fra la prima e l'ultima registrazione. */
function closeAsFree(o) {
  if (S.sessionLog.some(x => x.sid === o.sid)) return;
  const first = Math.min.apply(null, o.logs.map(l => l.ts));
  const minutes = Math.max(1, Math.round((o.ts - first) / 60000) + 3);
  S.sessionLog.push({ ts: o.ts, sid: o.sid, idx: o.idx, label: 'Seduta libera',
    kind: 'free', minutes, free: true,
    note: 'Seduta rimasta aperta, registrata come libera' });
  planCache = null;
  save();
}

const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.toDateString() === y.toDateString(); };

/* Valutazione di una seduta chiusa: completamento delle serie previste,
   minuti rispetto alla stima, stelle medie dove ci sono carichi da confrontare. */
function sessionVerdict(x) {
  const logs = x.sid ? S.logs.filter(l => l.sid === x.sid) : logsOfSession(x);
  let done = 0, planned = 0;
  logs.forEach(l => { done += l.sets || 0; planned += (l.setsPlanned || l.sets || 0); });
  const pct = planned ? Math.round(done / planned * 100) : (logs.length ? 100 : 0);
  const rated = logs.filter(l => l.stars > 0);
  const avg = rated.length ? rated.reduce((a, l) => a + l.stars, 0) / rated.length : 0;
  const text = pct >= 95 ? 'Seduta completa' : pct >= 70 ? 'Seduta quasi completa' : pct > 0 ? 'Seduta parziale' : 'Seduta registrata';
  return { logs, pct, avg, text, minutes: x.minutes || 0 };
}

/* Mattino di oggi: fatto oggi, oppure quello da fare. */
function morningStatus() {
  const doneToday = S.sessionLog.filter(x => x.kind === 'morning' && sameDay(x.ts, Date.now())).pop();
  if (doneToday) return { done: true, entry: doneToday, verdict: sessionVerdict(doneToday) };
  const lunchToday = S.sessionLog.filter(x => isProgramKind(x.kind) && sameDay(x.ts, Date.now())).pop();
  // se il pranzo di oggi è già chiuso, l'indice punta a domani: il mattino di
  // oggi è quello del giorno appena svolto
  const idx = lunchToday && lunchToday.idx != null ? lunchToday.idx : S.sessionIndex;
  const w = weekOfIdx(idx), day = posOfIdx(idx) + 1;
  if (!morningAvail(w, day)) return { done: false, none: true, w, day };
  const m = buildMorning(w, day, S.morningMin || 10);
  return { done: false, w, day, m };
}
/* ---------------------------------------------------------------------------
   SEDUTA DI OGGI SECONDO IL CALENDARIO (dalla 8.7)
   Le sei sedute della settimana corrispondono, di base, ai giorni da lunedì a
   sabato: la «seduta di oggi» è quella prevista per il giorno della settimana
   in cui si apre l'app (gli scambi fatti nella settimana restano validi).
     · già svolta (o saltata) → risultati e valutazioni;
     · da fare → il programma del giorno (se prima ci sono sedute dei giorni
       scorsi non svolte, avviandola quelle si spostano più avanti);
     · domenica → riposo, con la prossima seduta a disposizione;
     · settimana del programma iniziata in una settimana di calendario
       precedente e rimasta a metà → si prosegue con la prossima seduta e si
       può saltare il resto per ripartire dal lunedì.
--------------------------------------------------------------------------- */
const WEEKDAYS = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
function calendarMonday(ts) {
  const d = new Date(ts || Date.now());
  const wd = (d.getDay() + 6) % 7;            // 0 = lunedì
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - wd);
  return d.getTime();
}
const weekdayIdx = ts => (new Date(ts || Date.now()).getDay() + 6) % 7;   // 0 = lunedì … 6 = domenica
function programWeekLogs(w) {
  const a = weekStart(w), b = a + weekLen(w);
  return (S.sessionLog || []).filter(x => x && x.idx != null && x.idx >= a && x.idx < b && isProgramKind(x.kind) && !/ignorata/.test(x.label || ''));
}
function todayPlan() {
  const SI = S.sessionIndex, wCur = weekOfIdx(SI), here = posOfIdx(SI);
  const monday = calendarMonday(), day = weekdayIdx();
  let W = wCur;
  if (here === 0 && wCur > 1 && programWeekLogs(wCur - 1).some(x => x.ts >= monday)) W = wCur - 1;   // settimana finita in anticipo
  else if (here > 0) {
    const first = programWeekLogs(wCur).reduce((m, x) => Math.min(m, x.ts || Infinity), Infinity);
    if (first < monday) return { stale: true, W: wCur, here, left: weekLen(wCur) - here, day };
  }
  const len = weekLen(W);
  if (day >= len) return { rest: true, W, day };
  const idx = weekStart(W) + day;
  if (idx < SI) { const i = sessionLogIndexFor(idx); return { done: true, idx, q: day, W, day, logIdx: i, entry: i >= 0 ? S.sessionLog[i] : null }; }
  return { done: false, idx, q: day, W, day, pending: idx - SI };
}
function lunchStatus() {
  const tp = todayPlan();
  if (tp.rest || tp.stale) return { rest: !!tp.rest, stale: !!tp.stale, tp, s: todaySession(null) };
  if (tp.done) {
    if (tp.entry && isSkipped(tp.entry)) return { skipped: true, entry: tp.entry, tp, s: todaySession(null) };
    return { done: true, entry: tp.entry, verdict: tp.entry ? sessionVerdict(tp.entry) : null, tp };
  }
  return { done: false, tp, s: tp.idx === S.sessionIndex ? todaySession(null) : sessionFor(tp.idx) };
}
/* Salta le sedute rimaste di una settimana del programma iniziata prima di
   questa settimana di calendario: registro «saltata», nessun dato cancellato. */
function skipRestOfWeek() {
  const w = weekOfIdx(S.sessionIndex);
  let k = 0;
  while (weekOfIdx(S.sessionIndex) === w && k < 8) {
    skipSession(sessionFor(S.sessionIndex), 'Saltata: settimana del programma rimasta a metà');
    const last = S.sessionLog[S.sessionLog.length - 1];
    if (last) last.sid = last.ts + k;
    k++;
  }
  planCache = null; save();
}

/* Percorso: fase, settimana, settimane alla fine e data di fine stimata
   (si sposta se aggiungi settimane di sola mobilità). */
function pathStatus() {
  const p = program();
  const meta = sessionMeta(S.sessionIndex);
  const total = totalWeeks(p) || p.cycleWeeks || 1;
  const tw = meta.trainingWeek;
  const futureMob = (S.mobilityWeeks || []).filter(w => w >= meta.weekAbs).length;
  const weeksLeft = Math.max(0, total - tw) + futureMob;
  const daysIntoWeek = posOfIdx(S.sessionIndex);
  const end = new Date(Date.now() + (weeksLeft * 7 + (meta.days - daysIntoWeek)) * 86400000);
  return { p, meta, total, tw, weeksLeft, end, pct: Math.min(100, Math.round((tw - 1) / total * 100)) };
}

/* Tendenza degli esercizi: per ciascuno confronta la media delle ultime due
   registrazioni con quella delle prime due (dentro le ultime 8 settimane),
   sulla metrica che l'app usa già nei grafici (massimale stimato, gradino o
   volume). Sopra +2% cresce, sotto -2% cala. */
let trendMemo = null;
function trendFor() {
  const sig = planSignature();
  if (!trendMemo || trendMemo.sig !== sig) trendMemo = { sig, v: exerciseTrend() };
  return trendMemo.v;
}
function exerciseTrend() {
  const since = Date.now() - 56 * 86400000;
  const byEx = {};
  // solo prestazioni vere: niente aerobico, allungamenti, sedute segnate come fatte
  S.logs.forEach(l => { if (isRatable(l) && !isDeloadLog(l)) (byEx[l.exId] = byEx[l.exId] || []).push(l); });
  // (6.9) dalla ripartenza: riferimento + sedute successive
  Object.keys(byEx).forEach(k => { byEx[k] = progressLogs(k, byEx[k]); });
  let up = 0, flat = 0, down = 0;
  const detail = [];
  Object.keys(byEx).forEach(k => {
    const logs = byEx[k].filter(l => l.ts >= since);
    const vals = seriesValues(logs).vals.filter(isFinite);
    if (vals.length < 2) return;
    const a = vals.slice(0, 2), b = vals.slice(-2);
    const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
    const r = ma ? (mb - ma) / ma : 0;
    if (r > 0.02) up++; else if (r < -0.02) down++; else flat++;
    detail.push({ name: logs[logs.length - 1].name, r });
  });
  const rated = S.logs.filter(l => l.stars > 0);
  const avgOf = (from, to) => { const x = rated.filter(l => l.ts >= from && l.ts < to); return x.length ? x.reduce((s, l) => s + l.stars, 0) / x.length : 0; };
  const now = Date.now(), d14 = 14 * 86400000;
  return { up, flat, down, n: up + flat + down, recent: avgOf(now - d14, now + 1), before: avgOf(now - 2 * d14, now - d14),
           best: detail.sort((x, y) => y.r - x.r).slice(0, 3) };
}

/* Obiettivo ragionevole a fine piano.
   Peso: con pesi e deficit moderato è realistico perdere 0,25-0,5 kg a
   settimana conservando il muscolo (la letteratura indica 0,5-1% del peso
   corporeo a settimana come tetto per non perdere massa magra: Helms et al.
   2014); la stima usa la fascia prudente, adatta a chi costruisce muscolo
   nello stesso tempo.
   Girovita: si proietta la tendenza delle TUE misure (servono almeno due
   misure a 2 settimane di distanza), con un tetto di 0,5 cm a settimana;
   come riferimento, l'OMS indica per gli uomini rischio aumentato sopra 94 cm
   e molto aumentato sopra 102 cm. */
function bodyProjection() {
  const m = (S.measures || []).slice().sort((a, b) => a.ts - b.ts);
  const path = pathStatus();
  const weeks = Math.max(0, (path.end - Date.now()) / (7 * 86400000));
  const lastW = m.slice().reverse().find(x => isFinite(x.weight));
  const lastC = m.slice().reverse().find(x => isFinite(x.waist));
  const firstC = m.find(x => isFinite(x.waist));
  const out = { m, weeks, end: path.end, lastW, lastC };
  if (lastW) out.weight = { from: lastW.weight, lo: lastW.weight - 0.5 * weeks, hi: lastW.weight - 0.25 * weeks };
  // Tetto prudente del 5-10% del peso iniziale. Nota sulla fonte: era
  // attribuito al Position Stand ACSM di Donnelly et al. 2009, superato dal
  // Consensus Statement ACSM 2024 (Jakicic et al.), che NON fissa più obiettivi
  // percentuali di perdita di peso e insiste invece su almeno 150 minuti a
  // settimana di attività moderata, con beneficio crescente con la dose. Il
  // tetto resta qui come freno prudente alla proiezione, non come obiettivo.
  if (lastW) { out.weight.lo = Math.max(out.weight.lo, lastW.weight * 0.90); out.weight.hi = Math.max(out.weight.hi, lastW.weight * 0.95); }
  if (lastC && firstC && lastC !== firstC && (lastC.ts - firstC.ts) >= 14 * 86400000) {
    const perWeek = (lastC.waist - firstC.waist) / ((lastC.ts - firstC.ts) / (7 * 86400000));
    const rate = Math.max(-0.5, Math.min(0, perWeek));        // tetto prudente; nessuna proiezione in aumento
    out.waist = { from: lastC.waist, to: lastC.waist + rate * weeks, perWeek };
    out.waist.to = Math.max(out.waist.to, lastC.waist - 8);    // tetto prudente: non più di 8 cm in tutto il piano
  }
  return out;
}
const kg1 = v => (Math.round(v * 10) / 10).toString().replace('.', ',');
const dateIt = d => new Date(d).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

/* ---------------------------------------------------------------------------
   RIQUADRI DELLE DUE SEDUTE DI OGGI
   Mattino e pranzo nella schermata di scelta di Oggi, che dalla 6.5 è anche la
   pagina d'apertura dell'app (la Home, quasi identica, è stata tolta).
--------------------------------------------------------------------------- */
const dashTile = (attr, id, kicker, cls, body) => `<button class="dtile ${cls}" data-${attr}="${id}">
      <div class="kicker">${kicker}</div>${body}<span class="chev">›</span></button>`;

function morningTileBody(ms, full) {
  if (ms.done) return `<div class="dstat ok">Fatta ✓</div><p class="small">${esc(ms.verdict.text)} · ${ms.verdict.pct}% delle tenute · ${ms.verdict.minutes} min</p>
       <p class="small muted">Mobilità brevi della settimana: ${morningsDone(weekOfIdx(S.sessionIndex)).length} di ${MORNING_DAYS}.${full ? ' Puoi ripeterla o recuperarne una.' : ''}</p>`;
  if (ms.none) return `<div class="dstat">Oggi niente</div><p class="small muted">Oggi c'è la seduta di mobilità del programma.${full ? ' Entra se vuoi recuperarne una saltata.' : ''}</p>`;
  return `<div class="dstat todo">Da fare · ${ms.m.minutes} min</div><p class="small">${esc(ms.m.focusLabel || '')}</p>
         <p class="small muted">${Math.max(1, morningDaysOf(ms.w).indexOf(ms.day) + 1)}ª di ${MORNING_DAYS} della settimana · ${ms.m.items.length} esercizi a casa${full ? ', serve solo un tappetino' : ''}.</p>`;
}

function lunchTileBody(ls, full) {
  const wd = WEEKDAYS[weekdayIdx()];
  if (ls.rest) return `<div class="dstat">Domenica · riposo</div><p class="small">Nessuna seduta prevista oggi.</p>
       <p class="small muted">La prossima è «${esc(ls.s.label)}» (lunedì) · tocca per vederla o farla lo stesso.</p>`;
  if (ls.stale) return `<div class="dstat todo">Settimana da chiudere</div><p class="small"><b>${esc(ls.s.label)}</b> · ${ls.s.minutes} min</p>
       <p class="small muted">La settimana ${ls.tp.W} del programma è rimasta a metà (${ls.tp.left === 1 ? 'manca 1 seduta' : `mancano ${ls.tp.left} sedute`}): puoi proseguire o saltare il resto e ripartire dal lunedì.</p>`;
  if (ls.skipped) return `<div class="dstat">Saltata</div><p class="small">Seduta di oggi (${wd}): <b>${esc(sessLabel(ls.entry))}</b> non svolta.</p>
       <p class="small muted">Tocca per i dettagli e il programma della settimana.</p>`;
  if (ls.done) return `<div class="dstat ok">Fatta ✓</div><p class="small">Seduta di oggi (${wd}): <b>${esc(ls.entry ? sessLabel(ls.entry) : sessionFor(ls.tp.idx).label)}</b></p>
       ${ls.verdict ? `<p class="small">${esc(ls.verdict.text)} · ${ls.verdict.pct}% delle serie · ${ls.verdict.minutes} min${ls.verdict.avg ? ' · ' + starsHtml(Math.round(ls.verdict.avg)) : ''}</p>` : ''}
       <p class="small muted">Tocca per svolgimento, risultati e valutazioni.</p>`;
  return `<div class="dstat todo">Da fare · ${ls.s.minutes} min</div><p class="small">Seduta di oggi (${wd}): <b>${esc(ls.s.label)}</b></p>
       <p class="small muted">${typeWord(ls.s)} · ${ls.s.items.length} esercizi${ls.tp && ls.tp.pending ? ` · prima ${ls.tp.pending === 1 ? 'c\'è 1 seduta' : `ci sono ${ls.tp.pending} sedute`} dei giorni scorsi non svolte` : ''}.</p>`;
}

/* Pagina Progressi: percorso, prossime settimane, trazioni, esercizi, misure,
   volume e storico. Dalla 6.5 non c'è più la Home: l'app si apre su Oggi, che
   resta concentrata su cosa fare oggi; tutto il resto sta qui. */
/* ===========================================================================
   VERSIONE 8 · PROGRESSI, RECORD, SENSAZIONI E DOLORE
=========================================================================== */
/* ---------- record personali ----------
   Per ogni esercizio: massimale stimato (carichi), ripetizioni migliori allo
   stesso carico o a un carico maggiore, ripetizioni al livello (corpo libero),
   secondi di tenuta (esercizi a tempo). Valgono le registrazioni reali, fuori
   dalla settimana di scarico (regola 6.8); quelle prima della ripartenza della
   6.9 restano valide come riferimento: sono record veri. */
const prOk = l => l && !l.planned && !isDeloadLog(l) && exById(l.exId);
function prValueOf(l) {
  const ex = exById(l.exId);
  if (!ex || isCardioEx(ex) || ex.type === 'stretch') return null;
  if (ex.load === 'weight' && !isAssist(ex)) {
    const e = e1rm(l);
    return e ? { kind: 'e1rm', v: e } : null;
  }
  if (ex.load === 'time') {
    const rows = setRows(l);
    const v = rows ? Math.max(0, ...rows.map(r => +r.hold || 0)) : (+l.hold || 0);
    return v > 0 ? { kind: 'hold', v } : null;
  }
  if (isAssist(ex)) return null;
  const steps = levelsOf(ex);
  const lvl = steps ? Math.max(0, steps.indexOf(l.load)) : 0;
  const reps = bestRepsOf(l);
  return reps > 0 ? { kind: 'reps', v: reps, lvl } : null;
}
/* Il nuovo record (se c'è) di una registrazione rispetto alle precedenti. */
function detectPR(entry, others) {
  if (!prOk(entry)) return null;
  const cur = prValueOf(entry);
  if (!cur) return null;
  const prev = others.filter(l => l !== entry && l.exId === entry.exId && prOk(l) && !(entry.sid != null && l.sid === entry.sid))
    .map(prValueOf).filter(x => x && x.kind === cur.kind && (cur.kind !== 'reps' || x.lvl === cur.lvl));
  if (!prev.length) return null;                      // la prima volta non è un record
  const best = Math.max(...prev.map(x => x.v));
  if (cur.v <= best + (cur.kind === 'e1rm' ? 0.25 : 0)) return null;
  const ex = exById(entry.exId), kg = x => (Math.round(x * 10) / 10).toString().replace('.', ',');
  if (cur.kind === 'e1rm') return { kind: 'e1rm', v: cur.v, text: `massimale stimato ${kg(cur.v)} kg (prima ${kg(best)})` };
  if (cur.kind === 'hold') return { kind: 'hold', v: cur.v, text: `${Math.round(cur.v)} s di tenuta (prima ${Math.round(best)})` };
  return { kind: 'reps', v: cur.v, text: `${cur.v} ripetizioni di fila${levelsOf(ex) ? ` a «${entry.load}»` : ''} (prima ${best})` };
}
/* Elenco dei record attuali, esercizio per esercizio. */
function recordsList() {
  const by = new Map();
  S.logs.forEach(l => {
    if (!prOk(l)) return;
    const v = prValueOf(l);
    if (!v) return;
    const key = l.exId + '|' + v.kind + '|' + (v.lvl || 0);
    const cur = by.get(key);
    if (!cur || v.v > cur.v.v) by.set(key, { l, v });
  });
  return [...by.values()].sort((a, b) => (b.l.ts || 0) - (a.l.ts || 0));
}
function recordText(r) {
  const ex = exById(r.l.exId), kg = x => (Math.round(x * 10) / 10).toString().replace('.', ',');
  if (r.v.kind === 'e1rm') {
    const rows = setRows(r.l) || [];
    const top = rows.length ? rows.reduce((a, x) => (numLoad(x.load) || 0) * (1 + (+x.reps || 0) / 30) > (numLoad(a.load) || 0) * (1 + (+a.reps || 0) / 30) ? x : a) : { load: r.l.load, reps: r.l.repsDone };
    return `massimale stimato <b>${kg(r.v.v)} kg</b> · ${kg(numLoad(top.load) || 0)} kg × ${top.reps}`;
  }
  if (r.v.kind === 'hold') return `<b>${Math.round(r.v.v)} s</b> di tenuta`;
  return `<b>${r.v.v}</b> di fila${levelsOf(ex) ? ` · ${esc(r.l.load || '')}` : ''}`;
}
/* (8) ANNULLA: per 10 secondi dopo «Salta», «Segna come svolta» o lo
   spostamento di una seduta. Ripristina esattamente lo stato di prima:
   toglie solo ciò che quell'azione aveva appena aggiunto. */
let undoSnap = null;
function snapForUndo() {
  undoSnap = { ts: Date.now(), logsLen: S.logs.length, slLen: S.sessionLog.length, idx: S.sessionIndex,
    perms: JSON.stringify(S.perms || {}), pick: JSON.stringify(S.sessPick || {}),
    runsLen: Array.isArray(S.spartanRuns) ? S.spartanRuns.length : 0,
    snapsLen: Array.isArray(S.snapshots) ? S.snapshots.length : 0, lastRecap: S.lastRecap,
    resume: S.resume ? JSON.stringify(S.resume) : null };
}
function offerUndo(text) {
  showToast(`<div style="flex:1">${esc(text)}</div><button class="undo" id="undoBtn">Annulla</button>`, 10000);
  const bt = document.getElementById('undoBtn');
  if (bt) bt.onclick = doUndo;
}
function doUndo() {
  const u = undoSnap;
  undoSnap = null;
  const t = document.getElementById('toast'); if (t) t.classList.remove('on');
  if (!u || Date.now() - u.ts > 12000) return false;
  if (S.logs.length > u.logsLen) S.logs.length = u.logsLen;   // save() riscrive lo storico
  if (S.sessionLog.length > u.slLen) S.sessionLog.length = u.slLen;
  if (Array.isArray(S.spartanRuns) && S.spartanRuns.length > u.runsLen) S.spartanRuns.length = u.runsLen;
  if (Array.isArray(S.snapshots) && S.snapshots.length > u.snapsLen) S.snapshots.length = u.snapsLen;
  S.sessionIndex = u.idx; S.perms = JSON.parse(u.perms); S.sessPick = JSON.parse(u.pick); S.lastRecap = u.lastRecap;
  if (u.resume && !S.resume) S.resume = JSON.parse(u.resume);
  planCache = null; save(); renderHome();
  showToast('<div>Annullato: tutto come prima.</div>', 2500);
  return true;
}
let toastTimer = null;
function showToast(html, ms) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.innerHTML = html;
  t.classList.add('on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms || 3500);
  return t;
}

/* ---------- massimale stimato con tendenza ---------- */
const KEY_PATTERNS = ['squat', 'hinge', 'pushH', 'pushV', 'pullH', 'pullV', 'lunge'];
function trendLine(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
  let num = 0, den = 0;
  pts.forEach(p => { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; });
  const b = den ? num / den : 0;
  return { a: my - b * mx, b };
}
function e1rmSeries(exId) {
  return progressLogs(exId).map(l => ({ x: (l.ts || 0) / DAY_MS, y: e1rm(l), ts: l.ts })).filter(p => p.y);
}
function e1rmChart(pts) {
  if (pts.length < 2) return '<p class="small muted">Servono almeno due sedute con il carico annotato.</p>';
  const tl = trendLine(pts);
  const ys = pts.map(p => p.y).concat([tl.a + tl.b * pts[0].x, tl.a + tl.b * pts[pts.length - 1].x]);
  const min = Math.min(...ys), max = Math.max(...ys), r = (max - min) || 1;
  const x0 = pts[0].x, x1 = pts[pts.length - 1].x, rx = (x1 - x0) || 1;
  const X = x => 8 + (x - x0) / rx * 284, Y = y => 96 - (y - min) / r * 78;
  const poly = pts.map(p => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const dots = pts.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.6" fill="#F5A524"/>`).join('');
  return `<svg viewBox="0 0 300 112" style="width:100%" role="img" aria-label="Massimale stimato e linea di tendenza">
    <line x1="8" y1="100" x2="292" y2="100" stroke="#2B3B4E" stroke-width="1.5"/>
    <line x1="${X(x0)}" y1="${Y(tl.a + tl.b * x0).toFixed(1)}" x2="${X(x1)}" y2="${Y(tl.a + tl.b * x1).toFixed(1)}" stroke="#4FC3A1" stroke-width="2" stroke-dasharray="5 4"/>
    <polyline points="${poly}" fill="none" stroke="#F5A524" stroke-width="2.6" stroke-linejoin="round"/>${dots}
    <text x="8" y="12" fill="#93A7BC" font-size="10">${max.toFixed(1)} kg</text>
    <text x="8" y="94" fill="#93A7BC" font-size="10">${min.toFixed(1)}</text>
    <text x="292" y="110" fill="#93A7BC" font-size="9" text-anchor="end">${dateIt(pts[0].ts)} → ${dateIt(pts[pts.length - 1].ts)}</text></svg>`;
}
function keyLifts() {
  const ids = [...new Set(S.logs.filter(l => prOk(l)).map(l => l.exId))]
    .filter(id => { const ex = exById(id); return ex && ex.load === 'weight' && !isAssist(ex) && KEY_PATTERNS.includes(ex.pattern); });
  return ids.map(id => ({ ex: exById(id), pts: e1rmSeries(id) })).filter(x => x.pts.length >= 2)
    .sort((a, b) => b.pts.length - a.pts.length);
}
function openE1rm() {
  const lifts = keyLifts();
  const rows = lifts.map(({ ex, pts }) => {
    const tl = trendLine(pts);
    const per4 = tl ? tl.b * 28 : 0, last = pts[pts.length - 1].y;
    const pct = last ? per4 / last * 100 : 0;
    return `<div class="block" style="margin-top:14px"><h3 style="font-size:16px">${esc(ex.name)}</h3>
      <p class="small muted">Ultimo ${last.toFixed(1)} kg · tendenza ${per4 >= 0 ? '+' : ''}${per4.toFixed(1)} kg ogni 4 settimane (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) · ${pts.length} sedute</p>
      ${e1rmChart(pts)}</div>`;
  }).join('');
  openModal(`<h2>Massimale stimato</h2>
    <p class="small muted">Esercizi fondamentali con il carico annotato. Linea arancio: massimale stimato seduta per seduta (formula di Epley, ripetizioni fino a 15); tratteggio verde: tendenza. È una stima, utile per vedere la direzione, non un valore da provare. Senza settimane di scarico, dalla ripartenza della 6.9 (più il riferimento di partenza).</p>
    ${rows || '<p class="small muted" style="margin-top:12px">Servono almeno due sedute con il carico annotato su squat, stacchi, spinte o tirate.</p>'}
    <button class="btn secondary" id="e1Close" style="margin-top:14px">Chiudi</button>`);
  $('#e1Close').onclick = () => closeModal();
}
function openRecords() {
  const list = recordsList();
  const rows = list.map(r => `<li><div class="nm" style="flex:1"><b>${esc(exById(r.l.exId).name)}</b>
      <div class="small">${recordText(r)}</div><div class="small muted">${dateIt(r.l.ts)}</div></div></li>`).join('');
  openModal(`<h2>Record personali</h2>
    <p class="small muted">Il migliore di sempre per ogni esercizio, dal più recente. Le settimane di scarico non contano. Quando ne batti uno, l'app te lo dice subito in seduta.</p>
    <ul class="hist">${rows || '<li class="small muted">Ancora nessun record: servono almeno due sedute dello stesso esercizio.</li>'}</ul>
    <button class="btn secondary" id="prClose" style="margin-top:14px">Chiudi</button>`);
  $('#prClose').onclick = () => closeModal();
}

/* ---------- durata reale contro stimata ---------- */
function durationStats() {
  const rows = S.sessionLog.filter(x => isProgramKind(x.kind) && !x.planned && x.minutes > 4 && x.est > 0).slice(-12);
  const by = {};
  rows.forEach(x => { const k = x.budget || x.est; (by[k] = by[k] || []).push(x); });
  return Object.keys(by).map(k => {
    const xs = by[k];
    const real = xs.reduce((a, x) => a + x.minutes, 0) / xs.length;
    const est = xs.reduce((a, x) => a + x.est, 0) / xs.length;
    return { budget: +k, n: xs.length, real: Math.round(real), est: Math.round(est), diff: Math.round(real - est) };
  }).sort((a, b) => a.budget - b.budget);
}

/* ---------- sensazioni e dolore ---------- */
const feelRows = () => S.sessionLog.filter(x => x && x.feel && isProgramKind(x.kind));
/* Il dolore è salito per due sedute di fila (tre valori in crescita). */
function painRising(part) {
  const v = feelRows().map(x => x.feel[part]).filter(n => isFinite(n) && n !== null);
  if (v.length < 3) return false;
  const [a, b, c] = v.slice(-3);
  return c > b && b > a;
}
function lastPain(part) {
  const v = feelRows().map(x => x.feel[part]).filter(n => isFinite(n) && n !== null);
  return v.length ? v[v.length - 1] : null;
}
const KNEE_PATTERNS = ['squat', 'lunge', 'quadIso'];
const SHOULDER_PATTERNS = ['pushV', 'pushH', 'shoulderIso', 'pullV', 'pullup'];
const PAIN_NAME = { knee: 'Ginocchio', shoulder: 'Spalla' };
/* Distretto che un esercizio carica di più (null se nessuno dei due). */
function partOfEx(ex) {
  if (!ex) return null;
  if (KNEE_PATTERNS.includes(ex.pattern)) return 'knee';
  if (SHOULDER_PATTERNS.includes(ex.pattern) || ex.shoulderRisk) return 'shoulder';
  return null;
}
/* ---------------------------------------------------------------------------
   DOLORE E FASTIDIO (dalla 8.3)
   Si segna in tre momenti: durante un esercizio (pulsante nella seduta), a
   fine seduta (sensazioni) e in qualunque giorno da Oggi (per esempio la
   mattina dopo). Le soglie sono REGOLE OPERATIVE DELL'APP: la linea guida
   sulla tendinopatia della cuffia (Desmeules et al. 2025, JOSPT) chiede di
   adattare l'esercizio alla tolleranza al dolore senza fissare numeri, e nel
   dolore femoro-rotuleo lo studio di Esculier et al. 2018 (BJSM) usava un
   tetto di 2 su 10 per la corsa.
     0-3  lieve: si annota, si continua se non sale;
     4-6  moderato: serie rimanenti più leggere (circa −10% o un gradino più
          facile) e lo stesso esercizio parte più leggero la volta dopo;
     7-10 forte: stop all'esercizio (cambiarlo, chiuderlo o escluderlo per 2
          settimane); nella seduta successiva il distretto lavora solo con
          esercizi «amici» (come con le precauzioni accese) e carichi −10%.
   Un valore ≥5 a fine seduta o segnato da Oggi alleggerisce del 10% gli
   esercizi di quel distretto nella seduta successiva. Il registro del dolore
   (S.painLog) non si cancella mai.
--------------------------------------------------------------------------- */
var PAIN_LIGHT = 4, PAIN_STRONG = 7, PAIN_DISTRICT = 5;
function lastProgramSession() {
  const L = S.sessionLog || [];
  for (let i = L.length - 1; i >= 0; i--) {
    const x = L[i];
    if (x && isProgramKind(x.kind) && !x.planned && !/ignorata/.test(x.label || '')) return x;
  }
  return null;
}
/* Valore del distretto che conta per la prossima seduta: se dopo l'ultima
   seduta hai segnato il dolore da Oggi vale l'ultimo valore segnato; se no il
   più alto fra fine seduta e valori segnati durante la seduta. */
function districtPain(part) {
  const L = lastProgramSession();
  const log = (S.painLog || []).filter(p => p && p.part === part && isFinite(p.v));
  const after = log.filter(p => p.when === 'day' && p.ts > (L ? L.ts : 0));
  if (after.length) return { v: after[after.length - 1].v, src: 'segnato da Oggi' };
  if (!L) return null;
  const vals = [];
  if (L.feel && isFinite(L.feel[part]) && L.feel[part] !== null) vals.push({ v: L.feel[part], src: 'a fine seduta' });
  log.filter(p => p.when === 'set' && p.sid === L.sid).forEach(p => vals.push({ v: p.v, src: 'durante la seduta' }));
  if (!vals.length) return null;
  return vals.reduce((a, b) => b.v > a.v ? b : a);
}
/* Precauzioni temporanee decise dal dolore forte: valgono finché un nuovo
   valore più basso non le spegne. */
function painCare() {
  const k = districtPain('knee'), sh = districtPain('shoulder');
  return { knee: !!(k && k.v >= PAIN_STRONG), shoulder: !!(sh && sh.v >= PAIN_STRONG) };
}
function painSig() { const p = painCare(); return (p.knee ? 'k' : '') + (p.shoulder ? 's' : ''); }
/* Perché alleggerire un esercizio (null se non serve). */
function painInfo(ex, it) {
  if (!ex) return null;
  // dolore segnato oggi su questo esercizio
  if (it && it.pain && it.pain.v >= PAIN_LIGHT)
    return { part: it.pain.part, why: `${it.pain.v}/10 segnato in questa seduta` };
  // l'ultima volta questo esercizio ha dato dolore moderato o forte
  for (let i = (S.logs || []).length - 1; i >= 0; i--) {
    const l = S.logs[i];
    if (!l || l.exId !== ex.id || l.planned) continue;
    if (l.pain && l.pain.v >= PAIN_LIGHT) return { part: l.pain.part, why: `${l.pain.v}/10 l'ultima volta con questo esercizio` };
    break;
  }
  const part = partOfEx(ex);
  if (!part) return null;
  // nella seduta in corso un dolore forte alleggerisce tutto il distretto
  if (current && !current.finished && current.sess && current.sess.items.some(x => x.pain && x.pain.part === part && x.pain.v >= PAIN_STRONG))
    return { part, why: 'dolore forte segnato poco fa in questa seduta' };
  if (painRising(part)) return { part, why: 'dolore in aumento nelle ultime due sedute' };
  const d = districtPain(part);
  if (d && d.v >= PAIN_DISTRICT) return { part, why: `${d.v}/10 ${d.src}` };
  return null;
}
/* Compatibilità: distretto da alleggerire. */
function painPartFor(ex) { const p = painInfo(ex); return p ? p.part : null; }
/* Un passo più leggero: −10% sul carico (più assistenza se assistito) o un
   gradino più facile. */
function lighterValue(ex, value, it) {
  if (!ex || value === '' || value === null || value === undefined) return null;
  const steps = ex.load === 'band' ? BANDS : levelsOf(ex);
  if (steps) {
    if (it && it.level) return null;
    const i = steps.indexOf(value), j = i - progressDir(ex);
    return (i >= 0 && j >= 0 && j < steps.length) ? { value: steps[j], how: 'un gradino più facile' } : null;
  }
  if (ex.load !== 'weight') return null;
  const v = numLoad(value);
  if (!(v > 0)) return null;
  const nv = isAssist(ex) ? stepOnScale(ex, v, 1) : (rackOf(ex) ? Math.max(rackOf(ex)[0], snapLoad(ex, v * 0.9, -1)) : Math.floor(v * 0.9 * 2) / 2);
  if (nv === v) return null;
  return { value: String(nv % 1 === 0 ? nv : nv.toFixed(1)), how: isAssist(ex) ? 'più assistenza' : 'carico ridotto di circa il 10%' };
}
const PAIN_HINT = v => v === null || v === undefined ? 'Scegli un valore.'
  : v <= 3 ? 'Lieve: puoi continuare, se resta così e non sale.'
  : v < PAIN_STRONG ? 'Moderato: le serie che restano si alleggeriscono e la prossima volta l\'esercizio parte più leggero.'
  : 'Forte: fermati con questo esercizio. La prossima seduta il distretto lavora con esercizi più tollerabili e carichi più bassi. Se non passa in pochi giorni, senti il medico o il fisioterapista.';
/* Finestra per segnare il dolore. onSave(part, v). */
function openPainModal(opt) {
  const o = opt || {};
  let part = o.part || 'knee', val = null;
  openModal(`<h2>${esc(o.title || 'Dolore o fastidio')}</h2>
    <p class="small muted">${esc(o.sub || 'Dove e quanto: 0 nessun dolore, 10 il peggiore immaginabile.')}</p>
    <div class="seg" role="group" aria-label="Dove" style="margin-top:10px">
      <button data-ppart="knee" aria-pressed="${part === 'knee'}">Ginocchio</button>
      <button data-ppart="shoulder" aria-pressed="${part === 'shoulder'}">Spalla</button>
    </div>
    <div class="feelbtns painvals" style="margin-top:12px">${Array.from({ length: 11 }, (_, i) => `<button type="button" data-pv="${i}">${i}</button>`).join('')}</div>
    <p class="small" id="painHint" style="margin-top:10px">${PAIN_HINT(null)}</p>
    <p class="small muted">Soglie: regola operativa dell'app. Le linee guida chiedono di adattare l'esercizio alla tolleranza al dolore, senza numeri fissi.</p>
    <button class="btn" id="painOk" disabled style="margin-top:8px">Salva</button>
    <button class="btn ghost" id="painNo" style="margin-top:10px">Annulla</button>`);
  document.querySelectorAll('[data-ppart]').forEach(b => b.onclick = () => {
    part = b.dataset.ppart;
    document.querySelectorAll('[data-ppart]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  document.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => {
    val = +b.dataset.pv;
    document.querySelectorAll('[data-pv]').forEach(x => x.setAttribute('aria-pressed', String(+x.dataset.pv === val)));
    $('#painHint').textContent = PAIN_HINT(val);
    $('#painOk').disabled = false;
  });
  $('#painNo').onclick = () => closeModal();
  $('#painOk').onclick = () => { if (val === null) return; const p = part, v = val; closeModal(() => o.onSave && o.onSave(p, v)); };
}
/* Dolore segnato da Oggi, fuori dalla seduta. */
function recordDayPain(part, v) {
  S.painLog = Array.isArray(S.painLog) ? S.painLog : [];
  S.painLog.push({ ts: Date.now(), part, v, when: 'day' });
  planCache = null; save();
  const msg = v >= PAIN_STRONG ? 'la prossima seduta usa esercizi più tollerabili per questo distretto e carichi −10%'
    : v >= PAIN_DISTRICT ? 'la prossima seduta alleggerisce del 10% gli esercizi di questo distretto'
    : 'nessuna modifica: valore lieve';
  showToast(`<div><b>${PAIN_NAME[part]} ${v}/10</b> annotato: ${msg}.</div>`, 4200);
}
function feelSummary() {
  const rows = feelRows();
  if (!rows.length) return null;
  const last = rows[rows.length - 1].feel;
  const starsOf = x => { const ls = S.logs.filter(l => l.sid === x.sid && l.stars > 0); return ls.length ? ls.reduce((a, l) => a + l.stars, 0) / ls.length : null; };
  const withS = rows.map(x => ({ x, st: starsOf(x) })).filter(o => o.st !== null && isFinite(o.x.feel.sleep));
  let link = '';
  const lo = withS.filter(o => o.x.feel.sleep <= 2), hi = withS.filter(o => o.x.feel.sleep >= 4);
  if (lo.length >= 2 && hi.length >= 2) {
    const a = lo.reduce((s, o) => s + o.st, 0) / lo.length, b = hi.reduce((s, o) => s + o.st, 0) / hi.length;
    link = Math.abs(a - b) >= 0.3
      ? `Dopo le notti corte le stelle medie sono ${kg1(a)}, dopo quelle buone ${kg1(b)}: ${a < b ? 'il sonno pesa sulle tue sedute' : 'per ora il sonno non sembra pesare'}.`
      : `Stelle simili dopo notti corte (${kg1(a)}) e buone (${kg1(b)}): per ora il sonno non sembra fare differenza.`;
  }
  return { n: rows.length, last, link };
}
function feelPickerHtml() {
  const row = (key, label, from, to, hint) => `<div class="feelrow"><span class="lab">${label}<span class="small muted"> ${hint}</span></span>
    <div class="feelbtns" data-feel="${key}">${Array.from({ length: to - from + 1 }, (_, i) => `<button type="button" data-v="${from + i}">${from + i}</button>`).join('')}</div></div>`;
  return `<div class="feel">
    ${row('energy', 'Energia', 1, 5, '1 a terra · 5 al massimo')}
    ${row('sleep', 'Sonno della notte', 1, 5, '1 pessimo · 5 ottimo')}
    ${row('knee', 'Ginocchio', 0, 10, '0 nessun dolore · 10 il peggiore')}
    ${row('shoulder', 'Spalla', 0, 10, '0 nessun dolore · 10 il peggiore')}
  </div>`;
}
function bindFeelPicker(store) {
  document.querySelectorAll('[data-feel]').forEach(g => g.querySelectorAll('button').forEach(bt => bt.onclick = () => {
    const k = g.dataset.feel, v = +bt.dataset.v;
    store[k] = store[k] === v ? null : v;
    g.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(+x.dataset.v === store[k])));
  }));
}

/* ---------- riepilogo della settimana: cosa migliorare ---------- */
function weekAdvice(weekAbs) {
  const ana = volumeFor(weekAbs), a = aerobicMinutes(weekAbs), r = weekReport(weekAbs);
  const meta = sessionMeta(weekStart(weekAbs));
  const plan = plannedVolume(weekAbs), doneStr = strengthSessionsIn(weekAbs);
  if (painRising('knee')) return 'Ginocchio: il dolore è salito per due sedute di fila. La prossima settimana l\'app riduce del 10% i carichi su squat, affondi e leg extension; se continua a salire, senti il fisioterapista.';
  if (painRising('shoulder')) return 'Spalla: il dolore è salito per due sedute di fila. La prossima settimana l\'app riduce del 10% i carichi di spinte e tirate; se continua a salire, senti il fisioterapista.';
  if (!meta.mobilityWeek && plan.strength && doneStr < plan.strength && weekAbs < weekOfIdx(S.sessionIndex))
    return `Sono state fatte ${doneStr} sedute di forza su ${plan.strength}: la prossima settimana prova a completarle tutte, anche scegliendo 35 minuti invece di saltarle.`;
  const fs = feelRows().filter(x => x.idx != null && weekOfIdx(x.idx) === weekAbs && isFinite(x.feel.sleep));
  if (fs.length >= 2 && fs.reduce((s, x) => s + x.feel.sleep, 0) / fs.length <= 2.5)
    return 'Il sonno è stato scarso in quasi tutte le sedute: è la leva più semplice per allenarti meglio la prossima settimana.';
  if (!meta.mobilityWeek && a.eq < 150) return `Minuti aerobici ${a.eq} su 150: completa le due sedute aerobiche e, quando hai 50 minuti, lascia il finale metabolico.`;
  const low = (ana.low || []).filter(x => x.planned >= VOL_MIN);
  if (low.length && meta.profile.label !== 'Scarico') return `${low.map(x => x.group).join(', ')} sotto le ${VOL_MIN} serie: controlla gli esercizi chiusi in anticipo o sostituiti.`;
  if (r.avg && r.avg < 2.5) return 'Stelle sotto la media: tieni fermi i carichi e cura recupero e sonno, la progressione riparte da sola.';
  return 'Settimana completa: la prossima prova a guadagnare una ripetizione in più nell\'ultima serie dei fondamentali, con la stessa tecnica.';
}
function weekExtrasHtml(weekAbs) {
  const parts = [];
  if (S.pullupGoal) { const ps = pullStage(); if (ps) parts.push(`<p class="small"><b>Trazioni</b>: massimo ${ps.m} pulite di fila · tappa «${esc(ps.stage.label)}» · obiettivo ${pullTarget().n}.</p>`); }
  if (SP() && spPhase(Date.now()) !== 'off') {
    const t = ['pull', 'hang', 'burpee', 'run'].map(k => `${SP_NAMES[k]} ${spValueText(k, spMetric(k))}`).join(' · ');
    parts.push(`<p class="small"><b>Spartan Race</b> (${weeksToRace()} settimane): ${esc(t)}.</p>`);
  }
  const ms = (S.measures || []).filter(m => m && (m.waist || m.weight)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (ms.length) {
    const l = ms[ms.length - 1], f = ms.find(m => m.waist) || {};
    parts.push(`<p class="small"><b>Misure</b> (${dateIt(l.ts || Date.now())}): ${l.waist ? `girovita ${kg1(l.waist)} cm${f.waist && f !== l ? ` (${l.waist - f.waist >= 0 ? '+' : ''}${kg1(l.waist - f.waist)} dalla prima)` : ''}` : ''}${l.waist && l.weight ? ' · ' : ''}${l.weight ? `peso ${kg1(l.weight)} kg` : ''}.</p>`);
  } else parts.push('<p class="small muted"><b>Misure</b>: nessuna ancora. Girovita e peso si registrano in Progressi › Misure corporee.</p>');
  const fs = feelRows().filter(x => x.idx != null && weekOfIdx(x.idx) === weekAbs);
  if (fs.length) {
    const avg = k => { const v = fs.map(x => x.feel[k]).filter(n => isFinite(n) && n !== null); return v.length ? kg1(v.reduce((a, b) => a + b, 0) / v.length) : '—'; };
    parts.push(`<p class="small"><b>Sensazioni</b> (media di ${fs.length} sedute): energia ${avg('energy')} · sonno ${avg('sleep')} · ginocchio ${avg('knee')} · spalla ${avg('shoulder')}.</p>`);
  }
  return parts.join('');
}

/* Settimana da riassumere: quella in corso, o la precedente se è appena finita. */
function maybeSundayRecap() {
  const today = new Date();
  if (today.getDay() !== 0 || !(S.logs || []).length || S.sundayRecap === today.toDateString()) return false;
  if (current && !current.finished) return false;
  S.sundayRecap = today.toDateString(); save();
  openWeekReport(recapWeek());
  return true;
}
function recapWeek() {
  const w = weekOfIdx(S.sessionIndex);
  return posOfIdx(S.sessionIndex) === 0 && w > 1 ? w - 1 : w;
}
function weekRecapTile() {
  const w = recapWeek(), r = weekReport(w);
  return `<div class="dstat">Settimana ${w}</div>
    <p class="small">${r.sessions} sedute · ${r.avg ? kg1(r.avg) + ' stelle medie' : 'stelle non ancora disponibili'} · ${aerobicMinutes(w).eq} minuti aerobici</p>
    <p class="small muted">${esc(weekAdvice(w))}</p>`;
}
function recordsTile() {
  const list = recordsList(), recent = S.logs.filter(l => l.pr).slice(-3).reverse();
  return `<div class="dstat">${recent.length ? `${recent.length === 1 ? 'Ultimo' : 'Ultimi'} record` : list.length + ' esercizi con un migliore'}</div>
    ${recent.length ? recent.map(l => `<p class="small">🏆 ${esc(l.name)} · ${esc(l.pr)}</p>`).join('') : '<p class="small muted">Quando superi il tuo massimo, il record compare qui e in seduta.</p>'}`;
}
function e1rmTile() {
  const lifts = keyLifts();
  if (!lifts.length) return '<div class="dstat">Ancora pochi dati</div><p class="small muted">Servono due sedute con il carico annotato sui fondamentali.</p>';
  const up = lifts.filter(x => { const t = trendLine(x.pts); return t && t.b > 0; }).length;
  return `<div class="dstat">${up} di ${lifts.length} in crescita</div><p class="small muted">Grafico per ogni fondamentale, con la linea di tendenza.</p>`;
}
function feelTile() {
  const d = durationStats(), f = feelSummary();
  const dTxt = d.length ? d.map(x => `${x.budget}′: ${x.real}′ reali${x.diff ? ` (${x.diff > 0 ? '+' : ''}${x.diff}′)` : ''}`).join(' · ') : 'durata reale: servono sedute chiuse con la versione 8';
  const pain = painRising('knee') || painRising('shoulder');
  return `<div class="dstat${pain ? ' todo' : ''}">${pain ? 'Dolore in aumento' : f ? 'Energia ' + (f.last.energy || '—') + ' · sonno ' + (f.last.sleep || '—') : 'Nessuna sensazione registrata'}</div>
    <p class="small">${esc(dTxt)}</p>
    <p class="small muted">${f ? `Ultima seduta: ginocchio ${f.last.knee ?? '—'}/10 · spalla ${f.last.shoulder ?? '—'}/10` : 'Energia, sonno e dolore si indicano a fine seduta.'}</p>`;
}
function openFeel() {
  const d = durationStats(), f = feelSummary(), rows = feelRows().slice(-10).reverse();
  const dRows = d.map(x => `<li><div class="nm" style="flex:1"><b>Sedute da ${x.budget}′</b>
      <div class="small">${x.real}′ reali contro ${x.est}′ stimati (${x.diff > 0 ? '+' : ''}${x.diff}′) · ${x.n} sedute</div>
      <div class="small muted">${x.diff >= 5 ? 'Il tempo si perde soprattutto nei cambi fra gli esercizi e nei recuperi allungati: con le superserie a 35′ e «Macchina occupata» si recupera qualcosa. La stima intanto impara dal tuo ritmo.' : x.diff <= -5 ? 'Finisci prima del previsto: puoi scegliere una durata più lunga e lasciare entrare supplementari e finale.' : 'Stima e realtà coincidono.'}</div></div></li>`).join('');
  const fRows = rows.map(x => `<li><div class="nm" style="flex:1"><b>${dateIt(x.ts)}</b> · ${esc(sessLabel(x))}
      <div class="small muted">energia ${x.feel.energy ?? '—'} · sonno ${x.feel.sleep ?? '—'} · ginocchio ${x.feel.knee ?? '—'}/10 · spalla ${x.feel.shoulder ?? '—'}/10</div></div></li>`).join('');
  const painTxt = ['knee', 'shoulder'].filter(painRising).map(p => `<div class="notice" style="margin-top:10px">${p === 'knee' ? 'Ginocchio' : 'Spalla'}: dolore salito per due sedute di fila. Nelle prossime sedute l'app propone carichi ridotti di circa il 10% (o un gradino più facile) su ${p === 'knee' ? 'squat, affondi e leg extension' : 'spinte, alzate e tirate'}, finché il dolore non smette di salire. Se continua, senti il fisioterapista.</div>`).join('');
  openModal(`<h2>Durata, sensazioni e dolore</h2>
    ${painTxt}
    <h3>Durata reale e stimata</h3>
    <ul class="hist">${dRows || '<li class="small muted">Serve qualche seduta chiusa con questa versione: la stima viene salvata a fine seduta.</li>'}</ul>
    <h3>Sensazioni a fine seduta</h3>
    ${f && f.link ? `<p class="small">${esc(f.link)}</p>` : '<p class="small muted">Con qualche seduta in più l\'app confronta le stelle delle sedute dopo notti corte e dopo notti buone.</p>'}
    <ul class="hist">${fRows || '<li class="small muted">Nessuna ancora: le indichi nella schermata di fine seduta.</li>'}</ul>
    <p class="small muted" style="margin-top:10px">Il dolore si annota da 0 a 10. «In aumento» vuol dire tre valori di fila in crescita. Regola operativa dell'app, nello spirito delle linee guida: per il dolore femoro-rotuleo e la tendinopatia della cuffia l'esercizio va adattato alla tolleranza (Willy et al. 2019; Desmeules et al. 2025).</p>
    <button class="btn secondary" id="flClose" style="margin-top:12px">Chiudi</button>`);
  $('#flClose').onclick = () => closeModal();
}

function renderProg() {
  $('#topTitle').textContent = 'Progressi';
  $('#topChip').textContent = `${S.logs.length} esercizi registrati`;
  $('#topChip').className = 'chip';

  const path = pathStatus(), ph = path.meta.phase;
  const t = trendFor();
  const b = bodyProjection();
  const trendWord = t.recent && t.before ? (t.recent > t.before + 0.2 ? 'in miglioramento' : t.recent < t.before - 0.2 ? 'in calo' : 'stabile') : '';

  const pBody = `<div class="dstat">${ph ? esc(ph.ph.name) : esc(path.p.name)}</div>
    <p class="small">${whereText(path.meta, { cap: true })}${ph ? ` · ${ph.weekInPhase}ª settimana della fase su ${ph.ph.weeks}` : ''}${path.meta.mobilityWeek ? ' · sola mobilità' : ''}</p>
    <div class="dbar"><i style="width:${path.pct}%"></i></div>
    <p class="small muted">${path.weeksLeft} settimane alla fine · ${dateIt(path.end)}</p>`;

  const eBody = t.n
    ? `<div class="dstat">${t.up} in crescita</div>
       <div class="dsplit"><span class="up" style="flex:${t.up || 0.001}"></span><span class="flat" style="flex:${t.flat || 0.001}"></span><span class="down" style="flex:${t.down || 0.001}"></span></div>
       <p class="small">${t.up} in crescita · ${t.flat} stabili · ${t.down} in calo (ultime 8 settimane)</p>
       ${t.recent ? `<p class="small muted">Media stelle ultime 2 settimane ${kg1(t.recent)}${trendWord ? ' · ' + trendWord : ''}</p>` : ''}`
    : `<div class="dstat">Ancora pochi dati</div><p class="small muted">Servono almeno due sedute per esercizio per vedere la tendenza.</p>`;
  const eNote = epochNote() ? `<p class="small muted">${esc(epochNote())}</p>` : '';

  const bBody = (b.lastW || b.lastC)
    ? `<div class="dstat">${b.lastC ? kg1(b.lastC.waist) + ' cm' : ''}${b.lastC && b.lastW ? ' · ' : ''}${b.lastW ? kg1(b.lastW.weight) + ' kg' : ''}</div>
       <p class="small">Obiettivo ragionevole al ${dateIt(b.end)}: ${b.waist ? `girovita circa ${kg1(b.waist.to)} cm` : 'girovita da stimare (servono due misure a 2 settimane)'}${b.weight ? `, peso ${kg1(b.weight.lo)}-${kg1(b.weight.hi)} kg` : ''}.</p>`
    : `<div class="dstat todo">Nessuna misura</div><p class="small muted">Registra girovita e peso: da lì l'app stima l'obiettivo a fine piano.</p>`;

  const aero = aerobicMinutes(weekOfIdx(S.sessionIndex));
  const vBody = `<div class="dstat">Settimana ${weekOfIdx(S.sessionIndex)}</div>
    <p class="small">${aero.eq} minuti aerobici equivalenti su 150</p>
    <p class="small muted">Serie per gruppo muscolare, riepiloghi settimanali, carichi esercizio per esercizio e ultime sedute.</p>`;

  const tile = (id, kicker, body) => `<button class="dtile" data-prog="${id}">
      <div class="kicker">${kicker}</div>${body}<span class="chev">›</span></button>`;
  $('#view-prog').innerHTML = `
    ${tile('path', 'Il percorso', pBody)}
    ${tile('upcoming', 'Le prossime settimane', `<div class="dstat">Cosa ti aspetta</div>
      <p class="small muted">Tipo di seduta giorno per giorno, con fasi, scarichi e settimane di sola mobilità.</p>`)}
    ${SP() && (S.spartan !== false || spPhase(Date.now()) !== 'off') ? tile('spartan', 'Spartan Race · Sprint di Orte', spartanTileBody()) : ''}
    ${S.pullupGoal ? tile('pull', 'Trazioni e muscle-up', pullTileBody()) : ''}
    ${tile('week', 'Riepilogo della settimana', weekRecapTile())}
    ${tile('trend', 'Progressione negli esercizi', eBody + eNote)}
    ${tile('records', 'Record personali', recordsTile())}
    ${tile('e1rm', 'Massimale stimato', e1rmTile())}
    ${tile('feel', 'Durata, sensazioni e dolore', feelTile())}
    ${tile('body', 'Misure corporee', bBody)}
    ${tile('history', 'Volume e storico', vBody)}`;

  document.querySelectorAll('[data-prog]').forEach(el => el.onclick = () => {
    const k = el.dataset.prog;
    if (k === 'path') openPath();
    else if (k === 'upcoming') openUpcoming();
    else if (k === 'pull') openPullGoal();
    else if (k === 'spartan') openSpartan();
    else if (k === 'week') openWeekReport(recapWeek());
    else if (k === 'records') openRecords();
    else if (k === 'e1rm') openE1rm();
    else if (k === 'feel') openFeel();
    else if (k === 'trend') { go('history'); scrollToId('loadsCard'); }
    else if (k === 'body') { go('history'); scrollToId('bodyCard'); }
    else go('history');
  });
}

/* ---------------------------------------------------------------------------
   OBIETTIVO TRAZIONI E MUSCLE-UP (dalla 6.4)
   Riquadro in Progressi e scheda di dettaglio: massimo attuale e da dove
   viene, tappa del blocco trazioni e criterio per la successiva, ritmo che
   serve per arrivare all'obiettivo, test registrati, aggiornamento a mano del
   massimo (per esempio dopo una prova fuori programma).
--------------------------------------------------------------------------- */
function pullTarget() {
  const t = (PROG.pullupBlock && PROG.pullupBlock.target) || {};
  return { n: t.pullups || 15, mu: t.muscleUps || 2 };
}
function pullTileBody() {
  const ps = pullStage(), t = pullTarget();
  if (!ps) return '<p class="small muted">Blocco trazioni non configurato.</p>';
  const pct = Math.min(100, Math.round((Math.min(ps.m, t.n) / t.n * 0.6 + Math.min(ps.mu, t.mu) / t.mu * 0.4) * 100));
  return `<div class="dstat">${ps.m} ${ps.m === 1 ? 'trazione' : 'trazioni'} · ${ps.mu} muscle-up</div>
    <div class="dbar"><i style="width:${pct}%"></i></div>
    <p class="small">Obiettivo: ${t.n} trazioni pulite di fila e ${t.mu} muscle-up · tappa: ${esc(ps.stage.label)}</p>`;
}
function openPullGoal() {
  const ps = pullStage(), t = pullTarget(), path = pathStatus();
  if (!ps) return;
  const pm = pullMax(), mm = muMax();
  // la data dell'obiettivo è quella fissa del programma, non la fine stimata
  const goalEnd = path.p.target ? new Date(path.p.target + 'T12:00:00') : path.end;
  const weeksToGoal = Math.max(1, Math.round((goalEnd - Date.now()) / (7 * 864e5)));
  const srcTxt = r => r.src === 'nessuno' ? 'nessun dato ancora'
    : `${r.src === 'test' ? 'test' : r.src === 'serie' ? 'serie registrata' : 'valore inserito da te'} del ${dateIt(r.ts)}`;
  const weeks = weeksToGoal;
  const perMonth = Math.max(0, (t.n - ps.m) / weeks * 4);
  const next = ps.next;
  let nextTxt = '';
  if (ps.blocked) nextTxt = `<p class="small"><b>${esc(ps.blocked.label)}</b> ti spetterebbe già, ma resta chiusa perché in <i>Programma</i> è attiva «evita gli esercizi dolorosi per la spalla». Il muscle-up è fra i gesti ginnici più spesso indicati come causa di infortuni alla spalla, e in quasi quattro casi su dieci si trattava di un problema già presente. Togli la spunta solo se trazioni, trazioni al petto e dip non ti danno dolore, meglio dopo una valutazione del fisioterapista.</p>`;
  else if (next) nextTxt = `<p class="small">Tappa successiva, <b>${esc(next.label)}</b>: ${next.minMu ? 'il primo muscle-up completo' : `${next.min} trazioni pulite di fila`}${next.needsShoulder ? ', senza dolore alla spalla' : ''}.</p>`;
  const tests = S.logs.filter(l => l.goal === 'pullupTest' || l.goal === 'muTest').slice(-8).reverse();
  const testRows = tests.length ? `<ul class="small">${tests.map(l => `<li>${dateIt(l.ts)} · ${l.goal === 'muTest' ? 'muscle-up' : 'trazioni'}: <b>${bestRepsOf(l)}</b></li>`).join('')}</ul>`
    : '<p class="small muted">Nessun test ancora: il primo cade nella prima settimana del prossimo blocco, subito dopo lo scarico, in Forza A.</p>';
  openModal(`<h2>Trazioni e muscle-up</h2>
    <p class="small muted">Obiettivo al ${dateIt(goalEnd)}: <b>${t.n} trazioni pulite di fila</b> e <b>${t.mu} muscle-up</b>.</p>
    <div class="card" style="margin:10px 0">
      <div class="dstat">${ps.m} ${ps.m === 1 ? 'trazione' : 'trazioni'} · ${ps.mu} muscle-up</div>
      <p class="small muted">Trazioni: ${srcTxt(pm)}. Muscle-up: ${srcTxt(mm)}.</p>
      <p class="small">Tappa attuale: <b>${esc(ps.stage.label)}</b> — ${esc(ps.stage.why)}</p>
      ${nextTxt}
      <p class="small muted">Per arrivare a ${t.n} servono in media circa ${kg1(perMonth)} ripetizioni in più ogni quattro settimane, per ${weeks} settimane. È un obiettivo ambizioso: negli adulti già allenati studiati da Sánchez-Moreno e colleghi le ripetizioni massime sono salite del 15% in 12 settimane; chi parte da poche ripetizioni di solito progredisce più in fretta in proporzione, ma non esistono dati su adulti di 50 anni che permettano una previsione affidabile. Il test mensile dirà se il ritmo regge.</p>
    </div>
    <h3>Test registrati</h3>${testRows}
    <h3>Aggiorna il massimo</h3>
    <p class="small muted">Se hai provato fuori programma, inserisci quante ripetizioni pulite di fila hai fatto: il blocco trazioni si adegua da subito. Le registrazioni non vengono toccate.</p>
    <div class="row" style="gap:8px;margin:6px 0">
      <label class="small">Trazioni <input id="pmN" type="number" inputmode="numeric" min="0" max="40" value="${ps.m}" style="width:70px"></label>
      <label class="small">Muscle-up <input id="pmMu" type="number" inputmode="numeric" min="0" max="30" value="${ps.mu}" style="width:70px"></label>
    </div>
    <button class="btn" id="pmSave">Salva il massimo</button>
    <p class="small muted" style="margin-top:12px">Fonti: Sánchez-Moreno et al. 2020, J Strength Cond Res 34(4):911-917 (serie con fatica moderata); Sánchez-Moreno et al. 2017, Int J Sports Physiol Perform 12(10):1378-1384; Walker et al. 2023, Int J Exerc Sci 16(1):1451-1460 (muscle-up: prima la sbarra); McKenzie et al. 2022, IJERPH 19(21):14390 (dip); Summitt et al. 2016, Sports Health 8(6):541-546 (spalla); Desmeules et al. 2025, JOSPT 55(4):235-274. Le soglie delle tappe sono regole operative dell'app.</p>
    <button class="btn secondary" id="pmClose" style="margin-top:10px">Chiudi</button>`);
  $('#pmClose').onclick = () => closeModal();
  $('#pmSave').onclick = () => {
    const n = Math.round(+$('#pmN').value), mu = Math.round(+$('#pmMu').value);
    if (!isFinite(n) || n < 0 || n > 40 || !isFinite(mu) || mu < 0 || mu > 30) return;
    S.pullSelf = { n, mu, ts: Date.now() };
    planCache = null; save(); closeModal(); renderProg();
  };
}

/* ---------------------------------------------------------------------------
   SPARTAN RACE IN OGGI E IN PROGRESSI (dalla 7S 0)
   In Oggi: il promemoria «Spartan Race check» quando la seduta del giorno (o
   la prossima, se quella di oggi è già fatta) contiene un check, la domanda
   sul ginocchio il giorno dopo una corsa e l'avviso della settimana della
   gara. In Progressi: riquadro con i quattro traguardi e scheda completa
   (check in calendario, ostacoli, corse, aggiornamento a mano).
--------------------------------------------------------------------------- */
const SP_NAMES = { pull: 'Trazioni', hang: 'Sospensione', burpee: 'Burpees', run: 'Corsa-camminata' };
function spValueText(kind, m) {
  if (kind === 'pull') return `${m.n} di ${m.T}`;
  if (kind === 'hang') return `${m.show != null ? m.show : m.n} s di ${m.T}`;
  if (kind === 'burpee') return `${m.show != null ? m.show : m.n} di ${m.T}`;
  return spPhase(Date.now()) === 'base' ? 'da dicembre' : `livello ${m.n + 1} di ${m.T + 1}`;
}
function spPct(kind, m) {
  if (kind === 'run') return m.rs.runs.length || m.n ? Math.round(m.n / Math.max(1, m.T) * 100) : 0;
  if (kind === 'burpee') {
    const b = m.b, v = m.show != null ? m.show : m.n, part = Math.min(1, v / m.T);
    return Math.round((b.L >= b.maxL ? part : (b.L + Math.min(1, v / (b.next || m.T))) / (b.maxL + 1)) * 100);
  }
  return Math.round(Math.min(1, (m.show != null ? m.show : m.n) / m.T) * 100);
}
function kneeAskHtml(r) {
  return `<div class="card spcard" id="kneeCard">
    <div class="kicker">Spartan · ginocchio dopo la corsa</div>
    <h3 style="margin:4px 0 6px">Com'è andata la corsa-camminata di ${esc(new Date(r.ts).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }))}?</h3>
    <p class="small muted">Da questa risposta dipende il livello della prossima corsa (criteri di Esculier et al. 2018).</p>
    <div class="spknee">
      <button class="btn ghost" data-knee="0">Tutto tranquillo: durante al massimo 2 su 10, passato entro un'ora, stamattina come prima</button>
      <button class="btn ghost" data-knee="1">Più di 2 su 10, o più di un'ora per passare, ma stamattina come prima</button>
      <button class="btn ghost" data-knee="2">Stamattina il ginocchio va peggio del solito</button>
    </div>
    <label class="small" style="display:flex;align-items:center;gap:8px;margin-top:10px">Distanza dal Garmin (facoltativa)
      <input id="kneeKm" type="text" inputmode="decimal" placeholder="km" style="width:80px"></label>
  </div>`;
}
function bindKneeAsk(after) {
  document.querySelectorAll('[data-knee]').forEach(b => b.onclick = () => {
    const rs = runState(), r = rs.pending;
    if (!r) return;
    const km = parseFloat(String(($('#kneeKm') || {}).value || '').replace(',', '.'));
    r.knee = +b.dataset.knee;
    r.kneeTs = Date.now();
    if (isFinite(km) && km > 0 && km <= 50) r.km = Math.round(km * 100) / 100;
    planCache = null; save();
    const now = runState();
    const msg = r.knee === 0
      ? (r.full && !r.light ? `Bene: la prossima corsa sale al livello ${now.L + 1} di ${now.max + 1}.` : `Bene. Il livello resta ${now.L + 1}: la corsa non era completa o era una settimana leggera.`)
      : r.knee === 1 ? `Il livello resta ${now.L + 1}: si ripete finché il ginocchio non resta tranquillo.`
      : `La prossima corsa torna al livello ${now.L + 1}. Se preferisci, quel giorno scegli la bici con «Cambia attrezzo».${now.worse >= 2 ? ' È la seconda volta di fila: fermati con la corsa e senti il fisioterapista prima di riprendere.' : ''}`;
    openModal(`<h2>Ginocchio registrato</h2><p>${esc(msg)}</p><button class="btn" id="kaOk" style="margin-top:12px">Ok</button>`);
    $('#kaOk').onclick = () => closeModal(after);
  });
}
/* Riquadro per Oggi: domanda sul ginocchio, check della seduta, settimana della gara. */
function spartanTodayHtml(s) {
  if (!spOn()) return '';
  let html = '';
  const rs = runState();
  if (rs.pending) html += kneeAskHtml(rs.pending);
  const ph = spPhase(Date.now());
  if (ph === 'race') html += `<div class="card spcard"><div class="kicker">Spartan Race · ${esc(SP().place || '')}</div>
      <h3 style="margin:4px 0 6px">È la settimana della gara</h3>
      <p class="small">Sedute più leggere e nessun check: arrivi riposato. Il giorno della gara e quello prima, salta pure la seduta prevista («Non la faccio: salta»). Obiettivo: divertirti e superare gli ostacoli in sicurezza, con calma; il giavellotto lo salti e fai i 30 burpees.</p></div>`;
  if (s && s.items) {
    const checks = s.items.filter(it => it.spCheck);
    if (checks.length) {
      const doneToday = (S.sessionLog || []).some(y => isProgramKind(y.kind) && sameDay(y.ts, Date.now()));
      html += `<div class="card spcard">
        <div class="kicker">${doneToday ? 'Nella prossima seduta' : 'Oggi'} · ${esc(s.label)}</div>
        ${checks.map(it => `<p class="spcheck"><b>${esc(it.note.split(' · usa')[0])}</b></p>`).join('')}
        <p class="small muted">Riscaldati bene e misura con calma: ti fermi quando la forma si sporca. Il risultato aggiorna i traguardi in Progressi.</p></div>`;
    }
  }
  if (rs.worse >= 2 && (ph === 'run' || ph === 'race')) html += `<div class="notice" style="margin-top:12px">Il ginocchio è peggiorato dopo due corse di fila: sospendi la corsa (nella seduta di corsa scegli la bici con «Cambia attrezzo») e senti il fisioterapista prima di riprendere.</div>`;
  return html;
}

function spartanTileBody() {
  const sp = SP();
  const ph = spPhase(Date.now());
  if (ph === 'off') return `<div class="dstat">${S.spartan === false ? 'Preparazione spenta' : 'Gara passata'}</div>
      <p class="small muted">${S.spartan === false ? 'La riattivi in Impostazioni.' : `La Sprint di ${esc(sp.place)} era il ${spDateText()}: il piano è tornato quello di prima.`}</p>`;
  const rows = ['pull', 'hang', 'burpee', 'run'].map(k => {
    const m = spMetric(k);
    return `<div class="sprow"><span>${SP_NAMES[k]}</span><div class="dbar sp"><i style="width:${spPct(k, m)}%"></i></div><b>${spValueText(k, m)}</b></div>`;
  }).join('');
  const next = spCheckPlan()[0];
  return `<div class="dstat">${weeksToRace()} settimane alla gara</div>
    <p class="small">Sprint di ${esc(sp.place)}, ${spDateText()} · ${sp.distanceKm} km e ${sp.obstacles} ostacoli</p>
    ${rows}
    <p class="small muted" style="margin-top:8px">${next ? `Prossimo Spartan Race check: ${dateIt(next.date)} · ${SP_NAMES[next.kind].toLowerCase()}` : 'Nessun altro check prima della gara.'}</p>`;
}

/* Stato di ciascun ostacolo rispetto ai traguardi raggiunti. */
function spObstacleStatus(keys) {
  if (!keys || !keys.length) return { cls: 'tip', txt: 'consiglio' };
  const rank = k => {
    if (k === 'carry') {
      const logs = S.logs.filter(l => (SP().carries || []).includes(l.exId) && !l.planned);
      const heavy = logs.some(l => numLoad(l.load) >= (l.exId === 'g_farmercarry' ? 20 : 26));
      return heavy ? 2 : logs.length ? 1 : 0;
    }
    const m = spMetric(k);
    if (k === 'run') return m.n >= m.T ? 2 : m.n >= m.T - 2 ? 1 : 0;
    if (k === 'burpee') return m.b.L >= m.b.maxL && m.n >= m.T ? 2 : m.n >= 20 ? 1 : 0;
    const q = k === 'pull' ? 5 : 40;
    return m.n >= m.T ? 2 : m.n >= q ? 1 : 0;
  };
  const r = Math.min(...keys.map(rank));
  return r === 2 ? { cls: 'ok', txt: 'pronto' } : r === 1 ? { cls: 'mid', txt: 'quasi' } : { cls: 'todo', txt: 'in corso' };
}

function openSpartan() {
  const sp = SP();
  if (!sp) return;
  const ph = spPhase(Date.now());
  const srcTxt = m => {
    const src = m.srcShow || m.src, ts = m.tsShow || m.ts;
    if (src === 'nessuno' || !src) return 'nessun dato ancora';
    return `${src === 'test' ? 'check' : src === 'serie' ? 'serie migliore registrata' : 'valore inserito da te'} del ${dateIt(ts)}${
      m.fromDeload ? ' (in settimana di scarico: lo vedi qui, ma per regola non entra nei conteggi della progressione né nelle dosi)' : ''}`;
  };
  const mP = spMetric('pull'), mH = spMetric('hang'), mB = spMetric('burpee'), mR = spMetric('run');
  const b = mB.b, rs = mR.rs;
  const goalRow = (k, m, extra) => `<li><div class="nm" style="flex:1"><b>${SP_NAMES[k]}</b> · ${spValueText(k, m)}
      <div class="dbar sp"><i style="width:${spPct(k, m)}%"></i></div>
      <div class="small muted">${extra}</div></div></li>`;
  const plan = spCheckPlan();
  const planRows = plan.length ? plan.slice(0, 16).map(c => `<li><div class="nm" style="flex:1"><span class="small muted">${dateIt(c.date)} · ${esc(dayLabel(sessionMeta(c.idx)))}</span>
      <div class="small">${esc(spCheckLabel(c.kind, c.goal, c.first))}</div></div></li>`).join('')
    : '<li><div class="small muted">Nessun check fino alla gara.</div></li>';
  const obs = (sp.obstacles_list || []).map(o => {
    const st = spObstacleStatus(o.keys);
    return `<li><div class="nm" style="flex:1"><b>${esc(o.name)}</b> <span class="sptag ${st.cls}">${st.txt}</span>
      <div class="small muted">${esc(o.need)}${o.tip ? ' · ' + esc(o.tip) : ''}</div></div></li>`;
  }).join('');
  const runRows = rs.runs.slice(-6).reverse().map(r => `<li><div class="nm" style="flex:1">${dateIt(r.ts)} · livello ${(r.level || 0) + 1}${r.full ? '' : ' (non completa)'}${r.light ? ' · leggera' : ''}${r.check ? ' · check' : ''}
      <div class="small muted">Ginocchio: ${r.knee === 0 ? 'tranquillo' : r.knee === 1 ? 'oltre 2/10 o lento a passare' : r.knee === 2 ? 'peggio la mattina dopo' : 'risposta mancante'}${isFinite(r.km) && r.km ? ` · ${String(r.km).replace('.', ',')} km` : ''}</div></div></li>`).join('');
  const runFrom = isoNoon(sp.runFrom);
  openModal(`<h2>Spartan Race · Sprint di ${esc(sp.place)}</h2>
    <p class="small muted">${spDateText()} · ${sp.distanceKm} km e ${sp.obstacles} ostacoli · ${weeksToRace()} settimane.</p>
    <p class="small">${esc(sp.aim)}</p>
    ${ph === 'off' ? `<p class="notice">${S.spartan === false ? 'Preparazione spenta: la riattivi in Impostazioni.' : 'La gara è passata: il piano è tornato quello di prima.'}</p>` : ''}

    <h3>Traguardi per la gara</h3>
    <ul class="hist">
      ${goalRow('pull', mP, `Traguardo ${mP.T} trazioni pulite di fila (fune, muri, Hercules hoist) · ${srcTxt(mP)}. L'obiettivo del programma resta ${pullTarget().n} a fine maggio.`)}
      ${goalRow('hang', mH, `Traguardo ${mH.T} secondi appeso con le spalle attive (monkey bars, multi-rig) · ${srcTxt(mH)}.`)}
      ${goalRow('burpee', mB, `Traguardo ${mB.T} di fila in forma corretta, la penalità del giavellotto e di ogni ostacolo fallito. Livello «${esc(b.level)}»${b.byChoice ? ', scelto da te in seduta' + (S.kneeCare ? ' (con la priorità al ginocchio l\'app non lo proporrebbe da sola)' : '') : ''}${b.L < b.maxL ? `: con ${b.next} di fila passi al livello successivo` : ''}${b.capped && !b.byChoice ? '. Il livello regolamentare, con il salto, l\'app non lo propone da sola finché è attiva la priorità al ginocchio: puoi sceglierlo tu nel menu del livello, meglio sentito il fisioterapista' : ''}. Conta la serie migliore di fila, non il totale della seduta; una serie a un livello più difficile vale anche per quelli più facili · ${srcTxt(mB)}.`)}
      ${goalRow('run', mR, ph === 'base' ? `Dal ${dateIt(runFrom)} la seduta a ritmo costante diventa corsa-camminata all'aperto, una volta a settimana. Traguardo: ${runSpecText(rs.levels[rs.max])}, circa ${sp.targets.runKm} km per chi corre piano.`
        : `Ora: ${runSpecText(rs.spec)}. Traguardo: ${runSpecText(rs.levels[rs.max])}, circa ${sp.targets.runKm} km${rs.km ? ` · distanza migliore registrata ${String(rs.km).replace('.', ',')} km` : ''}. Il livello sale solo se il giorno dopo il ginocchio è tranquillo.`)}
    </ul>

    <h3>Spartan Race check in calendario</h3>
    <p class="small muted">Nella prima settimana di ogni blocco, subito dopo lo scarico. Le date sono stimate: si spostano se salti sedute o fai una settimana di sola mobilità. L'obiettivo di ogni check divide in parti uguali la strada che manca al traguardo.</p>
    <ul class="hist">${planRows}</ul>

    <h3>Come cambia il piano</h3>
    <ul class="small" style="padding-left:18px">
      <li><b>Forza A, B e C</b>: invariate. Il test delle trazioni in Forza A, fino alla gara, è anche lo Spartan Race check.</li>
      <li><b>Seduta a intervalli</b>: dopo il riscaldamento, a fresco, burpees per livelli e sospensione alla sbarra${S.setup === 'gym' ? '' : ' (a casa solo burpees)'}; dal ${dateIt(runFrom)} anche un trasporto (contadino o in abbraccio, a settimane alterne). Poi gli scatti, nel tempo che resta.</li>
      <li><b>Seduta a ritmo costante</b>: dal ${dateIt(runFrom)} corsa-camminata all'aperto, una volta a settimana, con il timer che suona ai cambi. Se piove o il ginocchio protesta, «Cambia attrezzo» riporta la bici.</li>
      <li><b>Settimane di scarico</b>: blocco Spartan e corsa più corti, nessun aumento di livello.</li>
      <li><b>Settimana della gara</b>: tutto leggero, nessun check. Dopo la gara il piano torna com'era.</li>
      <li>Le serie del blocco Spartan non contano nel volume dei gruppi muscolari: sono condizionamento.</li>
    </ul>

    <h3>Gli ostacoli</h3>
    <ul class="hist">${obs}</ul>

    ${rs.runs.length ? `<h3>Corse registrate</h3><ul class="hist">${runRows}</ul>` : ''}
    ${rs.pending ? kneeAskHtml(rs.pending) : ''}

    <h3>Aggiorna a mano</h3>
    <p class="small muted">Se hai provato fuori programma: secondi di sospensione e burpees di fila in forma corretta. Le registrazioni non vengono toccate.</p>
    <div class="row" style="gap:8px;margin:6px 0;flex-wrap:wrap">
      <label class="small">Sospensione (s) <input id="spH" type="number" inputmode="numeric" min="0" max="600" value="${mH.n || ''}" style="width:70px"></label>
      <label class="small">Burpees <input id="spB" type="number" inputmode="numeric" min="0" max="200" value="${mB.n || ''}" style="width:70px"></label>
      <label class="small">Livello <select id="spBL">${b.levels.map((x, i) => `<option value="${i}" ${i === b.L ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
    </div>
    <button class="btn" id="spSave">Salva</button>
    <p class="small muted" style="margin-top:12px">Fonti: ${esc((sp.sources || []).join(' · '))}. Traguardi, livelli e dosi del blocco Spartan sono regole operative dell'app.</p>
    <button class="btn secondary" id="spClose" style="margin-top:10px">Chiudi</button>`);
  bindKneeAsk(() => openSpartan());
  $('#spClose').onclick = () => closeModal();
  $('#spSave').onclick = () => {
    const h = Math.round(+$('#spH').value), bn = Math.round(+$('#spB').value), bl = Math.round(+$('#spBL').value);
    if (!isFinite(h) || h < 0 || h > 600 || !isFinite(bn) || bn < 0 || bn > 200 || !isFinite(bl) || bl < 0 || bl >= b.levels.length) return;
    S.spSelf = { hang: h, burpee: bn, burpeeLevel: bl, ts: Date.now() };
    planCache = null; save(); closeModal(); renderProg();
  };
}

function scrollToId(id) {
  requestAnimationFrame(() => { const el = document.getElementById(id); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}

/* ---------------------------------------------------------------------------
   LE PROSSIME SETTIMANE (dalla 5.8)
   Che cosa mi aspetta: per ogni giorno il tipo di seduta e il suo schema
   (Forza A, Aerobico a intervalli, Mobilità…), con la fase e le settimane di
   scarico o di sola mobilità già segnalate. Le etichette si leggono dal
   programma senza generare le sedute: l'elenco resta immediato anche per
   dieci settimane.
--------------------------------------------------------------------------- */
function dayLabel(meta) {
  const p = meta.program;
  if (meta.mobilityWeek) return ((p.stretchDays || [])[meta.tmplIdx] || {}).label || 'Mobilità';
  if (meta.isStrength) return ((p.strengthDays || [])[meta.tmplIdx] || {}).label || 'Potenziamento';
  if (meta.isCardio) {
    // (7S 0) preparazione Spartan: corsa-camminata e burpees
    if (runDay(meta)) return 'Corsa-camminata · Spartan';
    const base = ((PROG.cardioDays || [])[meta.tmplIdx] || {}).label || 'Aerobico';
    return meta.tmplIdx === 0 && spPhase(metaDate(meta)) !== 'off' ? base + ' + burpees' : base;
  }
  return ((p.stretchDays || [])[meta.tmplIdx] || {}).label || 'Mobilità';
}

/* ---------------------------------------------------------------------------
   COME E PERCHÉ CAMBIA IL PROGRAMMA (dalla 6.7)
   In «Le prossime settimane», prima del calendario: che cosa cambia per
   calendario (fasi, blocco di 4 settimane, rotazione degli esercizi,
   intervalli, mobilità) e che cosa cambia secondo i risultati registrati
   (carichi, trazioni, supplementari, tenute), più ciò che sposta il
   calendario. Tutto è letto dai dati del programma attivo, così il testo
   resta allineato a quello che l'app fa davvero.
--------------------------------------------------------------------------- */
function cyclesHtml(p, meta) {
  const G = PROG.goals;
  const doseOf = k => { const g = G[k]; return g ? `${g.repsLow}-${g.repsHigh} rip., recupero ${g.rest} s` : ''; };
  const days = (p.strengthDays || []).map(d => esc(String(d.label).split('·')[0].trim()));
  // fasi del macrociclo
  let acc = 0;
  const phases = (p.phases || []).map((f, i) => {
    const a = acc + 1, b = acc + f.weeks; acc = b;
    const cur = meta.phase && meta.phase.index === i;
    const goals = (f.goals || []).map((k, j) => `${days[j] || 'Forza ' + 'ABC'[j]}: ${esc((G[k] || {}).label || k)}`).join(' · ');
    return `<li class="${cur ? 'cur' : ''}"><div class="nm" style="flex:1"><b>${esc(f.name)}</b>${cur ? ' <span class="wkbadge">sei qui</span>' : ''}
      <div class="small muted">${a === b ? `Settimana ${a}` : `Settimane ${a}-${b}`}${f.deload ? ' · tutta di scarico' : ''} · ${goals}</div>
      <div class="small muted">${esc(f.aim || '')}</div></div></li>`;
  }).join('');
  const usedGoals = [...new Set((p.phases || []).flatMap(f => f.goals || []))].filter(k => G[k]);
  const goalRows = usedGoals.map(k => `<li><b>${esc(G[k].label)}</b>: ${doseOf(k)}</li>`).join('');
  // blocco di 4 settimane
  const cw = p.cycleWeeks || 4;
  const block = Array.from({ length: cw }, (_, i) => {
    const pr = weekProfile(i + 1, cw);
    const what = pr.label === 'Scarico' ? 'una serie in meno, ripetizioni a metà della fascia, carico fermo'
      : pr.label === 'Picco' ? 'una serie in più, ripetizioni nella parte bassa della fascia'
      : pr.label === 'Adattamento' ? 'ripetizioni nella parte alta della fascia, 3 di riserva'
      : 'ripetizioni un po\' più basse della settimana prima';
    const cur = meta.weekInCycle === i + 1 && !meta.mobilityWeek;
    return `<li class="${cur ? 'cur' : ''}"><span class="wknum" style="flex:0 0 26px">${i + 1}</span><div class="nm" style="flex:1"><b>${esc(pr.label)}</b>${cur ? ' <span class="wkbadge">questa settimana</span>' : ''}
      <div class="small muted">${what}</div></div></li>`;
  }).join('');
  const ps = (typeof pullStage === 'function' && S.pullupGoal) ? pullStage() : null;
  const tw = meta.trainingWeek || 1;
  const hiit = hiitScheme(meta);
  return `<div class="block" style="margin-top:14px">
    <h3>Come cambia il programma</h3>
    <p class="small muted">Alcune cose cambiano <b>per calendario</b>, decise dal programma; altre <b>secondo i tuoi risultati</b>, da quello che registri. I carichi non salgono mai per calendario.</p>

    <h3 style="margin-top:14px;font-size:15px">Per calendario</h3>
    ${phases ? `<p class="small"><b>Le fasi del macrociclo.</b> Cambiano l'obiettivo di ciascuna seduta di forza, quindi ripetizioni e recuperi:</p>
    <ul class="hist">${phases}</ul>
    <ul class="small" style="padding-left:18px;margin-top:6px">${goalRows}</ul>` : ''}
    <p class="small" style="margin-top:10px"><b>Il blocco di ${cw} settimane</b>, che si ripete dentro ogni fase: stessi esercizi, cambiano serie e ripetizioni.</p>
    <ul class="hist">${block}</ul>
    <ul class="small" style="padding-left:18px;margin-top:8px">
      <li><b>Esercizi</b>: a ogni nuovo blocco di ${cw} settimane l'esercizio ruota, a parità di schema di movimento (per esempio un'altra spinta orizzontale al posto della precedente), quando l'attrezzatura offre alternative.</li>
      <li><b>Intervalli</b>: crescono con le settimane di allenamento — 30″ di lavoro e 90″ di recupero fino alla 4ª, 30/60 fino alla 12ª, 45/60 fino alla 24ª, poi 60/60. Ora sei alla settimana ${tw}: ${hiit.work}″ / ${hiit.rest}″.</li>
      <li><b>Mobilità</b>: i due schemi (anca e gambe; colonna e spalle) si alternano di settimana in settimana; la mobilità breve a casa segue i distretti dell'allenamento dello stesso giorno.</li>
    </ul>

    <h3 style="margin-top:14px;font-size:15px">Secondo i tuoi risultati</h3>
    <ul class="small" style="padding-left:18px">
      <li><b>Carichi</b>: salgono di un passo solo quando, per due sedute di fila, superi l'obiettivo di 2 ripetizioni nell'ultima serie (regola 2-for-2, regola operativa dell'app); scendono se segnali che era troppo pesante. Nella settimana di scarico restano fermi.</li>
      ${ps ? `<li><b>Trazioni e muscle-up</b>: il lavoro cambia per tappe secondo il massimo di trazioni pulite, misurato con un test nella prima settimana di ogni blocco, subito dopo lo scarico. Ora: <b>${esc(ps.stage.label)}</b> (massimo ${ps.m})${ps.next ? `; la prossima tappa, ${esc(ps.next.label)}, a ${ps.next.minMu ? 'primo muscle-up' : ps.next.min + ' trazioni'}` : ''}.</li>` : ''}
      <li><b>Esercizi supplementari</b>: entrano a fine seduta, se resta tempo, solo per i gruppi muscolari che nella settimana restano sotto le 10 serie, contando le sedute già fatte e quelle ancora previste; mai nella settimana di scarico.</li>
      <li><b>Esercizi a tempo</b> (plank, tenute): se per due volte di fila ti restano almeno 10 secondi di margine, la tenuta si allunga di 5 secondi, fino a +30.</li>
      <li><b>Durata</b>: la scegli ogni giorno fra 35 e 50 minuti; con più tempo entrano supplementari, finale metabolico e sospensione alla sbarra, con meno si accorciano prima i complementari.</li>
    </ul>

    <h3 style="margin-top:14px;font-size:15px">Che cosa sposta il calendario</h3>
    <ul class="small" style="padding-left:18px">
      <li>Una <b>settimana di sola mobilità</b> non conta nel piano: fasi, blocchi e data di fine slittano di una settimana.</li>
      <li>Una <b>seduta saltata</b> consuma il suo posto: il programma passa alla successiva e non si allunga.</li>
      <li>Puoi <b>scambiare le sedute</b> dentro la settimana, mobilità compresa: è prevista per ultima, ma puoi farla in qualunque giorno.</li>
    </ul>
    ${spCyclesHtml()}
  </div>`;
}

/* (7S 0) La preparazione Spartan dentro «Come cambia il programma». */
function spCyclesHtml() {
  const sp = SP();
  if (!sp || spPhase(Date.now()) === 'off') return '';
  const runFrom = dateIt(isoNoon(sp.runFrom));
  return `<h3 style="margin-top:14px;font-size:15px">Preparazione Spartan Race (fino al ${spDateText()})</h3>
    <ul class="small" style="padding-left:18px">
      <li><b>Per calendario</b>: da ora burpees e sospensione alla sbarra nella seduta a intervalli; dal ${runFrom} la seduta a ritmo costante diventa corsa-camminata (una volta a settimana) e si aggiunge un trasporto; settimana della gara leggera; dopo la gara il piano torna com'era. Forza A, B e C non cambiano.</li>
      <li><b>Secondo i tuoi risultati</b>: il livello dei burpees sale con ${(sp.burpee.advance || []).join(' e ')} di fila; le ripetizioni sono circa il 60-70% del tuo massimo; la sospensione il 60% del tuo massimo; la corsa sale di un livello solo se il giorno dopo il ginocchio è tranquillo, resta ferma se ha dato fastidio, scende se la mattina dopo andava peggio.</li>
      <li><b>Spartan Race check</b> nella prima settimana di ogni blocco: trazioni (Forza A), burpees e sospensione (intervalli), corsa-camminata (dal ${runFrom}). Dettagli e date in Progressi › Spartan Race.</li>
    </ul>`;
}

function openUpcoming(fromWeek) {
  const start = fromWeek || weekOfIdx(S.sessionIndex);
  const p = program();
  const weeks = [];
  for (let w = start; w < start + 6; w++) {
    const n = weekLen(w);
    const first = sessionMeta(weekStart(w));
    const days = [];
    for (let k = 0; k < n; k++) {
      const meta = sessionMeta(weekStart(w) + k);
      const cur = weekStart(w) + k === S.sessionIndex;
      const ck = spCheckKinds(meta);
      days.push(`<li${cur ? ' class="cur"' : ''}>
        <span class="wknum ${typeClass(meta)}" style="flex:0 0 26px">${k + 1}</span>
        <div class="nm" style="flex:1"><b>${esc(dayLabel(meta))}</b>${cur ? ' <span class="wkbadge">oggi</span>' : ''}${ck.length ? ' <span class="wkbadge sp">Spartan Race check</span>' : ''}
          <div class="small muted">${typeWord(meta)}${ck.length ? ' · ' + ck.map(x => SP_NAMES[x].toLowerCase()).join(', ') : ''}</div></div></li>`);
    }
    weeks.push(`<div class="block" style="margin-top:14px">
      <h3 style="font-size:16px;color:var(--muted)">${weekText(first, { cap: true })}${first.phase ? ' · ' + esc(first.phase.ph.name) : ''}${
        first.mobilityWeek ? ' · sola mobilità' : (first.profile.label === 'Scarico' ? ' · scarico' : '')}</h3>
      <ul class="hist">${days.join('')}</ul></div>`);
  }
  openModal(`<h2>Le prossime settimane</h2>
    <p class="small muted">${esc(p.name)}. Gli esercizi esatti vengono scelti quando apri la seduta, in base a carichi, attrezzatura e tempo che hai; qui vedi il tipo di lavoro previsto giorno per giorno.</p>
    ${start === weekOfIdx(S.sessionIndex) ? cyclesHtml(p, sessionMeta(S.sessionIndex)) : ''}
    <h3 style="margin-top:16px">Settimana per settimana</h3>
    ${weeks.join('')}
    <div class="btn-row" style="margin-top:14px">
      <button class="btn ghost" id="upPrev" ${start <= 1 ? 'disabled' : ''}>‹ Indietro</button>
      <button class="btn ghost" id="upNext">Altre 6 ›</button>
    </div>
    <button class="btn secondary" id="upClose" style="margin-top:10px">Chiudi</button>`);
  $('#upPrev').onclick = () => closeModal(() => openUpcoming(Math.max(1, start - 6)));
  $('#upNext').onclick = () => closeModal(() => openUpcoming(start + 6));
  $('#upClose').onclick = () => closeModal();
}

/* Schermata completa del percorso: tutte le fasi con la posizione attuale. */
function openPath() {
  const path = pathStatus(), p = path.p, meta = path.meta;
  let acc = 0;
  const rows = (p.phases || []).map((f, i) => {
    const start = acc + 1, end = acc + f.weeks; acc = end;
    const cur = path.meta.phase && path.meta.phase.index === i;
    const past = path.tw > end;
    return `<li class="${cur ? 'cur' : ''}" style="${past ? 'opacity:.55' : ''}">
      <div class="nm" style="flex:1"><b>${esc(f.name)}</b>${cur ? ' <span class="wkbadge">sei qui</span>' : ''}
        <div class="small muted">settimane ${start}-${end} · ${esc(f.aim || '')}</div></div>
      <div class="val small">${past ? '✓' : `${f.weeks} sett.`}</div></li>`;
  }).join('');
  openModal(`<h2>Il percorso</h2>
    <p class="small muted">${esc(p.name)} · ${esc(p.periodization || '')}</p>
    <div class="dbar" style="margin:12px 0 6px"><i style="width:${path.pct}%"></i></div>
    <p class="small">${whereText(meta, { cap: true })} · ${path.weeksLeft} settimane alla fine, previste per il <b>${dateIt(path.end)}</b>${(S.mobilityWeeks || []).length ? ' (le settimane di sola mobilità spostano la data)' : ''}.</p>
    <p class="small">Blocco di 4 settimane: settimana ${meta.weekInCycle} di ${meta.cycleLen} · ${esc(meta.profile.label)}${meta.profile.label === 'Scarico' ? ' (recupero)' : ''}.</p>
    <ul class="hist" style="margin-top:12px">${rows}</ul>
    <button class="btn ghost" id="pathUp" style="margin-top:14px">Vedi le prossime settimane</button>
    <button class="btn secondary" id="pathClose" style="margin-top:10px">Chiudi</button>`);
  $('#pathUp').onclick = () => closeModal(() => openUpcoming());
  $('#pathClose').onclick = () => closeModal();
}

/* Torna alla pagina d'apertura: la scelta fra mattino e pranzo di Oggi. */
function goToday() { homeView = null; daySel = null; homeSel = 'session'; go('home'); }

function go(view) {
  if (view === 'dash') { homeView = null; view = 'home'; }   // vecchio nome della pagina d'apertura
  setTimeout(() => tryApplyUpdate(), 0);                      // (7S 4) aggiornamento in attesa
  // uscendo dalla schermata della sessione il timer NON si ferma: si riduce da
  // solo alla barretta in basso e continua a scorrere mentre navighi
  if (timerRunning() && view !== 'session' && $('#timer').classList.contains('on')) minimizeTimer();
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  const navFor = view === 'history' ? 'prog' : view;   // lo storico sta dentro Progressi
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.go === navFor));
  // la barra comandi fissa appartiene alla sola schermata della sessione
  document.body.classList.toggle('in-session', view === 'session');
  if (view !== 'session') $('#actionBar').classList.remove('on');
  refreshDeload();
  window.scrollTo(0, 0);
  if (view === 'home') renderHome();
  if (view === 'prog') renderProg();
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  if (view === 'catalog') renderCatalog();
}

function doseText(it) {
  if (it.role === 'finisher' || CARDIO_ROLES.includes(it.role)) return it.sets > 1 ? `${it.sets}× ${it.hold}s / ${it.rest}s` : `${Math.round(it.hold / 60)} min`;
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
    (!alt.roles || alt.roles.includes(e.pullRole)) &&
    // (7S 0) la corsa-camminata non è un'alternativa alla bici: si sceglie solo
    // nella seduta di corsa della preparazione Spartan
    (!(e.cardioModes || []).includes('run') || (alt.modes || []).includes('run')));
  if (alt.roles && pool.length < 2) {
    pool = DB.exercises.filter(e => e.setup.includes(S.setup) && e.pattern === 'pullup');
  }
  // (8.3) slot per un muscolo preciso: le alternative allenano lo stesso muscolo
  if (alt.focus) {
    const f = DB.exercises.filter(e => e.setup.includes(S.setup) && (alt.types || ['strength']).includes(e.type) &&
      (e.focus || []).some(x => alt.focus.includes(x)));
    if (f.length >= 2 || !pool.length) pool = f;
  }
  // (8.4) attrezzi aerobici: la priorità al ginocchio vale per le proposte
  // automatiche, ma vogatore e scalini restano selezionabili a mano
  pool = (alt.patterns || []).includes('cardio') ? pool.filter(e => !isAvoided(e.id)) : applyCare(pool);
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
  if (item.ss && sess && sess.items) finalizeSupersets(sess.items, { noMove: true });   // la nota del compagno cita il nuovo nome
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

/* ---------------------------------------------------------------------------
   PANNELLI DI SCELTA DELLA SEDUTA (dalla 5.12)
   Aerobico: si sceglie l'attrezzo e, se serve, il tipo di lavoro (intervalli o
   ritmo costante). Mobilità: si sceglie quale dei due schemi svolgere.
--------------------------------------------------------------------------- */
const cardioModeWord = m => m === 'hiit' ? 'intervalli' : m === 'run' ? 'corsa-camminata' : 'ritmo costante';

function openSessionPicker(sess) {
  const meta = sessionMeta(sess.idx);
  if (meta.dayType === 'cardio') openCardioPicker(sess, meta);
  else openStretchPicker(sess, meta);
}

/* Riapre il pannello dopo una modifica, ricostruendo la seduta. */
function reopenPicker(idx, fn) {
  renderHome();
  fn(idx === S.sessionIndex ? todaySession() : sessionFor(idx), sessionMeta(idx));
}

function openCardioPicker(sess, meta, opt) {
  const live = !!(opt && opt.live);
  const chosen = pickOf(meta.idx) || {};
  const days = PROG.cardioDays || [];
  const base = days[meta.tmplIdx] || { label: 'Aerobico', mode: 'steady' };
  const mode = chosen.mode || base.mode;
  const curId = (sess.items.filter(i => i.role === 'cardio')[0] || {}).exId;
  // (7S 0) la corsa-camminata si sceglie solo nella seduta a ritmo costante,
  // da dicembre alla gara
  const runOk = meta.tmplIdx === 1 && !meta.mobilityWeek && ['run', 'race'].includes(spPhase(metaDate(meta)));
  const pool = DB.exercises.filter(e => (e.pattern === 'cardio' || e.pattern === 'finisher') &&
      !e.retired && e.setup.includes(S.setup) && (e.cardioModes || []).length &&
      (!(e.cardioModes || []).includes('run') || runOk))
    .sort((a, b) => a.name.localeCompare(b.name));
  // (8.4) in seduta: finché nulla è registrato si può cambiare tutto; dopo,
  // solo l'attrezzo, fra quelli che reggono il tipo di lavoro già iniziato
  const begun = live && current && current.sess.items.some((it, i) => current.setsDone[i] > 0 || (current.logRef[i] !== null && current.logRef[i] !== undefined));
  const modes = begun ? '' : days.map(t =>
    `<button data-cmode="${t.mode}" aria-pressed="${t.mode === mode}">${esc(cardioModeWord(t.mode))}</button>`).join('');
  const rows = pool.filter(ex => !begun || (ex.cardioModes || []).includes(mode)).map(ex => {
    const ms = ex.cardioModes || [];
    const isCur = ex.id === curId;
    const care = S.kneeCare && ex.kneeFriendly === false;
    const why = isCur ? 'in programma oggi'
      : ms.includes('run') ? 'preparazione Spartan: la corsa della settimana, livelli guidati dal ginocchio'
      : care ? 'flessione profonda sotto carico: non viene proposto da solo con la priorità al ginocchio'
      : ms.includes(mode) ? 'adatto al lavoro a ' + cardioModeWord(mode)
      : 'si può fare solo a ' + ms.map(cardioModeWord).join(' o ');
    return `<li class="${isCur ? 'cur' : ''}" data-ckex="${ex.id}">
      <div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm"><b>${esc(ex.name)}</b>
        <div class="small muted">${esc(ms.map(cardioModeWord).join(' · '))}</div>
        <div class="why">${esc(why)}</div></div>
      <button class="pick">${isCur ? 'Mantieni' : 'Scegli'}</button></li>`;
  }).join('');
  openModal(`<h2>Cambia la seduta aerobica</h2>
    <p class="small muted">Il programma propone «${esc(base.label)}», ma l'attrezzo lo scegli tu: i minuti contano allo stesso modo da qualunque macchina arrivino. La scelta vale per questa seduta e resta anche se cambi la durata o chiudi l'app.</p>
    ${begun ? `<p class="small" style="margin-top:10px">Seduta già iniziata: resta il lavoro a ${esc(cardioModeWord(mode))}, cambia l'attrezzo per le parti ancora da fare.</p>` : `<div class="seg" role="group" aria-label="Tipo di lavoro" style="margin-top:12px">${modes}</div>`}
    <ul class="picker" style="margin-top:12px">${rows}</ul>
    ${(chosen.exId || chosen.mode) && !begun ? '<button class="btn ghost" id="ckReset" style="margin-top:14px">Torna alla seduta prevista</button>' : ''}
    <button class="btn secondary" id="ckClose" style="margin-top:10px">Chiudi</button>`);

  document.querySelectorAll('[data-ckex]').forEach(li => li.onclick = () => {
    const ex = exById(li.dataset.ckex);
    const ms = ex.cardioModes || [];
    // se l'attrezzo non regge il tipo di lavoro del giorno, si adatta il lavoro
    const m = ms.includes(mode) ? mode : ms[0];
    setPick(meta.idx, { exId: ex.id, mode: m });
    closeModal(() => { if (live) liveCardioChange(ex.id, begun); else { homeSel = 'session'; renderHome(); } });
  });
  document.querySelectorAll('[data-cmode]').forEach(b => b.onclick = () => {
    const m = b.dataset.cmode;
    const keep = (chosen.exId && ((exById(chosen.exId) || {}).cardioModes || []).includes(m)) ? chosen.exId : null;
    setPick(meta.idx, { exId: keep, mode: m });
    closeModal(() => {
      if (live) { liveCardioChange(null, false); openCardioPicker(current.sess, sessionMeta(current.sess.idx), { live: true }); }
      else reopenPicker(meta.idx, openCardioPicker);
    });
  });
  if ($('#ckReset')) $('#ckReset').onclick = () =>
    closeModal(() => { setPick(meta.idx, null); if (live) liveCardioChange(null, false); else renderHome(); });
  $('#ckClose').onclick = () => closeModal();
}

/* (8.4) Attrezzo aerobico cambiato a seduta aperta. Se nulla è ancora
   registrato la seduta si ricostruisce con la nuova scelta (anche il tipo di
   lavoro); altrimenti cambia solo l'attrezzo delle parti ancora da fare. */
function liveCardioChange(exId, begun) {
  const c = current;
  if (!c || c.finished) return;
  const s = c.sess;
  if (!begun) {
    try { stopTimer(); } catch (e) {}
    planCache = null;
    const ns = todaySession(null);
    if (!ns || !ns.items || !ns.items.length) return;
    startSession(ns);
    go('session'); renderSession();
    return;
  }
  const ex = exById(exId);
  if (!ex) return;
  let oldName = '';
  s.items.forEach((it, i) => {
    if (!CARDIO_ROLES.includes(it.role) || !isOpenItem(c, i)) return;
    oldName = oldName || (exById(it.exId) || {}).name || '';
    it.exId = ex.id; c.loads[i] = '';
  });
  if (oldName && s.label) s.label = s.label.replace(oldName, ex.name);
  saveResume(); renderSession();
}

function openStretchPicker(sess, meta) {
  const chosen = pickOf(meta.idx) || {};
  const sDays = meta.program.stretchDays || [];
  const ti = (chosen.stretch != null && sDays[chosen.stretch]) ? chosen.stretch : meta.tmplIdx;
  const rows = sDays.map((t, i) => `<li class="${i === ti ? 'cur' : ''}" data-ski="${i}">
      <div class="nm" style="flex:1"><b>${esc(t.label)}</b>
        <div class="small muted">${esc(t.staticGroups.join(' · '))}</div>
        <div class="why">${i === ti ? 'in programma oggi' : `${t.dynamic} esercizi di mobilità dinamica e ${t.count} allungamenti`}</div></div>
      <button class="pick">${i === ti ? 'Mantieni' : 'Scegli'}</button></li>`).join('');
  openModal(`<h2>Cambia la seduta di mobilità</h2>
    <p class="small muted">Due schemi, distretti diversi: scegli quello che ti serve oggi. Qui cambia il contenuto; il giorno lo scegli dal calendario della settimana: la mobilità è prevista per ultima, ma puoi farla quando ti conviene.</p>
    <ul class="picker" style="margin-top:12px">${rows}</ul>
    ${chosen.stretch != null ? '<button class="btn ghost" id="skReset" style="margin-top:14px">Torna alla seduta prevista</button>' : ''}
    <button class="btn secondary" id="skClose" style="margin-top:10px">Chiudi</button>`);

  document.querySelectorAll('[data-ski]').forEach(li => li.onclick = () => {
    setPick(meta.idx, { stretch: +li.dataset.ski });
    closeModal(() => { homeSel = 'session'; renderHome(); });
  });
  if ($('#skReset')) $('#skReset').onclick = () =>
    closeModal(() => { setPick(meta.idx, null); renderHome(); });
  $('#skClose').onclick = () => closeModal();
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
  const key = `${S.programId}|${S.setup}|${S.sessionIndex}|${kind || ''}|${S.durPref || 45}|${S.finisher || ''}|${pickKey(S.sessionIndex)}|${spSig()}|${painSig()}`;
  if (!planCache || planCache.key !== key) planCache = { key, sess: buildSession(S.sessionIndex, kind) };
  return planCache.sess;
}

const typeWord = x => x.dayType === 'strength' || (x.isStrength && !x.dayType) ? 'potenziamento' : x.dayType === 'cardio' ? 'aerobica' : 'mobilità';
const typeClass = x => x.dayType === 'strength' || (x.isStrength && !x.dayType) ? 'strength' : x.dayType === 'cardio' ? 'cardio' : 'mobility';

/* ---------------------------------------------------------------------------
   OGGI: PRIMA SI SCEGLIE, POI SI ENTRA (dalla 5.13)
   La pagina mostrava di seguito mattino, calendario della settimana ed elenco
   della seduta di pranzo: tre blocchi lunghi, con quello che serviva davvero
   adesso quasi sempre fuori schermo. Ora Oggi si apre su due scelte — la
   mobilità del mattino e la seduta del giorno — e i dettagli compaiono solo
   dentro quella che tocchi, con «Torna alla scelta» per cambiare idea.
--------------------------------------------------------------------------- */
function renderHome() {
  $('#topTitle').textContent = 'Oggi';
  refreshDeload();
  if (homeView === 'morning') return renderHomeMorning();
  if (homeView === 'lunch') return renderHomeLunch();
  if (homeView === 'week') return renderHomeWeek();
  if (homeView === 'result') return renderHomeResult();
  return renderHomePick();
}

/* Avvisi che valgono per tutta la pagina: seduta in corso o interrotta e
   promemoria del backup. Tornano identici nelle tre schermate. */
function homeBanners() {
  const daysSince = S.lastExport ? (Date.now() - S.lastExport) / 86400000 : Infinity;
  const backupNag = weekendBackupDue() ? weekendBackupHtml() : (S.logs.length > 0 && daysSince > 7)
    ? `<div class="notice" style="margin-top:14px;display:flex;align-items:center;gap:12px">
         <span style="flex:1">${S.lastExport ? 'Backup non aggiornato da un po\'' : 'Non hai ancora un backup'}: se rimuovi l'app dalla Home, i dati si perdono.</span>
         <button class="btn secondary" id="nagExport" style="width:auto;min-height:44px;font-size:15px">Esporta ora</button>
       </div>` : '';
  const saved = (!current || current.finished) ? resumableSession() : null;
  const resume = (current && !current.finished)
    ? `<div class="notice" style="margin-top:14px;display:flex;align-items:center;gap:12px">
         <span style="flex:1">Sessione in corso: ${esc(current.sess.label)}</span>
         <button class="btn" id="resumeBtn" style="width:auto;min-height:44px;font-size:17px">Riprendi</button>
       </div>`
    : saved
    ? `<div class="notice" style="margin-top:14px;display:flex;align-items:center;gap:12px">
         <span style="flex:1">Seduta lasciata a metà: ${esc(saved.label)}, esercizio ${saved.pos + 1} di ${saved.items.length}
           (${new Date(saved.ts).toDateString() === new Date().toDateString() ? 'oggi' : new Date(saved.ts).toLocaleDateString('it-IT')}).</span>
         <button class="btn" id="restoreBtn" style="width:auto;min-height:44px;font-size:17px">Riprendi</button>
       </div>
       <button class="btn ghost" id="dropResume" style="margin-top:8px">Scarta la seduta interrotta</button>` : '';
  return { html: resume + (resume ? '' : backupNag), saved };
}

/* Collega i pulsanti degli avvisi: esistono in tutte e tre le schermate. */
function bindHomeBanners(saved) {
  if ($('#resumeBtn')) $('#resumeBtn').onclick = () => { go('session'); renderSession(); };
  if ($('#restoreBtn')) $('#restoreBtn').onclick = () => restoreSession(saved);
  if ($('#dropResume')) $('#dropResume').onclick = () => confirmAction('Scartare la seduta interrotta?',
    'Gli esercizi già conclusi restano nello storico; i dati non ancora registrati vengono persi.',
    'Scarta', () => { clearResume(); renderHome(); });
  if ($('#nagExport')) $('#nagExport').onclick = () => exportData(() => renderHome());
  if ($('#wkBackup')) $('#wkBackup').onclick = () => exportData(() => renderHome());
  if ($('#homeBack')) $('#homeBack').onclick = () => { homeView = null; renderHome(); window.scrollTo(0, 0); };
  // (8) lo stesso pulsante anche in fondo alla pagina
  if ($('#homeBack2')) $('#homeBack2').onclick = () => { homeView = null; renderHome(); window.scrollTo(0, 0); };
}

/* Schermata del mattino. */
function renderHomeMorning() {
  const s = todaySession(null);
  $('#topChip').textContent = shortWhere(s);
  $('#topChip').className = 'chip mobility';
  const b = homeBanners();
  $('#view-home').innerHTML = `
    <button class="btn ghost" id="homeBack" style="margin-top:14px">‹ Torna a Oggi</button>
    ${b.html}
    ${deloadCardHtml()}
    ${morningHtml()}
    <button class="btn ghost backbottom" id="homeBack2">‹ Torna a Oggi</button>`;
  bindHomeBanners(b.saved);
  bindMorning();
}

/* ---------------------------------------------------------------------------
   OGGI IN TRE SEZIONI (dalla 7S 6)
   La pagina d'apertura ha tre riquadri: Mobilità breve, Allenamento del
   giorno, Programma della settimana.
     · «Allenamento del giorno» apre la scheda della seduta: titolo,
       descrizione, durata, equipaggiamento, esercizi, e i tre comandi
       Inizia / Salta / Segna come svolta.
     · «Programma della settimana» mostra dove sei nel programma, lo scopo
       della fase e soltanto le sedute dei giorni della settimana: svolte
       evidenziate, «Seleziona» per spostare una seduta a oggi (scambio come
       prima), solo blocco core e seduta libera. Toccare una seduta apre la sua
       scheda «Allenamento del giorno» (e nient'altro: non compare più in fondo
       alla pagina). Se non è quella di oggi, avviarla, saltarla o segnarla la
       porta prima a oggi con lo stesso scambio.
--------------------------------------------------------------------------- */
let daySel = null;          // posizione nella settimana della seduta aperta (null = quella di oggi)
let dayFrom = 'pick';       // da dove si è aperta la scheda: 'pick' o 'week'

function weekIntroHtml(s) {
  const p = program();
  return `<div class="kicker wkkicker">
      ${s.mobilityWeek ? 'Settimana di sola mobilità'
        : s.phase ? `Fase ${s.phase.index + 1} di ${p.phases.length} · ${esc(s.phase.ph.name)}`
                  : `Blocco · settimana ${s.weekInCycle} di ${p.cycleWeeks} · ${esc(p.name)}`}</div>
    ${s.mobilityWeek
      ? `<p class="small muted" style="margin:6px 0 0">Tutte le sedute sono di mobilità e stretching. Il programma di forza riprende la settimana ${s.weekAbs + 1} da dove era rimasto: nessuna settimana di lavoro va persa.</p>`
      : s.phase ? `<p class="small muted" style="margin:6px 0 0">${whereText(s, { cap: true })}, ${s.phase.weekInPhase}ª della fase su ${s.phase.ph.weeks}${weeksLeftText(p, s.trainingWeek)}. ${esc(s.phase.ph.aim)}</p>`
      : `<p class="small muted" style="margin:6px 0 0">${whereText(s, { cap: true })}.</p>`}`;
}
function weekTileBody() {
  const s = sessionMeta(S.sessionIndex), here = posOfIdx(S.sessionIndex);
  return `<div class="dstat">${s.phase ? esc(s.phase.ph.name) : 'Settimana ' + s.weekAbs}</div>
    <p class="small">${weekText(s, { cap: true })} · ${here} di ${s.days} sedute svolte</p>
    <p class="small muted">Le sedute di ogni giorno: spostale, scegli il blocco core o una seduta libera.</p>`;
}

/* Schermata di scelta: tre riquadri. */
function renderHomePick() {
  const s = todaySession(null);
  $('#topChip').textContent = shortWhere(s);
  $('#topChip').className = 'chip';
  const ms = morningStatus(), ls = lunchStatus();
  const b = homeBanners();
  const mBody = morningTileBody(ms, true), lBody = lunchTileBody(ls, true);
  const tile = (id, kicker, cls, body) => dashTile('pick', id, kicker, cls, body);

  $('#view-home').innerHTML = `
    ${b.html}
    ${deloadCardHtml()}
    ${tile('morning', 'Mobilità breve · a casa', 'mobility', mBody)}
    ${tile('lunch', 'Allenamento del giorno', ls.done || ls.skipped ? 'strength' : typeClass(ls.s), lBody)}
    ${tile('week', 'Programma della settimana', 'week', weekTileBody())}
    ${spartanTodayHtml(ls.done || ls.skipped ? todaySession(null) : ls.s)}`;

  document.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
    const k = el.dataset.pick;
    if (k === 'lunch' && current && !current.finished) { go('session'); renderSession(); return; }
    // (8.6 / 8.7) seduta di oggi (secondo il calendario) già fatta o saltata: risultati
    if (k === 'lunch' && (ls.done || ls.skipped)) {
      const i = ls.entry ? S.sessionLog.indexOf(ls.entry) : -1;
      if (i >= 0) { openResult(i, 'pick'); return; }
      homeView = 'week'; renderHome(); return;
    }
    if (k === 'lunch') {
      daySel = (!ls.rest && !ls.stale && ls.tp && ls.tp.W === weekOfIdx(S.sessionIndex)) ? ls.tp.q : null;
      if (daySel === posOfIdx(S.sessionIndex)) daySel = null;
      dayFrom = 'pick'; homeSel = 'session';
    }
    homeView = k; renderHome();
  });
  bindHomeBanners(b.saved);
  bindKneeAsk(() => renderHome());
}

/* Programma della settimana: presentazione e sedute dei giorni. */
function renderHomeWeek() {
  const here = posOfIdx(S.sessionIndex);
  const wStart = S.sessionIndex - here;
  const nDays = weekLen(weekOfIdx(S.sessionIndex));
  const s = sessionFor(S.sessionIndex);
  $('#topChip').textContent = shortWhere(s);
  $('#topChip').className = 'chip';
  let week = '';
  const tpw = todayPlan();
  const calQ = (!tpw.rest && !tpw.stale && tpw.W === weekOfIdx(S.sessionIndex)) ? tpw.q : -1;
  for (let q = 0; q < nDays; q++) {
    const alt = sessionFor(wStart + q);          // sola lettura: etichetta, tipo, minuti
    const state = q < here ? 'done' : (q === calQ || (calQ < 0 && q === here) ? 'now' : 'next');
    const lg = q < here ? (() => { const i = sessionLogIndexFor(wStart + q); return i >= 0 ? S.sessionLog[i] : null; })() : null;
    const badge = q < here ? `<span class="wkbadge done">${lg && isSkipped(lg) ? 'saltata' : '✓ svolta'}</span>`
                : q === calQ ? '<span class="wkbadge">di oggi</span>'
                : q === here ? '<span class="wkbadge alt">la prossima</span>'
                : `<button class="selbtn" data-sel="${q}" aria-label="Sposta ${esc(alt.label)} come prossima">Seleziona</button>`;
    const ck = q >= here ? spCheckKinds(sessionMeta(wStart + q)) : [];
    week += `<li class="wk ${state}" data-day="${q}">
      <span class="wknum ${typeClass(alt)}">${q < here ? '✓' : q + 1}</span>
      <div class="nm"><b>${esc(alt.label)}</b>
        <div class="small muted">${nDays === 6 ? WEEKDAYS[q] + ' · ' : ''}${typeWord(alt)} · ${alt.minutes} min${alt.items.some(i => i.block === 'pullup') ? ' · trazioni' : ''}${ck.length ? ' · Spartan Race check' : ''}${(nDays === 6 && alt.dayType === 'stretch' && q === nDays - 1) ? ' · di solito l\'ultima' : ''}</div></div>
      ${badge}</li>`;
  }
  const coreS = sessionFor(S.sessionIndex, 'core');
  week += `<li class="wk next extra" data-core="1">
      <span class="wknum core">+</span>
      <div class="nm"><b>Solo blocco core</b>
        <div class="small muted">facoltativo · ${coreS.minutes} min · non fa avanzare la settimana</div></div>
      <span class="chev">›</span></li>
    <li class="wk next extra" data-free="1">
      <span class="wknum core">+</span>
      <div class="nm"><b>Seduta libera</b>
        <div class="small muted">scegli tu gli esercizi · non fa avanzare la settimana</div></div>
      <span class="chev">›</span></li>`;
  const b = homeBanners();
  $('#view-home').innerHTML = `
    <button class="btn ghost" id="homeBack" style="margin-top:14px">‹ Torna a Oggi</button>
    ${b.html}
    ${deloadCardHtml()}
    <div class="card">
      ${weekIntroHtml(s)}
      <h2 style="margin-top:10px">Programma della settimana</h2>
      <ul class="week">${week}</ul>
      <p class="small muted" style="margin-top:10px">Le sedute corrispondono ai giorni da lunedì a sabato. Tocca una seduta per aprirla (quelle svolte mostrano risultati e valutazioni); «Seleziona» la rende la prossima da fare e quella prevista prende il suo posto. La mobilità è prevista per ultima, ma puoi farla in qualunque giorno.</p>
    </div>
    <button class="btn ghost backbottom" id="homeBack2">‹ Torna a Oggi</button>`;
  const openDay = q => { daySel = q; dayFrom = 'week'; homeSel = 'session'; homeView = 'lunch'; renderHome(); window.scrollTo(0, 0); };
  document.querySelectorAll('[data-sel]').forEach(bt => bt.onclick = e => {
    e.stopPropagation();
    const q = +bt.dataset.sel;
    snapForUndo();
    if (q > here) swapDay(here, q);
    planCache = null; homeSel = 'session';
    renderHome();
    offerUndo('Seduta spostata a oggi.');
  });
  // (8.6) le sedute svolte aprono i risultati, non quella prevista
  document.querySelectorAll('[data-day]').forEach(li => li.onclick = () => {
    const q = +li.dataset.day;
    if (q < here) { const i = sessionLogIndexFor(wStart + q); if (i >= 0) { openResult(i, 'week'); return; } }
    openDay(q);
  });
  $('[data-core]').onclick = () => { daySel = null; dayFrom = 'week'; homeSel = 'core'; homeView = 'lunch'; planCache = null; renderHome(); window.scrollTo(0, 0); };
  $('[data-free]').onclick = () => {
    if (current && !current.finished) {
      confirmAction('Sessione già in corso', 'Vuoi abbandonarla e iniziare una seduta libera? Gli esercizi già conclusi restano nello storico.',
        'Inizia la seduta libera', openFreeSession);
    } else openFreeSession();
  };
  bindHomeBanners(b.saved);
}

/* (8.3) Il programma è costruito su 45 minuti: superserie e lavoro diretto
   sui muscoli piccoli ci stanno tutti. Con meno minuti si confronta la seduta
   con quella da 45 e si elenca cosa si perde (i supplementari, il finale e la
   sospensione «se resta tempo» non contano: non fanno parte del programma). */
const PROGRAM_MIN = 45;
function durationLoss(idx, m) {
  if (!(m < PROGRAM_MIN)) return [];
  let a, b;
  try { a = buildSession(idx, null, PROGRAM_MIN); b = buildSession(idx, null, m); } catch (e) { return []; }
  if (!a || !b || a.type !== 'strength') return [];
  const inProgram = it => !['extra', 'finisher', 'activation'].includes(it.role);
  const out = [];
  a.items.filter(inProgram).forEach(x => {
    const y = b.items.find(z => z.exId === x.exId);
    const nm = (exById(x.exId) || {}).name || x.exId;
    if (!y) out.push(`${nm}: tolto${x.ss ? ' (era in superserie)' : ''}`);
    else if (y.sets < x.sets) out.push(`${nm}: ${x.sets} → ${y.sets} serie`);
  });
  return out;
}
/* Riquadro del dolore in Allenamento del giorno: stato e pulsante. */
function painStatusHtml() {
  const lines = ['knee', 'shoulder'].map(p => {
    const d = districtPain(p);
    if (!d || d.v < PAIN_DISTRICT) return '';
    return `<li>${PAIN_NAME[p]} ${d.v}/10 ${esc(d.src)}: ${d.v >= PAIN_STRONG ? 'esercizi più tollerabili per questo distretto e carichi −10%' : 'carichi −10% sugli esercizi di questo distretto'}.</li>`;
  }).filter(Boolean);
  return `<div class="card painstatus" style="margin-top:14px">
    <p class="small" style="margin:0"><b>Ginocchio e spalla</b></p>
    ${lines.length ? `<ul class="small" style="margin:6px 0 0 18px">${lines.join('')}</ul>` : '<p class="small muted" style="margin:6px 0 0">Nessun dolore segnalato che cambi la prossima seduta.</p>'}
    <button class="btn ghost" id="painDayBtn" style="margin-top:10px">Segna dolore o fastidio</button>
  </div>`;
}

/* (8.6) Seduta già svolta: risultati, stelle e motivo, dolore modificabile.
   Si apre dal riquadro «Allenamento del giorno» quando la seduta di oggi è
   fatta e dalle sedute «svolta» del programma della settimana. */
let resultIdx = -1;
function sessionLogIndexFor(idx) {
  for (let i = S.sessionLog.length - 1; i >= 0; i--) {
    const x = S.sessionLog[i];
    if (x && x.idx === idx && isProgramKind(x.kind) && !/ignorata/.test(x.label || '')) return i;
  }
  return -1;
}
function openResult(i, from) { resultIdx = i; dayFrom = from || 'pick'; homeView = 'result'; renderHome(); window.scrollTo(0, 0); }
function renderHomeResult() {
  const x = S.sessionLog[resultIdx];
  if (!x) { homeView = null; return renderHome(); }
  const v = sessionVerdict(x), d = new Date(x.ts);
  $('#topChip').textContent = 'Seduta svolta';
  $('#topChip').className = 'chip';
  const backTxt = dayFrom === 'week' ? 'Torna al programma della settimana' : 'Torna a Oggi';
  const next = todaySession(null);
  $('#view-home').innerHTML = `
    <button class="btn ghost" id="resBack" style="margin-top:14px">‹ ${backTxt}</button>
    <div class="card">
      <div class="kicker">Seduta svolta · ${d.toLocaleDateString('it-IT')}</div>
      <h2>${esc(sessLabel(x))}</h2>
      ${isSkipped(x) ? '<p class="small">Seduta saltata: nessun risultato registrato.</p>'
        : `<p class="small">${esc(v.text)} · ${v.pct}% delle serie · ${v.minutes} min${v.avg ? ` · ${starsHtml(Math.round(v.avg))} ${kg1(v.avg)} stelle medie` : ''}</p>`}
      ${x.note ? `<div class="notice" style="margin-top:8px">${esc(x.note)}</div>` : ''}
      <ul class="hist" style="margin-top:10px">${sessionRowsHtml(v.logs) || '<li><span class="small muted">Nessun esercizio registrato per questa seduta.</span></li>'}</ul>
      <p class="small muted" style="margin-top:8px">Sotto ogni esercizio: serie (carico × ripetizioni, tra parentesi le ripetizioni di riserva), stelle e motivo del giudizio.</p>
      ${feelEditHtml(resultIdx)}
    </div>
    ${dayFrom === 'week' ? '' : `<button class="btn" id="resNext">Prossima seduta: ${esc(next.label)} ›</button>
    <button class="btn ghost" id="resWeek" style="margin-top:10px">Programma della settimana</button>`}
    <button class="btn ghost backbottom" id="resBack2">‹ ${backTxt}</button>`;
  const back = () => { const to = dayFrom === 'week' ? 'week' : null; homeView = to; renderHome(); window.scrollTo(0, 0); };
  $('#resBack').onclick = back; $('#resBack2').onclick = back;
  if ($('#resWeek')) $('#resWeek').onclick = () => { homeView = 'week'; renderHome(); window.scrollTo(0, 0); };
  if ($('#resNext')) $('#resNext').onclick = () => { daySel = null; dayFrom = 'pick'; homeSel = 'session'; homeView = 'lunch'; renderHome(); window.scrollTo(0, 0); };
  bindFeelEdit(resultIdx);
}

/* Allenamento del giorno: la seduta di oggi, o quella toccata nel programma
   della settimana. */
function renderHomeLunch() {
  const p = program();
  const here = posOfIdx(S.sessionIndex);
  const wStart = S.sessionIndex - here;
  const core = homeSel === 'core';
  const q = core || daySel === null ? here : daySel;
  const isToday = q === here;
  const done = q < here;
  const s = (core || isToday) ? todaySession(core ? 'core' : null) : sessionFor(wStart + q);

  $('#topChip').textContent = shortWhere(isToday || core ? s : sessionMeta(S.sessionIndex));
  $('#topChip').className = 'chip ' + (core ? 'mobility' : (s.dayType || 'mobility').replace('stretch', 'mobility'));

  const rows = s.items.map((it, i) => {
    const ex = exById(it.exId);
    // (7S 1) carico proposto per le ripetizioni di oggi e ultima seduta
    const sg = ex && ex.load === 'weight' && !isAssist(ex) ? suggestLoad(ex, it) : null;
    const sgTxt = sg && sg.value && sg.last && numLoad(sg.last.load) > 0
      ? `<span class="small sugline">Proposto <b>${esc(String(sg.value).replace('.', ','))} kg</b> · ultima ${esc(lastSetsText(sg.last))}</span>` : '';
    const ssHead = it.ss && it.ssRole === 'A' ? `<li class="sshead"><b>Superserie ${it.ssN || ''}</b> · alterna i due esercizi qui sotto: una serie del primo, 20 s per spostarti, una serie del secondo, poi il recupero. Ripeti per tutte le serie.</li>` : '';
    return ssHead + `<li data-plan="${i}" class="${it.block === 'pullup' ? 'pullrow' : ''}${it.ss ? ' ssrow' : ''}"><div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm"><b>${esc(ex.name)}</b>${sgTxt}<span class="small muted">${esc(ex.group)}${it.note ? ' · ' + esc(it.note) : ''}</span></div>
      <div class="dose">${doseText(it)}</div><div class="chev">›</div></li>`;
  }).join('');

  const b = homeBanners();
  // aerobico e mobilità: il contenuto della seduta di oggi si può cambiare
  const chosenNow = pickOf(S.sessionIndex);
  // (8.4) anche per le sedute degli altri giorni della settimana, non ancora fatte
  const swapHtml = (core || s.isStrength || done) ? '' : `
      ${pickOf(isToday ? S.sessionIndex : wStart + q) ? `<p class="small" style="margin-top:10px">Seduta scelta da te al posto di quella prevista.</p>` : ''}
      <button class="btn ghost" id="swapKind" style="margin-top:10px">${
        s.dayType === 'cardio' ? 'Cambia attrezzo o tipo di lavoro' : 'Cambia schema di mobilità'}</button>`;
  const tpl = todayPlan();
  const calToday = !tpl.rest && !tpl.stale && tpl.W === weekOfIdx(S.sessionIndex) && tpl.q === q;
  const notToday = !core && !isToday && !done
    ? (calToday
      ? `<div class="notice" style="margin-top:12px">È la seduta di oggi (${WEEKDAYS[q]}). Prima ${q - here === 1 ? 'c\'è 1 seduta' : `ci sono ${q - here} sedute`} dei giorni scorsi non svolte: se avvii questa o la segni come svolta, quelle si spostano più avanti nella settimana. Per saltarle usa il programma della settimana.</div>`
      : `<div class="notice" style="margin-top:12px">Questa seduta è prevista per ${WEEKDAYS[q] || 'il giorno ' + (q + 1)}. Se la avvii, la salti o la segni come svolta, diventa la prossima da fare e quella prevista prende il suo posto.</div>`) : '';
  const staleNote = !core && tpl.stale && isToday
    ? `<div class="notice" style="margin-top:12px">La settimana ${tpl.W} del programma è iniziata la settimana scorsa ed è rimasta a metà (${tpl.left === 1 ? 'manca 1 seduta' : `mancano ${tpl.left} sedute`}). Puoi proseguire da qui oppure saltare il resto e ripartire con la settimana nuova dal lunedì.
       <button class="btn ghost" id="skipRest" style="margin-top:10px">Salta le sedute rimaste e passa alla settimana ${tpl.W + 1}</button></div>` : '';
  const restNote = !core && tpl.rest && isToday && weekdayIdx() === 6
    ? `<div class="notice" style="margin-top:12px">Oggi è domenica: nessuna seduta prevista. Questa è la prossima, di lunedì; puoi farla anche oggi.</div>` : '';
  const doneNote = done ? `<div class="notice" style="margin-top:12px">Seduta già svolta questa settimana: qui sotto gli esercizi previsti.</div>` : '';

  $('#view-home').innerHTML = `
    <button class="btn ghost" id="dayBack" style="margin-top:14px">‹ ${dayFrom === 'week' ? 'Torna al programma della settimana' : 'Torna a Oggi'}</button>
    ${b.html}
    ${deloadCardHtml()}
    ${core || !isToday ? '' : spartanTodayHtml(s)}
    ${notToday}${doneNote}${staleNote}${restNote}
    <div class="seg" role="group" aria-label="Attrezzatura">
      <button data-setup="gym" aria-pressed="${S.setup === 'gym'}">Palestra</button>
      <button data-setup="home" aria-pressed="${S.setup === 'home'}">Casa</button>
    </div>

    <div class="card" id="lunchCard">
      <div class="session-head ${core ? 'mobility' : ({ strength: '', cardio: 'cardio' }[s.dayType] ?? 'mobility')}">
        <div>
          <div class="kicker">${core ? 'Blocco core facoltativo' : `Allenamento del giorno · sessione ${s.pos} di ${s.days} · ${typeWord(s)}`}</div>
          <h2>${esc(s.label)}</h2>
          <p class="small muted" style="margin:6px 0 0">${core ? 'Blocco breve da aggiungere quando hai tempo: non avanza la settimana del programma.'
                 : esc(s.isStrength ? s.profile.note : s.run ? `Preparazione Spartan: livello ${s.run.level + 1} di ${runState().max + 1}${s.run.light ? ', accorciata' : ''}. Corsa lenta, ginocchio al massimo 2 su 10; il giorno dopo l'app ti chiede come sta, e da lì dipende il livello successivo.` : s.dayType === 'cardio' ? (PROG.cardioDays[s.tmplIdx] || {}).note || '' : mobilityNote(s.profile, s.mobilityWeek))}</p>
        </div>
      </div>
      ${core || done ? '' : `<div class="durrow">
        <span class="lab">Tempo a disposizione oggi</span>
        <div class="seg dur" role="group" aria-label="Durata della seduta">
          ${DURATIONS.map(m => `<button data-dur="${m}" aria-pressed="${(S.durPref || 45) === m}">${m}′</button>`).join('')}
        </div>
        <p class="small muted" style="margin:6px 0 0">Durata stimata ${s.minutes} minuti, cambi fra gli esercizi compresi.${
          s.trimmed ? ' Seduta ridotta per stare nel tempo scelto: con più minuti tornano serie ed esercizi.'
          : (s.isStrength ? ' Con più minuti si aggiungono supplementari, finale metabolico e sospensione alla sbarra.' : ' Con più minuti si aggiungono allungamenti e tenute.')}</p>
      </div>`}
      <ul class="plan">${rows}</ul>
      <p class="small muted" style="margin-top:10px">Tocca un esercizio per aprire la scheda con esecuzione, muscoli coinvolti ed errori da evitare.</p>
      ${swapHtml}
    </div>

    ${done ? '' : `<button class="btn ${(s.isStrength && !core) ? '' : 'teal'}" id="startBtn">${core ? 'Inizia il blocco core' : 'Inizia la sessione'}</button>
    <div class="btn-row" style="margin-top:10px">
      ${core ? '' : '<button class="btn ghost" id="skipBtn">Non la faccio: salta</button>'}
      <button class="btn ghost" id="markBtn">${core ? 'Segna il core come svolto' : 'L\'ho già fatta: segna come svolta'}</button>
    </div>`}
    ${core ? '' : painStatusHtml()}
    ${dayFrom === 'week' ? '' : '<button class="btn ghost" id="toWeek" style="margin-top:10px">Programma della settimana</button>'}
    <p class="small muted" style="margin-top:16px">Programma attivo: ${esc(p.name)} · ${esc(p.periodization)}.</p>
    <button class="btn ghost backbottom" id="dayBack2">‹ ${dayFrom === 'week' ? 'Torna al programma della settimana' : 'Torna a Oggi'}</button>
  `;

  const back = () => { const to = dayFrom === 'week' ? 'week' : null; daySel = null; homeSel = 'session'; homeView = to; renderHome(); window.scrollTo(0, 0); };
  $('#dayBack').onclick = back;
  $('#dayBack2').onclick = back;
  if ($('#toWeek')) $('#toWeek').onclick = () => { daySel = null; homeView = 'week'; renderHome(); window.scrollTo(0, 0); };
  if ($('#skipRest')) $('#skipRest').onclick = () => confirmAction('Saltare le sedute rimaste?',
    `Le ${tpl.left} sedute rimaste della settimana ${tpl.W} vengono segnate come saltate (restano nello storico) e si riparte dalla settimana ${tpl.W + 1}.`,
    'Salta e riparti', () => { snapForUndo(); skipRestOfWeek(); daySel = null; homeView = null; renderHome(); offerUndo('Sedute rimaste saltate.'); });
  document.querySelectorAll('[data-setup]').forEach(x => x.onclick = () => {
    if (current && !current.finished) return;   // non cambiare attrezzatura a sessione aperta
    S.setup = x.dataset.setup; save(); renderHome();
  });
  document.querySelectorAll('[data-dur]').forEach(x => x.onclick = () => {
    const m = +x.dataset.dur;
    const apply = () => { S.durPref = m; planCache = null; save(); renderHome(); };
    if (m === (S.durPref || 45)) return;
    // (8.3) sotto i 45 minuti del programma: avviso se si perdono esercizi o serie
    const loss = core || done ? [] : durationLoss(isToday ? S.sessionIndex : wStart + q, m);
    if (!loss.length) { apply(); return; }
    openModal(`<h2>Seduta da ${m} minuti?</h2>
      <p class="small">Il programma è costruito su <b>${PROGRAM_MIN} minuti</b>: con ${m} minuti questa seduta perde</p>
      <ul class="small" style="margin:6px 0 0 18px">${loss.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <p class="small muted" style="margin-top:10px">Questa scelta potrebbe compromettere la corretta riuscita del programma: i muscoli piccoli (braccia, avambracci, deltoidi posteriori, addome) restano senza il lavoro diretto previsto. La decisione resta tua.</p>
      <button class="btn" id="durKeep" style="margin-top:12px">Resto a ${PROGRAM_MIN} minuti</button>
      <button class="btn ghost" id="durGo" style="margin-top:10px">Scelgo comunque ${m} minuti</button>`);
    $('#durKeep').onclick = () => closeModal(() => { S.durPref = PROGRAM_MIN; planCache = null; save(); renderHome(); });
    $('#durGo').onclick = () => closeModal(apply);
  });
  if ($('#painDayBtn')) $('#painDayBtn').onclick = () => openPainModal({
    title: 'Dolore o fastidio', sub: 'Come stanno ginocchio e spalla oggi? 0 nessun dolore, 10 il peggiore immaginabile. La prossima seduta si regola di conseguenza.',
    onSave: (p, v) => { recordDayPain(p, v); renderHome(); } });
  // ogni riga dell'elenco apre la scheda illustrativa dell'esercizio
  document.querySelectorAll('[data-plan]').forEach(li => li.onclick = () => {
    const it = s.items[+li.dataset.plan];
    openSheet(exById(it.exId), it, { sess: s, after: () => renderHome() });
  });
  bindHomeBanners(b.saved);
  bindKneeAsk(() => renderHome());
  if ($('#swapKind')) $('#swapKind').onclick = () => openSessionPicker(s);

  // una seduta di un altro giorno diventa prima quella di oggi (scambio)
  const commit = () => {
    if (!core && !isToday && q > here) { swapDay(here, q); planCache = null; }
    daySel = null;
    return todaySession(core ? 'core' : null);
  };
  if ($('#markBtn')) $('#markBtn').onclick = () => confirmAction(
    'Segnare la seduta come svolta?',
    `Verranno registrati i ${s.items.length} esercizi di «${s.label}» alle dosi previste (${s.minutes} minuti), senza carichi. Serve quando l'hai svolta senza aprire l'app.`,
    'Segna come svolta', () => { snapForUndo(); markSessionDone(commit()); homeView = dayFrom === 'week' ? 'week' : null; homeSel = 'session'; renderHome(); offerUndo('Seduta segnata come svolta.'); });
  const begin = () => {
    const go1 = () => startSession(commit());
    if (current && !current.finished) {
      confirmAction('Sessione già in corso', 'Vuoi abbandonarla e iniziarne una nuova? Gli esercizi già conclusi restano nello storico.',
        'Inizia una nuova sessione', go1);
    } else go1();
  };
  if ($('#startBtn')) $('#startBtn').onclick = begin;
  if ($('#skipBtn')) $('#skipBtn').onclick = () => confirmAction('Saltare «' + s.label + '»?',
    'Resta nello storico come saltata e il programma passa alla seduta successiva. Niente viene registrato come svolto: nel volume della settimana continuerà a risultare mancante.',
    'Sì, la salto', () => { snapForUndo(); skipSession(commit(), 'Saltata dalla schermata Oggi'); homeView = dayFrom === 'week' ? 'week' : null; renderHome(); offerUndo('Seduta saltata.'); });
}

/* ---------- sessione in corso ---------- */
/* Testo di aiuto della scala RIR (ripetizioni in riserva). */
/* Negli esercizi a tempo la riserva si misura in secondi, non in ripetizioni:
   "quanto avrei resistito ancora" dice quanto margine c'era, ed entra nel
   merito della prestazione (vedi comparePair) e nell'allungamento della
   tenuta suggerita (holdBonus). */
const SEC_HINT = {
  '-1': 'tocca un valore a fine tenuta',
  0: 'al limite: non un secondo di più',
  5: 'cinque secondi di margine',
  10: 'dieci secondi: c\'era spazio',
  15: 'quindici o più: tenuta facile'
};
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
              setLog: sess.items.map(() => []),      // una riga per serie conclusa
              started: Date.now() };
  requestWakeLock();
  unlockAudio();
  prewarmBells(sess.items);        // tracce audio pronte prima della prima serie
  saveResume();
  go('session');
  renderSession();
}

function renderSessionCore() {
  const c = current, s = c.sess, it = s.items[c.pos], ex = exById(it.exId);
  // nel blocco trazioni il livello è fissato e si progredisce con le
  // ripetizioni: resta il richiamo all'ultima volta, non il consiglio di gradino
  const sug0 = suggestLoad(ex, it);
  const sug = (it.level && sug0) ? Object.assign({}, sug0, { value: '', reason: '' }) : sug0;
  refreshDeload();
  $('#topTitle').textContent = s.type === 'stretch' ? 'Mobilità' : s.type === 'cardio' ? 'Aerobico' : 'Sessione';
  $('#topChip').textContent = `${c.pos + 1}/${s.items.length}`;
  $('#topChip').className = 'chip ' + (s.type === 'stretch' ? 'mobility' : s.type === 'cardio' ? 'cardio' : 'strength');

  const bars = s.items.map((_, i) =>
    `<span class="${i === c.pos ? 'now' : (!isOpenItem(c, i) ? 'done' : '')}"></span>`).join('');

  const setBtns = Array.from({ length: it.sets }, (_, i) =>
    `<button data-set="${i}" class="${i < c.setsDone[c.pos] ? 'done' : ''}">${setLabel(it, i)}</button>`).join('');

  // --- carico: numerico, band o gradino della progressione a corpo libero ---
  const steps = ex.load === 'band' ? BANDS : levelsOf(ex);
  const curLoad = c.loads[c.pos] || it.level || (sug && sug.value) || '';
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
  const noLoad = ex.type === 'stretch' || ex.pattern === 'finisher' || ex.pattern === 'cardio';

  // esercizi a tempo: stretching statico, plank, wall sit, tenute isometriche
  const timed = isTimedItem(it, ex);
  const hold = holdOf(it, ex);

  // --- ripetizioni davvero eseguite nell'ultima serie (proposta 1) ---
  const repsVal = (c.repsDone[c.pos] === null || c.repsDone[c.pos] === undefined)
    ? it.reps : c.repsDone[c.pos];
  const repsCtl = (timed || ex.type === 'stretch') ? '' : `
    <div class="repsrow">
      <span class="lab">Ripetizioni di questa serie</span>
      <div class="stepper">
        <button data-rep="-1" aria-label="Una ripetizione in meno">−</button>
        <b class="num" id="repsVal">${repsVal}</b>
        <button data-rep="1" aria-label="Una ripetizione in più">+</button>
      </div>
      <span class="small muted">obiettivo ${it.reps}</span>
    </div>`;

  // --- ripetizioni in riserva (proposta 3) ---
  const rirVal = c.rir[c.pos];
  const rirCtl = timed ? `
    <div class="rirrow">
      <span class="lab">Quanti secondi avresti resistito ancora?</span>
      <div class="rirbtns" role="group" aria-label="Secondi di riserva">
        ${[0, 5, 10, 15].map(v => `<button data-rir="${v}" aria-pressed="${rirVal === v}">${v === 0 ? '0' : (v === 15 ? '15s+' : v + 's')}</button>`).join('')}
      </div>
      <span class="small muted">${SEC_HINT[rirVal === undefined || rirVal === null ? -1 : rirVal]}</span>
    </div>` : `
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
    const rws = Array.isArray(l.setLog) && l.setLog.length ? l.setLog : null;
    if (rws) det.push(rws.map(r => `${r.load ? String(r.load).replace('.', ',') + '×' : ''}${r.hold ? r.hold + 's' : r.reps}`).join(' · '));
    else if (isFinite(l.repsDone)) det.push(`${l.sets}×${l.repsDone}`);
    if (hasNum(l.rir)) det.push(`RIR ${l.rir}`);
    const e = e1rm(l);
    if (e) det.push(`max stimato ${e.toFixed(1)} kg`);
    lastTxt = `Ultima volta: <b>${esc(l.load || '—')}</b>${det.length ? ' · ' + det.join(' · ') : ''} · ${new Date(l.ts).toLocaleDateString('it-IT')} ${starsHtml(l.stars)}`;
    // (7S 1) il carico proposto per oggi, scritto per esteso accanto all'ultima volta
    if (sug.value && ex.load === 'weight') lastTxt += `<br><b>${isAssist(ex) ? 'Assistenza proposta' : 'Proposto oggi'}: ${esc(String(sug.value).replace('.', ','))} kg</b> per ${it.sets}×${it.reps}`;
    if (sug.reason) lastTxt += `<br><span class="small">${esc(sug.reason)}</span>`;
  } else {
    lastTxt = 'Prima volta con questo esercizio: parti prudente e annota carico e ripetizioni.';
  }

  // avviso immediato se il passo rispetto alla volta scorsa è troppo ampio
  // (più carico, oppure meno assistenza di quanto sia prudente)
  let jump = '';
  if (sug && sug.last) {
    // (7S 1) con ripetizioni diverse il riferimento è il carico ricalcolato
    const prevV = sug.converted ? numLoad(sug.value) : logValue(sug.last);
    const nowV = logValue({ exId: it.exId, load: c.loads[c.pos] });
    if (prevV && nowV !== null) {
      const d = isAssist(ex) ? (prevV - nowV) / prevV : (nowV - prevV) / prevV;
      // un solo passo dell'attrezzo non è mai un salto, qualunque percentuale sia
      if (d > SAFE_STEP && Math.abs(nowV - prevV) > minStepFor(ex, prevV) + 0.001) {
        jump = isAssist(ex)
          ? `<div class="warnbox">Stai togliendo il ${Math.round(d * 100)}% dell'assistenza rispetto alla volta scorsa. Meglio un pacco pesi alla volta: le linee guida indicano passi del 2-10%, e qui il rischio è perdere le ultime ripetizioni pulite.</div>`
          : `<div class="warnbox">Stai salendo del ${Math.round(d * 100)}% rispetto ${sug.converted ? 'al carico stimato per le ripetizioni di oggi' : 'alla volta scorsa'}. Le linee guida suggeriscono incrementi del 2-10% per volta: valuta un passo più piccolo, soprattutto se la tecnica peggiora nelle ultime ripetizioni.</div>`;
      }
    }
  }

  const nota = S.exNotes[it.exId] || '';

  // (6.10) sotto le barre: quale esercizio viene dopo, secondo il programma
  // (il primo ancora da fare dopo questo, nell'ordine della seduta)
  const nx = s.items.length > 1 ? nextOpenAfter(c, c.pos) : -1;
  const nxIt = nx >= 0 ? s.items[nx] : null, nxEx = nxIt ? exById(nxIt.exId) : null;
  const nextLine = `<div class="nextline small"><span class="muted">Esercizio ${c.pos + 1} di ${s.items.length}</span> · ${
    nxEx ? `${nx < c.pos ? 'Poi torni a' : 'Prossimo'}: <b>${esc(nxEx.name)}</b> <span class="muted">${doseText(nxIt)}${nx < c.pos ? ' · rimasto da fare' : ''}</span>`
         : '<span class="muted">ultimo esercizio della seduta</span>'}</div>`;

  // (8.3) superserie: come si svolge, scritto per esteso
  const ssMi = ssMateIdx(c, c.pos);
  const ssMate = ssMi >= 0 ? s.items[ssMi] : null;
  const ssBox = ssMate ? (() => {
    const A = it.ssRole === 'A' ? it : ssMate, B = it.ssRole === 'A' ? ssMate : it;
    const nA = exById(A.exId).name, nB = exById(B.exId).name;
    const rounds = Math.max(A.sets, B.sets), rest = Math.max(A.rest, B.rest);
    return `<div class="ssbox"><b>Superserie ${it.ssN || ''}</b> · ${it.ssRole === 'A' ? '1°' : '2°'} esercizio di 2
      <ol class="small"><li>una serie di <b>${esc(nA)}</b>;</li><li>${SS_TRANSFER} secondi per spostarti;</li>
      <li>una serie di <b>${esc(nB)}</b>;</li><li>recupero di ${rest} secondi, poi di nuovo il primo.</li></ol>
      <span class="small muted">${rounds} giri. Il timer ti porta da solo da un esercizio all'altro: tu chiudi la serie con il pulsante in basso.</span></div>`;
  })() : '';
  // (8.7) serie in più: sull'esercizio appena chiuso o su questo, se finito
  const lc = c.lastClosed;
  const lcIt = (lc !== undefined && lc !== null && lc !== c.pos && s.items[lc] && !isOpenItem(c, lc)) ? s.items[lc] : null;
  const extraHtml = (lcIt ? `<div class="extraline small"><span>«${esc(exById(lcIt.exId).name)}» chiuso con ${c.setsDone[lc]} serie${lcIt.extraSets ? ` (${lcIt.extraSets} in più)` : ''}.</span>
      <button class="btn ghost" id="extraPrev">+ una serie in più</button></div>` : '') +
    (c.setsDone[c.pos] >= it.sets && !CARDIO_ROLES.includes(it.role) && ex.type !== 'stretch'
      ? `<div class="extraline small"><span>Serie previste fatte${it.extraSets ? ` · ${it.extraSets} in più` : ''}.</span><button class="btn ghost" id="extraHere">+ una serie in più</button></div>` : '');
  // (8.3) dolore segnato su questo esercizio
  const painBox = it.pain ? `<div class="${it.pain.v >= PAIN_STRONG ? 'warnbox' : 'notice'} painbox">${PAIN_NAME[it.pain.part]} ${it.pain.v}/10 segnato alla serie ${it.pain.set + 1 > it.sets ? it.sets : it.pain.set + 1}: ${
    it.pain.v >= PAIN_STRONG ? 'fermati con questo esercizio: cambialo o chiudilo.' : it.pain.v >= PAIN_LIGHT ? 'serie rimanenti più leggere; la prossima volta l\'esercizio parte più leggero.' : 'lieve, continua se non sale.'}</div>` : '';

  $('#view-session').innerHTML = `
    <div class="progress">${bars}</div>
    ${nextLine}
    ${ssBox}
    ${s.items.length > 1 ? `<div class="swipehint">${c.pos > 0 ? '‹ precedente' : ''}${c.pos > 0 && c.pos < s.items.length - 1 ? ' · ' : ''}${c.pos < s.items.length - 1 ? 'successivo ›' : ''} — scorri col dito, il timer continua</div>` : ''}
    <div class="exercise">
      <div class="fig-large">${figureMotion(ex)}</div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-top:14px">
        <div><h2>${esc(ex.name)}</h2>
          <div class="small muted">${esc(ex.group)} · ${esc(it.goalLabel)} · RPE ${esc(it.rpe)}</div></div>
        <div class="dose-big num">${doseText(it)}<br><small>rec. ${it.rest}s</small></div>
      </div>

      ${nota ? `<div class="exnote" id="noteShow">📌 ${esc(nota)}</div>` : ''}

      ${painBox}
      ${extraHtml}
      ${warmupHtml(c, it, ex, sug, s)}
      <div class="setdots">${setBtns}</div>
      ${setRowsHtml(c.pos)}

      ${noLoad ? '' : `
      ${isAssist(ex) ? `<div class="assistnote">Il numero è <b>l'aiuto</b>, non il peso sollevato: più è basso, più sei forte. Progredire significa ridurlo.</div>` : ''}
      ${rackNote(ex) ? `<p class="small muted" style="margin-top:10px">${esc(rackNote(ex, ex.rack === 'barbell' ? (c.loads[c.pos] || curLoad) : null))}</p>` : ''}
      <div class="loadrow">
        ${loadCtl}
        <div class="feedback">
          <button data-fb="up"   aria-pressed="${c.feedback[c.pos] === 'up'}" aria-label="Più facile del previsto${isAssist(ex) ? ': la prossima volta meno assistenza' : ''}">↑</button>
          <button data-fb="same" aria-pressed="${c.feedback[c.pos] === 'same'}" aria-label="Invariato">–</button>
          <button data-fb="down" aria-pressed="${c.feedback[c.pos] === 'down'}" aria-label="Più difficile del previsto">↓</button>
        </div>
      </div>
      ${c.setsDone[c.pos] > 0 && c.setsDone[c.pos] < it.sets && c.loads[c.pos] && ex.load === 'weight' ? `<p class="small muted" style="margin:6px 0 0">Serie ${c.setsDone[c.pos] + 1}: riparte dal carico dell'ultima serie (${esc(String(c.loads[c.pos]).replace('.', ','))} kg). Se vuoi salire o scendere, cambialo qui.</p>` : ''}
      ${repsCtl}
      ${rirCtl}
      <p class="lasttime">${lastTxt}</p>
      ${jump}`}

      ${it.holdBonus ? `<p class="small muted" style="margin-top:10px">Tenuta allungata di ${it.holdBonus} s rispetto alla base: nelle ultime sedute hai chiuso con almeno dieci secondi di margine.</p>` : ''}
      ${timerRunning() && !chainHasWork() ? `<p class="small muted" style="margin-top:14px">Recupero in corso: il pulsante si riattiva allo scadere. Intanto puoi aprire la scheda dell'esercizio; «Salta» sulla barretta lo chiude in anticipo.</p>` : ''}
      ${chainHasWork() ? `<p class="small muted" style="margin-top:14px">Sequenza in corso: il timer avanza da solo fra tenute e pause e conta le serie.</p>` : ''}
      ${timed && !chainHasWork() && c.setsDone[c.pos] < it.sets ? `<p class="small muted" style="margin-top:14px">${
        it.sets - c.setsDone[c.pos] > 1
          ? it.goal === 'cardioRun'
            ? `Un solo tocco avvia tutta la corsa-camminata: 3 secondi di preparazione, poi ${it.sets - c.setsDone[c.pos]} tratti di corsa da ${hold} secondi alternati a ${it.rest} secondi di camminata. Rintocchi nei 3 secondi prima di ogni cambio, colpo acuto alla fine: puoi tenere il telefono in tasca. Corsa lenta, in cui riesci a parlare; dolore al ginocchio al massimo 2 su 10, altrimenti cammina.`
          : (it.role === 'finisher' || it.role === 'cardio')
            ? `Un solo tocco avvia tutti gli intervalli: 3 secondi di preparazione, poi ${it.sets - c.setsDone[c.pos]} scatti da ${hold} secondi alternati a ${it.rest} secondi a ritmo tranquillo, senza fermarti. Rintocchi nei 3 secondi prima di ogni scatto e negli ultimi 3, colpo acuto alla fine.`
            : `Un solo tocco avvia tutta la sequenza: 3 secondi di preparazione, poi ${it.sets - c.setsDone[c.pos]} tenute da ${hold} secondi con ${it.rest} secondi di pausa fra una e l'altra${c.pos < s.items.length - 1 ? ', infine il recupero prima dell\'esercizio successivo' : ''}. Il timer avanza da solo: rintocchi nei 3 secondi prima di ogni tenuta e negli ultimi 3 secondi di ciascuna, colpo acuto alla fine.`
          : ['finisher', 'cardio', 'warmup', 'cooldown'].includes(it.role)
            ? `3 secondi di preparazione, poi ${Math.round(hold / 60)} minuti continui. Rintocchi prima dell'inizio e negli ultimi 3 secondi, colpo acuto alla fine.${CARDIO_ROLES.includes(it.role) && c.pos < s.items.length - 1 && CARDIO_ROLES.includes(s.items[c.pos + 1].role) ? ' La parte successiva parte da sola.' : ''}`
            : `3 secondi di preparazione, poi una tenuta da ${hold} secondi. Rintocchi nei 3 secondi prima dell'inizio e negli ultimi 3, colpo acuto alla fine.`
        }${it.perSide ? ' Le tenute alternano sinistra e destra.' : ''}</p>` : ''}

      ${timed && c.setsDone[c.pos] < it.sets && !timerRunning() ? `<div class="btn-row" style="margin-top:12px">
        <button class="btn ghost" id="stopwatchBtn">Cronometro: tieni finché riesci</button>
      </div>` : ''}

      <div class="btn-row" style="margin-top:14px">
        <button class="btn ghost" id="infoBtn">Scheda esercizio</button>
        <button class="btn ghost" id="swapBtn">${s.type === 'cardio' && CARDIO_ROLES.includes(it.role) ? 'Cambia attrezzo' : `Cambia esercizio${nAlt > 1 ? ` (${nAlt - 1})` : ''}`}</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="noteBtn">${nota ? 'Modifica nota' : 'Aggiungi nota'}</button>
        <button class="btn ghost" id="orderBtn" ${c.pos === s.items.length - 1 ? 'disabled' : ''}>Ordine esercizi</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="postponeBtn" ${c.pos === s.items.length - 1 ? 'disabled' : ''}>Macchina occupata: passa a un altro</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="dayPlanBtn">Programma di oggi</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost painbtn" id="painBtn">Dolore o fastidio a spalla o ginocchio</button>
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
    <button class="btn secondary" id="nextBtn">${nextOpenAfter(c, c.pos) < 0 ? 'Chiudi seduta' : 'Chiudi esercizio'}</button>`;
  $('#actionBar').classList.add('on');

  // I pallini servono a CORREGGERE il conteggio, non ad avanzarlo: toccarne uno
  // già spento non conclude la serie, la marca soltanto. Portare il conteggio
  // al massimo con un tocco chiede conferma, perché equivale a dichiarare
  // l'esercizio finito e prima era il modo più facile per perdere una serie.
  document.querySelectorAll('[data-setedit]').forEach(b => b.onclick = () => editSet(c.pos, +b.dataset.setedit));
  // (8) serie di avvicinamento: non si registrano, avviano solo un breve recupero
  document.querySelectorAll('[data-wu]').forEach(b => b.onclick = () => {
    if (timerRunning()) return;
    captureLoad();
    const i = +b.dataset.wu;
    it.wuDone = it.wuDone || [];
    it.wuDone[i] = true;
    saveResume();
    const left = warmupSteps(it).length - it.wuDone.filter(Boolean).length;
    renderSession();
    startTimer(left > 0 ? 45 : 75, left > 0 ? `Avvicinamento · poi la serie successiva di riscaldamento` : `Avvicinamento finito · poi la prima serie di ${ex.name}`, null, 'rest', 0, { mini: true });
  });
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
  $('#dayPlanBtn').onclick = () => { captureLoad(); openDayPlan(); };
  if ($('#extraPrev')) $('#extraPrev').onclick = () => { captureLoad(); addExtraSet(lc); };
  if ($('#extraHere')) $('#extraHere').onclick = () => { captureLoad(); addExtraSet(c.pos); };
  // (8.3) dolore durante l'esercizio
  $('#painBtn').onclick = () => { captureLoad(); openPainModal({
    part: partOfEx(ex) || (it.pain && it.pain.part) || 'shoulder',
    title: `Dolore o fastidio · ${ex.name}`,
    onSave: (p, v) => sessionPain(it, ex, p, v) }); };

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
    if (c.lastClosed !== c.pos) c.lastClosed = undefined;
    const before = c.setsDone[c.pos];
    if (before < it.sets) c.setsDone[c.pos] = before + 1;
    const done = c.setsDone[c.pos];
    const rirNow = c.rir[c.pos];
    recordSet(c.pos);                       // carico e ripetizioni di QUESTA serie
    // (8) la riserva si indica serie per serie: si riparte vuoti
    c.rir[c.pos] = null;
    saveResume();
    if (done >= it.sets) { concludeExercise(); return; }
    // (8) recupero adattivo: +30 s dopo una serie al limite, -15 s con 3 o più di riserva
    const ad = adaptiveRest(it.rest, rirNow);
    // (8) superserie: si passa all'altro esercizio
    const mi = ssMateIdx(c, c.pos);
    if (mi >= 0 && c.setsDone[mi] < s.items[mi].sets) {
      const mate = s.items[mi], mex = exById(mate.exId);
      const sec = it.ssRole === 'A' ? SS_TRANSFER : adaptiveRest(Math.max(it.rest, mate.rest), rirNow).sec;
      c.pos = mi; saveResume(); renderSession();
      startTimer(sec, `Superserie · ${mex.name} · serie ${c.setsDone[mi] + 1} di ${mate.sets}${it.ssRole === 'A' ? '' : ad.why}`, null, 'rest');
      return;
    }
    renderSession();
    startTimer(ad.sec, `Serie ${done + 1} di ${it.sets}${it.perSide ? ' · ' + (done % 2 ? 'Dx' : 'Sx') : ''} · ${ex.name}${ad.why}`, null, 'rest');
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
    const nextPos = nextOpenAfter(c, c.pos);
    const last = nextPos < 0;
    const nextName = last ? '' : exById(s.items[nextPos].exId).name;
    const side = k => it.perSide ? ' · ' + (k % 2 ? 'Dx' : 'Sx') : '';
    const defs = holdChainDefs(it, ex, c.setsDone[c.pos], last);
    defs.forEach((d, i) => {
      if (d.kind === 'work') {
        d.what = it.sets === 1 ? `${it.workLabel || 'Tenuta'} · ${ex.name}`
          : `${it.workLabel || 'Tenuta'} ${d.set + 1} di ${it.sets}${side(d.set)} · ${ex.name}`;
        d.onEnd = (seg) => {
          // la tenuta conta sull'esercizio da cui è partita, anche se nel
          // frattempo sei passato a un'altra schermata scorrendo
          if (!current || current.finished || current.started !== atSid) return false;
          const at = current.sess.items.indexOf(atIt);
          if (at < 0 || atIt.exId !== atEx) return false;
          current.setsDone[at] = Math.min(it.sets, current.setsDone[at] + 1);
          // secondi davvero tenuti: se hai chiuso prima con «Termina la
          // tenuta», o allungato con +15 s, è quello che finisce nello storico
          const held = seg ? Math.max(1, Math.round((seg.end - seg.start) / 1000)) : it.hold;
          recordSet(at, { hold: held });
          saveResume();
          if (current.setsDone[at] >= it.sets) {
            if (current.pos === at) { concludeExercise(true); return true; }
            logExercise(at);                   // registrato senza strapparti dalla schermata in cui sei
          }
          renderSession();
          return true;
        };
      } else if (d.kind === 'rest' && d.final) {
        const nextIt = last ? null : s.items[nextPos];
        const flow = CARDIO_ROLES.includes(it.role) && nextIt && CARDIO_ROLES.includes(nextIt.role);
        d.what = flow ? `Poi: ${(nextIt.workLabel || nextName)}` : `Recupero · poi ${nextName}`;
        d.onStart = () => minimizeTimer();       // lascia vedere il prossimo esercizio
        // nell'aerobico riscaldamento, parte centrale e defaticamento si
        // susseguono da soli: non serve toccare il telefono sulla macchina
        if (flow) d.onEnd = () => {
          setTimeout(() => {
            if (!timerRunning() && current && !current.finished && current.started === atSid &&
                current.sess.items[current.pos] === nextIt && $('#doneSet')) $('#doneSet').onclick();
          }, 50);
          return false;
        };
      } else if (d.kind === 'rest') {
        const nx = defs[i + 1];
        d.what = `${it.restLabel || 'Pausa'} · poi ${(it.workLabel || 'tenuta').toLowerCase()} ${nx.set + 1} di ${it.sets}${side(nx.set)}`;
      }
    });
    defs[0].what = defs[1].what;                 // la preparazione annuncia la prima tenuta
    runChain(defs);
    renderSession();
  };

  /* Cronometro: la tenuta dura quanto riesci. Tre secondi di preparazione con
     le campanelle, poi il contatore sale; «Fine tenuta» ferma, registra i
     secondi davvero tenuti e avvia la pausa. Serve quando il tempo previsto
     non è il punto — plank, wall sit, sospensione portata al limite. */
  const runStopwatch = () => {
    const atSid = c.started, atIt = it, atEx = it.exId;
    const label = it.workLabel || 'Tenuta';
    const defs = [
      { kind: 'prep', dur: 3, what: `Preparati · ${label} · ${ex.name}` },
      { kind: 'work', dur: 3600, what: `${label} a cronometro · ${ex.name}`, onEnd: (seg) => {
          if (!current || current.finished || current.started !== atSid) return false;
          const at = current.sess.items.indexOf(atIt);
          if (at < 0 || atIt.exId !== atEx) return false;
          const held = Math.max(1, Math.round((Date.now() - seg.start) / 1000));
          current.setsDone[at] = Math.min(it.sets, current.setsDone[at] + 1);
          recordSet(at, { hold: held });
          saveResume();
          if (current.setsDone[at] >= it.sets) {
            if (current.pos === at) { concludeExercise(); return true; }
            logExercise(at); renderSession(); return true;
          }
          startTimer(it.rest, `Pausa · poi ${label.toLowerCase()} ${current.setsDone[at] + 1} di ${it.sets} · ${ex.name}`, null, 'rest');
          return true;
        } }];
    runChain(defs, { countUp: true });
    renderSession();
  };

  if ($('#stopwatchBtn')) $('#stopwatchBtn').onclick = () => { if (!timerRunning()) { captureLoad(); runStopwatch(); } };

  $('#doneSet').onclick = () => {
    if (timerRunning()) return;                  // un timer è già in corso
    captureLoad();
    // con tutte le serie già segnate non c'è una tenuta da cronometrare:
    // il pulsante chiude e basta
    if (timed && !allDone) runHolds();
    else closeSet();
  };
  $('#infoBtn').onclick = () => openSheet(ex, it, { sess: s, after: () => renderSession() });
  // (8.4) seduta aerobica: si cambia l'attrezzo di tutta la seduta (e, se
  // non è ancora iniziata, anche il tipo di lavoro)
  if (s.type === 'cardio' && CARDIO_ROLES.includes(it.role)) $('#swapBtn').onclick = () => { captureLoad(); openCardioPicker(s, sessionMeta(s.idx), { live: true }); };
  else $('#swapBtn').onclick = () => openExercisePicker(it, s, changed => {
    if (changed) {
      if (chainHasWork()) stopTimer();          // le tenute in corso erano dell'esercizio sostituito
      c.setsDone[c.pos] = 0; c.loads[c.pos] = ''; c.feedback[c.pos] = null;
      c.repsDone[c.pos] = null; c.rir[c.pos] = null; c.setLog[c.pos] = [];
    }
    saveResume(); renderSession();
  });
  $('#noteBtn').onclick = () => editNote(it.exId, () => renderSession());
  if ($('#noteShow')) $('#noteShow').onclick = () => editNote(it.exId, () => renderSession());
  $('#postponeBtn').onclick = () => { captureLoad(); releaseTimerForMove(); postponeCurrent(); };
  $('#orderBtn').onclick = () => { captureLoad(); openReorder(); };

  // il timer di recupero accompagna al prossimo esercizio: passando avanti
  // continua a scorrere, si stacca solo l'azione automatica che aveva in coda
  const goNext = () => { releaseTimerForMove(); nextExercise(); };
  $('#nextBtn').onclick = () => {
    captureLoad();
    if (nextOpenAfter(c, c.pos) < 0) {
      confirmAction('Chiudere la sessione?', 'Non restano altri esercizi aperti: chiudendo questo si conclude la seduta.',
        'Chiudi la sessione', () => { stopTimer(); nextExercise(); });
    } else if (c.setsDone[c.pos] < it.sets) {
      confirmAction('Chiudere questo esercizio?',
        `Hai completato ${c.setsDone[c.pos]} serie su ${it.sets}: verrà registrato così. Per guardare solo un altro esercizio, scorri lo schermo.`, 'Chiudi e vai avanti', goNext);
    } else goNext();
  };
  $('#abortBtn').onclick = () => {
    openModal(`<h2>Interrompere la seduta?</h2>
      <p class="small muted">Gli esercizi già conclusi restano nello storico. Scegli cosa farne:</p>
      <button class="btn" id="abLater" style="margin-top:12px">La riprendo più tardi</button>
      <p class="small muted" style="margin-top:6px">La seduta resta quella di oggi e la ritrovi in Oggi con «Riprendi».</p>
      <button class="btn ghost" id="abSkip" style="margin-top:12px">Non la faccio: salta e vai alla prossima</button>
      <p class="small muted" style="margin-top:6px">Resta nello storico come saltata e il programma avanza alla seduta successiva.</p>
      <button class="btn ghost" id="abNo" style="margin-top:12px">Annulla</button>`);
    const leave = () => { stopTimer(); releaseWakeLock(); current = null; goToday(); };
    $('#abLater').onclick = () => closeModal(() => { leave(); saveResumeFromAbort(s, c); });
    $('#abSkip').onclick = () => closeModal(() => { const sess = s; leave(); clearResume(); skipSession(sess, 'Saltata dopo aver interrotto la seduta'); goToday(); });
    $('#abNo').onclick = () => closeModal();
  };
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
  [s.items, c.setsDone, c.loads, c.feedback, c.logRef, c.repsDone, c.rir, c.setLog].forEach(arr => {
    const v = arr.splice(from, 1)[0];
    arr.splice(to, 0, v);
  });
  saveResume();
}

/* (8) «Macchina occupata»: l'esercizio corrente va in fondo e si passa al
   successivo ancora da fare che, se possibile, lavora un gruppo muscolare
   diverso da quello dell'esercizio appena concluso. */
function postponeCurrent() {
  const c = current, s = c.sess;
  if (c.pos >= s.items.length - 1) return;
  moveItem(c.pos, s.items.length - 1);
  const mine = S.logs.filter(l => l.sid === c.started);
  const prevEx = mine.length ? exById(mine[mine.length - 1].exId) : null;
  const prevG = prevEx ? primaryGroups(prevEx)[0] : null;
  const open = [];
  for (let j = c.pos; j < s.items.length - 1; j++) if (isOpenItem(c, j)) open.push(j);
  const pick = open.find(j => { const e = exById(s.items[j].exId); return !prevG || !e || primaryGroups(e)[0] !== prevG; });
  const j = pick !== undefined ? pick : open[0];
  if (j !== undefined && j !== c.pos) moveItem(j, c.pos);
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

/* ---------------------------------------------------------------------------
   REGISTRAZIONE SERIE PER SERIE (dalla 5.11)
   Prima l'app teneva un solo carico e un solo numero di ripetizioni per
   esercizio: se alzavi il peso alla seconda serie, la fatica si scaricava
   sulla terza ma nei numeri non si vedeva nulla. Ora ogni serie conclusa
   lascia la sua riga (carico, ripetizioni o secondi, riserva) e il confronto
   fra sedute usa i totali veri: tonnellaggio, ripetizioni, secondi.
--------------------------------------------------------------------------- */
function recordSet(pos, extra) {
  const c = current;
  if (!c) return;
  const it = c.sess.items[pos], ex = exById(it.exId);
  const timed = isTimedItem(it, ex);
  const rd = c.repsDone[pos];
  const row = Object.assign({
    load: c.loads[pos] || '',
    reps: timed ? 1 : ((rd === null || rd === undefined) ? it.reps : rd),
    hold: timed ? (it.hold || 0) : 0,
    rir: (c.rir[pos] === null || c.rir[pos] === undefined) ? null : c.rir[pos]
  }, extra || {});
  c.setLog[pos] = c.setLog[pos] || [];
  const n = Math.max(0, c.setsDone[pos] - 1);     // la serie appena chiusa
  c.setLog[pos][n] = row;
  saveResume();
}

/* Riepilogo compatto delle serie già registrate, con la riga toccabile per
   correggere ciò che è stato annotato male. */
function setRowsHtml(pos) {
  const c = current, it = c.sess.items[pos], ex = exById(it.exId);
  const rows = (c.setLog[pos] || []).slice(0, c.setsDone[pos]);
  if (!rows.length) return '';
  const timed = isTimedItem(it, ex);
  return `<div class="setlog">
    ${rows.map((r, i) => `<button data-setedit="${i}">
      <span class="n">${setLabel(it, i)}</span>
      <span class="v">${timed ? `${r.hold || 0}s` : `${r.reps} rip`}${r.load ? ' · ' + esc(String(r.load).replace('.', ',')) + (ex.load === 'weight' ? ' kg' : '') : ''}${
        r.rir === null || r.rir === undefined ? '' : ` · ${timed ? r.rir + 's di margine' : 'RIR ' + r.rir}`}</span>
      <span class="chev">✎</span></button>`).join('')}
  </div>`;
}

/* (8.4) Il programma del giorno a seduta aperta: lo stesso elenco di
   «Allenamento del giorno» (superserie, dosi, note), con lo stato di ogni
   esercizio. Tocca la riga per la scheda, «Vai» per passarci (come scorrere:
   non registra nulla e il timer continua). */
function openDayPlan() {
  const c = current;
  if (!c || c.finished) return;
  const s = c.sess;
  const rows = s.items.map((it, i) => {
    const ex = exById(it.exId);
    if (!ex) return '';
    const doneN = c.setsDone[i] || 0, logged = c.logRef[i] !== null && c.logRef[i] !== undefined;
    const state = i === c.pos ? 'in corso' : (!isOpenItem(c, i) ? 'fatto' : doneN ? `${doneN} di ${it.sets} serie` : 'da fare');
    const ssHead = it.ss && it.ssRole === 'A' ? `<li class="sshead"><b>Superserie ${it.ssN || ''}</b> · una serie del primo, 20 s per spostarti, una serie del secondo, poi il recupero.</li>` : '';
    return ssHead + `<li data-dp="${i}" class="${it.ss ? 'ssrow' : ''}${i === c.pos ? ' now' : ''}${!isOpenItem(c, i) || logged ? ' isdone' : ''}">
      <div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm"><b>${esc(ex.name)}</b><span class="small muted">${esc(state)} · ${doseText(it)}${it.note ? ' · ' + esc(it.note) : ''}</span></div>
      ${i === c.pos ? '' : `<button class="goto" data-goto="${i}">Vai</button>`}</li>`;
  }).join('');
  openModal(`<h2>Programma di oggi</h2>
    <p class="small muted">${esc(s.label)} · esercizio ${c.pos + 1} di ${s.items.length}. Tocca un esercizio per la scheda, «Vai» per passarci: non si registra nulla e il timer continua.</p>
    <ul class="plan" style="margin-top:10px">${rows}</ul>
    <button class="btn secondary" id="dpClose" style="margin-top:14px">Torna all'esercizio</button>`);
  $('#dpClose').onclick = () => closeModal();
  document.querySelectorAll('[data-goto]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const i = +b.dataset.goto;
    closeModal(() => { if (!current || current.finished) return; current.pos = i; saveResume(); renderSession(); window.scrollTo(0, 0); });
  });
  document.querySelectorAll('[data-dp]').forEach(li => li.onclick = () => {
    const it = s.items[+li.dataset.dp];
    closeModal(() => openSheet(exById(it.exId)));
  });
}

/* (8.3) Dolore segnato durante un esercizio della seduta in corso. */
function sessionPain(it, ex, part, v) {
  const c = current;
  if (!c || c.finished) return;
  const pos = c.sess.items.indexOf(it);
  if (pos < 0) return;
  const prev = it.pain && it.pain.part === part ? it.pain.v : -1;
  it.pain = { part, v: Math.max(prev, v), set: c.setsDone[pos] };
  S.painLog = Array.isArray(S.painLog) ? S.painLog : [];
  S.painLog.push({ ts: Date.now(), part, v, when: 'set', exId: it.exId, sid: c.started, sIdx: c.sess.idx, set: c.setsDone[pos] });
  // esercizio già registrato: il dolore va anche sulla registrazione
  const ref = c.logRef[pos];
  if (ref !== null && ref !== undefined && S.logs[ref]) S.logs[ref].pain = Object.assign({}, it.pain);
  let msg = 'annotato. Continua se resta lieve e non sale.';
  if (v >= PAIN_LIGHT) {
    const lv = lighterValue(ex, c.loads[pos] || (suggestLoad(ex, it) || {}).value || '', it);
    if (lv && c.setsDone[pos] < it.sets) { c.loads[pos] = lv.value; msg = `serie che restano: ${lv.how} (${String(lv.value).replace('.', ',')}${ex.load === 'weight' ? ' kg' : ''}).`; }
    else msg = 'la prossima volta l\'esercizio parte più leggero.';
  }
  saveResume(); save();
  renderSession();
  if (v < PAIN_STRONG) { showToast(`<div><b>${PAIN_NAME[part]} ${v}/10</b>: ${esc(msg)}</div>`, 4200); return; }
  // dolore forte: fermarsi con questo esercizio
  openModal(`<h2>${PAIN_NAME[part]} ${v}/10: fermati</h2>
    <p class="small">Con un dolore forte non continuare con <b>${esc(ex.name)}</b>. Per il resto della seduta gli esercizi che caricano ${part === 'knee' ? 'il ginocchio' : 'la spalla'} propongono carichi più bassi; la prossima seduta usa esercizi più tollerabili per questo distretto.</p>
    <p class="small muted">Se il dolore non passa in pochi giorni, o compare anche a riposo, senti il medico o il fisioterapista.</p>
    <button class="btn" id="pSwap" style="margin-top:12px">Cambia esercizio</button>
    <button class="btn ghost" id="pAvoid" style="margin-top:10px">Chiudi l'esercizio ed escludilo per 2 settimane</button>
    <button class="btn ghost" id="pClose" style="margin-top:10px">Chiudi solo l'esercizio</button>
    <button class="btn ghost" id="pStay" style="margin-top:10px">Continuo comunque, con prudenza</button>`);
  $('#pSwap').onclick = () => closeModal(() => { const b = $('#swapBtn'); if (b) b.click(); });
  $('#pAvoid').onclick = () => closeModal(() => {
    S.avoid = Object.assign({}, S.avoid || {});
    S.avoid[ex.id] = Date.now() + 14 * 864e5;
    save(); planCache = null;
    showToast(`<div>«${esc(ex.name)}» fuori dalle proposte fino al ${dateIt(S.avoid[ex.id])}.</div>`, 4200);
    const b = $('#nextBtn'); if (b) b.click();
  });
  $('#pClose').onclick = () => closeModal(() => { const b = $('#nextBtn'); if (b) b.click(); });
  $('#pStay').onclick = () => closeModal();
}

/* Correzione di una serie già registrata. */
function editSet(pos, i) {
  const c = current, it = c.sess.items[pos], ex = exById(it.exId);
  const r = (c.setLog[pos] || [])[i] || {};
  const timed = isTimedItem(it, ex);
  const scale = ex.load === 'weight' ? rackOf(ex) : null;
  const steps = ex.load === 'band' ? BANDS : levelsOf(ex);
  let loadCtl = '';
  if (steps) loadCtl = `<select id="esLoad">${steps.map(b => `<option ${r.load === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>`;
  else if (scale) loadCtl = `<select id="esLoad"><option value="">—</option>${scale.map(v => `<option value="${v}" ${String(v) === String(r.load) ? 'selected' : ''}>${String(v).replace('.', ',')} kg</option>`).join('')}</select>`;
  else if (ex.load === 'weight') loadCtl = `<input id="esLoad" type="number" inputmode="decimal" step="0.5" value="${esc(r.load || '')}">`;
  openModal(`<h2>${esc(setLabel(it, i))} · ${esc(ex.name)}</h2>
    <p class="small muted">Correggi quello che hai davvero fatto in questa serie.</p>
    ${loadCtl ? `<div class="field"><label>${isAssist(ex) ? 'Assistenza' : 'Carico'}</label>${loadCtl}</div>` : ''}
    <div class="field"><label>${timed ? 'Secondi tenuti' : 'Ripetizioni'}</label>
      <input id="esReps" type="number" inputmode="numeric" min="0" max="${timed ? 900 : 99}" value="${timed ? (r.hold || 0) : (r.reps || 0)}"></div>
    <div class="field"><label>${timed ? 'Secondi di riserva' : 'Ripetizioni di riserva'}</label>
      <input id="esRir" type="number" inputmode="numeric" min="0" max="${timed ? 60 : 9}" value="${r.rir === null || r.rir === undefined ? '' : r.rir}"></div>
    <button class="btn" id="esOk" style="margin-top:12px">Salva</button>
    <button class="btn ghost" id="esNo" style="margin-top:10px">Annulla</button>`);
  $('#esOk').onclick = () => {
    const v = parseInt($('#esReps').value, 10);
    const rr = $('#esRir').value === '' ? null : parseInt($('#esRir').value, 10);
    const row = Object.assign({}, r);
    if (isFinite(v)) { if (timed) row.hold = v; else row.reps = v; }
    row.rir = isFinite(rr) ? rr : null;
    if ($('#esLoad')) row.load = $('#esLoad').value;
    c.setLog[pos][i] = row;
    // (7S 1) in revisione l'esercizio è già nello storico: va riscritto alla chiusura
    c.dirty = c.dirty || {}; c.dirty[pos] = true;
    // (8) correggendo il carico dell'ultima serie, la prossima parte da lì
    if (i === c.setsDone[pos] - 1 && row.load !== undefined && row.load !== '') c.loads[pos] = row.load;
    if (c.logRef[pos] !== null && c.logRef[pos] !== undefined) logExercise(pos);
    saveResume();
    closeModal(() => renderSession());
  };
  $('#esNo').onclick = () => closeModal();
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

/* Interrompendo "la riprendo più tardi" lo stato resta su disco com'era:
   saveResume l'ha già scritto a ogni modifica, quindi qui non serve altro. */
function saveResumeFromAbort() {}

function saveResume() {
  if (!current || current.finished) return;
  const c = current;
  S.resume = {
    ts: Date.now(), started: c.started, pos: c.pos,
    kind: c.sess.kind, idx: c.sess.idx,
    items: c.sess.items,                      // la seduta può essere stata riordinata
    label: c.sess.label, type: c.sess.type, mWeek: c.sess.mWeek, mDay: c.sess.mDay,
    focusKey: c.sess.focusKey, lunchLabel: c.sess.lunchLabel, run: c.sess.run || null, mode: c.sess.mode || null,
    setsDone: c.setsDone, loads: c.loads, feedback: c.feedback,
    repsDone: c.repsDone, rir: c.rir, logRef: c.logRef, setLog: c.setLog,
    review: !!c.review, dirty: c.dirty || {}
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
    mWeek: r.mWeek, mDay: r.mDay, focusKey: r.focusKey, lunchLabel: r.lunchLabel,
    ...(r.run ? { run: r.run } : {}), ...(r.mode ? { mode: r.mode } : {}),
    minutes: estimateMinutes(r.items)
  });
  current = { sess, pos: r.pos, setsDone: r.setsDone, loads: r.loads,
              feedback: r.feedback, logRef: r.logRef,
              repsDone: r.repsDone || r.items.map(() => null),
              rir: r.rir || r.items.map(() => null),
              setLog: r.setLog || r.items.map(() => []),
              review: !!r.review, dirty: r.dirty || {},
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
/* (8) Serie di avvicinamento sul primo esercizio fondamentale di forza:
   percentuali del carico di lavoro proposto (regola operativa dell'app, il
   tempo è già compreso nella stima della seduta). */
const warmupSteps = it => it.goal === 'strength' ? [[0.5, 8], [0.7, 4], [0.85, 2]] : [[0.5, 8], [0.75, 4]];
function warmupHtml(c, it, ex, sug, s) {
  const firstKey = s.items.findIndex(x => x.role === 'key');
  if (s.type !== 'strength' || c.pos !== firstKey || !ex || ex.load !== 'weight' || isAssist(ex) || c.setsDone[c.pos] > 0) return '';
  const w = numLoad(c.loads[c.pos] || (sug && sug.value) || '');
  const done = it.wuDone || [];
  const kg = v => String(v).replace('.', ',');
  const rows = warmupSteps(it).map(([p, r], i) => {
    const load = w > 0 ? snapLoad(ex, w * p, -1) : null;
    return `<li class="${done[i] ? 'done' : ''}"><span class="n">${Math.round(p * 100)}%</span>
      <span class="v">${r} rip${load ? ` · <b>${kg(load)} kg</b>` : ''}</span>
      ${done[i] ? '<span class="ok">✓</span>' : `<button class="wubtn" data-wu="${i}" ${timerRunning() ? 'disabled' : ''}>Fatta</button>`}</li>`;
  }).join('');
  return `<div class="warmup">
    <div class="wuhead"><b>Avvicinamento</b> <span class="small muted">${w > 0 ? `percentuali di ${kg(w)} kg` : 'carico leggero, che senti facile'} · non si registra</span></div>
    <ul>${rows}</ul></div>`;
}

/* (8) Recupero adattivo: dopo una serie chiusa al limite (0 ripetizioni di
   riserva) il recupero si allunga di 30 s; con 3 o più di riserva si accorcia
   di 15 s, mai sotto i 30 s. Regola operativa dell'app, coerente con Singer et
   al. 2024: oltre i 60 s il recupero aiuta, oltre i 90 s non aggiunge. */
function adaptiveRest(base, rir) {
  if (rir === 0) return { sec: base + 30, why: ' · recupero +30 s: serie al limite' };
  if (rir !== null && rir !== undefined && rir >= 3) return { sec: Math.max(30, base - 15), why: ' · recupero -15 s: margine ampio' };
  return { sec: base, why: '' };
}
/* (8) Compagno di superserie ancora nella seduta. */
function ssMateIdx(c, pos) {
  const it = c.sess.items[pos];
  if (!it || !it.ss) return -1;
  return c.sess.items.findIndex((x, j) => j !== pos && x.ss === it.ss);
}

/* (8.7) Serie in più rispetto a quelle previste: si aggiungono all'esercizio
   (anche già chiuso) e si registrano come le altre. Contano nel volume e nei
   record; le stelle confrontano solo le serie previste, così una serie in più
   fatta con la stanchezza non abbassa il giudizio e non lo gonfia. */
function addExtraSet(pos) {
  const c = current;
  if (!c || c.finished) return;
  const it = c.sess.items[pos];
  if (!it) return;
  const k = it.perSide ? 2 : 1;
  it.sets += k; it.extraSets = (it.extraSets || 0) + k;
  c.lastClosed = undefined;
  c.pos = pos; saveResume(); renderSession(); window.scrollTo(0, 0);
}
function concludeExercise(inChain) {
  const c = current, s = c.sess;
  c.lastClosed = c.pos;                    // (8.7) per offrire «una serie in più»
  const it = s.items[c.pos], ex = exById(it.exId);
  const last = nextOpenAfter(c, c.pos) < 0;
  if (!inChain) stopTimer();
  nextExercise();
  if (last || !current || current.finished) return;
  if (!inChain) {
    const nxIt = s.items[c.pos], nx = exById(nxIt.exId);
    // (8) dentro la superserie il passaggio è breve
    const rest = (it.ss && nxIt.ss === it.ss) ? SS_TRANSFER : finalRestOf(it, ex);
    startTimer(rest, `${it.ss && nxIt.ss === it.ss ? 'Superserie' : 'Recupero'} · poi ${nx.name}`, null, 'rest', 0, { mini: true });
    renderSession();                             // il pulsante resta in attesa del recupero
  }
}

/* (8.4) Il carico proposto per l'esercizio in posizione pos era alleggerito
   per il dolore? Si guarda prima della registrazione (la memoria è nella
   seduta, così ritoccare la registrazione non cambia la risposta). */
function painAdjAt(pos) {
  const c = current;
  if (!c) return null;
  c.painAdj = c.painAdj || {};
  const it = c.sess.items[pos];
  if (!it) return null;
  if (!(pos in c.painAdj) || c.painAdj[pos] === null) {
    const ex = exById(it.exId);
    const pi = ex && !isCardioEx(ex) && ex.type !== 'stretch' ? painInfo(ex, it) : null;
    c.painAdj[pos] = pi ? pi.part : null;
  }
  return c.painAdj[pos];
}

/* Registra l'esercizio in posizione pos (o aggiorna il record, se ci si era
   già tornati sopra: niente doppioni nello storico). */
function logExercise(pos) {
  const c = current, s = c.sess;
  const it = s.items[pos];
  const ex0 = exById(it.exId);
  const timed0 = isTimedItem(it, ex0);
  // righe delle serie davvero chiuse; se una serie è stata segnata con i
  // pallini senza passare dal pulsante, si completa con i valori correnti
  const rows = [];
  for (let i = 0; i < c.setsDone[pos]; i++) {
    const r = (c.setLog[pos] || [])[i];
    rows.push(r || { load: c.loads[pos] || '', reps: timed0 ? 1 : ((c.repsDone[pos] === null || c.repsDone[pos] === undefined) ? it.reps : c.repsDone[pos]),
                     hold: timed0 ? (it.hold || 0) : 0, rir: null });
  }
  const nums = rows.map(r => numLoad(r.load)).filter(v => v !== null);
  const repLoad = nums.length === rows.length && nums.length
    ? String(isAssist(ex0) ? Math.min(...nums) : Math.max(...nums))     // serie più impegnativa
    : (rows.length ? (rows[rows.length - 1].load || '') : (c.loads[pos] || ''));
  const lastRir = rows.slice().reverse().find(r => r.rir !== null && r.rir !== undefined);
  const rd = rows.length ? (timed0 ? it.reps : rows[rows.length - 1].reps) : c.repsDone[pos];
  const entry = { ts: Date.now(), sid: c.started, sIdx: s.idx, exId: it.exId, name: exById(it.exId).name,
                  setup: S.setup, load: repLoad, feedback: c.feedback[pos] || 'same',
                  sets: c.setsDone[pos], setLog: rows,
                  repsTarget: it.reps,                                   // obiettivo previsto
                  repsDone: (rd === null || rd === undefined) ? it.reps : rd,  // eseguite davvero
                  rir: lastRir ? lastRir.rir : ((c.rir[pos] === null || c.rir[pos] === undefined) ? null : c.rir[pos]),
                  rirUnit: timed0 ? 's' : 'reps',
                  reps: it.reps,                                         // compatibilità storico
                  goal: it.goal, week: s.weekInCycle,
                  hold: rows.length && timed0 ? Math.round(rows.reduce((a, r) => a + (r.hold || 0), 0) / rows.length) : (it.hold || 0),
                  rest: it.rest || 0,                                 // per i minuti aerobici
                  setsPlanned: it.sets - (it.extraSets || 0),         // per la valutazione in Home
                  ...(it.extraSets ? { extraSets: it.extraSets } : {}),   // (8.7) serie fatte oltre al previsto
                  ...(it.pain ? { pain: Object.assign({}, it.pain) } : {}),   // (8.3) dolore segnato durante l'esercizio
                  ...(painAdjAt(pos) ? { painAdj: painAdjAt(pos) } : {}),        // (8.4) carico proposto alleggerito per il dolore
                  ...(it.block === 'spartan' ? { spartan: true } : {}) };   // (7S 0) fuori dal volume dei gruppi
  // valutazione automatica rispetto alla registrazione precedente dello stesso esercizio
  const ref0 = c.logRef[pos];
  const r = rateFor(entry, S.logs.filter((g, gi) => gi !== ref0));
  entry.stars = r.stars; entry.rateText = r.text; entry.warn = r.warn || ''; entry.advice = r.advice || '';
  // (8) record personale: annotato e annunciato subito
  const pr = detectPR(entry, S.logs.filter((g, gi) => gi !== ref0));
  const hadPr = ref0 !== null && ref0 !== undefined && S.logs[ref0] && S.logs[ref0].pr;
  if (pr) entry.pr = pr.text;
  if (ref0 !== null && ref0 !== undefined && S.logs[ref0]) S.logs[ref0] = entry;
  else { c.logRef[pos] = S.logs.length; S.logs.push(entry); }
  save();
  if (pr && !hadPr) showToast(`<span class="trophy">🏆</span><div><b>Nuovo record</b><br>${esc(entry.name)}: ${esc(pr.text)}</div>`, 4200);
}

/* Esercizi ancora da fare: né completati né già registrati. Scorrendo fra le
   schermate si può lasciare indietro un esercizio: dopo ogni esercizio chiuso
   si va al successivo ancora aperto, e la seduta finisce solo quando non ne
   resta nessuno. */
const isOpenItem = (c, i) => c.setsDone[i] < c.sess.items[i].sets && (c.logRef[i] === null || c.logRef[i] === undefined);
function nextOpenAfter(c, pos) {
  const n = c.sess.items.length;
  for (let i = pos + 1; i < n; i++) if (isOpenItem(c, i)) return i;
  for (let i = 0; i < pos; i++) if (isOpenItem(c, i)) return i;
  return -1;
}

function nextExercise() {
  const c = current;
  if (c.finished) return;              // evita doppie registrazioni sull'ultimo esercizio
  logExercise(c.pos);
  // (8.3) superserie: se il compagno ha ancora serie, si torna a lui
  const mi = ssMateIdx(c, c.pos);
  const nx = mi >= 0 && isOpenItem(c, mi) ? mi : nextOpenAfter(c, c.pos);
  if (nx >= 0) { c.pos = nx; saveResume(); renderSession(); return; }
  // fine seduta: gli esercizi iniziati ma lasciati a metà restano registrati
  c.sess.items.forEach((_, i) => {
    if (c.setsDone[i] > 0 && (c.logRef[i] === null || c.logRef[i] === undefined)) logExercise(i);
  });
  // (7S 1) prima della schermata di fine allenamento: revisione, per
  // correggere carichi e ripetizioni o aggiungere una nota
  c.review = true; saveResume(); renderSession();
}

/* ---------------------------------------------------------------------------
   REVISIONE PRIMA DI CHIUDERE (dalla 7S 1)
   Chiusa l'ultima serie, la seduta non finisce subito: resta aperta la
   schermata dell'ultimo esercizio con le serie registrate. Si tocca una riga
   (✎) per correggere carico e ripetizioni, si aggiunge una nota
   all'esercizio, si scorre agli altri esercizi per correggere anche quelli.
   «Chiudi la seduta» riscrive nello storico gli esercizi corretti (lo stesso
   record, nessun doppione) e apre la schermata di fine allenamento.
--------------------------------------------------------------------------- */
function finishReview() {
  const c = current;
  if (!c || c.finished) return;
  Object.keys(c.dirty || {}).forEach(k => { const i = +k; if (c.setsDone[i] > 0) logExercise(i); });
  c.review = false; c.dirty = {};
  c.finished = true; endSession();
}
function applyReview() {
  const v = $('#view-session');
  if (!v) return;
  v.insertAdjacentHTML('afterbegin', `<div class="notice reviewnote">Seduta finita. Prima di chiuderla puoi <b>correggere carichi e ripetizioni</b> toccando le righe delle serie (✎), <b>aggiungere una nota</b> all'esercizio e scorrere agli altri esercizi per controllarli.</div>`);
  $('#actionBar').innerHTML = `<button class="btn" id="reviewDone">Chiudi la seduta</button>`;
  $('#actionBar').classList.add('on');
  $('#reviewDone').onclick = () => finishReview();
}
function renderSession() {
  renderSessionCore();
  const v = $('#view-session');
  if (v) v.classList.toggle('review', !!(current && current.review && !current.finished));
  if (current && current.review && !current.finished) applyReview();
}

/* ---------- fine sessione: riepilogo e salvataggio ---------- */
let endTries = 0;
function endSession() {
  stopTimer(); releaseWakeLock();
  // la seduta è conclusa: la barra di navigazione torna disponibile, così non
  // si resta mai chiusi dentro la schermata della sessione
  document.body.classList.remove('in-session');
  $('#actionBar').classList.remove('on');
  const s = current.sess, mins = Math.round((Date.now() - current.started) / 60000);
  openModal(`
    <h2>Sessione completata</h2>
    <p class="small muted">${esc(s.label)} · ${mins} minuti effettivi.</p>
    ${s.kind === 'core' ? '' : `<p class="small muted" style="margin:10px 0 4px">Com'è andata? Bastano due tocchi, tutto facoltativo.</p>${feelPickerHtml()}`}
    <div class="field"><label>Note</label><input id="sNote" type="text" placeholder="sensazioni, ginocchio, ecc."></div>
    <button class="btn" id="saveSession">Salva e chiudi</button>
    <button class="btn ghost" id="skipSave" style="margin-top:10px">Chiudi senza note</button>
    ${s.kind === 'core' ? '' : `<button class="btn ghost" id="addMore" style="margin-top:10px">Ho ancora tempo: aggiungi esercizi</button>`}
  `);
  const feel = {};
  bindFeelPicker(feel);
  // (8.3) il dolore segnato durante la seduta precompila ginocchio e spalla
  ['knee', 'shoulder'].forEach(p => {
    const vs = s.items.filter(x => x.pain && x.pain.part === p).map(x => x.pain.v);
    if (!vs.length) return;
    const b = document.querySelector(`[data-feel="${p}"] [data-v="${Math.max(...vs)}"]`);
    if (b) b.click();
  });
  const finish = (withNote) => {
    const sid = current ? current.started : 0;
    const hasFeel = Object.keys(feel).some(k => feel[k] !== null && feel[k] !== undefined);
    S.sessionLog.push({ ts: Date.now(), sid: sid, idx: s.idx,
      label: s.label, kind: s.kind, minutes: mins,
      est: s.minutes || estimateMinutes(s.items), budget: s.budget || null,     // (8) durata stimata
      ...(hasFeel ? { feel: Object.assign({ energy: null, sleep: null, knee: null, shoulder: null }, feel) } : {}),
      ...(s.kind === 'morning' ? { mWeek: s.mWeek, mDay: s.mDay, mFocus: s.focusKey, mLunch: s.lunchLabel } : {}),
      note: withNote ? ($('#sNote').value || '') : '' });
    if (isProgramKind(s.kind)) S.sessionIndex++;
    if (s.run && current) {
      const mi = s.items.findIndex(it => it.goal === 'cardioRun');
      recordRun(s, mi >= 0 ? (current.setsDone[mi] || 0) : 0, sid, Date.now());
    }
    planCache = null; homeSel = 'session';
    const weekDone = (isProgramKind(s.kind) && posOfIdx(S.sessionIndex) === 0) ? weekOfIdx(S.sessionIndex) - 1 : 0;
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
    const prs = done.filter(l => l.pr).map(l => `${l.name}: ${l.pr}`);
    // (8) traguardi speciali: prima trazione pulita, traguardi Spartan raggiunti
    const firstPull = done.some(l => l.exId === 'g_pullup' && bestAtLevels(l, STRICT_LEVELS) >= 1) &&
      !S.logs.some(l => l.sid !== sid && l.exId === 'g_pullup' && !l.planned && bestAtLevels(l, STRICT_LEVELS) >= 1);
    const goals = spGoalsNewlyHit();
    closeModal(() => celebrate({ label: s.label, mins, est: s.minutes, count: done.length, avg, weekDone, prs, kind: s.kind, firstPull, goals }));
  };

  $('#saveSession').onclick = () => finish(true);
  $('#skipSave').onclick = () => finish(false);
  if ($('#addMore')) $('#addMore').onclick = () => closeModal(() => openExtraPicker());
  // se per qualsiasi motivo il riepilogo non resta a schermo, lo si ripropone:
  // una seduta finita deve sempre potersi chiudere
  setTimeout(() => {
    if (current && current.finished && !$('#modal').classList.contains('on') && endTries++ < 3) endSession();
    else if ($('#modal').classList.contains('on')) endTries = 0;
  }, 500);
}

/* ---------------------------------------------------------------------------
   ESERCIZI IN PIÙ A FINE SEDUTA (dalla 5.8)
   Se alla fine resta tempo, l'app propone due o tre esercizi scelti dove il
   volume settimanale è più indietro (petto, polpacci, femorali… secondo la
   settimana in corso), con serie proporzionate ai minuti disponibili. Gli
   esercizi si aggiungono alla seduta in corso: contano nel volume e nello
   storico come tutti gli altri.
--------------------------------------------------------------------------- */
function extraCandidates(minutes) {
  const c = current;
  if (!c) return [];
  const meta = sessionMeta(c.sess.idx);
  const inSession = new Set(c.sess.items.map(it => it.exId));
  // stessa logica dei supplementari (weekNeeds), ma con quanto già fatto oggi:
  // prima i gruppi che la settimana lascia più indietro
  const proj = weekNeeds(c.sess.idx, { includeSelf: true }).proj;
  const groups = Object.keys(EXTRA_PATTERNS)
    .map(g => ({ g, have: proj[g] || 0 }))
    .sort((a, b) => a.have - b.have);
  const out = [], used = new Set(inSession);
  const stretchDay = c.sess.type === 'stretch';
  groups.forEach(({ g }) => {
    if (out.length >= 4) return;
    let pool = [];
    (stretchDay ? [] : EXTRA_PATTERNS[g]).forEach(pat => { pool = pool.concat(slotPool([pat])); });
    if (stretchDay) pool = DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'static' && e.setup.includes(S.setup));
    pool = pool.filter(e => !used.has(e.id));
    const ex = pool[0];
    if (!ex) return;
    used.add(ex.id);
    const goalKey = stretchDay ? 'stretch' : (c.sess.type === 'cardio' ? 'hypertrophy' : (c.sess.items.find(i => i.role === 'key') || {}).goalKey || 'hypertrophy');
    const d = dose(goalKey, meta.profile, ex);
    // serie che stanno davvero nei minuti dichiarati, cambio compreso
    let sets = d.perSide ? 2 : 1;
    const fits = n => itemMinutes(Object.assign({}, d, { exId: ex.id, sets: n, goal: goalKey })) <= minutes;
    while (sets + (d.perSide ? 2 : 1) <= d.sets && fits(sets + (d.perSide ? 2 : 1))) sets += d.perSide ? 2 : 1;
    out.push({ group: g, item: Object.assign(d, { exId: ex.id, note: 'Aggiunto a fine seduta', goalKey, role: 'extra',
      sets, alt: { patterns: [ex.pattern], types: [ex.type] } }) });
  });
  return out.slice(0, 4);
}

function openExtraPicker(minutes) {
  const min = minutes || 10;
  const list = extraCandidates(min);
  const rows = list.map((x, i) => {
    const ex = exById(x.item.exId);
    return `<li data-extra="${i}"><div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm" style="flex:1"><b>${esc(ex.name)}</b>
        <div class="small muted">${esc(x.group)} · ${doseText(x.item)} · ${itemMinutes(x.item)} min</div></div>
      <button class="pick">Aggiungi</button></li>`;
  }).join('');
  openModal(`<h2>Quanto tempo hai ancora?</h2>
    <div class="seg dur" role="group" aria-label="Minuti disponibili" style="margin-top:10px">
      ${[5, 10, 15].map(v => `<button data-xmin="${v}" aria-pressed="${v === min}">${v}′</button>`).join('')}
    </div>
    <p class="small muted" style="margin-top:10px">Proposte sui gruppi più indietro rispetto al programma di questa settimana. Tocca quelli che vuoi fare: si aggiungono alla seduta.</p>
    <ul class="hist">${rows || '<li><span class="small muted">Nessuna proposta disponibile.</span></li>'}</ul>
    <button class="btn ghost" id="xClose" style="margin-top:12px">Chiudi la seduta</button>`);
  document.querySelectorAll('[data-xmin]').forEach(b => b.onclick = () => closeModal(() => openExtraPicker(+b.dataset.xmin)));
  document.querySelectorAll('[data-extra]').forEach(li => li.onclick = () => {
    const x = list[+li.dataset.extra];
    closeModal(() => addExtraToSession(x.item));
  });
  $('#xClose').onclick = () => closeModal(() => { if (current && current.finished) endSession(); });
}

/* Aggiunge l'esercizio in coda alla seduta e ci porta sopra: la seduta torna
   aperta, e si chiuderà come sempre quando non restano esercizi da fare. */
function addExtraToSession(item) {
  const c = current;
  if (!c) return;
  c.sess.items.push(item);
  c.setsDone.push(0); c.loads.push(''); c.feedback.push(null);
  c.logRef.push(null); c.repsDone.push(null); c.rir.push(null); c.setLog.push([]);
  c.finished = false;
  c.pos = c.sess.items.length - 1;
  c.sess.minutes = estimateMinutes(c.sess.items);
  saveResume();
  go('session'); renderSession();
}

/* Pop up di complimenti: cerchio che si disegna, spunta, scintille e numeri
   della seduta. Alla chiusura, se la settimana è completa, lascia il posto al
   riepilogo settimanale. */
/* (8) Traguardi Spartan raggiunti per la prima volta (trazioni, sospensione,
   burpees): si festeggiano una volta sola. */
function spGoalsNewlyHit() {
  if (!SP() || spPhase(Date.now()) === 'off') return [];
  S.spGoalsHit = S.spGoalsHit || {};
  const out = [];
  ['pull', 'hang', 'burpee'].forEach(k => {
    const m = spMetric(k), v = m.show != null ? m.show : m.n;
    if (v >= m.T && !S.spGoalsHit[k]) { S.spGoalsHit[k] = Date.now(); out.push(`${SP_NAMES[k]}: ${spValueText(k, m)}`); }
  });
  if (out.length) save();
  return out;
}

function celebrate(st) {
  const line = st.avg >= 4 ? 'Seduta sopra le attese: stai andando meglio del programma.'
    : st.avg >= 3 ? 'Progressione perfettamente in linea con il programma.'
    : st.avg >= 2 ? 'Seduta solida: il mantenimento è già un risultato.'
    : 'Fatto. Presentarsi nei giorni storti vale più di una seduta brillante.';
  // (8) festa graduata: piccola per la seduta, grande per record, settimana
  // completa, prima trazione e traguardi Spartan
  const prs = st.prs || [], goals = st.goals || [];
  const big = prs.length || st.weekDone || st.firstPull || goals.length;
  const title = st.firstPull ? 'La prima trazione!' : goals.length ? 'Traguardo Spartan raggiunto!'
    : prs.length ? (prs.length > 1 ? `${prs.length} nuovi record!` : 'Nuovo record!')
    : st.weekDone ? 'Settimana completa!' : 'Seduta completata!';
  const highlights = [
    st.firstPull ? '🎉 Prima trazione pulita: da qui il blocco trazioni cambia tappa.' : '',
    ...goals.map(g => `🏁 ${g}`),
    ...prs.slice(0, 4).map(p => `🏆 ${p}`),
    st.weekDone ? `📅 Settimana ${st.weekDone} completa.` : ''
  ].filter(Boolean);

  const sparks = [[60, 8], [102, 30], [102, 90], [60, 112], [18, 90], [18, 30]]
    .map((p, i) => `<circle class="spark" cx="${p[0]}" cy="${p[1]}" r="3.4" fill="#4FC3A1" style="animation-delay:${1 + i * 0.05}s"/>`).join('');
  const colors = ['#F5A524', '#4FC3A1', '#B49CFF', '#EF8A5B', '#FFD27A'];
  const confetti = big ? Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2, r = 52 + (i % 4) * 8, x = (60 + Math.cos(a) * r).toFixed(1), y = (60 + Math.sin(a) * r).toFixed(1);
    return `<rect class="conf" x="${x}" y="${y}" width="5" height="10" rx="1.5" fill="${colors[i % 5]}" transform="rotate(${(i * 41) % 360} ${x} ${y})" style="animation-delay:${(0.9 + (i % 6) * 0.06).toFixed(2)}s"/>`;
  }).join('') : '';

  openModal(`<div class="cheer${big ? ' updcheer big' : ''}">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      ${confetti}${sparks}
      <circle class="ring" cx="60" cy="60" r="45" fill="none" stroke="#F5A524" stroke-width="7"
              stroke-linecap="round" transform="rotate(-90 60 60)"/>
      <path class="tick" d="M40 61 L54 75 L81 46" fill="none" stroke="#EAF1F8" stroke-width="8"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <h2>${esc(title)}</h2>
    <p class="sub small muted">${esc(st.label)}</p>
    ${highlights.length ? `<div class="sub hl">${highlights.map(h => `<p class="small">${esc(h)}</p>`).join('')}</div>` : ''}
    <div class="statline">
      <div class="stat"><b>${st.mins}</b><span>minuti${st.est ? ` su ${st.est} previsti` : ''}</span></div>
      <div class="stat"><b>${st.count}</b><span>esercizi</span></div>
      <div class="stat"><b>${st.avg ? st.avg.toFixed(1) : '—'}</b><span>stelle medie</span></div>
    </div>
    <p class="sub small" style="margin-top:12px">${line}</p>
    <button class="btn" id="cheerOk" style="margin-top:18px">Continua</button>
    ${st.avg ? '<button class="btn ghost" id="cheerWhy" style="margin-top:10px">Perché queste stelle</button>' : ''}
  </div>`);

  $('#cheerOk').onclick = () => closeModal(() => {
    goToday();
    if (st.weekDone) setTimeout(() => openWeekReport(st.weekDone), 260);
  });
  // (8.5) dal riepilogo al dettaglio: stelle e motivo esercizio per esercizio
  if ($('#cheerWhy')) $('#cheerWhy').onclick = () => closeModal(() => {
    goToday();
    setTimeout(() => openSessionDetail(S.sessionLog.length - 1), 260);
  });
}

/* ---------- scheda esercizio ---------- */
function openSheet(ex, it, ctx) {
  $('#sheetPanel').innerHTML = `
    <h2>${esc(ex.name)}</h2>
    <div class="small muted">${esc(ex.group)} · ${esc(ex.equipment.join(', ') || 'corpo libero')}</div>
    <div class="motion">${figureMotion(ex)}<div class="small muted" style="text-align:center">il movimento · in arancio le parti che lavorano</div></div>
    <div class="frames">
      <div>${figureA11y(ex, 0)}<div class="small muted" style="text-align:center">posizione iniziale</div></div>
      <div>${figureA11y(ex, 1)}<div class="small muted" style="text-align:center">posizione finale</div></div>
    </div>
    ${it ? `<p class="small muted">Oggi: ${doseText(it)}, recupero ${it.rest}s, RPE ${esc(it.rpe)}. ${esc(it.source)}</p>` : ''}
    ${(() => {
      // aerobico e allungamenti: si mostra l'ultima seduta con le sue fasi,
      // non un carico, delle ripetizioni o delle stelle
      if (ex.type === 'stretch' || isCardioEx(ex)) {
        const mine = S.logs.filter(l => l.exId === ex.id);
        if (!mine.length) return `<div class="notice" style="margin-top:10px">Nessuna seduta precedente: intensità e durata le indica il programma.</div>`;
        const k = sessionKey(mine[mine.length - 1]), sess = mine.filter(l => sessionKey(l) === k);
        return `<div class="notice" style="margin-top:10px"><b>Ultima seduta</b> (${new Date(sess[0].ts).toLocaleDateString('it-IT')}): ${sess.map(phaseText).join(' · ')}</div>`;
      }
      const sug = suggestLoad(ex, it), last = sug && sug.last;
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
    ${isAvoided(ex.id)
      ? `<p class="small muted" style="margin-top:14px">Segnato come fastidioso: l'app non lo propone fino al ${dateIt(S.avoid[ex.id])}.</p><button class="btn ghost" id="sheetAvoid" style="margin-top:6px">Riattivalo da subito</button>`
      : `<button class="btn ghost" id="sheetAvoid" style="margin-top:10px">Mi dà fastidio: non propormelo per 4 settimane</button>`}
    <button class="btn secondary" id="closeSheet" style="margin-top:10px">Chiudi</button>`;
  $('#sheet').classList.add('on');
  $('#sheetPanel').scrollTop = 0;                // si apre sempre dalla cima
  $('#closeSheet').onclick = closeSheet;
  $('#sheetAvoid').onclick = () => {
    S.avoid = Object.assign({}, S.avoid || {});
    if (isAvoided(ex.id)) { delete S.avoid[ex.id]; save(); planCache = null; closeSheet(); showToast(`<div>«${esc(ex.name)}» di nuovo fra le proposte.</div>`); if (ctx && ctx.after) ctx.after(false); return; }
    S.avoid[ex.id] = Date.now() + AVOID_MS;
    save(); planCache = null;
    // nella seduta aperta o in quella di oggi si sostituisce subito con l'alternativa più simile
    let swapped = null;
    if (ctx && it && ctx.sess) {
      const alt = alternativesFor(it, ctx.sess).filter(e => e.id !== ex.id && !isAvoided(e.id))
        .sort((a, b) => relevance(b, ex, it) - relevance(a, ex, it));
      if (alt[0] && applyExercise(it, ctx.sess, alt[0])) swapped = alt[0];
    }
    closeSheet();
    showToast(`<div>«${esc(ex.name)}» fuori dalle proposte fino al ${dateIt(S.avoid[ex.id])}${swapped ? `: al suo posto <b>${esc(swapped.name)}</b>` : ''}.</div>`, 4200);
    if (ctx && ctx.after) ctx.after(!!swapped);
  };
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

  // (6.6) le linee di andamento solo per gli esercizi con una prestazione da
  // misurare; aerobico e allungamenti in un elenco a parte, senza grafico né stelle
  const perfKeys = keys.filter(k => { const ex = exById(k); return ex && ex.type !== 'stretch' && !isCardioEx(ex); });
  const planKeys = keys.filter(k => !perfKeys.includes(k));
  const rows = perfKeys.map(k => {
    const all = byEx[k], last = all[all.length - 1];
    const logs = progressLogs(k, all);
    // la linea segue il massimale stimato: così migliorare le ripetizioni a
    // parità di carico si vede, mentre prima il grafico restava piatto
    // la linea mostra le ultime 24 registrazioni: oltre non si legge nulla di
    // più e il calcolo cresce con lo storico, che a fine programma è lungo
    const nums = seriesValues(logs.slice(-24)).vals.filter(n => isFinite(n));
    const e = e1rm(last);
    const nS = sessionsCount(all);
    return `<li data-ex="${k}">
      <div class="spark">${sparkline(nums)}</div>
      <div class="nm" style="flex:1"><b>${esc(last.name)}</b>
        <div class="small muted">${nS} ${nS === 1 ? 'seduta' : 'sedute'} · ultima ${new Date(last.ts).toLocaleDateString('it-IT')}${e ? ' · max stimato ' + e.toFixed(1) + ' kg' : ''}</div></div>
      <div class="val">${esc(last.load || '—')}${isAssist(exById(k)) ? ' <span class="small muted">aiuto</span>' : ''} ${arrow(last.feedback)}<br>${starsHtml(last.stars)}</div></li>`;
  }).join('');
  const planRows = planKeys.map(k => {
    const logs = byEx[k], last = logs[logs.length - 1], ex = exById(k);
    const nS = sessionsCount(logs);
    const lastSess = logs.filter(l => sessionKey(l) === sessionKey(last));
    const min = Math.round(lastSess.reduce((a, l) => a + (l.sets || 1) * (l.hold || 0) + Math.max(0, (l.sets || 1) - 1) * (l.rest || 0), 0) / 60);
    return `<li data-ex="${k}"><div class="nm" style="flex:1"><b>${esc(last.name)}</b>
        <div class="small muted">${nS} ${nS === 1 ? 'seduta' : 'sedute'} · ultima ${new Date(last.ts).toLocaleDateString('it-IT')}</div></div>
      <div class="val">${isCardioEx(ex) ? (min ? min + ' min' : '') : ''}</div><div class="chev">›</div></li>`;
  }).join('');

  const sess = S.sessionLog.map((x, i) => [x, i]).slice(-10).reverse().map(pair => {
    const x = pair[0], i = pair[1];
    return `<li data-sess="${i}"><div class="nm" style="flex:1"><b>${esc(sessLabel(x))}</b>${isSkipped(x) ? ' <span class="wkbadge done">saltata</span>' : ''}
      <div class="small muted">${new Date(x.ts).toLocaleDateString('it-IT')}${isSkipped(x) ? '' : ' · ' + x.minutes + ' min'}${x.note ? ' · ' + esc(x.note) : ''}</div></div>
      <div class="chev">›</div></li>`;
  }).join('');

  const wks = weeksWithData().slice(0, 4).map(w =>
    `<button class="btn ghost" data-week="${w}" style="margin-top:8px">Settimana ${w} · ${weekReport(w).sessions} sedute</button>`).join('');

  const curWeek = weekOfIdx(S.sessionIndex);
  const volAna = volumeFor(curWeek);
  const vol = volumeHtml(curWeek, volAna);

  const aero = aerobicMinutes(curWeek);
  $('#view-history').innerHTML = `
    ${sess ? `<div class="card" id="lastSessCard"><h2>Ultime sedute</h2>
      <p class="small muted">Tocca una seduta per vedere esercizio per esercizio serie, carichi, stelle e il motivo del giudizio.</p><ul class="hist">${sess}</ul></div>` : ''}
    ${measuresHtml()}
    ${aerobicHtml(curWeek, aero)}
    ${vol ? `<div class="card"><h2>Volume della settimana ${curWeek}</h2>
      <p class="small muted">Serie fatte / previste dal programma, per gruppo muscolare. Una serie conta 1 per i muscoli
      che la eseguono e ½ per quelli che collaborano (i tricipiti nella panca, i bicipiti nelle trazioni).
      La tacca chiara segna le 10 serie settimanali: è il <b>minimo</b> raccomandato dal Position Stand ACSM 2026 per l'ipertrofia,
      non un tetto — i guadagni continuano a crescere con rendimenti decrescenti e si appiattiscono verso le 18-20 serie
      (Pelland et al. 2026). Sotto le 5 la barra diventa rossa. Per le gambe l'obiettivo è tono, forza e sostegno del ginocchio, non l'ipertrofia: lì la tacca non è un traguardo.</p>
      <div style="margin-top:10px">${vol}</div>
      ${volAna.advice.length ? `<ul class="small" style="margin-top:12px;padding-left:18px">${volAna.advice.map(t => `<li style="margin-top:6px">${esc(t)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    ${(() => { const f = fineMuscleHtml(curWeek); return f ? `<div class="card"><h2>Muscoli specifici · settimana ${curWeek}</h2>
      <p class="small muted">Serie per i muscoli che il programma allena in modo mirato (capo lungo del tricipite, bicipite, brachiale, avambracci, deltoide posteriore, trapezio superiore, obliqui, addome, petto alto).</p>${f}</div>` : ''; })()}
    ${wks ? `<div class="card"><h2>Riepilogo settimanale</h2>
      <p class="small muted">Traguardi migliori e punti a cui fare attenzione, dalla valutazione automatica dei progressi.</p>${wks}</div>` : ''}
    ${rows ? `<div class="card" id="loadsCard"><h2>Carichi per esercizio</h2>
      <p class="small muted">La linea segue il massimale stimato, non il solo peso: migliorare le ripetizioni a parità di carico si vede. Non entrano nella linea le sedute segnate come fatte alle dosi previste e quelle della settimana di scarico, che restano nello storico.${epochNote() ? ' ' + esc(epochNote()) : ''}</p>
      <ul class="hist">${rows}</ul></div>` : ''}
    ${planRows ? `<div class="card"><h2>Aerobico e allungamenti</h2>
      <p class="small muted">Qui intensità e durata le decide il programma (riscaldamento, parte centrale, defaticamento; tenute degli allungamenti): non sono prestazioni da confrontare, quindi niente linea di andamento e niente stelle. Contano i minuti, nel riquadro dell'attività aerobica.</p>
      <ul class="hist">${planRows}</ul></div>` : ''}
`;

  bindMeasures();
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
/* ---------------------------------------------------------------------------
   GIROVITA E PESO
   Il girovita è l'indicatore pratico del grasso addominale: misurato ogni 2-4
   settimane, alla stessa ora, a livello dell'ombelico e a fine espirazione.
   Il peso da solo inganna: con i pesi il muscolo cresce mentre il grasso cala.
--------------------------------------------------------------------------- */
/* Minuti aerobici della settimana contro il riferimento OMS (150 minuti
   moderati, un minuto vigoroso ne vale due). */
function aerobicHtml(weekAbs, a) {
  a = a || aerobicMinutes(weekAbs);
  const pct = Math.min(100, a.eq / 150 * 100);
  return `<div class="card"><h2>Attività aerobica · settimana ${weekAbs}</h2>
    <p class="small muted">Minuti equivalenti moderati: un minuto di scatto vale due minuti a ritmo costante (OMS 2020). Riferimento: almeno 150 a settimana; 300 danno benefici ulteriori, anche sul grasso addominale.</p>
    <div class="volrow" style="margin-top:8px"><span class="nm">Settimana</span>
      <span class="volbar"><i class="${a.eq >= 150 ? 'good' : (a.eq < 75 ? 'low' : '')}" style="width:${pct}%"></i></span>
      <span class="val">${a.eq}<small class="muted"> / 150</small></span></div>
    <p class="small muted" style="margin-top:6px">${a.vig} min di scatti · ${a.mod} min a ritmo moderato. Contano le sedute aerobiche e il finale metabolico; riscaldamento e defaticamento no.</p>
  </div>`;
}

function measuresHtml() {
  const m = (S.measures || []).slice().sort((a, b) => a.ts - b.ts);
  const first = m[0], last = m[m.length - 1];
  const fmt = v => (v === null || v === undefined || !isFinite(v)) ? '—' : String(Math.round(v * 10) / 10).replace('.', ',');
  const delta = (k, unit) => {
    const a = m.find(x => isFinite(x[k])), b = m.slice().reverse().find(x => isFinite(x[k]));
    if (!a || !b || a === b) return '';
    const d = b[k] - a[k];
    return `<span class="${d < 0 ? 'trend-up' : d > 0 ? 'trend-down' : ''}">${d > 0 ? '+' : ''}${fmt(d)} ${unit}</span> dal ${new Date(a.ts).toLocaleDateString('it-IT')}`;
  };
  const rows = m.slice(-6).reverse().map(x => `<li><div class="nm" style="flex:1">${new Date(x.ts).toLocaleDateString('it-IT')}</div>
      <div class="val">${fmt(x.waist)} cm · ${fmt(x.weight)} kg</div></li>`).join('');
  const due = !last || (Date.now() - last.ts) > 14 * 86400000;
  return `<div class="card" id="bodyCard"><h2>Girovita e peso</h2>
    <p class="small muted">Misura il girovita all'altezza dell'ombelico, a fine espirazione, al mattino, ogni 2-4 settimane: è l'indicatore più diretto del grasso addominale. Il peso da solo inganna, perché il muscolo che costruisci pesa.</p>
    ${m.length > 1 ? `<p class="small" style="margin-top:8px">Girovita: ${delta('waist', 'cm') || '—'}<br>Peso: ${delta('weight', 'kg') || '—'}</p>` : ''}
    ${due ? `<div class="btn-row" style="margin-top:10px;align-items:center">
      <input id="msWaist" type="number" inputmode="decimal" step="0.5" placeholder="girovita cm" aria-label="Girovita in centimetri">
      <input id="msWeight" type="number" inputmode="decimal" step="0.1" placeholder="peso kg" aria-label="Peso in chilogrammi">
    </div>
    <button class="btn secondary" id="msSave" style="margin-top:10px">Registra la misura di oggi</button>`
    : `<p class="small muted" style="margin-top:8px">Prossima misura consigliata dal ${new Date(last.ts + 14 * 86400000).toLocaleDateString('it-IT')}.</p>`}
    ${rows ? `<ul class="hist" style="margin-top:10px">${rows}</ul>` : ''}
    ${!due ? `<button class="btn ghost" id="msEarly" style="margin-top:8px">Registra comunque una misura</button>` : ''}
    ${projectionHtml()}
  </div>`;
}
/* Obiettivo ragionevole a fine piano, con il ragionamento che lo produce. */
function projectionHtml() {
  const b = bodyProjection();
  if (!b.lastW && !b.lastC) return '';
  const waistRisk = v => v > 102 ? 'sopra la soglia OMS di rischio molto aumentato (102 cm)'
    : v > 94 ? 'fra le soglie OMS di rischio aumentato (94 cm) e molto aumentato (102 cm)' : 'sotto la soglia OMS di rischio aumentato (94 cm)';
  return `<div class="block" style="margin-top:14px">
    <h3 style="font-size:16px;color:var(--muted)">Obiettivo ragionevole al ${dateIt(b.end)}</h3>
    <p class="small muted">Fine del piano stimata fra ${Math.round(b.weeks)} settimane; la data si sposta se aggiungi settimane di sola mobilità.</p>
    ${b.weight ? `<p class="small"><b>Peso: ${kg1(b.weight.lo)}-${kg1(b.weight.hi)} kg</b> (oggi ${kg1(b.weight.from)} kg). Calcolato con una perdita di 0,25-0,5 kg a settimana, la fascia prudente per ridurre il grasso conservando e costruendo muscolo (oltre lo 0,5-1% del peso a settimana si rischia di perdere massa magra: Helms et al. 2014), e con un tetto prudente del 5-10% del peso, che tiene la proiezione nel campo del realistico. La posizione attuale dell'ACSM (Jakicic et al. 2024, Consensus Statement, che sostituisce Donnelly et al. 2009) non fissa più obiettivi percentuali di perdita di peso: indica almeno 150 minuti a settimana di attività moderata, con beneficio che cresce con la dose. La leva principale resta un deficit calorico moderato con circa 1,6 g di proteine per kg al giorno (Morton et al. 2018).</p>` : ''}
    ${b.waist ? `<p class="small"><b>Girovita: circa ${kg1(b.waist.to)} cm</b> (oggi ${kg1(b.waist.from)} cm, ${waistRisk(b.waist.from)}). Proiezione della tendenza delle tue misure (${b.waist.perWeek <= 0 ? kg1(-b.waist.perWeek) + ' cm in meno' : kg1(b.waist.perWeek) + ' cm in più'} a settimana), con un tetto prudente di 0,5 cm a settimana e di 8 cm in tutto${b.waist.to <= 94 && b.waist.from > 94 ? ': arriveresti sotto la soglia dei 94 cm' : ''}.</p>`
      : (b.lastC ? `<p class="small">Girovita oggi ${kg1(b.lastC.waist)} cm, ${waistRisk(b.lastC.waist)}. Per proiettarlo servono almeno due misure a 2 settimane di distanza.</p>` : '')}
    <p class="small muted">È una stima, non una promessa: si aggiorna a ogni misura.</p>
  </div>`;
}

function bindMeasures() {
  if ($('#msSave')) $('#msSave').onclick = () => {
    const w = parseFloat(String($('#msWaist').value).replace(',', '.'));
    const k = parseFloat(String($('#msWeight').value).replace(',', '.'));
    if (!(w > 40 && w < 200) && !(k > 30 && k < 250)) return;
    S.measures = (S.measures || []).concat([{ ts: Date.now(), waist: (w > 40 && w < 200) ? w : null, weight: (k > 30 && k < 250) ? k : null }]);
    save(); renderHistory();
  };
  if ($('#msEarly')) $('#msEarly').onclick = () => {
    const last = (S.measures || []).slice().sort((a, b) => a.ts - b.ts).pop();
    if (last) last.ts -= 15 * 86400000;           // riapre il modulo senza toccare i valori
    renderHistory();
    if (last) last.ts += 15 * 86400000;
  };
}

/* (8.6) Righe dei risultati di una seduta svolta (dettaglio in Progressi e
   seduta svolta in Oggi). */
function sessionRowsHtml(logs) {
  return logs.map(l => `<li>
      <div class="nm" style="flex:1"><b>${esc(l.name)}</b>
        <div class="small muted">${Array.isArray(l.setLog) && l.setLog.length
          ? l.setLog.map(r => `${r.load && (numLoad(r.load) !== null || r.load !== l.load) ? String(r.load).replace('.', ',') + '×' : ''}${r.hold ? r.hold + 's' : r.reps + (numLoad(r.load) === null ? ' rip' : '')}${hasNum(r.rir) ? ` (${r.rir}${l.rirUnit === 's' ? 's' : ''})` : ''}`).join(' · ')
          : `${l.sets}×${l.hold ? l.hold + 's' : (l.repsDone || l.reps)}${l.rirUnit === 's' && hasNum(l.rir) ? ' · ' + l.rir + 's di margine' : (hasNum(l.rir) ? ' · RIR ' + l.rir : '')}`}</div>
        ${l.rateText ? `<div class="small muted">${starsHtml(l.stars)} ${esc(l.rateText)}</div>` : ''}</div>
      <div class="val">${esc(l.load || '—')} ${arrow(l.feedback)}</div>
      ${l.manual ? `<button class="mini-skip" data-dellog="${S.logs.indexOf(l)}" aria-label="Elimina la registrazione aggiunta a mano">✕</button>` : ''}</li>`).join('');
}
/* (8.6) Dolore a ginocchio e spalla modificabile anche a seduta chiusa
   (dolori che arrivano a freddo). Il valore va sulla seduta; se è l'ultima
   seduta del programma vale anche per la prossima (registro del dolore,
   come se fosse segnato da Oggi). Nulla viene cancellato: ogni modifica si
   aggiunge al registro. */
function feelEditHtml(i) {
  const x = S.sessionLog[i];
  if (!x || x.kind === 'morning' || x.kind === 'core' || isSkipped(x)) return '';
  const f = x.feel || {};
  const row = (k, label) => `<div class="feelrow"><span class="lab">${label}<span class="small muted"> 0 nessun dolore · 10 il peggiore</span></span>
    <div class="feelbtns" data-fe="${k}">${Array.from({ length: 11 }, (_, v) => `<button type="button" data-v="${v}" aria-pressed="${f[k] === v}">${v}</button>`).join('')}</div></div>`;
  return `<div class="block feeledit" style="margin-top:14px"><h3 style="font-size:16px;color:var(--muted)">Dolore dopo la seduta</h3>
    <p class="small muted">Se il dolore è arrivato a freddo, segnalo o correggilo qui: ${lastProgramSession() === x ? 'vale anche per la prossima seduta (carichi e scelta degli esercizi).' : 'resta nello storico delle sensazioni.'}</p>
    <div class="feel">${row('knee', 'Ginocchio')}${row('shoulder', 'Spalla')}</div></div>`;
}
function bindFeelEdit(i, after) {
  document.querySelectorAll('[data-fe]').forEach(g => g.querySelectorAll('button').forEach(bt => bt.onclick = () => {
    const x = S.sessionLog[i];
    if (!x) return;
    const k = g.dataset.fe, v = +bt.dataset.v;
    x.feel = Object.assign({ energy: null, sleep: null, knee: null, shoulder: null }, x.feel || {});
    const last = lastProgramSession() === x;
    x.feel[k] = x.feel[k] === v ? null : v;
    S.painLog = Array.isArray(S.painLog) ? S.painLog : [];
    if (x.feel[k] !== null) S.painLog.push({ ts: Date.now(), part: k, v, when: last ? 'day' : 'after', sid: x.sid, edit: true });
    planCache = null; save();
    g.querySelectorAll('button').forEach(b2 => b2.setAttribute('aria-pressed', String(+b2.dataset.v === x.feel[k])));
    if (x.feel[k] !== null) showToast(`<div><b>${PAIN_NAME[k]} ${v}/10</b> annotato sulla seduta${last && v >= PAIN_DISTRICT ? ': la prossima seduta si alleggerisce per questo distretto' : ''}.</div>`, 3600);
    if (after) after();
  }));
}

function openSessionDetail(i) {
  const x = S.sessionLog[i], logs = logsOfSession(x);
  const d = new Date(x.ts);
  const rows = sessionRowsHtml(logs);
  openModal(`<h2>${esc(sessLabel(x))}</h2>
    <p class="small muted">${d.toLocaleDateString('it-IT')} · ${x.minutes} minuti · ${logs.length} esercizi${x.kind === 'core' ? ' · blocco core' : ''}</p>
    ${x.note ? `<div class="notice" style="margin-bottom:10px">${esc(x.note)}</div>` : ''}
    <ul class="hist">${rows || '<li><span class="small muted">Nessun esercizio registrato per questa seduta.</span></li>'}</ul>
    ${feelEditHtml(i)}
    <button class="btn ghost" id="addMissing" style="margin-top:16px">Aggiungi un esercizio non registrato</button>
    <button class="btn secondary" id="closeModal2" style="margin-top:10px">Chiudi</button>`);
  $('#closeModal2').onclick = closeModal;
  bindFeelEdit(i);
  $('#addMissing').onclick = () => closeModal(() => addMissingLog(i));
  document.querySelectorAll('[data-dellog]').forEach(b => b.onclick = () => {
    const l = S.logs[+b.dataset.dellog];
    if (current && !current.finished) return;   // durante una seduta gli indici devono restare fermi
    confirmAction('Eliminare questa registrazione?', `${l.name} · ${l.sets}×${l.reps} · ${l.load || '—'}. Era stata aggiunta a mano.`,
      'Elimina', () => { S.logs.splice(+b.dataset.dellog, 1); planCache = null; save(); openSessionDetail(i); });
  });
}

/* ---------------------------------------------------------------------------
   ESERCIZIO NON REGISTRATO
   Per rimettere nello storico un esercizio svolto ma non salvato (o andato
   perso): viene agganciato alla seduta scelta, quindi conta nella settimana
   giusta, nel volume e nei suggerimenti di carico della volta successiva.
--------------------------------------------------------------------------- */
function addMissingLog(i) {
  const x = S.sessionLog[i];
  const pool = DB.exercises.filter(e => e.type !== 'stretch')
    .slice().sort((a, b) => a.name.localeCompare(b.name, 'it'));
  const draw = exId => {
    const ex = exById(exId) || pool[0];
    const scale = ex.load === 'weight' ? rackOf(ex) : null;
    const steps = ex.load === 'band' ? BANDS : levelsOf(ex);
    let loadCtl;
    if (steps) loadCtl = `<select id="mlLoad">${steps.map(b => `<option>${esc(b)}</option>`).join('')}</select>`;
    else if (scale) loadCtl = `<select id="mlLoad"><option value="">— ${isAssist(ex) ? 'aiuto' : 'carico'} —</option>${scale.map(v => `<option value="${v}">${String(v).replace('.', ',')} kg</option>`).join('')}</select>`;
    else if (ex.load === 'weight') loadCtl = `<input id="mlLoad" type="number" inputmode="decimal" step="0.5" placeholder="kg">`;
    else loadCtl = `<input id="mlLoad" type="text" placeholder="nota sul carico (facoltativa)">`;
    openModal(`<h2>Esercizio non registrato</h2>
      <p class="small muted">Viene aggiunto a «${esc(sessLabel(x))}» del ${new Date(x.ts).toLocaleDateString('it-IT')}: conterà in quella settimana, nel volume e nei suggerimenti di carico.</p>
      <div class="field"><label>Esercizio</label><select id="mlEx">${pool.map(e =>
        `<option value="${e.id}" ${e.id === ex.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Serie</label><input id="mlSets" type="number" inputmode="numeric" min="1" max="10" value="3"></div>
      <div class="field"><label>Ripetizioni per serie</label><input id="mlReps" type="number" inputmode="numeric" min="1" max="99" value="12"></div>
      <div class="field"><label>${isAssist(ex) ? 'Assistenza' : 'Carico'}</label>${loadCtl}</div>
      <button class="btn" id="mlOk" style="margin-top:12px">Aggiungi</button>
      <button class="btn ghost" id="mlNo" style="margin-top:10px">Annulla</button>`);
    $('#mlEx').onchange = e => draw(e.target.value);
    $('#mlNo').onclick = () => closeModal(() => openSessionDetail(i));
    $('#mlOk').onclick = () => {
      const sets = Math.max(1, Math.min(10, parseInt($('#mlSets').value, 10) || 0));
      const reps = Math.max(1, Math.min(99, parseInt($('#mlReps').value, 10) || 0));
      const load = String($('#mlLoad').value || '').trim();
      const meta = x.idx != null ? sessionMeta(x.idx) : null;
      const entry = { ts: x.ts - 60000, sid: x.sid || null, sIdx: x.idx, exId: ex.id, name: ex.name,
        setup: S.setup, load, feedback: 'same', sets, repsTarget: reps, repsDone: reps, rir: null, reps,
        goal: ex.type === 'core' ? 'core' : 'hypertrophy', week: meta ? meta.weekInCycle : null, manual: true };
      const r = rateFor(entry, S.logs.filter(g => g.ts < entry.ts));
      entry.stars = r.stars; entry.rateText = r.text; entry.warn = ''; entry.advice = r.advice || '';
      // in ordine di tempo, così "ultima volta" e confronti restano corretti
      let at = S.logs.findIndex(g => g.ts > entry.ts);
      if (at < 0) at = S.logs.length;
      S.logs.splice(at, 0, entry);
      // una seduta in corso tiene gli indici dei suoi record: vanno spostati
      const shift = arr => (arr || []).forEach((v, k) => { if (v !== null && v >= at) arr[k] = v + 1; });
      if (current && !current.finished) { shift(current.logRef); saveResume(); }
      else if (S.resume) shift(S.resume.logRef);
      rerateExercise(ex.id);          // le registrazioni successive si confrontano con questa
      planCache = null; save();
      closeModal(() => openSessionDetail(i));
    };
  };
  draw(pool[0].id);
}

/* ---------------------------------------------------------------------------
   RIEPILOGO SETTIMANALE
   Alla fine delle 5 sedute l'app raccoglie le valutazioni della settimana e
   mostra i traguardi migliori e i punti a cui fare attenzione. Richiamabile in
   qualsiasi momento dalla scheda Progressi.
--------------------------------------------------------------------------- */
function weekReport(weekAbs) {
  const logs = S.logs.filter(l => l.sIdx != null && weekOfIdx(l.sIdx) === weekAbs);
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
  return S.sessionLog.filter(x => isProgramKind(x.kind)).length;
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
  const prog = list.filter(x => isProgramKind(x.kind));
  let k = S.sessionIndex - 1;
  // le sedute più vecchie dell'inizio del programma (prove, versioni
  // precedenti) restano nello storico ma fuori da ogni settimana
  for (let i = prog.length - 1; i >= 0; i--, k--) prog[i].idx = k >= 0 ? k : null;
  let lastIdx = null;
  list.forEach(x => {
    if (isProgramKind(x.kind)) lastIdx = x.idx;
    else if (x.kind === 'morning' && x.mWeek) x.idx = weekStart(x.mWeek) + x.mDay - 1;   // la mattina dello stesso giorno
    else x.idx = lastIdx;
  });
  // gli esercizi seguono la seduta a cui appartengono (per sid, o per orario
  // nelle registrazioni più vecchie che non lo avevano)
  let moved = 0;
  // (la ricerca per orario solo senza sid: una seduta con sid ma senza esercizi
  // non deve "adottare" quelli di una seduta vicina)
  list.forEach(x => (x.sid ? S.logs.filter(g => g.sid === x.sid) : logsOfSession(x)).forEach(l => {
    if (l.sIdx !== x.idx) { l.sIdx = x.idx; moved++; }
  }));
  planCache = null;
  return moved;
}

/* Una sola volta (5.8): le stelle sono un giudizio calcolato, non un dato
   inserito da te. Quelle assegnate prima della correzione confrontavano
   grandezze diverse — volume contro massimale stimato — e potevano dare una
   stella a una seduta migliorata. Qui vengono ricalcolate con la regola nuova,
   in ordine di data; nessun'altra informazione viene toccata. */
function migrateRatings() {
  // 6.5: regole nuove (confronto per serie, scarico, riferimento corretto,
  // niente stelle ad aerobico e sedute segnate come fatte): stesso ricalcolo,
  // una volta, con il punto di ingresso unico. Solo il giudizio cambia.
  // 6.8: settimana di scarico fuori dalla progressione
  // 6.9: conteggi azzerati, ripartenza dopo lo scarico
  // 8.4: cambio di obiettivo con il carico proposto = in linea; carico
  // alleggerito per il dolore fuori dal confronto e mai come riferimento
  // 8.5: cambio di obiettivo confrontato con quanto l'app chiedeva (Epley),
  // anche con un carico diverso da quello proposto
  // 8.8: ripetizioni prescritte diverse dalla volta scorsa = confronto con l'obiettivo
  if (S.ratingsRev >= 7) return;
  if (S.progressEpoch == null) { S.progressEpoch = computeProgressEpoch(); S.progressEpochTs = Date.now(); }
  S.ratingsFixed = true; S.ratingsRev = 7;
  [...new Set(S.logs.map(l => l.exId))].forEach(rerateExercise);
  save();
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
  return S.sessionLog.filter(x => x.idx != null && weekOfIdx(x.idx) === weekAbs &&
    (x.kind === 'strength' || (!x.kind && /^Forza/.test(x.label || '')))).length;
}

function weeksWithData() {
  const set = new Set(S.logs.filter(l => l.sIdx != null).map(l => weekOfIdx(l.sIdx)));
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
  if (!ex || ex.type === 'stretch' || ex.noVolume || !sets) return out;
  const n = ex.perSide ? sets / 2 : sets;
  (ex.primary || []).forEach(m => { const g = muscleGroup(m); if (g) out[g] = n; });
  (ex.secondary || []).forEach(m => { const g = muscleGroup(m); if (g && out[g] === undefined) out[g] = n * 0.5; });
  return out;
}
const addInto = (acc, part) => Object.keys(part).forEach(g => { acc[g] = (acc[g] || 0) + part[g]; });

function weekLogs(weekAbs) {
  return S.logs.filter(l => l.sIdx != null && weekOfIdx(l.sIdx) === weekAbs);
}

/* Serie effettivamente completate nella settimana. */
function weeklyVolume(weekAbs) {
  const acc = {};
  weekLogs(weekAbs).forEach(l => { if (!l.spartan) addInto(acc, groupSetsOf(exById(l.exId), l.sets || 0)); });
  return acc;
}

/* Serie previste dal programma per la stessa settimana (sedute generate con
   le impostazioni attuali: è una stima, ma fedele a quello che l'app propone). */
function plannedVolume(weekAbs) {
  const acc = {};
  let strength = 0;
  for (let k = 0; k < weekLen(weekAbs); k++) {
    const idx = weekStart(weekAbs) + k;
    let sess;
    try { sess = sessionFor(idx); } catch (e) { continue; }
    if (sess.type !== 'strength') continue;
    strength++;
    // i supplementari "se resta tempo" non sono previsti dal programma: dipendono
    // da quanto è stato fatto, quindi non entrano nel confronto
    sess.items.forEach(it => { if (it.role !== 'extra') addInto(acc, groupSetsOf(exById(it.exId), it.sets)); });
  }
  return { acc, strength };
}

const fmtSets = v => (Math.round(v * 2) / 2).toString().replace('.', ',');

/* L'analisi del volume compare in due schermate e viene chiesta più volte per
   la stessa settimana: si tiene l'ultima, con la stessa firma delle sedute. */
let volMemo = null;
function volumeFor(weekAbs) {
  const sig = planSignature() + '|' + weekAbs;
  if (!volMemo || volMemo.sig !== sig) volMemo = { sig, v: volumeAnalysis(weekAbs) };
  return volMemo.v;
}

/* Analisi della settimana: righe per le barre e indicazioni pratiche. */
function volumeAnalysis(weekAbs) {
  const meta = sessionMeta(weekStart(weekAbs));
  const done = weeklyVolume(weekAbs);
  const plan = plannedVolume(weekAbs);
  const strengthDone = strengthSessionsIn(weekAbs);
  const rows = VOL_GROUPS.filter(g => done[g] || plan.acc[g])
    .map(g => ({ group: g, sets: done[g] || 0, planned: plan.acc[g] || 0 }));

  const curWeek = weekOfIdx(S.sessionIndex);
  const inProgress = weekAbs === curWeek;
  const deload = meta.profile && meta.profile.label === 'Scarico';
  const low = rows.filter(r => r.sets < VOL_MIN);
  const advice = [];

  if (meta.mobilityWeek) {
    advice.push('Settimana di sola mobilità: nessun lavoro di forza previsto, il volume non si valuta. Si riparte dalla settimana successiva.');
    return { rows: [], advice, low: [], meta };
  }
  if (!low.length) return { rows, advice, low, meta };

  const skippedN = S.sessionLog.filter(x => isSkipped(x) && x.idx != null && weekOfIdx(x.idx) === weekAbs &&
    (x.realKind === 'strength' || !x.realKind)).length;
  const missing = Math.max(0, plan.strength - strengthDone);
  if (missing > 0) {
    advice.push(inProgress
      ? `Settimana ancora in corso: ${missing === 1 ? 'manca 1 seduta' : `mancano ${missing} sedute`} di forza su ${plan.strength}. Le barre si allungano man mano; per ora nessun provvedimento.`
      : `${strengthDone === 1 ? 'È stata svolta 1 seduta' : `Sono state svolte ${strengthDone} sedute`} di forza su ${plan.strength}${skippedN ? ` (${skippedN} ${skippedN === 1 ? 'saltata' : 'saltate'} volontariamente)` : ''}: il volume basso dipende soprattutto da questo. Provvedimento: nella prossima settimana cerca di completarle tutte; se capita spesso, riduci la durata delle sedute nelle impostazioni invece di saltarle.`);
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

/* ---------------------------------------------------------------------------
   MUSCOLI SPECIFICI (dalla 8.3)
   I gruppi del volume sono 8 e larghi (le braccia sommano bicipiti e
   tricipiti, il dorso dorsali e trapezi). Qui si contano anche i singoli
   muscoli che il programma allena in modo mirato, con la stessa regola
   (diretta 1, indiretta ½). Non c'è una soglia: le 10 serie dell'ACSM 2026
   valgono per gruppo muscolare, non per capo o singolo muscolo, e nessuna
   fonte verificata fissa numeri per il capo lungo del tricipite, il
   brachiale o gli avambracci.
--------------------------------------------------------------------------- */
const FINE_MUSCLES = [
  ['Petto, fasci alti', /fasci (clavicolari|alti)/],
  ['Tricipite, capo lungo', /tricipit.*capo lungo/],
  ['Tricipite, tutti i capi', /tricipit/],
  ['Bicipite', /bicipit/],
  ['Brachiale e brachioradiale', /^brachiale|brachioradial/],
  ['Avambracci e presa', /avambracci|presa/],
  ['Deltoide posteriore', /deltoide posteriore/],
  ['Trapezio superiore', /trapezio superiore/],
  ['Obliqui', /obliqu/],
  ["Retto dell'addome", /retto dell/]
];
function fineSetsOf(ex, sets) {
  const out = {};
  if (!ex || ex.type === 'stretch' || ex.noVolume || !sets) return out;
  const n = ex.perSide ? sets / 2 : sets;
  const add = (m, w) => FINE_MUSCLES.forEach(([k, re]) => {
    if (re.test(String(m).toLowerCase()) && (out[k] === undefined || out[k] < w)) out[k] = w;
  });
  (ex.primary || []).forEach(m => add(m, n));
  (ex.secondary || []).forEach(m => add(m, n * 0.5));
  return out;
}
function fineVolume(weekAbs) {
  const done = {}, plan = {};
  weekLogs(weekAbs).forEach(l => { if (!l.spartan) addInto(done, fineSetsOf(exById(l.exId), l.sets || 0)); });
  for (let k = 0; k < weekLen(weekAbs); k++) {
    let sess;
    try { sess = sessionFor(weekStart(weekAbs) + k); } catch (e) { continue; }
    if (sess.type !== 'strength') continue;
    sess.items.forEach(it => { if (it.role !== 'extra') addInto(plan, fineSetsOf(exById(it.exId), it.sets)); });
  }
  return FINE_MUSCLES.map(([k]) => ({ m: k, done: done[k] || 0, plan: plan[k] || 0 }));
}
function fineMuscleHtml(weekAbs) {
  const rows = fineVolume(weekAbs);
  if (!rows.some(r => r.plan || r.done)) return '';
  return `<table class="cmp finetab"><tr><th>Muscolo</th><th>fatte</th><th>previste</th></tr>${rows.map(r =>
    `<tr><td>${esc(r.m)}</td><td>${fmtSets(r.done)}</td><td>${fmtSets(r.plan)}</td></tr>`).join('')}</table>
    <p class="small muted" style="margin-top:6px">Diretta = 1, indiretta = ½. Nessuna soglia per singolo muscolo: le 10 serie del Position Stand ACSM 2026 valgono per gruppo. Il programma è pensato su 45 minuti: con meno tempo il lavoro diretto sui muscoli piccoli è il primo a ridursi.</p>`;
}

function volumeHtml(weekAbs, ana) {
  const a = ana || volumeFor(weekAbs);
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
  const ana = volumeFor(weekAbs);
  const vol = volumeHtml(weekAbs, ana);
  const volAdvice = ana.advice.map(t => `<li>${esc(t)}</li>`).join('');

  openModal(`<h2>Riepilogo settimana ${weekAbs}</h2>
    <p class="small muted">${r.sessions} sedute completate · ${r.logs.length} esercizi registrati · media ${r.avg.toFixed(1)} stelle</p>
    <div style="margin:10px 0">${starsHtml(Math.round(r.avg))}</div>
    <p class="small">${tone}</p>
    <div class="notice" style="margin-top:10px"><b>Per la prossima settimana</b>: ${esc(weekAdvice(weekAbs))}</div>
    <div class="block" style="margin-top:16px"><h3 style="font-size:16px;color:var(--muted)">Obiettivi, misure e sensazioni</h3>${weekExtrasHtml(weekAbs)}</div>
    ${medals ? `<div class="block" style="margin-top:16px"><h3 style="font-size:16px;color:var(--muted)">Migliori traguardi</h3>${medals}</div>` : ''}
    <div class="block" style="margin-top:16px"><h3 style="font-size:16px;color:var(--muted)">Attività aerobica</h3>
      <p class="small">${(() => { const a = aerobicMinutes(weekAbs); return `${a.eq} minuti equivalenti su 150 (${a.vig} di scatti, ${a.mod} moderati).${a.eq < 150 && !isMobilityWeek(weekAbs) ? ' Per arrivarci: completa le due sedute aerobiche e, quando hai 50 minuti, lascia il finale metabolico nelle sedute di forza.' : ''}`; })()}</p></div>
    ${vol ? `<div class="block" style="margin-top:16px"><h3 style="font-size:16px;color:var(--muted)">Serie per gruppo muscolare</h3>
      <p class="small muted">Serie fatte / previste dal programma. Diretta = 1, indiretta = ½. Tacca a 10: minimo raccomandato per l'ipertrofia (plateau verso 18-20); barra rossa sotto 5.</p>${vol}</div>` : ''}
    ${(() => { const f = fineMuscleHtml(weekAbs); return f ? `<div class="block" style="margin-top:16px"><h3 style="font-size:16px;color:var(--muted)">Muscoli specifici</h3>${f}</div>` : ''; })()}
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

/* Dettaglio di aerobico e allungamenti: le sedute una per una, con le fasi
   previste dal programma, senza grafico e senza stelle. */
const PHASE_LABEL = { cardioWarm: 'Riscaldamento', cardioCool: 'Defaticamento', cardioHiit: 'Intervalli',
                      cardioSteady: 'Ritmo costante', finisher: 'Finale metabolico', stretch: 'Allungamento', mobility: 'Mobilità' };
function phaseText(l) {
  const sets = l.sets || 1, hold = l.hold || 0, rest = l.rest || 0;
  const lab = PHASE_LABEL[l.goal] || 'Lavoro';
  if (sets > 1 && rest) return `${lab} ${sets}× ${hold}″ / ${rest}″`;
  if (sets > 1) return `${lab} ${sets}× ${hold}″`;
  return hold >= 60 ? `${lab} ${Math.round(hold / 60)}′` : `${lab} ${hold}″`;
}
function detailPlanned(exId, logs) {
  const ex = exById(exId);
  const bySess = [];
  logs.forEach(l => { const k = sessionKey(l); let g = bySess.find(x => x.k === k); if (!g) bySess.push(g = { k, logs: [] }); g.logs.push(l); });
  const rows = bySess.slice().reverse().map(g => {
    const min = Math.round(g.logs.reduce((a, l) => a + (l.sets || 1) * (l.hold || 0) + Math.max(0, (l.sets || 1) - 1) * (l.rest || 0), 0) / 60);
    return `<li><div class="nm" style="flex:1"><b>${new Date(g.logs[0].ts).toLocaleDateString('it-IT')}</b>
      <div class="small muted">${g.logs.map(phaseText).join(' · ')}</div></div>
      <div class="val">${min ? min + ' min' : ''}</div></li>`;
  }).join('');
  openModal(`<h2>${esc(ex.name)}</h2>
    <p class="small muted">${isCardioEx(ex) ? 'Riscaldamento, parte centrale e defaticamento seguono il programma: sono fasi della stessa seduta, non prestazioni da confrontare fra loro.' : 'Le tenute seguono il programma: niente valutazione a stelle.'}</p>
    <ul class="hist">${rows}</ul>
    <button class="btn secondary" id="closeModal" style="margin-top:16px">Chiudi</button>`);
  $('#closeModal').onclick = closeModal;
}

function detailFor(exId, logs) {
  const ex = exById(exId);
  if (!ex || ex.type === 'stretch' || isCardioEx(ex)) return detailPlanned(exId, logs);
  const rows = logs.slice().reverse().map(l => {
    const r = isFinite(l.repsDone) ? l.repsDone : l.reps;
    const e = e1rm(l);
    const extra = [`${l.sets}×${r}`];
    if (l.planned) extra.push('segnata come fatta');
    if (isDeloadLog(l)) extra.push('scarico, fuori dalla progressione');
    else if (isPreEpoch(l) && !l.planned) extra.push(epochBaseline(exId) === l ? 'riferimento di partenza' : 'prima della ripartenza');
    if (isFinite(l.rir) && l.rir !== null) extra.push(`RIR ${l.rir}`);
    if (e) extra.push(`max ${e.toFixed(1)} kg`);
    extra.push(l.setup === 'gym' ? 'palestra' : 'casa');
    return `<li><div class="nm" style="flex:1"><b>${esc(l.load || '—')}</b>
      <div class="small muted">${new Date(l.ts).toLocaleDateString('it-IT')} · ${extra.join(' · ')}</div>
      ${l.rateText ? `<div class="small muted">${esc(l.rateText)}</div>` : ''}</div>
      <div class="val">${arrow(l.feedback)}<br>${starsHtml(l.stars)}</div></li>`;
  }).join('');
  openModal(`<h2>${esc(ex.name)}</h2>
    <div style="height:110px;margin:10px 0">${bigChart(progressLogs(exId, logs))}</div>
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
let catEquip = 'tutti', catPlace = 'qui', catKnee = false;   // (8) filtri per attrezzo, luogo, ginocchio
/* (8) Famiglie di attrezzi per il filtro del catalogo. */
const EQUIP_FAMILIES = [
  ['Manubri', e => e.rack === 'dumbbell' || /manubri/i.test((e.equipment || []).join(' '))],
  ['Bilanciere', e => e.rack === 'barbell' || /bilanciere|smith/i.test((e.equipment || []).join(' '))],
  ['Macchine e cavi', e => e.rack === 'machine' || /macchina|lat machine|pulley|cavi|smith/i.test((e.equipment || []).join(' '))],
  ['Kettlebell', e => e.rack === 'kettlebell' || /kettlebell/i.test((e.equipment || []).join(' '))],
  ['Elastici', e => e.load === 'band' || /band|elastico/i.test((e.equipment || []).join(' '))],
  ['Sbarra e parallele', e => /sbarra|parallele/i.test((e.equipment || []).join(' '))],
  ['Attrezzi aerobici', e => e.pattern === 'cardio' || e.pattern === 'finisher'],
  ['Corpo libero', e => !e.rack && e.load !== 'band' && e.pattern !== 'cardio' && e.pattern !== 'finisher' &&
    !/manubri|bilanciere|macchina|pulley|cavi|kettlebell|band|elastico|sbarra|parallele|smith/i.test((e.equipment || []).join(' '))]
];

function catalogGroups() {
  const g = new Set(DB.exercises.map(e => e.group));
  return ['tutti'].concat(Array.from(g).sort((a, b) => a.localeCompare(b)));
}

function catalogList() {
  const q = catQuery.trim().toLowerCase();
  const fam = EQUIP_FAMILIES.find(f => f[0] === catEquip);
  return DB.exercises.filter(e => {
    const place = catPlace === 'qui' ? S.setup : catPlace;
    if (place !== 'tutti' && !e.setup.includes(place)) return false;
    if (catFilter !== 'tutti' && e.group !== catFilter) return false;
    if (fam && !fam[1](e)) return false;
    if (catKnee && e.kneeFriendly === false) return false;
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
        ${last ? `<div class="why">${ex.type === 'stretch' || isCardioEx(ex) ? 'ultima seduta' : `ultima volta ${esc(last.load || '—')} ·`} ${new Date(last.ts).toLocaleDateString('it-IT')}</div>` : ''}</div>
      <div class="chev">›</div></li>`;
  }).join('');

  $('#view-catalog').innerHTML = `
    <input class="search" id="catSearch" type="search" placeholder="Cerca per nome, muscolo (es. «bicipiti») o attrezzo"
           aria-label="Cerca un esercizio" value="${esc(catQuery)}">
    <div class="seg" role="group" aria-label="Dove" style="margin-top:10px">
      ${[['qui', S.setup === 'gym' ? 'Palestra (oggi)' : 'Casa (oggi)'], ['gym', 'Palestra'], ['home', 'Casa'], ['tutti', 'Tutti']]
        .filter(([k]) => !(k === S.setup))
        .map(([k, l]) => `<button data-place="${k}" aria-pressed="${catPlace === k}">${l}</button>`).join('')}
    </div>
    <p class="small muted" style="margin:10px 0 4px">Attrezzo</p>
    <div class="filters">${['tutti'].concat(EQUIP_FAMILIES.map(f => f[0])).map(k => `<button data-equip="${esc(k)}" aria-pressed="${catEquip === k}">${k === 'tutti' ? 'Tutti' : esc(k)}</button>`).join('')}</div>
    <p class="small muted" style="margin:10px 0 4px">Gruppo muscolare</p>
    <div class="filters">${chips}</div>
    <div class="switch" style="border:0;padding-top:0">
      <span class="small muted">Solo esercizi che rispettano il ginocchio</span>
      <input type="checkbox" id="catKnee" ${catKnee ? 'checked' : ''}></div>
    <div class="card"><ul class="picker">${rows || '<li><span class="small muted">Nessun esercizio corrisponde alla ricerca.</span></li>'}</ul></div>`;

  const inp = $('#catSearch');
  inp.oninput = () => {
    catQuery = inp.value;
    const pos = inp.selectionStart;
    renderCatalog();
    const el = $('#catSearch'); el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {}
  };
  document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { catFilter = b.dataset.cat; renderCatalog(); });
  document.querySelectorAll('[data-place]').forEach(b => b.onclick = () => { catPlace = b.dataset.place; renderCatalog(); });
  document.querySelectorAll('[data-equip]').forEach(b => b.onclick = () => { catEquip = b.dataset.equip; renderCatalog(); });
  $('#catKnee').onchange = e => { catKnee = e.target.checked; renderCatalog(); };
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
    if (ex.pattern === 'finisher') {
      const f = finisherItem(meta, ex.id);
      if (f) return Object.assign(f, { note: 'Seduta libera' });
    }
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
      <p class="small muted">Prossima seduta prevista: <b>${whereText(meta)}</b>${meta.phase ? ' · fase ' + esc(meta.phase.ph.name) : ''}.
        Sedute di programma registrate finora: ${countProgramSessions()}.</p>
      ${meta.trainingWeek !== meta.weekAbs ? `<p class="small muted">La settimana di calendario è la ${meta.weekAbs}ª; le settimane di sola mobilità non contano come allenamento, quindi sul piano di ${totalWeeks(p) || p.cycleWeeks} settimane sei alla ${meta.trainingWeek}ª.</p>` : ''}
      <div class="btn-row" style="margin-top:12px">
        <div class="field" style="flex:1;margin:0"><label>Settimana</label>
          <select id="posWeek">${Array.from({ length: Math.max(12, meta.weekAbs + 4) }, (_, i) => i + 1).map(w =>
            `<option value="${w}" ${w === meta.weekAbs ? 'selected' : ''}>Settimana ${w}</option>`).join('')}</select></div>
        <div class="field" style="flex:1;margin:0"><label>Sessione</label>
          <select id="posDay">${Array.from({ length: 6 }, (_, i) => i + 1).map(d =>
            `<option value="${d}" ${d === meta.pos ? 'selected' : ''}>Sessione ${d}${d <= weekLen(meta.weekAbs) ? ' · ' + typeWord(sessionMeta(weekStart(meta.weekAbs) + d - 1)) : ''}</option>`).join('')}</select></div>
      </div>
      <button class="btn ghost" id="posSet" style="margin-top:10px">Imposta questa posizione</button>
      <button class="btn ghost" id="posAuto" style="margin-top:10px">Ricalcola dalle sedute registrate</button>
    </div>

    <div class="card">
      <h2>Settimane di sola mobilità</h2>
      <p class="small muted">Quando non puoi andare in sala pesi, tutte le sedute della settimana diventano mobilità e stretching.
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
      <div class="switch"><span>Evita gli esercizi di solito dolorosi per la spalla</span>
        <input type="checkbox" id="shoulderChk" ${S.shoulderCare ? 'checked' : ''}></div>
      <p class="small muted" style="margin:8px 0 0">Sono due preferenze di comfort, non divieti. Le linee guida più recenti non vietano esercizi:
        per il dolore femoro-rotuleo il rinforzo è il trattamento di prima scelta e nessun tipo risulta superiore a un altro
        (Morri et al. 2025), e per la tendinopatia della cuffia dei rotatori — la definizione che oggi comprende il conflitto
        subacromiale — l'esercizio attivo contro resistenza è raccomandato con prove forti, senza un elenco di movimenti da
        evitare (linea guida JOSPT 2025). Qui l'app sceglie per primi gli esercizi che di solito danno meno fastidio; se un
        movimento non ti dà dolore, togli la spunta e torna disponibile.</p>
      <div class="switch"><span>Obiettivo trazioni e muscle-up<br><span class="small muted">15 trazioni pulite di fila e 2 muscle-up a fine programma: lavoro per tappe dopo i due esercizi principali, test dopo ogni scarico, sospensione in chiusura se resta tempo. Dettagli in Progressi.</span></span>
        <input type="checkbox" id="pullChk" ${S.pullupGoal ? 'checked' : ''}></div>
      ${SP() ? `<div class="switch"><span>Preparazione Spartan Race<br><span class="small muted">Sprint di ${esc(SP().place)}, ${spDateText()}: burpees e sospensione nella seduta a intervalli, corsa-camminata settimanale dal ${dateIt(isoNoon(SP().runFrom))}, Spartan Race check dopo ogni scarico. Forza A, B e C invariate. Dettagli in Progressi.</span></span>
        <input type="checkbox" id="spChk" ${S.spartan !== false ? 'checked' : ''}></div>` : ''}
      <div class="field" style="margin-top:12px"><label>Ultima valutazione del fisioterapista</label>
        <input id="physioDate" type="date" value="${esc(S.physioDate || '')}"></div>
      <p class="small muted" style="margin:4px 0 0">Prima di togliere le spunte di ginocchio e spalla (che sbloccano burpee con salto e muscle-up) l'app te la ricorda.</p>
      ${avoidListHtml()}
      <div class="switch"><span>Schermo da palestra<br><span class="small muted">Numeri e timer grandi in seduta, leggibili con il telefono appoggiato.</span></span>
        <input type="checkbox" id="bigChk" ${S.bigScreen !== false ? 'checked' : ''}></div>
      <div class="field"><label>Tema</label>
        <select id="themeSel">
          <option value="dark" ${(S.theme || 'dark') === 'dark' ? 'selected' : ''}>Scuro</option>
          <option value="light" ${S.theme === 'light' ? 'selected' : ''}>Chiaro (all'aperto, al sole)</option>
          <option value="auto" ${S.theme === 'auto' ? 'selected' : ''}>Come l'iPhone</option></select></div>
      <div class="switch"><span>Campanella del timer</span>
        <input type="checkbox" id="soundChk" ${S.sound !== false ? 'checked' : ''}></div>

      <div class="switch" style="border:0"><span>Schermo sempre acceso</span><span class="small muted" id="wlStatus">—</span></div>
      <button class="btn ghost" id="testSound" style="margin-top:12px">Prova la campanella</button>
      <p class="small muted" style="margin-top:8px">La campanella si sovrappone a Spotify o YouTube senza abbassarli né metterli in pausa. Perché si senta, la modalità silenziosa dell'iPhone deve essere disattivata: tocca "Prova la campanella" e alza il volume con i tasti laterali mentre suona.</p>
    </div>

    <div class="card">
      <h2>Grasso addominale</h2>
      <p class="small muted">Tre leve, in ordine di peso. <b>L'alimentazione</b>: un deficit calorico moderato è ciò che riduce davvero il grasso, e con circa 1,6 g di proteine per kg di peso al giorno il muscolo si conserva mentre il grasso cala. <b>I pesi</b>: riducono anche il grasso viscerale, oltre a costruire muscolo. <b>Il lavoro a intervalli</b>: fra tutte le modalità è la più efficace sul grasso viscerale, già con poco tempo a settimana.</p>
      <p class="small muted">Dalla 5.0 la settimana ha due sedute aerobiche (intervalli e ritmo costante) su bici da spinning, cyclette orizzontale, sacco, vogatore o scalini; niente corsa, nuoto o ellittico. Il finale metabolico si aggiunge anche alle sedute di forza quando scegli 50 minuti, o con 40-45 se avanza tempo.</p>
      <div class="switch" style="border:0"><span>Finale metabolico</span>
        <select id="finSel" style="width:190px;min-height:44px;background:var(--surface2);border:1px solid var(--line);border-radius:10px;padding:0 10px">
          ${(PROG.finisherOptions || []).map(o => `<option value="${o.id}" ${(S.finisher || 'f_bikehiit') === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select></div>
      <p class="small muted" style="margin-top:6px">Bici: sella alta, sempre seduti, cadenza alta. Se la rotula protesta, la cyclette orizzontale o il sacco caricano meno il ginocchio. Dopo i 50 anni, per l'alta intensità serve il via libera del medico se hai fattori di rischio cardiovascolare. Il girovita si registra in Progressi.</p>
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
      <p class="small muted" style="margin-top:8px">Dove salvarlo: nella condivisione scegli «Salva in File» e la cartella ${BACKUP_PATH}. Il sabato e la domenica Oggi te lo ricorda se l'ultimo backup ha più di cinque giorni. Importando, l'app ti mostra prima che cosa contiene il file.</p>
      ${(() => { try { return localStorage.getItem(KEY + '.prerestore') ? '<button class="btn ghost" id="undoRestoreBtn" style="margin-top:10px">Annulla il ripristino</button>' : ''; } catch (e) { return ''; } })()}
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
        : `Nella settimana ${w} tutte le sedute saranno di mobilità e stretching. Il programma di forza slitta di una settimana: non perdi nulla.`,
      isMobilityWeek(w) ? 'Ripristina' : 'Imposta', () => setMobWeek(w));
  };
  $('#mobThis').onclick = () => {
    const w = meta.weekAbs;
    confirmAction(isMobilityWeek(w) ? 'Ripristinare la settimana normale?' : 'Solo mobilità questa settimana?',
      isMobilityWeek(w)
        ? `La settimana ${w} tornerà a prevedere tre sedute di potenziamento e due di mobilità.`
        : `Nella settimana ${w} tutte le sedute saranno di mobilità e stretching. Il programma di forza slitta di una settimana: non perdi nulla.`,
      isMobilityWeek(w) ? 'Ripristina' : 'Imposta', () => setMobWeek(w));
  };
  if ($('#mobClear')) $('#mobClear').onclick = () => confirmAction('Annullare tutte le settimane di sola mobilità?',
    'Le settimane interessate torneranno allo schema normale: forza, aerobico e mobilità.',
    'Annulla tutte', () => { S.mobilityWeeks = []; planCache = null; save(); renderSettings(); });
  $('#posSet').onclick = () => {
    const w = +$('#posWeek').value, d = +$('#posDay').value;
    const dd = Math.min(d, weekLen(w));
    const idx = weekStart(w) + (dd - 1);
    const alt = buildSession(idx);
    confirmAction('Spostare la posizione nel programma?',
      `La prossima seduta diventerà "${alt.label}", ${whereText(sessionMeta(idx))}. Lo storico dei carichi e le valutazioni restano invariati.`,
      'Imposta', () => { S.sessionIndex = idx; planCache = null; homeSel = 'session'; save(); renderSettings(); });
  };
  $('#posAuto').onclick = () => {
    const n = countProgramSessions();
    const alt = buildSession(n);
    confirmAction('Ricalcolare la posizione?',
      `Risultano ${n} sedute di programma registrate, quindi la prossima sarebbe "${alt.label}", ` +
      `${whereText(sessionMeta(n))}. Blocchi core, sedute libere e mobilità brevi non contano.`,
      'Allinea alla cronologia', () => { S.sessionIndex = n; realignHistory(); planCache = null; homeSel = 'session'; save(); renderSettings(); });
  };
  $('#progSel').onchange = e => { S.programId = e.target.value; save(); renderSettings(); };
  $('#setupSel').onchange = e => { S.setup = e.target.value; save(); };
  // (8) togliere le spunte sblocca burpee con salto e muscle-up: prima il fisioterapista
  const careOff = (box, key, what) => {
    if (box.checked) { S[key] = true; planCache = null; save(); return; }
    const when = S.physioDate ? `L'ultima valutazione che hai annotato è del ${dateIt(isoNoon(S.physioDate))}.` : 'Non hai ancora annotato una valutazione del fisioterapista.';
    box.checked = true;
    confirmAction('Hai il via libera del fisioterapista?',
      `Togliendo la spunta l'app potrà proporti ${what}. ${when} Toglila solo se il movimento non ti dà dolore, meglio dopo averlo sentito.`,
      'Sì, togli la spunta', () => { S[key] = false; planCache = null; save(); renderSettings(); });
  };
  $('#kneeChk').onchange = e => careOff(e.target, 'kneeCare', 'il burpee regolamentare con il salto e gli esercizi meno protettivi per il ginocchio');
  $('#physioDate').onchange = e => { S.physioDate = e.target.value || null; save(); };
  $('#bigChk').onchange = e => { S.bigScreen = e.target.checked; save(); applyLook(); };
  $('#themeSel').onchange = e => { S.theme = e.target.value; save(); applyLook(); };
  document.querySelectorAll('[data-unavoid]').forEach(b => b.onclick = () => { S.avoid = Object.assign({}, S.avoid); delete S.avoid[b.dataset.unavoid]; planCache = null; save(); renderSettings(); });
  $('#pullChk').onchange = e => { S.pullupGoal = e.target.checked; planCache = null; save(); };
  if ($('#spChk')) $('#spChk').onchange = e => { S.spartan = e.target.checked; planCache = null; save(); };
  $('#finSel').onchange = e => { S.finisher = e.target.value; planCache = null; save(); };
  $('#shoulderChk').onchange = e => careOff(e.target, 'shoulderCare', 'le tappe verso il muscle-up (dip, transizione, muscle-up) e gli esercizi meno protettivi per la spalla');
  $('#soundChk').onchange = e => { S.sound = e.target.checked; save(); if (e.target.checked) testBells(); };
  $('#testSound').onclick = testBells;
  $('#backupChk').onchange = e => { S.autoBackup = e.target.checked; save(); };
  $('#csvBtn').onclick = () => dangerAction('Esportare i dati in CSV?',
    `Verrà creato un foglio con ${S.logs.length} righe, una per esercizio registrato, apribile in Numbers o Excel. Il file finisce nei Download del telefono: chiunque vi acceda può leggerlo.`,
    'Esporta il CSV', exportCsv);
  document.querySelectorAll('[data-snap]').forEach(b => b.onclick = () => restoreSnapshot(+b.dataset.snap));
  $('#exportBtn').onclick = () => dangerAction('Esportare i tuoi dati?',
    `Verrà creato un file con ${S.logs.length} esercizi registrati, ${S.sessionLog.length} sedute e le tue impostazioni. Nella condivisione scegli «Salva in File» e la cartella ${BACKUP_PATH}: chiunque acceda a quella cartella può leggerlo.`,
    'Esporta il backup', exportData);
  $('#importBtn').onclick = () => dangerAction('Importare un backup?',
    `Il file scelto sostituirà i dati ora presenti sul telefono: ${S.logs.length} esercizi registrati e ${S.sessionLog.length} sedute andranno persi. Se ti servono ancora, esporta prima un backup.`,
    'Scegli il file da importare', () => $('#importFile').click());
  $('#importFile').onchange = e => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  if ($('#undoRestoreBtn')) $('#undoRestoreBtn').onclick = () => undoRestore();
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

function exportData(after) {
  S.lastExport = Date.now(); save();
  // (8) data e versione nel file: il ripristino guidato le mostra
  deliverFile(`palestra50-${new Date().toISOString().slice(0, 10)}.json`,
              JSON.stringify(Object.assign({}, S, { exportedAt: Date.now(), appVersion: APP_VER }), null, 2), 'application/json');
  if (typeof after === 'function') after(); else if (document.getElementById('view-settings') && document.getElementById('view-settings').classList.contains('active')) renderSettings();
}
/* (8) BACKUP DEL FINE SETTIMANA. Sabato e domenica, se l'ultimo backup ha più
   di cinque giorni, Oggi propone di salvarlo: un tocco apre la condivisione
   dell'iPhone, «Salva in File» e la cartella iCloud Drive › cm › Allenamenti ›
   palestra50 (iOS ricorda l'ultima cartella usata). Una PWA non può salvare
   da sola senza quel tocco. */
const BACKUP_PATH = 'iCloud Drive › cm › Allenamenti › palestra50';
function weekendBackupDue() {
  const d = new Date().getDay();
  return (d === 0 || d === 6) && (S.logs || []).length > 0 && (!S.lastExport || Date.now() - S.lastExport > 5 * DAY_MS_8);
}
function weekendBackupHtml() {
  if (!weekendBackupDue()) return '';
  return `<div class="card backupcard">
    <div class="kicker">Backup del fine settimana</div>
    <p class="small" style="margin:6px 0 10px">${S.lastExport ? `Ultimo backup ${dateIt(S.lastExport)}.` : 'Non hai ancora un backup.'} Tocca, scegli <b>Salva in File</b> e la cartella <b>${BACKUP_PATH}</b>.</p>
    <button class="btn" id="wkBackup">Salva in File</button></div>`;
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
      l.sIdx != null ? weekOfIdx(l.sIdx) : '',
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
/* (8) RIPRISTINO GUIDATO: prima di sostituire i dati si legge il backup e
   si mostra che cosa contiene (date, sedute, esercizi, posizione nel
   programma), confrontandolo con i dati sul telefono. I dati attuali restano
   in una copia di sicurezza, ripristinabile con «Annulla il ripristino». */
function backupSummary(d) {
  const logs = Array.isArray(d.logs) ? d.logs : [], sl = Array.isArray(d.sessionLog) ? d.sessionLog : [];
  const ts = logs.map(l => l && l.ts).concat(sl.map(x => x && x.ts)).filter(t => isFinite(t) && t > 0);
  const prog = sl.filter(x => x && isProgramKind(x.kind) && x.kind !== 'skipped');
  const last = sl.filter(x => x && x.ts).sort((a, b) => a.ts - b.ts).pop();
  return { logs: logs.length, sessions: prog.length, first: ts.length ? Math.min(...ts) : null, last: ts.length ? Math.max(...ts) : null,
           lastLabel: last ? sessLabel(last) : '', idx: Math.max(0, Math.round(d.sessionIndex) || 0),
           exportedAt: isFinite(d.exportedAt) ? d.exportedAt : null, ver: d.appVersion || '', measures: (d.measures || []).length };
}
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
    const b = backupSummary(data), now = backupSummary(S);
    const fmt = t => t ? dateIt(t) : '—';
    const older = now.last && b.last && b.last < now.last;
    const lost = Math.max(0, now.sessions - b.sessions);
    let where = '';
    try { where = whereText(sessionMeta(b.idx)); } catch (e) { where = ''; }
    openModal(`<h2>Controllo del backup</h2>
      <p class="small muted">${file && file.name ? esc(file.name) : 'File scelto'}${b.exportedAt ? ` · salvato il ${fmt(b.exportedAt)}` : ''}${b.ver ? ` · versione ${esc(b.ver)}` : ''}</p>
      <table class="cmp"><tr><th></th><th>Backup</th><th>Sul telefono</th></tr>
        <tr><td>Sedute del programma</td><td>${b.sessions}</td><td>${now.sessions}</td></tr>
        <tr><td>Esercizi registrati</td><td>${b.logs}</td><td>${now.logs}</td></tr>
        <tr><td>Dal</td><td>${fmt(b.first)}</td><td>${fmt(now.first)}</td></tr>
        <tr><td>Fino al</td><td>${fmt(b.last)}</td><td>${fmt(now.last)}</td></tr>
        <tr><td>Misure</td><td>${b.measures}</td><td>${now.measures}</td></tr></table>
      ${b.lastLabel ? `<p class="small" style="margin-top:10px">Ultima seduta nel backup: <b>${esc(b.lastLabel)}</b>${where ? ` · si riparte da ${esc(where)}` : ''}.</p>` : ''}
      ${older || lost ? `<div class="notice" style="margin-top:10px">Attenzione: il backup è più vecchio dei dati sul telefono${lost ? ` e ha ${lost} ${lost === 1 ? 'seduta' : 'sedute'} in meno` : ''}. Ripristinandolo perderesti ciò che hai fatto dopo il ${fmt(b.last)}.</div>`
        : '<p class="small muted" style="margin-top:10px">Il backup è aggiornato almeno quanto i dati sul telefono.</p>'}
      <p class="small muted">I dati attuali restano in una copia di sicurezza: dopo il ripristino puoi tornare indietro da Programma › «Annulla il ripristino».</p>
      <button class="btn" id="impGo" style="margin-top:12px">Ripristina questo backup</button>
      <button class="btn ghost" id="impNo" style="margin-top:10px">Annulla</button>`);
    $('#impNo').onclick = () => closeModal();
    $('#impGo').onclick = () => {
      try { localStorage.setItem(KEY + '.prerestore', JSON.stringify(Object.assign({}, S, { snapshots: [], savedAt: Date.now() }))); } catch (e) {}
      const keep = { seenVersion: S.seenVersion, splashDay: S.splashDay };
      S = Object.assign({}, DEFAULT_STATE, data, keep);
      delete S.exportedAt; delete S.appVersion;
      save(); planCache = null; closeModal(() => { go('home'); showToast('<div>Backup ripristinato.</div>', 3000); });
    };
  };
  reader.readAsText(file);
}
function undoRestore() {
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(KEY + '.prerestore') || 'null'); } catch (e) { prev = null; }
  if (!prev || !Array.isArray(prev.logs)) return false;
  confirmAction('Annullare il ripristino?', `Tornano i dati che c'erano sul telefono prima del ripristino (${prev.logs.length} esercizi registrati, copia del ${dateIt(prev.savedAt || Date.now())}).`,
    'Torna ai dati di prima', () => {
      S = Object.assign({}, DEFAULT_STATE, prev); delete S.savedAt;
      save(); planCache = null;
      try { localStorage.removeItem(KEY + '.prerestore'); } catch (e) {}
      go('home');
    });
  return true;
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
     · negli ultimi 3 secondi di ogni tenuta o scatto, con il colpo acuto
       finale: "puoi rilasciare".
   I rintocchi troppo vicini a un colpo appena suonato vengono omessi, così una
   pausa brevissima non produce mai campane sovrapposte.
--------------------------------------------------------------------------- */
function marksOf(segs) {
  const raw = [];
  segs.forEach(s => {
    // anche le fasi di lavoro (tenute, scatti) hanno il conto alla rovescia
    // negli ultimi 3 secondi, poi il colpo acuto di fine
    if (s.kind === 'work') {
      for (let k = 3; k >= 1; k--) if (s.end - k >= s.start + 1) raw.push([s.end - k, false]);
      raw.push([s.end, true]);
      return;
    }
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
const finalRestOf = (it, ex) => CARDIO_ROLES.includes(it.role) ? 10 : Math.max(it.rest, ex.type === 'stretch' ? 30 : 45);

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
  chain = { segs, idx: 0, audioT0: t0, countUp: !!(opts && opts.countUp) };
  const mini = opts && opts.mini;
  $('#timer').classList.toggle('on', !mini);
  $('#miniTimer').classList.toggle('on', !!mini);
  document.body.classList.toggle('mini-on', !!mini);
  unlockAudio();
  // a cronometro la fine non è prevedibile: si suona solo la preparazione
  playBells(specOf(relSegs(chain.countUp ? defs.slice(0, 1) : defs)), 0);
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
    : work ? (chain.countUp ? 'Fine tenuta' : 'Termina la tenuta')
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
    if (seg.onEnd && seg.onEnd(seg) === true) redrawn = true;
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
  // a cronometro il numero sale invece di scendere: è il tempo che stai tenendo
  const up = chain.countUp && seg.kind === 'work';
  const shown = up ? Math.max(0, Math.floor((now - seg.start) / 1000)) : left;
  // in preparazione si mostra solo la cifra che scorre: resta centrata nel cerchio
  const txt = prep ? String(left) : `${Math.floor(shown / 60)}:${String(shown % 60).padStart(2, '0')}`;
  $('#timerCount').textContent = txt;
  $('#miniCount').textContent = txt;
  $('#ringFill').setAttribute('stroke-dashoffset', String(prep || up ? 0 : 283 * (1 - Math.min(1, left / dur))));
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

/* ---------------------------------------------------------------------------
   SCORRIMENTO FRA GLI ESERCIZI (dalla 5.3)
   Dito verso destra → esercizio successivo; verso sinistra → precedente.
   È solo una consultazione: non registra nulla, non chiude l'esercizio e non
   tocca il timer, che continua a scorrere (le tenute in corso restano legate
   all'esercizio da cui sono partite).
--------------------------------------------------------------------------- */
function swipeTo(dir) {
  const c = current;
  if (!c || c.finished) return;
  const n = c.pos + dir;
  if (n < 0 || n >= c.sess.items.length) return;
  captureLoad();
  const v = $('#view-session');
  v.classList.add(dir > 0 ? 'swipe-next' : 'swipe-prev');
  setTimeout(() => {
    if (!current || current.finished) return;
    current.pos = n; saveResume(); renderSession();
    v.classList.remove('swipe-next', 'swipe-prev');
  }, 120);
}
(function bindSwipe() {
  const v = document.getElementById('view-session');
  if (!v) return;
  let x0 = null, y0 = 0, t0 = 0;
  v.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { x0 = null; return; }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  v.addEventListener('touchend', e => {
    if (x0 === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
    x0 = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || dt > 800) return;
    // (7S 4) come sfogliare le pagine su iPhone: pollice verso sinistra =
    // esercizio successivo; verso destra = precedente
    swipeTo(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

$('#timerSkip').onclick = skipTimer;
$('#timerStop').onclick = cancelTimer;
$('#miniSkip').onclick = skipTimer;
$('#miniStop').onclick = cancelTimer;
$('#timerMin').onclick = minimizeTimer;
$('#miniExpand').onclick = expandTimer;
$('#timerPlus').onclick = () => {
  if (!chain || chain.countUp || chain.segs[chain.idx].kind === 'prep') return;
  shiftChain(15000); restartBells(); tick();
};
$('#timerMinus').onclick = () => {
  if (!chain || chain.countUp || chain.segs[chain.idx].kind === 'prep') return;
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
  $('#cfOk').onclick = () => closeModal(() => onOk());
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

/* La dissolvenza di chiusura dura 200 ms. Se in quei 200 ms si apre un altro
   modale — è il caso di "Chiudi seduta", che conferma e subito dopo mostra il
   riepilogo — il timeout della chiusura precedente spegneva anche il nuovo:
   la schermata restava vuota e senza vie d'uscita. Ora l'apertura annulla la
   chiusura in corso, e ciò che segue una conferma parte DOPO la dissolvenza. */
let modalTimer = null;
function openModal(html) {
  const m = $('#modal');
  if (modalTimer) { clearTimeout(modalTimer); modalTimer = null; }
  m.classList.remove('closing');
  $('#modalBox').innerHTML = html;
  m.classList.add('on');
}
function closeModal(then) {
  const m = $('#modal');
  // alcuni pulsanti passano closeModal direttamente come gestore: l'argomento
  // è l'evento del tocco, non una funzione da eseguire dopo
  if (typeof then !== 'function') then = null;
  if (!m.classList.contains('on')) { if (then) then(); return; }
  m.classList.add('closing');                    // dissolvenza e rientro verso il basso
  if (modalTimer) clearTimeout(modalTimer);
  modalTimer = setTimeout(() => {
    modalTimer = null;
    m.classList.remove('on', 'closing');
    if (then) then();
    setTimeout(() => tryApplyUpdate(), 0);           // (7S 4) aggiornamento in attesa
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
  // "Oggi" riporta sempre alla scelta fra mattino e seduta del giorno
  if (b.dataset.go === 'home') homeView = null;
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
/* ---------------------------------------------------------------------------
   AGGIORNAMENTO AUTOMATICO (dalla 7S 4)
   Con la rete i file dell'app arrivano già nuovi da GitHub; restava in attesa
   solo il service worker nuovo, e serviva toccare «Aggiornamento pronto».
   Ora si applica da solo appena non c'è una seduta in corso né una scheda
   aperta (dove potresti star scrivendo): a metà seduta aspetta la fine.
--------------------------------------------------------------------------- */
let pendingSw = null;
function tryApplyUpdate(reg) {
  if (reg) pendingSw = reg;
  const r = pendingSw;
  if (!r || !r.waiting) return;
  if (current && !current.finished) return;                       // seduta in corso: si aspetta
  if (document.getElementById('splash')) return;                  // (8.1) intro da leggere: si aspetta
  const m = document.getElementById('modal');
  if (m && m.classList.contains('on')) return;                    // scheda aperta: si aspetta
  try { r.waiting.postMessage('skipWaiting'); } catch (e) {}      // controllerchange → ricarica
}

/* (8) Aspetto: numeri grandi in seduta e tema (scuro, chiaro, automatico). */
function applyLook() {
  const b = document.body;
  b.classList.toggle('big', S.bigScreen !== false);
  const dark = S.theme === 'light' ? false : S.theme === 'auto'
    ? !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) : true;
  b.classList.toggle('light', !dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0E1620' : '#F4F6F8');
}
try {
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (S && S.theme === 'auto') applyLook(); });
} catch (e) {}

/* Pop-up alla prima apertura dopo un aggiornamento. La versione si legge
   dall'intro (index.html), la stessa che scrive version.sh. */
const APP_VER = (() => {
  const el = document.querySelector('.splash .ver');
  return el ? el.textContent.trim().replace(/\s+\d{4}$/, '') : '';
})();
function showUpdatedPopup(then) {
  const next = typeof then === 'function' ? then : () => {};
  if (!APP_VER || S.seenVersion === APP_VER) { next(); return false; }
  // prima installazione: niente festa, si memorizza e basta
  if (!S.seenVersion && !(S.logs || []).length && !(S.sessionLog || []).length) {
    S.seenVersion = APP_VER; save(); next(); return false;
  }
  const colors = ['#F5A524', '#4FC3A1', '#B49CFF', '#EF8A5B', '#FFD27A'];
  const confetti = Array.from({ length: 30 }, (_, i) => {
    const a = (i / 30) * Math.PI * 2 + (i % 2) * 0.1, r = 50 + (i % 4) * 7;
    return `<rect class="conf" x="${(60 + Math.cos(a) * r).toFixed(1)}" y="${(60 + Math.sin(a) * r).toFixed(1)}" width="5" height="9" rx="1.5"
      fill="${colors[i % colors.length]}" transform="rotate(${(i * 37) % 360} ${(60 + Math.cos(a) * r).toFixed(1)} ${(60 + Math.sin(a) * r).toFixed(1)})"
      style="animation-delay:${(0.9 + (i % 6) * 0.05).toFixed(2)}s"/>`;
  }).join('');
  openModal(`<div class="cheer updcheer">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      ${confetti}
      <circle class="ring" cx="60" cy="60" r="40" fill="none" stroke="#F5A524" stroke-width="7"
              stroke-linecap="round" transform="rotate(-90 60 60)"/>
      <path class="tick" d="M60 80 L60 42 M45 56 L60 41 L75 56" fill="none" stroke="#EAF1F8" stroke-width="8"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <h2>App aggiornata alla versione ${esc(APP_VER)}!</h2>
    <p class="sub">Tutto pronto e tutti i tuoi dati al loro posto. Buon allenamento!</p>
    <button class="btn" id="updOk" style="margin-top:18px">Andiamo!</button>
  </div>`);
  $('#updOk').onclick = () => { S.seenVersion = APP_VER; save(); closeModal(next); };
  return true;
}
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting) tryApplyUpdate(reg);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) tryApplyUpdate(reg);
      });
    });
    // un controllo all'apertura e uno ogni ora: l'aggiornamento non dipende
    // più dal ricordarsi di chiudere l'app dal multitasking
    reg.update().catch(() => {});
    setInterval(() => reg.update().catch(() => {}), 3600 * 1000);
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return; reloaded = true;
    // (8.7) la ricarica dopo l'aggiornamento non ripropone l'intro: si torna
    // diritti alla pagina d'apertura (il pop-up, se non già visto, compare lì)
    try { sessionStorage.setItem('p50reload', String(Date.now())); } catch (e) {}
    location.reload();
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
  migrateWeek6();                  // dalla 5.0: settimane da 6 sedute
  migrateToMacro();
  migrateNames();
  resetCalfLogs();
  migrateLogFields();
  migrateRealign();
  seedPaceFromHistory();
  migrateRatings();
  applyLook();
  goToday();
  // l'intro si anima per 3 secondi e resta sull'ultimo fotogramma: sparisce solo
  // quando l'utente tocca lo schermo, e solo dopo compare l'avvertenza
  const splash = document.getElementById('splash');
  const afterSplash = () => {
    const poi = () => {
      if (!S.disclaimerOk) { disclaimer(); return; }
      // (7S 4) prima apertura dopo un aggiornamento: il pop-up, poi il resto
      showUpdatedPopup(() => {
        // (8) la domenica, alla prima apertura: riepilogo della settimana
        if (maybeSundayRecap()) return;
        askMobilityWeek();
        if (!$('#modal').classList.contains('on')) fixOrphanSessions();
      });
    };
    if (!splash || splash.dataset.done) { poi(); return; }
    splash.dataset.done = '1';
    splash.classList.add('hide');
    setTimeout(() => {
      if (splash.parentNode) splash.parentNode.removeChild(splash);
      poi();
      setTimeout(() => tryApplyUpdate(), 0);      // (8.1) l'aggiornamento in attesa, ora che l'intro è chiusa
    }, 420);
  };
  const qEl = document.getElementById('splashQuote');
  if (qEl) qEl.textContent = pickQuote();
  // riga dinamica sotto il titolo: a che punto sei del percorso. È la cosa che
  // più tiene in riga nei mesi lunghi — vedere che la meta si avvicina.
  const gEl = document.getElementById('splashGoal');
  if (gEl) {
    try {
      const path = pathStatus();
      const days = Math.max(0, Math.round((path.end - Date.now()) / 86400000));
      gEl.textContent = (path.weeksLeft > 0
        ? `${weekText(path.meta, { cap: true })} · ${days} giorni alla meta`
        : 'Ultima settimana del percorso: ci sei.') +
        // (8) conto alla rovescia della Spartan Race
        (SP() && spPhase(Date.now()) !== 'off' ? ` · ${weeksToRace()} settimane alla Spartan` : '');
    } catch (e) { gEl.textContent = ''; }
  }
  // (8.2) l'intro si sviluppa per intero a ogni avvio e resta a schermo
  // finché non la tocchi: la frase e il percorso si devono poter leggere
  // (su richiesta dell'utente; la versione breve della 8 è stata tolta)
  let skipIntro = false;
  try {
    const t = +sessionStorage.getItem('p50reload');
    skipIntro = !!t && Date.now() - t < 120000;
    sessionStorage.removeItem('p50reload');
  } catch (e) {}
  if (splash && skipIntro) { splash.dataset.done = '1'; if (splash.parentNode) splash.parentNode.removeChild(splash); afterSplash(); }
  else if (splash) splash.onclick = afterSplash; else afterSplash();
  registerServiceWorker();
})();
