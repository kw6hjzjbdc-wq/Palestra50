# Palestra 50

PWA per allenamento in palestra e a casa, costruita su un profilo specifico: uomo di 50 anni, obiettivo tono e ipertrofia, riduzione del grasso addominale, rinforzo degli arti inferiori a protezione del ginocchio, mobilità mantenuta con stretching regolare.

Settimana tipo (dalla 5.0): **6 sedute a pranzo** — forza A, aerobico a intervalli, forza B, aerobico a ritmo costante, forza C, mobilità (sempre l'ultima) — di durata scelta ogni giorno fra 35, 40, 45 e 50 minuti (45 predefinita dalla 8.3), più un blocco core facoltativo e, dalla 5.1, cinque sessioni di mobilità del mattino da 10 o 15 minuti (giorni 1-5).

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
- settimane intermedie → le ripetizioni scendono verso il basso del range. Il **carico non sale per calendario**: sale solo con la regola 2-for-2, quando i risultati registrati lo giustificano (vedi *Progressione del carico*);
- ultima settimana di ogni ciclo → scarico: una serie in meno e qualche ripetizione in meno, carichi fermi, per gestire il recupero;
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

### Settimana da 6 sedute (dalla 5.0)

| Giorno | Seduta | Perché lì |
|---|---|---|
| 1 | Forza A · gambe e spinta | a inizio settimana, a fresco |
| 2 | Aerobico · intervalli | fra due sedute di forza: 48 ore fra un allenamento di pesi e l'altro |
| 3 | Forza B · parte alta e unilaterale | |
| 4 | Aerobico · ritmo costante | lavoro moderato, non affatica i muscoli che servono il giorno dopo |
| 5 | Forza C · full body e core | |
| 6 | Mobilità | **ultima di default**: recupero prima della settimana successiva; dalla 6.10 si può fare in qualunque giorno |

Le tre sedute di forza mantengono il lavoro per le trazioni (tre volte a settimana) e tutti i gruppi muscolari lavorano almeno due volte (ACSM 2026). La mobilità è una sola seduta, ma ogni seduta aerobica si chiude con due allungamenti per anche e polpacci: la flessibilità viene allenata almeno 3 giorni a settimana, come indicato dall'ACSM. Le due sedute di mobilità alternano i due schemi di settimana in settimana.

**Passaggio dalla 4.8.** Le settimane già iniziate con 5 sedute restano da 5 (storico e riepiloghi non cambiano); le 6 sedute partono dalla prima settimana nuova.

**Sedute aerobiche.** Riscaldamento 5 minuti → parte centrale → defaticamento 3 minuti → due allungamenti. Le parti si susseguono da sole, senza toccare il telefono sulla macchina.
- *Intervalli*: scatti a sforzo 8/10 con recupero attivo. Progressione con le settimane di allenamento: 30 s / 90 s (settimane 1-4) → 30/60 (fino alla 12) → 45/60 (fino alla 24) → 60/60. Massimo 12 scatti: il tempo che avanza diventa ritmo costante. In settimana di scarico gli scatti calano del 40%.
- *Ritmo costante*: 15-45 minuti a sforzo 5-6/10, "riesci a parlare a frasi brevi".
- *Attrezzi*: bici da spinning (sempre seduti, sella alta), cyclette orizzontale (la più delicata per la rotula), sacco da pugilato (piedi fermi, solo intervalli), vogatore, macchina a scalini. Con la **priorità al ginocchio** attiva vogatore e scalini non vengono proposti in automatico — l'attacco del vogatore e la salita sugli scalini caricano la rotula in flessione profonda — ma si scelgono con *Cambia esercizio* nei giorni buoni (vogatore con attacco accorciato, scalini solo a ritmo costante). A casa: colpi al sacco d'aria e camminata veloce in piano.

**Minuti aerobici.** Progressi mostra i minuti della settimana nel conto dell'OMS (un minuto di scatto vale due moderati) rispetto al riferimento di 150; il riepilogo settimanale indica come arrivarci. Il finale metabolico nelle sedute di forza resta disponibile e, con due sedute aerobiche in settimana, ha riservati i suoi 10 minuti solo quando scegli 50 minuti (con 40-45 entra se avanza tempo).

### L'app si apre su Oggi (dalla 6.5)

Fino alla 6.4 dopo l'intro si apriva una **Home** con tre riquadri — *Mattino*, *Pranzo* e un riassunto del percorso — quasi identica alla schermata di scelta di *Oggi*. La Home è stata tolta: dopo l'intro — «Forza · Mobilità · Linea», con la riga del percorso e una frase del giorno — si apre direttamente **Oggi**, con le due scelte *Mattino · mobilità* e *Pranzo · allenamento del giorno*. Le informazioni sul percorso (fase, settimana, settimane mancanti, data di fine) stanno nel riquadro *Il percorso* di **Progressi**, insieme a *Le prossime settimane*, *Trazioni e muscle-up*, *Progressione negli esercizi*, *Misure corporee* e *Volume e storico*.

- Con una seduta in corso, il riquadro *Pranzo* riporta direttamente dentro la seduta, come faceva quello della Home.
- Fine seduta, interruzione, «salta» e chiusura di una seduta rimasta aperta riportano tutti a *Oggi* (`goToday`).
- La barra in basso ha quattro voci: **Oggi**, Progressi, Esercizi, Programma.

### Esercizi a tempo: riserva in secondi (dalla 5.9)

Negli esercizi la cui difficoltà è il tempo (tenuta isometrica alla sbarra, plank, wall sit, sospensione) la domanda di fine serie non è più «quante ne avresti fatte ancora?» ma **«quanti secondi avresti resistito ancora?»**, con 0, 5, 10 e 15+.

Il margine entra nella valutazione: la prestazione di una tenuta vale *secondi tenuti + metà dei secondi di riserva* (la riserva è capacità, non lavoro svolto), moltiplicata per le serie. Dieci secondi tenuti con dieci di margine valgono più di dieci al limite, ed è giusto che le stelle lo dicano.

Entra anche nella progressione: **ogni due sedute di fila chiuse con almeno 10 secondi di margine, la tenuta suggerita cresce di 5 secondi**, fino a +30. È l'equivalente della regola 2-for-2 del carico — si progredisce quando il margine c'è, non per calendario — e la schermata dell'esercizio lo segnala.

Due sedute di fila portate al limite vengono segnalate solo se non è arrivato nemmeno un miglioramento: prima la segnalazione copriva anche i progressi veri.

### Perché quelle stelle: due correzioni (5.9)

- **L'attesa non cresce all'infinito.** Il confronto si aspetta circa +2,5% a settimana dall'ultima volta che hai fatto quell'esercizio. Con la rotazione degli esercizi potevano passare quattro settimane, e l'app pretendeva +10%: un miglioramento reale del 5% prendeva due stelle. Ora l'attesa si ferma a +5%.
- **Il motivo è visibile.** In *Progressi → Ultime sedute*, aprendo una seduta, ogni esercizio mostra le sue stelle e la frase che le spiega («in linea con la progressione prevista», «calo del 4% sul massimale stimato», «obiettivo diverso dalla volta scorsa»), con margine o RIR dichiarati.

### Supplementari decisi dalla settimana, non da una lista (dalla 6.3)

**Principio**: nessun gruppo muscolare ha un posto obbligato fuori da quanto il programma prevede. Le sedute seguono il programma; gli esercizi *supplementari* ("se resta tempo") vanno ai gruppi che, **in base al programma e a quanto hai fatto davvero**, restano indietro nella settimana.

Fino alla 6.0 ogni seduta di forza aveva una lista fissa di supplementari (ad esempio polpacci e quadricipiti isolati in Forza B) che entravano ogni volta che il tempo bastava, anche nelle settimane di scarico. La 6.1 li ha condizionati al volume previsto; la 6.2 aveva dato ai polpacci un posto fisso, poi tolto su indicazione dell'utente. Dalla 6.3 (`weekNeeds`, `buildStrength`):

- per ogni gruppo l'app stima dove arriverà la settimana: per le sedute **già passate** conta le serie **registrate** (quindi una seduta saltata o accorciata pesa), per la seduta in esame e le successive le serie che il programma **prevede**;
- i supplementari (al massimo due) vanno ai gruppi che restano **sotto le 10 serie settimanali** (minimo ACSM 2026), prima al più indietro, con un esercizio mirato per quel gruppo; dopo averne scelto uno il conteggio si aggiorna;
- le liste fisse `extras` sono state tolte da `programs.json`;
- **nelle settimane di scarico non entra nessun supplementare**: il volume più basso è voluto;
- la nota spiega il motivo, ad esempio "Supplementare · Polpacci a 2,5 serie su 10 questa settimana · se resta tempo";
- le registrazioni della seduta del giorno non entrano nel calcolo, quindi la seduta non cambia mentre la si registra;
- gli **esercizi in più a fine seduta** (dalla 5.8) usano la stessa stima, compreso quanto fatto oggi;
- il **volume previsto** nell'analisi settimanale non conta più i supplementari: è quello del programma, e il confronto con il fatto resta onesto.

### Verifica completa, razionalizzazione e ottimizzazione (6.0)

La 6.0 non aggiunge funzioni: controlla quelle che ci sono, le rende più veloci e rimette in ordine le fonti.

**Un difetto trovato e corretto.** Il passaggio alle settimane da sei sedute (`week6From`) è per costruzione un multiplo di 5, perché avviene sempre a inizio settimana. Con un valore diverso — un backup modificato a mano, un file importato da un'altra installazione — `weekStart` finiva oltre l'indice e la posizione nella settimana diventava −1: la prima seduta del programma usciva **senza tipo**, veniva costruita come mobilità e registrata con un genere indefinito, quindi restava invisibile al conteggio delle sedute di forza e al volume settimanale. Ora il valore viene riportato all'inizio della sua settimana e la posizione è comunque tenuta dentro i limiti della settimana. Con dati validi non cambia nulla: le sedute generate sono identiche a prima, verificate una per una.

**Robustezza.** Un indice di seduta negativo, una permutazione corrotta, un programma o un'attrezzatura inesistenti, una durata fuori scala, una scelta di seduta che punta a un attrezzo ritirato, registrazioni senza campi: diciassette stati anomali, tutti provati su tutte le schermate. Prima uno di questi faceva saltare l'app; ora nessuno produce un'eccezione, e i valori fuori scala vengono riportati nel campo all'avvio.

**Velocità.** Costruire una seduta non è gratis, e la stessa posizione veniva ricostruita più volte nella stessa schermata — il calendario della settimana ne costruisce sei, la mobilità del mattino un'altra solo per leggerne l'etichetta, il volume previsto tutte quelle di forza. Ora c'è una memoria delle sedute già costruite, che si svuota da sola quando cambia qualcosa da cui dipendono (programma, attrezzatura, durata, precauzioni, settimane di sola mobilità, scelte di seduta, risultati registrati). Lo stesso trattamento per l'analisi del volume e per la tendenza degli esercizi, che comparivano in due schermate. Su uno storico realistico di nove mesi (1.583 esercizi, 220 sedute):

| | prima | dopo |
|---|---|---|
| Oggi · seduta del giorno | 3,5 ms | 0,9 ms |
| Home | 4,4 ms | 2,2 ms |
| Progressi | 8,9 ms | 1,7 ms |
| Storico | 32,0 ms | 12,2 ms |
| Analisi del volume | 5,9 ms | 1,4 ms |

**Scritture su disco.** A ogni salvataggio — e si salva a ogni serie registrata — l'archivio dei risultati veniva riscritto per intero: a fine programma sono migliaia di record ogni volta. Ora si riscrive solo quando qualcosa è davvero cambiato. Lo stesso controllo serve a sapere quando svuotare la memoria delle sedute.

**Meno codice ripetuto.** I due riquadri delle sedute di oggi, identici nella Home e nella schermata di scelta, sono scritti una volta sola; la linea dei carichi nello storico guarda le ultime 24 registrazioni invece di tutta la storia, che a fine programma è lunga e nel grafico non si leggerebbe comunque.

### Fonti: verifica una per una (6.0)

Ogni fonte citata dall'app è stata riaperta e riletta. Nessun parametro di allenamento è risultato sbagliato; sono state corrette precisione delle citazioni e qualificazione dei numeri:

- **ACSM Position Stand 2026** confermato come posizione più recente (Currier et al., MSSE 58(4):851-872). Precisazioni recepite: le 10 serie settimanali sono un **minimo**, non un bersaglio, con plateau verso 18-20 (le barre del volume ora lo dicono); l'ordine degli esercizi conta per la forza, non per l'ipertrofia; le prove non bastano a fissare valori precisi di ripetizioni di riserva, quindi il 2-3 RIR dell'app è dichiarato per quello che è, una scelta pratica prudente;
- **Pelland et al.** è del **2026** (Sports Medicine 56(2):481-505), non del 2025;
- **Chang et al. 2026**: i 400 MET-min a settimana sono la **dose minima efficace** dell'HIIT, non l'obiettivo — l'effetto massimo si colloca verso 1000-1100, circa 230 minuti di camminata veloce. Si aggiunge **Xu et al. 2026**, seconda rete indipendente che conferma la graduatoria;
- **Donnelly et al. 2009** è **superato** dal Consensus Statement ACSM 2024 (Jakicic et al.), che non fissa più obiettivi percentuali di perdita di peso. Il tetto del 5-10% resta nella proiezione delle misure, ma come freno prudente e non più come "obiettivo raccomandato dall'ACSM";
- **Zourdos et al. 2016** era attribuito alla rivista sbagliata: è *Journal of Strength and Conditioning Research* 30(1):267-275;
- i numeri sullo **stretching** sono ACSM (Garber et al. 2011), non ACE, e il 30-60 s riguarda gli "adulti più anziani", non una soglia di 50 anni;
- la **regola 2-for-2** non è verificabile su fonte ad accesso aperto: resta la regola operativa dell'app, ma non viene più presentata come citazione NSCA. La posizione NSCA leggibile (Fragala et al. 2019) non indica alcun metodo di progressione come superiore agli altri — il che conferma la scelta di far salire il carico sui risultati e non sul calendario;
- **novità 2025 recepite**: per la spalla, la linea guida JOSPT 2025 (Desmeules et al.) comprende il conflitto subacromiale nella tendinopatia della cuffia dei rotatori, raccomanda l'esercizio contro resistenza con prove forti e **non elenca movimenti da evitare**; per il ginocchio, Morri et al. 2025 trova che nessun tipo di rinforzo è superiore a un altro e **nessun esercizio è sconsigliato**. Per questo i due interruttori in *Programma* sono ora presentati come preferenze di comfort, con una nota che lo spiega: se un movimento non fa male, basta togliere la spunta e torna disponibile.

### Oggi: prima si sceglie, poi si entra (dalla 5.13)

La schermata *Oggi* mostrava di seguito la mobilità del mattino, il calendario della settimana e l'elenco completo della seduta di pranzo: tre blocchi lunghi, con quello che serviva davvero quasi sempre fuori schermo.

Ora *Oggi* si apre su **due scelte** — *Mattino · mobilità* e *Pranzo · allenamento del giorno* — ciascuna con stato (da fare, fatta, saltata), durata e numero di esercizi. Toccandone una si aprono i suoi dettagli: la mobilità del mattino con i pallini dei cinque giorni e la durata, oppure il calendario della settimana, la durata scelta, l'elenco degli esercizi e i pulsanti di avvio. **‹ Torna alla scelta** riporta indietro, e la voce *Oggi* della barra in basso riapre sempre la scelta. I riquadri della Home portano direttamente dentro la sessione giusta, senza passare dalla scelta.

### Settimana di scarico: fascia rossa sempre in vista (dalla 5.13)

Ogni quarta settimana del blocco è di scarico: stessi carichi, una serie e qualche ripetizione in meno. L'app già congelava il carico suggerito, ma l'informazione viveva in una riga di nota facile da saltare, e bastava alzare il peso a mano per vanificare il recupero.

Ora, per tutta la settimana di scarico, compare una **fascia rossa in cima allo schermo** — *⚠ Settimana 4 di scarico · non aumentare i carichi*. Sta dentro la barra del titolo, quindi resta visibile in ogni schermata, **durante la seduta compresa**, e ricompare anche sul timer a tutto schermo. Toccandola si apre la spiegazione: perché lo scarico serve, e perché il carico suggerito resta quello della settimana scorsa anche dove hai soddisfatto la regola 2-for-2 (l'aumento scatta la settimana successiva). Nelle schermate di *Oggi* la fascia è accompagnata da un riquadro rosso con la nota della settimana. Nelle settimane di sola mobilità la fascia non compare: non c'è carico da tenere fermo.

### Dove sei nel programma: un solo modo di dirlo (dalla 5.12)

La stessa informazione era scritta in quattro modi diversi. La Home e le Impostazioni contavano la **settimana di calendario** (la quarta), il riquadro *Progressi* la **settimana di allenamento** (la terza, perché una settimana era di sola mobilità e non conta sul piano di 37), l'etichetta in alto in *Oggi* mostrava invece la settimana dentro il blocco di quattro. Tre numeri per la stessa domanda.

Ora esiste una sola formula, usata da tutte le schermate: **«sessione 2 di 6 · settimana 4 di 37»**. Quando le due settimane divergono — cioè solo dopo una settimana di sola mobilità — la formula lo dice per esteso: **«sessione 2 di 6 · settimana 4 di calendario · allenamento 3 di 37»**. L'etichetta in alto, dove lo spazio è poco, porta la versione corta *Sett. 4 · sess. 2 di 6*, con lo stesso numero di settimana di tutto il resto. Le Impostazioni aggiungono una riga che spiega la differenza quando c'è.

### Cambiare la seduta aerobica o di mobilità (dalla 5.12)

Le sedute di forza hanno un ordine che serve: A, B e C si alternano per non caricare due volte gli stessi distretti. L'aerobico no — che i minuti arrivino dalla cyclette, dal sacco o dalla bici da spinning cambia poco per il risultato e molto per la voglia di farli (e per l'attrezzo libero in sala).

In *Oggi*, nelle giornate aerobiche e di mobilità, compare **Cambia attrezzo o tipo di lavoro** (o *Cambia schema di mobilità*):

- **aerobico** — si sceglie l'attrezzo fra quelli disponibili (bici da spinning, cyclette orizzontale, sacco da pugilato, vogatore, macchina a scalini; a casa colpi al sacco d'aria e camminata veloce) e il tipo di lavoro, *intervalli* o *ritmo costante*. Riscaldamento, parte centrale, defaticamento e allungamenti finali si ricostruiscono attorno alla scelta, con la stessa progressione degli scatti e lo stesso budget di minuti. Se l'attrezzo non regge il lavoro a intervalli (la macchina a scalini, per esempio) l'app passa da sola al ritmo costante. Vogatore e scalini restano segnalati come sconsigliati con la priorità al ginocchio, ma si possono scegliere;
- **mobilità** — si sceglie quale dei due schemi svolgere: *Anca, gambe e ginocchio* oppure *Colonna, spalle e parte alta*.

