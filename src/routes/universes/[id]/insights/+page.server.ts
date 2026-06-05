import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { ownedUniverse } from '$lib/server/universe-access';
import {
	entityHeat,
	isValidTimezone,
	relationshipLinks,
	storyProgress,
	writingActivity
} from '$lib/server/insights';

export const load: PageServerLoad = async ({ params, locals, cookies }) => {
	const universe = await ownedUniverse(params.id, locals.user!.id);
	// Day boundaries follow the author's clock. The page sets this cookie on
	// first visit and reloads the data once; until then days bucket as UTC.
	const requested = decodeURIComponent(cookies.get('codex-tz') ?? '');
	const timezone = requested && isValidTimezone(requested) ? requested : 'UTC';
	const [stories, heat, activity, web] = await Promise.all([
		storyProgress(db, universe.id),
		entityHeat(db, universe.id),
		writingActivity(db, universe.id, timezone),
		relationshipLinks(db, universe.id)
	]);
	return { universe, timezone, stories, heat, activity, web };
};
