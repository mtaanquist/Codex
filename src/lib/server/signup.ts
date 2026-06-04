import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { users } from './db/schema';
import { hashPassword } from './password';
import { consumeToken } from './tokens';

export type RegisterResult =
	| { ok: true; userId: string }
	| { ok: false; reason: string }
	// The email is already in use. Handled like a success by the caller so the
	// page never reveals whether an address has an account.
	| { ok: false; reason: 'duplicate' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export async function registerUser(
	db: Database,
	input: { email: string; password: string; displayName: string }
): Promise<RegisterResult> {
	const email = input.email.trim().toLowerCase();
	const displayName = input.displayName.trim();
	if (!EMAIL_RE.test(email)) return { ok: false, reason: 'Enter a valid email address.' };
	if (input.password.length < MIN_PASSWORD) {
		return { ok: false, reason: `Use a password of at least ${MIN_PASSWORD} characters.` };
	}
	if (!displayName) return { ok: false, reason: 'Enter a display name.' };

	const passwordHash = await hashPassword(input.password);
	try {
		// email_verified_at and approved_at stay null: both gates must clear
		// before sign-in succeeds (see verifyCredentials).
		const [row] = await db
			.insert(users)
			.values({ email, displayName, passwordHash, role: 'user' })
			.returning({ id: users.id });
		return { ok: true, userId: row.id };
	} catch (err) {
		if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
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
