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
const storedConfig = { tuning: {} as Record<string, unknown>, models: {} };
const savedInputs: { tuning?: Record<string, unknown>; models?: Record<string, string> }[] = [];
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
		toolProfile: 'full'
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
