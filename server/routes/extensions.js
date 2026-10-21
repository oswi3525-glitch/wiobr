import { Router } from 'express';
import { z } from 'zod';
import { db, auditLog } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const permissions = ['search.read', 'workspace.read', 'url.modify', 'storage.read'];

router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT e.id, e.name, e.version, e.description, e.source_url AS sourceUrl, e.permissions,
      COALESCE(ue.enabled, 0) AS enabled
    FROM extensions e LEFT JOIN user_extensions ue ON ue.extension_id = e.id AND ue.user_id = ?
    WHERE e.enabled = 1 ORDER BY e.name COLLATE NOCASE
  `).all(req.user.id).map((row) => ({ ...row, permissions: JSON.parse(row.permissions), enabled: Boolean(row.enabled) }));
  res.json({ extensions: rows, runtime: 'metadata-only; extension code is not downloaded or executed' });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
  if (!Number.isSafeInteger(id) || id < 1 || !parsed.success) return res.status(400).json({ error: 'invalid extension update' });
  const extension = db.prepare('SELECT id, name FROM extensions WHERE id = ? AND enabled = 1').get(id);
  if (!extension) return res.status(404).json({ error: 'extension not found' });
  db.prepare(`
    INSERT INTO user_extensions(user_id, extension_id, enabled) VALUES (?,?,?)
    ON CONFLICT(user_id, extension_id) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')
  `).run(req.user.id, id, parsed.data.enabled ? 1 : 0);
  if (extension.name === 'Privacy URL Cleaner') {
    db.prepare(`
      INSERT INTO user_settings(user_id, key, value) VALUES (?, 'privacy_clean_tracking', ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(req.user.id, String(parsed.data.enabled));
  }
  res.json({ id, enabled: parsed.data.enabled });
});

const admin = Router();
admin.use(requireAuth, requireRole('admin'));

admin.post('/', (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().max(500).default(''),
    sourceUrl: z.string().url().max(2048),
    permissions: z.array(z.enum(permissions)).max(4).default([]),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid extension metadata' });
  const source = new URL(parsed.data.sourceUrl);
  if (source.protocol !== 'https:' || source.username || source.password || source.search || source.hash) {
    return res.status(400).json({ error: 'extension source must be a public HTTPS page' });
  }
  try {
    const info = db.prepare(`
      INSERT INTO extensions(name, version, description, source_url, permissions, enabled, installed_by)
      VALUES (?,?,?,?,?,1,?)
    `).run(parsed.data.name, parsed.data.version, parsed.data.description, source.href, JSON.stringify(parsed.data.permissions), req.user.id);
    auditLog({ actorUserId: req.user.id, action: 'register_extension_metadata', targetType: 'extension', targetId: String(info.lastInsertRowid) });
    res.status(201).json({ id: info.lastInsertRowid, ...parsed.data, sourceUrl: source.href, runtime: 'metadata-only' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'extension version already registered' });
    throw error;
  }
});

admin.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid extension id' });
  const existing = db.prepare('SELECT id FROM extensions WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'extension not found' });
  db.prepare('DELETE FROM extensions WHERE id = ?').run(id);
  auditLog({ actorUserId: req.user.id, action: 'remove_extension_metadata', targetType: 'extension', targetId: String(id) });
  res.status(204).send();
});

router.use('/admin/catalog', admin);
export default router;
