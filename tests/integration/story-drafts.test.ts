import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, asc, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assets,
	chapters,
	characters,
	characterStoryMemberships,
	characterStoryNotes,
	entityRelationships,
	notes,
	places,
	publications,
	relationTypes,
	revisions,
	scenes,
	stories,
	storyDrafts,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	deleteDraft,
	draftsByStory,
	draftUsesCover,
	getDraft,
	replaceCover,
	listDrafts,
	newStoryFromDraft,
	restoreDraftScene,
	saveDraft,
	compareWithDraft,
	updateDraftDetails,
	workingOutline
} from '../../src/lib/server/story-drafts';
import { compareDrafts } from '../../src/lib/drafts';
import { publishStory } from '../../src/lib/server/publish';
import {
	buildAccountExport,
	buildStoryZip,
	gatherDrafts,
	gatherStory
} from '../../src/lib/server/export';
import { deleteStory } from '../../src/lib/server/story-delete';
import { purgeUniverse } from '../../src/lib/server/universe-lifecycle';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import { zipBytes } from '../../src/lib/server/zip-stream';
import { parseStoryZip } from '../../src/lib/import-markdown';
import { textHash } from '../../src/lib/text-hash';
import type { Database } from '../../src/lib/server/auth';
import { ensureBuiltInRelationTypes, ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let otherUserId: string;
let universeId: string;
let storyId: string;
let chapterId: string;
let sceneId: string;
let unfiledId: string;
let characterId: string;
let placeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(
		'truncate table story_drafts, assets, pending_object_deletions, publication_assets, publications, revisions, entity_relationships, character_story_memberships, character_story_notes, notes, scenes, chapters, characters, places, lore_entries, entity_categories, stories, universes, users cascade'
	);
	await ensureBuiltInRelationTypes(pool);
	const [owner] = await db
		.insert(users)
		.values({
			email: 'drafts@example.com',
			displayName: 'Drafter',
			passwordHash: 'x',
			role: 'user',
			handle: 'drafter',
			publicArchiveEnabled: true
		})
		.returning();
	ownerId = owner.id;
	const [other] = await db
		.insert(users)
		.values({ email: 'other@example.com', displayName: 'Other', passwordHash: 'x', role: 'user' })
		.returning();
	otherUserId = other.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'The Salt Road', author: 'A. Vane', slug: 'salt-road' })
		.returning();
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, title: 'Departure', position: 1 })
		.returning();
	chapterId = chapter.id;
	const [scene] = await db
		.insert(scenes)
		.values({
			storyId,
			chapterId,
			positionInChapter: 1,
			globalPosition: 1,
			title: 'Dawn',
			bodyMd: 'Halden left at dawn.',
			wordCount: 4,
			status: 'revised'
		})
		.returning();
	sceneId = scene.id;
	const [unfiled] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 2, title: 'Loose', bodyMd: 'A stray page.', wordCount: 3 })
		.returning();
	unfiledId = unfiled.id;
	const [character] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Halden', aliases: ['Hal'], summaryMd: 'A guide.' })
		.returning();
	characterId = character.id;
	const [place] = await db
		.insert(places)
		.values({ universeId, ownerId, name: 'Saltmarsh' })
		.returning();
	placeId = place.id;
	await db.insert(characterStoryMemberships).values({ characterId, storyId });
	await db
		.insert(characterStoryNotes)
		.values({ characterId, storyId, notesMd: 'Limps in act two.' });
	const [livesIn] = await db
		.select({ id: relationTypes.id })
		.from(relationTypes)
		.where(eq(relationTypes.key, 'lives_in'));
	await db.insert(entityRelationships).values({
		universeId,
		ownerId,
		fromType: 'character',
		fromId: characterId,
		toType: 'place',
		toId: placeId,
		relationTypeId: livesIn.id
	});
	await db.insert(notes).values({
		ownerId,
		universeId,
		storyId,
		sceneId,
		title: 'Dawn light',
		bodyMd: 'Make it colder.'
	});
});

async function save(label = 'First draft') {
	const result = await saveDraft(db, ownerId, storyId, { label, note: '' });
	if (!result.ok) throw new Error(result.reason);
	return result.id;
}

