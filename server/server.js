// ---------- WebCrypto 全局注入（修复 "An instance of the Crypto API could not be located"） ----------
// @simplewebauthn/server v13 依赖全局的 Web Crypto API（globalThis.crypto.subtle）。
// 部分运行环境（某些 Node 版本、pm2 启动方式）下 globalThis.crypto 未被自动暴露，
// 调用 generateRegistrationOptions() 时会抛 "An instance of the Crypto API could not be located"。
// 这里在加载 simplewebauthn 之前，用 Node 内置 crypto.webcrypto 兜底填充。
try {
  const _webcrypto = require('crypto').webcrypto
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto || !globalThis.crypto.subtle) {
    Object.defineProperty(globalThis, 'crypto', {
      value: _webcrypto,
      configurable: true,
      writable: true
    })
    console.log('[webauthn] 已用 Node 内置 crypto.webcrypto 兜底填充 globalThis.crypto')
  }
} catch (e) {
  console.error('[webauthn] 加载 WebCrypto 失败：', e && e.message ? e.message : e)
}

const express = require('express')
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.set('trust proxy', true)

// ---------- v3.1：logo 图标（标签页 favicon / iPhone 主屏幕 apple-touch-icon / PWA manifest） ----------
app.use(express.static(require('path').join(__dirname, 'public')))
app.get('/manifest.webmanifest', (_req, res) => {
  res.set('Content-Type', 'application/manifest+json')
  res.json({
    name: 'OTP 验证码看板',
    short_name: 'OTP 看板',
    description: '一次性验证码实时看板',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F4F7FA',
    theme_color: '#edf3f0',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  })
})

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server')
const { WebSocketServer } = require('ws')
// otp-board 兼容：手机端 content 原文的服务端提取（与 Android OtpExtractor 同规则）
const otpCore = require('../shared/js/otp-core.js')
const https = require('https')
const httpMod = require('http')
// v3.1 邮件直发：nodemailer 懒加载，缺失时不崩溃整个服务
let nodemailer = null
try { nodemailer = require('nodemailer') } catch (e) { console.error('[email] nodemailer 未安装，邮件通知不可用') }

// ---------- .env 加载（install.sh 写入；手动部署可自行编辑） ----------
function loadDotEnv(p) {
  try {
    if (!fs.existsSync(p)) return
    const t = fs.readFileSync(p, 'utf8')
    for (const line of t.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (m && !(m[1] in process.env)) {
        let v = m[2]
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        process.env[m[1]] = v
      }
    }
  } catch (e) {}
}
loadDotEnv(path.join(__dirname, '.env'))

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
const DOMAIN = process.env.DOMAIN || 'localhost'
const CLEANUP_HOUR = 23
const CLEANUP_MINUTE = 59
const REFRESH_INTERVAL = (parseInt(process.env.REFRESH_SEC, 10) || 5) * 1000

// ---------- WebAuthn（面容/触控ID）生物识别配置 ----------
// RP_NAME：浏览器弹窗里展示的可读服务名
const RP_NAME = 'OTP 验证码看板'
// ADMIN_USER_ID：固定用户句柄（user.id）。同一管理员账号必须用同一个句柄，
// 否则不同设备注册出来的凭据会被当成不同用户，导致登录时找不到凭据。
const ADMIN_USER_ID = Buffer.from('otp-admin-fixed-user-id')
const WEBAUTHN_FILE = path.join(__dirname, 'webauthn.json')

// 关键修复点：rpID 与 expectedOrigin 必须从「浏览器实际访问地址」推导，而不是写死成 https://域名。
// 此前在 macOS/iOS 上完全没反应，根因就是：本地用 localhost、手机走隧道/LAN IP 时，
// 真实 Origin / rpID 与写死的 https://域名 不匹配，验证被静默拒绝。
//  - 生产（宝塔反代）：请求带 x-forwarded-proto / Host，推导出 rpID=域名、origin=https://域名
//  - 本地/隧道：按真实 host 推导（如 localhost 或 xxx.trycloudflare.com），保证两端一致
function webauthnConfig(req) {
  // 兜底开关：某些反代/隧道（如 cloudflared/ngrok）若未能正确传递头，可手动指定公开地址，
  // 格式：export OTP_PUBLIC_ORIGIN=https://your.domain  （iOS 远程测试常用）
  if (process.env.OTP_PUBLIC_ORIGIN) {
    try {
      const u = new URL(process.env.OTP_PUBLIC_ORIGIN)
      return { rpID: u.hostname, expectedOrigin: process.env.OTP_PUBLIC_ORIGIN.replace(/\/+$/, '') }
    } catch (e) { /* 格式错误则忽略，继续走自动推导 */ }
  }
  // 反代会带上真实协议与真实主机头；本地直连则没有这些头，回退到 req 自身的 host / 协议
  const xfh = req.headers['x-forwarded-host']
  const xfpRaw = req.headers['x-forwarded-proto']
  // x-forwarded-proto 在不同反代下可能是数组（如 "https,https"），统一取第一段
  const xfp = String(Array.isArray(xfpRaw) ? xfpRaw[0] : (xfpRaw || '')).split(',')[0].trim()
  const host = xfh || req.headers.host || ''
  const hostNoPort = host.split(':')[0]   // rpID 与 origin 都不能带端口号
  // host 为空（极端情况）时回退到部署时填写的域名，避免崩溃
  const rpID = hostNoPort || DOMAIN
  // 协议推导（关键修复生产域名 origin 被算成 http 的问题）：
  //  - 命中生产域名 DOMAIN 时一律 https（浏览器真实 origin 必然是 https，避免 macOS/iOS 出现
  //    "expected http://..., got https://..."）。
  //  - 命中反代转发 host（xfh）但没带 proto 时，反代几乎都是 https 终止，按 https 处理。
  //  - 否则优先用 x-forwarded-proto；再否则按 req.secure 兜底。
  let proto
  if (rpID === DOMAIN) proto = 'https'
  else if (xfp) proto = xfp
  else if (xfh) proto = 'https'
  else proto = req.secure ? 'https' : 'http'
  // origin 必须去掉端口：https 默认 443 / http 默认 80 时，浏览器真实 origin 不含端口
  const originHost = hostNoPort || DOMAIN
  const expectedOrigin = proto + '://' + originHost
  console.log('[webauthn] config rpID=' + rpID + ' origin=' + expectedOrigin + ' (host=' + host + ', xfh=' + (xfh || '') + ', xfp=' + (xfp || '') + ')')
  return { rpID, expectedOrigin }
}

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(WEBAUTHN_FILE, 'utf8')) } catch (e) { return [] }
}
function saveCreds() {
  try { fs.writeFileSync(WEBAUTHN_FILE, JSON.stringify(webauthnCreds, null, 2)) } catch (e) {}
}
let webauthnCreds = loadCreds()

// ---------- WebAuthn 单次挑战存储 ----------
// 之前用单个全局变量 webauthnChallenge 保存挑战，但同一 admin 在多设备 / 多标签页同时打开后台时，
// 后一次 options 预取会覆盖前一次的 challenge，导致另一台设备 verify 时挑战不匹配
// （"Unexpected registration response challenge ..."，正是 macOS 报的错）。
// 改为按「挑战值本身」存进 Map：options 时写入（同时存下当时推导出的 rpID / origin），
// verify 时按浏览器回传的挑战反查并一次性销毁。多设备 / 多标签页天然互不干扰，
// 且 options 与 verify 使用的 rpID / origin 必然一致（顺带根除 origin 不匹配问题）。
const challengeStore = new Map()
const CHALLENGE_TTL = 5 * 60 * 1000 // 5 分钟过期，避免内存泄漏
function putChallenge(challenge, meta) {
  const now = Date.now()
  for (const [k, v] of challengeStore) {
    if (now - v.ts > CHALLENGE_TTL) challengeStore.delete(k)
  }
  challengeStore.set(challenge, Object.assign({ ts: now }, meta))
}
function takeChallenge(challenge) {
  const m = challengeStore.get(challenge)
  if (m) challengeStore.delete(challenge)
  return m
}
// 从浏览器回传的 attestation / assertion 里取出用户真正签名的挑战值（base64url 字符串）
function challengeFromBody(body) {
  try {
    const c = body && body.response && body.response.clientDataJSON
    if (!c) return null
    let b = String(c).replace(/-/g, '+').replace(/_/g, '/')
    while (b.length % 4) b += '='
    const clientData = JSON.parse(Buffer.from(b, 'base64').toString('utf8'))
    return clientData && clientData.challenge ? clientData.challenge : null
  } catch (e) { return null }
}

// ---------- v3.1 安全增强：Token 校验 / 限流 / 审计 / 登录锁定 ----------
const OTP_TOKEN = process.env.OTP_TOKEN || ''
const AUDIT_FILE = path.join(__dirname, 'audit.log')
const LOGIN_MAX_FAIL = 5
const LOGIN_LOCK_MS = 15 * 60 * 1000
const OTP_RATE_LIMIT = 30
const OTP_RATE_WINDOW = 60 * 1000

const loginFails = {}
const otpRate = {}

function clientIpOf(req) {
  const xff = req.headers && req.headers['x-forwarded-for']
  const ip = (xff ? String(xff).split(',')[0].trim() : '') || req.ip || (req.connection && req.connection.remoteAddress) || 'unknown'
  return ip
}
function audit(action, detail, req) {
  const ip = req ? clientIpOf(req) : 'system'
  const line = new Date().toISOString() + ' | ' + ip + ' | ' + action + ' | ' + (detail || '') + '\n'
  try { fs.appendFileSync(AUDIT_FILE, line) } catch (e) {}
}
function isLocked(ip) {
  const f = loginFails[ip]
  return !!(f && f.lockUntil && f.lockUntil > Date.now())
}
function registerLoginFail(ip) {
  const f = loginFails[ip] || { count: 0, lockUntil: 0 }
  f.count++
  if (f.count >= LOGIN_MAX_FAIL) f.lockUntil = Date.now() + LOGIN_LOCK_MS
  loginFails[ip] = f
  return f
}
function resetLoginFails(ip) { delete loginFails[ip] }
function otpAllowed(ip) {
  const now = Date.now()
  let r = otpRate[ip]
  if (!r || now - r.start > OTP_RATE_WINDOW) { r = { count: 0, start: now }; otpRate[ip] = r }
  if (r.count >= OTP_RATE_LIMIT) return false
  r.count++
  return true
}

// ---------- v3.1 外部通知集成（Telegram / 企业微信 / 飞书 / Bark / 自定义 Webhook）----------
// 仅使用 Node 内置 http/https，不引入额外依赖
const NOTIFY_FILE = path.join(__dirname, 'notify.json')
const DEFAULT_NOTIFY = {
  enabled: false,
  telegram: { botToken: '', chatId: '' },
  wecom: { key: '' },
  feishu: { key: '' },
  bark: { key: '', server: 'https://api.day.app' },
  webhook: { url: '', secret: '' },
  email: { host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '' }
}
function loadNotify() {
  try {
    const raw = JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8'))
    return Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_NOTIFY)), raw)
  } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_NOTIFY)) }
}
function saveNotify() {
  try { fs.writeFileSync(NOTIFY_FILE, JSON.stringify(notifyCfg, null, 2)) } catch (e) { console.error('[notify] save fail', e.message) }
}
let notifyCfg = loadNotify()
let emailTransporter = null // v3.1 SMTP transporter 缓存，配置变更后失效重建

// 通用 HTTP 请求（内置模块，返回 Promise）
function httpSend(urlStr, method, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return reject(e) }
    const lib = u.protocol === 'http:' ? httpMod : https
    const opts = { method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: headers || {} }
    const req = lib.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', reject)
    req.setTimeout(12000, () => req.destroy(new Error('请求超时（12 秒），请检查服务器能否访问该通知平台')))
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// Telegram Bot API：目标必须是用户/群组的 Chat ID（或频道 @username），不是机器人用户名。
// 同时检查 Telegram 返回的 ok 字段，避免接口报错时前端仍显示“已触发”。
function sendTelegram(tg, text) {
  const botToken = String(tg && tg.botToken || '').trim().replace(/^bot/i, '')
  const chatId = String(tg && tg.chatId || '').trim()
  if (!botToken) return Promise.reject(new Error('请填写 Bot Token'))
  if (!chatId) return Promise.reject(new Error('请填写接收方 Chat ID；这里不能填机器人名字'))
  const url = 'https://api.telegram.org/bot' + botToken + '/sendMessage'
  const payload = JSON.stringify({ chat_id: chatId, text: text })
  return httpSend(url, 'POST', {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }, payload).then(result => {
    let data = null
    try { data = JSON.parse(result.body) } catch (e) {}
    if (result.status < 200 || result.status >= 300 || !data || data.ok !== true) {
      let detail = data && data.description ? data.description : ('HTTP ' + result.status)
      if (/chat not found/i.test(detail)) detail += '；请先私聊机器人发送 /start，并确认填写的是 message.chat.id'
      if (/unauthorized/i.test(detail)) detail += '；Bot Token 无效或已被 BotFather 重置'
      throw new Error(detail)
    }
    return data
  })
}

