#!/usr/bin/env bash
# OTP Board — deployment helper.
# This script is intentionally NON-destructive: it validates the environment and
# prints the exact commands you need. Pass --write-systemd to actually install the
# systemd unit (requires sudo).
set -euo pipefail

cd "$(dirname "$0")/.."   # -> server/

NODE_BIN="$(command -v node || true)"
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/v([0-9]+).*/\1/')"

echo "== OTP Board deployment =="
echo "Working dir : $(pwd)"
echo "Node binary : ${NODE_BIN:-<not found>}"

if [ -z "${NODE_BIN:-}" ] || [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 is required (found ${NODE_MAJOR:-none})."
  echo "       Install via:  https://nodejs.org  or  nvm install 20"
  exit 1
fi

echo ""
echo "== 1. Configure =="
echo "   cp .env.example .env"
echo "   # edit .env: set INGEST_TOKEN, ADMIN_TOKEN, PORT ..."

echo ""
echo "== 2a. Run directly (dev) =="
echo "   node server.js"
echo "   # or with hot reload:"
echo "   npm run dev"

echo ""
echo "== 2b. Run with PM2 (recommended for a VPS) =="
echo "   sudo npm i -g pm2"
echo "   pm2 start server.js --name otp-board"
echo "   pm2 save && pm2 startup"

echo ""
echo "== 2c. Run as a systemd service =="
echo "   sudo cp deploy/otp-board.service /etc/systemd/system/"
echo "   sudo systemctl daemon-reload"
echo "   sudo systemctl enable --now otp-board"

echo ""
echo "== 3. TLS reverse proxy (Nginx) =="
echo "   sudo cp deploy/nginx.example.conf /etc/nginx/sites-available/otp-board"
echo "   sudo ln -s /etc/nginx/sites-available/otp-board /etc/nginx/sites-enabled/"
echo "   sudo certbot --nginx -d your.domain.example"
echo "   sudo nginx -t && sudo systemctl reload nginx"

echo ""
echo "== 3b. TLS reverse proxy (Caddy, simplest) =="
echo "   # Caddyfile:"
echo "   your.domain.example {"
echo "       reverse_proxy 127.0.0.1:3000"
echo "   }"

if [ "${1:-}" = "--write-systemd" ]; then
  echo ""
  echo "== Installing systemd unit =="
  sudo cp deploy/otp-board.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now otp-board
  echo "Done. 'sudo systemctl status otp-board' to verify."
fi

echo ""
echo "== Verify =="
echo "   curl -i http://127.0.0.1:3000/healthz"
echo "   # Open http://your.domain.example/ in a browser."
