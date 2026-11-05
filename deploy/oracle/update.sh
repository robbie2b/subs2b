#!/usr/bin/env bash
# Pune pe server versiunea curenta de pe GitHub (ramura din care ai clonat) si reporneste aplicatia.
# Se ruleaza de mana, doar cand vrei sa actualizezi (nu se actualizeaza singur).
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps
