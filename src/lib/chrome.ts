import { resolve } from '$app/paths';

// The path in the app bar, built here so every screen spells the same
// destinations the same way. The model: Library / Universe / Story / Page.
// Every crumb opens that place's home, the last crumb is the page you are on
// and does not link, and a place in the path is a menu whose first item goes
// to the place itself. A page in the path is plain text, because nothing
// belongs to it.

// The line under the mode strip at universe scope. Write and Review need a
// story open, so both open the universe's own list of stories.
export const UNIVERSE_MODE_NOTE =
	'Write and Review need a story open. Both take you to the story list.';

// The line under the mode strip on a universe page that is not one of the four
// modes, so nothing in the strip is lit.
export const INSIGHTS_MODE_NOTE =
	'Insights reads the whole universe, so no mode is current. Pick one to go back to the work.';

// The line under the mode strip for an invited reviewer.
export const GUEST_MODE_NOTE =
	'You were invited to review. Write and Plan belong to the author, so they are here but switched off.';

// The line under the mode strip on the Notes pages, which sit beside the
// modes rather than being one.
export const NOTES_MODE_NOTE =
	'Notes sit beside every mode; the Notes panel on the right of Write and Plan brings you here. Pick a mode to go back to the work.';

export type CrumbMenuItem = { label: string; href: string; current?: boolean };

export type Crumb =
	// A place further up the path, opened by clicking its name.
	| { kind: 'link'; label: string; href: string }
	// The page you are on, or a place with nothing behind it.
	| { kind: 'text'; label: string }
	// A place: the name is the menu, and `groups` are separated by a rule.
	| { kind: 'place'; label: string; current: boolean; groups: CrumbMenuItem[][] };

export type UniverseRef = { slug: string; name: string };

// A story's public reading page, when it has one. Absent when the story has
// no published edition, or the owner has no public handle: the menu then
// leaves the item out rather than offering a dead link.
export type ReadingRef = { handle: string; storyId: string };

export type StoryRef = { slug: string; title: string; reading?: ReadingRef | null };

// Which universe-scoped page is open, so the menu can tick it.
export type UniverseAt = 'universe' | 'settings' | 'insights' | 'export' | null;
// Which story-scoped page is open, so the menu can tick it.
export type StoryAt = 'story' | 'settings' | 'print' | 'export' | 'reading' | null;

export function libraryCrumb(current = false): Crumb {
	return current
		? { kind: 'text', label: 'Library' }
		: { kind: 'link', label: 'Library', href: resolve('/') };
}

export function universeCrumb(universe: UniverseRef, at: UniverseAt = null): Crumb {
	const settings = resolve('/universes/[id]/[[section]]', { id: universe.slug });
	return {
		kind: 'place',
		label: universe.name,
		current: at === 'universe',
		groups: [
			[
				{
					label: 'Go to the universe',
					href: resolve('/universes/[id]/plan', { id: universe.slug }),
					current: at === 'universe'
				}
			],
			[
				{ label: 'Universe settings', href: settings, current: at === 'settings' },
				{
					label: 'Insights',
					href: resolve('/universes/[id]/insights', { id: universe.slug }),
					current: at === 'insights'
				}
			],
			[
				{
					label: 'Export the universe',
					href: resolve('/universes/[id]/[[section]]', {
						id: universe.slug,
						section: 'export'
					}),
					current: at === 'export'
				}
			]
		]
	};
}

export function storyCrumb(story: StoryRef, at: StoryAt = null): Crumb {
	const own: CrumbMenuItem[] = [
		{
			label: 'Story settings',
			href: resolve('/stories/[id]/settings/[[section]]', { id: story.slug }),
			current: at === 'settings'
		},
		{
			label: 'Print preview',
			href: resolve('/stories/[id]/print', { id: story.slug }),
			current: at === 'print'
		},
		{
			label: 'Export a file',
			href: resolve('/stories/[id]/settings/[[section]]', {
				id: story.slug,
				section: 'export'
			}),
			current: at === 'export'
		}
	];
	const groups: CrumbMenuItem[][] = [
		[
			{
				label: 'Go to the story',
				href: resolve('/stories/[id]', { id: story.slug }),
				current: at === 'story'
			}
		],
		own
	];
	if (story.reading) {
		groups.push([
			{
				label: 'Public reading page',
				href: resolve('/@[handle]/[story=uuid]', {
					handle: story.reading.handle,
					story: story.reading.storyId
				}),
				current: at === 'reading'
			}
		]);
	}
	return { kind: 'place', label: story.title, current: at === 'story', groups };
}

// A page under a place: Insights, Print preview, a help article.
export function pageCrumb(label: string): Crumb {
	return { kind: 'text', label };
}

// The whole path for a story-scoped page, which is every editor view plus the
// pages that hang off a story.
export function storyPath(
	universe: UniverseRef,
	story: StoryRef,
	options: { storyAt?: StoryAt; page?: string } = {}
): Crumb[] {
	const crumbs: Crumb[] = [
		libraryCrumb(),
		universeCrumb(universe),
		storyCrumb(story, options.storyAt ?? null)
	];
	if (options.page) crumbs.push(pageCrumb(options.page));
	return crumbs;
}

// The whole path for a universe-scoped page.
export function universePath(
	universe: UniverseRef,
	options: { universeAt?: UniverseAt; page?: string } = {}
): Crumb[] {
	const crumbs: Crumb[] = [libraryCrumb(), universeCrumb(universe, options.universeAt ?? null)];
	if (options.page) crumbs.push(pageCrumb(options.page));
	return crumbs;
}
