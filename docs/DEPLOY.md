# Deploy

The app is a single Node.js process with no runtime dependencies. Any container
host or Node 22+ platform works. Render is the shortest path and ships with a
Blueprint.

## Render Blueprint

1. Push the repository to GitHub.
2. Render Dashboard → **New** → **Blueprint**.
3. Select the repository. Render reads [`render.yaml`](../render.yaml).
4. Apply. The service builds with `npm ci --omit=dev` and starts with `node src/server.js`.
5. Open the URL. The demo works immediately in mock mode.

[`render.yaml`](../render.yaml) sets:

- `healthCheckPath: /api/health`
- `TRUST_PROXY=1` so request-derived return URLs and per-IP rate limits work behind Render's proxy
- `AI_PROVIDER=auto`
- optional PayPal, AI, `PUBLIC_BASE_URL`, and `DEMO_RESET_SECRET` values
- a commented persistent-disk upgrade path

### Free-tier realities

- The instance spins down after ~15 minutes idle and takes about a minute to wake.
- The filesystem is ephemeral; without `DATA_FILE` on a disk, a restart reseeds the demo.
- Warm the URL before recording the demo video.
- Free instances cannot mount a disk. For durable state, upgrade and uncomment the disk block, then set `DATA_FILE=/var/data/store.json`.

### Public demo hardening

- Set `DEMO_RESET_SECRET` so only you can reset the demo.
- Leave `PAYPAL_*` unset for a safe public mock demo, or use sandbox credentials only.
- Keep `ALLOW_WEBHOOK_SIMULATION=true` for the demo; set it to `false` if you do not want the replay button to work.
- The API applies per-IP rate limits (`RATE_LIMIT_MAX`, `RATE_LIMIT_WRITE_MAX`) and same-origin checks on writes.

## Docker

```sh
docker build -t cashflow-copilot .
docker run --rm -p 3000:3000 -e PORT=3000 cashflow-copilot
```

The image:

- runs as the non-root `node` user,
- includes a `HEALTHCHECK` against `/api/health`,
- copies `policies/`, `public/`, `openapi/`, `scripts/`, `tests/`, and `docs/` so the container is inspectable,
- never contains secrets.

With sandbox credentials:

```sh
docker run --rm -p 3000:3000 \
  -e PAYPAL_CLIENT_ID=... \
  -e PAYPAL_CLIENT_SECRET=... \
  -e PAYPAL_WEBHOOK_ID=... \
  cashflow-copilot
```

## Any Node host

```sh
npm ci --omit=dev
PORT=3000 NODE_ENV=production node src/server.js
```

Environment variables are documented in [`.env.example`](../.env.example).

## Persistence

By default the store is in memory (a deliberate prototype boundary). To persist:

```sh
DATA_FILE=/var/data/store.json npm start
```

Writes are debounced and atomic (temporary file + rename). `SIGTERM`/`SIGINT`
flush pending writes before exit. The file contains invoice data but no secrets.

## Health and observability

`GET /api/health` returns:

- adapter and mode (`mock` / `sandbox`),
- version and uptime,
- capability flags (checkout, webhooks, agent, audit, policy),
- AI provider/model/fallback status,
- no secrets.

Use it as the platform health check. For deeper inspection, `GET /api/audit`
returns the hash-chain verification for every invoice.

## Deployment checklist

- [ ] `npm run verify` passes locally.
- [ ] `docker build` succeeds (optional).
- [ ] Hosted URL opens with seeded data and a visible mode banner.
- [ ] `/api/health` returns `status: ok`.
- [ ] `DEMO_RESET_SECRET` is set on the public deployment.
- [ ] If sandbox credentials are configured, a create/send/remind flow works.
- [ ] The video records the hosted URL, not localhost.
