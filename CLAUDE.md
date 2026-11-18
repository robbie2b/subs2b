# subs2b: context de lucru pentru Claude

Fișierul ăsta e citit automat la începutul fiecărei sesiuni: ține-l SCURT. La finalul fiecărei etape importante:
adaugă o intrare detaliată (ce s-a făcut, ce a ieșit la teste, ce a rămas) sus, la „Istoric recent” din `docs/ISTORIC.md`,
și actualizează aici doar „Stare”, „Decizii” și „De făcut”. Detaliile vechi (versiuni, cifre, motive) sunt în `docs/ISTORIC.md`.

## Proiectul
- Addon Stremio de subtitrări cu clasament inteligent (TypeScript / Node / Express). Repo: `robbie2b/subs2b`.
- Rulează pe **Vercel** (ramura `vercel`, plan Hobby, mai multe instanțe) cu Postgres pe Supabase; `https://subs2b.vercel.app`. Render (ramura `main`, plan gratuit, ținut treaz de un cron-job.org) rămâne doar la cerere explicită.
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
- `https://subs2b.vercel.app/<uuid>/debug/{recent,usage,providers,alignments,logs,activity,db,downloads,requests}.json`. Cere doar UUID-ul, fără parolă.
- UUID-ul e în variabila de mediu `SUBS2B_UUID` a mediului cloud (citit doar la pornirea sesiunii).
  Accesul la rețea către `subs2b.vercel.app` (și `subs2b.onrender.com`) e permis (Custom).
- Exemplu: `curl -s "https://subs2b.vercel.app/$SUBS2B_UUID/debug/alignments.json"`

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

## Reguli tehnice (de ținut minte)
- **`ALIGN_ENGINE_VERSION`** (în `src/storage/alignedStore.ts`, acum **3**): se urcă ori de câte ori se schimbă logica de aliniere (motorul din `utils/subsync.ts`, alegerea referințelor, ce înseamnă „se potrivește”, `alignDecision.ts`) SAU felul în care se citește textul subtitrării (parser de rânduri, codare). Deciziile vechi din `aligned_cache` nu se mai găsesc și pleacă singure.
- **Teste:** `npm test` exportă `ALLOW_PRIVATE_HOSTS=1` (testele folosesc servere pe 127.0.0.1; paza SSRF din `utils/publicUrl.ts` le-ar refuza). Un test rulat singur are nevoie de `ALLOW_PRIVATE_HOSTS=1`. Părțile cu baza de date rulează doar cu `TEST_DATABASE_URL=postgres://pgtest:pgtest@localhost:5432/postgres` (Postgres 16 local; dacă e oprit: `service postgresql start`).
- Nimic din DB nu se așteaptă înainte de `app.listen`. Orice rută `app.get/post` e învelită în `safeHandler`. Erorile (≥400) și redirecturile de rezervă sunt `no-store`.
- Linkurile din listă NU poartă chei API (`kt` = hash scurt al cheii, `c` = UUID-ul profilului; cheia o citește serverul din configurație).
- Profilele (UUID) sunt separate în Debug (`utils/requestContext.ts`); datele comune fără identitate: cache-ul listelor, referințele Subsync, `aligned_cache`.
- Subsync-ul ține minte rezultatul în DB (`aligned_cache`, buget 150 MB, cele mai vechi folosite pleacă primele) și are un marker „în lucru” între instanțe (`claimWork`). Pagina Debug nu cere nimic cât tabul e ascuns.
- Rezultatele fiecărei liste (timpi, surse, scoruri, limbi, `preMs`, `instance`) sunt în `usage_events` / `recent.json`; deciziile Subsync în `subsync_decisions` (cu MCC); `db.json` arată tabelele și `aligned_cache`.

## Decizii ale utilizatorului (NU se redeschid fără motiv nou)
- **Fără „slot”** (link fix cu subtitrare aleasă manual / mutare +/− s): vrem experiență automată, fără alegeri manuale.
- **Fără curățarea textului** subtitrărilor (reclame, credite, versuri).
- **Rămânem la addonul comunității Subs.ro**, nu la integrarea directă (serviciul direct a fost șters în 1.6.18).
- **Subsync: niciun prag „mutări mici = aliniat” (0,6 s) și nicio întârziere de 0,2 s, SUB NICIO FORMĂ.** Regula globală / bucăți mari rămâne (nu replică cu replică). Referințe HD pentru fișiere UHD („umbră”): lăsat.
- **Priority bate potrivirea** la egalitate în nivelul de sus (regula din 1.5.0). **Fără etichetă ✓** pentru subtitrările deja decise (cost +22 ms, `id` instabil).
- Înregistrarea rămâne deschisă; OpenSubtitles v3 îl oprește utilizatorul din Services; eticheta „PGS” închisă (bug punctual); lista brută în DB (B) sărită.
- `maxSubtitles` = cel mult N din FIECARE limbă. Debug nu face cereri cât tabul e ascuns.

## Stare (2026-11-18, v1.6.18, ramura `vercel`)
- Valurile 1–4 din raportul celor 11 agenți: făcute (1.6.0–1.6.15). 1.6.16: măsurare pornire la rece. 1.6.17: `aligned_cache` în `db.json`. 1.6.18: `subsrodirect` șters. Istoric detaliat în `docs/ISTORIC.md`.
- Măsurat (2026-11-18): liste noi de la 1.5.25: mediană 0,79 s, p90 1,6 s, max 2,2 s, 0 peste 3 s (nu e nevoie de circuit breaker); `aligned_cache`: 88 rezultate, 2,35 MB din 150, 16% din deciziile Subsync citite din el (85 ms față de 519 ms); Subs.ro «waived»: 42% (1.5.25–1.6.7), 3/8 după 1.6.8.

## De făcut / de urmărit
- **După 2–3 zile de date:** pornirea la rece (compară `instance.seq` = 1 cu restul, `preMs`, `speedsMs`, `totalMs` pe `usage.json`; apoi, cu utilizatorul, dacă merită un ping de încălzire din cron-job.org); cât de des e Subs.ro «waived» după 1.6.8; dispariția pregătirilor duble (1.6.14).
- **După o săptămână:** compară MCC (Debug, lângă scorul fiecărei referințe) cu deciziile; praguri sau vârfuri suplimentare doar cu acordul utilizatorului.
- **Episodul următor** (NEFĂCUT, câștig mic): doar referințele Subsync ale lui `ep+1`, ~2 s după decizia episodului curent, o dată pe serial pe oră, nu pentru `ep>30`, nu atinge Subs.ro. De decis: la fiecare episod sau mai rar, plafon 1/oră.
- **La utilizator:** tagurile git (v1.5.11 → v1.6.18) de pe calculator; oprirea OpenSubtitles v3 din Services; schimbarea parolei profilului (UUID-ul a apărut într-un rezultat de comandă, 2026-11-18); opțional, ștergerea tabelului `subsro_cache` din Supabase.

## Limitări în cloud
- Nu există Docker și nici corpusul local de benchmark.
- Backslash-urile din comenzile inline se strică: folosește fișiere sau Edit.
