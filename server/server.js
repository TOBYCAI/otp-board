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
