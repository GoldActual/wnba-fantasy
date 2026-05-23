#!/usr/bin/env bash
#
# WNBA Fantasy Tracker — Pi deployment / redeploy script.
#
# Safe to re-run. Never touches backend/data/wnba.db, never overwrites
# .env. On a fresh Pi, walks the user through filling in WNBA_ADMIN_TOKEN
# then enables the systemd service.
#
# Run as the `cole` user (not root). It will sudo where it needs to.
set -euo pipefail

# --- Paths --------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$REPO_ROOT/backend"
FRONTEND="$REPO_ROOT/frontend"
VENV="$BACKEND/.venv"
ENV_FILE="$REPO_ROOT/.env"
SERVICE_FILE="$REPO_ROOT/deploy/wnba-fantasy.service"
SERVICE_NAME="wnba-fantasy.service"

# Sanity: make sure we're running from the repo, not /tmp or wherever.
if [[ ! -f "$BACKEND/requirements.txt" ]]; then
  echo "ERROR: backend/requirements.txt not found at $BACKEND" >&2
  echo "Run this script from inside the cloned wnba-fantasy repo." >&2
  exit 1
fi

echo "=== WNBA Fantasy Tracker — install/redeploy ==="
echo "Repo: $REPO_ROOT"

# --- System packages ----------------------------------------------------
echo "--> Installing system packages (apt)…"
sudo apt-get update -qq
sudo apt-get install -y python3 python3-venv python3-pip nodejs npm git

# --- Backend venv + deps ------------------------------------------------
echo "--> Building backend venv at $VENV"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -U pip
"$VENV/bin/pip" install -r "$BACKEND/requirements.txt"

# --- Frontend build -----------------------------------------------------
echo "--> Building frontend (npm install && npm run build)"
cd "$FRONTEND"
# `npm install` rather than `npm ci` because the lockfile is generated on
# Windows (dev machine) and `npm ci` rejects mismatched platform-specific
# optional deps on Linux ARM64 (the Pi). `npm install` is lenient and
# resolves the platform-correct optional deps from the registry.
npm install
npm run build
# Starlette's StaticFiles(html=True) serves `404.html` (not `index.html`)
# on unknown paths. For SPA client-side routing (e.g. `/spectator`) to
# work, mirror index.html as 404.html so any unmatched URL falls through
# to the SPA shell. Acceptable trade-off: a typo'd API path also returns
# the HTML index — the dev console makes that obvious for this app.
cp dist/index.html dist/404.html
cd "$REPO_ROOT"

# --- Data directory (DB-preserving) ------------------------------------
# Never wipe; just ensure the directory exists. init_db() is idempotent.
mkdir -p "$BACKEND/data"

# --- .env -------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "--> Creating .env from .env.example"
  cp "$REPO_ROOT/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo ""
  echo "  !! Edit $ENV_FILE and replace WNBA_ADMIN_TOKEN before continuing. !!"
  echo "  Generate a strong token:"
  echo "    python3 -c 'import secrets; print(secrets.token_urlsafe(32))'"
  echo ""
  read -p "  Press ENTER once .env is updated, or Ctrl+C to bail…"
fi

# --- systemd unit ------------------------------------------------------
echo "--> Installing systemd unit ($SERVICE_NAME)"
sudo cp "$SERVICE_FILE" "/etc/systemd/system/$SERVICE_NAME"
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"

# --- Status ------------------------------------------------------------
echo ""
echo "=== Done. Status: ==="
sudo systemctl status "$SERVICE_NAME" --no-pager || true
echo ""
echo "Hit it from your LAN:  http://$(hostname -I | awk '{print $1}'):8000/"
echo "Tail logs:             sudo journalctl -u $SERVICE_NAME -f"
echo "Restart after changes: sudo systemctl restart $SERVICE_NAME"
