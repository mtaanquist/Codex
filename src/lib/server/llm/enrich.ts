import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { entityMentions, scenes, stories } from '../db/schema.ts';
import { errorFields, logEvent } from '../log.ts';
import {
	AssistantDisabledError,
	completeDetailed,
	NoModelError,
	ReplyCutOffError,
	type GatewayDeps
} from './gateway.ts';
import { spentFields, type SpendMeter } from './spend.ts';
import { jobSpendMeter } from './job-spend.ts';
import { buildEnrichMessage } from './prompts/enrich.ts';
import { entityAppearances, type PlanAppearance } from '../plan-data.ts';
import {
	ENTITY_TYPES,
	entityAliasColumn,
	entityNameColumn,
	entityTable,
	resolveOwnedEntity
} from '../entity-lookups.ts';
import { inLiveUniverse, storyAssistantOn } from '../universe-scope.ts';
import { STALE_MARK_BEFORE } from '../scene-lifecycle.ts';
import { dbNow } from '../db-clock.ts';
import {
	stageEntitySuggestions,
	summarySuggestionClosed,
	type EntitySuggestion,
	type ProposedSuggestion
} from '../entity-suggestions.ts';
import type { ChatMessage } from './providers/types.ts';

// Inline per-entity enrichment: gather where an entity appears (in one story, or
// across its universe), ask the Assistant for new aliases, quick details, and a
// summary, and stage the result as suggestions the writer accepts or rejects.
// Sync (one completion), like single-scene review. Nothing is applied here -
// stageEntitySuggestions only stages.

export type EnrichScope = { storyId: string } | { universeId: string };

export const MAX_APPEARANCES = 16;
const MAX_ENRICH_TOKENS = 700;
// Failed reads in a row after which the pass stops rather than keep calling an
// endpoint that is down. A cut-off reply is not counted: the endpoint answered.
export const MAX_FAILURES_IN_A_ROW = 3;

// Defensive parse of the model's reply into proposals. Endpoints vary, so this
// pulls the first JSON object out of the text and validates each field, ignoring
// anything malformed rather than throwing. Lore takes keywords, not aliases, but
// the suggestion field is 'alias' either way (applied to the right column on
// accept). Exported for unit testing.
export function parseEnrichResponse(text: string): ProposedSuggestion[] {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1 || end < start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== 'object') return [];
	const obj = parsed as { aliases?: unknown; details?: unknown; summary?: unknown };
	const proposals: ProposedSuggestion[] = [];

	if (Array.isArray(obj.aliases)) {
		for (const a of obj.aliases) {
			if (typeof a === 'string' && a.trim()) proposals.push({ field: 'alias', value: a.trim() });
		}
	}
	if (Array.isArray(obj.details)) {
		for (const d of obj.details) {
			if (d && typeof d === 'object') {
				const label = (d as { label?: unknown }).label;
				const value = (d as { value?: unknown }).value;
				if (
					typeof label === 'string' &&
					typeof value === 'string' &&
					label.trim() &&
					value.trim()
				) {
					proposals.push({ field: 'detail', label: label.trim(), value: value.trim() });
				}
			}
		}
	}
	if (typeof obj.summary === 'string' && obj.summary.trim()) {
		proposals.push({ field: 'summary', value: obj.summary.trim() });
	}
	return proposals;
}

// Up to max appearances, chosen from each story in turn so a universe-wide read
// is not filled by whichever story comes first, then returned in their original
// (reading) order. Exported for unit testing.
export function spreadAppearances<T extends { storyId: string }>(rows: T[], max: number): T[] {
	const byStory = new Map<string, number[]>();
	rows.forEach((row, index) => {
		const list = byStory.get(row.storyId);
		if (list) list.push(index);
		else byStory.set(row.storyId, [index]);
	});
	const queues = [...byStory.values()];
	const picked: number[] = [];
	for (let round = 0; picked.length < max; round++) {
		const before = picked.length;
		for (const queue of queues) {
			if (round < queue.length && picked.length < max) picked.push(queue[round]);
		}
		if (picked.length === before) break;
	}
	return picked.sort((a, b) => a - b).map((index) => rows[index]);
}