describe('saveDraft', () => {
	it('freezes the prose, outline, worldbuilding, and notes as they are now', async () => {
		const id = await save();
		const draft = await getDraft(db, storyId, id);
		expect(draft?.label).toBe('First draft');
		expect(draft?.wordCount).toBe(7);
		const content = draft!.content;
		expect(content.story.title).toBe('The Salt Road');
		expect(content.chapters).toEqual([{ id: chapterId, title: 'Departure', summaryMd: null }]);
		expect(content.scenes.map((scene) => [scene.id, scene.chapterId, scene.bodyMd])).toEqual([
			[sceneId, chapterId, 'Halden left at dawn.'],
			[unfiledId, null, 'A stray page.']
		]);
		expect(content.scenes[0].status).toBe('revised');
		const halden = content.entities.find((entity) => entity.id === characterId);
		expect(halden).toMatchObject({
			type: 'character',
			name: 'Halden',
			aliases: ['Hal'],
			summaryMd: 'A guide.',
			storyNotesMd: 'Limps in act two.',
			inStory: true
		});
		expect(content.entities.find((entity) => entity.id === placeId)?.inStory).toBe(false);
		expect(content.relationships).toEqual([
			expect.objectContaining({
				fromId: characterId,
				toId: placeId,
				label: 'lives in',
				storyOnly: false
			})
		]);
		expect(content.notes).toEqual([
			expect.objectContaining({ title: 'Dawn light', bodyMd: 'Make it colder.', sceneId })
		]);
	});

	it('does not change when the working draft changes afterwards', async () => {
		const id = await save();
		await db.update(scenes).set({ bodyMd: 'Rewritten.' }).where(eq(scenes.id, sceneId));
		await db.update(characters).set({ name: 'Hallam' }).where(eq(characters.id, characterId));
		await db.delete(scenes).where(eq(scenes.id, unfiledId));
		const content = (await getDraft(db, storyId, id))!.content;
		expect(content.scenes[0].bodyMd).toBe('Halden left at dawn.');
		expect(content.scenes).toHaveLength(2);
		expect(content.entities.find((entity) => entity.id === characterId)?.name).toBe('Halden');
	});

	it('leaves out scenes in the trash', async () => {
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, unfiledId));
		const id = await save();
		const content = (await getDraft(db, storyId, id))!.content;
		expect(content.scenes.map((scene) => scene.id)).toEqual([sceneId]);
	});

	it('needs a name and refuses a story the user does not own', async () => {
		expect(await saveDraft(db, ownerId, storyId, { label: '  ', note: '' })).toMatchObject({
			ok: false,
			code: 'invalid'
		});
		expect(await saveDraft(db, otherUserId, storyId, { label: 'Mine', note: '' })).toMatchObject({
			ok: false,
			code: 'not_found'
		});
		expect(await listDrafts(db, storyId)).toEqual([]);
	});

	it('lists drafts newest first, and by story for the library', async () => {
		const first = await save('One');
		await new Promise((done) => setTimeout(done, 5));
		const second = await save('Two');
		expect((await listDrafts(db, storyId)).map((draft) => draft.id)).toEqual([second, first]);
		const byStory = await draftsByStory(db, ownerId);
		expect(byStory.get(storyId)?.map((draft) => draft.label)).toEqual(['Two', 'One']);
		expect((await draftsByStory(db, otherUserId)).size).toBe(0);
	});
});

describe('updateDraftDetails and deleteDraft', () => {
	it('renames and notes a draft without touching its content', async () => {
		const id = await save();
		const before = (await getDraft(db, storyId, id))!.content;
		expect(
			await updateDraftDetails(db, storyId, id, { label: 'Agent copy', note: 'Sent in May' })
		).toEqual({ ok: true });
		const after = await getDraft(db, storyId, id);
		expect(after?.label).toBe('Agent copy');
		expect(after?.noteMd).toBe('Sent in May');
		expect(after?.content).toEqual(before);
	});

	it('deletes only within the story', async () => {
		const id = await save();
		const [elsewhere] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Other', slug: 'other' })
			.returning();
		expect(await deleteDraft(db, ownerId, elsewhere.id, id)).toMatchObject({ ok: false });
		expect(await deleteDraft(db, ownerId, storyId, id)).toEqual({ ok: true });
		expect(await getDraft(db, storyId, id)).toBeNull();
	});
});

