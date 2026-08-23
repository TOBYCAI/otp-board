#!/usr/bin/env bash
# OTP Board — self-contained one-click server installer with interactive wizard.
#
#   curl -fsSL https://raw.githubusercontent.com/TOBYCAI/otp-board/main/server/install.sh | bash
#
# Everything (server.js + shared/js/otp-core.js + package.json) is EMBEDDED below,
# so this single file is enough — no runtime fetch from GitHub required.
# After running it, the dashboard is live on http://<host>:3000/.
#
# Interactive: when run in a terminal it asks for install dir / port / tokens /
# retention / rate-limit / auto-start and shows a confirmation step (mirrors the
# original otp31.sh guided install). When piped (curl | bash) it falls back to
# safe defaults and auto-generates tokens, so it still runs unattended.
#
# Override the install dir:  install.sh /opt/otp-board
set -euo pipefail

INSTALL_DIR="${1:-$HOME/otp-board-server}"

# Interactive mode only when attached to a real terminal (not piped / curl | bash).
# When non-interactive, every prompt falls back to a safe default and the final
# confirmation is auto-accepted, so `curl ... | bash` still works unattended.
INTERACTIVE=0
if [ -t 0 ]; then
  INTERACTIVE=1
fi

# Helper: ask a question. Usage: ask VAR "prompt" "default"
# In non-interactive mode the default is taken without prompting.
ask() {
  local __var="$1" __prompt="$2" __default="$3"
  if [ "${INTERACTIVE}" -eq 1 ]; then
    local __ans
    if [ -n "${__default}" ]; then
      read -r -p "${__prompt} (默认 ${__default}): " __ans
    else
      read -r -p "${__prompt}: " __ans
    fi
    __ans="${__ans:-${__default}}"
    printf -v "$__var" '%s' "$__ans"
  else
    printf -v "$__var" '%s' "$__default"
  fi
}

echo "== OTP Board one-click installer (self-contained) =="
if [ "${INTERACTIVE}" -eq 1 ]; then
  echo "  交互式安装向导（非终端环境将自动使用默认值）"
fi
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

# --- 2. Write embedded files ---
# (dirs are prepared + cd'd after the wizard resolves INSTALL_DIR, see step 3.5)
echo ""
echo "== Writing files =="
cat > server/server.js <<'___SERVERJS___'
#!/usr/bin/env node
'use strict';