// A fingerprint of a request's messages, stored with the watermark so a marked
// entity or arc whose request would be the same is not sent again. Marks are
// set for any passage change, but enrich and arcs send only some passages.
export function requestHash(messages: ChatMessage[]): string {
	return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

function snippetLine(a: PlanAppearance, withStory: boolean): string {
	const where = [withStory ? a.storyTitle : '', a.sceneTitle ?? ''].filter(Boolean).join(' / ');
	return where ? `[${where}] ${a.snippet}` : a.snippet;
}

type EnrichOptions = {
	userId: string;
	scope: EnrichScope;
	entityId: string;
	meter?: SpendMeter;
	signal?: AbortSignal;
};

export async function enrichEntity(
	db: Database,
	opts: EnrichOptions,
	deps: GatewayDeps = {}
): Promise<EntitySuggestion[]> {
	return (await enrichRead(db, opts, deps)).suggestions;
}

// The request an enrich read of this entity would send as things stand, with
// its fingerprint; null when the entity is not the user's or not in the scope.
export async function enrichRequest(
	db: Database,
	opts: { userId: string; scope: EnrichScope; entityId: string }
): Promise<{
	kind: 'character' | 'place' | 'lore';
	messages: ChatMessage[];
	input: string;
} | null> {
	const entity = await resolveOwnedEntity(db, opts.userId, opts.entityId, (table) => ({
		universeId: table.universeId,
		name: entityNameColumn(table),
		aliases: entityAliasColumn(table),
		details: table.details,
		summaryMd: table.summaryMd
	}));
	if (!entity) return null;
	if ('universeId' in opts.scope && entity.universeId !== opts.scope.universeId) return null;
	const kind = entity.type === 'lore_entry' ? ('lore' as const) : entity.type;

	const universeWide = 'universeId' in opts.scope;
	const appearances = await entityAppearances(db, { kind, id: opts.entityId }, opts.scope, {
		assistant: true
	});
	const snippets = spreadAppearances(appearances, MAX_APPEARANCES).map((a) =>
		snippetLine(a, universeWide)
	);

	const fields = {
		kind,
		name: entity.name,
		aliases: entity.aliases ?? [],
		details: entity.details ?? [],
		summaryMd: entity.summaryMd
	};
	const hasSummary = await summarySuggestionClosed(db, {
		ownerId: opts.userId,
		kind,
		entityId: opts.entityId,
		summaryMd: entity.summaryMd
	});
	const messages: ChatMessage[] = [
		{ role: 'user', content: buildEnrichMessage({ ...fields, hasSummary }, snippets) }
	];
	// Hashed as if no summary were known: a read that stages a summary would
	// otherwise change the next request, and an unchanged passage set would be
	// sent again just to be told not to propose one.
	const input = requestHash([
		{ role: 'user', content: buildEnrichMessage({ ...fields, hasSummary: false }, snippets) }
	]);
	return { kind, messages, input };
}

// enrichEntity, plus the hash of the request it built. With `unlessInput`, a
// request with that hash is not sent (unchanged: true).
async function enrichRead(
	db: Database,
	opts: EnrichOptions & { unlessInput?: string | null },
	deps: GatewayDeps
): Promise<{ suggestions: EntitySuggestion[]; input: string | null; unchanged: boolean }> {
	const request = await enrichRequest(db, opts);
	if (!request) return { suggestions: [], input: null, unchanged: false };
	const { kind, messages, input } = request;
	if (opts.unlessInput && input === opts.unlessInput) {
		return { suggestions: [], input, unchanged: true };
	}

	const result = await completeDetailed(
		db,
		{
			userId: opts.userId,
			// A story scope carries its mute and model override; the universe
			// scope runs on the account settings.
			storyId: 'storyId' in opts.scope ? opts.scope.storyId : undefined,
			role: 'utility',
			enableTools: false,
			messages,
			maxTokens: MAX_ENRICH_TOKENS,
			meter: opts.meter,
			signal: opts.signal
		},
		deps
	);
	// Cut-off JSON parses to nothing; failing keeps the entity unmarked so the
	// next pass reads it again.
	if (result.cutOff) {
		throw new ReplyCutOffError(
			'The suggestions were cut off at the reply limit. Raise Longest reply for Background work in its Tune window under Account, Assistant.'
		);
	}

	const proposals = parseEnrichResponse(result.content);
	if (proposals.length === 0) return { suggestions: [], input, unchanged: false };
	const suggestions = await stageEntitySuggestions(db, {
		ownerId: opts.userId,
		kind,
		entityId: opts.entityId,
		proposals
	});
	return { suggestions, input, unchanged: false };
}

export type UniverseEnrichResult = {
	// Entities the pass read, and how many suggestions it staged across them.
	entities: number;
	// Entities passed over because the request would have been the same as
	// their last read.
	unchanged?: number;
	staged: number;
	failed: number;
	// Why reads failed when replies were cut off at the limit, and how many.
	cutOff?: string;
	cutOffs?: number;
	// Set when the job was stopped (expired, shut down) before the pass finished.
	aborted?: boolean;
	// Set when the Assistant was turned off while the pass ran.
	disabled?: boolean;
	// Set when the pass stopped because no model is chosen for it.
	noModel?: boolean;
	// Set when the pass gave up after MAX_FAILURES_IN_A_ROW failed reads.
	stoppedFailing?: boolean;
	// Set when the spend ceiling stopped the pass early, with what it had spent.
	capped?: boolean;
	spentUsd?: number;
	// Set when spentUsd includes estimated counts, not only reported ones.
	spentEstimated?: boolean;
	// Why a cap that was set could not be enforced.
	capNotApplied?: string;
};

// The universe's entities worth enriching: those mentioned in at least one live
// scene, never enriched or marked since the last pass (a passage that mentions
// them changed, or a scene or story holding them was deleted, restored, or
// unmuted). Characters, then places, then lore, each by name.
async function entitiesToEnrich(db: Database, userId: string, universeId: string) {
	const out: { id: string; type: (typeof ENTITY_TYPES)[number] }[] = [];
	for (const type of ENTITY_TYPES) {
		const table = entityTable(type);
		const rows = await db
			.select({ id: table.id })
			.from(table)
			.innerJoin(
				entityMentions,
				and(
					eq(entityMentions.targetType, type),
					eq(entityMentions.targetId, table.id),
					eq(entityMentions.sourceType, 'scene')
				)
			)
			.innerJoin(scenes, eq(scenes.id, entityMentions.sourceId))
			.innerJoin(stories, eq(stories.id, scenes.storyId))
			.where(
				and(
					eq(table.universeId, universeId),
					eq(table.ownerId, userId),
					eq(stories.universeId, universeId),
					isNull(stories.deletedAt),
					isNull(scenes.deletedAt),
					storyAssistantOn(),
					inLiveUniverse(table.universeId),
					or(isNull(table.assistantEnrichedAt), lt(table.assistantEnrichedAt, STALE_MARK_BEFORE))
				)
			)
			.groupBy(table.id, entityNameColumn(table))
			.orderBy(asc(entityNameColumn(table)));
		out.push(...rows.map((row) => ({ id: row.id, type })));
	}
	return out;
}

// The background pass: enrich every entity in the universe that has new prose
// to read, staging suggestions for the writer exactly as the inline button does.
// Each entity is marked with the time its read started, so an edit made while
// the pass runs is picked up next time. A failed entity is not marked, so the
// next pass tries it again. Stops between entities at the spend cap or when the
// job is stopped, and stops early when the Assistant is turned off or the
// endpoint keeps failing.
export async function enrichUniverse(
	db: Database,
	opts: { userId: string; universeId: string; jobId?: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<UniverseEnrichResult> {
	const { userId, universeId, signal } = opts;
	// Keyed by the job, so a retry carries on from what it already spent.
	const meter = await jobSpendMeter(db, { userId, jobId: opts.jobId });
	let entities = 0;
	let unchanged = 0;
	let staged = 0;
	let failed = 0;
	let capped = false;
	let aborted = false;
	let disabled = false;
	let noModel = false;
	let stoppedFailing = false;
	let failedInARow = 0;
	let cutOff: string | undefined;
	let cutOffs = 0;

	const todo = await entitiesToEnrich(db, userId, universeId);
	for (const [index, entity] of todo.entries()) {
		if (signal?.aborted) {
			aborted = true;
			break;
		}
		if (meter.capReached) {
			capped = true;
			break;
		}
		// A real time, so any mark set while the model reads stands apart from it.
		const startedAt = await dbNow(db);
		const table = entityTable(entity.type);
		// As text, so the check below compares to the microsecond; a JS Date
		// keeps only milliseconds, and marks land often.
		const [last] = await db
			.select({
				before: sql<string | null>`${table.assistantEnrichedAt}::text`,
				lastInput: table.assistantEnrichedInput
			})
			.from(table)
			.where(eq(table.id, entity.id));
		// Deleted since the pass listed it: nothing left to read.
		if (!last) continue;
		const { before, lastInput } = last;
		try {
			const read = await enrichRead(
				db,
				{
					userId,
					scope: { universeId },
					entityId: entity.id,
					meter,
					signal,
					unlessInput: lastInput
				},
				deps
			);
			// An unmute while the model was reading cleared the mark so the next
			// pass reads the entity again; that stands. A request the same as the
			// last one only clears the mark.
			await db
				.update(table)
				.set({
					assistantEnrichedAt: startedAt,
					...(read.input ? { assistantEnrichedInput: read.input } : {}),
					updatedAt: sql`${table.updatedAt}`
				})
				.where(
					and(
						eq(table.id, entity.id),
						sql`${table.assistantEnrichedAt} is not distinct from ${before}::timestamptz`
					)
				);
			if (read.unchanged) {
				unchanged += 1;
				continue;
			}
			entities += 1;
			staged += read.suggestions.length;
			failedInARow = 0;
		} catch (err) {
			if (signal?.aborted) {
				aborted = true;
				break;
			}
			// Every later entity would be refused the same way.
			if (err instanceof NoModelError) {
				noModel = true;
				break;
			}
			if (err instanceof AssistantDisabledError) {
				disabled = true;
				break;
			}
			logEvent('error', 'assistant.enrich_failed', { entityId: entity.id, ...errorFields(err) });
			failed += 1;
			if (err instanceof ReplyCutOffError) {
				cutOff = err.message;
				cutOffs += 1;
				failedInARow = 0;
			} else {
				failedInARow += 1;
				// Only a stop with entities still to read; a pass that failed on its
				// last entity finished anyway.
				if (failedInARow >= MAX_FAILURES_IN_A_ROW && index < todo.length - 1) {
					stoppedFailing = true;
					break;
				}
			}
		}
	}

	await meter.flush();
	return {
		entities,
		...(unchanged ? { unchanged } : {}),
		staged,
		failed,
		...(cutOff ? { cutOff, cutOffs } : {}),
		...(aborted ? { aborted: true } : {}),
		...(disabled ? { disabled: true } : {}),
		...(noModel ? { noModel: true } : {}),
		...(stoppedFailing ? { stoppedFailing: true } : {}),
		...(capped ? { capped: true, ...spentFields(meter) } : {}),
		...(meter.notApplied ? { capNotApplied: meter.notAppliedMessage } : {})
	};
}
