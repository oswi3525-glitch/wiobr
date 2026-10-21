import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { auditLog } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use('/chat', requireAuth);
router.use('/members', requireAuth);
router.use('/workspaces', requireAuth);

router.get('/chat', (req, res) => {
  const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
  if (!Number.isSafeInteger(before) || before < 1) return res.status(400).json({ error: 'invalid cursor' });
  const rows = db.prepare(`
    SELECT m.id, m.user_id AS userId, u.username, m.content, m.created_at AS createdAt
    FROM chat_messages m JOIN users u ON u.id = m.user_id
    WHERE m.room = 'global' AND m.id < ?
    ORDER BY m.id DESC LIMIT ?
  `).all(before, limit).reverse();
  res.json({ messages: rows, nextCursor: rows.length === limit ? rows[0].id : null });
});

router.get('/members', (_req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.username, COALESCE(
      CASE WHEN p.last_heartbeat_at >= datetime('now','-90 seconds') THEN p.status ELSE 'offline' END,
      'offline'
    ) AS status,
    p.last_heartbeat_at AS lastActive,
    CASE WHEN p.last_heartbeat_at >= datetime('now','-90 seconds') THEN p.active_sessions ELSE 0 END AS activeSessions
    FROM users u LEFT JOIN online_presence p ON p.user_id = u.id
    WHERE u.disabled = 0 ORDER BY status = 'offline', u.username COLLATE NOCASE
  `).all();
  res.json({ members });
});

const workspaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  tabs: z.array(z.object({
    url: z.union([z.literal(''), z.string().url().max(2048).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))]),
    title: z.string().max(300).default(''),
  })).max(50).default([]),
  activeTab: z.number().int().min(0).default(0),
  theme: z.enum(['light', 'dark', 'system']).default('system'),
}).strict().refine((data) => data.tabs.length === 0 || data.activeTab < data.tabs.length, { path: ['activeTab'] });

router.get('/workspaces', (req, res) => {
  const workspaces = db.prepare('SELECT id, name, data, version, created_at AS createdAt, updated_at AS updatedAt FROM workspaces WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id).map((workspace) => ({ ...workspace, data: JSON.parse(workspace.data) }));
  res.json({ workspaces });
});

router.post('/workspaces', (req, res) => {
  const parsed = workspaceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid workspace data' });
  if (db.prepare('SELECT 1 FROM workspaces WHERE user_id = ? AND name = ?').get(req.user.id, parsed.data.name)) {
    return res.status(409).json({ error: 'workspace name already exists' });
  }
  const info = db.prepare('INSERT INTO workspaces(user_id, name, data) VALUES (?,?,?)')
    .run(req.user.id, parsed.data.name, JSON.stringify(parsed.data));
  auditLog({ actorUserId: req.user.id, action: 'create_workspace', targetType: 'workspace', targetId: String(info.lastInsertRowid) });
  res.status(201).json({ id: info.lastInsertRowid, version: 1, name: parsed.data.name, data: parsed.data });
});

router.put('/workspaces/:id', (req, res) => {
  const id = Number(req.params.id);
  const expectedVersion = Number(req.get('if-match') || req.body.version);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return res.status(400).json({ error: 'workspace id and version are required' });
  }
  const parsed = workspaceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid workspace data' });
  if (db.prepare('SELECT 1 FROM workspaces WHERE user_id = ? AND name = ? AND id != ?').get(req.user.id, parsed.data.name, id)) {
    return res.status(409).json({ error: 'workspace name already exists' });
  }
  const updated = db.prepare(`
    UPDATE workspaces SET name = ?, data = ?, version = version + 1, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND version = ?
  `).run(parsed.data.name, JSON.stringify(parsed.data), id, req.user.id, expectedVersion);
  if (updated.changes) return res.json({ id, name: parsed.data.name, data: parsed.data, version: expectedVersion + 1 });
  const current = db.prepare('SELECT name, data, version FROM workspaces WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!current) return res.status(404).json({ error: 'workspace not found' });
  res.status(409).json({ error: 'workspace changed in another session', current: { ...current, data: JSON.parse(current.data) } });
});

router.post('/workspaces/:id/duplicate', (req, res) => {
  const id = Number(req.params.id);
  const source = db.prepare('SELECT name, data FROM workspaces WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!source) return res.status(404).json({ error: 'workspace not found' });
  const name = z.string().trim().min(1).max(80).safeParse(req.body?.name);
  if (!name.success) return res.status(400).json({ error: 'a workspace name is required' });
  if (db.prepare('SELECT 1 FROM workspaces WHERE user_id = ? AND name = ?').get(req.user.id, name.data)) {
    return res.status(409).json({ error: 'workspace name already exists' });
  }
  const info = db.prepare('INSERT INTO workspaces(user_id, name, data) VALUES (?,?,?)').run(req.user.id, name.data, source.data);
  res.status(201).json({ id: info.lastInsertRowid, name: name.data, data: JSON.parse(source.data), version: 1 });
});

router.delete('/workspaces/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid workspace id' });
  const removed = db.prepare('DELETE FROM workspaces WHERE id = ? AND user_id = ?').run(id, req.user.id);
  if (!removed.changes) return res.status(404).json({ error: 'workspace not found' });
  auditLog({ actorUserId: req.user.id, action: 'delete_workspace', targetType: 'workspace', targetId: String(id) });
  res.status(204).send();
});

export default router;
