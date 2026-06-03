import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Applies pending migrations from ./drizzle. Used by the app container on
// start; drizzle-kit stays a dev dependency and out of the image.
const connectionString = process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';

const pool = new pg.Pool({ connectionString, max: 1 });
await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
await pool.end();
console.log('Migrations applied.');
