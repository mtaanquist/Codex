// Pure helpers for the library dashboard: the story card's status pill and
// the "edited ..." wording. No I/O.

export type StoryStatusCounts = {
	sceneCount: number;
	words: number;
	outline: number;
	draft: number;
	revised: number;
	final: number;
};

export type StoryStatus = {
	label: 'Outlining' | 'Drafting' | 'Revising' | 'Final';
	token: 'outline' | 'draft' | 'revised' | 'final';
};

// One label for the whole story, derived from its scenes: nothing written
// yet reads as outlining; otherwise the most common scene status wins, the
// later stage taking ties.
export function storyStatus(counts: StoryStatusCounts): StoryStatus {
	if (counts.sceneCount === 0 || counts.words === 0) {
		return { label: 'Outlining', token: 'outline' };
	}
	const ladder: [number, StoryStatus][] = [
		[counts.outline, { label: 'Outlining', token: 'outline' }],
		[counts.draft, { label: 'Drafting', token: 'draft' }],
		[counts.revised, { label: 'Revising', token: 'revised' }],
		[counts.final, { label: 'Final', token: 'final' }]
	];
	let best = ladder[0];
	for (const step of ladder) {
		if (step[0] >= best[0]) best = step;
	}
	return best[1];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "2 hours ago", "yesterday", "3 months ago": the card meta. */
export function relativeTime(then: Date, now: Date): string {
	const elapsed = now.getTime() - then.getTime();
	if (elapsed < 2 * MINUTE) return 'just now';
	if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} minutes ago`;
	if (elapsed < 2 * HOUR) return '1 hour ago';
	if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hours ago`;
	if (elapsed < 2 * DAY) return 'yesterday';
	if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;
	if (elapsed < 14 * DAY) return 'last week';
	if (elapsed < 30 * DAY) return `${Math.floor(elapsed / (7 * DAY))} weeks ago`;
	if (elapsed < 60 * DAY) return 'last month';
	if (elapsed < 365 * DAY) return `${Math.floor(elapsed / (30 * DAY))} months ago`;
	const years = Math.floor(elapsed / (365 * DAY));
	return years === 1 ? 'last year' : `${years} years ago`;
}
