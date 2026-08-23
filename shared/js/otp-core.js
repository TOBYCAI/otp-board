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
