import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { verifyAccountPassword } from '$lib/server/account';
import { secretsAvailable } from '$lib/server/crypto';
import { reauthLimit } from '$lib/server/reauth';
import { PASSKEY_CHALLENGE_COOKIE, startPasskeyRegistration } from '$lib/server/passkeys';

// Step one of adding a passkey: hand the browser its creation options and
// hold the challenge in a signed, short-lived cookie.
//
// Adding a passkey is gated by the current password, the same as removing
// one: a passkey is password-free at sign-in and survives a password reset,
// so a borrowed session must not be able to add a durable credential without
// re-proving the password. Shares the re-auth throttle with the account
// page's other password-gated actions.
export const POST: RequestHandler = async ({ cookies, locals, request, url }) => {
	if (!secretsAvailable()) {
		return json({ message: 'Set APP_SECRET on the server to use passkeys.' }, { status: 503 });
	}
	const limit = reauthLimit(locals.user!.id);
	if (!limit.allowed) {
		const minutes = Math.ceil(limit.retryAfterSeconds / 60);
		return json(
			{
				message: `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
			},
			{ status: 429 }
		);
	}
	const body = await request.json().catch(() => null);
	if (!(await verifyAccountPassword(db, locals.user!.id, String(body?.password ?? '')))) {
		return json({ message: 'That password is not right.' }, { status: 400 });
	}
	const origin = env.ORIGIN ?? url.origin;
	const { options, challengeToken } = await startPasskeyRegistration(db, locals.user!, origin);
	cookies.set(PASSKEY_CHALLENGE_COOKIE, challengeToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 600
	});
	return json(options);
};
