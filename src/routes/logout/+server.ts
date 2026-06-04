import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth';

// Signing out from anywhere (the avatar menu). Revokes the current session and
// clears the cookie, then sends the visitor to the sign-in page.
export const POST: RequestHandler = async ({ locals, cookies }) => {
	if (locals.session) await revokeSession(db, locals.session.id);
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/login');
};
