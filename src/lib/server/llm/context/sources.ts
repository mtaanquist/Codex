import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../auth';
import {
	chapters,
	characters,
	characterStoryNotes,
	loreEntries,
	loreStoryNotes,
	notes,
	places,
	placeStoryNotes,
	scenes,
	stories,
	universes
} from '../../db/schema';
import { storyEntityLists } from '../../membership';
import { listEntityRelationships } from '../../relationships';
import type { EntityDetail } from '$lib/entity-snapshot';

// The deterministic "what is in scope" queries that feed context assembly. Each
// returns plain typed data; the rendering and budgeting live in assemble.ts.
// These draw on the existing mention index and entity queries rather than
// re-scanning prose (storyEntityLists is members-or-mentioned, the same list the
// story Plan shows). Everything here is owner-scoped through the story, which
// loadStoryScope validates first.

export type ScopeKind = 'character' | 'place' | 'lore';

export type StoryScope = {
	storyId: string;
	universeId: string;
	storyTitle: string;
	storyBrief: string | null;
	storyDescription: string | null;
	// The author's genre and craft intent, so feedback calibrates to it.
	storyStyleNotes: string | null;
	universeName: string;
	universeDescription: string | null;
	// True for an established published setting; the Assistant may then draw
	// on its own canon knowledge, with the author's material taking precedence.
	universeEstablished: boolean;
};

// The story and its universe, but only if the user owns it. Null means no such
// story for this user, which the caller turns into "no context".
export async function loadStoryScope(
	db: Database,
	userId: string,
	storyId: string
): Promise<StoryScope | null> {
	const [row] = await db
		.select({
			storyId: stories.id,
			universeId: stories.universeId,
			storyTitle: stories.title,
			storyBrief: stories.brief,
			storyDescription: stories.descriptionMd,
			storyStyleNotes: stories.styleNotes,
			universeName: universes.name,
			universeDescription: universes.descriptionMd,
			universeEstablished: universes.establishedSetting
		})
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	return row ?? null;
}

export type CurrentScene = {
	id: string;
	title: string | null;
	summaryMd: string | null;
	bodyMd: string;
	wordCount: number;
};

export type NeighbourScene = {
	id: string;
	title: string | null;
	summaryMd: string | null;
	side: 'before' | 'after';
};

// The current scene in full plus a window of neighbouring scene summaries, found
// by global position. No sceneId (a chat with nothing open) yields an empty
// neighbourhood rather than guessing.
export async function sceneNeighbourhood(
	db: Database,
	storyId: string,
	sceneId: string | undefined,
	window = 2
): Promise<{ current: CurrentScene | null; neighbours: NeighbourScene[] }> {
	if (!sceneId) return { current: null, neighbours: [] };
	const ordered = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			summaryMd: scenes.summaryMd,
			globalPosition: scenes.globalPosition
		})
		.from(scenes)
		.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));
	const index = ordered.findIndex((s) => s.id === sceneId);
	if (index === -1) return { current: null, neighbours: [] };

	const [current] = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			summaryMd: scenes.summaryMd,
			bodyMd: scenes.bodyMd,
			wordCount: scenes.wordCount
		})
		.from(scenes)
		.where(eq(scenes.id, sceneId));

	const neighbours: NeighbourScene[] = [];
	for (let i = Math.max(0, index - window); i < index; i++) {
		neighbours.push({ ...ordered[i], side: 'before' });
	}
	for (let i = index + 1; i <= Math.min(ordered.length - 1, index + window); i++) {
		neighbours.push({ ...ordered[i], side: 'after' });
	}
	return { current: current ?? null, neighbours };
}

export type SceneSummary = {
	id: string;
	title: string | null;
	summaryMd: string | null;
	status: string;
};

export type ChapterSkeleton = {
	id: string;
	title: string | null;
	summaryMd: string | null;
	scenes: SceneSummary[];
};

