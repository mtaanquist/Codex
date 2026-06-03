import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { entityCategories, loreEntries, loreStoryNotes, stories } from './db/schema';

export type LoreSave = {
	// The entry's title; arrives as "name" from the shared entity editor.
	name: string;
	keywords: string[];
	summaryMd: string | null;
	bodyMd: string;
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
		const [category] = await db
			.select({ id: entityCategories.id })
			.from(entityCategories)
			.where(
				and(
					eq(entityCategories.id, save.categoryId),
					eq(entityCategories.universeId, entry.universeId)
				)
			);
		if (!category) return { ok: false, reason: 'category not found' };
		categoryId = category.id;
	}

	// Title and keywords drive mention detection.
	const mentionsAffected =
		title !== entry.title ||
		keywords.length !== entry.keywords.length ||
		keywords.some((keyword, index) => keyword !== entry.keywords[index]);

	await db
		.update(loreEntries)
		.set({
			title,
			keywords,
			categoryId,
			summaryMd: save.summaryMd?.trim() || null,
			bodyMd: save.bodyMd
		})
		.where(eq(loreEntries.id, entry.id));

	if (save.storyId !== undefined) {
		const [story] = await db
			.select({ id: stories.id })
			.from(stories)
			.where(and(eq(stories.id, save.storyId), eq(stories.ownerId, userId)));
		if (!story) return { ok: false, reason: 'story not found' };
		await db
			.insert(loreStoryNotes)
			.values({ loreEntryId: entry.id, storyId: story.id, notesMd: save.storyNotesMd ?? '' })
			.onConflictDoUpdate({
				target: [loreStoryNotes.loreEntryId, loreStoryNotes.storyId],
				set: { notesMd: save.storyNotesMd ?? '', updatedAt: sql`now()` }
			});
	}
	return { ok: true, universeId: entry.universeId, mentionsAffected };
}
