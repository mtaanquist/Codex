import { afterEach, describe, expect, it, vi } from 'vitest';
import { del, patch, post, put, upload } from './api';

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
	const fetchMock = vi.fn(impl);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('api helpers', () => {
	it('sends JSON with the right method and merges the body into the result', async () => {
		const fetchMock = stubFetch(async () => Response.json({ id: 'x' }));
		for (const [send, method] of [
			[post, 'POST'],
			[put, 'PUT'],
			[patch, 'PATCH']
		] as const) {
			const result = await send<{ id: string }>('/api/thing', { a: 1 }, 'fallback');
			expect(result).toEqual({ ok: true, id: 'x' });
			const init = fetchMock.mock.lastCall![1];
			expect(init.method).toBe(method);
			expect(init.body).toBe('{"a":1}');
			expect(init.headers).toEqual({ 'content-type': 'application/json' });
		}
	});

	it('surfaces the server message on a refused request', async () => {
		stubFetch(async () => Response.json({ message: 'Too many requests' }, { status: 429 }));
		expect(await put('/api/thing', {}, 'Could not save.')).toEqual({
			ok: false,
			message: 'Too many requests'
		});
	});

	it('falls back when the refusal has no JSON message', async () => {
		stubFetch(async () => new Response('Payload Too Large', { status: 413 }));
		expect(await upload('/api/thing', new FormData(), 'Could not upload.')).toEqual({
			ok: false,
			message: 'Could not upload.'
		});
	});

	it('falls back when the network request itself fails', async () => {
		stubFetch(async () => {
			throw new TypeError('Failed to fetch');
		});
		expect(await patch('/api/thing', {}, 'Could not move.')).toEqual({
			ok: false,
			message: 'Could not move.'
		});
	});

	it('sends a DELETE without a body and tolerates an empty success', async () => {
		const fetchMock = stubFetch(async () => new Response(null, { status: 204 }));
		expect(await del('/api/thing', 'Could not remove.')).toEqual({ ok: true });
		const init = fetchMock.mock.lastCall![1];
		expect(init.method).toBe('DELETE');
		expect(init.body).toBeUndefined();
	});

	it('uploads a form without forcing a content type', async () => {
		const fetchMock = stubFetch(async () => Response.json({ id: 'asset' }));
		const form = new FormData();
		expect(await upload<{ id: string }>('/api/thing', form, 'x')).toEqual({
			ok: true,
			id: 'asset'
		});
		const init = fetchMock.mock.lastCall![1];
		expect(init.method).toBe('POST');
		expect(init.body).toBe(form);
		expect(init.headers).toBeUndefined();
	});
});
