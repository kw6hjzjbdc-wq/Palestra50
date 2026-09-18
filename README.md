# Palestra 50

PWA per allenamento in palestra e a casa, costruita su un profilo specifico: uomo di 50 anni, obiettivo tono e ipertrofia, riduzione del grasso addominale, rinforzo degli arti inferiori a protezione del ginocchio, mobilità mantenuta con stretching regolare.

Settimana tipo: 5 sedute, tre di potenziamento (1, 3, 5) e due di mobilità (2, 4), circa 30 minuti l'una, più un blocco core facoltativo.

---

## 1. Architettura e scelte

| File | Ruolo |
|---|---|
| `index.html` | Shell dell'interfaccia: cinque viste, timer a tutto schermo, scheda esercizio, barra comandi, modale |
| `styles.css` | Tema scuro ad alto contrasto, tap target da 58 px, safe area iPhone |
| `app.js` | Stato, motore di periodizzazione, generazione sessioni, progressione dei carichi, timer, storico |
| `exercises.json` | Database esercizi (109 voci): muscoli, attrezzatura, istruzioni, errori, sicurezza, progressioni, fonte |
| `programs.json` | Programmi, template di seduta e parametri per obiettivo (serie/rip/recuperi) |
| `poses.json` | Libreria di pose stilizzate usata per generare le illustrazioni SVG |
| `quotes.json` | Frasi motivazionali dell'intro (123, in tre lingue) |
| `sw.js`, `manifest.webmanifest`, `icon-*.png`, `splash-*.png` | Installazione, schermate di avvio e funzionamento offline |

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

### Macrociclo fino al 30 maggio 2027

È il programma predefinito: 37 settimane, sempre 3 sedute di pesi e 2 di mobilità, con l'obiettivo che cambia fase dopo fase. La logica è quella della periodizzazione a blocchi: non si insegue un solo obiettivo per nove mesi, si alternano fasi di volume e fasi di forza, perché più forza significa poter usare carichi più alti nella fase di volume successiva, e quindi più stimolo per la crescita.

| Fase | Settimane | Obiettivi (giorni A · B · C) | A cosa serve |
|---|---|---|---|
| Adattamento | 4 | resistenza · ipertrofia · resistenza | preparare tendini, articolazioni e tecnica |
| Ipertrofia 1 | 8 | ipertrofia · forza · ipertrofia | accumulo di volume, dove si costruisce la massa |
| Forza | 6 | forza · ipertrofia · forza | alzare il tetto di carico |
| Ipertrofia 2 | 8 | ipertrofia · ipertrofia · resistenza | volume con i carichi più alti guadagnati prima |
| Forza-ipertrofia | 5 | forza · ipertrofia · ipertrofia | mantenere la forza senza fermare la crescita |
| Densità e tono | 5 | ipertrofia · resistenza · resistenza | recuperi brevi e più core: il muscolo diventa visibile |
| Rifinitura | 1 | volume ridotto | arrivare scarichi al 30 maggio |

Dentro ogni fase si lavora a blocchi di quattro settimane, con la quarta di scarico (volume ridotto e circa −15% di carico), e la rotazione degli esercizi cambia a ogni blocco. La home mostra fase in corso, settimana nella fase, settimana assoluta e quante ne mancano alla data obiettivo.

**Corsa e aerobica** non compaiono da nessuna parte nell'app: restano nel fine settimana, gestite in autonomia.

**Cambiando programma non si perde nulla**: storico dei carichi, valutazioni a stelle, riepiloghi e backup sono indipendenti dal programma attivo, e gli altri programmi (3, 4 e 6 settimane) restano disponibili in Programma.

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

Le tre azioni della scheda **Dati** (esportazione, importazione, azzeramento) passano da una conferma rossa che indica quanti esercizi e quante sedute sono coinvolti: nessuna parte per un tocco involontario.

### Animazioni

Il passaggio da una schermata all'altra avviene con una breve dissolvenza in salita, titolo compreso. Tutti i pop up hanno un'animazione di apertura (velo in dissolvenza, riquadro che sale e si ingrandisce) e una di chiusura speculare; le schede esercizio scorrono dal basso e rientrano verso il basso. Il timer si riduce e si riapre con la stessa logica di scala. Tutto rispetta l'impostazione di sistema per il movimento ridotto.

### Riepilogo settimanale

