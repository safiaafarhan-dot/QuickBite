# Deploying QuickBite

> **Nothing here has been deployed.** This document describes how to deploy; no
> hosting account, domain or gateway has been configured, and no deployment has
> been attempted. Treat every command below as untested against a real host.
>
> What *has* been tested is the application itself against a real PostgreSQL 18
> — the full suite, the migration, the seed and the SQLite import. See §9.

---

## 1. What the app needs

| Requirement | Detail |
| --- | --- |
| Runtime | Node **22.5+** |
| Build step | None — Express serves the static front end directly |
| Database | **PostgreSQL 13+**, reached over the network via `DATABASE_URL` |
| Persistent disk | **None.** The container is stateless; everything lives in PostgreSQL |
| Processes | One is recommended — see the note below |
| Outbound network | PostgreSQL, plus Anthropic only if `ANTHROPIC_API_KEY` is set |

The app writes nothing to its own filesystem, so it fits a free, ephemeral
container host perfectly well. Running more than one instance is now *safe*
(PostgreSQL has no single-writer limit, and the schema migration takes an
advisory lock so two instances deploying at once cannot race). The only thing
that degrades is rate limiting, which is counted per process: two instances
means roughly twice the configured ceiling. Lower `API_RATE_LIMIT_MAX`
accordingly, or keep one instance.

---

## 2. Configuration

Copy `.env.example` to `.env` and fill it in. The variables that actually matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | *(none)* | **Required. The server refuses to start without it.** |
| `JWT_SECRET` | *(none)* | **Required when `NODE_ENV=production`.** Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `NODE_ENV` | `development` | `production` enables HSTS and hides stack traces |
| `PORT` | `3000` | Render injects this; the server honours it |
| `TRUST_PROXY_HOPS` | `0` | **Set to `1` on Render**, so rate limiting sees the real client IP rather than the proxy's |
| `PAYMENT_WEBHOOK_SECRET` | *(none)* | Without it the payment webhook rejects everything with 503 |
| `PGPOOL_MAX` | `8` | Connection pool ceiling |
| `PGSSL_STRICT` | `0` | `1` to verify the database's certificate properly (needs `PGSSLROOTCERT`) |
| `ANTHROPIC_API_KEY` | *(none)* | Optional. Without it the assistant uses its built-in rules |

Rotating `JWT_SECRET` signs every existing session out. That is the intended way
to revoke all tokens, since the tokens themselves are stateless.

**Never commit a filled-in `DATABASE_URL`.** It contains the database password.

---

## 3. Free deployment: Render + Supabase

This is the ₹0/month path. Both tiers are genuinely free; neither asks for a
card.

### 3a. Create the database (Supabase)

1. supabase.com → **New project**. Pick a region near your users and set a
   strong database password — you will not be shown it again.
2. **Project Settings → Database → Connection string → Transaction**.
3. Copy that URI and replace `[YOUR-PASSWORD]` with the password you set.

It looks like:

```
postgresql://postgres.abcdefghijkl:PASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
```

**Use the Transaction pooler on port 6543, not the direct connection on 5432.**
The free tier caps how many server-side connections you may hold open, and the
pooler is what keeps a restarting web service from exhausting it.

> Supabase pauses a free project after a week with no activity. It resumes on
> the next connection, but the first request after a pause is slow. If the
> project stays paused long enough Supabase will eventually delete it — keep a
> backup (§7).

### 3b. Create the web service (Render)

1. render.com → **New → Web Service**, connect the GitHub repository.
2. Runtime **Node**, Build command `npm ci`, Start command `npm start`.
3. Instance type **Free**.
4. Add the environment variables from §2. At minimum:

   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | the Supabase URI from 3a |
   | `JWT_SECRET` | a fresh 48-byte random hex string |
   | `PAYMENT_WEBHOOK_SECRET` | another random string |
   | `NODE_ENV` | `production` |
   | `TRUST_PROXY_HOPS` | `1` |

   `PORT` is injected by Render — do not set it yourself.

