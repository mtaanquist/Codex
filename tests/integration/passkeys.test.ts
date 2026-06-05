import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { users, webauthnCredentials } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The challenge tokens are signed with APP_SECRET; the value only needs to be
// consistent within the run.
process.env.APP_SECRET = process.env.APP_SECRET || 'passkeys-test-secret';

const {
	finishPasskeyRegistration,
	finishPasskeySignIn,
	listPasskeys,
	removePasskey,
	startPasskeyRegistration,
	startPasskeySignIn
} = await import('../../src/lib/server/passkeys');
const { purgeAccount } = await import('../../src/lib/server/account-deletion');

const ORIGIN = 'http://localhost:5173';

let pool: pg.Pool;
let db: Database;
let userId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table webauthn_credentials, auth_tokens, users cascade');
	const [user] = await db
		.insert(users)
		.values({
			email: 'pk@example.com',
			displayName: 'PK',
			passwordHash: 'x',
			role: 'user',
			emailVerifiedAt: new Date(),
			approvedAt: new Date()
		})
		.returning({ id: users.id });
	userId = user.id;
});

afterAll(async () => {
	await pool.end();
});

async function insertCredential(name = 'phone') {
	const [row] = await db
		.insert(webauthnCredentials)
		.values({
			userId,
			credentialId: `cred-${crypto.randomUUID()}`,
			publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
			name
		})
		.returning();
	return row;
}

describe('registration options', () => {
	it('asks for a discoverable, user-verified credential and excludes existing ones', async () => {
		const existing = await insertCredential();
		const { options, challengeToken } = await startPasskeyRegistration(
			db,
			{ id: userId, email: 'pk@example.com', displayName: 'PK' },
			ORIGIN
		);
		expect(options.rp.id).toBe('localhost');
		expect(options.authenticatorSelection?.residentKey).toBe('required');
		expect(options.authenticatorSelection?.userVerification).toBe('required');
		expect(options.excludeCredentials?.map((c) => c.id)).toContain(existing.credentialId);
		expect(challengeToken).toContain('.');
	});
});

describe('finishPasskeyRegistration', () => {
	it('refuses a missing or expired challenge', async () => {
		const garbage = { id: 'x' } as never;
		expect(
			await finishPasskeyRegistration(db, userId, garbage, undefined, ORIGIN, 'k')
		).toMatchObject({ ok: false, reason: expect.stringContaining('timed out') });
		expect(
			await finishPasskeyRegistration(db, userId, garbage, 'not-a-signed-token', ORIGIN, 'k')
		).toMatchObject({ ok: false });
	});

	it("refuses another user's challenge", async () => {
		const { challengeToken } = await startPasskeyRegistration(
			db,
			{ id: crypto.randomUUID(), email: 'else@example.com', displayName: 'E' },
			ORIGIN
		);
		const garbage = { id: 'x' } as never;
		expect(
			await finishPasskeyRegistration(db, userId, garbage, challengeToken, ORIGIN, 'k')
		).toMatchObject({ ok: false, reason: expect.stringContaining('timed out') });
	});

	it('refuses a response that does not verify', async () => {
		const { challengeToken } = await startPasskeyRegistration(
			db,
			{ id: userId, email: 'pk@example.com', displayName: 'PK' },
			ORIGIN
		);
		const garbage = { id: 'x', rawId: 'x', response: {}, type: 'public-key' } as never;
		const result = await finishPasskeyRegistration(
			db,
			userId,
			garbage,
			challengeToken,
			ORIGIN,
			'k'
		);
		expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('verified') });
		expect(await listPasskeys(db, userId)).toHaveLength(0);
	});
});

describe('finishPasskeySignIn', () => {
	it('treats an unknown credential or stale challenge as invalid', async () => {
		const { challengeToken } = await startPasskeySignIn(ORIGIN);
		const unknown = { id: 'never-registered', response: {} } as never;
		expect(await finishPasskeySignIn(db, unknown, challengeToken, ORIGIN)).toMatchObject({
			status: 'invalid'
		});
		const credential = await insertCredential();
		const known = { id: credential.credentialId, response: {} } as never;
		expect(await finishPasskeySignIn(db, known, undefined, ORIGIN)).toMatchObject({
			status: 'invalid'
		});
		// A known credential with a fresh challenge still fails on the signature.
		const { challengeToken: fresh } = await startPasskeySignIn(ORIGIN);
		expect(await finishPasskeySignIn(db, known, fresh, ORIGIN)).toMatchObject({
			status: 'invalid'
		});
	});
});

describe('list and remove', () => {
	it('lists own passkeys and removes only with the right owner', async () => {
		const credential = await insertCredential('laptop');
		const listed = await listPasskeys(db, userId);
		expect(listed).toHaveLength(1);
		expect(listed[0].name).toBe('laptop');

		expect(await removePasskey(db, crypto.randomUUID(), credential.id)).toBe(false);
		expect(await removePasskey(db, userId, credential.id)).toBe(true);
		expect(await listPasskeys(db, userId)).toHaveLength(0);
	});
});

describe('purgeAccount', () => {
	it('removes the credentials with the account', async () => {
		await insertCredential();
		await purgeAccount(db, userId, null);
		expect(
			await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId))
		).toEqual([]);
	});
});
