# subs2b pe Oracle Cloud (Always Free): pas cu pas

Scop: acelasi addon, pe un server cu mult mai mult procesor decat Render gratuit. Render ramane pornit pe tot parcursul
probei; nu se strica nimic. Baza de date ramane pe Supabase, deci configuratia si UUID-ul sunt aceleasi.

Ce faci tu: contul, serverul, 2 reguli de retea, o adresa gratuita si cateva comenzi lipite.
Ce a facut deja codul: fisierele din acest folder (aplicatia + HTTPS automat + scripturile).

Nu trimite nimanui (nici mie) fisierul cheie SSH si nici continutul fisierului `.env`.

---

## 1. Contul Oracle
1. Mergi la **https://www.oracle.com/cloud/free/** si apasa **Start for free**.
2. Completeaza formularul. Cere nume, e-mail, adresa si un card (pentru verificarea identitatii; in zona Always Free nu se taxeaza).
3. **Home region** (regiunea de baza): se alege o singura data si **nu se mai poate schimba**. Alege una din Europa
   (de exemplu Frankfurt sau Amsterdam). Atentie: in regiunile aglomerate, serverul ARM gratuit apare uneori ca
   „Out of capacity" (vezi sectiunea Probleme).
4. Dupa creare poate dura cateva minute (uneori cateva ore) pana contul e activ. Primesti e-mail.

## 2. Creeaza serverul
In consola Oracle: meniul (☰) → **Compute** → **Instances** → **Create instance**.
- **Name:** `subs2b`
- **Image:** apasa *Change image* → **Canonical Ubuntu** → **24.04** (varianta pentru ARM apare automat daca alegi forma de mai jos).
- **Shape:** *Change shape* → **Ampere** → **VM.Standard.A1.Flex**. Pune **2 OCPU** si **12 GB** de memorie (sau cat te lasa
  contul; scrie langa „Always Free-eligible"). **Nu** alege VM.Standard.E2.1.Micro: e prea slab.
- **Networking:** lasa implicit, dar verifica sa fie bifat **Assign a public IPv4 address**.
- **Add SSH keys:** alege **Generate a key pair for me** si apasa **Save private key** (si public key). Pastreaza fisierul
  `.key` privat (de ex. in `C:\Users\rober\oracle\`). Fara el nu intri pe server.
- **Boot volume:** lasa implicit (50 GB).
- Apasa **Create**. Dupa 1–2 minute apare adresa **Public IP address**; nota-o.

## 3. Deschide porturile 80 si 443 (in reteaua Oracle)
Meniul (☰) → **Networking** → **Virtual cloud networks** → reteaua ta → **Subnets** → subreteaua publica →
**Security Lists** → **Default Security List** → **Add Ingress Rules**:
- Source CIDR: `0.0.0.0/0`, IP Protocol: **TCP**, Destination Port Range: `80` → Add
- La fel, inca o regula cu Destination Port Range: `443`

## 4. O adresa gratuita pentru server (HTTPS cere un nume, nu doar un numar)
1. Mergi la **https://www.duckdns.org** si intra cu Google sau GitHub.
2. La „sub domain" scrie un nume (de ex. `robbie-subs2b`) → **add domain**.
3. In dreptul lui, la „current ip", pune **Public IP-ul serverului** → **update ip**.
4. Adresa ta: `robbie-subs2b.duckdns.org` (cu numele tau). Asta e valoarea pentru `DOMAIN` mai jos.

## 5. Intra pe server (SSH) si instaleaza
Deschide **PowerShell** pe calculatorul tau:
```
ssh -i C:\Users\rober\oracle\ssh-key.key ubuntu@IP-UL-SERVERULUI
```
(pune calea reala a cheii si IP-ul real). La prima conectare raspunde `yes`.
Daca scrie „UNPROTECTED PRIVATE KEY FILE", ruleaza intai (in PowerShell, cu calea ta):
```
icacls C:\Users\rober\oracle\ssh-key.key /inheritance:r
icacls C:\Users\rober\oracle\ssh-key.key /grant:r "$($env:USERNAME):(R)"
```

Pe server (lipesti linie cu linie):
```
sudo apt-get install -y git
git clone -b work/subsync-engine https://github.com/robbie2b/subs2b.git
BRANCH=work/subsync-engine bash subs2b/deploy/oracle/setup.sh
```
Dureaza cateva minute. La final iti spune pasii urmatori.

## 6. Completeaza setarile
```
nano ~/subs2b/deploy/oracle/.env
```
Completeaza doua randuri:
- `DOMAIN=` adresa de la pasul 4 (fara `https://`), de ex. `DOMAIN=robbie-subs2b.duckdns.org`
- `DATABASE_URL=` aceeasi valoare ca pe Render (Render → serviciul → Environment → ochiul → copiaza). Nu o lipi in chat.

Salvezi: `Ctrl+O`, `Enter`, apoi `Ctrl+X`.

## 7. Porneste
Iesi si intra din nou pe SSH (`exit`, apoi comanda `ssh ...` de la pasul 5), apoi:
```
cd ~/subs2b/deploy/oracle
docker compose up -d --build
```
Prima construire dureaza 5–10 minute. Verifica:
- `docker compose ps` → ambele servicii „running"/„healthy"
- in browser: `https://robbie-subs2b.duckdns.org/health` → trebuie sa arate `"status":"ok"`
  (daca da eroare de certificat in primul minut, asteapta putin: Caddy abia obtine certificatul)

## 8. Instaleaza addonul nou si compara
- In Stremio/Nuvio instaleaza, **alaturi** de cel vechi: `https://ADRESA-TA/<UUID-ul tau>/manifest.json`
  (lasa oprit unul dintre ele ca sa nu vezi liste duble).
- Logul serverului nou: `https://ADRESA-TA/<UUID>/debug/logs.json`; cauta liniile `[SUBSYNC] timing` (campul *computation*).
  Pe Render erau 2,7–11,8 s la 4 calcule la rand.
- Uita-te in Debug si la timpii per sursa (Titrari, Subtitrari-noi, Addic7ed pot refuza adresa Oracle).
- In cron-job.org poti adauga un job la `https://ADRESA-TA/health` (la 10 min): tine serverul activ si il face sa nu para „nefolosit".

## Comenzi utile (pe server, in ~/subs2b/deploy/oracle)
- Actualizare dupa ce schimbam codul: `bash update.sh` (nu se actualizeaza singur)
- Loguri: `docker compose logs -f subs2b`
- Repornire: `docker compose restart`

## Probleme probabile
- **„Out of capacity for shape VM.Standard.A1.Flex"** la creare: se intampla des. Incearca mai tarziu (dimineata devreme merge
  mai bine) sau cu mai putine resurse (1 OCPU / 6 GB). Regiunea nu se mai schimba dupa creare.
- **Oracle poate opri serverele Always Free aproape nefolosite** (daca procesorul, memoria si reteaua stau sub ~20% mult timp).
  Addonul consuma putin, deci exista riscul. Daca se opreste, il pornesti din consola (Instances → Start). Spune-mi daca se intampla.
- **Constructia imaginii pe ARM** n-a fost testata de mine (nu am Docker aici). Dependintele sunt doar JavaScript, deci ar trebui sa mearga;
  daca `docker compose up --build` da eroare, copiaza-mi mesajul (fara parole).
- **Adresa Oracle poate fi refuzata de unele site-uri de subtitrari** (ca si cele de la Render). Se vede in Debug la timpii per sursa.
- Nu trece contul pe „Pay As You Go" si nu alege forme fara eticheta „Always Free-eligible", ca sa nu platesti.
