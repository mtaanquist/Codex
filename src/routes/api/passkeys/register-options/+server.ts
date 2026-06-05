import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { secretsAvailable } from '$lib/server/crypto';
import { PASSKEY_CHALLENGE_COOKIE, startPasskeyRegistration } from '$lib/server/passkeys';

// Step one of adding a passkey: hand the browser its creation options and
// hold the challenge in a signed, short-lived cookie.
export const POST: RequestHandler = async ({ cookies, locals, url }) => {
	if (!secretsAvailable()) {
		return json({ message: 'Set APP_SECRET on the server to use passkeys.' }, { status: 503 });
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
