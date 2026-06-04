import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { db } from '$lib/server/db';
import { createSession, SESSION_COOKIE, verifyCredentials } from '$lib/server/auth';

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '')
			.trim()
			.toLowerCase();
		const password = String(data.get('password') ?? '');

		if (!email || !password) {
			return fail(400, { email, message: 'Enter your email and password.' });
		}

		const result = await verifyCredentials(db, email, password);
		if (result.status === 'invalid') {
			return fail(400, { email, message: 'Wrong email or password.' });
		}
		if (result.status === 'unverified') {
			return fail(403, { email, message: 'Confirm your email address before signing in.' });
		}
		if (result.status === 'unapproved') {
			return fail(403, { email, message: 'Your account is awaiting approval.' });
		}
		if (result.status === 'suspended') {
			return fail(403, { email, message: 'This account has been suspended.' });
		}

		const session = await createSession(db, result.user.id, {
			userAgent: request.headers.get('user-agent'),
			ip: getClientAddress()
		});
		cookies.set(SESSION_COOKIE, session.id, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			expires: session.expiresAt
		});
		redirect(303, '/');
	}
};