Completate le cinque sedute, l'app apre un riepilogo con le sedute svolte, la media delle stelle, i tre migliori traguardi della settimana e l'elenco di ciò a cui fare attenzione. Resta richiamabile in qualsiasi momento dalla scheda **Progressi → Riepilogo settimanale**, per le ultime quattro settimane con dati.

### Che cosa registra l'app, e come decide il carico

A ogni esercizio si annotano quattro cose, tutte con un tocco: il **carico**, le **ripetizioni davvero eseguite** nell'ultima serie (precompilate con l'obiettivo, si correggono con − e +), le **ripetizioni in riserva** (quante ne avresti fatte ancora: 0, 1, 2, 3+) e il feedback a frecce. Le ripetizioni reali sono la base di tutto il resto: senza di esse il carico suggerito, il punteggio a stelle e i grafici lavorerebbero su un numero mai inserito.

Il carico della volta dopo segue la **regola 2-for-2**: sale solo se nelle ultime *due* sedute dello stesso esercizio hai completato almeno *due* ripetizioni oltre l'obiettivo. L'incremento è di un passo reale — 0,5 kg sotto i 10 kg, 1 kg sui piccoli gruppi, 2,5 kg sui grandi — arrotondato per eccesso e comunque entro il 10%. Chiudere una serie a zero ripetizioni di riserva blocca l'aumento senza far scendere il carico; solo un "troppo difficile" esplicito lo riduce del 7% circa.

Per elastici ed esercizi a corpo libero la scala è a gradini: le quattro band (azzurra → gialla → rossa → viola) e, per 17 esercizi a corpo libero, una **progressione dichiarata** — per i piegamenti: mani su rialzo alto → mani su panca → ginocchia a terra → completi → tempo lento → presa stretta. Si sale di un gradino con la stessa regola dei pesi, quindi anche il lavoro senza carico diventa misurabile.

### Esercizi in cui il numero è un aiuto, non un carico

Su trazioni alla macchina assistita, trazioni assistite e trazioni con band, quello che annoti non è un peso sollevato ma l'**aiuto** che ricevi: più è alto, più l'esercizio è facile. Questi esercizi sono marcati `assist` nel database e tutta la logica dei carichi ne tiene conto, invertendo il verso:

- la regola 2-for-2 **riduce** l'assistenza invece di aumentare il carico, di un pacco pesi alla volta (5 kg);
- un "troppo difficile" la **aumenta**;
- con la band, progredire significa passare alla band più **leggera**, perché quella più dura solleva più peso corporeo;
- nel punteggio a stelle scendere da 40 a 35 kg di aiuto vale cinque stelle, salire a 45 ne vale una;
- il massimale stimato non viene calcolato, perché non avrebbe significato;
- l'avviso sugli incrementi bruschi diventa un avviso sulle riduzioni troppo rapide dell'aiuto;
- arrivati a zero, l'app lo dice: "sei pronto a provare senza assistenza".

Nella schermata della seduta e nella scheda, il campo è etichettato come assistenza con una nota che lo spiega.

### Carichi realmente disponibili in palestra

Suggerire "22,7 kg" è inutile se quel peso non si può comporre. Ogni esercizio con carico è associato al suo attrezzo e il suggerimento cade sempre su un valore che esiste davvero; nella seduta il campo è un menu dei carichi possibili, non un numero libero.

| Attrezzo | Scala |
|---|---|
| Bilanciere | Barra da 10 kg con dischi da 2, 5, 10 e 20 kg a coppie: 10, 14, 18, 20, 22, 24… I totali da 12 e 16 kg non sono componibili, perché richiederebbero 1 e 3 kg per lato |
| Manubri | Rastrelliera da 2 a 40 kg (senza il 38). Il numero annotato è il peso del **singolo** manubrio, anche quando se ne usano due |
| Macchine, cavi, lat machine | Pacco pesi da 10 a 120 kg, a scalini di 2,5 kg |
| Casa | Manubri da 1 e 2 kg, anche in coppia: 1, 2, 3, 4 kg |

Quando la regola 2-for-2 chiede un aumento, l'app cerca il primo scalino utile nella direzione giusta: dal bilanciere a 20 kg propone 22, dai manubri a 8 kg propone 10, dalla macchina a 50 kg propone 52,5. Al carico massimo dell'attrezzo lo dice e suggerisce di aumentare le ripetizioni o cambiare variante.

