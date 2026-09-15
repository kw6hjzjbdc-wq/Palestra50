# Palestra 50

PWA per allenamento in palestra e a casa, costruita su un profilo specifico: uomo di 50 anni, obiettivo tono e ipertrofia, riduzione del grasso addominale, rinforzo degli arti inferiori a protezione del ginocchio, mobilità mantenuta con stretching regolare.

Settimana tipo: 5 sedute, tre di potenziamento (1, 3, 5) e due di mobilità (2, 4), circa 30 minuti l'una, più un blocco core facoltativo.

---

## 1. Architettura e scelte

| File | Ruolo |
|---|---|
| `index.html` | Shell dell'interfaccia: quattro viste, timer a tutto schermo, scheda esercizio, modale |
| `styles.css` | Tema scuro ad alto contrasto, tap target da 58 px, safe area iPhone |
| `app.js` | Stato, motore di periodizzazione, generazione sessioni, timer, storico |
| `exercises.json` | Database esercizi (89 voci): muscoli, attrezzatura, istruzioni, errori, sicurezza, fonte |
| `programs.json` | Programmi, template di seduta e parametri per obiettivo (serie/rip/recuperi) |
| `poses.json` | Libreria di pose stilizzate usata per generare le illustrazioni SVG |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | Installazione e funzionamento offline |

**Perché niente framework.** L'app deve partire in un secondo con il telefono in mano tra una serie e l'altra e funzionare senza rete. HTML, CSS e JavaScript nativi, nessuna build, nessuna dipendenza: il codice che leggi è quello che gira sul telefono.

**Perché i dati sono in JSON separati.** Esercizi, programmi e pose sono file autonomi: puoi aggiungere un esercizio o un programma senza toccare la logica. Il service worker li mette in cache, quindi restano disponibili offline.

**Perché le sessioni sono deterministiche.** Una seduta è una funzione di tre variabili: indice progressivo della sessione, programma attivo, attrezzatura scelta. Nessuna casualità: la stessa combinazione produce sempre la stessa seduta, quindi il programma è verificabile e riproducibile e non cambia se chiudi e riapri l'app.

**Perché le illustrazioni sono generate.** Ogni figura è uno scheletro 2D (`poses.json`) disegnato in SVG dal codice, con l'attrezzo aggiunto sopra (bilanciere, manubri, elastico, cavo, ruota). Nessuna immagine o video di terzi, nessun problema di licenza, peso trascurabile, e per aggiungere un esercizio basta indicare due pose.

### Periodizzazione

`weekProfile(settimana, settimaneCiclo)` traduce la settimana del mesociclo in modificatori:

- settimana 1 → adattamento, carico di riferimento, ripetizioni nella parte alta del range;
- settimane intermedie → il carico suggerito sale del 2-3% a settimana e le ripetizioni scendono verso il basso del range (sovraccarico progressivo, NSCA);
- ultima settimana di ogni ciclo → scarico: una serie in meno e circa −15% di carico, per gestire il recupero (ACSM, adulti over 50);
- la settimana di picco aggiunge una serie sui movimenti principali.

Il ciclo dura 4 settimane nel programma base, ma è un parametro del programma: `ipertrofia6` usa 6 settimane, `ricomp3` ne usa 3. Il **mesociclo** (il numero di cicli completati) è anche l'indice di rotazione degli esercizi: al ciclo successivo ogni slot pesca l'esercizio seguente nel proprio pool, così il programma cambia da solo.

Dentro la settimana la logica è **ondulata** nel programma base: seduta A ipertrofia (8-12 rip), seduta B forza (4-6 rip), seduta C resistenza muscolare (15-20 rip).

### Selezione degli esercizi

Ogni seduta di forza è un elenco di *slot*, ciascuno con uno o più schemi di movimento ammessi (`squat`, `hinge`, `lunge`, `pushH`, `pushV`, `pullH`, `pullV`, `arms`, `calf`, `coreAnti`…). Per ogni slot l'algoritmo:

