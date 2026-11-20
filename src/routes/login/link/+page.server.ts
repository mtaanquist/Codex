import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { users } from '#lib/server/db/schema';
import { publicOrigin } from '#lib/server/origin';
import { queueEmail } from '#lib/server/jobs';
import { rateLimit } from '#lib/server/rate-limit';
import { logEvent } from '#lib/server/log';
import { continueSignIn } from '#lib/server/sign-in';
import {
	redeemSignInLink,
	requestSignInLink,
	SIGN_IN_LINK_TTL_MINUTES
} from '#lib/server/sign-in-link';
import { peekToken } from '#lib/server/tokens';
import { formText } from '#lib/server/validation';

// Per-address, so link mail to one inbox cannot be triggered repeatedly, and
// per IP so one host cannot mass-mail distinct addresses (as for a password
// reset).
const SEND_LIMIT = 5;
const SEND_IP_LIMIT = 20;
const SEND_WINDOW_MS = 15 * 60 * 1000;
// Using a link draws on the same per-IP budget as the password step in
// ../+page.server.ts: both are sign-in attempts.
const LOGIN_IP_LIMIT = 50;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

const INVALID =
	'This sign-in link is not valid. It may have expired or already been used. Ask for a new one below.';

// With a token, the page offers a button that signs in; the link itself only
// peeks, so an email scanner that opens it cannot spend it. Without one (or
// with a dead one), the page asks for an email address to send a link to.
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token') ?? '';
	const userId = token === '' ? null : await peekToken(db, 'sign_in', token);
	const valid = userId !== null;
	// Shown beside the button, so a link passed on by someone else cannot sign
	// the reader in to an account they do not expect.
	const [account] = userId
		? await db.select({ email: users.email }).from(users).where(eq(users.id, userId))
		: [];
	return {
		token: valid ? token : '',
		email: account?.email ?? '',
		message: token !== '' && !valid ? INVALID : null,
		minutes: SIGN_IN_LINK_TTL_MINUTES
	};
};

export const actions: Actions = {
	send: async ({ request, url, getClientAddress }) => {
		const data = await request.formData();
		const email = formText(data, 'email').trim().toLowerCase();

		// On the limit, return the same response without mailing, keeping the
		// reply identical whether or not the address has an account.
		const overLimit =
			!rateLimit(`sign_in_link:ip:${getClientAddress()}`, SEND_IP_LIMIT, SEND_WINDOW_MS).allowed ||
			(email && !rateLimit(`sign_in_link:${email}`, SEND_LIMIT, SEND_WINDOW_MS).allowed);
		if (overLimit) {
			logEvent('warn', 'sign_in_link.rate_limited', { email });
			return { sent: true };
		}

		const tokenId = await requestSignInLink(db, email);
		if (tokenId) await queueEmail({ tokenId, to: email, origin: publicOrigin(url) });

		// Always the same response, whether or not the address has an account.
		return { sent: true };
	},

	use: async ({ request, cookies, getClientAddress }) => {
		const data = await request.formData();
		const token = formText(data, 'token');

		if (!rateLimit(`login:ip:${getClientAddress()}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS).allowed) {
			logEvent('warn', 'login.rate_limited', { via: 'link' });
			return fail(429, {
				message: 'Too many sign-in attempts. Wait a few minutes and try again.'
			});
		}

		const userId = token ? await redeemSignInLink(db, token) : null;
		if (!userId) {
			logEvent('info', 'login.failed', { via: 'link' });
			return fail(400, { message: INVALID });
		}
		redirect(303, await continueSignIn(db, userId, { request, cookies, getClientAddress }, 'link'));
	}
};