// The whole story as a skeleton of chapter and scene summaries (no bodies), so
// the model knows the shape of the work without the full prose.
export async function storySkeleton(
	db: Database,
	storyId: string
): Promise<{ chapters: ChapterSkeleton[]; orphans: SceneSummary[] }> {
	const chapterRows = await db
		.select({ id: chapters.id, title: chapters.title, summaryMd: chapters.summaryMd })
		.from(chapters)
		.where(eq(chapters.storyId, storyId))
		.orderBy(asc(chapters.position));
	const sceneRows = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			summaryMd: scenes.summaryMd,
			status: scenes.status,
			chapterId: scenes.chapterId
		})
		.from(scenes)
		.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));

	const byChapter = new Map<string, SceneSummary[]>();
	const orphans: SceneSummary[] = [];
	for (const scene of sceneRows) {
		const summary: SceneSummary = {
			id: scene.id,
			title: scene.title,
			summaryMd: scene.summaryMd,
			status: scene.status
		};
		if (scene.chapterId) {
			const list = byChapter.get(scene.chapterId) ?? [];
			list.push(summary);
			byChapter.set(scene.chapterId, list);
		} else {
			orphans.push(summary);
		}
	}
	return {
		chapters: chapterRows.map((chapter) => ({
			id: chapter.id,
			title: chapter.title,
			summaryMd: chapter.summaryMd,
			scenes: byChapter.get(chapter.id) ?? []
		})),
		orphans
	};
}

export type RecapScene = {
	id: string;
	title: string | null;
	summaryMd: string | null;
	bodyMd: string;
	status: string;
};

// The story's scenes in order, up to and including the focus scene, for a
// recap. With no focus scene (or one not found) the whole story is returned, so
// "catch me up" off a story with nothing open recaps everything. Bodies ride
// along because summaries are sparse until summary maintenance fills them; the
// assembler prefers a summary and falls back to a body excerpt.
export async function scenesUpTo(
	db: Database,
	storyId: string,
	sceneId: string | undefined
): Promise<RecapScene[]> {
	const ordered = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			summaryMd: scenes.summaryMd,
			bodyMd: scenes.bodyMd,
			status: scenes.status
		})
		.from(scenes)
		.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));
	if (!sceneId) return ordered;
	const index = ordered.findIndex((s) => s.id === sceneId);
	return index === -1 ? ordered : ordered.slice(0, index + 1);
}

export type ScopeEntity = {
	kind: ScopeKind;
	id: string;
	name: string;
	summaryMd: string | null;
	details: EntityDetail[];
	aliases: string[];
	// The per-story overlay note (character/place/lore_story_notes), if any.
	storyNote: string | null;
	relationships: { label: string; otherName: string }[];
};

// Characters and places that are declared members of, or mentioned in, this
// story, with the detail the model needs: summary, quick details, aliases,
// relationships, and the per-story note. Capped so a dense universe cannot fan
// out into an unbounded number of relationship queries; the budget trims the
// rendering further. (Perf: relationships are fetched per entity for now,
// mirroring the editor; a single-pass variant exists - relatedEntitySummaries -
// if this proves hot.)
const MAX_SCOPE_ENTITIES = 50;

export async function inScopeEntities(
	db: Database,
	universeId: string,
	storyId: string
): Promise<ScopeEntity[]> {
	const lists = await storyEntityLists(db, universeId, storyId);
	const characterIds = lists.characters.map((c) => c.id);
	const placeIds = lists.places.map((p) => p.id);

	const characterRows = characterIds.length
		? await db
				.select({
					id: characters.id,
					name: characters.name,
					summaryMd: characters.summaryMd,
					details: characters.details,
					aliases: characters.aliases
				})
				.from(characters)
				.where(inArray(characters.id, characterIds))
				.orderBy(asc(characters.name))
		: [];
	const placeRows = placeIds.length
		? await db
				.select({
					id: places.id,
					name: places.name,
					summaryMd: places.summaryMd,
					details: places.details,
					aliases: places.aliases
				})
				.from(places)
				.where(inArray(places.id, placeIds))
				.orderBy(asc(places.name))
		: [];

	const characterNotes = characterIds.length
		? await db
				.select({ entityId: characterStoryNotes.characterId, notesMd: characterStoryNotes.notesMd })
				.from(characterStoryNotes)
				.where(
					and(
						eq(characterStoryNotes.storyId, storyId),
						inArray(characterStoryNotes.characterId, characterIds)
					)
				)
		: [];
	const placeNotes = placeIds.length
		? await db
				.select({ entityId: placeStoryNotes.placeId, notesMd: placeStoryNotes.notesMd })
				.from(placeStoryNotes)
				.where(
					and(eq(placeStoryNotes.storyId, storyId), inArray(placeStoryNotes.placeId, placeIds))
				)
		: [];
	const noteFor = new Map<string, string | null>([
		...characterNotes.map((n) => [n.entityId, n.notesMd] as const),
		...placeNotes.map((n) => [n.entityId, n.notesMd] as const)
	]);

	const entities: ScopeEntity[] = [
		...characterRows.map((c) => buildEntity('character', c, noteFor)),
		...placeRows.map((p) => buildEntity('place', p, noteFor))
	].slice(0, MAX_SCOPE_ENTITIES);

	for (const entity of entities) {
		const relationships = await listEntityRelationships(db, universeId, {
			kind: entity.kind,
			id: entity.id
		});
		entity.relationships = relationships.map((r) => ({ label: r.label, otherName: r.otherName }));
	}
	return entities;
}

