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