function sendFeishu(feishu, text) {
  let key = String(feishu && feishu.key || '').trim()
  if (!key) return Promise.reject(new Error('请填写 Webhook Key'))
  const match = key.match(/\/bot\/v2\/hook\/([^/?#]+)/)
  if (match) key = match[1]
  const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/' + key
  const payload = JSON.stringify({ msg_type: 'text', content: { text: text } })
  return httpSend(url, 'POST', {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }, payload).then(result => {
    let data = null
    try { data = JSON.parse(result.body) } catch (e) {}
    const code = data && (data.code != null ? data.code : data.StatusCode)
    if (result.status < 200 || result.status >= 300 || !data || Number(code) !== 0) {
      throw new Error((data && (data.msg || data.StatusMessage)) || ('HTTP ' + result.status))
    }
    return data
  })
}

function requireHttpSuccess(result) {
  if (result.status < 200 || result.status >= 300) throw new Error('HTTP ' + result.status + (result.body ? '：' + result.body.slice(0, 160) : ''))
  return result
}

function testWecom(cfg, text) {
  let key = String(cfg && cfg.key || '').trim()
  if (!key) return Promise.reject(new Error('请填写 Webhook Key'))
  const match = key.match(/[?&]key=([^&#]+)/)
  if (match) key = match[1]
  const payload = JSON.stringify({ msgtype: 'text', text: { content: text } })
  return httpSend('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + key, 'POST', { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, payload).then(requireHttpSuccess).then(result => {
    let data = null; try { data = JSON.parse(result.body) } catch (e) {}
    if (!data || Number(data.errcode) !== 0) throw new Error((data && data.errmsg) || '企业微信返回格式异常')
  })
}

function testBark(cfg, text) {
  const key = String(cfg && cfg.key || '').trim()
  if (!key) return Promise.reject(new Error('请填写 Device Key'))
  const server = String(cfg.server || 'https://api.day.app').trim().replace(/\/+$/, '')
  return httpSend(server + '/' + key + '/' + encodeURIComponent('验证码看板') + '/' + encodeURIComponent(text), 'GET').then(requireHttpSuccess)
}

function testWebhook(cfg, text) {
  const url = String(cfg && cfg.url || '').trim()
  if (!url) return Promise.reject(new Error('请填写 Webhook URL'))
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.secret) headers['x-notify-secret'] = cfg.secret
  const payload = JSON.stringify({ title: '验证码看板', text: text, otp: '123456', source: 'Test' })
  headers['Content-Length'] = Buffer.byteLength(payload)
  return httpSend(url, 'POST', headers, payload).then(requireHttpSuccess)
}

function testEmail(cfg) {
  if (!nodemailer) return Promise.reject(new Error('nodemailer 未安装'))
  if (!cfg.host || !cfg.to) return Promise.reject(new Error('请填写 SMTP 服务器和收件人'))
  const transporter = nodemailer.createTransport({ host: cfg.host, port: parseInt(cfg.port, 10) || 465, secure: cfg.secure !== false, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined })
  return transporter.sendMail({ from: cfg.from || cfg.user, to: cfg.to, subject: '[验证码看板] 通知测试', text: '验证码：123456\n这是一封测试邮件。' })
}

// 收到新验证码时，向已启用的渠道推送
function notifyNewOtp(item) {
  if (!notifyCfg.enabled) return
  const src = (item.source === 'Email' || String(item.source || '').startsWith('Email')) ? '邮件' : (item.source || '短信')
  const body = '验证码：' + item.otp + '\n来源：' + src + (item.platform ? '（' + item.platform + '）' : '') + '\n时间：' + (item.time || '')
  const text = '新验证码\n' + body
  const title = '验证码看板'
  // Telegram
  const tg = notifyCfg.telegram
  if (tg && tg.botToken && tg.chatId) {
    sendTelegram(tg, text)
      .catch(e => console.error('[notify] telegram fail:', e.message))
  }
  // 企业微信群机器人
  const wx = notifyCfg.wecom
  if (wx && wx.key) {
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + wx.key
    httpSend(url, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ msgtype: 'text', text: { content: text } }))
      .catch(e => console.error('[notify] wecom fail:', e.message))
  }
  // 飞书机器人
  const fs2 = notifyCfg.feishu
  if (fs2 && fs2.key) {
    sendFeishu(fs2, text)
      .catch(e => console.error('[notify] feishu fail:', e.message))
  }
  // Bark（iOS 推送）
  const bk = notifyCfg.bark
  if (bk && bk.key) {
    const server = (bk.server || 'https://api.day.app').replace(/\/+$/, '')
    const url = server + '/' + bk.key + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body)
    httpSend(url, 'GET')
      .catch(e => console.error('[notify] bark fail:', e.message))
  }
  // 自定义 Webhook（可对接邮件网关 / Server 酱 / 推送加 等）
  const wh = notifyCfg.webhook
  if (wh && wh.url) {
    const h = { 'Content-Type': 'application/json' }
    if (wh.secret) h['x-notify-secret'] = wh.secret
    httpSend(wh.url, 'POST', h, JSON.stringify({ title: title, text: text, otp: item.otp, source: item.source, time: item.time, platform: item.platform }))
      .catch(e => console.error('[notify] webhook fail:', e.message))
  }
  // 邮件直发（SMTP）
  const em = notifyCfg.email
  if (em && em.host && em.to) {
    try { sendEmailNotify(item) } catch (e) { console.error('[notify] email dispatch fail:', e.message) }
  }
}

// SMTP 发送（懒重建 transporter，配置变更后 emailTransporter 置空）
function sendEmailNotify(item) {
  if (!nodemailer) { console.error('[notify] email 不可用：nodemailer 缺失'); return }
  const em = notifyCfg.email
  if (!em || !em.host || !em.to) return
  if (!emailTransporter) {
    emailTransporter = nodemailer.createTransport({
      host: em.host,
      port: parseInt(em.port, 10) || 465,
      secure: em.secure !== false,
      auth: em.user ? { user: em.user, pass: em.pass } : undefined
    })
  }
  const src = (item.source === 'Email' || String(item.source || '').startsWith('Email')) ? '邮件' : (item.source || '短信')
  const text = '新验证码\n验证码：' + item.otp + '\n来源：' + src + (item.platform ? '（' + item.platform + '）' : '') + '\n时间：' + (item.time || '')
  const from = em.from || em.user
  if (!from) { console.error('[notify] email 缺少发件人'); return }
  emailTransporter.sendMail({ from: from, to: em.to, subject: '[验证码看板] 新验证码 ' + item.otp, text: text }, (err) => {
    if (err) console.error('[notify] email fail:', err.message)
    else console.log('[notify] email sent ->', em.to)
  })
}

function toBase64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) str += '='
  return Buffer.from(str, 'base64')
}

// ---------- v3.1 数据持久化：验证码存入 otp.json，重启不丢 ----------
const OTP_FILE = path.join(__dirname, 'otp.json')
const OTP_MAX = 200
const OTP_TTL = 86400000 // 24 小时
function loadOtp() {
  try {
    const arr = JSON.parse(fs.readFileSync(OTP_FILE, 'utf8'))
    if (!Array.isArray(arr)) return []
    const cutoff = Date.now() - OTP_TTL
    // 启动时按 TTL 过滤一次，避免陈旧数据堆积
    return arr.filter(i => i && (i.timestamp || 0) > cutoff).slice(0, OTP_MAX)
  } catch (e) { return [] }
}
function saveOtp() {
  try {
    const tmp = OTP_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(otpList))
    fs.renameSync(tmp, OTP_FILE) // 原子替换，避免写一半崩溃导致文件损坏
  } catch (e) { console.error('[otp] save fail', e.message) }
}
let otpList = loadOtp()
let lastOtpIds = [] // v3.1: 用于新消息检测
const OTP_DEDUP_WINDOW_MS = 120000 // 与安卓端一致：同一验证码 2 分钟内只入库一次（幂等投递）
const otpDedup = new Map()

/* ---------- v3.1 API ---------- */
// otp-board 部署脚本健康检查
app.get('/healthz', (_req, res) => res.send('ok'))
app.post('/otp', (req, res) => {
  const ip = clientIpOf(req)
  if (!otpAllowed(ip)) return res.status(429).send('too many requests')
  if (OTP_TOKEN && req.body.token !== OTP_TOKEN && req.query.token !== OTP_TOKEN && req.get('x-otp-token') !== OTP_TOKEN && req.get('x-token') !== OTP_TOKEN) {
    audit('otp_rejected', 'invalid token', req)
    return res.status(403).send('invalid token')
  }
  let { otp, source, time, platform } = req.body
  // otp-board 兼容：手机端只发 content 原文时，由服务端用 otp-core 提取验证码
  if (!otp && req.body.content) {
    const r = otpCore.process(String(req.body.content), String(platform || ''))
    if (r) otp = r.otp
  }
  if (!otp) return res.status(400).send('missing otp')
  const now = Date.now()
  if (otpDedup.size > 500) {
    for (const [k, v] of otpDedup) if (now - v >= OTP_DEDUP_WINDOW_MS) otpDedup.delete(k)
  }
  const dedupKey = String(otp)
  const lastSeen = otpDedup.get(dedupKey)
  if (lastSeen && now - lastSeen < OTP_DEDUP_WINDOW_MS) return res.send('ok') // 安卓重试不会产生重复条目
  otpDedup.set(dedupKey, now)
  const item = {
    otp,
    source: source || 'SMS',
    time: time || new Date().toLocaleTimeString(),
    platform: platform || '',
    timestamp: now
  }
  otpList.unshift(item)
  if (otpList.length > OTP_MAX) otpList.pop()
  try { saveOtp() } catch (e) {}
  try { broadcastUpdate() } catch (e) {}
  try { notifyNewOtp(item) } catch (e) { console.error('[notify] dispatch fail:', e.message) }
  res.send('ok')
})

function getOtpData() {
  const cutoff = Date.now() - OTP_TTL
  const before = otpList.length
  otpList = otpList.filter(i => (i.timestamp || 0) > cutoff)
  if (otpList.length !== before) { try { saveOtp() } catch (e) {} } // TTL 淘汰后同步落盘
  const smsList = otpList.filter(isSmsItem)
  const otherList = otpList.filter(i => !isSmsItem(i))
  return {
    sms: smsList.map(i => ({ otp: i.otp, source: i.source, time: i.time, platform: i.platform, timestamp: i.timestamp })),
    other: otherList.map(i => ({ otp: i.otp, source: i.source, time: i.time, platform: i.platform, timestamp: i.timestamp }))
  }
}

// 只有明确来自系统短信接收器的记录归入“短信通道”；
// WhatsApp、Gmail、Outlook 等通知监听器抓取的内容统一归入“其它通道”。
function isSmsItem(item) {
  const source = String(item && item.source || '').trim()
  return !source || /^sms(?:[-_ ]|$)/i.test(source) || source === '短信'
}

app.get('/api/data', (_req, res) => {
  res.json(getOtpData())
})

// ---------- v3.1 统一主题：系统偏好 + 本地持久化，所有页面共享 ----------
const THEME_BOOT = '<script>(function(){var t="light";try{var s=localStorage.getItem("otp-theme");if(s==="light"||s==="dark")t=s}catch(e){}document.documentElement.setAttribute("data-theme",t);document.documentElement.style.colorScheme=t;var m=document.querySelector("meta[name=theme-color]");if(m)m.setAttribute("content",t==="dark"?"#0b1113":"#edf3f0");var a=document.querySelector("meta[name=apple-mobile-web-app-status-bar-style]");if(a)a.setAttribute("content",t==="dark"?"black-translucent":"default")})()</script>'
const THEME_JS = 'function applyThemeChrome(){var dark=document.documentElement.getAttribute("data-theme")==="dark";var color=dark?"#0b1113":"#edf3f0";document.documentElement.style.colorScheme=dark?"dark":"light";var meta=document.querySelector("meta[name=theme-color]");if(!meta){meta=document.createElement("meta");meta.name="theme-color";document.head.appendChild(meta)}meta.content=color;var apple=document.querySelector("meta[name=apple-mobile-web-app-status-bar-style]");if(apple)apple.content=dark?"black-translucent":"default";var moon="<svg viewBox=0,0,24,24 width=20 height=20 aria-hidden=true focusable=false fill=none stroke=currentColor stroke-width=1.8 stroke-linecap=round stroke-linejoin=round><path d=M20.5,15.2A8.6,8.6,0,0,1,8.8,3.5A8.6,8.6,0,1,0,20.5,15.2Z></path></svg>";var sun="<svg viewBox=0,0,24,24 width=20 height=20 aria-hidden=true focusable=false fill=none stroke=currentColor stroke-width=1.8 stroke-linecap=round><circle cx=12 cy=12 r=3.7></circle><path d=M12,2.5v2M12,19.5v2M4.6,4.6,6,6M18,18l1.4,1.4M2.5,12h2M19.5,12h2M4.6,19.4,6,18M18,6l1.4-1.4></path></svg>";document.querySelectorAll("[data-theme-toggle]").forEach(function(b){b.innerHTML=dark?sun:moon;b.setAttribute("aria-label",dark?"切换到浅色模式":"切换到深色模式");b.setAttribute("title",dark?"浅色模式":"深色模式")})}function toggleTheme(){var next=document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",next);try{localStorage.setItem("otp-theme",next)}catch(e){}applyThemeChrome()}applyThemeChrome();'

function uiIcon(name, cls) {
  const paths = {
    shield: '<path d="M12 3 5.5 5.7v5.6c0 4.2 2.7 7.7 6.5 9.7 3.8-2 6.5-5.5 6.5-9.7V5.7L12 3Z"/><path d="m9.2 12 1.8 1.8 3.9-4.1"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10M12 14v2"/>',
    chart: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    message: '<path d="M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4v8Z"/><path d="M8 9h8M8 13h5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    spark: '<path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>'
  }
  return '<svg class="ui-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.shield) + '</svg>'
}

