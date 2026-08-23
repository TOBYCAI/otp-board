'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const otp = require('./otp-core.js');

test('extracts a Chinese SMS verification code', () => {
  const r = otp.process('【腾讯】您的验证码是123456，5分钟内有效', '10690');
  assert.ok(r, 'should extract something');
  assert.equal(r.otp, '123456');
  assert.equal(r.platform, '腾讯');
  assert.match(r.time, /^\d{2}:\d{2}:\d{2}$/);
});

test('extracts an English verification code', () => {
  const r = otp.process('Your verification code is 654321. Do not share it.', 'Google');
  assert.ok(r);
  assert.equal(r.otp, '654321');
});

test('extracts a WeChat linking mobile number code', () => {
  const r = otp.process('Weixin: verifying your mobile number [428157]', '');
  assert.ok(r, 'wechat linking code');
  assert.equal(r.otp, '428157');
});

test('extracts a separated code 123-456', () => {
  const r = otp.process('Your code is 123-456 to login', 'OpenAI');
  assert.ok(r);
  assert.equal(r.otp, '123456');
});

test('extracts a full hyphenated alphanumeric code A1B2-C3D4', () => {
  // Realistic OTPs are alphanumeric WITH digits; the pattern intentionally
  // rejects pure-letter tokens (e.g. ABCD-EFGH), matching the client logic.
  // This input routes through pattern 11 (the "<code> is your <kind> code" form)
  // so the hyphenated token is captured whole.
  const r = otp.process('A1B2-C3D4 is your verification code', 'Gmail');
  assert.ok(r, 'alphanumeric code with digits');
  assert.equal(r.otp.toUpperCase(), 'A1B2-C3D4');
});

test('returns null when no OTP keyword is present', () => {
  const r = otp.process('今日促销 优惠 打折 满减 领红包，速来！', '10655');
  assert.equal(r, null);
});

test('returns null for a plain price / amount (context rejected)', () => {
  const r = otp.process('您的尾号8888信用卡账单金额￥123456，请还款', '95588');
  assert.equal(r, null);
});

test('classifies notification packages', () => {
  assert.deepEqual(otp.classifySource('com.whatsapp'), { source: 'WhatsApp', fallbackPlatform: 'WhatsApp' });
  assert.deepEqual(otp.classifySource('com.tencent.mm'), { source: 'WeChat', fallbackPlatform: '微信' });
  assert.deepEqual(otp.classifySource('com.google.android.gm'), { source: 'Email', fallbackPlatform: 'Gmail' });
  assert.equal(otp.classifySource('com.unknown.app'), null);
});

test('isEmailSource', () => {
  assert.equal(otp.isEmailSource('Email'), true);
  assert.equal(otp.isEmailSource('Email-Google'), true);
  assert.equal(otp.isEmailSource('SMS'), false);
  assert.equal(otp.isEmailSource('WhatsApp'), false);
});
