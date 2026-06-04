import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { Actions } from './$types';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/signup';
import { issueToken } from '$lib/server/tokens';
import { queueEmail } from '$lib/server/jobs';
import { verificationEmail } from '$lib/server/email';

const VERIFY_TTL_MINUTES = 60 * 24;

export const actions: Actions = {
	default: async ({ request, url }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const password = String(data.get('password') ?? '');
		const displayName = String(data.get('displayName') ?? '');

		const result = await registerUser(db, { email, password, displayName });

		// A taken email is treated like success so the page never reveals whether
		// an address already has an account; no second account or email is made.
		if (!result.ok && result.reason !== 'duplicate') {
			return fail(400, { email, displayName, message: result.reason });
		}

		if (result.ok) {
			const token = await issueToken(db, result.userId, 'email_verify', VERIFY_TTL_MINUTES);
			// ORIGIN is set in production (adapter-node needs it); the request
			// origin is the dev fallback. Using a configured origin keeps a spoofed
			// Host header out of the link.
			const origin = env.ORIGIN ?? url.origin;
			const link = `${origin}/verify-email?token=${token}`;
			await queueEmail(verificationEmail(email.trim().toLowerCase(), link));
		}

		return { sent: true };
	}
};
