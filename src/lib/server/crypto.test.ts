import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { decryptSecret, encryptSecret, secretsAvailable } from './crypto';

const original = process.env.APP_SECRET;

beforeAll(() => {
	process.env.APP_SECRET = 'a-test-app-secret';
});

afterAll(() => {
	if (original === undefined) delete process.env.APP_SECRET;
	else process.env.APP_SECRET = original;
});

describe('secret encryption', () => {
	it('round-trips a value without exposing it', () => {
		const enc = encryptSecret('hunter2');
		expect(enc).not.toContain('hunter2');
		expect(decryptSecret(enc)).toBe('hunter2');
	});

	it('uses a fresh iv each time, so ciphertext differs', () => {
		expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
	});

	it('rejects a tampered value', () => {
		const [iv, tag] = encryptSecret('secret').split(':');
		const tampered = `${iv}:${tag}:${Buffer.from('not-the-body').toString('base64')}`;
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it('reports availability from APP_SECRET', () => {
		expect(secretsAvailable()).toBe(true);
	});
});
