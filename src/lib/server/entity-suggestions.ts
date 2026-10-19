import { and, eq } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, entitySuggestions, loreEntries, places } from './db/schema';
import { recordEntityRevision } from './revisions';
import { queueUniverseMentions } from './jobs';
import { MAX_DETAILS, type EntityDetail } from '$lib/entity-snapshot';
import { loadEntity, type EntityKind, type SuggestionField } from './entity-suggestions-core';

// The Assistant's staged enrichments for an entity: a new alias, a quick detail,
// or a drafted summary. Nothing here touches an entity until the writer accepts;
// accepting applies the one field and records a 'suggestion' revision, so the
// change shows in History and can be rolled back like any edit. This module runs
// in the app (it queues a mention reindex on an accepted alias), never the worker.

export {
	listPendingForEntity,
	stageEntitySuggestions,
	type EntityKind,
	type EntitySuggestion,
	type ProposedSuggestion,
	type SuggestionField
} from './entity-suggestions-core';

const REVISION_TYPE = { character: 'character', place: 'place', lore: 'lore_entry' } as const;

// Accept or reject one suggestion, owner-scoped. Accepting applies the single
// field to the entity and records a 'suggestion' revision; an accepted alias
// requeues the universe mention index (a new alias can match more prose).
export async function decideEntitySuggestion(
	db: Database,
	ownerId: string,
	id: string,
	decision: 'accept' | 'reject'
): Promise<{ ok: boolean; reason?: string }> {
	const [s] = await db
		.select()
		.from(entitySuggestions)
		.where(
			and(
				eq(entitySuggestions.id, id),
				eq(entitySuggestions.ownerId, ownerId),
				eq(entitySuggestions.status, 'pending')
			)
		);
	if (!s) return { ok: false, reason: 'suggestion not found' };

	if (decision === 'reject') {
		await db
			.update(entitySuggestions)
			.set({ status: 'rejected', decidedAt: new Date() })
			.where(eq(entitySuggestions.id, id));
		return { ok: true };
	}

	const kind = s.entityKind as EntityKind;
	let universeId: string | null = null;
	try {
		await db.transaction(async (tx) => {
			universeId = await applyToEntity(tx, ownerId, kind, s.entityId, {
				field: s.field as SuggestionField,
				label: s.label,
				value: s.value
			});
			await recordEntityRevision(tx, REVISION_TYPE[kind], s.entityId, 'suggestion');
			await tx
				.update(entitySuggestions)
				.set({ status: 'accepted', decidedAt: new Date() })
				.where(eq(entitySuggestions.id, id));
		});
	} catch {
		return { ok: false, reason: 'could not apply the suggestion' };
	}

	if (s.field === 'alias' && universeId) await queueUniverseMentions(universeId);
	return { ok: true };
}

// Apply one field to the entity inside a transaction, returning its universe.
// Throws if the entity is not the user's (rolls the transaction back).
async function applyToEntity(
	tx: Database,
	ownerId: string,
	kind: EntityKind,
	entityId: string,
	s: { field: SuggestionField; label: string | null; value: string }
): Promise<string> {
	const entity = await loadEntity(tx, ownerId, kind, entityId);
	if (!entity) throw new Error('entity not found');

	const set: {
		aliases?: string[];
		keywords?: string[];
		details?: EntityDetail[];
		summaryMd?: string;
	} = {};
	if (s.field === 'summary') {
		set.summaryMd = s.value;
	} else if (s.field === 'detail') {
		set.details = [...entity.details, { label: s.label ?? '', value: s.value }].slice(
			0,
			MAX_DETAILS
		);
	} else {
		const aliases = entity.aliases.includes(s.value)
			? entity.aliases
			: [...entity.aliases, s.value];
		if (kind === 'lore') set.keywords = aliases;
		else set.aliases = aliases;
	}

	if (kind === 'character') await tx.update(characters).set(set).where(eq(characters.id, entityId));
	else if (kind === 'place') await tx.update(places).set(set).where(eq(places.id, entityId));
	else await tx.update(loreEntries).set(set).where(eq(loreEntries.id, entityId));
	return entity.universeId;
}