/* ---------- 前台 ---------- */
app.get('/', (_req, res) => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth()+1).padStart(2,'0')
  const day = String(now.getDate()).padStart(2,'0')
  const today = year + '-' + month + '-' + day
  
  const cutoff = Date.now() - 86400000
  otpList = otpList.filter(i => (i.timestamp || 0) > cutoff)

  const smsList = otpList.filter(isSmsItem)
  const otherList = otpList.filter(i => !isSmsItem(i))

  let smsCards = ''
  if (smsList.length) {
    for (let i = 0; i < smsList.length; i++) {
      smsCards += renderCard(smsList[i], 'sms')
    }
  } else {
    smsCards = '<div class="empty-state"><div class="empty-icon"></div><div class="empty-text">暂无短信验证码</div></div>'
  }

  let otherCards = ''
  if (otherList.length) {
    for (let i = 0; i < otherList.length; i++) {
      otherCards += renderCard(otherList[i], 'other')
    }
  } else {
    otherCards = '<div class="empty-state"><div class="empty-icon"></div><div class="empty-text">暂无通知验证码</div></div>'
  }

  let html = '<!DOCTYPE html>'
  html += '<html lang="zh-CN">'
  html += '<head><link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32"><link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#edf3f0"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="OTP 看板">'
  html += '<meta charset="utf-8">'
  html += '<meta name="viewport" content="width=device-width,initial-scale=1">'
  html += '<title>OTP看板 - ' + today + '</title>'
  html += THEME_BOOT
  html += '<style>'
  html += ':root{--bg:#edf3f0;--surface:rgba(255,255,255,.82);--surface-2:#fff;--line:rgba(19,55,44,.12);--text:#10211b;--muted:#64756f;--green:#087f58;--cyan:#087f92;--amber:#a96712;--danger:#cc4650;--radius:8px;--shadow:0 24px 70px rgba(26,65,52,.16)}'
  html += 'html[data-theme="dark"]{--bg:#0b1113;--surface:rgba(18,28,32,.88);--surface-2:#121c20;--line:rgba(190,255,225,.13);--text:#f2f7f5;--muted:#91a19c;--green:#73e8b6;--cyan:#62d5e5;--amber:#ffd07a;--danger:#ff8389;--shadow:0 24px 70px rgba(0,0,0,.4);color-scheme:dark}'
  html += '*{margin:0;padding:0;box-sizing:border-box}'
  html += 'html{color-scheme:light}'
  html += 'body{font-family:Inter,"SF Pro Display","PingFang SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0;background:linear-gradient(145deg,#f7faf8 0%,var(--bg) 55%,#e7f1ef 100%);color:var(--text);min-height:100vh;padding:24px 18px 56px;position:relative;overflow-x:hidden}'
  html += 'html[data-theme="dark"] body{background:linear-gradient(145deg,#121b1e 0%,var(--bg) 58%,#0c1517 100%)}'
  html += 'body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(8,127,88,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(8,127,88,.045) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,black,transparent 82%)}'
  html += '.glow-layer{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;background:linear-gradient(110deg,transparent 0 42%,rgba(8,127,146,.025) 46%,rgba(8,127,88,.105) 50%,rgba(255,202,104,.055) 54%,transparent 58%);background-size:240% 100%;animation:ambientSweep 11s linear infinite}'
  html += '.glow-layer:after{content:"";position:absolute;left:0;right:0;top:-1px;height:1px;background:linear-gradient(90deg,transparent,#21b985,transparent);box-shadow:0 0 22px rgba(33,185,133,.42);animation:scanDown 8s ease-in-out infinite}'
  html += 'html[data-theme="dark"] body:before{background-image:linear-gradient(rgba(115,232,182,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(115,232,182,.035) 1px,transparent 1px)}html[data-theme="dark"] .glow-layer{background:linear-gradient(110deg,transparent 0 42%,rgba(98,213,229,.025) 46%,rgba(115,232,182,.08) 50%,rgba(255,208,122,.035) 54%,transparent 58%);background-size:240% 100%}'
  html += '@keyframes ambientSweep{to{background-position:-240% 0}}@keyframes scanDown{0%,10%{top:0;opacity:0}20%{opacity:.7}80%{opacity:.18}90%,100%{top:100%;opacity:0}}'
  html += '.container{width:min(100%,720px);margin:0 auto;position:relative;z-index:1}.ui-icon{width:1em;height:1em;display:inline-block;vertical-align:-.14em;flex:0 0 auto}'
  html += '.header{padding:30px 2px 28px;display:grid;grid-template-columns:1fr auto;gap:18px;align-items:end;border-bottom:1px solid var(--line);margin-bottom:18px}'
  html += '.brand{display:flex;align-items:center}.header-actions{display:flex;align-items:center;gap:12px}.theme-toggle{width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--text);font-size:18px;cursor:pointer;box-shadow:0 8px 24px rgba(26,65,52,.07);transition:transform .2s,border-color .2s,background .2s}.theme-toggle:hover{transform:translateY(-1px);border-color:var(--green)}.theme-toggle:focus-visible{outline:2px solid var(--green);outline-offset:2px}'
  html += '.header h1{font-size:clamp(22px,5vw,32px);line-height:1.1;font-weight:720}.header p{font-size:13px;color:var(--muted);margin-top:7px}'
  html += '.live-status{display:flex;align-items:center;gap:8px;color:var(--green);font-size:12px;font-weight:650;white-space:nowrap}.status-dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px rgba(115,242,183,.08),0 0 16px currentColor;animation:statusPulse 2s ease-out infinite}.live-status.offline{color:var(--danger)}@keyframes statusPulse{50%{box-shadow:0 0 0 8px transparent,0 0 20px currentColor}}'
  html += '.subbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.date-badge{font:600 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}'
  html += '.admin-link{color:var(--muted);text-decoration:none;font-size:12px;padding:8px;border-radius:6px;transition:color .2s,background .2s}.admin-link:hover{color:var(--text);background:rgba(8,127,88,.06)}.admin-link:focus-visible{outline:2px solid var(--green);outline-offset:2px}'
  html += '.tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;padding:4px;background:rgba(255,255,255,.5);border:1px solid var(--line);border-radius:8px;margin-bottom:14px;box-shadow:0 8px 28px rgba(26,65,52,.06);backdrop-filter:blur(16px)}'
  html += 'html[data-theme="dark"] .tabs{background:rgba(9,15,17,.55);box-shadow:0 8px 28px rgba(0,0,0,.18)}'
  html += '.tab{min-height:42px;border:0;border-radius:5px;font-size:13px;font-weight:650;cursor:pointer;color:var(--muted);background:transparent;transition:color .2s,background .2s,box-shadow .2s;display:flex;align-items:center;justify-content:center;gap:7px}.tab .ui-icon{width:15px;height:15px;color:var(--green);opacity:.72}.tab.active .ui-icon{opacity:1}.tab:hover{color:var(--text)}.tab:focus-visible{outline:2px solid var(--green);outline-offset:1px}.tab.active{background:var(--surface-2);color:var(--text);box-shadow:inset 0 0 0 1px rgba(115,242,183,.12)}'
  html += '.tab-count{display:inline-grid;place-items:center;min-width:20px;height:20px;margin-left:7px;border-radius:5px;background:rgba(16,33,27,.05);color:var(--muted);font-size:11px}.tab.active .tab-count{color:var(--green);background:rgba(8,127,88,.08)}'
  html += '.card-list{display:none}.card-list.active{display:block}'
  html += '.card{position:relative;isolation:isolate;overflow:hidden;min-height:96px;padding:19px 20px;margin-bottom:10px;display:flex;align-items:center;background:linear-gradient(120deg,rgba(255,255,255,.94),rgba(247,251,249,.88));backdrop-filter:blur(18px);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 12px 34px rgba(26,65,52,.09),inset 0 1px rgba(255,255,255,.9);cursor:pointer;user-select:none;animation:cardIn .42s cubic-bezier(.2,.75,.25,1) both;transition:transform .2s,border-color .2s,box-shadow .2s}'
  html += '.card:before{content:"";position:absolute;z-index:-1;inset:-1px;background:radial-gradient(260px circle at var(--mx,50%) var(--my,50%),rgba(33,185,133,.13),transparent 62%);opacity:0;transition:opacity .25s}.card:after{content:"COPY";position:absolute;right:18px;top:18px;color:rgba(42,78,66,.32);font:700 9px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.16em}'
  html += '.card:hover{transform:translateY(-2px);border-color:rgba(8,127,88,.3);box-shadow:0 18px 46px rgba(26,65,52,.15),0 0 30px rgba(33,185,133,.08)}.card:hover:before{opacity:1}.card:active{transform:scale(.99)}.card:focus-visible{outline:2px solid var(--green);outline-offset:3px}'
  html += 'html[data-theme="dark"] .card{background:linear-gradient(120deg,rgba(18,28,32,.96),rgba(12,19,22,.94));box-shadow:0 12px 34px rgba(0,0,0,.23),inset 0 1px rgba(255,255,255,.035)}html[data-theme="dark"] .card:hover{border-color:rgba(115,232,182,.3);box-shadow:0 18px 46px rgba(0,0,0,.32),0 0 30px rgba(115,232,182,.07)}'
  html += '.card.copied{border-color:var(--green);box-shadow:0 0 0 1px rgba(115,242,183,.25),0 0 34px rgba(115,242,183,.15)}.card.copied:after{content:"COPIED";color:var(--green)}'
  html += '@keyframes cardIn{from{opacity:0;transform:translateY(12px);filter:blur(5px)}to{opacity:1;transform:none;filter:none}}'
  html += '.card-left{width:100%;min-width:0}.otp-number{font:750 clamp(27px,8vw,38px)/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text);letter-spacing:.14em;text-shadow:0 0 28px rgba(115,242,183,.12);overflow-wrap:anywhere}'
  html += '.otp-source{font-size:11px;color:var(--muted);margin-top:13px;display:flex;align-items:center;flex-wrap:wrap;gap:7px}.otp-source .tag,.platform-badge{display:inline-flex;align-items:center;min-height:20px;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase}.tag-sms{background:rgba(88,215,231,.09);color:var(--cyan)}.tag-email{background:rgba(255,212,121,.09);color:var(--amber)}.platform-badge{background:rgba(115,242,183,.08);color:var(--green)}'
  html += '.empty-state{text-align:center;padding:72px 20px;border:1px dashed rgba(190,255,225,.13);border-radius:var(--radius);color:var(--muted)}.empty-icon{font-size:0;width:32px;height:32px;margin:0 auto 16px;border:1px solid rgba(115,242,183,.28);border-radius:50%;position:relative}.empty-icon:before,.empty-icon:after{content:"";position:absolute;background:var(--green);opacity:.7}.empty-icon:before{width:10px;height:1px;left:10px;top:15px}.empty-icon:after{width:1px;height:10px;left:15px;top:10px}.empty-text{font-size:13px}'
  html += '.progress-bar{position:fixed;top:0;left:0;width:100%;height:2px;z-index:9999}.progress-bar-inner{height:100%;background:linear-gradient(90deg,var(--cyan),var(--green),var(--amber));box-shadow:0 0 16px var(--green);width:0;transition:width .3s linear}'
  html += '.toast-copy{position:fixed;bottom:28px;left:50%;transform:translate(-50%,12px);background:#10211b;color:#fff;border:1px solid rgba(33,185,133,.3);box-shadow:var(--shadow);padding:11px 16px;border-radius:7px;font-size:12px;opacity:0;transition:opacity .25s,transform .25s;z-index:9998;pointer-events:none;max-width:calc(100vw - 36px);text-align:center}.toast-copy.show{opacity:1;transform:translate(-50%,0)}'
  html += '.card.flash{animation:newCode .9s cubic-bezier(.2,.8,.25,1) both;border-color:var(--amber)}@keyframes newCode{0%{opacity:0;transform:translateY(-10px);box-shadow:0 0 0 1px var(--amber),0 0 45px rgba(255,212,121,.28)}100%{opacity:1;transform:none}}'
  html += '@media(max-width:520px){body{padding:14px 12px 42px}.header{padding:20px 2px}.header p{max-width:220px}.header-actions{gap:8px}.theme-toggle{width:36px;height:36px}.card{min-height:90px;padding:17px 15px}.card:after{right:14px}.otp-number{letter-spacing:.1em}.subbar{margin-bottom:14px}}'
  html += '@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}'
  html += '</style>'
  html += '</head>'
  html += '<body>'
  html += '<div class="glow-layer"></div>'
  html += '<div class="progress-bar"><div class="progress-bar-inner" id="progressBar"></div></div>'
  html += '<div class="toast-copy" id="toastCopy">已复制到剪贴板</div>'
  html += '<div class="container">'
  html += '  <header class="header"><div class="brand"><div><h1>验证码看板</h1><p>安全接收 · 即时同步 · 点击复制</p></div></div><div class="header-actions"><div class="live-status" id="liveStatus"><span class="status-dot"></span><span id="statusText">连接中</span></div><button class="theme-toggle" type="button" data-theme-toggle onclick="toggleTheme()" aria-label="切换显示模式"></button></div></header>'
  html += '  <div class="subbar"><div class="date-badge">SESSION / ' + today + '</div><a href="/admin" class="admin-link" aria-label="打开管理控制台">管理控制台 &#8599;</a></div>'
  html += '  <div class="tabs">'
  html += '    <button class="tab active" id="tabSms" onclick="switchTab(\'sms\')">' + uiIcon('message') + '<span>短信通道</span><span class="tab-count" id="smsCount">' + smsList.length + '</span></button>'
  html += '    <button class="tab" id="tabOther" onclick="switchTab(\'other\')">' + uiIcon('bell') + '<span>其它通道</span><span class="tab-count" id="otherCount">' + otherList.length + '</span></button>'
  html += '  </div>'
  html += '  <div id="sms-list" class="card-list active">' + smsCards + '</div>'
  html += '  <div id="other-list" class="card-list">' + otherCards + '</div>'
  html += '</div>'
  html += '<script>'
  html += 'var currentTab="sms";'
  html += THEME_JS
  /* 光效跟随鼠标 */
  html += 'document.addEventListener("mousemove",function(e){var card=e.target.closest(".card");if(card){var r=card.getBoundingClientRect();card.style.setProperty("--mx",(e.clientX-r.left)+"px");card.style.setProperty("--my",(e.clientY-r.top)+"px")}});'
  html += 'function switchTab(tab){'
  html += '  document.getElementById("tabSms").classList.remove("active");'
  html += '  document.getElementById("tabOther").classList.remove("active");'
  html += '  document.getElementById("sms-list").classList.remove("active");'
  html += '  document.getElementById("other-list").classList.remove("active");'
  html += '  if(tab==="sms"){document.getElementById("tabSms").classList.add("active");document.getElementById("sms-list").classList.add("active");}'
  html += '  else{document.getElementById("tabOther").classList.add("active");document.getElementById("other-list").classList.add("active");}'
  html += '  currentTab=tab;'
  html += '}'
  html += 'function showToast(msg){'
  html += '  var t=document.getElementById("toastCopy");'
  html += '  t.textContent=msg;'
  html += '  t.classList.add("show");'
  html += '  setTimeout(function(){t.classList.remove("show")},2500);'
  html += '}'
  html += 'async function copyCode(code,el){'
  html += '  if(navigator.clipboard&&window.isSecureContext){try{await navigator.clipboard.writeText(code);el.classList.add("copied");showToast("已复制 "+code);setTimeout(function(){el.classList.remove("copied")},1500);return}catch(e){}}'
  html += '  var ta=document.createElement("textarea");'
  html += '  ta.value=code;'
  html += '  ta.style.position="fixed";'
  html += '  ta.style.left="-9999px";'
  html += '  ta.style.top="-9999px";'
  html += '  ta.style.width="1px";'
  html += '  ta.style.height="1px";'
  html += '  ta.style.opacity="0";'
  html += '  document.body.appendChild(ta);'
  html += '  ta.focus();ta.select();'
  html += '  try{'
  html += '    var ok=document.execCommand("copy");'
  html += '    if(ok){'
  html += '      el.classList.add("copied");'
  html += '      showToast("已复制: "+code);'
  html += '      setTimeout(function(){el.classList.remove("copied")},1500);'
  html += '    }else{prompt("请手动复制:",code)}'
  html += '  }catch(e){prompt("请手动复制:",code)}'
  html += '  document.body.removeChild(ta);'
  html += '}'
  html += 'document.addEventListener("click",function(e){'
  html += '  var card=e.target.closest(".card");'
  html += '  if(card&&!e.target.closest(".tab")){'
  html += '    var code=card.querySelector(".otp-number").textContent.trim();'
  html += '    copyCode(code,card);'
  html += '  }'
  html += '});'
  html += 'document.addEventListener("keydown",function(e){var card=e.target.closest&&e.target.closest(".card");if(card&&(e.key==="Enter"||e.key===" ")){e.preventDefault();copyCode(card.querySelector(".otp-number").textContent.trim(),card)}});'
  html += 'var progress=0;'
  html += 'var progressBar=document.getElementById("progressBar");'
  html += 'var lastOtpIds=[];'
  html += 'var renderedSig="";'
  /* 使用动态刷新间隔 */
  html += 'setInterval(function(){'
  html += '  progress+=100/(' + REFRESH_INTERVAL + '/100);'
  html += '  if(progress>98)progress=98;'
  html += '  progressBar.style.width=progress+"%";'
  html += '},100);'
  /* v3.1 新消息检测 + 仅变化才重绘 */
  html += 'async function refreshData(){'
  html += '  try{'
  html += '    var res=await fetch("/api/data");'
  html += '    var data=await res.json();'
  html += '    var curIds=data.sms.concat(data.other).map(i=>i.otp+"|"+i.timestamp);'
  html += '    var newIds={};'
  html += '    if(lastOtpIds.length>0){'
  html += '      curIds.forEach(function(id){'
  html += '        if(lastOtpIds.indexOf(id)===-1){'
  html += '          newIds[id]=true;'
  html += '          var otp=id.split("|")[0];'
  html += '          showToast("收到新验证码: "+otp);'
  html += '        }'
  html += '      });'
  html += '    }'
  html += '    lastOtpIds=curIds;'
  html += '    var sig=curIds.join(",");'
  html += '    if(sig!==renderedSig){'
  html += '      renderedSig=sig;'
  html += '      updateUI(data,newIds);'
  html += '    }'
  html += '  }catch(e){showToast("暂时无法同步，请检查网络");setConnection(false)}'
  html += '  progress=0;'
  html += '  progressBar.style.width="0%";'
  html += '}'
  html += 'function updateUI(data,newIds){'
  html += '  newIds=newIds||{};'
  html += '  var smsList=document.getElementById("sms-list");'
  html += '  var smsCount=document.getElementById("smsCount");'
  html += '  if(smsCount)smsCount.textContent=data.sms.length;'
  html += '  if(data.sms.length){'
  html += '    var cards="";'
  html += '    for(var i=0;i<data.sms.length;i++){cards+=renderCard(data.sms[i],"sms",newIds[data.sms[i].otp+"|"+data.sms[i].timestamp]);}'
  html += '    smsList.innerHTML=cards;'
  html += '  }else{smsList.innerHTML="<div class=\\"empty-state\\"><div class=\\"empty-icon\\"></div><div class=\\"empty-text\\">暂无短信验证码</div></div>";}'
  html += '  var otherList=document.getElementById("other-list");'
  html += '  var otherTab=document.getElementById("tabOther");'
  html += '  var otherCount=document.getElementById("otherCount");'
  html += '  if(data.other.length){'
  html += '    otherTab.style.display="block";'
  html += '    if(otherCount)otherCount.textContent=data.other.length;'
  html += '    var cards="";'
  html += '    for(var i=0;i<data.other.length;i++){cards+=renderCard(data.other[i],"other",newIds[data.other[i].otp+"|"+data.other[i].timestamp]);}'
  html += '    otherList.innerHTML=cards;'
  html += '  }else{otherTab.style.display="block";if(otherCount)otherCount.textContent="0";otherList.innerHTML="<div class=\\"empty-state\\"><div class=\\"empty-icon\\"></div><div class=\\"empty-text\\">暂无通知验证码</div></div>";}'
  html += '}'
  html += 'function normalizeOtpName(name){var text=String(name||"").trim();if(!text)return "";if(/^giffgaff$/i.test(text))return "GIFFGAFF";if(/^sms$/i.test(text))return "短信";if(/^email$/i.test(text))return "邮件";return text;}'
  html += 'function renderCard(item,type,isNew){'
  html += '  var tagClass=type==="sms"?"tag-sms":"tag-email";'
  html += '  var tagText=type==="sms"?"短信":"其它";'
  html += '  var source=item.source==="SMS"?"":normalizeOtpName(item.source.replace("Email-",""));'
  html += '  var time=item.time||"";'
  html += '  var platform=normalizeOtpName(item.platform||"");'
  html += '  var platformBadge=platform?"<span class=\\"platform-badge\\">"+platform+"</span>":"";'
  html += '  var flashCls=isNew?" flash":"";'
  html += '  return "<div class=\\"card"+flashCls+"\\" tabindex=\\"0\\" role=\\"button\\" aria-label=\\"复制验证码 "+item.otp+"\\"><div class=\\"card-left\\"><div class=\\"otp-number\\">"+item.otp+"</div><div class=\\"otp-source\\"><span class=\\"tag "+tagClass+"\\">"+tagText+"</span>"+platformBadge+(source?"<span>"+source+"</span>":"")+"<span style=\\"margin-left:auto\\">"+time+"</span></div></div></div>";'
  html += '}'
  html += 'connectRealtime();'
