import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(extraEnv = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kovi-server-'));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: dir, CALIBRE_COVER_RESOLVER: 'false', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !healthy) {
    try { healthy = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!healthy) await sleep(100);
  }
  if (!healthy) {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`kovi did not start:\n${output}`);
  }
  return {
    base,
    logs: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill('SIGKILL');
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const post = (base, pathname, body, headers = {}) => fetch(`${base}${pathname}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('pairing attempts are rate limited per source and ignore X-Forwarded-For unless trusted', async () => {
  const server = await startServer();
  try {
    for (let i = 0; i < 30; i++) {
      const res = await post(server.base, '/api/plugin/pair', { code: 'invalid-code' }, { 'x-forwarded-for': `203.0.113.${i + 1}` });
      assert.equal(res.status, 401);
    }
    const blocked = await post(server.base, '/api/plugin/pair', { code: 'invalid-code' }, { 'x-forwarded-for': '203.0.113.250' });
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /Too many pairing attempts/);
  } finally {
    await server.stop();
  }
});

test('TRUST_PROXY keys the rate limit on the forwarded client, validates hops, and logs it', async () => {
  const server = await startServer({ TRUST_PROXY: '1' });
  try {
    for (let i = 0; i < 30; i++) {
      assert.equal((await post(server.base, '/api/plugin/pair', { code: 'invalid-code' }, { 'x-forwarded-for': '203.0.113.10' })).status, 401);
    }
    // A different forwarded client still has its own budget.
    assert.equal((await post(server.base, '/api/plugin/pair', { code: 'invalid-code' }, { 'x-forwarded-for': '203.0.113.11' })).status, 401);
    // The exhausted client is now blocked.
    assert.equal((await post(server.base, '/api/plugin/pair', { code: 'invalid-code' }, { 'x-forwarded-for': '203.0.113.10' })).status, 429);
    // A non-IP forwarded value is rejected and falls back to the direct peer.
    assert.equal((await post(server.base, '/api/plugin/pair', { code: 'invalid-code' }, { 'x-forwarded-for': 'not-an-ip' })).status, 401);
    await sleep(100);
    assert.match(server.logs(), /"remote":"203\.0\.113\.10"/);
    assert.match(server.logs(), /"remote":"127\.0\.0\.1"/);
  } finally {
    await server.stop();
  }
});

test('plugin ping keeps responding but logs at most once per interval', async () => {
  const server = await startServer();
  try {
    assert.equal((await fetch(`${server.base}/api/plugin/ping`)).status, 200);
    assert.equal((await fetch(`${server.base}/api/plugin/ping`)).status, 200);
    await sleep(100);
    assert.equal((server.logs().match(/plugin\.ping/g) || []).length, 1);
  } finally {
    await server.stop();
  }
});

test('concurrent backup requests are serialized with 429', async () => {
  const server = await startServer();
  try {
    const statuses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${server.base}/api/backup`).then((r) => r.status)));
    assert.ok(statuses.includes(200), `expected a successful backup, got ${statuses}`);
    assert.ok(statuses.includes(429), `expected a rejected concurrent backup, got ${statuses}`);
  } finally {
    await server.stop();
  }
});

test('server pins explicit HTTP timeouts instead of relying on runtime defaults', () => {
  const source = readFileSync(SERVER, 'utf8');
  assert.match(source, /server\.headersTimeout\s*=\s*HEADERS_TIMEOUT_MS/);
  assert.match(source, /server\.requestTimeout\s*=\s*REQUEST_TIMEOUT_MS/);
  assert.match(source, /server\.keepAliveTimeout\s*=\s*KEEP_ALIVE_TIMEOUT_MS/);
});
