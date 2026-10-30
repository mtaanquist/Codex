import { describe, expect, it } from 'vitest';
import { isValidTimezone, requestTimeZone } from './timezone';

const jar = (value?: string) => ({ get: () => value });

describe('requestTimeZone', () => {
	it('reads a valid zone from the cookie', () => {
		expect(requestTimeZone(jar('Pacific/Auckland'))).toBe('Pacific/Auckland');
	});

	it('falls back to UTC when the cookie is missing or unknown', () => {
		expect(requestTimeZone(jar())).toBe('UTC');
		expect(requestTimeZone(jar('Mars/Olympus'))).toBe('UTC');
		// Not a zone name; real cookie decoding is covered in e2e/timezone.spec.ts.
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