1. filtra il database per attrezzatura selezionata (palestra o casa) e per schema di movimento;
2. applica i filtri di sicurezza del profilo, schema per schema, così non elimina mai un intero pattern di movimento:
   - **ginocchio** (`kneeFriendly`): esclude gli esercizi ad alto carico femoro-rotuleo;
   - **spalla** (`shoulderRisk`): esclude gli esercizi tipicamente dolorosi in caso di conflitto subacromiale e sofferenza del capo lungo del bicipite — spinte sopra la testa con bilanciere a presa prona (military press), panca inclinata con bilanciere, croci ai cavi in massima apertura, lat machine a presa larga, dip su sedia, estensioni sopra la testa, alzate frontali — sostituendoli con varianti a presa neutra e traiettorie sul piano scapolare: spinta con manubri o macchina a impugnature parallele, panca inclinata con manubri a presa neutra, scaption con i pollici in alto, lat machine con triangolo, trazioni assistite a presa neutra, estensioni dei tricipiti a terra;
3. sceglie in base alla rotazione del mesociclo, evitando doppioni nella stessa seduta; gli esercizi non scelti restano disponibili come alternative dal pulsante *Cambia esercizio*;
4. assegna serie, ripetizioni e recupero in base all'obiettivo dello slot e alla settimana, portando al pari superiore le serie degli esercizi marcati `perSide` (un lato alla volta).

Le sedute di mobilità combinano 2-3 esercizi di mobilità dinamica in apertura e 5-6 allungamenti statici sui gruppi previsti dal template, con rotazione settimanale.

### Vincolo dei 30 minuti

Dopo la generazione, `fitToTime()` stima la durata (lavoro + recuperi, allungamenti contati su entrambi i lati) e, se supera i 32 minuti, riduce prima le serie degli esercizi accessori e solo in ultima istanza toglie l'ultimo esercizio. Il primo esercizio, quello principale, non viene mai toccato. Quando la seduta è stata ridotta, la home lo segnala.

### Blocco trazioni alla sbarra

Obiettivo attivabile da Programma (predefinito: attivo). Aggiunge due esercizi **in apertura** di ciascuna delle tre sedute di forza — quindi tre volte a settimana, sempre a fresco, secondo il principio NSCA di mettere per primo il movimento obiettivo — e il budget tempo delle sedute complete sale da 32 a 35 minuti (tetto 38).

L'onda settimanale non è casuale, segue le evidenze sulla progressione:

| Giorno | Blocco | Dose |
|---|---|---|
| A | attivazione + **eccentriche** (trazioni negative, discesa 4-5 s) | 4× 3-5, recupero 2 min |
| B | attivazione + **isometria** (mento sopra la sbarra) | 4× 8-12 s, recupero 90 s |
| C | attivazione + **volume assistito** (band o macchina) | 3× 5-8, recupero 90 s |

L'attivazione è sospensione alla sbarra o trazioni scapolari: è la fase iniziale del movimento, quella che quasi tutti saltano. A casa, senza sbarra, il blocco si traduce in attivazione scapolare, pulldown con band a eccentrica lenta di 5 secondi e tenuta isometrica con band.

**Perché eccentriche e non solo band.** Uno studio del Journal of Strength and Conditioning Research ha confrontato per otto settimane tre gruppi di principianti — assistenza elastica, macchina a contrappeso e lavoro solo eccentrico: il gruppo con la band ha avuto il minor miglioramento nelle trazioni libere, quello eccentrico il maggiore, pur non eseguendo mai una trazione completa in allenamento. Il motivo è meccanico: la band assiste al massimo in basso, dove sei più debole, e quasi per nulla in alto. Le band restano utili come accumulo di volume, perché l'analisi EMG mostra che l'assistenza elastica riproduce il pattern della trazione libera meglio della macchina, core e stabilizzatori scapolari inclusi: il corpo resta sospeso e deve stabilizzarsi. La lat machine è un complemento, non il lavoro centrale: tre sedute settimanali di trazioni assistite con riduzione progressiva della band hanno prodotto in dieci settimane 4-5 ripetizioni strict in più contro 1-2 di un gruppo che usava solo la lat machine.

