import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { sessions, users } from './db/schema';
import { hashPassword, verifyPassword } from './password';
import { consumeToken, issueToken, revokeTokens } from './tokens';
import { isUniqueViolation } from './db-errors.ts';
import { EMAIL_RE } from './signup.ts';

const MIN_PASSWORD = 8;
const EMAIL_CHANGE_TTL_MINUTES = 60 * 24;

export type AccountResult = { ok: true } | { ok: false; reason: string };

// Re-confirms the account password for a sensitive action. Security-relevant
// mutations (change password/email, delete, and turning two-factor off or
// rotating its recovery codes) require it so a bare session is not enough.
export async function verifyAccountPassword(
	db: Database,
	userId: string,
	password: string
): Promise<boolean> {
	const [user] = await db
		.select({ passwordHash: users.passwordHash })
		.from(users)
		.where(eq(users.id, userId));
	return Boolean(user) && verifyPassword(user.passwordHash, password);
}

const MAX_PEN_NAME = 120;
const MAX_DISPLAY_NAME = 120;

// Saves the always-editable identity fields: the required display name and the
// optional pen name (the name stories are published under when it differs).
export async function saveIdentity(
	db: Database,
	userId: string,
	input: { displayName: string; penName: string }
): Promise<AccountResult> {
	// Capped like the pen name: the display name renders on every page that
	// shows the author, so an unbounded value should not reach the database.
	const name = input.displayName.trim().slice(0, MAX_DISPLAY_NAME);
	if (!name) return { ok: false, reason: 'Enter a display name.' };
	const pen = input.penName.trim().slice(0, MAX_PEN_NAME);
	await db
		.update(users)
		.set({ displayName: name, penName: pen || null })
		.where(eq(users.id, userId));
	return { ok: true };
}

export type ProfileLink = { label: string; url: string };

const MAX_LINKS = 8;
const MAX_LINK_LABEL = 60;
const MAX_LINK_URL = 200;

// Normalises the links posted from the profile form (a JSON array, or the
// parsed value). Drops rows with no address, trims and caps lengths, and keeps
// at most a handful. Rendering decides which addresses become live anchors, so
// no scheme check is needed here.
export function parseLinks(raw: unknown): ProfileLink[] {
	let value = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(value)) return [];
	const links: ProfileLink[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== 'object') continue;
		const url = String((item as Record<string, unknown>).url ?? '')
			.trim()
			.slice(0, MAX_LINK_URL);
		// Drop blanks and duplicate addresses; the public page keys on the URL.
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const label = String((item as Record<string, unknown>).label ?? '')
			.trim()
			.slice(0, MAX_LINK_LABEL);
		links.push({ label, url });
		if (links.length >= MAX_LINKS) break;
	}
	return links;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;

// Saves the public-page fields: the bio, external links, commissions state,
// and whether the @handle page is listed publicly. All are stored verbatim;
// the bio and commissions line collapse to null when blank.
export async function saveProfile(
	db: Database,
	userId: string,
	input: {
		bioMd: string;
		profilePublic: boolean;
		links: ProfileLink[];
		commissionsOpen: boolean;
		commissionsMd: string;
	}
): Promise<AccountResult> {
	const bio = input.bioMd.trim();
	const commissions = input.commissionsMd.trim();
	await db
		.update(users)
		.set({
			bioMd: bio || null,
			profilePublic: input.profilePublic,
			links: input.links,
			commissionsOpen: input.commissionsOpen,
			commissionsMd: commissions || null
		})
		.where(eq(users.id, userId));
	return { ok: true };
}

// Claims a public handle. A handle is claimed once and never changed:
// publications carry a denormalised copy and the reader matches on it alone, so
// freeing a handle would serve someone's editions under another name. The
// IS NULL guard makes it write-once.
export async function claimHandle(
	db: Database,
	userId: string,
	rawHandle: string
): Promise<AccountResult> {
	const handle = rawHandle.trim().toLowerCase();
	if (!HANDLE_RE.test(handle)) {
		return { ok: false, reason: 'Handles are 3-30 characters: letters, numbers, and dashes.' };
	}
	try {
		const claimed = await db
			.update(users)
			.set({ handle })
			.where(and(eq(users.id, userId), isNull(users.handle)))
			.returning({ id: users.id });
		if (claimed.length === 0) {
			return { ok: false, reason: 'You already have a handle; it cannot be changed.' };
		}
	} catch (error) {
		if (isUniqueViolation(error)) {
			return { ok: false, reason: 'That handle is taken.' };
		}
		throw error;
	}
	return { ok: true };
}

// Admins grant publishing to other accounts; they can also turn it on for
// their own account here, rather than needing a second admin to do it. A
// regular user still has to be granted publishing by an admin.
export async function enableOwnPublishing(
	db: Database,
	user: { id: string; role: 'admin' | 'user' }
): Promise<AccountResult> {
	if (user.role !== 'admin') {
		return { ok: false, reason: 'Only an admin can enable publishing.' };
	}
	await db.update(users).set({ publicArchiveEnabled: true }).where(eq(users.id, user.id));
	return { ok: true };
}