describe('restoreDraftScene', () => {
	it('puts the saved text back, keeping the replaced text in History', async () => {
		const id = await save();
		await db.update(scenes).set({ bodyMd: 'Rewritten badly.' }).where(eq(scenes.id, sceneId));
		const result = await restoreDraftScene(db, storyId, id, sceneId);
		expect(result).toEqual({ ok: true, sceneId, created: false });
		const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
		expect(scene.bodyMd).toBe('Halden left at dawn.');
		const history = await db
			.select({ bodyMd: revisions.bodyMd, reason: revisions.reason })
			.from(revisions)
			.where(eq(revisions.entityId, sceneId))
			.orderBy(asc(revisions.createdAt));
		expect(history).toEqual([
			{ bodyMd: 'Rewritten badly.', reason: 'checkpoint' },
			{ bodyMd: 'Halden left at dawn.', reason: 'restore' }
		]);
	});

	it('records nothing when the text already matches', async () => {
		const id = await save();
		expect(await restoreDraftScene(db, storyId, id, sceneId)).toMatchObject({ ok: true });
		expect(await db.select().from(revisions).where(eq(revisions.entityId, sceneId))).toEqual([]);
	});

	it('makes a new scene in the old chapter when the scene is gone', async () => {
		const id = await save();
		await db.delete(notes);
		await db.delete(scenes).where(eq(scenes.id, sceneId));
		const result = await restoreDraftScene(db, storyId, id, sceneId);
		expect(result).toMatchObject({ ok: true, created: true });
		if (!result.ok) return;
		const [scene] = await db.select().from(scenes).where(eq(scenes.id, result.sceneId));
		expect(scene).toMatchObject({
			storyId,
			chapterId,
			title: 'Dawn',
			bodyMd: 'Halden left at dawn.',
			positionInChapter: 1
		});
		expect(scene.globalPosition).toBeGreaterThan(2);
	});

	it('leaves a trashed scene in the trash and makes a new one', async () => {
		const id = await save();
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, sceneId));
		const result = await restoreDraftScene(db, storyId, id, sceneId);
		expect(result).toMatchObject({ ok: true, created: true });
		const [trashed] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
		expect(trashed.deletedAt).not.toBeNull();
	});

	it('adds a deleted scene back only once', async () => {
		const id = await save();
		await db.delete(notes);
		await db.delete(scenes).where(eq(scenes.id, sceneId));
		const first = await restoreDraftScene(db, storyId, id, sceneId);
		const second = await restoreDraftScene(db, storyId, id, sceneId);
		expect(first).toMatchObject({ ok: true, created: true });
		if (!first.ok) return;
		expect(second).toEqual({ ok: true, sceneId: first.sceneId, created: false });
		const copies = await db.select().from(scenes).where(eq(scenes.bodyMd, 'Halden left at dawn.'));
		expect(copies).toHaveLength(1);
	});

	it('restores onto a scene that was added back and then edited', async () => {
		const id = await save();
		await db.delete(notes);
		await db.delete(scenes).where(eq(scenes.id, sceneId));
		const added = await restoreDraftScene(db, storyId, id, sceneId);
		if (!added.ok) throw new Error('expected a restore');
		await db.update(scenes).set({ bodyMd: 'Rewritten since.' }).where(eq(scenes.id, added.sceneId));
		const again = await restoreDraftScene(db, storyId, id, sceneId);
		expect(again).toEqual({ ok: true, sceneId: added.sceneId, created: false });
		const [copy] = await db.select().from(scenes).where(eq(scenes.id, added.sceneId));
		expect(copy.bodyMd).toBe('Halden left at dawn.');
		const history = await db.select().from(revisions).where(eq(revisions.entityId, added.sceneId));
		expect(history.map((row) => row.bodyMd)).toContain('Rewritten since.');
		const live = await db.select().from(scenes).where(eq(scenes.storyId, storyId));
		expect(live.filter((row) => row.bodyMd === 'Halden left at dawn.')).toHaveLength(1);
	});

	it('adds a scene back even when another scene has the same text', async () => {
		const id = await save();
		await db.delete(notes);
		const [other] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 50, bodyMd: 'Halden left at dawn.' })
			.returning({ id: scenes.id });
		await db.delete(scenes).where(eq(scenes.id, sceneId));
		const result = await restoreDraftScene(db, storyId, id, sceneId);
		expect(result).toMatchObject({ ok: true, created: true });
		if (!result.ok) return;
		expect(result.sceneId).not.toBe(other.id);
	});

	it('refuses a draft from another story', async () => {
		const id = await save();
		const [elsewhere] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Other', slug: 'other' })
			.returning();
		expect(await restoreDraftScene(db, elsewhere.id, id, sceneId)).toMatchObject({
			ok: false,
			code: 'not_found'
		});
	});

	it('makes an editor still showing the old text ask before saving over it', async () => {
		const id = await save();
		await db.update(scenes).set({ bodyMd: 'Halden left at dusk.' }).where(eq(scenes.id, sceneId));
		await restoreDraftScene(db, storyId, id, sceneId);
		// An editor open since before the restore last saw the dusk text.
		const result = await saveSceneBody(db, sceneId, {
			title: 'Dawn',
			bodyMd: 'Halden left at dusk, late.',
			anchors: null,
			baseHashes: [textHash('Halden left at dusk.')],
			overwrite: false
		});
		expect(result).toEqual({
			ok: false,
			conflict: { bodyMd: 'Halden left at dawn.', title: 'Dawn' }
		});
		const history = await db
			.select({ bodyMd: revisions.bodyMd })
			.from(revisions)
			.where(eq(revisions.entityId, sceneId))
			.orderBy(asc(revisions.createdAt));
		expect(history.map((row) => row.bodyMd)).toEqual([
			'Halden left at dusk.',
			'Halden left at dawn.'
		]);
	});

	it('compares a scene added back as the same scene', async () => {
		const id = await save();
		await db.delete(notes);
		await db.delete(scenes).where(eq(scenes.id, sceneId));
		await restoreDraftScene(db, storyId, id, sceneId);
		const draft = await getDraft(db, storyId, id);
		const result = compareDrafts(draft!.content, await workingOutline(db, storyId));
		expect(result.counts).toEqual({ same: 2, changed: 0, added: 0, removed: 0 });
		// A draft saved now remembers where the copy came from too.
		const later = await getDraft(db, storyId, await save());
		expect(compareDrafts(draft!.content, later!.content).counts.same).toBe(2);
	});

	it('follows a scene added back twice to the first draft', async () => {
		const first = await save();
		await db.delete(notes);
		await db.delete(scenes).where(eq(scenes.id, sceneId));
		const once = await restoreDraftScene(db, storyId, first, sceneId);
		if (!once.ok) throw new Error('expected a restore');
		const second = await save('Second draft');
		await db.delete(scenes).where(eq(scenes.id, once.sceneId));
		await restoreDraftScene(db, storyId, second, once.sceneId);
		const draft = await getDraft(db, storyId, first);
		const result = compareDrafts(draft!.content, await workingOutline(db, storyId));
		expect(result.counts).toEqual({ same: 2, changed: 0, added: 0, removed: 0 });
	});

	it('restores onto a scene added back twice instead of making another copy', async () => {
		const first = await save();
		await db.delete(notes);
		await db.delete(scenes).where(eq(scenes.id, sceneId));
		const once = await restoreDraftScene(db, storyId, first, sceneId);
		if (!once.ok) throw new Error('expected a restore');
		const second = await save('Second draft');
		await db.delete(scenes).where(eq(scenes.id, once.sceneId));
		const twice = await restoreDraftScene(db, storyId, second, once.sceneId);
		if (!twice.ok) throw new Error('expected a restore');
		await db.update(scenes).set({ bodyMd: 'Rewritten since.' }).where(eq(scenes.id, twice.sceneId));
		const result = await restoreDraftScene(db, storyId, first, sceneId);
		expect(result).toEqual({ ok: true, sceneId: twice.sceneId, created: false });
		const live = await db
			.select()
			.from(scenes)
			.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)));
		expect(live.filter((row) => row.bodyMd === 'Halden left at dawn.')).toHaveLength(1);
		expect(live.some((row) => row.bodyMd === 'Rewritten since.')).toBe(false);
	});

	it('refuses a scene that is not in the draft', async () => {
		const id = await save();
		expect(await restoreDraftScene(db, storyId, id, characterId)).toMatchObject({
			ok: false,
			code: 'not_found'
		});
	});
});