html += 'function connectRealtime(){'
html += '  var wsUrl=(location.protocol==="https:"?"wss://":"ws://")+location.host;'
html += '  try{'
html += '    var ws=new WebSocket(wsUrl);'
html += '    ws.onopen=function(){setConnection(true)};'
html += '    ws.onmessage=function(){setConnection(true);refreshData();};'
html += '    ws.onclose=function(){setConnection(false);setTimeout(connectRealtime,3000);fallbackPoll();};'
html += '    ws.onerror=function(){setConnection(false);fallbackPoll();};'
html += '  }catch(e){setConnection(false);fallbackPoll();}'
html += '}'
html += 'function setConnection(ok){var el=document.getElementById("liveStatus"),txt=document.getElementById("statusText");if(!el||!txt)return;el.classList.toggle("offline",!ok);txt.textContent=ok?"实时在线":"正在重连"}'
html += 'var pollTimer=null;'
html += 'function fallbackPoll(){if(pollTimer)return;pollTimer=setInterval(refreshData,' + REFRESH_INTERVAL + ');}'
  html += 'refreshData();'
  html += '</script>'
  html += '</body>'
  html += '</html>'

  res.send(html)
})

function renderCard(item, type) {
  var tagClass = type === 'sms' ? 'tag-sms' : 'tag-email'
  var tagText = type === 'sms' ? '短信' : '其它'
  var sourceDisplay = item.source === 'SMS' ? '' : normalizeDisplayName(item.source.replace('Email-',''))
  var timeStr = item.time || ''
  var platform = normalizeDisplayName(item.platform || '')
  var platformBadge = platform ? '<span class="platform-badge">' + platform + '</span>' : ''
  
  var card = '<div class="card" tabindex="0" role="button" aria-label="复制验证码 ' + item.otp + '">'
  card += '<div class="card-left">'
  card += '<div class="otp-number">' + item.otp + '</div>'
  card += '<div class="otp-source">'
  card += '<span class="tag ' + tagClass + '">' + tagText + '</span>'
  card += platformBadge
  if (sourceDisplay) {
    card += '<span style="color:#bbb">' + sourceDisplay + '</span>'
  }
  card += '<span style="color:#ccc;margin-left:auto">' + timeStr + '</span>'
  card += '</div>'
  card += '</div>'
  card += '</div>'
  
  return card
}

function normalizeDisplayName(name) {
  var text = String(name || '').trim()
  if (!text) return ''
  if (/^giffgaff$/i.test(text)) return 'GIFFGAFF'
  if (/^sms$/i.test(text)) return '短信'
  if (/^email$/i.test(text)) return '邮件'
  return text
}

/* ---------- 后台（仅卡片视图 + 合并返回/退出） ---------- */
function modernizeLoginHtml(html) {
  const trailingError = html.match(/<\/body><\/html>(<div class="error">[\s\S]*?<\/div>)$/)
  if (trailingError) html = html.replace(trailingError[0], trailingError[1] + '</body></html>')
  const style = '<style>'
    + ':root{--bg:#edf3f0;--panel:#fff;--line:rgba(19,55,44,.13);--text:#10211b;--muted:#64756f;--green:#087f58;--cyan:#087f92;--danger:#cc4650}'
    + 'html{color-scheme:light}body{font-family:Inter,"SF Pro Display","PingFang SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;letter-spacing:0!important;background:linear-gradient(145deg,#f8fbf9 0%,var(--bg) 55%,#e5f0ed 100%)!important;color:var(--text);position:relative;overflow:hidden}'
    + 'body:before{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(8,127,88,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(8,127,88,.045) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,black,transparent);pointer-events:none}'
    + 'body:after{content:"";position:fixed;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,#21b985,transparent);box-shadow:0 0 26px rgba(33,185,133,.45);animation:loginScan 7s ease-in-out infinite;pointer-events:none}@keyframes loginScan{0%,10%{top:0;opacity:0}25%{opacity:.8}85%{opacity:.15}95%,100%{top:100%;opacity:0}}'
    + '.login-card{position:relative!important;width:min(100%,410px)!important;max-width:none!important;padding:32px!important;border-radius:8px!important;background:rgba(255,255,255,.9)!important;border:1px solid var(--line)!important;box-shadow:0 32px 100px rgba(26,65,52,.16),0 0 55px rgba(33,185,133,.06)!important;backdrop-filter:blur(24px)!important;animation:loginIn .55s cubic-bezier(.2,.8,.25,1) both}@keyframes loginIn{from{opacity:0;transform:translateY(18px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}'
    + '.login-brand{display:flex;align-items:center;gap:13px;margin-bottom:28px}.login-brand>.ui-icon{width:42px;height:42px;padding:9px;border:1px solid var(--line);border-radius:9px;color:var(--green);background:color-mix(in srgb,var(--green) 7%,transparent);box-shadow:0 0 24px rgba(115,242,183,.1)}.ui-icon{display:inline-block;vertical-align:-.14em;flex:0 0 auto}.login-card h1{text-align:left!important;color:var(--text)!important;font-size:22px!important;line-height:1.15;margin:0 0 5px!important}.login-card p{text-align:left!important;color:var(--muted)!important;font-size:12px!important;margin:0!important}'
    + '.form-group{margin-bottom:15px!important}.form-group label{color:var(--muted)!important;font-size:11px!important;text-transform:uppercase;letter-spacing:.08em!important}.form-group input{height:48px;padding:0 14px!important;background:#fff!important;color:var(--text)!important;border:1px solid var(--line)!important;border-radius:6px!important;font-size:15px!important;caret-color:var(--green);transition:border-color .2s,box-shadow .2s!important}.form-group input:focus{border-color:var(--green)!important;box-shadow:0 0 0 3px rgba(8,127,88,.08),0 0 22px rgba(33,185,133,.08)!important}.form-group input::placeholder{color:#82908b}'
    + '.submit-btn{min-height:48px!important;padding:11px 16px!important;background:var(--green)!important;color:#fff!important;border-radius:6px!important;font-size:14px!important;font-weight:750!important;box-shadow:0 0 24px rgba(8,127,88,.12)!important;transition:transform .2s,box-shadow .2s,opacity .2s!important}.submit-btn:hover{transform:translateY(-1px)!important;box-shadow:0 8px 30px rgba(8,127,88,.2)!important}.submit-btn:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}.submit-btn:disabled{opacity:.55!important;transform:none!important}.bio-btn{background:#eef7f3!important;color:var(--green)!important;border:1px solid rgba(8,127,88,.2)!important;box-shadow:none!important}.divider{color:#71817b!important}.divider:before,.divider:after{background:var(--line)!important}'
    + '.bio-hint{color:var(--muted)!important;line-height:1.5;min-height:20px}.error{position:relative;color:var(--danger)!important;background:rgba(255,125,130,.08);border:1px solid rgba(255,125,130,.18);border-radius:6px;padding:10px 12px;margin-top:14px!important;text-align:left!important;font-size:12px!important}.login-foot{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);color:#60706b;font:600 10px/1.4 ui-monospace,SFMono-Regular,monospace;letter-spacing:.08em}'
    + '.theme-toggle{position:absolute;right:18px;top:18px;width:36px;height:36px;display:grid;place-items:center;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--text);font-size:17px;cursor:pointer}.theme-toggle:hover{border-color:var(--green)}.theme-toggle:focus-visible{outline:2px solid var(--green);outline-offset:2px}'
    + 'html[data-theme="dark"]{--bg:#0b1113;--panel:#121c20;--line:rgba(190,255,225,.13);--text:#f2f7f5;--muted:#91a19c;--green:#73e8b6;--cyan:#62d5e5;--danger:#ff8389;color-scheme:dark}html[data-theme="dark"] body{background:linear-gradient(145deg,#121b1e 0%,var(--bg) 58%,#0c1517 100%)!important}html[data-theme="dark"] body:before{background-image:linear-gradient(rgba(115,232,182,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(115,232,182,.035) 1px,transparent 1px)}html[data-theme="dark"] .login-card{background:rgba(18,28,32,.94)!important;box-shadow:0 32px 100px rgba(0,0,0,.45),0 0 55px rgba(115,232,182,.05)!important}html[data-theme="dark"] .form-group input{background:#0a1113!important}html[data-theme="dark"] .bio-btn{background:#142421!important}html[data-theme="dark"] .login-foot{color:#71817b}'
    + '@media(max-width:480px){body{padding:14px!important}.login-card{padding:24px 20px!important}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}'
    + '</style>'
  html = html.replace('</head>', style + THEME_BOOT + '</head>')
  html = html.replace('<div class="login-card"><h1>管理控制台</h1><p>请输入管理员密码</p>', '<div class="login-card"><button class="theme-toggle" type="button" data-theme-toggle onclick="toggleTheme()" aria-label="切换显示模式"></button><div class="login-brand"><div><h1>管理控制台</h1><p>验证管理员身份后继续</p></div></div>')
  html = html.replace('</div><script>', '<div class="login-foot">OTP CONTROL / AUTHENTICATION REQUIRED</div></div><script>')
  html = html.replace('</body>', '<script>' + THEME_JS + '</script></body>')
  return html
}

