// Wire types shared between server loaders and client components, defined
// client-side (the review-ui.ts pattern) so no component imports from
// #lib/server. The server modules that produce these shapes import the types
// from here.

import type { EntityKind } from '#lib/components/EntityEditor.svelte';

// A note row in the sidebar list (notes.ts).
export type NoteListItem = {
	id: string;
	title: string | null;
	pinned: boolean;
	updatedAt: Date;
};

// A command-palette search hit (search.ts).
export type SearchResult = {
	type: 'universe' | 'story' | 'scene' | 'character' | 'place' | 'lore' | 'passage';
	label: string;
	sublabel: string | null;
	href: string;
};

// The editor's read-only entity quick card (plan-data.ts).
export type EntityCardData = {
	id: string;
	kind: EntityKind;
	name: string;
	categoryName: string | null;
	categoryColor: string | null;
	badgeColor: string | null;
	badgeAssetId: string | null;
	aliases: string[];
	summaryMd: string | null;
	bodyMd: string;
	details: { label: string; value: string }[];
	related: { id: string; name: string; kind: EntityKind; label: string }[];
};

// Find and replace across a chapter or a story (story-replace.ts).
export type StoryFindMatch = {
	start: number;
	end: number;
	before: string;
	text: string;
	after: string;
};
export type StoryFindScene = {
	sceneId: string;
	title: string | null;
	chapterId: string | null;
	// Fingerprint of the stored text the matches were found in; the replace
	// leaves the scene alone when the text has changed since.
	baseHash: string;
	matches: StoryFindMatch[];
};
export type StoryFindResult = {
	scenes: StoryFindScene[];
	matchCount: number;
	// More matches than the preview lists; only the listed ones can be replaced.
	truncated: boolean;
};
export type StoryReplaceResult = {
	scenesChanged: number;
	replaced: number;
	// Scenes left alone: changed (or gone) since the search, or the replace
	// would make them longer than a scene can be saved.
	skipped: { sceneId: string; title: string | null; reason: 'changed' | 'too_long' }[];
};
