import type { Database } from '../../auth.ts';
import type { ChatMessage } from '../providers/types.ts';
import {
	activeLore,
	inScopeEntities,
	loadStoryScope,
	loadUniverseScope,
	sceneNeighbourhood,
	scenesUpTo,
	scopeNotes,
	storySkeleton,
	universeEntities,
	universeSkeleton,
	type ChapterSkeleton,
	type CurrentScene,
	type NeighbourScene,
	type RecapScene,
	type ScopeEntity,
	type ScopeLore,
	type ScopeNote,
	type SceneSummary,
	type StorySkeleton,
	type StoryScope,
	type UniverseScope
} from './sources.ts';

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
	// Which surface this was assembled for: a story focus or the whole universe.
	// Drives the system preamble (see buildSystemMessage).
	kind: 'story' | 'universe';
	text: string;
	estimatedTokens: number;
	budgetTokens: number;
	includedTiers: string[];
	droppedTiers: string[];
	// True when the universe is an established published setting; the system
	// preamble then permits canon knowledge instead of forbidding invention.
	establishedSetting: boolean;
	// What was drawn on, for a future grounding step that cites sources.
	sources: {
		entities: { id: string; kind: ScopeEntity['kind']; name: string }[];
		scenes: { id: string; title: string | null }[];
		lore: { id: string; title: string }[];
	};
};

export type AssembleOptions = {
	userId: string;
	// The focus path: a story (and optionally a scene) the writer has open. When
	// absent, universeId drives the universe-Plan path.
	storyId?: string;
	// The universe path: no story focus, the whole universe in view.
	universeId?: string;
	// The scene in focus, if any; drives the scene-local tier and lore keyword
	// activation. Only meaningful on the focus path.
	sceneId?: string;
	// The writer's question or selection, folded into lore keyword activation.
	focusText?: string;
	budgetTokens?: number;
};

// The one entry: gather every tier, render, and fit to budget. Branches on the
// scope - a story focus (the Write/Review/story-Plan path) or the whole
// universe (the universe-Plan path). Returns null when the scope is not the
// user's (owner-scoped through the loaders).
export async function assembleContext(
	db: Database,
	options: AssembleOptions
): Promise<AssembledContext | null> {
	if (options.storyId) return assembleStoryContext(db, options, options.storyId);
	if (options.universeId) return assembleUniverseContext(db, options, options.universeId);
	return null;
}

