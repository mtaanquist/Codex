import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { users } from '../../src/lib/server/db/schema';
import { savePreferences, userPreferences } from '../../src/lib/server/preferences';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let userId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'prefs@example.com', displayName: 'P', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
});

afterAll(async () => {
	await pool.end();
});

describe('appearance preferences', () => {
	it('defaults to the system theme and the default accent', async () => {
		const prefs = await userPreferences(db, userId);
		expect(prefs.theme).toBe('system');
		expect(prefs.accent).toBe('#5b8cff');
		// The editor defaults are untouched.
		expect(prefs.entityAutocomplete).toBe('popup');
		expect(prefs.continuousSceneMarks).toBe('shown');
	});

	it('round-trips theme and accent without disturbing other keys', async () => {
		await savePreferences(db, userId, { entityAutocomplete: 'ghost' });
		await savePreferences(db, userId, { theme: 'dark', accent: '#2fae8c' });
		const prefs = await userPreferences(db, userId);
		expect(prefs.theme).toBe('dark');
		expect(prefs.accent).toBe('#2fae8c');
		// The jsonb merge kept the earlier autocomplete choice.
		expect(prefs.entityAutocomplete).toBe('ghost');
	});

	it('falls back when a stored value is unrecognised', async () => {
		await db
			.update(users)
			.set({ preferences: { theme: 'neon', accent: 'chartreuse' } })
			.where(eq(users.id, userId));
		const prefs = await userPreferences(db, userId);
		expect(prefs.theme).toBe('system');
		expect(prefs.accent).toBe('#5b8cff');
	});
});
