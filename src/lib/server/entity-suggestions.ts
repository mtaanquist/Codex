import { and, asc, eq } from 'drizzle-orm';
import type { Database } from './auth';
import { characters, entitySuggestions, loreEntries, places } from './db/schema';
import { recordEntityRevision } from './revisions';
import { queueUniverseMentions } from './jobs';
import { MAX_DETAILS, type EntityDetail } from '$lib/entity-snapshot';
import type { EntityKind } from '$lib/components/EntityEditor.svelte';

// The Assistant's staged enrichments for an entity: a new alias, a quick detail,
// or a drafted summary. Nothing here touches an entity until the writer accepts;
// accepting applies the one field and records a 'suggestion' revision, so the
// change shows in History and can be rolled back like any edit. This module runs
// in the app (it queues a mention reindex on an accepted alias), never the worker.

export type { EntityKind };
export type SuggestionField = 'alias' | 'detail' | 'summary';

export type EntitySuggestion = {
	id: string;
	field: SuggestionField;
	label: string | null;
	value: string;
};

// A field the Assistant proposes, before it is staged.
export type ProposedSuggestion =
	| { field: 'alias'; value: string }
	| { field: 'detail'; label: string; value: string }
	| { field: 'summary'; value: string };

const REVISION_TYPE = { character: 'character', place: 'place', lore: 'lore_entry' } as const;

export async function listPendingForEntity(
	db: Database,
	ownerId: string,
	kind: EntityKind,
	entityId: string
): Promise<EntitySuggestion[]> {
	const rows = await db
		.select({
			id: entitySuggestions.id,
			field: entitySuggestions.field,
			label: entitySuggestions.label,
			value: entitySuggestions.value
		})
		.from(entitySuggestions)
		.where(
			and(
				eq(entitySuggestions.ownerId, ownerId),
				eq(entitySuggestions.entityKind, kind),
				eq(entitySuggestions.entityId, entityId),
				eq(entitySuggestions.status, 'pending')
			)
		)
		.orderBy(asc(entitySuggestions.createdAt));
	return rows;
}

// The entity's current alias list (or keyword list for lore), quick details, and
// summary, plus its universe, owner-scoped. Null when it is not the user's.
async function loadEntity(
	db: Database,
	ownerId: string,
	kind: EntityKind,
	entityId: string
): Promise<{
	universeId: string;
	aliases: string[];
	details: EntityDetail[];
	summaryMd: string | null;
} | null> {
	if (kind === 'lore') {
		const [row] = await db
			.select({
				universeId: loreEntries.universeId,
				aliases: loreEntries.keywords,
				details: loreEntries.details,
				summaryMd: loreEntries.summaryMd
			})
			.from(loreEntries)
			.where(and(eq(loreEntries.id, entityId), eq(loreEntries.ownerId, ownerId)));
		return row ?? null;
	}
	const table = kind === 'character' ? characters : places;
	const [row] = await db
		.select({
			universeId: table.universeId,
			aliases: table.aliases,
			details: table.details,
			summaryMd: table.summaryMd
		})
		.from(table)
		.where(and(eq(table.id, entityId), eq(table.ownerId, ownerId)));
	return row ?? null;
}

// Stage proposals as pending suggestions, dropping any that duplicate what the
// entity already has or an already-pending suggestion: an alias already listed, a
// detail whose label exists, or a summary when one is set. Returns the staged
// rows. Skips silently when the entity is not the user's.
export async function stageEntitySuggestions(
	db: Database,
	opts: { ownerId: string; kind: EntityKind; entityId: string; proposals: ProposedSuggestion[] }
): Promise<EntitySuggestion[]> {
	const { ownerId, kind, entityId, proposals } = opts;
	const entity = await loadEntity(db, ownerId, kind, entityId);
	if (!entity) return [];

	const pending = await listPendingForEntity(db, ownerId, kind, entityId);
	const lower = (s: string) => s.trim().toLowerCase();
	const aliasSet = new Set([
		...entity.aliases.map(lower),
		...pending.filter((p) => p.field === 'alias').map((p) => lower(p.value))
	]);
	const labelSet = new Set([
		...entity.details.map((d) => lower(d.label)),
		...pending.filter((p) => p.field === 'detail').map((p) => lower(p.label ?? ''))
	]);
	const hasSummary = !!entity.summaryMd?.trim() || pending.some((p) => p.field === 'summary');

	const toInsert: { field: SuggestionField; label: string | null; value: string }[] = [];
	for (const p of proposals) {
		if (p.field === 'alias') {
			const value = p.value.trim();
			if (!value || aliasSet.has(lower(value))) continue;
			aliasSet.add(lower(value));
			toInsert.push({ field: 'alias', label: null, value });
		} else if (p.field === 'detail') {
			const label = p.label.trim();
			const value = p.value.trim();
			if (!label || !value || labelSet.has(lower(label))) continue;
			labelSet.add(lower(label));
			toInsert.push({ field: 'detail', label, value });
		} else {
			const value = p.value.trim();
			if (!value || hasSummary) continue;
			// Only one summary suggestion per run.
			toInsert.push({ field: 'summary', label: null, value });
			break;
		}
	}
	if (toInsert.length === 0) return [];

	return db
		.insert(entitySuggestions)
		.values(toInsert.map((row) => ({ ownerId, entityKind: kind, entityId, ...row })))
		.returning({
			id: entitySuggestions.id,
			field: entitySuggestions.field,
			label: entitySuggestions.label,
			value: entitySuggestions.value
		});
}

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
