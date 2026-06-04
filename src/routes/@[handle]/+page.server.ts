import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { publicShelf } from '$lib/server/publish';

// The author's public shelf. Public and unguarded by design; it only ever
// reads frozen editions.
export const load: PageServerLoad = async ({ params }) => {
	// Handles are stored lowercase (citext on users); a URL typed with
	// different casing must still resolve.
	const handle = params.handle.toLowerCase();
	const shelf = await publicShelf(db, handle);
	return { handle, shelf };
};