**Nota sul passo minimo.** L'allarme "incremento oltre il 10%" scatta solo se la variazione supera *anche* il passo minimo realmente disponibile su quell'attrezzo (5 kg sul pacco pesi, 2,5 kg con i dischi, 1 kg con i manubri, 0,5 kg sui carichi leggeri). Senza questa condizione l'app segnalava come imprudente proprio l'incremento più piccolo possibile — per esempio da 20 a 22,5 kg, che è +12,5% ma anche l'unico passo che i dischi consentono, e che l'app stessa suggeriva.

### Massimale stimato

Il confronto fra sedute usa il massimale stimato con la formula di Epley — carico × (1 + ripetizioni/30), applicata fino a 15 ripetizioni dove resta attendibile. È ciò che permette di dire che 60 kg × 11 (82 kg stimati) è un progresso rispetto a 60 kg × 6 (72 kg stimati), cosa che guardando il solo peso non si vedrebbe. Nel grafico del dettaglio la linea piena è il massimale stimato, quella tratteggiata il carico usato. Il controllo sugli incrementi troppo bruschi resta invece ancorato al peso reale: aumentare le ripetizioni non è un rischio, aumentare il peso sì.

### Volume settimanale

La scheda Progressi mostra le serie completate per gruppo muscolare nella settimana in corso, con una tacca a 10 serie e la barra rossa sotto le 5. Le soglie vengono dalla meta-analisi dose-risposta: meno di 5 serie settimanali per gruppo danno +5,4%, da 5 a 9 +6,6%, 10 o più +9,8%. Lo stesso riquadro compare nel riepilogo di fine settimana, che segnala esplicitamente i gruppi rimasti sotto le 5 serie.

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

### Settimane di sola mobilità

Quando non puoi andare in sala pesi per una settimana — viaggio, impegni, un fastidio da lasciar passare — la scheda **Programma → Settimane di sola mobilità** permette di dichiararlo per la settimana in corso o per la prossima. Tutte e cinque le sedute diventano di mobilità e stretching, con schemi e rotazioni diversi fra loro per non ripetere gli stessi allungamenti.

Il punto che conta: **il programma di forza non perde nulla, slitta**. Nel conteggio delle settimane di fase quelle di sola mobilità non vengono contate, quindi se ti fermi alla settimana 2 di una fase, alla ripresa riparti dalla settimana 2, non dalla 3. Il macrociclo si allunga di una settimana invece di saltarne un pezzo.

### Se la posizione nel programma non corrisponde

Può capitare che l'indice della prossima seduta si disallinei da ciò che hai davvero svolto, tipicamente dopo un "Salta a domani" o qualche prova. La scheda **Programma → Dove sei nel programma** mostra la posizione corrente e offre due modi per correggerla:

- **Imposta questa posizione**: scegli settimana e sessione dai due menu e confermi. L'app dice quale seduta diventerà la prossima prima di applicare.
- **Ricalcola dalle sedute registrate**: conta le sedute di programma presenti nello storico e allinea l'indice a quel numero. I blocchi core e le sedute libere non contano, perché non fanno avanzare il programma.

In entrambi i casi lo storico dei carichi, le valutazioni e i backup restano invariati: cambia solo il segnaposto.

### Seduta interrotta

Se l'app viene chiusa da iOS a metà allenamento — cosa normale mentre ascolti musica e usi altre app in palestra — al riavvio la schermata Oggi propone *Riprendi*, con esercizio corrente, serie completate, carichi, ripetizioni e RIR già inseriti. La proposta resta valida per sei ore, poi la seduta è considerata chiusa. Si può anche scartare esplicitamente: gli esercizi già conclusi restano comunque nello storico.

### Accessibilità

Lo zoom non è più bloccato (era una violazione del criterio WCAG 1.4.4). Il contatore del timer è annunciato dalla sintesi vocale, utile anche a chi tiene il telefono in tasca con gli auricolari. Le illustrazioni degli esercizi hanno una descrizione testuale generata dai dati della scheda, quindi non sono più invisibili a uno screen reader. Tutte le animazioni rispettano "Riduci movimento" di iOS.

### Sostituire l'icona sulla schermata Home

iOS fotografa l'icona al momento dell'installazione e non la aggiorna da sola: dopo aver cambiato le icone nel repository bisogna reinstallare la scorciatoia, e reinstallare significa **perdere i dati salvati** (vedi il riquadro sopra). Prima di procedere:

