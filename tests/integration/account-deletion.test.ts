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
	notifications,
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
	adminCancelDeletion,
	cancelAccountDeletion,
	listAccountsDueForPurge,
	purgeAccount,
	scheduleAccountDeletion
} from '../../src/lib/server/account-deletion';
import { setUserSuspended } from '../../src/lib/server/admin';
import { issueToken } from '../../src/lib/server/tokens';
import { createSession, validateSession, type Database } from '../../src/lib/server/auth';
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
	await db.insert(sessions).values({
		userId: ownerId,
		tokenHash: crypto.randomUUID(),
		expiresAt: new Date(Date.now() + 60_000)
	});
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table publication_assets, publications, scene_markers, revisions, entity_mentions, entity_relationships, character_story_memberships, place_story_memberships, character_story_notes, place_story_notes, lore_story_notes, scenes, chapters, characters, places, lore_entries, entity_categories, assets, stories, universes, auth_tokens, sessions, notifications, users cascade'
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
		// Notifications joined the schema after the cascade was written; an
		// account with one must still purge (regression: the FK aborted it).
		for (const userId of [victim, bystander]) {
			await db
				.insert(notifications)
				.values({ userId, kind: 'review_activity', payload: { title: 'A comment' } });
		}

		await purgeAccount(db, victim, stubStore);

		// The victim is gone, root and branch.
		expect(await db.select().from(users).where(eq(users.id, victim))).toHaveLength(0);
		expect(
			await db.select().from(notifications).where(eq(notifications.userId, victim))
		).toHaveLength(0);
		expect(
			await db.select().from(notifications).where(eq(notifications.userId, bystander))
		).toHaveLength(1);
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

	it('with requireSchedule, a cancellation that cleared the schedule aborts the purge', async () => {
		const rescued = await makeUser('rescued@example.com');
		await seedFullAccount(rescued);
		// deletionScheduledAt is null (a cancellation landed before the worker
		// reached this row). The scheduled purge must leave the account whole.
		await purgeAccount(db, rescued, stubStore, { requireSchedule: true });
		expect(await db.select().from(users).where(eq(users.id, rescued))).toHaveLength(1);
		expect(await db.select().from(stories).where(eq(stories.ownerId, rescued))).toHaveLength(1);
		expect(removedKeys).toEqual([]);

		// Once the schedule stands, the same call purges.
		await db
			.update(users)
			.set({ deletionScheduledAt: sql`now()` })
			.where(eq(users.id, rescued));
		await purgeAccount(db, rescued, stubStore, { requireSchedule: true });
		expect(await db.select().from(users).where(eq(users.id, rescued))).toHaveLength(0);
	});
});

describe('scheduleAccountDeletion and cancel', () => {
	it('deactivates, takes down editions, schedules, and can be cancelled', async () => {
		const userId = await makeUser('go@example.com');
		await seedFullAccount(userId);

		const token = await scheduleAccountDeletion(db, userId);
		const [scheduled] = await db.select().from(users).where(eq(users.id, userId));
		expect(scheduled.deletionScheduledAt).not.toBeNull();
		// The schedule itself blocks sign-in; the shared suspension column
		// stays free for admin use (regression: cancel used to lift it).
		expect(scheduled.suspendedAt).toBeNull();
		const live = await db.select().from(publications).where(eq(publications.ownerId, userId));
		expect(live.every((p) => p.removedAt !== null)).toBe(true);

		// A session opened while the deletion is pending dies at validation.
		const blocked = await createSession(db, userId);
		expect(await validateSession(db, blocked.token)).toBeNull();

		expect(await cancelAccountDeletion(db, token)).toBe(true);
		const [restored] = await db.select().from(users).where(eq(users.id, userId));
		expect(restored.deletionScheduledAt).toBeNull();
		expect(restored.suspendedAt).toBeNull();
		// The token is single-use.
		expect(await cancelAccountDeletion(db, token)).toBe(false);
	});

	it('cancelling a deletion never lifts an admin-imposed suspension', async () => {
		const userId = await makeUser('abuser@example.com');
		const token = await scheduleAccountDeletion(db, userId);
		expect(await setUserSuspended(db, userId, true)).toBe(true);

		expect(await cancelAccountDeletion(db, token)).toBe(true);
		const [after] = await db.select().from(users).where(eq(users.id, userId));
		expect(after.deletionScheduledAt).toBeNull();
		expect(after.suspendedAt).not.toBeNull();
	});

	it('adminCancelDeletion clears the schedule and nothing else', async () => {
		const userId = await makeUser('rescued@example.com');
		await scheduleAccountDeletion(db, userId);
		await setUserSuspended(db, userId, true);

		expect(await adminCancelDeletion(db, userId)).toBe(true);
		const [after] = await db.select().from(users).where(eq(users.id, userId));
		expect(after.deletionScheduledAt).toBeNull();
		expect(after.suspendedAt).not.toBeNull();
		// Nothing scheduled: nothing to cancel.
		expect(await adminCancelDeletion(db, userId)).toBe(false);
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
