<div align="center">

<img src="src/web/public/assets/subs2b_logo.png" width="160" height="160" alt="subs2b logo">

# subs2b

**Subtitles for Stremio & Nuvio, matched automatically to the file you are playing**

[![License: GPLv3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![CI](https://github.com/robbie2b/subs2b/actions/workflows/ci.yml/badge.svg)](https://github.com/robbie2b/subs2b/actions/workflows/ci.yml)

</div>

## What is subs2b?

subs2b is a Stremio/Nuvio subtitle addon that searches several sources at once, scores every subtitle
against the file you are actually playing and puts the best match **first** in the list, so the player picks
it on its own. There is nothing to choose by hand in the common case.

It is a fork of [AIOsubs](https://github.com/Augustofabg/AIOsubs), extended with the automatic scoring,
Subs.ro, exact file-hash matching and a lot of clean-up. It does not host or distribute any subtitle files:
it only asks the providers you configure and passes their results to your player.

## How the best subtitle is chosen

When you press Play, the player (Stremio) tells the addon the **file name**, **size** and **hash** of the video.
Every subtitle found is then compared with that file, in the spirit of Bazarr:

| Signal | Effect |
| :--- | :--- |
| Exact file-hash match (OpenSubtitles) | Always first: the subtitle was made for this exact file |
| Same release group (`...-FLUX`) | Strong bonus |
| Same source (WEB-DL, BluRay, REMUX, HDTV...) | Bonus; BluRay ↔ REMUX and WEB-DL ↔ WEBRip count as close |
| Same resolution, streaming service (NF, AMZN, DSNP...), codec, edition (IMAX, Extended...) | Smaller bonuses |
| Another title, another year, another season or episode | Removed from the list |
| CAM / TS / HDTC recordings | Pushed to the end |
| Subs.ro | Small bonus (it is the reference source for Romanian) |

If the player does not send the file name (see the Nuvio note below), subtitles are ranked by general
quality instead (good source and resolution, exact year, popularity) and wrong titles/episodes are still removed.
The scoring never returns an empty list: if everything would be rejected, the original order is kept.

Everything is always searched and scored. The **Results** setting (Filters & Ordering → Results) only limits how many
subtitles are *shown* to the player, best first.

## Features

- **Sources:** OpenSubtitles.com (API v1), SubDL, Subsource and Subs.ro, each with its own API key that is
  validated live, plus any Stremio subtitle addon imported by its `manifest.json` URL.
- **Language whitelist and remapping:** everything is normalized to ISO 639-2; free rules such as `pt-br → pob`.
- **Deduplication** by download URL and release-name similarity, with provider priority.
- **Results limit** to show only the best *N* subtitles.
- **Configuration page** with UUID + password (bcrypt), install links and a QR code for mobile.
- **Diagnostics** page with the last requests and how each subtitle was scored (see below).

## Requirements

- **API keys** (each user enters their own in the *Services* tab): [OpenSubtitles](https://www.opensubtitles.com/api)
  (enable *Under development* for the key), [SubDL](https://subdl.com), [Subsource](https://subsource.net),
  [Subs.ro](https://subs.ro/api). Use only the providers you want.
- **Stremio** sends the file name and hash to subtitle addons. **Nuvio currently does not**
  ([NuvioMobile#1979](https://github.com/NuvioMedia/NuvioMobile/issues/1979),
  [NuvioDesktop#765](https://github.com/NuvioMedia/NuvioDesktop/issues/765)), so with Nuvio the ranking falls back to
  general quality and the exact-file signals are unavailable.

## Run it

### Locally

Node.js 20+ is required.

```bash
git clone https://github.com/robbie2b/subs2b.git
cd subs2b
npm install
cp .env.example .env      # optional
npm run build
npm start                 # or: npm run dev
```

Open `http://localhost:7000/configure`, create a configuration, and install the addon in Stremio.

### Docker

```bash
docker compose up -d
```

Configurations are stored in `./data` unless `DATABASE_URL` points to a PostgreSQL database.

### Render (free plan)

1. Create a **Web Service** from this repository (runtime **Docker**, branch `main`). Every push to `main` redeploys.
2. Add a PostgreSQL database (Render, Supabase, Neon...) and set its connection string as `DATABASE_URL`.
   Without it, saved configurations are lost on every redeploy because the free plan has no persistent disk.
3. Open `https://<your-service>.onrender.com/configure`.

The free plan sleeps after inactivity; the first request after a pause takes about a minute.

## Environment variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `7000` | HTTP port |
| `HOST` | `0.0.0.0` | Listening address |
| `BASE_URL` | *(detected)* | Public URL of the addon, if it cannot be detected from the request |
| `DATABASE_URL` | *(empty)* | PostgreSQL connection string. Empty: configurations go to `./data/configurations.json` |
| `DATA_DIR` | `./data` | Folder for the local configuration file |
| `OPENSUBTITLES_ADDON_MODE` | `parallel` | `parallel`: OpenSubtitles addons imported in the UI run together with the direct integration. `fallback`: only if the direct integration fails |
| `SUBSRO_PROXY_URL`, `SUBSRO_PROXY_TOKEN` | *(empty)* | Optional relay for the Subs.ro API (see below) |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | `60000`, `150` | Rate limit of the subtitles endpoint |

## Subs.ro and Cloudflare

The Subs.ro API sits behind Cloudflare, which challenges many datacenter IPs (Render included) with a
"Just a moment" page, so the direct Subs.ro provider may report "blocked by Cloudflare". Options:

- Import the community **Subs.ro** Stremio addon in the *Addons* tab. Its results work with subs2b: the real file
  names hidden in its links are decoded and scored like any other source.
- Run the relay in [`scripts/cloudflare-subsro-relay.js`](scripts/cloudflare-subsro-relay.js) as a free Cloudflare
  Worker and set `SUBSRO_PROXY_URL` / `SUBSRO_PROXY_TOKEN`. This helps only while Cloudflare accepts the Worker's traffic.
- Ask Subs.ro to allow your server.

## Diagnostics

`https://<your-service>/<configuration-uuid>/debug/recent.json` lists the last requests: the file name and hash the
player sent, how many subtitles each provider returned, what was filtered, and the top of the ranking with the reason
for every score. It is kept in memory only (reset on restart) and needs the UUID of your configuration, which is
already the credential of your addon, so do not share it.

Render logs show the same information: lines starting with `Request`, `Scoring` and `[SCORE]`.

## Security notes

- The **configuration UUID is a secret**: it identifies your addon and unlocks your diagnostics. Do not post the addon URL.
- Some subtitle links handed to the player contain the provider API key (OpenSubtitles direct, Subsource, Subs.ro
  direct) because the player downloads through this server. Treat the links as private too.
- The download proxy only fetches from subtitle sites (SubDL, Subsource, OpenSubtitles, Stremio's mirror) and ignores
  files bigger than 10 MB inside archives.
- Passwords are stored as bcrypt hashes and never logged.

## Tests

```bash
npm test         # providers, pipeline, storage, scoring, fallback, HTTP endpoints (no network, no server needed)
npm run lint     # type check
```

`experiments/subsync/` holds offline tools used to study subtitle timing (not part of the addon).

## Disclaimer

subs2b aggregates results from third-party subtitle services. It does not host, store or distribute any content.
You are responsible for complying with the laws and the terms of service of the services you use.

## Credits

Fork of [AIOsubs](https://github.com/Augustofabg/AIOsubs) by Augustofabg. The configuration interface follows the visual
style of [AIOStreams](https://github.com/Viren070/AIOStreams). Thanks to the OpenSubtitles, SubDL, Subsource and Subs.ro
teams and to the authors of the community Stremio subtitle addons.
