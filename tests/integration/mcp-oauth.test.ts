import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import {
	apiTokens,
	oauthClients,
	oauthCodes,
	oauthGrants,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';
import { sentToken } from './token-helpers';

// The OAuth server behind external access, against a real database: the code
// and token rules, the two switches, revocation with the account's other
// credentials, and the routes an outside app calls.

// The second factor's secret is encrypted with a key derived from this.
process.env.APP_SECRET = process.env.APP_SECRET || 'mcp-oauth-test-secret';

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { hashPassword } = await import('#lib/server/password');
const { changePassword } = await import('#lib/server/account');
const { requestPasswordReset, resetPassword } = await import('#lib/server/password-reset');
const { scheduleAccountDeletion } = await import('#lib/server/account-deletion');
const { setUserSuspended } = await import('#lib/server/admin');
const { findClient, registerClient } = await import('#lib/server/mcp/clients');
const {
	createAuthorizationCode,
	createPersonalToken,
	exchangeCode,
	listGrants,
	listPersonalTokens,
	purgeExternalAccess,
	refreshTokens,
	revokeAllGrants,
	resolveBearer,
	revokeGrant,
	revokeToken
} = await import('#lib/server/mcp/oauth');
const { mcpInstanceEnabled, saveMcpInstanceEnabled, setMcpAccountEnabled } =
	await import('#lib/server/mcp/settings');
const { checkAuthorizeRequest } = await import('#lib/server/mcp/authorize');
const { beginEnrollment, confirmEnrollment } = await import('#lib/server/two-factor');
const { totpCode } = await import('#lib/server/totp');

const tokenRoute = await import('../../src/routes/oauth/token/+server');
const registerRoute = await import('../../src/routes/oauth/register/+server');
const revokeRoute = await import('../../src/routes/oauth/revoke/+server');
const serverMetadataRoute =
	await import('../../src/routes/.well-known/oauth-authorization-server/+server');
const resourceMetadataRoute =
	await import('../../src/routes/.well-known/oauth-protected-resource/[...rest]/+server');
const authorizePage = await import('../../src/routes/oauth/authorize/+page.server');
const accountPage = await import('../../src/routes/account/[[section]]/+page.server');

const ORIGIN = 'http://localhost';
const REDIRECT = 'https://app.example/callback';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

type Client = NonNullable<Awaited<ReturnType<typeof findClient>>>;
let alice: string;
let bob: string;
let client: Client;

async function addUser(email: string, extra: Partial<typeof users.$inferInsert> = {}) {
	const [row] = await db
		.insert(users)
		.values({
			email,
			displayName: email.split('@')[0],
			passwordHash: 'x',
			role: 'user',
			emailVerifiedAt: new Date(),
			approvedAt: new Date(),
			mcpEnabled: true,
			...extra
		})
		.returning({ id: users.id });
	return row.id;
}

async function newClient(redirectUris = [REDIRECT], name = 'Writing Desk'): Promise<Client> {
	const result = await registerClient(db, { client_name: name, redirect_uris: redirectUris });
	if (!result.ok) throw new Error(result.description);
	return result.client;
}

const codeFor = (userId: string, permissions: ('read' | 'suggest')[] = ['read', 'suggest']) =>
	createAuthorizationCode(db, {
		userId,
		client,
		permissions,
		redirectUri: REDIRECT,
		codeChallenge: CHALLENGE
	});

const exchange = (code: string, overrides: Record<string, string> = {}) =>
	exchangeCode(db, {
		code,
		clientId: client.clientId,
		redirectUri: REDIRECT,
		codeVerifier: VERIFIER,
		...overrides
	});

// A connected app: the tokens a writer's consent ends in.
async function connect(userId: string) {
	const result = await exchange(await codeFor(userId));
	if (!result.ok) throw new Error('the exchange was refused');
	return result.tokens;
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users, oauth_clients cascade');
	await pool.query(`delete from app_settings where key = 'mcp'`);
	resetRateLimits();
	alice = await addUser('alice@example.com');
	bob = await addUser('bob@example.com');
	client = await newClient();
});

afterAll(async () => {
	await pool.end();
});

describe('exchanging a code', () => {
	it('issues tokens that resolve to the writer who allowed the app, and no one else', async () => {
		const tokens = await connect(alice);
		expect(tokens.permissions).toEqual(['read', 'suggest']);
		expect(tokens.expiresInSeconds).toBe(3600);

		const identity = await resolveBearer(db, tokens.accessToken);
		expect(identity).toMatchObject({
			userId: alice,
			permissions: ['read', 'suggest'],
			client: { clientName: 'Writing Desk', host: 'app.example' }
		});
		// The refresh token is not a bearer credential.
		expect(await resolveBearer(db, tokens.refreshToken)).toBeNull();

		const bobs = await connect(bob);
		expect((await resolveBearer(db, bobs.accessToken))?.userId).toBe(bob);
		expect((await resolveBearer(db, tokens.accessToken))?.userId).toBe(alice);
	});

	it('stores only hashes', async () => {
		const code = await codeFor(alice);
		const result = await exchange(code);
		const text = JSON.stringify([
			await db.select().from(oauthCodes),
			await db.select().from(apiTokens)
		]);
		expect(text).not.toContain(code);
		expect(result.ok && text.includes(result.tokens.accessToken)).toBe(false);
		expect(result.ok && text.includes(result.tokens.refreshToken)).toBe(false);
	});

	it('refuses a wrong verifier, redirect address or client, and an unknown code', async () => {
		const other = await newClient(['https://other.example/cb'], 'Other');
		const wrong: Record<string, string>[] = [
			{ codeVerifier: 'w'.repeat(64) },
			{ redirectUri: 'https://app.example/callback2' },
			{ clientId: other.clientId }
		];
		for (const overrides of wrong) {
			expect(await exchange(await codeFor(alice), overrides)).toEqual({ ok: false });
		}
		expect(await exchange('cdx_ac_unknown')).toEqual({ ok: false });
		expect(await db.select().from(apiTokens)).toHaveLength(0);
		expect(await db.select().from(oauthGrants)).toHaveLength(0);
	});

	it('refuses an expired code', async () => {
		const code = await codeFor(alice);
		await db.update(oauthCodes).set({ expiresAt: new Date(Date.now() - 1000) });
		expect(await exchange(code)).toEqual({ ok: false });
	});

	it('works once: a second use is refused and takes back the first tokens', async () => {
		const code = await codeFor(alice);
		const first = await exchange(code);
		expect(first.ok).toBe(true);
		expect(await exchange(code)).toEqual({ ok: false });
		expect(first.ok && (await resolveBearer(db, first.tokens.accessToken))).toBeNull();
	});

	it('lets only one of two simultaneous uses through', async () => {
		const code = await codeFor(alice);
		const results = await Promise.all([exchange(code), exchange(code)]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
	});

	it('keeps one grant per writer and client, updated by a new consent', async () => {
		await connect(alice);
		const again = await exchange(await codeFor(alice, ['read']));
		expect(again.ok && again.tokens.permissions).toEqual(['read']);
		const grants = await listGrants(db, alice);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({
			clientName: 'Writing Desk',
			host: 'app.example',
			permissions: ['read']
		});
	});
});

describe('refreshing', () => {
	it('replaces both tokens and retires the old ones', async () => {
		const first = await connect(alice);
		const result = await refreshTokens(db, {
			refreshToken: first.refreshToken,
			clientId: client.clientId
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tokens.refreshToken).not.toBe(first.refreshToken);
		expect((await resolveBearer(db, result.tokens.accessToken))?.userId).toBe(alice);
		expect(await resolveBearer(db, first.accessToken)).toBeNull();
	});

	it('treats a spent refresh token as stolen and ends the whole connection', async () => {
		const first = await connect(alice);
		const refresh = (refreshToken: string) =>
			refreshTokens(db, { refreshToken, clientId: client.clientId });
		const second = await refresh(first.refreshToken);
		expect(second.ok).toBe(true);
		expect(await refresh(first.refreshToken)).toEqual({ ok: false });
		if (!second.ok) return;
		expect(await resolveBearer(db, second.tokens.accessToken)).toBeNull();
		expect(await refresh(second.tokens.refreshToken)).toEqual({ ok: false });
	});

	it('refuses another client, an expired token and an access token', async () => {
		const other = await newClient(['https://other.example/cb'], 'Other');
		const tokens = await connect(alice);
		expect(
			await refreshTokens(db, { refreshToken: tokens.refreshToken, clientId: other.clientId })
		).toEqual({ ok: false });
		expect(
			await refreshTokens(db, { refreshToken: tokens.accessToken, clientId: client.clientId })
		).toEqual({ ok: false });
		await db.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1000) });
		expect(
			await refreshTokens(db, { refreshToken: tokens.refreshToken, clientId: client.clientId })
		).toEqual({ ok: false });
	});

	it('picks up a change to the grant: permissions live there, not on the token', async () => {
		const tokens = await connect(alice);
		await db.update(oauthGrants).set({ permissions: ['read'] });
		expect((await resolveBearer(db, tokens.accessToken))?.permissions).toEqual(['read']);
	});
});

