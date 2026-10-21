import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import express from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const ITEM_TTL_DAYS = 30;
const itemSchema = z.object({
  kind: z.enum(['folder', 'note', 'link', 'snippet', 'draft']),
  name: z.string().trim().min(1).max(160),
  content: z.string().max(200_000).optional(),
  parentId: z.number().int().positive().nullable().optional(),
}).strict();

function usage(userId) {
  return db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS used FROM storage_items WHERE user_id = ?')
    .get(userId).used;
}

function parentBelongsToUser(parentId, userId) {
  return parentId == null || Boolean(db.prepare("SELECT id FROM storage_items WHERE id = ? AND user_id = ? AND kind = 'folder'")
    .get(parentId, userId));
}

function isDescendant(candidateId, folderId, userId) {
  if (candidateId == null) return false;
  const found = db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM storage_items WHERE id = ? AND user_id = ?
      UNION ALL
      SELECT child.id FROM storage_items child JOIN descendants parent ON child.parent_id = parent.id
      WHERE child.user_id = ?
    )
    SELECT 1 FROM descendants WHERE id = ? LIMIT 1
  `).get(folderId, userId, userId, candidateId);
  return Boolean(found);
}

router.use(requireAuth);

router.get('/', (req, res) => {
  const parentId = req.query.parentId === undefined ? null : Number(req.query.parentId);
  if (parentId !== null && (!Number.isSafeInteger(parentId) || parentId < 1 || !parentBelongsToUser(parentId, req.user.id))) {
    return res.status(404).json({ error: 'folder not found' });
  }
  const items = db.prepare(`
    SELECT id, kind, parent_id AS parentId, name, content, mime, size_bytes AS sizeBytes,
      expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
    FROM storage_items WHERE user_id = ? AND parent_id IS ? AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY kind = 'folder' DESC, name COLLATE NOCASE
  `).all(req.user.id, parentId);
  res.json({ items, usedBytes: usage(req.user.id), quotaBytes: config.userStorageQuotaBytes });
});

router.post('/', (req, res) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid storage item' });
  const { kind, name, content = '', parentId = null } = parsed.data;
  if (!parentBelongsToUser(parentId, req.user.id)) return res.status(404).json({ error: 'folder not found' });
  if (kind === 'link') {
    try {
      const url = new URL(content);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return res.status(400).json({ error: 'only public HTTP(S) links are supported' });
    } catch {
      return res.status(400).json({ error: 'a valid HTTP(S) link is required' });
    }
  }
  const size = Buffer.byteLength(kind === 'link' ? content : content);
  if (usage(req.user.id) + size > config.userStorageQuotaBytes) return res.status(413).json({ error: 'storage quota exceeded' });
  const info = db.prepare(`
    INSERT INTO storage_items(user_id, kind, parent_id, name, content, size_bytes, expires_at)
    VALUES (?,?,?,?,?,?,CASE WHEN ? = 'folder' THEN NULL ELSE datetime('now', ?) END)
  `).run(req.user.id, kind, parentId, name, content, size, kind, `+${ITEM_TTL_DAYS} days`);
  res.status(201).json({ id: info.lastInsertRowid, kind, name, parentId, content, sizeBytes: size, expiresInDays: ITEM_TTL_DAYS });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid storage item id' });
  const item = db.prepare('SELECT * FROM storage_items WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!item) return res.status(404).json({ error: 'storage item not found' });
  const updateSchema = z.object({
    name: z.string().trim().min(1).max(160).optional(),
    content: z.string().max(200_000).optional(),
    parentId: z.number().int().positive().nullable().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0);
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid storage update' });
  const nextParent = parsed.data.parentId === undefined ? item.parent_id : parsed.data.parentId;
  if (nextParent === id || !parentBelongsToUser(nextParent, req.user.id) || isDescendant(nextParent, id, req.user.id)) {
    return res.status(400).json({ error: 'invalid destination folder' });
  }
  const content = parsed.data.content ?? item.content ?? '';
  const size = item.kind === 'file' ? item.size_bytes : Buffer.byteLength(content);
  if (usage(req.user.id) - item.size_bytes + size > config.userStorageQuotaBytes) return res.status(413).json({ error: 'storage quota exceeded' });
  db.prepare(`
    UPDATE storage_items SET name = ?, content = ?, parent_id = ?, size_bytes = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(parsed.data.name ?? item.name, content, nextParent, size, id, req.user.id);
  res.json({ id, name: parsed.data.name ?? item.name, content, parentId: nextParent, sizeBytes: size });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid storage item id' });
  const item = db.prepare('SELECT kind, storage_path FROM storage_items WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!item) return res.status(404).json({ error: 'storage item not found' });
  const paths = db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM storage_items WHERE id = ? AND user_id = ?
      UNION ALL
      SELECT child.id FROM storage_items child JOIN descendants parent ON child.parent_id = parent.id
      WHERE child.user_id = ?
    )
    SELECT storage_path FROM storage_items WHERE id IN (SELECT id FROM descendants) AND storage_path IS NOT NULL
  `).all(id, req.user.id, req.user.id);
  db.prepare('DELETE FROM storage_items WHERE id = ? AND user_id = ?').run(id, req.user.id);
  for (const path of paths) {
    try {
      unlinkSync(join(config.storageDir, basename(path.storage_path)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  res.status(204).send();
});

router.post('/upload', express.raw({ type: 'application/octet-stream', limit: config.maxUploadBytes }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'upload must contain a file' });
  const name = String(req.query.name || '').trim();
  if (!name || name.length > 160 || basename(name) !== name || /[\u0000-\u001f/\\]/.test(name) || name === '.' || name === '..') {
    return res.status(400).json({ error: 'invalid file name' });
  }
  const parentId = req.query.parentId === undefined ? null : Number(req.query.parentId);
  if (parentId !== null && (!Number.isSafeInteger(parentId) || !parentBelongsToUser(parentId, req.user.id))) {
    return res.status(404).json({ error: 'folder not found' });
  }
  if (req.body.length > config.maxUploadBytes) return res.status(413).json({ error: 'file exceeds the 5 MiB limit' });
  if (usage(req.user.id) + req.body.length > config.userStorageQuotaBytes) return res.status(413).json({ error: 'storage quota exceeded' });
  const id = randomUUID();
  const storagePath = `${id}.blob`;
  const target = join(config.storageDir, storagePath);
  writeFileSync(target, req.body, { flag: 'wx', mode: 0o600 });
  try {
    db.prepare(`
      INSERT INTO storage_items(user_id, kind, parent_id, name, mime, size_bytes, storage_path, expires_at)
      VALUES (?, 'file', ?, ?, 'application/octet-stream', ?, ?, datetime('now', ?))
    `).run(req.user.id, parentId, name, req.body.length, storagePath, `+${ITEM_TTL_DAYS} days`);
  } catch (error) {
    unlinkSync(target);
    throw error;
  }
  res.status(201).json({ id, kind: 'file', name, sizeBytes: req.body.length, expiresInDays: ITEM_TTL_DAYS });
});

router.get('/:id/download', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid storage item id' });
  const item = db.prepare("SELECT name, storage_path FROM storage_items WHERE id = ? AND user_id = ? AND kind = 'file'")
    .get(id, req.user.id);
  if (!item) return res.status(404).json({ error: 'file not found' });
  res.set('X-Content-Type-Options', 'nosniff');
  res.download(join(config.storageDir, basename(item.storage_path)), item.name);
});

export default router;
