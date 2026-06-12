#!/bin/sh
# Stable app launcher baked into the image: apply migrations, then serve.
# Deployments should use this as the container command (`codex-app`) instead
# of spelling out node invocations, so the launch sequence can change between
# releases without breaking compose files.
set -e
cd /app
node scripts/migrate.ts
exec node build
