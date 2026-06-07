# Self-hosting Codex

This guide is for operators running their own Codex instance. The README has
the quickstart; this goes deeper on configuration, the reverse proxy, email,
storage, backups and restore, monitoring, and updates.

Codex is one Docker image run as three long-lived parts plus your database:

- **app**: serves the web app on port 3000. Sign-in, editing, publishing,
  uploads, and the admin panel.
- **worker**: runs background jobs. Mention indexing, outgoing email,
  publishing exports, scheduled backups, and the account and universe purges.
  Nothing in the app sends email or takes a backup directly; the worker does.
- **db**: PostgreSQL 18. Holds everything.
- Optional: **caddy** for TLS, and **minio** as a local S3 bucket for testing.

Run both the app and the worker. Without the worker, mentions never index (the
Reference panel stays empty), no email is sent, and no backups are taken.

## Requirements

- A host with Docker and Docker Compose.
- A PostgreSQL 18 database (the bundled `db` service, or your own).
- A public hostname and a TLS certificate for any real deployment, served by
  the bundled Caddy or a reverse proxy of your own.
- Optional but recommended: an S3-compatible bucket for off-site backups, and
  a separate one for uploaded images.

## First run

From a clean host:

```bash
git clone https://github.com/mtaanquist/Codex.git
cd Codex
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, ORIGIN, and APP_SECRET at minimum.
docker compose up -d
```

The app container applies pending database migrations on every start, so there
is no separate migration step. Watch for it to come up:

```bash
docker compose logs -f app   # wait for "Migrations applied." then the server
```

Then create the first admin (see below) and sign in at your `ORIGIN`.

The repository's `compose.yaml` builds the image from source and wires up every
optional service. To run released images instead of building, use the minimal
compose file in the README, which pulls `ghcr.io/mtaanquist/codex`.

### Create the first admin

New accounts wait behind an approval gate, so the first one is made from the
command line. With the stack running:

```bash
docker compose exec -it app node scripts/seed-admin.ts you@example.com "Your Name"
```

You are asked for a password, which is not echoed. For unattended provisioning,
pass it as `ADMIN_PASSWORD` in the environment instead. This account is
pre-verified and pre-approved, signs in immediately, and approves everyone who
signs up after. Once any admin exists the command refuses; manage further
admins from the admin panel.

## Environment variables

Two things read `.env`: the dev tooling, and Docker Compose for variable
substitution in `compose.yaml`. The app and worker receive the values Compose
passes through. Settings saved in the admin panel (SMTP, asset storage, backup
storage) win over the matching environment variables, which act as the initial
seed.

### Core

| Variable            | Required         | Default                 | Notes                                                                                                                                                                                                                                                                                                           |
| ------------------- | ---------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | yes              | dev local db            | PostgreSQL connection string. The bundled stack builds it from `POSTGRES_PASSWORD`.                                                                                                                                                                                                                             |
| `POSTGRES_PASSWORD` | yes (bundled db) | `codex`                 | Database password for the bundled `db` service. Set something strong.                                                                                                                                                                                                                                           |
| `ORIGIN`            | yes (prod)       | `http://localhost:3000` | The public URL, scheme and any non-standard port included. Form posts that do not match it are rejected.                                                                                                                                                                                                        |
| `APP_SECRET`        | recommended      | unset                   | Encrypts secrets at rest (SMTP password, two-factor secrets) and signs two-factor and passkey challenges. Keep it stable; changing it makes stored secrets unreadable and breaks two-factor until re-enrolled. Without it, two-factor and passkeys are unavailable and the panel cannot store an SMTP password. |
| `APP_PORT`          | no               | `3000`                  | Host port the app publishes. The container always listens on 3000.                                                                                                                                                                                                                                              |
| `BODY_SIZE_LIMIT`   | no               | `15M`                   | Upload cap for the Node adapter. Images are capped at 10 MB regardless.                                                                                                                                                                                                                                         |

### Reverse proxy

