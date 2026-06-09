import { describe, it, expect, vi } from 'vitest';

// The route module opens a real database pool on import and calls the account
// helper; neither is needed to prove the rate-limit guard fires, so stub both.
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/account', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/account')>()),
	changePassword: vi.fn(async () => ({ ok: true }))
}));

const { actions } = await import('./+page.server');

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
