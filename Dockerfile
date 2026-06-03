FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/build build
COPY --from=build /app/package.json package.json
# Migrations (applied on app start) and operational scripts (seed-admin).
COPY --from=build /app/drizzle drizzle
COPY --from=build /app/scripts scripts
# The worker runs from source under Node's native TypeScript support.
COPY --from=build /app/src/worker src/worker
USER node
EXPOSE 3000
CMD ["node", "build"]
