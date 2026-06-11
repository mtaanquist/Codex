// The sidebar search semantics shared by the Write outline and the Review
// nav: a matching chapter keeps all its scenes, otherwise only matching
// scenes show, and a chapter with nothing left hides. Untitled rows match by
// their fallback labels.

const UNTITLED_SCENE = 'Untitled scene';

function matches(query: string, title: string | null, fallback: string): boolean {
	return (title ?? fallback).toLowerCase().includes(query);
}

export type OutlineChapterMatch<S> = {
	// The chapter's own name matched (or no search is active).
	chapterMatch: boolean;
	// The scenes to render under it.
	scenes: S[];
	// Whether the chapter row renders at all.
	visible: boolean;
};

export function filterChapter<S extends { title: string | null }>(
	query: string,
	chapterTitle: string | null,
	chapterFallback: string,
	scenes: S[]
): OutlineChapterMatch<S> {
	const q = query.trim().toLowerCase();
	const chapterMatch = q === '' || matches(q, chapterTitle, chapterFallback);
	const list = chapterMatch ? scenes : scenes.filter((s) => matches(q, s.title, UNTITLED_SCENE));
	return { chapterMatch, scenes: list, visible: chapterMatch || list.length > 0 };
}

// Scenes outside any chapter: only matching scenes show under a search.
export function filterOrphanScenes<S extends { title: string | null }>(
	query: string,
	scenes: S[]
): S[] {
	const q = query.trim().toLowerCase();
	return q === '' ? scenes : scenes.filter((s) => matches(q, s.title, UNTITLED_SCENE));
}
