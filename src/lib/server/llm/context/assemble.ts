import type { Database } from '../../auth';
import type { ChatMessage } from '../providers/types';
import {
	activeLore,
	inScopeEntities,
	loadStoryScope,
	sceneNeighbourhood,
	scopeNotes,
	storySkeleton,
	type ChapterSkeleton,
	type CurrentScene,
	type NeighbourScene,
	type ScopeEntity,
	type ScopeLore,
	type ScopeNote,
	type SceneSummary,
	type StoryScope
} from './sources';

// Assemble the world context for a request, in tiers, against a token budget.
// The gathering (sources.ts) is settled design; the budget and the order tiers
// are dropped in are calibration decisions the design defers until there is a
// real prose corpus to tune against (see assistant.md "Context assembly" TODO).
// So the numbers and the drop order here are deliberately simple and provisional
// - a single overall budget and a greedy fit - not a tuned per-tier strategy.

// A rough token estimate (about four characters per token); good enough to keep
// a request from blowing past a context window, not a real tokenizer.
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// Provisional. Calibrate against a corpus before trusting it.
const DEFAULT_BUDGET_TOKENS = 6000;

export type ContextTier = { name: string; text: string };

export type BudgetedContext = {
	text: string;
	includedTiers: string[];
	droppedTiers: string[];
	estimatedTokens: number;
};

// Greedily include whole tiers in priority order until the budget is spent;
// a tier that does not fit is dropped and the next, smaller one still gets a
// chance. Empty tiers are skipped silently. Pure, so the policy is testable
// without a database.
export function selectWithinBudget(tiers: ContextTier[], budgetTokens: number): BudgetedContext {
	const blocks: string[] = [];
	const includedTiers: string[] = [];
	const droppedTiers: string[] = [];
	let used = 0;
	for (const tier of tiers) {
		if (!tier.text.trim()) continue;
		const cost = estimateTokens(tier.text);
		if (used > 0 && used + cost > budgetTokens) {
			droppedTiers.push(tier.name);
			continue;
		}
		blocks.push(tier.text);
		includedTiers.push(tier.name);
		used += cost;
	}
	return { text: blocks.join('\n\n'), includedTiers, droppedTiers, estimatedTokens: used };
}

export type AssembledContext = {
	text: string;
	estimatedTokens: number;
	budgetTokens: number;
	includedTiers: string[];
	droppedTiers: string[];
	// What was drawn on, for a future grounding step that cites sources.
	sources: {
		entities: { id: string; kind: ScopeEntity['kind']; name: string }[];
		scenes: { id: string; title: string | null }[];
		lore: { id: string; title: string }[];
	};
};

export type AssembleOptions = {
	userId: string;
	storyId: string;
	// The scene in focus, if any; drives the scene-local tier and lore keyword
	// activation.
	sceneId?: string;
	// The writer's question or selection, folded into lore keyword activation.
	focusText?: string;
	budgetTokens?: number;
};

// The one entry: gather every tier, render, and fit to budget. Returns null when
// the story is not the user's (owner-scoped through loadStoryScope).
export async function assembleContext(
	db: Database,
	options: AssembleOptions
): Promise<AssembledContext | null> {
	const scope = await loadStoryScope(db, options.userId, options.storyId);
	if (!scope) return null;
	const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

	const neighbourhood = await sceneNeighbourhood(db, scope.storyId, options.sceneId);
	const skeleton = await storySkeleton(db, scope.storyId);
	const entities = await inScopeEntities(db, scope.universeId, scope.storyId);
	const notes = await scopeNotes(db, options.userId, scope.universeId, scope.storyId);

	// What a 'keyword' lore entry matches against: the writer's focus, the
	// current scene, neighbour summaries, and the in-scope entity names.
	const scopeText = [
		options.focusText ?? '',
		neighbourhood.current?.bodyMd ?? '',
		...neighbourhood.neighbours.map((n) => n.summaryMd ?? ''),
		...entities.map((e) => e.name)
	].join('\n');
	const lore = await activeLore(db, scope.universeId, scope.storyId, scopeText);

	// Tier order is the spec's: frame, scene-local, summaries, entities, lore,
	// notes. Under budget pressure the later tiers drop first. Provisional.
	const tiers: ContextTier[] = [
		{ name: 'frame', text: renderFrame(scope) },
		{ name: 'scene-local', text: renderSceneLocal(neighbourhood) },
		{ name: 'summaries', text: renderSkeleton(skeleton) },
		{ name: 'entities', text: renderEntities(entities) },
		{ name: 'lore', text: renderLore(lore) },
		{ name: 'notes', text: renderNotes(notes) }
	];
	const budgeted = selectWithinBudget(tiers, budgetTokens);

	return {
		text: budgeted.text,
		estimatedTokens: budgeted.estimatedTokens,
		budgetTokens,
		includedTiers: budgeted.includedTiers,
		droppedTiers: budgeted.droppedTiers,
		sources: {
			entities: entities.map((e) => ({ id: e.id, kind: e.kind, name: e.name })),
			scenes: [
				...(neighbourhood.current
					? [{ id: neighbourhood.current.id, title: neighbourhood.current.title }]
					: []),
				...neighbourhood.neighbours.map((n) => ({ id: n.id, title: n.title }))
			],
			lore: lore.map((l) => ({ id: l.id, title: l.title }))
		}
	};
}

