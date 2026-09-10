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

let DB = { exercises: [] }, PROG = null, POSES = null;
let S = null;              // stato persistente
let current = null;        // sessione in corso
let planCache = null;      // sessione di oggi già generata (per mantenere le sostituzioni)
let wakeLock = null, audioCtx = null, timerHandle = null;

/* ---------------------------------------------------------------------------
   1. STATO
--------------------------------------------------------------------------- */
const DEFAULT_STATE = {
  v: 1,
  setup: 'gym',            // 'gym' | 'home'
  programId: 'tono50',
  sessionIndex: 0,         // numero progressivo della prossima sessione da fare
  kneeCare: true,          // dà priorità agli esercizi a basso impatto sul ginocchio
  sound: true,             // campanella del timer
  audioMode: 'mix',        // 'mix' = suona sopra la musica, 'solo' = priorità alla campanella
  disclaimerOk: false,
  logs: [],                // storico per esercizio
  sessionLog: []           // storico per sessione (durata, note)
};

function load() {
  try { S = Object.assign({}, DEFAULT_STATE, JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch (e) { S = Object.assign({}, DEFAULT_STATE); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

/* ---------------------------------------------------------------------------
   2. DATI
--------------------------------------------------------------------------- */
async function loadData() {
  const [ex, pr, po] = await Promise.all([
    fetch('exercises.json').then(r => r.json()),
    fetch('programs.json').then(r => r.json()),
    fetch('poses.json').then(r => r.json())
  ]);
  DB = ex; PROG = pr; POSES = po;
}
const exById = id => DB.exercises.find(e => e.id === id);
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
    case 'cable':        return `<line x1="112" y1="6" x2="112" y2="100" class="imp" stroke-width="3"/>` + band(112, Math.min(h[1], 30));
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
  const s = `<svg viewBox="${POSES.viewBox}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`;
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

/* Dose (serie, ripetizioni, recupero) per un obiettivo e una settimana.
   Gli esercizi unilaterali (un lato alla volta) ricevono sempre un numero PARI
   di serie, così destra e sinistra lavorano lo stesso numero di volte. */
function dose(goalKey, profile, ex) {
  const g = PROG.goals[goalKey];
  let sets = Math.min(6, Math.max(2, g.sets + (profile.setsDelta || 0)));
  const perSide = !!(ex && ex.perSide);
  if (perSide && sets % 2) sets++;                 // arrotonda al pari superiore
  const reps = Math.round(g.repsLow + (g.repsHigh - g.repsLow) * profile.repsBias);
  return {
    goal: goalKey, goalLabel: g.label, sets, reps, perSide,
    rest: g.rest, hold: g.hold || 0, rpe: g.rpe, source: g.source
  };
}
/* Etichetta della singola serie: per gli unilaterali alterna sinistra e destra. */
function setLabel(it, i) {
  if (!it.perSide) return String(i + 1);
  return `${Math.floor(i / 2) + 1}${i % 2 ? ' Dx' : ' Sx'}`;
}

/* Suggerimento di carico basato sull'ultima seduta e sul feedback dato. */
function lastEntry(exId) {
  for (let i = S.logs.length - 1; i >= 0; i--) if (S.logs[i].exId === exId) return S.logs[i];
  return null;
}
function suggestLoad(ex) {
  const last = lastEntry(ex.id);
  if (!last) return null;
  if (ex.load === 'band') {
    let i = BANDS.indexOf(last.load);
    if (i < 0) i = 0;
    if (last.feedback === 'up') i = Math.min(BANDS.length - 1, i + 1);
    if (last.feedback === 'down') i = Math.max(0, i - 1);
    return { value: BANDS[i], last };
  }
  if (ex.load !== 'weight') return { value: null, last };
  const n = parseFloat(last.load);
  if (!isFinite(n)) return { value: null, last };
  const f = last.feedback === 'up' ? 1.05 : last.feedback === 'down' ? 0.93 : 1;
  const raw = n * f;
  const step = raw < 10 ? 0.5 : 1;
  return { value: (Math.round(raw / step) * step).toString(), last };
}

/* ---------------------------------------------------------------------------
   5. GENERAZIONE DELLA SESSIONE
   La sessione è deterministica: dipende solo da (indice sessione, programma,
   attrezzatura). Cambiando mesociclo la rotazione sposta la scelta nel pool,
   così gli esercizi cambiano automaticamente ogni ciclo.
--------------------------------------------------------------------------- */
function sessionMeta(idx) {
  const p = program();
  const dayInWeek = (idx % 5) + 1;
  const weekAbs = Math.floor(idx / 5) + 1;
  const weekInCycle = ((weekAbs - 1) % p.cycleWeeks) + 1;
  const mesocycle = Math.floor((weekAbs - 1) / p.cycleWeeks) + 1;
  const isStrength = DAYS_STRENGTH.includes(dayInWeek);
  return { idx, dayInWeek, weekAbs, weekInCycle, mesocycle, isStrength,
           tmplIdx: isStrength ? DAYS_STRENGTH.indexOf(dayInWeek) : DAYS_STRETCH.indexOf(dayInWeek),
           profile: weekProfile(weekInCycle, p.cycleWeeks), program: p };
}

function pickFrom(pool, rotation, used) {
  if (!pool.length) return null;
  for (let k = 0; k < pool.length; k++) {
    const cand = pool[(rotation + k) % pool.length];
    if (!used.has(cand.id)) { used.add(cand.id); return cand; }
  }
  return pool[rotation % pool.length];
}

function buildStrength(meta) {
  const tmpl = meta.program.strengthDays[meta.tmplIdx];
  const used = new Set(), items = [];
  tmpl.slots.forEach((slot, i) => {
    // Il pool si costruisce pattern per pattern: così il filtro "ginocchio" non
    // cancella un intero schema di movimento (es. gli affondi) lasciando in piedi
    // solo un altro pattern dello stesso slot.
    let pool = [];
    slot.patterns.forEach(pat => {
      let sub = DB.exercises.filter(e => e.setup.includes(S.setup) &&
        (e.type === 'strength' || e.type === 'core') && e.pattern === pat);
      if (S.kneeCare) {
        const safe = sub.filter(e => e.kneeFriendly);
        if (safe.length) sub = safe;
      }
      pool = pool.concat(sub.sort((a, b) => a.id.localeCompare(b.id)));
    });
    const rot = (meta.mesocycle - 1) * (meta.tmplIdx + 2) + i;   // rotazione per mesociclo
    const ex = pickFrom(pool, rot, used);
    if (!ex) return;
    const goalKey = slot.goal || tmpl.goal;
    items.push({ exId: ex.id, note: slot.note || '', goalKey,
                 alt: { patterns: slot.patterns.slice(), types: ['strength', 'core'] },
                 ...dose(goalKey, meta.profile, ex) });
  });
  return { label: tmpl.label, type: 'strength', items };
}

function buildStretch(meta) {
  const tmpl = meta.program.stretchDays[meta.tmplIdx];
  const used = new Set(), items = [];
  const dyn = DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'mobility' && e.setup.includes(S.setup));
  const stat = DB.exercises.filter(e => e.type === 'stretch' && e.pattern === 'static' && e.setup.includes(S.setup)
                                        && tmpl.staticGroups.includes(e.group));
  dyn.sort((a, b) => a.id.localeCompare(b.id));
  stat.sort((a, b) => a.id.localeCompare(b.id));
  const rot = (meta.mesocycle - 1) * 2 + meta.tmplIdx + (meta.weekInCycle - 1);
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
  return { label: tmpl.label, type: 'stretch', items };
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
  const trimmed = fitToTime(body.items, kind === 'core' ? 14 : 32);
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
  return Math.round(sec / 60);
}

/* Vincolo dei 30 minuti: se la seduta è troppo lunga si riduce prima il volume
   degli esercizi accessori (mai il primo, che è il movimento principale) e solo
   in ultima istanza si toglie l'ultimo esercizio. */
function fitToTime(items, maxMin) {
  let trimmed = false, guard = 0;
  while (estimateMinutes(items) > maxMin && guard++ < 30) {
    let i = -1;
    for (let k = items.length - 1; k >= 1; k--) if (items[k].sets > (items[k].perSide ? 2 : 2)) { i = k; break; }
    if (i >= 0) { items[i].sets -= items[i].perSide ? 2 : 1; trimmed = true; continue; }
    if (items.length > 4) { items.pop(); trimmed = true; continue; }
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
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.go === view));
  window.scrollTo(0, 0);
  if (view === 'home') renderHome();
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
}

function doseText(it) {
  const side = it.perSide ? ` (${it.sets / 2} per lato)` : '';
  if (it.goal === 'stretch') return `${it.sets}× ${it.hold}s${side}`;
  if (it.goal === 'mobility') return `${it.sets}× ${it.reps}${side}`;
  const ex = exById(it.exId);
  if (ex && ex.load === 'time') return `${it.sets}× ${20 + it.reps}s${side}`;
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
    (!alt.groups || alt.groups.includes(e.group)));
  if (S.kneeCare) {
    const safe = pool.filter(e => e.kneeFriendly);
    if (safe.length) pool = safe;
  }
  pool.sort((a, b) => a.id.localeCompare(b.id));
  return pool.filter(e => e.id === item.exId || !inUse.has(e.id));
}

/* Passa all'alternativa successiva, ricalcolando la dose sul nuovo esercizio. */
function swapExercise(item, sess) {
  const pool = alternativesFor(item, sess);
  if (pool.length < 2) return false;
  const i = pool.findIndex(e => e.id === item.exId);
  const next = pool[(i + 1) % pool.length];
  const d = dose(item.goalKey || item.goal, sess.profile, next);
  item.exId = next.id;
  item.sets = d.sets; item.reps = d.reps; item.rest = d.rest;
  item.hold = d.hold; item.perSide = d.perSide; item.source = d.source;
  return true;
}

/* La seduta del giorno viene generata una volta sola e tenuta in memoria: così
   le sostituzioni fatte dalla home restano valide quando si preme "Inizia". */
function todaySession(kind) {
  const key = `${S.programId}|${S.setup}|${S.sessionIndex}|${kind || ''}`;
  if (!planCache || planCache.key !== key) planCache = { key, sess: buildSession(S.sessionIndex, kind) };
  return planCache.sess;
}

function renderHome() {
  const s = todaySession(null);
  const p = program();
  $('#topTitle').textContent = 'Oggi';
  $('#topChip').textContent = `Sett. ${s.weekInCycle}/${p.cycleWeeks} · ciclo ${s.mesocycle}`;
  $('#topChip').className = 'chip ' + (s.isStrength ? 'strength' : 'mobility');

  const rows = s.items.map((it, i) => {
    const ex = exById(it.exId);
    return `<li data-plan="${i}"><div class="fig">${figureFor(ex, 1, { ground: false })}</div>
      <div class="nm"><b>${esc(ex.name)}</b><span class="small muted">${esc(ex.group)}${it.note ? ' · ' + esc(it.note) : ''}</span></div>
      <div class="dose">${doseText(it)}</div><div class="chev">›</div></li>`;
  }).join('');

  // banner di ripresa se una sessione è rimasta aperta
  const resume = (current && !current.finished)
    ? `<div class="notice" style="margin-top:14px;display:flex;align-items:center;gap:12px">
         <span style="flex:1">Sessione in corso: ${esc(current.sess.label)}</span>
         <button class="btn" id="resumeBtn" style="width:auto;min-height:44px;font-size:17px">Riprendi</button>
       </div>` : '';

  $('#view-home').innerHTML = `
    ${resume}
    <div class="seg" role="group" aria-label="Attrezzatura">
      <button data-setup="gym" aria-pressed="${S.setup === 'gym'}">Palestra</button>
      <button data-setup="home" aria-pressed="${S.setup === 'home'}">Casa</button>
    </div>

    <div class="card">
      <div class="session-head ${s.isStrength ? '' : 'mobility'}">
        <div>
          <div class="kicker">Sessione ${s.dayInWeek} di 5 · ${s.isStrength ? 'potenziamento' : 'mobilità'}</div>
          <h2>${esc(s.label)}</h2>
          <p class="small muted" style="margin:6px 0 0">${esc(s.profile.note)} Durata stimata ${s.minutes} minuti.${s.trimmed ? ' Volume adattato per restare nei 30 minuti.' : ''}</p>
        </div>
      </div>
      <ul class="plan">${rows}</ul>
      <p class="small muted" style="margin-top:10px">Tocca un esercizio per aprire la scheda con esecuzione, muscoli coinvolti ed errori da evitare.</p>
    </div>

    <button class="btn ${s.isStrength ? '' : 'teal'}" id="startBtn">Inizia la sessione</button>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn ghost" id="coreBtn">Solo blocco core</button>
      <button class="btn ghost" id="skipBtn">Salta a domani</button>
    </div>
    <p class="small muted" style="margin-top:16px">Programma attivo: ${esc(p.name)} · ${esc(p.periodization)}.</p>
  `;

  document.querySelectorAll('[data-setup]').forEach(b => b.onclick = () => {
    if (current && !current.finished) return;   // non cambiare attrezzatura a sessione aperta
    S.setup = b.dataset.setup; save(); renderHome();
  });
  // ogni riga dell'elenco apre la scheda illustrativa dell'esercizio
  document.querySelectorAll('[data-plan]').forEach(li => li.onclick = () => {
    const it = s.items[+li.dataset.plan];
    openSheet(exById(it.exId), it, () => { if (swapExercise(it, s)) renderHome(); });
  });
  if ($('#resumeBtn')) $('#resumeBtn').onclick = () => { go('session'); renderSession(); };
  const begin = kind => {
    if (current && !current.finished) {
      confirmAction('Sessione già in corso', 'Vuoi abbandonarla e iniziarne una nuova? Gli esercizi già conclusi restano nello storico.',
        'Inizia una nuova sessione', () => startSession(todaySession(kind)));
    } else startSession(todaySession(kind));
  };
  $('#startBtn').onclick = () => begin(null);
  $('#coreBtn').onclick = () => begin('core');
  $('#skipBtn').onclick = () => confirmAction('Saltare la seduta di oggi?',
    'Passerai alla sessione successiva del programma senza registrare questa.',
    'Salta', () => { S.sessionIndex++; planCache = null; save(); renderHome(); });
}

/* ---------- sessione in corso ---------- */
function startSession(sess) {
  current = { sess, pos: 0, setsDone: sess.items.map(() => 0), loads: sess.items.map(() => ''),
              feedback: sess.items.map(() => null), started: Date.now() };
  requestWakeLock();
  unlockAudio();
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

  let loadCtl = '';
  if (ex.load === 'weight') {
    loadCtl = `<input id="loadIn" type="number" inputmode="decimal" step="0.5" placeholder="kg"
                 value="${esc(c.loads[c.pos] || (sug && sug.value) || '')}">`;
  } else if (ex.load === 'band') {
    loadCtl = `<select id="loadIn">${BANDS.map(b =>
      `<option ${((c.loads[c.pos] || (sug && sug.value)) === b) ? 'selected' : ''}>${b}</option>`).join('')}</select>`;
  } else {
    loadCtl = `<input id="loadIn" type="text" placeholder="note (es. rip. eseguite)" value="${esc(c.loads[c.pos] || '')}">`;
  }

  const nAlt = alternativesFor(it, s).length;

  // esercizi a tempo: stretching statico, plank, wall sit, tenute isometriche
  const timed = it.goal === 'stretch' || it.hold > 0 || ex.load === 'time';
  const hold = it.hold ? it.hold : (ex.load === 'time' ? 20 + it.reps : 30);

  const lastTxt = sug && sug.last
    ? `Ultima volta: <b>${esc(sug.last.load || '—')}</b> ${arrow(sug.last.feedback)} · ${new Date(sug.last.ts).toLocaleDateString('it-IT')}`
    : 'Prima volta con questo esercizio: parti conservativo e annota il carico.';

  $('#view-session').innerHTML = `
    <div class="progress">${bars}</div>
    <div class="exercise">
      <div class="fig-large">${figureFor(ex, 1)}</div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-top:14px">
        <div><h2>${esc(ex.name)}</h2>
          <div class="small muted">${esc(ex.group)} · ${esc(it.goalLabel)} · RPE ${esc(it.rpe)}</div></div>
        <div class="dose-big num">${doseText(it)}<br><small>rec. ${it.rest}s</small></div>
      </div>

      <div class="setdots">${setBtns}</div>

      <div class="loadrow">
        ${loadCtl}
        <div class="feedback">
          <button data-fb="up"   aria-pressed="${c.feedback[c.pos] === 'up'}" aria-label="Più facile del previsto">↑</button>
          <button data-fb="same" aria-pressed="${c.feedback[c.pos] === 'same'}" aria-label="Invariato">–</button>
          <button data-fb="down" aria-pressed="${c.feedback[c.pos] === 'down'}" aria-label="Più difficile del previsto">↓</button>
        </div>
      </div>
      <p class="lasttime">${lastTxt}</p>

      <button class="btn ${timed ? 'teal' : ''}" id="doneSet" style="margin-top:16px">${timed ? 'Avvia ' + hold + ' secondi' + (it.perSide ? ' (' + (c.setsDone[c.pos] % 2 ? 'lato destro' : 'lato sinistro') + ')' : '') : 'Ho finito la serie'}</button>
      ${timed ? `<p class="small muted" style="margin-top:8px">Tre secondi di preparazione scanditi dalla campanella, poi parte il conteggio: mantieni la posizione fino al rintocco finale. Gli ultimi tre secondi sono scanditi da un rintocco ciascuno.${it.goal === 'stretch' ? ' Ogni serie è un lato solo: il pulsante ti dice quale.' : ''}</p>` : ''}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="infoBtn">Scheda esercizio</button>
        <button class="btn ghost" id="swapBtn" ${nAlt < 2 ? 'disabled' : ''}>Cambia esercizio${nAlt > 1 ? ` (${nAlt - 1})` : ''}</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="postponeBtn" ${c.pos === s.items.length - 1 ? 'disabled' : ''}>Rimanda a dopo</button>
        <button class="btn ghost" id="orderBtn" ${c.pos === s.items.length - 1 ? 'disabled' : ''}>Ordine esercizi</button>
      </div>
      <button class="btn ghost" id="nextBtn" style="margin-top:10px">${c.pos === s.items.length - 1 ? 'Chiudi sessione' : 'Prossimo esercizio'}</button>
      <p class="small muted" style="margin-top:14px">${esc(it.source)}${it.note ? ' · ' + esc(it.note) : ''}</p>
      <button class="btn ghost" id="abortBtn" style="margin-top:18px">Interrompi</button>
    </div>`;

  document.querySelectorAll('[data-set]').forEach(b => b.onclick = () => {
    const i = +b.dataset.set;
    c.setsDone[c.pos] = (c.setsDone[c.pos] === i + 1) ? i : i + 1;
    renderSession();
  });
  document.querySelectorAll('[data-fb]').forEach(b => b.onclick = () => {
    c.feedback[c.pos] = c.feedback[c.pos] === b.dataset.fb ? null : b.dataset.fb;
    captureLoad(); renderSession();
  });
  $('#loadIn').onchange = captureLoad;
  // conclude una serie e avvia il recupero
  const closeSet = () => {
    captureLoad();
    if (c.setsDone[c.pos] < it.sets) c.setsDone[c.pos]++;
    const finished = c.setsDone[c.pos] >= it.sets;
    const rest = finished ? Math.max(it.rest, 45) : it.rest;
    const what = finished
      ? (c.pos === s.items.length - 1 ? 'Recupero finale' : `Poi: ${exById(s.items[c.pos + 1].exId).name}`)
      : `Serie ${c.setsDone[c.pos] + 1} di ${it.sets} · ${ex.name}`;
    renderSession();
    startTimer(rest, what, () => { if (finished) nextExercise(); }, 'rest');
  };

  $('#doneSet').onclick = () => {
    captureLoad();
    if (timed) {
      // cronometro della tenuta: al termine parte da solo il recupero
      startTimer(hold, `Tenuta · ${ex.name}`, closeSet, 'work', 3);
    } else closeSet();
  };
  $('#infoBtn').onclick = () => openSheet(ex, it, () => { if (swapExercise(it, s)) renderSession(); });
  $('#swapBtn').onclick = () => {
    if (c.setsDone[c.pos] > 0) {
      confirmAction('Cambiare esercizio?', 'Hai già completato qualche serie: verranno azzerate per il nuovo esercizio.',
        'Cambia', () => { c.setsDone[c.pos] = 0; c.loads[c.pos] = ''; c.feedback[c.pos] = null; if (swapExercise(it, s)) renderSession(); });
    } else if (swapExercise(it, s)) renderSession();
  };
  $('#postponeBtn').onclick = () => { captureLoad(); stopTimer(); postponeCurrent(); };
  $('#orderBtn').onclick = () => { captureLoad(); openReorder(); };
  $('#nextBtn').onclick = () => {
    captureLoad();
    if (c.pos === s.items.length - 1) {
      confirmAction('Chiudere la sessione?', 'Stai per concludere l\'ultimo esercizio e chiudere la seduta.',
        'Chiudi la sessione', () => { stopTimer(); nextExercise(); });
    } else if (c.setsDone[c.pos] < it.sets) {
      confirmAction('Passare al prossimo esercizio?',
        `Hai completato ${c.setsDone[c.pos]} serie su ${it.sets}.`, 'Vai avanti',
        () => { stopTimer(); nextExercise(); });
    } else { stopTimer(); nextExercise(); }
  };
  $('#abortBtn').onclick = () => confirmAction('Interrompere la sessione?',
    'Gli esercizi già conclusi restano nello storico, il resto della seduta viene abbandonato.',
    'Interrompi', () => { stopTimer(); releaseWakeLock(); current = null; go('home'); });
}

/* Sposta un esercizio nella scaletta insieme ai dati già inseriti (serie fatte,
   carico, feedback), così l'ordine può essere adattato al volo se una macchina
   o un attrezzo è occupato. Si possono spostare solo gli esercizi non ancora
   conclusi, cioè dalla posizione corrente in poi. */
function moveItem(from, to) {
  const c = current, s = c.sess;
  if (from === to || from < c.pos || to < c.pos || to >= s.items.length) return;
  [s.items, c.setsDone, c.loads, c.feedback].forEach(arr => {
    const v = arr.splice(from, 1)[0];
    arr.splice(to, 0, v);
  });
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
        <div class="nm" style="flex:1"><b>${esc(ex.name)}</b>
          <div class="small muted">${esc(ex.group)} · ${doseText(it)}${i === c.pos ? ' · in corso' : ''}</div></div>
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
    $('#reorderOk').onclick = () => { closeModal(); renderSession(); };
  };
  draw();
}