5. Deploy.

The repository includes `render.yaml`, so you can instead point Render at the
blueprint and it will create the service with the right commands; it still asks
you for the secret values, which is the point — they are marked `sync: false`
so they never live in git.

### 3c. Create the schema

Migrations run automatically before the server accepts traffic: `server/index.js`
awaits `initDb()` — which applies migrations and loads the reference menu —
before it opens the port. The Docker image also runs `scripts/migrate.js` from
its `CMD` first.

> Render's `preDeployCommand` is **not** used, because Render offers pre-deploy
> only on paid instance types and rejects a free-plan blueprint that declares
> one. Boot-time migration covers the free plan; on a paid plan you can add
> `preDeployCommand: npm run migrate` to `render.yaml` to migrate before the
> new instance takes traffic.

To migrate by hand from your own machine:

```bash
export DATABASE_URL='postgresql://...'   # the Supabase URI
npm run migrate            # create/update the schema and load the 30-dish menu
npm run migrate:status     # report only, changes nothing
npm run seed               # OPTIONAL: demo accounts + 45 days of fake orders
```

All three are safe to run repeatedly. `migrate` applies each migration at most
once and takes an advisory lock so two deploys cannot race; `seed` skips
anything it already created.

> Run `npm run seed` only if you want the demo data. It inserts clearly-marked
> synthetic orders (codes begin `QB-D`) so the analytics dashboard has
> something to show. Do not run it on a database holding real orders.

### 3d. Free-tier realities

- **Render Free sleeps after 15 minutes of inactivity.** The next request takes
  roughly 30–60 seconds while it wakes. This is the single most noticeable
  thing about the free tier.
- **Render Free gives 750 instance-hours a month**, enough for one service
  running continuously.
- **Supabase Free gives 500 MB.** QuickBite's schema is tiny; the 286-order
  demo database is well under 5 MB.
- A keep-alive pinger defeats the sleep but burns your instance hours and
  Supabase's activity allowance. It is usually not worth it.

---

## 4. Migrating existing SQLite data

If you already ran QuickBite on SQLite and want to keep those orders:

```bash
export DATABASE_URL='postgresql://...'

# 1. Look before you leap. This writes nothing.
node scripts/import-sqlite.js ./data/quickbite.db

# 2. Do it.
node scripts/import-sqlite.js ./data/quickbite.db --write
```

The importer:

- opens the SQLite file **read-only** and never modifies it;
- copies users, orders, order items and events, addresses, reviews, coupon
  redemptions, idempotency keys, payment events and browsing events;
- **keeps the original primary keys**, so every foreign key still resolves, and
  resets each identity sequence afterwards so the next insert does not collide;
- **does not copy the menu or the coupons.** Those are reference data, rebuilt
  from `server/data/menu.js` on every boot. Instead it **remaps every
  `item_id` by dish name**, because a freshly seeded menu need not be numbered
  the way an old SQLite file was. Copying those ids verbatim would silently
  re-point historical orders at the wrong dishes — every figure in the
  dashboard would still add up, and every one would be wrong;
- treats SQLite's timestamps as UTC and says so explicitly, so nothing shifts
  by your server's offset;
- runs as **one transaction** — a failure leaves the target untouched;
- **refuses to import into a table that already holds rows** unless you pass
  `--force`, so it cannot quietly double an earlier run.

Afterwards, check the row counts and spot-check an old order in the UI. Keep
the `.db` file until you are satisfied.

---

## 5. Subsequent deploys

```bash
git pull
npm ci --omit=dev
npm run migrate      # idempotent; applies anything new
# restart the service
```

On Render this is just a push: the build command reinstalls, the service
restarts, and the new instance migrates during boot before it opens the port.

Migrations are forward-only and additive. None of them drops or rewrites a
table holding user data.

---

## 6. Smoke test

Run these against the deployed URL. Each should behave exactly as described.

