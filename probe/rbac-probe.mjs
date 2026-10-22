/**
 * Empirical RBAC / authorization probe for WioBrowse Cloud.
 *
 * Boots the real API server against a throwaway data directory, creates one
 * admin and two member accounts, then replays every API surface with several
 * principals: anonymous, member, other-member, admin. The goal is to
 * *demonstrate* which endpoints enforce which role, not to trust route
 * declarations.
 *
 * Usage: node probe/rbac-probe.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const adminPassword = 'probe-admin-password-1234';
const memberPassword = 'probe-member-password-1234';
const results = [];
let dataDir;
let baseUrl;
let child;
let stderr = '';

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  let last = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (response.ok) return;
      last = `${response.status} ${await response.text()}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server never became ready (${baseUrl}; ${last}): ${stderr}`);
}

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wiobr-request': '1' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`login failed for ${username}: ${response.status} ${await response.text()}`);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

async function call(principal, cookie, path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())) headers.set('x-wiobr-request', '1');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  let body = '';
  try {
    body = (await response.text()).slice(0, 220);
  } catch {
    body = '<unreadable>';
  }
  const row = { principal, method: (options.method || 'GET').toUpperCase(), path, status: response.status, body };
  results.push(row);
  return row;
}

function report(row) {
  const flag = row.status >= 500 ? '  <== 5xx' : '';
  console.log(`${String(row.status).padEnd(3)} ${row.principal.padEnd(9)} ${row.method.padEnd(6)} ${row.path.padEnd(46)} ${row.body.replace(/\s+/g, ' ').slice(0, 80)}${flag}`);
}

dataDir = await mkdtemp(join(tmpdir(), 'wiobr-rbac-probe-'));
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  NODE_ENV: 'test',
  SECURE_COOKIES: 'false',
  HOST: '127.0.0.1',
  PORT: String(await freePort()),
  LOG_LEVEL: 'warn',
};
execFileSync(process.execPath, ['--input-type=module', '-e', `
  import { db } from './server/db.js';
  import { hashPassword } from './server/auth/password.js';
  const hash = await hashPassword(${JSON.stringify(adminPassword)});
  db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?,?,?)').run('probe-admin', hash, 'admin');
  db.close();
`], { cwd: process.cwd(), env, stdio: 'pipe' });
baseUrl = `http://127.0.0.1:${env.PORT}`;
child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stderr += chunk; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
await waitForServer();

try {
  console.log('=== Phase 1: account setup ===');
  const adminCookie = await login('probe-admin', adminPassword);

  const createMember = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wiobr-request': '1', cookie: adminCookie },
    body: JSON.stringify({ username: 'probe-member-one', password: memberPassword, role: 'member' }),
  });
  const memberOneId = (await createMember.json()).id;
  console.log(`member-one created: id=${memberOneId} status=${createMember.status}`);

  const createMember2 = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wiobr-request': '1', cookie: adminCookie },
    body: JSON.stringify({ username: 'probe-member-two', password: memberPassword, role: 'member' }),
  });
  const memberTwoId = (await createMember2.json()).id;
  console.log(`member-two created: id=${memberTwoId} status=${createMember2.status}`);

  const memberCookie = await login('probe-member-one', memberPassword);
  const otherCookie = await login('probe-member-two', memberPassword);
  console.log('logins ok\n');

  const GETS = [
    '/api/health', '/api/ready', '/api/auth/me', '/api/auth/sessions',
    '/api/members', '/api/chat', '/api/workspaces', '/api/storage',
    '/api/search/history', '/api/tasks', '/api/tasks/status',
    '/api/privacy/settings', '/api/privacy/cloud-ip', '/api/extensions',
    '/api/extensions/admin/catalog',
    '/api/admin/users', '/api/admin/audit-logs', '/api/admin/search-history',
    '/api/admin/technical-logs', '/api/admin/runtime',
  ];

  console.log('=== Phase 2: anonymous access to every endpoint ===');
  for (const path of GETS) report(await call('anon', null, path));

  console.log('\n=== Phase 3: member access to every endpoint ===');
  for (const path of GETS) report(await call('member', memberCookie, path));

  console.log('\n=== Phase 4: admin access to every endpoint (baseline) ===');
  for (const path of GETS) report(await call('admin', adminCookie, path));

  console.log('\n=== Phase 5: member attempts state-changing admin operations ===');
  report(await call('member', memberCookie, '/api/admin/users', { method: 'POST', body: JSON.stringify({ username: 'probe-escalated', password: 'probe-escalated-password-99', role: 'admin' }) }));
  report(await call('member', memberCookie, `/api/admin/users/${memberTwoId}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) }));
  report(await call('member', memberCookie, `/api/admin/users/${memberOneId}/revoke-sessions`, { method: 'POST', body: JSON.stringify({}) }));
  report(await call('member', memberCookie, '/api/admin/search-history', { method: 'DELETE', body: JSON.stringify({ before: '2999-01-01T00:00:00.000Z', confirm: true }) }));
  report(await call('member', memberCookie, '/api/admin/technical-logs', { method: 'DELETE', body: JSON.stringify({ before: '2999-01-01T00:00:00.000Z', confirm: true }) }));
  report(await call('member', memberCookie, '/api/admin/runtime', { method: 'PUT', body: JSON.stringify({ alwaysOnEnabled: false }) }));
  report(await call('member', memberCookie, '/api/extensions/admin/catalog', { method: 'POST', body: JSON.stringify({ name: 'probe', version: '1.0.0', description: 'x', sourceUrl: 'https://example.org/x', permissions: [] }) }));
  report(await call('member', memberCookie, '/api/extensions/admin/catalog/1', { method: 'DELETE' }));

  console.log('\n=== Phase 6: cross-member isolation (member-one vs member-two) ===');
  const ws = await call('member', memberCookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'member-one-ws', tabs: [], activeTab: 0 }) });
  let wsId = null;
  try { wsId = JSON.parse(ws.body).id; } catch { wsId = null; }
  console.log(`workspace id = ${wsId}`);
  if (wsId) {
    report(await call('other', otherCookie, `/api/workspaces/${wsId}`, { method: 'PUT', headers: { 'if-match': '1' }, body: JSON.stringify({ name: 'stolen', tabs: [], activeTab: 0 }) }));
    report(await call('other', otherCookie, `/api/workspaces/${wsId}/duplicate`, { method: 'POST', body: JSON.stringify({ name: 'dup' }) }));
    report(await call('other', otherCookie, `/api/workspaces/${wsId}`, { method: 'DELETE' }));
  }

  const note = await call('member', memberCookie, '/api/storage', { method: 'POST', body: JSON.stringify({ kind: 'note', name: 'secret-note', content: 'member-one secret' }) });
  let noteId = null;
  try { noteId = JSON.parse(note.body).id; } catch { noteId = null; }
  console.log(`storage item id = ${noteId}`);
  if (noteId) {
    report(await call('other', otherCookie, `/api/storage/${noteId}`, { method: 'DELETE' }));
    report(await call('other', otherCookie, `/api/storage/${noteId}/download`));
    report(await call('other', otherCookie, '/api/storage', { method: 'PATCH', body: JSON.stringify({ id: noteId, name: 'renamed' }) }));
  }

  const task = await call('member', memberCookie, '/api/tasks', { method: 'POST', body: JSON.stringify({ name: 'probe-monitor', url: 'https://example.org/', type: 'monitor' }) });
  let taskId = null;
  try { taskId = JSON.parse(task.body || '{}').task?.id ?? JSON.parse(task.body || '{}').id ?? null; } catch { taskId = null; }
  console.log(`task id = ${taskId} (status ${task.status})`);
  if (taskId) {
    report(await call('other', otherCookie, `/api/tasks/${taskId}/logs`));
    report(await call('other', otherCookie, `/api/tasks/${taskId}/stop`, { method: 'POST', body: JSON.stringify({}) }));
    report(await call('other', otherCookie, `/api/tasks/${taskId}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }));
  }

  console.log('\n=== Phase 7: session/auth lifecycle ===');
  report(await call('anon', null, '/api/auth/me', { headers: { cookie: 'wiobr_session=' + 'f'.repeat(64) } }));
  report(await call('member', memberCookie, '/api/auth/sessions'));
  const disabled = await fetch(`${baseUrl}/api/admin/users/${memberTwoId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-wiobr-request': '1', cookie: adminCookie },
    body: JSON.stringify({ disabled: true }),
  });
  console.log(`disable member-two: ${disabled.status}`);
  report(await call('disabled', otherCookie, '/api/auth/me'));
  report(await call('disabled', otherCookie, '/api/admin/users'));

  console.log('\n=== Phase 8: role-change propagation ===');
  await fetch(`${baseUrl}/api/admin/users/${memberTwoId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-wiobr-request': '1', cookie: adminCookie },
    body: JSON.stringify({ disabled: false }),
  });
  const promoted = await fetch(`${baseUrl}/api/admin/users/${memberTwoId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-wiobr-request': '1', cookie: adminCookie },
    body: JSON.stringify({ role: 'admin' }),
  });
  console.log(`promote member-two to admin: ${promoted.status}`);
  report(await call('promoted', otherCookie, '/api/admin/users'));
} catch (error) {
  console.error('PROBE ERROR:', error instanceof Error ? error.stack : String(error));
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 12_000))]);
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (stderr.trim()) console.log('\n--- server stderr ---\n' + stderr.trim().slice(0, 4000));
}

console.log('\n=== Machine-readable summary ===');
console.log(JSON.stringify(results.map(({ principal, method, path, status }) => ({ principal, method, path, status }))));
