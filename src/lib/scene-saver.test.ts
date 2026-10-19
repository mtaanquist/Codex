import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSceneSaver } from './scene-saver';
import { textHash } from './text-hash';

type Sent = { baseHashes: string[]; overwrite?: boolean; bodyMd: string };

// Each fetch is answered by the next queued responder; the request bodies are
// kept so the test can read what the saver sent.
function mockFetch(responders: (() => Response | Promise<Response>)[]) {
	const sent: Sent[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)));
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

	it('never sends more than four fingerprints', async () => {
		const sent = mockFetch([networkError, networkError, networkError, networkError, ok]);
		const saver = createSceneSaver('s', 'a', () => {});
		for (const body of ['b', 'c', 'd', 'e']) await expect(saver.save(save(body))).rejects.toThrow();
		await saver.save(save('f'));
		expect(sent[4].baseHashes).toHaveLength(4);
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

	it('rebases onto an accepted suggestion without a conflict notice', async () => {
		const sent = mockFetch([ok]);
		const seen: unknown[] = [];
		const saver = createSceneSaver('s', 'a', (c) => seen.push(c));
		saver.rebase('a, accepted');
		await saver.save(save('a, accepted, typed'));
		expect(sent[0].baseHashes).toEqual([textHash('a, accepted')]);
		expect(seen).toEqual([]);
	});
});
