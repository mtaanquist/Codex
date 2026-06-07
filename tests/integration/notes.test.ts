import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { notes, revisions, stories, universes, users } from '../../src/lib/server/db/schema';
import {
	createStoryNote,
	createUniverseNote,
	deleteNote,
	getNote,
	listStoryNotes,
	listUniverseNotes,
	saveNote,
	setNotePinned
} from '../../src/lib/server/notes';
import { createCheckpoint, listRevisions, restoreRevision } from '../../src/lib/server/revisions';
import { deleteStoryWithin } from '../../src/lib/server/story-delete';
import { purgeUniverseWithin } from '../../src/lib/server/universe-lifecycle';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query('truncate table notes, revisions, scenes, stories, universes, users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'notes@example.com', displayName: 'N', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'other@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	universeId = universe.id;
	const [story] = await db.insert(stories).values({ universeId, ownerId, title: 'S' }).returning();
	storyId = story.id;
});

beforeEach(async () => {
	await pool.query('truncate table notes, revisions cascade');
});

afterAll(async () => {
	await pool.end();
});

describe('note scoping', () => {
	it('separates universe notes from story notes', async () => {
		const uniId = await createUniverseNote(db, ownerId, universeId);
		const storyNoteId = await createStoryNote(db, ownerId, universeId, storyId);

		const universeList = await listUniverseNotes(db, universeId, ownerId);
		const storyList = await listStoryNotes(db, storyId, ownerId);
		expect(universeList.map((n) => n.id)).toEqual([uniId]);
		expect(storyList.map((n) => n.id)).toEqual([storyNoteId]);

		// The story note carries its universe; the universe note has no story.
		const storyNote = await getNote(db, storyNoteId, ownerId);
		expect(storyNote).toMatchObject({ universeId, storyId });
		const universeNote = await getNote(db, uniId, ownerId);
		expect(universeNote).toMatchObject({ universeId, storyId: null });
	});

	it('lists pinned first, then most recently edited', async () => {
		const a = await createUniverseNote(db, ownerId, universeId);
		const b = await createUniverseNote(db, ownerId, universeId);
		const c = await createUniverseNote(db, ownerId, universeId);
		// b edited last; c pinned.
		await saveNote(db, a, ownerId, { title: 'A', bodyMd: 'a' });
		await saveNote(db, b, ownerId, { title: 'B', bodyMd: 'b' });
		await setNotePinned(db, c, ownerId, true);

		const list = await listUniverseNotes(db, universeId, ownerId);
		expect(list[0].id).toBe(c); // pinned floats up
		expect(list[0].pinned).toBe(true);
		// Then the unpinned by recency of edit: b before a.
		expect(list.slice(1).map((n) => n.id)).toEqual([b, a]);
	});
});

describe('saveNote', () => {
	it('updates title and body and records a revision', async () => {
		const id = await createStoryNote(db, ownerId, universeId, storyId);
		const result = await saveNote(db, id, ownerId, { title: '  Session 1  ', bodyMd: 'They met.' });
		expect(result.ok).toBe(true);

		const note = await getNote(db, id, ownerId);
		expect(note).toMatchObject({ title: 'Session 1', bodyMd: 'They met.' });
		const history = await listRevisions(db, 'note', id);
		expect(history.length).toBe(1);
	});

	it('blanks a whitespace-only title and refuses another user', async () => {
		const id = await createUniverseNote(db, ownerId, universeId);
		await saveNote(db, id, ownerId, { title: '   ', bodyMd: 'x' });
		expect((await getNote(db, id, ownerId))?.title).toBeNull();
		expect(await saveNote(db, id, strangerId, { title: 'x', bodyMd: 'y' })).toMatchObject({
			ok: false
		});
	});
});

describe('getNote and setNotePinned', () => {
	it('guards by owner', async () => {
		const id = await createUniverseNote(db, ownerId, universeId);
		expect(await getNote(db, id, strangerId)).toBeNull();
		expect(await setNotePinned(db, id, strangerId, true)).toBe(false);
		expect(await setNotePinned(db, id, ownerId, true)).toBe(true);
		expect((await getNote(db, id, ownerId))?.pinned).toBe(true);
	});
});

describe('deleteNote', () => {
	it('removes the note and its revisions, owner-guarded', async () => {
		const id = await createUniverseNote(db, ownerId, universeId);
		await saveNote(db, id, ownerId, { title: 'Gone', bodyMd: 'soon' });
		expect(await deleteNote(db, id, strangerId)).toBe(false);
		expect(await deleteNote(db, id, ownerId)).toBe(true);
		expect(await getNote(db, id, ownerId)).toBeNull();
		expect(await listRevisions(db, 'note', id)).toHaveLength(0);
	});
});

describe('note revisions', () => {
	it('restores a past version body-only', async () => {
		const id = await createUniverseNote(db, ownerId, universeId);
		await saveNote(db, id, ownerId, { title: 'Doc', bodyMd: 'First' });
		await createCheckpoint(db, ownerId, 'note', id, 'v1');
		await saveNote(db, id, ownerId, { title: 'Doc', bodyMd: 'Second' });

		const history = await listRevisions(db, 'note', id);
		const checkpoint = history.find((r) => r.reason === 'checkpoint');
		expect(checkpoint).toBeDefined();
		const result = await restoreRevision(db, ownerId, checkpoint!.id, 'note', id);
		expect(result.ok).toBe(true);
		expect((await getNote(db, id, ownerId))?.bodyMd).toBe('First');
		// The title is untouched by a body-only restore.
		expect((await getNote(db, id, ownerId))?.title).toBe('Doc');
	});
});

describe('cascade cleanup', () => {
	it('story delete removes the story notes and their revisions', async () => {
		const [extraStory] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Doomed' })
			.returning();
		const noteId = await createStoryNote(db, ownerId, universeId, extraStory.id);
		await saveNote(db, noteId, ownerId, { title: 'x', bodyMd: 'y' });

		await db.transaction((tx) => deleteStoryWithin(tx, extraStory.id));
		expect(await getNote(db, noteId, ownerId)).toBeNull();
		expect(await listRevisions(db, 'note', noteId)).toHaveLength(0);
	});

	it('universe purge removes universe notes and their revisions', async () => {
		const [doomed] = await db.insert(universes).values({ ownerId, name: 'Doomed' }).returning();
		const noteId = await createUniverseNote(db, ownerId, doomed.id);
		await saveNote(db, noteId, ownerId, { title: 'x', bodyMd: 'y' });

		await db.transaction((tx) => purgeUniverseWithin(tx, doomed.id));
		expect(await db.select().from(notes).where(eq(notes.id, noteId))).toHaveLength(0);
		expect(
			await db
				.select()
				.from(revisions)
				.where(and(eq(revisions.entityType, 'note'), eq(revisions.entityId, noteId)))
		).toHaveLength(0);
	});
});
