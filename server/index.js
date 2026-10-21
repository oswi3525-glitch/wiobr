import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { config } from './config.js';
import { db, technicalLog } from './db.js';
import { logger } from './logger.js';
import { requireSameOrigin } from './middleware/auth.js';
import { setMonitorEnabled, startMonitorService, stopMonitorService } from './services/monitor.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import healthRoutes from './routes/health.js';
import searchRoutes from './routes/search.js';
import collaborationRoutes from './routes/collaboration.js';
import storageRoutes from './routes/storage.js';
import taskRoutes from './routes/tasks.js';
import privacyRoutes from './routes/privacy.js';
import extensionRoutes from './routes/extensions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const app = express();
const server = createServer(app);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
const clients = new Map();
const clientsByUser = new Map();
const CHAT_WINDOW_MS = 60_000;
const CHAT_MESSAGE_LIMIT = 10;

app.set('trust proxy', config.trustProxyHops);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '256kb', strict: true }));
app.use(cookieParser());
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && config.corsOrigin && origin === config.corsOrigin) {
    res.set('Access-Control-Allow-Origin', config.corsOrigin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-WioBr-Request, If-Match');
    res.vary('Origin');
  }
  if (req.method === 'OPTIONS' && origin === config.corsOrigin && config.corsOrigin) return res.status(204).end();
  next();
});

app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));
app.use('/api', requireSameOrigin);
app.locals.db = db;
app.locals.monitor = { setMonitorEnabled };

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/search', searchRoutes);
app.use('/api', collaborationRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/privacy', privacyRoutes);
app.use('/api/extensions', extensionRoutes);
app.use('/api', healthRoutes);

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 4096,
  perMessageDeflate: false,
});

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function validWebSocketOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.host === req.headers.host) return true;
    return Boolean(config.corsOrigin && parsed.origin === config.corsOrigin);
  } catch {
    return false;
  }
}

function send(ws, payload) {
  if (ws.readyState !== 1 || ws.bufferedAmount > 1_000_000) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function broadcast(payload) {
  for (const ws of clients.keys()) send(ws, payload);
}

function updatePresence(userId) {
  const sockets = clientsByUser.get(userId);
  const activeSessions = new Set([...sockets || []].map((ws) => clients.get(ws)?.sessionId).filter(Boolean)).size;
  const status = !sockets?.size ? 'offline' : [...sockets].some((ws) => !clients.get(ws)?.idle) ? 'online' : 'idle';
  db.prepare(`
    INSERT INTO online_presence(user_id, status, last_heartbeat_at, active_sessions, updated_at)
    VALUES (?,?,datetime('now'),?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET status = excluded.status,
      last_heartbeat_at = excluded.last_heartbeat_at,
      active_sessions = excluded.active_sessions, updated_at = excluded.updated_at
  `).run(userId, status, activeSessions);
}

wss.on('connection', (ws, req) => {
  if (clients.size >= 200 || !validWebSocketOrigin(req)) {
    ws.close(1008, 'connection rejected');
    return;
  }
  const sid = readCookie(req.headers.cookie, config.sessionCookieName);
  const session = sid && /^[a-f0-9]{64}$/i.test(sid)
    ? db.prepare('SELECT id, user_id, expires_at FROM sessions WHERE id = ? AND revoked = 0').get(sid)
    : null;
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    ws.close(1008, 'unauthorized');
    return;
  }
  const user = db.prepare('SELECT id, username, disabled FROM users WHERE id = ?').get(session.user_id);
  if (!user || user.disabled) {
    ws.close(1008, 'unauthorized');
    return;
  }

  const client = { userId: user.id, username: user.username, sessionId: session.id, chatTimes: [], idle: false, lastHeartbeatAt: Date.now() };
  clients.set(ws, client);
  if (!clientsByUser.has(user.id)) clientsByUser.set(user.id, new Set());
  clientsByUser.get(user.id).add(ws);
  updatePresence(user.id);
  send(ws, { type: 'hello', user: { id: user.id, username: user.username } });

  ws.on('message', (raw) => {
    const current = clients.get(ws);
    if (!current) return;
    const activeSession = db.prepare('SELECT id FROM sessions WHERE id = ? AND revoked = 0 AND expires_at > ?')
      .get(current.sessionId, new Date().toISOString());
    if (!activeSession) {
      ws.close(1008, 'session expired');
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', error: 'invalid message' });
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'heartbeat') {
      current.idle = message.idle === true;
      current.lastHeartbeatAt = Date.now();
      updatePresence(current.userId);
      send(ws, { type: 'heartbeat-ack', ts: Date.now() });
      return;
    }
    if (message.type === 'chat') {
      const now = Date.now();
      current.chatTimes = current.chatTimes.filter((time) => now - time < CHAT_WINDOW_MS);
      if (current.chatTimes.length >= CHAT_MESSAGE_LIMIT) {
        send(ws, { type: 'error', error: 'message rate limit reached; try again shortly' });
        return;
      }
      if (typeof message.content !== 'string' || message.content.length > 2000) {
        send(ws, { type: 'error', error: 'message must be 1-2,000 characters' });
        return;
      }
      const content = message.content.trim();
      if (!content) return;
      current.chatTimes.push(now);
      const info = db.prepare("INSERT INTO chat_messages(room, user_id, content) VALUES ('global',?,?)")
        .run(current.userId, content);
      const row = db.prepare(`
        SELECT m.id, m.user_id AS userId, u.username, m.content, m.created_at AS createdAt
        FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?
      `).get(info.lastInsertRowid);
      broadcast({ type: 'chat', message: row });
    }
  });

  ws.on('close', () => {
    const current = clients.get(ws);
    if (!current) return;
    clients.delete(ws);
    const sockets = clientsByUser.get(current.userId);
    sockets?.delete(ws);
    if (!sockets?.size) clientsByUser.delete(current.userId);
    updatePresence(current.userId);
  });

  ws.on('error', (error) => {
    logger.warn({ code: error.code || 'WEBSOCKET_ERROR' }, 'websocket connection error');
  });
});

