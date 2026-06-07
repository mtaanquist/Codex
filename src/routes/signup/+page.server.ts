import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/signup';
import { signupMode } from '$lib/server/settings';
import { issueToken } from '$lib/server/tokens';
import { queueEmail } from '$lib/server/jobs';
import { verificationEmail } from '$lib/server/email';
import { notifyAdmins } from '$lib/server/notify';
import { rateLimit } from '$lib/server/rate-limit';
import { logEvent } from '$lib/server/log';

const VERIFY_TTL_MINUTES = 60 * 24;
// Per-address, so repeated sign-ups for one email cannot bomb it with
// verification mail; a legitimate sign-up happens once.
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

// An invite link (/signup?code=...) prefills the code field. The mode decides
// which face the page shows: closed, code required, or the form.
export const load: PageServerLoad = async ({ url }) => {
	return {
		mode: await signupMode(db),
		prefillCode: url.searchParams.get('code') ?? ''
	};
};

export const actions: Actions = {
	default: async ({ request, url }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const password = String(data.get('password') ?? '');
		const displayName = String(data.get('displayName') ?? '');
		const inviteCode = String(data.get('inviteCode') ?? '');
		const cleanEmail = email.trim().toLowerCase();
		const mode = await signupMode(db);
		// Whether this sign-up waits in the approval queue. Derived from the
		// form rather than the result so a duplicate email renders the same
		// page as a fresh account.
		const pendingApproval = mode === 'approval' && inviteCode.trim() === '';

		// On the limit, return the same response without registering or mailing,
		// so the page still reveals nothing about whether the address is taken.
		if (cleanEmail && !rateLimit(`signup:${cleanEmail}`, SIGNUP_LIMIT, SIGNUP_WINDOW_MS).allowed) {
			logEvent('warn', 'signup.rate_limited', { email: cleanEmail });
			return { sent: true, pendingApproval };
		}

		const result = await registerUser(db, { email, password, displayName, inviteCode }, mode);

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

			// Let the admins know there is someone to review (or that someone
			// joined, on an invite or an open instance). Goes through the
			// notification matrix: the bell always, email per preference.
			await notifyAdmins(db, 'account_pending', {
				title: result.invited
					? `${displayName.trim()} joined with an invite code`
					: result.approved
						? `${displayName.trim()} created an account`
						: `${displayName.trim()} signed up and waits for approval`,
				detail: cleanEmail,
				href: '/admin?section=users'
			});
		}

		return { sent: true, pendingApproval };
	}
};
