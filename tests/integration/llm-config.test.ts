import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The config decrypts the API key on resolve, so a secret must be set.
process.env.APP_SECRET = process.env.APP_SECRET || 'llm-config-test-secret';

const {
	accountLlmView,
	assistantLayout,
	resolveLlmConfig,
	saveAccountLlmConfig,
	saveStoryLlmOverride
} = await import('../../src/lib/server/llm/config');
const { egressPolicy, saveEgressPolicy } = await import('../../src/lib/server/llm/egress');

let pool: pg.Pool;
let db: Database;
let userId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table app_settings, stories, universes, users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'w@example.com', displayName: 'Wren', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
});

afterAll(async () => {
	await pool.end();
});

describe('account config round-trip', () => {
	it('saves, never exposes the key in the view, and decrypts it on resolve', async () => {
		const result = await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: 'Muse',
			persona: 'concise',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk-secret-123',
			models: { chat: 'gpt-4o-mini' },
			toolCallBudget: 12
		});
		expect(result.ok).toBe(true);

		const view = await accountLlmView(db, userId);
		expect(view).toMatchObject({
			configured: true,
			enabled: true,
			assistantName: 'Muse',
			persona: 'concise',
			endpoint: 'https://api.example.com/v1',
			hasKey: true,
			toolCallBudget: 12
		});
		expect(JSON.stringify(view)).not.toContain('sk-secret-123');

		const resolved = await resolveLlmConfig(db, userId);
		expect(resolved.gate.surfacesEnabled).toBe(true);
		expect(resolved.config.apiKey).toBe('sk-secret-123');
		expect(resolved.config.models.chat).toBe('gpt-4o-mini');
		expect(resolved.config.assistantName).toBe('Muse');
		expect(resolved.config.persona).toBe('concise');
	});

	it('cleans the name and falls back to the default persona for an unknown value', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '  The   Muse \n',
			// An invalid persona id is coerced to the default on save.
			persona: 'wildcard' as never,
			endpoint: 'https://api.example.com/v1',
			apiKey: '',
			models: {},
			toolCallBudget: 8
		});
		const view = await accountLlmView(db, userId);
		expect(view.assistantName).toBe('The Muse');
		expect(view.persona).toBe('balanced');
	});

	it('defaults a config saved without a provider to custom', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: '',
			models: {},
			toolCallBudget: 8
		});
		expect((await accountLlmView(db, userId)).provider).toBe('custom');
		expect((await resolveLlmConfig(db, userId)).config.provider).toBe('custom');
	});

	it('a preset owns its endpoint: the submitted URL is ignored', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			provider: 'anthropic',
			endpoint: 'https://evil.example.com/v1',
			apiKey: 'sk-ant-x',
			models: {},
			toolCallBudget: 8,
			// A preset never carries a manual capability opt-out.
			supportsTools: false
		});
		const view = await accountLlmView(db, userId);
		expect(view.provider).toBe('anthropic');
		expect(view.endpoint).toBe('https://api.anthropic.com');
		expect(view.supportsTools).toBe(true);
		expect(view.supportsStreaming).toBe(true);
	});

	it('switching back to custom frees the endpoint field again', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			provider: 'openrouter',
			endpoint: '',
			apiKey: 'sk-or-x',
			models: {},
			toolCallBudget: 8
		});
		expect((await accountLlmView(db, userId)).endpoint).toBe('https://openrouter.ai/api/v1');
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			provider: 'custom',
			endpoint: 'http://ollama.local:11434/v1',
			apiKey: '',
			models: {},
			toolCallBudget: 8
		});
		const view = await accountLlmView(db, userId);
		expect(view.provider).toBe('custom');
		expect(view.endpoint).toBe('http://ollama.local:11434/v1');
	});

	it('a blank key on save keeps the stored one', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk-original',
			models: {},
			toolCallBudget: 8
		});
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v2',
			apiKey: '',
			models: {},
			toolCallBudget: 8
		});
		const resolved = await resolveLlmConfig(db, userId);
		expect(resolved.config.endpoint).toBe('https://api.example.com/v2');
		expect(resolved.config.apiKey).toBe('sk-original');
		expect((await accountLlmView(db, userId)).hasKey).toBe(true);
	});

	it('rejects a non-http endpoint', async () => {
		const result = await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'ftp://nope',
			apiKey: '',
			models: {},
			toolCallBudget: 8
		});
		expect(result.ok).toBe(false);
	});
});

