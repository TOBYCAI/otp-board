#!/usr/bin/env bash
# OTP Board — one-click server installer.
#
#   curl -fsSL https://raw.githubusercontent.com/TOBYCAI/otp-board/main/server/install.sh | bash
#
# What it does (idempotent, best-effort):
#   1. checks Node.js >= 18
#   2. creates an install dir with the repo's server/ + shared/ layout
#      (so `require('../shared/js/otp-core.js')` keeps resolving)
#   3. downloads server.js / package.json / .env.example / shared/js/otp-core.js
#   4. writes .env with auto-generated INGEST_TOKEN / ADMIN_TOKEN
#   5. starts the service via pm2 (preferred) or nohup fallback
#
# Override the install dir:  install.sh /opt/otp-board
set -euo pipefail

RAW_BASE="${OTP_INSTALL_RAW:-https://raw.githubusercontent.com/TOBYCAI/otp-board/main}"
INSTALL_DIR="${1:-$HOME/otp-board-server}"

echo "== OTP Board one-click installer =="
echo "Install dir : ${INSTALL_DIR}"

# --- 1. Node check ---
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN:-}" ]; then
  echo "ERROR: Node.js not found. Install >= 18 from https://nodejs.org or 'nvm install 20'."
  exit 1
fi
NODE_MAJOR="$(node -v | sed -E 's/v([0-9]+).*/\1/')"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required (found v${NODE_MAJOR})."
  exit 1
fi
echo "Node        : $(node -v) (${NODE_BIN})"

# --- 2. Prepare dirs (repo layout: server/ + shared/) ---
mkdir -p "${INSTALL_DIR}/server" "${INSTALL_DIR}/shared/js"
cd "${INSTALL_DIR}"

# --- 3. Download files ---
dl() {
  local url="$1" out="$2" attempt
  for attempt in 1 2 3; do
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --http1.1 "$url" -o "$out" && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$out" "$url" && return 0
    else
      echo "ERROR: need curl or wget to download files."; exit 1
    fi
    echo "  (retry ${attempt}/3 for $(basename "$out"))"
    sleep 1
  done
  echo "ERROR: failed to download $url"; exit 1
}
echo ""
echo "== Downloading (${RAW_BASE}) =="
dl "${RAW_BASE}/server/server.js"            "server/server.js"
dl "${RAW_BASE}/server/package.json"         "server/package.json"
dl "${RAW_BASE}/server/.env.example"         "server/.env.example"
dl "${RAW_BASE}/shared/js/otp-core.js"       "shared/js/otp-core.js"
echo "  server/server.js, server/package.json, server/.env.example, shared/js/otp-core.js"

# --- 4. .env with auto tokens ---
if [ ! -f server/.env ]; then
  cp server/.env.example server/.env
  if grep -q '^INGEST_TOKEN=' server/.env; then
    TOK="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
    sed -i.bak -E "s/^INGEST_TOKEN=.*/INGEST_TOKEN=${TOK}/" server/.env && rm -f server/.env.bak
  fi
  if grep -q '^ADMIN_TOKEN=' server/.env; then
    TOK="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
    sed -i.bak -E "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=${TOK}/" server/.env && rm -f server/.env.bak
  fi
  echo "  .env created with auto-generated INGEST_TOKEN / ADMIN_TOKEN."
  echo "  (edit server/.env to change PORT, TOKENS, retention, etc.)"
fi

# --- 5. Start service ---
echo ""
echo "== Starting service =="
cd server
PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2- | tr -d '\r' || echo 3000)"
PORT="${PORT:-3000}"

if command -v pm2 >/dev/null 2>&1; then
  pm2 start server.js --name otp-board --update-env 2>/dev/null || pm2 start server.js --name otp-board
  pm2 save 2>/dev/null || true
  echo "  started via pm2 (name: otp-board)."
elif command -v npm >/dev/null 2>&1; then
  ( nohup npm start >otp-board.log 2>&1 & )
  echo "  started via 'npm start' (nohup, log: server/otp-board.log)."
else
  ( nohup node server.js >otp-board.log 2>&1 & )
  echo "  started via 'node server.js' (nohup, log: server/otp-board.log)."
fi

sleep 1
echo ""
echo "== Verify =="
echo "  curl -fsS http://127.0.0.1:${PORT}/healthz"
echo "  open http://<this-host>:${PORT}/ in a browser."
echo ""
echo "Done. Files are in: ${INSTALL_DIR}"
echo "Stop later:  pm2 stop otp-board   (or: pkill -f 'node server.js')"
