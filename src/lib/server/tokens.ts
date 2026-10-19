import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { authTokens } from './db/schema.ts';

export type TokenKind = 'email_verify' | 'password_reset' | 'deletion_cancel' | 'email_change';

// Only the hash is ever stored, so a leaked database row cannot be turned back
// into a usable link.
export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

// Reserves a single-use token row and returns its id. The row starts with the
// hash of a throwaway value, so it matches no link until armToken gives it one.
// Emailed links are queued by this id and armed in the worker at send time, so
// the raw token never sits in the job queue or its dead-letter queue.
export async function reserveToken(
	db: Database,
	userId: string,
	kind: TokenKind,
	ttlMinutes: number
): Promise<string> {
	const [row] = await db
		.insert(authTokens)
		.values({
			userId,
			kind,
			tokenHash: hashToken(randomBytes(32).toString('base64url')),
			expiresAt: new Date(Date.now() + ttlMinutes * 60_000)
		})
		.returning({ id: authTokens.id });
	return row.id;
}

// Gives a reserved token a fresh raw value and returns it with the token's
// kind, or null when the token was revoked, used, or has expired. Arming again
// (a retried send) replaces the value, so only the last link sent works.
export async function armToken(
	db: Database,
	tokenId: string
): Promise<{ token: string; kind: TokenKind } | null> {
	const token = randomBytes(32).toString('base64url');
	const [row] = await db
		.update(authTokens)
		.set({ tokenHash: hashToken(token) })
		.where(
			and(
				eq(authTokens.id, tokenId),
				isNull(authTokens.consumedAt),
				gt(authTokens.expiresAt, sql`now()`)
			)
		)
		.returning({ kind: authTokens.kind });
	return row ? { token, kind: row.kind } : null;
}

// Issues a token and returns the raw value in one step. Emailed links must not
// use this (reserve and queue the id instead); tests use it to mint a token.
export async function issueToken(
	db: Database,
	userId: string,
	kind: TokenKind,
	ttlMinutes: number
): Promise<string> {
	const armed = await armToken(db, await reserveToken(db, userId, kind, ttlMinutes));
	if (!armed) throw new Error('A token reserved just now could not be armed.');
	return armed.token;
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
