import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { db } from '../db.js';

const router = Router();
const cache = new Map();
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 200;
const searchSchema = z.object({
  query: z.string().trim().min(1).max(200),
  privateSession: z.boolean().default(false),
});

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripMarkup(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function resultUrl(raw) {
  try {
    const candidate = new URL(decodeHtml(raw), 'https://html.duckduckgo.com');
    const redirected = candidate.searchParams.get('uddg');
    const target = new URL(redirected || candidate.href);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    return target;
  } catch {
    return null;
  }
}

export function parseDuckDuckGoResults(html, limit = 10) {
  const results = [];
  const pattern = /<a\b[^>]*class=(["'])[^"']*\bresult__a\b[^"']*\1[^>]*href=(["'])(.*?)\2[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) && results.length < limit) {
    const url = resultUrl(match[3]);
    if (!url) continue;
    const end = html.indexOf('</div>', pattern.lastIndex);
    const section = html.slice(pattern.lastIndex, end < 0 ? pattern.lastIndex + 5000 : end);
    const snippetMatch = section.match(/class=(["'])[^"']*\bresult__snippet\b[^"']*\1[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    const title = stripMarkup(match[4]).slice(0, 300);
    if (!title) continue;
    results.push({
      title,
      url: url.href,
      snippet: snippetMatch ? stripMarkup(snippetMatch[2]).slice(0, 700) : '',
      domain: url.hostname,
      favicon: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(url.hostname)}.ico`,
    });
  }
  return results;
}

export async function searchDuckDuckGo(query, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'WioBrowseCloud/1.0 (+server-side search)' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Search provider returned ${response.status}`);
    const html = await response.text();
    if (html.length > 2_000_000) throw new Error('Search provider response exceeded the limit');
    return parseDuckDuckGoResults(html);
  } finally {
    clearTimeout(timeout);
  }
}

router.use(requireAuth);
const userSearchLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id),
});

router.get('/history', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
  const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
  if (!Number.isSafeInteger(before) || before < 1) return res.status(400).json({ error: 'invalid history cursor' });
  const history = db.prepare(`
    SELECT id, query, private_session AS privateSession, created_at AS createdAt
    FROM search_history WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?
  `).all(req.user.id, before, limit).map((entry) => ({ ...entry, privateSession: Boolean(entry.privateSession) }));
  res.json({ history });
});

router.delete('/history', (req, res) => {
  const parsed = z.object({ before: z.string().datetime(), confirm: z.literal(true) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'provide a cutoff time and confirm deletion' });
  const count = db.prepare('SELECT COUNT(*) AS count FROM search_history WHERE user_id = ? AND created_at < ?')
    .get(req.user.id, parsed.data.before).count;
  if (count > 1000) return res.status(409).json({ error: 'deletion exceeds the 1,000-record limit; narrow the date range', count });
  const removed = db.prepare('DELETE FROM search_history WHERE user_id = ? AND created_at < ?')
    .run(req.user.id, parsed.data.before);
  db.prepare(`
    INSERT INTO audit_logs(actor_user_id, action, target_type, scope, metadata)
    VALUES (?,?,?, ?, ?)
  `).run(req.user.id, 'delete_own_search_history', 'search_history', 'self', JSON.stringify({ deletedCount: removed.changes, before: parsed.data.before }));
  res.json({ deleted: removed.changes });
});

router.post('/', userSearchLimiter, async (req, res, next) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid search request' });
  const query = parsed.data.query.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!query) return res.status(400).json({ error: 'invalid search request' });
  const startedAt = performance.now();
  const key = query.toLocaleLowerCase();
  const cached = cache.get(key);
  let results;
  let cacheHit = false;
  try {
    if (cached && cached.expiresAt > Date.now()) {
      cacheHit = true;
      results = cached.results;
      cache.delete(key);
      cache.set(key, cached);
    } else {
      cache.delete(key);
      if (process.env.SEARCH_PROVIDER && process.env.SEARCH_PROVIDER !== 'duckduckgo') {
        return res.status(503).json({ error: 'configured search provider is not available' });
      }
      results = await searchDuckDuckGo(query);
      cache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    }
    db.prepare('INSERT INTO search_history(user_id, query, private_session) VALUES (?,?,?)')
      .run(req.user.id, query, parsed.data.privateSession ? 1 : 0);
    res.json({ results, tookMs: Math.round(performance.now() - startedAt), cacheHit });
  } catch (error) {
    next(error);
  }
});

export default router;
