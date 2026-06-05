import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { searchAll } from '$lib/server/search';
import { rateLimit } from '$lib/server/rate-limit';

// The command palette's search box. Owner-scoped; an empty query returns
// nothing rather than everything.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!rateLimit(`search:${locals.user!.id}`, 120, 60 * 1000).allowed) {
		return json({ results: [] });
	}
	const query = url.searchParams.get('q') ?? '';
	return json({ results: await searchAll(db, locals.user!.id, query) });
};
