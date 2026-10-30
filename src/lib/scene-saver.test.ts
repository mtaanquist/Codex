import { describe, it, expect, vi, afterEach } from 'vitest';
import { UnretryableSaveError } from './autosave';
import { createSceneSaver, MAX_BASE_HASHES, SAVE_TIMEOUT_MS, saveTimeoutMs } from './scene-saver';
import { textHash } from './text-hash';

type Sent = { baseHashes: string[]; overwrite?: boolean; bodyMd: string; keepalive?: boolean };

// Each fetch is answered by the next queued responder; the request bodies are
// kept so the test can read what the saver sent.
function mockFetch(responders: (() => Response | Promise<Response>)[]) {
	const sent: Sent[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			sent.push({ ...JSON.parse(String(init.body)), keepalive: init.keepalive });
			const next = responders.shift();
			if (!next) throw new Error('no response queued');
			return next();
		})
	);
	return sent;
}

const ok = () => new Response('{}', { status: 200 });
const conflict = (bodyMd: string) => () =>
	new Response(JSON.stringify({ conflict: true, bodyMd, title: null }), { status: 409 });
const networkError = () => {
	throw new TypeError('network');
};

afterEach(() => {
	vi.unstubAllGlobals();
});

const save = (bodyMd: string, keepalive = false) => ({ keepalive, title: null, bodyMd });