describe('who a token works for', () => {
	it('stops working when the token expires', async () => {
		const tokens = await connect(alice);
		await db
			.update(apiTokens)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(apiTokens.kind, 'access'));
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
	});

	it('stops working while the account is suspended, unapproved or waiting for deletion', async () => {
		const tokens = await connect(alice);
		for (const state of [
			{ suspendedAt: new Date() },
			{ deletionScheduledAt: new Date() },
			{ approvedAt: null },
			{ emailVerifiedAt: null }
		]) {
			await db.update(users).set(state).where(eq(users.id, alice));
			expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
			expect(
				await refreshTokens(db, { refreshToken: tokens.refreshToken, clientId: client.clientId })
			).toEqual({ ok: false });
			await db
				.update(users)
				.set({
					suspendedAt: null,
					deletionScheduledAt: null,
					approvedAt: new Date(),
					emailVerifiedAt: new Date()
				})
				.where(eq(users.id, alice));
		}
		// Nothing above revoked it: with the account back in order it works.
		expect((await resolveBearer(db, tokens.accessToken))?.userId).toBe(alice);
	});

	it('is refused, and no code can be exchanged, while the account switch is off', async () => {
		const carol = await addUser('carol@example.com', { mcpEnabled: false });
		expect(await exchange(await codeFor(carol))).toEqual({ ok: false });
		const tokens = await connect(alice);
		await db.update(users).set({ mcpEnabled: false }).where(eq(users.id, alice));
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
	});

	it('is not found for a garbage or empty value', async () => {
		expect(await resolveBearer(db, '')).toBeNull();
		expect(await resolveBearer(db, 'cdx_at_nope')).toBeNull();
	});
});

