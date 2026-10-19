import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assets,
	characters,
	entityCategories,
	entityRelationships,
	exportArtifacts,
	notifications,
	pendingObjectDeletions,
	places,
	reviewComments,
	publications,
	relationTypes,
	revisions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	destroyUniverse,
	listTrashedUniverses,
	listUniversesDueForPurge,
	restoreUniverse,
	trashUniverse,
	universeAssetKeys
} from '../../src/lib/server/universe-lifecycle';
import { ownedStory } from '../../src/lib/server/story-access';
import { ownedUniverse } from '../../src/lib/server/universe-access';
import { searchAll } from '../../src/lib/server/search';
import { recordRevision } from '../../src/lib/server/revisions';
import { ownedScene } from '../../src/lib/server/scene-access';
import { ownedEntityBody } from '../../src/lib/server/revisions';
import { getEntityCard } from '../../src/lib/server/plan-data';
import { setEntityBadgeColor } from '../../src/lib/server/entity-badge';
import { ownedStoryUniverse, ownsUniverse } from '../../src/lib/server/llm/tools/dispatch';
import { loadStoryScope, loadUniverseScope } from '../../src/lib/server/llm/context/sources';
import {
	createReviewInvitation,
	createSuggestion,
	createThread,
	decideSuggestion,
	deleteComment,
	deleteSuggestion,
	ensureReviewer,
	invitationByToken,
	reviewerAccess,
	setThreadResolved
} from '../../src/lib/server/review';
import { createMarker, deleteMarker, setMarkerResolved } from '../../src/lib/server/markers';
import { createAsset, type AssetObjectStore } from '../../src/lib/server/assets';
import { createChapter, createScene, trashScene } from '../../src/lib/server/scene-lifecycle';
import { duplicateScene, mergeScenes } from '../../src/lib/server/scene-split-merge';
import { clearMentionPin, setMentionPin } from '../../src/lib/server/mention-pins';
import { declareMembership } from '../../src/lib/server/membership';
import { saveEntity } from '../../src/lib/server/entity-save';
import { createRelationship, deleteRelationship } from '../../src/lib/server/relationships';
import { createStoryNote, getNote, setNotePinned } from '../../src/lib/server/notes';
import { notifyReviewActivity } from '../../src/lib/server/notify';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let characterId: string;
let typeId: string;
let sceneId: string;
let placeId: string;
let secondSceneId: string;
let reviewToken: string;
let reviewerId: string;
let noteId: string;
let markerId: string;
let relationshipId: string;
let threadId: string;
let commentId: string;
let suggestionId: string;

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const assetConfig = {
	endpoint: undefined,
	region: 'auto',
	bucket: 'test',
	prefix: 'codex-assets',
	accessKeyId: 'id',
	secretAccessKey: 'secret'
};
const nullStore: AssetObjectStore = {
	async put() {},
	async upload() {},
	async get() {
		throw new Error('not stored');
	},
	async remove() {}
};

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'uni@example.com', displayName: 'U', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'uni2@example.com', displayName: 'U2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;

	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Closing Time', slug: 'closing-time' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'Last Orders', slug: 'last-orders' })
		.returning();
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'Bell', bodyMd: 'The bell rang.' })
		.returning();
	sceneId = scene.id;
	const [secondScene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 2, title: 'Last call', bodyMd: 'Time, please.' })
		.returning();
	secondSceneId = secondScene.id;
	const invitation = await createReviewInvitation(db, { storyId, createdBy: ownerId });
	reviewToken = invitation.token;
	const reviewer = await ensureReviewer(db, invitation.id, { displayName: 'Guest' });
	reviewerId = reviewer!.id;
	noteId = await createStoryNote(db, ownerId, universeId, storyId);
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	const [character] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Mara', categoryId: category.id })
		.returning();
	characterId = character.id;
	const [place] = await db
		.insert(places)
		.values({ universeId, ownerId, name: 'The Anchor', categoryId: category.id })
		.returning();
	placeId = place.id;
	await recordRevision(db, 'character', characterId, 'A barkeep.');
	const [relType] = await db
		.insert(relationTypes)
		.values({
			universeId,
			key: 'patron-of',
			forwardLabel: 'patron of',
			fromType: 'character',
			toType: 'place'
		})
		.returning();
	typeId = relType.id;

	const marker = await createMarker(db, ownerId, sceneId, 0, 4);
	if (!marker.ok) throw new Error(marker.reason);
	markerId = marker.id;
	const relationship = await createRelationship(db, ownerId, {
		fromKind: 'character',
		fromId: characterId,
		relationTypeId: typeId,
		toId: placeId
	});
	if (!relationship.ok) throw new Error(relationship.reason);
	relationshipId = relationship.id;
	const thread = await createThread(db, {
		storyId,
		sceneId,
		anchor: { start: 0, end: 3 },
		author: { reviewerId },
		body: 'Lovely.'
	});
	if (!thread.ok) throw new Error(thread.reason);
	threadId = thread.threadId;
	const [comment] = await db
		.select({ id: reviewComments.id })
		.from(reviewComments)
		.where(eq(reviewComments.threadId, threadId));
	commentId = comment.id;
	const suggestion = await createSuggestion(db, {
		storyId,
		sceneId,
		author: { reviewerId },
		range: { start: 4, end: 8 },
		replacement: 'gong'
	});
	if (!suggestion.ok) throw new Error(suggestion.reason);
	suggestionId = suggestion.suggestionId;
});

