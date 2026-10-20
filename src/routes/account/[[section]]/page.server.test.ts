import { describe, it, expect, beforeEach, vi } from 'vitest';

// The route module opens a real database pool on import and calls the account
// helper; neither is needed to prove the re-auth guards fire, so stub both. The
// Assistant forms, which store what they save, are covered against a real
// database in tests/integration/account-assistant-route.test.ts.
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/account', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/account')>()),
	changePassword: vi.fn(async () => ({ ok: true })),
	verifyAccountPassword: vi.fn(
		async (_db: unknown, _userId: string, password: string) => password === 'right-password'
	),
	revokeOtherSessions: vi.fn(async () => {})
}));
vi.mock('$lib/server/two-factor', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/two-factor')>()),
	confirmEnrollment: vi.fn(async () => ({ ok: true, recoveryCodes: ['code-1'] }))
}));

const { actions } = await import('./+page.server');
const { revokeOtherSessions } = await import('$lib/server/account');
const { confirmEnrollment } = await import('$lib/server/two-factor');

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

function formEvent(userId: string, fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return {
		request: { formData: async () => form },
		locals: { user: { id: userId, email: 'a@example.com' }, session: { id: 'session-1' } }
	};
}

type ActionResult = { status?: number; data?: { scope?: string; message?: string } };

// Turning two-factor on and signing out other sessions together let a borrowed
// session lock the owner out, so both re-confirm the password (#585).
describe('confirmTotp action', () => {
	const call = actions.confirmTotp as (event: unknown) => Promise<unknown>;

	beforeEach(() => vi.mocked(confirmEnrollment).mockClear());

	it('refuses to turn two-factor on without the current password', async () => {
		const result = (await call(
			formEvent('totp-reauth-user', { code: '123456', password: 'wrong' })
		)) as ActionResult;
		expect(result.status).toBe(400);
		expect(result.data?.scope).toBe('totp');
		expect(confirmEnrollment).not.toHaveBeenCalled();
	});

	it('turns two-factor on with the right password', async () => {
		const result = (await call(
			formEvent('totp-reauth-user-ok', { code: '123456', password: 'right-password' })
		)) as { recoveryCodes?: string[] };
		expect(result.recoveryCodes).toEqual(['code-1']);
	});

	it('shares the re-auth throttle', async () => {
		const userId = 'totp-reauth-throttle-user';
		for (let attempt = 1; attempt <= 10; attempt++) {
			await call(formEvent(userId, { code: '123456', password: 'wrong' }));
		}
		const blocked = (await call(
			formEvent(userId, { code: '123456', password: 'right-password' })
		)) as ActionResult;
		expect(blocked.status).toBe(429);
		expect(blocked.data?.scope).toBe('totp');
	});
});

describe('revokeOthers action', () => {
	const call = actions.revokeOthers as (event: unknown) => Promise<unknown>;

	beforeEach(() => vi.mocked(revokeOtherSessions).mockClear());

	it('refuses to sign out other sessions without the current password', async () => {
		const result = (await call(
			formEvent('revoke-reauth-user', { password: 'wrong' })
		)) as ActionResult;
		expect(result.status).toBe(400);
		expect(result.data?.scope).toBe('sessions');
		expect(revokeOtherSessions).not.toHaveBeenCalled();
	});

	it('signs out other sessions with the right password', async () => {
		const result = (await call(
			formEvent('revoke-reauth-user-ok', { password: 'right-password' })
		)) as { saved?: boolean };
		expect(result.saved).toBe(true);
		expect(revokeOtherSessions).toHaveBeenCalledOnce();
	});
});
