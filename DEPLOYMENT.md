# Deploying QuickBite

> **Nothing here has been deployed.** This document describes how to deploy; no
> hosting account, domain or gateway has been configured, and no deployment has
> been attempted. Treat every command below as untested against a real host.

---

## 1. What the app needs

| Requirement | Detail |
| --- | --- |
| Runtime | Node **22.5+** (uses the built-in `node:sqlite` module) |
| Build step | None — Express serves the static front end directly |
| Persistent disk | **Required.** The database is a file; without a persistent volume every redeploy wipes all orders and accounts |
| Processes | **One.** Rate limiting is in-process and SQLite has a single writer |
| Outbound network | Only if `ANTHROPIC_API_KEY` is set |

That last pair matters most. QuickBite is a single-process, file-backed
application. It fits a small VPS, a container with a volume, or a platform that
offers persistent disks — and it does **not** fit a platform that runs multiple
stateless replicas on ephemeral filesystems without changes (see §6).

---

## 2. Configuration

Copy `.env.example` to `.env` and fill it in. The variables that actually matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | *(none)* | **The server refuses to start with `NODE_ENV=production` unless this is set.** Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `NODE_ENV` | `development` | `production` enables HSTS and hides stack traces |
| `PORT` | `3000` | |
| `DB_FILE` | `./data/quickbite.db` | Point at the persistent volume |
| `TRUST_PROXY_HOPS` | `0` | Set to `1` behind one reverse proxy, so rate limiting sees the real client IP rather than the proxy's |
| `PAYMENT_WEBHOOK_SECRET` | *(none)* | Without it the payment webhook rejects everything with 503 |
| `ANTHROPIC_API_KEY` | *(none)* | Optional. Without it the assistant uses its built-in rules |

Rotating `JWT_SECRET` signs every existing session out. That is the intended way
to revoke all tokens, since the tokens themselves are stateless.

---

## 3. First deploy

```bash
git clone <your-repo> quickbite && cd quickbite
npm ci --omit=dev

cp .env.example .env
# edit .env: set JWT_SECRET, PAYMENT_WEBHOOK_SECRET, NODE_ENV=production, DB_FILE

npm run migrate          # creates and migrates the database
npm run seed:accounts    # demo accounts only — omit for a real deployment
NODE_ENV=production npm start
```

Then smoke-test (§5).

For a real deployment, **do not** run `npm run seed`: it generates 45 days of
synthetic orders. Create your admin account directly instead:

```bash
node -e "
const { db } = require('./server/db');
const { hashPassword } = require('./server/auth');
hashPassword(process.env.ADMIN_PASSWORD).then(h => {
  db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
    .run('Owner', process.env.ADMIN_EMAIL, h, 'admin');
  console.log('admin created');
});"
```

…with `ADMIN_EMAIL` and `ADMIN_PASSWORD` set in the environment, so the password
never appears in your shell history.

---

## 4. Subsequent deploys

Migrations are forward-only, additive, and safe to re-run. The order matters:

```bash
git pull
npm ci --omit=dev
npm run migrate -- --backup   # copies the database, then applies what is pending
                              # restart the process (systemd / Docker / pm2)
```

`npm run migrate -- --status` reports what is applied and what is pending
without changing anything.

**Rollback.** Migrations have no `down` step by design — reversing a schema
change on live data is where people lose data. To roll back, restore the backup
`migrate --backup` wrote and redeploy the previous code:

```bash
systemctl stop quickbite
cp data/quickbite.db.2025-01-01T00-00-00-000Z.bak data/quickbite.db
git checkout <previous-tag> && npm ci --omit=dev
systemctl start quickbite
```

---

## 5. Smoke test

Run these against the deployed URL. Each should behave exactly as described.

```bash
BASE=https://your-host

# 1. The service is up AND the database answers.
curl -s $BASE/api/health
#    expect: {"ok":true,"status":"healthy","migrations":8,"menu_items":30,...}

# 2. The menu loads.
curl -s "$BASE/api/menu" | head -c 200

# 3. Security headers are present.
curl -sI $BASE/ | grep -Ei 'content-security-policy|x-frame-options|x-content-type'

# 4. The server does not advertise itself.
curl -sI $BASE/ | grep -i 'x-powered-by'     # expect: no output

# 5. Protected routes are closed.
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/orders        # expect 401
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/admin/stats   # expect 401

# 6. The front end is served.
curl -s $BASE/ | grep -c QuickBite            # expect a non-zero count

# 7. A dish photo loads.
curl -s -o /dev/null -w '%{http_code}\n' $BASE/images/dishes/margherita-pizza.jpg
```