| Variable         | Default           | Notes                                                                                                                      |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ADDRESS_HEADER` | `x-forwarded-for` | Header to read the client address from, for rate limiting. Set empty if no proxy is in front, so a client cannot spoof it. |
| `XFF_DEPTH`      | `1`               | Number of proxies in front of the app. With one proxy, the default is correct.                                             |

### Email (SMTP)

| Variable        | Default                      | Notes                                                                 |
| --------------- | ---------------------------- | --------------------------------------------------------------------- |
| `SMTP_HOST`     | unset                        | With nothing set, email is written to the worker log instead of sent. |
| `SMTP_PORT`     | `587`                        | `465` for implicit TLS, `587` for STARTTLS.                           |
| `SMTP_SECURE`   | `false`                      | `true` for port 465.                                                  |
| `SMTP_USER`     | empty                        | SMTP username.                                                        |
| `SMTP_PASSWORD` | unset                        | Stored encrypted when set from the admin panel.                       |
| `SMTP_FROM`     | `Codex <no-reply@localhost>` | The From header.                                                      |

### Image storage (assets)

Uploaded images go to an S3-compatible bucket and are served back through the
app. Off until the endpoint, bucket, and both keys are set, here or in the
admin panel's Usage and storage section. **Use a different bucket from the
backups** (see the warning below).

| Variable                     | Default        | Notes                                                |
| ---------------------------- | -------------- | ---------------------------------------------------- |
| `ASSET_S3_ENDPOINT`          | unset          | Include the scheme. Empty disables uploads entirely. |
| `ASSET_S3_REGION`            | `auto`         |                                                      |
| `ASSET_S3_BUCKET`            | unset          | Required when the endpoint is set.                   |
| `ASSET_S3_PREFIX`            | `codex-assets` | Key prefix inside the bucket.                        |
| `ASSET_S3_ACCESS_KEY_ID`     | unset          | Required when the endpoint is set.                   |
| `ASSET_S3_SECRET_ACCESS_KEY` | unset          | Required when the endpoint is set.                   |

### Off-site backups

Scheduled database dumps to any S3-compatible bucket. Off until the endpoint,
bucket, and both keys are set. The schedule and retention are below; the bucket
details can also be set in the admin panel's Backups section.

| Variable                      | Default         | Notes                                      |
| ----------------------------- | --------------- | ------------------------------------------ |
| `BACKUP_S3_ENDPOINT`          | unset           | Include the scheme.                        |
| `BACKUP_S3_REGION`            | `auto`          |                                            |
| `BACKUP_S3_BUCKET`            | unset           | Required when the endpoint is set.         |
| `BACKUP_S3_PREFIX`            | `codex-backups` | Key prefix inside the bucket.              |
| `BACKUP_S3_ACCESS_KEY_ID`     | unset           | Required when the endpoint is set.         |
| `BACKUP_S3_SECRET_ACCESS_KEY` | unset           | Required when the endpoint is set.         |
| `BACKUP_CRON`                 | `0 * * * *`     | Schedule in UTC. Environment only.         |
| `BACKUP_KEEP_RECENT_HOURS`    | `48`            | Keep every dump from the last N hours.     |
| `BACKUP_KEEP_DAYS`            | `30`            | Then keep the newest per day, back N days. |

### Optional bundled services

| Variable              | Default              | Notes                                                                                  |
| --------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `COMPOSE_PROFILES`    | empty                | `caddy` runs the bundled TLS proxy; `minio` runs a local bucket. Combine with a comma. |
| `SITE_ADDRESS`        | `:80`                | Caddy: a bare domain obtains TLS; `:80` serves plain HTTP.                             |
| `HTTP_PORT`           | `80`                 | Caddy HTTP port.                                                                       |
| `HTTPS_PORT`          | `443`                | Caddy HTTPS port.                                                                      |
| `MINIO_ROOT_USER`     | `codex-minio`        | Credentials for the bundled MinIO; it creates the two buckets on first start.          |
| `MINIO_ROOT_PASSWORD` | `codex-minio-secret` |                                                                                        |

> **Keep assets and backups in separate buckets.** A restore writes the whole
> database back, including the rows that point at uploaded images. If the
> backup and asset buckets were the same, a restore could overwrite or prune
> your images. Use distinct buckets (or at least distinct prefixes on
> different lifecycle rules), and never point both at the same bundled MinIO in
> production. The bundled MinIO keeps data on the same host, so it is for
> testing, not disaster recovery; use an external provider (S3, B2, R2) for a
> real deployment.

## Reverse proxy and TLS

Codex serves plain HTTP on port 3000 and expects TLS to be terminated in front
of it. Set `ORIGIN` to the exact public URL the browser sees (scheme, host, and
any non-standard port). A mismatch rejects every form submission, so this is the
first thing to check if sign-in or saving fails with a 403.

Behind any proxy, set `ADDRESS_HEADER` to the header carrying the client
address (`x-forwarded-for` by default) and `XFF_DEPTH` to the number of proxies.
Without it, every request looks like it comes from the proxy, and the per-address
sign-in rate limit collapses into one shared counter that enough failed
attempts can trip for everyone at once.

### Bundled Caddy

Set `COMPOSE_PROFILES=caddy` and `SITE_ADDRESS` to your domain. Caddy obtains
and renews a certificate automatically and forwards to the app. Its config is
the whole `Caddyfile`:

```
{$SITE_ADDRESS}

