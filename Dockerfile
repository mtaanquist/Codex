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
USER node
EXPOSE 3000
CMD ["node", "build"]
