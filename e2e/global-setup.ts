import pg from 'pg';
import { hash } from '@node-rs/argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Migrates the database the preview server uses and seeds the user the e2e
// tests sign in with. Idempotent, so repeated local runs are fine.
export default async function globalSetup() {
	const connectionString =
		process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex';
	const pool = new pg.Pool({ connectionString, max: 1 });
	await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
	const passwordHash = await hash('e2e-password', {
		memoryCost: 19456,
		timeCost: 2,
		parallelism: 1
	});
	await pool.query(
		`insert into users (email, display_name, password_hash, role, email_verified_at, approved_at)
		 values ($1, 'E2E Tester', $2, 'user', now(), now())
		 on conflict (email) do update set password_hash = excluded.password_hash`,
		['e2e@example.com', passwordHash]
	);
	await pool.end();
}
