import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import WebSocket from 'ws';

const adminPassword = 'correct-horse-battery-admin-1';
const memberPassword = 'correct-horse-battery-member-1';
let dataDir;
let baseUrl;
let devServer;
let devUrl;
let child;
let stderr = '';

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  let lastResponse = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (response.ok) return;
      lastResponse = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastResponse = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not become ready (${baseUrl}; ${lastResponse}): ${stderr}`);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wiobr-integration-'));
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    NODE_ENV: 'test',
    SECURE_COOKIES: 'false',
    HOST: '127.0.0.1',
    PORT: String(await freePort()),
    LOG_LEVEL: 'info',
  };
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { db } from './server/db.js';
    import { hashPassword } from './server/auth/password.js';
    const hash = await hashPassword(${JSON.stringify(adminPassword)});
    db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?,?,?)').run('root-admin', hash, 'admin');
    db.close();
  `], { cwd: process.cwd(), env, stdio: 'pipe' });
  baseUrl = `http://127.0.0.1:${env.PORT}`;
  child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stderr += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitForServer();

  const originalHost = process.env.HOST;
  const originalPort = process.env.PORT;
  process.env.HOST = env.HOST;
  process.env.PORT = env.PORT;
  try {
    devServer = await createViteServer({
      configFile: join(process.cwd(), 'vite.config.ts'),
      server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
    });
    await devServer.listen();
    devUrl = `http://127.0.0.1:${devServer.httpServer.address().port}`;
  } finally {
    if (originalHost === undefined) delete process.env.HOST;
    else process.env.HOST = originalHost;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  }
});

after(async () => {
  if (devServer) await devServer.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 12_000)),
    ]);
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wiobr-request': '1' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

async function request(path, cookie, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

test('development proxy allows same-origin login requests through Vite', async () => {
  const response = await fetch(`${devUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: devUrl,
      'content-type': 'application/json',
      'x-wiobr-request': '1',
    },
    body: JSON.stringify({ username: 'root-admin', password: adminPassword }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.user.role, 'admin');
  assert.match(response.headers.get('set-cookie'), /wiobr_session=/);
});

test('auth enforces CSRF, admin roles, workspace ownership and session revocation', async () => {
  const adminCookie = await login('root-admin', adminPassword);
  const noCsrf = await request('/api/workspaces', adminCookie, {
    method: 'POST',
    body: JSON.stringify({ name: 'blocked', tabs: [], activeTab: 0 }),
  });
  assert.equal(noCsrf.status, 403);

  const createMember = await request('/api/admin/users', adminCookie, {
    method: 'POST',
    headers: { 'x-wiobr-request': '1' },
    body: JSON.stringify({ username: 'member-one', password: memberPassword, role: 'member' }),
  });
  assert.equal(createMember.status, 201);
  const memberId = (await createMember.json()).id;
  const createSecondMember = await request('/api/admin/users', adminCookie, {
    method: 'POST',
    headers: { 'x-wiobr-request': '1' },
    body: JSON.stringify({ username: 'member-two', password: memberPassword, role: 'member' }),
  });
  assert.equal(createSecondMember.status, 201);

  const memberCookie = await login('member-one', memberPassword);
  const secondCookie = await login('member-two', memberPassword);
  const forbidden = await request('/api/admin/users', memberCookie);
  assert.equal(forbidden.status, 403);

  const workspaceResponse = await request('/api/workspaces', memberCookie, {
    method: 'POST',
    headers: { 'x-wiobr-request': '1' },
    body: JSON.stringify({ name: 'Private work', tabs: [], activeTab: 0 }),
  });
  assert.equal(workspaceResponse.status, 201);
  const workspace = await workspaceResponse.json();
  const stolenWorkspace = await request(`/api/workspaces/${workspace.id}`, secondCookie, {
    method: 'PUT',
    headers: { 'x-wiobr-request': '1', 'if-match': '1' },
    body: JSON.stringify({ name: 'Taken', tabs: [], activeTab: 0 }),
  });
  assert.equal(stolenWorkspace.status, 404);
  const otherList = await (await request('/api/workspaces', secondCookie)).json();
  assert.equal(otherList.workspaces.length, 0);

  const nextMemberCookie = await login('member-one', memberPassword);
  const revoke = await request('/api/auth/sessions/revoke-others', nextMemberCookie, {
    method: 'POST',
    headers: { 'x-wiobr-request': '1' },
    body: JSON.stringify({}),
  });
  assert.equal(revoke.status, 204);
  assert.equal((await request('/api/auth/me', memberCookie)).status, 401);
  assert.equal((await request('/api/auth/me', nextMemberCookie)).status, 200);
  assert.ok(memberId > 0);
});

test('storage is owner-scoped and monitor rejects local targets', async () => {
  const ownerCookie = await login('member-one', memberPassword);
  const otherCookie = await login('member-two', memberPassword);
  const upload = await request('/api/storage/upload?name=private.txt', ownerCookie, {
    method: 'POST',
    headers: { 'x-wiobr-request': '1', 'content-type': 'application/octet-stream' },
    body: 'owner-only file',
  });
  assert.equal(upload.status, 201);
  const items = await (await request('/api/storage', ownerCookie)).json();
  const file = items.items.find((item) => item.kind === 'file');
  assert.ok(file);
  assert.equal((await request(`/api/storage/${file.id}/download`, otherCookie)).status, 404);
  const invalidTask = await request('/api/tasks', ownerCookie, {
    method: 'POST',
    headers: { 'x-wiobr-request': '1' },
    body: JSON.stringify({ name: 'local target', url: 'http://127.0.0.1', type: 'monitor' }),
  });
  assert.equal(invalidTask.status, 400);
  assert.equal((await invalidTask.json()).error, 'private and reserved IP addresses are not allowed');

  const persistentTask = await request('/api/tasks', ownerCookie, {
    method: 'POST',
    headers: { 'x-wiobr-request': '1' },
    body: JSON.stringify({ name: 'persistent process', url: 'https://example.com', type: 'persistent' }),
  });
  assert.equal(persistentTask.status, 422);
  assert.match((await persistentTask.json()).error, /Persistent Web Task is unavailable/);
  const tasks = await (await request('/api/tasks', ownerCookie)).json();
  assert.equal(tasks.tasks.length, 0);
});

test('chat persists server-side messages and read access requires authentication', async () => {
  const cookie = await login('member-one', memberPassword);
  assert.equal((await request('/api/chat')).status, 401);
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`, {
    headers: { origin: baseUrl, cookie },
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`WebSocket handshake timed out: ${stderr}`)), 5_000);
      ws.once('message', (data) => {
        clearTimeout(timeout);
        const message = JSON.parse(data.toString());
        if (message.type === 'hello') resolve();
        else reject(new Error('Expected chat handshake'));
      });
      ws.once('error', reject);
    });
    const received = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chat message echo timed out')), 5_000);
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'chat' && message.message?.content === 'persist this message') {
          clearTimeout(timeout);
          resolve(message.message);
        }
      });
    });
    ws.send(JSON.stringify({ type: 'chat', content: 'persist this message' }));
    const echoed = await received;
    assert.equal(echoed.username, 'member-one');
    const history = await (await request('/api/chat', cookie)).json();
    assert.ok(history.messages.some((message) => message.id === echoed.id));
  } finally {
    ws.close();
  }
});
