import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/signup';
import { issueToken } from '$lib/server/tokens';
import { queueEmail } from '$lib/server/jobs';
import { signupNotificationEmail, verificationEmail } from '$lib/server/email';
import { adminEmails } from '$lib/server/admin';
import { rateLimit } from '$lib/server/rate-limit';
import { logEvent } from '$lib/server/log';

const VERIFY_TTL_MINUTES = 60 * 24;
// Per-address, so repeated sign-ups for one email cannot bomb it with
// verification mail; a legitimate sign-up happens once.
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

// An invite link (/signup?code=...) prefills the code field.
export const load: PageServerLoad = ({ url }) => {
	return { prefillCode: url.searchParams.get('code') ?? '' };
};

export const actions: Actions = {
	default: async ({ request, url }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const password = String(data.get('password') ?? '');
		const displayName = String(data.get('displayName') ?? '');
		const inviteCode = String(data.get('inviteCode') ?? '');
		const cleanEmail = email.trim().toLowerCase();

		// On the limit, return the same response without registering or mailing,
		// so the page still reveals nothing about whether the address is taken.
		if (cleanEmail && !rateLimit(`signup:${cleanEmail}`, SIGNUP_LIMIT, SIGNUP_WINDOW_MS).allowed) {
			logEvent('warn', 'signup.rate_limited', { email: cleanEmail });
			return { sent: true };
		}

		const result = await registerUser(db, { email, password, displayName, inviteCode });

		// A taken email is treated like success so the page never reveals whether
		// an address already has an account; no second account or email is made.
		if (!result.ok && result.reason !== 'duplicate') {
			return fail(400, { email, displayName, inviteCode, message: result.reason });
		}

		if (result.ok) {
			const token = await issueToken(db, result.userId, 'email_verify', VERIFY_TTL_MINUTES);
			// ORIGIN is set in production (adapter-node needs it); the request
			// origin is the dev fallback. Using a configured origin keeps a spoofed
			// Host header out of the link.
			const origin = env.ORIGIN ?? url.origin;
			const link = `${origin}/verify-email?token=${token}`;
			await queueEmail(verificationEmail(cleanEmail, link));

			// Let the operator know there is someone to review (or, with an invite
			// code, that someone joined).
			const reviewLink = `${origin}/admin`;
			for (const admin of await adminEmails(db)) {
				await queueEmail(
					signupNotificationEmail(
						admin,
						{ displayName: displayName.trim(), email: cleanEmail },
						reviewLink,
						result.invited
					)
				);
			}
		}

		// A duplicate email only gets this far when the code was absent or valid
		// (an invalid code fails above before the email is checked), so the
		// invited flag can come from the form without leaking whether the address
		// has an account.
		return { sent: true, invited: result.ok ? result.invited : inviteCode.trim() !== '' };
	}
};
