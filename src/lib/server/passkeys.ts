import { and, desc, eq, sql } from 'drizzle-orm';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
	type WebAuthnCredential
} from '@simplewebauthn/server';
import type { CredentialResult, Database } from './auth';
import { users, webauthnCredentials } from './db/schema';
import { signToken, verifyToken } from './crypto';
import { isUniqueViolation } from './db-errors.ts';

// Passkeys (WebAuthn). Registration runs from the account page; sign-in is
// usernameless: the browser presents a discoverable credential and the
// stored row says whose it is. A passkey with user verification proves
// possession plus a local biometric or PIN, so passkey sign-in does not ask
// for a TOTP code on top. The cryptography lives in @simplewebauthn/server;
// this module owns the challenge lifecycle and the rows.

const RP_NAME = 'Codex';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export const PASSKEY_CHALLENGE_COOKIE = 'passkey_challenge';

export function passkeyRpId(origin: string): string {
	return new URL(origin).hostname;
}

// The challenge travels in a signed, short-lived cookie, bound to its purpose
// (and, for registration, the signing-in user) so one flow's challenge cannot
// be replayed into the other.
function issueChallengeToken(
	purpose: 'register' | 'signin',
	challenge: string,
	userId = ''
): string {
	return signToken(`${purpose}.${userId}.${challenge}.${Date.now() + CHALLENGE_TTL_MS}`);
}

function readChallengeToken(
	token: string | undefined,
	purpose: 'register' | 'signin',
	userId = ''
): string | null {
	if (!token) return null;
	const payload = verifyToken(token);
	if (!payload) return null;
	const [gotPurpose, gotUserId, challenge, expiresAt] = payload.split('.');
	if (gotPurpose !== purpose || gotUserId !== userId) return null;
	if (!Number.isFinite(Number(expiresAt)) || Date.now() > Number(expiresAt)) return null;
	return challenge || null;
}

export async function startPasskeyRegistration(
	db: Database,
	user: { id: string; email: string; displayName: string },
	origin: string
) {
	const existing = await db
		.select({ credentialId: webauthnCredentials.credentialId })
		.from(webauthnCredentials)
		.where(eq(webauthnCredentials.userId, user.id));
	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: passkeyRpId(origin),
		userName: user.email,
		userDisplayName: user.displayName,
		attestationType: 'none',
		excludeCredentials: existing.map((row) => ({ id: row.credentialId })),
		authenticatorSelection: {
			// Discoverable, so the sign-in button can work without an email; user
			// verification required, since passkey sign-in stands in for 2FA.
			residentKey: 'required',
			userVerification: 'required'
		}
	});
	return { options, challengeToken: issueChallengeToken('register', options.challenge, user.id) };
}

export async function finishPasskeyRegistration(
	db: Database,
	userId: string,
	response: RegistrationResponseJSON,
	challengeToken: string | undefined,
	origin: string,
	name: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const expectedChallenge = readChallengeToken(challengeToken, 'register', userId);
	if (!expectedChallenge) {
		return { ok: false, reason: 'The registration timed out. Start again.' };
	}
	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response,
			expectedChallenge,
			expectedOrigin: origin,
			expectedRPID: passkeyRpId(origin),
			requireUserVerification: true
		});
	} catch {
		return { ok: false, reason: 'That passkey could not be verified.' };
	}
	if (!verification.verified || !verification.registrationInfo) {
		return { ok: false, reason: 'That passkey could not be verified.' };
	}
	const { credential } = verification.registrationInfo;
	try {
		await db.insert(webauthnCredentials).values({
			userId,
			credentialId: credential.id,
			publicKey: Buffer.from(credential.publicKey).toString('base64url'),
			signCount: credential.counter,
			transports: credential.transports ?? null,
			name: name.trim() || null
		});
	} catch (err) {
		if (isUniqueViolation(err)) {
			return { ok: false, reason: 'That passkey is already registered.' };
		}
		throw err;
	}
	return { ok: true };
}

export async function startPasskeySignIn(origin: string) {
	const options = await generateAuthenticationOptions({
		rpID: passkeyRpId(origin),
		userVerification: 'required'
	});
	return { options, challengeToken: issueChallengeToken('signin', options.challenge) };
}

// Verifies a sign-in assertion and applies the same account gates as the
// password path. 'invalid' covers an unknown credential, a bad signature,
// and a stale challenge alike; the page shows one message for all three.
export async function finishPasskeySignIn(
	db: Database,
	response: AuthenticationResponseJSON,
	challengeToken: string | undefined,
	origin: string
): Promise<CredentialResult> {
	const expectedChallenge = readChallengeToken(challengeToken, 'signin');
	if (!expectedChallenge) return { status: 'invalid' };

	const [row] = await db
		.select({ credential: webauthnCredentials, user: users })
		.from(webauthnCredentials)
		.innerJoin(users, eq(webauthnCredentials.userId, users.id))
		.where(eq(webauthnCredentials.credentialId, response.id));
	if (!row) return { status: 'invalid' };

	const credential: WebAuthnCredential = {
		id: row.credential.credentialId,
		publicKey: new Uint8Array(Buffer.from(row.credential.publicKey, 'base64url')),
		counter: row.credential.signCount,
		transports: (row.credential.transports ?? undefined) as WebAuthnCredential['transports']
	};
	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge,
			expectedOrigin: origin,
			expectedRPID: passkeyRpId(origin),
			credential,
			requireUserVerification: true
		});
	} catch {
		return { status: 'invalid' };
	}
	if (!verification.verified) return { status: 'invalid' };

	await db
		.update(webauthnCredentials)
		.set({ signCount: verification.authenticationInfo.newCounter, lastUsedAt: sql`now()` })
		.where(eq(webauthnCredentials.id, row.credential.id));

	if (!row.user.emailVerifiedAt) return { status: 'unverified' };
	if (!row.user.approvedAt) return { status: 'unapproved' };
	// Same gates as the password path: admin suspension or a pending
	// self-deletion both deactivate the account.
	if (row.user.suspendedAt || row.user.deletionScheduledAt) return { status: 'suspended' };
	return {
		status: 'ok',
		user: {
			id: row.user.id,
			email: row.user.email,
			displayName: row.user.displayName,
			role: row.user.role
		}
	};
}

export async function listPasskeys(db: Database, userId: string) {
	return await db
		.select({
			id: webauthnCredentials.id,
			name: webauthnCredentials.name,
			createdAt: webauthnCredentials.createdAt,
			lastUsedAt: webauthnCredentials.lastUsedAt
		})
		.from(webauthnCredentials)
		.where(eq(webauthnCredentials.userId, userId))
		.orderBy(desc(webauthnCredentials.createdAt));
}

export async function removePasskey(db: Database, userId: string, id: string): Promise<boolean> {
	const removed = await db
		.delete(webauthnCredentials)
		.where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
		.returning({ id: webauthnCredentials.id });
	return removed.length > 0;
}
