import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	characters,
	entityMentions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	listStaleMentionScenes,
	rebuildSceneMentions,
	rebuildUniverseMentions,
	reconcileMentions
} from '../../src/lib/server/mentions';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let universeId: string;
let sceneId: string;
let aliceId: string;

async function mentionRows(source: string) {
	return await db
		.select()
		.from(entityMentions)
		.where(eq(entityMentions.sourceId, source))
		.orderBy(asc(entityMentions.position));
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table entity_mentions, scenes, chapters, characters, stories, universes, users cascade'
	);

	const [user] = await db
		.insert(users)
		.values({ email: 'idx@example.com', displayName: 'Idx', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db.insert(universes).values({ ownerId: user.id, name: 'U' }).returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: user.id, title: 'S' })
		.returning();
	const [scene] = await db
		.insert(scenes)
		.values({
			storyId: story.id,
			globalPosition: 1,
			bodyMd: 'Alice counted the coin into the dark. "Mrs. Fenwick," said Bram.'
		})
		.returning();
	sceneId = scene.id;

	const [alice] = await db
		.insert(characters)
		.values({
			universeId,
			ownerId: user.id,
			name: 'Alice',
			aliases: ['Mrs. Fenwick']
		})
		.returning();
	aliceId = alice.id;
	// Bram opted out of detection (a common-word name).
	await db.insert(characters).values({
		universeId,
		ownerId: user.id,
		name: 'Bram',
		autoDetectMentions: false
	});
});

afterAll(async () => {
	await pool.end();
});

describe('rebuildSceneMentions', () => {
	it('indexes names and aliases with positions and snippets', async () => {
		const result = await rebuildSceneMentions(db, sceneId);
		expect(result).toMatchObject({ ok: true, count: 2 });

		const rows = await mentionRows(sceneId);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.targetId)).toEqual([aliceId, aliceId]);
		expect(rows[0].position).toBe(0);
		expect(rows[0].surroundingText).toContain('Alice counted the coin');
		expect(rows[1].surroundingText).toContain('Mrs. Fenwick');
	});

	it('skips characters with auto-detect off', async () => {
		const rows = await mentionRows(sceneId);
		expect(rows.every((row) => row.targetId === aliceId)).toBe(true);
	});

	it('replaces rows on rebuild instead of accumulating', async () => {
		await rebuildSceneMentions(db, sceneId);
		await rebuildSceneMentions(db, sceneId);
		expect(await mentionRows(sceneId)).toHaveLength(2);
	});

	it('reflects an edited body', async () => {
		await db.update(scenes).set({ bodyMd: 'Nobody here at all.' }).where(eq(scenes.id, sceneId));
		const result = await rebuildSceneMentions(db, sceneId);
		expect(result).toMatchObject({ ok: true, count: 0 });
		expect(await mentionRows(sceneId)).toHaveLength(0);
	});

	it('reports a missing scene', async () => {
		expect(await rebuildSceneMentions(db, crypto.randomUUID())).toMatchObject({ ok: false });
	});
});

describe('place mentions', () => {
	it('indexes place names alongside characters', async () => {
		await db.insert(schema.places).values({
			universeId,
			ownerId: (await db.select({ id: users.id }).from(users).limit(1))[0].id,
			name: 'Halden Gate'
		});
		await db
			.update(scenes)
			.set({ bodyMd: 'Alice reached Halden Gate by dusk.' })
			.where(eq(scenes.id, sceneId));
		const result = await rebuildSceneMentions(db, sceneId);
		expect(result).toMatchObject({ ok: true, count: 2 });
		const rows = await mentionRows(sceneId);
		expect(rows.map((row) => row.targetType).sort()).toEqual(['character', 'place']);
	});
});

describe('lore mentions', () => {
	it('indexes lore titles and keywords', async () => {
		const owner = (await db.select({ id: users.id }).from(users).limit(1))[0].id;
		const [category] = await db
			.insert(schema.entityCategories)
			.values({ universeId, ownerId: owner, name: 'Lore', sortOrder: 0 })
			.returning();
		await db.insert(schema.loreEntries).values({
			universeId,
			ownerId: owner,
			categoryId: category.id,
			title: 'Toll-pass',
			keywords: ['pass-stamp']
		});
		await db
			.update(scenes)
			.set({ bodyMd: 'She held the pass-stamp high; the Toll-pass was hers.' })
			.where(eq(scenes.id, sceneId));
		const result = await rebuildSceneMentions(db, sceneId);
		expect(result).toMatchObject({ ok: true, count: 2 });
		const rows = await mentionRows(sceneId);
		expect(rows.every((row) => row.targetType === 'lore_entry')).toBe(true);
	});
});

describe('rebuildUniverseMentions', () => {
	it('reindexes every scene in the universe', async () => {
		await db
			.update(scenes)
			.set({ bodyMd: 'Alice again, twice: Alice.' })
			.where(eq(scenes.id, sceneId));
		const count = await rebuildUniverseMentions(db, universeId);
		expect(count).toBe(1);
		expect(await mentionRows(sceneId)).toHaveLength(2);
	});
});

describe('reconcile', () => {
	// Timestamps are forced with the database's own now() so the comparison does
	// not depend on app-vs-database clock skew.
	it('treats a freshly indexed scene as up to date', async () => {
		await pool.query(`update scenes set updated_at = now() - interval '5 seconds' where id = $1`, [
			sceneId
		]);
		await rebuildSceneMentions(db, sceneId);
		expect((await listStaleMentionScenes(db)).map((s) => s.id)).not.toContain(sceneId);
	});

	it('reindexes a scene whose body changed after indexing (a dropped job)', async () => {
		// The body changed and updated_at moved past the watermark, but no rebuild
		// ran - exactly what a dropped enqueue leaves behind.
		await pool.query(
			`update scenes set body_md = 'Alice and Alice and Alice.', updated_at = now() where id = $1`,
			[sceneId]
		);
		expect((await listStaleMentionScenes(db)).map((s) => s.id)).toContain(sceneId);

		const reindexed = await reconcileMentions(db);
		expect(reindexed).toBeGreaterThanOrEqual(1);
		expect(await mentionRows(sceneId)).toHaveLength(3);
		expect((await listStaleMentionScenes(db)).map((s) => s.id)).not.toContain(sceneId);
	});

	it('reindexes a scene when an entity in its universe changes after indexing', async () => {
		// An alias edit whose universe rebuild was dropped: the scene body is
		// unchanged, but a character it could mention changed after the watermark.
		await pool.query(`update characters set updated_at = now() where id = $1`, [aliceId]);
		expect((await listStaleMentionScenes(db)).map((s) => s.id)).toContain(sceneId);

		await reconcileMentions(db);
		expect((await listStaleMentionScenes(db)).map((s) => s.id)).not.toContain(sceneId);
	});
});
