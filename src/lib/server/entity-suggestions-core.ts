import { and, asc, eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { characters, entitySuggestions, loreEntries, places } from './db/schema.ts';
import type { EntityDetail } from '$lib/entity-snapshot';
import type { EntityKind } from '$lib/components/EntityEditor.svelte';

// Listing and staging the Assistant's entity suggestions, split from
// entity-suggestions.ts (which applies them and queues a mention reindex, so
// it runs in the app only) because the worker's background enrichment stages
// suggestions too.

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
export async function loadEntity(
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
