import { describe, expect, it } from 'vitest';
import { resolveOrigin } from './origin';

describe('resolveOrigin', () => {
	it('uses the configured origin over the request origin', () => {
		expect(resolveOrigin('https://codex.example', 'https://evil.example', false)).toBe(
			'https://codex.example'
		);
		expect(resolveOrigin('https://codex.example', 'https://evil.example', true)).toBe(
			'https://codex.example'
		);
	});

	it('refuses to fall back to the request origin in a built app', () => {
		expect(() => resolveOrigin(undefined, 'https://evil.example', false)).toThrow(/ORIGIN/);
		expect(() => resolveOrigin('', 'https://evil.example', false)).toThrow(/ORIGIN/);
	});

	it('falls back to the request origin on the dev server', () => {
		expect(resolveOrigin(undefined, 'http://localhost:5173', true)).toBe('http://localhost:5173');
	});
});