function captureLoad() {
  const el = $('#loadIn');
  if (el && current) current.loads[current.pos] = el.value;
}
const arrow = f => f === 'up' ? '<span class="trend-up">↑</span>' : f === 'down' ? '<span class="trend-down">↓</span>' : '–';

function nextExercise() {
  const c = current, s = c.sess;
  if (c.finished) return;              // evita doppie registrazioni sull'ultimo esercizio
  // registra l'esercizio appena concluso
  const it = s.items[c.pos];
  S.logs.push({ ts: Date.now(), exId: it.exId, name: exById(it.exId).name, setup: S.setup,
                load: c.loads[c.pos] || '', feedback: c.feedback[c.pos] || 'same',
                sets: c.setsDone[c.pos], reps: it.reps, goal: it.goal, week: s.weekInCycle });
  save();
  if (c.pos < s.items.length - 1) { c.pos++; renderSession(); }
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
    S.sessionLog.push({ ts: Date.now(), idx: s.idx, label: s.label, kind: s.kind, minutes: mins,
      note: withNote ? ($('#sNote').value || '') : '' });
    if (s.kind !== 'core') S.sessionIndex++;
    planCache = null;
    save(); closeModal(); current = null; go('home');
  };
  $('#saveSession').onclick = () => finish(true);
  $('#skipSave').onclick = () => finish(false);
}