0. Apri l'app, vai in **Programma → Dati** e tocca **Esporta JSON**: salva il file da qualche parte che ricordi (finisce in File → Download).
1. Carica le tre icone aggiornate (`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`) insieme agli altri file.
2. Sulla schermata Home tieni premuta l'icona vecchia → **Rimuovi app** → **Rimuovi dalla schermata Home** (i tuoi dati non si perdono: restano nell'archivio del sito).
3. Apri l'indirizzo dell'app con Safari, tocca **Condividi** → **Aggiungi a Home** → **Aggiungi**.
4. Se ricompare l'icona vecchia, in Safari apri Impostazioni → Safari → Cancella dati siti web e cronologia oppure ricarica la pagina due volte, poi ripeti il punto 3.

### Aggiornare l'app in seguito
Carica i file modificati nello stesso repository (**Add file → Upload files** sovrascrive quelli con lo stesso nome). Versione nell'intro e numero di cache si aggiornano con un solo comando, `./version.sh 4.4`, che scrive la data di oggi e incrementa la cache: erano tre punti da toccare a mano e bastava dimenticarne uno perché l'iPhone continuasse a servire la versione vecchia. Da questa versione non serve altro: l'app controlla la presenza di aggiornamenti all'apertura e ogni ora, e quando ne trova uno mostra in basso l'avviso **"Aggiornamento pronto"**. Lo applichi quando vuoi tu — se sei a metà seduta l'app te lo dice e la seduta viene salvata prima di ricaricare. Il service worker usa network-first sui file dell'applicazione, quindi la versione nuova arriva da sola appena c'è rete, e cache-first su icone e immagini, che non cambiano.

### Se qualcosa non va
- **Schermata bianca o messaggio sui dati non caricati**: manca qualche file nel repository, oppure i file sono finiti dentro una sottocartella. Devono stare nella radice, accanto a `index.html`.
- **"Aggiungi a Home" non compare**: stai usando Chrome o Firefox. Riapri l'indirizzo in Safari.
- **L'icona non si vede**: le due `icon-*.png` non sono state caricate.
- **L'app non si aggiorna**: hai dimenticato di cambiare il nome della cache in `sw.js`.

I tuoi dati (carichi, storico, settimana del ciclo) restano sul telefono, non sul sito: pubblicare il repository come *public* non espone nulla di personale.

---

## 3. Uso quotidiano

All'apertura scorre un'intro di tre secondi: l'anello del marchio si disegna, le tre barre della progressione salgono una dopo l'altra, compaiono nome, sottotitolo e una **frase motivazionale** in italiano, inglese o francese. Le frasi sono 123, originali e non attribuite, e l'app tiene in memoria le ultime cento mostrate: una frase non può quindi ripetersi prima di altre cento aperture. Si aggiungono o si modificano in `quotes.json`. Finita l'animazione l'intro resta ferma sull'ultimo fotogramma e sparisce **solo quando tocchi lo schermo** (in basso compare il suggerimento "Tocca per iniziare"). Rispetta l'impostazione di sistema per il movimento ridotto.