// Verifies the current password before setting a new one, then revokes every
// other session so a device that still held the old password is signed out.
// The caller's own session is kept so they are not logged out mid-change.
export async function changePassword(
	db: Database,
	userId: string,
	currentSessionId: string,
	currentPassword: string,
	newPassword: string
): Promise<AccountResult> {
	if (newPassword.length < MIN_PASSWORD) {
		return { ok: false, reason: `Use a password of at least ${MIN_PASSWORD} characters.` };
	}
	const [user] = await db
		.select({ passwordHash: users.passwordHash })
		.from(users)
		.where(eq(users.id, userId));
	if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
		return { ok: false, reason: 'That is not your current password.' };
	}
	const passwordHash = await hashPassword(newPassword);
	await db.transaction(async (tx) => {
		// Changing the password also ends any in-flight email change; if it
		// was wanted, requesting it again costs one form.
		await tx.update(users).set({ passwordHash, pendingEmail: null }).where(eq(users.id, userId));
		await revokeTokens(tx, userId, 'email_change');
		// A deliberate password change also kills any outstanding reset links, so
		// one issued before the change cannot take the account over afterwards.
		await revokeTokens(tx, userId, 'password_reset');
		await tx
			.update(sessions)
			.set({ revokedAt: sql`now()` })
			.where(
				and(
					eq(sessions.userId, userId),
					ne(sessions.id, currentSessionId),
					isNull(sessions.revokedAt)
				)
			);
	});
	return { ok: true };
}

export type EmailChangeResult =
	| { ok: true; token: string; newEmail: string }
	| { ok: false; reason: string };

// Begins an email change: verifies the password, checks the address is valid
// and free, records it as pending, and returns a token for the link sent to
// the new address. The live email does not change until the link is confirmed.
export async function requestEmailChange(
	db: Database,
	userId: string,
	currentPassword: string,
	newEmail: string
): Promise<EmailChangeResult> {
	const email = newEmail.trim().toLowerCase();
	if (!EMAIL_RE.test(email)) return { ok: false, reason: 'Enter a valid email address.' };

	const [user] = await db
		.select({ passwordHash: users.passwordHash, email: users.email })
		.from(users)
		.where(eq(users.id, userId));
	if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
		return { ok: false, reason: 'That is not your current password.' };
	}
	if (email === user.email) {
		return { ok: false, reason: 'That is already your email address.' };
	}

	// Do not reveal whether the address already belongs to another account: a
	// distinct "already in use" message turns this into an enumeration oracle.
	// A taken address simply fails at confirmation time (confirmEmailChange
	// catches the unique violation), keeping signup, reset, and change quiet.

	// Revoke any earlier pending change before issuing the new one, so an older
	// link cannot later confirm whatever address is pending at that moment.
	const token = await db.transaction(async (tx) => {
		await revokeTokens(tx, userId, 'email_change');
		await tx.update(users).set({ pendingEmail: email }).where(eq(users.id, userId));
		return issueToken(tx, userId, 'email_change', EMAIL_CHANGE_TTL_MINUTES);
	});
	return { ok: true, token, newEmail: email };
}

// Confirms an email change: swaps the pending address in as the live, verified
// email. Idempotent if the pending address was cleared; reports a collision if
// the address was taken in the meantime.
export async function confirmEmailChange(db: Database, token: string): Promise<AccountResult> {
	const userId = await consumeToken(db, 'email_change', token);
	if (!userId) {
		return { ok: false, reason: 'This confirmation link is not valid or has expired.' };
	}
	const [user] = await db
		.select({ pendingEmail: users.pendingEmail })
		.from(users)
		.where(eq(users.id, userId));
	if (!user?.pendingEmail) return { ok: true };
	try {
		await db
			.update(users)
			.set({ email: user.pendingEmail, pendingEmail: null, emailVerifiedAt: sql`now()` })
			.where(eq(users.id, userId));
		return { ok: true };
	} catch (err) {
		if (isUniqueViolation(err)) {
			await db.update(users).set({ pendingEmail: null }).where(eq(users.id, userId));
			return { ok: false, reason: 'That email address is no longer available.' };
		}
		throw err;
	}
}

export type ActiveSession = {
	id: string;
	createdAt: Date;
	lastSeenAt: Date;
	userAgent: string | null;
	current: boolean;
};

export async function listSessions(
	db: Database,
	userId: string,
	currentSessionId: string
): Promise<ActiveSession[]> {
	const rows = await db
		.select({
			id: sessions.id,
			createdAt: sessions.createdAt,
			lastSeenAt: sessions.lastSeenAt,
			userAgent: sessions.userAgent
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, userId),
				isNull(sessions.revokedAt),
				sql`${sessions.expiresAt} > now()`
			)
		)
		.orderBy(desc(sessions.lastSeenAt));
	return rows.map((row) => ({ ...row, current: row.id === currentSessionId }));
}

// Revokes one of the user's own sessions. Scoped to the user so a guessed id
// from another account cannot be revoked.
export async function revokeOwnSession(
	db: Database,
	userId: string,
	sessionId: string
): Promise<boolean> {
	const [row] = await db
		.update(sessions)
		.set({ revokedAt: sql`now()` })
		.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
		.returning({ id: sessions.id });
	return Boolean(row);
}

// "Sign out everywhere else": revokes all of the user's sessions but the one
// they are using now.
export async function revokeOtherSessions(
	db: Database,
	userId: string,
	currentSessionId: string
): Promise<void> {
	await db
		.update(sessions)
		.set({ revokedAt: sql`now()` })
		.where(
			and(
				eq(sessions.userId, userId),
				ne(sessions.id, currentSessionId),
				isNull(sessions.revokedAt)
			)
		);
}