**Presa e spalla.** Le trazioni riducono lo spazio subacromiale, e in uno studio biomeccanico la presa prona a larghezza spalle è risultata a minor rischio di conflitto rispetto alle altre varianti; la presa neutra mantiene la spalla in rotazione più esterna ed è di norma la più tollerata. Le schede indicano presa neutra o prona a larghezza spalle e sconsigliano la presa larga, coerentemente con il filtro spalla del profilo.

**Criteri di avanzamento** (per checkpoint, non per calendario):
- riduci la band (viola → rossa → gialla → azzurra) quando completi le ripetizioni previste con due di margine;
- passa alla trazione completa quando tieni 5 secondi con il mento sopra la sbarra e scendi in 5 secondi controllati;
- non portare mai a cedimento il blocco: è lavoro di forza e di tecnica, non di esaurimento.

### Parametri e fonti

Rielaborati (nessun testo riprodotto) da: ACSM *Guidelines for Exercise Testing and Prescription*, NSCA *Essentials of Strength Training and Conditioning*, linee guida ACE per stretching e mobilità, raccomandazioni OMS sull'attività fisica per adulti 45-64 anni (150 minuti settimanali di attività moderata più due sedute di rinforzo: le cinque sedute qui previste rientrano in quel volume).

| Obiettivo | Serie | Ripetizioni | Recupero |
|---|---|---|---|
| Ipertrofia | 3-4 | 8-12 | 75 s |
| Forza | 3-4 | 4-6 | 120 s |
| Resistenza muscolare | 2-4 | 15-20 | 40 s |
| Core | 2-4 | 12-15 (o 30-35 s) | 40 s |
| Stretching statico | 2-4 (pari) | 30 s per lato | 15 s |
| Mobilità dinamica | 2 | 8-10 | 15 s |

I valori in tabella sono i punti di partenza: l'app li ricalcola a ogni seduta in base alla settimana del ciclo.

### Valutazione automatica dei progressi

A ogni esercizio concluso l'app confronta quanto hai registrato con quanto il modello si aspettava — dentro il mesociclo circa +2,5% di carico a settimana — e assegna da 1 a 5 stelle:

| Stelle | Significato |
|---|---|
| ★ | calo superiore al 3% rispetto alla volta scorsa |
| ★★ | stabile, sotto la progressione prevista |
| ★★★ | in linea con la previsione dell'algoritmo |
| ★★★★ | sopra le attese, entro il 5% |
| ★★★★★ | progresso netto, fino al 10%: la fascia massima consigliata |

Per gli esercizi con elastico la scala è a gradini: passare alla band successiva vale cinque stelle, saltarne due in una volta viene segnalato. Allungamenti e mobilità non ricevono punteggio, perché non hanno un carico confrontabile.

