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
	// For a scene added back from an earlier draft, the id it had there.
	// Absent in drafts saved before this was recorded.
	origin?: string | null;
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

export type SceneChangeKind = 'same' | 'changed' | 'added' | 'removed';

export type SceneChange = {
	kind: SceneChangeKind;
	before: DraftScene | null;
	after: DraftScene | null;
	chapterTitle: string | null;
};

type Side = Pick<DraftContent, 'chapters' | 'scenes'>;

// What changed between two versions of a story, scene by scene: in the
// newer version's reading order, then the scenes it no longer has. A scene
// matches by id, or by the id it came from when it was added back from a
// draft. A scene is changed when its text or title differs.
export function compareDrafts(
	before: Side,
	after: Side
): {
	changes: SceneChange[];
	counts: Record<SceneChangeKind, number>;
	words: { before: number; after: number };
} {
	const beforeById = new Map(before.scenes.map((scene) => [scene.id, scene]));
	const used = new Set<string>();
	const chapterTitle = (side: Side, scene: DraftScene) => {
		const index = side.chapters.findIndex((chapter) => chapter.id === scene.chapterId);
		if (index < 0) return null;
		return side.chapters[index].title ?? `Chapter ${index + 1}`;
	};
	const changes: SceneChange[] = [];
	const outline = draftOutline(after);
	for (const scene of [
		...outline.chapters.flatMap((chapter) => chapter.scenes),
		...outline.unfiled
	]) {
		let match = beforeById.get(scene.id);
		if ((!match || used.has(match.id)) && scene.origin) match = beforeById.get(scene.origin);
		if (match && used.has(match.id)) match = undefined;
		if (match) used.add(match.id);
		changes.push({
			kind: !match
				? 'added'
				: match.bodyMd === scene.bodyMd && match.title === scene.title
					? 'same'
					: 'changed',
			before: match ?? null,
			after: scene,
			chapterTitle: chapterTitle(after, scene)
		});
	}
	for (const scene of before.scenes) {
		if (used.has(scene.id)) continue;
		changes.push({
			kind: 'removed',
			before: scene,
			after: null,
			chapterTitle: chapterTitle(before, scene)
		});
	}
	const counts = { same: 0, changed: 0, added: 0, removed: 0 };
	for (const change of changes) counts[change.kind]++;
	const sum = (side: Side) => side.scenes.reduce((total, scene) => total + scene.wordCount, 0);
	return { changes, counts, words: { before: sum(before), after: sum(after) } };
}
