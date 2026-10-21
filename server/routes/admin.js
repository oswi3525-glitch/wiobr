import { Router } from 'express';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { revokeAllUserSessions } from '../auth/session.js';
import { db, auditLog } from '../db.js';
import { requireAuth, requireRole, requireSameOrigin } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));
router.use(requireSameOrigin);

const createSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(12).max(256),
  role: z.enum(['admin', 'member']).default('member'),
});

router.get('/users', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.role, u.disabled, u.created_at, u.updated_at,
      COUNT(CASE WHEN s.revoked = 0 AND s.expires_at > datetime('now') THEN 1 END) AS active_sessions
    FROM users u LEFT JOIN sessions s ON s.user_id = u.id
    GROUP BY u.id ORDER BY u.id
  `).all();
  res.json({ users: rows });
});

router.post('/users', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });
  const { username, password, role } = parsed.data;
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'username taken' });
  const hash = await hashPassword(password);
  const info = db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?,?,?)').run(username, hash, role);
  auditLog({ actorUserId: req.user.id, action: 'create_user', targetType: 'user', targetId: String(info.lastInsertRowid), metadata: { username, role } });
  res.status(201).json({ id: info.lastInsertRowid });
});

const updateSchema = z.object({
  disabled: z.boolean().optional(),
  role: z.enum(['admin', 'member']).optional(),
  password: z.string().min(12).max(256).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

router.patch('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const { disabled, role, password } = parsed.data;
  if (disabled !== undefined) {
    if (id === req.user.id && disabled) return res.status(400).json({ error: 'cannot disable the current admin account' });
  }
  if (role !== undefined) {
    if (id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'cannot remove your own admin role' });
  }
  const nextDisabled = disabled ?? Boolean(user.disabled);
  const nextRole = role ?? user.role;
  if (user.role === 'admin' && !user.disabled && (nextDisabled || nextRole !== 'admin')) {
    const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get().count;
    if (activeAdmins <= 1) return res.status(409).json({ error: 'the last active admin cannot be disabled or demoted' });
  }
  const updateUser = db.transaction(() => {
    if (disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ?, updated_at = datetime(\'now\') WHERE id = ?').run(disabled ? 1 : 0, id);
    }
    if (role !== undefined) {
      db.prepare('UPDATE users SET role = ?, updated_at = datetime(\'now\') WHERE id = ?').run(role, id);
    }
    if (password !== undefined) {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(passwordHash, id);
      revokeAllUserSessions(id);
    }
    if (disabled === true) revokeAllUserSessions(id);
    auditLog({
      actorUserId: req.user.id,
      action: 'update_user',
      targetType: 'user',
      targetId: String(id),
      metadata: { disabled, role, passwordChanged: password !== undefined },
    });
  });
  let passwordHash;
  if (password !== undefined) {
    passwordHash = await hashPassword(password);
  }
  updateUser();
  res.json({ ok: true });
});

router.post('/users/:id/revoke-sessions', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'not found' });
  revokeAllUserSessions(id);
  auditLog({ actorUserId: req.user.id, action: 'revoke_sessions', targetType: 'user', targetId: String(id) });
  res.json({ ok: true });
});

router.get('/audit-logs', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ logs: rows });
});

router.get('/search-history', (req, res) => {
  const userId = req.query.userId === undefined ? null : Number(req.query.userId);
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 200));
  if (userId !== null && (!Number.isSafeInteger(userId) || userId < 1)) return res.status(400).json({ error: 'invalid user id' });
  const conditions = [];
  const values = [];
  if (userId !== null) { conditions.push('h.user_id = ?'); values.push(userId); }
  if (req.query.from) { conditions.push('h.created_at >= ?'); values.push(String(req.query.from)); }
  if (req.query.to) { conditions.push('h.created_at < ?'); values.push(String(req.query.to)); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT h.id, h.user_id AS userId, u.username, h.query, h.private_session AS privateSession, h.created_at AS createdAt
    FROM search_history h JOIN users u ON u.id = h.user_id ${where}
    ORDER BY h.id DESC LIMIT ?
  `).all(...values, limit);
  res.json({ history: rows.map((row) => ({ ...row, privateSession: Boolean(row.privateSession) })) });
});

