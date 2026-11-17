import type { EntityDetail } from './entity-snapshot.ts';
import { isSceneStatus, SCENE_STATUS_LABELS } from './scene-status.ts';

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
	// For a changed scene, what changed besides its text, in words.
	notes: string[];
};

export type ChapterRename = { id: string; before: string; after: string };

type Side = Pick<DraftContent, 'chapters' | 'scenes'>;

function readingOrder(side: Side): DraftScene[] {
	const outline = draftOutline(side);
	return [...outline.chapters.flatMap((chapter) => chapter.scenes), ...outline.unfiled];
}

// The ids of the paired scenes that changed place: those outside the longest
// run that kept its order. One scene moved, or one scene added, then marks
// only that scene, not everything after it.
function movedScenes(order: string[], olderIndex: Map<string, number>): Set<string> {
	const ids = order.filter((id) => olderIndex.has(id));
	const tails: number[] = [];
	const tailAt: number[] = [];
	const previous: number[] = [];
	ids.forEach((id, i) => {
		const value = olderIndex.get(id)!;
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (tails[mid] < value) low = mid + 1;
			else high = mid;
		}
		tails[low] = value;
		tailAt[low] = i;
		previous[i] = low > 0 ? tailAt[low - 1] : -1;
	});
	const kept = new Set<string>();
	for (let i = tails.length ? tailAt[tails.length - 1] : -1; i >= 0; i = previous[i]) {
		kept.add(ids[i]);
	}
	return new Set(ids.filter((id) => !kept.has(id)));
}

function statusLabel(status: string): string {
	return isSceneStatus(status) ? SCENE_STATUS_LABELS[status] : status;
}

// What changed between two versions of a story, scene by scene: in the
// newer version's reading order, then the scenes it no longer has. Scenes
// pair up through matchScenes. A scene is changed when its text, title,
// summary or status differs, or when it moved to another chapter or place;
// unchanged scenes are only counted. Chapters kept in both under a new title
// are listed as renames.
export function compareDrafts(
	before: Side,
	after: Side
): {
	changes: SceneChange[];
	counts: Record<SceneChangeKind, number>;
	words: { before: number; after: number };
	chapterRenames: ChapterRename[];
} {
	const beforeById = new Map(before.scenes.map((scene) => [scene.id, scene]));
	const pairs = matchScenes(before.scenes, after.scenes);
	const matched = new Set(pairs.values());
	const chapterTitle = (side: Side, chapterId: string | null) => {
		const index = side.chapters.findIndex((chapter) => chapter.id === chapterId);
		if (index < 0) return null;
		return side.chapters[index].title ?? `Chapter ${index + 1}`;
	};
	const slim = (scene: DraftScene): CompareScene => ({
		id: scene.id,
		title: scene.title,
		bodyMd: scene.bodyMd,
		wordCount: scene.wordCount
	});
	const afterOrder = readingOrder(after);
	const olderIndex = new Map(readingOrder(before).map((scene, index) => [scene.id, index]));
	// Keyed by the newer scene's id, through its pair.
	// A scene that changed chapter gets its own note, so it stays out of the
	// order check and cannot make a scene that stayed put look moved.
	const pairedIndex = new Map(
		afterOrder
			.filter(
				(scene) =>
					pairs.has(scene.id) && beforeById.get(pairs.get(scene.id)!)!.chapterId === scene.chapterId
			)
			.map((scene) => [scene.id, olderIndex.get(pairs.get(scene.id)!)!])
	);
	const moved = movedScenes(
		afterOrder.map((scene) => scene.id),
		pairedIndex
	);
	const changes: SceneChange[] = [];
	const counts = { same: 0, changed: 0, added: 0, removed: 0 };
	for (const scene of afterOrder) {
		const pairedId = pairs.get(scene.id);
		const match = pairedId ? beforeById.get(pairedId) : undefined;
		const notes: string[] = [];
		if (match) {
			if (match.title !== scene.title) {
				notes.push(`Renamed from "${match.title ?? 'Untitled scene'}"`);
			}
			if (match.chapterId !== scene.chapterId) {
				const from = chapterTitle(before, match.chapterId);
				notes.push(from ? `Moved from ${from}` : 'Moved into a chapter');
			} else if (moved.has(scene.id)) {
				notes.push('Moved to another place in the story');
			}
			if (match.status !== scene.status) {
				notes.push(
					`Status changed from ${statusLabel(match.status)} to ${statusLabel(scene.status)}`
				);
			}
			if ((match.summaryMd ?? '') !== (scene.summaryMd ?? '')) notes.push('Summary changed');
			if (match.bodyMd === scene.bodyMd && notes.length === 0) {
				counts.same++;
				continue;
			}
		}
		const kind = match ? 'changed' : 'added';
		counts[kind]++;
		changes.push({
			kind,
			before: match ? slim(match) : null,
			after: slim(scene),
			chapterTitle: chapterTitle(after, scene.chapterId),
			notes
		});
	}
	for (const scene of before.scenes) {
		if (matched.has(scene.id)) continue;
		counts.removed++;
		changes.push({
			kind: 'removed',
			before: slim(scene),
			after: null,
			chapterTitle: chapterTitle(before, scene.chapterId),
			notes: []
		});
	}
	const chapterRenames: ChapterRename[] = [];
	for (const chapter of after.chapters) {
		const older = before.chapters.find((candidate) => candidate.id === chapter.id);
		if (!older || (older.title ?? '') === (chapter.title ?? '')) continue;
		const from = chapterTitle(before, older.id)!;
		const to = chapterTitle(after, chapter.id)!;
		if (from !== to) chapterRenames.push({ id: chapter.id, before: from, after: to });
	}
	const sum = (side: Side) => side.scenes.reduce((total, scene) => total + scene.wordCount, 0);
	return {
		changes,
		counts,
		words: { before: sum(before), after: sum(after) },
		chapterRenames
	};
}

const ORDINALS = [
	'First',
	'Second',
	'Third',
	'Fourth',
	'Fifth',
	'Sixth',
	'Seventh',
	'Eighth',
	'Ninth',
	'Tenth',
	'Eleventh',
	'Twelfth'
];

function draftName(n: number): string {
	return n <= ORDINALS.length ? `${ORDINALS[n - 1]} draft` : `Draft ${n}`;
}

// The number a suggested name stands for: "Third draft" is 3, "Draft 14" is
// 14. Anything else is 0.
function draftNumber(label: string): number {
	const name = label.trim().toLowerCase();
	const ordinal = ORDINALS.findIndex((word) => `${word.toLowerCase()} draft` === name);
	if (ordinal >= 0) return ordinal + 1;
	// Up to six digits: past that it is not a count, and a huge number would
	// stop the search for a free name from ever moving on.
	const numbered = /^draft (\d{1,6})$/.exec(name);
	return numbered ? Number(numbered[1]) : 0;
}

// The name offered for the next saved draft: "Second draft" when the story
// has one, and past the highest numbered name in use, so deleting earlier
// drafts never offers a lower number again.
export function suggestDraftName(existing: string[]): string {
	const taken = new Set(existing.map((label) => label.trim().toLowerCase()));
	let n = Math.max(existing.length, ...existing.map(draftNumber)) + 1;
	while (taken.has(draftName(n).toLowerCase())) n++;
	return draftName(n);
}