```bash
BASE=https://your-service.onrender.com

# 1. The service is up AND the database answers.
curl -s $BASE/api/health
#    expect: {"ok":true,"status":"healthy","migrations":8,"menu_items":30,...}
#    "database" names the host and database, never the password.

# 2. The menu loads.
curl -s "$BASE/api/menu" | head -c 200

# 3. Search is case-insensitive (it uses ILIKE).
curl -s "$BASE/api/menu?q=BIRYANI" | head -c 120

# 4. Security headers are present.
curl -sI $BASE/ | grep -Ei 'content-security-policy|x-frame-options|x-content-type'

# 5. The server does not advertise itself.
curl -sI $BASE/ | grep -i 'x-powered-by'     # expect: no output

# 6. Protected routes are closed.
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/orders        # expect 401
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/admin/stats   # expect 401

# 7. The front end is served.
curl -s $BASE/ | grep -c QuickBite            # expect a non-zero count

# 8. A dish photo loads.
curl -s -o /dev/null -w '%{http_code}\n' $BASE/images/dishes/margherita-pizza.jpg
```

Then, in a browser: sign in, add a dish, apply `QUICK10`, check out, and watch
the order advance on `/orders.html`.

---

## 7. Backups

The database is no longer a file you can copy, which is the one real cost of
this move. Supabase takes daily backups on the free tier; take your own before
anything risky:

```bash
# A full logical backup. Restores with psql.
pg_dump "$DATABASE_URL" > quickbite-$(date +%F).sql

# Restore into an empty database.
psql "$NEW_DATABASE_URL" < quickbite-2026-01-01.sql
```

`npm run migrate -- --backup` has been **removed**: it copied a file, and there
is no file. The command refuses with the `pg_dump` line above rather than
pretending to have worked.

Keep backups off the host, and test a restore at least once — an untested
backup is a guess.

---

## 8. Other platforms

### Docker

```bash
docker build -t quickbite .
docker run -d --name quickbite -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e JWT_SECRET='...' \
  -e PAYMENT_WEBHOOK_SECRET='...' \
  -e NODE_ENV=production \
  quickbite
```

No volume, and no `VOLUME` line in the Dockerfile any more. The container holds
no state, so it can be replaced, scaled or moved without losing an order.

### Fly.io, Railway, a VPS

All work the same way: set `DATABASE_URL`, run `npm run migrate`, start the
process. A persistent disk is no longer needed anywhere.

### Serverless / multi-replica

Now viable, with one caveat: rate limiting is per-process, so N replicas means
N times the configured ceiling. Divide `API_RATE_LIMIT_MAX` and
`AUTH_RATE_LIMIT_MAX` by the replica count, or move the limiter to a shared
store.

---

## 9. What was actually verified

Against a real PostgreSQL 18.4 (not a mock, not an emulator):

- the full test suite — **182 tests, 182 passing, 0 skipped**;
- `npm run migrate` on an empty database, and again (idempotent);
- `npm run seed`, and again (no duplicate users, orders or coupons);
- `node scripts/import-sqlite.js --write` against a real 286-order SQLite
  file: 2,419 rows, zero dangling references, zero mis-pointed dish lines;
- the server booting and serving the real API: menu, search, cart, checkout,
  orders, admin stats, analytics, forecast, recommender, assistant.

Not verified: Supabase and Render themselves. Nothing has been deployed.

---

## 10. Before going live — checklist

- [ ] `DATABASE_URL` set, and **not** committed anywhere
- [ ] `JWT_SECRET` set to a fresh 48-byte random value
- [ ] `PAYMENT_WEBHOOK_SECRET` set
- [ ] `NODE_ENV=production`
- [ ] `TRUST_PROXY_HOPS=1` behind Render's proxy
- [ ] `npm run migrate` run, `/api/health` reports `migrations: 8`
- [ ] HTTPS in front (Render terminates TLS for you)
- [ ] A backup taken, and a restore tested
- [ ] Smoke test in §6 passes
- [ ] Demo seed **not** run on a database holding real orders
