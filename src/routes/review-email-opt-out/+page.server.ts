import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { applyReviewerOptOut, reviewerOptOutTarget } from '$lib/server/notification-digest';

// The GET only checks the link, so a mail scanner's prefetch cannot silently
// opt the reviewer out; the button's POST does it.
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	return { valid: token !== null && reviewerOptOutTarget(token) !== null };
};

export const actions: Actions = {
	default: async ({ url }) => {
		const token = url.searchParams.get('token') ?? '';
		return { optedOut: await applyReviewerOptOut(db, token) };
	}
};