const presenceSweeper = setInterval(() => {
  const cutoff = Date.now() - 90_000;
  for (const ws of clients.keys()) {
    const client = clients.get(ws);
    if (!client) continue;
    if (client.lastHeartbeatAt < cutoff) {
      ws.close(1001, 'heartbeat timeout');
    }
  }
  db.prepare(`
    UPDATE online_presence SET status = 'offline', active_sessions = 0, updated_at = datetime('now')
    WHERE status IN ('online','idle') AND (last_heartbeat_at IS NULL OR last_heartbeat_at < datetime('now','-90 seconds'))
  `).run();
}, 30_000);
presenceSweeper.unref?.();

const retentionSweeper = setInterval(() => {
  try {
    const cleanup = db.transaction(() => {
      db.prepare("DELETE FROM search_history WHERE created_at < datetime('now','-90 days')").run();
      db.prepare("DELETE FROM technical_logs WHERE created_at < datetime('now','-30 days')").run();
      db.prepare("DELETE FROM chat_messages WHERE created_at < datetime('now','-180 days')").run();
      db.prepare("DELETE FROM always_on_checks WHERE checked_at < datetime('now','-30 days')").run();
      db.prepare("DELETE FROM login_attempts WHERE created_at < datetime('now','-30 days')").run();
      db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now','-30 days') OR (revoked = 1 AND last_seen_at < datetime('now','-30 days'))").run();
      db.prepare("DELETE FROM audit_logs WHERE created_at < datetime('now','-365 days')").run();
      const expiredFiles = db.prepare("SELECT storage_path FROM storage_items WHERE expires_at IS NOT NULL AND expires_at < datetime('now') AND storage_path IS NOT NULL").all();
      const expired = db.prepare("DELETE FROM storage_items WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
      if (expired.changes) {
        db.prepare(`
          INSERT INTO audit_logs(actor_user_id, action, target_type, scope, metadata)
          VALUES (NULL, 'retention_cleanup', 'retention', 'expired_storage', ?)
        `).run(JSON.stringify({ deletedCount: expired.changes }));
      }
      return { expiredFiles, expiredCount: expired.changes };
    });
    const result = cleanup();
    for (const file of result.expiredFiles) {
      try {
        unlinkSync(resolve(config.storageDir, file.storage_path));
      } catch (error) {
        if (error.code !== 'ENOENT') logger.error({ code: error.code || 'STORAGE_CLEANUP_ERROR' }, 'expired file cleanup failed');
      }
    }
    if (result.expiredCount) logger.info({ expiredCount: result.expiredCount }, 'expired storage items removed');
  } catch (error) {
    logger.error({ code: error.code || 'RETENTION_ERROR' }, 'retention cleanup failed');
  }
}, 60 * 60 * 1000);
retentionSweeper.unref?.();

db.prepare("UPDATE online_presence SET status = 'offline', active_sessions = 0, updated_at = datetime('now')").run();
startMonitorService();

const distDir = resolve(root, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir, { index: false, maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));
  app.get('/{*path}', (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return res.status(404).end();
    res.sendFile(resolve(distDir, 'index.html'));
  });
}

app.use((error, req, res, _next) => {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  logger.error({ status, path: req.path, method: req.method, code: error.code || 'REQUEST_ERROR' }, 'request failed');
  if (status >= 500) {
    try {
      technicalLog('error', 'request failed', { path: req.path, method: req.method, code: error.code || 'REQUEST_ERROR' });
    } catch {
      logger.error({ code: 'TECHNICAL_LOG_FAILURE' }, 'unable to persist request error');
    }
  }
  if (res.headersSent) return;
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'request body is too large' });
  res.status(status).json({ error: status === 500 ? 'internal server error' : error.message });
});

server.listen(config.port, config.host, () => {
  logger.info({ port: config.port, host: config.host }, 'WioBrowse server listening');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'server shutdown started');
  clearInterval(presenceSweeper);
  clearInterval(retentionSweeper);
  stopMonitorService();
  for (const ws of clients.keys()) ws.close(1001, 'server shutting down');
  wss.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
