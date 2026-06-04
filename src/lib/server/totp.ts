import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Time-based one-time passwords (RFC 6238) and the recovery codes that back
// them. Pure functions over Node's crypto: no database, no environment. The
// defaults (SHA-1, 6 digits, 30-second step) are what every authenticator app
// assumes, so they are not configurable.

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
	let bits = 0;
	let value = 0;
	let output = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	}
	return output;
}

function base32Decode(input: string): Buffer {
	const clean = input.replace(/[\s=]/g, '').toUpperCase();
	let bits = 0;
	let value = 0;
	const output: number[] = [];
	for (const char of clean) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index === -1) throw new Error('invalid base32 character');
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			output.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(output);
}

// A fresh 160-bit secret, base32-encoded as authenticator apps expect.
export function generateSecret(): string {
	return base32Encode(randomBytes(20));
}

function codeForCounter(secret: string, counter: number): string {
	const key = base32Decode(secret);
	const message = Buffer.alloc(8);
	// 64-bit big-endian counter; the high 32 bits are zero for any realistic time.
	message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
	message.writeUInt32BE(counter >>> 0, 4);
	const hmac = createHmac('sha1', key).update(message).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const binary =
		((hmac[offset] & 0x7f) << 24) |
		(hmac[offset + 1] << 16) |
		(hmac[offset + 2] << 8) |
		hmac[offset + 3];
	return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

// The code for a given moment; exposed mainly so tests can drive it.
export function totpCode(secret: string, atMs: number = Date.now()): string {
	return codeForCounter(secret, Math.floor(atMs / 1000 / STEP_SECONDS));
}

// Whether a submitted code is valid now, allowing one step either side to
// absorb clock drift. Constant-time per candidate so a near-miss leaks nothing.
export function verifyTotp(
	secret: string,
	token: string,
	options: { window?: number; atMs?: number } = {}
): boolean {
	const candidate = token.replace(/\s/g, '');
	if (!/^\d{6}$/.test(candidate)) return false;
	const window = options.window ?? 1;
	const counter = Math.floor((options.atMs ?? Date.now()) / 1000 / STEP_SECONDS);
	const submitted = Buffer.from(candidate);
	let valid = false;
	for (let offset = -window; offset <= window; offset++) {
		const expected = Buffer.from(codeForCounter(secret, counter + offset));
		if (submitted.length === expected.length && timingSafeEqual(submitted, expected)) {
			valid = true;
		}
	}
	return valid;
}

// The otpauth:// URI an authenticator imports from a QR code. Label and issuer
// are percent-encoded so an email address or a space cannot break the URI.
export function otpauthUri(secret: string, account: string, issuer: string): string {
	const label = encodeURIComponent(`${issuer}:${account}`);
	const params = new URLSearchParams({
		secret,
		issuer,
		algorithm: 'SHA1',
		digits: String(DIGITS),
		period: String(STEP_SECONDS)
	});
	return `otpauth://totp/${label}?${params.toString()}`;
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_GROUP = 5;

// Human-friendly recovery codes (two five-character groups), drawn from an
// alphabet without easily confused characters. Generated once at enrolment.
export function generateRecoveryCodes(count = 10): string[] {
	const codes: string[] = [];
	for (let i = 0; i < count; i++) {
		const chars = randomBytes(RECOVERY_GROUP * 2);
		let code = '';
		for (let j = 0; j < chars.length; j++) {
			if (j === RECOVERY_GROUP) code += '-';
			code += RECOVERY_ALPHABET[chars[j] % RECOVERY_ALPHABET.length];
		}
		codes.push(code);
	}
	return codes;
}

// Strips formatting so a code typed with or without its dash, in any case,
// hashes the same way.
export function normaliseRecoveryCode(code: string): string {
	return code.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

// Recovery codes are high-entropy, so a fast one-way hash is enough; this also
// keeps verifying a handful of them quick.
export function hashRecoveryCode(code: string): string {
	return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}
