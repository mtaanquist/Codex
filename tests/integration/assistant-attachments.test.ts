import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { chapterSummaryRequest } from '../../src/lib/server/llm/chapter-summary-request';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	places,
	notes,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { ChatAttachment } from '../../src/lib/assistant-chat';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'attachments-test-secret';

const { resolveAttachments, searchContext, storyContents } =
	await import('../../src/lib/server/llm/attachments');

// What the writer attaches to a chat message: read by id and owner, kept out
// of muted stories, and cut to fit the budget.

let pool: pg.Pool;
let db: Database;
let userId: string;
let otherId: string;
let storyId: string;
let otherUniverseStoryId: string;
let chapterId: string;
let sceneId: string;
let characterId: string;
let noteId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	const [user, other] = await db
		.insert(users)
		.values([
			{ email: 'w@example.com', displayName: 'Wren', passwordHash: 'x', role: 'user' },
			{ email: 'o@example.com', displayName: 'Other', passwordHash: 'x', role: 'user' }
		])
		.returning({ id: users.id });
	userId = user.id;
	otherId = other.id;
	const [universe, second] = await db
		.insert(universes)
		.values([
			{ ownerId: userId, name: 'Harbour' },
			{ ownerId: userId, name: 'Elsewhere' }
		])
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: userId, title: 'Book of Ash' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [far] = await db
		.insert(stories)
		.values({ universeId: second.id, ownerId: userId, title: 'Salt Road' })
		.returning({ id: stories.id });
	otherUniverseStoryId = far.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, position: 1, title: 'Arrival', summaryMd: 'They arrive.' })
		.returning({ id: chapters.id });
	chapterId = chapter.id;
	const [scene] = await db
		.insert(scenes)
		.values([
			{
				storyId,
				chapterId,
				positionInChapter: 1,
				globalPosition: 1,
				title: 'The gate',
				bodyMd: 'The gate stood open.',
				summaryMd: 'A gate.',
				wordCount: 4
			},
			{
				storyId,
				chapterId,
				positionInChapter: 2,
				globalPosition: 2,
				title: 'The hall',
				bodyMd: 'The hall was cold.',
				wordCount: 4
			}
		])
		.returning({ id: scenes.id });
	sceneId = scene.id;
	await db
		.insert(scenes)
		.values({ storyId: far.id, globalPosition: 1, title: 'Dust', bodyMd: 'Dust everywhere.' });
	const [character] = await db
		.insert(characters)
		.values({
			universeId: universe.id,
			ownerId: userId,
			name: 'Mira',
			aliases: ['the ferrywoman'],
			summaryMd: 'Runs the ferry.'
		})
		.returning({ id: characters.id });
	characterId = character.id;
	const [note] = await db
		.insert(notes)
		.values({
			ownerId: userId,
			universeId: universe.id,
			storyId,
			title: 'Threads',
			bodyMd: 'Pull the ash thread.'
		})
		.returning({ id: notes.id });
	noteId = note.id;
});

afterAll(async () => {
	await pool.end();
});

const BIG = 100_000;

function texts(resolved: { title: string; text: string }[]) {
	return resolved.map((item) => `${item.title}: ${item.text}`);
}

