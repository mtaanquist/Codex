import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { effectiveSmtp, saveSmtp, smtpView } from '../../src/lib/server/settings';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
const SMTP_ENV = [
	'SMTP_HOST',
	'SMTP_PORT',
	'SMTP_SECURE',
	'SMTP_USER',
	'SMTP_PASSWORD',
	'SMTP_FROM'
];

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	process.env.APP_SECRET = 'a-test-app-secret';
});

beforeEach(async () => {
	await pool.query('truncate table app_settings');
	for (const key of SMTP_ENV) delete process.env[key];
});

afterAll(async () => {
	await pool.end();
	delete process.env.APP_SECRET;
});

describe('effectiveSmtp', () => {
	it('is null when neither the database nor the environment configures it', async () => {
		expect(await effectiveSmtp(db)).toBeNull();
	});

	it('falls back to the environment when the database has nothing', async () => {
		process.env.SMTP_HOST = 'mail.env.test';
		process.env.SMTP_PORT = '2525';
		process.env.SMTP_USER = 'envuser';
		process.env.SMTP_PASSWORD = 'envpass';
		const config = await effectiveSmtp(db);
		expect(config).toMatchObject({ host: 'mail.env.test', port: 2525, password: 'envpass' });
		expect((await smtpView(db)).source).toBe('environment');
	});

	it('prefers stored settings over the environment and decrypts the password', async () => {
		process.env.SMTP_HOST = 'mail.env.test';
		await saveSmtp(db, {
			host: 'mail.db.test',
			port: 465,
			secure: true,
			user: 'dbuser',
			from: 'Codex <no-reply@db.test>',
			password: 'db-secret'
		});
		const config = await effectiveSmtp(db);
		expect(config).toMatchObject({ host: 'mail.db.test', secure: true, password: 'db-secret' });
	});
});

describe('saveSmtp', () => {
	it('does not store or surface the password in clear', async () => {
		await saveSmtp(db, {
			host: 'mail.db.test',
			port: 587,
			secure: false,
			user: 'u',
			from: '',
			password: 'top-secret'
		});
		const [row] = await pool
			.query('select value from app_settings where key = $1', ['smtp'])
			.then((r) => r.rows);
		expect(JSON.stringify(row.value)).not.toContain('top-secret');

		const view = await smtpView(db);
		expect(view.hasPassword).toBe(true);
		expect(view).not.toHaveProperty('password');
	});

	it('keeps the existing password when a blank one is submitted', async () => {
		await saveSmtp(db, {
			host: 'mail.db.test',
			port: 587,
			secure: false,
			user: 'u',
			from: '',
			password: 'keep-me'
		});
		// Edit another field, leaving the password blank.
		await saveSmtp(db, {
			host: 'mail.db.test',
			port: 2525,
			secure: false,
			user: 'u',
			from: '',
			password: ''
		});
		const config = await effectiveSmtp(db);
		expect(config).toMatchObject({ port: 2525, password: 'keep-me' });
	});

	it('rejects a missing host', async () => {
		expect(
			(await saveSmtp(db, { host: '', port: 587, secure: false, user: '', from: '', password: '' }))
				.ok
		).toBe(false);
	});
});
