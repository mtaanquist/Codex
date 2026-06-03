#!/usr/bin/env bash
# Bootstraps a Codex dev environment. Runs on SessionStart (see .claude/settings.json).
# Safe to run repeatedly, and safe to run locally: it no-ops until the app is
# scaffolded and prefers already-running services over starting new ones.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

# Start the Docker daemon. In the web sandbox Docker is installed but the daemon
# is not started automatically, which can make tooling believe Docker is missing.
# Done before the scaffold check so Docker is available in every session.
if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo "Starting Docker daemon..."
  if command -v service >/dev/null 2>&1; then
    service docker start >/dev/null 2>&1 || sudo service docker start >/dev/null 2>&1 || true
  fi
  if ! docker info >/dev/null 2>&1 && command -v dockerd >/dev/null 2>&1; then
    (sudo dockerd >/tmp/dockerd.log 2>&1 &) || (dockerd >/tmp/dockerd.log 2>&1 &) || true
  fi
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

# Nothing else to do until the SvelteKit app exists.
if [ ! -f package.json ]; then
  echo "No package.json yet; skipping app setup (scaffold the app first)."
  exit 0
fi

# Bring up Postgres. Prefer the compose database used for local dev; in the web
# sandbox Postgres is pre-installed but not running, so fall back to the service.
if command -v docker >/dev/null 2>&1 && [ -f compose.dev.yaml ]; then
  docker compose -f compose.dev.yaml up -d db || true
elif command -v pg_ctlcluster >/dev/null 2>&1; then
  service postgresql start >/dev/null 2>&1 || sudo service postgresql start >/dev/null 2>&1 || true
fi

# Wait briefly for Postgres to accept connections before migrating.
if command -v pg_isready >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    if pg_isready -q; then break; fi
    sleep 1
  done
fi

# Install dependencies on a fresh clone.
if [ ! -d node_modules ]; then
  npm install
fi

# Ensure Playwright browsers are present for headless UI checks. This is fast
# when they are already cached; system libraries are installed once in the web
# UI setup script (see .claude/web-environment.md).
if [ -x node_modules/.bin/playwright ]; then
  npx playwright install >/dev/null 2>&1 || true
fi

# Apply migrations once Drizzle is configured. Idempotent.
if [ -f drizzle.config.ts ]; then
  npx drizzle-kit migrate || true
fi

echo "Codex dev environment ready. Start the app with 'npm run dev' and the worker with 'npm run worker'."