app.get('/admin', (req, res) => {
  const pw = req.query.pw
  const ip = clientIpOf(req)
  if (pw === ADMIN_PASSWORD) {
    resetLoginFails(ip)
    audit('login_success', '', req)
  } else if (!pw) {
    const err = isLocked(ip) ? 'locked' : null
    var loginHtml = '<!DOCTYPE html><html lang="zh-CN"><head><link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32"><link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#edf3f0"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="OTP 看板"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理控制台 - 登录</title>'
    loginHtml += '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.login-card{background:rgba(255,255,255,.95);backdrop-filter:blur(20px);border-radius:20px;padding:40px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.15)}.login-card h1{text-align:center;color:#333;font-size:24px;margin-bottom:8px}.login-card p{text-align:center;color:#999;font-size:14px;margin-bottom:30px}.form-group{margin-bottom:20px}.form-group label{display:block;color:#666;font-size:14px;margin-bottom:6px;font-weight:600}.form-group input{width:100%;padding:12px 16px;border:2px solid #eee;border-radius:10px;font-size:16px;outline:none;transition:border-color .3s}.form-group input:focus{border-color:#667eea}.submit-btn{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;transition:all .3s}.submit-btn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(102,126,234,.35)}.error{color:#e74c3c;text-align:center;font-size:14px;margin-top:12px}.divider{display:flex;align-items:center;color:#bbb;font-size:13px;margin:18px 0 4px}.divider:before,.divider:after{content:"";flex:1;height:1px;background:#eee}.divider span{padding:0 12px}.bio-btn{background:linear-gradient(135deg,#43cea2,#185a9d);margin-top:14px}.bio-btn:hover{box-shadow:0 6px 20px rgba(67,206,162,.4)}.bio-btn:disabled{opacity:.7;cursor:default}.bio-hint{text-align:center;font-size:13px;margin-top:10px;color:#999}</style>'
    loginHtml += '</head><body><div class="login-card"><h1>管理控制台</h1><p>请输入管理员密码</p><form method="get" action="/admin"><div class="form-group"><label>密码</label><input type="password" name="pw" placeholder="请输入密码" required></div><button type="submit" class="submit-btn">登 录</button></form>'
    loginHtml += '<div id="bioWrap" style="display:none;margin-top:20px"><div class="divider"><span>或使用</span></div><button type="button" class="submit-btn bio-btn" id="bioBtn" onclick="bioLogin()">使用面容/触控ID登录</button><div class="bio-hint" id="bioHint"></div></div>'
    loginHtml += '</div>'
    loginHtml += '<script>'
    loginHtml += 'function bufToB64url(b){var u=new Uint8Array(b),s="";for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}'
    loginHtml += 'function b64urlToBuf(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var bin=atob(s),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer}'
    loginHtml += 'function credToJson(c){var r={id:c.id,rawId:bufToB64url(c.rawId),type:c.type,response:{}};if(c.response.clientDataJSON)r.response.clientDataJSON=bufToB64url(c.response.clientDataJSON);if(c.response.attestationObject)r.response.attestationObject=bufToB64url(c.response.attestationObject);if(c.response.authenticatorData)r.response.authenticatorData=bufToB64url(c.response.authenticatorData);if(c.response.signature)r.response.signature=bufToB64url(c.response.signature);if(c.response.userHandle)r.response.userHandle=bufToB64url(c.response.userHandle);r.response.transports=c.response.transports||[];return r}'
    loginHtml += 'function prepOpt(o){o.challenge=b64urlToBuf(o.challenge);if(o.allowCredentials)o.allowCredentials.forEach(function(c){c.id=b64urlToBuf(c.id)});if(o.excludeCredentials)o.excludeCredentials.forEach(function(c){c.id=b64urlToBuf(c.id)});if(o.user&&o.user.id)o.user.id=b64urlToBuf(o.user.id);return o}'
    loginHtml += 'var loginOptions=null,loginReady=false,loginPlatformAvail=null,loginLoadErr="";'
  loginHtml += 'try{if(window.PublicKeyCredential&&typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable==="function"){window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function(b){loginPlatformAvail=b}).catch(function(){loginPlatformAvail=false})}}catch(e){loginPlatformAvail=false}'
  loginHtml += 'async function loadLoginOptions(){loginLoadErr="";try{var r=await fetch("/admin/webauthn/login/options",{method:"POST"});if(r.status!==200){var d=null;try{d=await r.json()}catch(e){}loginLoadErr="获取登录选项失败(HTTP "+r.status+")"+(d&&d.error?("："+d.error):"，请先到后台注册本设备生物识别");loginReady=false;return}loginOptions=prepOpt(await r.json());loginReady=true}catch(e){loginReady=false;loginLoadErr="获取登录选项失败："+((e&&e.message)?e.message:String(e))}}'
  loginHtml += 'async function bioLogin(){var btn=document.getElementById("bioBtn"),hint=document.getElementById("bioHint");btn.disabled=true;btn.textContent="请验证面容/触控ID...";hint.textContent="";try{if(!window.isSecureContext)throw new Error("当前不是安全上下文（需 https 或 localhost）");if(!(window.PublicKeyCredential&&navigator.credentials&&navigator.credentials.get))throw new Error("当前浏览器不支持 WebAuthn");if(loginPlatformAvail===false)throw new Error("本机未检测到可用的平台生物识别（面容/触控ID）");if(!loginReady||!loginOptions){await loadLoginOptions()}if(!loginReady||!loginOptions)throw new Error("登录选项尚未准备好"+(loginLoadErr?("："+loginLoadErr):"，请稍候重试"));hint.textContent="请在系统弹窗中验证面容/触控ID...";var cred=await navigator.credentials.get({publicKey:loginOptions});var body=credToJson(cred);var res=await fetch("/admin/webauthn/login/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});var data=await res.json();if(data.verified&&data.redirect){window.location.href=data.redirect}else{throw new Error((data&&data.error)||"验证失败")}}catch(e){btn.disabled=false;btn.textContent="使用面容/触控ID登录";hint.style.color="#e74c3c";hint.textContent="生物识别登录失败："+((e&&e.name?("["+e.name+"] "):"")+(e&&e.message?e.message:String(e)))}}'
    loginHtml += 'if(window.PublicKeyCredential&&navigator.credentials&&window.isSecureContext){document.getElementById("bioWrap").style.display="block";loadLoginOptions();fetch("/admin/webauthn/registered").then(function(r){return r.json()}).then(function(d){if(!d.registered){var h=document.getElementById("bioHint");h.style.color="#999";h.textContent="首次使用请先用密码登录，在后台“注册本设备生物识别”"}}).catch(function(){})}else{var h=document.getElementById("bioHint");h.style.color="#999";h.textContent="当前环境不支持生物识别（需 HTTPS 或 localhost 安全上下文）"}'
    loginHtml += '</script>'
    loginHtml += '</body></html>'
    if (err === 'locked') {
      var remain = Math.ceil((loginFails[ip].lockUntil - Date.now()) / 60000)
      loginHtml += '<div class="error">登录失败次数过多，已锁定，请约 ' + remain + ' 分钟后重试</div>'
    } else if (req.query.error) {
      loginHtml += '<div class="error">密码错误，请重试</div>'
    }
    return res.send(modernizeLoginHtml(loginHtml))
  } else {
    if (isLocked(ip)) {
    var loginHtml = '<!DOCTYPE html><html lang="zh-CN"><head><link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32"><link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#edf3f0"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="OTP 看板"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理控制台 - 登录</title>'
    loginHtml += '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.login-card{background:rgba(255,255,255,.95);backdrop-filter:blur(20px);border-radius:20px;padding:40px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.15)}.login-card h1{text-align:center;color:#333;font-size:24px;margin-bottom:8px}.login-card p{text-align:center;color:#999;font-size:14px;margin-bottom:30px}.form-group{margin-bottom:20px}.form-group label{display:block;color:#666;font-size:14px;margin-bottom:6px;font-weight:600}.form-group input{width:100%;padding:12px 16px;border:2px solid #eee;border-radius:10px;font-size:16px;outline:none;transition:border-color .3s}.form-group input:focus{border-color:#667eea}.submit-btn{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;transition:all .3s}.submit-btn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(102,126,234,.35)}.error{color:#e74c3c;text-align:center;font-size:14px;margin-top:12px}.divider{display:flex;align-items:center;color:#bbb;font-size:13px;margin:18px 0 4px}.divider:before,.divider:after{content:"";flex:1;height:1px;background:#eee}.divider span{padding:0 12px}.bio-btn{background:linear-gradient(135deg,#43cea2,#185a9d);margin-top:14px}.bio-btn:hover{box-shadow:0 6px 20px rgba(67,206,162,.4)}.bio-btn:disabled{opacity:.7;cursor:default}.bio-hint{text-align:center;font-size:13px;margin-top:10px;color:#999}</style>'
    loginHtml += '</head><body><div class="login-card"><h1>管理控制台</h1><p>请输入管理员密码</p><form method="get" action="/admin"><div class="form-group"><label>密码</label><input type="password" name="pw" placeholder="请输入密码" required></div><button type="submit" class="submit-btn">登 录</button></form>'
    loginHtml += '<div id="bioWrap" style="display:none;margin-top:20px"><div class="divider"><span>或使用</span></div><button type="button" class="submit-btn bio-btn" id="bioBtn" onclick="bioLogin()">使用面容/触控ID登录</button><div class="bio-hint" id="bioHint"></div></div>'
    loginHtml += '</div>'
    loginHtml += '<script>'
    loginHtml += 'function bufToB64url(b){var u=new Uint8Array(b),s="";for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}'
    loginHtml += 'function b64urlToBuf(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var bin=atob(s),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer}'
    loginHtml += 'function credToJson(c){var r={id:c.id,rawId:bufToB64url(c.rawId),type:c.type,response:{}};if(c.response.clientDataJSON)r.response.clientDataJSON=bufToB64url(c.response.clientDataJSON);if(c.response.attestationObject)r.response.attestationObject=bufToB64url(c.response.attestationObject);if(c.response.authenticatorData)r.response.authenticatorData=bufToB64url(c.response.authenticatorData);if(c.response.signature)r.response.signature=bufToB64url(c.response.signature);if(c.response.userHandle)r.response.userHandle=bufToB64url(c.response.userHandle);r.response.transports=c.response.transports||[];return r}'
    loginHtml += 'function prepOpt(o){o.challenge=b64urlToBuf(o.challenge);if(o.allowCredentials)o.allowCredentials.forEach(function(c){c.id=b64urlToBuf(c.id)});if(o.excludeCredentials)o.excludeCredentials.forEach(function(c){c.id=b64urlToBuf(c.id)});if(o.user&&o.user.id)o.user.id=b64urlToBuf(o.user.id);return o}'
    loginHtml += 'var loginOptions=null,loginReady=false,loginPlatformAvail=null,loginLoadErr="";'
  loginHtml += 'try{if(window.PublicKeyCredential&&typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable==="function"){window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function(b){loginPlatformAvail=b}).catch(function(){loginPlatformAvail=false})}}catch(e){loginPlatformAvail=false}'
  loginHtml += 'async function loadLoginOptions(){loginLoadErr="";try{var r=await fetch("/admin/webauthn/login/options",{method:"POST"});if(r.status!==200){var d=null;try{d=await r.json()}catch(e){}loginLoadErr="获取登录选项失败(HTTP "+r.status+")"+(d&&d.error?("："+d.error):"，请先到后台注册本设备生物识别");loginReady=false;return}loginOptions=prepOpt(await r.json());loginReady=true}catch(e){loginReady=false;loginLoadErr="获取登录选项失败："+((e&&e.message)?e.message:String(e))}}'
  loginHtml += 'async function bioLogin(){var btn=document.getElementById("bioBtn"),hint=document.getElementById("bioHint");btn.disabled=true;btn.textContent="请验证面容/触控ID...";hint.textContent="";try{if(!window.isSecureContext)throw new Error("当前不是安全上下文（需 https 或 localhost）");if(!(window.PublicKeyCredential&&navigator.credentials&&navigator.credentials.get))throw new Error("当前浏览器不支持 WebAuthn");if(loginPlatformAvail===false)throw new Error("本机未检测到可用的平台生物识别（面容/触控ID）");if(!loginReady||!loginOptions){await loadLoginOptions()}if(!loginReady||!loginOptions)throw new Error("登录选项尚未准备好"+(loginLoadErr?("："+loginLoadErr):"，请稍候重试"));hint.textContent="请在系统弹窗中验证面容/触控ID...";var cred=await navigator.credentials.get({publicKey:loginOptions});var body=credToJson(cred);var res=await fetch("/admin/webauthn/login/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});var data=await res.json();if(data.verified&&data.redirect){window.location.href=data.redirect}else{throw new Error((data&&data.error)||"验证失败")}}catch(e){btn.disabled=false;btn.textContent="使用面容/触控ID登录";hint.style.color="#e74c3c";hint.textContent="生物识别登录失败："+((e&&e.name?("["+e.name+"] "):"")+(e&&e.message?e.message:String(e)))}}'
    loginHtml += 'if(window.PublicKeyCredential&&navigator.credentials&&window.isSecureContext){document.getElementById("bioWrap").style.display="block";loadLoginOptions();fetch("/admin/webauthn/registered").then(function(r){return r.json()}).then(function(d){if(!d.registered){var h=document.getElementById("bioHint");h.style.color="#999";h.textContent="首次使用请先用密码登录，在后台“注册本设备生物识别”"}}).catch(function(){})}else{var h=document.getElementById("bioHint");h.style.color="#999";h.textContent="当前环境不支持生物识别（需 HTTPS 或 localhost 安全上下文）"}'
    loginHtml += '</script>'
    loginHtml += '</body></html>'
      var remain = Math.ceil((loginFails[ip].lockUntil - Date.now()) / 60000)
      loginHtml += '<div class="error">登录失败次数过多，已锁定，请约 ' + remain + ' 分钟后重试</div>'
      return res.send(modernizeLoginHtml(loginHtml))
    }
    const f = registerLoginFail(ip)
    audit('login_fail', 'count=' + f.count, req)
    var loginHtml = '<!DOCTYPE html><html lang="zh-CN"><head><link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32"><link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#edf3f0"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="OTP 看板"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理控制台 - 登录</title>'
    loginHtml += '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.login-card{background:rgba(255,255,255,.95);backdrop-filter:blur(20px);border-radius:20px;padding:40px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.15)}.login-card h1{text-align:center;color:#333;font-size:24px;margin-bottom:8px}.login-card p{text-align:center;color:#999;font-size:14px;margin-bottom:30px}.form-group{margin-bottom:20px}.form-group label{display:block;color:#666;font-size:14px;margin-bottom:6px;font-weight:600}.form-group input{width:100%;padding:12px 16px;border:2px solid #eee;border-radius:10px;font-size:16px;outline:none;transition:border-color .3s}.form-group input:focus{border-color:#667eea}.submit-btn{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;transition:all .3s}.submit-btn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(102,126,234,.35)}.error{color:#e74c3c;text-align:center;font-size:14px;margin-top:12px}.divider{display:flex;align-items:center;color:#bbb;font-size:13px;margin:18px 0 4px}.divider:before,.divider:after{content:"";flex:1;height:1px;background:#eee}.divider span{padding:0 12px}.bio-btn{background:linear-gradient(135deg,#43cea2,#185a9d);margin-top:14px}.bio-btn:hover{box-shadow:0 6px 20px rgba(67,206,162,.4)}.bio-btn:disabled{opacity:.7;cursor:default}.bio-hint{text-align:center;font-size:13px;margin-top:10px;color:#999}</style>'
    loginHtml += '</head><body><div class="login-card"><h1>管理控制台</h1><p>请输入管理员密码</p><form method="get" action="/admin"><div class="form-group"><label>密码</label><input type="password" name="pw" placeholder="请输入密码" required></div><button type="submit" class="submit-btn">登 录</button></form>'
    loginHtml += '<div id="bioWrap" style="display:none;margin-top:20px"><div class="divider"><span>或使用</span></div><button type="button" class="submit-btn bio-btn" id="bioBtn" onclick="bioLogin()">使用面容/触控ID登录</button><div class="bio-hint" id="bioHint"></div></div>'
    loginHtml += '</div>'
    loginHtml += '<script>'
    loginHtml += 'function bufToB64url(b){var u=new Uint8Array(b),s="";for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}'
    loginHtml += 'function b64urlToBuf(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var bin=atob(s),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer}'
    loginHtml += 'function credToJson(c){var r={id:c.id,rawId:bufToB64url(c.rawId),type:c.type,response:{}};if(c.response.clientDataJSON)r.response.clientDataJSON=bufToB64url(c.response.clientDataJSON);if(c.response.attestationObject)r.response.attestationObject=bufToB64url(c.response.attestationObject);if(c.response.authenticatorData)r.response.authenticatorData=bufToB64url(c.response.authenticatorData);if(c.response.signature)r.response.signature=bufToB64url(c.response.signature);if(c.response.userHandle)r.response.userHandle=bufToB64url(c.response.userHandle);r.response.transports=c.response.transports||[];return r}'
    loginHtml += 'function prepOpt(o){o.challenge=b64urlToBuf(o.challenge);if(o.allowCredentials)o.allowCredentials.forEach(function(c){c.id=b64urlToBuf(c.id)});if(o.excludeCredentials)o.excludeCredentials.forEach(function(c){c.id=b64urlToBuf(c.id)});if(o.user&&o.user.id)o.user.id=b64urlToBuf(o.user.id);return o}'
    loginHtml += 'var loginOptions=null,loginReady=false,loginPlatformAvail=null,loginLoadErr="";'
  loginHtml += 'try{if(window.PublicKeyCredential&&typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable==="function"){window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function(b){loginPlatformAvail=b}).catch(function(){loginPlatformAvail=false})}}catch(e){loginPlatformAvail=false}'
  loginHtml += 'async function loadLoginOptions(){loginLoadErr="";try{var r=await fetch("/admin/webauthn/login/options",{method:"POST"});if(r.status!==200){var d=null;try{d=await r.json()}catch(e){}loginLoadErr="获取登录选项失败(HTTP "+r.status+")"+(d&&d.error?("："+d.error):"，请先到后台注册本设备生物识别");loginReady=false;return}loginOptions=prepOpt(await r.json());loginReady=true}catch(e){loginReady=false;loginLoadErr="获取登录选项失败："+((e&&e.message)?e.message:String(e))}}'
  loginHtml += 'async function bioLogin(){var btn=document.getElementById("bioBtn"),hint=document.getElementById("bioHint");btn.disabled=true;btn.textContent="请验证面容/触控ID...";hint.textContent="";try{if(!window.isSecureContext)throw new Error("当前不是安全上下文（需 https 或 localhost）");if(!(window.PublicKeyCredential&&navigator.credentials&&navigator.credentials.get))throw new Error("当前浏览器不支持 WebAuthn");if(loginPlatformAvail===false)throw new Error("本机未检测到可用的平台生物识别（面容/触控ID）");if(!loginReady||!loginOptions){await loadLoginOptions()}if(!loginReady||!loginOptions)throw new Error("登录选项尚未准备好"+(loginLoadErr?("："+loginLoadErr):"，请稍候重试"));hint.textContent="请在系统弹窗中验证面容/触控ID...";var cred=await navigator.credentials.get({publicKey:loginOptions});var body=credToJson(cred);var res=await fetch("/admin/webauthn/login/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});var data=await res.json();if(data.verified&&data.redirect){window.location.href=data.redirect}else{throw new Error((data&&data.error)||"验证失败")}}catch(e){btn.disabled=false;btn.textContent="使用面容/触控ID登录";hint.style.color="#e74c3c";hint.textContent="生物识别登录失败："+((e&&e.name?("["+e.name+"] "):"")+(e&&e.message?e.message:String(e)))}}'
    loginHtml += 'if(window.PublicKeyCredential&&navigator.credentials&&window.isSecureContext){document.getElementById("bioWrap").style.display="block";loadLoginOptions();fetch("/admin/webauthn/registered").then(function(r){return r.json()}).then(function(d){if(!d.registered){var h=document.getElementById("bioHint");h.style.color="#999";h.textContent="首次使用请先用密码登录，在后台“注册本设备生物识别”"}}).catch(function(){})}else{var h=document.getElementById("bioHint");h.style.color="#999";h.textContent="当前环境不支持生物识别（需 HTTPS 或 localhost 安全上下文）"}'
    loginHtml += '</script>'
    loginHtml += '</body></html>'
    if (isLocked(ip)) {
      var remain = Math.ceil((loginFails[ip].lockUntil - Date.now()) / 60000)
      loginHtml += '<div class="error">登录失败次数过多，已锁定，请约 ' + remain + ' 分钟后重试</div>'
    } else {
      loginHtml += '<div class="error">密码错误，请重试</div>'
    }
    return res.send(modernizeLoginHtml(loginHtml))
  }

  const total = otpList.length
  const now = new Date()
  const todayStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0')
  const todayCount = otpList.filter(function(i) {
    var d = new Date(i.timestamp)
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') === todayStr
  }).length
  
  const smsCount = otpList.filter(isSmsItem).length
  const otherCount = otpList.filter(function(i) { return !isSmsItem(i) }).length

  function normalizeOtpName(name) {
    var text = String(name || '').trim()
    if (!text) return ''
    if (/^giffgaff$/i.test(text)) return 'GIFFGAFF'
    if (/^sms$/i.test(text)) return '短信'
    if (/^email$/i.test(text)) return '邮件'
    return text
  }
  function displaySourceName(source) {
    var text = String(source || '')
    if (!text) return ''
    text = text.replace(/^Email-/, '')
    return normalizeOtpName(text)
  }

  // 仅卡片视图，无表格
  var cardRows = ''
  for (var i = 0; i < Math.min(otpList.length, 100); i++) {
    var item = otpList[i]
    var isSms = isSmsItem(item)
    var channelLabel = isSms ? '短信' : '其它'
    var tagClass = isSms ? 'tag-sms' : 'tag-email'
    var sourceDisplay = displaySourceName(item.source)
    if (sourceDisplay === channelLabel) sourceDisplay = ''
    var platform = normalizeOtpName(item.platform || '')
    var platformDisplay = platform ? '<span class="platform-badge">' + platform + '</span>' : ''
    var sourceTag = sourceDisplay ? '<span class="source-name">' + sourceDisplay + '</span>' : ''
    cardRows += '<div class="record-card" data-id="' + i + '" data-otp="' + item.otp + '" tabindex="0" role="button" aria-label="复制验证码 ' + item.otp + '">'
      + '<div class="record-content">'
      + '<div class="otp">' + item.otp + '</div>'
      + '<div class="meta"><span class="tag ' + tagClass + '">' + channelLabel + '</span>' + platformDisplay + sourceTag + '<span class="record-time">' + item.time + '</span></div>'
      + '</div>'
      + '</div>'
  }

  var adminHtml = '<!DOCTYPE html><html lang="zh-CN"><head><link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32"><link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#edf3f0"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="OTP 看板"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理控制台 - 验证码看板</title>'
  adminHtml += '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:sans-serif;background:#f0f2f5;padding:20px}.container{max-width:1000px;margin:0 auto}.header{background:#fff;border-radius:16px;padding:24px 30px;margin-bottom:20px;box-shadow:0 2px 12px rgba(0,0,0,.06);display:flex;justify-content:space-between;align-items:center}.header h1{font-size:22px;color:#333}.header a{color:#667eea;text-decoration:none;font-size:14px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}.stat-card{background:#fff;border-radius:12px;padding:16px 20px;box-shadow:0 2px 8px rgba(0,0,0,.04)}.stat-card .num{font-size:28px;font-weight:700;color:#333}.stat-card .label{font-size:13px;color:#999;margin-top:4px}.stat-card .icon{font-size:24px;float:right}'
  // 卡片样式 + 左滑掉落删除
  adminHtml += '.record-card{position:relative;background:#fff;border-radius:14px;margin-bottom:10px;overflow:hidden;touch-action:pan-y;animation:cardSlideIn .35s cubic-bezier(0.68, -0.55, 0.265, 1.55)}'
  adminHtml += '@keyframes cardSlideIn{0%{opacity:0;transform:translateX(40px) scale(0.95)}60%{opacity:1;transform:translateX(-5px) scale(1.01)}100%{opacity:1;transform:translateX(0) scale(1)}}'
  adminHtml += '.record-content{padding:16px;transition:transform .3s cubic-bezier(.4,0,.2,1)}'
  adminHtml += '.otp{font-size:22px;font-weight:700;letter-spacing:2px}'
  adminHtml += '.plat-tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:#f3e5f5;color:#9c27b0}'
  adminHtml += '.meta{font-size:12px;color:#999;margin-top:6px}'
  adminHtml += '.toolbar{display:flex;gap:8px;margin-bottom:16px}'
  adminHtml += '.tool-btn{padding:8px 16px;border:none;border-radius:8px;font-size:13px;cursor:pointer;background:#fff;color:#333;box-shadow:0 2px 6px rgba(0,0,0,.06)}'
  adminHtml += '.tool-btn.danger{background:#ffeaea;color:#e74c3c}.tool-btn.danger:hover{background:#e74c3c;color:#fff}'
  adminHtml += '.tool-btn.success{background:#e8f5e9;color:#4caf50}.tool-btn.success:hover{background:#4caf50;color:#fff}'
  adminHtml += '.toast{position:fixed;top:20px;right:20px;background:#333;color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;opacity:0;transition:opacity .3s;z-index:999}.toast.show{opacity:1}'
  // 移动端适配：窄屏下统计卡片改两列、工具栏按钮自动换行不再挤压、缩小内边距
  adminHtml += '@media(max-width:600px){'
  adminHtml += 'body{padding:12px}'
  adminHtml += '.header{padding:18px 18px;border-radius:14px}'
  adminHtml += '.header h1{font-size:19px}'
  adminHtml += '.stats{grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px}'
  adminHtml += '.stat-card{padding:14px 16px}'
  adminHtml += '.stat-card .num{font-size:24px}'
  adminHtml += '.stat-card .icon{font-size:20px}'
  adminHtml += '.toolbar{flex-wrap:wrap;gap:8px}'
  adminHtml += '.tool-btn{flex:1 1 auto;text-align:center;padding:10px 12px;font-size:13px;white-space:nowrap;line-height:1.2}'
  adminHtml += '#bioRegBtn{flex:1 1 100%}'
  adminHtml += '.otp{font-size:20px}'
  adminHtml += '}'
  adminHtml += '@media(max-width:360px){'
  adminHtml += '.stats{grid-template-columns:repeat(2,1fr)}'
  adminHtml += '.tool-btn{flex:1 1 100%}'
  adminHtml += '}'
  /* v3.1 统一控制台设计令牌与高级状态光效 */
  adminHtml += ':root{--bg:#edf3f0;--surface:rgba(255,255,255,.86);--surface-2:#fff;--line:rgba(19,55,44,.12);--text:#10211b;--muted:#64756f;--green:#087f58;--cyan:#087f92;--amber:#a96712;--danger:#cc4650;--radius:8px;--page-shadow:0 16px 44px rgba(26,65,52,.11)}html[data-theme="dark"]{--bg:#0b1113;--surface:rgba(18,28,32,.9);--surface-2:#121c20;--line:rgba(190,255,225,.13);--text:#f2f7f5;--muted:#91a19c;--green:#73e8b6;--cyan:#62d5e5;--amber:#ffd07a;--danger:#ff8389;--page-shadow:0 16px 44px rgba(0,0,0,.3);color-scheme:dark}'
  adminHtml += 'html{color-scheme:light}body{font-family:Inter,"SF Pro Display","PingFang SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0;background:linear-gradient(145deg,#f8fbf9 0%,var(--bg) 55%,#e5f0ed 100%);color:var(--text);min-height:100vh;padding:24px 18px 56px;position:relative}body:before{content:"";position:fixed;inset:0;z-index:-1;background-image:linear-gradient(rgba(8,127,88,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(8,127,88,.045) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,black,transparent 80%)}html[data-theme="dark"] body{background:linear-gradient(145deg,#121b1e 0%,var(--bg) 58%,#0c1517 100%)}html[data-theme="dark"] body:before{background-image:linear-gradient(rgba(115,232,182,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(115,232,182,.035) 1px,transparent 1px)}'
  adminHtml += '.container{max-width:1080px}.ui-icon{width:1em;height:1em;display:inline-block;vertical-align:-.14em;flex:0 0 auto}.header{background:transparent;border-radius:0;padding:22px 2px 24px;margin-bottom:18px;border-bottom:1px solid var(--line);box-shadow:none;display:flex;justify-content:space-between;align-items:center}.header h1{font-size:26px;color:var(--text);margin-bottom:8px;display:flex;align-items:center;gap:9px}.header h1 .ui-icon{color:var(--green)}.header a{display:inline-flex;align-items:center;color:var(--muted);font-size:12px;padding:7px 0}.header a:hover{color:var(--green)}.header a:focus-visible{outline:2px solid var(--green);outline-offset:3px}.theme-toggle{width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--text);font-size:18px;cursor:pointer;box-shadow:var(--page-shadow);transition:transform .2s,border-color .2s}.theme-toggle:hover{transform:translateY(-1px);border-color:var(--green)}.theme-toggle:focus-visible{outline:2px solid var(--green);outline-offset:2px}'
  adminHtml += '.stats{gap:10px;margin-bottom:22px}.stat-card{position:relative;overflow:hidden;background:linear-gradient(145deg,var(--surface-2),var(--surface));border:1px solid var(--line);border-radius:var(--radius);padding:18px 19px;box-shadow:0 12px 32px rgba(0,0,0,.17);transition:transform .2s,border-color .2s}.stat-card:before{content:"";position:absolute;left:0;top:0;width:100%;height:1px;background:linear-gradient(90deg,transparent,var(--green),transparent);opacity:.35}.stat-card:hover{transform:translateY(-2px);border-color:rgba(115,242,183,.24)}.stat-card .num{font:750 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text)}.stat-card .label{font-size:11px;color:var(--muted);margin-top:9px}.stat-card .icon{font-size:14px;color:var(--green);filter:grayscale(1);opacity:.7}'
  adminHtml += '.toolbar{align-items:center;flex-wrap:wrap;gap:7px;margin-bottom:10px;padding:0 0 16px;border-bottom:1px solid var(--line)}.tool-btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:8px 13px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text);box-shadow:none;font-size:12px;line-height:1;text-align:center;vertical-align:middle;transition:background .2s,border-color .2s,color .2s,transform .2s}.tool-btn:hover{background:var(--surface-2);border-color:rgba(115,242,183,.25);transform:translateY(-1px)}.tool-btn:focus-visible{outline:2px solid var(--green);outline-offset:2px}.tool-btn.success{background:rgba(115,242,183,.08);color:var(--green);border-color:rgba(115,242,183,.18)}.tool-btn.success:hover{background:rgba(115,242,183,.14);color:var(--green)}.tool-btn.danger{background:rgba(255,125,130,.07);color:var(--danger);border-color:rgba(255,125,130,.16)}.tool-btn.danger:hover{background:rgba(255,125,130,.13);color:var(--danger)}.tool-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}'
  adminHtml += '#bioHint{color:var(--danger)!important;line-height:1.5;margin:0 0 10px!important}.record-card{background:linear-gradient(120deg,var(--surface-2),var(--surface));border:1px solid var(--line);border-radius:var(--radius);margin-bottom:8px;box-shadow:var(--page-shadow);animation:adminCardIn .38s cubic-bezier(.2,.75,.25,1) both;transition:border-color .2s,transform .2s,opacity .2s}.record-card:hover{border-color:color-mix(in srgb,var(--green) 34%,transparent);transform:translateY(-1px)}@keyframes adminCardIn{from{opacity:0;transform:translateY(10px);filter:blur(4px)}to{opacity:1;transform:none;filter:none}}.record-content{padding:17px 18px}.otp{font:750 24px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);letter-spacing:.12em;text-shadow:0 0 24px color-mix(in srgb,var(--green) 15%,transparent)}.meta{font-size:11px;color:var(--muted);margin-top:11px}.plat-tag{border-radius:4px;background:color-mix(in srgb,var(--green) 10%,transparent);color:var(--green)}'
  adminHtml += '.record-card{cursor:pointer;transform-origin:45% 50%}.record-card.copied{border-color:var(--green);box-shadow:0 0 0 1px color-mix(in srgb,var(--green) 24%,transparent),0 0 30px color-mix(in srgb,var(--green) 16%,transparent)}.record-card.swiping{border-color:color-mix(in srgb,var(--danger) 30%,transparent);transition:none}.record-card.deleting{pointer-events:none;z-index:5;transform:translateX(-260px) translateY(76vh) rotate(-10deg)!important;opacity:0;transition:transform .58s cubic-bezier(.22,.68,.25,1),opacity .45s}.record-card.deleting .record-content{transform:none!important}.meta{display:flex;align-items:center;flex-wrap:wrap;gap:7px}.meta .tag,.meta .platform-badge,.source-name{display:inline-flex;align-items:center;min-height:20px;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase}.meta .tag-sms{background:rgba(88,215,231,.09);color:var(--cyan)}.meta .tag-email{background:rgba(255,212,121,.09);color:var(--amber)}.meta .platform-badge{background:rgba(115,242,183,.08);color:var(--green)}.source-name{background:color-mix(in srgb,var(--text) 7%,transparent);color:var(--muted)}.record-time{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}'
  adminHtml += '.toast{top:auto;right:24px;bottom:24px;background:#10211b;color:#fff;border:1px solid rgba(33,185,133,.28);border-radius:7px;box-shadow:0 20px 60px rgba(0,0,0,.32);transform:translateY(10px);transition:opacity .25s,transform .25s}.toast.show{opacity:1;transform:none}'
  adminHtml += '@media(max-width:600px){body{padding:12px 12px 40px}.header{padding:16px 2px 20px}.header h1{font-size:22px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat-card{padding:15px}.toolbar{gap:6px}.tool-btn{flex:1 1 calc(50% - 6px);padding:9px 8px}.otp{font-size:21px}.toast{right:12px;left:12px;text-align:center}}'
  adminHtml += '@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}'
  adminHtml += '</style>'
  adminHtml += THEME_BOOT
  adminHtml += '</head><body><div class="container">'
  // 合并返回/退出：只有一个“返回看板”链接，点击即退出登录（跳转到前台）
  adminHtml += '<header class="header"><div><h1>管理控制台</h1><a href="/" onclick="return confirm(\'确定退出登录？\')">&#x2190; 退出并返回看板</a></div><button class="theme-toggle" type="button" data-theme-toggle onclick="toggleTheme()" aria-label="切换显示模式"></button></header>'
  adminHtml += '<div class="stats">'
  adminHtml += '<div class="stat-card"><span class="icon">' + uiIcon('chart') + '</span><div class="num">' + total + '</div><div class="label">总记录数</div></div>'
  adminHtml += '<div class="stat-card"><span class="icon">' + uiIcon('calendar') + '</span><div class="num">' + todayCount + '</div><div class="label">今日新增</div></div>'
  adminHtml += '<div class="stat-card"><span class="icon">' + uiIcon('message') + '</span><div class="num">' + smsCount + '</div><div class="label">短信验证码</div></div>'
  adminHtml += '<div class="stat-card"><span class="icon">' + uiIcon('bell') + '</span><div class="num">' + otherCount + '</div><div class="label">其它通道验证码</div></div>'
  adminHtml += '</div>'
  adminHtml += '<div class="toolbar">'
  adminHtml += '<button class="tool-btn success" onclick="exportData()">导出CSV</button>'
  adminHtml += '<button class="tool-btn danger" onclick="clearAll()">清空全部</button>'
  adminHtml += '<button class="tool-btn" onclick="location.reload()">刷新</button>'
  adminHtml += '<a class="tool-btn" href="/admin/notify?pw=' + ADMIN_PASSWORD + '" style="text-decoration:none">通知设置</a>'
  adminHtml += '<button class="tool-btn" id="bioRegBtn" onclick="registerBio()" title="将当前设备绑定为生物识别（面容/触控ID）登录凭据">注册本设备生物识别</button>'
  adminHtml += '</div>'
  adminHtml += '<div id="bioHint" style="margin-top:10px;font-size:13px;min-height:18px;color:#e74c3c"></div>'
  // 卡片列表（无表格）
  adminHtml += '<div id="cardView">' + (cardRows || '<div style="text-align:center;padding:40px;color:#ccc">暂无记录</div>') + '</div>'
  adminHtml += '<div style="text-align:center;color:#ccc;font-size:13px;margin-top:12px">仅显示最近100条记录</div>'
  adminHtml += '</div>'
  adminHtml += '<div id="toast" class="toast"></div>'
  adminHtml += '<script>'
  adminHtml += THEME_JS
  adminHtml += 'function showToast(msg){var t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(function(){t.classList.remove("show")},2000)}'
  // 点按复制 + 左滑掉落删除
  adminHtml += 'var startX=0,startY=0,dragging=false,suppressClick=false,swipeCard=null;'
  adminHtml += 'document.querySelectorAll(".record-card").forEach(function(card){'
  adminHtml += '  card.addEventListener("click",function(e){if(dragging||suppressClick)return;copyAdmin(card.dataset.otp,card)});'
  adminHtml += '  card.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();copyAdmin(card.dataset.otp,card)}});'
  adminHtml += '  card.addEventListener("pointerdown",function(e){startX=e.clientX;startY=e.clientY;dragging=false;swipeCard=card;card.setPointerCapture&&card.setPointerCapture(e.pointerId)});'
  adminHtml += '  card.addEventListener("pointermove",function(e){if(swipeCard!==card)return;var dx=e.clientX-startX,dy=e.clientY-startY;if(Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)){dragging=true;if(dx<0){card.classList.add("swiping");card.style.transform="translateX("+Math.max(dx,-140)+"px) rotate("+Math.max(dx/18,-7)+"deg)"}}});'
  adminHtml += '  card.addEventListener("pointerup",function(e){if(swipeCard!==card)return;var dx=e.clientX-startX;card.classList.remove("swiping");card.style.transform="";swipeCard=null;if(dx<-96){deleteOne(card.dataset.id,card,true);return}if(Math.abs(dx)>8){suppressClick=true;setTimeout(function(){dragging=false;suppressClick=false},250)}});'
  adminHtml += '  card.addEventListener("pointercancel",function(){if(swipeCard===card){swipeCard=null;dragging=false;card.classList.remove("swiping");card.style.transform=""}});'
  adminHtml += '});'
  adminHtml += 'async function deleteOne(idx,card,fromSwipe){if(!fromSwipe&&!confirm("确定删除？"))return;if(card){card.classList.add("deleting")}try{if(fromSwipe)showToast("正在删除");var r=await fetch("/admin/delete/"+idx+"?pw=' + ADMIN_PASSWORD + '",{method:"DELETE"});if(r.ok){showToast("已删除");setTimeout(function(){location.reload()},fromSwipe?420:0)}else{throw new Error("delete failed")}}catch(e){if(card)card.classList.remove("deleting");alert("删除失败")}}'
  adminHtml += 'async function copyAdmin(code,card){if(!code)return;var done=false;if(navigator.clipboard&&window.isSecureContext){try{await navigator.clipboard.writeText(code);done=true}catch(e){}}if(!done){var ta=document.createElement("textarea");ta.value=code;ta.style.position="fixed";ta.style.left="-9999px";document.body.appendChild(ta);ta.select();try{document.execCommand("copy");done=true}catch(e){prompt("请手动复制:",code)}document.body.removeChild(ta)}if(done){if(card){card.classList.add("copied");setTimeout(function(){card.classList.remove("copied")},900)}showToast("已复制: "+code)}}'
  adminHtml += 'async function clearAll(){if(!confirm("确定清空全部？"))return;try{var r=await fetch("/admin/clear?pw=' + ADMIN_PASSWORD + '",{method:"POST"});if(r.ok){showToast("已清空");location.reload()}}catch(e){alert("清空失败")}}'
  adminHtml += 'async function exportData(){window.open("/admin/export?pw=' + ADMIN_PASSWORD + '")}'
  adminHtml += 'function bufToB64url(b){var u=new Uint8Array(b),s="";for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}'
  adminHtml += 'function b64urlToBuf(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var bin=atob(s),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer}'
  adminHtml += 'function credToJson(c){var r={id:c.id,rawId:bufToB64url(c.rawId),type:c.type,response:{}};if(c.response.clientDataJSON)r.response.clientDataJSON=bufToB64url(c.response.clientDataJSON);if(c.response.attestationObject)r.response.attestationObject=bufToB64url(c.response.attestationObject);if(c.response.authenticatorData)r.response.authenticatorData=bufToB64url(c.response.authenticatorData);if(c.response.signature)r.response.signature=bufToB64url(c.response.signature);if(c.response.userHandle)r.response.userHandle=bufToB64url(c.response.userHandle);r.response.transports=c.response.transports||[];return r}'
  adminHtml += 'function prepOpt(o){o.challenge=b64urlToBuf(o.challenge);if(o.allowCredentials)o.allowCredentials.forEach(function(c){c.id=b64urlToBuf(c.id)});if(o.excludeCredentials)o.excludeCredentials.forEach(function(c){c.id=b64urlToBuf(c.id)});if(o.user&&o.user.id)o.user.id=b64urlToBuf(o.user.id);return o}'
  adminHtml += 'var regOptions=null,regReady=false,platformAvail=null,loadErr="";'
  adminHtml += 'try{if(window.PublicKeyCredential&&typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable==="function"){window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function(b){platformAvail=b}).catch(function(){platformAvail=false})}}catch(e){platformAvail=false}'
  adminHtml += 'async function loadRegOptions(){loadErr="";try{var r=await fetch("/admin/webauthn/register/options?pw=' + ADMIN_PASSWORD + '",{method:"POST"});if(!r.ok){var d=null;try{d=await r.json()}catch(e){}loadErr="获取注册选项失败(HTTP "+r.status+")"+(d&&d.error?("："+d.error):"，请确认已用正确密码登录后台");regReady=false;return}regOptions=prepOpt(await r.json());regReady=true}catch(e){regReady=false;loadErr="获取注册选项失败："+((e&&e.message)?e.message:String(e))}}'
  adminHtml += 'loadRegOptions().then(function(){if(!regReady&&loadErr){var h=document.getElementById("bioHint");if(h){h.style.color="#e74c3c";h.textContent=loadErr}}});'
  adminHtml += 'async function registerBio(){var btn=document.getElementById("bioRegBtn");var hint=document.getElementById("bioHint");btn.disabled=true;var old=btn.textContent;btn.textContent="请验证面容/触控ID...";if(hint){hint.style.color="";hint.textContent=""};try{if(!window.isSecureContext)throw new Error("当前不是安全上下文（需 https 或 localhost），无法使用生物识别");if(!(window.PublicKeyCredential&&navigator.credentials&&navigator.credentials.create))throw new Error("当前浏览器不支持 WebAuthn");if(platformAvail===false)throw new Error("本机未检测到可用的平台生物识别（面容/触控ID），请先到系统设置中启用，并确保浏览器允许");if(!regReady||!regOptions){await loadRegOptions()}if(!regReady||!regOptions)throw new Error("注册选项尚未准备好"+(loadErr?("："+loadErr):"，请稍候重试"));if(hint)hint.textContent="请在系统弹窗中验证面容/触控ID...";var cred=await navigator.credentials.create({publicKey:regOptions});var body=credToJson(cred);var res=await fetch("/admin/webauthn/register/verify?pw=' + ADMIN_PASSWORD + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});var data=await res.json();if(data.verified){if(hint){hint.style.color="#27ae60";hint.textContent="生物识别已注册，下次可用面容/触控ID登录"}showToast("生物识别已注册")}else{throw new Error((data&&data.error)||"注册失败")}}catch(e){if(hint){hint.style.color="#e74c3c";hint.textContent="注册失败："+((e&&e.name?("["+e.name+"] "):"")+(e&&e.message?e.message:String(e)))}}finally{btn.disabled=false;btn.textContent=old;loadRegOptions()}}'

  adminHtml += '</script>'
  adminHtml += '</body></html>'

  res.send(adminHtml)
})