describe('disconnecting', () => {
	it('revokes one app for its own writer only', async () => {
		const tokens = await connect(alice);
		const bobs = await connect(bob);
		const [grant] = await listGrants(db, alice);
		// Bob cannot disconnect Alice's app by naming its id.
		expect(await revokeGrant(db, bob, grant.id)).toBe(false);
		expect((await resolveBearer(db, tokens.accessToken))?.userId).toBe(alice);

		expect(await revokeGrant(db, alice, grant.id)).toBe(true);
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
		expect(
			await refreshTokens(db, { refreshToken: tokens.refreshToken, clientId: client.clientId })
		).toEqual({ ok: false });
		expect(await listGrants(db, alice)).toHaveLength(0);
		expect((await resolveBearer(db, bobs.accessToken))?.userId).toBe(bob);
		// Connecting again after a disconnect makes a new grant.
		await connect(alice);
		expect(await listGrants(db, alice)).toHaveLength(1);
	});

	it('ends a connection when the app hands back either token', async () => {
		const tokens = await connect(alice);
		await revokeToken(db, tokens.refreshToken);
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
		await revokeToken(db, 'unknown');
	});

	it('disconnects every app when the writer turns the switch off', async () => {
		const tokens = await connect(alice);
		const bobs = await connect(bob);
		const pending = await codeFor(alice);
		await setMcpAccountEnabled(db, alice, false);
		await setMcpAccountEnabled(db, alice, true);
		// Turning it back on does not bring the old connection back.
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
		expect(await exchange(pending)).toEqual({ ok: false });
		expect(await listGrants(db, alice)).toHaveLength(0);
		expect((await resolveBearer(db, bobs.accessToken))?.userId).toBe(bob);
	});

	it('disconnects every app on a password change', async () => {
		await db
			.update(users)
			.set({ passwordHash: await hashPassword('the old password') })
			.where(eq(users.id, alice));
		const tokens = await connect(alice);
		const bobs = await connect(bob);
		const result = await changePassword(
			db,
			alice,
			'00000000-0000-4000-8000-000000000000',
			'the old password',
			'a brand new password'
		);
		expect(result.ok).toBe(true);
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
		expect(
			await refreshTokens(db, { refreshToken: tokens.refreshToken, clientId: client.clientId })
		).toEqual({ ok: false });
		expect((await resolveBearer(db, bobs.accessToken))?.userId).toBe(bob);
	});

	it('disconnects every app on a password reset', async () => {
		const tokens = await connect(alice);
		const tokenId = await requestPasswordReset(db, 'alice@example.com');
		const result = await resetPassword(db, await sentToken(db, tokenId!), 'a brand new password');
		expect(result.ok).toBe(true);
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
		expect(await listGrants(db, alice)).toHaveLength(0);
	});

	it('disconnects every app when the account is scheduled for deletion', async () => {
		const tokens = await connect(alice);
		await scheduleAccountDeletion(db, alice);
		// Even with the schedule lifted, the old connection is gone.
		await db.update(users).set({ deletionScheduledAt: null }).where(eq(users.id, alice));
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
	});

	it('spends the codes of an app when it is disconnected', async () => {
		await connect(alice);
		const [grant] = await listGrants(db, alice);
		// Issued a moment before the writer selects Disconnect.
		const pending = await codeFor(alice);
		const bobs = await codeFor(bob);
		const other = await newClient(['https://other.example/cb'], 'Other');
		const others = await createAuthorizationCode(db, {
			userId: alice,
			client: other,
			permissions: ['read'],
			redirectUri: 'https://other.example/cb',
			codeChallenge: CHALLENGE
		});
		expect(await revokeGrant(db, alice, grant.id)).toBe(true);
		expect(await exchange(pending)).toEqual({ ok: false });
		expect(await listGrants(db, alice)).toHaveLength(0);
		// Another writer's code, and a code for another app, are untouched.
		expect((await exchange(bobs)).ok).toBe(true);
		const kept = await exchangeCode(db, {
			code: others,
			clientId: other.clientId,
			redirectUri: 'https://other.example/cb',
			codeVerifier: VERIFIER
		});
		expect(kept.ok).toBe(true);
	});

	it('leaves no live token when a code is exchanged while everything is revoked', async () => {
		// The two run on separate connections and are started together; whatever
		// the order, the writer ends with nothing connected.
		for (let round = 0; round < 40; round++) {
			const code = await codeFor(alice);
			const [exchanged] = await Promise.all([
				exchange(code),
				db.transaction((tx) => revokeAllGrants(tx, alice))
			]);
			if (exchanged.ok) {
				expect(await resolveBearer(db, exchanged.tokens.accessToken)).toBeNull();
				expect(
					await refreshTokens(db, {
						refreshToken: exchanged.tokens.refreshToken,
						clientId: client.clientId
					})
				).toEqual({ ok: false });
			}
			expect(await listGrants(db, alice)).toHaveLength(0);
			const { rows } = await pool.query(
				`select count(*)::int as n from api_tokens where user_id = $1 and revoked_at is null`,
				[alice]
			);
			expect(rows[0].n).toBe(0);
		}
	});

	it('leaves no live token when a refresh races the same revocation', async () => {
		for (let round = 0; round < 20; round++) {
			const tokens = await connect(alice);
			const [refreshed] = await Promise.all([
				refreshTokens(db, { refreshToken: tokens.refreshToken, clientId: client.clientId }),
				db.transaction((tx) => revokeAllGrants(tx, alice))
			]);
			if (refreshed.ok) {
				expect(await resolveBearer(db, refreshed.tokens.accessToken)).toBeNull();
			}
			const { rows } = await pool.query(
				`select count(*)::int as n from api_tokens where user_id = $1 and revoked_at is null`,
				[alice]
			);
			expect(rows[0].n).toBe(0);
		}
	});

	it('disconnects every app when an admin suspends the account', async () => {
		const tokens = await connect(alice);
		const bobs = await connect(bob);
		const pending = await codeFor(alice);
		expect(await setUserSuspended(db, alice, true)).toBe(true);
		// Lifting the suspension does not bring the connection back.
		expect(await setUserSuspended(db, alice, false)).toBe(true);
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
		expect(
			await refreshTokens(db, { refreshToken: tokens.refreshToken, clientId: client.clientId })
		).toEqual({ ok: false });
		expect(await exchange(pending)).toEqual({ ok: false });
		expect(await listGrants(db, alice)).toHaveLength(0);
		expect((await resolveBearer(db, bobs.accessToken))?.userId).toBe(bob);
	});

	it('leaves nothing behind when the account row goes', async () => {
		await connect(alice);
		await codeFor(alice);
		await pool.query('delete from users where id = $1', [alice]);
		expect(await db.select().from(apiTokens)).toHaveLength(0);
		expect(await db.select().from(oauthGrants)).toHaveLength(0);
		expect(await db.select().from(oauthCodes)).toHaveLength(0);
	});
});

describe('clients', () => {
	const URL_ID = 'https://desk.example/oauth/client.json';
	const doc = (extra: Record<string, unknown> = {}) => ({
		client_id: URL_ID,
		client_name: 'Desk',
		redirect_uris: ['https://desk.example/cb', 'https://desk.example/cb2'],
		token_endpoint_auth_method: 'none',
		...extra
	});

	it('vouches for the redirect host of a self-registered client', async () => {
		const local = await newClient(['http://localhost:4000/callback'], 'Local Tool');
		expect(local).toMatchObject({ kind: 'dcr', host: 'localhost', clientName: 'Local Tool' });
		const unnamed = await registerClient(db, { redirect_uris: [REDIRECT] });
		expect(unnamed.ok && unnamed.client.clientName).toBe('app.example');
		expect(await findClient(db, local.clientId)).toMatchObject({ id: local.id });
		expect(await findClient(db, 'never-registered')).toBeNull();
	});

	it('refuses a client whose redirect addresses are on more than one remote host', async () => {
		// Shown as "Claude (claude.ai)" while the code would go to evil.example.
		const mixed = await registerClient(db, {
			client_name: 'Claude',
			redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb']
		});
		expect(mixed).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
		const withLocal = await registerClient(db, {
			client_name: 'Claude',
			redirect_uris: [
				'http://localhost/cb',
				'https://claude.ai/api/mcp/auth_callback',
				'https://evil.example/cb'
			]
		});
		expect(withLocal.ok).toBe(false);
		expect(
			await db.select().from(oauthClients).where(eq(oauthClients.clientName, 'Claude'))
		).toEqual([]);
		// A metadata document is held to the same rule.
		const fetchDocument = vi.fn(async () =>
			doc({ redirect_uris: ['https://desk.example/cb', 'https://evil.example/cb'] })
		);
		expect(await findClient(db, URL_ID, fetchDocument)).toBeNull();
	});

	it('takes a local address beside one remote host, and vouches only for the local one', async () => {
		// A program on this computer can list any remote address beside its own,
		// so the remote host is not what the list of apps shows for it.
		for (const redirect_uris of [
			['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:33418/cb'],
			['http://127.0.0.1:33418/cb', 'https://claude.ai/api/mcp/auth_callback']
		]) {
			const mixed = await registerClient(db, { client_name: 'Claude', redirect_uris });
			expect(mixed).toMatchObject({ ok: true, client: { host: '127.0.0.1' } });
		}
	});

	it('reads a metadata document once, names its host, and caches it', async () => {
		const fetchDocument = vi.fn(async () => doc());
		const first = await findClient(db, URL_ID, fetchDocument);
		expect(first).toMatchObject({
			kind: 'cimd',
			clientId: URL_ID,
			clientName: 'Desk',
			host: 'desk.example',
			redirectUris: ['https://desk.example/cb', 'https://desk.example/cb2']
		});
		const second = await findClient(db, URL_ID, fetchDocument);
		expect(second?.id).toBe(first?.id);
		expect(fetchDocument).toHaveBeenCalledTimes(1);
	});

	it('fetches a stale document again and keeps the client row', async () => {
		const first = await findClient(db, URL_ID, async () => doc());
		await db.update(oauthClients).set({ fetchedAt: new Date(Date.now() - 2 * 86400_000) });
		const renamed = await findClient(db, URL_ID, async () => doc({ client_name: 'Desk Two' }));
		expect(renamed).toMatchObject({ id: first?.id, clientName: 'Desk Two' });
	});

	it('falls back to the copy it has when the document cannot be fetched', async () => {
		const failing = async () => {
			throw new Error('unreachable');
		};
		expect(await findClient(db, URL_ID, failing)).toBeNull();
		const first = await findClient(db, URL_ID, async () => doc());
		await db.update(oauthClients).set({ fetchedAt: new Date(Date.now() - 2 * 86400_000) });
		expect((await findClient(db, URL_ID, failing))?.id).toBe(first?.id);
	});

	it('refuses a document that names another address or does not qualify', async () => {
		for (const bad of [
			doc({ client_id: 'https://desk.example/other.json' }),
			doc({ redirect_uris: ['http://desk.example/cb'] }),
			doc({ token_endpoint_auth_method: 'client_secret_basic' }),
			'not an object'
		]) {
			expect(await findClient(db, URL_ID, async () => bad)).toBeNull();
		}
		expect(await db.select().from(oauthClients).where(eq(oauthClients.kind, 'cimd'))).toEqual([]);
	});

	it('never fetches for a client_id that is not an https address with a path', async () => {
		const fetchDocument = vi.fn(async () => doc());
		for (const id of ['http://desk.example/client.json', 'https://desk.example/', 'plain-id']) {
			expect(await findClient(db, id, fetchDocument)).toBeNull();
		}
		expect(fetchDocument).not.toHaveBeenCalled();
	});
});

