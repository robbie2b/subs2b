# Proba pe Hugging Face Spaces (gratuit, ~2 procesoare)

Scop: să vedem dacă addonul merge mai repede acolo decât pe Render gratuit. Render rămâne pornit, nu se strică nimic.
Codul e același; ramura `hf-space` e `work/subsync-engine` plus un antet în `README.md` (cerut de Hugging Face).

## 1. Creează Space-ul (în browser, pe huggingface.co)
1. New → **Space**. Nume: `subs2b`. SDK: **Docker** → *Blank*. Hardware: **CPU basic** (gratuit). Vizibilitate: **Public** merge,
   dar Private e mai bine (apoi linkul nu mai merge fără cont, deci pentru Stremio/Nuvio alege **Public**).
2. Nu adăuga fișiere acum.

## 2. Pune variabilele (Space → Settings → Variables and secrets)
Copiază din Render (Environment) TOATE variabilele pe care le ai acolo. Cele importante:
- **Secret** `DATABASE_URL` = același ca pe Render (baza Supabase; deci aceeași configurație și același UUID).
- **Variable** `BASE_URL` = `https://<utilizatorul-tău>-subs2b.hf.space` (litere mici; îl vezi în pagina Space-ului, „Embed this Space").
- Orice altceva ai pe Render (ex. `OPENSUBTITLES_ADDON_MODE`).
Nu pune valorile aici în chat sau în cod.

## 3. Trimite codul (pe calculatorul tău, în `C:\Users\rober\subs2b`)
Hugging Face cere un **token** în loc de parolă: huggingface.co → Settings → Access Tokens → New token, rol **Write**.
```
git fetch origin
git remote add hf https://huggingface.co/spaces/<utilizatorul-tău>/subs2b
git push hf origin/hf-space:main
```
La întrebarea de parolă lipești tokenul. Space-ul se construiește singur (3–10 minute; vezi „Logs").
Dacă respinge pozele `.png` („binary file"), spune-mi: le scot din ramura `hf-space` (nu strică funcționarea).

## 4. Verifică
- `https://<utilizatorul-tău>-subs2b.hf.space/health` trebuie să răspundă `ok`.
- Instalează în Stremio/Nuvio, ALĂTURI de cel vechi: `https://<utilizatorul-tău>-subs2b.hf.space/<UUID-ul tău>/manifest.json`.
  (Scoate temporar sau lasă oprit unul din ele ca să nu primești dubluri.)

## 5. Ține-l treaz
În cron-job.org adaugă un al doilea job la `https://<utilizatorul-tău>-subs2b.hf.space/health`, la 10 minute.

## 6. Compară (câteva zile)
- Logul live al fiecăruia: `<adresa>/<UUID>/debug/logs.json`; caută liniile `[SUBSYNC] timing` (câmpul *computation*).
- Pe Render erau 2,7–11,8 s la 4 calcule la rând.
- Uită-te și la timpii per sursă din Debug (Titrari, Subtitrari-noi, Addic7ed pot refuza IP-ul Hugging Face).
Dacă e mai bun: treci pe el. Dacă nu: șterge Space-ul și ai pierdut doar o seară.

## Actualizări ulterioare
Când se schimbă codul: `git fetch origin && git push hf origin/hf-space:main` (după ce `hf-space` a primit schimbările de la mine).
