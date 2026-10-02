# subs2b: context de lucru pentru Claude

Fișierul ăsta e citit automat la începutul fiecărei sesiuni. Ține-l la zi la finalul fiecărei etape importante
(ce s-a făcut, ce a ieșit la teste, ce a rămas).

## Proiectul
- Addon Stremio de subtitrări cu clasament inteligent (TypeScript / Node / Express). Repo: `robbie2b/subs2b`.
- Rulează pe Render (Docker, plan gratuit ~0.1 CPU) cu Postgres pe Supabase. Un cron-job.org îl ține treaz ziua (la 10 min).
- Proprietarul nu e programator: explică simplu, **în română**.

## Reguli
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
- **v1.4.10 (deploy 2026-10-02):** unealta Debug `/<uuid>/debug/probe.json?url=…[&as=addon]` (`src/proxy/siteProbe.ts`):
  descarcă de pe Render o pagină de pe site-urile candidate (titrari.ro, subtitrari-noi.ro, yifysubtitles.*/yts-subs.com,
  addic7ed.com, wyzie.ru/wyzie.io) și arată status, antete, corp; redirecturile trebuie să rămână pe ele.
  Log nou: `[SOURCES] saved source blocks read in X ms` (pe 1.4.9 tot apărea „not read within 5 s” fără blocări în DB).
  Următorul pas: 5 surse noi ca servicii (cerute de utilizator): Titrari.ro, Subtitrari-noi.ro, YIFY, Addic7ed, Wyzie
  (`sub.wyzie.io`), scrise după paginile reale văzute cu probe.
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
  Tagurile v1.4.2–v1.4.10 de pus (v1.4.7 n-a ajuns live) de pe calculatorul utilizatorului.
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

## De făcut (în ordinea discutată)
- Subsync pe REMUX: încredere doar în referințe REMUX (sau ale grupului fișierului); altfel subtitrarea neschimbată.
- Limită de timp pentru calculul suplimentar (verificarea pe bucăți + alternative) când prima verificare a durat mult.
- Semn vizibil în Stremio când serverul trimite altă subtitrare decât cea aleasă („replaced by”), legat de mesajul custom.
- Surse noi (mai târziu, la cererea utilizatorului): Titrari.ro și Subtitrari-noi.ro, de verificat întâi în browser.
  Addic7ed (Cloudflare, limită mică, scos deja înainte de 1.0.0) și YIFY (doar filme, multe clone) — nerecomandate.
- Arhive non-zip: RAR există doar la RegieLive; de adăugat în `/sub/proxy`, plus jurnal permanent al eșecurilor de descărcare în Debug.
- „PGS” la prima subtitrare. Ipoteze: piste PGS din REMUX, sau linkuri fără `.srt` / MIME `text/plain`.
  Direcție: linkuri care se termină în `.srt`, cu `application/x-subrip`.
  Nou (2026-10-01, 1.4.8, telefon): Peacemaker S01E01 2160p HMAX WEB-DL CRU → prima subtitrare a addonului apare „PGS”,
  următoarele 4 „SRT”. Toate 5 sunt linkuri `/sub/aligned/<token>.srt` (deci nu pista video și nu lipsa `.srt`).
  Prima a fost pregătită din timp (servită în 0 ms, −5 s, 2 referințe). Răspunsul are `Content-Type: text/plain`.
  De verificat ce face Stremio diferit cu prima (auto-selectată) și dacă `application/x-subrip` schimbă eticheta.
- Mesaj custom la începutul filmului (oprit / tehnic / text propriu; `{\an8}` doar dacă nu există gol; de testat pe dispozitive).
- Cache scurt (1–2 min) pentru răspunsuri goale sau incomplete, normal (30 min) pentru liste bune.
- Feedback la alegerea manuală a altei subtitrări (pentru clasament).
- Măsurarea impactului regulilor de scor pe datele Debug adunate.

## Limitări în cloud
- Nu există Docker și nici corpusul local de benchmark.
- Backslash-urile din comenzile inline se strică: folosește fișiere sau Edit.
