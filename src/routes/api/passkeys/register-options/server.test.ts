import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

// The endpoint opens a real database pool and reaches the passkey ceremony on
// import; stub the dependencies so the test exercises only the re-auth gate.
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/crypto', () => ({ secretsAvailable: () => true }));
vi.mock('$lib/server/account', () => ({ verifyAccountPassword: vi.fn() }));
vi.mock('$lib/server/passkeys', () => ({
	PASSKEY_CHALLENGE_COOKIE: 'pk_challenge',
	startPasskeyRegistration: vi.fn(async () => ({
		options: { challenge: 'opts' },
		challengeToken: 'token'
	}))
}));

const { verifyAccountPassword } = await import('$lib/server/account');
const { startPasskeyRegistration } = await import('$lib/server/passkeys');
const { POST } = await import('./+server');

// The status the handler answered with, whether it returned a Response or threw.
async function statusOf(ev: ReturnType<typeof event>): Promise<number> {
	try {
		return ((await POST(ev as never)) as Response).status;
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

function event(userId: string, password: string) {
	const cookies = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
	return {
		cookies,
		locals: { user: { id: userId, email: 'a@example.com' } },
		request: { json: async () => ({ password }) },
		url: new URL('http://localhost/api/passkeys/register-options')
	};
}

describe('passkey register-options re-auth gate', () => {
	beforeEach(() => {
		vi.mocked(startPasskeyRegistration).mockClear();
		vi.mocked(verifyAccountPassword).mockReset();
	});

	it('refuses to start registration when the password is wrong', async () => {
		vi.mocked(verifyAccountPassword).mockResolvedValue(false);
		const ev = event('pk-wrong-user', 'nope');
		expect(await statusOf(ev)).toBe(400);
		// No challenge issued and no ceremony begun.
		expect(ev.cookies.set).not.toHaveBeenCalled();
		expect(startPasskeyRegistration).not.toHaveBeenCalled();
	});

	it('starts registration and sets the challenge cookie when the password is right', async () => {
		vi.mocked(verifyAccountPassword).mockResolvedValue(true);
		const ev = event('pk-right-user', 'correct');
		expect(await statusOf(ev)).toBe(200);
		expect(startPasskeyRegistration).toHaveBeenCalledTimes(1);
		expect(ev.cookies.set).toHaveBeenCalledWith('pk_challenge', 'token', expect.any(Object));
	});

	it('throttles repeated attempts before checking the password', async () => {
		vi.mocked(verifyAccountPassword).mockResolvedValue(true);
		const userId = 'pk-throttle-user';
		for (let attempt = 1; attempt <= 10; attempt++) {
			expect(await statusOf(event(userId, 'correct'))).toBe(200);
		}
		expect(await statusOf(event(userId, 'correct'))).toBe(429);
	});
});
