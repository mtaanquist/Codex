import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, asc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
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
	listDrafts,
	newStoryFromDraft,
	restoreDraftScene,
	saveDraft,
	updateDraftDetails
} from '../../src/lib/server/story-drafts';
import { publishStory } from '../../src/lib/server/publish';
import {
	buildAccountExport,
	buildStoryZip,
	gatherDrafts,
	gatherStory
} from '../../src/lib/server/export';
import { deleteStory } from '../../src/lib/server/story-delete';
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
		'truncate table story_drafts, publication_assets, publications, revisions, entity_relationships, character_story_memberships, character_story_notes, notes, scenes, chapters, characters, places, lore_entries, entity_categories, stories, universes, users cascade'
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
		expect(await deleteDraft(db, elsewhere.id, id)).toMatchObject({ ok: false });
		expect(await deleteDraft(db, storyId, id)).toEqual({ ok: true });
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
		await deleteDraft(db, storyId, id);
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
	it('goes with the story when it is deleted', async () => {
		await save();
		await deleteStory(db, storyId, ownerId);
		expect(await db.select().from(storyDrafts)).toEqual([]);
	});

	it('knows when a draft still shows an image as its cover', async () => {
		const assetId = '00000000-0000-4000-8000-000000000001';
		expect(await draftUsesCover(db, assetId)).toBe(false);
		await db.update(stories).set({ coverAssetId: assetId }).where(eq(stories.id, storyId));
		await save();
		expect(await draftUsesCover(db, assetId)).toBe(true);
	});
});

describe('exports', () => {
	const text = (entry: { data: unknown } | undefined) =>
		entry && entry.data instanceof Uint8Array ? new TextDecoder().decode(entry.data) : null;

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
