import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { authTokens } from './db/schema.ts';

export type TokenKind = 'email_verify' | 'password_reset' | 'deletion_cancel' | 'email_change';

// Only the hash is ever stored, so a leaked database row cannot be turned back
// into a usable link.
export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

// Issues a single-use token of the given kind and returns the raw value to put
// in the emailed link; the row keeps only its hash and an expiry.
export async function issueToken(
	db: Database,
	userId: string,
	kind: TokenKind,
	ttlMinutes: number
): Promise<string> {
	const token = randomBytes(32).toString('base64url');
	await db.insert(authTokens).values({
		userId,
		kind,
		tokenHash: hashToken(token),
		expiresAt: new Date(Date.now() + ttlMinutes * 60_000)
	});
	return token;
}

// Checks a token without spending it: valid, unexpired, unconsumed. The
// confirmation pages peek on GET and only consume on the POSTed confirm, so
// an email link-scanner's prefetch cannot burn or trigger the action.
export async function peekToken(
	db: Database,
	kind: TokenKind,
	token: string
): Promise<string | null> {
	const [row] = await db
		.select({ userId: authTokens.userId })
		.from(authTokens)
		.where(
			and(
				eq(authTokens.tokenHash, hashToken(token)),
				eq(authTokens.kind, kind),
				isNull(authTokens.consumedAt),
				gt(authTokens.expiresAt, sql`now()`)
			)
		);
	return row?.userId ?? null;
}

// Revokes every outstanding token of one kind for a user, e.g. a pending
// email change when the password is reset.
export async function revokeTokens(db: Database, userId: string, kind: TokenKind): Promise<void> {
	await db
		.update(authTokens)
		.set({ consumedAt: sql`now()` })
		.where(
			and(eq(authTokens.userId, userId), eq(authTokens.kind, kind), isNull(authTokens.consumedAt))
		);
}

// Consumes a token, returning its user id when it is valid, unexpired, and
// unused. The consume is the same statement as the lookup, so a token cannot
// be replayed even under a race: the second caller matches no unconsumed row.
export async function consumeToken(
	db: Database,
	kind: TokenKind,
	token: string
): Promise<string | null> {
	const [row] = await db
		.update(authTokens)
		.set({ consumedAt: sql`now()` })
		.where(
			and(
				eq(authTokens.tokenHash, hashToken(token)),
				eq(authTokens.kind, kind),
				isNull(authTokens.consumedAt),
				gt(authTokens.expiresAt, sql`now()`)
			)
		)
		.returning({ userId: authTokens.userId });
	return row?.userId ?? null;
}
