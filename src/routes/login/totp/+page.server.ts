import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { createSession, SESSION_COOKIE } from '$lib/server/auth';
import {
	consumeRecoveryCode,
	readTotpChallenge,
	TOTP_CHALLENGE_COOKIE,
	verifyUserTotp
} from '$lib/server/two-factor';

// The second sign-in step. Reachable only with a valid challenge cookie, which
// the login form sets after the password checks out.
export const load: PageServerLoad = async ({ cookies }) => {
	if (!readTotpChallenge(cookies.get(TOTP_CHALLENGE_COOKIE))) {
		redirect(303, '/login');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const userId = readTotpChallenge(cookies.get(TOTP_CHALLENGE_COOKIE));
		if (!userId) {
			cookies.delete(TOTP_CHALLENGE_COOKIE, { path: '/' });
			redirect(303, '/login');
		}

		const data = await request.formData();
		const useRecovery = data.get('mode') === 'recovery';
		const code = String(data.get('code') ?? '').trim();
		if (!code) {
			return fail(400, { recovery: useRecovery, message: 'Enter a code.' });
		}

		const ok = useRecovery
			? await consumeRecoveryCode(db, userId, code)
			: await verifyUserTotp(db, userId, code);
		if (!ok) {
			return fail(400, {
				recovery: useRecovery,
				message: useRecovery
					? 'That recovery code is not valid or has been used.'
					: 'That code is not right. Check your app and try again.'
			});
		}

		const session = await createSession(db, userId, {
			userAgent: request.headers.get('user-agent'),
			ip: getClientAddress()
		});
		cookies.delete(TOTP_CHALLENGE_COOKIE, { path: '/' });
		cookies.set(SESSION_COOKIE, session.id, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			expires: session.expiresAt
		});
		redirect(303, '/');
	}
};
