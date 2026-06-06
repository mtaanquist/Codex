import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { applyReviewerOptOut } from '$lib/server/notification-digest';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	return { optedOut: token ? await applyReviewerOptOut(db, token) : false };
};
