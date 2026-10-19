import { runMigrations } from '../src/lib/server/db/migrate.ts';

// Applies pending migrations from ./drizzle. Run by both the app and the worker
// container on start; drizzle-kit stays a dev dependency and out of the image.
const connectionString = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';

await runMigrations(connectionString, 'drizzle');
console.log('Migrations applied.');