/* ---------- scheda esercizio ---------- */
function openSheet(ex, it, onSwap) {
  $('#sheetPanel').innerHTML = `
    <h2>${esc(ex.name)}</h2>
    <div class="small muted">${esc(ex.group)} · ${esc(ex.equipment.join(', ') || 'corpo libero')}</div>
    <div class="frames">
      <div>${figureFor(ex, 0)}<div class="small muted" style="text-align:center">posizione iniziale</div></div>
      <div>${figureFor(ex, 1)}<div class="small muted" style="text-align:center">posizione finale</div></div>
    </div>
    ${it ? `<p class="small muted">Oggi: ${doseText(it)}, recupero ${it.rest}s, RPE ${esc(it.rpe)}. ${esc(it.source)}</p>` : ''}
    <div class="block"><h3>Esecuzione</h3><ol>${ex.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>
    <div class="block"><h3>Muscoli coinvolti</h3>
      <div class="tags">${ex.primary.map(m => `<span>${esc(m)}</span>`).join('')}
      ${ex.secondary.map(m => `<span>${esc(m)} (secondario)</span>`).join('')}</div></div>
    <div class="block warnblock"><h3>Errori e rischi</h3>
      <ul>${ex.errors.map(e => `<li>${esc(e)}</li>`).join('')}${ex.safety.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>
    <div class="block"><h3>Riferimento</h3><p class="small muted">${esc(ex.source)}</p></div>
    ${onSwap ? `<button class="btn ghost" id="sheetSwap" style="margin-top:18px">Sostituisci con un altro esercizio</button>` : ''}
    <button class="btn secondary" id="closeSheet" style="margin-top:10px">Chiudi</button>`;
  $('#sheet').classList.add('on');
  $('#closeSheet').onclick = () => $('#sheet').classList.remove('on');
  if (onSwap && $('#sheetSwap')) $('#sheetSwap').onclick = () => { $('#sheet').classList.remove('on'); onSwap(); };
}
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') $('#sheet').classList.remove('on'); });

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
    const nums = logs.map(l => parseFloat(l.load)).filter(n => isFinite(n));
    return `<li data-ex="${k}">
      <div class="spark">${sparkline(nums)}</div>
      <div class="nm" style="flex:1"><b>${esc(last.name)}</b>
        <div class="small muted">${logs.length} sedute · ultima ${new Date(last.ts).toLocaleDateString('it-IT')}</div></div>
      <div class="val">${esc(last.load || '—')} ${arrow(last.feedback)}</div></li>`;
  }).join('');

  const sess = S.sessionLog.slice(-8).reverse().map(x =>
    `<li><div class="nm" style="flex:1"><b>${esc(x.label)}</b>
      <div class="small muted">${new Date(x.ts).toLocaleDateString('it-IT')} · ${x.minutes} min${x.note ? ' · ' + esc(x.note) : ''}</div></div></li>`).join('');

  $('#view-history').innerHTML = `
    <div class="card"><h2>Carichi per esercizio</h2><ul class="hist">${rows}</ul></div>
    ${sess ? `<div class="card"><h2>Ultime sedute</h2><ul class="hist">${sess}</ul></div>` : ''}`;

  document.querySelectorAll('[data-ex]').forEach(li => li.onclick = () => detailFor(li.dataset.ex, byEx[li.dataset.ex]));
}