/**
 * OTP Board — zero-dependency Node.js ingestion + dashboard server.
 *
 * Design goals
 * ------------
 * - No external npm packages: plain `http`, `fs`, `crypto`. `npm install` is a no-op.
 * - Reuses the SAME extraction logic as the Android client via `shared/js/otp-core.js`,
 *   so a raw `content` body can be parsed server-side with identical rules.
 * - Persists every code to a JSON file so it survives restarts.
 * - Two boards: `SMS` (SMS / IM / RCS) and `Email`. Split is purely by the `source` field.
 * - Optional ingest token (body.token / x-token) and optional admin token (dashboard + API).
 * - Daily cleanup at 23:59 (local) prunes codes older than RETENTION_DAYS.
 *
 * Contract (shared/proto/otp-payload.schema.json)
 *   { otp: string, source?: string, platform?: string, time?: string, token?: string }
 *   OR
 *   { content: string, source?: string, token?: string }  -> otp extracted server-side.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const otpCore = require('../shared/js/otp-core.js');

// ---------------------------------------------------------------------------
// Config (env first, then .env if present)
// ---------------------------------------------------------------------------
loadDotEnv(path.join(__dirname, '.env'));

const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  INGEST_TOKEN: process.env.INGEST_TOKEN || '',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  DATA_FILE: process.env.DATA_FILE || path.join(__dirname, 'data', 'messages.json'),
  RETENTION_DAYS: parseInt(process.env.RETENTION_DAYS || '7', 10),
  RATE_LIMIT_COUNT: parseInt(process.env.RATE_LIMIT_COUNT || '60', 10),
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
let messages = [];

function ensureStore() {
  const dir = path.dirname(CONFIG.DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
      messages = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
      if (!Array.isArray(messages)) messages = [];
    } catch (e) {
      console.error('[store] corrupt data file, starting empty:', e.message);
      messages = [];
    }
  }
  saveStore();
}

function saveStore() {
  const dir = path.dirname(CONFIG.DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(messages, null, 2));
}

// ---------------------------------------------------------------------------
// Classification: SMS board vs Email board
// ---------------------------------------------------------------------------
function categoryOf(source) {
  const s = (source || '').trim();
  if (!s) return 'SMS';
  if (/^sms/i.test(s) || s === '短信') return 'SMS';
  if (/^email/i.test(s)) return 'Email';
  // WhatsApp / WeChat / Telegram / etc. are delivered as text codes -> SMS board.
  return 'SMS';
}

// ---------------------------------------------------------------------------
// Rate limiter (per IP, sliding window)
// ---------------------------------------------------------------------------
const hitLog = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;
  const hits = (hitLog.get(ip) || []).filter((t) => t > windowStart);
  hits.push(now);
  hitLog.set(ip, hits);
  return hits.length > CONFIG.RATE_LIMIT_COUNT;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function adminAuthorized(req) {
  if (!CONFIG.ADMIN_TOKEN) return true; // open dashboard when no token set
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = url.searchParams.get('key') || req.headers['x-admin-token'] || '';
  return key === CONFIG.ADMIN_TOKEN;
}

function ingestAuthorized(body, req) {
  if (!CONFIG.INGEST_TOKEN) return true;
  const headerToken = req.headers['x-token'] || '';
  const bodyToken = body && body.token ? String(body.token) : '';
  return bodyToken === CONFIG.INGEST_TOKEN || headerToken === CONFIG.INGEST_TOKEN;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------
async function handleIngest(req, res, ip) {
  if (rateLimited(ip)) {
    sendJson(res, 429, { ok: false, error: 'too many requests' });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: 'bad request' });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch (e) {
    sendJson(res, 400, { ok: false, error: 'invalid json' });
    return;
  }

  if (!ingestAuthorized(body, req)) {
    sendJson(res, 403, { ok: false, error: 'token error' });
    return;
  }

  // Optional server-side extraction from raw `content`.
  let otp = body.otp;
  if (!otp && body.content) {
    const r = otpCore.process(String(body.content), String(body.platform || ''));
    if (r) otp = r.otp;
  }

  if (!otp || typeof otp !== 'string' || !otp.trim()) {
    sendJson(res, 400, { ok: false, error: 'missing otp' });
    return;
  }

  const source = body.source || 'SMS';
  const record = {
    id: crypto.randomUUID(),
    otp: otp.trim(),
    source: source,
    category: categoryOf(source),
    platform: body.platform || '',
    time: body.time || new Date().toLocaleTimeString('sv-SE'),
    timestamp: Date.now(),
    ip,
  };

  messages.unshift(record);
  if (messages.length > 5000) messages = messages.slice(0, 5000);
  saveStore();

  console.log(`[ingest] ${record.category} code from ${source} (${record.platform || '-'})`);
  sendJson(res, 200, { ok: true, id: record.id });
}

// ---------------------------------------------------------------------------
// Dashboard + API
// ---------------------------------------------------------------------------
function getBoards() {
  const sms = [];
  const email = [];
  for (const m of messages) {
    (m.category === 'Email' ? email : sms).push(m);
  }
  return { sms, email };
}

function renderDashboard() {
  const { sms, email } = getBoards();

  const row = (m) => `<tr>
    <td class="code">${escapeHtml(m.otp)}</td>
    <td>${escapeHtml(m.source)}</td>
    <td>${escapeHtml(m.platform || '-')}</td>
    <td>${escapeHtml(m.time || '')}</td>
    <td class="muted">${new Date(m.timestamp).toLocaleString()}</td>
    <td><button class="del" data-id="${m.id}">删除</button></td>
  </tr>`;

  const table = (title, list) => `
    <section class="board">
      <h2>${title} <span class="count">${list.length}</span></h2>
      ${list.length ? `<table>
        <thead><tr><th>验证码</th><th>来源</th><th>平台</th><th>时间</th><th>接收于</th><th></th></tr></thead>
        <tbody>${list.map(row).join('')}</tbody>
      </table>` : '<p class="empty">暂无记录</p>'}
    </section>`;

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OTP 看板</title>
<style>
  :root{--bg:#0d1213;--panel:#161c1d;--line:#2a3331;--txt:#e1e9e6;--muted:#8b9794;--accent:#20d9c2}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--txt)}
  header{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  h1{font-size:20px;margin:0}
  .actions{margin-left:auto;display:flex;gap:8px}
  button{background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer;font-size:14px}
  button:hover{border-color:var(--accent)}
  button.del{color:#ff9a9a}
  .wrap{padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media(max-width:760px){.wrap{grid-template-columns:1fr}}
  .board{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
  h2{font-size:16px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
  .count{background:var(--accent);color:#00201c;border-radius:999px;padding:1px 9px;font-size:13px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);font-size:14px}
  th{color:var(--muted);font-weight:500}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600;color:var(--accent)}
  .muted{color:var(--muted);font-size:13px}
  .empty{color:var(--muted)}
</style></head>
<body>
<header>
  <h1>OTP 验证码看板</h1>
  <div class="actions">
    <button id="refresh">刷新</button>
    <button id="export">导出 CSV</button>
    <button id="clear" class="del">清空全部</button>
  </div>
</header>
<div class="wrap">
  ${table('短信 / IM', sms)}
  ${table('邮件', email)}
</div>
<script>
  const qs = location.search;
  document.getElementById('refresh').onclick = () => location.reload();
  document.getElementById('export').onclick = () => window.open('/api/export.csv' + qs, '_blank');
  document.getElementById('clear').onclick = async () => {
    if (!confirm('确认清空全部验证码？')) return;
    const r = await fetch('/api/clear' + qs, { method: 'POST' });
    if (r.ok) location.reload();
  };
  document.querySelectorAll('.del').forEach(b => b.onclick = async () => {
    if (!confirm('删除这条记录？')) return;
    const r = await fetch('/api/messages/' + b.dataset.id + qs, { method: 'DELETE' });
    if (r.ok) location.reload();
  });
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function handleApiMessages(res) {
  const { sms, email } = getBoards();
  sendJson(res, 200, { sms, email });
}

function handleApiDelete(res, id) {
  const before = messages.length;
  messages = messages.filter((m) => m.id !== id);
  if (messages.length !== before) saveStore();
  sendJson(res, 200, { ok: true });
}

function handleApiClear(res) {
  messages = [];
  saveStore();
  sendJson(res, 200, { ok: true });
}

function handleApiExport(res) {
  const header = 'otp,source,category,platform,time,received_at\n';
  const lines = messages.map((m) =>
    [m.otp, m.source, m.category, m.platform || '', m.time || '', new Date(m.timestamp).toISOString()]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );
  const csv = '﻿' + header + lines.join('\n') + '\n';
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="otp-export.csv"',
  });
  res.end(csv);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/otp') return await handleIngest(req, res, ip);
    if (req.method === 'GET' && pathname === '/') {
      if (!adminAuthorized(req)) return sendText(res, 401, 'admin token required');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderDashboard());
    }
    if (req.method === 'GET' && pathname === '/api/messages') {
      if (!adminAuthorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return handleApiMessages(res);
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/messages/')) {
      if (!adminAuthorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return handleApiDelete(res, pathname.split('/').pop());
    }
    if (req.method === 'POST' && pathname === '/api/clear') {
      if (!adminAuthorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return handleApiClear(res);
    }
    if (req.method === 'GET' && pathname === '/api/export.csv') {
      if (!adminAuthorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return handleApiExport(res);
    }
    if (req.method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true });

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// Daily cleanup at 23:59 (local)
// ---------------------------------------------------------------------------
function pruneOld() {
  const cutoff = Date.now() - CONFIG.RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const before = messages.length;
  messages = messages.filter((m) => m.timestamp >= cutoff);
  if (messages.length !== before) {
    saveStore();
    console.log(`[cleanup] pruned ${before - messages.length} codes older than ${CONFIG.RETENTION_DAYS}d`);
  }
}

function scheduleDailyCleanup() {
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 23 && now.getMinutes() === 59) pruneOld();
  }, 60 * 1000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
ensureStore();
pruneOld();
scheduleDailyCleanup();

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`OTP Board listening on http://${CONFIG.HOST}:${CONFIG.PORT}`);
  if (!CONFIG.INGEST_TOKEN) console.log('[warn] INGEST_TOKEN not set — anyone can POST /otp');
  if (!CONFIG.ADMIN_TOKEN) console.log('[warn] ADMIN_TOKEN not set — dashboard is open');
});

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) {
    console.error('[env] failed to load .env:', e.message);
  }
}

___SERVERJS___

cat > shared/js/otp-core.js <<'___OTPCORE___'
'use strict';

/**
 * shared/js/otp-core.js
 * ----------------------
 * A faithful JavaScript port of the Android client's `OtpExtractor` (android/otp-core).
 * The SAME extraction + platform-classification logic now runs on both sides of the
 * wire, so the server can re-validate / re-extract codes (e.g. an email-ingestion
 * endpoint) and classify notification packages without drifting from the client.
 *
 * Rule data lives in ../otp-rules.json (the single source of truth). The module falls
 * back to built-in defaults if the JSON cannot be loaded, so it stays testable in isolation.
 *
 * Pure Node.js — no third-party dependencies.
 */

