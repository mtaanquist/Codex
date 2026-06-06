import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assets,
	chapters,
	characters,
	characterStoryMemberships,
	entityCategories,
	entityMentions,
	entityRelationships,
	loreEntries,
	places,
	publicationAssets,
	publications,
	relationTypes,
	revisions,
	sceneMarkers,
	scenes,
	sessions,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { AssetObjectStore } from '../../src/lib/server/assets';
import {
	cancelAccountDeletion,
	listAccountsDueForPurge,
	purgeAccount,
	scheduleAccountDeletion
} from '../../src/lib/server/account-deletion';
import { issueToken } from '../../src/lib/server/tokens';
import type { Database } from '../../src/lib/server/auth';
import { ensureBuiltInRelationTypes, ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;

const removedKeys: string[] = [];
const stubStore = {
	remove: async (key: string) => {
		removedKeys.push(key);
	}
} as unknown as AssetObjectStore;

async function makeUser(email: string) {
	const [user] = await db
		.insert(users)
		.values({ email, displayName: email, passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	return user.id;
}

// A full account: a universe with a category, all three entity kinds, a
// story with a chapter and scene, a marker, a revision, a mention,
// node, a membership, a story-scoped and a universe-wide relationship, a
// publication with an asset reference, plus a session and a stray asset.
async function seedFullAccount(ownerId: string) {
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId: universe.id, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	const [alice] = await db
		.insert(characters)
		.values({ universeId: universe.id, ownerId, name: 'Alice', categoryId: category.id })
		.returning();
	const [place] = await db
		.insert(places)
		.values({ universeId: universe.id, ownerId, name: 'Halden' })
		.returning();
	await db
		.insert(loreEntries)
		.values({ universeId: universe.id, ownerId, categoryId: category.id, title: 'Toll' });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'Doomed', visibility: 'public' })
		.returning();
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId: story.id, title: 'Ch1', position: 1 })
		.returning();
	const [scene] = await db
		.insert(scenes)
		.values({
			storyId: story.id,
			chapterId: chapter.id,
			globalPosition: 1,
			title: 'S1',
			bodyMd: 'Alice.'
		})
		.returning();
	await db
		.insert(sceneMarkers)
		.values({ sceneId: scene.id, ownerId, anchorStart: 0, anchorEnd: 5 });
	await db.insert(revisions).values({ entityType: 'scene', entityId: scene.id, bodyMd: 'Alice.' });
	await db.insert(entityMentions).values({
		sourceType: 'scene',
		sourceId: scene.id,
		targetType: 'character',
		targetId: alice.id,
		position: 0,
		surroundingText: 'Alice.'
	});
	await db.insert(characterStoryMemberships).values({ characterId: alice.id, storyId: story.id });
	const [livesIn] = await db.select().from(relationTypes).where(eq(relationTypes.key, 'lives_in'));
	for (const storyId of [story.id, null]) {
		await db.insert(entityRelationships).values({
			universeId: universe.id,
			ownerId,
			fromType: 'character',
			fromId: alice.id,
			toType: 'place',
			toId: place.id,
			relationTypeId: livesIn.id,
			storyId
		});
	}
	const [asset] = await db
		.insert(assets)
		.values({
			ownerId,
			universeId: universe.id,
			kind: 'inline',
			filename: 'x.png',
			contentType: 'image/png',
			byteSize: 1,
			storageKey: `key-${ownerId}`
		})
		.returning();
	const [pub] = await db
		.insert(publications)
		.values({
			storyId: story.id,
			ownerId,
			handle: ownerId.slice(0, 8),
			title: 'Doomed',
			content: {},
			isCurrent: true
		})
		.returning();
	await db.insert(publicationAssets).values({ publicationId: pub.id, assetId: asset.id });
	await db.insert(sessions).values({ userId: ownerId, expiresAt: new Date(Date.now() + 60_000) });
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table publication_assets, publications, scene_markers, revisions, entity_mentions, entity_relationships, character_story_memberships, place_story_memberships, character_story_notes, place_story_notes, lore_story_notes, scenes, chapters, characters, places, lore_entries, entity_categories, assets, stories, universes, auth_tokens, sessions, users cascade'
	);
	await ensureBuiltInRelationTypes(pool);
	removedKeys.length = 0;
});

afterAll(async () => {
	await pool.end();
});

describe('purgeAccount', () => {
	it('erases everything the account owns and leaves other accounts intact', async () => {
		const victim = await makeUser('victim@example.com');
		const bystander = await makeUser('bystander@example.com');
		await seedFullAccount(victim);
		await seedFullAccount(bystander);
		await issueToken(db, victim, 'email_verify', 60);

		await purgeAccount(db, victim, stubStore);

		// The victim is gone, root and branch.
		expect(await db.select().from(users).where(eq(users.id, victim))).toHaveLength(0);
		for (const table of [universes, stories, characters, places, loreEntries, assets]) {
			const rows = await db.select().from(table).where(eq(table.ownerId, victim));
			expect(rows).toHaveLength(0);
		}
		expect(removedKeys).toEqual([`key-${victim}`]);

		// The bystander is untouched, and only their story-scoped rows remain.
		expect(await db.select().from(users).where(eq(users.id, bystander))).toHaveLength(1);
		expect(await db.select().from(stories).where(eq(stories.ownerId, bystander))).toHaveLength(1);
		expect(
			await db.select().from(characters).where(eq(characters.ownerId, bystander))
		).toHaveLength(1);
		expect(await db.select().from(scenes)).toHaveLength(1);
		expect(await db.select().from(sceneMarkers)).toHaveLength(1);
		expect(await db.select().from(entityMentions)).toHaveLength(1);
		expect(await db.select().from(publications)).toHaveLength(1);
		expect(await db.select().from(entityRelationships)).toHaveLength(2);
	});
});

describe('scheduleAccountDeletion and cancel', () => {
	it('deactivates, takes down editions, schedules, and can be cancelled', async () => {
		const userId = await makeUser('go@example.com');
		await seedFullAccount(userId);

		const token = await scheduleAccountDeletion(db, userId);
		const [scheduled] = await db.select().from(users).where(eq(users.id, userId));
		expect(scheduled.deletionScheduledAt).not.toBeNull();
		expect(scheduled.suspendedAt).not.toBeNull();
		const live = await db.select().from(publications).where(eq(publications.ownerId, userId));
		expect(live.every((p) => p.removedAt !== null)).toBe(true);

		expect(await cancelAccountDeletion(db, token)).toBe(true);
		const [restored] = await db.select().from(users).where(eq(users.id, userId));
		expect(restored.deletionScheduledAt).toBeNull();
		expect(restored.suspendedAt).toBeNull();
		// The token is single-use.
		expect(await cancelAccountDeletion(db, token)).toBe(false);
	});
});

describe('listAccountsDueForPurge', () => {
	it('returns only accounts past their grace window', async () => {
		const due = await makeUser('due@example.com');
		const waiting = await makeUser('waiting@example.com');
		await db
			.update(users)
			.set({ deletionScheduledAt: sql`now() - interval '1 hour'` })
			.where(eq(users.id, due));
		await db
			.update(users)
			.set({ deletionScheduledAt: sql`now() + interval '3 days'` })
			.where(eq(users.id, waiting));
		expect(await listAccountsDueForPurge(db)).toEqual([due]);
	});
});
