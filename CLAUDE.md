# subs2b: context de lucru pentru Claude

Fișierul ăsta e citit automat la începutul fiecărei sesiuni. Ține-l la zi la finalul fiecărei etape importante
(ce s-a făcut, ce a ieșit la teste, ce a rămas).

## Proiectul
- Addon Stremio de subtitrări cu clasament inteligent (TypeScript / Node / Express). Repo: `robbie2b/subs2b`.
- Rulează pe Render (Docker, plan gratuit ~0.1 CPU) cu Postgres pe Supabase. Un cron-job.org îl ține treaz non-stop, 24/7 (la 10 min; confirmat de utilizator 2026-11-04, nu a fost limitat niciodată).
- Proprietarul nu e programator: explică simplu, **în română**.

## Reguli
- **Vercel (ramura `vercel`): deploy DIRECT după fiecare set de modificări, fără să mai întreb** (instrucțiunea utilizatorului, 2026-11-06: „direct deploy, nu mai stăm la discuții"). Înainte de push: `npm run build` și `npm test` trec; la fiecare deploy crește a treia cifră; după push verific `/health`. Render și `main` rămân doar la cerere explicită (mai jos).
- **Deploy pe Render DOAR la cererea explicită a utilizatorului.** Render face deploy automat la push pe `main`,
  deci nu împinge pe `main` fără cerere. Lucrul curent stă pe o ramură (acum: `work/subsync-engine`).
- **Împinge ramura de lucru pe GitHub la finalul fiecărei etape.** O ramură a fost aproape pierdută o dată
  (exista doar local când sesiunea s-a mutat în cloud).
- Versiuni: la fiecare deploy crește doar a treia cifră (1.4.2 → 1.4.3). A doua cifră se schimbă doar când zice utilizatorul.
  Versiunea se schimbă în `package.json` și pe 2 linii în `package-lock.json` (liniile 3 și 9), cu tag `vX.Y.Z`.
  Din cloud tagurile NU se pot împinge (proxy-ul le blochează): utilizatorul le pune de pe calculatorul lui
  (`C:\Users\rober\subs2b`: `git fetch origin && git tag vX.Y.Z origin/main && git push origin vX.Y.Z`).
- Mesajele de commit (și descrierile de PR) NU conțin nimic despre Claude sau sesiune: fără `Co-Authored-By`,
  fără `Claude-Session`, fără „Generated with Claude Code”. Doar descrierea schimbării.
- Înainte de commit: `npm run build` și `npm test` (autonom, fără rețea; toate trebuie să treacă).
- Nu pune UUID-ul configurației sau chei în cod, în commituri sau în chat.

## Debug-ul serverului live
- `https://subs2b.onrender.com/<uuid>/debug/{recent,usage,providers,alignments,logs,search}.json`. Cere doar UUID-ul, fără parolă.
- UUID-ul e în variabila de mediu `SUBS2B_UUID` a mediului cloud (citit doar la pornirea sesiunii).
  Accesul la rețea către `subs2b.onrender.com` e permis (Custom).
- Exemplu: `curl -s "https://subs2b.onrender.com/$SUBS2B_UUID/debug/alignments.json"`

## Cum funcționează (pe scurt)
- `src/core/aggregator.ts`: caută la toți furnizorii, filtrează limba, deduplică, ordonează (`src/utils/scorer.ts`),
  apoi construiește linkurile pentru Stremio.
- `src/utils/scorer.ts`: punctaj în stil Bazarr (grup, sursă, rezoluție, serviciu, codec, ediție). Respinge alt titlu,
  an sau episod. Titlu: jaccard ≥ 0.5 SAU titlul scurt e sfârșitul celui lung (max 3 cuvinte în față, prefixe de limbă
  ca „21_Romanian” ignorate). Reguli opționale în `RuleFlags` (fuzzyGroup și multiVariant pornite, sourceTiers oprită).
- **Subsync** (re-sincronizare automată, `src/core/alignment.ts`, `src/proxy/alignedProxy.ts`, motor în `src/utils/subsync.ts`):
  - Se declanșează (`needsReference`) pentru orice subtitrare care NU e de la același grup cu fișierul (`fromFileGroup`).
    Eticheta („1080p BluRay”) nu mai e crezută: la The Chaser o subtitrare „REMUX FraMeSToR” pe un fișier REMUX Shamir
    era desincronizată. Subtitrările de la același grup merg direct, celelalte se verifică (dacă sunt bune: „already aligned”).
  - Referințele rămân de același tip cu fișierul: aceeași clasă de rezoluție (uhd/hd) ȘI aceeași familie de sursă
    (disc = remux/bluray, web = webdl/webrip, tv = hdtv, dvd).
  - Linkurile verificate trec prin `/:config/sub/aligned/<token>.srt`. La descărcare caută referințe în orice limbă,
    de același tip cu fișierul, și aliniază: decalaj, raport de cadre (ex. ×1.043 pentru 25 vs 23.976 fps), split pe bucăți.
    Playerul AȘTEAPTĂ decizia (cererea utilizatorului: subtitrarea bună din prima, chiar dacă durează). Originalul se
    trimite doar dacă nu există referințe, la eroare, sau peste limita de siguranță de 60 s (`SUBSYNC_MAX_WAIT_MS`).
  - Pornire din timp: lista pornește deja pregătirea primei subtitrări din fiecare limbă (max 2), cât se deschide filmul
    (`src/core/alignedPrepare.ts`, partajată cu cererea playerului).
  - Calculul rulează pe un fir separat (`src/core/alignPool.ts` + `alignWorker.ts`, cod pur în `alignDecision.ts`), ca
    serverul să nu se blocheze; dacă firul nu pornește, se calculează pe firul principal. `SUBSYNC_WORKER=0` îl oprește.
  - Candidat verificat: linkul poartă până la 3 alternative din aceeași limbă. Dacă subtitrarea nu se potrivește cu
    nicio referință, dar referințele se potrivesc între ele, se servește prima alternativă care se potrivește.
    Debug-ul arată „replaced by …”.
  - Deciziile se păstrează în DB (`storage/alignmentLogStore.ts`, tabela `subsync_decisions`).
  - Benchmark față de ffsubsync 0.5.1: potrivire identică (72% global / 77% cu split), ~70 ms față de 16 s pe Render.
    Uneltele sunt în `experiments/subsync/benchmark/`; corpusul nu e în repo.

## Istoric recent
- **v1.5.25 — din analiza a doi subagenți (2026-11-12).** Cercetător (Bazarr, subliminal, ffsubsync, alass, StremioSubMaker, SCS, stremio-subs-ro, USS) + analist
  (traseul real pas cu pas, cu date din Debug). Făcut acum: (1) grația după „destul de bun" nu mai e 300 fix: 0 la potrivire exactă sau risc <3%, 100 ms altfel
  (`goodEnough` întoarce `false | grație`); (2) o sursă care eșuează dar câștigă <3% nu mai face lista „incompletă" (`sourceMatters`): înainte fiecare listă avea
  vreo sursă picată (RegieLive, Subs.ro 520, Titrari, Addic7ed, PRO) și era ținută doar 2 min; (3) cache-ul configurației se reciteşte din DB la 30 s
  (`CONFIG_RECHECK_MS`; BUG: după salvare celelalte instanțe Vercel serveau config vechi până la reciclare); (4) `s-maxage` pe liste (max 300 s) și pe
  subtitrările decise (3600 s dacă decizia e sigură, 300 s altfel; timeout/eroare rămân `no-store`) ca repetările să nu mai ruleze funcția; (5) referințele:
  oprire la 2 candidate (sau 1 după 1,2 s) și O SINGURĂ interogare pentru „referințe salvate sau marca fără referințe" (`loadStoredOrNone`); (6) pregătire din timp
  și a 2-a/3-a subtitrare din aceeași limbă, la 300 ms după prima, fără sursele cu cotă pe cheie (OpenSubtitles API, Wyzie).
  Rămase din analiză, pe rând: (A) rezultatul aliniat salvat în DB (decizia + textul original, TTL), citit cu plafon 150 ms înainte de pregătire (repetările sunt 41% din
  Play-uri, 3 din 8 subtitrări s-au pregătit de două ori pe instanțe diferite); (B) cache-ul listei brute în DB (acum doar memoria instanței; cheia are hash-ul);
  (C) legătura hash↔nume de fișier; (D) apelurile către propriul domeniu la `.vtt`→`/sub/convert` (30–60 ms); (E) DDL la pornire la rece; (F) circuit breaker pentru surse moarte
  (Titrari a dat 500 la 89 din 95 de căutări între 5 și 9 nov.); (G) măsurare pornire la rece (nu există date).
- **v1.5.24 — cozile lente (2026-11-12, „eficientizăm și mai tare").** Date după 1.5.13 (90 de decizii, 54 de liste): lista mediană 1,6 s (p90 3,7 s), subtitrare gata
  după listă mediană 0,75 s (p90 2,8 s), jucătorul a așteptat mediană 0,6 s; 8 din 90 au așteptat >3 s. Cozile: referințe p95 3,4 s / max 7,6 s (Zodiac: 6,6–7,6 s),
  calcul max 7,9 s (Odyssey telesync), descărcarea subtitrării max 4 s. Schimbări: (1) referințele: descărcarea cu timeout 4 s (era 8), lista se închide când sunt 2
  referințe + 400 ms de așteptare pentru a treia (era `allSettled` pe 3), cele eșuate sunt înlocuite de următoarele candidate; (2) buget de calcul `ALIGN_BUDGET_MS` = 3,5 s în
  `alignAgainst`: peste el nu se mai încearcă alte referințe și nu pornește căutarea cu decalaj variabil; (3) `awaitSourceSpeeds`: o instanță nouă așteaptă (max 250 ms) statisticile
  surselor la prima cerere, ca regulile dinamice (risc, p75) să funcționeze și la ea (înainte prima cerere pe instanță nouă mergea fără ele; liste după >30 min de pauză: mediană 1,9 s față de 1,6 s).
- **DECIZIE (2026-11-12, utilizatorul): NU curățăm textul subtitrărilor** (reclame, credite, etichete de zgomot, versuri), ca la Ultimate Smart Subs (uss.ezerche.com,
  addon găzduit de altcineva: surse multiple, traducere AI cu cheia utilizatorului, text curățat, a doua limbă sub rând). Creditele traducătorilor rămân în subtitrare.
  Comparația cu USS: ce avem noi mai bun = Subsync pe referințe din alte limbi, viteză măsurată, Debug, control; ce are el = traducere AI când lipsește limba, curățare de text,
  mai multe surse. Nu reluăm fără motiv nou. (Dacă se vrea vreodată: doar la capete, replici întregi de credit, oprită implicit, cu lista scoaselor în Debug.)
- **v1.5.23 — plafon de 12 s pentru așteptarea Subsync pe Vercel (era 45 s).** Din codul Nuvio (TV și telefon, citit): descărcarea unei subtitrări pentru
  auto-sync are timeout 15 s; peste asta Nuvio n-are ce arăta din verificare. Telefonul (NuvioMobile 0.6.8-beta): la start alege subtitrarea preferată și, cât timp
  indexează pista din fișier, descarcă în paralel până la 6 alternative din aceeași limbă (de aici 1–3 cereri pe Play) și le compară cu pista; la alegerea manuală
  verifică doar subtitrarea aleasă. Nuvio compară varianta deja sincronizată de noi, deci nu se adună două corecturi. `SUBSYNC_MAX_WAIT_MS` suprascrie plafonul.
- **v1.5.22 — așteptare după riscul de schimbare (2026-11-06, „eficientizăm și mai tare").** Date (413 cereri clasate): Subs.ro (addonul) câștigă 84% din
  cereri (342/405), RegieLive 4%, PRO 3%, OpenSubtitles 3%, restul <2%. Măsurat pe 21 de liste de azi: lista mediană 1,5 s, 14 din 21 oprite devreme;
  decizie Subsync gata la mediană 0,7 s (p90 2,8 s; la început 2,5 s / 7,5 s); jucătorul a așteptat mediană 0,6 s. Rămâneau listele de 6 s când cel mai
  bun scor era sub prag (Enola 37, Avatar TLA 33) sau Subs.ro lent (Seinfeld 5,7 s). Nou în `goodEnough`: riscul = suma ratelor de câștig ale surselor încă
  așteptate (cele peste „fereastra" lor, 2× p75, max 4 s, nu mai contează; necunoscute 10%); sub 6% lista pleacă chiar dacă scorul e sub prag și fără
  regula Priority. Fără statistici (instanță nouă) comportamentul rămâne cel vechi. `EarlyStop.recheck` ține 4,2 s. Test în `test/dynamicTimeout.test.ts`.
- **DECIZIE (2026-11-06, utilizatorul): rămânem la addonul comunității Subs.ro, NU la integrarea directă.** Testul lui: integrarea directă dă mult mai puține
  rezultate decât addonul (addonul listează fiecare fișier din toate arhivele; varianta „descărcare la cerere" listează max 2 pachete după descriere, ca să
  nu consume cereri). Serviciul `subsrodirect` (v1.5.14–1.5.21) rămâne în cod, OPRIT implicit, fără efect cât timp nu e pornit; poate fi șters. Nu mai
  reluăm ideea fără motiv nou. Lecție: măsoară rezultatele (nu doar cererile) înainte să construiești un înlocuitor.
- **Subs.ro direct, serviciu nativ `subsrodirect` (2026-11-06, cerut de utilizator; NEDEPLOYAT):** `providers/subsroDirect.ts`,
  `storage/subsroStore.ts` (tabela `subsro_cache`, RLS pornit; căutarea 6 h, pachetele până se schimbă `updatedAt`, gzip, partajate între
  instanțe), `utils/archiveEntries.ts` (listare/extragere ZIP+RAR), `proxy/subsroDownload.ts` (ruta `/proxy/download/subsro/:packId/:entry`,
  fără cheie în link, servește din pachetul păstrat, 404 dacă nu mai e), rând „Subs.ro (direct)" în Services (grupul „Requires API key", cheia
  de la subs.ro/api). Cum merge: o căutare `GET api.subs.ro/v1.0/search/imdbid/tt…` (antet `X-Subs-Api-Key`) dă un rezultat pe PACHET (film /
  sezon / sezoane), nu pe subtitrare; se deschid doar pachetele sezonului cerut (max 4) și fiecare fișier .srt al episodului devine o
  subtitrare cu numele release-ului (PHOENiX, VELUN...). Addonul comunității (github.com/allecsc/stremio-subs-ro, GPL v3, citit, nu copiat)
  descarcă TOATE arhivele titlului la fiecare căutare, în cache de 30 min global (max 30 arhive): de aici 3–4 cereri la un film nou și până la
  1+15 la Family Guy cu cache gol. `/quota` e gratuit: sub 15 cereri rămase azi sursa nu mai e întrebată („daily limit almost reached").
  Referințele Subsync NU o folosesc (`allLanguages` → [] și dezactivată în `buildReferences`). Testat real (film The Fall, 3 cereri: 1 căutare
  + 2 pachete, 8 subtitrări cu nume reale, 1,7 s) și pe Postgres 16. Test: `test/subsroDirect.test.ts`. După deploy: utilizatorul pune cheia în
  Services, pornește „Subs.ro (direct)" și oprește addonul Subs.ro din Addons ca să nu fie duble. Testele mele consumă din cota lui: acum 12 azi
  (105 → 117).
  **Primul test real al utilizatorului (The Greatest Showman, 2026-11-06 13:58 UTC):** Subs.ro (direct) 12 subtitrări în 685 ms, +4 cereri la Subs.ro
  (1 căutare + 3 pachete; la un film nou ca la addon, câștigul e la seriale și la repetări); locul 1 în clasament. Lista a ieșit în 2,4 s fiindcă
  `subsrodirect` era ultimul în Priority (regula „sursele mai sus se așteaptă") → v1.5.16: `mergeWithDefaults` pune `subsrodirect` în locul
  addonului `org.stremio.subsro` din lista de priorități când acesta e deasupra lui.
  **v1.5.18 (utilizatorul: „cum să ia 4 cereri"):** pachetele se deschid pe rând, cel mai potrivit cu fișierul întâi (descrierea unui pachet de film
  listează release-urile din el, deci se ordonează cu același scorer), și următorul doar cât timp sunt prea puține subtitrări (`maxSubtitles`, altfel
  5); max 3 pachete; un pachet de serial a cărui descriere spune doar alte episoade („Ep.1-4") se omite (`excludesEpisode`). Un film nou: 1 căutare +
  1 pachet = 2 cereri când primul pachet are destule. Debug: `/debug/subsro.json?imdb=tt…` arată ce a păstrat căutarea (pachete, descrieri, fișiere),
  fără cereri la Subs.ro.
  **v1.5.19:** Peacemaker S01E01 cu două fișiere video (2026-11-06 14:09): cota 124→127 = 1 căutare + 2 pachete (cele două pachete „Sezonul 1" ale serialului,
  ambele păstrate), TOATE la prima redare; a doua redare (alt fișier) a costat 0 (348 ms, din păstrate). Pachetul cel mai bun avea doar 2 fișiere pentru
  episod și ținta era 3 → s-a deschis și al doilea. Acum ținta e 2 subtitrări (`WANTED_SUBTITLES`), independent de `maxSubtitles`: un episod nou costă de regulă
  1 căutare + 1 pachet.
  **v1.5.20 (utilizatorul: „ce să facă cu a doua variantă"):** ținta e 1 (`WANTED_SUBTITLES`): se deschide doar cel mai potrivit pachet și următorul numai dacă
  acela n-are niciun fișier pentru episod; alternativele pentru Subsync vin și de la celelalte surse. Un titlu nou = 2 cereri (3 când cel mai bun pachet nu are episodul).
  **v1.5.21 (utilizatorul: „descărcăm doar ce trebuie, nu degeaba"): descărcare LA CERERE.** La căutare se face doar 1 cerere (căutarea); pachetele nu se mai
  deschid pentru listă. Un pachet păstrat (deschis înainte) își listează fișierele reale (cost 0); unul nepăstrat apare ca un singur element (max 2),
  numit din descriere (la film descrierea listează release-urile; la serial `Show.S04E20 WEB-DL`) cu link `/proxy/download/subsro/<pachet>/pick.srt?s&e&vf&v`
  (+ `&c=<config>` pus de aggregator; cheia se citește pe server din configurație, niciodată în link). Abia când se cere subtitrarea se descarcă pachetul
  (1 cerere, partajată între cererile simultane prin `inflight`, păstrată 14 zile), se alege fișierul episodului cel mai apropiat de fișierul video
  (`pickArchiveEntry` cu `vf`) și se servește; pachet fără episod = 404 și următoarea căutare îl omite gratis. Cost: 1 cerere la un titlu nou
  neutilizat; 2 când subtitrarea Subs.ro e folosită (inclusiv pregătită de Subsync); 0 la repetări. Observat la The Greatest Showman: pachetele de film sunt mici (0,1–0,3 MB, 1–8 fișiere), descrierile lor listează numele release-urilor.
- **v1.5.21 = pachetele Subs.ro se descarcă doar când subtitrarea e cerută (1 cerere la căutare). v1.5.20 = un singur pachet (cel mai potrivit) per titlu, următorul doar dacă n-are episodul. v1.5.19 = ținta de 2 subtitrări pe sursă (Subs.ro: de regulă 2 cereri la un titlu nou). v1.5.18 = pachetele Subs.ro se deschid pe rând, cel mai potrivit întâi (2 cereri la un film nou). v1.5.16 = Subs.ro (direct) ia locul addonului Subs.ro în Priority. v1.5.15 = fix: validarea cheii Subs.ro în Services (lipsea → X roșu) și linkul corect https://subs.ro/utilizator/api. v1.5.14 = Subs.ro direct (vezi mai jos, deploy 2026-11-06).** **v1.5.12–v1.5.13 (ramura `vercel`, 2026-11-06; deploy la cererea utilizatorului):** (1.5.13 = referințe mai rapide, memoria „fără referințe", prag 30, `connect.json`) (1) căutarea referințelor Subsync
  pornește la T0, în paralel cu lista (`getAggregatedSubtitles` apelează `getReferences`, partajat prin cheie cu `prepareAligned`);
  în date, playerul cere subtitrarea imediat ce primește lista (`askedAfterMs` ≈ 0), deci nu există marjă: timp până la subtitrare =
  listă + așteptare (mediană ~4 s, p90 ~13 s înainte). (2) Referințe salvate care nu se potrivesc deloc („no reference fits well
  enough" / „disagree" / „single reference") sunt căutate din nou o singură dată (`refreshReferences`, cooldown 1 h pe cheie) și
  subtitrarea se verifică iar; cheia (`referenceKey`) nu conține numele întreg, deci nu vede montaje diferite nemenționate (Avatar:
  salvate 0%, proaspete 88–92%). Test nou în `test/subsync.test.ts` pentru pornirea la T0; calea de reîmprospătare NU e testată
  (cere Postgres pentru referințe salvate). (3) Dynamic timeout dinamic (A+C, cerut de utilizator; Family Guy: potrivire exactă la 0,5 s, ținută 6 s de
  Subs.ro care a dat timeout): potrivire exactă / hash NU așteaptă nicio sursă mai sus în Priority; altfel o sursă mai sus se așteaptă
  cât durează de obicei de la T0 (p75 din ultimele 150 de căutări, `getProviderSpeeds` în usageStore, `utils/sourceSpeed.ts`, reîmprospătat
  la 10 min în fundal), plafon `PRIORITY_WAIT_MS` = 2 s, minim 300 ms; o sursă care eșuează în >20% din căutări nu se așteaptă; necunoscută
  (instanță nouă) = 2 s. `EarlyStop.recheck` reverifică la 150 ms în primele 2,15 s.
  (5) Live activity în baza de date (cerut de utilizator; pe Vercel fiecare instanță avea propriul buffer și pașii de pe cealaltă lipseau
  sau făceau un al doilea card): `storage/activityStore.ts`, tabela `activity_events` (RLS pornit), scrisă în loturi la ~200 ms (un
  INSERT pe lot, nu pe pas), păstrată 24 h; `activity.json` citește din DB (`instance` = „db", cursorul = id) și cade pe memorie fără DB.
  `attachActivitySink` în `createServer`. Pagina unește un card făcut din pași sosiți înaintea lui „request" cu acela. Verificat pe
  Postgres 16 local (30 de pași = 1 lot, citire completă și incrementală); netestat pe Supabase.
  (6) „Fără referințe" ținut minte în DB 15 min (`noReferencesKnown` / `storeNoReferences`, rând `none|<cheie>` în `subsync_references`):
  înainte, o instanță care nu găsea referințe nu spunea celorlalte, iar fiecare subtitrare cerută de Nuvio mai căuta 3 s degeaba
  (Avatar: The Last Airbender, 2160p WEB, nu există referințe). Verificat pe Postgres 16 local. NEDEPLOYAT (comis local, 2026-11-06).
  (7) Referințele, mai repede (cerut de utilizator, NEDEPLOYAT): căutarea lor se oprește când are 3 candidate bune (`earlyStop` în
  `buildReferences`; înainte 3 s fixe, Addic7ed ținea totul) și descărcările celor mai bune pornesc din `onProgress` după 400 ms, înainte
  să se termine căutarea (`download` ține fiecare candidat o singură dată). (8) Dynamic timeout: o sursă mai sus în Priority care câștigă
  <3% și intră în top <20% (din ultimele 150 de cereri clasate) nu se mai așteaptă (`winRate`/`inTopRate` în `getProviderSpeeds`).
  (9) Pragul implicit „Dynamic timeout score" e 30 (era 40); configurațiile deja salvate își păstrează valoarea din Filters → Results.
  (10) Unealta Debug `/debug/connect.json`: 3 cereri la rând spre fiecare sursă cu agentul implicit vs conexiune nouă, ca să se vadă dacă
  reutilizarea conexiunilor câștigă ceva (Node ≥19 are keepAlive implicit în agentul global, deci probabil deja e așa).
  Măsurat pe Vercel: conexiunile sunt deja reutilizate (a doua cerere la aceeași sursă e cu 20–180 ms mai rapidă); Subs.ro are 360–535 ms
  pentru o cerere goală. **Limita Subs.ro: 300 cereri/zi pe cheia gratuită** (utilizatorul a văzut 105 azi, 2026-11-06, la mijlocul zilei);
  Nuvio are doar addonul subs2b, deci toate trec prin noi. Contor de cereri pe gazdă și zi (`utils/requestCounter.ts` = interceptor axios,
  `storage/requestCountStore.ts`, tabela `request_counts`, ruta `/debug/requests.json`, card „REQUESTS TO THE SOURCES" în Debug) ca să
  comparăm cu panoul Subs.ro; verificat pe Postgres 16 (NEDEPLOYAT). Planuri discutate: descărcări și liste salvate în DB (partajate între
  instanțe), oprire de siguranță la ~270/zi, integrare directă api.subs.ro (`/v1.0/search/imdbid/{id}`, antet `X-Subs-Api-Key`; cere
  domeniile `api.subs.ro` și `subs.ro` permise în mediu și cheia prin `request_credential`).
  **Măsurătoare Subs.ro (2026-11-06, `/quota` e gratuit și nu consumă; filmul Weapons, cu `?nocache=1`):** prima listă a unui titlu nou +4 cereri
  (căutare + pregătirea primei subtitrări prin addonul comunității); cele 3 linkuri aliniate cerute apoi +0 (addonul păstrează pachetul);
  a doua listă a aceluiași film +0. Deci un titlu NOU costă ~4 cereri la Subs.ro (nu 5–9 per Play), iar realegerile lui Nuvio nu costă;
  la 300/zi încap ~75 de titluri noi pe zi, mai mult decât uzul normal (~15–20). Integrarea directă (căutare 1 + pachet 1 = ~2 per titlu) ar tăia
  la jumătate, dar am renunțat deocamdată (pierdem numele de release din addon, sau descărcăm pachetul de 16 MB la fiecare căutare). Cheia
  **Împărțirea (a doua măsurătoare, film nou „The Fall", cota citită la 120 ms):** căutarea prin addon = +2 la Subs.ro (la 1,2 s), prima
  descărcare = +1 (la 1,6 s); Weapons dăduse +4 în total (variază cu numărul de pachete). Subs2b a trimis addonului exact 2 cereri (căutare +
  pregătirea primei subtitrări); restul îl face addonul. Un titlu nou costă deci 3–4, iar un titlu deja atins (de oricine: cache-ul addonului
  e comun) costă 0. Panoul lor număra 105 la ~19 liste. Total consumat de testele mele azi: 9 (105 → 114).
  Cheia Subs.ro a utilizatorului e în mediul cloud ca secret de rețea pentru `api.subs.ro` (injectat de proxy, nu se vede); `api.subs.ro` e în lista
  permisă. Cererile mele de test au consumat 6 din cotă (105 → 111). (4) Live activity: când prima subtitrare e de la grupul
  fișierului (link direct, nu trece prin server) lista are `meta.direct`, iar cardul arată „sent as it is" la Player asked/Delivered
  și se închide după 4 s (înainte părea că „nu s-a întâmplat nimic"). Idei rămase: prag dynamic 30, pregătirea episodului următor, plafon pentru calcul.
- **v1.5.11 (ramura `vercel`, 2026-11-06; cerut de utilizator):** LIVE ACTIVITY nu mai e consolă de text: un card pe fiecare Play, cu o bară
  de 8 puncte (Request, Search, Rank, List sent, References, Compute, Player asked, Delivered; punctul activ pulsează, bara albastră
  în lucru, VERDE o singură culoare când a reușit, galben dacă s-a terminat cu probleme) și dedesubt câte o bulină pe sursă (verde
  rapid, galben ≥1 s, roșu eșuat, albastru în așteptare, punctat „not waited for"). Evenimentele din `activity.ts` au acum `meta`
  (`step`, `state`, `ms`, `sources`, `waived`, `src`, `verdict`); cardurile se construiesc în `debug-page.js`
  (`applyActivityEvent`, `renderActivity`); un card nou la fiecare „request"; fără Subsync, cardul se închide după 4 s de la listă.
  SERVICES & ADDONS are paginare (5 implicit, 10/20/50, Prev/Next, ținută minte în browser). Test: `test/activity.test.ts`.
- **Pagina Debug reorganizată (ramura `vercel`, 2026-11-05; cerut de utilizator):** ordinea: LIVE LOG, **LIVE ACTIVITY** (nou),
  WHAT WAS ACCESSED, SERVICES & ADDONS, SUBSYNC DECISIONS, TV FORMAT TEST, SCORING RULES, DOWNLOAD FAILURES, WHEN IS THE ADDON USED
  (jos de tot). LIVE ACTIVITY arată pașii serverului în engleză (REQUEST, SEARCH, SOURCE, RANK, LIST, SYNC, SEND, DONE, WARN),
  grupați pe film; sursele individuale sunt ascunse până se pornește „Sources". Modul `src/utils/activity.ts` (buffer în memorie, 600
  evenimente, nume de instanță ca la log), ruta `/<uuid>/debug/activity.json?after=&instance=`; evenimente emise din `providers/index.ts`,
  `aggregator.ts`, `alignedPrepare.ts`, `alignment.ts`, `alignedProxy.ts`. Pe Vercel fiecare instanță are propriul buffer (ca la log):
  pagina le amestecă, dar un pas poate lipsi dacă a fost pe altă instanță decât cea care răspunde la cerere. DOWNLOAD FAILURES are acum
  paginare ca celelalte (5 implicit, 10/20/50, Prev/Next) și fiecare intrare se deschide cu clic (motivul complet).
  Cursorul „?" de la numele serviciilor (SERVICES & ADDONS) scos. Test: `test/activity.test.ts`.
- **Cronometru cap-coadă în Debug (ramura `vercel`, 2026-11-05; cerut de utilizator):** înainte, timpii erau împrăștiați și doar
  în logul din memoria unei instanțe. Acum se salvează în baza de date: (1) la fiecare listă, `details.timing` în `usage_events`
  (`totalMs`, `searchMs`, `scoringMs`, `stoppedEarly`) plus timpii pe sursă (`providers`, cu `waived` pentru cele neașteptate de
  dynamic timeout); (2) la fiecare decizie Subsync, coloana nouă `timing` JSONB în `subsync_decisions` (`subtitleMs`, `referencesMs`,
  `computeMs`, `readyAfterMs` = de la începutul pregătirii până a fost gata, `askedAfterMs` = după cât a cerut-o playerul,
  `waitedMs`). Debug arată „list ready in …", sursele de la cea mai lentă la cea mai rapidă și, la fiecare decizie, linia „time: …".
  Atenție: `waitedMs`/`ms` e cât a așteptat playerul, NU timpul de la deschidere; `askedAfterMs` ≈ timpul dintre listă și cererea
  subtitrării când a fost pregătită din timp. Se loghează doar prima cerere a unei subtitrări (repetările sunt „served again").
  Test: `test/timingRecord.test.ts`. Parametri de test pe cererea de subtitrări: `?dynamic=1|0` și `?nocache=1` (doar pentru măsurători).
- **Dynamic timeout (ramura `vercel`, 2026-11-05; cerut de utilizator, înainte refuzat):** setare nouă în Filters → Results
  (`dynamicTimeout`, `dynamicTimeoutScore`, implicit oprit / 40). Lista nu mai așteaptă tot Connector timeout (6 s) când a
  sosit ceva „bun": primul din clasament e la nivelul de sus (hash match sau nume exact) sau are scor ≥ prag, ȘI sursele pe care
  utilizatorul le pune mai sus în Priority au răspuns deja. Încă 300 ms de grație. Sursele rămase termină în fundal (`keepAlive`
  pe Vercel) și completează lista din cache (lista timpurie e ținută 2 min). Cod: `executeParallelSearch(..., { earlyStop })`
  în `providers/index.ts`, `goodEnough` în `aggregator.ts`; Debug arată sursele neașteptate ca „waived". Test: `test/dynamicTimeout.test.ts`.
  Limite per sursă (Addic7ed 2,5 s, RegieLive 3 s) încercate și scoase la cererea utilizatorului: o singură limită globală.
- **Proba pe Vercel Hobby (ramura `vercel`, nedeployată pe Render, 2026-11-05):** `api/index.js` (aplicația Express ca funcție),
  `vercel.json` (build `npm run build`, static din `dist/web/public`, rewrite spre `/api`, `maxDuration` 60),
  `src/utils/background.ts` (`keepAlive` = `waitUntil` doar pe Vercel; pregătirea Subsync și `recordUsage`), firul de calcul oprit
  pe Vercel (`SUBSYNC_WORKER=1` îl pornește), asteptarea Subsync 45 s pe Vercel. Verificat local cu `VERCEL=1`; netestat pe Vercel.
  Instrucțiuni în `deploy/vercel/INSTRUCTIUNI.md`. Plan Hobby (din căutare): 4 h procesor activ/lună, 1 vCPU / 2 GB, oprire la depășire.
- **Mutare pe Oracle Cloud Always Free (în curs, 2026-11-05; decizia utilizatorului):** fișiere pregătite în `deploy/oracle/`
  (`docker-compose.yml` cu aplicația + Caddy pentru HTTPS automat, `setup.sh`, `update.sh`, `env.example`, `INSTRUCTIUNI.md`
  în română, pas cu pas). Serverul: Ubuntu 24.04 ARM, VM.Standard.A1.Flex 2 OCPU / 12 GB, adresă gratuită DuckDNS. Se clonează
  ramura `work/subsync-engine` (repo public). Deploy-ul pe Oracle e DOAR manual (`update.sh`), ca și regula pentru Render.
  Render rămâne pornit în timpul probei; baza rămâne Supabase (același UUID). Netestat: build-ul imaginii pe ARM (fără Docker
  în cloud). Riscuri: „Out of capacity" la crearea A1, Oracle poate opri instanțele aproape nefolosite, unele site-uri pot
  refuza IP-ul Oracle. Alte variante respinse: Hugging Face (Docker plătit), Northflank (incident de securitate, variabile
  de mediu decriptate), IBM Code Engine (scalează la zero), Koyeb/Fly/Railway (fără plan gratuit potrivit).
- **v1.5.10 (deploy 2026-11-04; eficiență):** analiză cap-coadă a căii unei căutări, cu benchmark local
  (`scratchpad/perf`, nu în repo). Cel mai scump: deduplicarea (tokeniza de două ori fiecare pereche, O(n²)): 300 de
  release-uri diferite = 119 ms → 13 ms; scoring (medoid pe perechi) 45 → 21 ms; `parseRelease` și `tokenize` ținute
  în memorie (rezultatele nu sunt modificate nicăieri). Rezultate identice cu codul vechi (300 runde aleatorii,
  0 diferențe). În plus: aceeași căutare cerută simultan se face o dată (`inflightSearches` în aggregator.ts);
  cheia cache-ului ține cont de addonurile importate (`searchCacheKey`; înainte două configurații cu aceleași servicii,
  dar alte addonuri, își împărțeau răspunsul); `usageStore` păstrează detaliile (≈20 KB/cerere) doar pentru ultimele
  150 de cereri din memorie (înainte până la 5000, ~100 MB). Test nou: `test/searchShare.test.ts`. Plus: dacă referințele se potrivesc între ele (`referencesAgreeCached`) se calculează o
  dată pe lista de referințe, nu pentru fiecare subtitrare. Pe Render calculul Subsync durează secunde (log live: 4 calcule
  la rând 2,7→11,8 s, CPU ~0,1): limita reală e procesorul. Variante cercetate: Render Starter (~7 $), Oracle Always Free,
  Northflank Sandbox (0,5 vCPU/1 GB în 20 $ credit, fără card; atenție: incident de securitate anunțat de ei); Hugging Face
  Docker e acum plătit. Instrucțiuni HF rămase în `deploy/huggingface/` (neutilizabile fără plan plătit).
- **v1.5.9 (deploy 2026-11-04):** (1) „Connector timeout" e global: aceeași limită (implicit 6 s, 2–15 s) pentru servicii și
  pentru addonurile importate (înainte un addon importat avea propriul timeout de 20 s, memorat la import); câmpul din
  Edit addon e ascuns; Debug scrie „timed out after Nms". Test: `test/connectorTimeout.test.ts`. (2) Extra-urile către
  addonurile importate (1.5.8) anulate: aceleași rezultate ca fără, v3 dă 0 cu hash fără size. Măsurat pe 136 căutări:
  la 6 s se pierd ~4% din răspunsuri și ~1% din subtitrări (PRO, Addic7ed); la 4 s ~2%. Idee cerută: setare „dynamic"
  (oprire înainte de limită când există deja rezultate bune peste un punctaj): NU se face (decizia utilizatorului, 2026-11-04):
  bufferingul până la prima imagine e ~3 s, deci oricum lista nu mai contează după; posibil doar la seriale (replici de la secunda 0).
- **v1.5.8 (deploy 2026-11-04):** addonurile importate (Subs.ro, PRO, v3) sunt întrebate cu `videoHash`, `videoSize`,
  `filename` ca de player (vezi „De făcut”); cache-ul raw e pe fișier. De comparat după deploy: timpii per sursă din Debug.
  Gazdă: rămâne Render gratuit (cron-job 24/7); varianta recomandată dacă se vrea liniște: Render Starter (~7 $/lună,
  0,5 CPU, nu doarme, fără mutare; prețuri din memorie, neverificate live).
- **v1.5.7 (deploy 2026-11-04):** (1) id-ul subtitrării = etichetă citibilă (`★ Subs.ro · 2160p BluRay · MainFrame`), pentru
  Nuvio care afișează id-ul; (2) Harry Potter: subtitrare al cărei fișier lipsește de pe site => înlocuită cu următoarea
  din aceeași limbă, fișierele stricate coboară la sfârșitul listei, motivul arată răspunsul site-ului. Detalii în
  „De făcut” (secțiunile „Pe ramură” din 2026-11-04).
- **v1.5.6 (deploy 2026-10-09):**
  - OpenSubtitles: limita zilnică atinsă blochează doar cheia respectivă (`openSubtitlesApiSource(key)` =
    `api.opensubtitles.com#<8 hex din sha256>`), nu toate configurațiile (un prieten cu profil separat).
  - Testare UI amplă (Playwright, 1366×900 și 390×844, scripturi în scratchpad, server local cu Postgres):
    nota de sub Whitelist urmează lista („2 languages chosen…”), iar listă goală = limbile implicite (serverul folosea
    oricum implicitele, textul zicea „toate limbile”); limbile implicite noi: RON + ENG (buton „Romanian + English”);
    Remapping pe telefon nu mai iese din ecran (`.filters-content-area { width: 100% }`), taburile Filters pe 2 rânduri;
    „+ + Add Mapping Rule”; texte vechi la Priority, Subsync și Debug (decizii „kept in memory”); butonul Sign out lipsea
    pe telefon (acum în bara de sus); Escape și clic în afara ferestrei închid ferestrele (prin butonul ×); Debug fără
    configurație nu mai stă la „Loading...”; săgeata grupurilor din Services (arăta ca o bifă pe telefon); etichetele
    „No API Key” din grupuri scoase; textul serviciilor nu mai intră sub comutator; liniile din Live log nu se mai rup
    în mijlocul cuvintelor; iconițele de pe CDN ascunse dacă nu se încarcă; link de addon greșit → mesaj clar.
- **v1.5.5 (deploy 2026-10-09):** Addic7ed se debifa singur: pagina de configurare (`app.js`, `applyConfigWithMigration`)
  încă avea regula veche care scotea Addic7ed din config și din Priority la încărcare; la orice salvare, serverul îl
  primea oprit (live: căutările mergeau la 11 surse, fără Addic7ed). Scoasă (pe server fusese scoasă în 1.5.0).
- **v1.5.3 (deploy 2026-10-09):** testul temporar „TV FORMAT TEST” din Debug (vezi „De făcut” → TV).
- **v1.5.1 (deploy 2026-10-02):** Subsync: rapoartele lângă 1 (24/23.976) încercate mereu; lungimile ghicite de două ori
  (cu toate liniile și fără liniile singure la capete: max 3 linii la peste 2 min de rest, `withoutLoneEdges`); ambele
  ghicitori doar ADAUGĂ rapoarte de încercat. Toate liniile se aliniază și se mută în continuare. O decizie apare o
  singură dată în Debug. Caz: Gone Baby Gone (detalii mai jos).
  Test live 08:37: TiMELORDS „shifted −3.4 s ×0.999”, 0.98 (înainte −7.9 s ×1, 0.82), 3.1 s. Confirmat de utilizator: sincronizat.
- **v1.5.0 (deploy 2026-10-02):** (a doua cifră schimbată la cererea utilizatorului)
  - Clasament: o subtitrare cu numele exact al release-ului fișierului (același grup, sursă, serviciu, ediție, episod;
    orice rezoluție la WEB/TV, aceeași clasă UHD/HD la disc) intră în nivelul hash match-ului; între ele decide
    Priority, apoi punctajul (`exactNameMatch` în scorer.ts, motiv „EXACT NAME MATCH”). Caz: Homecoming S01E01–E04
    (fișier 1080p AMZN WEB-DL NTb): Subs.ro „…1080p…NTb” pierdea în fața hash match-urilor OpenSubtitles „720p…NTb”,
    „XviD-AFG”, „iNSiDiOUS”. Subtitrările forced / traduse automat nu intră în nivel prin nume.
    Test live 08:15 (Homecoming S01E05): #1 Subs.ro „…1080p…NTb” (126, EXACT NAME MATCH), #2 OpenSubtitles hash „720p…NTb” (307.5). Confirmat de utilizator.
  - Subsync: referința de la grupul fișierului decide prima (Gone Baby Gone, mai jos).
  - Addic7ed nu mai e scos din lista Priority salvată (regulă veche, de când fusese eliminat).
  - Interfață: Services grupate pliabil („No API key”, „Optional API key”, „Requires API key”, cu „x of y on”);
    Addons: „Recommended addons by the developer” (Subs.ro și OpenSubtitles PRO cu Configure, OpenSubtitles v3 cu Add);
    Debug: id-ul serviciului doar la hover / tap pe nume, ora din consolă în ora locală (24 h), buton „Copy logs”.
- **v1.4.12 (deploy 2026-10-02):** 5 servicii noi: Titrari.ro, Subtitrari-noi.ro, YIFY, Addic7ed, Wyzie (detalii mai jos).
- **v1.4.11 (deploy 2026-10-02):** probe cu `referer=`, `warm=` (cookie de sesiune), `form=` (POST), `ajax=1`.
  Constatări probe (de pe Render): Titrari.ro OK (căutare `index.php?page=cautamainaltaparte&z8=1&z5=<imdb fără tt>`,
  release în „Comentariu”, `get.php?id=` fără Referer întoarce la pagină); Subtitrari-noi.ro: rezultate prin POST
  `paginare_filme.php` (search_q, query_q, cautare, tip, an, gen); YIFY: `yts-subs.com/movie-imdb/tt…` OK, zip la
  `https://subtitles.yts-subs.com/subtitles/<slug>.zip`, `yifysubtitles.ch` blocat Cloudflare; Addic7ed OK (search.php →
  `serie/<Show>/<s>/<e>/<titlu>`, versiuni pe release, linkuri `/original/<id>/<n>`); Wyzie (`sub.wyzie.io`) cere cheie gratuită.
- **v1.4.10 (deploy 2026-10-02):** unealta Debug `/<uuid>/debug/probe.json?url=…[&as=addon]` (`src/proxy/siteProbe.ts`):
  descarcă de pe Render o pagină de pe site-urile candidate (titrari.ro, subtitrari-noi.ro, yifysubtitles.*/yts-subs.com,
  addic7ed.com, wyzie.ru/wyzie.io) și arată status, antete, corp; redirecturile trebuie să rămână pe ele.
  Log nou: `[SOURCES] saved source blocks read in X ms` (pe 1.4.9 tot apărea „not read within 5 s” fără blocări în DB).
- În 1.4.12 (deploy 2026-10-02): **5 servicii noi**, toate pornite oprite (Services):
  - `titrari.ts`: căutare după IMDb (`cautamainaltaparte&z8=1|-1&z5=`), rezultate despărțite după celula de imagine,
    limba din „[ Romana ]”, release din „Comentariu”; descărcare RAR/ZIP `get.php?id=` cu Referer.
  - `subtitrariNoi.ts`: POST `paginare_filme.php` după titlu (Cinemeta), păstrate doar cele cu IMDb-ul cerut; ZIP.
  - `yify.ts`: `yts-subs.com/movie-imdb/tt…`, doar filme, toate limbile; ZIP de pe `subtitles.yts-subs.com`.
  - `addic7ed.ts`: doar seriale; `search.php` (lent, ~7 s; continuă după limita furnizorului, ținut minte 7 zile),
    apoi pagina episodului; release `Show.S01E02.<versiune>`; descărcare cu Referer (pagina episodului, `ref=`).
  - `wyzie.ts`: API JSON `sub.wyzie.io/search?source=all&format=srt,vtt&key=`; 400 „No subtitles found” = gol;
    traducerile AI lăsate deoparte. Cheie gratuită: 1.000 cereri/zi (căutare + fiecare descărcare). Verificare cheie în server.
  - `/sub/proxy`: gazdele noi permise, Referer pe site (`REFERER_REQUIRED`, `ref=` doar de pe același site), RAR și
    cod 1250 pentru site-urile românești (ca la RegieLive), identitate de browser pentru site-urile citite ca pagini.
  - Teste pe pagini reale salvate: `test/fixtures/sources/`, `test/newSources.test.ts`.
- **v1.4.9 (deploy 2026-10-02):** tabele create fără să aștepte blocări (`dbTools.ensureTableSafely`), `query_timeout` 20 s,
  pagina Debug `db.json`, **RLS pornit pe toate tabelele** (Supabase Advisor: „RLS Disabled in Public”, CRITICAL; utilizatorul
  l-a pornit manual în SQL Editor pe 2026-10-02, codul îl pornește doar dacă e oprit, fără blocare). Serverul e proprietarul
  tabelelor, deci RLS nu-l afectează (verificat local). `source_blocks` exista deja pe Supabase pe 2026-10-02.
- **v1.4.8:** 1.4.7 a trecut build-ul pe Render, dar nu a devenit live (rămăsese 1.4.6): pornirea aștepta citirea
  `source_blocks` din Postgres înainte de `listen`. Acum serverul pornește întâi, citirea se face în fundal (max 5 s).
  Regulă: nimic din baza de date nu se așteaptă înainte de `app.listen`.
  Live 09:21: pornit în 0.5 s, dar `CREATE TABLE IF NOT EXISTS source_blocks` atârnă (fără eroare, >1 min) → memoria
  surselor blocate e doar în RAM.
- În 1.4.9: `src/storage/dbTools.ts`. `ensureTableSafely`: întâi `to_regclass` (nu poate fi
  blocat), apoi `CREATE` cu `SET LOCAL lock_timeout = '5s'`; la eroare conexiunea se închide (nu se întoarce în pool).
  Folosit la `source_blocks` și `subsync_references` (reîncercare la 10 min). Pool cu `query_timeout: 20000`.
  Pagina Debug nouă `/<uuid>/debug/db.json`: sesiunile care nu sunt idle, cine pe cine blochează (`pg_blocking_pids`),
  ce tabele există, starea pool-ului. Reprodus local (Postgres 16): o sesiune „idle in transaction” care a început
  `CREATE TABLE source_blocks` blochează orice alt CREATE la nesfârșit; varianta nouă renunță în 5 s cu „lock timeout”.
- **v1.4.7 (deploy 2026-10-01):** sursele blocate ținute minte în Postgres peste reporniri; rezerve și pentru hash match;
  o subtitrare pe care n-o poate descărca nimeni coboară ultima (eroarea de la Downton Abbey S03E03).
- **v1.4.6 (deploy 2026-10-01):** referințe independente (fără cele de la release-ul subtitrării verificate), release-uri
  în paranteze drepte recunoscute, candidați și timpi în log, descărcări în paralel, fir de calcul pornit la start.
  **Podnapisi scos complet** (închis definitiv în martie 2026); configurațiile salvate cu el sunt curățate automat.
  Rămâne `src/utils/titleInfo.ts` (Cinemeta, folosit de RegieLive).
- **v1.4.5 (deploy 2026-10-01):** surse care refuză serverul ținute minte (`sourceHealth`), copii descărcabile preferate,
  subtitrări neverificabile mai jos, referințe în Postgres, ediția filmului în Subsync, **Podnapisi** (serviciu nou,
  fără cheie, pornit din Services; `src/providers/podnapisi.ts`, căutarea `search/old?sXML=1` din subliminal/Bazarr,
  descărcare zip prin `/sub/proxy`). **Live: `getaddrinfo ENOTFOUND www.podnapisi.net`; site-ul nu se deschide nici la
  utilizator (pare închis).** Codul rămâne; utilizatorul îl oprește din Services. slo-podnapisi.net NU e același site
  (~37 000 subtitrări, probabil doar slovene), nu se folosește.
- Teste live v1.4.5: Utopia S01E03 sincronizat (−0.1 s, 2 bucăți, 3 referințe SHORTBREHD, 4.5 s). Sisi S02E04
  (release italian `iTALiAN ... Pir8`): nicio referință descărcabilă (OpenSubtitles blocat azi) și oricum nu există
  subtitrări pentru varianta italiană → original. Limită de principiu: Subsync are nevoie de o subtitrare făcută pentru
  același release; fără ea, release-urile dublate în altă limbă nu pot fi sincronizate.
- **v1.4.4 (deploy 2026-10-01):** motor Subsync mai rapid, fir separat, pornire din timp, playerul așteaptă decizia; rezerve la descărcare; referințe care cruță limita OpenSubtitles; log `[DOWNLOAD]`.
- **v1.4.3 (deploy 2026-10-01):** Subsync verifică orice subtitrare care nu e de la același grup cu fișierul (cazul The Chaser).
  Tagurile v1.4.2–v1.4.12, v1.5.0–v1.5.10 de pus (v1.4.7 n-a ajuns live) de pe calculatorul utilizatorului.
  - Test live The Chaser (REMUX Shamir, MULTi/francez): declanșat, 3 referințe „FRA BluRay Remux ZQ”, subtitrarea
    FraMeSToR „shifted −0.2 s ×0.959 in 2 parts” (82%). Ediția franceză rulează mai repede (×0.959 = 1/1.043, 25 fps).
    Utilizatorul a confirmat pe telefon: sincronizată la început și la final.
  - Observații: Stremio a refolosit lista veche ~30 min după deploy (`Cache-Control: max-age=1800`); aceeași subtitrare
    s-a re-aliniat de 13 ori în 2 min (playerul o cere din nou; ~40–90 ms fiecare, rezultatul nu e ținut în cache).
- **v1.4.2 (live din 2026-10-01):** fix titlu Andor; declanșare și referințe pe familia sursei; candidat verificat;
  scos codul vechi `fitOffset`/`decideAlignment` din `src/utils/timeline.ts`. Tagul v1.4.2 încă nu e pus (de pus de pe calculatorul utilizatorului).
- Teste live 2026-10-01 (din logurile Debug):
  - Big Bang S01E06 (REMUX 1080p FraMeSToR): s-a declanșat (hd disc), 3 referințe BluRay, „shifted 0.7 s ×1.045”.
  - Friends S03E08 (UHD REMUX FraMeSToR): s-a declanșat (uhd disc), 1 referință (arabă, pachet de sezon), „shifted −0.1 s ×1.043”.
  - The Chaser (REMUX): corect nedeclanșat (există subtitrare FraMeSToR).
  - Andor S01E01 (Star.Wars.Andor UHD REMUX HYPERION): „21_Romanian---Andor” și „Star.Wars.Andor…NTb” sunt acum păstrate.
    Declanșat, 3 referințe UHD REMUX. Decizia de aliniere nu era încă în log.
  - Andor: decizia a fost „already aligned” (97%, 2 referințe). Big Bang: 2 referințe agree. Friends: o singură referință (88%).
    „Scoring: 15 → 5” la Andor: 7 vizibile sunt alt episod (E6–E12 SubDL); 3 nu se văd (Debug arată doar primele 12).
  - The Chaser: utilizatorul a raportat subtitrarea desincronizată, deși era nedeclanșat. Comparând 12 subtitrări din alte
    limbi: edițiile Blu-ray (KOR/GER/AUS) se potrivesc între ele (≤0.7 s), dar una „BluRay CHD” era ×1.043 și una NF −12 s.
    → Schimbare pe ramură (nedeployată): se verifică orice subtitrare care nu e de la același grup.
  - **De verificat:** sincronizarea pe ecran (Big Bang, Friends, The Chaser după deploy); timpul de răspuns, acum că
    mult mai multe filme trec prin verificare.
  - The Chaser la play: subtitrarea a venit după 20 s (calcul de ~18 s pe Render, care bloca serverul; bugetul de 5 s nu
    funcționa fiindcă ceasul nu putea porni). Bufferingul de 7–10 s de la început a fost al fișierului video.
    → Pe ramură (nedeployat): motor ~3.5× mai rapid (spectre refolosite, FFT pe jumătate; 582/582 decizii identice),
    fir separat, pornire din timp, playerul așteaptă decizia.
  - Idei: Debug să arate toate respinsele, nu doar primele 12; titlu lipit de rezoluție („amb-friends720p”) e respins greșit.

## Surse și limite (2026-10-01)
- Căutarea întreabă toate sursele în paralel; ordinea finală o dă punctajul. `providerPriority` (Filters → Priority)
  decide doar ce copie rămâne la deduplicare și ordinea la egalitate. Ordinea utilizatorului: Subs.ro, RegieLive,
  OpenSubtitles v3 (addon), opensubtitles PRO (addon), OpenSubtitles (serviciu, cheia lui), SubDL, Subsource.
- OpenSubtitles direct = cheia API a utilizatorului, fără cont: limită zilnică mică de descărcări. Pe 2026-10-01
  referințele Subsync (Utopia) au primit `HTTP 469`. Addonurile descarcă prin serverele lor (nu consumă cheia).
- Pe ramură (nedeployat, pentru 1.4.4):
  - Deduplicarea păstrează copiile ca rezerve (`backups`, max 2). Linkurile cu rezerve trec prin
    `/:config/sub/fallback/<token>.srt` (sau `b` în tokenul aligned); serverul încearcă sursele în ordine.
  - Referințe Subsync: OpenSubtitles pierde doar la egalitate de punctaj; se descarcă doar câte trebuie (3), restul doar
    ca înlocuitori; referințele OpenSubtitles se iau întâi de pe mirroare (`mirrorFirst=1`), API-ul e rezervă.
  - Log `[DOWNLOAD]`: motivul fiecărui pas (inclusiv mesajul OpenSubtitles despre limită, `remaining`, `reset`).

- Test live v1.4.4 (2026-10-01): cheia OpenSubtitles a utilizatorului are **100 descărcări / 24 h** (consumate azi, în
  mare de referințele Subsync). De pe Render: `dl.opensubtitles.org` → 403, `subs5.strem.io` (addonul v3) → 469.
  Addonul PRO (`opensubtitles.stremio.homes`) merge de pe server. Utopia S01E02: 5 referințe OS picate → original după 6.6 s.
- Pe ramură (nedeployat, pentru 1.4.5):
  - `src/utils/sourceHealth.ts`: serverul ține minte sursele care îl refuză (406 până la ora de resetare din mesajul
    OpenSubtitles; 403/469 30 min; 429 15 min; 503 5 min) și nu le mai încearcă. Log `[SOURCES]`.
  - `serverCanDownload(item)`: la deduplicare rămâne copia descărcabilă (cea blocată devine rezervă); subtitrările
    nedescărcabile (deci neverificabile) coboară la final când Subsync e necesar; referințele blocate nu se încearcă.
  - Referințele Subsync salvate în Postgres (`subsync_references`, doar timpii la ms, gzip, 60 zile, comune tuturor).
  - Ediția filmului (cut: extended, unrated, directors, uncut, finalcut, special; theatrical = normal) intră în încredere
    (același grup + aceeași ediție), în alegerea referințelor și în cheia lor. Punctajul o folosea deja (+10 / −12 / −3).

- Downton Abbey S03E01 (2026-10-01): pe REMUX FraMeSToR, subtitrarea SHORTBREHD a fost „already aligned” (94%) fiindcă
  2 din 3 referințe erau tot SHORTBREHD (s-au confirmat singure); utilizatorul a avut nevoie de +2.2 s, iar spre final
  nici asta nu mai mergea (versiuni ușor diferite, 1h06). Pe WEB-DL playWEB a mers: subtitrarea Subs.ro era chiar pentru
  playWEB (scris în paranteze drepte), dar n-a fost recunoscută ca același grup; prima cerere a durat 10.7 s (calcul ~8 s).
- În 1.4.6 (deploy 2026-10-01):
  - `variantsOf`/`bracketedReleases` (scorer.ts): release-urile din paranteze drepte contează la punctaj (doar adaugă, nu
    pot salva alt episod) și la „același grup”.
  - Referințe independente: în `alignAgainst` se scot referințele de la release-ul subtitrării verificate (nota apare în
    Debug); „no independent reference” dacă nu rămâne niciuna. Oprirea după 2 referințe de acord doar dacă vin de la
    release-uri diferite. Alegerea referințelor: întâi câte una pe grup. Cheia referințelor: `v2|...`.
  - Log `[SUBSYNC] reference candidates` (și motivele celor sărite) și `[SUBSYNC] timing` (subtitrare / referințe /
    calcul). Subtitrarea și referințele se descarcă în paralel. Firul de calcul pornește odată cu serverul.

- Downton Abbey S03E02 pe 1.4.6 (REMUX FraMeSToR): subtitrarea SHORTBREHD n-a mai fost „confirmată” de propriul release;
  n-a fitat referințele independente → înlocuită cu alternativa DKV (HMAX WEB-DL), mutată +1.5 s după referințele
  SHORTBREHD pt-PT + Dansk (Blu-ray). Tot nesincronizat: nu există nicio subtitrare pentru REMUX/FraMeSToR, iar Blu-ray-urile
  găsite au alt timing (RARBG chiar ~41 s). Primul răspuns a durat 12.8 s (calcul 11.3 s). Pe WEB-DL playWEB merge.
  Utilizatorul: „avem ceva funcțional, revenim altădată”.

- **Eroare Downton Abbey S03E03 (SHORTBREHD BluRay) pe 1.4.6:** primul loc era OpenSubtitles direct cu HASH MATCH, dar
  limita era terminată; deploy-ul șterge memoria surselor blocate (doar RAM) și hash match-urile nu primeau rezerve →
  playerul a primit eroare. Reparat în 1.4.7: `source_blocks` în Postgres (`storage/sourceBlockStore.ts`,
  citit la pornire), `copiesOf` dă rezerve și hash match-urilor (copia care merge îi ia locul, rămâne hash match),
  o subtitrare cu link prin server la o sursă blocată, fără copie, coboară ultima mereu (și cu Subsync oprit).

- **Gone Baby Gone (2026-10-02, 1.4.12):** fișier REMUX EPSiLON; subtitrarea TiMELORDS (Subs.ro) n-a fost mutată fiindcă
  referința `[zh-CN] …REMUX…-EPSiLON` (exact release-ul fișierului) zicea −7.9 s, iar `[pt-PT] …REMUX-FraMeSToR` −2.3 s
  („references disagree”). Primul răspuns a durat 12.7 s (calcul 10.3 s).
  → În 1.5.0: `alignAgainst(..., fileName)`: referințele de la grupul fișierului (nu și al subtitrării)
  se încearcă primele, singure, cu prag 0.70 (`FILE_REFERENCE_MIN_OVERLAP`); dacă subtitrarea se potrivește cu ele,
  decizia e luată (nota „followed the reference(s) made for the file's own release”), altfel regulile obișnuite.
  Plus: avertismentul „not read within 5 s” nu mai apare când citirea a reușit.
- **Gone Baby Gone pe 1.5.0:** referința EPSiLON a decis (−7.9 s), dar subtitrarea TiMELORDS tot nesincronizată.
  Comparând subtitrările românești aliniate: Z0N3 și playHD (0.98 pe referința zh-CN) se potrivesc între ele, TiMELORDS
  (0.82) diferă de ele cu o derivă liniară +4.5 s → −1.9 s pe film = raport 24/23.976 (×0.999), pe care motorul nu l-a încercat:
  rapoartele se aleg după lungimea celor două subtitrări, iar o linie departe de dialog în referință (notă de traducător
  după final) o strică. Reprodus local (−7.8 s, 0.83). → În 1.5.1: rapoartele lângă 1 (24/23.976) se încearcă mereu
  (`subsync.ts`); local dă ×0.999 −3.4 s, 1.00. Test în `subsyncEngine.test.ts`. Benchmark-ul (corpusul) nu e în cloud.
  Plus: o decizie Subsync apare o singură dată în Debug (playerul cere aceeași subtitrare de mai multe ori; repetările
  sunt doar „served again from memory”).

## De făcut (în ordinea discutată)
- **v1.5.2 (deploy 2026-10-02):**
  - SRT trimis ca `application/x-subrip` (nu `text/plain`), pentru eticheta „PGS” de la prima subtitrare (de verificat
    pe telefon după deploy, ex. Peacemaker).
  - Liste ținute 2 min (`SHORT_CACHE_MINUTES`) și pe server, și în Stremio (`cacheMaxAge` + `Cache-Control`) când o sursă
    a dat eroare / a depășit timpul sau nu e nicio subtitrare în limbile alese; altfel `cacheTtlMinutes` (30); eroare =
    `no-store`. Log `[CACHE] kept 2 min only: …`.
  - Titlu lipit de rezoluție („amb-friends720p”, „1080pBluRay”) despărțit la parsare; „friends720p” nu mai e grup.
  - Debug: toate subtitrările respinse (max 60, pliate), nu doar primele 12.
  - Debug: jurnal de descărcări eșuate (`utils/downloadJournal.ts`, tabela `download_failures`, 30 zile, citit în fundal
    la pornire; `/debug/downloads.json`): eșecuri de la `/sub/proxy`, OpenSubtitles, RegieLive, convert (orice 5xx) și
    din linkurile cu rezerve („recovered” când o copie a mers). Verificat local pe Postgres 16 (rămâne după repornire, RLS pornit).
  - Debug: „SCORING RULES” → Measure (`/debug/rules.json`, `utils/ruleImpact.ts`): fiecare regulă opțională e inversată
    pe clasamentele salvate (ultimele 1000 cereri cu nume de fișier) și se numără de câte ori s-ar schimba prima
    subtitrare. `exactTier` e acum regulă (pornită). Pe datele live (75 cereri, 2026-10-02): fuzzyGroup 0, sourceTiers 0,
    multiVariant 0, exactTier 6 (Homecoming: Subs.ro NTb 1080p în loc de hash-ul OpenSubtitles 720p / XviD-AFG).
    Limită: se re-clasează doar ce e salvat (primele 12 + respinsele).
- **TV (2026-10-09):** pe Stremio TV nicio subtitrare subs2b nu afișează text (pe telefon merg aceleași). Serverul le
  primește cererile și răspunde (Loki 2026-10-08: toate 5 cerute în aceeași secundă, servite). Prima subtitrare pe
  telefon apare „PGS” și goală la Peacemaker CRU „PL” (probabil pista internă poloneză PGS încurcată de player).
  Utilizatorul nu mai folosește Stremio pe TV din cauza asta. Diferențe față de alte addonuri: `application/x-subrip`
  din 1.5.2 (înainte `text/plain`) și linkuri lungi (2–4.5 KB, tokenul poartă alternativele). → În 1.5.3: test temporar
  (`src/proxy/formatTest.ts`, buton Debug „TV FORMAT TEST”, 2 h): prima subtitrare de încă 4 ori sus: 1 text/plain link
  lung, 2 text/plain scurt, 3 x-subrip scurt, 4 VTT scurt; log `[FORMAT TEST] variant N requested` (cu user-agent).
  După rezultat: toate linkurile pe varianta care merge (linkuri scurte = token ținut pe server/în DB), testul scos.
  **Rezultat 2026-10-09:** pe TV toate 4 variantele merg (Loki), și Endgame (care nu mergea înainte) merge acum, după ce
  utilizatorul a reinstalat addonul în Stremio. Deci nici tipul (`x-subrip`), nici lungimea linkului nu sunt cauza pe
  TV-ul lui. Cauza rămâne neclară (probabil starea aplicației Stremio de pe TV, curățată de reinstalare). Testul rămâne
  în Debug (oprit) pentru data viitoare: întâi testul, apoi reinstalarea, ca să se vadă dacă e serverul sau aplicația.
- **v1.5.4 (deploy 2026-10-09):** Debug → SUBSYNC DECISIONS: fiecare referință arată și sursa
  („[ron · Subtitrari-noi.ro] …”; câmpul `provider` în deciziile noi, cele vechi n-au), iar numele cu multe release-uri
  (Subtitrari-noi.ro le listează pe toate, ex. Endgame ~70) apar scurtate: primul + „+ N more releases”, tot numele la
  hover sau tap.
- **v1.5.7: etichete citibile ca id de subtitrare** (2026-11-04). Nuvio afișează
  `id`-ul sub limbă (niciun player nu arată `title`), deci `id` = `★ Subs.ro · 2160p BluRay · MainFrame`
  (`src/utils/subtitleLabel.ts`): sursa, rezoluție + serviciu + sursă (REMUX/BluRay/BRRip/WEB-DL...), XviD când e cazul,
  grupul; ★ doar la nivelul de sus (hash match sau nume exact); max 44 caractere; depinde doar de subtitrare și fișier,
  nu de poziție sau scor (stabilă la fiecare deschidere); repetările primesc „ (2)”. La numele cu multe release-uri se
  folosește varianta cea mai apropiată de fișier. `title` rămâne numele release-ului. Testele vechi care căutau id-urile
  tehnice au fost adaptate (providerValidation, vttConvert). Nuvio are și el auto-sync, după pista embedded din fișier
  („Auto synced” / „autosync failed” în meniul lui; nu vine de la noi): se completează cu Subsync-ul nostru.
- **v1.5.7: Harry Potter și piatra filozofală (2026-11-04).** Prima subtitrare (Subtitrari-noi
  `subtitrarinoi-24773`, release TASTED) dădea în Nuvio „autosync failed”, a doua (Subs.ro, același release) mergea.
  Cauza: nu format și nu antet. Site-ul răspunde 200 cu un text de 100 de octeți („Ne pare rău, subtitrarea nu este
  disponibilă momentan. Vă rugăm să contactați administratorul.”) în loc de arhivă, chiar și cu Referer și sesiune
  (probe.json); serverul dădea 502 și lista o ținea pe primul loc (jurnalul: 16 eșecuri la același fișier).
  Reparat: (1) `loadWithAlternatives` (alignedPrepare.ts): dacă fișierul subtitrării alese nu se poate descărca,
  se ia următoarea din aceeași limbă (alternativele din token), alinierea merge pe ea, Debug arată „replaced by” cu
  motivul, jurnalul „replaced”; fără alternative rămâne 502; (2) `utils/brokenFiles.ts`: un fișier fără bloc de timp
  sau gol e ținut minte 3 h (în memorie) și `serverCanDownload` îl dă drept nedescărcabil, deci coboară la sfârșitul
  listei (un răspuns HTML/JSON nu, poate fi doar o blocare); (3) motivul invalid arată ce a spus site-ul când răspunsul
  e scurt și text. Verificat live pe 1.5.7 (2026-11-04 12:50): prima subtitrare (fișier lipsă) → HTTP 200, 1219 replici, înlocuită de a doua (Debug: „replaced by”, „already aligned (the subtitle could not be downloaded…)”); etichetele apar în listă.
- **Nuvio TV, din codul sursă (github.com/NuvioMedia/nuviotv, citit 2026-11-04, versiunea „bump version” din 4 nov):**
  - Cere subtitrările de la TOATE addonurile în paralel, cu **20 s per addon** (`PER_ADDON_TIMEOUT_MS = 20_000` în
    `data/repository/SubtitleRepositoryImpl.kt`; peste, addonul e ignorat); clientul HTTP are connect 30 s / read 60 s
    (`core/di/NetworkModule.kt`), deci limita efectivă e 20 s.
  - Trimite el însuși `videoHash`, `videoSize`, `filename` în forma `/subtitles/<tip>/<id>/videoHash=..&videoSize=..&filename=...json`;
    hash-ul îl calculează el (`OpenSubtitlesHasher`) înainte de cerere.
  - Meniul de subtitrări (`SubtitleSelectionOverlay.kt`): titlul = limba, eticheta sursei = numele addonului, rândul de
    jos = `subtitle.id` al nostru (de aici etichetele citibile, `meta`), sortat după ORDINEA addonurilor instalate (apoi
    ordinea sosirii) — deci ipoteza „apar în ordinea sosirii” NU e adevărată pentru TV; subs2b, primul instalat, ar trebui
    să fie primul. id-ul opțiunii = `addon:<nume>:<id>:<url>`.
  - Auto-sync propriu (`ui/screens/player/autosync/AutomaticSubtitleSync.kt`): descarcă el subtitrarea aleasă, cu **timeout
    15 s** (`SUBTITLE_DOWNLOAD_TIMEOUT_MS`); „autosync failed” apare și când linkul dă eroare (cazul Harry Potter, 502).
  - Consecință pentru noi: o listă care ajunge la ~20 s (opensubtitles PRO are timeout 20 s la noi) e abandonată de Nuvio
    ÎNTREAGĂ; 9 din 144 de căutări (6%) au avut sursa cea mai lentă la ≥19 s, toate PRO. Ținta: listă sub ~8–10 s și
    subtitrare aliniată gata sub 15 s. Cererea Social Network (11,9 s) NU ar fi trebuit tăiată de Nuvio: neexplicată.
  - Se verifică versiunea instalată de utilizator (poate diferi de repo); aplicația de telefon e alt cod.
- **Extra-uri către addonurile importate: ÎNCERCAT în 1.5.8 și ANULAT (1.5.9, 2026-11-04).** Ideea: trimis `videoHash`,
  `videoSize`, `filename` ca playerul. Măsurat live pe filme reale (A/B, aceleași filme cu și fără extra): numărul de
  rezultate e IDENTIC (The Social Network: PRO 24, v3 85, Subs.ro 10; Fantastic Four: PRO 7, v3 99, Subs.ro 12), deci nu
  aduce nimic; timpii nu s-au îmbunătățit (PRO a avut 11,9 s cu extra și 3,6 s fără; comparația e influențată de cache-ul
  lor la a doua cerere). În plus: cu hash FĂRĂ videoSize, OpenSubtitles v3 întoarce 0 rezultate (Peacemaker 69 → 0), deci
  riscul e de pierdere, nu câștig. Concluzie: copiile addonurilor din subs2b dau aceleași rezultate ca playerul, deci
  Subs.ro și PRO pot fi scoase din Nuvio fără pierdere de conținut. Lecție: un test cu cereri făcute de mână trebuie să
  ia TOATE valorile reale (hash + size + nume), nu doar o parte.
- **v1.5.7: etichete citibile ca id de subtitrare** (2026-11-04). Nuvio afișează
  `id`-ul sub limbă (niciun player nu arată `title`), deci `id` = `★ Subs.ro · 2160p BluRay · MainFrame`
  (`src/utils/subtitleLabel.ts`): sursa, rezoluție + serviciu + sursă (REMUX/BluRay/BRRip/WEB-DL...), XviD când e cazul,
  grupul; ★ doar la nivelul de sus (hash match sau nume exact); max 44 caractere; depinde doar de subtitrare și fișier,
  nu de poziție sau scor (stabilă la fiecare deschidere); repetările primesc „ (2)”. La numele cu multe release-uri se
  folosește varianta cea mai apropiată de fișier. `title` rămâne numele release-ului. Testele vechi care căutau id-urile
  tehnice au fost adaptate (providerValidation, vttConvert). Nuvio are și el auto-sync, după pista embedded din fișier
  („Auto synced” / „autosync failed” în meniul lui; nu vine de la noi): se completează cu Subsync-ul nostru.
- **v1.5.7: Harry Potter și piatra filozofală (2026-11-04).** Prima subtitrare (Subtitrari-noi
  `subtitrarinoi-24773`, release TASTED) dădea în Nuvio „autosync failed”, a doua (Subs.ro, același release) mergea.
  Cauza: nu format și nu antet. Site-ul răspunde 200 cu un text de 100 de octeți („Ne pare rău, subtitrarea nu este
  disponibilă momentan. Vă rugăm să contactați administratorul.”) în loc de arhivă, chiar și cu Referer și sesiune
  (probe.json); serverul dădea 502 și lista o ținea pe primul loc (jurnalul: 16 eșecuri la același fișier).
  Reparat: (1) `loadWithAlternatives` (alignedPrepare.ts): dacă fișierul subtitrării alese nu se poate descărca,
  se ia următoarea din aceeași limbă (alternativele din token), alinierea merge pe ea, Debug arată „replaced by” cu
  motivul, jurnalul „replaced”; fără alternative rămâne 502; (2) `utils/brokenFiles.ts`: un fișier fără bloc de timp
  sau gol e ținut minte 3 h (în memorie) și `serverCanDownload` îl dă drept nedescărcabil, deci coboară la sfârșitul
  listei (un răspuns HTML/JSON nu, poate fi doar o blocare); (3) motivul invalid arată ce a spus site-ul când răspunsul
  e scurt și text. Verificat live pe 1.5.7 (2026-11-04 12:50): prima subtitrare (fișier lipsă) → HTTP 200, 1219 replici, înlocuită de a doua (Debug: „replaced by”, „already aligned (the subtitle could not be downloaded…)”); etichetele apar în listă.
- **v1.5.8 (2026-11-04; cerut de utilizator):** addonurile importate (Subs.ro, PRO, v3) sunt întrebate de
  noi doar cu `/subtitles/<type>/<id>.json`, FĂRĂ extra (`filename`, `videoHash`, `videoSize`) pe care le trimite playerul
  (`src/providers/genericStremioAddon.ts`): copiile din subs2b pot da rezultate mai slabe decât addonurile puse direct în
  Nuvio/Stremio (PRO/v3 pun întâi hash match-ul). De trimis extra în forma Stremio `/subtitles/<type>/<id>/<extra>.json`
  (cheia raw din cache conține deja videoHash). Abia apoi are sens ca utilizatorul să scoată din Nuvio Subs.ro și PRO
  (duplicate ale surselor din subs2b); Community Subtitles rămâne separat. FĂCUT pe ramură: `extraPathOf` trimite
  `videoHash`, `videoSize`, `filename` în forma Stremio; un addon care răspunde 4xx la calea cu extra e întrebat din nou
  simplu (eroare 5xx/429/rețea = eșec, fără a doua încercare); cheia cache-ului raw ține cont de fișier (hash, altfel nume).
  Test: `test/genericAddon.test.ts` (server mock). După deploy: comparat timpii per sursă din Debug cu cei de dinainte
  (mediană PRO 2,0 s, Subs.ro 1,1 s, v3 0,56 s) ca să se vadă dacă extra-urile încetinesc. Context: în Nuvio rezultatele subs2b apar
  ultimele (ipoteză: ordinea sosirii; noi răspundem în ~5 s pe un film nou, ~1 s repetat, iar opensubtitles PRO,
  addon importat cu timeout 20 s, e cea mai lentă sursă în 88 din 146 de căutări; mediană 2 s, p90 13 s). Test propus:
  a doua deschidere a aceluiași film + timeout PRO 3–4 s (Addons → Edit). Idei dacă se confirmă: răspuns după ~3 s cu
  ce avem (restul în fundal), sau sloturi fixe (pierd etichetele citibile).
- **Pentru mai târziu (cererea utilizatorului, 2026-10-02): „slot” ca la Stremio Community Subtitles.** Primul loc din listă
  = link fix către server (`no-store`); serverul trimite ce e ales acum. Pagină „Now playing” în interfață: alegi altă
  subtitrare dintre cele găsite și/sau muți manual (+/− s), fără să cauți în Stremio; alegerea ținută minte pe fișier și
  folosită la clasament (vezi „Feedback la alegerea manuală”). Restul listei rămâne la fel. **Întâi o probă:** un slot
  care își schimbă singur decalajul, ca să vedem dacă/când Stremio reîncarcă subtitrarea (telefon și TV); din loguri,
  playerul o cere uneori de mai multe ori (The Chaser 13× în 2 min, Gone Baby Gone 3×). Dacă nu reîncarcă singur,
  schimbarea se vede după oprit/pornit subtitrarea sau derulare.
- Subsync pe REMUX: încredere doar în referințe REMUX (sau ale grupului fișierului); altfel subtitrarea neschimbată.
- Limită de timp pentru calculul suplimentar (verificarea pe bucăți + alternative) când prima verificare a durat mult.
- Semn vizibil în Stremio când serverul trimite altă subtitrare decât cea aleasă („replaced by”), legat de mesajul custom.
- „PGS” la prima subtitrare (fix pe ramură, vezi mai sus). Ipoteze: piste PGS din REMUX, sau linkuri fără `.srt` / MIME `text/plain`.
  Direcție: linkuri care se termină în `.srt`, cu `application/x-subrip`.
  Nou (2026-10-01, 1.4.8, telefon): Peacemaker S01E01 2160p HMAX WEB-DL CRU → prima subtitrare a addonului apare „PGS”,
  următoarele 4 „SRT”. Toate 5 sunt linkuri `/sub/aligned/<token>.srt` (deci nu pista video și nu lipsa `.srt`).
  Prima a fost pregătită din timp (servită în 0 ms, −5 s, 2 referințe). Răspunsul are `Content-Type: text/plain`.
  De verificat ce face Stremio diferit cu prima (auto-selectată) și dacă `application/x-subrip` schimbă eticheta.
- Mesaj custom la începutul filmului (oprit / tehnic / text propriu; `{\an8}` doar dacă nu există gol; de testat pe dispozitive).
- Feedback la alegerea manuală a altei subtitrări (pentru clasament).

## Limitări în cloud
- Nu există Docker și nici corpusul local de benchmark.
- Backslash-urile din comenzile inline se strică: folosește fișiere sau Edit.
