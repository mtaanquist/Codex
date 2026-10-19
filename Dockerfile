FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# pg_dump and pg_restore for off-site backups; the major version must be
# able to talk to the postgres:18 server. Chromium renders the stored PDF
# exports in the worker (driven via puppeteer-core); the font packages give
# it a serif to typeset with.
RUN apk add --no-cache postgresql18-client chromium font-liberation ttf-dejavu
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/build build
COPY --from=build /app/package.json package.json
# Migrations (applied on app start) and operational scripts (seed-admin).
COPY --from=build /app/drizzle drizzle
COPY --from=build /app/scripts scripts
# The worker runs from source under Node's native TypeScript support; it
# imports from src/lib (schema, mention pipeline), so both come along.
COPY --from=build /app/src/worker src/worker
COPY --from=build /app/src/lib src/lib
# Stable launch commands, so a deployment's compose file can say `codex-app`
# and `codex-worker` and survive launch-sequence changes between releases.
RUN cp scripts/start-app.sh /usr/local/bin/codex-app && \
    cp scripts/start-worker.sh /usr/local/bin/codex-worker && \
    chmod +x /usr/local/bin/codex-app /usr/local/bin/codex-worker
USER node
EXPOSE 3000
# Probes the app's /healthz. The start period covers migrations on boot. The
# worker runs from this image too but serves no HTTP, so its compose service
# turns the check off.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -T 5 -O /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1
CMD ["codex-app"]
