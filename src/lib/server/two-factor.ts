import { randomBytes } from 'node:crypto';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { totpRecoveryCodes, userTotp } from './db/schema';
import { decryptSecret, encryptSecret, signToken, verifyToken } from './crypto';
import {
	generateRecoveryCodes,
	generateSecret,
	hashRecoveryCode,
	matchTotpStep,
	otpauthUri
} from './totp';

// Database-facing two-factor logic: enrolment, verification, recovery codes,
// and the short-lived challenge that carries a half-finished sign-in (password
// accepted, code still owed) between the login form and the code prompt.

const ISSUER = 'Codex';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export const TOTP_CHALLENGE_COOKIE = 'totp_challenge';

export type TotpStatus = 'off' | 'pending' | 'on';

export async function totpStatus(
	db: Database,
	userId: string
): Promise<{ status: TotpStatus; confirmedAt: Date | null }> {
	const [row] = await db
		.select({ confirmedAt: userTotp.confirmedAt })
		.from(userTotp)
		.where(eq(userTotp.userId, userId));
	if (!row) return { status: 'off', confirmedAt: null };
	return { status: row.confirmedAt ? 'on' : 'pending', confirmedAt: row.confirmedAt };
}

export async function isTotpEnabled(db: Database, userId: string): Promise<boolean> {
	const [row] = await db
		.select({ userId: userTotp.userId })
		.from(userTotp)
		.where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)));
	return Boolean(row);
}

// Starts (or restarts) enrolment: stores a fresh encrypted secret, unconfirmed,
// and returns it with the otpauth URI for the QR code. Refused if two-factor is
// already on, so an active secret is never silently replaced.
export async function beginEnrollment(
	db: Database,
	userId: string,
	accountEmail: string
): Promise<{ ok: true; secret: string; otpauthUri: string } | { ok: false; reason: string }> {
	if (await isTotpEnabled(db, userId)) {
		return { ok: false, reason: 'Two-factor authentication is already on.' };
	}
	const secret = generateSecret();
	const encrypted = encryptSecret(secret);
	await db
		.insert(userTotp)
		.values({ userId, secret: encrypted })
		.onConflictDoUpdate({
			target: userTotp.userId,
			set: { secret: encrypted, confirmedAt: null, lastUsedAt: null, createdAt: sql`now()` }
		});
	return { ok: true, secret, otpauthUri: otpauthUri(secret, accountEmail, ISSUER) };
}

// The in-progress enrolment's secret and otpauth URI, so the setup screen can
// redraw the QR while confirmation is still pending. Null once confirmed or if
// setup never started.
export async function pendingEnrollment(
	db: Database,
	userId: string,
	accountEmail: string
): Promise<{ secret: string; otpauthUri: string } | null> {
	const [row] = await db
		.select()
		.from(userTotp)
		.where(and(eq(userTotp.userId, userId), isNull(userTotp.confirmedAt)));
	if (!row) return null;
	const secret = decryptSecret(row.secret);
	return { secret, otpauthUri: otpauthUri(secret, accountEmail, ISSUER) };
}

// Confirms enrolment with a code from the app, turning two-factor on and
// issuing the recovery codes (returned once, in the clear, to show the user).
// One-shot: it only acts on an unconfirmed row, so a double-submit cannot
// rotate the recovery codes out from under a user who copied the first set.
export async function confirmEnrollment(
	db: Database,
	userId: string,
	code: string
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; reason: string }> {
	const [row] = await db
		.select()
		.from(userTotp)
		.where(and(eq(userTotp.userId, userId), isNull(userTotp.confirmedAt)));
	if (!row) return { ok: false, reason: 'Start setup again.' };
	const step = matchTotpStep(decryptSecret(row.secret), code);
	if (step === null) {
		return { ok: false, reason: 'That code is not right. Check your app and try again.' };
	}
	const recoveryCodes = generateRecoveryCodes();
	await db.transaction(async (tx) => {
		// The confirming code's step is recorded so it cannot be replayed at the
		// next sign-in.
		await tx
			.update(userTotp)
			.set({ confirmedAt: sql`now()`, lastUsedAt: sql`now()`, lastUsedStep: step })
			.where(eq(userTotp.userId, userId));
		await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));
		await tx
			.insert(totpRecoveryCodes)
			.values(recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
	});
	return { ok: true, recoveryCodes };
}

// Verifies a code against the confirmed secret (sign-in challenge). Single-use:
// the matched step must be higher than the last one accepted, and the gate is
// the UPDATE's WHERE so two parallel sign-ins cannot both spend the same code.
export async function verifyUserTotp(db: Database, userId: string, code: string): Promise<boolean> {
	const [row] = await db
		.select()
		.from(userTotp)
		.where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)));
	if (!row) return false;
	const step = matchTotpStep(decryptSecret(row.secret), code);
	if (step === null) return false;
	const [updated] = await db
		.update(userTotp)
		.set({ lastUsedAt: sql`now()`, lastUsedStep: step })
		.where(
			and(
				eq(userTotp.userId, userId),
				or(isNull(userTotp.lastUsedStep), lt(userTotp.lastUsedStep, step))
			)
		)
		.returning({ userId: userTotp.userId });
	return Boolean(updated);
}

