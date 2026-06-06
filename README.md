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
`ghcr.io/mtaanquist/codex`, tagged `vX.Y.Z`, `vX.Y`, and `latest`.

A minimal deployment compose file:

```yaml
name: codex

services:
  app:
    image: ghcr.io/mtaanquist/codex:latest
    restart: unless-stopped
    # Applies pending database migrations, then serves.
    command: sh -c "node scripts/migrate.ts && node build"
    ports:
      - '3000:3000'
    environment:
      DATABASE_URL: postgres://codex:${POSTGRES_PASSWORD}@db:5432/codex
      ORIGIN: ${ORIGIN}
      APP_SECRET: ${APP_SECRET}
      BODY_SIZE_LIMIT: 15M
    depends_on:
      db:
        condition: service_healthy

  worker:
    image: ghcr.io/mtaanquist/codex:latest
    restart: unless-stopped
    command: node src/worker/index.ts
    environment:
      DATABASE_URL: postgres://codex:${POSTGRES_PASSWORD}@db:5432/codex
      APP_SECRET: ${APP_SECRET}
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:18-alpine
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
  not match what the browser sees.
- `APP_SECRET`: a long random value, kept stable. It encrypts secrets
  stored in the database and signs the two-factor and passkey challenges;
  without it those features are unavailable, and changing it later makes
  stored secrets unreadable.

Then `docker compose up -d` and open the app on port 3000 behind your
reverse proxy. Run both the app and the worker: mentions, email,
publishing exports, and backups all happen in the worker.

The repository's own `compose.yaml` is the same stack built from source
instead of pulled, with every optional service wired up: bundled Caddy for
TLS (`COMPOSE_PROFILES=caddy`), a local MinIO for image uploads
(`COMPOSE_PROFILES=minio`), and off-site backups. `.env.example` documents
every variable: SMTP for outgoing email, `ASSET_S3_*` for image uploads,
`BACKUP_S3_*` for hourly database dumps to any S3-compatible bucket.

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
Pending migrations apply when the app container starts. Migrations are
forward-only, so take a backup before updating if you are not running the
scheduled ones; with `BACKUP_S3_*` configured the worker keeps hourly dumps,
and `node scripts/restore-backup.ts latest` restores the newest.

## Develop

You need Node 24 and Docker.

```
npm install
cp .env.example .env          # defaults match the dev database below
docker compose -f compose.dev.yaml up -d   # Postgres only
npm run dev                   # the app, on http://localhost:5173
npm run worker                # in a second terminal
```

Run the worker too: without it mentions never index, and the Reference
panel stays empty.

Checks, in the order CI runs them:

```
npm run lint                  # prettier + eslint
npm run check                 # svelte-check
npm run test:unit -- --run    # unit + integration (throwaway codex_test db)
npm run test:e2e              # Playwright; builds and previews on :4173
```

Schema changes go through generated migrations: edit
`src/lib/server/db/schema.ts`, then `npx drizzle-kit generate`. Migrations
are additive and forward-only by convention.

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

## License

MIT.
