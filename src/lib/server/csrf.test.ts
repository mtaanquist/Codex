import { describe, it, expect } from 'vitest';
import { isForbiddenCrossSiteForm } from './csrf';

const SELF = 'https://codex.example';

function check(overrides: Partial<Parameters<typeof isForbiddenCrossSiteForm>[0]>) {
	return isForbiddenCrossSiteForm({
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		origin: 'https://evil.example',
		selfOrigin: SELF,
		pathname: '/account',
		...overrides
	});
}

describe('isForbiddenCrossSiteForm', () => {
	it('refuses a form post from another site', () => {
		expect(check({})).toBe(true);
	});

	it('refuses a form post with no Origin header', () => {
		expect(check({ origin: null })).toBe(true);
	});

	it('refuses every form content type and a missing one, on every mutating method', () => {
		for (const contentType of [
			'multipart/form-data; boundary=x',
			'text/plain',
			'TEXT/PLAIN;charset=utf-8',
			'application/x-sveltekit-formdata',
			null,
			''
		]) {
			expect(check({ contentType })).toBe(true);
		}
		for (const method of ['PUT', 'PATCH', 'DELETE']) expect(check({ method })).toBe(true);
	});

	it('allows a form post from this site', () => {
		expect(check({ origin: SELF })).toBe(false);
	});

	it('allows reads and JSON requests from anywhere', () => {
		expect(check({ method: 'GET' })).toBe(false);
		expect(check({ method: 'HEAD' })).toBe(false);
		expect(check({ contentType: 'application/json' })).toBe(false);
	});

	it('lets other programs post forms to the token and revoke endpoints only', () => {
		expect(check({ pathname: '/oauth/token', origin: null })).toBe(false);
		expect(check({ pathname: '/oauth/revoke' })).toBe(false);
		expect(check({ pathname: '/oauth/authorize', origin: null })).toBe(true);
		expect(check({ pathname: '/oauth/token/', origin: null })).toBe(true);
		expect(check({ pathname: '/oauth/register' })).toBe(true);
	});
});
