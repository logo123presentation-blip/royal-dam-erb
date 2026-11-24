/* Integration test: two independent device caches, offline queue, compressed backup, sync, and forced logout. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(process.cwd());
const temp = await mkdtemp(path.join(tmpdir(), 'royal-dam-offline-test-'));
const processes = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const testPassword = 'test-only-password-123';
function start(port, dir, offline = false) {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), LOCAL_DATA_DIR: dir, JWT_SECRET: 'test-only-jwt-secret-012345678901234567890123456789', INITIAL_ADMIN_PASSWORD: testPassword, ...(offline ? { DB_HOST: '127.0.0.1', DB_PORT: '1' } : {}) }, stdio: 'pipe', windowsHide: true });
  processes.push(child); return child;
}
async function waitFor(port) {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return r.json(); } catch {} await delay(250); }
  throw Error(`API ${port} did not start`);
}
async function json(port, url, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: r.status === 204 ? null : await r.json() };
}
try {
  const aDir = path.join(temp, 'device-a'), bDir = path.join(temp, 'device-b');
  start(3101, aDir); await waitFor(3101);
  const aLogin = await json(3101, '/api/auth/login', { method: 'POST', body: { username: 'owner', password: testPassword } }); assert.equal(aLogin.status, 200); const ownerA = aLogin.data.accessToken;
  start(3102, bDir); await waitFor(3102);
  const bLogin = await json(3102, '/api/auth/login', { method: 'POST', body: { username: 'owner', password: testPassword } }); assert.equal(bLogin.status, 200); const ownerB = bLogin.data.accessToken;
  const viewer = await json(3102, '/api/auth/login', { method: 'POST', body: { username: 'viewer', password: testPassword } }); assert.equal(viewer.status, 200);
  processes.pop().kill(); await delay(600);
  start(3102, bDir, true); const offlineHealth = await waitFor(3102); assert.equal(offlineHealth.online, false);
  const offlineLogin = await json(3102, '/api/auth/login', { method: 'POST', body: { username: 'owner', password: testPassword } }); assert.equal(offlineLogin.status, 200);
  const created = await json(3102, '/api/projects', { method: 'POST', token: offlineLogin.data.accessToken, body: { name: `Offline test ${Date.now()}`, location: 'offline', status: 'نشط', budget: 1, startDate: '2026-08-24', notes: 'temporary integration test' } }); assert.equal(created.status, 202); assert.equal(created.data.syncStatus, 'pending');
  const pending = await json(3102, '/api/sync-status', { token: offlineLogin.data.accessToken }); assert.ok(pending.data.queued > 0);
  assert.ok((await readdir(path.join(bDir, 'backups'))).some(x => x.endsWith('.json.gz')), 'compressed backup was not created');
  processes.pop().kill(); await delay(600);
  start(3102, bDir); const onlineHealth = await waitFor(3102); assert.equal(onlineHealth.online, true);
  const synced = await json(3102, '/api/sync-status', { token: ownerB }); assert.equal(synced.data.queued, 0);
  await json(3101, '/health'); const onA = await json(3101, '/api/projects', { token: ownerA }); assert.ok(onA.data.some(x => x.id === created.data.id), 'second device did not receive synced change');
  const logout = await json(3101, '/api/logout-all', { method: 'POST', token: ownerA }); assert.equal(logout.status, 200);
  await json(3102, '/health'); const rejected = await json(3102, '/api/me', { token: viewer.data.accessToken }); assert.equal(rejected.status, 401, 'force logout did not invalidate the second device token');
  await json(3101, `/api/projects/${created.data.id}`, { method: 'DELETE', token: ownerA });
  console.log('PASS: offline save → compressed local cache/backup → online sync across device caches → forced logout.');
} finally {
  for (const child of processes) child.kill();
  await rm(temp, { recursive: true, force: true });
}