**Segnalazione degli incrementi troppo rapidi.** La fascia di riferimento è il 2-10% per singolo incremento (raccomandazione ACSM: aumentare il carico del 2-10% quando si completano una o due ripetizioni oltre l'obiettivo). Oltre il 10% l'app avvisa già mentre digiti il carico, e la registrazione resta marcata nel riepilogo settimanale. Vengono segnalati anche gli aumenti in settimana di scarico, che ne annullano la funzione, e la presenza di tre o più esercizi marcati come più difficili del previsto nella stessa settimana, indizio di recupero insufficiente.

### Animazioni

Tutti i pop up hanno un'animazione di apertura (velo in dissolvenza, riquadro che sale e si ingrandisce) e una di chiusura speculare; le schede esercizio scorrono dal basso e rientrano verso il basso. Il timer si riduce e si riapre con la stessa logica di scala. Tutto rispetta l'impostazione di sistema per il movimento ridotto.

### Riepilogo settimanale

Completate le cinque sedute, l'app apre un riepilogo con le sedute svolte, la media delle stelle, i tre migliori traguardi della settimana e l'elenco di ciò a cui fare attenzione. Resta richiamabile in qualsiasi momento dalla scheda **Progressi → Riepilogo settimanale**, per le ultime quattro settimane con dati.

### Gestione dei carichi

A fine esercizio si registrano carico e feedback (↑ più facile del previsto, – invariato, ↓ più difficile). Alla seduta successiva l'app mostra "Ultima volta: 12 kg ↑" e propone il carico aggiornato: +5% dopo un ↑, −7% dopo un ↓, invariato dopo un –, arrotondato a 0,5 kg sotto i 10 kg e a 1 kg sopra. Per gli esercizi con elastico la stessa logica cambia colore della band (azzurra → gialla → rossa → viola). Tutto è in `localStorage`, con esportazione JSON dalla scheda Programma.

---

## 2. Avvio dell'app dall'iPhone (senza computer)

L'app ha bisogno di un indirizzo `https://`: il service worker, l'installazione a Home e il funzionamento offline non partono aprendo `index.html` dai File. Tutta la procedura si fa dall'iPhone, con Safari, in una decina di minuti. Si fa una volta sola.

### Passo 1 — Scarica e scompatta i file
1. Apri questa conversazione sull'iPhone e scarica `palestra50.zip`: finisce in **File → Download**.
2. Apri l'app **File**, tocca `palestra50.zip`: iOS crea accanto la cartella `palestra50` con gli 11 file.
3. Aprila e verifica di vedere `index.html`, `app.js`, `styles.css`, i tre `.json`, `sw.js`, `manifest.webmanifest` e le icone.

I file devono restare tutti allo stesso livello: la struttura è piatta apposta, così su iPhone non serve caricare cartelle.

### Passo 2 — Pubblica su GitHub Pages
1. In Safari vai su `github.com` e accedi (o crea un account gratuito).
2. Tocca il menu ☰ → **New repository**. Nome: `palestra50`. Lascia **Public** e crea.
3. Vai alla pagina di caricamento. Il modo più affidabile su iPhone è scriverla direttamente nella barra degli indirizzi di Safari:
   `github.com/TUONOME/palestra50/upload/main` (sostituisci `TUONOME` con il tuo nome utente).
   In alternativa: sulla pagina del repository appena creato cerca la frase *"Get started by creating a new file or **uploading an existing file**"* e tocca quel collegamento; oppure tocca `ᴀA` nella barra degli indirizzi → **Richiedi sito desktop**, così compare il pulsante **Add file → Upload files** accanto al pulsante verde *Code*.
   Sul layout per telefono il pulsante *Add file* spesso non è visibile: è normale, usa l'indirizzo diretto.
4. Tocca **choose your files**: si apre il selettore. Vai in **Sfoglia → Download → palestra50**, tocca **Seleziona** in alto a destra, seleziona tutti gli 11 file (non la cartella) e conferma con **Apri**.
5. Scorri in fondo e tocca **Commit changes**.

> L'app GitHub per iOS non permette di caricare file: questi passaggi vanno fatti in Safari.
6. Tocca **Settings**. Se il menu non compare, tocca `ᴀA` nella barra degli indirizzi → **Richiedi sito desktop**, poi ripeti.
7. Nella colonna di sinistra tocca **Pages** → in *Branch* scegli `main`, cartella `/ (root)` → **Save**.
8. Aspetta uno o due minuti e ricarica: in cima compare l'indirizzo `https://tuonome.github.io/palestra50/`.

### Passo 3 — Installa a Home
1. Apri quell'indirizzo **con Safari** (Chrome su iOS non installa le PWA).
2. Tocca **Condividi** (il quadrato con la freccia) → **Aggiungi a Home**  → **Aggiungi**.
3. Avvia l'app dall'icona: parte a schermo intero, senza barre del browser.
4. Al primo avvio compare l'avvertenza medica. Da quel momento l'app funziona anche senza rete: in palestra puoi stare offline.

### Alternativa più rapida ma temporanea
Su `app.netlify.com/drop`, dopo aver fatto l'accesso, puoi caricare direttamente il file **`palestra50.zip`** dal selettore file: Netlify lo scompatta e ti dà subito un indirizzo `https://...netlify.app`. È comodo per provare l'app in due minuti, ma senza account collegato quei siti sono provvisori: per l'uso quotidiano resta meglio GitHub Pages.

### Sostituire l'icona sulla schermata Home

iOS fotografa l'icona al momento dell'installazione e non la aggiorna da sola: dopo aver cambiato le icone nel repository bisogna reinstallare la scorciatoia, e reinstallare significa **perdere i dati salvati** (vedi il riquadro sopra). Prima di procedere:

0. Apri l'app, vai in **Programma → Dati** e tocca **Esporta JSON**: salva il file da qualche parte che ricordi (finisce in File → Download).
1. Carica le tre icone aggiornate (`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`) insieme agli altri file.
2. Sulla schermata Home tieni premuta l'icona vecchia → **Rimuovi app** → **Rimuovi dalla schermata Home** (i tuoi dati non si perdono: restano nell'archivio del sito).
3. Apri l'indirizzo dell'app con Safari, tocca **Condividi** → **Aggiungi a Home** → **Aggiungi**.
4. Se ricompare l'icona vecchia, in Safari apri Impostazioni → Safari → Cancella dati siti web e cronologia oppure ricarica la pagina due volte, poi ripeti il punto 3.

