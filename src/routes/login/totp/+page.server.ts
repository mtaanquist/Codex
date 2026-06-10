import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { createSession, SESSION_COOKIE } from '$lib/server/auth';
import {
	consumeRecoveryCode,
	consumeTotpChallenge,
	peekTotpChallenge,
	readTotpChallenge,
	TOTP_CHALLENGE_COOKIE,
	verifyUserTotp
} from '$lib/server/two-factor';
import { rateLimit } from '$lib/server/rate-limit';
import { logEvent } from '$lib/server/log';

// Keyed by the challenged account, so the six-digit space cannot be brute
// forced: a handful of tries per window makes guessing infeasible.
const CODE_LIMIT = 10;
const CODE_WINDOW_MS = 5 * 60 * 1000;

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

		if (!rateLimit(`totp:${userId}`, CODE_LIMIT, CODE_WINDOW_MS).allowed) {
			logEvent('warn', 'totp.rate_limited', { userId });
			return fail(429, {
				recovery: useRecovery,
				message: 'Too many attempts. Wait a few minutes and try again.'
			});
		}

		// Validate the challenge cookie before spending anything: a stale or
		// replayed cookie must not burn a single-use recovery code. The cookie is
		// actually consumed below, once the code is verified.
		if (!(await peekTotpChallenge(db, cookies.get(TOTP_CHALLENGE_COOKIE)))) {
			cookies.delete(TOTP_CHALLENGE_COOKIE, { path: '/' });
			redirect(303, '/login');
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

		// Spend the challenge now the code is accepted: a stale or replayed cookie
		// whose nonce no longer matches is refused even with a valid code.
		if (!(await consumeTotpChallenge(db, cookies.get(TOTP_CHALLENGE_COOKIE)))) {
			cookies.delete(TOTP_CHALLENGE_COOKIE, { path: '/' });
			redirect(303, '/login');
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
