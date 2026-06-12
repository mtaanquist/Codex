#!/bin/sh
# Stable worker launcher baked into the image. The worker runs the TypeScript
# sources directly under Node and needs the module-resolution hook in
# src/worker/register.js ($lib alias, extensionless imports, $env shim);
# launching it any other way crashes on the first aliased import. Deployments
# should use this as the container command (`codex-worker`) so the invocation
# can change between releases without breaking compose files.
set -e
cd /app
exec node --import ./src/worker/register.js src/worker/index.ts