/* ---------- WebAuthn 生物识别（面容/触控ID） ---------- */
// 统一错误出口：任何异常都必须回应 JSON，绝不能让请求挂起。
// 之前 register/options、login/options 没有 try/catch，generateRegistrationOptions()
// 一旦抛错，Express 4 不会自动捕获 async 异常 → 响应一直不返回 → 反代（宝塔/Cloudflare）超时 → 504。
function webauthnError(res, status, msg) {
  console.error('[webauthn] ' + msg)
  audit('webauthn_error', msg, null)
  return res.status(status).json({ verified: false, error: msg })
}

app.get('/admin/webauthn/registered', (_req, res) => {
  res.json({ registered: webauthnCreds.length > 0 })
})

// 诊断接口：返回当前推导出的 rpID / origin 与依赖状态。浏览器直接访问即可，便于排查 504 / 验证失败。
app.get('/admin/webauthn/debug', (req, res) => {
  const cfg = webauthnConfig(req)
  res.json({
    ok: true,
    rpID: cfg.rpID,
    expectedOrigin: cfg.expectedOrigin,
    host_header: req.headers.host || '',
    x_forwarded_host: req.headers['x-forwarded-host'] || '',
    x_forwarded_proto: req.headers['x-forwarded-proto'] || '',
    secure: !!req.secure,
    creds: webauthnCreds.length,
    hasGenerator: typeof generateRegistrationOptions === 'function',
    cryptoAvailable: !!(globalThis.crypto && globalThis.crypto.subtle)
  })
})

