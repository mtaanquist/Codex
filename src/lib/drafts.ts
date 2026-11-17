import type { EntityDetail } from './entity-snapshot.ts';

// The frozen content of a saved draft. Ids are the ids the rows had when the
// draft was saved: they let a scene be compared with or restored onto the
// live scene it came from, and tie notes and relationships to their scenes
// and entities inside the draft. Nothing here is a foreign key, so a draft
// stays whole whatever happens to the live rows.

export type DraftEntityType = 'character' | 'place' | 'lore_entry';

export type DraftChapter = { id: string; title: string | null; summaryMd: string | null };

export type DraftScene = {
	id: string;
	chapterId: string | null;
	title: string | null;
	bodyMd: string;
	summaryMd: string | null;
	status: string;
	storyTime: string | null;
	wordCount: number;
	// For a scene added back from an earlier draft, the id it had there, and
	// the id it had in the first draft of that chain (the same id unless it
	// was added back more than once). Absent in drafts saved before this was
	// recorded.
	origin?: string | null;
	root?: string | null;
};

export type DraftEntity = {
	type: DraftEntityType;
	id: string;
	name: string;
	// Aliases for characters and places, keywords for lore.
	aliases: string[];
	categoryName: string | null;
	summaryMd: string | null;
	bodyMd: string;
	details: EntityDetail[];
	// This story's notes on the entity, when it had any.
	storyNotesMd: string | null;
	// Declared as part of this story.
	inStory: boolean;
};

export type DraftRelationship = {
	fromType: DraftEntityType;
	fromId: string;
	toType: DraftEntityType;
	toId: string;
	relationTypeId: string;
	label: string;
	notesMd: string | null;
	// True for a relationship that holds only in this story.
	storyOnly: boolean;
};

export type DraftNote = {
	id: string;
	title: string | null;
	bodyMd: string;
	pinned: boolean;
	sceneId: string | null;
};

export type DraftContent = {
	version: 1;
	story: {
		title: string;
		author: string | null;
		brief: string | null;
		descriptionMd: string | null;
		coverAssetId: string | null;
	};
	chapters: DraftChapter[];
	scenes: DraftScene[];
	entities: DraftEntity[];
	relationships: DraftRelationship[];
	notes: DraftNote[];
};

export const DRAFT_LABEL_MAX = 120;
export const DRAFT_NOTE_MAX = 4000;

// A draft's scenes grouped the way the story reads: chapters in order, each
// with its scenes, then the scenes with no chapter.
export function draftOutline(content: Pick<DraftContent, 'chapters' | 'scenes'>): {
	chapters: (DraftChapter & { scenes: DraftScene[] })[];
	unfiled: DraftScene[];
} {
	return {
		chapters: content.chapters.map((chapter) => ({
			...chapter,
			scenes: content.scenes.filter((scene) => scene.chapterId === chapter.id)
		})),
		unfiled: content.scenes.filter(
			(scene) =>
				scene.chapterId === null ||
				!content.chapters.some((chapter) => chapter.id === scene.chapterId)
		)
	};
}

// Pairs each scene of a newer version with the scene it was in an older
// one: the same id first, then the id it was added back from, then the
// first id in a chain of add-backs. A scene pairs with at most one other.
// Returns newer id -> older id.
export function matchScenes(
	older: { id: string }[],
	newer: { id: string; origin?: string | null; root?: string | null }[]
): Map<string, string> {
	const olderIds = new Set(older.map((scene) => scene.id));
	const pairs = new Map<string, string>();
	const taken = new Set<string>();
	for (const key of ['id', 'origin', 'root'] as const) {
		for (const scene of newer) {
			const target = scene[key];
			if (pairs.has(scene.id) || !target || taken.has(target) || !olderIds.has(target)) continue;
			pairs.set(scene.id, target);
			taken.add(target);
		}
	}
	return pairs;
}

export type SceneChangeKind = 'same' | 'changed' | 'added' | 'removed';

// One side of a changed, added or removed scene: only what the compare view
// shows.
export type CompareScene = { id: string; title: string | null; bodyMd: string; wordCount: number };

export type SceneChange = {
	kind: Exclude<SceneChangeKind, 'same'>;
	before: CompareScene | null;
	after: CompareScene | null;
	chapterTitle: string | null;
};

type Side = Pick<DraftContent, 'chapters' | 'scenes'>;

// What changed between two versions of a story, scene by scene: in the
// newer version's reading order, then the scenes it no longer has. Scenes
// pair up through matchScenes. A scene is changed when its text or title
// differs; unchanged scenes are only counted.
export function compareDrafts(
	before: Side,
	after: Side
): {
	changes: SceneChange[];
	counts: Record<SceneChangeKind, number>;
	words: { before: number; after: number };
} {
	const beforeById = new Map(before.scenes.map((scene) => [scene.id, scene]));
	const pairs = matchScenes(before.scenes, after.scenes);
	const matched = new Set(pairs.values());
	const chapterTitle = (side: Side, scene: DraftScene) => {
		const index = side.chapters.findIndex((chapter) => chapter.id === scene.chapterId);
		if (index < 0) return null;
		return side.chapters[index].title ?? `Chapter ${index + 1}`;
	};
	const slim = (scene: DraftScene): CompareScene => ({
		id: scene.id,
		title: scene.title,
		bodyMd: scene.bodyMd,
		wordCount: scene.wordCount
	});
	const changes: SceneChange[] = [];
	const counts = { same: 0, changed: 0, added: 0, removed: 0 };
	const outline = draftOutline(after);
	for (const scene of [
		...outline.chapters.flatMap((chapter) => chapter.scenes),
		...outline.unfiled
	]) {
		const pairedId = pairs.get(scene.id);
		const match = pairedId ? beforeById.get(pairedId) : undefined;
		if (match && match.bodyMd === scene.bodyMd && match.title === scene.title) {
			counts.same++;
			continue;
		}
		const kind = match ? 'changed' : 'added';
		counts[kind]++;
		changes.push({
			kind,
			before: match ? slim(match) : null,
			after: slim(scene),
			chapterTitle: chapterTitle(after, scene)
		});
	}
	for (const scene of before.scenes) {
		if (matched.has(scene.id)) continue;
		counts.removed++;
		changes.push({
			kind: 'removed',
			before: slim(scene),
			after: null,
			chapterTitle: chapterTitle(before, scene)
		});
	}
	const sum = (side: Side) => side.scenes.reduce((total, scene) => total + scene.wordCount, 0);
	return { changes, counts, words: { before: sum(before), after: sum(after) } };
}
