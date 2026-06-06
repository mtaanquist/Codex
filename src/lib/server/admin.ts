import { and, asc, count, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { authTokens, stories, universes, users, userTotp } from './db/schema.ts';
import { hashPassword } from './password.ts';

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

export type AdminUser = {
	id: string;
	email: string;
	displayName: string;
	role: 'admin' | 'user';
	emailVerifiedAt: Date | null;
	approvedAt: Date | null;
	suspendedAt: Date | null;
	deletionScheduledAt: Date | null;
	publicArchiveEnabled: boolean;
	handle: string | null;
	twoFactorEnabled: boolean;
	createdAt: Date;
};

// Every account on the instance, newest first, for the admin accounts list.
export async function listAllUsers(db: Database): Promise<AdminUser[]> {
	return db
		.select({
			id: users.id,
			email: users.email,
			displayName: users.displayName,
			role: users.role,
			emailVerifiedAt: users.emailVerifiedAt,
			approvedAt: users.approvedAt,
			suspendedAt: users.suspendedAt,
			deletionScheduledAt: users.deletionScheduledAt,
			publicArchiveEnabled: users.publicArchiveEnabled,
			handle: users.handle,
			twoFactorEnabled: sql<boolean>`${userTotp.confirmedAt} is not null`,
			createdAt: users.createdAt
		})
		.from(users)
		.leftJoin(userTotp, eq(userTotp.userId, users.id))
		.orderBy(desc(users.createdAt));
}

export type InstanceStats = {
	writers: number;
	pending: number;
	universes: number;
	stories: number;
};

// Headline counts for the admin overview. Active writers are approved and not
// suspended; pending are non-admin accounts still awaiting approval. Universe
// and story counts are instance-wide.
export async function instanceStats(db: Database): Promise<InstanceStats> {
	const [writers] = await db
		.select({ n: count() })
		.from(users)
		.where(
			and(isNotNull(users.approvedAt), isNull(users.suspendedAt), isNull(users.deletionScheduledAt))
		);
	const [pending] = await db
		.select({ n: count() })
		.from(users)
		.where(and(isNull(users.approvedAt), ne(users.role, 'admin')));
	const [universeCount] = await db.select({ n: count() }).from(universes);
	const [storyCount] = await db.select({ n: count() }).from(stories);
	return {
		writers: writers.n,
		pending: pending.n,
		universes: universeCount.n,
		stories: storyCount.n
	};
}

// Enables or disables a user's public archive (their permission to publish).
export async function setUserArchive(
	db: Database,
	userId: string,
	enabled: boolean
): Promise<boolean> {
	const [row] = await db
		.update(users)
		.set({ publicArchiveEnabled: enabled })
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	return Boolean(row);
}

// Suspends or unsuspends an account. Suspending blocks sign-in and drops the
// account's live sessions on their next request; it never touches an admin.
export async function setUserSuspended(
	db: Database,
	userId: string,
	suspended: boolean
): Promise<boolean> {
	const [row] = await db
		.update(users)
		.set({ suspendedAt: suspended ? new Date() : null })
		.where(and(eq(users.id, userId), ne(users.role, 'admin')))
		.returning({ id: users.id });
	return Boolean(row);
}
