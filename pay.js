// Demo store with Midtrans Snap checkout (owner request 12:44).
// Sandbox by default. The server key stays server-side in env; the client key
// is public by design (Snap JS). Built per the official Midtrans agent skill
// (integrate-midtrans-payments, snap-checkout playbook, skill v0.3.2).
const crypto = require('node:crypto');

const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY || '';
const PROD = false; // This deployment is sandbox-only, regardless of env drift.
const SNAP_BASE = PROD ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com';
const CORE_BASE = PROD ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
const SNAP_JS = `${SNAP_BASE}/snap/snap.js`;
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://irvan.app.neoapp.id').replace(/\/+$/, '');

// Fake demo catalog: no real business, no real delivery, clearly labeled.
const ITEMS = [
  { id: 'starter', name: 'Demo SaaS Starter (not a real product)', price: 25000 },
  { id: 'support', name: 'Demo API Support Pack (not a real product)', price: 50000 },
  { id: 'pro', name: 'Demo Pro License (not a real product)', price: 99000 },
];

// In-memory order store (demo; gone on restart). State model per the skill:
// creating_payment -> awaiting_payment -> paid|failed|cancelled|expired(->refunded)
const orders = new Map();
const FINAL = new Set(['paid', 'failed', 'cancelled', 'expired', 'refunded']);
const paidEvents = new Map();
let drainingPaidEvents = false;
async function drainPaidEvents(deliver) {
  if (drainingPaidEvents) return;
  drainingPaidEvents = true;
  try {
    for (const event of paidEvents.values()) {
      if (event.delivered) continue;
      if (await deliver(event).catch(() => false)) event.delivered = true;
    }
  } finally { drainingPaidEvents = false; }
}
const inventory = new Map(ITEMS.map(i => [i.id, { stock: 999, reserved: 0 }]));
function catalog() {
  return ITEMS.map(i => ({ ...i, stock: inventory.get(i.id).stock,
    available: inventory.get(i.id).stock - inventory.get(i.id).reserved }));
}
function releaseReservation(order) {
  if (!order.reserved) return;
  inventory.get(order.itemId).reserved--;
  order.reserved = false;
}

function checkoutOrder(orderId) {
  const o = orders.get(orderId);
  if (!o || FINAL.has(o.state) || !o.token) return { error: 'No pending checkout for this order. Check its verified status instead.' };
  return { ...publicOrder(o), token: o.token, redirectUrl: o.redirectUrl };
}

