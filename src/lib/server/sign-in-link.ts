import { eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { users } from './db/schema.ts';
import { consumeToken, NO_USER, reserveToken, revokeTokens } from './tokens.ts';

// Short, because the link signs in on its own: it stands in for the password.
export const SIGN_IN_LINK_TTL_MINUTES = 15;

// The same gates as the password path (verifyCredentials): a link is neither
// sent to nor honoured for an account that could not sign in with a password.
function maySignIn(user: {
	emailVerifiedAt: Date | null;
	approvedAt: Date | null;
	suspendedAt: Date | null;
	deletionScheduledAt: Date | null;
}): boolean {
	return Boolean(
		user.emailVerifiedAt && user.approvedAt && !user.suspendedAt && !user.deletionScheduledAt
	);
}

const GATES = {
	id: users.id,
	emailVerifiedAt: users.emailVerifiedAt,
	approvedAt: users.approvedAt,
	suspendedAt: users.suspendedAt,
	deletionScheduledAt: users.deletionScheduledAt
};

// Reserves a sign-in token for an account that may sign in and returns its id
// for the queued email, or null otherwise. The caller shows the same message
// either way, so it never reveals whether an email is registered.
export async function requestSignInLink(db: Database, email: string): Promise<string | null> {
	const normalized = email.trim().toLowerCase();
	const [user] = await db.select(GATES).from(users).where(eq(users.email, normalized));
	// The same transaction whether or not the address is registered, as for a
	// password reset. Revoking earlier links first keeps only the newest live.
	return await db.transaction(async (tx) => {
		await revokeTokens(tx, user?.id ?? NO_USER, 'sign_in');
		return user && maySignIn(user)
			? reserveToken(tx, user.id, 'sign_in', SIGN_IN_LINK_TTL_MINUTES)
			: null;
	});
}

// Spends a sign-in link and returns the account it proves, or null for a link
// that is unknown, expired, used, or for an account that may no longer sign
// in. The link replaces the password only: the caller still runs the
// two-factor step.
export async function redeemSignInLink(db: Database, token: string): Promise<string | null> {
	const userId = await consumeToken(db, 'sign_in', token);
	if (!userId) return null;
	const [user] = await db.select(GATES).from(users).where(eq(users.id, userId));
	return user && maySignIn(user) ? user.id : null;
}
