import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { apiTokens, oauthClients, oauthCodes, oauthGrants, users } from '../db/schema.ts';
import { hashToken } from '../tokens.ts';
import {
	BASE_PERMISSION,
	GRANTABLE_PERMISSIONS,
	parsePermissions,
	type McpPermission
} from '../../mcp-access.ts';
import {
	ACCESS_TOKEN_TTL_MS,
	CODE_TTL_MS,
	LAST_USED_REFRESH_MS,
	MAX_PERSONAL_TOKEN_NAME,
	MAX_PERSONAL_TOKENS,
	PERSONAL_TOKEN_EXPIRY_DAYS,
	PERSONAL_TOKEN_HOST,
	REFRESH_TOKEN_TTL_MS,
	REVOKED_CLIENT_RETENTION,
	SPENT_CODE_RETENTION,
	UNUSED_CLIENT_RETENTION
} from './constants.ts';
import type { OauthClient } from './clients.ts';
import { verifyPkce } from './rules.ts';

// The authorization server's state: codes, grants and tokens. Every function
// takes the database, so the integration tests run them against a real one.
//
// The rules that hold throughout:
// - A code or token is stored only as a hash and resolves to exactly one user.
// - Permissions live on the grant, not the token, so a change or a revoke
//   takes effect on the next request.
// - The account must be in good standing and have external access on, checked
//   every time a credential is used.

const ACCESS_PREFIX = 'cdx_at_';
const REFRESH_PREFIX = 'cdx_rt_';
const CODE_PREFIX = 'cdx_ac_';
const PERSONAL_PREFIX = 'cdx_pat_';

function newSecret(prefix: string): string {
	return prefix + randomBytes(32).toString('base64url');
}

// Issuing a credential and revoking every credential of an account must not
// overlap, or the one issued while the other runs survives it. Both take a
// lock on the user's row first: whoever issues takes it shared (`holdUser`),
// whoever revokes takes it for update (`lockUserForRevocation`), so a
// revocation waits for an issue in flight and the next issue sees its result.
// The user lock always comes before any lock on a code, token or grant row,
// which is why the issuers look the user up by hash before locking the row
// they came for.
async function lockUserForRevocation(tx: Database, userId: string): Promise<void> {
	await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
}

// Whether the account may use external access at all right now. With
// `holdUser` (inside a transaction that issues something) the row is locked
// shared until that transaction ends.
async function accountUsable(db: Database, userId: string, holdUser = false): Promise<boolean> {
	const query = db
		.select({
			emailVerifiedAt: users.emailVerifiedAt,
			approvedAt: users.approvedAt,
			suspendedAt: users.suspendedAt,
			deletionScheduledAt: users.deletionScheduledAt,
			mcpEnabled: users.mcpEnabled
		})
		.from(users)
		.where(eq(users.id, userId));
	const [user] = await (holdUser ? query.for('share') : query);
	return Boolean(
		user &&
		user.emailVerifiedAt &&
		user.approvedAt &&
		!user.suspendedAt &&
		!user.deletionScheduledAt &&
		user.mcpEnabled
	);
}

// ============ Authorization codes ============

export async function createAuthorizationCode(
	db: Database,
	input: {
		userId: string;
		client: OauthClient;
		permissions: readonly McpPermission[];
		redirectUri: string;
		codeChallenge: string;
	}
): Promise<string> {
	const code = newSecret(CODE_PREFIX);
	await db.insert(oauthCodes).values({
		codeHash: hashToken(code),
		userId: input.userId,
		clientId: input.client.id,
		permissions: [...input.permissions],
		redirectUri: input.redirectUri,
		codeChallenge: input.codeChallenge,
		expiresAt: new Date(Date.now() + CODE_TTL_MS)
	});
	return code;
}

export type TokenSet = {
	accessToken: string;
	refreshToken: string;
	expiresInSeconds: number;
	permissions: McpPermission[];
};

// Every failure reads the same to the client (invalid_grant), so a probe
// learns nothing about which check refused it.
export type TokenResult = { ok: true; tokens: TokenSet } | { ok: false };

