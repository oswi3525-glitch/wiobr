import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const configuredCorsOrigin = process.env.CORS_ORIGIN ? new URL(process.env.CORS_ORIGIN).origin : '';
if (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== configuredCorsOrigin) {
  throw new Error('CORS_ORIGIN must be an origin without a path or trailing slash');
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: resolve(root, process.env.DATA_DIR || 'data'),
  dbPath: resolve(root, process.env.DATA_DIR || 'data', 'wiobr.sqlite'),
  storageDir: resolve(root, process.env.DATA_DIR || 'data', 'uploads'),
  sessionCookieName: process.env.SESSION_COOKIE || 'wiobr_session',
  secureCookies: process.env.SECURE_COOKIES === 'true' || process.env.NODE_ENV === 'production',
  nodeEnv: process.env.NODE_ENV || 'development',
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),
  corsOrigin: configuredCorsOrigin,
  searchProvider: process.env.SEARCH_PROVIDER || 'duckduckgo',
  searchApiKey: process.env.SEARCH_API_KEY || '',
  maxUploadBytes: 5 * 1024 * 1024,
  userStorageQuotaBytes: 100 * 1024 * 1024,
  maxMonitorTasksPerUser: 3,
  monitorIntervalMs: 5 * 60 * 1000,
};

export function ensureDataDir() {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (!existsSync(config.storageDir)) mkdirSync(config.storageDir, { recursive: true, mode: 0o700 });
}
