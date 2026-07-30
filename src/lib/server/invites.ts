import { randomInt } from 'node:crypto';
import { and, count, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { inviteCodes, users } from './db/schema.ts';
import { isUniqueViolation } from './db-errors.ts';

// Invite codes skip the admin approval queue at sign-up. The admin mints a
// code (optionally limited by uses and expiry), shares it, and a sign-up that
// presents it gets approved_at set immediately. Email verification still
// applies, so a leaked code does not bypass that gate.

// Accepts a transaction handle as well as the root database, so a redeem can
// run inside the sign-up transaction.
type DbLike = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

// No 0/O/1/I/L, so a code read out loud or scribbled down survives the trip.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateInviteCode(): string {
	const group = () =>
		Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
	return `${group()}-${group()}-${group()}`;
}

// Codes are stored uppercase; comparison tolerates case and stray whitespace.
export function normalizeInviteCode(input: string): string {
	return input.trim().toUpperCase();
}

export type InviteCode = typeof inviteCodes.$inferSelect;

export async function createInviteCode(
	db: DbLike,
	input: { createdBy: string; label?: string; maxUses?: number; expiresAt?: Date | null }
): Promise<InviteCode> {
	const label = input.label?.trim() || null;
	const maxUses = Math.max(1, Math.floor(input.maxUses ?? 1));
	// A duplicate random code is vanishingly rare; one retry covers it.
	for (let attempt = 0; ; attempt++) {
		try {
			const [row] = await db
				.insert(inviteCodes)
				.values({
					code: generateInviteCode(),
					label,
					createdBy: input.createdBy,
					maxUses,
					expiresAt: input.expiresAt ?? null
				})
				.returning();
			return row;
		} catch (err) {
			const duplicate = isUniqueViolation(err);
			if (!duplicate || attempt >= 2) throw err;
		}
	}
}

export async function listInviteCodes(db: Database): Promise<InviteCode[]> {
	return await db.select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt));
}

export async function deleteInviteCode(db: Database, id: string): Promise<boolean> {
	const [row] = await db
		.delete(inviteCodes)
		.where(eq(inviteCodes.id, id))
		.returning({ id: inviteCodes.id });
	return Boolean(row);
}

// A user's own invites: the admin grants an allowance on the account, and
// each generated code admits one person. Codes count against the allowance
// while they exist, so revoking an unused one frees its slot.

export async function listUserInviteCodes(db: Database, userId: string): Promise<InviteCode[]> {
	return await db
		.select()
		.from(inviteCodes)
		.where(eq(inviteCodes.createdBy, userId))
		.orderBy(desc(inviteCodes.createdAt));
}

/**
 * Generates one single-use code against the user's allowance, or returns null
 * when none is left. The user row is locked so two racing requests cannot
 * both take the last slot.
 */
export async function createUserInvite(db: Database, userId: string): Promise<InviteCode | null> {
	return db.transaction(async (tx) => {
		const [user] = await tx
			.select({ allowance: users.inviteAllowance })
			.from(users)
			.where(eq(users.id, userId))
			.for('update');
		if (!user) return null;
		const [existing] = await tx
			.select({ n: count() })
			.from(inviteCodes)
			.where(eq(inviteCodes.createdBy, userId));
		if (existing.n >= user.allowance) return null;
		return createInviteCode(tx, { createdBy: userId });
	});
}

/** Revokes one of the user's own codes, but never one already used. */
export async function deleteUserInviteCode(
	db: Database,
	userId: string,
	inviteId: string
): Promise<boolean> {
	const [row] = await db
		.delete(inviteCodes)
		.where(
			and(
				eq(inviteCodes.id, inviteId),
				eq(inviteCodes.createdBy, userId),
				eq(inviteCodes.usedCount, 0)
			)
		)
		.returning({ id: inviteCodes.id });
	return Boolean(row);
}

export async function setInviteAllowance(
	db: Database,
	userId: string,
	allowance: number
): Promise<boolean> {
	const value = Math.max(0, Math.floor(allowance));
	const [row] = await db
		.update(users)
		.set({ inviteAllowance: value })
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	return Boolean(row);
}

// Spends one use of a code, returning whether it was valid. The guard and the
// increment are one statement, so two sign-ups racing for the last use cannot
// both win.
export async function redeemInviteCode(db: DbLike, code: string): Promise<boolean> {
	const normalized = normalizeInviteCode(code);
	if (!normalized) return false;
	const [row] = await db
		.update(inviteCodes)
		.set({ usedCount: sql`${inviteCodes.usedCount} + 1` })
		.where(
			and(
				eq(inviteCodes.code, normalized),
				lt(inviteCodes.usedCount, inviteCodes.maxUses),
				or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, sql`now()`))
			)
		)
		.returning({ id: inviteCodes.id });
	return Boolean(row);
}
