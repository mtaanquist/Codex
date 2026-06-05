import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { createSession, SESSION_COOKIE } from '$lib/server/auth';
import { finishPasskeySignIn, PASSKEY_CHALLENGE_COOKIE } from '$lib/server/passkeys';
import { rateLimit } from '$lib/server/rate-limit';
import { logEvent } from '$lib/server/log';

// Step two of passkey sign-in: verify the assertion, apply the same account
// gates as the password path, and create the session. A verified passkey
// already proves possession plus a local check, so no TOTP step follows.
export const POST: RequestHandler = async ({ cookies, getClientAddress, request, url }) => {
	if (!rateLimit(`passkey:${getClientAddress()}`, 30, 5 * 60 * 1000).allowed) {
		return json({ message: 'Too many attempts. Wait a few minutes.' }, { status: 429 });
	}
	const body = await request.json().catch(() => null);
	if (!body?.response?.id) {
		return json({ message: 'That passkey was not recognised.' }, { status: 400 });
	}
	const origin = env.ORIGIN ?? url.origin;
	const result = await finishPasskeySignIn(
		db,
		body.response,
		cookies.get(PASSKEY_CHALLENGE_COOKIE),
		origin
	);
	cookies.delete(PASSKEY_CHALLENGE_COOKIE, { path: '/' });

	if (result.status === 'invalid') {
		logEvent('info', 'login.passkey_failed', { ip: getClientAddress() });
		return json({ message: 'That passkey was not recognised.' }, { status: 400 });
	}
	if (result.status === 'unverified') {
		return json({ message: 'Confirm your email address before signing in.' }, { status: 403 });
	}
	if (result.status === 'unapproved') {
		return json({ message: 'Your account is awaiting approval.' }, { status: 403 });
	}
	if (result.status === 'suspended') {
		return json({ message: 'This account has been suspended.' }, { status: 403 });
	}

	const session = await createSession(db, result.user.id, {
		userAgent: request.headers.get('user-agent'),
		ip: getClientAddress()
	});
	logEvent('info', 'login.passkey_ok', { userId: result.user.id });
	cookies.set(SESSION_COOKIE, session.id, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		expires: session.expiresAt
	});
	return json({ ok: true });
};
