import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { sessions, users } from './db/schema';
import { hashPassword } from './password';
import { consumeToken, issueToken, revokeTokens } from './tokens';

const MIN_PASSWORD = 8;
const RESET_TTL_MINUTES = 60;

// Issues a reset token for an existing account and returns the raw value for
// the emailed link, or null when no account matches. The caller shows the same
// message either way, so it never reveals whether an email is registered.
export async function requestPasswordReset(db: Database, email: string): Promise<string | null> {
	const normalized = email.trim().toLowerCase();
	const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalized));
	if (!user) return null;
	// Revoke any earlier outstanding reset links before issuing the new one, so
	// only the most recent link is ever live (a leaked older one is dead).
	return await db.transaction(async (tx) => {
		await revokeTokens(tx, user.id, 'password_reset');
		return issueToken(tx, user.id, 'password_reset', RESET_TTL_MINUTES);
	});
}

export type ResetResult = { ok: true } | { ok: false; reason: string };

// Sets a new password if the token is valid. The length is checked before the
// token is consumed, so a too-short attempt does not burn the link. On success
// every existing session is revoked, logging out anyone who held the account.
export async function resetPassword(
	db: Database,
	token: string,
	newPassword: string
): Promise<ResetResult> {
	if (newPassword.length < MIN_PASSWORD) {
		return { ok: false, reason: `Use a password of at least ${MIN_PASSWORD} characters.` };
	}
	const userId = await consumeToken(db, 'password_reset', token);
	if (!userId) {
		return {
			ok: false,
			reason: 'This reset link is not valid. It may have expired or already been used.'
		};
	}
	const passwordHash = await hashPassword(newPassword);
	await db.transaction(async (tx) => {
		// A reset is account recovery: any in-flight email change was possibly
		// started by whoever the owner is recovering from, so it dies here too.
		await tx.update(users).set({ passwordHash, pendingEmail: null }).where(eq(users.id, userId));
		await revokeTokens(tx, userId, 'email_change');
		// Any sibling reset links die with this one, so a second outstanding link
		// cannot reset the password again after recovery.
		await revokeTokens(tx, userId, 'password_reset');
		await tx
			.update(sessions)
			.set({ revokedAt: sql`now()` })
			.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
	});
	return { ok: true };
}