afterAll(async () => {
	await pool.end();
});

describe('trash and restore', () => {
	it('a trashed universe leaves every resolver and search', async () => {
		expect(await trashUniverse(db, strangerId, universeId)).toBe(false);
		expect(await trashUniverse(db, ownerId, universeId)).toBe(true);

		await expect(ownedUniverse('closing-time', ownerId, db)).rejects.toMatchObject({
			status: 404
		});
		await expect(ownedStory('last-orders', ownerId, db)).rejects.toMatchObject({ status: 404 });
		expect(await searchAll(db, ownerId, 'Mara')).toEqual([]);
		expect(await searchAll(db, ownerId, 'bell')).toEqual([]);

		const trashed = await listTrashedUniverses(db, ownerId);
		expect(trashed.map((row) => row.id)).toEqual([universeId]);
		expect(trashed[0].daysLeft).toBe(30);
	});

	it('by-id lookups, Assistant scopes, and guest review stop resolving too', async () => {
		await trashUniverse(db, ownerId, universeId);
		expect(await ownedScene(db, ownerId, sceneId)).toBeNull();
		expect(await ownedEntityBody(db, ownerId, 'scene', sceneId)).toBeNull();
		expect(await ownedEntityBody(db, ownerId, 'character', characterId)).toBeNull();
		expect(await getEntityCard(db, ownerId, characterId)).toBeNull();
		expect((await setEntityBadgeColor(db, ownerId, characterId, null)).ok).toBe(false);
		expect(await ownsUniverse(db, ownerId, universeId)).toBe(false);
		expect(await ownedStoryUniverse(db, ownerId, storyId)).toBeNull();
		expect(await loadUniverseScope(db, ownerId, universeId)).toBeNull();
		expect(await loadStoryScope(db, ownerId, storyId)).toBeNull();
		expect((await invitationByToken(db, reviewToken)).status).toBe('unknown');
		expect(await reviewerAccess(db, reviewerId, storyId)).toBeNull();
	});

	it('refuses writes and reads by id inside the trashed universe', async () => {
		await trashUniverse(db, ownerId, universeId);
		const refusals: [string, () => Promise<unknown>][] = [
			['createChapter', () => createChapter(db, ownerId, storyId)],
			['createScene', () => createScene(db, ownerId, storyId)],
			['trashScene', () => trashScene(db, ownerId, sceneId)],
			['duplicateScene', () => duplicateScene(db, ownerId, sceneId)],
			['mergeScenes', () => mergeScenes(db, ownerId, storyId, [sceneId, secondSceneId])],
			[
				'setMentionPin',
				() => setMentionPin(db, ownerId, storyId, 'Mara', 'character', characterId)
			],
			['clearMentionPin', () => clearMentionPin(db, ownerId, storyId, 'Mara')],
			[
				'declareMembership',
				() => declareMembership(db, ownerId, 'character', characterId, storyId)
			],
			[
				'saveEntity',
				() =>
					saveEntity(db, 'character', characterId, ownerId, {
						name: 'Mara',
						tags: [],
						summaryMd: null,
						bodyMd: 'Rewritten.'
					})
			],
			[
				'createRelationship',
				() =>
					createRelationship(db, ownerId, {
						fromKind: 'character',
						fromId: characterId,
						relationTypeId: typeId,
						toId: placeId
					})
			],
			['getNote', () => getNote(db, noteId, ownerId)],
			['setNotePinned', () => setNotePinned(db, noteId, ownerId, true)],
			['ownedEntityBody note', () => ownedEntityBody(db, ownerId, 'note', noteId)],
			['setMarkerResolved', () => setMarkerResolved(db, ownerId, markerId, true)],
			['deleteMarker', () => deleteMarker(db, ownerId, markerId)],
			['deleteRelationship', () => deleteRelationship(db, relationshipId, ownerId)],
			['setThreadResolved', () => setThreadResolved(db, ownerId, storyId, threadId, true)],
			['decideSuggestion', () => decideSuggestion(db, ownerId, storyId, suggestionId, false)],
			['deleteComment', () => deleteComment(db, { reviewerId }, storyId, commentId)],
			['deleteSuggestion', () => deleteSuggestion(db, { reviewerId }, storyId, suggestionId)],
			[
				'createAsset',
				() =>
					createAsset(db, nullStore, assetConfig, ownerId, {
						universeId,
						kind: 'inline',
						filename: 'x.png',
						contentType: 'image/png',
						bytes: PNG
					})
			]
		];
		const allowed: string[] = [];
		for (const [name, call] of refusals) {
			const result = await call();
			const refused =
				result === null ||
				result === false ||
				(typeof result === 'object' && result !== null && 'ok' in result && !result.ok);
			if (!refused) allowed.push(name);
		}
		expect(allowed).toEqual([]);
		const [{ total: before }] = await db
			.select({ total: sql<number>`count(*)::int` })
			.from(notifications);
		await notifyReviewActivity(db, storyId, 'Guest', 'commented', 'Late note.');
		const [{ total: after }] = await db
			.select({ total: sql<number>`count(*)::int` })
			.from(notifications);
		expect(after).toBe(before);
	});

	it('is not due for the purge until the window elapses', async () => {
		await trashUniverse(db, ownerId, universeId);
		expect(await listUniversesDueForPurge(db)).toEqual([]);
		await db
			.update(universes)
			.set({ deletedAt: sql`now() - interval '31 days'` })
			.where(eq(universes.id, universeId));
		expect(await listUniversesDueForPurge(db)).toEqual([universeId]);
	});

	it('restore brings everything back whole', async () => {
		await trashUniverse(db, ownerId, universeId);
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(true);
		expect((await ownedUniverse('closing-time', ownerId, db)).id).toBe(universeId);
		expect((await ownedStory('last-orders', ownerId, db)).story.id).toBe(storyId);
		expect((await searchAll(db, ownerId, 'Mara')).length).toBeGreaterThan(0);
		expect((await ownedScene(db, ownerId, sceneId))?.id).toBe(sceneId);
		expect(await ownedEntityBody(db, ownerId, 'character', characterId)).not.toBeNull();
		expect(await getEntityCard(db, ownerId, characterId)).not.toBeNull();
		expect(await ownsUniverse(db, ownerId, universeId)).toBe(true);
		expect(await ownedStoryUniverse(db, ownerId, storyId)).toBe(universeId);
		expect((await invitationByToken(db, reviewToken)).status).toBe('ok');
		expect(await reviewerAccess(db, reviewerId, storyId)).not.toBeNull();
		expect((await getNote(db, noteId, ownerId))?.id).toBe(noteId);
		// Review actions are scoped to the story they are asked about.
		const otherStory = '00000000-0000-4000-8000-000000000000';
		expect(await setThreadResolved(db, ownerId, otherStory, threadId, true)).toBe(false);
		expect((await decideSuggestion(db, ownerId, otherStory, suggestionId, false)).ok).toBe(false);
		expect((await deleteComment(db, { reviewerId }, otherStory, commentId)).ok).toBe(false);
		expect((await deleteSuggestion(db, { reviewerId }, otherStory, suggestionId)).ok).toBe(false);
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(false);
	});
});