describe('resolveAttachments', () => {
	it('reads each kind', async () => {
		const resolved = await resolveAttachments(
			db,
			userId,
			[
				{ kind: 'scene', id: sceneId, label: 'The gate' },
				{ kind: 'chapter', id: chapterId, label: 'Arrival' },
				{ kind: 'entity', id: characterId, label: 'Mira' },
				{ kind: 'note', id: noteId, label: 'Threads' },
				{ kind: 'story', id: storyId, label: 'Book of Ash', depth: 'outline' },
				{ kind: 'story', id: otherUniverseStoryId, label: 'Salt Road', depth: 'book' }
			],
			BIG
		);
		const out = texts(resolved);
		expect(out[0]).toBe('Scene "The gate" from Book of Ash: The gate stood open.');
		expect(out[1]).toContain('Arrival from Book of Ash');
		expect(out[1]).toContain('The gate stood open.');
		expect(out[1]).toContain('The hall was cold.');
		expect(out[2]).toContain('Runs the ferry.');
		expect(out[2]).toContain('the ferrywoman');
		expect(out[3]).toBe('Note "Threads": Pull the ash thread.');
		expect(out[4]).toContain('- The gate: A gate.');
		expect(out[4]).not.toContain('stood open');
		// Another universe in the library is fine.
		expect(out[5]).toContain('Dust everywhere.');
		expect(resolved.every((item) => !item.attachment.shortened)).toBe(true);
	});

	it('records what kind of library entry it is, whatever the browser said', async () => {
		const [{ universeId }] = await db
			.select({ universeId: characters.universeId })
			.from(characters)
			.where(eq(characters.id, characterId));
		const [place] = await db
			.insert(places)
			.values({ universeId, ownerId: userId, name: 'The Quay' })
			.returning({ id: places.id });
		const resolved = await resolveAttachments(
			db,
			userId,
			[
				{ kind: 'entity', id: characterId, label: 'Mira', entityType: 'lore' },
				{ kind: 'entity', id: place.id, label: 'The Quay' },
				{ kind: 'scene', id: sceneId, label: 'The gate', entityType: 'place' }
			],
			BIG
		);
		expect(resolved.map((item) => item.attachment.entityType)).toEqual([
			'character',
			'place',
			undefined
		]);
		expect(await searchContext(db, userId, 'Quay')).toContainEqual(
			expect.objectContaining({ kind: 'entity', id: place.id, entityType: 'place' })
		);
	});

	it("leaves out what is not the writer's, is in the trash, or is muted", async () => {
		const asked: ChatAttachment[] = [
			{ kind: 'scene', id: sceneId, label: 'x' },
			{ kind: 'note', id: noteId, label: 'x' },
			{ kind: 'entity', id: characterId, label: 'x' }
		];
		expect(await resolveAttachments(db, otherId, asked, BIG)).toEqual([]);

		await db
			.update(stories)
			.set({ llmConfig: { enabled: false } })
			.where(eq(stories.id, storyId));
		const muted = await resolveAttachments(db, userId, asked, BIG);
		expect(muted.map((item) => item.attachment.kind)).toEqual(['entity']);

		await db.update(stories).set({ llmConfig: {} }).where(eq(stories.id, storyId));
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, sceneId));
		expect(
			await resolveAttachments(db, userId, [{ kind: 'scene', id: sceneId, label: 'x' }], BIG)
		).toEqual([]);
	});

	it('names each item as it is now, not as the browser sent it', async () => {
		await db.update(scenes).set({ title: 'The broken gate' }).where(eq(scenes.id, sceneId));
		const resolved = await resolveAttachments(
			db,
			userId,
			[
				{ kind: 'scene', id: sceneId, label: 'The gate' },
				{ kind: 'entity', id: characterId, label: 'someone\nelse' }
			],
			BIG
		);
		expect(resolved.map((item) => item.attachment.label)).toEqual(['The broken gate', 'Mira']);
	});

	it('cuts what does not fit and says so', async () => {
		await db
			.update(scenes)
			.set({ bodyMd: 'word '.repeat(2000) })
			.where(eq(scenes.id, sceneId));
		const [scene, note] = await resolveAttachments(
			db,
			userId,
			[
				{ kind: 'scene', id: sceneId, label: 'The gate', shortened: false },
				{ kind: 'note', id: noteId, label: 'Threads', shortened: true }
			],
			200
		);
		expect(scene.attachment.shortened).toBe(true);
		expect(scene.text.length).toBeLessThan(900);
		expect(scene.text).toContain('cut here to fit');
		// A small one stays whole, whatever the browser claimed.
		expect(note.attachment.shortened).toBeUndefined();
		expect(note.text).toBe('Pull the ash thread.');
	});
});

