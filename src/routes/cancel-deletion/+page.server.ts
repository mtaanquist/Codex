import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { cancelAccountDeletion } from '$lib/server/account-deletion';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	return { cancelled: token ? await cancelAccountDeletion(db, token) : false };
};
