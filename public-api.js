'use strict';

// Browser callers are limited to the public GitHub Pages frontend. CORS is
// not authentication; server-side origin checks and rate limits still apply.
const PAGES_ORIGIN = 'https://vanipy.com';

function allowedPagesOrigin(origin) {
  return origin === PAGES_ORIGIN;
}

function visitorCorsHeaders(origin) {
  if (!allowedPagesOrigin(origin)) return null;
  return {
    'access-control-allow-origin': PAGES_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'access-control-max-age': '600',
    'vary': 'Origin',
  };
}

function clientKey(req, trustForwardedFor = false) {
  // Only opt in to X-Forwarded-For after confirming that the hosting ingress
  // strips client-supplied values and writes its own. Default to the socket.
  const forwarded = trustForwardedFor && req.headers && req.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return first || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createRateLimiter({ maxRequests, windowMs, minIntervalMs = 0, maxEntries = 10000 }) {
  const records = new Map();
  let lastCleanup = 0;
  return function check(key, now = Date.now()) {
    if (now - lastCleanup > 60_000) {
      for (const [id, record] of records) {
        if (now - record.windowStart >= windowMs) records.delete(id);
      }
      lastCleanup = now;
    }
    let record = records.get(key);
    if (!record || now - record.windowStart >= windowMs) {
      record = { windowStart: now, count: 0, lastAt: -Infinity };
      records.set(key, record);
    }
    if (minIntervalMs && now - record.lastAt < minIntervalMs) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((minIntervalMs - (now - record.lastAt)) / 1000)) };
    }
    if (record.count >= maxRequests) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - record.windowStart)) / 1000)) };
    }
    record.count += 1;
    record.lastAt = now;
    if (records.size > maxEntries) records.delete(records.keys().next().value);
    return { allowed: true, retryAfter: 0 };
  };
}

module.exports = { PAGES_ORIGIN, allowedPagesOrigin, visitorCorsHeaders, clientKey, createRateLimiter };