describe('newStoryFromDraft', () => {
	it('copies the draft into a new story and leaves the original alone', async () => {
		const id = await save();
		await db.update(scenes).set({ bodyMd: 'Changed since.' }).where(eq(scenes.id, sceneId));
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		const result = await newStoryFromDraft(db, ownerId, story, id, 'Salt Road, take two');
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;
		const [copy] = await db
			.select()
			.from(stories)
			.where(and(eq(stories.ownerId, ownerId), eq(stories.slug, result.slug)));
		expect(copy.title).toBe('Salt Road, take two');
		expect(copy.universeId).toBe(universeId);
		const copied = await db
			.select()
			.from(scenes)
			.where(eq(scenes.storyId, copy.id))
			.orderBy(asc(scenes.globalPosition));
		expect(copied.map((scene) => scene.bodyMd)).toEqual(['Halden left at dawn.', 'A stray page.']);
		expect(copied[0].chapterId).not.toBeNull();
		expect(copied[1].chapterId).toBeNull();
		const [note] = await db.select().from(notes).where(eq(notes.storyId, copy.id));
		expect(note.sceneId).toBe(copied[0].id);
		const [overlay] = await db
			.select()
			.from(characterStoryNotes)
			.where(eq(characterStoryNotes.storyId, copy.id));
		expect(overlay.notesMd).toBe('Limps in act two.');
		const [original] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
		expect(original.bodyMd).toBe('Changed since.');
	});

	it('copies relationships that held only in this story', async () => {
		await db
			.update(entityRelationships)
			.set({ storyId, notesMd: 'Only here.' })
			.where(eq(entityRelationships.fromId, characterId));
		const id = await save();
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		const result = await newStoryFromDraft(db, ownerId, story, id, 'Copy');
		if (!result.ok) throw new Error('expected a new story');
		const [copy] = await db.select().from(stories).where(eq(stories.slug, result.slug));
		const rows = await db
			.select()
			.from(entityRelationships)
			.where(eq(entityRelationships.storyId, copy.id));
		expect(rows).toEqual([
			expect.objectContaining({ fromId: characterId, toId: placeId, notesMd: 'Only here.' })
		]);
	});

	it('refuses a draft from another story', async () => {
		const id = await save();
		const [elsewhere] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Other', slug: 'other' })
			.returning();
		expect(await newStoryFromDraft(db, ownerId, elsewhere, id, '')).toMatchObject({ ok: false });
	});

	it('skips story notes for entities deleted since', async () => {
		const id = await save();
		await db.delete(characterStoryNotes);
		await db.delete(characterStoryMemberships);
		await db.delete(entityRelationships);
		await db.delete(characters).where(eq(characters.id, characterId));
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		const result = await newStoryFromDraft(db, ownerId, story, id, '');
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;
		const [copy] = await db.select().from(stories).where(eq(stories.slug, result.slug));
		expect(copy.title).toBe('The Salt Road (First draft)');
		expect(
			await db.select().from(characterStoryNotes).where(eq(characterStoryNotes.storyId, copy.id))
		).toEqual([]);
	});
});

