import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sessions, users } from './db/schema.ts';
import type * as schema from './db/schema.ts';
import { verifyPassword } from './password.ts';
import { hashToken } from './tokens.ts';

// The database is passed in rather than imported so the same functions run
// against the app database and the integration tests' throwaway one.
export type Database = NodePgDatabase<typeof schema>;

export const SESSION_COOKIE = 'session';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

// Refresh last_seen_at at most this often, to avoid a write per request.
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

// A valid hash of a throwaway password, verified when the email is unknown so
// that lookups take the same time whether or not the account exists.
const DUMMY_HASH =
	'$argon2id$v=19$m=19456,t=2,p=1$9kz8Iw6tXEkTYPTKrCUt0g$zuCnbUeMW0FRTmdH6eCAKsIQqZg72Sl6chFf/O2cFbw';

export type SessionUser = {
	id: string;
	email: string;
	displayName: string;
	role: 'admin' | 'user';
};

export type CredentialResult =
	| { status: 'ok'; user: SessionUser }
	| { status: 'invalid' }
	| { status: 'unverified' }
	| { status: 'unapproved' }
	| { status: 'suspended' };

export async function verifyCredentials(
	db: Database,
	email: string,
	password: string
): Promise<CredentialResult> {
	const [user] = await db.select().from(users).where(eq(users.email, email));
	if (!user) {
		await verifyPassword(DUMMY_HASH, password);
		return { status: 'invalid' };
	}
	if (!(await verifyPassword(user.passwordHash, password))) {
		return { status: 'invalid' };
	}
	if (!user.emailVerifiedAt) return { status: 'unverified' };
	if (!user.approvedAt) return { status: 'unapproved' };
	// A pending self-deletion deactivates the account the same way a
	// suspension does; the emailed cancellation link is the way back in.
	if (user.suspendedAt || user.deletionScheduledAt) return { status: 'suspended' };
	return {
		status: 'ok',
		user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role }
	};
}

export async function createSession(
	db: Database,
	userId: string,
	meta: { userAgent?: string | null; ip?: string | null } = {}
) {
	// The raw token goes in the cookie; the row keeps only its hash. The returned
	// token is the only time the raw value exists, so the caller must set it now.
	const token = randomBytes(32).toString('base64url');
	const [session] = await db
		.insert(sessions)
		.values({
			userId,
			tokenHash: hashToken(token),
			expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
			userAgent: meta.userAgent ?? null,
			ip: meta.ip ?? null
		})
		.returning();
	await db
		.update(users)
		.set({ lastLoginAt: sql`now()` })
		.where(eq(users.id, userId));
	return { ...session, token };
}

export async function validateSession(db: Database, token: string) {
	// The cookie carries a random token; the lookup is by its hash, so a leaked
	// row cannot be replayed. Any non-matching or empty cookie simply finds no
	// row and reads as no session, which lets the hook clear a stale cookie.
	if (!token) return null;
	const [row] = await db
		.select({ session: sessions, user: users })
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(
			and(
				eq(sessions.tokenHash, hashToken(token)),
				isNull(sessions.revokedAt),
				gt(sessions.expiresAt, sql`now()`)
			)
		);
	if (!row) return null;
	// A suspended or deletion-scheduled account loses its live sessions on
	// the next request.
	if (row.user.suspendedAt || row.user.deletionScheduledAt) return null;

	if (Date.now() - row.session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
		await db
			.update(sessions)
			.set({ lastSeenAt: sql`now()` })
			.where(and(eq(sessions.id, row.session.id), lt(sessions.lastSeenAt, sql`now()`)));
	}

	const user: SessionUser = {
		id: row.user.id,
		email: row.user.email,
		displayName: row.user.displayName,
		role: row.user.role
	};
	return { session: { id: row.session.id, expiresAt: row.session.expiresAt }, user };
}

export async function revokeSession(db: Database, sessionId: string) {
	await db
		.update(sessions)
		.set({ revokedAt: sql`now()` })
		.where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}
