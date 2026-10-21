import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { fetchPublicText, isPublicIPv4 } from '../security/safe-url.js';

const router = Router();
const TRACKING_PARAMETERS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'gbraid', 'wbraid', 'yclid', 'mc_cid', 'mc_eid',
  'igshid', 'vero_id', 'oly_anon_id', 'oly_enc_id', 'ref_src', 'ref_url',
]);

export function cleanTrackingUrl(value) {
  const url = new URL(value);
  for (const name of [...url.searchParams.keys()]) {
    const normalized = name.toLowerCase();
    if (normalized.startsWith('utm_') || TRACKING_PARAMETERS.has(normalized)) url.searchParams.delete(name);
  }
  return url.href;
}

router.use(requireAuth);

router.get('/settings', (req, res) => {
  const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'privacy_clean_tracking'")
    .get(req.user.id);
  res.json({ cleanTracking: row ? row.value === 'true' : true, scope: 'URLs opened from within WioBrowse only; no external-site request filtering.' });
});

router.put('/settings', (req, res) => {
  const parsed = z.object({ cleanTracking: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid privacy settings' });
  db.prepare(`
    INSERT INTO user_settings(user_id, key, value) VALUES (?, 'privacy_clean_tracking', ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(req.user.id, String(parsed.data.cleanTracking));
  res.json({ cleanTracking: parsed.data.cleanTracking });
});

router.post('/clean-url', (req, res) => {
  const parsed = z.object({ url: z.string().url().max(2048) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid URL' });
  const url = new URL(parsed.data.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return res.status(400).json({ error: 'only HTTP(S) URLs without credentials are supported' });
  }
  res.json({ url: cleanTrackingUrl(url.href) });
});

router.get('/cloud-ip', async (_req, res, next) => {
  try {
    const response = await fetchPublicText('https://api.ipify.org?format=json', { maxBytes: 256 });
    if (response.status !== 200) return res.status(502).json({ error: 'egress IP provider returned an error' });
    const value = JSON.parse(response.body).ip;
    if (typeof value !== 'string' || !isPublicIPv4(value)) {
      return res.status(502).json({ error: 'egress IP provider returned an invalid address' });
    }
    res.json({ egressIp: value, checkedAt: new Date().toISOString(), source: 'api.ipify.org' });
  } catch (error) {
    next(error);
  }
});

export default router;