describe('the authorization request', () => {
	const request = (overrides: Record<string, string | null> = {}) => {
		const fields: Record<string, string | null> = {
			response_type: 'code',
			client_id: client.clientId,
			redirect_uri: REDIRECT,
			code_challenge: CHALLENGE,
			code_challenge_method: 'S256',
			state: 'xyz',
			scope: 'read suggest',
			resource: `${ORIGIN}/api/mcp`,
			...overrides
		};
		return checkAuthorizeRequest(db, (name) => fields[name] ?? null, ORIGIN);
	};

	it('passes a complete request and offers what was asked for', async () => {
		expect(await request()).toMatchObject({
			kind: 'ok',
			redirectUri: REDIRECT,
			state: 'xyz',
			offered: ['read', 'suggest'],
			requested: ['read', 'suggest']
		});
		expect(await request({ scope: 'read' })).toMatchObject({ requested: ['read'] });
		// Reading is always part of it, and unknown names are ignored.
		expect(await request({ scope: 'suggest offline_access' })).toMatchObject({
			requested: ['read', 'suggest']
		});
		expect(await request({ scope: null })).toMatchObject({ requested: ['read', 'suggest'] });
		// The apply permission cannot be asked for yet.
		expect(await request({ scope: 'read apply' })).toMatchObject({
			offered: ['read', 'suggest'],
			requested: ['read']
		});
	});

	it('sends nobody anywhere for an unknown client or an unregistered address', async () => {
		expect(await request({ client_id: 'unknown' })).toMatchObject({ kind: 'invalid' });
		expect(await request({ redirect_uri: 'https://evil.example/cb' })).toMatchObject({
			kind: 'invalid'
		});
		expect(await request({ redirect_uri: null })).toMatchObject({ kind: 'invalid' });
	});

	it('names the fault and the clients own address for any other fault', async () => {
		for (const [overrides, error] of [
			[{ response_type: 'token' }, 'unsupported_response_type'],
			[{ code_challenge: null }, 'invalid_request'],
			[{ code_challenge_method: 'plain' }, 'invalid_request'],
			[{ resource: 'https://elsewhere.example/api/mcp' }, 'invalid_target']
		] as const) {
			const result = await request(overrides);
			expect(result.kind).toBe('refused');
			if (result.kind !== 'refused') continue;
			const location = new URL(result.location);
			expect(location.origin + location.pathname).toBe(REDIRECT);
			expect(location.searchParams.get('error')).toBe(error);
			expect(location.searchParams.get('state')).toBe('xyz');
			expect(location.searchParams.get('iss')).toBe(ORIGIN);
			expect(result.host).toBe('app.example');
		}
	});
});

describe('clean-up', () => {
	it('removes expired tokens, old codes and clients nobody uses', async () => {
		const tokens = await connect(alice);
		const idle = await newClient(['https://idle.example/cb'], 'Idle');
		const fresh = await newClient(['https://fresh.example/cb'], 'Fresh');
		const gone = await newClient(['https://gone.example/cb'], 'Gone');
		await pool.query(
			`insert into oauth_grants (user_id, client_id, permissions, revoked_at)
			 values ($1, $2, '{read}', now() - interval '31 days')`,
			[bob, gone.id]
		);
		await pool.query(
			`update oauth_clients set created_at = now() - interval '2 days' where id = any($1)`,
			[[idle.id, gone.id, client.id]]
		);
		await pool.query(`update oauth_codes set expires_at = now() - interval '2 days'`);
		await pool.query(
			`update api_tokens set expires_at = now() - interval '1 minute' where kind = 'access'`
		);

		expect(await purgeExternalAccess(db)).toEqual({ tokens: 1, codes: 1, clients: 2 });
		const left = (await db.select({ id: oauthClients.id }).from(oauthClients)).map((row) => row.id);
		expect(left.sort()).toEqual([client.id, fresh.id].sort());
		// The connection itself is untouched: the refresh token still works.
		expect(
			(await refreshTokens(db, { refreshToken: tokens.refreshToken, clientId: client.clientId })).ok
		).toBe(true);
	});
});

// ============ The routes ============

function event(
	path: string,
	init: { method?: string; body?: string; type?: string; ip?: string } = {}
) {
	const url = new URL(ORIGIN + path);
	return {
		url,
		params: {},
		request: new Request(url, {
			method: init.method ?? 'POST',
			body: init.body,
			headers: init.type ? { 'content-type': init.type } : {}
		}),
		getClientAddress: () => init.ip ?? '203.0.113.7'
	};
}

const form = (fields: Record<string, string>) => ({
	body: new URLSearchParams(fields).toString(),
	type: 'application/x-www-form-urlencoded'
});

const postToken = (fields: Record<string, string>) =>
	tokenRoute.POST(event('/oauth/token', form(fields)) as never) as Promise<Response>;