function sparkline(vals) {
  if (vals.length < 2) return `<svg viewBox="0 0 86 34"><line x1="2" y1="30" x2="84" y2="30" stroke="#2B3B4E" stroke-width="2"/></svg>`;
  const min = Math.min(...vals), max = Math.max(...vals), r = (max - min) || 1;
  const pts = vals.map((v, i) => `${2 + i * (82 / (vals.length - 1))},${30 - ((v - min) / r) * 24}`).join(' ');
  return `<svg viewBox="0 0 86 34"><polyline points="${pts}" fill="none" stroke="#F5A524" stroke-width="2.4" stroke-linejoin="round"/></svg>`;
}

function detailFor(exId, logs) {
  const ex = exById(exId);
  const rows = logs.slice().reverse().map(l =>
    `<li><div class="nm" style="flex:1"><b>${esc(l.load || '—')}</b>
      <div class="small muted">${new Date(l.ts).toLocaleDateString('it-IT')} · ${l.sets}×${l.reps} · ${l.setup === 'gym' ? 'palestra' : 'casa'}</div></div>
      <div class="val">${arrow(l.feedback)}</div></li>`).join('');
  openModal(`<h2>${esc(ex.name)}</h2>
    <div style="height:110px;margin:10px 0">${bigChart(logs)}</div>
    <ul class="hist">${rows}</ul>
    <button class="btn secondary" id="closeModal" style="margin-top:16px">Chiudi</button>`);
  $('#closeModal').onclick = closeModal;
}
function bigChart(logs) {
  const vals = logs.map(l => parseFloat(l.load)).filter(n => isFinite(n));
  if (vals.length < 2) return `<p class="small muted">Servono almeno due sedute con carico annotato per il grafico.</p>`;
  const min = Math.min(...vals), max = Math.max(...vals), r = (max - min) || 1;
  const pts = vals.map((v, i) => `${6 + i * (288 / (vals.length - 1))},${96 - ((v - min) / r) * 80}`).join(' ');
  return `<svg viewBox="0 0 300 110" style="width:100%;height:100%">
    <line x1="6" y1="100" x2="294" y2="100" stroke="#2B3B4E" stroke-width="1.5"/>
    <polyline points="${pts}" fill="none" stroke="#F5A524" stroke-width="3" stroke-linejoin="round"/>
    <text x="6" y="14" fill="#93A7BC" font-size="11">${max}</text>
    <text x="6" y="96" fill="#93A7BC" font-size="11">${min}</text></svg>`;
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
      <p class="small muted">Periodizzazione: ${esc(p.periodization)}. Sei alla sessione ${meta.dayInWeek} della settimana ${meta.weekInCycle} (mesociclo ${meta.mesocycle}).</p>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn ghost" id="prevSess">Sessione precedente</button>
        <button class="btn ghost" id="nextSess">Sessione successiva</button>
      </div>
    </div>

    <div class="card">
      <h2>Profilo</h2>
      <div class="switch"><span>Attrezzatura predefinita</span>
        <select id="setupSel" style="width:150px;min-height:44px;background:var(--surface2);border:1px solid var(--line);border-radius:10px;padding:0 10px">
          <option value="gym" ${S.setup === 'gym' ? 'selected' : ''}>Palestra</option>
          <option value="home" ${S.setup === 'home' ? 'selected' : ''}>Casa</option></select></div>
      <div class="switch"><span>Priorità agli esercizi che proteggono il ginocchio</span>
        <input type="checkbox" id="kneeChk" ${S.kneeCare ? 'checked' : ''}></div>
      <div class="switch"><span>Campanella del timer</span>
        <input type="checkbox" id="soundChk" ${S.sound !== false ? 'checked' : ''}></div>
      <div class="switch"><span>Convivenza con la musica</span>
        <select id="audioSel" style="width:180px;min-height:44px;background:var(--surface2);border:1px solid var(--line);border-radius:10px;padding:0 10px">
          <option value="mix" ${S.audioMode !== 'solo' ? 'selected' : ''}>Sopra la musica</option>
          <option value="solo" ${S.audioMode === 'solo' ? 'selected' : ''}>Priorità campanella</option>
        </select></div>
      <div class="switch" style="border:0"><span>Schermo sempre acceso</span><span class="small muted" id="wlStatus">—</span></div>
      <button class="btn ghost" id="testSound" style="margin-top:12px">Prova la campanella</button>
      <p class="small muted" style="margin-top:8px"><b>Sopra la musica</b>: la campanella si sovrappone a Spotify o YouTube abbassandoli per un attimo, senza fermarli; richiede però che la modalità silenziosa dell'iPhone sia disattivata. <b>Priorità campanella</b>: si sente anche con il telefono in silenzioso, ma mette in pausa l'audio delle altre app. Se non senti nulla, tocca "Prova la campanella" e alza il volume con i tasti laterali mentre suona.</p>
    </div>

    <div class="card">
      <h2>Dati</h2>
      <div class="btn-row">
        <button class="btn ghost" id="exportBtn">Esporta JSON</button>
        <button class="btn ghost" id="resetBtn">Azzera tutto</button>
      </div>
    </div>

    <div class="card flat">
      <h2>Avvertenza</h2>
      <p class="small muted">Questa app propone programmi generici costruiti sulle linee guida ACSM, NSCA, ACE e OMS per adulti sani. Non sostituisce una valutazione medica. Prima di iniziare, e in particolare per la sensibilità al ginocchio, consulta un medico o un fisioterapista. Interrompi subito in caso di dolore acuto, vertigini o dolore toracico.</p>
    </div>`;

  $('#progSel').onchange = e => { S.programId = e.target.value; save(); renderSettings(); };
  $('#setupSel').onchange = e => { S.setup = e.target.value; save(); };
  $('#kneeChk').onchange = e => { S.kneeCare = e.target.checked; save(); };
  $('#soundChk').onchange = e => { S.sound = e.target.checked; save(); if (e.target.checked) { unlockAudio(); setTimeout(() => ding(false), 350); } };
  $('#audioSel').onchange = e => { S.audioMode = e.target.value; save(); setAudioSession(); };
  $('#testSound').onclick = () => {
    unlockAudio();
    setTimeout(() => ding(false), 250);
    setTimeout(() => ding(false), 1150);
    setTimeout(() => ding(true), 2050);
  };
  $('#prevSess').onclick = () => { S.sessionIndex = Math.max(0, S.sessionIndex - 1); save(); renderSettings(); };
  $('#nextSess').onclick = () => { S.sessionIndex++; save(); renderSettings(); };
  $('#exportBtn').onclick = exportData;
  $('#resetBtn').onclick = () => {
    openModal(`<h2>Azzerare i dati?</h2><p class="small muted">Verranno cancellati storico carichi, sedute e impostazioni. L'operazione non è reversibile.</p>
      <button class="btn" id="yesReset">Sì, azzera</button>
      <button class="btn ghost" id="noReset" style="margin-top:10px">Annulla</button>`);
    $('#yesReset').onclick = () => { localStorage.removeItem(KEY); load(); closeModal(); go('home'); };
    $('#noReset').onclick = closeModal;
  };
  $('#wlStatus').textContent = ('wakeLock' in navigator) ? 'attivo durante le sessioni' : 'non supportato su questo browser';
}

function exportData() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `palestra50-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

/* ---------------------------------------------------------------------------
   7. TIMER, AUDIO, WAKE LOCK
--------------------------------------------------------------------------- */
/* --- AUDIO ------------------------------------------------------------------
   Su iOS il suono generato con Web Audio è spesso inaudibile: il contesto viene
   sospeso appena l'app perde il fuoco e il volume segue il canale "suoneria".
   Per questo la campanella è un file WAV generato al volo e riprodotto con un
   elemento <audio> (canale multimediale, più affidabile), con Web Audio come
   riserva. Gli elementi vengono "sbloccati" al primo tocco dell'utente.
----------------------------------------------------------------------------- */
let bells = { short: [], final: [], ready: false }, bellIdx = 0;

/* Sintetizza una campanella e la restituisce come data URI WAV. */
function wavDataUri(freqs, dur, decay) {
  const sr = 22050, n = Math.floor(sr * dur);
  const bytes = new Uint8Array(44 + n * 2), dv = new DataView(bytes.buffer);
  const wr = (o, t) => { for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    freqs.forEach((f, k) => { v += Math.sin(2 * Math.PI * f * t) / (k + 1.5); });
    v *= Math.exp(-t * decay) * 0.9;
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

function buildAudio() {
  if (bells.short.length) return;
  const s1 = wavDataUri([880, 1760, 2640], 0.5, 8);    // rintocco dei secondi
  const s2 = wavDataUri([1320, 2640, 3300], 1.1, 4);   // colpo finale, più lungo
  for (let i = 0; i < 3; i++) {                        // pool: rintocchi ravvicinati
    const a = new Audio(s1), b = new Audio(s2);
    a.preload = b.preload = 'auto';
    bells.short.push(a); bells.final.push(b);
  }
}

/* Categoria della sessione audio di iOS (Safari 17+):
     'transient' → la campanella si sovrappone alla musica abbassandola un attimo,
                   senza fermare Spotify o YouTube (impostazione predefinita);
     'playback'  → la campanella ha la priorità e ignora l'interruttore silenzioso,
                   ma mette in pausa l'audio delle altre app.
   Se l'API non è disponibile il browser usa il comportamento di sistema. */
function setAudioSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type =
      (S && S.audioMode === 'solo') ? 'playback' : 'transient';
  } catch (e) {}
}

/* Va chiamata dentro un gesto dell'utente (tocco su un pulsante). */
function unlockAudio() {
  buildAudio();
  setAudioSession();
  bells.short.concat(bells.final).forEach(a => {
    a.volume = 0;
    const p = a.play();
    const reset = () => { try { a.pause(); a.currentTime = 0; } catch (e) {} a.volume = 1; bells.ready = true; };
    if (p && p.then) p.then(reset).catch(() => { a.volume = 1; }); else reset();
  });
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}

/* Riserva: sintesi diretta con Web Audio se l'elemento <audio> non parte. */
function webBell(isFinal) {
  if (!audioCtx) return;
  const at = audioCtx.currentTime, base = isFinal ? 1320 : 880;
  [base, base * 2.02].forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.9 / (i + 1), at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + (isFinal ? 1 : 0.55));
    o.connect(g); g.connect(audioCtx.destination);
    o.start(at); o.stop(at + 1.1);
  });
}

