import { rateLimit, type RateLimitResult } from './rate-limit';

// Actions that re-verify the account password share one throttle, so a
// borrowed session cannot brute-force the password by spreading guesses
// across the separate actions (change password, change email, disable
// two-factor, regenerate recovery codes, add a passkey, remove a passkey,
// delete the account). 10 attempts per 15 minutes, the way sign-in is.
export const REAUTH_LIMIT = 10;
export const REAUTH_WINDOW_MS = 15 * 60 * 1000;

export function reauthLimit(userId: string): RateLimitResult {
	return rateLimit(`account:reauth:${userId}`, REAUTH_LIMIT, REAUTH_WINDOW_MS);
}