### Aggiornare l'app in seguito
Carica i file modificati nello stesso repository (**Add file → Upload files** sovrascrive quelli con lo stesso nome) e cambia il numero di versione in `sw.js` (`palestra50-v1` → `palestra50-v2`), altrimenti l'iPhone continua a usare la copia in cache. Poi apri l'app, chiudila dal multitasking e riaprila.

### Se qualcosa non va
- **Schermata bianca o messaggio sui dati non caricati**: manca qualche file nel repository, oppure i file sono finiti dentro una sottocartella. Devono stare nella radice, accanto a `index.html`.
- **"Aggiungi a Home" non compare**: stai usando Chrome o Firefox. Riapri l'indirizzo in Safari.
- **L'icona non si vede**: le due `icon-*.png` non sono state caricate.
- **L'app non si aggiorna**: hai dimenticato di cambiare il nome della cache in `sw.js`.

I tuoi dati (carichi, storico, settimana del ciclo) restano sul telefono, non sul sito: pubblicare il repository come *public* non espone nulla di personale.

---

## 3. Uso quotidiano

All'apertura scorre un'intro di tre secondi: l'anello del marchio si disegna, le tre barre della progressione salgono una dopo l'altra, compaiono nome, sottotitolo e una **frase motivazionale** in italiano, inglese o francese. Le frasi sono 123, originali e non attribuite, e l'app tiene in memoria le ultime cento mostrate: una frase non può quindi ripetersi prima di altre cento aperture. Si aggiungono o si modificano in `quotes.json`. Finita l'animazione l'intro resta ferma sull'ultimo fotogramma e sparisce **solo quando tocchi lo schermo** (in basso compare il suggerimento "Tocca per iniziare"). Rispetta l'impostazione di sistema per il movimento ridotto.

