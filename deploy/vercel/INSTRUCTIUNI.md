# subs2b pe Vercel (plan gratuit Hobby): proba

Ramura `vercel` = codul de pe `work/subsync-engine` + adaptarea pentru Vercel. Render nu se atinge: ramura nu e pe `main`.
Ce e diferit pe Vercel: nu ruleaza un server permanent, ci o functie care porneste la cerere (`api/index.js`, cu `vercel.json`).
Firul de calcul separat e oprit acolo (calculul Subsync ruleaza in cerere), iar lucrul care continua dupa raspuns
(pregatirea din timp, istoricul de utilizare) e legat de `waitUntil` din `@vercel/functions`.

## 1. Cont (fara card, cu GitHub)
1. https://vercel.com/signup → alege planul **Hobby** → **Continue with GitHub**.
2. Daca cere telefon sau alte date, citeste ce cere; oprește-te daca cere card.

## 2. Importa proiectul
1. Add New → **Project** → **Import Git Repository** → `robbie2b/subs2b`.
   La autorizarea aplicatiei GitHub alege **Only select repositories** → doar `subs2b`.
2. Pe ecranul de configurare: **Framework Preset: Other**. Lasa restul (setarile vin din `vercel.json`).
3. Deschide **Environment Variables** si adauga:
   - `DATABASE_URL` = aceeasi valoare ca pe Render (copiaz-o din Render → Environment). Bifeaza **Sensitive**. Nu o trimite nimanui.
4. Apasa **Deploy**. Primul deploy porneste de pe `main`, care NU are adaptarea: poate esua, e normal.

## 3. Pune ramura `vercel` ca ramura de productie
- Project → **Settings → Environments → Production → Branch Tracking** (sau **Settings → Git → Production Branch**): `vercel`. Save.
- Spune-mi cand ai terminat; eu imping un commit pe ramura `vercel`, ca Vercel sa o construiasca. (Alternativ: la Deployments, daca vezi o
  constructie a ramurii `vercel`, o promovezi la Production.)

## 4. Verifica
- `https://<numele-proiectului>.vercel.app/health` → trebuie sa arate `"status":"ok"` (deschide-l si dintr-o fereastra privata,
  ca sa fii sigur ca e public; daca cere login Vercel, Settings → Deployment Protection → dezactiveaza pentru productie).
- Instaleaza in Nuvio/Stremio, **alaturi** de cel vechi: `https://<numele-proiectului>.vercel.app/<UUID>/manifest.json`.

## 5. Compara
- Logurile se vad in Vercel: proiectul → **Logs** (cauta `[SUBSYNC] timing`, campul *computation*; pe Render: 2,7–11,8 s la cazurile grele).
  `…/debug/logs.json` merge, dar arata doar instanta care raspunde.
- Consumul: **Settings → Usage** → *Active CPU* (limita Hobby: 4 ore pe luna, dupa ea functia se opreste pana in luna urmatoare).
- Nu ai nevoie de cron-job: functia porneste la cerere.

## Necunoscute (nu le-am putut testa de aici)
- Durata maxima a unei cereri pe Hobby (60 s sau 300 s, sursele se contrazic): `vercel.json` cere 60 s, iar asteptarea Subsync se opreste la 45 s.
- Cat dureaza pornirea la rece a functiei si ce se pierde din memorie intre instante.
- Daca baza de date (Supabase) face probleme cu multe conexiuni mici: ar ajuta adresa „pooler" din Supabase (Connect → Transaction pooler).
- Politica Vercel despre scraping/proxy si „doar uz necomercial" pe Hobby: citeste termenii lor.
- Cu mai multe instante, memoria nu e comuna: lista poate fi recalculata mai des decat pe un server unic.
