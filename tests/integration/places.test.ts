import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { places, placeStoryNotes, stories, universes, users } from '../../src/lib/server/db/schema';
import { savePlace } from '../../src/lib/server/places';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let storyId: string;
let placeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table place_story_notes, places, stories, universes, users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'geo@example.com', displayName: 'Geo', passwordHash: 'x', role: 'user' })
		.returning();
	const [stranger] = await db
		.insert(users)
		.values({ email: 'not-geo@example.com', displayName: 'No', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
	const [place] = await db
		.insert(places)
		.values({ universeId: universe.id, ownerId, name: 'Halden' })
		.returning();
	placeId = place.id;
});

afterAll(async () => {
	await pool.end();
});

describe('savePlace', () => {
	it('updates fields and reports a rename as mentions-affecting', async () => {
		const renamed = await savePlace(db, placeId, ownerId, {
			name: 'Halden Gate',
			aliases: [],
			summaryMd: 'The toll town at the pass.',
			bodyMd: 'Stone walls, one gate, two prices.'
		});
		expect(renamed).toMatchObject({ ok: true, mentionsAffected: true });

		const unchanged = await savePlace(db, placeId, ownerId, {
			name: 'Halden Gate',
			aliases: [],
			summaryMd: 'Body-only edits do not reindex.',
			bodyMd: 'New body.'
		});
		expect(unchanged).toMatchObject({ ok: true, mentionsAffected: false });

		const [row] = await db.select().from(places).where(eq(places.id, placeId));
		expect(row.name).toBe('Halden Gate');
	});

	it('round-trips aliases and reports their change as mentions-affecting', async () => {
		const withAliases = await savePlace(db, placeId, ownerId, {
			name: 'Halden Gate',
			aliases: ['The Gate', ' Toll Town ', ''],
			summaryMd: null,
			bodyMd: ''
		});
		expect(withAliases).toMatchObject({ ok: true, mentionsAffected: true });
		const [row] = await db.select().from(places).where(eq(places.id, placeId));
		expect(row.aliases).toEqual(['The Gate', 'Toll Town']);

		const sameAliases = await savePlace(db, placeId, ownerId, {
			name: 'Halden Gate',
			aliases: ['The Gate', 'Toll Town'],
			summaryMd: 'Unchanged names.',
			bodyMd: 'New body.'
		});
		expect(sameAliases).toMatchObject({ ok: true, mentionsAffected: false });

		const cleared = await savePlace(db, placeId, ownerId, {
			name: 'Halden Gate',
			aliases: [],
			summaryMd: null,
			bodyMd: ''
		});
		expect(cleared).toMatchObject({ ok: true, mentionsAffected: true });
	});

	it('upserts the per-story notes', async () => {
		for (const notes of ['First pass.', 'Second pass.']) {
			const result = await savePlace(db, placeId, ownerId, {
				name: 'Halden Gate',
				aliases: [],
				summaryMd: null,
				bodyMd: '',
				storyId,
				storyNotesMd: notes
			});
			expect(result.ok).toBe(true);
		}
		const rows = await db
			.select()
			.from(placeStoryNotes)
			.where(and(eq(placeStoryNotes.placeId, placeId), eq(placeStoryNotes.storyId, storyId)));
		expect(rows).toHaveLength(1);
		expect(rows[0].notesMd).toBe('Second pass.');
	});

	it('rejects a save by someone who does not own the place', async () => {
		const result = await savePlace(db, placeId, strangerId, {
			name: 'Hijacked',
			aliases: [],
			summaryMd: null,
			bodyMd: ''
		});
		expect(result).toMatchObject({ ok: false });
	});
});
