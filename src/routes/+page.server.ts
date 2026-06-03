import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth';

export const load: PageServerLoad = async ({ locals }) => {
	// The hook guard guarantees a user here.
	return { user: locals.user! };
};

export const actions: Actions = {
	signout: async ({ locals, cookies }) => {
		if (locals.session) {
			await revokeSession(db, locals.session.id);
		}
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
