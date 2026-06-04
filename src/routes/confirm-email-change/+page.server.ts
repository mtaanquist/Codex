import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { confirmEmailChange } from '$lib/server/account';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	if (!token) return { ok: false, reason: 'This confirmation link is not valid.' };
	return confirmEmailChange(db, token);
};