function buildEntity(
	kind: ScopeKind,
	row: {
		id: string;
		name: string;
		summaryMd: string | null;
		details: EntityDetail[];
		aliases: string[] | null;
	},
	noteFor: Map<string, string | null>
): ScopeEntity {
	return {
		kind,
		id: row.id,
		name: row.name,
		summaryMd: row.summaryMd,
		details: row.details ?? [],
		aliases: row.aliases ?? [],
		storyNote: noteFor.get(row.id) ?? null,
		relationships: []
	};
}

// Whether any of an entry's keywords appears in the scope text. Pure, so the
// activation rule is easy to pin down in tests. A plain case-insensitive
// substring match for now; smarter boundary matching is a calibration concern.
export function loreMatches(keywords: string[], scopeText: string): boolean {
	const haystack = scopeText.toLowerCase();
	return keywords.some((keyword) => {
		const needle = keyword.trim().toLowerCase();
		return needle.length > 0 && haystack.includes(needle);
	});
}

export type ScopeLore = {
	id: string;
	title: string;
	summaryMd: string | null;
	bodyMd: string;
	details: EntityDetail[];
	keywords: string[];
	storyNote: string | null;
	// Why it was injected: always-on, or a keyword matched the scope.
	activation: 'always' | 'keyword';
};

// Lore activated for this scope, the reserved activation_mode finally earning
// its keep: 'always' entries always, 'keyword' entries when a keyword appears in
// the scope text, 'manual' entries never auto-injected.
export async function activeLore(
	db: Database,
	universeId: string,
	storyId: string,
	scopeText: string
): Promise<ScopeLore[]> {
	const rows = await db
		.select({
			id: loreEntries.id,
			title: loreEntries.title,
			summaryMd: loreEntries.summaryMd,
			bodyMd: loreEntries.bodyMd,
			details: loreEntries.details,
			keywords: loreEntries.keywords,
			activationMode: loreEntries.activationMode
		})
		.from(loreEntries)
		.where(
			and(
				eq(loreEntries.universeId, universeId),
				inArray(loreEntries.activationMode, ['always', 'keyword'])
			)
		)
		.orderBy(asc(loreEntries.title));

	const selected = rows.filter(
		(row) => row.activationMode === 'always' || loreMatches(row.keywords ?? [], scopeText)
	);
	const ids = selected.map((row) => row.id);
	const noteRows = ids.length
		? await db
				.select({ loreEntryId: loreStoryNotes.loreEntryId, notesMd: loreStoryNotes.notesMd })
				.from(loreStoryNotes)
				.where(and(eq(loreStoryNotes.storyId, storyId), inArray(loreStoryNotes.loreEntryId, ids)))
		: [];
	const noteFor = new Map(noteRows.map((n) => [n.loreEntryId, n.notesMd] as const));

	return selected.map((row) => ({
		id: row.id,
		title: row.title,
		summaryMd: row.summaryMd,
		bodyMd: row.bodyMd,
		details: row.details ?? [],
		keywords: row.keywords ?? [],
		storyNote: noteFor.get(row.id) ?? null,
		activation: row.activationMode === 'always' ? 'always' : 'keyword'
	}));
}

export type ScopeNote = {
	title: string | null;
	bodyMd: string;
	scope: 'story' | 'universe';
};

// The writer's freeform notes in scope: this story's notes, then the universe's
// (the "From the universe" set the story view already peeks at). Pinned first.
export async function scopeNotes(
	db: Database,
	userId: string,
	universeId: string,
	storyId: string
): Promise<ScopeNote[]> {
	const storyRows = await db
		.select({ title: notes.title, bodyMd: notes.bodyMd })
		.from(notes)
		.where(and(eq(notes.ownerId, userId), eq(notes.storyId, storyId)))
		.orderBy(desc(notes.pinned), desc(notes.updatedAt));
	const universeRows = await db
		.select({ title: notes.title, bodyMd: notes.bodyMd })
		.from(notes)
		.where(and(eq(notes.ownerId, userId), eq(notes.universeId, universeId), isNull(notes.storyId)))
		.orderBy(desc(notes.pinned), desc(notes.updatedAt));
	return [
		...storyRows.map((n) => ({ ...n, scope: 'story' as const })),
		...universeRows.map((n) => ({ ...n, scope: 'universe' as const }))
	];
}