- **Oggi**: scegli palestra o casa, poi il **calendario della settimana** mostra tutte e cinque le sedute previste più il blocco core facoltativo. L'etichetta *da programma* resta sempre attaccata alla seduta che il programma prevede come prossima, anche dopo uno scambio d'ordine; la seduta scelta per oggi è marcata a parte come *scelta per oggi*. Le sedute le già svolte restano barrate e non riapribili. Tocca la seduta che vuoi fare adesso — anche il blocco core — e sotto compare il suo elenco esercizi; poi premi *Inizia la sessione*. Scegliendo una seduta diversa da quella prevista, quella di oggi prende il suo posto più avanti nella settimana, quindi non si perde nulla.
- Nell'elenco della seduta, **tocca un esercizio** per aprirne subito la scheda illustrativa, senza dover iniziare l'allenamento.
- Durante l'esercizio: segna le serie completate, scrivi il carico, dai il feedback con le tre frecce, premi **Ho finito la serie**: parte il timer di recupero, con un rintocco su ciascuno degli ultimi 3 secondi e colpo finale più acuto.
- **Esercizi a tempo** (stretching statico, plank, wall sit): il pulsante diventa *Avvia 30 secondi* e fa partire il cronometro della tenuta, in verde. Prima del conteggio ci sono **3 secondi di preparazione**, scanditi da un rintocco ciascuno, mostrati come sola cifra al centro del cerchio; al termine parte da solo il recupero.
- **Esercizi da fare un lato alla volta** (split squat, rematore a un braccio, plank laterale, quasi tutti gli allungamenti) hanno sempre un **numero pari di serie**, così destra e sinistra ricevono lo stesso lavoro: il contatore mostra `1 Sx`, `1 Dx`, `2 Sx`… e il pulsante di avvio indica il lato da fare.
- **Cambia esercizio**: apre una pagina di scelta (si esce con *Indietro*, che non modifica nulla) con le alternative disponibili, ordinate per pertinenza rispetto a quello in programma — pesano lo schema di movimento, il ruolo nel blocco trazioni, il gruppo, i muscoli primari condivisi e il tipo di carico — ciascuna con l'illustrazione, l'attrezzatura e il motivo per cui è proposta. L'esercizio previsto compare in cima con il pulsante *Mantieni*, quindi decidi tu se cambiare. Lo stesso vale dalla scheda esercizio (*Sostituisci con un altro esercizio*) e prima di iniziare, dall'elenco di Oggi.
- **Dai muscoli agli esercizi**: nella scheda esercizio le etichette dei muscoli coinvolti sono toccabili e aprono l'elenco di tutti gli esercizi che lavorano quel muscolo con l'attrezzatura selezionata, sempre con la possibilità di sostituire quello in programma o di tenerlo.
- **Esercizio precedente**: il pulsante *‹ Precedente* torna indietro nella scaletta per correggere un carico o completare una serie saltata. Lo storico non si sdoppia: il record dell'esercizio viene aggiornato, non duplicato.
- **Ordine degli esercizi**: se una macchina o un attrezzo è occupato, usa *Rimanda a dopo* (sposta l'esercizio corrente in fondo) oppure *Ordine esercizi*, che apre la scaletta di quello che resta da fare con le frecce su/giù. Serie già completate, carico e feedback seguono l'esercizio spostato.
- **Il timer ha tre comandi**: *Riprendi ora* chiude il recupero in anticipo ed esegue ciò che aveva in coda; *Ferma il timer* lo annulla senza concludere nulla, lasciando la serie come sta; *Riduci* lo trasforma nella barretta in basso, che ha a sua volta *Salta* e ✕ per fermarlo. Allo scadere la schermata dell'esercizio viene sempre ridisegnata, quindi il pulsante della serie successiva torna attivo da solo; se nel frattempo stavi guardando un'altra schermata, una barretta segnala *Recupero finito* e riporta alla seduta.
- **Il conteggio delle serie avanza solo dal pulsante in basso**, che dice sempre quale serie sta per chiudere ("Ho finito la serie 2 di 3"). I pallini servono a correggere il conteggio, non ad avanzarlo: portarli al massimo con un tocco chiede conferma, perché equivale a dichiarare l'esercizio concluso. L'esercizio si chiude solo se è stata quella pressione a completare l'ultima serie, e il passaggio automatico al movimento seguente è legato all'esercizio da cui il timer è partito: se nel frattempo ti sposti, il timer non registra quello sbagliato.
- **Il timer non si ferma passando all'esercizio successivo**: se premi *Prossimo esercizio* durante il recupero, il conto alla rovescia prosegue e ti accompagna al movimento seguente; si stacca solo l'avanzamento automatico che aveva in coda. Mentre un timer è in corso il pulsante di avvio dell'esercizio resta disattivato, con l'avviso che si riattiva allo scadere.
- **Il timer non si ferma mai cambiando schermata**: se passi a Progressi o a Programma mentre scorre, si riduce da solo alla barretta in basso e continua il conteggio, rintocchi compresi.
- **Timer riducibile**: durante il recupero tocca *Riduci*. Il pannello rimpicciolisce verso il basso con un'animazione e il conto alla rovescia resta in una barretta, mentre puoi consultare schede e storico. Tocca la barretta e il pannello si riapre ingrandendosi; *Salta* riprende subito.
- Chiusura e interruzione della sessione chiedono sempre conferma, così non si esce per errore. Se esci dalla vista della sessione, in Oggi compare il banner **Riprendi**.
- **Scheda esercizio**: si apre sempre dall'alto e riporta, oltre a esecuzione passo-passo, muscoli, errori e figure, anche **l'ultima registrazione** dello stesso esercizio (data, carico, freccia e stelle) e il **carico suggerito per oggi**. È raggiungibile anche dalla pagina *Ordine degli esercizi*, toccando il nome di un esercizio.
- A fine seduta puoi annotare una nota libera (sensazioni, ginocchio, carichi). Salvando, un **pop up di complimenti** celebra la seduta conclusa: cerchio che si disegna, spunta, scintille, minuti, esercizi e media delle stelle, con una riga di commento che cambia in base a com'è andata. Se era la quinta seduta della settimana, alla chiusura lascia il posto al riepilogo settimanale.
- **Esercizi**: nuova scheda con tutti i 109 esercizi del database, cercabili per nome, muscolo o attrezzo e filtrabili per gruppo. Ogni voce apre la scheda completa e mostra l'ultimo carico registrato. Serve anche in palestra, quando una macchina è occupata e vuoi capire cosa sai fare al suo posto.
- **Seduta libera**: dalla schermata Oggi, per allenarsi fuori programma. Scegli gli esercizi al momento, timer e registrazione funzionano come sempre, ma la settimana del programma non avanza.
- **Note personali**: ogni esercizio può avere una nota che resta nel tempo e ricompare ogni volta ("sedile al foro 4", "presa stretta", "il ginocchio tira se scendo troppo").
- **Progressi**: toccando un esercizio si apre il suo grafico con l'elenco delle registrazioni e, in fondo, *Cancella lo storico di questo esercizio*, utile quando si cambia attrezzo e i vecchi carichi non sono più confrontabili. Andamento del carico per esercizio e riepilogo delle ultime dieci sedute. Toccando una seduta si apre il suo **riepilogo completo**: data e ora, durata, nota, e l'elenco degli esercizi svolti con serie, ripetizioni, carico e feedback.
- **Programma**: cambio di programma (3, 4 o 6 settimane), attrezzatura predefinita, priorità ginocchio, esclusione degli esercizi critici per la spalla, obiettivo trazioni, spostamento avanti/indietro nella settimana, esportazione e azzeramento dati.

---

## 4. Limiti tecnici noti e alternative

**Schermo sempre acceso.** L'app usa la Screen Wake Lock API, supportata da Safari iOS dalla 16.4. Il blocco viene richiesto all'avvio della sessione e riacquisito ogni volta che l'app torna in primo piano, e rilasciato a fine seduta per non consumare batteria. Se il sistema lo nega (batteria molto bassa, versione iOS precedente), la scheda Programma mostra "non supportato": in quel caso alza manualmente il blocco automatico in Impostazioni → Schermo e luminosità → Blocco automatico → Mai, e riportalo a 30 secondi dopo l'allenamento.

**Campanella: come funziona e perché a volte non si sente.** La campanella è un breve file WAV sintetizzato dall'app all'avvio e riprodotto da un elemento `<audio>`, cioè sul canale multimediale, che su iOS è molto più affidabile del suono generato con Web Audio (rimasto solo come riserva). Gli elementi audio vengono sbloccati al primo tocco su un pulsante, come richiede Safari. Se non senti nulla, controlla nell'ordine:

1. **Modalità silenziosa attiva** — è la causa più frequente: l'interruttore laterale o la mezzaluna nel Centro di Controllo silenzia anche il suono delle pagine web.
2. **Volume multimediale basso** — va alzato con i tasti laterali *mentre l'app riproduce un suono*: usa il pulsante **Prova la campanella** nella scheda Programma e regola il volume in quel momento.
3. **Interruttore "Campanella del timer"** in Programma, che deve essere attivo.
4. Se hai aggiornato i file, ricorda di cambiare la versione della cache in `sw.js`, altrimenti gira ancora la versione vecchia.

**Come funzionano le campanelle (riscritte da zero).** Programmare molti suoni con dei timer, su iOS, produce rintocchi sfasati e nessun suono quando l'app passa in secondo piano. L'app quindi non programma più niente: all'avvio del timer costruisce **una sola traccia audio** che contiene già il silenzio e i rintocchi nei punti esatti — tre rintocchi sui secondi finali più il colpo di chiusura, e altrettanti sui tre secondi di preparazione con il colpo di via — e la manda in riproduzione. Da quel momento il tempo lo tiene il motore audio del telefono: i rintocchi cadono precisi al campione (verificato: su un recupero da 90 secondi cadono a 87, 88, 89 e 90 esatti), sono sempre suoni singoli e non possono accavallarsi, e continuano a scorrere mentre navighi fra le schermate dell'app. Al rientro in primo piano la traccia viene riallineata al contatore, e i pulsanti ±15 s la ricostruiscono sul tempo rimanente.

**Musica e secondo piano.** La sessione audio è dichiarata `ambient`: si mescola all'audio delle altre app, quindi Spotify e YouTube non vengono mai interrotti né abbassati e la campanella si sovrappone alla musica. Questa scelta ha due conseguenze da conoscere: l'interruttore del silenzioso dell'iPhone silenzia anche la campanella, e in background il suono prosegue soltanto finché iOS lascia attiva la riproduzione della pagina. Le alternative non esistono davvero: l'unica categoria che garantisce il suono a schermo bloccato è `playback`, che però mette in pausa la musica — esattamente ciò che va evitato. Restano quindi il wake lock, che tiene lo schermo acceso per tutta la seduta, e la vibrazione a fine timer.

**Campanella con app ridotta o in secondo piano.** Con il timer ridotto a barretta l'app resta in primo piano e i rintocchi suonano regolarmente. Se invece esci dall'app o blocchi lo schermo, iOS sospende l'audio delle pagine web e il suono può non arrivare: è un limite di sistema che nessuna PWA può aggirare senza tenere occupata la sessione audio, cosa che fermerebbe la musica. Per questo il wake lock tiene lo schermo acceso durante la sessione e a fine timer parte anche la vibrazione.

**Notifiche.** Su iOS le notifiche push da PWA richiedono l'installazione a Home e permessi espliciti; non sono usate qui per non introdurre dipendenze da un server.

**Frequenza cardiaca e Garmin Forerunner 55: funzione rimossa.** Una PWA in Safari è isolata nel browser e non può in alcun modo collegarsi all'app Garmin Connect installata sull'iPhone: iOS non permette a una pagina web di leggere i dati di un'altra app, Safari non espone Web Bluetooth (quindi niente lettura diretta dell'orologio) e HealthKit è accessibile solo alle app native, perciò nemmeno il passaggio Garmin Connect → Salute apre una strada. Restano solo percorsi che non sono un "collegamento" e richiedono un backend o passaggi manuali:

