# Developing Codex with Claude Code on the web

Config for the web sandbox is split in two. The repo carries what can be committed; the rest is set once in the web UI environment settings.

## In the repo (already here)

- `.claude/settings.json` - permissions tuned for this stack (npm, npx, pnpm, docker compose, drizzle-kit, git, psql), secret files denied, and a `SessionStart` hook.
- `scripts/session-setup.sh` - the hook target. On each session it starts the Docker daemon (the sandbox installs Docker but never starts it, which can make tooling think Docker is missing), starts Postgres (compose database if present, otherwise the sandbox's built-in Postgres), installs dependencies on a fresh clone, ensures Playwright browsers are present, and runs Drizzle migrations. The daemon start runs even before the app is scaffolded; the rest no-ops until then, so it is safe to commit now.

Only `.claude/settings.json` reaches the cloud. Add `.claude/settings.local.json` (personal overrides) and `.env*` to `.gitignore`; they never leave your machine.

## In the web UI (set once per environment)

The sandbox comes with Node (20/21/22, plus npm/pnpm/yarn), Docker and docker compose, and PostgreSQL 16 and Redis preinstalled. The filesystem is fresh each session (the repo is cloned from your branch), and database contents are ephemeral.

1. **Network access:** `Trusted` is enough. It already covers npm and Docker Hub. Only switch to `Custom` and add domains if you point at an external managed database or API.
2. **Environment variables:** set anything secret here rather than in the repo. At minimum `DATABASE_URL` if you are not using the committed default. Note that variables set in the UI are visible to anyone who can edit the environment, so use a throwaway dev database, not a production one.
3. **Setup script (recommended):** the UI setup script runs once per environment and is cached, which makes it the place for slow, rarely-changing steps. Use it to install the Playwright system libraries and browsers once, so headless layout and behaviour checks work without re-downloading each session, and to warm image caches:

   ```bash
   npx playwright install --with-deps
   docker compose pull || true
   ```

   Routine per-session work (Docker daemon start, database start, install, migrate, ensure browsers) is already handled by `scripts/session-setup.sh`.

## Database choices

- **Ephemeral (default):** the committed `DATABASE_URL` points at `localhost:5432`, which the setup script brings up. Data is lost between sessions. This is the right choice for normal feature work; it matches a fresh `docker compose` locally.
- **Persistent:** if you want data to survive across sessions, set `DATABASE_URL` in the UI to a managed Postgres (Neon, Supabase, or similar) and set network access to `Custom` with that host allowed.

## Requirements checklist

- Node 20+ (preinstalled).
- PostgreSQL reachable at `DATABASE_URL` (preinstalled; started by the setup script).
- Docker daemon started each session (handled by `scripts/session-setup.sh`).
- Playwright available for headless UI checks (system libraries warmed once via the UI setup script; browsers ensured per session).
- The repo's `.claude/settings.json` and `scripts/session-setup.sh` committed.
- `DATABASE_URL` and any secrets provided via the UI environment for cloud sessions, and via a local `.env` for local sessions.
- `.env*` and `.claude/settings.local.json` git-ignored.
