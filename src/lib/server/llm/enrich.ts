import type { Database } from '../auth';
import { complete, type GatewayDeps } from './gateway';
import { buildEnrichMessage } from './prompts/enrich';
import { entityAppearances, getEntityCard } from '../plan-data';
import {
	stageEntitySuggestions,
	type EntitySuggestion,
	type ProposedSuggestion
} from '../entity-suggestions';
import type { ChatMessage } from './providers/types';

// Inline per-entity enrichment: gather where an entity appears, ask the
// Assistant for new aliases, quick details, and a summary, and stage the result
// as suggestions the writer accepts or rejects. Sync (one completion), like
// single-scene review; a whole-universe background pass is a later step. Nothing
// is applied here - stageEntitySuggestions only stages.

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

export async function enrichEntity(
	db: Database,
	opts: { userId: string; storyId: string; entityId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<EntitySuggestion[]> {
	const card = await getEntityCard(db, opts.userId, opts.entityId);
	if (!card) return [];

	const appearances = await entityAppearances(
		db,
		{ kind: card.kind, id: opts.entityId },
		{ storyId: opts.storyId }
	);
	const snippets = appearances
		.slice(0, MAX_APPEARANCES)
		.map((a) => (a.sceneTitle ? `[${a.sceneTitle}] ${a.snippet}` : a.snippet));

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

	const text = await complete(
		db,
		{
			userId: opts.userId,
			storyId: opts.storyId,
			role: 'chat',
			enableTools: false,
			messages,
			maxTokens: MAX_ENRICH_TOKENS,
			signal: opts.signal
		},
		deps
	);

	const proposals = parseEnrichResponse(text);
	if (proposals.length === 0) return [];
	return stageEntitySuggestions(db, {
		ownerId: opts.userId,
		kind: card.kind,
		entityId: opts.entityId,
		proposals
	});
}
