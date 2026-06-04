import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { sessions, users } from './db/schema';
import { hashPassword, verifyPassword } from './password';

const MIN_PASSWORD = 8;

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