app.post('/admin/webauthn/register/options', async (req, res) => {
  try {
    if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'forbidden' })
    const cfg = webauthnConfig(req)
    console.log('[webauthn] register/options rpID=' + cfg.rpID + ' origin=' + cfg.expectedOrigin)
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: cfg.rpID,
      userName: 'admin',
      userID: ADMIN_USER_ID,
      userDisplayName: '管理员',
      attestationType: 'none',
      excludeCredentials: webauthnCreds.map(c => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' }
    })
    // 把挑战与当时推导出的 rpID / origin 一起存下，verify 时按挑战值反查，保证两端一致
    putChallenge(options.challenge, { rpID: cfg.rpID, expectedOrigin: cfg.expectedOrigin })
    res.json(options)
  } catch (e) {
    return webauthnError(res, 400, '生成注册选项失败：' + (e && e.message ? e.message : String(e)))
  }
})

app.post('/admin/webauthn/register/verify', async (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'forbidden' })
  try {
    const ch = challengeFromBody(req.body)
    const meta = ch ? takeChallenge(ch) : null
    if (!meta) {
      return webauthnError(res, 400, '注册挑战已过期或不存在，请重新点击“注册本设备生物识别”')
    }
    console.log('[webauthn] register/verify rpID=' + meta.rpID + ' origin=' + meta.expectedOrigin)
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: ch,
      expectedOrigin: meta.expectedOrigin,
      expectedRPID: meta.rpID,
      requireUserVerification: false
    })
    if (verification.verified && verification.registrationInfo) {
      const ci = verification.registrationInfo.credential
      const newCred = {
        id: ci.id,
        publicKey: toBase64url(ci.publicKey),
        counter: ci.counter,
        transports: ci.transports || []
      }
      webauthnCreds = webauthnCreds.filter(c => c.id !== newCred.id)
      webauthnCreds.push(newCred)
      saveCreds()
      res.json({ verified: true })
    } else {
      return webauthnError(res, 400, '验证未通过')
    }
  } catch (e) {
    return webauthnError(res, 400, '注册验证失败：' + (e && e.message ? e.message : String(e)))
  }
})

app.post('/admin/webauthn/login/options', async (req, res) => {
  try {
    if (webauthnCreds.length === 0) return res.status(400).json({ error: 'no-credential' })
    const cfg = webauthnConfig(req)
    console.log('[webauthn] login/options rpID=' + cfg.rpID + ' origin=' + cfg.expectedOrigin)
    const options = await generateAuthenticationOptions({
      rpID: cfg.rpID,
      allowCredentials: webauthnCreds.map(c => ({ id: c.id, transports: c.transports })),
      userVerification: 'preferred'
    })
    putChallenge(options.challenge, { rpID: cfg.rpID, expectedOrigin: cfg.expectedOrigin })
    res.json(options)
  } catch (e) {
    return webauthnError(res, 400, '生成登录选项失败：' + (e && e.message ? e.message : String(e)))
  }
})

app.post('/admin/webauthn/login/verify', async (req, res) => {
  try {
    const cred = webauthnCreds.find(c => c.id === req.body.id)
    if (!cred) return res.status(400).json({ verified: false, error: 'unknown-credential' })
    const ch = challengeFromBody(req.body)
    const meta = ch ? takeChallenge(ch) : null
    if (!meta) {
      return webauthnError(res, 400, '登录挑战已过期或不存在，请重新点击“使用面容/触控ID登录”')
    }
    console.log('[webauthn] login/verify rpID=' + meta.rpID + ' origin=' + meta.expectedOrigin)
    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: ch,
      expectedOrigin: meta.expectedOrigin,
      expectedRPID: meta.rpID,
      credential: {
        id: cred.id,
        publicKey: fromBase64url(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports
      },
      // 与注册策略保持一致（preferred）：面容/触控ID自然会做用户验证，
      // 未设生物识别的设备也不会被硬性拒绝，兼容性最好。
      requireUserVerification: false
    })
    if (verification.verified) {
      cred.counter = verification.authenticationInfo.newCounter
      saveCreds()
      // 生物识别通过后，沿用原有 query 密码方式进入后台，其它逻辑完全不变
      res.json({ verified: true, redirect: '/admin?pw=' + encodeURIComponent(ADMIN_PASSWORD) })
    } else {
      return webauthnError(res, 400, '登录验证未通过')
    }
  } catch (e) {
    return webauthnError(res, 400, '登录验证失败：' + (e && e.message ? e.message : String(e)))
  }
})

// v3.1 删除/清空/导出/自动清理
app.delete('/admin/delete/:idx', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send('forbidden')
  const idx = parseInt(req.params.idx)
  if (idx >= 0 && idx < otpList.length) {
    otpList.splice(idx, 1)
    try { saveOtp() } catch (e) {}
    try { broadcastUpdate() } catch (e) {}
    res.send('ok')
  } else {
    res.status(404).send('not found')
  }
})

app.post('/admin/clear', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send('forbidden')
  otpList = []
  audit('clear_all', '', req)
  try { saveOtp() } catch (e) {}
  try { broadcastUpdate() } catch (e) {}
  res.send('ok')
})

app.get('/admin/export', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send('forbidden')
  audit('export_csv', '', req)
  var csv = '序号,验证码,来源,平台,时间\n'
  for (var i = 0; i < otpList.length; i++) {
    csv += (i+1) + ',' + otpList[i].otp + ',' + otpList[i].source + ',' + (otpList[i].platform || '') + ',' + otpList[i].time + '\n'
  }
  res.setHeader('Content-Type', 'text/csv;charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment;filename=otp_history.csv')
  res.send('\ufeff' + csv)
})

