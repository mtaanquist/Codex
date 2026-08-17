import { describe, it, expect, beforeEach, vi } from 'vitest';

// The route module opens a real database pool on import and calls the account
// helper; neither is needed to prove the rate-limit guard fires, so stub both.
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/account', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/account')>()),
	changePassword: vi.fn(async () => ({ ok: true }))
}));

// The models form saves through the config module; stubbing it captures what
// the action would store, and lets a test stand a stored config up by hand.
const storedConfig = {
	tuning: {} as Record<string, unknown>,
	models: {},
	modelContextManual: {} as Record<string, number>
};
const savedInputs: {
	tuning?: Record<string, unknown>;
	models?: Record<string, string>;
	modelContextManual?: Record<string, number>;
	spendCapUsd?: number | null;
	spendWarnUsd?: number | null;
}[] = [];
vi.mock('$lib/server/llm/config', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/llm/config')>()),
	accountLlmView: vi.fn(async () => ({
		configured: true,
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		provider: 'custom',
		endpoint: 'http://local/v1',
		hasKey: false,
		models: storedConfig.models,
		tuning: storedConfig.tuning,
		toolCallBudget: 8,
		toolProfile: 'full',
		modelContextManual: storedConfig.modelContextManual
	})),
	saveAccountLlmConfig: vi.fn(async (_db: unknown, _userId: string, input: unknown) => {
		savedInputs.push(input as (typeof savedInputs)[number]);
		return { ok: true };
	})
}));

const { actions } = await import('./+page.server');

function saveModels(fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	const call = actions.saveAssistantModels as (event: unknown) => Promise<unknown>;
	return call({
		request: { formData: async () => form },
		locals: { user: { id: 'tuning-test-user' } }
	});
}

function lastTuning(): Record<string, unknown> {
	return savedInputs[savedInputs.length - 1].tuning ?? {};
}

describe('saveAssistantModels tuning', () => {
	beforeEach(() => {
		savedInputs.length = 0;
		storedConfig.tuning = {};
		storedConfig.models = {};
		storedConfig.modelContextManual = {};
	});

	it('stores the three thinking states and a temperature per role', async () => {
		await saveModels({
			reviewer: 'big-model',
			'reviewer-thinking': 'on',
			'reviewer-temperature': '0.2',
			'continuation-thinking': 'off',
			'continuation-temperature': '',
			'chat-thinking': ''
		});
		expect(lastTuning().reviewer).toEqual({ thinking: true, temperature: 0.2 });
		expect(lastTuning().continuation).toEqual({ thinking: false });
		expect(lastTuning().chat).toBeUndefined();
	});

	it('drops a temperature the writer emptied, and junk in the box', async () => {
		storedConfig.tuning = { reviewer: { temperature: 0.2 }, chat: { temperature: 0.9 } };
		await saveModels({ 'reviewer-temperature': '', 'chat-temperature': 'warm' });
		expect(lastTuning().reviewer).toBeUndefined();
		expect(lastTuning().chat).toBeUndefined();
	});

	it('keeps tuning the form did not show: effort survives a temperature save', async () => {
		// The effort control only renders for the Claude provider, so a save from
		// an OpenAI-compatible endpoint carries no effort field at all.
		storedConfig.tuning = { reviewer: { effort: 'high', thinking: true } };
		await saveModels({ 'reviewer-temperature': '0.2', 'reviewer-thinking': 'on' });
		expect(lastTuning().reviewer).toEqual({ effort: 'high', thinking: true, temperature: 0.2 });
	});

	it('keeps a stored temperature when the form shows effort instead', async () => {
		storedConfig.tuning = { coauthor: { temperature: 0.7 } };
		await saveModels({ 'coauthor-effort': 'low', 'coauthor-thinking': 'off' });
		expect(lastTuning().coauthor).toEqual({ temperature: 0.7, effort: 'low', thinking: false });
	});

	it('carries the utility role through like any other', async () => {
		await saveModels({ utility: 'small-model', 'utility-thinking': 'off' });
		expect(savedInputs[0].models).toEqual({ utility: 'small-model' });
		expect(lastTuning().utility).toEqual({ thinking: false });
	});
});

