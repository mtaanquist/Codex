import { describe, it, expect } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { RETURN_TO_COOKIE, rememberReturnTo, safeReturnTo, takeReturnTo } from './return-to';

function cookieJar(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial));
	const cookies = {
		get: (name: string) => jar.get(name),
		delete: (name: string) => void jar.delete(name),
		serialize: (name: string, value: string) => `${name}=${encodeURIComponent(value)}`
	} as unknown as Cookies;
	return { jar, cookies };
}

describe('safeReturnTo', () => {
	it('keeps the consent page with its query', () => {
		expect(safeReturnTo('/oauth/authorize?client_id=abc&state=x%20y')).toBe(
			'/oauth/authorize?client_id=abc&state=x%20y'
		);
	});

	it('refuses any other page of this site', () => {
		for (const value of ['/', '/account', '/oauth/token', '/oauth/authorize/extra', '/admin']) {
			expect(safeReturnTo(value)).toBeNull();
		}
	});

	it('refuses anything that could leave the site', () => {
		for (const value of [
			'https://evil.example/oauth/authorize',
			'//evil.example/oauth/authorize',
			'/\\evil.example/oauth/authorize',
			'\\/evil.example',
			'javascript:alert(1)',
			'oauth/authorize',
			'/oauth/../oauth/authorize/../../account',
			'',
			null,
			undefined
		]) {
			expect(safeReturnTo(value)).toBeNull();
		}
	});

	it('drops a fragment and refuses an oversized value', () => {
		expect(safeReturnTo('/oauth/authorize?a=1#frag')).toBe('/oauth/authorize?a=1');
		expect(safeReturnTo('/oauth/authorize?a=' + 'x'.repeat(5000))).toBeNull();
	});
});

describe('the return-to cookie', () => {
	it('is set only for a returnable page', () => {
		const { cookies } = cookieJar();
		expect(
			rememberReturnTo(cookies, new URL('https://codex.example/oauth/authorize?client_id=a'))
		).toBe(`${RETURN_TO_COOKIE}=${encodeURIComponent('/oauth/authorize?client_id=a')}`);
		expect(rememberReturnTo(cookies, new URL('https://codex.example/account'))).toBeNull();
	});

	it('is used once and then forgotten', () => {
		const { jar, cookies } = cookieJar({ [RETURN_TO_COOKIE]: '/oauth/authorize?client_id=a' });
		expect(takeReturnTo(cookies)).toBe('/oauth/authorize?client_id=a');
		expect(jar.has(RETURN_TO_COOKIE)).toBe(false);
		expect(takeReturnTo(cookies)).toBeNull();
	});

	it('is dropped without being followed when it was tampered with', () => {
		const { jar, cookies } = cookieJar({ [RETURN_TO_COOKIE]: 'https://evil.example/' });
		expect(takeReturnTo(cookies)).toBeNull();
		expect(jar.has(RETURN_TO_COOKIE)).toBe(false);
	});
});
