import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { sessions, users } from './db/schema';
import { hashPassword, verifyPassword } from './password';
import { consumeToken, issueToken } from './tokens';

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_CHANGE_TTL_MINUTES = 60 * 24;

export type AccountResult = { ok: true } | { ok: false; reason: string };

export async function changeDisplayName(
	db: Database,
	userId: string,
	displayName: string
): Promise<AccountResult> {
	const name = displayName.trim();
	if (!name) return { ok: false, reason: 'Enter a display name.' };
	await db.update(users).set({ displayName: name }).where(eq(users.id, userId));
	return { ok: true };
}

// Verifies the current password before setting a new one, then revokes every
// other session so a device that still held the old password is signed out.
// The caller's own session is kept so they are not logged out mid-change.
export async function changePassword(
	db: Database,
	userId: string,
	currentSessionId: string,
	currentPassword: string,
	newPassword: string
): Promise<AccountResult> {
	if (newPassword.length < MIN_PASSWORD) {
		return { ok: false, reason: `Use a password of at least ${MIN_PASSWORD} characters.` };
	}
	const [user] = await db
		.select({ passwordHash: users.passwordHash })
		.from(users)
		.where(eq(users.id, userId));
	if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
		return { ok: false, reason: 'That is not your current password.' };
	}
	const passwordHash = await hashPassword(newPassword);
	await db.transaction(async (tx) => {
		await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
		await tx
			.update(sessions)
			.set({ revokedAt: sql`now()` })
			.where(
				and(
					eq(sessions.userId, userId),
					ne(sessions.id, currentSessionId),
					isNull(sessions.revokedAt)
				)
			);
	});
	return { ok: true };
}

export type EmailChangeResult =
	| { ok: true; token: string; newEmail: string }
	| { ok: false; reason: string };

// Begins an email change: verifies the password, checks the address is valid
// and free, records it as pending, and returns a token for the link sent to
// the new address. The live email does not change until the link is confirmed.
export async function requestEmailChange(
	db: Database,
	userId: string,
	currentPassword: string,
	newEmail: string
): Promise<EmailChangeResult> {
	const email = newEmail.trim().toLowerCase();
	if (!EMAIL_RE.test(email)) return { ok: false, reason: 'Enter a valid email address.' };

	const [user] = await db
		.select({ passwordHash: users.passwordHash, email: users.email })
		.from(users)
		.where(eq(users.id, userId));
	if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
		return { ok: false, reason: 'That is not your current password.' };
	}
	if (email === user.email) {
		return { ok: false, reason: 'That is already your email address.' };
	}
	const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
	if (taken) return { ok: false, reason: 'That email address is already in use.' };

	await db.update(users).set({ pendingEmail: email }).where(eq(users.id, userId));
	const token = await issueToken(db, userId, 'email_change', EMAIL_CHANGE_TTL_MINUTES);
	return { ok: true, token, newEmail: email };
}

// Confirms an email change: swaps the pending address in as the live, verified
// email. Idempotent if the pending address was cleared; reports a collision if
// the address was taken in the meantime.
export async function confirmEmailChange(db: Database, token: string): Promise<AccountResult> {
	const userId = await consumeToken(db, 'email_change', token);
	if (!userId) {
		return { ok: false, reason: 'This confirmation link is not valid or has expired.' };
	}
	const [user] = await db
		.select({ pendingEmail: users.pendingEmail })
		.from(users)
		.where(eq(users.id, userId));
	if (!user?.pendingEmail) return { ok: true };
	try {
		await db
			.update(users)
			.set({ email: user.pendingEmail, pendingEmail: null, emailVerifiedAt: sql`now()` })
			.where(eq(users.id, userId));
		return { ok: true };
	} catch (err) {
		if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
			await db.update(users).set({ pendingEmail: null }).where(eq(users.id, userId));
			return { ok: false, reason: 'That email address is no longer available.' };
		}
		throw err;
	}
}

export type ActiveSession = {
	id: string;
	createdAt: Date;
	lastSeenAt: Date;
	userAgent: string | null;
	current: boolean;
};

export async function listSessions(
	db: Database,
	userId: string,
	currentSessionId: string
): Promise<ActiveSession[]> {
	const rows = await db
		.select({
			id: sessions.id,
			createdAt: sessions.createdAt,
			lastSeenAt: sessions.lastSeenAt,
			userAgent: sessions.userAgent
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, userId),
				isNull(sessions.revokedAt),
				sql`${sessions.expiresAt} > now()`
			)
		)
		.orderBy(desc(sessions.lastSeenAt));
	return rows.map((row) => ({ ...row, current: row.id === currentSessionId }));
}

// Revokes one of the user's own sessions. Scoped to the user so a guessed id
// from another account cannot be revoked.
export async function revokeOwnSession(
	db: Database,
	userId: string,
	sessionId: string
): Promise<boolean> {
	const [row] = await db
		.update(sessions)
		.set({ revokedAt: sql`now()` })
		.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
		.returning({ id: sessions.id });
	return Boolean(row);
}

// "Sign out everywhere else": revokes all of the user's sessions but the one
// they are using now.
export async function revokeOtherSessions(
	db: Database,
	userId: string,
	currentSessionId: string
): Promise<void> {
	await db
		.update(sessions)
		.set({ revokedAt: sql`now()` })
		.where(
			and(
				eq(sessions.userId, userId),
				ne(sessions.id, currentSessionId),
				isNull(sessions.revokedAt)
			)
		);
}