describe('the token route', () => {
	it('exchanges a code and then a refresh token, as form posts', async () => {
		const response = await postToken({
			grant_type: 'authorization_code',
			code: await codeFor(alice),
			client_id: client.clientId,
			redirect_uri: REDIRECT,
			code_verifier: VERIFIER,
			resource: `${ORIGIN}/api/mcp`
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = await response.json();
		expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read suggest' });
		expect((await resolveBearer(db, body.access_token))?.userId).toBe(alice);

		const refreshed = await postToken({
			grant_type: 'refresh_token',
			refresh_token: body.refresh_token,
			client_id: client.clientId
		});
		expect(refreshed.status).toBe(200);
		expect((await refreshed.json()).refresh_token).not.toBe(body.refresh_token);
	});

	it('answers invalid_grant for a dead code or token', async () => {
		const dead: Record<string, string>[] = [
			{
				grant_type: 'authorization_code',
				code: 'nope',
				client_id: client.clientId,
				redirect_uri: REDIRECT,
				code_verifier: VERIFIER
			},
			{ grant_type: 'refresh_token', refresh_token: 'nope', client_id: client.clientId }
		];
		for (const fields of dead) {
			const response = await postToken(fields);
			expect(response.status).toBe(400);
			expect((await response.json()).error).toBe('invalid_grant');
		}
	});

	it('refuses other grant types, missing fields, JSON bodies and another resource', async () => {
		const cases: [Record<string, string>, string][] = [
			[{ grant_type: 'client_credentials' }, 'unsupported_grant_type'],
			[{ grant_type: 'authorization_code', code: 'x' }, 'invalid_request'],
			[{ grant_type: 'refresh_token' }, 'invalid_request'],
			[
				{
					grant_type: 'refresh_token',
					refresh_token: 'x',
					client_id: 'y',
					resource: 'https://elsewhere.example/api/mcp'
				},
				'invalid_target'
			]
		];
		for (const [fields, error] of cases) {
			const response = await postToken(fields);
			expect(response.status).toBe(400);
			expect((await response.json()).error).toBe(error);
		}
		const json = (await tokenRoute.POST(
			event('/oauth/token', { body: '{}', type: 'application/json' }) as never
		)) as Response;
		expect((await json.json()).error).toBe('invalid_request');
	});
});

describe('the register and revoke routes', () => {
	const register = (body: unknown, ip?: string) =>
		registerRoute.POST(
			event('/oauth/register', {
				body: JSON.stringify(body),
				type: 'application/json',
				ip
			}) as never
		) as Promise<Response>;

	it('registers a public client and says so', async () => {
		const response = await register({ client_name: 'New App', redirect_uris: [REDIRECT] });
		expect(response.status).toBe(201);
		const body = await response.json();
		expect(body).toMatchObject({
			client_name: 'New App',
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: 'none'
		});
		expect(body.client_secret).toBeUndefined();
		expect(await findClient(db, body.client_id)).not.toBeNull();
	});

	it('refuses bad metadata and a body that is not JSON', async () => {
		const bad = await register({ redirect_uris: ['http://app.example/cb'] });
		expect(bad.status).toBe(400);
		expect((await bad.json()).error).toBe('invalid_redirect_uri');
		const garbage = (await registerRoute.POST(
			event('/oauth/register', { body: 'nope', type: 'application/json' }) as never
		)) as Response;
		expect(garbage.status).toBe(400);
	});

	it('limits how many clients one address can register', async () => {
		const ip = '198.51.100.9';
		let last = 0;
		for (let i = 0; i < 31; i++) last = (await register({ redirect_uris: [REDIRECT] }, ip)).status;
		expect(last).toBe(429);
		expect((await register({ redirect_uris: [REDIRECT] }, '198.51.100.10')).status).toBe(201);
	});

	it('revokes a token and answers the same for an unknown one', async () => {
		const tokens = await connect(alice);
		for (const token of [tokens.accessToken, 'unknown']) {
			const response = (await revokeRoute.POST(
				event('/oauth/revoke', form({ token })) as never
			)) as Response;
			expect(response.status).toBe(200);
		}
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
	});
});

describe('the instance switch', () => {
	const getServer = () =>
		serverMetadataRoute.GET(
			event('/.well-known/oauth-authorization-server', { method: 'GET' }) as never
		) as Promise<Response>;
	const getResource = (rest: string) =>
		resourceMetadataRoute.GET({
			...event(`/.well-known/oauth-protected-resource/${rest}`, { method: 'GET' }),
			params: { rest }
		} as never) as Promise<Response>;

	it('is on by default and serves the discovery documents', async () => {
		expect(await mcpInstanceEnabled(db)).toBe(true);
		const server = await getServer();
		expect(server.status).toBe(200);
		expect(server.headers.get('access-control-allow-origin')).toBe('*');
		expect(await server.json()).toMatchObject({
			issuer: ORIGIN,
			token_endpoint: `${ORIGIN}/oauth/token`
		});
		for (const rest of ['', 'api/mcp']) {
			const resource = await getResource(rest);
			expect(resource.status).toBe(200);
			expect(await resource.json()).toMatchObject({
				resource: `${ORIGIN}/api/mcp`,
				authorization_servers: [ORIGIN]
			});
		}
		expect((await getResource('api/other')).status).toBe(404);
	});

	it('makes every route answer 404 when off, and keeps what was there for when it is back', async () => {
		const tokens = await connect(alice);
		await saveMcpInstanceEnabled(db, false);
		const statusOf = async (run: () => unknown) => {
			try {
				return ((await run()) as Response).status;
			} catch (err) {
				if (isHttpError(err)) return err.status;
				throw err;
			}
		};
		expect((await getServer()).status).toBe(404);
		expect((await getResource('api/mcp')).status).toBe(404);
		expect((await postToken({ grant_type: 'refresh_token' })).status).toBe(404);
		expect(
			await statusOf(() =>
				registerRoute.POST(
					event('/oauth/register', { body: '{}', type: 'application/json' }) as never
				)
			)
		).toBe(404);
		expect(
			await statusOf(() => revokeRoute.POST(event('/oauth/revoke', form({ token: 'x' })) as never))
		).toBe(404);
		const page = authorizeEvent(alice, new URLSearchParams({ client_id: client.clientId }));
		expect(await statusOf(() => authorizePage.load(page as never))).toBe(404);
		expect(
			await statusOf(() => accountPage.actions.setExternalAccess(accountEvent(alice, {}) as never))
		).toBe(404);

		await saveMcpInstanceEnabled(db, true);
		expect((await resolveBearer(db, tokens.accessToken))?.userId).toBe(alice);
	});
});

function authorizeQuery(overrides: Record<string, string> = {}) {
	return new URLSearchParams({
		response_type: 'code',
		client_id: client.clientId,
		redirect_uri: REDIRECT,
		code_challenge: CHALLENGE,
		code_challenge_method: 'S256',
		state: 'st-1',
		scope: 'read suggest',
		...overrides
	});
}

function authorizeEvent(userId: string, query: URLSearchParams, fields?: URLSearchParams) {
	const url = new URL(`${ORIGIN}/oauth/authorize?${query}`);
	const data = new FormData();
	for (const [key, value] of fields ?? []) data.append(key, value);
	return {
		url,
		locals: { user: { id: userId, email: 'writer@example.com' }, session: { id: 's' } },
		request: { formData: async () => data },
		setHeaders: vi.fn()
	};
}

function accountEvent(userId: string, fields: Record<string, string>) {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) data.set(key, value);
	return {
		request: { formData: async () => data },
		locals: { user: { id: userId }, session: { id: 's' } }
	};
}

describe('the consent page', () => {
	type Loaded = {
		status: string;
		connected: boolean;
		permissions: { id: string; required: boolean; checked: boolean }[];
	};
	const load = async (userId: string, query = authorizeQuery()) =>
		(await authorizePage.load(authorizeEvent(userId, query) as never)) as Loaded;
	const answer = (
		action: 'allow' | 'deny',
		userId: string,
		fields: URLSearchParams = authorizeQuery()
	) =>
		authorizePage.actions[action](
			authorizeEvent(userId, new URLSearchParams(), fields) as never
		) as Promise<{ continueTo?: string; status?: number; data?: { message: string } }>;

	it('names the app with its host and offers the permissions that exist today', async () => {
		const data = await load(alice);
		expect(data).toMatchObject({
			status: 'ok',
			accessOn: true,
			client: { clientName: 'Writing Desk', host: 'app.example' },
			redirectHost: 'app.example',
			local: false,
			connected: false
		});
		expect(data.permissions.map((p) => [p.id, p.required, p.checked])).toEqual([
			['read', true, true],
			['suggest', false, true]
		]);
	});

	it('shows an error and no form for an unknown client or address', async () => {
		expect(await load(alice, authorizeQuery({ client_id: 'unknown' }))).toMatchObject({
			status: 'invalid'
		});
		expect(
			await load(alice, authorizeQuery({ redirect_uri: 'https://evil.example/cb' }))
		).toMatchObject({ status: 'invalid' });
	});

	it('shows a faulty request as an error with a link back, and redirects nobody', async () => {
		// Sent on without a click, this page would forward a visitor to any
		// address a self-registered client chose.
		const data = (await load(alice, authorizeQuery({ response_type: 'token' }))) as unknown as {
			status: string;
			host: string;
			returnTo: string;
		};
		expect(data.status).toBe('refused');
		expect(data.host).toBe('app.example');
		expect(data.returnTo.startsWith(REDIRECT)).toBe(true);
		expect(new URL(data.returnTo).searchParams.get('error')).toBe('unsupported_response_type');
		// Answering a form whose request has been made faulty goes nowhere either.
		for (const action of ['allow', 'deny'] as const) {
			const result = await answer(action, alice, authorizeQuery({ response_type: 'token' }));
			expect(result.status).toBe(400);
			expect(result.continueTo).toBeUndefined();
		}
		expect(await db.select().from(oauthCodes)).toHaveLength(0);
	});

	it('names the host the answer goes to, whatever the client registered first', async () => {
		// A row from before registration held every address to one host.
		const [old] = await db
			.insert(oauthClients)
			.values({
				clientId: 'old-mixed-client',
				kind: 'dcr',
				clientName: 'Claude',
				host: 'claude.ai',
				redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb']
			})
			.returning();
		const data = await load(
			alice,
			authorizeQuery({ client_id: old.clientId, redirect_uri: 'https://evil.example/cb' })
		);
		expect(data).toMatchObject({
			status: 'ok',
			client: { clientName: 'Claude', host: 'evil.example' },
			local: false
		});
	});

	it('names each address of a client with a local and a remote one for what it is', async () => {
		const mixed = await newClient(['https://desk.example/cb', 'http://localhost/cb'], 'Desk');
		const viaLocal = await load(
			alice,
			authorizeQuery({ client_id: mixed.clientId, redirect_uri: 'http://localhost:5123/cb' })
		);
		// The remote host is not shown as if it had been checked for this request.
		expect(viaLocal).toMatchObject({
			status: 'ok',
			client: { clientName: 'Desk', host: 'localhost' },
			redirectHost: 'localhost',
			local: true
		});
		const viaRemote = await load(
			alice,
			authorizeQuery({ client_id: mixed.clientId, redirect_uri: 'https://desk.example/cb' })
		);
		expect(viaRemote).toMatchObject({
			status: 'ok',
			client: { clientName: 'Desk', host: 'desk.example' },
			local: false
		});
	});

	it('issues a code only on Allow, for the signed-in writer, with what was ticked', async () => {
		const fields = authorizeQuery();
		fields.append('permission', 'suggest');
		// A permission that is not offered cannot be ticked in by hand.
		fields.append('permission', 'apply');
		const result = await answer('allow', alice, fields);
		const location = new URL(result.continueTo!);
		expect(location.origin + location.pathname).toBe(REDIRECT);
		expect(location.searchParams.get('state')).toBe('st-1');
		expect(location.searchParams.get('iss')).toBe(ORIGIN);

		const exchanged = await exchange(location.searchParams.get('code')!);
		expect(exchanged.ok && exchanged.tokens.permissions).toEqual(['read', 'suggest']);
		expect(exchanged.ok && (await resolveBearer(db, exchanged.tokens.accessToken))?.userId).toBe(
			alice
		);
		expect(await listGrants(db, bob)).toHaveLength(0);
	});

	it('grants reading alone when nothing else is ticked', async () => {
		const result = await answer('allow', alice);
		const exchanged = await exchange(new URL(result.continueTo!).searchParams.get('code')!);
		expect(exchanged.ok && exchanged.tokens.permissions).toEqual(['read']);
	});

	it('issues nothing on Do not allow', async () => {
		const result = await answer('deny', alice);
		const location = new URL(result.continueTo!);
		expect(location.searchParams.get('error')).toBe('access_denied');
		expect(location.searchParams.get('code')).toBeNull();
		expect(await db.select().from(oauthCodes)).toHaveLength(0);
	});

	it('issues nothing while the account switch is off', async () => {
		const carol = await addUser('carol@example.com', { mcpEnabled: false });
		expect(await load(carol)).toMatchObject({ status: 'ok', accessOn: false });
		const result = await answer('allow', carol);
		expect(result.status).toBe(403);
		expect(await db.select().from(oauthCodes)).toHaveLength(0);
	});

	it('checks the request again when it is answered', async () => {
		const tampered = authorizeQuery({ redirect_uri: 'https://evil.example/cb' });
		const result = await answer('allow', alice, tampered);
		expect(result.status).toBe(400);
		expect(result.continueTo).toBeUndefined();
		expect(await db.select().from(oauthCodes)).toHaveLength(0);
	});

	it('starts from what a connected app already has', async () => {
		await exchange(await codeFor(alice, ['read']));
		const data = await load(alice);
		expect(data.connected).toBe(true);
		expect(data.permissions.map((p) => p.checked)).toEqual([true, false]);
	});
});

describe('personal access tokens', () => {
	const make = (userId: string, overrides: Record<string, unknown> = {}) =>
		createPersonalToken(db, {
			userId,
			name: 'Night Script',
			permissions: ['suggest'],
			expiresInDays: 90,
			...overrides
		});
	const made = async (userId: string, overrides: Record<string, unknown> = {}) => {
		const result = await make(userId, overrides);
		if (!result.ok) throw new Error(result.reason);
		return result;
	};

	it('resolves to the writer who made it, with its name and permissions', async () => {
		const { token, id } = await made(alice);
		expect(token).toMatch(/^cdx_pat_/);
		const identity = await resolveBearer(db, token);
		expect(identity).toMatchObject({
			userId: alice,
			grantId: id,
			client: { clientName: 'Night Script', host: 'personal token' },
			permissions: ['read', 'suggest']
		});
		// Stored as a hash, in the table the app tokens are in.
		const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, alice));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'personal', grantId: id });
		expect(rows[0].tokenHash).not.toContain(token);
		const days = (rows[0].expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
		expect(Math.round(days)).toBe(90);
	});

	it('always reads, suggests only when asked, and never takes more', async () => {
		const reader = await made(alice, { name: 'Reader', permissions: [] });
		expect((await resolveBearer(db, reader.token))?.permissions).toEqual(['read']);
		const greedy = await made(alice, { name: 'Greedy', permissions: ['suggest', 'apply', 'x'] });
		expect((await resolveBearer(db, greedy.token))?.permissions).toEqual(['read', 'suggest']);
	});

	it('refuses a bad name, a repeat of a name, a bad lifetime and an account with access off', async () => {
		for (const bad of [
			{ name: '   ' },
			{ name: 'x'.repeat(61) },
			{ expiresInDays: 0 },
			{ expiresInDays: 9999 },
			{ expiresInDays: Number.NaN }
		]) {
			expect((await make(alice, bad)).ok).toBe(false);
		}
		await made(alice);
		expect(await make(alice, { name: 'night  script' })).toMatchObject({
			ok: false,
			reason: 'You already have a token with that name.'
		});
		// Another writer may use the same name.
		expect((await make(bob)).ok).toBe(true);
		const carol = await addUser('carol@example.com', { mcpEnabled: false });
		expect((await make(carol)).ok).toBe(false);
		expect(await db.select().from(apiTokens).where(eq(apiTokens.userId, carol))).toHaveLength(0);
	});

	it('is listed apart from the apps, for its own writer only', async () => {
		await connect(alice);
		const { id } = await made(alice);
		expect((await listGrants(db, alice)).map((grant) => grant.clientName)).toEqual([
			'Writing Desk'
		]);
		const [listed] = await listPersonalTokens(db, alice);
		expect(listed).toMatchObject({
			id,
			name: 'Night Script',
			permissions: ['read', 'suggest'],
			lastUsedAt: null
		});
		expect(listed.expiresAt!.getTime()).toBeGreaterThan(Date.now());
		expect(await listPersonalTokens(db, bob)).toEqual([]);
	});

	it('shows when it was last used', async () => {
		const { token } = await made(alice);
		await resolveBearer(db, token);
		const [listed] = await listPersonalTokens(db, alice);
		expect(listed.lastUsedAt).not.toBeNull();
	});

	it('cannot be used as an OAuth client or refreshed', async () => {
		const { token } = await made(alice);
		const [row] = await db.select().from(oauthClients).where(eq(oauthClients.kind, 'personal'));
		expect(row.redirectUris).toEqual([]);
		expect(await findClient(db, row.clientId)).toBeNull();
		expect(await refreshTokens(db, { refreshToken: token, clientId: row.clientId })).toEqual({
			ok: false
		});
		// The refusal did not cost the token its life.
		expect((await resolveBearer(db, token))?.userId).toBe(alice);
	});

	it('stops at expiry, and the clean-up takes it off the list', async () => {
		const { token, id } = await made(alice);
		const kept = await made(alice, { name: 'Kept' });
		await pool.query(
			`update api_tokens set expires_at = now() - interval '1 minute' where grant_id = $1`,
			[id]
		);
		expect(await resolveBearer(db, token)).toBeNull();
		expect((await listPersonalTokens(db, alice)).map((row) => row.name).sort()).toEqual([
			'Kept',
			'Night Script'
		]);
		await purgeExternalAccess(db);
		expect((await listPersonalTokens(db, alice)).map((row) => row.name)).toEqual(['Kept']);
		expect((await resolveBearer(db, kept.token))?.userId).toBe(alice);
	});

	it('is revoked by its own writer only', async () => {
		const { token, id } = await made(alice);
		expect(await revokeGrant(db, bob, id)).toBe(false);
		expect((await resolveBearer(db, token))?.userId).toBe(alice);
		expect(await revokeGrant(db, alice, id)).toBe(true);
		expect(await resolveBearer(db, token)).toBeNull();
		expect(await listPersonalTokens(db, alice)).toEqual([]);
	});

	it('is revoked when the writer turns access off', async () => {
		const { token } = await made(alice);
		const bobs = await made(bob);
		await setMcpAccountEnabled(db, alice, false);
		await setMcpAccountEnabled(db, alice, true);
		expect(await resolveBearer(db, token)).toBeNull();
		expect(await listPersonalTokens(db, alice)).toEqual([]);
		expect((await resolveBearer(db, bobs.token))?.userId).toBe(bob);
	});

	it('is revoked on a password change', async () => {
		await db
			.update(users)
			.set({ passwordHash: await hashPassword('the old password') })
			.where(eq(users.id, alice));
		const { token } = await made(alice);
		const bobs = await made(bob);
		const result = await changePassword(
			db,
			alice,
			'00000000-0000-4000-8000-000000000000',
			'the old password',
			'a brand new password'
		);
		expect(result.ok).toBe(true);
		expect(await resolveBearer(db, token)).toBeNull();
		expect((await resolveBearer(db, bobs.token))?.userId).toBe(bob);
	});

	it('is revoked on a password reset', async () => {
		const { token } = await made(alice);
		const tokenId = await requestPasswordReset(db, 'alice@example.com');
		const result = await resetPassword(db, await sentToken(db, tokenId!), 'a brand new password');
		expect(result.ok).toBe(true);
		expect(await resolveBearer(db, token)).toBeNull();
		expect(await listPersonalTokens(db, alice)).toEqual([]);
	});

	it('is revoked when the account is scheduled for deletion, and gone with the account', async () => {
		const { token } = await made(alice);
		await scheduleAccountDeletion(db, alice);
		await db.update(users).set({ deletionScheduledAt: null }).where(eq(users.id, alice));
		expect(await resolveBearer(db, token)).toBeNull();
		await made(bob);
		await pool.query('delete from users where id = $1', [bob]);
		expect(await db.select().from(apiTokens).where(eq(apiTokens.userId, bob))).toHaveLength(0);
		expect(await db.select().from(oauthGrants).where(eq(oauthGrants.userId, bob))).toHaveLength(0);
	});

	it('does not work for a suspended account', async () => {
		const { token } = await made(alice);
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, alice));
		expect(await resolveBearer(db, token)).toBeNull();
	});
});

