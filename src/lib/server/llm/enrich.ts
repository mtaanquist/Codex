import { and, asc, eq, gt, isNull, max, or, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { entityMentions, scenes, stories } from '../db/schema.ts';
import { errorFields, logEvent } from '../log.ts';
import { completeDetailed, type GatewayDeps } from './gateway.ts';
import { resolveLlmConfig } from './config.ts';
import { SpendMeter } from './spend.ts';
import { buildEnrichMessage } from './prompts/enrich.ts';
import { entityAppearances, type PlanAppearance } from '../plan-data.ts';
import {
	ENTITY_TYPES,
	entityAliasColumn,
	entityNameColumn,
	entityTable,
	resolveOwnedEntity
} from '../entity-lookups.ts';
import { inLiveUniverse } from '../universe-scope.ts';
import {
	stageEntitySuggestions,
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

function snippetLine(a: PlanAppearance, withStory: boolean): string {
	const where = [withStory ? a.storyTitle : '', a.sceneTitle ?? ''].filter(Boolean).join(' / ');
	return where ? `[${where}] ${a.snippet}` : a.snippet;
}

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
	const entity = await resolveOwnedEntity(db, opts.userId, opts.entityId, (table) => ({
		universeId: table.universeId,
		name: entityNameColumn(table),
		aliases: entityAliasColumn(table),
		details: table.details,
		summaryMd: table.summaryMd
	}));
	if (!entity) return [];
	if ('universeId' in opts.scope && entity.universeId !== opts.scope.universeId) return [];
	const kind = entity.type === 'lore_entry' ? ('lore' as const) : entity.type;

	const universeWide = 'universeId' in opts.scope;
	const appearances = await entityAppearances(db, { kind, id: opts.entityId }, opts.scope);
	const snippets = spreadAppearances(appearances, MAX_APPEARANCES).map((a) =>
		snippetLine(a, universeWide)
	);

	const messages: ChatMessage[] = [
		{
			role: 'user',
			content: buildEnrichMessage(
				{
					kind,
					name: entity.name,
					aliases: entity.aliases ?? [],
					details: entity.details ?? [],
					summaryMd: entity.summaryMd,
					hasSummary: !!entity.summaryMd?.trim()
				},
				snippets
			)
		}
	];

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
			signal: opts.signal
		},
		deps
	);
	opts.meter?.record(result.model, result.usage);

	const proposals = parseEnrichResponse(result.content);
	if (proposals.length === 0) return [];
	return stageEntitySuggestions(db, {
		ownerId: opts.userId,
		kind,
		entityId: opts.entityId,
		proposals
	});
}

export type UniverseEnrichResult = {
	// Entities the pass read, and how many suggestions it staged across them.
	entities: number;
	staged: number;
	failed: number;
	// Set when the spend ceiling stopped the pass early, with what it had spent.
	capped?: boolean;
	spentUsd?: number;
	// Why a cap that was set could not be enforced.
	capNotApplied?: string;
};

// The universe's entities worth enriching: those mentioned in at least one live
// scene, never enriched or with a mentioning scene changed since the last pass.
// Characters, then places, then lore, each by name.
async function entitiesToEnrich(db: Database, userId: string, universeId: string) {
	const out: { id: string; type: (typeof ENTITY_TYPES)[number] }[] = [];
	for (const type of ENTITY_TYPES) {
		const table = entityTable(type);
		const lastChanged = max(scenes.updatedAt);
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
					inLiveUniverse(table.universeId)
				)
			)
			.groupBy(table.id, table.assistantEnrichedAt, entityNameColumn(table))
			.having(or(isNull(table.assistantEnrichedAt), gt(lastChanged, table.assistantEnrichedAt)))
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
// job is stopped.
export async function enrichUniverse(
	db: Database,
	opts: { userId: string; universeId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<UniverseEnrichResult> {
	const { userId, universeId, signal } = opts;
	const resolved = await resolveLlmConfig(db, userId);
	const meter = new SpendMeter({
		pricing: resolved.config.modelPricing,
		capUsd: resolved.config.spendCapUsd
	});
	let entities = 0;
	let staged = 0;
	let failed = 0;
	let capped = false;

	for (const entity of await entitiesToEnrich(db, userId, universeId)) {
		if (signal?.aborted) break;
		if (meter.capReached) {
			capped = true;
			break;
		}
		const startedAt = new Date();
		try {
			const rows = await enrichEntity(
				db,
				{ userId, scope: { universeId }, entityId: entity.id, meter, signal },
				deps
			);
			const table = entityTable(entity.type);
			await db
				.update(table)
				.set({ assistantEnrichedAt: startedAt, updatedAt: sql`${table.updatedAt}` })
				.where(eq(table.id, entity.id));
			entities += 1;
			staged += rows.length;
		} catch (err) {
			if (signal?.aborted) break;
			logEvent('error', 'assistant.enrich_failed', { entityId: entity.id, ...errorFields(err) });
			failed += 1;
		}
	}

	return {
		entities,
		staged,
		failed,
		...(capped ? { capped: true, spentUsd: meter.spentUsd } : {}),
		...(meter.notApplied ? { capNotApplied: meter.notAppliedMessage } : {})
	};
}
