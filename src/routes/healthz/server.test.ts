import { describe, it, expect, vi, afterEach } from 'vitest';

const execute = vi.fn();
vi.mock('$lib/server/db', () => ({ db: { execute: (...args: unknown[]) => execute(...args) } }));

const { GET } = await import('./+server');

async function call() {
	return (await GET({} as Parameters<typeof GET>[0])) as Response;
}

afterEach(() => {
	vi.useRealTimers();
});

describe('GET /healthz', () => {
	it('is ok when the probe query succeeds', async () => {
		execute.mockResolvedValueOnce({ rows: [] });
		expect((await call()).status).toBe(200);
	});

	it('is 503 when the probe query fails', async () => {
		execute.mockRejectedValueOnce(new Error('down'));
		expect((await call()).status).toBe(503);
	});

	it('answers 503 instead of hanging when the probe never returns', async () => {
		vi.useFakeTimers();
		execute.mockReturnValueOnce(new Promise(() => {}));
		const pending = call();
		await vi.advanceTimersByTimeAsync(10_000);
		expect((await pending).status).toBe(503);
	});
});