describe('making a token on the account page', () => {
	type Answer = { status?: number; data?: { message?: string }; token?: string; tokenId?: string };
	const fields = { name: 'Night Script', permission: 'suggest', expiresInDays: '90' };
	const create = async (userId: string, extra: Record<string, string>) =>
		(await accountPage.actions.createToken(
			accountEvent(userId, { ...fields, ...extra }) as never
		)) as Answer;

	beforeEach(async () => {
		await db
			.update(users)
			.set({ passwordHash: await hashPassword('the right password') })
			.where(eq(users.id, alice));
	});

	it('asks for the password and shows the token once', async () => {
		const wrong = await create(alice, { password: 'not the password' });
		expect(wrong.status).toBe(400);
		expect(wrong.data?.message).toBe('That password is not right.');
		expect(await create(alice, {})).toMatchObject({ status: 400 });
		expect(await listPersonalTokens(db, alice)).toEqual([]);

		const right = await create(alice, { password: 'the right password' });
		expect(right.token).toMatch(/^cdx_pat_/);
		expect((await resolveBearer(db, right.token!))?.userId).toBe(alice);
		// Nothing the page loads afterwards holds the secret.
		const [listed] = await listPersonalTokens(db, alice);
		expect(JSON.stringify(listed)).not.toContain(right.token);
		expect(listed.id).toBe(right.tokenId);
	});

	it('asks for an authenticator code as well when two-factor is on', async () => {
		const begin = await beginEnrollment(db, alice, 'alice@example.com');
		if (!begin.ok) throw new Error(begin.reason);
		expect((await confirmEnrollment(db, alice, totpCode(begin.secret))).ok).toBe(true);

		const noCode = await create(alice, { password: 'the right password' });
		expect(noCode.status).toBe(400);
		const badCode = await create(alice, { password: 'the right password', code: '000000' });
		expect(badCode.data?.message).toContain('That code is not right.');
		// A right code does not make up for a wrong password.
		const next = totpCode(begin.secret, Date.now() + 30_000);
		expect((await create(alice, { password: 'wrong', code: next })).status).toBe(400);
		expect(await listPersonalTokens(db, alice)).toEqual([]);

		const right = await create(alice, { password: 'the right password', code: next });
		expect(right.token).toMatch(/^cdx_pat_/);
	});

	it('throttles password guesses with the other account actions', async () => {
		for (let i = 0; i < 10; i++) await create(alice, { password: 'guess' });
		const limited = await create(alice, { password: 'the right password' });
		expect(limited.status).toBe(429);
		expect(await listPersonalTokens(db, alice)).toEqual([]);
	});

	it('revokes only a token of the signed-in writer', async () => {
		const made = await createPersonalToken(db, {
			userId: alice,
			name: 'Night Script',
			permissions: [],
			expiresInDays: 30
		});
		if (!made.ok) throw new Error(made.reason);
		const asBob = (await accountPage.actions.revokePersonalToken(
			accountEvent(bob, { grantId: made.id }) as never
		)) as Answer;
		expect(asBob.status).toBe(400);
		expect((await resolveBearer(db, made.token))?.userId).toBe(alice);
		await accountPage.actions.revokePersonalToken(
			accountEvent(alice, { grantId: made.id }) as never
		);
		expect(await resolveBearer(db, made.token)).toBeNull();
	});
});