// Spends a recovery code if it matches an unused one. The update's WHERE does
// the matching atomically, so the same code cannot be used twice.
export async function consumeRecoveryCode(
	db: Database,
	userId: string,
	code: string
): Promise<boolean> {
	const [row] = await db
		.update(totpRecoveryCodes)
		.set({ usedAt: sql`now()` })
		.where(
			and(
				eq(totpRecoveryCodes.userId, userId),
				eq(totpRecoveryCodes.codeHash, hashRecoveryCode(code)),
				isNull(totpRecoveryCodes.usedAt)
			)
		)
		.returning({ id: totpRecoveryCodes.id });
	return Boolean(row);
}

export async function recoveryCodesRemaining(db: Database, userId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(totpRecoveryCodes)
		.where(and(eq(totpRecoveryCodes.userId, userId), isNull(totpRecoveryCodes.usedAt)));
	return row?.n ?? 0;
}

// Replaces every recovery code with a fresh set, invalidating the old ones.
export async function regenerateRecoveryCodes(
	db: Database,
	userId: string
): Promise<string[] | null> {
	if (!(await isTotpEnabled(db, userId))) return null;
	const recoveryCodes = generateRecoveryCodes();
	await db.transaction(async (tx) => {
		await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));
		await tx
			.insert(totpRecoveryCodes)
			.values(recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
	});
	return recoveryCodes;
}

// Turns two-factor off entirely. Used by the account owner and by an admin
// resetting a locked-out user.
// Abandons an UNCONFIRMED enrolment only: the scope on confirmed_at is the
// server-side guard, so this can never strip live two-factor (that path is
// disableTotp, behind a password re-check). Returns whether a pending row
// was actually cleared.
export async function cancelPendingEnrollment(db: Database, userId: string): Promise<boolean> {
	const cleared = await db
		.delete(userTotp)
		.where(and(eq(userTotp.userId, userId), isNull(userTotp.confirmedAt)))
		.returning({ userId: userTotp.userId });
	return cleared.length > 0;
}

export async function disableTotp(db: Database, userId: string): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));
		await tx.delete(userTotp).where(eq(userTotp.userId, userId));
	});
}

// A signed, ten-minute token standing in for "this user cleared the password
// step and still owes a code". It carries the user id, an expiry, and a random
// nonce stored server-side; the signature stops forgery, and the nonce makes
// the challenge single-use: a new password step overwrites it (killing any
// earlier challenge) and accepting a code clears it (so a captured cookie
// cannot be replayed).
export async function issueTotpChallenge(db: Database, userId: string): Promise<string> {
	const nonce = randomBytes(18).toString('base64url');
	await db.update(userTotp).set({ challenge: nonce }).where(eq(userTotp.userId, userId));
	return signToken(`${userId}.${Date.now() + CHALLENGE_TTL_MS}.${nonce}`);
}

function parseTotpChallenge(token: string | undefined): { userId: string; nonce: string } | null {
	if (!token) return null;
	const payload = verifyToken(token);
	if (!payload) return null;
	const parts = payload.split('.');
	if (parts.length !== 3) return null;
	const [userId, expiresAt, nonce] = parts;
	if (!userId || !nonce) return null;
	if (!Number.isFinite(Number(expiresAt)) || Date.now() > Number(expiresAt)) return null;
	return { userId, nonce };
}

// The unprivileged check the code-prompt page uses to decide whether to render:
// signature and expiry only, no database round-trip and no consumption.
export function readTotpChallenge(token: string | undefined): string | null {
	return parseTotpChallenge(token)?.userId ?? null;
}

// Spends the challenge once a code has been accepted: the nonce must still match
// the one stored for the user, and it is cleared in the same statement so the
// cookie cannot be used a second time. Returns the user id, or null if the
// challenge was already spent or superseded by a newer one.
export async function consumeTotpChallenge(
	db: Database,
	token: string | undefined
): Promise<string | null> {
	const parsed = parseTotpChallenge(token);
	if (!parsed) return null;
	const [row] = await db
		.update(userTotp)
		.set({ challenge: null })
		.where(and(eq(userTotp.userId, parsed.userId), eq(userTotp.challenge, parsed.nonce)))
		.returning({ userId: userTotp.userId });
	return row?.userId ?? null;
}

// Validates the challenge cookie without spending it, so the caller can reject
// a stale or replayed cookie before consuming a single-use recovery code. The
// real consume still happens after the code is verified.
export async function peekTotpChallenge(
	db: Database,
	token: string | undefined
): Promise<string | null> {
	const parsed = parseTotpChallenge(token);
	if (!parsed) return null;
	const [row] = await db
		.select({ userId: userTotp.userId })
		.from(userTotp)
		.where(and(eq(userTotp.userId, parsed.userId), eq(userTotp.challenge, parsed.nonce)));
	return row?.userId ?? null;
}