describe('publishing a saved draft', () => {
	it('publishes the draft prose and records where it came from', async () => {
		const id = await save();
		await db.update(scenes).set({ bodyMd: 'Unfinished rewrite.' }).where(eq(scenes.id, sceneId));
		await db.update(stories).set({ title: 'New Title' }).where(eq(stories.id, storyId));
		const result = await publishStory(db, ownerId, storyId, 'Edition 1', id);
		expect(result.ok).toBe(true);
		const [edition] = await db.select().from(publications);
		expect(edition.sourceDraftId).toBe(id);
		expect(edition.title).toBe('The Salt Road');
		expect(edition.content).toEqual({
			chapters: [
				{ title: 'Departure', scenes: [{ title: 'Dawn', bodyMd: 'Halden left at dawn.' }] }
			],
			unfiled: [{ title: 'Loose', bodyMd: 'A stray page.' }]
		});
		// Deleting the draft keeps the edition.
		await deleteDraft(db, ownerId, storyId, id);
		const [kept] = await db.select().from(publications);
		expect(kept.sourceDraftId).toBeNull();
	});

	it('refuses a draft from another story', async () => {
		const [elsewhere] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Other', slug: 'other' })
			.returning();
		const id = await save();
		const result = await publishStory(db, ownerId, elsewhere.id, undefined, id);
		expect(result.ok).toBe(false);
	});
});

