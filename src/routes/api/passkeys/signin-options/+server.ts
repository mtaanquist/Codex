import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { secretsAvailable } from '$lib/server/crypto';
import { PASSKEY_CHALLENGE_COOKIE, startPasskeySignIn } from '$lib/server/passkeys';
import { rateLimit } from '$lib/server/rate-limit';

// Step one of passkey sign-in. Public and usernameless: the options carry no
// account hints, just a fresh challenge held in a signed cookie.
export const POST: RequestHandler = async ({ cookies, getClientAddress, url }) => {
	if (!secretsAvailable()) {
		return json({ message: 'Passkey sign-in is not available.' }, { status: 503 });
	}
	if (!rateLimit(`passkey:${getClientAddress()}`, 30, 5 * 60 * 1000).allowed) {
		return json({ message: 'Too many attempts. Wait a few minutes.' }, { status: 429 });
	}
	const origin = env.ORIGIN ?? url.origin;
	const { options, challengeToken } = await startPasskeySignIn(origin);
	cookies.set(PASSKEY_CHALLENGE_COOKIE, challengeToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 600
	});
	return json(options);
};