describe('saveAssistantModels context windows', () => {
	beforeEach(() => {
		savedInputs.length = 0;
		storedConfig.tuning = {};
		storedConfig.models = {};
		storedConfig.modelContextManual = {};
	});

	function lastContext(): Record<string, number> {
		return savedInputs[savedInputs.length - 1].modelContextManual ?? {};
	}

	it('stores a number typed into a rendered box', async () => {
		await saveModels({ reviewer: 'big-model', 'context-big-model': '32768' });
		expect(lastContext()).toEqual({ 'big-model': 32768 });
	});

	it('clears the entry when the writer empties a rendered box', async () => {
		storedConfig.modelContextManual = { 'big-model': 32768 };
		await saveModels({ reviewer: 'big-model', 'context-big-model': '' });
		expect(lastContext()['big-model']).toBeUndefined();
	});

	it('keeps entries for models the form did not render', async () => {
		// The form only renders a box for the models currently picked for a role,
		// so a save from a form showing one model must not wipe the other's entry.
		storedConfig.modelContextManual = { 'big-model': 32768, 'small-model': 8192 };
		await saveModels({ reviewer: 'big-model', 'context-big-model': '65536' });
		expect(lastContext()).toEqual({ 'big-model': 65536, 'small-model': 8192 });
	});
});

function saveEndpoint(fields: Record<string, string>) {
	const form = new FormData();
	form.set('provider', 'custom');
	form.set('endpoint', 'http://local/v1');
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	const call = actions.saveAssistantEndpoint as (event: unknown) => Promise<unknown>;
	return call({
		request: { formData: async () => form },
		locals: { user: { id: 'spend-test-user' } }
	});
}

describe('saveAssistantEndpoint spend fields', () => {
	beforeEach(() => {
		savedInputs.length = 0;
	});

	it('stores the amounts typed into the boxes', async () => {
		await saveEndpoint({ spendCapUsd: '5', spendWarnUsd: '1.50' });
		expect(savedInputs[0].spendCapUsd).toBe(5);
		expect(savedInputs[0].spendWarnUsd).toBe(1.5);
	});

	it('clears a figure the writer emptied', async () => {
		await saveEndpoint({ spendCapUsd: '', spendWarnUsd: '' });
		expect(savedInputs[0].spendCapUsd).toBeNull();
		expect(savedInputs[0].spendWarnUsd).toBeNull();
	});

	it('refuses junk rather than clearing the figure in silence', async () => {
		const result = (await saveEndpoint({ spendCapUsd: 'abc' })) as {
			status?: number;
			data?: { scope?: string; message?: string };
		};
		expect(result.status).toBe(400);
		expect(result.data?.scope).toBe('assistant-endpoint');
		expect(result.data?.message).toBe('Enter an amount in dollars, or leave it blank.');
		expect(savedInputs).toHaveLength(0);
	});

	it('refuses a negative amount', async () => {
		const result = (await saveEndpoint({ spendWarnUsd: '-5' })) as { status?: number };
		expect(result.status).toBe(400);
		expect(savedInputs).toHaveLength(0);
	});
});

function changePasswordEvent(userId: string) {
	const form = new FormData();
	form.set('currentPassword', 'current-password');
	form.set('newPassword', 'a-new-password');
	return {
		request: { formData: async () => form },
		locals: { user: { id: userId }, session: { id: 'session-1' } }
	};
}

describe('changePassword action', () => {
	it('throttles repeated attempts the way its re-auth siblings do', async () => {
		// A borrowed session must not get an unthrottled password oracle. The
		// shared bucket allows 10 attempts per 15 minutes; the 11th is refused
		// before the password is ever checked.
		const userId = 'reauth-guard-test-user';
		const call = actions.changePassword as (
			event: ReturnType<typeof changePasswordEvent>
		) => Promise<unknown>;

		for (let attempt = 1; attempt <= 10; attempt++) {
			const result = (await call(changePasswordEvent(userId))) as { status?: number };
			expect(result.status).toBeUndefined();
		}

		const blocked = (await call(changePasswordEvent(userId))) as {
			status?: number;
			data?: { scope?: string };
		};
		expect(blocked.status).toBe(429);
		expect(blocked.data?.scope).toBe('password');
	});
});