async function issueTokens(
	db: Database,
	input: { userId: string; grantId: string; familyId: string; permissions: readonly string[] }
): Promise<TokenSet> {
	const accessToken = newSecret(ACCESS_PREFIX);
	const refreshToken = newSecret(REFRESH_PREFIX);
	const base = { userId: input.userId, grantId: input.grantId, familyId: input.familyId };
	await db.insert(apiTokens).values([
		{
			...base,
			kind: 'access',
			tokenHash: hashToken(accessToken),
			expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS)
		},
		{
			...base,
			kind: 'refresh',
			tokenHash: hashToken(refreshToken),
			expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
		}
	]);
	return {
		accessToken,
		refreshToken,
		expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
		permissions: parsePermissions(input.permissions)
	};
}

async function revokeFamily(db: Database, familyId: string): Promise<void> {
	await db
		.update(apiTokens)
		.set({ revokedAt: sql`now()` })
		.where(and(eq(apiTokens.familyId, familyId), isNull(apiTokens.revokedAt)));
}

// Exchanges a code for tokens. The code row is locked, so two requests with
// the same code cannot both succeed; the second finds it spent, and a spent
// code presented again takes back the tokens the first use issued.
export async function exchangeCode(
	db: Database,
	input: { code: string; clientId: string; redirectUri: string; codeVerifier: string }
): Promise<TokenResult> {
	return db.transaction(async (tx) => {
		const codeHash = hashToken(input.code);
		// Whose code it is, read without a lock, so the user lock comes first.
		const [owner] = await tx
			.select({ userId: oauthCodes.userId })
			.from(oauthCodes)
			.where(eq(oauthCodes.codeHash, codeHash));
		if (!owner) return { ok: false };
		const usable = await accountUsable(tx, owner.userId, true);
		const [row] = await tx
			.select({ code: oauthCodes, client: oauthClients })
			.from(oauthCodes)
			.innerJoin(oauthClients, eq(oauthCodes.clientId, oauthClients.id))
			.where(eq(oauthCodes.codeHash, codeHash))
			.for('update', { of: oauthCodes });
		if (!row) return { ok: false };
		const { code, client } = row;
		if (code.usedAt) {
			if (code.familyId) await revokeFamily(tx, code.familyId);
			return { ok: false };
		}
		if (
			code.expiresAt.getTime() <= Date.now() ||
			client.clientId !== input.clientId ||
			code.redirectUri !== input.redirectUri ||
			!verifyPkce(input.codeVerifier, code.codeChallenge) ||
			!usable
		) {
			return { ok: false };
		}

		const familyId = randomUUID();
		await tx
			.update(oauthCodes)
			.set({ usedAt: sql`now()`, familyId })
			.where(eq(oauthCodes.id, code.id));

		// One live grant per writer and client: connecting again (a second
		// device, or after the app lost its tokens) updates it in place.
		const [grant] = await tx
			.insert(oauthGrants)
			.values({ userId: code.userId, clientId: client.id, permissions: code.permissions })
			.onConflictDoUpdate({
				target: [oauthGrants.userId, oauthGrants.clientId],
				targetWhere: isNull(oauthGrants.revokedAt),
				set: { permissions: code.permissions }
			})
			.returning();
		const tokens = await issueTokens(tx, {
			userId: code.userId,
			grantId: grant.id,
			familyId,
			permissions: grant.permissions
		});
		return { ok: true, tokens };
	});
}

// Exchanges a refresh token for a new pair. The old refresh token is spent in
// the same transaction; presenting a spent or revoked one again means it was
// copied, so every token descended from the same code is revoked.
export async function refreshTokens(
	db: Database,
	input: { refreshToken: string; clientId: string }
): Promise<TokenResult> {
	return db.transaction(async (tx) => {
		const isRefresh = and(
			eq(apiTokens.tokenHash, hashToken(input.refreshToken)),
			eq(apiTokens.kind, 'refresh')
		);
		// As in exchangeCode: the user lock before the token's.
		const [owner] = await tx.select({ userId: apiTokens.userId }).from(apiTokens).where(isRefresh);
		if (!owner) return { ok: false };
		const usable = await accountUsable(tx, owner.userId, true);
		const [row] = await tx
			.select({ token: apiTokens, grant: oauthGrants, client: oauthClients })
			.from(apiTokens)
			.innerJoin(oauthGrants, eq(apiTokens.grantId, oauthGrants.id))
			.innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
			.where(isRefresh)
			.for('update', { of: apiTokens });
		if (!row) return { ok: false };
		const { token, grant, client } = row;
		if (token.usedAt || token.revokedAt) {
			await revokeFamily(tx, token.familyId);
			return { ok: false };
		}
		if (
			token.expiresAt.getTime() <= Date.now() ||
			grant.revokedAt ||
			client.clientId !== input.clientId ||
			!usable
		) {
			return { ok: false };
		}
		await tx
			.update(apiTokens)
			.set({ usedAt: sql`now()` })
			.where(eq(apiTokens.id, token.id));
		// The access token this refresh token came with is replaced too.
		await tx
			.update(apiTokens)
			.set({ revokedAt: sql`now()` })
			.where(
				and(
					eq(apiTokens.familyId, token.familyId),
					eq(apiTokens.kind, 'access'),
					isNull(apiTokens.revokedAt)
				)
			);
		const tokens = await issueTokens(tx, {
			userId: token.userId,
			grantId: grant.id,
			familyId: token.familyId,
			permissions: grant.permissions
		});
		return { ok: true, tokens };
	});
}