- **Oggi**: scegli palestra o casa, poi il **calendario della settimana** mostra tutte e cinque le sedute previste più il blocco core facoltativo. Quella da fare secondo il programma è evidenziata con l'etichetta *da programma*, le già svolte restano barrate e non riapribili. Tocca la seduta che vuoi fare adesso — anche il blocco core — e sotto compare il suo elenco esercizi; poi premi *Inizia la sessione*. Scegliendo una seduta diversa da quella prevista, quella di oggi prende il suo posto più avanti nella settimana, quindi non si perde nulla.
- Nell'elenco della seduta, **tocca un esercizio** per aprirne subito la scheda illustrativa, senza dover iniziare l'allenamento.
- Durante l'esercizio: segna le serie completate, scrivi il carico, dai il feedback con le tre frecce, premi **Ho finito la serie**: parte il timer di recupero, con un rintocco su ciascuno degli ultimi 3 secondi e colpo finale più acuto.
- **Esercizi a tempo** (stretching statico, plank, wall sit): il pulsante diventa *Avvia 30 secondi* e fa partire il cronometro della tenuta, in verde. Prima del conteggio ci sono **3 secondi di preparazione**, scanditi da un rintocco ciascuno, mostrati come sola cifra al centro del cerchio; al termine parte da solo il recupero.
- **Esercizi da fare un lato alla volta** (split squat, rematore a un braccio, plank laterale, quasi tutti gli allungamenti) hanno sempre un **numero pari di serie**, così destra e sinistra ricevono lo stesso lavoro: il contatore mostra `1 Sx`, `1 Dx`, `2 Sx`… e il pulsante di avvio indica il lato da fare.
- **Cambia esercizio**: nella sessione, il pulsante *Cambia esercizio* propone un'alternativa dello stesso schema di movimento (o dello stesso gruppo, per lo stretching), coerente con attrezzatura, obiettivo della seduta e filtro ginocchio; premendolo più volte scorri tutte le alternative. La stessa cosa si può fare prima di iniziare, dalla scheda che si apre toccando un esercizio nell'elenco di Oggi.
- **Esercizio precedente**: il pulsante *‹ Precedente* torna indietro nella scaletta per correggere un carico o completare una serie saltata. Lo storico non si sdoppia: il record dell'esercizio viene aggiornato, non duplicato.
- **Ordine degli esercizi**: se una macchina o un attrezzo è occupato, usa *Rimanda a dopo* (sposta l'esercizio corrente in fondo) oppure *Ordine esercizi*, che apre la scaletta di quello che resta da fare con le frecce su/giù. Serie già completate, carico e feedback seguono l'esercizio spostato.
- **Timer riducibile**: durante il recupero tocca *Riduci*. Il pannello rimpicciolisce verso il basso con un'animazione e il conto alla rovescia resta in una barretta, mentre puoi consultare schede e storico. Tocca la barretta e il pannello si riapre ingrandendosi; *Salta* riprende subito.
- Chiusura e interruzione della sessione chiedono sempre conferma, così non si esce per errore. Se esci dalla vista della sessione, in Oggi compare il banner **Riprendi**.
- **Scheda esercizio**: esecuzione passo-passo, muscoli primari e secondari, errori comuni, avvertenze di sicurezza e le due figure inizio/fine.
- A fine seduta puoi annotare una nota libera (sensazioni, ginocchio, carichi). Salvando, un **pop up di complimenti** celebra la seduta conclusa: cerchio che si disegna, spunta, scintille, minuti, esercizi e media delle stelle, con una riga di commento che cambia in base a com'è andata. Se era la quinta seduta della settimana, alla chiusura lascia il posto al riepilogo settimanale.
- **Progressi**: andamento del carico per esercizio e riepilogo delle ultime dieci sedute. Toccando una seduta si apre il suo **riepilogo completo**: data e ora, durata, nota, e l'elenco degli esercizi svolti con serie, ripetizioni, carico e feedback.
- **Programma**: cambio di programma (3, 4 o 6 settimane), attrezzatura predefinita, priorità ginocchio, esclusione degli esercizi critici per la spalla, obiettivo trazioni, spostamento avanti/indietro nella settimana, esportazione e azzeramento dati.

---

## 4. Limiti tecnici noti e alternative

**Schermo sempre acceso.** L'app usa la Screen Wake Lock API, supportata da Safari iOS dalla 16.4. Il blocco viene richiesto all'avvio della sessione e riacquisito ogni volta che l'app torna in primo piano, e rilasciato a fine seduta per non consumare batteria. Se il sistema lo nega (batteria molto bassa, versione iOS precedente), la scheda Programma mostra "non supportato": in quel caso alza manualmente il blocco automatico in Impostazioni → Schermo e luminosità → Blocco automatico → Mai, e riportalo a 30 secondi dopo l'allenamento.

**Campanella: come funziona e perché a volte non si sente.** La campanella è un breve file WAV sintetizzato dall'app all'avvio e riprodotto da un elemento `<audio>`, cioè sul canale multimediale, che su iOS è molto più affidabile del suono generato con Web Audio (rimasto solo come riserva). Gli elementi audio vengono sbloccati al primo tocco su un pulsante, come richiede Safari. Se non senti nulla, controlla nell'ordine:

1. **Modalità silenziosa attiva** — è la causa più frequente: l'interruttore laterale o la mezzaluna nel Centro di Controllo silenzia anche il suono delle pagine web.
2. **Volume multimediale basso** — va alzato con i tasti laterali *mentre l'app riproduce un suono*: usa il pulsante **Prova la campanella** nella scheda Programma e regola il volume in quel momento.
3. **Interruttore "Campanella del timer"** in Programma, che deve essere attivo.
4. Se hai aggiornato i file, ricorda di cambiare la versione della cache in `sw.js`, altrimenti gira ancora la versione vecchia.

**Timbro della campanella.** Ogni rintocco è una sola campana: un unico timbro sintetizzato, con attacco morbido e coda che si spegne in mezzo secondo. Cambia solo l'altezza fra i tre rintocchi dei secondi (La5) e il colpo finale (Mi6), e prima di ogni rintocco l'app zittisce quello precedente, così non si sovrappongono mai due suoni.

**Campanella e musica (Spotify, YouTube).** In Programma c'è l'opzione *Convivenza con la musica*:

- **Sopra la musica** (predefinita): l'app dichiara a iOS una sessione audio di tipo `transient`, quindi la campanella si sovrappone alla musica abbassandola per un istante, senza fermare Spotify o YouTube. In questa modalità però l'interruttore del silenzioso deve essere disattivato.
- **Priorità campanella**: sessione di tipo `playback`, che si sente anche con il telefono in silenzioso ma mette in pausa l'audio delle altre app.

L'API `navigator.audioSession` esiste da Safari 17: su versioni precedenti vale il comportamento predefinito del sistema, cioè la campanella può abbassare o interrompere brevemente la musica.

**Precisione dei rintocchi.** Ogni campanella ha il proprio timeout calcolato sull'istante esatto di fine (con 40 ms di anticipo per compensare la latenza di riproduzione), invece di essere dedotta dal ciclo di aggiornamento dello schermo: i tre secondi finali cadono quindi puntuali. L'aggiornamento del display gira comunque a 100 ms.

**Campanella con app ridotta o in secondo piano.** Durante un timer attivo l'app fa tre cose: dichiara la sessione audio come `playback`, che dà alla campanella la precedenza su qualunque altro suono e la fa sentire anche con l'iPhone in silenzioso; tiene in riproduzione una traccia silenziosa in loop, che impedisce a iOS di sospendere la sessione audio quando l'app passa in secondo piano; e programma i rintocchi sulla timeline di Web Audio, che continua a scorrere anche se i timer JavaScript vengono rallentati. Al rientro in primo piano il contesto audio viene ripreso e le campanelle riprogrammate. Resta un limite di sistema che nessuna PWA può aggirare: se iOS decide comunque di sospendere la scheda (batteria molto bassa, memoria sotto pressione, schermo bloccato a lungo), il suono può non arrivare. Per questo il wake lock tiene lo schermo acceso durante la sessione e a fine timer parte anche la vibrazione.

**Notifiche.** Su iOS le notifiche push da PWA richiedono l'installazione a Home e permessi espliciti; non sono usate qui per non introdurre dipendenze da un server.

**Frequenza cardiaca e Garmin Forerunner 55: funzione rimossa.** Una PWA in Safari è isolata nel browser e non può in alcun modo collegarsi all'app Garmin Connect installata sull'iPhone: iOS non permette a una pagina web di leggere i dati di un'altra app, Safari non espone Web Bluetooth (quindi niente lettura diretta dell'orologio) e HealthKit è accessibile solo alle app native, perciò nemmeno il passaggio Garmin Connect → Salute apre una strada. Restano solo percorsi che non sono un "collegamento" e richiedono un backend o passaggi manuali:

