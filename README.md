# Codex

A writing workspace for long-form creative work: novels, serials,
worldbuilding, and TTRPG campaigns. Browser-based and self-hostable, with
your work stored as markdown that exports cleanly at any time.

- A distraction-free scene editor (CodeMirror) with live markdown, autosave,
  revision history, and focus mode.
- Worldbuilding that works while you write: characters, places, and lore are
  recognised in your prose, underlined, and one hover away; renames offer to
  sweep the old name through the text.
- Planning views: scene and story boards, relationship webs, an entity
  heatmap, and writing insights.
- Publishing: freeze an edition and share a public reading page, with EPUB
  and PDF downloads; invite reviewers by link for comments and suggested
  edits, no account needed.
- Multi-user with an approval gate, invite codes, two-factor, and passkeys,
  so one instance can host a circle of writers.
- Everything exports: per story, per universe, or the whole account as a
  zip of markdown.

## Run it

Codex is three containers: the app, a background worker (mention indexing,
email, exports, backups), and Postgres. Every tagged release publishes a
production image to GitHub Container Registry as
`ghcr.io/mtaanquist/codex`, tagged `vX.Y.Z`, `vX.Y` (the newest patch of that
minor version), and `latest` (the newest release).

A minimal deployment compose file:

```yaml
name: codex

services:
  app:
    image: ghcr.io/mtaanquist/codex:latest
    restart: unless-stopped
    # codex-app is baked into the image: applies pending database
    # migrations, then serves. Always use it rather than spelling out node
    # commands; the launch sequence can change between releases.
    command: codex-app
    # Loopback only, so clients reach the app solely through your proxy.
    ports:
      - '${APP_BIND:-127.0.0.1}:${APP_PORT:-3000}:3000'
    environment:
      DATABASE_URL: postgres://codex:${POSTGRES_PASSWORD}@db:5432/codex
      ORIGIN: ${ORIGIN}
      APP_SECRET: ${APP_SECRET}
      BODY_SIZE_LIMIT: 15M
      # Trust the proxy's forwarded client address for rate limiting.
      ADDRESS_HEADER: x-forwarded-for
      XFF_DEPTH: '1'
    healthcheck:
      test: ['CMD-SHELL', 'wget -q -T 5 -O /dev/null http://127.0.0.1:3000/healthz || exit 1']
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 3
    depends_on:
      db:
        condition: service_healthy

  worker:
    image: ghcr.io/mtaanquist/codex:latest
    restart: unless-stopped
    # codex-worker is baked into the image, like codex-app above.
    command: codex-worker
    # Time for running jobs to wind down on a stop or redeploy before Docker
    # kills the process; the worker hands back what is left before then.
    stop_grace_period: 60s
    environment:
      DATABASE_URL: postgres://codex:${POSTGRES_PASSWORD}@db:5432/codex
      ORIGIN: ${ORIGIN}
      APP_SECRET: ${APP_SECRET}
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:18.6-alpine3.24
    restart: unless-stopped
    environment:
      POSTGRES_USER: codex
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: codex
    volumes:
      - db-data:/var/lib/postgresql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U codex']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  db-data:
```

Put the three values in an `.env` file next to it:

- `POSTGRES_PASSWORD`: something strong; the app and worker pick it up.
- `ORIGIN`: the public URL the app is reached on, scheme included
  (`https://codex.example.com`). Form submissions are rejected when it does
  not match what the browser sees, and emailed links use it. The app and
  worker will not start without it.
- `APP_SECRET`: a long random value, kept stable. It encrypts secrets
  stored in the database and signs the two-factor and passkey challenges;
  without it those features are unavailable, and changing it later makes
  stored secrets unreadable.

Optionally set `APP_PORT` to publish the app on a different host port;
it defaults to 3000. The port is published on `127.0.0.1` only, so a proxy
on the same host reaches it and nothing else does. If your proxy runs on
another machine, set `APP_BIND` to an address only that proxy can reach,
never one open to the internet.

Then `docker compose up -d` and open the app on its port behind your
reverse proxy. Run both the app and the worker: mentions, email,
publishing exports, and backups all happen in the worker.

The example trusts the `X-Forwarded-For` header so rate limits see the real
client address; set `XFF_DEPTH` to the number of proxies in front of the app
if more than one. This is only safe while the proxy is the one thing that can
reach the app: anyone who can connect to the app port directly can send their
own header and dodge the per-address rate limits. If you ever expose the app
with no proxy in front, set `APP_BIND` to `0.0.0.0` and drop `ADDRESS_HEADER`
so a client cannot spoof its address.

