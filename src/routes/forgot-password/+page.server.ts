import { env } from '$env/dynamic/private';
import type { Actions } from './$types';
import { db } from '$lib/server/db';
import { requestPasswordReset } from '$lib/server/password-reset';
import { queueEmail } from '$lib/server/jobs';
import { passwordResetEmail } from '$lib/server/email';

export const actions: Actions = {
	default: async ({ request, url }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '')
			.trim()
			.toLowerCase();

		const token = await requestPasswordReset(db, email);
		if (token) {
			const origin = env.ORIGIN ?? url.origin;
			const link = `${origin}/reset-password?token=${token}`;
			await queueEmail(passwordResetEmail(email, link));
		}

		// Always the same response, whether or not the address has an account.
		return { sent: true };
	}
};