async function assembleStoryContext(
	db: Database,
	options: AssembleOptions,
	storyId: string
): Promise<AssembledContext | null> {
	const scope = await loadStoryScope(db, options.userId, storyId);
	if (!scope) return null;
	const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

	const neighbourhood = await sceneNeighbourhood(db, scope.storyId, options.sceneId);
	const skeleton = await storySkeleton(db, scope.storyId);
	const entities = await inScopeEntities(db, scope.universeId, scope.storyId);
	const notes = await scopeNotes(db, options.userId, scope.universeId, scope.storyId);
	// The other stories in the universe, so a focused turn can reach across for
	// continuity; bodies stay out (the model pulls them with get_scene).
	const backbone = (await universeSkeleton(db, scope.universeId)).filter(
		(s) => s.storyId !== scope.storyId
	);

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
	// notes, then the low-priority universe backbone last so it drops first
	// under budget pressure. Provisional.
	const tiers: ContextTier[] = [
		{ name: 'frame', text: renderFrame(scope) },
		{ name: 'scene-local', text: renderSceneLocal(neighbourhood) },
		{ name: 'summaries', text: renderSkeleton(skeleton) },
		{ name: 'entities', text: renderEntities(entities) },
		{ name: 'lore', text: renderLore(lore) },
		{ name: 'notes', text: renderNotes(notes) },
		{ name: 'universe-backbone', text: renderUniverseBackbone(backbone) }
	];
	const budgeted = selectWithinBudget(tiers, budgetTokens);

	return {
		kind: 'story',
		text: budgeted.text,
		estimatedTokens: budgeted.estimatedTokens,
		budgetTokens,
		includedTiers: budgeted.includedTiers,
		droppedTiers: budgeted.droppedTiers,
		establishedSetting: scope.universeEstablished,
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

async function assembleUniverseContext(
	db: Database,
	options: AssembleOptions,
	universeId: string
): Promise<AssembledContext | null> {
	const scope = await loadUniverseScope(db, options.userId, universeId);
	if (!scope) return null;
	const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

	const stories = await universeSkeleton(db, universeId);
	const entities = await universeEntities(db, universeId);
	const notes = await scopeNotes(db, options.userId, universeId);

	const scopeText = [options.focusText ?? '', ...entities.map((e) => e.name)].join('\n');
	const lore = await activeLore(db, universeId, undefined, scopeText);

	// No scene-local tier (no story focus): frame, the per-story outline,
	// entities, lore, notes. Later tiers drop first under budget pressure.
	const tiers: ContextTier[] = [
		{ name: 'universe-frame', text: renderUniverseFrame(scope) },
		{ name: 'universe-outline', text: renderUniverseOutline(stories) },
		{ name: 'entities', text: renderEntities(entities) },
		{ name: 'lore', text: renderLore(lore) },
		{ name: 'notes', text: renderNotes(notes) }
	];
	const budgeted = selectWithinBudget(tiers, budgetTokens);

	return {
		kind: 'universe',
		text: budgeted.text,
		estimatedTokens: budgeted.estimatedTokens,
		budgetTokens,
		includedTiers: budgeted.includedTiers,
		droppedTiers: budgeted.droppedTiers,
		establishedSetting: scope.universeEstablished,
		sources: {
			entities: entities.map((e) => ({ id: e.id, kind: e.kind, name: e.name })),
			scenes: stories.flatMap((s) => [
				...s.chapters.flatMap((c) => c.scenes.map((sc) => ({ id: sc.id, title: sc.title }))),
				...s.orphans.map((sc) => ({ id: sc.id, title: sc.title }))
			]),
			lore: lore.map((l) => ({ id: l.id, title: l.title }))
		}
	};
}

const PREAMBLE =
	'You are assisting the writer with their own story. The following is the world ' +
	'context for it - the story, its world, the scene in focus, characters, places, ' +
	'and lore. Ground your answers in this material and say when something is not ' +
	'covered here rather than inventing it.';

// For a story set in an established published setting (Forgotten Realms,
// Azeroth): the model may draw on the setting's canon, but the writer's own
// material wins where they differ.
const PREAMBLE_ESTABLISHED =
	'You are assisting the writer with their own story, set in an established ' +
	'published setting. The following is the context for it - the story, its world, ' +
	'the scene in focus, characters, places, and lore. Ground your answers in this ' +
	'material first; you may also draw on your knowledge of the published canon of ' +
	"the setting named below, but the writer's own material here overrides that " +
	'canon wherever they differ. Say when something rests on neither rather than ' +
	'inventing it.';

// The universe-Plan surface: no single story is in focus, the whole universe
// is the working set. The retrieval tools reach across every story in it, so
// the model can check continuity between books.
const PREAMBLE_UNIVERSE =
	'You are assisting the writer across their whole universe - every story in ' +
	'it, its characters, places, and lore. The following is the context: the ' +
	'world, its stories in outline, characters, places, and lore. Ground your ' +
	'answers in this material and the stories you can read through the tools, ' +
	'and say when something is not covered rather than inventing it.';

const PREAMBLE_UNIVERSE_ESTABLISHED =
	'You are assisting the writer across their whole universe, set in an ' +
	'established published setting. The following is the context: the world, its ' +
	'stories in outline, characters, places, and lore. Ground your answers in ' +
	'this material first; you may also draw on the published canon, but the ' +
	"writer's own material here overrides that canon wherever they differ. Say " +
	'when something rests on neither rather than inventing it.';

// Appended only when the turn offers tools; a tool-less surface must not be
// told about tools it cannot call. The reads reach across every story in the
// universe, not just the story in focus.
const TOOL_HINT =
	'Any scene in this universe can be read in full with the get_scene tool ' +
	'using the scene ids shown in the outline; list_scenes returns the chapter ' +
	'and scene list for every story in the universe, and search_text and ' +
	'find_appearances reach across all of them, so you can check one story ' +
	'against another.';

function pickPreamble(kind: 'story' | 'universe', established: boolean): string {
	if (kind === 'universe') {
		return established ? PREAMBLE_UNIVERSE_ESTABLISHED : PREAMBLE_UNIVERSE;
	}
	return established ? PREAMBLE_ESTABLISHED : PREAMBLE;
}

// Wrap assembled context as a system message for the gateway. The surfaces call
// this, then hand the messages to the gateway; the gateway stays generic.
export function buildSystemMessage(
	context: AssembledContext,
	options?: { tools?: boolean }
): ChatMessage {
	const preamble = pickPreamble(context.kind, context.establishedSetting);
	const head = options?.tools ? `${preamble} ${TOOL_HINT}` : preamble;
	return { role: 'system', content: `${head}\n\n${context.text}` };
}

// Recap ("catch me up"): the story so far, up to and including the open scene.
// A separate assembly from the per-scene context above - it walks the scenes in
// order rather than a neighbour window, and falls back to a body excerpt where a
// scene has no summary yet (summaries are sparse until summary maintenance fills
// them). Budgets and the excerpt length are provisional, like the rest of this
// file (see the calibration note at the top).
const RECAP_BUDGET_TOKENS = 8000;
const RECAP_BODY_EXCERPT_CHARS = 1500;

function recapSceneBlock(scene: RecapScene): string {
	const heading = `### ${scene.title?.trim() || 'Untitled'}`;
	const summary = scene.summaryMd?.trim();
	const body = scene.bodyMd.trim();
	let content: string;
	if (summary) content = summary;
	else if (!body) content = '(empty)';
	else if (body.length <= RECAP_BODY_EXCERPT_CHARS) content = body;
	else content = body.slice(0, RECAP_BODY_EXCERPT_CHARS).trimEnd() + ' [...]';
	return `${heading}\n${content}`;
}

// Greedily fit scene blocks newest-first (a recap cares most about where the
// story stands now), then restore chronological order for the prose. The most
// recent scene is always kept even if it alone exceeds the budget. Pure, so the
// drop policy is testable without a database.
export function fitRecapScenes(
	scenes: RecapScene[],
	budgetTokens = RECAP_BUDGET_TOKENS
): { blocks: string[]; dropped: number } {
	const kept: { index: number; text: string }[] = [];
	let used = 0;
	let dropped = 0;
	for (let i = scenes.length - 1; i >= 0; i--) {
		const text = recapSceneBlock(scenes[i]);
		const cost = estimateTokens(text);
		if (used > 0 && used + cost > budgetTokens) {
			dropped += 1;
			continue;
		}
		kept.push({ index: i, text });
		used += cost;
	}
	kept.sort((a, b) => a.index - b.index);
	return { blocks: kept.map((k) => k.text), dropped };
}

// The world frame plus the story so far, as a single system-message body. Null
// when the story is not the user's (owner-scoped through loadStoryScope).
export async function assembleRecapContext(
	db: Database,
	options: { userId: string; storyId: string; sceneId?: string }
): Promise<string | null> {
	const scope = await loadStoryScope(db, options.userId, options.storyId);
	if (!scope) return null;
	const scenes = await scenesUpTo(db, scope.storyId, options.sceneId);
	const entities = await inScopeEntities(db, scope.universeId, scope.storyId);

	const { blocks, dropped } = fitRecapScenes(scenes);
	const parts = [renderFrame(scope)];
	if (dropped > 0) {
		parts.push(
			`(The first ${dropped} scene${dropped === 1 ? '' : 's'} ${dropped === 1 ? 'is' : 'are'} omitted to fit; recap from what follows.)`
		);
	}
	parts.push(['## The story so far', ...blocks].join('\n\n'));
	const renderedEntities = renderEntities(entities);
	if (renderedEntities) parts.push(renderedEntities);
	return parts.join('\n\n');
}

function renderFrame(scope: StoryScope): string {
	const lines = [`# Story: ${scope.storyTitle}`];
	if (scope.storyBrief) lines.push(scope.storyBrief);
	if (scope.storyDescription) lines.push(scope.storyDescription);
	if (scope.storyStyleNotes) {
		lines.push(
			`Genre and style the author is aiming for (judge the prose against this, not against general taste): ${scope.storyStyleNotes}`
		);
	}
	lines.push('', `## World: ${scope.universeName}`);
	if (scope.universeDescription) lines.push(scope.universeDescription);
	return lines.join('\n');
}

function renderUniverseFrame(scope: UniverseScope): string {
	const lines = [`# World: ${scope.universeName}`];
	if (scope.universeDescription) lines.push(scope.universeDescription);
	return lines.join('\n');
}

// Every story in the universe as a titled outline block: brief, scene count,
// and its chapter/scene summary lines (with scene ids, so a tool turn can read
// any of them). The universe-Plan surface's backbone.
function renderUniverseOutline(stories: StorySkeleton[]): string {
	const blocks = stories.map(renderStoryOutlineBlock).filter(Boolean);
	if (!blocks.length) return '';
	return ['## Stories in this universe', ...blocks].join('\n\n');
}

// A compact index of the other stories for a focused turn: title, brief, and
// scene count, but no scene-by-scene lines (the focus story already carries the
// detailed outline). Lets the model know what else exists and pull specifics
// with the tools.
function renderUniverseBackbone(stories: StorySkeleton[]): string {
	if (!stories.length) return '';
	const lines = ['## Other stories in this universe'];
	for (const story of stories) {
		const parts = [`### ${story.storyTitle}`];
		if (story.storyBrief) parts.push(story.storyBrief);
		parts.push(`${story.sceneCount} scene${story.sceneCount === 1 ? '' : 's'}.`);
		lines.push(parts.join('\n'));
	}
	return lines.join('\n');
}

function renderStoryOutlineBlock(story: StorySkeleton): string {
	const lines = [`### Story: ${story.storyTitle}`];
	if (story.storyBrief) lines.push(story.storyBrief);
	for (const chapter of story.chapters) {
		lines.push(`#### Chapter${title(chapter.title)}`);
		if (chapter.summaryMd) lines.push(chapter.summaryMd);
		for (const scene of chapter.scenes) lines.push(renderSceneSummaryLine(scene));
	}
	if (story.orphans.length) {
		lines.push('#### Unfiled scenes');
		for (const scene of story.orphans) lines.push(renderSceneSummaryLine(scene));
	}
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
			lines.push(`- Before${title(n.title)} (scene id: ${n.id}): ${n.summaryMd ?? '(no summary)'}`);
		for (const n of after)
			lines.push(`- After${title(n.title)} (scene id: ${n.id}): ${n.summaryMd ?? '(no summary)'}`);
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
	// The id rides along so a tool-capable turn can read any scene in full
	// with get_scene, not just the one in focus.
	return `- ${scene.title ?? 'Untitled'} [${scene.status}] (scene id: ${scene.id}): ${scene.summaryMd ?? '(no summary)'}`;
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
