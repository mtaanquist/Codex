import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { recordEntityRevision } from './revisions';
import { categoryInUniverse, ownsStoryInUniverse } from './entity-lookups';
import { loreEntries, loreStoryNotes } from './db/schema';
import type { EntityDetail } from '$lib/entity-snapshot';

export type LoreSave = {
	// The entry's title; arrives as "name" from the shared entity editor.
	name: string;
	keywords: string[];
	summaryMd: string | null;
	bodyMd: string;
	// Quick details; undefined leaves them unchanged.
	details?: EntityDetail[];
	categoryId?: string;
	// When present, the per-story "In this book" notes are upserted too.
	storyId?: string;
	storyNotesMd?: string;
};

export async function saveLoreEntry(
	db: Database,
	loreEntryId: string,
	userId: string,
	save: LoreSave
): Promise<
	{ ok: true; universeId: string; mentionsAffected: boolean } | { ok: false; reason: string }
> {
	const [entry] = await db
		.select({
			id: loreEntries.id,
			universeId: loreEntries.universeId,
			title: loreEntries.title,
			keywords: loreEntries.keywords,
			categoryId: loreEntries.categoryId
		})
		.from(loreEntries)
		.where(and(eq(loreEntries.id, loreEntryId), eq(loreEntries.ownerId, userId)));
	if (!entry) return { ok: false, reason: 'lore entry not found' };

	const title = save.name.trim();
	if (!title) return { ok: false, reason: 'the entry needs a title' };
	const keywords = save.keywords.map((keyword) => keyword.trim()).filter((k) => k !== '');

	let categoryId = entry.categoryId;
	if (save.categoryId !== undefined && save.categoryId !== entry.categoryId) {
		if (!(await categoryInUniverse(db, save.categoryId, entry.universeId))) {
			return { ok: false, reason: 'category not found' };
		}
		categoryId = save.categoryId;
	}

	// Title and keywords drive mention detection.
	const mentionsAffected =
		title !== entry.title ||
		keywords.length !== entry.keywords.length ||
		keywords.some((keyword, index) => keyword !== entry.keywords[index]);

	// Validate the optional story BEFORE anything is written: the old
	// ordering persisted the save, then reported failure and skipped the
	// mention reindex (review finding #191).
	if (
		save.storyId !== undefined &&
		!(await ownsStoryInUniverse(db, save.storyId, userId, entry.universeId))
	) {
		return { ok: false, reason: 'story not found' };
	}

	// One transaction so the entity update, its History snapshot, and the
	// story-note upsert commit together rather than leaving the entry changed
	// with no matching revision on a part-way failure.
	await db.transaction(async (tx) => {
		await tx
			.update(loreEntries)
			.set({
				title,
				keywords,
				categoryId,
				summaryMd: save.summaryMd?.trim() || null,
				bodyMd: save.bodyMd,
				...(save.details !== undefined ? { details: save.details } : {})
			})
			.where(eq(loreEntries.id, entry.id));
		// Full snapshot, so keyword, summary, category, and detail changes
		// register in History even when the body is untouched.
		await recordEntityRevision(tx, 'lore_entry', entry.id);

		if (save.storyId !== undefined) {
			await tx
				.insert(loreStoryNotes)
				.values({ loreEntryId: entry.id, storyId: save.storyId, notesMd: save.storyNotesMd ?? '' })
				.onConflictDoUpdate({
					target: [loreStoryNotes.loreEntryId, loreStoryNotes.storyId],
					set: { notesMd: save.storyNotesMd ?? '', updatedAt: sql`now()` }
				});
		}
	});
	return { ok: true, universeId: entry.universeId, mentionsAffected };
}
