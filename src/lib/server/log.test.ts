import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorFields, logEvent } from './log';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('logEvent', () => {
	it('writes one JSON object per line, errors to stderr', () => {
		const out = vi.spyOn(console, 'log').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		logEvent('info', 'mentions.scene', { sceneId: 's1', count: 3 });
		logEvent('error', 'purge.failed', { userId: 'u1' });
		expect(JSON.parse(out.mock.calls[0][0])).toMatchObject({
			level: 'info',
			event: 'mentions.scene',
			sceneId: 's1',
			count: 3
		});
		expect(JSON.parse(err.mock.calls[0][0])).toMatchObject({
			level: 'error',
			event: 'purge.failed'
		});
	});

	it('keeps the message and stack of an error, which JSON.stringify drops', () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		logEvent('error', 'job.failed', errorFields(new Error('boom')));
		const line = JSON.parse(err.mock.calls[0][0]);
		expect(line.message).toBe('boom');
		expect(line.stack).toContain('boom');
	});
});

describe('errorFields', () => {
	it('handles values that are not errors', () => {
		expect(errorFields('plain')).toEqual({ message: 'plain' });
		expect(errorFields(undefined)).toEqual({ message: 'undefined' });
	});
});