describe('createSceneSaver', () => {
	it('sends the last saved text as the base', async () => {
		const sent = mockFetch([ok, ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		await saver.save(save('ab'));
		await saver.save(save('abc'));
		expect(sent[0].baseHashes).toEqual([textHash('a')]);
		expect(sent[1].baseHashes).toEqual([textHash('ab')]);
	});

	it('advances the base after a successful close-tab save', async () => {
		const sent = mockFetch([ok, ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		await saver.save(save('ab', true));
		await saver.save(save('abc'));
		expect(sent[1].baseHashes).toEqual([textHash('ab')]);
	});

	it('keeps a save lost to a network error as an accepted base', async () => {
		const sent = mockFetch([networkError, ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		await expect(saver.save(save('ab'))).rejects.toThrow();
		await saver.save(save('abc'));
		expect(sent[1].baseHashes).toEqual([textHash('a'), textHash('ab')]);
	});

	it('keeps an older unsettled save as a base through retries of the same text', async () => {
		const sent = mockFetch([networkError, networkError, networkError, networkError, ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		await expect(saver.save(save('ab'))).rejects.toThrow();
		for (let i = 0; i < 3; i++) await expect(saver.save(save('abc'))).rejects.toThrow();
		await saver.save(save('abcd'));
		expect(sent[4].baseHashes).toEqual([textHash('a'), textHash('ab'), textHash('abc')]);
	});

	it('keeps the oldest of several timed-out saves, up to the cap', async () => {
		const bodies = ['b', 'c', 'd', 'e', 'f'];
		const sent = mockFetch([...bodies.map(() => networkError), ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		for (const body of bodies) await expect(saver.save(save(body))).rejects.toThrow();
		await saver.save(save('g'));
		// The server may have applied 'b' late; it must still count as a base.
		expect(sent[5].baseHashes).toContain(textHash('b'));
	});

	it('never sends more fingerprints than the server accepts', async () => {
		const bodies = Array.from({ length: MAX_BASE_HASHES + 2 }, (_, i) => `t${i}`);
		const sent = mockFetch([...bodies.map(() => networkError), ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		for (const body of bodies) await expect(saver.save(save(body))).rejects.toThrow();
		await saver.save(save('last'));
		expect(sent.at(-1)!.baseHashes).toHaveLength(MAX_BASE_HASHES);
	});

	it('gives up on a save with no answer, as a retryable network error', async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal(
				'fetch',
				vi.fn(
					(_url: string, init: RequestInit) =>
						new Promise((_resolve, reject) => {
							init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
						})
				)
			);
			const saver = createSceneSaver('s', 'a', () => {});
			const saving = saver.save(save('ab'));
			const outcome = expect(saving).rejects.not.toBeInstanceOf(UnretryableSaveError);
			await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS + 1000);
			await outcome;
		} finally {
			vi.useRealTimers();
		}
	});

	it('caps the time a long scene gets at two minutes', () => {
		expect(saveTimeoutMs('short')).toBeLessThan(SAVE_TIMEOUT_MS + 100);
		expect(saveTimeoutMs('x'.repeat(1_000_000))).toBe(120_000);
	});

	it('gives a long scene more time before it gives up', async () => {
		vi.useFakeTimers();
		try {
			let aborted = false;
			vi.stubGlobal(
				'fetch',
				vi.fn(
					(_url: string, init: RequestInit) =>
						new Promise((_resolve, reject) => {
							init.signal?.addEventListener('abort', () => {
								aborted = true;
								reject(new Error('aborted'));
							});
						})
				)
			);
			const saver = createSceneSaver('s', 'a', () => {});
			const saving = saver.save(save('x'.repeat(100_000)));
			saving.catch(() => {});
			await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS + 1000);
			expect(aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(110_000);
			expect(aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('sends a close-tab save as keepalive only when the body fits the cap', async () => {
		const sent = mockFetch([ok, ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		await saver.save(save('short', true));
		await saver.save(save('x'.repeat(70_000), true));
		expect(sent[0].keepalive).toBe(true);
		expect(sent[1].keepalive).toBe(false);
	});

	it('refuses a conflict with an error autosave does not retry', async () => {
		mockFetch([conflict('theirs')]);
		const saver = createSceneSaver('s', 'a', () => {});
		await expect(saver.save(save('mine'))).rejects.toBeInstanceOf(UnretryableSaveError);
	});

	it('refuses a 4xx as unretryable and a 5xx as retryable', async () => {
		mockFetch([
			() => new Response('{}', { status: 413 }),
			() => new Response('{}', { status: 503 })
		]);
		const saver = createSceneSaver('s', 'a', () => {});
		await expect(saver.save(save('b'))).rejects.toBeInstanceOf(UnretryableSaveError);
		const retryable = saver.save(save('c'));
		await expect(retryable).rejects.toThrow('save failed: 503');
		await expect(retryable).rejects.not.toBeInstanceOf(UnretryableSaveError);
	});

	it('reports a conflict, and keepMine overwrites once', async () => {
		const sent = mockFetch([conflict('theirs'), ok, ok]);
		const seen: (string | null)[] = [];
		const saver = createSceneSaver('s', 'a', (c) => seen.push(c?.bodyMd ?? null));
		await expect(saver.save(save('mine'))).rejects.toThrow();
		saver.keepMine('theirs');
		await saver.save(save('mine'));
		await saver.save(save('mine2'));
		expect(seen).toEqual(['theirs', null]);
		expect(sent[1]).toMatchObject({ baseHashes: [textHash('theirs')], overwrite: true });
		expect(sent[2].overwrite).toBeUndefined();
	});

	it('ignores a refusal for a save started before the conflict was settled', async () => {
		let answer!: (r: Response) => void;
		mockFetch([() => new Promise<Response>((r) => (answer = r))]);
		const seen: (string | null)[] = [];
		const saver = createSceneSaver('s', 'a', (c) => seen.push(c?.bodyMd ?? null));
		const stale = saver.save(save('mine'));
		saver.adopt('theirs');
		answer(conflict('theirs')());
		await expect(stale).rejects.toThrow();
		expect(seen).toEqual([null]);
	});

	it('rebases onto an accepted suggestion made on the text it saved', async () => {
		const sent = mockFetch([ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		saver.rebase('a, accepted', textHash('a'));
		await saver.save(save('a, accepted, typed'));
		expect(sent[0].baseHashes).toEqual([textHash('a, accepted')]);
	});

	it('does not rebase when the accept was applied to text from another window', async () => {
		const sent = mockFetch([ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		saver.rebase('elsewhere, accepted', textHash('elsewhere'));
		await saver.save(save('a, accepted'));
		expect(sent[0].baseHashes).toEqual([textHash('a')]);
	});
});
