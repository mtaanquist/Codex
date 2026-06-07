import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ownedUniverse } from '$lib/server/universe-access';
import { isValidTimezone, writingActivity } from '$lib/server/insights';
import { userPreferences } from '$lib/server/preferences';
import { isUuid } from '$lib/slug';

// The right pane's Session card: today's words, the last week's writing
// days, and the streak. Fetched when the tab opens, so page loads stay
// free of the activity queries.
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	const tzParam = url.searchParams.get('tz') ?? '';
	const timezone = isValidTimezone(tzParam) ? tzParam : 'UTC';
	const storyParam = url.searchParams.get('story');
	const storyId = storyParam && isUuid(storyParam) ? storyParam : null;

	const activity = await writingActivity(db, universe.id, timezone, 7);
	const week = activity.daily.map((entry) => ({
		// 'Mon' .. 'Sun'; the date string is a plain calendar day.
		label: new Date(`${entry.day}T00:00:00Z`).toLocaleDateString('en-US', {
			weekday: 'narrow',
			timeZone: 'UTC'
		}),
		active: entry.words !== 0,
		isToday: entry.day === activity.today
	}));

	let storyWords: number | null = null;
	if (storyId) {
		const story = await writingActivity(db, universe.id, timezone, 1, storyId);
		storyWords = story.daily.at(-1)?.words ?? 0;
	}

	// The streak card is optional scorekeeping; a null streak tells the
	// panel to leave it out entirely.
	const preferences = await userPreferences(db, locals.user!.id);

	return json({
		words: activity.daily.at(-1)?.words ?? 0,
		storyWords,
		week,
		streak: preferences.sessionStreak === 'hidden' ? null : activity.streak,
		// 0 means no goal; the panel shows progress toward it when set.
		dailyGoal: preferences.dailyWordGoal
	});
};
