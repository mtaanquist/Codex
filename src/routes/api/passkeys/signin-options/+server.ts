import { error } from '@sveltejs/kit';
import { publicOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';
import { secretsAvailable } from '$lib/server/crypto';
import { PASSKEY_CHALLENGE_COOKIE, startPasskeySignIn } from '$lib/server/passkeys';
import { rateLimit } from '$lib/server/rate-limit';

// Step one of passkey sign-in. Public and usernameless: the options carry no
// account hints, just a fresh challenge held in a signed cookie.
export const POST: RequestHandler = async ({ cookies, getClientAddress, url }) => {
	if (!secretsAvailable()) {
		error(503, 'Passkey sign-in is not available.');
	}
	if (!rateLimit(`passkey:${getClientAddress()}`, 30, 5 * 60 * 1000).allowed) {
		error(429, 'Too many attempts. Wait a few minutes.');
	}
	const origin = publicOrigin(url);
	const { options, challengeToken } = await startPasskeySignIn(origin);
	cookies.set(PASSKEY_CHALLENGE_COOKIE, challengeToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 600
	});
	return Response.json(options);
};
