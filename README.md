# WioBrowse Cloud

## Requirements

- Node.js 20 or newer
- npm

## Local setup

```sh
npm install
cp .env.example .env
npm run dev
```

The Vite client and API server start together. The client is available at
`http://localhost:5173`; API requests are proxied to the server using `HOST`
and `PORT` from `.env` (default port 3000). Relative `DATA_DIR` paths resolve
from the project directory. `.env` is ignored by Git; use `.env.example` as the
list of supported variables.

## Create the first administrator

Set a unique username and a strong password only for the bootstrap command:

```sh
ADMIN_USERNAME=your-admin ADMIN_PASSWORD='use-a-strong-unique-password' node scripts/bootstrap-admin.js
```

The command creates the initial administrator only when no administrator
already exists. Do not commit real credentials or put bootstrap credentials in
source control.

## Production

Build and start the app with:

```sh
npm run build
NODE_ENV=production npm start
```

In production, configure `HOST`, `PORT`, and `DATA_DIR` for your host. HTTPS
deployments should terminate TLS at the server or a trusted reverse proxy;
secure session cookies are enabled automatically when `NODE_ENV=production`.
If the proxy terminates TLS, set `TRUST_PROXY_HOPS` to the exact number of
trusted proxy hops. Set `CORS_ORIGIN` only when the frontend is served from a
different origin, using the origin alone (for example
`https://app.example.com`, with no path or trailing slash).

The frontend can use `VITE_API_BASE_URL` when its API is hosted at a different
origin. Vite reads this value at build time; rebuild after changing it.

## Checks

```sh
npm test
npm run typecheck
npm run build
```
# startup loop test 1792686618