describe('the account page actions', () => {
	it('asks for the password, and a code with two-factor, to turn access on', async () => {
		const carol = await addUser('carol@example.com', {
			mcpEnabled: false,
			passwordHash: await hashPassword('carols password')
		});
		const turnOn = async (extra: Record<string, string>) =>
			(await accountPage.actions.setExternalAccess(
				accountEvent(carol, { enabled: 'on', ...extra }) as never
			)) as { status?: number; data?: { message?: string } };
		const isOn = async () =>
			(await db.select({ on: users.mcpEnabled }).from(users).where(eq(users.id, carol)))[0].on;

		// A borrowed session alone cannot open the account to apps.
		expect((await turnOn({})).status).toBe(400);
		const wrong = await turnOn({ password: 'not it' });
		expect(wrong.data?.message).toBe('That password is not right.');
		expect(await isOn()).toBe(false);

		const begin = await beginEnrollment(db, carol, 'carol@example.com');
		if (!begin.ok) throw new Error(begin.reason);
		expect((await confirmEnrollment(db, carol, totpCode(begin.secret))).ok).toBe(true);
		expect((await turnOn({ password: 'carols password' })).status).toBe(400);
		expect((await turnOn({ password: 'carols password', code: '000000' })).status).toBe(400);
		expect(await isOn()).toBe(false);
		const next = totpCode(begin.secret, Date.now() + 30_000);
		expect((await turnOn({ password: 'carols password', code: next })).status).toBeUndefined();
		expect(await isOn()).toBe(true);

		// Turning it off asks for nothing.
		await accountPage.actions.setExternalAccess(accountEvent(carol, {}) as never);
		expect(await isOn()).toBe(false);
	});

	it('turns access on and off, disconnecting on the way out', async () => {
		const carol = await addUser('carol@example.com', {
			mcpEnabled: false,
			passwordHash: await hashPassword('carols password')
		});
		await accountPage.actions.setExternalAccess(
			accountEvent(carol, { enabled: 'on', password: 'carols password' }) as never
		);
		client = await newClient();
		const tokens = await connect(carol);
		await accountPage.actions.setExternalAccess(accountEvent(carol, {}) as never);
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
		const [row] = await db.select({ on: users.mcpEnabled }).from(users).where(eq(users.id, carol));
		expect(row.on).toBe(false);
	});

	it('disconnects only an app of the signed-in writer', async () => {
		const tokens = await connect(alice);
		const [grant] = await listGrants(db, alice);
		const asBob = (await accountPage.actions.revokeApp(
			accountEvent(bob, { grantId: grant.id }) as never
		)) as { status?: number };
		expect(asBob.status).toBe(400);
		expect((await resolveBearer(db, tokens.accessToken))?.userId).toBe(alice);
		const notAnId = (await accountPage.actions.revokeApp(
			accountEvent(alice, { grantId: 'nope' }) as never
		)) as { status?: number };
		expect(notAnId.status).toBe(400);

		await accountPage.actions.revokeApp(accountEvent(alice, { grantId: grant.id }) as never);
		expect(await resolveBearer(db, tokens.accessToken)).toBeNull();
	});
});