describe('the whole book', () => {
	it("sends a chapter's summary unless the Assistant wrote it and it is out of date", async () => {
		const [chapter] = await db
			.insert(chapters)
			.values({ storyId, position: 9, title: 'Ashfall', summaryMd: 'The town burns.' })
			.returning({ id: chapters.id });
		const [scene] = await db
			.insert(scenes)
			.values({
				storyId,
				chapterId: chapter.id,
				positionInChapter: 1,
				globalPosition: 90,
				bodyMd: 'Smoke over the roofs.',
				summaryMd: 'Smoke rises.'
			})
			.returning({ id: scenes.id });
		const text = async () =>
			(
				await resolveAttachments(
					db,
					userId,
					[{ kind: 'chapter', id: chapter.id, label: 'Ashfall' }],
					BIG
				)
			)[0].text;
		try {
			// The writer's own summary always goes.
			expect(await text()).toContain('Summary: The town burns.');
			// One the Assistant wrote goes while its fingerprint matches.
			const request = chapterSummaryRequest('Ashfall', [
				{ summaryMd: 'Smoke rises.', summaryGeneratedAt: null, updatedAt: new Date() }
			])!;
			await db
				.update(chapters)
				.set({ summaryGeneratedAt: new Date(), summaryInput: request.input })
				.where(eq(chapters.id, chapter.id));
			expect(await text()).toContain('Summary: The town burns.');
			await db.update(scenes).set({ summaryMd: 'Rain falls.' }).where(eq(scenes.id, scene.id));
			expect(await text()).not.toContain('Summary:');
			expect(await text()).toContain('Smoke over the roofs.');
			// And not when it was stored without one.
			await db.update(chapters).set({ summaryInput: null }).where(eq(chapters.id, chapter.id));
			await db.update(scenes).set({ summaryMd: 'Smoke rises.' }).where(eq(scenes.id, scene.id));
			expect(await text()).not.toContain('Summary:');
		} finally {
			await db.delete(scenes).where(eq(scenes.id, scene.id));
			await db.delete(chapters).where(eq(chapters.id, chapter.id));
		}
	});

	it('heads each chapter, names an untitled one by its place, and keeps loose scenes apart', async () => {
		const [untitled] = await db
			.insert(chapters)
			.values({ storyId, position: 2, title: '' })
			.returning({ id: chapters.id });
		await db.insert(scenes).values([
			{ storyId, globalPosition: 3, title: 'Loose', bodyMd: 'A loose page.' },
			{
				storyId,
				chapterId: untitled.id,
				positionInChapter: 1,
				globalPosition: 4,
				title: 'Night',
				bodyMd: 'It was night.'
			}
		]);
		const [book] = await resolveAttachments(
			db,
			userId,
			[{ kind: 'story', id: storyId, label: 'Book of Ash', depth: 'book' }],
			BIG
		);
		const headings = book.text.split('\n').filter((line) => line.startsWith('# '));
		expect(headings).toEqual(['# Arrival', '# Scenes outside a chapter', '# Chapter 2']);
		const [chapter] = await resolveAttachments(
			db,
			userId,
			[{ kind: 'chapter', id: untitled.id, label: '' }],
			BIG
		);
		expect(chapter.title).toContain('Chapter 2');
	});
});

describe('searchContext', () => {
	it('lists the stories with no query, and searches every kind', async () => {
		const start = await searchContext(db, userId, '');
		expect(start.map((item) => item.label).sort()).toEqual(['Book of Ash', 'Salt Road']);

		const found = await searchContext(db, userId, 'a');
		const kinds = new Set(found.map((item) => item.kind));
		expect(kinds).toEqual(new Set(['story', 'chapter', 'scene', 'entity', 'note']));
		expect(await searchContext(db, otherId, 'a')).toEqual([]);
	});

	it('leaves muted stories out', async () => {
		await db
			.update(stories)
			.set({ llmConfig: { enabled: false } })
			.where(eq(stories.id, storyId));
		const found = await searchContext(db, userId, 'the');
		expect(found.filter((item) => item.kind === 'scene')).toEqual([]);
		expect(await searchContext(db, userId, 'Threads')).toEqual([]);
		expect(await storyContents(db, userId, storyId)).toBeNull();
	});

	it('leaves trashed stories out', async () => {
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
		expect((await searchContext(db, userId, '')).map((item) => item.label)).toEqual(['Salt Road']);
		expect(await searchContext(db, userId, 'gate')).toEqual([]);
		expect(await storyContents(db, userId, storyId)).toBeNull();
	});

	it('finds a chapter with no title by the name it is shown under', async () => {
		await db.insert(chapters).values({ storyId, position: 2, title: '' });
		const found = await searchContext(db, userId, 'chapter 2');
		expect(found.filter((item) => item.kind === 'chapter').map((item) => item.label)).toEqual([
			'Chapter 2'
		]);
	});

	it('matches % and _ literally', async () => {
		expect(await searchContext(db, userId, '%')).toEqual([]);
		expect(await searchContext(db, userId, '_')).toEqual([]);
	});
});

describe('storyContents', () => {
	it("lists a story's chapters and scenes with the book's size", async () => {
		const contents = await storyContents(db, userId, storyId);
		expect(contents?.chapters.map((c) => c.label)).toEqual(['Arrival']);
		expect(contents?.scenes.map((s) => s.label)).toEqual(['The gate', 'The hall']);
		expect(contents?.words).toBe(8);
		expect(contents?.tokens).toBeGreaterThan(0);
		expect(await storyContents(db, otherId, storyId)).toBeNull();
	});
});
