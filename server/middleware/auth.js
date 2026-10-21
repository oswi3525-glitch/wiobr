import { getSession, touchSession } from '../auth/session.js';
import { db } from '../db.js';
import { config } from '../config.js';

export async function requireAuth(req, res, next) {
  const cookieName = config.sessionCookieName;
  const sid = req.cookies?.[cookieName];
  const session = getSession(sid);
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const u = db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?').get(session.user_id);
  if (!u || u.disabled) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  touchSession(session.id);
  req.session = session;
  req.user = u;
  next();
}

export function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return res.status(403).json({ error: 'request origin rejected' });
    }
    const allowed = new Set([req.get('host')]);
    if (config.corsOrigin) allowed.add(config.corsOrigin);
    if (!allowed.has(originUrl.host) && !allowed.has(originUrl.origin)) {
      return res.status(403).json({ error: 'request origin rejected' });
    }
    if (config.secureCookies && originUrl.protocol !== 'https:' && !config.corsOrigin) {
      return res.status(403).json({ error: 'secure origin required' });
    }
  }
  if (req.get('x-wiobr-request') !== '1') {
    return res.status(403).json({ error: 'request verification required' });
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}
