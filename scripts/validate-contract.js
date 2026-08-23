#!/usr/bin/env node
'use strict';

/**
 * Validates the cross-cutting contract shared by client and server:
 *   - shared/proto/otp-payload.schema.json is valid JSON and well-formed
 *   - shared/otp-rules.json is valid and has the expected rule groups
 *   - shared/js/otp-core.js produces a payload that satisfies the schema
 */

const fs = require('fs');
const path = require('path');
const otpCore = require('../shared/js/otp-core.js');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function fail(msg) {
  console.error('  ✗ ' + msg);
  failures++;
}
function ok(msg) {
  console.log('  ✓ ' + msg);
}

// ---- 1. schema ----
const schemaPath = path.join(ROOT, 'shared', 'proto', 'otp-payload.schema.json');
let schema;
try {
  schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  ok('otp-payload.schema.json parses');
} catch (e) {
  fail('otp-payload.schema.json invalid JSON: ' + e.message);
  process.exit(1);
}

if (schema.type !== 'object') fail('schema.type must be "object"');
else ok('schema.type is object');

const required = Array.isArray(schema.required) ? schema.required : [];
for (const f of ['otp', 'source', 'platform', 'time']) {
  if (!required.includes(f)) fail(`schema.required missing "${f}"`);
}
if (required.includes('otp') && required.includes('source') && required.includes('platform') && required.includes('time')) {
  ok('schema.required covers otp/source/platform/time');
}

// ---- 2. rules ----
const rulesPath = path.join(ROOT, 'shared', 'otp-rules.json');
let rules;
try {
  rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  ok('otp-rules.json parses');
} catch (e) {
  fail('otp-rules.json invalid JSON: ' + e.message);
  process.exit(1);
}
for (const key of ['whitelist', 'blacklist', 'carrierMap']) {
  if (!Array.isArray(rules[key]) && typeof rules[key] !== 'object') {
    fail(`otp-rules.json missing "${key}"`);
  } else {
    ok(`otp-rules.json has "${key}"`);
  }
}

// ---- 3. payload from the shared core satisfies the schema ----
function validate(sample) {
  for (const f of required) {
    if (!(f in sample)) return `missing required field "${f}"`;
  }
  for (const [k, v] of Object.entries(sample)) {
    const def = schema.properties && schema.properties[k];
    if (!def) continue;
    const t = def.type === 'string' ? 'string' : def.type === 'integer' || def.type === 'number' ? 'number' : null;
    if (t && typeof v !== t) return `field "${k}" expected ${def.type}`;
  }
  return null;
}

const samples = [
  { content: '你的验证码是 123456，5 分钟内有效', platform: '中国移动', source: 'SMS' },
  { content: 'Your Gmail code is 654321', platform: 'Gmail', source: 'Email' },
  { content: 'Use ABCD-12EF to verify', platform: 'GitHub', source: 'SMS' },
];

// The extractor intentionally does NOT set `source` (the caller decides the channel),
// so we validate its own output (otp/platform/time) and then assemble a full payload
// that also carries `source` — mirroring how OtpForwarder / server.js build it.
for (const s of samples) {
  const r = otpCore.process(s.content, s.platform);
  if (!r || typeof r.otp !== 'string' || !r.otp) {
    fail(`otp-core failed to extract from: ${s.content}`);
    continue;
  }
  if (typeof r.platform !== 'string' || typeof r.time !== 'string') {
    fail(`otp-core output shape wrong for "${s.content}": ${JSON.stringify(r)}`);
    continue;
  }
  const fullPayload = { otp: r.otp, source: s.source, platform: r.platform, time: r.time };
  const err = validate(fullPayload);
  if (err) fail(`payload for "${s.content}" invalid: ${err}`);
  else ok(`extract + assemble payload: ${JSON.stringify(fullPayload)}`);
}

console.log('');
if (failures > 0) {
  console.error(`Contract validation FAILED (${failures} issue(s)).`);
  process.exit(1);
}
console.log('Contract validation passed.');
