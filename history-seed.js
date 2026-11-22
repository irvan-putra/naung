// Explicit one-time seed. Historical text is display-only, never live room context.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function validate(input) {
  if (!input || input.version !== 1 || typeof input.capturedAt !== 'string' || !Array.isArray(input.records) || input.records.length > 100) throw Error('Invalid history seed');
  const records = input.records.map(r => {
    if (!r || !['web-feed','native-group'].includes(r.source) || typeof r.from !== 'string' || typeof r.text !== 'string' || typeof r.time !== 'string' || r.text.length > 10000 || r.from.length > 250 || r.time.length > 100) throw Error('Invalid historical record');
    return { source:r.source, from:r.from, text:r.text, time:r.time };
  });
  if (!Array.isArray(input.catalog) || input.catalog.length > 56) throw Error('Invalid seed catalog');
  const ids = new Set();
  const catalog = input.catalog.map(i => {
    if (!i || typeof i.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(i.id) || ids.has(i.id) || !['seller','name','pitch'].every(k=>typeof i[k]==='string'&&i[k].length<2000) || !Number.isSafeInteger(i.price) || i.price<1 || !Number.isSafeInteger(i.stock) || i.stock<0 || i.available!==i.stock) throw Error('Invalid seed stock or active reservations');
    ids.add(i.id);
    return { id:i.id, seller:i.seller, name:i.name, price:i.price, pitch:i.pitch, initialStock:i.stock };
  });
  return { version:1, capturedAt:input.capturedAt, records, catalog };
}
function bootstrap() {
  const bundled=process.env.NAUNG_BUNDLED_HISTORY === '1';
  if(bundled && process.env.NAUNG_HISTORY_SEED_PATH)throw Error('Choose bundled or private history seed, not both');
  const selected=bundled ? path.join(__dirname,'archive/2026-11-23/history-seed.json') : process.env.NAUNG_HISTORY_SEED_PATH;
  if (!selected) return;
  const store = require('./state-store');
  if (!store.enabled) throw Error('History seed requires a private data directory, which can be ephemeral');
  const file = fs.realpathSync(selected);
  const source = fs.realpathSync(__dirname);
  if (!path.isAbsolute(selected) || (!bundled && (file===source || file.startsWith(source+path.sep)))) throw Error('History seed must be outside served source');
  if (fs.statSync(file).size > 2*1024*1024) throw Error('History seed too large');
  const raw=fs.readFileSync(file); const digest=crypto.createHash('sha256').update(raw).digest('hex');
  const seeded=store.get('historySeed',null);
  if(seeded){if(seeded.digest!==digest)throw Error('Different seed already imported');return;}
  if(store.get('shop',null)||store.get('bridge',null)||store.get('publicThread',null))throw Error('Refusing seed over existing state');
  const data=validate(JSON.parse(raw));
  store.setMany({ historicalArchive:{capturedAt:data.capturedAt,records:data.records}, shop:{items:data.catalog,orders:[],inventory:data.catalog.map(i=>[i.id,{stock:i.initialStock,reserved:0}]),paidEvents:[]}, historySeed:{digest,importedAt:new Date().toISOString(),mode:'visible-history-and-stock-only'} });
}
function render(archive) {
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if(!archive)return '<h1>Historical public chat</h1><p>No archive imported.</p>';
  return '<h1>Historical public chat</h1><p>Archived quotes from the previous demo, not new messages or verified identities. The web feed and group views overlap; duplicates are kept. Only publicly visible messages were captured. Times are exactly as captured. Web-feed times have no date and may be the old UTC display, not WIB; group records retain their original ISO timestamp.</p><p>Captured: '+esc(archive.capturedAt)+'</p><p>Shop catalog and stock were carried over as a new opening balance. Previous orders, checkout links, payment events and reservations were not restored.</p>'+archive.records.map(r=>'<article class="msg"><div class="meta">'+esc(r.source)+' | '+esc(r.from)+' | '+esc(r.time)+' (original display)</div><blockquote class="message-text">'+esc(r.text)+'</blockquote></article>').join('');
}
module.exports={validate,bootstrap,render};
