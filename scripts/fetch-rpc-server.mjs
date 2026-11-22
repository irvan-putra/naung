// Downloads the encore (chatmail/core fork) deltachat-rpc-server binary,
// pinned to a specific CI release with a SHA-256 check. Installs to
// bin/deltachat-rpc-server, which dc.js prefers over the npm prebuilt.
// Fails the install on download or checksum error so a deploy never
// silently falls back to a different core.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const URL =
  'https://github.com/irvan-putra/encore/releases/download/rpc-server-20261122-0218/deltachat-rpc-server';
const SHA256 = '1d19d71dbfdab4b7d3527fa8f2a9d3fbb922b76976f3ab934fdbd18295047e9b';
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'deltachat-rpc-server');

if (existsSync(dest)) {
  console.log('[fetch-rpc-server] bin/deltachat-rpc-server already present, skipping');
  process.exit(0);
}

const res = await fetch(URL, { redirect: 'follow' });
if (!res.ok || !res.body) {
  console.error(`[fetch-rpc-server] download failed: HTTP ${res.status} from ${URL}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
const hash = createHash('sha256');
const out = createWriteStream(dest, { mode: 0o755 });
const body = Readable.fromWeb(res.body);
body.on('data', (chunk) => hash.update(chunk));
await pipeline(body, out);
const got = hash.digest('hex');
if (SHA256 && got !== SHA256) {
  console.error(`[fetch-rpc-server] sha256 mismatch: got ${got}, expected ${SHA256}`);
  process.exit(1);
}
chmodSync(dest, 0o755);
console.log(`[fetch-rpc-server] installed encore deltachat-rpc-server (sha256 ${got})`);
