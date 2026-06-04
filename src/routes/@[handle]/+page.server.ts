import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { publicProfile, publicShelf } from '$lib/server/publish';

// The author's public shelf. Public and unguarded by design; it only ever
// reads frozen editions, and the profile header only when listed publicly.
export const load: PageServerLoad = async ({ params }) => {
	// Handles are stored lowercase (citext on users); a URL typed with
	// different casing must still resolve.
	const handle = params.handle.toLowerCase();
	const [shelf, profile] = await Promise.all([publicShelf(db, handle), publicProfile(db, handle)]);
	return { handle, shelf, profile };
};
