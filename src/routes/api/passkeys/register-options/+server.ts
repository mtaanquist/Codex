import { error, json } from '@sveltejs/kit';
import { publicOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { readJson } from '$lib/server/validation';
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
		error(503, 'Set APP_SECRET on the server to use passkeys.');
	}
	const limit = reauthLimit(locals.user!.id);
	if (!limit.allowed) {
		const minutes = Math.ceil(limit.retryAfterSeconds / 60);
		error(
			429,
			`Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
		);
	}
	const body = await readJson<{ password?: unknown }>(request);
	if (!(await verifyAccountPassword(db, locals.user!.id, String(body.password ?? '')))) {
		error(400, 'That password is not right.');
	}
	const origin = publicOrigin(url);
	const { options, challengeToken } = await startPasskeyRegistration(db, locals.user!, origin);
	cookies.set(PASSKEY_CHALLENGE_COOKIE, challengeToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 600
	});
	return json(options);
};
