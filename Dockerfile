FROM node:24.22.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.22.0-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
# pg_dump and pg_restore for off-site backups; the major version must be
# able to talk to the postgres:18 server. Chromium renders the stored PDF
# exports in the worker (driven via puppeteer-core, which finds it on the
# usual paths); the font packages give it a serif to typeset with. The tag
# pins the Alpine release, so these packages only move with a base bump.
RUN apk add --no-cache postgresql18-client chromium font-liberation ttf-dejavu
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/build build
COPY --from=build /app/package.json package.json
# Runtime entry that feeds ORIGIN to adapter-node (see server.js).
COPY --from=build /app/server.js server.js
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
CMD ["codex-app"]