- **Garmin Health API / Connect Developer Program**: dati automatici, ma serve un server proprio, la registrazione come sviluppatore e l'approvazione di Garmin.
- **Import di un file esportato**: da Garmin Connect si esporta l'attività in `.tcx` (XML con la frequenza cardiaca campionata) e la si carica nell'app, che ne ricava media e massimo. Funziona senza server, ma è un'operazione manuale da fare dopo ogni seduta.
- **Scorciatoia iOS**: un'automazione dell'app Comandi può leggere la FC da Salute e copiarla negli appunti, da incollare a mano.

Poiché nessuna di queste opzioni è il collegamento automatico richiesto, l'inserimento manuale dei battiti è stato tolto: la scheda di fine sessione registra ora durata e una nota libera. L'intensità reale si legge direttamente sull'orologio o nell'app Garmin Connect, dove la seduta è già registrata. Se in futuro vuoi l'import del `.tcx`, il punto di innesto è `endSession()` in `app.js` e il campo da aggiungere ai record di `sessionLog`.

**Persistenza dei dati — leggi con attenzione.** Tutti i dati vivono solo su questo iPhone: non c'è alcun salvataggio su server. Dalla versione 4.0 i record di allenamento stanno in **IndexedDB**, che non ha il limite di pochi megabyte di `localStorage` e non obbliga a riscrivere l'intero stato a ogni serie registrata; impostazioni e programma restano in `localStorage`. All'avvio l'app chiede al sistema di **non cancellare i dati** durante le pulizie automatiche (`navigator.storage.persist()`) e mostra l'esito nella scheda Dati. Restano però i rischi seguenti. Su iOS questo tipo di memoria può sparire in tre casi:

