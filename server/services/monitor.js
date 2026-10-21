import { checkWebsite } from '../security/safe-url.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { logger } from '../logger.js';

const activeChecks = new Set();
let timer;
let globalEnabled = true;

function safeError(error) {
  return String(error?.message || 'website check failed')
    .replace(/https?:\/\/\S+/gi, '[website]')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 240);
}

async function runCheck(task) {
  if (activeChecks.has(task.id) || !globalEnabled) return;
  activeChecks.add(task.id);
  const started = new Date().toISOString();
  db.prepare("UPDATE always_on_tasks SET status = 'starting', updated_at = datetime('now') WHERE id = ?").run(task.id);
  try {
    const result = await checkWebsite(task.url);
    if (!db.prepare('SELECT 1 FROM always_on_tasks WHERE id = ?').get(task.id)) return;
    const outcome = result.status >= 200 && result.status < 400 ? 'ok' : 'error';
    const message = outcome === 'ok' ? null : `Website returned HTTP ${result.status}`;
    db.prepare(`
      INSERT INTO always_on_checks(task_id, http_status, latency_ms, outcome, message)
      VALUES (?,?,?,?,?)
    `).run(task.id, result.status, result.latencyMs, outcome, message);
    db.prepare(`
      UPDATE always_on_tasks SET status = ?, started_at = COALESCE(started_at, ?),
        last_heartbeat_at = datetime('now'), last_error = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'starting'
    `).run(outcome === 'ok' ? 'running' : 'degraded', started, message, task.id);
  } catch (error) {
    if (!db.prepare('SELECT 1 FROM always_on_tasks WHERE id = ?').get(task.id)) return;
    const message = safeError(error);
    db.prepare("INSERT INTO always_on_checks(task_id, outcome, message) VALUES (?, 'error', ?)").run(task.id, message);
    db.prepare(`
      UPDATE always_on_tasks SET status = 'degraded', last_heartbeat_at = datetime('now'),
        last_error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'starting'
    `).run(message, task.id);
  } finally {
    activeChecks.delete(task.id);
    const queued = db.prepare("SELECT 1 FROM always_on_tasks WHERE id = ? AND status = 'queued'").get(task.id);
    if (queued && globalEnabled) setImmediate(() => wakeMonitorService());
  }
}

async function tick() {
  if (!globalEnabled) return;
  const tasks = db.prepare(`
    SELECT id, url FROM always_on_tasks
    WHERE task_type = 'monitor' AND status IN ('queued','starting','running','degraded')
    ORDER BY updated_at LIMIT 10
  `).all();
  for (const task of tasks) await runCheck(task);
}

export function startMonitorService() {
  if (timer) return;
  globalEnabled = db.prepare("SELECT value FROM system_settings WHERE key = 'always_on_enabled'").get()?.value !== 'false';
  if (globalEnabled) {
    db.prepare("UPDATE always_on_tasks SET status = 'queued', last_error = NULL, updated_at = datetime('now') WHERE task_type = 'monitor' AND status IN ('starting','running','degraded')").run();
  }
  timer = setInterval(() => {
    tick().catch((error) => logger.error({ err: error }, 'website monitor cycle failed'));
  }, config.monitorIntervalMs);
  timer.unref?.();
  tick().catch((error) => logger.error({ err: error }, 'website monitor startup check failed'));
}

export function stopMonitorService() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export function setMonitorEnabled(enabled) {
  const update = db.transaction(() => {
    if (!enabled) {
      if (db.prepare("SELECT value FROM system_settings WHERE key = 'always_on_enabled'").get()?.value === 'false') return;
      const activeIds = db.prepare("SELECT id FROM always_on_tasks WHERE task_type = 'monitor' AND status IN ('queued','starting','running','degraded')").all()
        .map((task) => task.id);
      db.prepare("INSERT INTO system_settings(key, value) VALUES ('always_on_paused_ids', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
        .run(JSON.stringify(activeIds));
      db.prepare("UPDATE always_on_tasks SET status = 'stopped', updated_at = datetime('now') WHERE task_type = 'monitor' AND status IN ('queued','starting','running','degraded')").run();
    } else {
      if (db.prepare("SELECT value FROM system_settings WHERE key = 'always_on_enabled'").get()?.value !== 'false') return;
      const saved = db.prepare("SELECT value FROM system_settings WHERE key = 'always_on_paused_ids'").get();
      if (saved) {
        const ids = JSON.parse(saved.value);
        const resume = db.prepare("UPDATE always_on_tasks SET status = 'queued', updated_at = datetime('now') WHERE id = ? AND task_type = 'monitor' AND status = 'stopped'");
        for (const id of ids) resume.run(id);
        db.prepare("DELETE FROM system_settings WHERE key = 'always_on_paused_ids'").run();
      }
    }
    db.prepare("UPDATE system_settings SET value = ?, updated_at = datetime('now') WHERE key = 'always_on_enabled'")
      .run(enabled ? 'true' : 'false');
  });
  update();
  globalEnabled = enabled;
  if (enabled) tick().catch((error) => logger.error({ err: error }, 'website monitor resume failed'));
}

export function wakeMonitorService() {
  if (globalEnabled) tick().catch((error) => logger.error({ err: error }, 'website monitor check failed'));
}

export function monitorStatus() {
  return {
    enabled: globalEnabled,
    activeChecks: activeChecks.size,
    intervalMs: config.monitorIntervalMs,
    maxConcurrentChecks: 1,
    executionMode: 'in-process HTTP(S) monitor; browser JavaScript is not executed',
  };
}
