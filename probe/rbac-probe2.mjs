/**
 * RBAC / authorization probe, part 2.
 *
 * Complements rbac-probe.mjs (which covers the broad endpoint matrix) with
 * targeted, schema-exact checks:
 *   A. Role promotion semantics: does an *existing* session observe a new role?
 *   B. WebSocket authentication / authorization (origin, cookie, disabled user).
 *   C. Cross-user isolation with the real payload shapes for storage, tasks,
 *      extensions and collaboration.
 *   D. Outbound DNS / SSRF guards on Website Monitor task creation.
 *
 * Usage: node probe/rbac-probe2.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const adminPassword = 'probe2-admin-password-1234';
const memberPassword = 'probe2-member-password-1234';
const results = [];
let dataDir;
let baseUrl;
let child;
let serverLog = '';

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
    if (child.exitCode !== null) throw new Error(`server exited early: ${serverLog}`);
    try {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (response.ok) return;
      last = `${response.status} ${await response.text()}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server never became ready (${baseUrl}; ${last}): ${serverLog}`);
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
  console.log(`${String(row.status).padEnd(3)} ${row.principal.padEnd(10)} ${row.method.padEnd(6)} ${row.path.padEnd(40)} ${row.body.replace(/\s+/g, ' ').slice(0, 90)}${flag}`);
}

async function adminPatch(adminCookie, id, payload) {
  return fetch(`${baseUrl}/api/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-wiobr-request': '1', cookie: adminCookie },
    body: JSON.stringify(payload),
  });
}

function openSocket(cookie, { origin = null } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (origin !== null) headers.origin = origin;
    const ws = new WebSocket(`ws://127.0.0.1:${baseUrl.split(':').pop()}/ws`, { headers });
    const outcome = { closed: false, code: null, reason: null, messages: [] };
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 6_000);
    ws.on('message', (data) => {
      try {
        outcome.messages.push(JSON.parse(data.toString()));
      } catch {
        outcome.messages.push({ raw: data.toString() });
      }
    });
    ws.on('close', (code, reason) => {
      outcome.closed = true;
      outcome.code = code;
      outcome.reason = reason?.toString();
      clearTimeout(timer);
      resolve(outcome);
    });
    ws.on('error', (error) => {
      outcome.error = error.message;
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}


dataDir = await mkdtemp(join(tmpdir(), 'wiobr-rbac-probe2-'));
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
  db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?,?,?)').run('probe2-admin', hash, 'admin');
  db.close();
`], { cwd: process.cwd(), env, stdio: 'pipe' });
baseUrl = `http://127.0.0.1:${env.PORT}`;
child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { serverLog += chunk; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { serverLog += chunk; });
await waitForServer();

try {
  console.log('=== Setup ===');
  const adminCookie = await login('probe2-admin', adminPassword);
  const createMember = async (username) => {
    const response = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wiobr-request': '1', cookie: adminCookie },
      body: JSON.stringify({ username, password: memberPassword, role: 'member' }),
    });
    return (await response.json()).id;
  };
  const memberOneId = await createMember('probe2-member-one');
  const memberTwoId = await createMember('probe2-member-two');
  const memberCookie = await login('probe2-member-one', memberPassword);
  const otherCookie = await login('probe2-member-two', memberPassword);
  console.log(`member-one id=${memberOneId} member-two id=${memberTwoId}\n`);

  console.log('=== Phase A: role promotion vs existing session ===');
  const before = await call('member2(before)', otherCookie, '/api/auth/me');
  console.log(`before promotion role: ${before.body}`);
  const promote = await adminPatch(adminCookie, memberTwoId, { role: 'admin' });
  console.log(`admin promotes member-two -> admin: ${promote.status}`);
  const afterExisting = await call('member2(same-session)', otherCookie, '/api/auth/me');
  console.log(`same session role after promotion: ${afterExisting.body}`);
  const adminAfterExisting = await call('member2(same-session)', otherCookie, '/api/admin/users');
  console.log(`same session admin access after promotion: ${adminAfterExisting.status}`);
  const freshCookie = await login('probe2-member-two', memberPassword);
  const afterFresh = await call('member2(fresh-login)', freshCookie, '/api/auth/me');
  console.log(`fresh login role after promotion: ${afterFresh.body}`);
  const adminAfterFresh = await call('member2(fresh-login)', freshCookie, '/api/admin/users');
  console.log(`fresh login admin access after promotion: ${adminAfterFresh.status}`);
  console.log('');

  console.log('=== Phase B: demotion takes effect on existing session ===');
  const demote = await adminPatch(adminCookie, memberTwoId, { role: 'member' });
  console.log(`admin demotes member-two -> member: ${demote.status}`);
  const afterDemote = await call('member2(after-demote)', freshCookie, '/api/admin/users');
  console.log(`existing session admin access after demotion: ${afterDemote.status}`);
  console.log('');

  console.log('=== Phase C: WebSocket authentication / authorization ===');
  const wsNoCookie = await openSocket(null, { origin: baseUrl });
  console.log(`ws no cookie      -> closed=${wsNoCookie.closed} code=${wsNoCookie.code} reason=${wsNoCookie.reason}`);
  const wsBadCookie = await openSocket('wiobr_session=' + 'f'.repeat(64), { origin: baseUrl });
  console.log(`ws bad cookie     -> closed=${wsBadCookie.closed} code=${wsBadCookie.code} reason=${wsBadCookie.reason}`);
  const wsNoOrigin = await openSocket(memberCookie, { origin: null });
  console.log(`ws no origin      -> closed=${wsNoOrigin.closed} code=${wsNoOrigin.code} reason=${wsNoOrigin.reason}`);
  const wsForeign = await openSocket(memberCookie, { origin: 'https://evil.example' });
  console.log(`ws foreign origin -> closed=${wsForeign.closed} code=${wsForeign.code} reason=${wsForeign.reason}`);
  const wsMember = await openSocket(memberCookie, { origin: baseUrl });
  console.log(`ws member valid   -> closed=${wsMember.closed} code=${wsMember.code} messages=${JSON.stringify(wsMember.messages).slice(0, 120)}`);
  console.log('');
  console.log('=== Phase D: cross-user isolation with real schemas ===');
  // Storage: item created by member-one, accessed by member-two.
  const note = await call('member1', memberCookie, '/api/storage', {
    method: 'POST',
    body: JSON.stringify({ kind: 'note', name: 'member1-note', content: 'member-one secret' }),
  });
  const noteId = JSON.parse(note.body).id;
  console.log(`member1 created storage item id=${noteId} status=${note.status}`);
  report(await call('member2', otherCookie, `/api/storage/${noteId}`));
  report(await call('member2', otherCookie, `/api/storage/${noteId}`, { method: 'PATCH', body: JSON.stringify({ name: 'hijacked' }) }));
  report(await call('member2', otherCookie, `/api/storage/${noteId}`, { method: 'DELETE' }));
  report(await call('member2', otherCookie, `/api/storage/${noteId}/download`));
  report(await call('member2', otherCookie, `/api/storage?parentId=${noteId}`));

  // Tasks: monitor created by member-one, actions attempted by member-two.
  const task = await (await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wiobr-request': '1', cookie: memberCookie },
    body: JSON.stringify({ name: 'probe2-monitor', url: 'https://example.org/', type: 'monitor' }),
  })).json().catch(() => ({}));
  const taskId = task?.task?.id ?? null;
  console.log(`member1 created task id=${taskId} status=${task?.task ? 'created' : JSON.stringify(task).slice(0, 120)}`);
  if (taskId) {
    report(await call('member2', otherCookie, `/api/tasks/${taskId}/logs`));
    report(await call('member2', otherCookie, `/api/tasks/${taskId}/stop`, { method: 'POST', body: JSON.stringify({}) }));
    report(await call('member2', otherCookie, `/api/tasks/${taskId}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }));
    report(await call('member1', memberCookie, `/api/tasks/${taskId}/logs`));
  }

  // Extensions: per-user enablement must not leak across users.
  report(await call('member1', memberCookie, '/api/extensions'));
  const extPatch = await call('member1', memberCookie, '/api/extensions/1', { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
  console.log(`member1 enables extension 1: ${extPatch.status} ${extPatch.body}`);
  report(await call('member2', otherCookie, '/api/extensions'));

  // Collaboration: workspace isolation with the exact if-match/version contract.
  const ws = await call('member1', memberCookie, '/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: 'member1-ws', tabs: [{ url: 'https://example.org/', title: 'Example' }], activeTab: 0, theme: 'dark' }),
  });
  const wsId = ws.status === 201 ? JSON.parse(ws.body).id : null;
  console.log(`member1 created workspace id=${wsId} status=${ws.status}`);
  report(await call('member2', otherCookie, `/api/workspaces/${wsId}/duplicate`, { method: 'POST', body: JSON.stringify({ name: 'dup' }) }));
  report(await call('member2', otherCookie, `/api/workspaces/${wsId}`, { method: 'DELETE' }));
  report(await call('member2', otherCookie, `/api/workspaces/${wsId}`, { method: 'PUT', headers: { 'if-match': '1' }, body: JSON.stringify({ name: 'stolen', tabs: [], activeTab: 0, theme: 'dark' }) }));

  report(await call('member1', memberCookie, '/api/workspaces'));
  console.log('');

  console.log('=== Phase E: outbound DNS / SSRF guards on Website Monitor ===');
  const ssrfUrls = [
    ['http://127.0.0.1/', 'loopback literal'],
    ['http://localhost/', 'localhost name'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata IP'],
    ['http://10.0.0.5/', 'private 10/8'],
    ['http://192.168.1.1/', 'private 192.168/16'],
    ['http://[::1]/', 'ipv6 literal'],
    ['http://example.com:8080/', 'non-standard port'],
    ['https://user:pass@example.com/', 'embedded credentials'],
    ['file:///etc/passwd', 'non-http scheme'],
  ];
  for (const [url, label] of ssrfUrls) {
    const row = await call('member1', memberCookie, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ name: `ssrf-${label}`, url, type: 'monitor' }),
    });
    console.log(`  ${String(row.status).padEnd(3)} ${label.padEnd(22)} ${url.padEnd(40)} ${row.body.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  const persistent = await call('member1', memberCookie, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ name: 'persistent', url: 'https://example.org/', type: 'persistent' }),
  });
  console.log(`  ${String(persistent.status).padEnd(3)} persistent task type       ${persistent.body.replace(/\s+/g, ' ').slice(0, 110)}`);
  console.log('');

  console.log('=== Phase F: same-origin enforcement on state-changing requests ===');
  report(await call('member1', memberCookie, '/api/storage', {
    method: 'POST',
    headers: { 'x-wiobr-request': '0' },
    body: JSON.stringify({ kind: 'note', name: 'x', content: 'y' }),
  }));
  report(await call('member1', memberCookie, '/api/storage', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'x-wiobr-request': '1' },
    body: JSON.stringify({ kind: 'note', name: 'x', content: 'y' }),
  }));
  report(await call('member1', memberCookie, '/api/privacy/settings', {
    method: 'PUT',
    headers: { origin: 'https://evil.example', 'x-wiobr-request': '1' },
    body: JSON.stringify({ cleanTracking: false }),
  }));
  console.log('');

  const wsMember2 = await openSocket(memberCookie, { origin: baseUrl });
  console.log(`ws member valid   -> closed=${wsMember2.closed} code=${wsMember2.code} messages=${JSON.stringify(wsMember2.messages).slice(0, 120)}`);
  console.log('');

  console.log('=== Machine-readable summary ===');
  console.log(JSON.stringify(results));

  const serverErrors = serverLog.split('\n').filter((line) => /error|ERROR|5\d\d/.test(line));
  if (serverErrors.length) {
    console.log('\n=== Server log lines mentioning errors ===');
    for (const line of serverErrors.slice(0, 40)) console.log(line);
  } else {
    console.log('\nNo error lines in server log.');
  }
} catch (error) {
  console.error(`PROBE FAILED: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
} finally {
  if (child) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 12_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