const PREAMBLE =
	'You are assisting the writer with their own story. The following is the world ' +
	'context for it - the story, its world, the scene in focus, characters, places, ' +
	'and lore. Ground your answers in this material and say when something is not ' +
	'covered here rather than inventing it.';

// Wrap assembled context as a system message for the gateway. The surfaces call
// this, then hand the messages to the gateway; the gateway stays generic.
export function buildSystemMessage(context: AssembledContext): ChatMessage {
	return { role: 'system', content: `${PREAMBLE}\n\n${context.text}` };
}

function renderFrame(scope: StoryScope): string {
	const lines = [`# Story: ${scope.storyTitle}`];
	if (scope.storyBrief) lines.push(scope.storyBrief);
	if (scope.storyDescription) lines.push(scope.storyDescription);
	lines.push('', `## World: ${scope.universeName}`);
	if (scope.universeDescription) lines.push(scope.universeDescription);
	return lines.join('\n');
}

function renderSceneLocal(neighbourhood: {
	current: CurrentScene | null;
	neighbours: NeighbourScene[];
}): string {
	if (!neighbourhood.current) return '';
	const { current, neighbours } = neighbourhood;
	const lines = [`## Current scene${current.title ? `: ${current.title}` : ''}`];
	if (current.summaryMd) lines.push(`Summary: ${current.summaryMd}`);
	lines.push('', current.bodyMd.trim() || '(empty)');
	const before = neighbours.filter((n) => n.side === 'before');
	const after = neighbours.filter((n) => n.side === 'after');
	if (before.length || after.length) {
		lines.push('', '### Nearby scenes');
		for (const n of before)
			lines.push(`- Before${title(n.title)}: ${n.summaryMd ?? '(no summary)'}`);
		for (const n of after) lines.push(`- After${title(n.title)}: ${n.summaryMd ?? '(no summary)'}`);
	}
	return lines.join('\n');
}

function renderSkeleton(skeleton: {
	chapters: ChapterSkeleton[];
	orphans: SceneSummary[];
}): string {
	const blocks: string[] = [];
	for (const chapter of skeleton.chapters) {
		const lines = [`### Chapter${title(chapter.title)}`];
		if (chapter.summaryMd) lines.push(chapter.summaryMd);
		for (const scene of chapter.scenes) lines.push(renderSceneSummaryLine(scene));
		blocks.push(lines.join('\n'));
	}
	if (skeleton.orphans.length) {
		const lines = ['### Unfiled scenes'];
		for (const scene of skeleton.orphans) lines.push(renderSceneSummaryLine(scene));
		blocks.push(lines.join('\n'));
	}
	if (!blocks.length) return '';
	return ['## Story outline', ...blocks].join('\n\n');
}

function renderSceneSummaryLine(scene: SceneSummary): string {
	return `- ${scene.title ?? 'Untitled'} [${scene.status}]: ${scene.summaryMd ?? '(no summary)'}`;
}

function renderEntities(entities: ScopeEntity[]): string {
	if (!entities.length) return '';
	const lines = ['## Characters and places in this story'];
	for (const entity of entities) {
		lines.push(`### ${entity.name} (${entity.kind})`);
		if (entity.summaryMd) lines.push(entity.summaryMd);
		if (entity.aliases.length) lines.push(`Also known as: ${entity.aliases.join(', ')}`);
		for (const detail of entity.details) lines.push(`- ${detail.label}: ${detail.value}`);
		for (const rel of entity.relationships) lines.push(`- ${rel.label} ${rel.otherName}`);
		if (entity.storyNote) lines.push(`In this story: ${entity.storyNote}`);
	}
	return lines.join('\n');
}

function renderLore(lore: ScopeLore[]): string {
	if (!lore.length) return '';
	const lines = ['## Lore'];
	for (const entry of lore) {
		lines.push(`### ${entry.title}`);
		if (entry.summaryMd) lines.push(entry.summaryMd);
		if (entry.bodyMd.trim()) lines.push(entry.bodyMd.trim());
		for (const detail of entry.details) lines.push(`- ${detail.label}: ${detail.value}`);
		if (entry.storyNote) lines.push(`In this story: ${entry.storyNote}`);
	}
	return lines.join('\n');
}

function renderNotes(notes: ScopeNote[]): string {
	if (!notes.length) return '';
	const lines = ['## Notes'];
	for (const note of notes) {
		if (!note.bodyMd.trim()) continue;
		lines.push(`### ${note.title ?? 'Note'} (${note.scope})`);
		lines.push(note.bodyMd.trim());
	}
	return lines.length > 1 ? lines.join('\n') : '';
}

function title(value: string | null): string {
	return value ? ` "${value}"` : '';
}
