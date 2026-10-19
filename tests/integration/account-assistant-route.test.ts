import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The Assistant model and endpoint forms, called as the real account actions
// against the test database, with what they stored read back afterwards.

vi.mock('$lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

const { db, pool } = (await import('$lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { accountLlmView } = await import('$lib/server/llm/config');
const { actions } = await import('../../src/routes/account/[[section]]/+page.server');

let userId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	const [user] = await db
		.insert(users)
		.values({
			email: 'assistant-form@example.com',
			displayName: 'A',
			passwordHash: 'x',
			role: 'user',
			llmConfig: { provider: 'custom', endpoint: 'http://local/v1' }
		})
		.returning({ id: users.id });
	userId = user.id;
});

afterAll(async () => {
	await pool.end();
});

// Stands a stored config up by hand, as an earlier save would have left it.
async function storeConfig(config: Record<string, unknown>) {
	await db
		.update(users)
		.set({ llmConfig: { provider: 'custom', endpoint: 'http://local/v1', ...config } })
		.where(eq(users.id, userId));
}

function call(action: keyof typeof actions, form: FormData) {
	const run = actions[action] as (event: unknown) => Promise<unknown>;
	return run({ request: { formData: async () => form }, locals: { user: { id: userId } } });
}

function saveModels(fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return call('saveAssistantModels', form);
}

function saveEndpoint(fields: Record<string, string>) {
	const form = new FormData();
	form.set('provider', 'custom');
	form.set('endpoint', 'http://local/v1');
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return call('saveAssistantEndpoint', form);
}

async function stored() {
	return await accountLlmView(db, userId);
}

describe('saveAssistantModels tuning', () => {
	it('stores the three thinking states and a temperature per role', async () => {
		await saveModels({
			reviewer: 'big-model',
			'reviewer-thinking': 'on',
			'reviewer-temperature': '0.2',
			'continuation-thinking': 'off',
			'continuation-temperature': '',
			'chat-thinking': ''
		});
		const { tuning } = await stored();
		expect(tuning.reviewer).toEqual({ thinking: true, temperature: 0.2 });
		expect(tuning.continuation).toEqual({ thinking: false });
		expect(tuning.chat).toBeUndefined();
	});

	it('drops a temperature the writer emptied, and junk in the box', async () => {
		await storeConfig({ tuning: { reviewer: { temperature: 0.2 }, chat: { temperature: 0.9 } } });
		await saveModels({ 'reviewer-temperature': '', 'chat-temperature': 'warm' });
		const { tuning } = await stored();
		expect(tuning.reviewer).toBeUndefined();
		expect(tuning.chat).toBeUndefined();
	});

	it('keeps tuning the form did not show: effort survives a temperature save', async () => {
		// The effort control only renders for the Claude provider, so a save from
		// an OpenAI-compatible endpoint carries no effort field at all.
		await storeConfig({ tuning: { reviewer: { effort: 'high', thinking: true } } });
		await saveModels({ 'reviewer-temperature': '0.2', 'reviewer-thinking': 'on' });
		expect((await stored()).tuning.reviewer).toEqual({
			effort: 'high',
			thinking: true,
			temperature: 0.2
		});
	});

	it('keeps a stored temperature when the form shows effort instead', async () => {
		await storeConfig({ tuning: { coauthor: { temperature: 0.7 } } });
		await saveModels({ 'coauthor-effort': 'low', 'coauthor-thinking': 'off' });
		expect((await stored()).tuning.coauthor).toEqual({
			temperature: 0.7,
			effort: 'low',
			thinking: false
		});
	});

	it('carries the utility role through like any other', async () => {
		await saveModels({ utility: 'small-model', 'utility-thinking': 'off' });
		const view = await stored();
		expect(view.models).toEqual({ utility: 'small-model' });
		expect(view.tuning.utility).toEqual({ thinking: false });
	});
});

describe('saveAssistantModels context windows', () => {
	it('stores a number typed into a rendered box', async () => {
		await saveModels({ reviewer: 'big-model', 'context-big-model': '32768' });
		expect((await stored()).modelContextManual).toEqual({ 'big-model': 32768 });
	});

	it('clears the entry when the writer empties a rendered box', async () => {
		await storeConfig({ modelContextManual: { 'big-model': 32768 } });
		await saveModels({ reviewer: 'big-model', 'context-big-model': '' });
		expect((await stored()).modelContextManual?.['big-model']).toBeUndefined();
	});

	it('keeps entries for models the form did not render', async () => {
		// The form only renders a box for the models currently picked for a role,
		// so a save from a form showing one model must not wipe the other's entry.
		await storeConfig({ modelContextManual: { 'big-model': 32768, 'small-model': 8192 } });
		await saveModels({ reviewer: 'big-model', 'context-big-model': '65536' });
		expect((await stored()).modelContextManual).toEqual({
			'big-model': 65536,
			'small-model': 8192
		});
	});
});

describe('saveAssistantEndpoint spend fields', () => {
	it('stores the amounts typed into the boxes', async () => {
		await saveEndpoint({ spendCapUsd: '5', spendWarnUsd: '1.50' });
		const view = await stored();
		expect(view.spendCapUsd).toBe(5);
		expect(view.spendWarnUsd).toBe(1.5);
	});

	it('clears a figure the writer emptied', async () => {
		await storeConfig({ spendCapUsd: 5, spendWarnUsd: 1.5 });
		await saveEndpoint({ spendCapUsd: '', spendWarnUsd: '' });
		const view = await stored();
		expect(view.spendCapUsd).toBeUndefined();
		expect(view.spendWarnUsd).toBeUndefined();
	});

	it('refuses junk rather than clearing the figure in silence', async () => {
		await storeConfig({ spendCapUsd: 5 });
		const result = (await saveEndpoint({ spendCapUsd: 'abc' })) as {
			status?: number;
			data?: { scope?: string; message?: string };
		};
		expect(result.status).toBe(400);
		expect(result.data?.scope).toBe('assistant-endpoint');
		expect(result.data?.message).toBe('Enter an amount in dollars, or leave it blank.');
		expect((await stored()).spendCapUsd).toBe(5);
	});

	it('refuses a negative amount', async () => {
		await storeConfig({ spendWarnUsd: 1.5 });
		const result = (await saveEndpoint({ spendWarnUsd: '-5' })) as { status?: number };
		expect(result.status).toBe(400);
		expect((await stored()).spendWarnUsd).toBe(1.5);
	});
});