// RFC 7009: revoking either token of a pair ends that connection. Unknown
// tokens are not an error.
export async function revokeToken(db: Database, token: string): Promise<void> {
	const [row] = await db
		.select({ familyId: apiTokens.familyId })
		.from(apiTokens)
		.where(eq(apiTokens.tokenHash, hashToken(token)));
	if (row) await revokeFamily(db, row.familyId);
}

// ============ Bearer resolution ============

export type BearerIdentity = {
	userId: string;
	tokenId: string;
	grantId: string;
	// The registered client's row id and how it is named and vouched for.
	client: { id: string; clientName: string; host: string };
	permissions: McpPermission[];
};

// The one place an access token becomes a user. Returns null for anything
// that is not a live access token (an app's, or a personal one) of a live
// grant on a usable account; the caller answers 401 without saying which.
// A personal token resolves exactly as an app's does: its grant holds the
// permissions and its client row the name the writer gave it.
export async function resolveBearer(db: Database, token: string): Promise<BearerIdentity | null> {
	if (!token) return null;
	const [row] = await db
		.select({ token: apiTokens, grant: oauthGrants, client: oauthClients })
		.from(apiTokens)
		.innerJoin(oauthGrants, eq(apiTokens.grantId, oauthGrants.id))
		.innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
		.where(
			and(
				eq(apiTokens.tokenHash, hashToken(token)),
				inArray(apiTokens.kind, ['access', 'personal'])
			)
		);
	if (!row) return null;
	const { token: stored, grant, client } = row;
	// A personal token belongs to a personal client and no other kind does.
	if ((stored.kind === 'personal') !== (client.kind === 'personal')) return null;
	if (stored.revokedAt || grant.revokedAt || stored.expiresAt.getTime() <= Date.now()) return null;
	// The token says whose it is; the grant must agree.
	if (grant.userId !== stored.userId) return null;
	if (!(await accountUsable(db, stored.userId))) return null;

	if (!grant.lastUsedAt || Date.now() - grant.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
		await db
			.update(oauthGrants)
			.set({ lastUsedAt: sql`now()` })
			.where(eq(oauthGrants.id, grant.id));
	}
	return {
		userId: stored.userId,
		tokenId: stored.id,
		grantId: grant.id,
		client: { id: client.id, clientName: client.clientName, host: client.host },
		permissions: parsePermissions(grant.permissions)
	};
}

// ============ Grants (the Account page) ============

export type GrantView = {
	id: string;
	clientName: string;
	host: string;
	permissions: McpPermission[];
	createdAt: Date;
	lastUsedAt: Date | null;
};

export async function listGrants(db: Database, userId: string): Promise<GrantView[]> {
	const rows = await db
		.select({
			id: oauthGrants.id,
			clientName: oauthClients.clientName,
			host: oauthClients.host,
			permissions: oauthGrants.permissions,
			createdAt: oauthGrants.createdAt,
			lastUsedAt: oauthGrants.lastUsedAt
		})
		.from(oauthGrants)
		.innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
		.where(
			and(
				eq(oauthGrants.userId, userId),
				isNull(oauthGrants.revokedAt),
				// Personal tokens have a list of their own.
				ne(oauthClients.kind, 'personal')
			)
		)
		.orderBy(desc(oauthGrants.createdAt));
	return rows.map((row) => ({ ...row, permissions: parsePermissions(row.permissions) }));
}

// ============ Personal access tokens ============
// A token the writer makes on the Account page for a program of their own
// that cannot go through the consent page. It is a grant like an app's (same
// permissions, same revocation, same checks on every use) on a client row of
// kind 'personal' that carries its name, with one long-lived token in
// api_tokens. The secret is returned once, here, and stored only as a hash.

