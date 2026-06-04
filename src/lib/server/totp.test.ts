import { describe, it, expect } from 'vitest';
import {
	generateRecoveryCodes,
	generateSecret,
	hashRecoveryCode,
	matchTotpStep,
	normaliseRecoveryCode,
	otpauthUri,
	totpCode,
	verifyTotp
} from './totp';

// RFC 6238 reference secret ("12345678901234567890" in base32) and its
// test-vector times, truncated to the six digits this app uses.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS: [number, string][] = [
	[59, '287082'],
	[1111111109, '081804'],
	[1111111111, '050471'],
	[1234567890, '005924'],
	[2000000000, '279037']
];

describe('totpCode', () => {
	it('matches the RFC 6238 vectors', () => {
		for (const [seconds, code] of VECTORS) {
			expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(code);
		}
	});
});

describe('verifyTotp', () => {
	const atMs = 1111111111 * 1000;

	it('accepts the current code and rejects a wrong one', () => {
		expect(verifyTotp(RFC_SECRET, '050471', { atMs })).toBe(true);
		expect(verifyTotp(RFC_SECRET, '000000', { atMs })).toBe(false);
		expect(verifyTotp(RFC_SECRET, 'abc', { atMs })).toBe(false);
		expect(verifyTotp(RFC_SECRET, '05047', { atMs })).toBe(false);
	});

	it('tolerates one step of drift but no more', () => {
		const previous = totpCode(RFC_SECRET, atMs - 30_000);
		const tooOld = totpCode(RFC_SECRET, atMs - 90_000);
		expect(verifyTotp(RFC_SECRET, previous, { atMs })).toBe(true);
		expect(verifyTotp(RFC_SECRET, tooOld, { atMs })).toBe(false);
	});
});

describe('matchTotpStep', () => {
	const atMs = 1111111111 * 1000;
	const step = Math.floor(atMs / 1000 / 30);

	it('returns the matched step counter, accounting for drift', () => {
		expect(matchTotpStep(RFC_SECRET, '050471', { atMs })).toBe(step);
		// The previous step's code is accepted via drift and reports its own step.
		expect(matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, atMs - 30_000), { atMs })).toBe(step - 1);
	});

	it('returns null for a wrong or malformed code', () => {
		expect(matchTotpStep(RFC_SECRET, '000000', { atMs })).toBeNull();
		expect(matchTotpStep(RFC_SECRET, 'abc', { atMs })).toBeNull();
	});
});

describe('generateSecret', () => {
	it('produces a usable base32 secret that round-trips through a code', () => {
		const secret = generateSecret();
		expect(secret).toMatch(/^[A-Z2-7]+$/);
		const now = Date.now();
		expect(verifyTotp(secret, totpCode(secret, now), { atMs: now })).toBe(true);
	});
});

describe('otpauthUri', () => {
	it('encodes the label and carries the standard parameters', () => {
		const uri = otpauthUri('ABCDEF', 'me@example.com', 'Codex');
		expect(uri).toContain('otpauth://totp/Codex%3Ame%40example.com?');
		expect(uri).toContain('secret=ABCDEF');
		expect(uri).toContain('issuer=Codex');
		expect(uri).toContain('algorithm=SHA1');
	});
});

describe('recovery codes', () => {
	it('generates the requested count in a readable, unambiguous format', () => {
		const codes = generateRecoveryCodes(10);
		expect(codes).toHaveLength(10);
		for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
	});

	it('hashes the same regardless of dashes or case', () => {
		expect(normaliseRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
		expect(hashRecoveryCode('ABCDE-FGHJK')).toBe(hashRecoveryCode('abcdefghjk'));
		expect(hashRecoveryCode('ABCDE-FGHJK')).not.toBe(hashRecoveryCode('ABCDE-FGHJL'));
	});
});
