import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { recordEntityRevision } from './revisions';
import { categoryInUniverse, ownsStoryInUniverse } from './entity-lookups';
import {
	characters,
	characterStoryNotes,
	loreEntries,
	loreStoryNotes,
	places,
	placeStoryNotes
} from './db/schema';
import type { EntityDetail } from '$lib/entity-snapshot';

// One save path for all three entity kinds. The flow carries real invariants
// that must not drift between kinds: validate everything BEFORE anything is
// written (review finding #191), compare name and tags to decide whether the
// universe-wide mention reindex is needed, and commit the entity update, its
// History snapshot, and the story-note upsert in one transaction.

export type EntitySaveKind = 'character' | 'place' | 'lore';

export type EntitySave = {
	// The display name; lore stores it as "title".
	name: string;
	// The mention-detection tags: aliases for characters and places,
	// keywords for lore.
	tags: string[];
	summaryMd: string | null;
	bodyMd: string;
	// Quick details; undefined leaves them unchanged.
	details?: EntityDetail[];
	// Optional grouping; null clears it, undefined leaves it unchanged. A
	// lore entry always has a category (NOT NULL in the schema), so null is
	// refused there.
	categoryId?: string | null;
	// When present, the per-story "In this book" notes are upserted too.
	storyId?: string;
	storyNotesMd?: string;
};

export type EntitySaveResult =
	| { ok: true; universeId: string; mentionsAffected: boolean }
	| { ok: false; reason: string };

const NOUN: Record<EntitySaveKind, { label: string; nameNoun: string }> = {
	character: { label: 'character', nameNoun: 'name' },
	place: { label: 'place', nameNoun: 'name' },
	lore: { label: 'lore entry', nameNoun: 'title' }
};

// The kind-specific row reads and writes, so the shared flow stays fully
// typed per table (the entity-suggestions.ts pattern, one step further).
function adapter(db: Database, kind: EntitySaveKind, entityId: string, userId: string) {
	if (kind === 'character') {
		return {
			async load() {
				const [row] = await db
					.select({
						id: characters.id,
						universeId: characters.universeId,
						name: characters.name,
						tags: characters.aliases
					})
					.from(characters)
					.where(and(eq(characters.id, entityId), eq(characters.ownerId, userId)));
				return row ?? null;
			},
			async update(tx: Database, id: string, fields: Record<string, unknown>) {
				const { name, tags, ...rest } = fields;
				await tx
					.update(characters)
					.set({ name: name as string, aliases: tags as string[], ...rest })
					.where(eq(characters.id, id));
				await recordEntityRevision(tx, 'character', id);
			},
			async upsertNotes(tx: Database, id: string, storyId: string, notesMd: string) {
				await tx
					.insert(characterStoryNotes)
					.values({ characterId: id, storyId, notesMd })
					.onConflictDoUpdate({
						target: [characterStoryNotes.characterId, characterStoryNotes.storyId],
						set: { notesMd, updatedAt: sql`now()` }
					});
			}
		};
	}
	if (kind === 'place') {
		return {
			async load() {
				const [row] = await db
					.select({
						id: places.id,
						universeId: places.universeId,
						name: places.name,
						tags: places.aliases
					})
					.from(places)
					.where(and(eq(places.id, entityId), eq(places.ownerId, userId)));
				return row ?? null;
			},
			async update(tx: Database, id: string, fields: Record<string, unknown>) {
				const { name, tags, ...rest } = fields;
				await tx
					.update(places)
					.set({ name: name as string, aliases: tags as string[], ...rest })
					.where(eq(places.id, id));
				await recordEntityRevision(tx, 'place', id);
			},
			async upsertNotes(tx: Database, id: string, storyId: string, notesMd: string) {
				await tx
					.insert(placeStoryNotes)
					.values({ placeId: id, storyId, notesMd })
					.onConflictDoUpdate({
						target: [placeStoryNotes.placeId, placeStoryNotes.storyId],
						set: { notesMd, updatedAt: sql`now()` }
					});
			}
		};
	}
	return {
		async load() {
			const [row] = await db
				.select({
					id: loreEntries.id,
					universeId: loreEntries.universeId,
					name: loreEntries.title,
					tags: loreEntries.keywords
				})
				.from(loreEntries)
				.where(and(eq(loreEntries.id, entityId), eq(loreEntries.ownerId, userId)));
			return row ?? null;
		},
		async update(tx: Database, id: string, fields: Record<string, unknown>) {
			const { name, tags, ...rest } = fields;
			await tx
				.update(loreEntries)
				.set({ title: name as string, keywords: tags as string[], ...rest })
				.where(eq(loreEntries.id, id));
			await recordEntityRevision(tx, 'lore_entry', id);
		},
		async upsertNotes(tx: Database, id: string, storyId: string, notesMd: string) {
			await tx
				.insert(loreStoryNotes)
				.values({ loreEntryId: id, storyId, notesMd })
				.onConflictDoUpdate({
					target: [loreStoryNotes.loreEntryId, loreStoryNotes.storyId],
					set: { notesMd, updatedAt: sql`now()` }
				});
		}
	};
}

export async function saveEntity(
	db: Database,
	kind: EntitySaveKind,
	entityId: string,
	userId: string,
	save: EntitySave
): Promise<EntitySaveResult> {
	const { label, nameNoun } = NOUN[kind];
	const rows = adapter(db, kind, entityId, userId);
	const entity = await rows.load();
	if (!entity) return { ok: false, reason: `${label} not found` };

	const name = save.name.trim();
	if (!name) return { ok: false, reason: `the ${label} needs a ${nameNoun}` };
	const tags = save.tags.map((tag) => tag.trim()).filter((tag) => tag !== '');

	// Only a changed name or tag set can add or remove mentions; body and
	// summary edits should not trigger a universe-wide reindex.
	const mentionsAffected =
		name !== entity.name ||
		tags.length !== entity.tags.length ||
		tags.some((tag, index) => tag !== entity.tags[index]);

	if (kind === 'lore' && save.categoryId === null) {
		return { ok: false, reason: 'a lore entry needs a category' };
	}
	if (
		save.categoryId != null &&
		!(await categoryInUniverse(db, save.categoryId, entity.universeId))
	) {
		return { ok: false, reason: 'category not found' };
	}

	// Validate the optional story BEFORE anything is written: the old
	// ordering persisted the save, then reported failure and skipped the
	// mention reindex (review finding #191).
	if (
		save.storyId !== undefined &&
		!(await ownsStoryInUniverse(db, save.storyId, userId, entity.universeId))
	) {
		return { ok: false, reason: 'story not found' };
	}

	// One transaction so the entity update, its History snapshot (a full
	// snapshot, so tag, summary, category, and detail changes register even
	// when the body is untouched), and the story-note upsert commit together.
	await db.transaction(async (tx) => {
		await rows.update(tx, entity.id, {
			name,
			tags,
			summaryMd: save.summaryMd?.trim() || null,
			bodyMd: save.bodyMd,
			...(save.details !== undefined ? { details: save.details } : {}),
			...(save.categoryId !== undefined ? { categoryId: save.categoryId } : {})
		});
		if (save.storyId !== undefined) {
			await rows.upsertNotes(tx, entity.id, save.storyId, save.storyNotesMd ?? '');
		}
	});
	return { ok: true, universeId: entity.universeId, mentionsAffected };
}
