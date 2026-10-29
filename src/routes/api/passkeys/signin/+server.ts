import { error } from '@sveltejs/kit';
import { publicOrigin } from '$lib/server/origin';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { readJson } from '$lib/server/validation';
import { createSession, SESSION_COOKIE } from '$lib/server/auth';
import { finishPasskeySignIn, PASSKEY_CHALLENGE_COOKIE } from '$lib/server/passkeys';
import { rateLimit } from '$lib/server/rate-limit';
import { logEvent } from '$lib/server/log';

// Step two of passkey sign-in: verify the assertion, apply the same account
// gates as the password path, and create the session. A verified passkey
// already proves possession plus a local check, so no TOTP step follows.
export const POST: RequestHandler = async ({ cookies, getClientAddress, request, url }) => {
	if (!rateLimit(`passkey:${getClientAddress()}`, 30, 5 * 60 * 1000).allowed) {
		error(429, 'Too many attempts. Wait a few minutes.');
	}
	const body = await readJson<{ response?: AuthenticationResponseJSON }>(request);
	if (!body.response?.id) {
		error(400, 'That passkey was not recognised.');
	}
	const origin = publicOrigin(url);
	const result = await finishPasskeySignIn(
		db,
		body.response,
		cookies.get(PASSKEY_CHALLENGE_COOKIE),
		origin
	);
	cookies.delete(PASSKEY_CHALLENGE_COOKIE, { path: '/' });

	if (result.status === 'invalid') {
		logEvent('info', 'login.passkey_failed', { ip: getClientAddress() });
		error(400, 'That passkey was not recognised.');
	}
	if (result.status === 'unverified') {
		error(403, 'Confirm your email address before signing in.');
	}
	if (result.status === 'unapproved') {
		error(403, 'Your account is awaiting approval.');
	}
	if (result.status === 'suspended') {
		error(403, 'This account has been suspended.');
	}

	const session = await createSession(db, result.user.id, {
		userAgent: request.headers.get('user-agent'),
		ip: getClientAddress()
	});
	logEvent('info', 'login.passkey_ok', { userId: result.user.id });
	cookies.set(SESSION_COOKIE, session.token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		expires: session.expiresAt
	});
	return Response.json({ ok: true });
};