Set `ADDRESS_HEADER` whenever there is a proxy in front of the app. Without it,
every request appears to come from the proxy's own address, so the per-address
sign-in rate limit collapses into a single shared counter and enough failed
sign-ins can lock the whole instance out at once.

The repository's own `compose.yaml` is the same stack built from source
instead of pulled, with every optional service wired up: bundled Caddy for
TLS (`COMPOSE_PROFILES=caddy`), a local RustFS for image uploads
(`COMPOSE_PROFILES=rustfs`), and off-site backups. `.env.example` documents
every variable: SMTP for outgoing email, `ASSET_S3_*` for image uploads,
`BACKUP_S3_*` for hourly database dumps to any S3-compatible bucket.

For the full operator guide - every variable, reverse-proxy examples for
Caddy, nginx, and Traefik, email and storage setup, the backup and restore
drill, health checks, and updates - see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

### Create the first admin

New accounts wait behind an approval gate, so the first account has to be
made from the command line. With the stack running:

```
docker compose exec -it app node scripts/seed-admin.ts you@example.com "Your Name"
```

You will be asked for a password, which is not shown as you type. This
account can sign in straight away and approves everyone who signs up after.
If an admin already exists, the command refuses and points you to the admin
panel instead.

### Update

Change the image tag (or pull `latest`), then `docker compose up -d`.
Pending migrations apply when the app or worker container starts. Migrations
are forward-only, so take a backup before updating if you are not running the
scheduled ones; with `BACKUP_S3_*` configured the worker keeps hourly dumps,
and `node scripts/restore-backup.ts latest` restores the newest.

## Develop

You need Node 26 and Docker.

```
npm install
cp .env.example .env          # defaults match the dev services below
docker compose -f compose.dev.yaml up -d   # Postgres and RustFS
npm run dev                   # the app, on http://localhost:5173
npm run worker                # in a second terminal
```

RustFS is the asset storage exports and image uploads need. Both stay hidden in
the app until asset storage is configured, and the end-to-end suite covers
them, so leave it running.

If your dev setup still runs MinIO, switch it over once: run
`docker compose -f compose.dev.yaml down --remove-orphans`, copy the
`ASSET_S3_ACCESS_KEY_ID` and `ASSET_S3_SECRET_ACCESS_KEY` values from
`.env.example` into your `.env`, and start the services again. The old
`codex-dev_minio-data` volume can then be removed with `docker volume rm`.

Run the worker too: without it mentions never index, and the Reference
panel stays empty.

Checks, in the order CI runs them:

```
npm run lint                  # prettier + eslint
npm run check                 # svelte-check
npm run test:unit -- --run    # unit + integration (throwaway database)
npm run test:e2e              # Playwright; builds and previews on its own port
```

Both suites create their own throwaway database, named for the checkout, and
the end-to-end preview server takes a port derived the same way. Two worktrees
can run tests at the same time without emptying each other's tables or, worse,
attaching to each other's preview server and testing the wrong branch. None of
that needs configuring.

To point a run somewhere else, pass it on the command line. These belong there
rather than in `.env`, which is the running instance's configuration:

```
TEST_DATABASE_URL=postgres://...  npm run test:unit -- --run
E2E_DATABASE_URL=postgres://...   npm run test:e2e
E2E_PORT=4173                     npm run test:e2e
```

Schema changes go through generated migrations: edit
`src/lib/server/db/schema.ts`, then `npx drizzle-kit generate`. Migrations
are additive and forward-only by convention.

### Develop against a copy of real data

With `BACKUP_S3_*` set, `npm run restore:prod-copy` pulls the newest backup
into a separate `codex_prod_copy` database, drops the service settings the
dump carries, and migrates it. Run the app and the worker against it together,
or they will use different databases:

```
npm run dev:prod-copy
npm run worker:prod-copy      # in a second terminal
```

It stays out of `codex`, which the end-to-end suite writes to. Leave
`APP_SECRET` unset so the restored credentials stay unreadable; the script
refuses to run otherwise. Accounts with two-factor enabled cannot sign in on
the copy, since their secrets were encrypted with the source instance's key.

## Layout

- `src/routes` - SvelteKit pages and API endpoints
- `src/lib/server` - database access, auth, and everything server-only
- `src/lib` - editor extensions and shared pure logic
- `src/worker` - the pg-boss background worker
- `src/lib/docs` - the in-app help articles
- `drizzle` - generated SQL migrations
- `tests`, `e2e` - integration (Vitest against Postgres) and Playwright
- `scratch` - design documents; planning material, not part of the app
- `TODO.md` - progress tracker and feedback backlog
- `scratch/system-design/history.md` - notes on how shipped work was built

## License

MIT.
