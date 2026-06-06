import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { peekToken } from '$lib/server/tokens';
import { confirmEmailChange } from '$lib/server/account';

// The GET only checks the token, so a mail scanner's prefetch cannot swap
// the address or burn the link; the button's POST confirms the change.
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	return { valid: token !== null && (await peekToken(db, 'email_change', token)) !== null };
};

export const actions: Actions = {
	default: async ({ url }) => {
		const token = url.searchParams.get('token') ?? '';
		return confirmEmailChange(db, token);
	}
};
