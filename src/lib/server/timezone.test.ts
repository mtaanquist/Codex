import { describe, expect, it } from 'vitest';
import { isValidTimezone, requestTimeZone } from './timezone';

const jar = (value?: string) => ({ get: () => value });

describe('requestTimeZone', () => {
	it('reads a valid zone from the cookie', () => {
		expect(requestTimeZone(jar('Pacific%2FAuckland'))).toBe('Pacific/Auckland');
	});

	it('falls back to UTC when the cookie is missing, unknown or malformed', () => {
		expect(requestTimeZone(jar())).toBe('UTC');
		expect(requestTimeZone(jar('Mars%2FOlympus'))).toBe('UTC');
		expect(requestTimeZone(jar('%E0%A4%A'))).toBe('UTC');
	});
});

describe('isValidTimezone', () => {
	it('accepts IANA names and rejects junk', () => {
		expect(isValidTimezone('Europe/Copenhagen')).toBe(true);
		expect(isValidTimezone('UTC')).toBe(true);
		expect(isValidTimezone('Not/AZone')).toBe(false);
		expect(isValidTimezone('')).toBe(false);
	});
});
