import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	characterStoryNotes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { saveCharacter } from '../../src/lib/server/characters';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let storyId: string;
let characterId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table character_story_notes, characters, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'cast@example.com', displayName: 'Cast', passwordHash: 'x', role: 'user' })
		.returning();
	const [stranger] = await db
		.insert(users)
		.values({ email: 'other@example.com', displayName: 'Other', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
	const [character] = await db
		.insert(characters)
		.values({ universeId: universe.id, ownerId, name: 'Alice' })
		.returning();
	characterId = character.id;
});

afterAll(async () => {
	await pool.end();
});

describe('saveCharacter', () => {
	it('updates fields and round-trips aliases', async () => {
		const result = await saveCharacter(db, characterId, ownerId, {
			name: 'Alice Vane',
			aliases: ['Allie', ' Mrs. Fenwick ', ''],
			summaryMd: 'A toll-road smuggler.',
			bodyMd: 'Knows every checkpoint between Halden and the pass.'
		});
		expect(result.ok).toBe(true);

		const [row] = await db.select().from(characters).where(eq(characters.id, characterId));
		expect(row.name).toBe('Alice Vane');
		expect(row.aliases).toEqual(['Allie', 'Mrs. Fenwick']);
		expect(row.summaryMd).toBe('A toll-road smuggler.');
	});

	it('upserts the per-story notes', async () => {
		const first = await saveCharacter(db, characterId, ownerId, {
			name: 'Alice Vane',
			aliases: [],
			summaryMd: null,
			bodyMd: '',
			storyId,
			storyNotesMd: 'Starts the book in debt.'
		});
		expect(first.ok).toBe(true);
		const second = await saveCharacter(db, characterId, ownerId, {
			name: 'Alice Vane',
			aliases: [],
			summaryMd: null,
			bodyMd: '',
			storyId,
			storyNotesMd: 'Starts the book in debt to Corvin.'
		});
		expect(second.ok).toBe(true);

		const rows = await db
			.select()
			.from(characterStoryNotes)
			.where(
				and(
					eq(characterStoryNotes.characterId, characterId),
					eq(characterStoryNotes.storyId, storyId)
				)
			);
		expect(rows).toHaveLength(1);
		expect(rows[0].notesMd).toBe('Starts the book in debt to Corvin.');
	});

	it('rejects a save by someone who does not own the character', async () => {
		const result = await saveCharacter(db, characterId, strangerId, {
			name: 'Hijacked',
			aliases: [],
			summaryMd: null,
			bodyMd: ''
		});
		expect(result).toMatchObject({ ok: false });
	});

	it('rejects an empty name', async () => {
		const result = await saveCharacter(db, characterId, ownerId, {
			name: '   ',
			aliases: [],
			summaryMd: null,
			bodyMd: ''
		});
		expect(result).toMatchObject({ ok: false });
	});
});