const fs = require('fs');
const path = require('path');

let RULES = null;
try {
  RULES = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'otp-rules.json'), 'utf8'),
  );
} catch (_e) {
  RULES = null;
}

const DEFAULTS = {
  whitelist: [
    '验证码', '验码', '校验码', '认证码', '确认码', '安全码', '登录码', '登陆码',
    '短信码', '动态码', '动态口令', '一次性密码', '一次性口令', '激活码',
    'code', 'otp', 'verification', 'pin', 'token', 'verify',
    'verifying', 'one-time', 'one time', 'security code', 'authentication',
    'authenticate', 'confirmation', 'password', 'passcode', 'login', 'sign-in',
    'sign in', 'confirm', 'secure', 'weixin', 'wechat', 'linking',
  ],
  blacklist: [
    '促销', '优惠', '打折', '满减', '返利', '抽奖', '中奖', '领红包',
    '退订回复TD', '回复T', '回复N',
    '已发货', '取件码', '快递', '余额', '账单', '消费', '还款', '扣款',
  ],
  carrierMap: {
    '10000': '中国电信', '10010': '中国联通', '10086': '中国移动', '10099': '中国广电',
    '95588': '工商银行', '95533': '建设银行', '95555': '招商银行', '95566': '中国银行',
    '95599': '农业银行', '95528': '浦发银行', '95561': '兴业银行', '95568': '民生银行',
    '95559': '交通银行', '95558': '中信银行', '95511': '平安银行', '95577': '华夏银行',
    '95508': '广发银行', '95580': '邮储银行',
  },
  knownBrands: [
    'Google', 'ChatGPT', 'OpenAI', 'Microsoft', 'Apple', 'FaceBook',
    'Instagram', 'Twitter', 'Alipay', 'WeChat', '淘宝', '腾讯', 'giffgaff',
  ],
  supportedPackages: {},
};

