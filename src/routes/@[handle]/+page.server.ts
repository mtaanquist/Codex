import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { publicShelf } from '$lib/server/publish';

// The author's public shelf. Public and unguarded by design; it only ever
// reads frozen editions.
export const load: PageServerLoad = async ({ params }) => {
	const shelf = await publicShelf(db, params.handle);
	return { handle: params.handle, shelf };
};