// ---------- v3.1 外部通知设置 ----------
function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function renderNotifyPage(saved, msg) {
  const c = notifyCfg
  const t = c.telegram, w = c.wecom, f = c.feishu, b = c.bark, h = c.webhook, em = c.email || {}
  let html = '<!DOCTYPE html><html lang="zh-CN"><head><link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32"><link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#edf3f0"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="OTP 看板"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>通知设置 - 管理控制台</title>'
  html += '<style>:root{--bg:#edf3f0;--surface:rgba(255,255,255,.86);--surface-2:#fff;--line:rgba(19,55,44,.12);--text:#10211b;--muted:#64756f;--green:#087f58;--cyan:#087f92;--danger:#cc4650;--page-shadow:0 16px 44px rgba(26,65,52,.11)}html[data-theme="dark"]{--bg:#0b1113;--surface:rgba(18,28,32,.9);--surface-2:#121c20;--line:rgba(190,255,225,.13);--text:#f2f7f5;--muted:#91a19c;--green:#73e8b6;--cyan:#62d5e5;--danger:#ff8389;--page-shadow:0 16px 44px rgba(0,0,0,.3);color-scheme:dark}*{margin:0;padding:0;box-sizing:border-box}html{color-scheme:light}body{font-family:Inter,"SF Pro Display","PingFang SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0;background:linear-gradient(145deg,#f8fbf9 0%,var(--bg) 55%,#e5f0ed 100%);min-height:100vh;padding:24px 18px 56px;color:var(--text);position:relative}body:before{content:"";position:fixed;inset:0;z-index:-1;background-image:linear-gradient(rgba(8,127,88,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(8,127,88,.045) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,black,transparent 85%)}html[data-theme="dark"] body{background:linear-gradient(145deg,#121b1e 0%,var(--bg) 58%,#0c1517 100%)}html[data-theme="dark"] body:before{background-image:linear-gradient(rgba(115,232,182,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(115,232,182,.035) 1px,transparent 1px)}a{color:var(--muted)}a:hover{color:var(--green)}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--green);outline-offset:2px}.wrap{max-width:720px;margin:0 auto}.topbar{display:flex;justify-content:space-between;align-items:center;padding:24px 2px;margin-bottom:18px;border-bottom:1px solid var(--line)}.topbar h1{font-size:26px}.top-actions{display:flex;align-items:center;gap:10px}.topbar a{font-size:12px;text-decoration:none}.theme-toggle{width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--text);padding:0;min-height:0;font-size:18px;box-shadow:var(--page-shadow)}.card{background:linear-gradient(145deg,var(--surface-2),var(--surface));border:1px solid var(--line);box-shadow:var(--page-shadow);border-radius:8px;padding:19px 20px;margin-bottom:10px}.card h2{font-size:15px;margin-bottom:15px;display:flex;align-items:center;gap:8px}.field{margin-bottom:12px}.field label{display:block;font-size:11px;color:var(--muted);margin-bottom:6px}.field input{width:100%;min-height:43px;padding:9px 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:14px;caret-color:var(--green);transition:border-color .2s,box-shadow .2s}.field input:focus{outline:none;border-color:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 10%,transparent)}.field input::placeholder{color:var(--muted);opacity:.7}.row{display:flex;gap:10px}.row .field{flex:1;min-width:0}button{cursor:pointer;border:1px solid var(--line);border-radius:6px;padding:10px 17px;min-height:42px;font-size:13px;font-weight:700;transition:transform .2s,background .2s}button:hover{transform:translateY(-1px)}.btn-save{background:#087f58;border-color:#087f58;color:#fff}.btn-test{background:var(--surface-2);color:var(--text)}.form-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.form-actions button{width:100%;height:44px;min-height:44px;padding:0 16px}.switch{display:inline-flex;align-items:center;gap:10px;cursor:pointer}.switch input{width:18px;height:18px;accent-color:#087f58}.hint{font-size:11px;color:var(--muted);margin-top:6px;line-height:1.6}.saved{background:color-mix(in srgb,var(--green) 9%,transparent);border:1px solid color-mix(in srgb,var(--green) 20%,transparent);color:var(--green);padding:10px 13px;border-radius:6px;font-size:12px;margin-bottom:10px}@media(max-width:560px){body{padding:12px 12px 40px}.topbar{padding:16px 2px}.topbar h1{font-size:22px}.top-actions{gap:6px}.card{padding:16px}.row{display:block}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;transition-duration:.01ms!important}}</style>'
  html = html.replace('.card h2{font-size:15px;margin-bottom:15px;display:flex;align-items:center;gap:8px}', '.card h2{font-size:15px;margin-bottom:15px;display:flex;align-items:center;justify-content:space-between;gap:12px}.ui-icon{width:20px;height:20px;display:inline-block;vertical-align:-.14em;flex:0 0 auto}.topbar h1{display:flex;align-items:center;gap:9px}.topbar h1 .ui-icon{width:24px;height:24px;color:var(--green)}.channel-title{display:flex;align-items:center;gap:8px;min-width:0}.channel-title .ui-icon{color:var(--green)}.channel-test{flex:0 0 auto;width:36px;height:36px;min-height:36px;padding:0;display:grid;place-items:center;border-radius:50%;background:color-mix(in srgb,var(--green) 7%,var(--surface-2));border-color:color-mix(in srgb,var(--green) 18%,var(--line));color:var(--green);font-size:14px;box-shadow:0 4px 14px rgba(26,65,52,.07)}.channel-test .ui-icon{width:16px;height:16px}.channel-test:hover{background:color-mix(in srgb,var(--green) 13%,var(--surface-2));border-color:color-mix(in srgb,var(--green) 38%,var(--line))}.channel-test:disabled{cursor:wait;opacity:.7}.channel-test.testing{animation:spin .8s linear infinite}.test-status{display:block;margin:-3px 0 14px;padding:9px 11px;border-radius:6px;font-size:11px;font-weight:650;line-height:1.55;overflow-wrap:anywhere}.test-status:empty{display:none}.test-status.ok{color:var(--green);background:color-mix(in srgb,var(--green) 8%,transparent);border:1px solid color-mix(in srgb,var(--green) 20%,transparent)}.test-status.fail{color:var(--danger);background:color-mix(in srgb,var(--danger) 7%,transparent);border:1px solid color-mix(in srgb,var(--danger) 20%,transparent)}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:560px){.channel-test{width:44px;height:44px;min-height:44px}.form-actions{position:sticky;bottom:max(10px,env(safe-area-inset-bottom));z-index:20;padding:8px;background:color-mix(in srgb,var(--surface-2) 88%,transparent);border:1px solid var(--line);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.18);backdrop-filter:blur(16px)}.form-actions.form-actions button{height:48px;min-height:48px;padding:0 10px}.test-status{font-size:12px}}')
  html += THEME_BOOT
  html += '</head><body><div class="wrap">'
  html += '<div class="topbar"><h1>通知设置</h1><div class="top-actions"><a href="/admin?pw=' + encodeURIComponent(ADMIN_PASSWORD) + '">&#x2190; 返回管理控制台</a><button class="theme-toggle" type="button" data-theme-toggle onclick="toggleTheme()" aria-label="切换显示模式"></button></div></div>'
  if (saved) html += '<div class="saved">设置已保存</div>'
  if (msg) html += '<div class="saved">' + escAttr(msg) + '</div>'
  html += '<form method="post" action="/admin/notify?pw=' + encodeURIComponent(ADMIN_PASSWORD) + '">'
  html += '<label class="switch card"><input type="checkbox" name="enabled" ' + (c.enabled ? 'checked' : '') + '> <span>启用外部通知（收到新验证码时推送）</span></label>'
  html += '<div class="card"><h2><span class="channel-title">' + uiIcon('send') + ' Telegram</span><button type="button" class="channel-test" onclick="testChannel(\'telegram\',this)" title="测试 Telegram" aria-label="测试 Telegram">' + uiIcon('send') + '</button></h2><div class="test-status" data-status="telegram" role="status" aria-live="polite"></div>'
  html += '<div class="field"><label>Bot Token</label><input name="telegram.botToken" value="' + escAttr(t.botToken) + '" placeholder="123456:ABC-DEF..."></div>'
  html += '<div class="field"><label>接收方 Chat ID（不是 Bot 名字）</label><input name="telegram.chatId" value="' + escAttr(t.chatId) + '" placeholder="私聊数字 ID / 群组负数 ID / 频道 @username"></div>'
  html += '<div class="hint">私聊请先向机器人发送 /start，再通过 getUpdates 获取 message.chat.id；机器人自己的 @用户名不能作为接收方。</div></div>'
  html += '<div class="card"><h2><span class="channel-title">' + uiIcon('users') + ' 企业微信群机器人</span><button type="button" class="channel-test" onclick="testChannel(\'wecom\',this)" title="测试企业微信" aria-label="测试企业微信">' + uiIcon('send') + '</button></h2><div class="test-status" data-status="wecom" role="status" aria-live="polite"></div>'
  html += '<div class="field"><label>Webhook Key</label><input name="wecom.key" value="' + escAttr(w.key) + '" placeholder="693a-xxxx-xxxx"></div></div>'
  html += '<div class="card"><h2><span class="channel-title">' + uiIcon('spark') + ' 飞书机器人</span><button type="button" class="channel-test" onclick="testChannel(\'feishu\',this)" title="测试飞书" aria-label="测试飞书">' + uiIcon('send') + '</button></h2><div class="test-status" data-status="feishu" role="status" aria-live="polite"></div>'
  html += '<div class="field"><label>Webhook Key</label><input name="feishu.key" value="' + escAttr(f.key) + '" placeholder="xxxx-xxxx-xxxx"></div></div>'
  html += '<div class="card"><h2><span class="channel-title">' + uiIcon('phone') + ' Bark（iOS 推送）</span><button type="button" class="channel-test" onclick="testChannel(\'bark\',this)" title="测试 Bark" aria-label="测试 Bark">' + uiIcon('send') + '</button></h2><div class="test-status" data-status="bark" role="status" aria-live="polite"></div>'
  html += '<div class="row"><div class="field"><label>Device Key</label><input name="bark.key" value="' + escAttr(b.key) + '" placeholder="xxxxxxxxxxxx"></div>'
  html += '<div class="field"><label>服务器（可选）</label><input name="bark.server" value="' + escAttr(b.server) + '" placeholder="https://api.day.app"></div></div></div>'
  html += '<div class="card"><h2><span class="channel-title">' + uiIcon('link') + ' 自定义 Webhook</span><button type="button" class="channel-test" onclick="testChannel(\'webhook\',this)" title="测试 Webhook" aria-label="测试 Webhook">' + uiIcon('send') + '</button></h2><div class="test-status" data-status="webhook" role="status" aria-live="polite"></div>'
  html += '<div class="field"><label>URL</label><input name="webhook.url" value="' + escAttr(h.url) + '" placeholder="https://example.com/hook"></div>'
  html += '<div class="field"><label>密钥（可选，作为 x-notify-secret 头）</label><input name="webhook.secret" value="' + escAttr(h.secret) + '" placeholder="可选"></div>'
  html += '<div class="hint">可对接邮件网关、Server 酱、推送加等。请求体为 JSON：{title,text,otp,source,time,platform}</div></div>'
  html += '<div class="card"><h2><span class="channel-title">' + uiIcon('mail') + ' 邮件直发（SMTP）</span><button type="button" class="channel-test" onclick="testChannel(\'email\',this)" title="测试邮件" aria-label="测试邮件">' + uiIcon('send') + '</button></h2><div class="test-status" data-status="email" role="status" aria-live="polite"></div>'
  html += '<div class="row"><div class="field"><label>SMTP 服务器</label><input name="email.host" value="' + escAttr(em.host) + '" placeholder="smtp.qq.com"></div>'
  html += '<div class="field"><label>端口</label><input name="email.port" value="' + escAttr(em.port) + '" placeholder="465"></div></div>'
  html += '<label class="switch" style="margin:4px 0 10px"><input type="checkbox" name="email.secure" ' + (em.secure !== false ? 'checked' : '') + '> <span>使用 SSL/TLS（465 端口；587 请取消勾选）</span></label>'
  html += '<div class="row"><div class="field"><label>账号</label><input name="email.user" value="' + escAttr(em.user) + '" placeholder="你的邮箱"></div>'
  html += '<div class="field"><label>密码 / 授权码</label><input type="password" name="email.pass" value="' + escAttr(em.pass) + '" placeholder="邮箱授权码"></div></div>'
  html += '<div class="row"><div class="field"><label>发件人（可选）</label><input name="email.from" value="' + escAttr(em.from) + '" placeholder="默认用账号"></div>'
  html += '<div class="field"><label>收件人（逗号分隔）</label><input name="email.to" value="' + escAttr(em.to) + '" placeholder="me@example.com"></div></div>'
  html += '<div class="hint">需要 SMTP 服务（如 QQ / 163 / Gmail）。密码通常为邮箱「授权码」而非登录密码。</div></div>'
  html += '<div class="form-actions">'
  html += '<button type="submit" class="btn-save">保存设置</button>'
  html += '<button type="button" class="btn-test" onclick="testNotify()">测试所有已配置通道</button>'
  html += '</div></form>'
  html += '</div>'
  html += '<script>' + THEME_JS + 'function runTests(channel){var f=document.querySelector("form");var p=new URLSearchParams(new FormData(f));if(channel)p.set("channel",channel);return fetch("/admin/notify/test?pw=' + encodeURIComponent(ADMIN_PASSWORD) + '",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:p.toString()}).then(function(r){return r.json()})}function paintResult(x){var s=document.querySelector("[data-status="+x.id+"]");if(!s)return;s.className="test-status "+(x.ok?"ok":"fail");s.textContent=x.ok?"测试成功":x.error}function testChannel(channel,btn){btn.disabled=true;btn.classList.add("testing");var s=document.querySelector("[data-status="+channel+"]");s.className="test-status";s.textContent="测试中";runTests(channel).then(function(d){(d.results||[]).forEach(paintResult)}).catch(function(e){paintResult({id:channel,ok:false,error:e.message})}).finally(function(){btn.disabled=false;btn.classList.remove("testing")})}function testNotify(){runTests("").then(function(d){if(!d.results||!d.results.length){alert("请至少填写一个通道配置");return}(d.results||[]).forEach(paintResult)}).catch(function(e){alert("请求失败："+e.message)})}</script>'
  html += '</body></html>'
  return html
}
app.get('/admin/notify', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send('forbidden')
  res.send(renderNotifyPage(req.query.saved === '1', req.query.msg))
})
app.post('/admin/notify', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send('forbidden')
  const b = req.body
  notifyCfg = {
    enabled: b.enabled === 'on',
    telegram: { botToken: b['telegram.botToken'] || '', chatId: b['telegram.chatId'] || '' },
    wecom: { key: b['wecom.key'] || '' },
    feishu: { key: b['feishu.key'] || '' },
    bark: { key: b['bark.key'] || '', server: b['bark.server'] || 'https://api.day.app' },
    webhook: { url: b['webhook.url'] || '', secret: b['webhook.secret'] || '' },
    email: {
      host: b['email.host'] || '',
      port: b['email.port'] || 465,
      secure: b['email.secure'] === 'on',
      user: b['email.user'] || '',
      pass: b['email.pass'] || '',
      from: b['email.from'] || '',
      to: b['email.to'] || ''
    }
  }
  emailTransporter = null // 配置变更，下次发送重建 transporter
  saveNotify()
  res.redirect('/admin/notify?pw=' + encodeURIComponent(ADMIN_PASSWORD) + '&saved=1')
})
app.post('/admin/notify/test', async (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: 'forbidden' })
  const testNow = new Date()
  const pad2 = n => String(n).padStart(2, '0')
  const testTime24 = testNow.getFullYear() + '-' + pad2(testNow.getMonth() + 1) + '-' + pad2(testNow.getDate())
    + ' ' + pad2(testNow.getHours()) + ':' + pad2(testNow.getMinutes()) + ':' + pad2(testNow.getSeconds())
  const testText = '通知测试\n验证码：123456\n时间：' + testTime24
  const tg = {
    botToken: req.body['telegram.botToken'] || (notifyCfg.telegram && notifyCfg.telegram.botToken) || '',
    chatId: req.body['telegram.chatId'] || (notifyCfg.telegram && notifyCfg.telegram.chatId) || ''
  }
  const feishu = { key: req.body['feishu.key'] || (notifyCfg.feishu && notifyCfg.feishu.key) || '' }
  const wecom = { key: req.body['wecom.key'] || (notifyCfg.wecom && notifyCfg.wecom.key) || '' }
  const bark = { key: req.body['bark.key'] || '', server: req.body['bark.server'] || 'https://api.day.app' }
  const webhook = { url: req.body['webhook.url'] || '', secret: req.body['webhook.secret'] || '' }
  const email = { host: req.body['email.host'] || '', port: req.body['email.port'] || 465, secure: req.body['email.secure'] === 'on', user: req.body['email.user'] || '', pass: req.body['email.pass'] || '', from: req.body['email.from'] || '', to: req.body['email.to'] || '' }
  const selected = String(req.body.channel || '')
  const allTests = [
    { id: 'telegram', channel: 'Telegram', configured: tg.botToken || tg.chatId, run: () => sendTelegram(tg, testText) },
    { id: 'wecom', channel: '企业微信', configured: wecom.key, run: () => testWecom(wecom, testText) },
    { id: 'feishu', channel: '飞书', configured: feishu.key, run: () => sendFeishu(feishu, testText) },
    { id: 'bark', channel: 'Bark', configured: bark.key, run: () => testBark(bark, testText) },
    { id: 'webhook', channel: 'Webhook', configured: webhook.url, run: () => testWebhook(webhook, testText) },
    { id: 'email', channel: '邮件', configured: email.host || email.to, run: () => testEmail(email) }
  ]
  const tests = selected ? allTests.filter(t => t.id === selected) : allTests.filter(t => t.configured)
  const results = await Promise.all(tests.map(async test => {
    try {
      await test.run()
      return { id: test.id, channel: test.channel, ok: true }
    } catch (e) {
      console.error('[notify] ' + test.channel + ' test fail:', e.message)
      return { id: test.id, channel: test.channel, ok: false, error: e.message }
    }
  }))
  res.json({ ok: results.length > 0 && results.every(r => r.ok), results: results })
})

function scheduleCleanup() {
  const now = new Date()
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), CLEANUP_HOUR, CLEANUP_MINUTE, 0)
  let ms = target - now
  if (ms <= 0) ms += 86400000
  setTimeout(function() {
    otpList = []
    try { saveOtp() } catch (e) {}
    console.log('[Cleanup] 自动清空验证码记录')
    scheduleCleanup()
  }, ms)
}
scheduleCleanup()

const PORT = process.env.PORT || 3001
// 绑定 0.0.0.0：本地 localhost 与局域网/隧道都能访问；生产环境由反代转发，同样适用
const server = app.listen(PORT, '0.0.0.0', function() {
  console.log('OTP v3.2 服务已启动，端口:', PORT)
  console.log('管理控制台: http://127.0.0.1:' + PORT + '/admin')
})
// 端口被占用时给出明确提示并退出，而不是静默崩溃
server.on('error', function(err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用！请先停止占用该端口的程序，或用 OTP_PORT 换一个端口再启动（例如 OTP_PORT=3002）。')
    process.exit(1)
  } else {
    console.error('服务启动出错:', err)
    process.exit(1)
  }
})
const wss = new WebSocketServer({ server })
function broadcastUpdate() {
  if (!wss) return
  const msg = JSON.stringify({ type: 'update' })
  wss.clients.forEach(function(c) { if (c.readyState === 1) c.send(msg) })
}