1. **Rimuovi l'icona dalla schermata Home** ("Rimuovi app"): iOS cancella insieme all'icona anche i dati che l'app aveva salvato. È la causa più comune di perdita dati, ed è quello che succede tipicamente quando si reinstalla l'app per aggiornare l'icona.
2. **Il sito non viene aperto per una settimana** (limite ITP di Safari): capita raramente se usi l'app regolarmente, ma è un rischio reale nei periodi di pausa.
3. **Cancelli manualmente i dati dei siti** da Impostazioni → Safari → Cancella dati siti web.

Le difese sono tre, in ordine di forza:

1. **Backup esportato fuori dall'app.** A settimana conclusa il riepilogo propone da solo *Salva il backup della settimana*: il file passa dal foglio di condivisione di iOS, quindi può finire su iCloud Drive o in una mail a sé stessi con due tocchi. È l'unica difesa che sopravvive alla rimozione dell'icona. Il pulsante **Importa backup** lo ricarica.
2. **Istantanee automatiche.** L'app conserva le ultime tre istantanee di fine settimana, ripristinabili dalla scheda Dati. Vivono però nella stessa memoria dell'app: proteggono da un errore, non dalla disinstallazione.
3. **Esportazione CSV**, per avere i dati in un foglio apribile in Numbers o Excel: una riga per esercizio con data, carico, serie, ripetizioni obiettivo ed eseguite, RIR, massimale stimato e stelle.

