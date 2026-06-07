import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from './auth';
import { notes, revisions } from './db/schema';
import { recordRevision } from './revisions';

// Freeform writer notes, scoped to a universe or a story. Universe notes have
// story_id null; story notes carry both the story and its universe. The list
// order is pinned first, then most recently edited.

export type NoteListItem = {
	id: string;
	title: string | null;
	pinned: boolean;
	updatedAt: Date;
};

export type Note = {
	id: string;
	title: string | null;
	bodyMd: string;
	pinned: boolean;
	universeId: string | null;
	storyId: string | null;
};

const LIST_COLUMNS = {
	id: notes.id,
	title: notes.title,
	pinned: notes.pinned,
	updatedAt: notes.updatedAt
};

/** A story's own notes, newest-edited first within pinned and unpinned. */
export async function listStoryNotes(
	db: Database,
	storyId: string,
	userId: string
): Promise<NoteListItem[]> {
	return db
		.select(LIST_COLUMNS)
		.from(notes)
		.where(and(eq(notes.storyId, storyId), eq(notes.ownerId, userId)))
		.orderBy(desc(notes.pinned), desc(notes.updatedAt));
}

/** A universe's own notes: those not attached to any story. */
export async function listUniverseNotes(
	db: Database,
	universeId: string,
	userId: string
): Promise<NoteListItem[]> {
	return db
		.select(LIST_COLUMNS)
		.from(notes)
		.where(and(eq(notes.universeId, universeId), isNull(notes.storyId), eq(notes.ownerId, userId)))
		.orderBy(desc(notes.pinned), desc(notes.updatedAt));
}

/** One note, owner-guarded; null when it is missing or another user's. */
export async function getNote(db: Database, noteId: string, userId: string): Promise<Note | null> {
	const [row] = await db
		.select({
			id: notes.id,
			title: notes.title,
			bodyMd: notes.bodyMd,
			pinned: notes.pinned,
			universeId: notes.universeId,
			storyId: notes.storyId
		})
		.from(notes)
		.where(and(eq(notes.id, noteId), eq(notes.ownerId, userId)));
	return row ?? null;
}

/** Creates a blank universe note and returns its id. The caller checks
 * universe ownership. */
export async function createUniverseNote(
	db: Database,
	userId: string,
	universeId: string
): Promise<string> {
	const [row] = await db
		.insert(notes)
		.values({ ownerId: userId, universeId })
		.returning({ id: notes.id });
	return row.id;
}

/** Creates a blank story note (carrying its universe) and returns its id. The
 * caller checks story ownership. */
export async function createStoryNote(
	db: Database,
	userId: string,
	universeId: string,
	storyId: string
): Promise<string> {
	const [row] = await db
		.insert(notes)
		.values({ ownerId: userId, universeId, storyId })
		.returning({ id: notes.id });
	return row.id;
}

/** Saves a note's title and body, recording a body-only revision. */
export async function saveNote(
	db: Database,
	noteId: string,
	userId: string,
	save: { title: string | null; bodyMd: string }
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const note = await getNote(db, noteId, userId);
	if (!note) return { ok: false, reason: 'note not found' };
	const title = save.title?.trim() || null;
	await db.transaction(async (tx) => {
		await tx.update(notes).set({ title, bodyMd: save.bodyMd }).where(eq(notes.id, noteId));
		await recordRevision(tx, 'note', noteId, save.bodyMd);
	});
	return { ok: true };
}

/** Pins or unpins a note. */
export async function setNotePinned(
	db: Database,
	noteId: string,
	userId: string,
	pinned: boolean
): Promise<boolean> {
	const [row] = await db
		.update(notes)
		.set({ pinned })
		.where(and(eq(notes.id, noteId), eq(notes.ownerId, userId)))
		.returning({ id: notes.id });
	return Boolean(row);
}

/** Deletes a note and its revision history. */
export async function deleteNote(db: Database, noteId: string, userId: string): Promise<boolean> {
	const note = await getNote(db, noteId, userId);
	if (!note) return false;
	await db.transaction(async (tx) => {
		await tx
			.delete(revisions)
			.where(and(eq(revisions.entityType, 'note'), eq(revisions.entityId, noteId)));
		await tx.delete(notes).where(eq(notes.id, noteId));
	});
	return true;
}