describe('lifecycle', () => {
	it('goes with the universe, editions published from a draft included', async () => {
		const id = await save();
		expect((await publishStory(db, ownerId, storyId, 'Edition 1', id)).ok).toBe(true);
		await purgeUniverse(db, universeId);
		expect(await db.select().from(storyDrafts)).toEqual([]);
		expect(await db.select().from(publications)).toEqual([]);
		expect(await db.select().from(stories)).toEqual([]);
	});

	it('goes with the story when it is deleted', async () => {
		await save();
		await deleteStory(db, storyId, ownerId);
		expect(await db.select().from(storyDrafts)).toEqual([]);
	});

	it('knows when a draft still shows an image as its cover', async () => {
		const assetId = '00000000-0000-4000-8000-000000000001';
		expect(await draftUsesCover(db, storyId, assetId)).toBe(false);
		await db.update(stories).set({ coverAssetId: assetId }).where(eq(stories.id, storyId));
		await save();
		expect(await draftUsesCover(db, storyId, assetId)).toBe(true);
		const [elsewhere] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Other', slug: 'other' })
			.returning();
		expect(await draftUsesCover(db, elsewhere.id, assetId)).toBe(false);
	});

	const cover = async (name: string) => {
		const [row] = await db
			.insert(assets)
			.values({
				ownerId,
				universeId,
				kind: 'cover',
				filename: `${name}.png`,
				contentType: 'image/png',
				byteSize: 1,
				storageKey: `key-${name}`
			})
			.returning({ id: assets.id });
		return row.id;
	};
	const assetIds = async () => (await db.select({ id: assets.id }).from(assets)).map((a) => a.id);

	it('keeps an old cover a draft shows, and frees it with the last such draft', async () => {
		const first = await cover('first');
		const second = await cover('second');
		expect(await replaceCover(db, storyId, first)).toBeNull();
		const id = await save();
		// The draft still shows the first cover, so it is not freed.
		expect(await replaceCover(db, storyId, second)).toBeNull();
		expect(await deleteDraft(db, ownerId, storyId, id)).toEqual({ ok: true });
		expect(await assetIds()).toEqual([second]);
	});

	it('hands back an old cover no draft shows', async () => {
		const first = await cover('first');
		const second = await cover('second');
		await replaceCover(db, storyId, first);
		expect(await replaceCover(db, storyId, second)).toBe(first);
	});

	it('keeps the story cover when a draft that shows it is deleted', async () => {
		const first = await cover('first');
		await replaceCover(db, storyId, first);
		const id = await save();
		await deleteDraft(db, ownerId, storyId, id);
		expect(await assetIds()).toEqual([first]);
	});
});

