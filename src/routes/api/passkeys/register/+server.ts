import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { finishPasskeyRegistration, PASSKEY_CHALLENGE_COOKIE } from '$lib/server/passkeys';

// Step two of adding a passkey: verify the authenticator's response against
// the held challenge and store the credential.
export const POST: RequestHandler = async ({ cookies, locals, request, url }) => {
	const body = await request.json().catch(() => null);
	if (!body?.response) {
		return json({ message: 'That passkey could not be verified.' }, { status: 400 });
	}
	const origin = env.ORIGIN ?? url.origin;
	const result = await finishPasskeyRegistration(
		db,
		locals.user!.id,
		body.response,
		cookies.get(PASSKEY_CHALLENGE_COOKIE),
		origin,
		String(body.name ?? '')
	);
	cookies.delete(PASSKEY_CHALLENGE_COOKIE, { path: '/' });
	if (!result.ok) return json({ message: result.reason }, { status: 400 });
	return json({ ok: true });
};
