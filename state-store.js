// Private application state. Disabled unless a private data directory is set.
// Configuring a directory alone does not prove durable storage; redeploy tests do.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.env.NAUNG_DATA_DIR ? path.resolve(process.env.NAUNG_DATA_DIR) : null;
const enabled = Boolean(root);
let data = { version: 1, id: crypto.randomUUID(), values: {} };
const clone = value => JSON.parse(JSON.stringify(value));
let file;
if (enabled) {
  if (!path.isAbsolute(process.env.NAUNG_DATA_DIR) || root === path.parse(root).root) throw new Error('Private data directory must be a non-root absolute path');
  const source = fs.realpathSync(__dirname);
  if (root === source || root.startsWith(source + path.sep)) throw new Error('State directory must be outside the served source tree');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);
  if (realRoot === source || realRoot.startsWith(source + path.sep)) throw new Error('State directory resolves inside served source tree');
  fs.chmodSync(root, 0o700);
  file = path.join(root, 'state.json');
  try {
    if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('State snapshot is too large');
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || typeof data.id !== 'string' || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) throw new Error('Invalid state snapshot');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}
function get(key, fallback) { return clone(Object.hasOwn(data.values, key) ? data.values[key] : fallback); }
function set(key, value) {
  if (!enabled) return;
  data.values[key] = clone(value);
  const tmp = path.join(root, '.state-' + crypto.randomBytes(8).toString('hex') + '.tmp');
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(root, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch (err) {
    // No request handler or background retry may swallow a storage failure and
    // keep publishing unsaved paid stock or announcements from RAM.
    console.error('Private state write failed; stopping:', err.code || 'write_error');
    process.exit(74);
  }
}
module.exports = { enabled, root, id: data.id, get, set };
