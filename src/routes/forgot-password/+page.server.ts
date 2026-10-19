import { publicOrigin } from '$lib/server/origin';
import type { Actions } from './$types';
import { db } from '$lib/server/db';
import { requestPasswordReset } from '$lib/server/password-reset';
import { queueEmail } from '$lib/server/jobs';
import { rateLimit } from '$lib/server/rate-limit';
import { logEvent } from '$lib/server/log';

// Per-address, so reset mail to one inbox cannot be triggered repeatedly. The
// per-IP tier stops one host mass-mailing distinct addresses, the way login is
// throttled per IP as well as per email.
const RESET_LIMIT = 5;
const RESET_IP_LIMIT = 20;
const RESET_WINDOW_MS = 15 * 60 * 1000;

export const actions: Actions = {
	default: async ({ request, url, getClientAddress }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '')
			.trim()
			.toLowerCase();

		// On the limit, return the same response without mailing, keeping the
		// reply identical whether or not the address has an account.
		const overLimit =
			!rateLimit(`reset:ip:${getClientAddress()}`, RESET_IP_LIMIT, RESET_WINDOW_MS).allowed ||
			(email && !rateLimit(`reset:${email}`, RESET_LIMIT, RESET_WINDOW_MS).allowed);
		if (overLimit) {
			logEvent('warn', 'password_reset.rate_limited', { email });
			return { sent: true };
		}

		const tokenId = await requestPasswordReset(db, email);
		if (tokenId) await queueEmail({ tokenId, to: email, origin: publicOrigin(url) });

		// Always the same response, whether or not the address has an account.
		return { sent: true };
	}
};
