const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export function apiUrl(path: string) {
  return `${apiBaseUrl}${path}`;
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = new Headers(opts.headers);
  if (opts.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-WioBr-Request', '1');
  const res = await fetch(apiUrl(path), {
    credentials: 'include',
    ...opts,
    headers,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json() as { error?: string };
      msg = body.error || msg;
    } catch {
      // Preserve the HTTP status text if an upstream returns a non-JSON error.
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
