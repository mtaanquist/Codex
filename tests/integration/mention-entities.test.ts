import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	relationTypes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { createRelationship } from '../../src/lib/server/relationships';
import { reviewMentionData } from '../../src/lib/server/mention-entities';
import { QUICK_CARD_DETAILS, QUICK_CARD_RELATED } from '../../src/lib/quick-card';
import type { Database } from '../../src/lib/server/auth';
import { ensureBuiltInRelationTypes, ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The story page and the author's review load every entity in the universe for
// mention detection; each one ships only what the quick card renders.

let pool: pg.Pool;
let db: Database;
let universeId: string;
let storyId: string;
let aliceId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table entity_relationships, entity_mentions, characters, stories, universes, users cascade'
	);
	await ensureBuiltInRelationTypes(pool);

	const [owner] = await db
		.insert(users)
		.values({ email: 'me@example.com', displayName: 'M', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: owner.id, name: 'U' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: owner.id, title: 'S' })
		.returning();
	storyId = story.id;

	const details = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
	const [alice] = await db
		.insert(characters)
		.values({ universeId, ownerId: owner.id, name: 'Alice', summaryMd: 'A smith.', details })
		.returning();
	aliceId = alice.id;

	const [rival] = await db
		.select({ id: relationTypes.id })
		.from(relationTypes)
		.where(and(isNull(relationTypes.universeId), eq(relationTypes.key, 'rival_of')));
	for (let i = 0; i < 6; i++) {
		const [other] = await db
			.insert(characters)
			.values({ universeId, ownerId: owner.id, name: `Other ${i}` })
			.returning();
		const made = await createRelationship(db, owner.id, {
			fromKind: 'character',
			fromId: aliceId,
			relationTypeId: rival.id,
			toId: other.id
		});
		expect(made).toMatchObject({ ok: true });
	}
});

afterAll(async () => {
	await pool.end();
});

describe('reviewMentionData', () => {
	it('trims details and related to the quick card counts for the full cast', async () => {
		const data = await reviewMentionData(db, {
			universeId,
			storyId,
			sceneIds: [],
			restrictToMentioned: false
		});
		expect(data.entities).toHaveLength(7);
		const alice = data.entities.find((entity) => entity.id === aliceId)!;
		expect(alice.summaryMd).toBe('A smith.');
		expect(alice.details).toEqual(
			Array.from({ length: QUICK_CARD_DETAILS }, (_, i) => ({ label: `L${i}`, value: `V${i}` }))
		);
		expect(alice.related).toHaveLength(QUICK_CARD_RELATED);
	});
});