describe('story override merge', () => {
	beforeEach(async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'account-model', reviewer: 'account-reviewer' },
			toolCallBudget: 8
		});
	});

	it('a per-story model wins over the account model', async () => {
		await saveStoryLlmOverride(db, storyId, { models: { chat: 'story-model' } });
		const resolved = await resolveLlmConfig(db, userId, storyId);
		expect(resolved.config.models.chat).toBe('story-model');
		// Roles the story did not override still come from the account.
		expect(resolved.config.models.reviewer).toBe('account-reviewer');
	});

	it('a story mute subtracts the surfaces but keeps the tab', async () => {
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		const resolved = await resolveLlmConfig(db, userId, storyId);
		expect(resolved.gate.tabEnabled).toBe(true);
		expect(resolved.gate.surfacesEnabled).toBe(false);
	});

	it('clearing the mute with null restores the account default', async () => {
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		await saveStoryLlmOverride(db, storyId, { enabled: null });
		const resolved = await resolveLlmConfig(db, userId, storyId);
		expect(resolved.gate.surfacesEnabled).toBe(true);
	});

	it('account-off stays dark even with a story override present', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: false,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: '',
			models: { chat: 'account-model' },
			toolCallBudget: 8
		});
		await saveStoryLlmOverride(db, storyId, { models: { chat: 'story-model' } });
		const resolved = await resolveLlmConfig(db, userId, storyId);
		expect(resolved.gate.surfacesEnabled).toBe(false);
		expect(resolved.gate.tabEnabled).toBe(false);
	});
});

describe('assistant layout (the editor page gate)', () => {
	it('renders no Assistant when the account is unconfigured', async () => {
		const layout = await assistantLayout(db, userId, storyId);
		expect(layout).toEqual({
			tabEnabled: false,
			surfacesEnabled: false,
			muted: false,
			name: 'Assistant'
		});
	});

	it('shows the tab and live surfaces when configured and enabled', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: 'Muse',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'm' },
			toolCallBudget: 8
		});
		const layout = await assistantLayout(db, userId, storyId);
		expect(layout).toEqual({
			tabEnabled: true,
			surfacesEnabled: true,
			muted: false,
			name: 'Muse'
		});
	});

	it('keeps the tab but reports muted when the story is muted', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: 'Muse',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'm' },
			toolCallBudget: 8
		});
		await saveStoryLlmOverride(db, storyId, { enabled: false });
		const layout = await assistantLayout(db, userId, storyId);
		expect(layout.tabEnabled).toBe(true);
		expect(layout.surfacesEnabled).toBe(false);
		expect(layout.muted).toBe(true);
	});

	it('stays dark when the master switch is off, ignoring any story override', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: false,
			assistantName: 'Muse',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { chat: 'm' },
			toolCallBudget: 8
		});
		const layout = await assistantLayout(db, userId, storyId);
		expect(layout.tabEnabled).toBe(false);
		expect(layout.surfacesEnabled).toBe(false);
		expect(layout.muted).toBe(false);
	});
});

describe('egress policy settings', () => {
	it('defaults to block-private with an empty allowlist', async () => {
		expect(await egressPolicy(db)).toEqual({ policy: 'block-private', allowlist: [] });
	});

	it('saves and reads back a normalised allowlist', async () => {
		const result = await saveEgressPolicy(db, {
			policy: 'allowlist',
			allowlist: ['Ollama.Internal ', 'ollama.internal', '']
		});
		expect(result.ok).toBe(true);
		expect(await egressPolicy(db)).toEqual({
			policy: 'allowlist',
			allowlist: ['ollama.internal']
		});
	});

	it('refuses an allowlist policy with no hosts', async () => {
		const result = await saveEgressPolicy(db, { policy: 'allowlist', allowlist: [] });
		expect(result.ok).toBe(false);
	});
});