export type PersonalTokenView = {
	// The grant's id: what the list revokes by.
	id: string;
	name: string;
	permissions: McpPermission[];
	createdAt: Date;
	lastUsedAt: Date | null;
	// Null once the clean-up has removed the expired token row.
	expiresAt: Date | null;
};

export type CreatePersonalToken =
	{ ok: true; id: string; token: string; expiresAt: Date } | { ok: false; reason: string };

const live = (userId: string) =>
	and(
		eq(oauthGrants.userId, userId),
		isNull(oauthGrants.revokedAt),
		eq(oauthClients.kind, 'personal')
	);

export async function listPersonalTokens(
	db: Database,
	userId: string
): Promise<PersonalTokenView[]> {
	const rows = await db
		.select({
			id: oauthGrants.id,
			name: oauthClients.clientName,
			permissions: oauthGrants.permissions,
			createdAt: oauthGrants.createdAt,
			lastUsedAt: oauthGrants.lastUsedAt,
			expiresAt: apiTokens.expiresAt
		})
		.from(oauthGrants)
		.innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
		.leftJoin(apiTokens, eq(apiTokens.grantId, oauthGrants.id))
		.where(live(userId))
		.orderBy(desc(oauthGrants.createdAt));
	return rows.map((row) => ({ ...row, permissions: parsePermissions(row.permissions) }));
}

// The caller has checked who is asking (password, and the second factor
// when the account has one).
export async function createPersonalToken(
	db: Database,
	input: {
		userId: string;
		name: string;
		permissions: readonly string[];
		expiresInDays: number;
	}
): Promise<CreatePersonalToken> {
	const name = input.name.replace(/\s+/g, ' ').trim();
	if (!name) return { ok: false, reason: 'Give the token a name.' };
	if (name.length > MAX_PERSONAL_TOKEN_NAME) {
		return {
			ok: false,
			reason: `Keep the name to ${MAX_PERSONAL_TOKEN_NAME} characters or fewer.`
		};
	}
	if (!(PERSONAL_TOKEN_EXPIRY_DAYS as readonly number[]).includes(input.expiresInDays)) {
		return { ok: false, reason: 'Choose how long the token lasts.' };
	}
	// Only what a writer can hand out today, and always reading.
	const permissions = parsePermissions([
		BASE_PERMISSION,
		...input.permissions.filter((permission) =>
			(GRANTABLE_PERMISSIONS as readonly string[]).includes(permission)
		)
	]);
	return db.transaction(async (tx) => {
		if (!(await accountUsable(tx, input.userId, true))) {
			return { ok: false, reason: 'Turn on "Allow other apps to connect" first.' };
		}
		const existing = await tx
			.select({ name: oauthClients.clientName })
			.from(oauthGrants)
			.innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
			.where(live(input.userId));
		if (existing.length >= MAX_PERSONAL_TOKENS) {
			return {
				ok: false,
				reason: `You have ${existing.length} tokens. Revoke one before making another.`
			};
		}
		// The name is how its notes are attributed, so it names one token.
		if (existing.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
			return { ok: false, reason: 'You already have a token with that name.' };
		}
		const [client] = await tx
			.insert(oauthClients)
			.values({
				clientId: `personal:${randomUUID()}`,
				kind: 'personal',
				clientName: name,
				host: PERSONAL_TOKEN_HOST,
				redirectUris: []
			})
			.returning({ id: oauthClients.id });
		const [grant] = await tx
			.insert(oauthGrants)
			.values({ userId: input.userId, clientId: client.id, permissions })
			.returning({ id: oauthGrants.id });
		const token = newSecret(PERSONAL_PREFIX);
		const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
		await tx.insert(apiTokens).values({
			userId: input.userId,
			grantId: grant.id,
			kind: 'personal',
			tokenHash: hashToken(token),
			familyId: randomUUID(),
			expiresAt
		});
		return { ok: true, id: grant.id, token, expiresAt };
	});
}

// The live grant a writer already gave this client, if any.
export async function existingGrant(
	db: Database,
	userId: string,
	clientRowId: string
): Promise<{ permissions: McpPermission[] } | null> {
	const [row] = await db
		.select({ permissions: oauthGrants.permissions })
		.from(oauthGrants)
		.where(
			and(
				eq(oauthGrants.userId, userId),
				eq(oauthGrants.clientId, clientRowId),
				isNull(oauthGrants.revokedAt)
			)
		);
	return row ? { permissions: parsePermissions(row.permissions) } : null;
}