La scelta è legata alla **posizione nel programma**, non all'esercizio: resta se cambi la durata della seduta, se esci e rientri, se chiudi l'app, e si cancella da sola quando quella seduta è passata. *Torna alla seduta prevista* annulla. Quello che non cambia è il posto della mobilità: resta l'ultima seduta della settimana, qui si cambia solo il contenuto.

### Kettlebell (dalla 5.12)

In sala ci sono kettlebell **da 8 a 24 kg, un ferro ogni 2 kg**: è una scala a sé, con il suo passo minimo, e l'app la usa come già fa con bilanciere, manubri e macchine (il selettore del carico propone solo pesi che esistono davvero).

Tre esercizi nuovi, tutti compatibili con ginocchio e spalla:

- **Slancio con kettlebell (swing russo)** — schema d'anca, non di ginocchio: la rotula resta quasi scarica. Lo swing russo si ferma all'altezza dello sterno, quindi non entra nell'arco doloroso del conflitto subacromiale. Lavora glutei, femorali, erettori spinali e presa, con una componente cardiometabolica che serve all'obiettivo sul grasso addominale;
- **Goblet squat con kettlebell** — il carico davanti al petto tiene il busto eretto e scarica la rotula;
- **Rematore con kettlebell a un braccio** — presa neutra e gomito vicino al corpo, fuori dall'arco critico della spalla.

Il kettlebell compare anche fra gli attrezzi utilizzabili per rematore con manubrio, affondi e split squat bulgaro.

### Seduta rimasta aperta: anche come seduta libera (dalla 5.12)

Quando l'app si chiude prima del riepilogo, all'avvio successivo propone di sistemare la seduta. Alle due risposte esistenti (*era la mobilità del mattino*, *era la seduta del giorno*) se ne aggiunge una terza: **era una seduta libera**. In quel caso resta registrato soltanto ciò che hai davvero fatto — nessun esercizio aggiunto d'ufficio alle dosi previste — e il programma **non avanza**, perché la seduta prevista è ancora da svolgere. I minuti si ricavano dall'intervallo fra la prima e l'ultima registrazione. Come sempre, nessuna delle quattro risposte cancella qualcosa.

### Ogni serie ha la sua riga (dalla 5.11)

Prima l'app teneva un solo carico e un solo numero di ripetizioni per esercizio, quelli dell'ultima serie. Se alzavi il peso alla seconda serie, la fatica si scaricava sulla terza ma nei numeri non si vedeva.

Ora ogni serie conclusa lascia la sua riga — carico, ripetizioni o secondi, riserva — sotto i pallini delle serie; toccando una riga si corregge ciò che è stato annotato male. Il confronto fra sedute usa i totali veri: **tonnellaggio** (somma di carico × ripetizioni serie per serie), **massimale stimato della serie migliore**, **ripetizioni** o **secondi totali**. Nello storico ogni seduta mostra le serie una per una, e la riga «ultima volta» le riporta in fila (`40×12 · 50×10 · 50×8`).

### Esercizi a tempo: tempo effettivo e cronometro (dalla 5.11)

- **Il tempo registrato è quello vero.** Nella sequenza automatica, se chiudi prima con *Termina la tenuta* o allunghi con *+15 s*, nello storico finiscono i secondi davvero tenuti, non quelli previsti.
- **Cronometro.** Sugli esercizi a tempo compare *Cronometro: tieni finché riesci*: tre secondi di preparazione con le campanelle, poi il contatore **sale**; *Fine tenuta* ferma, registra i secondi e avvia da solo la pausa (con i suoi rintocchi). È il modo giusto per plank, wall sit e sospensioni portate al limite, dove il tempo previsto non è il punto.
- **Plank senza stelle: corretto.** Quando l'obiettivo del blocco non indicava una tenuta (è il caso del core), la dose usciva con 0 secondi: la seduta non registrava nulla e l'esercizio restava senza valutazione. Ora la tenuta prevista si ricava dall'esercizio stesso, quindi i secondi vengono registrati e le stelle arrivano come per gli altri.

### Le prossime settimane (dalla 5.8)

Da *Oggi* (sotto il calendario), dalla pagina *Progressi* e dal riquadro *Il percorso*: sei settimane per volta, giorno per giorno, con il tipo di seduta e il suo schema (Forza A, Aerobico a intervalli, Mobilità…), la fase, le settimane di scarico e quelle di sola mobilità. Gli esercizi esatti restano scelti all'apertura della seduta, perché dipendono da carichi, attrezzatura e tempo disponibile.

### Esercizi in più a fine seduta (dalla 5.8)

Nel riepilogo di fine seduta, *Ho ancora tempo: aggiungi esercizi*. Si dichiara quanto tempo resta (5, 10 o 15 minuti) e l'app propone quattro esercizi sui **gruppi più indietro** rispetto al volume previsto per la settimana, con le serie che stanno davvero in quei minuti (tempo di preparazione compreso). Toccandone uno si torna nella seduta, che riprende da quell'esercizio e si chiude normalmente.