describe('exports', () => {
	const text = (entry: { data: unknown } | undefined) =>
		entry && entry.data instanceof Uint8Array ? new TextDecoder().decode(entry.data) : null;

	it('import back as the working draft only', async () => {
		await save();
		await db.update(scenes).set({ bodyMd: 'Now.' }).where(eq(scenes.id, sceneId));
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		const content = await gatherStory(db, story);
		const archive = await buildStoryZip(
			story,
			{ ...content, drafts: await gatherDrafts(db, story.id) },
			async () => []
		);
		const plan = parseStoryZip(await zipBytes(archive.entries));
		expect(plan.story.title).toBe('The Salt Road');
		expect(plan.chapters[0].scenes.map((scene) => scene.bodyMd)).toEqual(['Now.']);
		expect(plan.problems).toContain(
			'The saved drafts in this archive were not imported, only the working draft.'
		);
	});

	it('carry each saved draft in its own folder, worldbuilding included', async () => {
		await save('First draft');
		await db.update(scenes).set({ bodyMd: 'Changed since.' }).where(eq(scenes.id, sceneId));
		const archive = await buildAccountExport(db, ownerId, async () => []);
		const paths = archive.entries.map((entry) => entry.path);
		const base = 'universes/u/stories/the-salt-road/drafts/first-draft';
		expect(paths).toEqual(
			expect.arrayContaining([
				`${base}/draft.md`,
				`${base}/story.md`,
				`${base}/chapters/01-departure/chapter.md`,
				`${base}/chapters/01-departure/01-dawn.md`,
				`${base}/unfiled/01-loose.md`,
				`${base}/characters/halden.md`,
				`${base}/places/saltmarsh.md`,
				`${base}/notes/characters/halden.md`,
				`${base}/relationships.md`,
				`${base}/notebook/dawn-light.md`
			])
		);
		const byPath = new Map(archive.entries.map((entry) => [entry.path, entry]));
		expect(text(byPath.get(`${base}/chapters/01-departure/01-dawn.md`))).toContain(
			'Halden left at dawn.'
		);
		expect(text(byPath.get(`${base}/relationships.md`))).toContain('Halden - lives in - Saltmarsh');
		// A notebook note keeps the scene it hangs off, by its path in the draft.
		expect(text(byPath.get(`${base}/notebook/dawn-light.md`))).toContain(
			'scene: "chapters/01-departure/01-dawn.md"'
		);
	});

	it('include drafts in the story archive too', async () => {
		await save('First draft');
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		const content = await gatherStory(db, story);
		const archive = await buildStoryZip(
			story,
			{ ...content, drafts: await gatherDrafts(db, story.id) },
			async () => []
		);
		expect(archive.entries.map((entry) => entry.path)).toEqual(
			expect.arrayContaining([
				'the-salt-road/drafts/first-draft/draft.md',
				'the-salt-road/drafts/first-draft/chapters/01-departure/01-dawn.md'
			])
		);
	});
});

describe('compareWithDraft', () => {
	it('reads from the older draft to the newer, whichever is open', async () => {
		const firstId = await save();
		await db.update(scenes).set({ bodyMd: 'Halden left at dusk.' }).where(eq(scenes.id, sceneId));
		const secondId = await save('Second draft');
		const first = (await getDraft(db, storyId, firstId))!;
		const second = (await getDraft(db, storyId, secondId))!;
		for (const [open, other] of [
			[first, second],
			[second, first]
		]) {
			const result = await compareWithDraft(db, storyId, open, other.id);
			expect(result).toMatchObject({
				with: other.id,
				older: 'First draft',
				newer: 'Second draft',
				counts: { same: 1, changed: 1, added: 0, removed: 0 }
			});
			expect(result.changes[0].before?.bodyMd).toBe('Halden left at dawn.');
		}
	});

	it('falls back to the working draft for itself, junk, or another story', async () => {
		const id = await save();
		const draft = (await getDraft(db, storyId, id))!;
		const [elsewhere] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Other', slug: 'other' })
			.returning();
		const foreign = await saveDraft(db, ownerId, elsewhere.id, { label: 'Theirs', note: '' });
		if (!foreign.ok) throw new Error(foreign.reason);
		for (const withId of [id, 'junk', null, foreign.id]) {
			const result = await compareWithDraft(db, storyId, draft, withId);
			expect(result).toMatchObject({
				with: 'working',
				older: 'First draft',
				newer: 'Working draft'
			});
		}
	});
});