/* Un rintocco, con vibrazione di supporto. */
function ding(isFinal) {
  if (S && S.sound === false) return;
  const pool = isFinal ? bells.final : bells.short;
  let played = false;
  if (pool.length) {
    const a = pool[bellIdx++ % pool.length];
    try {
      a.currentTime = 0; a.volume = 1;
      const p = a.play();
      played = true;
      if (p && p.catch) p.catch(() => webBell(isFinal));
    } catch (e) { played = false; }
  }
  if (!played) webBell(isFinal);
  if (navigator.vibrate) navigator.vibrate(isFinal ? [150, 70, 150] : 70);
}

/* --- TIMER ------------------------------------------------------------------
   Un solo timer per tutta l'app, con due modalità:
     'rest' → recupero tra serie o tra esercizi
     'work' → tenuta a tempo (stretching statico, plank, wall sit)
   Può essere ridotto a icona: continua a girare e resta visibile mentre si
   naviga nel resto dell'app.
----------------------------------------------------------------------------- */
let timerEnd = 0, timerStart = 0, timerTotal = 0, timerCb = null, timerMode = 'rest';
let bellTimers = [];
const AUDIO_LATENCY = 40;      // ms di anticipo per compensare la latenza di play()

function clearBellTimers() { bellTimers.forEach(clearTimeout); bellTimers = []; }

