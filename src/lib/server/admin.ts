import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from './auth';
import { authTokens, users } from './db/schema';
import { hashPassword } from './password';

export type CreateAdminResult = { ok: true; id: string } | { ok: false; reason: string };

// Creates the first site admin, pre-verified and pre-approved so it can sign
// in before the email-verification and approval gates apply to everyone else.
// A one-shot bootstrap: once any admin exists it refuses, since further admins
// are managed from inside the app.
export async function createFirstAdmin(
	db: Database,
	input: { email: string; password: string; displayName: string }
): Promise<CreateAdminResult> {
	const email = input.email.trim().toLowerCase();
	const displayName = input.displayName.trim();
	if (!email || !input.password || !displayName) {
		return { ok: false, reason: 'Email, password, and display name are all required.' };
	}

	const [{ admins }] = await db
		.select({ admins: count() })
		.from(users)
		.where(eq(users.role, 'admin'));
	if (admins > 0) {
		return {
			ok: false,
			reason: 'An admin already exists. Manage further admins from inside the app.'
		};
	}

	const passwordHash = await hashPassword(input.password);
	try {
		const now = new Date();
		const [row] = await db
			.insert(users)
			.values({
				email,
				displayName,
				passwordHash,
				role: 'admin',
				emailVerifiedAt: now,
				approvedAt: now
			})
			.returning({ id: users.id });
		return { ok: true, id: row.id };
	} catch (err) {
		// 23505: another account already uses this email. Drizzle wraps the
		// driver error, so the code sits on the cause.
		if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
			return { ok: false, reason: 'An account with that email already exists.' };
		}
		throw err;
	}
}

export type PendingUser = {
	id: string;
	email: string;
	displayName: string;
	emailVerifiedAt: Date | null;
	createdAt: Date;
};

// Accounts waiting on the operator: signed up but not yet approved. Verified
// or not is surfaced so the operator can see who has confirmed their email.
export async function listPendingUsers(db: Database): Promise<PendingUser[]> {
	return db
		.select({
			id: users.id,
			email: users.email,
			displayName: users.displayName,
			emailVerifiedAt: users.emailVerifiedAt,
			createdAt: users.createdAt
		})
		.from(users)
		.where(and(isNull(users.approvedAt), ne(users.role, 'admin')))
		.orderBy(asc(users.createdAt));
}

// Approves a pending account. Scoped to still-pending non-admin rows so a
// double-click or a stale form cannot re-approve or touch an admin.
export async function approveUser(db: Database, userId: string): Promise<boolean> {
	const [row] = await db
		.update(users)
		.set({ approvedAt: new Date() })
		.where(and(eq(users.id, userId), isNull(users.approvedAt), ne(users.role, 'admin')))
		.returning({ id: users.id });
	return Boolean(row);
}

// Rejects a pending account by deleting it. Only ever a brand-new sign-up with
// no content of its own; its outstanding tokens go first to clear the foreign
// key. Refuses to delete an already-approved account or an admin.
export async function rejectUser(db: Database, userId: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [pending] = await tx
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.id, userId), isNull(users.approvedAt), ne(users.role, 'admin')));
		if (!pending) return false;
		await tx.delete(authTokens).where(eq(authTokens.userId, userId));
		await tx.delete(users).where(eq(users.id, userId));
		return true;
	});
}

// Admin addresses to notify when someone signs up.
export async function adminEmails(db: Database): Promise<string[]> {
	const rows = await db.select({ email: users.email }).from(users).where(eq(users.role, 'admin'));
	return rows.map((row) => row.email);
}
