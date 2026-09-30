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

- **Sources:** OpenSubtitles.com (API v1), SubDL and Subsource, each with its own API key that is
  validated live, **RegieLive** (Romanian; works without a key, see below), plus any Stremio subtitle addon imported by its `manifest.json` URL (for example the community Subs.ro addon).
- **Language whitelist and remapping:** everything is normalized to ISO 639-2; free rules such as `pt-br → pob`.
- **Deduplication** by download URL and release-name similarity, with provider priority.
- **Results limit** to show only the best *N* subtitles.
- **VTT to SRT conversion:** subtitles delivered as WebVTT (for example by the community Subs.ro addon) are converted to plain SRT
  on the fly, without cue positioning or styling, so the player applies your own subtitle size and position settings.
  It can be turned off in Filters & Ordering → Results.
- **Configuration page** with UUID + password (bcrypt), install links and a QR code for mobile.
- **Diagnostics** page with the last requests and how each subtitle was scored (see below).

## Requirements

- **API keys** (each user enters their own in the *Services* tab): [OpenSubtitles](https://www.opensubtitles.com/api)
  (enable *Under development* for the key), [SubDL](https://subdl.com), [Subsource](https://subsource.net).
  Use only the providers you want.
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
| `REGIELIVE_API_KEY` | *(empty)* | Personal RegieLive API key (optional; the shared Bazarr key is used without it) |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | `60000`, `150` | Rate limit of the subtitles endpoint |

## RegieLive

RegieLive is built in as a service (Services tab, no key needed). It uses the same search API as Bazarr: by title and
year (+ season/episode) and by the playing file's name, and it downloads the ZIP/RAR archives, picks the right file
(episode, Romanian language), fixes the old Romanian charset (Windows-1250) and converts MicroDVD `.sub` files to SRT.

- RegieLive asks API users to stay under about 8 searches per minute; subs2b enforces that (and caches results).
- Without a personal key the **shared Bazarr key** is used, whose request budget is shared with every other Bazarr user.
  If you have your own RegieLive key, paste it in the service settings (or set `REGIELIVE_API_KEY`).
- The IMDb-id search is not used: the API refuses it for the shared key.

## Subs.ro

Subs.ro is used through the community **Subs.ro** Stremio addon: import it in the *Addons* tab. Its results work
with subs2b: the real file names hidden in its links are decoded and scored like any other source, and its WebVTT
subtitles are converted to SRT. A direct Subs.ro integration is not included: its API sits behind Cloudflare, which
blocks most datacenter IPs (Render included).

## Diagnostics

`https://<your-service>/<configuration-uuid>/debug/recent.json` lists the last requests: the file name and hash the
player sent, how many subtitles each provider returned, what was filtered, and the top of the ranking with the reason
for every score. It is kept in memory only (reset on restart) and needs the UUID of your configuration, which is
already the credential of your addon, so do not share it.

The **Debug** page of the configuration interface shows the live server log and *when* the addon is used: every
subtitles request (one per Play) is counted per weekday and hour (stored in the database when `DATABASE_URL` is set),
together with the content id and the file name the player sent. Only these counters are stored, never the UUID.
The keep-alive pings of `/health` are not counted. Note that the live log is the log of the whole server.

Render logs show the same information: lines starting with `Request`, `Scoring` and `[SCORE]`.

## Security notes

- The **configuration UUID is a secret**: it identifies your addon and unlocks your diagnostics. Do not post the addon URL.
- Some subtitle links handed to the player contain the provider API key (OpenSubtitles direct, Subsource
  direct) because the player downloads through this server. Treat the links as private too.
- The download proxy only fetches from subtitle sites (SubDL, Subsource, OpenSubtitles, Stremio's mirror) and ignores
  files bigger than 10 MB inside archives. The VTT converter also accepts the hosts of the addons imported in that
  configuration, and does not follow redirects to other hosts.
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
