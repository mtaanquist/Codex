import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	ownProfilePreview,
	publicAuthorIdentity,
	publicProfile,
	publicShelf
} from '$lib/server/publish';

// The author's public shelf. Public and unguarded by design; it only ever
// reads frozen editions, and the profile header only when listed publicly.
// The owner sees their own header either way, marked as a preview while the
// page is not listed, so they can check the page before turning it on.
export const load: PageServerLoad = async ({ params, locals }) => {
	// Handles are stored lowercase (citext on users); a URL typed with
	// different casing must still resolve.
	const handle = params.handle.toLowerCase();
	const [shelf, listed, identity] = await Promise.all([
		publicShelf(db, handle),
		publicProfile(db, handle),
		publicAuthorIdentity(db, handle)
	]);
	let profile = listed;
	let preview = false;
	if (!listed && locals.user) {
		const own = await ownProfilePreview(db, locals.user.id, handle);
		if (own) {
			const { profilePublic, ...header } = own;
			profile = header;
			preview = !profilePublic;
		}
	}
	return { handle, shelf, profile, identity, preview };
};
