import { eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { recordEntityRevision } from './revisions';
import {
	categoryInUniverse,
	entityAliasColumn,
	entityNameColumn,
	entityNaming,
	entityTable,
	ownedLiveEntity,
	ownsStoryInUniverse
} from './entity-lookups';
import { characterStoryNotes, loreStoryNotes, placeStoryNotes } from './db/schema';
import type { EntityDetail } from '$lib/entity-snapshot';
import type { ActionFailure } from './action-result.ts';

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
	{ ok: true; universeId: string; mentionsAffected: boolean } | ActionFailure;

const NOUN: Record<EntitySaveKind, { label: string; nameNoun: string }> = {
	character: { label: 'character', nameNoun: 'name' },
	place: { label: 'place', nameNoun: 'name' },
	lore: { label: 'lore entry', nameNoun: 'title' }
};

const ENTITY_TYPE = { character: 'character', place: 'place', lore: 'lore_entry' } as const;

// The per-story "In this book" notes live in one table per kind.
async function upsertStoryNotes(
	tx: Database,
	kind: EntitySaveKind,
	id: string,
	storyId: string,
	notesMd: string
) {
	const set = { notesMd, updatedAt: sql`now()` };
	if (kind === 'character') {
		await tx
			.insert(characterStoryNotes)
			.values({ characterId: id, storyId, notesMd })
			.onConflictDoUpdate({
				target: [characterStoryNotes.characterId, characterStoryNotes.storyId],
				set
			});
	} else if (kind === 'place') {
		await tx
			.insert(placeStoryNotes)
			.values({ placeId: id, storyId, notesMd })
			.onConflictDoUpdate({ target: [placeStoryNotes.placeId, placeStoryNotes.storyId], set });
	} else {
		await tx
			.insert(loreStoryNotes)
			.values({ loreEntryId: id, storyId, notesMd })
			.onConflictDoUpdate({ target: [loreStoryNotes.loreEntryId, loreStoryNotes.storyId], set });
	}
}

function adapter(db: Database, kind: EntitySaveKind, entityId: string, userId: string) {
	const type = ENTITY_TYPE[kind];
	const table = entityTable(type);
	return {
		async load() {
			const [row] = await db
				.select({
					id: table.id,
					universeId: table.universeId,
					name: entityNameColumn(table),
					tags: entityAliasColumn(table)
				})
				.from(table)
				.where(ownedLiveEntity(table, entityId, userId));
			return row ?? null;
		},
		async update(tx: Database, id: string, fields: Record<string, unknown>) {
			const { name, tags, ...rest } = fields;
			await tx
				.update(table)
				.set({ ...entityNaming(type, name as string, tags as string[]), ...rest })
				.where(eq(table.id, id));
			await recordEntityRevision(tx, type, id);
		},
		upsertNotes: (tx: Database, id: string, storyId: string, notesMd: string) =>
			upsertStoryNotes(tx, kind, id, storyId, notesMd)
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
	if (!entity) return { ok: false, code: 'not_found', reason: `That ${label} does not exist.` };

	const name = save.name.trim();
	if (!name) return { ok: false, code: 'invalid', reason: `Give the ${label} a ${nameNoun}.` };
	const tags = save.tags.map((tag) => tag.trim()).filter((tag) => tag !== '');

	// Only a changed name or tag set can add or remove mentions; body and
	// summary edits should not trigger a universe-wide reindex.
	const mentionsAffected =
		name !== entity.name ||
		tags.length !== entity.tags.length ||
		tags.some((tag, index) => tag !== entity.tags[index]);

	if (kind === 'lore' && save.categoryId === null) {
		return { ok: false, code: 'invalid', reason: 'Choose a category for the lore entry.' };
	}
	if (
		save.categoryId != null &&
		!(await categoryInUniverse(db, save.categoryId, entity.universeId))
	) {
		return { ok: false, code: 'not_found', reason: 'That category does not exist.' };
	}

	// Validate the optional story BEFORE anything is written: the old
	// ordering persisted the save, then reported failure and skipped the
	// mention reindex (review finding #191).
	if (
		save.storyId !== undefined &&
		!(await ownsStoryInUniverse(db, save.storyId, userId, entity.universeId))
	) {
		return { ok: false, code: 'not_found', reason: 'That story does not exist.' };
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
