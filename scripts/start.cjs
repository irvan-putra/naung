// A disk-backed instance must hold the OS writer lock for its entire lifetime.
// RWO storage alone does not prevent two pods on the same node from writing.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
// Explicit disposable mode. Never reuse the old mounted native directory.
if(process.env.NAUNG_BUNDLED_HISTORY === '1' && !process.env.NAUNG_DATA_DIR) process.env.NAUNG_DATA_DIR='/tmp/naung-ephemeral';
if (!process.env.NAUNG_DATA_DIR) {
  require('../server');
} else {
  const root = path.resolve(process.env.NAUNG_DATA_DIR);
  const source = fs.realpathSync(path.join(__dirname, '..'));
  if (!path.isAbsolute(process.env.NAUNG_DATA_DIR) || root === path.parse(root).root || root === source || root.startsWith(source + path.sep)) throw new Error('Invalid private data directory');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);
  if (realRoot === source || realRoot.startsWith(source + path.sep)) throw new Error('Private data directory resolves into served files');
  fs.chmodSync(root, 0o700);
  // No fork means the lock stays held by the actual server process.
  // A missing flock is an error, never a reason to run without the lock.
  const child = spawn('flock', ['--no-fork', '--nonblock', '--conflict-exit-code', '73', path.join(root, 'writer.lock'), process.execPath, path.join(source, 'server.js')], { stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('error', err => { console.error('Cannot acquire disk writer lock:', err.code); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (code === 73) console.error('Another disk writer is active; refusing to start');
    process.exit(code == null ? (signal ? 1 : 0) : code);
  });
}
