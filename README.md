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

iOS fotografa l'icona al momento dell'installazione e non la aggiorna da sola: dopo aver cambiato le icone nel repository bisogna reinstallare la scorciatoia.

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

All'apertura scorre un'intro di tre secondi: l'anello del marchio si disegna, le tre barre della progressione salgono una dopo l'altra, compaiono nome e sottotitolo. Finita l'animazione l'intro resta ferma sull'ultimo fotogramma e sparisce **solo quando tocchi lo schermo** (in basso compare il suggerimento "Tocca per iniziare"). Rispetta l'impostazione di sistema per il movimento ridotto.

**L'ora** è sempre visibile in piccolo in alto a destra, sopra l'indicatore della settimana, e al centro in alto durante il timer a tutto schermo: comoda per sapere da quanto sei in palestra senza uscire dall'app.

- **Oggi**: scegli palestra o casa, controlla la seduta e premi *Inizia la sessione*.
- Nell'elenco della seduta, **tocca un esercizio** per aprirne subito la scheda illustrativa, senza dover iniziare l'allenamento.
- Durante l'esercizio: segna le serie completate, scrivi il carico, dai il feedback con le tre frecce, premi **Ho finito la serie**: parte il timer di recupero, con un rintocco su ciascuno degli ultimi 3 secondi e colpo finale più acuto.
- **Esercizi a tempo** (stretching statico, plank, wall sit): il pulsante diventa *Avvia 30 secondi* e fa partire il cronometro della tenuta, in verde. Prima del conteggio ci sono **3 secondi di preparazione**, scanditi da un rintocco ciascuno, mostrati come sola cifra al centro del cerchio; al termine parte da solo il recupero.
- **Esercizi da fare un lato alla volta** (split squat, rematore a un braccio, plank laterale, quasi tutti gli allungamenti) hanno sempre un **numero pari di serie**, così destra e sinistra ricevono lo stesso lavoro: il contatore mostra `1 Sx`, `1 Dx`, `2 Sx`… e il pulsante di avvio indica il lato da fare.
- **Cambia esercizio**: nella sessione, il pulsante *Cambia esercizio* propone un'alternativa dello stesso schema di movimento (o dello stesso gruppo, per lo stretching), coerente con attrezzatura, obiettivo della seduta e filtro ginocchio; premendolo più volte scorri tutte le alternative. La stessa cosa si può fare prima di iniziare, dalla scheda che si apre toccando un esercizio nell'elenco di Oggi.
- **Scambia seduta**: in Oggi puoi anticipare un'altra seduta della settimana (per esempio fare il potenziamento al posto della mobilità). Quella di oggi prende il suo posto più avanti, quindi nessuna seduta va persa e il conteggio delle 5 settimanali resta intatto.
- **Esercizio precedente**: il pulsante *‹ Precedente* torna indietro nella scaletta per correggere un carico o completare una serie saltata. Lo storico non si sdoppia: il record dell'esercizio viene aggiornato, non duplicato.
- **Ordine degli esercizi**: se una macchina o un attrezzo è occupato, usa *Rimanda a dopo* (sposta l'esercizio corrente in fondo) oppure *Ordine esercizi*, che apre la scaletta di quello che resta da fare con le frecce su/giù. Serie già completate, carico e feedback seguono l'esercizio spostato.
- **Timer riducibile**: durante il recupero tocca *Riduci*. Il conto alla rovescia resta in una barretta in basso e nel frattempo puoi consultare le schede, lo storico o cambiare vista. Tocca la barretta per tornare a schermo intero, o *Salta* per riprendere subito.
- Chiusura e interruzione della sessione chiedono sempre conferma, così non si esce per errore. Se esci dalla vista della sessione, in Oggi compare il banner **Riprendi**.
- **Scheda esercizio**: esecuzione passo-passo, muscoli primari e secondari, errori comuni, avvertenze di sicurezza e le due figure inizio/fine.
- A fine seduta puoi annotare una nota libera sulla seduta (sensazioni, ginocchio, carichi).
- **Progressi**: andamento del carico per esercizio e riepilogo delle ultime dieci sedute. Toccando una seduta si apre il suo **riepilogo completo**: data e ora, durata, nota, e l'elenco degli esercizi svolti con serie, ripetizioni, carico e feedback.
- **Programma**: cambio di programma (3, 4 o 6 settimane), attrezzatura predefinita, priorità ginocchio, esclusione degli esercizi critici per la spalla, spostamento avanti/indietro nella settimana, esportazione e azzeramento dati.

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

Resta il limite di sistema: con l'app in background o lo schermo bloccato iOS sospende comunque l'audio delle pagine web. Per questo il wake lock tiene lo schermo acceso durante la sessione e a fine timer parte anche la vibrazione.

**Notifiche.** Su iOS le notifiche push da PWA richiedono l'installazione a Home e permessi espliciti; non sono usate qui per non introdurre dipendenze da un server.

**Frequenza cardiaca e Garmin Forerunner 55: funzione rimossa.** Una PWA in Safari è isolata nel browser e non può in alcun modo collegarsi all'app Garmin Connect installata sull'iPhone: iOS non permette a una pagina web di leggere i dati di un'altra app, Safari non espone Web Bluetooth (quindi niente lettura diretta dell'orologio) e HealthKit è accessibile solo alle app native, perciò nemmeno il passaggio Garmin Connect → Salute apre una strada. Restano solo percorsi che non sono un "collegamento" e richiedono un backend o passaggi manuali:

- **Garmin Health API / Connect Developer Program**: dati automatici, ma serve un server proprio, la registrazione come sviluppatore e l'approvazione di Garmin.
- **Import di un file esportato**: da Garmin Connect si esporta l'attività in `.tcx` (XML con la frequenza cardiaca campionata) e la si carica nell'app, che ne ricava media e massimo. Funziona senza server, ma è un'operazione manuale da fare dopo ogni seduta.
- **Scorciatoia iOS**: un'automazione dell'app Comandi può leggere la FC da Salute e copiarla negli appunti, da incollare a mano.

Poiché nessuna di queste opzioni è il collegamento automatico richiesto, l'inserimento manuale dei battiti è stato tolto: la scheda di fine sessione registra ora durata e una nota libera. L'intensità reale si legge direttamente sull'orologio o nell'app Garmin Connect, dove la seduta è già registrata. Se in futuro vuoi l'import del `.tcx`, il punto di innesto è `endSession()` in `app.js` e il campo da aggiungere ai record di `sessionLog`.

**Persistenza dei dati.** `localStorage` in Safari può essere ripulito dopo lunghi periodi di inutilizzo del sito. Installando l'app a Home il rischio si riduce molto; in ogni caso esporta ogni tanto il JSON dalla scheda Programma. Per volumi di dati maggiori il passo successivo naturale è IndexedDB, con la stessa struttura di record già usata nei log.

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