async function revokeGrantTokens(db: Database, grantId: string): Promise<void> {
	await db
		.update(apiTokens)
		.set({ revokedAt: sql`now()` })
		.where(and(eq(apiTokens.grantId, grantId), isNull(apiTokens.revokedAt)));
}

// Disconnects one app. Scoped by user id, so one writer cannot revoke
// another's grant by guessing its id. Returns whether a grant was revoked.
export async function revokeGrant(db: Database, userId: string, grantId: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		await lockUserForRevocation(tx, userId);
		const revoked = await tx
			.update(oauthGrants)
			.set({ revokedAt: sql`now()` })
			.where(
				and(
					eq(oauthGrants.id, grantId),
					eq(oauthGrants.userId, userId),
					isNull(oauthGrants.revokedAt)
				)
			)
			.returning({ id: oauthGrants.id, clientId: oauthGrants.clientId });
		if (revoked.length === 0) return false;
		await revokeGrantTokens(tx, grantId);
		// A code this app was handed a moment ago would make the grant anew.
		await tx
			.update(oauthCodes)
			.set({ usedAt: sql`now()` })
			.where(
				and(
					eq(oauthCodes.userId, userId),
					eq(oauthCodes.clientId, revoked[0].clientId),
					isNull(oauthCodes.usedAt)
				)
			);
		return true;
	});
}

// Disconnects every app and kills every credential of the account: on a
// password change or reset, on scheduling deletion, and when the writer turns
// external access off, and when an admin suspends the account. Pass the
// caller's transaction so it lands with the change that caused it, and so the
// lock it takes on the user's row holds until that change is committed.
export async function revokeAllGrants(db: Database, userId: string): Promise<void> {
	await lockUserForRevocation(db, userId);
	await db
		.update(oauthGrants)
		.set({ revokedAt: sql`now()` })
		.where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)));
	await db
		.update(apiTokens)
		.set({ revokedAt: sql`now()` })
		.where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
	// A code issued a moment ago must not outlive the change either.
	await db
		.update(oauthCodes)
		.set({ usedAt: sql`now()` })
		.where(and(eq(oauthCodes.userId, userId), isNull(oauthCodes.usedAt)));
}

// ============ Clean-up ============

// Run daily by the worker. Expired tokens and old codes go; so do clients
// nobody connected (dynamic registration makes one per attempt) and clients
// whose every grant was revoked long ago.
export async function purgeExternalAccess(
	db: Database
): Promise<{ tokens: number; codes: number; clients: number }> {
	const tokens = await db
		.delete(apiTokens)
		.where(lt(apiTokens.expiresAt, sql`now()`))
		.returning({ id: apiTokens.id });
	// A personal token that has expired is over: its grant goes with it, and
	// its client row follows by the rule for revoked clients below.
	await db
		.update(oauthGrants)
		.set({ revokedAt: sql`now()` })
		.where(
			and(
				isNull(oauthGrants.revokedAt),
				sql`exists (select 1 from ${oauthClients} where ${oauthClients.id} = ${oauthGrants.clientId} and ${oauthClients.kind} = 'personal')`,
				sql`not exists (select 1 from ${apiTokens} where ${apiTokens.grantId} = ${oauthGrants.id})`
			)
		);
	const codes = await db
		.delete(oauthCodes)
		.where(lt(oauthCodes.expiresAt, sql`now() - ${SPENT_CODE_RETENTION}::interval`))
		.returning({ id: oauthCodes.id });
	const clients = await db
		.delete(oauthClients)
		.where(
			or(
				and(
					lt(oauthClients.createdAt, sql`now() - ${UNUSED_CLIENT_RETENTION}::interval`),
					sql`not exists (select 1 from ${oauthGrants} where ${oauthGrants.clientId} = ${oauthClients.id})`
				),
				and(
					sql`exists (select 1 from ${oauthGrants} where ${oauthGrants.clientId} = ${oauthClients.id})`,
					sql`not exists (select 1 from ${oauthGrants} where ${oauthGrants.clientId} = ${oauthClients.id} and (${oauthGrants.revokedAt} is null or ${oauthGrants.revokedAt} > now() - ${REVOKED_CLIENT_RETENTION}::interval))`
				)
			)
		)
		.returning({ id: oauthClients.id });
	return { tokens: tokens.length, codes: codes.length, clients: clients.length };
}
