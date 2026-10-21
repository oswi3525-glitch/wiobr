import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createSession(userId, { userAgent, ipAddress } = {}) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO sessions(id, user_id, expires_at, user_agent, ip_address) VALUES (?,?,?,?,?)',
  ).run(id, userId, expiresAt, userAgent || null, ipAddress || null);
  return id;
}

export function getSession(id) {
  if (!id) return null;
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND revoked = 0')
    .get(id);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export function touchSession(id) {
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?").run(id);
}

export function revokeSession(id) {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(id);
}

export function revokeAllUserSessions(userId, exceptId = null) {
  if (exceptId) {
    db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id != ?').run(userId, exceptId);
  } else {
    db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(userId);
  }
}

export function listUserSessions(userId) {
  return db
    .prepare('SELECT id, created_at, last_seen_at, expires_at, user_agent, ip_address, revoked FROM sessions WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

export { SESSION_TTL_MS };