- **Garmin Health API / Connect Developer Program**: dati automatici, ma serve un server proprio, la registrazione come sviluppatore e l'approvazione di Garmin.
- **Import di un file esportato**: da Garmin Connect si esporta l'attività in `.tcx` (XML con la frequenza cardiaca campionata) e la si carica nell'app, che ne ricava media e massimo. Funziona senza server, ma è un'operazione manuale da fare dopo ogni seduta.
- **Scorciatoia iOS**: un'automazione dell'app Comandi può leggere la FC da Salute e copiarla negli appunti, da incollare a mano.

Poiché nessuna di queste opzioni è il collegamento automatico richiesto, l'inserimento manuale dei battiti è stato tolto: la scheda di fine sessione registra ora durata e una nota libera. L'intensità reale si legge direttamente sull'orologio o nell'app Garmin Connect, dove la seduta è già registrata. Se in futuro vuoi l'import del `.tcx`, il punto di innesto è `endSession()` in `app.js` e il campo da aggiungere ai record di `sessionLog`.

**Persistenza dei dati — leggi con attenzione.** Tutti i dati (carichi, storico, settimana del ciclo) vivono solo su questo iPhone, in `localStorage`: non c'è alcun salvataggio su server. Su iOS questo tipo di memoria può sparire in tre casi:

