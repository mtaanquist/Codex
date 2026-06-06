import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { peekToken } from '$lib/server/tokens';
import { cancelAccountDeletion } from '$lib/server/account-deletion';

// The GET only checks the token, so a mail scanner's prefetch can neither
// spend the link nor cancel the deletion; the button's POST does it.
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	return { valid: token !== null && (await peekToken(db, 'deletion_cancel', token)) !== null };
};

export const actions: Actions = {
	default: async ({ url }) => {
		const token = url.searchParams.get('token') ?? '';
		return { cancelled: await cancelAccountDeletion(db, token) };
	}
};