reverse_proxy app:3000
```

Remember to set `ORIGIN=https://your.domain` to match.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name codex.example.com;
    ssl_certificate     /etc/letsencrypt/live/codex.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/codex.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

With `ORIGIN=https://codex.example.com`, the default `ADDRESS_HEADER` and
`XFF_DEPTH=1` are correct.

### Traefik (labels)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.codex.rule=Host(`codex.example.com`)
  - traefik.http.routers.codex.entrypoints=websecure
  - traefik.http.routers.codex.tls.certresolver=letsencrypt
  - traefik.http.services.codex.loadbalancer.server.port=3000
```

Traefik forwards `X-Forwarded-For` by default. Keep `ADDRESS_HEADER=x-forwarded-for`
and set `ORIGIN` to the HTTPS URL.

## Email

With no SMTP configured, the worker writes the body of every message it would
send to its log, which is enough to grab a verification or reset link during
setup. For real use, set the `SMTP_*` variables, or fill in the admin panel's
Email relay section and send yourself a test message from there. The panel
stores the password encrypted (this needs `APP_SECRET`), and its settings win
over the environment seed.

## Backups and restore

With the `BACKUP_S3_*` variables set, the worker dumps the database on the
`BACKUP_CRON` schedule (hourly by default, in UTC). A dump that is identical to
the last one is not re-uploaded. Retention is tiered: every dump from the last
`BACKUP_KEEP_RECENT_HOURS` hours, then the newest per day back `BACKUP_KEEP_DAYS`
days. The admin sees recent runs and a "Back up now" button on the library page.

To take one immediately from the command line:

```bash
docker compose exec app node scripts/run-backup.ts
```

### Restore drill

Practice this before you need it. The restore replaces the current database, so
take a fresh dump first if there is anything live worth keeping.

1. Stop the app and worker so nothing writes during the restore:

   ```bash
   docker compose stop app worker
   ```

2. Restore the newest dump (or pass a specific object key instead of `latest`):

   ```bash
   docker compose run --rm app node scripts/restore-backup.ts latest
   ```

   This streams the dump from the bucket into `pg_restore` against
   `DATABASE_URL`, dropping and recreating objects as it goes.

3. Bring the stack back:

   ```bash
   docker compose up -d
   ```

The dump excludes the job-queue tables, so any jobs that were pending at dump
time are not restored; the worker simply carries on with new ones. Uploaded
images live in the asset bucket, not the database, so they are unaffected by a
restore as long as that bucket is intact (the reason to keep it separate).

## Health checks and monitoring

`GET /healthz` is public and runs a `select 1`. It returns `200` with
`{"status":"ok"}` when the database is reachable and `503` with
`{"status":"error"}` when it is not. Point an uptime monitor or an orchestrator
liveness and readiness probe at it.

The worker logs one line per job to stdout; collect those if you want
visibility into indexing, email, exports, and backups. A failed backup is
logged there and shown in the admin panel's run history.

## Updating

Change the image tag (or pull `latest`) and run `docker compose up -d`. Pending
migrations apply when the app container starts. Migrations are forward-only, so
take a backup before updating if you are not running the scheduled ones; with
`BACKUP_S3_*` set the worker already keeps hourly dumps, and
`node scripts/restore-backup.ts latest` brings the newest one back.

## Scaling and replicas

Run a single app replica and a single worker. Two pieces of state are
per-process today:

- **Rate limiting** is held in memory, so each app replica would keep its own
  counters and the limits would not hold across them.
- **The worker's scheduled jobs** (backups, purges, the reconcile sweep) would
  run once per worker instance, so more than one worker means duplicate runs.

Scale the app vertically (a bigger host) rather than horizontally for now. A
shared rate-limit store is a prerequisite for multiple app replicas and is not
in place yet.

## Troubleshooting

- **Form submissions rejected (403), sign-in or saving fails.** `ORIGIN` does
  not match the URL the browser uses. Set it to the exact public URL, scheme
  and port included.
- **Sign-in rate limit seems global, or locks everyone out.** A proxy is in
  front but `ADDRESS_HEADER` is unset or wrong, so every request shares the
  proxy's address. Set it (`x-forwarded-for` for most proxies) and `XFF_DEPTH`.
- **No emails arrive.** SMTP is not configured; check the worker log for the
  message body, then set the `SMTP_*` variables or the admin Email relay
  section and send a test.
- **Image upload is missing from the UI.** Asset storage is not configured. Set
  the `ASSET_S3_*` variables or the admin Usage and storage section.
- **Two-factor or passkeys unavailable, or SMTP password will not save.**
  `APP_SECRET` is unset. Set a long random value and keep it stable.
- **A worker feature (email, backups, exports, mentions) does nothing.** The
  worker may be down. Check `docker compose ps` and the worker log.