const rules = RULES || DEFAULTS;

const CandidateKind = { NUMERIC: 'NUMERIC', SEPARATED_NUMERIC: 'SEPARATED_NUMERIC', ALPHANUMERIC: 'ALPHANUMERIC' };

function normalizeMessage(body) {
  return body
    .normalize('NFKC')
    .replace(/ /g, ' ')
    .replace(/ /g, ' ')
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/'/g, "'")
    .replace(/"/g, '"')
    .replace(/"/g, '"')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const DIRECT_PATTERNS = [
  /(?:weixin|wechat).{0,64}?(?:linking|verifying|verify).{0,32}?mobile\s+number\s*[\(（\[]\s*(\d{4,8})\s*[\)）\]]/i,
  /(?:linking|verifying|verification|verify|security\s+code|code).{0,48}?[\(（\[]\s*(\d{4,8})\s*[\)）\]]/i,
  /\b(?:verification\s+code|security\s+code|authentication\s+code|confirmation\s+code|one[ -]?time\s+(?:password|code)|otp(?:\s+code)?|passcode|pin)\s+[\(（\[]?\s*(\d{4,8})\b/i,
  /\b(?:your\s+)?(?:verification\s+code|security\s+code|authentication\s+code|confirmation\s+code|one[ -]?time\s+(?:password|code)|otp(?:\s+code)?|passcode|pin|token|code)\s*(?:is|=|:|：|-)\s*[\(（\[]?\s*([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b/i,
  /\b([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b\s*(?:is|=|:)\s*(?:your|the)\s+(?:[a-z0-9][a-z0-9 .,'_-]{0,32}\s+)?(?:verification\s+code|security\s+code|authentication\s+code|confirmation\s+code|one[ -]?time\s+(?:password|code)|otp(?:\s+code)?|passcode|pin|token|code)\b/i,
  /(?:your\s+)?(?:verification|authentication|security|confirmation|login|sign[ -]?in|one[ -]?time)?\s*(?:code|otp|pin|token|passcode)\s*(?:is|=|:|：|-)\s*[\(（\[]?\s*([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b/i,
  /\b([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b\s*(?:is|=|:)\s*(?:your|the)\s+(?:[a-z0-9][a-z0-9 .,'_-]{0,32}\s+)?(?:verification|authentication|security|confirmation|login|sign[ -]?in|one[ -]?time)?\s*(?:code|otp|pin|token|passcode)\b/i,
  /\b(?:use|enter|type|submit|input)\s+(?:the\s+)?(?:code\s+)?[\(（\[]?\s*((?:[a-z0-9]{4,10}|[a-z0-9]{2,5}-[a-z0-9]{2,5}))\b.{0,40}?\b(?:verify|verification|authenticate|confirm|login|sign[ -]?in|continue|proceed)\b/i,
  /\b(?:verify|verification|authenticate|confirm|login|sign[ -]?in).{0,32}?\b(?:with|using|code|otp|pin)\s*(?:is|=|:|：|-)?\s*[\(（\[]?\s*([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b/i,
  /\buse\s+([a-z0-9]{2,5}-[a-z0-9]{2,5})\s+to\s+(?:verify|confirm|sign\s+in|login)\b/i,
  /\b([a-z0-9]{2,5}-[a-z0-9]{2,5})\b\s+(?:is\s+your|for\s+your)\s+(?:verification\s+)?(?:code|otp|pin|token|passcode)\b/i,
];

function findDirectOtp(body) {
  for (const pattern of DIRECT_PATTERNS) {
    const m = pattern.exec(body);
    if (!m) continue;
    const otp = (m[1] || '').trim();
    if (otp && /\d/.test(otp)) return otp;
  }
  return null;
}

function buildCandidates(body) {
  const candidates = [];

  const separatedRe = /(?<!\d)(\d{3}[-\s.]\d{3}|\d{2}[-\s.]\d{4}|\d{4}[-\s.]\d{2})(?!\d)/g;
  let m;
  while ((m = separatedRe.exec(body)) !== null) {
    const value = m[0].trim();
    const normalized = value.replace(/\D/g, '');
    if (normalized.length >= 4 && normalized.length <= 8) {
      candidates.push({ value, normalized, start: m.index, end: m.index + m[0].length, kind: CandidateKind.SEPARATED_NUMERIC });
    }
  }

  const parenRe = /(?<!\d)[(（\[]\s*(\d{4,8})\s*[)）\]](?!\d)/g;
  while ((m = parenRe.exec(body)) !== null) {
    const value = m[1];
    const start = body.indexOf(value, m.index);
    candidates.push({ value, normalized: value, start, end: start + value.length, kind: CandidateKind.NUMERIC });
  }

  const plainRe = /(?<!\d)(\d{4,8})(?!\d)/g;
  while ((m = plainRe.exec(body)) !== null) {
    const value = m[0];
    candidates.push({ value, normalized: value, start: m.index, end: m.index + m[0].length, kind: CandidateKind.NUMERIC });
  }

  const alphaRe = /(?<![a-z0-9])(?=[a-z0-9-]{4,10}(?![a-z0-9]))(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9]{2,5}(?:-[a-z0-9]{2,5})?(?![a-z0-9])/gi;
  while ((m = alphaRe.exec(body)) !== null) {
    const value = m[0];
    candidates.push({ value, normalized: value, start: m.index, end: m.index + m[0].length, kind: CandidateKind.ALPHANUMERIC });
  }

  return candidates;
}

function scoreCandidate(body, candidate) {
  const lower = body.toLowerCase();
  const before = lower.substring(Math.max(0, candidate.start - 40), candidate.start);
  const after = lower.substring(candidate.end, Math.min(lower.length, candidate.end + 40));
  const around = `${before} ${after}`;
  let score = 0;

  if (candidate.kind === CandidateKind.SEPARATED_NUMERIC) score += 18;
  if (candidate.kind === CandidateKind.ALPHANUMERIC) score += 8;

  score += ({ 6: 18, 4: 10, 5: 10, 7: 10, 8: 10 })[candidate.normalized.length] || 0;

  if (/(验证码|验码|校验码|认证码|确认码|安全码|登录码|登陆码|短信码|动态码|动态口令|激活码|code|otp|pin|token|security|verification|verify|verifying|authentication)(?:[:：是为\s-]|\bis\b|\bare\b|\bthe\b)*$/.test(before.slice(-34))) {
    score += 60;
  }
  if (/^\s*(?:is\s+your|is\s+the|是您|为您|用于|to\s+verify|for\s+verification|verification|code|otp|pin)/.test(after.slice(0, 34))) {
    score += 48;
  }
  if (candidate.start > 0 && candidate.end < body.length) {
    const open = body[candidate.start - 1];
    const close = body[candidate.end];
    if ((open === '(' && close === ')') || (open === '（' && close === '）') || (open === '[' && close === ']')) {
      score += 44;
    }
  }
  if (/(weixin|wechat|linking|mobile\s+number|手机号|手机号码|绑定|验证|verify|verifying|verification|one[-\s]?time|security\s+code)/i.test(lower)) {
    score += 24;
  }

  if (/(\$|￥|¥|amount|balance|账单|余额|消费|订单|快递|取件|tracking|parcel)/i.test(around)) {
    score -= 70;
  }
  if (/(http|https|www\.|\.com|\.net|@)/i.test(around)) {
    score -= 20;
  }
  if (/(电话|tel|phone|call|热线|客服)/i.test(around) && !/(weixin|wechat|verify|verifying|verification|绑定|验证)/i.test(lower)) {
    score -= 60;
  }
  if (looksLikeDateOrTime(body, candidate)) score -= 70;
  if (new Set(candidate.normalized).size === 1) score -= 25;
  if (/(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)/.test(candidate.normalized)) {
    score -= 12;
  }

  return score;
}

function looksLikeDateOrTime(body, candidate) {
  const start = Math.max(0, candidate.start - 2);
  const end = Math.min(body.length, candidate.end + 2);
  const around = body.substring(start, end);
  return /(?<!\d)(?:(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])(?:[-/.](?:0?[1-9]|[12]\d|3[01]))?|(?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])[-/.](?:19|20)?\d{2}|(?:[01]?\d|2[0-3]):[0-5]\d)(?!\d)/.test(around);
}

function extractOtp(body) {
  const direct = findDirectOtp(body);
  if (direct) return direct;

  const lower = body.toLowerCase();
  if (!rules.whitelist.some((w) => lower.includes(w))) return null;

  const seen = new Set();
  const candidates = buildCandidates(body).filter((c) => {
    const key = `${c.normalized}:${c.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((c) => ({ c, score: scoreCandidate(body, c) }))
    .filter(({ c, score }) => score >= (c.kind === CandidateKind.ALPHANUMERIC ? 52 : 28));

  if (scored.length === 0) return null;

  let best = scored[0];
  for (const item of scored.slice(1)) {
    if (
      item.score > best.score ||
      (item.score === best.score && (item.c.normalized.length === 6 ? 1 : 0) > (best.c.normalized.length === 6 ? 1 : 0)) ||
      (item.score === best.score && (item.c.normalized.length === 6 ? 1 : 0) === (best.c.normalized.length === 6 ? 1 : 0) && item.c.start > best.c.start)
    ) {
      best = item;
    }
  }

  return best.c.kind === CandidateKind.ALPHANUMERIC ? best.c.value : best.c.normalized;
}

function clean(name) {
  const stopWords = ['is your', 'your', 'is', 'verification', 'code', '官方', '团队', '客服', '通知', '服务'];
  let result = (name || '').trim();
  for (const word of stopWords) {
    if (result.toLowerCase() === word.toLowerCase()) return '';
    if (result.toLowerCase().endsWith(word.toLowerCase())) {
      result = result.substring(0, result.length - word.length).trim();
    }
  }
  return result.toLowerCase() === 'is your' ? '' : result;
}

function extractPlatform(body, sender) {
  const trimmed = body.trim();

  let mm = /^[【\[<](.+?)[】\]>]/.exec(trimmed);
  if (mm) return clean(mm[1]);
  mm = /[【\[<](.+?)[】\]>]\s*$/.exec(trimmed);
  if (mm) return clean(mm[1]);

  const eng = /\d{4,8}\s+is\s+your\s+(.+?)\s+(?:verification\s+)?(?:code|otp|pin|token)/i.exec(body);
  if (eng) {
    const brand = eng[1].trim();
    if (brand.toLowerCase() !== 'verification') return clean(brand);
  }

  const cleanSender = (sender || '').replace('+86', '').replace(/\s/g, '');
  if (rules.carrierMap[cleanSender]) return rules.carrierMap[cleanSender];
  if (cleanSender.startsWith('955') || cleanSender.startsWith('966')) return cleanSender;
  if (cleanSender.startsWith('106')) return '商业短信';

  mm = /[（(](.+?)[）)]验证码/.exec(body);
  if (mm) return clean(mm[1]);

  for (const b of rules.knownBrands) {
    if (body.toLowerCase().includes(b.toLowerCase())) return b;
  }

  return '';
}

/** Core entry point. Returns { otp, platform, time } or null. `source` is intentionally NOT set here. */
function process(body, sender) {
  const normalizedBody = normalizeMessage(body);
  const otp = extractOtp(normalizedBody);
  if (!otp) return null;
  const platform = extractPlatform(normalizedBody, sender);
  const time = new Date().toTimeString().slice(0, 8);
  return { otp, platform, time };
}

/** Server-side helper: map an Android notification package name to its source + fallback platform. */
function classifySource(packageName) {
  const entry = rules.supportedPackages[packageName];
  return entry ? { source: entry.source, fallbackPlatform: entry.fallbackPlatform } : null;
}

function isEmailSource(source) {
  return source === 'Email' || (typeof source === 'string' && source.startsWith('Email-'));
}

module.exports = {
  process,
  extractOtp,
  extractPlatform,
  classifySource,
  isEmailSource,
  normalizeMessage,
  rules,
  CandidateKind,
};

___OTPCORE___

cat > server/package.json <<'___PKG___'
{
  "name": "otp-board-server",
  "version": "3.1.1",
  "description": "Zero-dependency Node.js ingestion + dashboard server for the OTP forwarder (reuses shared/js/otp-core).",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "MIT"
}

___PKG___

# --- 3.5 Interactive wizard (or defaults when non-interactive) ---
# Ask the user for the runtime config. Mirrors the original otp31.sh guided install.
echo ""
echo "============================================"
echo "  OTP Board 服务端配置向导"
echo "============================================"

ask INSTALL_DIR "安装目录" "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}/server" "${INSTALL_DIR}/shared/js"
cd "${INSTALL_DIR}"

ask PORT "HTTP 监听端口" "3000"
ask BIND "绑定地址（0.0.0.0=所有网卡 / 127.0.0.1=仅本机）" "0.0.0.0"
ask INGEST_TOKEN "推送接口 Token（留空则随机生成；手机端转发需带此 Token，否则 403）" ""
ask ADMIN_TOKEN "管理看板 Token（留空则随机生成；留空但想开放看板请输入 EMPTY）" ""
ask RETENTION_DAYS "验证码保留天数（自动清理）" "14"
ask RATE_LIMIT_PER_MIN "每分钟每 IP 最大推送次数（限流）" "30"

echo ""
echo "============================================"
echo "  开机自启配置"
echo "  1. 不配置开机自启（手动启动）"
echo "  2. crontab @reboot（推荐，最简单可靠）"
echo "  3. PM2 自带自启（需已安装 pm2）"
echo "  4. systemd 服务"
echo "============================================"
ask AUTO_START "请选择开机自启方式 (1/2/3/4)" "3"

# Confirmation step (skipped / auto-yes when non-interactive)
if [ "${INTERACTIVE}" -eq 1 ]; then
  echo ""
  echo "============================================"
  echo "  请确认以下信息："
  echo "  安装目录:        ${INSTALL_DIR}"
  echo "  监听端口:        ${PORT}"
  echo "  绑定地址:        ${BIND}"
  echo "  推送 Token:      ${INGEST_TOKEN:+${INGEST_TOKEN:0:6}******（已设置）}${INGEST_TOKEN:-<随机生成>}"
  echo "  管理 Token:      ${ADMIN_TOKEN:+${ADMIN_TOKEN:0:6}******（已设置）}${ADMIN_TOKEN:-<随机生成>}"
  echo "  保留天数:        ${RETENTION_DAYS} 天"
  echo "  限流:            ${RATE_LIMIT_PER_MIN} 次/分钟"
  case $AUTO_START in
    1) echo "  开机自启:        不配置" ;;
    2) echo "  开机自启:        crontab @reboot" ;;
    3) echo "  开机自启:        PM2 自带自启" ;;
    4) echo "  开机自启:        systemd 服务" ;;
  esac
  echo "============================================"
  read -r -p "以上信息正确吗？(y/n，默认 y): " CONFIRM
  CONFIRM="${CONFIRM:-y}"
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "已取消部署。"
    exit 1
  fi
fi

# Resolve empty tokens: random gen, or explicit EMPTY -> open dashboard.
if [ -z "${INGEST_TOKEN}" ]; then
  INGEST_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
fi
if [ "${ADMIN_TOKEN}" = "EMPTY" ]; then
  ADMIN_TOKEN=""
fi
if [ -z "${ADMIN_TOKEN}" ] && [ "${INTERACTIVE}" -eq 0 ]; then
  # Non-interactive: keep a random admin token so the dashboard isn't wide open.
  ADMIN_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
fi

# --- 4. .env ---
if [ ! -f server/.env ]; then
  cat > server/.env <<'___ENV___'
PORT=__PORT__
BIND=__BIND__
DATA_FILE=./data/messages.json
INGEST_TOKEN=__INGEST_TOKEN__
ADMIN_TOKEN=__ADMIN_TOKEN__
RETENTION_DAYS=__RETENTION_DAYS__
RATE_LIMIT_PER_MIN=__RATE_LIMIT_PER_MIN__
TZ=Asia/Shanghai
___ENV___
  sed -i.bak -E "s/__PORT__/${PORT}/" server/.env && rm -f server/.env.bak
  sed -i.bak -E "s/__BIND__/${BIND}/" server/.env && rm -f server/.env.bak
  sed -i.bak -E "s/__INGEST_TOKEN__/${INGEST_TOKEN}/" server/.env && rm -f server/.env.bak
  sed -i.bak -E "s/__ADMIN_TOKEN__/${ADMIN_TOKEN}/" server/.env && rm -f server/.env.bak
  sed -i.bak -E "s/__RETENTION_DAYS__/${RETENTION_DAYS}/" server/.env && rm -f server/.env.bak
  sed -i.bak -E "s/__RATE_LIMIT_PER_MIN__/${RATE_LIMIT_PER_MIN}/" server/.env && rm -f server/.env.bak
  echo "  .env created with your configuration."
  echo "  (edit server/.env to change PORT, TOKENS, retention, etc.)"
fi

# --- 5. Optional auto-start ---
setup_autostart() {
  case "$AUTO_START" in
    2)
      if command -v crontab >/dev/null 2>&1; then
        ( crontab -l 2>/dev/null | grep -v "otp-board" ; echo "@reboot cd ${INSTALL_DIR}/server && node server.js >> ${INSTALL_DIR}/server/otp-board.log 2>&1" ) | crontab -
        echo "  已配置 crontab @reboot 开机自启。"
      else
        echo "  未找到 crontab，跳过开机自启（方式 2 不可用）。"
      fi
      ;;
    3)
      if command -v pm2 >/dev/null 2>&1; then
        pm2 startup >/dev/null 2>&1 || true
        echo "  已配置 PM2 开机自启（pm2 startup）。"
      else
        echo "  未安装 pm2，跳过开机自启（方式 3 不可用，可改用方式 2）。"
      fi
      ;;
    4)
      if command -v systemctl >/dev/null 2>&1; then
        cat > /etc/systemd/system/otp-board.service <<EOF
[Unit]
Description=OTP Board server
After=network.target

[Service]
WorkingDirectory=${INSTALL_DIR}/server
ExecStart=$(command -v node) ${INSTALL_DIR}/server/server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload >/dev/null 2>&1 || true
        systemctl enable otp-board >/dev/null 2>&1 || true
        echo "  已配置 systemd 服务 otp-board（enable）。"
      else
        echo "  未找到 systemctl，跳过开机自启（方式 4 不可用）。"
      fi
      ;;
    *) echo "  不配置开机自启（手动启动）。" ;;
  esac
}
setup_autostart

# --- 6. Start service now (unless auto-start already handles it) ---
echo ""
echo "== Starting service =="
cd server
PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2- | tr -d '\r' || echo 3000)"
PORT="${PORT:-3000}"

if [ "${AUTO_START}" = "4" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl start otp-board >/dev/null 2>&1 || true
  echo "  started via systemd (systemctl start otp-board)."
elif [ "${AUTO_START}" = "3" ] && command -v pm2 >/dev/null 2>&1; then
  pm2 start server.js --name otp-board --update-env 2>/dev/null || pm2 start server.js --name otp-board
  pm2 save 2>/dev/null || true
  echo "  started via pm2 (name: otp-board)."
elif command -v pm2 >/dev/null 2>&1; then
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
