#!/usr/bin/env bash
# Pregateste un server Ubuntu (Oracle Cloud) pentru subs2b: Docker, firewall, codul. Se ruleaza O SINGURA DATA, dupa clonare:
#   git clone -b work/subsync-engine https://github.com/robbie2b/subs2b.git
#   BRANCH=work/subsync-engine bash subs2b/deploy/oracle/setup.sh
# (BRANCH = ramura de pe care se ia codul; "main" cand fisierele sunt pe main). Poate fi rulat si a doua oara.
set -euo pipefail

BRANCH="${BRANCH:-main}"
DIR="${DIR:-$HOME/subs2b}"
REPO="https://github.com/robbie2b/subs2b.git"

echo "==> 1/5 Actualizez pachetele"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates unattended-upgrades iptables-persistent

echo "==> 2/5 Instalez Docker (daca nu e deja)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER" || true

echo "==> 3/5 Deschid porturile 80 si 443 in firewall-ul serverului"
# Imaginile Ubuntu de pe Oracle vin cu reguli iptables care blocheaza tot in afara de SSH
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 1 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
sudo netfilter-persistent save

echo "==> 4/5 Actualizari automate de securitate"
sudo dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo "==> 5/5 Aduc codul in $DIR (ramura $BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" checkout "$BRANCH"
  git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR/deploy/oracle"
if [ ! -f .env ]; then
  cp env.example .env
  chmod 600 .env
fi

cat <<MSG

Gata pregatirea. Urmatorii pasi (vezi INSTRUCTIUNI.md):
  1. Completeaza fisierul .env:      nano $DIR/deploy/oracle/.env
  2. Iesi si intra din nou pe SSH (ca sa mearga docker fara sudo), apoi:
       cd $DIR/deploy/oracle && docker compose up -d --build
MSG