### Intro dopo l'aggiornamento (correzione vera), precauzione per l'inguine (8.9)
- **Intro dopo il pop-up dell'aggiornamento**: la correzione della 8.7 segnava la ricarica in `sessionStorage`, ma la ricarica stessa non serviva: i file arrivano già dalla rete (network-first), quindi l'apertura che mostra il pop-up è già la versione nuova. Ora, se all'avvio la versione è cambiata o il pop-up è stato mostrato (`bootVersionChanged`, `updPopupShown`), il nuovo service worker prende il controllo senza ricaricare la pagina: niente intro. Se invece la pagina era quella vecchia (per esempio aperta senza rete), la ricarica avviene e salta l'intro (segnale anche in `localStorage`).
- **Dolore all'inguine**: selettore in Programma › Profilo («Dolore all'inguine: evita gli esercizi che sforzano parete addominale e inguine»), acceso una volta sola alla prima apertura (`S.groinCare`, `S.groin89`). Esclusi (`groinRisk`): rollout con la ruota, hollow hold, crunch inverso, mountain climber, Copenhagen plank, adduzioni al cavo e con band, squat sumo; restano dead bug, plank, Pallof press, plank laterale, abduzioni. Vale anche nel blocco core facoltativo (prima non applicava nessuna precauzione) e nelle alternative di «Cambia esercizio». «Inguine» si può segnare come ginocchio e spalla (durante l'esercizio, a fine seduta, da Oggi, a seduta chiusa): con 4 su 10 o più la precauzione si accende da sola per la seduta successiva anche se il selettore è spento. Regola operativa dell'app.
- Fonti aperte e lette il 29 ottobre 2026: **NHS**, pagina «Hernia» (consiglia di restare attivi; dolore nella zona dell'ernia tra i segnali per cui cercare aiuto, possibile strozzamento); **NHS England 2023**, scheda decisionale sull'ernia inguinale (restare attivi ma non fare nulla che dia fastidio o dolore; «vigile attesa» se l'ernia non dà dolore; circa 2-3 su 100 si strozzano nel primo anno). Il Position Stand ACSM 2026 non tratta pressione addominale né ernia, né il recupero fra sedute consecutive.

### Stelle con ripetizioni prescritte diverse; «null» nelle serie (8.8)
- **Stelle**: il programma cambia le ripetizioni con fasi e settimane (per esempio 15 → 14 nel rollout). Prima chi faceva le ripetizioni chieste risultava «in calo» (1 stella) perché il confronto era con le ripetizioni assolute della volta scorsa. Ora, se le ripetizioni prescritte cambiano, il confronto si fa rispetto all'obiettivo di ciascuna seduta e la prima seduta alla dose nuova non deve progredire: 14 su 14 dopo 15 su 15 = «in linea» (3), con la spiegazione nel testo. Restare sotto il nuovo obiettivo resta un calo. Ricalcolo una tantum (`S.ratingsRev` = 7), tocca solo il giudizio.
- **«(null)» accanto alle serie**: compariva quando le ripetizioni di riserva non erano indicate (`isFinite(null)` è vero in JavaScript); ora non compare più (`hasNum`). Negli esercizi a livelli il nome del livello non si ripete a ogni serie.

### Seduta di oggi secondo il calendario, gambe senza ipertrofia, serie in più, ginocchia, niente intro dopo l'aggiornamento (8.7)
- **Seduta di oggi = giorno della settimana** (lunedì → 1ª seduta … sabato → 6ª; `todayPlan`, `WEEKDAYS`, `calendarMonday`). Il riquadro dice se è fatta o da fare: fatta (o saltata) → svolgimento, risultati e valutazioni; da fare → programma del giorno. In entrambe le pagine c'è il tasto «Programma della settimana». Casi: sedute dei giorni scorsi non svolte (avviando quella di oggi si spostano più avanti, come con «Seleziona»); settimana del programma finita in anticipo (oggi mostra quella già fatta); domenica = riposo, con la prossima seduta disponibile; settimana del programma iniziata in una settimana di calendario precedente e rimasta a metà → si prosegue oppure «Salta le sedute rimaste» (registro «saltata», niente cancellato). Nel programma della settimana ogni seduta porta il suo giorno; «di oggi» segue il calendario, «la prossima» è quella da fare.
- **Gambe: tono, forza, sostegno del ginocchio, esplosività; non ipertrofia**. Obiettivi nuovi in programs.json: `legStrength` (3 × 6-8, 2 min), `legTone` (3 × 15-20, 45 s), `power` (3 × 5-6 a carico moderato, salita alla massima velocità, 2 min). Le gambe non ricevono supplementari per arrivare a 10 serie e non si allungano col tempo in avanzo. Slot di Forza A/B/C: A squat (forza) · stacchi o hip thrust (tono) · leg extension parziale (tono) · **adduttori + medio gluteo**; B affondi o squat (tono) · **femorali + polpacci**; C **slancio con kettlebell (esplosività)** · squat o affondi (forza) · **glutei + medio gluteo/adduttori**. Esercizi nuovi: squat sumo goblet, adduzione al cavo e con band, Copenhagen plank corto, abduzione al cavo, passi laterali con mini band, abduzione da sdraiato, leg curl con band (casa); pose frontali `frontStand`, `frontAbd`, `frontWide`, `sideLyingDown/Up`, attrezzo `cableAnkle`. A casa, a 45′, la terza superserie di Forza C può restare fuori.
- **Serie in più**: sull'esercizio appena chiuso o su quello finito, «+ una serie in più» la aggiunge e la registra (`extraSets`, `setsPlanned` resta il previsto). Contano nel volume e nei record; le stelle confrontano solo le serie previste (`plannedPart`), così una serie in più non gonfia né abbassa il giudizio.
- **Ginocchia al contrario**: controllo automatico di tutte le pose e dei fotogrammi intermedi delle animazioni (il ginocchio deve flettersi verso dietro, il piede puntare avanti). Corretti: gamba di sfondo in piedi (leggera iperestensione in tutte le pose «in piedi»), bird dog, circonduzioni dell'anca, piede posteriore negli affondi e nell'allungamento dei flessori, leg extension, bici da spinning, slancio della gamba, dead bug, leg press (piede sulla pedana), cyclette orizzontale (prima la tibia saliva verso l'alto), posizione 90/90; animazioni del mountain climber e del burpee con una posizione intermedia.
- **Dopo il pop-up dell'aggiornamento niente intro**: la ricarica fatta per attivare la versione nuova segna `p50reload` e riparte direttamente dalla pagina d'apertura.

Fonti aperte e lette il 28 ottobre 2026: **ACSM 2026** (Currier et al., testo integrale) — potenza con carichi moderati (30-70% del massimale), volume basso-moderato (≤24 ripetizioni × serie), concentrica alla massima velocità volontaria; nessuna prova affidabile su quali variabili migliorino la resistenza muscolare. **Ramírez-Campillo et al. 2013**, *J Strength Cond Res* 27(8):2219-2224 — 12 settimane di leg press con una gamba: grasso ridotto in braccia e tronco, **non** nella gamba allenata (il dimagrimento localizzato non funziona). **Paoli et al. 2009**, *J Strength Cond Res* 23(1):246-250 — nello squat la larghezza dei piedi non cambia l'attività di vasto laterale, vasto mediale e adduttore; aumenta solo quella del grande gluteo con la posizione larga. **Martín-Fuentes et al. 2020**, *IJERPH* 17(22) — leg press: vasto mediale obliquo il più attivo a prescindere da larghezza e rotazione dei piedi. **AAFP 2020** (sintesi della linea guida Willy et al. 2019, fonte secondaria) — esercizi per l'anca posteriore e per il quadricipite insieme, ad alto volume. Senza fonte verificata (regole operative): dosi `legStrength`, `legTone`, recupero di `power`, scelta degli esercizi per adduttori e medio gluteo.

### Disegni rivisti, dolore modificabile a seduta chiusa, risultati delle sedute svolte (8.6)
- **Disegni**: rivisti tutti i 139 esercizi attivi, fermi e in movimento. Corretti quelli incongruenti:
  - **burpee**: ora l'animazione segue il gesto vero in sei posizioni (salto con le braccia in alto → accosciata con le mani a terra → plank → petto a terra → plank → accosciata); prima passava in modo innaturale da in piedi al mountain climber;
  - goblet squat (manubrio e kettlebell) e trasporto in abbraccio: peso al petto anche in piedi;
  - lat machine (larga e presa neutra): da seduti, come alla macchina;
  - croci ai cavi: in piedi con un piede avanti, come dice la scheda (prima sdraiato);
  - iperestensioni: sul cuscino della panca, non a terra;
  - vogatore: presa con le ginocchia piegate e il busto avanti, poi finale;
  - camminata veloce e corsa-camminata: passo e corsa veri (prima uno slancio della gamba); trasporto del contadino animato col passo;
  - estensioni sopra la testa al cavo: cavo in basso dietro, non in alto;
  - curl stile Scott: seduto, braccio appoggiato in avanti.
  Campo nuovo `art.motion` (facoltativo): più posizioni chiave per l'animazione; `frames` resta di due per le miniature e per `validateData`.
- **Dolore a freddo**: ginocchio e spalla (0-10) si segnano o correggono anche dopo aver chiuso e salvato la seduta, nella seduta svolta (Oggi e programma della settimana) e in Progressi › Ultime sedute. Sull'ultima seduta del programma il valore vale anche per la prossima (registro `S.painLog`, voce «day»); sulle precedenti resta nello storico delle sensazioni. Nessuna voce del registro viene cancellata.
- **Risultati delle sedute svolte**: in Oggi, se la seduta del giorno è fatta, il riquadro «Allenamento del giorno» apre i suoi risultati (serie, carichi, stelle e motivo, nota, dolore), con il pulsante per la prossima seduta; nel programma della settimana le sedute «svolta» aprono i risultati invece della seduta prevista.
- Scale 0-10 su una sola riga anche su iPhone 12.

### Ultime sedute in cima, «Perché queste stelle», dischi per lato, niente ora (8.5)
- **Progressi**: «Ultime sedute» è la prima sezione (prima era in fondo alla pagina e non si trovava). Toccando una seduta: serie, carichi, stelle e motivo esercizio per esercizio.
- **Riepilogo di fine seduta**: pulsante «Perché queste stelle», che apre lo stesso dettaglio.
- **Bilanciere**: sotto il selettore del carico la composizione per lato con il minor numero di dischi (48 kg = bilanciere + 10 + 5 + 2 + 2 per lato). Se un disco è occupato si sceglie un carico vicino dal selettore.
- **Stelle con obiettivo cambiato**: il confronto è con quanto l'app chiedeva (carico proposto × ripetizioni obiettivo, formula di Epley), anche se il carico usato è diverso: 50 kg × 8 al posto di 48 × 10 proposti vale «in linea». Ricalcolo una tantum (`S.ratingsRev` = 6), tocca solo il giudizio. A obiettivo invariato resta il confronto con la seduta precedente: carico e ripetizioni contano insieme nel massimale stimato.
- **Niente ora a schermo** (regola permanente): tolta dal dettaglio della seduta, dall'avviso di seduta rimasta aperta e dal riquadro «Seduta lasciata a metà» (resta solo nel file CSV esportato).

### Attrezzo aerobico, niente zoom col doppio tocco, programma in seduta, stelle (8.4)
- **Cambio dell'attrezzo aerobico ripristinato ovunque**: «Cambia attrezzo o tipo di lavoro» compare anche per le sedute degli altri giorni della settimana (dalla 7S 6 c'era solo per quella di oggi); scambiando il giorno, la scelta segue la seduta (`swapDay` sposta anche `S.sessPick`). In seduta il pulsante diventa «Cambia attrezzo»: finché nulla è registrato si può cambiare attrezzo e tipo di lavoro (la seduta si ricostruisce), dopo cambia l'attrezzo delle parti ancora da fare. Vogatore e scalini restano sempre selezionabili a mano anche con la priorità al ginocchio (che vale solo per le proposte automatiche): prima «Cambia esercizio» in seduta li nascondeva.
- **Doppio tocco senza zoom**: `touch-action: manipulation` su pagina e pulsanti; lo zoom con due dita resta (viewport senza blocchi, WCAG 1.4.4).
- **«Programma di oggi» a seduta aperta**: l'elenco del giorno con superserie, dosi, note e stato di ogni esercizio; tocco sulla riga = scheda, «Vai» = passa all'esercizio (come scorrere: non registra nulla, il timer continua).
- **Stelle, due incongruenze corrette** (ricalcolo una tantum `S.ratingsRev` = 5, tocca solo il giudizio):
  - obiettivo cambiato dal programma (per esempio curl da 5 a 10 ripetizioni con la 8.3): chi usava il carico proposto dall'app (ricalcolato e arrotondato per difetto) e chiudeva le ripetizioni prendeva 2 stelle «stabile»; ora la prima seduta al nuovo obiettivo non deve progredire e quella prestazione è «in linea» (3);
  - carico alleggerito per il dolore (proposto dall'app o dopo un dolore ≥4 segnato in seduta, campi `painAdj`/`pain`): prendeva 1 stella «calo»; ora è fuori dal confronto (0 stelle, se il risultato sarebbe sotto 3) e non fa da riferimento per la seduta dopo.
  - Invariato e coerente con i criteri: stessa prestazione della settimana prima = 2 stelle (l'attesa è +2,5% a settimana), una ripetizione in più = 3, carico salito con il 2-for-2 = 4-5, meno serie a parità di ripetizioni per serie ≠ calo.

### Programma adattato ai muscoli specifici, superserie, dolore, 45 minuti (8.3)
- **Forza A, B e C riscritte** (solo il programma attivo «Macrociclo → 30 maggio 2027»): i primi quattro slot restano quelli di prima (fondamentali, blocco trazioni, complementari), poi **due superserie fisse per seduta**:
  - **A** · rinforzo gambe (leg extension, leg curl o polpacci) + **obliqui** (Pallof press); **capo lungo del tricipite** (estensioni sopra la testa; con la precauzione spalla → push-down) + **deltoide posteriore**.
  - **B** · panca **inclinata** come primo esercizio (fasci alti del petto); **bicipite** + **tricipite**; **addome** + **avambracci** (flessioni o estensioni dei polsi).
  - **C** · polpacci o alzate laterali + **brachiale e brachioradiale** (hammer curl, curl a presa prona); **addome/obliqui** + **trapezio superiore** (scrollate).
- Nuovo campo `focus` negli esercizi e negli slot (`focus`, `fallback`, `loose`, `ss` in programs.json): lo slot chiede un muscolo, non uno schema; precauzioni rigide negli slot mirati (nessun esercizio a rischio come ripiego); i muscoli con uno slot dedicato non occupano gli slot generici (il rematore resta rematore). «Cambia esercizio» propone esercizi per lo stesso muscolo.
- **Esercizi nuovi**: estensioni sopra la testa al cavo, curl stile Scott sullo schienale inclinato, curl a presa prona (bilanciere EZ e manubri leggeri), flessioni ed estensioni dei polsi (palestra e casa), scrollate con manubri e con band. Pose nuove: `shrugUp`, `wristCurlDown`, `wristCurlUp`.
- **Superserie del programma a qualunque durata** (prima solo a 35′, automatiche): una serie del primo, 20 s per spostarsi, una serie del secondo, poi il recupero; il timer alterna da solo. Riquadro con le istruzioni in seduta e intestazione «Superserie N» nell'elenco del giorno. Solo esercizi a ripetizioni (con le tenute a tempo la sequenza andrebbe tutta di fila). Se il secondo finisce prima, si torna al primo.
- **Tagli e aggiunte**: fra i complementari si accorcia prima quello con più serie; con tempo in avanzo i complementari tornano alle serie previste prima di allungare petto e gambe.
- **Muscoli specifici** in Progressi e nel riepilogo settimanale: serie fatte/previste per petto alto, tricipite (capo lungo e totale), bicipite, brachiale, avambracci, deltoide posteriore, trapezio superiore, obliqui, retto dell'addome. Nessuna soglia: le 10 serie ACSM valgono per gruppo.
- **Dolore e fastidio** (spalla, ginocchio, 0-10) in tre momenti: pulsante in seduta, sensazioni di fine seduta (precompilate con il valore segnato in seduta), riquadro «Ginocchio e spalla» in Allenamento del giorno. Effetti (regole operative dell'app): 4-6 → serie rimanenti −10% o un gradino più facile, lo stesso esercizio parte più leggero la volta dopo; ≥7 → finestra «fermati» (cambia, chiudi, escludi per 2 settimane), resto della seduta più leggero sul distretto, seduta successiva con esercizi più tollerabili (precauzioni temporanee) e −10%; ≥5 a fine seduta o da Oggi → −10% sul distretto nella seduta dopo; un valore più basso segnato da Oggi spegne le precauzioni temporanee. Registro `S.painLog`, mai cancellato; il dolore resta anche sulla registrazione dell'esercizio.
- **Durata predefinita 45 minuti** (migrazione una tantum per chi aveva 35). Scegliendo meno di 45 l'app confronta la seduta con quella da 45 e, se si perdono esercizi o serie, avvisa con l'elenco; la decisione resta all'utente («Resto a 45» / «Scelgo comunque»).

Fonti aperte e lette: Maeo, Isaka, Sugiyama, Wu, Huang, Kusagawa, Sakurai, Kanehisa, *Eur J Sport Sci*, doi 10.1080/17461391.2022.2100279 (estensioni sopra la testa: tricipite cresciuto circa 1,4 volte più che con il push-down); Chaves et al. 2020, *Int J Exerc Sci* 13(6):859-872 (panca inclinata: più spessore del petto solo al secondo spazio intercostale, cioè la parte alta; forza simile); Zabaleta-Korta et al. 2023, *J Hum Kinet* 88:259-270 (curl alla panca Scott: crescita significativa nella parte distale del bicipite; curl inclinato senza crescita significativa; campione piccolo); Date et al. 2021, *Front Physiol* 12:809422 (attivazione del brachiale simile con le diverse posizioni dell'avambraccio, n = 6: l'hammer curl non «isola» il brachiale); Zhang et al. 2025, *Sports Med* (superserie); Desmeules et al. 2025 ed Esculier et al. 2018 per il dolore (adattare alla tolleranza; 2/10 nella corsa). **Senza fonte verificata** (regole operative dell'app): soglie del dolore 4/5/7, −10%, esclusione di 2 settimane, lavoro diretto su avambracci e trapezio superiore, Scott sullo schienale inclinato al posto della panca Scott, 45 minuti come durata del programma.

### Intro intera a ogni avvio (8.2)

Su richiesta dell'utente l'intro si sviluppa per intero (animazione completa del logo, percorso, frase) **a ogni avvio**, non solo al primo della giornata, e resta finché non la tocchi. La versione breve introdotta nella 8 è stata tolta. Restano le correzioni della 8.1 (nessuna chiusura automatica, aggiornamento che aspetta la chiusura dell'intro).

### Intro leggibile (8.1)

- L'intro (logo animato, percorso, frase del giorno) **resta a schermo finché non la tocchi**, sempre. Nella 8 dalla seconda apertura del giorno si chiudeva da sola dopo meno di un secondo, e un aggiornamento automatico poteva ricaricare la pagina proprio mentre la leggevi.
- Dalla seconda apertura del giorno è solo più breve: compare già completa, senza i 3 secondi di animazione. L'apertura del giorno si conta al tocco, non al caricamento.
- L'aggiornamento automatico aspetta che l'intro sia chiusa.

### Versione 8: seduta, progressi, salute, Spartan, usabilità, estetica, dati

**Seduta**
- **Avvicinamento guidato** sul primo esercizio fondamentale con carico: 50% × 8 e 75% × 4 del carico proposto (con la forza anche 85% × 2), carichi già arrotondati all'attrezzo; «Fatta» avvia un breve recupero. Non si registra; il tempo era già nella stima. Regola operativa dell'app.
- **Carico per serie**: la serie successiva riparte dal carico dell'ultima (anche se lo correggi toccando la riga della serie); la scritta lo ricorda.
- **Recupero adattivo**: +30 s dopo una serie con 0 ripetizioni di riserva, -15 s con 3 o più (mai sotto 30 s). La riserva ora si indica serie per serie. Regola operativa, coerente con Singer et al. 2024.
- **Superserie a 35 minuti** fra complementari di gruppi diversi, di preferenza antagonisti (spinta + tirata, gambe + parte alta): serie alternate, 20 s per spostarsi, un recupero per giro; fondamentali e blocco trazioni restano a recupero pieno; il tempo risparmiato va ai supplementari. Fonte: Zhang, Weakley, Li, Li, García-Ramos 2025, *Sports Med*, doi 10.1007/s40279-025-02176-8 (stesso volume in meno tempo, nessuna differenza su forza e ipertrofia; le superserie agonista-antagonista mantengono il volume, quelle sullo stesso muscolo lo riducono; più faticose).
- **«Macchina occupata: passa a un altro»**: l'esercizio va in fondo e si passa al successivo ancora da fare che, se possibile, lavora un gruppo diverso da quello appena concluso.
- **Schermo da palestra** (Programma, attivo di default): ripetizioni, carico, serie e timer molto più grandi.

**Progressi**
- **Riepilogo della settimana** automatico la domenica alla prima apertura (e sempre in Progressi): serie per gruppo, stelle medie, minuti aerobici, trazioni e traguardi Spartan, misure, sensazioni e una frase su cosa migliorare (`weekAdvice`).
- **Record personali**: massimale stimato, ripetizioni al livello, secondi di tenuta; annuncio in seduta e elenco in Progressi. Fuori dalla settimana di scarico.
- **Massimale stimato** dei fondamentali con linea di tendenza e variazione ogni 4 settimane.
- **Durata reale contro stimata** per durata scelta (la stima ora si salva a fine seduta).
- **Sensazioni a fine seduta**: energia e sonno da 1 a 5, ginocchio e spalla da 0 a 10, facoltativi; confronto fra stelle dopo notti corte e buone.

**Ginocchio e spalla**
- **Diario del dolore**: se ginocchio o spalla salgono per due sedute di fila (tre valori in crescita), l'app propone circa -10% di carico (o un gradino più facile, o più assistenza) sugli esercizi collegati — ginocchio: squat, affondi, leg extension; spalla: spinte, alzate, tirate — finché il dolore non smette di salire, e lo segnala in Progressi e nel riepilogo. Regola operativa, nello spirito di Willy 2019 e Desmeules 2025 (esercizio adattato alla tolleranza).
- **«Mi dà fastidio»** dalla scheda dell'esercizio: fuori dalle proposte per 4 settimane, sostituito subito con l'alternativa più simile; elenco e «Riattiva» in Programma.
- **Fisioterapista**: data dell'ultima valutazione in Programma; togliere le spunte di ginocchio o spalla (che sbloccano burpee con salto e muscle-up) chiede prima conferma ricordando la data.

**Spartan Race**
- **Simulazione** da marzo 2027, nella seconda settimana di ogni blocco: dopo la corsa-camminata, 30 burpees al proprio livello, sospensione lunga e trasporto in fila. Non fa salire il livello della corsa.
- **Conto alla rovescia** nell'intro: «N settimane alla Spartan».

**Usabilità**
- **Catalogo**: filtri per attrezzo (manubri, bilanciere, macchine e cavi, kettlebell, elastici, sbarra e parallele, attrezzi aerobici, corpo libero), luogo (palestra, casa, tutti) e «solo esercizi che rispettano il ginocchio»; la ricerca trova anche i muscoli.
- **Annulla** per 10 secondi dopo «Salta», «Segna come svolta» e «Seleziona»: toglie solo ciò che l'azione aveva appena aggiunto.
- **«Torna a Oggi»** anche in fondo alle schermate che lo hanno in alto.

**Estetica**
- **Tema chiaro** facoltativo (o come l'iPhone), per l'uso all'aperto.
- **Figure animate** fra posizione iniziale e finale, in seduta e nella scheda, con le parti che lavorano in arancio (anche nelle figure ferme).
- **Celebrazioni graduate**: festa piccola per la seduta, grande con coriandoli per record, settimana completa, prima trazione e traguardi Spartan.
- **Icona**: l'icona arancio con bilanciere e «50» provata nella prima uscita della versione 8 è stata tolta su richiesta dell'utente; restano l'icona e le schermate di avvio originali (anello arancio e barre che crescono), ripristinate dai file del suo backup. **Intro breve** dalla seconda apertura della giornata.

**Dati**
- **Backup del fine settimana**: sabato e domenica, se l'ultimo ha più di 5 giorni, Oggi propone «Salva in File» nella cartella iCloud Drive › cm › Allenamenti › palestra50 (iOS ricorda l'ultima cartella; una PWA non può salvare senza quel tocco). Il file contiene data e versione.
- **Ripristino guidato**: prima di sostituire i dati mostra date, sedute, esercizi e misure del backup a confronto con il telefono, avvisa se è più vecchio, conserva una copia di sicurezza e permette «Annulla il ripristino».

Fonte aperta e letta il 22 ottobre 2026: Zhang X, Weakley J, Li H, Li Z, García-Ramos A. 2025, *Sports Medicine*, doi 10.1007/s40279-025-02176-8 (sintesi del deposito istituzionale; titolo completo non riportato nella pagina letta).

### Oggi in tre sezioni (7S 6)

- **Oggi** mostra tre riquadri: **Mobilità breve**, **Allenamento del giorno** (titolo e breve descrizione della seduta), **Programma della settimana**. Promemoria Spartan e domanda sul ginocchio stanno sotto i tre riquadri.
- **Allenamento del giorno** apre la scheda della seduta: titolo, descrizione, Palestra/Casa, durata, esercizi con dose e carico proposto (come prima) e i comandi **Inizia la sessione**, **Non la faccio: salta**, **L'ho già fatta: segna come svolta**. Il calendario della settimana non c'è più qui.
- **Programma della settimana**: dove sei nel programma e scopo della fase, poi soltanto le sedute dei giorni della settimana. Le svolte sono evidenziate (✓, bordo verde), quella di oggi in arancio; «Seleziona» sposta una seduta a oggi (stesso scambio di prima, `swapDay`); in fondo **Solo blocco core** e **Seduta libera**. Toccare una seduta apre la sua scheda «Allenamento del giorno»; se è di un altro giorno, avviarla, saltarla o segnarla la porta prima a oggi. Le sedute già svolte si aprono in sola lettura.
- Tolta l'anteprima a finestra della 7S 4, sostituita dalla scheda del giorno.

### Programma della settimana da Oggi; conteggio dei burpees corretto (7S 5)

- In Oggi, sotto le due sedute del giorno, il pulsante **«Programma della settimana ›»** apre «La tua settimana» (sedute con anteprima e «Seleziona»).
- **Burpees nei traguardi Spartan: errore corretto.** Il contatore considerava solo le serie al livello che l'app stessa avrebbe proposto (con la priorità al ginocchio, «A passi, senza petto a terra»): 10 burpees regolamentari risultavano 0. Ora una serie a un livello più difficile vale anche per quelli più facili, e se nelle ultime sei settimane hai scelto tu un livello più alto l'app resta su quello (dosi al 60-70% del massimo a quel livello). Il contatore resta «di fila»: conta la serie migliore, non il totale della seduta.
- Burpees e sospensione registrati in **settimana di scarico** ora si vedono nei traguardi Spartan, segnalati come tali; per la regola della 6.8 restano fuori da dosi, livelli e obiettivi dei check.

### Anteprima delle sedute, aggiornamento automatico, pop-up e scorrimento (7S 4)

- **«La tua settimana»**: toccare una seduta non la sceglie più per oggi. Apre una schermata con gli esercizi previsti (dose e, dove c'è un carico, quello proposto con l'ultima seduta), che si chiude con «‹ Torna alla settimana» o «Chiudi» (`openDayPreview`). Per scegliere la seduta c'è il pulsante **«Seleziona»** su ogni riga (e in fondo all'anteprima); lo scambio dentro la settimana funziona come prima (`swapDay`). Anche il blocco core ha il suo «Seleziona».
- **Scorrimento fra gli esercizi invertito** (richiesta dell'utente): pollice da destra a sinistra = esercizio successivo, da sinistra a destra = precedente, come si sfogliano le pagine su iPhone e coerente con la scritta «‹ precedente · successivo ›». Anche il movimento della schermata segue il pollice.
- **Niente più pulsante «Aggiornamento pronto».** Con la rete i file arrivano già nuovi da GitHub; restava in attesa solo il service worker nuovo (quello che tiene la copia per l'uso senza rete). Ora la pagina lo attiva da sola (`tryApplyUpdate`) appena non c'è una seduta in corso né una scheda aperta: a metà seduta aspetta la fine, poi l'app si ricarica una volta da sola.
- **Pop-up alla prima apertura dopo un aggiornamento** (`showUpdatedPopup`): «App aggiornata alla versione …!», con coriandoli. La versione si legge dall'intro scritta da `version.sh`; ricompare solo con la versione successiva (`S.seenVersion`, salvata quando tocchi «Andiamo!»). Alla prima installazione non compare.

### Equipaggiamento: ripristinato com'era (7S 3)

La 7S 2 aveva spostato la scelta Palestra / Casa dentro la scheda della seduta, sopra gli esercizi. Su indicazione dell'utente («era più logica e performava meglio») la 7S 3 torna esattamente alla 7S 1: selettore in cima alla pagina dell'allenamento del giorno.

### Carico commisurato alle ripetizioni; revisione prima di chiudere (7S 1)

- **Carico proposto secondo le ripetizioni di oggi** (`convertedLoad`). Quando le ripetizioni previste differiscono di almeno 2 da quelle dell'ultima seduta vera (fuori scarico, non segnata come fatta, con un carico annotato), il carico non resta uguale: si stima il massimale dall'ultima seduta contando le ripetizioni in riserva annotate (formula di Epley, la stessa del massimale stimato nei grafici; riserva secondo la scala di Zourdos et al. 2016) e si ricava il carico per le ripetizioni di oggi con la riserva prevista dall'obiettivo (RPE 7-8 → circa 2,5; RPE 8 → 2; RPE 7 → 3). Esempio: 3×15 a 52,5 kg con 2 di riserva → 3×6 con 2 di riserva ≈ 64,9 kg → **62,5 kg**. Si arrotonda sempre **per difetto** al carico disponibile, perché la relazione fra ripetizioni e percentuale del massimale varia molto fra persone ed esercizi (Nuzzo et al. 2024, *Sports Med* 54(2):303-321: alla stessa percentuale nella leg press si fanno più ripetizioni che nella panca; età e livello di allenamento non cambiano chiaramente la relazione). La prima serie fa da verifica e il consiglio lo dice. Con «troppo pesante» l'ultima volta si toglie un 5%; in settimana di scarico il carico non sale mai. Con ripetizioni simili resta la regola 2-for-2. Formula e arrotondamento: regola operativa dell'app.
- Il carico proposto compare nella seduta («Proposto oggi: … kg per 3×6») e nell'elenco di Oggi, **insieme all'ultima seduta** (carico, serie e ripetizioni). L'avviso di salto troppo ampio confronta con il carico ricalcolato, non con quello della volta scorsa.
- **Revisione prima di chiudere** (`finishReview`). Chiusa l'ultima serie della giornata, la seduta non finisce subito: resta aperta con le serie registrate, che si correggono toccando la riga (✎), il pulsante della nota dell'esercizio e la possibilità di scorrere agli altri esercizi. «Chiudi la seduta» apre la schermata di fine allenamento (con la nota della seduta). Le correzioni riscrivono lo stesso record nello storico, senza doppioni; la revisione sopravvive alla chiusura dell'app.
- Corretto anche: correggere una serie di un esercizio già concluso, tornandoci sopra, non aggiornava lo storico.

Fonte aperta e letta il 20 ottobre 2026: Nuzzo, Pinto, Nosaka, Steele 2024, *Sports Med* 54(2):303-321, doi 10.1007/s40279-023-01937-7 (meta-regressione su ripetizioni massime alle diverse percentuali del massimale).

### Preparazione Spartan Race Sprint di Orte (7S 0)

Richiesta dell'utente (19 ottobre 2026): arrivare preparato alla **Spartan Race Sprint di Orte del 24-25 aprile 2027** (5 km, 20 ostacoli). Obiettivo: divertirsi e superare gli ostacoli in sicurezza, con forma corretta e disinvoltura; tempo e velocità non contano. Il **giavellotto non si tenta**: al suo posto si fanno i 30 burpees. **Forza A, B e C restano com'erano.** Interruttore «Preparazione Spartan Race» in Programma (acceso di default).

- **Seduta a intervalli** (`spartanBlock`): subito dopo il riscaldamento, a fresco, **burpees** per livelli (a passi senza petto a terra → a passi con petto a terra → regolamentare con salto), **sospensione alla sbarra** e, dal 7 dicembre 2026, un **trasporto** (del contadino o in abbraccio, a settimane alterne). Poi gli scatti nel tempo che resta; se il tempo non basta per 4 scatti si accorciano prima i trasporti, poi la sospensione, poi i burpees (mai sotto 2 serie, mai i check). Burpees al 60-70% del massimo di fila, sospensione al 60% del massimo. Livelli dei burpees: si passa con 15 di fila al primo e 20 al secondo; il livello con il salto resta chiuso finché è attiva la priorità al ginocchio.
- **Corsa-camminata** (`buildRun`): dal **7 dicembre 2026** la seduta a ritmo costante diventa corsa-camminata all'aperto, **una volta a settimana**. Ho anticipato di quattro settimane il «da gennaio» proposto dall'utente: con 19 settimane invece di 15 c'è margine per ripetere un livello ogni volta che il ginocchio lo chiede. Dieci livelli, da 6 × 1′ di corsa e 2′ di camminata a 4 × 8′ di corsa e 2′ di camminata (circa 5 km per chi corre piano); il tempo che avanza diventa camminata svelta. **Il livello sale solo** dopo una corsa completa, fuori da scarico e settimana della gara, con il ginocchio tranquillo il giorno dopo; resta fermo se ha dato fastidio; **scende** se la mattina dopo andava peggio (registro `S.spartanRuns`, domanda in Oggi il giorno dopo, distanza dal Garmin facoltativa). Criteri da Esculier et al. 2018: dolore entro 2/10 durante la corsa, ritorno al livello di partenza entro un'ora, nessun aumento la mattina dopo; prima la distanza, poi velocità e salite. «Cambia attrezzo» riporta la bici quando serve.
- **Spartan Race check** nella prima settimana di ogni blocco, dopo lo scarico: trazioni (è il test di Forza A che c'era già), burpees e sospensione (seduta a intervalli), corsa-camminata (dal blocco dopo il 7 dicembre). Ogni check ha un obiettivo intermedio: il traguardo per la gara diviso in parti uguali fra i check rimasti. Promemoria in Oggi («Oggi» o «Nella prossima seduta»), badge in «Le prossime settimane», calendario completo in Progressi.
- **Traguardi per la gara** (regole operative dell'app): 8 trazioni pulite di fila (l'obiettivo del programma resta 15 a fine maggio), 60 s di sospensione, 30 burpees di fila in forma corretta, corsa-camminata all'ultimo livello senza fastidio il giorno dopo.
- **Settimana di scarico**: blocco e corsa più corti, nessun trasporto, nessun aumento di livello. **Settimana della gara**: tutto leggero, nessun check. **Dopo la gara** il piano torna esattamente com'era.
- **Progressi › Spartan Race**: settimane alla gara, i quattro traguardi, prossimo check; nella scheda anche il calendario dei check, gli ostacoli con il loro stato (pronto, quasi, in corso), le corse registrate e l'aggiornamento a mano di sospensione e burpees (`S.spSelf`).
- Le serie del blocco Spartan (`spartan: true` nella registrazione) e gli esercizi `noVolume` **non contano nel volume dei gruppi muscolari**: sono condizionamento. Check dei burpees e della sospensione confrontati solo con altri check; la corsa non ha stelle.
- Regola 4 aggiornata su richiesta dell'utente: la corsa resta esclusa dal programma generale; c'è solo come preparazione alla Spartan, una volta a settimana, guidata dal ginocchio.
- Corretto anche: i gradini lunghi (burpees, trazioni) allargavano la schermata della seduta oltre lo schermo; l'intestazione delle sedute aerobiche mostrava il testo della mobilità.

Fonti aperte e lette il 19 ottobre 2026: pagina ufficiale della gara (Spartan Race – Rome, Orte Spartan Weekend 2027); guida Spartan agli ostacoli («Instructions and Training Tips for Every Spartan Race Obstacle»); Spartan Editors 2025, «5 Common Mistakes to Avoid When Doing Burpees» (petto a terra, salto con talloni e punte sollevati, mani sopra le orecchie; 30 burpees per ostacolo fallito nelle Sprint); Esculier et al. 2018, *Br J Sports Med* 52(10):659-666 (testo integrale, sezione Metodi); Willy et al. 2019, *JOSPT* 49(9) (sintesi ufficiale); Schumann et al. 2022, *Sports Med* 52(3). Livelli, soglie e dosi sono regole operative dell'app.

### Attività extra tolta (6.12)

La 6.11 aveva aggiunto la registrazione manuale di attività fuori programma (per esempio una pedalata in mountain bike). Su indicazione dell'utente la funzione è stata tolta e la 6.12 riparte dalla 6.10. Unica traccia rimasta: le eventuali registrazioni fatte con la 6.11 (tipo `extra`) restano nello storico, perché nessun dato si cancella, ma non contano come sedute del programma (`isProgramKind`).

### Mobilità in qualunque giorno; prossimo esercizio in seduta (6.10)

- **Mobilità spostabile.** La seduta di mobilità resta **preimpostata come ultima** della settimana da 6, ma dal calendario di *Oggi* si può scegliere in qualunque giorno, anche prima delle altre sedute: funziona come lo scambio delle altre sedute (quella prevista oggi prende il suo posto più avanti nella settimana). La settimana successiva riparte con l'ordine predefinito. Tolto il blocco «La mobilità chiude la settimana».
- **La mobilità breve a casa si sposta con lei** (`morningAvail`, `morningDaysOf`): nella settimana da 6 c'è nei cinque giorni che non hanno la seduta di mobilità, dovunque cada (prima era legata ai giorni 1-5 per posizione). Nelle settimane vecchie da 5 sedute e in quelle di sola mobilità restano i giorni 1-5.
- **Prossimo esercizio.** Nella schermata dell'esercizio in corso, sotto le barre di avanzamento, una riga dice «Esercizio N di M · Prossimo: *nome* *dose*», secondo l'ordine della seduta e saltando quelli già completati; se resta solo un esercizio rimandato più indietro, «Poi torni a: … · rimasto da fare»; sull'ultimo, «ultimo esercizio della seduta».

### Progressione azzerata: si riparte dopo lo scarico (6.9)

Su richiesta, tutti i conteggi della progressione sono stati **azzerati** e ripartono dalla **prima seduta dopo la settimana di scarico** (`S.progressEpoch`, fissato una volta all'aggiornamento: la settimana che segue lo scarico più recente, o il prossimo se non ce n'è ancora stato uno). Nessuna registrazione è stata cancellata.

- **Prima della ripartenza**: le registrazioni restano nello storico ma non entrano nei conteggi — niente stelle, niente punti nella linea dei carichi, nel grafico di dettaglio e nella tendenza, nessuna seduta valida per la regola 2-for-2.
- **Riferimento di partenza** (`epochBaseline`): per ogni esercizio, l'ultima seduta reale prima dello scarico. Da lì partono il carico suggerito, il confronto (e le stelle) della prima seduta dopo la ripartenza e il primo punto della linea; nello storico è indicata come «riferimento di partenza».
- **Regola 2-for-2**: la serie di sedute sopra l'obiettivo riparte da zero; per aumentare il carico servono due sedute dopo la ripartenza.
- **Tenute**: i secondi già guadagnati restano (sono il punto di partenza); il conteggio delle coppie di sedute con margine riparte da zero.
- **Massimo di trazioni e muscle-up**: resta come riferimento; il test della prima settimana dopo lo scarico lo aggiorna.
- **Non cambiano**: volume settimanale, minuti aerobici, sedute svolte, posizione nel programma, riepiloghi delle settimane passate (senza stelle).

In *Progressi* (riquadro «Progressione negli esercizi») e nello storico una nota dice da quale settimana conta la progressione.

### Settimana di scarico fuori dalla progressione (6.8)

Le prestazioni della settimana di scarico **restano nello storico** (nessuna registrazione si cancella) ma **non entrano più nei dati della progressione**:

- **niente stelle**: la registrazione dice «Settimana di scarico: registrata nello storico, non entra nei dati della progressione»; se il carico è salito invece di restare fermo, l'avviso resta;
- **mai riferimento** per il confronto: la prima seduta dopo lo scarico si confronta con l'ultima seduta normale;
- **carico suggerito e regola 2-for-2** leggono solo le sedute normali (`lastEntry`, `lastEntries`): l'aumento guadagnato prima dello scarico scatta alla ripresa, senza che le ripetizioni ridotte dello scarico lo annullino;
- **tenute** (allungamento di 5 s con il margine): il margine dichiarato in scarico non conta;
- **grafici, linea dei carichi e tendenza degli esercizi**: le registrazioni di scarico non compaiono; nel dettaglio dell'esercizio restano elencate con la nota «scarico, fuori dalla progressione»;
- **massimo di trazioni e muscle-up**: le serie dello scarico non lo aggiornano. Per questo il **test** è stato spostato dalla settimana di scarico alla **prima settimana di ogni blocco**, subito dopo lo scarico (e nella prima settimana del programma): Forza A per le trazioni, Forza B per i muscle-up;
- restano invece nei conteggi che non misurano la progressione: volume della settimana, minuti aerobici, sedute svolte, calibrazione della durata.

La fascia rossa e il riquadro della settimana di scarico lo spiegano. All'aggiornamento le stelle dello storico vengono ricalcolate una volta con questa regola; nessun altro dato cambia.

### Senza «Mattino» e «Pranzo»; «Come cambia il programma» (6.7)

- **Niente diciture legate all'ora del giorno.** La sessione breve a casa si chiama **Mobilità breve** (riquadro «Mobilità breve · a casa»), la seduta principale **Allenamento del giorno**. Cambiati tutti i testi a schermo (riquadri di Oggi, schermata della mobilità breve, conferme, chiusura di una seduta rimasta aperta, intestazione della seduta). Le sedute già registrate come «Mattino · giorno N» restano com'erano nel registro e vengono mostrate come «Mobilità breve · giorno N» (`sessLabel`).
- **Obiettivo muscle-up: 2** (prima 10); 15 trazioni pulite confermate. Le tappe del blocco trazioni non cambiano.
- **«Le prossime settimane» spiega come cambia il programma** (`cyclesHtml`), prima del calendario settimana per settimana:
  - *per calendario*: le fasi del macrociclo con settimane, obiettivo di Forza A, B e C e scopo (fase attuale evidenziata), con ripetizioni e recuperi di ogni obiettivo; il blocco di 4 settimane (adattamento, costruzione, picco, scarico) con che cosa cambia in ciascuna; rotazione degli esercizi a ogni blocco; progressione degli intervalli con le settimane di allenamento (e lo schema attuale); alternanza degli schemi di mobilità;
  - *secondo i risultati*: carichi con la regola 2-for-2 (fermi in scarico), tappe di trazioni e muscle-up con la tappa attuale e la successiva, supplementari per i gruppi sotto 10 serie, tenute che si allungano con il margine, durata scelta ogni giorno;
  - *che cosa sposta il calendario*: settimane di sola mobilità, sedute saltate, scambio di sedute (la mobilità resta l'ultima).
  Il testo è generato dai dati del programma attivo (fasi, obiettivi, profilo del blocco, soglie degli intervalli), quindi resta allineato a quello che l'app fa.

### Aerobico nello storico: fasi, non prestazioni (6.6)

Una seduta aerobica registra lo stesso attrezzo tre volte: riscaldamento (5 minuti facili), parte centrale (intervalli o ritmo costante) e defaticamento (3 minuti). Lo storico le trattava come tre prestazioni successive dello stesso esercizio: nei *Carichi per esercizio* la bici da spinning aveva una linea che saliva (riscaldamento → parte centrale) e poi scendeva (→ defaticamento), con «3 sedute» dopo una seduta sola, e fino alla 6.4 una stella diversa per ogni fase. Intensità e durata le decide il programma e non c'era nulla di precedente da confrontare: il giudizio era senza senso.

- **Carichi per esercizio** contiene solo gli esercizi con una prestazione da misurare (pesi, corpo libero, core). Le sedute segnate come fatte alle dosi previste non entrano nella linea.
- **Aerobico e allungamenti** è un elenco a parte: numero di sedute, data e minuti dell'ultima seduta, senza linea di andamento e senza stelle. Il dettaglio mostra le sedute una per una con le loro fasi («Riscaldamento 5′ · Intervalli 8× 30″ / 90″ · Defaticamento 3′»).
- **Sedute contate come sedute**, non come registrazioni (`sessionsCount`), anche per gli esercizi di forza.
- La **scheda esercizio** dell'aerobico mostra l'ultima seduta con le sue fasi invece di carico, ripetizioni e stelle; nel catalogo «ultima seduta» invece di «ultima volta —».
- La **tendenza degli esercizi** in *Progressi* conta solo registrazioni valutabili (niente aerobico, allungamenti, sedute segnate come fatte).
- Corretti i nomi degli obiettivi aerobici esclusi dalla valutazione (`cardioWarm`, `cardioCool`, `cardioHiit`, `cardioSteady`): nella 6.5 la lista usava nomi inesistenti e l'esclusione reggeva solo grazie al controllo sull'attrezzo.
- I minuti aerobici della settimana (OMS) restano nel riquadro *Attività aerobica*, come prima.

### Stelle: verifica di congruenza (6.5)

Le stelle sono un giudizio dell'app, ricalcolato. Una verifica su casi costruiti — stessa prestazione o prestazione migliore, che devono dare un giudizio coerente — ha trovato otto incongruenze, ora corrette:

| Caso | Prima | Ora |
|---|---|---|
| Stesse ripetizioni per serie, ma 2 serie (35′) dopo 4 (50′) | 1-2★ «calo del 33%» | confronto **per serie**: il numero di serie lo decide il programma |
| Settimana di scarico: stesso carico, ripetizioni ridotte come previsto | 1★ «calo» | 3★ «riduzione in linea con lo scarico»; salire di carico o di gradino resta segnalato |
| Prima seduta dopo lo scarico | confronto con lo scarico, progresso gonfiato (5★) | confronto con l'ultima seduta normale; le settimane di scarico non contano nel progresso atteso |
| Seduta segnata come fatta alle dosi previste | stelle calcolate su numeri non reali | nessuna stella, e non fa da riferimento per le successive |
| Aerobico e finale metabolico | stelle sulla durata, decisa dal programma | nessuna stella (come allungamenti e mobilità) |
| Test di trazioni e serie pulite | confrontati fra loro (5×1 dopo un test da 3 = 4★) | test con test, serie con serie |
| Cambio di tappa (da trazioni con band a serie pulite) | «salto di due livelli» | 5★ «gradino più difficile con il nuovo obiettivo del programma» |
| Fascia delle 4 stelle con +5% atteso (due settimane) | inesistente: da 3★ si passava a 5★ | segue l'atteso: fino a +5 punti sopra l'atteso |

Inoltre: stesso gradino su esercizi a corpo libero o con band ora usa la stessa regola degli esercizi a carico (con l'attesa di +2,5% a settimana), invece di un giudizio fisso a 3 stelle; un piccolo calo nella stessa settimana non viene più descritto come «atteso +0%». Tutti i punti che assegnano stelle — seduta dal vivo, seduta segnata come fatta, esercizio aggiunto a mano, ricalcolo dello storico — passano ora da una sola funzione (`rateFor`), con lo stesso riferimento e lo stesso riconoscimento dello scarico; aggiungendo a mano una registrazione nel passato, le stelle delle successive dello stesso esercizio si ricalcolano. All'aggiornamento le stelle dello storico vengono **ricalcolate una volta** con le regole nuove: nessun'altra informazione viene toccata, nessuna registrazione si perde.

### Valutazione a stelle: metriche confrontabili (corretto nella 5.8)

Un difetto: per ogni registrazione l'app sceglieva la metrica "migliore" disponibile — massimale stimato se calcolabile, altrimenti volume. Sopra le 15 ripetizioni il massimale stimato non è più attendibile e non veniva calcolato, così il *volume* della seduta nuova finiva confrontato con il *massimale* della precedente: grandezze di scala diversa, e una seduta migliorata poteva prendere una stella sola.

Ora il confronto avviene sempre sulla stessa grandezza, scelta fra le due registrazioni: massimale stimato se calcolabile per entrambe, altrimenti lavoro totale (carico × serie × ripetizioni, o merito × volume sugli esercizi assistiti), altrimenti volume semplice; per gli esercizi a tempo contano i secondi tenuti. Se l'obiettivo è cambiato rispetto alla volta scorsa (per esempio da resistenza a forza) il messaggio lo dice. Lo stesso criterio vale per i grafici e per la tendenza in *Progressi*, che prima potevano mescolare le due scale.

Le stelle già assegnate con la vecchia regola vengono **ricalcolate una volta** all'aggiornamento: sono un giudizio prodotto dall'app, non un dato inserito da te, e nessun'altra informazione viene toccata.

### Sedute saltate (dalla 5.7)

Quando una seduta non si fa e non la si vuole recuperare, si dichiara saltata invece di lasciarla in sospeso:
- in **Oggi**, il pulsante *Non la faccio: salta*;
- durante la seduta, *Interrompi* ora chiede cosa farne: *La riprendo più tardi* (resta quella di oggi, con il banner «Riprendi») oppure *Non la faccio: salta e vai alla prossima*;
- per la mobilità del mattino, *Non la faccio: salta*, che segna il pallino della giornata con un trattino.

La seduta saltata resta nello storico con l'etichetta *saltata* e il programma avanza a quella successiva, così l'indice non si disallinea (una seduta saltata ha comunque consumato il suo posto in calendario). Nulla viene registrato come svolto: nel volume settimanale quella seduta continua a risultare mancante, e il riepilogo aggiunge quante ne hai saltate volontariamente. Saltare la mobilità del mattino non sposta il programma, perché le mattine non fanno avanzare le sedute di pranzo.

### Sedute non chiuse (corretto nella 5.5)

Un difetto della 5.3-5.4: premendo *Chiudi seduta* la conferma si chiudeva e, nei 200 millisecondi della sua dissolvenza, spegneva anche il riepilogo che si stava aprendo. Restavi sulla schermata della sessione senza riepilogo e senza barra di navigazione, e l'unico modo di uscire era chiudere l'app — con la seduta che risultava non svolta.

Tre correzioni: l'apertura di un modale annulla la dissolvenza di quello precedente; il riepilogo di fine seduta si ripropone da solo se per qualunque motivo sparisce; quando la seduta è conclusa la barra di navigazione torna disponibile, così non si resta mai chiusi dentro.

In più, all'avvio l'app riconosce le **sedute rimaste aperte** (esercizi registrati senza che la seduta sia stata chiusa) e propone di registrarle, completando gli esercizi mancanti alle dosi previste. Nulla viene cancellato: si aggiunge solo ciò che manca.

### Scorrere fra gli esercizi (dalla 5.3)

Durante la seduta si passa da un esercizio all'altro **scorrendo lo schermo**: dito verso **sinistra** per il successivo, verso **destra** per il precedente (invertito su richiesta dell'utente nella 7S 4). È solo consultazione: non registra nulla e **non ferma il timer**. Una sequenza di tenute continua a contare sull'esercizio da cui è partita anche se nel frattempo guardi un'altra schermata; se si completa mentre sei altrove, l'esercizio viene registrato senza spostarti.

Il pulsante *Chiudi esercizio* registra l'esercizio così com'è e porta al successivo **ancora aperto**: se scorrendo ne hai lasciato indietro uno, l'app ci torna prima di chiudere la seduta. *Chiudi seduta* compare quando non restano esercizi aperti. Il vecchio pulsante *‹ Precedente* non c'è più.

### Mobilità del mattino (dalla 5.1)

Porzione a sé stante, in cima alla schermata Oggi: **cinque sessioni brevi al mattino**, nei giorni 1-5 della settimana, in aggiunta alle sedute di **pranzo** del programma. Il sesto giorno c'è solo la mobilità a pranzo. Durata a scelta: **10 o 15 minuti**.

- **Cosa contiene.** Prima mobilità dinamica (2 esercizi a 10 minuti, 3 a 15) per "svegliare" le articolazioni, poi allungamenti statici sui distretti che lavoreranno a pranzo lo stesso giorno: anche, quadricipiti e polpacci prima di Forza A e degli intervalli; spalle, torace e colonna prima di Forza B; catena posteriore e colonna prima di Forza C; anche, colonna e spalle prima del ritmo costante.
- **Dosi.** Per i distretti del giorno 2 tenute da 30 secondi per muscolo (circa 60 secondi totali, indicazione ACSM per la flessibilità); se avanza tempo le tenute salgono a 45 secondi (30-60 s è l'indicazione negli adulti più anziani) e anche gli altri allungamenti passano a 2 tenute.
- **Perché al mattino.** L'ACSM indica che allungare quasi ogni giorno dà i risultati migliori; poche decine di secondi per muscolo, ore prima dell'allenamento, non riducono forza e prestazione della seduta di pranzo.
- **Dove.** A casa: servono solo un tappetino, un muro o uno stipite e la loop band per i femorali.
- **Segue la seduta di pranzo.** Il focus del mattino è calcolato ogni volta dalla seduta di pranzo prevista per quel giorno: se nel calendario scegli un'altra seduta (per esempio Forza B al posto di Forza A, o l'aerobico), la card del mattino cambia da sola distretti ed esercizi e mostra la nuova seduta di pranzo. Se la mattina era già stata fatta in vista di un'altra seduta, la card lo segnala e propone di ripeterla. Unica eccezione: la *seduta libera* costruita dal catalogo non è prevedibile, e il mattino resta legato alla seduta del programma.
- **Se l'hai fatta senza aprire l'app**, il pulsante *L'ho già fatta: segnala come svolta* la registra alle dosi previste (stessa cosa per la seduta di pranzo, in fondo alla schermata *Oggi*).
- **Conteggi.** I pallini 1-5 mostrano le mattine fatte; toccandone uno si recupera una mattina saltata. Le sessioni del mattino compaiono nello storico ma non fanno avanzare il programma e non contano nel volume dei pesi né nei minuti aerobici.

### Durata scelta ogni giorno (35, 40, 45, 50 minuti)

In Home, dopo aver scelto la seduta (mobilità oppure forza A, B o C), si sceglie il **tempo a disposizione**. La scelta resta memorizzata finché non la cambi.

**Come si stima la durata.** Lavoro + recuperi fra le serie + un **tempo di cambio** per ogni esercizio (75 s nella forza: spostarsi, regolare la macchina, preparare il carico; 15 s negli allungamenti; 60 s per salire sulla cyclette) + 2 minuti e mezzo di serie di avvicinamento sul primo esercizio. Fino alla 4.7 il cambio non era conteggiato: le sedute stimate in 35 minuti ne duravano 47-57. Il ritmo personale si impara dalle sedute reali, **separatamente per forza e mobilità**; all'aggiornamento viene ricavato una volta dallo storico già registrato.

**Se il tempo è poco** (`fitToTime`), si taglia nell'ordine: sospensione alla sbarra → una serie del lavoro per le trazioni (non sotto 3) → serie dei complementari, dall'ultimo (non sotto 2) → trazioni fino a 2 serie → i due esercizi principali fino a 2 serie (ACSM 2026: 2-3 serie per esercizio) → l'ultimo complementare, lasciandone almeno quattro.

**Se il tempo c'è** (`fillToTime`), si aggiunge nell'ordine: esercizi supplementari per i gruppi che la settimana lascia sotto le 10 serie, in base al programma e a quanto fatto, mai in settimana di scarico (vedi 6.3) → **finale metabolico** (con 50 minuti una decina di minuti sono riservati a lui) → **sospensione alla sbarra** in chiusura → una serie in più a petto e gambe, fino a 4. Nelle sedute di mobilità: altri allungamenti, poi tenute da 45 secondi (30-60 s è l'indicazione ACSM negli adulti più anziani), poi una tenuta in più.

### Grasso addominale senza corsa, nuoto o ellittico (corsa solo per la Spartan, dalla 7S 0)

Card **Grasso addominale** in Programma. Le evidenze più recenti (Chang et al. 2026, *Nutrition & Metabolism*, 61 studi randomizzati; Xu et al. 2026, 60 studi, stessa graduatoria) indicano che il lavoro a intervalli (HIIT) è la modalità più efficace sul grasso viscerale. Sulla dose: 400 MET-min a settimana sono il minimo efficace, l'effetto massimo si colloca verso 1000-1100 — circa 230 minuti di camminata veloce, che è esattamente il motivo per cui la settimana ha due sedute aerobiche e un finale metabolico. Anche i pesi lo riducono, con effetto minore. La leva principale resta comunque l'alimentazione: un deficit moderato, con circa 1,6 g di proteine per kg al giorno per conservare il muscolo (Morton et al. 2018, *BJSM*).

Il **finale metabolico** entra nelle sedute di forza quando il tempo lo consente e si sceglie fra: cyclette a intervalli (predefinita: sella alta, resistenza moderata, cadenza alta), ergometro a braccia (nessun carico sul ginocchio), camminata in salita sul tapis roulant, colpi al sacco d'aria (anche a casa, piedi fermi). Lo schema è 30 s di scatto e 60 s a ritmo tranquillo, da 4 a 8 ripetizioni secondo il tempo rimasto; il timer alterna i due ritmi da solo. In settimana di scarico si accorcia.

In Progressi la card **Girovita e peso** registra le misure ogni 2-4 settimane e mostra la variazione dalla prima.

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

Dentro ogni fase si lavora a blocchi di quattro settimane, con la quarta di scarico (una serie e qualche ripetizione in meno a carichi invariati; il carico suggerito non sale in quella settimana), e la rotazione degli esercizi cambia a ogni blocco. La home mostra fase in corso, settimana nella fase, settimana assoluta e quante ne mancano alla data obiettivo.

**Corsa, nuoto ed ellittico** non compaiono: il ginocchio non li tollera. Il lavoro per il grasso addominale passa dal finale metabolico a basso impatto descritto sopra.

**Cambiando programma non si perde nulla**: storico dei carichi, valutazioni a stelle, riepiloghi e backup sono indipendenti dal programma attivo, e gli altri programmi (3, 4 e 6 settimane) restano disponibili in Programma.

### Trazioni e muscle-up: obiettivo del programma (dalla 6.4)

**Obiettivo al 30 maggio 2027: 15 trazioni pulite di fila a corpo libero e 2 muscle-up** (obiettivo dei muscle-up ridotto da 10 a 2 nella 6.7, su indicazione dell'utente). Attivabile da *Programma* (predefinito: attivo). Il lavoro resta dopo i due esercizi fondamentali del giorno, con la **sospensione alla sbarra** o l'attivazione scapolare in chiusura se resta tempo; ma quando la seduta va accorciata per stare nei minuti scelti, ora si riducono prima i complementari e poi le serie del blocco trazioni.

**Tappe guidate dai progressi, non dal calendario.** Il blocco cambia secondo il massimo di trazioni pulite (`pullMax`) e di muscle-up (`muMax`):

| Massimo | Tappa | Forza A | Forza B | Forza C |
|---|---|---|---|---|
| 0 | Prima trazione | negative | tenuta isometrica | volume assistito |
| 1-5 | Prime ripetizioni | serie pulite brevi | negative | volume assistito |
| 6-11 | Volume a corpo libero | serie pulite | trazioni esplosive al petto | negative lente |
| 12+ | Verso il muscle-up | serie pulite | trazioni al petto + dip | transizione alla sbarra bassa |
| 12+ e 1 muscle-up | Muscle-up | serie pulite | muscle-up + dip | transizione |

- **Serie pulite**: ripetizioni = massimo − 2, fino a 12 (sempre due di margine, mai a cedimento), 5 serie fino a 5 trazioni, 4 oltre; livello «Completa» preimpostato. Il riferimento è Sánchez-Moreno et al. 2020 (J Strength Cond Res 34(4):911-917): in 29 uomini allenati, 8 settimane di trazioni a corpo libero con fatica moderata (perdita di velocità del 25%) hanno migliorato forza e prestazione più delle serie spinte verso il cedimento (50%), che non hanno dato guadagni.
- **Il massimo** è il migliore fra test, serie pulite registrate (le serie annotate come assistite o a mezza escursione non contano) e il valore inserito a mano, nelle ultime sei settimane; le sedute segnate come fatte alle dosi previste non contano.
- **Test**: nella prima settimana di ogni blocco, subito dopo lo scarico (dalla 6.8; prima era nella settimana di scarico), in Forza A, una serie di trazioni pulite al massimo (obiettivo: il massimo + 1); in Forza B il test di muscle-up quando sono già in programma. È un test di massime ripetizioni a corpo libero come quelli di Sánchez-Moreno et al. 2017 (Int J Sports Physiol Perform 12(10):1378-1384).
- **Spalla**: le tappe del muscle-up restano chiuse finché in *Programma* è attiva «evita gli esercizi dolorosi per la spalla». In un'indagine su praticanti di CrossFit (Summitt et al. 2016, Sports Health 8(6):541-546) muscle-up agli anelli e alla sbarra, dip agli anelli e trazioni con slancio erano fra i gesti indicati come causa di infortuni alla spalla, e il 38,6% degli infortuni era la riacutizzazione di un problema già presente. La linea guida JOSPT 2025 (Desmeules et al., 55(4):235-274) raccomanda l'esercizio progressivo adattato alla tolleranza al dolore, senza elencare movimenti vietati: per questo la scelta resta all'utente, con l'indicazione di passare prima da una valutazione del fisioterapista.
- **Dip**: fino a 90° di gomito e mai a cedimento. In McKenzie et al. 2022 (IJERPH 19(21):14390) la spalla nel dip alla sbarra arriva a circa 67° di estensione, il 76% della sua escursione passiva; due partecipanti l'hanno superata nell'ultima ripetizione fallita.
- **Muscle-up prima alla sbarra**: Walker et al. 2023 (Int J Exerc Sci 16(1):1451-1460) indicano di costruire forza degli arti superiori e di imparare il muscle-up alla sbarra prima di quello agli anelli, che richiede più attivazione a bicipiti, tricipiti e trapezio superiore.
- **Soglie delle tappe** (1, 6, 12 trazioni; primo muscle-up): **regole operative dell'app**. Nessuna fonte verificata fissa prerequisiti numerici per il muscle-up.
- **Quanto è realistico**: per gli uomini di 46-50 anni la tabella del test fisico dei Marines assegna il punteggio massimo a 19 trazioni (fonte secondaria: tabelle USMC PFT riportate da Military.com), quindi 15 è un livello alto. In Sánchez-Moreno et al. 2017 le ripetizioni massime di uomini già allenati sono salite del 15% in 12 settimane; chi parte da poche ripetizioni progredisce di solito più in fretta in proporzione, ma non esistono dati su adulti di 50 anni per una previsione affidabile. La scheda in *Progressi* mostra il ritmo necessario e i test registrati.
- **A casa**, senza sbarra, il blocco resta quello di sempre: attivazione scapolare, pulldown con band a eccentrica lenta e tenuta isometrica con band.

**Riquadro in Progressi**: massimo attuale e da dove viene, tappa e criterio per la successiva, ritmo necessario, test registrati, aggiornamento a mano del massimo (le registrazioni non vengono toccate).

**Fonti tolte.** Le versioni precedenti citavano uno studio JSCR su band, macchina ed eccentriche nei principianti, un'analisi EMG sull'assistenza elastica, uno studio di dieci settimane con 4-5 ripetizioni in più e uno studio biomeccanico sulla presa. Nessuno è stato rintracciato su una fonte verificabile: le affermazioni sono state tolte e le scelte corrispondenti (eccentriche e tenute nella prima tappa, band come volume, presa a larghezza spalle) sono indicate come regole operative dell'app.

### Parametri e fonti

Rielaborati (nessun testo riprodotto) da: ACSM *Guidelines for Exercise Testing and Prescription*, NSCA *Essentials of Strength Training and Conditioning*, linee guida ACE per stretching e mobilità, raccomandazioni OMS sull'attività fisica per adulti 45-64 anni (150 minuti settimanali di attività moderata più due sedute di rinforzo: le sedute aerobiche e il finale metabolico servono a raggiungere quel volume).

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

Completate le sedute della settimana, l'app apre un riepilogo con le sedute svolte, la media delle stelle, i tre migliori traguardi della settimana e l'elenco di ciò a cui fare attenzione. Resta richiamabile in qualsiasi momento dalla scheda **Progressi → Riepilogo settimanale**, per le ultime quattro settimane con dati.

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
| Manubri | Rastrelliera da 2 a 40 kg, a passi di 2 kg. Il numero annotato è il peso del **singolo** manubrio, anche quando se ne usano due |
| Macchine, cavi, lat machine | Pacco pesi da 10 a 120 kg, a scalini di 2,5 kg |
| Casa | Manubri da 1 e 2 kg, anche in coppia: 1, 2, 3, 4 kg |

Quando la regola 2-for-2 chiede un aumento, l'app cerca il primo scalino utile nella direzione giusta: dal bilanciere a 20 kg propone 22, dai manubri a 8 kg propone 10, dalla macchina a 50 kg propone 52,5. Al carico massimo dell'attrezzo lo dice e suggerisce di aumentare le ripetizioni o cambiare variante.

**Nota sul passo minimo.** L'allarme "incremento oltre il 10%" scatta solo se la variazione supera *anche* il passo minimo realmente disponibile su quell'attrezzo (5 kg sul pacco pesi, 2,5 kg con i dischi, 1 kg con i manubri, 0,5 kg sui carichi leggeri). Senza questa condizione l'app segnalava come imprudente proprio l'incremento più piccolo possibile — per esempio da 20 a 22,5 kg, che è +12,5% ma anche l'unico passo che i dischi consentono, e che l'app stessa suggeriva.

### Massimale stimato

Il confronto fra sedute usa il massimale stimato con la formula di Epley — carico × (1 + ripetizioni/30), applicata fino a 15 ripetizioni dove resta attendibile. È ciò che permette di dire che 60 kg × 11 (82 kg stimati) è un progresso rispetto a 60 kg × 6 (72 kg stimati), cosa che guardando il solo peso non si vedrebbe. Nel grafico del dettaglio la linea piena è il massimale stimato, quella tratteggiata il carico usato. Il controllo sugli incrementi troppo bruschi resta invece ancorato al peso reale: aumentare le ripetizioni non è un rischio, aumentare il peso sì.

### Esercizio non registrato

In Progressi, toccando una seduta dell'elenco, il pulsante **Aggiungi un esercizio non registrato** permette di rimettere nello storico un esercizio svolto ma non salvato (o andato perso): esercizio, serie, ripetizioni e carico. La registrazione viene agganciata a quella seduta, quindi conta nella settimana giusta, nel volume e nei suggerimenti di carico successivi. Le voci aggiunte a mano si possono eliminare con ✕; le altre no.

Dalla 4.7 nessuna migrazione cancella più registrazioni: quella che nelle versioni precedenti azzerava una volta lo storico del calf alla macchina è stata disattivata.

### Volume settimanale

La scheda Progressi mostra, per la settimana in corso, le serie **fatte / previste** per otto gruppi (Petto, Dorso, Spalle, Braccia, Quadricipiti, Glutei e femorali, Polpacci, Core), con una tacca a 10 serie e la barra rossa sotto le 5. Le soglie vengono dalla meta-analisi dose-risposta: meno di 5 serie settimanali per gruppo danno +5,4%, da 5 a 9 +6,6%, 10 o più +9,8%.

Come si conta: una serie vale 1 per i gruppi che eseguono il movimento e ½ per quelli che collaborano (i tricipiti nella panca, i bicipiti nelle trazioni); negli esercizi monolaterali ogni lato riceve metà delle serie registrate; mobilità e allungamenti non contano. Il conteggio "previste" è ricavato dalle sedute che l'app genera per quella settimana.

Le sedute di forza della settimana si contano dal registro delle sedute (il tipo effettivamente svolto), non dagli esercizi: il blocco core facoltativo non passa per una seduta di forza. Con la 4.6 lo storico è stato riallineato una volta alla posizione nel programma: le sedute salvate prima della correzione del 17/09 avevano un indice sfasato e finivano nella settimana sbagliata. Lo stesso riallineamento si ripete quando usi *Allinea alla cronologia* in Programma; nessun dato viene cancellato, cambia solo la settimana a cui la seduta è attribuita.

Quando un gruppo resta sotto le 5 serie, sotto le barre e nel riepilogo di fine settimana compare **il motivo e il provvedimento**: settimana ancora in corso (nessuno); sedute di forza saltate (completarle, o accorciare la durata invece di saltarle); settimana di scarico o di sola mobilità (nessuno, è voluto); serie registrate meno di quelle previste (controllare esercizi chiusi in anticipo o sostituiti); gruppi che il programma tiene bassi per scelta, come polpacci e core (blocco core facoltativo o qualche serie in una seduta libera, se si vuole insistere).

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

Quando non puoi andare in sala pesi per una settimana — viaggio, impegni, un fastidio da lasciar passare — la scheda **Programma → Settimane di sola mobilità** permette di dichiararlo per la settimana in corso o per la prossima. Tutte le sedute diventano di mobilità e stretching, con schemi e rotazioni diversi fra loro per non ripetere gli stessi allungamenti.

Il punto che conta: **il programma di forza non perde nulla, slitta**. Nel conteggio delle settimane di fase quelle di sola mobilità non vengono contate, quindi se ti fermi alla settimana 2 di una fase, alla ripresa riparti dalla settimana 2, non dalla 3. Il macrociclo si allunga di una settimana invece di saltarne un pezzo.

### Se la posizione nel programma non corrisponde

Può capitare che l'indice della prossima seduta si disallinei da ciò che hai davvero svolto, tipicamente dopo qualche prova. La scheda **Programma → Dove sei nel programma** mostra la posizione corrente e offre due modi per correggerla:

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

- **Oggi**: scegli palestra o casa, poi il **calendario della settimana** mostra tutte le sedute previste più il blocco core facoltativo. L'etichetta *da programma* resta sempre attaccata alla seduta che il programma prevede come prossima, anche dopo uno scambio d'ordine; la seduta scelta per oggi è marcata a parte come *scelta per oggi*. Le sedute le già svolte restano barrate e non riapribili. Tocca la seduta che vuoi fare adesso — anche il blocco core — e sotto compare il suo elenco esercizi; poi premi *Inizia la sessione*. Scegliendo una seduta diversa da quella prevista, quella di oggi prende il suo posto più avanti nella settimana, quindi non si perde nulla.
- Nell'elenco della seduta, **tocca un esercizio** per aprirne subito la scheda illustrativa, senza dover iniziare l'allenamento.
- Durante l'esercizio: segna le serie completate, scrivi il carico, dai il feedback con le tre frecce, premi **Ho finito la serie**: parte il timer di recupero, con un rintocco su ciascuno degli ultimi 3 secondi e colpo finale più acuto.
- **Esercizi a tempo** (stretching statico, plank, wall sit): il pulsante diventa *Avvia 30 secondi* e fa partire il cronometro della tenuta, in verde. Prima del conteggio ci sono **3 secondi di preparazione**, scanditi da un rintocco ciascuno, mostrati come sola cifra al centro del cerchio; al termine parte da solo il recupero.
- **Esercizi da fare un lato alla volta** (split squat, rematore a un braccio, plank laterale, quasi tutti gli allungamenti) hanno sempre un **numero pari di serie**, così destra e sinistra ricevono lo stesso lavoro: il contatore mostra `1 Sx`, `1 Dx`, `2 Sx`… e il pulsante di avvio indica il lato da fare.
- **Cambia esercizio**: apre una pagina di scelta (si esce con *Indietro*, che non modifica nulla) con le alternative disponibili, ordinate per pertinenza rispetto a quello in programma — pesano lo schema di movimento, il ruolo nel blocco trazioni, il gruppo, i muscoli primari condivisi e il tipo di carico — ciascuna con l'illustrazione, l'attrezzatura e il motivo per cui è proposta. L'esercizio previsto compare in cima con il pulsante *Mantieni*, quindi decidi tu se cambiare. Lo stesso vale dalla scheda esercizio (*Sostituisci con un altro esercizio*) e prima di iniziare, dall'elenco di Oggi.
- **Dai muscoli agli esercizi**: nella scheda esercizio le etichette dei muscoli coinvolti sono toccabili e aprono l'elenco di tutti gli esercizi che lavorano quel muscolo con l'attrezzatura selezionata, sempre con la possibilità di sostituire quello in programma o di tenerlo.
- **Esercizio precedente**: il pulsante *‹ Precedente* torna indietro nella scaletta per correggere un carico o completare una serie saltata. Lo storico non si sdoppia: il record dell'esercizio viene aggiornato, non duplicato.
- **Ordine degli esercizi**: se una macchina o un attrezzo è occupato, usa *Rimanda a dopo* (sposta l'esercizio corrente in fondo) oppure *Ordine esercizi*, che apre la scaletta di quello che resta da fare con le frecce su/giù. Serie già completate, carico e feedback seguono l'esercizio spostato.
- **Esercizi a tempo** (allungamenti, plank, tenute): un solo tocco su *Avvia* fa partire tutta la sequenza — 3 secondi di preparazione, tenuta, pausa, tenuta… — e ogni tenuta completata conta da sola una serie, alternando Sx e Dx negli esercizi monolaterali. La campanella suona nei 3 secondi che precedono ogni tenuta (con il colpo acuto di via), negli **ultimi 3 secondi di ogni tenuta** (poi il colpo acuto di fine) e negli ultimi 3 secondi del recupero. Lo stesso vale per gli scatti degli intervalli e per le fasi continue dell'aerobico. Il pulsante del timer cambia nome a seconda del momento: *Parti ora*, *Termina la tenuta*, *Accorcia la pausa* (porta la pausa a 3 secondi, così il preavviso suona comunque).
- **Esercizi a ripetizioni o a tempo con un'unica indicazione**: ogni esercizio ha o le ripetizioni o i secondi, mai entrambi. Gli esercizi di mobilità dinamica (cat camel, circonduzioni, slanci) si contano a ripetizioni; gli allungamenti statici a secondi. Nelle sedute di mobilità non compaiono campi di carico, frecce, ripetizioni o RIR.
- **Recupero conclusivo con l'esercizio successivo a schermo**: completata l'ultima serie, l'esercizio viene registrato subito, compare la schermata del prossimo e il recupero conclusivo scorre nella barretta in basso (almeno 45 s nella forza, 30 s nella mobilità). Intanto puoi aprire la scheda del nuovo esercizio senza interrompere il timer. Dopo l'ultimo esercizio della seduta si passa direttamente al riepilogo.
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

Aggiornate al 13 ottobre 2026, con verifica diretta di ciascuna fonte: dove una fonte più recente sostituisce una precedente, l'app segue la più recente, e dove una fonte non è verificabile ad accesso aperto è detto esplicitamente.

- **Currier, D'Souza, Fiatarone Singh, … Phillips 2026**, *Resistance Training Prescription for Muscle Function, Hypertrophy, and Physical Performance in Healthy Adults: An Overview of Reviews* — ACSM Position Stand, Medicine & Science in Sports & Exercise 58(4):851-872 (137 revisioni sistematiche; sostituisce la posizione del 2009). Tutti i gruppi principali almeno 2 volte a settimana; per l'ipertrofia **almeno** 10 serie settimanali per gruppo, con plateau verso 18-20; forza con carichi ≥80% 1RM per 2-3 serie per esercizio; esercizi chiave per primi **nel lavoro di forza** (per l'ipertrofia l'ordine è indifferente); il cedimento non è necessario, e il documento precisa che **le prove non bastano a fissare valori precisi di ripetizioni di riserva**: il 2-3 RIR dell'app è una scelta pratica prudente, non una soglia dimostrata. Le raccomandazioni non sono differenziate per età.
- **Pelland et al. 2026**, *The Resistance Training Dose Response*, Sports Medicine 56(2):481-505 (online dicembre 2025; 67 studi, 2.058 partecipanti) — volume e crescita con rendimenti decrescenti; il conteggio "frazionario" (serie indirette = ½), usato nelle barre del volume, è il più predittivo; la frequenza conta per la forza, non per l'ipertrofia.
- **Singer et al. 2024**, *Give it a rest*, Frontiers in Sports and Active Living — recuperi oltre 60 s lievemente migliori per l'ipertrofia, nessun vantaggio oltre 90 s.
- **Schoenfeld, Ogborn, Krieger 2017**, Journal of Sports Sciences 35(11):1073-1082 — soglie 5 e 10 serie settimanali. Da leggere con cautela: la relazione era un trend non significativo (P = 0,074) e il vantaggio delle ≥10 serie sparisce nell'analisi di sensibilità. Resta come riferimento storico delle soglie; sul volume l'autorità attuale sono il Position Stand 2026 e Pelland 2026.
- **Chang et al. 2026**, Nutrition & Metabolism 23(1):75 (61 studi randomizzati, 4.136 partecipanti) — HIIT la modalità più efficace sul grasso viscerale (SMD −0,84; primo posto con SUCRA 99,3%); anche i pesi lo riducono, con effetto minore. **I 400 MET-min a settimana sono la dose minima efficace dell'HIIT, non l'obiettivo**: l'effetto massimo si colloca verso 1000 MET-min.
- **Xu, Xie, Liu 2026**, BMC Sports Science, Medicine and Rehabilitation 18:354 (60 studi, 3.308 adulti) — seconda rete indipendente che conferma la graduatoria (HIIT primo) e colloca la dose ottimale complessiva verso 1100 MET-min a settimana, circa 230 minuti di camminata veloce.
- **Jakicic et al. 2024**, *Physical Activity and Excess Body Weight and Adiposity for Adults* — ACSM Consensus Statement, Translational Journal of the ACSM 9(4):e000266 (sostituisce Donnelly et al. 2009). **Non fissa obiettivi percentuali di perdita di peso**; indica almeno 150 minuti a settimana di attività moderata con beneficio crescente con la dose, e nessuna modalità superiore alle altre per il controllo del peso. Il tetto del 5-10% usato nella proiezione delle misure resta come freno prudente, non come obiettivo raccomandato.
- **Morton et al. 2018**, British Journal of Sports Medicine — circa 1,6 g/kg/die di proteine per massimizzare i guadagni di massa magra con i pesi.
- **Regola 2-for-2** (due ripetizioni oltre l'obiettivo per due sedute, poi incremento del 2,5-10%) — pratica diffusa nella manualistica NSCA (*Essentials of Strength Training and Conditioning*), **non verificabile su fonte ad accesso aperto**: è qui una scelta operativa dell'app, non una raccomandazione citabile. La posizione NSCA che ho potuto leggere — **Fragala et al. 2019**, *Resistance training for older adults*, Journal of Strength and Conditioning Research 33(8):2019-2052 — non indica alcun metodo di progressione come superiore agli altri. Quello che conta, e che l'app rispetta, è che il carico salga sui risultati e non sul calendario.
- **Garber et al. 2011**, ACSM Position Stand, Medicine & Science in Sports & Exercise 43(7):1334-1359 — flessibilità: tenute di 10-30 s, **30-60 s negli adulti più anziani** (il testo dice "older persons": l'app non estende il valore a una soglia di età precisa), circa 60 s totali per esercizio, 2-3 giorni a settimana efficaci e risultati migliori con lavoro quotidiano. È la fonte dei numeri sullo stretching, che in precedenza erano attribuiti a ACE.
- **Desmeules et al. 2025**, *Rotator cuff tendinopathy diagnosis, nonsurgical medical care, and rehabilitation: a clinical practice guideline*, Journal of Orthopaedic & Sports Physical Therapy 55(4):235-274 — il conflitto subacromiale rientra oggi nella diagnosi ombrello di tendinopatia della cuffia dei rotatori; l'esercizio attivo contro resistenza è raccomandato con prove forti (grado A) e **la linea guida non elenca movimenti da evitare**. Per questo il filtro della spalla nell'app è presentato come preferenza di comfort e non come divieto.
- **Morri et al. 2025**, *Conservative treatment of patellofemoral pain*, BMC Sports Science, Medicine and Rehabilitation 17:303 — il rinforzo batte gli altri trattamenti conservativi sul dolore (certezza delle prove bassa), **nessun tipo di rinforzo risulta superiore a un altro e nessun esercizio è sconsigliato**. Anche la priorità al ginocchio è quindi una preferenza, non un divieto.
- **Meigh et al. 2022**, *Effects of supervised high-intensity hardstyle kettlebell training on grip strength and health-related physical fitness in insufficiently active older adults: the BELL pragmatic controlled trial*, BMC Geriatrics — 12 settimane di kettlebell in adulti fra 59 e 79 anni: forza di presa +23-25%, sit-to-stand +23%, stacco stimato +16 kg, nessun infortunio serio. È la base degli esercizi con kettlebell introdotti nella 5.12.
- **OMS 2020** — raccomandazioni di attività fisica per adulti.
- **Zourdos et al. 2016**, *Novel Resistance Training-specific Rating of Perceived Exertion Scale Measuring Repetitions in Reserve*, Journal of Strength and Conditioning Research 30(1):267-275 — scala delle ripetizioni in riserva (in precedenza qui era indicata la rivista sbagliata).
- **Epley (1985)** — formula del massimale stimato.
- **W3C**, *WCAG 2.2*, criterio 1.4.4 — niente blocco dello zoom.

## Avvertenza

I programmi generati sono costruiti su linee guida generali per adulti sani e non sostituiscono una valutazione medica. Prima di iniziare, e in particolare per la sensibilità al ginocchio, consulta un medico o un fisioterapista. Interrompi in caso di dolore articolare acuto, dolore toracico, mancanza di respiro insolita o vertigini.
