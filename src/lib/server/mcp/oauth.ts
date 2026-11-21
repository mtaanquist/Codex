import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { apiTokens, oauthClients, oauthCodes, oauthGrants, users } from '../db/schema.ts';
import { hashToken } from '../tokens.ts';
import { parsePermissions, type McpPermission } from '../../mcp-access.ts';
import {
	ACCESS_TOKEN_TTL_MS,
	CODE_TTL_MS,
	LAST_USED_REFRESH_MS,
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

function newSecret(prefix: string): string {
	return prefix + randomBytes(32).toString('base64url');
}

// Whether the account may use external access at all right now.
async function accountUsable(db: Database, userId: string): Promise<boolean> {
	const [user] = await db
		.select({
			emailVerifiedAt: users.emailVerifiedAt,
			approvedAt: users.approvedAt,
			suspendedAt: users.suspendedAt,
			deletionScheduledAt: users.deletionScheduledAt,
			mcpEnabled: users.mcpEnabled
		})
		.from(users)
		.where(eq(users.id, userId));
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
		const [row] = await tx
			.select({ code: oauthCodes, client: oauthClients })
			.from(oauthCodes)
			.innerJoin(oauthClients, eq(oauthCodes.clientId, oauthClients.id))
			.where(eq(oauthCodes.codeHash, hashToken(input.code)))
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
			!(await accountUsable(tx, code.userId))
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
		const [row] = await tx
			.select({ token: apiTokens, grant: oauthGrants, client: oauthClients })
			.from(apiTokens)
			.innerJoin(oauthGrants, eq(apiTokens.grantId, oauthGrants.id))
			.innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
			.where(
				and(eq(apiTokens.tokenHash, hashToken(input.refreshToken)), eq(apiTokens.kind, 'refresh'))
			)
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
			!(await accountUsable(tx, token.userId))
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
// that is not a live access token of a live grant on a usable account; the
// caller answers 401 without saying which.
export async function resolveBearer(db: Database, token: string): Promise<BearerIdentity | null> {
	if (!token) return null;
	const [row] = await db
		.select({ token: apiTokens, grant: oauthGrants, client: oauthClients })
		.from(apiTokens)
		.innerJoin(oauthGrants, eq(apiTokens.grantId, oauthGrants.id))
		.innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
		.where(and(eq(apiTokens.tokenHash, hashToken(token)), eq(apiTokens.kind, 'access')));
	if (!row) return null;
	const { token: stored, grant, client } = row;
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
		.where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
		.orderBy(desc(oauthGrants.createdAt));
	return rows.map((row) => ({ ...row, permissions: parsePermissions(row.permissions) }));
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
			.returning({ id: oauthGrants.id });
		if (revoked.length === 0) return false;
		await revokeGrantTokens(tx, grantId);
		return true;
	});
}

// Disconnects every app and kills every credential of the account: on a
// password change or reset, on scheduling deletion, and when the writer turns
// external access off. Pass the caller's transaction so it lands with the
// change that caused it.
export async function revokeAllGrants(db: Database, userId: string): Promise<void> {
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
