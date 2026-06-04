import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { verifyEmail } from '$lib/server/signup';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	if (!token) return { verified: false };
	return { verified: await verifyEmail(db, token) };
};
