import { error, json } from '@sveltejs/kit';
import { publicOrigin } from '$lib/server/origin';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { readJson } from '$lib/server/validation';
import { finishPasskeyRegistration, PASSKEY_CHALLENGE_COOKIE } from '$lib/server/passkeys';

// Step two of adding a passkey: verify the authenticator's response against
// the held challenge and store the credential.
export const POST: RequestHandler = async ({ cookies, locals, request, url }) => {
	const body = await readJson<{ response?: RegistrationResponseJSON; name?: unknown }>(request);
	if (!body.response) {
		error(400, 'That passkey could not be verified.');
	}
	const origin = publicOrigin(url);
	const result = await finishPasskeyRegistration(
		db,
		locals.user!.id,
		body.response,
		cookies.get(PASSKEY_CHALLENGE_COOKIE),
		origin,
		String(body.name ?? '')
	);
	cookies.delete(PASSKEY_CHALLENGE_COOKIE, { path: '/' });
	if (!result.ok) error(400, result.reason);
	return json({ ok: true });
};
