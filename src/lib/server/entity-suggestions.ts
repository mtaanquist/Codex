import { and, asc, eq, sql } from 'drizzle-orm';
import type { ActionFailure } from './action-result.ts';
import type { Database } from './auth.ts';
import { entitySuggestions } from './db/schema.ts';
import { entityAliasColumn, entityTable, ownedLiveEntity } from './entity-lookups.ts';
import { recordEntityRevision } from './revisions.ts';
import { MAX_DETAILS, type EntityDetail } from '#lib/entity-snapshot';
import type { EntityKind } from '#lib/components/EntityEditor.svelte';

// The Assistant's staged enrichments for an entity: a new alias, a quick detail,
// or a drafted summary. Nothing here touches an entity until the writer accepts;
// accepting applies the one field and records a 'suggestion' revision, so the
// change shows in History and can be rolled back like any edit. The app and the
// worker (the background enrichment pass) both use it.

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
	entityId: string,
	options: { lock?: boolean } = {}
): Promise<{
	universeId: string;
	aliases: string[];
	details: EntityDetail[];
	summaryMd: string | null;
} | null> {
	const table = entityTable(REVISION_TYPE[kind]);
	const query = db
		.select({
			universeId: table.universeId,
			aliases: entityAliasColumn(table),
			details: table.details,
			summaryMd: table.summaryMd
		})
		.from(table)
		.where(ownedLiveEntity(table, entityId, ownerId));
	const [row] = options.lock ? await query.for('update') : await query;
	return row ?? null;
}

// Stage proposals as pending suggestions, dropping any that duplicate what the
// entity already has, an already-pending suggestion, or one the writer rejected:
// an alias already listed or ever suggested before (so one the writer accepted
// and later removed stays gone), a detail whose label exists (or that
// exact label and value was turned down), or a summary when one is set or
// pending. Returns the staged rows. Skips silently when the entity is not the
// user's.
export async function stageEntitySuggestions(
	db: Database,
	opts: { ownerId: string; kind: EntityKind; entityId: string; proposals: ProposedSuggestion[] }
): Promise<EntitySuggestion[]> {
	const { ownerId, kind, entityId, proposals } = opts;
	const entity = await loadEntity(db, ownerId, kind, entityId);
	if (!entity) return [];

	const earlier = await db
		.select({
			field: entitySuggestions.field,
			label: entitySuggestions.label,
			value: entitySuggestions.value,
			status: entitySuggestions.status
		})
		.from(entitySuggestions)
		.where(
			and(
				eq(entitySuggestions.ownerId, ownerId),
				eq(entitySuggestions.entityKind, kind),
				eq(entitySuggestions.entityId, entityId)
			)
		);
	const pending = earlier.filter((p) => p.status === 'pending');
	const rejected = earlier.filter((p) => p.status === 'rejected');
	const lower = (s: string) => s.trim().toLowerCase();
	const detailKey = (label: string, value: string) => `${lower(label)}\u0000${lower(value)}`;
	const aliasSet = new Set([
		...entity.aliases.map(lower),
		...earlier.filter((p) => p.field === 'alias').map((p) => lower(p.value))
	]);
	const labelSet = new Set([
		...entity.details.map((d) => lower(d.label)),
		...pending.filter((p) => p.field === 'detail').map((p) => lower(p.label ?? ''))
	]);
	const rejectedDetails = new Set(
		rejected.filter((p) => p.field === 'detail').map((p) => detailKey(p.label ?? '', p.value))
	);
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
			if (rejectedDetails.has(detailKey(label, value))) continue;
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
// names the universe whose mention index the caller should requeue (a new alias
// can match more prose). The queueing is left to the caller so this module stays
// importable by the worker, which cannot load jobs.ts.
export async function decideEntitySuggestion(
	db: Database,
	ownerId: string,
	id: string,
	decision: 'accept' | 'reject'
): Promise<{ ok: true; reindexUniverseId?: string } | ActionFailure> {
	const gone: ActionFailure = {
		ok: false,
		code: 'not_found',
		reason: 'That suggestion no longer exists.'
	};
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
	if (!s) return gone;

	// Only a still-pending row is decided, so a double click or a second tab
	// cannot apply the same suggestion twice.
	const stillPending = and(eq(entitySuggestions.id, id), eq(entitySuggestions.status, 'pending'));

	if (decision === 'reject') {
		const rejected = await db
			.update(entitySuggestions)
			.set({ status: 'rejected', decidedAt: new Date() })
			.where(stillPending)
			.returning({ id: entitySuggestions.id });
		return rejected.length ? { ok: true } : gone;
	}

	const kind = s.entityKind as EntityKind;
	let universeId: string | null = null;
	try {
		await db.transaction(async (tx) => {
			const claimed = await tx
				.update(entitySuggestions)
				.set({ status: 'accepted', decidedAt: new Date() })
				.where(stillPending)
				.returning({ id: entitySuggestions.id });
			if (!claimed.length) throw new AlreadyDecided();
			universeId = await applyToEntity(tx, ownerId, kind, s.entityId, {
				field: s.field as SuggestionField,
				label: s.label,
				value: s.value
			});
			await recordEntityRevision(tx, REVISION_TYPE[kind], s.entityId, 'suggestion');
		});
	} catch (error) {
		if (error instanceof AlreadyDecided) return gone;
		if (error instanceof SummaryTaken) {
			return {
				ok: false,
				code: 'conflict',
				reason: 'This entry already has a summary, so the suggestion was not added.'
			};
		}
		return { ok: false, code: 'conflict', reason: 'That suggestion could not be applied.' };
	}

	if (s.field === 'alias' && universeId) return { ok: true, reindexUniverseId: universeId };
	return { ok: true };
}

// A summary suggestion can sit pending for days; the writer may have written
// their own since, and accepting must never replace it.
class SummaryTaken extends Error {}
class AlreadyDecided extends Error {}

// Apply one field to the entity inside a transaction, returning its universe.
// Throws if the entity is not the user's (rolls the transaction back).
async function applyToEntity(
	tx: Database,
	ownerId: string,
	kind: EntityKind,
	entityId: string,
	s: { field: SuggestionField; label: string | null; value: string }
): Promise<string> {
	// Locked, so a save that lands meanwhile is read before the arrays are
	// rewritten rather than overwritten by them.
	const entity = await loadEntity(tx, ownerId, kind, entityId, { lock: true });
	if (!entity) throw new Error('entity not found');

	const set: {
		aliases?: string[];
		keywords?: string[];
		details?: EntityDetail[];
		summaryMd?: string;
	} = {};
	if (s.field === 'summary') {
		if (entity.summaryMd?.trim()) throw new SummaryTaken();
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

	const table = entityTable(REVISION_TYPE[kind]);
	// The summary check is repeated in the write itself, so a save that lands
	// between the read and this update is not replaced.
	const updated = await tx
		.update(table)
		.set(set)
		.where(
			s.field === 'summary'
				? and(eq(table.id, entityId), sql`coalesce(trim(${table.summaryMd}), '') = ''`)
				: eq(table.id, entityId)
		)
		.returning({ id: table.id });
	if (updated.length === 0) throw new SummaryTaken();
	return entity.universeId;
}
