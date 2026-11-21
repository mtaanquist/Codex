import type { Cookies } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE, type Database } from './auth.ts';
import { logEvent } from './log.ts';
import { takeReturnTo } from './return-to.ts';
import { isTotpEnabled, issueTotpChallenge, TOTP_CHALLENGE_COOKIE } from './two-factor.ts';

const CHALLENGE_MAX_AGE_SECONDS = 10 * 60;

// The rest of a sign-in once the first factor (the password, or an emailed
// link) has checked out. With two-factor on, that factor is only half: a signed
// challenge goes in a short-lived cookie and a code is asked for before any
// session exists. Returns where to send the browser next: the two-factor
// step, a page that was waiting on the sign-in (see return-to.ts), or home.
export async function continueSignIn(
	db: Database,
	userId: string,
	event: { request: Request; cookies: Cookies; getClientAddress: () => string },
	via: 'password' | 'link'
): Promise<string> {
	const { request, cookies, getClientAddress } = event;
	if (await isTotpEnabled(db, userId)) {
		cookies.set(TOTP_CHALLENGE_COOKIE, await issueTotpChallenge(db, userId), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: CHALLENGE_MAX_AGE_SECONDS
		});
		return '/login/totp';
	}
	const session = await createSession(db, userId, {
		userAgent: request.headers.get('user-agent'),
		ip: getClientAddress()
	});
	logEvent('info', 'login.ok', { userId, via });
	cookies.set(SESSION_COOKIE, session.token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		expires: session.expiresAt
	});
	return takeReturnTo(cookies) ?? '/';
}