// Public demo workflow, deterministic commands only. No real goods, payouts,
// seller identity claims, or AI-authorized commerce. Each /buy is one unit.
async function marketCommand(text) {
  const input = String(text || '').trim();
  const match = input.match(/^\/(shop|market|sell|buy)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const command = match[1].toLowerCase(), arg = (match[2] || '').trim();
  if (command === 'shop' || command === 'market') {
    await reconcilePending();
    return 'Sandbox marketplace, pretend goods only. One unit per checkout. No real delivery or seller payouts.\n'
      + catalog().map(i => i.id + ': ' + i.name + ' | ' + idr(i.price) + ' | quantity ' + i.stock + (i.available < i.stock ? ' (' + (i.stock-i.available) + ' reserved)' : '')).join('\n')
      + '\nBuy: /buy item-id\nSell: /sell Demo item name | 25000 | 999\nListings and stock reset on server restart. All chat and order links here are public.';
  }
  if (command === 'sell') {
    const parts = arg.split('|').map(x => x.trim());
    if (parts.length !== 3 || parts[0].length < 2 || parts[0].length > 25 || /[\r\n<>]/.test(parts[0])
        || !/^[0-9]+$/.test(parts[1]) || !/^[0-9]+$/.test(parts[2]))
      return 'To add a pretend demo listing: /sell Demo item name | 25000 | 999. Use an item name (2-25 characters), integer IDR price, and integer quantity. No private information or real offers.';
    const price = Number(parts[1]), qty = Number(parts[2]);
    if (!Number.isSafeInteger(price) || price < 1000 || price > 10000000 || !Number.isSafeInteger(qty) || qty < 1 || qty > 9999)
      return 'Demo limits: price Rp1,000-Rp10,000,000; quantity 1-9999. Nothing real is sold or delivered.';
    if (ITEMS.length >= 53) return 'This demo session already has 50 custom listings. No new listing was added.';
    const item = { id: 'listing-' + crypto.randomBytes(3).toString('hex'), name: 'Demo listing: ' + parts[0] + ' (not real)', price };
    ITEMS.push(item); inventory.set(item.id, { stock: qty, reserved: 0 });
    return 'Sandbox listing added: ' + item.id + ' | ' + item.name + ' | ' + idr(price) + ' | quantity ' + qty
      + '.\nBuy one: /buy ' + item.id + '\nPretend goods only. No real delivery, seller payout, or verified seller identity. Listing resets on restart.';
  }
  if (!/^(starter|support|pro|listing-[0-9a-f]{6})$/.test(arg)) return 'Choose an item with /shop, then /buy item-id. One unit per sandbox checkout.';
  const o = await createOrder(arg);
  if (o.error) return 'No checkout created: ' + o.error;
  if (!o.token) return 'Sandbox checkout could not be created. No payment or stock reduction occurred. Try again later.';
  return 'Sandbox checkout for ' + o.itemName + ', one unit, ' + idr(o.amount) + '. Stock changes only after verified payment.\n'
    + PUBLIC_BASE + '/pay?order_id=' + encodeURIComponent(o.orderId) + '&checkout=1'
    + '\nOpen this link to pay on Midtrans sandbox. Never put card/wallet details in chat. This demo order link is public; no real money or delivery.';
}

function configured() { return Boolean(SERVER_KEY && CLIENT_KEY); }

function mapProviderStatus(ts, fraud) {
  if (ts === 'settlement') return 'paid';
  if (ts === 'capture') return fraud === 'accept' ? 'paid' : 'awaiting_payment';
  if (ts === 'pending') return 'awaiting_payment';
  if (ts === 'deny' || ts === 'failure') return 'failed';
  if (ts === 'cancel') return 'cancelled';
  if (ts === 'expire') return 'expired';
  if (ts === 'refund' || ts === 'partial_refund') return 'refunded';
  return 'awaiting_payment';
}

function applyProvider(order, ts, fraud) {
  // Monotonic: a late pending/cancel never overwrites paid or refunded.
  if (order.state === 'paid' || order.state === 'refunded') return;
  order.state = mapProviderStatus(ts, fraud);
  const firstPaid = order.state === 'paid' && !order.stockApplied;
  if (firstPaid) {
    const inv = inventory.get(order.itemId);
    // One synchronous update per verified order; duplicate polls/notifications
    // cannot consume stock twice. Pending checkouts reserve capacity only.
    releaseReservation(order);
    inv.stock = Math.max(0, inv.stock - 1);
    order.stockApplied = true;
  } else if (FINAL.has(order.state)) releaseReservation(order);
  order.providerStatus = String(ts || '');
  order.updatedAt = Date.now();
  if (firstPaid && !paidEvents.has(order.orderId)) {
    paidEvents.set(order.orderId, { orderId: order.orderId, itemName: order.itemName,
      amount: order.amount, stockRemaining: inventory.get(order.itemId).stock,
      providerStatus: order.providerStatus, delivered: false });
  }
}

async function snapCreate(order) {
  const res = await fetch(`${SNAP_BASE}/snap/v1/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(`${SERVER_KEY}:`).toString('base64'),
      // Per-transaction webhook route so no dashboard change is needed for the
      // demo; status polling covers any missed notification.
      'X-Override-Notification': `${PUBLIC_BASE}/api/pay/notification`,
    },
    body: JSON.stringify({
      transaction_details: { order_id: order.orderId, gross_amount: order.amount },
      item_details: [{ id: order.itemId, price: order.amount, quantity: 1, name: order.itemName }],
      customer_details: { first_name: 'Demo Customer' },
      // Cards are in scope (all methods shown): enforce 3DS per transaction.
      credit_card: { secure: true },
      // Per-transaction redirection URLs (these override the dashboard
      // Finish/Error URLs): after paying on the Snap page the customer lands
      // back on /pay, which re-verifies the order with Midtrans server-side
      // before claiming any state. Owner request 13:26.
      // GoPay mobile deeplinks bypass the Snap popup's onSuccess callback.
      // Provider appends order_id and result; backend still verifies status.
      gopay: { enable_callback: true, callback_url: `${PUBLIC_BASE}/pay` },
      callbacks: {
        finish: `${PUBLIC_BASE}/pay?order_id=${encodeURIComponent(order.orderId)}`,
        error: `${PUBLIC_BASE}/pay?order_id=${encodeURIComponent(order.orderId)}&result=error`,
        pending: `${PUBLIC_BASE}/pay?order_id=${encodeURIComponent(order.orderId)}&result=pending`,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`snap create failed: ${String(data.status_message || res.status).slice(0, 120)}`);
  return data;
}

async function createOrder(itemId) {
  const item = ITEMS.find((i) => i.id === itemId);
  if (!item) return { error: 'unknown item' };
  if (!configured()) return { error: 'payments not configured' };
  const inv = inventory.get(item.id);
  if (inv.stock - inv.reserved <= 0) return { error: 'demo product sold out (or all units reserved by pending checkouts)' };
  if (orders.size >= 5000) return { error: 'demo order limit reached for this server session' };
  // Reserve before the first await, so concurrent creates cannot oversell.
  inv.reserved++;
  const orderId = `NAUNGDEMO-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const order = { orderId, itemId: item.id, itemName: item.name, amount: item.price, state: 'creating_payment', reserved: true, stockApplied: false, token: null, redirectUrl: null, providerStatus: '', updatedAt: Date.now() };
  orders.set(orderId, order);
  // Keep session records for idempotency; do not evict pending/paid orders.
  try {
    const data = await snapCreate(order);
    order.token = data.token || null;
    order.redirectUrl = data.redirect_url || null;
    order.state = order.token ? 'awaiting_payment' : 'failed';
  } catch (err) {
    order.state = 'failed';
    order.providerStatus = String(err && err.message || err).slice(0, 120);
  }
  if (order.state === 'failed') releaseReservation(order);
  order.updatedAt = Date.now();
  return order;
}

async function refreshStatus(order) {
  if (!configured() || !order || FINAL.has(order.state)) return;
  order.lastCheckedAt = Date.now();
  const res = await fetch(`${CORE_BASE}/v2/${encodeURIComponent(order.orderId)}/status`, {
    headers: { authorization: 'Basic ' + Buffer.from(`${SERVER_KEY}:`).toString('base64') },
  }).catch(() => null);
  // 404 before the customer picks a method means "not attempted yet".
  if (!res || !res.ok) return;
  const data = await res.json().catch(() => null);
  if (!data || !data.transaction_status) return;
  applyProvider(order, data.transaction_status, data.fraud_status);
}

let reconciling = false;
async function reconcilePending() {
  if (reconciling || !configured()) return;
  reconciling = true;
  try {
    const pending = [...orders.values()].filter(o => !FINAL.has(o.state)
      && o.state !== 'creating_payment' && Date.now() - (o.lastCheckedAt || 0) >= 30000)
      .sort((a,b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0)).slice(0,10);
    await Promise.all(pending.map(o => refreshStatus(o)));
  } finally { reconciling = false; }
}
// Browser-independent reconciliation: mobile wallet users can leave the page.
const reconcileTimer = setInterval(() => { reconcilePending().catch(() => {}); }, 15000);
reconcileTimer.unref();

function handleNotification(body) {
  const b = body || {};
  const orderId = String(b.order_id || '');
  const signature = String(b.signature_key || '');
  if (!orderId || !signature) return { ok: false, reason: 'missing fields' };
  // Raw gross_amount string, never reformatted (most common signature bug).
  const expect = crypto.createHash('sha512')
    .update(orderId + String(b.status_code || '') + String(b.gross_amount || '') + SERVER_KEY)
    .digest('hex');
  if (expect !== signature) return { ok: false, reason: 'bad signature' };
  const order = orders.get(orderId);
  if (order) applyProvider(order, b.transaction_status, b.fraud_status);
  return { ok: true, known: Boolean(order) };
}

// Reset-surviving confirmation: the local order store is in-memory, so after a
// restart a confirmation link only has the provider record. Look it up directly
// (read-only GET, demo ids only) and present a minimal provider-verified view.
async function lookupProvider(orderId) {
  if (!configured() || !/^NAUNGDEMO-[0-9]+-[0-9a-f]+$/.test(String(orderId || ''))) return null;
  const res = await fetch(`${CORE_BASE}/v2/${encodeURIComponent(orderId)}/status`, {
    headers: { authorization: 'Basic ' + Buffer.from(`${SERVER_KEY}:`).toString('base64') },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.transaction_status) return null;
  return {
    orderId: String(data.order_id || orderId),
    itemName: 'Order details recovered from Midtrans (local record cleared by a server restart)',
    amount: Math.round(Number(data.gross_amount || 0)),
    state: mapProviderStatus(data.transaction_status, data.fraud_status),
    providerStatus: String(data.transaction_status || ''),
    updatedAt: Date.now(),
  };
}

function publicOrder(o) {
  return { orderId: o.orderId, itemName: o.itemName, amount: o.amount, state: o.state, providerStatus: o.providerStatus, updatedAt: o.updatedAt, stockApplied: Boolean(o.stockApplied), stockRemaining: o.itemId ? inventory.get(o.itemId).stock : null };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function idr(n) { return 'Rp' + Number(n).toLocaleString('id-ID'); }

function payPage(shell) {
  const cards = ITEMS.map((i) => `
      <div class="msg">
        <div><strong>${esc(i.name)}</strong></div>
        <div class="meta">${esc(idr(i.price))}</div>
        <div class="meta" id="stock-${esc(i.id)}">Demo quantity remaining: ${inventory.get(i.id).stock}</div>
        <button id="buy-${esc(i.id)}" onclick="buy('${esc(i.id)}')">Buy (sandbox)</button>
      </div>`).join('\n');
  const cfgNote = configured()
    ? '<p>Sandbox mode: payments go to the Midtrans sandbox, no real money moves and nothing real is delivered. Snap will offer every payment method active on this sandbox account (cards, QRIS, e-wallets, bank transfer VA, convenience stores - which ones appear depends on the account dashboard).</p>'
    : '<p><strong>Payments are not configured yet</strong> (sandbox keys are not set on the server), so checkout is disabled. The store below is a preview.</p>';
  const snapTag = configured()
    ? `<script src="${esc(SNAP_JS)}" data-client-key="${esc(CLIENT_KEY)}"></script>`
    : '';
  const body = `
    <h1>Naung Software - demo store</h1>
    <p>A pretend software store to demo Midtrans payments. Sandbox only: no real charges, no real products, no real company.</p>
    ${cfgNote}
    <p>Built-in demo stock starts at 999 per product; chat listings use the quantity supplied by the participant. A verified successful payment reduces it by 1. Pending checkouts reserve a unit without reducing stock. Stock and reservations reset when this demo server restarts; past recovered payments do not reduce the new session stock.</p>
    <div id="store">${cards}</div>
    <h2>Order status</h2>
    <div id="order"><p>No order yet.</p></div>
    ${snapTag}
    <script>
(function () {
  var orderBox = document.getElementById('order');
  var pollTimer = null;
  function show(o) {
    orderBox.textContent = '';
    var d = document.createElement('div');
    d.className = 'msg';
    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = o.itemName + ' - Rp' + Number(o.amount).toLocaleString('id-ID') + ' - ' + o.orderId;
    var st = document.createElement('div');
    st.textContent = 'Status: ' + o.state + (o.providerStatus ? ' (' + o.providerStatus + ')' : '');
    d.appendChild(meta);
    d.appendChild(st);
    if (o.stockApplied) {
      var stockNote = document.createElement('div');
      stockNote.textContent = 'Demo product quantity decreased by 1 after verified payment. Remaining: ' + o.stockRemaining + '.';
      d.appendChild(stockNote);
    }
    var link = document.createElement('div');
    var a = document.createElement('a');
    a.href = '/pay?order_id=' + encodeURIComponent(o.orderId);
    a.textContent = 'Order confirmation link';
    link.appendChild(a);
    d.appendChild(link);
    orderBox.appendChild(d);
  }
  function updateStock() {
    fetch('/api/pay/catalog', { cache: 'no-store' }).then(function(r) { return r.json(); }).then(function(items) {
      items.forEach(function(i) {
        var el = document.getElementById('stock-' + i.id);
        if (el) el.textContent = 'Demo quantity remaining: ' + i.stock + (i.available < i.stock ? ' (' + (i.stock - i.available) + ' reserved)' : '');
        var btn = document.getElementById('buy-' + i.id);
        if (btn) { btn.disabled = i.available <= 0; btn.textContent = i.available <= 0 ? 'Sold out / reserved' : 'Buy (sandbox)'; }
      });
    }).catch(function() {});
  }
  updateStock();
  setInterval(updateStock, 5000);
  function check(orderId) {
    return fetch('/api/pay/status?id=' + encodeURIComponent(orderId), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (o) {
        if (!o || o.error) return;
        show(o);
        updateStock();
        if (['paid', 'failed', 'cancelled', 'expired', 'refunded'].indexOf(o.state) >= 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      })
      .catch(function () {});
  }
  function poll(orderId) {
    if (pollTimer) clearInterval(pollTimer);
    check(orderId);
    pollTimer = setInterval(function () { check(orderId); }, 5000);
  }
  // Returned from Snap (redirect mode finish/error/pending URL, or a shared
  // confirmation link): the status shown is ALWAYS re-verified server-side
  // with Midtrans; the query string is never trusted for the paid claim.
  var returnedOrder = new URLSearchParams(window.location.search).get('order_id');
  if (!returnedOrder) {
    try { returnedOrder = window.localStorage.getItem('naung-demo-last-order'); } catch (_) {}
  }
  if (returnedOrder && !/^NAUNGDEMO-[0-9]+-[0-9a-f]+$/.test(returnedOrder)) returnedOrder = null;
  if (returnedOrder) {
    try { window.localStorage.setItem('naung-demo-last-order', returnedOrder); } catch (_) {}
  }
  if (returnedOrder) {
    orderBox.innerHTML = '<p>Back from payment. The status below is verified with Midtrans, not taken from the link you followed.</p>';
    poll(returnedOrder);
  }
  window.buy = function (itemId) {
    fetch('/api/pay/create', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'item=' + encodeURIComponent(itemId),
    }).then(function (r) { return r.json(); }).then(function (o) {
      if (o.error) { orderBox.textContent = 'Cannot create payment: ' + o.error; return; }
      // Save before opening Snap, which can navigate this entire tab away.
      try { window.localStorage.setItem('naung-demo-last-order', o.orderId); } catch (_) {}
      window.history.replaceState(null, '', '/pay?order_id=' + encodeURIComponent(o.orderId));
      show(o);
      poll(o.orderId);
      openCheckout(o);
    }).catch(function () { orderBox.textContent = 'Cannot create payment right now.'; });
  };
  function openCheckout(o) {
      if (o.token && window.snap && window.snap.pay) {
        window.snap.pay(o.token, {
          onSuccess: function () { window.location.assign('/pay?order_id=' + encodeURIComponent(o.orderId) + '#order'); },
          onPending: function () { poll(o.orderId); },
          onError: function () { poll(o.orderId); },
          onClose: function () {},
        });
      } else if (o.redirectUrl) {
        window.location = o.redirectUrl;
      }
  }
  if (returnedOrder && new URLSearchParams(window.location.search).get('checkout') === '1') {
    window.history.replaceState(null, '', '/pay?order_id=' + encodeURIComponent(returnedOrder));
    fetch('/api/pay/checkout?id=' + encodeURIComponent(returnedOrder), { cache: 'no-store' }).then(function(r) { return r.json(); }).then(function(o) {
      if (o.error) { check(returnedOrder); return; }
      openCheckout(o);
    }).catch(function() {});
  }
})();
    </script>`;
  return shell('Naung Software - demo store (Midtrans sandbox)', body);
}

module.exports = { createOrder, refreshStatus, handleNotification, publicOrder, payPage, configured, orders, lookupProvider, catalog, reconcilePending, marketCommand, checkoutOrder, drainPaidEvents, SNAP_JS };