Regola pratica invariata: esporta un backup **prima** di rimuovere l'app dalla Home per qualsiasi motivo, aggiornare l'icona compreso.

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

`type`: `strength`, `core`, `stretch`. `load`: `weight`, `band`, `bodyweight`, `time`. `frames`: due nomi presenti in `poses.json`. Campo facoltativo `levels`: un elenco ordinato di gradini dal più facile al più difficile, che rende misurabile un esercizio a corpo libero. All'avvio un **validatore** controlla campi obbligatori, identificativi duplicati, pose inesistenti o identiche, attrezzi non riconosciuti e pose condivise da troppi gruppi muscolari diversi — il segnale del riciclo sbagliato che aveva prodotto tre illustrazioni non pertinenti. Gli errori compaiono nella console del browser. `implement`: `barbell`, `barbellBack`, `dumbbells`, `dumbbell1`, `goblet`, `machine`, `cable`, `wheel`, `bandVertical`, `bandTop`, `bandFront`, `bandBack`, `bandFeet`, `bandFoot`, `bandKnees`, `bandAnkle`, `bandShoulder`, `bandSide`, oppure `null`.

Per un nuovo programma aggiungi una voce in `programs.json` con `cycleWeeks`, tre `strengthDays` e due `stretchDays`: la logica di periodizzazione e di rotazione si adatta da sola.

---

## Fonti della logica di allenamento

- **NSCA**, *Essentials of Strength Training and Conditioning* — schemi serie/ripetizioni/recupero per obiettivo; regola 2-for-2 per la progressione del carico (due ripetizioni oltre l'obiettivo nell'ultima serie per due sedute consecutive, poi incremento del 2,5–10%); ordine degli esercizi con il movimento obiettivo per primo.
- **ACSM**, *Guidelines for Exercise Testing and Prescription* — frequenza, intensità e volume per adulti; incremento del carico del 2–10% al raggiungimento del target.
- **ACE** — linee guida di stretching statico e mobilità dinamica.
- **OMS** — raccomandazioni di attività fisica per adulti 45-64 anni.
- **Zourdos M. et al. (2016)**, *Application of the Repetitions in Reserve-Based RPE Scale for Resistance Training*, Strength and Conditioning Journal — scala delle ripetizioni in riserva; validità confermata anche negli adulti anziani (*Experimental Gerontology*, 2025).
- **Schoenfeld B., Ogborn D., Krieger J. (2017)**, *Dose-response relationship between weekly resistance training volume and increases in muscle mass*, Journal of Sports Sciences — meno di 5 serie settimanali per gruppo +5,4%, 5–9 serie +6,6%, 10 o più +9,8%.
- **Epley (1985)** — formula del massimale stimato usata nei confronti fra sedute.
- **Journal of Strength and Conditioning Research** — confronto fra assistenza elastica, macchina a contrappeso e lavoro eccentrico nella progressione verso le trazioni.
- **W3C**, *WCAG 2.2*, criterio 1.4.4 Resize Text — niente blocco dello zoom.

## Avvertenza

I programmi generati sono costruiti su linee guida generali per adulti sani e non sostituiscono una valutazione medica. Prima di iniziare, e in particolare per la sensibilità al ginocchio, consulta un medico o un fisioterapista. Interrompi in caso di dolore articolare acuto, dolore toracico, mancanza di respiro insolita o vertigini.
