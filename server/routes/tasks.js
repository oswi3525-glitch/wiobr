import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { auditLog, db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { validatePublicMonitorUrl } from '../security/safe-url.js';
import { monitorStatus, wakeMonitorService } from '../services/monitor.js';

const router = Router();
router.use(requireAuth);

function serialize(task) {
  const uptimeMs = task.started_at && ['running', 'degraded'].includes(task.status)
    ? Math.max(0, Date.now() - new Date(`${task.started_at.replace(' ', 'T')}${task.started_at.includes('Z') ? '' : 'Z'}`).getTime())
    : 0;
  return {
    id: task.id,
    name: task.name,
    url: task.url,
    type: task.task_type,
    status: task.status,
    startedAt: task.started_at,
    uptimeMs,
    lastHeartbeatAt: task.last_heartbeat_at,
    restartCount: task.restart_count,
    lastError: task.last_error,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

router.get('/status', (_req, res) => res.json(monitorStatus()));

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM always_on_tasks WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ tasks: rows.map(serialize), status: monitorStatus() });
});

router.post('/', async (req, res) => {
  const createSchema = z.object({
    name: z.string().trim().min(1).max(80),
    url: z.string().trim().min(1).max(2048),
    type: z.enum(['monitor', 'persistent']).default('monitor'),
  }).strict();
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid task configuration' });
  if (parsed.data.type === 'persistent') {
    return res.status(422).json({ error: 'Persistent Web Task is unavailable: this host has not been verified for isolated long-running browser or JavaScript processes. Website Monitor supports scheduled HTTP(S) checks only.' });
  }
  if (!monitorStatus().enabled) return res.status(503).json({ error: 'Always-On monitoring is paused by an administrator' });
  const count = db.prepare("SELECT COUNT(*) AS count FROM always_on_tasks WHERE user_id = ? AND status != 'stopped'").get(req.user.id).count;
  if (count >= config.maxMonitorTasksPerUser) return res.status(429).json({ error: 'your account has reached the three active monitor limit' });
  const globalCount = db.prepare("SELECT COUNT(*) AS count FROM always_on_tasks WHERE status != 'stopped'").get().count;
  if (globalCount >= 10) return res.status(503).json({ error: 'server monitor capacity is full' });
  let url;
  try {
    url = await validatePublicMonitorUrl(parsed.data.url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const info = db.prepare(`
    INSERT INTO always_on_tasks(user_id, name, url, task_type, status)
    VALUES (?,?,?,'monitor','queued')
  `).run(req.user.id, parsed.data.name, url.href);
  auditLog({ actorUserId: req.user.id, action: 'create_monitor', targetType: 'always_on_task', targetId: String(info.lastInsertRowid) });
  wakeMonitorService();
  const task = db.prepare('SELECT * FROM always_on_tasks WHERE id = ? AND user_id = ?').get(info.lastInsertRowid, req.user.id);
  res.status(201).json({ task: serialize(task) });
});

router.get('/:id/logs', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid task id' });
  const task = db.prepare('SELECT id FROM always_on_tasks WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const checks = db.prepare(`
    SELECT checked_at AS checkedAt, http_status AS httpStatus, latency_ms AS latencyMs, outcome, message
    FROM always_on_checks WHERE task_id = ? ORDER BY id DESC LIMIT 100
  `).all(id);
  res.json({ checks });
});

router.post('/:id/:action', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid task id' });
  const task = db.prepare('SELECT * FROM always_on_tasks WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (!['start', 'stop', 'restart'].includes(req.params.action)) return res.status(404).json({ error: 'task action not found' });
  if (req.params.action === 'stop') {
    db.prepare("UPDATE always_on_tasks SET status = 'stopped', last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  } else {
    if (!monitorStatus().enabled) return res.status(503).json({ error: 'Always-On monitoring is paused by an administrator' });
    const running = db.prepare("SELECT COUNT(*) AS count FROM always_on_tasks WHERE status != 'stopped' AND id != ?").get(id).count;
    if (task.status === 'stopped' && running >= 10) return res.status(503).json({ error: 'server monitor capacity is full' });
    if (task.status === 'stopped') {
      const ownedActive = db.prepare("SELECT COUNT(*) AS count FROM always_on_tasks WHERE user_id = ? AND status != 'stopped'").get(req.user.id).count;
      if (ownedActive >= config.maxMonitorTasksPerUser) return res.status(429).json({ error: 'your account has reached the three active monitor limit' });
    }
    db.prepare(`
      UPDATE always_on_tasks SET status = 'queued', started_at = NULL, last_heartbeat_at = NULL,
        last_error = NULL, restart_count = restart_count + ?, updated_at = datetime('now') WHERE id = ?
    `).run(req.params.action === 'restart' ? 1 : 0, id);
    wakeMonitorService();
  }
  const updated = db.prepare('SELECT * FROM always_on_tasks WHERE id = ?').get(id);
  auditLog({ actorUserId: req.user.id, action: `${req.params.action}_monitor`, targetType: 'always_on_task', targetId: String(id) });
  res.json({ task: serialize(updated) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid task id' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm task deletion' });
  const removed = db.prepare('DELETE FROM always_on_tasks WHERE id = ? AND user_id = ?').run(id, req.user.id);
  if (!removed.changes) return res.status(404).json({ error: 'task not found' });
  auditLog({ actorUserId: req.user.id, action: 'delete_monitor', targetType: 'always_on_task', targetId: String(id) });
  res.status(204).send();
});

export default router;