Then, in a browser: sign in, add a dish, apply `QUICK10`, check out, and watch
the order advance on `/orders.html`.

---

## 6. Platform notes

### A VPS with systemd — the straightforward option

```ini
# /etc/systemd/system/quickbite.service
[Unit]
Description=QuickBite
After=network.target

[Service]
Type=simple
User=quickbite
WorkingDirectory=/srv/quickbite
EnvironmentFile=/srv/quickbite/.env
ExecStartPre=/usr/bin/node scripts/migrate.js
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5

# The app only ever needs to write to its own data directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/srv/quickbite/data

[Install]
WantedBy=multi-user.target
```

Put nginx or Caddy in front for TLS, and set `TRUST_PROXY_HOPS=1`.

### Docker

```bash
docker build -t quickbite .
docker run -d --name quickbite \
  -p 3000:3000 \
  -v quickbite-data:/app/data \
  -e NODE_ENV=production \
  -e JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')" \
  -e PAYMENT_WEBHOOK_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  quickbite
```

The named volume is not optional. Without `-v`, the database lives inside the
container's writable layer and disappears when the container is replaced.

### Platforms with persistent disks

Fly.io, Render, Railway and similar work well **provided** you attach a volume
and keep the instance count at one:

- mount the volume at `/app/data` and set `DB_FILE=/app/data/quickbite.db`
- scale to exactly 1 instance
- set `TRUST_PROXY_HOPS=1`

### Serverless / multi-replica platforms

Vercel, Netlify Functions, Cloud Run with `min=0`, and any autoscaled setup are
**not** suitable as-is, for three concrete reasons:

1. **The filesystem is ephemeral**, so the database vanishes between invocations.
2. **SQLite allows one writer**, so two replicas would corrupt or lock each other.
3. **Rate limiting is in-process**, so each replica would enforce its own
   separate budget — multiplying the effective limit by the replica count.

Making QuickBite multi-replica means changing all three: move the database to a
networked engine (Postgres), move rate-limit counters to Redis, and move the
idempotency table along with the database. The SQL in this project is plain
enough that a Postgres port is mostly mechanical, but it is a real migration, not
a configuration flag.

---

## 7. Backups

The whole database is one file, so backing it up is a copy — but it must be a
*consistent* copy, which `cp` does not guarantee while the server is writing.
Use SQLite's own backup command:

```bash
# Daily, via cron. Safe to run against a live database.
sqlite3 /srv/quickbite/data/quickbite.db \
  ".backup '/srv/backups/quickbite-$(date +%F).db'"

find /srv/backups -name 'quickbite-*.db' -mtime +30 -delete
```

Restore by stopping the service, copying the backup over `quickbite.db`,
deleting any stale `-wal` and `-shm` files, and starting again.

Verify a backup occasionally — an untested backup is a guess:

```bash
sqlite3 /srv/backups/quickbite-2025-01-01.db \
  "PRAGMA integrity_check; SELECT COUNT(*) FROM orders;"
```

---

## 8. Operating it

**Logs.** One JSON object per request on stdout:

```json
{"t":"2025-01-01T12:00:00.000Z","id":"...","method":"GET","path":"/api/menu","status":200,"ms":4,"user":12}
```

No request bodies, headers, passwords or tokens are logged. Errors add a
`level:"error"` line carrying the same request `id`, which is also returned to
the client as `request_id` — so a user-reported failure can be traced to one log
line without them sending you anything sensitive.

Pipe stdout to your log collector; with systemd, `journalctl -u quickbite -f`.

**Health.** `GET /api/health` runs a real query, so it returns 503 if the
database is unreachable rather than falsely reporting healthy.

**Payments.** Point your gateway's webhook at `POST /api/payments/webhook` and
set `PAYMENT_WEBHOOK_SECRET` to the signing secret it gives you. The handler
verifies an HMAC-SHA256 signature over the raw body, rejects amount mismatches,
and ignores replays. To use a provider other than the sandbox, replace
`verifySignature` in `server/routes/payments.js` with that provider's scheme —
the surrounding order-state logic does not change.

---

## 9. Before going live — checklist

- [ ] `JWT_SECRET` and `PAYMENT_WEBHOOK_SECRET` set to long random values, not the examples
- [ ] `NODE_ENV=production`
- [ ] `DB_FILE` pointing at a **persistent** volume
- [ ] `TRUST_PROXY_HOPS` matching the actual proxy depth
- [ ] TLS terminating in front of the app
- [ ] A real admin account created; demo accounts **not** seeded
- [ ] Backups scheduled *and* one restore rehearsed
- [ ] `npm run audit:deps` clean
- [ ] Smoke test (§5) passing against the deployed URL
- [ ] Instance count is exactly 1
