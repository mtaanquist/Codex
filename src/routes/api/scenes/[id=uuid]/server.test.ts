import { describe, it, expect, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { MAX_BASE_HASHES } from '#lib/scene-saver';

// Only the request checks are under test; the scene lookup and save are stubbed.
vi.mock('#lib/server/db', () => ({ db: {} }));
vi.mock('#lib/server/scene-access', () => ({ ownedScene: async () => ({ id: 'scene' }) }));
vi.mock('#lib/server/jobs', () => ({ queueSceneMentions: async () => {} }));
vi.mock('#lib/server/write-guard', () => ({ rateLimitWrites: () => {} }));
vi.mock('#lib/server/scene-save', () => ({
	saveSceneBody: async () => ({ ok: true, bodyChanged: false, wordCount: 1 })
}));
vi.mock('#lib/server/scene-status', () => ({ setSceneStatus: async () => true }));

const { PUT } = await import('./+server');

async function statusFor(baseHashes: string[]): Promise<number> {
	const body = JSON.stringify({ bodyMd: 'Words.', baseHashes });
	const event = {
		params: { id: 'scene' },
		locals: { user: { id: 'user' } },
		request: new Request('http://localhost/api/scenes/scene', { method: 'PUT', body })
	};
	try {
		return ((await PUT(event as never)) as Response).status;
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

const hashes = (n: number) => Array.from({ length: n }, (_, i) => `h${i}`);

describe('scene save fingerprints', () => {
	it('accepts as many fingerprints as the editor may send', async () => {
		expect(await statusFor(hashes(MAX_BASE_HASHES))).toBe(200);
	});

	it('refuses more than that', async () => {
		expect(await statusFor(hashes(MAX_BASE_HASHES + 1))).toBe(400);
	});
});