router.get('/technical-logs', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 200));
  res.json({ logs: db.prepare('SELECT id, level, message, context, created_at AS createdAt FROM technical_logs ORDER BY id DESC LIMIT ?').all(limit) });
});

router.delete('/search-history', (req, res) => {
  const parsed = z.object({
    before: z.string().datetime(),
    userId: z.number().int().positive().optional(),
    confirm: z.literal(true),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'provide an ISO cutoff time and confirm deletion' });
  const count = parsed.data.userId === undefined
    ? db.prepare('SELECT COUNT(*) AS count FROM search_history WHERE created_at < ?').get(parsed.data.before).count
    : db.prepare('SELECT COUNT(*) AS count FROM search_history WHERE created_at < ? AND user_id = ?').get(parsed.data.before, parsed.data.userId).count;
  if (count > 1000) return res.status(409).json({ error: 'deletion exceeds the 1,000-record limit; narrow the date range or user scope', count });
  const removed = parsed.data.userId === undefined
    ? db.prepare('DELETE FROM search_history WHERE created_at < ?').run(parsed.data.before)
    : db.prepare('DELETE FROM search_history WHERE created_at < ? AND user_id = ?').run(parsed.data.before, parsed.data.userId);
  auditLog({ actorUserId: req.user.id, action: 'delete_search_history', targetType: 'search_history', scope: parsed.data.userId ? `user:${parsed.data.userId}` : 'all-users', metadata: { deletedCount: removed.changes, before: parsed.data.before } });
  res.json({ deleted: removed.changes });
});

router.delete('/technical-logs', (req, res) => {
  const parsed = z.object({ before: z.string().datetime(), confirm: z.literal(true) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'provide an ISO cutoff time and confirm deletion' });
  const count = db.prepare('SELECT COUNT(*) AS count FROM technical_logs WHERE created_at < ?').get(parsed.data.before).count;
  if (count > 1000) return res.status(409).json({ error: 'deletion exceeds the 1,000-record limit; narrow the date range', count });
  const removed = db.prepare('DELETE FROM technical_logs WHERE created_at < ?').run(parsed.data.before);
  auditLog({ actorUserId: req.user.id, action: 'delete_technical_logs', targetType: 'technical_logs', scope: 'older-than-cutoff', metadata: { deletedCount: removed.changes, before: parsed.data.before } });
  res.json({ deleted: removed.changes });
});

router.get('/runtime', (_req, res) => {
  const enabled = db.prepare("SELECT value FROM system_settings WHERE key = 'always_on_enabled'").get()?.value !== 'false';
  const tasks = db.prepare("SELECT COUNT(*) AS total, SUM(status IN ('queued','starting','running','degraded')) AS active FROM always_on_tasks").get();
  res.json({
    alwaysOnEnabled: enabled,
    tasks: { total: tasks.total, active: tasks.active || 0 },
    memory: process.memoryUsage(),
    uptimeSeconds: Math.round(process.uptime()),
    limitation: 'Website Monitor runs in the API process and checks public HTTP(S) status; JavaScript applications are not executed.',
  });
});

router.put('/runtime', (req, res) => {
  const parsed = z.object({ alwaysOnEnabled: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid runtime setting' });
  const { setMonitorEnabled } = req.app.locals.monitor;
  setMonitorEnabled(parsed.data.alwaysOnEnabled);
  auditLog({ actorUserId: req.user.id, action: 'set_monitor_kill_switch', targetType: 'system_setting', targetId: 'always_on_enabled', metadata: { enabled: parsed.data.alwaysOnEnabled } });
  res.json({ alwaysOnEnabled: parsed.data.alwaysOnEnabled });
});

export default router;
