import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import {
	characters,
	entityMentions,
	entitySuggestions,
	loreEntries,
	places,
	scenes,
	stories,
	universes
} from '../db/schema.ts';
import { completeDetailed, type GatewayDeps } from './gateway.ts';
import { resolveLlmConfig } from './config.ts';
import { buildEnrichMessage } from './prompts/enrich.ts';
import { SpendMeter } from './spend.ts';
import { entityAppearances, getEntityCard } from '../plan-data.ts';
import {
	stageEntitySuggestions,
	type EntityKind,
	type EntitySuggestion,
	type ProposedSuggestion
} from '../entity-suggestions-core.ts';
import type { ChatMessage } from './providers/types.ts';

// Entity enrichment: gather where an entity appears, ask the Assistant for new
// aliases, quick details, and a summary, and stage the result as suggestions
// the writer accepts or rejects. enrichEntity is one completion, run inline from
// the entity editor; enrichUniverse runs it over every entry of a universe as a
// background job. Nothing is applied here - stageEntitySuggestions only stages.

const MAX_APPEARANCES = 16;
const MAX_ENRICH_TOKENS = 700;

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

// Where an entity's appearances are read from: one story (the story Plan) or
// every story in its universe (the universe Plan and the background pass).
export type EnrichScope = { storyId: string } | { universeId: string };

export async function enrichEntity(
	db: Database,
	opts: {
		userId: string;
		scope: EnrichScope;
		entityId: string;
		meter?: SpendMeter;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<EntitySuggestion[]> {
	const card = await getEntityCard(db, opts.userId, opts.entityId);
	if (!card) return [];

	const appearances = await entityAppearances(
		db,
		{ kind: card.kind, id: opts.entityId },
		opts.scope
	);
	const acrossStories = 'universeId' in opts.scope;
	const snippets = appearances.slice(0, MAX_APPEARANCES).map((a) => {
		const where = [acrossStories ? a.storyTitle : null, a.sceneTitle].filter(Boolean).join(' / ');
		return where ? `[${where}] ${a.snippet}` : a.snippet;
	});

	const messages: ChatMessage[] = [
		{
			role: 'user',
			content: buildEnrichMessage(
				{
					kind: card.kind,
					name: card.name,
					aliases: card.aliases,
					details: card.details,
					summaryMd: card.summaryMd,
					hasSummary: !!card.summaryMd?.trim()
				},
				snippets
			)
		}
	];

	const result = await completeDetailed(
		db,
		{
			userId: opts.userId,
			// A story scope carries the story's own mute; the universe scope has only
			// the account gate.
			storyId: 'storyId' in opts.scope ? opts.scope.storyId : undefined,
			role: 'utility',
			enableTools: false,
			messages,
			maxTokens: MAX_ENRICH_TOKENS,
			signal: opts.signal
		},
		deps
	);
	opts.meter?.record(result.model, result.usage);

	const proposals = parseEnrichResponse(result.content);
	if (proposals.length === 0) return [];
	return stageEntitySuggestions(db, {
		ownerId: opts.userId,
		kind: card.kind,
		entityId: opts.entityId,
		proposals
	});
}

export type UniverseEnrichResult = {
	// Entries the pass asked the Assistant about.
	entries: number;
	// Entries that came back with at least one new suggestion, and how many
	// suggestions were staged in all.
	enriched: number;
	suggestions: number;
	failed: number;
	// Set when the run's spend ceiling was reached and the rest was left for a
	// later run.
	capped?: boolean;
	// Set when a cap is configured but could not be enforced (see SpendMeter).
	capNote?: string;
};

// Which of a universe's entries the background pass should ask about: those the
// prose mentions at least once (an entry nobody mentions gives the Assistant
// nothing to read), leaving out any that still have suggestions waiting for the
// writer, so a second run does not pile more on top of an unreviewed batch.
// Exported for integration testing.
export async function universeEnrichTargets(
	db: Database,
	opts: { userId: string; universeId: string }
): Promise<{ kind: EntityKind; id: string }[]> {
	const { userId, universeId } = opts;
	const entries: { kind: EntityKind; id: string }[] = [];
	for (const [kind, table, name] of [
		['character', characters, characters.name],
		['place', places, places.name],
		['lore', loreEntries, loreEntries.title]
	] as const) {
		const rows = await db
			.select({ id: table.id })
			.from(table)
			.where(and(eq(table.universeId, universeId), eq(table.ownerId, userId)))
			.orderBy(asc(name));
		for (const row of rows) entries.push({ kind, id: row.id });
	}
	if (entries.length === 0) return [];

	const mentioned = await db
		.selectDistinct({ targetId: entityMentions.targetId })
		.from(entityMentions)
		.innerJoin(scenes, eq(entityMentions.sourceId, scenes.id))
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(and(eq(entityMentions.sourceType, 'scene'), eq(stories.universeId, universeId)));
	const mentionedIds = new Set(mentioned.map((row) => row.targetId));

	const pending = await db
		.selectDistinct({ entityId: entitySuggestions.entityId })
		.from(entitySuggestions)
		.where(
			and(
				eq(entitySuggestions.ownerId, userId),
				eq(entitySuggestions.status, 'pending'),
				inArray(
					entitySuggestions.entityId,
					entries.map((entry) => entry.id)
				)
			)
		);
	const pendingIds = new Set(pending.map((row) => row.entityId));

	return entries.filter((entry) => mentionedIds.has(entry.id) && !pendingIds.has(entry.id));
}

// The background pass: enrich every mentioned entry of a universe in turn,
// staging what comes back as suggestions. Owner scoped through the universe.
// Per-entry errors are caught so one bad reply does not abandon the rest, and
// the account's spend ceiling is checked between entries.
export async function enrichUniverse(
	db: Database,
	opts: { userId: string; universeId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<UniverseEnrichResult> {
	const { userId, universeId, signal } = opts;
	const result: UniverseEnrichResult = { entries: 0, enriched: 0, suggestions: 0, failed: 0 };
	const [universe] = await db
		.select({ id: universes.id })
		.from(universes)
		.where(and(eq(universes.id, universeId), eq(universes.ownerId, userId)));
	if (!universe) return result;

	const resolved = await resolveLlmConfig(db, userId);
	const meter = new SpendMeter({
		pricing: resolved.config.modelPricing,
		capUsd: resolved.config.spendCapUsd
	});

	for (const target of await universeEnrichTargets(db, { userId, universeId })) {
		if (signal?.aborted) break;
		// Between entries is the boundary where stopping leaves nothing partial.
		if (meter.capReached) {
			result.capped = true;
			break;
		}
		result.entries += 1;
		try {
			const staged = await enrichEntity(
				db,
				{ userId, scope: { universeId }, entityId: target.id, meter, signal },
				deps
			);
			if (staged.length > 0) {
				result.enriched += 1;
				result.suggestions += staged.length;
			}
		} catch (err) {
			if (signal?.aborted) break;
			console.error(`enrich: ${target.kind} ${target.id} failed:`, err);
			result.failed += 1;
		}
	}
	if (meter.notApplied) result.capNote = meter.notAppliedMessage;
	return result;
}
