'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedPagesOrigin, visitorCorsHeaders, publicReadCorsHeaders, clientKey, createRateLimiter } = require('./public-api');

test('only the canonical Pages origin receives CORS headers', () => {
  assert.equal(allowedPagesOrigin('https://vanipy.com'), true);
  for (const origin of [undefined, 'null', 'https://www.vanipy.com', 'https://vanipy.com.evil.test', 'http://vanipy.com']) {
    assert.equal(allowedPagesOrigin(origin), false);
    assert.equal(visitorCorsHeaders(origin), null);
  }
  assert.equal(visitorCorsHeaders('https://vanipy.com')['access-control-allow-origin'], 'https://vanipy.com');
});

test('read-only CORS permits GET from the Pages origin only', () => {
  assert.deepEqual(publicReadCorsHeaders('https://vanipy.com'), {
    'access-control-allow-origin': 'https://vanipy.com',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '600',
    'vary': 'Origin',
  });
  for (const origin of [undefined, 'null', 'https://www.vanipy.com', 'https://vanipy.com.evil.test', 'http://vanipy.com']) {
    assert.equal(publicReadCorsHeaders(origin), null);
  }
});
test('client key uses forwarded client address then socket fallback', () => {
  assert.equal(clientKey({ headers: { 'x-forwarded-for': '198.51.100.2, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.2' } }), '10.0.0.2');
  assert.equal(clientKey({ headers: { 'x-forwarded-for': '198.51.100.2, 10.0.0.1' }, socket: {} }, true), '198.51.100.2');
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
});

test('rate limiter enforces interval and window and resets after the window', () => {
  const check = createRateLimiter({ maxRequests: 2, windowMs: 10000, minIntervalMs: 2000 });
  assert.deepEqual(check('ip', 0), { allowed: true, retryAfter: 0 });
  assert.equal(check('ip', 1000).allowed, false);
  assert.equal(check('ip', 2000).allowed, true);
  assert.equal(check('ip', 4000).allowed, false);
  assert.equal(check('ip', 10000).allowed, true);
});
