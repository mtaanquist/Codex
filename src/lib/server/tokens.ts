import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { authTokens } from './db/schema.ts';

export type TokenKind = 'email_verify' | 'password_reset' | 'deletion_cancel';

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
