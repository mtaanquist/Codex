import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { users } from './db/schema.ts';
import { hashPassword } from './password.ts';
import { consumeToken } from './tokens.ts';
import { redeemInviteCode } from './invites.ts';
import type { SignupMode } from './settings.ts';
import { isUniqueViolation } from './db-errors.ts';

export type RegisterResult =
	// invited: a valid invite code was spent. approved: the account skipped
	// the approval queue (an invite did it, or the instance is open).
	| { ok: true; userId: string; invited: boolean; approved: boolean }
	| { ok: false; reason: string }
	// The email is already in use. Handled like a success by the caller so the
	// page never reveals whether an address has an account.
	| { ok: false; reason: 'duplicate' };

export const INVALID_INVITE = 'That invite code is not valid. Check it and try again.';
export const INVITE_REQUIRED = 'An invite code is needed to create an account here.';
export const SIGNUPS_CLOSED = 'This Codex is not taking new accounts.';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export async function registerUser(
	db: Database,
	input: { email: string; password: string; displayName: string; inviteCode?: string },
	mode: SignupMode = 'approval'
): Promise<RegisterResult> {
	if (mode === 'none') return { ok: false, reason: SIGNUPS_CLOSED };
	const email = input.email.trim().toLowerCase();
	const displayName = input.displayName.trim();
	if (!EMAIL_RE.test(email)) return { ok: false, reason: 'Enter a valid email address.' };
	if (input.password.length < MIN_PASSWORD) {
		return { ok: false, reason: `Use a password of at least ${MIN_PASSWORD} characters.` };
	}
	if (!displayName) return { ok: false, reason: 'Enter a display name.' };

	const passwordHash = await hashPassword(input.password);
	// On an open instance a code buys nothing, so one that rides in on an old
	// invite link is ignored rather than spent.
	const inviteCode = mode === 'open' ? '' : (input.inviteCode?.trim() ?? '');
	if (mode === 'invite' && inviteCode === '') return { ok: false, reason: INVITE_REQUIRED };
	try {
		// One transaction: a bad code creates no account, and a duplicate email
		// rolls the redeemed use back, so probing emails cannot burn a code.
		return await db.transaction(async (tx): Promise<RegisterResult> => {
			const invited = inviteCode !== '' && (await redeemInviteCode(tx, inviteCode));
			if (inviteCode !== '' && !invited) return { ok: false, reason: INVALID_INVITE };
			// email_verified_at stays null until the emailed link is clicked, and
			// approved_at stays null unless something cleared the queue: both
			// gates must pass before sign-in succeeds (see verifyCredentials).
			const approved = invited || mode === 'open';
			const [row] = await tx
				.insert(users)
				.values({
					email,
					displayName,
					passwordHash,
					role: 'user',
					approvedAt: approved ? sql`now()` : null
				})
				.returning({ id: users.id });
			return { ok: true, userId: row.id, invited, approved };
		});
	} catch (err) {
		if (isUniqueViolation(err)) {
			return { ok: false, reason: 'duplicate' };
		}
		throw err;
	}
}

// Marks the account's email confirmed if the token is valid. Idempotent: a
// second valid token (or a re-click) leaves an already-verified account as is.
export async function verifyEmail(db: Database, token: string): Promise<boolean> {
	const userId = await consumeToken(db, 'email_verify', token);
	if (!userId) return false;
	await db
		.update(users)
		.set({ emailVerifiedAt: sql`now()` })
		.where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
	return true;
}