1. **Rimuovi l'icona dalla schermata Home** ("Rimuovi app"): iOS cancella insieme all'icona anche i dati che l'app aveva salvato. È la causa più comune di perdita dati, ed è quello che succede tipicamente quando si reinstalla l'app per aggiornare l'icona.
2. **Il sito non viene aperto per una settimana** (limite ITP di Safari): capita raramente se usi l'app regolarmente, ma è un rischio reale nei periodi di pausa.
3. **Cancelli manualmente i dati dei siti** da Impostazioni → Safari → Cancella dati siti web.

Per questo la scheda **Programma → Dati** mostra da quanto non fai un backup e propone **Esporta JSON**; se sono passati più di 7 giorni dall'ultimo salvataggio, anche la schermata Oggi lo ricorda con un avviso. Il pulsante **Importa backup** carica di nuovo un file esportato in precedenza, per i casi in cui i dati sul telefono vadano persi. Regola pratica: esporta un backup **prima** di rimuovere l'app dalla Home per qualsiasi motivo (aggiornare l'icona compreso) — è l'unico modo per non perdere lo storico in quel passaggio. Per volumi di dati maggiori il passo successivo naturale è IndexedDB, con la stessa struttura di record già usata nei log.

**Suggerimento di carico.** Si basa solo su ciò che annoti: alla prima seduta non c'è proposta ed è giusto partire prudenti. L'app non calcola l'1RM e non lo stima da carichi submassimali: per la fascia d'età e l'obiettivo, la regolazione per sensazione con RPE è più sicura di un test massimale.

**Aggiornamenti.** Dopo aver modificato i file, cambia il valore di `CACHE` in `sw.js` (es. `palestra50-v2`), altrimenti il telefono continua a servire la versione in cache.

---

## 5. Estendere il database

Aggiungi un oggetto in `exercises.json`:

```json
{
  "id": "g_nuovo",
  "name": "Nome esercizio",
  "setup": ["gym"],
  "type": "strength",
  "group": "Petto",
  "pattern": "pushH",
  "load": "weight",
  "kneeFriendly": true,
  "primary": ["Gran pettorale"],
  "secondary": ["Tricipiti"],
  "equipment": ["Manubri"],
  "art": { "frames": ["benchStart", "benchEnd"], "implement": "dumbbells" },
  "steps": ["…", "…", "…"],
  "errors": ["…", "…"],
  "safety": ["…"],
  "source": "NSCA – ipertrofia"
}
```

`type`: `strength`, `core`, `stretch`. `load`: `weight`, `band`, `bodyweight`, `time`. `frames`: due nomi presenti in `poses.json`. `implement`: `barbell`, `barbellBack`, `dumbbells`, `dumbbell1`, `goblet`, `machine`, `cable`, `wheel`, `bandVertical`, `bandTop`, `bandFront`, `bandBack`, `bandFeet`, `bandFoot`, `bandKnees`, `bandAnkle`, `bandShoulder`, `bandSide`, oppure `null`.

Per un nuovo programma aggiungi una voce in `programs.json` con `cycleWeeks`, tre `strengthDays` e due `stretchDays`: la logica di periodizzazione e di rotazione si adatta da sola.

---

## Avvertenza

I programmi generati sono costruiti su linee guida generali per adulti sani e non sostituiscono una valutazione medica. Prima di iniziare, e in particolare per la sensibilità al ginocchio, consulta un medico o un fisioterapista. Interrompi in caso di dolore articolare acuto, dolore toracico, mancanza di respiro insolita o vertigini.
