import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { universes, users } from '../../src/lib/server/db/schema';
import { slugTaken, uniqueSlug } from '../../src/lib/server/slugs';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let otherId: string;
let universeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table stories, universes, users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'slug@example.com', displayName: 'S', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [other] = await db
		.insert(users)
		.values({ email: 'slug2@example.com', displayName: 'S2', passwordHash: 'x', role: 'user' })
		.returning();
	otherId = other.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	universeId = universe.id;
});

afterAll(async () => {
	await pool.end();
});

describe('uniqueSlug', () => {
	it('uses the plain slug when free', async () => {
		expect(await uniqueSlug(db, 'universes', ownerId, 'Eressëa', 'universe')).toBe('eressea');
	});

	it('suffixes within the owner, counting past gaps', async () => {
		expect(await uniqueSlug(db, 'universes', ownerId, 'Ardenfall', 'universe')).toBe('ardenfall-2');
		await db.insert(universes).values({ ownerId, name: 'Ardenfall', slug: 'ardenfall-2' });
		expect(await uniqueSlug(db, 'universes', ownerId, 'Ardenfall', 'universe')).toBe('ardenfall-3');
	});

	it('another owner gets the plain slug', async () => {
		expect(await uniqueSlug(db, 'universes', otherId, 'Ardenfall', 'universe')).toBe('ardenfall');
	});

	it('falls back when the name slugs to nothing', async () => {
		expect(await uniqueSlug(db, 'stories', ownerId, '***', 'story')).toBe('story');
	});
});

describe('slugTaken', () => {
	it("sees the owner's other rows but not its own", async () => {
		expect(await slugTaken(db, 'universes', ownerId, 'ardenfall', universeId)).toBe(false);
		expect(await slugTaken(db, 'universes', ownerId, 'ardenfall-2', universeId)).toBe(true);
		expect(await slugTaken(db, 'universes', otherId, 'ardenfall', universeId)).toBe(false);
	});
});