/* I rintocchi non vengono più dedotti dal ciclo di aggiornamento (che gira a
   scatti e sbagliava di qualche decimo): ogni campanella ha il suo timeout
   calcolato sull'istante esatto, quindi cade precisa al secondo. */
function scheduleBells() {
  clearBellTimers();
  const marks = [];
  if (timerStart > Date.now()) {                 // fase di preparazione
    for (let k = 3; k >= 1; k--) marks.push([timerStart - k * 1000, false]);
    marks.push([timerStart, true]);              // via!
  }
  for (let k = 3; k >= 1; k--) marks.push([timerEnd - k * 1000, false]);
  marks.push([timerEnd, true]);
  marks.forEach(m => {
    const delay = m[0] - Date.now() - AUDIO_LATENCY;
    if (delay > -200) bellTimers.push(setTimeout(() => ding(m[1]), Math.max(0, delay)));
  });
}

/* lead = secondi di preparazione prima che parta il conteggio vero e proprio. */
function startTimer(seconds, what, cb, mode, lead) {
  stopTimer();
  timerMode = mode || 'rest';
  const wait = (lead || 0) * 1000;
  timerStart = Date.now() + wait;
  timerEnd = timerStart + seconds * 1000;
  timerTotal = seconds; timerCb = cb || null;
  $('#timerWhat').textContent = (wait ? 'Preparati · ' : '') + (what || '');
  $('#miniWhat').textContent = what || '';
  $('#timer').classList.add('on');
  $('#timer').classList.toggle('work', timerMode === 'work');
  $('#miniTimer').classList.toggle('work', timerMode === 'work');
  $('#miniTimer').classList.remove('on');
  unlockAudio();
  scheduleBells();
  if (wait) bellTimers.push(setTimeout(() => { $('#timerWhat').textContent = what || ''; }, wait));
  tick();
  timerHandle = setInterval(tick, 100);
}

