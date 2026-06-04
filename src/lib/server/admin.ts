import { count, eq } from 'drizzle-orm';
import type { Database } from './auth';
import { users } from './db/schema';
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
