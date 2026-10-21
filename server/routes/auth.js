import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, revokeSession, cookieOptions, listUserSessions } from '../auth/session.js';
import { db } from '../db.js';
import { auditLog } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireSameOrigin } from '../middleware/auth.js';
import crypto from 'node:crypto';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

const dummyPasswordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));

router.post('/login', requireSameOrigin, loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });
  const { username, password } = parsed.data;
  const ip = req.ip;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const passwordMatches = await verifyPassword(user?.password_hash || dummyPasswordHash, password);
  const ok = Boolean(user && !user.disabled && passwordMatches);
  db.prepare('INSERT INTO login_attempts(username, ip_address, success) VALUES (?,?,?)').run(username, ip, ok ? 1 : 0);
  if (!ok || !user) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const sid = createSession(user.id, { userAgent: req.get('user-agent'), ipAddress: ip });
  res.cookie(config.sessionCookieName, sid, cookieOptions());
  auditLog({ actorUserId: user.id, action: 'login', targetType: 'session' });
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/logout', requireSameOrigin, (req, res) => {
  const cookieName = config.sessionCookieName;
  const sid = req.cookies?.[cookieName];
  if (sid) {
    revokeSession(sid);
    const session = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sid);
    if (session) auditLog({ actorUserId: session.user_id, action: 'logout', targetType: 'session' });
  }
  res.clearCookie(cookieName, cookieOptions());
  res.status(204).send();
});

router.get('/me', (req, res) => {
  const cookieName = config.sessionCookieName;
  const sid = req.cookies?.[cookieName];
  if (!sid) return res.status(401).json({ error: 'unauthorized' });
  // validate session
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND revoked = 0').get(sid);
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const user = db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?').get(session.user_id);
  if (!user || user.disabled) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

router.get('/sessions', requireAuth, (req, res) => {
  const sessions = listUserSessions(req.user.id).map((session) => ({
    createdAt: new Date(`${session.created_at.replace(' ', 'T')}${session.created_at.includes('Z') ? '' : 'Z'}`).toISOString(),
    lastSeenAt: new Date(`${session.last_seen_at.replace(' ', 'T')}${session.last_seen_at.includes('Z') ? '' : 'Z'}`).toISOString(),
    expiresAt: session.expires_at,
    userAgent: session.user_agent,
    current: session.id === req.session.id,
    revoked: Boolean(session.revoked),
  }));
  res.json({ sessions });
});

router.post('/sessions/revoke-others', requireSameOrigin, requireAuth, (req, res) => {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id != ?').run(req.user.id, req.session.id);
  auditLog({ actorUserId: req.user.id, action: 'revoke_other_sessions', targetType: 'user', targetId: String(req.user.id) });
  res.status(204).send();
});

router.post('/change-password', requireSameOrigin, requireAuth, async (req, res) => {
  const parsed = z.object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'use a new password with at least 12 characters' });
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!await verifyPassword(user.password_hash, parsed.data.currentPassword)) {
    return res.status(403).json({ error: 'current password is incorrect' });
  }
  const hash = await hashPassword(parsed.data.newPassword);
  const change = db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, req.user.id);
    db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id != ?').run(req.user.id, req.session.id);
    auditLog({ actorUserId: req.user.id, action: 'change_password', targetType: 'user', targetId: String(req.user.id) });
  });
  change();
  res.json({ ok: true, message: 'Password changed. Other sessions have been revoked.' });
});

export default router;
