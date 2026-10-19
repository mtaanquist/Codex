import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { users } from '../../src/lib/server/db/schema';
import { requestPasswordReset } from '../../src/lib/server/password-reset';
import { consumeToken, peekToken, reserveToken, revokeTokens } from '../../src/lib/server/tokens';
import { resolveEmailJob, type EmailJob } from '../../src/lib/server/token-email';
import type { EmailMessage } from '../../src/lib/server/email';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let userId: string;
const origin = 'https://codex.example';

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table sessions, auth_tokens, users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'mail@example.com', displayName: 'Mail', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
});

afterAll(async () => {
	await pool.end();
});

function linkToken(text: string, path: string): string {
	const match = text.match(new RegExp(`${origin}${path}\\?token=(\\S+)`));
	if (!match) throw new Error(`no ${path} link in: ${text}`);
	return match[1];
}

async function sent(job: EmailJob): Promise<EmailMessage> {
	const resolved = await resolveEmailJob(db, job);
	if (!('message' in resolved)) throw new Error(`skipped: ${resolved.skipped}`);
	return resolved.message;
}

describe('token emails', () => {
	it('queues no usable token; the worker writes a working link at send time', async () => {
		const tokenId = (await requestPasswordReset(db, 'mail@example.com'))!;
		const job = { tokenId, to: 'mail@example.com', origin };
		// The queued job is all pg-boss stores: nothing in it opens the account.
		for (const value of Object.values(job)) {
			expect(await peekToken(db, 'password_reset', value)).toBeNull();
		}

		const message = await sent(job);
		expect(message.to).toBe('mail@example.com');
		expect(message.subject).toBe('Reset your password');
		const token = linkToken(message.text, '/reset-password');
		expect(await consumeToken(db, 'password_reset', token)).toBe(userId);
	});

	it('builds each kind of link', async () => {
		const cases = [
			['email_verify', '/verify-email'],
			['email_change', '/confirm-email-change'],
			['deletion_cancel', '/cancel-deletion']
		] as const;
		for (const [kind, path] of cases) {
			const tokenId = await reserveToken(db, userId, kind, 60);
			const message = await sent({ tokenId, to: 'mail@example.com', origin });
			expect(await peekToken(db, kind, linkToken(message.text, path))).toBe(userId);
		}
	});

	it('a retried send replaces the link, so only the last one works', async () => {
		const tokenId = await reserveToken(db, userId, 'email_verify', 60);
		const job = { tokenId, to: 'mail@example.com', origin };
		const first = linkToken((await sent(job)).text, '/verify-email');
		const second = linkToken((await sent(job)).text, '/verify-email');
		expect(await peekToken(db, 'email_verify', first)).toBeNull();
		expect(await peekToken(db, 'email_verify', second)).toBe(userId);
	});

	it('skips a token revoked before the send, saying so', async () => {
		const tokenId = await reserveToken(db, userId, 'email_change', 60);
		await revokeTokens(db, userId, 'email_change');
		expect(await resolveEmailJob(db, { tokenId, to: 'mail@example.com', origin })).toEqual({
			skipped: 'revoked'
		});
	});

	it('skips a token that expired before the send, saying so', async () => {
		const tokenId = await reserveToken(db, userId, 'password_reset', -1);
		expect(await resolveEmailJob(db, { tokenId, to: 'mail@example.com', origin })).toEqual({
			skipped: 'expired'
		});
	});

	it('passes a finished message through unchanged', async () => {
		const message = { to: 'mail@example.com', subject: 'Hi', text: 'Body' };
		expect(await resolveEmailJob(db, message)).toEqual({ message });
	});
});
