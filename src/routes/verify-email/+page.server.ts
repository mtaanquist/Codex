import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { peekToken } from '$lib/server/tokens';
import { verifyEmail } from '$lib/server/signup';

// The GET only checks the token, so a mail scanner's prefetch cannot spend
// it; the button's POST does the confirming.
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	return { valid: token !== null && (await peekToken(db, 'email_verify', token)) !== null };
};

export const actions: Actions = {
	default: async ({ url }) => {
		const token = url.searchParams.get('token') ?? '';
		return { verified: await verifyEmail(db, token) };
	}
};
