import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { createSession, SESSION_COOKIE, verifyCredentials } from '$lib/server/auth';
import { signupMode } from '$lib/server/settings';
import { isTotpEnabled, issueTotpChallenge, TOTP_CHALLENGE_COOKIE } from '$lib/server/two-factor';
import { rateLimit } from '$lib/server/rate-limit';
import { logEvent } from '$lib/server/log';

const CHALLENGE_MAX_AGE_SECONDS = 10 * 60;
// Keyed by the targeted account, so brute force against one login is slowed
// without locking the whole instance out; ample for a human retyping.
const LOGIN_LIMIT = 15;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
// A coarser per-address cap so one host cannot spray a common password across
// many accounts, where each account's own counter stays low. Wide enough for a
// shared network behind one proxy; needs ADDRESS_HEADER set (see the README)
// for the address to be the real client rather than the proxy.
const LOGIN_IP_LIMIT = 50;

// Whether to offer the sign-up link at all.
export const load: PageServerLoad = async () => {
	return { signupOpen: (await signupMode(db)) !== 'none' };
};

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

		const tooMany = () => {
			logEvent('warn', 'login.rate_limited', { email });
			return fail(429, {
				email,
				message: 'Too many sign-in attempts. Wait a few minutes and try again.'
			});
		};
		if (!rateLimit(`login:ip:${getClientAddress()}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS).allowed) {
			return tooMany();
		}
		if (!rateLimit(`login:${email}`, LOGIN_LIMIT, LOGIN_WINDOW_MS).allowed) {
			return tooMany();
		}

		const result = await verifyCredentials(db, email, password);
		if (result.status === 'invalid') {
			logEvent('info', 'login.failed', { email });
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

		// With two-factor on, the password is only half the sign-in: hold a signed
		// challenge in a short-lived cookie and ask for a code before any session
		// exists.
		if (await isTotpEnabled(db, result.user.id)) {
			cookies.set(TOTP_CHALLENGE_COOKIE, await issueTotpChallenge(db, result.user.id), {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				maxAge: CHALLENGE_MAX_AGE_SECONDS
			});
			redirect(303, '/login/totp');
		}

		const session = await createSession(db, result.user.id, {
			userAgent: request.headers.get('user-agent'),
			ip: getClientAddress()
		});
		logEvent('info', 'login.ok', { userId: result.user.id });
		cookies.set(SESSION_COOKIE, session.token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			expires: session.expiresAt
		});
		redirect(303, '/');
	}
};