describe('universeAssetKeys', () => {
	it('includes uploaded images and the editions stored export files', async () => {
		await db
			.insert(assets)
			.values({
				ownerId,
				universeId,
				kind: 'inline',
				filename: 'x.png',
				contentType: 'image/png',
				byteSize: 1,
				storageKey: 'img-key'
			})
			.returning();
		const [pub] = await db
			.insert(publications)
			.values({ storyId, ownerId, handle: 'h', title: 'Ed', content: {}, isCurrent: true })
			.returning();
		await db.insert(exportArtifacts).values({
			publicationId: pub.id,
			format: 'epub',
			storageKey: 'epub-key',
			filename: 'e.epub',
			contentType: 'application/epub+zip',
			byteSize: 20
		});

		const keys = await universeAssetKeys(db, universeId);
		expect(keys).toContain('img-key');
		expect(keys).toContain('epub-key');
	});
});

describe('destroy', () => {
	it('refuses a live universe, then purges a trashed one completely', async () => {
		expect((await destroyUniverse(db, ownerId, universeId)).ok).toBe(false);
		await trashUniverse(db, ownerId, universeId);
		await db.insert(assets).values({
			ownerId,
			universeId,
			kind: 'inline',
			filename: 'gone.png',
			contentType: 'image/png',
			byteSize: 1,
			storageKey: 'destroyed-img-key'
		});
		expect((await destroyUniverse(db, strangerId, universeId)).ok).toBe(false);
		expect((await destroyUniverse(db, ownerId, universeId)).ok).toBe(true);
		// The image object is queued for the deferred sweep, not removed now.
		const queued = await db
			.select()
			.from(pendingObjectDeletions)
			.where(eq(pendingObjectDeletions.storageKey, 'destroyed-img-key'));
		expect(queued).toHaveLength(1);

		expect(await db.select().from(universes).where(eq(universes.id, universeId))).toHaveLength(0);
		expect(await db.select().from(stories).where(eq(stories.id, storyId))).toHaveLength(0);
		expect(await db.select().from(characters).where(eq(characters.id, characterId))).toHaveLength(
			0
		);
		// The pieces the old account purge leaked: custom relation types and
		// entity history.
		expect(await db.select().from(relationTypes).where(eq(relationTypes.id, typeId))).toHaveLength(
			0
		);
		expect(
			await db.select().from(revisions).where(eq(revisions.entityId, characterId))
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(entityRelationships)
				.where(eq(entityRelationships.universeId, universeId))
		).toHaveLength(0);
	});
});