function tick() {
  const now = Date.now();
  const prep = timerStart > now;
  const left = prep ? Math.ceil((timerStart - now) / 1000)
                    : Math.max(0, Math.ceil((timerEnd - now) / 1000));
  // in preparazione si mostra solo la cifra che scorre: resta centrata nel cerchio
  const txt = prep ? String(left)
                   : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  $('#timerCount').textContent = txt;
  $('#miniCount').textContent = txt;
  $('#ringFill').setAttribute('stroke-dashoffset',
    String(prep ? 0 : 283 * (1 - left / timerTotal)));
  $('#timer').classList.toggle('prep', prep);
  $('#miniTimer').classList.toggle('prep', prep);
  $('#timer').classList.toggle('warn', !prep && left <= 3 && timerMode === 'rest');
  if (!prep && left <= 0) {
    const cb = timerCb;
    stopTimer();
    if (cb) cb();
  }
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null; timerCb = null;
  clearBellTimers();
  $('#timer').classList.remove('on', 'warn', 'prep');
  $('#miniTimer').classList.remove('on', 'prep');
}
const timerRunning = () => !!timerHandle;
function minimizeTimer() {
  if (!timerHandle) return;
  $('#timer').classList.remove('on');
  $('#miniTimer').classList.add('on');
}
function expandTimer() {
  if (!timerHandle) return;
  $('#miniTimer').classList.remove('on');
  $('#timer').classList.add('on');
}
function skipTimer() { const cb = timerCb; stopTimer(); if (cb) cb(); }

$('#timerSkip').onclick = skipTimer;
$('#miniSkip').onclick = skipTimer;
$('#timerMin').onclick = minimizeTimer;
$('#miniExpand').onclick = expandTimer;
$('#timerPlus').onclick = () => { timerEnd += 15000; timerTotal += 15; scheduleBells(); tick(); };
$('#timerMinus').onclick = () => {
  timerEnd = Math.max(Date.now() + 1000, timerEnd - 15000); scheduleBells(); tick();
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
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (timerHandle) tick();
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

function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.add('on'); }
function closeModal() { $('#modal').classList.remove('on'); }

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

(async function boot() {
  load();
  try { await loadData(); }
  catch (e) {
    document.body.innerHTML = '<p style="padding:24px">Impossibile caricare i dati degli esercizi. Apri l\'app da un server web (o dalla schermata Home dopo l\'installazione), non da file locale.</p>';
    return;
  }
  go('home');
  if (!S.disclaimerOk) disclaimer();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
